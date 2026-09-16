/**
 * V1.2 Phase 3.5 — 修復週期 1（F01 … F05）。
 *
 *   F01 時區「值」與時區「已確認」是兩件事：UTC 是合法時區，不是哨兵值。
 *   F02 v13→v14 不可以把所有既有使用者一律標成 READY；狀態要由**證據**推導。
 *   F03 授權連結的限流必須自己恢復（有界的未完成數量），不可永久鎖死。
 *   F04 READY 必須在轉移的**那一刻**原子地重新驗證所有前提。
 *   F05 完全沒有可讀的核心 WHOOP 權限的人不可以 READY（沒資料 ≠ 沒權限）。
 *
 * 全部用真實 libSQL；WHOOP 與 Telegram 都是假的。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';

import { createDb } from '../src/db.js';
import {
  handleUnlinkedMessage, handleOnboardingMessage, issueAuthLink, normalizeTimezone,
} from '../src/onboarding.js';
import { createWhoopOAuthCallback } from '../src/whoopOAuthCallback.js';
import {
  runOnboardingBootstrap, resumeOnboardingBootstraps, evaluateReadiness,
  missingScopes, scopeVerdict, BOOTSTRAP_RESULT,
} from '../src/onboardingBootstrap.js';
import { runMigrations } from '../src/migrations.js';
import {
  ONBOARDING_STATE, ONBOARDING_FAILURE, USER_STATUS, SCHEMA_VERSION,
} from '../src/schema.js';
import { ONBOARDING } from '../src/config.js';
import { localDate } from '../src/time.js';

const NOW = new Date('2026-09-15T12:00:00.000Z');
const HOUR = 3_600_000;
const CLIENT_ID = 'test-client';
const REDIRECT = 'https://example.test/whoop/oauth/callback';
const A_CHAT = '111111';
const B_CHAT = '222222';
const QUOTA_WORKER = new URL('./onboarding-quota-worker.js', import.meta.url);

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whoop-onb-rc1-'));
  return { dir, url: `file:${path.join(dir, 't.db')}`, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
async function env() {
  const t = tempDir();
  const db = createDb({ url: t.url });
  await db.migrate();
  return { db, url: t.url, done: () => { try { db.close(); } catch { /* ignore */ } t.cleanup(); } };
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
const stateFromUrl = (url) => new URL(url).searchParams.get('state');
const urlIn = (reply) => /https:\/\/\S+/.exec(reply)?.[0] ?? null;

const fakeWhoopBackend = ({ whoopUserId = '900001' } = {}) => ({
  exchange: async ({ code }) => {
    if (!code || code === 'bad') throw new Error('invalid_grant');
    return {
      accessToken: `at-${whoopUserId}`, refreshToken: `rt-${whoopUserId}`,
      expiresAt: new Date(NOW.getTime() + HOUR), scope: 'offline',
    };
  },
  verifyIdentity: async () => whoopUserId,
});

/**
 * bootstrap 的注入點。
 * @param scopeMissing 這些資源會在 syncAll 回 `scope_missing`，並出現在 probe 的 scopeErrors
 * @param emptyData    端點成功但沒有資料（READY 的正常起點）
 */
function fakeBootstrapDeps({
  db, scopeMissing = [], emptyData = false, notes = [], syncStatus = 'ok', probeFails = false,
} = {}) {
  const resources = ['sleep', 'recovery', 'cycle', 'workout', 'body_measurement'];
  return {
    makeWhoop: () => ({ tag: 'fake' }),
    makeSync: ({ userId }) => ({
      syncAll: async () => {
        for (const r of resources) {
          if (scopeMissing.includes(r)) continue;
          await db.saveSyncState(userId, r, { lastSuccessAt: NOW.toISOString() }, { now: NOW });
        }
        return resources.map((resource) => ({
          resource,
          status: scopeMissing.includes(resource) ? 'scope_missing' : syncStatus,
          ...(emptyData ? { fetched: 0, written: 0 } : {}),
        }));
      },
    }),
    probe: async ({ userId }) => {
      if (probeFails) throw new Error('probe boom');
      const entries = resources.filter((r) => !scopeMissing.includes(r)).map((r) => ({
        key: r === 'sleep' ? 'sleep_total' : r, status: emptyData ? 'UNKNOWN' : 'SUPPORTED',
        sampleCount: emptyData ? 0 : 5, nonNullCount: emptyData ? 0 : 5,
      }));
      for (const r of scopeMissing) entries.push({ key: r, status: 'UNAUTHORIZED', sampleCount: 0, nonNullCount: 0 });
      await db.saveCapabilities(userId, entries, { now: NOW });
      return { entries, scopeErrors: scopeMissing.map((resource) => ({ resource })) };
    },
    notify: async (userId, kind) => { notes.push({ userId, kind }); },
  };
}

/** 走到「已授權、等 bootstrap」為止。 */
async function authorize(db, chatId, { timezone = 'Asia/Taipei', whoopUserId = '900001' } = {}) {
  await onb(db, chatId, '/start');
  const user = await userFor(db, chatId);
  const reply = await linked(db, user, timezone);
  const cb = createWhoopOAuthCallback({ db, ...fakeWhoopBackend({ whoopUserId }), now: () => NOW });
  const res = await cb({ query: new URLSearchParams({ code: 'good', state: stateFromUrl(urlIn(reply)) }) });
  assert.equal(res.outcome, 'ok');
  return await db.getUser(user.id);
}

/** 完整走到 READY。 */
async function onboardFully(db, chatId, opts = {}) {
  const user = await authorize(db, chatId, opts);
  const notes = [];
  const boot = await runOnboardingBootstrap({
    db, userId: user.id, env: {}, now: () => NOW, deps: fakeBootstrapDeps({ db, notes, ...opts }),
  });
  return { user: await db.getUser(user.id), boot, notes };
}

