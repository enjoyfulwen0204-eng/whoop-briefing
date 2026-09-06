#!/usr/bin/env node
/**
 * Telegram bot worker（常駐 process）。
 *
 * 與每日簡報的 cron **完全分開**部署：
 *   cron   whoop-briefing     每 30 分鐘跑一次就結束
 *   worker whoop-telegram-bot 一直活著，long polling
 *
 * 兩者共用同一個 Turso、同一組 WHOOP token。安全性靠：
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
import { log, describeError } from '../logger.js';

export async function main({ maxIterations = Infinity } = {}) {
  loadDotEnvIfPresent();
  const env = loadEnv();

  const db = createDb({ url: env.tursoUrl, authToken: env.tursoToken });
  await db.migrate();

  const coach = createCoach({
    apiKey: env.openrouterApiKey, model: env.openrouterModel, db,
  });
  const api = createTelegramApi({ botToken: env.telegramBotToken });

  const me = await api.getMe().catch((err) => {
    log.error('telegram_getme_failed', { error: describeError(err) });
    return null;
  });
  log.info('bot_start', {
    username: me?.username ?? null,
    chat_id: String(env.telegramChatId),
    timezone: env.timezone,
    model: env.openrouterModel,
  });

  const router = createRouter({ db, coach, timezone: env.timezone });

  const poller = createPoller({
    db,
    botToken: env.telegramBotToken,
    allowedChatId: env.telegramChatId,
    api,
    handleMessage: async ({ text, chatId }) => {
      const reply = await router.handle({ text, chatId });
      if (reply) await api.sendMessage(chatId, reply);
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
