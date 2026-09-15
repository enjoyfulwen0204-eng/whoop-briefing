/**
 * V1.2 Phase 1 — 事件處理：認領／圍欄／canonical 取得／刪除／亂序／多使用者。
 *
 * 一律用暫時檔案 DB + 假的 WHOOP client。**不打任何真實網路**，
 * 不碰生產環境，不送任何 Telegram 訊息。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createDb } from '../src/db.js';
import { WHOOP_EVENT_STATE, TOMBSTONE_STATE } from '../src/schema.js';
import { WhoopApiError, WhoopAuthError } from '../src/whoop.js';
import {
  processWhoopEvent, drainWhoopWebhookEvents, classifyWhoopError,
  PROCESS_RESULT, ERROR_CLASS,
} from '../src/whoopWebhookProcessor.js';
import { WHOOP_WEBHOOK } from '../src/config.js';

const TZ = 'Asia/Taipei';
const ALICE = { id: 'u-alice', whoop: '1001' };
const BOB = { id: 'u-bob', whoop: '2002' };
const SLEEP_ID = 'aaaaaaaa-0000-4000-8000-000000000001';

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whoop-proc-'));
  const db = createDb({ url: `file:${path.join(dir, 't.db')}` });
  return { db, cleanup: () => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

async function seed(db, users = [ALICE]) {
  await db.migrate();
  for (const u of users) {
    await db.createUser({ id: u.id, displayName: u.id, timezone: TZ });
    await db.saveTokens(u.id, {
      accessToken: `a-${u.id}`, refreshToken: `r-${u.id}`,
      expiresAt: new Date(Date.now() + 3_600_000), scope: 'offline',
      whoopUserId: u.whoop,
    });
  }
}

/** WHOOP 的 sleep 物件（只放這一層真的會用到的欄位）。 */
const sleepRecord = (updatedAt, rr = 15, id = SLEEP_ID) => ({
  id,
  nap: false,
  score_state: 'SCORED',
  start: '2026-09-11T22:00:00.000Z',
  end: '2026-09-12T06:00:00.000Z',
  created_at: '2026-09-12T06:01:00.000Z',
  updated_at: updatedAt,
  score: {
    respiratory_rate: rr,
    stage_summary: {
      total_light_sleep_time_milli: 1,
      total_slow_wave_sleep_time_milli: 1,
      total_rem_sleep_time_milli: 1,
    },
  },
});

const workoutRecord = (updatedAt, strain, id = 'wwwwwwww-0000-4000-8000-000000000001') => ({
  id,
  user_id: 1,
  score_state: 'SCORED',
  sport_name: 'running',
  start: '2026-09-11T08:00:00.000Z',
  end: '2026-09-11T09:00:00.000Z',
  created_at: '2026-09-11T09:00:00.000Z',
  updated_at: updatedAt,
  score: { strain, zone_durations: {} },
});

const recoveryRecord = (updatedAt, score, sleepId = SLEEP_ID) => ({
  sleep_id: sleepId,
  cycle_id: 'c-1',
  user_id: 1,
  score_state: 'SCORED',
  created_at: '2026-09-12T06:00:00.000Z',
  updated_at: updatedAt,
  score: { recovery_score: score },
});

/**
 * 假的 WHOOP client。
 *
 * `routes` 是 path → 回應（或會拋的錯）。`recoveries` 是那個時間窗查詢的結果。
 */
function fakeWhoop({ routes = {}, recoveries = [], onCall = null } = {}) {
  return () => ({
    async apiGet(p) {
      onCall?.(p);
      const hit = routes[p];
      if (hit === undefined) throw new WhoopApiError(`WHOOP 404 ${p}`, 404);
      if (hit instanceof Error) throw hit;
      return hit;
    },
    async recoveries() {
      onCall?.('/recovery');
      if (recoveries instanceof Error) throw recoveries;
      return recoveries;
    },
  });
}

async function insertEvent(db, {
  whoopUserId = ALICE.whoop, eventType = 'sleep.updated',
  resourceType = 'sleep', resourceId = SLEEP_ID, traceId = 't-1',
} = {}) {
  const r = await db.recordWhoopEvent({
    whoopUserId, eventType, resourceType, resourceId, traceId, eventAt: '1789000000000',
  });
  return r.id;
}

const claim = (db, owner, over = {}) => db.claimWhoopEvent({
  owner, leaseMs: WHOOP_WEBHOOK.LEASE_MS, maxAttempts: WHOOP_WEBHOOK.MAX_ATTEMPTS, ...over,
});

const sleepRow = async (db, userId, id = SLEEP_ID) => (await db.raw.execute({
  sql: 'SELECT respiratory_rate, updated_at FROM whoop_sleeps WHERE user_id = ? AND id = ?',
  args: [userId, id],
})).rows[0] ?? null;

// ===========================================================================
// UPDATED：canonical 取得與寫入
// ===========================================================================

test('★★★ sleep.updated：payload 不是事實來源，一定重新去拿 canonical', async () => {
  const { db, cleanup } = tempDb();
  try {
    await seed(db);
    const id = await insertEvent(db);
    const calls = [];
    const whoopFor = fakeWhoop({
      routes: { [`/activity/sleep/${SLEEP_ID}`]: sleepRecord('2026-09-12T10:00:00.000Z', 42) },
      onCall: (p) => calls.push(p),
    });
    const event = await claim(db, 'owner-A');
    const r = await processWhoopEvent({ db, event, owner: 'owner-A', whoopFor });

    assert.equal(r.result, PROCESS_RESULT.PERSISTED);
    assert.deepEqual(calls, [`/activity/sleep/${SLEEP_ID}`], '★ 必須去打單筆端點');
    const row = await sleepRow(db, ALICE.id);
    assert.equal(Number(row.respiratory_rate), 42, '★ 寫進去的是 API 回來的資料');
    const ev = await db.getWhoopEvent(id);
    assert.equal(ev.state, WHOOP_EVENT_STATE.PROCESSED);
    assert.equal(ev.userId, ALICE.id);
  } finally { cleanup(); }
});

