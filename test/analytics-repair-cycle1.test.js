/**
 * V1.2 Phase 3 — 修復週期 1（P3-AUDIT-F01 / F02 / F03）。
 *
 *   F01 耐久輸出的寫入本身要有所有權圍欄（owner / 有效租約 / claimed_generation，
 *       在寫入的同一個交易裡證明）：失去租約的工作者一筆都寫不進去。
 *   F02 recovery 的 health_date 關聯改變（relink）是語義變化：新舊日期都失效，同交易。
 *   F03 輕量長範圍分成有界的片段，剩餘範圍耐久；只有整個範圍做完才算 CURRENT。
 *
 * 真實 libSQL；F01 的接手用另一條執行緒、另一個連線（真的第二個寫入者）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';

import { createDb } from '../src/db.js';
import { createReconciler } from '../src/reconcile.js';
import {
  processAnalyticsForUser, processPendingAnalytics, runLightweightAnalysis, runHeavyAnalytics,
  fencedAnalyticsDb, nextLightChunk, unionRange,
} from '../src/analyticsWorker.js';
import { runMigrations } from '../src/migrations.js';
import {
  ANALYTICS_CLASS, ANALYTICS_RESULT, ANALYTICS_FRESHNESS, TOMBSTONE_STATE, SCHEMA_VERSION, ADDITIVE_COLUMNS,
} from '../src/schema.js';
import { ANALYTICS_WORK } from '../src/config.js';
import { addDays } from '../src/time.js';

const TZ = 'Asia/Taipei';
const ALICE = { id: 'u-alice', whoop: '1001' };
const BOB = { id: 'u-bob', whoop: '2002' };
const NOW = new Date('2026-09-15T12:00:00.000Z');
const DAY = 86_400_000;
const HOUR = 3_600_000;
const { LIGHT, HEAVY } = ANALYTICS_CLASS;
const WORKER = new URL('./p3-takeover-worker.js', import.meta.url);
const LEASE = ANALYTICS_WORK.LEASE_MS;

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whoop-p3rc1-'));
  return { dir, url: `file:${path.join(dir, 't.db')}`, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
async function env(users = [ALICE]) {
  const t = tempDir();
  const db = createDb({ url: t.url });
  await db.migrate();
  for (const u of users) {
    await db.createUser({ id: u.id, displayName: u.id, timezone: TZ });
    await db.saveTokens(u.id, { accessToken: `a-${u.id}`, refreshToken: `r-${u.id}`, expiresAt: new Date(Date.now() + HOUR), scope: 'offline', whoopUserId: u.whoop });
  }
  return { db, url: t.url, done: () => { try { db.close(); } catch { /* ignore */ } t.cleanup(); } };
}

