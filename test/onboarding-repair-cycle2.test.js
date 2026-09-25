/**
 * V1.2 Phase 3.5 — 修復週期 2（RC1-FG-01 / F02、RC1-FG-02 / F04）。
 *
 *   F02 「有一組 access_token」**不是**身分證明。READY 需要可信的 WHOOP 身分：
 *       token 列上有 whoop_user_id，而且與 canonical 歷史身分不衝突。
 *       窄化的歷史例外（pre-M-01 的 NULL 身分 + 唯一一致的 canonical 身分）
 *       **只存在於遷移**，即時 / CLI 路徑拿不到。
 *   F04 READY 的原子轉移必須要求「必要資源（sleep / recovery）的權限判定
 *       屬於**目前**的授權世代」。舊世代的判定、或被改成 UNAUTHORIZED 的判定，
 *       一律不能讓 READY 通過。
 *
 * 全部用真實 libSQL。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createDb } from './localDb.js';
import { handleUnlinkedMessage, handleOnboardingMessage } from '../src/onboarding.js';
import { createWhoopOAuthCallback } from '../src/whoopOAuthCallback.js';
import { runOnboardingBootstrap, evaluateReadiness, BOOTSTRAP_RESULT } from '../src/onboardingBootstrap.js';
import { runMigrations } from './localMigrations.js';
import {
  ONBOARDING_STATE, ONBOARDING_FAILURE, USER_STATUS, SCHEMA_VERSION, RESOURCE_ACCESS_STATUS,
} from '../src/schema.js';
import { ONBOARDING } from '../src/config.js';

const NOW = new Date('2026-09-15T12:00:00.000Z');
const HOUR = 3_600_000;
const CLIENT_ID = 'test-client';
const REDIRECT = 'https://example.test/whoop/oauth/callback';
const A_CHAT = '111111';
const B_CHAT = '222222';
const RESOURCES = ['sleep', 'recovery', 'cycle', 'workout', 'body_measurement'];

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whoop-onb-rc2-'));
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
const urlIn = (reply) => /https:\/\/\S+/.exec(reply)?.[0] ?? null;
const stateFromUrl = (url) => new URL(url).searchParams.get('state');

const fakeWhoopBackend = ({ whoopUserId = 'W1' } = {}) => ({
  exchange: async ({ code }) => {
    if (!code || code === 'bad') throw new Error('invalid_grant');
    return {
      accessToken: `at-${whoopUserId}`, refreshToken: `rt-${whoopUserId}`,
      expiresAt: new Date(NOW.getTime() + HOUR), scope: 'offline',
    };
  },
  verifyIdentity: async () => whoopUserId,
});

function fakeBootstrapDeps({ db, scopeMissing = [], transient = [], notes = [] } = {}) {
  return {
    makeWhoop: () => ({ tag: 'fake' }),
    makeSync: ({ userId }) => ({
      syncAll: async () => {
        for (const r of RESOURCES) {
          if (scopeMissing.includes(r) || transient.includes(r)) continue;
          await db.saveSyncState(userId, r, { lastSuccessAt: NOW.toISOString() }, { now: NOW });
        }
        return RESOURCES.map((resource) => ({
          resource,
          status: scopeMissing.includes(resource) ? 'scope_missing'
            : transient.includes(resource) ? 'failed' : 'ok',
        }));
      },
    }),
    probe: async ({ userId, expectedLifecycleGeneration }) => {
      await db.saveCapabilities(userId, [
        { key: 'recovery', status: 'SUPPORTED', sampleCount: 5, nonNullCount: 5 },
      ], { expectedLifecycleGeneration, now: NOW });
      return { entries: [], scopeErrors: scopeMissing.map((resource) => ({ resource })) };
    },
    notify: async (userId, kind) => { notes.push({ userId, kind }); },
  };
}

/** 一個「管理者用 CLI 建好」的使用者：綁定 + token（可選身分）+ 同步 + capability。 */
async function cliUser(db, {
  id, chatId, whoopUserId = null, status = USER_STATUS.ACTIVE, tz = 'Asia/Taipei',
}) {
  const u = await db.createUser({ id, displayName: id, timezone: tz, status, now: NOW });
  await db.linkTelegram({ chatId, userId: u.id, now: NOW });
  await db.saveTokens(u.id, {
    accessToken: 'at', refreshToken: 'rt', expiresAt: new Date(NOW.getTime() + HOUR),
    scope: 'offline', whoopUserId,
  });
  await db.saveSyncState(u.id, 'sleep', { lastSuccessAt: NOW.toISOString() }, { now: NOW });
  await db.saveCapabilities(u.id, [{ key: 'recovery', status: 'SUPPORTED', sampleCount: 5, nonNullCount: 5 }], { expectedLifecycleGeneration: (await db.getUser(u.id)).lifecycleGeneration, now: NOW });
  return u;
}

/** 在 canonical 表塞一筆帶 WHOOP 身分的睡眠（歷史身分證據）。 */
async function canonicalIdentity(db, userId, whoopUserId, { table = 'whoop_sleeps', id = 's1' } = {}) {
  await db.raw.execute({
    sql: `INSERT INTO ${table} (user_id, id, whoop_user_id, health_date, created_at, updated_at, synced_at, raw_json)
          VALUES (?, ?, ?, '2026-09-10', ?, ?, ?, '{}')`,
    args: [userId, id, String(whoopUserId), NOW.toISOString(), NOW.toISOString(), NOW.toISOString()],
  });
}

