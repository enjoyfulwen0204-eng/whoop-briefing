/**
 * 身分與安全：Telegram 綁定、一次性 link code、OAuth state、
 * WHOOP 帳號唯一性、token refresh 併發隔離。
 *
 * 全部用 mock，**不呼叫真實 WHOOP / Telegram / OpenRouter**。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { createDb } from '../src/db.js';
import { createWhoopClient } from '../src/whoop.js';
import { hashSecret } from '../src/identityStore.js';
import {
  OAuthFlowError, assertAuthorizable, completeAuthorization, prepareAuthorization,
} from '../src/oauthFlow.js';
import { LOCKS } from '../src/config.js';
import { ALICE, BOB, seedAliceAndBob } from './users.js';

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mu-id-'));
  return {
    dir,
    make: () => createDb({ url: `file:${path.join(dir, 't.db')}` }),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}
async function withDb(fn) {
  const t = tempDb();
  const db = t.make();
  try { await db.migrate(); await seedAliceAndBob(db); await fn(db, t); }
  finally { db.close(); t.cleanup(); }
}

// ---------------------------------------------------------------------------
// Telegram 身分解析
// ---------------------------------------------------------------------------
test('Telegram 身分解析：chat → ACTIVE 綁定 → ACTIVE 使用者', async () => {
  await withDb(async (db) => {
    assert.equal((await db.resolveUserByChatId(ALICE.chatId)).user.id, ALICE.id);
    assert.equal((await db.resolveUserByChatId(BOB.chatId)).user.id, BOB.id);
    assert.equal(await db.resolveUserByChatId('999999'), null, '未知 chat 一律回 null');
  });
});

test('停用使用者 / 撤銷綁定後，該 chat 一律解析不到', async () => {
  await withDb(async (db) => {
    await db.updateUser(ALICE.id, { status: 'DISABLED' });
    assert.equal(await db.resolveUserByChatId(ALICE.chatId), null, 'DISABLED 使用者不可通過');

    await db.revokeTelegramLink(BOB.chatId);
    assert.equal(await db.resolveUserByChatId(BOB.chatId), null, '撤銷的綁定不可通過');
  });
});

test('不可把已經綁在別人身上的 chat 搶走', async () => {
  await withDb(async (db) => {
    await assert.rejects(
      () => db.linkTelegram({ chatId: ALICE.chatId, userId: BOB.id }),
      (err) => err.code === 'CHAT_ALREADY_LINKED',
    );
    assert.equal((await db.resolveUserByChatId(ALICE.chatId)).user.id, ALICE.id, 'Alice 的綁定必須完好');
  });
});

// ---------------------------------------------------------------------------
// 一次性 link code
// ---------------------------------------------------------------------------
test('link code：原文不入庫，只存 hash', async () => {
  await withDb(async (db) => {
    const { code } = await db.createLinkCode(BOB.id, { ttlMs: 60_000 });
    const rows = await db.raw.execute('SELECT code_hash FROM user_link_codes');
    assert.equal(rows.rows.length, 1);
    assert.notEqual(rows.rows[0].code_hash, code, 'DB 裡不可有原文');
    assert.equal(rows.rows[0].code_hash, hashSecret(code), '存的必須是 SHA-256 hash');
    assert.equal(rows.rows[0].code_hash.length, 64);
  });
});

test('link code：valid / 已用過 / 過期 / 無效 四種路徑', async () => {
  await withDb(async (db) => {
    const ok = await db.createLinkCode(BOB.id, { ttlMs: 60_000 });
    const first = await db.redeemLinkCode(ok.code, { chatId: '3001' });
    assert.deepEqual(first, { ok: true, userId: BOB.id });

    assert.deepEqual(await db.redeemLinkCode(ok.code, { chatId: '3002' }),
      { ok: false, reason: 'used' }, '第二次必須被拒');

    const expired = await db.createLinkCode(BOB.id, { ttlMs: -1000 });
    assert.deepEqual(await db.redeemLinkCode(expired.code, { chatId: '3003' }),
      { ok: false, reason: 'expired' });

    assert.deepEqual(await db.redeemLinkCode('totally-made-up', { chatId: '3004' }),
      { ok: false, reason: 'invalid' });
  });
});

test('link code：兩個並發兌換同一組碼，只有一個成功', async () => {
  await withDb(async (db) => {
    const { code } = await db.createLinkCode(BOB.id, { ttlMs: 60_000 });
    const results = await Promise.all([
      db.redeemLinkCode(code, { chatId: '4001' }),
      db.redeemLinkCode(code, { chatId: '4002' }),
      db.redeemLinkCode(code, { chatId: '4003' }),
    ]);
    const wins = results.filter((r) => r.ok);
    assert.equal(wins.length, 1, `恰好一個成功，實際 ${wins.length}`);
    assert.ok(results.filter((r) => !r.ok).every((r) => r.reason === 'used'));
  });
});

// ---------------------------------------------------------------------------
// OAuth state
// ---------------------------------------------------------------------------
test('OAuth state：原文不入庫、長度足夠、只存 hash', async () => {
  await withDb(async (db) => {
    const { state } = await db.createOAuthState(ALICE.id, { ttlMs: 60_000 });
    // 32 bytes base64url ≈ 43 字元
    assert.ok(state.length >= 43, `state 至少 32 bytes，實際字元數 ${state.length}`);
    const rows = await db.raw.execute('SELECT state_hash FROM oauth_states');
    assert.notEqual(rows.rows[0].state_hash, state);
    assert.equal(rows.rows[0].state_hash, hashSecret(state));
  });
});

test('OAuth state：valid / replay / expired / invalid', async () => {
  await withDb(async (db) => {
    const { state } = await db.createOAuthState(ALICE.id, { ttlMs: 60_000 });
    assert.deepEqual(await db.consumeOAuthState(state), { ok: true, userId: ALICE.id });
    assert.deepEqual(await db.consumeOAuthState(state), { ok: false, reason: 'consumed' },
      'replay 必須被拒');

    const exp = await db.createOAuthState(ALICE.id, { ttlMs: -1000 });
    assert.deepEqual(await db.consumeOAuthState(exp.state), { ok: false, reason: 'expired' });
    assert.deepEqual(await db.consumeOAuthState('nope'), { ok: false, reason: 'invalid' });
  });
});

test('OAuth state：並發雙 callback 只有一個成功', async () => {
  await withDb(async (db) => {
    const { state } = await db.createOAuthState(ALICE.id, { ttlMs: 60_000 });
    const rs = await Promise.all([
      db.consumeOAuthState(state), db.consumeOAuthState(state), db.consumeOAuthState(state),
    ]);
    assert.equal(rs.filter((r) => r.ok).length, 1);
  });
});

test('OAuth：Alice 的 state 只會把 token 存給 Alice，絕不可能綁到 Bob', async () => {
  await withDb(async (db) => {
    const { state } = await prepareAuthorization({
      db, userId: ALICE.id, clientId: 'cid', redirectUri: 'http://localhost:8788/callback',
    });
    const exchange = async () => ({
      accessToken: 'A-ACC', refreshToken: 'A-REF',
      expiresAt: new Date(Date.now() + 3600_000), scope: 'offline', whoopUserId: 555,
    });
    const res = await completeAuthorization({ db, rawState: state, code: 'code-1', exchange });
    assert.equal(res.userId, ALICE.id);
    assert.equal((await db.getTokens(ALICE.id)).accessToken, 'A-ACC');
    assert.equal(await db.getTokens(BOB.id), null, 'Bob 不可拿到任何 token');
  });
});

test('OAuth：replay 同一個 state 不會再存一次 token', async () => {
  await withDb(async (db) => {
    const { state } = await prepareAuthorization({
      db, userId: ALICE.id, clientId: 'cid', redirectUri: 'http://x/cb',
    });
    let exchanges = 0;
    const exchange = async () => {
      exchanges += 1;
      return {
        accessToken: `ACC-${exchanges}`, refreshToken: 'R',
        expiresAt: new Date(Date.now() + 3600_000), scope: 'offline',
      };
    };
    await completeAuthorization({ db, rawState: state, code: 'c', exchange });
    await assert.rejects(
      () => completeAuthorization({ db, rawState: state, code: 'c', exchange }),
      (err) => err instanceof OAuthFlowError && err.code === 'STATE_CONSUMED',
    );
    assert.equal(exchanges, 1, '第二次不該再打 WHOOP');
    assert.equal((await db.getTokens(ALICE.id)).accessToken, 'ACC-1');
  });
});

test('authorize 前置檢查：未知使用者 / 非 ACTIVE 一律拒絕', async () => {
  await withDb(async (db) => {
    await assert.rejects(() => assertAuthorizable(db, 'u-nobody'),
      (e) => e.code === 'UNKNOWN_USER');
    await db.updateUser(BOB.id, { status: 'PAUSED' });
    await assert.rejects(() => assertAuthorizable(db, BOB.id),
      (e) => e.code === 'USER_NOT_ACTIVE');
    await assert.rejects(() => assertAuthorizable(db, undefined), { name: 'MissingUserIdError' });
  });
});

// ---------------------------------------------------------------------------
// WHOOP 帳號唯一性（DB 層，race-safe）
// ---------------------------------------------------------------------------
test('同一個 WHOOP 帳號不可綁到兩個使用者（DB 層 partial unique index）', async () => {
  await withDb(async (db) => {
    const tok = (u) => ({
      accessToken: `${u}-acc`, refreshToken: `${u}-ref`,
      expiresAt: new Date(Date.now() + 3600_000), scope: 'offline', whoopUserId: 777,
    });
    await db.saveTokens(ALICE.id, tok('a'));
    await assert.rejects(
      () => db.saveTokens(BOB.id, tok('b'), { retries: 1 }),
      /UNIQUE constraint failed/,
    );
    assert.equal(await db.getTokens(BOB.id), null);
    assert.equal(await db.findUserByWhoopUserId(777), ALICE.id);
  });
});

test('並發綁同一個 WHOOP 帳號：恰好一個成功', async () => {
  await withDb(async (db) => {
    const tok = (u) => ({
      accessToken: `${u}-acc`, refreshToken: `${u}-ref`,
      expiresAt: new Date(Date.now() + 3600_000), scope: 'offline', whoopUserId: 888,
    });
    const rs = await Promise.allSettled([
      db.saveTokens(ALICE.id, tok('a'), { retries: 1 }),
      db.saveTokens(BOB.id, tok('b'), { retries: 1 }),
    ]);
    const ok = rs.filter((r) => r.status === 'fulfilled');
    assert.equal(ok.length, 1, `恰好一個成功，實際 ${ok.length}`);
  });
});

test('OAuth 完成時撞到既有 WHOOP 綁定 → 明確錯誤，不洩漏 token', async () => {
  await withDb(async (db) => {
    await db.saveTokens(ALICE.id, {
      accessToken: 'A', refreshToken: 'B',
      expiresAt: new Date(Date.now() + 3600_000), scope: 'offline', whoopUserId: 999,
    });
    const { state } = await prepareAuthorization({
      db, userId: BOB.id, clientId: 'c', redirectUri: 'http://x/cb',
    });
    const exchange = async () => ({
      accessToken: 'SECRET-TOKEN', refreshToken: 'SECRET-REFRESH',
      expiresAt: new Date(Date.now() + 3600_000), scope: 'offline', whoopUserId: 999,
    });
    await assert.rejects(
      () => completeAuthorization({ db, rawState: state, code: 'c', exchange }),
      (err) => {
        assert.equal(err.code, 'WHOOP_ACCOUNT_ALREADY_LINKED');
        assert.ok(!/SECRET-TOKEN|SECRET-REFRESH/.test(err.message), '錯誤訊息不可含 token');
        return true;
      },
    );
    assert.equal(await db.getTokens(BOB.id), null);
  });
});

// ---------------------------------------------------------------------------
// token refresh 併發隔離（真的跑，不只驗字串）
// ---------------------------------------------------------------------------
/** 造一個「快過期」的 token，強迫 refresh。 */
async function seedExpiring(db, userId, tag) {
  await db.saveTokens(userId, {
    accessToken: `${tag}-old`, refreshToken: `${tag}-ref-old`,
    expiresAt: new Date(Date.now() + 60_000), // < 5 分鐘 skew → 會 refresh
    scope: 'offline',
  });
}

