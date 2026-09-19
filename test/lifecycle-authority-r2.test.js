/**
 * V1.2 Phase 3.5 — 帳號啟用權責的**端到端**化（R2，schema v18）。
 *
 * ## R1 錯在哪裡
 *
 * R1 建立了正確的架構（lifecycle_generation），但把啟用脈絡做成**選用**的：
 * 沒傳就安靜地退化成「只檢查 ACTIVE」。於是安全性被押在「每個呼叫端都記得
 * 傳」上面，而獨立稽核找到的正是那些忘記傳的正式路徑。
 *
 * R2 的鎖定規則：**正式的健康處理路徑不可以有選用的啟用權責。**
 * 缺少脈絡要大聲失敗（LifecycleContextError），真的要豁免必須寫出
 * LIFECYCLE_UNFENCED —— 那是一個 grep 得到、code review 看得到的決定。
 *
 * 這個檔案涵蓋 LIFE-FG-01 … LIFE-FG-10 的十個封閉證明。
 * 全部用真實 libSQL，競態用 hook 造，不用 sleep。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createDb } from '../src/db.js';
import { handleUnlinkedMessage, handleOnboardingMessage } from '../src/onboarding.js';
import { createWhoopOAuthCallback } from '../src/whoopOAuthCallback.js';
import { completeAuthorization } from '../src/oauthFlow.js';
import { createSync } from '../src/sync.js';
import { probeCapabilities } from '../src/capabilities.js';
import { createWhoopClient } from '../src/whoop.js';
import { deliverReport, DELIVERY_RESULT } from '../src/reportDelivery.js';
import {
  LIFECYCLE_UNFENCED, LifecycleContextError, withDeliveryAuthorization } from '../src/accountLifecycle.js';
import {
  ONBOARDING_STATE, USER_STATUS, ANALYTICS_CLASS, REPORT_DELIVERY_STATE, SCHEMA_VERSION,
} from '../src/schema.js';

const NOW = new Date('2026-09-15T12:00:00.000Z');
const HOUR = 3_600_000;
const CLIENT_ID = 'test-client';
const REDIRECT = 'https://example.test/whoop/oauth/callback';
const A_CHAT = '611111';
const INACTIVE = [USER_STATUS.PAUSED, USER_STATUS.DISABLED];

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whoop-r2-'));
  return {
    url: `file:${path.join(dir, 't.db')}`,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}
async function env() {
  const t = tempDir();
  const db = createDb({ url: t.url });
  await db.migrate();
  return { db, done: () => { try { db.close(); } catch { /* ignore */ } t.cleanup(); } };
}

const privateMessage = (chatId, text) => ({
  message_id: 1, text,
  chat: { id: Number(chatId), type: 'private' },
  from: { id: Number(chatId), is_bot: false, first_name: 'Amy' },
});
const onb = (db, chatId, text, opts = {}) => handleUnlinkedMessage({
  db, text, chatId, message: privateMessage(chatId, text), isPrivateChat: true,
  clientId: CLIENT_ID, redirectUri: REDIRECT, now: NOW, ...opts,
});
const linked = (db, user, text, opts = {}) => handleOnboardingMessage({
  db, user, text, clientId: CLIENT_ID, redirectUri: REDIRECT, now: NOW, ...opts,
});
const userFor = async (db, chatId) => (await db.resolveUserByChatId(String(chatId)))?.user ?? null;
const urlIn = (r) => /https:\/\/\S+/.exec(r)?.[0] ?? null;
const stateFromUrl = (u) => new URL(u).searchParams.get('state');
const lifeOf = async (db, id) => (await db.getUser(id))?.lifecycleGeneration ?? null;

const backend = ({ whoopUserId = 'W1' } = {}) => ({
  exchange: async ({ code }) => {
    if (!code || code === 'bad') throw new Error('invalid_grant');
    return {
      accessToken: `at-${whoopUserId}`, refreshToken: `rt-${whoopUserId}`,
      expiresAt: new Date(NOW.getTime() + HOUR), scope: 'offline read:sleep read:recovery',
    };
  },
  verifyIdentity: async () => whoopUserId,
});

async function authorize(db, chatId, { whoopUserId = 'W1' } = {}) {
  await onb(db, chatId, '/start');
  const user = await userFor(db, chatId);
  const reply = await linked(db, user, 'Asia/Taipei');
  const cb = createWhoopOAuthCallback({ db, ...backend({ whoopUserId }), now: () => NOW });
  assert.equal((await cb({
    query: new URLSearchParams({ code: 'good', state: stateFromUrl(urlIn(reply)) }),
  })).outcome, 'ok');
  return await db.getUser(user.id);
}

/** ACTIVE(L) → 非 ACTIVE(L+1) → ACTIVE(L+2)。回傳舊世代 L。 */
async function aba(db, userId, via = USER_STATUS.DISABLED) {
  const before = await lifeOf(db, userId);
  await db.transitionUserLifecycle({ userId, targetStatus: via });
  await db.transitionUserLifecycle({ userId, targetStatus: USER_STATUS.ACTIVE });
  assert.equal(await lifeOf(db, userId), before + 2);
  assert.equal((await db.getUser(userId)).status, USER_STATUS.ACTIVE);
  return before;
}