/** 走到「已授權、等 bootstrap」。 */
async function authorize(db, chatId, { timezone = 'Asia/Taipei', whoopUserId = 'W1' } = {}) {
  await onb(db, chatId, '/start');
  const user = await userFor(db, chatId);
  const reply = await linked(db, user, timezone);
  const cb = createWhoopOAuthCallback({ db, ...fakeWhoopBackend({ whoopUserId }), now: () => NOW });
  const res = await cb({ query: new URLSearchParams({ code: 'good', state: stateFromUrl(urlIn(reply)) }) });
  assert.equal(res.outcome, 'ok');
  return await db.getUser(user.id);
}
async function onboardFully(db, chatId, opts = {}) {
  const user = await authorize(db, chatId, opts);
  const boot = await runOnboardingBootstrap({
    db, userId: user.id, env: {}, now: () => NOW, deps: fakeBootstrapDeps({ db, ...opts }),
  });
  return { user: await db.getUser(user.id), boot };
}

/** 直接把必要資源標成可讀（測 READY 轉移時用）。 */
async function grantAccess(db, userId, { resources = ONBOARDING.REQUIRED_SCOPES, generation = null } = {}) {
  const gen = generation ?? await db.getAuthGeneration(userId);
  await db.recordResourceAccess(userId, resources.map((resource) => ({
    resource, status: RESOURCE_ACCESS_STATUS.ACCESSIBLE,
  })), { authGeneration: gen, now: NOW });
  return gen;
}

// ===========================================================================
// F02 — 身分必須可信
// ===========================================================================

test('RC2-ATTACK-01 / F02-A 新使用者只有 token、身分是 NULL → 即使同步與 capability 都在也不 READY', async () => {
  const e = await env();
  try {
    const u = await cliUser(e.db, { id: 'token-only', chatId: A_CHAT, whoopUserId: null });
    // 即時推導（CLI / 排程 backfill 都走這一條）
    await e.db.ensureOnboardingDerived(u.id, { now: NOW });
    const row = await e.db.getOnboardingRow(u.id);
    assert.notEqual(row.state, ONBOARDING_STATE.READY, '★★★ 有 token ≠ 有身分');
    assert.equal(row.state, ONBOARDING_STATE.TIMEZONE_PENDING);
    assert.equal(row.timezoneConfirmedAt, null);
    assert.deepEqual(await e.db.listSchedulableUsers({ activeStatus: USER_STATUS.ACTIVE }), [],
      '★ 不可被排程');
    // 原子轉移也擋
    await e.db.setOnboardingState(u.id, ONBOARDING_STATE.SYNCING, { timezoneConfirmed: true, now: NOW });
    await grantAccess(e.db, u.id);
    const ready = await e.db.setReadyIfEligible({
      userId: u.id, requiredResources: ONBOARDING.REQUIRED_SCOPES, now: NOW,
    });
    assert.equal(ready.ok, false, '★★★ 原子轉移同樣要求可信身分');
    const v = await evaluateReadiness({ db: e.db, userId: u.id });
    assert.ok(v.missing.includes('whoop_identity'));
  } finally { e.done(); }
});

test('RC2-ATTACK-14 / F02-H CLI 只塞 token 的使用者：排程 backfill 也不會把他變成 READY', async () => {
  const e = await env();
  try {
    await cliUser(e.db, { id: 'cli-token-only', chatId: A_CHAT, whoopUserId: null });
    const good = await cliUser(e.db, { id: 'cli-verified', chatId: B_CHAT, whoopUserId: 'WV' });
    await e.db.ensureOnboardingDerivedForAll({ now: NOW });
    assert.notEqual((await e.db.getOnboardingRow('cli-token-only')).state, ONBOARDING_STATE.READY);
    assert.equal((await e.db.getOnboardingRow(good.id)).state, ONBOARDING_STATE.READY,
      '★ 有驗證身分的 CLI 使用者可以 READY');
    const sched = await e.db.listSchedulableUsers({ activeStatus: USER_STATUS.ACTIVE });
    assert.deepEqual(sched.map((u) => u.id), [good.id]);
  } finally { e.done(); }
});

test('RC2-ATTACK-04 / F02-D canonical 身分互相矛盾 → 不可 READY（即使 token 上有身分）', async () => {
  const e = await env();
  try {
    const u = await cliUser(e.db, { id: 'conflict', chatId: A_CHAT, whoopUserId: 'W1' });
    await canonicalIdentity(e.db, u.id, 'W1', { id: 's1' });
    await canonicalIdentity(e.db, u.id, 'W2', { id: 's2' });
    await e.db.ensureOnboardingDerived(u.id, { now: NOW });
    assert.notEqual((await e.db.getOnboardingRow(u.id)).state, ONBOARDING_STATE.READY);
    await e.db.setOnboardingState(u.id, ONBOARDING_STATE.SYNCING, { timezoneConfirmed: true, now: NOW });
    await grantAccess(e.db, u.id);
    assert.equal((await e.db.setReadyIfEligible({
      userId: u.id, requiredResources: ONBOARDING.REQUIRED_SCOPES, now: NOW,
    })).ok, false, '★★★ 身分矛盾 → fail closed');
    const v = await evaluateReadiness({ db: e.db, userId: u.id });
    assert.ok(v.missing.includes('whoop_identity_conflict'));
  } finally { e.done(); }
});

