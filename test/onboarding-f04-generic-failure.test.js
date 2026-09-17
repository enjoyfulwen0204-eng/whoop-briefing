/**
 * V1.2 Phase 3.5 — F04-FG-NEW-01：一般性失敗的過期 worker。
 *
 * ## 被修掉的那個 bug
 *
 * 前一次修正把**權限結論**綁在授權世代上了，但「一般性失敗」那條路
 * （暫時性同步故障、capability 故障、READY 前提不足）還留著兩個洞：
 *
 *   1. failOrRetry 用 bootstrap **開跑時**讀到的 onboarding 快照算嘗試次數。
 *      使用者中途重新授權時 callback 會把額度歸零 —— 快照看不到那件事。
 *   2. 它寫 ACTION_REQUIRED / BOOTSTRAP_FAILED 時沒有任何世代條件。
 *
 * 於是：attempts 是 4 的使用者，bootstrap 開跑（推到 5），使用者重新授權
 * （世代 2、額度歸零），舊的世代 1 同步這時才回報一個普通的 500 ——
 * 舊 worker 拿過期的 4+1 算出「已經到上限」，把一個剛授權成功、額度全新的人
 * 寫成 ACTION_REQUIRED / BOOTSTRAP_FAILED，還送出上線失敗通知。
 *
 * ## 修正
 *
 * 終局升級變成**一句**有條件的 UPDATE，三個前提在寫入當下一起求值：
 * 世代仍是開跑時捕捉的那個、**目前耐久的** attempts 真的達到上限、
 * 狀態仍是 bootstrap 擁有的來源狀態。通知移到確認寫入成功之後。
 *
 * 全部用真實 libSQL、真實 runOnboardingBootstrap、真實 OAuth callback。
 * 競態用 hook 造，不用 sleep。
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
import { ONBOARDING_STATE, ONBOARDING_FAILURE, RESOURCE_ACCESS_STATUS } from '../src/schema.js';
import { ONBOARDING } from '../src/config.js';

const NOW = new Date('2026-09-15T12:00:00.000Z');
const HOUR = 3_600_000;
const CLIENT_ID = 'test-client';
const REDIRECT = 'https://example.test/whoop/oauth/callback';
const A_CHAT = '411111';
const B_CHAT = '422222';
const RESOURCES = ['sleep', 'recovery', 'cycle', 'workout', 'body_measurement'];
const MAX = ONBOARDING.MAX_BOOTSTRAP_ATTEMPTS;

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whoop-f04fg-'));
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
const urlIn = (reply) => /https:\/\/\S+/.exec(reply)?.[0] ?? null;
const stateFromUrl = (url) => new URL(url).searchParams.get('state');
const genOf = async (db, userId) => (await db.getTokens(userId))?.authGeneration ?? null;
const onboardingOf = (db, userId) => db.getOnboarding(userId);

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

async function authorize(db, chatId, { timezone = 'Asia/Taipei', whoopUserId = 'W1', at = NOW } = {}) {
  await onb(db, chatId, '/start', { now: at });
  const user = await userFor(db, chatId);
  const reply = await linked(db, user, timezone, { now: at });
  const cb = createWhoopOAuthCallback({ db, ...fakeWhoopBackend({ whoopUserId }), now: () => at });
  const res = await cb({ query: new URLSearchParams({ code: 'good', state: stateFromUrl(urlIn(reply)) }) });
  assert.equal(res.outcome, 'ok');
  return await db.getUser(user.id);
}

/** 真實的重新授權：世代 +1、狀態轉移、attempts 歸零全部是真的。 */
async function reauthorize(db, chatId, { whoopUserId = 'W1', scope = 'offline read:sleep read:recovery', at } = {}) {
  const t = at ?? new Date(NOW.getTime() + ONBOARDING.AUTH_LINK_COOLDOWN_MS + 1);
  const user = await userFor(db, chatId);
  const reply = await linked(db, user, '/connect', { now: t });
  const cb = createWhoopOAuthCallback({ db, ...fakeWhoopBackend({ whoopUserId, scope }), now: () => t });
  const res = await cb({ query: new URLSearchParams({ code: 'good', state: stateFromUrl(urlIn(reply)) }) });
  assert.equal(res.outcome, 'ok', '重新授權應該成功');
  return t;
}

