/**
 * V1.2 Phase 3.5 — F04 受控架構修正（授權世代歸屬）。
 *
 * ## 被修掉的那個 bug
 *
 * 舊的 bootstrap 在**所有 WHOOP 觀測跑完之後**才去讀「目前的授權世代」，
 * 然後用那個值去標記這些觀測。使用者只要在中間重新授權一次（世代 N → N+1），
 * 用世代 N 觀測到的「睡眠可讀」就會被貼上 N+1 的標籤 —— 而
 * setReadyIfEligible 的世代條件看到的正是「目前世代的 ACCESSIBLE」，
 * 於是它正確地放行了一組**被偽造過**的證據：一個剛剛才撤掉睡眠權限的人
 * 被宣告 READY，而且這件事在系統裡完全看不出來。
 *
 * ## 修正的三個支點
 *
 *   1. 捕捉在前：憑證與世代來自**同一次**列讀取（db.getTokens），
 *      在任何觀測之前取得，整輪不變。
 *   2. client 綁定：WHOOP client 被釘在那次授權上，任何從 DB 撿到別的
 *      世代的 token 都不採用，直接 STALE_AUTHORIZATION。
 *   3. 寫入 CAS：判定寫入時**在 SQL 裡**再證明一次世代仍然是目前世代，
 *      不成立就一列都不寫。
 *
 * 全部用真實 libSQL、真實的 runOnboardingBootstrap、真實的 createWhoopClient。
 * 競態用 barrier / hook 造，不用 sleep。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createDb } from '../src/db.js';
import { handleUnlinkedMessage, handleOnboardingMessage } from '../src/onboarding.js';
import { createWhoopOAuthCallback } from '../src/whoopOAuthCallback.js';
import { runOnboardingBootstrap, BOOTSTRAP_RESULT } from '../src/onboardingBootstrap.js';
import {
  createWhoopClient, isStaleAuthorizationError, isScopeError,
  WhoopAuthGenerationError, STALE_AUTHORIZATION,
} from '../src/whoop.js';
import { createSync } from '../src/sync.js';
import { ONBOARDING_STATE, ONBOARDING_FAILURE, RESOURCE_ACCESS_STATUS } from '../src/schema.js';
import { ONBOARDING } from '../src/config.js';

const NOW = new Date('2026-09-15T12:00:00.000Z');
const HOUR = 3_600_000;
const CLIENT_ID = 'test-client';
const REDIRECT = 'https://example.test/whoop/oauth/callback';
const A_CHAT = '311111';
const B_CHAT = '322222';
const RESOURCES = ['sleep', 'recovery', 'cycle', 'workout', 'body_measurement'];

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whoop-f04-'));
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
const stateOf = async (db, userId) => (await db.getOnboarding(userId)).state;
const urlIn = (reply) => /https:\/\/\S+/.exec(reply)?.[0] ?? null;
const stateFromUrl = (url) => new URL(url).searchParams.get('state');
const genOf = async (db, userId) => (await db.getTokens(userId))?.authGeneration ?? null;
const accessOf = async (db, userId) => {
  const rows = await db.getResourceAccess(userId);
  return Object.fromEntries(rows.map((r) => [r.resource, r]));
};

const fakeWhoopBackend = ({ whoopUserId = 'W1', scope = 'offline read:sleep read:recovery' } = {}) => ({
  exchange: async ({ code }) => {
    if (!code || code === 'bad') throw new Error('invalid_grant');
    return {
      accessToken: `at-${whoopUserId}-${scope.length}`, refreshToken: `rt-${whoopUserId}`,
      expiresAt: new Date(NOW.getTime() + HOUR), scope,
    };
  },
  verifyIdentity: async () => whoopUserId,
});

/** 走到「已授權、等 bootstrap」。 */
async function authorize(db, chatId, { timezone = 'Asia/Taipei', whoopUserId = 'W1', at = NOW } = {}) {
  await onb(db, chatId, '/start', { now: at });
  const user = await userFor(db, chatId);
  const reply = await linked(db, user, timezone, { now: at });
  const cb = createWhoopOAuthCallback({ db, ...fakeWhoopBackend({ whoopUserId }), now: () => at });
  const res = await cb({ query: new URLSearchParams({ code: 'good', state: stateFromUrl(urlIn(reply)) }) });
  assert.equal(res.outcome, 'ok');
  return await db.getUser(user.id);
}

/**
 * 重新授權（同一個 WHOOP 帳號，可以換 scope）。走**真實**的 callback，
 * 所以世代遞增、狀態轉移、attempts 歸零全部是真的。
 */
async function reauthorize(db, chatId, { whoopUserId = 'W1', scope = 'offline read:sleep read:recovery', at } = {}) {
  const t = at ?? new Date(NOW.getTime() + ONBOARDING.AUTH_LINK_COOLDOWN_MS + 1);
  const user = await userFor(db, chatId);
  const reply = await linked(db, user, '/connect', { now: t });
  const cb = createWhoopOAuthCallback({
    db, ...fakeWhoopBackend({ whoopUserId, scope }), now: () => t,
  });
  const res = await cb({ query: new URLSearchParams({ code: 'good', state: stateFromUrl(urlIn(reply)) }) });
  assert.equal(res.outcome, 'ok', '重新授權應該成功');
  return t;
}

/**
 * 可控的 bootstrap 依賴：在指定的「階段」觸發一次 hook（例如重新授權），
 * 藉此精準造出 F04 的競態，完全不用 sleep。
 */
