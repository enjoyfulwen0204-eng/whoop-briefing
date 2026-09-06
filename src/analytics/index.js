/**
 * 分析層總入口。
 *
 * 這一層唯一的工作是把 daily_metrics 變成「已經算好的結論」。
 * 之後不管是 Daily Brief、Telegram Q&A 還是任何新功能，
 * 都吃這裡的輸出，LLM 永遠只負責把結論講成人話。
 */

import { ANALYTICS } from '../config.js';
import { seriesOf } from '../dailyMetrics.js';
import { summarise, describeWindow } from './statistics.js';
import { evaluateDeviation } from './anomaly.js';
import { trendsFor, detectBaselineShift } from './trend.js';
import { whatChangedToday } from './whatChanged.js';

export * from './statistics.js';
export * from './anomaly.js';
export * from './trend.js';
export * from './whatChanged.js';

/** 分析層預設關注的指標。 */
export const ANALYSED_METRICS = [
  'recovery', 'hrv', 'rhr', 'respiratory_rate',
  'sleep_total', 'deep_sleep', 'rem_sleep', 'sleep_performance',
  'sleep_efficiency', 'sleep_consistency', 'sleep_debt',
  'previous_day_strain', 'spo2', 'skin_temp',
];

/** daily_metrics 列 → { metric: [{date,value}] }（舊→新）。 */
export function seriesByMetric(rows, metrics = ANALYSED_METRICS) {
  const out = {};
  for (const m of metrics) out[m] = seriesOf(rows, m);
  return out;
}

/**
 * 完整分析包。所有數字都在這裡算完。
 *
 * @param {object[]} rows       computeDailyMetrics() 的輸出
 * @param {string}   anchorDate 要分析哪一天（health_date）
 */
export function analyse(rows, anchorDate, { metrics = ANALYSED_METRICS } = {}) {
  const series = seriesByMetric(rows, metrics);
  const today = rows.find((r) => r.health_date === anchorDate) ?? null;

  const perMetric = {};
  for (const key of metrics) {
    const s = series[key];
    const current = today ? today[key] ?? null : null;
    const baseline = describeWindow(s, {
      endDate: anchorDate,
      days: ANALYTICS.DEFAULT_BASELINE_WINDOW,
      excludeEndDate: true,
    });
    perMetric[key] = {
      current,
      windows: summarise(s, { endDate: anchorDate, current }),
      deviation: evaluateDeviation(key, current, baseline),
      trends: trendsFor(key, s, { endDate: anchorDate }),
      baseline_shift: detectBaselineShift(key, s, { endDate: anchorDate }),
    };
  }

  return {
    anchorDate,
    totalDays: rows.length,
    metrics: perMetric,
    whatChanged: whatChangedToday(series, anchorDate),
  };
}
