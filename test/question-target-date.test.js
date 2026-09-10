/**
 * 問題目標日必須被明確持久化（R2-M-02）。
 *
 * ## 修的是什麼
 *
 * 真實的主動問題是：
 *
 *   「你的HRV**今天**比平常偏低了不少。**昨天**有喝酒嗎？」
 *
 * 訊號日（event health_date）是 2026-02-06，所以「昨天」是 2026-02-05。
 * 而 lag=1 的關聯分析要的正是 journal 日 D-1 → 指標日 D。
 *
 * 上一輪把答案錨定到 `context.health_date`（訊號日），所以短答「喝了兩杯」
 * 被記在 **2026-02-06**。實測確認。錯的方向剛好讓我們主動問來的答案，
 * 結構上永遠對不上我們主動問的那個異常。
 *
 * ## 現在的不變量
 *
 *   **被問的行為發生在哪一天，是問題被建立時就決定並持久化的事實**
 *   （`context.question_target_date`），與訊號的 health_date 分開儲存。
 *   絕不留到回答時再由 parser 的預設值去推論。
 *
 * parser 仍然區分「使用者明確講了日期」與「沒講」：
 *   沒講 → 沿用問題目標日；有講 → 使用者說的贏。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createDb } from '../src/db.js';
import { createRouter, questionTargetDateOf } from '../src/bot/router.js';
import { selectQuestion, questionTargetDate, buildQuestionText } from '../src/questionEngine.js';
import { openFollowUp } from '../src/bot/conversation.js';
import { INFORMATION_GAIN_POLICY } from '../src/proactivePolicy.js';
import { PROACTIVE_QUESTION_INTENT } from '../src/schema.js';

const SIGNAL_DAY = '2026-02-06';
const BEHAVIOR_DAY = '2026-02-05';
const TZ = 'Asia/Taipei';
const ASK_AT = new Date('2026-02-06T01:00:00Z');    // 台北 09:00
const REPLY_AT = new Date('2026-02-06T01:10:00Z');

const signal = {
  metric: 'hrv', direction: 'low', level: 'STRONG',
  health_date: SIGNAL_DAY, current: 30, baseline_mean: 55, baseline_n: 30,
};

async function withUser(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r2m02-'));
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

const coachWith = (extra = {}) => () => ({
  async json() {
    return {
      category: 'alcohol', subtype: 'beer', numeric_value: 2,
      unit: 'cup', confidence: 0.9, ...extra,
    };
  },
  async ask() { return null; },
});

/** 開一個帶 target date 的主動問題。 */
async function askProactive(db, userId, {
  targetDate, category = 'alcohol', now = ASK_AT,
} = {}) {
  const { id: eventId } = await db.claimProactiveEvent(userId, {
    healthDate: SIGNAL_DAY, idempotencyKey: 'k1', signals: [signal],
    decision: 'ASK_CONTEXT', reason: {}, policyVersion: 'v1', messageText: 'q',
  }, { now });
  const context = {
    proactive_event_id: eventId, health_date: SIGNAL_DAY, signal, category,
  };
  if (targetDate !== undefined) context.question_target_date = targetDate;
  const qid = await db.openPendingQuestion(userId, {
    chatId: '1', question: buildQuestionText({ category, signal }),
    intent: PROACTIVE_QUESTION_INTENT, contextJson: context, ttlMs: 30 * 60_000,
  }, { now });
  await db.markProactiveEventSent(userId, eventId, { pendingQuestionId: qid }, { now });
  return { eventId, qid };
}

const journalDates = async (db, userId) => (await db.getJournalEvents(userId, {
  from: '2026-01-01', to: '2026-12-31', limit: 20,
})).map((e) => e.health_date);

// ===========================================================================
// ★★★ 目標日是被算出來並持久化的事實
// ===========================================================================

test('★★★ R2-M-02: selectQuestion 回報這一題在問哪一天', () => {
  const sel = selectQuestion({ signal, journalEvents: [], metricSeries: [] });
  assert.ok('targetDate' in sel, '★ 必須有明確的目標日欄位');
  assert.equal(sel.targetDate, BEHAVIOR_DAY,
    '★ 「昨天有喝酒嗎？」問的是訊號日的前一天');
});

test('★★★ R2-M-02: 每一個候選類別都有明文的目標日偏移', () => {
  for (const category of Object.keys(INFORMATION_GAIN_POLICY.CANDIDATES)) {
    const offset = INFORMATION_GAIN_POLICY.TARGET_DAY_OFFSET[category];
    assert.ok(Number.isInteger(offset),
      `★ ${category} 沒有宣告目標日偏移——那會讓日期又變成靠猜`);
    assert.equal(questionTargetDate({ category, signal }),
      new Date(Date.parse(`${SIGNAL_DAY}T00:00:00Z`) + offset * 86_400_000)
        .toISOString().slice(0, 10));
  }
});

