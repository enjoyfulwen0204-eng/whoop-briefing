/**
 * Proactive Physiological Agent —— 端到端管線測試（PA3-PA9, PA10-PA14, PA19, PA20）。
 *
 * 固定管線：新 WHOOP 資料 → readiness → 訊號 → Attention Engine
 *   → （ASK_CONTEXT）Information-Gain 問題引擎 → 認領冪等鍵 → Telegram
 *   → 開 pending question → 使用者回答 → journal → reanalysis → insight/follow-up
 *
 * 全部用真的 libSQL（file:）+ 真的 store 層，只有 Telegram 用假的
 * （fakeTelegram，符合「開發/測試絕不打真的 Telegram」的規則）。
 *
 * ## 關於「持續性」的測試手法
 *
 * checkAndAct() 每次只處理 coverage() 回報的**最新一天**（跟游標比對）。
 * 要測「連續兩天出現同一個訊號」，資料必須**分兩批**寫入、中間真的呼叫
 * 一次 checkAndAct()——不能一次把兩天資料都寫好才呼叫兩次，那樣兩次呼叫
 * 會因為「沒有新的 health_date」而第二次直接 no-op。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createDb } from '../src/db.js';
import { loadDailyMetrics } from '../src/dailyMetrics.js';
import { localDate } from '../src/time.js';
import { checkAndAct } from '../src/proactiveAgent.js';
import { createRouter } from '../src/bot/router.js';
import { PROACTIVE_DECISION, PROACTIVE_QUESTION_INTENT } from '../src/schema.js';
import { ANTI_SPAM_POLICY } from '../src/proactivePolicy.js';
import { fakeTelegram } from './fakes.js';
import { ALICE, BOB, seedAliceAndBob, seedSingleUser } from './users.js';

const DAY_MS = 86_400_000;
const START_DATE = '2026-01-01';

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proactive-'));
  const db = createDb({ url: `file:${path.join(dir, 't.db')}` });
  return { db, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/** 平穩基準的第 i 天（i 從 0 開始）。輕微抖動但不構成偏離訊號。 */
function calmValue(i, { recovery = 60, hrv = 50, rhr = 55 } = {}) {
  return {
    recovery: recovery + (i % 3) - 1,
    hrv: hrv + (i % 4) - 2,
    rhr: rhr + (i % 3) - 1,
  };
}

/**
 * 寫入「第 dateIndex 天」的 sleep+recovery（health_date 由 sleep.end 決定）。
 * 可以重複呼叫、每次加一天——這是模擬「cron 每天多看到一天新資料」的正確方式。
 */
async function seedOneDay(db, user, dateIndex, values, { idPrefix = 'd' } = {}) {
  const day = new Date(Date.parse(`${START_DATE}T15:00:00.000Z`) + dateIndex * DAY_MS);
  const start = day.toISOString();
  const end = new Date(day.getTime() + 8 * 3600_000).toISOString();
  const sleepId = `${idPrefix}-sleep-${dateIndex}`;

  await db.upsertSleeps(user.id, [{
    id: sleepId, v1_id: dateIndex, user_id: 999, start, end,
    nap: false, score_state: 'SCORED', timezone_offset: '+08:00',
    score: {
      respiratory_rate: 15, sleep_performance_percentage: 85,
      sleep_consistency_percentage: 85, sleep_efficiency_percentage: 90,
      stage_summary: {
        total_light_sleep_time_milli: 3_000_000, total_slow_wave_sleep_time_milli: 1_000_000,
        total_rem_sleep_time_milli: 1_000_000, total_awake_time_milli: 0,
        total_no_data_time_milli: 0, total_in_bed_time_milli: 8_000_000,
        disturbance_count: 1, sleep_cycle_count: 4,
      },
      sleep_needed: {
        baseline_milli: 28_800_000, need_from_sleep_debt_milli: 0,
        need_from_recent_strain_milli: 0, need_from_recent_nap_milli: 0,
      },
    },
  }], { timezone: user.timezone });

  await db.upsertRecoveries(user.id, [{
    sleep_id: sleepId, cycle_id: `${idPrefix}-cycle-${dateIndex}`, user_id: 999, score_state: 'SCORED',
    score: {
      recovery_score: values.recovery, hrv_rmssd_milli: values.hrv, resting_heart_rate: values.rhr,
      spo2_percentage: null, skin_temp_celsius: null, user_calibrating: false,
    },
  }]);

  return day;
}