function racingDeps({
  db, scopeMissing = [], notes = [], onStage = async () => {}, afterSyncResource = null,
}) {
  return {
    makeWhoop: (opts) => ({ tag: 'fake', authorization: opts?.authorization ?? null }),
    makeSync: ({ userId }) => ({
      syncAll: async () => {
        const results = [];
        for (const r of RESOURCES) {
          if (!scopeMissing.includes(r)) {
            await db.saveSyncState(userId, r, { lastSuccessAt: NOW.toISOString() }, { now: NOW });
          }
          results.push({ resource: r, status: scopeMissing.includes(r) ? 'scope_missing' : 'ok' });
          if (afterSyncResource === r) await onStage('after_sync_resource');
        }
        await onStage('after_sync');
        return results;
      },
    }),
    probe: async ({ userId }) => {
      await db.saveCapabilities(userId, [
        { key: 'recovery', status: 'SUPPORTED', sampleCount: 5, nonNullCount: 5 },
      ], { now: NOW });
      await onStage('after_probe');
      return { entries: [], scopeErrors: scopeMissing.map((resource) => ({ resource })) };
    },
    notify: async (userId, kind) => { notes.push({ userId, kind }); },
  };
}

// ===========================================================================
// §35 精確重現 Final Gate 的競態
// ===========================================================================

test('F04-RACE-01 ★★★ Final Gate：世代 1 的觀測 + 中途重新授權 → 判定不得被貼上世代 2', async () => {
  const e = await env();
  try {
    const user = await authorize(e.db, A_CHAT, { whoopUserId: 'W1' });
    assert.equal(await genOf(e.db, user.id), 1, '第一次授權就是世代 1');

    const notes = [];
    let reauthAt = null;
    // 觀測全部在世代 1 完成；判定寫入之前，使用者重新授權（這次**少勾睡眠**）。
    const boot = await runOnboardingBootstrap({
      db: e.db, userId: user.id, env: {}, now: () => NOW,
      deps: racingDeps({
        db: e.db, notes,
        onStage: async (stage) => {
          if (stage !== 'after_probe' || reauthAt) return;
          reauthAt = await reauthorize(e.db, A_CHAT, { scope: 'offline read:recovery' });
        },
      }),
    });

    assert.equal(await genOf(e.db, user.id), 2, '★ 重新授權 → 世代 2');
    assert.equal(boot.result, BOOTSTRAP_RESULT.STALE_AUTHORIZATION,
      '★★★ 舊 bootstrap 必須回 STALE_AUTHORIZATION');

    // ---- 核心斷言：舊觀測沒有被關到新世代名下 ----
    const access = await accessOf(e.db, user.id);
    assert.deepEqual(access, {}, '★★★ 一列判定都不該寫入（整批 CAS 失敗）');
    for (const row of Object.values(access)) {
      assert.notEqual(row.authGeneration, 2, '★★★ 絕不可以有世代 2 的判定來自世代 1 的觀測');
    }

    assert.notEqual(await stateOf(e.db, user.id), ONBOARDING_STATE.READY,
      '★★★ 舊 bootstrap 不得讓使用者 READY');
    const onboarding = await e.db.getOnboarding(user.id);
    assert.notEqual(onboarding.failureCode, ONBOARDING_FAILURE.WHOOP_SCOPE_INCOMPLETE,
      '★ 不得用舊證據寫出「權限不足」');
    assert.deepEqual(notes, [], '★ 不得因為內部競態通知使用者');

    // ---- §35 步驟 9-12：新世代自己跑一輪，得到**真實**的結論 ----
    const fresh = await runOnboardingBootstrap({
      db: e.db, userId: user.id, env: {}, now: () => reauthAt,
      deps: racingDeps({ db: e.db, notes, scopeMissing: ['sleep'] }),
    });
    assert.equal(fresh.result, BOOTSTRAP_RESULT.ACTION_REQUIRED,
      '★★★ 世代 2 真的缺睡眠權限 → ACTION_REQUIRED（誠實的結論）');
    assert.deepEqual(fresh.lacking, ['sleep']);
    const access2 = await accessOf(e.db, user.id);
    assert.equal(access2.sleep.authGeneration, 2, '★ 新判定屬於世代 2');
    assert.equal(access2.sleep.status, RESOURCE_ACCESS_STATUS.UNAUTHORIZED);
    assert.equal(access2.recovery.status, RESOURCE_ACCESS_STATUS.ACCESSIBLE);
    assert.equal(await stateOf(e.db, user.id), ONBOARDING_STATE.ACTION_REQUIRED);
  } finally { e.done(); }
});

test('F04-RACE-02 重新授權落在 sync 與 probe 之間 → 同樣一列判定都不寫', async () => {
  const e = await env();
  try {
    const user = await authorize(e.db, A_CHAT);
    let done = false;
    const boot = await runOnboardingBootstrap({
      db: e.db, userId: user.id, env: {}, now: () => NOW,
      deps: racingDeps({
        db: e.db,
        onStage: async (stage) => {
          if (stage !== 'after_sync' || done) return;
          done = true;
          await reauthorize(e.db, A_CHAT, { scope: 'offline read:recovery' });
        },
      }),
    });
    assert.equal(boot.result, BOOTSTRAP_RESULT.STALE_AUTHORIZATION);
    assert.deepEqual(await accessOf(e.db, user.id), {});
    assert.notEqual(await stateOf(e.db, user.id), ONBOARDING_STATE.READY);
  } finally { e.done(); }
});

