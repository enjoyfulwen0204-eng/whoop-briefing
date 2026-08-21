#!/usr/bin/env node
// 進入點：Render Cron Job 每 15 分鐘跑這支。
//
// Cron（UTC）： */15 21-23,0-7 * * *    ≈ 台灣時間每天 05:00–15:45，每 15 分鐘
// 程式判斷「今天」一律用 TIMEZONE=Asia/Taipei 的 local date，不用 server UTC 日期。
//
// daily 與 weekly 完全獨立：各自判斷、各自去重、各自 retry。
// daily 已經 SENT 不會讓程式提早 return 而跳過 weekly。

import { WEEKLY, loadDotEnvIfPresent, loadEnv } from './config.js';
import { createDb } from './db.js';
import { createWhoopClient } from './whoop.js';
import { createDataSource } from './dataSource.js';
import { createCoach } from './coach.js';
import { createTelegram } from './telegram.js';
import { runDaily } from './daily.js';
import { runWeekly } from './weekly.js';
import { completedWeeks, localDate, localTime, localWeekday } from './time.js';
import { log, describeError } from './logger.js';

export async function main({ now = new Date() } = {}) {
  loadDotEnvIfPresent();
  const env = loadEnv();
  const tz = env.timezone;

  log.info('run_start', {
    utc: now.toISOString(),
    local: `${localDate(now, tz)} ${localTime(now, tz)}`,
    timezone: tz,
    dry_run: env.dryRun,
  });

  const db = createDb({ url: env.tursoUrl, authToken: env.tursoToken });
  const telegram = createTelegram({
    botToken: env.telegramBotToken,
    chatId: env.telegramChatId,
    dryRun: env.dryRun,
    db,
  });

  const summary = { daily: null, weekly: null, errors: [] };

  try {
    await db.migrate();

    // ---- 先只用 DB 判斷「有沒有事要做」，沒事就完全不打 WHOOP API ----
    const today = localDate(now, tz);
    const weekKey = completedWeeks(now, tz).last.key;
    const dailyDue = !(await db.isSent('daily', today));
    const weeklyDue = localWeekday(today) === WEEKLY.WEEKDAY && !(await db.isSent('weekly', weekKey));

    log.info('due_check', { local_date: today, week_key: weekKey, daily_due: dailyDue, weekly_due: weeklyDue });

    if (!dailyDue && !weeklyDue) {
      log.info('run_skip_nothing_due', { local_date: today });
      return summary;
    }

    const whoop = createWhoopClient({
      db,
      clientId: env.whoopClientId,
      clientSecret: env.whoopClientSecret,
    });
    // 先把 token 準備好（序列化 refresh，避免後面平行請求同時 refresh）
    await whoop.getAccessToken();

    const source = createDataSource({ whoop, now });
    const coach = createCoach({ apiKey: env.anthropicApiKey, model: env.anthropicModel });
    const ctx = { db, source, coach, telegram, timezone: tz, now };

    // ---- daily ----
    if (dailyDue) {
      try {
        summary.daily = await runDaily(ctx);
      } catch (err) {
        summary.errors.push({ stage: 'daily', error: describeError(err) });
        log.error('daily_failed', { error: describeError(err), stack: err?.stack?.split('\n').slice(0, 4) });
        await telegram.notifyError('daily_report', describeError(err));
      }
    }

    // ---- weekly（不因為 daily 的結果而跳過）----
    if (weeklyDue) {
      try {
        summary.weekly = await runWeekly(ctx);
      } catch (err) {
        summary.errors.push({ stage: 'weekly', error: describeError(err) });
        log.error('weekly_failed', { error: describeError(err), stack: err?.stack?.split('\n').slice(0, 4) });
        await telegram.notifyError('weekly_report', describeError(err));
      }
    }
  } catch (err) {
    // 基礎設施層失敗（Turso / token / 環境變數）
    summary.errors.push({ stage: 'bootstrap', error: describeError(err) });
    log.error('run_failed', { error: describeError(err), stack: err?.stack?.split('\n').slice(0, 4) });
    await telegram.notifyError('bootstrap', describeError(err));
  } finally {
    try {
      db.close();
    } catch { /* 關連線失敗不影響結果 */ }
  }

  log.info('run_done', {
    daily: summary.daily?.status ?? 'not_run',
    weekly: summary.weekly?.status ?? 'not_run',
    errors: summary.errors.length,
  });
  return summary;
}

// 直接執行時才跑（被 import 時不跑）
if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .then((s) => process.exit(s.errors.length ? 1 : 0))
    .catch((err) => {
      log.error('fatal', { error: describeError(err) });
      process.exit(1);
    });
}
