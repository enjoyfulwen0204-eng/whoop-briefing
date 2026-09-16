/**
 * V1.2 Phase 3 — 攝取 / 分析解耦。
 *
 *   失效模型（generation + 範圍聯集）、同交易的崩潰一致性、語義變化分類
 *   （changed / unchanged / blocked / deleted）、輕量 / 重量邊界、認領 / 租約 /
 *   圍欄、generation N 不能清掉 N+1、新鮮度、多使用者、成本上限。
 *   P3-ATTACK-01 … 16 各自獨立成測試。
 *
 * 全部用真實 libSQL（本機檔案）。「崩潰」用真的子行程：commit 之後 SIGKILL 自己。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { createDb } from '../src/db.js';
import { createReconciler } from '../src/reconcile.js';
import { drainWhoopWebhookEvents } from '../src/whoopWebhookProcessor.js';
import {
  processAnalyticsForUser, processPendingAnalytics, runLightweightAnalysis, runHeavyAnalytics,
  lightRangeFor, nextLightChunk, ANALYTICS_ERROR_CLASS,
} from '../src/analyticsWorker.js';
import { classifyCanonicalWrite } from '../src/analyticsInvalidation.js';
import { runMigrations } from '../src/migrations.js';
import {
  ANALYTICS_CLASS, ANALYTICS_RESULT, ANALYTICS_FRESHNESS, TOMBSTONE_STATE, SCHEMA_VERSION,
  ANALYTICS_WORK_SCHEMA, RESHAPED_TABLES,
} from '../src/schema.js';
import { ANALYTICS_WORK } from '../src/config.js';

const TZ = 'Asia/Taipei';
const ALICE = { id: 'u-alice', whoop: '1001' };
const BOB = { id: 'u-bob', whoop: '2002' };
const NOW = new Date('2026-09-15T12:00:00.000Z');
const DAY = 86_400_000;
const HOUR = 3_600_000;
const CRASH = path.resolve(new URL('./p3-crash-worker.js', import.meta.url).pathname);
const { LIGHT, HEAVY } = ANALYTICS_CLASS;

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whoop-p3-'));
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
// 22:00Z 開始的 8 小時睡眠 → health_date = 隔天（Asia/Taipei）
const sleepRecord = ({ id = sid(1), updatedAt = at(2), rr = 15, daysAgo = 2 } = {}) => {
  const start = at(daysAgo + 1, 22 - 12);   // (daysAgo+1) 天前的 22:00Z
  return {
    id, nap: false, score_state: 'SCORED', user_id: 1,
    start, end: new Date(Date.parse(start) + 8 * HOUR).toISOString(),
    created_at: updatedAt, updated_at: updatedAt,
    score: {
      respiratory_rate: rr, sleep_performance_percentage: 80,
      stage_summary: { total_light_sleep_time_milli: 3_600_000, total_slow_wave_sleep_time_milli: 3_600_000, total_rem_sleep_time_milli: 3_600_000 },
    },
  };
};
const recoveryRecord = ({ sleepId = sid(1), updatedAt = at(2), score = 70 } = {}) => ({
  sleep_id: sleepId, cycle_id: 'c-1', user_id: 1, score_state: 'SCORED',
  created_at: updatedAt, updated_at: updatedAt,
  score: { recovery_score: score, hrv_rmssd_milli: 60, resting_heart_rate: 55 },
});
const workoutRecord = ({ id = sid(50), updatedAt = at(2), strain = 10, daysAgo = 2 } = {}) => {
  const start = at(daysAgo, 2);
  return {
    id, user_id: 1, score_state: 'SCORED', sport_name: 'running',
    start, end: new Date(Date.parse(start) + HOUR).toISOString(),
    created_at: updatedAt, updated_at: updatedAt, score: { strain, zone_durations: {} },
  };
};
const cycleRecord = ({ id = 'cy-1', updatedAt = at(2), strain = 8, daysAgo = 2 } = {}) => {
  const start = at(daysAgo + 1, 4);
  return {
    id, user_id: 1, score_state: 'SCORED', start, end: new Date(Date.parse(start) + 20 * HOUR).toISOString(),
    timezone_offset: '+08:00', created_at: updatedAt, updated_at: updatedAt,
    score: { strain, kilojoule: 8000, average_heart_rate: 60, max_heart_rate: 150 },
  };
};

const inv = (db, u = ALICE) => db.getAnalyticsInvalidation(u.id);
const gen = async (db, u = ALICE) => (await inv(db, u))?.generation ?? 0;
const fresh = (db, u = ALICE) => db.getAnalyticsFreshness(u.id);
const count = async (db, table, uid) => Number((await db.raw.execute({ sql: `SELECT COUNT(*) n FROM ${table} WHERE user_id = ?`, args: [uid] })).rows[0].n);
const healthDateOf = async (db, uid, id) => (await db.raw.execute({ sql: 'SELECT health_date FROM whoop_sleeps WHERE user_id = ? AND id = ?', args: [uid, id] })).rows[0]?.health_date ?? null;

async function webhookDelete(db, user, resourceType, resourceId, { owner = 'wh-test' } = {}) {
  const rec = await db.recordWhoopEvent({ whoopUserId: user.whoop, eventType: `${resourceType}.deleted`, resourceType, resourceId, traceId: `t-${resourceId}` });
  const ev = await db.claimWhoopEvent({ owner, leaseMs: 600_000 });
  assert.equal(ev.id, rec.id);
  await db.mutateForWhoopEvent(ev.id, { owner }, () => db.deleteWhoopResource({ userId: user.id, resourceType, resourceId, sourceEventId: ev.id }));
  await db.settleWhoopEvent(ev.id, { owner, state: 'PROCESSED', userId: user.id });
}

/** 一組有用的歷史：N 天連續 sleep + recovery（讓重量分析有東西可算）。 */
async function seedHistory(db, user, days = 12) {
  for (let i = 1; i <= days; i += 1) {
    await db.upsertSleeps(user.id, [sleepRecord({ id: sid(1000 + i), daysAgo: i, updatedAt: at(i), rr: 14 + (i % 3) })], { timezone: TZ });
    await db.upsertRecoveries(user.id, [recoveryRecord({ sleepId: sid(1000 + i), updatedAt: at(i), score: 50 + i })]);
  }
}
const light = (db, u = ALICE, opts = {}) => processAnalyticsForUser({ db, userId: u.id, cls: LIGHT, owner: opts.owner ?? 'L', now: opts.now ?? (() => NOW), ...opts });
const heavy = (db, u = ALICE, opts = {}) => processAnalyticsForUser({ db, userId: u.id, cls: HEAVY, owner: opts.owner ?? 'H', now: opts.now ?? (() => NOW), ...opts });

// ===========================================================================
// 失效模型
// ===========================================================================