test('F04-RACE-03 判定已合法寫入、READY 之前才重新授權 → READY 被擋且不算失敗', async () => {
  const e = await env();
  try {
    const user = await authorize(e.db, A_CHAT);
    const gen1 = await genOf(e.db, user.id);

    // 世代 1 的判定合法寫入（CAS 當下世代仍然是 1）
    const rec = await e.db.recordResourceAccess(user.id, RESOURCES.map((resource) => ({
      resource, status: RESOURCE_ACCESS_STATUS.ACCESSIBLE,
    })), { expectedAuthGeneration: gen1, now: NOW });
    assert.equal(rec.ok, true);
    assert.equal(rec.written, RESOURCES.length);

    // 然後才重新授權
    await reauthorize(e.db, A_CHAT);
    assert.equal(await genOf(e.db, user.id), gen1 + 1);

    // 既有的 READY 述詞（RC2 就寫對了）本來就會擋下來
    await e.db.setOnboardingState(user.id, ONBOARDING_STATE.SYNCING, { now: NOW });
    const ready = await e.db.setReadyIfEligible({
      userId: user.id, requiredResources: ONBOARDING.REQUIRED_SCOPES, now: NOW,
    });
    assert.equal(ready.ok, false, '★★★ 舊世代的判定不能讓 READY 通過');
    assert.notEqual(await stateOf(e.db, user.id), ONBOARDING_STATE.READY);
  } finally { e.done(); }
});

test('F04-RACE-04 沒有競態的正常路徑：判定屬於目前世代 → READY', async () => {
  const e = await env();
  try {
    const user = await authorize(e.db, A_CHAT);
    const boot = await runOnboardingBootstrap({
      db: e.db, userId: user.id, env: {}, now: () => NOW,
      deps: racingDeps({ db: e.db }),
    });
    assert.equal(boot.result, BOOTSTRAP_RESULT.READY);
    assert.equal(await stateOf(e.db, user.id), ONBOARDING_STATE.READY);
    const access = await accessOf(e.db, user.id);
    assert.equal(access.sleep.authGeneration, 1);
    assert.equal(access.sleep.status, RESOURCE_ACCESS_STATUS.ACCESSIBLE);
  } finally { e.done(); }
});

// ===========================================================================
// §36 / §37 混世代與 401 採用
// ===========================================================================

/** 最小可用的假 WHOOP HTTP 後端，記錄每一次請求用的 bearer。 */
function httpBackend({ failFirstWith401 = null } = {}) {
  const seen = [];
  const refreshed = [];
  const reply = (obj) => {
    const body = JSON.stringify(obj);
    return { ok: true, status: 200, json: async () => JSON.parse(body), text: async () => body, headers: new Map() };
  };
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    if (u.pathname.endsWith('/oauth/oauth2/token')) {
      const token = `refreshed-${refreshed.length + 1}`;
      refreshed.push(token);
      return reply({
        access_token: token, refresh_token: `rt-${refreshed.length}`,
        expires_in: 3600, scope: 'offline read:sleep read:recovery',
      });
    }
    const bearer = String(init.headers?.Authorization ?? '').replace('Bearer ', '');
    seen.push({ path: u.pathname, bearer });
    if (failFirstWith401 && u.pathname.includes(failFirstWith401)
        && seen.filter((s) => s.path === u.pathname).length === 1) {
      return {
        ok: false, status: 401, json: async () => ({}),
        text: async () => 'unauthorized', headers: new Map(),
      };
    }
    // body measurement 是單一物件，其餘是分頁集合
    return u.pathname.includes('/measurement/body')
      ? reply({ height_meter: 1.75, weight_kilogram: 70, max_heart_rate: 190 })
      : reply({ records: [], next_token: null });
  };
  return {
    fetchImpl, seen, refreshed,
    bearers: () => [...new Set(seen.map((s) => s.bearer))],
  };
}

/**
 * 讓 token 在**真實時鐘**下還很久才過期。
 *
 * 測試的邏輯時間（NOW）刻意固定在過去，但 token 的過期判斷用的是真實的
 * Date.now() —— 不調整的話每一個 client 一開機就會去 refresh，
 * 那會蓋掉我們真正想測的東西。這是一次例行 refresh 的等價操作：世代不變。
 */
async function longLivedToken(db, userId, accessToken = 'at-live') {
  await db.saveTokens(userId, {
    accessToken, refreshToken: 'rt-live',
    expiresAt: new Date(Date.now() + 6 * HOUR),
    scope: 'offline read:sleep read:recovery', whoopUserId: 'W1',
  });
  return db.getTokens(userId);
}

test('F04-MIX-01 ★★★ 被釘住的 client 絕不採用另一個世代的 token（401 之後也不行）', async () => {
  const e = await env();
  try {
    const user = await authorize(e.db, A_CHAT);
    const snapshot = await longLivedToken(e.db, user.id, 'at-gen1');
    assert.equal(snapshot.authGeneration, 1);
    assert.ok(Number.isInteger(snapshot.authGeneration), '★ 快照與憑證同一次讀取');

    const backend = httpBackend({ failFirstWith401: '/activity/sleep' });
    const whoop = createWhoopClient({
      db: e.db, userId: user.id, clientId: 'c', clientSecret: 's',
      fetchImpl: backend.fetchImpl, sleepImpl: async () => {},
      authorization: snapshot,
    });

    // 在第一個請求之前，使用者重新授權 → 世代 2 的 token 進了 DB。
    await reauthorize(e.db, A_CHAT);
    const gen2Token = await e.db.getTokens(user.id);
    assert.equal(gen2Token.authGeneration, 2);

    // sleep 會吃 401 → 強制 refresh → 走到 DB 重讀 → 世代不符 → 拒絕。
    const err = await whoop.sleeps(new Date(NOW.getTime() - HOUR), NOW).then(
      () => null, (x) => x,
    );
    assert.ok(err, '★★★ 必須拋錯，不可以安靜地換成世代 2 繼續跑');
    assert.ok(isStaleAuthorizationError(err), `★★★ 必須是 STALE_AUTHORIZATION，實際：${err?.name}`);
    assert.equal(err.code, STALE_AUTHORIZATION);
    assert.equal(err.expectedAuthGeneration, 1);
    assert.equal(err.actualAuthGeneration, 2);

    // ★★★ 從來沒有用世代 2 的 bearer 送出過任何請求
    assert.ok(!backend.seen.some((s) => s.bearer === gen2Token.accessToken),
      '★★★ 絕不可以用世代 2 的憑證送請求');
    assert.deepEqual(backend.bearers(), [snapshot.accessToken],
      '★★★ 所有請求都只用世代 1 的憑證');

    // 錯誤內容不得洩漏任何祕密
    const text = `${err.message}${JSON.stringify(err.expectedAuthGeneration)}${err.stack ?? ''}`;
    for (const secret of [snapshot.accessToken, snapshot.refreshToken,
      gen2Token.accessToken, gen2Token.refreshToken]) {
      assert.ok(!text.includes(secret), '★ 錯誤不得含 token');
    }
  } finally { e.done(); }
});

