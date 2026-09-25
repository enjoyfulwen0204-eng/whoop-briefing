/**
 * V1.2 Phase 3.5 — 帳號啟用權責 R3：執行期傳播與狀態機封閉。
 *
 * R2 建立了「正式路徑不可以有選用的啟用權責」這條規則，但獨立稽核找到
 * 十一個具體的執行期缺口：一般的執行期 client 沒帶脈絡、OAuth 寫入成功
 * 之後的續作沒驗、孤兒快速路徑信任呼叫端、Q&A 最終送出只看 ACTIVE、
 * 報告狀態機把「被擋」當成「已送」、遷移只查 sleep 不查 recovery、主動
 * 訊息被擋還開待答、分析 API 仍然接受 null、Guardian 冷卻被沒送出的訊息
 * 吃掉、對帳 CLI 直接 ReferenceError、同步的下一個 provider 階段照樣開始。
 *
 * R3 的原則：**進入時捕捉一次 → 強制傳播 → 每一個新的使用者健康權責邊界
 * 重新驗證 → 依實際送達／落地結果結案。**
 *
 * 全部用真實 libSQL、真實 orchestration。競態用 hook 造，不用 sleep。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { createDb } from './localDb.js';
import { handleUnlinkedMessage, handleOnboardingMessage } from '../src/onboarding.js';
import { createWhoopOAuthCallback } from '../src/whoopOAuthCallback.js';
import { createWhoopClient } from '../src/whoop.js';
import { createSync } from '../src/sync.js';
import { probeCapabilities } from '../src/capabilities.js';
import { createSendReply } from '../src/bot/index.js';
import { deliverReport, DELIVERY_RESULT } from '../src/reportDelivery.js';
import { checkAndAct } from '../src/proactiveAgent.js';
import { runGuardian } from '../src/guardian.js';
import { runForUser } from '../src/index.js';
import {
  LIFECYCLE_UNFENCED, LifecycleContextError, withDeliveryAuthorization, isAccountInactiveError,
} from '../src/accountLifecycle.js';
import {
  ONBOARDING_STATE, USER_STATUS, ANALYTICS_CLASS, REPORT_DELIVERY_STATE, RESOURCE_ACCESS_STATUS,
  V18_READY_REQUIRED_RESOURCES,
} from '../src/schema.js';
import { runDaily } from '../src/daily.js';
import { runWeekly } from '../src/weekly.js';
import { staticDataSource } from '../src/dataSource.js';
import { makeDataset } from './fixtures.js';
import { fakeCoach } from './fakes.js';
import { ONBOARDING } from '../src/config.js';

const NOW = new Date('2026-09-15T12:00:00.000Z');
const HOUR = 3_600_000;
const CLIENT_ID = 'test-client';
const REDIRECT = 'https://example.test/whoop/oauth/callback';
const A_CHAT = '711111';
const B_CHAT = '722222';
const INACTIVE = [USER_STATUS.PAUSED, USER_STATUS.DISABLED];
const ROOT = path.resolve(new URL('..', import.meta.url).pathname);

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whoop-r3-'));
  return { dir, url: `file:${path.join(dir, 't.db')}`, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
async function env() {
  const t = tempDir();
  const db = createDb({ url: t.url });
  await db.migrate();
  return { db, url: t.url, dir: t.dir, done: () => { try { db.close(); } catch { /* ignore */ } t.cleanup(); } };
}

function runCli(e, script, args, transitionUser = '') {
  const requestLog = path.join(e.dir, 'requests.log');
  fs.writeFileSync(requestLog, '');
  const child = spawnSync(process.execPath, [
    '--import', path.join(ROOT, 'test/r3-cli-network.fixture.mjs'),
    path.join(ROOT, `scripts/${script}.js`), ...args,
  ], {
    cwd: e.dir, encoding: 'utf8', timeout: 15000,
    env: {
      PATH: process.env.PATH, TURSO_DATABASE_URL: e.url, TURSO_AUTH_TOKEN: 'test',
      WHOOP_CLIENT_ID: 'test', WHOOP_CLIENT_SECRET: 'test',
      TELEGRAM_BOT_TOKEN: 'test', TELEGRAM_CHAT_ID: '1',
      R3_REQUEST_LOG: requestLog, R3_TRANSITION_USER: transitionUser,
    },
  });
  assert.ifError(child.error);
  return { ...child, requests: fs.readFileSync(requestLog, 'utf8') };
}

const privateMessage = (chatId, text) => ({
  message_id: 1, text, chat: { id: Number(chatId), type: 'private' },
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
  assert.equal((await cb({ query: new URLSearchParams({ code: 'good', state: stateFromUrl(urlIn(reply)) }) })).outcome, 'ok');
  return await db.getUser(user.id);
}
async function aba(db, userId, via = USER_STATUS.DISABLED) {
  const before = await lifeOf(db, userId);
  await db.transitionUserLifecycle({ userId, targetStatus: via });
  await db.transitionUserLifecycle({ userId, targetStatus: USER_STATUS.ACTIVE });
  assert.equal(await lifeOf(db, userId), before + 2);
  return before;
}
/** 讓 token 在真實時鐘下快過期 → 第一次 WHOOP 呼叫就會 refresh。 */
async function expiringToken(db, userId) {
  await db.saveTokens(userId, {
    accessToken: 'about-to-expire', refreshToken: 'rt-old',
    expiresAt: new Date(Date.now() + 1_000), scope: 'offline read:sleep read:recovery', whoopUserId: 'W1',
  });
  return db.getTokens(userId);
}
/** 假 WHOOP HTTP：token endpoint 輪替憑證；資料端點回空集合；可在 refresh 前觸發 hook。 */
function httpBackend({ onBeforeRefresh = null } = {}) {
  const seen = []; let refreshes = 0;
  const reply = (obj) => { const b = JSON.stringify(obj); return { ok: true, status: 200, json: async () => JSON.parse(b), text: async () => b, headers: new Map() }; };
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    if (u.pathname.endsWith('/oauth/oauth2/token')) {
      if (onBeforeRefresh) await onBeforeRefresh();
      refreshes += 1;
      return reply({ access_token: `refreshed-${refreshes}`, refresh_token: `rt-${refreshes}`, expires_in: 3600, scope: 'offline' });
    }
    seen.push({ path: u.pathname, bearer: String(init.headers?.Authorization ?? '').replace('Bearer ', '') });
    return u.pathname.includes('/measurement/body')
      ? reply({ height_meter: 1.75, weight_kilogram: 70, max_heart_rate: 190 })
      : reply({ records: [], next_token: null });
  };
  return { fetchImpl, seen, refreshes: () => refreshes };
}

// ===========================================================================
// R2-FG-01-RUNTIME-REFRESH：一般執行期 client 的例行 refresh
// ===========================================================================

