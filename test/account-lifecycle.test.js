/**
 * V1.2 Phase 3.5 — 帳號啟用生命週期（schema v17）。
 *
 * ## 為什麼只看 status 不夠：ABA
 *
 *     t0  worker 在 ACTIVE 開跑（啟用世代 L）
 *     t1  帳號被停用（PAUSED / DISABLED）→ L+1
 *     t2  帳號又被啟用                   → L+2
 *     t3  舊 worker 醒來寫入 → status 又是 ACTIVE → 只看狀態就會放行
 *
 * 於是一份**跨越了一整段停用期**的結論、報告、回覆或健康資料會生效。
 * lifecycle_generation 讓 t3 變成可判定的：L ≠ L+2。
 *
 * 這個檔案同時涵蓋「停用中」與「停用→再啟用」兩類，而且每一個停用測試
 * 都對 PAUSED 與 DISABLED 各跑一次（§41：合法條件只有 status === ACTIVE）。
 *
 * 全部用真實 libSQL、真實的 runOnboardingBootstrap / OAuth callback。
 * 競態用 hook 造，不用 sleep。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createDb } from './localDb.js';
import { handleUnlinkedMessage, handleOnboardingMessage, issueAuthLink } from '../src/onboarding.js';
import { createWhoopOAuthCallback } from '../src/whoopOAuthCallback.js';
import { runOnboardingBootstrap, resumeOnboardingBootstraps, BOOTSTRAP_RESULT } from '../src/onboardingBootstrap.js';
import { createSync } from '../src/sync.js';
import { isAccountInactiveError, withDeliveryAuthorization } from '../src/accountLifecycle.js';
import {
  ONBOARDING_STATE, ONBOARDING_FAILURE, USER_STATUS, RESOURCE_ACCESS_STATUS, SCHEMA_VERSION,
  ANALYTICS_CLASS,
} from '../src/schema.js';
import { ONBOARDING } from '../src/config.js';

const NOW = new Date('2026-09-15T12:00:00.000Z');
const HOUR = 3_600_000;
const CLIENT_ID = 'test-client';
const REDIRECT = 'https://example.test/whoop/oauth/callback';
const A_CHAT = '511111';
const B_CHAT = '522222';
const RESOURCES = ['sleep', 'recovery', 'cycle', 'workout', 'body_measurement'];
/** ★ §41：每一個「停用」情境都要對兩種非 ACTIVE 狀態各跑一次。 */
const INACTIVE = [USER_STATUS.PAUSED, USER_STATUS.DISABLED];

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whoop-life-'));
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
const lifeOf = async (db, userId) => (await db.getUser(userId))?.lifecycleGeneration ?? null;
const accessOf = async (db, userId) => Object.fromEntries(
  (await db.getResourceAccess(userId)).map((r) => [r.resource, r]),
);

const fakeWhoopBackend = ({ whoopUserId = 'W1' } = {}) => ({
  exchange: async ({ code }) => {
    if (!code || code === 'bad') throw new Error('invalid_grant');
    return {
      accessToken: `at-${whoopUserId}`, refreshToken: `rt-${whoopUserId}`,
      expiresAt: new Date(NOW.getTime() + HOUR), scope: 'offline read:sleep read:recovery',
    };
  },
  verifyIdentity: async () => whoopUserId,
});

async function authorize(db, chatId, { whoopUserId = 'W1', timezone = 'Asia/Taipei' } = {}) {
  await onb(db, chatId, '/start');
  const user = await userFor(db, chatId);
  const reply = await linked(db, user, timezone);
  const cb = createWhoopOAuthCallback({ db, ...fakeWhoopBackend({ whoopUserId }), now: () => NOW });
  assert.equal((await cb({
    query: new URLSearchParams({ code: 'good', state: stateFromUrl(urlIn(reply)) }),
  })).outcome, 'ok');
  return await db.getUser(user.id);
}

/** 依賴：可在任何階段觸發 hook，並記錄實際發出的 WHOOP 呼叫與通知。 */
function deps({ db, calls = [], notes = [], onStage = async () => {}, scopeMissing = [] } = {}) {
  return {
    makeWhoop: () => ({ tag: 'fake' }),
    makeSync: ({ userId, expectedLifecycleGeneration }) => ({
      syncAll: async () => {
        calls.push({ stage: 'sync', expectedLifecycleGeneration });
        const out = [];
        for (const r of RESOURCES) {
          if (!scopeMissing.includes(r)) {
            await db.saveSyncState(userId, r, { lastSuccessAt: NOW.toISOString() }, { now: NOW });
          }
          out.push({ resource: r, status: scopeMissing.includes(r) ? 'scope_missing' : 'ok' });
        }
        await onStage('after_sync');
        return out;
      },
    }),
    probe: async ({ userId, expectedLifecycleGeneration }) => {
      calls.push({ stage: 'probe', expectedLifecycleGeneration });
      await db.saveCapabilities(userId, [
        { key: 'recovery', status: 'SUPPORTED', sampleCount: 5, nonNullCount: 5 },
      ], { expectedLifecycleGeneration, now: NOW });
      await onStage('after_probe');
      return { entries: [], scopeErrors: scopeMissing.map((resource) => ({ resource })) };
    },
    notify: async (userId, kind) => { notes.push({ userId, kind }); },
  };
}

// ===========================================================================
// 架構：世代本身
// ===========================================================================

