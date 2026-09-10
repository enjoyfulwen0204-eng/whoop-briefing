/**
 * WHOOP 帳號身分不可變、而且 race-safe（R2-M-01）。
 *
 * ## 上一輪修好了什麼、還剩什麼
 *
 * 上一輪讓身分驗證變成授權的必要步驟（問不到就不存 token）。但還有兩個
 * 繞過，而且**兩個都不可能只在應用層關掉**：
 *
 * 1. **既有列的 whoop_user_id 是 NULL。**
 *    第一版的授權流程從來沒有寫過這個欄位，所以舊資料一律是 NULL。
 *    舊版的 `COALESCE(excluded, existing)` 讓新身分覆寫 NULL —— 於是一個
 *    已經累積了 WHOOP#111 健康資料的使用者可以被換成 WHOOP#999，
 *    而歷史資料完全留在原地。實測確認。
 *
 * 2. **同一個未綁定使用者的並發 OAuth。**
 *    兩個 callback 都讀到 NULL、都通過應用層檢查、都寫入，最後一個贏。
 *    實測確認：兩個不同身分都回報成功。SELECT-before-WRITE 永遠關不掉。
 *
 * ## 現在的不變量
 *
 *   一旦某個內部使用者的生理歷史屬於某個 WHOOP 身分，
 *   帳號身分就不可以無聲改變。
 *
 * 兩個機制：
 *   - 權威事實來自**資料本身**（每一列健康資料都帶著 whoop_user_id），
 *     不是可能為 NULL 的 token 列。
 *   - 「NULL → 某個身分」是一個**原子的條件式寫入**（ON CONFLICT ... WHERE），
 *     並發時恰好一個贏，輸的那個拿到 WHOOP_IDENTITY_IMMUTABLE。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createDb } from '../src/db.js';
import {
  OAuthFlowError, completeAuthorization, prepareAuthorization,
} from '../src/oauthFlow.js';

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r2m01-'));
  const db = createDb({ url: `file:${path.join(dir, 't.db')}` });
  return { db, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

async function withUser(fn) {
  const { db, cleanup } = tempDb();
  try {
    await db.migrate();
    const user = await db.createUser({ displayName: 'Alice' });
    await fn(db, user);
  } finally {
    db.close();
    cleanup();
  }
}

const exchange = async () => ({
  accessToken: 'at', refreshToken: 'rt',
  expiresAt: new Date(Date.now() + 3600_000), scope: 'offline',
});

async function authorize(db, userId, whoopId) {
  const { state } = await prepareAuthorization({
    db, userId, clientId: 'c', redirectUri: 'http://x/cb',
  });
  return completeAuthorization({
    db, rawState: state, code: 'c', exchange, verifyIdentity: async () => whoopId,
  });
}

/** 舊版留下的 token 列：有 token，但 whoop_user_id 是 NULL。 */
async function seedLegacyTokenRow(db, userId) {
  await db.raw.execute({
    sql: `INSERT INTO user_whoop_tokens
            (user_id, whoop_user_id, access_token, refresh_token,
             access_token_expires_at, scope, updated_at)
          VALUES (?, NULL, 'old-at', 'old-rt', ?, 'offline', ?)`,
    args: [userId, new Date(Date.now() + 3600_000).toISOString(), new Date().toISOString()],
  });
}

/** 一列真實的健康資料，帶著它來自哪個 WHOOP 帳號。 */
async function seedHealthRow(db, userId, whoopUserId, { id = 's1' } = {}) {
  await db.raw.execute({
    sql: `INSERT INTO whoop_sleeps
            (user_id, id, whoop_user_id, health_date, start_at, end_at,
             nap, score_state, synced_at)
          VALUES (?, ?, ?, '2026-09-01', '2026-09-01T15:00:00Z',
                  '2026-09-01T23:00:00Z', 0, 'SCORED', ?)`,
    args: [userId, id, whoopUserId, new Date().toISOString()],
  });
}

const identityOf = async (db, userId) => (await db.getTokens(userId))?.whoopUserId ?? null;

