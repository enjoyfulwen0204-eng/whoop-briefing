/**
 * Healthspan 基礎（Phase R）—— **只建立資料底座，不算生理年齡**。
 *
 * ## 為什麼這一輪不算
 *
 * WHOOP 沒有公開 WHOOP Age / Healthspan 的完整演算法。我們自己做的東西
 * 不能、也不該叫 WHOOP Age。而且官方 Developer API 根本拿不到幾個關鍵
 * contributor（步數、VO2 Max、瘦體重），硬算出來的數字只會是假的。
 *
 * 所以這裡做的是：**誠實盤點每一個 contributor 現在拿不拿得到**，
 * 把結果連同 availability / sample_count / coverage 一起存起來。
 * 未來要做自己的 physiological age estimate 時，公式可以版本化，
 * 而且永遠知道每個輸入的資料品質。
 */

import { ANALYTICS } from './config.js';
import { requireUserId } from './userContext.js';
import { STATUS } from './capabilities.js';
import { capabilityStatusForContributor } from './capabilityMap.js';
import { describeWindow } from './analytics/statistics.js';
import { seriesOf } from './dailyMetrics.js';
import { STRENGTH_SPORTS } from './dailyMetrics.js';

export const AVAILABILITY = {
  AVAILABLE: 'AVAILABLE',
  PARTIAL: 'PARTIAL',
  UNAVAILABLE: 'UNAVAILABLE',
  UNKNOWN: 'UNKNOWN',
  APP_ONLY: 'APP_ONLY_UNAVAILABLE_TO_API',
};

/**
 * Healthspan contributor 清單。
 *
 * source:
 *   'daily_metrics'  從 daily_metrics 的欄位直接取
 *   'derived'        由其他欄位推導（會標明是推導的）
 *   'app_only'       官方 Developer API v2 沒有這個欄位
 */
export const CONTRIBUTORS = [
  { key: 'sleep_duration', field: 'sleep_total', unit: 'ms', source: 'daily_metrics' },
  { key: 'sleep_consistency', field: 'sleep_consistency', unit: '%', source: 'daily_metrics' },
  { key: 'resting_heart_rate', field: 'rhr', unit: 'bpm', source: 'daily_metrics' },
  { key: 'hrv', field: 'hrv', unit: 'ms', source: 'daily_metrics' },
  { key: 'recovery', field: 'recovery', unit: '%', source: 'daily_metrics' },
  { key: 'respiratory_rate', field: 'respiratory_rate', unit: 'brpm', source: 'daily_metrics' },
  { key: 'strain', field: 'previous_day_strain', unit: 'strain', source: 'daily_metrics' },
  { key: 'workout_volume', field: 'workout_duration_minutes', unit: 'min', source: 'daily_metrics' },
  { key: 'hr_zone_1_3', field: 'zone1_3_minutes', unit: 'min', source: 'daily_metrics' },
  { key: 'hr_zone_4_5', field: 'zone4_5_minutes', unit: 'min', source: 'daily_metrics' },
  {
    key: 'strength_activity',
    field: 'strength_minutes_derived',
    unit: 'min',
    source: 'derived',
    detail: `由 workout 的 sport_name 推導（${[...STRENGTH_SPORTS].slice(0, 3).join('/')}…），非官方欄位`,
  },
  { key: 'weight', field: 'weight', unit: 'kg', source: 'daily_metrics' },
  { key: 'max_heart_rate', field: 'body_max_hr', unit: 'bpm', source: 'daily_metrics' },
  { key: 'spo2', field: 'spo2', unit: '%', source: 'daily_metrics' },
  { key: 'skin_temp', field: 'skin_temp', unit: '°C', source: 'daily_metrics' },

  // ---- 官方 API 沒有的：永遠 APP_ONLY，永遠 null ----
  {
    key: 'steps', field: null, unit: 'count', source: 'app_only',
    detail: 'WHOOP App 有每日步數，Developer API v2 無此欄位',
  },
  {
    key: 'vo2_max', field: null, unit: 'ml/kg/min', source: 'app_only',
    detail: 'App 有 VO2 Max，Developer API v2 無此欄位',
  },
  {
    key: 'lean_body_mass', field: null, unit: 'kg', source: 'app_only',
    detail: 'body measurement 只有 height / weight / max_heart_rate',
  },
];

