/**
 * 每日簡報流程。
 *
 * 效率原則：
 *  - 每 15 分鐘的 polling 只抓「判斷起床所需的最新 Sleep / Recovery」。
 *  - 只有真的準備發報告了，才抓 45 天歷史算 baseline。
 */

import { BASELINE, REPORT_CLAIM, WAKE } from './config.js';
import { LATE_POLICY } from './briefingState.js';
import { requireUserId } from './userContext.js';
import { localDate } from './time.js';
import { BRIEFING_OUTCOME, isRetryableOutcome } from './briefingState.js';
import {
  buildObservations, completedCycles, detectWake, baselineRecords, stageFor,
  computeBaselines, evaluateAll, detectTrends, yesterdayCycleFor,
} from './analyze.js';
import { renderDaily } from './format.js';
import { buildNarrative } from './narrative.js';
import { buildInsightsSafe } from './insights.js';
import { log, describeError } from './logger.js';
import { DELIVERY_RESULT, deliverReport, renewReportClaim } from './reportDelivery.js';

/**
 * @param {string} userId   **必填**。這份報告屬於誰。
 * @param {string} timezone **該使用者的**時區（不是全域 TIMEZONE）。
 * @param {object} telegram 已經綁定到該使用者 chat 的 telegram client。
 */