// ===========================================================================
// F01 — 時區「值」vs 時區「已確認」
// ===========================================================================

test('RC1-ATTACK-01 / F01-A 使用者明確選 UTC → 可以一路走到 READY', async () => {
  const e = await env();
  try {
    const { user, boot } = await onboardFully(e.db, A_CHAT, { timezone: 'UTC' });
    assert.equal(boot.result, BOOTSTRAP_RESULT.READY, JSON.stringify(boot));
    assert.equal(user.timezone, 'UTC', '★ UTC 是一個合法時區');
    assert.equal(await stateOf(e.db, user.id), ONBOARDING_STATE.READY);
    const row = await e.db.getOnboardingRow(user.id);
    assert.ok(row.timezoneConfirmedAt, '★★★ 確認是明確記錄下來的證據');
    const sched = await e.db.listSchedulableUsers({ activeStatus: USER_STATUS.ACTIVE });
    assert.deepEqual(sched.map((u) => u.id), [user.id], '★ UTC 使用者可被排程');
  } finally { e.done(); }
});

test('RC1-ATTACK-02 / F01-B 預設 UTC 但從未確認 → 不可能 READY', async () => {
  const e = await env();
  try {
    await onb(e.db, A_CHAT, '/start');
    const user = await userFor(e.db, A_CHAT);
    assert.equal(user.timezone, 'UTC', '新使用者的欄位預設就是 UTC');
    const row = await e.db.getOnboardingRow(user.id);
    assert.equal(row.timezoneConfirmedAt, null, '★ 但沒有確認證據');
    const v = await evaluateReadiness({ db: e.db, userId: user.id });
    assert.ok(v.missing.includes('timezone_confirmed'));
    // 即使把其他前提全部補齊，原子轉移仍然拒絕
    await e.db.saveTokens(user.id, {
      accessToken: 'at', refreshToken: 'rt', expiresAt: new Date(NOW.getTime() + HOUR),
      scope: 'offline', whoopUserId: 'W1',
    });
    await e.db.saveSyncState(user.id, 'sleep', { lastSuccessAt: NOW.toISOString() }, { now: NOW });
    await e.db.saveCapabilities(user.id, [{ key: 'recovery', status: 'SUPPORTED', sampleCount: 5, nonNullCount: 5 }], { now: NOW });
    await e.db.setOnboardingState(user.id, ONBOARDING_STATE.SYNCING, { now: NOW });
    const ready = await e.db.setReadyIfEligible({ userId: user.id, now: NOW });
    assert.equal(ready.ok, false, '★★★ 沒有時區確認就不可能 READY');
    assert.notEqual(await stateOf(e.db, user.id), ONBOARDING_STATE.READY);
  } finally { e.done(); }
});

test('F01-C/D/E 確認 Asia/Taipei 通過；不合法的輸入不寫入也不確認；確認後重啟仍在', async () => {
  const e = await env();
  try {
    await onb(e.db, A_CHAT, '/start');
    const user = await userFor(e.db, A_CHAT);
    // D：不合法
    await linked(e.db, user, '+08:00');
    assert.equal((await e.db.getOnboardingRow(user.id)).timezoneConfirmedAt, null);
    assert.equal((await e.db.getUser(user.id)).timezone, 'UTC');
    // C：合法
    await linked(e.db, user, 'Asia/Taipei');
    const row = await e.db.getOnboardingRow(user.id);
    assert.ok(row.timezoneConfirmedAt);
    assert.equal((await e.db.getUser(user.id)).timezone, 'Asia/Taipei');
    const v = await evaluateReadiness({ db: e.db, userId: user.id });
    assert.ok(!v.missing.includes('timezone_confirmed'), '★ 時區前提已滿足');
    e.db.close();
    // E：重啟後確認證據仍在
    const db2 = createDb({ url: e.url });
    assert.ok((await db2.getOnboardingRow(user.id)).timezoneConfirmedAt, '★ 耐久');
    db2.close();
  } finally { e.done(); }
});

test('RC1-ATTACK-13 / F01-F 台灣 / 越南 / UTC 三人同時上線：時區與跨日邊界各自正確', async () => {
  const e = await env();
  try {
    const a = await onboardFully(e.db, A_CHAT, { timezone: 'Asia/Taipei', whoopUserId: 'WA' });
    const b = await onboardFully(e.db, B_CHAT, { timezone: 'Asia/Ho_Chi_Minh', whoopUserId: 'WB' });
    const c = await onboardFully(e.db, '333333', { timezone: 'UTC', whoopUserId: 'WC' });
    assert.equal(a.user.timezone, 'Asia/Taipei');
    assert.equal(b.user.timezone, 'Asia/Ho_Chi_Minh');
    assert.equal(c.user.timezone, 'UTC');
    const t = new Date('2026-09-15T16:30:00.000Z');
    assert.equal(localDate(t, a.user.timezone), '2026-09-16');
    assert.equal(localDate(t, b.user.timezone), '2026-09-15');
    assert.equal(localDate(t, c.user.timezone), '2026-09-15');
    // 三個獨立的 WHOOP 身分與排程資格
    const sched = await e.db.listSchedulableUsers({ activeStatus: USER_STATUS.ACTIVE });
    assert.equal(sched.length, 3);
    assert.equal((await e.db.getTokens(a.user.id)).whoopUserId, 'WA');
    assert.equal((await e.db.getTokens(b.user.id)).whoopUserId, 'WB');
  } finally { e.done(); }
});

// ===========================================================================
// F02 — 既有使用者的遷移必須是真的
// ===========================================================================

