/**
 * V1.1 final audit — H-06 / M-01 / M-02 / M-03 的回歸。
 *
 *   H-06  查詢失敗 → [] → workout_count = 0  （unknown 被偽造成事實）
 *   M-01  SUPPORTED 的信念在證據崩塌時無法降級（非法轉移 → 整個放棄）
 *   M-02  refresh 請求無上限 + 沒有寫入圍欄 → 過期的 owner 蓋掉新 token
 *   M-03  無條件 upsert → 較舊的 WHOOP 版本蓋掉較新的
 *
 * 絕不呼叫真的 WHOOP：token 那一題用注入的 fetch 替身。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { computeDailyMetrics, loadDailyMetricsDetailed } from '../src/dailyMetrics.js';
import {
  INSIGHT_STATUS, EVIDENCE_SOURCE, nextStatusFor, contradicts,
  canTransition, recordInsight, reviseInsight,
} from '../src/healthMemory.js';
import { createDb } from '../src/db.js';
import { createWhoopClient, refreshTokens } from '../src/whoop.js';
import { LOCKS } from '../src/config.js';

const TZ = 'UTC';

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v11-data-'));
  const db = createDb({ url: `file:${path.join(dir, 't.db')}` });
  return { db, cleanup: () => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

// ===========================================================================
// H-06 —— 缺資料絕不變成 0
// ===========================================================================

/** 一天份的最小骨架：一筆主睡眠 + 一個涵蓋它前一天的 cycle。 */
const SLEEP = {
  user_id: 'u', id: 's1', nap: 0, score_state: 'SCORED',
  start_at: '2026-09-11T22:00:00.000Z', end_at: '2026-09-12T06:00:00.000Z',
  raw_json: JSON.stringify({
    id: 's1', nap: false, score_state: 'SCORED',
    start: '2026-09-11T22:00:00.000Z', end: '2026-09-12T06:00:00.000Z',
    score: { stage_summary: { total_light_sleep_time_milli: 1, total_slow_wave_sleep_time_milli: 1, total_rem_sleep_time_milli: 1 } },
  }),
};
const CYCLE = {
  user_id: 'u', id: 'c1', score_state: 'SCORED',
  start_at: '2026-09-11T00:00:00.000Z', end_at: '2026-09-11T22:00:00.000Z',
  raw_json: JSON.stringify({
    id: 'c1', score_state: 'SCORED',
    start: '2026-09-11T00:00:00.000Z', end: '2026-09-11T22:00:00.000Z',
    score: { strain: 10 },
  }),
};

test('★★★ H-06/1: 查詢成功而且真的沒有運動 → workout_count = 0（真零）', () => {
  const rows = computeDailyMetrics({
    sleepRows: [SLEEP], cycleRows: [CYCLE], workoutRows: [], timezone: TZ,
    available: { sleeps: true, recoveries: true, cycles: true, workouts: true },
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].workout_count, 0, '★ 真的沒運動就是 0');
  assert.equal(rows[0].workout_scored_count, 0);
  assert.equal(rows[0].workouts_available, true);
});

test('★★★ H-06/2: 查詢失敗 → workout_count = null（不可以變成 0）', () => {
  const rows = computeDailyMetrics({
    sleepRows: [SLEEP], cycleRows: [CYCLE], workoutRows: [], timezone: TZ,
    available: { sleeps: true, recoveries: true, cycles: true, workouts: false },
  });
  assert.equal(rows[0].workout_count, null, '★★★ 讀不到就是不知道，不是零');
  assert.equal(rows[0].workout_scored_count, null);
  assert.equal(rows[0].workout_strain_total, null);
  assert.equal(rows[0].workout_duration_minutes, null);
  assert.equal(rows[0].zone1_3_minutes, null);
  assert.equal(rows[0].zone4_5_minutes, null);
  assert.equal(rows[0].strength_minutes_derived, null);
  assert.equal(rows[0].workouts_available, false);
});

test('★★★ H-06/3: 旗標也不可以說謊 —— recovery/cycle 讀不到時是 null 不是 false', () => {
  const rows = computeDailyMetrics({
    sleepRows: [SLEEP], cycleRows: [CYCLE], workoutRows: [], timezone: TZ,
    available: { sleeps: true, recoveries: false, cycles: true, workouts: true },
  });
  assert.equal(rows[0].has_recovery, null, '★ 「讀不到」不等於「沒有」');
  assert.equal(rows[0].recovery_scored, null);
  assert.equal(rows[0].recovery, null);

  const noCycle = computeDailyMetrics({
    sleepRows: [SLEEP], cycleRows: [], workoutRows: [], timezone: TZ,
    available: { sleeps: true, recoveries: true, cycles: false, workouts: true },
  });
  assert.equal(noCycle[0].has_previous_cycle, null);
});