test('R3-00 ★★★ 一般執行期 client 少了啟用脈絡 → 拋錯（不再安靜地不設防）', async () => {
  const e = await env();
  try {
    const u = await authorize(e.db, A_CHAT);
    assert.throws(
      () => createWhoopClient({ db: e.db, userId: u.id, clientId: 'c', clientSecret: 's' }),
      LifecycleContextError,
    );
  } finally { e.done(); }
});

for (const via of INACTIVE) {
  test(`R3-01/${via} ★★★ runForUser 的例行 refresh：refresh 期間被停用 → 輪替憑證不落地`, async () => {
    const e = await env();
    try {
      const u = await authorize(e.db, A_CHAT);
      await e.db.setOnboardingState(u.id, ONBOARDING_STATE.READY, { ready: true, timezoneConfirmed: true, now: NOW });
      const before = await expiringToken(e.db, u.id);
      const user = (await e.db.listSchedulableUsers({ activeStatus: USER_STATUS.ACTIVE }))[0];
      assert.ok(user, '前提：使用者可被排程');
      const backendA = httpBackend({
        onBeforeRefresh: async () => { await e.db.transitionUserLifecycle({ userId: u.id, targetStatus: via }); },
      });
      const out = await runForUser({
        db: e.db, env: { whoopClientId: 'c', whoopClientSecret: 's', dryRun: true }, user, now: NOW,
        deps: {
          makeWhoop: (opts) => createWhoopClient({ ...opts, fetchImpl: backendA.fetchImpl, sleepImpl: async () => {} }),
          makeTelegram: () => ({ send: async () => ({ messageId: 1 }), notifyError: async () => {} }),
          daily: async () => ({ status: 'not_run' }), weekly: async () => ({ status: 'not_run' }),
          proactive: async () => ({}), reap: async () => 0, predictionCycle: async () => ({}), healthspan: async () => ({}),
        },
      });
      const after = await e.db.getTokens(u.id);
      assert.equal(after.accessToken, before.accessToken, '★★★ 停用期間輪替的憑證不可以寫回去');
      assert.ok(out, '流程本身不拋');
    } finally { e.done(); }
  });

  test(`R3-02/${via} ★★★ runForUser 的例行 refresh：refresh 期間 ABA → 仍然不落地`, async () => {
    const e = await env();
    try {
      const u = await authorize(e.db, A_CHAT);
      await e.db.setOnboardingState(u.id, ONBOARDING_STATE.READY, { ready: true, timezoneConfirmed: true, now: NOW });
      const before = await expiringToken(e.db, u.id);
      const user = (await e.db.listSchedulableUsers({ activeStatus: USER_STATUS.ACTIVE }))[0];
      const backendA = httpBackend({ onBeforeRefresh: async () => { await aba(e.db, u.id, via); } });
      await runForUser({
        db: e.db, env: { whoopClientId: 'c', whoopClientSecret: 's', dryRun: true }, user, now: NOW,
        deps: {
          makeWhoop: (opts) => createWhoopClient({ ...opts, fetchImpl: backendA.fetchImpl, sleepImpl: async () => {} }),
          makeTelegram: () => ({ send: async () => ({ messageId: 1 }), notifyError: async () => {} }),
          daily: async () => ({ status: 'not_run' }), weekly: async () => ({ status: 'not_run' }),
          proactive: async () => ({}), reap: async () => 0, predictionCycle: async () => ({}), healthspan: async () => ({}),
        },
      });
      const after = await e.db.getTokens(u.id);
      assert.equal(after.accessToken, before.accessToken, '★★★ status 又是 ACTIVE，但世代不是 —— 憑證不可以落地');
    } finally { e.done(); }
  });
}

for (const script of ['sync', 'probe-fields']) {
  test(`R3-03/04 ${script} CLI propagates lifecycle through refresh`, async () => {
    const e = await env();
    try {
      const u = await authorize(e.db, A_CHAT);
      const old = await expiringToken(e.db, u.id);
      const child = runCli(e, script, [`--user=${u.id}`], u.id);
      assert.equal(child.requests, 'refresh\n');
      assert.equal((await e.db.getTokens(u.id)).accessToken, old.accessToken);
      assert.equal(await lifeOf(e.db, u.id), 3);
      assert.doesNotMatch(child.stdout + child.stderr, /ReferenceError|LIFECYCLE_CONTEXT_REQUIRED/);
    } finally { e.done(); }
  });
}

// ===========================================================================
// R2-FG-02-POSTSAVE-OAUTH
// ===========================================================================

for (const via of INACTIVE) {
  test(`R3-05/${via} ★★★ token 寫入成功後 ABA → callback 續作被擋（不轉狀態、不歸零、不通知、不 bootstrap）`, async () => {
    const e = await env();
    try {
      await onb(e.db, A_CHAT, '/start');
      const user = await userFor(e.db, A_CHAT);
      const reply = await linked(e.db, user, 'Asia/Taipei');
      const state = stateFromUrl(urlIn(reply));
      await e.db.recordBootstrapAttempt(user.id, { now: NOW });
      let hooked = false;
      // 在 verifyIdentity（token 寫入的前一步）之後、續作之前換啟用期：
      // 用 saveTokens 之後才觸發的方式 —— 這裡用 verifyIdentity 回傳後
      // 再包一層，讓 token 真的先落地。
      const realDb = e.db;
      const dbProxy = new Proxy(realDb, {
        get(t, k) {
          if (k === 'saveTokens') {
            return async (...args) => {
              const r = await t.saveTokens(...args);
              // ★ token 已經 commit 了；現在才換啟用期
              await aba(realDb, user.id, via);
              return r;
            };
          }
          const v = t[k]; return typeof v === 'function' ? v.bind(t) : v;
        },
      });
      const cb = createWhoopOAuthCallback({
        db: dbProxy, ...backend(), now: () => NOW, onAuthorized: async () => { hooked = true; },
      });
      const out = await cb({ query: new URLSearchParams({ code: 'good', state }) });
      assert.notEqual(out.outcome, 'ok', '★★★ 寫入成功 ≠ 續作被授權');
      assert.equal(out.outcome, 'account_inactive');
      assert.equal(hooked, false, '★★★ 不可以啟動 bootstrap / 通知');
      const o = await e.db.getOnboarding(user.id);
      assert.notEqual(o.state, ONBOARDING_STATE.WHOOP_AUTHORIZED, '★★★ 不可以轉成 WHOOP_AUTHORIZED');
      assert.equal(o.bootstrapAttempts, 0, '★ 額度歸零是轉移做的，不是 callback 做的');
      // §8：token 列可以留著（commit 當下合法），新啟用期會重新驗證
      assert.ok(await e.db.getTokens(user.id), 'token 在 commit 當下是合法的，可以留著');
    } finally { e.done(); }
  });
}

// ===========================================================================
// R2-ORPHAN-01
// ===========================================================================

