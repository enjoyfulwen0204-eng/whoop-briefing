#!/usr/bin/env node
// 進入點：排程器每 30 分鐘跑這支。
//
// Cron（UTC）： */30 * * * *    全天每 30 分鐘
// 刻意全天跑：daily 的去重 key 是 health_date（主睡眠結束的當地日期），不是執行
// 當下的日期，所以下午才起床、或跨午夜才跑到都能正確補發，而且不會重複發。
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
import { checkRepoFreshness } from './maintenance.js';
import { addDays, completedWeeks, localDate, localTime, localWeekday } from './time.js';
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

    // 運維提醒：GitHub 滿 60 天無 commit 會停用排程，屆時簡報會安靜停掉。
    // 放在 due 判斷之前，所以「沒事做」的那些 run 也會檢查。自己不拋錯。
    await checkRepoFreshness({ db, telegram, now, lastCommitAt: env.repoLastCommitAt });

    // ---- 先只用 DB 判斷「有沒有事要做」，沒事就完全不打 WHOOP API ----
    //
    // daily 的 key 是 health_date，執行前還不知道最新睡眠屬於哪一天，所以無法
    // 精確判斷。保守做法：只有「今天與昨天兩個 health_date 都已 SENT」才可能沒事做
    // —— 涵蓋正常當天發送、以及跨午夜補發昨天的情況。
    const today = localDate(now, tz);
    const yesterday = addDays(today, -1);
    const weekKey = completedWeeks(now, tz).last.key;

    const dailySettled = (await db.isSent('daily', today))
      && (await db.isSent('daily', yesterday));
    const weeklyDue = localWeekday(today) === WEEKLY.WEEKDAY
      && !(await db.isSent('weekly', weekKey));

    log.info('due_check', {
      local_date: today, yesterday, week_key: weekKey,
      daily_settled: dailySettled, weekly_due: weeklyDue,
    });

    // 快速返回一定要把「週報待發」算進去，否則週一 daily 發完後會永久跳過週報
    if (dailySettled && !weeklyDue) {
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
    const coach = createCoach({ apiKey: env.openrouterApiKey, model: env.openrouterModel });
    const ctx = { db, source, coach, telegram, timezone: tz, now };

    // ---- daily ----
    if (!dailySettled) {
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
