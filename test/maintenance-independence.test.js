/**
 * 純 DB 維護不依賴 WHOOP 授權或 Telegram 綁定（R2-M-06）。
 *
 * ## 修的是什麼
 *
 * 過期追問／卡住事件的收斂完全不需要 WHOOP token，也不需要能送 Telegram
 * —— 它只是把資料庫裡的狀態機推向終局。但舊版把它放在流程中段與尾端，
 * 於是兩條路徑會整個跳過它：
 *
 *   WHOOP 授權失敗       → `return out`（在 reaper 之前）
 *   沒有 Telegram 綁定   → `return out`（更早）
 *
 * 實測確認：兩種情況下 `reaped` 都是 null、事件 outcome 永遠停在 NULL，
 * Guardian 的 stuck 計數維持 1。WHOOP 一旦掛久一點，那個假警報就永遠
 * 不會消失 —— 而且**正是在系統最需要可信監看的時候**。
 *
 * ## 現在的不變量
 *
 *   資料庫狀態的維護與收斂，不依賴：
 *     - WHOOP token 是否有效
 *     - 有沒有可遞送的 Telegram 目的地
 *
 * 它是 runForUser 的**第一步**，在任何 early return 之前。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createDb } from '../src/db.js';
import { runForUser } from '../src/index.js';
import { LINK_STATUS, PROACTIVE_QUESTION_INTENT } from '../src/schema.js';

const NOW = new Date('2026-09-11T00:00:00Z');
const SENT = new Date(NOW.getTime() - 72 * 3600_000);

const ENV = {
  telegramBotToken: 'T', tursoUrl: 'file:x', tursoToken: 't',
  whoopClientId: 'c', whoopClientSecret: 's',
  openrouterApiKey: 'k', openrouterModel: 'm',
  timezone: 'Asia/Taipei', dryRun: false,
};

/**
 * 一個有「需要收斂的過期主動問題」的使用者。
 * @param {boolean} link 要不要綁 Telegram
 */