// ===========================================================================
// §5 契約：正式健康路徑不可以有選用的啟用權責
// ===========================================================================

test('R2-API-01 ★★★ 正式健康 API 缺少啟用脈絡 → 大聲失敗，不是安靜地不設防', async () => {
  const e = await env();
  try {
    const user = await authorize(e.db, A_CHAT);
    const whoop = { sleeps: async () => [], recoveries: async () => [], cycles: async () => [], workouts: async () => [], bodyMeasurement: async () => null };

    assert.throws(
      () => createSync({ db: e.db, whoop, userId: user.id, timezone: 'Asia/Taipei', now: NOW }),
      LifecycleContextError, '★★★ createSync 少了脈絡必須拋錯',
    );
    await assert.rejects(
      () => probeCapabilities({ db: e.db, whoop, userId: user.id, timezone: 'Asia/Taipei', now: NOW }),
      LifecycleContextError, '★★★ probeCapabilities 少了脈絡必須拋錯',
    );
    const snapshot = await e.db.getTokens(user.id);
    assert.throws(
      () => createWhoopClient({
        db: e.db, userId: user.id, clientId: 'c', clientSecret: 's', authorization: snapshot,
      }),
      LifecycleContextError, '★★★ 受授權約束的 client 也必須帶啟用脈絡',
    );

    // ★ R3 / R2-FG-01：連**不受授權約束**的一般 client 也不可以少了啟用脈絡 ——
    // 那正是排程器、手動同步、對帳會做例行 refresh 的那種 client。
    assert.throws(
      () => createWhoopClient({ db: e.db, userId: user.id, clientId: 'c', clientSecret: 's' }),
      LifecycleContextError, '★★★ 一般執行期 client 少了脈絡必須拋錯',
    );

    // 明確的豁免可以用（而且看得見）
    assert.ok(createSync({
      db: e.db, whoop, userId: user.id, timezone: 'Asia/Taipei',
      expectedLifecycleGeneration: LIFECYCLE_UNFENCED, now: NOW,
    }));
    assert.ok(createSync({
      db: e.db, whoop, userId: user.id, timezone: 'Asia/Taipei',
      expectedLifecycleGeneration: 1, now: NOW,
    }));
  } finally { e.done(); }
});

// ===========================================================================
// §42 TRANS：轉移原子性與併發
// ===========================================================================

test('TRANS-01/02/05 基本轉移與冪等', async () => {
  const e = await env();
  try {
    const u = await authorize(e.db, A_CHAT);
    const a = await e.db.transitionUserLifecycle({ userId: u.id, targetStatus: USER_STATUS.DISABLED });
    assert.deepEqual([a.changed, a.oldGeneration, a.newGeneration], [true, 1, 2]);
    const b = await e.db.transitionUserLifecycle({ userId: u.id, targetStatus: USER_STATUS.ACTIVE });
    assert.deepEqual([b.changed, b.oldGeneration, b.newGeneration], [true, 2, 3]);
    const c = await e.db.transitionUserLifecycle({ userId: u.id, targetStatus: USER_STATUS.ACTIVE });
    assert.equal(c.changed, false, 'TRANS-05 同狀態不推世代');
    assert.equal(await lifeOf(e.db, u.id), 3);
  } finally { e.done(); }
});

test('TRANS-03/04/07 ★★★ 併發轉移：世代單調、呼叫端拿到的是它真的提交的那一次', async () => {
  const e = await env();
  try {
    const u = await authorize(e.db, A_CHAT);
    // 併發：兩個轉移同時提交。在單一檔案的 libsql 上，落敗的一方可能拿到
    // 可重試的 SQLITE_BUSY —— 那是**可接受**的結果（什麼都沒提交），
    // 不可接受的是「回報了一次沒發生的轉移」或世代跳號。
    const settle = (p) => p.then((v) => ({ ok: true, v }), (err) => ({ ok: false, err }));
    const [o1, o2] = await Promise.all([
      settle(e.db.transitionUserLifecycle({ userId: u.id, targetStatus: USER_STATUS.PAUSED })),
      settle(e.db.transitionUserLifecycle({ userId: u.id, targetStatus: USER_STATUS.DISABLED })),
    ]);
    for (const o of [o1, o2]) {
      if (!o.ok) {
        assert.match(String(o.err?.message ?? ''), /SQLITE_BUSY|database is locked/,
          '★ 唯一可接受的失敗是可重試的鎖競爭');
      }
    }
    const results = [o1, o2].filter((o) => o.ok).map((o) => o.v);
    assert.ok(results.length >= 1, '★ 至少一個要成功');
    const [r1, r2] = [results[0], results[1] ?? { changed: false, reason: 'busy' }];
    const committed = results.filter((r) => r.changed);
    assert.equal(committed.length >= 1, true);
    const finalUser = await e.db.getUser(u.id);
    // 世代恰好等於實際提交的次數（單調、不重複、不遺漏）
    assert.equal(finalUser.lifecycleGeneration, 1 + committed.length,
      '★★★ 每一次真正的狀態改變恰好 +1');
    for (const r of committed) {
      // ★★★ 呼叫端回報的轉移必須是它自己提交的那一次
      assert.equal(r.newGeneration, r.oldGeneration + 1);
      assert.notEqual(r.oldStatus, r.newStatus, '★★★ 不可以回報一次沒發生的轉移');
    }
    for (const r of [r1, r2].filter((x) => x && !x.changed)) {
      assert.ok(['already', 'concurrent_transition', 'busy'].includes(r.reason), `reason=${r.reason}`);
    }
    // TRANS-04 反向併發（DISABLED/PAUSED → ACTIVE vs → PAUSED）
    const [o3, o4] = await Promise.all([
      settle(e.db.transitionUserLifecycle({ userId: u.id, targetStatus: USER_STATUS.ACTIVE })),
      settle(e.db.transitionUserLifecycle({ userId: u.id, targetStatus: USER_STATUS.PAUSED })),
    ]);
    const ok34 = [o3, o4].filter((o) => o.ok).map((o) => o.v);
    const after = await e.db.getUser(u.id);
    assert.ok([USER_STATUS.ACTIVE, USER_STATUS.PAUSED, USER_STATUS.DISABLED].includes(after.status));
    assert.equal(after.lifecycleGeneration,
      finalUser.lifecycleGeneration + ok34.filter((r) => r.changed).length,
      '★★★ 世代恰好等於實際提交的轉移次數');
    for (const r of ok34.filter((x) => x.changed)) {
      assert.equal(r.newGeneration, r.oldGeneration + 1);
      assert.notEqual(r.oldStatus, r.newStatus);
    }
  } finally { e.done(); }
});