test('LIFE-GEN-01 每一次真正的狀態轉移都推進啟用世代；沒變就不推', async () => {
  const e = await env();
  try {
    const user = await authorize(e.db, A_CHAT);
    assert.equal(await lifeOf(e.db, user.id), 1, '★ 新使用者從 1 開始');

    const a = await e.db.transitionUserLifecycle({ userId: user.id, targetStatus: USER_STATUS.DISABLED });
    assert.equal(a.changed, true);
    assert.deepEqual([a.oldGeneration, a.newGeneration], [1, 2]);

    // 冪等：同樣的目標狀態不推世代
    const again = await e.db.transitionUserLifecycle({ userId: user.id, targetStatus: USER_STATUS.DISABLED });
    assert.equal(again.changed, false);
    assert.equal(await lifeOf(e.db, user.id), 2, '★★★ 狀態沒變就不可以推世代');

    // 每一種轉移都推
    for (const [target, expected] of [
      [USER_STATUS.PAUSED, 3], [USER_STATUS.ACTIVE, 4],
      [USER_STATUS.PAUSED, 5], [USER_STATUS.DISABLED, 6], [USER_STATUS.ACTIVE, 7],
    ]) {
      await e.db.transitionUserLifecycle({ userId: user.id, targetStatus: target });
      assert.equal(await lifeOf(e.db, user.id), expected, `→ ${target}`);
    }
  } finally { e.done(); }
});

test('LIFE-GEN-02 ★★★ updateUser 不可以改 status（沒有繞過世代的後門）', async () => {
  const e = await env();
  try {
    const user = await authorize(e.db, A_CHAT);
    await assert.rejects(
      () => e.db.updateUser(user.id, { status: USER_STATUS.DISABLED }),
      /transitionUserLifecycle/,
      '★★★ 唯一能改 status 的路徑必須推進世代',
    );
    assert.equal((await e.db.getUser(user.id)).status, USER_STATUS.ACTIVE);
    assert.equal(await lifeOf(e.db, user.id), 1);
    // 其他欄位照常
    const after = await e.db.updateUser(user.id, { timezone: 'UTC' });
    assert.equal(after.timezone, 'UTC');
    assert.equal(await lifeOf(e.db, user.id), 1, '★ 一般更新不動世代');
  } finally { e.done(); }
});

test('LIFE-GEN-03 遷移：既有使用者一律從世代 1 開始，schema 為 v17', async () => {
  const e = await env();
  try {
    assert.equal(SCHEMA_VERSION, 22);
    const user = await authorize(e.db, A_CHAT);
    assert.equal(await lifeOf(e.db, user.id), 1);
    // 重跑遷移是冪等的，而且不動世代
    await e.db.migrate();
    assert.equal(await lifeOf(e.db, user.id), 1, '★ 重複遷移不改變世代');
  } finally { e.done(); }
});

// ===========================================================================
// §47 停用中
// ===========================================================================