/**
 * 本機 token endpoint（跟既有 whoop.test.js 同一套做法）。
 * 只監聽 127.0.0.1，**不對外連線**。記錄每個 refresh_token 被換了幾次。
 */
async function localTokenServer(counter, { delayMs = 0 } = {}) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const rt = new URLSearchParams(body).get('refresh_token');
      counter.push(rt);
      const reply = () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          access_token: `${rt}-NEW`, refresh_token: `${rt}-R2`,
          expires_in: 3600, scope: 'offline',
        }));
      };
      if (delayMs) setTimeout(reply, delayMs); else reply();
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return {
    tokenUrl: `http://127.0.0.1:${port}/oauth/token`,
    close: () => new Promise((r) => server.close(r)),
  };
}

test('Alice 的 token refresh 不會阻塞 Bob（鎖名帶 userId）', async () => {
  await withDb(async (db) => {
    await seedExpiring(db, ALICE.id, 'A');
    await seedExpiring(db, BOB.id, 'B');
    const calls = [];
    const srv = await localTokenServer(calls);
    try {
      const mk = (uid) => createWhoopClient({
        db, userId: uid, clientId: 'c', clientSecret: 's', tokenUrl: srv.tokenUrl,
      });

      const [a, b] = await Promise.all([
        mk(ALICE.id).getAccessToken(),
        mk(BOB.id).getAccessToken(),
      ]);
      assert.equal(a, 'A-ref-old-NEW');
      assert.equal(b, 'B-ref-old-NEW', 'Bob 必須也完成 refresh，不能被 Alice 卡住');
      assert.equal(calls.length, 2, '兩個人各 refresh 一次');
    } finally { await srv.close(); }

    // 鎖名必須帶 userId（否則一個人的 refresh 會卡住所有人）
    assert.equal(db.userLockName(LOCKS.TOKEN_REFRESH_NAME, ALICE.id),
      `${LOCKS.TOKEN_REFRESH_NAME}:${ALICE.id}`);
    assert.notEqual(db.userLockName(LOCKS.TOKEN_REFRESH_NAME, ALICE.id),
      db.userLockName(LOCKS.TOKEN_REFRESH_NAME, BOB.id));
    const locks = await db.raw.execute('SELECT name FROM resource_locks');
    assert.equal(locks.rows.length, 0, '結束後鎖應已釋放');
  });
});

