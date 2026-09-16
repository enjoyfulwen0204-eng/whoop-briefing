/**
 * V1.2 Phase 2 — 對帳 + 增量同步。
 *
 * 測試矩陣（對應任務單 A–K）：
 *   A 增量狀態      B 分頁      C 版本修復     D 墓碑      E 與 webhook 共存
 *   F cycle         G 身體量測  H 鎖 / 租約    I 限流 / 失敗
 *   J 遷移 v10→v11  K 回歸（排程器沒被接線、V1.1 同步路徑沒動）
 * 之後是 12 個對抗性攻擊。
 *
 * 全部用真實 libSQL（本機檔案）與一個可編程的假 WHOOP client；
 * 併發認領那一題用另一條執行緒（本機 libSQL 綁定是同步的，同 process
 * 的第二個連線等鎖會卡住事件迴圈）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';

import { createDb } from '../src/db.js';
import {
  createReconciler, classifyReconcileError, reconcileBackoffMs, isReconcileDue, nextWindow, ERROR_CLASS,
} from '../src/reconcile.js';
import { runMigrations } from '../src/migrations.js';
import {
  RECONCILE_RESULT, TOMBSTONE_RECONCILE_VERDICT, TOMBSTONE_STATE, DISCREPANCY_KIND,
  SCHEMA_VERSION, RECONCILIATION_SCHEMA, RESHAPED_TABLES, ADDITIVE_COLUMNS,
} from '../src/schema.js';
import { WhoopApiError, WhoopAuthError } from '../src/whoop.js';
import { WHOOP_RECONCILE, WHOOP } from '../src/config.js';

const TZ = 'Asia/Taipei';
const ALICE = { id: 'u-alice', whoop: '1001' };
const BOB = { id: 'u-bob', whoop: '2002' };
const NOW = new Date('2026-09-15T12:00:00.000Z');
const DAY = 86_400_000;
const CLAIM_WORKER = new URL('./reconcile-claim-worker.js', import.meta.url);

function tempUrl() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whoop-reconcile-'));
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

/** 建一個帶 cleanup 的測試環境。 */
async function env(users = [ALICE]) {
  const t = tempUrl();
  const db = createDb({ url: t.url });
  await seed(db, users);
  return { db, url: t.url, done: () => { try { db.close(); } catch { /* ignore */ } t.cleanup(); } };
}