test('RC2-ATTACK-05 / F02-E token 身分 W2、canonical 身分 W1 → 不可 READY（不可以默默挑一個）', async () => {
  const e = await env();
  try {
    const u = await cliUser(e.db, { id: 'mismatch', chatId: A_CHAT, whoopUserId: 'W2' });
    await canonicalIdentity(e.db, u.id, 'W1');
    await e.db.ensureOnboardingDerived(u.id, { now: NOW });
    assert.notEqual((await e.db.getOnboardingRow(u.id)).state, ONBOARDING_STATE.READY);
    await e.db.setOnboardingState(u.id, ONBOARDING_STATE.SYNCING, { timezoneConfirmed: true, now: NOW });
    await grantAccess(e.db, u.id);
    assert.equal((await e.db.setReadyIfEligible({
      userId: u.id, requiredResources: ONBOARDING.REQUIRED_SCOPES, now: NOW,
    })).ok, false);
    assert.ok((await evaluateReadiness({ db: e.db, userId: u.id })).missing.includes('whoop_identity_conflict'));
  } finally { e.done(); }
});

test('F02-F token 身分 W1、canonical 身分 W1 → 其他前提齊全時可以 READY', async () => {
  const e = await env();
  try {
    const u = await cliUser(e.db, { id: 'consistent', chatId: A_CHAT, whoopUserId: 'W1' });
    await canonicalIdentity(e.db, u.id, 'W1');
    await e.db.ensureOnboardingDerived(u.id, { now: NOW });
    assert.equal((await e.db.getOnboardingRow(u.id)).state, ONBOARDING_STATE.READY);
    assert.deepEqual((await e.db.listSchedulableUsers({ activeStatus: USER_STATUS.ACTIVE })).map((x) => x.id), [u.id]);
  } finally { e.done(); }
});

test('F02-C 舊使用者 token 身分 NULL、canonical 也沒有任何身分 → 不可 READY', async () => {
  const e = await env();
  try {
    await cliUser(e.db, { id: 'no-evidence', chatId: A_CHAT, whoopUserId: null });
    const s = await migrateFromV13(e.db);
    assert.equal(s.to, SCHEMA_VERSION);
    assert.notEqual((await e.db.getOnboardingRow('no-evidence')).state, ONBOARDING_STATE.READY,
      '★★★ 沒有任何身分證據 → 不可能 READY');
    assert.deepEqual(await e.db.listSchedulableUsers({ activeStatus: USER_STATUS.ACTIVE }), []);
  } finally { e.done(); }
});

/** 把資料庫退回 v13 形狀再遷移（onboarding 表與 v16 的資源表都拿掉）。 */
async function migrateFromV13(db) {
  await db.raw.execute('DROP TABLE IF EXISTS user_onboarding');
  await db.raw.execute('DROP TABLE IF EXISTS whoop_resource_access');
  await db.raw.execute('DELETE FROM schema_version WHERE version >= 14');
  await db.raw.execute("INSERT OR IGNORE INTO schema_version (version, applied_at, note) VALUES (13, '2026-09-14T00:00:00.000Z', 'v13')");
  return runMigrations(db.raw);
}

test('RC2-ATTACK-02 / F02-B 窄化的歷史例外：pre-M-01（token 身分 NULL）+ canonical 唯一一致身分 → 遷移可給 READY', async () => {
  const e = await env();
  try {
    const legacy = await cliUser(e.db, { id: 'legacy-ok', chatId: A_CHAT, whoopUserId: null });
    // canonical 四張表裡的身分完全一致
    await canonicalIdentity(e.db, legacy.id, 'WL', { id: 's1' });
    await e.db.raw.execute({
      sql: `INSERT INTO whoop_recoveries (user_id, sleep_id, whoop_user_id, created_at, updated_at, synced_at, raw_json)
            VALUES (?, 's1', 'WL', ?, ?, ?, '{}')`,
      args: [legacy.id, NOW.toISOString(), NOW.toISOString(), NOW.toISOString()],
    });
    const s = await migrateFromV13(e.db);
    assert.deepEqual(s.rebuilt, []);
    // ★ R2 / LIFE-FG-10：窄化的歷史身分例外仍然成立（他沒有被當成身分不明
    // 而降級成 ACTION_REQUIRED），但仍要在目前啟用世代重新驗證資格。
    assert.equal((await e.db.getOnboardingRow(legacy.id)).state, ONBOARDING_STATE.WHOOP_AUTHORIZED,
      '★ 歷史例外仍然被認得（不是 ACTION_REQUIRED），但要重新驗證');
    assert.ok((await e.db.getOnboardingRow(legacy.id)).timezoneConfirmedAt);
    // ★ R2 / LIFE-FG-10：遷移之後沒有人直接可排程；重新驗證通過才回來。
    assert.deepEqual((await e.db.listSchedulableUsers({ activeStatus: USER_STATUS.ACTIVE })).map((u) => u.id), []);
    assert.deepEqual(
      (await e.db.listOnboardingInState([ONBOARDING_STATE.WHOOP_AUTHORIZED])).map((o) => o.userId),
      [legacy.id], '★ 但他立刻進入重新驗證佇列');

    // ★ 同樣的形狀走**即時**路徑則拿不到例外
    await e.db.raw.execute('DELETE FROM user_onboarding');
    await e.db.ensureOnboardingDerived(legacy.id, { now: NOW });
    assert.notEqual((await e.db.getOnboardingRow(legacy.id)).state, ONBOARDING_STATE.READY,
      '★★★ 歷史例外只存在於遷移，即時路徑不適用');
  } finally { e.done(); }
});

