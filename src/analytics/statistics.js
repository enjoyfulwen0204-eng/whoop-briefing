/**
 * 描述性統計。純函式、沒有任何 I/O、不知道「健康」是什麼。
 *
 * ## 一條重要的界線：window ≠ n
 *
 * `windowDays` 是**日曆天數**（最近 30 天）。
 * `n` 是那個窗口裡**實際有效的樣本數**（可能只有 27 天有戴錶）。
 * 兩者永遠分開記錄、永遠一起輸出。混用會讓「30 天平均」在缺資料時
 * 悄悄變成「27 天平均」而沒人知道。
 *
 * 所有計算都在 Node。LLM 永遠不做這裡的任何一件事。
 */

import { ANALYTICS } from '../config.js';

/** 算術平均。 */
export function mean(values) {
  if (!values.length) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** 中位數（偶數取中間兩個的平均）。 */
export function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * 樣本標準差（除以 n-1）。
 * 用 n-1 而不是 n：我們手上的永遠是樣本，不是母體。
 * n < 2 時回 null（一個點沒有離散度可言）。
 */
export function stddev(values) {
  if (values.length < 2) return null;
  const m = mean(values);
  const ss = values.reduce((acc, v) => acc + (v - m) ** 2, 0);
  return Math.sqrt(ss / (values.length - 1));
}

export function min(values) {
  return values.length ? Math.min(...values) : null;
}

export function max(values) {
  return values.length ? Math.max(...values) : null;
}

/**
 * value 在 samples 裡的百分位（0–100）。
 * 用「小於 value 的比例 + 等於的一半」（midrank），避免相同值時
 * 百分位一路跳到 0 或 100。
 */
export function percentileOf(value, samples) {
  if (!samples.length || value === null || value === undefined) return null;
  let below = 0;
  let equal = 0;
  for (const s of samples) {
    if (s < value) below += 1;
    else if (s === value) equal += 1;
  }
  return ((below + equal / 2) / samples.length) * 100;
}

/** 第 p 百分位的值（線性內插）。 */
export function quantile(values, p) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  if (s.length === 1) return s[0];
  const idx = (s.length - 1) * (p / 100);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return s[lo];
  return s[lo] + (s[hi] - s[lo]) * (idx - lo);
}

/**
 * 從時間序列（舊→新，[{date, value}]）取出一個日曆窗口。
 *
 * @param {string} endDate  YYYY-MM-DD，窗口的最後一天（含）
 * @param {number} days     日曆天數
 * @param {boolean} excludeEndDate 是否排除 endDate 當天
 *        （算「今天 vs 過去 30 天基準」時要排除今天，否則今天會把基準往自己拉）
 */
export function windowSlice(series, { endDate, days, excludeEndDate = false }) {
  const end = Date.parse(`${endDate}T00:00:00Z`);
  const start = end - (days - 1) * 86_400_000;
  return series.filter((p) => {
    const t = Date.parse(`${p.date}T00:00:00Z`);
    if (!Number.isFinite(t)) return false;
    if (excludeEndDate && t >= end) return false;
    return t >= (excludeEndDate ? start - 86_400_000 : start) && t <= end;
  });
}

/**
 * 一個窗口的完整描述。
 * n < ANALYTICS.MIN_SAMPLES 時 sufficient=false —— 上層據此決定要不要下結論。
 */
export function describeWindow(series, { endDate, days, excludeEndDate = false } = {}) {
  const points = windowSlice(series, { endDate, days, excludeEndDate });
  const values = points.map((p) => p.value);
  return {
    windowDays: days,          // 日曆天數（設定值）
    n: values.length,          // 實際有效樣本數
    coverage: days > 0 ? values.length / days : null,
    sufficient: values.length >= ANALYTICS.MIN_SAMPLES,
    mean: mean(values),
    median: median(values),
    stddev: stddev(values),
    min: min(values),
    max: max(values),
    first: points[0] ?? null,
    last: points[points.length - 1] ?? null,
    values,
  };
}

/**
 * 一個指標在所有標準窗口（7/14/30/90）的統計。
 * current 有給的話會一併算出百分位與變化量。
 */
export function summarise(series, { endDate, current = null, windows = ANALYTICS.WINDOWS } = {}) {
  const out = {};
  for (const days of windows) {
    const w = describeWindow(series, { endDate, days, excludeEndDate: true });
    let percentile = null;
    let changeAbsolute = null;
    let changePct = null;
    if (current !== null && current !== undefined && w.n > 0) {
      percentile = percentileOf(current, w.values);
      changeAbsolute = current - w.mean;
      changePct = w.mean !== 0 ? (changeAbsolute / Math.abs(w.mean)) * 100 : null;
    }
    out[`${days}d`] = {
      ...w,
      values: undefined, // 對外不吐整串原始值（訊息會爆掉），需要時用 describeWindow
      count: w.n,
      percentile_of_current: percentile,
      change_absolute: changeAbsolute,
      change_pct: changePct,
    };
  }
  return out;
}