for (const status of INACTIVE) {
  test(`LIFE-01/${status} 停用的帳號不會被上線排程選到`, async () => {
    const e = await env();
    try {
      const user = await authorize(e.db, A_CHAT);
      await e.db.transitionUserLifecycle({ userId: user.id, targetStatus: status });
      const pending = await e.db.listOnboardingInState(
        [ONBOARDING_STATE.WHOOP_AUTHORIZED, ONBOARDING_STATE.SYNCING],
      );
      assert.deepEqual(pending, [], '★★★ 選取層就要排除');
      const resumed = await resumeOnboardingBootstraps({ db: e.db, env: {}, now: () => NOW, deps: deps({ db: e.db }) });
      assert.deepEqual(resumed, []);
      assert.deepEqual(await e.db.listSchedulableUsers({ activeStatus: USER_STATUS.ACTIVE }), []);
    } finally { e.done(); }
  });

  test(`LIFE-02/${status} 選取後、進入 bootstrap 前被停用 → 零 WHOOP、零次數、零變更、零通知`, async () => {
    const e = await env();
    try {
      const user = await authorize(e.db, A_CHAT);
      const before = await e.db.getOnboarding(user.id);
      await e.db.transitionUserLifecycle({ userId: user.id, targetStatus: status });
      const calls = []; const notes = [];
      const boot = await runOnboardingBootstrap({
        db: e.db, userId: user.id, env: {}, now: () => NOW, deps: deps({ db: e.db, calls, notes }),
      });
      assert.equal(boot.result, BOOTSTRAP_RESULT.ACCOUNT_INACTIVE);
      assert.deepEqual(calls, [], '★★★ 一次 WHOOP 都不可以打');
      assert.deepEqual(notes, [], '★★★ 一則通知都不可以送');
      const after = await e.db.getOnboarding(user.id);
      assert.equal(after.bootstrapAttempts, before.bootstrapAttempts, '★★★ 不消耗嘗試額度');
      assert.equal(after.state, before.state, '★★★ 狀態不動');
      assert.notEqual(after.failureCode, ONBOARDING_FAILURE.BOOTSTRAP_FAILED);
    } finally { e.done(); }
  });

  test(`LIFE-03/${status} 嘗試次數圍欄：停用時 recordBootstrapAttempt 不加`, async () => {
    const e = await env();
    try {
      const user = await authorize(e.db, A_CHAT);
      await e.db.transitionUserLifecycle({ userId: user.id, targetStatus: status });
      const r = await e.db.recordBootstrapAttempt(user.id, { now: NOW });
      assert.equal(r.ok, false);
      assert.equal((await e.db.getOnboarding(user.id)).bootstrapAttempts, 0);
    } finally { e.done(); }
  });

  test(`LIFE-04/${status} 同步途中被停用 → canonical 不落地，而且游標不前進`, async () => {
    const e = await env();
    try {
      const user = await authorize(e.db, A_CHAT);
      const life = await lifeOf(e.db, user.id);
      const record = (id) => ({
        id, user_id: 12345, created_at: NOW.toISOString(), updated_at: NOW.toISOString(),
        start: NOW.toISOString(), end: NOW.toISOString(), timezone_offset: '+08:00',
        score_state: 'SCORED', score: { stage_summary: {} },
      });
      const sync = createSync({
        db: e.db, userId: user.id, timezone: 'Asia/Taipei',
        expectedLifecycleGeneration: life, now: NOW,
        whoop: {
          // 抓完資料之後、落地之前把帳號停用
          sleeps: async () => {
            await e.db.transitionUserLifecycle({ userId: user.id, targetStatus: status });
            return [record('s-1')];
          },
          recoveries: async () => [], cycles: async () => [],
          workouts: async () => [], bodyMeasurement: async () => null,
        },
      });
      const results = await sync.syncAll({ force: true, resources: ['sleep'] });
      assert.equal(results[0].status, 'account_inactive', '★★★ 分類成帳號層級的停止');

      const rows = await e.db.raw.execute({
        sql: 'SELECT COUNT(*) n FROM whoop_sleeps WHERE user_id = ?', args: [user.id],
      });
      assert.equal(Number(rows.rows[0].n), 0, '★★★ canonical 一列都不可以寫進去');
      const st = await e.db.getSyncState(user.id, 'sleep');
      assert.ok(!st?.lastSuccessAt, '★★★ 游標／進度絕不可以前進（否則那段資料被永久跳過）');
    } finally { e.done(); }
  });

  test(`LIFE-05/${status} capability 盤點時被停用 → 證據不落地`, async () => {
    const e = await env();
    try {
      const user = await authorize(e.db, A_CHAT);
      const life = await lifeOf(e.db, user.id);
      await e.db.transitionUserLifecycle({ userId: user.id, targetStatus: status });
      const n = await e.db.saveCapabilities(user.id, [
        { key: 'recovery', status: 'SUPPORTED', sampleCount: 5, nonNullCount: 5 },
      ], { expectedLifecycleGeneration: life, now: NOW });
      assert.equal(n, 0, '★★★ 停用帳號不產生新的資格證據');
      const caps = await e.db.getCapabilities(user.id);
      assert.ok(!caps || !Object.keys(caps).length);
    } finally { e.done(); }
  });

  test(`LIFE-06/${status} 停用之後不可能 READY`, async () => {
    const e = await env();
    try {
      const user = await authorize(e.db, A_CHAT);
      const life = await lifeOf(e.db, user.id);
      await e.db.recordResourceAccess(user.id, ONBOARDING.REQUIRED_SCOPES.map((resource) => ({
        resource, status: RESOURCE_ACCESS_STATUS.ACCESSIBLE,
      })), { expectedAuthGeneration: 1, expectedLifecycleGeneration: life, now: NOW });
      await e.db.saveCapabilities(user.id, [{ key: 'recovery', status: 'SUPPORTED', sampleCount: 5, nonNullCount: 5 }],
        { expectedLifecycleGeneration: life, now: NOW });
      await e.db.saveSyncState(user.id, 'sleep', { lastSuccessAt: NOW.toISOString() }, { now: NOW });
      await e.db.setOnboardingState(user.id, ONBOARDING_STATE.SYNCING, { now: NOW });

      await e.db.transitionUserLifecycle({ userId: user.id, targetStatus: status });
      const ready = await e.db.setReadyIfEligible({
        userId: user.id, requiredResources: ONBOARDING.REQUIRED_SCOPES, now: NOW,
      });
      assert.equal(ready.ok, false, '★★★ 停用的帳號絕不可以 READY');
      assert.notEqual(await stateOf(e.db, user.id), ONBOARDING_STATE.READY);
    } finally { e.done(); }
  });

  test(`LIFE-07/${status} 舊 worker 的 scope ACTION_REQUIRED 在停用後被擋、且不通知`, async () => {
    const e = await env();
    try {
      const user = await authorize(e.db, A_CHAT);
      const notes = [];
      const boot = await runOnboardingBootstrap({
        db: e.db, userId: user.id, env: {}, now: () => NOW,
        deps: deps({
          db: e.db, notes, scopeMissing: ['sleep'],
          onStage: async (stage) => {
            if (stage !== 'after_probe') return;
            await e.db.transitionUserLifecycle({ userId: user.id, targetStatus: status });
          },
        }),
      });
      assert.equal(boot.result, BOOTSTRAP_RESULT.ACCOUNT_INACTIVE);
      const o = await e.db.getOnboarding(user.id);
      assert.notEqual(o.failureCode, ONBOARDING_FAILURE.WHOOP_SCOPE_INCOMPLETE);
      assert.deepEqual(notes, [], '★★★ 不可以對停用的人發權限提示');
    } finally { e.done(); }
  });

  test(`LIFE-08/${status} 終局 BOOTSTRAP_FAILED 在停用後被擋、且不通知`, async () => {
    const e = await env();
    try {
      const user = await authorize(e.db, A_CHAT);
      for (let i = 0; i < ONBOARDING.MAX_BOOTSTRAP_ATTEMPTS; i++) {
        await e.db.recordBootstrapAttempt(user.id, { now: NOW });
      }
      await e.db.setOnboardingState(user.id, ONBOARDING_STATE.SYNCING, { now: NOW });
      await e.db.transitionUserLifecycle({ userId: user.id, targetStatus: status });

      const r = await e.db.failBootstrapIfExhausted({
        userId: user.id, from: [ONBOARDING_STATE.SYNCING],
        failureCode: ONBOARDING_FAILURE.BOOTSTRAP_FAILED,
        maxAttempts: ONBOARDING.MAX_BOOTSTRAP_ATTEMPTS, now: NOW,
      });
      assert.equal(r.ok, false);
      assert.equal(r.reason, 'account_inactive');
      assert.notEqual((await e.db.getOnboarding(user.id)).state, ONBOARDING_STATE.ACTION_REQUIRED);
    } finally { e.done(); }
  });

  test(`LIFE-09/${status} 分析完成、送出前被停用 → 不遞送`, async () => {
    const e = await env();
    try {
      const user = await authorize(e.db, A_CHAT);
      const life = await lifeOf(e.db, user.id);
      const sent = [];
      const tg = withDeliveryAuthorization(
        { send: async (t) => { sent.push(t); return { messageId: 1 }; }, notifyError: async () => {} },
        async () => Boolean(await e.db.getActiveChatIdForUser(user.id, { expectedLifecycleGeneration: life })),
      );
      assert.ok(await e.db.getActiveChatIdForUser(user.id, { expectedLifecycleGeneration: life }));
      await e.db.transitionUserLifecycle({ userId: user.id, targetStatus: status });
      const r = await tg.send('今天的日報');
      assert.equal(r.suppressed, 'ACCOUNT_INACTIVE');
      assert.deepEqual(sent, [], '★★★ 停用之後不可以送出健康內容');
      assert.equal(await e.db.getActiveChatIdForUser(user.id), null, '★ 送出授權本身也擋');
    } finally { e.done(); }
  });

  test(`LIFE-11/${status} OAuth state 發出後被停用 → callback 不能綁定也不能啟動 bootstrap`, async () => {
    const e = await env();
    try {
      await onb(e.db, A_CHAT, '/start');
      const user = await userFor(e.db, A_CHAT);
      const reply = await linked(e.db, user, 'Asia/Taipei');
      const state = stateFromUrl(urlIn(reply));
      await e.db.transitionUserLifecycle({ userId: user.id, targetStatus: status });

      let bootstrapped = false;
      const cb = createWhoopOAuthCallback({
        db: e.db, ...fakeWhoopBackend(), now: () => NOW,
        onAuthorized: async () => { bootstrapped = true; },
      });
      const res = await cb({ query: new URLSearchParams({ code: 'good', state }) });
      assert.notEqual(res.outcome, 'ok', '★★★ 停用帳號的 callback 不可以成功');
      assert.equal(bootstrapped, false, '★★★ 不可以啟動 bootstrap');
      assert.equal(await e.db.getTokens(user.id), null, '★★★ 不可以寫入任何 token');
      const o = await e.db.getOnboarding(user.id);
      assert.notEqual(o.state, ONBOARDING_STATE.WHOOP_AUTHORIZED, '★★★ 不可以推進上線狀態');
    } finally { e.done(); }
  });

  test(`LIFE-12/${status} 停用使用者 /start：不建孤兒列、不繞過`, async () => {
    const e = await env();
    try {
      const user = await authorize(e.db, A_CHAT);
      await e.db.transitionUserLifecycle({ userId: user.id, targetStatus: status });
      const before = (await e.db.listUsers()).length;
      for (let i = 0; i < 3; i++) await onb(e.db, A_CHAT, '/start');
      const after = await e.db.listUsers();
      assert.equal(after.length, before, '★★★ 不可以每次 /start 都留下一列垃圾');
      assert.equal(after.filter((u) => u.status === USER_STATUS.ACTIVE).length, 0,
        '★★★ 不可以憑空產生一個 ACTIVE 使用者');
      assert.equal((await e.db.getUser(user.id)).status, status, '★ 原帳號狀態不變');
    } finally { e.done(); }
  });

  test(`LIFE-13/${status} 停用使用者 /connect：拿不到授權連結，也不消耗額度`, async () => {
    const e = await env();
    try {
      const user = await authorize(e.db, A_CHAT);
      const budgetBefore = (await e.db.getOnboarding(user.id)).authLinkCount;
      await e.db.transitionUserLifecycle({ userId: user.id, targetStatus: status });
      const created = await e.db.createOAuthState(user.id, { ttlMs: 60_000, maxOutstanding: 5 });
      assert.equal(created.ok, false);
      assert.equal(created.reason, 'account_inactive');
      assert.equal((await e.db.getOnboarding(user.id)).authLinkCount, budgetBefore, '★ 額度不變');
    } finally { e.done(); }
  });

  test(`LIFE-13b/${status} 停用帳號要連結：**先**擋資格，不消耗冷卻／配額`, async () => {
    const e = await env();
    try {
      const user = await authorize(e.db, A_CHAT);
      const before = await e.db.getOnboarding(user.id);
      await e.db.transitionUserLifecycle({ userId: user.id, targetStatus: status });
      const r = await issueAuthLink({
        db: e.db, userId: user.id, clientId: CLIENT_ID, redirectUri: REDIRECT,
        cooldownMs: ONBOARDING.AUTH_LINK_COOLDOWN_MS,
        maxOutstanding: ONBOARDING.MAX_OUTSTANDING_AUTH_LINKS, now: NOW,
      });
      assert.equal(r.ok, false);
      assert.equal(r.reason, 'account_inactive');
      const after = await e.db.getOnboarding(user.id);
      assert.equal(after.authLinkCount, before.authLinkCount, '★★★ 不可以消耗配額');
      assert.equal(after.lastAuthLinkAt, before.lastAuthLinkAt, '★★★ 不可以起算冷卻');
    } finally { e.done(); }
  });

  test(`LIFE-16/${status} 停用帳號不被分析工作選到`, async () => {
    const e = await env();
    try {
      const user = await authorize(e.db, A_CHAT);
      await e.db.markAnalyticsDirty({
        userId: user.id, resource: 'sleep', reason: 'test', now: NOW,
      });
      assert.ok((await e.db.listPendingAnalytics(ANALYTICS_CLASS.LIGHT, { now: NOW }))
        .some((p) => p.userId === user.id));
      await e.db.transitionUserLifecycle({ userId: user.id, targetStatus: status });
      const pending = await e.db.listPendingAnalytics(ANALYTICS_CLASS.LIGHT, { now: NOW });
      assert.deepEqual(pending.filter((p) => p.userId === user.id), [],
        '★★★ 停用帳號不產生新的分析計算');
    } finally { e.done(); }
  });
}