/** 寫入第 0..n-1 天的平穩基準資料。 */
async function seedCalmBaseline(db, user, n, opts) {
  for (let i = 0; i < n; i++) await seedOneDay(db, user, i, calmValue(i), opts);
}

/**
 * 第 dateIndex 天實際落在哪個 health_date——直接用跟 seedOneDay 相同的
 * sleep.end 時間戳算，不查資料庫窗口（相鄰天只差 1 天，窗口查詢會選到
 * 錯的那一天）。
 */
function healthDateOf(user, dateIndex) {
  const day = new Date(Date.parse(`${START_DATE}T15:00:00.000Z`) + dateIndex * DAY_MS);
  const end = new Date(day.getTime() + 8 * 3600_000);
  return localDate(end, user.timezone);
}

const BASELINE_DAYS = 35; // 足夠讓 PROACTIVE_MONITORING 對 recovery/hrv/rhr 都 READY

test('★ PA3/PA4: 平穩基準資料沒有任何訊號 → IGNORE，且游標前進避免重複檢查', async () => {
  const { db, cleanup } = tempDb();
  try {
    await db.migrate();
    const user = await seedSingleUser(db);
    await seedCalmBaseline(db, user, BASELINE_DAYS);

    const telegram = fakeTelegram();
    const chatId = await db.getActiveChatIdForUser(user.id);
    const now = new Date('2026-02-05T08:00:00Z');

    const result = await checkAndAct({
      db, userId: user.id, timezone: user.timezone, telegram, chatId, now,
    });

    assert.equal(result.triggered, true);
    assert.equal(result.decision, PROACTIVE_DECISION.IGNORE);
    assert.equal(telegram.sent.length, 0, '沒有訊號就不該送任何 Telegram 訊息');

    const again = await checkAndAct({
      db, userId: user.id, timezone: user.timezone, telegram, chatId, now,
    });
    assert.equal(again.triggered, false);
    // 稽核後改名：判斷依據是「日期 + 內容指紋」，不只是日期。
    assert.equal(again.reason, 'no_new_or_changed_data');
  } finally {
    db.close();
    cleanup();
  }
});

test('PA5: 單一天、非持續性的嚴重偏離 → LOG_ONLY（不是每個異常都要通知使用者）', async () => {
  const { db, cleanup } = tempDb();
  try {
    await db.migrate();
    const user = await seedSingleUser(db);
    await seedCalmBaseline(db, user, BASELINE_DAYS);
    // 只讓 hrv 單日暴跌，recovery/rhr 維持原本的抖動模式，避免同時觸發多重訊號。
    await seedOneDay(db, user, BASELINE_DAYS, { ...calmValue(BASELINE_DAYS), hrv: 15 });

    const telegram = fakeTelegram();
    const chatId = await db.getActiveChatIdForUser(user.id);
    const result = await checkAndAct({
      db, userId: user.id, timezone: user.timezone, telegram, chatId,
      now: new Date('2026-02-06T08:00:00Z'),
    });

    assert.equal(result.triggered, true);
    assert.equal(result.signals.length, 1, '應該只有 HRV 這一個訊號');
    assert.equal(result.signals[0].metric, 'hrv');
    assert.equal(result.decision, PROACTIVE_DECISION.LOG_ONLY);
    assert.equal(telegram.sent.length, 0, '單日、非持續、非多重佐證的異常不該發訊息');
  } finally {
    db.close();
    cleanup();
  }
});

