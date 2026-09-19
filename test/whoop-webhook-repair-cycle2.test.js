/**
 * V1.2 Phase 1 — 修復週期 2（P1-R02-RC2）。
 *
 * 缺陷：排程同步的「讀墓碑 → 之後寫 canonical」是兩個分開的操作。
 * 一個併發的 webhook DELETE 可以在中間 commit，於是同步用**過期**的墓碑判定
 * 把已刪除的生理資料寫回來。Codex 用真實 libSQL 重現：
 *   ACTIVE 墓碑 + canonical 列 同時存在。
 *
 * 修法：墓碑判定與 canonical 寫入在**同一個交易**裡。這一支用兩個真實連線
 * （其中一個在另一條執行緒）與明確的 barrier 重現原始競態，證明它不可能再發生。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';

import { createDb } from './localDb.js';
import { createHealthStore } from '../src/store.js';
import { TOMBSTONE_STATE, WHOOP_EVENT_STATE } from '../src/schema.js';
import { WhoopApiError } from '../src/whoop.js';
import { processWhoopEvent, PROCESS_RESULT } from '../src/whoopWebhookProcessor.js';
import { WHOOP_WEBHOOK } from '../src/config.js';

const TZ = 'Asia/Taipei';
const ALICE = { id: 'u-alice', whoop: '1001' };
const BOB = { id: 'u-bob', whoop: '2002' };
const SID = 'aaaaaaaa-0000-4000-8000-000000000001';
const WID = 'wwwwwwww-0000-4000-8000-000000000001';
const WORKER = new URL('./whoop-delete-worker.js', import.meta.url);

function tempUrl() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whoop-rc2-'));
  return { url: `file:${path.join(dir, 't.db')}`, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

async function seed(db, users = [ALICE]) {
  await db.migrate();
  for (const u of users) {
    await db.createUser({ id: u.id, displayName: u.id, timezone: TZ });
    await db.saveTokens(u.id, {
      accessToken: `a-${u.id}`, refreshToken: `r-${u.id}`,
      expiresAt: new Date(Date.now() + 3_600_000), scope: 'offline', whoopUserId: u.whoop,
    });
  }
}

const sleepRecord = (updatedAt, rr = 15, id = SID) => ({
  id, nap: false, score_state: 'SCORED',
  start: '2026-09-11T22:00:00.000Z', end: '2026-09-12T06:00:00.000Z',
  created_at: '2026-09-12T06:01:00.000Z', updated_at: updatedAt,
  score: {
    respiratory_rate: rr,
    stage_summary: {
      total_light_sleep_time_milli: 1, total_slow_wave_sleep_time_milli: 1, total_rem_sleep_time_milli: 1,
    },
  },
});
const recoveryRecord = (updatedAt, score, sleepId = SID) => ({
  sleep_id: sleepId, cycle_id: 'c-1', user_id: 1, score_state: 'SCORED',
  created_at: '2026-09-12T06:00:00.000Z', updated_at: updatedAt, score: { recovery_score: score },
});
const workoutRecord = (updatedAt, strain, id = WID) => ({
  id, user_id: 1, score_state: 'SCORED', sport_name: 'running',
  start: '2026-09-11T08:00:00.000Z', end: '2026-09-11T09:00:00.000Z',
  created_at: '2026-09-11T09:00:00.000Z', updated_at: updatedAt, score: { strain, zone_durations: {} },
});

/** 每種資源的 canonical 表、識別欄位、寫入方式、範例資料。 */
const RESOURCES = {
  sleep: {
    table: 'whoop_sleeps', idCol: 'id', id: SID,
    write: (db, uid, u, v) => db.upsertSleeps(uid, [sleepRecord(u, v)], { timezone: TZ }),
    valueCol: 'respiratory_rate',
  },
  recovery: {
    table: 'whoop_recoveries', idCol: 'sleep_id', id: SID,
    write: (db, uid, u, v) => db.upsertRecoveries(uid, [recoveryRecord(u, v)]),
    valueCol: 'recovery_score',
  },
  workout: {
    table: 'whoop_workouts', idCol: 'id', id: WID,
    write: (db, uid, u, v) => db.upsertWorkouts(uid, [workoutRecord(u, v)], { timezone: TZ }),
    valueCol: 'strain',
  },
};

