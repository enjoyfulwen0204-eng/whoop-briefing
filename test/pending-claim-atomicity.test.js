/**
 * 追問的原子認領（M-02）。
 *
 * ## 修的是什麼
 *
 * `route()` 讀到的 pending question 是一個**瞬間的快照**。接下來要打一次
 * LLM 解析（秒級），這段時間裡 cron 的收割器可能已經把這題收成 EXPIRED
 * 並把對應的 proactive_event 寫成 NO_RESPONSE。
 *
 * 舊版把 `resolvePendingQuestion()` 埋在流程中段，而且**把回傳值丟掉**：
 *
 *   1. `saveEvent()` 先把 journal 寫進去（副作用已經發生）
 *   2. `resolvePendingQuestion()` 回 false（這題已經不是 OPEN 了）—— 被忽略
 *   3. `resolveProactiveEvent()` 是**無條件** UPDATE，
 *      直接把 NO_RESPONSE 覆寫成 STILL_UNEXPLAINED
 *
 * 實測確認：`resolvePendingQuestion -> false`，程式照樣走完並覆寫了結果。
 * 後果是稽核軌跡說謊 —— 一個從來沒有被及時回答的問題被記成「有回應」，
 * 而 proactivePolicy 未來要拿 NO_RESPONSE 比例來調門檻。
 *
 * ## 現在的不變量
 *
 *   **認領是產生副作用的前置條件。**
 *   贏得那個條件式 UPDATE（`status = 'OPEN'`）之後才可以寫 journal、
 *   重跑分析、或把事件寫成任何終局結果。輸掉就完全不碰這一題 ——
 *   絕不回頭覆寫任何已經定案的結果。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createDb } from '../src/db.js';
import { createRouter } from '../src/bot/router.js';
import { reapExpiredProactiveQuestions } from '../src/proactiveReaper.js';
import { PROACTIVE_QUESTION_INTENT, PROACTIVE_OUTCOME } from '../src/schema.js';

const T0 = new Date('2026-09-09T00:00:00Z');
const REPLY_AT = new Date(T0.getTime() + 60_000);
const AFTER_TTL = new Date(T0.getTime() + 40 * 60_000);

async function withSetup(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm02-'));
  const db = createDb({ url: `file:${path.join(dir, 't.db')}` });
  try {
    await db.migrate();
    const user = await db.createUser({ displayName: 'K' });
    const uid = user.id;
    const { id: eventId } = await db.claimProactiveEvent(uid, {
      healthDate: '2026-09-08', idempotencyKey: 'k1',
      signals: [{ metric: 'hrv' }], decision: 'ASK', reason: {},
      policyVersion: 'v1', messageText: '昨天有喝酒嗎？',
    }, { now: T0 });
    const qid = await db.openPendingQuestion(uid, {
      chatId: '1', originalMessage: 'HRV 偏低', question: '昨天有喝酒嗎？',
      intent: PROACTIVE_QUESTION_INTENT,
      contextJson: {
        proactive_event_id: eventId, signal: { metric: 'hrv' }, health_date: '2026-09-08',
        // R3-M-02：這一題在問哪一天，必須是持久化的事實
        question_target_date: '2026-09-07', category: 'alcohol',
      },
      ttlMs: 30 * 60_000,
    }, { now: T0 });
    await db.markProactiveEventSent(uid, eventId, { pendingQuestionId: qid }, { now: T0 });
    await fn({ db, uid, eventId, qid });
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** 一個會回傳固定解析結果的 coach。 */
const coachFor = () => ({
  async json() {
    return {
      category: 'alcohol', subtype: 'beer', numeric_value: 2,
      unit: 'cup', day_offset: 0, confidence: 0.9,
    };
  },
  async ask() { return null; },
});

// ===========================================================================
// ★★★ 收割器在「讀到快照」與「認領」之間搶先
// ===========================================================================