test('RC2-ATTACK-03 / F02-G v14 寫下的任意-token 假 READY → v16 遷移降級並移出排程', async () => {
  const e = await env();
  try {
    await cliUser(e.db, { id: 'fake-ready', chatId: A_CHAT, whoopUserId: null });
    const good = await cliUser(e.db, { id: 'true-ready', chatId: B_CHAT, whoopUserId: 'WT' });
    // 模擬 v14/v15 之後的資料庫：兩個人都被寫成 READY
    await e.db.raw.execute('DELETE FROM user_onboarding');
    for (const id of ['fake-ready', 'true-ready']) {
      await e.db.raw.execute({
        sql: `INSERT INTO user_onboarding (user_id, state, timezone_confirmed_at, ready_at,
                state_changed_at, created_at, updated_at) VALUES (?, 'READY', ?, ?, ?, ?, ?)`,
        args: [id, NOW.toISOString(), NOW.toISOString(), NOW.toISOString(), NOW.toISOString(), NOW.toISOString()],
      });
    }
    await e.db.raw.execute('DELETE FROM schema_version WHERE version >= 16');
    await e.db.raw.execute("INSERT OR IGNORE INTO schema_version (version, applied_at, note) VALUES (15, '2026-09-15T00:00:00.000Z', 'v15')");

    const s = await runMigrations(e.db.raw);
    assert.equal(s.from, 15); assert.equal(s.to, SCHEMA_VERSION);
    assert.deepEqual(s.dataMigrations, [{ version: 16, rows: 1 }, { version: 18, rows: 1 }, { version: 19, rows: 0 }], '★ 只有一列被降級');
    const fake = await e.db.getOnboardingRow('fake-ready');
    assert.equal(fake.state, ONBOARDING_STATE.ACTION_REQUIRED, '★★★ 假 READY 被修正');
    assert.equal(fake.failureCode, ONBOARDING_FAILURE.REAUTH_REQUIRED);
    assert.equal(fake.readyAt, null);
    // 身分可信的人不會被打成 ACTION_REQUIRED（v16 的降級只針對身分不可信），
    // 但 v18 仍會把他移進重新驗證。
    assert.equal((await e.db.getOnboardingRow(good.id)).state, ONBOARDING_STATE.WHOOP_AUTHORIZED,
      '★ 身分可信 → 不是 ACTION_REQUIRED，而是重新驗證');
    assert.deepEqual((await e.db.listSchedulableUsers({ activeStatus: USER_STATUS.ACTIVE })).map((u) => u.id),
      [], '★★★ 遷移之後沒有人直接可排程');
    // 冪等
    assert.deepEqual((await runMigrations(e.db.raw)).dataMigrations, []);
  } finally { e.done(); }
});

test('RC2-ATTACK-13 / F02-I 完整設定好的 Kelvin（pre-M-01 形狀）遷移後仍 READY 且可排程', async () => {
  const e = await env();
  try {
    const kelvin = await cliUser(e.db, { id: 'kelvin', chatId: '999888', whoopUserId: null });
    await canonicalIdentity(e.db, kelvin.id, 'KELVIN-WHOOP');
    const s = await migrateFromV13(e.db);
    assert.equal(s.from, 13); assert.equal(s.to, SCHEMA_VERSION);
    assert.deepEqual(s.rebuilt, []);
    const row = await e.db.getOnboardingRow(kelvin.id);
    // ★ R2 / LIFE-FG-10：pre-M-01 的 Kelvin 仍然被認得（身分例外成立），
    // 但要在目前啟用世代重新產生資源權限判定之後才回到 READY。
    assert.equal(row.state, ONBOARDING_STATE.WHOOP_AUTHORIZED);
    assert.equal((await e.db.getUser(kelvin.id)).status, USER_STATUS.ACTIVE);
    assert.equal((await e.db.getUser(kelvin.id)).timezone, 'Asia/Taipei');
    assert.deepEqual((await e.db.listSchedulableUsers({ activeStatus: USER_STATUS.ACTIVE })).map((u) => u.id), [],
      '★ 重新驗證之前不可排程');
    assert.deepEqual(
      (await e.db.listOnboardingInState([ONBOARDING_STATE.WHOOP_AUTHORIZED])).map((o) => o.userId),
      [kelvin.id], '★ 立刻進入重新驗證佇列（不需要重走自助流程）');
    // 不需要重走自助流程：每一輪排程的 backfill 都不會把他改掉，
    // 他就停在重新驗證佇列裡等 bootstrap。
    for (let i = 0; i < 3; i += 1) {
      await e.db.ensureOnboardingDerivedForAll({ now: NOW });
      assert.equal((await e.db.getOnboardingRow(kelvin.id)).state, ONBOARDING_STATE.WHOOP_AUTHORIZED);
    }
  } finally { e.done(); }
});

// ===========================================================================
// F04 — 必要資源的權限必須綁在目前的授權世代
// ===========================================================================

test('F04-A 必要資源在目前世代皆可讀 → READY 成功', async () => {
  const e = await env();
  try {
    const { boot, user } = await onboardFully(e.db, A_CHAT);
    assert.equal(boot.result, BOOTSTRAP_RESULT.READY, JSON.stringify(boot));
    const gen = await e.db.getAuthGeneration(user.id);
    const access = await e.db.getResourceAccess(user.id);
    assert.equal(access.length, RESOURCES.length);
    assert.ok(access.every((a) => a.authGeneration === gen));
    for (const r of ONBOARDING.REQUIRED_SCOPES) {
      assert.equal(access.find((a) => a.resource === r).status, RESOURCE_ACCESS_STATUS.ACCESSIBLE);
    }
  } finally { e.done(); }
});

