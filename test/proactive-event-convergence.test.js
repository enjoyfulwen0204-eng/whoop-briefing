/**
 * 主動事件的終局收斂（M-03）。
 *
 * ## 修的是什麼
 *
 * 收割器只看得到 pending_questions 的 OPEN 與 EXPIRED。ANSWERED 與
 * SUPERSEDED 是**刻意**排除的（對它們寫 NO_RESPONSE 會是事實錯誤），
 * 但這也代表兩種真實情況會讓 `proactive_events.outcome` 永遠停在 NULL：
 *
 *   1. **澄清追問的兩段寫入。** router 在聽不懂使用者的回答時會先把 Q1
 *      收成 ANSWERED，再開一個 Q2。中間 process 死掉的話 Q2 從來不存在，
 *      而 Q1 已經是 ANSWERED —— 沒有任何人會再回來收尾。
 *   2. **被取代（SUPERSEDED）。** 這題還沒被回答就被新的追問取代了。
 *
 * 實測：兩種狀態下把收割器連跑三次，事件都還是 NULL。後果是 Guardian
 * 每 12 小時誤報一次「有事件卡住」，而且**永遠**不會消失 —— 假警報會很快
 * 讓人開始忽略真警報。
 *
 * ## 現在的不變量
 *
 *   **每一個送出過的主動事件都必須能走到一個終局結果。**
 *
 * 而且那個結果必須是**誠實**的：使用者真的回了就是 ABANDONED，被取代
 * 就是 SUPERSEDED，絕不一律塞 NO_RESPONSE（那會污染 proactivePolicy
 * 未來要拿來調門檻的統計）。
 *
 * ## 安全條件
 *
 * 收斂**不可以**跟一個正在處理中的請求打架：只有在「沒有任何 OPEN 的
 * 追問還指著這個事件」而且「事件送出已經超過 grace」時才動手。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createDb } from '../src/db.js';
import { reapExpiredProactiveQuestions } from '../src/proactiveReaper.js';
import {
  PROACTIVE_DECISION, PROACTIVE_OUTCOME, PROACTIVE_QUESTION_INTENT,
} from '../src/schema.js';
import { ANTI_SPAM_POLICY } from '../src/proactivePolicy.js';
import { TELEGRAM_BOT } from '../src/config.js';
import { ALICE, BOB, seedAliceAndBob } from './users.js';

const T0 = new Date('2026-09-09T07:00:00Z');
const later = (ms) => new Date(T0.getTime() + ms);
const AFTER_GRACE = later(TELEGRAM_BOT.PENDING_TTL_MS + ANTI_SPAM_POLICY.QUESTION_TTL_MS + 60_000);

async function withDb(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm03-'));
  const db = createDb({ url: `file:${path.join(dir, 't.db')}` });
  try {
    await db.migrate();
    await seedAliceAndBob(db);
    await fn(db);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function ask(db, user, { key = 'k1', now = T0 } = {}) {
  const claim = await db.claimProactiveEvent(user.id, {
    healthDate: '2026-09-09', idempotencyKey: key,
    signals: [{ code: 'HRV_LOW', metric: 'hrv' }],
    decision: PROACTIVE_DECISION.ASK_CONTEXT,
    reason: {}, policyVersion: 'p1', messageText: '昨天有喝酒嗎？',
  }, { now });
  const questionId = await db.openPendingQuestion(user.id, {
    chatId: user.chatId, question: '昨天有喝酒嗎？',
    intent: PROACTIVE_QUESTION_INTENT,
    contextJson: { proactive_event_id: claim.id, health_date: '2026-09-09' },
    ttlMs: ANTI_SPAM_POLICY.QUESTION_TTL_MS,
  }, { now });
  await db.markProactiveEventSent(user.id, claim.id, { pendingQuestionId: questionId }, { now });
  return { eventId: claim.id, questionId };
}

const outcomeOf = async (db, userId, eventId) => {
  const rs = await db.raw.execute({
    sql: 'SELECT outcome, resolved_at FROM proactive_events WHERE user_id = ? AND id = ?',
    args: [userId, eventId],
  });
  return rs.rows[0] ?? null;
};

// ===========================================================================
// ★★★ 兩種卡死狀態都必須收斂
// ===========================================================================

test('★★★ M-03: Q1 收成 ANSWERED 之後崩潰（Q2 從未產生）→ 收斂成 ABANDONED', async () => {
  await withDb(async (db) => {
    const { eventId, questionId } = await ask(db, ALICE);
    // router 的第一段寫入完成……
    await db.resolvePendingQuestion(ALICE.id, questionId, '嗯嗯', { now: later(60_000) });
    // ……第二段（openPendingQuestion Q2）從來沒有發生：process 死了

    // 收割器跑很多次都救不回來 —— 這正是舊版的行為
    let res;
    for (let i = 0; i < 3; i += 1) {
      res = await reapExpiredProactiveQuestions({ db, userId: ALICE.id, now: AFTER_GRACE });
    }
    const row = await outcomeOf(db, ALICE.id, eventId);
    assert.equal(row.outcome, PROACTIVE_OUTCOME.ABANDONED, '★ 必須有終局，不可以停在 NULL');
    assert.ok(row.resolved_at, '★ resolved_at 也要寫');
    assert.deepEqual(
      { superseded: res.superseded, abandoned: res.abandoned, noResponse: res.noResponse },
      { superseded: 0, abandoned: 0, noResponse: 0 },
      '第三次應該完全沒有工作（冪等、收斂到零）',
    );
  });
});

test('★★★ M-03: 被新追問取代 → 收斂成 SUPERSEDED，不是 NO_RESPONSE', async () => {
  await withDb(async (db) => {
    const first = await ask(db, ALICE, { key: 'k1' });
    await ask(db, ALICE, { key: 'k2', now: later(1000) });   // 把第一題 SUPERSEDE 掉

    await reapExpiredProactiveQuestions({ db, userId: ALICE.id, now: AFTER_GRACE });
    const row = await outcomeOf(db, ALICE.id, first.eventId);
    assert.equal(row.outcome, PROACTIVE_OUTCOME.SUPERSEDED);
    assert.notEqual(row.outcome, PROACTIVE_OUTCOME.NO_RESPONSE,
      '★ 被取代不等於沒回應——混為一談會污染反騷擾政策的統計');
  });
});

test('★★★ M-03: 收斂之後 Guardian 不再看到卡住的事件', async () => {
  await withDb(async (db) => {
    const a = await ask(db, ALICE, { key: 'k1' });
    await db.resolvePendingQuestion(ALICE.id, a.questionId, '嗯', { now: later(60_000) });
    const b = await ask(db, ALICE, { key: 'k2', now: later(2000) });
    await ask(db, ALICE, { key: 'k3', now: later(3000) });   // 把 b SUPERSEDE 掉

    const before = await db.countStuckProactiveEvents(ALICE.id, {
      olderThanIso: AFTER_GRACE.toISOString(),
    });
    assert.ok(before.count >= 2, `前置：Guardian 確實看到卡住的事件（${before.count}）`);

    await reapExpiredProactiveQuestions({ db, userId: ALICE.id, now: AFTER_GRACE });

    const after = await db.countStuckProactiveEvents(ALICE.id, {
      olderThanIso: AFTER_GRACE.toISOString(),
    });
    assert.equal(after.count, 0, '★ 收割之後不可以再有任何卡住的事件');
    assert.ok(!Number.isNaN(Number(a.eventId)) && !Number.isNaN(Number(b.eventId)));
  });
});

// ===========================================================================
// ★★★ 安全條件：絕不跟正在處理中的流程打架
// ===========================================================================

test('★★★ M-03: 澄清追問 Q2 還開著 → 事件絕不可以被提前收斂', async () => {
  await withDb(async (db) => {
    const { eventId, questionId } = await ask(db, ALICE);
    await db.resolvePendingQuestion(ALICE.id, questionId, '嗯嗯', { now: later(60_000) });
    // Q2：澄清追問，context 沿用同一個 event id（欄位連結仍然指著 Q1）
    await db.openPendingQuestion(ALICE.id, {
      chatId: ALICE.chatId, question: '可以說得更清楚一點嗎？',
      intent: PROACTIVE_QUESTION_INTENT,
      contextJson: { proactive_event_id: eventId, clarified: true },
      ttlMs: ANTI_SPAM_POLICY.QUESTION_TTL_MS,
    }, { now: later(61_000) });

    // Q2 還在 TTL 內
    const res = await reapExpiredProactiveQuestions({
      db, userId: ALICE.id, now: later(TELEGRAM_BOT.PENDING_TTL_MS + 5000),
    });
    assert.equal(res.abandoned, 0, '★ 還有 OPEN 的追問指著它，不可以收斂');
    assert.equal((await outcomeOf(db, ALICE.id, eventId)).outcome, null);
  });
});

test('★★★ M-03: grace 之內不收斂（不跟正在處理的請求打架）', async () => {
  await withDb(async (db) => {
    const { eventId, questionId } = await ask(db, ALICE);
    await db.resolvePendingQuestion(ALICE.id, questionId, '嗯', { now: later(1000) });

    // 才剛送出 1 秒，遠在 grace 之內
    const res = await reapExpiredProactiveQuestions({
      db, userId: ALICE.id, now: later(2000),
    });
    assert.equal(res.abandoned, 0);
    assert.equal((await outcomeOf(db, ALICE.id, eventId)).outcome, null,
      '★ grace 之內絕不動手——正常流程可能正在跑');
  });
});

test('★★ M-03: 從未送出的事件不會被收斂（沒送出就沒有人該回答）', async () => {
  await withDb(async (db) => {
    const claim = await db.claimProactiveEvent(ALICE.id, {
      healthDate: '2026-09-09', idempotencyKey: 'never-sent',
      signals: [], decision: PROACTIVE_DECISION.LOG_ONLY,
      reason: {}, policyVersion: 'p1', messageText: null,
    }, { now: T0 });
    // 刻意不呼叫 markProactiveEventSent

    const res = await reapExpiredProactiveQuestions({ db, userId: ALICE.id, now: AFTER_GRACE });
    assert.equal(res.abandoned + res.superseded, 0);
    assert.equal((await outcomeOf(db, ALICE.id, claim.id)).outcome, null);
  });
});

// ===========================================================================
// ★★★ 已經定案的結果永遠不被覆寫
// ===========================================================================

test('★★★ M-03: 已經有結果的事件不會被第二輪覆寫', async () => {
  await withDb(async (db) => {
    const { eventId, questionId } = await ask(db, ALICE);
    await db.resolvePendingQuestion(ALICE.id, questionId, '有喝', { now: later(60_000) });
    await db.resolveProactiveEvent(ALICE.id, eventId, PROACTIVE_OUTCOME.EXPLAINED, {
      now: later(61_000),
    });

    const res = await reapExpiredProactiveQuestions({ db, userId: ALICE.id, now: AFTER_GRACE });
    assert.equal(res.abandoned, 0);
    assert.equal((await outcomeOf(db, ALICE.id, eventId)).outcome, PROACTIVE_OUTCOME.EXPLAINED,
      '★ 真實的結論絕不可以被維護工作蓋掉');
  });
});

// ===========================================================================
// ★★★ 多使用者隔離
// ===========================================================================

test('★★★ M-03: 收斂絕不跨使用者', async () => {
  await withDb(async (db) => {
    const a = await ask(db, ALICE, { key: 'a1' });
    await db.resolvePendingQuestion(ALICE.id, a.questionId, '嗯', { now: later(60_000) });
    const b = await ask(db, BOB, { key: 'b1' });
    await db.resolvePendingQuestion(BOB.id, b.questionId, '嗯', { now: later(60_000) });

    await reapExpiredProactiveQuestions({ db, userId: ALICE.id, now: AFTER_GRACE });

    assert.equal((await outcomeOf(db, ALICE.id, a.eventId)).outcome, PROACTIVE_OUTCOME.ABANDONED);
    assert.equal((await outcomeOf(db, BOB.id, b.eventId)).outcome, null,
      '★ Bob 的事件必須完全不受影響');
  });
});

test('★★ M-03: 偽造成別人事件 id 的 context 不會讓別人的事件被收斂', async () => {
  await withDb(async (db) => {
    const bob = await ask(db, BOB, { key: 'b1' });
    // Alice 開一個 context 指著 Bob 事件的問題
    const qid = await db.openPendingQuestion(ALICE.id, {
      chatId: ALICE.chatId, question: '偽造',
      intent: PROACTIVE_QUESTION_INTENT,
      contextJson: { proactive_event_id: bob.eventId },
      ttlMs: ANTI_SPAM_POLICY.QUESTION_TTL_MS,
    }, { now: T0 });
    await db.resolvePendingQuestion(ALICE.id, qid, '嗯', { now: later(60_000) });

    await reapExpiredProactiveQuestions({ db, userId: ALICE.id, now: AFTER_GRACE });
    assert.equal((await outcomeOf(db, BOB.id, bob.eventId)).outcome, null,
      '★ context 裡的事件 id 絕不可信');
  });
});

// ===========================================================================
// 韌性
// ===========================================================================

test('★★ M-03: 壞掉的 context_json 不會讓收斂查詢整個失敗', async () => {
  await withDb(async (db) => {
    const a = await ask(db, ALICE, { key: 'a1' });
    await db.resolvePendingQuestion(ALICE.id, a.questionId, '嗯', { now: later(60_000) });
    await db.raw.execute({
      sql: "UPDATE pending_questions SET context_json = '{壞掉' WHERE id = ?",
      args: [a.questionId],
    });

    const res = await reapExpiredProactiveQuestions({ db, userId: ALICE.id, now: AFTER_GRACE });
    // 欄位連結仍然權威，所以還是收斂得了；重點是**不拋錯**
    assert.equal(res.abandoned, 1);
  });
});

test('★★ M-03: 舊 fake（沒有新 store 函式）安全跳過，不拋錯', async () => {
  const res = await reapExpiredProactiveQuestions({ db: {}, userId: 'u-x', now: AFTER_GRACE });
  assert.deepEqual(res, {
    expired: 0, repaired: 0, noResponse: 0,
    superseded: 0, abandoned: 0, delivered: 0, skipped: 0,
  });
});

test('★★ M-03: 收斂查詢失敗不會讓收割器拋錯', async () => {
  await withDb(async (db) => {
    const broken = {
      ...db,
      listUnresolvableProactiveEvents: async () => { throw new Error('boom'); },
    };
    const res = await reapExpiredProactiveQuestions({
      db: broken, userId: ALICE.id, now: AFTER_GRACE,
    });
    assert.ok(res && typeof res.abandoned === 'number');
  });
});
