/**
 * 假資料產生器（形狀照 WHOOP v2 schema）。
 * 給單元測試和 dry-run 用，不需要真的 WHOOP 帳號就能驗證整條流程。
 */

const DAY_MS = 86_400_000;
const MIN = 60_000;
const H = 3_600_000;

/** 固定種子的偽隨機，確保測試每次跑結果一樣。 */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export const BASE = {
  recovery_score: 65,
  hrv: 55,
  rhr: 51,
  respiratory_rate: 15.2,
  light: 4 * H,
  sws: 1.5 * H,
  rem: 1.6 * H,
  awake: 22 * MIN,
  sleep_performance: 90,
  sleep_consistency: 78,
  sleep_efficiency: 92,
  disturbance_count: 12,
  sleep_debt: 12 * MIN,
  spo2: 96.5,
  skin_temp: 33.6,
  strain: 12.8,
};

/**
 * @param {object} opts
 * @param {Date}   opts.now         「現在」
 * @param {number} opts.days        產生幾天（含今天）
 * @param {number} opts.wakeMinutesAgo 今天的睡眠結束在幾分鐘前
 * @param {object} opts.overrides   { 0: {hrv: 40, ...} } 指定第 i 天（0=今天）的值
 * @param {string[]} opts.omitFields 這些欄位一律回 null（模擬 WHOOP One 沒有 SpO2）
 * @param {number[]} opts.calibratingDays 這幾天的 recovery 是 user_calibrating
 * @param {number[]} opts.unscoredDays    這幾天的 sleep 是 PENDING（未評分）
 * @param {boolean}  opts.withNaps   額外插入小睡紀錄（測試 nap 排除）
 */