test('★★★ workout.updated 正常流程', async () => {
  const { db, cleanup } = tempDb();
  try {
    await seed(db);
    const wid = 'wwwwwwww-0000-4000-8000-000000000001';
    await insertEvent(db, { eventType: 'workout.updated', resourceType: 'workout', resourceId: wid });
    const whoopFor = fakeWhoop({
      routes: { [`/activity/workout/${wid}`]: workoutRecord('2026-09-12T10:00:00.000Z', 14) },
    });
    const event = await claim(db, 'owner-A');
    const r = await processWhoopEvent({ db, event, owner: 'owner-A', whoopFor });
    assert.equal(r.result, PROCESS_RESULT.PERSISTED);
    const row = (await db.raw.execute({
      sql: 'SELECT strain FROM whoop_workouts WHERE user_id = ?', args: [ALICE.id],
    })).rows[0];
    assert.equal(Number(row.strain), 14);
  } finally { cleanup(); }
});

test('★★★ recovery.updated：webhook 的 id 是 sleep UUID，不可以拿去當 cycle', async () => {
  const { db, cleanup } = tempDb();
  try {
    await seed(db);
    await insertEvent(db, {
      eventType: 'recovery.updated', resourceType: 'recovery', resourceId: SLEEP_ID,
    });
    const calls = [];
    const whoopFor = fakeWhoop({
      routes: { [`/activity/sleep/${SLEEP_ID}`]: sleepRecord('2026-09-12T10:00:00.000Z') },
      recoveries: [
        recoveryRecord('2026-09-12T10:00:00.000Z', 77, SLEEP_ID),
        recoveryRecord('2026-09-12T10:00:00.000Z', 11, 'some-other-sleep'),
      ],
      onCall: (p) => calls.push(p),
    });
    const event = await claim(db, 'owner-A');
    const r = await processWhoopEvent({ db, event, owner: 'owner-A', whoopFor });

    assert.equal(r.result, PROCESS_RESULT.PERSISTED);
    // ★★★ 絕不可以出現 /cycle/<sleepUuid>/recovery —— 那會打到別人的 cycle
    assert.ok(!calls.some((p) => p.includes('/cycle/')), `不可以用 cycle 定址：${calls}`);
    const row = (await db.raw.execute({
      sql: 'SELECT recovery_score, sleep_id FROM whoop_recoveries WHERE user_id = ?',
      args: [ALICE.id],
    })).rows[0];
    assert.equal(Number(row.recovery_score), 77, '★ 必須挑 sleep_id 全等的那一筆');
    assert.equal(String(row.sleep_id), SLEEP_ID);
  } finally { cleanup(); }
});

test('★★★ recovery 還沒算出來（窗裡沒有相符的）→ 什麼都不寫，記成 IGNORED', async () => {
  const { db, cleanup } = tempDb();
  try {
    await seed(db);
    const id = await insertEvent(db, {
      eventType: 'recovery.updated', resourceType: 'recovery', resourceId: SLEEP_ID,
    });
    const whoopFor = fakeWhoop({
      routes: { [`/activity/sleep/${SLEEP_ID}`]: sleepRecord('2026-09-12T10:00:00.000Z') },
      recoveries: [recoveryRecord('2026-09-12T10:00:00.000Z', 11, 'different-sleep')],
    });
    const event = await claim(db, 'owner-A');
    const r = await processWhoopEvent({ db, event, owner: 'owner-A', whoopFor });
    assert.equal(r.result, PROCESS_RESULT.IGNORED_RESOURCE_GONE);
    const rows = await db.raw.execute({
      sql: 'SELECT COUNT(*) n FROM whoop_recoveries WHERE user_id = ?', args: [ALICE.id],
    });
    assert.equal(Number(rows.rows[0].n), 0, '★★★ 缺資料就是缺，絕不可以寫出 0');
    assert.equal((await db.getWhoopEvent(id)).state, WHOOP_EVENT_STATE.IGNORED);
  } finally { cleanup(); }
});

// ===========================================================================
// 使用者解析
// ===========================================================================

test('★★★ 未知 WHOOP 使用者 → IGNORED，而且一個生理欄位都不動', async () => {
  const { db, cleanup } = tempDb();
  try {
    await seed(db);
    const id = await insertEvent(db, { whoopUserId: '999999' });
    let called = false;
    const whoopFor = fakeWhoop({ onCall: () => { called = true; } });
    const event = await claim(db, 'owner-A');
    const r = await processWhoopEvent({ db, event, owner: 'owner-A', whoopFor });
    assert.equal(r.result, PROCESS_RESULT.IGNORED_UNKNOWN_USER);
    assert.equal(called, false, '★ 連 API 都不該打');
    const ev = await db.getWhoopEvent(id);
    assert.equal(ev.state, WHOOP_EVENT_STATE.IGNORED);
    assert.equal(ev.userId, null);
    assert.equal(ev.lastErrorClass, 'unknown_user', '★ 要可診斷');
  } finally { cleanup(); }
});

test('★★★ 曖昧綁定：結構上被唯一索引擋住（第一道防線）', async () => {
  const { db, cleanup } = tempDb();
  try {
    await seed(db, [ALICE]);
    await db.createUser({ id: BOB.id, displayName: 'Bob', timezone: TZ });
    // 想把同一個 WHOOP 帳號綁到第二個本地使用者 → partial unique index 直接拒絕。
    await assert.rejects(
      () => db.raw.execute({
        sql: `INSERT INTO user_whoop_tokens
                (user_id, whoop_user_id, access_token, refresh_token,
                 access_token_expires_at, scope, updated_at)
              VALUES (?, ?, 'a', 'r', ?, 'offline', ?)`,
        args: [BOB.id, ALICE.whoop, new Date(Date.now() + 3_600_000).toISOString(),
          new Date().toISOString()],
      }),
      /UNIQUE constraint failed/,
      '★★★ 同一個 WHOOP 帳號不可以綁到兩個本地使用者',
    );
    // 解析仍然明確指向唯一那一個人。
    const r = await db.resolveUserByWhoopUserId(ALICE.whoop);
    assert.equal(r.status, 'resolved');
    assert.equal(r.userId, ALICE.id);
  } finally { cleanup(); }
});