test('★★★ H-06/4: 端到端 —— getWorkouts 拋錯時整條管線都拿到 null', async () => {
  const failing = {
    getSleeps: async () => [SLEEP],
    getRecoveries: async () => [],
    getCycles: async () => [CYCLE],
    getWorkouts: async () => { throw new Error('whoop_workouts 查詢失敗'); },
    getLatestBodyMeasurement: async () => null,
  };
  const { rows, available, complete } = await loadDailyMetricsDetailed({
    db: failing, userId: 'u', timezone: TZ, from: '2026-09-12', to: '2026-09-12',
  });
  assert.equal(available.workouts, false);
  assert.equal(complete, false, '★ 這批資料不完整，呼叫端必須知道');
  assert.equal(rows[0].workout_count, null, '★★★ 絕不可以出現 workout_count = 0');

  // 對照組：同一條路徑在查詢成功時仍然給出真零。
  const ok = await loadDailyMetricsDetailed({
    db: { ...failing, getWorkouts: async () => [] },
    userId: 'u', timezone: TZ, from: '2026-09-12', to: '2026-09-12',
  });
  assert.equal(ok.complete, true);
  assert.equal(ok.rows[0].workout_count, 0);
});

// ===========================================================================
// M-01 —— 信念降級
// ===========================================================================

test('★★★ M-01/1: SUPPORTED 遇到崩塌的有效證據 → 合法降級到 WEAKENED', () => {
  // 樣本數掉到不足
  assert.equal(
    nextStatusFor(INSIGHT_STATUS.SUPPORTED, { sampleCount: 5, effectSize: 0.8 }),
    INSIGHT_STATUS.WEAKENED,
    '★★★ 舊版在這裡試圖走 → HYPOTHESIS，被判非法而整個放棄',
  );
  // 效果量變弱
  assert.equal(
    nextStatusFor(INSIGHT_STATUS.SUPPORTED, { sampleCount: 50, effectSize: 0.05 }),
    INSIGHT_STATUS.WEAKENED,
  );
  assert.equal(canTransition(INSIGHT_STATUS.SUPPORTED, INSIGHT_STATUS.WEAKENED), true);
  assert.equal(canTransition(INSIGHT_STATUS.SUPPORTED, INSIGHT_STATUS.HYPOTHESIS), false,
    '★ 退回「還沒相信過」仍然是非法的');
});

test('★★★ M-01/2: 連續兩次崩塌 → RETIRED（但一次不會）', () => {
  assert.equal(
    nextStatusFor(INSIGHT_STATUS.WEAKENED, { sampleCount: 5, effectSize: 0.8 }),
    INSIGHT_STATUS.RETIRED,
    '★ 已經降級過、這次仍然沒回來 → 收掉',
  );
  assert.equal(
    nextStatusFor(INSIGHT_STATUS.SUPPORTED, { sampleCount: 5, effectSize: 0.8 }),
    INSIGHT_STATUS.WEAKENED,
    '★ 第一次只降級，不可以一次殺掉',
  );
});

test('★★★ M-01/3: 證據方向翻轉 = 被否定（不是變弱）', () => {
  assert.equal(contradicts(-0.6, 0.6), true);
  assert.equal(contradicts(-0.6, -0.3), false, '同方向變弱不算翻轉');
  assert.equal(contradicts(-0.6, 0.05), false, '在 0 附近跳動是雜訊，不是矛盾');
  assert.equal(contradicts(null, 0.6), false);

  assert.equal(
    nextStatusFor(INSIGHT_STATUS.SUPPORTED, {
      sampleCount: 50, effectSize: 0.7, previousEffectSize: -0.7,
    }),
    INSIGHT_STATUS.WEAKENED,
    '★ 方向翻轉先降級',
  );
  assert.equal(
    nextStatusFor(INSIGHT_STATUS.WEAKENED, {
      sampleCount: 50, effectSize: 0.7, previousEffectSize: -0.7,
    }),
    INSIGHT_STATUS.RETIRED,
    '★ 已經降級過又被否定 → 收掉',
  );
});