test('★★ R2-M-02: 問「昨天」的類別偏移 -1，問「最近」的偏移 0', () => {
  const t = INFORMATION_GAIN_POLICY.TARGET_DAY_OFFSET;
  for (const yesterday of ['alcohol', 'travel', 'late_sleep', 'caffeine', 'late_meal', 'exercise_note']) {
    assert.equal(t[yesterday], -1, `${yesterday} 的樣板問的是昨天`);
  }
  for (const recent of ['sickness', 'stress']) {
    assert.equal(t[recent], 0, `${recent} 的樣板問的是「最近」，沒有指定某一天`);
  }
});

test('★★ R2-M-02: 訊號沒有 health_date 時目標日是 null（不亂猜）', () => {
  assert.equal(questionTargetDate({ category: 'alcohol', signal: {} }), null);
  assert.equal(questionTargetDate({ category: 'alcohol', signal: { health_date: 'x' } }), null);
});

// ===========================================================================
// ★★★ 端到端：答案記在被問的那一天
// ===========================================================================

test('★★★ R2-M-02: 短答「喝了兩杯」記在 2026-02-05，不是訊號日', async () => {
  await withUser(async (db, user) => {
    await askProactive(db, user.id, { targetDate: BEHAVIOR_DAY });
    const router = createRouter({ db, coachFor: coachWith(), now: () => REPLY_AT });
    await router.handle({ text: '喝了兩杯', chatId: '1', user: { id: user.id, timezone: TZ } });

    assert.deepEqual(await journalDates(db, user.id), [BEHAVIOR_DAY],
      '★ 問的是 02-05 的行為，就必須記在 02-05');
  });
});

test('★★★ R2-M-02: 「最近…」類別（偏移 0）記在訊號日', async () => {
  await withUser(async (db, user) => {
    const target = questionTargetDate({ category: 'stress', signal });
    assert.equal(target, SIGNAL_DAY);
    await askProactive(db, user.id, { targetDate: target, category: 'stress' });
    const router = createRouter({
      db, coachFor: coachWith({ category: 'stress' }), now: () => REPLY_AT,
    });
    await router.handle({ text: '壓力很大', chatId: '1', user: { id: user.id, timezone: TZ } });
    assert.deepEqual(await journalDates(db, user.id), [SIGNAL_DAY]);
  });
});

// ===========================================================================
// ★★★ 使用者明確講日期時，使用者贏
// ===========================================================================

for (const [name, offset, expected] of [
  ['今天', 0, '2026-02-06'],
  ['昨天', -1, '2026-02-05'],
  ['前天', -2, '2026-02-04'],
]) {
  test(`★★★ R2-M-02: 使用者明確說「${name}」→ 以使用者為準`, async () => {
    await withUser(async (db, user) => {
      await askProactive(db, user.id, { targetDate: BEHAVIOR_DAY });
      const router = createRouter({
        db, coachFor: coachWith({ day_offset: offset }), now: () => REPLY_AT,
      });
      await router.handle({ text: `${name}喝的`, chatId: '1', user: { id: user.id, timezone: TZ } });
      assert.deepEqual(await journalDates(db, user.id), [expected],
        `★ 使用者說「${name}」（相對於今天）就要記在 ${expected}`);
    });
  });
}

// ===========================================================================
// ★★ 舊資料（沒有 question_target_date）
// ===========================================================================

test('★★ R2-M-02: 舊追問沒有 target date → 退回 health_date（不比舊版差）', async () => {
  await withUser(async (db, user) => {
    await askProactive(db, user.id, { targetDate: undefined });
    const router = createRouter({ db, coachFor: coachWith(), now: () => REPLY_AT });
    await router.handle({ text: '喝了兩杯', chatId: '1', user: { id: user.id, timezone: TZ } });
    assert.deepEqual(await journalDates(db, user.id), [SIGNAL_DAY]);
  });
});

test('★★ R2-M-02: questionTargetDateOf 優先用明確欄位，格式不對就退回', () => {
  assert.equal(questionTargetDateOf({
    context: { question_target_date: BEHAVIOR_DAY, health_date: SIGNAL_DAY },
  }), BEHAVIOR_DAY);
  assert.equal(questionTargetDateOf({
    context: { question_target_date: '2026/02/05', health_date: SIGNAL_DAY },
  }), SIGNAL_DAY, '★ 格式不合法就不用它');
  assert.equal(questionTargetDateOf({ context: { health_date: SIGNAL_DAY } }), SIGNAL_DAY);
  assert.equal(questionTargetDateOf({ context: {} }), null);
  assert.equal(questionTargetDateOf({}), null);
  assert.equal(questionTargetDateOf(null), null);
});