test('★★★ 曖昧綁定：萬一索引之前的舊資料真的造出兩筆 → fail closed（第二道防線）', async () => {
  // 唯一索引是 v6 之後才加的，舊資料可能早於它。所以解析層**不可以**假設
  // 索引一定成立 —— 這一題直接驗那條路徑：多於一筆就不猜、不動任何資料。
  const fakeClient = {
    execute: async () => ({
      rows: [
        { user_id: 'u-alice', status: 'ACTIVE', timezone: TZ, display_name: 'A' },
        { user_id: 'u-bob', status: 'ACTIVE', timezone: TZ, display_name: 'B' },
      ],
    }),
  };
  const { createWhoopWebhookStore } = await import('../src/whoopWebhookStore.js');
  const store = createWhoopWebhookStore(fakeClient);
  const r = await store.resolveUserByWhoopUserId('1001');
  assert.equal(r.status, 'ambiguous');
  assert.equal(r.count, 2);
});

test('★★★ 曖昧綁定 → 事件進終局 FAILED，而且一個生理欄位都不動', async () => {
  const { db, cleanup } = tempDb();
  try {
    await seed(db);
    const id = await insertEvent(db);
    const event = await claim(db, 'owner-A');
    // 直接注入曖昧解析（模擬索引之前的舊資料）。
    const ambiguousDb = {
      ...db,
      resolveUserByWhoopUserId: async () => ({ status: 'ambiguous', count: 2 }),
    };
    let called = false;
    const r = await processWhoopEvent({
      db: ambiguousDb, event, owner: 'owner-A',
      whoopFor: fakeWhoop({ onCall: () => { called = true; } }),
    });
    assert.equal(r.result, PROCESS_RESULT.FAILED);
    assert.equal(r.reason, 'ambiguous_user');
    assert.equal(called, false, '★ 連 API 都不該打');
    const ev = await db.getWhoopEvent(id);
    assert.equal(ev.state, WHOOP_EVENT_STATE.FAILED, '★ 終局，不會無限重試');
    assert.equal(ev.lastErrorClass, 'ambiguous_user');
    assert.equal(await sleepRow(db, ALICE.id), null, '★★★ 絕不動任何人的生理資料');
  } finally { cleanup(); }
});

test('★★★ 多使用者隔離：Alice 的事件絕不可能寫到 Bob 身上', async () => {
  const { db, cleanup } = tempDb();
  try {
    await seed(db, [ALICE, BOB]);
    // 兩個人的資源 id **完全相同** —— 這是最容易寫錯的情況。
    await insertEvent(db, { whoopUserId: ALICE.whoop, traceId: 'trace-alice' });
    const whoopFor = fakeWhoop({
      routes: { [`/activity/sleep/${SLEEP_ID}`]: sleepRecord('2026-09-12T10:00:00.000Z', 42) },
    });
    const event = await claim(db, 'owner-A');
    await processWhoopEvent({ db, event, owner: 'owner-A', whoopFor });

    assert.equal(Number((await sleepRow(db, ALICE.id)).respiratory_rate), 42);
    assert.equal(await sleepRow(db, BOB.id), null, '★★★ Bob 那邊必須什麼都沒有');
  } finally { cleanup(); }
});

// ===========================================================================
// 認領 / 租約 / 圍欄
// ===========================================================================

test('★★★ 同一則事件同時只有一個擁有者', async () => {
  const { db, cleanup } = tempDb();
  try {
    await seed(db);
    await insertEvent(db);
    const a = await claim(db, 'owner-A');
    const b = await claim(db, 'owner-B');
    assert.ok(a, 'A 拿到');
    assert.equal(b, null, '★ B 不可以同時拿到');
  } finally { cleanup(); }
});

test('★★★ A 租約過期 → B 接手 → A 恢復執行時被圍欄擋下（且不覆蓋 B 的結果）', async () => {
  const { db, cleanup } = tempDb();
  try {
    await seed(db);
    const id = await insertEvent(db);
    const t0 = new Date('2026-09-12T10:00:00.000Z');
    const a = await claim(db, 'owner-A', { leaseMs: 60_000, now: t0 });
    assert.ok(a);

    // 租約過期之後 B 接手（崩潰復原路徑）。
    const later = new Date(t0.getTime() + 61_000);
    const b = await claim(db, 'owner-B', { leaseMs: 60_000, now: later });
    assert.ok(b, '★ 過期的 PROCESSING 必須可以被接手');
    assert.equal(b.id, a.id);

    // A 醒過來：所有權檢查與結案都必須失敗。
    assert.equal(await db.holdsWhoopEvent(id, 'owner-A', { now: later }), false);
    assert.equal(await db.settleWhoopEvent(id, {
      owner: 'owner-A', state: WHOOP_EVENT_STATE.PROCESSED, now: later,
    }), false, '★★★ 失去所有權就寫不進任何狀態');

    // B 正常結案。
    assert.equal(await db.settleWhoopEvent(id, {
      owner: 'owner-B', state: WHOOP_EVENT_STATE.PROCESSED, userId: ALICE.id, now: later,
    }), true);
    assert.equal((await db.getWhoopEvent(id)).state, WHOOP_EVENT_STATE.PROCESSED);
  } finally { cleanup(); }
});

