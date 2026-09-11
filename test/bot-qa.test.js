/**
 * Telegram Q&A + journal + 追問（Phase M / N / O）。
 *
 * 全部用 synthetic data 與 mock LLM。
 * 最重要的一組是「完全沒有 WHOOP 資料時」的行為 —— 那正是現在的真實狀況。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createDb } from '../src/db.js';
import { createSync } from '../src/sync.js';
import { createRouter, looksLikeJournal, parseNaturalJournal } from '../src/bot/router.js';
import {
  deterministicIntent, validateIntent, parseCommand, extractWindowDays, extractMetric,
} from '../src/bot/intent.js';
import { renderFallback, buildAnswerContext } from '../src/bot/answer.js';
import { isNegativeAnswer, shouldFollowUp } from '../src/bot/conversation.js';
import { makeDataset, degradedOverrides } from './fixtures.js';

const TZ = 'Asia/Taipei';
const CHAT = '12345';
const NOW = new Date('2026-09-01T00:00:00Z');

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whoop-qa-'));
  return {
    url: `file:${path.join(dir, 'qa.db')}`,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

/** mock LLM：回傳預設答案，並記錄收到什麼。 */
function fakeCoach({ answer = '（教練回覆）', json = null } = {}) {
  const calls = { ask: [], json: [] };
  return {
    calls,
    async ask(args) { calls.ask.push(args); return answer; },
    async json(args) { calls.json.push(args); return json; },
  };
}

async function dbWithData({ days = 60, overrides = undefined } = {}) {
  const { url, cleanup } = tempDb();
  const db = createDb({ url });
  await db.migrate();
  if (days > 0) {
    const ds = makeDataset({ days, now: NOW, overrides });
    const whoop = {
      sleeps: async () => ds.sleeps,
      recoveries: async () => ds.recoveries,
      cycles: async () => ds.cycles,
      workouts: async () => [],
      bodyMeasurement: async () => null,
    };
    const sync = createSync({ db, whoop, userId: USER.id, timezone: TZ, now: NOW });
    await sync.incremental('sleep');
    await sync.incremental('recovery');
    await sync.incremental('cycle');
  }
  return { db, cleanup };
}

const USER = { id: 'u-qa-test', timezone: TZ };

const routerFor = (db, coach = fakeCoach()) =>
  createRouter({ db, coachFor: () => coach, now: () => NOW });

// ===========================================================================
// Intent（確定性優先）
// ===========================================================================

test('M: 確定性 intent —— 常見問法都不需要 LLM', () => {
  assert.equal(deterministicIntent('我今天狀態怎樣？').intent, 'today_status');
  assert.equal(deterministicIntent('最近 HRV 如何？').intent, 'trend_query');
  assert.equal(deterministicIntent('最近 HRV 如何？').metric, 'hrv');
  assert.equal(deterministicIntent('最近睡眠有沒有變差？').intent, 'sleep_quality');
  assert.equal(deterministicIntent('最近 30 天最好是哪一天？').intent, 'best_worst_day');
  assert.equal(deterministicIntent('最近 30 天最好是哪一天？').window_days, 30);
  assert.equal(deterministicIntent('今天最值得注意的是什麼？').intent, 'what_changed');
  assert.equal(deterministicIntent('最近 recovery 趨勢怎樣？').intent, 'trend_query');
  assert.equal(deterministicIntent('最近 recovery 趨勢怎樣？').metric, 'recovery');
  // 全部都是 deterministic，一次 LLM 都沒用到
  for (const q of ['我今天狀態怎樣？', '最近 HRV 如何？']) {
    assert.equal(deterministicIntent(q).source, 'deterministic');
  }
});

