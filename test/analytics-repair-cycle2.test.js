/**
 * V1.2 Phase 3 — 修復週期 2（P3-RC1-F01）。
 *
 * 缺陷：輕量輸出的所有權證明用的是呼叫端**稍早凍結**的時刻。
 * 昂貴的 daily metrics 載入跑完之後，租約其實已經過期，但證明仍然拿計算開始
 * 時的時間去問「lease_expires_at > T」——於是過期的工作者照樣寫進耐久輸出，
 * 之後才在範圍推進那一步被擋下並判成 FENCED。輸出已經進去了。
 *
 * 修法：租約證明用**活的時鐘函式**，在交易裡的 before 與 after 各取一次當下時刻。
 * 分析錨點（health_date / 就緒判定 / computed_at）仍然是穩定的 `now`，兩者分開。
 *
 * 這一支用**真正的工作者路徑**（processAnalyticsForUser → runLightweightAnalysis
 * → saveAnalyticsDailyState）重現 Codex 的序列，並證明 before 與 after 兩個檢查
 * 各自獨立看當下時間。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createDb } from '../src/db.js';
import {
  processAnalyticsForUser, runLightweightAnalysis, fencedAnalyticsDb, lightRangeFor,
} from '../src/analyticsWorker.js';
import { ANALYTICS_CLASS, ANALYTICS_RESULT, ANALYTICS_FRESHNESS, SCHEMA_VERSION } from '../src/schema.js';
import { LIFECYCLE_UNFENCED } from '../src/accountLifecycle.js';

const TZ = 'Asia/Taipei';
const ALICE = { id: 'u-alice', whoop: '1001' };
const BOB = { id: 'u-bob', whoop: '2002' };
const NOW = new Date('2026-09-15T12:00:00.000Z');
const DAY = 86_400_000;
const HOUR = 3_600_000;
const { LIGHT, HEAVY } = ANALYTICS_CLASS;
/** 刻意很短的租約：計算一定會跑超過它。 */
const SHORT_LEASE = 1000;

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whoop-p3rc2-'));
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
const sleepRecord = ({ id = sid(1), updatedAt = at(2), rr = 15, daysAgo = 2 } = {}) => {
  const start = at(daysAgo + 1, 10);
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

const fresh = (db, u = ALICE) => db.getAnalyticsFreshness(u.id);
const work = (db, u, cls) => db.getAnalyticsWorkState(u.id, cls);
const rowCount = async (db, table, uid) => Number((await db.raw.execute({ sql: `SELECT COUNT(*) n FROM ${table} WHERE user_id = ?`, args: [uid] })).rows[0].n);
const dailyRows = (rr, dates) => dates.map((d) => ({ health_date: d, daily_status: 'READY', metrics: { health_date: d, respiratory_rate: rr } }));

async function seedHistory(db, user, days) {
  for (let i = 1; i <= days; i += 1) {
    await db.upsertSleeps(user.id, [sleepRecord({ id: sid(1000 + i), daysAgo: i, updatedAt: at(i), rr: 14 + (i % 3) })], { timezone: TZ });
    await db.upsertRecoveries(user.id, [recoveryRecord({ sleepId: sid(1000 + i), updatedAt: at(i), score: 50 + (i % 40) })]);
  }
}

// ===========================================================================
// P3-RC1-F01 — 真正的工作者路徑重現
// ===========================================================================

test('RC2 主案例：真實工作者路徑 —— 計算期間租約過期（無人接手）→ FENCED、0 列輸出、游標不動；之後新 owner 正常完成', async () => {
  const e = await env();
  try {
    await seedHistory(e.db, ALICE, 6);
    const genBefore = (await e.db.getAnalyticsInvalidation(ALICE.id)).generation;

    // 注入的邏輯時鐘：在「載入 daily metrics」期間越過租約到期。
    let t = NOW.getTime();
    const clock = () => new Date(t);
    let advancedAt = null;
    const slowDb = {
      ...e.db,
      // 真正的工作者路徑會呼叫它來載入這一片的資料；載入「很慢」，慢過租約。
      getRecoveries: async (...args) => {
        if (advancedAt === null) { t += SHORT_LEASE + 1; advancedAt = t; }
        return e.db.getRecoveries(...args);
      },
    };

    const r = await processAnalyticsForUser({
      db: slowDb, userId: ALICE.id, cls: LIGHT, owner: 'A', now: clock, leaseMs: SHORT_LEASE,
    });

    // ---- 必要的最終狀態 ----
    assert.equal(r.result, ANALYTICS_RESULT.FENCED, '★ 結果是 FENCED');
    assert.equal(await rowCount(e.db, 'analytics_daily_state', ALICE.id), 0, '★★★ 過期的 A 寫入 0 列');
    // 這一代需要覆蓋的完整範圍（認領時就耐久化，讓下一個 owner 接得下去）。
    // 「沒有推進」= 剩餘範圍仍然是**整個**需要的範圍，一天都沒被消化掉。
    const invRow = await e.db.getAnalyticsInvalidation(ALICE.id);
    const needed = lightRangeFor({
      affectedFrom: invRow.affectedFrom, affectedTo: invRow.affectedTo,
      anchorDate: (await e.db.coverage(ALICE.id)).last_date,
    });
    const w = await work(e.db, ALICE, LIGHT);
    assert.deepEqual({ from: w.rangeFrom, to: w.rangeTo }, needed, '★ 範圍完全沒有被推進（沒有任何一片被當成完成）');
    assert.equal(w.rangeGeneration, genBefore);
    assert.equal(w.doneGeneration, 0, '★ done_generation 不變');
    assert.notEqual(w.status, 'SUCCESS', '★ 沒有被錯誤地標成完成');
    assert.equal(w.consecutiveFailures, 0, '★ FENCED 不算失敗、不排退避');
    assert.equal(w.nextAttemptAt, null);
    const f = await fresh(e.db);
    assert.equal(f.light.status, ANALYTICS_FRESHNESS.PENDING, '★ 仍待處理');
    assert.equal(f.generation, genBefore);
    const runs = await e.db.recentAnalyticsRuns(ALICE.id, { cls: LIGHT });
    assert.equal(runs[0].result, ANALYTICS_RESULT.FENCED);
    assert.equal(runs[0].owner, 'A');

    // ---- 新 owner 接手：正常完成 ----
    const later = new Date(t + 10_000);
    assert.deepEqual((await e.db.listPendingAnalytics(LIGHT, { now: later })).map((p) => p.userId), [ALICE.id]);
    const b = await processAnalyticsForUser({ db: e.db, userId: ALICE.id, cls: LIGHT, owner: 'B', now: () => later });
    assert.equal(b.result, ANALYTICS_RESULT.SUCCESS, '★ B 成功');
    assert.equal(await rowCount(e.db, 'analytics_daily_state', ALICE.id), 6, '★ 六天都物化了');
    const f2 = await fresh(e.db);
    assert.equal(f2.light.status, ANALYTICS_FRESHNESS.CURRENT, '★ 合法完成之後才 CURRENT');
    assert.equal(f2.light.doneGeneration, genBefore);
    assert.ok((await e.db.getAnalyticsDailyState(ALICE.id)).every((x) => !x.stale));
  } finally { e.done(); }
});

test('RC2 BEFORE 檢查：持久化交易開始前就過期 → before 擋下、0 列', async () => {
  const e = await env();
  try {
    await seedHistory(e.db, ALICE, 3);
    const c = await e.db.claimAnalyticsWork({ expectedLifecycleGeneration: LIFECYCLE_UNFENCED, userId: ALICE.id, cls: LIGHT, owner: 'A', leaseMs: SHORT_LEASE, now: NOW });
    const expired = new Date(NOW.getTime() + SHORT_LEASE + 1);
    await assert.rejects(e.db.saveAnalyticsDailyState(ALICE.id, dailyRows(1, ['2026-09-14']), { expectedLifecycleGeneration: LIFECYCLE_UNFENCED,
      owner: 'A', generation: c.generation, now: NOW, clock: () => expired,
    }), /analytics_ownership_lost/);
    assert.equal(await rowCount(e.db, 'analytics_daily_state', ALICE.id), 0, '★ 0 列');
  } finally { e.done(); }
});

test('RC2 AFTER 檢查（強制）：before 通過、寫入執行、寫入期間才過期 → after 擋下、整段回滾、0 列', async () => {
  const e = await env();
  try {
    await seedHistory(e.db, ALICE, 3);
    const c = await e.db.claimAnalyticsWork({ expectedLifecycleGeneration: LIFECYCLE_UNFENCED, userId: ALICE.id, cls: LIGHT, owner: 'A', leaseMs: SHORT_LEASE, now: NOW });
    // 時鐘：第一次（before）還在租約內；之後（after）已經過期。
    let calls = 0;
    const crossing = () => {
      calls += 1;
      return calls === 1 ? new Date(NOW.getTime() + SHORT_LEASE - 1) : new Date(NOW.getTime() + SHORT_LEASE + 1);
    };
    await assert.rejects(e.db.saveAnalyticsDailyState(ALICE.id, dailyRows(7, ['2026-09-13', '2026-09-14']), { expectedLifecycleGeneration: LIFECYCLE_UNFENCED,
      owner: 'A', generation: c.generation, now: NOW, clock: crossing,
    }), /analytics_ownership_lost/);
    assert.ok(calls >= 2, `★ before 與 after 各自取了一次時間（calls=${calls}）`);
    assert.equal(await rowCount(e.db, 'analytics_daily_state', ALICE.id), 0, '★★★ 交易回滾：0 列');
    // 對照組：同一段寫入、時鐘全程有效 → 真的寫進去（證明上面擋下的是 after，不是別的原因）
    const live = new Date(NOW.getTime() + SHORT_LEASE - 1);
    const n = await e.db.saveAnalyticsDailyState(ALICE.id, dailyRows(7, ['2026-09-13', '2026-09-14']), { expectedLifecycleGeneration: LIFECYCLE_UNFENCED,
      owner: 'A', generation: c.generation, now: NOW, clock: () => live,
    });
    assert.equal(n, 2);
    assert.equal(await rowCount(e.db, 'analytics_daily_state', ALICE.id), 2);
  } finally { e.done(); }
});

test('RC2 mutateForAnalytics 結構上拒絕凍結時間：不是函式就拋錯（避免 F01 回歸）', async () => {
  const e = await env();
  try {
    await seedHistory(e.db, ALICE, 1);
    const c = await e.db.claimAnalyticsWork({ expectedLifecycleGeneration: LIFECYCLE_UNFENCED, userId: ALICE.id, cls: LIGHT, owner: 'A', leaseMs: 60_000, now: NOW });
    await assert.rejects(e.db.mutateForAnalytics({ expectedLifecycleGeneration: LIFECYCLE_UNFENCED, userId: ALICE.id, cls: LIGHT, owner: 'A', generation: c.generation, now: NOW }, async () => {}), /analytics_live_clock_required/);
    await assert.rejects(e.db.saveAnalyticsDailyState(ALICE.id, dailyRows(1, ['2026-09-14']), { expectedLifecycleGeneration: LIFECYCLE_UNFENCED, owner: 'A', generation: c.generation, now: NOW, clock: NOW }), /analytics_live_clock_required/);
    assert.throws(() => fencedAnalyticsDb(e.db, { expectedLifecycleGeneration: LIFECYCLE_UNFENCED, userId: ALICE.id, cls: HEAVY, owner: 'A', generation: 1, now: NOW }), /analytics_live_clock_required/);
    assert.equal(await rowCount(e.db, 'analytics_daily_state', ALICE.id), 0);
  } finally { e.done(); }
});

test('RC2 租約相等邊界仍然是「過期」：lease_expires_at == now → 0 列；now − 1ms → 寫入', async () => {
  const e = await env();
  try {
    await seedHistory(e.db, ALICE, 2);
    const c = await e.db.claimAnalyticsWork({ expectedLifecycleGeneration: LIFECYCLE_UNFENCED, userId: ALICE.id, cls: LIGHT, owner: 'A', leaseMs: 60_000, now: NOW });
    const boundary = new Date(NOW.getTime() + 60_000);
    await assert.rejects(e.db.saveAnalyticsDailyState(ALICE.id, dailyRows(1, ['2026-09-14']), { expectedLifecycleGeneration: LIFECYCLE_UNFENCED,
      owner: 'A', generation: c.generation, now: NOW, clock: () => boundary,
    }), /analytics_ownership_lost/);
    assert.equal(await rowCount(e.db, 'analytics_daily_state', ALICE.id), 0);
    const n = await e.db.saveAnalyticsDailyState(ALICE.id, dailyRows(1, ['2026-09-14']), { expectedLifecycleGeneration: LIFECYCLE_UNFENCED,
      owner: 'A', generation: c.generation, now: NOW, clock: () => new Date(boundary.getTime() - 1),
    });
    assert.equal(n, 1);
  } finally { e.done(); }
});

test('RC2 分析錨點與租約時鐘分開：計算中途時間前進，health_date / 就緒判定仍用穩定的錨點', async () => {
  const e = await env();
  try {
    await seedHistory(e.db, ALICE, 3);
    const c = await e.db.claimAnalyticsWork({ expectedLifecycleGeneration: LIFECYCLE_UNFENCED, userId: ALICE.id, cls: LIGHT, owner: 'A', leaseMs: 600_000, now: NOW });
    // 錨點固定在 NOW；活時鐘往前走（但還在租約內）
    let t = NOW.getTime();
    const r = await runLightweightAnalysis({ expectedLifecycleGeneration: LIFECYCLE_UNFENCED,
      db: e.db, userId: ALICE.id, timezone: TZ, generation: c.generation, owner: 'A',
      range: { from: '2026-09-11', to: '2026-09-15' }, now: NOW, clock: () => { t += 30_000; return new Date(t); },
    });
    assert.ok(r.days >= 3);
    const rows = await e.db.getAnalyticsDailyState(ALICE.id);
    assert.ok(rows.every((x) => x.computedAt === NOW.toISOString()), '★ computed_at 用穩定的錨點，不是活時鐘');
    assert.ok(rows.every((x) => x.healthDate >= '2026-09-11' && x.healthDate <= '2026-09-15'));
    assert.equal(r.anchorDate, (await e.db.coverage(ALICE.id)).last_date);
  } finally { e.done(); }
});

test('RC2 分片耦合：過期造成 0 列輸出時，範圍游標也完全不動；下一個 owner 從同一個上緣接續', async () => {
  const e = await env();
  try {
    await seedHistory(e.db, ALICE, 130);
    // 第一片正常完成（PARTIAL）
    const r1 = await processAnalyticsForUser({ db: e.db, userId: ALICE.id, cls: LIGHT, owner: 'L1', now: () => NOW });
    assert.equal(r1.result, ANALYTICS_RESULT.PARTIAL);
    const before = await work(e.db, ALICE, LIGHT);
    const rowsBefore = await rowCount(e.db, 'analytics_daily_state', ALICE.id);

    // 第二片：計算期間租約過期
    let t = NOW.getTime() + 1000;
    let advanced = false;
    const slowDb = {
      ...e.db,
      getRecoveries: async (...args) => { if (!advanced) { advanced = true; t += SHORT_LEASE + 1; } return e.db.getRecoveries(...args); },
    };
    const r2 = await processAnalyticsForUser({
      db: slowDb, userId: ALICE.id, cls: LIGHT, owner: 'L2', now: () => new Date(t), leaseMs: SHORT_LEASE,
    });
    assert.equal(r2.result, ANALYTICS_RESULT.FENCED);
    assert.equal(await rowCount(e.db, 'analytics_daily_state', ALICE.id), rowsBefore, '★ 0 列新輸出');
    const after = await work(e.db, ALICE, LIGHT);
    assert.equal(after.rangeTo, before.rangeTo, '★ 游標不動');
    assert.equal(after.rangeFrom, before.rangeFrom);
    assert.equal(after.doneGeneration, 0);
    assert.equal((await fresh(e.db)).light.status, ANALYTICS_FRESHNESS.PENDING);

    // 接續完成
    const now3 = new Date(t + 5000);
    let r; let n = 0;
    do { r = await processAnalyticsForUser({ db: e.db, userId: ALICE.id, cls: LIGHT, owner: 'L3', now: () => now3 }); n += 1; }
    while (r.result === ANALYTICS_RESULT.PARTIAL && n < 8);
    assert.equal(r.result, ANALYTICS_RESULT.SUCCESS);
    assert.equal((await fresh(e.db)).light.status, ANALYTICS_FRESHNESS.CURRENT);
    assert.equal(await rowCount(e.db, 'analytics_daily_state', ALICE.id), 130);
  } finally { e.done(); }
});

test('RC2 多使用者：A 的過期不影響 Bob 的輕量進度', async () => {
  const e = await env([ALICE, BOB]);
  try {
    await seedHistory(e.db, ALICE, 4); await seedHistory(e.db, BOB, 4);
    let t = NOW.getTime();
    let advanced = false;
    const slowDb = { ...e.db, getRecoveries: async (...a) => { if (!advanced) { advanced = true; t += SHORT_LEASE + 1; } return e.db.getRecoveries(...a); } };
    const ra = await processAnalyticsForUser({ db: slowDb, userId: ALICE.id, cls: LIGHT, owner: 'A', now: () => new Date(t), leaseMs: SHORT_LEASE });
    assert.equal(ra.result, ANALYTICS_RESULT.FENCED);
    const rb = await processAnalyticsForUser({ db: e.db, userId: BOB.id, cls: LIGHT, owner: 'B', now: () => new Date(t) });
    assert.equal(rb.result, ANALYTICS_RESULT.SUCCESS);
    assert.equal(await rowCount(e.db, 'analytics_daily_state', ALICE.id), 0);
    assert.equal(await rowCount(e.db, 'analytics_daily_state', BOB.id), 4);
    assert.equal((await fresh(e.db, ALICE)).light.status, ANALYTICS_FRESHNESS.PENDING);
    assert.equal((await fresh(e.db, BOB)).light.status, ANALYTICS_FRESHNESS.CURRENT);
  } finally { e.done(); }
});

test('RC2 的修復本身沒有動 schema（v13 的欄位仍在；v14 是 Phase 3.5 另外加的）', () => {
  assert.ok(SCHEMA_VERSION >= 13);
});