test('★★★ M-01/4: 恢復支持時可以升回來，但 HYPOTHESIS 不可以跳級', () => {
  assert.equal(
    nextStatusFor(INSIGHT_STATUS.WEAKENED, { sampleCount: 50, effectSize: 0.8 }),
    INSIGHT_STATUS.SUPPORTED,
  );
  assert.equal(
    nextStatusFor(INSIGHT_STATUS.HYPOTHESIS, { sampleCount: 50, effectSize: 0.8 }),
    INSIGHT_STATUS.EMERGING,
    '★ 一次回答不可以直接產生一條「已被支持」的規律',
  );
  assert.equal(nextStatusFor(INSIGHT_STATUS.RETIRED, { sampleCount: 50, effectSize: 0.9 }),
    INSIGHT_STATUS.RETIRED, '★ 退休的不可以復活');
});

test('★★★ M-01/5: 資料暫時拿不到 ≠ 證據不再支持（端到端）', async () => {
  const { db, cleanup } = tempDb();
  try {
    await db.migrate();
    await db.createUser({ id: 'u-m1', displayName: 'M1' });
    const { id, status } = await recordInsight(db, 'u-m1', {
      insightType: 'association', subject: 'alcohol->recovery',
      statement: '喝酒的隔天恢復偏低', evidence: { pearson: -0.7 },
      sampleCount: 50, effectSize: -0.7,
    });
    assert.equal(status, INSIGHT_STATUS.SUPPORTED);

    // ingestion 掛了：這一輪算不出證據。
    const skipped = await reviseInsight(db, 'u-m1', id, {
      statement: '喝酒的隔天恢復偏低', evidence: null, sampleCount: 0, effectSize: null,
    }, { evidenceSource: EVIDENCE_SOURCE.UNAVAILABLE });
    assert.equal(skipped.ok, true);
    assert.equal(skipped.changed, false);
    assert.equal(skipped.skipped, 'evidence_unavailable');
    assert.equal((await db.getInsight('u-m1', id)).status, INSIGHT_STATUS.SUPPORTED,
      '★★★ 基礎建設故障絕不可以改寫一個長期健康結論');

    // 樣本數根本沒給（undefined）也一樣不動。
    const noSample = await reviseInsight(db, 'u-m1', id, {
      statement: 'x', evidence: null, effectSize: null,
    });
    assert.equal(noSample.skipped, 'evidence_unavailable');
    assert.equal((await db.getInsight('u-m1', id)).status, INSIGHT_STATUS.SUPPORTED);

    // ★ 對照組：**有效**的新證據崩塌 → 真的要降級。
    const demoted = await reviseInsight(db, 'u-m1', id, {
      statement: '喝酒的隔天恢復偏低', evidence: { pearson: -0.02 },
      sampleCount: 50, effectSize: -0.02,
    }, { evidenceSource: EVIDENCE_SOURCE.AVAILABLE });
    assert.equal(demoted.ok, true);
    assert.equal(demoted.changed, true);
    assert.equal(demoted.status, INSIGHT_STATUS.WEAKENED, '★★★ 有效證據崩塌必須降級');
    assert.equal((await db.getInsight('u-m1', id)).status, INSIGHT_STATUS.RETIRED,
      '★ 舊版本被 RETIRE 並串起來（版本鏈可回溯）');
    assert.equal((await db.getInsight('u-m1', demoted.id)).status, INSIGHT_STATUS.WEAKENED);
  } finally { cleanup(); }
});

// ===========================================================================
// M-02 —— token refresh 圍欄
// ===========================================================================

const TOKEN_BODY = (suffix) => JSON.stringify({
  access_token: `access-${suffix}`,
  refresh_token: `refresh-${suffix}`,
  expires_in: 3600,
  scope: 'offline',
});

test('★★★ M-02/1: refresh 請求有明確逾時（不可以無上限地掛著）', async () => {
  let sawSignal = false;
  const fetchImpl = async (url, opts) => {
    sawSignal = Boolean(opts?.signal);
    return { ok: true, status: 200, async text() { return TOKEN_BODY('x'); } };
  };
  await refreshTokens({
    refreshToken: 'r', clientId: 'c', clientSecret: 's',
    tokenUrl: 'https://example.invalid/token', fetchImpl,
  });
  assert.equal(sawSignal, true, '★ 一定要帶 AbortSignal');
});