const rowsOf = async (db, res, uid) => (await db.raw.execute({
  sql: `SELECT ${res.valueCol} v, updated_at FROM ${res.table} WHERE user_id = ? AND ${res.idCol} = ?`,
  args: [uid, res.id],
})).rows.map((r) => ({ v: Number(r.v), updated_at: r.updated_at }));

/**
 * 在 A 的 upsert 交易裡、讀完墓碑之後、寫 canonical 之前，插一個 barrier。
 * 回傳 { paused, release }：paused 在 A 走到那一點時 resolve。
 */
function installPauseBeforeCanonicalWrite(db) {
  let release;
  const gate = new Promise((r) => { release = r; });
  let signal;
  const paused = new Promise((r) => { signal = r; });
  const orig = db.raw.transaction;
  db.raw.transaction = async (...a) => {
    const tx = await orig(...a);
    const batch = tx.batch.bind(tx);
    tx.batch = async (...b) => { signal(); await gate; return batch(...b); };
    return tx;
  };
  return { paused, release, restore: () => { db.raw.transaction = orig; } };
}

/** 在另一條執行緒、另一個連線上跑 webhook DELETE（兩階段：prepare → mutate）。 */
function deleteWorker({ url, userId, whoopUserId, resourceType, resourceId, traceId }) {
  const worker = new Worker(WORKER);
  const waitFor = (type) => new Promise((resolve, reject) => {
    const on = (m) => { if (m.type === type) { worker.off('message', on); resolve(m); } };
    worker.on('message', on);
    worker.on('error', reject);
  });
  const ready = waitFor('ready');
  worker.postMessage({ type: 'prepare', url, userId, whoopUserId, resourceType, resourceId, traceId });
  return {
    ready,
    mutate() {
      const starting = waitFor('starting');
      const done = waitFor('done');
      worker.postMessage({ type: 'mutate' });
      return { starting, done };
    },
    terminate: () => worker.terminate(),
  };
}

// ===========================================================================
// 1. 原始 Codex 競態：排程同步先讀（沒墓碑）→ 暫停 → DELETE 在另一連線 → 恢復
// ===========================================================================

