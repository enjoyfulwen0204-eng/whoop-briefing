/**
 * v3 → v4 migration（V1.1 Phase 8）。
 *
 * v4 只做一件事：**新增兩張全新的表**（system_heartbeats、prediction_models）。
 * 所以這個檔案要證明的不是「新表建起來了」（那很容易），而是
 * **既有 production 資料一列都沒有被動到**。
 *
 * 特別要證明：兩張新表都沒有被加進 RESHAPED_TABLES。那份清單會武裝
 * 「空表就 DROP 重建」的路徑；對一張在任何環境都是第一次出現的表來說，
 * 那條路徑永遠不該存在。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createDb } from '../src/db.js';
import {
  SCHEMA_VERSION, RESHAPED_TABLES, GUARDIAN_SCHEMA, PREDICTION_MODEL_SCHEMA,
} from '../src/schema.js';
import { runMigrations, inspectReshape } from '../src/migrations.js';
import { ALICE, BOB, seedAliceAndBob, seedHealthData } from './users.js';

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v11-mig4-'));
  return {
    url: `file:${path.join(dir, 't.db')}`,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

const tables = async (db) => (await db.raw.execute(
  "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
)).rows.map((r) => String(r.name));

const count = async (db, table) => Number(
  (await db.raw.execute(`SELECT COUNT(*) AS n FROM "${table}"`)).rows[0].n,
);

const version = async (db) => Number(
  (await db.raw.execute('SELECT MAX(version) AS v FROM schema_version')).rows[0].v,
);

// ---------------------------------------------------------------------------
// 版本與清單
// ---------------------------------------------------------------------------

test('SCHEMA_VERSION 是 5', () => {
  // v5 = telegram_processed_updates 的狀態機欄位（R3-M-05，純加欄位）。
  assert.equal(SCHEMA_VERSION, 5);
});

test('★★ 兩張新表都不在 RESHAPED_TABLES 裡（不可武裝 DROP 路徑）', () => {
  const names = RESHAPED_TABLES.map((r) => r.table);
  assert.ok(!names.includes('system_heartbeats'));
  assert.ok(!names.includes('prediction_models'));
});

test('★ v4 的 DDL 全部是 IF NOT EXISTS，沒有 DROP / ALTER / RENAME', () => {
  for (const stmt of [...GUARDIAN_SCHEMA, ...PREDICTION_MODEL_SCHEMA]) {
    assert.match(stmt, /IF NOT EXISTS/i, `必須是 additive：${stmt.slice(0, 60)}`);
    assert.ok(!/\bDROP\b/i.test(stmt), '不可以有 DROP');
    assert.ok(!/\bALTER\b/i.test(stmt), '不可以有 ALTER');
    assert.ok(!/\bRENAME\b/i.test(stmt), '不可以有 RENAME');
  }
});

// ---------------------------------------------------------------------------
// CASE 1：全新 DB
// ---------------------------------------------------------------------------

test('全新 DB → v4，兩張新表都在', async () => {
  const { url, cleanup } = tempDir();
  try {
    const db = createDb({ url });
    await db.migrate();
    const t = await tables(db);
    assert.ok(t.includes('system_heartbeats'));
    assert.ok(t.includes('prediction_models'));
    assert.equal(await version(db), SCHEMA_VERSION);
    db.close();
  } finally { cleanup(); }
});

test('全新 DB 連跑三次 migrate 是冪等的', async () => {
  const { url, cleanup } = tempDir();
  try {
    const db = createDb({ url });
    await db.migrate();
    const before = await tables(db);
    await db.migrate();
    await db.migrate();
    assert.deepEqual(await tables(db), before);
    assert.equal(await version(db), SCHEMA_VERSION);
    db.close();
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------
// ★★★ CASE 2：v3 + 真實資料 → v4，一列都不能少
// ---------------------------------------------------------------------------

test('★★★ v3 帶著代表性資料升到 v4：所有既有資料完整保留', async () => {
  const { url, cleanup } = tempDir();
  try {
    // ---- 先建一個「v3 狀態」的資料庫並塞滿代表性資料 ----
    const db = createDb({ url });
    await db.migrate();

    // 假裝它還停在 v3
    await db.raw.execute('DELETE FROM schema_version');
    await db.raw.execute({
      sql: 'INSERT INTO schema_version (version, applied_at, note) VALUES (3, ?, ?)',
      args: [new Date().toISOString(), 'pretend v3'],
    });
    // 把 v4 的兩張表拿掉，模擬真正的 v3 現場
    await db.raw.execute('DROP TABLE IF EXISTS system_heartbeats');
    await db.raw.execute('DROP TABLE IF EXISTS prediction_models');

    await seedAliceAndBob(db);
    await seedHealthData(db, ALICE, 11);
    await seedHealthData(db, BOB, 22);

    await db.addJournalEvent(ALICE.id, {
      eventAt: '2026-09-07T10:00:00Z', healthDate: '2026-09-07',
      category: 'alcohol', numericValue: 2, source: 'manual',
    });
    await db.recordRun({
      userId: ALICE.id, reportType: 'daily', localDateKey: '2026-09-07',
      healthDate: '2026-09-07', status: 'SENT', detail: null,
    });
    await db.savePrediction(ALICE.id, {
      targetDate: '2026-09-08', targetMetric: 'recovery', modelVersion: 'linear-v0',
      status: 'OK', features: { hrv: 55 }, predictedValue: 60,
      predictedLow: 55, predictedHigh: 65, nTrain: 30,
    });
    await db.claimProactiveEvent(ALICE.id, {
      healthDate: '2026-09-07', idempotencyKey: 'kk',
      signals: [{ code: 'HRV_LOW' }], decision: 'ASK_CONTEXT',
      reason: {}, policyVersion: 'p1', messageText: 'q',
    });
    await db.setProactiveState(ALICE.id, {
      lastCheckedHealthDate: '2026-09-07', lastFingerprint: 'fp',
    });
    await db.saveHealthspanSnapshot(ALICE.id, {
      snapshotDate: '2026-09-07', algorithmVersion: 'foundation-v0',
      score: null, scoreKind: null, contributors: [], coverage: 0, status: 'FOUNDATION_ONLY',
    });

    // ---- 拍一張「升級前」的快照 ----
    const watched = [
      'users', 'user_telegram', 'user_whoop_tokens', 'whoop_sleeps', 'whoop_recoveries',
      'whoop_cycles', 'whoop_workouts', 'whoop_body_measurements', 'journal_events',
      'report_runs', 'prediction_runs', 'proactive_events', 'proactive_agent_state',
      'healthspan_snapshots',
    ];
    const before = {};
    for (const t of watched) before[t] = await count(db, t);
    const aliceBefore = await db.coverage(ALICE.id);
    const bobBefore = await db.coverage(BOB.id);
    const predBefore = await db.getPredictions(ALICE.id, {});
    const journalBefore = await db.getJournalEvents(ALICE.id, { from: '2026-01-01', to: '2026-12-31' });
    db.close();

    // ---- 升級 ----
    const up = createDb({ url });
    const summary = await runMigrations(up.raw);

    assert.equal(summary.from, 3);
    assert.equal(summary.to, SCHEMA_VERSION);
    assert.deepEqual(summary.rebuilt, [], '★ v4 不可以重建任何表');

    // ---- 逐一比對：一列都不能少 ----
    for (const t of watched) {
      assert.equal(await count(up, t), before[t], `${t} 的列數不可以改變`);
    }
    assert.deepEqual(await up.coverage(ALICE.id), aliceBefore);
    assert.deepEqual(await up.coverage(BOB.id), bobBefore);
    assert.equal((await up.getPredictions(ALICE.id, {})).length, predBefore.length);
    assert.equal(
      (await up.getJournalEvents(ALICE.id, { from: '2026-01-01', to: '2026-12-31' })).length,
      journalBefore.length,
    );

    // 身分完全保留
    assert.equal((await up.getUser(ALICE.id)).displayName, 'Alice');
    assert.equal((await up.getUser(BOB.id)).displayName, 'Bob');
    assert.equal((await up.resolveUserByChatId(ALICE.chatId)).user.id, ALICE.id);

    // 主動代理狀態保留
    const st = await up.getProactiveState(ALICE.id);
    assert.equal(st.lastCheckedHealthDate, '2026-09-07');
    assert.equal(st.lastFingerprint, 'fp');

    // 新表已經在，而且是空的
    const t2 = await tables(up);
    assert.ok(t2.includes('system_heartbeats'));
    assert.ok(t2.includes('prediction_models'));
    assert.equal(await count(up, 'system_heartbeats'), 0);
    assert.equal(await count(up, 'prediction_models'), 0);
    assert.equal(await version(up), SCHEMA_VERSION);
    up.close();
  } finally { cleanup(); }
});

test('★ v3 → v4 之後再跑一次 migrate 仍然冪等，資料不變', async () => {
  const { url, cleanup } = tempDir();
  try {
    const db = createDb({ url });
    await db.migrate();
    await seedAliceAndBob(db);
    await seedHealthData(db, ALICE, 11);
    const before = await db.coverage(ALICE.id);

    await db.migrate();
    await db.migrate();

    assert.deepEqual(await db.coverage(ALICE.id), before);
    assert.equal(await version(db), SCHEMA_VERSION);
    db.close();
  } finally { cleanup(); }
});

test('★ v4 不會讓任何既有表進入「需要重建」的狀態', async () => {
  const { url, cleanup } = tempDir();
  try {
    const db = createDb({ url });
    await db.migrate();
    await seedAliceAndBob(db);
    await seedHealthData(db, ALICE, 11);

    const insp = await inspectReshape(db.raw);
    assert.deepEqual(insp.rebuild, [], '不該有任何表需要重建');
    assert.deepEqual(insp.blocked, [], '不該有任何表被擋住');
    db.close();
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------
// 新表的形狀與約束
// ---------------------------------------------------------------------------

test('★★ system_heartbeats 的 (scope, component) 是真的唯一（NULL 陷阱測試）', async () => {
  const { url, cleanup } = tempDir();
  try {
    const db = createDb({ url });
    await db.migrate();

    const ins = (scope, component) => db.raw.execute({
      sql: `INSERT INTO system_heartbeats (scope, component, last_ok_at, updated_at)
            VALUES (?,?,?,?)`,
      args: [scope, component, '2026-09-09T00:00:00Z', '2026-09-09T00:00:00Z'],
    });

    await ins('global', 'cron');
    await assert.rejects(() => ins('global', 'cron'), /UNIQUE/i, '同一組不可以插兩次');

    // 不同 scope / 不同 component 可以共存
    await ins('user:u-alice', 'cron');
    await ins('global', 'worker');
    assert.equal(await count(db, 'system_heartbeats'), 3);
    db.close();
  } finally { cleanup(); }
});

test('★★ prediction_models 的冪等鍵真的唯一，且 qualified 預設是 0', async () => {
  const { url, cleanup } = tempDir();
  try {
    const db = createDb({ url });
    await db.migrate();

    const ins = (userId, trainEnd) => db.raw.execute({
      sql: `INSERT INTO prediction_models
              (user_id, target_metric, model_version, trained_at, train_end, maturity, created_at)
            VALUES (?,?,?,?,?,?,?)`,
      args: [userId, 'recovery', 'linear-v0', '2026-09-09T00:00:00Z', trainEnd,
        'EVALUATED_UNQUALIFIED', '2026-09-09T00:00:00Z'],
    });

    await ins('u-alice', '2026-09-08');
    await assert.rejects(() => ins('u-alice', '2026-09-08'), /UNIQUE/i);

    // 不同使用者、同樣的一切 → 必須共存
    await ins('u-bob', '2026-09-08');
    // 同一個使用者、不同訓練區間 → 也共存
    await ins('u-alice', '2026-09-09');
    assert.equal(await count(db, 'prediction_models'), 3);

    const rs = await db.raw.execute('SELECT qualified FROM prediction_models LIMIT 1');
    assert.equal(Number(rs.rows[0].qualified), 0, '★ 預設一律不合格');
    db.close();
  } finally { cleanup(); }
});

test('★ prediction_models 與 prediction_runs 是兩張獨立的表', async () => {
  const { url, cleanup } = tempDir();
  try {
    const db = createDb({ url });
    await db.migrate();
    const t = await tables(db);
    assert.ok(t.includes('prediction_runs'));
    assert.ok(t.includes('prediction_models'));

    // prediction_runs 的形狀完全沒被改動（沒有偷加欄位）
    const cols = (await db.raw.execute('PRAGMA table_info("prediction_runs")'))
      .rows.map((r) => String(r.name));
    assert.deepEqual(cols, [
      'id', 'user_id', 'target_date', 'target_metric', 'model_version', 'status',
      'features_json', 'predicted_value', 'predicted_low', 'predicted_high',
      'n_train', 'created_at', 'actual_value', 'error', 'evaluated_at',
    ], 'prediction_runs 的形狀在 v4 完全沒被動過');

    // 模型層的統計絕不可以被偷偷塞進 run 層
    for (const c of ['mae', 'rmse', 'r2', 'qualified', 'maturity', 'baseline_mae']) {
      assert.ok(!cols.includes(c), `${c} 屬於 prediction_models，不該出現在 prediction_runs`);
    }
    db.close();
  } finally { cleanup(); }
});