// ===========================================================================
// ★★ 反應式追問也要記目標日
// ===========================================================================

test('★★★ R2-M-02: 反應式追問（問「昨天」）也記下正確的目標日', async () => {
  await withUser(async (db, user) => {
    await openFollowUp({
      db, userId: user.id, chatId: '1', originalMessage: '我今天怎樣？',
      result: { intent: 'today_status', health_date: SIGNAL_DAY, what_changed: [] },
      now: ASK_AT,
    });
    const q = await db.getOpenPendingQuestion(user.id, { now: ASK_AT });
    assert.equal(q.context.question_target_date, BEHAVIOR_DAY,
      '★ FOLLOW_UP_QUESTION 問的是「昨天」');

    const router = createRouter({ db, coachFor: coachWith(), now: () => REPLY_AT });
    await router.handle({ text: '喝了兩杯', chatId: '1', user: { id: user.id, timezone: TZ } });
    assert.deepEqual(await journalDates(db, user.id), [BEHAVIOR_DAY]);
  });
});

// ===========================================================================
// ★★★ 跨午夜與時區
// ===========================================================================

test('★★★ R2-M-02: 跨午夜回答（台北 23:50 問、00:10 答）仍然記在被問的那一天', async () => {
  await withUser(async (db, user) => {
    // 台北 2026-02-06 23:50 = UTC 15:50
    const askAt = new Date('2026-02-06T15:50:00Z');
    // 台北 2026-02-07 00:10 = UTC 16:10（已經跨過午夜，但還在 TTL 內）
    const replyAt = new Date('2026-02-06T16:10:00Z');

    await askProactive(db, user.id, { targetDate: BEHAVIOR_DAY, now: askAt });
    const router = createRouter({ db, coachFor: coachWith(), now: () => replyAt });
    await router.handle({ text: '喝了兩杯', chatId: '1', user: { id: user.id, timezone: TZ } });

    assert.deepEqual(await journalDates(db, user.id), [BEHAVIOR_DAY],
      '★ 回答跨過午夜與被問的那一天無關');
  });
});

test('★★★ R2-M-02: 不同時區的使用者，目標日都以問題為準', async () => {
  await withUser(async (db, alice) => {
    const bob = await db.createUser({ displayName: 'Bob', timezone: 'America/New_York' });
    // 同一個 UTC 瞬間對兩人是不同的當地日期——目標日必須完全不受影響
    const askAt = new Date('2026-02-06T01:00:00Z');
    const replyAt = new Date('2026-02-06T01:10:00Z');

    for (const u of [alice, bob]) {
      await db.openPendingQuestion(u.id, {
        chatId: u.id, question: 'q', intent: PROACTIVE_QUESTION_INTENT,
        contextJson: { health_date: SIGNAL_DAY, question_target_date: BEHAVIOR_DAY },
        ttlMs: 30 * 60_000,
      }, { now: askAt });
      const router = createRouter({ db, coachFor: coachWith(), now: () => replyAt });
      await router.handle({
        text: '喝了兩杯', chatId: u.id, user: { id: u.id, timezone: u.timezone },
      });
      assert.deepEqual(await journalDates(db, u.id), [BEHAVIOR_DAY],
        `★ ${u.timezone} 的使用者也必須記在 ${BEHAVIOR_DAY}`);
    }
  });
});

// ===========================================================================
// ★★★ 澄清追問沿用同一個目標日
// ===========================================================================

test('★★★ R2-M-02: 澄清追問（Q2）沿用同一個目標日', async () => {
  await withUser(async (db, user) => {
    await askProactive(db, user.id, { targetDate: BEHAVIOR_DAY });
    // 第一次答不出來 → 開澄清追問
    const unparsable = () => ({
      async json() { return { category: 'not_a_category' }; },
      async ask() { return null; },
    });
    const r1 = createRouter({ db, coachFor: unparsable, now: () => REPLY_AT });
    await r1.handle({ text: '唔…', chatId: '1', user: { id: user.id, timezone: TZ } });

    const q2 = await db.getOpenPendingQuestion(user.id, { now: REPLY_AT });
    assert.ok(q2, '前置：澄清追問要被開出來');
    assert.equal(q2.context.question_target_date, BEHAVIOR_DAY,
      '★ 澄清追問問的還是同一天');

    const r2 = createRouter({ db, coachFor: coachWith(), now: () => REPLY_AT });
    await r2.handle({ text: '有，喝了兩杯', chatId: '1', user: { id: user.id, timezone: TZ } });
    assert.deepEqual(await journalDates(db, user.id), [BEHAVIOR_DAY]);
  });
});
