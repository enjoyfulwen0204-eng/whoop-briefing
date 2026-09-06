/**
 * Capability 偵測 —— 「這個帳號實際拿得到什麼」。
 *
 * ## 核心原則（不可違反）
 *
 * 絕不用 membership tier 判斷能力。沒有 `if (membership === 'one')`。
 * WHOOP One 與 Peak 用的是同一顆 WHOOP 5.0 硬體，差別在服務層，
 * 而且 WHOOP 隨時可能調整。唯一可信的判準只有一條：
 *
 *     API 這個欄位實際有沒有值 → 有就 available，沒有就 unavailable
 *
 * ## status 語義
 *
 *   SUPPORTED   取樣範圍內每一筆都有值
 *   PARTIAL     有些筆有、有些筆沒有（可能是裝置沒戴滿、或 WHOOP 間歇提供）
 *   UNAVAILABLE 有取到樣本，但這個欄位每一筆都是 null → 這個帳號沒有
 *   UNKNOWN     樣本不足，無從判斷（不要猜）
 *   UNAUTHORIZED        對應 endpoint 需要的 scope 目前 token 沒有 → 重新授權即可
 *   APP_ONLY_UNAVAILABLE_TO_API
 *               WHOOP App 裡看得到，但官方 Developer API v2 根本沒有這個欄位。
 *               這是靜態事實，不需要 probe。**絕不 scrape、絕不用 private API。**
 */

import { METRICS, num } from './config.js';
import { metricValueFromRecord, buildRecords, completedCycles } from './analyze.js';
import { log } from './logger.js';

export const STATUS = {
  SUPPORTED: 'SUPPORTED',
  PARTIAL: 'PARTIAL',
  UNAVAILABLE: 'UNAVAILABLE',
  UNKNOWN: 'UNKNOWN',
  UNAUTHORIZED: 'UNAUTHORIZED',
  APP_ONLY: 'APP_ONLY_UNAVAILABLE_TO_API',
};

/** 樣本數低於這個值就不下判斷（回 UNKNOWN）。 */
export const MIN_SAMPLES_FOR_VERDICT = 3;

/**
 * 官方 Developer API v2 沒有提供的東西。
 *
 * 依 https://developer.whoop.com/api/ 的完整 endpoint 與 schema 清單確認：
 * v2 只有 cycle / recovery / sleep / workout / body measurement / profile。
 * 下面這些在 WHOOP App 看得到，但 API 沒有對應欄位。
 * 標成 APP_ONLY 是為了讓上層明確知道「這不是壞掉，是拿不到」。
 */
export const APP_ONLY_CAPABILITIES = [
  { key: 'steps', detail: 'WHOOP App 有每日步數，Developer API v2 無此欄位' },
  { key: 'vo2_max', detail: 'App 有 VO2 Max，API 無此欄位' },
  { key: 'lean_body_mass', detail: 'body measurement 只有 height / weight / max_heart_rate' },
  { key: 'stress_score', detail: 'Stress Monitor 為 App 功能，API 無此欄位' },
  { key: 'whoop_age', detail: 'WHOOP Age 為 App 專有演算法，API 無此欄位' },
  { key: 'healthspan', detail: 'Healthspan 為 App 專有演算法，API 無此欄位' },
  { key: 'blood_pressure', detail: 'API 無此欄位' },
  { key: 'ecg_afib', detail: 'API 無此欄位' },
  { key: 'hormonal_insights', detail: 'API 無此欄位' },
  { key: 'journal_behaviors', detail: 'WHOOP Journal 為 App 功能，API 無法讀取（本系統改用自建 journal）' },
];

/**
 * 除了 METRICS 之外，另外要偵測的原始欄位。
 * getter 直接吃 WHOOP 原始 record（不是 observation）。
 */