test('★ M: 確定性判定寧可漏判也不誤判（今天天氣如何 ≠ 健康查詢）', () => {
  assert.equal(deterministicIntent('今天天氣如何'), null, '★ 不可以誤判成 today_status');
  assert.equal(deterministicIntent('今天股票怎樣'), null);
  // 有健康語境詞才算
  assert.equal(deterministicIntent('我今天狀態怎樣？').intent, 'today_status');
  assert.equal(deterministicIntent('今天恢復如何').intent, 'today_status');
});

test('M: 時間窗與指標抽取', () => {
  assert.equal(extractWindowDays('最近 7 天'), 7);
  assert.equal(extractWindowDays('past 90 days'), 90);
  assert.equal(extractWindowDays('這週'), 7);
  assert.equal(extractWindowDays('沒有數字'), null);
  assert.equal(extractWindowDays('最近 9999 天'), null, '超出範圍要拒絕');
  assert.equal(extractMetric('我的 hrv'), 'hrv');
  assert.equal(extractMetric('靜息心率'), 'rhr');
  assert.equal(extractMetric('隨便講講'), null);
});

test('★ M: LLM 提案一定要過 validate，不合法一律丟掉', () => {
  assert.equal(validateIntent({ intent: 'trend_query', metric: 'hrv', window_days: 30 }).intent, 'trend_query');
  assert.equal(validateIntent({ intent: '亂編的' }), null);
  assert.equal(validateIntent({ intent: 'unknown' }), null);
  assert.equal(validateIntent(null), null);
  assert.equal(validateIntent('字串'), null);
  // 超出範圍的 window 要被清成 null，而不是照用
  assert.equal(validateIntent({ intent: 'trend_query', window_days: 9999 }).window_days, null);
  assert.equal(validateIntent({ intent: 'trend_query', window_days: -5 }).window_days, null);
});

test('M: parseCommand', () => {
  assert.deepEqual(parseCommand('/help'), { command: 'help', argsText: '', args: [] });
  assert.equal(parseCommand('/log alcohol 3 drinks').command, 'log');
  assert.equal(parseCommand('/log alcohol 3 drinks').argsText, 'alcohol 3 drinks');
  assert.equal(parseCommand('/start@my_bot').command, 'start');
  assert.equal(parseCommand('不是指令'), null);
});

// ===========================================================================
// ★ 沒有 WHOOP 資料時的行為（現在的真實狀況）
// ===========================================================================

test('★ 沒有任何 WHOOP 資料：/start 說明現況，不當成錯誤', async () => {
  const { db, cleanup } = await dbWithData({ days: 0 });
  try {
    const reply = await routerFor(db).handle({ text: '/start', chatId: CHAT, user: USER });
    assert.match(reply, /還沒有同步到任何健康資料/);
    assert.match(reply, /自動開始分析/);
    assert.match(reply, /\/log/, '要告訴使用者現在已經能做什麼');
  } finally { db.close(); cleanup(); }
});

test('★ 沒有任何 WHOOP 資料：/healthdata 顯示 0，不是 error', async () => {
  const { db, cleanup } = await dbWithData({ days: 0 });
  try {
    const reply = await routerFor(db).handle({ text: '/healthdata', chatId: CHAT, user: USER });
    assert.match(reply, /尚未開始/);
    assert.match(reply, /睡眠：0 筆/);
    assert.match(reply, /恢復：0 筆/);
    assert.match(reply, /運動：0 筆/);
    assert.match(reply, /Capability probe：尚未執行/);
    assert.ok(!/error|錯誤|失敗/i.test(reply), '★ 沒資料不可以講成錯誤');
  } finally { db.close(); cleanup(); }
});