/** 建一個 v13 形狀的資料庫並塞入各種既有使用者，再遷移。 */
async function migrateLegacy(db, seed) {
  await seed(db);
  await db.raw.execute('DROP TABLE user_onboarding');
  await db.raw.execute('DELETE FROM schema_version WHERE version >= 14');
  await db.raw.execute("INSERT OR IGNORE INTO schema_version (version, applied_at, note) VALUES (13, '2026-09-14T00:00:00.000Z', 'v13')");
  return runMigrations(db.raw);
}
const fullyConfigured = async (db, { id, chatId, whoopUserId, status = USER_STATUS.ACTIVE, tz = 'Asia/Taipei' }) => {
  const u = await db.createUser({ id, displayName: id, timezone: tz, status, now: NOW });
  await db.linkTelegram({ chatId, userId: u.id, now: NOW });
  await db.saveTokens(u.id, {
    accessToken: 'at', refreshToken: 'rt', expiresAt: new Date(NOW.getTime() + HOUR),
    scope: 'offline', whoopUserId,
  });
  await db.saveSyncState(u.id, 'sleep', { lastSuccessAt: NOW.toISOString() }, { now: NOW });
  await db.saveCapabilities(u.id, [{ key: 'recovery', status: 'SUPPORTED', sampleCount: 5, nonNullCount: 5 }], { now: NOW });
  return u;
};

test('RC1-ATTACK-03 / RC1-ATTACK-04 / RC1-ATTACK-14 遷移矩陣：每一種既有使用者都得到**真實**的狀態', async () => {
  const e = await env();
  try {
    const summary = await migrateLegacy(e.db, async (db) => {
      // A：完整設定好（Kelvin 形狀）
      await fullyConfigured(db, { id: 'legacy-a', chatId: '900001', whoopUserId: 'WA' });
      // B：ACTIVE + 時區，但沒有 Telegram 綁定
      await db.createUser({ id: 'legacy-b', displayName: 'b', timezone: 'Asia/Taipei', now: NOW });
      // C：ACTIVE + Telegram，但沒有 WHOOP token / 身分
      const c = await db.createUser({ id: 'legacy-c', displayName: 'c', timezone: 'Asia/Taipei', now: NOW });
      await db.linkTelegram({ chatId: '900003', userId: c.id, now: NOW });
      // D：DISABLED（其餘完整）
      await fullyConfigured(db, { id: 'legacy-d', chatId: '900004', whoopUserId: 'WD', status: USER_STATUS.DISABLED });
      // E：綁好 WHOOP，但沒有 capability 證據
      const ee = await db.createUser({ id: 'legacy-e', displayName: 'e', timezone: 'Asia/Taipei', now: NOW });
      await db.linkTelegram({ chatId: '900005', userId: ee.id, now: NOW });
      await db.saveTokens(ee.id, {
        accessToken: 'at', refreshToken: 'rt', expiresAt: new Date(NOW.getTime() + HOUR),
        scope: 'offline', whoopUserId: 'WE',
      });
      await db.saveSyncState(ee.id, 'sleep', { lastSuccessAt: NOW.toISOString() }, { now: NOW });
      // F：token 已過期但 refresh 仍然可用（正常情況，不該被判定不可用）
      const f = await fullyConfigured(db, { id: 'legacy-f', chatId: '900006', whoopUserId: 'WF' });
      await db.saveTokens(f.id, {
        accessToken: 'at-old', refreshToken: 'rt-good', expiresAt: new Date(NOW.getTime() - HOUR),
        scope: 'offline', whoopUserId: 'WF',
      });
    });

    assert.equal(summary.from, 13);
    assert.equal(summary.to, SCHEMA_VERSION);
    assert.deepEqual(summary.rebuilt, []);
    assert.deepEqual(summary.dataMigrations, [{ version: 14, rows: 6 }, { version: 15, rows: 0 }]);

    const state = async (id) => (await e.db.getOnboardingRow(id)).state;
    assert.equal(await state('legacy-a'), ONBOARDING_STATE.READY, 'A 完整 → READY');
    assert.equal(await state('legacy-b'), ONBOARDING_STATE.STARTED, 'B 沒有綁定 → 自助流程還沒開始');
    assert.equal(await state('legacy-c'), ONBOARDING_STATE.TIMEZONE_PENDING, 'C 沒有 WHOOP → 從第一步重走');
    assert.equal(await state('legacy-d'), ONBOARDING_STATE.ACTION_REQUIRED, 'D 停用 → 要管理者處理');
    assert.equal((await e.db.getOnboardingRow('legacy-d')).failureCode, ONBOARDING_FAILURE.ACCOUNT_INACTIVE);
    assert.equal(await state('legacy-e'), ONBOARDING_STATE.SYNCING, 'E 缺 capability → 可續作');
    assert.equal(await state('legacy-f'), ONBOARDING_STATE.READY, 'F token 過期但可 refresh → 仍然正常');

    // 只有真的完整的人可以被排程
    const sched = await e.db.listSchedulableUsers({ activeStatus: USER_STATUS.ACTIVE });
    assert.deepEqual(sched.map((u) => u.id).sort(), ['legacy-a', 'legacy-f'],
      '★★★ 不完整的既有使用者一個都不會被排程');

    // 時區確認證據只給「有驗證過的 WHOOP 身分」的人
    assert.ok((await e.db.getOnboardingRow('legacy-a')).timezoneConfirmedAt);
    assert.equal((await e.db.getOnboardingRow('legacy-b')).timezoneConfirmedAt, null);
    assert.equal((await e.db.getOnboardingRow('legacy-c')).timezoneConfirmedAt, null);

    // 冪等
    for (let i = 0; i < 3; i += 1) {
      const s2 = await runMigrations(e.db.raw);
      assert.deepEqual(s2.dataMigrations, []);
    }
    assert.equal(await state('legacy-a'), ONBOARDING_STATE.READY);
  } finally { e.done(); }
});

