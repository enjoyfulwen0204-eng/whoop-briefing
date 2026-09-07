/**
 * Multi-user 測試用的合成使用者。
 *
 * Alice 與 Bob 刻意設計成「所有能撞的維度都撞」：
 *   - 相同的 WHOOP external id（sleep / recovery / cycle / workout）
 *   - 相同的 body measurement 時間戳
 *   - 相同的 health_date 與 UTC 時間戳
 *   - 相同的 prediction target / model version
 *   - 相同的 experiment 名稱
 *   - 相同的 healthspan snapshot 日期 / 版本
 * 只有**數值**不同。兩邊都必須共存且互相看不到。
 *
 * 時區刻意選相差 12 小時的兩地，好驗證同一個 UTC 瞬間會落在不同的當地日期。
 */

export const ALICE = {
  id: 'u-alice', displayName: 'Alice', chatId: '1001', timezone: 'Asia/Taipei',
};
export const BOB = {
  id: 'u-bob', displayName: 'Bob', chatId: '1002', timezone: 'America/New_York',
};

/** 兩人共用的 external id / 時間戳 —— 刻意完全相同。 */
export const SHARED = {
  sleepId: 'shared-sleep-1',
  cycleId: 'shared-cycle-1',
  workoutId: 'shared-workout-1',
  sleepStart: '2026-09-06T15:00:00.000Z',
  sleepEnd: '2026-09-06T23:00:00.000Z',
  healthDate: '2026-09-07',
  experimentName: '早睡實驗',
  predictionTarget: '2026-09-08',
  modelVersion: 'v1-test',
  snapshotDate: '2026-09-07',
  algorithmVersion: 'alg-v1',
};

/** 建立兩個使用者並綁好 Telegram。回傳 { alice, bob }。 */
export async function seedAliceAndBob(db) {
  for (const u of [ALICE, BOB]) {
    await db.createUser({
      id: u.id, displayName: u.displayName, timezone: u.timezone, status: 'ACTIVE',
    });
    await db.linkTelegram({ chatId: u.chatId, userId: u.id });
  }
  return { alice: ALICE, bob: BOB };
}

/** 建立單一使用者（單人行為回歸測試用）。 */
export async function seedSingleUser(db, {
  id = 'u-solo', displayName = 'Solo', timezone = 'Asia/Taipei', chatId = '9001',
} = {}) {
  await db.createUser({ id, displayName, timezone, status: 'ACTIVE' });
  await db.linkTelegram({ chatId, userId: id });
  return { id, displayName, timezone, chatId };
}

// ---------------------------------------------------------------------------
// WHOOP payload 產生器：兩人用相同 id、不同數值
// ---------------------------------------------------------------------------
export const mkSleep = (v, { id = SHARED.sleepId, nap = false } = {}) => ({
  id, v1_id: 1, user_id: 999, start: SHARED.sleepStart, end: SHARED.sleepEnd,
  nap, score_state: 'SCORED', timezone_offset: '+08:00',
  score: {
    respiratory_rate: v, sleep_performance_percentage: v,
    sleep_consistency_percentage: v, sleep_efficiency_percentage: v,
    stage_summary: {
      total_light_sleep_time_milli: v * 100_000,
      total_slow_wave_sleep_time_milli: v * 10_000,
      total_rem_sleep_time_milli: v * 10_000,
      total_awake_time_milli: 0, total_no_data_time_milli: 0,
      total_in_bed_time_milli: v * 120_000,
      disturbance_count: v, sleep_cycle_count: 4,
    },
    sleep_needed: {
      baseline_milli: 28_800_000, need_from_sleep_debt_milli: v * 1000,
      need_from_recent_strain_milli: 0, need_from_recent_nap_milli: 0,
    },
  },
});

export const mkRecovery = (v, { sleepId = SHARED.sleepId, calibrating = false } = {}) => ({
  sleep_id: sleepId, cycle_id: SHARED.cycleId, user_id: 999, score_state: 'SCORED',
  score: {
    recovery_score: v, hrv_rmssd_milli: v, resting_heart_rate: v,
    spo2_percentage: null, skin_temp_celsius: null, user_calibrating: calibrating,
  },
});

export const mkCycle = (v, { id = SHARED.cycleId } = {}) => ({
  id, user_id: 999, start: SHARED.sleepStart, end: SHARED.sleepEnd,
  score_state: 'SCORED',
  score: { strain: v, kilojoule: v * 100, average_heart_rate: v, max_heart_rate: v * 2 },
});

export const mkWorkout = (v, { id = SHARED.workoutId } = {}) => ({
  id, v1_id: 1, user_id: 999, start: SHARED.sleepStart, end: SHARED.sleepEnd,
  sport_name: 'running', score_state: 'SCORED',
  score: { strain: v, average_heart_rate: v, zone_duration: {} },
});

/** 把一整套（相同 id、不同值）健康資料寫給某個使用者。 */
export async function seedHealthData(db, user, v) {
  await db.upsertSleeps(user.id, [mkSleep(v)], { timezone: user.timezone });
  await db.upsertRecoveries(user.id, [mkRecovery(v)]);
  await db.upsertCycles(user.id, [mkCycle(v)]);
  await db.upsertWorkouts(user.id, [mkWorkout(v)], { timezone: user.timezone });
  await db.upsertBodyMeasurement(user.id, {
    height_meter: 1.7, weight_kilogram: v, max_heart_rate: 190,
  });
}