test('canonical 變動 → generation +1、範圍聯集；同版本重放不失效', async () => {
  const e = await env();
  try {
    assert.equal(await inv(e.db), null);
    await e.db.upsertSleeps(ALICE.id, [sleepRecord({ id: sid(1), daysAgo: 2 })], { timezone: TZ });
    let i = await inv(e.db);
    assert.equal(i.generation, 1);
    const hd = await healthDateOf(e.db, ALICE.id, sid(1));
    assert.equal(i.affectedFrom, hd); assert.equal(i.affectedTo, hd);
    assert.deepEqual(i.resources, ['sleep']); assert.deepEqual(i.reasons, ['upsert']);
    assert.ok(i.dirtySince);
    // 同版本重放（冪等）→ 不失效
    await e.db.upsertSleeps(ALICE.id, [sleepRecord({ id: sid(1), daysAgo: 2 })], { timezone: TZ });
    assert.equal(await gen(e.db), 1, '同版本重放不算變動');
    // 另一天的 recovery → generation 2，範圍擴大
    await e.db.upsertSleeps(ALICE.id, [sleepRecord({ id: sid(2), daysAgo: 6, updatedAt: at(6) })], { timezone: TZ });
    await e.db.upsertRecoveries(ALICE.id, [recoveryRecord({ sleepId: sid(2), updatedAt: at(6) })]);
    i = await inv(e.db);
    assert.equal(i.generation, 3);
    assert.equal(i.affectedFrom, await healthDateOf(e.db, ALICE.id, sid(2)));
    assert.equal(i.affectedTo, hd);
    assert.deepEqual(i.resources, ['recovery', 'sleep']);
  } finally { e.done(); }
});

test('classifyCanonicalWrite：changed / unchanged / blocked 的純函式規則；cycle 跨到隔天', () => {
  const idOf = (r) => r.id;
  const before = new Map([['a', { updatedAt: '2026-09-10T00:00:00.000Z', date: '2026-09-10' }]]);
  // 新列
  let c = classifyCanonicalWrite({ records: [{ id: 'b', updated_at: '2026-09-11T00:00:00.000Z' }], before, after: new Map([['b', { updatedAt: '2026-09-11T00:00:00.000Z', date: '2026-09-11' }]]), idOf });
  assert.deepEqual(c, { changed: 1, unchanged: 0, blocked: 0, affectedFrom: '2026-09-11', affectedTo: '2026-09-11' });
  // 較新版本
  c = classifyCanonicalWrite({ records: [{ id: 'a', updated_at: '2026-09-12T00:00:00.000Z' }], before, after: new Map([['a', { updatedAt: '2026-09-12T00:00:00.000Z', date: '2026-09-10' }]]), idOf });
  assert.equal(c.changed, 1);
  // 同版本重放
  c = classifyCanonicalWrite({ records: [{ id: 'a', updated_at: '2026-09-10T00:00:00.000Z' }], before, after: before, idOf });
  assert.deepEqual([c.changed, c.unchanged, c.blocked], [0, 1, 0]);
  // 較舊版本（M-03 擋下）
  c = classifyCanonicalWrite({ records: [{ id: 'a', updated_at: '2026-09-01T00:00:00.000Z' }], before, after: before, idOf });
  assert.deepEqual([c.changed, c.unchanged, c.blocked], [0, 0, 1]);
  // 墓碑擋下（之後仍沒有列）
  c = classifyCanonicalWrite({ records: [{ id: 'z', updated_at: '2026-09-12T00:00:00.000Z' }], before: new Map(), after: new Map(), idOf });
  assert.deepEqual([c.changed, c.unchanged, c.blocked], [0, 0, 1]);
  // cycle：日期 + 1
  c = classifyCanonicalWrite({ records: [{ id: 'c' }], before: new Map(), after: new Map([['c', { updatedAt: null, date: '2026-09-10' }]]), idOf, spansNextDay: true });
  assert.deepEqual([c.affectedFrom, c.affectedTo], ['2026-09-10', '2026-09-11']);
});

test('每種資源都會失效：sleep / recovery / workout / cycle（+1 天）/ body_measurement（數值變才算）', async () => {
  const e = await env();
  try {
    await e.db.upsertSleeps(ALICE.id, [sleepRecord({ id: sid(1) })], { timezone: TZ });
    assert.equal(await gen(e.db), 1);
    await e.db.upsertRecoveries(ALICE.id, [recoveryRecord({ sleepId: sid(1) })]);
    assert.equal(await gen(e.db), 2);
    await e.db.upsertWorkouts(ALICE.id, [workoutRecord()], { timezone: TZ });
    assert.equal(await gen(e.db), 3);
    await e.db.upsertCycles(ALICE.id, [cycleRecord({ daysAgo: 9 })]);
    let i = await inv(e.db);
    assert.equal(i.generation, 4);
    assert.equal(i.affectedFrom, at(10, 4).slice(0, 10), 'cycle start 的日期');
    await e.db.upsertBodyMeasurement(ALICE.id, { height_meter: 1.8, weight_kilogram: 75, max_heart_rate: 190 }, { now: NOW });
    assert.equal(await gen(e.db), 5);
    await e.db.upsertBodyMeasurement(ALICE.id, { height_meter: 1.8, weight_kilogram: 75, max_heart_rate: 190 }, { now: NOW });
    assert.equal(await gen(e.db), 5, '同一天同數值 → 不失效');
    await e.db.upsertBodyMeasurement(ALICE.id, { height_meter: 1.8, weight_kilogram: 76, max_heart_rate: 190 }, { now: NOW });
    i = await inv(e.db);
    assert.equal(i.generation, 6);
    assert.ok(i.resources.includes('body_measurement'));
  } finally { e.done(); }
});

// ===========================================================================
// P3-ATTACK-01 / 04 / 15 — 崩潰一致性（真的子行程 SIGKILL）
// ===========================================================================

function crash(url, userId, op, payload) {
  const r = spawnSync(process.execPath, [CRASH, url, userId, op, JSON.stringify(payload)], { encoding: 'utf8', timeout: 60_000 });
  return { signal: r.signal, out: `${r.stdout}${r.stderr}` };
}

test('P3-ATTACK-01 canonical 變動 → commit 後立刻 SIGKILL → 重開仍有分析工作（同一個 commit）', async () => {
  const e = await env();
  try {
    e.db.close();
    const r = crash(e.url, ALICE.id, 'upsert', { record: sleepRecord({ id: sid(1) }) });
    assert.equal(r.signal, 'SIGKILL'); assert.ok(/COMMITTED/.test(r.out), r.out);
    const db2 = createDb({ url: e.url });
    assert.equal(await count(db2, 'whoop_sleeps', ALICE.id), 1, 'canonical 在');
    const i = await db2.getAnalyticsInvalidation(ALICE.id);
    assert.equal(i.generation, 1, '★★★ 分析失效也在');
    const pending = await db2.listPendingAnalytics(LIGHT, { now: NOW });
    assert.deepEqual(pending.map((p) => p.userId), [ALICE.id]);
    const f = await db2.getAnalyticsFreshness(ALICE.id);
    assert.equal(f.light.status, ANALYTICS_FRESHNESS.PENDING); assert.equal(f.heavy.status, ANALYTICS_FRESHNESS.PENDING);
    db2.close();
  } finally { e.done(); }
});