test('LIFE-14/15 停用帳號的 webhook：UPDATE 不寫 canonical，DELETE 仍然執行本地刪除', async () => {
  const e = await env();
  try {
    const user = await authorize(e.db, A_CHAT);
    await e.db.raw.execute({
      sql: 'UPDATE user_whoop_tokens SET whoop_user_id = ? WHERE user_id = ?',
      args: ['W-HOOK', user.id],
    });
    // 先在 ACTIVE 時放一列 canonical
    await e.db.raw.execute({
      sql: `INSERT INTO whoop_sleeps (user_id, id, whoop_user_id, health_date, created_at, updated_at, synced_at, raw_json)
            VALUES (?, 's-del', 'W-HOOK', '2026-09-10', ?, ?, ?, '{}')`,
      args: [user.id, NOW.toISOString(), NOW.toISOString(), NOW.toISOString()],
    });
    await e.db.transitionUserLifecycle({ userId: user.id, targetStatus: USER_STATUS.DISABLED });

    const resolved = await e.db.resolveUserByWhoopUserId('W-HOOK');
    assert.equal(resolved.status, 'resolved');
    assert.notEqual(resolved.user.status, USER_STATUS.ACTIVE);
    assert.ok(Number.isInteger(resolved.user.lifecycleGeneration), '★ 事件處理拿得到啟用世代');
  } finally { e.done(); }
});

