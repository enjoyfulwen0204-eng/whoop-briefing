/**
 * V1.2 Phase 3.5 — 自助 Telegram 上線。
 *
 * 一個全新的朋友只靠私訊就能把自己的 Health OS 開起來：
 *
 *   /start → 身分 + 綁定 → 時區 → Connect WHOOP → 公開 callback → token 綁定
 *          → 自動 bootstrap（初次同步 + capability）→ READY → 問自己的資料
 *
 * 沒有管理員建帳號、沒有綁定碼、沒有授權腳本、沒有 localhost callback、
 * 沒有複製 token。
 *
 * 這一支涵蓋 ONB-ATTACK-01 … 24 與完整的端對端模擬（含兩人同時上線）。
 * 全部用真實 libSQL；WHOOP 與 Telegram 都是假的（絕不打真的服務）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createDb } from '../src/db.js';
import {
  handleUnlinkedMessage, handleOnboardingMessage, normalizeTimezone, resolveOrCreateUser,
  issueAuthLink, MESSAGES,
} from '../src/onboarding.js';
import { createWhoopOAuthCallback, escapeHtml, renderScreen, OAUTH_CALLBACK_PATH } from '../src/whoopOAuthCallback.js';
import {
  runOnboardingBootstrap, resumeOnboardingBootstraps, evaluateReadiness, syncUsable, BOOTSTRAP_RESULT,
} from '../src/onboardingBootstrap.js';
import { createWebhookHandler } from '../src/bot/webhook.js';
import { runMigrations } from '../src/migrations.js';
import { ONBOARDING_STATE, ONBOARDING_FAILURE, USER_STATUS, SCHEMA_VERSION } from '../src/schema.js';
import { ONBOARDING } from '../src/config.js';

const NOW = new Date('2026-09-15T12:00:00.000Z');
const HOUR = 3_600_000;
const DAY = 86_400_000;
const CLIENT_ID = 'test-client';
const REDIRECT = 'https://example.test/whoop/oauth/callback';
const ALICE_CHAT = '111111';
const BOB_CHAT = '222222';

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whoop-onb-'));
  return { dir, url: `file:${path.join(dir, 't.db')}`, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
async function env() {
  const t = tempDir();
  const db = createDb({ url: t.url });
  await db.migrate();
  return { db, url: t.url, done: () => { try { db.close(); } catch { /* ignore */ } t.cleanup(); } };
}

/** 一則私訊 update 的 message 物件（sender id === chat id，與正式閘門一致）。 */
const privateMessage = (chatId, text, { firstName = 'Amy' } = {}) => ({
  message_id: 1, text,
  chat: { id: Number(chatId), type: 'private' },
  from: { id: Number(chatId), is_bot: false, first_name: firstName },
});

const onb = (db, chatId, text, opts = {}) => handleUnlinkedMessage({
  db, text, chatId, message: privateMessage(chatId, text), isPrivateChat: true,
  clientId: CLIENT_ID, redirectUri: REDIRECT, now: NOW, ...opts,
});
const linked = (db, user, text, opts = {}) => handleOnboardingMessage({
  db, user, text, clientId: CLIENT_ID, redirectUri: REDIRECT, now: NOW, ...opts,
});

const stateOf = async (db, userId) => (await db.getOnboarding(userId)).state;
const userFor = async (db, chatId) => (await db.resolveUserByChatId(String(chatId)))?.user ?? null;
const stateFromUrl = (url) => new URL(url).searchParams.get('state');
const countUsers = async (db) => Number((await db.raw.execute('SELECT COUNT(*) n FROM users')).rows[0].n);

/** 假 WHOOP：token 交換 + 身分 + 資料。 */
function fakeWhoopBackend({ whoopUserId = '900001', failExchange = false, failIdentity = false } = {}) {
  return {
    exchange: async ({ code }) => {
      if (failExchange) throw new Error('exchange boom');
      if (!code || code === 'bad') throw new Error('invalid_grant');
      return {
        accessToken: `at-${whoopUserId}`, refreshToken: `rt-${whoopUserId}`,
        expiresAt: new Date(NOW.getTime() + HOUR), scope: 'offline read:recovery',
      };
    },
    verifyIdentity: async () => {
      if (failIdentity) throw new Error('identity boom');
      return whoopUserId;
    },
  };
}

/** 假的同步 / capability（bootstrap 注入點），預設成功且寫入可驗證的痕跡。 */
function fakeBootstrapDeps({ db, syncStatus = 'ok', probeFails = false, notes = [] } = {}) {
  return {
    makeWhoop: () => ({ tag: 'fake-whoop' }),
    makeSync: ({ userId }) => ({
      syncAll: async () => {
        if (syncStatus === 'throw') throw new Error('sync exploded');
        // 真的寫同步狀態，讓 READY 判定有東西可看
        if (syncStatus === 'ok') {
          for (const r of ['sleep', 'recovery', 'cycle', 'workout', 'body_measurement']) {
            await db.saveSyncState(userId, r, { lastSuccessAt: NOW.toISOString() }, { now: NOW });
          }
        }
        return ['sleep', 'recovery', 'cycle', 'workout', 'body_measurement']
          .map((resource) => ({ resource, status: syncStatus === 'ok' ? 'ok' : syncStatus }));
      },
    }),
    probe: async ({ userId, expectedLifecycleGeneration }) => {
      if (probeFails) throw new Error('probe boom');
      await db.saveCapabilities(userId, [
        { key: 'recovery', status: 'SUPPORTED', sampleCount: 5, nonNullCount: 5 },
        { key: 'spo2', status: 'UNAVAILABLE', sampleCount: 5, nonNullCount: 0 },
      ], { expectedLifecycleGeneration, now: NOW });
      return { entries: [], scopeErrors: [] };
    },
    notify: async (userId, kind) => { notes.push({ userId, kind }); },
  };
}

/** 完整走完一個使用者的上線（回傳 user 與過程中的通知）。 */
async function onboardFully(db, chatId, { timezone = 'Asia/Taipei', whoopUserId = '900001' } = {}) {
  await onb(db, chatId, '/start');
  const user = await userFor(db, chatId);
  const tzReply = await linked(db, user, timezone);
  const authUrl = /https:\/\/\S+/.exec(tzReply)[0];
  const backend = fakeWhoopBackend({ whoopUserId });
  const callback = createWhoopOAuthCallback({ db, ...backend, now: () => NOW });
  const res = await callback({ query: new URLSearchParams({ code: 'good', state: stateFromUrl(authUrl) }) });
  assert.equal(res.outcome, 'ok');
  const notes = [];
  const boot = await runOnboardingBootstrap({
    db, userId: user.id, env: {}, now: () => NOW, deps: fakeBootstrapDeps({ db, notes }),
  });
  assert.equal(boot.result, BOOTSTRAP_RESULT.READY, JSON.stringify(boot));
  return { user: await db.getUser(user.id), notes, authUrl };
}

// ===========================================================================
// ONB-ATTACK-01 / 02 / 03 / 04 — /start 的身分建立與邊界
// ===========================================================================

test('ONB-ATTACK-01 陌生私訊 /start：恰好建立一個使用者與一個綁定，並得到歡迎訊息', async () => {
  const e = await env();
  try {
    const reply = await onb(e.db, ALICE_CHAT, '/start');
    assert.match(reply, /歡迎/);
    assert.match(reply, /時區/);
    assert.equal(await countUsers(e.db), 1);
    const user = await userFor(e.db, ALICE_CHAT);
    assert.ok(user);
    assert.equal(user.status, USER_STATUS.ACTIVE);
    assert.equal(await stateOf(e.db, user.id), ONBOARDING_STATE.TIMEZONE_PENDING);
    const links = await e.db.raw.execute('SELECT * FROM user_telegram');
    assert.equal(links.rows.length, 1);
    assert.equal(String(links.rows[0].telegram_chat_id), ALICE_CHAT);
    assert.equal(String(links.rows[0].user_id), user.id);
    // 不洩漏任何內部 id
    assert.ok(!reply.includes(user.id));
  } finally { e.done(); }
});