test('★★★ M-02/2: 逾時不會洩漏任何 token 內容', async () => {
  const fetchImpl = async () => {
    const err = new Error('The operation was aborted due to timeout');
    err.name = 'TimeoutError';
    throw err;
  };
  await assert.rejects(
    () => refreshTokens({
      refreshToken: 'super-secret-refresh-token', clientId: 'c', clientSecret: 'secret',
      tokenUrl: 'https://example.invalid/token', fetchImpl,
    }),
    (err) => {
      assert.doesNotMatch(err.message, /super-secret-refresh-token|secret/,
        '★ 錯誤訊息絕不可以帶祕密');
      return true;
    },
  );
});

test('★★★ M-02/3: A 租約過期 → B 寫入新 token → A 回來時被圍欄擋下', async () => {
  const { db, cleanup } = tempDb();
  try {
    await db.migrate();
    const uid = 'u-m2';
    await db.createUser({ id: uid, displayName: 'M2' });
    // 一組快過期的 token，強迫 refresh。
    await db.saveTokens(uid, {
      accessToken: 'access-v1', refreshToken: 'refresh-v1',
      expiresAt: new Date(Date.now() + 1_000), scope: 'offline',
    });
    const v1 = await db.getTokens(uid);

    let released = null;
    const client = createWhoopClient({
      db, userId: uid, clientId: 'c', clientSecret: 's',
      tokenUrl: 'https://example.invalid/token',
      // A 的 refresh 請求「卡住」：在它回來之前，B 已經完成整輪 refresh。
      fetchImpl: async () => {
        // B 搶走鎖並寫入 v2（模擬另一個 process）。
        await db.raw.execute({
          sql: 'DELETE FROM resource_locks WHERE name = ?',
          args: [`${LOCKS.TOKEN_REFRESH_NAME}:${uid}`],
        });
        released = true;
        const ok = await db.saveTokens(uid, {
          accessToken: 'access-v2', refreshToken: 'refresh-v2',
          expiresAt: new Date(Date.now() + 3_600_000), scope: 'offline',
        }, { expectedUpdatedAt: v1.updatedAt });
        assert.notEqual(ok, false, 'B 是贏家，它必須寫得進去');
        return { ok: true, status: 200, async text() { return TOKEN_BODY('A-STALE'); } };
      },
    });

    // A 的請求終於回來，手上是「以 v1 為基礎」的舊結果。
    const token = await client.getAccessToken({ force: true });
    assert.equal(released, true);

    const final = await db.getTokens(uid);
    assert.equal(final.accessToken, 'access-v2', '★★★ A 絕不可以蓋掉 B 的新 token');
    assert.equal(final.refreshToken, 'refresh-v2', '★★★ 輪替過的 refresh_token 必須保住');
    assert.equal(token, 'access-v2', '★ A 應該改用贏家寫好的 token');
  } finally { cleanup(); }
});

test('★★★ M-02/3b: 租約看起來還在，但 DB 已經前進 → CAS 仍然擋下舊寫入', async () => {
  // 兩道關卡是各自獨立的。時鐘偏移／鎖被誤放的時候，租約檢查可能通過，
  // 而 DB 上的版本戳才是最終權威。這一題把租約**保持有效**，只讓資料前進。
  const { db, cleanup } = tempDb();
  try {
    await db.migrate();
    const uid = 'u-m2b';
    await db.createUser({ id: uid, displayName: 'M2b' });
    await db.saveTokens(uid, {
      accessToken: 'access-v1', refreshToken: 'refresh-v1',
      expiresAt: new Date(Date.now() + 1_000), scope: 'offline',
    });
    const v1 = await db.getTokens(uid);

    const client = createWhoopClient({
      db, userId: uid, clientId: 'c', clientSecret: 's',
      tokenUrl: 'https://example.invalid/token',
      fetchImpl: async () => {
        // B 寫了 v2，但**沒有**動 A 的鎖。
        await new Promise((r) => { setTimeout(r, 5); });
        const ok = await db.saveTokens(uid, {
          accessToken: 'access-v2', refreshToken: 'refresh-v2',
          expiresAt: new Date(Date.now() + 3_600_000), scope: 'offline',
        }, { expectedUpdatedAt: v1.updatedAt });
        assert.notEqual(ok, false);
        return { ok: true, status: 200, async text() { return TOKEN_BODY('A-STALE'); } };
      },
    });

    const token = await client.getAccessToken({ force: true });
    const final = await db.getTokens(uid);
    assert.equal(final.accessToken, 'access-v2', '★★★ CAS 必須擋下遲到的寫入');
    assert.equal(final.refreshToken, 'refresh-v2');
    assert.equal(token, 'access-v2');
  } finally { cleanup(); }
});

