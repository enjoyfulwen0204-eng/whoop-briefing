/**
 * V1.2 Phase 2 — 修復週期 1（P2-R01 … P2-R05）。
 *
 *   R01 畸形集合回應絕不是「空的成功」：FAILED、水位不動、不記缺席、不寫 canonical
 *   R02 續傳失敗不能丟掉原本的邏輯窗：同一個 [from, to] 從第一頁重來
 *   R03 有界的深度掃描：每天一片 30 天歷史切片，補回超過 5 天重疊的舊版本（含 cycle）
 *   R04 續傳完成的窗不產生缺席證據（那不是整個窗的觀察集合）
 *   R05 手動執行器用 schema_version（遷移系統的權威）判斷版本，在任何網路工作之前
 *
 * 全部用真實 libSQL（本機檔案）與可編程的假 WHOOP client；R05 用子行程跑真的
 * scripts/reconcile.js，cwd 是沒有 .env 的暫存目錄（絕不載入正式憑證）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { createDb } from '../src/db.js';
import {
  createReconciler, validateCollectionPage, nextDeepSlice, deepResourceKey, isReconcileDue, hasPendingWindow, ERROR_CLASS,
} from '../src/reconcile.js';
import { currentVersion } from '../src/migrations.js';
import { RECONCILE_RESULT, TOMBSTONE_STATE, SCHEMA_VERSION } from '../src/schema.js';
import { WhoopApiError } from '../src/whoop.js';
import { WHOOP_RECONCILE, WHOOP } from '../src/config.js';

const TZ = 'Asia/Taipei';
const ALICE = { id: 'u-alice', whoop: '1001' };
const BOB = { id: 'u-bob', whoop: '2002' };
const NOW = new Date('2026-09-15T12:00:00.000Z');
const DAY = 86_400_000;
const HOUR = 3_600_000;
const DEEP = WHOOP_RECONCILE.DEEP;
const SCRIPT = path.resolve(new URL('../scripts/reconcile.js', import.meta.url).pathname);

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whoop-rc1-'));
  return { dir, url: `file:${path.join(dir, 't.db')}`, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

async function env(users = [ALICE]) {
  const t = tempDir();
  const db = createDb({ url: t.url });
  await db.migrate();
  for (const u of users) {
    await db.createUser({ id: u.id, displayName: u.id, timezone: TZ });
    await db.saveTokens(u.id, {
      accessToken: `a-${u.id}`, refreshToken: `r-${u.id}`,
      expiresAt: new Date(Date.now() + HOUR), scope: 'offline', whoopUserId: u.whoop,
    });
  }
  return { db, url: t.url, dir: t.dir, done: () => { try { db.close(); } catch { /* ignore */ } t.cleanup(); } };
}