test('F02 v15 修正：v14 第一版盲目寫下的 READY 會被改回真實狀態（只動證據不足的列）', async () => {
  const e = await env();
  try {
    await fullyConfigured(e.db, { id: 'good', chatId: '900001', whoopUserId: 'WG' });
    await e.db.createUser({ id: 'bare', displayName: 'bare', timezone: 'Asia/Taipei', now: NOW });
    // 模擬「已經被 v14 第一版遷移過」的資料庫：兩個人都被寫成 READY
    await e.db.raw.execute('DELETE FROM user_onboarding');
    for (const id of ['good', 'bare']) {
      await e.db.raw.execute({
        sql: `INSERT INTO user_onboarding (user_id, state, timezone_confirmed_at, ready_at,
                state_changed_at, created_at, updated_at) VALUES (?, 'READY', ?, ?, ?, ?, ?)`,
        args: [id, NOW.toISOString(), NOW.toISOString(), NOW.toISOString(), NOW.toISOString(), NOW.toISOString()],
      });
    }
    await e.db.raw.execute('DELETE FROM schema_version WHERE version >= 15');
    await e.db.raw.execute("INSERT OR IGNORE INTO schema_version (version, applied_at, note) VALUES (14, '2026-09-15T00:00:00.000Z', 'v14')");

    const s = await runMigrations(e.db.raw);
    assert.equal(s.from, 14); assert.equal(s.to, 15);
    assert.deepEqual(s.dataMigrations, [{ version: 15, rows: 1 }], '★ 只有一列需要修正');
    assert.equal((await e.db.getOnboardingRow('good')).state, ONBOARDING_STATE.READY, '★ 證據齊全的不動');
    assert.equal((await e.db.getOnboardingRow('bare')).state, ONBOARDING_STATE.STARTED, '★★★ 假的 READY 被改正');
    assert.equal((await e.db.getOnboardingRow('bare')).readyAt, null);
    assert.equal((await e.db.getOnboardingRow('bare')).timezoneConfirmedAt, null);
    const sched = await e.db.listSchedulableUsers({ activeStatus: USER_STATUS.ACTIVE });
    assert.deepEqual(sched.map((u) => u.id), ['good']);
    // 冪等
    assert.deepEqual((await runMigrations(e.db.raw)).dataMigrations, []);
  } finally { e.done(); }
});

test('RC1-ATTACK-15 遷移之後才被建立的 ACTIVE 使用者：沒有上線列 → 不可被排程、不可繞過狀態機', async () => {
  const e = await env();
  try {
    // 直接用 CLI 的方式建一個使用者（不經過自助流程）
    const u = await e.db.createUser({ id: 'cli-user', displayName: 'cli', timezone: 'Asia/Taipei', now: NOW });
    await e.db.linkTelegram({ chatId: A_CHAT, userId: u.id, now: NOW });
    assert.equal(await e.db.getOnboardingRow(u.id), null, '沒有上線列');
    assert.deepEqual(await e.db.listSchedulableUsers({ activeStatus: USER_STATUS.ACTIVE }), [],
      '★★★ 沒有上線列 ≠ READY：不會被排程');
    // 讀取時依證據推導（沒有 token → 從時區那一步開始），不是 READY
    assert.equal(await stateOf(e.db, u.id), ONBOARDING_STATE.TIMEZONE_PENDING);
    // /start 會補一列，同樣是推導出來的
    const reply = await onb(e.db, A_CHAT, '/start');
    assert.match(reply, /時區/);
    assert.equal((await e.db.getOnboardingRow(u.id)).state, ONBOARDING_STATE.TIMEZONE_PENDING);
    assert.deepEqual(await e.db.listSchedulableUsers({ activeStatus: USER_STATUS.ACTIVE }), []);
  } finally { e.done(); }
});

test('排程資格：逐一列出每個上線狀態的可排程性', async () => {
  const e = await env();
  try {
    const ids = [];
    for (const [i, state] of Object.values(ONBOARDING_STATE).entries()) {
      const u = await fullyConfigured(e.db, { id: `u-${state}`, chatId: `80000${i}`, whoopUserId: `W${i}` });
      // 先依證據建列（production 的 /start 與遷移都走這條），再指定要測的狀態。
      // setOnboardingState 是 UPDATE：沒有列就什麼都不會發生 —— 這本身就是
      // F02 的不變量（沒有列 ≠ READY）。
      await e.db.ensureOnboardingDerived(u.id, { now: NOW });
      await e.db.setOnboardingState(u.id, state, { now: NOW });
      assert.equal((await e.db.getOnboardingRow(u.id)).state, state);
      ids.push([state, u.id]);
    }
    const sched = (await e.db.listSchedulableUsers({ activeStatus: USER_STATUS.ACTIVE })).map((u) => u.id);
    for (const [state, id] of ids) {
      const expected = state === ONBOARDING_STATE.READY;
      assert.equal(sched.includes(id), expected, `${state} → ${expected ? '可排程' : '不可排程'}`);
    }
    // DISABLED 使用者即使 READY 也不排程
    const d = await fullyConfigured(e.db, { id: 'u-disabled', chatId: '899999', whoopUserId: 'WD9' });
    await e.db.ensureOnboardingDerived(d.id, { now: NOW });
    await e.db.setOnboardingState(d.id, ONBOARDING_STATE.READY, { ready: true, now: NOW });
    await e.db.updateUser(d.id, { status: USER_STATUS.DISABLED }, { now: NOW });
    const sched2 = (await e.db.listSchedulableUsers({ activeStatus: USER_STATUS.ACTIVE })).map((u) => u.id);
    assert.ok(!sched2.includes(d.id), 'DISABLED → 不可排程');
    // bootstrap 的接手清單仍看得到 WHOOP_AUTHORIZED / SYNCING
    const pending = await e.db.listOnboardingInState(
      [ONBOARDING_STATE.WHOOP_AUTHORIZED, ONBOARDING_STATE.SYNCING], { limit: 50 },
    );
    assert.equal(pending.length, 2, '★ bootstrap resume 仍看得到這兩個狀態');
  } finally { e.done(); }
});