test('P3-ATTACK-04 DELETE commit 後立刻 SIGKILL → 重開：canonical 沒了、墓碑 ACTIVE、分析工作在', async () => {
  const e = await env();
  try {
    await e.db.upsertSleeps(ALICE.id, [sleepRecord({ id: sid(1) })], { timezone: TZ });
    await light(e.db); await heavy(e.db);
    assert.equal((await fresh(e.db)).light.status, ANALYTICS_FRESHNESS.CURRENT);
    const hd = await healthDateOf(e.db, ALICE.id, sid(1));
    e.db.close();
    const r = crash(e.url, ALICE.id, 'delete', { whoopUserId: ALICE.whoop, resourceId: sid(1) });
    assert.equal(r.signal, 'SIGKILL'); assert.ok(/COMMITTED/.test(r.out), r.out);
    const db2 = createDb({ url: e.url });
    assert.equal(await count(db2, 'whoop_sleeps', ALICE.id), 0);
    assert.equal((await db2.getTombstone(ALICE.id, 'sleep', sid(1))).state, TOMBSTONE_STATE.ACTIVE);
    const i = await db2.getAnalyticsInvalidation(ALICE.id);
    assert.equal(i.generation, 2, '★★★ 刪除的失效與刪除同一個 commit');
    assert.ok(i.reasons.includes('delete')); assert.equal(i.affectedFrom, hd);
    const f = await db2.getAnalyticsFreshness(ALICE.id);
    assert.equal(f.light.status, ANALYTICS_FRESHNESS.PENDING); assert.equal(f.heavy.status, ANALYTICS_FRESHNESS.PENDING);
    db2.close();
  } finally { e.done(); }
});

test('原子性另一面：canonical 交易 rollback → 失效也不會留下', async () => {
  const e = await env();
  try {
    await e.db.upsertSleeps(ALICE.id, [sleepRecord({ id: sid(1) })], { timezone: TZ });
    assert.equal(await gen(e.db), 1);
    // 在 mutateForReconciliation 的交易裡寫入之後拋錯 → 整個交易 rollback
    await e.db.claimReconciliation({ userId: ALICE.id, resource: 'sleep', owner: 'X', leaseMs: 60_000, now: NOW });
    await assert.rejects(e.db.mutateForReconciliation({ userId: ALICE.id, resource: 'sleep', owner: 'X', now: () => NOW }, async () => {
      await e.db.upsertSleeps(ALICE.id, [sleepRecord({ id: sid(2), daysAgo: 3, updatedAt: at(3) })], { timezone: TZ });
      throw new Error('boom after write');
    }), /boom/);
    assert.equal(await count(e.db, 'whoop_sleeps', ALICE.id), 1, 'canonical 回滾');
    assert.equal(await gen(e.db), 1, '★ 失效也回滾：沒有「失效在、資料不在」');
  } finally { e.done(); }
});

test('P3-ATTACK-15 完整重啟：待處理的分析、認領中的租約、done_generation 全部耐久', async () => {
  const e = await env();
  try {
    await seedHistory(e.db, ALICE, 3);
    await light(e.db);
    const before = await fresh(e.db);
    await e.db.upsertSleeps(ALICE.id, [sleepRecord({ id: sid(9), daysAgo: 1, updatedAt: at(1) })], { timezone: TZ });
    const claimed = await e.db.claimAnalyticsWork({ userId: ALICE.id, cls: HEAVY, owner: 'old-proc', leaseMs: 60_000, now: NOW });
    assert.ok(claimed);
    e.db.close();
    const db2 = createDb({ url: e.url });
    const f = await db2.getAnalyticsFreshness(ALICE.id);
    assert.equal(f.light.doneGeneration, before.light.doneGeneration);
    assert.equal(f.light.status, ANALYTICS_FRESHNESS.PENDING);
    assert.equal(f.heavy.owner, 'old-proc', '租約耐久（過期前不能被接手）');
    assert.equal((await db2.listPendingAnalytics(HEAVY, { now: NOW })).length, 0, '租約有效 → 不列出');
    assert.equal((await db2.listPendingAnalytics(HEAVY, { now: new Date(NOW.getTime() + 61_000) })).length, 1, '租約過期 → 可接手');
    db2.close();
  } finally { e.done(); }
});

// ===========================================================================
// P3-ATTACK-02 / 03 / 13 — 沒有語義變化就不失效
// ===========================================================================

test('P3-ATTACK-02 M-03 擋下的較舊版本 → 不失效（重量分析不會被無謂觸發）', async () => {
  const e = await env();
  try {
    await e.db.upsertSleeps(ALICE.id, [sleepRecord({ id: sid(1), updatedAt: at(1), rr: 16 })], { timezone: TZ });
    await light(e.db); await heavy(e.db);
    assert.equal((await fresh(e.db)).heavy.status, ANALYTICS_FRESHNESS.CURRENT);
    const n = await e.db.upsertSleeps(ALICE.id, [sleepRecord({ id: sid(1), updatedAt: at(3), rr: 10 })], { timezone: TZ });
    assert.equal(n, 0, 'M-03 擋下');
    assert.equal(await gen(e.db), 1, '★ generation 不動');
    assert.equal((await fresh(e.db)).heavy.status, ANALYTICS_FRESHNESS.CURRENT, '★ 重量仍是最新');
    assert.equal((await e.db.listPendingAnalytics(HEAVY, { now: NOW })).length, 0);
  } finally { e.done(); }
});

test('P3-ATTACK-03 ACTIVE 墓碑擋下的復活 → 不失效、不復活、墓碑不變', async () => {
  const e = await env();
  try {
    await e.db.upsertSleeps(ALICE.id, [sleepRecord({ id: sid(1) })], { timezone: TZ });
    await webhookDelete(e.db, ALICE, 'sleep', sid(1));
    const g = await gen(e.db);   // upsert + delete = 2
    assert.equal(g, 2);
    await light(e.db); await heavy(e.db);
    const n = await e.db.upsertSleeps(ALICE.id, [sleepRecord({ id: sid(1), updatedAt: at(0, -1), rr: 99 })], { timezone: TZ });
    assert.equal(n, 0);
    assert.equal(await count(e.db, 'whoop_sleeps', ALICE.id), 0, '沒復活');
    assert.equal((await e.db.getTombstone(ALICE.id, 'sleep', sid(1))).state, TOMBSTONE_STATE.ACTIVE);
    assert.equal(await gen(e.db), 2, '★ 被擋下的復活不是 canonical 變動');
    assert.equal((await fresh(e.db)).heavy.status, ANALYTICS_FRESHNESS.CURRENT);
  } finally { e.done(); }
});