test('★★ PA5/PA7/PA8: 連續兩天同一個訊號（持續性）→ ASK_CONTEXT，選出恰好一題並送出、開 pending question', async () => {
  const { db, cleanup } = tempDb();
  try {
    await db.migrate();
    const user = await seedSingleUser(db);
    await seedCalmBaseline(db, user, BASELINE_DAYS);
    await seedOneDay(db, user, BASELINE_DAYS, { ...calmValue(BASELINE_DAYS), hrv: 15 });

    const telegram = fakeTelegram();
    const chatId = await db.getActiveChatIdForUser(user.id);

    const day1 = await checkAndAct({
      db, userId: user.id, timezone: user.timezone, telegram, chatId,
      now: new Date('2026-02-06T08:00:00Z'),
    });
    assert.equal(day1.decision, PROACTIVE_DECISION.LOG_ONLY, '第一天還沒有持續性佐證');

    // 第二天：hrv 仍然低 → 跟前一天的 proactive_events 比對後視為「持續」。
    await seedOneDay(db, user, BASELINE_DAYS + 1, { ...calmValue(BASELINE_DAYS + 1), hrv: 14 });
    const day2 = await checkAndAct({
      db, userId: user.id, timezone: user.timezone, telegram, chatId,
      now: new Date('2026-02-07T08:00:00Z'),
    });
    assert.equal(day2.decision, PROACTIVE_DECISION.ASK_CONTEXT);
    assert.equal(telegram.sent.length, 1, '應該恰好送出一則訊息');
    assert.match(telegram.sent[0], /HRV/);

    const openQuestion = await db.getOpenPendingQuestion(user.id, { now: new Date('2026-02-07T08:05:00Z') });
    assert.ok(openQuestion, '應該開了一個 pending question');
    assert.equal(openQuestion.intent, PROACTIVE_QUESTION_INTENT);
    assert.ok(openQuestion.context.category, '問題要綁定一個候選類別');
    assert.equal(openQuestion.context.signal.metric, 'hrv');
  } finally {
    db.close();
    cleanup();
  }
});

test('PA9/PA20: 重跑同一天（模擬 cron 重複執行／worker 重啟）不會重複送訊息', async () => {
  const { db, cleanup } = tempDb();
  try {
    await db.migrate();
    const user = await seedSingleUser(db);
    await seedCalmBaseline(db, user, BASELINE_DAYS);
    await seedOneDay(db, user, BASELINE_DAYS, { ...calmValue(BASELINE_DAYS), hrv: 15 });

    const telegram = fakeTelegram();
    const chatId = await db.getActiveChatIdForUser(user.id);
    await checkAndAct({
      db, userId: user.id, timezone: user.timezone, telegram, chatId,
      now: new Date('2026-02-06T08:00:00Z'),
    });

    await seedOneDay(db, user, BASELINE_DAYS + 1, { ...calmValue(BASELINE_DAYS + 1), hrv: 14 });
    const now2 = new Date('2026-02-07T08:00:00Z');
    await checkAndAct({ db, userId: user.id, timezone: user.timezone, telegram, chatId, now: now2 });
    assert.equal(telegram.sent.length, 1);

    const stateAfterDay2 = await db.getProactiveState(user.id);

    // 模擬「claim 成功但游標沒前進就當掉」：手動把游標往回撥一天，
    // 再跑一次同一批資料（等同 worker 重啟／cron 重跑）。
    await db.setProactiveState(user.id, { lastCheckedHealthDate: healthDateOf(user, BASELINE_DAYS) }, { now: now2 });

    const rerun = await checkAndAct({
      db, userId: user.id, timezone: user.timezone, telegram, chatId, now: now2,
    });
    assert.equal(rerun.duplicate, true, 'idempotency key 應該讓這次被視為重複');
    assert.equal(telegram.sent.length, 1, '絕不能因為重跑而送出第二則訊息');

    const stateAfterRerun = await db.getProactiveState(user.id);
    assert.equal(stateAfterRerun.lastCheckedHealthDate, stateAfterDay2.lastCheckedHealthDate, '游標應該還是前進到最新，不會卡住');
  } finally {
    db.close();
    cleanup();
  }
});