// ===========================================================================
// F03 — 授權連結限流會自己恢復
// ===========================================================================

test('RC1-ATTACK-05 / F03-A,B,C 連發到上限 → 立刻被拒；等舊連結過期 → 可以再拿新的（不會永久鎖死）', async () => {
  const e = await env();
  try {
    await onb(e.db, A_CHAT, '/start');
    const user = await userFor(e.db, A_CHAT);
    await linked(e.db, user, 'Asia/Taipei');   // 第 1 條
    let t = NOW.getTime();
    let issued = 1;
    for (let i = 0; i < 12; i += 1) {
      t += ONBOARDING.AUTH_LINK_COOLDOWN_MS + 1;
      const r = await linked(e.db, user, '/connect', { now: new Date(t) });
      if (urlIn(r)) issued += 1;
    }
    assert.equal(issued, ONBOARDING.MAX_OUTSTANDING_AUTH_LINKS, '★ 同時有效的連結數有上限');
    const blocked = await linked(e.db, user, '/connect', { now: new Date(t + ONBOARDING.AUTH_LINK_COOLDOWN_MS + 1) });
    assert.match(blocked, /太多次/, 'F03-A：立刻再要 → 被拒');

    // F03-B/C：所有舊 state 過期之後
    const after = new Date(t + ONBOARDING.OAUTH_STATE_TTL_MS + 1000);
    const recovered = await linked(e.db, user, '/connect', { now: after });
    assert.ok(urlIn(recovered), '★★★ 過期之後可以再拿到新連結（沒有永久鎖死）');
    assert.equal(await stateOf(e.db, user.id), ONBOARDING_STATE.WHOOP_AUTH_PENDING);
  } finally { e.done(); }
});

test('F03-D/E 授權成功會消耗掉一條；失敗燒掉的 state 也不再計入，之後仍可取得新連結', async () => {
  const e = await env();
  try {
    await onb(e.db, A_CHAT, '/start');
    const user = await userFor(e.db, A_CHAT);
    const first = await linked(e.db, user, 'Asia/Taipei');
    let t = NOW.getTime();
    // 用掉配額
    for (let i = 0; i < ONBOARDING.MAX_OUTSTANDING_AUTH_LINKS; i += 1) {
      t += ONBOARDING.AUTH_LINK_COOLDOWN_MS + 1;
      await linked(e.db, user, '/connect', { now: new Date(t) });
    }
    t += ONBOARDING.AUTH_LINK_COOLDOWN_MS + 1;
    assert.match(await linked(e.db, user, '/connect', { now: new Date(t) }), /太多次/);

    // F03-E：一條 state 因為 token 交換失敗被燒掉 → 未完成數量 -1 → 可以再拿
    const cb = createWhoopOAuthCallback({ db: e.db, ...fakeWhoopBackend(), now: () => new Date(t) });
    const failed = await cb({ query: new URLSearchParams({ code: 'bad', state: stateFromUrl(urlIn(first)) }) });
    assert.equal(failed.outcome, 'failed');
    t += ONBOARDING.AUTH_LINK_COOLDOWN_MS + 1;
    const again = await linked(e.db, user, '/connect', { now: new Date(t) });
    assert.ok(urlIn(again), '★ 燒掉的 state 不再佔用配額');

    // F03-D：授權成功之後仍然可以重新連接（不被上一輪卡死）
    const ok = await cb({ query: new URLSearchParams({ code: 'good', state: stateFromUrl(urlIn(again)) }) });
    assert.equal(ok.outcome, 'ok');
    const outstanding = await e.db.raw.execute({
      sql: 'SELECT COUNT(*) n FROM oauth_states WHERE user_id = ? AND consumed_at IS NULL AND expires_at > ?',
      args: [user.id, new Date(t).toISOString()],
    });
    assert.ok(Number(outstanding.rows[0].n) < ONBOARDING.MAX_OUTSTANDING_AUTH_LINKS);
  } finally { e.done(); }
});

test('RC1-ATTACK-06 / F03-F 真併發：另一條執行緒同時狂發 /connect，總量仍不超過上限', async () => {
  const e = await env();
  try {
    await onb(e.db, A_CHAT, '/start');
    const user = await userFor(e.db, A_CHAT);
    await linked(e.db, user, 'Asia/Taipei');   // 1 條
    const limit = ONBOARDING.MAX_OUTSTANDING_AUTH_LINKS;

    // 兩邊各嘗試 11 次（不同連線、真的併發），全部略過冷卻（直接呼叫 store）
    const worker = new Worker(QUOTA_WORKER);
    const done = new Promise((resolve, reject) => {
      worker.on('message', (m) => { if (m.type === 'done') resolve(m); });
      worker.on('error', reject);
    });
    worker.postMessage({
      type: 'go', url: e.url, userId: user.id, attempts: 11, limit,
      ttlMs: ONBOARDING.OAUTH_STATE_TTL_MS, nowMs: NOW.getTime(),
    });
    let mine = 0;
    for (let i = 0; i < 11; i += 1) {
      const r = await e.db.createOAuthState(user.id, {
        ttlMs: ONBOARDING.OAUTH_STATE_TTL_MS, now: NOW, maxOutstanding: limit,
      });
      if (r.ok) mine += 1;
    }
    const w = await done;
    await worker.terminate();
    assert.equal(w.ok, true, w.error);

    const outstanding = Number((await e.db.raw.execute({
      sql: 'SELECT COUNT(*) n FROM oauth_states WHERE user_id = ? AND consumed_at IS NULL AND expires_at > ?',
      args: [user.id, NOW.toISOString()],
    })).rows[0].n);
    assert.equal(outstanding, limit, `★★★ 22 次併發嘗試之後仍然恰好 ${limit} 條有效（我方 ${mine} / worker ${w.issued}）`);
    assert.equal(mine + w.issued, limit - 1, '兩邊成功的次數加起來等於剩餘配額');
  } finally { e.done(); }
});

