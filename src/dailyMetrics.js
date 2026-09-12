/**
 * 每日正規化指標（daily_metrics）。
 *
 * ## 為什麼從 raw_json 還原
 *
 * health_date、「同日多筆主睡眠取 end 最晚那筆」、「昨日 Strain 單向對應」
 * 這幾條規則是全系統的時間軸，已經有大量測試保護。與其在扁平的 DB 欄位上
 * 重寫一套（勢必漂移），不如把 raw_json 還原成 WHOOP 原始形狀，
 * 直接呼叫 analyze.js 既有的 buildObservations / yesterdayCycleFor。
 * 口徑保證 100% 一致。
 *
 * ## 「前一天」的定義
 *
 * previous_day_strain 用的是 sleep.end 之前最近一個已完成 cycle。
 * 為了口徑一致，**運動、小睡、全日心率、熱量全部取自同一個 cycle 的時間窗**，
 * 而不是各用各的日期算法。這樣「昨天的負荷」在每一個欄位上都是同一段時間。
 *
 * ## 缺欄位不等於這一天無效
 *
 * 少一個 optional 欄位（例如 SpO2）只會讓那個欄位是 null，
 * 絕不會讓整天的 daily_metrics 失效。
 */

import { num, sleepTotalMilli } from './config.js';
import {
  buildObservations, completedCycles, yesterdayCycleFor, isCalibrating,
} from './analyze.js';
import { localDate, localTime } from './time.js';
import { log } from './logger.js';
import { requireUserId } from './userContext.js';

const MIN_MS = 60_000;

/**
 * WHOOP 的 sport_name 裡屬於「肌力訓練」的類型。
 * ⚠️ 這是**推導值不是官方欄位** —— Developer API 沒有 strength minutes，
 * 這裡用運動類型近似。凡是用到的地方都要標明是推導的。
 */
export const STRENGTH_SPORTS = new Set([
  'weightlifting', 'powerlifting', 'functional_fitness', 'strength_trainer',
  'cross_country_skiing', // 佔位：實際清單以 probe 到的 sport_name 為準
]);

/** DB 列 → 原始 WHOOP 物件（raw_json 存在就用它，確保與 API 完全一致）。 */
function reviveRow(row) {
  if (row?.raw_json) {
    try {
      return JSON.parse(row.raw_json);
    } catch { /* raw_json 壞掉就退回用扁平欄位重建 */ }
  }
  return null;
}

function reviveSleep(row) {
  return reviveRow(row) ?? {
    id: row.id,
    start: row.start_at,
    end: row.end_at,
    timezone_offset: row.timezone_offset,
    nap: row.nap === 1,
    score_state: row.score_state,
    score: {
      respiratory_rate: num(row.respiratory_rate),
      sleep_performance_percentage: num(row.sleep_performance_percentage),
      sleep_consistency_percentage: num(row.sleep_consistency_percentage),
      sleep_efficiency_percentage: num(row.sleep_efficiency_percentage),
      stage_summary: {
        total_light_sleep_time_milli: num(row.light_sleep_milli),
        total_slow_wave_sleep_time_milli: num(row.slow_wave_sleep_milli),
        total_rem_sleep_time_milli: num(row.rem_sleep_milli),
        total_awake_time_milli: num(row.awake_milli),
        total_in_bed_time_milli: num(row.in_bed_milli),
        disturbance_count: num(row.disturbance_count),
        sleep_cycle_count: num(row.sleep_cycle_count),
      },
      sleep_needed: {
        baseline_milli: num(row.sleep_need_baseline_milli),
        need_from_sleep_debt_milli: num(row.sleep_debt_milli),
      },
    },
  };
}

function reviveRecovery(row) {
  return reviveRow(row) ?? {
    sleep_id: row.sleep_id,
    cycle_id: row.cycle_id,
    score_state: row.score_state,
    score: {
      recovery_score: num(row.recovery_score),
      hrv_rmssd_milli: num(row.hrv_rmssd_milli),
      resting_heart_rate: num(row.resting_heart_rate),
      spo2_percentage: num(row.spo2_percentage),
      skin_temp_celsius: num(row.skin_temp_celsius),
      user_calibrating: row.user_calibrating === 1,
    },
  };
}

