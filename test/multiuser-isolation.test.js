/**
 * Multi-user 隔離套件（STEP 2 / 18–21）。
 *
 * Alice 與 Bob 刻意使用**完全相同的 external id、health_date、UTC 時間戳、
 * experiment 名稱、prediction target、healthspan snapshot 版本**，只有數值不同。
 *
 * 每一條隔離保證都雙向驗證：Alice 讀不到 Bob，Bob 也讀不到 Alice。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createDb } from '../src/db.js';
import { MissingUserIdError } from '../src/userContext.js';
import { ALICE, BOB, SHARED, seedAliceAndBob, seedHealthData } from './users.js';

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mu-iso-'));
  const db = createDb({ url: `file:${path.join(dir, 't.db')}` });
  return { db, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/** 建好兩人 + 各自一套（相同 id、不同值）健康資料。 */
async function withAliceBob(fn, { alice = 11, bob = 22 } = {}) {
  const { db, cleanup } = tempDb();
  try {
    await db.migrate();
    await seedAliceAndBob(db);
    await seedHealthData(db, ALICE, alice);
    await seedHealthData(db, BOB, bob);
    await fn(db);
  } finally {
    db.close();
    cleanup();
  }
}

const RANGE = { from: '2026-01-01', to: '2026-12-31' };
const ISO_RANGE = { fromIso: '2026-01-01T00:00:00Z', toIso: '2026-12-31T00:00:00Z' };

// ---------------------------------------------------------------------------
// 相同 external id 共存
// ---------------------------------------------------------------------------
test('相同的 WHOOP external id 在兩個使用者之間可以共存', async () => {
  await withAliceBob(async (db) => {
    for (const [table, col] of [
      ['whoop_sleeps', 'id'], ['whoop_recoveries', 'sleep_id'],
      ['whoop_cycles', 'id'], ['whoop_workouts', 'id'],
      ['whoop_body_measurements', 'recorded_at'],
    ]) {
      const rs = await db.raw.execute(`SELECT user_id, ${col} FROM ${table} ORDER BY user_id`);
      assert.equal(rs.rows.length, 2, `${table} 應該兩個使用者各一列`);
      assert.deepEqual(rs.rows.map((r) => String(r.user_id)), [ALICE.id, BOB.id]);
      // 同一個邏輯 id 出現兩次，只有 user_id 不同
      assert.equal(String(rs.rows[0][col]), String(rs.rows[1][col]), `${table} 的 external id 應該相同`);
    }
  });
});

// ---------------------------------------------------------------------------
// 健康資料
// ---------------------------------------------------------------------------
test('健康資料雙向隔離：sleeps / recoveries / cycles / workouts / body', async () => {
  await withAliceBob(async (db) => {
    const aS = await db.getSleeps(ALICE.id, RANGE);
    const bS = await db.getSleeps(BOB.id, RANGE);
    assert.equal(aS.length, 1); assert.equal(bS.length, 1);
    assert.equal(aS[0].respiratory_rate, 11);
    assert.equal(bS[0].respiratory_rate, 22);

    const aR = await db.getRecoveries(ALICE.id, RANGE);
    const bR = await db.getRecoveries(BOB.id, RANGE);
    assert.equal(aR[0].recovery_score, 11);
    assert.equal(bR[0].recovery_score, 22);

    const aC = await db.getCycles(ALICE.id, ISO_RANGE);
    const bC = await db.getCycles(BOB.id, ISO_RANGE);
    assert.equal(aC[0].strain, 11);
    assert.equal(bC[0].strain, 22);

    const aW = await db.getWorkouts(ALICE.id, ISO_RANGE);
    const bW = await db.getWorkouts(BOB.id, ISO_RANGE);
    assert.equal(aW[0].strain, 11);
    assert.equal(bW[0].strain, 22);

    assert.equal((await db.getLatestBodyMeasurement(ALICE.id)).weight_kilogram, 11);
    assert.equal((await db.getLatestBodyMeasurement(BOB.id)).weight_kilogram, 22);
  });
});

