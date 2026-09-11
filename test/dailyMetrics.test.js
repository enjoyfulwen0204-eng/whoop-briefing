/**
 * daily_metrics 正規化層。
 *
 * 最重要的一條：它必須**沿用**既有的 health_date / 同日多筆 / 昨日 cycle 口徑，
 * 不可以自己長出第二套時間軸。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createDb } from '../src/db.js';

const U = 'u-dm-test';
import { createSync } from '../src/sync.js';
import { computeDailyMetrics, loadDailyMetrics, seriesOf } from '../src/dailyMetrics.js';
import { buildObservations } from '../src/analyze.js';
import { localDate } from '../src/time.js';
import { makeDataset } from './fixtures.js';

const TZ = 'Asia/Taipei';
const DAY = 86_400_000;

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whoop-dm-'));
  return {
    url: `file:${path.join(dir, 'dm.db')}`,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

/** 把 fixtures 的假 WHOOP 資料灌進 DB，回傳 db。 */
async function seed({ days = 20, now = new Date('2026-09-01T00:00:00Z'), extra = {} } = {}) {
  const { url, cleanup } = tempDb();
  const db = createDb({ url });
  await db.migrate();
  await db.createUser({ id: U, displayName: 'DM' });
  const ds = makeDataset({ days, now, ...extra });
  const workouts = [];
  // 在每天的 cycle 窗內放一筆運動
  for (let i = 1; i < Math.min(days, 10); i++) {
    const wStart = new Date(now.getTime() - i * DAY - 6 * 3_600_000);
    workouts.push({
      id: `w-${i}`,
      start: wStart.toISOString(),
      end: new Date(wStart.getTime() + 40 * 60_000).toISOString(),
      timezone_offset: '+08:00',
      sport_name: i % 2 ? 'running' : 'weightlifting',
      score_state: 'SCORED',
      score: {
        strain: 8.5, average_heart_rate: 140, max_heart_rate: 170, kilojoule: 1500,
        percent_recorded: 100, distance_meter: 6000, altitude_gain_meter: 20,
        zone_durations: {
          zone_zero_milli: 0, zone_one_milli: 300_000, zone_two_milli: 600_000,
          zone_three_milli: 600_000, zone_four_milli: 480_000, zone_five_milli: 120_000,
        },
      },
    });
  }
  const whoop = {
    sleeps: async () => ds.sleeps,
    recoveries: async () => ds.recoveries,
    cycles: async () => ds.cycles,
    workouts: async () => workouts,
    bodyMeasurement: async () => ({ height_meter: 1.75, weight_kilogram: 70.5, max_heart_rate: 190 }),
  };
  const sync = createSync({ db, whoop, userId: U, timezone: TZ, now });
  for (const r of ['sleep', 'recovery', 'cycle', 'workout', 'body_measurement']) {
    await sync.syncResource(r);
  }
  return { db, cleanup, ds, now, workouts };
}

// ---------------------------------------------------------------------------

test('★ daily_metrics 的 health_date 與 buildObservations 完全一致', async () => {
  const { db, cleanup, ds, now } = await seed({ days: 20 });
  try {
    const from = localDate(new Date(now.getTime() - 25 * DAY), TZ);
    const to = localDate(now, TZ);
    const rows = await loadDailyMetrics({ db, userId: U, timezone: TZ, from, to });

    const expected = buildObservations({ ...ds, timezone: TZ })
      .map((o) => o.healthDate)
      .filter((d) => d >= from && d <= to)
      .sort();
    const actual = rows.map((r) => r.health_date).sort();

    assert.deepEqual(actual, expected, 'health_date 必須逐字相同，不可自成一套');
    assert.equal(new Set(actual).size, actual.length, '一個 health_date 只能一列');
  } finally { db.close(); cleanup(); }
});

