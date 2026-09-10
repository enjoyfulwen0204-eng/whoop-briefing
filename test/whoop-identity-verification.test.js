/**
 * WHOOP 帳號身分驗證（M-01）。
 *
 * ## 修的是什麼
 *
 * `schema.js` 有 partial unique index、`db.js` 有 `findUserByWhoopUserId()`、
 * `oauthFlow.js` 的註解宣稱「同一個 WHOOP 帳號不允許綁到兩個內部使用者」。
 * 但正式路徑上 `user_whoop_tokens.whoop_user_id` **永遠是 NULL**：
 * WHOOP 的 token endpoint 不回傳身分，`postToken()` 因此沒有 `whoopUserId`，
 * 而 index 的條件正是 `WHERE whoop_user_id IS NOT NULL`。
 *
 * 也就是說整套防護在真實授權流程裡一次都沒有生效過。實測：Alice 與 Bob
 * 先後授權同一個 WHOOP 帳號，兩次都成功，兩筆都是 NULL。
 *
 * ## 現在的不變量
 *
 *   **絕不捏造身分。** 沒有經過驗證的 WHOOP 身分 → 不存 token。
 *   一個 WHOOP 帳號只能屬於一個內部使用者；一個內部使用者的 WHOOP 帳號
 *   一旦確定就不可以被換掉（換掉等於把舊帳號的健康資料重新歸屬給新帳號）。
 *
 * 不呼叫真實 WHOOP —— verifyIdentity / fetch 全部注入。
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
import { fetchWhoopUserId } from '../src/whoop.js';

async function withDb(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm01-'));
  const db = createDb({ url: `file:${path.join(dir, 't.db')}` });
  try {
    await db.migrate();
    const alice = await db.createUser({ displayName: 'Alice' });
    const bob = await db.createUser({ displayName: 'Bob' });
    await fn(db, alice, bob);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** 真實形狀的 exchange：postToken() 就是這樣，**沒有** whoopUserId。 */
const realShapeExchange = async () => ({
  accessToken: 'ACC', refreshToken: 'REF',
  expiresAt: new Date(Date.now() + 3600_000), scope: 'offline read:sleep',
});

async function authorize(db, userId, verifyIdentity, exchange = realShapeExchange) {
  const { state } = await prepareAuthorization({
    db, userId, clientId: 'c', redirectUri: 'http://x/cb',
  });
  return completeAuthorization({ db, rawState: state, code: 'c', exchange, verifyIdentity });
}

// ===========================================================================
// ★★★ fail-closed：沒有身分就沒有 token
// ===========================================================================

test('★★★ M-01: 沒有提供 verifyIdentity → 拒絕授權，token 不入庫', async () => {
  await withDb(async (db, alice) => {
    await assert.rejects(
      () => authorize(db, alice.id, undefined),
      (e) => e instanceof OAuthFlowError && e.code === 'IDENTITY_UNVERIFIED',
    );
    assert.equal(await db.getTokens(alice.id), null, '★ token 絕不可以被存下來');
  });
});

test('★★★ M-01: 身分查詢失敗 → 拒絕授權，token 不入庫', async () => {
  await withDb(async (db, alice) => {
    await assert.rejects(
      () => authorize(db, alice.id, async () => { throw new Error('network down'); }),
      (e) => e.code === 'IDENTITY_UNVERIFIED',
    );
    assert.equal(await db.getTokens(alice.id), null);
  });
});

for (const [name, value] of [['空字串', ''], ['空白', '   '], ['null', null], ['undefined', undefined]]) {
  test(`★★ M-01: 身分查詢回 ${name} → 拒絕授權（fail-closed）`, async () => {
    await withDb(async (db, alice) => {
      await assert.rejects(
        () => authorize(db, alice.id, async () => value),
        (e) => e.code === 'IDENTITY_UNVERIFIED',
      );
      assert.equal(await db.getTokens(alice.id), null);
    });
  });
}

test('★★ M-01: 錯誤訊息絕不含 token', async () => {
  await withDb(async (db, alice) => {
    const exchange = async () => ({
      accessToken: 'SECRET-TOKEN', refreshToken: 'SECRET-REFRESH',
      expiresAt: new Date(Date.now() + 3600_000), scope: 'offline',
    });
    await assert.rejects(
      () => authorize(db, alice.id, async () => { throw new Error('boom'); }, exchange),
      (e) => {
        assert.ok(!/SECRET-TOKEN|SECRET-REFRESH/.test(e.message), '★ 錯誤訊息不可洩漏 token');
        return true;
      },
    );
  });
});

// ===========================================================================
// ★★★ 一個 WHOOP 帳號只能屬於一個內部使用者
// ===========================================================================

