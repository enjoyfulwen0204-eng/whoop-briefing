/**
 * V1.2 Phase 1 — 修復週期 1（P1-R01 + P1-R02）的對抗性回歸。
 *
 * P1-R01  本地順序不是 WHOOP 來源時序。Phase 1 的 ACTIVE 墓碑**永遠**不自動退位。
 * P1-R02  canonical / 墓碑變更必須在**同一個交易**裡證明所有權；
 *         墓碑 + 實體刪除必須原子。
 *
 * 全部用暫時檔案 DB + 假 WHOOP。不打網路、不碰生產環境。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createDb } from '../src/db.js';
import { WHOOP_EVENT_STATE, TOMBSTONE_STATE } from '../src/schema.js';
import { WhoopApiError } from '../src/whoop.js';
import { processWhoopEvent, drainWhoopWebhookEvents, PROCESS_RESULT } from '../src/whoopWebhookProcessor.js';
import { WHOOP_WEBHOOK } from '../src/config.js';

const TZ = 'Asia/Taipei';
const ALICE = { id: 'u-alice', whoop: '1001' };
const BOB = { id: 'u-bob', whoop: '2002' };
const SID = 'aaaaaaaa-0000-4000-8000-000000000001';
const WID = 'wwwwwwww-0000-4000-8000-000000000001';

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whoop-r1-'));
  const db = createDb({ url: `file:${path.join(dir, 't.db')}` });
  return { db, cleanup: () => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
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

function fakeWhoop({ routes = {}, recoveries = [], onCall = null } = {}) {
  return () => ({
    async apiGet(p) {
      await onCall?.(p);
      const hit = routes[p];
      if (hit === undefined) throw new WhoopApiError(`WHOOP 404 ${p}`, 404);
      if (hit instanceof Error) throw hit;
      return hit;
    },
    async recoveries() { await onCall?.('/recovery'); return recoveries; },
  });
}

const insertEvent = async (db, {
  whoopUserId = ALICE.whoop, eventType = 'sleep.updated', resourceType = 'sleep',
  resourceId = SID, traceId, eventAt = '1789000000000',
}) => (await db.recordWhoopEvent({ whoopUserId, eventType, resourceType, resourceId, traceId, eventAt })).id;

const claim = (db, owner, over = {}) => db.claimWhoopEvent({
  owner, leaseMs: WHOOP_WEBHOOK.LEASE_MS, maxAttempts: WHOOP_WEBHOOK.MAX_ATTEMPTS, ...over,
});

const sleepRow = async (db, uid, id = SID) => (await db.raw.execute({
  sql: 'SELECT respiratory_rate, updated_at FROM whoop_sleeps WHERE user_id = ? AND id = ?', args: [uid, id],
})).rows[0] ?? null;
const count = async (db, table, uid) => Number((await db.raw.execute({
  sql: `SELECT COUNT(*) n FROM ${table} WHERE user_id = ?`, args: [uid],
})).rows[0].n);

/** 走完整的 DELETE。 */
async function runDelete(db, { traceId, owner = `d-${traceId}`, uid = ALICE.whoop, type = 'sleep', id = SID }) {
  const et = `${type}.deleted`;
  await insertEvent(db, { whoopUserId: uid, eventType: et, resourceType: type, resourceId: id, traceId });
  const e = await claim(db, owner);
  return processWhoopEvent({ db, event: e, owner, whoopFor: fakeWhoop() });
}

/** 走完整的 sleep UPDATE，canonical 回 record。 */
async function runUpdate(db, { traceId, record, owner = `u-${traceId}`, eventAt }) {
  const id = await insertEvent(db, { eventType: 'sleep.updated', traceId, eventAt });
  const e = await claim(db, owner);
  const r = await processWhoopEvent({
    db, event: e, owner, whoopFor: fakeWhoop({ routes: { [`/activity/sleep/${SID}`]: record } }),
  });
  return { ...r, eventId: id };
}