test('RC2-ATTACK-07 / F04-B sleep 在轉移前被改成 UNAUTHORIZED → READY 被拒', async () => {
  const e = await env();
  try {
    const user = await authorize(e.db, A_CHAT);
    const deps = fakeBootstrapDeps({ db: e.db });
    const hooked = {
      ...deps,
      probe: async (args) => {
        const r = await deps.probe(args);
        // 判定寫進去之後、READY 之前，權限被撤掉（同一個世代）
        return r;
      },
    };
    // 先正常跑到 READY 需要的狀態，再在轉移前翻轉 sleep
    const boot = await runOnboardingBootstrap({
      db: {
        ...e.db,
        setReadyIfEligible: async (args) => {
          await e.db.recordResourceAccess(user.id, [{ resource: 'sleep', status: RESOURCE_ACCESS_STATUS.UNAUTHORIZED }],
            { authGeneration: await e.db.getAuthGeneration(user.id), now: NOW });
          return e.db.setReadyIfEligible(args);
        },
      },
      userId: user.id, env: {}, now: () => NOW, deps: hooked,
    });
    assert.notEqual(boot.result, BOOTSTRAP_RESULT.READY, '★★★ sleep 不可讀 → 不可 READY');
    assert.notEqual(await stateOf(e.db, user.id), ONBOARDING_STATE.READY);
    assert.ok((await evaluateReadiness({ db: e.db, userId: user.id })).missing.includes('access_sleep_unauthorized'));
  } finally { e.done(); }
});

test('RC2-ATTACK-08 / F04-C,D recovery（或兩者）不可讀 → READY 被拒', async () => {
  for (const missing of [['recovery'], ['sleep', 'recovery']]) {
    const e = await env();
    try {
      const user = await authorize(e.db, A_CHAT);
      const boot = await runOnboardingBootstrap({
        db: e.db, userId: user.id, env: {}, now: () => NOW,
        deps: fakeBootstrapDeps({ db: e.db, scopeMissing: missing }),
      });
      assert.equal(boot.result, BOOTSTRAP_RESULT.ACTION_REQUIRED, missing.join('+'));
      assert.equal((await e.db.getOnboardingRow(user.id)).failureCode, ONBOARDING_FAILURE.WHOOP_SCOPE_INCOMPLETE);
      const access = await e.db.getResourceAccess(user.id);
      for (const m of missing) {
        assert.equal(access.find((a) => a.resource === m).status, RESOURCE_ACCESS_STATUS.UNAUTHORIZED);
      }
      assert.deepEqual(await e.db.listSchedulableUsers({ activeStatus: USER_STATUS.ACTIVE }), []);
    } finally { e.done(); }
  }
});

test('RC2-ATTACK-09 / F04-E 只有選配資源不可讀 → READY 仍然成功', async () => {
  const e = await env();
  try {
    const { boot, user } = await onboardFully(e.db, A_CHAT, {
      scopeMissing: ['cycle', 'workout', 'body_measurement'],
    });
    assert.equal(boot.result, BOOTSTRAP_RESULT.READY);
    assert.equal(await stateOf(e.db, user.id), ONBOARDING_STATE.READY);
    const access = await e.db.getResourceAccess(user.id);
    assert.equal(access.find((a) => a.resource === 'workout').status, RESOURCE_ACCESS_STATUS.UNAUTHORIZED);
    assert.equal(access.find((a) => a.resource === 'sleep').status, RESOURCE_ACCESS_STATUS.ACCESSIBLE);
    // 轉移之後選配資源再消失也不影響既有的 READY
    await e.db.recordResourceAccess(user.id, [{ resource: 'cycle', status: RESOURCE_ACCESS_STATUS.UNAUTHORIZED }],
      { authGeneration: await e.db.getAuthGeneration(user.id), now: NOW });
    assert.equal(await stateOf(e.db, user.id), ONBOARDING_STATE.READY);
  } finally { e.done(); }
});

test('RC2-ATTACK-10 / F04-F 必要資源成功但沒有任何資料 → 仍算可讀，READY 成功', async () => {
  const e = await env();
  try {
    // scopeMissing 為空 = 端點都成功回應（空集合）
    const { boot, user } = await onboardFully(e.db, A_CHAT);
    assert.equal(boot.result, BOOTSTRAP_RESULT.READY, '★★★ 沒有資料 ≠ 沒有權限');
    const access = await e.db.getResourceAccess(user.id);
    for (const r of ONBOARDING.REQUIRED_SCOPES) {
      assert.equal(access.find((a) => a.resource === r).status, RESOURCE_ACCESS_STATUS.ACCESSIBLE);
    }
  } finally { e.done(); }
});