function reviveCycle(row) {
  return reviveRow(row) ?? {
    id: row.id,
    start: row.start_at,
    end: row.end_at,
    score_state: row.score_state,
    score: {
      strain: num(row.strain),
      kilojoule: num(row.kilojoule),
      average_heart_rate: num(row.average_heart_rate),
      max_heart_rate: num(row.max_heart_rate),
    },
  };
}

/** 落在 [fromMs, toMs) 的運動，彙總成一天的數字。 */
function summariseWorkouts(workoutRows, fromMs, toMs) {
  const inWindow = workoutRows.filter((w) => {
    const t = Date.parse(w.start_at);
    return Number.isFinite(t) && t >= fromMs && t < toMs;
  });
  const scored = inWindow.filter((w) => w.score_state === 'SCORED');

  // ★ 缺值**不可以**壓低總和。
  //
  // 舊寫法是 `acc + (num(f(w)) ?? 0)`：一筆已評分的運動若缺 strain，它就
  // 貢獻 0，於是總和看起來完整、實際上少算一筆。使用者看到的是一個可信
  // 的數字，而它是錯的 —— 那比「無資料」更糟。
  //
  // 現在：任何一筆已評分紀錄缺該欄位 → 整個總和不可用（null）。
  // 「完全沒有已評分的運動」是另一回事，由呼叫端的 scored.length 判斷。
  const sumRequired = (records, f) => {
    let acc = 0;
    for (const r of records) {
      const v = num(f(r));
      if (v === null) return null;
      acc += v;
    }
    return acc;
  };

  /** 時長同理：起訖時間有一筆解析不出來，整段時長就不可用。 */
  const durationRequired = (records) => {
    let acc = 0;
    for (const r of records) {
      const a = Date.parse(r.start_at);
      const b = Date.parse(r.end_at);
      if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return null;
      acc += b - a;
    }
    return acc;
  };

  /** null 會傳染：任何一項不可用，整個合計就不可用。 */
  const addAll = (...parts) => (parts.some((p) => p === null)
    ? null : parts.reduce((a, b) => a + b, 0));
  const toMinutes = (ms) => (ms === null ? null : Math.round(ms / MIN_MS));

  const durationMs = durationRequired(scored);
  const zone13 = addAll(
    sumRequired(scored, (w) => w.zone_one_milli),
    sumRequired(scored, (w) => w.zone_two_milli),
    sumRequired(scored, (w) => w.zone_three_milli),
  );
  const zone45 = addAll(
    sumRequired(scored, (w) => w.zone_four_milli),
    sumRequired(scored, (w) => w.zone_five_milli),
  );
  const strengthMs = durationRequired(scored
    .filter((w) => STRENGTH_SPORTS.has(String(w.sport_name ?? '').toLowerCase())));

  return {
    // 筆數是真正的計數：窗內沒有紀錄就是 0，那是事實不是缺值。
    workout_count: inWindow.length,
    workout_scored_count: scored.length,
    workout_strain_total: scored.length ? sumRequired(scored, (w) => w.strain) : null,
    workout_duration_minutes: scored.length ? toMinutes(durationMs) : null,
    workout_kilojoule: scored.length ? sumRequired(scored, (w) => w.kilojoule) : null,
    zone1_3_minutes: scored.length ? toMinutes(zone13) : null,
    zone4_5_minutes: scored.length ? toMinutes(zone45) : null,
    // 推導值，非官方欄位
    strength_minutes_derived: scored.length ? toMinutes(strengthMs) : null,
    workout_sports: [...new Set(scored.map((w) => w.sport_name).filter(Boolean))],
  };
}