test('★★★ M-02: 收割器搶在認領之前 → NO_RESPONSE 絕不被覆寫', async () => {
  await withSetup(async ({ db, uid, qid }) => {
    // 讓收割器剛好在 route() 拿到快照之後、認領之前跑完
    const realGet = db.getOpenPendingQuestion.bind(db);
    let raced = false;
    db.getOpenPendingQuestion = async (...args) => {
      const snapshot = await realGet(...args);
      if (snapshot && !raced) {
        raced = true;
        await reapExpiredProactiveQuestions({ db, userId: uid, now: AFTER_TTL });
      }
      return snapshot;
    };

    const router = createRouter({ db, coachFor, now: () => REPLY_AT });
    await router.handle({
      text: '有，喝了兩杯', chatId: '1', user: { id: uid, timezone: 'Asia/Taipei' },
    });

    const ev = await db.getProactiveEventByPendingQuestion(uid, qid);
    assert.equal(ev.outcome, PROACTIVE_OUTCOME.NO_RESPONSE,
      '★ 收割器已經定案的 NO_RESPONSE 絕不可以被遲到的回答覆寫');
  });
});

test('★★★ M-02: 認領失敗時不產生任何主動代理副作用', async () => {
  await withSetup(async ({ db, uid, qid }) => {
    // 收割器在「讀到快照」與「認領」之間搶先，並寫下 NO_RESPONSE
    let resolveCalls = 0;
    const realResolve = db.resolveProactiveEventIfUnresolved.bind(db);
    db.resolveProactiveEventIfUnresolved = async (...a) => {
      resolveCalls += 1;
      return realResolve(...a);
    };

    const realGet = db.getOpenPendingQuestion.bind(db);
    let raced = false;
    db.getOpenPendingQuestion = async (...args) => {
      const snapshot = await realGet(...args);
      if (snapshot && !raced) {
        raced = true;
        await reapExpiredProactiveQuestions({ db, userId: uid, now: AFTER_TTL });
        // 收割器自己的那一次寫入不算在「回答路徑的副作用」裡
        resolveCalls = 0;
      }
      return snapshot;
    };

    const before = await db.getProactiveEventByPendingQuestion(uid, qid);
    assert.equal(before.outcome, null, '前置：這時還沒有結果');

    const router = createRouter({ db, coachFor, now: () => REPLY_AT });
    await router.handle({
      text: '有，喝了兩杯', chatId: '1', user: { id: uid, timezone: 'Asia/Taipei' },
    });

    assert.equal(resolveCalls, 0,
      '★ 輸掉認領就不可以碰事件的終局結果（收割器自己的那次不算）');
    const after = await db.getProactiveEventByPendingQuestion(uid, qid);
    assert.equal(after.outcome, PROACTIVE_OUTCOME.NO_RESPONSE,
      '★ 收割器定案的結果必須完整保留');
    const q = await db.getPendingQuestionById?.(uid, qid);
    if (q) assert.notEqual(q.status, 'ANSWERED', '★ 已經 EXPIRED 的題不可以被改成 ANSWERED');
  });
});

test('★★★ M-02: 認領失敗時使用者的訊息不會被吞掉（仍然被當一般訊息處理）', async () => {
  await withSetup(async ({ db, uid }) => {
    const realGet = db.getOpenPendingQuestion.bind(db);
    let raced = false;
    db.getOpenPendingQuestion = async (...args) => {
      const snapshot = await realGet(...args);
      if (snapshot && !raced) {
        raced = true;
        await reapExpiredProactiveQuestions({ db, userId: uid, now: AFTER_TTL });
      }
      return snapshot;
    };
    const router = createRouter({ db, coachFor, now: () => REPLY_AT });
    const reply = await router.handle({
      text: '有，喝了兩杯', chatId: '1', user: { id: uid, timezone: 'Asia/Taipei' },
    });
    assert.ok(reply && String(reply).trim().length > 0, '★ 一定要回一句話，不可以靜默丟棄');
  });
});

// ===========================================================================
// 沒有競爭時一切照常
// ===========================================================================

