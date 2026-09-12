/**
 * Schema v8：簡報評估的耐久狀態，以及 48 小時補發／漏發政策。
 *
 * ## 為什麼 v8 存在
 *
 * 2026-09-12 的事故裡，「跑了但還不能發」與「根本沒跑」在資料庫上完全一樣：
 * 兩者都不寫任何東西。追查只能靠 cron heartbeat 反推，而使用者問
 * 「今天的晨報呢」時，系統連「我在等什麼」都答不出來。
 *
 * ## 政策（使用者已核可）
 *
 *   age = now − sleep.end（**實際的**睡眠結束時間）
 *   age ≤ 24h → 一般簡報
 *   24h < age ≤ 48h → 補發（標示「補發」，去重鍵仍是原本的 health_date）
 *   age > 48h → MISSED：不送整份報告，只通知一次，終局
 *
 * **48 小時是包含的。** 邊界上的錯誤代價不對稱：晚送一份標示清楚的報告，
 * 遠好過把一份還救得回來的報告永久丟掉。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createDb } from '../src/db.js';
import { createClient } from '@libsql/client';
import { runMigrations } from '../src/migrations.js';
import {
  SCHEMA_VERSION, SCHEMA, REPORT_SCHEMA, IDENTITY_SCHEMA, VERSION_SCHEMA,
  BRIEFING_STATE_SCHEMA, RESHAPED_TABLES,
} from '../src/schema.js';
import {
  BRIEFING_OUTCOME, LATE_POLICY, deliveryWindow, isRetryableOutcome,
} from '../src/briefingState.js';

const TZ = 'Asia/Taipei';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'v8-'));

// ===========================================================================
// 遷移
// ===========================================================================

test('★★★ SCHEMA_VERSION 是 8，且新表走純新增路徑', () => {
  assert.equal(SCHEMA_VERSION, 8);
  assert.ok(SCHEMA.some((s) => /CREATE TABLE IF NOT EXISTS briefing_evaluations/.test(s)));
  assert.ok(BRIEFING_STATE_SCHEMA.every((s) => /IF NOT EXISTS/.test(s)),
    '★ 每一句都必須是 IF NOT EXISTS（可重複執行）');
  // 絕不可以進 DROP 路徑
  assert.ok(!RESHAPED_TABLES.some((r) => r.table === 'briefing_evaluations'),
    '★ 新表不可以被武裝成可重建（那是 DROP）');
});

test('★★★ 全新資料庫一次遷移到 v8', async () => {
  const dir = tmp();
  try {
    const client = createClient({ url: `file:${path.join(dir, 'fresh.db')}` });
    const summary = await runMigrations(client);
    assert.equal(summary.to, 8);
    const rs = await client.execute(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='briefing_evaluations'",
    );
    assert.equal(rs.rows.length, 1);
    client.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('★★★ 既有的 v7 資料庫升到 v8，而且原有資料原封不動', async () => {
  const dir = tmp();
  try {
    const url = `file:${path.join(dir, 'v7.db')}`;
    const client = createClient({ url });
    // 建一個「v7 形狀」：所有表都在，但沒有 briefing_evaluations，版本記 7
    for (const stmt of [...VERSION_SCHEMA, ...IDENTITY_SCHEMA, ...REPORT_SCHEMA]) {
      await client.execute(stmt);
    }
    await client.execute({
      sql: 'INSERT INTO schema_version (version, applied_at, note) VALUES (7, ?, ?)',
      args: [new Date().toISOString(), 'test v7'],
    });
    await client.execute({
      sql: `INSERT INTO report_runs
              (user_id, report_type, local_date, health_date, status, sent_at)
            VALUES ('u-1','daily','2026-09-11','2026-09-11','SENT',?)`,
      args: [new Date().toISOString()],
    });
    const before = await client.execute('SELECT COUNT(*) n FROM report_runs');
    assert.equal(Number(before.rows[0].n), 1);

    const summary = await runMigrations(client);
    assert.equal(summary.from, 7, '★ 起點必須被認成 7');
    assert.equal(summary.to, 8);
    assert.deepEqual(summary.rebuilt, [], '★ 升級不可以重建（DROP）任何表');

    const after = await client.execute('SELECT COUNT(*) n FROM report_runs');
    assert.equal(Number(after.rows[0].n), 1, '★ 既有資料必須完好');
    const t = await client.execute(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='briefing_evaluations'",
    );
    assert.equal(t.rows.length, 1, '★ 新表要建起來');
    client.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('★★★ 遷移可以重跑（冪等），資料不變', async () => {
  const dir = tmp();
  try {
    const url = `file:${path.join(dir, 'again.db')}`;
    const client = createClient({ url });
    await runMigrations(client);
    await client.execute({
      sql: `INSERT INTO briefing_evaluations
              (user_id, report_type, evaluated_at, local_date, outcome, retryable,
               created_at, updated_at)
            VALUES ('u-1','daily',?,?,'READY',1,?,?)`,
      args: [new Date().toISOString(), '2026-09-12', new Date().toISOString(), new Date().toISOString()],
    });
    for (let i = 0; i < 3; i += 1) {
      const s = await runMigrations(client);
      assert.equal(s.to, 8);
      assert.deepEqual(s.rebuilt, []);
    }
    const rs = await client.execute('SELECT COUNT(*) n FROM briefing_evaluations');
    assert.equal(Number(rs.rows[0].n), 1, '★ 重跑不可以動到資料');
    client.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ===========================================================================
// 狀態表語意
// ===========================================================================

test('★★★ 每個 (user, report_type) 只有一列，upsert 覆寫（表不會成長）', async () => {
  const dir = tmp();
  const db = createDb({ url: `file:${path.join(dir, 's.db')}` });
  try {
    await db.migrate();
    const u = await db.createUser({ displayName: 'k', timezone: TZ });
    for (const outcome of ['WAITING_FOR_SLEEP', 'TOO_SOON', 'READY', 'SENT']) {
      await db.recordBriefingEvaluation({
        userId: u.id, reportType: 'daily', evaluatedAt: new Date().toISOString(),
        localDate: '2026-09-12', targetHealthDate: '2026-09-12', outcome,
        retryable: isRetryableOutcome(outcome),
      });
    }
    const rs = await db.raw.execute('SELECT COUNT(*) n FROM briefing_evaluations');
    assert.equal(Number(rs.rows[0].n), 1, '★ 一列，不是四列');
    const row = await db.getBriefingEvaluation(u.id, 'daily');
    assert.equal(row.outcome, 'SENT', '★ 最新的那個贏');
    assert.equal(row.retryable, false);
    // 不同 report_type 各自一列
    await db.recordBriefingEvaluation({
      userId: u.id, reportType: 'weekly', evaluatedAt: new Date().toISOString(),
      localDate: '2026-09-12', outcome: 'READY',
    });
    const rs2 = await db.raw.execute('SELECT COUNT(*) n FROM briefing_evaluations');
    assert.equal(Number(rs2.rows[0].n), 2);
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('★★★ 併發寫入收斂成一列（Cloudflare 與 GitHub 同時跑）', async () => {
  const dir = tmp();
  const db = createDb({ url: `file:${path.join(dir, 'c.db')}` });
  try {
    await db.migrate();
    const u = await db.createUser({ displayName: 'k', timezone: TZ });
    await Promise.all(['READY', 'CLAIM_BUSY', 'SENT', 'ALREADY_SENT'].map((outcome) =>
      db.recordBriefingEvaluation({
        userId: u.id, reportType: 'daily', evaluatedAt: new Date().toISOString(),
        localDate: '2026-09-12', outcome,
      })));
    const rs = await db.raw.execute('SELECT COUNT(*) n FROM briefing_evaluations');
    assert.equal(Number(rs.rows[0].n), 1);
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('★★★ 狀態表不存原始 payload、報告全文、祕密或 chat id', async () => {
  const dir = tmp();
  const db = createDb({ url: `file:${path.join(dir, 'p.db')}` });
  try {
    await db.migrate();
    const cols = await db.raw.execute("SELECT name FROM pragma_table_info('briefing_evaluations')");
    const names = cols.rows.map((r) => String(r.name));
    for (const forbidden of ['raw_json', 'text', 'body', 'chat_id', 'token', 'secret', 'prose']) {
      assert.ok(!names.includes(forbidden), `★ 不可以有 ${forbidden} 欄位`);
    }
    assert.deepEqual(names.slice(0, 2), ['user_id', 'report_type']);
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

// ===========================================================================
// 48 小時邊界
// ===========================================================================

test('★★★ deliveryWindow 的邊界語意（48 小時包含）', () => {
  const end = '2026-09-12T01:43:00.000Z';
  const at = (h) => new Date(Date.parse(end) + h * 3600_000);
  assert.equal(LATE_POLICY.NORMAL_WINDOW_HOURS, 24);
  assert.equal(LATE_POLICY.LATE_WINDOW_HOURS, 48);
  assert.equal(deliveryWindow({ sleepEndIso: end, now: at(0) }), 'normal');
  assert.equal(deliveryWindow({ sleepEndIso: end, now: at(23.999) }), 'normal');
  assert.equal(deliveryWindow({ sleepEndIso: end, now: at(24) }), 'normal', '★ 24h 整仍是 normal');
  assert.equal(deliveryWindow({ sleepEndIso: end, now: at(24 + 1 / 3_600_000) }), 'late');
  assert.equal(deliveryWindow({ sleepEndIso: end, now: at(47 + 59 / 60 + 59 / 3600) }), 'late');
  assert.equal(deliveryWindow({ sleepEndIso: end, now: at(48) }), 'late', '★ 48h 整仍可補發（包含）');
  assert.equal(deliveryWindow({ sleepEndIso: end, now: at(48 + 1 / 3_600_000) }), 'missed');
  assert.equal(deliveryWindow({ sleepEndIso: end, now: at(72) }), 'missed');
  // 壞資料一律 unknown，不可以當成「非常新」
  assert.equal(deliveryWindow({ sleepEndIso: end, now: at(-1) }), 'unknown');
  assert.equal(deliveryWindow({ sleepEndIso: null, now: at(1) }), 'unknown');
  assert.equal(deliveryWindow({ sleepEndIso: 'not-a-date', now: at(1) }), 'unknown');
});

test('★★★ 邊界不受時區影響（同一個 UTC 瞬間，兩個時區結果一致）', () => {
  const end = '2026-09-11T16:30:00.000Z';  // 台北 09-12 00:30
  const now = new Date(Date.parse(end) + 47 * 3600_000);
  // deliveryWindow 完全用 UTC 毫秒算，時區只影響 health_date 的歸屬
  assert.equal(deliveryWindow({ sleepEndIso: end, now }), 'late');
  const past = new Date(Date.parse(end) + 49 * 3600_000);
  assert.equal(deliveryWindow({ sleepEndIso: end, now: past }), 'missed');
});

test('★★★ 結果詞彙涵蓋所有必要狀態，且終局標記正確', () => {
  for (const k of ['WAITING_FOR_SLEEP', 'WAITING_FOR_SLEEP_SCORE', 'WAITING_FOR_RECOVERY',
    'WAITING_FOR_RECOVERY_SCORE', 'TOO_SOON', 'READY', 'CLAIM_BUSY', 'ALREADY_SENT',
    'SENT', 'SENT_LATE', 'FAILED', 'MISSED']) {
    assert.ok(BRIEFING_OUTCOME[k], `★ 缺少 ${k}`);
  }
  for (const retry of ['WAITING_FOR_SLEEP', 'TOO_SOON', 'READY', 'CLAIM_BUSY', 'FAILED']) {
    assert.equal(isRetryableOutcome(BRIEFING_OUTCOME[retry]), true, `★ ${retry} 應可重試`);
  }
  for (const terminal of ['MISSED', 'SENT', 'SENT_LATE', 'ALREADY_SENT']) {
    assert.equal(isRetryableOutcome(BRIEFING_OUTCOME[terminal]), false, `★ ${terminal} 是終局`);
  }
});