async function assertTombstonedAndAbsent(db, label) {
  assert.equal(await sleepRow(db, ALICE.id), null, `★★★ ${label}：canonical 必須不存在`);
  const tomb = await db.getTombstone(ALICE.id, 'sleep', SID);
  assert.equal(tomb?.state, TOMBSTONE_STATE.ACTIVE, `★★★ ${label}：墓碑必須 ACTIVE`);
}

// ===========================================================================
// P1-R01
// ===========================================================================

test('★★★ R01/1 延遲抵達的刪除前 UPDATE（updated_at 較新）不可以復活', async () => {
  // WHOOP 語義：U2 先產生，DELETE 後產生。投遞：DELETE 先到，U2 延遲後到。
  const { db, cleanup } = tempDb();
  try {
    await seed(db);
    await db.upsertSleeps(ALICE.id, [sleepRecord('2026-09-12T10:00:00.000Z', 20)], { timezone: TZ });
    await runDelete(db, { traceId: 'D' });
    await assertTombstonedAndAbsent(db, '刪除後');
    // U2 取到的 canonical 比刪除時本地那一版新
    const r = await runUpdate(db, { traceId: 'U2', record: sleepRecord('2026-09-12T10:30:00.000Z', 99) });
    assert.equal(r.result, PROCESS_RESULT.BLOCKED_BY_TOMBSTONE);
    await assertTombstonedAndAbsent(db, '延遲 U2 之後');
    assert.equal((await db.getWhoopEvent(r.eventId)).state, WHOOP_EVENT_STATE.PROCESSED, '★ 保守結案');
  } finally { cleanup(); }
});

test('★★★ R01/2 刪除後的「真正重建」在 Phase 1 仍然墓碑（需要未來的對帳）', async () => {
  const { db, cleanup } = tempDb();
  try {
    await seed(db);
    await db.upsertSleeps(ALICE.id, [sleepRecord('2026-09-12T10:00:00.000Z', 20)], { timezone: TZ });
    await runDelete(db, { traceId: 'D' });
    const r = await runUpdate(db, {
      traceId: 'RECREATE', record: sleepRecord('2026-09-13T08:00:00.000Z', 42), eventAt: '1789999999999',
    });
    assert.equal(r.result, PROCESS_RESULT.BLOCKED_BY_TOMBSTONE);
    await assertTombstonedAndAbsent(db, '重建之後');
  } finally { cleanup(); }
});

test('★★★ R01/3 反向投遞（UPDATE 先到、DELETE 延遲）最終仍然保守刪除', async () => {
  const { db, cleanup } = tempDb();
  try {
    await seed(db);
    // WHOOP 語義：DELETE 先、重建 UPDATE 後；投遞反過來。
    const r1 = await runUpdate(db, { traceId: 'U', record: sleepRecord('2026-09-13T08:00:00.000Z', 42) });
    assert.equal(r1.result, PROCESS_RESULT.PERSISTED);
    assert.ok(await sleepRow(db, ALICE.id));
    const r2 = await runDelete(db, { traceId: 'D-late' });
    assert.equal(r2.result, PROCESS_RESULT.DELETED);
    // 不拿「本地誰先誰後」推論任何事：最終狀態保守地是刪除。
    await assertTombstonedAndAbsent(db, '延遲 DELETE 之後');
  } finally { cleanup(); }
});

