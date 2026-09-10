/**
 * 正在處理中的事件不可以被孤兒收割（R2-M-03）。
 *
 * ## 修的是什麼
 *
 * 回答流程是：原子認領追問 → 打 LLM 解析（秒級）→ 寫 journal → 重新分析
 * → 結案。收割器的孤兒判準是「送出很久了、沒有 OPEN 的追問指著它」——
 * 一個**正在被處理**的事件剛好完全符合：追問已經是 ANSWERED，而 sent_at
 * 可能是好幾天前（使用者隔天才回）。
 *
 * 實測確認：
 *   認領 → 解析暫停 → 收割器寫 ABANDONED → 回答恢復 → 覆寫成
 *   STILL_UNEXPLAINED。兩個結論都不可信。
 *
 * 把 grace 調長不會關掉這個窗口，只是把它往後推（使用者可以在 TTL 的
 * 最後一秒回答）。
 *
 * ## 現在的不變量
 *
 *   1. 正在被處理的事件**不會**被孤兒收割（處理中是一個明確、有時效、
 *      原子的事實 —— 沿用既有的 resource_locks 租約，零 schema 變更）。
 *   2. 已經定案的終局**永遠不會**被過期的處理流程覆寫（結案改成條件式
 *      寫入 outcome IS NULL）。
 *   3. 收割孤兒時在**同一句 SQL 裡**重新確認租約（不是只在 SELECT 階段
 *      看一次）。
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

/** 真實時間軸：事件 48 小時前送出，使用者「現在」才回答，cron 也在「現在」。 */
const NOW = new Date('2026-09-11T00:00:00Z');
const SENT = new Date(NOW.getTime() - 48 * 3600_000);

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r2m03-'));
  const db = createDb({ url: `file:${path.join(dir, 't.db')}` });
  return { db, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

async function withSetup(fn, { questionTtlMs = 72 * 3600_000, sent = SENT } = {}) {
  const { db, cleanup } = tempDb();
  try {
    await db.migrate();
    const user = await db.createUser({ displayName: 'K', timezone: 'Asia/Taipei' });
    const { id: eventId } = await db.claimProactiveEvent(user.id, {
      healthDate: '2026-09-08', idempotencyKey: 'k1',
      signals: [{ metric: 'hrv', direction: 'low' }],
      decision: PROACTIVE_DECISION.ASK_CONTEXT, reason: {},
      policyVersion: 'v1', messageText: '昨天有喝酒嗎？',
    }, { now: sent });
    const questionId = await db.openPendingQuestion(user.id, {
      chatId: '1', question: '昨天有喝酒嗎？', intent: PROACTIVE_QUESTION_INTENT,
      contextJson: {
        proactive_event_id: eventId, health_date: '2026-09-08',
        question_target_date: '2026-09-07', signal: { metric: 'hrv', direction: 'low' },
      },
      ttlMs: questionTtlMs,
    }, { now: sent });
    await db.markProactiveEventSent(user.id, eventId, { pendingQuestionId: questionId }, { now: sent });
    await fn({ db, user, eventId, questionId });
  } finally {
    db.close();
    cleanup();
  }
}

const outcomeOf = async (db, userId, eventId) => (await db.raw.execute({
  sql: 'SELECT outcome, resolved_at FROM proactive_events WHERE user_id = ? AND id = ?',
  args: [userId, eventId],
})).rows[0];

/** 解析期間讓 `during()` 跑一次（模擬 cron 同時執行）。 */
const racingCoach = (during) => {
  let fired = false;
  return () => ({
    async json() {
      if (!fired) { fired = true; await during(); }
      return {
        category: 'alcohol', subtype: 'beer', numeric_value: 2,
        unit: 'cup', confidence: 0.9,
      };
    },
    async ask() { return null; },
  });
};

// ===========================================================================
// ★★★ 核心競態
// ===========================================================================

test('★★★ R2-M-03: 解析中收割器跑過去 → 事件不被孤兒收割，真實結論保留', async () => {
  await withSetup(async ({ db, user, eventId }) => {
    let reaped = null;
    const coachFor = racingCoach(async () => {
      reaped = await reapExpiredProactiveQuestions({ db, userId: user.id, now: NOW });
    });
    const router = createRouter({ db, coachFor, now: () => NOW });
    await router.handle({
      text: '有，喝了兩杯', chatId: '1', user: { id: user.id, timezone: 'Asia/Taipei' },
    });

    assert.equal(reaped.abandoned, 0, '★ 正在處理的事件不可以被收成 ABANDONED');
    assert.ok(reaped.skipped >= 1, '收割器要明確記下自己跳過了');
    const row = await outcomeOf(db, user.id, eventId);
    assert.equal(row.outcome, PROACTIVE_OUTCOME.STILL_UNEXPLAINED,
      '★ 使用者真的回答了，結論必須是回答帶來的那個');
  });
});

test('★★★ R2-M-03: 租約已過期而事件被收割 → 恢復的流程不可以覆寫終局', async () => {
  await withSetup(async ({ db, user, eventId }) => {
    // 模擬「解析卡了很久，租約過期，收割器settle 了它」：
    // 直接在解析期間手動讓租約過期，再跑收割器。
    const coachFor = racingCoach(async () => {
      await db.raw.execute({
        sql: 'UPDATE resource_locks SET expires_at = ? WHERE name = ?',
        args: [new Date(NOW.getTime() - 1000).toISOString(),
          PROACTIVE_PROCESSING_LEASE.name(user.id, eventId)],
      });
      await reapExpiredProactiveQuestions({ db, userId: user.id, now: NOW });
    });
    const router = createRouter({ db, coachFor, now: () => NOW });
    await router.handle({
      text: '有，喝了兩杯', chatId: '1', user: { id: user.id, timezone: 'Asia/Taipei' },
    });

    const row = await outcomeOf(db, user.id, eventId);
    assert.equal(row.outcome, PROACTIVE_OUTCOME.ABANDONED,
      '★ 已經定案的終局絕不可以被過期的處理流程覆寫');
  });
});

test('★★★ R2-M-03: 收割時在同一句 SQL 裡重新確認租約', async () => {
  await withSetup(async ({ db, user, eventId }) => {
    // 手動持有租約 → 直接呼叫 settle（requireNoLease）必須失敗
    const owner = await db.acquireLock(
      PROACTIVE_PROCESSING_LEASE.name(user.id, eventId),
      { ttlMs: 60_000, now: NOW },
    );
    assert.ok(owner, '前置：租約要拿得到');

    const wroteWithGuard = await db.resolveProactiveEventIfUnresolved(
      user.id, eventId, PROACTIVE_OUTCOME.ABANDONED, { now: NOW, requireNoLease: true },
    );
    assert.equal(wroteWithGuard, false, '★ 有租約時不可以 settle');
    assert.equal((await outcomeOf(db, user.id, eventId)).outcome, null);

    // 租約放掉之後就可以
    await db.releaseLock(PROACTIVE_PROCESSING_LEASE.name(user.id, eventId), owner);
    const wroteAfter = await db.resolveProactiveEventIfUnresolved(
      user.id, eventId, PROACTIVE_OUTCOME.ABANDONED, { now: NOW, requireNoLease: true },
    );
    assert.equal(wroteAfter, true);
  });
});

// ===========================================================================
// ★★★ 兩個處理者
// ===========================================================================

test('★★★ R2-M-03: 兩個 process 同時處理同一個事件 → 只有一個進得去', async () => {
  await withSetup(async ({ db, user, eventId }) => {
    // 另一個 process 已經持有租約
    const other = await db.acquireLock(
      PROACTIVE_PROCESSING_LEASE.name(user.id, eventId),
      { ttlMs: 60_000, now: NOW },
    );
    assert.ok(other);

    let parsed = false;
    const coachFor = () => ({
      async json() { parsed = true; return { category: 'alcohol', confidence: 0.9 }; },
      async ask() { return null; },
    });
    const router = createRouter({ db, coachFor, now: () => NOW });
    const reply = await router.handle({
      text: '有，喝了兩杯', chatId: '1', user: { id: user.id, timezone: 'Asia/Taipei' },
    });

    assert.equal(parsed, false, '★ 拿不到租約就不該做任何處理（連 LLM 都不打）');
    assert.ok(reply && reply.length > 0, '★ 但還是要回一句話，不可以靜默');
    assert.equal((await outcomeOf(db, user.id, eventId)).outcome, null);
  });
});

test('★★ R2-M-03: 處理完成後租約會被釋放（下一次回答不會被卡住）', async () => {
  await withSetup(async ({ db, user, eventId }) => {
    const coachFor = () => ({
      async json() {
        return { category: 'alcohol', subtype: 'beer', numeric_value: 2, unit: 'cup', confidence: 0.9 };
      },
      async ask() { return null; },
    });
    const router = createRouter({ db, coachFor, now: () => NOW });
    await router.handle({
      text: '有，喝了兩杯', chatId: '1', user: { id: user.id, timezone: 'Asia/Taipei' },
    });

    const held = await db.raw.execute({
      sql: 'SELECT 1 FROM resource_locks WHERE name = ? AND expires_at > ?',
      args: [PROACTIVE_PROCESSING_LEASE.name(user.id, eventId), NOW.toISOString()],
    });
    assert.equal(held.rows.length, 0, '★ 租約必須被釋放');
  });
});

// ===========================================================================
// ★★★ 重跑、重啟、重複收割
// ===========================================================================

test('★★★ R2-M-03: 收割器重複跑（含租約過期後）仍然收斂且冪等', async () => {
  await withSetup(async ({ db, user, eventId }) => {
    // 使用者回答過但流程死掉（追問 ANSWERED、事件沒結案、沒有租約）
    await db.resolvePendingQuestion(user.id, (await db.raw.execute({
      sql: 'SELECT id FROM pending_questions WHERE user_id = ?', args: [user.id],
    })).rows[0].id, '嗯', { now: SENT });

    const first = await reapExpiredProactiveQuestions({ db, userId: user.id, now: NOW });
    assert.equal(first.abandoned, 1);
    for (let i = 0; i < 3; i += 1) {
      const again = await reapExpiredProactiveQuestions({ db, userId: user.id, now: NOW });
      assert.equal(again.abandoned, 0, '★ 收斂到零工作量');
      assert.equal(again.noResponse, 0);
    }
    assert.equal((await outcomeOf(db, user.id, eventId)).outcome, PROACTIVE_OUTCOME.ABANDONED);
  });
});

test('★★★ R2-M-03: 兩個收割器同時跑 → 恰好一個寫入', async () => {
  await withSetup(async ({ db, user, eventId }) => {
    const qid = (await db.raw.execute({
      sql: 'SELECT id FROM pending_questions WHERE user_id = ?', args: [user.id],
    })).rows[0].id;
    await db.resolvePendingQuestion(user.id, qid, '嗯', { now: SENT });

    const rs = await Promise.all([
      reapExpiredProactiveQuestions({ db, userId: user.id, now: NOW }),
      reapExpiredProactiveQuestions({ db, userId: user.id, now: NOW }),
    ]);
    const total = rs.reduce((n, r) => n + r.abandoned, 0);
    assert.equal(total, 1, `★ 恰好一次寫入，實際 ${total}`);
    assert.equal((await outcomeOf(db, user.id, eventId)).outcome, PROACTIVE_OUTCOME.ABANDONED);
  });
});

test('★★ R2-M-03: 重啟安全（換一個 db 連線，狀態全在 DB）', async () => {
  const { db, cleanup } = tempDb();
  try {
    await db.migrate();
    const user = await db.createUser({ displayName: 'K', timezone: 'Asia/Taipei' });
    const { id: eventId } = await db.claimProactiveEvent(user.id, {
      healthDate: '2026-09-08', idempotencyKey: 'k1', signals: [],
      decision: PROACTIVE_DECISION.ASK_CONTEXT, reason: {},
      policyVersion: 'v1', messageText: 'q',
    }, { now: SENT });
    const qid = await db.openPendingQuestion(user.id, {
      chatId: '1', question: 'q', intent: PROACTIVE_QUESTION_INTENT,
      contextJson: { proactive_event_id: eventId }, ttlMs: 72 * 3600_000,
    }, { now: SENT });
    await db.markProactiveEventSent(user.id, eventId, { pendingQuestionId: qid }, { now: SENT });
    await db.resolvePendingQuestion(user.id, qid, '嗯', { now: SENT });
    // 一個「死掉的 process」留下的租約，而且已經過期
    await db.acquireLock(PROACTIVE_PROCESSING_LEASE.name(user.id, eventId), {
      ttlMs: 1000, now: new Date(NOW.getTime() - 3600_000),
    });

    const res = await reapExpiredProactiveQuestions({ db, userId: user.id, now: NOW });
    assert.equal(res.abandoned, 1, '★ 過期的租約不可以永久卡住事件');
    assert.equal((await outcomeOf(db, user.id, eventId)).outcome, PROACTIVE_OUTCOME.ABANDONED);
  } finally {
    db.close();
    cleanup();
  }
});

// ===========================================================================
// 既有的收斂路徑不可以退化
// ===========================================================================

test('★★ R2-M-03: 沒有人在處理時，過期／被取代的路徑照常收斂', async () => {
  await withSetup(async ({ db, user, eventId }) => {
    // 追問直接過期（沒有人回答、沒有租約）
    const res = await reapExpiredProactiveQuestions({
      db, userId: user.id, now: new Date(SENT.getTime() + 96 * 3600_000),
    });
    assert.equal(res.noResponse, 1, '★ 問了沒回仍然要收成 NO_RESPONSE');
    assert.equal((await outcomeOf(db, user.id, eventId)).outcome, PROACTIVE_OUTCOME.NO_RESPONSE);
  });
});

// R3-M-03 取代了原本的 R2 版本。R2 當時要求「租約壞掉就照常處理」（fail-open），
// 理由是不要讓維護機制卡死使用者。第三輪的獨立稽核指出那個取捨是錯的：
// 租約壞掉的時候，我們**無法知道**有沒有別人正在處理同一個事件，而收割器
// 也可能同時把它推向終局；照常處理等於在無人擁有的狀態下改 Journal。
//
// 現在的取捨是 fail-closed，而且代價很小 —— 追問狀態不會被翻轉，所以使用者
// 的回答沒有遺失，等一下再講一次就會被正常處理。
test('★★★ R3-M-03: 租約機制不可用 → fail closed，完全沒有副作用', async () => {
  await withSetup(async ({ db, user, eventId }) => {
    const broken = {
      ...db,
      acquireLock: async () => { throw new Error('lock table gone'); },
    };
    const coachFor = () => ({
      async json() {
        return { category: 'alcohol', subtype: 'beer', numeric_value: 2, unit: 'cup', confidence: 0.9 };
      },
      async ask() { return null; },
    });
    const journalCount = async () => (await db.getJournalEvents(
      user.id, { from: '2026-09-01', to: '2026-09-30', limit: 50 },
    )).length;
    const before = await journalCount();
    const router = createRouter({ db: broken, coachFor, now: () => NOW });
    const reply = await router.handle({
      text: '有，喝了兩杯', chatId: '1', user: { id: user.id, timezone: 'Asia/Taipei' },
    });

    assert.doesNotMatch(String(reply), /已記錄/,
      '★ 拿不到所有權就不可以宣稱記錄成功');
    assert.equal(await journalCount(), before, '★ 不可以有任何 Journal 變更');
    assert.equal((await outcomeOf(db, user.id, eventId)).outcome, null,
      '★ 事件不可以被推向終局');

    // 使用者的回答沒有被吃掉：追問還開著，再講一次就會被處理。
    const pending = await db.getOpenPendingQuestion(user.id, { now: NOW });
    assert.ok(pending, '★ 追問必須仍然開著（回答沒有遺失）');

    const healthy = createRouter({ db, coachFor, now: () => NOW });
    const retry = await healthy.handle({
      text: '有，喝了兩杯', chatId: '1', user: { id: user.id, timezone: 'Asia/Taipei' },
    });
    assert.match(String(retry), /已記錄/, '★ 租約恢復之後同一句話要能正常處理');
  });
});

test('★★ R2-M-03: 租約 TTL 是明文政策，而且長於最壞情況的處理時間', () => {
  assert.ok(PROACTIVE_PROCESSING_LEASE.TTL_MS >= 60_000,
    '★ 太短會讓正常的兩次 LLM 呼叫做不完');
  assert.ok(PROACTIVE_PROCESSING_LEASE.TTL_MS <= 30 * 60_000,
    '★ 太長會讓真的死掉的 process 永久卡住事件');
  assert.equal(
    PROACTIVE_PROCESSING_LEASE.name('u1', 7), 'proactive_event:u1:7',
    '★ 租約名稱要 per-user + per-event（不可以是全域鎖）',
  );
});

// ===========================================================================
// ★★★ 多使用者
// ===========================================================================

test('★★★ R2-M-03: Alice 的租約不會擋住 Bob 的事件', async () => {
  await withSetup(async ({ db, user: alice, eventId: aliceEvent }) => {
    const bob = await db.createUser({ displayName: 'Bob', timezone: 'Asia/Taipei' });
    const { id: bobEvent } = await db.claimProactiveEvent(bob.id, {
      healthDate: '2026-09-08', idempotencyKey: 'b1', signals: [],
      decision: PROACTIVE_DECISION.ASK_CONTEXT, reason: {},
      policyVersion: 'v1', messageText: 'q',
    }, { now: SENT });
    const bq = await db.openPendingQuestion(bob.id, {
      chatId: '2', question: 'q', intent: PROACTIVE_QUESTION_INTENT,
      contextJson: { proactive_event_id: bobEvent }, ttlMs: 72 * 3600_000,
    }, { now: SENT });
    await db.markProactiveEventSent(bob.id, bobEvent, { pendingQuestionId: bq }, { now: SENT });
    await db.resolvePendingQuestion(bob.id, bq, '嗯', { now: SENT });

    // Alice 的事件正在被處理
    await db.acquireLock(PROACTIVE_PROCESSING_LEASE.name(alice.id, aliceEvent), {
      ttlMs: 60_000, now: NOW,
    });

    const bobRes = await reapExpiredProactiveQuestions({ db, userId: bob.id, now: NOW });
    assert.equal(bobRes.abandoned, 1, '★ Bob 的收斂不該被 Alice 的租約影響');
    assert.equal((await outcomeOf(db, alice.id, aliceEvent)).outcome, null,
      '★ Alice 的事件仍然受保護');
  });
});
