#!/usr/bin/env node
// 進入點：排程器每 30 分鐘跑這支。
//
// Cron（UTC）： */30 * * * *    全天每 30 分鐘
//
// ## Multi-user
//
// 每次執行會撈出所有 ACTIVE 使用者，然後**各自獨立**處理：
//   - 各自的時區（users.timezone，不是全域 TIMEZONE）
//   - 各自的 WHOOP token 與 refresh lease（鎖名帶 userId）
//   - 各自的 Telegram 目的地（user_telegram）
//   - 各自的報告去重 / claim（key 含 user_id）
//   - 各自的同步狀態
//
// **失敗隔離**：一個使用者出錯絕不影響其他人（mapWithConcurrency 個別捕捉）。
// 併發上限 MAX_USER_CONCURRENCY（預設 3），避免撞 WHOOP rate limit。
//
// 刻意全天跑：daily 的去重 key 是 health_date（主睡眠結束的當地日期），不是執行
// 當下的日期，所以下午才起床、或跨午夜才跑到都能正確補發，而且不會重複發。

import { CRON, WEEKLY, loadDotEnvIfPresent, loadEnv } from './config.js';
import { GLOBAL_SCOPE, userScope } from './schema.js';
import { createDb } from './db.js';
import { createWhoopClient } from './whoop.js';
import { createDataSource } from './dataSource.js';
import { createCoach } from './coach.js';
import { createTelegram } from './telegram.js';
import { runDaily } from './daily.js';
import { runWeekly } from './weekly.js';
import { checkRepoFreshness } from './maintenance.js';
import { createSync } from './sync.js';
import { checkAndAct } from './proactiveAgent.js';
import { mapWithConcurrency } from './concurrency.js';
import { addDays, completedWeeks, localDate, localTime, localWeekday } from './time.js';
import { log, describeError } from './logger.js';

/**
 * 判斷某個使用者現在有沒有事要做。**用該使用者自己的時區算**，
 * 所以 Alice（台北）與 Bob（紐約）在同一個 UTC 瞬間可能是不同的當地日期。
 */
export async function dueForUser({ db, userId, timezone, now }) {
  const today = localDate(now, timezone);
  const yesterday = addDays(today, -1);
  const weekKey = completedWeeks(now, timezone).last.key;

  // daily 的 key 是 health_date，執行前還不知道最新睡眠屬於哪一天，所以無法
  // 精確判斷。保守做法：只有「今天與昨天兩個 health_date 都已 SENT」才算沒事做
  // —— 涵蓋正常當天發送、以及跨午夜補發昨天的情況。
  const dailySettled = (await db.isSent(userId, 'daily', today))
    && (await db.isSent(userId, 'daily', yesterday));
  // 補發寬限內（預設週一～週三）都算「該檢查週報」，週一故障不會整週漏掉
  const weeklyDue = localWeekday(today) <= WEEKLY.CATCHUP_DAYS
    && !(await db.isSent(userId, 'weekly', weekKey));

  return {
    today, yesterday, weekKey, dailySettled, weeklyDue,
    anythingDue: !dailySettled || weeklyDue,
  };
}

/**
 * 跑一個使用者的完整流程。**這個函式不對外拋錯以外的副作用**：
 * 每個階段各自 try/catch，回傳結構化結果。
 *
 * `deps` 讓測試可以注入替身（預設就是真的實作），這樣「報告有沒有送到正確的
 * chat」「一個人失敗會不會影響另一個人」都可以真的驗，而不是只讀程式碼。
 */
