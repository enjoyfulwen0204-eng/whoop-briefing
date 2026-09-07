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
import { buildWeeklyUserMessage } from './coach.js';
import { guardNarrative } from './llmValidation.js';
import { completedWeeks, localDate, localHour, localWeekday } from './time.js';
import { log, describeError } from './logger.js';
import { TelegramError } from './telegram.js';

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
  const rawCoachText = await coach.weekly(weekly);

  // ★ 敘述守門：與 daily / 健康問答共用同一個 guardNarrative（見 daily.js 的說明）。
  // context 是 buildWeeklyUserMessage(weekly)，純粹由 Node 從週統計算出來。
  // 守門失敗 → coachText 變 null → renderWeekly 印 FALLBACK_NOTE，
  // 週回顧的數據部分完整保留。
  const guardedWeekly = guardNarrative({
    answer: rawCoachText,
    context: buildWeeklyUserMessage(weekly),
    fallback: null,
    label: 'weekly',
  });
  if (rawCoachText && guardedWeekly.used === 'fallback') {
    log.warn('weekly_narrative_rejected', {
      week_key: weekKey,
      problems: guardedWeekly.problems?.slice(0, 6) ?? [],
    });
  }
  const coachText = guardedWeekly.text;

  const text = renderWeekly(weekly, coachText);

  let sent;
  try {
    sent = await telegram.send(text);
  } catch (err) {
    await releaseClaim();
    await db.recordRun({
      userId: uid,
      reportType: 'weekly',
      localDateKey: weekKey,
      status: 'FAILED',
      detail: describeError(err),
    }, { throwOnError: false });
    if (err instanceof TelegramError) {
      log.error('weekly_telegram_failed', { week_key: weekKey, error: describeError(err) });
      return { status: 'telegram_failed', weekKey, error: describeError(err) };
    }
    throw err;
  }

  // ★ 送出成功後第一件事：把「已送出」釘進 claim（見 daily.js 的說明）
  if (claiming && claim.owner) {
    try {
      await db.markClaimSent({ ...claimKey, owner: claim.owner, messageId: sent.messageId });
    } catch (err) {
      log.error('weekly_claim_mark_failed', { week_key: weekKey, error: describeError(err) });
    }
  }

  // 同 daily：訊息已送出，紀錄寫入失敗只能大聲喊，不能當成發送失敗
  let recorded = true;
  try {
    await db.recordRun({
      userId: uid,
      reportType: 'weekly',
      localDateKey: weekKey,
      telegramMessageId: sent.messageId,
      status: 'SENT',
      detail: coachText ? `trigger=${trigger}` : `trigger=${trigger};coach_fallback`,
    });
  } catch (err) {
    recorded = false;
    log.error('weekly_record_failed_after_send', { week_key: weekKey, error: describeError(err) });
    await telegram.notifyError(
      'weekly_record',
      `週回顧已經發出去了，但發送紀錄寫不進 Turso → 下一輪可能會重複發一次。${describeError(err)}`,
    );
  }

  log.info('weekly_sent', {
    week_key: weekKey, days: last.days, trigger,
    coach: coachText ? 'ok' : 'fallback', chars: text.length, recorded,
  });
  return { status: 'sent', weekKey, text, weekly, coachUsed: Boolean(coachText), recorded };
}
