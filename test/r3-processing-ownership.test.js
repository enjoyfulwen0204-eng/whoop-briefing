/**
 * 處理所有權必須先於狀態翻轉（R3-M-03）。
 *
 * ## R2 修掉的和沒修掉的
 *
 * R2 已經讓「處理中」變成一個原子、有時效的事實（resource_locks 租約），
 * 而且收割器會在同一句 SQL 裡重新確認租約。那些都還在。
 *
 * 但 R2 的順序是：
 *
 *     resolvePendingQuestion(→ ANSWERED)   ← 狀態已經翻了
 *     ... 幾行程式 ...
 *     acquireLock(事件租約)                 ← 這裡才宣告所有權
 *
 * 這兩步之間有一個窗口：追問已經不是 OPEN，租約還沒有人拿。收割器的孤兒
 * 判準「送出很久了、沒有 OPEN 的追問指著它、沒有人持有租約」在那個瞬間
 * **完全成立**。實測重現：事件被寫成 ABANDONED，處理流程接著照樣寫了
 * Journal —— 一筆沒有任何人擁有的變更。
 *
 * 第二個窗口在後面：租約可能在 LLM 解析期間過期，收割器合法地把事件推向
 * 終局，而處理流程醒來之後仍然去改 Journal。
 *
 * ## 現在的不變量
 *
 *   1. **所有權先於狀態翻轉**：拿不到所有權就不碰追問狀態，也不產生任何
 *      副作用。順序反過來之後，那個窗口在結構上不存在。
 *   2. **租約機制壞掉 = 拿不到所有權**（fail closed）。不知道有沒有別人
 *      在處理的時候，正確的行為是不處理。
 *   3. **每一個副作用之前重新確認所有權**（stillOwns fence）—— 尤其是
 *      Journal 寫入。所有權掉了就不寫。
 *
 * 代價很小：追問狀態沒有被翻轉，所以使用者的回答沒有遺失，再講一次就會
 * 被正常處理。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createDb } from '../src/db.js';
import { createRouter } from '../src/bot/router.js';
import { reapExpiredProactiveQuestions } from '../src/proactiveReaper.js';
import { PROACTIVE_PROCESSING_LEASE } from '../src/proactivePolicy.js';
import {
  PROACTIVE_OUTCOME, PROACTIVE_QUESTION_INTENT, PROACTIVE_DECISION,
} from '../src/schema.js';

const NOW = new Date('2026-09-11T00:00:00Z');
const SENT = new Date(NOW.getTime() - 48 * 3600_000);

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r3m03-'));
  const db = createDb({ url: `file:${path.join(dir, 't.db')}` });
  return { db, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/**
 * 追問 TTL 用 96 小時。72 小時的話追問剛好在 NOW 這一刻過期，走的是
 * EXPIRED 路徑而不是我們要測的競態路徑。
 */
async function withSetup(fn, { questionTtlMs = 96 * 3600_000 } = {}) {
  const { db, cleanup } = tempDb();
  try {
    await db.migrate();
    const user = await db.createUser({ displayName: 'K', timezone: 'Asia/Taipei' });
    const { id: eventId } = await db.claimProactiveEvent(user.id, {
      healthDate: '2026-09-08', idempotencyKey: 'k1',
      signals: [{ metric: 'hrv', direction: 'low' }],
      decision: PROACTIVE_DECISION.ASK_CONTEXT, reason: {},
      policyVersion: 'v1', messageText: '昨天有喝酒嗎？',
    }, { now: SENT });
    const questionId = await db.openPendingQuestion(user.id, {
      chatId: '1', question: '昨天有喝酒嗎？', intent: PROACTIVE_QUESTION_INTENT,
      contextJson: {
        proactive_event_id: eventId, health_date: '2026-09-08',
        question_target_date: '2026-09-07', signal: { metric: 'hrv', direction: 'low' },
      },
      ttlMs: questionTtlMs,
    }, { now: SENT });
    await db.markProactiveEventSent(user.id, eventId, { pendingQuestionId: questionId }, { now: SENT });
    await fn({ db, user, eventId, questionId });
  } finally {
    db.close();
    cleanup();
  }
}

const outcomeOf = async (db, userId, eventId) => (await db.raw.execute({
  sql: 'SELECT outcome FROM proactive_events WHERE user_id = ? AND id = ?',
  args: [userId, eventId],
})).rows[0]?.outcome ?? null;

const journalCount = async (db, userId) => (await db.getJournalEvents(
  userId, { from: '2026-09-01', to: '2026-09-30', limit: 50 },
)).length;

const parsingCoach = () => ({
  async json() {
    return { category: 'alcohol', subtype: 'beer', numeric_value: 2, unit: 'cup', confidence: 0.9 };
  },
  async ask() { return null; },
});

