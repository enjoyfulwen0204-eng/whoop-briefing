/**
 * 追問的答案記在「這題問的那一天」（M-06）。
 *
 * ## 修的是什麼
 *
 * 主動代理在 09-09 早上問「**昨天**有喝酒嗎？」——問的是 09-08 的異常。
 * 使用者回「有，喝了兩杯」。這種短答裡完全沒有時間資訊，於是
 * `parseNaturalJournal()` 落回 `day_offset = 0`，事件被記成 **09-09**。
 *
 * 而且失敗是**靜默**的，有兩層：
 *
 *   1. `validateStructured()` 會把「模型沒給的欄位」補成 `null`，
 *      而 `Number(null) === 0` —— 「沒說」被讀成「說了今天」。
 *   2. 沒有任何地方檢查「這個答案是在回答哪一天的問題」。
 *
 * 後果不是小小的日期誤差：
 *   - Journal 說了假話（那杯酒不是今天喝的）
 *   - `reanalyzeAfterAnswer()` 用 lag=1 把 journal 日配到隔天的指標，
 *     於是去看 09-10 —— 根本不是我們在問的那個異常。**我們主動問來的
 *     答案，結構上永遠解釋不了我們主動問的問題。**
 *   - 長期關聯學習被系統性灌進差一天的資料
 *
 * ## 現在的不變量
 *
 *   **問哪一天，答案就記在哪一天** —— 除非使用者自己講了日期，
 *   那就完全尊重使用者。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createDb } from '../src/db.js';
import {
  createRouter, parseNaturalJournal, anchorToQuestionDay,
} from '../src/bot/router.js';
import { PROACTIVE_QUESTION_INTENT } from '../src/schema.js';
import { ANTI_SPAM_POLICY } from '../src/proactivePolicy.js';

const TZ = 'Asia/Taipei';
const SIGNAL_DAY = '2026-09-08';
const ASK_AT = new Date('2026-09-09T01:00:00Z');    // 台北 09:00
const REPLY_AT = new Date('2026-09-09T01:10:00Z');  // 台北 09:10（TTL 內）

async function withDb(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm06-'));
  const db = createDb({ url: `file:${path.join(dir, 't.db')}` });
  try {
    await db.migrate();
    const user = await db.createUser({ displayName: 'K', timezone: TZ });
    await fn(db, user);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** 主動代理問一題「昨天…嗎？」。 */
async function askAboutYesterday(db, userId) {
  const { id: eventId } = await db.claimProactiveEvent(userId, {
    healthDate: SIGNAL_DAY, idempotencyKey: 'k1',
    signals: [{ metric: 'hrv', code: 'HRV_LOW' }], decision: 'ASK_CONTEXT',
    reason: {}, policyVersion: 'v1', messageText: '昨天有喝酒嗎？',
  }, { now: ASK_AT });
  const questionId = await db.openPendingQuestion(userId, {
    chatId: '1', originalMessage: 'HRV 偏低', question: '昨天有喝酒嗎？',
    intent: PROACTIVE_QUESTION_INTENT,
    contextJson: {
      proactive_event_id: eventId, health_date: SIGNAL_DAY,
      // R3-M-02：這一題在問哪一天，是建立時就決定並持久化的事實
      question_target_date: SIGNAL_DAY,
      signal: { metric: 'hrv', direction: 'low' }, category: 'alcohol',
    },
    ttlMs: ANTI_SPAM_POLICY.QUESTION_TTL_MS,
  }, { now: ASK_AT });
  await db.markProactiveEventSent(userId, eventId, { pendingQuestionId: questionId }, { now: ASK_AT });
  return { eventId, questionId };
}

/** 一個回傳固定解析結果的 coach。`extra` 讓測試控制 day_offset。 */
const coachWith = (extra = {}) => () => ({
  async json() {
    return {
      category: 'alcohol', subtype: 'beer', numeric_value: 2,
      unit: 'cup', confidence: 0.9, ...extra,
    };
  },
  async ask() { return null; },
});

// ===========================================================================
// ★★★ 端到端：短答被記在問題那一天
// ===========================================================================

test('★★★ M-06: 對「昨天…嗎？」的短答記在昨天，不是今天', async () => {
  await withDb(async (db, user) => {
    await askAboutYesterday(db, user.id);
    const router = createRouter({ db, coachFor: coachWith(), now: () => REPLY_AT });
    await router.handle({
      text: '有，喝了兩杯', chatId: '1', user: { id: user.id, timezone: TZ },
    });

    const events = await db.getJournalEvents(user.id, {
      from: '2026-09-01', to: '2026-09-30', limit: 50,
    });
    assert.equal(events.length, 1);
    assert.equal(events[0].health_date, SIGNAL_DAY,
      '★ 問的是 09-08 的異常，答案就必須記在 09-08');
    assert.equal(events[0].source, 'proactive_agent', '前置：確定走的是主動代理那條路');
  });
});