// ---- 樣本資料（時間都落在 NOW 往前 45 天的窗裡） ----------------------------
const sid = (n) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`;
const wid = (n) => `wwwwwwww-0000-4000-8000-${String(n).padStart(12, '0')}`;
const daysAgo = (d, h = 0) => new Date(NOW.getTime() - d * DAY + h * 3_600_000).toISOString();

const sleepRecord = ({ id = sid(1), updatedAt = daysAgo(2), rr = 15, start = daysAgo(2, -8) } = {}) => ({
  id, nap: false, score_state: 'SCORED', user_id: 1,
  start, end: new Date(Date.parse(start) + 8 * 3_600_000).toISOString(),
  created_at: updatedAt, updated_at: updatedAt,
  score: {
    respiratory_rate: rr,
    stage_summary: { total_light_sleep_time_milli: 1, total_slow_wave_sleep_time_milli: 1, total_rem_sleep_time_milli: 1 },
  },
});
const recoveryRecord = ({ sleepId = sid(1), updatedAt = daysAgo(2), score = 70 } = {}) => ({
  sleep_id: sleepId, cycle_id: 'c-1', user_id: 1, score_state: 'SCORED',
  created_at: updatedAt, updated_at: updatedAt, score: { recovery_score: score },
});
const workoutRecord = ({ id = wid(1), updatedAt = daysAgo(2), strain = 10, start = daysAgo(2, -3) } = {}) => ({
  id, user_id: 1, score_state: 'SCORED', sport_name: 'running',
  start, end: new Date(Date.parse(start) + 3_600_000).toISOString(),
  created_at: updatedAt, updated_at: updatedAt, score: { strain, zone_durations: {} },
});
const cycleRecord = ({ id = 'cy-1', updatedAt = daysAgo(2), strain = 8, start = daysAgo(2, -20) } = {}) => ({
  id, user_id: 1, score_state: 'SCORED', start, end: new Date(Date.parse(start) + 20 * 3_600_000).toISOString(),
  timezone_offset: '+08:00', created_at: updatedAt, updated_at: updatedAt,
  score: { strain, kilojoule: 8000, average_heart_rate: 60, max_heart_rate: 150 },
});

/**
 * 可編程的假 WHOOP client。
 *
 *   pages[path] = [ {records, next_token} | Error | (params) => page ]   依呼叫序取
 *   或 pages[path] = { byToken: { '': page, tok1: page, ... } }           依 nextToken 取
 *   singles[path] = record | Error
 */
function fakeWhoop({ pages = {}, singles = {}, body = null } = {}) {
  const calls = [];
  const idx = {};
  return {
    calls,
    async apiGet(path, params = {}) {
      calls.push({ path, params: { ...params } });
      if (path in singles) {
        const v = singles[path];
        if (v instanceof Error) throw v;
        return v;
      }
      const spec = pages[path];
      if (!spec) throw new WhoopApiError(`unexpected path ${path}`, 404);
      let page;
      if (Array.isArray(spec)) {
        const i = idx[path] ?? 0;
        idx[path] = i + 1;
        page = spec[Math.min(i, spec.length - 1)];
      } else if (spec.byToken) {
        page = spec.byToken[params.nextToken ?? ''];
        if (page === undefined) throw new WhoopApiError('invalid nextToken', 400);
      } else {
        page = spec;
      }
      if (typeof page === 'function') page = page(params);
      if (page instanceof Error) throw page;
      return page;
    },
    async bodyMeasurement() {
      calls.push({ path: '/user/measurement/body', params: {} });
      if (body instanceof Error) throw body;
      return body;
    },
  };
}

const count = async (db, table, uid) => Number((await db.raw.execute({
  sql: `SELECT COUNT(*) n FROM ${table} WHERE user_id = ?`, args: [uid],
})).rows[0].n);
const sleepRow = async (db, uid, id) => (await db.raw.execute({
  sql: 'SELECT respiratory_rate rr, updated_at FROM whoop_sleeps WHERE user_id = ? AND id = ?', args: [uid, id],
})).rows[0] ?? null;

/** 用 Phase 1 的正式路徑（帳本 → 認領 → 圍欄交易）做一個 webhook DELETE。 */
async function webhookDelete(db, user, resourceType, resourceId, { owner = 'wh-test' } = {}) {
  const rec = await db.recordWhoopEvent({
    whoopUserId: user.whoop, eventType: `${resourceType}.deleted`, resourceType, resourceId,
    traceId: `t-${resourceType}-${resourceId}`,
  });
  const ev = await db.claimWhoopEvent({ owner, leaseMs: 600_000 });
  assert.equal(ev.id, rec.id);
  await db.mutateForWhoopEvent(ev.id, { owner }, () => db.deleteWhoopResource({
    userId: user.id, resourceType, resourceId, sourceEventId: ev.id,
  }));
  await db.settleWhoopEvent(ev.id, { owner, state: 'PROCESSED', userId: user.id });
}

const mk = (db, whoop, { user = ALICE, now = () => NOW, ...rest } = {}) => createReconciler({
  db, whoop, userId: user.id, timezone: TZ, now, ...rest,
});

// ===========================================================================
// A. 增量狀態
// ===========================================================================

test('A1 第一輪：沒有狀態 → 初始 45 天窗，成功後水位 = 窗的 end', async () => {
  const e = await env();
  try {
    const whoop = fakeWhoop({ pages: { '/activity/sleep': [{ records: [sleepRecord()], next_token: null }] } });
    const r = await mk(e.db, whoop).reconcileResource('sleep');
    assert.equal(r.result, RECONCILE_RESULT.SUCCESS);
    assert.equal(r.fetched, 1); assert.equal(r.written, 1); assert.equal(r.pages, 1);

    const call = whoop.calls[0];
    assert.equal(call.params.start, new Date(NOW.getTime() - WHOOP_RECONCILE.INITIAL_WINDOW_DAYS * DAY).toISOString());
    assert.equal(call.params.end, NOW.toISOString());
    assert.equal(call.params.limit, WHOOP.PAGE_LIMIT);

    const s = await e.db.getReconciliationState(ALICE.id, 'sleep');
    assert.equal(s.windowWatermark, NOW.toISOString());
    assert.equal(s.lastSuccessAt, NOW.toISOString());
    assert.equal(s.owner, null, '成功後釋放持有');
    assert.equal(s.consecutiveFailures, 0);
    assert.equal(s.continuationToken, null);
    assert.equal(await count(e.db, 'whoop_sleeps', ALICE.id), 1);

    const runs = await e.db.recentReconciliationRuns(ALICE.id);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].result, RECONCILE_RESULT.SUCCESS);
    assert.equal(runs[0].mode, 'incremental');
    assert.equal(runs[0].windowTo, NOW.toISOString());
  } finally { e.done(); }
});

test('A2 第二輪：一小時內不到期 → SKIPPED；force → 窗 = 水位 − 重疊 … now', async () => {
  const e = await env();
  try {
    const whoop = fakeWhoop({ pages: { '/activity/sleep': { records: [], next_token: null } } });
    await mk(e.db, whoop).reconcileResource('sleep');
    const later = new Date(NOW.getTime() + 10 * 60_000);
    const r2 = await mk(e.db, whoop, { now: () => later }).reconcileAll({ resources: ['sleep'], includeDeep: false });
    assert.equal(r2[0].result, RECONCILE_RESULT.SKIPPED);
    assert.equal(r2[0].reason, 'not_due');
    assert.equal(whoop.calls.length, 1, '不到期就不打 API');

    const r3 = await mk(e.db, whoop, { now: () => later }).reconcileAll({ resources: ['sleep'], force: true, includeDeep: false });
    assert.equal(r3[0].result, RECONCILE_RESULT.SUCCESS);
    const c = whoop.calls[1];
    assert.equal(c.params.start, new Date(NOW.getTime() - WHOOP_RECONCILE.OVERLAP_DAYS.sleep * DAY).toISOString());
    assert.equal(c.params.end, later.toISOString());
    const s = await e.db.getReconciliationState(ALICE.id, 'sleep');
    assert.equal(s.windowWatermark, later.toISOString());
  } finally { e.done(); }
});

test('A3 到期規則：滿一小時後到期；退避中不到期；有續傳一律到期', () => {
  const t = NOW;
  assert.equal(isReconcileDue(null, { now: t }), true);
  assert.equal(isReconcileDue({ lastSuccessAt: new Date(t.getTime() - 30 * 60_000).toISOString() }, { now: t }), false);
  assert.equal(isReconcileDue({ lastSuccessAt: new Date(t.getTime() - 61 * 60_000).toISOString() }, { now: t }), true);
  assert.equal(isReconcileDue({ nextAttemptAt: new Date(t.getTime() + 1).toISOString() }, { now: t }), false);
  assert.equal(isReconcileDue({ nextAttemptAt: new Date(t.getTime() - 1).toISOString() }, { now: t }), true);
  assert.equal(isReconcileDue({
    lastSuccessAt: t.toISOString(), continuationToken: 'x', continuationFrom: 'a', continuationTo: 'b',
  }, { now: t }), true, '續傳要盡快做完');
});

test('A4 狀態是 per-(user, resource)：Alice 的 sleep 不影響 Alice 的 workout、也不影響 Bob', async () => {
  const e = await env([ALICE, BOB]);
  try {
    const whoop = fakeWhoop({ pages: { '/activity/sleep': { records: [sleepRecord()], next_token: null } } });
    await mk(e.db, whoop).reconcileResource('sleep');
    assert.ok(await e.db.getReconciliationState(ALICE.id, 'sleep'));
    assert.equal(await e.db.getReconciliationState(ALICE.id, 'workout'), null);
    assert.equal(await e.db.getReconciliationState(BOB.id, 'sleep'), null);
    assert.equal(await count(e.db, 'whoop_sleeps', BOB.id), 0);
    assert.equal((await e.db.getAllReconciliationState(BOB.id)).length, 0);
  } finally { e.done(); }
});

test('A5 窗的 end 固定在這一輪開始的那一刻（now 在抓的過程中往前走也不變）', async () => {
  const e = await env();
  try {
    let t = NOW.getTime();
    const whoop = fakeWhoop({ pages: { '/activity/sleep': {
      byToken: {
        '': () => { t += 60_000; return { records: [sleepRecord({ id: sid(1) })], next_token: 'p2' }; },
        p2: () => { t += 60_000; return { records: [sleepRecord({ id: sid(2) })], next_token: null }; },
      },
    } } });
    const rec = mk(e.db, whoop, { now: () => new Date(t) });
    const r = await rec.reconcileResource('sleep');
    assert.equal(r.result, RECONCILE_RESULT.SUCCESS);
    const [c1, c2] = whoop.calls;
    assert.equal(c1.params.end, c2.params.end, '兩頁用同一個 end');
    const s = await e.db.getReconciliationState(ALICE.id, 'sleep');
    assert.equal(s.windowWatermark, c1.params.end, '水位 = 窗的 end，不是結束時的 now');
  } finally { e.done(); }
});

// ===========================================================================
// B. 分頁
// ===========================================================================

const threePages = () => ({ byToken: {
  '': { records: [sleepRecord({ id: sid(1) })], next_token: 't2' },
  t2: { records: [sleepRecord({ id: sid(2) })], next_token: 't3' },
  t3: { records: [sleepRecord({ id: sid(3) })], next_token: null },
} });

test('B1 三頁全抓：token 逐頁傳遞，三筆都寫入，SUCCESS', async () => {
  const e = await env();
  try {
    const whoop = fakeWhoop({ pages: { '/activity/sleep': threePages() } });
    const r = await mk(e.db, whoop).reconcileResource('sleep');
    assert.equal(r.result, RECONCILE_RESULT.SUCCESS);
    assert.equal(r.pages, 3); assert.equal(r.fetched, 3); assert.equal(r.written, 3);
    assert.deepEqual(whoop.calls.map((c) => c.params.nextToken), [undefined, 't2', 't3']);
    assert.equal(await count(e.db, 'whoop_sleeps', ALICE.id), 3);
  } finally { e.done(); }
});

test('B2 中間一頁失敗：FAILED、水位不前進、下一輪從頭重抓（不會跳過第二頁）', async () => {
  const e = await env();
  try {
    let fail = true;
    const whoop = fakeWhoop({ pages: { '/activity/sleep': { byToken: {
      '': { records: [sleepRecord({ id: sid(1) })], next_token: 't2' },
      t2: () => { if (fail) throw new WhoopApiError('boom', 503); return { records: [sleepRecord({ id: sid(2) })], next_token: 't3' }; },
      t3: { records: [sleepRecord({ id: sid(3) })], next_token: null },
    } } } });
    const r = await mk(e.db, whoop).reconcileResource('sleep');
    assert.equal(r.result, RECONCILE_RESULT.FAILED);
    assert.equal(r.errorClass, ERROR_CLASS.SERVER);
    assert.equal(r.retryable, true);
    assert.equal(r.written, 0, '★ 頁沒抓完就不寫：失敗不寫任何東西');
    assert.equal(await count(e.db, 'whoop_sleeps', ALICE.id), 0);
    let s = await e.db.getReconciliationState(ALICE.id, 'sleep');
    assert.equal(s.windowWatermark, null, '★ 水位不前進');
    assert.equal(s.consecutiveFailures, 1);
    assert.ok(s.nextAttemptAt);
    assert.equal(s.continuationToken, null);
    assert.equal(s.continuationFrom, new Date(NOW.getTime() - WHOOP_RECONCILE.INITIAL_WINDOW_DAYS * DAY).toISOString(), 'P2-R02：未完成窗保留');
    assert.equal(s.continuationTo, NOW.toISOString());

    fail = false;
    const later = new Date(Date.parse(s.nextAttemptAt) + 1);
    const r2 = await mk(e.db, whoop, { now: () => later }).reconcileAll({ resources: ['sleep'], includeDeep: false });
    assert.equal(r2[0].result, RECONCILE_RESULT.SUCCESS);
    assert.equal(r2[0].written, 3);
    const tokens = whoop.calls.map((c) => c.params.nextToken);
    assert.deepEqual(tokens, [undefined, 't2', undefined, 't2', 't3'], '★ 從第一頁重來，不是從失敗那頁');
    s = await e.db.getReconciliationState(ALICE.id, 'sleep');
    assert.equal(s.windowWatermark, NOW.toISOString(), 'P2-R02：重來的是**原本的窗**，水位 = 原窗的 end');
    assert.equal(s.consecutiveFailures, 0, '成功歸零');
  } finally { e.done(); }
});

test('B3 頁數預算用完：PARTIAL 存續傳、水位不動；下一輪從 token 續、同一個窗、完成才前進', async () => {
  const e = await env();
  try {
    const whoop = fakeWhoop({ pages: { '/activity/sleep': threePages() } });
    const r = await mk(e.db, whoop, { maxPagesPerRun: 2 }).reconcileResource('sleep');
    assert.equal(r.result, RECONCILE_RESULT.PARTIAL);
    assert.equal(r.pages, 2); assert.equal(r.written, 2);
    let s = await e.db.getReconciliationState(ALICE.id, 'sleep');
    assert.equal(s.windowWatermark, null, '★ 水位不動');
    assert.equal(s.continuationToken, 't3');
    assert.equal(s.continuationTo, NOW.toISOString());
    assert.equal(s.owner, null, 'PARTIAL 也釋放持有');

    const later = new Date(NOW.getTime() + 5 * 60_000);   // 5 分鐘後：有續傳所以到期
    const r2 = await mk(e.db, whoop, { now: () => later, maxPagesPerRun: 2 }).reconcileAll({ resources: ['sleep'], includeDeep: false });
    assert.equal(r2[0].result, RECONCILE_RESULT.SUCCESS);
    assert.equal(r2[0].pages, 1);
    const c = whoop.calls[2];
    assert.equal(c.params.nextToken, 't3');
    assert.equal(c.params.end, NOW.toISOString(), '★ 同一個窗（end 不是新的 now）');
    s = await e.db.getReconciliationState(ALICE.id, 'sleep');
    assert.equal(s.windowWatermark, NOW.toISOString(), '★ 水位 = 原窗的 end，不是 later');
    assert.equal(s.continuationToken, null);
    assert.equal(await count(e.db, 'whoop_sleeps', ALICE.id), 3);
    const runs = await e.db.recentReconciliationRuns(ALICE.id);
    assert.deepEqual(runs.map((x) => x.result), [RECONCILE_RESULT.SUCCESS, RECONCILE_RESULT.PARTIAL]);
  } finally { e.done(); }
});

test('B4 跨頁重複的同一筆：只寫一次、fetched 只算一次', async () => {
  const e = await env();
  try {
    const whoop = fakeWhoop({ pages: { '/activity/sleep': { byToken: {
      '': { records: [sleepRecord({ id: sid(1) }), sleepRecord({ id: sid(2) })], next_token: 'b' },
      b: { records: [sleepRecord({ id: sid(2) }), sleepRecord({ id: sid(3) })], next_token: null },
    } } } });
    const r = await mk(e.db, whoop).reconcileResource('sleep');
    assert.equal(r.fetched, 3); assert.equal(r.written, 3);
    assert.equal(await count(e.db, 'whoop_sleeps', ALICE.id), 3);
  } finally { e.done(); }
});

test('B5 空窗 ≠ 失敗：空的成功回應讓水位前進；失敗不前進', async () => {
  const e = await env();
  try {
    const okEmpty = fakeWhoop({ pages: { '/activity/sleep': { records: [], next_token: null } } });
    const r = await mk(e.db, okEmpty).reconcileResource('sleep');
    assert.equal(r.result, RECONCILE_RESULT.SUCCESS); assert.equal(r.fetched, 0);
    assert.equal((await e.db.getReconciliationState(ALICE.id, 'sleep')).windowWatermark, NOW.toISOString());

    const failing = fakeWhoop({ pages: { '/activity/workout': new WhoopApiError('x', 500) } });
    const r2 = await mk(e.db, failing).reconcileResource('workout');
    assert.equal(r2.result, RECONCILE_RESULT.FAILED);
    assert.equal((await e.db.getReconciliationState(ALICE.id, 'workout')).windowWatermark, null);
  } finally { e.done(); }
});

test('B6 畸形回應（records 不是陣列 / 不是物件）→ FAILED malformed、可重試、不寫', async () => {
  const e = await env();
  try {
    for (const bad of [{ records: 'nope' }, 'text', null]) {
      const whoop = fakeWhoop({ pages: { '/activity/sleep': [bad] } });
      const r = await mk(e.db, whoop).reconcileResource('sleep');
      assert.equal(r.result, RECONCILE_RESULT.FAILED);
      assert.equal(r.errorClass, ERROR_CLASS.MALFORMED);
      assert.equal(r.retryable, true);
    }
    assert.equal(await count(e.db, 'whoop_sleeps', ALICE.id), 0);
  } finally { e.done(); }
});

test('B7 續傳 token 失效（400）：FAILED 並清掉續傳，下一輪整個窗重來（不會永遠卡在那一頁）', async () => {
  const e = await env();
  try {
    const whoop = fakeWhoop({ pages: { '/activity/sleep': { byToken: {
      '': { records: [sleepRecord({ id: sid(1) })], next_token: 'stale' },
    } } } });
    const r = await mk(e.db, whoop, { maxPagesPerRun: 1 }).reconcileResource('sleep');
    assert.equal(r.result, RECONCILE_RESULT.PARTIAL);
    const r2 = await mk(e.db, whoop, { maxPagesPerRun: 1 }).reconcileResource('sleep');
    assert.equal(r2.result, RECONCILE_RESULT.FAILED);
    assert.equal(r2.errorClass, ERROR_CLASS.CLIENT);
    const s = await e.db.getReconciliationState(ALICE.id, 'sleep');
    assert.equal(s.continuationToken, null, '★ 續傳 token 被清掉');
    assert.equal(s.continuationTo, NOW.toISOString(), '★ 但未完成窗保留（P2-R02）');
    assert.equal(s.windowWatermark, null);
    const later = new Date(Date.parse(s.nextAttemptAt) + 1);
    await mk(e.db, whoop, { now: () => later, maxPagesPerRun: 1 }).reconcileAll({ resources: ['sleep'], includeDeep: false });
    assert.equal(whoop.calls.at(-1).params.nextToken, undefined, '從第一頁重來');
    assert.equal(whoop.calls.at(-1).params.end, NOW.toISOString(), '同一個窗');
  } finally { e.done(); }
});

// ===========================================================================
// C. 版本修復（漏掉的 webhook 更新靠對帳補回）
// ===========================================================================

test('C1 遠端較新 → 蓋掉本地；遠端較舊 → 不動（M-03）；漏掉的更新被補回', async () => {
  const e = await env();
  try {
    await e.db.upsertSleeps(ALICE.id, [sleepRecord({ updatedAt: daysAgo(2), rr: 15 })], { timezone: TZ });
    // 假設 WHOOP 重新評分了（updated_at 往前），而 webhook 沒送到：
    const newer = fakeWhoop({ pages: { '/activity/sleep': { records: [sleepRecord({ updatedAt: daysAgo(1), rr: 16 })], next_token: null } } });
    const r = await mk(e.db, newer).reconcileResource('sleep');
    assert.equal(r.written, 1); assert.equal(r.blocked, 0);
    assert.equal(Number((await sleepRow(e.db, ALICE.id, sid(1))).rr), 16, '★ 漏掉的更新補回來了');

    // 一個過期的回應（較舊的版本）不能把它蓋回去
    const older = fakeWhoop({ pages: { '/activity/sleep': { records: [sleepRecord({ updatedAt: daysAgo(3), rr: 14 })], next_token: null } } });
    const r2 = await mk(e.db, older).reconcileResource('sleep');
    assert.equal(r2.result, RECONCILE_RESULT.SUCCESS, '被擋下不是失敗');
    assert.equal(r2.written, 0); assert.equal(r2.blocked, 1);
    assert.equal(Number((await sleepRow(e.db, ALICE.id, sid(1))).rr), 16, '★ 已知較新不被較舊覆蓋');
  } finally { e.done(); }
});

test('C2 相同版本重抓 → 冪等（不算擋下也不改值）', async () => {
  const e = await env();
  try {
    const whoop = fakeWhoop({ pages: { '/activity/sleep': { records: [sleepRecord({ rr: 15 })], next_token: null } } });
    await mk(e.db, whoop).reconcileResource('sleep');
    const r = await mk(e.db, whoop).reconcileResource('sleep');
    assert.equal(r.written, 1, '同版本重寫是允許的（冪等）');
    assert.equal(await count(e.db, 'whoop_sleeps', ALICE.id), 1);
  } finally { e.done(); }
});

// ===========================================================================
// D. 墓碑（診斷，不解決）
// ===========================================================================

test('D1 窗裡回來的資源有 ACTIVE 墓碑 → 不寫、擋下計數、判定 REMOTE_PRESENT_UNRESOLVED、state 不變', async () => {
  const e = await env();
  try {
    await e.db.upsertSleeps(ALICE.id, [sleepRecord()], { timezone: TZ });
    await webhookDelete(e.db, ALICE, 'sleep', sid(1));
    assert.equal(await count(e.db, 'whoop_sleeps', ALICE.id), 0);

    // WHOOP 卻還回得出它，而且 updated_at 更新 —— 我們仍然沒有證據能說它「重建了」
    const whoop = fakeWhoop({ pages: { '/activity/sleep': { records: [sleepRecord({ updatedAt: daysAgo(0, -1), rr: 99 })], next_token: null } } });
    const r = await mk(e.db, whoop).reconcileResource('sleep');
    assert.equal(r.result, RECONCILE_RESULT.SUCCESS);
    assert.equal(r.written, 0); assert.equal(r.blocked, 1);
    assert.equal(r.tombstonesChecked, 1); assert.equal(r.tombstonesUnresolved, 1);
    assert.equal(await count(e.db, 'whoop_sleeps', ALICE.id), 0, '★ 已刪除的資源沒有被復活');
    const t = await e.db.getTombstone(ALICE.id, 'sleep', sid(1));
    assert.equal(t.state, TOMBSTONE_STATE.ACTIVE, '★★★ 墓碑仍是 ACTIVE');
    assert.equal(t.blockedCount, 1);
    const row = (await e.db.raw.execute({ sql: 'SELECT * FROM whoop_resource_tombstones WHERE resource_id = ?', args: [sid(1)] })).rows[0];
    assert.equal(row.reconcile_verdict, TOMBSTONE_RECONCILE_VERDICT.REMOTE_PRESENT_UNRESOLVED);
    assert.equal(row.reconcile_checked_at, NOW.toISOString());
    assert.equal(row.reconcile_remote_updated_at, daysAgo(0, -1));
    assert.equal(whoop.calls.length, 1, '窗裡已看到 → 不另外打單筆端點');
  } finally { e.done(); }
});

test('D2 墓碑不在窗裡：單筆端點 404 → STILL_DELETED；200 → REMOTE_PRESENT_UNRESOLVED；都不改 state', async () => {
  const e = await env();
  try {
    await e.db.upsertSleeps(ALICE.id, [sleepRecord({ id: sid(1) }), sleepRecord({ id: sid(2) })], { timezone: TZ });
    await webhookDelete(e.db, ALICE, 'sleep', sid(1));
    await webhookDelete(e.db, ALICE, 'sleep', sid(2));
    const whoop = fakeWhoop({
      pages: { '/activity/sleep': { records: [], next_token: null } },
      singles: { [`/activity/sleep/${sid(1)}`]: new WhoopApiError('gone', 404), [`/activity/sleep/${sid(2)}`]: sleepRecord({ id: sid(2), updatedAt: daysAgo(1) }) },
    });
    const r = await mk(e.db, whoop).reconcileResource('sleep');
    assert.equal(r.result, RECONCILE_RESULT.SUCCESS);
    assert.equal(r.tombstonesChecked, 2); assert.equal(r.tombstonesUnresolved, 1);
    const rows = (await e.db.raw.execute('SELECT resource_id, state, reconcile_verdict FROM whoop_resource_tombstones ORDER BY resource_id')).rows;
    assert.equal(rows[0].reconcile_verdict, TOMBSTONE_RECONCILE_VERDICT.STILL_DELETED);
    assert.equal(rows[1].reconcile_verdict, TOMBSTONE_RECONCILE_VERDICT.REMOTE_PRESENT_UNRESOLVED);
    assert.ok(rows.every((x) => x.state === TOMBSTONE_STATE.ACTIVE), '★★★ 兩個墓碑都還是 ACTIVE');
    assert.equal(await count(e.db, 'whoop_sleeps', ALICE.id), 0, '單筆端點回的資料**不會**被寫入');
  } finally { e.done(); }
});

test('D3 recovery 沒有單筆端點：窗裡沒看到 → UNRESOLVED，不多打任何 API', async () => {
  const e = await env();
  try {
    await e.db.upsertSleeps(ALICE.id, [sleepRecord()], { timezone: TZ });
    await e.db.upsertRecoveries(ALICE.id, [recoveryRecord()]);
    await webhookDelete(e.db, ALICE, 'recovery', sid(1));
    const whoop = fakeWhoop({ pages: { '/recovery': { records: [], next_token: null } } });
    const r = await mk(e.db, whoop).reconcileResource('recovery');
    assert.equal(r.tombstonesChecked, 1); assert.equal(r.tombstonesUnresolved, 0);
    assert.equal(whoop.calls.length, 1);
    const row = (await e.db.raw.execute({ sql: 'SELECT state, reconcile_verdict FROM whoop_resource_tombstones WHERE resource_id = ?', args: [sid(1)] })).rows[0];
    assert.equal(row.reconcile_verdict, TOMBSTONE_RECONCILE_VERDICT.UNRESOLVED);
    assert.equal(row.state, TOMBSTONE_STATE.ACTIVE);
  } finally { e.done(); }
});

test('D4 墓碑檢查有預算（每輪最多 5 個）且 24h 內不重查', async () => {
  const e = await env();
  try {
    const ids = Array.from({ length: 7 }, (_, i) => sid(10 + i));
    await e.db.upsertSleeps(ALICE.id, ids.map((id) => sleepRecord({ id })), { timezone: TZ });
    for (const id of ids) await webhookDelete(e.db, ALICE, 'sleep', id);
    const singles = Object.fromEntries(ids.map((id) => [`/activity/sleep/${id}`, new WhoopApiError('gone', 404)]));
    const whoop = fakeWhoop({ pages: { '/activity/sleep': { records: [], next_token: null } }, singles });

    const r1 = await mk(e.db, whoop).reconcileResource('sleep');
    assert.equal(r1.tombstonesChecked, WHOOP_RECONCILE.MAX_TOMBSTONE_CHECKS_PER_RUN);
    assert.equal(whoop.calls.length, 1 + 5, 'API 呼叫 = 1 頁 + 5 個單筆');

    const r2 = await mk(e.db, whoop, { now: () => new Date(NOW.getTime() + 2 * 3_600_000) }).reconcileResource('sleep');
    assert.equal(r2.tombstonesChecked, 2, '剩下兩個；剛查過的 5 個 24h 內不重查');
    const r3 = await mk(e.db, whoop, { now: () => new Date(NOW.getTime() + 4 * 3_600_000) }).reconcileResource('sleep');
    assert.equal(r3.tombstonesChecked, 0);
    const r4 = await mk(e.db, whoop, { now: () => new Date(NOW.getTime() + 25 * 3_600_000) }).reconcileResource('sleep');
    assert.equal(r4.tombstonesChecked, 5, '24h 後重新輪到');
  } finally { e.done(); }
});

test('D5 抓取之後、寫入之前發生 webhook DELETE → 寫入被同一交易的墓碑判定擋下', async () => {
  const e = await env();
  try {
    await e.db.upsertSleeps(ALICE.id, [sleepRecord()], { timezone: TZ });
    let deleted = false;
    const whoop = fakeWhoop({ pages: { '/activity/sleep': [async () => {
      const page = { records: [sleepRecord({ updatedAt: daysAgo(1), rr: 42 })], next_token: null };
      // 回應已在手上（fetch 完成）；在 reconciler 開始寫之前，DELETE 先 commit。
      await webhookDelete(e.db, ALICE, 'sleep', sid(1));
      deleted = true;
      return page;
    }] } });
    // apiGet 回的 promise 要被 await 才會觸發；fakeWhoop 對函式回傳值直接 return（會是 promise），
    // reconciler 的 `await whoop.apiGet` 會等它。
    const r = await mk(e.db, whoop).reconcileResource('sleep');
    assert.equal(deleted, true);
    assert.equal(r.result, RECONCILE_RESULT.SUCCESS);
    assert.equal(r.written, 0); assert.equal(r.blocked, 1);
    assert.equal(await count(e.db, 'whoop_sleeps', ALICE.id), 0, '★★★ 已刪除的睡眠沒有被舊回應寫回');
    const t = await e.db.getTombstone(ALICE.id, 'sleep', sid(1));
    assert.equal(t.state, TOMBSTONE_STATE.ACTIVE);
    assert.equal(t.blockedCount, 1);
  } finally { e.done(); }
});

test('D6 對帳從不清墓碑：SUPERSEDED / 非 ACTIVE 也不會被判定寫入觸碰', async () => {
  const e = await env();
  try {
    await e.db.upsertSleeps(ALICE.id, [sleepRecord()], { timezone: TZ });
    await webhookDelete(e.db, ALICE, 'sleep', sid(1));
    await e.db.raw.execute({ sql: 'UPDATE whoop_resource_tombstones SET state = ? WHERE resource_id = ?', args: ['SUPERSEDED', sid(1)] });
    const ok = await e.db.recordTombstoneVerdict({
      userId: ALICE.id, resourceType: 'sleep', resourceId: sid(1), verdict: TOMBSTONE_RECONCILE_VERDICT.STILL_DELETED,
    });
    assert.equal(ok, false, '非 ACTIVE → rowsAffected 0');
    const due = await e.db.tombstonesDueForCheck(ALICE.id, 'sleep', { recheckMs: 0, limit: 10 });
    assert.equal(due.length, 0, '非 ACTIVE 不在檢查名單');
  } finally { e.done(); }
});

// ===========================================================================
// E. 與 webhook 共存
// ===========================================================================

test('E1 webhook 先寫入較新版本，對帳的較舊回應不能蓋掉它；反過來對帳較新則蓋掉', async () => {
  const e = await env();
  try {
    // webhook 路徑（正式 upsert）先寫 v2
    await e.db.upsertSleeps(ALICE.id, [sleepRecord({ updatedAt: daysAgo(1), rr: 20 })], { timezone: TZ });
    const stale = fakeWhoop({ pages: { '/activity/sleep': { records: [sleepRecord({ updatedAt: daysAgo(2), rr: 15 })], next_token: null } } });
    await mk(e.db, stale).reconcileResource('sleep');
    assert.equal(Number((await sleepRow(e.db, ALICE.id, sid(1))).rr), 20);

    const fresh = fakeWhoop({ pages: { '/activity/sleep': { records: [sleepRecord({ updatedAt: daysAgo(0, -2), rr: 21 })], next_token: null } } });
    await mk(e.db, fresh).reconcileResource('sleep');
    assert.equal(Number((await sleepRow(e.db, ALICE.id, sid(1))).rr), 21);
    // 之後 webhook 帶回更舊的也不會倒退
    await e.db.upsertSleeps(ALICE.id, [sleepRecord({ updatedAt: daysAgo(1), rr: 20 })], { timezone: TZ });
    assert.equal(Number((await sleepRow(e.db, ALICE.id, sid(1))).rr), 21);
  } finally { e.done(); }
});

// ===========================================================================
// F. cycle（沒有 webhook，只能靠對帳）
// ===========================================================================

test('F1 cycle 走窗式對帳，M-03 生效，沒有墓碑檢查', async () => {
  const e = await env();
  try {
    const whoop = fakeWhoop({ pages: { '/cycle': { records: [cycleRecord({ strain: 8 })], next_token: null } } });
    const r = await mk(e.db, whoop).reconcileResource('cycle');
    assert.equal(r.result, RECONCILE_RESULT.SUCCESS); assert.equal(r.written, 1);
    assert.equal(r.tombstonesChecked, 0);
    assert.equal(whoop.calls[0].path, '/cycle');
    assert.equal(await count(e.db, 'whoop_cycles', ALICE.id), 1);

    const older = fakeWhoop({ pages: { '/cycle': { records: [cycleRecord({ strain: 1, updatedAt: daysAgo(5) })], next_token: null } } });
    const r2 = await mk(e.db, older).reconcileResource('cycle');
    assert.equal(r2.blocked, 1);
    const row = (await e.db.raw.execute({ sql: 'SELECT strain FROM whoop_cycles WHERE id = ?', args: ['cy-1'] })).rows[0];
    assert.equal(Number(row.strain), 8);
    assert.equal((await e.db.getReconciliationState(ALICE.id, 'cycle')).windowWatermark, NOW.toISOString());
  } finally { e.done(); }
});

// ===========================================================================
// G. 身體量測（單一物件、沒有時間戳）
// ===========================================================================

test('G1 body_measurement：成功寫日期快照、同一天重跑同一列、失敗不寫也不前進', async () => {
  const e = await env();
  try {
    const bm = { height_meter: 1.8, weight_kilogram: 75, max_heart_rate: 190 };
    const whoop = fakeWhoop({ body: bm });
    const r = await mk(e.db, whoop).reconcileResource('body_measurement');
    assert.equal(r.result, RECONCILE_RESULT.SUCCESS); assert.equal(r.written, 1);
    assert.equal(await count(e.db, 'whoop_body_measurements', ALICE.id), 1);
    const s = await e.db.getReconciliationState(ALICE.id, 'body_measurement');
    assert.equal(s.windowWatermark, NOW.toISOString());
    const runs = await e.db.recentReconciliationRuns(ALICE.id, { resource: 'body_measurement' });
    assert.equal(runs[0].mode, 'point_in_time');

    await mk(e.db, fakeWhoop({ body: { ...bm, weight_kilogram: 76 } }), { now: () => new Date(NOW.getTime() + 3_600_000) }).reconcileResource('body_measurement');
    assert.equal(await count(e.db, 'whoop_body_measurements', ALICE.id), 1, '同一天 → 同一列');
    const w = (await e.db.raw.execute({ sql: 'SELECT weight_kilogram w FROM whoop_body_measurements WHERE user_id = ?', args: [ALICE.id] })).rows[0];
    assert.equal(Number(w.w), 76);

    const bad = fakeWhoop({ body: new WhoopApiError('x', 500) });
    const r3 = await mk(e.db, bad, { now: () => new Date(NOW.getTime() + DAY) }).reconcileResource('body_measurement');
    assert.equal(r3.result, RECONCILE_RESULT.FAILED);
    assert.equal(await count(e.db, 'whoop_body_measurements', ALICE.id), 1, '★ 失敗不寫任何列');
    assert.equal((await e.db.getReconciliationState(ALICE.id, 'body_measurement')).windowWatermark,
      new Date(NOW.getTime() + 3_600_000).toISOString(), '水位停在最後一次成功');

    const malformed = fakeWhoop({ body: 'nope' });
    const r4 = await mk(e.db, malformed, { now: () => new Date(NOW.getTime() + 2 * DAY) }).reconcileResource('body_measurement');
    assert.equal(r4.errorClass, ERROR_CLASS.MALFORMED);
  } finally { e.done(); }
});

// ===========================================================================
// H. 鎖 / 租約
// ===========================================================================

test('H1 同一 (user, resource) 被持有時第二個 reconciler SKIPPED(claim_busy)，且不打 API', async () => {
  const e = await env();
  try {
    assert.equal(await e.db.claimReconciliation({ userId: ALICE.id, resource: 'sleep', owner: 'other', leaseMs: 60_000, now: NOW }), true);
    const whoop = fakeWhoop({ pages: { '/activity/sleep': { records: [], next_token: null } } });
    const r = await mk(e.db, whoop).reconcileResource('sleep');
    assert.equal(r.result, RECONCILE_RESULT.SKIPPED); assert.equal(r.reason, 'claim_busy');
    assert.equal(whoop.calls.length, 0);
    // 不同資源不受影響
    const r2 = await mk(e.db, fakeWhoop({ pages: { '/activity/workout': { records: [], next_token: null } } })).reconcileResource('workout');
    assert.equal(r2.result, RECONCILE_RESULT.SUCCESS);
  } finally { e.done(); }
});

test('H2 租約過期後可被接手；原持有者之後的寫入與結案都被圍欄擋下（FENCED，零寫入）', async () => {
  const e = await env();
  try {
    let t = NOW.getTime();
    const now = () => new Date(t);
    const whoop = fakeWhoop({ pages: { '/activity/sleep': [async () => {
      // A 正在抓；此時租約過期，B 接手並完成
      t += WHOOP_RECONCILE.LEASE_MS + 1;
      const b = await mk(e.db, fakeWhoop({ pages: { '/activity/sleep': { records: [], next_token: null } } }), { now, ownerId: 'B' }).reconcileResource('sleep');
      assert.equal(b.result, RECONCILE_RESULT.SUCCESS);
      return { records: [sleepRecord({ rr: 77 })], next_token: null };
    }] } });
    const a = await mk(e.db, whoop, { now, ownerId: 'A' }).reconcileResource('sleep');
    assert.equal(a.result, RECONCILE_RESULT.FENCED);
    assert.equal(await count(e.db, 'whoop_sleeps', ALICE.id), 0, '★★★ 失去所有權的執行寫不進任何 canonical 資料');
    const s = await e.db.getReconciliationState(ALICE.id, 'sleep');
    assert.equal(s.owner, null);
    assert.equal(s.lastErrorClass, null, 'A 的失敗不會污染狀態');
    const runs = await e.db.recentReconciliationRuns(ALICE.id);
    assert.deepEqual(runs.map((x) => [x.owner, x.result]), [['B', 'SUCCESS'], ['A', 'FENCED']]);
  } finally { e.done(); }
});

test('H3 真實併發：兩條執行緒、兩個連線同時認領 → 恰好一個持有', async () => {
  const e = await env();
  try {
    const worker = new Worker(CLAIM_WORKER);
    const done = new Promise((resolve, reject) => {
      worker.on('message', (m) => { if (m.type === 'done') resolve(m); });
      worker.on('error', reject);
    });
    worker.postMessage({ type: 'go', url: e.url, userId: ALICE.id, resource: 'sleep', owner: 'thread-B', attempts: 25, leaseMs: 600_000 });
    let mine = 0;
    for (let i = 0; i < 25; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      if (await e.db.claimReconciliation({ userId: ALICE.id, resource: 'sleep', owner: 'thread-A', leaseMs: 600_000 })) mine += 1;
    }
    const w = await done;
    await worker.terminate();
    assert.equal(w.ok, true, w.error);
    // 認領不是續租：租約有效期間**任何人**（包括自己）再認領都拿不到。
    // 所以 50 次嘗試裡恰好一次成功，而且持有者就是那一次的擁有者。
    const s = await e.db.getReconciliationState(ALICE.id, 'sleep');
    assert.ok(['thread-A', 'thread-B'].includes(s.owner));
    assert.equal(mine + w.wins, 1, `★ 恰好一次認領成功（A=${mine}, B=${w.wins}, holder=${s.owner}）`);
    assert.equal(s.owner, mine === 1 ? 'thread-A' : 'thread-B');
  } finally { e.done(); }
});

test('H4 mutateForReconciliation 沒有持有 → 交易前檢查就拒絕，fn 不執行', async () => {
  const e = await env();
  try {
    let ran = false;
    await assert.rejects(
      e.db.mutateForReconciliation({ userId: ALICE.id, resource: 'sleep', owner: 'nobody' }, async () => { ran = true; }),
      /reconcile_ownership_lost/,
    );
    assert.equal(ran, false);
    await assert.rejects(e.db.mutateForReconciliation({ userId: ALICE.id, resource: 'sleep', owner: null }, async () => {}), /reconcile_owner_required/);
  } finally { e.done(); }
});

// ===========================================================================
// I. 限流 / 失敗
// ===========================================================================

test('I1 錯誤分類', () => {
  const c = classifyReconcileError;
  assert.deepEqual(c(new WhoopApiError('x', 429)), { class: ERROR_CLASS.RATE_LIMIT, retryable: true });
  assert.deepEqual(c(new WhoopApiError('x', 503)), { class: ERROR_CLASS.SERVER, retryable: true });
  assert.deepEqual(c(new WhoopApiError('x', 0)), { class: ERROR_CLASS.NETWORK, retryable: true });
  assert.deepEqual(c(new WhoopApiError('x', 403)), { class: ERROR_CLASS.SCOPE, retryable: false });
  assert.deepEqual(c(new WhoopApiError('x', 404)), { class: ERROR_CLASS.NOT_FOUND, retryable: false });
  assert.deepEqual(c(new WhoopApiError('x', 400)), { class: ERROR_CLASS.CLIENT, retryable: false });
  assert.deepEqual(c(new WhoopAuthError('401')), { class: ERROR_CLASS.AUTH, retryable: true });
  assert.deepEqual(c(new SyntaxError('Unexpected token')), { class: ERROR_CLASS.MALFORMED, retryable: true });
  assert.deepEqual(c(new Error('reconcile_ownership_lost')), { class: ERROR_CLASS.FENCED, retryable: false });
  assert.deepEqual(c(Object.assign(new Error('busy'), { code: 'SQLITE_BUSY' })), { class: ERROR_CLASS.DB, retryable: true });
  assert.deepEqual(c(new Error('???')), { class: ERROR_CLASS.INTERNAL, retryable: true });
});

test('I2 退避指數成長且有上限', () => {
  assert.equal(reconcileBackoffMs(1), WHOOP_RECONCILE.RETRY_BASE_MS);
  assert.equal(reconcileBackoffMs(2), WHOOP_RECONCILE.RETRY_BASE_MS * 2);
  assert.equal(reconcileBackoffMs(3), WHOOP_RECONCILE.RETRY_BASE_MS * 4);
  assert.equal(reconcileBackoffMs(50), WHOOP_RECONCILE.RETRY_MAX_MS);
});

test('I3 429：FAILED rate_limit、退避、退避中 SKIPPED、連續失敗退避加倍、成功歸零', async () => {
  const e = await env();
  try {
    let t = NOW.getTime();
    const now = () => new Date(t);
    let fail = true;
    const whoop = fakeWhoop({ pages: { '/activity/sleep': [() => { if (fail) throw new WhoopApiError('slow down', 429); return { records: [], next_token: null }; }] } });
    const r1 = await mk(e.db, whoop, { now }).reconcileResource('sleep');
    assert.equal(r1.result, RECONCILE_RESULT.FAILED); assert.equal(r1.errorClass, ERROR_CLASS.RATE_LIMIT);
    let s = await e.db.getReconciliationState(ALICE.id, 'sleep');
    assert.equal(s.nextAttemptAt, new Date(t + WHOOP_RECONCILE.RETRY_BASE_MS).toISOString());
    assert.equal(s.lastErrorClass, ERROR_CLASS.RATE_LIMIT);

    t += 1000;
    const r2 = await mk(e.db, whoop, { now }).reconcileAll({ resources: ['sleep'], includeDeep: false });
    assert.equal(r2[0].result, RECONCILE_RESULT.SKIPPED);
    assert.equal(whoop.calls.length, 1, '★ 退避中不打 API');

    t += WHOOP_RECONCILE.RETRY_BASE_MS;
    const r3 = await mk(e.db, whoop, { now }).reconcileAll({ resources: ['sleep'], includeDeep: false });
    assert.equal(r3[0].result, RECONCILE_RESULT.FAILED);
    s = await e.db.getReconciliationState(ALICE.id, 'sleep');
    assert.equal(s.consecutiveFailures, 2);
    assert.equal(s.nextAttemptAt, new Date(t + WHOOP_RECONCILE.RETRY_BASE_MS * 2).toISOString(), '第二次退避加倍');

    fail = false;
    t += WHOOP_RECONCILE.RETRY_BASE_MS * 2 + 1;
    const r4 = await mk(e.db, whoop, { now }).reconcileAll({ resources: ['sleep'], includeDeep: false });
    assert.equal(r4[0].result, RECONCILE_RESULT.SUCCESS);
    s = await e.db.getReconciliationState(ALICE.id, 'sleep');
    assert.equal(s.consecutiveFailures, 0); assert.equal(s.nextAttemptAt, null); assert.equal(s.lastErrorClass, null);
    const runs = await e.db.recentReconciliationRuns(ALICE.id);
    assert.equal(runs.filter((x) => x.result === 'FAILED').length, 2);
    assert.ok(runs.filter((x) => x.result === 'FAILED').every((x) => x.retryable === true));
  } finally { e.done(); }
});

test('I4 403 scope：FAILED、不可重試、但仍排退避（不會每個 tick 都撞 403）', async () => {
  const e = await env();
  try {
    const whoop = fakeWhoop({ pages: { '/activity/sleep': new WhoopApiError('forbidden', 403) } });
    const r = await mk(e.db, whoop).reconcileResource('sleep');
    assert.equal(r.errorClass, ERROR_CLASS.SCOPE); assert.equal(r.retryable, false);
    const s = await e.db.getReconciliationState(ALICE.id, 'sleep');
    assert.ok(s.nextAttemptAt);
    const r2 = await mk(e.db, whoop, { now: () => new Date(NOW.getTime() + 1000) }).reconcileAll({ resources: ['sleep'], includeDeep: false });
    assert.equal(r2[0].result, RECONCILE_RESULT.SKIPPED);
    assert.equal(whoop.calls.length, 1);
  } finally { e.done(); }
});

test('I5 API 用量有上限：每輪 ≤ MAX_PAGES_PER_RUN 頁 + ≤ MAX_TOMBSTONE_CHECKS 單筆；reconcileAll 一次最多 5 種資源', async () => {
  const e = await env();
  try {
    // 無限分頁（每頁都給下一頁）
    const byToken = new Proxy({}, { get: (_, k) => ({ records: [sleepRecord({ id: sid(Math.floor(Math.random() * 1e6)) })], next_token: `n${k}` }) });
    const whoop = fakeWhoop({ pages: { '/activity/sleep': { byToken } } });
    const r = await mk(e.db, whoop).reconcileResource('sleep');
    assert.equal(r.result, RECONCILE_RESULT.PARTIAL);
    assert.equal(r.pages, WHOOP_RECONCILE.MAX_PAGES_PER_RUN);
    assert.equal(whoop.calls.length, WHOOP_RECONCILE.MAX_PAGES_PER_RUN);
    assert.ok(WHOOP_RECONCILE.MAX_PAGES_PER_RUN <= WHOOP.MAX_PAGES);
    assert.equal(WHOOP_RECONCILE.RESOURCES.length, 5);
  } finally { e.done(); }
});

test('I6 reconcileAll 永遠不拋錯：一種資源炸掉不影響其他資源', async () => {
  const e = await env();
  try {
    const whoop = fakeWhoop({
      pages: { '/activity/sleep': new WhoopApiError('x', 500), '/recovery': { records: [], next_token: null }, '/cycle': { records: [], next_token: null }, '/activity/workout': { records: [], next_token: null } },
      body: { height_meter: 1.8, weight_kilogram: 70, max_heart_rate: 190 },
    });
    const out = await mk(e.db, whoop).reconcileAll();
    assert.deepEqual(out.map((x) => [x.resource, x.scope, x.result]), [
      ['sleep', 'recent', 'FAILED'], ['recovery', 'recent', 'SUCCESS'], ['cycle', 'recent', 'SUCCESS'],
      ['workout', 'recent', 'SUCCESS'], ['body_measurement', 'recent', 'SUCCESS'],
      // 深度路徑：各自的狀態列，sleep 的深度切片一樣撞 500 → FAILED，其他成功
      ['sleep', 'deep', 'FAILED'], ['recovery', 'deep', 'SUCCESS'], ['cycle', 'deep', 'SUCCESS'], ['workout', 'deep', 'SUCCESS'],
    ]);
    // 甚至 db 層炸掉也不拋
    const broken = { ...e.db, getReconciliationState: async () => { throw new Error('db down'); } };
    const out2 = await createReconciler({ db: broken, whoop, userId: ALICE.id, timezone: TZ, now: () => NOW }).reconcileAll({ resources: ['sleep'], includeDeep: false });
    assert.equal(out2[0].result, RECONCILE_RESULT.FAILED);
  } finally { e.done(); }
});

// ===========================================================================
// 差異：「遠端看不到」只記錄，永遠不刪
// ===========================================================================

test('X1 本地有、完整窗裡遠端沒有 → MISSING_REMOTE 差異，canonical 列**不動**；邊界 24h 內不算', async () => {
  const e = await env();
  try {
    await e.db.upsertSleeps(ALICE.id, [
      sleepRecord({ id: sid(1), start: daysAgo(2) }),                  // 窗中央，遠端沒有 → 差異
      sleepRecord({ id: sid(2), start: daysAgo(3) }),                  // 遠端有 → 無差異
      sleepRecord({ id: sid(3), start: daysAgo(0, -2) }),              // 距窗 end 只有 2h（邊界）→ 不算
      sleepRecord({ id: sid(4), start: daysAgo(44, -12) }),            // 距窗 from 12h（邊界）→ 不算
    ], { timezone: TZ });
    const whoop = fakeWhoop({ pages: { '/activity/sleep': { records: [sleepRecord({ id: sid(2), start: daysAgo(3) })], next_token: null } } });
    const r = await mk(e.db, whoop).reconcileResource('sleep');
    assert.equal(r.missing, 1);
    assert.equal(await count(e.db, 'whoop_sleeps', ALICE.id), 4, '★★★ 沒有任何列被刪');
    const d = await e.db.listDiscrepancies(ALICE.id);
    assert.equal(d.length, 1);
    assert.equal(d[0].resourceId, sid(1)); assert.equal(d[0].kind, DISCREPANCY_KIND.MISSING_REMOTE); assert.equal(d[0].seenCount, 1);

    // 再跑一輪（增量窗 = 水位 − 5d … now+2h，sid(1) 仍在窗中央）：同一筆 seen_count +1，仍然不刪
    await mk(e.db, whoop, { now: () => new Date(NOW.getTime() + 2 * 3_600_000) }).reconcileResource('sleep');
    assert.equal((await e.db.listDiscrepancies(ALICE.id))[0].seenCount, 2);
    assert.equal(await count(e.db, 'whoop_sleeps', ALICE.id), 4);
    assert.equal(await e.db.getTombstone(ALICE.id, 'sleep', sid(1)), null, '★ 也不會憑空造墓碑');
  } finally { e.done(); }
});

test('X2 窗沒抓完（PARTIAL / FAILED）→ 不做差異偵測（缺席可能只是沒抓到那一頁）', async () => {
  const e = await env();
  try {
    await e.db.upsertSleeps(ALICE.id, [sleepRecord({ id: sid(1), start: daysAgo(10) })], { timezone: TZ });
    const whoop = fakeWhoop({ pages: { '/activity/sleep': threePages() } });
    const r = await mk(e.db, whoop, { maxPagesPerRun: 1 }).reconcileResource('sleep');
    assert.equal(r.result, RECONCILE_RESULT.PARTIAL);
    assert.equal(r.missing, 0);
    assert.equal((await e.db.listDiscrepancies(ALICE.id)).length, 0);
  } finally { e.done(); }
});

// ===========================================================================
// 明確窗（backfill / 修復）
// ===========================================================================

test('W1 明確窗：抓、寫、但**不動**常規水位與續傳', async () => {
  const e = await env();
  try {
    const whoop = fakeWhoop({ pages: { '/activity/sleep': threePages() } });
    await mk(e.db, whoop, { maxPagesPerRun: 2 }).reconcileResource('sleep');   // → PARTIAL，有續傳
    const before = await e.db.getReconciliationState(ALICE.id, 'sleep');
    assert.equal(before.continuationToken, 't3');

    const old = fakeWhoop({ pages: { '/activity/sleep': { records: [sleepRecord({ id: sid(99), start: daysAgo(200) })], next_token: null } } });
    const from = new Date(NOW.getTime() - 210 * DAY); const to = new Date(NOW.getTime() - 190 * DAY);
    const r = await mk(e.db, old).reconcileResource('sleep', { explicitWindow: { from, to } });
    assert.equal(r.result, RECONCILE_RESULT.SUCCESS); assert.equal(r.written, 1);
    assert.equal(old.calls[0].params.start, from.toISOString()); assert.equal(old.calls[0].params.end, to.toISOString());
    const after = await e.db.getReconciliationState(ALICE.id, 'sleep');
    assert.equal(after.windowWatermark, before.windowWatermark, '★ 水位不動');
    assert.equal(after.continuationToken, 't3', '★ 續傳不動');
    assert.equal(after.continuationTo, before.continuationTo);
    const runs = await e.db.recentReconciliationRuns(ALICE.id);
    assert.equal(runs[0].mode, 'explicit_window');
  } finally { e.done(); }
});

// ===========================================================================
// J. 遷移 v10 → v11
// ===========================================================================

const NEW_TABLES = ['whoop_reconciliation_state', 'whoop_reconciliation_runs', 'whoop_reconciliation_discrepancies'];
const TOMB_COLS = ['reconcile_checked_at', 'reconcile_verdict', 'reconcile_remote_updated_at'];
const tableNames = async (c) => (await c.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")).rows.map((r) => String(r.name));
const colNames = async (c, t) => (await c.execute(`PRAGMA table_info(${t})`)).rows.map((r) => String(r.name));

/** 把一個最新版 DB 退回 v10 的形狀（沒有三張新表、墓碑沒有三個診斷欄位）。 */
async function downgradeToV10(db) {
  for (const t of [...NEW_TABLES, 'analytics_invalidation', 'analytics_work_state', 'analytics_daily_state', 'analytics_runs', 'user_onboarding']) await db.raw.execute(`DROP TABLE IF EXISTS ${t}`);
  for (const c of TOMB_COLS) await db.raw.execute(`ALTER TABLE whoop_resource_tombstones DROP COLUMN ${c}`);
  await db.raw.execute('DELETE FROM schema_version WHERE version >= 11');
  await db.raw.execute("INSERT OR IGNORE INTO schema_version (version, applied_at, note) VALUES (10, '2026-09-01T00:00:00.000Z', 'v10')");
}

test('J1 v10 → v11：純新增（三張表 + 三欄），零重建，既有墓碑與生理資料一列不動', async () => {
  const e = await env();
  try {
    await e.db.upsertSleeps(ALICE.id, [sleepRecord({ id: sid(1) }), sleepRecord({ id: sid(2) })], { timezone: TZ });
    await webhookDelete(e.db, ALICE, 'sleep', sid(1));
    await downgradeToV10(e.db);
    const before = await tableNames(e.db.raw);
    for (const t of NEW_TABLES) assert.ok(!before.includes(t));
    for (const c of TOMB_COLS) assert.ok(!(await colNames(e.db.raw, 'whoop_resource_tombstones')).includes(c));

    const summary = await runMigrations(e.db.raw);
    assert.equal(summary.from, 10); assert.equal(summary.to, SCHEMA_VERSION); assert.equal(SCHEMA_VERSION, 15);
    assert.deepEqual(summary.rebuilt, [], '★★★ 絕不重建');
    assert.deepEqual(summary.columnsAdded, TOMB_COLS.map((c) => `whoop_resource_tombstones.${c}`));
    // v12 的四張表在同一次遷移裡一起建起來（純新增）
    const after = await tableNames(e.db.raw);
    for (const t of NEW_TABLES) assert.ok(after.includes(t));

    const t = await e.db.getTombstone(ALICE.id, 'sleep', sid(1));
    assert.equal(t.state, TOMBSTONE_STATE.ACTIVE, '★ 墓碑原封不動');
    assert.equal(await count(e.db, 'whoop_sleeps', ALICE.id), 1);
    const row = (await e.db.raw.execute('SELECT reconcile_verdict FROM whoop_resource_tombstones')).rows[0];
    assert.equal(row.reconcile_verdict, null, '新欄位是 NULL，不是捏造的判定');

    // 升級後對帳可用
    const r = await mk(e.db, fakeWhoop({ pages: { '/activity/sleep': { records: [], next_token: null } }, singles: { [`/activity/sleep/${sid(1)}`]: new WhoopApiError('gone', 404) } })).reconcileResource('sleep');
    assert.equal(r.result, RECONCILE_RESULT.SUCCESS);
  } finally { e.done(); }
});

test('J2 遷移冪等：重跑三次零變更；全新資料庫一次到位；中斷後重跑補齊', async () => {
  const e = await env();
  try {
    const snap = await tableNames(e.db.raw);
    for (let i = 0; i < 3; i += 1) {
      const s = await runMigrations(e.db.raw);
      assert.deepEqual(s.rebuilt, []); assert.deepEqual(s.columnsAdded, []);
    }
    assert.deepEqual(await tableNames(e.db.raw), snap);
    const v = (await e.db.raw.execute('SELECT MAX(version) v FROM schema_version')).rows[0].v;
    assert.equal(Number(v), SCHEMA_VERSION);
    const cols = await colNames(e.db.raw, 'whoop_resource_tombstones');
    for (const c of TOMB_COLS) assert.ok(cols.includes(c), '全新 DB 由 CREATE TABLE 直接建齊');

    // 中斷：只建了第一張表
    await downgradeToV10(e.db);
    await e.db.raw.execute(RECONCILIATION_SCHEMA[0]);
    const s = await runMigrations(e.db.raw);
    assert.deepEqual(s.rebuilt, []);
    const after = await tableNames(e.db.raw);
    for (const t of NEW_TABLES) assert.ok(after.includes(t));
  } finally { e.done(); }
});

test('J3 新表不在 RESHAPED_TABLES（不可武裝 DROP 路徑），DDL 全是 IF NOT EXISTS，新欄位全是 nullable', () => {
  const reshaped = RESHAPED_TABLES.map((r) => r.table);
  for (const t of NEW_TABLES) assert.ok(!reshaped.includes(t), t);
  assert.ok(RECONCILIATION_SCHEMA.every((s) => /IF NOT EXISTS/.test(s)));
  const v11 = ADDITIVE_COLUMNS.filter((c) => c.table === 'whoop_resource_tombstones');
  assert.equal(v11.length, 3);
  assert.ok(v11.every((c) => !/NOT NULL/.test(c.ddl) && !c.backfill), '純 nullable、無回填');
});

// ===========================================================================
// K. 回歸守衛
// ===========================================================================

test('K1 正式排程器沒有接線：src/index.js 與 bot 不 import reconcile', () => {
  const root = new URL('../src/', import.meta.url);
  const files = ['index.js', 'daily.js', 'sync.js', 'bot/index.js', 'bot/webhook.js']
    .map((f) => new URL(f, root)).filter((u) => fs.existsSync(u));
  for (const u of files) {
    const src = fs.readFileSync(u, 'utf8');
    assert.ok(!/reconcile\.js|createReconciler|reconciliationStore/.test(src), `${u.pathname} 不該接線 Phase 2`);
  }
});

test('K2 V1.1 同步狀態表與對帳狀態表互不影響', async () => {
  const e = await env();
  try {
    await mk(e.db, fakeWhoop({ pages: { '/activity/sleep': { records: [], next_token: null } } })).reconcileResource('sleep');
    const legacy = await e.db.getAllSyncState(ALICE.id);
    assert.equal(legacy.length, 0, '對帳不寫 whoop_sync_state');
  } finally { e.done(); }
});

// ===========================================================================
// 對抗性攻擊
// ===========================================================================

test('ATK1 偽造擁有者字串無法結案別人的持有', async () => {
  const e = await env();
  try {
    await e.db.claimReconciliation({ userId: ALICE.id, resource: 'sleep', owner: 'real', leaseMs: 60_000, now: NOW });
    for (const owner of ['fake', '', 'real ', 'REAL', 'real ']) {
      const ok = await e.db.settleReconciliation({ userId: ALICE.id, resource: 'sleep', owner, result: RECONCILE_RESULT.SUCCESS, windowTo: NOW, now: NOW });
      assert.equal(ok, false, JSON.stringify(owner));
    }
    assert.equal((await e.db.getReconciliationState(ALICE.id, 'sleep')).windowWatermark, null);
  } finally { e.done(); }
});

test('ATK2 租約過期後的結案被拒（即使 owner 正確）', async () => {
  const e = await env();
  try {
    await e.db.claimReconciliation({ userId: ALICE.id, resource: 'sleep', owner: 'A', leaseMs: 1000, now: NOW });
    const ok = await e.db.settleReconciliation({ userId: ALICE.id, resource: 'sleep', owner: 'A', result: RECONCILE_RESULT.SUCCESS, windowTo: NOW, now: new Date(NOW.getTime() + 1001) });
    assert.equal(ok, false);
  } finally { e.done(); }
});

test('ATK3 SUCCESS 沒帶 windowTo → 拒絕（不可能把水位寫成 NULL）；水位單調不減', async () => {
  const e = await env();
  try {
    await e.db.claimReconciliation({ userId: ALICE.id, resource: 'sleep', owner: 'A', leaseMs: 60_000, now: NOW });
    await assert.rejects(e.db.settleReconciliation({ userId: ALICE.id, resource: 'sleep', owner: 'A', result: RECONCILE_RESULT.SUCCESS, now: NOW }), /window_to/);
    await e.db.settleReconciliation({ userId: ALICE.id, resource: 'sleep', owner: 'A', result: RECONCILE_RESULT.SUCCESS, windowTo: NOW, now: NOW });
    await e.db.claimReconciliation({ userId: ALICE.id, resource: 'sleep', owner: 'A', leaseMs: 60_000, now: NOW });
    await e.db.settleReconciliation({ userId: ALICE.id, resource: 'sleep', owner: 'A', result: RECONCILE_RESULT.SUCCESS, windowTo: new Date(NOW.getTime() - DAY), now: NOW });
    assert.equal((await e.db.getReconciliationState(ALICE.id, 'sleep')).windowWatermark, NOW.toISOString(), '★ 較早的 windowTo 不會讓水位倒退');
  } finally { e.done(); }
});

test('ATK4 時鐘倒退：水位在未來 → 仍抓合法的窗，水位不倒退', async () => {
  const e = await env();
  try {
    const future = new Date(NOW.getTime() + 3 * DAY);
    const w = nextWindow('sleep', { windowWatermark: future.toISOString() }, { now: NOW });
    assert.ok(w.from < w.to);
    assert.equal(w.to.toISOString(), NOW.toISOString());
    const whoop = fakeWhoop({ pages: { '/activity/sleep': { records: [], next_token: null } } });
    await mk(e.db, whoop, { now: () => future }).reconcileResource('sleep');
    const r = await mk(e.db, whoop, { now: () => NOW }).reconcileResource('sleep');
    assert.equal(r.result, RECONCILE_RESULT.SUCCESS);
    assert.equal((await e.db.getReconciliationState(ALICE.id, 'sleep')).windowWatermark, future.toISOString());
  } finally { e.done(); }
});

test('ATK5 遠端回的資源帶著比墓碑 last_known 更新的 updated_at → 仍被墓碑擋下', async () => {
  const e = await env();
  try {
    await e.db.upsertSleeps(ALICE.id, [sleepRecord({ updatedAt: daysAgo(5) })], { timezone: TZ });
    await webhookDelete(e.db, ALICE, 'sleep', sid(1));
    const whoop = fakeWhoop({ pages: { '/activity/sleep': { records: [sleepRecord({ updatedAt: daysAgo(0, -1), rr: 1 })], next_token: null } } });
    const r = await mk(e.db, whoop).reconcileResource('sleep');
    assert.equal(r.written, 0);
    assert.equal(await count(e.db, 'whoop_sleeps', ALICE.id), 0);
    assert.equal((await e.db.getTombstone(ALICE.id, 'sleep', sid(1))).state, TOMBSTONE_STATE.ACTIVE);
  } finally { e.done(); }
});

test('ATK6 遠端整個窗都是空的 → 本地一筆都不刪、只有差異紀錄', async () => {
  const e = await env();
  try {
    const ids = [sid(1), sid(2), sid(3)];
    await e.db.upsertSleeps(ALICE.id, ids.map((id) => sleepRecord({ id, start: daysAgo(20) })), { timezone: TZ });
    await mk(e.db, fakeWhoop({ pages: { '/activity/sleep': { records: [], next_token: null } } })).reconcileResource('sleep');
    assert.equal(await count(e.db, 'whoop_sleeps', ALICE.id), 3);
    assert.equal((await e.db.listDiscrepancies(ALICE.id)).length, 3);
    assert.equal((await e.db.raw.execute('SELECT COUNT(*) n FROM whoop_resource_tombstones')).rows[0].n, 0);
  } finally { e.done(); }
});

test('ATK7 無限 next_token 迴圈（同一個 token 反覆回來）→ 每輪都被預算截斷', async () => {
  const e = await env();
  try {
    const whoop = fakeWhoop({ pages: { '/activity/sleep': { records: [sleepRecord()], next_token: 'same' } } });
    const r = await mk(e.db, whoop).reconcileResource('sleep');
    assert.equal(r.result, RECONCILE_RESULT.PARTIAL);
    assert.equal(whoop.calls.length, WHOOP_RECONCILE.MAX_PAGES_PER_RUN);
    const r2 = await mk(e.db, whoop, { now: () => new Date(NOW.getTime() + 60_000) }).reconcileResource('sleep');
    assert.equal(r2.result, RECONCILE_RESULT.PARTIAL);
    assert.equal(whoop.calls.length, 2 * WHOOP_RECONCILE.MAX_PAGES_PER_RUN);
  } finally { e.done(); }
});

test('ATK8 頁裡混進沒有 id 的垃圾紀錄 → 忽略，不炸、不寫', async () => {
  const e = await env();
  try {
    const whoop = fakeWhoop({ pages: { '/activity/sleep': { records: [{ foo: 1 }, null, 7, sleepRecord()], next_token: null } } });
    const r = await mk(e.db, whoop).reconcileResource('sleep');
    assert.equal(r.result, RECONCILE_RESULT.SUCCESS); assert.equal(r.fetched, 1); assert.equal(r.written, 1);
  } finally { e.done(); }
});

test('ATK9 多使用者：Alice 的對帳只用 Alice 的 client，只寫 Alice 的列；Bob 的墓碑不影響 Alice', async () => {
  const e = await env([ALICE, BOB]);
  try {
    await e.db.upsertSleeps(BOB.id, [sleepRecord()], { timezone: TZ });
    await webhookDelete(e.db, BOB, 'sleep', sid(1));
    const bobWhoop = fakeWhoop({ pages: { '/activity/sleep': { records: [], next_token: null } } });
    const aliceWhoop = fakeWhoop({ pages: { '/activity/sleep': { records: [sleepRecord()], next_token: null } } });
    const r = await mk(e.db, aliceWhoop, { user: ALICE }).reconcileResource('sleep');
    assert.equal(r.written, 1, 'Bob 刪掉同 id 的睡眠，不影響 Alice 的同 id（不同使用者）');
    assert.equal(bobWhoop.calls.length, 0);
    assert.equal(await count(e.db, 'whoop_sleeps', ALICE.id), 1);
    assert.equal(await count(e.db, 'whoop_sleeps', BOB.id), 0);
    assert.equal((await e.db.getTombstone(BOB.id, 'sleep', sid(1))).state, TOMBSTONE_STATE.ACTIVE);
    assert.equal(await e.db.getReconciliationState(BOB.id, 'sleep'), null);
  } finally { e.done(); }
});

test('ATK10 續傳 token 不能被搬到別的窗：續傳一律沿用存下來的 from/to', () => {
  const w = nextWindow('sleep', {
    windowWatermark: NOW.toISOString(), continuationToken: 'tok',
    continuationFrom: daysAgo(30), continuationTo: daysAgo(1),
  }, { now: new Date(NOW.getTime() + 10 * DAY) });
  assert.equal(w.resumed, true); assert.equal(w.token, 'tok');
  assert.equal(w.from.toISOString(), daysAgo(30)); assert.equal(w.to.toISOString(), daysAgo(1));
});

test('ATK11 診斷步驟炸掉不影響已寫入的資料與水位前進', async () => {
  const e = await env();
  try {
    const whoop = fakeWhoop({ pages: { '/activity/sleep': { records: [sleepRecord()], next_token: null } } });
    const db = { ...e.db, recordDiscrepancy: async () => { throw new Error('disc down'); } };
    await e.db.upsertSleeps(ALICE.id, [sleepRecord({ id: sid(2), start: daysAgo(20) })], { timezone: TZ });
    const r = await createReconciler({ db, whoop, userId: ALICE.id, timezone: TZ, now: () => NOW }).reconcileResource('sleep');
    assert.equal(r.result, RECONCILE_RESULT.SUCCESS);
    assert.equal((await e.db.getReconciliationState(ALICE.id, 'sleep')).windowWatermark, NOW.toISOString());
    assert.equal(await count(e.db, 'whoop_sleeps', ALICE.id), 2);
  } finally { e.done(); }
});

test('ATK12 不支援的資源名 / 沒有 userId → 立刻拒絕，不碰 DB', async () => {
  const e = await env();
  try {
    await assert.rejects(mk(e.db, fakeWhoop()).reconcileResource('profile'), /unsupported_resource/);
    assert.throws(() => createReconciler({ db: e.db, whoop: fakeWhoop(), userId: null, timezone: TZ }));
    assert.equal((await e.db.recentReconciliationRuns(ALICE.id)).length, 0);
  } finally { e.done(); }
});
