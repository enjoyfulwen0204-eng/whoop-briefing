/**
 * 每週回顧流程（與 daily 完全獨立：各自去重、各自 retry）。
 *
 * 統計口徑：一個 health_date 算一天（同日多筆主睡眠取 sleep.end 最晚那筆），
 * 跟 daily / 趨勢 / baseline 完全一致。
 *
 * 觸發條件：
 *  - 今天（台灣時間）是週一
 *  - 本週的 weekly 尚未 SENT（週 key = 上週一的日期）
 *  - 而且「已偵測到起床」或「台灣時間已過 12:00」
 *    → 前者避免清晨 5 點就把訊息丟給還在睡的人；
 *      後者保證即使當天沒抓到睡眠（沒戴錶等）也不會漏掉週回顧。
 *
 * 區間定義：
 *  - 上週 = 上一個完整週一 00:00:00.000 ～ 週日 23:59:59.999（台灣時間）
 *  - 前週 = 再前一個完整週
 */

import { REPORT_CLAIM, WEEKLY } from './config.js';
import { requireUserId } from './userContext.js';
import { buildObservations, detectWake, weeklyStats, weekOverWeek } from './analyze.js';
import { renderWeekly } from './format.js';
import { completedWeeks, localDate, localHour, localWeekday } from './time.js';
import { log, describeError } from './logger.js';
import { buildNarrative } from './narrative.js';
import { DELIVERY_RESULT, deliverReport, renewReportClaim } from './reportDelivery.js';

/**
 * 把週報整理成驗證器看得懂的「已核可事實」形狀。
 *
 * 驗證器只需要知道兩件事：有哪些數字可以講、有沒有有效基準可以下判斷。
 * 週報的平均值就是那些數字；樣本不足時 metrics 為空，於是任何「偏低／
 * 異常」的說法都會被否決 —— 那正是我們要的。
 */
function weeklyBriefingShape(weekly) {
  const metrics = [];
  for (const [key, m] of Object.entries(weekly?.last?.metrics ?? {})) {
    if (!m || m.display === undefined || m.display === null) continue;
    metrics.push({
      key, label: m.label ?? key, display: String(m.display), available: true,
      baselineDisplay: weekly?.prev?.metrics?.[key]?.display ?? null,
      severity: weekly?.wow?.[key]?.severity ?? null,
      pct: Number.isFinite(weekly?.wow?.[key]?.pct) ? weekly.wow[key].pct : null,
      calibrating: false, tier: 'core',
    });
  }
  return {
    stage: metrics.length ? 'warm' : 'cold',
    sampleCount: weekly?.last?.days ?? 0,
    metrics, trends: null,
    localDate: weekly?.last?.key ?? null, healthDate: weekly?.last?.key ?? null,
  };
}

/**
 * @param {string} userId   **必填**。
 * @param {string} timezone **該使用者的**時區。
 */
