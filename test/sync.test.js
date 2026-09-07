/**
 * 長期同步（backfill + incremental）。
 *
 * 用真的 SQLite 檔 + 假的 WHOOP client：
 *  - upsert 冪等、重新評分會覆蓋
 *  - backfill 分 chunk、可 resume
 *  - incremental 重疊
 *  - scope 不足不算故障、不會拋錯
 *  - 節流
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createDb } from '../src/db.js';
import { createSync } from '../src/sync.js';
import { WhoopApiError } from '../src/whoop.js';
import { WHOOP_SYNC } from '../src/config.js';

const TZ = 'Asia/Taipei';
const DAY = 86_400_000;
const NOW = new Date('2026-09-01T00:00:00.000Z');

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whoop-sync-'));
  return {
    url: `file:${path.join(dir, 'sync.db')}`,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

/** 造 N 天的假 WHOOP 資料，每天一筆，往回排。 */
function makeApiData({ days = 400, now = NOW } = {}) {
  const sleeps = [];
  const recoveries = [];
  const cycles = [];
  const workouts = [];
  for (let i = 0; i < days; i++) {
    const end = new Date(now.getTime() - i * DAY - 3_600_000);
    const id = `sleep-${i}`;
    sleeps.push({
      id,
      user_id: 1,
      start: new Date(end.getTime() - 7 * 3_600_000).toISOString(),
      end: end.toISOString(),
      timezone_offset: '+08:00',
      nap: false,
      score_state: 'SCORED',
      created_at: end.toISOString(),
      updated_at: end.toISOString(),
      score: {
        stage_summary: {
          total_in_bed_time_milli: 7 * 3_600_000,
          total_awake_time_milli: 20 * 60_000,
          total_no_data_time_milli: 0,
          total_light_sleep_time_milli: 4 * 3_600_000,
          total_slow_wave_sleep_time_milli: 1.5 * 3_600_000,
          total_rem_sleep_time_milli: 1.5 * 3_600_000,
          sleep_cycle_count: 5,
          disturbance_count: 10,
        },
        sleep_needed: {
          baseline_milli: 8 * 3_600_000,
          need_from_sleep_debt_milli: 10 * 60_000,
          need_from_recent_strain_milli: 5 * 60_000,
          need_from_recent_nap_milli: 0,
        },
        respiratory_rate: 15.1,
        sleep_performance_percentage: 90,
        sleep_consistency_percentage: 78,
        sleep_efficiency_percentage: 92,
      },
    });
    recoveries.push({
      cycle_id: 1000 + i,
      sleep_id: id,
      user_id: 1,
      score_state: 'SCORED',
      created_at: end.toISOString(),
      updated_at: end.toISOString(),
      score: {
        user_calibrating: false,
        recovery_score: 65,
        resting_heart_rate: 51,
        hrv_rmssd_milli: 55,
        spo2_percentage: 96.5,
        skin_temp_celsius: 33.6,
      },
    });
    cycles.push({
      id: 1000 + i,
      user_id: 1,
      start: new Date(end.getTime() - DAY).toISOString(),
      end: end.toISOString(),
      timezone_offset: '+08:00',
      score_state: 'SCORED',
      score: { strain: 12.8, kilojoule: 9000, average_heart_rate: 68, max_heart_rate: 165 },
    });
    // i=0 是「今天剛起床」，當天的運動還沒發生，所以從 i>=1 才有 workout
    if (i >= 1 && i % 3 === 1) {
      const wStart = new Date(end.getTime() + 8 * 3_600_000);
      workouts.push({
        id: `workout-${i}`,
        v1_id: 5000 + i,
        user_id: 1,
        start: wStart.toISOString(),
        end: new Date(wStart.getTime() + 45 * 60_000).toISOString(),
        timezone_offset: '+08:00',
        sport_name: 'running',
        sport_id: 0,
        score_state: 'SCORED',
        score: {
          strain: 9.5,
          average_heart_rate: 140,
          max_heart_rate: 175,
          kilojoule: 2000,
          percent_recorded: 100,
          distance_meter: 8000,
          altitude_gain_meter: 50,
          altitude_change_meter: 5,
          zone_durations: {
            zone_zero_milli: 60_000,
            zone_one_milli: 300_000,
            zone_two_milli: 600_000,
            zone_three_milli: 900_000,
            zone_four_milli: 600_000,
            zone_five_milli: 120_000,
          },
        },
      });
    }
  }
  return { sleeps, recoveries, cycles, workouts };
}