test('改動 Bob 的資料完全不影響 Alice 讀到的東西（analytics 輸入隔離）', async () => {
  await withAliceBob(async (db) => {
    const before = await db.getSleeps(ALICE.id, RANGE);
    // 把 Bob 的值整組換掉
    await seedHealthData(db, BOB, 99);
    const after = await db.getSleeps(ALICE.id, RANGE);
    assert.deepEqual(
      after.map((r) => r.respiratory_rate), before.map((r) => r.respiratory_rate),
      'Bob 的資料變動不可影響 Alice',
    );
    // 反向
    const bBefore = await db.getSleeps(BOB.id, RANGE);
    await seedHealthData(db, ALICE, 77);
    assert.deepEqual(
      (await db.getSleeps(BOB.id, RANGE)).map((r) => r.respiratory_rate),
      bBefore.map((r) => r.respiratory_rate),
      'Alice 的資料變動不可影響 Bob',
    );
  });
});

// ---------------------------------------------------------------------------
// per-user 時區
// ---------------------------------------------------------------------------
test('同一個 UTC 時間戳依各自時區落在不同的 health_date', async () => {
  await withAliceBob(async (db) => {
    const a = (await db.getSleeps(ALICE.id, RANGE))[0];
    const b = (await db.getSleeps(BOB.id, RANGE))[0];
    assert.equal(a.end_at, b.end_at, '同一個 UTC 時間戳');
    assert.equal(a.health_date, '2026-09-07', 'Asia/Taipei');
    assert.equal(b.health_date, '2026-09-06', 'America/New_York');
    assert.notEqual(a.health_date, b.health_date);
  });
});

// ---------------------------------------------------------------------------
// capability / readiness
// ---------------------------------------------------------------------------
test('coverage / capability：Alice 有資料不會讓 Bob 變成 READY', async () => {
  const { db, cleanup } = tempDb();
  try {
    await db.migrate();
    // 這一題要驗「Bob 的 capability 必須是空的」，所以刻意不 probe
    await seedAliceAndBob(db, { probed: false });
    await seedHealthData(db, ALICE, 11);           // 只有 Alice 有資料

    const aCov = await db.coverage(ALICE.id);
    const bCov = await db.coverage(BOB.id);
    assert.equal(Number(aCov.main_sleeps), 1);
    assert.equal(Number(bCov.main_sleeps), 0, 'Bob 必須是 0，不可因 Alice 有資料而有值');
    assert.equal(Number(bCov.cycles), 0);
    assert.equal(bCov.first_date, null);

    await db.saveCapabilities(ALICE.id, [{ key: 'spo2', status: 'AVAILABLE', nonNullCount: 5 }]);
    assert.equal((await db.getCapabilities(ALICE.id)).spo2.status, 'AVAILABLE');
    assert.deepEqual(await db.getCapabilities(BOB.id), {}, 'Bob 的 capability 必須是空的');
  } finally { db.close(); cleanup(); }
});

test('sync state 隔離', async () => {
  await withAliceBob(async (db) => {
    await db.saveSyncState(ALICE.id, 'sleep', { latestSynced: 'A' });
    await db.saveSyncState(BOB.id, 'sleep', { latestSynced: 'B' });
    assert.equal((await db.getSyncState(ALICE.id, 'sleep')).latestSynced, 'A');
    assert.equal((await db.getSyncState(BOB.id, 'sleep')).latestSynced, 'B');
    assert.equal((await db.getAllSyncState(ALICE.id)).length, 1);
  });
});

// ---------------------------------------------------------------------------
// journal
// ---------------------------------------------------------------------------
test('journal 隔離：同一 health_date、不同事件，各自看不到對方', async () => {
  await withAliceBob(async (db) => {
    await db.addJournalEvent(ALICE.id, {
      eventAt: SHARED.sleepEnd, healthDate: SHARED.healthDate,
      category: 'alcohol', numericValue: 2, source: 'manual',
    });
    await db.addJournalEvent(BOB.id, {
      eventAt: SHARED.sleepEnd, healthDate: SHARED.healthDate,
      category: 'sauna', numericValue: 1, source: 'manual',
    });

    const aEvents = await db.getJournalEvents(ALICE.id, RANGE);
    const bEvents = await db.getJournalEvents(BOB.id, RANGE);
    assert.deepEqual(aEvents.map((e) => e.category), ['alcohol']);
    assert.deepEqual(bEvents.map((e) => e.category), ['sauna']);
    assert.ok(!aEvents.some((e) => e.category === 'sauna'), 'Alice 不可看到 sauna');
    assert.ok(!bEvents.some((e) => e.category === 'alcohol'), 'Bob 不可看到 alcohol');
    assert.equal(await db.countJournalEvents(ALICE.id), 1);
    assert.equal(await db.countJournalEvents(BOB.id), 1);
  });
});