test('★★★ R01/4-7 較新 updated_at / 較大本地 id / 較晚 received_at / 較晚簽章時間戳都不能退位', async () => {
  const { db, cleanup } = tempDb();
  try {
    await seed(db);
    await db.upsertSleeps(ALICE.id, [sleepRecord('2026-09-12T10:00:00.000Z', 20)], { timezone: TZ });
    await runDelete(db, { traceId: 'D' });
    const delEv = (await db.raw.execute("SELECT id, received_at FROM whoop_webhook_events WHERE event_type='sleep.deleted'")).rows[0];

    const r = await runUpdate(db, {
      traceId: 'U-everything-newer',
      record: sleepRecord('2099-12-31T00:00:00.000Z', 99),   // updated_at 極新
      eventAt: '9999999999999',                               // 簽章時間戳極新
    });
    const upEv = await db.getWhoopEvent(r.eventId);
    assert.ok(upEv.id > Number(delEv.id), '本地 id 較大');
    assert.ok(upEv.receivedAt >= String(delEv.received_at), 'received_at 較晚');
    assert.equal(r.result, PROCESS_RESULT.BLOCKED_BY_TOMBSTONE);
    await assertTombstonedAndAbsent(db, '全部都「較新」之後');
  } finally { cleanup(); }
});

test('★★★ R01/7 排程同步在墓碑之後看到資源 → 不退位、不復活', async () => {
  const { db, cleanup } = tempDb();
  try {
    await seed(db);
    await db.upsertSleeps(ALICE.id, [sleepRecord('2026-09-12T10:00:00.000Z', 20)], { timezone: TZ });
    await runDelete(db, { traceId: 'D' });
    for (const u of ['2026-09-12T10:00:00.000Z', '2026-09-12T11:00:00.000Z', '2099-01-01T00:00:00.000Z']) {
      const n = await db.upsertSleeps(ALICE.id, [sleepRecord(u, 77)], { timezone: TZ });
      assert.equal(n, 0, `★ 排程同步（updated_at=${u}）必須被擋`);
    }
    await assertTombstonedAndAbsent(db, '排程同步之後');
  } finally { cleanup(); }
});

test('★★★ R01/8-9 墓碑後重複 UPDATE 冪等地被擋；重複 DELETE 冪等', async () => {
  const { db, cleanup } = tempDb();
  try {
    await seed(db);
    await db.upsertSleeps(ALICE.id, [sleepRecord('2026-09-12T10:00:00.000Z', 20)], { timezone: TZ });
    await runDelete(db, { traceId: 'D1' });
    for (let i = 0; i < 3; i += 1) {
      const r = await runUpdate(db, { traceId: `U${i}`, record: sleepRecord('2026-09-12T12:00:00.000Z', 5) });
      assert.equal(r.result, PROCESS_RESULT.BLOCKED_BY_TOMBSTONE, `第 ${i + 1} 次 UPDATE`);
    }
    for (let i = 0; i < 3; i += 1) {
      const r = await runDelete(db, { traceId: `D${i + 2}` });
      assert.equal(r.result, PROCESS_RESULT.DELETED, `第 ${i + 2} 次 DELETE`);
    }
    assert.equal(await count(db, 'whoop_resource_tombstones', ALICE.id), 1, '★ 只有一個墓碑');
    await assertTombstonedAndAbsent(db, '多次重播之後');
    const tomb = await db.getTombstone(ALICE.id, 'sleep', SID);
    assert.equal(tomb.blockedCount, 3, '★ 每一次被擋都留下證據');
  } finally { cleanup(); }
});

test('★★★ R01 沒有任何程式路徑會把墓碑寫成 SUPERSEDED', async () => {
  const { db, cleanup } = tempDb();
  try {
    await seed(db);
    assert.equal(typeof db.supersedeTombstoneIfProven, 'undefined', '★ 退位函式必須不存在');
    assert.equal(typeof db.supersedeTombstone, 'undefined');
  } finally { cleanup(); }
});

// ===========================================================================
// P1-R02 — 所有權圍欄在變更交易裡
// ===========================================================================