export async function runDaily({
  db, userId, source, coach, telegram, timezone, now = new Date(),
  // ★ R2：這一輪的帳號啟用世代（由 index.js 的 worker 進入點捕捉）。
  // 報告認領會記下它，於是舊啟用期留下的未送出認領不會擋住新啟用期的報告。
  expectedLifecycleGeneration = null,
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

  // 每一次評估都留下足夠的欄位，讓事後可以區分「跑了但還不能發」與「根本
  // 沒跑」。2026-09-12 的事故裡這兩者在紀錄上長得一模一樣，追查時只能靠
  // cron heartbeat 反推。
  //
  // ⚠️ 這些只是 log。真正的耐久狀態需要一張新表（見 README / v8 提案）——
  // 沒有經過核可之前不會寫任何新的 production 狀態。
  const evaluatedAt = new Date(now).toISOString();
  const todayLocal = localDate(now, timezone);
  const observationAgeMinutes = wake.record?.endUtc
    ? Math.round((new Date(now).getTime() - Date.parse(wake.record.endUtc)) / 60_000)
    : null;
  /** 這個 reason 會不會因為「等一下再跑一次」而改變？ */
  const retryable = wake.reason !== 'sleep_too_old';
  const base = {
    evaluated_at: evaluatedAt,
    local_date: todayLocal,
    timezone,
    observation_health_date: wake.healthDate ?? wake.record?.healthDate ?? null,
    observation_age_minutes: observationAgeMinutes,
  };

  /**
   * 把「這一輪看到什麼」寫成耐久狀態（v8）。
   *
   * 絕不讓它失敗影響簡報本身：診斷是附加價值，不是先決條件。
   */
  const recordEvaluation = async (outcome, extra = {}) => {
    if (typeof db.recordBriefingEvaluation !== 'function') return;
    try {
      await db.recordBriefingEvaluation({
        userId: uid,
        reportType: 'daily',
        evaluatedAt,
        localDate: todayLocal,
        targetHealthDate: wake.healthDate ?? wake.record?.healthDate ?? null,
        outcome,
        retryable: isRetryableOutcome(outcome),
        observationAgeMinutes,
        ...extra,
      });
    } catch (err) {
      log.warn('briefing_evaluation_record_failed', { error: describeError(err) });
    }
  };

  /** detectWake 的 reason → 耐久詞彙。分得細才答得出「我在等什麼」。 */
  const OUTCOME_FOR_REASON = {
    no_main_sleep: BRIEFING_OUTCOME.WAITING_FOR_SLEEP,
    sleep_not_scored: BRIEFING_OUTCOME.WAITING_FOR_SLEEP_SCORE,
    recovery_missing: BRIEFING_OUTCOME.WAITING_FOR_RECOVERY,
    recovery_not_scored: BRIEFING_OUTCOME.WAITING_FOR_RECOVERY_SCORE,
    too_soon: BRIEFING_OUTCOME.TOO_SOON,
  };

  if (!wake.ready) {
    log.info('daily_not_ready', {
      ...base,
      reason: wake.reason,
      minutes_since_wake: wake.minutesSinceWake ?? null,
      hours_since_wake: wake.hoursSinceWake ?? null,
      health_date: wake.healthDate ?? null,
      retryable,
    });
    // ★ 超過補發時限是**終局**：再跑一百次也不會變。
    if (wake.reason === 'sleep_too_old') {
      const missedHealthDate = wake.healthDate ?? wake.record?.healthDate ?? null;
      log.warn('daily_discarded_window_expired', {
        ...base,
        late_window_hours: LATE_POLICY.LATE_WINDOW_HOURS,
        hours_since_wake: wake.hoursSinceWake ?? null,
        terminal: true,
      });
      // 已經送出過的那一天不算漏發 —— 那只是一筆過期的舊觀測。
      const alreadyDelivered = missedHealthDate
        ? await db.isSent(uid, 'daily', missedHealthDate).catch(() => false)
        : false;
      // ★ 冪等靠**耐久狀態**，不靠通知冷卻。
      // 排程每 10 分鐘跑一次，如果每一輪都重新宣告一次漏發，那就是把一個
      // 修好的問題換成另一個騷擾來源。已經記成 MISSED 的同一天就直接收工。
      let alreadyMissed = false;
      if (missedHealthDate && typeof db.getBriefingEvaluation === 'function') {
        try {
          const prev = await db.getBriefingEvaluation(uid, 'daily');
          alreadyMissed = prev?.outcome === BRIEFING_OUTCOME.MISSED
            && prev?.targetHealthDate === missedHealthDate;
        } catch { alreadyMissed = false; }
      }
      if (!alreadyDelivered && !alreadyMissed) {
        await recordEvaluation(BRIEFING_OUTCOME.MISSED, {
          reason: wake.reason,
          detail: `age_hours=${wake.hoursSinceWake ?? '?'}`,
        });
        // 只通知一次：用 health_date 當訊號名稱，所以同一天不會重複，
        // 不同天各自可以通知。冷卻取很長，避免任何重播。
        if (missedHealthDate) {
          await telegram.notifyError(
            `daily_missed_${missedHealthDate}`,
            `${missedHealthDate} 的晨報沒有在可補發的時間內送出，所以我不會再補那一份了。`
            + '後續的簡報不受影響。',
            { cooldownHours: 24 * 30 },
          ).catch(() => false);
        }
      }
      return {
        status: 'missed', reason: wake.reason, retryable: false, healthDate: missedHealthDate,
      };
    }
    await recordEvaluation(
      OUTCOME_FOR_REASON[wake.reason] ?? BRIEFING_OUTCOME.WAITING_FOR_SLEEP,
      { reason: wake.reason },
    );
    return { status: 'not_ready', reason: wake.reason, retryable };
  }

  const healthDate = wake.healthDate;

  // 2) 去重：用 health_date，不是執行當天。所以下午才起床、或跨午夜才跑到，
  //    都還是同一個 key，不會漏發也不會重複發。
  if (await db.isSent(uid, 'daily', healthDate)) {
    // ★ 區分兩種 already_sent：
    //   · 今天的份已經送了 → 使用者沒在等任何東西
    //   · **前一天**的份已經送了，而今天的資料還沒出現 → 使用者正在等，
    //     而系統看起來卻像「沒事做」。2026-09-12 事故走的正是這一條。
    const staleObservation = healthDate !== todayLocal;
    log.info('daily_already_sent', {
      ...base,
      health_date: healthDate,
      stale_observation: staleObservation,
      awaiting_current_date: staleObservation,
    });
    await recordEvaluation(BRIEFING_OUTCOME.ALREADY_SENT, {
      reason: staleObservation ? 'prior_health_date' : 'current_health_date',
    });
    return {
      status: 'already_sent', healthDate, localDate: healthDate, staleObservation,
    };
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
    claim = await db.claimReport({
      ...claimKey, ttlMs: REPORT_CLAIM.TTL_MS,
      // ★ R2：認領屬於這一輪的啟用期（見 db.claimReport）。
      expectedLifecycleGeneration,
    });
    if (!claim.granted) {
      // ★ 三種拒絕要分開，因為處置完全不同：
      //   already_sent  使用者已經收到了 → 什麼都不用做
      //   ambiguous     上一次送出結果不明 → **終局**，排程永遠不再自動送。
      //                 這是 fail-closed：寧可漏一次，也不要讓人收到兩份。
      //   claim_busy    別人正在做 → 下一輪再看
      if (claim.ambiguous) {
        log.error('daily_claim_denied_ambiguous', { ...base, health_date: healthDate });
        await recordEvaluation(BRIEFING_OUTCOME.FAILED, { reason: 'delivery_ambiguous' });
        return {
          status: 'delivery_ambiguous', healthDate, localDate: healthDate, retryable: false,
        };
      }
      log.info('daily_claim_denied', {
        health_date: healthDate, already_sent: claim.alreadySent,
      });
      await recordEvaluation(
        claim.alreadySent ? BRIEFING_OUTCOME.ALREADY_SENT : BRIEFING_OUTCOME.CLAIM_BUSY,
      );
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
  let narrativeSource = null;
  let narrativeFailure = null;
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

    // ★ 敘述層（H-05）。健康判斷與**每一個字**都由應用程式擁有：
    // 模型收到的是一份已經寫好的句子清單，它唯一能回的是一串 id。
    // 它挑得不合法（編造 id、丟掉事實骨幹…）就用預設順序，
    // 使用者一樣拿得到一段完整可讀的話。見 narrativePlan.js。
    const narrative = await buildNarrative({
      briefing,
      plan: typeof coach?.narrativePlan === 'function'
        ? (fragments) => coach.narrativePlan(fragments, { period: 'daily' })
        : null,
    });
    coachText = narrative.text;
    narrativeSource = narrative.source;
    narrativeFailure = narrative.failureCategory;

    text = renderDaily(briefing, coachText);
    // ★ 補發必須看得出來是補發。標示用的是**這份報告的 health_date**，
    // 不是執行當下的日期 —— 使用者要知道這是哪一天的報告。
    if (wake.late) {
      text = `📮 補發：${healthDate} 的晨報\n`
        + '（這份資料比平常晚才備齊或晚一步被處理，所以現在才送。）\n\n'
        + text;
    }
  } catch (err) {
    await releaseClaim();
    throw err;
  }

  // 5) ★ 生成結束、外部送出開始。
  //
  //    先續租一次：抓 45 天歷史 + 等模型回應可能已經吃掉大半個租期，
  //    而正常的長工作不該因此失去所有權。續租只是效率 ——
  //    真正的安全邊界是下面 deliverReport() 裡的授權圍欄。
  await renewReportClaim({
    db, claimKey, claim, ttlMs: REPORT_CLAIM.RENEW_MS, now, stage: 'pre_send',
  });

  const delivery = await deliverReport({
    db, claimKey, claim, telegram, text, now: () => now,
  });

  if (delivery.result === DELIVERY_RESULT.FENCED) {
    // 租約在生成期間過期，別人接手了（而且可能已經送出）。
    // **不送、不還 claim、不寫 FAILED** —— 這一輪什麼都沒發生。
    log.warn('daily_delivery_fenced', { ...base, health_date: healthDate });
    await recordEvaluation(BRIEFING_OUTCOME.CLAIM_BUSY, { reason: 'ownership_lost' });
    return { status: 'claim_lost', healthDate, localDate: healthDate };
  }

  if (delivery.result === DELIVERY_RESULT.DEFINITE_FAILURE) {
    // 證明得了沒送出去 → 發送權已經歸還，下一輪可以安全重試。
    await db.recordRun({
      userId: uid,
      reportType: 'daily',
      localDateKey: healthDate,
      healthDate,
      sleepId: briefing.sleepId,
      cycleId: briefing.cycleId,
      status: 'FAILED',
      detail: delivery.error,
    }, { throwOnError: false });
    await recordEvaluation(BRIEFING_OUTCOME.FAILED, { reason: 'telegram_send_failed' });
    log.error('daily_telegram_failed', { health_date: healthDate, error: delivery.error });
    return {
      status: 'telegram_failed', healthDate, localDate: healthDate, error: delivery.error,
    };
  }

  if (delivery.result === DELIVERY_RESULT.AMBIGUOUS) {
    // ★ 這就是 H-01。Telegram 可能已經把晨報交給使用者了，只是我們證明不了。
    // claim 已經是終局狀態，排程**不會**再送一次。
    await db.recordRun({
      userId: uid,
      reportType: 'daily',
      localDateKey: healthDate,
      healthDate,
      sleepId: briefing.sleepId,
      cycleId: briefing.cycleId,
      status: 'AMBIGUOUS',
      detail: delivery.error,
    }, { throwOnError: false });
    await recordEvaluation(BRIEFING_OUTCOME.FAILED, { reason: 'delivery_ambiguous' });
    log.error('daily_delivery_ambiguous', { health_date: healthDate, error: delivery.error });
    return {
      status: 'delivery_ambiguous', healthDate, localDate: healthDate,
      error: delivery.error, retryable: false,
    };
  }

  const sent = { messageId: delivery.messageId };

  // 6) 記錄。訊息已經發出去、收不回來了 —— 紀錄寫入失敗不能當成「發送失敗」。
  //
  //    ★ 這裡**不再**是防重發的最後一道防線。claim 的 delivery_state 已經是
  //    DELIVERED（終局），所以就算這筆 SENT 寫失敗，下一輪也拿不到發送權。
  //    仍然要大聲喊：缺紀錄會讓事後追查與統計失真。
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
      detail: narrativeFailure ? `narrative=${narrativeSource};reason=${narrativeFailure}` : null,
    });
  } catch (err) {
    recorded = false;
    log.error('daily_record_failed_after_send', {
      health_date: healthDate, error: describeError(err),
    });
    await telegram.notifyError(
      'daily_record',
      '今天的簡報已經發出去了，但發送紀錄寫不進 Turso。'
      + '不會重複發送（發送權已經是終局狀態），但歷史紀錄會少一筆。'
      + describeError(err),
    );
  }

  await recordEvaluation(
    wake.late ? BRIEFING_OUTCOME.SENT_LATE : BRIEFING_OUTCOME.SENT,
    { reason: wake.late ? 'late_delivery' : null },
  );

  log.info('daily_sent', {
    health_date: healthDate, stage: briefing.stage, samples: briefing.sampleCount,
    late: Boolean(wake.late),
    narrative_source: narrativeSource, narrative_failure: narrativeFailure,
    chars: text.length, recorded,
  });
  return {
    status: 'sent', healthDate, localDate: healthDate, text, briefing,
    late: Boolean(wake.late), coachUsed: narrativeSource === 'model',
    narrativeSource, narrativeFailure, recorded,
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