// ===========================================================================
// F04 — READY 轉移必須原子地重新驗證
// ===========================================================================

test('RC1-ATTACK-07 / F04-A 讀完前提之後綁定被退役 → READY 被拒', async () => {
  const e = await env();
  try {
    const user = await authorize(e.db, A_CHAT);
    const deps = fakeBootstrapDeps({ db: e.db });
    // 在 capability 盤點之後、READY 轉移之前把綁定退役
    const hooked = {
      ...deps,
      probe: async (args) => {
        const r = await deps.probe(args);
        await e.db.revokeTelegramLink(A_CHAT);
        return r;
      },
    };
    const boot = await runOnboardingBootstrap({ db: e.db, userId: user.id, env: {}, now: () => NOW, deps: hooked });
    assert.notEqual(boot.result, BOOTSTRAP_RESULT.READY, '★★★ 不可以 READY');
    assert.notEqual(await stateOf(e.db, user.id), ONBOARDING_STATE.READY);
    const ready = await e.db.setReadyIfEligible({ userId: user.id, now: NOW });
    assert.equal(ready.ok, false);
    assert.deepEqual(await e.db.listSchedulableUsers({ activeStatus: USER_STATUS.ACTIVE }), []);
  } finally { e.done(); }
});

test('F04-B/C/D token、WHOOP 身分、capability 在轉移前消失 → 一律拒絕 READY', async () => {
  const cases = [
    ['token 被撤銷', async (db, uid) => { await db.raw.execute({ sql: 'DELETE FROM user_whoop_tokens WHERE user_id = ?', args: [uid] }); }],
    ['WHOOP 身分被清掉', async (db, uid) => { await db.raw.execute({ sql: 'UPDATE user_whoop_tokens SET whoop_user_id = NULL WHERE user_id = ?', args: [uid] }); }],
    ['capability 被清掉', async (db, uid) => { await db.raw.execute({ sql: 'DELETE FROM whoop_capabilities WHERE user_id = ?', args: [uid] }); }],
    ['帳號被停用', async (db, uid) => { await db.updateUser(uid, { status: USER_STATUS.DISABLED }, { now: NOW }); }],
  ];
  for (const [label, sabotage] of cases) {
    const e = await env();
    try {
      const user = await authorize(e.db, A_CHAT);
      const deps = fakeBootstrapDeps({ db: e.db });
      const hooked = {
        ...deps,
        probe: async (args) => { const r = await deps.probe(args); await sabotage(e.db, user.id); return r; },
      };
      const boot = await runOnboardingBootstrap({ db: e.db, userId: user.id, env: {}, now: () => NOW, deps: hooked });
      assert.notEqual(boot.result, BOOTSTRAP_RESULT.READY, label);
      assert.notEqual(await stateOf(e.db, user.id), ONBOARDING_STATE.READY, label);
    } finally { e.done(); }
  }
});

test('RC1-ATTACK-08 / F04-E 期間狀態被改成 ACTION_REQUIRED → 過期的 bootstrap 不可覆蓋成 READY', async () => {
  const e = await env();
  try {
    const user = await authorize(e.db, A_CHAT);
    const deps = fakeBootstrapDeps({ db: e.db });
    const hooked = {
      ...deps,
      probe: async (args) => {
        const r = await deps.probe(args);
        // 管理者/使用者在這期間讓狀態變成需要處理
        await e.db.setOnboardingState(user.id, ONBOARDING_STATE.ACTION_REQUIRED, {
          failureCode: ONBOARDING_FAILURE.REAUTH_REQUIRED, now: NOW,
        });
        return r;
      },
    };
    const boot = await runOnboardingBootstrap({ db: e.db, userId: user.id, env: {}, now: () => NOW, deps: hooked });
    assert.notEqual(boot.result, BOOTSTRAP_RESULT.READY);
    const row = await e.db.getOnboardingRow(user.id);
    assert.equal(row.state, ONBOARDING_STATE.ACTION_REQUIRED, '★★★ 較新的狀態沒有被覆蓋');
    assert.equal(row.failureCode, ONBOARDING_FAILURE.REAUTH_REQUIRED);
    // 直接呼叫也一樣：來源狀態不在允許清單裡
    const ready = await e.db.setReadyIfEligible({ userId: user.id, now: NOW });
    assert.equal(ready.ok, false);
    assert.match(ready.reason, /ACTION_REQUIRED/);
  } finally { e.done(); }
});

test('F04-F 前提全部成立 → READY 成功，而且只走允許的來源狀態', async () => {
  const e = await env();
  try {
    const { boot, user } = await onboardFully(e.db, A_CHAT);
    assert.equal(boot.result, BOOTSTRAP_RESULT.READY);
    assert.equal(await stateOf(e.db, user.id), ONBOARDING_STATE.READY);
    // READY 之後再呼叫一次 → 來源狀態不符（已經是 READY）→ 不重複寫
    const again = await e.db.setReadyIfEligible({ userId: user.id, now: NOW });
    assert.equal(again.ok, false);
    assert.equal(await stateOf(e.db, user.id), ONBOARDING_STATE.READY);
    // STARTED 也不是合法來源
    await e.db.setOnboardingState(user.id, ONBOARDING_STATE.STARTED, { now: NOW });
    assert.equal((await e.db.setReadyIfEligible({ userId: user.id, now: NOW })).ok, false);
  } finally { e.done(); }
});