test('RC2-ATTACK-06 / F04-G,H 重新授權後世代 +1：舊世代的判定不能讓 READY 通過；新世代驗過才可以', async () => {
  const e = await env();
  try {
    const user = await authorize(e.db, A_CHAT, { whoopUserId: 'W1' });
    const gen1 = await e.db.getAuthGeneration(user.id);
    assert.equal(gen1, 1, '第一次授權就是世代 1');

    // 世代 1 的判定：一切良好
    await grantAccess(e.db, user.id, { generation: gen1, resources: RESOURCES });
    await e.db.saveSyncState(user.id, 'sleep', { lastSuccessAt: NOW.toISOString() }, { now: NOW });
    await e.db.saveCapabilities(user.id, [{ key: 'recovery', status: 'SUPPORTED', sampleCount: 5, nonNullCount: 5 }], { expectedLifecycleGeneration: (await e.db.getUser(user.id)).lifecycleGeneration, now: NOW });
    await e.db.setOnboardingState(user.id, ONBOARDING_STATE.SYNCING, { syncStarted: true, now: NOW });

    // 使用者重新授權（同一個 WHOOP 帳號）→ 世代 +1，舊判定立刻失效
    const t = new Date(NOW.getTime() + ONBOARDING.AUTH_LINK_COOLDOWN_MS + 1);
    const reply = await linked(e.db, await e.db.getUser(user.id), '/connect', { now: t });
    const cb = createWhoopOAuthCallback({ db: e.db, ...fakeWhoopBackend({ whoopUserId: 'W1' }), now: () => t });
    assert.equal((await cb({ query: new URLSearchParams({ code: 'good', state: stateFromUrl(urlIn(reply)) }) })).outcome, 'ok');
    const gen2 = await e.db.getAuthGeneration(user.id);
    assert.equal(gen2, gen1 + 1, '★ 重新授權 → 世代 +1');

    // 舊的 bootstrap（拿著世代 1 的判定）嘗試 READY
    await e.db.setOnboardingState(user.id, ONBOARDING_STATE.SYNCING, { now: t });
    const stale = await e.db.setReadyIfEligible({
      userId: user.id, requiredResources: ONBOARDING.REQUIRED_SCOPES, now: t,
    });
    assert.equal(stale.ok, false, '★★★ 舊世代的權限判定不能通過 READY');
    assert.notEqual(await stateOf(e.db, user.id), ONBOARDING_STATE.READY);
    const v = await evaluateReadiness({ db: e.db, userId: user.id });
    assert.ok(v.missing.includes('access_sleep_unknown'), JSON.stringify(v.missing));

    // 新世代重新驗證過 → 可以 READY（F04-H）
    const boot = await runOnboardingBootstrap({
      db: e.db, userId: user.id, env: {}, now: () => t, deps: fakeBootstrapDeps({ db: e.db }),
    });
    assert.equal(boot.result, BOOTSTRAP_RESULT.READY);
    const access = await e.db.getResourceAccess(user.id);
    assert.ok(access.every((a) => a.authGeneration === gen2));
  } finally { e.done(); }
});

test('RC2-ATTACK-15 重新授權（這次權限補齊）→ 可以從 ACTION_REQUIRED 恢復到 READY', async () => {
  const e = await env();
  try {
    const user = await authorize(e.db, A_CHAT, { whoopUserId: 'W1' });
    const bad = await runOnboardingBootstrap({
      db: e.db, userId: user.id, env: {}, now: () => NOW,
      deps: fakeBootstrapDeps({ db: e.db, scopeMissing: ['sleep', 'recovery'] }),
    });
    assert.equal(bad.result, BOOTSTRAP_RESULT.ACTION_REQUIRED);
    const t = new Date(NOW.getTime() + ONBOARDING.AUTH_LINK_COOLDOWN_MS + 1);
    const reply = await linked(e.db, await e.db.getUser(user.id), '/connect', { now: t });
    const cb = createWhoopOAuthCallback({ db: e.db, ...fakeWhoopBackend({ whoopUserId: 'W1' }), now: () => t });
    await cb({ query: new URLSearchParams({ code: 'good', state: stateFromUrl(urlIn(reply)) }) });
    const ok = await runOnboardingBootstrap({
      db: e.db, userId: user.id, env: {}, now: () => t, deps: fakeBootstrapDeps({ db: e.db }),
    });
    assert.equal(ok.result, BOOTSTRAP_RESULT.READY, '★ 權限補齊之後恢復');
    assert.equal(await stateOf(e.db, user.id), ONBOARDING_STATE.READY);
  } finally { e.done(); }
});

test('RC2-ATTACK-11 / F04-I 必要資源暫時性失敗 → 不寫任何權限判定、不誤報權限不足、可重試', async () => {
  const e = await env();
  try {
    const user = await authorize(e.db, A_CHAT);
    const boot = await runOnboardingBootstrap({
      db: e.db, userId: user.id, env: {}, now: () => NOW,
      deps: fakeBootstrapDeps({ db: e.db, transient: ['sleep'] }),
    });
    assert.equal(boot.result, BOOTSTRAP_RESULT.RETRY, '★ 暫時性 → 重試');
    const row = await e.db.getOnboardingRow(user.id);
    assert.equal(row.state, ONBOARDING_STATE.SYNCING);
    assert.notEqual(row.failureCode, ONBOARDING_FAILURE.WHOOP_SCOPE_INCOMPLETE, '★★★ 不可誤報權限不足');
    const access = await e.db.getResourceAccess(user.id);
    assert.equal(access.find((a) => a.resource === 'sleep'), undefined, '★★★ 暫時性失敗不寫結論');
    // 恢復之後可以 READY
    const ok = await runOnboardingBootstrap({
      db: e.db, userId: user.id, env: {}, now: () => NOW, deps: fakeBootstrapDeps({ db: e.db }),
    });
    assert.equal(ok.result, BOOTSTRAP_RESULT.READY);
  } finally { e.done(); }
});