/** 落在 [fromMs, toMs) 的小睡。 */
function summariseNaps(napRows, fromMs, toMs) {
  const inWindow = napRows.filter((n) => {
    const t = Date.parse(n.end_at);
    return Number.isFinite(t) && t >= fromMs && t < toMs;
  });
  // 窗內沒有小睡 → 總時長真的是 0（那是事實）。
  // 有小睡但某一筆缺時長 → 不可用；把它當成 0 分鐘的睡眠是捏造。
  let napTotal = 0;
  for (const n of inWindow) {
    const v = num(n.total_sleep_milli);
    if (v === null) { napTotal = null; break; }
    napTotal += v;
  }
  return {
    nap_count: inWindow.length,
    nap_total_milli: napTotal,
  };
}

/**
 * 純函式：DB 列 → 每日正規化指標（新→舊）。
 *
 * @param {object[]} sleepRows  whoop_sleeps 的列（含 nap）
 * @param {object[]} recoveryRows
 * @param {object[]} cycleRows
 * @param {object[]} workoutRows
 * @param {?object}  bodyMeasurement 最新一筆
 */
export function computeDailyMetrics({
  sleepRows = [], recoveryRows = [], cycleRows = [], workoutRows = [],
  bodyMeasurement = null, timezone,
} = {}) {
  const mainSleepRows = sleepRows.filter((r) => r.nap === 0 || r.nap === false);
  const napRows = sleepRows.filter((r) => r.nap === 1 || r.nap === true);

  const sleeps = mainSleepRows.map(reviveSleep);
  const recoveries = recoveryRows.map(reviveRecovery);
  const cycles = cycleRows.map(reviveCycle);

  // ★ 直接沿用簡報用的同一套日曆口徑
  const observations = buildObservations({ sleeps, recoveries, timezone });
  const cyclesDesc = completedCycles(cycles);

  const weight = num(bodyMeasurement?.weight_kilogram);
  const height = num(bodyMeasurement?.height_meter);
  const bodyMaxHr = num(bodyMeasurement?.max_heart_rate);

  return observations.map((obs) => {
    const s = obs.sleep;
    const r = obs.recovery;
    const g = s?.score?.stage_summary ?? {};

    // 「昨天」= sleep.end 之前最近一個已完成 cycle（與 previous_day_strain 同一個）
    const cycle = yesterdayCycleFor(obs, cyclesDesc);
    const winFrom = cycle?.start ? Date.parse(cycle.start) : null;
    const winTo = cycle?.end ? Date.parse(cycle.end) : null;
    const hasWindow = Number.isFinite(winFrom) && Number.isFinite(winTo);

    const workouts = hasWindow
      ? summariseWorkouts(workoutRows, winFrom, winTo)
      : {
        workout_count: null, workout_scored_count: null, workout_strain_total: null,
        workout_duration_minutes: null, workout_kilojoule: null,
        zone1_3_minutes: null, zone4_5_minutes: null,
        strength_minutes_derived: null, workout_sports: [],
      };
    const naps = hasWindow
      ? summariseNaps(napRows, winFrom, winTo)
      : { nap_count: null, nap_total_milli: null };

    // 各分期**各自**可為 null（那是誠實的「這一段拿不到」）。
    const light = num(g.total_light_sleep_time_milli);
    const sws = num(g.total_slow_wave_sleep_time_milli);
    const rem = num(g.total_rem_sleep_time_milli);
    // 但**總和**三段缺一不可（與 store 寫入、METRICS 顯示共用同一個函式）。
    const sleepTotal = sleepTotalMilli(g);

    const recoveryScored = r?.score_state === 'SCORED';
    const calibrating = isCalibrating(obs);
    /**
     * 已評分的 recovery 數值 —— **校正期也照樣保留**。
     *
     * 這裡以前會在校正期把值抹成 null，理由是「校正期的數字不可信，不能進
     * 統計」。那個目的是對的，但做法把兩件不同的事綁在一起了：
     *
     *   事實：WHOOP 今天真的算出了 recovery 63 / HRV 65.6 / RHR 54
     *   分析資格：這些值還不能拿來當 baseline、趨勢、預測的樣本
     *
     * 抹成 null 等於連「事實存在」都否認掉，於是 Q&A 回「目前拿不到 HRV」，
     * 而使用者手機上明明就看得到。日報那條路早就做對了（analyze.js 用
     * allowCalibrating 顯示數值、同時用 lightsAllowed 收掉判斷），Q&A 沒跟上。
     *
     * 現在事實保留在這一列，**分析資格由 seriesOf 那個邊界負責排除**。
     */
    const rec = (k) => (recoveryScored ? num(r?.score?.[k]) : null);

    return {
      health_date: obs.healthDate,

      // --- 恢復 ---
      recovery: rec('recovery_score'),
      hrv: rec('hrv_rmssd_milli'),
      rhr: rec('resting_heart_rate'),
      spo2: rec('spo2_percentage'),
      skin_temp: rec('skin_temp_celsius'),

      // --- 睡眠時機（★ 之前完全沒有保存）---
      sleep_start: s?.start ?? null,
      sleep_end: s?.end ?? null,
      bedtime_local: s?.start ? localTime(s.start, timezone) : null,
      wake_time_local: s?.end ? localTime(s.end, timezone) : null,
      bedtime_date_local: s?.start ? localDate(s.start, timezone) : null,
      timezone_offset: s?.timezone_offset ?? null,

      // --- 睡眠品質 ---
      respiratory_rate: num(s?.score?.respiratory_rate),
      sleep_total: sleepTotal,
      deep_sleep: sws,
      rem_sleep: rem,
      light_sleep: light,
      awake_time: num(g.total_awake_time_milli),
      in_bed_time: num(g.total_in_bed_time_milli),
      sleep_performance: num(s?.score?.sleep_performance_percentage),
      sleep_consistency: num(s?.score?.sleep_consistency_percentage),
      sleep_efficiency: num(s?.score?.sleep_efficiency_percentage),
      sleep_debt: num(s?.score?.sleep_needed?.need_from_sleep_debt_milli),
      sleep_need_baseline: num(s?.score?.sleep_needed?.baseline_milli),
      disturbances: num(g.disturbance_count),
      sleep_cycle_count: num(g.sleep_cycle_count),

      // --- 前一天（全部取自同一個 cycle 時間窗）---
      previous_day_strain: cycle ? num(cycle?.score?.strain) : null,
      cycle_avg_hr: cycle ? num(cycle?.score?.average_heart_rate) : null,
      cycle_max_hr: cycle ? num(cycle?.score?.max_heart_rate) : null,
      kilojoule: cycle ? num(cycle?.score?.kilojoule) : null,
      cycle_id: cycle ? String(cycle.id) : null,
      ...workouts,
      ...naps,

      // --- 身體量測（最新一筆，非每日）---
      weight,
      height,
      body_max_hr: bodyMaxHr,

      // --- 官方 API 沒有的（永遠 null，絕不假造）---
      steps: null,              // APP_ONLY_UNAVAILABLE_TO_API
      vo2max: null,             // APP_ONLY_UNAVAILABLE_TO_API
      lean_body_mass: null,     // APP_ONLY_UNAVAILABLE_TO_API

      // --- 資料品質旗標（缺欄位不會讓整天失效）---
      has_sleep: Boolean(s),
      sleep_scored: s?.score_state === 'SCORED',
      has_recovery: Boolean(r),
      recovery_scored: recoveryScored,
      calibrating,
      has_previous_cycle: Boolean(cycle),
    };
  });
}