test('★ bedtime：sleep.start 有被保存並換算成當地時間', async () => {
  const { db, cleanup, now } = await seed({ days: 10 });
  try {
    const rows = await loadDailyMetrics({
      db, userId: U, timezone: TZ,
      from: localDate(new Date(now.getTime() - 12 * DAY), TZ),
      to: localDate(now, TZ),
    });
    const r = rows[0];
    assert.ok(r.sleep_start, 'sleep_start 必須有值（以前完全沒保存）');
    assert.match(r.bedtime_local, /^\d{2}:\d{2}$/, 'bedtime_local 要是 HH:MM');
    assert.match(r.wake_time_local, /^\d{2}:\d{2}$/);
    assert.equal(r.timezone_offset, '+08:00');
    assert.ok(Date.parse(r.sleep_start) < Date.parse(r.sleep_end), '入睡要早於起床');
  } finally { db.close(); cleanup(); }
});

test('之前浪費掉的睡眠欄位現在都在 daily_metrics 裡', async () => {
  const { db, cleanup, now } = await seed({ days: 10 });
  try {
    const rows = await loadDailyMetrics({
      db, userId: U, timezone: TZ,
      from: localDate(new Date(now.getTime() - 12 * DAY), TZ),
      to: localDate(now, TZ),
    });
    const r = rows[0];
    assert.ok(r.awake_time > 0, 'total_awake_time_milli');
    assert.ok(r.in_bed_time > 0, 'total_in_bed_time_milli');
    assert.ok(r.sleep_cycle_count > 0, 'sleep_cycle_count');
    assert.ok(r.sleep_need_baseline > 0, 'sleep_needed.baseline_milli');
    assert.ok(r.light_sleep > 0);
    // 睡眠總時長仍然是 light+deep+rem（不含 awake）
    assert.equal(r.sleep_total, r.light_sleep + r.deep_sleep + r.rem_sleep);
    assert.notEqual(r.sleep_total, r.in_bed_time);
  } finally { db.close(); cleanup(); }
});

test('★ 前一天的 strain / 心率 / 熱量 / 運動全部取自同一個 cycle 窗', async () => {
  const { db, cleanup, now } = await seed({ days: 15 });
  try {
    const rows = await loadDailyMetrics({
      db, userId: U, timezone: TZ,
      from: localDate(new Date(now.getTime() - 18 * DAY), TZ),
      to: localDate(now, TZ),
    });
    const withCycle = rows.filter((r) => r.has_previous_cycle);
    assert.ok(withCycle.length > 5, '應該多數天都找得到昨日 cycle');

    const r = withCycle[1];
    assert.ok(r.previous_day_strain > 0);
    assert.ok(r.cycle_avg_hr > 0, '全日平均心率（以前完全沒用）');
    assert.ok(r.cycle_max_hr > 0, '全日最高心率');
    assert.ok(r.kilojoule > 0, '熱量');
    assert.ok(r.cycle_id, '要記錄用了哪一個 cycle');
    assert.equal(typeof r.workout_count, 'number', '運動彙總掛在同一個窗');
  } finally { db.close(); cleanup(); }
});

test('運動彙總：zone 分組與推導的肌力分鐘', async () => {
  const { db, cleanup, now } = await seed({ days: 15 });
  try {
    const rows = await loadDailyMetrics({
      db, userId: U, timezone: TZ,
      from: localDate(new Date(now.getTime() - 18 * DAY), TZ),
      to: localDate(now, TZ),
    });
    const withWorkout = rows.find((r) => r.workout_count > 0);
    assert.ok(withWorkout, '應該有幾天有運動');
    assert.equal(withWorkout.zone1_3_minutes, 25, '(300+600+600)k ms = 25 分');
    assert.equal(withWorkout.zone4_5_minutes, 10, '(480+120)k ms = 10 分');
    assert.ok(withWorkout.workout_strain_total > 0);
    assert.ok(withWorkout.workout_duration_minutes > 0);
    assert.ok(Array.isArray(withWorkout.workout_sports));
    assert.equal(typeof withWorkout.strength_minutes_derived, 'number');
  } finally { db.close(); cleanup(); }
});

