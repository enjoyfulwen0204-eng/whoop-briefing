const DAY_MS = 86_400_000;
const START_DATE = '2026-01-01';
export function calmValue(i, { recovery = 60, hrv = 50, rhr = 55 } = {}) {
  return {
    recovery: recovery + (i % 3) - 1,
    hrv: hrv + (i % 4) - 2,
    rhr: rhr + (i % 3) - 1,
  };
}

/**
 * 寫入「第 dateIndex 天」的 sleep+recovery（health_date 由 sleep.end 決定）。
 * 可以重複呼叫、每次加一天——這是模擬「cron 每天多看到一天新資料」的正確方式。
 */
export async function seedOneDay(db, user, dateIndex, values, { idPrefix = 'd' } = {}) {
  const day = new Date(Date.parse(`${START_DATE}T15:00:00.000Z`) + dateIndex * DAY_MS);
  const start = day.toISOString();
  const end = new Date(day.getTime() + 8 * 3600_000).toISOString();
  const sleepId = `${idPrefix}-sleep-${dateIndex}`;

  await db.upsertSleeps(user.id, [{
    id: sleepId, v1_id: dateIndex, user_id: 999, start, end,
    nap: false, score_state: 'SCORED', timezone_offset: '+08:00',
    score: {
      respiratory_rate: 15, sleep_performance_percentage: 85,
      sleep_consistency_percentage: 85, sleep_efficiency_percentage: 90,
      stage_summary: {
        total_light_sleep_time_milli: 3_000_000, total_slow_wave_sleep_time_milli: 1_000_000,
        total_rem_sleep_time_milli: 1_000_000, total_awake_time_milli: 0,
        total_no_data_time_milli: 0, total_in_bed_time_milli: 8_000_000,
        disturbance_count: 1, sleep_cycle_count: 4,
      },
      sleep_needed: {
        baseline_milli: 28_800_000, need_from_sleep_debt_milli: 0,
        need_from_recent_strain_milli: 0, need_from_recent_nap_milli: 0,
      },
    },
  }], { timezone: user.timezone });

  await db.upsertRecoveries(user.id, [{
    sleep_id: sleepId, cycle_id: `${idPrefix}-cycle-${dateIndex}`, user_id: 999, score_state: 'SCORED',
    score: {
      recovery_score: values.recovery, hrv_rmssd_milli: values.hrv, resting_heart_rate: values.rhr,
      spo2_percentage: null, skin_temp_celsius: null, user_calibrating: false,
    },
  }]);

  return day;
}

/** 寫入第 0..n-1 天的平穩基準資料。 */
export async function seedCalmBaseline(db, user, n, opts) {
  for (let i = 0; i < n; i++) await seedOneDay(db, user, i, calmValue(i), opts);
}