test('PA6: 每日上限（DAILY_PROACTIVE_CAP）達到後 → 即使訊號持續也只 LOG_ONLY', async () => {
  const { db, cleanup } = tempDb();
  try {
    await db.migrate();
    const user = await seedSingleUser(db);
    await seedCalmBaseline(db, user, BASELINE_DAYS);
    await seedOneDay(db, user, BASELINE_DAYS, { ...calmValue(BASELINE_DAYS), hrv: 15 });

    const telegram = fakeTelegram();
    const chatId = await db.getActiveChatIdForUser(user.id);
    await checkAndAct({
      db, userId: user.id, timezone: user.timezone, telegram, chatId,
      now: new Date('2026-02-06T08:00:00Z'),
    });

    // 塞進「今天已經發過上限則」的假歷史事件（跟第二天的偵測時間在同一個 24 小時內）。
    const now2 = new Date('2026-02-07T08:00:00Z');
    for (let i = 0; i < ANTI_SPAM_POLICY.DAILY_PROACTIVE_CAP; i++) {
      await db.claimProactiveEvent(user.id, {
        healthDate: `fake-cap-day-${i}`,
        idempotencyKey: `fake-cap-${i}`,
        signals: [{ code: 'RECOVERY_LOW', level: 'STRONG', metric: 'recovery' }],
        decision: PROACTIVE_DECISION.NOTIFY,
        reason: {},
        policyVersion: 'test',
        messageText: 'x',
      }, { now: new Date(now2.getTime() - (i + 1) * 3600_000) });
    }

    await seedOneDay(db, user, BASELINE_DAYS + 1, { ...calmValue(BASELINE_DAYS + 1), hrv: 14 });
    const result = await checkAndAct({
      db, userId: user.id, timezone: user.timezone, telegram, chatId, now: now2,
    });

    assert.equal(result.decision, PROACTIVE_DECISION.LOG_ONLY);
    assert.equal(result.reason, 'daily_cap_reached');
    assert.equal(telegram.sent.length, 0);
  } finally {
    db.close();
    cleanup();
  }
});

test('PA5: 今天已經有 journal 紀錄（脈絡已知）→ 即使訊號持續也不再問一次', async () => {
  const { db, cleanup } = tempDb();
  try {
    await db.migrate();
    const user = await seedSingleUser(db);
    await seedCalmBaseline(db, user, BASELINE_DAYS);
    await seedOneDay(db, user, BASELINE_DAYS, { ...calmValue(BASELINE_DAYS), hrv: 15 });

    const telegram = fakeTelegram();
    const chatId = await db.getActiveChatIdForUser(user.id);
    await checkAndAct({
      db, userId: user.id, timezone: user.timezone, telegram, chatId,
      now: new Date('2026-02-06T08:00:00Z'),
    });

    await seedOneDay(db, user, BASELINE_DAYS + 1, { ...calmValue(BASELINE_DAYS + 1), hrv: 14 });
    const anchor = healthDateOf(user, BASELINE_DAYS + 1);
    await db.addJournalEvent(user.id, {
      eventAt: `${anchor}T10:00:00.000Z`, healthDate: anchor, category: 'alcohol',
      numericValue: 2, unit: 'drinks', source: 'manual',
    });

    const result = await checkAndAct({
      db, userId: user.id, timezone: user.timezone, telegram, chatId,
      now: new Date('2026-02-07T08:00:00Z'),
    });

    assert.equal(result.decision, PROACTIVE_DECISION.LOG_ONLY);
    assert.equal(result.reason, 'context_already_explained');
    assert.equal(telegram.sent.length, 0);
  } finally {
    db.close();
    cleanup();
  }
});

// ===========================================================================
// PA10-PA14: 回答 → journal → reanalysis → insight/follow-up
// ===========================================================================

function fakeCoachFor(answer) {
  return () => ({
    json: async () => answer,
    ask: async () => null,
  });
}

async function seedPersistentHrvSignal(db, user, telegram, chatId) {
  await seedCalmBaseline(db, user, BASELINE_DAYS);
  await seedOneDay(db, user, BASELINE_DAYS, { ...calmValue(BASELINE_DAYS), hrv: 15 });
  await checkAndAct({
    db, userId: user.id, timezone: user.timezone, telegram, chatId,
    now: new Date('2026-02-06T08:00:00Z'),
  });
  await seedOneDay(db, user, BASELINE_DAYS + 1, { ...calmValue(BASELINE_DAYS + 1), hrv: 14 });
  const day2 = await checkAndAct({
    db, userId: user.id, timezone: user.timezone, telegram, chatId,
    now: new Date('2026-02-07T08:00:00Z'),
  });
  assert.equal(day2.decision, PROACTIVE_DECISION.ASK_CONTEXT, '測試前提：第二天應該進到 ASK_CONTEXT');
}