test('R3-06 orphanCleanupOnly rejects a meaningful READY bound tokenized account', async () => {
  const e = await env();
  try {
    const u = await authorize(e.db, A_CHAT);
    await e.db.setOnboardingState(u.id, ONBOARDING_STATE.READY, { ready: true, now: NOW });
    for (let i = 0; i < 3; i++) await e.db.recordBootstrapAttempt(u.id, { now: NOW });
    const r = await e.db.transitionUserLifecycle({
      userId: u.id, targetStatus: USER_STATUS.DISABLED, orphanCleanupOnly: true,
    });
    assert.equal(r.changed, false);
    assert.equal(r.reason, 'not_claim_race_debris');
    const o = await e.db.getOnboarding(u.id);
    assert.equal(o.bootstrapAttempts, 3);
    assert.equal(o.state, ONBOARDING_STATE.READY);
    assert.equal(await lifeOf(e.db, u.id), 1);
  } finally { e.done(); }
});

test('R3-07 真正的認領輸家孤兒列 → 快速路徑成功，世代仍然推進', async () => {
  const e = await env();
  try {
    const orphan = await e.db.createUser({ displayName: 'orphan', timezone: 'UTC', now: NOW });
    const r = await e.db.transitionUserLifecycle({
      userId: orphan.id, targetStatus: USER_STATUS.DISABLED, orphanCleanupOnly: true,
    });
    assert.equal(r.changed, true);
    assert.equal(r.reason, 'orphan');
    const after = await e.db.getUser(orphan.id);
    assert.equal(after.status, USER_STATUS.DISABLED);
    assert.equal(after.lifecycleGeneration, 2, '★ 快速路徑也推進世代');
  } finally { e.done(); }
});

// ===========================================================================
// R2-QA-DELIVERY-01：最終送出邊界
// ===========================================================================

for (const via of INACTIVE) {
  test(`R3-08/${via} ★★★ Q&A 最終送出：送出前一刻 ABA → 不送、不留送達收據`, async () => {
    const e = await env();
    try {
      const u = await authorize(e.db, A_CHAT);
      const life = await lifeOf(e.db, u.id);
      const sent = [];
      const sendReply = createSendReply({ db: e.db, api: { sendMessage: async (c, t) => { sent.push(t); return { message_id: 9 }; } } });
      // 進來時捕捉的世代 = life；送出前一刻 ABA（status 又是 ACTIVE）
      await aba(e.db, u.id, via);
      const r = await sendReply({ chatId: A_CHAT, reply: '你的恢復分數…', userId: u.id, expectedLifecycleGeneration: life });
      assert.equal(r.sent, false, '★★★ ACTIVE-only 的最終解析會放行 —— 只有世代分得出來');
      assert.equal(r.reason, 'lifecycle_changed');
      assert.deepEqual(sent, [], '★★★ Telegram 一個字都沒送');
      // 新世代的回覆照常
      const fresh = await sendReply({ chatId: A_CHAT, reply: '新世代', userId: u.id, expectedLifecycleGeneration: await lifeOf(e.db, u.id) });
      assert.equal(fresh.sent, true);
      assert.deepEqual(sent, ['新世代']);
    } finally { e.done(); }
  });
}

// ===========================================================================
// R2-REPORT-01：認領權責、抑制狀態、DELIVERY_STARTED 復原
// ===========================================================================

test('R3-09 ★★★ 舊世代的 worker 在 ABA 之後不可以建立新的報告認領', async () => {
  const e = await env();
  try {
    const u = await authorize(e.db, A_CHAT);
    const oldLife = await aba(e.db, u.id);
    const stale = await e.db.claimReport({
      userId: u.id, reportType: 'daily', localDateKey: '2026-09-15', ttlMs: 600_000,
      expectedLifecycleGeneration: oldLife, now: NOW,
    });
    assert.equal(stale.granted, false, '★★★ 認領時就要證明世代');
    const fresh = await e.db.claimReport({
      userId: u.id, reportType: 'daily', localDateKey: '2026-09-15', ttlMs: 600_000,
      expectedLifecycleGeneration: await lifeOf(e.db, u.id), now: NOW,
    });
    assert.equal(fresh.granted, true, '★ 新世代照常認領');
  } finally { e.done(); }
});

test('R3-10 ★★★ 舊世代卡在 DELIVERY_STARTED → ABA → 沒有真的送出 → 新世代可以認領並送出', async () => {
  const e = await env();
  try {
    const u = await authorize(e.db, A_CHAT);
    const oldLife = await lifeOf(e.db, u.id);
    const claimKey = { userId: u.id, reportType: 'daily', localDateKey: '2026-09-15' };
    const c1 = await e.db.claimReport({ ...claimKey, ttlMs: 600_000, expectedLifecycleGeneration: oldLife, now: NOW });
    assert.equal(c1.granted, true);
    // 舊 worker 跨進 DELIVERY_STARTED 之後當掉（沒有送出）
    assert.equal(await e.db.authorizeReportDelivery({ ...claimKey, owner: c1.owner, expectedLifecycleGeneration: oldLife, now: NOW }), true);
    const stuck = (await e.db.raw.execute({ sql: 'SELECT delivery_state FROM report_claims WHERE user_id = ?', args: [u.id] })).rows[0];
    assert.equal(String(stuck.delivery_state), REPORT_DELIVERY_STATE.DELIVERY_STARTED);

    await aba(e.db, u.id);   // 轉移清掉未送出的舊認領
    const newLife = await lifeOf(e.db, u.id);
    const c2 = await e.db.claimReport({ ...claimKey, ttlMs: 600_000, expectedLifecycleGeneration: newLife, now: NOW });
    assert.equal(c2.granted, true, '★★★ 舊的 DELIVERY_STARTED 不可以永久擋住新世代');
    assert.notEqual(c2.alreadySent, true);
    const sent = [];
    const tg = withDeliveryAuthorization(
      { send: async (t) => { sent.push(t); return { messageId: 5 }; }, notifyError: async () => {} },
      async () => Boolean(await e.db.getActiveChatIdForUser(u.id, { expectedLifecycleGeneration: newLife })),
    );
    const d = await deliverReport({ db: e.db, claimKey, claim: c2, telegram: tg, text: '晨報', now: () => NOW });
    assert.equal(d.result, DELIVERY_RESULT.DELIVERED, '★★★ 新世代真的送得出去（晨報可用性）');
    assert.deepEqual(sent, ['晨報']);
  } finally { e.done(); }
});

test('R3-10b 舊世代拿著舊認領要跨進 DELIVERY_STARTED → 被 authorizeReportDelivery 擋下', async () => {
  const e = await env();
  try {
    const u = await authorize(e.db, A_CHAT);
    const oldLife = await lifeOf(e.db, u.id);
    const claimKey = { userId: u.id, reportType: 'daily', localDateKey: '2026-09-15' };
    const c1 = await e.db.claimReport({ ...claimKey, ttlMs: 600_000, expectedLifecycleGeneration: oldLife, now: NOW });
    // 直接把帳號換到新世代但**不**讓轉移清掉認領（模擬轉移與授權之間的競態）
    await e.db.raw.execute({ sql: 'UPDATE users SET lifecycle_generation = lifecycle_generation + 2 WHERE id = ?', args: [u.id] });
    assert.equal(
      await e.db.authorizeReportDelivery({ ...claimKey, owner: c1.owner, expectedLifecycleGeneration: oldLife, now: NOW }),
      false, '★★★ 認領世代 ≠ 目前世代 → 不授權，連 DELIVERY_STARTED 都進不去',
    );
  } finally { e.done(); }
});