const EXTRA_PROBES = {
  sleep: [
    { key: 'sleep_start', label: '入睡時間', get: (s) => (s?.start ? 1 : null) },
    { key: 'sleep_timezone_offset', label: '睡眠時區位移', get: (s) => (s?.timezone_offset ? 1 : null) },
    { key: 'sleep_awake_time', label: '清醒時間', get: (s) => num(s?.score?.stage_summary?.total_awake_time_milli) },
    { key: 'sleep_in_bed_time', label: '在床時間', get: (s) => num(s?.score?.stage_summary?.total_in_bed_time_milli) },
    { key: 'sleep_cycle_count', label: '睡眠週期數', get: (s) => num(s?.score?.stage_summary?.sleep_cycle_count) },
    { key: 'sleep_need_baseline', label: '睡眠需求基準', get: (s) => num(s?.score?.sleep_needed?.baseline_milli) },
    { key: 'sleep_need_recent_strain', label: '負荷造成的睡眠需求', get: (s) => num(s?.score?.sleep_needed?.need_from_recent_strain_milli) },
    { key: 'sleep_need_recent_nap', label: '小睡折抵', get: (s) => num(s?.score?.sleep_needed?.need_from_recent_nap_milli) },
  ],
  cycle: [
    { key: 'cycle_average_heart_rate', label: '全日平均心率', get: (c) => num(c?.score?.average_heart_rate) },
    { key: 'cycle_max_heart_rate', label: '全日最高心率', get: (c) => num(c?.score?.max_heart_rate) },
    { key: 'cycle_kilojoule', label: '熱量消耗', get: (c) => num(c?.score?.kilojoule) },
  ],
  workout: [
    { key: 'workout_strain', label: '運動 Strain', get: (w) => num(w?.score?.strain) },
    { key: 'workout_sport_name', label: '運動類型', get: (w) => (w?.sport_name ? 1 : null) },
    { key: 'workout_average_heart_rate', label: '運動平均心率', get: (w) => num(w?.score?.average_heart_rate) },
    { key: 'workout_max_heart_rate', label: '運動最高心率', get: (w) => num(w?.score?.max_heart_rate) },
    { key: 'workout_kilojoule', label: '運動熱量', get: (w) => num(w?.score?.kilojoule) },
    { key: 'workout_distance', label: '運動距離', get: (w) => num(w?.score?.distance_meter) },
    { key: 'workout_altitude_gain', label: '爬升高度', get: (w) => num(w?.score?.altitude_gain_meter) },
    { key: 'workout_zone_durations', label: '心率區間時間', get: (w) => num(w?.score?.zone_durations?.zone_two_milli) },
    { key: 'workout_percent_recorded', label: '資料完整度', get: (w) => num(w?.score?.percent_recorded) },
  ],
  body_measurement: [
    { key: 'body_height', label: '身高', get: (b) => num(b?.height_meter) },
    { key: 'body_weight', label: '體重', get: (b) => num(b?.weight_kilogram) },
    { key: 'body_max_heart_rate', label: '最大心率', get: (b) => num(b?.max_heart_rate) },
  ],
};

/** 依樣本數與非 null 數決定 status。 */
export function classify(sampleCount, nonNullCount) {
  if (sampleCount === 0) return STATUS.UNKNOWN;
  if (nonNullCount === 0) {
    // 樣本太少時「全都是 null」也可能只是剛好，不要太早下 UNAVAILABLE
    return sampleCount >= MIN_SAMPLES_FOR_VERDICT ? STATUS.UNAVAILABLE : STATUS.UNKNOWN;
  }
  if (nonNullCount === sampleCount) return STATUS.SUPPORTED;
  return STATUS.PARTIAL;
}

/**
 * 純函式：原始資料 → capability 清單。
 * 好測、不需要網路，也讓上層可以改成從 DB 取樣。
 *
 * @param {object[]} scopeErrors 形如 [{ resource: 'workout' }]，該 resource
 *                               的所有 capability 會標成 UNAUTHORIZED
 */