/** 假 whoop client：依 [from,to] 篩資料，並記錄呼叫。 */
function fakeWhoop(data, { failResource = null, failWith = null } = {}) {
  const calls = [];
  const pick = (arr, key, from, to) => arr.filter((r) => {
    const t = Date.parse(r[key]);
    return t >= Date.parse(from) && t <= Date.parse(to);
  });
  const guard = (name) => {
    if (failResource === name) throw failWith;
  };
  return {
    calls,
    sleeps: async (f, t) => { guard('sleep'); calls.push({ r: 'sleep', f, t }); return pick(data.sleeps, 'end', f, t); },
    recoveries: async (f, t) => { guard('recovery'); calls.push({ r: 'recovery', f, t }); return pick(data.recoveries, 'created_at', f, t); },
    cycles: async (f, t) => { guard('cycle'); calls.push({ r: 'cycle', f, t }); return pick(data.cycles, 'end', f, t); },
    workouts: async (f, t) => { guard('workout'); calls.push({ r: 'workout', f, t }); return pick(data.workouts, 'start', f, t); },
    bodyMeasurement: async () => {
      guard('body_measurement');
      calls.push({ r: 'body_measurement' });
      return { height_meter: 1.75, weight_kilogram: 70.5, max_heart_rate: 190 };
    },
  };
}

const U = 'u-sync-test';

async function setup({ data = makeApiData(), whoopOpts = {}, now = NOW } = {}) {
  const { url, cleanup } = tempDb();
  const db = createDb({ url });
  await db.migrate();
  await db.createUser({ id: U, displayName: 'SyncTest', timezone: TZ });
  const whoop = fakeWhoop(data, whoopOpts);
  const sync = createSync({ db, whoop, userId: U, timezone: TZ, now });
  return { db, whoop, sync, cleanup, now, userId: U };
}

const count = async (db, table) => Number(
  (await db.raw.execute(`SELECT COUNT(*) AS c FROM ${table}`)).rows[0].c,
);

// ---------------------------------------------------------------------------

test('sync: 增量同步寫入資料，欄位對得上官方 schema', async () => {
  const { db, sync, cleanup } = await setup();
  try {
    await sync.incremental('sleep');
    const rs = await db.raw.execute("SELECT * FROM whoop_sleeps WHERE id = 'sleep-0'");
    const row = rs.rows[0];
    assert.ok(row, '應該寫進去了');
    assert.equal(row.nap, 0);
    assert.equal(row.score_state, 'SCORED');
    assert.equal(Number(row.in_bed_milli), 7 * 3_600_000, 'total_in_bed_time_milli 要保存');
    assert.equal(Number(row.awake_milli), 20 * 60_000, 'awake 要保存');
    assert.equal(Number(row.sleep_cycle_count), 5);
    assert.equal(Number(row.sleep_need_baseline_milli), 8 * 3_600_000);
    assert.equal(Number(row.sleep_need_recent_strain_milli), 5 * 60_000);
    assert.ok(row.start_at, '★ bedtime：sleep.start 必須保存');
    assert.equal(row.timezone_offset, '+08:00', '★ timezone_offset 必須保存');
    // 總時長 = light + sws + rem（不含 awake）
    assert.equal(Number(row.total_sleep_milli), 7 * 3_600_000);
    assert.ok(row.raw_json && JSON.parse(row.raw_json).id === 'sleep-0', 'raw_json 要保存');
    assert.ok(row.health_date && /^\d{4}-\d{2}-\d{2}$/.test(row.health_date));
  } finally { db.close(); cleanup(); }
});