for (const kind of ['daily', 'weekly']) {
  test(`R3-11/12 ${kind} orchestration suppresses stale delivery and fresh lifecycle delivers`, async () => {
    const e = await env();
    try {
      const u = await authorize(e.db, A_CHAT);
      const now = new Date('2026-09-14T04:00:00Z');
      const ds = makeDataset({ days: 45, now });
      const run = kind === 'daily' ? runDaily : runWeekly;
      let sends = 0;
      const transport = { send: async () => ({ messageId: ++sends }), notifyError: async () => {} };
      const ctx = { db: e.db, userId: u.id, source: staticDataSource(ds), coach: fakeCoach(), timezone: u.timezone, now };
      const tg = withDeliveryAuthorization(transport, async () => {
        await aba(e.db, u.id);
        return false;
      });
      const stale = await run({ ...ctx, telegram: tg, expectedLifecycleGeneration: 1 });
      assert.equal(stale.status, 'suppressed_stale_lifecycle');
      assert.equal(sends, 0);
      assert.equal(Number((await e.db.raw.execute("SELECT COUNT(*) n FROM report_runs WHERE status = 'SENT'")).rows[0].n), 0);
      assert.equal(Number((await e.db.raw.execute('SELECT COUNT(*) n FROM report_claims WHERE telegram_sent_at IS NOT NULL')).rows[0].n), 0);
      const fresh = await run({ ...ctx, telegram: transport, expectedLifecycleGeneration: 3 });
      assert.equal(fresh.status, 'sent');
      assert.equal(sends, 1);
    } finally { e.done(); }
  });
}

// ===========================================================================
// R2-GUARDIAN-01：冷卻不可以被沒送出的訊息吃掉
// ===========================================================================

test('R3-14 ★★★ Guardian：舊世代的 finding 被擋 → 冷卻歸還 → 新世代的警告仍然可以送', async () => {
  const e = await env();
  try {
    const u = await authorize(e.db, A_CHAT);
    const oldLife = await lifeOf(e.db, u.id);
    // 造一個「同步停擺」事實：很久沒成功同步
    await e.db.saveSyncState(u.id, 'sleep', { lastSuccessAt: new Date(NOW.getTime() - 72 * HOUR).toISOString() }, { now: NOW });
    const sent = [];
    const makeTelegram = ({ chatId }) => ({ send: async (t) => { sent.push({ chatId, t }); return { messageId: 1 }; }, notifyError: async () => {} });

    // 舊世代跑 Guardian：finding 在 L1 產生。資格預檢**通過**、冷卻**已認領**，
    // 然後才在送出前 ABA —— 這是最窄的窗口，只有「送不出去就歸還冷卻」擋得住。
    let calls = 0;
    const firstRun = runGuardian({
      db: new Proxy(e.db, {
        get(t, k) {
          if (k === 'getActiveChatIdForUser') {
            return async (uid, opts) => {
              calls += 1;
              // 第 1 次：資格預檢（通過）。第 2 次：deliver 內 → 此刻換啟用期。
              if (calls === 2) await aba(e.db, u.id).catch(() => {});
              return t.getActiveChatIdForUser(uid, opts);
            };
          }
          const v = t[k]; return typeof v === 'function' ? v.bind(t) : v;
        },
      }),
      makeTelegram, now: NOW,
    });
    const r1 = await firstRun;
    assert.equal(r1.notified, 0, '★ 舊世代的警告沒送出');
    assert.deepEqual(sent, []);
    assert.ok(await lifeOf(e.db, u.id) >= oldLife + 2);

    // 新世代立刻再跑：冷卻**不可以**還被舊世代吃著
    const r2 = await runGuardian({ db: e.db, makeTelegram, now: new Date(NOW.getTime() + 60_000) });
    assert.equal(r2.notified, 1, '★★★ 新世代的 WHOOP_SYNC_STALE 警告必須送得出去');
    assert.equal(sent.length, 1);
  } finally { e.done(); }
});

// ===========================================================================
// R2-ANALYTICS-01：分析 API 必填啟用脈絡
// ===========================================================================

test('R3-15 ★★★ 分析 API 少了啟用脈絡 → 拋錯（claim / output / settle）', async () => {
  const e = await env();
  try {
    const u = await authorize(e.db, A_CHAT);
    await e.db.markAnalyticsDirty({ userId: u.id, resource: 'sleep', reason: 't', affectedFrom: '2026-09-14', affectedTo: '2026-09-14', now: NOW });
    await assert.rejects(() => e.db.claimAnalyticsWork({ userId: u.id, cls: ANALYTICS_CLASS.LIGHT, owner: 'w', leaseMs: 60_000, now: NOW }), LifecycleContextError);
    await assert.rejects(() => e.db.mutateForAnalytics({ userId: u.id, cls: ANALYTICS_CLASS.LIGHT, owner: 'w', generation: 1, now: () => NOW }, async () => 1), LifecycleContextError);
    await assert.rejects(() => e.db.settleAnalyticsWork({ userId: u.id, cls: ANALYTICS_CLASS.LIGHT, owner: 'w', result: 'SUCCESS', generation: 1, now: NOW }), LifecycleContextError);
    await assert.rejects(() => e.db.saveAnalyticsDailyState(u.id, [], { owner: 'w', generation: 1, now: NOW }), LifecycleContextError);
  } finally { e.done(); }
});

test('R3-16 ★★★ 分析：L1 認領 → ABA → 舊的 saveAnalyticsDailyState 被拒；結案也被拒', async () => {
  const e = await env();
  try {
    const u = await authorize(e.db, A_CHAT);
    await e.db.markAnalyticsDirty({ userId: u.id, resource: 'sleep', reason: 't', affectedFrom: '2026-09-14', affectedTo: '2026-09-14', now: NOW });
    const life = await lifeOf(e.db, u.id);
    const claim = await e.db.claimAnalyticsWork({ userId: u.id, cls: ANALYTICS_CLASS.LIGHT, owner: 'w', leaseMs: 600_000, expectedLifecycleGeneration: life, now: NOW });
    assert.ok(claim);
    await aba(e.db, u.id);
    await assert.rejects(
      () => e.db.saveAnalyticsDailyState(u.id, [{ health_date: '2026-09-14' }], { owner: 'w', generation: claim.generation, expectedLifecycleGeneration: life, now: NOW, clock: () => NOW }),
      /analytics_account_inactive|analytics_ownership_lost/,
    );
    const settled = await e.db.settleAnalyticsWork({ userId: u.id, cls: ANALYTICS_CLASS.LIGHT, owner: 'w', result: 'SUCCESS', generation: claim.generation, expectedLifecycleGeneration: life, now: NOW });
    assert.equal(settled, false, '★★★ 舊世代不可以把目前的分析狀態標成完成');
  } finally { e.done(); }
});

