/**
 * 資料庫層驗證。
 * 用本機 SQLite 檔案跑（libSQL 就是 SQLite 的分支，SQL 完全一樣），
 * 所以不需要真的 Turso 帳號也能確認 schema、去重索引、冷卻邏輯都正確。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createDb } from '../src/db.js';
import { ERROR_NOTIFY_COOLDOWN_HOURS } from '../src/config.js';

function tempDb() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'whoop-db-')), 'test.db');
  const db = createDb({ url: `file:${file}`, authToken: undefined });
  return { db, file };
}

test('migrate 建出所有資料表與去重索引，且可重複執行', async () => {
  const { db } = tempDb();
  try {
    await db.migrate();
    await db.migrate(); // 第二次不該爆
    const rs = await db.raw.execute(
      "SELECT name, type FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name",
    );
    const names = rs.rows.map((r) => r.name);
    for (const expected of [
      'whoop_tokens', 'report_runs', 'error_notifications',
      'uniq_report_sent', 'idx_report_lookup',
    ]) {
      assert.ok(names.includes(expected), `缺少 ${expected}（實際：${names.join(', ')}）`);
    }
  } finally {
    db.close();
  }
});

test('token 只會有一列，refresh 後是覆寫而不是一直長', async () => {
  const { db } = tempDb();
  try {
    await db.migrate();
    assert.equal(await db.getTokens(), null);

    const t1 = {
      accessToken: 'a1', refreshToken: 'r1',
      expiresAt: new Date('2026-08-21T10:00:00Z'), scope: 'offline read:recovery',
    };
    await db.saveTokens(t1);
    let got = await db.getTokens();
    assert.equal(got.accessToken, 'a1');
    assert.equal(got.refreshToken, 'r1');
    assert.equal(got.expiresAt.toISOString(), '2026-08-21T10:00:00.000Z');

    await db.saveTokens({
      accessToken: 'a2', refreshToken: 'r2',
      expiresAt: new Date('2026-08-21T11:00:00Z'), scope: 'offline read:recovery',
    });
    got = await db.getTokens();
    assert.equal(got.accessToken, 'a2');
    assert.equal(got.refreshToken, 'r2');

    const count = await db.raw.execute('SELECT COUNT(*) AS n FROM whoop_tokens');
    assert.equal(Number(count.rows[0].n), 1);
  } finally {
    db.close();
  }
});

test('去重：同一天同一種報告只能有一筆 SENT（資料庫層級保險）', async () => {
  const { db } = tempDb();
  try {
    await db.migrate();
    assert.equal(await db.isSent('daily', '2026-08-21'), false);

    assert.equal(await db.recordRun({
      reportType: 'daily', localDateKey: '2026-08-21',
      sleepId: 's1', cycleId: 'c1', telegramMessageId: 55, status: 'SENT',
    }), true);
    assert.equal(await db.isSent('daily', '2026-08-21'), true);

    // 第二筆 SENT 會被唯一索引擋掉（recordRun 回 false，不會拋錯）
    assert.equal(await db.recordRun({
      reportType: 'daily', localDateKey: '2026-08-21', status: 'SENT',
    }), false);

    // FAILED 可以有多筆（retry 稽核用）
    assert.equal(await db.recordRun({
      reportType: 'daily', localDateKey: '2026-08-22', status: 'FAILED', detail: 'x',
    }), true);
    assert.equal(await db.recordRun({
      reportType: 'daily', localDateKey: '2026-08-22', status: 'FAILED', detail: 'y',
    }), true);
    assert.equal(await db.isSent('daily', '2026-08-22'), false);
  } finally {
    db.close();
  }
});

test('去重：daily 與 weekly 互不干擾', async () => {
  const { db } = tempDb();
  try {
    await db.migrate();
    await db.recordRun({ reportType: 'daily', localDateKey: '2026-08-24', status: 'SENT' });

    // 同一天，weekly 仍然是「還沒送」
    assert.equal(await db.isSent('daily', '2026-08-24'), true);
    assert.equal(await db.isSent('weekly', '2026-08-17'), false);

    assert.equal(await db.recordRun({
      reportType: 'weekly', localDateKey: '2026-08-17', status: 'SENT',
    }), true);
    assert.equal(await db.isSent('weekly', '2026-08-17'), true);

    const runs = await db.recentRuns(10);
    assert.equal(runs.length, 2);
  } finally {
    db.close();
  }
});

test('錯誤通知冷卻：2 小時內同一類型只通知一次', async () => {
  const { db } = tempDb();
  try {
    await db.migrate();
    assert.equal(await db.claimErrorNotify('whoop_api', ERROR_NOTIFY_COOLDOWN_HOURS), true);
    assert.equal(await db.claimErrorNotify('whoop_api', ERROR_NOTIFY_COOLDOWN_HOURS), false);
    assert.equal(await db.claimErrorNotify('whoop_api', ERROR_NOTIFY_COOLDOWN_HOURS), false);

    // 不同類型各自獨立
    assert.equal(await db.claimErrorNotify('telegram_down', ERROR_NOTIFY_COOLDOWN_HOURS), true);

    // 被壓住的次數有記錄下來
    const rs = await db.raw.execute(
      "SELECT hits FROM error_notifications WHERE error_type = 'whoop_api'",
    );
    assert.equal(Number(rs.rows[0].hits), 3);

    // 把時間往前推 3 小時 → 又可以通知
    await db.raw.execute({
      sql: 'UPDATE error_notifications SET last_notified_at = ? WHERE error_type = ?',
      args: [new Date(Date.now() - 3 * 3600_000).toISOString(), 'whoop_api'],
    });
    assert.equal(await db.claimErrorNotify('whoop_api', ERROR_NOTIFY_COOLDOWN_HOURS), true);
  } finally {
    db.close();
  }
});

test('token 寫入失敗會 retry，連續失敗才拋錯', async () => {
  const { db } = tempDb();
  try {
    await db.migrate();
    let attempts = 0;
    const realExecute = db.raw.execute.bind(db.raw);
    db.raw.execute = async (arg) => {
      if (typeof arg === 'object' && arg.sql?.includes('whoop_tokens')) {
        attempts += 1;
        if (attempts < 3) throw new Error('模擬暫時性寫入失敗');
      }
      return realExecute(arg);
    };

    await db.saveTokens({
      accessToken: 'a', refreshToken: 'r', expiresAt: new Date(), scope: 'offline',
    }, { retries: 4 });
    assert.equal(attempts, 3, '應該重試到成功');

    attempts = 0;
    db.raw.execute = async (arg) => {
      if (typeof arg === 'object' && arg.sql?.includes('whoop_tokens')) {
        attempts += 1;
        throw new Error('模擬永久寫入失敗');
      }
      return realExecute(arg);
    };
    await assert.rejects(
      () => db.saveTokens(
        { accessToken: 'a', refreshToken: 'r', expiresAt: new Date(), scope: 'offline' },
        { retries: 2 },
      ),
      /中止本次執行/,
    );
    assert.equal(attempts, 2);
  } finally {
    db.close();
  }
});