test('TRANS-06 ★★★ 沒有「新世代 ACTIVE + 舊 READY」可被排程的中間態', async () => {
  const e = await env();
  try {
    const u = await authorize(e.db, A_CHAT);
    await e.db.setOnboardingState(u.id, ONBOARDING_STATE.READY, { ready: true, now: NOW });
    await e.db.transitionUserLifecycle({ userId: u.id, targetStatus: USER_STATUS.DISABLED });
    // 重新啟用：狀態、世代、READY 降級、額度歸零全部在同一個交易裡
    await e.db.transitionUserLifecycle({ userId: u.id, targetStatus: USER_STATUS.ACTIVE });
    const row = await e.db.getOnboardingRow(u.id);
    assert.notEqual(row.state, ONBOARDING_STATE.READY,
      '★★★ 轉移提交之後不可能看到「ACTIVE 新世代 + 舊 READY」');
    assert.equal(row.bootstrapAttempts, 0);
    assert.deepEqual(
      (await e.db.listSchedulableUsers({ activeStatus: USER_STATUS.ACTIVE })).map((x) => x.id), [],
    );
  } finally { e.done(); }
});

// ===========================================================================
// §43 REFRESH-LIFE：例行 refresh 的啟用 CAS（LIFE-FG-01）
// ===========================================================================

for (const via of INACTIVE) {
  test(`REFRESH-LIFE-01/${via} 停用之後舊世代的 refresh 不可以落地`, async () => {
    const e = await env();
    try {
      const u = await authorize(e.db, A_CHAT);
      const before = await e.db.getTokens(u.id);
      await e.db.transitionUserLifecycle({ userId: u.id, targetStatus: via });
      const ok = await e.db.saveTokens(u.id, {
        accessToken: 'rotated', refreshToken: 'rotated-rt',
        expiresAt: new Date(NOW.getTime() + HOUR), scope: 'offline', whoopUserId: 'W1',
      }, {
        expectedUpdatedAt: before.updatedAt, expectedAuthGeneration: before.authGeneration,
        expectedLifecycleGeneration: before.lifecycleGeneration ?? 1,
      });
      assert.equal(ok, false, '★★★ 停用帳號不可以被寫入輪替後的憑證');
      assert.equal((await e.db.getTokens(u.id)).accessToken, before.accessToken);
    } finally { e.done(); }
  });

  test(`REFRESH-LIFE-02/${via} ★★★ ABA 之後舊世代的 refresh 仍然被拒`, async () => {
    const e = await env();
    try {
      const u = await authorize(e.db, A_CHAT);
      const before = await e.db.getTokens(u.id);
      const oldLife = await aba(e.db, u.id, via);
      const ok = await e.db.saveTokens(u.id, {
        accessToken: 'rotated', refreshToken: 'rotated-rt',
        expiresAt: new Date(NOW.getTime() + HOUR), scope: 'offline', whoopUserId: 'W1',
      }, {
        expectedUpdatedAt: before.updatedAt, expectedAuthGeneration: before.authGeneration,
        expectedLifecycleGeneration: oldLife,
      });
      assert.equal(ok, false, '★★★ status 又是 ACTIVE、授權世代也沒變 —— 只有啟用世代擋得住');
      assert.equal((await e.db.getTokens(u.id)).accessToken, before.accessToken);
    } finally { e.done(); }
  });
}