test('F04-MIX-02 sleep 在世代 N 抓到、之後重新授權 → recovery 不會用 N+1 憑證（整輪 stale）', async () => {
  const e = await env();
  try {
    const user = await authorize(e.db, A_CHAT);
    const snapshot = await longLivedToken(e.db, user.id, 'at-gen1');
    const backend = httpBackend({ failFirstWith401: '/recovery' });
    const whoop = createWhoopClient({
      db: e.db, userId: user.id, clientId: 'c', clientSecret: 's',
      fetchImpl: backend.fetchImpl, sleepImpl: async () => {},
      authorization: snapshot,
    });

    // sleep 在世代 1 成功
    await whoop.sleeps(new Date(NOW.getTime() - HOUR), NOW);
    assert.ok(backend.seen.length >= 1);
    assert.deepEqual(backend.bearers(), [snapshot.accessToken]);

    // 然後重新授權
    await reauthorize(e.db, A_CHAT);
    const gen2 = await e.db.getTokens(user.id);

    // recovery 吃 401 → 不得採用世代 2
    const err = await whoop.recoveries(new Date(NOW.getTime() - HOUR), NOW).then(() => null, (x) => x);
    assert.ok(isStaleAuthorizationError(err), '★★★ 混世代必須失敗，不得繼續');
    assert.ok(!backend.seen.some((s) => s.bearer === gen2.accessToken),
      '★★★ 禁止 sleep 用 N、recovery 用 N+1');
  } finally { e.done(); }
});

test('F04-MIX-03 未綁定的 client（index.js / reconcile.js 的路徑）行為完全不變', async () => {
  const e = await env();
  try {
    const user = await authorize(e.db, A_CHAT);
    await longLivedToken(e.db, user.id, 'at-unconstrained');
    const backend = httpBackend();
    const whoop = createWhoopClient({
      db: e.db, userId: user.id, clientId: 'c', clientSecret: 's',
      fetchImpl: backend.fetchImpl, sleepImpl: async () => {},
      // 不傳 authorization → 不受約束
    });
    await whoop.sleeps(new Date(NOW.getTime() - HOUR), NOW);
    // 重新授權之後仍然可以繼續用（這正是排程同步該有的行為）
    await reauthorize(e.db, A_CHAT);
    await whoop.recoveries(new Date(NOW.getTime() - HOUR), NOW);
    assert.ok(backend.seen.length >= 2, '★ 未綁定的 client 不受世代影響');
  } finally { e.done(); }
});

test('F04-MIX-04 STALE_AUTHORIZATION 不得被當成缺 scope', async () => {
  const err = new WhoopAuthGenerationError({ expected: 1, actual: 2 });
  assert.equal(isScopeError(err), false, '★★★ 世代競態不是 401/403 缺 scope');
  assert.equal(isStaleAuthorizationError(err), true);
  // 真正的 scope 錯誤仍然要被認出來
  assert.equal(isScopeError({ status: 403 }), true);
  assert.equal(isScopeError({ status: 401 }), true);
});

// ===========================================================================
// §38 / §39 例行 refresh 與 refresh vs reauth
// ===========================================================================

test('F04-REFRESH-01 ★ 例行 refresh 不動世代，被釘住的 client 照常跑完', async () => {
  const e = await env();
  try {
    const user = await authorize(e.db, A_CHAT);
    // 讓快照裡的 token 已經快過期 → 第一次呼叫就會 refresh
    await e.db.saveTokens(user.id, {
      accessToken: 'about-to-expire', refreshToken: 'rt-old',
      expiresAt: new Date(Date.now() + 1_000), scope: 'offline read:sleep read:recovery',
      whoopUserId: 'W1',
    });
    const snapshot = await e.db.getTokens(user.id);
    assert.equal(snapshot.authGeneration, 1, '★ refresh 前是世代 1');

    const backend = httpBackend();
    const whoop = createWhoopClient({
      db: e.db, userId: user.id, clientId: 'c', clientSecret: 's',
      fetchImpl: backend.fetchImpl, sleepImpl: async () => {},
      authorization: snapshot,
    });
    await whoop.sleeps(new Date(NOW.getTime() - HOUR), NOW);
    await whoop.recoveries(new Date(NOW.getTime() - HOUR), NOW);

    const after = await e.db.getTokens(user.id);
    assert.equal(after.authGeneration, 1, '★★★ 例行 refresh 絕不前進世代');
    assert.equal(after.accessToken, 'refreshed-1', '★ 新的 access token 有寫回去');
    assert.ok(backend.seen.some((s) => s.bearer === 'refreshed-1'),
      '★ 同一次授權內換新 token 是允許的');

    // 而且判定照樣能以世代 1 寫入、READY 照樣成立
    const rec = await e.db.recordResourceAccess(user.id, RESOURCES.map((resource) => ({
      resource, status: RESOURCE_ACCESS_STATUS.ACCESSIBLE,
    })), { expectedAuthGeneration: 1, now: NOW });
    assert.equal(rec.ok, true, '★ refresh 過後世代 1 的判定仍然寫得進去');
  } finally { e.done(); }
});

