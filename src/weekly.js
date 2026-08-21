/**
 * 每週回顧流程（與 daily 完全獨立：各自去重、各自 retry）。
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

import { WEEKLY } from './config.js';
import { buildRecords, detectWake, weeklyStats, weekOverWeek } from './analyze.js';
import { renderWeekly } from './format.js';
import { completedWeeks, localDate, localHour, localWeekday } from './time.js';
import { log, describeError } from './logger.js';
import { TelegramError } from './telegram.js';

export async function runWeekly({ db, source, coach, telegram, timezone, now = new Date() }) {
  const today = localDate(now, timezone);
  const weeks = completedWeeks(now, timezone);
  const weekKey = weeks.last.key;

  if (localWeekday(today) !== WEEKLY.WEEKDAY) {
    return { status: 'not_monday', localDate: today };
  }
  if (await db.isSent('weekly', weekKey)) {
    log.info('weekly_already_sent', { week_key: weekKey });
    return { status: 'already_sent', weekKey };
  }

  // 時機判斷：偵測到起床，或已過中午（補發保險）
  const hour = localHour(now, timezone);
  let trigger = hour >= WEEKLY.FALLBACK_SEND_AFTER_HOUR ? 'after_noon' : null;
  if (!trigger) {
    const { sleeps, recoveries } = await source.poll();
    const wake = detectWake({
      records: buildRecords({ sleeps, recoveries, timezone }),
      now,
      timezone,
    });
    if (wake.ready) trigger = 'wake';
    else {
      log.info('weekly_waiting', { week_key: weekKey, reason: wake.reason, local_hour: hour });
      return { status: 'waiting', reason: wake.reason, weekKey };
    }
  }

  const { sleeps, recoveries } = await source.history();
  const records = buildRecords({ sleeps, recoveries, timezone });

  const last = weeklyStats({ records, week: weeks.last });
  const prev = weeklyStats({ records, week: weeks.prev });

  if (last.days === 0) {
    log.warn('weekly_no_data', { week_key: weekKey });
    await db.recordRun({
      reportType: 'weekly',
      localDateKey: weekKey,
      status: 'SKIPPED',
      detail: 'no_data_last_week',
    });
    return { status: 'no_data', weekKey };
  }

  const weekly = { last, prev, wow: weekOverWeek(last, prev) };
  const coachText = await coach.weekly(weekly);
  const text = renderWeekly(weekly, coachText);

  try {
    const sent = await telegram.send(text);
    await db.recordRun({
      reportType: 'weekly',
      localDateKey: weekKey,
      telegramMessageId: sent.messageId,
      status: 'SENT',
      detail: coachText ? `trigger=${trigger}` : `trigger=${trigger};coach_fallback`,
    });
    log.info('weekly_sent', {
      week_key: weekKey, days: last.days, trigger,
      coach: coachText ? 'ok' : 'fallback', chars: text.length,
    });
    return { status: 'sent', weekKey, text, weekly, coachUsed: Boolean(coachText) };
  } catch (err) {
    await db.recordRun({
      reportType: 'weekly',
      localDateKey: weekKey,
      status: 'FAILED',
      detail: describeError(err),
    });
    if (err instanceof TelegramError) {
      log.error('weekly_telegram_failed', { week_key: weekKey, error: describeError(err) });
      return { status: 'telegram_failed', weekKey, error: describeError(err) };
    }
    throw err;
  }
}