test('★ 沒有任何 WHOOP 資料：問問題會誠實說沒資料，不編數字', async () => {
  const { db, cleanup } = await dbWithData({ days: 0 });
  try {
    const coach = fakeCoach();
    const router = routerFor(db, coach);
    for (const q of ['我今天狀態怎樣？', '最近 HRV 如何？', '最近 30 天最好是哪一天？']) {
      const reply = await router.handle({ text: q, chatId: CHAT, user: USER });
      assert.match(reply, /還沒有足夠的 WHOOP 資料/, `「${q}」應該誠實回答`);
      assert.ok(!/\d+\s*(ms|bpm|%)/.test(reply), `★「${q}」的回覆不可以出現任何數字`);
    }
    assert.equal(coach.calls.ask.length, 0, '★ 沒資料時根本不該叫 LLM 講話');
  } finally { db.close(); cleanup(); }
});

test('★ 沒有任何 WHOOP 資料：/log 照樣可以成功保存', async () => {
  const { db, cleanup } = await dbWithData({ days: 0 });
  try {
    const reply = await routerFor(db).handle({ text: '/log alcohol 3 drinks', chatId: CHAT, user: USER });
    assert.match(reply, /已記錄/);
    // 顯示的是核可的中文標籤，不是內部鍵（內部鍵外洩過：「已記錄：alcohol」）
    assert.match(reply, /飲酒/);
    assert.doesNotMatch(reply, /alcohol/, '★ 內部類別鍵不可以出現在使用者看到的文字裡');

    const events = await db.getJournalEvents(USER.id, { from: '2026-01-01', to: '2027-01-01' });
    assert.equal(events.length, 1, '★ journal 不依賴 WHOOP 資料');
    assert.equal(events[0].category, 'alcohol');
    assert.equal(Number(events[0].numeric_value), 3);
    assert.equal(events[0].unit, 'drinks');
  } finally { db.close(); cleanup(); }
});

// ===========================================================================
// 有資料時的 Q&A
// ===========================================================================

test('M: 有資料時 today_status 只發布確定性斷言', async () => {
  const { db, cleanup } = await dbWithData({ days: 60 });
  try {
    const coach = fakeCoach({ answer: '早安 Kelvin，今天看起來不錯。' });
    const reply = await routerFor(db, coach).handle({ text: '我今天狀態怎樣？', chatId: CHAT, user: USER });

    // ★ R3-H-02：生理數值一律由確定性渲染器輸出，而且排在最前面。
    // LLM 的說明只是附加在後面的裝飾（而且必須不含任何生理斷言）。
    assert.match(reply, /恢復 \d+%/, '★ 數值必須來自確定性渲染器');
    assert.ok(!reply.includes('早安 Kelvin，今天看起來不錯。'));
    assert.equal(coach.calls.ask.length, 0);
  } finally { db.close(); cleanup(); }
});

test('M: trend_query 會算出趨勢與樣本數', async () => {
  const { db, cleanup } = await dbWithData({ days: 60 });
  try {
    const coach = fakeCoach();
    const ctx = await routerFor(db, coach).handle({ text: '最近 HRV 如何？', chatId: CHAT, user: USER });
    assert.equal(coach.calls.ask.length, 0);
    assert.match(ctx, /HRV/);
    assert.match(ctx, /n=\d+/, '一定要附樣本數');
    assert.match(ctx, /趨勢/);
  } finally { db.close(); cleanup(); }
});

test('M: best_worst_day 由 Node 挑出最好與最差的那一天', async () => {
  const { db, cleanup } = await dbWithData({ days: 60 });
  try {
    const coach = fakeCoach();
    const ctx = await routerFor(db, coach).handle({ text: '最近 30 天最好是哪一天？', chatId: CHAT, user: USER });
    assert.equal(coach.calls.ask.length, 0);
    assert.match(ctx, /最好：\d{4}-\d{2}-\d{2}/, '★ 日期由程式挑，不是 LLM 挑');
    assert.match(ctx, /最差：\d{4}-\d{2}-\d{2}/);
  } finally { db.close(); cleanup(); }
});