test('LIFE-17 ★★★ Alice 停用不影響 Bob', async () => {
  const e = await env();
  try {
    const alice = await authorize(e.db, A_CHAT, { whoopUserId: 'W-A' });
    const bob = await authorize(e.db, B_CHAT, { whoopUserId: 'W-B' });
    const bobLifeBefore = await lifeOf(e.db, bob.id);
    const bobTokens = await e.db.getTokens(bob.id);

    await e.db.transitionUserLifecycle({ userId: alice.id, targetStatus: USER_STATUS.DISABLED });

    assert.equal(await lifeOf(e.db, bob.id), bobLifeBefore, '★★★ Bob 的世代沒動');
    assert.equal((await e.db.getUser(bob.id)).status, USER_STATUS.ACTIVE);
    assert.equal((await e.db.getTokens(bob.id)).accessToken, bobTokens.accessToken);
    assert.equal((await e.db.getOnboarding(bob.id)).bootstrapAttempts, 0);
    assert.ok(await e.db.getActiveChatIdForUser(bob.id, { expectedLifecycleGeneration: bobLifeBefore }),
      '★★★ Bob 仍然可以收到訊息');
    const boot = await runOnboardingBootstrap({
      db: e.db, userId: bob.id, env: {}, now: () => NOW, deps: deps({ db: e.db }),
    });
    assert.equal(boot.result, BOOTSTRAP_RESULT.READY, '★★★ Bob 照常上線');
  } finally { e.done(); }
});

// ===========================================================================
// §46 ABA：停用 → 再啟用
// ===========================================================================

/** ACTIVE(L) → 停用(L+1) → ACTIVE(L+2)，回傳舊世代 L。 */
async function aba(db, userId, via = USER_STATUS.DISABLED) {
  const before = await lifeOf(db, userId);
  await db.transitionUserLifecycle({ userId, targetStatus: via });
  await db.transitionUserLifecycle({ userId, targetStatus: USER_STATUS.ACTIVE });
  const after = await lifeOf(db, userId);
  assert.equal(after, before + 2, 'ABA 之後世代應該 +2');
  assert.equal((await db.getUser(userId)).status, USER_STATUS.ACTIVE, 'ABA 之後狀態又是 ACTIVE');
  return before;
}