test('ONB-ATTACK-02 同一個私訊連送 20 次 /start（含並發）：仍然只有一個使用者、一個綁定、一份狀態', async () => {
  const e = await env();
  try {
    await Promise.all(Array.from({ length: 20 }, () => onb(e.db, ALICE_CHAT, '/start')));
    // 併發時每一個都會先建一個 users 列，但只有一個能原子認領這個 chat；
    // 輸的那些立刻被停用，所以「可用的身分」恰好一個。
    assert.equal((await e.db.listActiveUsers()).length, 1, '★★★ 只有一個 ACTIVE 使用者');
    const links = await e.db.raw.execute('SELECT * FROM user_telegram');
    assert.equal(links.rows.length, 1, '★ 一個綁定');
    const rows = await e.db.raw.execute('SELECT * FROM user_onboarding');
    assert.equal(rows.rows.length, 1, '★ 一份上線狀態');
    const orphans = await e.db.raw.execute("SELECT COUNT(*) n FROM users WHERE status <> 'ACTIVE'");
    const tokens = await e.db.raw.execute('SELECT COUNT(*) n FROM user_whoop_tokens');
    assert.equal(Number(tokens.rows[0].n), 0, '★ 落選的身分沒有任何 token');
    assert.equal((await e.db.listSchedulableUsers({ activeStatus: USER_STATUS.ACTIVE })).length, 0,
      '★ 落選的身分不會被排程（上線也還沒完成）');
    const before = await countUsers(e.db);
    for (let i = 0; i < 20; i += 1) await onb(e.db, ALICE_CHAT, '/start');
    assert.equal(await countUsers(e.db), before, '★ 連續 20 次完全冪等，一個新列都不會多');
    assert.equal((await e.db.listActiveUsers()).length, 1);
    const user = await userFor(e.db, ALICE_CHAT);
    assert.equal(String(links.rows[0].user_id), user.id);
    assert.equal(await stateOf(e.db, user.id), ONBOARDING_STATE.TIMEZONE_PENDING);
    assert.ok(Number(orphans.rows[0].n) >= 0);
  } finally { e.done(); }
});

test('ONB-ATTACK-03 群組 /start：不建立任何使用者、不回覆', async () => {
  const e = await env();
  try {
    const reply = await handleUnlinkedMessage({
      db: e.db, text: '/start', chatId: '-100999', message: { chat: { id: -100999, type: 'group' } },
      isPrivateChat: false, clientId: CLIENT_ID, redirectUri: REDIRECT, now: NOW,
    });
    assert.equal(reply, null, '★ 完全不回');
    assert.equal(await countUsers(e.db), 0, '★★★ 群組不可能建立身分');
    assert.equal((await e.db.raw.execute('SELECT * FROM user_telegram')).rows.length, 0);
  } finally { e.done(); }
});

test('ONB-ATTACK-04 sender/chat 不一致或群組 chat id：儲存層也擋（縱深防禦）', async () => {
  const e = await env();
  try {
    // 綁定層：負數（群組）chat id 一律拒絕，即使呼叫端說它是私訊
    const user = await e.db.createUser({ displayName: 'x', timezone: 'UTC', now: NOW });
    await assert.rejects(e.db.linkTelegram({ chatId: '-100123', userId: user.id, now: NOW }), /私訊/);
    // 自助流程本身也只在 isPrivateChat 時動作
    const reply = await handleUnlinkedMessage({
      db: e.db, text: '/start', chatId: '-100123', message: { chat: { id: -100123, type: 'private' } },
      isPrivateChat: false, clientId: CLIENT_ID, redirectUri: REDIRECT, now: NOW,
    });
    assert.equal(reply, null);
    assert.equal((await e.db.raw.execute('SELECT * FROM user_telegram')).rows.length, 0);
  } finally { e.done(); }
});

test('ONB-ATTACK-05 Alice / Bob 同時上線：兩個獨立的使用者、狀態、時區', async () => {
  const e = await env();
  try {
    await Promise.all([onb(e.db, ALICE_CHAT, '/start'), onb(e.db, BOB_CHAT, '/start')]);
    assert.equal((await e.db.listActiveUsers()).length, 2);
    const a = await userFor(e.db, ALICE_CHAT); const b = await userFor(e.db, BOB_CHAT);
    assert.notEqual(a.id, b.id);
    await linked(e.db, a, 'Asia/Taipei');
    await linked(e.db, b, 'Asia/Ho_Chi_Minh');
    assert.equal((await e.db.getUser(a.id)).timezone, 'Asia/Taipei');
    assert.equal((await e.db.getUser(b.id)).timezone, 'Asia/Ho_Chi_Minh');
    assert.equal(await stateOf(e.db, a.id), ONBOARDING_STATE.WHOOP_AUTH_PENDING);
    assert.equal(await stateOf(e.db, b.id), ONBOARDING_STATE.WHOOP_AUTH_PENDING);
  } finally { e.done(); }
});

// ===========================================================================
// 時區（ONB-ATTACK-16 / 17）
// ===========================================================================

test('ONB-ATTACK-16 時區驗證：合法的 IANA 才接受，時差字串與亂打一律拒絕', async () => {
  assert.equal(normalizeTimezone('Asia/Taipei'), 'Asia/Taipei');
  assert.equal(normalizeTimezone('Asia/Ho_Chi_Minh'), 'Asia/Ho_Chi_Minh');
  assert.equal(normalizeTimezone('Europe/Berlin'), 'Europe/Berlin');
  assert.equal(normalizeTimezone('America/Argentina/Buenos_Aires'), 'America/Argentina/Buenos_Aires');
  assert.equal(normalizeTimezone(' Asia/Kuala_Lumpur '), 'Asia/Kuala_Lumpur');
  // ICU 會把合法別名正規化（Asia/Ho_Chi_Minh → Asia/Saigon）；我們保留使用者
  // 打的名字，但只在大小寫不同時採用正規化寫法。
  assert.equal(normalizeTimezone('asia/taipei'), 'Asia/Taipei');
  assert.equal(normalizeTimezone('Asia/Saigon'), 'Asia/Saigon');
  for (const bad of ['+08:00', 'GMT+8', '台北', 'Mars/Olympus', '', null, undefined, 'x'.repeat(80),
    'Asia/Taipei; DROP TABLE users', '../../etc/passwd']) {
    assert.equal(normalizeTimezone(bad), null, JSON.stringify(bad));
  }
  const e = await env();
  try {
    await onb(e.db, ALICE_CHAT, '/start');
    const user = await userFor(e.db, ALICE_CHAT);
    const reply = await linked(e.db, user, '+08:00');
    assert.match(reply, /不認得/);
    assert.equal((await e.db.getUser(user.id)).timezone, 'UTC', '★ 不合法就不寫入');
    assert.equal(await stateOf(e.db, user.id), ONBOARDING_STATE.TIMEZONE_PENDING);
  } finally { e.done(); }
});