export function makeDataset({
  now = new Date('2026-08-21T00:00:00Z'),
  days = 45,
  wakeMinutesAgo = 60,
  overrides = {},
  omitFields = [],
  calibratingDays = [],
  unscoredDays = [],
  withNaps = true,
  seed = 42,
} = {}) {
  const rand = rng(seed);
  const todayWake = new Date(now.getTime() - wakeMinutesAgo * MIN);

  const sleeps = [];
  const recoveries = [];
  const cycles = [];

  for (let i = 0; i < days; i++) {
    const end = new Date(todayWake.getTime() - i * DAY_MS);
    const jitter = (pct) => 1 + (rand() - 0.5) * 2 * pct;
    const o = overrides[i] ?? {};
    const v = (key, spread = 0.03) => (o[key] !== undefined ? o[key] : BASE[key] * jitter(spread));

    const light = v('light');
    const sws = v('sws');
    const rem = v('rem');
    const start = new Date(end.getTime() - (light + sws + rem + BASE.awake));

    const sleepId = `sleep-${String(i).padStart(3, '0')}-uuid`;
    const scored = !unscoredDays.includes(i);

    const drop = (key, value) => (omitFields.includes(key) ? null : value);

    sleeps.push({
      id: sleepId,
      v1_id: 900000 + i,
      user_id: 12345,
      created_at: end.toISOString(),
      updated_at: end.toISOString(),
      start: start.toISOString(),
      end: end.toISOString(),
      timezone_offset: '+08:00',
      nap: false,
      score_state: scored ? 'SCORED' : 'PENDING_SCORE',
      score: scored ? {
        stage_summary: {
          total_in_bed_time_milli: light + sws + rem + BASE.awake,
          total_awake_time_milli: BASE.awake,
          total_no_data_time_milli: 0,
          total_light_sleep_time_milli: light,
          total_slow_wave_sleep_time_milli: sws,
          total_rem_sleep_time_milli: rem,
          sleep_cycle_count: 5,
          disturbance_count: drop('disturbance_count', Math.round(v('disturbance_count', 0.3))),
        },
        sleep_needed: {
          baseline_milli: 8 * H,
          need_from_sleep_debt_milli: Math.round(v('sleep_debt', 0.5)),
          need_from_recent_strain_milli: 5 * MIN,
          need_from_recent_nap_milli: 0,
        },
        respiratory_rate: round1(v('respiratory_rate', 0.02)),
        sleep_performance_percentage: Math.round(v('sleep_performance')),
        sleep_consistency_percentage: drop('sleep_consistency', Math.round(v('sleep_consistency', 0.08))),
        sleep_efficiency_percentage: drop('sleep_efficiency', round1(v('sleep_efficiency', 0.02))),
      } : null,
    });

    if (withNaps && i > 0 && i % 5 === 0) {
      // 小睡：baseline 必須排除，起床觸發也不能挑到它
      const napEnd = new Date(end.getTime() + 8 * H);
      sleeps.push({
        id: `nap-${i}-uuid`,
        user_id: 12345,
        start: new Date(napEnd.getTime() - 40 * MIN).toISOString(),
        end: napEnd.toISOString(),
        nap: true,
        score_state: 'SCORED',
        score: {
          stage_summary: {
            total_light_sleep_time_milli: 30 * MIN,
            total_slow_wave_sleep_time_milli: 5 * MIN,
            total_rem_sleep_time_milli: 5 * MIN,
            total_awake_time_milli: 2 * MIN,
            total_no_data_time_milli: 0,
            disturbance_count: 1,
          },
          sleep_needed: { baseline_milli: 8 * H, need_from_sleep_debt_milli: 0 },
          respiratory_rate: 14.5,
          sleep_performance_percentage: 12,
        },
      });
    }

    recoveries.push({
      cycle_id: 500000 + i,
      sleep_id: sleepId,
      user_id: 12345,
      created_at: new Date(end.getTime() + 60_000).toISOString(),
      updated_at: new Date(end.getTime() + 60_000).toISOString(),
      score_state: scored ? 'SCORED' : 'PENDING_SCORE',
      score: scored ? {
        user_calibrating: calibratingDays.includes(i),
        recovery_score: Math.round(v('recovery_score', 0.12)),
        resting_heart_rate: Math.round(v('rhr', 0.04)),
        hrv_rmssd_milli: round1(v('hrv', 0.1)),
        spo2_percentage: drop('spo2', round1(v('spo2', 0.01))),
        skin_temp_celsius: drop('skin_temp', round1(v('skin_temp', 0.01))),
      } : null,
    });

    // cycle：i=0 是「今天剛開始、還沒結束」的那個 → end = null
    cycles.push({
      id: 500000 + i,
      user_id: 12345,
      created_at: end.toISOString(),
      updated_at: end.toISOString(),
      start: new Date(end.getTime() - DAY_MS).toISOString(),
      end: i === 0 ? null : end.toISOString(),
      timezone_offset: '+08:00',
      score_state: 'SCORED',
      score: {
        strain: round1(v('strain', 0.2)),
        kilojoule: 9000,
        average_heart_rate: 68,
        max_heart_rate: 165,
      },
    });
  }

  // i=0 的 cycle 沒結束，所以「昨日 strain」= i=1 那筆。
  // 為了讓 i=1 的 end 剛好落在今天起床附近（符合 WHOOP 的 cycle 定義），調整它。
  const yesterday = cycles.find((c) => c.id === 500001);
  if (yesterday) yesterday.end = todayWake.toISOString();

  return { sleeps, recoveries, cycles, now };
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

/** 情境：今天多項指標明顯偏離（測紅黃燈 + 教練展開講）。 */
export function degradedOverrides() {
  return {
    0: {
      recovery_score: 38,
      hrv: 38,               // -31% → 紅
      rhr: 58,               // +14% → 紅
      respiratory_rate: 16.8, // +10% → 紅
      light: 2.6 * 3_600_000,
      sws: 0.9 * 3_600_000,
      rem: 1.0 * 3_600_000,   // 總時長 4h30m → 紅
      sleep_performance: 68,
      sleep_debt: 95 * 60_000, // 比基準多 ~83 分 → 黃
      strain: 17.5,
    },
  };
}

/** 情境：連續 3 天走低（測趨勢預警 A + B 與「兩個訊號同時異常」）。 */
export function trendOverrides() {
  return {
    0: { hrv: 44, rhr: 57, recovery_score: 45, respiratory_rate: 16.2 },
    1: { hrv: 47, rhr: 55, recovery_score: 52, respiratory_rate: 15.9 },
    2: { hrv: 50, rhr: 54, recovery_score: 56, respiratory_rate: 15.8 },
  };
}