test('P3-ATTACK-13 同版本重放 N 次（同步重疊窗每小時都會這樣）→ 零 churn', async () => {
  const e = await env();
  try {
    await seedHistory(e.db, ALICE, 5);
    await light(e.db); await heavy(e.db);
    const g = await gen(e.db);
    for (let i = 0; i < 20; i += 1) {
      await e.db.upsertSleeps(ALICE.id, [sleepRecord({ id: sid(1001), daysAgo: 1, updatedAt: at(1), rr: 15 })], { timezone: TZ });
      await e.db.upsertRecoveries(ALICE.id, [recoveryRecord({ sleepId: sid(1001), updatedAt: at(1), score: 51 })]);
    }
    assert.equal(await gen(e.db), g, '★ 40 次重放，generation 不動');
    const f = await fresh(e.db);
    assert.equal(f.light.status, ANALYTICS_FRESHNESS.CURRENT); assert.equal(f.heavy.status, ANALYTICS_FRESHNESS.CURRENT);
    const out = await processPendingAnalytics({ db: e.db, cls: HEAVY, now: () => NOW });
    assert.equal(out.candidates, 0, '沒有任何重量工作被排出來');
  } finally { e.done(); }
});

// ===========================================================================
// P3-ATTACK-05 — 合併
// ===========================================================================

test('P3-ATTACK-05 同一使用者 30 秒內 sleep / recovery / workout 連續變動 → 一列狀態、範圍聯集、一次輕量 + 一次重量', async () => {
  const e = await env();
  try {
    await e.db.upsertSleeps(ALICE.id, [sleepRecord({ id: sid(1), daysAgo: 1, updatedAt: at(1) })], { timezone: TZ });
    await e.db.upsertRecoveries(ALICE.id, [recoveryRecord({ sleepId: sid(1), updatedAt: at(1) })]);
    await e.db.upsertWorkouts(ALICE.id, [workoutRecord({ daysAgo: 4, updatedAt: at(4) })], { timezone: TZ });
    await e.db.upsertSleeps(ALICE.id, [sleepRecord({ id: sid(1), daysAgo: 1, updatedAt: at(0, -1), rr: 17 })], { timezone: TZ });
    const i = await inv(e.db);
    assert.equal(i.generation, 4);
    assert.equal((await e.db.raw.execute({ sql: 'SELECT COUNT(*) n FROM analytics_invalidation WHERE user_id = ?', args: [ALICE.id] })).rows[0].n, 1, '一列，不是每個事件一列');
    assert.deepEqual(i.resources, ['sleep', 'recovery', 'workout'].sort());
    const workoutDay = at(4, 2).slice(0, 10);
    assert.ok(i.affectedFrom <= workoutDay && i.affectedTo >= await healthDateOf(e.db, ALICE.id, sid(1)), '範圍聯集');
    // 只需要一次輕量 + 一次重量
    const l = await processPendingAnalytics({ db: e.db, cls: LIGHT, now: () => NOW });
    assert.equal(l.processed.length, 1); assert.equal(l.processed[0].result, ANALYTICS_RESULT.SUCCESS);
    const h = await processPendingAnalytics({ db: e.db, cls: HEAVY, now: () => NOW });
    assert.equal(h.processed.length, 1); assert.equal(h.processed[0].result, ANALYTICS_RESULT.SUCCESS);
    const f = await fresh(e.db);
    assert.equal(f.light.doneGeneration, 4); assert.equal(f.heavy.doneGeneration, 4);
    assert.equal(f.dirtySince, null, '全部追上 → dirty_since 清掉');
    const after = await inv(e.db);
    assert.equal(after.affectedFrom, null, '輕量消化後範圍清掉');
    assert.equal((await e.db.recentAnalyticsRuns(ALICE.id)).length, 2);
  } finally { e.done(); }
});

// ===========================================================================
// P3-ATTACK-06 / 07 / 17 — generation N 不能清掉 N+1；過期持有者
// ===========================================================================

test('P3-ATTACK-06 分析中又有新 canonical 變動 → 結案只寫 done=N，N+1 仍待處理；範圍不被清', async () => {
  const e = await env();
  try {
    await seedHistory(e.db, ALICE, 4);
    const g0 = await gen(e.db);
    // 重量：在 predictionCycle 執行中插入新資料
    let injected = false;
    const deps = {
      predictionCycle: async () => {
        if (!injected) {
          injected = true;
          await e.db.upsertSleeps(ALICE.id, [sleepRecord({ id: sid(77), daysAgo: 1, updatedAt: at(0, -2) })], { timezone: TZ });
        }
        return { maturity: 'WARMING_UP', qualified: false };
      },
      healthspan: async () => ({ maturity: 'WARMING_UP', saved: false }),
    };
    const r = await heavy(e.db, ALICE, { deps });
    assert.equal(r.result, ANALYTICS_RESULT.SUCCESS);
    assert.equal(r.generation, g0);
    assert.equal(r.stillDirty, true, '★ 回報：期間又髒了');
    const f = await fresh(e.db);
    assert.equal(f.generation, g0 + 1);
    assert.equal(f.heavy.doneGeneration, g0);
    assert.equal(f.heavy.status, ANALYTICS_FRESHNESS.PENDING, '★★★ N+1 仍待處理');
    assert.deepEqual((await e.db.listPendingAnalytics(HEAVY, { now: NOW })).map((p) => p.userId), [ALICE.id]);

    // 輕量：在讀 coverage 時插入新資料 → 結案 CAS 不清範圍
    const dbHook = { ...e.db, coverage: async (u) => { await e.db.upsertRecoveries(ALICE.id, [recoveryRecord({ sleepId: sid(77), updatedAt: at(0, -1) })]); return e.db.coverage(u); } };
    const r2 = await processAnalyticsForUser({ db: dbHook, userId: ALICE.id, cls: LIGHT, owner: 'L', now: () => NOW });
    assert.equal(r2.result, ANALYTICS_RESULT.SUCCESS); assert.equal(r2.stillDirty, true);
    const i = await inv(e.db);
    assert.equal(i.generation, g0 + 2);
    assert.ok(i.affectedFrom, '★ 範圍保留給 N+2（CAS 失敗不清）');
    assert.equal((await fresh(e.db)).light.status, ANALYTICS_FRESHNESS.PENDING);
    // 再跑一次就追上
    const r3 = await light(e.db);
    assert.equal(r3.result, ANALYTICS_RESULT.SUCCESS); assert.equal(r3.stillDirty, false);
    assert.equal((await fresh(e.db)).light.status, ANALYTICS_FRESHNESS.CURRENT);
    assert.equal((await inv(e.db)).affectedFrom, null);
  } finally { e.done(); }
});