test('ONB-ATTACK-17 越南 / 台灣時區在跨日邊界各自正確', async () => {
  const e = await env();
  try {
    await onb(e.db, ALICE_CHAT, '/start'); await onb(e.db, BOB_CHAT, '/start');
    const a = await userFor(e.db, ALICE_CHAT); const b = await userFor(e.db, BOB_CHAT);
    await linked(e.db, a, 'Asia/Taipei');
    await linked(e.db, b, 'Asia/Ho_Chi_Minh');
    const { localDate } = await import('../src/time.js');
    // 台北 UTC+8 / 胡志明 UTC+7：UTC 16:30 時，台北已經是隔天 00:30，胡志明還是 23:30
    const t = new Date('2026-09-15T16:30:00.000Z');
    assert.equal(localDate(t, (await e.db.getUser(a.id)).timezone), '2026-09-16');
    assert.equal(localDate(t, (await e.db.getUser(b.id)).timezone), '2026-09-15');
  } finally { e.done(); }
});

// ===========================================================================
// OAuth（ONB-ATTACK-06 … 12, 22, 23）
// ===========================================================================

test('ONB-ATTACK-06 Alice 的 state 在「別的瀏覽器」完成：仍然只綁到 Alice（瀏覽器身分無關）', async () => {
  const e = await env();
  try {
    await onb(e.db, ALICE_CHAT, '/start'); await onb(e.db, BOB_CHAT, '/start');
    const a = await userFor(e.db, ALICE_CHAT); const b = await userFor(e.db, BOB_CHAT);
    const aliceReply = await linked(e.db, a, 'Asia/Taipei');
    await linked(e.db, b, 'Asia/Tokyo');
    const aliceState = stateFromUrl(/https:\/\/\S+/.exec(aliceReply)[0]);
    // 「Bob 的瀏覽器」= 同一個 callback，沒有任何使用者參數可以指定
    const callback = createWhoopOAuthCallback({ db: e.db, ...fakeWhoopBackend({ whoopUserId: '5555' }), now: () => NOW });
    const res = await callback({ query: new URLSearchParams({ code: 'good', state: aliceState, user_id: b.id }) });
    assert.equal(res.outcome, 'ok');
    assert.equal(res.userId, a.id, '★★★ 綁到 state 的擁有者 Alice');
    assert.equal((await e.db.getTokens(a.id))?.whoopUserId, '5555');
    assert.equal(await e.db.getTokens(b.id), null, '★ Bob 沒有拿到任何 token');
    assert.equal(await stateOf(e.db, b.id), ONBOARDING_STATE.WHOOP_AUTH_PENDING);
  } finally { e.done(); }
});

test('ONB-ATTACK-07 / 23 state 重放：第二次被拒；已成功的綁定不會被重複改動', async () => {
  const e = await env();
  try {
    await onb(e.db, ALICE_CHAT, '/start');
    const a = await userFor(e.db, ALICE_CHAT);
    const reply = await linked(e.db, a, 'Asia/Taipei');
    const st = stateFromUrl(/https:\/\/\S+/.exec(reply)[0]);
    const callback = createWhoopOAuthCallback({ db: e.db, ...fakeWhoopBackend(), now: () => NOW });
    const first = await callback({ query: new URLSearchParams({ code: 'good', state: st }) });
    assert.equal(first.outcome, 'ok');
    const tokensAfterFirst = await e.db.getTokens(a.id);

    const replay = await callback({ query: new URLSearchParams({ code: 'good', state: st }) });
    assert.equal(replay.outcome, 'failed');
    assert.equal(replay.status, 400);
    assert.match(replay.html, /已經失效/);
    const tokensAfterReplay = await e.db.getTokens(a.id);
    assert.deepEqual(
      { at: tokensAfterReplay.accessToken, w: tokensAfterReplay.whoopUserId },
      { at: tokensAfterFirst.accessToken, w: tokensAfterFirst.whoopUserId },
      '★ 重放不會改動已經綁好的 token',
    );
    assert.equal(await stateOf(e.db, a.id), ONBOARDING_STATE.WHOOP_AUTHORIZED, '★ 重放不會把狀態打回失敗');
  } finally { e.done(); }
});

test('ONB-ATTACK-08 過期的 state：被拒，而且 /start 會給一條新的連結', async () => {
  const e = await env();
  try {
    await onb(e.db, ALICE_CHAT, '/start');
    const a = await userFor(e.db, ALICE_CHAT);
    const reply = await linked(e.db, a, 'Asia/Taipei');
    const st = stateFromUrl(/https:\/\/\S+/.exec(reply)[0]);
    const late = new Date(NOW.getTime() + ONBOARDING.OAUTH_STATE_TTL_MS + 1000);
    const callback = createWhoopOAuthCallback({ db: e.db, ...fakeWhoopBackend(), now: () => late });
    const res = await callback({ query: new URLSearchParams({ code: 'good', state: st }) });
    assert.equal(res.outcome, 'failed');
    assert.match(res.html, /已經失效/);
    assert.equal(await e.db.getTokens(a.id), null, '★ 沒有存任何 token');
    // 自助復原：/start 給新的連結，而且 state 不一樣
    const retry = await linked(e.db, a, '/start', { now: late });
    const newState = stateFromUrl(/https:\/\/\S+/.exec(retry)[0]);
    assert.notEqual(newState, st, '★ 每次重試都是新的一次性 state');
    const ok = await callback({ query: new URLSearchParams({ code: 'good', state: newState }) });
    assert.equal(ok.outcome, 'ok');
  } finally { e.done(); }
});

test('ONB-ATTACK-09 同一個 WHOOP 帳號給 Alice 與 Bob：只有一個擁有者，另一個安全失敗', async () => {
  const e = await env();
  try {
    await onb(e.db, ALICE_CHAT, '/start'); await onb(e.db, BOB_CHAT, '/start');
    const a = await userFor(e.db, ALICE_CHAT); const b = await userFor(e.db, BOB_CHAT);
    const ar = await linked(e.db, a, 'Asia/Taipei');
    const br = await linked(e.db, b, 'Asia/Tokyo');
    const callback = createWhoopOAuthCallback({ db: e.db, ...fakeWhoopBackend({ whoopUserId: '777' }), now: () => NOW });
    const first = await callback({ query: new URLSearchParams({ code: 'good', state: stateFromUrl(/https:\/\/\S+/.exec(ar)[0]) }) });
    assert.equal(first.outcome, 'ok');
    const second = await callback({ query: new URLSearchParams({ code: 'good', state: stateFromUrl(/https:\/\/\S+/.exec(br)[0]) }) });
    assert.equal(second.outcome, 'failed');
    assert.equal(second.failure, ONBOARDING_FAILURE.WHOOP_ACCOUNT_ALREADY_LINKED);
    assert.equal(second.status, 409);
    assert.equal((await e.db.getTokens(a.id)).whoopUserId, '777');
    assert.equal(await e.db.getTokens(b.id), null, '★★★ Bob 沒有拿到 token');
    assert.equal(await stateOf(e.db, b.id), ONBOARDING_STATE.ACTION_REQUIRED);
    const bobStatus = await linked(e.db, b, '/start');
    assert.match(bobStatus, /已經連到另一個使用者/);
  } finally { e.done(); }
});