test('RC2-ATTACK-06 補充 / F04-J 狀態已變成 ACTION_REQUIRED 時，過期的 worker 仍然不能 READY', async () => {
  const e = await env();
  try {
    const user = await authorize(e.db, A_CHAT);
    await grantAccess(e.db, user.id);
    await e.db.saveSyncState(user.id, 'sleep', { lastSuccessAt: NOW.toISOString() }, { now: NOW });
    await e.db.saveCapabilities(user.id, [{ key: 'recovery', status: 'SUPPORTED', sampleCount: 5, nonNullCount: 5 }], { expectedLifecycleGeneration: (await e.db.getUser(user.id)).lifecycleGeneration, now: NOW });
    await e.db.setOnboardingState(user.id, ONBOARDING_STATE.ACTION_REQUIRED, {
      failureCode: ONBOARDING_FAILURE.REAUTH_REQUIRED, now: NOW,
    });
    const ready = await e.db.setReadyIfEligible({
      userId: user.id, requiredResources: ONBOARDING.REQUIRED_SCOPES, now: NOW,
    });
    assert.equal(ready.ok, false);
    assert.match(ready.reason, /ACTION_REQUIRED/);
  } finally { e.done(); }
});

// ===========================================================================
// F02 + F04 交互
// ===========================================================================

test('F02+F04 交互：身分不可信但權限良好 → 不 READY；身分好但世代過期 → 不 READY；兩者都對 → READY', async () => {
  const e = await env();
  try {
    // 身分不可信 + 權限良好
    const noId = await cliUser(e.db, { id: 'no-id', chatId: A_CHAT, whoopUserId: null });
    await e.db.ensureOnboardingDerived(noId.id, { now: NOW });
    await e.db.setOnboardingState(noId.id, ONBOARDING_STATE.SYNCING, { timezoneConfirmed: true, now: NOW });
    await grantAccess(e.db, noId.id);
    assert.equal((await e.db.setReadyIfEligible({
      userId: noId.id, requiredResources: ONBOARDING.REQUIRED_SCOPES, now: NOW,
    })).ok, false, '★ 身分不可信 → 不 READY');

    // 身分好 + 權限判定是舊世代
    const ok = await cliUser(e.db, { id: 'ok-id', chatId: B_CHAT, whoopUserId: 'W9' });
    await e.db.ensureOnboardingDerived(ok.id, { now: NOW });
    await e.db.setOnboardingState(ok.id, ONBOARDING_STATE.SYNCING, { timezoneConfirmed: true, now: NOW });
    const gen = await e.db.getAuthGeneration(ok.id);
    // F04 之後「舊世代的判定列」只能用**真實的路徑**造出來：先在目前世代寫
    // 判定，再重新授權讓世代往前走。直接寫一個不存在的世代已經被 CAS 圍欄
    // 擋掉了（那正是這次修正的重點），所以測試也要照真實順序來。
    await grantAccess(e.db, ok.id, { generation: gen });
    await e.db.saveTokens(ok.id, {
      accessToken: 'reauthorized', refreshToken: 'rt-new',
      expiresAt: new Date(NOW.getTime() + HOUR), scope: 'offline read:sleep read:recovery',
      whoopUserId: 'W9',
    }, { bumpAuthGeneration: true });
    assert.equal(await e.db.getAuthGeneration(ok.id), gen + 1, '★ 重新授權 → 世代 +1');
    assert.equal((await e.db.setReadyIfEligible({
      userId: ok.id, requiredResources: ONBOARDING.REQUIRED_SCOPES, now: NOW,
    })).ok, false, '★ 世代過期 → 不 READY');

    // 兩者都對（在**新的**世代重新驗過）
    await grantAccess(e.db, ok.id, { generation: gen + 1 });
    assert.equal((await e.db.setReadyIfEligible({
      userId: ok.id, requiredResources: ONBOARDING.REQUIRED_SCOPES, now: NOW,
    })).ok, true, '★ 兩者都對 → READY');
    assert.equal(await stateOf(e.db, ok.id), ONBOARDING_STATE.READY);
  } finally { e.done(); }
});

test('RC2-ATTACK-12 Alice / Bob：身分、授權世代、權限判定、READY 資格互相隔離', async () => {
  const e = await env();
  try {
    const a = await onboardFully(e.db, A_CHAT, { whoopUserId: 'W-A' });
    const b = await onboardFully(e.db, B_CHAT, { whoopUserId: 'W-B' });
    assert.equal(a.boot.result, BOOTSTRAP_RESULT.READY);
    assert.equal(b.boot.result, BOOTSTRAP_RESULT.READY);
    const genA = await e.db.getAuthGeneration(a.user.id);
    const genB = await e.db.getAuthGeneration(b.user.id);

    // Alice 重新授權 → 只有她的世代前進
    const t = new Date(NOW.getTime() + ONBOARDING.AUTH_LINK_COOLDOWN_MS + 1);
    const reply = await linked(e.db, a.user, '/connect', { now: t });
    const cb = createWhoopOAuthCallback({ db: e.db, ...fakeWhoopBackend({ whoopUserId: 'W-A' }), now: () => t });
    await cb({ query: new URLSearchParams({ code: 'good', state: stateFromUrl(urlIn(reply)) }) });
    assert.equal(await e.db.getAuthGeneration(a.user.id), genA + 1);
    assert.equal(await e.db.getAuthGeneration(b.user.id), genB, '★★★ Bob 的世代不受影響');

    // Bob 仍然 READY 且可排程；Alice 回到已授權待 bootstrap
    assert.equal(await stateOf(e.db, b.user.id), ONBOARDING_STATE.READY);
    assert.equal(await stateOf(e.db, a.user.id), ONBOARDING_STATE.WHOOP_AUTHORIZED);
    assert.deepEqual((await e.db.listSchedulableUsers({ activeStatus: USER_STATUS.ACTIVE })).map((u) => u.id), [b.user.id]);
    const accessB = await e.db.getResourceAccess(b.user.id);
    assert.ok(accessB.every((x) => x.authGeneration === genB), '★ Bob 的判定仍屬於他自己的世代');
    assert.equal((await e.db.getTokens(a.user.id)).whoopUserId, 'W-A');
    assert.equal((await e.db.getTokens(b.user.id)).whoopUserId, 'W-B');
  } finally { e.done(); }
});