const sid = (n) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`;
const at = (d, h = 0) => new Date(NOW.getTime() - d * DAY + h * HOUR).toISOString();

const sleepRecord = ({ id = sid(1), updatedAt = at(2), rr = 15, start = at(2, -8) } = {}) => ({
  id, nap: false, score_state: 'SCORED', user_id: 1,
  start, end: new Date(Date.parse(start) + 8 * HOUR).toISOString(),
  created_at: updatedAt, updated_at: updatedAt,
  score: { respiratory_rate: rr, stage_summary: { total_light_sleep_time_milli: 1, total_slow_wave_sleep_time_milli: 1, total_rem_sleep_time_milli: 1 } },
});
const recoveryRecord = ({ sleepId = sid(1), updatedAt = at(2), score = 70 } = {}) => ({
  sleep_id: sleepId, cycle_id: 'c-1', user_id: 1, score_state: 'SCORED',
  created_at: updatedAt, updated_at: updatedAt, score: { recovery_score: score },
});
const workoutRecord = ({ id = sid(1), updatedAt = at(2), strain = 10, start = at(2, -3) } = {}) => ({
  id, user_id: 1, score_state: 'SCORED', sport_name: 'running',
  start, end: new Date(Date.parse(start) + HOUR).toISOString(),
  created_at: updatedAt, updated_at: updatedAt, score: { strain, zone_durations: {} },
});
const cycleRecord = ({ id = 'cy-1', updatedAt = at(2), strain = 8, start = at(2, -20) } = {}) => ({
  id, user_id: 1, score_state: 'SCORED', start, end: new Date(Date.parse(start) + 20 * HOUR).toISOString(),
  timezone_offset: '+08:00', created_at: updatedAt, updated_at: updatedAt,
  score: { strain, kilojoule: 8000, average_heart_rate: 60, max_heart_rate: 150 },
});

/** 每種資源：路徑、canonical 表、本地讀值、造紀錄、直接寫 canonical（模擬 webhook / 舊同步）。 */
const RES = {
  sleep: {
    path: '/activity/sleep', table: 'whoop_sleeps', idCol: 'id', valCol: 'respiratory_rate',
    make: (o) => sleepRecord(o), val: 'rr',
    write: (db, uid, o) => db.upsertSleeps(uid, [sleepRecord(o)], { timezone: TZ }),
  },
  recovery: {
    path: '/recovery', table: 'whoop_recoveries', idCol: 'sleep_id', valCol: 'recovery_score',
    make: (o) => recoveryRecord({ sleepId: o.id, updatedAt: o.updatedAt, score: o.v }), val: 'score',
    write: (db, uid, o) => db.upsertRecoveries(uid, [recoveryRecord({ sleepId: o.id, updatedAt: o.updatedAt, score: o.v })]),
  },
  workout: {
    path: '/activity/workout', table: 'whoop_workouts', idCol: 'id', valCol: 'strain',
    make: (o) => workoutRecord({ id: o.id, updatedAt: o.updatedAt, strain: o.v, start: o.start }), val: 'strain',
    write: (db, uid, o) => db.upsertWorkouts(uid, [workoutRecord({ id: o.id, updatedAt: o.updatedAt, strain: o.v, start: o.start })], { timezone: TZ }),
  },
  cycle: {
    path: '/cycle', table: 'whoop_cycles', idCol: 'id', valCol: 'strain',
    make: (o) => cycleRecord({ id: o.id, updatedAt: o.updatedAt, strain: o.v, start: o.start }), val: 'strain',
    write: (db, uid, o) => db.upsertCycles(uid, [cycleRecord({ id: o.id, updatedAt: o.updatedAt, strain: o.v, start: o.start })]),
  },
};
RES.sleep.make = (o) => sleepRecord({ id: o.id, updatedAt: o.updatedAt, rr: o.v, start: o.start });
RES.sleep.write = (db, uid, o) => db.upsertSleeps(uid, [sleepRecord({ id: o.id, updatedAt: o.updatedAt, rr: o.v, start: o.start })], { timezone: TZ });

const valueOf = async (db, res, uid, id) => {
  const r = (await db.raw.execute({ sql: `SELECT ${res.valCol} v FROM ${res.table} WHERE user_id = ? AND ${res.idCol} = ?`, args: [uid, id] })).rows[0];
  return r ? Number(r.v) : null;
};
const count = async (db, table, uid) => Number((await db.raw.execute({ sql: `SELECT COUNT(*) n FROM ${table} WHERE user_id = ?`, args: [uid] })).rows[0].n);
const state = (db, uid, key) => db.getReconciliationState(uid, key);
const deepState = (db, uid, resource) => state(db, uid, deepResourceKey(resource));

/**
 * 假 WHOOP：每個路徑一個「頁面產生器」。
 *   windowed(all, {pageSize, startOf}) → 依 params.start/end 過濾、依 nextToken 分頁（token = 'p<n>'）
 *   可用 hooks.beforePage(params, n) 拋錯 / 改回應（模擬失敗與畸形）。
 */
function fakeWhoop(routes = {}) {
  const calls = [];
  return {
    calls,
    async apiGet(p, params = {}) {
      calls.push({ path: p, params: { ...params } });
      const route = routes[p];
      if (route === undefined) throw new WhoopApiError(`unexpected ${p}`, 404);
      const out = typeof route === 'function' ? await route(params, calls.length) : route;
      if (out instanceof Error) throw out;
      return out;
    },
    async bodyMeasurement() { calls.push({ path: '/user/measurement/body', params: {} }); return { height_meter: 1.8, weight_kilogram: 70, max_heart_rate: 190 }; },
  };
}
function windowed(all, { pageSize = 25, startOf = (r) => r.start, hook = null } = {}) {
  return (params) => {
    const inWin = all.filter((r) => { const s = startOf(r); return !s || (s >= params.start && s < params.end); });
    const n = params.nextToken ? Number(String(params.nextToken).slice(1)) : 0;
    const page = inWin.slice(n * pageSize, (n + 1) * pageSize);
    const more = (n + 1) * pageSize < inWin.length;
    const out = { records: page, next_token: more ? `p${n + 1}` : null };
    return hook ? hook(out, n, params) : out;
  };
}
const empty = { records: [], next_token: null };
const mk = (db, whoop, { user = ALICE, now = () => NOW, ...rest } = {}) => createReconciler({ db, whoop, userId: user.id, timezone: TZ, now, ...rest });

async function webhookDelete(db, user, resourceType, resourceId, { owner = 'wh-test' } = {}) {
  const rec = await db.recordWhoopEvent({ whoopUserId: user.whoop, eventType: `${resourceType}.deleted`, resourceType, resourceId, traceId: `t-${resourceId}` });
  const ev = await db.claimWhoopEvent({ owner, leaseMs: 600_000 });
  assert.equal(ev.id, rec.id);
  await db.mutateForWhoopEvent(ev.id, { owner }, () => db.deleteWhoopResource({ userId: user.id, resourceType, resourceId, sourceEventId: ev.id }));
  await db.settleWhoopEvent(ev.id, { owner, state: 'PROCESSED', userId: user.id });
}

/** 對一個資源做「畸形回應必須是 FAILED」的完整斷言。 */
async function assertMalformedIsFailure(e, resource, route, { label, watermarkBefore = null, localRows = 0 }) {
  const res = RES[resource];
  const whoop = fakeWhoop({ [res.path]: route });
  const r = await mk(e.db, whoop).reconcileResource(resource);
  assert.equal(r.result, RECONCILE_RESULT.FAILED, `${label}: 必須 FAILED`);
  assert.equal(r.errorClass, ERROR_CLASS.MALFORMED, `${label}: 錯誤分類`);
  assert.equal(r.retryable, true);
  assert.equal(r.written, 0, `${label}: 不寫 canonical`);
  const s = await state(e.db, ALICE.id, resource);
  assert.equal(s.windowWatermark, watermarkBefore, `${label}: 水位不動`);
  assert.equal(s.lastErrorClass, ERROR_CLASS.MALFORMED, `${label}: 失敗來源有記錄`);
  assert.ok(s.nextAttemptAt, `${label}: 有退避`);
  assert.equal(s.consecutiveFailures, 1);
  assert.equal((await e.db.listDiscrepancies(ALICE.id)).length, 0, `${label}: 不記缺席`);
  assert.equal(await count(e.db, res.table, ALICE.id), localRows, `${label}: 本地列數不變`);
  const runs = await e.db.recentReconciliationRuns(ALICE.id, { resource, limit: 1 });
  assert.equal(runs[0].result, RECONCILE_RESULT.FAILED);
  assert.equal(runs[0].errorClass, ERROR_CLASS.MALFORMED);
  return r;
}

// ===========================================================================
// P2-R01 — 畸形集合回應
// ===========================================================================

test('R01 validateCollectionPage：形狀規則', () => {
  for (const bad of [{}, null, undefined, { records: null }, { records: {} }, { records: 'x' }, [], 'text', 7, { records: [], next_token: 5 }, { records: [], next_token: {} }, { records: [], next_token: [] }]) {
    assert.throws(() => validateCollectionPage(bad), SyntaxError, JSON.stringify(bad));
  }
  assert.deepEqual(validateCollectionPage({ records: [] }), { records: [], nextToken: null });
  assert.deepEqual(validateCollectionPage({ records: [], next_token: null }), { records: [], nextToken: null });
  assert.deepEqual(validateCollectionPage({ records: [], next_token: '' }), { records: [], nextToken: null });
  assert.deepEqual(validateCollectionPage({ records: [{ id: 1 }], next_token: 'abc' }), { records: [{ id: 1 }], nextToken: 'abc' });
});

test('R01-1..6 {} / null / 缺 records / records=null / 物件 / 字串 → FAILED、水位不動、不記缺席、不寫', async () => {
  const e = await env();
  try {
    // 本地有一筆在窗中央：畸形回應絕不能把它記成 MISSING_REMOTE
    await RES.cycle.write(e.db, ALICE.id, { id: 'cy-1', updatedAt: at(10), v: 5, start: at(10) });
    const cases = [['{}', {}], ['null', null], ['missing records', { next_token: null }], ['records null', { records: null }], ['records object', { records: {} }], ['records string', { records: '[]' }]];
    for (const [label, page] of cases) {
      await assertMalformedIsFailure(e, 'cycle', page, { label, localRows: 1 });
      // 重設失敗計數，讓每個案例獨立可讀
      await e.db.raw.execute({ sql: 'UPDATE whoop_reconciliation_state SET consecutive_failures = 0, next_attempt_at = NULL WHERE user_id = ?', args: [ALICE.id] });
    }
    assert.equal(await valueOf(e.db, RES.cycle, ALICE.id, 'cy-1'), 5, '生理資料原封不動');
  } finally { e.done(); }
});

test('R01-7 畸形分頁 token（數字 / 物件）→ FAILED，不當終端頁', async () => {
  const e = await env();
  try {
    for (const tok of [5, { a: 1 }, ['x']]) {
      const r = await assertMalformedIsFailure(e, 'sleep', { records: [sleepRecord()], next_token: tok }, { label: `token ${JSON.stringify(tok)}` });
      assert.equal(r.pages, 0, '畸形頁不算入已抓頁數');
      await e.db.raw.execute({ sql: 'UPDATE whoop_reconciliation_state SET consecutive_failures = 0, next_attempt_at = NULL WHERE user_id = ?', args: [ALICE.id] });
    }
    assert.equal(await count(e.db, 'whoop_sleeps', ALICE.id), 0, '畸形頁裡的紀錄一筆都不寫');
  } finally { e.done(); }
});

test('R01-8 合法的空回應 {records: []} 仍是成功、水位前進；{records: [], next_token: null|""} 亦同', async () => {
  const e = await env();
  try {
    for (const [i, page] of [{ records: [] }, { records: [], next_token: null }, { records: [], next_token: '' }].entries()) {
      const t = new Date(NOW.getTime() + i * 2 * HOUR);
      const r = await mk(e.db, fakeWhoop({ '/cycle': page }), { now: () => t }).reconcileResource('cycle');
      assert.equal(r.result, RECONCILE_RESULT.SUCCESS);
      assert.equal((await state(e.db, ALICE.id, 'cycle')).windowWatermark, t.toISOString());
    }
  } finally { e.done(); }
});

test('R01-9/10 第二頁 / 最後一頁畸形 → 整輪 FAILED，第一頁的紀錄也不寫、水位不動、不記缺席', async () => {
  const e = await env();
  try {
    await RES.sleep.write(e.db, ALICE.id, { id: sid(50), updatedAt: at(10), v: 15, start: at(10) });
    const all = Array.from({ length: 60 }, (_, i) => sleepRecord({ id: sid(100 + i), start: at(1, -i) }));
    for (const [label, badPage] of [['第二頁', 1], ['最後一頁', 2]]) {
      const route = windowed(all, { hook: (out, n) => (n === badPage ? {} : out) });
      const whoop = fakeWhoop({ '/activity/sleep': route });
      const r = await mk(e.db, whoop).reconcileResource('sleep');
      assert.equal(r.result, RECONCILE_RESULT.FAILED, label);
      assert.equal(r.errorClass, ERROR_CLASS.MALFORMED);
      assert.equal(r.pages, badPage, `${label}: 只有前 ${badPage} 頁算合法`);
      assert.equal(r.written, 0, `${label}: 一筆都不寫（整輪緩衝，失敗就作廢）`);
      assert.equal(await count(e.db, 'whoop_sleeps', ALICE.id), 1);
      assert.equal((await state(e.db, ALICE.id, 'sleep')).windowWatermark, null);
      assert.equal((await e.db.listDiscrepancies(ALICE.id)).length, 0);
      await e.db.raw.execute({ sql: 'UPDATE whoop_reconciliation_state SET consecutive_failures = 0, next_attempt_at = NULL WHERE user_id = ?', args: [ALICE.id] });
    }
    // 修好之後同一個窗成功
    const r = await mk(e.db, fakeWhoop({ '/activity/sleep': windowed(all) })).reconcileResource('sleep');
    assert.equal(r.result, RECONCILE_RESULT.SUCCESS);
    assert.equal(r.written, 60);
  } finally { e.done(); }
});

test('R01 ATTACK 1：{} 對每一種集合資源都是 FAILED，且 body_measurement 的畸形也一樣', async () => {
  const e = await env();
  try {
    for (const resource of ['sleep', 'recovery', 'workout', 'cycle']) {
      await assertMalformedIsFailure(e, resource, {}, { label: resource });
    }
    for (const bad of [null, 'x', [], 7]) {
      const whoop = fakeWhoop(); whoop.bodyMeasurement = async () => bad;
      const r = await mk(e.db, whoop).reconcileResource('body_measurement');
      assert.equal(r.result, RECONCILE_RESULT.FAILED); assert.equal(r.errorClass, ERROR_CLASS.MALFORMED);
      await e.db.raw.execute({ sql: 'UPDATE whoop_reconciliation_state SET consecutive_failures = 0, next_attempt_at = NULL WHERE user_id = ?', args: [ALICE.id] });
    }
    assert.equal(await count(e.db, 'whoop_body_measurements', ALICE.id), 0);
  } finally { e.done(); }
});

// ===========================================================================
// P2-R02 — 續傳失敗不能丟掉原本的邏輯窗
// ===========================================================================

test('R02 強制序列：PARTIAL → 續傳失敗 → 時鐘大幅前進 → 用**同一個** [from0,to0] 從第一頁重來，下緣的紀錄被抓回', async () => {
  const e = await env();
  try {
    const from0 = new Date(NOW.getTime() - WHOOP_RECONCILE.INITIAL_WINDOW_DAYS * DAY);
    const to0 = NOW;
    // 下緣附近的紀錄：from0 + 6h。時鐘前進 30 天之後重算的 45 天窗會從 NOW−15d 開始 → 看不到它。
    const edge = sleepRecord({ id: sid(1), start: new Date(from0.getTime() + 6 * HOUR).toISOString(), rr: 42 });
    const recent = Array.from({ length: 30 }, (_, i) => sleepRecord({ id: sid(100 + i), start: at(1, -i) }));
    const all = [...recent, edge];   // 依 start desc 排：edge 在最後一頁
    let failResume = false;
    const route = windowed(all, { pageSize: 25, hook: (out, n) => { if (failResume && n === 1) throw new WhoopApiError('boom', 503); return out; } });
    const whoop = fakeWhoop({ '/activity/sleep': route });

    // Run 1：預算 1 頁 → PARTIAL，存下 [from0,to0] + token
    const r1 = await mk(e.db, whoop, { maxPagesPerRun: 1 }).reconcileResource('sleep');
    assert.equal(r1.result, RECONCILE_RESULT.PARTIAL);
    let s = await state(e.db, ALICE.id, 'sleep');
    assert.equal(s.continuationToken, 'p1');
    assert.equal(s.continuationFrom, from0.toISOString()); assert.equal(s.continuationTo, to0.toISOString());
    assert.equal(s.windowWatermark, null);

    // Run 2：續傳第二頁失敗 → FAILED；token 清掉、窗保留
    failResume = true;
    const t2 = new Date(NOW.getTime() + HOUR);
    const r2 = await mk(e.db, whoop, { now: () => t2 }).reconcileResource('sleep');
    assert.equal(r2.result, RECONCILE_RESULT.FAILED);
    assert.equal(whoop.calls.at(-1).params.nextToken, 'p1', 'Run 2 真的是續傳');
    s = await state(e.db, ALICE.id, 'sleep');
    assert.equal(s.continuationToken, null, 'token 清掉');
    assert.equal(s.continuationFrom, from0.toISOString(), '★ 窗保留');
    assert.equal(s.continuationTo, to0.toISOString());
    assert.equal(s.windowWatermark, null);
    assert.equal(await valueOf(e.db, RES.sleep, ALICE.id, sid(1)), null, '下緣紀錄還沒抓到');

    // 時鐘前進 30 天。Run 3：必須用 exact [from0,to0]、從第一頁
    failResume = false;
    const t3 = new Date(NOW.getTime() + 30 * DAY);
    assert.equal(isReconcileDue(s, { now: t3 }), true, '有未完成窗 → 到期');
    const r3 = await mk(e.db, whoop, { now: () => t3 }).reconcileAll({ resources: ['sleep'], includeDeep: false });
    assert.equal(r3[0].result, RECONCILE_RESULT.SUCCESS);
    const c = whoop.calls.filter((x) => x.params.end === to0.toISOString() && x.params.start === from0.toISOString());
    assert.ok(c.length >= 4, '所有呼叫都用同一個窗');
    const run3calls = whoop.calls.slice(-2);
    assert.deepEqual(run3calls.map((x) => x.params.nextToken), [undefined, 'p1'], '★ 從第一頁重來');
    assert.deepEqual([run3calls[0].params.start, run3calls[0].params.end], [from0.toISOString(), to0.toISOString()], '★ exact [from0,to0]');
    assert.equal(await valueOf(e.db, RES.sleep, ALICE.id, sid(1)), 42, '★★★ 下緣的紀錄被抓回來了');
    s = await state(e.db, ALICE.id, 'sleep');
    assert.equal(s.windowWatermark, to0.toISOString(), '完整成功後水位才到 to0（不是 t3）');
    assert.equal(hasPendingWindow(s), false);
    assert.equal(s.continuationToken, null);

    // 之後的窗才從水位往前算
    const r4 = await mk(e.db, whoop, { now: () => t3 }).reconcileResource('sleep');
    assert.equal(r4.result, RECONCILE_RESULT.SUCCESS);
    assert.equal(whoop.calls.at(-1).params.start, new Date(to0.getTime() - 5 * DAY).toISOString());
    assert.equal(whoop.calls.at(-1).params.end, t3.toISOString());
  } finally { e.done(); }
});

test('R02 第一輪還沒 PARTIAL 就失敗：窗已耐久化 → 時鐘前進後仍用同一個窗', async () => {
  const e = await env();
  try {
    let fail = true;
    const whoop = fakeWhoop({ '/cycle': () => { if (fail) throw new WhoopApiError('x', 500); return empty; } });
    const r1 = await mk(e.db, whoop).reconcileResource('cycle');
    assert.equal(r1.result, RECONCILE_RESULT.FAILED);
    const s = await state(e.db, ALICE.id, 'cycle');
    assert.equal(s.continuationFrom, at(WHOOP_RECONCILE.INITIAL_WINDOW_DAYS)); assert.equal(s.continuationTo, NOW.toISOString());
    fail = false;
    const t = new Date(NOW.getTime() + 20 * DAY);
    const r2 = await mk(e.db, whoop, { now: () => t }).reconcileResource('cycle');
    assert.equal(r2.result, RECONCILE_RESULT.SUCCESS);
    assert.deepEqual([whoop.calls.at(-1).params.start, whoop.calls.at(-1).params.end], [at(WHOOP_RECONCILE.INITIAL_WINDOW_DAYS), NOW.toISOString()]);
    assert.equal((await state(e.db, ALICE.id, 'cycle')).windowWatermark, NOW.toISOString());
  } finally { e.done(); }
});

test('R02 重啟：另一個 reconciler（新 owner）分得出「沒有未完成窗」與「有未完成窗但沒 token」', async () => {
  const e = await env();
  try {
    let fail = true;
    const whoop = fakeWhoop({ '/cycle': () => { if (fail) throw new WhoopApiError('x', 500); return empty; } });
    await mk(e.db, whoop, { ownerId: 'proc-1' }).reconcileResource('cycle');
    fail = false;
    // 「重啟」：全新 owner、時鐘前進
    const t = new Date(NOW.getTime() + 7 * DAY);
    const s = await state(e.db, ALICE.id, 'cycle');
    assert.equal(hasPendingWindow(s), true); assert.equal(s.continuationToken, null);
    await mk(e.db, whoop, { ownerId: 'proc-2', now: () => t }).reconcileResource('cycle');
    assert.equal(whoop.calls.at(-1).params.end, NOW.toISOString(), '重啟後重做保留的窗');
    // 之後沒有未完成窗 → 新窗
    await mk(e.db, whoop, { ownerId: 'proc-2', now: () => t }).reconcileResource('cycle');
    assert.equal(whoop.calls.at(-1).params.end, t.toISOString());
  } finally { e.done(); }
});

test('R02 明確窗（backfill）不碰未完成窗', async () => {
  const e = await env();
  try {
    const whoop = fakeWhoop({ '/cycle': new WhoopApiError('x', 500) });
    await mk(e.db, whoop).reconcileResource('cycle');
    const before = await state(e.db, ALICE.id, 'cycle');
    const ok = fakeWhoop({ '/cycle': empty });
    const r = await mk(e.db, ok).reconcileResource('cycle', { explicitWindow: { from: new Date(NOW.getTime() - 200 * DAY), to: new Date(NOW.getTime() - 190 * DAY) } });
    assert.equal(r.result, RECONCILE_RESULT.SUCCESS);
    const after = await state(e.db, ALICE.id, 'cycle');
    assert.equal(after.continuationFrom, before.continuationFrom); assert.equal(after.continuationTo, before.continuationTo);
    assert.equal(after.windowWatermark, null);
  } finally { e.done(); }
});

// ===========================================================================
// P2-R03 — 有界的深度掃描
// ===========================================================================

test('R03 nextDeepSlice：由新到舊、貼齊水平線、走完就從 now 重來、未完成片沿用', () => {
  const s0 = nextDeepSlice(null, { now: NOW });
  assert.equal(s0.to.toISOString(), NOW.toISOString()); assert.equal(s0.from.toISOString(), at(DEEP.SLICE_DAYS)); assert.equal(s0.wrapped, true);
  const s1 = nextDeepSlice({ windowWatermark: at(DEEP.SLICE_DAYS) }, { now: NOW });
  assert.equal(s1.to.toISOString(), at(DEEP.SLICE_DAYS)); assert.equal(s1.from.toISOString(), at(2 * DEEP.SLICE_DAYS)); assert.equal(s1.wrapped, false);
  // 最後一片貼齊水平線
  const sLast = nextDeepSlice({ windowWatermark: at(DEEP.HORIZON_DAYS - 10) }, { now: NOW });
  assert.equal(sLast.from.toISOString(), at(DEEP.HORIZON_DAYS)); assert.equal(sLast.to.toISOString(), at(DEEP.HORIZON_DAYS - 10));
  // 游標到水平線 → 從頭
  const sWrap = nextDeepSlice({ windowWatermark: at(DEEP.HORIZON_DAYS) }, { now: NOW });
  assert.equal(sWrap.wrapped, true); assert.equal(sWrap.to.toISOString(), NOW.toISOString());
  // 游標在未來（時鐘倒退）→ 從頭，仍合法
  const sSkew = nextDeepSlice({ windowWatermark: new Date(NOW.getTime() + DAY).toISOString() }, { now: NOW });
  assert.equal(sSkew.wrapped, true); assert.ok(sSkew.from < sSkew.to);
  // 未完成片
  const sPend = nextDeepSlice({ windowWatermark: at(60), continuationFrom: at(90), continuationTo: at(60), continuationToken: 'p2' }, { now: NOW });
  assert.equal(sPend.pending, true); assert.equal(sPend.token, 'p2'); assert.equal(sPend.from.toISOString(), at(90));
  // 整輪：13 片鋪滿 365 天，彼此相接，然後從頭
  let st = null; const slices = [];
  for (let i = 0; i < 20; i += 1) {
    const sl = nextDeepSlice(st, { now: NOW });
    if (i > 0 && sl.wrapped) break;
    slices.push(sl); st = { windowWatermark: sl.from.toISOString() };
  }
  assert.equal(slices.length, Math.ceil(DEEP.HORIZON_DAYS / DEEP.SLICE_DAYS));
  for (let i = 1; i < slices.length; i += 1) assert.equal(slices[i].to.toISOString(), slices[i - 1].from.toISOString(), '相接');
  assert.equal(slices.at(-1).from.toISOString(), at(DEEP.HORIZON_DAYS));
});

for (const resource of ['sleep', 'recovery', 'workout', 'cycle']) {
  test(`R03 ${resource}：舊資源（>5d）在遠端有新版本 → 快路徑看不到、深度切片補回、更舊的被 M-03 擋下、快路徑水位不動`, async () => {
    const e = await env();
    try {
      const res = RES[resource];
      const id = resource === 'cycle' ? 'cy-old' : sid(7);
      // 20 天前發生的資源，本地是舊版（v=15，updated 20 天前）；假設 webhook 漏了
      await res.write(e.db, ALICE.id, { id, updatedAt: at(20), v: 15, start: at(20) });
      // recovery 沒有 start：靠對應的 sleep 決定窗歸屬，這裡讓遠端只在 deep 片才回它
      const remote = [res.make({ id, updatedAt: at(0, -1), v: 16, start: at(20) })];
      const route = resource === 'recovery'
        ? (params) => (params.start <= at(20) ? { records: remote, next_token: null } : empty)
        : windowed(remote);
      const whoop = fakeWhoop({ [res.path]: route });

      // 1. 建立正常水位；5. 快路徑（水位 − 5d … now）看不到它
      const rec = mk(e.db, whoop);
      const r1 = await rec.reconcileResource(resource);
      assert.equal(r1.result, RECONCILE_RESULT.SUCCESS);   // 初始 45 天窗會看到它 —— 所以先把水位建立在「之後」
      assert.equal(await valueOf(e.db, res, ALICE.id, id), 16);
      // 把本地退回舊版來模擬「水位之後才漏掉的 webhook」
      await e.db.raw.execute({ sql: `UPDATE ${res.table} SET ${res.valCol} = 15, updated_at = ? WHERE user_id = ? AND ${res.idCol} = ?`, args: [at(20), ALICE.id, id] });
      const t2 = new Date(NOW.getTime() + 2 * HOUR);
      const r2 = await mk(e.db, whoop, { now: () => t2 }).reconcileResource(resource);
      assert.equal(r2.result, RECONCILE_RESULT.SUCCESS);
      assert.equal(whoop.calls.at(-1).params.start, at(5), '快路徑窗 = 水位 − 5d');
      assert.equal(await valueOf(e.db, res, ALICE.id, id), 15, '★ 快路徑看不到 20 天前的資源');
      const recentWm = (await state(e.db, ALICE.id, resource)).windowWatermark;
      assert.equal(recentWm, t2.toISOString());

      // 6-7. 深度切片 [now−30d, now] 看得到 → 新版本被接受
      const d = await mk(e.db, whoop, { now: () => t2 }).reconcileDeep(resource);
      assert.equal(d.result, RECONCILE_RESULT.SUCCESS); assert.equal(d.scope, 'deep');
      assert.equal(d.written, 1);
      assert.equal(await valueOf(e.db, res, ALICE.id, id), 16, '★★★ 深度掃描補回新版本');
      const ds = await deepState(e.db, ALICE.id, resource);
      assert.equal(ds.windowWatermark, new Date(t2.getTime() - DEEP.SLICE_DAYS * DAY).toISOString(), '深度游標 = 這一片的下緣');
      // 12. 快路徑水位不變
      assert.equal((await state(e.db, ALICE.id, resource)).windowWatermark, recentWm, '★ 深度成功不動快路徑水位');
      const runs = await e.db.recentReconciliationRuns(ALICE.id, { resource: deepResourceKey(resource), limit: 1 });
      assert.equal(runs[0].mode, 'deep_slice');

      // 8. 更舊的深度版本被 M-03 擋下
      const older = fakeWhoop({ [res.path]: resource === 'recovery'
        ? { records: [res.make({ id, updatedAt: at(30), v: 1, start: at(20) })], next_token: null }
        : windowed([res.make({ id, updatedAt: at(30), v: 1, start: at(20) })]) });
      const d2 = await mk(e.db, older, { now: () => t2 }).reconcileResource(resource, { explicitWindow: { from: new Date(t2.getTime() - 25 * DAY), to: t2 } });
      assert.equal(d2.blocked, 1);
      assert.equal(await valueOf(e.db, res, ALICE.id, id), 16, '★ 已知較新不被較舊覆蓋');
    } finally { e.done(); }
  });
}

test('R03-11 ACTIVE 墓碑擋下深度掃描的復活（sleep / recovery / workout），且 DELETE 在 fetch 之後、寫入之前 commit 也一樣', async () => {
  const e = await env();
  try {
    for (const resource of ['sleep', 'recovery', 'workout']) {
      const res = RES[resource]; const id = sid(300);
      await RES.sleep.write(e.db, ALICE.id, { id, updatedAt: at(20), v: 15, start: at(20) });
      if (resource !== 'sleep') await res.write(e.db, ALICE.id, { id, updatedAt: at(20), v: 15, start: at(20) });
      await webhookDelete(e.db, ALICE, resource, id);
      assert.equal(await count(e.db, res.table, ALICE.id), 0);
      const remote = { records: [res.make({ id, updatedAt: at(0, -1), v: 99, start: at(20) })], next_token: null };
      const d = await mk(e.db, fakeWhoop({ [res.path]: remote })).reconcileDeep(resource);
      assert.equal(d.result, RECONCILE_RESULT.SUCCESS); assert.equal(d.written, 0); assert.equal(d.blocked, 1);
      assert.equal(await count(e.db, res.table, ALICE.id), 0, `${resource}: ★★★ 深度掃描沒有復活已刪除的資源`);
      assert.equal((await e.db.getTombstone(ALICE.id, resource, id)).state, TOMBSTONE_STATE.ACTIVE);
      await e.db.raw.execute({ sql: 'DELETE FROM whoop_resource_tombstones WHERE user_id = ?', args: [ALICE.id] });
      await e.db.raw.execute({ sql: 'DELETE FROM whoop_reconciliation_state WHERE user_id = ?', args: [ALICE.id] });
    }
    // ATTACK 12：深度 fetch 已完成 → webhook DELETE commit → 深度寫入
    const id = sid(301);
    await RES.workout.write(e.db, ALICE.id, { id, updatedAt: at(20), v: 15, start: at(20) });
    const whoop = fakeWhoop({ '/activity/workout': async () => {
      const page = { records: [RES.workout.make({ id, updatedAt: at(0, -1), v: 99, start: at(20) })], next_token: null };
      await webhookDelete(e.db, ALICE, 'workout', id);
      return page;
    } });
    const d = await mk(e.db, whoop).reconcileDeep('workout');
    assert.equal(d.result, RECONCILE_RESULT.SUCCESS); assert.equal(d.blocked, 1);
    assert.equal(await count(e.db, 'whoop_workouts', ALICE.id), 0, '★★★ 同一交易的墓碑判定擋下深度寫入');
    assert.equal((await e.db.getTombstone(ALICE.id, 'workout', id)).blockedCount, 1);
  } finally { e.done(); }
});

test('R03-13/14 深度游標只在整片完整成功後前進；失敗保留同一片並重試；PARTIAL 續傳同一片', async () => {
  const e = await env();
  try {
    const all = Array.from({ length: 60 }, (_, i) => cycleRecord({ id: `cy-${i}`, start: at(1, -i) }));
    let failAt = 1;
    const route = windowed(all, { hook: (out, n) => { if (failAt === n) throw new WhoopApiError('x', 503); return out; } });
    const whoop = fakeWhoop({ '/cycle': route });
    const d1 = await mk(e.db, whoop).reconcileDeep('cycle');
    assert.equal(d1.result, RECONCILE_RESULT.FAILED);
    let ds = await deepState(e.db, ALICE.id, 'cycle');
    assert.equal(ds.windowWatermark, null, '★ 游標不動');
    assert.equal(ds.continuationFrom, at(DEEP.SLICE_DAYS)); assert.equal(ds.continuationTo, NOW.toISOString());
    assert.ok(ds.nextAttemptAt);
    assert.equal(await count(e.db, 'whoop_cycles', ALICE.id), 0, '失敗一筆都不寫');

    // 退避後重試：同一片、第一頁；預算 2 頁 → PARTIAL
    failAt = -1;
    const t2 = new Date(Date.parse(ds.nextAttemptAt) + 1);
    const d2 = await mk(e.db, whoop, { now: () => t2, maxPagesPerRun: 2 }).reconcileDeep('cycle');
    assert.equal(d2.result, RECONCILE_RESULT.PARTIAL);
    assert.deepEqual(whoop.calls.slice(-2).map((c) => [c.params.start, c.params.end, c.params.nextToken]), [[at(DEEP.SLICE_DAYS), NOW.toISOString(), undefined], [at(DEEP.SLICE_DAYS), NOW.toISOString(), 'p1']], '★ 同一片，從第一頁');
    ds = await deepState(e.db, ALICE.id, 'cycle');
    assert.equal(ds.windowWatermark, null); assert.equal(ds.continuationToken, 'p2');
    assert.equal(isReconcileDue(ds, { now: t2, minIntervalMs: DEEP.MIN_INTERVAL_MS }), true, '未完成片不受每日節流');

    // 續傳完成 → 游標前進
    const d3 = await mk(e.db, whoop, { now: () => new Date(t2.getTime() + HOUR) }).reconcileDeep('cycle');
    assert.equal(d3.result, RECONCILE_RESULT.SUCCESS);
    ds = await deepState(e.db, ALICE.id, 'cycle');
    assert.equal(ds.windowWatermark, at(DEEP.SLICE_DAYS), '★ 整片完成才前進');
    assert.equal(hasPendingWindow(ds), false);
    assert.equal(await count(e.db, 'whoop_cycles', ALICE.id), 60);
    // 每日節流
    assert.equal(isReconcileDue(ds, { now: new Date(t2.getTime() + 2 * HOUR), minIntervalMs: DEEP.MIN_INTERVAL_MS }), false);
    assert.equal(isReconcileDue(ds, { now: new Date(t2.getTime() + 25 * HOUR), minIntervalMs: DEEP.MIN_INTERVAL_MS }), true);
  } finally { e.done(); }
});

test('R03-15 重啟保留深度游標與未完成片（新 owner 接續）', async () => {
  const e = await env();
  try {
    const all = Array.from({ length: 40 }, (_, i) => cycleRecord({ id: `cy-${i}`, start: at(40, -i * 12) }));
    const whoop = fakeWhoop({ '/cycle': windowed(all) });
    const d1 = await mk(e.db, whoop, { ownerId: 'proc-1' }).reconcileDeep('cycle');
    assert.equal(d1.result, RECONCILE_RESULT.SUCCESS);
    const cursor = (await deepState(e.db, ALICE.id, 'cycle')).windowWatermark;
    assert.equal(cursor, at(DEEP.SLICE_DAYS));
    // 「重啟」：新 owner；第二片 = [cursor − 30d, cursor]；預算 1 頁 → PARTIAL
    const t = new Date(NOW.getTime() + DAY + HOUR);
    const d2 = await mk(e.db, whoop, { ownerId: 'proc-2', now: () => t, maxPagesPerRun: 1 }).reconcileDeep('cycle');
    assert.equal(d2.result, RECONCILE_RESULT.PARTIAL);
    assert.equal(whoop.calls.at(-1).params.end, cursor, '第二片從游標往回');
    // 再「重啟」：第三個 owner 續傳同一片
    const d3 = await mk(e.db, whoop, { ownerId: 'proc-3', now: () => new Date(t.getTime() + HOUR) }).reconcileDeep('cycle');
    assert.equal(d3.result, RECONCILE_RESULT.SUCCESS);
    assert.equal(whoop.calls.at(-1).params.nextToken, 'p1');
    assert.equal((await deepState(e.db, ALICE.id, 'cycle')).windowWatermark, at(2 * DEEP.SLICE_DAYS));
    assert.equal(await count(e.db, 'whoop_cycles', ALICE.id), 40);
  } finally { e.done(); }
});

test('R03-16 / ATTACK 11：Alice 與 Bob 的深度游標、canonical、墓碑互相隔離（同一個資源 id）', async () => {
  const e = await env([ALICE, BOB]);
  try {
    const id = sid(500);
    await RES.sleep.write(e.db, BOB.id, { id, updatedAt: at(20), v: 15, start: at(20) });
    await webhookDelete(e.db, BOB, 'sleep', id);
    const remote = { records: [sleepRecord({ id, updatedAt: at(0, -1), rr: 33, start: at(20) })], next_token: null };
    const a = await mk(e.db, fakeWhoop({ '/activity/sleep': remote }), { user: ALICE }).reconcileDeep('sleep');
    assert.equal(a.written, 1);
    assert.equal(await valueOf(e.db, RES.sleep, ALICE.id, id), 33);
    assert.equal(await count(e.db, 'whoop_sleeps', BOB.id), 0, 'Bob 的刪除不受 Alice 影響');
    assert.ok(await deepState(e.db, ALICE.id, 'sleep'));
    assert.equal(await deepState(e.db, BOB.id, 'sleep'), null, 'Bob 沒有深度狀態');
    const b = await mk(e.db, fakeWhoop({ '/activity/sleep': remote }), { user: BOB, now: () => new Date(NOW.getTime() + HOUR) }).reconcileDeep('sleep');
    assert.equal(b.written, 0); assert.equal(b.blocked, 1);
    assert.equal(await count(e.db, 'whoop_sleeps', BOB.id), 0, '★ Bob 的 ACTIVE 墓碑擋下 Bob 的深度掃描');
    assert.equal(await valueOf(e.db, RES.sleep, ALICE.id, id), 33, 'Alice 的列不受影響');
    const [sa, sb] = [await deepState(e.db, ALICE.id, 'sleep'), await deepState(e.db, BOB.id, 'sleep')];
    assert.notEqual(sa.windowWatermark, sb.windowWatermark);
  } finally { e.done(); }
});

test('R03-17 API 預算：深度一片 ≤ MAX_PAGES_PER_RUN；reconcileAll 全部到期時的呼叫數有上限；深度每天一片', async () => {
  const e = await env();
  try {
    const endless = () => ({ records: [cycleRecord({ id: `cy-${Math.random()}`, start: at(3) })], next_token: 'p999' });
    const whoop = fakeWhoop({ '/cycle': endless, '/activity/sleep': endless, '/recovery': endless, '/activity/workout': endless });
    const d = await mk(e.db, whoop).reconcileDeep('cycle');
    assert.equal(d.result, RECONCILE_RESULT.PARTIAL); assert.equal(whoop.calls.length, WHOOP_RECONCILE.MAX_PAGES_PER_RUN);

    whoop.calls.length = 0;
    await e.db.raw.execute({ sql: 'DELETE FROM whoop_reconciliation_state WHERE user_id = ?', args: [ALICE.id] });
    const out = await mk(e.db, whoop).reconcileAll();
    const collection = 4; const P = WHOOP_RECONCILE.MAX_PAGES_PER_RUN; const T = WHOOP_RECONCILE.MAX_TOMBSTONE_CHECKS_PER_RUN;
    const maxRecent = collection * P + 2 * T + 1;      // 4 資源 × 8 頁 + sleep/workout 各 ≤5 單筆 + body 1
    const maxDeep = collection * P;                    // 4 資源 × 8 頁
    assert.ok(whoop.calls.length <= maxRecent + maxDeep, `${whoop.calls.length} ≤ ${maxRecent + maxDeep}`);
    assert.equal(whoop.calls.length, collection * P * 2 + 1, '無限分頁下正好是預算上限');
    assert.equal(out.filter((x) => x.scope === 'deep').length, 4);
    assert.ok(DEEP.SLICE_DAYS * Math.ceil(DEEP.HORIZON_DAYS / DEEP.SLICE_DAYS) >= DEEP.HORIZON_DAYS);
    assert.equal(DEEP.MIN_INTERVAL_MS, 24 * HOUR);
  } finally { e.done(); }
});

test('R03 ATTACK 3/4：cycle 與 sleep 的舊版本，只靠 reconcileAll 的正常節奏最終被深度切片補回（並列示到期節奏）', async () => {
  const e = await env();
  try {
    // 100 天前的 cycle 與 sleep，本地是舊版
    await RES.cycle.write(e.db, ALICE.id, { id: 'cy-old', updatedAt: at(100), v: 3, start: at(100) });
    await RES.sleep.write(e.db, ALICE.id, { id: sid(900), updatedAt: at(100), v: 12, start: at(100) });
    const routes = {
      '/cycle': windowed([cycleRecord({ id: 'cy-old', updatedAt: at(0, -1), strain: 9, start: at(100) })]),
      '/activity/sleep': windowed([sleepRecord({ id: sid(900), updatedAt: at(0, -1), rr: 18, start: at(100) })]),
      '/recovery': empty, '/activity/workout': empty,
    };
    const whoop = fakeWhoop(routes);
    let t = NOW; const seen = [];
    // 每小時一個 tick，跑 5 天
    for (let tick = 0; tick < 24 * 5; tick += 1) {
      const out = await mk(e.db, whoop, { now: () => t }).reconcileAll();
      seen.push(out.filter((x) => x.scope === 'deep' && x.result !== 'SKIPPED').length);
      t = new Date(t.getTime() + HOUR);
    }
    assert.equal(await valueOf(e.db, RES.cycle, ALICE.id, 'cy-old'), 9, '★★★ 沒有 webhook 的舊 cycle 靠深度切片補回');
    assert.equal(await valueOf(e.db, RES.sleep, ALICE.id, sid(900)), 18, '★★★ 漏掉 webhook 的舊 sleep 靠深度切片補回');
    const deepRuns = seen.reduce((a, b) => a + b, 0);
    assert.ok(deepRuns >= 4 * 4 && deepRuns <= 4 * 6, `5 天 × 4 資源 ≈ 每天一片（實際 ${deepRuns}）`);
    const ds = await deepState(e.db, ALICE.id, 'cycle');
    assert.ok(Date.parse(ds.windowWatermark) <= NOW.getTime() - 100 * DAY, '游標已越過 100 天前');
  } finally { e.done(); }
});

// ===========================================================================
// P2-R04 — 續傳完成的窗不產生缺席證據
// ===========================================================================

test('R04 主案例：頁 1+2 PARTIAL → 頁 3 SUCCESS：頁 1/2 的資源不可以變成 MISSING_REMOTE', async () => {
  const e = await env();
  try {
    // 60 筆，全部落在最近 1～3.5 天（初始窗與之後的增量窗都涵蓋，且不壓邊界）
    const all = Array.from({ length: 60 }, (_, i) => sleepRecord({ id: sid(100 + i), start: at(1, -i) }));
    const whoop = fakeWhoop({ '/activity/sleep': windowed(all) });
    const r1 = await mk(e.db, whoop, { maxPagesPerRun: 2 }).reconcileResource('sleep');
    assert.equal(r1.result, RECONCILE_RESULT.PARTIAL); assert.equal(r1.written, 50); assert.equal(r1.missing, 0);
    assert.equal((await e.db.listDiscrepancies(ALICE.id)).length, 0, 'PARTIAL：無缺席證據');
    const r2 = await mk(e.db, whoop, { now: () => new Date(NOW.getTime() + 5 * 60_000) }).reconcileResource('sleep');
    assert.equal(r2.result, RECONCILE_RESULT.SUCCESS); assert.equal(r2.written, 10);
    assert.equal(r2.window.resumed, true);
    assert.equal(r2.missing, 0, '★★★ 續傳完成：不產生缺席證據');
    assert.equal((await e.db.listDiscrepancies(ALICE.id)).length, 0);
    assert.equal(await count(e.db, 'whoop_sleeps', ALICE.id), 60);
    assert.equal((await state(e.db, ALICE.id, 'sleep')).windowWatermark, NOW.toISOString(), '水位仍正常前進');
    // 下一次完整的窗（單輪抓完）才建立缺席證據：拿掉遠端一筆
    const later = new Date(NOW.getTime() + 2 * HOUR);
    const whoop2 = fakeWhoop({ '/activity/sleep': windowed(all.filter((r) => r.id !== sid(102))) });
    const r3 = await mk(e.db, whoop2, { now: () => later }).reconcileResource('sleep');
    assert.equal(r3.result, RECONCILE_RESULT.SUCCESS); assert.equal(r3.window.resumed, false);
    assert.equal(r3.missing, 1);
    assert.equal((await e.db.listDiscrepancies(ALICE.id))[0].resourceId, sid(102));
    assert.equal(await count(e.db, 'whoop_sleeps', ALICE.id), 60, '仍不刪');
  } finally { e.done(); }
});

test('R04 邊界：單輪完整窗有缺席偵測；空的完整窗亦然；PARTIAL / FAILED / 畸形 沒有', async () => {
  const e = await env();
  try {
    await RES.sleep.write(e.db, ALICE.id, { id: sid(1), updatedAt: at(10), v: 15, start: at(10) });
    // FAILED
    const r0 = await mk(e.db, fakeWhoop({ '/activity/sleep': new WhoopApiError('x', 500) })).reconcileResource('sleep');
    assert.equal(r0.result, RECONCILE_RESULT.FAILED); assert.equal((await e.db.listDiscrepancies(ALICE.id)).length, 0);
    await e.db.raw.execute({ sql: 'DELETE FROM whoop_reconciliation_state WHERE user_id = ?', args: [ALICE.id] });
    // 畸形
    const rm = await mk(e.db, fakeWhoop({ '/activity/sleep': {} })).reconcileResource('sleep');
    assert.equal(rm.result, RECONCILE_RESULT.FAILED); assert.equal((await e.db.listDiscrepancies(ALICE.id)).length, 0);
    await e.db.raw.execute({ sql: 'DELETE FROM whoop_reconciliation_state WHERE user_id = ?', args: [ALICE.id] });
    // PARTIAL
    const many = Array.from({ length: 30 }, (_, i) => sleepRecord({ id: sid(100 + i), start: at(1, -i) }));
    const rp = await mk(e.db, fakeWhoop({ '/activity/sleep': windowed(many) }), { maxPagesPerRun: 1 }).reconcileResource('sleep');
    assert.equal(rp.result, RECONCILE_RESULT.PARTIAL); assert.equal((await e.db.listDiscrepancies(ALICE.id)).length, 0);
    await e.db.raw.execute({ sql: 'DELETE FROM whoop_reconciliation_state WHERE user_id = ?', args: [ALICE.id] });
    // 空的完整窗 → 縮邊窗內的本地列全部缺席：sid(1) + PARTIAL 那一頁寫進來的 24 筆（i=0 那筆壓在 24h 邊界上，不算）
    const re = await mk(e.db, fakeWhoop({ '/activity/sleep': empty })).reconcileResource('sleep');
    assert.equal(re.result, RECONCILE_RESULT.SUCCESS); assert.equal(re.missing, 25);
    assert.equal(await count(e.db, 'whoop_sleeps', ALICE.id), 26, '不刪');
    // 單輪完整窗（有資料）→ 仍然偵測：遠端有全部 30 筆，但本地多一筆 sid(2) 在窗中央
    await RES.sleep.write(e.db, ALICE.id, { id: sid(2), updatedAt: at(2), v: 15, start: at(2) });
    const rf = await mk(e.db, fakeWhoop({ '/activity/sleep': windowed(many) }), { now: () => new Date(NOW.getTime() + 2 * HOUR) }).reconcileResource('sleep');
    assert.equal(rf.result, RECONCILE_RESULT.SUCCESS); assert.equal(rf.window.resumed, false); assert.equal(rf.missing, 1);
    const d = await e.db.listDiscrepancies(ALICE.id);
    assert.equal(d.find((x) => x.resourceId === sid(2)).seenCount, 1);
    assert.equal(await count(e.db, 'whoop_sleeps', ALICE.id), 32, '仍然不刪（26 + sid(2) + 第二頁的 5 筆）');
  } finally { e.done(); }
});

test('R04 R02 交互：FAILED 之後同一窗從第一頁重來 → 那是完整的單輪觀察，缺席偵測可以做', async () => {
  const e = await env();
  try {
    await RES.sleep.write(e.db, ALICE.id, { id: sid(1), updatedAt: at(10), v: 15, start: at(10) });
    const many = Array.from({ length: 30 }, (_, i) => sleepRecord({ id: sid(100 + i), start: at(1, -i) }));
    let fail = false;
    const route = windowed(many, { hook: (out, n) => { if (fail && n === 1) throw new WhoopApiError('x', 503); return out; } });
    const whoop = fakeWhoop({ '/activity/sleep': route });
    await mk(e.db, whoop, { maxPagesPerRun: 1 }).reconcileResource('sleep');            // PARTIAL
    fail = true;
    await mk(e.db, whoop).reconcileResource('sleep');                                    // 續傳失敗
    fail = false;
    const s = await state(e.db, ALICE.id, 'sleep');
    const r = await mk(e.db, whoop, { now: () => new Date(Date.parse(s.nextAttemptAt) + 1) }).reconcileResource('sleep');
    assert.equal(r.result, RECONCILE_RESULT.SUCCESS); assert.equal(r.window.resumed, false); assert.equal(r.missing, 1);
  } finally { e.done(); }
});

// ===========================================================================
// P2-R05 — 手動執行器的 schema 閘
// ===========================================================================

/** 在沒有 .env 的暫存目錄跑真的 scripts/reconcile.js。環境只給明確列出的變數。 */
function runScript(args, { url, cwd, extraEnv = {} }) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, TURSO_DATABASE_URL: url, TURSO_AUTH_TOKEN: 'x', ...extraEnv },
    encoding: 'utf8', timeout: 60_000,
  });
  return { code: r.status, out: `${r.stdout}\n${r.stderr}` };
}

async function makeDb(version) {
  const t = tempDir();
  const db = createDb({ url: t.url });
  if (version === 'missing') { /* 空檔案：什麼都不建 */ } else {
    await db.migrate();
    await db.createUser({ id: 'u1', displayName: 'u1', timezone: TZ });
    if (version === 10) {
      for (const tbl of ['whoop_reconciliation_state', 'whoop_reconciliation_runs', 'whoop_reconciliation_discrepancies', 'analytics_invalidation', 'analytics_work_state', 'analytics_daily_state', 'analytics_runs', 'user_onboarding']) await db.raw.execute(`DROP TABLE IF EXISTS ${tbl}`);
      for (const c of ['reconcile_checked_at', 'reconcile_verdict', 'reconcile_remote_updated_at']) await db.raw.execute(`ALTER TABLE whoop_resource_tombstones DROP COLUMN ${c}`);
      await db.raw.execute('DELETE FROM schema_version WHERE version >= 11');
      await db.raw.execute("INSERT OR IGNORE INTO schema_version (version, applied_at, note) VALUES (10, '2026-09-01T00:00:00.000Z', 'v10')");
    } else if (version === 'malformed') {
      await db.raw.execute('DROP TABLE schema_version');
      await db.raw.execute('CREATE TABLE schema_version (garbage TEXT)');
    }
  }
  const v = version === 'missing' || version === 'malformed' ? null : await currentVersion(db.raw);
  const pragma = Number((await db.raw.execute('PRAGMA user_version')).rows[0].user_version);
  db.close();
  return { ...t, version: v, pragma };
}

test('R05 真的 v11 DB：PRAGMA user_version 是 0，但 schema_version 是 11 → 閘通過（之後才因缺 WHOOP 憑證 / 找不到使用者而停）', async () => {
  const t = await makeDb(11);
  try {
    assert.equal(t.version, SCHEMA_VERSION); assert.equal(t.pragma, 0, '這就是 Codex 抓到的根因：PRAGMA 永遠是 0');
    // 無 WHOOP 憑證：閘之後、載入憑證時停 —— 證明閘接受了 v11，且沒有任何網路工作
    const a = runScript(['run', '--user=u1'], { url: t.url, cwd: t.dir });
    assert.equal(a.code, 1);
    assert.ok(!/schema 版本/.test(a.out), a.out);
    assert.ok(/缺少環境變數：WHOOP_CLIENT_ID/.test(a.out), a.out);
    // 有（假）憑證但使用者不存在：在 createWhoopClient 之前安全停下
    const b = runScript(['run', '--user=nobody'], { url: t.url, cwd: t.dir, extraEnv: { WHOOP_CLIENT_ID: 'fake', WHOOP_CLIENT_SECRET: 'fake' } });
    assert.equal(b.code, 1);
    assert.ok(/找不到使用者：nobody/.test(b.out), b.out);
    // status 可用
    const c = runScript(['status', '--user=u1'], { url: t.url, cwd: t.dir });
    assert.equal(c.code, 0, c.out);
    assert.ok(/尚未跑過任何一輪/.test(c.out));
  } finally { t.cleanup(); }
});

test('R05 真的 v10 DB → 閘拒絕，在 WHOOP 憑證 / 網路之前；不會自動 migrate', async () => {
  const t = await makeDb(10);
  try {
    assert.equal(t.version, 10);
    const a = runScript(['run', '--user=u1'], { url: t.url, cwd: t.dir, extraEnv: { WHOOP_CLIENT_ID: 'fake', WHOOP_CLIENT_SECRET: 'fake' } });
    assert.equal(a.code, 1);
    assert.ok(/schema 版本 10 ≠ 程式碼 14/.test(a.out), a.out);
    assert.ok(!/找不到使用者|缺少環境變數/.test(a.out), '在使用者 / 憑證之前就停');
    const db = createDb({ url: t.url });
    assert.equal(await currentVersion(db.raw), 10, '★ 沒有被自動 migrate');
    db.close();
  } finally { t.cleanup(); }
});

test('R05 沒有 schema / schema_version 壞掉 → 拒絕', async () => {
  for (const kind of ['missing', 'malformed']) {
    const t = await makeDb(kind);
    try {
      const a = runScript(['run', '--user=u1'], { url: t.url, cwd: t.dir, extraEnv: { WHOOP_CLIENT_ID: 'fake', WHOOP_CLIENT_SECRET: 'fake' } });
      assert.equal(a.code, 1, kind);
      assert.ok(/schema 版本 0 ≠|無法讀取 schema_version/.test(a.out), `${kind}: ${a.out}`);
    } finally { t.cleanup(); }
  }
});

test('R05 既有閘保留：缺 --user、遠端 URL', async () => {
  const t = await makeDb(11);
  try {
    const a = runScript(['run'], { url: t.url, cwd: t.dir });
    assert.equal(a.code, 2); assert.ok(/--user/.test(a.out));
    const b = runScript(['run', '--user=u1'], { url: 'libsql://example.invalid', cwd: t.dir, extraEnv: { WHOOP_CLIENT_ID: 'fake', WHOOP_CLIENT_SECRET: 'fake' } });
    assert.equal(b.code, 2); assert.ok(/RECONCILE_ALLOW_REMOTE/.test(b.out));
  } finally { t.cleanup(); }
});

// ===========================================================================
// 修復後的儲存層規則
// ===========================================================================

test('store：openPendingWindow 帶 owner 圍欄；FAILED 只清 token；SUCCESS keep 不清窗；deep set 可倒退', async () => {
  const e = await env();
  try {
    const f = new Date(NOW.getTime() - DAY); const to = NOW;
    assert.equal(await e.db.openPendingWindow({ userId: ALICE.id, resource: 'sleep', owner: 'nobody', from: f, to, now: NOW }), false, '沒持有 → 寫不進');
    await e.db.claimReconciliation({ userId: ALICE.id, resource: 'sleep', owner: 'A', leaseMs: 60_000, now: NOW });
    assert.equal(await e.db.openPendingWindow({ userId: ALICE.id, resource: 'sleep', owner: 'A', from: f, to, now: NOW }), true);
    await e.db.settleReconciliation({ userId: ALICE.id, resource: 'sleep', owner: 'A', result: RECONCILE_RESULT.PARTIAL, continuation: { token: 't', from: f, to }, now: NOW });
    await e.db.claimReconciliation({ userId: ALICE.id, resource: 'sleep', owner: 'A', leaseMs: 60_000, now: NOW });
    await e.db.settleReconciliation({ userId: ALICE.id, resource: 'sleep', owner: 'A', result: RECONCILE_RESULT.FAILED, errorClass: 'x', now: NOW });
    let s = await state(e.db, ALICE.id, 'sleep');
    assert.equal(s.continuationToken, null); assert.equal(s.continuationFrom, f.toISOString()); assert.equal(s.continuationTo, to.toISOString());
    await e.db.claimReconciliation({ userId: ALICE.id, resource: 'sleep', owner: 'A', leaseMs: 60_000, now: NOW });
    await e.db.settleReconciliation({ userId: ALICE.id, resource: 'sleep', owner: 'A', result: RECONCILE_RESULT.SUCCESS, windowTo: to, watermarkMode: 'keep', now: NOW });
    s = await state(e.db, ALICE.id, 'sleep');
    assert.equal(s.continuationFrom, f.toISOString(), 'keep 不清窗'); assert.equal(s.windowWatermark, null);
    await e.db.claimReconciliation({ userId: ALICE.id, resource: 'sleep', owner: 'A', leaseMs: 60_000, now: NOW });
    await e.db.settleReconciliation({ userId: ALICE.id, resource: 'sleep', owner: 'A', result: RECONCILE_RESULT.SUCCESS, windowTo: to, now: NOW });
    s = await state(e.db, ALICE.id, 'sleep');
    assert.equal(hasPendingWindow(s), false); assert.equal(s.windowWatermark, to.toISOString());
    // deep set：游標可以往回
    const dk = deepResourceKey('sleep');
    await e.db.claimReconciliation({ userId: ALICE.id, resource: dk, owner: 'A', leaseMs: 60_000, now: NOW });
    await e.db.settleReconciliation({ userId: ALICE.id, resource: dk, owner: 'A', result: RECONCILE_RESULT.SUCCESS, cursor: at(30), watermarkMode: 'set', now: NOW });
    await e.db.claimReconciliation({ userId: ALICE.id, resource: dk, owner: 'A', leaseMs: 60_000, now: NOW });
    await e.db.settleReconciliation({ userId: ALICE.id, resource: dk, owner: 'A', result: RECONCILE_RESULT.SUCCESS, cursor: at(60), watermarkMode: 'set', now: NOW });
    assert.equal((await state(e.db, ALICE.id, dk)).windowWatermark, at(60));
    // 快路徑水位仍是單調的
    assert.equal((await state(e.db, ALICE.id, 'sleep')).windowWatermark, to.toISOString());
    await assert.rejects(e.db.settleReconciliation({ userId: ALICE.id, resource: dk, owner: 'A', result: RECONCILE_RESULT.SUCCESS, watermarkMode: 'set', now: NOW }), /cursor/);
    await assert.rejects(e.db.settleReconciliation({ userId: ALICE.id, resource: dk, owner: 'A', result: RECONCILE_RESULT.SUCCESS, watermarkMode: 'bogus', now: NOW }), /watermark_mode/);
  } finally { e.done(); }
});

test('deep scope 拒絕 body_measurement 與明確窗；scope 名稱驗證', async () => {
  const e = await env();
  try {
    const rec = mk(e.db, fakeWhoop());
    await assert.rejects(rec.reconcileDeep('body_measurement'), /deep_scope_not_applicable/);
    await assert.rejects(rec.reconcileResource('sleep', { scope: 'deep', explicitWindow: { from: NOW, to: NOW } }), /deep_scope_not_applicable/);
    await assert.rejects(rec.reconcileResource('sleep', { scope: 'weird' }), /invalid_scope/);
    assert.equal(WHOOP.PAGE_LIMIT, 25);
  } finally { e.done(); }
});
