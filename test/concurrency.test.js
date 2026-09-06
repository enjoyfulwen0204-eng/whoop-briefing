/**
 * 併發保護（audit A1 / A2）。
 *
 * 刻意使用**真的 SQLite 檔案**而不是記憶體假 DB —— 這裡要驗證的正是
 * 「ON CONFLICT ... DO UPDATE ... WHERE」這句 SQL 的原子性本身。
 * 用假 DB 測等於在測假 DB 自己的實作，沒有意義。
 *
 * 兩個獨立的 createDb() 實例指向同一個檔案 = 模擬兩個 process。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

import { createDb } from '../src/db.js';
import { createWhoopClient, WhoopAuthError } from '../src/whoop.js';
import { LOCKS, REPORT_CLAIM, WHOOP } from '../src/config.js';

/** 建一個臨時 SQLite 檔，回傳 url 與清理函式。 */
function tempDbFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whoop-conc-'));
  const file = path.join(dir, 'test.db');
  return {
    url: `file:${file}`,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

const noSleep = async () => {};

// ===========================================================================
// A1. 跨 process token refresh lock
// ===========================================================================

test('A1: lock 同時只有一個持有者，釋放後才能再取得', async () => {
  const { url, cleanup } = tempDbFile();
  const a = createDb({ url });
  const b = createDb({ url });
  try {
    await a.migrate();

    const ownerA = await a.acquireLock('t', { ttlMs: 60_000 });
    assert.ok(ownerA, 'A 應該拿得到');

    const ownerB = await b.acquireLock('t', { ttlMs: 60_000 });
    assert.equal(ownerB, null, 'B 不可以同時拿到同一個 lock');

    // 非持有者不能釋放
    assert.equal(await b.releaseLock('t', 'not-the-owner'), false);
    assert.equal(await b.acquireLock('t', { ttlMs: 60_000 }), null, '仍然被 A 持有');

    assert.equal(await a.releaseLock('t', ownerA), true);
    assert.ok(await b.acquireLock('t', { ttlMs: 60_000 }), '釋放後 B 就拿得到');
  } finally {
    a.close(); b.close(); cleanup();
  }
});

test('A1: lock 過期後可以被接手（process crash 不會永久卡死）', async () => {
  const { url, cleanup } = tempDbFile();
  const a = createDb({ url });
  const b = createDb({ url });
  try {
    await a.migrate();
    const t0 = new Date('2026-09-01T00:00:00.000Z');

    const ownerA = await a.acquireLock('t', { ttlMs: 60_000, now: t0 });
    assert.ok(ownerA);

    // 30 秒後：還沒過期
    const t1 = new Date(t0.getTime() + 30_000);
    assert.equal(await b.acquireLock('t', { ttlMs: 60_000, now: t1 }), null);

    // 61 秒後：租約到期，B 可以接手（模擬 A crash 了）
    const t2 = new Date(t0.getTime() + 61_000);
    const ownerB = await b.acquireLock('t', { ttlMs: 60_000, now: t2 });
    assert.ok(ownerB, '過期的 lock 必須可以被接手');
    assert.notEqual(ownerB, ownerA);

    // 舊持有者已經不是 owner 了，不能把新的 lock 釋放掉
    assert.equal(await a.releaseLock('t', ownerA), false);
  } finally {
    a.close(); b.close(); cleanup();
  }
});

test('A1: 100 個並行 acquire 只有 1 個成功', async () => {
  const { url, cleanup } = tempDbFile();
  const db = createDb({ url });
  try {
    await db.migrate();
    const results = await Promise.all(
      Array.from({ length: 100 }, () => db.acquireLock('hot', { ttlMs: 60_000 })),
    );
    const winners = results.filter(Boolean);
    assert.equal(winners.length, 1, `只能有一個贏家，實際 ${winners.length}`);
  } finally {
    db.close(); cleanup();
  }
});

/** 假的 WHOOP token endpoint，數 refresh 被呼叫幾次。 */
async function mockTokenServer() {
  const calls = [];
  let seq = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      calls.push(Object.fromEntries(new URLSearchParams(body)));
      seq += 1;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        access_token: `access-${seq}`,
        refresh_token: `refresh-${seq}`,
        expires_in: 3600,
        scope: WHOOP.SCOPES,
      }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return {
    calls,
    tokenUrl: `http://127.0.0.1:${port}/oauth/oauth2/token`,
    close: () => new Promise((r) => server.close(r)),
  };
}