test('★★★ R02/10,13 UPDATE：A 早期檢查通過 → 租約過期 → B 認領 → A 的變更被交易圍欄擋下', async () => {
  const { db, cleanup } = tempDb();
  try {
    await seed(db);
    await insertEvent(db, { traceId: 'U' });
    const t0 = new Date('2026-09-12T10:00:00.000Z');
    const a = await claim(db, 'A', { leaseMs: 60_000, now: t0 });
    // A 的早期 helper 檢查在租約內是 true —— 這正是稽核指出不夠的那種檢查。
    assert.equal(await db.holdsWhoopEvent(a.id, 'A', { now: t0 }), true);

    const later = new Date(t0.getTime() + 61_000);
    // A 在打 API 時卡住，租約過期，B 接手。
    const whoopFor = fakeWhoop({
      routes: { [`/activity/sleep/${SID}`]: sleepRecord('2026-09-12T10:00:00.000Z', 42) },
      onCall: async () => { assert.ok(await db.claimWhoopEvent({ owner: 'B', leaseMs: 60_000, now: later })); },
    });
    const r = await processWhoopEvent({ db, event: a, owner: 'A', whoopFor, now: () => later });
    assert.equal(r.result, PROCESS_RESULT.FENCED);
    assert.equal(await sleepRow(db, ALICE.id), null, '★★★ A 不可以寫 canonical');
    assert.equal(await count(db, 'whoop_resource_tombstones', ALICE.id), 0, '★ 也不可以動墓碑');
    assert.equal((await db.getWhoopEvent(a.id)).owner, 'B', '★ 事件屬於 B');

    // B 可以正常做完。
    const bEv = await db.getWhoopEvent(a.id);
    const rb = await processWhoopEvent({
      db, event: bEv, owner: 'B',
      whoopFor: fakeWhoop({ routes: { [`/activity/sleep/${SID}`]: sleepRecord('2026-09-12T10:00:00.000Z', 42) } }),
      now: () => later,
    });
    assert.equal(rb.result, PROCESS_RESULT.PERSISTED);
    assert.equal(Number((await sleepRow(db, ALICE.id)).respiratory_rate), 42);
  } finally { cleanup(); }
});

test('★★★ R02/11,12,14 DELETE：過期的 A 不能立墓碑、不能刪 canonical；B 可以', async () => {
  const { db, cleanup } = tempDb();
  try {
    await seed(db);
    await db.upsertSleeps(ALICE.id, [sleepRecord('2026-09-12T10:00:00.000Z', 20)], { timezone: TZ });
    await insertEvent(db, { eventType: 'sleep.deleted', traceId: 'D' });
    const t0 = new Date('2026-09-12T10:00:00.000Z');
    const a = await claim(db, 'A', { leaseMs: 60_000, now: t0 });
    assert.equal(await db.holdsWhoopEvent(a.id, 'A', { now: t0 }), true, 'A 的早期檢查通過');

    const later = new Date(t0.getTime() + 61_000);
    assert.ok(await db.claimWhoopEvent({ owner: 'B', leaseMs: 60_000, now: later }));

    // A 醒過來嘗試刪除。
    const r = await processWhoopEvent({ db, event: a, owner: 'A', whoopFor: fakeWhoop(), now: () => later });
    assert.equal(r.result, PROCESS_RESULT.FENCED);
    assert.ok(await sleepRow(db, ALICE.id), '★★★ canonical 必須還在');
    assert.equal(await count(db, 'whoop_resource_tombstones', ALICE.id), 0, '★★★ 不可以有墓碑');

    const bEv = await db.getWhoopEvent(a.id);
    const rb = await processWhoopEvent({ db, event: bEv, owner: 'B', whoopFor: fakeWhoop(), now: () => later });
    assert.equal(rb.result, PROCESS_RESULT.DELETED);
    await assertTombstonedAndAbsent(db, 'B 刪除之後');
  } finally { cleanup(); }
});