test('★★★ PA10-11: 回答問題 → 寫入 journal（source=proactive_agent）→ 誠實回報「還不足以確認」', async () => {
  const { db, cleanup } = tempDb();
  try {
    await db.migrate();
    const user = await seedSingleUser(db);
    const telegram = fakeTelegram();
    const chatId = await db.getActiveChatIdForUser(user.id);
    await seedPersistentHrvSignal(db, user, telegram, chatId);

    const pending = await db.getOpenPendingQuestion(user.id, { now: new Date('2026-02-07T08:05:00Z') });
    assert.ok(pending);

    const coachFor = fakeCoachFor({
      asserted: true, about_self: true, negated: false, hypothetical: false,
      category: 'alcohol', subtype: null, numeric_value: 2, unit: 'drinks',
      day_offset: -1, confidence: 0.9,
    });
    const router = createRouter({ db, coachFor, now: () => new Date('2026-02-07T08:05:00Z') });

    const reply = await router.handle({
      text: '喝了兩杯', chatId, user: { id: user.id, timezone: user.timezone },
    });

    assert.match(reply, /已記錄/);
    assert.match(reply, /還不足以確認/);

    const events = await db.getJournalEvents(user.id, { from: '2026-01-01', to: '2026-12-31' });
    const proactiveEvent = events.find((e) => e.source === 'proactive_agent');
    assert.ok(proactiveEvent, 'journal 應該有一筆 source=proactive_agent 的紀錄');
    assert.equal(proactiveEvent.category, 'alcohol');

    const closed = await db.getOpenPendingQuestion(user.id, { now: new Date('2026-02-07T08:06:00Z') });
    assert.equal(closed, null, 'pending question 應該已經被回答並關閉');
  } finally {
    db.close();
    cleanup();
  }
});

test('PA10: 明確回答「沒有」→ 不寫 journal，也不再追問', async () => {
  const { db, cleanup } = tempDb();
  try {
    await db.migrate();
    const user = await seedSingleUser(db);
    const telegram = fakeTelegram();
    const chatId = await db.getActiveChatIdForUser(user.id);
    await seedPersistentHrvSignal(db, user, telegram, chatId);

    const router = createRouter({ db, coachFor: fakeCoachFor(null), now: () => new Date('2026-02-07T08:05:00Z') });
    const reply = await router.handle({
      text: '沒有', chatId, user: { id: user.id, timezone: user.timezone },
    });
    assert.match(reply, /先記著/);

    const events = await db.getJournalEvents(user.id, { from: '2026-01-01', to: '2026-12-31' });
    assert.equal(events.filter((e) => e.source === 'proactive_agent').length, 0);
  } finally {
    db.close();
    cleanup();
  }
});

test('PA7: 看不懂的回答只允許一次澄清追問，不會無限盤問', async () => {
  const { db, cleanup } = tempDb();
  try {
    await db.migrate();
    const user = await seedSingleUser(db);
    const telegram = fakeTelegram();
    const chatId = await db.getActiveChatIdForUser(user.id);
    await seedPersistentHrvSignal(db, user, telegram, chatId);

    // coach.json 回傳 null → parseNaturalJournal 視為看不懂
    const router = createRouter({ db, coachFor: fakeCoachFor(null), now: () => new Date('2026-02-07T08:05:00Z') });

    const first = await router.handle({
      text: '嗯...', chatId, user: { id: user.id, timezone: user.timezone },
    });
    assert.match(first, /沒有聽懂/);

    const clarifying = await db.getOpenPendingQuestion(user.id, { now: new Date('2026-02-07T08:06:00Z') });
    assert.ok(clarifying, '應該開了一個澄清用的 pending question');
    assert.equal(clarifying.context.clarified, true);

    const second = await router.handle({
      text: '還是不知道', chatId, user: { id: user.id, timezone: user.timezone },
    });
    assert.doesNotMatch(second, /沒有聽懂/, '澄清過一次之後不該再問第二次');

    const afterSecond = await db.getOpenPendingQuestion(user.id, { now: new Date('2026-02-07T08:07:00Z') });
    assert.equal(afterSecond, null, '不應該再開新的 pending question');
  } finally {
    db.close();
    cleanup();
  }
});