// ===========================================================================
// F05 — 最低 WHOOP 權限（沒資料 ≠ 沒權限）
// ===========================================================================

test('F05 政策本身：必要 scope 是 sleep + recovery；scope_missing 與 scopeErrors 都算', () => {
  assert.deepEqual(ONBOARDING.REQUIRED_SCOPES, ['sleep', 'recovery']);
  assert.deepEqual(missingScopes({
    syncResults: [{ resource: 'sleep', status: 'scope_missing' }, { resource: 'cycle', status: 'ok' }],
    scopeErrors: [{ resource: 'workout' }],
  }), ['sleep', 'workout']);
  // 一般失敗**不算**沒有權限
  assert.deepEqual(missingScopes({ syncResults: [{ resource: 'sleep', status: 'failed' }] }), []);
  assert.deepEqual(scopeVerdict([]), { ok: true, lacking: [] });
  assert.deepEqual(scopeVerdict(['workout', 'cycle']), { ok: true, lacking: [] });
  assert.deepEqual(scopeVerdict(['sleep']), { ok: false, lacking: ['sleep'] });
  assert.deepEqual(scopeVerdict(['sleep', 'recovery', 'cycle', 'workout', 'body_measurement']),
    { ok: false, lacking: ['sleep', 'recovery'] });
});