test('A1: 兩個 process 同時要 refresh → 只會真的 refresh 一次，另一個沿用', async () => {
  const { url, cleanup } = tempDbFile();
  const dbA = createDb({ url });
  const dbB = createDb({ url });
  const api = await mockTokenServer();
  try {
    await dbA.migrate();
    // 種一組「快過期」的 token（剩 1 分鐘 < 5 分鐘 skew）
    await dbA.saveTokens({
      accessToken: 'old-access',
      refreshToken: 'old-refresh',
      expiresAt: new Date(Date.now() + 60_000),
      scope: WHOOP.SCOPES,
    });

    const mk = (db) => createWhoopClient({
      db, clientId: 'id', clientSecret: 'secret',
      tokenUrl: api.tokenUrl, sleepImpl: noSleep,
    });

    // A 先拿到 lock 並完成 refresh；B 隨後進來
    const clientA = mk(dbA);
    const clientB = mk(dbB);
    const tokenA = await clientA.getAccessToken();
    const tokenB = await clientB.getAccessToken();

    assert.equal(api.calls.length, 1, `token endpoint 只該被呼叫一次，實際 ${api.calls.length}`);
    assert.equal(tokenA, 'access-1');
    assert.equal(tokenB, 'access-1', 'B 應該直接沿用 A refresh 出來的 token');

    // DB 裡只有一組 token，而且是最新那組
    const stored = await dbB.getTokens();
    assert.equal(stored.accessToken, 'access-1');
    assert.equal(stored.refreshToken, 'refresh-1');
  } finally {
    await api.close(); dbA.close(); dbB.close(); cleanup();
  }
});

test('A1: peer 握著 lock 但一直沒寫出新 token → 等到逾時就中止，不自己 refresh', async () => {
  const { url, cleanup } = tempDbFile();
  const db = createDb({ url });
  const api = await mockTokenServer();
  try {
    await db.migrate();
    await db.saveTokens({
      accessToken: 'old-access',
      refreshToken: 'old-refresh',
      expiresAt: new Date(Date.now() + 60_000),
      scope: WHOOP.SCOPES,
    });

    // 模擬另一個 process 正握著 lock（而且卡住了，永遠不會寫新 token）
    const peer = await db.acquireLock(LOCKS.TOKEN_REFRESH_NAME, { ttlMs: 60_000 });
    assert.ok(peer);

    const client = createWhoopClient({
      db, clientId: 'id', clientSecret: 'secret',
      tokenUrl: api.tokenUrl, sleepImpl: noSleep,
    });

    await assert.rejects(
      () => client.getAccessToken(),
      (err) => err instanceof WhoopAuthError && /等待逾時/.test(err.message),
      '等不到就該明確失敗',
    );
    assert.equal(
      api.calls.length, 0,
      '關鍵：等不到 lock 時絕不可以自己 refresh（會讓 refresh_token 輪替競態重現）',
    );
  } finally {
    await api.close(); db.close(); cleanup();
  }
});

// ===========================================================================
// A2. 報告發送權
// ===========================================================================

test('A2: 同一份報告只有一個 process 拿得到發送權', async () => {
  const { url, cleanup } = tempDbFile();
  const a = createDb({ url });
  const b = createDb({ url });
  try {
    await a.migrate();
    const args = { reportType: 'daily', localDateKey: '2026-09-01', ttlMs: REPORT_CLAIM.TTL_MS };

    const claimA = await a.claimReport(args);
    assert.equal(claimA.granted, true);

    const claimB = await b.claimReport(args);
    assert.equal(claimB.granted, false, 'B 不可以同時拿到發送權');
    assert.equal(claimB.alreadySent, false, '只是被佔用，還沒真的送出去');
  } finally {
    a.close(); b.close(); cleanup();
  }
});

test('A2: 20 個並行 claim 只有 1 個成功', async () => {
  const { url, cleanup } = tempDbFile();
  const db = createDb({ url });
  try {
    await db.migrate();
    const results = await Promise.all(Array.from({ length: 20 }, () => db.claimReport({
      reportType: 'daily', localDateKey: '2026-09-02', ttlMs: REPORT_CLAIM.TTL_MS,
    })));
    assert.equal(results.filter((r) => r.granted).length, 1);
  } finally {
    db.close(); cleanup();
  }
});