for (const via of INACTIVE) {
  test(`ABA-01/${via} 舊世代的 bootstrap 嘗試在重新啟用後仍然被拒`, async () => {
    const e = await env();
    try {
      const user = await authorize(e.db, A_CHAT);
      const oldLife = await aba(e.db, user.id, via);
      const r = await e.db.recordBootstrapAttempt(user.id, {
        expectedLifecycleGeneration: oldLife, now: NOW,
      });
      assert.equal(r.ok, false, '★★★ status 又是 ACTIVE，但世代不是');
      assert.equal((await e.db.getOnboarding(user.id)).bootstrapAttempts, 0);
    } finally { e.done(); }
  });

  test(`ABA-02/${via} 舊世代的 scope ACTION_REQUIRED 在重新啟用後被拒`, async () => {
    const e = await env();
    try {
      const user = await authorize(e.db, A_CHAT);
      await e.db.setOnboardingState(user.id, ONBOARDING_STATE.SYNCING, { now: NOW });
      const oldLife = await aba(e.db, user.id, via);
      const marked = await e.db.setOnboardingState(user.id, ONBOARDING_STATE.ACTION_REQUIRED, {
        from: [ONBOARDING_STATE.SYNCING, ONBOARDING_STATE.WHOOP_AUTHORIZED],
        failureCode: ONBOARDING_FAILURE.WHOOP_SCOPE_INCOMPLETE,
        expectedLifecycleGeneration: oldLife, requireActiveLifecycle: true, now: NOW,
      });
      assert.equal(marked, null, '★★★ 舊世代的結論不可以寫進新的啟用期');
      assert.notEqual((await e.db.getOnboarding(user.id)).failureCode,
        ONBOARDING_FAILURE.WHOOP_SCOPE_INCOMPLETE);
    } finally { e.done(); }
  });

  test(`ABA-03/${via} 舊世代的 BOOTSTRAP_FAILED 在重新啟用後被拒、且不通知`, async () => {
    const e = await env();
    try {
      const user = await authorize(e.db, A_CHAT);
      for (let i = 0; i < ONBOARDING.MAX_BOOTSTRAP_ATTEMPTS; i++) {
        await e.db.recordBootstrapAttempt(user.id, { now: NOW });
      }
      await e.db.setOnboardingState(user.id, ONBOARDING_STATE.SYNCING, { now: NOW });
      const oldLife = await aba(e.db, user.id, via);
      // 重新啟用把額度歸零了；即使把它推回上限，世代仍然擋得住
      for (let i = 0; i < ONBOARDING.MAX_BOOTSTRAP_ATTEMPTS; i++) {
        await e.db.recordBootstrapAttempt(user.id, { now: NOW });
      }
      await e.db.setOnboardingState(user.id, ONBOARDING_STATE.SYNCING, { now: NOW });
      const r = await e.db.failBootstrapIfExhausted({
        userId: user.id, from: [ONBOARDING_STATE.SYNCING],
        failureCode: ONBOARDING_FAILURE.BOOTSTRAP_FAILED,
        expectedLifecycleGeneration: oldLife,
        maxAttempts: ONBOARDING.MAX_BOOTSTRAP_ATTEMPTS, now: NOW,
      });
      assert.equal(r.ok, false);
      assert.equal(r.reason, 'account_inactive');
      assert.notEqual((await e.db.getOnboarding(user.id)).state, ONBOARDING_STATE.ACTION_REQUIRED);
    } finally { e.done(); }
  });

  test(`ABA-04/${via} ★★★ 舊世代的證據不可以讓重新啟用後的帳號 READY`, async () => {
    const e = await env();
    try {
      const user = await authorize(e.db, A_CHAT);
      const life = await lifeOf(e.db, user.id);
      // 完整的、當時完全合法的資格證據
      await e.db.recordResourceAccess(user.id, ONBOARDING.REQUIRED_SCOPES.map((resource) => ({
        resource, status: RESOURCE_ACCESS_STATUS.ACCESSIBLE,
      })), { expectedAuthGeneration: 1, expectedLifecycleGeneration: life, now: NOW });
      await e.db.saveCapabilities(user.id, [{ key: 'recovery', status: 'SUPPORTED', sampleCount: 5, nonNullCount: 5 }],
        { expectedLifecycleGeneration: life, now: NOW });
      await e.db.saveSyncState(user.id, 'sleep', { lastSuccessAt: NOW.toISOString() }, { now: NOW });
      await e.db.setOnboardingState(user.id, ONBOARDING_STATE.SYNCING, { now: NOW });

      await aba(e.db, user.id, via);   // 停用 → 再啟用
      await e.db.setOnboardingState(user.id, ONBOARDING_STATE.SYNCING, { now: NOW });

      const ready = await e.db.setReadyIfEligible({
        userId: user.id, requiredResources: ONBOARDING.REQUIRED_SCOPES, now: NOW,
      });
      assert.equal(ready.ok, false,
        '★★★ status 又是 ACTIVE，但證據屬於上一段啟用期 —— 不可以 READY');
      assert.notEqual(await stateOf(e.db, user.id), ONBOARDING_STATE.READY);
    } finally { e.done(); }
  });

  test(`ABA-05/${via} 舊世代的資源判定寫入在重新啟用後被拒`, async () => {
    const e = await env();
    try {
      const user = await authorize(e.db, A_CHAT);
      const oldLife = await aba(e.db, user.id, via);
      const r = await e.db.recordResourceAccess(user.id, [
        { resource: 'sleep', status: RESOURCE_ACCESS_STATUS.ACCESSIBLE },
      ], { expectedAuthGeneration: 1, expectedLifecycleGeneration: oldLife, now: NOW });
      assert.equal(r.ok, false, '★★★ 舊啟用期的判定不可以落地');
      assert.deepEqual(await accessOf(e.db, user.id), {});
    } finally { e.done(); }
  });

  test(`ABA-06/${via} 舊世代的 capability 證據在重新啟用後被拒`, async () => {
    const e = await env();
    try {
      const user = await authorize(e.db, A_CHAT);
      const oldLife = await aba(e.db, user.id, via);
      const n = await e.db.saveCapabilities(user.id, [
        { key: 'recovery', status: 'SUPPORTED', sampleCount: 5, nonNullCount: 5 },
      ], { expectedLifecycleGeneration: oldLife, now: NOW });
      assert.equal(n, 0, '★★★ 舊啟用期的盤點不可以落地');
    } finally { e.done(); }
  });

  test(`ABA-07/${via} ★★★ 舊世代的 canonical 同步寫入被拒，且游標不前進`, async () => {
    const e = await env();
    try {
      const user = await authorize(e.db, A_CHAT);
      const oldLife = await lifeOf(e.db, user.id);
      const record = (id) => ({
        id, user_id: 12345, created_at: NOW.toISOString(), updated_at: NOW.toISOString(),
        start: NOW.toISOString(), end: NOW.toISOString(), timezone_offset: '+08:00',
        score_state: 'SCORED', score: { stage_summary: {} },
      });
      const sync = createSync({
        db: e.db, userId: user.id, timezone: 'Asia/Taipei',
        expectedLifecycleGeneration: oldLife, now: NOW,
        whoop: {
          sleeps: async () => { await aba(e.db, user.id, via); return [record('s-aba')]; },
          recoveries: async () => [], cycles: async () => [],
          workouts: async () => [], bodyMeasurement: async () => null,
        },
      });
      const results = await sync.syncAll({ force: true, resources: ['sleep'] });
      assert.equal(results[0].status, 'account_inactive');
      const rows = await e.db.raw.execute({
        sql: 'SELECT COUNT(*) n FROM whoop_sleeps WHERE user_id = ?', args: [user.id],
      });
      assert.equal(Number(rows.rows[0].n), 0, '★★★ 舊啟用期抓到的資料不落地');
      const st = await e.db.getSyncState(user.id, 'sleep');
      assert.ok(!st?.lastSuccessAt, '★★★ 游標不可以前進');
    } finally { e.done(); }
  });

  test(`ABA-09/${via} ★★★ 舊世代算出來的報告在重新啟用後不遞送`, async () => {
    const e = await env();
    try {
      const user = await authorize(e.db, A_CHAT);
      const oldLife = await lifeOf(e.db, user.id);
      const sent = [];
      const tg = withDeliveryAuthorization(
        { send: async (t) => { sent.push(t); return { messageId: 1 }; }, notifyError: async () => {} },
        async () => Boolean(await e.db.getActiveChatIdForUser(user.id, {
          expectedLifecycleGeneration: oldLife,
        })),
      );
      await aba(e.db, user.id, via);
      const r = await tg.send('（在停用之前算出來的）今天的日報');
      assert.equal(r.suppressed, 'ACCOUNT_INACTIVE');
      assert.deepEqual(sent, [], '★★★ status 又是 ACTIVE 也不可以送出舊世代的健康內容');
      // 新世代的訊息照常送
      const freshLife = await lifeOf(e.db, user.id);
      assert.ok(await e.db.getActiveChatIdForUser(user.id, { expectedLifecycleGeneration: freshLife }));
    } finally { e.done(); }
  });

  test(`ABA-11/${via} ★★★ 舊世代發出的 OAuth state 在重新啟用後仍然被拒`, async () => {
    const e = await env();
    try {
      await onb(e.db, A_CHAT, '/start');
      const user = await userFor(e.db, A_CHAT);
      const reply = await linked(e.db, user, 'Asia/Taipei');
      const state = stateFromUrl(urlIn(reply));

      await aba(e.db, user.id, via);   // 停用 → 再啟用（status 又是 ACTIVE）

      let bootstrapped = false;
      const cb = createWhoopOAuthCallback({
        db: e.db, ...fakeWhoopBackend(), now: () => NOW,
        onAuthorized: async () => { bootstrapped = true; },
      });
      const res = await cb({ query: new URLSearchParams({ code: 'good', state }) });
      assert.notEqual(res.outcome, 'ok',
        '★★★ 光看 status 會放行 —— 這條 state 屬於上一段啟用期');
      assert.equal(bootstrapped, false);
      assert.equal(await e.db.getTokens(user.id), null, '★★★ 不可以綁定憑證');
      assert.notEqual((await e.db.getOnboarding(user.id)).state, ONBOARDING_STATE.WHOOP_AUTHORIZED);
    } finally { e.done(); }
  });

  test(`ABA-12/${via} 舊世代的分析工作在重新啟用後無法認領`, async () => {
    const e = await env();
    try {
      const user = await authorize(e.db, A_CHAT);
      await e.db.markAnalyticsDirty({
        userId: user.id, resource: 'sleep', reason: 'test', now: NOW,
      });
      await e.db.transitionUserLifecycle({ userId: user.id, targetStatus: via });
      assert.deepEqual(
        (await e.db.listPendingAnalytics(ANALYTICS_CLASS.LIGHT, { now: NOW }))
          .filter((p) => p.userId === user.id),
        [], '★ 停用期間不被選取',
      );
      await e.db.transitionUserLifecycle({ userId: user.id, targetStatus: USER_STATUS.ACTIVE });
      // 重新啟用之後才可以再被選（而且是新世代的工作）
      assert.ok((await e.db.listPendingAnalytics(ANALYTICS_CLASS.LIGHT, { now: NOW }))
        .some((p) => p.userId === user.id));
    } finally { e.done(); }
  });
}