test('P3-ATTACK-07 A 租約過期、B 接手完成、A 晚到 → A 被圍欄擋下，不能覆蓋 B 的 done_generation', async () => {
  const e = await env();
  try {
    await seedHistory(e.db, ALICE, 3);
    let t = NOW.getTime();
    const now = () => new Date(t);
    let bResult = null;
    const deps = {
      predictionCycle: async () => {
        // A 正在算；租約過期；新資料進來；B 接手並完成
        t += ANALYTICS_WORK.LEASE_MS.heavy + 1;
        await e.db.upsertSleeps(ALICE.id, [sleepRecord({ id: sid(78), daysAgo: 1, updatedAt: at(0, -2) })], { timezone: TZ });
        bResult = await heavy(e.db, ALICE, { owner: 'B', now, deps: { predictionCycle: async () => ({}), healthspan: async () => ({}) } });
        return {};
      },
      healthspan: async () => ({}),
    };
    const a = await heavy(e.db, ALICE, { owner: 'A', now, deps });
    assert.equal(bResult.result, ANALYTICS_RESULT.SUCCESS);
    assert.equal(a.result, ANALYTICS_RESULT.FENCED, '★★★ A 晚到被圍欄擋下');
    const f = await fresh(e.db);
    assert.equal(f.heavy.doneGeneration, bResult.generation);
    assert.equal(f.heavy.status, ANALYTICS_FRESHNESS.CURRENT);
    assert.equal(f.heavy.owner, null);
    const runs = await e.db.recentAnalyticsRuns(ALICE.id, { cls: HEAVY });
    assert.deepEqual(runs.map((r) => [r.owner, r.result]), [['B', 'SUCCESS'], ['A', 'FENCED']]);
    // store 層：A 直接 settle 也寫不進
    assert.equal(await e.db.settleAnalyticsWork({ userId: ALICE.id, cls: HEAVY, owner: 'A', result: ANALYTICS_RESULT.SUCCESS, generation: 999, now: now() }), false);
    assert.equal((await fresh(e.db)).heavy.doneGeneration, bResult.generation);
  } finally { e.done(); }
});

test('P3-ATTACK-14 / 17 衍生新鮮度：generation 前進後，輕量物化列與重量狀態都可偵測為舊', async () => {
  const e = await env();
  try {
    await seedHistory(e.db, ALICE, 3);
    await light(e.db); await heavy(e.db);
    const rows = await e.db.getAnalyticsDailyState(ALICE.id);
    assert.ok(rows.length >= 3);
    const g = await gen(e.db);
    assert.ok(rows.every((r) => r.generation === g));
    await e.db.upsertSleeps(ALICE.id, [sleepRecord({ id: sid(1001), daysAgo: 1, updatedAt: at(0, -1), rr: 19 })], { timezone: TZ });
    const f = await fresh(e.db);
    assert.equal(f.generation, g + 1);
    assert.equal(f.light.status, ANALYTICS_FRESHNESS.PENDING);
    assert.equal(f.heavy.status, ANALYTICS_FRESHNESS.PENDING, '★ 重量衍生輸出可偵測為舊');
    const stale = await e.db.getAnalyticsDailyState(ALICE.id);
    assert.ok(stale.every((r) => r.generation < f.generation), '每一列都比目前 generation 舊');
    const hd1001 = await healthDateOf(e.db, ALICE.id, sid(1001));
    const old = stale.find((r) => r.healthDate === hd1001);
    assert.equal(old.metrics.respiratory_rate, 15, '舊輸出仍是舊值（而且可辨識）');
    await light(e.db);
    const fresh2 = await e.db.getAnalyticsDailyState(ALICE.id);
    const updated = fresh2.find((r) => r.healthDate === old.healthDate);
    assert.equal(updated.metrics.respiratory_rate, 19); assert.equal(updated.generation, g + 1);
  } finally { e.done(); }
});

// ===========================================================================
// P3-ATTACK-08 / 09 — 失敗
// ===========================================================================

test('P3-ATTACK-08 輕量失敗（讀取不完整）→ canonical 不動、髒狀態保留、退避、重試成功', async () => {
  const e = await env();
  try {
    await seedHistory(e.db, ALICE, 3);
    const broken = { ...e.db, getWorkouts: async () => { throw new Error('workouts down'); } };
    const r = await processAnalyticsForUser({ db: broken, userId: ALICE.id, cls: LIGHT, owner: 'L', now: () => NOW });
    assert.equal(r.result, ANALYTICS_RESULT.FAILED);
    assert.equal(r.errorClass, ANALYTICS_ERROR_CLASS.INPUT_INCOMPLETE);
    assert.equal(await count(e.db, 'whoop_sleeps', ALICE.id), 3, 'canonical 完好');
    assert.equal((await e.db.getAnalyticsDailyState(ALICE.id)).length, 0, '★ 讀取失敗不物化成「沒有」');
    const f = await fresh(e.db);
    assert.equal(f.light.status, ANALYTICS_FRESHNESS.FAILED);
    assert.equal(f.light.doneGeneration, 0); assert.ok(f.light.nextAttemptAt); assert.equal(f.light.consecutiveFailures, 1);
    assert.equal((await e.db.listPendingAnalytics(LIGHT, { now: NOW })).length, 0, '退避中不列出');
    const later = new Date(Date.parse(f.light.nextAttemptAt) + 1);
    assert.equal((await e.db.listPendingAnalytics(LIGHT, { now: later })).length, 1, '退避後列出');
    const r2 = await light(e.db, ALICE, { now: () => later });
    assert.equal(r2.result, ANALYTICS_RESULT.SUCCESS);
    assert.equal((await fresh(e.db)).light.status, ANALYTICS_FRESHNESS.CURRENT);
    assert.equal((await fresh(e.db)).light.consecutiveFailures, 0);
  } finally { e.done(); }
});

test('P3-ATTACK-09 重量部分失敗 → 成功模組的輸出保留、canonical 與輕量不動、重量 FAILED 不假裝最新', async () => {
  const e = await env();
  try {
    await seedHistory(e.db, ALICE, 3);
    await light(e.db);
    const deps = {
      predictionCycle: async ({ db, userId }) => { await db.saveHealthspanMetrics(userId, [], { now: NOW }); return { maturity: 'WARMING_UP' }; },
      healthspan: async () => { throw new Error('healthspan exploded'); },
    };
    const r = await heavy(e.db, ALICE, { deps });
    assert.equal(r.result, ANALYTICS_RESULT.FAILED); assert.equal(r.errorClass, ANALYTICS_ERROR_CLASS.MODULE_FAILED);
    const f = await fresh(e.db);
    assert.equal(f.heavy.status, ANALYTICS_FRESHNESS.FAILED); assert.equal(f.heavy.doneGeneration, 0);
    assert.equal(f.light.status, ANALYTICS_FRESHNESS.CURRENT, '輕量不受影響');
    assert.equal(await count(e.db, 'whoop_sleeps', ALICE.id), 3);
    const runs = await e.db.recentAnalyticsRuns(ALICE.id, { cls: HEAVY });
    assert.equal(runs[0].result, 'FAILED'); assert.ok(runs[0].detail?.healthspan?.error, '失敗來源記錄在帳本');
    assert.ok(runs[0].detail?.prediction, '成功模組的摘要也在');
  } finally { e.done(); }
});