test('★★★ 端到端圍欄：A 在打 API 期間失去所有權 → 不寫 canonical', async () => {
  const { db, cleanup } = tempDb();
  try {
    await seed(db);
    const id = await insertEvent(db);
    const t0 = new Date('2026-09-12T10:00:00.000Z');
    const a = await claim(db, 'owner-A', { leaseMs: 60_000, now: t0 });

    // 在 A 打 API 的當下，B 接手（模擬 A 卡住、租約過期）。
    const later = new Date(t0.getTime() + 61_000);
    const whoopFor = fakeWhoop({
      routes: { [`/activity/sleep/${SLEEP_ID}`]: sleepRecord('2026-09-12T10:00:00.000Z', 42) },
      onCall: async () => { await db.claimWhoopEvent({ owner: 'owner-B', leaseMs: 60_000, now: later }); },
    });
    const r = await processWhoopEvent({
      db, event: a, owner: 'owner-A', whoopFor, now: () => later,
    });
    assert.equal(r.result, PROCESS_RESULT.FENCED, '★★★ 失去所有權就不可以寫');
    assert.equal(await sleepRow(db, ALICE.id), null, '★ canonical 一個字都沒被寫');
    assert.equal((await db.getWhoopEvent(id)).owner, 'owner-B', '★ 事件屬於接手者');
  } finally { cleanup(); }
});

test('★★★ 終局狀態永遠不會被復活', async () => {
  const { db, cleanup } = tempDb();
  try {
    await seed(db);
    for (const state of [WHOOP_EVENT_STATE.PROCESSED, WHOOP_EVENT_STATE.IGNORED,
      WHOOP_EVENT_STATE.FAILED]) {
      const id = await insertEvent(db, { traceId: `t-${state}` });
      const e = await claim(db, `o-${state}`);
      await db.settleWhoopEvent(e.id, { owner: `o-${state}`, state, userId: ALICE.id });
      assert.equal((await db.getWhoopEvent(id)).state, state);
      // 一年後、租約早就過期 —— 仍然不可以被重新認領。
      const future = new Date(Date.now() + 365 * 86_400_000);
      const again = await claim(db, 'owner-X', { now: future });
      assert.equal(again, null, `★★★ ${state} 是終局，不可以被重新認領`);
    }
  } finally { cleanup(); }
});

// ===========================================================================
// WHOOP API 失敗語義
// ===========================================================================

test('★★★ 錯誤分類：可重試 vs 終局', () => {
  assert.deepEqual(classifyWhoopError(new WhoopApiError('x', 429)),
    { class: ERROR_CLASS.RATE_LIMIT, retryable: true });
  assert.deepEqual(classifyWhoopError(new WhoopApiError('x', 500)),
    { class: ERROR_CLASS.SERVER, retryable: true });
  assert.deepEqual(classifyWhoopError(new WhoopApiError('x', 0)),
    { class: ERROR_CLASS.NETWORK, retryable: true });
  assert.deepEqual(classifyWhoopError(new WhoopApiError('x', 404)),
    { class: ERROR_CLASS.NOT_FOUND, retryable: false, gone: true });
  assert.deepEqual(classifyWhoopError(new WhoopApiError('x', 403)),
    { class: ERROR_CLASS.FORBIDDEN, retryable: false });
  assert.deepEqual(classifyWhoopError(new WhoopApiError('x', 400)),
    { class: ERROR_CLASS.CLIENT, retryable: false });
  assert.equal(classifyWhoopError(new WhoopAuthError('x')).retryable, true);
  assert.equal(classifyWhoopError(new SyntaxError('Unexpected token')).class, ERROR_CLASS.MALFORMED);
});

test('★★★ 每一種 API 失敗都不會變成生理上的 0', async () => {
  const cases = [
    ['429', new WhoopApiError('rate', 429), WHOOP_EVENT_STATE.RETRY],
    ['500', new WhoopApiError('server', 500), WHOOP_EVENT_STATE.RETRY],
    ['網路逾時', new WhoopApiError('timeout', 0), WHOOP_EVENT_STATE.RETRY],
    ['401 refresh 後仍失敗', new WhoopAuthError('auth'), WHOOP_EVENT_STATE.RETRY],
    ['403 scope', new WhoopApiError('scope', 403), WHOOP_EVENT_STATE.FAILED],
    ['404 資源不存在', new WhoopApiError('gone', 404), WHOOP_EVENT_STATE.IGNORED],
    ['回應壞掉', new SyntaxError('Unexpected end of JSON input'), WHOOP_EVENT_STATE.RETRY],
  ];
  for (const [label, err, expected] of cases) {
    const { db, cleanup } = tempDb();
    try {
      await seed(db);
      const id = await insertEvent(db);
      const whoopFor = fakeWhoop({ routes: { [`/activity/sleep/${SLEEP_ID}`]: err } });
      const event = await claim(db, 'owner-A');
      await processWhoopEvent({ db, event, owner: 'owner-A', whoopFor });
      const ev = await db.getWhoopEvent(id);
      assert.equal(ev.state, expected, `★ ${label}`);
      assert.equal(await sleepRow(db, ALICE.id), null,
        `★★★ ${label}：API 失敗絕不可以寫出任何 canonical 列`);
    } finally { cleanup(); }
  }
});

test('★★★ 回應的 id 對不上 → 當成壞回應，絕不寫入', async () => {
  const { db, cleanup } = tempDb();
  try {
    await seed(db);
    await insertEvent(db);
    // WHOOP 回了 200，但內容是**別筆**睡眠。
    const whoopFor = fakeWhoop({
      routes: {
        [`/activity/sleep/${SLEEP_ID}`]: sleepRecord('2026-09-12T10:00:00.000Z', 42, 'a-different-id'),
      },
    });
    const event = await claim(db, 'owner-A');
    const r = await processWhoopEvent({ db, event, owner: 'owner-A', whoopFor });
    assert.equal(r.result, PROCESS_RESULT.RETRY);
    assert.equal(await sleepRow(db, ALICE.id), null, '★★★ 絕不可以把別人的資料寫進來');
  } finally { cleanup(); }
});