test('REFRESH-LIFE-03 同一啟用世代的例行 refresh 照常成功，且不動授權世代', async () => {
  const e = await env();
  try {
    const u = await authorize(e.db, A_CHAT);
    const before = await e.db.getTokens(u.id);
    const ok = await e.db.saveTokens(u.id, {
      accessToken: 'rotated', refreshToken: 'rotated-rt',
      expiresAt: new Date(NOW.getTime() + HOUR), scope: 'offline', whoopUserId: 'W1',
    }, {
      expectedUpdatedAt: before.updatedAt, expectedAuthGeneration: before.authGeneration,
      expectedLifecycleGeneration: before.lifecycleGeneration ?? 1,
    });
    assert.notEqual(ok, false, '★★★ 同世代的輪替憑證必須寫得進去（不可以因為修正而壞掉）');
    const after = await e.db.getTokens(u.id);
    assert.equal(after.accessToken, 'rotated');
    assert.equal(after.authGeneration, before.authGeneration, '★ 例行 refresh 不動授權世代');
    assert.equal(after.lifecycleGeneration, before.lifecycleGeneration, '★ 也不動啟用世代');
  } finally { e.done(); }
});

test('REFRESH-LIFE-04/05 授權世代 CAS 仍然獨立有效（重新授權競態不受影響）', async () => {
  const e = await env();
  try {
    const u = await authorize(e.db, A_CHAT);
    const before = await e.db.getTokens(u.id);
    // 使用者重新授權（授權世代 +1，啟用世代不動）
    await e.db.saveTokens(u.id, {
      accessToken: 'reauth', refreshToken: 'reauth-rt',
      expiresAt: new Date(NOW.getTime() + HOUR), scope: 'offline', whoopUserId: 'W1',
    }, { bumpAuthGeneration: true });
    const after = await e.db.getTokens(u.id);
    assert.equal(after.authGeneration, before.authGeneration + 1);
    assert.equal(after.lifecycleGeneration, before.lifecycleGeneration, '★★★ 重新授權不動啟用世代');
    // 舊的 refresh 仍然被授權世代 CAS 擋下
    const stale = await e.db.saveTokens(u.id, {
      accessToken: 'stale', refreshToken: 'stale-rt',
      expiresAt: new Date(NOW.getTime() + HOUR), scope: 'offline', whoopUserId: 'W1',
    }, {
      expectedUpdatedAt: before.updatedAt, expectedAuthGeneration: before.authGeneration,
      expectedLifecycleGeneration: before.lifecycleGeneration ?? 1,
    });
    assert.equal(stale, false);
    assert.equal((await e.db.getTokens(u.id)).accessToken, 'reauth', '★ 新授權的憑證原封不動');
  } finally { e.done(); }
});

// ===========================================================================
// §44 OAUTH-LIFE：交換完成之後、持久化之前（LIFE-FG-02）
// ===========================================================================

for (const via of INACTIVE) {
  test(`OAUTH-LIFE-01/${via} ★★★ provider 交換期間被停用 → 不得持久化`, async () => {
    const e = await env();
    try {
      await onb(e.db, A_CHAT, '/start');
      const user = await userFor(e.db, A_CHAT);
      const reply = await linked(e.db, user, 'Asia/Taipei');
      const state = stateFromUrl(urlIn(reply));

      // 交換**成功**，但在它回來之前帳號被停用
      const res = await completeAuthorization({
        db: e.db, rawState: state, code: 'good', now: NOW,
        exchange: async () => {
          await e.db.transitionUserLifecycle({ userId: user.id, targetStatus: via });
          return {
            accessToken: 'at-late', refreshToken: 'rt-late',
            expiresAt: new Date(NOW.getTime() + HOUR), scope: 'offline',
          };
        },
        verifyIdentity: async () => 'W1',
      }).then(() => null, (err) => err);

      assert.ok(res, '★★★ 交換前檢查通過不代表可以持久化');
      assert.equal(res.code, 'ACCOUNT_INACTIVE');
      assert.equal(await e.db.getTokens(user.id), null, '★★★ 一個 token 都不可以寫入');
      assert.notEqual((await e.db.getOnboarding(user.id)).state, ONBOARDING_STATE.WHOOP_AUTHORIZED);
    } finally { e.done(); }
  });

  test(`OAUTH-LIFE-02/${via} ★★★ 交換期間 ABA → 仍然不得持久化`, async () => {
    const e = await env();
    try {
      await onb(e.db, A_CHAT, '/start');
      const user = await userFor(e.db, A_CHAT);
      const reply = await linked(e.db, user, 'Asia/Taipei');
      const state = stateFromUrl(urlIn(reply));

      const res = await completeAuthorization({
        db: e.db, rawState: state, code: 'good', now: NOW,
        exchange: async () => {
          await aba(e.db, user.id, via);   // 回到 ACTIVE，但世代 +2
          return {
            accessToken: 'at-late', refreshToken: 'rt-late',
            expiresAt: new Date(NOW.getTime() + HOUR), scope: 'offline',
          };
        },
        verifyIdentity: async () => 'W1',
      }).then(() => null, (err) => err);

      assert.ok(res, '★★★ status 又是 ACTIVE —— 只有啟用世代分得出來');
      assert.equal(res.code, 'ACCOUNT_INACTIVE');
      assert.equal(await e.db.getTokens(user.id), null);
    } finally { e.done(); }
  });

  test(`OAUTH-LIFE-03/${via} 交換失敗 + 啟用改變 → 不得寫入舊世代的失敗結論`, async () => {
    const e = await env();
    try {
      await onb(e.db, A_CHAT, '/start');
      const user = await userFor(e.db, A_CHAT);
      const reply = await linked(e.db, user, 'Asia/Taipei');
      const state = stateFromUrl(urlIn(reply));
      const cb = createWhoopOAuthCallback({
        db: e.db, now: () => NOW, verifyIdentity: async () => 'W1',
        exchange: async () => { await aba(e.db, user.id, via); throw new Error('provider down'); },
      });
      const out = await cb({ query: new URLSearchParams({ code: 'good', state }) });
      assert.notEqual(out.outcome, 'ok');
      const o = await e.db.getOnboarding(user.id);
      assert.notEqual(o.failureCode, 'TOKEN_EXCHANGE_FAILED',
        '★★★ 舊啟用期的失敗不可以寫進新的啟用期');
    } finally { e.done(); }
  });
}