test('★★ M-02: 正常（沒有競爭）時追問流程完全不受影響', async () => {
  await withSetup(async ({ db, uid, qid }) => {
    const router = createRouter({ db, coachFor, now: () => REPLY_AT });
    const reply = await router.handle({
      text: '有，喝了兩杯', chatId: '1', user: { id: uid, timezone: 'Asia/Taipei' },
    });
    assert.match(String(reply), /已記錄/, '★ 正常回答必須照樣寫 journal 並回覆');
    const ev = await db.getProactiveEventByPendingQuestion(uid, qid);
    assert.ok(ev.outcome && ev.outcome !== PROACTIVE_OUTCOME.NO_RESPONSE,
      '真的有回答就要記成有回答');
  });
});

test('★★ M-02: 認領在 LLM 解析之前發生（副作用之前）', async () => {
  await withSetup(async ({ db, uid, qid }) => {
    const order = [];
    const realResolve = db.resolvePendingQuestion.bind(db);
    db.resolvePendingQuestion = async (...a) => { order.push('claim'); return realResolve(...a); };
    const spyCoach = () => ({
      async json() { order.push('llm'); return { category: 'alcohol', confidence: 0.9 }; },
      async ask() { return null; },
    });
    const router = createRouter({ db, coachFor: spyCoach, now: () => REPLY_AT });
    await router.handle({
      text: '有，喝了兩杯', chatId: '1', user: { id: uid, timezone: 'Asia/Taipei' },
    });
    assert.equal(order[0], 'claim', `★ 認領必須是第一件事，實際順序：${order.join(' → ')}`);
    assert.ok(order.includes('llm'));
  });
});

test('★★★ M-02: 同一則回答被處理兩次 → 事件的終局結果只被寫一次', async () => {
  await withSetup(async ({ db, uid, qid }) => {
    // R2-M-03 之後回答路徑改用條件式寫入 resolveProactiveEventIfUnresolved
    let resolveCalls = 0;
    const realResolve = db.resolveProactiveEventIfUnresolved.bind(db);
    db.resolveProactiveEventIfUnresolved = async (...a) => {
      resolveCalls += 1;
      return realResolve(...a);
    };

    const router = createRouter({ db, coachFor, now: () => REPLY_AT });
    const msg = () => ({
      text: '有，喝了兩杯', chatId: '1', user: { id: uid, timezone: 'Asia/Taipei' },
    });
    await router.handle(msg());
    assert.equal(resolveCalls, 1, '第一次要正常結案');
    const first = await db.getProactiveEventByPendingQuestion(uid, qid);

    // 第二次：追問已經是 ANSWERED，認領必定失敗
    await router.handle(msg());
    assert.equal(resolveCalls, 1,
      '★ 認領失敗的那一次絕不可以再碰事件的終局結果');

    const second = await db.getProactiveEventByPendingQuestion(uid, qid);
    assert.equal(second.outcome, first.outcome, '★ 結果不可以被改寫');
    assert.equal(second.resolvedAt, first.resolvedAt, '★ 結案時間也不可以被改寫');
  });
});

test('★★★ M-02: 追問已經 EXPIRED 之後才回覆 → 事件維持 NO_RESPONSE', async () => {
  await withSetup(async ({ db, uid, qid }) => {
    // 收割器先跑完（這是最常見的情況：使用者隔天才回）
    const reaped = await reapExpiredProactiveQuestions({ db, userId: uid, now: AFTER_TTL });
    assert.equal(reaped.noResponse, 1, '前置：收割器確實寫了 NO_RESPONSE');

    const router = createRouter({ db, coachFor, now: () => AFTER_TTL });
    await router.handle({
      text: '有，喝了兩杯', chatId: '1', user: { id: uid, timezone: 'Asia/Taipei' },
    });

    const ev = await db.getProactiveEventByPendingQuestion(uid, qid);
    assert.equal(ev.outcome, PROACTIVE_OUTCOME.NO_RESPONSE,
      '★ 遲到的回答不可以把 NO_RESPONSE 改寫成別的結果');
  });
});
