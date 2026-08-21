/**
 * 每日簡報流程。
 *
 * 效率原則：
 *  - 每 15 分鐘的 polling 只抓「判斷起床所需的最新 Sleep / Recovery」。
 *  - 只有真的準備發報告了，才抓 45 天歷史算 baseline。
 */

import { BASELINE } from './config.js';
import {
  buildRecords, completedCycles, detectWake, baselineRecords, stageFor,
  computeBaselines, evaluateAll, detectTrends,
} from './analyze.js';
import { renderDaily } from './format.js';
import { localDate } from './time.js';
import { log, describeError } from './logger.js';
import { TelegramError } from './telegram.js';

const STALE_CYCLE_MS = 48 * 60 * 60 * 1000;

export async function runDaily({ db, source, coach, telegram, timezone, now = new Date() }) {
  const today = localDate(now, timezone);

  // 1) 去重：今天（台灣時間）的 daily 是否已成功送出
  if (await db.isSent('daily', today)) {
    log.info('daily_already_sent', { local_date: today });
    return { status: 'already_sent', localDate: today };
  }

  // 2) 輕量 polling：只抓最近幾天的睡眠 / 恢復來判斷起床
  const { sleeps: pollSleeps, recoveries: pollRecoveries } = await source.poll();
  const wake = detectWake({
    records: buildRecords({ sleeps: pollSleeps, recoveries: pollRecoveries, timezone }),
    now,
    timezone,
  });

  if (!wake.ready) {
    log.info('daily_not_ready', {
      local_date: today,
      reason: wake.reason,
      minutes_since_wake: wake.minutesSinceWake ?? null,
    });
    return { status: 'not_ready', reason: wake.reason, localDate: today };
  }

  log.info('daily_wake_detected', {
    local_date: today,
    sleep_id: wake.record.sleepId,
    minutes_since_wake: wake.minutesSinceWake,
  });

  // 3) 準備發報告了 → 才抓 45 天歷史
  const { sleeps, recoveries, cycles } = await source.history();

  const briefing = buildBriefing({
    sleeps, recoveries, cycles, timezone, today, wakeSleepId: wake.record.sleepId,
  });

  // 4) Claude 只負責講話；掛掉就走 fallback（照樣發數據簡報）
  const coachText = await coach.daily(briefing);
  const text = renderDaily(briefing, coachText);

  // 5) 發送 + 記錄
  try {
    const sent = await telegram.send(text);
    await db.recordRun({
      reportType: 'daily',
      localDateKey: today,
      sleepId: briefing.sleepId,
      cycleId: briefing.cycleId,
      telegramMessageId: sent.messageId,
      status: 'SENT',
      detail: coachText ? null : 'coach_fallback',
    });
    log.info('daily_sent', {
      local_date: today, stage: briefing.stage, samples: briefing.sampleCount,
      coach: coachText ? 'ok' : 'fallback', chars: text.length,
    });
    return { status: 'sent', localDate: today, text, briefing, coachUsed: Boolean(coachText) };
  } catch (err) {
    await db.recordRun({
      reportType: 'daily',
      localDateKey: today,
      sleepId: briefing.sleepId,
      cycleId: briefing.cycleId,
      status: 'FAILED',
      detail: describeError(err),
    });
    if (err instanceof TelegramError) {
      // Telegram 自己掛了 → 只寫 log，不遞迴再呼叫 Telegram
      log.error('daily_telegram_failed', { local_date: today, error: describeError(err) });
      return { status: 'telegram_failed', localDate: today, error: describeError(err) };
    }
    throw err;
  }
}

/** 純函式：原始資料 → 算好的 briefing 物件（好測、dry-run 也用它）。 */
export function buildBriefing({ sleeps, recoveries, cycles, timezone, today, wakeSleepId }) {
  const records = buildRecords({ sleeps, recoveries, timezone });
  const todayRecord = records.find((r) => r.sleepId === String(wakeSleepId)) ?? records[0];
  if (!todayRecord) throw new Error('buildBriefing：找不到任何主睡眠紀錄');

  // 昨日 Strain = 上一個「已完成」cycle 的 day strain（不是當日剛起床那個）
  const cyclesDesc = completedCycles(cycles);
  const candidate = cyclesDesc[0] ?? null;
  const yesterdayCycle = candidate
    && Math.abs(new Date(candidate.end) - todayRecord.endUtc) <= STALE_CYCLE_MS
    ? candidate
    : null;

  const baseSet = baselineRecords({
    records,
    todayLocalDate: today,
    excludeSleepId: todayRecord.sleepId,
  });
  const sampleCount = Math.min(baseSet.length, BASELINE.TARGET_SAMPLES);
  const stage = stageFor(baseSet.length);

  const baselines = computeBaselines({
    records: baseSet,
    cycles: cyclesDesc,
    excludeCycleId: yesterdayCycle?.id ?? null,
  });

  const metrics = evaluateAll({ record: todayRecord, cycle: yesterdayCycle, baselines, stage });

  // 趨勢用「含今天」的連續資料點
  const trends = detectTrends({
    records: records.filter((r) => r.sleep.score_state === 'SCORED'),
    baselines,
    stage,
    cycles: cyclesDesc,
  });

  return {
    kind: 'daily',
    localDate: today,
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