/**
 * DB 版：抓出區間內所有原始資料再算。
 *
 * ⚠️ 這裡刻意用 allSettled 而不是 Promise.all。
 *
 * Promise.all 遇到第一個 reject 就往外拋，**其餘還在飛的 promise 之後才 reject
 * 就變成 unhandledRejection** —— Node 22 預設會直接終止 process。也就是說
 * 一個 optional 查詢失敗有可能整支 cron 被殺掉，連已經算好的簡報都發不出去。
 *
 * 現在：睡眠是唯一的必要資料，它失敗就往外拋（呼叫端已包 try/catch）；
 * 其餘任何一個失敗都只是那部分沒有值，不影響其他欄位。
 */
/**
 * @param {string} userId **必填**。所有資料讀取都限定這個使用者。
 * @param {string} timezone 該使用者的時區。
 */
export async function loadDailyMetrics({
  db, userId, timezone, from, to, fromIso, toIso,
  includeCalibratingFacts = false,
}) {
  const uid = requireUserId(userId, 'loadDailyMetrics');
  const startIso = fromIso ?? `${from}T00:00:00.000Z`;
  const endIso = toIso ?? `${to}T23:59:59.999Z`;
  // cycle / workout 用時間戳篩，而且要比 health_date 區間再往前一天，
  // 因為 from 那天的「昨日 cycle」落在 from 的前一天。
  const padStart = new Date(Date.parse(startIso) - 2 * 86_400_000).toISOString();

  const settled = await Promise.allSettled([
    db.getSleeps(uid, { from, to, includeNaps: true }),
    db.getRecoveries(uid, { from, to }),
    db.getCycles(uid, { fromIso: padStart, toIso: endIso }),
    db.getWorkouts(uid, { fromIso: padStart, toIso: endIso }),
    db.getLatestBodyMeasurement(uid),
  ]);

  const names = ['sleeps', 'recoveries', 'cycles', 'workouts', 'bodyMeasurement'];
  const value = (i, fallback) => {
    if (settled[i].status === 'fulfilled') return settled[i].value ?? fallback;
    log.warn('daily_metrics_partial_failure', {
      user_id: uid,
      part: names[i],
      error: String(settled[i].reason?.message ?? settled[i].reason).slice(0, 200),
    });
    return fallback;
  };

  // 睡眠是骨架：沒有它就沒有任何 health_date 可言
  if (settled[0].status === 'rejected') throw settled[0].reason;

  const rows = computeDailyMetrics({
    sleepRows: value(0, []),
    recoveryRows: value(1, []),
    cycleRows: value(2, []),
    workoutRows: value(3, []),
    bodyMeasurement: value(4, null),
    timezone,
  });

  // Most callers are analytical pipelines. Preserve their pre-QAA semantics even
  // when they consume rows directly instead of going through seriesOf(). Only a
  // factual publication caller may opt in to the observed calibration values.
  if (includeCalibratingFacts) return rows;
  return rows.map((row) => {
    if (row.calibrating !== true) return row;
    const safe = { ...row };
    for (const key of RECOVERY_DERIVED_METRICS) safe[key] = null;
    return safe;
  });
}