test('★★★ 重試有上限：用完就進終局 FAILED（不會變成重試風暴）', async () => {
  const { db, cleanup } = tempDb();
  try {
    await seed(db);
    const id = await insertEvent(db);
    const whoopFor = fakeWhoop({
      routes: { [`/activity/sleep/${SLEEP_ID}`]: new WhoopApiError('server', 500) },
    });
    let guard = 0;
    for (;;) {
      const event = await claim(db, `o-${guard}`, { now: new Date(Date.now() + guard * 3_600_000) });
      if (!event) break;
      await processWhoopEvent({
        db, event, owner: `o-${guard}`, whoopFor,
        now: () => new Date(Date.now() + guard * 3_600_000),
      });
      guard += 1;
      assert.ok(guard < 20, '★ 必須收斂');
    }
    const ev = await db.getWhoopEvent(id);
    assert.equal(ev.state, WHOOP_EVENT_STATE.FAILED, '★★★ 最終必須是終局');
    assert.ok(ev.attemptCount <= WHOOP_WEBHOOK.MAX_ATTEMPTS + 1,
      `★ 嘗試次數要有上限（實際 ${ev.attemptCount}）`);
  } finally { cleanup(); }
});

// ===========================================================================
// DELETED / 墓碑
// ===========================================================================

async function seedSleepRow(db, userId, updatedAt, rr = 20) {
  await db.upsertSleeps(userId, [sleepRecord(updatedAt, rr)], { timezone: TZ });
}

test('★★★ sleep.deleted：立墓碑 + 移除 canonical（分析層看到的是「缺」不是 0）', async () => {
  const { db, cleanup } = tempDb();
  try {
    await seed(db);
    await seedSleepRow(db, ALICE.id, '2026-09-12T10:00:00.000Z');
    assert.ok(await sleepRow(db, ALICE.id));

    const id = await insertEvent(db, { eventType: 'sleep.deleted', traceId: 'del-1' });
    const event = await claim(db, 'owner-A');
    const r = await processWhoopEvent({ db, event, owner: 'owner-A', whoopFor: fakeWhoop() });

    assert.equal(r.result, PROCESS_RESULT.DELETED);
    assert.equal(await sleepRow(db, ALICE.id), null, '★ canonical 列被移除');
    const tomb = await db.getTombstone(ALICE.id, 'sleep', SLEEP_ID);
    assert.equal(tomb.state, TOMBSTONE_STATE.ACTIVE);
    assert.equal(tomb.lastKnownUpdatedAt, '2026-09-12T10:00:00.000Z',
      '★★★ 必須記下刪除當下那一版的 updated_at');
    assert.equal((await db.getWhoopEvent(id)).state, WHOOP_EVENT_STATE.PROCESSED);
  } finally { cleanup(); }
});

test('★★★ 重複 DELETE 是冪等的', async () => {
  const { db, cleanup } = tempDb();
  try {
    await seed(db);
    await seedSleepRow(db, ALICE.id, '2026-09-12T10:00:00.000Z');
    for (let i = 0; i < 3; i += 1) {
      await insertEvent(db, { eventType: 'sleep.deleted', traceId: `del-${i}` });
      const event = await claim(db, `o-${i}`);
      const r = await processWhoopEvent({ db, event, owner: `o-${i}`, whoopFor: fakeWhoop() });
      assert.equal(r.result, PROCESS_RESULT.DELETED, `第 ${i + 1} 次`);
    }
    const tombs = await db.raw.execute({
      sql: 'SELECT COUNT(*) n FROM whoop_resource_tombstones WHERE user_id = ?', args: [ALICE.id],
    });
    assert.equal(Number(tombs.rows[0].n), 1, '★ 只可以有一個墓碑');
    assert.equal(await sleepRow(db, ALICE.id), null);
  } finally { cleanup(); }
});

test('★★★ DELETE 之後重播舊的 UPDATE → 絕不復活', async () => {
  const { db, cleanup } = tempDb();
  try {
    await seed(db);
    await seedSleepRow(db, ALICE.id, '2026-09-12T10:00:00.000Z', 20);

    // 刪除
    await insertEvent(db, { eventType: 'sleep.deleted', traceId: 'del-1' });
    const delEvent = await claim(db, 'owner-D');
    await processWhoopEvent({ db, event: delEvent, owner: 'owner-D', whoopFor: fakeWhoop() });
    assert.equal(await sleepRow(db, ALICE.id), null);

    // 之後一則**比較舊**的 UPDATE 重播（WHOOP 仍然回得出資料）
    const id = await insertEvent(db, { eventType: 'sleep.updated', traceId: 'old-update' });
    const whoopFor = fakeWhoop({
      routes: { [`/activity/sleep/${SLEEP_ID}`]: sleepRecord('2026-09-12T09:00:00.000Z', 99) },
    });
    const upEvent = await claim(db, 'owner-U');
    await processWhoopEvent({ db, event: upEvent, owner: 'owner-U', whoopFor });

    assert.equal(await sleepRow(db, ALICE.id), null,
      '★★★ 已刪除的資料絕不可以被舊的重播復活');
    assert.equal((await db.getWhoopEvent(id)).state, WHOOP_EVENT_STATE.PROCESSED,
      '★ 事件本身正常結案（被擋下不是失敗）');
    const tomb = await db.getTombstone(ALICE.id, 'sleep', SLEEP_ID);
    assert.equal(tomb.state, TOMBSTONE_STATE.ACTIVE);
    assert.ok(tomb.blockedCount >= 1, '★ 要留下「有東西想復活但被擋下」的痕跡');
  } finally { cleanup(); }
});