for (const [type, res] of Object.entries(RESOURCES)) {
  test(`★★★ RC2/${type}: 真實兩連線競態（sync 先讀墓碑、DELETE 在中間）→ 不可能復活`, async () => {
    const { url, cleanup } = tempUrl();
    const A = createDb({ url });
    let worker = null;
    try {
      await seed(A);
      await res.write(A, ALICE.id, '2026-09-12T10:00:00.000Z', 20);
      assert.equal((await rowsOf(A, res, ALICE.id)).length, 1);

      // B（另一條執行緒、另一個連線）先把 DELETE 事件收下並認領 —— 這兩步是寫入，
      // 必須在 A 取得寫鎖之前完成，否則測到的是 harness 自己的死結。
      worker = deleteWorker({
        url, userId: ALICE.id, whoopUserId: ALICE.whoop,
        resourceType: type, resourceId: res.id, traceId: `del-${type}`,
      });
      await worker.ready;

      // A：排程同步式的 upsert，在「讀完墓碑（沒有）」之後暫停，仍持有寫交易。
      const pause = installPauseBeforeCanonicalWrite(A);
      const syncP = res.write(A, ALICE.id, '2026-09-12T11:00:00.000Z', 99);
      await pause.paused;

      // B 現在才做 DELETE 變更交易。
      // 修復前這裡會**在 A 的兩步之間 commit**；修復後 A 持有寫交易，B 只能等。
      const b = worker.mutate();
      await b.starting;
      // 給 B 一點時間真的發出 BEGIN IMMEDIATE 並被擋住（它在另一條執行緒，不會卡住這裡）。
      await new Promise((r) => setTimeout(r, 300));
      let bFinishedEarly = false;
      b.done.then(() => { bFinishedEarly = true; });
      await new Promise((r) => setTimeout(r, 200));
      assert.equal(bFinishedEarly, false,
        '★★★ B 不可以在 A 的「讀墓碑 → 寫 canonical」之間 commit —— 那正是原始缺陷');

      // A 恢復並 commit。
      const releasedAt = Date.now();
      pause.release();
      const written = await syncP;
      pause.restore();
      // A 寫成功是**合法**的：它讀到沒有墓碑，而 B 還沒 commit。
      assert.equal(written, 1, 'A 在自己的交易裡合法寫入');

      // B 現在才拿到鎖 → 立墓碑 + 刪掉 A 剛寫的那一列。
      const bResult = await b.done;
      assert.equal(bResult.ok, true, `B 必須在 A 之後成功：${bResult.error ?? ''}`);
      assert.ok(bResult.committedAt >= releasedAt, '★ B 的 commit 一定在 A 釋放之後');

      // ★★★ 最終不變量
      const tomb = await A.getTombstone(ALICE.id, type, res.id);
      assert.equal(tomb?.state, TOMBSTONE_STATE.ACTIVE);
      assert.equal((await rowsOf(A, res, ALICE.id)).length, 0,
        '★★★ ACTIVE 墓碑 + canonical 列 這個狀態必須不可達');
    } finally {
      worker?.terminate();
      A.close();
      cleanup();
    }
  });
}

// ===========================================================================
// 2/3. 另外兩種順序（不需要執行緒）
// ===========================================================================

for (const [type, res] of Object.entries(RESOURCES)) {
  test(`★★★ RC2/${type}: DELETE 先 commit → 之後的排程同步被擋（所有版本）`, async () => {
    const { url, cleanup } = tempUrl();
    const db = createDb({ url });
    try {
      await seed(db);
      await res.write(db, ALICE.id, '2026-09-12T10:00:00.000Z', 20);
      await db.recordWhoopEvent({
        whoopUserId: ALICE.whoop, eventType: `${type}.deleted`, resourceType: type,
        resourceId: res.id, traceId: 'd',
      });
      const ev = await db.claimWhoopEvent({ owner: 'D', leaseMs: 600_000 });
      await processWhoopEvent({ db, event: ev, owner: 'D', whoopFor: () => ({}) });
      for (const u of ['2026-09-12T09:00:00.000Z', '2026-09-12T10:00:00.000Z', '2099-01-01T00:00:00.000Z']) {
        assert.equal(await res.write(db, ALICE.id, u, 77), 0, `★ updated_at=${u} 必須被擋`);
      }
      assert.equal((await rowsOf(db, res, ALICE.id)).length, 0);
      assert.equal((await db.getTombstone(ALICE.id, type, res.id)).state, TOMBSTONE_STATE.ACTIVE);
      assert.equal((await db.getTombstone(ALICE.id, type, res.id)).blockedCount, 3, '★ blocked_count 在同一交易裡更新');
    } finally { db.close(); cleanup(); }
  });

  test(`★★★ RC2/${type}: 排程同步先 commit → DELETE 之後刪掉它`, async () => {
    const { url, cleanup } = tempUrl();
    const db = createDb({ url });
    try {
      await seed(db);
      assert.equal(await res.write(db, ALICE.id, '2026-09-12T11:00:00.000Z', 99), 1);
      await db.recordWhoopEvent({
        whoopUserId: ALICE.whoop, eventType: `${type}.deleted`, resourceType: type,
        resourceId: res.id, traceId: 'd',
      });
      const ev = await db.claimWhoopEvent({ owner: 'D', leaseMs: 600_000 });
      const r = await processWhoopEvent({ db, event: ev, owner: 'D', whoopFor: () => ({}) });
      assert.equal(r.result, PROCESS_RESULT.DELETED);
      assert.equal((await rowsOf(db, res, ALICE.id)).length, 0);
      assert.equal((await db.getTombstone(ALICE.id, type, res.id)).state, TOMBSTONE_STATE.ACTIVE);
    } finally { db.close(); cleanup(); }
  });
}