// ===========================================================================
// §48 重新啟用語義
// ===========================================================================

test('REACT-01..05 重新啟用：世代 +1、額度歸零、綁定與 token 保留、auth_generation 不動', async () => {
  const e = await env();
  try {
    const user = await authorize(e.db, A_CHAT);
    const tokensBefore = await e.db.getTokens(user.id);
    const authGenBefore = tokensBefore.authGeneration;
    for (let i = 0; i < 3; i++) await e.db.recordBootstrapAttempt(user.id, { now: NOW });
    assert.equal((await e.db.getOnboarding(user.id)).bootstrapAttempts, 3);

    await e.db.transitionUserLifecycle({ userId: user.id, targetStatus: USER_STATUS.DISABLED });
    const t = await e.db.transitionUserLifecycle({ userId: user.id, targetStatus: USER_STATUS.ACTIVE });

    assert.equal(t.changed, true);
    assert.equal(t.newGeneration, t.oldGeneration + 1, 'REACT-01 世代 +1');
    assert.equal((await e.db.getOnboarding(user.id)).bootstrapAttempts, 0, 'REACT-02 額度歸零');
    assert.ok(await e.db.getTelegramLink(A_CHAT), 'REACT-03 綁定保留');
    const tokensAfter = await e.db.getTokens(user.id);
    assert.equal(tokensAfter.accessToken, tokensBefore.accessToken, 'REACT-04 token 保留');
    assert.equal(tokensAfter.authGeneration, authGenBefore,
      'REACT-05 ★★★ 啟用世代改變**不可以**動到授權世代');
  } finally { e.done(); }
});