export function computeCapabilities({
  sleeps = [], recoveries = [], cycles = [], workouts = [],
  bodyMeasurement = null, timezone, scopeErrors = [],
} = {}) {
  const unauthorized = new Set(scopeErrors.map((e) => e.resource));
  const out = [];

  // observation 形狀（sleep + 對應 recovery），與簡報用的完全一致
  const records = buildRecords({ sleeps, recoveries, timezone });
  const cyclesDesc = completedCycles(cycles);
  const scoredWorkouts = workouts.filter((w) => w && w.score_state === 'SCORED');

  const push = (key, label, samples, getter, resource) => {
    if (unauthorized.has(resource)) {
      out.push({
        key,
        label,
        status: STATUS.UNAUTHORIZED,
        sampleCount: 0,
        nonNullCount: 0,
        latestValue: null,
        detail: `缺少 ${resource} 所需的 scope，請重跑 npm run authorize`,
      });
      return;
    }
    let nonNull = 0;
    let latest = null;
    for (const s of samples) {
      const v = getter(s);
      if (v !== null && v !== undefined) {
        nonNull += 1;
        if (latest === null) latest = v;
      }
    }
    out.push({
      key,
      label,
      status: classify(samples.length, nonNull),
      sampleCount: samples.length,
      nonNullCount: nonNull,
      latestValue: latest,
      detail: null,
    });
  };

  // --- 簡報實際使用的 15 個指標 ---
  for (const metric of METRICS) {
    if (metric.source === 'cycle') {
      push(metric.key, metric.label, cyclesDesc, (c) => metric.get(c), 'cycle');
    } else {
      const resource = metric.source === 'recovery' ? 'recovery' : 'sleep';
      push(
        metric.key, metric.label, records,
        (r) => metricValueFromRecord(metric, r, { allowCalibrating: true }),
        resource,
      );
    }
  }

  // --- 之前被浪費、現在開始落地的原始欄位 ---
  for (const p of EXTRA_PROBES.sleep) {
    push(p.key, p.label, records.map((r) => r.sleep), p.get, 'sleep');
  }
  for (const p of EXTRA_PROBES.cycle) {
    push(p.key, p.label, cyclesDesc, p.get, 'cycle');
  }
  for (const p of EXTRA_PROBES.workout) {
    push(p.key, p.label, scoredWorkouts, p.get, 'workout');
  }
  for (const p of EXTRA_PROBES.body_measurement) {
    push(p.key, p.label, bodyMeasurement ? [bodyMeasurement] : [], p.get, 'body_measurement');
  }

  // --- 有沒有運動資料本身也是一個 capability ---
  if (unauthorized.has('workout')) {
    out.push({
      key: 'workout', label: '運動紀錄', status: STATUS.UNAUTHORIZED,
      sampleCount: 0, nonNullCount: 0, latestValue: null,
      detail: '缺少 read:workout scope，請重跑 npm run authorize',
    });
  } else {
    out.push({
      key: 'workout',
      label: '運動紀錄',
      status: workouts.length === 0 ? STATUS.UNKNOWN : STATUS.SUPPORTED,
      sampleCount: workouts.length,
      nonNullCount: scoredWorkouts.length,
      latestValue: scoredWorkouts[0]?.sport_name ?? null,
      detail: workouts.length === 0 ? '取樣範圍內沒有運動紀錄，無法判定' : null,
    });
  }

  // --- 小睡 ---
  const naps = sleeps.filter((s) => s?.nap === true);
  out.push({
    key: 'nap',
    label: '小睡',
    status: sleeps.length === 0 ? STATUS.UNKNOWN : (naps.length ? STATUS.SUPPORTED : STATUS.UNKNOWN),
    sampleCount: sleeps.length,
    nonNullCount: naps.length,
    latestValue: naps.length,
    detail: naps.length ? null : '取樣範圍內沒有小睡紀錄，無法判定',
  });

  // --- API 根本沒有的（靜態事實，不 probe）---
  for (const a of APP_ONLY_CAPABILITIES) {
    out.push({
      key: a.key,
      label: a.key,
      status: STATUS.APP_ONLY,
      sampleCount: 0,
      nonNullCount: 0,
      latestValue: null,
      detail: a.detail,
    });
  }

  return out;
}

/**
 * 實際去 WHOOP 抓資料 → 算 capability → 寫進 Turso。
 * 任何一個 resource 缺 scope 都不會讓整個 probe 失敗。
 */
export async function probeCapabilities({ db, whoop, timezone, days = 14, now = new Date() }) {
  const start = new Date(now.getTime() - days * 86_400_000);
  const scopeErrors = [];

  const tryFetch = async (resource, fn) => {
    try {
      return await fn();
    } catch (err) {
      const { isScopeError } = await import('./whoop.js');
      if (isScopeError(err)) {
        scopeErrors.push({ resource });
        log.warn('probe_scope_missing', { resource });
        return resource === 'body_measurement' ? null : [];
      }
      throw err;
    }
  };

  const [sleeps, recoveries, cycles, workouts, bodyMeasurement] = await Promise.all([
    tryFetch('sleep', () => whoop.sleeps(start, now)),
    tryFetch('recovery', () => whoop.recoveries(start, now)),
    tryFetch('cycle', () => whoop.cycles(start, now)),
    tryFetch('workout', () => whoop.workouts(start, now)),
    tryFetch('body_measurement', () => whoop.bodyMeasurement()),
  ]);

  const entries = computeCapabilities({
    sleeps, recoveries, cycles, workouts, bodyMeasurement, timezone, scopeErrors,
  });
  await db.saveCapabilities(entries, { now });
  log.info('probe_done', {
    days,
    total: entries.length,
    supported: entries.filter((e) => e.status === STATUS.SUPPORTED).length,
    unavailable: entries.filter((e) => e.status === STATUS.UNAVAILABLE).length,
    unauthorized: entries.filter((e) => e.status === STATUS.UNAUTHORIZED).length,
  });
  return { entries, scopeErrors, sampleDays: days };
}

/**
 * 其他模組的入口：`getCapability(caps, 'spo2')`。
 * 沒 probe 過就回 UNKNOWN —— 永遠不要猜。
 */
export function getCapability(capabilities, key) {
  return capabilities?.[key]?.status ?? STATUS.UNKNOWN;
}

/** 這個 capability 現在可以拿來做分析嗎？ */
export function isUsable(capabilities, key) {
  const s = getCapability(capabilities, key);
  return s === STATUS.SUPPORTED || s === STATUS.PARTIAL;
}