test('★★★ M-06: 回覆文字顯示的也是問題那一天（不會對使用者說錯日期）', async () => {
  await withDb(async (db, user) => {
    await askAboutYesterday(db, user.id);
    const router = createRouter({ db, coachFor: coachWith(), now: () => REPLY_AT });
    const reply = await router.handle({
      text: '有，喝了兩杯', chatId: '1', user: { id: user.id, timezone: TZ },
    });
    assert.match(String(reply), new RegExp(SIGNAL_DAY));
    assert.ok(!String(reply).includes('2026-09-09'), '★ 不可以顯示回話當天的日期');
  });
});

test('★★★ M-06: event_at 也跟著平移，與 health_date 一致', async () => {
  await withDb(async (db, user) => {
    await askAboutYesterday(db, user.id);
    const router = createRouter({ db, coachFor: coachWith(), now: () => REPLY_AT });
    await router.handle({
      text: '有，喝了兩杯', chatId: '1', user: { id: user.id, timezone: TZ },
    });
    const [e] = await db.getJournalEvents(user.id, {
      from: '2026-09-01', to: '2026-09-30', limit: 50,
    });
    assert.ok(e.event_at.startsWith(SIGNAL_DAY),
      `★ event_at 不可以留在回話那天：${e.event_at}`);
  });
});

// ===========================================================================
// ★★★ 使用者自己講日期時，完全尊重使用者
// ===========================================================================

test('★★★ M-06: 使用者說「前天」時不覆蓋（day_offset = -2 相對於今天）', async () => {
  await withDb(async (db, user) => {
    await askAboutYesterday(db, user.id);
    const router = createRouter({
      db, coachFor: coachWith({ date_explicit: true, day_offset: -2 }), now: () => REPLY_AT,
    });
    await router.handle({
      text: '前天喝的', chatId: '1', user: { id: user.id, timezone: TZ },
    });
    const [e] = await db.getJournalEvents(user.id, {
      from: '2026-09-01', to: '2026-09-30', limit: 50,
    });
    assert.equal(e.health_date, '2026-09-07',
      '★ 使用者明確說了日期就以使用者為準，不可以硬拉回問題那一天');
  });
});

test('★★ M-06: 使用者說「今天」（day_offset = 0）也尊重', async () => {
  await withDb(async (db, user) => {
    await askAboutYesterday(db, user.id);
    const router = createRouter({
      db, coachFor: coachWith({ date_explicit: true, day_offset: 0 }), now: () => REPLY_AT,
    });
    await router.handle({
      text: '今天早上喝的', chatId: '1', user: { id: user.id, timezone: TZ },
    });
    const [e] = await db.getJournalEvents(user.id, {
      from: '2026-09-01', to: '2026-09-30', limit: 50,
    });
    assert.equal(e.health_date, '2026-09-09');
  });
});

// ===========================================================================
// ★★★ 靜默失敗的根源：Number(null) === 0
// ===========================================================================

test('★★★ M-06: 模型沒給 day_offset → statedDayOffset 是 null，不是 0', async () => {
  const nat = await parseNaturalJournal({
    text: '有，喝了兩杯', now: REPLY_AT, timezone: TZ,
    coach: { async json() { return { category: 'alcohol', confidence: 0.9 }; } },
  });
  assert.equal(nat.ok, true);
  assert.equal(nat.statedDayOffset, null,
    '★ Number(null) === 0：「沒說」絕不可以被讀成「說了今天」');
  assert.equal(nat.event.healthDate, '2026-09-09', '沒有錨點時仍然預設今天');
});

test('★★ M-06 / R3-M-02: 只有 date_explicit=true 才算「使用者說了日期」', async () => {
  for (const offset of [0, -1, -2]) {
    const nat = await parseNaturalJournal({
      text: 'x', now: REPLY_AT, timezone: TZ,
      coach: {
        async json() {
          return { category: 'alcohol', confidence: 0.9, date_explicit: true, day_offset: offset };
        },
      },
    });
    assert.equal(nat.statedDayOffset, offset);
  }
});