test('ONB-ATTACK-10 同一個人重新連接同一個 WHOOP 帳號：安全支援，不會被打回上線中', async () => {
  const e = await env();
  try {
    const { user } = await onboardFully(e.db, ALICE_CHAT, { whoopUserId: '888' });
    assert.equal(await stateOf(e.db, user.id), ONBOARDING_STATE.READY);
    // 重新連接：要等過冷卻（剛剛才發過一條連結）
    const later = new Date(NOW.getTime() + ONBOARDING.AUTH_LINK_COOLDOWN_MS + 1);
    const reconnect = await linked(e.db, user, '/connect', { now: later });
    assert.match(reconnect, /連接你的 WHOOP/);
    const st = stateFromUrl(/https:\/\/\S+/.exec(reconnect)[0]);
    const callback = createWhoopOAuthCallback({ db: e.db, ...fakeWhoopBackend({ whoopUserId: '888' }), now: () => NOW });
    const res = await callback({ query: new URLSearchParams({ code: 'good', state: st }) });
    assert.equal(res.outcome, 'ok');
    // ★ RC2 / F04：成功的重新授權讓舊的權限判定失效（授權世代 +1），所以連
    // READY 的人也回到「已授權、待重新驗證」。bootstrap 隨即把他帶回 READY。
    assert.equal(await stateOf(e.db, user.id), ONBOARDING_STATE.WHOOP_AUTHORIZED);
    assert.equal((await e.db.getTokens(user.id)).whoopUserId, '888', '★ 綁定與資料完全沒有損失');
    const reboot = await runOnboardingBootstrap({
      db: e.db, userId: user.id, env: {}, now: () => NOW, deps: fakeBootstrapDeps({ db: e.db }),
    });
    assert.equal(reboot.result, BOOTSTRAP_RESULT.READY, '★ 重新驗證之後回到 READY');
    assert.equal(await stateOf(e.db, user.id), ONBOARDING_STATE.READY);
  } finally { e.done(); }
});

test('ONB-ATTACK-11 無效的 code：沒有 token 被寫入，狀態可重試', async () => {
  const e = await env();
  try {
    await onb(e.db, ALICE_CHAT, '/start');
    const a = await userFor(e.db, ALICE_CHAT);
    const reply = await linked(e.db, a, 'Asia/Taipei');
    const st = stateFromUrl(/https:\/\/\S+/.exec(reply)[0]);
    const callback = createWhoopOAuthCallback({ db: e.db, ...fakeWhoopBackend(), now: () => NOW });
    const res = await callback({ query: new URLSearchParams({ code: 'bad', state: st }) });
    assert.equal(res.outcome, 'failed');
    assert.equal(res.failure, ONBOARDING_FAILURE.TOKEN_EXCHANGE_FAILED);
    assert.equal(await e.db.getTokens(a.id), null, '★ 沒有 token 被寫入');
    assert.equal(await stateOf(e.db, a.id), ONBOARDING_STATE.ACTION_REQUIRED);
    assert.equal(res.userId, a.id, '★ 失敗被記到正確的人身上');
    // 重試可行（等過冷卻）
    const retry = await linked(e.db, a, '/connect', {
      now: new Date(NOW.getTime() + ONBOARDING.AUTH_LINK_COOLDOWN_MS + 1),
    });
    const ok = await callback({ query: new URLSearchParams({ code: 'good', state: stateFromUrl(/https:\/\/\S+/.exec(retry)[0]) }) });
    assert.equal(ok.outcome, 'ok');
    assert.equal(await stateOf(e.db, a.id), ONBOARDING_STATE.WHOOP_AUTHORIZED);
  } finally { e.done(); }
});