test('A2: 標記已送出後，claim 永遠不會再被授予（即使租約過期）', async () => {
  const { url, cleanup } = tempDbFile();
  const a = createDb({ url });
  const b = createDb({ url });
  try {
    await a.migrate();
    const key = { reportType: 'daily', localDateKey: '2026-09-03' };
    const t0 = new Date('2026-09-03T00:00:00.000Z');

    const claim = await a.claimReport({ ...key, ttlMs: 60_000, now: t0 });
    assert.equal(claim.granted, true);

    // Telegram 送出成功 → 立刻標記
    assert.equal(await a.markClaimSent({ ...key, owner: claim.owner, messageId: 555, now: t0 }), true);

    // 一年後、租約早就過期，仍然不可以再拿到發送權
    const later = new Date(t0.getTime() + 365 * 86_400_000);
    const retry = await b.claimReport({ ...key, ttlMs: 60_000, now: later });
    assert.equal(retry.granted, false);
    assert.equal(retry.alreadySent, true, '必須明確告訴呼叫端「已經送過了」');

    const stored = await b.getClaim('daily', '2026-09-03');
    assert.equal(stored.telegramMessageId, 555);
    assert.ok(stored.telegramSentAt);
  } finally {
    a.close(); b.close(); cleanup();
  }
});

test('A2: 尚未送出的 claim 過期後可以被接手（process crash 不會永久卡住報告）', async () => {
  const { url, cleanup } = tempDbFile();
  const db = createDb({ url });
  try {
    await db.migrate();
    const key = { reportType: 'weekly', localDateKey: '2026-08-31' };
    const t0 = new Date('2026-08-31T00:00:00.000Z');

    const first = await db.claimReport({ ...key, ttlMs: 60_000, now: t0 });
    assert.equal(first.granted, true);

    const during = await db.claimReport({ ...key, ttlMs: 60_000, now: new Date(t0.getTime() + 30_000) });
    assert.equal(during.granted, false);

    const after = await db.claimReport({ ...key, ttlMs: 60_000, now: new Date(t0.getTime() + 61_000) });
    assert.equal(after.granted, true, '過期未送出 → 必須可以接手重試');

    // 舊持有者已經不是 owner，不能再標記已送出
    assert.equal(await db.markClaimSent({ ...key, owner: first.owner, messageId: 1 }), false);
    assert.equal(await db.markClaimSent({ ...key, owner: after.owner, messageId: 2 }), true);
  } finally {
    db.close(); cleanup();
  }
});

test('A2: releaseClaim 讓失敗的報告可以立刻重試，但已送出的不受影響', async () => {
  const { url, cleanup } = tempDbFile();
  const db = createDb({ url });
  try {
    await db.migrate();
    const key = { reportType: 'daily', localDateKey: '2026-09-04' };

    const c1 = await db.claimReport({ ...key, ttlMs: 600_000 });
    assert.equal(await db.releaseClaim({ ...key, owner: c1.owner }), true);
    const c2 = await db.claimReport({ ...key, ttlMs: 600_000 });
    assert.equal(c2.granted, true, '釋放後不必等 TTL 就能重試');

    // 已送出的 claim 不可以被釋放掉
    await db.markClaimSent({ ...key, owner: c2.owner, messageId: 9 });
    assert.equal(await db.releaseClaim({ ...key, owner: c2.owner }), false);
    assert.equal((await db.claimReport({ ...key, ttlMs: 600_000 })).alreadySent, true);
  } finally {
    db.close(); cleanup();
  }
});

test('A2: daily 與 weekly、不同日期彼此獨立', async () => {
  const { url, cleanup } = tempDbFile();
  const db = createDb({ url });
  try {
    await db.migrate();
    const ttlMs = 600_000;
    assert.equal((await db.claimReport({ reportType: 'daily', localDateKey: '2026-09-05', ttlMs })).granted, true);
    assert.equal((await db.claimReport({ reportType: 'weekly', localDateKey: '2026-09-05', ttlMs })).granted, true);
    assert.equal((await db.claimReport({ reportType: 'daily', localDateKey: '2026-09-06', ttlMs })).granted, true);
    assert.equal((await db.claimReport({ reportType: 'daily', localDateKey: '2026-09-05', ttlMs })).granted, false);
  } finally {
    db.close(); cleanup();
  }
});
