import { LIFECYCLE_UNFENCED } from '../src/accountLifecycle.js';
/**
 * v8 → v9 遷移閘門。
 *
 * v9 只做一件事：在 **report_claims** 上加四個欄位，把「報告送出」變成一個
 * 有狀態機的耐久事實（H-01 / H-02）。
 *
 * ## 回填的方向是刻意不對稱的
 *
 * v8 的 report_claims 只有兩種列：
 *
 *   telegram_sent_at 有值   → 舊程式**證明**送出去過 → DELIVERED
 *   telegram_sent_at 是 NULL → 那個 owner 沒有走完任何一條已知路徑
 *                              （每一條已知失敗路徑都會 releaseClaim 把列刪掉）
 *                              → 它可能死在送出之前，也可能死在送出之中
 *                              → 兩者在資料上完全一樣 → **AMBIGUOUS**
 *
 * 把後者當成可重送，會在升級的當下製造重複發送 —— 正是 H-01 要修的 bug。
 * 所以欄位的 DEFAULT 取保守的那一邊，只有證明得了的才升級成 DELIVERED。
 * 萬一回填沒跑到，留下的是安全的那一邊。
 *
 * 代價是升級當下卡著的那一天不會自動補發。漏一次可以人工處理，發兩次不行。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createClient } from '@libsql/client';
import { runMigrations } from './localMigrations.js';
import {
  SCHEMA_VERSION, REPORT_DELIVERY_STATE,
  IDENTITY_SCHEMA, REPORT_SCHEMA, VERSION_SCHEMA,
} from '../src/schema.js';
import { createDb } from './localDb.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'v8-v9-'));

/** v8 形狀的 report_claims：**沒有**任何 delivery_* 欄位。 */
const V8_REPORT_CLAIMS = `CREATE TABLE report_claims (
   user_id             TEXT NOT NULL,
   report_type         TEXT NOT NULL,
   local_date          TEXT NOT NULL,
   owner               TEXT NOT NULL,
   claimed_at          TEXT NOT NULL,
   expires_at          TEXT NOT NULL,
   telegram_sent_at    TEXT,
   telegram_message_id INTEGER,
   PRIMARY KEY (user_id, report_type, local_date)
 )`;

/** 建一個「像正式環境的 v8」：有資料的 report_claims + 版本記 8。 */
async function seedV8(url) {
  const client = createClient({ url });
  for (const stmt of [...VERSION_SCHEMA, ...IDENTITY_SCHEMA]) await client.execute(stmt);
  // report_schema 的其他表照新版建（它們在 v8 就是這個形狀），
  // 只有 report_claims 刻意用 v8 的舊形狀。
  for (const stmt of REPORT_SCHEMA) {
    if (/CREATE TABLE IF NOT EXISTS report_claims/.test(stmt)) continue;
    await client.execute(stmt);
  }
  await client.execute(V8_REPORT_CLAIMS);
  await client.execute({
    sql: 'INSERT INTO schema_version (version, applied_at, note) VALUES (8, ?, ?)',
    args: [new Date().toISOString(), 'test v8'],
  });

  const t = new Date().toISOString();
  for (const id of ['u-1','u-2']) await client.execute({
    sql: 'INSERT INTO users(id,display_name,status,created_at,updated_at) VALUES (?, ?, ?, ?, ?)',
    args: [id,'Synthetic legacy','ACTIVE',t,t],
  });
  // (a) 證明得了送出去過的歷史列
  await client.execute({
    sql: `INSERT INTO report_claims
            (user_id, report_type, local_date, owner, claimed_at, expires_at,
             telegram_sent_at, telegram_message_id)
          VALUES ('u-1','daily','2026-09-10','owner-old',?,?,?,555)`,
    args: [t, t, t],
  });
  // (b) 送出狀態不明的歷史列（owner 消失在某處）
  await client.execute({
    sql: `INSERT INTO report_claims
            (user_id, report_type, local_date, owner, claimed_at, expires_at)
          VALUES ('u-1','daily','2026-09-11','owner-vanished',?,?)`,
    args: [t, t],
  });
  // (c) 另一個使用者，證明 scoping 沒被破壞
  await client.execute({
    sql: `INSERT INTO report_claims
            (user_id, report_type, local_date, owner, claimed_at, expires_at,
             telegram_sent_at, telegram_message_id)
          VALUES ('u-2','weekly','2026-09-07','owner-b',?,?,?,777)`,
    args: [t, t, t],
  });
  return client;
}