// ===========================================================================
// ★★★ 繞過 1：legacy NULL identity
// ===========================================================================

test('★★★ R2-M-01: token 列是 NULL 但健康資料屬於別的帳號 → 拒絕綁定', async () => {
  await withUser(async (db, user) => {
    await seedLegacyTokenRow(db, user.id);
    await seedHealthRow(db, user.id, 111);

    await assert.rejects(
      () => authorize(db, user.id, '999'),
      (e) => e instanceof OAuthFlowError && e.code === 'WHOOP_ACCOUNT_MISMATCH',
    );
    assert.equal(await identityOf(db, user.id), null,
      '★ 拒絕之後不可以留下任何身分');
    assert.equal((await db.getTokens(user.id)).accessToken, 'old-at',
      '★ 舊 token 不可以被覆寫');
  });
});

test('★★★ R2-M-01: token 列是 NULL 且健康資料**就是**這個帳號 → 允許補上身分', async () => {
  await withUser(async (db, user) => {
    await seedLegacyTokenRow(db, user.id);
    await seedHealthRow(db, user.id, 111);

    const r = await authorize(db, user.id, '111');
    assert.equal(r.whoopUserId, '111');
    assert.equal(await identityOf(db, user.id), '111',
      '★ 舊資料補上正確的身分是必要的遷移路徑');
  });
});

test('★★★ R2-M-01: 完全沒有健康資料的新使用者可以正常綁定', async () => {
  await withUser(async (db, user) => {
    const r = await authorize(db, user.id, '111');
    assert.equal(r.whoopUserId, '111');
    assert.equal(await identityOf(db, user.id), '111');
  });
});

test('★★★ R2-M-01: 健康資料同時帶著多個帳號 → 資料已汙染，拒絕任何綁定', async () => {
  await withUser(async (db, user) => {
    await seedHealthRow(db, user.id, 111, { id: 's1' });
    await seedHealthRow(db, user.id, 222, { id: 's2' });
    await assert.rejects(
      () => authorize(db, user.id, '111'),
      (e) => e.code === 'IDENTITY_HISTORY_AMBIGUOUS',
    );
    assert.equal(await db.getTokens(user.id), null);
  });
});

test('★★★ R2-M-01: 歷史身分查不到（DB 故障）→ fail closed', async () => {
  await withUser(async (db, user) => {
    const broken = {
      ...db,
      getHistoricalWhoopUserIds: async () => { throw new Error('db down'); },
    };
    await assert.rejects(
      () => authorize(broken, user.id, '111'),
      (e) => e.code === 'IDENTITY_HISTORY_UNREADABLE',
    );
    assert.equal(await db.getTokens(user.id), null, '★ 不確定歸屬就不存 token');
  });
});

// ===========================================================================
// ★★★ 繞過 2：並發 OAuth（儲存層原子性）
// ===========================================================================

test('★★★ R2-M-01: 同一個未綁定使用者的並發 OAuth → 恰好一個成功', async () => {
  await withUser(async (db, user) => {
    const p1 = await prepareAuthorization({ db, userId: user.id, clientId: 'c', redirectUri: 'r' });
    const p2 = await prepareAuthorization({ db, userId: user.id, clientId: 'c', redirectUri: 'r' });

    const rs = await Promise.allSettled([
      completeAuthorization({
        db, rawState: p1.state, code: 'x', exchange, verifyIdentity: async () => 'aaa',
      }),
      completeAuthorization({
        db, rawState: p2.state, code: 'x', exchange, verifyIdentity: async () => 'bbb',
      }),
    ]);
    const ok = rs.filter((r) => r.status === 'fulfilled');
    assert.equal(ok.length, 1, `★ 恰好一個可以成功，實際 ${ok.length}`);
    const rejected = rs.find((r) => r.status === 'rejected');
    assert.equal(rejected.reason.code, 'WHOOP_ACCOUNT_MISMATCH');

    const finalId = await identityOf(db, user.id);
    assert.equal(finalId, ok[0].value.whoopUserId, '★ 最終身分必須是贏的那一個');
  });
});