test('sync: workout 欄位完全依官方 v2 schema（含 zone_durations）', async () => {
  const { db, sync, cleanup } = await setup();
  try {
    await sync.incremental('workout');
    const rs = await db.raw.execute("SELECT * FROM whoop_workouts WHERE id = 'workout-1'");
    const w = rs.rows[0];
    assert.ok(w);
    assert.equal(w.sport_name, 'running');
    assert.equal(Number(w.strain), 9.5);
    assert.equal(Number(w.percent_recorded), 100);
    assert.equal(Number(w.distance_meter), 8000);
    assert.equal(Number(w.altitude_gain_meter), 50);
    assert.equal(Number(w.zone_four_milli), 600_000);
    assert.equal(Number(w.zone_five_milli), 120_000);
    assert.ok(w.raw_json);
  } finally { db.close(); cleanup(); }
});

test('sync: body measurement 是單一物件（不分頁），並保存歷史版本', async () => {
  const { db, sync, cleanup } = await setup();
  try {
    const r = await sync.syncResource('body_measurement');
    assert.equal(r.mode, 'point_in_time');
    const bm = await db.getLatestBodyMeasurement(U);
    assert.equal(Number(bm.weight_kilogram), 70.5);
    assert.equal(Number(bm.max_heart_rate), 190);
    const state = await db.getSyncState(U, 'body_measurement');
    assert.equal(state.backfillComplete, true, 'point-in-time 沒有 backfill 概念');
  } finally { db.close(); cleanup(); }
});

test('sync: upsert 冪等 —— 同步兩次不會產生重複列', async () => {
  const { db, sync, cleanup } = await setup();
  try {
    await sync.incremental('sleep');
    const first = await count(db, 'whoop_sleeps');
    await sync.incremental('sleep');
    assert.equal(await count(db, 'whoop_sleeps'), first, '重跑不可以長出新列');
    assert.ok(first > 0);
  } finally { db.close(); cleanup(); }
});

test('sync: 重新評分（PENDING_SCORE → SCORED）會覆蓋舊列', async () => {
  const data = makeApiData({ days: 3 });
  // 先讓最新那筆是未評分
  data.sleeps[0].score_state = 'PENDING_SCORE';
  data.sleeps[0].score = null;

  const { db, sync, cleanup } = await setup({ data });
  try {
    await sync.incremental('sleep');
    let row = (await db.raw.execute("SELECT * FROM whoop_sleeps WHERE id='sleep-0'")).rows[0];
    assert.equal(row.score_state, 'PENDING_SCORE');
    assert.equal(row.total_sleep_milli, null, '未評分時沒有數值');

    // WHOOP 稍後評分完成 → 重抓同一筆
    data.sleeps[0].score_state = 'SCORED';
    data.sleeps[0].score = makeApiData({ days: 1 }).sleeps[0].score;
    await sync.incremental('sleep');

    row = (await db.raw.execute("SELECT * FROM whoop_sleeps WHERE id='sleep-0'")).rows[0];
    assert.equal(row.score_state, 'SCORED', '★ 重新評分必須覆蓋');
    assert.equal(Number(row.total_sleep_milli), 7 * 3_600_000);
    assert.equal(await count(db, 'whoop_sleeps'), 3, '仍然只有 3 列');
  } finally { db.close(); cleanup(); }
});