// ===========================================================================
// R2-FG-03-CLI：對帳 CLI
// ===========================================================================

test('R3-17 reconcile CLI completes active/admin runs and rejects inactive default', async () => {
  const e = await env();
  try {
    const u = await authorize(e.db, A_CHAT);
    const args = ['run', `--user=${u.id}`, '--resource=sleep', '--from=2026-09-01', '--to=2026-09-02'];
    const active = runCli(e, 'reconcile', args);
    assert.equal(active.status, 0, active.stderr);
    assert.match(active.stdout, /SUCCESS/);
    assert.match(active.requests, /resource/);
    await e.db.transitionUserLifecycle({ userId: u.id, targetStatus: USER_STATUS.DISABLED });
    const rejected = runCli(e, 'reconcile', args);
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /非 ACTIVE/);
    assert.equal(rejected.requests, '');
    const admin = runCli(e, 'reconcile', [...args, '--allow-inactive']);
    assert.equal(admin.status, 0, admin.stderr);
    assert.match(admin.stdout, /SUCCESS/);
    assert.match(admin.requests, /resource/);
  } finally { e.done(); }
});

// ===========================================================================
// R2-STAGE-01：provider 階段邊界
// ===========================================================================

for (const via of INACTIVE) {
  test(`R3-18/${via} ★★★ sync：sleep 階段在 L1 完成、換啟用期 → recovery 階段**不開始**`, async () => {
    const e = await env();
    try {
      const u = await authorize(e.db, A_CHAT);
      const life = await lifeOf(e.db, u.id);
      const calls = [];
      const sync = createSync({
        db: e.db, userId: u.id, timezone: 'Asia/Taipei', expectedLifecycleGeneration: life, now: NOW,
        whoop: {
          sleeps: async () => { calls.push('sleep'); return []; },
          recoveries: async () => { calls.push('recovery'); return []; },
          cycles: async () => { calls.push('cycle'); return []; },
          workouts: async () => { calls.push('workout'); return []; },
          bodyMeasurement: async () => { calls.push('body'); return null; },
        },
      });
      // 在 sleep 落地之後、recovery 開始之前換啟用期
      const orig = e.db.saveSyncState.bind(e.db);
      let flipped = false;
      e.db.saveSyncState = async (...a) => {
        const r = await orig(...a);
        if (!flipped && a[1] === 'sleep') { flipped = true; await e.db.transitionUserLifecycle({ userId: u.id, targetStatus: via }); }
        return r;
      };
      const results = await sync.syncAll({ force: true, resources: ['sleep', 'recovery', 'cycle'] });
      assert.ok(!calls.includes('recovery') && !calls.includes('cycle'),
        `★★★ recovery / cycle 的 provider 請求根本不可以發出：${calls}`);
      assert.equal(calls.filter((c) => c === 'sleep').length, 1,
        '★ sleep 的 backfill chunk 也不再發出（換啟用期發生在 incremental 落地之後）');
      // 換啟用期發生在 sleep 的 incremental 落地之後：sleep 的 backfill 抓取
      // 被階段邊界擋下 → sleep 以 account_inactive 結束、迴圈中止。
      assert.equal(results.find((r) => r.resource === 'sleep')?.status, 'account_inactive');
      assert.equal(results.find((r) => r.resource === 'recovery'), undefined, '★★★ recovery 階段根本沒開始');
      assert.equal(results.find((r) => r.resource === 'cycle'), undefined, '★ 後面的階段也不跑');
    } finally { e.done(); }
  });
}

test('R3-19 ★★★ 盤點：階段依序、每個階段前重新驗證 —— 停用後不再發任何新請求', async () => {
  const e = await env();
  try {
    const u = await authorize(e.db, A_CHAT);
    const life = await lifeOf(e.db, u.id);
    const calls = [];
    const whoop = {
      sleeps: async () => { calls.push('sleep'); await e.db.transitionUserLifecycle({ userId: u.id, targetStatus: USER_STATUS.PAUSED }); return []; },
      recoveries: async () => { calls.push('recovery'); return []; },
      cycles: async () => { calls.push('cycle'); return []; },
      workouts: async () => { calls.push('workout'); return []; },
      bodyMeasurement: async () => { calls.push('body'); return null; },
    };
    const err = await probeCapabilities({ db: e.db, whoop, userId: u.id, timezone: 'Asia/Taipei', days: 14, expectedLifecycleGeneration: life, now: NOW }).then(() => null, (x) => x);
    assert.ok(err && isAccountInactiveError(err), '★ 盤點以帳號層級的停止結束');
    assert.deepEqual(calls, ['sleep'], '★★★ 停用之後其餘四個階段一個都不可以發出（不再 Promise.all）');
    const caps = await e.db.getCapabilities(u.id);
    assert.ok(!caps || !Object.keys(caps).length, '★ 沒有寫下任何盤點');
  } finally { e.done(); }
});

// ===========================================================================
// R2-MIG-01：遷移的 READY 述詞要求完整的 v18 集合
// ===========================================================================

test('R3-20 ★★★ 遷移：只有 sleep 判定、缺 recovery 的 READY → 降級', async () => {
  const e = await env();
  try {
    assert.deepEqual([...V18_READY_REQUIRED_RESOURCES], ['sleep', 'recovery'], '★ v18 凍結集合');
    assert.deepEqual([...V18_READY_REQUIRED_RESOURCES], [...ONBOARDING.REQUIRED_SCOPES], '★ 與 v18 當下的執行期要求相等');
    const u = await authorize(e.db, A_CHAT);
    const life = await lifeOf(e.db, u.id);
    // 只有 sleep 的目前世代判定（缺 recovery）
    await e.db.recordResourceAccess(u.id, [{ resource: 'sleep', status: RESOURCE_ACCESS_STATUS.ACCESSIBLE }], { expectedAuthGeneration: 1, expectedLifecycleGeneration: life, now: NOW });
    await e.db.raw.execute({ sql: "UPDATE user_onboarding SET state='READY', ready_at=?, timezone_confirmed_at=? WHERE user_id=?", args: [NOW.toISOString(), NOW.toISOString(), u.id] });
    await e.db.raw.execute('DELETE FROM schema_version');
    await e.db.raw.execute("INSERT INTO schema_version (version, applied_at, note) VALUES (17, '2026-09-14T00:00:00.000Z', 'v17')");
    const s = await e.db.migrate();
    assert.ok(s.dataMigrations.some((d) => d.version === 18 && d.rows === 1), '★★★ 缺 recovery 必須降級');
    assert.equal((await e.db.getOnboardingRow(u.id)).state, ONBOARDING_STATE.WHOOP_AUTHORIZED);
  } finally { e.done(); }
});