test('★ 官方 API 沒有的欄位永遠是 null，絕不假造', async () => {
  const { db, cleanup, now } = await seed({ days: 10 });
  try {
    const rows = await loadDailyMetrics({
      db, userId: U, timezone: TZ,
      from: localDate(new Date(now.getTime() - 12 * DAY), TZ),
      to: localDate(now, TZ),
    });
    for (const r of rows) {
      assert.equal(r.steps, null, 'steps：API 沒有，必須 null');
      assert.equal(r.vo2max, null, 'VO2max：API 沒有，必須 null');
      assert.equal(r.lean_body_mass, null, 'lean body mass：API 沒有，必須 null');
    }
  } finally { db.close(); cleanup(); }
});

test('body measurement 的體重 / 最大心率會附在每一列上', async () => {
  const { db, cleanup, now } = await seed({ days: 10 });
  try {
    const rows = await loadDailyMetrics({
      db, userId: U, timezone: TZ,
      from: localDate(new Date(now.getTime() - 12 * DAY), TZ),
      to: localDate(now, TZ),
    });
    assert.equal(rows[0].weight, 70.5);
    assert.equal(rows[0].body_max_hr, 190);
  } finally { db.close(); cleanup(); }
});

test('★ 缺一個 optional 欄位不會讓整天失效', async () => {
  const { db, cleanup, now } = await seed({ days: 10, extra: { omitFields: ['spo2', 'skin_temp'] } });
  try {
    const rows = await loadDailyMetrics({
      db, userId: U, timezone: TZ,
      from: localDate(new Date(now.getTime() - 12 * DAY), TZ),
      to: localDate(now, TZ),
    });
    assert.ok(rows.length > 5, '天數不可以因為缺 SpO2 而變少');
    for (const r of rows) {
      assert.equal(r.spo2, null);
      assert.equal(r.skin_temp, null);
      assert.ok(r.hrv !== null, '其他指標照常');
      assert.equal(r.has_sleep, true);
    }
  } finally { db.close(); cleanup(); }
});

test('★★★ 校正期：事實值保留，但不進統計（兩件事分開）', () => {
  // 以前這裡是把值抹成 null。那個做法把兩件不同的事綁在一起：
  //
  //   事實：WHOOP 今天真的算出了 HRV / recovery
  //   分析資格：這些值還不能當 baseline / 趨勢的樣本
  //
  // 抹成 null 等於連事實都否認，於是 Q&A 回「目前拿不到 HRV」，而使用者
  // 手機上明明看得到。現在事實留在列上，排除改在 seriesOf（分析層唯一入口）。
  const ds = makeDataset({ days: 5, calibratingDays: [0] });
  const rows = computeDailyMetrics({
    sleepRows: ds.sleeps.filter((s) => !s.nap).map((s) => ({
      id: s.id, nap: 0, health_date: localDate(s.end, TZ), raw_json: JSON.stringify(s),
    })),
    recoveryRows: ds.recoveries.map((r) => ({
      sleep_id: r.sleep_id, raw_json: JSON.stringify(r),
    })),
    cycleRows: [], workoutRows: [], timezone: TZ,
  });
  const today = rows[0];
  assert.equal(today.calibrating, true);

  // 1) 事實照樣在（Q&A 要用）
  assert.ok(Number.isFinite(today.hrv), '★ 校正期的 HRV 事實值必須保留');
  assert.ok(Number.isFinite(today.recovery), '★ 校正期的 recovery 事實值必須保留');
  assert.ok(today.sleep_total > 0, '睡眠資料與校正期無關，照常');

  // 2) 但**不可以**進統計序列
  for (const key of ['hrv', 'recovery', 'rhr']) {
    const series = seriesOf(rows, key);
    assert.ok(!series.some((p) => p.date === today.health_date),
      `★ 校正期那一天不可以出現在 ${key} 的統計序列裡`);
  }
  // 3) 非 recovery 衍生的指標不受影響
  const sleepSeries = seriesOf(rows, 'sleep_total');
  assert.ok(sleepSeries.some((p) => p.date === today.health_date),
    '★ 睡眠不是 recovery 衍生，校正期不該排除它');
});