test('★★★ R02/15,16 墓碑 + 實體刪除原子：中間注入失敗 → 兩者都 rollback', async () => {
  const { db, cleanup } = tempDb();
  try {
    await seed(db);
    await db.upsertSleeps(ALICE.id, [sleepRecord('2026-09-12T10:00:00.000Z', 20)], { timezone: TZ });
    await insertEvent(db, { eventType: 'sleep.deleted', traceId: 'D' });
    const e = await claim(db, 'A');

    // 在墓碑寫入**之後**、實體刪除**之前**注入 DB 失敗。
    const origExecute = db.raw.execute.bind(db.raw);
    let tombstoneWritten = false;
    const poisoned = {
      ...db,
      raw: db.raw,
      deleteWhoopResource: async (args) => {
        await db.upsertTombstone({ ...args, lastKnownUpdatedAt: '2026-09-12T10:00:00.000Z' });
        tombstoneWritten = true;
        throw new Error('injected_failure_between_tombstone_and_delete');
      },
    };
    const r = await processWhoopEvent({ db: poisoned, event: e, owner: 'A', whoopFor: fakeWhoop() });
    assert.equal(tombstoneWritten, true, '（墓碑那一句真的執行過）');
    assert.notEqual(r.result, PROCESS_RESULT.DELETED);

    // ★★★ 交易 rollback：沒有墓碑、canonical 原封不動。
    assert.equal(await count(db, 'whoop_resource_tombstones', ALICE.id), 0, '★★★ 墓碑必須被 rollback');
    const row = await sleepRow(db, ALICE.id);
    assert.ok(row, '★★★ canonical 必須原封不動');
    assert.equal(Number(row.respiratory_rate), 20);
    // 事件不是終局，可以安全重試。
    const ev = await db.getWhoopEvent(e.id);
    assert.ok([WHOOP_EVENT_STATE.RETRY, WHOOP_EVENT_STATE.PROCESSING].includes(ev.state));
  } finally { cleanup(); }
});

test('★★★ R02/17 原子刪除 commit 之後、結案之前崩潰 → 重播收斂、無重複破壞', async () => {
  const { db, cleanup } = tempDb();
  try {
    await seed(db);
    await db.upsertSleeps(ALICE.id, [sleepRecord('2026-09-12T10:00:00.000Z', 20)], { timezone: TZ });
    const id = await insertEvent(db, { eventType: 'sleep.deleted', traceId: 'D' });
    const t0 = new Date('2026-09-12T10:00:00.000Z');
    const a = await claim(db, 'A', { leaseMs: 60_000, now: t0 });
    // 只做變更交易，**不**結案（模擬崩潰）。
    await db.mutateForWhoopEvent(a.id, { owner: 'A', now: () => t0 }, () => db.deleteWhoopResource({
      userId: ALICE.id, resourceType: 'sleep', resourceId: SID, sourceEventId: a.id, now: t0,
    }));
    await assertTombstonedAndAbsent(db, '崩潰前');
    assert.equal((await db.getWhoopEvent(id)).state, WHOOP_EVENT_STATE.PROCESSING);

    // 租約過期後重新排空。
    const later = new Date(t0.getTime() + 120_000);
    const s = await drainWhoopWebhookEvents({ db, whoopFor: fakeWhoop(), owner: 'restart', now: () => later });
    assert.equal(s.claimed, 1);
    assert.equal(s.results[PROCESS_RESULT.DELETED], 1);
    await assertTombstonedAndAbsent(db, '重播後');
    assert.equal(await count(db, 'whoop_resource_tombstones', ALICE.id), 1, '★ 沒有第二個墓碑');
    const ev = await db.getWhoopEvent(id);
    assert.equal(ev.state, WHOOP_EVENT_STATE.PROCESSED);
    assert.equal(ev.lastErrorDetail, 'delete_idempotent_replay', '★ 看得出來是重播');
  } finally { cleanup(); }
});