// ===========================================================================
// P3-ATTACK-10 — 多使用者
// ===========================================================================

test('P3-ATTACK-10 Alice / Bob 同 id 同日期：失效、認領、結果、物化全部隔離', async () => {
  const e = await env([ALICE, BOB]);
  try {
    await e.db.upsertSleeps(ALICE.id, [sleepRecord({ id: sid(1), rr: 11 })], { timezone: TZ });
    await e.db.upsertSleeps(BOB.id, [sleepRecord({ id: sid(1), rr: 22 })], { timezone: TZ });
    assert.equal(await gen(e.db, ALICE), 1); assert.equal(await gen(e.db, BOB), 1);
    await e.db.upsertRecoveries(BOB.id, [recoveryRecord({ sleepId: sid(1) })]);
    assert.equal(await gen(e.db, ALICE), 1, 'Bob 的變動不動 Alice'); assert.equal(await gen(e.db, BOB), 2);
    // 認領互不衝突
    assert.ok(await e.db.claimAnalyticsWork({ userId: ALICE.id, cls: LIGHT, owner: 'X', leaseMs: 60_000, now: NOW }));
    assert.ok(await e.db.claimAnalyticsWork({ userId: BOB.id, cls: LIGHT, owner: 'Y', leaseMs: 60_000, now: NOW }));
    assert.equal(await e.db.settleAnalyticsWork({ userId: ALICE.id, cls: LIGHT, owner: 'Y', result: ANALYTICS_RESULT.SUCCESS, generation: 1, now: NOW }), false, 'Bob 的 owner 不能結 Alice 的案');
    await e.db.releaseAnalyticsWork({ userId: ALICE.id, cls: LIGHT, owner: 'X', now: NOW });
    await e.db.releaseAnalyticsWork({ userId: BOB.id, cls: LIGHT, owner: 'Y', now: NOW });
    await light(e.db, ALICE); await light(e.db, BOB);
    const a = await e.db.getAnalyticsDailyState(ALICE.id); const b = await e.db.getAnalyticsDailyState(BOB.id);
    assert.equal(a.find((r) => r.metrics.respiratory_rate === 11)?.metrics.respiratory_rate, 11);
    assert.equal(b.find((r) => r.metrics.respiratory_rate === 22)?.metrics.respiratory_rate, 22);
    assert.ok(!a.some((r) => r.metrics.respiratory_rate === 22) && !b.some((r) => r.metrics.respiratory_rate === 11));
    // Bob 的刪除不會讓 Alice 髒
    await webhookDelete(e.db, BOB, 'sleep', sid(1));
    assert.equal((await fresh(e.db, ALICE)).light.status, ANALYTICS_FRESHNESS.CURRENT);
    assert.equal((await fresh(e.db, BOB)).light.status, ANALYTICS_FRESHNESS.PENDING);
    assert.equal(await count(e.db, 'whoop_sleeps', ALICE.id), 1);
    const pend = await e.db.listPendingAnalytics(LIGHT, { now: NOW });
    assert.deepEqual(pend.map((p) => p.userId), [BOB.id]);
  } finally { e.done(); }
});

// ===========================================================================
// P3-ATTACK-11 / 12 — 攝取路徑
// ===========================================================================

test('P3-ATTACK-11 Phase 2 深度對帳修好舊資源 → 失效；快 / 深水位正確；對帳不等重量分析', async () => {
  const e = await env();
  try {
    await e.db.upsertSleeps(ALICE.id, [sleepRecord({ id: sid(1), daysAgo: 20, updatedAt: at(20), rr: 15 })], { timezone: TZ });
    await light(e.db); await heavy(e.db);
    const g = await gen(e.db);
    const remote = { records: [sleepRecord({ id: sid(1), daysAgo: 20, updatedAt: at(0, -1), rr: 16 })], next_token: null };
    const whoop = { apiGet: async () => remote, bodyMeasurement: async () => ({}) };
    const rec = createReconciler({ db: e.db, whoop, userId: ALICE.id, timezone: TZ, now: () => NOW });
    const d = await rec.reconcileDeep('sleep');
    assert.equal(d.result, 'SUCCESS'); assert.equal(d.written, 1);
    assert.equal(await gen(e.db), g + 1, '★ 對帳的修復讓分析失效');
    const f = await fresh(e.db);
    assert.equal(f.heavy.status, ANALYTICS_FRESHNESS.PENDING);
    assert.equal(f.heavy.doneGeneration, g, '對帳沒有等重量分析（重量仍是舊代）');
    const ds = await e.db.getReconciliationState(ALICE.id, 'sleep/deep');
    assert.equal(ds.windowWatermark, new Date(NOW.getTime() - 30 * DAY).toISOString(), '深度游標正確');
    assert.equal(await e.db.getReconciliationState(ALICE.id, 'sleep'), null, '快路徑水位不受影響');
    // 快路徑：同版本重抓 → 不失效
    const whoop2 = { apiGet: async () => remote, bodyMeasurement: async () => ({}) };
    const r = await createReconciler({ db: e.db, whoop: whoop2, userId: ALICE.id, timezone: TZ, now: () => NOW }).reconcileResource('sleep');
    assert.equal(r.result, 'SUCCESS');
    assert.equal(await gen(e.db), g + 1, '同版本 → 不失效');
    assert.equal((await e.db.getReconciliationState(ALICE.id, 'sleep')).windowWatermark, NOW.toISOString());
  } finally { e.done(); }
});