// ===========================================================================
// ★★★ 核心：所有權先於狀態翻轉
// ===========================================================================

test('★★★ R3-M-03: 追問翻成 ANSWERED 的同時，事件租約已經被持有', async () => {
  await withSetup(async ({ db, user, eventId }) => {
    let lockedAtFlip = null;
    // 在追問狀態翻轉的**那一刻**觀察租約有沒有人拿。
    const spy = {
      ...db,
      async resolvePendingQuestion(...args) {
        lockedAtFlip = !await db.acquireLock(
          PROACTIVE_PROCESSING_LEASE.name(user.id, eventId), { ttlMs: 60_000, now: NOW },
        );
        return db.resolvePendingQuestion(...args);
      },
    };
    const router = createRouter({ db: spy, coachFor: parsingCoach, now: () => NOW });
    await router.handle({
      text: '有，喝了兩杯', chatId: '1', user: { id: user.id, timezone: 'Asia/Taipei' },
    });
    assert.equal(lockedAtFlip, true,
      '★ 狀態翻轉時租約必須已經被持有 —— 否則 SELECT 與租約之間就有窗口');
  });
});

test('★★★ R3-M-03: 收割器插在認領之後 → 不可以把正在處理的事件判成孤兒', async () => {
  await withSetup(async ({ db, user, eventId }) => {
    let reaped = null;
    const spy = {
      ...db,
      async resolvePendingQuestion(...args) {
        const claimed = await db.resolvePendingQuestion(...args);
        // 追問剛翻成 ANSWERED —— R2 的窗口正好在這裡。
        reaped = await reapExpiredProactiveQuestions({ db, userId: user.id, now: NOW });
        return claimed;
      },
    };
    const router = createRouter({ db: spy, coachFor: parsingCoach, now: () => NOW });
    const reply = await router.handle({
      text: '有，喝了兩杯', chatId: '1', user: { id: user.id, timezone: 'Asia/Taipei' },
    });

    assert.equal(reaped.abandoned, 0, '★ 正在被處理的事件不可以被 ABANDONED');
    assert.equal(reaped.skipped, 1, '★ 收割器應該明確跳過（看見租約），不是碰巧沒選到');
    assert.notEqual(await outcomeOf(db, user.id, eventId), PROACTIVE_OUTCOME.ABANDONED);
    assert.match(String(reply), /已記錄/, '★ 使用者的回答仍然被正常處理');
  });
});

// ===========================================================================
// ★★★ 副作用前的 fence
// ===========================================================================

test('★★★ R3-M-03: 解析期間所有權掉了 → 不可以再寫 Journal', async () => {
  await withSetup(async ({ db, user, eventId }) => {
    const before = await journalCount(db, user.id);
    const coachFor = () => ({
      async json() {
        // 解析很慢，慢到租約過期，收割器合法地把事件收掉。
        await db.raw.execute({
          sql: 'DELETE FROM resource_locks WHERE name = ?',
          args: [PROACTIVE_PROCESSING_LEASE.name(user.id, eventId)],
        });
        return { category: 'alcohol', subtype: 'beer', numeric_value: 2, unit: 'cup', confidence: 0.9 };
      },
      async ask() { return null; },
    });
    const router = createRouter({ db, coachFor, now: () => NOW });
    const reply = await router.handle({
      text: '有，喝了兩杯', chatId: '1', user: { id: user.id, timezone: 'Asia/Taipei' },
    });

    assert.equal(await journalCount(db, user.id), before,
      '★ 所有權掉了之後不可以再產生 Journal 變更');
    assert.doesNotMatch(String(reply), /已記錄/, '★ 也不可以宣稱記錄成功');
  });
});

test('★★★ R3-M-03: 所有權還在 → Journal 正常寫入（fence 不可以擋掉正常路徑）', async () => {
  await withSetup(async ({ db, user, eventId }) => {
    const before = await journalCount(db, user.id);
    const router = createRouter({ db, coachFor: parsingCoach, now: () => NOW });
    const reply = await router.handle({
      text: '有，喝了兩杯', chatId: '1', user: { id: user.id, timezone: 'Asia/Taipei' },
    });
    assert.equal(await journalCount(db, user.id), before + 1, '★ 正常情況必須寫得進去');
    assert.match(String(reply), /已記錄/);
    assert.ok(await outcomeOf(db, user.id, eventId), '★ 事件要結案');
  });
});

// ===========================================================================
// ★★★ 競爭與失敗模式
// ===========================================================================