/** 依樣本數與涵蓋率決定 availability。 */
export function availabilityOf({ n, windowDays, source }) {
  if (source === 'app_only') return AVAILABILITY.APP_ONLY;
  if (n === 0) return AVAILABILITY.UNKNOWN;   // 沒樣本 ≠ 沒能力，不要判死
  const coverage = windowDays > 0 ? n / windowDays : 0;
  if (coverage >= 0.8) return AVAILABILITY.AVAILABLE;
  if (coverage >= 0.3) return AVAILABILITY.PARTIAL;
  return AVAILABILITY.UNKNOWN;
}

/** 資料品質信心（0–1）。純粹反映涵蓋率，不代表任何健康結論。 */
export function confidenceOf({ n, windowDays }) {
  if (!windowDays || n === 0) return 0;
  return Math.min(1, n / windowDays);
}

/**
 * 盤點所有 contributor。
 *
 * **不計算任何分數、不輸出生理年齡。**
 *
 * @param {object[]} rows daily_metrics 列
 */
export function buildContributors(rows = [], {
  endDate = null, windowDays = 90, capabilities = {},
} = {}) {
  const anchor = endDate ?? rows[0]?.health_date ?? null;

  return CONTRIBUTORS.map((c) => {
    if (c.source === 'app_only') {
      return {
        metricKey: c.key,
        value: null,
        unit: c.unit,
        windowDays,
        sampleCount: 0,
        coverage: 0,
        availability: AVAILABILITY.APP_ONLY,
        source: 'app_only',
        confidence: 0,
        detail: c.detail,
      };
    }

    if (!anchor) {
      return {
        metricKey: c.key,
        value: null,
        unit: c.unit,
        windowDays,
        sampleCount: 0,
        coverage: 0,
        availability: AVAILABILITY.UNKNOWN,
        source: c.source,
        confidence: 0,
        detail: '尚無任何健康資料',
      };
    }

    const series = seriesOf(rows, c.field);
    const w = describeWindow(series, { endDate: anchor, days: windowDays });
    const availability = availabilityOf({ n: w.n, windowDays, source: c.source });

    // capability probe 說這個帳號拿不到 → 以 probe 為準。
    //
    // ⚠️ V1.1 修正：以前是 `capabilities[c.key] ?? capabilities[c.field]`，
    // 直接拿 contributor key 或 daily_metrics 欄位名去查 probe。但 probe 用的
    // 是第三套命名（`recovery_score` / `strain` / `body_weight`…），
    // 所以 `resting_heart_rate`、`sleep_duration`、`weight` 這些永遠查不到，
    // 安靜地變成 undefined。現在走集中、明確、有測試的對應表。
    const capStatus = capabilityStatusForContributor(c.key, capabilities);
    const finalAvailability = capStatus === STATUS.UNAVAILABLE
      || capStatus === STATUS.UNAUTHORIZED
      ? AVAILABILITY.UNAVAILABLE
      : availability;

    return {
      metricKey: c.key,
      // 沒有足夠樣本時 value 一律 null —— 不要用 1、2 筆算平均當結論
      value: w.n >= ANALYTICS.MIN_SAMPLES ? w.mean : null,
      unit: c.unit,
      windowDays,
      sampleCount: w.n,
      coverage: w.coverage,
      availability: finalAvailability,
      source: c.source,
      confidence: confidenceOf({ n: w.n, windowDays }),
      detail: c.detail ?? null,
    };
  });
}

/** 盤點並寫進 healthspan_metrics。 */
export async function snapshotContributors({
  userId,
  db, rows, endDate, windowDays = 90, capabilities = {}, now = new Date(),
}) {
  const contributors = buildContributors(rows, { endDate, windowDays, capabilities });
  const uid = requireUserId(userId, 'snapshotContributors');
  await db.saveHealthspanMetrics(uid, contributors, { now });

  const usable = contributors.filter(
    (c) => c.availability === AVAILABILITY.AVAILABLE || c.availability === AVAILABILITY.PARTIAL,
  );

  // ⚠️ 刻意寫入 status='FOUNDATION_ONLY'、score=null。
  // 這一輪絕不產生任何生理年齡數字。
  await db.saveHealthspanSnapshot(uid, {
    snapshotDate: endDate ?? now.toISOString().slice(0, 10),
    algorithmVersion: 'foundation-v0',
    score: null,
    scoreKind: null,
    contributors,
    coverage: contributors.length ? usable.length / contributors.length : 0,
    status: 'FOUNDATION_ONLY',
  }, { now });

  return {
    contributors,
    usable_count: usable.length,
    total: contributors.length,
    score: null,
    note: '這一輪只建立資料底座，不計算生理年齡。',
  };
}