test('journal 越權刪除：帶別人的 event id 一律刪不到', async () => {
  await withAliceBob(async (db) => {
    const aliceId = await db.addJournalEvent(ALICE.id, {
      eventAt: SHARED.sleepEnd, healthDate: SHARED.healthDate,
      category: 'alcohol', source: 'manual',
    });
    const deleted = await db.deleteJournalEvent(BOB.id, aliceId);
    assert.equal(deleted, false, 'Bob 不可刪掉 Alice 的 journal');
    assert.equal(await db.countJournalEvents(ALICE.id), 1, 'Alice 的資料必須還在');
  });
});

// ---------------------------------------------------------------------------
// pending question / 對話
// ---------------------------------------------------------------------------
test('pending question 隔離：Bob 的回覆不可解掉 Alice 的追問', async () => {
  await withAliceBob(async (db) => {
    const aliceQ = await db.openPendingQuestion(ALICE.id, {
      chatId: ALICE.chatId, question: '昨天有喝酒嗎？', ttlMs: 30 * 60_000,
    });

    // Bob 那邊看不到任何 pending
    assert.equal(await db.getOpenPendingQuestion(BOB.id), null);

    // Bob 拿 Alice 的 question id 也解不掉
    assert.equal(await db.resolvePendingQuestion(BOB.id, aliceQ, '有'), false);
    const still = await db.getOpenPendingQuestion(ALICE.id);
    assert.ok(still, 'Alice 的追問必須還開著');
    assert.equal(still.id, aliceQ);

    // Alice 自己可以解
    assert.equal(await db.resolvePendingQuestion(ALICE.id, aliceQ, '有'), true);
    assert.equal(await db.getOpenPendingQuestion(ALICE.id), null);
  });
});

test('pending question：一個使用者同時只有一個 OPEN，且不影響另一人', async () => {
  await withAliceBob(async (db) => {
    await db.openPendingQuestion(ALICE.id, { chatId: ALICE.chatId, question: 'Q1', ttlMs: 60_000 });
    await db.openPendingQuestion(BOB.id, { chatId: BOB.chatId, question: 'B1', ttlMs: 60_000 });
    const a2 = await db.openPendingQuestion(ALICE.id, { chatId: ALICE.chatId, question: 'Q2', ttlMs: 60_000 });

    assert.equal((await db.getOpenPendingQuestion(ALICE.id)).id, a2, 'Alice 只留最新那個');
    assert.equal((await db.getOpenPendingQuestion(BOB.id)).question, 'B1', 'Bob 的不受影響');
  });
});

// ---------------------------------------------------------------------------
// 報告去重 / claim
// ---------------------------------------------------------------------------
test('報告去重：同一個 local_date 兩人各自獨立發送', async () => {
  await withAliceBob(async (db) => {
    const d = SHARED.healthDate;
    assert.equal(await db.recordRun({
      userId: ALICE.id, reportType: 'daily', localDateKey: d, status: 'SENT',
    }), true);
    assert.equal(await db.recordRun({
      userId: BOB.id, reportType: 'daily', localDateKey: d, status: 'SENT',
    }), true, 'Bob 同一天也要能發');

    assert.equal(await db.isSent(ALICE.id, 'daily', d), true);
    assert.equal(await db.isSent(BOB.id, 'daily', d), true);

    // 同一人重複 SENT 被唯一索引擋
    assert.equal(await db.recordRun({
      userId: ALICE.id, reportType: 'daily', localDateKey: d, status: 'SENT',
    }), false);

    // recentRuns 只回自己的
    assert.equal((await db.recentRuns(ALICE.id)).length, 1);
    assert.equal((await db.recentRuns(BOB.id)).length, 1);
  });
});

test('report claim：Alice 的 claim 不會阻塞 Bob', async () => {
  await withAliceBob(async (db) => {
    const key = { reportType: 'daily', localDateKey: SHARED.healthDate, ttlMs: 60_000 };
    const a = await db.claimReport({ userId: ALICE.id, ...key });
    const b = await db.claimReport({ userId: BOB.id, ...key });
    assert.equal(a.granted, true);
    assert.equal(b.granted, true, 'Bob 必須也拿得到自己的發送權');

    // 同一人重複 claim 被拒
    assert.equal((await db.claimReport({ userId: ALICE.id, ...key })).granted, false);

    // 標記已送出後永遠不再授權
    assert.equal(await db.markClaimSent({
      userId: ALICE.id, reportType: 'daily', localDateKey: SHARED.healthDate, owner: a.owner,
    }), true);
    // Bob 用 Alice 的 owner 標記不了
    assert.equal(await db.markClaimSent({
      userId: BOB.id, reportType: 'daily', localDateKey: SHARED.healthDate, owner: a.owner,
    }), false);
  });
});