test('F04-REFRESH-02 完整 bootstrap 中途發生例行 refresh → 仍然 READY（關鍵回歸）', async () => {
  const e = await env();
  try {
    const user = await authorize(e.db, A_CHAT);
    await e.db.saveTokens(user.id, {
      accessToken: 'about-to-expire', refreshToken: 'rt-old',
      expiresAt: new Date(Date.now() + 1_000), scope: 'offline read:sleep read:recovery',
      whoopUserId: 'W1',
    });
    const backend = httpBackend();
    const boot = await runOnboardingBootstrap({
      db: e.db, userId: user.id, env: { whoopClientId: 'c', whoopClientSecret: 's' },
      now: () => NOW,
      deps: {
        // 真實的 client（會 refresh），假的 HTTP
        makeWhoop: (opts) => createWhoopClient({
          ...opts, fetchImpl: backend.fetchImpl, sleepImpl: async () => {},
        }),
        makeSync: ({ db, whoop, userId, timezone }) => {
          const real = createSync({ db, whoop, userId, timezone, now: NOW });
          return { syncAll: (o) => real.syncAll(o) };
        },
        probe: async ({ userId }) => {
          await e.db.saveCapabilities(userId, [
            { key: 'recovery', status: 'SUPPORTED', sampleCount: 5, nonNullCount: 5 },
          ], { now: NOW });
          return { entries: [], scopeErrors: [] };
        },
        notify: async () => {},
      },
    });
    assert.equal(boot.result, BOOTSTRAP_RESULT.READY, '★★★ 例行 refresh 不該讓 bootstrap 失敗');
    assert.equal(await genOf(e.db, user.id), 1, '★★★ 世代仍然是 1');
    const access = await accessOf(e.db, user.id);
    assert.equal(access.sleep.authGeneration, 1);
    assert.equal(access.sleep.status, RESOURCE_ACCESS_STATUS.ACCESSIBLE);
  } finally { e.done(); }
});

test('F04-REFRESH-03 ★★★ 舊世代的 refresh 結果不得覆蓋新的 OAuth 授權', async () => {
  const e = await env();
  try {
    const user = await authorize(e.db, A_CHAT);
    const gen1 = await e.db.getTokens(user.id);

    // 使用者完成了新的授權 → 世代 2
    await reauthorize(e.db, A_CHAT);
    const gen2 = await e.db.getTokens(user.id);
    assert.equal(gen2.authGeneration, 2);

    // 一個還停在世代 1 的 refresh 現在才回來要寫入
    const written = await e.db.saveTokens(user.id, {
      accessToken: 'stale-refresh-result', refreshToken: 'stale-rt',
      expiresAt: new Date(NOW.getTime() + HOUR), scope: 'offline',
      whoopUserId: 'W1',
    }, { expectedUpdatedAt: gen1.updatedAt, expectedAuthGeneration: 1 });
    assert.equal(written, false, '★★★ 世代 CAS 必須擋下來');

    const after = await e.db.getTokens(user.id);
    assert.equal(after.accessToken, gen2.accessToken, '★★★ 新授權的 token 原封不動');
    assert.equal(after.authGeneration, 2, '★ 世代也沒被動到');
  } finally { e.done(); }
});

test('F04-REFRESH-04 同世代的正常 refresh CAS 照樣通過', async () => {
  const e = await env();
  try {
    const user = await authorize(e.db, A_CHAT);
    const t = await e.db.getTokens(user.id);
    const ok = await e.db.saveTokens(user.id, {
      accessToken: 'fresh', refreshToken: 'fresh-rt',
      expiresAt: new Date(NOW.getTime() + HOUR), scope: 'offline', whoopUserId: 'W1',
    }, { expectedUpdatedAt: t.updatedAt, expectedAuthGeneration: t.authGeneration });
    assert.notEqual(ok, false, '★ 同世代的 refresh 不該被擋');
    const after = await e.db.getTokens(user.id);
    assert.equal(after.accessToken, 'fresh');
    assert.equal(after.authGeneration, 1, '★ 世代不變');
  } finally { e.done(); }
});

// ===========================================================================
// §40 資源判定寫入的 CAS
// ===========================================================================

test('F04-FENCE-01 世代過期 → 一列都不寫、回報 stale（不得假裝成功）', async () => {
  const e = await env();
  try {
    const user = await authorize(e.db, A_CHAT);
    await reauthorize(e.db, A_CHAT);
    assert.equal(await genOf(e.db, user.id), 2);

    const r = await e.db.recordResourceAccess(user.id, [
      { resource: 'sleep', status: RESOURCE_ACCESS_STATUS.ACCESSIBLE },
      { resource: 'recovery', status: RESOURCE_ACCESS_STATUS.ACCESSIBLE },
    ], { expectedAuthGeneration: 1, now: NOW });

    assert.equal(r.ok, false, '★★★ 必須回報失敗');
    assert.equal(r.written, 0);
    assert.equal(r.reason, 'stale_authorization');
    assert.deepEqual(await accessOf(e.db, user.id), {}, '★★★ 一列都沒寫');
  } finally { e.done(); }
});