test('ONB-ATTACK-12 provider 回報錯誤：安全 HTML，絕不回放外部字串；state 不被消耗', async () => {
  const e = await env();
  try {
    await onb(e.db, ALICE_CHAT, '/start');
    const a = await userFor(e.db, ALICE_CHAT);
    const reply = await linked(e.db, a, 'Asia/Taipei');
    const st = stateFromUrl(/https:\/\/\S+/.exec(reply)[0]);
    const callback = createWhoopOAuthCallback({ db: e.db, ...fakeWhoopBackend(), now: () => NOW });
    const evil = '<script>alert(document.cookie)</script>';
    const res = await callback({ query: new URLSearchParams({ error: 'access_denied', error_description: evil, state: st }) });
    assert.equal(res.outcome, 'provider_error');
    assert.equal(res.status, 400);
    assert.ok(!res.html.includes('<script>'), '★★★ 沒有任何外部字串被回放');
    assert.ok(!res.html.includes('access_denied'));
    assert.ok(!res.html.includes(st), '★ 不回放 state');
    assert.ok(!res.html.includes(a.id), '★ 不洩漏內部 user id');
    assert.match(res.html, /授權未完成/);
    assert.equal(await stateOf(e.db, a.id), ONBOARDING_STATE.ACTION_REQUIRED);
    // state 沒有被消耗 —— 使用者可能只是按錯，手上那條還能用
    const ok = await callback({ query: new URLSearchParams({ code: 'good', state: st }) });
    assert.equal(ok.outcome, 'ok');
    // escapeHtml 本身
    assert.equal(escapeHtml('<a href="x">&\'</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
  } finally { e.done(); }
});

test('ONB-ATTACK-22 重複按 Connect：冷卻與總量都有界，且不影響已存在的連結', async () => {
  const e = await env();
  try {
    await onb(e.db, ALICE_CHAT, '/start');
    const a = await userFor(e.db, ALICE_CHAT);
    await linked(e.db, a, 'Asia/Taipei');           // 第 1 條
    const again = await linked(e.db, a, '/connect'); // 冷卻中
    assert.match(again, /剛剛才產生過/);
    let t = NOW.getTime();
    let issued = 1;
    for (let i = 0; i < 20; i += 1) {
      t += ONBOARDING.AUTH_LINK_COOLDOWN_MS + 1;
      const r = await linked(e.db, a, '/connect', { now: new Date(t) });
      if (/https:\/\//.test(r)) issued += 1; else assert.match(r, /太多次/);
    }
    // 上限是「同時還有效的連結數」，不是「這輪總共能按幾次」（RC1 / F03）
    assert.equal(issued, ONBOARDING.MAX_OUTSTANDING_AUTH_LINKS,
      `★ 同時最多 ${ONBOARDING.MAX_OUTSTANDING_AUTH_LINKS} 條`);
    const states = await e.db.raw.execute('SELECT COUNT(*) n FROM oauth_states');
    assert.equal(Number(states.rows[0].n), ONBOARDING.MAX_OUTSTANDING_AUTH_LINKS);
    // ★ 自己會恢復：等舊的 state 全部過期之後就能再拿新的（不會永久鎖死）
    const afterExpiry = new Date(t + ONBOARDING.OAUTH_STATE_TTL_MS + 1000);
    const recovered = await linked(e.db, a, '/connect', { now: afterExpiry });
    assert.match(recovered, /https:\/\//, '★★★ 過期之後可以再取得新連結');
  } finally { e.done(); }
});

// ===========================================================================
// bootstrap（ONB-ATTACK-13 / 14 / 15 / 21）
// ===========================================================================

test('ONB-ATTACK-13 token 綁定之後、通知之前崩潰：重啟看得到 WHOOP_AUTHORIZED 並接手', async () => {
  const e = await env();
  try {
    await onb(e.db, ALICE_CHAT, '/start');
    const a = await userFor(e.db, ALICE_CHAT);
    const reply = await linked(e.db, a, 'Asia/Taipei');
    // onAuthorized 直接爆掉 = 「通知/後續全部沒發生」
    const callback = createWhoopOAuthCallback({
      db: e.db, ...fakeWhoopBackend(), now: () => NOW,
      onAuthorized: async () => { throw new Error('process died'); },
    });
    const res = await callback({ query: new URLSearchParams({ code: 'good', state: stateFromUrl(/https:\/\/\S+/.exec(reply)[0]) }) });
    assert.equal(res.outcome, 'ok', '★ 綁定仍然成功');
    e.db.close();

    // 「重啟」：新的連線，排程器接手
    const db2 = createDb({ url: e.url });
    assert.equal((await db2.getOnboarding(a.id)).state, ONBOARDING_STATE.WHOOP_AUTHORIZED);
    const notes = [];
    const resumed = await resumeOnboardingBootstraps({
      db: db2, env: {}, now: () => NOW, deps: fakeBootstrapDeps({ db: db2, notes }),
    });
    assert.equal(resumed.length, 1);
    assert.equal(resumed[0].result, BOOTSTRAP_RESULT.READY);
    assert.equal((await db2.getOnboarding(a.id)).state, ONBOARDING_STATE.READY);
    assert.deepEqual(notes.map((n) => n.kind), ['ready']);
    db2.close();
  } finally { e.done(); }
});

test('ONB-ATTACK-14 初次同步中途崩潰：重啟繼續（狀態停在 SYNCING，下一輪接手）', async () => {
  const e = await env();
  try {
    await onb(e.db, ALICE_CHAT, '/start');
    const a = await userFor(e.db, ALICE_CHAT);
    const reply = await linked(e.db, a, 'Asia/Taipei');
    const callback = createWhoopOAuthCallback({ db: e.db, ...fakeWhoopBackend(), now: () => NOW });
    await callback({ query: new URLSearchParams({ code: 'good', state: stateFromUrl(/https:\/\/\S+/.exec(reply)[0]) }) });

    const crashed = await runOnboardingBootstrap({
      db: e.db, userId: a.id, env: {}, now: () => NOW,
      deps: { ...fakeBootstrapDeps({ db: e.db }), makeSync: () => ({ syncAll: async () => { throw new Error('crash'); } }) },
    });
    assert.equal(crashed.result, BOOTSTRAP_RESULT.RETRY);
    assert.equal((await e.db.getOnboarding(a.id)).state, ONBOARDING_STATE.SYNCING, '★ 停在 SYNCING');
    assert.equal((await e.db.getAllSyncState(a.id)).length, 0);

    const notes = [];
    const resumed = await resumeOnboardingBootstraps({
      db: e.db, env: {}, now: () => NOW, deps: fakeBootstrapDeps({ db: e.db, notes }),
    });
    assert.equal(resumed[0].result, BOOTSTRAP_RESULT.READY, '★ 下一輪接手完成');
    assert.equal(await stateOf(e.db, a.id), ONBOARDING_STATE.READY);
  } finally { e.done(); }
});

test('ONB-ATTACK-15 capability 暫時失敗：不會寫出假的 UNAVAILABLE，可以重試', async () => {
  const e = await env();
  try {
    await onb(e.db, ALICE_CHAT, '/start');
    const a = await userFor(e.db, ALICE_CHAT);
    const reply = await linked(e.db, a, 'Asia/Taipei');
    const callback = createWhoopOAuthCallback({ db: e.db, ...fakeWhoopBackend(), now: () => NOW });
    await callback({ query: new URLSearchParams({ code: 'good', state: stateFromUrl(/https:\/\/\S+/.exec(reply)[0]) }) });

    const failed = await runOnboardingBootstrap({
      db: e.db, userId: a.id, env: {}, now: () => NOW,
      deps: fakeBootstrapDeps({ db: e.db, probeFails: true }),
    });
    assert.equal(failed.result, BOOTSTRAP_RESULT.RETRY);
    const caps = await e.db.getCapabilities(a.id);
    assert.deepEqual(caps, {}, '★★★ 探測失敗不寫任何 capability 結論');
    assert.notEqual(await stateOf(e.db, a.id), ONBOARDING_STATE.READY);

    const ok = await runOnboardingBootstrap({
      db: e.db, userId: a.id, env: {}, now: () => NOW, deps: fakeBootstrapDeps({ db: e.db }),
    });
    assert.equal(ok.result, BOOTSTRAP_RESULT.READY);
    assert.equal((await e.db.getCapabilities(a.id)).recovery.status, 'SUPPORTED');
  } finally { e.done(); }
});

test('ONB-ATTACK-21 Alice 的 bootstrap 一直失敗：轉成 ACTION_REQUIRED，Bob 照樣完成', async () => {
  const e = await env();
  try {
    await onb(e.db, ALICE_CHAT, '/start'); await onb(e.db, BOB_CHAT, '/start');
    const a = await userFor(e.db, ALICE_CHAT); const b = await userFor(e.db, BOB_CHAT);
    const ar = await linked(e.db, a, 'Asia/Taipei');
    const br = await linked(e.db, b, 'Asia/Tokyo');
    const cbA = createWhoopOAuthCallback({ db: e.db, ...fakeWhoopBackend({ whoopUserId: 'A1' }), now: () => NOW });
    const cbB = createWhoopOAuthCallback({ db: e.db, ...fakeWhoopBackend({ whoopUserId: 'B1' }), now: () => NOW });
    await cbA({ query: new URLSearchParams({ code: 'good', state: stateFromUrl(/https:\/\/\S+/.exec(ar)[0]) }) });
    await cbB({ query: new URLSearchParams({ code: 'good', state: stateFromUrl(/https:\/\/\S+/.exec(br)[0]) }) });

    const notes = [];
    for (let i = 0; i < ONBOARDING.MAX_BOOTSTRAP_ATTEMPTS; i += 1) {
      await runOnboardingBootstrap({
        db: e.db, userId: a.id, env: {}, now: () => NOW,
        deps: { ...fakeBootstrapDeps({ db: e.db, notes }), makeSync: () => ({ syncAll: async () => [{ resource: 'sleep', status: 'failed' }] }) },
      });
    }
    assert.equal(await stateOf(e.db, a.id), ONBOARDING_STATE.ACTION_REQUIRED);
    const row = await e.db.getOnboardingRow(a.id);
    assert.equal(row.failureCode, ONBOARDING_FAILURE.BOOTSTRAP_FAILED);
    assert.ok(notes.some((n) => n.userId === a.id && n.kind === 'bootstrap_failed'));

    const bootB = await runOnboardingBootstrap({
      db: e.db, userId: b.id, env: {}, now: () => NOW, deps: fakeBootstrapDeps({ db: e.db, notes }),
    });
    assert.equal(bootB.result, BOOTSTRAP_RESULT.READY, '★ Bob 不受 Alice 影響');
    assert.equal(await stateOf(e.db, b.id), ONBOARDING_STATE.READY);
    assert.equal(await e.db.getTokens(a.id) !== null, true, 'Alice 的 token 仍在（可重試）');
  } finally { e.done(); }
});

test('bootstrap 的判定規則：scope_missing 不算失敗、同步結果為空不算可用；READY 條件逐項', async () => {
  assert.equal(syncUsable([]), false);
  assert.equal(syncUsable([{ resource: 'sleep', status: 'ok' }, { resource: 'recovery', status: 'scope_missing' }]), true);
  // 核心資源失敗 → 不可用（重試）；選配資源失敗 → 不擋上線
  assert.equal(syncUsable([{ resource: 'sleep', status: 'ok' }, { resource: 'recovery', status: 'failed' }]), false);
  assert.equal(syncUsable([{ resource: 'sleep', status: 'ok' }, { resource: 'workout', status: 'failed' }]), true);
  assert.equal(syncUsable([{ resource: 'sleep', status: 'throttled' }]), true);
  const e = await env();
  try {
    await onb(e.db, ALICE_CHAT, '/start');
    const a = await userFor(e.db, ALICE_CHAT);
    let v = await evaluateReadiness({ db: e.db, userId: a.id });
    assert.equal(v.ready, false);
    assert.deepEqual(v.missing.sort(), [
      'access_recovery_unknown', 'access_sleep_unknown',
      'capabilities', 'sync_state', 'timezone_confirmed', 'whoop_identity', 'whoop_tokens',
    ].sort());
    await onboardFully(e.db, BOB_CHAT, { whoopUserId: 'B9' });
    v = await evaluateReadiness({ db: e.db, userId: (await userFor(e.db, BOB_CHAT)).id });
    assert.deepEqual(v, { ready: true, missing: [] });
  } finally { e.done(); }
});

// ===========================================================================
// 排程器（ONB-ATTACK-19 / 20 / 24）
// ===========================================================================

test('ONB-ATTACK-19 / 20 排程器只看 READY：上線中的人不會被排程，完成後自動被發現', async () => {
  const e = await env();
  try {
    await onb(e.db, ALICE_CHAT, '/start');
    const a = await userFor(e.db, ALICE_CHAT);
    assert.deepEqual(await e.db.listSchedulableUsers({ activeStatus: USER_STATUS.ACTIVE }), [],
      '★★★ 還在上線的人不會收到日報');
    assert.equal((await e.db.listActiveUsers()).length, 1, '但他確實是 ACTIVE 使用者');
    await linked(e.db, a, 'Asia/Taipei');
    assert.deepEqual(await e.db.listSchedulableUsers({ activeStatus: USER_STATUS.ACTIVE }), []);
    const { user } = await onboardFully(e.db, BOB_CHAT, { whoopUserId: 'B2' });
    const schedulable = await e.db.listSchedulableUsers({ activeStatus: USER_STATUS.ACTIVE });
    assert.deepEqual(schedulable.map((u) => u.id), [user.id], '★ READY 之後自動被排程發現');
    assert.equal(schedulable[0].timezone, 'Asia/Taipei');
  } finally { e.done(); }
});

test('ONB-ATTACK-24 舊使用者（Kelvin）遷移：資料全留、進入重新驗證，不會假 READY', async () => {
  const e = await env();
  try {
    // 真的 v13 形狀：沒有 user_onboarding 表
    const kelvin = await e.db.createUser({ displayName: 'Kelvin', timezone: 'Asia/Taipei', now: NOW });
    await e.db.linkTelegram({ chatId: '999888', userId: kelvin.id, now: NOW });
    await e.db.saveTokens(kelvin.id, {
      accessToken: 'at', refreshToken: 'rt', expiresAt: new Date(NOW.getTime() + HOUR),
      scope: 'offline', whoopUserId: 'KELVIN1',
    });
    // 「完整設定好」的形狀：同步狀態與 capability 盤點都存在
    await e.db.saveSyncState(kelvin.id, 'sleep', { lastSuccessAt: NOW.toISOString() }, { now: NOW });
    await e.db.saveCapabilities(kelvin.id, [
      { key: 'recovery', status: 'SUPPORTED', sampleCount: 5, nonNullCount: 5 },
    ], { expectedLifecycleGeneration: (await e.db.getUser(kelvin.id)).lifecycleGeneration, now: NOW });
    await e.db.raw.execute('DROP TABLE user_onboarding');
    await e.db.raw.execute('DELETE FROM schema_version WHERE version >= 14');
    await e.db.raw.execute("INSERT OR IGNORE INTO schema_version (version, applied_at, note) VALUES (13, '2026-09-14T00:00:00.000Z', 'v13')");

    const summary = await runMigrations(e.db.raw);
    assert.equal(summary.from, 13); assert.equal(summary.to, SCHEMA_VERSION); assert.equal(SCHEMA_VERSION, 20);
    assert.deepEqual(summary.rebuilt, []);
    assert.deepEqual(summary.columnsAdded, []);
    // v14 依證據建列（Kelvin 證據齊全 → READY）；v15 的修正沒有東西要改
    // ★ R2 / LIFE-FG-10：v18 把「遷移寫下的 READY」降級成可續跑的
    // WHOOP_AUTHORIZED —— 因為執行期的 READY 述詞現在要求「目前啟用世代的
    // 資源權限判定」，而 v13 時代的資料一列都沒有。遷移**不捏造**那些判定。
    assert.deepEqual(summary.dataMigrations,
      [{ version: 14, rows: 1 }, { version: 15, rows: 0 }, { version: 16, rows: 0 },
        { version: 18, rows: 1 }, { version: 19, rows: 0 }]);

    const row = await e.db.getOnboardingRow(kelvin.id);
    assert.equal(row.state, ONBOARDING_STATE.WHOOP_AUTHORIZED,
      '★★★ 遷移不可以留下一個執行期述詞會拒絕的 READY');
    assert.equal((await e.db.getUser(kelvin.id)).status, USER_STATUS.ACTIVE);
    assert.equal((await e.db.getUser(kelvin.id)).timezone, 'Asia/Taipei');
    assert.equal((await e.db.getTokens(kelvin.id)).whoopUserId, 'KELVIN1');
    assert.equal((await e.db.getUser(kelvin.id)).lifecycleGeneration, 1, '★ 世代從 1 開始');
    assert.deepEqual(
      (await e.db.listSchedulableUsers({ activeStatus: USER_STATUS.ACTIVE })).map((u) => u.id),
      [], '★★★ 還沒重新驗證之前不可以被排程（不會發出無根據的報告）',
    );
    // ★ 但他**沒有被丟掉**：綁定、token、時區、歷史資料都在，而且
    // bootstrap 會立刻接手，在目前的啟用世代產生真實證據後自動回到 READY。
    assert.deepEqual(
      (await e.db.listOnboardingInState([ONBOARDING_STATE.WHOOP_AUTHORIZED])).map((o) => o.userId),
      [kelvin.id], '★★★ 立刻進入重新驗證佇列，不需要人工重新連接',
    );
    const boot = await runOnboardingBootstrap({
      db: e.db, userId: kelvin.id, env: {}, now: () => NOW, deps: fakeBootstrapDeps({ db: e.db }),
    });
    assert.equal(boot.result, BOOTSTRAP_RESULT.READY, '★★★ 重新驗證之後自動回到 READY');
    assert.deepEqual(
      (await e.db.listSchedulableUsers({ activeStatus: USER_STATUS.ACTIVE })).map((u) => u.id),
      [kelvin.id], '★★★ 收斂完成：Kelvin 又可以被排程了');

    assert.ok(row.timezoneConfirmedAt, '★ 完整設定好的既有使用者視為時區已確認');
    // 冪等：重跑三次不再動任何東西
    for (let i = 0; i < 3; i += 1) {
      const s2 = await runMigrations(e.db.raw);
      assert.deepEqual(s2.rebuilt, []); assert.deepEqual(s2.columnsAdded, []);
      assert.deepEqual(s2.dataMigrations, [], '★ 版本已經到了 → 資料遷移不再跑');
    }
    assert.equal((await e.db.raw.execute('SELECT COUNT(*) n FROM user_onboarding')).rows[0].n, 1);
  } finally { e.done(); }
});

test('遷移 v13 → v15：中斷後重跑補齊；全新資料庫不會憑空產生上線列', async () => {
  const e = await env();
  try {
    // 全新 DB（from = 0）：沒有使用者 → 資料遷移不做任何事
    assert.equal((await e.db.raw.execute('SELECT COUNT(*) n FROM user_onboarding')).rows[0].n, 0);
    const fresh = await runMigrations(e.db.raw);
    assert.deepEqual(fresh.dataMigrations ?? [], []);

    // 中斷：表建好了但版本沒寫進去
    const u = await e.db.createUser({ displayName: 'legacy', timezone: 'Asia/Taipei', now: NOW });
    await e.db.raw.execute('DELETE FROM user_onboarding');
    await e.db.raw.execute('DELETE FROM schema_version WHERE version >= 14');
    await e.db.raw.execute("INSERT OR IGNORE INTO schema_version (version, applied_at, note) VALUES (13, '2026-09-14T00:00:00.000Z', 'v13')");
    const s = await runMigrations(e.db.raw);
    // 這個使用者從來就不是 READY（只有帳號），所以 v18 沒有東西要降級。
    assert.deepEqual(s.dataMigrations, [{ version: 14, rows: 1 }, { version: 15, rows: 0 }, { version: 16, rows: 0 },
      { version: 18, rows: 0 }, { version: 19, rows: 0 }]);
    // 這個使用者只有帳號，沒有綁定 / token → truthful 的狀態是 STARTED，不是 READY
    assert.equal((await e.db.getOnboardingRow(u.id)).state, ONBOARDING_STATE.STARTED);
    assert.equal((await e.db.getOnboardingRow(u.id)).timezoneConfirmedAt, null);
    assert.deepEqual(await e.db.listSchedulableUsers({ activeStatus: USER_STATUS.ACTIVE }), [],
      '★ 不完整的既有使用者不會被排程');
  } finally { e.done(); }
});

// ===========================================================================
// ONB-ATTACK-18 — 未知使用者的健康查詢
// ===========================================================================

test('ONB-ATTACK-18 陌生人問「我的恢復怎樣」：拿不到任何人的資料，只得到上線指引', async () => {
  const e = await env();
  try {
    // 先讓 Kelvin 存在並且有資料
    const kelvin = await e.db.createUser({ displayName: 'Kelvin', timezone: 'Asia/Taipei', now: NOW });
    await e.db.linkTelegram({ chatId: '999888', userId: kelvin.id, now: NOW });

    const reply = await onb(e.db, ALICE_CHAT, '我的恢復怎樣');
    assert.match(reply, /\/start/);
    assert.ok(!reply.includes(kelvin.id));
    assert.ok(!/恢復分數|HRV|睡眠/.test(reply), '★★★ 沒有任何健康資訊');
    assert.equal(await countUsers(e.db), 1, '★ 非 /start 不建立身分');
    assert.equal((await e.db.raw.execute('SELECT * FROM user_telegram')).rows.length, 1);

    // 上線中的人問健康問題：只得到狀態，不執行健康處理
    await onb(e.db, ALICE_CHAT, '/start');
    const a = await userFor(e.db, ALICE_CHAT);
    const midReply = await linked(e.db, a, '我的恢復怎樣');
    assert.match(midReply, /時區/);
  } finally { e.done(); }
});

// ===========================================================================
// /start 在各狀態下的行為
// ===========================================================================

test('/start 的分支：未知 → 歡迎；時區待辦 → 提示；等授權 → 連結；同步中 → 進度；READY → 交回正常 router', async () => {
  const e = await env();
  try {
    // 未知
    assert.match(await onb(e.db, ALICE_CHAT, '/start'), /歡迎/);
    const a = await userFor(e.db, ALICE_CHAT);
    // 時區待辦
    assert.match(await linked(e.db, a, '/start'), /時區/);
    // 等授權
    await linked(e.db, a, 'Asia/Taipei');
    const authMsg = await linked(e.db, a, '/start', { now: new Date(NOW.getTime() + 60_000) });
    assert.match(authMsg, /連接你的 WHOOP|第 2 步/);
    assert.match(authMsg, /https:\/\//);
    // 同步中
    await e.db.setOnboardingState(a.id, ONBOARDING_STATE.SYNCING, { now: NOW });
    assert.match(await linked(e.db, a, '/start'), /同步中/);
    // READY → null（交給正常 router）
    await e.db.setOnboardingState(a.id, ONBOARDING_STATE.READY, { ready: true, now: NOW });
    assert.equal(await linked(e.db, a, '/start'), null, '★ READY 的人由既有的 /start 處理');
    assert.equal(await linked(e.db, a, '我今天狀態怎樣'), null, '★ 健康問題交回 router');
  } finally { e.done(); }
});

test('已經退役的綁定不會被自動重綁（交給管理者）', async () => {
  const e = await env();
  try {
    const u = await e.db.createUser({ displayName: 'old', timezone: 'Asia/Taipei', now: NOW });
    await e.db.linkTelegram({ chatId: ALICE_CHAT, userId: u.id, now: NOW });
    await e.db.revokeTelegramLink(ALICE_CHAT);
    const reply = await onb(e.db, ALICE_CHAT, '/start');
    assert.match(reply, /聯絡管理者/);
    assert.equal(await countUsers(e.db), 1, '★ 沒有建立第二個人');
  } finally { e.done(); }
});

// ===========================================================================
// HTTP 路由（公開 callback）
// ===========================================================================

function fakeRes() {
  const res = { statusCode: null, headers: null, body: '', headersSent: false };
  res.writeHead = (s, h) => { res.statusCode = s; res.headers = h; res.headersSent = true; return res; };
  res.end = (b) => { res.body = b ?? ''; };
  res.on = () => {};
  return res;
}
const call = async (handler, { method = 'GET', url }) => {
  const res = fakeRes();
  await handler({ method, url, headers: {} }, res);
  return res;
};

test('公開 callback 路由：GET 回 HTML、非 GET 405、沒有設定時 404；其他路由不受影響', async () => {
  const e = await env();
  try {
    await onb(e.db, ALICE_CHAT, '/start');
    const a = await userFor(e.db, ALICE_CHAT);
    const reply = await linked(e.db, a, 'Asia/Taipei');
    const st = stateFromUrl(/https:\/\/\S+/.exec(reply)[0]);

    const handler = createWebhookHandler({
      processUpdate: async () => ({ outcome: 'processed', updateId: 1 }),
      secret: 'shhh',
      oauthCallback: createWhoopOAuthCallback({ db: e.db, ...fakeWhoopBackend(), now: () => NOW }),
    });
    const ok = await call(handler, { url: `${OAUTH_CALLBACK_PATH}?code=good&state=${encodeURIComponent(st)}` });
    assert.equal(ok.statusCode, 200);
    assert.match(ok.headers['content-type'], /text\/html/);
    assert.equal(ok.headers['cache-control'], 'no-store');
    assert.match(ok.headers['content-security-policy'], /default-src 'none'/);
    assert.match(ok.body, /WHOOP 已連接/);
    assert.equal((await e.db.getOnboarding(a.id)).state, ONBOARDING_STATE.WHOOP_AUTHORIZED);

    const post = await call(handler, { method: 'POST', url: OAUTH_CALLBACK_PATH });
    assert.equal(post.statusCode, 405);

    const disabled = createWebhookHandler({
      processUpdate: async () => ({ outcome: 'processed', updateId: 1 }), secret: 'shhh',
    });
    const off = await call(disabled, { url: OAUTH_CALLBACK_PATH });
    assert.equal(off.statusCode, 404);
    // 既有路由仍然正常
    const health = await call(disabled, { url: '/health' });
    assert.equal(health.statusCode, 200);
    assert.match(health.headers['content-type'], /application\/json/);
    const unknown = await call(disabled, { url: '/nope' });
    assert.equal(unknown.statusCode, 404);
  } finally { e.done(); }
});

test('callback 畫面：每一種結果都有安全的 HTML，且不含祕密', () => {
  for (const key of ['ok', 'denied', 'state_invalid', 'identity', 'already_linked', 'mismatch', 'error', 'not_found']) {
    const s = renderScreen(key);
    assert.ok(s.status >= 200 && s.status < 600);
    assert.match(s.html, /<!doctype html>/);
    assert.ok(!/token|secret|state=/i.test(s.html), key);
    assert.ok(!s.html.includes('<script'), key);
  }
  assert.equal(renderScreen('nonexistent').status, 500);
});

// ===========================================================================
// 端對端模擬
// ===========================================================================

test('E2E：全新使用者從 /start 到 READY，之後健康查詢解析到自己的資料；兩人同時上線互不干擾', async () => {
  const e = await env();
  try {
    const journey = [];

    // ---- Alice ----
    journey.push(['alice', '/start', await onb(e.db, ALICE_CHAT, '/start')]);
    const a = await userFor(e.db, ALICE_CHAT);
    journey.push(['alice', 'Asia/Taipei', await linked(e.db, a, 'Asia/Taipei')]);
    const aliceAuth = /https:\/\/\S+/.exec(journey.at(-1)[2])[0];
    assert.match(aliceAuth, /^https:\/\/api\.prod\.whoop\.com/, '★ 官方 WHOOP 授權網址');
    assert.equal(new URL(aliceAuth).searchParams.get('redirect_uri'), REDIRECT, '★ 公開 HTTPS 回呼');
    assert.ok(!aliceAuth.includes(a.id), '★ 連結不含內部 user id');

    // ---- Bob 同時進行 ----
    await onb(e.db, BOB_CHAT, '/start');
    const b = await userFor(e.db, BOB_CHAT);
    const bobReply = await linked(e.db, b, 'Asia/Ho_Chi_Minh');
    const bobAuth = /https:\/\/\S+/.exec(bobReply)[0];
    assert.notEqual(stateFromUrl(aliceAuth), stateFromUrl(bobAuth));

    // ---- 兩人各自完成 OAuth ----
    const cbA = createWhoopOAuthCallback({ db: e.db, ...fakeWhoopBackend({ whoopUserId: 'W-ALICE' }), now: () => NOW });
    const cbB = createWhoopOAuthCallback({ db: e.db, ...fakeWhoopBackend({ whoopUserId: 'W-BOB' }), now: () => NOW });
    assert.equal((await cbA({ query: new URLSearchParams({ code: 'c1', state: stateFromUrl(aliceAuth) }) })).outcome, 'ok');
    assert.equal((await cbB({ query: new URLSearchParams({ code: 'c2', state: stateFromUrl(bobAuth) }) })).outcome, 'ok');

    // ---- bootstrap（排程器接手兩個人）----
    const notes = [];
    const resumed = await resumeOnboardingBootstraps({
      db: e.db, env: {}, now: () => NOW, deps: fakeBootstrapDeps({ db: e.db, notes }),
    });
    assert.equal(resumed.length, 2);
    assert.ok(resumed.every((r) => r.result === BOOTSTRAP_RESULT.READY));
    assert.equal(notes.filter((n) => n.kind === 'ready').length, 2);

    // ---- 隔離驗證 ----
    assert.equal((await e.db.getUser(a.id)).timezone, 'Asia/Taipei');
    assert.equal((await e.db.getUser(b.id)).timezone, 'Asia/Ho_Chi_Minh');
    assert.equal((await e.db.getTokens(a.id)).whoopUserId, 'W-ALICE');
    assert.equal((await e.db.getTokens(b.id)).whoopUserId, 'W-BOB');
    assert.equal(await e.db.getActiveChatIdForUser(a.id), ALICE_CHAT);
    assert.equal(await e.db.getActiveChatIdForUser(b.id), BOB_CHAT);
    assert.notDeepEqual(await e.db.getCapabilities(a.id), {});

    // ---- READY 之後：上線層放行，交給既有的 router ----
    assert.equal(await linked(e.db, a, '我今天狀態怎樣'), null);
    assert.equal(await linked(e.db, b, '/status'), null);

    // ---- 健康查詢解析到自己的資料 ----
    const { createRouter } = await import('../src/bot/router.js');
    const router = createRouter({ db: e.db, coachFor: () => null });
    // Alice 有一筆睡眠、Bob 沒有
    await e.db.upsertSleeps(a.id, [{
      id: 'sleep-alice', nap: false, score_state: 'SCORED',
      start: '2026-09-14T14:00:00.000Z', end: '2026-09-14T22:00:00.000Z',
      created_at: NOW.toISOString(), updated_at: NOW.toISOString(),
      score: { respiratory_rate: 15, stage_summary: { total_light_sleep_time_milli: 1, total_slow_wave_sleep_time_milli: 1, total_rem_sleep_time_milli: 1 } },
    }], { timezone: 'Asia/Taipei' });
    const aliceData = await e.db.getSleeps(a.id, { from: '2026-09-01', to: '2026-09-30' });
    const bobData = await e.db.getSleeps(b.id, { from: '2026-09-01', to: '2026-09-30' });
    assert.equal(aliceData.length, 1);
    assert.equal(bobData.length, 0, '★★★ Bob 看不到 Alice 的資料');
    const aliceStatus = await router.handle({ text: '/healthdata', chatId: ALICE_CHAT, user: await e.db.getUser(a.id) });
    const bobStatus = await router.handle({ text: '/healthdata', chatId: BOB_CHAT, user: await e.db.getUser(b.id) });
    assert.notEqual(aliceStatus, bobStatus);

    // ---- 排程器看得到兩個人 ----
    const schedulable = await e.db.listSchedulableUsers({ activeStatus: USER_STATUS.ACTIVE });
    assert.deepEqual(schedulable.map((u) => u.id).sort(), [a.id, b.id].sort());

    // 全程沒有任何祕密出現在回覆裡
    for (const [, , reply] of journey) {
      assert.ok(!/at-|rt-|client_secret/i.test(String(reply)));
    }
  } finally { e.done(); }
});

test('上線期間的訊息絕不含祕密；授權連結只帶 client_id / redirect_uri / state / scope', async () => {
  const e = await env();
  try {
    await onb(e.db, ALICE_CHAT, '/start');
    const a = await userFor(e.db, ALICE_CHAT);
    const reply = await linked(e.db, a, 'Asia/Taipei');
    const url = new URL(/https:\/\/\S+/.exec(reply)[0]);
    const params = [...url.searchParams.keys()].sort();
    assert.deepEqual(params, ['client_id', 'redirect_uri', 'response_type', 'scope', 'state']);
    assert.ok(!reply.includes(a.id));
    assert.ok(!/secret/i.test(reply));
    const link = await issueAuthLink({
      db: e.db, userId: a.id, clientId: CLIENT_ID, redirectUri: REDIRECT,
      now: new Date(NOW.getTime() + ONBOARDING.AUTH_LINK_COOLDOWN_MS + 1),
    });
    assert.equal(link.ok, true);
    assert.notEqual(stateFromUrl(link.authUrl), stateFromUrl(url.toString()), '★ 每次都是新的 state');
  } finally { e.done(); }
});

test('resolveOrCreateUser 併發：兩個同時進來只會有一個使用者，輸的那個不會留下可用的帳號', async () => {
  const e = await env();
  try {
    const msg = privateMessage(ALICE_CHAT, '/start');
    const [r1, r2] = await Promise.all([
      resolveOrCreateUser({ db: e.db, chatId: ALICE_CHAT, message: msg, now: NOW }),
      resolveOrCreateUser({ db: e.db, chatId: ALICE_CHAT, message: msg, now: NOW }),
    ]);
    assert.ok(r1.user && r2.user);
    const link = await e.db.getTelegramLink(ALICE_CHAT);
    assert.ok([r1.user.id, r2.user.id].includes(link.userId));
    const active = await e.db.listActiveUsers();
    assert.equal(active.length, 1, '★ 只有一個 ACTIVE 使用者');
    assert.equal(active[0].id, link.userId);
  } finally { e.done(); }
});
