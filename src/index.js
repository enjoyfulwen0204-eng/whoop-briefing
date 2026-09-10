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
import { createSync, isSyncDue } from './sync.js';
import { checkAndAct } from './proactiveAgent.js';
import { reapExpiredProactiveQuestions } from './proactiveReaper.js';
import { runGuardian } from './guardian.js';
import { runPredictionCycle } from './predictionPipeline.js';
import { runHealthspanSnapshot } from './healthspanEngine.js';
import { loadDailyMetrics } from './dailyMetrics.js';
import { capabilityStatusForField, isKnownUnavailable } from './capabilityMap.js';
import { HEARTBEAT_COMPONENT } from './guardianPolicy.js';
import { mapWithConcurrency } from './concurrency.js';
import { addDays, completedWeeks, localDate, localTime, localWeekday } from './time.js';
import { log, describeError } from './logger.js';

/** 預測要往回看幾天的 daily_metrics（涵蓋訓練 + 時序切分所需的長度）。 */
const PREDICTION_LOOKBACK_DAYS = 180;

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
    reap = reapExpiredProactiveQuestions,
    predictionCycle = runPredictionCycle,
    healthspan = runHealthspanSnapshot,
  } = deps;
  const uid = user.id;
  const tz = user.timezone;
  const out = {
    userId: uid, timezone: tz, daily: null, weekly: null, sync: null, proactive: null,
    reaped: null, prediction: null, healthspan: null, skipped: null, errors: [],
    maintenance: null,
  };

  /**
   * 純 DB 狀態維護（R2-M-06）。
   *
   * **不呼叫 WHOOP、不呼叫 OpenRouter、不送 Telegram。** 只把資料庫裡的
   * 狀態機推向終局：
   *
   *   - 過期／被取代／被遺棄的主動問題與事件 → 誠實的終局結果
   *   - 歷史遺留的不安全 Telegram 綁定 → 退役（R2-H-01）
   *
   * 每一項都自己吞掉錯誤：維護是背景工作，絕不可以讓主流程失敗，
   * 也絕不可以讓其中一項的故障擋住另一項。
   */
  const runMaintenance = async () => {
    const result = { reaped: null, retiredLinks: null };
    try {
      result.reaped = await reap({ db, userId: uid, now });
      out.reaped = result.reaped;
    } catch (err) {
      out.errors.push({ stage: 'reap', error: describeError(err) });
      log.error('proactive_reap_unexpected', { user_id: uid, error: describeError(err) });
    }
    if (typeof db.retireUnsafeTelegramLinks === 'function') {
      try {
        result.retiredLinks = await db.retireUnsafeTelegramLinks();
      } catch (err) {
        out.errors.push({ stage: 'retire_unsafe_links', error: describeError(err) });
        log.error('retire_unsafe_links_unexpected', {
          user_id: uid, error: describeError(err),
        });
      }
    }
    out.maintenance = result;
    return result;
  };

  // ---------------------------------------------------------------------
  // 0) 純 DB 狀態維護（R2-M-06）
  //
  // ## 為什麼一定要在最前面、而且無條件
  //
  // 這一段完全不需要 WHOOP token，也不需要能送 Telegram —— 它只是把
  // 資料庫裡的狀態機推向終局（過期的追問、卡住的主動事件、不安全的
  // Telegram 綁定）。
  //
  // 舊版把它放在流程中段與尾端，於是兩條路徑會整個跳過它：
  //   - WHOOP 授權失敗 → `return out`（在 reaper 之前）
  //   - 沒有 Telegram 綁定 → `return out`（更早）
  //
  // 實測確認：兩種情況下 reaped 都是 null、事件的 outcome 永遠停在 NULL，
  // 而 Guardian 每 12 小時就誤報一次「有事件卡住」—— 而且 WHOOP 一旦
  // 掛久一點，那個假警報就永遠不會消失。
  //
  // 收斂本來就該在 WHOOP 中斷期間繼續進行。所以它現在是流程的**第一步**，
  // 而且不在任何 early return 之後。
  // ---------------------------------------------------------------------
  await runMaintenance();

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
  //
  // ⚠️ V1.1：報告排程與資料新鮮度是**兩件獨立的事**。
  //
  // 舊版只問「有沒有報告要發」，沒有就整個 return —— 於是每天日報送出之後
  // 的那十幾個小時，WHOOP 同步與主動代理**一次都不會跑**。後果是 WHOOP
  // 的事後改分／補值要等到隔天才會被看到，而主動代理的指紋變更偵測
  // （它存在的理由就是為了抓「sleep 先進來、recovery 稍後才被評分」）
  // 根本沒有機會觸發。
  //
  // 「報告不用發」不等於「健康資料不需要更新」。
  const due = await dueForUser({ db, userId: uid, timezone: tz, now });
  const syncDue = await isSyncDue({ db, userId: uid, now }).catch(() => true);
  out.syncDue = syncDue;

  log.info('due_check', {
    user_id: uid, timezone: tz, local_date: due.today, week_key: due.weekKey,
    daily_settled: due.dailySettled, weekly_due: due.weeklyDue,
    reports_due: due.anythingDue, sync_due: syncDue,
  });

  // 報告不用發、資料也還在節流窗內 → 乾淨的 no-op。
  // 刻意在拿 WHOOP token **之前** 就返回：這一輪完全不碰 WHOOP。
  if (!due.anythingDue && !syncDue) {
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
    // ★ M-08：拿得到 token 就代表授權已經恢復。把累積的失敗紀錄清掉，
    // 否則 Guardian 會靠著那個永遠不會被清的 hits 計數，每 12 小時
    // 重複通知「需要重新授權」——直到天荒地老。
    if (typeof db.clearUserErrorNotify === 'function') {
      try {
        await db.clearUserErrorNotify(uid, 'whoop_auth');
      } catch (err) {
        // 清不掉不影響這一輪的任何事，只是 Guardian 可能晚一輪才安靜
        log.warn('whoop_auth_recovery_clear_failed', {
          user_id: uid, error: describeError(err),
        });
      }
    }
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
  // 報告的條件維持原樣（health_date 去重 + report_claims），完全沒有放寬。
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
  // 刻意放在報告之後：簡報永遠優先，同步只是附加工作。
  // 這裡**不**再看報告有沒有要發——syncAll 內部本來就有 per-resource 節流
  // （resourceSyncDue），它才是節流的權威。上面的 syncDue 只用來決定
  // 「這一輪要不要為了同步而去拿 token」，不重複做逐一 resource 的判斷。
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

  // ---- 預測生產迴圈（V1.1 Phase 10）----
  // 訓練 → 時序評估 → 對照樸素基準線 → 存模型 → 產生候選預測 → 回填實際值。
  // **發布仍然是關著的**：品質門檻尚未設定，所以不會有任何預測數字被拿給
  // 使用者看。照樣算、照樣存是刻意的——不存就永遠不會有記分卡，也就永遠
  // 沒有資料能證明模型好不好，於是永遠不可能從「不合格」畢業。
  //
  // 放在 sync 之後：要用剛同步進來的資料。放在 proactive 之後：主動訊息
  // 比預測重要，預測失敗絕不能影響它。
  // ⚠️ F-02：預測與 Healthspan 是**兩個互相獨立的選配能力**，各自要有自己的
  // 錯誤邊界。它們以前共用一個 try/catch，所以預測一炸，Healthspan 就整個
  // 不會執行——而且只會留下一筆 `prediction` 錯誤，看 log 的人根本不會發現
  // Healthspan 從此再也沒有盤點過。
  //
  // 共用的只有「準備輸入」（錨點日期、daily_metrics、capability）。那一段
  // 失敗時兩者都做不了，所以它有自己的邊界與自己的 stage 名稱。
  let analysisInputs = null;
  try {
    const anchor = (await db.coverage(uid))?.last_date ?? null;
    if (anchor) {
      const predRows = await loadDailyMetrics({
        db, userId: uid, timezone: tz, from: addDays(anchor, -PREDICTION_LOOKBACK_DAYS), to: anchor,
      });
      // capability 接線：目標指標**已經證實**拿不到時，成熟度是
      // UNSUPPORTED 而不是「資料還在累積」。查不到 capability（還沒 probe）
      // 一律當成 null → 繼續走樣本數邏輯，絕不誤判成不支援。
      const caps = await db.getCapabilities(uid).catch(() => ({}));
      analysisInputs = { anchor, predRows, caps };
    }
  } catch (err) {
    out.errors.push({ stage: 'analysis_inputs', error: describeError(err) });
    log.error('analysis_inputs_failed', { user_id: uid, error: describeError(err) });
  }

  // ---- 預測生產迴圈（V1.1 Phase 10）----
  if (analysisInputs) {
    try {
      const targetStatus = capabilityStatusForField('recovery', analysisInputs.caps);
      out.prediction = await predictionCycle({
        db,
        userId: uid,
        rows: analysisInputs.predRows,
        anchorDate: analysisInputs.anchor,
        capabilityUnavailable: isKnownUnavailable(targetStatus),
        now,
      });
    } catch (err) {
      out.errors.push({ stage: 'prediction', error: describeError(err) });
      log.error('prediction_unexpected', { user_id: uid, error: describeError(err) });
    }
  }

  // ---- Personal Healthspan 盤點（V1.1 Phase 12）----
  // snapshotContributors 以前沒有任何生產呼叫端，兩張 healthspan 表
  // 在正常運作下永遠是空的。現在每輪盤點一次。
  // **分數永遠寫 null**——沒有經過驗證的權重，那是正確答案不是待辦。
  //
  // 自己的 try/catch：預測失敗絕不影響這裡，這裡失敗也絕不回頭影響
  // 已經算好的 out.prediction。
  if (analysisInputs) {
    try {
      out.healthspan = await healthspan({
        db,
        userId: uid,
        rows: analysisInputs.predRows,
        endDate: analysisInputs.anchor,
        capabilities: analysisInputs.caps,
        now,
      });
    } catch (err) {
      out.errors.push({ stage: 'healthspan', error: describeError(err) });
      log.error('healthspan_unexpected', { user_id: uid, error: describeError(err) });
    }
  }

  // ---- 過期主動問題的收割（V1.1 Phase 5）----
  // 「問了但使用者從此沒再傳任何訊息」以前會永遠停在 OPEN、事件的 outcome
  // 永遠是 NULL。這一步把它收成 EXPIRED + NO_RESPONSE，讓「被無視」變成
  // 資料上真的存在的事實——那是之後要調 TTL 唯一能依據的東西。
  return out;
}