test('例行 refresh 不會前進授權世代（只有重新授權會）', async () => {
  const e = await env();
  try {
    const { user } = await onboardFully(e.db, A_CHAT);
    const gen = await e.db.getAuthGeneration(user.id);
    // 模擬 token refresh：同一次授權，換新的 access token
    await e.db.saveTokens(user.id, {
      accessToken: 'refreshed', refreshToken: 'rt2',
      expiresAt: new Date(NOW.getTime() + HOUR), scope: 'offline',
    });
    assert.equal(await e.db.getAuthGeneration(user.id), gen, '★★★ refresh 不動世代');
    assert.equal(await stateOf(e.db, user.id), ONBOARDING_STATE.READY, '★ 也不影響已經 READY 的人');
    const ready = await e.db.setReadyIfEligible({
      userId: user.id, from: [ONBOARDING_STATE.READY], requiredResources: ONBOARDING.REQUIRED_SCOPES, now: NOW,
    });
    assert.equal(ready.ok, true, '★ refresh 之後權限判定仍然有效');
  } finally { e.done(); }
});

// ===========================================================================
// 遷移
// ===========================================================================

test('遷移 v15 → v16：純新增（auth_generation 欄位 + 資源權限表），既有資料不動；冪等；中斷後補齊', async () => {
  const e = await env();
  try {
    const u = await cliUser(e.db, { id: 'mig', chatId: A_CHAT, whoopUserId: 'WM' });
    await e.db.ensureOnboardingDerived(u.id, { now: NOW });
    // 退回 v15 形狀
    await e.db.raw.execute('DROP TABLE IF EXISTS whoop_resource_access');
    await e.db.raw.execute('ALTER TABLE user_whoop_tokens DROP COLUMN auth_generation');
    await e.db.raw.execute('DELETE FROM schema_version WHERE version >= 16');
    await e.db.raw.execute("INSERT OR IGNORE INTO schema_version (version, applied_at, note) VALUES (15, '2026-09-15T00:00:00.000Z', 'v15')");

    const s = await runMigrations(e.db.raw);
    assert.equal(s.from, 15); assert.equal(s.to, SCHEMA_VERSION); assert.equal(SCHEMA_VERSION, 25);
    assert.deepEqual(s.rebuilt, []);
    assert.deepEqual(s.columnsAdded, ['user_whoop_tokens.auth_generation']);
    assert.equal(await e.db.getAuthGeneration(u.id), 1, '★ 既有 token 列預設世代 1');
    assert.equal((await e.db.getTokens(u.id)).whoopUserId, 'WM', '★ token 內容不動');
    // ★ R2 / LIFE-FG-10：v18 把未經目前啟用世代驗證的 READY 移進重新驗證。
    assert.equal((await e.db.getOnboardingRow(u.id)).state, ONBOARDING_STATE.WHOOP_AUTHORIZED);
    const tables = (await e.db.raw.execute("SELECT name FROM sqlite_master WHERE type='table'")).rows.map((r) => String(r.name));
    assert.ok(tables.includes('whoop_resource_access'));

    for (let i = 0; i < 3; i += 1) {
      const s2 = await runMigrations(e.db.raw);
      assert.deepEqual(s2.columnsAdded, []); assert.deepEqual(s2.rebuilt, []);
      assert.deepEqual(s2.dataMigrations, []);
    }
    // 中斷：欄位加了但表還沒建
    await e.db.raw.execute('DROP TABLE whoop_resource_access');
    await e.db.raw.execute('DELETE FROM schema_version WHERE version >= 16');
    const s3 = await runMigrations(e.db.raw);
    assert.deepEqual(s3.columnsAdded, []);
    const tables2 = (await e.db.raw.execute("SELECT name FROM sqlite_master WHERE type='table'")).rows.map((r) => String(r.name));
    assert.ok(tables2.includes('whoop_resource_access'));
  } finally { e.done(); }
});

test('遷移：全新資料庫直接到 v16，不會憑空產生上線列或權限判定', async () => {
  const e = await env();
  try {
    assert.equal((await e.db.raw.execute('SELECT COUNT(*) n FROM user_onboarding')).rows[0].n, 0);
    assert.equal((await e.db.raw.execute('SELECT COUNT(*) n FROM whoop_resource_access')).rows[0].n, 0);
    const s = await runMigrations(e.db.raw);
    assert.deepEqual(s.dataMigrations ?? [], []);
    assert.equal(SCHEMA_VERSION, 25);
  } finally { e.done(); }
});