// ---------------------------------------------------------------------------
// 錯誤通知冷卻
// ---------------------------------------------------------------------------
test('錯誤通知冷卻：Alice 的 WHOOP 錯誤不壓抑 Bob 的同類通知', async () => {
  await withAliceBob(async (db) => {
    assert.equal(await db.claimUserErrorNotify(ALICE.id, 'whoop_auth', 2), true);
    assert.equal(await db.claimUserErrorNotify(ALICE.id, 'whoop_auth', 2), false, 'Alice 冷卻中');
    assert.equal(await db.claimUserErrorNotify(BOB.id, 'whoop_auth', 2), true, 'Bob 不該被壓抑');
    // 系統層與使用者層互不干擾
    assert.equal(await db.claimGlobalErrorNotify('whoop_auth', 2), true);
  });
});

// ---------------------------------------------------------------------------
// prediction / insight / experiment / healthspan
// ---------------------------------------------------------------------------
test('prediction 隔離：相同 target/model 兩人各存一筆', async () => {
  await withAliceBob(async (db) => {
    const base = {
      targetDate: SHARED.predictionTarget, targetMetric: 'recovery',
      modelVersion: SHARED.modelVersion, status: 'PREDICTED',
    };
    await db.savePrediction(ALICE.id, { ...base, predictedValue: 60 });
    await db.savePrediction(BOB.id, { ...base, predictedValue: 80 });

    const a = await db.getPredictions(ALICE.id, {});
    const b = await db.getPredictions(BOB.id, {});
    assert.equal(a.length, 1); assert.equal(b.length, 1);
    assert.equal(a[0].predicted_value, 60);
    assert.equal(b[0].predicted_value, 80);
  });
});

test('insight 隔離：get / getActive / history 只回自己的', async () => {
  await withAliceBob(async (db) => {
    const aId = await db.createInsight(ALICE.id, {
      insightType: 'CORRELATION', subject: 'alcohol', statement: 'Alice 的結論',
      status: 'SUPPORTED', firstDetectedAt: '2026-09-01T00:00:00Z',
    });
    const bId = await db.createInsight(BOB.id, {
      insightType: 'CORRELATION', subject: 'alcohol', statement: 'Bob 的結論',
      status: 'SUPPORTED', firstDetectedAt: '2026-09-01T00:00:00Z',
    });

    assert.equal((await db.getInsight(ALICE.id, aId)).statement, 'Alice 的結論');
    assert.equal(await db.getInsight(ALICE.id, bId), null, 'Alice 不可讀到 Bob 的 insight');
    assert.equal(await db.getInsight(BOB.id, aId), null, 'Bob 不可讀到 Alice 的 insight');

    assert.deepEqual((await db.getActiveInsights(ALICE.id, {})).map((i) => i.statement), ['Alice 的結論']);
    assert.deepEqual((await db.getActiveInsights(BOB.id, {})).map((i) => i.statement), ['Bob 的結論']);
    assert.deepEqual(await db.getInsightHistory(BOB.id, aId), [], '拿別人的 id 查歷史要回空');
  });
});

test('experiment 隔離：相同名稱兩人各自存在', async () => {
  await withAliceBob(async (db) => {
    const aId = await db.createExperiment(ALICE.id, {
      name: SHARED.experimentName, targetMetrics: ['recovery'], status: 'DRAFT',
    });
    const bId = await db.createExperiment(BOB.id, {
      name: SHARED.experimentName, targetMetrics: ['hrv'], status: 'DRAFT',
    });
    assert.notEqual(aId, bId);
    assert.equal((await db.listExperiments(ALICE.id, {})).length, 1);
    assert.equal((await db.listExperiments(BOB.id, {})).length, 1);
    assert.equal(await db.getExperiment(ALICE.id, bId), null, 'Alice 不可讀到 Bob 的實驗');
    assert.equal(await db.updateExperiment(BOB.id, aId, { status: 'RUNNING' }), false,
      'Bob 不可改 Alice 的實驗');
  });
});

