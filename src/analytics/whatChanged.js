/**
 * 「今天最值得注意的變化」。
 *
 * ## 排序絕對不交給 LLM
 *
 * importance 是一個**確定性的分數**，由 Node 算完、排好、切到 top N 之後
 * 才交給 LLM 講成人話。LLM 不決定哪一項比較重要，也不決定好壞。
 *
 * importance 的組成（權重寫在這裡，改這裡就好）：
 *   0.50  統計強度   |z| / 3，封頂 1
 *   0.30  變化幅度   |vs 30 天平均 %| / 30，封頂 1
 *   0.20  多重佐證   vs 昨天與 vs 30 天同方向 → 給滿分
 *   ×     資料品質   樣本數不足時整體打折
 */

import { ANALYTICS, METRIC_DIRECTION, WHAT_CHANGED } from '../config.js';
import { describeWindow } from './statistics.js';
import { evaluateDeviation, DEVIATION } from './anomaly.js';

const W = { Z: 0.5, MAGNITUDE: 0.3, CONFIRMATION: 0.2 };

const clamp01 = (v) => Math.max(0, Math.min(1, v));

/** 這個變化的方向對這個指標而言是好還是壞。 */
function favourability(metricKey, delta) {
  if (delta === null || delta === 0) return 'neutral';
  const dir = METRIC_DIRECTION[metricKey] ?? 'both';
  if (dir === 'both') return 'neutral';
  const rising = delta > 0;
  if (dir === 'higher_better') return rising ? 'favourable' : 'unfavourable';
  return rising ? 'unfavourable' : 'favourable';
}

/**
 * 算一個指標今天的變化。
 *
 * @param {object[]} series 舊→新 [{date, value}]
 * @param {string} anchorDate 今天（health_date）
 */
export function changeFor(metricKey, series, anchorDate) {
  const byDate = new Map(series.map((p) => [p.date, p.value]));
  const current = byDate.get(anchorDate);
  if (current === null || current === undefined) return null;

  const yesterday = new Date(Date.parse(`${anchorDate}T00:00:00Z`) - 86_400_000)
    .toISOString().slice(0, 10);
  const prev = byDate.get(yesterday);

  // 基準一律排除今天，否則今天的值會把基準往自己拉
  const opts = { endDate: anchorDate, excludeEndDate: true };
  const w7 = describeWindow(series, { ...opts, days: 7 });
  const w30 = describeWindow(series, { ...opts, days: ANALYTICS.DEFAULT_BASELINE_WINDOW });
  const w90 = describeWindow(series, { ...opts, days: 90 });

  const pct = (base) => (base !== null && base !== 0
    ? ((current - base) / Math.abs(base)) * 100 : null);

  const deviation = evaluateDeviation(metricKey, current, w30);

  return {
    metric: metricKey,
    date: anchorDate,
    current,
    yesterday: prev ?? null,
    vs_yesterday_absolute: prev === undefined ? null : current - prev,
    vs_yesterday_pct: prev === undefined ? null : pct(prev),
    vs_7d_pct: pct(w7.mean),
    vs_30d_pct: pct(w30.mean),
    vs_90d_pct: pct(w90.mean),
    baseline_30d_mean: w30.mean,
    baseline_30d_n: w30.n,
    z_score: deviation.z_score,
    level: deviation.level,
    direction: deviation.direction,
    noteworthy: deviation.noteworthy,
    favourability: favourability(metricKey, w30.mean === null ? null : current - w30.mean),
  };
}

/** 確定性的重要度分數（0–1）。 */
export function importanceOf(change) {
  if (!change) return 0;

  const z = change.z_score === null ? 0 : clamp01(Math.abs(change.z_score) / 3);
  const mag = change.vs_30d_pct === null ? 0 : clamp01(Math.abs(change.vs_30d_pct) / 30);

  // 多重佐證：跟昨天比、跟 30 天比，兩個方向一致才算數
  let confirmation = 0;
  const a = change.vs_yesterday_pct;
  const b = change.vs_30d_pct;
  if (a !== null && b !== null && a !== 0 && b !== 0 && Math.sign(a) === Math.sign(b)) {
    confirmation = 1;
  }

  // 資料品質：30 天基準樣本不足就整體打折（不是直接丟掉）
  const quality = change.baseline_30d_n >= ANALYTICS.MIN_SAMPLES
    ? 1
    : clamp01(change.baseline_30d_n / ANALYTICS.MIN_SAMPLES) * 0.6;

  const raw = W.Z * z + W.MAGNITUDE * mag + W.CONFIRMATION * confirmation;
  return clamp01(raw) * quality;
}

/**
 * 今天最值得注意的變化（已排序、已截斷）。
 *
 * @param {object} seriesByMetric { hrv: [{date,value}], ... } 舊→新
 * @param {string} anchorDate
 */
export function whatChangedToday(seriesByMetric, anchorDate, {
  maxItems = WHAT_CHANGED.MAX_ITEMS,
  minImportance = WHAT_CHANGED.MIN_IMPORTANCE,
} = {}) {
  const items = [];
  for (const [metricKey, series] of Object.entries(seriesByMetric)) {
    const change = changeFor(metricKey, series, anchorDate);
    if (!change) continue;
    if (change.level === DEVIATION.INSUFFICIENT_DATA) continue;
    items.push({ ...change, importance: importanceOf(change) });
  }

  return items
    .filter((c) => c.importance >= minImportance)
    .sort((a, b) => {
      if (b.importance !== a.importance) return b.importance - a.importance;
      // 完全同分時用 metric key 排序，保證輸出是確定性的（測試才穩定）
      return a.metric < b.metric ? -1 : 1;
    })
    .slice(0, maxItems);
}