test('★★★ R02/18 UPDATE 與 DELETE 併發：最終是保守的刪除狀態（兩種交錯）', async () => {
  for (const order of ['delete-first', 'update-first']) {
    const { db, cleanup } = tempDb();
    try {
      await seed(db);
      await db.upsertSleeps(ALICE.id, [sleepRecord('2026-09-12T10:00:00.000Z', 20)], { timezone: TZ });
      await insertEvent(db, { traceId: 'U' });
      await insertEvent(db, { eventType: 'sleep.deleted', traceId: 'D' });
      const uEv = await claim(db, 'U', { leaseMs: 600_000 });
      const dEv = await claim(db, 'D', { leaseMs: 600_000 });
      const upd = () => processWhoopEvent({
        db, event: uEv, owner: 'U',
        whoopFor: fakeWhoop({ routes: { [`/activity/sleep/${SID}`]: sleepRecord('2026-09-12T10:30:00.000Z', 99) } }),
      });
      const del = () => processWhoopEvent({ db, event: dEv, owner: 'D', whoopFor: fakeWhoop() });
      if (order === 'delete-first') { await del(); await upd(); } else { await upd(); await del(); }
      await assertTombstonedAndAbsent(db, `併發（${order}）之後`);
    } finally { cleanup(); }
  }
});

test('★★★ R02/19,20 目前有效的擁有者仍然可以正常 UPDATE / DELETE', async () => {
  const { db, cleanup } = tempDb();
  try {
    await seed(db);
    const r1 = await runUpdate(db, { traceId: 'U', record: sleepRecord('2026-09-12T10:00:00.000Z', 42) });
    assert.equal(r1.result, PROCESS_RESULT.PERSISTED);
    assert.equal(Number((await sleepRow(db, ALICE.id)).respiratory_rate), 42);
    const r2 = await runDelete(db, { traceId: 'D' });
    assert.equal(r2.result, PROCESS_RESULT.DELETED);
    await assertTombstonedAndAbsent(db, '正常刪除');
  } finally { cleanup(); }
});

test('★★★ R02/21,22 同一個資源 id 跨兩個使用者：Alice 的刪除／更新絕不碰 Bob', async () => {
  const { db, cleanup } = tempDb();
  try {
    await seed(db, [ALICE, BOB]);
    await db.upsertSleeps(ALICE.id, [sleepRecord('2026-09-12T10:00:00.000Z', 20)], { timezone: TZ });
    await db.upsertSleeps(BOB.id, [sleepRecord('2026-09-12T10:00:00.000Z', 30)], { timezone: TZ });
    await runDelete(db, { traceId: 'D-alice', uid: ALICE.whoop });
    assert.equal(await sleepRow(db, ALICE.id), null);
    assert.equal(Number((await sleepRow(db, BOB.id)).respiratory_rate), 30, '★★★ Bob 完全不受影響');
    assert.equal(await db.getTombstone(BOB.id, 'sleep', SID), null);
    // Bob 之後的 UPDATE 也正常
    await insertEvent(db, { whoopUserId: BOB.whoop, traceId: 'U-bob' });
    const e = await claim(db, 'bob-owner');
    const r = await processWhoopEvent({
      db, event: e, owner: 'bob-owner',
      whoopFor: fakeWhoop({ routes: { [`/activity/sleep/${SID}`]: sleepRecord('2026-09-12T11:00:00.000Z', 31) } }),
    });
    assert.equal(r.result, PROCESS_RESULT.PERSISTED, '★ Alice 的墓碑不可以擋 Bob');
    assert.equal(Number((await sleepRow(db, BOB.id)).respiratory_rate), 31);
  } finally { cleanup(); }
});

test('★★★ R02/23 交易內的寫入仍然遵守 V1.1 新鮮度：新贏、舊擋、相同冪等', async () => {
  const { db, cleanup } = tempDb();
  try {
    await seed(db);
    await runUpdate(db, { traceId: 'a', record: sleepRecord('2026-09-12T10:00:00.000Z', 11) });
    await runUpdate(db, { traceId: 'b', record: sleepRecord('2026-09-12T11:00:00.000Z', 22) });
    assert.equal(Number((await sleepRow(db, ALICE.id)).respiratory_rate), 22, '★ 新的贏');
    await runUpdate(db, { traceId: 'c', record: sleepRecord('2026-09-12T10:00:00.000Z', 33) });
    assert.equal(Number((await sleepRow(db, ALICE.id)).respiratory_rate), 22, '★ 舊的被擋');
    await runUpdate(db, { traceId: 'd', record: sleepRecord('2026-09-12T11:00:00.000Z', 22) });
    assert.equal(await count(db, 'whoop_sleeps', ALICE.id), 1, '★ 相同版本冪等');
  } finally { cleanup(); }
});