test('★★★ M-01: 真實 exchange 形狀下，同一個 WHOOP 帳號綁不到第二個人', async () => {
  await withDb(async (db, alice, bob) => {
    const r = await authorize(db, alice.id, async () => '111');
    assert.equal(r.whoopUserId, '111', '★ 身分必須真的被寫下來');
    assert.equal((await db.getTokens(alice.id)).whoopUserId, '111');

    await assert.rejects(
      () => authorize(db, bob.id, async () => '111'),
      (e) => e.code === 'WHOOP_ACCOUNT_ALREADY_LINKED',
    );
    assert.equal(await db.getTokens(bob.id), null, '★ Bob 絕不可以拿到 token');
  });
});

test('★★ M-01: 不同的 WHOOP 帳號可以正常各自授權（沒有把功能鎖死）', async () => {
  await withDb(async (db, alice, bob) => {
    await authorize(db, alice.id, async () => '111');
    await authorize(db, bob.id, async () => '222');
    assert.equal((await db.getTokens(alice.id)).whoopUserId, '111');
    assert.equal((await db.getTokens(bob.id)).whoopUserId, '222');
  });
});

// ===========================================================================
// ★★★ 已確定的身分不可以被換掉
// ===========================================================================

test('★★★ M-01: 同一個使用者改綁另一個 WHOOP 帳號 → 拒絕', async () => {
  await withDb(async (db, alice) => {
    await authorize(db, alice.id, async () => '111');
    await assert.rejects(
      () => authorize(db, alice.id, async () => '999'),
      (e) => e.code === 'WHOOP_ACCOUNT_MISMATCH',
    );
    assert.equal((await db.getTokens(alice.id)).whoopUserId, '111',
      '★ 身分不可以被換掉，否則舊帳號的健康資料會被錯誤歸屬');
    assert.equal((await db.getTokens(alice.id)).accessToken, 'ACC');
  });
});

test('★★ M-01: 同一個使用者重新授權同一個 WHOOP 帳號 → 正常換新 token', async () => {
  await withDb(async (db, alice) => {
    await authorize(db, alice.id, async () => '111');
    const r = await authorize(db, alice.id, async () => '111', async () => ({
      accessToken: 'ACC-2', refreshToken: 'REF-2',
      expiresAt: new Date(Date.now() + 3600_000), scope: 'offline',
    }));
    assert.equal(r.whoopUserId, '111');
    assert.equal((await db.getTokens(alice.id)).accessToken, 'ACC-2', '★ 換 token 必須仍然可行');
  });
});

test('★★ M-01: exchange 自己就帶了身分時，不用再查一次', async () => {
  await withDb(async (db, alice) => {
    let asked = 0;
    const r = await authorize(db, alice.id, async () => { asked += 1; return '999'; }, async () => ({
      accessToken: 'A', refreshToken: 'R',
      expiresAt: new Date(Date.now() + 3600_000), scope: 'offline', whoopUserId: 555,
    }));
    assert.equal(r.whoopUserId, '555');
    assert.equal(asked, 0, '已經有身分就不必多打一次 WHOOP');
  });
});

// ===========================================================================
// fetchWhoopUserId 本身
// ===========================================================================

test('★★ M-01: fetchWhoopUserId 只取 user_id，不回傳姓名 / email', async () => {
  const fetchImpl = async (url, init) => {
    assert.match(url, /\/user\/profile\/basic$/);
    assert.equal(init.headers.Authorization, 'Bearer AT');
    return {
      ok: true, status: 200,
      json: async () => ({
        user_id: 12345, email: 'a@b.c', first_name: 'Kelvin', last_name: 'L',
      }),
    };
  };
  const id = await fetchWhoopUserId({ accessToken: 'AT', fetchImpl });
  assert.equal(id, '12345');
});

for (const [name, res] of [
  ['缺 user_id', { ok: true, status: 200, json: async () => ({ email: 'a@b.c' }) }],
  ['user_id 為 0', { ok: true, status: 200, json: async () => ({ user_id: 0 }) }],
  ['user_id 為 null', { ok: true, status: 200, json: async () => ({ user_id: null }) }],
  ['非 JSON', { ok: true, status: 200, json: async () => { throw new Error('bad'); } }],
  ['401', { ok: false, status: 401, text: async () => 'unauthorized' }],
  ['500', { ok: false, status: 500, text: async () => 'boom' }],
]) {
  test(`★★ M-01: fetchWhoopUserId ${name} → 拋錯（絕不回猜的值）`, async () => {
    await assert.rejects(() => fetchWhoopUserId({ accessToken: 'AT', fetchImpl: async () => res }));
  });
}

test('★★ M-01: fetchWhoopUserId 沒有 access token 就直接拒絕', async () => {
  await assert.rejects(() => fetchWhoopUserId({ accessToken: null, fetchImpl: async () => {
    throw new Error('不該被呼叫');
  } }));
});

test('★★ M-01: fetchWhoopUserId 網路失敗 → 拋錯', async () => {
  await assert.rejects(() => fetchWhoopUserId({
    accessToken: 'AT', fetchImpl: async () => { throw new Error('ECONNRESET'); },
  }));
});