test('★ M: LLM 掛掉時走 Node 排版的 fallback，資訊仍完整', async () => {
  const { db, cleanup } = await dbWithData({ days: 60 });
  try {
    const brokenCoach = { async ask() { return null; }, async json() { return null; } };
    const reply = await routerFor(db, brokenCoach).handle({ text: '我今天狀態怎樣？', chatId: CHAT, user: USER });
    assert.match(reply, /恢復|HRV/, 'fallback 仍要有數據');
    assert.ok(reply.length > 10);
  } finally { db.close(); cleanup(); }
});

test('M: 不認得的問題會給提示，不會亂猜', async () => {
  const { db, cleanup } = await dbWithData({ days: 60 });
  try {
    const coach = fakeCoach({ json: { intent: 'unknown' } });
    const reply = await routerFor(db, coach).handle({ text: '今天天氣如何', chatId: CHAT, user: USER });
    assert.match(reply, /不太確定你想問什麼/);
    assert.match(reply, /\/help/);
  } finally { db.close(); cleanup(); }
});

test('M: renderFallback 對每種 intent 都有輸出', () => {
  assert.match(renderFallback(null), /還沒有足夠/);
  assert.match(renderFallback({ available: false }), /還沒有足夠/);
  assert.match(renderFallback({
    available: true, intent: 'what_changed', items: [],
  }), /沒有特別值得注意/);
});

test('M: buildAnswerContext 不含 raw DB row（不把整包資料丟給 LLM）', () => {
  const ctx = buildAnswerContext('今天怎樣', {
    available: true, intent: 'today_status', health_date: '2026-09-01', history_days: 60,
    metrics: { hrv: { label: 'HRV', value: 50, display: '50ms', baseline_display: '55ms', baseline_n: 30, z_score: -1.2, level: 'MILD' } },
    what_changed: [],
  });
  assert.ok(!ctx.includes('raw_json'));
  assert.ok(!ctx.includes('sleep_id'));
  assert.match(ctx, /HRV：50ms/);
});

// ===========================================================================
// Journal（Phase N）
// ===========================================================================

test('N: looksLikeJournal 區分「記錄」與「提問」', () => {
  assert.equal(looksLikeJournal('昨天喝了三杯酒'), true);
  assert.equal(looksLikeJournal('今天飛胡志明'), true);
  assert.equal(looksLikeJournal('昨晚兩點才睡'), true);
  assert.equal(looksLikeJournal('我今天狀態怎樣？'), false, '問句不可以被當成記錄');
  assert.equal(looksLikeJournal('最近睡眠如何'), false);
});

test('★ N: 自然語言 journal —— LLM 只提案，Node 驗證後才寫', async () => {
  const { db, cleanup } = await dbWithData({ days: 0 });
  try {
    const coach = fakeCoach({
      json: {
        asserted: true, about_self: true, negated: false, hypothetical: false,
        category: 'alcohol', subtype: null, numeric_value: 3,
        unit: 'drinks', day_offset: -1, confidence: 0.95,
      },
    });
    const reply = await routerFor(db, coach).handle({ text: '昨天喝了三杯酒', chatId: CHAT, user: USER });
    assert.match(reply, /已記錄/);

    const events = await db.getJournalEvents(USER.id, { from: '2026-01-01', to: '2027-01-01' });
    assert.equal(events.length, 1);
    assert.equal(events[0].category, 'alcohol');
    assert.equal(Number(events[0].numeric_value), 3);
    assert.equal(events[0].source, 'natural_language');
    // health_date 由 Node 算，不是 LLM 給的
    assert.match(events[0].health_date, /^\d{4}-\d{2}-\d{2}$/);
  } finally { db.close(); cleanup(); }
});

