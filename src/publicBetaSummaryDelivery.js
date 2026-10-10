import { REPORT_CLAIM } from './config.js';
import { localDate } from './time.js';
import { requireUserId } from './userContext.js';
import { withDeliveryAuthorization } from './accountLifecycle.js';
import { createTelegram, TelegramError } from './telegram.js';
import { SEND_OUTCOME } from './sendOutcome.js';
import { deliverReport, DELIVERY_RESULT } from './reportDelivery.js';

/** Once per user/local day, after sync and the Stage 6 drain. report_claims
 * supplies the same durable ambiguity and overlap fence as daily/weekly. */
export async function deliverPublicBetaSummary({ db, env, user, presentation, now = new Date(),
  makeTelegram = createTelegram } = {}) {
  const userId = requireUserId(user?.id, 'deliverPublicBetaSummary');
  if (!presentation?.eligible(userId)) return { status: 'not_eligible' };
  if (typeof db?.getLocale === 'function' && !await db.getLocale(userId))
    return { status: 'locale_unset' };
  const result = await presentation.withCurrentSummary({ userId, now }, async (text, verifyCurrent) => {
    const current = await db.getUser(userId);
    if (!current || current.status !== 'ACTIVE') return { status: 'inactive' };
    const life = current.lifecycleGeneration;
    const chatId = await db.getActiveChatIdForUser(userId, { expectedLifecycleGeneration: life });
    if (!chatId) return { status: 'no_active_chat' };
    const claimKey = { userId, reportType: 'phase4_beta_summary',
      localDateKey: localDate(now, current.timezone) };
    const claim = await db.claimReport({ ...claimKey, ttlMs: REPORT_CLAIM.TTL_MS,
      expectedLifecycleGeneration: life, now });
    if (!claim.granted) return { status: claim.alreadySent ? 'already_sent'
      : claim.ambiguous ? 'delivery_ambiguous' : 'claim_busy' };
    const sender = withDeliveryAuthorization(makeTelegram({
      botToken: env.telegramBotToken, chatId, dryRun: env.dryRun, db,
      errorScope: `user:${userId}`,
    }), async () => String(await db.getActiveChatIdForUser(userId,
      { expectedLifecycleGeneration: life }).catch(() => null))===String(chatId),
    { userId, expectedLifecycleGeneration: life });
    const guarded = { send: async body => {
      try { await verifyCurrent(); }
      catch { throw new TelegramError('BETA_CURRENTNESS_FENCED',
        { sendOutcome: SEND_OUTCOME.DEFINITE_FAILURE, sendStage: 'pre_send' }); }
      return sender.send(body);
    } };
    const delivery = await deliverReport({ db, claimKey, claim, telegram: guarded, text,
      now: () => now });
    if (delivery.result === DELIVERY_RESULT.DELIVERED) {
      await db.recordRun({ userId, reportType: claimKey.reportType,
        localDateKey: claimKey.localDateKey, status: 'SENT',
        telegramMessageId: delivery.messageId }, { throwOnError: false });
    }
    return { status: delivery.result, localDate: claimKey.localDateKey };
  });
  return result ?? { status: 'no_current_summary' };
}
