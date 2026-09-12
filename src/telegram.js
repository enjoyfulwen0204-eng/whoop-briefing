/**
 * Telegram 推送。
 *
 * - plain text（不設 parse_mode），避免 Markdown escaping 出包。
 * - Telegram API 本身出錯：只寫 log，絕不遞迴再呼叫 Telegram。
 * - 錯誤通知有 cooldown（同一 error_type 2 小時內最多一次），避免每 30 分鐘洗版。
 */

import { ERROR_NOTIFY_COOLDOWN_HOURS, TELEGRAM_MAX_CHARS } from './config.js';
import { GLOBAL_SCOPE } from './schema.js';
import { clamp } from './format.js';
import { log, describeError } from './logger.js';

export class TelegramError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TelegramError';
  }
}

/**
 * @param {?string} errorScope 錯誤通知冷卻的 scope。
 *   'global'（預設）= 基礎設施故障；`user:<userId>` = 某個使用者的帳號問題。
 *   分開才不會讓 Alice 的 WHOOP token 過期壓抑掉 Bob 的同類通知。
 */
export function createTelegram({
  botToken, chatId, dryRun = false, fetchImpl = fetch, db = null,
  errorScope = GLOBAL_SCOPE,
}) {
  async function send(text) {
    // 共用同一個 clamp（format.js），不再各自實作一份
    const body = clamp(text);
    // 發送層的最後防線：clamp 若哪天壞了，寧可在這裡爆掉也不要送出超長訊息
    // 讓 Telegram 回 400（那會被記成發送失敗，還要多繞一輪才看得出原因）
    if (body.length > TELEGRAM_MAX_CHARS) {
      throw new TelegramError(
        `訊息長度收斂失敗：${body.length} > ${TELEGRAM_MAX_CHARS}（clamp 有 bug）`,
      );
    }

    if (dryRun) {
      log.info('telegram_dry_run', { chars: body.length });
      process.stdout.write(`\n----- DRY RUN Telegram 訊息 -----\n${body}\n----- 結束（${body.length} 字元）-----\n\n`);
      return { messageId: null, dryRun: true };
    }

    const res = await fetchImpl(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: body,
        disable_web_page_preview: true,
      }),
    });

    const raw = await res.text();
    if (!res.ok) {
      throw new TelegramError(`Telegram ${res.status}: ${raw.slice(0, 300)}`);
    }
    let json;
    try {
      json = JSON.parse(raw);
    } catch {
      throw new TelegramError('Telegram 回傳非 JSON');
    }
    if (!json.ok) throw new TelegramError(`Telegram 回應 ok=false: ${JSON.stringify(json).slice(0, 300)}`);

    log.info('telegram_sent', { message_id: json.result?.message_id, chars: body.length });
    return { messageId: json.result?.message_id ?? null, dryRun: false };
  }

  /**
   * 發錯誤通知（帶 cooldown）。
   * 這個函式自己絕不拋錯 —— Telegram 掛了只寫 log。
   */
  async function notifyError(errorType, message, { cooldownHours = ERROR_NOTIFY_COOLDOWN_HOURS } = {}) {
    // ★ 冷卻時間可以逐訊號指定。
    //
    // 全域預設是 2 小時，那對「一次性的故障」剛好。但對**持續**的狀況它是災難：
    // 排程器主要供應商掛掉一整天，2 小時的冷卻會送出 12 則一模一樣的警報，
    // 48 小時就是 24 則。那不是通知，那是訓練使用者把警報靜音。
    // 所以持續型訊號（例如排程器離線）自己指定一個長冷卻（24 小時）。
    const hours = Number.isFinite(cooldownHours) && cooldownHours > 0
      ? cooldownHours : ERROR_NOTIFY_COOLDOWN_HOURS;
    let claim = null;
    try {
      if (db) {
        // 有 owned 版本就用它 —— 送失敗時才有辦法「只還自己那一次」的認領。
        claim = typeof db.claimErrorNotifyOwned === 'function'
          ? await db.claimErrorNotifyOwned(errorScope, errorType, hours)
          : { granted: await db.claimErrorNotify(errorScope, errorType, hours), claimedAt: null };
        if (!claim.granted) {
          log.info('error_notify_suppressed', {
            scope: errorScope, error_type: errorType, cooldown_hours: hours,
          });
          return false;
        }
      }
      await send(`🚨 WHOOP 簡報系統異常\n類型：${errorType}\n${message}\n\n（同類型錯誤 ${hours} 小時內只通知一次）`);
      return true;
    } catch (err) {
      // ★ 送失敗 → 把認領還回去。
      //
      // 以前這裡只寫 log：認領已經持久化了，於是一次 Telegram 故障就把整個
      // 冷卻窗吃掉（排程離線警報是 24 小時）。使用者在那段時間完全不會被
      // 告知系統掛了 —— 而那正是最需要通知的時候。
      //
      // 釋放時帶上自己的 claimedAt，所以碰不到別人**更新的**成功認領。
      if (claim?.granted && claim.claimedAt && typeof db?.releaseErrorNotify === 'function') {
        try {
          const released = await db.releaseErrorNotify(errorScope, errorType, claim.claimedAt);
          log.info('error_notify_claim_released', {
            scope: errorScope, error_type: errorType, released,
          });
        } catch (releaseErr) {
          log.warn('error_notify_release_failed', { error: describeError(releaseErr) });
        }
      }
      // 不遞迴：Telegram 出錯就只留 log
      log.error('error_notify_failed', {
        scope: errorScope, error_type: errorType, error: describeError(err),
      });
      return false;
    }
  }

  return { send, notifyError };
}