test('OAUTH-LIFE-04 同一啟用世代的授權照常完成', async () => {
  const e = await env();
  try {
    const user = await authorize(e.db, A_CHAT);
    assert.ok((await e.db.getTokens(user.id)).accessToken);
    assert.equal((await e.db.getOnboarding(user.id)).state, ONBOARDING_STATE.WHOOP_AUTHORIZED);
  } finally { e.done(); }
});

test('OAUTH-LIFE-05 §13 被啟用擋下的 callback 仍然燒掉一次性 state（不可重放）', async () => {
  const e = await env();
  try {
    await onb(e.db, A_CHAT, '/start');
    const user = await userFor(e.db, A_CHAT);
    const reply = await linked(e.db, user, 'Asia/Taipei');
    const state = stateFromUrl(urlIn(reply));
    await e.db.transitionUserLifecycle({ userId: user.id, targetStatus: USER_STATUS.DISABLED });
    const cb = createWhoopOAuthCallback({ db: e.db, ...backend(), now: () => NOW });
    assert.notEqual((await cb({ query: new URLSearchParams({ code: 'good', state }) })).outcome, 'ok');
    // 重新啟用之後，同一條 state 仍然不可用
    await e.db.transitionUserLifecycle({ userId: user.id, targetStatus: USER_STATUS.ACTIVE });
    const again = await cb({ query: new URLSearchParams({ code: 'good', state }) });
    assert.notEqual(again.outcome, 'ok', '★★★ 一次性語義保留，不留下可重放的 state');
    assert.equal(await e.db.getTokens(user.id), null);
  } finally { e.done(); }
});

// ===========================================================================
// §47 REPORT-LIFE：抑制 ≠ 已送達（LIFE-FG-07）
// ===========================================================================

test('REPORT-LIFE-01/04 ★★★ 被啟用擋下的送出不可以被標成 DELIVERED', async () => {
  const e = await env();
  try {
    const u = await authorize(e.db, A_CHAT);
    const life = await lifeOf(e.db, u.id);
    const claimKey = { userId: u.id, reportType: 'daily', localDateKey: '2026-09-15' };
    const claim = await e.db.claimReport({
      ...claimKey, ttlMs: 600_000, expectedLifecycleGeneration: life, now: NOW,
    });
    assert.equal(claim.granted, true);

    const sent = [];
    const tg = withDeliveryAuthorization(
      { send: async (t) => { sent.push(t); return { messageId: 1 }; }, notifyError: async () => {} },
      async () => Boolean(await e.db.getActiveChatIdForUser(u.id, { expectedLifecycleGeneration: life })),
    );
    // 認領仍然有效，但送出當下的帳號授權說不行（停用發生在授權與送出之間）。
    const suppressing = withDeliveryAuthorization(
      { send: async (t) => { sent.push(t); return { messageId: 1 }; }, notifyError: async () => {} },
      async () => false,
    );
    const r = await deliverReport({
      db: e.db, claimKey, claim, telegram: suppressing, text: '早安簡報', now: () => NOW,
    });
    assert.equal(r.result, DELIVERY_RESULT.SUPPRESSED_INACTIVE, '★★★ 不是 DELIVERED');
    assert.deepEqual(sent, []);
    assert.ok(tg, '（tg 保留給下面的實際停用情境）');

    // 真的停用之後：認領被轉移清掉，送出被圍欄擋下 —— 同樣**沒有送出**。
    await e.db.transitionUserLifecycle({ userId: u.id, targetStatus: USER_STATUS.DISABLED });
    const r2 = await deliverReport({
      db: e.db, claimKey, claim, telegram: tg, text: '早安簡報', now: () => NOW,
    });
    assert.ok([DELIVERY_RESULT.FENCED, DELIVERY_RESULT.SUPPRESSED_INACTIVE].includes(r2.result),
      `★★★ 不可以是 DELIVERED：${r2.result}`);
    assert.deepEqual(sent, []);
    const row = (await e.db.raw.execute({
      sql: 'SELECT telegram_sent_at, delivery_state FROM report_claims WHERE user_id = ?',
      args: [u.id],
    })).rows[0] ?? null;
    assert.ok(!row || !row.telegram_sent_at, '★★★ 絕不可以寫下 telegram_sent_at');
    assert.ok(!row || row.delivery_state !== REPORT_DELIVERY_STATE.DELIVERED);
  } finally { e.done(); }
});