export async function runWeekly({
  db, userId, source, coach, telegram, timezone, now = new Date(),
}) {
  const uid = requireUserId(userId, 'runWeekly');
  const today = localDate(now, timezone);
  const weeks = completedWeeks(now, timezone);
  const weekKey = weeks.last.key;

  // 補發寬限（A3）：以前只有週一會跑，週一整天故障就永遠漏掉那一週。
  // completedWeeks() 在週一～週日都會回同一個「上一個完整週」，所以週二、
  // 週三補發用的 weekKey 與週一完全相同 —— uniq_report_sent 保證一週一次。
  const weekday = localWeekday(today);
  if (weekday > WEEKLY.CATCHUP_DAYS) {
    return { status: 'outside_window', localDate: today, weekday, weekKey };
  }
  const isCatchup = weekday !== WEEKLY.WEEKDAY;

  if (await db.isSent(uid, 'weekly', weekKey)) {
    log.info('weekly_already_sent', { week_key: weekKey });
    return { status: 'already_sent', weekKey };
  }

  // 時機判斷：偵測到起床，或已過中午（補發保險）
  const hour = localHour(now, timezone);
  let trigger = hour >= WEEKLY.FALLBACK_SEND_AFTER_HOUR ? 'after_noon' : null;
  if (trigger && isCatchup) trigger = `after_noon_catchup_d${weekday}`;
  if (!trigger) {
    const { sleeps, recoveries } = await source.poll();
    const wake = detectWake({
      observations: buildObservations({ sleeps, recoveries, timezone }),
      now,
      timezone,
    });
    if (wake.ready) trigger = isCatchup ? `wake_catchup_d${weekday}` : 'wake';
    else {
      log.info('weekly_waiting', { week_key: weekKey, reason: wake.reason, local_hour: hour });
      return { status: 'waiting', reason: wake.reason, weekKey };
    }
  }

  // 發送權（A2）—— 與 daily 同一套機制，各自獨立的 key
  const claiming = typeof db.claimReport === 'function';
  // claim / dedupe 的邏輯 key 一律含 userId：Alice 的 claim 不可阻塞 Bob
  const claimKey = { userId: uid, ...{ reportType: 'weekly', localDateKey: weekKey } };
  let claim = { granted: true, owner: null };
  if (claiming) {
    claim = await db.claimReport({ ...claimKey, ttlMs: REPORT_CLAIM.TTL_MS });
    if (!claim.granted) {
      // 與 daily 完全相同的三分法（見 daily.js）：模糊是**終局**，
      // 排程不會再自動送一次可能已經送達的週回顧。
      if (claim.ambiguous) {
        log.error('weekly_claim_denied_ambiguous', { week_key: weekKey });
        return { status: 'delivery_ambiguous', weekKey, retryable: false };
      }
      log.info('weekly_claim_denied', { week_key: weekKey, already_sent: claim.alreadySent });
      return { status: claim.alreadySent ? 'already_sent' : 'claim_busy', weekKey };
    }
  }
  const releaseClaim = async () => {
    if (!claiming || !claim.owner) return;
    try {
      await db.releaseClaim({ ...claimKey, owner: claim.owner });
    } catch (err) {
      log.warn('weekly_claim_release_failed', { error: describeError(err) });
    }
  };

  let sleeps;
  let recoveries;
  try {
    ({ sleeps, recoveries } = await source.history());
  } catch (err) {
    await releaseClaim();
    throw err;
  }
  // 用 observations（每個 health_date 一筆）而不是 records（一筆睡眠一筆）：
  // 分段睡的那天 WHOOP 會回兩筆主睡眠，用 records 會讓「有效天數」變成 8 天，
  // 而且那天的數值在平均裡被算兩次。跟 daily / 趨勢 / baseline 共用同一套口徑。
  const records = buildObservations({ sleeps, recoveries, timezone });

  const last = weeklyStats({ records, week: weeks.last });
  const prev = weeklyStats({ records, week: weeks.prev });

  if (last.days === 0) {
    await releaseClaim();
    log.warn('weekly_no_data', { week_key: weekKey });
    await db.recordRun({
      userId: uid,
      reportType: 'weekly',
      localDateKey: weekKey,
      status: 'SKIPPED',
      detail: 'no_data_last_week',
    }, { throwOnError: false });
    return { status: 'no_data', weekKey };
  }

  const weekly = { last, prev, wow: weekOverWeek(last, prev) };
  // Production cut: never append provider prose to physiological facts.
  // ★ 與 daily 同一套權責邊界：統計全部由程式算好，模型只負責講成自然的話，
  // 而且輸出要通過守門。資料不足時確定性版本會誠實說出來，絕不編一個
  // 不存在的「本週趨勢」。
  const narrative = await buildNarrative({
    briefing: weeklyBriefingShape(weekly),
    plan: typeof coach?.narrativePlan === 'function'
      ? (fragments) => coach.narrativePlan(fragments, { period: 'weekly' })
      : null,
    period: 'weekly',
  });
  const coachText = narrative.text;

  const text = renderWeekly(weekly, coachText);

  // ★ 送出邊界與 daily 共用同一支 deliverReport（見 reportDelivery.js）。
  //   兩條路各自抄一份正是稽核點名的問題：只要有兩份，行為就會分岔。
  await renewReportClaim({
    db, claimKey, claim, ttlMs: REPORT_CLAIM.RENEW_MS, now, stage: 'pre_send',
  });

  const delivery = await deliverReport({
    db, claimKey, claim, telegram, text, now: () => now,
  });

  if (delivery.result === DELIVERY_RESULT.FENCED) {
    // 生成期間失去所有權 → 什麼都沒送，也不還 claim（那一列屬於接手者）。
    log.warn('weekly_delivery_fenced', { week_key: weekKey });
    return { status: 'claim_lost', weekKey };
  }

  if (delivery.result === DELIVERY_RESULT.DEFINITE_FAILURE) {
    await db.recordRun({
      userId: uid,
      reportType: 'weekly',
      localDateKey: weekKey,
      status: 'FAILED',
      detail: delivery.error,
    }, { throwOnError: false });
    log.error('weekly_telegram_failed', { week_key: weekKey, error: delivery.error });
    return { status: 'telegram_failed', weekKey, error: delivery.error };
  }

  if (delivery.result === DELIVERY_RESULT.AMBIGUOUS) {
    // 可能已經送達，證明不了 → 終局，絕不自動重送。
    await db.recordRun({
      userId: uid,
      reportType: 'weekly',
      localDateKey: weekKey,
      status: 'AMBIGUOUS',
      detail: delivery.error,
    }, { throwOnError: false });
    log.error('weekly_delivery_ambiguous', { week_key: weekKey, error: delivery.error });
    return {
      status: 'delivery_ambiguous', weekKey, error: delivery.error, retryable: false,
    };
  }

  const sent = { messageId: delivery.messageId };

  // 同 daily：訊息已送出，紀錄寫入失敗只能大聲喊，不能當成發送失敗
  let recorded = true;
  try {
    await db.recordRun({
      userId: uid,
      reportType: 'weekly',
      localDateKey: weekKey,
      telegramMessageId: sent.messageId,
      status: 'SENT',
      detail: narrative.failureCategory
        ? `trigger=${trigger};narrative=${narrative.source};reason=${narrative.failureCategory}`
        : `trigger=${trigger}`,
    });
  } catch (err) {
    recorded = false;
    log.error('weekly_record_failed_after_send', { week_key: weekKey, error: describeError(err) });
    await telegram.notifyError(
      'weekly_record',
      '週回顧已經發出去了，但發送紀錄寫不進 Turso。'
      + '不會重複發送（發送權已經是終局狀態），但歷史紀錄會少一筆。'
      + describeError(err),
    );
  }

  log.info('weekly_sent', {
    week_key: weekKey, days: last.days, trigger,
    narrative_source: narrative.source, narrative_failure: narrative.failureCategory,
    chars: text.length, recorded,
  });
  return {
    status: 'sent', weekKey, text, weekly,
    coachUsed: narrative.source === 'model',
    narrativeSource: narrative.source, narrativeFailure: narrative.failureCategory, recorded,
  };
}