test('RC1-ATTACK-09 / F05-B 所有健康 scope 都缺 → ACTION_REQUIRED，不是 READY', async () => {
  const e = await env();
  try {
    const user = await authorize(e.db, A_CHAT);
    const notes = [];
    const boot = await runOnboardingBootstrap({
      db: e.db, userId: user.id, env: {}, now: () => NOW,
      deps: fakeBootstrapDeps({
        db: e.db, notes,
        scopeMissing: ['sleep', 'recovery', 'cycle', 'workout', 'body_measurement'],
      }),
    });
    assert.equal(boot.result, BOOTSTRAP_RESULT.ACTION_REQUIRED);
    assert.deepEqual(boot.lacking, ['sleep', 'recovery']);
    const row = await e.db.getOnboardingRow(user.id);
    assert.equal(row.state, ONBOARDING_STATE.ACTION_REQUIRED);
    assert.equal(row.failureCode, ONBOARDING_FAILURE.WHOOP_SCOPE_INCOMPLETE);
    assert.deepEqual(await e.db.listSchedulableUsers({ activeStatus: USER_STATUS.ACTIVE }), []);
    assert.ok(notes.some((n) => n.kind === 'scope_incomplete'));
    // 使用者看得到可行動的訊息
    const msg = await linked(e.db, await e.db.getUser(user.id), '/start',
      { now: new Date(NOW.getTime() + ONBOARDING.AUTH_LINK_COOLDOWN_MS + 1) });
    assert.match(msg, /權限不完整/);
    assert.match(msg, /https:\/\//, '★ 同時給一條新的授權連結');
  } finally { e.done(); }
});

test('RC1-ATTACK-10 / F05-A 核心 scope 都在、但完全沒有資料 → 允許 READY', async () => {
  const e = await env();
  try {
    const { boot, user } = await onboardFully(e.db, A_CHAT, { emptyData: true });
    assert.equal(boot.result, BOOTSTRAP_RESULT.READY, '★★★ 沒有資料不等於沒有權限');
    assert.equal(await stateOf(e.db, user.id), ONBOARDING_STATE.READY);
    const caps = await e.db.getCapabilities(user.id);
    assert.ok(Object.keys(caps).length > 0);
    assert.ok(Object.values(caps).every((c) => c.status !== 'UNAUTHORIZED'));
  } finally { e.done(); }
});

test('RC1-ATTACK-11 / F05-D 只缺選配 scope（workout / body_measurement / cycle）→ 仍然 READY', async () => {
  const e = await env();
  try {
    const { boot, user } = await onboardFully(e.db, A_CHAT, {
      scopeMissing: ['workout', 'body_measurement', 'cycle'],
    });
    assert.equal(boot.result, BOOTSTRAP_RESULT.READY);
    assert.equal(await stateOf(e.db, user.id), ONBOARDING_STATE.READY);
    const caps = await e.db.getCapabilities(user.id);
    assert.equal(caps.workout.status, 'UNAUTHORIZED', '★ 缺的權限誠實記錄下來');
  } finally { e.done(); }
});

test('F05-C 只缺一個核心 scope（recovery）→ ACTION_REQUIRED', async () => {
  const e = await env();
  try {
    const user = await authorize(e.db, A_CHAT);
    const boot = await runOnboardingBootstrap({
      db: e.db, userId: user.id, env: {}, now: () => NOW,
      deps: fakeBootstrapDeps({ db: e.db, scopeMissing: ['recovery'] }),
    });
    assert.equal(boot.result, BOOTSTRAP_RESULT.ACTION_REQUIRED);
    assert.deepEqual(boot.lacking, ['recovery']);
  } finally { e.done(); }
});

test('RC1-ATTACK-12 / F05-E,F 暫時性故障不會變成永久「沒有權限」；重新授權後可恢復 READY', async () => {
  const e = await env();
  try {
    const user = await authorize(e.db, A_CHAT);
    // E：429/500/timeout 這類失敗 → 重試，不是 ACTION_REQUIRED，也不寫 capability 結論
    const transient = await runOnboardingBootstrap({
      db: e.db, userId: user.id, env: {}, now: () => NOW,
      deps: fakeBootstrapDeps({ db: e.db, syncStatus: 'failed' }),
    });
    assert.equal(transient.result, BOOTSTRAP_RESULT.RETRY);
    assert.equal(await stateOf(e.db, user.id), ONBOARDING_STATE.SYNCING, '★ 仍可續作');
    assert.deepEqual(await e.db.getCapabilities(user.id), {}, '★★★ 沒有寫下任何「不支援」的結論');

    // 缺核心 scope → ACTION_REQUIRED
    const missing = await runOnboardingBootstrap({
      db: e.db, userId: user.id, env: {}, now: () => NOW,
      deps: fakeBootstrapDeps({ db: e.db, scopeMissing: ['sleep', 'recovery'] }),
    });
    assert.equal(missing.result, BOOTSTRAP_RESULT.ACTION_REQUIRED);

    // F：使用者重新授權（這次勾齊權限）→ 回到已授權 → bootstrap → READY
    const u = await e.db.getUser(user.id);
    const t = new Date(NOW.getTime() + ONBOARDING.AUTH_LINK_COOLDOWN_MS + 1);
    const reply = await linked(e.db, u, '/connect', { now: t });
    const cb = createWhoopOAuthCallback({ db: e.db, ...fakeWhoopBackend(), now: () => t });
    const res = await cb({ query: new URLSearchParams({ code: 'good', state: stateFromUrl(urlIn(reply)) }) });
    assert.equal(res.outcome, 'ok');
    assert.equal(await stateOf(e.db, user.id), ONBOARDING_STATE.WHOOP_AUTHORIZED, '★ 重新授權清掉失敗狀態');
    const ok = await runOnboardingBootstrap({
      db: e.db, userId: user.id, env: {}, now: () => t, deps: fakeBootstrapDeps({ db: e.db }),
    });
    assert.equal(ok.result, BOOTSTRAP_RESULT.READY, '★★★ 修好權限之後可以恢復');
    assert.equal(await stateOf(e.db, user.id), ONBOARDING_STATE.READY);
  } finally { e.done(); }
});

// ===========================================================================
// 端對端（Asia/Taipei、UTC、缺權限）
// ===========================================================================

test('E2E 三種結局：Asia/Taipei → READY、UTC → READY、缺核心權限 → ACTION_REQUIRED', async () => {
  const e = await env();
  try {
    const taipei = await onboardFully(e.db, A_CHAT, { timezone: 'Asia/Taipei', whoopUserId: 'W-TPE' });
    assert.equal(taipei.boot.result, BOOTSTRAP_RESULT.READY);
    assert.equal(taipei.user.timezone, 'Asia/Taipei');

    const utc = await onboardFully(e.db, B_CHAT, { timezone: 'UTC', whoopUserId: 'W-UTC' });
    assert.equal(utc.boot.result, BOOTSTRAP_RESULT.READY);
    assert.equal(utc.user.timezone, 'UTC');

    const denied = await authorize(e.db, '333333', { timezone: 'Europe/Berlin', whoopUserId: 'W-NOSCOPE' });
    const boot = await runOnboardingBootstrap({
      db: e.db, userId: denied.id, env: {}, now: () => NOW,
      deps: fakeBootstrapDeps({ db: e.db, scopeMissing: ['sleep', 'recovery', 'cycle', 'workout', 'body_measurement'] }),
    });
    assert.equal(boot.result, BOOTSTRAP_RESULT.ACTION_REQUIRED);

    const sched = (await e.db.listSchedulableUsers({ activeStatus: USER_STATUS.ACTIVE })).map((u) => u.id).sort();
    assert.deepEqual(sched, [taipei.user.id, utc.user.id].sort(),
      '★★★ 只有真的可用的兩個人會被排程');
    // 三人的狀態、時區、token、capability 完全隔離
    assert.equal((await e.db.getTokens(taipei.user.id)).whoopUserId, 'W-TPE');
    assert.equal((await e.db.getTokens(utc.user.id)).whoopUserId, 'W-UTC');
    assert.equal(await stateOf(e.db, denied.id), ONBOARDING_STATE.ACTION_REQUIRED);
    assert.equal(await stateOf(e.db, taipei.user.id), ONBOARDING_STATE.READY);
  } finally { e.done(); }
});

test('bootstrap 的接手仍然有效：WHOOP_AUTHORIZED / SYNCING 會被排程 tick 撿起來', async () => {
  const e = await env();
  try {
    const a = await authorize(e.db, A_CHAT, { whoopUserId: 'W1' });
    const b = await authorize(e.db, B_CHAT, { whoopUserId: 'W2' });
    assert.equal(await stateOf(e.db, a.id), ONBOARDING_STATE.WHOOP_AUTHORIZED);
    const notes = [];
    const resumed = await resumeOnboardingBootstraps({
      db: e.db, env: {}, now: () => NOW, deps: fakeBootstrapDeps({ db: e.db, notes }),
    });
    assert.equal(resumed.length, 2);
    assert.ok(resumed.every((r) => r.result === BOOTSTRAP_RESULT.READY));
    assert.equal(notes.filter((n) => n.kind === 'ready').length, 2);
    assert.equal(await stateOf(e.db, b.id), ONBOARDING_STATE.READY);
  } finally { e.done(); }
});

test('normalizeTimezone 對 UTC 一視同仁（合法時區，不是哨兵值）', () => {
  assert.equal(normalizeTimezone('UTC'), 'UTC');
  assert.equal(normalizeTimezone('utc'), 'UTC');
  assert.equal(normalizeTimezone('Etc/UTC'), 'Etc/UTC');
  assert.equal(normalizeTimezone('+00:00'), null);
});