test('★★★ R2-M-01: 三個並發、三個不同身分 → 仍然只有一個成功', async () => {
  await withUser(async (db, user) => {
    const states = [];
    for (let i = 0; i < 3; i += 1) {
      states.push((await prepareAuthorization({
        db, userId: user.id, clientId: 'c', redirectUri: 'r',
      })).state);
    }
    const rs = await Promise.allSettled(states.map((state, i) => completeAuthorization({
      db, rawState: state, code: 'x', exchange, verifyIdentity: async () => `id-${i}`,
    })));
    assert.equal(rs.filter((r) => r.status === 'fulfilled').length, 1);
  });
});

test('★★★ R2-M-01: 儲存層本身就擋（不靠應用層先讀）', async () => {
  await withUser(async (db, user) => {
    // 直接呼叫 saveTokens，繞過所有應用層檢查
    await db.saveTokens(user.id, {
      accessToken: 'a', refreshToken: 'r',
      expiresAt: new Date(Date.now() + 3600_000), scope: 's', whoopUserId: '111',
    });
    await assert.rejects(
      () => db.saveTokens(user.id, {
        accessToken: 'b', refreshToken: 'r2',
        expiresAt: new Date(Date.now() + 3600_000), scope: 's', whoopUserId: '999',
      }, { retries: 1 }),
      (e) => e.code === 'WHOOP_IDENTITY_IMMUTABLE' && e.currentWhoopUserId === '111',
    );
    assert.equal(await identityOf(db, user.id), '111');
    assert.equal((await db.getTokens(user.id)).accessToken, 'a',
      '★ 身分衝突時連 token 都不可以被換掉');
  });
});

test('★★★ R2-M-01: 身分衝突不重試（那不是暫時性錯誤）', async () => {
  await withUser(async (db, user) => {
    await db.saveTokens(user.id, {
      accessToken: 'a', refreshToken: 'r',
      expiresAt: new Date(Date.now() + 3600_000), scope: 's', whoopUserId: '111',
    });
    let writes = 0;
    const real = db.raw.execute.bind(db.raw);
    db.raw.execute = async (arg) => {
      if (typeof arg === 'object' && arg.sql?.includes('INSERT INTO user_whoop_tokens')) writes += 1;
      return real(arg);
    };
    await assert.rejects(() => db.saveTokens(user.id, {
      accessToken: 'b', refreshToken: 'r',
      expiresAt: new Date(Date.now() + 3600_000), scope: 's', whoopUserId: '999',
    }, { retries: 4 }));
    assert.equal(writes, 1, '★ 只該嘗試一次');
  });
});

// ===========================================================================
// ★★★ 不能破壞 token refresh（那是最危險的失敗）
// ===========================================================================

test('★★★ R2-M-01: token refresh（不帶身分）必須照常寫入並保留身分', async () => {
  await withUser(async (db, user) => {
    await db.saveTokens(user.id, {
      accessToken: 'a1', refreshToken: 'r1',
      expiresAt: new Date(Date.now() + 3600_000), scope: 's', whoopUserId: '111',
    });
    // refresh 路徑：whoop.js 呼叫 saveTokens 時不帶 whoopUserId
    await db.saveTokens(user.id, {
      accessToken: 'a2', refreshToken: 'r2',
      expiresAt: new Date(Date.now() + 7200_000), scope: 's',
    });
    const t = await db.getTokens(user.id);
    assert.equal(t.accessToken, 'a2', '★ 新的 access token 一定要寫進去');
    assert.equal(t.refreshToken, 'r2', '★ 新的 refresh token 一定要寫進去');
    assert.equal(t.whoopUserId, '111', '★ 身分必須被保留');
  });
});

test('★★ R2-M-01: 重新授權同一個帳號 → 換 token，身分不變', async () => {
  await withUser(async (db, user) => {
    await authorize(db, user.id, '111');
    await db.saveTokens(user.id, {
      accessToken: 'a3', refreshToken: 'r3',
      expiresAt: new Date(Date.now() + 3600_000), scope: 's', whoopUserId: '111',
    });
    const t = await db.getTokens(user.id);
    assert.equal(t.accessToken, 'a3');
    assert.equal(t.whoopUserId, '111');
  });
});