// ===========================================================================
// PA19: multi-user 隔離——Alice 的一切狀態絕不能影響 Bob
// ===========================================================================

test('★★★ PA19: Alice 的持續性訊號、pending question 完全不影響 Bob', async () => {
  const { db, cleanup } = tempDb();
  try {
    await db.migrate();
    await seedAliceAndBob(db);

    const aliceTelegram = fakeTelegram();
    const bobTelegram = fakeTelegram();
    const aliceChatId = await db.getActiveChatIdForUser(ALICE.id);
    const bobChatId = await db.getActiveChatIdForUser(BOB.id);

    await seedCalmBaseline(db, ALICE, BASELINE_DAYS, { idPrefix: 'alice' });
    await seedOneDay(db, ALICE, BASELINE_DAYS, { ...calmValue(BASELINE_DAYS), hrv: 15 }, { idPrefix: 'alice' });
    await seedCalmBaseline(db, BOB, BASELINE_DAYS, { idPrefix: 'bob' });
    await seedOneDay(db, BOB, BASELINE_DAYS, calmValue(BASELINE_DAYS), { idPrefix: 'bob' }); // Bob 完全平穩

    await checkAndAct({
      db, userId: ALICE.id, timezone: ALICE.timezone, telegram: aliceTelegram, chatId: aliceChatId,
      now: new Date('2026-02-06T08:00:00Z'),
    });
    await checkAndAct({
      db, userId: BOB.id, timezone: BOB.timezone, telegram: bobTelegram, chatId: bobChatId,
      now: new Date('2026-02-06T08:00:00Z'),
    });

    await seedOneDay(db, ALICE, BASELINE_DAYS + 1, { ...calmValue(BASELINE_DAYS + 1), hrv: 14 }, { idPrefix: 'alice' });
    await seedOneDay(db, BOB, BASELINE_DAYS + 1, calmValue(BASELINE_DAYS + 1), { idPrefix: 'bob' });

    const aliceDay2 = await checkAndAct({
      db, userId: ALICE.id, timezone: ALICE.timezone, telegram: aliceTelegram, chatId: aliceChatId,
      now: new Date('2026-02-07T08:00:00Z'),
    });
    assert.equal(aliceDay2.decision, PROACTIVE_DECISION.ASK_CONTEXT);
    assert.equal(aliceTelegram.sent.length, 1);

    const bobResult = await checkAndAct({
      db, userId: BOB.id, timezone: BOB.timezone, telegram: bobTelegram, chatId: bobChatId,
      now: new Date('2026-02-07T08:00:00Z'),
    });
    assert.equal(bobResult.decision, PROACTIVE_DECISION.IGNORE, 'Bob 平穩資料不該被 Alice 的訊號影響');
    assert.equal(bobTelegram.sent.length, 0);

    const aliceQuestion = await db.getOpenPendingQuestion(ALICE.id, { now: new Date('2026-02-07T08:05:00Z') });
    const bobQuestion = await db.getOpenPendingQuestion(BOB.id, { now: new Date('2026-02-07T08:05:00Z') });
    assert.ok(aliceQuestion);
    assert.equal(bobQuestion, null, 'Alice 的 pending question 絕不能出現在 Bob 名下');

    const bobEvents = await db.getRecentProactiveEvents(BOB.id, { sinceIso: '2026-01-01T00:00:00.000Z' });
    assert.ok(
      bobEvents.every((e) => !e.signals?.some((s) => s.code?.includes('HRV'))),
      'Bob 名下不該有任何因為 Alice 訊號而產生的 HRV 相關 proactive_events',
    );
  } finally {
    db.close();
    cleanup();
  }
});