test('★★★ 來源真相證明它之後又更新了 → 墓碑讓位（可證明才放行）', async () => {
  const { db, cleanup } = tempDb();
  try {
    await seed(db);
    await seedSleepRow(db, ALICE.id, '2026-09-12T10:00:00.000Z', 20);
    await insertEvent(db, { eventType: 'sleep.deleted', traceId: 'del-1' });
    const delEvent = await claim(db, 'owner-D');
    await processWhoopEvent({ db, event: delEvent, owner: 'owner-D', whoopFor: fakeWhoop() });

    // 這一版的 updated_at **嚴格大於**刪除當下那一版，**而且**這則通知是
    // 在刪除通知之後才收到的（帳本 id 較大）→ 兩個證據都成立。
    await insertEvent(db, { eventType: 'sleep.updated', traceId: 'newer-update' });
    const whoopFor = fakeWhoop({
      routes: { [`/activity/sleep/${SLEEP_ID}`]: sleepRecord('2026-09-12T11:00:00.000Z', 55) },
    });
    const upEvent = await claim(db, 'owner-U');
    await processWhoopEvent({ db, event: upEvent, owner: 'owner-U', whoopFor });

    const row = await sleepRow(db, ALICE.id);
    assert.ok(row, '★ 可證明的重建要放行');
    assert.equal(Number(row.respiratory_rate), 55);
    const tomb = await db.getTombstone(ALICE.id, 'sleep', SLEEP_ID);
    assert.equal(tomb.state, TOMBSTONE_STATE.SUPERSEDED, '★ 墓碑讓位但保留紀錄');
  } finally { cleanup(); }
});

test('★★★ 刪除時本地沒有那一列 → 證明不了新舊 → 一律擋（保守）', async () => {
  const { db, cleanup } = tempDb();
  try {
    await seed(db);
    // 本地根本沒有這筆睡眠就收到刪除事件。
    await insertEvent(db, { eventType: 'sleep.deleted', traceId: 'del-unknown' });
    const delEvent = await claim(db, 'owner-D');
    await processWhoopEvent({ db, event: delEvent, owner: 'owner-D', whoopFor: fakeWhoop() });
    const tomb = await db.getTombstone(ALICE.id, 'sleep', SLEEP_ID);
    assert.equal(tomb.lastKnownUpdatedAt, null);

    // 之後任何 UPDATE 都證明不了自己比較新 → 擋掉。
    await insertEvent(db, { eventType: 'sleep.updated', traceId: 'after' });
    const whoopFor = fakeWhoop({
      routes: { [`/activity/sleep/${SLEEP_ID}`]: sleepRecord('2030-01-01T00:00:00.000Z', 77) },
    });
    const upEvent = await claim(db, 'owner-U');
    await processWhoopEvent({ db, event: upEvent, owner: 'owner-U', whoopFor });
    assert.equal(await sleepRow(db, ALICE.id), null,
      '★★★ 證明不了就 fail closed（已知限制，見 docs/whoop-webhook.md）');
  } finally { cleanup(); }
});

test('★★★ UPDATE 與 DELETE 併發：刪除**之前**就在路上的通知不可以復活資料', async () => {
  // 這一題是墓碑規則裡最難的一個：U 取到的資料**確實比刪除時那一版新**，
  // 只比版本的話會復活。擋得住的唯一依據是「WHOOP 先告訴我們哪一件事」
  // —— 也就是事件帳本的 id 順序。
  const { db, cleanup } = tempDb();
  try {
    await seed(db);
    await seedSleepRow(db, ALICE.id, '2026-09-12T10:00:00.000Z', 20);

    // UPDATE 的通知**先**到（id 較小），DELETE 後到（id 較大）。
    const updId = await insertEvent(db, { eventType: 'sleep.updated', traceId: 'u1' });
    const delId = await insertEvent(db, { eventType: 'sleep.deleted', traceId: 'd1' });
    assert.ok(updId < delId);

    // U 先認領 UPDATE 但還在慢慢打 API；這期間 D 處理完 DELETE。
    const uEv = await claim(db, 'U', { leaseMs: 600_000 });
    assert.equal(uEv.id, updId);
    const dEv = await claim(db, 'D', { leaseMs: 600_000 });
    assert.equal(dEv.id, delId);
    await processWhoopEvent({ db, event: dEv, owner: 'D', whoopFor: fakeWhoop() });
    assert.equal(await sleepRow(db, ALICE.id), null);

    // U 現在才回來，手上是 T2（> 刪除時的 T1）。
    await processWhoopEvent({
      db, event: uEv, owner: 'U',
      whoopFor: fakeWhoop({
        routes: { [`/activity/sleep/${SLEEP_ID}`]: sleepRecord('2026-09-12T10:30:00.000Z', 99) },
      }),
    });

    assert.equal(await sleepRow(db, ALICE.id), null,
      '★★★ 刪除之前就在路上的通知絕不可以復活已刪除的資料');
    assert.equal((await db.getTombstone(ALICE.id, 'sleep', SLEEP_ID)).state, TOMBSTONE_STATE.ACTIVE);
  } finally { cleanup(); }
});

test('★★★ 排程同步**永遠**無法讓墓碑退位（它沒有事件順序可以證明）', async () => {
  const { db, cleanup } = tempDb();
  try {
    await seed(db);
    await seedSleepRow(db, ALICE.id, '2026-09-12T10:00:00.000Z', 20);
    await insertEvent(db, { eventType: 'sleep.deleted', traceId: 'd1' });
    const dEv = await claim(db, 'D');
    await processWhoopEvent({ db, event: dEv, owner: 'D', whoopFor: fakeWhoop() });

    // 排程同步拿到一個**比較新**的版本 —— 只比版本的話會復活。
    const written = await db.upsertSleeps(
      ALICE.id, [sleepRecord('2030-01-01T00:00:00.000Z', 99)], { timezone: TZ },
    );
    assert.equal(written, 0, '★★★ 排程同步不可以復活已刪除的資源');
    assert.equal(await sleepRow(db, ALICE.id), null);
    assert.equal((await db.getTombstone(ALICE.id, 'sleep', SLEEP_ID)).state, TOMBSTONE_STATE.ACTIVE,
      '★ 墓碑必須still ACTIVE');
  } finally { cleanup(); }
});