test('healthspan 隔離：相同 snapshot 日期/版本兩人各存一筆', async () => {
  await withAliceBob(async (db) => {
    for (const [u, v] of [[ALICE, 11], [BOB, 22]]) {
      await db.saveHealthspanMetrics(u.id, [{ metricKey: 'hrv', value: v, availability: 'AVAILABLE' }]);
      await db.saveHealthspanSnapshot(u.id, {
        snapshotDate: SHARED.snapshotDate, algorithmVersion: SHARED.algorithmVersion,
        score: null, status: 'FOUNDATION_ONLY',
      });
    }
    assert.equal((await db.getLatestHealthspanMetrics(ALICE.id))[0].value, 11);
    assert.equal((await db.getLatestHealthspanMetrics(BOB.id))[0].value, 22);
    assert.equal((await db.getHealthspanSnapshots(ALICE.id)).length, 1);
    assert.equal((await db.getHealthspanSnapshots(BOB.id)).length, 1);
  });
});

// ---------------------------------------------------------------------------
// AI usage / /cost
// ---------------------------------------------------------------------------
test('ai_usage 隔離：Alice 的成本不受 Bob 影響（雙向）', async () => {
  await withAliceBob(async (db) => {
    const entry = (cost) => ({
      timestamp: '2026-09-07T01:00:00Z', provider: 'openrouter', purpose: 'DAILY',
      requestStatus: 'OK', inputTokens: 100, outputTokens: 10, totalTokens: 110,
      estimatedCostUsd: cost,
    });
    await db.recordAiUsage(ALICE.id, entry(0.01));
    await db.recordAiUsage(BOB.id, entry(0.99));
    await db.recordAiUsage(BOB.id, entry(0.99));
    // 系統層用量（user_id = NULL）不屬於任何人
    await db.recordAiUsage(null, entry(0.5));

    const range = { fromIso: '2026-09-01T00:00:00Z', toIso: '2026-09-30T00:00:00Z' };
    assert.equal((await db.getAiUsage(ALICE.id, range)).length, 1);
    assert.equal((await db.getAiUsage(BOB.id, range)).length, 2);
    assert.equal(await db.countAiUsage(ALICE.id), 1);
    assert.equal(await db.countAiUsage(BOB.id), 2);
    // 系統層那筆不會出現在任何使用者的查詢裡
    const all = await db.raw.execute('SELECT COUNT(*) AS n FROM ai_usage WHERE user_id IS NULL');
    assert.equal(Number(all.rows[0].n), 1);
  });
});

// ---------------------------------------------------------------------------
// 缺 userId 一律大聲失敗
// ---------------------------------------------------------------------------
test('缺 userId 的 store 呼叫全部拋 MissingUserIdError（不會靜默查全部）', async () => {
  const { db, cleanup } = tempDb();
  try {
    await db.migrate();
    const calls = [
      ['getTokens', () => db.getTokens()],
      ['isSent', () => db.isSent(undefined, 'daily', '2026-09-07')],
      ['recentRuns', () => db.recentRuns()],
      ['getSleeps', () => db.getSleeps(null, RANGE)],
      ['getRecoveries', () => db.getRecoveries('', RANGE)],
      ['getCycles', () => db.getCycles(undefined, ISO_RANGE)],
      ['getWorkouts', () => db.getWorkouts(undefined, ISO_RANGE)],
      ['getLatestBodyMeasurement', () => db.getLatestBodyMeasurement()],
      ['coverage', () => db.coverage()],
      ['getCapabilities', () => db.getCapabilities()],
      ['getAllSyncState', () => db.getAllSyncState()],
      ['getJournalEvents', () => db.getJournalEvents(undefined, RANGE)],
      ['countJournalEvents', () => db.countJournalEvents()],
      ['getOpenPendingQuestion', () => db.getOpenPendingQuestion()],
      ['getPredictions', () => db.getPredictions()],
      ['getActiveInsights', () => db.getActiveInsights()],
      ['listExperiments', () => db.listExperiments()],
      ['getAiUsage', () => db.getAiUsage(undefined, {})],
      ['countAiUsage', () => db.countAiUsage()],
      ['getLatestHealthspanMetrics', () => db.getLatestHealthspanMetrics()],
      ['upsertSleeps', () => db.upsertSleeps(null, [])],
      ['claimReport', () => db.claimReport({ reportType: 'daily', localDateKey: 'x', ttlMs: 1 })],
    ];
    for (const [name, fn] of calls) {
      await assert.rejects(fn, MissingUserIdError, `${name} 缺 userId 應拋 MissingUserIdError`);
    }
  } finally { db.close(); cleanup(); }
});