export async function main({ now = new Date(), deps = {} } = {}) {
  const { guardian = runGuardian } = deps;
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

  const summary = {
    users: 0, ok: 0, failed: 0, skipped: 0, perUser: [], errors: [], guardian: null,
  };

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

    // ---- 運維心跳（V1.1 Phase 9）----
    // 「這一輪 cron 真的跑完了」是系統裡唯一沒有任何地方記錄的事實，
    // 而 cron 死掉時是**安靜地**死（沒有 run 就沒有錯誤通知）。
    // 記在成功跑完所有使用者之後，所以它代表的是「整輪走到底」。
    try {
      await db.recordHeartbeat(GLOBAL_SCOPE, HEARTBEAT_COMPONENT.CRON, {
        detail: `users=${users.length}`, now,
      });
    } catch (err) {
      log.warn('heartbeat_failed', { error: describeError(err) });
    }

    // ---- System Guardian（V1.1 Phase 9）----
    // 只看已經持久化的事實 → 判斷 →（必要時）發一則 Telegram。
    // 健康時完全靜默。絕不修改任何東西。自己吞掉所有錯誤。
    try {
      summary.guardian = await guardian({
        db,
        systemTelegram,
        makeTelegram: ({ chatId, errorScope }) => (deps.makeTelegram ?? createTelegram)({
          botToken: env.telegramBotToken,
          chatId,
          dryRun: env.dryRun,
          db,
          errorScope,
        }),
        now,
      });
    } catch (err) {
      log.error('guardian_unexpected', { error: describeError(err) });
    }

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