test('REPORT-LIFE-02/03/05 ★★★ 晨報可用性：舊世代的認領不擋住新世代的簡報', async () => {
  const e = await env();
  try {
    const u = await authorize(e.db, A_CHAT);
    const oldLife = await lifeOf(e.db, u.id);
    const claimKey = { userId: u.id, reportType: 'daily', localDateKey: '2026-09-15' };
    const stale = await e.db.claimReport({
      ...claimKey, ttlMs: 600_000, expectedLifecycleGeneration: oldLife, now: NOW,
    });
    assert.equal(stale.granted, true);

    const sent = [];
    const tg = withDeliveryAuthorization(
      { send: async (t) => { sent.push(t); return { messageId: 7 }; }, notifyError: async () => {} },
      async () => Boolean(await e.db.getActiveChatIdForUser(u.id, { expectedLifecycleGeneration: oldLife })),
    );
    await aba(e.db, u.id);                         // 停用 → 再啟用（世代 +2）
    const newLife = await lifeOf(e.db, u.id);

    // 舊世代的送出被擋（而且沒有佔掉名額）
    const r1 = await deliverReport({
      db: e.db, claimKey, claim: stale, telegram: tg, text: '舊世代的簡報', now: () => NOW,
    });
    assert.ok([DELIVERY_RESULT.FENCED, DELIVERY_RESULT.SUPPRESSED_INACTIVE].includes(r1.result),
      `★★★ 舊世代絕不可以送出：${r1.result}`);
    assert.deepEqual(sent, []);

    // ★★★ 新世代重新認領得到，而且真的送得出去 —— 使用者不會少一天晨報
    const fresh = await e.db.claimReport({
      ...claimKey, ttlMs: 600_000, expectedLifecycleGeneration: newLife, now: NOW,
    });
    assert.equal(fresh.granted, true, '★★★ 舊認領不可以擋住新啟用期的晨報');
    assert.notEqual(fresh.alreadySent, true, '★★★ 絕不可以回報「已經送過了」');

    const tg2 = withDeliveryAuthorization(
      { send: async (t) => { sent.push(t); return { messageId: 8 }; }, notifyError: async () => {} },
      async () => Boolean(await e.db.getActiveChatIdForUser(u.id, { expectedLifecycleGeneration: newLife })),
    );
    const r2 = await deliverReport({
      db: e.db, claimKey, claim: fresh, telegram: tg2, text: '新世代的晨報', now: () => NOW,
    });
    assert.equal(r2.result, DELIVERY_RESULT.DELIVERED, '★★★ 新世代的晨報真的送出去了');
    assert.deepEqual(sent, ['新世代的晨報']);
  } finally { e.done(); }
});

// ===========================================================================
// §48 NOTIFY-LIFE：使用者可見的健康／帳號告警（LIFE-FG-09）
// ===========================================================================

test('NOTIFY-LIFE-03 ★★★ user-scoped 的 notifyError 也受啟用授權（不再繞過）', async () => {
  const e = await env();
  try {
    const u = await authorize(e.db, A_CHAT);
    const life = await lifeOf(e.db, u.id);
    const errs = [];
    const tg = withDeliveryAuthorization(
      {
        send: async () => ({ messageId: 1 }),
        notifyError: async (scope, detail) => { errs.push({ scope, detail }); return true; },
      },
      async () => Boolean(await e.db.getActiveChatIdForUser(u.id, { expectedLifecycleGeneration: life })),
    );
    assert.equal((await tg.notifyError('whoop_auth', 'boom')).scope, undefined);
    assert.equal(errs.length, 1, '★ 同世代照常送');

    await aba(e.db, u.id);
    const suppressed = await tg.notifyError('whoop_auth', 'boom again');
    assert.equal(suppressed.suppressed, 'ACCOUNT_INACTIVE',
      '★★★ ABA 之後舊世代的帳號告警不可以送達');
    assert.equal(errs.length, 1, '★★★ 沒有第二則');
  } finally { e.done(); }
});

// ===========================================================================
// §49 AN-LIFE：分析認領與輸出（LIFE-FG-06）
// ===========================================================================

test('AN-LIFE-03 ★★★ 停用的使用者不可能被直接認領', async () => {
  const e = await env();
  try {
    const u = await authorize(e.db, A_CHAT);
    await e.db.markAnalyticsDirty({ userId: u.id, resource: 'sleep', reason: 't', now: NOW });
    await e.db.transitionUserLifecycle({ userId: u.id, targetStatus: USER_STATUS.DISABLED });
    const claim = await e.db.claimAnalyticsWork({
      userId: u.id, cls: ANALYTICS_CLASS.LIGHT, owner: 'w1', leaseMs: 60_000,
      expectedLifecycleGeneration: 1, now: NOW,
    });
    assert.equal(claim, null, '★★★ 低階認領 API 也不可以認領停用的帳號');
  } finally { e.done(); }
});