/**
 * recovery 算出來的指標。校正期的這幾個值**不可以**進任何統計。
 *
 * 事實層仍然看得到它們（見 computeDailyMetrics 的 rec()）—— 分開的地方就在這裡。
 */
export const RECOVERY_DERIVED_METRICS = new Set([
  'recovery', 'hrv', 'rhr', 'spo2', 'skin_temp',
]);

/**
 * 把 daily metrics 轉成某個欄位的時間序列（舊→新），null 會被略過。
 *
 * ★ 這是**分析層唯一的入口**：baseline、趨勢、預測、異常、Insight、
 * healthspan、實驗，全部都從這裡拿序列。所以「校正期的樣本不可以進統計」
 * 這條規則放在這裡就夠了，不需要在每個消費者各寫一次。
 *
 * 校正期的 recovery 衍生值以前是在 computeDailyMetrics 就被抹成 null，
 * 所以自然被下面的 null 過濾掉。現在值保留了（Q&A 要用），排除就改在這裡 ——
 * 對分析層來說**序列完全一樣**，行為沒有任何改變。
 */
export function seriesOf(rows, key) {
  const excludeCalibrating = RECOVERY_DERIVED_METRICS.has(key);
  return [...rows]
    .filter((r) => !(excludeCalibrating && r.calibrating === true))
    .filter((r) => num(r[key]) !== null)
    .sort((a, b) => (a.health_date < b.health_date ? -1 : 1))
    .map((r) => ({ date: r.health_date, value: num(r[key]) }));
}