test('★★★ 墓碑是 per-user 的：Alice 刪除不影響 Bob 的同 id 資源', async () => {
  const { db, cleanup } = tempDb();
  try {
    await seed(db, [ALICE, BOB]);
    await seedSleepRow(db, ALICE.id, '2026-09-12T10:00:00.000Z', 20);
    await seedSleepRow(db, BOB.id, '2026-09-12T10:00:00.000Z', 30);

    await insertEvent(db, { eventType: 'sleep.deleted', traceId: 'del-alice' });
    const e = await claim(db, 'owner-D');
    await processWhoopEvent({ db, event: e, owner: 'owner-D', whoopFor: fakeWhoop() });

    assert.equal(await sleepRow(db, ALICE.id), null, '★ Alice 的被刪掉');
    const bob = await sleepRow(db, BOB.id);
    assert.ok(bob, '★★★ Bob 的**完全不受影響**');
    assert.equal(Number(bob.respiratory_rate), 30);
    assert.equal(await db.getTombstone(BOB.id, 'sleep', SLEEP_ID), null);
  } finally { cleanup(); }
});

test('★★★ recovery / workout 的刪除也各自正確', async () => {
  const { db, cleanup } = tempDb();
  try {
    await seed(db);
    await db.upsertRecoveries(ALICE.id, [recoveryRecord('2026-09-12T10:00:00.000Z', 60)]);
    const wid = 'wwwwwwww-0000-4000-8000-000000000001';
    await db.upsertWorkouts(ALICE.id, [workoutRecord('2026-09-12T10:00:00.000Z', 12, wid)],
      { timezone: TZ });

    await insertEvent(db, {
      eventType: 'recovery.deleted', resourceType: 'recovery', resourceId: SLEEP_ID, traceId: 'dr',
    });
    const e1 = await claim(db, 'o1');
    assert.equal((await processWhoopEvent({ db, event: e1, owner: 'o1', whoopFor: fakeWhoop() })).result,
      PROCESS_RESULT.DELETED);

    await insertEvent(db, {
      eventType: 'workout.deleted', resourceType: 'workout', resourceId: wid, traceId: 'dw',
    });
    const e2 = await claim(db, 'o2');
    assert.equal((await processWhoopEvent({ db, event: e2, owner: 'o2', whoopFor: fakeWhoop() })).result,
      PROCESS_RESULT.DELETED);

    for (const [table, n] of [['whoop_recoveries', 0], ['whoop_workouts', 0]]) {
      const rs = await db.raw.execute({
        sql: `SELECT COUNT(*) n FROM ${table} WHERE user_id = ?`, args: [ALICE.id],
      });
      assert.equal(Number(rs.rows[0].n), n, `★ ${table} 應該空了`);
    }
    assert.equal((await db.getTombstone(ALICE.id, 'recovery', SLEEP_ID)).state, TOMBSTONE_STATE.ACTIVE);
    assert.equal((await db.getTombstone(ALICE.id, 'workout', wid)).state, TOMBSTONE_STATE.ACTIVE);
  } finally { cleanup(); }
});

// ===========================================================================
// 亂序 / 與排程同步共存
// ===========================================================================

test('★★★ 亂序：新版本先到、舊版本後到 → 新的留著', async () => {
  const { db, cleanup } = tempDb();
  try {
    await seed(db);
    // 先寫入新版本（webhook 處理完）
    await insertEvent(db, { traceId: 'newer' });
    const e1 = await claim(db, 'o1');
    await processWhoopEvent({
      db, event: e1, owner: 'o1',
      whoopFor: fakeWhoop({ routes: { [`/activity/sleep/${SLEEP_ID}`]: sleepRecord('2026-09-12T11:00:00.000Z', 99) } }),
    });
    assert.equal(Number((await sleepRow(db, ALICE.id)).respiratory_rate), 99);

    // 舊版本後到（例如排程同步拿到快取）
    await insertEvent(db, { traceId: 'older' });
    const e2 = await claim(db, 'o2');
    await processWhoopEvent({
      db, event: e2, owner: 'o2',
      whoopFor: fakeWhoop({ routes: { [`/activity/sleep/${SLEEP_ID}`]: sleepRecord('2026-09-12T10:00:00.000Z', 11) } }),
    });
    const row = await sleepRow(db, ALICE.id);
    assert.equal(Number(row.respiratory_rate), 99, '★★★ 舊版本不可以蓋掉新版本');
    assert.equal(row.updated_at, '2026-09-12T11:00:00.000Z');
  } finally { cleanup(); }
});

test('★★★ 亂序：舊版本先到、新版本後到 → 新的贏；相同版本重放 → 冪等', async () => {
  const { db, cleanup } = tempDb();
  try {
    await seed(db);
    const run = async (trace, updatedAt, rr) => {
      await insertEvent(db, { traceId: trace });
      const e = await claim(db, `o-${trace}`);
      await processWhoopEvent({
        db, event: e, owner: `o-${trace}`,
        whoopFor: fakeWhoop({ routes: { [`/activity/sleep/${SLEEP_ID}`]: sleepRecord(updatedAt, rr) } }),
      });
    };
    await run('a', '2026-09-12T10:00:00.000Z', 11);
    await run('b', '2026-09-12T11:00:00.000Z', 22);
    assert.equal(Number((await sleepRow(db, ALICE.id)).respiratory_rate), 22, '★ 新的要贏');
    await run('c', '2026-09-12T11:00:00.000Z', 22);
    assert.equal(Number((await sleepRow(db, ALICE.id)).respiratory_rate), 22, '★ 相同版本冪等');
    const count = await db.raw.execute({
      sql: 'SELECT COUNT(*) n FROM whoop_sleeps WHERE user_id = ?', args: [ALICE.id],
    });
    assert.equal(Number(count.rows[0].n), 1, '★ 不可以長出第二列');
  } finally { cleanup(); }
});