test('★ N: LLM 給不合法的 category → 拒絕寫入', async () => {
  const { db, cleanup } = await dbWithData({ days: 0 });
  try {
    const coach = fakeCoach({
      json: { category: '我亂編的類別', numeric_value: 3, confidence: 0.99 },
    });
    const out = await parseNaturalJournal({
      text: '昨天喝了三杯酒', now: NOW, timezone: TZ, coach,
    });
    assert.equal(out.ok, false);
    // Phase AB 之後，非法 enum 會先被 schema 驗證擋下（比原本的手動檢查更早），
    // 所以 reason 是 schema_invalid。兩者都代表「拒絕寫入」。
    assert.ok(
      ['schema_invalid', 'unknown_category'].includes(out.reason),
      `實際 reason=${out.reason}`,
    );
    assert.equal((await db.getJournalEvents(USER.id, { from: '2026-01-01', to: '2027-01-01' })).length, 0);
  } finally { db.close(); cleanup(); }
});

test('N: LLM 信心太低 → 不採用', async () => {
  const coach = fakeCoach({ json: { asserted: true, about_self: true, negated: false, hypothetical: false, category: 'alcohol', confidence: 0.2 } });
  const out = await parseNaturalJournal({ text: '可能有喝一點', now: NOW, timezone: TZ, coach });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'low_confidence');
});

test('N: 沒有 LLM 時自然語言解析安全失敗', async () => {
  const out = await parseNaturalJournal({ text: '昨天喝酒', now: NOW, timezone: TZ, coach: null });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'no_llm');
});

// ===========================================================================
// 追問（Phase O）
// ===========================================================================

test('O: shouldFollowUp 的條件', () => {
  const withNoteworthy = {
    available: true, intent: 'today_status',
    what_changed: [{ metric: 'hrv', noteworthy: true, level: 'STRONG' }],
  };
  assert.equal(shouldFollowUp({ result: withNoteworthy, journalCountForDay: 0 }), true);
  assert.equal(
    shouldFollowUp({ result: withNoteworthy, journalCountForDay: 2 }), false,
    '已經有 journal 就不必再問',
  );
  assert.equal(shouldFollowUp({
    result: { available: true, intent: 'today_status', what_changed: [] },
    journalCountForDay: 0,
  }), false, '沒有偏離就不要沒事找事問');
  assert.equal(shouldFollowUp({ result: { available: false }, journalCountForDay: 0 }), false);
});

test('O: isNegativeAnswer', () => {
  for (const s of ['沒有', '沒', '無', 'no', 'None', '都沒有', '沒事']) {
    assert.equal(isNegativeAnswer(s), true, `「${s}」應該算否定`);
  }
  assert.equal(isNegativeAnswer('喝了三杯'), false);
  assert.equal(isNegativeAnswer('沒睡好'), false, '「沒睡好」不是否定回答');
});

test('★ O: 完整追問流程 —— 反問 → 回答 → 寫 journal → 續答 → 清狀態', async () => {
  const { db, cleanup } = await dbWithData({ days: 60, overrides: degradedOverrides() });
  try {
    const coach = fakeCoach({
      answer: '今天恢復偏低。',
      json: {
        asserted: true, about_self: true, negated: false, hypothetical: false,
        category: 'alcohol', numeric_value: 3, unit: 'drinks',
        day_offset: -1, confidence: 0.95,
      },
    });
    const router = routerFor(db, coach);

    // 1. 問今天狀態 → 偏離明顯 + 當天沒有 journal → 應該反問
    const first = await router.handle({ text: '我今天狀態怎樣？', chatId: CHAT, user: USER });
    assert.match(first, /喝酒、旅行、生病/, '★ 應該發出追問');

    const pending = await db.getOpenPendingQuestion(USER.id, { now: NOW });
    assert.ok(pending, 'pending 要被保存');
    assert.equal(pending.intent, 'today_status');
    assert.equal(pending.originalMessage, '我今天狀態怎樣？');

    // 2. 使用者回答
    const second = await router.handle({ text: '喝了三杯酒', chatId: CHAT, user: USER });
    assert.match(second, /已記錄/, '要寫進 journal');

    const events = await db.getJournalEvents(USER.id, { from: '2026-01-01', to: '2027-01-01' });
    assert.equal(events.length, 1);
    assert.equal(events[0].category, 'alcohol');

    // 3. pending 被清掉
    assert.equal(await db.getOpenPendingQuestion(USER.id, { now: NOW }), null, '★ 回答後要清除');
  } finally { db.close(); cleanup(); }
});