// ===========================================================================
// 9. 沒有墓碑：正常 upsert 完全不受影響（M-03 也原封不動）
// ===========================================================================

test('★★★ RC2/9,19-22: 沒有墓碑時正常 upsert；M-03 新贏／舊擋／等冪等／缺版本不覆蓋', async () => {
  const { url, cleanup } = tempUrl();
  const db = createDb({ url });
  try {
    await seed(db);
    const res = RESOURCES.sleep;
    assert.equal(await res.write(db, ALICE.id, '2026-09-12T10:00:00.000Z', 11), 1);
    assert.equal(await res.write(db, ALICE.id, '2026-09-12T11:00:00.000Z', 22), 1, '★ 新贏');
    assert.equal(await res.write(db, ALICE.id, '2026-09-12T10:00:00.000Z', 33), 0, '★ 舊擋');
    assert.equal(await res.write(db, ALICE.id, '2026-09-12T11:00:00.000Z', 22), 1, '★ 等 = 冪等更新');
    assert.equal(await db.upsertSleeps(ALICE.id, [sleepRecord(null, 44)], { timezone: TZ }), 0,
      '★ 缺來源版本不可覆蓋已知版本');
    const rows = await rowsOf(db, res, ALICE.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].v, 22);
  } finally { db.close(); cleanup(); }
});

// ===========================================================================
// 10-16. webhook 交易：不巢狀、圍欄仍在
// ===========================================================================

test('★★★ RC2/10: webhook UPDATE 已在 mutateForWhoopEvent 裡 → store 沿用交易，不巢狀、不炸', async () => {
  const { url, cleanup } = tempUrl();
  const db = createDb({ url });
  try {
    await seed(db);
    // 直接證明：在交易內呼叫 upsert 時，processing 的 active() 為 true 且沒有第二次 BEGIN。
    let begins = 0;
    const orig = db.raw.transaction;
    db.raw.transaction = async (...a) => { begins += 1; return orig(...a); };
    await db.recordWhoopEvent({ whoopUserId: ALICE.whoop, eventType: 'sleep.updated', resourceType: 'sleep', resourceId: SID, traceId: 'u' });
    const ev = await db.claimWhoopEvent({ owner: 'U', leaseMs: 600_000 });
    let activeInside = null;
    await db.mutateForWhoopEvent(ev.id, { owner: 'U' }, async () => {
      activeInside = db.processingTransactionActive();
      return db.upsertSleeps(ALICE.id, [sleepRecord('2026-09-12T10:00:00.000Z', 42)], { timezone: TZ });
    });
    db.raw.transaction = orig;
    assert.equal(activeInside, true);
    assert.equal(begins, 1, '★★★ 只可以有一個 BEGIN（沒有巢狀交易）');
    assert.equal((await rowsOf(db, RESOURCES.sleep, ALICE.id))[0].v, 42);
  } finally { db.close(); cleanup(); }
});