test('MIG-R3-02 ★ 遷移：sleep + recovery 都有目前世代判定 → 保持 READY（完整不變量成立）', async () => {
  const e = await env();
  try {
    const u = await authorize(e.db, A_CHAT);
    const life = await lifeOf(e.db, u.id);
    await e.db.recordResourceAccess(u.id, [
      { resource: 'sleep', status: RESOURCE_ACCESS_STATUS.ACCESSIBLE },
      { resource: 'recovery', status: RESOURCE_ACCESS_STATUS.ACCESSIBLE },
    ], { expectedAuthGeneration: 1, expectedLifecycleGeneration: life, now: NOW });
    await e.db.saveSyncState(u.id, 'sleep', { lastSuccessAt: NOW.toISOString() }, { now: NOW });
    await e.db.saveCapabilities(u.id, [{ key: 'recovery', status: 'SUPPORTED' }], { expectedLifecycleGeneration: life, now: NOW });
    await e.db.raw.execute({ sql: "UPDATE user_onboarding SET state='READY', ready_at=?, timezone_confirmed_at=? WHERE user_id=?", args: [NOW.toISOString(), NOW.toISOString(), u.id] });
    await e.db.raw.execute('DELETE FROM schema_version');
    await e.db.raw.execute("INSERT INTO schema_version (version, applied_at, note) VALUES (17, '2026-09-14T00:00:00.000Z', 'v17')");
    const s = await e.db.migrate();
    assert.ok(s.dataMigrations.some((d) => d.version === 18 && d.rows === 0), '★ 完整證據 → 不動');
    assert.equal((await e.db.getOnboardingRow(u.id)).state, ONBOARDING_STATE.READY);
  } finally { e.done(); }
});

test('MIG-R3-05 / 多使用者：Alice 的轉移不影響 Bob 的認領、冷卻、分析、送出', async () => {
  const e = await env();
  try {
    const alice = await authorize(e.db, A_CHAT, { whoopUserId: 'W-A' });
    const bob = await authorize(e.db, B_CHAT, { whoopUserId: 'W-B' });
    const bobLife = await lifeOf(e.db, bob.id);
    const c = await e.db.claimReport({ userId: bob.id, reportType: 'daily', localDateKey: '2026-09-15', ttlMs: 600_000, expectedLifecycleGeneration: bobLife, now: NOW });
    assert.equal(c.granted, true);
    await aba(e.db, alice.id);
    assert.equal(await e.db.authorizeReportDelivery({ userId: bob.id, reportType: 'daily', localDateKey: '2026-09-15', owner: c.owner, expectedLifecycleGeneration: bobLife, now: NOW }), true, '★★★ Bob 的認領不受 Alice 影響');
    assert.ok(await e.db.getActiveChatIdForUser(bob.id, { expectedLifecycleGeneration: bobLife }));
    assert.equal(await lifeOf(e.db, bob.id), bobLife);
  } finally { e.done(); }
});

for (const missing of [undefined, null, 0]) {
  test(`R3-15 range/release/ownership APIs reject lifecycle ${missing}`, async () => {
    const e = await env();
    try {
      const u = await authorize(e.db, A_CHAT);
      const args = { userId: u.id, cls: 'light', owner: 'w', generation: 1, now: NOW, expectedLifecycleGeneration: missing };
      for (const method of ['setAnalyticsRange', 'advanceAnalyticsRange', 'releaseAnalyticsWork', 'holdsAnalyticsWork']) {
        await assert.rejects(() => e.db[method](args), LifecycleContextError, method);
      }
    } finally { e.done(); }
  });
}

test('R3-16 stale lifecycle cannot mutate range, settle failure, release or prove ownership even with intact owner/lease', async () => {
  const e = await env();
  try {
    const u = await authorize(e.db, A_CHAT);
    const args = { userId: u.id, cls: 'light', owner: 'w', expectedLifecycleGeneration: 1, now: NOW };
    const claim = await e.db.claimAnalyticsWork({ ...args, leaseMs: 600000 });
    args.generation = claim.generation;
    await e.db.setAnalyticsRange({ ...args, from: '2026-09-01', to: '2026-09-14' });
    const before = await e.db.getAnalyticsWorkState(u.id, 'light');
    await e.db.raw.execute({ sql: 'UPDATE users SET lifecycle_generation = 3 WHERE id = ?', args: [u.id] });
    assert.equal(await e.db.setAnalyticsRange({ ...args, from: '2026-08-01', to: '2026-09-14' }), false);
    assert.equal(await e.db.advanceAnalyticsRange({ ...args, chunkTo: '2026-09-14', newTo: null }), false);
    assert.equal(await e.db.holdsAnalyticsWork(args), false);
    assert.equal(await e.db.releaseAnalyticsWork(args), false);
    assert.equal(await e.db.settleAnalyticsWork({ ...args, result: 'FAILED', errorClass: 'test' }), false);
    assert.equal(await e.db.settleAnalyticsWork({ ...args, result: 'SUCCESS' }), false);
    await assert.rejects(() => e.db.saveAnalyticsDailyState(u.id, [{ health_date: '2026-09-14' }], { ...args, clock: () => NOW }), /analytics_account_inactive/);
    assert.deepEqual(await e.db.getAnalyticsWorkState(u.id, 'light'), before);
  } finally { e.done(); }
});

test('R3 refresh same lifecycle preserves auth generation; reauthorization wins refresh CAS', async () => {
  const e = await env();
  try {
    const u = await authorize(e.db, A_CHAT);
    const before = await expiringToken(e.db, u.id);
    const client = createWhoopClient({ db: e.db, userId: u.id, clientId: 'c', clientSecret: 's', expectedLifecycleGeneration: 1, fetchImpl: httpBackend().fetchImpl });
    await client.getAccessToken();
    assert.equal((await e.db.getTokens(u.id)).authGeneration, before.authGeneration);
    const again = await expiringToken(e.db, u.id);
    const race = httpBackend({ onBeforeRefresh: async () => {
      await e.db.saveTokens(u.id, { ...again, accessToken: 'reauthorized', expiresAt: new Date(Date.now() + HOUR) }, { bumpAuthGeneration: true, expectedLifecycleGeneration: 1 });
    } });
    const racing = createWhoopClient({ db: e.db, userId: u.id, clientId: 'c', clientSecret: 's', expectedLifecycleGeneration: 1, fetchImpl: race.fetchImpl });
    assert.equal(await racing.getAccessToken(), 'reauthorized');
    const after = await e.db.getTokens(u.id);
    assert.equal(after.accessToken, 'reauthorized');
    assert.equal(after.authGeneration, again.authGeneration + 1);
  } finally { e.done(); }
});

