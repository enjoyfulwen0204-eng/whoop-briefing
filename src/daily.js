/**
 * 每日簡報流程。
 *
 * 效率原則：
 *  - 每 15 分鐘的 polling 只抓「判斷起床所需的最新 Sleep / Recovery」。
 *  - 只有真的準備發報告了，才抓 45 天歷史算 baseline。
 */

import { BASELINE, REPORT_CLAIM } from './config.js';
import { requireUserId } from './userContext.js';
import {
  buildObservations, completedCycles, detectWake, baselineRecords, stageFor,
  computeBaselines, evaluateAll, detectTrends, yesterdayCycleFor,
} from './analyze.js';
import { renderDaily } from './format.js';
import { buildInsightsSafe } from './insights.js';
import { guardPublication } from './publishGuard.js';
import { factsFromBriefing } from './publishableFacts.js';
import { log, describeError } from './logger.js';
import { TelegramError } from './telegram.js';

/**
 * @param {string} userId   **必填**。這份報告屬於誰。
 * @param {string} timezone **該使用者的**時區（不是全域 TIMEZONE）。
 * @param {object} telegram 已經綁定到該使用者 chat 的 telegram client。
 */
export async function runDaily({
  db, userId, source, coach, telegram, timezone, now = new Date(),
}) {
  const uid = requireUserId(userId, 'runDaily');
  // 1) 輕量 polling。刻意放在去重之前：health_date 是從最新那筆睡眠算出來的，
  //    沒抓資料就不知道要用哪個 key 去重。「完全沒事做」的快速返回在 index.js。
  const { sleeps: pollSleeps, recoveries: pollRecoveries } = await source.poll();
  const wake = detectWake({
    observations: buildObservations({
      sleeps: pollSleeps, recoveries: pollRecoveries, timezone,
    }),
    now,
    timezone,
  });

  if (!wake.ready) {
    log.info('daily_not_ready', {
      reason: wake.reason,
      minutes_since_wake: wake.minutesSinceWake ?? null,
      hours_since_wake: wake.hoursSinceWake ?? null,
      health_date: wake.healthDate ?? null,
    });
    return { status: 'not_ready', reason: wake.reason };
  }

  const healthDate = wake.healthDate;

  // 2) 去重：用 health_date，不是執行當天。所以下午才起床、或跨午夜才跑到，
  //    都還是同一個 key，不會漏發也不會重複發。
  if (await db.isSent(uid, 'daily', healthDate)) {
    log.info('daily_already_sent', { health_date: healthDate });
    return { status: 'already_sent', healthDate, localDate: healthDate };
  }

  log.info('daily_wake_detected', {
    health_date: healthDate,
    sleep_id: wake.record.sleepId,
    minutes_since_wake: wake.minutesSinceWake,
  });

  // 3) 取得發送權（跨 process）。isSent 到寫入 SENT 之間有 TOCTOU 空窗，
  //    claim 把那段空窗鎖起來：同一份報告同時只有一個 process 會做事。
  //    刻意放在「抓歷史 / 呼叫 LLM」之前 —— 沒搶到就不必浪費那些成本。
  const claiming = typeof db.claimReport === 'function';
  // claim / dedupe 的邏輯 key 一律含 userId：Alice 的 claim 不可阻塞 Bob
  const claimKey = { userId: uid, ...{ reportType: 'daily', localDateKey: healthDate } };
  let claim = { granted: true, owner: null };
  if (claiming) {
    claim = await db.claimReport({ ...claimKey, ttlMs: REPORT_CLAIM.TTL_MS });
    if (!claim.granted) {
      log.info('daily_claim_denied', {
        health_date: healthDate, already_sent: claim.alreadySent,
      });
      return {
        status: claim.alreadySent ? 'already_sent' : 'claim_busy',
        healthDate,
        localDate: healthDate,
      };
    }
  }

  /** 還沒送出就失敗時把發送權還回去，讓下一輪立刻重試（不必等 TTL）。 */
  const releaseClaim = async () => {
    if (!claiming || !claim.owner) return;
    try {
      await db.releaseClaim({ ...claimKey, owner: claim.owner });
    } catch (err) {
      log.warn('daily_claim_release_failed', { error: describeError(err) });
    }
  };

  // 4) 準備發報告了 → 才抓 45 天歷史
  let briefing;
  let coachText;
  let text;
  try {
    const { sleeps, recoveries, cycles } = await source.history();
    briefing = buildBriefing({
      sleeps, recoveries, cycles, timezone, healthDate, wakeSleepId: wake.record.sleepId,
    });
    // 統計層（z-score / What Changed）。**任何失敗都只是沒有這一段**，
    // 絕不影響簡報本身 —— buildInsightsSafe 自己吞掉所有錯誤回 null。
    const insights = await buildInsightsSafe({ db, userId: uid, timezone, healthDate });
    briefing.whatChanged = insights?.whatChanged ?? null;
    briefing.historyDays = insights?.historyDays ?? null;

    // AI 只負責講話；掛掉就走 fallback（照樣發數據簡報）
    coachText = await coach.daily(briefing);

    // ★ 發布邊界（R2-H-02）：敘述裡的每一個數值宣稱都必須歸屬到一筆
    // **可發布的結構化事實**。事實由 factsFromBriefing(briefing) 從確定性層
    // 直接建立 —— 不是拿餵給模型的那段文字去比對字串。
    //
    // 為什麼換掉舊做法：舊版比對的是「這個數字在 prompt 文字裡出現過嗎」，
    // 獨立稽核用改寫（逗號、語序、英文指標名、中文數字）繞過了 13/22。
    //
    // fallback 給 null 是刻意的：renderDaily(briefing, null) 本來就會印出
    // FALLBACK_NOTE 並保留完整的確定性數據簡報。也就是說守門失敗只會讓
    // 教練那段話消失，**數據簡報照常送出**。
    const guarded = guardPublication({
      narrative: coachText,
      factSet: factsFromBriefing(briefing),
      fallback: null,
      label: 'daily',
    });
    if (coachText && guarded.used === 'fallback') {
      log.warn('daily_narrative_rejected', {
        health_date: healthDate,
        violations: guarded.violations?.slice(0, 6) ?? [],
      });
    }
    coachText = guarded.text;

    text = renderDaily(briefing, coachText);
  } catch (err) {
    await releaseClaim();
    throw err;
  }

  // 5) 發送
  let sent;
  try {
    sent = await telegram.send(text);
  } catch (err) {
    await releaseClaim();
    // 記錄失敗原因時不能再拋錯，否則會蓋掉真正的錯誤
    await db.recordRun({
      userId: uid,
      reportType: 'daily',
      localDateKey: healthDate,
      healthDate,
      sleepId: briefing.sleepId,
      cycleId: briefing.cycleId,
      status: 'FAILED',
      detail: describeError(err),
    }, { throwOnError: false });
    if (err instanceof TelegramError) {
      // Telegram 自己掛了 → 只寫 log，不遞迴再呼叫 Telegram
      log.error('daily_telegram_failed', { health_date: healthDate, error: describeError(err) });
      return {
        status: 'telegram_failed', healthDate, localDate: healthDate, error: describeError(err),
      };
    }
    throw err;
  }

  // 6) ★ 訊息已經出去了 —— 立刻把「已送出」這件事釘進 claim。
  //    這是一個極小的 UPDATE，比整筆 report_runs insert 更可能成功，
  //    而且它才是防重發的關鍵證據：claim 一旦有 telegram_sent_at，
  //    之後永遠不會再被授予，即使下面的 SENT 紀錄寫失敗。
  if (claiming && claim.owner) {
    try {
      const marked = await db.markClaimSent({
        ...claimKey, owner: claim.owner, messageId: sent.messageId,
      });
      if (!marked) log.warn('daily_claim_mark_noop', { health_date: healthDate });
    } catch (err) {
      log.error('daily_claim_mark_failed', {
        health_date: healthDate, error: describeError(err),
      });
    }
  }

  // 7) 記錄。訊息已經發出去、收不回來了 —— 紀錄寫入失敗不能當成「發送失敗」，
  //    但一定要大聲喊：沒有 SENT 紀錄，下一輪 isSent 會回 false 而重複發送。
  let recorded = true;
  try {
    await db.recordRun({
      userId: uid,
      reportType: 'daily',
      localDateKey: healthDate,
      healthDate,
      sleepId: briefing.sleepId,
      cycleId: briefing.cycleId,
      telegramMessageId: sent.messageId,
      status: 'SENT',
      detail: coachText ? null : 'coach_fallback',
    });
  } catch (err) {
    recorded = false;
    log.error('daily_record_failed_after_send', {
      health_date: healthDate, error: describeError(err),
    });
    await telegram.notifyError(
      'daily_record',
      `今天的簡報已經發出去了，但發送紀錄寫不進 Turso → 下一輪可能會重複發一次。${describeError(err)}`,
    );
  }

  log.info('daily_sent', {
    health_date: healthDate, stage: briefing.stage, samples: briefing.sampleCount,
    coach: coachText ? 'ok' : 'fallback', chars: text.length, recorded,
  });
  return {
    status: 'sent', healthDate, localDate: healthDate, text, briefing,
    coachUsed: Boolean(coachText), recorded,
  };
}