test('同一使用者兩個 process 真正併發 refresh → 只真的 refresh 一次，另一個等待後沿用', async () => {
  const t = tempDb();
  const a = t.make();
  const b = t.make();   // 兩個獨立 client 指向同一個檔案 = 模擬兩個 process
  try {
    await a.migrate();
    await seedAliceAndBob(a);
    await seedExpiring(a, ALICE.id, 'A');
    const calls = [];
    // 刻意讓 token endpoint 慢一點回應，這樣第二個 process 一定會撞到「lock 被佔住」，
    // 真的走 waitForPeerRefresh 的輪詢路徑（不是「先後執行」的沿用路徑）
    const srv = await localTokenServer(calls, { delayMs: 40 });
    try {
      const mk = (db) => createWhoopClient({
        db, userId: ALICE.id, clientId: 'c', clientSecret: 's',
        tokenUrl: srv.tokenUrl,
        // 真的小睡，讓等待方有機會輪詢到對方寫好的新 token
        sleepImpl: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 10))),
      });

      const [t1, t2] = await Promise.all([mk(a).getAccessToken(), mk(b).getAccessToken()]);
      assert.equal(calls.length, 1, `只該有一次真的 refresh，實際 ${calls.length}`);
      assert.equal(t1, t2, '兩邊最後拿到同一個 access token');
      assert.equal(t1, 'A-ref-old-NEW');

      // DB 裡只有這個使用者的一組 token，而且是最新那組
      const rows = await a.raw.execute('SELECT * FROM user_whoop_tokens');
      assert.equal(rows.rows.length, 1);
      assert.equal(rows.rows[0].access_token, 'A-ref-old-NEW');
      assert.equal(String(rows.rows[0].user_id), ALICE.id);
    } finally { await srv.close(); }
  } finally { a.close(); b.close(); t.cleanup(); }
});
