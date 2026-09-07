/**
 * Signal Engine（PA4）。
 *
 * 把「readiness 已經 READY 的指標」轉成結構化訊號。**沒有任何一行 LLM
 * 呼叫、沒有任何一個數字是猜的**——全部重用 readiness.js 的 gating 與
 * analytics 既有的 evaluateDeviation() / detectBaselineShift()。
 *
 * ## 核心保證
 *
 * 一個指標只有在 assessDeviation()／assessChangeDetection() 回報 READY
 * 時才可能產生訊號。資料不足（NO_DATA/WARMING_UP/LIMITED）或結構性不可用
 * （UNAVAILABLE）的指標**絕不會**產生訊號——這就是「資料不足時不主動
 * 解讀正常生理波動」的實作方式：不是靠 Attention Engine 事後過濾，
 * 而是訊號從一開始就不存在。
 */

import { ANALYTICS } from './config.js';
import { describeWindow } from './analytics/statistics.js';
import { evaluateDeviation, DEVIATION } from './analytics/anomaly.js';
import { detectBaselineShift } from './analytics/trend.js';
import {
  assessDeviation, assessChangeDetection, READINESS_STATUS,
} from './readiness.js';
import { SIGNAL_POLICY } from './proactivePolicy.js';

export const SIGNAL_TYPE = {
  DEVIATION: 'DEVIATION',
  BASELINE_SHIFT: 'BASELINE_SHIFT',
};

/** DEVIATION.* 的嚴重度排序（只用來跟 SIGNAL_POLICY.MIN_LEVEL_FOR_ATTENTION 比較）。 */
const LEVEL_RANK = { NORMAL: 0, MILD: 1, NOTABLE: 2, STRONG: 3 };

function meetsMinLevel(level) {
  return (LEVEL_RANK[level] ?? 0) >= (LEVEL_RANK[SIGNAL_POLICY.MIN_LEVEL_FOR_ATTENTION] ?? 0);
}

/** metric + direction → 人看得懂、也是 KNOWN_METRIC_TERMS 相容的代碼。 */
function codeFor(metric, direction) {
  const dir = direction === 'low' ? 'LOW' : direction === 'high' ? 'HIGH' : 'CHANGED';
  return `${metric.toUpperCase()}_${dir}`;
}

/**
 * 單一指標的 DEVIATION 訊號。readiness 沒 READY 就直接回 null——
 * 呼叫端不需要自己再檢查一次。
 */
export function deviationSignal({
  metric, series = [], anchorDate, capabilityStatus = null,
}) {
  const readiness = assessDeviation({ series, anchorDate, capabilityStatus });
  if (readiness.status !== READINESS_STATUS.READY) return null;

  const baseline = describeWindow(series, {
    endDate: anchorDate, days: ANALYTICS.DEFAULT_BASELINE_WINDOW, excludeEndDate: true,
  });
  const today = series.find((p) => p.date === anchorDate);
  const current = today ? today.value : null;
  if (current === null || current === undefined) return null;

  const dev = evaluateDeviation(metric, current, baseline);
  if (!dev.noteworthy || dev.level === DEVIATION.NORMAL) return null;
  if (!meetsMinLevel(dev.level)) return null;

  return {
    type: SIGNAL_TYPE.DEVIATION,
    code: codeFor(metric, dev.direction),
    metric,
    health_date: anchorDate,
    level: dev.level,
    direction: dev.direction,
    z_score: dev.z_score,
    current: dev.current,
    baseline_mean: dev.baseline_mean,
    baseline_n: dev.baseline_n,
    readiness_status: readiness.status,
  };
}

/** 單一指標的「基準漂移」訊號——同樣要求 readiness READY 才可能產生。 */
export function baselineShiftSignal({
  metric, series = [], anchorDate, capabilityStatus = null,
}) {
  const readiness = assessChangeDetection({ metricKey: metric, series, anchorDate, capabilityStatus });
  if (readiness.status !== READINESS_STATUS.READY) return null;

  const shift = detectBaselineShift(metric, series, { endDate: anchorDate });
  if (!shift.shift) return null;

  return {
    type: SIGNAL_TYPE.BASELINE_SHIFT,
    code: `${metric.toUpperCase()}_SHIFT`,
    metric,
    health_date: anchorDate,
    level: Math.abs(shift.effect_size) >= 1 ? DEVIATION.STRONG : DEVIATION.NOTABLE,
    direction: shift.interpretation === 'worse' ? 'high' : shift.interpretation === 'better' ? 'low' : 'flat',
    effect_size: shift.effect_size,
    recent_mean: shift.recent_mean,
    previous_mean: shift.previous_mean,
    readiness_status: readiness.status,
  };
}

/**
 * 一次算完一組指標的全部訊號（DEVIATION + BASELINE_SHIFT）。
 *
 * @param {object} seriesByMetric { metricKey: [{date,value}] }
 * @param {object} capabilityByMetric 選填 { metricKey: capabilityStatus }
 * @param {string[]} metrics 要看哪些指標（呼叫端決定，不在這裡寫死）
 */
export function detectSignals({
  seriesByMetric = {}, capabilityByMetric = {}, anchorDate, metrics = [],
}) {
  const out = [];
  for (const metric of metrics) {
    const series = seriesByMetric[metric] ?? [];
    const capabilityStatus = capabilityByMetric[metric] ?? null;

    const dev = deviationSignal({
      metric, series, anchorDate, capabilityStatus,
    });
    if (dev) out.push(dev);

    const shift = baselineShiftSignal({
      metric, series, anchorDate, capabilityStatus,
    });
    if (shift) out.push(shift);
  }
  // 確定性排序：嚴重度高的在前，同嚴重度用 metric 字母序，結果永遠可重現。
  return out.sort((a, b) => {
    const rankDiff = (LEVEL_RANK[b.level] ?? 0) - (LEVEL_RANK[a.level] ?? 0);
    if (rankDiff !== 0) return rankDiff;
    return a.metric < b.metric ? -1 : a.metric > b.metric ? 1 : 0;
  });
}