for (const via of INACTIVE) {
  test(`AN-LIFE-01/02/${via} ★★★ 舊世代的認領不可以發布輸出`, async () => {
    const e = await env();
    try {
      const u = await authorize(e.db, A_CHAT);
      await e.db.markAnalyticsDirty({ userId: u.id, resource: 'sleep', reason: 't', now: NOW });
      const life = await lifeOf(e.db, u.id);
      const claim = await e.db.claimAnalyticsWork({
        userId: u.id, cls: ANALYTICS_CLASS.LIGHT, owner: 'w1', leaseMs: 600_000,
        expectedLifecycleGeneration: life, now: NOW,
      });
      assert.ok(claim, '★ 同世代認領得到');

      // 直接停用（AN-LIFE-01）與 ABA（AN-LIFE-02）都必須擋下輸出
      if (via === USER_STATUS.DISABLED) await aba(e.db, u.id, via);
      else await e.db.transitionUserLifecycle({ userId: u.id, targetStatus: via });

      await assert.rejects(
        () => e.db.mutateForAnalytics(
          {
            userId: u.id, cls: ANALYTICS_CLASS.LIGHT, owner: 'w1',
            generation: claim.generation, expectedLifecycleGeneration: life,
            now: () => NOW,
          },
          async () => 'output',
        ),
        /analytics_account_inactive|analytics_ownership_lost/,
        '★★★ 舊啟用世代的 worker 不可以發布',
      );
    } finally { e.done(); }
  });
}

test('AN-LIFE-04/05 新世代認領得到；分析世代 / 租約 / 活時鐘圍欄都還在', async () => {
  const e = await env();
  try {
    const u = await authorize(e.db, A_CHAT);
    await e.db.markAnalyticsDirty({ userId: u.id, resource: 'sleep', reason: 't', now: NOW });
    await aba(e.db, u.id);
    const life = await lifeOf(e.db, u.id);
    const claim = await e.db.claimAnalyticsWork({
      userId: u.id, cls: ANALYTICS_CLASS.LIGHT, owner: 'w2', leaseMs: 600_000,
      expectedLifecycleGeneration: life, now: NOW,
    });
    assert.ok(claim, 'AN-LIFE-04 新世代認領得到');
    const out = await e.db.mutateForAnalytics(
      {
        userId: u.id, cls: ANALYTICS_CLASS.LIGHT, owner: 'w2',
        generation: claim.generation, expectedLifecycleGeneration: life, now: () => NOW,
      },
      async () => 'ok',
    );
    assert.equal(out, 'ok');
    // AN-LIFE-05：既有的 Phase 3 圍欄一個都沒被取代
    await assert.rejects(
      () => e.db.mutateForAnalytics(
        {
          userId: u.id, cls: ANALYTICS_CLASS.LIGHT, owner: 'someone-else',
          generation: claim.generation, expectedLifecycleGeneration: life, now: () => NOW,
        },
        async () => 'x',
      ), /analytics_ownership_lost/, '★ 租約所有權圍欄仍然有效',
    );
    await assert.rejects(
      () => e.db.mutateForAnalytics(
        {
          userId: u.id, cls: ANALYTICS_CLASS.LIGHT, owner: 'w2',
          generation: claim.generation + 99, expectedLifecycleGeneration: life, now: () => NOW,
        },
        async () => 'x',
      ), /analytics_ownership_lost/, '★ 分析世代圍欄仍然有效',
    );
    await assert.rejects(
      () => e.db.mutateForAnalytics(
        {
          userId: u.id, cls: ANALYTICS_CLASS.LIGHT, owner: 'w2',
          generation: claim.generation, expectedLifecycleGeneration: life, now: NOW,
        },
        async () => 'x',
      ), /analytics_live_clock_required/, '★ 活時鐘要求仍然有效',
    );
  } finally { e.done(); }
});

// ===========================================================================
// §50 MIG-LIFE：遷移的 READY 安全（LIFE-FG-10）
// ===========================================================================