test('F04-FENCE-02 整批原子：世代在批次中途改變 → 全部不寫（不得半套）', async () => {
  const e = await env();
  try {
    const user = await authorize(e.db, A_CHAT);
    // 先寫成功一次，確認基準
    const first = await e.db.recordResourceAccess(user.id, [
      { resource: 'sleep', status: RESOURCE_ACCESS_STATUS.ACCESSIBLE },
    ], { expectedAuthGeneration: 1, now: NOW });
    assert.equal(first.written, 1);

    // 世代前進之後，一個五筆的批次全部作廢
    await reauthorize(e.db, A_CHAT);
    const batch = await e.db.recordResourceAccess(user.id, RESOURCES.map((resource) => ({
      resource, status: RESOURCE_ACCESS_STATUS.UNAUTHORIZED,
    })), { expectedAuthGeneration: 1, now: NOW });
    assert.equal(batch.ok, false);
    assert.equal(batch.written, 0);

    const access = await accessOf(e.db, user.id);
    assert.equal(Object.keys(access).length, 1, '★★★ 只剩原本那一列，沒有半套的批次');
    assert.equal(access.sleep.status, RESOURCE_ACCESS_STATUS.ACCESSIBLE, '★ 原本的判定沒被污染');
    assert.equal(access.sleep.authGeneration, 1);
  } finally { e.done(); }
});

test('F04-FENCE-03 延遲的舊世代寫入不得倒退已經存在的新世代判定', async () => {
  const e = await env();
  try {
    const user = await authorize(e.db, A_CHAT);
    await reauthorize(e.db, A_CHAT);
    // 世代 2 的判定先寫好
    const ok = await e.db.recordResourceAccess(user.id, [
      { resource: 'sleep', status: RESOURCE_ACCESS_STATUS.ACCESSIBLE },
    ], { expectedAuthGeneration: 2, now: NOW });
    assert.equal(ok.written, 1);

    // 一個遲到的世代 1 寫入
    const late = await e.db.recordResourceAccess(user.id, [
      { resource: 'sleep', status: RESOURCE_ACCESS_STATUS.UNAUTHORIZED },
    ], { expectedAuthGeneration: 1, now: NOW });
    assert.equal(late.ok, false, '★★★ 遲到的舊世代必須被擋');

    const access = await accessOf(e.db, user.id);
    assert.equal(access.sleep.authGeneration, 2, '★★★ 新世代的判定沒有被倒退');
    assert.equal(access.sleep.status, RESOURCE_ACCESS_STATUS.ACCESSIBLE);
  } finally { e.done(); }
});

test('F04-FENCE-04 判定必須帶合法世代；空批次是合法的 no-op', async () => {
  const e = await env();
  try {
    const user = await authorize(e.db, A_CHAT);
    await assert.rejects(
      () => e.db.recordResourceAccess(user.id, [{ resource: 'sleep', status: RESOURCE_ACCESS_STATUS.ACCESSIBLE }], { now: NOW }),
      /resource_access_requires_generation/, '★ 沒有世代就不可以下判定',
    );
    await assert.rejects(
      () => e.db.recordResourceAccess(user.id, [{ resource: 'sleep', status: 'MAYBE' }], { expectedAuthGeneration: 1, now: NOW }),
      /invalid_resource_access_status/, '★ 只認兩種結論',
    );
    const empty = await e.db.recordResourceAccess(user.id, [], { expectedAuthGeneration: 1, now: NOW });
    assert.equal(empty.ok, true);
    assert.equal(empty.written, 0);
  } finally { e.done(); }
});

// ===========================================================================
// §41 ACTION_REQUIRED 的世代圍欄
// ===========================================================================

test('F04-ACTION-01 ★★★ 舊世代算出「缺睡眠」→ 不得把已經重新授權的人打成 ACTION_REQUIRED', async () => {
  const e = await env();
  try {
    const user = await authorize(e.db, A_CHAT);
    const notes = [];
    // 世代 1 的觀測說 sleep 缺權限；寫結論之前使用者重新授權（這次補齊了）。
    const boot = await runOnboardingBootstrap({
      db: e.db, userId: user.id, env: {}, now: () => NOW,
      deps: racingDeps({
        db: e.db, notes, scopeMissing: ['sleep'],
        onStage: async (stage) => {
          if (stage !== 'after_probe') return;
          await reauthorize(e.db, A_CHAT, { scope: 'offline read:sleep read:recovery' });
        },
      }),
    });
    assert.equal(boot.result, BOOTSTRAP_RESULT.STALE_AUTHORIZATION,
      '★★★ 必須是 stale，而不是 ACTION_REQUIRED');
    const onboarding = await e.db.getOnboarding(user.id);
    assert.notEqual(onboarding.state, ONBOARDING_STATE.ACTION_REQUIRED,
      '★★★ 新的授權階段不得被舊結論打成 ACTION_REQUIRED');
    assert.notEqual(onboarding.failureCode, ONBOARDING_FAILURE.WHOOP_SCOPE_INCOMPLETE);
    assert.deepEqual(notes, [], '★★★ 不得對使用者發出錯誤的「權限不足」提示');
    assert.deepEqual(await accessOf(e.db, user.id), {}, '★ 也沒寫下任何舊世代的判定');
  } finally { e.done(); }
});

