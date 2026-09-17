/**
 * V1.2 Phase 1 — v9 → v10 遷移閘門。
 *
 * v10 只做一件事：新增兩張**全新的**表
 *   whoop_webhook_events        事件帳本
 *   whoop_resource_tombstones   刪除墓碑
 *
 * 純新增 = 不需要 ALTER、不需要回填、不可能重建任何既有的表。
 * 這一支就是在釘住「純新增」這件事。
 *
 * 全部用暫時本機 DB。**絕不碰生產環境。**
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createClient } from '@libsql/client';
import { runMigrations } from '../src/migrations.js';
import {
  SCHEMA_VERSION, RESHAPED_TABLES, WHOOP_WEBHOOK_SCHEMA,
  IDENTITY_SCHEMA, REPORT_SCHEMA, HEALTH_SCHEMA, TOKEN_SCHEMA, VERSION_SCHEMA,
} from '../src/schema.js';
import { createDb } from '../src/db.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'v9-v10-'));
const NEW_TABLES = ['whoop_webhook_events', 'whoop_resource_tombstones'];

const tableNames = async (client) => (await client.execute(
  "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
)).rows.map((r) => String(r.name));

/** 建一個「像 v9 的正式環境」：既有的表都在、有資料、版本記 9，但沒有新表。 */
async function seedV9(url) {
  const client = createClient({ url });
  for (const stmt of [...VERSION_SCHEMA, ...IDENTITY_SCHEMA, ...TOKEN_SCHEMA,
    ...REPORT_SCHEMA, ...HEALTH_SCHEMA]) {
    await client.execute(stmt);
  }
  await client.execute({
    sql: 'INSERT INTO schema_version (version, applied_at, note) VALUES (9, ?, ?)',
    args: [new Date().toISOString(), 'test v9'],
  });
  const t = new Date().toISOString();
  await client.execute({
    sql: `INSERT INTO users (id, display_name, timezone, status, created_at, updated_at)
          VALUES ('u-kelvin','Kelvin','Asia/Taipei','ACTIVE',?,?)`,
    args: [t, t],
  });
  await client.execute({
    sql: `INSERT INTO report_runs (user_id, report_type, local_date, health_date, status, sent_at)
          VALUES ('u-kelvin','daily','2026-09-14','2026-09-14','SENT',?)`,
    args: [t],
  });
  await client.execute({
    sql: `INSERT INTO whoop_sleeps (user_id, id, health_date, start_at, end_at, nap,
                                    score_state, respiratory_rate, updated_at, synced_at, raw_json)
          VALUES ('u-kelvin','sleep-1','2026-09-14',?,?,0,'SCORED',15,?,?,'{}')`,
    args: [t, t, '2026-09-14T06:00:00.000Z', t],
  });
  return client;
}

test('★★★ v10 的新表絕不可以被武裝成「可重建」（那是 DROP 路徑）', () => {
  const armed = RESHAPED_TABLES.map((r) => r.table);
  for (const t of NEW_TABLES) {
    assert.ok(!armed.includes(t), `★★★ ${t} 不可以出現在 RESHAPED_TABLES`);
  }
});

test('★★★ 新表的每一句 DDL 都是 IF NOT EXISTS（可重複執行）', () => {
  for (const stmt of WHOOP_WEBHOOK_SCHEMA) {
    assert.match(stmt, /IF NOT EXISTS/, `★ 必須可重複執行：${stmt.slice(0, 60)}`);
  }
});