test('R3-08 processor ABA after earlier authorization and delivery claim leaves no delivered receipt', async () => {
  const { createUpdateProcessor } = await import('../src/bot/updateProcessor.js');
  const e = await env();
  try {
    const u = await authorize(e.db, A_CHAT);
    let sent = 0;
    const start = e.db.markDeliveryStarted.bind(e.db);
    let flip = true;
    e.db.markDeliveryStarted = async (...args) => {
      const granted = await start(...args);
      if (granted && flip) { flip = false; await aba(e.db, u.id); }
      return granted;
    };
    const processor = createUpdateProcessor({
      db: e.db, resolveUser: (chat) => e.db.resolveUserByChatId(chat),
      handleMessage: async () => 'health answer', handleUnlinked: async () => null,
      sendReply: createSendReply({ db: e.db, api: { sendMessage: async () => ({ message_id: ++sent }) } }),
      now: () => NOW, sleepImpl: async () => {},
    });
    const update = (id) => ({ update_id: id, message: privateMessage(A_CHAT, '今天狀態如何？') });
    const stale = await processor.processUpdate(update(8101));
    assert.equal(stale.replied, false);
    assert.equal(sent, 0);
    const receipt = (await e.db.raw.execute('SELECT * FROM telegram_operations WHERE update_id = 8101')).rows[0];
    assert.ok(receipt);
    assert.notEqual(receipt.delivery_state, 'DELIVERED');
    assert.equal(receipt.delivered_at, null);
    assert.equal(receipt.telegram_message_id, null);
    const fresh = await processor.processUpdate(update(8102));
    assert.equal(fresh.replied, true);
    assert.equal(sent, 1);
  } finally { e.done(); }
});

test('R3-10 stale DELIVERY_STARTED is reclaimed even without transition cleanup', async () => {
  const e = await env();
  try {
    const u = await authorize(e.db, A_CHAT);
    const key = { userId: u.id, reportType: 'daily', localDateKey: '2026-09-15', now: NOW };
    const old = await e.db.claimReport({ ...key, ttlMs: 600000, expectedLifecycleGeneration: 1 });
    assert.equal(await e.db.authorizeReportDelivery({ ...key, owner: old.owner, expectedLifecycleGeneration: 1 }), true);
    await e.db.raw.execute({ sql: 'UPDATE users SET lifecycle_generation = 3 WHERE id = ?', args: [u.id] });
    const fresh = await e.db.claimReport({ ...key, ttlMs: 600000, expectedLifecycleGeneration: 3 });
    assert.equal(fresh.granted, true);
    assert.equal(await e.db.authorizeReportDelivery({ ...key, owner: old.owner, expectedLifecycleGeneration: 1 }), false);
    let sent = 0;
    const delivered = await deliverReport({ db: e.db, claimKey: key, claim: fresh, text: 'morning', now: () => NOW, telegram: { send: async () => ({ messageId: ++sent }) } });
    assert.equal(delivered.result, DELIVERY_RESULT.DELIVERED);
    assert.equal(sent, 1);
  } finally { e.done(); }
});

for (const boundary of ['before_transaction', 'after_transaction']) {
  test(`R3-05 OAuth rechecks ${boundary} before continuation or hook`, async () => {
    const e = await env();
    try {
      await onb(e.db, A_CHAT, '/start');
      const u = await userFor(e.db, A_CHAT);
      const reply = await linked(e.db, u, 'Asia/Taipei');
      let hooks = 0;
      const proxy = new Proxy(e.db, { get(t, k) {
        if (k === 'transaction') return async (...args) => {
          if (boundary === 'before_transaction') await aba(e.db, u.id);
          const result = await t.transaction(...args);
          if (boundary === 'after_transaction') await aba(e.db, u.id);
          return result;
        };
        const value = t[k]; return typeof value === 'function' ? value.bind(t) : value;
      } });
      const cb = createWhoopOAuthCallback({ db: proxy, ...backend(), now: () => NOW, onAuthorized: async () => { hooks++; } });
      const result = await cb({ query: new URLSearchParams({ code: 'good', state: stateFromUrl(urlIn(reply)) }) });
      assert.equal(result.outcome, 'account_inactive');
      assert.equal(hooks, 0);
      assert.ok(await e.db.getTokens(u.id));
    } finally { e.done(); }
  });
}

for (const scenario of ['valid', 'recovery_denied', 'inactive']) {
  test(`MIG-R3-03/04/05 actual frozen v9 schema -> revalidation: ${scenario}`, async () => {
    const t = tempDir();
    const db = createDb({ url: t.url });
    try {
      const fixture = JSON.parse(fs.readFileSync(path.join(ROOT, 'test/fixtures/schema-v9.json'), 'utf8'));
      assert.equal(fixture.version, 9);
      for (const sql of fixture.schema) await db.raw.execute(sql);
      for (const { table, column, ddl } of fixture.additive) {
        const columns = (await db.raw.execute(`PRAGMA table_info(${table})`)).rows;
        if (!columns.some((c) => c.name === column)) await db.raw.execute(ddl);
      }
      const uid = 'legacy-v9';
      const ts = NOW.toISOString();
      await db.raw.execute({ sql: "INSERT INTO schema_version(version, applied_at, note) VALUES (9, ?, 'frozen v9')", args: [ts] });
      await db.raw.execute({ sql: 'INSERT INTO users(id, display_name, timezone, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', args: [uid, 'Legacy', 'Asia/Taipei', scenario === 'inactive' ? 'DISABLED' : 'ACTIVE', ts, ts] });
      await db.raw.execute({ sql: "INSERT INTO user_telegram(telegram_chat_id, user_id, linked_at, status) VALUES (?, ?, ?, 'ACTIVE')", args: [A_CHAT, uid, ts] });
      await db.raw.execute({ sql: 'INSERT INTO user_whoop_tokens(user_id, whoop_user_id, access_token, refresh_token, access_token_expires_at, scope, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', args: [uid, 'W1', 'legacy-test', 'legacy-test-refresh', new Date(Date.now() + HOUR).toISOString(), 'offline read:sleep read:recovery', ts] });
      await db.raw.execute({ sql: "INSERT INTO whoop_sync_state(user_id, resource, last_success_at, updated_at) VALUES (?, 'sleep', ?, ?)", args: [uid, ts, ts] });
      await db.raw.execute({ sql: "INSERT INTO whoop_capabilities(user_id, key, status, last_probed_at) VALUES (?, 'recovery', 'SUPPORTED', ?)", args: [uid, ts] });
      const migrated = await db.migrate();
      assert.equal(migrated.from, 9);
      assert.equal(migrated.to, 25);
      assert.equal((await db.raw.execute('SELECT COUNT(*) n FROM whoop_resource_access')).rows[0].n, 0);
      const state = await db.getOnboardingRow(uid);
      assert.notEqual(state.state, 'READY');
      if (scenario !== 'inactive') assert.equal(state.state, 'WHOOP_AUTHORIZED');
      const { resumeOnboardingBootstraps } = await import('../src/onboardingBootstrap.js');
      const provider = httpBackend();
      let requests = 0;
      const results = await resumeOnboardingBootstraps({ db, env: { whoopClientId: 'test', whoopClientSecret: 'test' }, now: () => NOW, deps: {
        makeWhoop: (opts) => createWhoopClient({ ...opts, sleepImpl: async () => {}, fetchImpl: async (url, init) => {
          requests++;
          if (scenario === 'recovery_denied' && new URL(url).pathname.endsWith('/recovery')) {
            return new Response('{}', { status: 403 });
          }
          return provider.fetchImpl(url, init);
        } }),
      } });
      const after = await db.getOnboardingRow(uid);
      if (scenario === 'valid') {
        assert.equal(after.state, 'READY', JSON.stringify(results));
        assert.ok(requests > 0);
      } else if (scenario === 'recovery_denied') {
        assert.equal(after.state, 'ACTION_REQUIRED', JSON.stringify(results));
        assert.equal(after.failureCode, 'WHOOP_SCOPE_INCOMPLETE');
      } else {
        assert.equal((await db.getUser(uid)).status, 'DISABLED');
        assert.equal(requests, 0);
        assert.notEqual(after.state, 'READY');
      }
    } finally { db.close(); t.cleanup(); }
  });
}