test('F04-ACTION-02 真的缺權限（沒有競態）仍然照常 ACTION_REQUIRED', async () => {
  const e = await env();
  try {
    const user = await authorize(e.db, A_CHAT);
    const notes = [];
    const boot = await runOnboardingBootstrap({
      db: e.db, userId: user.id, env: {}, now: () => NOW,
      deps: racingDeps({ db: e.db, notes, scopeMissing: ['sleep'] }),
    });
    assert.equal(boot.result, BOOTSTRAP_RESULT.ACTION_REQUIRED, '★ 沒有競態就要誠實地說缺權限');
    assert.deepEqual(boot.lacking, ['sleep']);
    assert.equal(await stateOf(e.db, user.id), ONBOARDING_STATE.ACTION_REQUIRED);
    assert.deepEqual(notes.map((n) => n.kind), ['scope_incomplete']);
    const access = await accessOf(e.db, user.id);
    assert.equal(access.sleep.status, RESOURCE_ACCESS_STATUS.UNAUTHORIZED);
    assert.equal(access.sleep.authGeneration, 1);
  } finally { e.done(); }
});

// ===========================================================================
// §42 bootstrap 重試額度
// ===========================================================================

test('F04-BUDGET-01 ★★★ 重新授權的競態不得永久吃掉重試額度', async () => {
  const e = await env();
  try {
    const user = await authorize(e.db, A_CHAT);
    let at = NOW;
    // 連續發生比 MAX_BOOTSTRAP_ATTEMPTS 還多次的「授權中途改變」競態
    for (let i = 0; i < ONBOARDING.MAX_BOOTSTRAP_ATTEMPTS + 2; i++) {
      const when = at;
      const boot = await runOnboardingBootstrap({
        db: e.db, userId: user.id, env: {}, now: () => when,
        deps: racingDeps({
          db: e.db,
          onStage: async (stage) => {
            if (stage !== 'after_probe') return;
            at = await reauthorize(e.db, A_CHAT, {
              at: new Date(when.getTime() + ONBOARDING.AUTH_LINK_COOLDOWN_MS + 1),
            });
          },
        }),
      });
      assert.equal(boot.result, BOOTSTRAP_RESULT.STALE_AUTHORIZATION, `第 ${i + 1} 輪應該是 stale`);
      const o = await e.db.getOnboarding(user.id);
      assert.notEqual(o.state, ONBOARDING_STATE.ACTION_REQUIRED,
        `★★★ 第 ${i + 1} 輪：使用者不得因為內部競態被卡死`);
    }
    // 最後一次乾淨地跑完 → 應該要能 READY
    const final = await runOnboardingBootstrap({
      db: e.db, userId: user.id, env: {}, now: () => at,
      deps: racingDeps({ db: e.db }),
    });
    assert.equal(final.result, BOOTSTRAP_RESULT.READY, '★★★ 競態結束之後仍然上得了線');
    assert.equal(await stateOf(e.db, user.id), ONBOARDING_STATE.READY);
  } finally { e.done(); }
});

test('F04-BUDGET-02 ★ 沒有新授權的真實連續失敗，斷路器照樣生效（不得被解除）', async () => {
  const e = await env();
  try {
    const user = await authorize(e.db, A_CHAT);
    const notes = [];
    const failing = {
      makeWhoop: () => ({ tag: 'fake' }),
      makeSync: async () => { throw new Error('boom'); },
      probe: async () => ({ entries: [], scopeErrors: [] }),
      notify: async (userId, kind) => { notes.push(kind); },
    };
    let last = null;
    for (let i = 0; i < ONBOARDING.MAX_BOOTSTRAP_ATTEMPTS; i++) {
      last = await runOnboardingBootstrap({
        db: e.db, userId: user.id, env: {}, now: () => NOW,
        deps: { ...failing, makeSync: () => ({ syncAll: async () => { throw new Error('boom'); } }) },
      });
    }
    assert.equal(last.result, BOOTSTRAP_RESULT.ACTION_REQUIRED,
      '★★★ 真實的連續失敗仍然要走到 ACTION_REQUIRED');
    assert.equal(await stateOf(e.db, user.id), ONBOARDING_STATE.ACTION_REQUIRED);
    assert.ok(notes.includes('bootstrap_failed'));
  } finally { e.done(); }
});

test('F04-BUDGET-03 新授權讓 bootstrap_attempts 歸零（即使當時卡在 SYNCING）', async () => {
  const e = await env();
  try {
    const user = await authorize(e.db, A_CHAT);
    await e.db.setOnboardingState(user.id, ONBOARDING_STATE.SYNCING, { syncStarted: true, now: NOW });
    await e.db.recordBootstrapAttempt(user.id, { now: NOW });
    await e.db.recordBootstrapAttempt(user.id, { now: NOW });
    assert.equal((await e.db.getOnboarding(user.id)).bootstrapAttempts, 2);

    await reauthorize(e.db, A_CHAT);
    assert.equal((await e.db.getOnboarding(user.id)).bootstrapAttempts, 0,
      '★★★ 新授權 = 全新的嘗試預算（狀態是 SYNCING 時也必須成立）');
  } finally { e.done(); }
});

// ===========================================================================
// §43 / §44 / §45 併發、多次重新授權、多使用者
// ===========================================================================