test('sync: recovery 的 health_date 由對應的 sleep 補上（順序顛倒也能自癒）', async () => {
  const { db, sync, cleanup } = await setup();
  try {
    // 故意先寫 recovery（此時還沒有任何 sleep）
    await sync.incremental('recovery');
    let row = (await db.raw.execute("SELECT * FROM whoop_recoveries WHERE sleep_id='sleep-0'")).rows[0];
    assert.equal(row.health_date, null, '還沒有對應的 sleep → 先留 null');

    await sync.incremental('sleep');
    await db.relinkRecoveryDates(U);

    row = (await db.raw.execute("SELECT * FROM whoop_recoveries WHERE sleep_id='sleep-0'")).rows[0];
    assert.ok(row.health_date, '★ sleep 進來之後必須自動補上 health_date');
    const s = (await db.raw.execute("SELECT * FROM whoop_sleeps WHERE id='sleep-0'")).rows[0];
    assert.equal(row.health_date, s.health_date, '必須與 sleep 完全一致');
  } finally { db.close(); cleanup(); }
});

test('sync: backfill 分 chunk 推進，每個 chunk 都存檔（可 resume）', async () => {
  const { db, sync, cleanup } = await setup();
  try {
    const r1 = await sync.backfill('sleep');
    assert.equal(r1.chunks, WHOOP_SYNC.MAX_CHUNKS_PER_RUN, '一次只推進固定數量的 chunk');
    assert.equal(r1.complete, false);

    const s1 = await db.getSyncState(U, 'sleep');
    assert.ok(s1.backfillCursor, 'cursor 必須存檔');
    const cursor1 = Date.parse(s1.backfillCursor);
    const expected = NOW.getTime()
      - WHOOP_SYNC.MAX_CHUNKS_PER_RUN * WHOOP_SYNC.BACKFILL_CHUNK_DAYS * DAY;
    assert.equal(cursor1, expected, 'cursor 要正好往回推 chunks × chunk_days');

    // 第二次執行：從斷點繼續，不會從頭再來
    const r2 = await sync.backfill('sleep');
    const s2 = await db.getSyncState(U, 'sleep');
    assert.ok(Date.parse(s2.backfillCursor) < cursor1, '★ 必須從斷點繼續往回');
    assert.equal(r2.chunks, WHOOP_SYNC.MAX_CHUNKS_PER_RUN);
  } finally { db.close(); cleanup(); }
});

test('sync: backfill 跑完整段歷史後標記 complete，之後不再重跑', async () => {
  const { db, sync, cleanup } = await setup();
  try {
    let guard = 0;
    let r;
    do {
      r = await sync.backfill('sleep');
      guard += 1;
    } while (!r.complete && guard < 50);

    assert.ok(r.complete, 'backfill 應該要能跑完');
    const state = await db.getSyncState(U, 'sleep');
    assert.equal(state.backfillComplete, true);

    // 涵蓋到設定的天數
    const earliest = Date.parse(state.backfillCursor);
    assert.ok(
      earliest <= NOW.getTime() - WHOOP_SYNC.BACKFILL_DAYS * DAY,
      '要一路抓到 BACKFILL_DAYS 之前',
    );

    const again = await sync.backfill('sleep');
    assert.equal(again.status, 'already_complete', '跑完就不再重跑');
  } finally { db.close(); cleanup(); }
});

test('sync: backfill 中途失敗 → cursor 停在最後一個成功的 chunk，可續傳', async () => {
  const data = makeApiData();
  const { url, cleanup } = tempDb();
  const db = createDb({ url });
  try {
    await db.migrate();
    await db.createUser({ id: U, displayName: 'SyncTest', timezone: TZ });
    let failAfter = 2;
    const whoop = {
      ...fakeWhoop(data),
      sleeps: async (f, t) => {
        if (failAfter-- <= 0) throw new Error('模擬網路中斷');
        return data.sleeps.filter((r) => {
          const x = Date.parse(r.end);
          return x >= Date.parse(f) && x <= Date.parse(t);
        });
      },
    };
    const sync = createSync({ db, whoop, userId: U, timezone: TZ, now: NOW });

    await assert.rejects(() => sync.backfill('sleep'), /模擬網路中斷/);

    const state = await db.getSyncState(U, 'sleep');
    assert.ok(state.backfillCursor, '★ 已成功的 chunk 必須留下 cursor');
    assert.equal(
      Date.parse(state.backfillCursor),
      NOW.getTime() - 2 * WHOOP_SYNC.BACKFILL_CHUNK_DAYS * DAY,
      '正好停在第 2 個 chunk（第 3 個失敗）',
    );
    assert.equal(state.backfillComplete, false);
  } finally { db.close(); cleanup(); }
});