test('P3-ATTACK-12 webhook：HTTP 邊界只寫帳本（不失效）；處理階段 canonical 變了才失效', async () => {
  const e = await env();
  try {
    // 1. 入站：只有帳本
    const rec = await e.db.recordWhoopEvent({ whoopUserId: ALICE.whoop, eventType: 'sleep.updated', resourceType: 'sleep', resourceId: sid(1), traceId: 't-1' });
    assert.ok(rec.id);
    assert.equal(await inv(e.db), null, '★ 入站不碰分析狀態');
    assert.equal(await count(e.db, 'whoop_sleeps', ALICE.id), 0);
    // 2. 處理：拿到權威資料、寫 canonical → 失效在同一個處理交易
    const whoop = { apiGet: async () => sleepRecord({ id: sid(1), rr: 15 }) };
    const drain = () => drainWhoopWebhookEvents({ db: e.db, owner: 'proc', whoopFor: () => whoop, now: () => NOW, batch: 5 });
    const d1 = await drain();
    assert.equal(d1.claimed, 1);
    assert.equal(await count(e.db, 'whoop_sleeps', ALICE.id), 1, 'canonical 寫入');
    assert.equal(await gen(e.db), 1, '★ 失效發生在處理階段');
    // 3. 同一版本再處理一次 → 不失效
    await e.db.recordWhoopEvent({ whoopUserId: ALICE.whoop, eventType: 'sleep.updated', resourceType: 'sleep', resourceId: sid(1), traceId: 't-2' });
    await drain();
    assert.equal(await gen(e.db), 1);
    // 4. 刪除事件 → 失效（原因 delete）
    await e.db.recordWhoopEvent({ whoopUserId: ALICE.whoop, eventType: 'sleep.deleted', resourceType: 'sleep', resourceId: sid(1), traceId: 't-3' });
    await drain();
    assert.equal(await count(e.db, 'whoop_sleeps', ALICE.id), 0);
    const i = await inv(e.db);
    assert.equal(i.generation, 2); assert.ok(i.reasons.includes('delete'));
  } finally { e.done(); }
});

// ===========================================================================
// P3-ATTACK-16 — 有界的執行器
// ===========================================================================

test('P3-ATTACK-16 大量待處理使用者 → 單次執行最多 MAX_USERS_PER_RUN；輕量最多 LIGHT_MAX_DAYS 天', async () => {
  const users = Array.from({ length: 8 }, (_, i) => ({ id: `u-${i}`, whoop: `9${i}` }));
  const e = await env(users);
  try {
    for (const u of users) await e.db.upsertSleeps(u.id, [sleepRecord({ id: sid(1) })], { timezone: TZ });
    const r1 = await processPendingAnalytics({ db: e.db, cls: LIGHT, now: () => NOW });
    assert.equal(r1.processed.length, ANALYTICS_WORK.MAX_USERS_PER_RUN, '★ 有上限');
    const r2 = await processPendingAnalytics({ db: e.db, cls: LIGHT, now: () => NOW });
    assert.equal(r2.processed.length, users.length - ANALYTICS_WORK.MAX_USERS_PER_RUN, '剩下的下一輪');
    assert.equal((await processPendingAnalytics({ db: e.db, cls: LIGHT, now: () => NOW })).candidates, 0);
    assert.equal((await processPendingAnalytics({ db: e.db, cls: LIGHT, now: () => NOW, maxUsers: 2 })).candidates, 0);
    // 輕量：需要的範圍不截斷；一片最多 LIGHT_MAX_DAYS 天，剩餘耐久保留（F03）
    const wide = lightRangeFor({ affectedFrom: '2026-01-01', affectedTo: '2026-09-15', anchorDate: '2026-09-15' });
    assert.deepEqual(wide, { from: '2025-12-31', to: '2026-09-16' });
    const c = nextLightChunk(wide);
    assert.deepEqual(c, { chunk: { from: '2026-08-03', to: '2026-09-16' }, remainingTo: '2026-08-02', complete: false });
    const narrow = lightRangeFor({ affectedFrom: '2026-09-10', affectedTo: '2026-09-12', anchorDate: '2026-09-15' });
    assert.deepEqual(narrow, { from: '2026-09-09', to: '2026-09-13' });
    assert.deepEqual(nextLightChunk(narrow), { chunk: narrow, remainingTo: null, complete: true });
    assert.equal(lightRangeFor({ affectedFrom: null, affectedTo: null, anchorDate: null }), null);
  } finally { e.done(); }
});

// ===========================================================================
// 邊界 / 就緒 / 節奏 / 遷移
// ===========================================================================

test('輕量邊界：物化 daily metrics + 當日就緒狀態；沒有資料 → NO_DATA、不寫任何列', async () => {
  const e = await env();
  try {
    const r0 = await runLightweightAnalysis({ db: e.db, userId: ALICE.id, timezone: TZ, generation: 1, owner: 'L', range: null, now: NOW, clock: () => NOW });
    assert.equal(r0.days, 0); assert.equal(r0.dailyStatus, 'NO_DATA');
    await seedHistory(e.db, ALICE, 3);
    const i = await inv(e.db);
    // 直接呼叫邊界也必須持有租約（F01）：先認領
    const claim = await e.db.claimAnalyticsWork({ userId: ALICE.id, cls: LIGHT, owner: 'L', leaseMs: 60_000, now: NOW });
    const range = lightRangeFor({ affectedFrom: i.affectedFrom, affectedTo: i.affectedTo, anchorDate: null });
    const r = await runLightweightAnalysis({ db: e.db, userId: ALICE.id, timezone: TZ, generation: claim.generation, owner: 'L', range, now: NOW, clock: () => NOW });
    assert.ok(r.days >= 3); assert.equal(r.anchorDate, (await e.db.coverage(ALICE.id)).last_date);
    assert.equal(r.dailyStatus, 'READY');
    const rows = await e.db.getAnalyticsDailyState(ALICE.id);
    const anchor = rows.find((x) => x.healthDate === r.anchorDate);
    assert.equal(anchor.dailyStatus, 'READY'); assert.equal(anchor.metrics.has_sleep, true); assert.equal(typeof anchor.metrics.recovery, 'number');
    // 沒有睡眠那天的列：DEGRADED，數值 null（不是 0）
    const empty = rows.find((x) => x.metrics.has_sleep === false);
    if (empty) { assert.equal(empty.dailyStatus, 'DEGRADED'); assert.equal(empty.metrics.recovery, null); }
  } finally { e.done(); }
});

