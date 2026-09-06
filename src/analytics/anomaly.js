/**
 * 個人偏離（personal deviation）。
 *
 * ## 用詞
 *
 * 全系統一律稱 personal deviation / personal anomaly。
 * **絕不使用「異常」「不正常」「abnormal」這類醫學語彙** —— 這是拿你自己的
 * 歷史當基準的統計描述，不是任何形式的醫療判讀。
 *
 * ## 與既有 severityFor 的關係
 *
 * 既有的 severityFor（固定百分比門檻、紅黃綠燈）**完全保留、不動**。
 * 這一層是新增的統計視角，兩者並存：
 *   severityFor → 簡報上的燈號（穩定、好懂、已上線）
 *   z-score     → 分析層的統計強度（樣本量敏感、可比較不同指標）
 */

import { ANALYTICS, METRIC_DIRECTION } from '../config.js';

export const DEVIATION = {
  NORMAL: 'NORMAL',
  MILD: 'MILD',
  NOTABLE: 'NOTABLE',
  STRONG: 'STRONG',
  INSUFFICIENT_VARIANCE: 'insufficient_variance',
  INSUFFICIENT_DATA: 'insufficient_data',
};

/**
 * z = (current - mean) / stddev
 *
 * stddev 為 0 或極小時回 null —— 這種情況下 z 會爆成無限大，
 * 把「完全沒變化」誤報成「極度偏離」。
 */
export function zScore(current, { mean, stddev }) {
  if (current === null || current === undefined) return null;
  if (mean === null || stddev === null) return null;
  if (!Number.isFinite(stddev) || stddev <= 0) return null;
  // 相對於平均值太小的變異視為沒有變異
  const scale = Math.abs(mean) > 0 ? Math.abs(mean) : 1;
  if (stddev / scale < ANALYTICS.MIN_STDDEV_RATIO) return null;
  return (current - mean) / stddev;
}

/** |z| → 強度分級。 */
export function levelOf(z) {
  const a = Math.abs(z);
  const t = ANALYTICS.Z_THRESHOLDS;
  if (a >= t.STRONG) return DEVIATION.STRONG;
  if (a >= t.NOTABLE) return DEVIATION.NOTABLE;
  if (a >= t.MILD) return DEVIATION.MILD;
  return DEVIATION.NORMAL;
}

/**
 * 這個方向的偏離值不值得留意？
 *
 * HRV / 恢復 / 睡眠：偏低才要留意（偏高是好事）
 * RHR / 睡眠債 / 擾動：偏高才要留意
 * 呼吸率 / 皮膚溫度 / Strain：兩個方向都值得看
 */
export function isNoteworthy(metricKey, z) {
  if (z === null) return false;
  const dir = METRIC_DIRECTION[metricKey] ?? 'both';
  if (dir === 'higher_better') return z < 0;
  if (dir === 'lower_better') return z > 0;
  return true;
}

/**
 * 完整的偏離評估。
 *
 * @param {string} metricKey
 * @param {number} current   今天的值
 * @param {object} baseline  describeWindow() 的輸出（要有 mean / stddev / n / sufficient）
 */
export function evaluateDeviation(metricKey, current, baseline) {
  const base = {
    metric: metricKey,
    current: current ?? null,
    baseline_mean: baseline?.mean ?? null,
    baseline_stddev: baseline?.stddev ?? null,
    baseline_n: baseline?.n ?? 0,
    baseline_window_days: baseline?.windowDays ?? null,
    direction_rule: METRIC_DIRECTION[metricKey] ?? 'both',
    z_score: null,
    level: DEVIATION.INSUFFICIENT_DATA,
    direction: null,
    noteworthy: false,
  };

  if (current === null || current === undefined) return base;
  if (!baseline || !baseline.sufficient) {
    return { ...base, level: DEVIATION.INSUFFICIENT_DATA };
  }

  const z = zScore(current, baseline);
  if (z === null) {
    return { ...base, level: DEVIATION.INSUFFICIENT_VARIANCE };
  }

  return {
    ...base,
    z_score: z,
    level: levelOf(z),
    direction: z === 0 ? 'flat' : (z > 0 ? 'high' : 'low'),
    noteworthy: isNoteworthy(metricKey, z) && levelOf(z) !== DEVIATION.NORMAL,
  };
}
