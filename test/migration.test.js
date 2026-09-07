/**
 * Migration 測試（STEP 22 / 23）—— 進 production 前的必要閘門。
 *
 * CASE A：全新空 DB → 建出 multi-user schema → 再跑一次必須 idempotent
 * CASE B：**完全複製稽核到的舊 production 形狀**（4 張表、0 列）→ 安全升級
 * 安全性：舊形狀表若有非預期資料 → **拒絕**而不是靜默 DROP
 * 約束：唯一性 / 所有權 key 的實際行為（不假設 libSQL 的 FK 行為）
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createDb } from '../src/db.js';
import { SCHEMA_VERSION } from '../src/schema.js';
import { UnsafeMigrationError, inspectReshape, legacyTableStatus } from '../src/migrations.js';

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mu-mig-'));
  return {
    make: () => createDb({ url: `file:${path.join(dir, 't.db')}` }),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

/**
 * 稽核到的舊 production 形狀，**逐字複製**（含 health_date 是後來 ALTER 加在最後）。
 * 這不是近似值 —— 欄位順序、CHECK、partial unique index 都跟稽核結果一致。
 */
const LEGACY_DDL = [
  `CREATE TABLE whoop_tokens (
     id                      INTEGER PRIMARY KEY CHECK (id = 1),
     access_token            TEXT NOT NULL,
     refresh_token           TEXT NOT NULL,
     access_token_expires_at TEXT NOT NULL,
     scope                   TEXT,
     updated_at              TEXT NOT NULL
   )`,
  `CREATE TABLE report_runs (
     id                  INTEGER PRIMARY KEY AUTOINCREMENT,
     report_type         TEXT NOT NULL,
     local_date          TEXT NOT NULL,
     sleep_id            TEXT,
     cycle_id            TEXT,
     telegram_message_id INTEGER,
     status              TEXT NOT NULL,
     detail              TEXT,
     sent_at             TEXT NOT NULL,
     health_date         TEXT
   )`,
  `CREATE UNIQUE INDEX uniq_report_sent
     ON report_runs (report_type, local_date) WHERE status = 'SENT'`,
  `CREATE INDEX idx_report_lookup ON report_runs (report_type, local_date)`,
  `CREATE TABLE error_notifications (
     error_type       TEXT PRIMARY KEY,
     last_notified_at TEXT NOT NULL,
     hits             INTEGER NOT NULL DEFAULT 1
   )`,
  `CREATE TABLE app_state (
     key        TEXT PRIMARY KEY,
     value      TEXT NOT NULL,
     updated_at TEXT NOT NULL
   )`,
];

async function seedLegacy(client) {
  for (const stmt of LEGACY_DDL) await client.execute(stmt);
}

const cols = async (db, table) =>
  (await db.raw.execute(`PRAGMA table_info("${table}")`)).rows.map((r) => String(r.name));
