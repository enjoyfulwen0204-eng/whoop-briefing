/**
 * Capability 偵測。
 *
 * 這一組測試在守護一條產品紅線：
 * **能力判斷永遠來自「API 這個欄位有沒有值」，不是 membership tier。**
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  computeCapabilities, classify, getCapability, isUsable,
  STATUS, APP_ONLY_CAPABILITIES, probeCapabilities,
} from '../src/capabilities.js';
import { createDb } from '../src/db.js';
import { WhoopApiError } from '../src/whoop.js';
import { makeDataset } from './fixtures.js';

const TZ = 'Asia/Taipei';

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whoop-cap-'));
  return {
    url: `file:${path.join(dir, 'cap.db')}`,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

const byKey = (entries) => Object.fromEntries(entries.map((e) => [e.key, e]));

// ---------------------------------------------------------------------------

test('classify: 四種基本狀態', () => {
  assert.equal(classify(0, 0), STATUS.UNKNOWN, '沒樣本不下判斷');
  assert.equal(classify(10, 10), STATUS.SUPPORTED);
  assert.equal(classify(10, 4), STATUS.PARTIAL);
  assert.equal(classify(10, 0), STATUS.UNAVAILABLE);
  // 樣本太少時「全 null」不可以太早判死
  assert.equal(classify(2, 0), STATUS.UNKNOWN);
});

test('帳號有 SpO2 / 皮膚溫度 → SUPPORTED', () => {
  const ds = makeDataset({ days: 14 });
  const caps = byKey(computeCapabilities({ ...ds, workouts: [], timezone: TZ }));
  assert.equal(caps.spo2.status, STATUS.SUPPORTED);
  assert.equal(caps.skin_temp.status, STATUS.SUPPORTED);
  assert.ok(caps.spo2.nonNullCount > 0);
});

test('★ 帳號沒有 SpO2 / 皮膚溫度 → UNAVAILABLE（不是靠 membership 判斷）', () => {
  const ds = makeDataset({ days: 14, omitFields: ['spo2', 'skin_temp'] });
  const caps = byKey(computeCapabilities({ ...ds, workouts: [], timezone: TZ }));

  assert.equal(caps.spo2.status, STATUS.UNAVAILABLE);
  assert.equal(caps.spo2.nonNullCount, 0);
  assert.ok(caps.spo2.sampleCount > 0, '有樣本才能下 UNAVAILABLE');
  assert.equal(caps.skin_temp.status, STATUS.UNAVAILABLE);

  // 其他指標完全不受影響
  assert.equal(caps.hrv.status, STATUS.SUPPORTED);
  assert.equal(caps.recovery_score.status, STATUS.SUPPORTED);
});

test('間歇提供的欄位 → PARTIAL', () => {
  const ds = makeDataset({ days: 14 });
  // 讓一半的 recovery 沒有 spo2
  ds.recoveries.forEach((r, i) => {
    if (i % 2 === 0 && r.score) r.score.spo2_percentage = null;
  });
  const caps = byKey(computeCapabilities({ ...ds, workouts: [], timezone: TZ }));
  assert.equal(caps.spo2.status, STATUS.PARTIAL);
  assert.ok(caps.spo2.nonNullCount > 0 && caps.spo2.nonNullCount < caps.spo2.sampleCount);
});

test('之前被浪費的欄位現在都會被偵測到', () => {
  const ds = makeDataset({ days: 14 });
  const caps = byKey(computeCapabilities({ ...ds, workouts: [], timezone: TZ }));
  for (const key of [
    'sleep_start', 'sleep_timezone_offset', 'sleep_awake_time', 'sleep_in_bed_time',
    'sleep_cycle_count', 'sleep_need_baseline', 'sleep_need_recent_strain',
    'cycle_average_heart_rate', 'cycle_max_heart_rate', 'cycle_kilojoule',
  ]) {
    assert.ok(caps[key], `${key} 應該要被偵測`);
    assert.equal(caps[key].status, STATUS.SUPPORTED, `${key} 在假資料裡應該有值`);
  }
});

test('缺 scope → UNAUTHORIZED，而且訊息會叫人重新授權', () => {
  const ds = makeDataset({ days: 14 });
  const caps = byKey(computeCapabilities({
    ...ds, workouts: [], timezone: TZ,
    scopeErrors: [{ resource: 'workout' }, { resource: 'body_measurement' }],
  }));

  assert.equal(caps.workout.status, STATUS.UNAUTHORIZED);
  assert.equal(caps.workout_strain.status, STATUS.UNAUTHORIZED);
  assert.equal(caps.body_weight.status, STATUS.UNAUTHORIZED);
  assert.match(caps.workout.detail, /authorize/);

  // 睡眠 / 恢復完全不受影響 —— 缺 scope 不可以污染其他能力
  assert.equal(caps.hrv.status, STATUS.SUPPORTED);
  assert.equal(caps.sleep_total.status, STATUS.SUPPORTED);
});

test('★ API 根本沒有的東西標成 APP_ONLY，絕不假裝拿得到', () => {
  const ds = makeDataset({ days: 14 });
  const caps = byKey(computeCapabilities({ ...ds, workouts: [], timezone: TZ }));

  for (const { key } of APP_ONLY_CAPABILITIES) {
    assert.equal(caps[key].status, STATUS.APP_ONLY, `${key} 必須標成 APP_ONLY`);
    assert.equal(caps[key].latestValue, null, `${key} 不可以有假值`);
    assert.ok(caps[key].detail, `${key} 要說明為什麼拿不到`);
  }
  // 幾個一定要在清單裡的
  for (const key of ['steps', 'vo2_max', 'whoop_age', 'healthspan', 'stress_score', 'lean_body_mass']) {
    assert.ok(caps[key], `${key} 必須被明確標記`);
  }
});

test('workout 有資料 → SUPPORTED，含 zone durations', () => {
  const ds = makeDataset({ days: 14 });
  const workouts = [{
    id: 'w1', sport_name: 'running', score_state: 'SCORED',
    start: new Date(ds.now.getTime() - 3_600_000).toISOString(),
    end: ds.now.toISOString(),
    score: {
      strain: 9.5, average_heart_rate: 140, max_heart_rate: 175, kilojoule: 2000,
      percent_recorded: 100, distance_meter: 8000, altitude_gain_meter: 50,
      zone_durations: { zone_two_milli: 600_000 },
    },
  }];
  const caps = byKey(computeCapabilities({ ...ds, workouts, timezone: TZ }));
  assert.equal(caps.workout.status, STATUS.SUPPORTED);
  assert.equal(caps.workout_zone_durations.status, STATUS.SUPPORTED);
  assert.equal(caps.workout_distance.status, STATUS.SUPPORTED);
  assert.equal(caps.workout_sport_name.latestValue, 1);
});

test('完全沒有 workout 樣本 → UNKNOWN（不可以說「沒有」）', () => {
  const ds = makeDataset({ days: 14 });
  const caps = byKey(computeCapabilities({ ...ds, workouts: [], timezone: TZ }));
  assert.equal(caps.workout.status, STATUS.UNKNOWN, '沒運動 ≠ 沒有運動能力');
  assert.match(caps.workout.detail, /無法判定/);
});

test('body measurement 拿得到 → 三個欄位都 SUPPORTED', () => {
  const ds = makeDataset({ days: 14 });
  const caps = byKey(computeCapabilities({
    ...ds, workouts: [], timezone: TZ,
    bodyMeasurement: { height_meter: 1.75, weight_kilogram: 70.5, max_heart_rate: 190 },
  }));
  assert.equal(caps.body_height.status, STATUS.SUPPORTED);
  assert.equal(caps.body_weight.latestValue, 70.5);
  assert.equal(caps.body_max_heart_rate.latestValue, 190);
});

test('getCapability / isUsable：沒 probe 過一律 UNKNOWN，不猜', () => {
  const caps = {
    spo2: { status: STATUS.UNAVAILABLE },
    hrv: { status: STATUS.SUPPORTED },
    skin_temp: { status: STATUS.PARTIAL },
  };
  assert.equal(getCapability(caps, 'hrv'), STATUS.SUPPORTED);
  assert.equal(getCapability(caps, 'spo2'), STATUS.UNAVAILABLE);
  assert.equal(getCapability(caps, '沒probe過'), STATUS.UNKNOWN);
  assert.equal(getCapability(null, 'hrv'), STATUS.UNKNOWN);

  assert.equal(isUsable(caps, 'hrv'), true);
  assert.equal(isUsable(caps, 'skin_temp'), true, 'PARTIAL 仍然可用（但要記得 n）');
  assert.equal(isUsable(caps, 'spo2'), false);
  assert.equal(isUsable(caps, '沒probe過'), false);
});

test('probe 結果寫進 Turso，可以再讀回來', async () => {
  const { url, cleanup } = tempDb();
  const db = createDb({ url });
  try {
    await db.migrate();
    const ds = makeDataset({ days: 14, omitFields: ['spo2'] });
    const whoop = {
      sleeps: async () => ds.sleeps,
      recoveries: async () => ds.recoveries,
      cycles: async () => ds.cycles,
      workouts: async () => { throw new WhoopApiError('403 forbidden', 403); },
      bodyMeasurement: async () => ({ height_meter: 1.75, weight_kilogram: 70, max_heart_rate: 190 }),
    };

    const { scopeErrors } = await probeCapabilities({ db, whoop, timezone: TZ, days: 14 });
    assert.deepEqual(scopeErrors, [{ resource: 'workout' }], 'workout 缺 scope 要被記錄');

    const saved = await db.getCapabilities();
    assert.equal(saved.hrv.status, STATUS.SUPPORTED);
    assert.equal(saved.spo2.status, STATUS.UNAVAILABLE);
    assert.equal(saved.workout_strain.status, STATUS.UNAUTHORIZED);
    assert.equal(saved.steps.status, STATUS.APP_ONLY);
    assert.ok(saved.hrv.lastProbedAt, 'last_probed_at 要寫入');
    assert.ok(saved.hrv.firstSeenAt, '有值的欄位要記 first_seen_at');
    assert.equal(saved.spo2.firstSeenAt, null, '從沒看過的欄位不可以有 first_seen_at');

    // 再 probe 一次：first_seen_at 不可以被覆蓋掉
    const firstSeen = saved.hrv.firstSeenAt;
    await probeCapabilities({ db, whoop, timezone: TZ, days: 14 });
    const again = await db.getCapabilities();
    assert.equal(again.hrv.firstSeenAt, firstSeen, 'first_seen_at 必須維持第一次的值');
  } finally { db.close(); cleanup(); }
});

test('probe 不會因為缺 scope 而整個失敗', async () => {
  const { url, cleanup } = tempDb();
  const db = createDb({ url });
  try {
    await db.migrate();
    const ds = makeDataset({ days: 10 });
    const whoop = {
      sleeps: async () => ds.sleeps,
      recoveries: async () => ds.recoveries,
      cycles: async () => ds.cycles,
      workouts: async () => { throw new WhoopApiError('401', 401); },
      bodyMeasurement: async () => { throw new WhoopApiError('403', 403); },
    };
    const { entries } = await probeCapabilities({ db, whoop, timezone: TZ, days: 10 });
    assert.ok(entries.length > 20, '仍然要產出完整清單');
    assert.equal(byKey(entries).hrv.status, STATUS.SUPPORTED);
  } finally { db.close(); cleanup(); }
});