test('★★★ R3-M-02: date_explicit=false（或缺席）一律當成「沒說」', async () => {
  for (const extra of [
    { date_explicit: false, day_offset: 0 },
    { day_offset: 0 },                       // 欄位缺席
    { date_explicit: 'yes', day_offset: 0 }, // 型別不對
    { date_explicit: false, day_offset: -1 },
  ]) {
    const nat = await parseNaturalJournal({
      text: 'x', now: REPLY_AT, timezone: TZ,
      coach: { async json() { return { category: 'alcohol', confidence: 0.9, ...extra }; } },
    });
    // 型別不對時 validateStructured 會讓整個解析失敗（也是安全結果：
    // 不寫入任何東西）。兩種情況都不可以產生一個「明確日期」。
    assert.ok(nat.statedDayOffset === null || nat.statedDayOffset === undefined,
      `★ ${JSON.stringify(extra)} 不可以被當成明確日期（實際 ${nat.statedDayOffset}）`);
  }
});

// ===========================================================================
// anchorToQuestionDay 本身
// ===========================================================================

const EVENT = {
  eventAt: '2026-09-09T01:10:00.000Z', healthDate: '2026-09-09',
  category: 'alcohol', note: 'x',
};

test('★★ M-06: anchorToQuestionDay 只在「沒說日期」時才動手', () => {
  const moved = anchorToQuestionDay(EVENT, {
    anchorHealthDate: SIGNAL_DAY, statedDayOffset: null, timezone: TZ,
  });
  assert.equal(moved.healthDate, SIGNAL_DAY);

  const kept = anchorToQuestionDay(EVENT, {
    anchorHealthDate: SIGNAL_DAY, statedDayOffset: -2, timezone: TZ,
  });
  assert.equal(kept.healthDate, '2026-09-09', '★ 使用者說了就不動');
});

for (const [name, anchor] of [
  ['null', null], ['undefined', undefined], ['空字串', ''], ['格式不對', '2026/09/08'],
]) {
  test(`★★ M-06: 沒有可用的錨點（${name}）→ 原封不動`, () => {
    const out = anchorToQuestionDay(EVENT, {
      anchorHealthDate: anchor, statedDayOffset: null, timezone: TZ,
    });
    assert.equal(out.healthDate, '2026-09-09');
    assert.equal(out.eventAt, EVENT.eventAt);
  });
}

test('★★ M-06: 錨點就是原本那一天 → 完全不動（冪等）', () => {
  const out = anchorToQuestionDay(EVENT, {
    anchorHealthDate: '2026-09-09', statedDayOffset: null, timezone: TZ,
  });
  assert.deepEqual(out, EVENT);
});

test('★★ M-06: 錨點在更早的日子也算得對（差好幾天）', () => {
  const out = anchorToQuestionDay(EVENT, {
    anchorHealthDate: '2026-09-05', statedDayOffset: null, timezone: TZ,
  });
  assert.equal(out.healthDate, '2026-09-05');
  assert.ok(out.eventAt.startsWith('2026-09-05'));
});

// ===========================================================================
// 反應式追問（不是主動代理）也適用同一條規則
// ===========================================================================

test('★★ M-06: 反應式追問的答案也記在它問的那一天', async () => {
  await withDb(async (db, user) => {
    await db.openPendingQuestion(user.id, {
      chatId: '1', originalMessage: '我今天怎樣？',
      question: '昨天有做什麼特別的事嗎？',
      intent: 'today_status',
      contextJson: {
        health_date: SIGNAL_DAY, question_target_date: SIGNAL_DAY, items: [],
      },
      ttlMs: 30 * 60_000,
    }, { now: ASK_AT });

    const router = createRouter({ db, coachFor: coachWith(), now: () => REPLY_AT });
    await router.handle({
      text: '有，喝了兩杯', chatId: '1', user: { id: user.id, timezone: TZ },
    });
    const [e] = await db.getJournalEvents(user.id, {
      from: '2026-09-01', to: '2026-09-30', limit: 50,
    });
    assert.equal(e.health_date, SIGNAL_DAY);
  });
});

// ===========================================================================
// 沒有追問時，一般訊息不受影響
// ===========================================================================

test('★★ M-06 false positive: 沒有追問時，一般的 journal 訊息仍然記在今天', async () => {
  await withDb(async (db, user) => {
    const router = createRouter({ db, coachFor: coachWith(), now: () => REPLY_AT });
    await router.handle({
      text: '今天喝了兩杯', chatId: '1', user: { id: user.id, timezone: TZ },
    });
    const [e] = await db.getJournalEvents(user.id, {
      from: '2026-09-01', to: '2026-09-30', limit: 50,
    });
    assert.equal(e.health_date, '2026-09-09', '★ 沒有問題就沒有錨點，維持原本行為');
  });
});