for (const [type, res] of Object.entries(RESOURCES)) {
  test(`★★★ RC2/11-13: webhook ${type} UPDATE 的所有權圍欄仍然有效（A 過期、B 接手）`, async () => {
    const { url, cleanup } = tempUrl();
    const db = createDb({ url });
    try {
      await seed(db);
      const et = `${type}.updated`;
      await db.recordWhoopEvent({ whoopUserId: ALICE.whoop, eventType: et, resourceType: type, resourceId: res.id, traceId: 'u' });
      const t0 = new Date('2026-09-12T10:00:00.000Z');
      const a = await db.claimWhoopEvent({ owner: 'A', leaseMs: 60_000, now: t0 });
      const later = new Date(t0.getTime() + 61_000);
      const record = type === 'sleep' ? sleepRecord('2026-09-12T10:00:00.000Z', 42)
        : type === 'workout' ? workoutRecord('2026-09-12T10:00:00.000Z', 14)
          : recoveryRecord('2026-09-12T10:00:00.000Z', 77);
      const whoopFor = () => ({
        async apiGet(p) {
          // A 在打 API 時失去所有權
          await db.claimWhoopEvent({ owner: 'B', leaseMs: 60_000, now: later });
          if (type === 'recovery' || type === 'sleep') return sleepRecord('2026-09-12T10:00:00.000Z');
          return record;
        },
        async recoveries() { return [record]; },
      });
      const r = await processWhoopEvent({ db, event: a, owner: 'A', whoopFor, now: () => later });
      assert.equal(r.result, PROCESS_RESULT.FENCED);
      assert.equal((await rowsOf(db, res, ALICE.id)).length, 0, `★★★ ${type}：過期的 A 不可以寫`);
    } finally { db.close(); cleanup(); }
  });
}

test('★★★ RC2/16: 所有權在交易中途被換掉 → after-check 把 store 的寫入一起 rollback', async () => {
  const { url, cleanup } = tempUrl();
  const db = createDb({ url });
  try {
    await seed(db);
    await db.recordWhoopEvent({ whoopUserId: ALICE.whoop, eventType: 'sleep.updated', resourceType: 'sleep', resourceId: SID, traceId: 'u' });
    const ev = await db.claimWhoopEvent({ owner: 'A', leaseMs: 600_000 });
    await assert.rejects(() => db.mutateForWhoopEvent(ev.id, { owner: 'A' }, async () => {
      await db.upsertSleeps(ALICE.id, [sleepRecord('2026-09-12T10:00:00.000Z', 42)], { timezone: TZ });
      await db.raw.execute({ sql: "UPDATE whoop_webhook_events SET owner='B' WHERE id=?", args: [ev.id] });
    }), /whoop_event_ownership_lost/);
    assert.equal((await rowsOf(db, RESOURCES.sleep, ALICE.id)).length, 0, '★★★ 寫入必須被 rollback');
  } finally { db.close(); cleanup(); }
});

// ===========================================================================
// 17-18. 多使用者
// ===========================================================================

test('★★★ RC2/17-18: 同 id 跨使用者隔離；Alice 的墓碑不擋 Bob（交易內也一樣）', async () => {
  const { url, cleanup } = tempUrl();
  const db = createDb({ url });
  try {
    await seed(db, [ALICE, BOB]);
    const res = RESOURCES.sleep;
    await res.write(db, ALICE.id, '2026-09-12T10:00:00.000Z', 20);
    await res.write(db, BOB.id, '2026-09-12T10:00:00.000Z', 30);
    await db.recordWhoopEvent({ whoopUserId: ALICE.whoop, eventType: 'sleep.deleted', resourceType: 'sleep', resourceId: SID, traceId: 'd' });
    const ev = await db.claimWhoopEvent({ owner: 'D', leaseMs: 600_000 });
    await processWhoopEvent({ db, event: ev, owner: 'D', whoopFor: () => ({}) });
    assert.equal((await rowsOf(db, res, ALICE.id)).length, 0);
    assert.equal((await rowsOf(db, res, BOB.id))[0].v, 30, '★ Bob 完全不受影響');
    assert.equal(await res.write(db, BOB.id, '2026-09-12T11:00:00.000Z', 31), 1, '★★★ Alice 的墓碑不可以擋 Bob 的寫入');
    assert.equal(await db.getTombstone(BOB.id, 'sleep', SID), null);
  } finally { db.close(); cleanup(); }
});

// ===========================================================================
// 23-25. 崩潰重播 / 墓碑擋下的 webhook UPDATE 是終局
// ===========================================================================