const sid = (n) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`;
const at = (d, h = 0) => new Date(NOW.getTime() - d * DAY + h * HOUR).toISOString();
/** (daysAgo+1) 天前 22:00Z 開始的 8 小時睡眠 → health_date = daysAgo 天前（Asia/Taipei） */
const sleepRecord = ({ id = sid(1), updatedAt = at(2), rr = 15, daysAgo = 2, startHourZ = 22 } = {}) => {
  const start = at(daysAgo + 1, startHourZ - 12);
  return {
    id, nap: false, score_state: 'SCORED', user_id: 1,
    start, end: new Date(Date.parse(start) + 8 * HOUR).toISOString(),
    created_at: updatedAt, updated_at: updatedAt,
    score: { respiratory_rate: rr, sleep_performance_percentage: 80, stage_summary: { total_light_sleep_time_milli: 3_600_000, total_slow_wave_sleep_time_milli: 3_600_000, total_rem_sleep_time_milli: 3_600_000 } },
  };
};
const recoveryRecord = ({ sleepId = sid(1), updatedAt = at(2), score = 70 } = {}) => ({
  sleep_id: sleepId, cycle_id: 'c-1', user_id: 1, score_state: 'SCORED',
  created_at: updatedAt, updated_at: updatedAt, score: { recovery_score: score, hrv_rmssd_milli: 60, resting_heart_rate: 55 },
});

const inv = (db, u = ALICE) => db.getAnalyticsInvalidation(u.id);
const gen = async (db, u = ALICE) => (await inv(db, u))?.generation ?? 0;
const fresh = (db, u = ALICE) => db.getAnalyticsFreshness(u.id);
const work = (db, u, cls) => db.getAnalyticsWorkState(u.id, cls);
const rowCount = async (db, table, uid) => Number((await db.raw.execute({ sql: `SELECT COUNT(*) n FROM ${table} WHERE user_id = ?`, args: [uid] })).rows[0].n);
const recoveryDate = async (db, uid, sleepId) => (await db.raw.execute({ sql: 'SELECT health_date FROM whoop_recoveries WHERE user_id = ? AND sleep_id = ?', args: [uid, sleepId] })).rows[0]?.health_date ?? null;

async function seedHistory(db, user, days, { startDaysAgo = 1 } = {}) {
  for (let i = startDaysAgo; i < startDaysAgo + days; i += 1) {
    await db.upsertSleeps(user.id, [sleepRecord({ id: sid(1000 + i), daysAgo: i, updatedAt: at(i), rr: 14 + (i % 3) })], { timezone: TZ });
    await db.upsertRecoveries(user.id, [recoveryRecord({ sleepId: sid(1000 + i), updatedAt: at(i), score: 50 + (i % 40) })]);
  }
}
const light = (db, u = ALICE, opts = {}) => processAnalyticsForUser({ db, userId: u.id, cls: LIGHT, owner: opts.owner ?? 'L', now: opts.now ?? (() => NOW), ...opts });
const heavy = (db, u = ALICE, opts = {}) => processAnalyticsForUser({ db, userId: u.id, cls: HEAVY, owner: opts.owner ?? 'H', now: opts.now ?? (() => NOW), ...opts });

/** 在另一條執行緒讓 B 接手並寫真正的輸出。 */
function takeover({ url, userId, cls, owner = 'B', nowMs, action, payload, leaseMs = 600_000 }) {
  const worker = new Worker(WORKER);
  const done = new Promise((resolve, reject) => {
    worker.on('message', (m) => { if (m.type === 'done') resolve(m); });
    worker.on('error', reject);
  });
  worker.postMessage({ type: 'takeover', url, userId, cls, owner, leaseMs, nowMs, action, payload });
  return done.finally(() => worker.terminate());
}

const dailyRows = (rr, dates) => dates.map((d) => ({ health_date: d, daily_status: 'READY', metrics: { health_date: d, respiratory_rate: rr } }));
const modelFor = (tag) => ({
  targetMetric: 'recovery', modelVersion: `v-${tag}`, features: ['hrv'], trainStart: '2026-01-01', trainEnd: '2026-06-01',
  testStart: '2026-06-02', testEnd: '2026-07-01', nTrain: 100, nTest: 20, mae: 1, rmse: 1, r2: 0.1,
  intervalCoverage: 0.9, baselineKind: 'mean', baselineMae: 2, beatsBaseline: true, maturity: 'LIMITED', qualified: false,
  unqualifiedReason: null, policyVersion: 'p1',
});
const snapshotFor = (tag) => ({ snapshotDate: '2026-09-14', algorithmVersion: `a-${tag}`, score: null, scoreKind: null, contributors: [], coverage: 0.5, status: 'WARMING_UP' });

// ===========================================================================
// P3-AUDIT-F01 — 輸出寫入的所有權圍欄
// ===========================================================================

test('F01-A / ATTACK 1（真併發）：A 認領 LIGHT、算完、租約過期、B 在另一條執行緒接手並寫入、A 恢復 → A 寫入 0 列', async () => {
  const e = await env();
  try {
    await seedHistory(e.db, ALICE, 3);
    const claimA = await e.db.claimAnalyticsWork({ userId: ALICE.id, cls: LIGHT, owner: 'A', leaseMs: LEASE.light, now: NOW });
    const g = claimA.generation;
    const dates = ['2026-09-12', '2026-09-13', '2026-09-14'];
    // A 已經算完（rows 在記憶體），還沒持久化；租約過期；B 接手
    const later = NOW.getTime() + LEASE.light + 1;
    const b = await takeover({ url: e.url, userId: ALICE.id, cls: LIGHT, nowMs: later, action: 'light', payload: { rows: dailyRows(222, dates) } });
    assert.equal(b.ok, true, b.error); assert.equal(b.generation, g, 'B 認領的是同一代');
    // A 恢復：透過真正的路徑寫（同一代、不同 owner、租約已過期）
    await assert.rejects(
      e.db.saveAnalyticsDailyState(ALICE.id, dailyRows(111, dates), { owner: 'A', generation: g, now: new Date(later + 1), clock: () => new Date(later + 1) }),
      /analytics_ownership_lost/,
    );
    const rows = await e.db.getAnalyticsDailyState(ALICE.id);
    assert.equal(rows.length, 3);
    assert.ok(rows.every((r) => r.metrics.respiratory_rate === 222), '★★★ 資料庫裡只有 B 的輸出，A 的 0 列');
    // 也透過工作者路徑（runLightweightAnalysis）試一次
    await assert.rejects(runLightweightAnalysis({
      db: e.db, userId: ALICE.id, timezone: TZ, generation: g, owner: 'A', range: { from: '2026-09-12', to: '2026-09-14' },
      now: new Date(later + 1), clock: () => new Date(later + 1),
    }), /analytics_ownership_lost/);
    assert.ok((await e.db.getAnalyticsDailyState(ALICE.id)).every((r) => r.metrics.respiratory_rate === 222));
    const f = await fresh(e.db);
    assert.equal(f.light.doneGeneration, g); assert.equal(f.light.status, ANALYTICS_FRESHNESS.CURRENT); assert.equal(f.light.owner, null);
  } finally { e.done(); }
});

test('F01-B / ATTACK 2（真併發）：HEAVY 預測輸出 —— B 接手寫入新模型，過期的 A 寫入 0 列', async () => {
  const e = await env();
  try {
    await seedHistory(e.db, ALICE, 3);
    const claimA = await e.db.claimAnalyticsWork({ userId: ALICE.id, cls: HEAVY, owner: 'A', leaseMs: LEASE.heavy, now: NOW });
    const g = claimA.generation;
    const later = NOW.getTime() + LEASE.heavy + 1;
    const b = await takeover({ url: e.url, userId: ALICE.id, cls: HEAVY, nowMs: later, action: 'prediction', payload: { model: modelFor('B') } });
    assert.equal(b.ok, true, b.error);
    // A 恢復：透過圍欄視圖寫模型 / 預測 / 實際值
    const { db: fenced, fence } = fencedAnalyticsDb(e.db, { userId: ALICE.id, cls: HEAVY, owner: 'A', generation: g, now: () => new Date(later + 1) });
    await assert.rejects(fenced.savePredictionModel(ALICE.id, modelFor('A'), { now: new Date(later + 1) }), /analytics_ownership_lost/);
    await assert.rejects(fenced.savePrediction(ALICE.id, { targetDate: '2026-09-16', targetMetric: 'recovery', modelVersion: 'v-A', status: 'CANDIDATE', features: {}, predictedValue: 50, nTrain: 1 }, { now: new Date(later + 1) }), /analytics_ownership_lost/);
    await assert.rejects(fenced.recordPredictionActual({ userId: ALICE.id, targetDate: '2026-09-16', targetMetric: 'recovery', modelVersion: 'v-A', actualValue: 1 }, { now: new Date(later + 1) }), /analytics_ownership_lost/);
    assert.equal(fence.lost, true); assert.equal(fence.blockedWrites, 3);
    const models = (await e.db.raw.execute({ sql: 'SELECT model_version FROM prediction_models WHERE user_id = ?', args: [ALICE.id] })).rows.map((r) => r.model_version);
    assert.deepEqual(models, ['v-B'], '★★★ 只有 B 的模型');
    assert.equal(await rowCount(e.db, 'prediction_runs', ALICE.id), 0);
    // 整條工作者路徑：A 帶著過期租約跑 runHeavyAnalytics → 模組內的寫入被擋 → FENCED
    const r = await runHeavyAnalytics({ db: e.db, userId: ALICE.id, timezone: TZ, now: new Date(later + 1), fence: { owner: 'A', generation: g, now: () => new Date(later + 1) } }).catch((err) => err);
    assert.equal(r?.message, 'analytics_ownership_lost');
    assert.deepEqual((await e.db.raw.execute({ sql: 'SELECT model_version FROM prediction_models WHERE user_id = ?', args: [ALICE.id] })).rows.map((x) => x.model_version), ['v-B']);
    assert.equal(await rowCount(e.db, 'healthspan_snapshots', ALICE.id), 0);
  } finally { e.done(); }
});

test('F01-C / ATTACK 3（真併發）：HEAVY Healthspan 輸出 —— B 接手寫快照，過期的 A 寫入 0 列', async () => {
  const e = await env();
  try {
    await seedHistory(e.db, ALICE, 3);
    const claimA = await e.db.claimAnalyticsWork({ userId: ALICE.id, cls: HEAVY, owner: 'A', leaseMs: LEASE.heavy, now: NOW });
    const later = NOW.getTime() + LEASE.heavy + 1;
    const b = await takeover({ url: e.url, userId: ALICE.id, cls: HEAVY, nowMs: later, action: 'healthspan', payload: { snapshot: snapshotFor('B') } });
    assert.equal(b.ok, true, b.error);
    const { db: fenced } = fencedAnalyticsDb(e.db, { userId: ALICE.id, cls: HEAVY, owner: 'A', generation: claimA.generation, now: () => new Date(later + 1) });
    await assert.rejects(fenced.saveHealthspanSnapshot(ALICE.id, snapshotFor('A'), { now: new Date(later + 1) }), /analytics_ownership_lost/);
    await assert.rejects(fenced.saveHealthspanMetrics(ALICE.id, [{ metricKey: 'x', value: 1 }], { now: new Date(later + 1) }), /analytics_ownership_lost/);
    const snaps = (await e.db.raw.execute({ sql: 'SELECT algorithm_version FROM healthspan_snapshots WHERE user_id = ?', args: [ALICE.id] })).rows.map((r) => r.algorithm_version);
    assert.deepEqual(snaps, ['a-B'], '★★★ 只有 B 的快照');
    assert.equal(await rowCount(e.db, 'healthspan_metrics', ALICE.id), 0);
  } finally { e.done(); }
});

test('F01-D 租約過期、沒有人接手 → A 的輸出寫入仍然是 0（LIGHT 與 HEAVY）', async () => {
  const e = await env();
  try {
    await seedHistory(e.db, ALICE, 2);
    const cl = await e.db.claimAnalyticsWork({ userId: ALICE.id, cls: LIGHT, owner: 'A', leaseMs: LEASE.light, now: NOW });
    const ch = await e.db.claimAnalyticsWork({ userId: ALICE.id, cls: HEAVY, owner: 'A', leaseMs: LEASE.heavy, now: NOW });
    const expiredL = new Date(NOW.getTime() + LEASE.light + 1);
    const expiredH = new Date(NOW.getTime() + LEASE.heavy + 1);
    await assert.rejects(e.db.saveAnalyticsDailyState(ALICE.id, dailyRows(1, ['2026-09-14']), { owner: 'A', generation: cl.generation, now: expiredL, clock: () => expiredL }), /analytics_ownership_lost/);
    const { db: fenced } = fencedAnalyticsDb(e.db, { userId: ALICE.id, cls: HEAVY, owner: 'A', generation: ch.generation, now: () => expiredH });
    await assert.rejects(fenced.savePredictionModel(ALICE.id, modelFor('A'), { now: expiredH }), /analytics_ownership_lost/);
    await assert.rejects(fenced.saveHealthspanSnapshot(ALICE.id, snapshotFor('A'), { now: expiredH }), /analytics_ownership_lost/);
    assert.equal(await rowCount(e.db, 'analytics_daily_state', ALICE.id), 0);
    assert.equal(await rowCount(e.db, 'prediction_models', ALICE.id), 0);
    assert.equal(await rowCount(e.db, 'healthspan_snapshots', ALICE.id), 0);
    // 過期之後的工作者路徑是一次**新的**認領（新租約），合法完成；之前的 0 寫入不變
    const r = await light(e.db, ALICE, { owner: 'A', now: () => expiredL });
    assert.equal(r.result, ANALYTICS_RESULT.SUCCESS);
    assert.equal((await fresh(e.db)).light.consecutiveFailures, 0);
  } finally { e.done(); }
});

test('F01-E 租約邊界：lease_expires_at == now 算過期 → 0 寫入；now − 1ms 仍有效', async () => {
  const e = await env();
  try {
    await seedHistory(e.db, ALICE, 1);
    const c = await e.db.claimAnalyticsWork({ userId: ALICE.id, cls: LIGHT, owner: 'A', leaseMs: 60_000, now: NOW });
    const boundary = new Date(NOW.getTime() + 60_000);
    await assert.rejects(e.db.saveAnalyticsDailyState(ALICE.id, dailyRows(1, ['2026-09-14']), { owner: 'A', generation: c.generation, now: boundary, clock: () => boundary }), /analytics_ownership_lost/);
    assert.equal(await rowCount(e.db, 'analytics_daily_state', ALICE.id), 0);
    const justBefore = new Date(boundary.getTime() - 1);
    const n = await e.db.saveAnalyticsDailyState(ALICE.id, dailyRows(1, ['2026-09-14']), { owner: 'A', generation: c.generation, now: justBefore, clock: () => justBefore });
    assert.equal(n, 1);
    // 錯的 generation 也進不來（同 owner、租約有效）
    await assert.rejects(e.db.saveAnalyticsDailyState(ALICE.id, dailyRows(2, ['2026-09-14']), { owner: 'A', generation: c.generation + 1, now: NOW, clock: () => NOW }), /analytics_ownership_lost/);
    assert.equal((await e.db.getAnalyticsDailyState(ALICE.id))[0].metrics.respiratory_rate, 1);
  } finally { e.done(); }
});

test('F01-F A 在租約有效時寫入、結案前才過期 → 輸出保留（合法）、結案 FENCED、工作仍待處理可安全重試', async () => {
  const e = await env();
  try {
    await seedHistory(e.db, ALICE, 3);
    let t = NOW.getTime();
    const now = () => new Date(t);
    // 用 db hook 讓「寫完之後、結案之前」時間跳過租約
    const hooked = { ...e.db, holdsAnalyticsWork: async (a) => { t += LEASE.light + 1; return e.db.holdsAnalyticsWork({ ...a, now: now() }); } };
    const r = await processAnalyticsForUser({ db: hooked, userId: ALICE.id, cls: LIGHT, owner: 'A', now });
    assert.equal(r.result, ANALYTICS_RESULT.FENCED);
    const rows = await e.db.getAnalyticsDailyState(ALICE.id);
    assert.ok(rows.length >= 3, '租約有效時寫入的輸出保留（它是合法的）');
    assert.ok(rows.every((x) => x.stale), '但讀取端看得出它還不是「最新」（done 沒前進）');
    const f = await fresh(e.db);
    assert.equal(f.light.doneGeneration, 0); assert.equal(f.light.status, ANALYTICS_FRESHNESS.PENDING);
    assert.equal(f.light.consecutiveFailures, 0, 'FENCED 不算失敗');
    // 重試（新 owner）安全完成
    const r2 = await light(e.db, ALICE, { owner: 'A2', now: () => new Date(t + 1) });
    assert.equal(r2.result, ANALYTICS_RESULT.SUCCESS);
    assert.equal((await fresh(e.db)).light.status, ANALYTICS_FRESHNESS.CURRENT);
    assert.ok((await e.db.getAnalyticsDailyState(ALICE.id)).every((x) => !x.stale));
  } finally { e.done(); }
});

test('F01 圍欄在交易層：mutateForAnalytics 的 before / after 都驗，fn 拋錯整段回滾', async () => {
  const e = await env();
  try {
    await seedHistory(e.db, ALICE, 1);
    const c = await e.db.claimAnalyticsWork({ userId: ALICE.id, cls: HEAVY, owner: 'A', leaseMs: 60_000, now: NOW });
    let ran = false;
    await assert.rejects(e.db.mutateForAnalytics({ userId: ALICE.id, cls: HEAVY, owner: 'nobody', generation: c.generation, now: () => NOW }, async () => { ran = true; }), /analytics_ownership_lost/);
    assert.equal(ran, false, 'before 檢查擋下 → fn 不執行');
    await assert.rejects(e.db.mutateForAnalytics({ userId: ALICE.id, cls: HEAVY, owner: 'A', generation: c.generation, now: () => NOW }, async () => {
      await e.db.savePredictionModel(ALICE.id, modelFor('A'), { now: NOW });
      throw new Error('boom');
    }), /boom/);
    assert.equal(await rowCount(e.db, 'prediction_models', ALICE.id), 0, '回滾');
    await assert.rejects(e.db.mutateForAnalytics({ userId: ALICE.id, cls: 'bogus', owner: 'A', generation: 1 }, async () => {}), /invalid_analytics_class/);
    await assert.rejects(e.db.mutateForAnalytics({ userId: ALICE.id, cls: HEAVY, owner: 'A', generation: 'x' }, async () => {}), /generation_required/);
  } finally { e.done(); }
});

// ===========================================================================
// P3-AUDIT-F02 — recovery health_date relink
// ===========================================================================

test('F02-A NULL → D：recovery 先到、sleep 後到 → relink 讓日期從 NULL 變 D，失效範圍含 D', async () => {
  const e = await env();
  try {
    await e.db.upsertRecoveries(ALICE.id, [recoveryRecord({ sleepId: sid(1), updatedAt: at(2) })]);
    assert.equal(await recoveryDate(e.db, ALICE.id, sid(1)), null);
    const g1 = await gen(e.db);
    await e.db.upsertSleeps(ALICE.id, [sleepRecord({ id: sid(1), daysAgo: 2 })], { timezone: TZ });   // sleep 本身 +1
    const g2 = await gen(e.db);
    assert.equal(g2, g1 + 1);
    // 同版本 recovery 重放 → 觸發 relink → NULL → D → 失效（F02-D 的核心）
    await e.db.upsertRecoveries(ALICE.id, [recoveryRecord({ sleepId: sid(1), updatedAt: at(2) })]);
    const D = await recoveryDate(e.db, ALICE.id, sid(1));
    assert.ok(D);
    const i = await inv(e.db);
    assert.equal(i.generation, g2 + 1, '★ 同版本重放但日期關聯改變 → generation +1');
    assert.ok(i.affectedFrom <= D && i.affectedTo >= D, `範圍含 ${D}`);
    // 再重放一次（D → D）→ 不失效
    await e.db.upsertRecoveries(ALICE.id, [recoveryRecord({ sleepId: sid(1), updatedAt: at(2) })]);
    assert.equal(await gen(e.db), g2 + 1, 'F02-C：D → D 不失效');
  } finally { e.done(); }
});

test('F02-B / ATTACK 4 D1 → D2：sleep 換了 health_date → recovery relink → 範圍同時涵蓋 D1 與 D2', async () => {
  const e = await env();
  try {
    await e.db.upsertSleeps(ALICE.id, [sleepRecord({ id: sid(1), daysAgo: 5, updatedAt: at(5) })], { timezone: TZ });
    await e.db.upsertRecoveries(ALICE.id, [recoveryRecord({ sleepId: sid(1), updatedAt: at(5) })]);
    const D1 = await recoveryDate(e.db, ALICE.id, sid(1));
    await light(e.db); await heavy(e.db);
    const g = await gen(e.db);
    // sleep 被重新評分：end 移到隔天中午之後 → health_date 變成 D2（sleep 本身 +1）
    await e.db.upsertSleeps(ALICE.id, [sleepRecord({ id: sid(1), daysAgo: 4, updatedAt: at(0, -1), startHourZ: 22 })], { timezone: TZ });
    assert.equal(await recoveryDate(e.db, ALICE.id, sid(1)), D1, 'sleep 更新本身不會 relink（既有行為）');
    // 公開的 relink 路徑
    await e.db.relinkRecoveryDates(ALICE.id);
    const D2 = await recoveryDate(e.db, ALICE.id, sid(1));
    assert.notEqual(D2, D1);
    const i = await inv(e.db);
    assert.equal(i.generation, g + 2, 'sleep +1、relink +1');
    assert.ok(i.affectedFrom <= D1 && i.affectedTo >= D2, `★ 範圍 ${i.affectedFrom}→${i.affectedTo} 涵蓋 ${D1} 與 ${D2}`);
    assert.ok(i.reasons.includes('relink'));
    assert.equal((await fresh(e.db)).light.status, ANALYTICS_FRESHNESS.PENDING);
    // 再 relink（沒有變化）→ 不失效
    await e.db.relinkRecoveryDates(ALICE.id);
    assert.equal(await gen(e.db), g + 2);
  } finally { e.done(); }
});

test('F02-D / ATTACK 5 同版本 recovery 重放透過 upsertRecoveries 內部的 relink 改了日期 → 失效（且只 +1，不重複）', async () => {
  const e = await env();
  try {
    await e.db.upsertSleeps(ALICE.id, [sleepRecord({ id: sid(1), daysAgo: 5, updatedAt: at(5) })], { timezone: TZ });
    await e.db.upsertRecoveries(ALICE.id, [recoveryRecord({ sleepId: sid(1), updatedAt: at(5) })]);
    const D1 = await recoveryDate(e.db, ALICE.id, sid(1));
    await e.db.upsertSleeps(ALICE.id, [sleepRecord({ id: sid(1), daysAgo: 4, updatedAt: at(0, -1) })], { timezone: TZ });
    const g = await gen(e.db);
    const n = await e.db.upsertRecoveries(ALICE.id, [recoveryRecord({ sleepId: sid(1), updatedAt: at(5) })]);
    assert.equal(n, 1, '同版本 upsert 是冪等寫入（rowsAffected 1）');
    const D2 = await recoveryDate(e.db, ALICE.id, sid(1));
    assert.notEqual(D2, D1);
    const i = await inv(e.db);
    assert.equal(i.generation, g + 1, '★ 恰好 +1（同一交易裡的同一次語義變化）');
    assert.ok(i.affectedFrom <= D1 && i.affectedTo >= D2);
  } finally { e.done(); }
});

test('F02-E / ATTACK 12 relink 交易回滾 → 日期與失效都不留下', async () => {
  const e = await env();
  try {
    await e.db.upsertSleeps(ALICE.id, [sleepRecord({ id: sid(1), daysAgo: 5, updatedAt: at(5) })], { timezone: TZ });
    await e.db.upsertRecoveries(ALICE.id, [recoveryRecord({ sleepId: sid(1), updatedAt: at(5) })]);
    const D1 = await recoveryDate(e.db, ALICE.id, sid(1));
    await e.db.upsertSleeps(ALICE.id, [sleepRecord({ id: sid(1), daysAgo: 4, updatedAt: at(0, -1) })], { timezone: TZ });
    const g = await gen(e.db);
    await e.db.claimReconciliation({ userId: ALICE.id, resource: 'recovery', owner: 'X', leaseMs: 60_000, now: NOW });
    await assert.rejects(e.db.mutateForReconciliation({ userId: ALICE.id, resource: 'recovery', owner: 'X', now: () => NOW }, async () => {
      await e.db.relinkRecoveryDates(ALICE.id);
      assert.notEqual(await recoveryDate(e.db, ALICE.id, sid(1)), D1, '交易內已改');
      throw new Error('boom');
    }), /boom/);
    assert.equal(await recoveryDate(e.db, ALICE.id, sid(1)), D1, '★ 日期回滾');
    assert.equal(await gen(e.db), g, '★ 失效回滾');
  } finally { e.done(); }
});

test('F02-F Alice / Bob 同 sleep / recovery id：relink 只讓正確的使用者失效', async () => {
  const e = await env([ALICE, BOB]);
  try {
    for (const u of [ALICE, BOB]) {
      await e.db.upsertSleeps(u.id, [sleepRecord({ id: sid(1), daysAgo: 5, updatedAt: at(5) })], { timezone: TZ });
      await e.db.upsertRecoveries(u.id, [recoveryRecord({ sleepId: sid(1), updatedAt: at(5) })]);
    }
    const gb = await gen(e.db, BOB);
    await e.db.upsertSleeps(ALICE.id, [sleepRecord({ id: sid(1), daysAgo: 4, updatedAt: at(0, -1) })], { timezone: TZ });
    const ga = await gen(e.db, ALICE);
    await e.db.relinkRecoveryDates(ALICE.id);
    assert.equal(await gen(e.db, ALICE), ga + 1);
    assert.equal(await gen(e.db, BOB), gb, 'Bob 不受影響');
    await e.db.relinkRecoveryDates(BOB.id);
    assert.equal(await gen(e.db, BOB), gb, 'Bob 的 relink 沒有變化 → 不失效');
  } finally { e.done(); }
});

test('F02-G / ATTACK 11 深度對帳帶來 relink → 失效；快 / 深水位、墓碑、圍欄不變', async () => {
  const e = await env();
  try {
    await e.db.upsertSleeps(ALICE.id, [sleepRecord({ id: sid(1), daysAgo: 20, updatedAt: at(20) })], { timezone: TZ });
    await e.db.upsertRecoveries(ALICE.id, [recoveryRecord({ sleepId: sid(1), updatedAt: at(20) })]);
    const D1 = await recoveryDate(e.db, ALICE.id, sid(1));
    // 另一個已刪除的 recovery（ACTIVE 墓碑），遠端仍回它
    await e.db.upsertSleeps(ALICE.id, [sleepRecord({ id: sid(2), daysAgo: 21, updatedAt: at(21) })], { timezone: TZ });
    await e.db.upsertRecoveries(ALICE.id, [recoveryRecord({ sleepId: sid(2), updatedAt: at(21) })]);
    const rec = await e.db.recordWhoopEvent({ whoopUserId: ALICE.whoop, eventType: 'recovery.deleted', resourceType: 'recovery', resourceId: sid(2), traceId: 't' });
    const ev = await e.db.claimWhoopEvent({ owner: 'wh', leaseMs: 600_000 });
    await e.db.mutateForWhoopEvent(ev.id, { owner: 'wh' }, () => e.db.deleteWhoopResource({ userId: ALICE.id, resourceType: 'recovery', resourceId: sid(2), sourceEventId: ev.id }));
    await e.db.settleWhoopEvent(ev.id, { owner: 'wh', state: 'PROCESSED', userId: ALICE.id });
    await light(e.db); await heavy(e.db);
    const g = await gen(e.db);
    // 深度對帳：sleep 換了 health_date（較新版本），recovery 同版本重放 → relink
    const routes = {
      '/activity/sleep': { records: [sleepRecord({ id: sid(1), daysAgo: 19, updatedAt: at(0, -1) })], next_token: null },
      '/recovery': { records: [recoveryRecord({ sleepId: sid(1), updatedAt: at(20) }), recoveryRecord({ sleepId: sid(2), updatedAt: at(0, -1), score: 99 })], next_token: null },
    };
    const whoop = { apiGet: async (p) => routes[p] ?? { records: [], next_token: null }, bodyMeasurement: async () => ({}) };
    const rc = createReconciler({ db: e.db, whoop, userId: ALICE.id, timezone: TZ, now: () => NOW });
    const ds = await rc.reconcileDeep('sleep'); assert.equal(ds.result, 'SUCCESS'); assert.equal(ds.written, 1);
    const dr = await rc.reconcileDeep('recovery'); assert.equal(dr.result, 'SUCCESS'); assert.equal(dr.blocked, 1, '墓碑擋下 sid(2)');
    const D2 = await recoveryDate(e.db, ALICE.id, sid(1));
    assert.notEqual(D2, D1);
    const i = await inv(e.db);
    assert.equal(i.generation, g + 2, 'sleep 較新版本 +1、recovery relink +1');
    assert.ok(i.affectedFrom <= D1 && i.affectedTo >= D2);
    assert.equal((await e.db.getTombstone(ALICE.id, 'recovery', sid(2))).state, TOMBSTONE_STATE.ACTIVE, '墓碑不變');
    assert.equal(await rowCount(e.db, 'whoop_recoveries', ALICE.id), 1, '沒復活');
    assert.equal((await e.db.getReconciliationState(ALICE.id, 'sleep/deep')).windowWatermark, new Date(NOW.getTime() - 30 * DAY).toISOString(), '深度游標');
    assert.equal((await e.db.getReconciliationState(ALICE.id, 'recovery/deep')).owner, null, '租約釋放');
    assert.equal(await e.db.getReconciliationState(ALICE.id, 'sleep'), null, '快路徑水位不動');
    assert.equal((await fresh(e.db)).heavy.status, ANALYTICS_FRESHNESS.PENDING);
  } finally { e.done(); }
});

// ===========================================================================
// P3-AUDIT-F03 — 輕量長範圍的有界分片
// ===========================================================================

/** 130 天的歷史（health_date 從 130 天前到 1 天前） */
const seedLong = (db, u = ALICE) => seedHistory(db, u, 130);

test('F03-A / ATTACK 6 120+ 天範圍：45 + 45 + 40 三片；前兩片後 PENDING、最後一片才 CURRENT；所有日期都被刷新', async () => {
  const e = await env();
  try {
    await seedLong(e.db);
    const i = await inv(e.db);
    const i0 = await inv(e.db);
    assert.equal(i0.affectedFrom, addDays(NOW.toISOString().slice(0, 10), -130));
    const expectedFrom = addDays(i.affectedFrom, -1); const expectedTo = addDays(i.affectedTo, 1);   // ±1 天
    const progress = [];
    const r1 = await light(e.db);
    assert.equal(r1.result, ANALYTICS_RESULT.PARTIAL);
    let w = await work(e.db, ALICE, LIGHT);
    progress.push({ from: w.rangeFrom, to: w.rangeTo });
    assert.equal(w.rangeGeneration, i.generation);
    assert.equal(w.rangeTo, addDays(expectedTo, -45), '第一片（最新 45 天）做完 → 上緣往前縮');
    assert.equal(w.rangeFrom, expectedFrom);
    assert.equal(w.owner, null, '租約釋放');
    let f = await fresh(e.db);
    assert.equal(f.light.status, ANALYTICS_FRESHNESS.PENDING, '★ 一片之後仍是 PENDING');
    assert.deepEqual(f.light.remainingRange, { from: expectedFrom, to: addDays(expectedTo, -45) });
    assert.equal(f.light.doneGeneration, 0);
    assert.deepEqual((await e.db.listPendingAnalytics(LIGHT, { now: NOW })).map((p) => p.userId), [ALICE.id], '仍在待處理清單');
    const r2 = await light(e.db);
    assert.equal(r2.result, ANALYTICS_RESULT.PARTIAL);
    w = await work(e.db, ALICE, LIGHT); progress.push({ from: w.rangeFrom, to: w.rangeTo });
    assert.equal(w.rangeTo, addDays(expectedTo, -90));
    assert.equal((await fresh(e.db)).light.status, ANALYTICS_FRESHNESS.PENDING);
    const r3 = await light(e.db);
    assert.equal(r3.result, ANALYTICS_RESULT.SUCCESS, '最後一片（剩 42 天）');
    w = await work(e.db, ALICE, LIGHT); progress.push({ from: w.rangeFrom, to: w.rangeTo });
    assert.equal(w.rangeFrom, null); assert.equal(w.rangeTo, null);
    f = await fresh(e.db);
    assert.equal(f.light.status, ANALYTICS_FRESHNESS.CURRENT, '★ 整個範圍做完才 CURRENT');
    assert.equal(f.light.doneGeneration, i.generation);
    assert.equal((await inv(e.db)).affectedFrom, null, '失效範圍清掉');
    const rows = await e.db.getAnalyticsDailyState(ALICE.id);
    assert.equal(rows.length, 130, `所有有資料的日期（130 天）都物化：${rows.length}`);
    assert.ok(rows.every((r) => r.generation === i.generation && !r.stale));
    const runs = await e.db.recentAnalyticsRuns(ALICE.id, { cls: LIGHT });
    assert.deepEqual(runs.map((r) => r.result), ['SUCCESS', 'PARTIAL', 'PARTIAL']);
    // 三片：45 + 45 + 42 個日期（±1 天的兩端沒有睡眠 → 沒有列）→ 44 + 45 + 41 列
    assert.deepEqual(runs.reverse().map((r) => [r.detail.from, r.detail.to, r.detail.days]), [
      [addDays(expectedTo, -44), expectedTo, 44],
      [addDays(expectedTo, -89), addDays(expectedTo, -45), 45],
      [expectedFrom, addDays(expectedTo, -90), 41],
    ]);
    console.log('  progress after each chunk:', JSON.stringify(progress));
  } finally { e.done(); }
});

test('F03-B / ATTACK 8 第一片 commit 之後「崩潰」（丟掉 process 內狀態）→ 重開接續剩餘範圍', async () => {
  const e = await env();
  try {
    await seedLong(e.db);
    const r1 = await light(e.db, ALICE, { owner: 'proc-1' });
    assert.equal(r1.result, ANALYTICS_RESULT.PARTIAL);
    e.db.close();
    const db2 = createDb({ url: e.url });
    const w = await db2.getAnalyticsWorkState(ALICE.id, LIGHT);
    assert.ok(w.rangeFrom && w.rangeTo, '剩餘範圍耐久');
    const r2 = await processAnalyticsForUser({ db: db2, userId: ALICE.id, cls: LIGHT, owner: 'proc-2', now: () => NOW });
    assert.equal(r2.result, ANALYTICS_RESULT.PARTIAL);
    assert.equal(r2.summary.to, w.rangeTo, '★ 從剩餘範圍的上緣接續');
    const r3 = await processAnalyticsForUser({ db: db2, userId: ALICE.id, cls: LIGHT, owner: 'proc-2', now: () => NOW });
    assert.equal(r3.result, ANALYTICS_RESULT.SUCCESS);
    assert.equal((await db2.getAnalyticsFreshness(ALICE.id)).light.status, ANALYTICS_FRESHNESS.CURRENT);
    db2.close();
  } finally { e.done(); }
});

test('F03-C 第二片失敗 → 第一片保留、剩餘範圍不動、退避後重試接續', async () => {
  const e = await env();
  try {
    await seedLong(e.db);
    const r1 = await light(e.db);
    assert.equal(r1.result, ANALYTICS_RESULT.PARTIAL);
    const before = await work(e.db, ALICE, LIGHT);
    const rowsBefore = await rowCount(e.db, 'analytics_daily_state', ALICE.id);
    const broken = { ...e.db, getWorkouts: async () => { throw new Error('down'); } };
    const r2 = await processAnalyticsForUser({ db: broken, userId: ALICE.id, cls: LIGHT, owner: 'L', now: () => NOW });
    assert.equal(r2.result, ANALYTICS_RESULT.FAILED);
    const after = await work(e.db, ALICE, LIGHT);
    assert.equal(after.rangeFrom, before.rangeFrom); assert.equal(after.rangeTo, before.rangeTo, '★ 剩餘範圍保留');
    assert.equal(await rowCount(e.db, 'analytics_daily_state', ALICE.id), rowsBefore, '第一片保留、沒有半片');
    assert.equal((await fresh(e.db)).light.status, ANALYTICS_FRESHNESS.FAILED);
    const later = new Date(Date.parse(after.nextAttemptAt) + 1);
    const r3 = await light(e.db, ALICE, { now: () => later });
    assert.equal(r3.result, ANALYTICS_RESULT.PARTIAL); assert.equal(r3.summary.to, before.rangeTo);
    const r4 = await light(e.db, ALICE, { now: () => later });
    assert.equal(r4.result, ANALYTICS_RESULT.SUCCESS);
    assert.equal((await fresh(e.db)).light.status, ANALYTICS_FRESHNESS.CURRENT);
  } finally { e.done(); }
});

test('F03-D / ATTACK 9 算完一片之後、持久化之前租約過期 → F01 擋下寫入、游標不前進、剩餘範圍完整', async () => {
  const e = await env();
  try {
    await seedLong(e.db);
    const r1 = await light(e.db);
    const before = await work(e.db, ALICE, LIGHT);
    const rowsBefore = await rowCount(e.db, 'analytics_daily_state', ALICE.id);
    let t = NOW.getTime();
    const now = () => new Date(t);
    // coverage 之後（算之前 / 持久化之前）讓時間跳過租約
    const hooked = { ...e.db, coverage: async (u) => { const c = await e.db.coverage(u); t += LEASE.light + 1; return c; } };
    const r2 = await processAnalyticsForUser({ db: hooked, userId: ALICE.id, cls: LIGHT, owner: 'A', now });
    assert.equal(r2.result, ANALYTICS_RESULT.FENCED);
    assert.equal(await rowCount(e.db, 'analytics_daily_state', ALICE.id), rowsBefore, '★ 0 寫入');
    const after = await work(e.db, ALICE, LIGHT);
    assert.equal(after.rangeTo, before.rangeTo, '★ 游標不前進'); assert.equal(after.rangeFrom, before.rangeFrom);
    assert.equal(r1.result, ANALYTICS_RESULT.PARTIAL);
    // 新工作者接續
    const r3 = await light(e.db, ALICE, { owner: 'B', now: () => new Date(t + 1) });
    assert.equal(r3.result, ANALYTICS_RESULT.PARTIAL); assert.equal(r3.summary.to, before.rangeTo);
  } finally { e.done(); }
});

test('F03-E / ATTACK 7 第一片之後 N+1 到來（新 + 舊日期）→ 沒有任何受影響日期遺失', async () => {
  const e = await env();
  try {
    await seedLong(e.db);
    const r1 = await light(e.db);
    assert.equal(r1.result, ANALYTICS_RESULT.PARTIAL);
    const w1 = await work(e.db, ALICE, LIGHT);
    // N+1：一筆落在已完成的第一片裡（3 天前）改了值；另一筆在 100 天前
    await e.db.upsertSleeps(ALICE.id, [sleepRecord({ id: sid(1003), daysAgo: 3, updatedAt: at(0, -1), rr: 99 })], { timezone: TZ });
    await e.db.upsertSleeps(ALICE.id, [sleepRecord({ id: sid(1100), daysAgo: 100, updatedAt: at(0, -1), rr: 98 })], { timezone: TZ });
    const g2 = await gen(e.db);
    assert.equal(g2, w1.rangeGeneration + 2);
    // 接續：換代 → 剩餘 ∪ 失效範圍（含 3 天前那一天）
    let r; let n = 0;
    do { r = await light(e.db); n += 1; } while (r.result === ANALYTICS_RESULT.PARTIAL && n < 10);
    assert.equal(r.result, ANALYTICS_RESULT.SUCCESS);
    const f = await fresh(e.db);
    assert.equal(f.light.status, ANALYTICS_FRESHNESS.CURRENT); assert.equal(f.light.doneGeneration, g2);
    const rows = await e.db.getAnalyticsDailyState(ALICE.id);
    const d3 = rows.find((x) => x.metrics.respiratory_rate === 99);
    const d100 = rows.find((x) => x.metrics.respiratory_rate === 98);
    assert.ok(d3 && d3.generation === g2, '★ 第一片裡被 N+1 改到的那天重算了');
    assert.ok(d100 && d100.generation === g2, '★ 100 天前那天也算了');
    assert.ok(rows.every((x) => !x.stale));
    console.log(`  chunks to converge after N+1: ${n}`);
  } finally { e.done(); }
});

test('F03-F 只有 100 天前的一筆修正 → 不會被「最新 45 天」吃掉，一片就算到它', async () => {
  const e = await env();
  try {
    await seedLong(e.db);
    let r; do { r = await light(e.db); } while (r.result === ANALYTICS_RESULT.PARTIAL);
    assert.equal((await fresh(e.db)).light.status, ANALYTICS_FRESHNESS.CURRENT);
    await e.db.upsertSleeps(ALICE.id, [sleepRecord({ id: sid(1100), daysAgo: 100, updatedAt: at(0, -1), rr: 77 })], { timezone: TZ });
    const i = await inv(e.db);
    const r2 = await light(e.db);
    assert.equal(r2.result, ANALYTICS_RESULT.SUCCESS, '3 天的範圍一片完成');
    assert.equal(r2.summary.from, addDays(i.affectedFrom, -1)); assert.equal(r2.summary.to, addDays(i.affectedTo, 1));
    const row = (await e.db.getAnalyticsDailyState(ALICE.id)).find((x) => x.metrics.respiratory_rate === 77);
    assert.ok(row && row.generation === i.generation && !row.stale, '★ 100 天前那天被重算');
    assert.equal((await fresh(e.db)).light.status, ANALYTICS_FRESHNESS.CURRENT);
  } finally { e.done(); }
});

test('F03-G / ATTACK 10 Alice / Bob 各自的長範圍與分片進度互不影響', async () => {
  const e = await env([ALICE, BOB]);
  try {
    await seedLong(e.db, ALICE); await seedHistory(e.db, BOB, 60);
    const a1 = await light(e.db, ALICE); const b1 = await light(e.db, BOB);
    assert.equal(a1.result, ANALYTICS_RESULT.PARTIAL); assert.equal(b1.result, ANALYTICS_RESULT.PARTIAL);
    const wa = await work(e.db, ALICE, LIGHT); const wb = await work(e.db, BOB, LIGHT);
    assert.notEqual(wa.rangeFrom, wb.rangeFrom, '各自的剩餘範圍');
    const b2 = await light(e.db, BOB);
    assert.equal(b2.result, ANALYTICS_RESULT.SUCCESS);
    assert.equal((await fresh(e.db, BOB)).light.status, ANALYTICS_FRESHNESS.CURRENT);
    assert.equal((await fresh(e.db, ALICE)).light.status, ANALYTICS_FRESHNESS.PENDING, 'Bob 完成不影響 Alice');
    assert.deepEqual((await work(e.db, ALICE, LIGHT)).rangeTo, wa.rangeTo);
    const pend = await processPendingAnalytics({ db: e.db, cls: LIGHT, now: () => NOW });
    assert.deepEqual(pend.processed.map((p) => [p.userId, p.result]), [[ALICE.id, 'PARTIAL']]);
    const a3 = await light(e.db, ALICE);
    assert.equal(a3.result, ANALYTICS_RESULT.SUCCESS);
    assert.equal((await e.db.getAnalyticsDailyState(ALICE.id)).length, 130);
    assert.equal((await e.db.getAnalyticsDailyState(BOB.id)).length, 60);
  } finally { e.done(); }
});

test('F03-H ≤ 45 天的範圍一輪完成；分片純函式', async () => {
  const e = await env();
  try {
    await seedHistory(e.db, ALICE, 40);
    const r = await light(e.db);
    assert.equal(r.result, ANALYTICS_RESULT.SUCCESS); assert.equal(r.summary.remaining, null);
    assert.equal((await fresh(e.db)).light.status, ANALYTICS_FRESHNESS.CURRENT);
    assert.deepEqual(nextLightChunk({ from: '2026-01-01', to: '2026-01-10' }), { chunk: { from: '2026-01-01', to: '2026-01-10' }, remainingTo: null, complete: true });
    assert.deepEqual(nextLightChunk({ from: '2026-01-01', to: '2026-03-01' }, { maxDays: 30 }), { chunk: { from: '2026-01-31', to: '2026-03-01' }, remainingTo: '2026-01-30', complete: false });
    assert.deepEqual(unionRange({ from: '2026-01-05', to: '2026-01-10' }, { from: '2026-01-01', to: '2026-01-07' }), { from: '2026-01-01', to: '2026-01-10' });
    assert.deepEqual(unionRange(null, { from: 'a', to: 'b' }), { from: 'a', to: 'b' });
  } finally { e.done(); }
});

test('F03 store 規則：advanceAnalyticsRange 的 CAS（owner / 租約 / range_generation / range_to）', async () => {
  const e = await env();
  try {
    await seedHistory(e.db, ALICE, 1);
    const c = await e.db.claimAnalyticsWork({ userId: ALICE.id, cls: LIGHT, owner: 'A', leaseMs: 60_000, now: NOW });
    assert.ok(await e.db.setAnalyticsRange({ userId: ALICE.id, cls: LIGHT, owner: 'A', generation: c.generation, from: '2026-01-01', to: '2026-03-01', now: NOW }));
    assert.equal(await e.db.advanceAnalyticsRange({ userId: ALICE.id, cls: LIGHT, owner: 'B', generation: c.generation, chunkTo: '2026-03-01', newTo: '2026-02-01', now: NOW }), false, '別人');
    assert.equal(await e.db.advanceAnalyticsRange({ userId: ALICE.id, cls: LIGHT, owner: 'A', generation: c.generation + 1, chunkTo: '2026-03-01', newTo: '2026-02-01', now: NOW }), false, '錯的代');
    assert.equal(await e.db.advanceAnalyticsRange({ userId: ALICE.id, cls: LIGHT, owner: 'A', generation: c.generation, chunkTo: '2026-02-28', newTo: '2026-02-01', now: NOW }), false, '上緣不符');
    assert.equal(await e.db.advanceAnalyticsRange({ userId: ALICE.id, cls: LIGHT, owner: 'A', generation: c.generation, chunkTo: '2026-03-01', newTo: '2026-02-01', now: new Date(NOW.getTime() + 60_000) }), false, '租約到期');
    assert.equal(await e.db.advanceAnalyticsRange({ userId: ALICE.id, cls: LIGHT, owner: 'A', generation: c.generation, chunkTo: '2026-03-01', newTo: '2026-02-01', now: NOW }), true);
    assert.equal((await work(e.db, ALICE, LIGHT)).rangeTo, '2026-02-01');
    assert.equal(await e.db.advanceAnalyticsRange({ userId: ALICE.id, cls: LIGHT, owner: 'A', generation: c.generation, chunkTo: '2026-02-01', newTo: null, now: NOW }), true);
    const w = await work(e.db, ALICE, LIGHT);
    assert.equal(w.rangeFrom, null); assert.equal(w.rangeTo, null);
  } finally { e.done(); }
});

// ===========================================================================
// 遷移 v12 → v13
// ===========================================================================

test('遷移 v12 → v13：三個 nullable 欄位純新增；既有 canonical / 墓碑 / 對帳 / 分析狀態一列不動；冪等；中斷後補齊', async () => {
  const e = await env();
  try {
    await seedHistory(e.db, ALICE, 2);
    await light(e.db);
    const beforeState = await work(e.db, ALICE, LIGHT);
    const COLS = ['range_generation', 'range_from', 'range_to'];
    const cols = async () => (await e.db.raw.execute('PRAGMA table_info(analytics_work_state)')).rows.map((r) => String(r.name));
    // 退回真的 v12 形狀
    for (const c of COLS) await e.db.raw.execute(`ALTER TABLE analytics_work_state DROP COLUMN ${c}`);
    await e.db.raw.execute('DROP TABLE IF EXISTS user_onboarding');   // v14 的表也要退掉
    await e.db.raw.execute('DELETE FROM schema_version WHERE version >= 13');
    await e.db.raw.execute("INSERT OR IGNORE INTO schema_version (version, applied_at, note) VALUES (12, '2026-09-12T00:00:00.000Z', 'v12')");
    for (const c of COLS) assert.ok(!(await cols()).includes(c));
    const s = await runMigrations(e.db.raw);
    assert.equal(s.from, 12); assert.equal(s.to, SCHEMA_VERSION); assert.equal(SCHEMA_VERSION, 15);
    assert.deepEqual(s.rebuilt, []);
    assert.deepEqual(s.columnsAdded, COLS.map((c) => `analytics_work_state.${c}`));
    const tables = (await e.db.raw.execute("SELECT name FROM sqlite_master WHERE type='table'")).rows.map((r) => String(r.name));
    assert.ok(tables.includes('user_onboarding'), 'v14 的表在同一次遷移裡一起建起來');
    const afterState = await work(e.db, ALICE, LIGHT);
    assert.equal(afterState.doneGeneration, beforeState.doneGeneration); assert.equal(afterState.lastSuccessAt, beforeState.lastSuccessAt);
    assert.equal(afterState.rangeFrom, null);
    assert.equal(await rowCount(e.db, 'whoop_sleeps', ALICE.id), 2);
    for (let i = 0; i < 3; i += 1) { const s2 = await runMigrations(e.db.raw); assert.deepEqual(s2.columnsAdded, []); assert.deepEqual(s2.rebuilt, []); }
    // 中斷：只加了一個欄位
    for (const c of COLS) await e.db.raw.execute(`ALTER TABLE analytics_work_state DROP COLUMN ${c}`);
    await e.db.raw.execute('DELETE FROM schema_version WHERE version >= 13');
    await e.db.raw.execute('ALTER TABLE analytics_work_state ADD COLUMN range_generation INTEGER');
    const s3 = await runMigrations(e.db.raw);
    assert.deepEqual(s3.columnsAdded, ['analytics_work_state.range_from', 'analytics_work_state.range_to']);
    const v13 = ADDITIVE_COLUMNS.filter((c) => c.table === 'analytics_work_state');
    assert.equal(v13.length, 3); assert.ok(v13.every((c) => !/NOT NULL/.test(c.ddl) && !c.backfill));
    // 升級後分片可用
    await seedHistory(e.db, ALICE, 60, { startDaysAgo: 3 });
    const r = await light(e.db);
    assert.equal(r.result, ANALYTICS_RESULT.PARTIAL);
  } finally { e.done(); }
});
