/**
 * 相似歷史日（Phase U 基礎）。
 *
 * 作法：把每個指標各自標準化（z-score），再算歐氏距離的平均。
 * 標準化是必要的 —— 不然「睡眠總時長（毫秒，量級 10^7）」會完全蓋過
 * 「HRV（量級 10^1）」，距離等於只看睡眠。
 *
 * 缺欄位的處理：只用「兩天都有值」的特徵計算，並要求至少共用
 * MIN_SHARED_FEATURES 個特徵。**單一欄位缺失不會讓整天被排除。**
 *
 * 這一版只做確定性的距離排序，不做任何因果宣稱。
 */

import { mean, stddev } from './statistics.js';

/** 初版特徵。只會用「實際存在」的欄位。 */
export const DEFAULT_FEATURES = [
  'hrv', 'rhr', 'recovery', 'sleep_total', 'sleep_performance',
  'sleep_debt', 'previous_day_strain', 'respiratory_rate', 'bedtime_minutes',
];

export const MIN_SHARED_FEATURES = 4;

/**
 * "23:45" → 距離午夜的分鐘數，並把凌晨換算成負數。
 * 直接用 0-1439 的話，23:50 與 00:10 會差 1420 分鐘，
 * 但實際上只差 20 分鐘 —— 那會讓「晚睡」的距離完全算錯。
 */
export function bedtimeToMinutes(hhmm) {
  if (typeof hhmm !== 'string') return null;
  const m = hhmm.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(min)) return null;
  const total = h * 60 + min;
  // 中午之前視為「跨過午夜的凌晨」→ 用負數表示
  return total < 12 * 60 ? total : total - 24 * 60;
}

/** daily_metrics 列 → 特徵物件（缺的就是 null）。 */
export function featuresOf(row, features = DEFAULT_FEATURES) {
  const out = {};
  for (const f of features) {
    if (f === 'bedtime_minutes') {
      out[f] = bedtimeToMinutes(row.bedtime_local);
    } else {
      const v = row[f];
      out[f] = (v === null || v === undefined || !Number.isFinite(Number(v))) ? null : Number(v);
    }
  }
  return out;
}

/** 每個特徵各自算 mean/stddev（只用非 null 值）。 */
export function buildScaler(rows, features = DEFAULT_FEATURES) {
  const scaler = {};
  for (const f of features) {
    const values = rows
      .map((r) => featuresOf(r, [f])[f])
      .filter((v) => v !== null);
    const sd = stddev(values);
    scaler[f] = {
      mean: mean(values),
      // 變異為 0 的特徵不能拿來算距離（會除以 0），標成不可用
      stddev: sd !== null && sd > 0 ? sd : null,
      n: values.length,
    };
  }
  return scaler;
}

/**
 * 兩天的距離。
 * @returns {?{distance:number, shared:string[]}} 共用特徵不足時回 null
 */
export function distanceBetween(a, b, scaler, {
  features = DEFAULT_FEATURES, minShared = MIN_SHARED_FEATURES,
} = {}) {
  const fa = featuresOf(a, features);
  const fb = featuresOf(b, features);

  const shared = [];
  let sumSq = 0;
  for (const f of features) {
    const s = scaler[f];
    if (!s || s.stddev === null) continue;      // 這個特徵無法標準化
    if (fa[f] === null || fb[f] === null) continue; // 其中一天沒有值
    const za = (fa[f] - s.mean) / s.stddev;
    const zb = (fb[f] - s.mean) / s.stddev;
    sumSq += (za - zb) ** 2;
    shared.push(f);
  }

  if (shared.length < minShared) return null;
  // 除以特徵數 → 不同筆之間可比較（共用特徵數不同也不會偏袒）
  return { distance: Math.sqrt(sumSq / shared.length), shared };
}

/**
 * 找出與 targetDate 最相似的歷史日。
 *
 * @returns {object[]} 由近到遠。沒有歷史 / 目標日不存在時回 **[]**（不拋錯）
 */
export function findSimilarDays(rows, targetDate, {
  topN = 5,
  features = DEFAULT_FEATURES,
  minShared = MIN_SHARED_FEATURES,
} = {}) {
  if (!Array.isArray(rows) || rows.length < 2) return [];
  const target = rows.find((r) => r.health_date === targetDate);
  if (!target) return [];

  const scaler = buildScaler(rows, features);

  const scored = [];
  for (const row of rows) {
    if (row.health_date === targetDate) continue; // 永遠排除目標日自己
    const d = distanceBetween(target, row, scaler, { features, minShared });
    if (!d) continue;
    scored.push({
      health_date: row.health_date,
      distance: d.distance,
      shared_features: d.shared,
      shared_count: d.shared.length,
    });
  }

  return scored
    .sort((a, b) => {
      if (a.distance !== b.distance) return a.distance - b.distance;
      // 距離相同時用日期排序，保證輸出是確定性的
      return a.health_date < b.health_date ? -1 : 1;
    })
    .slice(0, topN);
}