/**
 * 純函式：原始資料 → 算好的 briefing 物件（好測、dry-run 也用它）。
 *
 * healthDate 是「要報告哪一個健康日」。一律用它做顯示日期、baseline 排除與趨勢
 * 起點，執行當下的日期完全不參與。
 */
export function buildBriefing({
  sleeps, recoveries, cycles, timezone, healthDate = null, wakeSleepId,
}) {
  // 每個 health_date 一筆（同日多筆主睡眠取 sleep.end 最晚那筆）
  const observations = buildObservations({ sleeps, recoveries, timezone });

  const todayRecord = (healthDate
      ? observations.find((o) => o.healthDate === healthDate)
      : null)
    ?? observations.find((o) => o.sleepId === String(wakeSleepId))
    ?? observations[0];
  if (!todayRecord) throw new Error('buildBriefing：找不到任何主睡眠紀錄');

  const reportDate = healthDate ?? todayRecord.healthDate;

  // 昨日 Strain：sleep.end 之前最近一個已完成 cycle（單向，不會拿到起床後的）
  const cyclesDesc = completedCycles(cycles);
  const yesterdayCycle = yesterdayCycleFor(todayRecord, cyclesDesc);

  const baseSet = baselineRecords({
    records: observations,
    healthDate: reportDate,
    excludeSleepId: todayRecord.sleepId,
  });
  const sampleCount = Math.min(baseSet.length, BASELINE.TARGET_SAMPLES);
  const stage = stageFor(baseSet.length);

  // strain 的基準也走 yesterdayCycleFor，跟今日顯示值同一個口徑
  const baselines = computeBaselines({ records: baseSet, cycles: cyclesDesc });

  const metrics = evaluateAll({ record: todayRecord, cycle: yesterdayCycle, baselines, stage });

  // 趨勢：從本次報告的 health_date 往回取逐日相鄰的健康日，缺一天就中斷
  const trends = detectTrends({
    observations,
    baselines,
    stage,
    anchorDate: reportDate,
  });

  return {
    kind: 'daily',
    healthDate: reportDate,
    localDate: reportDate, // 舊欄位名，值與 healthDate 相同
    sleepId: todayRecord.sleepId,
    cycleId: yesterdayCycle ? String(yesterdayCycle.id) : null,
    stage,
    sampleCount,
    baselineTotalRecords: baseSet.length,
    metrics,
    baselines,
    trends,
  };
}