async function setup({ link = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r2m06-'));
  const db = createDb({ url: `file:${path.join(dir, 't.db')}` });
  await db.migrate();
  const user = await db.createUser({ displayName: 'K', timezone: 'Asia/Taipei' });
  if (link) await db.linkTelegram({ chatId: '9001', userId: user.id });
  await db.saveTokens(user.id, {
    accessToken: 'a', refreshToken: 'r',
    expiresAt: new Date(NOW.getTime() + 3600_000), scope: 's', whoopUserId: '111',
  });
  const { id: eventId } = await db.claimProactiveEvent(user.id, {
    healthDate: '2026-09-08', idempotencyKey: 'k1', signals: [],
    decision: 'ASK_CONTEXT', reason: {}, policyVersion: 'v1', messageText: 'q',
  }, { now: SENT });
  const qid = await db.openPendingQuestion(user.id, {
    chatId: '9001', question: 'q', intent: PROACTIVE_QUESTION_INTENT,
    contextJson: { proactive_event_id: eventId }, ttlMs: 30 * 60_000,
  }, { now: SENT });
  await db.markProactiveEventSent(user.id, eventId, { pendingQuestionId: qid }, { now: SENT });
  return {
    db, user, eventId,
    cleanup: () => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

const deps = ({ authFails = false, calls = [] } = {}) => ({
  makeTelegram: () => ({
    async send(t) { calls.push({ k: 'send', t }); },
    async notifyError(type) { calls.push({ k: 'notifyError', type }); },
  }),
  makeWhoop: () => ({
    async getAccessToken() {
      calls.push({ k: 'whoop.token' });
      if (authFails) throw new Error('refresh token invalid');
      return 'a';
    },
  }),
  makeCoach: () => ({}),
  makeSource: () => ({}),
  daily: async () => { calls.push({ k: 'daily' }); return { status: 'skipped' }; },
  weekly: async () => { calls.push({ k: 'weekly' }); return { status: 'skipped' }; },
  makeSync: () => ({ async syncAll() { calls.push({ k: 'sync' }); return []; } }),
  proactive: async () => { calls.push({ k: 'proactive' }); return { triggered: false }; },
  predictionCycle: async () => null,
  healthspan: async () => null,
});

const outcomeOf = async (db, eventId) => (await db.raw.execute({
  sql: 'SELECT outcome FROM proactive_events WHERE id = ?', args: [eventId],
})).rows[0].outcome;

// ===========================================================================
// ★★★ WHOOP 授權失敗
// ===========================================================================

test('★★★ R2-M-06: WHOOP 授權失敗時，過期問題仍然收斂', async () => {
  const s = await setup();
  try {
    const out = await runForUser({
      db: s.db, env: ENV, user: { id: s.user.id, timezone: 'Asia/Taipei' },
      now: NOW, deps: deps({ authFails: true }),
    });
    assert.ok(out.reaped, '★ 維護結果一定要有');
    assert.equal(out.reaped.noResponse, 1);
    assert.equal(await outcomeOf(s.db, s.eventId), 'NO_RESPONSE');
    assert.ok(out.errors.some((e) => e.stage === 'whoop_auth'),
      '前置：授權確實失敗了');
  } finally { s.cleanup(); }
});

test('★★★ R2-M-06: WHOOP 連續多輪失敗，Guardian 的 stuck 計數回到 0', async () => {
  const s = await setup();
  try {
    const before = await s.db.countStuckProactiveEvents(s.user.id, {
      olderThanIso: NOW.toISOString(),
    });
    assert.equal(before.count, 1, '前置：確實有一個卡住的事件');

    for (let i = 0; i < 3; i += 1) {
      await runForUser({
        db: s.db, env: ENV, user: { id: s.user.id, timezone: 'Asia/Taipei' },
        now: NOW, deps: deps({ authFails: true }),
      });
    }
    const after = await s.db.countStuckProactiveEvents(s.user.id, {
      olderThanIso: NOW.toISOString(),
    });
    assert.equal(after.count, 0,
      '★ WHOOP 掛掉期間 Guardian 不可以一直誤報「有事件卡住」');
  } finally { s.cleanup(); }
});

test('★★★ R2-M-06: 授權恢復之後，一切照常（維護不會擋住主流程）', async () => {
  const s = await setup();
  try {
    await runForUser({
      db: s.db, env: ENV, user: { id: s.user.id, timezone: 'Asia/Taipei' },
      now: NOW, deps: deps({ authFails: true }),
    });
    const calls = [];
    const out = await runForUser({
      db: s.db, env: ENV, user: { id: s.user.id, timezone: 'Asia/Taipei' },
      now: NOW, deps: deps({ authFails: false, calls }),
    });
    assert.ok(calls.some((c) => c.k === 'whoop.token'), '★ 授權恢復後要繼續跑');
    assert.ok(out.reaped, '維護仍然每一輪都跑');
  } finally { s.cleanup(); }
});

// ===========================================================================
// ★★★ 沒有 Telegram 綁定
// ===========================================================================

test('★★★ R2-M-06: 沒有 Telegram 綁定時，過期問題仍然收斂', async () => {
  const s = await setup({ link: false });
  try {
    const out = await runForUser({
      db: s.db, env: ENV, user: { id: s.user.id, timezone: 'Asia/Taipei' },
      now: NOW, deps: deps(),
    });
    assert.equal(out.skipped, 'no_active_telegram_link');
    assert.ok(out.reaped);
    assert.equal(await outcomeOf(s.db, s.eventId), 'NO_RESPONSE');
  } finally { s.cleanup(); }
});

test('★★★ R2-M-06: 沒有綁定時絕不觸發任何需要對外的工作', async () => {
  const s = await setup({ link: false });
  try {
    const calls = [];
    await runForUser({
      db: s.db, env: ENV, user: { id: s.user.id, timezone: 'Asia/Taipei' },
      now: NOW, deps: deps({ calls }),
    });
    assert.deepEqual(calls, [],
      '★ WHOOP / 同步 / 報告 / 主動代理 / Telegram 一個都不可以被觸發');
  } finally { s.cleanup(); }
});

test('★★★ R2-M-06: 只有群組綁定（不安全）時，維護照跑而且順手退役那筆綁定', async () => {
  const s = await setup({ link: false });
  try {
    await s.db.raw.execute({
      sql: `INSERT INTO user_telegram (telegram_chat_id, user_id, linked_at, status)
            VALUES ('-100500', ?, ?, 'ACTIVE')`,
      args: [s.user.id, '2026-01-01T00:00:00.000Z'],
    });
    const out = await runForUser({
      db: s.db, env: ENV, user: { id: s.user.id, timezone: 'Asia/Taipei' },
      now: NOW, deps: deps(),
    });
    assert.equal(out.skipped, 'no_active_telegram_link');
    assert.ok(out.reaped, '★ 維護照跑');
    assert.equal((await s.db.getTelegramLink('-100500')).status, LINK_STATUS.RETIRED_UNSAFE,
      '★ 順手把不安全的綁定退役（R2-H-01 的全域收斂）');
  } finally { s.cleanup(); }
});

// ===========================================================================
// ★★★ 維護自己的失敗隔離
// ===========================================================================

test('★★★ R2-M-06: 收割失敗不會擋住主流程', async () => {
  const s = await setup();
  try {
    const calls = [];
    const out = await runForUser({
      db: s.db, env: ENV, user: { id: s.user.id, timezone: 'Asia/Taipei' },
      now: NOW,
      deps: {
        ...deps({ calls }),
        reap: async () => { throw new Error('reaper boom'); },
      },
    });
    assert.ok(out.errors.some((e) => e.stage === 'reap'), '★ 錯誤要被記下來');
    assert.ok(calls.some((c) => c.k === 'whoop.token'),
      '★ 但主流程必須繼續（維護是背景工作）');
  } finally { s.cleanup(); }
});

test('★★★ R2-M-06: 退役綁定失敗不會擋住收割（兩項互相隔離）', async () => {
  const s = await setup();
  try {
    const broken = {
      ...s.db,
      retireUnsafeTelegramLinks: async () => { throw new Error('retire boom'); },
    };
    const out = await runForUser({
      db: broken, env: ENV, user: { id: s.user.id, timezone: 'Asia/Taipei' },
      now: NOW, deps: deps(),
    });
    assert.ok(out.reaped, '★ 收割仍然完成');
    assert.equal(await outcomeOf(s.db, s.eventId), 'NO_RESPONSE');
    assert.ok(out.errors.some((e) => e.stage === 'retire_unsafe_links'));
  } finally { s.cleanup(); }
});

// ===========================================================================
// ★★★ 維護是第一步（在所有 early return 之前）
// ===========================================================================

test('★★★ R2-M-06: 「完全沒事做」的那一輪也會跑維護', async () => {
  const s = await setup();
  try {
    // 先把所有報告標成已送出 → nothing_due
    const out = await runForUser({
      db: s.db, env: ENV, user: { id: s.user.id, timezone: 'Asia/Taipei' },
      now: NOW, deps: deps(),
    });
    assert.ok(out.reaped, '★ 不管走哪一條路，維護都要跑到');
  } finally { s.cleanup(); }
});

test('★★ R2-M-06: 維護結果被明確回報（運維看得到它真的跑了）', async () => {
  const s = await setup();
  try {
    const out = await runForUser({
      db: s.db, env: ENV, user: { id: s.user.id, timezone: 'Asia/Taipei' },
      now: NOW, deps: deps({ authFails: true }),
    });
    assert.ok(out.maintenance, '★ 要有 maintenance 區塊');
    assert.ok(out.maintenance.reaped);
    assert.equal(typeof out.maintenance.retiredLinks, 'number');
  } finally { s.cleanup(); }
});

// ===========================================================================
// ★★★ 多使用者
// ===========================================================================

test('★★★ R2-M-06: Alice 的 WHOOP 掛掉不影響 Bob 的維護', async () => {
  const s = await setup();
  try {
    const bob = await s.db.createUser({ displayName: 'Bob', timezone: 'Asia/Taipei' });
    await s.db.linkTelegram({ chatId: '9002', userId: bob.id });
    const { id: bobEvent } = await s.db.claimProactiveEvent(bob.id, {
      healthDate: '2026-09-08', idempotencyKey: 'b1', signals: [],
      decision: 'ASK_CONTEXT', reason: {}, policyVersion: 'v1', messageText: 'q',
    }, { now: SENT });
    const bq = await s.db.openPendingQuestion(bob.id, {
      chatId: '9002', question: 'q', intent: PROACTIVE_QUESTION_INTENT,
      contextJson: { proactive_event_id: bobEvent }, ttlMs: 30 * 60_000,
    }, { now: SENT });
    await s.db.markProactiveEventSent(bob.id, bobEvent, { pendingQuestionId: bq }, { now: SENT });

    await runForUser({
      db: s.db, env: ENV, user: { id: s.user.id, timezone: 'Asia/Taipei' },
      now: NOW, deps: deps({ authFails: true }),
    });
    // Alice 收斂了，Bob 還沒被處理過
    assert.equal(await outcomeOf(s.db, s.eventId), 'NO_RESPONSE');
    assert.equal(await outcomeOf(s.db, bobEvent), null, '★ 不可以跨使用者收割');

    await runForUser({
      db: s.db, env: ENV, user: { id: bob.id, timezone: 'Asia/Taipei' },
      now: NOW, deps: deps(),
    });
    assert.equal(await outcomeOf(s.db, bobEvent), 'NO_RESPONSE');
  } finally { s.cleanup(); }
});