// ===========================================================================
// ★★★ 跨使用者唯一性（既有保證不可以退化）
// ===========================================================================

test('★★★ R2-M-01: 同一個 WHOOP 帳號仍然不可綁到兩個內部使用者', async () => {
  await withUser(async (db, alice) => {
    const bob = await db.createUser({ displayName: 'Bob' });
    await authorize(db, alice.id, '111');
    await assert.rejects(
      () => authorize(db, bob.id, '111'),
      (e) => e.code === 'WHOOP_ACCOUNT_ALREADY_LINKED',
    );
    assert.equal(await db.getTokens(bob.id), null);
  });
});

test('★★★ R2-M-01: 兩人並發綁同一個 WHOOP 帳號 → 恰好一個成功', async () => {
  await withUser(async (db, alice) => {
    const bob = await db.createUser({ displayName: 'Bob' });
    const pa = await prepareAuthorization({ db, userId: alice.id, clientId: 'c', redirectUri: 'r' });
    const pb = await prepareAuthorization({ db, userId: bob.id, clientId: 'c', redirectUri: 'r' });
    const rs = await Promise.allSettled([
      completeAuthorization({ db, rawState: pa.state, code: 'x', exchange, verifyIdentity: async () => 'same' }),
      completeAuthorization({ db, rawState: pb.state, code: 'x', exchange, verifyIdentity: async () => 'same' }),
    ]);
    assert.equal(rs.filter((r) => r.status === 'fulfilled').length, 1);
  });
});

// ===========================================================================
// ★★★ 遷移安全：有資料的資料庫
// ===========================================================================

test('★★★ R2-M-01 遷移安全: 有 token + 有健康資料的舊庫，migrate 不動任何一列', async () => {
  const { db, cleanup } = tempDb();
  try {
    await db.migrate();
    const user = await db.createUser({ displayName: 'Alice' });
    await seedLegacyTokenRow(db, user.id);
    await seedHealthRow(db, user.id, 111);

    const before = await db.raw.execute({
      sql: 'SELECT * FROM user_whoop_tokens WHERE user_id = ?', args: [user.id],
    });
    const sleepsBefore = await db.raw.execute({
      sql: 'SELECT * FROM whoop_sleeps WHERE user_id = ?', args: [user.id],
    });

    const summary = await db.migrate();
    assert.deepEqual(summary.rebuilt, [], '★ 不可以重建任何表');

    const after = await db.raw.execute({
      sql: 'SELECT * FROM user_whoop_tokens WHERE user_id = ?', args: [user.id],
    });
    assert.deepEqual(after.rows, before.rows, '★ token 列一個位元都不可以變');
    const sleepsAfter = await db.raw.execute({
      sql: 'SELECT * FROM whoop_sleeps WHERE user_id = ?', args: [user.id],
    });
    assert.deepEqual(sleepsAfter.rows, sleepsBefore.rows, '★ 健康資料一列都不可以變');

    // 遷移後仍然拿得到歷史身分
    assert.deepEqual(await db.getHistoricalWhoopUserIds(user.id), ['111']);
  } finally {
    db.close();
    cleanup();
  }
});

test('★★ R2-M-01: getHistoricalWhoopUserIds 沒有資料時回空陣列', async () => {
  await withUser(async (db, user) => {
    assert.deepEqual(await db.getHistoricalWhoopUserIds(user.id), []);
  });
});

test('★★ R2-M-01: 歷史身分只看自己的資料', async () => {
  await withUser(async (db, alice) => {
    const bob = await db.createUser({ displayName: 'Bob' });
    await seedHealthRow(db, alice.id, 111, { id: 'a1' });
    await seedHealthRow(db, bob.id, 222, { id: 'b1' });
    assert.deepEqual(await db.getHistoricalWhoopUserIds(alice.id), ['111']);
    assert.deepEqual(await db.getHistoricalWhoopUserIds(bob.id), ['222']);
  });
});