test('★★★ R02/24 recovery / workout 的原子刪除也 user/resource 正確', async () => {
  const { db, cleanup } = tempDb();
  try {
    await seed(db, [ALICE, BOB]);
    for (const u of [ALICE, BOB]) {
      await db.upsertRecoveries(u.id, [recoveryRecord('2026-09-12T10:00:00.000Z', 60)]);
      await db.upsertWorkouts(u.id, [workoutRecord('2026-09-12T10:00:00.000Z', 12)], { timezone: TZ });
    }
    assert.equal((await runDelete(db, { traceId: 'dr', type: 'recovery', id: SID })).result, PROCESS_RESULT.DELETED);
    assert.equal((await runDelete(db, { traceId: 'dw', type: 'workout', id: WID })).result, PROCESS_RESULT.DELETED);
    assert.equal(await count(db, 'whoop_recoveries', ALICE.id), 0);
    assert.equal(await count(db, 'whoop_workouts', ALICE.id), 0);
    assert.equal(await count(db, 'whoop_recoveries', BOB.id), 1, '★★★ Bob 的 recovery 還在');
    assert.equal(await count(db, 'whoop_workouts', BOB.id), 1, '★★★ Bob 的 workout 還在');
    assert.equal((await db.getTombstone(ALICE.id, 'recovery', SID)).state, TOMBSTONE_STATE.ACTIVE);
    assert.equal((await db.getTombstone(ALICE.id, 'workout', WID)).state, TOMBSTONE_STATE.ACTIVE);
    assert.equal(await db.getTombstone(BOB.id, 'recovery', SID), null);
  } finally { cleanup(); }
});

test('★★★ R02/25 被墓碑擋下的 UPDATE 是終局，不會無限重試', async () => {
  const { db, cleanup } = tempDb();
  try {
    await seed(db);
    await db.upsertSleeps(ALICE.id, [sleepRecord('2026-09-12T10:00:00.000Z', 20)], { timezone: TZ });
    await runDelete(db, { traceId: 'D' });
    await insertEvent(db, { traceId: 'U' });
    const whoopFor = fakeWhoop({ routes: { [`/activity/sleep/${SID}`]: sleepRecord('2026-09-12T12:00:00.000Z', 5) } });
    const s1 = await drainWhoopWebhookEvents({ db, whoopFor, owner: 'd1' });
    assert.equal(s1.results[PROCESS_RESULT.BLOCKED_BY_TOMBSTONE], 1);
    const s2 = await drainWhoopWebhookEvents({ db, whoopFor, owner: 'd2' });
    assert.equal(s2.claimed, 0, '★★★ 不可以被重新認領');
  } finally { cleanup(); }
});

test('★★★ R02 normal delete path 永遠不會留下「ACTIVE 墓碑 + canonical 列」', async () => {
  const { db, cleanup } = tempDb();
  try {
    await seed(db);
    await db.upsertSleeps(ALICE.id, [sleepRecord('2026-09-12T10:00:00.000Z', 20)], { timezone: TZ });
    await runDelete(db, { traceId: 'D' });
    const bad = await db.raw.execute({
      sql: `SELECT COUNT(*) n FROM whoop_resource_tombstones t
             JOIN whoop_sleeps s ON s.user_id = t.user_id AND s.id = t.resource_id
            WHERE t.resource_type = 'sleep' AND t.state = 'ACTIVE'`,
    });
    assert.equal(Number(bad.rows[0].n), 0, '★★★ 這個狀態在正常路徑上必須不可達');
  } finally { cleanup(); }
});