/** 把耐久的 bootstrap_attempts 推到指定值（用真實的計數器）。 */
async function setAttempts(db, userId, n) {
  await db.resetBootstrapAttempts(userId, { now: NOW });
  for (let i = 0; i < n; i++) await db.recordBootstrapAttempt(userId, { now: NOW });
  assert.equal((await db.getOnboarding(userId)).bootstrapAttempts, n);
}

/**
 * bootstrap 依賴：sync 拋出一個**普通的** provider 故障（不是世代錯誤、
 * 也不是缺 scope），並且可以在故障發生前觸發一次 hook。
 */
function failingDeps({ db = null, notes = [], onBeforeFailure = null, failing = true } = {}) {
  return {
    makeWhoop: () => ({ tag: 'fake' }),
    makeSync: ({ userId }) => ({
      syncAll: async () => {
        if (onBeforeFailure) await onBeforeFailure();
        if (!failing) {
          // 健康的一輪：真的留下同步證據，這樣 READY 的前提才成立
          for (const r of RESOURCES) {
            await db.saveSyncState(userId, r, { lastSuccessAt: NOW.toISOString() }, { now: NOW });
          }
          return RESOURCES.map((resource) => ({ resource, status: 'ok' }));
        }
        // 一般性暫時故障：核心資源失敗 → syncUsable 為 false → failOrRetry
        return RESOURCES.map((resource) => ({
          resource, status: 'failed', error: 'WHOOP 500（暫時性）',
        }));
      },
    }),
    probe: async ({ userId, expectedLifecycleGeneration }) => {
      if (!failing) {
        await db.saveCapabilities(userId, [
          { key: 'recovery', status: 'SUPPORTED', sampleCount: 5, nonNullCount: 5 },
        ], { expectedLifecycleGeneration, now: NOW });
      }
      return { entries: [], scopeErrors: [] };
    },
    notify: async (userId, kind) => { notes.push({ userId, kind }); },
  };
}

// ===========================================================================
// §21 精確重現 Codex 的發現
// ===========================================================================

test('FG-01 ★★★ Codex 重現：attempts=MAX-1 的 worker + 中途重新授權 + 一般性 500 → 不得終局失敗', async () => {
  const e = await env();
  try {
    // 1. 使用者在世代 1
    const user = await authorize(e.db, A_CHAT);
    assert.equal(await genOf(e.db, user.id), 1);

    // 2. 既有的 bootstrap_attempts = MAX - 1
    await setAttempts(e.db, user.id, MAX - 1);
    await e.db.setOnboardingState(user.id, ONBOARDING_STATE.WHOOP_AUTHORIZED, { now: NOW });

    const notes = [];
    let reauthAt = null;
    // 3-9. 開跑（attempts 被推到 MAX）→ 一般性故障前使用者重新授權
    const boot = await runOnboardingBootstrap({
      db: e.db, userId: user.id, env: {}, now: () => NOW,
      deps: failingDeps({ db: e.db,
        notes,
        onBeforeFailure: async () => {
          // 這一刻：舊 worker 手上的快照說 attempts = MAX-1（+1 = MAX）
          assert.equal((await e.db.getOnboarding(user.id)).bootstrapAttempts, MAX,
            '舊 worker 已經把耐久計數推到上限');
          reauthAt = await reauthorize(e.db, A_CHAT);
        },
      }),
    });

    // 6-7. 世代 2；8. callback 已經把額度歸零
    assert.equal(await genOf(e.db, user.id), 2, '★ 重新授權 → 世代 2');
    const after = await onboardingOf(e.db, user.id);
    assert.equal(after.bootstrapAttempts, 0, '★ 新授權把嘗試額度歸零');

    // ---- 核心斷言 ----
    assert.equal(boot.result, BOOTSTRAP_RESULT.STALE_AUTHORIZATION,
      '★★★ 舊 worker 必須回 STALE_AUTHORIZATION');
    assert.notEqual(after.state, ONBOARDING_STATE.ACTION_REQUIRED,
      '★★★ 舊 worker 不得把新授權寫成 ACTION_REQUIRED');
    assert.notEqual(after.failureCode, ONBOARDING_FAILURE.BOOTSTRAP_FAILED,
      '★★★ 不得留下 BOOTSTRAP_FAILED');
    assert.deepEqual(notes, [], '★★★ 不得送出 bootstrap_failed 通知');
    assert.equal(after.bootstrapAttempts, 0,
      '★★★ 額度反映新的授權，不是過期的世代 1 快照');

    // 排程器可以繼續處理世代 2
    const resumed = await runOnboardingBootstrap({
      db: e.db, userId: user.id, env: {}, now: () => reauthAt,
      deps: failingDeps({ db: e.db, notes, failing: false }),
    });
    assert.equal(resumed.result, BOOTSTRAP_RESULT.READY, '★★★ 世代 2 可以正常走完');
    assert.equal((await onboardingOf(e.db, user.id)).state, ONBOARDING_STATE.READY);
  } finally { e.done(); }
});