test('★ O: pending 30 分鐘後過期，不會硬接後來不相干的話', async () => {
  const { db, cleanup } = await dbWithData({ days: 0 });
  try {
    await db.openPendingQuestion(USER.id, {
      chatId: CHAT, originalMessage: '今天怎樣', question: '昨天喝酒嗎？',
      intent: 'today_status', ttlMs: 30 * 60_000,
    }, { now: NOW });

    // 29 分鐘：還在
    assert.ok(await db.getOpenPendingQuestion(USER.id, { now: new Date(NOW.getTime() + 29 * 60_000) }));

    // 31 分鐘：過期
    const later = new Date(NOW.getTime() + 31 * 60_000);
    assert.equal(await db.getOpenPendingQuestion(USER.id, { now: later }), null, '★ 必須過期');

    // 而且已被標成 EXPIRED，不會再被撿起來
    assert.equal(await db.getOpenPendingQuestion(USER.id, { now: later }), null);
  } finally { db.close(); cleanup(); }
});

test('O: 同一個 chat 同時只會有一個 OPEN 追問', async () => {
  const { db, cleanup } = await dbWithData({ days: 0 });
  try {
    const a = await db.openPendingQuestion(USER.id, {
      chatId: CHAT, question: 'Q1', ttlMs: 60_000,
    }, { now: NOW });
    const b = await db.openPendingQuestion(USER.id, {
      chatId: CHAT, question: 'Q2', ttlMs: 60_000,
    }, { now: NOW });
    const open = await db.getOpenPendingQuestion(USER.id, { now: NOW });
    assert.equal(open.id, b, '最新的那個才是 OPEN');
    assert.notEqual(open.id, a);
  } finally { db.close(); cleanup(); }
});

test('O: 回答「沒有」不會寫 journal，但會收掉 pending', async () => {
  const { db, cleanup } = await dbWithData({ days: 0 });
  try {
    await db.openPendingQuestion(USER.id, {
      chatId: CHAT, originalMessage: '今天怎樣', question: 'Q', ttlMs: 60_000,
    }, { now: NOW });

    const reply = await routerFor(db).handle({ text: '沒有', chatId: CHAT, user: USER });
    assert.match(reply, /好，那我先/);
    assert.equal((await db.getJournalEvents(USER.id, { from: '2026-01-01', to: '2027-01-01' })).length, 0);
    assert.equal(await db.getOpenPendingQuestion(USER.id, { now: NOW }), null);
  } finally { db.close(); cleanup(); }
});

test('O: 有 pending 時輸入指令仍走指令，不會被當成回答', async () => {
  const { db, cleanup } = await dbWithData({ days: 0 });
  try {
    await db.openPendingQuestion(USER.id, {
      chatId: CHAT, question: 'Q', ttlMs: 60_000,
    }, { now: NOW });
    const reply = await routerFor(db).handle({ text: '/help', chatId: CHAT, user: USER });
    assert.match(reply, /我可以做這些事/);
    assert.ok(await db.getOpenPendingQuestion(USER.id, { now: NOW }), 'pending 應該還在');
  } finally { db.close(); cleanup(); }
});

test('router 永遠不拋錯（handler 內部爆炸也要回一句人話）', async () => {
  const broken = {
    getOpenPendingQuestion: async () => { throw new Error('DB 爆炸'); },
  };
  const router = createRouter({ db: broken, coachFor: () => null, now: () => NOW });
  const reply = await router.handle({ text: '我今天狀態怎樣？', chatId: CHAT, user: USER });
  assert.match(reply, /出了點問題/);
});