test('★★★ RC2/23-24: DELETE 後崩潰重播安全；墓碑擋下的 webhook UPDATE 終局不重試', async () => {
  const { url, cleanup } = tempUrl();
  const db = createDb({ url });
  try {
    await seed(db);
    await RESOURCES.sleep.write(db, ALICE.id, '2026-09-12T10:00:00.000Z', 20);
    const d = await db.recordWhoopEvent({ whoopUserId: ALICE.whoop, eventType: 'sleep.deleted', resourceType: 'sleep', resourceId: SID, traceId: 'd' });
    const t0 = new Date('2026-09-12T10:00:00.000Z');
    const dEv = await db.claimWhoopEvent({ owner: 'D', leaseMs: 60_000, now: t0 });
    await db.mutateForWhoopEvent(dEv.id, { owner: 'D', now: () => t0 }, () => db.deleteWhoopResource({ userId: ALICE.id, resourceType: 'sleep', resourceId: SID }));
    // 崩潰（沒結案）→ 過期後重播
    const later = new Date(t0.getTime() + 120_000);
    const re = await db.claimWhoopEvent({ owner: 'R', leaseMs: 60_000, now: later });
    assert.equal(re.id, d.id);
    const r = await processWhoopEvent({ db, event: re, owner: 'R', whoopFor: () => ({}), now: () => later });
    assert.equal(r.result, PROCESS_RESULT.DELETED);
    assert.equal((await db.getWhoopEvent(d.id)).state, WHOOP_EVENT_STATE.PROCESSED);

    // 墓碑擋下的 webhook UPDATE：終局
    await db.recordWhoopEvent({ whoopUserId: ALICE.whoop, eventType: 'sleep.updated', resourceType: 'sleep', resourceId: SID, traceId: 'u' });
    const uEv = await db.claimWhoopEvent({ owner: 'U', leaseMs: 60_000, now: later });
    const ru = await processWhoopEvent({
      db, event: uEv, owner: 'U', now: () => later,
      whoopFor: () => ({ apiGet: async () => sleepRecord('2099-01-01T00:00:00.000Z', 99), recoveries: async () => [] }),
    });
    assert.equal(ru.result, PROCESS_RESULT.BLOCKED_BY_TOMBSTONE);
    assert.equal(await db.claimWhoopEvent({ owner: 'X', leaseMs: 60_000, now: new Date(later.getTime() + 3_600_000), maxAttempts: WHOOP_WEBHOOK.MAX_ATTEMPTS }), null, '★ 沒有東西可再認領');
    assert.equal((await rowsOf(db, RESOURCES.sleep, ALICE.id)).length, 0);
  } finally { db.close(); cleanup(); }
});

// ===========================================================================
// 27. pre-v10：沒有墓碑表 → 必須 fail closed（不可以靜默寫入）
// ===========================================================================

test('★★★ RC2/27: 墓碑表不存在（pre-v10）→ 受保護的寫入 fail closed，不可以靜默寫入', async () => {
  const { url, cleanup } = tempUrl();
  const db = createDb({ url });
  try {
    await seed(db);
    await db.raw.execute('DROP TABLE whoop_resource_tombstones');
    await assert.rejects(
      () => db.upsertSleeps(ALICE.id, [sleepRecord('2026-09-12T10:00:00.000Z', 20)], { timezone: TZ }),
      /no such table/i,
      '★★★ 沒有墓碑表就不可以寫 —— 靜默寫入等於保護不存在',
    );
    assert.equal((await rowsOf(db, RESOURCES.sleep, ALICE.id)).length, 0, '★ 交易 rollback，沒有任何列');
  } finally { db.close(); cleanup(); }
});

// ===========================================================================
// 建構時就要求交易執行器
// ===========================================================================

test('★★★ createHealthStore 沒有交易執行器就拒絕建構（保護不可能被靜默略過）', () => {
  assert.throws(() => createHealthStore({}), /transaction/);
});