// ===========================================================================
// §22 失敗視窗競態（最窄的那一個）
// ===========================================================================

test('FG-02 ★★★ 故障已發生、終局寫入之前才重新授權 → 世代 CAS 擋下，無通知', async () => {
  const e = await env();
  try {
    const user = await authorize(e.db, A_CHAT);
    await setAttempts(e.db, user.id, MAX - 1);
    await e.db.setOnboardingState(user.id, ONBOARDING_STATE.WHOOP_AUTHORIZED, { now: NOW });

    const notes = [];
    // 把重新授權塞在「故障已經產生、failOrRetry 還沒寫」之間：
    // syncAll 回傳 failed 之後才觸發，靠的是 probe 不會被呼叫（syncUsable 先擋）。
    // 這裡改用 recordBootstrapAttempt 之後、故障之前的 hook 不夠窄，
    // 所以直接讓 getOnboarding 之後的那一刻發生 —— 用注入的 syncAll 回傳前觸發。
    const boot = await runOnboardingBootstrap({
      db: e.db, userId: user.id, env: {}, now: () => NOW,
      deps: {
        makeWhoop: () => ({ tag: 'fake' }),
        makeSync: () => ({
          syncAll: async () => {
            const results = RESOURCES.map((resource) => ({
              resource, status: 'failed', error: 'WHOOP 503',
            }));
            // 故障「已經發生」，回傳給 bootstrap 之前授權換代
            await reauthorize(e.db, A_CHAT);
            return results;
          },
        }),
        probe: async () => ({ entries: [], scopeErrors: [] }),
        notify: async (userId, kind) => { notes.push({ userId, kind }); },
      },
    });

    assert.equal(boot.result, BOOTSTRAP_RESULT.STALE_AUTHORIZATION);
    const after = await onboardingOf(e.db, user.id);
    assert.notEqual(after.state, ONBOARDING_STATE.ACTION_REQUIRED);
    assert.notEqual(after.failureCode, ONBOARDING_FAILURE.BOOTSTRAP_FAILED);
    assert.deepEqual(notes, [], '★★★ 零列的有條件更新之後絕不通知');
  } finally { e.done(); }
});