test('★★★ v8 → v9：純新增欄位，既有資料一列不動', async () => {
  const dir = tmp();
  try {
    const url = `file:${path.join(dir, 'v8.db')}`;
    const client = await seedV8(url);

    const before = await client.execute('SELECT COUNT(*) n FROM report_claims');
    assert.equal(Number(before.rows[0].n), 3);

    const summary = await runMigrations(client);
    assert.equal(summary.from, 8, '★ 起點必須被認成 8');
    assert.equal(summary.to, SCHEMA_VERSION);
    // 這一支測的是「v8 的資料庫可以安全升到**最新版**」。最新版之後還會
    // 往前走（v10 加了 WHOOP webhook 的表），所以這裡跟著 SCHEMA_VERSION 走，
    // 但仍然斷言它至少已經過了 v9（report_claims 的送達狀態機）。
    assert.ok(SCHEMA_VERSION >= 9);
    assert.deepEqual(summary.rebuilt, [], '★★★ 升級絕不可以重建（DROP）任何表');
    assert.ok(summary.columnsAdded.includes('report_claims.delivery_state'));

    const after = await client.execute('SELECT COUNT(*) n FROM report_claims');
    assert.equal(Number(after.rows[0].n), 3, '★ 既有資料必須完好');
    client.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('★★★ v8 → v9 回填：證明得了的 → DELIVERED；不明的 → AMBIGUOUS（fail closed）', async () => {
  const dir = tmp();
  try {
    const url = `file:${path.join(dir, 'v8.db')}`;
    const client = await seedV8(url);
    await runMigrations(client);

    const rows = await client.execute(
      'SELECT user_id, local_date, delivery_state FROM report_claims ORDER BY user_id, local_date',
    );
    const state = Object.fromEntries(
      rows.rows.map((r) => [`${r.user_id}|${r.local_date}`, String(r.delivery_state)]),
    );

    assert.equal(state['u-1|2026-09-10'], REPORT_DELIVERY_STATE.DELIVERED,
      '★ 有 telegram_sent_at = 證明送出去過');
    assert.equal(state['u-1|2026-09-11'], REPORT_DELIVERY_STATE.AMBIGUOUS,
      '★★★ 送出狀態不明的歷史列必須 fail closed，絕不可以變成可重送');
    assert.equal(state['u-2|2026-09-07'], REPORT_DELIVERY_STATE.DELIVERED,
      '★ 另一個使用者的歷史也要正確升級');
    client.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('★★★ v8 → v9 之後：歷史列的行為正確（已送的不重送、不明的也不重送）', async () => {
  const dir = tmp();
  try {
    const url = `file:${path.join(dir, 'v8.db')}`;
    const client = await seedV8(url);
    client.close();

    const db = createDb({ url });
    try {
      await db.migrate();
      // ★ R3 / R2-REPORT-01：認領現在要證明帳號 ACTIVE。歷史列本來就是
      // 'u-1' 這個人的；這裡把他真的建出來，測的仍然是遷移後的歷史行為。
      await db.createUser({ id: 'u-1', displayName: 'U1', timezone: 'Asia/Taipei' }).catch(() => {});
      const future = new Date(Date.now() + 365 * 86_400_000);   // 租約早就過期

      const delivered = await db.claimReport({ expectedLifecycleGeneration: LIFECYCLE_UNFENCED,
        userId: 'u-1', reportType: 'daily', localDateKey: '2026-09-10',
        ttlMs: 600_000, now: future,
      });
      assert.equal(delivered.granted, false);
      assert.equal(delivered.alreadySent, true, '★ 已證明送出 → 永遠不再授予');

      const unknown = await db.claimReport({ expectedLifecycleGeneration: LIFECYCLE_UNFENCED,
        userId: 'u-1', reportType: 'daily', localDateKey: '2026-09-11',
        ttlMs: 600_000, now: future,
      });
      assert.equal(unknown.granted, false, '★★★ 不明的歷史列不可以被重新授予');
      assert.equal(unknown.ambiguous, true, '★ 而且要能明確告訴呼叫端原因');

      // 全新的一天完全不受影響 —— 遷移不可以把系統凍住。
      const fresh = await db.claimReport({ expectedLifecycleGeneration: LIFECYCLE_UNFENCED,
        userId: 'u-1', reportType: 'daily', localDateKey: '2026-09-12',
        ttlMs: 600_000, now: future,
      });
      assert.equal(fresh.granted, true, '★ 新的報告日必須照常運作');
    } finally { db.close(); }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('★★★ 遷移冪等：重跑三次，欄位與資料都不變', async () => {
  const dir = tmp();
  try {
    const url = `file:${path.join(dir, 'v8.db')}`;
    const client = await seedV8(url);
    await runMigrations(client);
    const snapshot = await client.execute(
      'SELECT user_id, local_date, delivery_state, telegram_message_id FROM report_claims ORDER BY user_id, local_date',
    );

    for (let i = 0; i < 3; i += 1) {
      const s = await runMigrations(client);
      assert.deepEqual(s.rebuilt, []);
      assert.deepEqual(s.columnsAdded, [], `★ 第 ${i + 2} 次不可以再加欄位`);
    }

    const again = await client.execute(
      'SELECT user_id, local_date, delivery_state, telegram_message_id FROM report_claims ORDER BY user_id, local_date',
    );
    assert.deepEqual(
      again.rows.map((r) => ({ ...r })), snapshot.rows.map((r) => ({ ...r })),
      '★ 重跑不可以動到任何資料',
    );
    client.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('★★★ 全新資料庫：report_claims 一開始就是新形狀，預設 CLAIMED', async () => {
  const dir = tmp();
  try {
    const db = createDb({ url: `file:${path.join(dir, 'fresh.db')}` });
    try {
      const s = await db.migrate();
      assert.equal(s.to, SCHEMA_VERSION);
      await db.createUser({ id: 'u-f', displayName: 'F' });
      const c = await db.claimReport({ expectedLifecycleGeneration: LIFECYCLE_UNFENCED,
        userId: 'u-f', reportType: 'daily', localDateKey: '2026-09-12', ttlMs: 600_000,
      });
      assert.equal(c.granted, true);
      const claim = await db.getClaim('u-f', 'daily', '2026-09-12');
      assert.equal(claim.deliveryState, REPORT_DELIVERY_STATE.CLAIMED,
        '★ 新列的起點是 CLAIMED（不是遷移用的 AMBIGUOUS 預設值）');
      assert.equal(claim.deliveryAttempts, 0);
    } finally { db.close(); }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
