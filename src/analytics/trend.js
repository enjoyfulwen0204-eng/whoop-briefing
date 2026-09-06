/**
 * 趨勢引擎（7/30/90 天線性斜率 + 簡單 baseline shift）。
 *
 * 既有的「連續 3 天 streak 預警」（analyze.js detectTrends）完全保留不動 ——
 * 那個管的是「最近 3 天有沒有連續走壞」，這裡管的是「這一兩個月的方向」。
 * 兩者互補，不互相取代。
 *
 * R² 只是「這條直線解釋了多少變異」。刻意不做過度解讀，也不拿它下結論，
 * 只當成「這個斜率可不可信」的輔助資訊輸出。
 */

import { METRIC_DIRECTION, TREND_ENGINE } from '../config.js';
import { mean, stddev, windowSlice } from './statistics.js';

export const TREND = {
  IMPROVING: 'IMPROVING',
  STABLE: 'STABLE',
  DECLINING: 'DECLINING',
  INSUFFICIENT_DATA: 'insufficient_data',
};

const DAY_MS = 86_400_000;

/**
 * 最小平方線性迴歸。x 用「距離第一個點幾天」，所以 slope 的單位是「每天」。
 * 缺日不會被當成等距 —— 用真實日期算 x，中間沒戴錶不會扭曲斜率。
 */
export function linearRegression(points) {
  if (!points || points.length < 2) return null;
  const t0 = Date.parse(`${points[0].date}T00:00:00Z`);
  const xs = points.map((p) => (Date.parse(`${p.date}T00:00:00Z`) - t0) / DAY_MS);
  const ys = points.map((p) => p.value);

  const mx = mean(xs);
  const my = mean(ys);
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < xs.length; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
  }
  if (sxx === 0) return null; // 所有點同一天，算不出斜率

  const slope = sxy / sxx;
  const intercept = my - slope * mx;

  // R²
  let ssTot = 0;
  let ssRes = 0;
  for (let i = 0; i < xs.length; i++) {
    const pred = intercept + slope * xs[i];
    ssTot += (ys[i] - my) ** 2;
    ssRes += (ys[i] - pred) ** 2;
  }
  const r2 = ssTot === 0 ? null : 1 - ssRes / ssTot;

  return {
    slope_per_day: slope,
    intercept,
    r2,
    n: points.length,
    span_days: xs[xs.length - 1] - xs[0],
    total_change: slope * (xs[xs.length - 1] - xs[0]),
  };
}

/**
 * 斜率 → IMPROVING / STABLE / DECLINING，而且是 metric-aware 的。
 *
 * HRV 上升 = 變好；RHR 上升 = 變差。方向由 METRIC_DIRECTION 決定，
 * 絕不由 LLM 判斷。
 */
export function classifySlope(metricKey, reg, baselineMean) {
  if (!reg) return TREND.INSUFFICIENT_DATA;
  const scale = Math.abs(baselineMean ?? reg.intercept ?? 0) || 1;
  const relPerDay = reg.slope_per_day / scale;
  if (Math.abs(relPerDay) < TREND_ENGINE.MIN_SLOPE_RATIO_PER_DAY) return TREND.STABLE;

  const dir = METRIC_DIRECTION[metricKey] ?? 'both';
  const rising = reg.slope_per_day > 0;
  if (dir === 'higher_better') return rising ? TREND.IMPROVING : TREND.DECLINING;
  if (dir === 'lower_better') return rising ? TREND.DECLINING : TREND.IMPROVING;
  // 'both'：沒有「好」的方向，只描述在動
  return TREND.STABLE;
}

/** 一個指標在所有趨勢窗口的斜率。 */
export function trendsFor(metricKey, series, { endDate, windows = TREND_ENGINE.WINDOWS } = {}) {
  const out = {};
  for (const days of windows) {
    const points = windowSlice(series, { endDate, days });
    if (points.length < TREND_ENGINE.MIN_SAMPLES) {
      out[`${days}d`] = {
        windowDays: days, n: points.length, sufficient: false,
        direction: TREND.INSUFFICIENT_DATA,
      };
      continue;
    }
    const reg = linearRegression(points);
    out[`${days}d`] = {
      windowDays: days,
      n: points.length,
      sufficient: true,
      slope_per_day: reg?.slope_per_day ?? null,
      total_change: reg?.total_change ?? null,
      r2: reg?.r2 ?? null,
      direction: classifySlope(metricKey, reg, mean(points.map((p) => p.value))),
    };
  }
  return out;
}

/**
 * 簡單的 baseline shift 偵測（不是 Bayesian change point，這一版刻意保持簡單）。
 *
 * 比較「最近 N 天」與「再往前 N 天」的平均，用 Cohen's d 當 effect size：
 *   d = (mean_recent - mean_previous) / pooled_stddev
 *
 * 只有在兩邊樣本都夠、而且 |d| 超過門檻時才回報 possible_baseline_shift。
 * 用「possible」是刻意的 —— 這是提示，不是結論。
 */
export function detectBaselineShift(metricKey, series, { endDate, windowDays = TREND_ENGINE.SHIFT_WINDOW_DAYS } = {}) {
  const recent = windowSlice(series, { endDate, days: windowDays });
  const prevEnd = new Date(Date.parse(`${endDate}T00:00:00Z`) - windowDays * DAY_MS)
    .toISOString().slice(0, 10);
  const previous = windowSlice(series, { endDate: prevEnd, days: windowDays });

  const base = {
    metric: metricKey,
    window_days: windowDays,
    recent_n: recent.length,
    previous_n: previous.length,
    shift: false,
  };
  if (recent.length < TREND_ENGINE.MIN_SHIFT_SAMPLES || previous.length < TREND_ENGINE.MIN_SHIFT_SAMPLES) {
    return { ...base, reason: 'insufficient_data' };
  }

  const rv = recent.map((p) => p.value);
  const pv = previous.map((p) => p.value);
  const mr = mean(rv);
  const mp = mean(pv);
  const sr = stddev(rv);
  const sp = stddev(pv);
  if (sr === null || sp === null) return { ...base, reason: 'insufficient_variance' };

  // pooled standard deviation
  const pooled = Math.sqrt(
    (((rv.length - 1) * sr ** 2) + ((pv.length - 1) * sp ** 2)) / (rv.length + pv.length - 2),
  );
  if (!Number.isFinite(pooled) || pooled === 0) return { ...base, reason: 'insufficient_variance' };

  const d = (mr - mp) / pooled;
  const dir = METRIC_DIRECTION[metricKey] ?? 'both';
  const rising = d > 0;
  let interpretation = 'neutral';
  if (dir === 'higher_better') interpretation = rising ? 'better' : 'worse';
  else if (dir === 'lower_better') interpretation = rising ? 'worse' : 'better';

  return {
    ...base,
    recent_mean: mr,
    previous_mean: mp,
    effect_size: d,
    shift: Math.abs(d) >= TREND_ENGINE.MIN_SHIFT_EFFECT_SIZE,
    status: Math.abs(d) >= TREND_ENGINE.MIN_SHIFT_EFFECT_SIZE ? 'possible_baseline_shift' : 'stable',
    interpretation,
  };
}