test('★★★ 校正期排除只作用在 recovery 衍生指標上', () => {
  const ds = makeDataset({ days: 5, calibratingDays: [0, 1] });
  const rows = computeDailyMetrics({
    sleepRows: ds.sleeps.filter((s) => !s.nap).map((s) => ({
      id: s.id, nap: 0, health_date: localDate(s.end, TZ), raw_json: JSON.stringify(s),
    })),
    recoveryRows: ds.recoveries.map((r) => ({
      sleep_id: r.sleep_id, raw_json: JSON.stringify(r),
    })),
    cycleRows: [], workoutRows: [], timezone: TZ,
  });
  const calibratingDates = rows.filter((r) => r.calibrating).map((r) => r.health_date);
  assert.equal(calibratingDates.length, 2);
  for (const key of ['hrv', 'recovery', 'rhr', 'spo2', 'skin_temp']) {
    for (const d of calibratingDates) {
      assert.ok(!seriesOf(rows, key).some((p) => p.date === d),
        `★ ${key} 的序列不可以含校正期的 ${d}`);
    }
  }
});

test('★★★ loadDailyMetrics 預設遮蔽校正值；只有事實查詢可明確 opt in', async () => {
  const { db, cleanup, now } = await seed({ days: 2, extra: { calibratingDays: [0] } });
  try {
    const args = {
      db, userId: U, timezone: TZ,
      from: localDate(new Date(now.getTime() - 3 * DAY), TZ), to: localDate(now, TZ),
    };
    const analytical = await loadDailyMetrics(args);
    const factual = await loadDailyMetrics({ ...args, includeCalibratingFacts: true });
    const a = analytical.find((r) => r.calibrating);
    const f = factual.find((r) => r.calibrating);
    assert.equal(a.hrv, null, 'direct analytical row consumers must retain old exclusion');
    assert.ok(Number.isFinite(f.hrv), 'factual publication may opt in explicitly');
  } finally { db.close(); cleanup(); }
});

test('小睡不會污染主睡眠，但會被彙總成 nap_count / nap_total', async () => {
  const { db, cleanup, now } = await seed({ days: 15 });
  try {
    const rows = await loadDailyMetrics({
      db, userId: U, timezone: TZ,
      from: localDate(new Date(now.getTime() - 18 * DAY), TZ),
      to: localDate(now, TZ),
    });
    // 每個 health_date 只有一列（小睡不會多開一天）
    const dates = rows.map((r) => r.health_date);
    assert.equal(new Set(dates).size, dates.length);
    assert.ok(rows.some((r) => r.nap_count !== null), 'nap 欄位要存在');
    // fixtures 每 5 天插一次小睡
    const napped = rows.filter((r) => r.nap_count > 0);
    assert.ok(napped.length > 0, '應該抓得到小睡');
    assert.ok(napped[0].nap_total_milli > 0);
  } finally { db.close(); cleanup(); }
});

test('seriesOf 產出舊→新且略過 null', () => {
  const rows = [
    { health_date: '2026-08-03', hrv: 50 },
    { health_date: '2026-08-01', hrv: 55 },
    { health_date: '2026-08-02', hrv: null },
  ];
  const s = seriesOf(rows, 'hrv');
  assert.deepEqual(s, [
    { date: '2026-08-01', value: 55 },
    { date: '2026-08-03', value: 50 },
  ]);
});

test('raw_json 壞掉時退回用扁平欄位（不會整個爆掉）', () => {
  const rows = computeDailyMetrics({
    sleepRows: [{
      id: 's1', nap: 0, health_date: '2026-08-20',
      start_at: '2026-08-19T15:00:00.000Z', end_at: '2026-08-19T23:00:00.000Z',
      timezone_offset: '+08:00', score_state: 'SCORED',
      light_sleep_milli: 4 * 3_600_000, slow_wave_sleep_milli: 2 * 3_600_000,
      rem_sleep_milli: 2 * 3_600_000, respiratory_rate: 15,
      raw_json: '{ 這不是合法 JSON',
    }],
    recoveryRows: [], cycleRows: [], workoutRows: [], timezone: TZ,
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].sleep_total, 8 * 3_600_000);
  assert.equal(rows[0].respiratory_rate, 15);
});