test('重量邊界：真的跑預測 + Healthspan（少量資料 → 未成熟、不發布、不拋錯）；節奏門檻；force', async () => {
  const e = await env();
  try {
    await seedHistory(e.db, ALICE, 6);
    const r = await runHeavyAnalytics({ db: e.db, userId: ALICE.id, timezone: TZ, now: NOW });
    assert.ok(r.modules.prediction.maturity); assert.equal(r.modules.prediction.qualified, false, '品質門檻沒過 → 不合格');
    assert.ok(r.modules.healthspan.maturity);
    assert.equal(r.failed.length, 0);
    const h1 = await heavy(e.db);
    assert.equal(h1.result, ANALYTICS_RESULT.SUCCESS);
    // 新變動；30 分鐘內 → heavy_cadence 跳過，且 next_attempt_at 讓 list 不列出
    await e.db.upsertSleeps(ALICE.id, [sleepRecord({ id: sid(1001), daysAgo: 1, updatedAt: at(0, -1), rr: 19 })], { timezone: TZ });
    const h2 = await heavy(e.db, ALICE, { now: () => new Date(NOW.getTime() + 5 * 60_000) });
    assert.equal(h2.result, ANALYTICS_RESULT.SKIPPED); assert.equal(h2.reason, 'heavy_cadence');
    assert.equal((await fresh(e.db)).heavy.status, ANALYTICS_FRESHNESS.PENDING, '仍然標為待處理，不假裝最新');
    assert.equal((await e.db.listPendingAnalytics(HEAVY, { now: new Date(NOW.getTime() + 6 * 60_000) })).length, 0);
    assert.equal((await e.db.listPendingAnalytics(HEAVY, { now: new Date(NOW.getTime() + 31 * 60_000) })).length, 1);
    const h3 = await heavy(e.db, ALICE, { now: () => new Date(NOW.getTime() + 31 * 60_000) });
    assert.equal(h3.result, ANALYTICS_RESULT.SUCCESS);
    // force 忽略節奏
    await e.db.upsertSleeps(ALICE.id, [sleepRecord({ id: sid(1002), daysAgo: 2, updatedAt: at(0, -1), rr: 19 })], { timezone: TZ });
    const h4 = await heavy(e.db, ALICE, { now: () => new Date(NOW.getTime() + 32 * 60_000), force: true });
    assert.equal(h4.result, ANALYTICS_RESULT.SUCCESS);
    assert.equal((await fresh(e.db)).heavy.status, ANALYTICS_FRESHNESS.CURRENT);
    // 已是最新 → already_current（不重算）
    const h5 = await heavy(e.db, ALICE, { now: () => new Date(NOW.getTime() + 33 * 60_000) });
    assert.equal(h5.result, ANALYTICS_RESULT.SKIPPED); assert.equal(h5.reason, 'already_current');
  } finally { e.done(); }
});

test('認領：同 (user, class) 只有一個持有者；不同 class 可並行；認領不是續租', async () => {
  const e = await env();
  try {
    await e.db.upsertSleeps(ALICE.id, [sleepRecord({ id: sid(1) })], { timezone: TZ });
    assert.ok(await e.db.claimAnalyticsWork({ userId: ALICE.id, cls: LIGHT, owner: 'A', leaseMs: 60_000, now: NOW }));
    assert.equal(await e.db.claimAnalyticsWork({ userId: ALICE.id, cls: LIGHT, owner: 'B', leaseMs: 60_000, now: NOW }), null);
    assert.equal(await e.db.claimAnalyticsWork({ userId: ALICE.id, cls: LIGHT, owner: 'A', leaseMs: 60_000, now: NOW }), null, '不是續租');
    assert.ok(await e.db.claimAnalyticsWork({ userId: ALICE.id, cls: HEAVY, owner: 'B', leaseMs: 60_000, now: NOW }), '不同 class 各自的租約');
    const r = await light(e.db, ALICE, { owner: 'C' });
    assert.equal(r.result, ANALYTICS_RESULT.SKIPPED); assert.equal(r.reason, 'claim_busy');
    assert.ok(await e.db.claimAnalyticsWork({ userId: ALICE.id, cls: LIGHT, owner: 'B', leaseMs: 60_000, now: new Date(NOW.getTime() + 60_001) }), '過期可接手');
    await assert.rejects(e.db.claimAnalyticsWork({ userId: ALICE.id, cls: 'bogus', owner: 'A', leaseMs: 1, now: NOW }), /invalid_analytics_class/);
  } finally { e.done(); }
});

test('遷移 v11 → v13：純新增四張表（+ v13 三欄），零重建、既有資料一列不動；冪等；全新 DB；中斷後補齊', async () => {
  const e = await env();
  try {
    await e.db.upsertSleeps(ALICE.id, [sleepRecord({ id: sid(1) })], { timezone: TZ });
    await webhookDelete(e.db, ALICE, 'sleep', sid(1));
    const NEW = ['analytics_invalidation', 'analytics_work_state', 'analytics_daily_state', 'analytics_runs'];
    const tables = async () => (await e.db.raw.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")).rows.map((r) => String(r.name));
    // 退回 v11 形狀
    for (const t of [...NEW, 'user_onboarding']) await e.db.raw.execute(`DROP TABLE IF EXISTS ${t}`);
    await e.db.raw.execute('DELETE FROM schema_version WHERE version >= 12');
    await e.db.raw.execute("INSERT OR IGNORE INTO schema_version (version, applied_at, note) VALUES (11, '2026-09-10T00:00:00.000Z', 'v11')");
    for (const t of NEW) assert.ok(!(await tables()).includes(t));
    const s = await runMigrations(e.db.raw);
    assert.equal(s.from, 11); assert.equal(s.to, SCHEMA_VERSION); assert.equal(SCHEMA_VERSION, 14);
    assert.deepEqual(s.rebuilt, []); assert.deepEqual(s.columnsAdded, [], '從 v11 起跳：新表由 CREATE TABLE 直接建齊（含 v13 欄位）');
    for (const t of NEW) assert.ok((await tables()).includes(t));
    assert.equal((await e.db.getTombstone(ALICE.id, 'sleep', sid(1))).state, TOMBSTONE_STATE.ACTIVE, '墓碑原封不動');
    assert.equal((await e.db.raw.execute('SELECT COUNT(*) n FROM whoop_reconciliation_state')).rows[0].n, 0);
    for (let i = 0; i < 3; i += 1) { const s2 = await runMigrations(e.db.raw); assert.deepEqual(s2.rebuilt, []); assert.deepEqual(s2.columnsAdded, []); }
    // 中斷：只建了第一張表
    for (const t of NEW) await e.db.raw.execute(`DROP TABLE ${t}`);
    await e.db.raw.execute('DELETE FROM schema_version WHERE version >= 12');
    await e.db.raw.execute(ANALYTICS_WORK_SCHEMA[0]);
    const s3 = await runMigrations(e.db.raw);
    assert.deepEqual(s3.rebuilt, []);
    for (const t of NEW) assert.ok((await tables()).includes(t));
    // 升級後失效機制可用
    await e.db.upsertSleeps(ALICE.id, [sleepRecord({ id: sid(2), daysAgo: 3, updatedAt: at(3) })], { timezone: TZ });
    assert.equal(await gen(e.db), 1);
    const reshaped = RESHAPED_TABLES.map((r) => r.table);
    for (const t of NEW) assert.ok(!reshaped.includes(t));
    assert.ok(ANALYTICS_WORK_SCHEMA.every((x) => /IF NOT EXISTS/.test(x)));
  } finally { e.done(); }
});

test('回歸守衛：正式排程器沒有接線 Phase 3 工作者；webhook 入站路由沒有分析', () => {
  const root = new URL('../src/', import.meta.url);
  for (const f of ['index.js', 'sync.js', 'whoopWebhookIngest.js', 'bot/index.js', 'bot/webhook.js']) {
    const u = new URL(f, root);
    if (!fs.existsSync(u)) continue;
    const src = fs.readFileSync(u, 'utf8');
    assert.ok(!/analyticsWorker|processPendingAnalytics|runHeavyAnalytics|runLightweightAnalysis/.test(src), `${f} 不該接線 Phase 3 工作者`);
  }
});