test('★★★ 排程同步不可以復活已刪除的資源（兩條路共用同一個墓碑守衛）', async () => {
  const { db, cleanup } = tempDb();
  try {
    await seed(db);
    await seedSleepRow(db, ALICE.id, '2026-09-12T10:00:00.000Z', 20);
    await insertEvent(db, { eventType: 'sleep.deleted', traceId: 'del' });
    const e = await claim(db, 'owner-D');
    await processWhoopEvent({ db, event: e, owner: 'owner-D', whoopFor: fakeWhoop() });
    assert.equal(await sleepRow(db, ALICE.id), null);

    // 排程同步（直接走既有的儲存層，與 webhook 是不同的呼叫者）
    const written = await db.upsertSleeps(ALICE.id, [sleepRecord('2026-09-12T10:00:00.000Z', 20)],
      { timezone: TZ });
    assert.equal(written, 0, '★★★ 排程同步也必須被墓碑擋下');
    assert.equal(await sleepRow(db, ALICE.id), null);

    // 而且排程同步**不會**抹掉墓碑
    assert.equal((await db.getTombstone(ALICE.id, 'sleep', SLEEP_ID)).state, TOMBSTONE_STATE.ACTIVE);
  } finally { cleanup(); }
});

test('★★★ 沒有墓碑時，既有的同步行為一個字都沒變', async () => {
  const { db, cleanup } = tempDb();
  try {
    await seed(db);
    assert.equal(await db.upsertSleeps(ALICE.id, [sleepRecord('2026-09-12T10:00:00.000Z', 15)],
      { timezone: TZ }), 1);
    assert.equal(await db.upsertSleeps(ALICE.id, [sleepRecord('2026-09-12T11:00:00.000Z', 16)],
      { timezone: TZ }), 1, '★ 新版本照常更新');
    assert.equal(await db.upsertSleeps(ALICE.id, [sleepRecord('2026-09-12T09:00:00.000Z', 17)],
      { timezone: TZ }), 0, '★ 舊版本照常被新鮮度守衛擋下');
    assert.equal(Number((await sleepRow(db, ALICE.id)).respiratory_rate), 16);
  } finally { cleanup(); }
});

// ===========================================================================
// 排空 / 崩潰復原
// ===========================================================================

test('★★★ 排空：一次處理多則，結果分類正確', async () => {
  const { db, cleanup } = tempDb();
  try {
    await seed(db);
    await insertEvent(db, { traceId: 'ok' });
    await insertEvent(db, { traceId: 'unknown', whoopUserId: '404404' });
    const whoopFor = fakeWhoop({
      routes: { [`/activity/sleep/${SLEEP_ID}`]: sleepRecord('2026-09-12T10:00:00.000Z', 42) },
    });
    const summary = await drainWhoopWebhookEvents({ db, whoopFor, owner: 'drain-1' });
    assert.equal(summary.claimed, 2);
    assert.equal(summary.results[PROCESS_RESULT.PERSISTED], 1);
    assert.equal(summary.results[PROCESS_RESULT.IGNORED_UNKNOWN_USER], 1);
    // 再排空一次：全部終局，沒有東西可做。
    const again = await drainWhoopWebhookEvents({ db, whoopFor, owner: 'drain-2' });
    assert.equal(again.claimed, 0, '★ 終局不可以被重新處理');
  } finally { cleanup(); }
});

test('★★★ 崩潰復原：認領後死掉 → 租約過期 → 重新排空把它做完', async () => {
  const { db, cleanup } = tempDb();
  try {
    await seed(db);
    const id = await insertEvent(db);
    const t0 = new Date('2026-09-12T10:00:00.000Z');
    // 認領後「死掉」（什麼都沒做）
    await claim(db, 'dead-owner', { leaseMs: 60_000, now: t0 });
    assert.equal((await db.getWhoopEvent(id)).state, WHOOP_EVENT_STATE.PROCESSING);

    const later = new Date(t0.getTime() + 120_000);
    const whoopFor = fakeWhoop({
      routes: { [`/activity/sleep/${SLEEP_ID}`]: sleepRecord('2026-09-12T10:00:00.000Z', 42) },
    });
    const summary = await drainWhoopWebhookEvents({
      db, whoopFor, owner: 'restarted', now: () => later,
    });
    assert.equal(summary.claimed, 1, '★★★ 重啟之後必須撿得回來');
    assert.equal((await db.getWhoopEvent(id)).state, WHOOP_EVENT_STATE.PROCESSED);
    assert.equal(Number((await sleepRow(db, ALICE.id)).respiratory_rate), 42);
  } finally { cleanup(); }
});

test('★★★ 崩潰復原：canonical 已寫入但事件還沒結案 → 重做不會產生第二列', async () => {
  const { db, cleanup } = tempDb();
  try {
    await seed(db);
    const id = await insertEvent(db);
    const t0 = new Date('2026-09-12T10:00:00.000Z');
    const a = await claim(db, 'owner-A', { leaseMs: 60_000, now: t0 });
    // 模擬「寫完 canonical 之後、結案之前」死掉
    await db.upsertSleeps(ALICE.id, [sleepRecord('2026-09-12T10:00:00.000Z', 42)], { timezone: TZ });
    assert.equal(a.id, id);

    const later = new Date(t0.getTime() + 120_000);
    const whoopFor = fakeWhoop({
      routes: { [`/activity/sleep/${SLEEP_ID}`]: sleepRecord('2026-09-12T10:00:00.000Z', 42) },
    });
    await drainWhoopWebhookEvents({ db, whoopFor, owner: 'restarted', now: () => later });

    const count = await db.raw.execute({
      sql: 'SELECT COUNT(*) n FROM whoop_sleeps WHERE user_id = ?', args: [ALICE.id],
    });
    assert.equal(Number(count.rows[0].n), 1, '★★★ 重做不可以產生重複的 canonical 列');
    assert.equal((await db.getWhoopEvent(id)).state, WHOOP_EVENT_STATE.PROCESSED);
  } finally { cleanup(); }
});