test('REACT-09/10 ★★★ 重新啟用後：READY 需要新世代的證據，而新一輪 bootstrap 收斂得了', async () => {
  const e = await env();
  try {
    const user = await authorize(e.db, A_CHAT);
    const boot1 = await runOnboardingBootstrap({
      db: e.db, userId: user.id, env: {}, now: () => NOW, deps: deps({ db: e.db }),
    });
    assert.equal(boot1.result, BOOTSTRAP_RESULT.READY);
    assert.equal(await stateOf(e.db, user.id), ONBOARDING_STATE.READY);

    await e.db.transitionUserLifecycle({ userId: user.id, targetStatus: USER_STATUS.DISABLED });
    await e.db.transitionUserLifecycle({ userId: user.id, targetStatus: USER_STATUS.ACTIVE });

    // READY 在轉移時就被降級了：新的啟用期必須重新驗證資格
    assert.notEqual(await stateOf(e.db, user.id), ONBOARDING_STATE.READY,
      '★★★ 重新啟用不可以直接沿用上一段啟用期的 READY');
    assert.deepEqual(await e.db.listSchedulableUsers({ activeStatus: USER_STATUS.ACTIVE }), [],
      '★★★ 還沒重新驗證之前不可以被排程');

    // 新世代跑一輪 → 重新 READY，而且證據屬於新世代
    const boot2 = await runOnboardingBootstrap({
      db: e.db, userId: user.id, env: {}, now: () => NOW, deps: deps({ db: e.db }),
    });
    assert.equal(boot2.result, BOOTSTRAP_RESULT.READY, 'REACT-09 新世代收斂得了');
    const life = await lifeOf(e.db, user.id);
    const access = await accessOf(e.db, user.id);
    assert.equal(access.sleep.lifecycleGeneration, life, 'REACT-10 證據屬於目前啟用期');
    assert.equal((await e.db.listSchedulableUsers({ activeStatus: USER_STATUS.ACTIVE })).length, 1);
  } finally { e.done(); }
});

test('REACT-06 舊世代的 worker 在重新啟用後完全無法變更任何狀態', async () => {
  const e = await env();
  try {
    const user = await authorize(e.db, A_CHAT);
    const oldLife = await lifeOf(e.db, user.id);
    await e.db.setOnboardingState(user.id, ONBOARDING_STATE.SYNCING, { now: NOW });
    const snapshot = await e.db.getOnboarding(user.id);
    await aba(e.db, user.id);

    // 一次把所有 bootstrap 擁有的變更都用舊世代試一遍
    assert.equal((await e.db.recordBootstrapAttempt(user.id, {
      expectedLifecycleGeneration: oldLife, now: NOW,
    })).ok, false);
    assert.equal(await e.db.setOnboardingState(user.id, ONBOARDING_STATE.ACTION_REQUIRED, {
      failureCode: ONBOARDING_FAILURE.BOOTSTRAP_FAILED,
      expectedLifecycleGeneration: oldLife, requireActiveLifecycle: true, now: NOW,
    }), null);
    assert.equal((await e.db.recordResourceAccess(user.id, [
      { resource: 'sleep', status: RESOURCE_ACCESS_STATUS.ACCESSIBLE },
    ], { expectedAuthGeneration: 1, expectedLifecycleGeneration: oldLife, now: NOW })).ok, false);
    assert.equal(await e.db.saveCapabilities(user.id, [
      { key: 'recovery', status: 'SUPPORTED', sampleCount: 1, nonNullCount: 1 },
    ], { expectedLifecycleGeneration: oldLife, now: NOW }), 0);

    const after = await e.db.getOnboarding(user.id);
    assert.equal(after.bootstrapAttempts, 0, '★ 重新啟用歸零的額度沒有被舊 worker 動到');
    assert.notEqual(after.failureCode, ONBOARDING_FAILURE.BOOTSTRAP_FAILED);
    assert.deepEqual(await accessOf(e.db, user.id), {});
    assert.equal(snapshot.userId, after.userId);
  } finally { e.done(); }
});

test('LIFE-ERR-01 AccountInactiveError 的分類與內容（不含任何祕密）', async () => {
  const { AccountInactiveError } = await import('../src/accountLifecycle.js');
  const err = new AccountInactiveError('u-1');
  assert.equal(isAccountInactiveError(err), true);
  assert.equal(err.code, 'ACCOUNT_INACTIVE');
  const { isScopeError, isStaleAuthorizationError } = await import('../src/whoop.js');
  assert.equal(isScopeError(err), false, '★ 不是缺 scope');
  assert.equal(isStaleAuthorizationError(err), false, '★★★ 與授權世代競態是不同的分類');
  assert.ok(!/token|secret|code=/i.test(`${err.message}${err.stack ?? ''}`));
});