test('sync: 增量同步的時間窗有刻意重疊（WHOOP 會事後改資料）', async () => {
  const { db, whoop, sync, cleanup } = await setup();
  try {
    await sync.incremental('sleep');
    const call = whoop.calls.find((c) => c.r === 'sleep');
    const spanDays = (Date.parse(call.t) - Date.parse(call.f)) / DAY;
    assert.equal(spanDays, WHOOP_SYNC.INCREMENTAL_OVERLAP_DAYS);
    assert.ok(spanDays >= 3, '重疊至少要 3 天');
  } finally { db.close(); cleanup(); }
});

test('sync: scope 不足（403）不算故障、不拋錯，且明確標記', async () => {
  const { db, sync, cleanup } = await setup({
    whoopOpts: { failResource: 'workout', failWith: new WhoopApiError('WHOOP 403 forbidden', 403) },
  });
  try {
    const results = await sync.syncAll({ force: true });
    const workout = results.find((r) => r.resource === 'workout');
    assert.equal(workout.status, 'scope_missing', '★ 缺 scope 要被辨識出來');

    const state = await db.getSyncState(U, 'workout');
    assert.equal(state.lastError, 'scope_missing');

    // 其他 resource 完全不受影響
    assert.equal(results.find((r) => r.resource === 'sleep').status, 'ok');
    assert.ok(await count(db, 'whoop_sleeps') > 0);
  } finally { db.close(); cleanup(); }
});

test('sync: 任何 resource 失敗都不會讓 syncAll 拋錯（簡報優先）', async () => {
  const { db, sync, cleanup } = await setup({
    whoopOpts: { failResource: 'cycle', failWith: new Error('Turso 爆炸') },
  });
  try {
    const results = await sync.syncAll({ force: true });
    assert.equal(results.find((r) => r.resource === 'cycle').status, 'failed');
    assert.equal(results.find((r) => r.resource === 'sleep').status, 'ok');
    const state = await db.getSyncState(U, 'cycle');
    assert.match(String(state.lastError), /Turso 爆炸/);
  } finally { db.close(); cleanup(); }
});

test('sync: 節流 —— 剛同步過就不重複打 API，但 backfill 未完成時仍會繼續', async () => {
  const { db, whoop, sync, cleanup } = await setup();
  try {
    await sync.syncAll({ force: true });
    const afterFirst = whoop.calls.length;

    // backfill 尚未完成 → 即使剛同步過也要繼續推進
    await sync.syncAll({ force: false });
    assert.ok(whoop.calls.length > afterFirst, 'backfill 未完成時不可被節流擋掉');

    // 把所有 resource 標成 backfill 完成 + 剛剛才成功
    for (const r of WHOOP_SYNC.RESOURCES) {
      await db.saveSyncState(U, r, {
        backfillComplete: true,
        lastSuccessAt: NOW.toISOString(),
      }, { now: NOW });
    }
    const before = whoop.calls.length;
    const results = await sync.syncAll({ force: false });
    assert.equal(whoop.calls.length, before, '★ 節流時完全不打 API');
    assert.ok(results.every((r) => r.status === 'throttled'));
  } finally { db.close(); cleanup(); }
});

test('sync: coverage() 回報實際涵蓋範圍', async () => {
  const { db, sync, cleanup } = await setup();
  try {
    await sync.incremental('sleep');
    await sync.incremental('recovery');
    const cov = await db.coverage(U);
    assert.ok(Number(cov.main_sleeps) > 0);
    assert.ok(cov.first_date && cov.last_date);
    assert.ok(cov.first_date <= cov.last_date);
    assert.equal(Number(cov.unscored_sleeps), 0);
  } finally { db.close(); cleanup(); }
});
