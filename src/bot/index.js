#!/usr/bin/env node
/**
 * Telegram bot worker（常駐 process）。
 *
 * 與每日簡報的 cron **完全分開**部署：
 *   cron   whoop-briefing     每 30 分鐘跑一次就結束
 *   worker whoop-telegram-bot 一直活著，long polling
 *
 * 兩者共用同一個 Turso。每個使用者各自一組 WHOOP token。安全性靠：
 *   - token refresh 有 Turso lease lock（src/whoop.js）
 *   - 報告發送權有 report_claims（src/db.js）
 * 所以兩個 process 同時活著不會互相破壞。
 *
 * ⚠️ 這個 worker **不發簡報、不同步 WHOOP**。它只讀 DB 回答問題、寫 journal。
 * 這是刻意的：唯一會寫健康資料的地方仍然只有 cron，責任邊界很清楚。
 */

import { loadDotEnvIfPresent, loadEnv } from '../config.js';
import { createDb } from '../db.js';
import { createCoach } from '../coach.js';
import { createTelegramApi } from './api.js';
import { createPoller } from './polling.js';
import { createRouter } from './router.js';
import { handleLinkAttempt } from './link.js';
import { log, describeError } from '../logger.js';

/**
 * 送出回覆前，重新確認這個 chat 現在**仍然**屬於當初產生這則回覆的使用者。
 *
 * 為什麼需要：送出發生在動作交易之外，而且失敗會重送。從產生回覆到真的送出
 * 之間，綁定可能已經被撤銷、換綁到別人、或因為是群組列而被退役。那時候把
 * 回覆送出去就是把一個人的生理資料送進別人的 chat。
 *
 * ⚠️ `resolveUserByChatId()` 回的是 `{ user, link }`，**不是 user 本身**。
 * 舊版比的是 `current?.id` —— 那一層永遠是 `undefined`，於是
 * `undefined !== userId` 恆真，**每一則給已綁定使用者的回覆都被靜靜丟掉**。
 * （`/link` 那條路走的是 `userId: null`，守衛整段被跳過，所以它一直是好的
 * —— 這也是為什麼這個 bug 可以躲過冒煙測試。）
 *
 * 解析不到（null）時 optional chaining 一樣得到 undefined → 比較不成立 →
 * 不送。fail-closed 的行為刻意保持不變。
 */
export function createSendReply({ db, api }) {
  return async function sendReply({ chatId, reply, userId }) {
    if (userId) {
      const current = await db.resolveUserByChatId(chatId);
      if (current?.user?.id !== userId) {
        // 靜靜不送是這個 bug 能存活這麼久的原因之一，所以留下紀錄。
        log.warn('telegram_reply_suppressed_binding_changed', {
          expected_user_id: userId, resolved_user_id: current?.user?.id ?? null,
        });
        return;
      }
    }
    await api.sendMessage(chatId, reply);
  };
}

export async function main({ maxIterations = Infinity } = {}) {
  loadDotEnvIfPresent();
  const env = loadEnv();

  const db = createDb({ url: env.tursoUrl, authToken: env.tursoToken });
  await db.migrate();

  // coach 要 per-user 建立，ai_usage 才會記在正確的人身上
  const coachFor = (userId) => createCoach({
    apiKey: env.openrouterApiKey, model: env.openrouterModel, db, userId,
  });
  const api = createTelegramApi({ botToken: env.telegramBotToken });

  const me = await api.getMe().catch((err) => {
    log.error('telegram_getme_failed', { error: describeError(err) });
    return null;
  });
  const activeUsers = await db.listActiveUsers();
  log.info('bot_start', {
    username: me?.username ?? null,
    active_users: activeUsers.length,
    model: env.openrouterModel,
  });

  const router = createRouter({ db, coachFor });

  const poller = createPoller({
    db,
    botToken: env.telegramBotToken,
    api,
    // 身分解析：chat → ACTIVE 綁定 → ACTIVE 使用者。解析不到回 null。
    resolveUser: (chatId) => db.resolveUserByChatId(chatId),
    handleMessage: async ({ text, chatId, user }) => {
      const reply = await router.handle({ text, chatId, user });
      return reply;
    },
    // Sending is outside the action transaction. A failed/ambiguous send retries
    // the persisted reply, never the committed Journal/action.
    sendReply: createSendReply({ db, api }),
    // 未綁定的 chat：只吃 /link，其他一律不回
    handleUnlinked: async ({ text, chatId, isPrivateChat = false }) => {
      const reply = await handleLinkAttempt({ db, text, chatId, isPrivateChat });
      return reply;
    },
  });

  // graceful shutdown：跑完手上這一輪再收工，不會把處理到一半的訊息丟掉
  const shutdown = (signal) => {
    log.info('bot_shutdown_signal', { signal });
    poller.stop();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  try {
    return await poller.start({ maxIterations });
  } finally {
    try { db.close(); } catch { /* 關連線失敗不影響收工 */ }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      log.error('bot_fatal', { error: describeError(err) });
      process.exit(1);
    });
}