export async function runForUser({ db, env, user, now, deps = {} }) {
  const {
    makeTelegram = createTelegram,
    makeWhoop = createWhoopClient,
    makeCoach = createCoach,
    makeSource = createDataSource,
    daily = runDaily,
    weekly = runWeekly,
    makeSync = createSync,
    proactive = checkAndAct,
  } = deps;
  const uid = user.id;
  const tz = user.timezone;
  const out = {
    userId: uid, timezone: tz, daily: null, weekly: null, sync: null, proactive: null,
    skipped: null, errors: [],
  };

  // 1) 這個使用者的 Telegram 目的地。沒有綁定就不能發報告（也不該亂發）。
  const chatId = await db.getActiveChatIdForUser(uid);
  if (!chatId) {
    out.skipped = 'no_active_telegram_link';
    log.warn('user_skipped_no_telegram', { user_id: uid });
    return out;
  }

  // 每個使用者一個 telegram client：chat 綁死，錯誤通知也 scope 到這個人
  const telegram = makeTelegram({
    botToken: env.telegramBotToken,
    chatId,
    dryRun: env.dryRun,
    db,
    errorScope: userScope(uid),
  });

  // 2) per-user due 判斷（用他自己的時區）
  const due = await dueForUser({ db, userId: uid, timezone: tz, now });
  log.info('due_check', {
    user_id: uid, timezone: tz, local_date: due.today, week_key: due.weekKey,
    daily_settled: due.dailySettled, weekly_due: due.weeklyDue,
  });
  if (!due.anythingDue) {
    out.skipped = 'nothing_due';
    return out;
  }

  // 3) 這個使用者的 WHOOP client（token 與 refresh lease 都綁 uid）
  const whoop = makeWhoop({
    db,
    userId: uid,
    clientId: env.whoopClientId,
    clientSecret: env.whoopClientSecret,
  });
  try {
    // 先把 token 準備好（序列化 refresh，避免後面平行請求同時 refresh）
    await whoop.getAccessToken();
  } catch (err) {
    // 這個人的授權壞了 → 只影響他自己，通知他自己
    out.errors.push({ stage: 'whoop_auth', error: describeError(err) });
    log.error('user_whoop_auth_failed', { user_id: uid, error: describeError(err) });
    await telegram.notifyError('whoop_auth', describeError(err));
    return out;
  }

  const source = makeSource({ whoop, now });
  // 傳 db + userId 進去才會把 ai_usage 記在這個人身上
  const coach = makeCoach({
    apiKey: env.openrouterApiKey, model: env.openrouterModel, db, userId: uid,
  });
  const ctx = { db, userId: uid, source, coach, telegram, timezone: tz, now };

  // ---- daily ----
  if (!due.dailySettled) {
    try {
      out.daily = await daily(ctx);
    } catch (err) {
      out.errors.push({ stage: 'daily', error: describeError(err) });
      log.error('daily_failed', {
        user_id: uid, error: describeError(err), stack: err?.stack?.split('\n').slice(0, 4),
      });
      await telegram.notifyError('daily_report', describeError(err));
    }
  }

  // ---- weekly（不因為 daily 的結果而跳過）----
  if (due.weeklyDue) {
    try {
      out.weekly = await weekly(ctx);
    } catch (err) {
      out.errors.push({ stage: 'weekly', error: describeError(err) });
      log.error('weekly_failed', {
        user_id: uid, error: describeError(err), stack: err?.stack?.split('\n').slice(0, 4),
      });
      await telegram.notifyError('weekly_report', describeError(err));
    }
  }

  // ---- 長期資料同步 ----
  // 刻意放在最後：簡報永遠優先，同步只是附加工作。
  try {
    out.sync = await makeSync({ whoop, db, userId: uid, timezone: tz, now }).syncAll();
  } catch (err) {
    out.errors.push({ stage: 'sync', error: describeError(err) });
    log.error('sync_unexpected', { user_id: uid, error: describeError(err) });
  }

  // ---- Proactive Agent（PA3）----
  // 在 sync 之後跑：只有這次 sync 真的帶來新的 health_date 才會做任何事
  // （checkAndAct 內部自己比對游標）。一個使用者的訊號偵測失敗絕不影響
  // 他的日報/週報已經送出的結果，也不影響其他使用者。
  try {
    out.proactive = await proactive({
      db, userId: uid, timezone: tz, telegram, chatId, now,
    });
  } catch (err) {
    out.errors.push({ stage: 'proactive', error: describeError(err) });
    log.error('proactive_unexpected', { user_id: uid, error: describeError(err) });
  }

  return out;
}

export async function main({ now = new Date(), deps = {} } = {}) {
  loadDotEnvIfPresent();
  const env = loadEnv();

  log.info('run_start', {
    utc: now.toISOString(),
    bootstrap_timezone: env.timezone,
    dry_run: env.dryRun,
    max_user_concurrency: env.maxUserConcurrency,
  });

  const db = createDb({ url: env.tursoUrl, authToken: env.tursoToken });

  // 系統層 telegram：只用於「基礎設施故障」通知（Turso 掛了、找不到任何使用者）。
  // chat 用 bootstrap 的 TELEGRAM_CHAT_ID —— 這是唯一還會用到那個 env 的地方。
  const systemTelegram = createTelegram({
    botToken: env.telegramBotToken,
    chatId: env.telegramChatId,
    dryRun: env.dryRun,
    db,
    errorScope: GLOBAL_SCOPE,
  });

  const summary = { users: 0, ok: 0, failed: 0, skipped: 0, perUser: [], errors: [] };

  try {
    await db.migrate();

    // 運維提醒：GitHub 滿 60 天無 commit 會停用排程。系統層，不屬於任何使用者。
    await checkRepoFreshness({
      db, telegram: systemTelegram, now, lastCommitAt: env.repoLastCommitAt,
    });

    const users = await db.listActiveUsers();
    summary.users = users.length;
    if (!users.length) {
      log.warn('run_no_active_users', {});
      return summary;
    }

    const results = await mapWithConcurrency(
      users,
      env.maxUserConcurrency,
      (user) => runForUser({ db, env, user, now, deps }),
    );

    for (const [i, r] of results.entries()) {
      const uid = users[i].id;
      if (r.ok) {
        const v = r.value;
        summary.perUser.push({
          userId: uid,
          daily: v.daily?.status ?? 'not_run',
          weekly: v.weekly?.status ?? 'not_run',
          skipped: v.skipped,
          errors: v.errors.length,
        });
        if (v.skipped) summary.skipped += 1;
        if (v.errors.length) summary.failed += 1;
        else summary.ok += 1;
      } else {
        // runForUser 本身爆掉（理論上不該發生，它內部已經全包）
        summary.failed += 1;
        summary.errors.push({ userId: uid, error: describeError(r.error) });
        summary.perUser.push({ userId: uid, fatal: describeError(r.error) });
        log.error('user_run_fatal', { user_id: uid, error: describeError(r.error) });
      }
    }
  } catch (err) {
    // 基礎設施層失敗（Turso / 環境變數）→ 全域 scope
    summary.errors.push({ stage: 'bootstrap', error: describeError(err) });
    log.error('run_failed', {
      error: describeError(err), stack: err?.stack?.split('\n').slice(0, 4),
    });
    await systemTelegram.notifyError('bootstrap', describeError(err));
  } finally {
    try {
      db.close();
    } catch { /* 關連線失敗不影響結果 */ }
  }

  log.info('run_done', {
    users: summary.users, ok: summary.ok, failed: summary.failed,
    skipped: summary.skipped, errors: summary.errors.length,
  });
  return summary;
}

// 直接執行時才跑（被 import 時不跑）
if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .then((s) => process.exit(s.errors.length || s.failed ? 1 : 0))
    .catch((err) => {
      log.error('fatal', { error: describeError(err) });
      process.exit(1);
    });
}