test('F04-CONCURRENT-01 同一世代的兩個 bootstrap：不得產生錯誤的 READY 或髒判定', async () => {
  const e = await env();
  try {
    const user = await authorize(e.db, A_CHAT);
    const [a, b] = await Promise.all([
      runOnboardingBootstrap({
        db: e.db, userId: user.id, env: {}, now: () => NOW, deps: racingDeps({ db: e.db }),
      }),
      runOnboardingBootstrap({
        db: e.db, userId: user.id, env: {}, now: () => NOW, deps: racingDeps({ db: e.db }),
      }),
    ]);
    const results = [a.result, b.result].sort();
    assert.ok(results.includes(BOOTSTRAP_RESULT.READY), `★ 至少一個要完成：${results}`);
    const access = await accessOf(e.db, user.id);
    for (const row of Object.values(access)) {
      assert.equal(row.authGeneration, 1, '★★★ 所有判定都屬於同一個世代');
    }
    assert.equal(await stateOf(e.db, user.id), ONBOARDING_STATE.READY);
  } finally { e.done(); }
});

test('F04-MULTIREAUTH-01 世代 1 跑、期間連續兩次重新授權 → 只有世代 3 的結論算數', async () => {
  const e = await env();
  try {
    const user = await authorize(e.db, A_CHAT);
    let at = NOW;
    const boot = await runOnboardingBootstrap({
      db: e.db, userId: user.id, env: {}, now: () => NOW,
      deps: racingDeps({
        db: e.db,
        onStage: async (stage) => {
          if (stage !== 'after_probe') return;
          at = await reauthorize(e.db, A_CHAT, { at: new Date(NOW.getTime() + 60_000) });
          at = await reauthorize(e.db, A_CHAT, { at: new Date(NOW.getTime() + 120_000) });
        },
      }),
    });
    assert.equal(boot.result, BOOTSTRAP_RESULT.STALE_AUTHORIZATION);
    assert.equal(await genOf(e.db, user.id), 3, '★ 兩次重新授權 → 世代 3');
    assert.deepEqual(await accessOf(e.db, user.id), {}, '★★★ 世代 1 的觀測什麼都沒留下');

    // 世代 2 的遲到寫入也不行
    const late2 = await e.db.recordResourceAccess(user.id, [
      { resource: 'sleep', status: RESOURCE_ACCESS_STATUS.ACCESSIBLE },
    ], { expectedAuthGeneration: 2, now: at });
    assert.equal(late2.ok, false, '★★★ 世代 2 也已經過期了');

    // 世代 3 乾淨跑一輪 → READY
    const fresh = await runOnboardingBootstrap({
      db: e.db, userId: user.id, env: {}, now: () => at, deps: racingDeps({ db: e.db }),
    });
    assert.equal(fresh.result, BOOTSTRAP_RESULT.READY);
    const access = await accessOf(e.db, user.id);
    assert.equal(access.sleep.authGeneration, 3, '★★★ 只有世代 3 的結論存在');
  } finally { e.done(); }
});

test('F04-MULTIUSER-01 ★★★ Alice 重新授權不得影響 Bob 的 bootstrap 或判定', async () => {
  const e = await env();
  try {
    const alice = await authorize(e.db, A_CHAT, { whoopUserId: 'W-A' });
    const bob = await authorize(e.db, B_CHAT, { whoopUserId: 'W-B' });

    // Bob 乾淨地完成
    const bobBoot = await runOnboardingBootstrap({
      db: e.db, userId: bob.id, env: {}, now: () => NOW, deps: racingDeps({ db: e.db }),
    });
    assert.equal(bobBoot.result, BOOTSTRAP_RESULT.READY);

    // Alice 在 bootstrap 中途重新授權
    const aliceBoot = await runOnboardingBootstrap({
      db: e.db, userId: alice.id, env: {}, now: () => NOW,
      deps: racingDeps({
        db: e.db,
        onStage: async (stage) => {
          if (stage !== 'after_probe') return;
          await reauthorize(e.db, A_CHAT, { whoopUserId: 'W-A' });
        },
      }),
    });
    assert.equal(aliceBoot.result, BOOTSTRAP_RESULT.STALE_AUTHORIZATION);

    // Bob 完全不受影響
    assert.equal(await genOf(e.db, bob.id), 1, '★★★ Bob 的世代沒動');
    assert.equal(await stateOf(e.db, bob.id), ONBOARDING_STATE.READY, '★★★ Bob 還是 READY');
    const bobAccess = await accessOf(e.db, bob.id);
    assert.equal(bobAccess.sleep.authGeneration, 1);
    assert.equal(bobAccess.sleep.status, RESOURCE_ACCESS_STATUS.ACCESSIBLE);
    assert.equal((await e.db.getOnboarding(bob.id)).bootstrapAttempts, 1, '★ Bob 的預算沒被動');

    // Alice 的世代前進、判定為空
    assert.equal(await genOf(e.db, alice.id), 2);
    assert.deepEqual(await accessOf(e.db, alice.id), {});
    assert.notEqual(await stateOf(e.db, alice.id), ONBOARDING_STATE.READY);
  } finally { e.done(); }
});

// ===========================================================================
// 快照本身
// ===========================================================================

test('F04-SNAPSHOT-01 getTokens 用**同一次**列讀取同時給出憑證與世代', async () => {
  const e = await env();
  try {
    const user = await authorize(e.db, A_CHAT);
    const t = await e.db.getTokens(user.id);
    assert.equal(t.authGeneration, 1);
    assert.ok(Number.isInteger(t.authGeneration) && t.authGeneration >= 1, '★ 正的有限整數');
    assert.ok(t.accessToken, '★ 憑證同時到手');
    assert.equal(t.whoopUserId, 'W1', '★ 身分也在同一個快照裡');

    await reauthorize(e.db, A_CHAT);
    const t2 = await e.db.getTokens(user.id);
    assert.equal(t2.authGeneration, 2);
    assert.equal(await e.db.getAuthGeneration(user.id), 2, '★ 與既有的讀取器一致');
    assert.equal(await e.db.getTokens('nobody'), null);
  } finally { e.done(); }
});