test('★★★ R3-M-03: 別人正持有租約 → 不翻轉追問、不產生副作用', async () => {
  await withSetup(async ({ db, user, eventId, questionId }) => {
    const before = await journalCount(db, user.id);
    // 另一個 process 正在處理這個事件。
    await db.acquireLock(PROACTIVE_PROCESSING_LEASE.name(user.id, eventId), {
      ttlMs: 60_000, now: NOW,
    });

    const router = createRouter({ db, coachFor: parsingCoach, now: () => NOW });
    const reply = await router.handle({
      text: '有，喝了兩杯', chatId: '1', user: { id: user.id, timezone: 'Asia/Taipei' },
    });

    assert.equal(await journalCount(db, user.id), before, '★ 不可以有任何 Journal 變更');
    assert.doesNotMatch(String(reply), /已記錄/);
    const q = await db.raw.execute({
      sql: 'SELECT status FROM pending_questions WHERE id = ?', args: [questionId],
    });
    assert.equal(q.rows[0].status, 'OPEN',
      '★ 拿不到所有權就不可以翻轉追問狀態（否則回答就被吃掉了）');
  });
});

test('★★★ R3-M-03: 拿不到所有權之後，重試同一句話會被正常處理', async () => {
  await withSetup(async ({ db, user, eventId }) => {
    const lock = PROACTIVE_PROCESSING_LEASE.name(user.id, eventId);
    await db.acquireLock(lock, { ttlMs: 60_000, now: NOW });
    const router = createRouter({ db, coachFor: parsingCoach, now: () => NOW });
    await router.handle({
      text: '有，喝了兩杯', chatId: '1', user: { id: user.id, timezone: 'Asia/Taipei' },
    });

    // 前一個 process 做完了。
    await db.raw.execute({ sql: 'DELETE FROM resource_locks WHERE name = ?', args: [lock] });
    const retry = await router.handle({
      text: '有，喝了兩杯', chatId: '1', user: { id: user.id, timezone: 'Asia/Taipei' },
    });
    assert.match(String(retry), /已記錄/, '★ 回答不可以永久遺失');
  });
});

test('★★★ R3-M-03: 處理結束後租約一定被釋放（含中途失敗）', async () => {
  await withSetup(async ({ db, user, eventId }) => {
    const coachFor = () => ({
      async json() { throw new Error('LLM 掛了'); },
      async ask() { return null; },
    });
    const router = createRouter({ db, coachFor, now: () => NOW });
    await router.handle({
      text: '有，喝了兩杯', chatId: '1', user: { id: user.id, timezone: 'Asia/Taipei' },
    }).catch(() => {});

    const held = await db.raw.execute({
      sql: 'SELECT name FROM resource_locks WHERE name = ?',
      args: [PROACTIVE_PROCESSING_LEASE.name(user.id, eventId)],
    });
    assert.equal(held.rows.length, 0, '★ 失敗路徑也要放掉租約，否則事件被卡到 TTL');
  });
});

test('★★★ R3-M-03: 所有權「確認」本身壞掉 → 當成沒有所有權（fail closed）', async () => {
  await withSetup(async ({ db, user }) => {
    const before = await journalCount(db, user.id);
    // 租約拿得到，但**檢查**租約還在不在的那個查詢壞了。
    // 這時候我們不知道自己還有沒有所有權 —— 不知道就不可以寫。
    const blind = {
      ...db,
      holdsLock: async () => { throw new Error('lock table unreadable'); },
    };
    const router = createRouter({ db: blind, coachFor: parsingCoach, now: () => NOW });
    const reply = await router.handle({
      text: '有，喝了兩杯', chatId: '1', user: { id: user.id, timezone: 'Asia/Taipei' },
    });

    assert.equal(await journalCount(db, user.id), before,
      '★ 讀不到 ≠ 還持有 —— 不確定的時候不可以產生副作用');
    assert.doesNotMatch(String(reply), /已記錄/);
  });
});

test('★★ R3-M-03: 一般訊息（沒有追問）完全不受所有權機制影響', async () => {
  const { db, cleanup } = tempDb();
  try {
    await db.migrate();
    const user = await db.createUser({ displayName: 'K', timezone: 'Asia/Taipei' });
    const broken = { ...db, acquireLock: async () => { throw new Error('lock table gone'); } };
    const router = createRouter({
      db: broken,
      coachFor: () => ({ async json() { return null; }, async ask() { return '嗨'; } }),
      now: () => NOW,
    });
    const reply = await router.handle({
      text: '今天恢復如何？', chatId: '1', user: { id: user.id, timezone: 'Asia/Taipei' },
    });
    assert.ok(String(reply).length > 0, '★ 沒有追問的訊息不該被所有權機制擋住');
  } finally {
    db.close();
    cleanup();
  }
});