for (const owned of ['journal', 'canonical']) {
  test(`R3-06 orphan cleanup rejects ${owned}-only ownership`, async () => {
    const e = await env();
    try {
      const u = await e.db.createUser({ displayName: 'owned', timezone: 'UTC' });
      const ts = NOW.toISOString();
      if (owned === 'journal') {
        await e.db.raw.execute({ sql: "INSERT INTO journal_events(user_id, event_at, health_date, category, source, created_at, updated_at) VALUES (?, ?, '2026-09-15', 'alcohol', 'test', ?, ?)", args: [u.id, ts, ts, ts] });
      } else {
        await e.db.raw.execute({ sql: "INSERT INTO whoop_body_measurements(user_id, recorded_at, height_meter, raw_json, synced_at) VALUES (?, ?, 1.7, '{}', ?)", args: [u.id, ts, ts] });
      }
      const result = await e.db.transitionUserLifecycle({ userId: u.id, targetStatus: 'DISABLED', orphanCleanupOnly: true });
      assert.equal(result.changed, false);
      assert.equal((await e.db.getUser(u.id)).status, 'ACTIVE');
    } finally { e.done(); }
  });
}

test('R3 analytics heavy output requires lifecycle and matching output user', async () => {
  const { fencedAnalyticsDb, runHeavyAnalytics } = await import('../src/analyticsWorker.js');
  const e = await env();
  try {
    const u = await authorize(e.db, A_CHAT);
    await assert.rejects(() => runHeavyAnalytics({ db: e.db, userId: u.id }), LifecycleContextError);
    assert.throws(() => fencedAnalyticsDb(e.db, { userId: u.id, cls: 'heavy', owner: 'w', generation: 0, now: () => NOW }), LifecycleContextError);
    const claim = await e.db.claimAnalyticsWork({ userId: u.id, cls: 'heavy', owner: 'w', leaseMs: 600000, expectedLifecycleGeneration: 1, now: NOW });
    const { db: fenced } = fencedAnalyticsDb(e.db, { userId: u.id, cls: 'heavy', owner: 'w', generation: claim.generation, expectedLifecycleGeneration: 1, now: () => NOW });
    await assert.rejects(() => fenced.savePredictionModel('another-user', {}), /analytics_output_user_mismatch/);
  } finally { e.done(); }
});

for (const missing of ['timezone', 'binding', 'token_identity', 'sync', 'capability']) {
  test(`MIG-R3-02 full resource evidence still demotes when ${missing} is missing`, async () => {
    const e = await env();
    try {
      const u = await authorize(e.db, A_CHAT);
      await e.db.recordResourceAccess(u.id, ['sleep', 'recovery'].map(resource => ({ resource, status: 'ACCESSIBLE' })), { expectedAuthGeneration: 1, expectedLifecycleGeneration: 1, now: NOW });
      await e.db.saveSyncState(u.id, 'sleep', { lastSuccessAt: NOW.toISOString() });
      await e.db.saveCapabilities(u.id, [{ key: 'recovery', status: 'SUPPORTED' }], { expectedLifecycleGeneration: 1 });
      await e.db.setOnboardingState(u.id, 'READY', { ready: true, timezoneConfirmed: true });
      const sql = {
        timezone: 'UPDATE user_onboarding SET timezone_confirmed_at = NULL WHERE user_id = ?',
        binding: 'DELETE FROM user_telegram WHERE user_id = ?',
        token_identity: 'UPDATE user_whoop_tokens SET whoop_user_id = NULL WHERE user_id = ?',
        sync: 'DELETE FROM whoop_sync_state WHERE user_id = ?',
        capability: 'UPDATE whoop_capabilities SET lifecycle_generation = 0 WHERE user_id = ?',
      }[missing];
      await e.db.raw.execute({ sql, args: [u.id] });
      await e.db.raw.execute('DELETE FROM schema_version');
      await e.db.raw.execute("INSERT INTO schema_version(version, applied_at, note) VALUES (17, '2026-09-14', 'test')");
      await e.db.migrate();
      assert.notEqual((await e.db.getOnboardingRow(u.id)).state, 'READY');
    } finally { e.done(); }
  });
}

test('R3 migration repairs false READY on an already-v18 database exactly once', async () => {
  const e = await env();
  try {
    const u = await authorize(e.db, A_CHAT);
    await e.db.setOnboardingState(u.id, 'READY', { timezoneConfirmed: true, ready: true });
    await e.db.recordResourceAccess(u.id, [{ resource: 'sleep', status: 'ACCESSIBLE' }], { expectedAuthGeneration: 1, expectedLifecycleGeneration: 1 });
    await e.db.raw.execute('DELETE FROM schema_version');
    await e.db.raw.execute("INSERT INTO schema_version(version, applied_at, note) VALUES (18, '2026-09-15', 'prior candidate')");
    const result = await e.db.migrate();
    assert.equal(result.from, 18);
    assert.equal(result.to, 25);
    assert.deepEqual(result.dataMigrations, [{ version: 19, rows: 1 }]);
    assert.equal((await e.db.getOnboardingRow(u.id)).state, 'WHOOP_AUTHORIZED');
    assert.deepEqual((await e.db.migrate()).dataMigrations, []);
  } finally { e.done(); }
});

test('R3-07 real Telegram claim loser is cleaned without changing winner', async () => {
  const e = await env();
  try {
    let loserId; let winner;
    const proxy = new Proxy(e.db, { get(t, k) {
      if (k === 'claimTelegramChat') return async (args) => {
        loserId = args.userId;
        winner = await t.createUser({ displayName: 'winner', timezone: 'UTC' });
        assert.equal((await t.claimTelegramChat({ ...args, userId: winner.id })).ok, true);
        return t.claimTelegramChat(args);
      };
      const value = t[k]; return typeof value === 'function' ? value.bind(t) : value;
    } });
    await onb(proxy, A_CHAT, '/start');
    const loser = await e.db.getUser(loserId);
    assert.equal(loser.status, 'DISABLED');
    assert.equal(loser.lifecycleGeneration, 2);
    assert.equal((await e.db.getUser(winner.id)).status, 'ACTIVE');
    assert.equal((await e.db.getTelegramLink(A_CHAT)).userId, winner.id);
  } finally { e.done(); }
});