test('★★★ v9 → v10：純新增，既有資料一列不動、零重建', async () => {
  const dir = tmp();
  try {
    const url = `file:${path.join(dir, 'v9.db')}`;
    const client = await seedV9(url);
    const before = await tableNames(client);
    for (const t of NEW_TABLES) assert.ok(!before.includes(t), `★ 起點不該有 ${t}`);

    const summary = await runMigrations(client);
    assert.equal(summary.from, 9, '★ 起點必須被認成 9');
    assert.equal(summary.to, SCHEMA_VERSION);
    assert.equal(SCHEMA_VERSION, 19);
    assert.deepEqual(summary.rebuilt, [], '★★★ 升級絕不可以重建（DROP）任何表');
    // v10 本身是純新增表。v11 在 v10 建的墓碑表上加了三個診斷欄位；從 v9
    // 起跳時墓碑表是這一輪剛用 v11 的 DDL 建的，欄位已經在裡面。
    //
    // 唯一會出現的 ALTER 是 v16 的 user_whoop_tokens.auth_generation —— 那張表
    // 從 v9 就存在，所以新欄位只能用 ADD COLUMN 補（純新增、nullable-safe）。
    assert.deepEqual(summary.columnsAdded, ['user_whoop_tokens.auth_generation'],
      '★★★ 從 v9 升級：除了既有表上的純新增欄位之外，不該有任何其他 ALTER');

    const after = await tableNames(client);
    for (const t of NEW_TABLES) assert.ok(after.includes(t), `★ ${t} 必須建起來`);

    // 既有資料完好
    const users = await client.execute('SELECT COUNT(*) n FROM users');
    const runs = await client.execute('SELECT COUNT(*) n FROM report_runs');
    const sleeps = await client.execute('SELECT respiratory_rate FROM whoop_sleeps');
    assert.equal(Number(users.rows[0].n), 1);
    assert.equal(Number(runs.rows[0].n), 1);
    assert.equal(Number(sleeps.rows[0].respiratory_rate), 15, '★ 生理資料必須原封不動');
    client.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('★★★ 遷移冪等：重跑三次，schema 與資料都不變', async () => {
  const dir = tmp();
  try {
    const url = `file:${path.join(dir, 'v9.db')}`;
    const client = await seedV9(url);
    await runMigrations(client);
    const snapshot = await tableNames(client);

    for (let i = 0; i < 3; i += 1) {
      const s = await runMigrations(client);
      assert.deepEqual(s.rebuilt, []);
      assert.deepEqual(s.columnsAdded, []);
    }
    assert.deepEqual(await tableNames(client), snapshot, '★ 表結構不可以變');
    const versions = await client.execute('SELECT COUNT(*) n FROM schema_version');
    assert.equal(Number(versions.rows[0].n), 2, '★ 只應該有 v9 與 v16 兩筆版本紀錄（v10～v15 從未單獨落地）');
    client.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('★★★ 中斷後重跑：只建了一張表就死掉 → 再跑一次會補齊（純新增所以可恢復）', async () => {
  const dir = tmp();
  try {
    const url = `file:${path.join(dir, 'v9.db')}`;
    const client = await seedV9(url);
    // 模擬「建到一半就死了」：只建 events，沒建 tombstones，版本也還沒寫。
    await client.execute(WHOOP_WEBHOOK_SCHEMA[0]);
    const mid = await tableNames(client);
    assert.ok(mid.includes('whoop_webhook_events'));
    assert.ok(!mid.includes('whoop_resource_tombstones'));

    const s = await runMigrations(client);
    assert.equal(s.to, SCHEMA_VERSION);
    assert.deepEqual(s.rebuilt, [], '★ 不可以因為「表已經在了」就去重建它');
    const after = await tableNames(client);
    for (const t of NEW_TABLES) assert.ok(after.includes(t), `★ ${t} 必須補齊`);
    client.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('★★★ 全新資料庫：一次就到最新版，兩張新表可用', async () => {
  const dir = tmp();
  try {
    const db = createDb({ url: `file:${path.join(dir, 'fresh.db')}` });
    try {
      const s = await db.migrate();
      assert.equal(s.to, SCHEMA_VERSION);
      await db.createUser({ id: 'u-1', displayName: 'U' });
      // 帳本可寫可讀
      const rec = await db.recordWhoopEvent({
        whoopUserId: '1', eventType: 'sleep.updated', resourceType: 'sleep',
        resourceId: 's1', traceId: 't1',
      });
      assert.equal(rec.inserted, true);
      // 墓碑可寫可讀
      await db.upsertTombstone({
        userId: 'u-1', resourceType: 'sleep', resourceId: 's1',
        lastKnownUpdatedAt: '2026-09-12T10:00:00.000Z',
      });
      const tomb = await db.getTombstone('u-1', 'sleep', 's1');
      assert.equal(tomb.state, 'ACTIVE');
    } finally { db.close(); }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('★★★ 唯一索引真的生效（去重的權威是 DB，不是應用層）', async () => {
  const dir = tmp();
  try {
    const db = createDb({ url: `file:${path.join(dir, 'u.db')}` });
    try {
      await db.migrate();
      const args = {
        whoopUserId: '1', eventType: 'sleep.updated', resourceType: 'sleep',
        resourceId: 's1', traceId: 't1',
      };
      const a = await db.recordWhoopEvent(args);
      const b = await db.recordWhoopEvent(args);
      assert.equal(a.inserted, true);
      assert.equal(b.duplicate, true);
      assert.equal(a.id, b.id);
      // 直接繞過應用層也要被擋下
      await assert.rejects(() => db.raw.execute({
        sql: `INSERT INTO whoop_webhook_events
                (provider, whoop_user_id, event_type, resource_type, resource_id, trace_id,
                 received_at, state, created_at, updated_at)
              VALUES ('whoop','1','sleep.updated','sleep','s1','t1',?,'RECEIVED',?,?)`,
        args: [new Date().toISOString(), new Date().toISOString(), new Date().toISOString()],
      }), /UNIQUE constraint failed/);
    } finally { db.close(); }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