test('★★★ M-02/4: compare-and-swap 本身 —— 版本對不上就拒絕寫入', async () => {
  const { db, cleanup } = tempDb();
  try {
    await db.migrate();
    const uid = 'u-cas';
    await db.createUser({ id: uid, displayName: 'CAS' });
    await db.saveTokens(uid, {
      accessToken: 'a1', refreshToken: 'r1',
      expiresAt: new Date(Date.now() + 3_600_000), scope: 'offline',
    });
    const v1 = await db.getTokens(uid);

    // 另一個寫者先成功了。
    await new Promise((r) => { setTimeout(r, 5); });   // 確保 updated_at 不同
    const won = await db.saveTokens(uid, {
      accessToken: 'a2', refreshToken: 'r2',
      expiresAt: new Date(Date.now() + 3_600_000), scope: 'offline',
    }, { expectedUpdatedAt: v1.updatedAt });
    assert.notEqual(won, false);

    // 遲到的寫者帶著 v1 的版本戳回來 → 必須被拒絕，而且不是拋錯。
    const lost = await db.saveTokens(uid, {
      accessToken: 'a-stale', refreshToken: 'r-stale',
      expiresAt: new Date(Date.now() + 3_600_000), scope: 'offline',
    }, { expectedUpdatedAt: v1.updatedAt });
    assert.equal(lost, false, '★★★ CAS 落敗要回 false（併發控制正常運作，不是錯誤）');
    assert.equal((await db.getTokens(uid)).accessToken, 'a2');

    // 多使用者：Alice 的版本戳不可以用來寫 Bob 的列。
    await db.createUser({ id: 'u-cas-2', displayName: 'CAS2' });
    await db.saveTokens('u-cas-2', {
      accessToken: 'b1', refreshToken: 'rb1',
      expiresAt: new Date(Date.now() + 3_600_000), scope: 'offline',
    });
    const bob = await db.getTokens('u-cas-2');
    assert.notEqual(bob.accessToken, 'a2', '★ 兩個人的 token 完全獨立');
  } finally { cleanup(); }
});

// ===========================================================================
// M-03 —— WHOOP 版本新鮮度
// ===========================================================================

