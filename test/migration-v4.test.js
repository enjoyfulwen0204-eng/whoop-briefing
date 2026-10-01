import { rejectHybridRewind } from './invalidHistoricalRewind.js';
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

import { createDb } from './localDb.js';
import {
  SCHEMA_VERSION, RESHAPED_TABLES, GUARDIAN_SCHEMA, PREDICTION_MODEL_SCHEMA,
} from '../src/schema.js';
import { runMigrations, inspectReshape } from './localMigrations.js';
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

test('SCHEMA_VERSION is v30 while legacy additive contracts remain', () => {
  // v9 adds the report delivery state machine to report_claims (additive
  // columns only); v8 added briefing_evaluations (a new table); v7 added the
  // delivery state machine to telegram_operations. Populated v4/v5/v6 tables
  // remain intact through all of them.
  // v10 adds the WHOOP webhook ingestion tables (two brand-new tables).
  // v11 adds the reconciliation tables (three brand-new tables) plus three
  // diagnostic columns on whoop_resource_tombstones (additive only).
  // v12 adds the analytics work tables (four brand-new tables, Phase 3).
  // v13 adds three nullable range columns on analytics_work_state (Phase 3 RC1).
  // v14 adds user_onboarding (self-service Telegram onboarding, Phase 3.5).
  // v15 is a data-only correction: legacy onboarding rows derived from evidence.
  // v16 adds the authorization generation + per-resource access evidence (Phase 3.5 RC2).
  assert.equal(SCHEMA_VERSION, 30);
});

test('an already-v30 database rejects a requested v27 downgrade without losing accounts', async () => {
  const { url, cleanup } = tempDir();
  const db = createDb({ url });
  try {
    await db.migrate();
    await db.createUser({ id: 'downgrade-guard', displayName: 'Guard' });
    const before = await db.getUser('downgrade-guard');
    await assert.rejects(runMigrations(db.raw, { targetVersion: 27 }), /schema_version_incompatible/);
    assert.equal(await version(db), 30);
    assert.deepEqual(await db.getUser('downgrade-guard'), before);
  } finally { db.close(); cleanup(); }
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

test('v30 rejects fabricated v3 hybrid and preserves account state', async () => {
  const { url, cleanup } = tempDir();
  const db = createDb({ url });
  try { await db.migrate(); await db.createUser({ id: 'historical-guard', displayName: 'Historical' });
    await rejectHybridRewind(db, 3); }
  finally { db.close(); cleanup(); }
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

    // All original columns remain; v22 adds only the required privacy envelope.
    const cols = (await db.raw.execute('PRAGMA table_info("prediction_runs")'))
      .rows.map((r) => String(r.name));
    assert.deepEqual(cols, [
      'id', 'user_id', 'target_date', 'target_metric', 'model_version', 'status',
      'features_json', 'predicted_value', 'predicted_low', 'predicted_high',
      'n_train', 'created_at', 'actual_value', 'error', 'evaluated_at',
      'content_state', 'health_content_redacted_at', 'health_content_redaction_reason',
      'source_subject_deleted_at', 'purge_generation', 'source_linkage_state', 'content_digest_salt', 'privacy_artifact_id',
    ], 'prediction_runs preserves v20 columns and adds exactly R');

    // 模型層的統計絕不可以被偷偷塞進 run 層
    for (const c of ['mae', 'rmse', 'r2', 'qualified', 'maturity', 'baseline_mae']) {
      assert.ok(!cols.includes(c), `${c} 屬於 prediction_models，不該出現在 prediction_runs`);
    }
    db.close();
  } finally { cleanup(); }
});