test('MIG-LIFE-02/03/04 ★★★ 遷移的 READY 一定是執行期述詞也會同意的 READY', async () => {
  const e = await env();
  try {
    // 一個「v13 時代完整設定好」的使用者：綁定 + 身分 + 同步 + capability，
    // 但**沒有**資源權限判定（那張表在 v16 才出現）。
    const u = await e.db.createUser({ displayName: 'Legacy', timezone: 'Asia/Taipei', now: NOW });
    await e.db.linkTelegram({ chatId: '777001', userId: u.id, now: NOW });
    await e.db.saveTokens(u.id, {
      accessToken: 'at', refreshToken: 'rt', expiresAt: new Date(NOW.getTime() + HOUR),
      scope: 'offline', whoopUserId: 'W-LEG',
    });
    await e.db.saveSyncState(u.id, 'sleep', { lastSuccessAt: NOW.toISOString() }, { now: NOW });
    await e.db.saveCapabilities(u.id, [
      { key: 'recovery', status: 'SUPPORTED', sampleCount: 5, nonNullCount: 5 },
    ], { expectedLifecycleGeneration: 1, now: NOW });
    await e.db.ensureOnboarding(u.id, { state: ONBOARDING_STATE.READY, now: NOW });
    await e.db.raw.execute({
      sql: "UPDATE user_onboarding SET state='READY', ready_at=?, timezone_confirmed_at=? WHERE user_id=?",
      args: [NOW.toISOString(), NOW.toISOString(), u.id],
    });
    // 這正是稽核指出的危險狀態：DB 說 READY，執行期述詞卻會拒絕。
    assert.equal((await e.db.setReadyIfEligible({
      userId: u.id, from: [ONBOARDING_STATE.READY],
      requiredResources: ['sleep', 'recovery'], now: NOW,
    })).ok, false, '★ 執行期述詞會拒絕這個使用者');

    // 重跑 v18 的資料遷移（把版本退回 17：from=0 代表全新 DB，
    // 那種情況本來就不需要資料遷移）
    await e.db.raw.execute('DELETE FROM schema_version');
    await e.db.raw.execute(
      "INSERT INTO schema_version (version, applied_at, note) VALUES (17, '2026-09-14T00:00:00.000Z', 'v17')",
    );
    const s = await e.db.migrate();
    assert.ok(s.dataMigrations.some((d) => d.version === 18 && d.rows === 1));

    const row = await e.db.getOnboardingRow(u.id);
    assert.equal(row.state, ONBOARDING_STATE.WHOOP_AUTHORIZED,
      '★★★ 遷移之後不可以留下執行期述詞不會同意的 READY');
    assert.equal(row.readyAt, null);
    assert.deepEqual(
      (await e.db.listSchedulableUsers({ activeStatus: USER_STATUS.ACTIVE })).map((x) => x.id), [],
      '★★★ 不會被排程（不會發出無根據的報告）',
    );
    // MIG-LIFE-03：資料全留，而且立刻進入重新驗證
    assert.equal((await e.db.getTokens(u.id)).whoopUserId, 'W-LEG');
    assert.ok(await e.db.getTelegramLink('777001'));
    assert.deepEqual(
      (await e.db.listOnboardingInState([ONBOARDING_STATE.WHOOP_AUTHORIZED])).map((o) => o.userId),
      [u.id], '★★★ 自動排進重新驗證，不需要人工重新連接',
    );
    // 冪等：再退回 17 重跑，這次沒有東西要降級了
    await e.db.raw.execute('DELETE FROM schema_version');
    await e.db.raw.execute(
      "INSERT INTO schema_version (version, applied_at, note) VALUES (17, '2026-09-14T00:00:00.000Z', 'v17')",
    );
    const s2 = await e.db.migrate();
    assert.ok(s2.dataMigrations.some((d) => d.version === 18 && d.rows === 0), 'MIG-LIFE-07 冪等');
  } finally { e.done(); }
});

test('MIG-LIFE-05/06 非 ACTIVE 維持不動；沒有世代出處的舊 OAuth state fail closed', async () => {
  const e = await env();
  try {
    await onb(e.db, A_CHAT, '/start');
    const user = await userFor(e.db, A_CHAT);
    const reply = await linked(e.db, user, 'Asia/Taipei');
    const state = stateFromUrl(urlIn(reply));
    // 模擬 v18 之前發出的 state：沒有世代出處
    await e.db.raw.execute('UPDATE oauth_states SET lifecycle_generation = NULL');
    const cb = createWhoopOAuthCallback({ db: e.db, ...backend(), now: () => NOW });
    const out = await cb({ query: new URLSearchParams({ code: 'good', state }) });
    assert.notEqual(out.outcome, 'ok', '★★★ 不知道屬於哪一段啟用期 → 拒絕，不是猜一個');
    assert.equal(await e.db.getTokens(user.id), null);

    // MIG-LIFE-05：非 ACTIVE 的使用者遷移後仍然非 ACTIVE、不被排程
    const paused = await e.db.createUser({ displayName: 'P', timezone: 'UTC', now: NOW });
    await e.db.transitionUserLifecycle({ userId: paused.id, targetStatus: USER_STATUS.PAUSED });
    await e.db.migrate();
    assert.equal((await e.db.getUser(paused.id)).status, USER_STATUS.PAUSED);
    assert.deepEqual(
      (await e.db.listSchedulableUsers({ activeStatus: USER_STATUS.ACTIVE })).map((x) => x.id), [],
    );
  } finally { e.done(); }
});

test('MIG-LIFE-01 schema 版本推進到 18，而且新欄位都是可為 NULL 的純新增', async () => {
  assert.equal(SCHEMA_VERSION, 21);
  const { ADDITIVE_COLUMNS } = await import('../src/schema.js');
  const added = ADDITIVE_COLUMNS.filter((c) => /lifecycle/.test(c.column));
  assert.ok(added.length >= 4);
  for (const c of added.filter((x) => ['report_claims', 'analytics_work_state'].includes(x.table))) {
    assert.ok(!/NOT NULL/.test(c.ddl), `★ ${c.table}.${c.column} 必須可為 NULL（舊列沒有出處）`);
  }
});