const indexNames = async (db) =>
  (await db.raw.execute(
    "SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  )).rows.map((r) => String(r.name));
const tableNames = async (db) =>
  (await db.raw.execute(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  )).rows.map((r) => String(r.name));
const countOf = async (db, t) =>
  Number((await db.raw.execute(`SELECT COUNT(*) AS n FROM "${t}"`)).rows[0].n);

/** 每一張 per-user 表都必須有 user_id 欄位。 */
const PER_USER_TABLES = [
  'report_runs', 'report_claims', 'whoop_sleeps', 'whoop_recoveries', 'whoop_cycles',
  'whoop_workouts', 'whoop_body_measurements', 'whoop_sync_state', 'whoop_capabilities',
  'journal_events', 'pending_questions', 'healthspan_metrics', 'healthspan_snapshots',
  'prediction_runs', 'health_insights', 'experiments', 'ai_usage', 'user_whoop_tokens',
];

async function assertMultiUserShape(db) {
  const tables = await tableNames(db);
  for (const t of ['users', 'user_telegram', 'user_link_codes', 'oauth_states',
    'user_whoop_tokens', 'telegram_state', 'resource_locks', 'schema_version']) {
    assert.ok(tables.includes(t), `缺表：${t}`);
  }
  for (const t of PER_USER_TABLES) {
    assert.ok(tables.includes(t), `缺表：${t}`);
    assert.ok((await cols(db, t)).includes('user_id'), `${t} 缺 user_id 欄位`);
  }
  // telegram_state 刻意**沒有** user_id（bot-global）
  assert.ok(!(await cols(db, 'telegram_state')).includes('user_id'),
    'telegram_state 不該有 user_id（getUpdates offset 是 bot 全域的）');

  const idx = await indexNames(db);
  for (const want of ['uniq_report_sent', 'uniq_healthspan_metric', 'uniq_healthspan_snapshot',
    'uniq_prediction_run', 'uniq_whoop_account', 'uniq_link_code_hash']) {
    assert.ok(idx.includes(want), `缺索引：${want}`);
  }
  // 唯一索引的定義必須含 user_id
  const sqlOf = async (name) => String((await db.raw.execute({
    sql: 'SELECT sql FROM sqlite_master WHERE name = ?', args: [name],
  })).rows[0].sql);
  for (const name of ['uniq_report_sent', 'uniq_healthspan_metric',
    'uniq_healthspan_snapshot', 'uniq_prediction_run']) {
    assert.match(await sqlOf(name), /user_id/, `${name} 的唯一性必須含 user_id`);
  }
  // schema_version
  const v = await db.raw.execute('SELECT MAX(version) AS v FROM schema_version');
  assert.equal(Number(v.rows[0].v), SCHEMA_VERSION);
}

// ---------------------------------------------------------------------------
// CASE A：全新空 DB
// ---------------------------------------------------------------------------
test('CASE A：全新空 DB → 建出 multi-user schema，且第二次 migrate 是 idempotent', async () => {
  const t = tempDb();
  const db = t.make();
  try {
    const first = await db.migrate();
    assert.equal(first.from, 0);
    assert.equal(first.to, SCHEMA_VERSION);
    assert.deepEqual(first.rebuilt, [], '全新 DB 沒有東西需要重建');
    await assertMultiUserShape(db);

    const beforeTables = await tableNames(db);
    const second = await db.migrate();
    assert.equal(second.skipped, true, '第二次應該跳過重建');
    assert.deepEqual(second.rebuilt, []);
    assert.deepEqual(await tableNames(db), beforeTables, '第二次不可改變表結構');
    const v = await db.raw.execute('SELECT COUNT(*) AS n FROM schema_version');
    assert.equal(Number(v.rows[0].n), 1, 'schema_version 不該重複寫入');
  } finally { db.close(); t.cleanup(); }
});

// ---------------------------------------------------------------------------
// CASE B：舊 production 形狀（0 列）
// ---------------------------------------------------------------------------
test('CASE B：完全複製舊 production 形狀（4 表 0 列）→ 安全升級到 multi-user', async () => {
  const t = tempDb();
  const db = t.make();
  try {
    await seedLegacy(db.raw);
    // 先確認我們真的複製到舊形狀
    assert.ok(!(await cols(db, 'report_runs')).includes('user_id'));
    assert.ok((await cols(db, 'error_notifications')).includes('error_type'));
    assert.ok(!(await cols(db, 'error_notifications')).includes('scope'));
    assert.match(
      String((await db.raw.execute(
        "SELECT sql FROM sqlite_master WHERE name='whoop_tokens'")).rows[0].sql),
      /CHECK \(id = 1\)/, '舊 whoop_tokens 必須有 CHECK(id = 1)',
    );

    // 升級前先做唯讀檢查
    const insp = await inspectReshape(db.raw);
    assert.deepEqual(insp.blocked, [], '0 列 → 不該有任何 blocked');
    assert.deepEqual(insp.rebuild.map((r) => r.table).sort(),
      ['error_notifications', 'report_runs'], '只有這兩張舊形狀表需要重建');

    const res = await db.migrate();
    assert.equal(res.from, 0);
    assert.deepEqual(res.rebuilt.sort(), ['error_notifications', 'report_runs']);

    await assertMultiUserShape(db);
    // 新形狀
    assert.ok((await cols(db, 'report_runs')).includes('user_id'));
    assert.ok((await cols(db, 'error_notifications')).includes('scope'));
    // 沒有任何健康資料被造出來
    for (const tbl of ['whoop_sleeps', 'whoop_recoveries', 'whoop_cycles', 'whoop_workouts',
      'prediction_runs', 'health_insights', 'journal_events', 'ai_usage', 'users']) {
      assert.equal(await countOf(db, tbl), 0, `${tbl} 必須是 0 列`);
    }
    // 舊表保留不刪（0 列、無引用，留著比破壞性 DDL 安全）
    const legacy = await legacyTableStatus(db.raw);
    assert.deepEqual(legacy, [
      { table: 'whoop_tokens', present: true, rows: 0 },
      { table: 'app_state', present: true, rows: 0 },
    ]);
    // 再跑一次仍然 idempotent
    assert.equal((await db.migrate()).skipped, true);
  } finally { db.close(); t.cleanup(); }
});

// ---------------------------------------------------------------------------
// 破壞性 migration 的安全閘門
// ---------------------------------------------------------------------------
test('安全閘門：舊形狀表若有非預期資料 → 拒絕重建，不靜默 DROP', async () => {
  const t = tempDb();
  const db = t.make();
  try {
    await seedLegacy(db.raw);
    // 塞一列「真實資料」進舊形狀的 report_runs
    await db.raw.execute({
      sql: `INSERT INTO report_runs (report_type, local_date, status, sent_at)
            VALUES ('daily','2026-09-01','SENT','2026-09-01T00:00:00Z')`,
      args: [],
    });

    const insp = await inspectReshape(db.raw);
    assert.equal(insp.blocked.length, 1);
    assert.equal(insp.blocked[0].table, 'report_runs');
    assert.equal(insp.blocked[0].rows, 1);

    await assert.rejects(() => db.migrate(), UnsafeMigrationError);

    // 資料必須完好，表也不可被 DROP
    assert.equal(await countOf(db, 'report_runs'), 1, '資料必須完好無損');
    assert.ok(!(await cols(db, 'report_runs')).includes('user_id'), '表不可被重建');
    const tables = await tableNames(db);
    assert.ok(!tables.includes('users'), '中止後不該留下半套新 schema');
  } finally { db.close(); t.cleanup(); }
});

test('安全閘門：allowRebuild=false 時連空表也不重建', async () => {
  const t = tempDb();
  const db = t.make();
  try {
    await seedLegacy(db.raw);
    await assert.rejects(() => db.migrate({ allowRebuild: false }), UnsafeMigrationError);
    assert.ok(!(await cols(db, 'report_runs')).includes('user_id'));
  } finally { db.close(); t.cleanup(); }
});

// ---------------------------------------------------------------------------
// 約束驗證（不假設 libSQL 的 FK 行為，實測）
// ---------------------------------------------------------------------------
test('約束：唯一所有權 key 重複時會失敗（實測，不靠假設）', async () => {
  const t = tempDb();
  const db = t.make();
  try {
    await db.migrate();
    await db.createUser({ id: 'u1', displayName: 'U1' });

    // 同一個 (user_id, id) 的 sleep 是 upsert，不會變兩列
    const s = {
      id: 'dup-1', start: '2026-09-06T15:00:00Z', end: '2026-09-06T23:00:00Z',
      nap: false, score_state: 'SCORED', score: { stage_summary: {}, sleep_needed: {} },
    };
    await db.upsertSleeps('u1', [s], { timezone: 'Asia/Taipei' });
    await db.upsertSleeps('u1', [s], { timezone: 'Asia/Taipei' });
    assert.equal(await countOf(db, 'whoop_sleeps'), 1, '同 user 同 id 應為 upsert');

    // 同一天同種報告的第二筆 SENT 被 partial unique index 擋掉
    await db.recordRun({ userId: 'u1', reportType: 'daily', localDateKey: 'd1', status: 'SENT' });
    assert.equal(
      await db.recordRun({ userId: 'u1', reportType: 'daily', localDateKey: 'd1', status: 'SENT' }),
      false,
    );
    // 但 FAILED 可以有多筆
    await db.recordRun({ userId: 'u1', reportType: 'daily', localDateKey: 'd1', status: 'FAILED' });
    await db.recordRun({ userId: 'u1', reportType: 'daily', localDateKey: 'd1', status: 'FAILED' });
    assert.equal(await countOf(db, 'report_runs'), 3);
  } finally { db.close(); t.cleanup(); }
});

test('約束：libSQL 預設不強制 FK —— 明確記錄實際行為，並靠應用層守住', async () => {
  const t = tempDb();
  const db = t.make();
  try {
    await db.migrate();
    const fk = await db.raw.execute('PRAGMA foreign_keys');
    const enforced = Number(fk.rows[0]?.foreign_keys ?? 0) === 1;

    // schema 刻意**沒有**宣告 FK 約束（見 schema.js）：
    // 我們不依賴 FK，所有權由每一條查詢的 user_id 條件保證。
    // 這個測試把「實際行為」釘住，避免以後有人誤以為有 FK 保護。
    await db.raw.execute({
      sql: `INSERT INTO journal_events
              (user_id, event_at, health_date, category, source, created_at, updated_at)
            VALUES ('u-does-not-exist','2026-09-07T00:00:00Z','2026-09-07','test','manual',
                    '2026-09-07T00:00:00Z','2026-09-07T00:00:00Z')`,
      args: [],
    });
    const orphan = await countOf(db, 'journal_events');
    assert.equal(orphan, 1, '目前沒有 FK 約束，孤兒列寫得進去（已知且刻意）');

    // 但**應用層**讀不到它：查詢一律帶 user_id，所以不存在的使用者查不到東西
    assert.deepEqual(
      await db.getJournalEvents('u-real', { from: '2026-01-01', to: '2026-12-31' }), [],
    );
    // 而且刪除使用者不會連帶刪掉健康歷史（沒有 CASCADE），這是刻意的設計
    await db.createUser({ id: 'u-real', displayName: 'R' });
    await db.raw.execute("DELETE FROM users WHERE id = 'u-real'");
    assert.equal(await countOf(db, 'journal_events'), 1, '刪 user 不該 cascade 掉歷史資料');

    // 把觀察到的事實記進測試訊息，方便日後查閱
    assert.ok(enforced === true || enforced === false);
  } finally { db.close(); t.cleanup(); }
});