const sleepAt = (updatedAt, rr) => ({
  id: 'sleep-1', nap: false, score_state: 'SCORED',
  start: '2026-09-11T22:00:00.000Z', end: '2026-09-12T06:00:00.000Z',
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

async function storedRr(db, uid) {
  const rs = await db.raw.execute({
    sql: 'SELECT respiratory_rate, updated_at FROM whoop_sleeps WHERE user_id = ? AND id = ?',
    args: [uid, 'sleep-1'],
  });
  return rs.rows[0];
}

test('★★★ M-03/1: 較舊的版本不可以覆蓋較新的（本地回應順序不代表來源順序）', async () => {
  const { db, cleanup } = tempDb();
  try {
    await db.migrate();
    const uid = 'u-m3';
    await db.createUser({ id: uid, displayName: 'M3' });

    // 較新的版本先寫進去（B 的請求比較快回來）。
    await db.upsertSleeps(uid, [sleepAt('2026-09-12T10:05:00.000Z', 99)], { timezone: TZ });
    assert.equal(Number((await storedRr(db, uid)).respiratory_rate), 99);

    // A 的舊回應現在才回來。
    const n = await db.upsertSleeps(uid, [sleepAt('2026-09-12T10:00:00.000Z', 11)], { timezone: TZ });
    assert.equal(n, 0, '★ 舊版本不可以產生任何寫入');
    const row = await storedRr(db, uid);
    assert.equal(Number(row.respiratory_rate), 99, '★★★ 較新的版本必須保住');
    assert.equal(row.updated_at, '2026-09-12T10:05:00.000Z');
  } finally { cleanup(); }
});

test('★★★ M-03/2: 較新的版本要更新；相同版本重放要冪等', async () => {
  const { db, cleanup } = tempDb();
  try {
    await db.migrate();
    const uid = 'u-m3b';
    await db.createUser({ id: uid, displayName: 'M3b' });

    await db.upsertSleeps(uid, [sleepAt('2026-09-12T10:00:00.000Z', 11)], { timezone: TZ });
    // 較新 → 更新
    await db.upsertSleeps(uid, [sleepAt('2026-09-12T10:05:00.000Z', 22)], { timezone: TZ });
    assert.equal(Number((await storedRr(db, uid)).respiratory_rate), 22);

    // 相同版本重放 → 冪等（值不變，也不炸）
    await db.upsertSleeps(uid, [sleepAt('2026-09-12T10:05:00.000Z', 22)], { timezone: TZ });
    const row = await storedRr(db, uid);
    assert.equal(Number(row.respiratory_rate), 22);
    const count = await db.raw.execute({
      sql: 'SELECT COUNT(*) n FROM whoop_sleeps WHERE user_id = ?', args: [uid],
    });
    assert.equal(Number(count.rows[0].n), 1, '★ 不可以長出第二列');
  } finally { cleanup(); }
});

test('★★★ M-03/3: 來源版本不明時，不可以覆蓋一個**已知**版本', async () => {
  const { db, cleanup } = tempDb();
  try {
    await db.migrate();
    const uid = 'u-m3c';
    await db.createUser({ id: uid, displayName: 'M3c' });

    // 已知版本先在。
    await db.upsertSleeps(uid, [sleepAt('2026-09-12T10:00:00.000Z', 55)], { timezone: TZ });
    // 一筆沒有 updated_at 的資料進來 → 談不上「比較新」，不可以蓋。
    const n = await db.upsertSleeps(uid, [sleepAt(null, 77)], { timezone: TZ });
    assert.equal(n, 0);
    assert.equal(Number((await storedRr(db, uid)).respiratory_rate), 55,
      '★★★ 來源新鮮度無法建立時，保留已知版本');

    // 反過來：既有列沒有版本資訊時，有版本的可以寫進去（從未知變成已知）。
    const uid2 = 'u-m3d';
    await db.createUser({ id: uid2, displayName: 'M3d' });
    await db.upsertSleeps(uid2, [sleepAt(null, 33)], { timezone: TZ });
    await db.upsertSleeps(uid2, [sleepAt('2026-09-12T10:00:00.000Z', 44)], { timezone: TZ });
    assert.equal(Number((await storedRr(db, uid2)).respiratory_rate), 44);
  } finally { cleanup(); }
});

test('★★★ M-03/3b: 新鮮度守衛不可以連帶關掉 recovery 的 health_date 重連', async () => {
  // 回歸：writeBatched 改成回報**實際寫入筆數**之後，
  // 「這一輪 recovery 全部是舊版本 → 0 筆寫入」會讓 relink 被跳過，
  // 而同一輪的 sleep 可能剛換了 health_date（重新評分會改 sleep.end）。
  // relink 的觸發條件必須是「處理過」，不是「寫入過」。
  const { db, cleanup } = tempDb();
  try {
    await db.migrate();
    const uid = 'u-relink';
    await db.createUser({ id: uid, displayName: 'R' });

    const sleepWith = (updatedAt, end) => ({
      id: 'sleep-1', nap: false, score_state: 'SCORED',
      start: '2026-09-11T22:00:00.000Z', end, updated_at: updatedAt,
      score: {
        stage_summary: {
          total_light_sleep_time_milli: 1,
          total_slow_wave_sleep_time_milli: 1,
          total_rem_sleep_time_milli: 1,
        },
      },
    });
    const recWith = (updatedAt) => ({
      sleep_id: 'sleep-1', cycle_id: 'c1', user_id: 1, score_state: 'SCORED',
      updated_at: updatedAt, score: { recovery_score: 50 },
    });
    const healthDate = async () => (await db.raw.execute({
      sql: 'SELECT health_date FROM whoop_recoveries WHERE user_id = ?', args: [uid],
    })).rows[0].health_date;

    await db.upsertSleeps(uid, [sleepWith('2026-09-12T10:00:00.000Z', '2026-09-12T06:00:00.000Z')], { timezone: TZ });
    await db.upsertRecoveries(uid, [recWith('2026-09-12T12:00:00.000Z')]);
    assert.equal(await healthDate(), '2026-09-12');

    // sleep 重新評分 → health_date 變成 09-13；recovery 收到**較舊**的版本。
    await db.upsertSleeps(uid, [sleepWith('2026-09-12T11:00:00.000Z', '2026-09-13T06:00:00.000Z')], { timezone: TZ });
    const written = await db.upsertRecoveries(uid, [recWith('2026-09-12T09:00:00.000Z')]);
    assert.equal(written, 0, '★ 舊版本不可以寫入');
    assert.equal(await healthDate(), '2026-09-13',
      '★★★ 但 health_date 仍然要跟著 sleep 重連');
  } finally { cleanup(); }
});

test('★★★ M-03/4: 新鮮度守衛是 per-user 的（Alice 的版本不影響 Bob）', async () => {
  const { db, cleanup } = tempDb();
  try {
    await db.migrate();
    await db.createUser({ id: 'u-a', displayName: 'A' });
    await db.createUser({ id: 'u-b', displayName: 'B' });

    // Alice 已經有一個很新的版本。
    await db.upsertSleeps('u-a', [sleepAt('2026-09-12T23:00:00.000Z', 11)], { timezone: TZ });
    // Bob 第一次收到同一個 external id 的**較舊**版本 —— 他自己沒有任何舊列，
    // 所以這是一個正常的新增，不可以被 Alice 的版本擋掉。
    const n = await db.upsertSleeps('u-b', [sleepAt('2026-09-12T10:00:00.000Z', 22)], { timezone: TZ });
    assert.equal(n, 1, '★ Alice 的版本絕不可以擋住 Bob 的寫入');
    assert.equal(Number((await storedRr(db, 'u-b')).respiratory_rate), 22);
    assert.equal(Number((await storedRr(db, 'u-a')).respiratory_rate), 11);
  } finally { cleanup(); }
});

test('★★★ M-03/5: recovery / cycle / workout 也套用同一條規則', async () => {
  const { db, cleanup } = tempDb();
  try {
    await db.migrate();
    const uid = 'u-m3e';
    await db.createUser({ id: uid, displayName: 'M3e' });

    const rec = (updatedAt, score) => ({
      sleep_id: 'sleep-1', cycle_id: 'c1', user_id: 1, score_state: 'SCORED',
      created_at: '2026-09-12T06:00:00.000Z', updated_at: updatedAt,
      score: { recovery_score: score },
    });
    await db.upsertRecoveries(uid, [rec('2026-09-12T10:05:00.000Z', 90)]);
    assert.equal(await db.upsertRecoveries(uid, [rec('2026-09-12T10:00:00.000Z', 10)]), 0);
    const r = await db.raw.execute({
      sql: 'SELECT recovery_score FROM whoop_recoveries WHERE user_id = ?', args: [uid],
    });
    assert.equal(Number(r.rows[0].recovery_score), 90, '★ recovery 也不可以被舊版本蓋掉');

    const cyc = (updatedAt, strain) => ({
      id: 'cyc-1', user_id: 1, score_state: 'SCORED',
      start: '2026-09-11T00:00:00.000Z', end: '2026-09-11T22:00:00.000Z',
      created_at: '2026-09-11T00:00:00.000Z', updated_at: updatedAt,
      score: { strain },
    });
    await db.upsertCycles(uid, [cyc('2026-09-12T10:05:00.000Z', 18)]);
    assert.equal(await db.upsertCycles(uid, [cyc('2026-09-12T10:00:00.000Z', 2)]), 0);
    const c = await db.raw.execute({
      sql: 'SELECT strain FROM whoop_cycles WHERE user_id = ?', args: [uid],
    });
    assert.equal(Number(c.rows[0].strain), 18, '★ cycle 也不可以被舊版本蓋掉');

    const wo = (updatedAt, strain) => ({
      id: 'w-1', user_id: 1, score_state: 'SCORED', sport_name: 'running',
      start: '2026-09-11T08:00:00.000Z', end: '2026-09-11T09:00:00.000Z',
      created_at: '2026-09-11T09:00:00.000Z', updated_at: updatedAt,
      score: { strain, zone_durations: {} },
    });
    await db.upsertWorkouts(uid, [wo('2026-09-12T10:05:00.000Z', 15)], { timezone: TZ });
    assert.equal(await db.upsertWorkouts(uid, [wo('2026-09-12T10:00:00.000Z', 1)], { timezone: TZ }), 0);
    const w = await db.raw.execute({
      sql: 'SELECT strain FROM whoop_workouts WHERE user_id = ?', args: [uid],
    });
    assert.equal(Number(w.rows[0].strain), 15, '★ workout 也不可以被舊版本蓋掉');
  } finally { cleanup(); }
});