test('FG-03 終局 CAS 直接測試：世代不符 → 零列、回報 stale', async () => {
  const e = await env();
  try {
    const user = await authorize(e.db, A_CHAT);
    await setAttempts(e.db, user.id, MAX);
    await e.db.setOnboardingState(user.id, ONBOARDING_STATE.SYNCING, { now: NOW });
    await reauthorize(e.db, A_CHAT);          // 世代 2（狀態 SYNCING 不在 from 白名單，維持 SYNCING）
    await setAttempts(e.db, user.id, MAX);    // 即使次數夠，世代也不對
    await e.db.setOnboardingState(user.id, ONBOARDING_STATE.SYNCING, { now: NOW });

    const r = await e.db.failBootstrapIfExhausted({
      userId: user.id,
      from: [ONBOARDING_STATE.SYNCING, ONBOARDING_STATE.WHOOP_AUTHORIZED],
      failureCode: ONBOARDING_FAILURE.BOOTSTRAP_FAILED,
      failureDetail: 'x', expectedAuthGeneration: 1, maxAttempts: MAX, now: NOW,
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'stale_authorization');
    assert.notEqual((await onboardingOf(e.db, user.id)).state, ONBOARDING_STATE.ACTION_REQUIRED);
  } finally { e.done(); }
});

test('FG-04 終局 CAS：世代對但**目前**次數未達上限 → 零列、below_threshold', async () => {
  const e = await env();
  try {
    const user = await authorize(e.db, A_CHAT);
    await setAttempts(e.db, user.id, MAX - 1);
    await e.db.setOnboardingState(user.id, ONBOARDING_STATE.SYNCING, { now: NOW });

    const r = await e.db.failBootstrapIfExhausted({
      userId: user.id,
      from: [ONBOARDING_STATE.SYNCING, ONBOARDING_STATE.WHOOP_AUTHORIZED],
      failureCode: ONBOARDING_FAILURE.BOOTSTRAP_FAILED,
      failureDetail: 'x', expectedAuthGeneration: 1, maxAttempts: MAX, now: NOW,
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'below_threshold');
    assert.equal(r.attempts, MAX - 1, '★ 讀的是目前耐久值');
    assert.notEqual((await onboardingOf(e.db, user.id)).state, ONBOARDING_STATE.ACTION_REQUIRED);
  } finally { e.done(); }
});

test('FG-05 終局 CAS：世代與次數都對、但狀態已被別人移走 → 零列', async () => {
  const e = await env();
  try {
    const user = await authorize(e.db, A_CHAT);
    await setAttempts(e.db, user.id, MAX);
    await e.db.setOnboardingState(user.id, ONBOARDING_STATE.ACTION_REQUIRED, {
      failureCode: ONBOARDING_FAILURE.OAUTH_DENIED, now: NOW,
    });

    const r = await e.db.failBootstrapIfExhausted({
      userId: user.id,
      from: [ONBOARDING_STATE.SYNCING, ONBOARDING_STATE.WHOOP_AUTHORIZED],
      failureCode: ONBOARDING_FAILURE.BOOTSTRAP_FAILED,
      failureDetail: 'x', expectedAuthGeneration: 1, maxAttempts: MAX, now: NOW,
    });
    assert.equal(r.ok, false);
    assert.ok(String(r.reason).startsWith('state:'), `reason=${r.reason}`);
    assert.equal((await onboardingOf(e.db, user.id)).failureCode, ONBOARDING_FAILURE.OAUTH_DENIED,
      '★ 別人寫的失敗原因沒有被蓋掉');
  } finally { e.done(); }
});

test('FG-06 終局 CAS：條件全部成立 → 寫入成功', async () => {
  const e = await env();
  try {
    const user = await authorize(e.db, A_CHAT);
    await setAttempts(e.db, user.id, MAX);
    await e.db.setOnboardingState(user.id, ONBOARDING_STATE.SYNCING, { now: NOW });

    const r = await e.db.failBootstrapIfExhausted({
      userId: user.id,
      from: [ONBOARDING_STATE.SYNCING, ONBOARDING_STATE.WHOOP_AUTHORIZED],
      failureCode: ONBOARDING_FAILURE.BOOTSTRAP_FAILED,
      failureDetail: 'initial_sync_failed', expectedAuthGeneration: 1, maxAttempts: MAX, now: NOW,
    });
    assert.equal(r.ok, true);
    const after = await onboardingOf(e.db, user.id);
    assert.equal(after.state, ONBOARDING_STATE.ACTION_REQUIRED);
    assert.equal(after.failureCode, ONBOARDING_FAILURE.BOOTSTRAP_FAILED);
    assert.equal(after.failureDetail, 'initial_sync_failed');
  } finally { e.done(); }
});

// ===========================================================================
// §23 / §24 同世代行為必須原封不動
// ===========================================================================

test('FG-07 ★★★ 沒有重新授權：一般性故障仍然會耗盡斷路器並通知（不得被解除）', async () => {
  const e = await env();
  try {
    const user = await authorize(e.db, A_CHAT);
    const notes = [];
    let last = null;
    for (let i = 0; i < MAX; i++) {
      last = await runOnboardingBootstrap({
        db: e.db, userId: user.id, env: {}, now: () => NOW, deps: failingDeps({ db: e.db, notes }),
      });
    }
    assert.equal(last.result, BOOTSTRAP_RESULT.ACTION_REQUIRED,
      '★★★ 真實的連續失敗仍然走到 ACTION_REQUIRED');
    const after = await onboardingOf(e.db, user.id);
    assert.equal(after.state, ONBOARDING_STATE.ACTION_REQUIRED);
    assert.equal(after.failureCode, ONBOARDING_FAILURE.BOOTSTRAP_FAILED);
    assert.deepEqual(notes.map((n) => n.kind), ['bootstrap_failed'],
      '★★★ 成功的終局轉移**之後**送出正好一則通知');
    assert.equal(await genOf(e.db, user.id), 1, '★ 世代沒動');
  } finally { e.done(); }
});

test('FG-08 未達上限的一般性故障 → RETRY，不通知、不 ACTION_REQUIRED', async () => {
  const e = await env();
  try {
    const user = await authorize(e.db, A_CHAT);
    const notes = [];
    const boot = await runOnboardingBootstrap({
      db: e.db, userId: user.id, env: {}, now: () => NOW, deps: failingDeps({ db: e.db, notes }),
    });
    assert.equal(boot.result, BOOTSTRAP_RESULT.RETRY);
    assert.equal(boot.attempts, 1, '★ 回報的是目前耐久次數');
    const after = await onboardingOf(e.db, user.id);
    assert.equal(after.state, ONBOARDING_STATE.SYNCING, '★ 留在 SYNCING 等下一輪');
    assert.notEqual(after.failureCode, ONBOARDING_FAILURE.BOOTSTRAP_FAILED);
    assert.deepEqual(notes, []);
  } finally { e.done(); }
});

test('FG-09 一次成功的重新授權之後，斷路器從頭開始（額度真的可用）', async () => {
  const e = await env();
  try {
    const user = await authorize(e.db, A_CHAT);
    const notes = [];
    // 先耗到剩一次
    for (let i = 0; i < MAX - 1; i++) {
      await runOnboardingBootstrap({
        db: e.db, userId: user.id, env: {}, now: () => NOW, deps: failingDeps({ db: e.db, notes }),
      });
    }
    assert.equal((await onboardingOf(e.db, user.id)).bootstrapAttempts, MAX - 1);

    // 重新授權 → 額度歸零
    const t = await reauthorize(e.db, A_CHAT);
    assert.equal((await onboardingOf(e.db, user.id)).bootstrapAttempts, 0);

    // 現在還能再失敗 MAX-1 次而不被終局宣告
    for (let i = 0; i < MAX - 1; i++) {
      const r = await runOnboardingBootstrap({
        db: e.db, userId: user.id, env: {}, now: () => t, deps: failingDeps({ db: e.db, notes }),
      });
      assert.equal(r.result, BOOTSTRAP_RESULT.RETRY, `第 ${i + 1} 次應該還是 RETRY`);
    }
    assert.deepEqual(notes, [], '★ 全程沒有終局通知');
    // 第 MAX 次才終局
    const last = await runOnboardingBootstrap({
      db: e.db, userId: user.id, env: {}, now: () => t, deps: failingDeps({ db: e.db, notes }),
    });
    assert.equal(last.result, BOOTSTRAP_RESULT.ACTION_REQUIRED, '★★★ 斷路器沒有被解除');
    assert.deepEqual(notes.map((n) => n.kind), ['bootstrap_failed']);
  } finally { e.done(); }
});

// ===========================================================================
// §25 重複合法重新授權不得把人卡死
// ===========================================================================

test('FG-10 ★★★ 反覆合法重新授權 + 每次都撞到一般性故障 → 使用者不會被卡死', async () => {
  const e = await env();
  try {
    const user = await authorize(e.db, A_CHAT);
    const notes = [];
    let at = NOW;
    for (let i = 0; i < MAX + 3; i++) {
      await setAttempts(e.db, user.id, MAX - 1);
      await e.db.setOnboardingState(user.id, ONBOARDING_STATE.WHOOP_AUTHORIZED, { now: at });
      const when = at;
      const r = await runOnboardingBootstrap({
        db: e.db, userId: user.id, env: {}, now: () => when,
        deps: failingDeps({ db: e.db,
          notes,
          onBeforeFailure: async () => {
            at = await reauthorize(e.db, A_CHAT, {
              at: new Date(when.getTime() + ONBOARDING.AUTH_LINK_COOLDOWN_MS + 1),
            });
          },
        }),
      });
      assert.equal(r.result, BOOTSTRAP_RESULT.STALE_AUTHORIZATION, `第 ${i + 1} 輪應該是 stale`);
      const o = await onboardingOf(e.db, user.id);
      assert.notEqual(o.state, ONBOARDING_STATE.ACTION_REQUIRED,
        `★★★ 第 ${i + 1} 輪：合法的授權變更不得把人卡死`);
    }
    assert.deepEqual(notes, [], '★★★ 全程零通知');

    // 最後乾淨跑完 → READY
    const final = await runOnboardingBootstrap({
      db: e.db, userId: user.id, env: {}, now: () => at, deps: failingDeps({ db: e.db, notes, failing: false }),
    });
    assert.equal(final.result, BOOTSTRAP_RESULT.READY);
  } finally { e.done(); }
});

// ===========================================================================
// §26 / §27 併發與多使用者
// ===========================================================================

test('FG-11 兩個 worker 不得在新授權之後競相寫出無效的終局狀態', async () => {
  const e = await env();
  try {
    const user = await authorize(e.db, A_CHAT);
    await setAttempts(e.db, user.id, MAX);
    await e.db.setOnboardingState(user.id, ONBOARDING_STATE.SYNCING, { now: NOW });
    await reauthorize(e.db, A_CHAT);   // 世代 2；狀態維持 SYNCING
    await setAttempts(e.db, user.id, MAX);
    await e.db.setOnboardingState(user.id, ONBOARDING_STATE.SYNCING, { now: NOW });

    // 兩個都拿著過期的世代 1
    const [a, b] = await Promise.all([
      e.db.failBootstrapIfExhausted({
        userId: user.id, from: [ONBOARDING_STATE.SYNCING],
        failureCode: ONBOARDING_FAILURE.BOOTSTRAP_FAILED,
        expectedAuthGeneration: 1, maxAttempts: MAX, now: NOW,
      }),
      e.db.failBootstrapIfExhausted({
        userId: user.id, from: [ONBOARDING_STATE.SYNCING],
        failureCode: ONBOARDING_FAILURE.BOOTSTRAP_FAILED,
        expectedAuthGeneration: 1, maxAttempts: MAX, now: NOW,
      }),
    ]);
    assert.equal(a.ok, false);
    assert.equal(b.ok, false);
    assert.equal(a.reason, 'stale_authorization');
    assert.equal(b.reason, 'stale_authorization');
    assert.notEqual((await onboardingOf(e.db, user.id)).state, ONBOARDING_STATE.ACTION_REQUIRED,
      '★★★ 兩個過期 worker 都不能寫出終局狀態');
  } finally { e.done(); }
});

test('FG-12 bootstrap 鎖：同一使用者兩個併發 bootstrap 不會寫出矛盾的終局狀態', async () => {
  const e = await env();
  try {
    const user = await authorize(e.db, A_CHAT);
    await setAttempts(e.db, user.id, MAX - 1);
    await e.db.setOnboardingState(user.id, ONBOARDING_STATE.WHOOP_AUTHORIZED, { now: NOW });
    const notes = [];
    const [a, b] = await Promise.all([
      runOnboardingBootstrap({
        db: e.db, userId: user.id, env: {}, now: () => NOW, deps: failingDeps({ db: e.db, notes }),
      }),
      runOnboardingBootstrap({
        db: e.db, userId: user.id, env: {}, now: () => NOW, deps: failingDeps({ db: e.db, notes }),
      }),
    ]);
    const results = [a.result, b.result];
    assert.ok(results.includes(BOOTSTRAP_RESULT.BUSY),
      `★ 鎖應該讓其中一個直接 BUSY：${results}`);
    assert.ok(notes.length <= 1, '★★★ 最多一則終局通知');
    const after = await onboardingOf(e.db, user.id);
    if (after.state === ONBOARDING_STATE.ACTION_REQUIRED) {
      assert.equal(after.failureCode, ONBOARDING_FAILURE.BOOTSTRAP_FAILED);
      assert.deepEqual(notes.map((n) => n.kind), ['bootstrap_failed']);
    }
  } finally { e.done(); }
});

test('FG-13 ★★★ Alice 的過期終局失敗不得影響 Bob', async () => {
  const e = await env();
  try {
    const alice = await authorize(e.db, A_CHAT, { whoopUserId: 'W-A' });
    const bob = await authorize(e.db, B_CHAT, { whoopUserId: 'W-B' });

    // Bob 走到接近上限，但仍然健康
    await setAttempts(e.db, bob.id, MAX - 1);
    await e.db.setOnboardingState(bob.id, ONBOARDING_STATE.SYNCING, { now: NOW });

    const notes = [];
    await setAttempts(e.db, alice.id, MAX - 1);
    await e.db.setOnboardingState(alice.id, ONBOARDING_STATE.WHOOP_AUTHORIZED, { now: NOW });
    const aliceBoot = await runOnboardingBootstrap({
      db: e.db, userId: alice.id, env: {}, now: () => NOW,
      deps: failingDeps({ db: e.db,
        notes,
        onBeforeFailure: async () => { await reauthorize(e.db, A_CHAT, { whoopUserId: 'W-A' }); },
      }),
    });
    assert.equal(aliceBoot.result, BOOTSTRAP_RESULT.STALE_AUTHORIZATION);

    // Bob 完全不受影響
    const bobOnb = await onboardingOf(e.db, bob.id);
    assert.equal(bobOnb.state, ONBOARDING_STATE.SYNCING, '★★★ Bob 的狀態沒動');
    assert.equal(bobOnb.bootstrapAttempts, MAX - 1, '★★★ Bob 的額度沒動');
    assert.notEqual(bobOnb.failureCode, ONBOARDING_FAILURE.BOOTSTRAP_FAILED);
    assert.equal(await genOf(e.db, bob.id), 1, '★★★ Bob 的世代沒動');
    assert.deepEqual(notes.filter((n) => n.userId === bob.id), [], '★★★ Bob 沒收到任何通知');
  } finally { e.done(); }
});

// ===========================================================================
// 其他失敗路徑也必須被同一個圍欄蓋住
// ===========================================================================

test('FG-14 capability 一般性故障：過期世代同樣不得終局失敗', async () => {
  const e = await env();
  try {
    const user = await authorize(e.db, A_CHAT);
    await setAttempts(e.db, user.id, MAX - 1);
    await e.db.setOnboardingState(user.id, ONBOARDING_STATE.WHOOP_AUTHORIZED, { now: NOW });
    const notes = [];
    const boot = await runOnboardingBootstrap({
      db: e.db, userId: user.id, env: {}, now: () => NOW,
      deps: {
        makeWhoop: () => ({ tag: 'fake' }),
        makeSync: ({ userId }) => ({
          syncAll: async () => {
            for (const r of RESOURCES) {
              await e.db.saveSyncState(userId, r, { lastSuccessAt: NOW.toISOString() }, { now: NOW });
            }
            return RESOURCES.map((resource) => ({ resource, status: 'ok' }));
          },
        }),
        probe: async () => {
          await reauthorize(e.db, A_CHAT);          // 世代換代
          throw new Error('probe 500（一般性故障，不是世代錯誤）');
        },
        notify: async (userId, kind) => { notes.push({ userId, kind }); },
      },
    });
    assert.equal(boot.result, BOOTSTRAP_RESULT.STALE_AUTHORIZATION);
    const after = await onboardingOf(e.db, user.id);
    assert.notEqual(after.state, ONBOARDING_STATE.ACTION_REQUIRED);
    assert.notEqual(after.failureCode, ONBOARDING_FAILURE.BOOTSTRAP_FAILED);
    assert.deepEqual(notes, []);
  } finally { e.done(); }
});

test('FG-15 同世代的 capability 一般性故障仍然照常耗盡斷路器', async () => {
  const e = await env();
  try {
    const user = await authorize(e.db, A_CHAT);
    await setAttempts(e.db, user.id, MAX - 1);
    await e.db.setOnboardingState(user.id, ONBOARDING_STATE.WHOOP_AUTHORIZED, { now: NOW });
    const notes = [];
    const boot = await runOnboardingBootstrap({
      db: e.db, userId: user.id, env: {}, now: () => NOW,
      deps: {
        makeWhoop: () => ({ tag: 'fake' }),
        makeSync: ({ userId }) => ({
          syncAll: async () => {
            for (const r of RESOURCES) {
              await e.db.saveSyncState(userId, r, { lastSuccessAt: NOW.toISOString() }, { now: NOW });
            }
            return RESOURCES.map((resource) => ({ resource, status: 'ok' }));
          },
        }),
        probe: async () => { throw new Error('probe 500'); },
        notify: async (userId, kind) => { notes.push({ userId, kind }); },
      },
    });
    assert.equal(boot.result, BOOTSTRAP_RESULT.ACTION_REQUIRED, '★ 同世代照常終局');
    assert.equal((await onboardingOf(e.db, user.id)).failureCode,
      ONBOARDING_FAILURE.BOOTSTRAP_FAILED);
    assert.deepEqual(notes.map((n) => n.kind), ['bootstrap_failed']);
  } finally { e.done(); }
});

test('FG-16 scope 缺失路徑（已經是世代圍欄的）不受影響', async () => {
  const e = await env();
  try {
    const user = await authorize(e.db, A_CHAT);
    const notes = [];
    const boot = await runOnboardingBootstrap({
      db: e.db, userId: user.id, env: {}, now: () => NOW,
      deps: {
        makeWhoop: () => ({ tag: 'fake' }),
        makeSync: ({ userId }) => ({
          syncAll: async () => {
            for (const r of RESOURCES) {
              if (r === 'sleep') continue;
              await e.db.saveSyncState(userId, r, { lastSuccessAt: NOW.toISOString() }, { now: NOW });
            }
            return RESOURCES.map((resource) => ({
              resource, status: resource === 'sleep' ? 'scope_missing' : 'ok',
            }));
          },
        }),
        probe: async ({ userId, expectedLifecycleGeneration }) => {
          await e.db.saveCapabilities(userId, [
            { key: 'recovery', status: 'SUPPORTED', sampleCount: 5, nonNullCount: 5 },
          ], { expectedLifecycleGeneration, now: NOW });
          return { entries: [], scopeErrors: [{ resource: 'sleep' }] };
        },
        notify: async (userId, kind) => { notes.push({ userId, kind }); },
      },
    });
    assert.equal(boot.result, BOOTSTRAP_RESULT.ACTION_REQUIRED);
    assert.deepEqual(boot.lacking, ['sleep']);
    assert.equal((await onboardingOf(e.db, user.id)).failureCode,
      ONBOARDING_FAILURE.WHOOP_SCOPE_INCOMPLETE, '★ 仍然是 scope 專用的失敗碼');
    assert.deepEqual(notes.map((n) => n.kind), ['scope_incomplete']);
    const access = await e.db.getResourceAccess(user.id);
    assert.equal(access.find((a) => a.resource === 'sleep').status,
      RESOURCE_ACCESS_STATUS.UNAUTHORIZED);
  } finally { e.done(); }
});

test('FG-17 沒有 token 列的 bootstrap：授權快照是 NULL，圍欄釘在同一個事實上', async () => {
  const e = await env();
  try {
    const user = await authorize(e.db, A_CHAT);
    // 把 token 列刪掉：這一輪的授權快照變成「沒有授權」
    await e.db.raw.execute({
      sql: 'DELETE FROM user_whoop_tokens WHERE user_id = ?', args: [user.id],
    });
    await setAttempts(e.db, user.id, MAX);
    await e.db.setOnboardingState(user.id, ONBOARDING_STATE.WHOOP_AUTHORIZED, { now: NOW });

    const notes = [];
    const boot = await runOnboardingBootstrap({
      db: e.db, userId: user.id, env: {}, now: () => NOW, deps: failingDeps({ db: e.db, notes }),
    });
    // 快照一致（仍然沒有 token）→ 終局升級成立
    assert.equal(boot.result, BOOTSTRAP_RESULT.ACTION_REQUIRED);
    assert.equal((await onboardingOf(e.db, user.id)).failureCode,
      ONBOARDING_FAILURE.BOOTSTRAP_FAILED);
    assert.deepEqual(notes.map((n) => n.kind), ['bootstrap_failed']);
  } finally { e.done(); }
});

test('FG-18 沒有 token 列 → 期間完成了授權 → 舊結論不得成立', async () => {
  const e = await env();
  try {
    const user = await authorize(e.db, A_CHAT);
    const tokens = await e.db.getTokens(user.id);
    await e.db.raw.execute({
      sql: 'DELETE FROM user_whoop_tokens WHERE user_id = ?', args: [user.id],
    });
    await setAttempts(e.db, user.id, MAX);
    await e.db.setOnboardingState(user.id, ONBOARDING_STATE.SYNCING, { now: NOW });

    // 期間授權完成（token 列回來了）
    await e.db.saveTokens(user.id, {
      accessToken: tokens.accessToken, refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt, scope: tokens.scope, whoopUserId: 'W1',
    });

    const r = await e.db.failBootstrapIfExhausted({
      userId: user.id, from: [ONBOARDING_STATE.SYNCING],
      failureCode: ONBOARDING_FAILURE.BOOTSTRAP_FAILED,
      expectedAuthGeneration: null, maxAttempts: MAX, now: NOW,
    });
    assert.equal(r.ok, false, '★★★ 「我看到沒有授權」的結論已經過期了');
    assert.equal(r.reason, 'stale_authorization');
    assert.notEqual((await onboardingOf(e.db, user.id)).state, ONBOARDING_STATE.ACTION_REQUIRED);
  } finally { e.done(); }
});
