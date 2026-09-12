/**
 * Codex regate 第四輪：寫入契約、原文否決權、同步真相、triage 精確度。
 *
 * 前三輪都在補「這句話該走哪條路」，這一輪補的是**授權本身仍然 fail open**：
 *
 *   1. schema 把四個語意欄位宣告成 nullable，runtime 只在 `=== true` 時拒絕 ——
 *      於是 `{asserted:true, about_self:true}` 這個缺了一半的物件直接通過。
 *   2. 即使欄位齊全，模型謊報就能推翻原文：「我今天沒有喝酒」配上
 *      `asserted:true, negated:false` 仍然寫出一筆飲酒紀錄。
 *   3. 驗這件事的測試自己會補預設值，所以永遠測不到缺欄位。
 *   4. 同步只要有任何一個資源成功過就宣稱「有，最後一次成功同步是……」，
 *      即使其他四個資源從來沒跑過。
 *   5. triage 把「這部電影讓我笑到喘不過氣」當成急診。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createDb } from '../src/db.js';
import { createRouter } from '../src/bot/router.js';
import {
  authorizeSemanticFields, rawTextVeto, authorizeJournalMutation,
  AUTHORIZED_SEMANTICS, categoryHintOf,
} from '../src/bot/journalAuthorization.js';
import { assessSync, SYNC_VERDICT, STALE_AFTER_MS } from '../src/syncTruth.js';
import { renderSyncAnswer } from '../src/bot/answer.js';
import { assessUrgency } from '../src/bot/triage.js';
import { resolvePerspective, PERSPECTIVE } from '../src/bot/perspective.js';
import { deterministicIntent } from '../src/bot/intent.js';
import { educationAnswer } from '../src/bot/healthEducation.js';
import { WHOOP_SYNC } from '../src/config.js';
import { STATUS } from '../src/capabilities.js';

const NOW = new Date('2026-09-11T09:05:00Z');
const HD = '2026-09-11';
const TZ = 'Asia/Taipei';

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r4-'));
  const db = createDb({ url: `file:${path.join(dir, 't.db')}` });
  return { db, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const L = 13_000_000; const SW = 7_000_000; const RM = 6_160_000;

async function seed() {
  const { db, cleanup } = tempDb();
  await db.migrate();
  const u = await db.createUser({ displayName: 'Kelvin', timezone: TZ });
  await db.linkTelegram({ chatId: '5001', userId: u.id });
  const end = new Date(Date.parse(`${HD}T00:00:00Z`) + 16 * 60_000).toISOString();
  const start = new Date(Date.parse(`${HD}T00:00:00Z`) - 7 * 3600_000).toISOString();
  await db.raw.execute({
    sql: `INSERT INTO whoop_sleeps (user_id,id,health_date,start_at,end_at,nap,score_state,
            sleep_performance_percentage,total_sleep_milli,light_sleep_milli,slow_wave_sleep_milli,
            rem_sleep_milli,created_at,updated_at,synced_at,raw_json)
          VALUES (?,?,?,?,?,0,'SCORED',87,?,?,?,?,?,?,?,?)`,
    args: [u.id, 's-0', HD, start, end, L + SW + RM, L, SW, RM, start, end, end,
      JSON.stringify({
        id: 's-0', score_state: 'SCORED',
        score: {
          sleep_performance_percentage: 87, respiratory_rate: 16.2,
          stage_summary: {
            total_light_sleep_time_milli: L, total_slow_wave_sleep_time_milli: SW,
            total_rem_sleep_time_milli: RM, total_awake_time_milli: 900000,
            total_in_bed_time_milli: L + SW + RM + 900000,
            disturbance_count: 9, sleep_cycle_count: 5,
          },
          sleep_needed: { baseline_milli: 28000000, need_from_sleep_debt_milli: 600000 },
        },
        start, end, nap: false,
      })],
  });
  await db.raw.execute({
    sql: `INSERT INTO whoop_recoveries (user_id,sleep_id,cycle_id,health_date,score_state,
            recovery_score,hrv_rmssd_milli,resting_heart_rate,user_calibrating,
            created_at,updated_at,synced_at,raw_json)
          VALUES (?,?,?,?,'SCORED',63,65.5599,54,1,?,?,?,?)`,
    args: [u.id, 's-0', 'c-0', HD, start, end, end,
      JSON.stringify({
        cycle_id: 'c-0', sleep_id: 's-0', score_state: 'SCORED',
        score: { recovery_score: 63, hrv_rmssd_milli: 65.5599, resting_heart_rate: 54, user_calibrating: true },
      })],
  });
  return { db, user: u, cleanup: () => { db.close(); cleanup(); } };
}

/** 原樣回傳指定的解析物件 —— 絕不補預設值。 */
const rawCoach = (obj) => () => ({
  async json() { return obj; },
  async ask() { return 'x'; },
});
/** 完整合法的解析結果。只給「明確想要一個合法物件」的測試用。 */
const validParse = (over = {}) => ({
  category: 'alcohol', subtype: null, numeric_value: null, unit: null, confidence: 0.9,
  ...AUTHORIZED_SEMANTICS, time_precision: 'now', ...over,
});

const bot = (db, user, coachFor) => {
  const r = createRouter({ db, coachFor, now: () => NOW });
  return (text) => r.handle({ text, chatId: '5001', user: { id: user.id, timezone: TZ } });
};
const rows = async (db, uid) => db.getJournalEvents(uid, { from: '2026-08-01', to: '2026-10-01', limit: 200 });

/** 走真實路由，回 {reply, delta}。 */
async function route(text, parserObj) {
  const { db, user, cleanup } = await seed();
  try {
    const reply = await bot(db, user, rawCoach(parserObj))(text);
    return { reply, delta: (await rows(db, user.id)).length };
  } finally { cleanup(); }
}

// ===========================================================================
// A — 結構化寫入契約
// ===========================================================================

test('★★★ A1: 唯一被授權的組合', () => {
  assert.deepEqual(AUTHORIZED_SEMANTICS, {
    asserted: true, negated: false, hypothetical: false, about_self: true,
  });
  assert.equal(authorizeSemanticFields({ ...AUTHORIZED_SEMANTICS }).ok, true);
});

test('★★★ A2: Codex 實測的漏洞物件必須被拒絕（缺 negated / hypothetical）', async () => {
  const vulnerable = { category: 'alcohol', asserted: true, about_self: true, confidence: 0.9 };
  const fields = authorizeSemanticFields(vulnerable);
  assert.equal(fields.ok, false, '★ 契約層必須拒絕');
  assert.equal(fields.reason, 'missing_field');
  assert.ok(['negated', 'hypothetical'].includes(fields.field), '★ 要指出缺哪一個');

  // 端到端：原文是清楚的個人主張，所以唯一的攔截點就是契約
  const r = await route('我剛剛喝酒了，為什麼這麼累？', vulnerable);
  assert.equal(r.delta, 0, '★ 端到端也必須零寫入');
  assert.doesNotMatch(r.reply, /已記錄|幫你記下/, '★ 不可以宣稱記錄了');
});

test('★★★ A3: 缺欄位 / null / 錯型 / 矛盾 —— 逐一驗證', () => {
  const cases = [
    ['{}', {}],
    ['asserted only', { asserted: true }],
    ['missing negated', { asserted: true, about_self: true, hypothetical: false }],
    ['missing hypothetical', { asserted: true, about_self: true, negated: false }],
    ['missing about_self', { asserted: true, negated: false, hypothetical: false }],
    ['asserted=null', { asserted: null, negated: false, hypothetical: false, about_self: true }],
    ['negated=null', { asserted: true, negated: null, hypothetical: false, about_self: true }],
    ['hypothetical=null', { asserted: true, negated: false, hypothetical: null, about_self: true }],
    ['about_self=null', { asserted: true, negated: false, hypothetical: false, about_self: null }],
    ['asserted="yes"', { asserted: 'yes', negated: false, hypothetical: false, about_self: true }],
    ['negated="false"', { asserted: true, negated: 'false', hypothetical: false, about_self: true }],
    ['hypothetical=0', { asserted: true, negated: false, hypothetical: 0, about_self: true }],
    ['about_self=1', { asserted: true, negated: false, hypothetical: false, about_self: 1 }],
    ['negated=true', { asserted: true, negated: true, hypothetical: false, about_self: true }],
    ['hypothetical=true', { asserted: true, negated: false, hypothetical: true, about_self: true }],
    ['asserted=false', { asserted: false, negated: false, hypothetical: false, about_self: true }],
    ['about_self=false', { asserted: true, negated: false, hypothetical: false, about_self: false }],
  ];
  for (const [label, obj] of cases) {
    assert.equal(authorizeSemanticFields(obj).ok, false, `★ ${label} 必須被拒絕`);
  }
});

test('★★★ A4: schema 層也必須拒絕（兩層獨立，不是只靠其中一層）', async () => {
  const { validateStructured } = await import('../src/llmValidation.js');
  const { JOURNAL_SCHEMA } = await import('../src/bot/router.js');
  const r = validateStructured(
    { category: 'alcohol', asserted: true, about_self: true, confidence: 0.9 },
    JOURNAL_SCHEMA,
  );
  assert.equal(r.ok, false, '★ schema 必須把缺席的語意欄位算成錯誤');
  assert.ok(r.errors.some((e) => e === 'missing:negated'), `★ 要有 missing:negated（${r.errors}）`);
  assert.ok(r.errors.some((e) => e === 'missing:hypothetical'), '★ 要有 missing:hypothetical');
  // 型別也要擋
  const typed = validateStructured(
    { ...validParse({ asserted: 'yes' }) }, JOURNAL_SCHEMA,
  );
  assert.equal(typed.ok, false);
  assert.ok(typed.errors.some((e) => e.startsWith('not_a_boolean:asserted')));
});

// ===========================================================================
// B — 原文否決權（模型謊報也擋得住）
// ===========================================================================

/** 這些原文即使配上**完全合法而且謊報**的解析結果，也必須零寫入。 */
const VETO_CASES = [
  ['negation', '我今天沒有喝酒，為什麼還是很累？', 'alcohol'],
  ['negation', '我沒喝酒', 'alcohol'],
  ['negation', '我沒有熬夜', 'late_sleep'],
  ['negation', '我今天並沒有喝酒', 'alcohol'],
  ['negation', '我不是喝酒後才累', 'alcohol'],
  ['negation', '我根本沒運動', 'exercise_note'],
  ['negation', '今天沒有喝任何酒', 'alcohol'],
  ['negation', '我不喝酒，為什麼 recovery 還是低？', 'alcohol'],
  ['hypothetical', '如果我喝酒，明天會比較累嗎？', 'alcohol'],
  ['hypothetical', '假如昨晚喝酒，今天 recovery 會變低嗎？', 'alcohol'],
  ['hypothetical', '要是我喝酒會怎樣？', 'alcohol'],
  ['hypothetical', '有喝酒的話，HRV 會降低嗎？', 'alcohol'],
  ['hypothetical', '如果沒有喝酒，數值會比較好嗎？', 'alcohol'],
  ['uncertain', '我不確定剛才那杯有沒有酒精', 'alcohol'],
  ['uncertain', '我是不是喝酒了？', 'alcohol'],
  ['uncertain', '我昨天有喝酒嗎？', 'alcohol'],
  ['uncertain', '你記得我有沒有喝酒嗎？', 'alcohol'],
  ['uncertain', '我可能有喝酒，但不確定', 'alcohol'],
  ['uncertain', '我好像喝了酒', 'alcohol'],
  ['meta', '我已經跟你說過我喝酒了，為什麼還要再記？', 'alcohol'],
  ['third_party', '我朋友喝酒後很累', 'alcohol'],
  ['third_party', '他昨晚喝酒', 'alcohol'],
  ['general', '有人喝酒後 HRV 會降低嗎？', 'alcohol'],
  ['general', '喝酒會讓人累嗎？', 'alcohol'],
  ['general', '為什麼有人運動完會累？', 'exercise_note'],
];

test('★★★ B1: 原文否決權 —— 25 種情況即使解析結果完全合法也不寫入', () => {
  for (const [kind, text, category] of VETO_CASES) {
    const v = rawTextVeto({ text, category });
    assert.equal(v.vetoed, true, `★ [${kind}] 「${text}」必須被否決`);
  }
});

test('★★★ B2: 端到端 —— 謊報的解析器推翻不了原文', async () => {
  for (const [kind, text, category] of VETO_CASES) {
    // 完全合法、而且謊報「這是使用者親口說發生過的事」
    const dishonest = validParse({ category, time_precision: 'now' });
    const r = await route(text, dishonest);
    assert.equal(r.delta, 0, `★ [${kind}] 「${text}」寫了 ${r.delta} 筆`);
    assert.doesNotMatch(r.reply, /已記錄|幫你記下/, `★ [${kind}] 「${text}」不可以宣稱記錄了`);
    assert.ok(r.reply.length > 10, `★ [${kind}] 「${text}」仍然要回答`);
  }
});

/** 清楚的個人主張 —— 否決權不可以擋到這些。 */
const POSITIVE_CASES = [
  ['我今天喝酒了', 'alcohol'],
  ['我剛剛喝了兩杯', 'alcohol'],
  ['我昨晚熬夜到三點', 'late_sleep'],
  ['我剛運動完', 'exercise_note'],
  ['我今天壓力很大', 'stress'],
  ['我吃了很晚的晚餐', 'late_meal'],
  ['我喝酒了，為什麼現在這麼累？', 'alcohol'],
];

test('★★★ B3: 清楚的個人主張不被否決，而且真的寫入一筆', async () => {
  for (const [text, category] of POSITIVE_CASES) {
    assert.equal(rawTextVeto({ text, category }).vetoed, false, `★ 「${text}」不該被否決`);
    const r = await route(text, validParse({ category }));
    assert.equal(r.delta, 1, `★ 「${text}」應該寫入一筆（實際 ${r.delta}）`);
  }
});

test('★★★ B4: 否定範圍 —— 雙重否定與跨類別否定', () => {
  // 雙重否定 = 肯定，不否決
  assert.equal(rawTextVeto({ text: '我不是沒喝酒，我是喝了兩杯', category: 'alcohol' }).vetoed, false);
  assert.equal(rawTextVeto({ text: '我沒有不喝，我確實喝了', category: 'alcohol' }).vetoed, false);
  // 第三人稱本身被否定 → 其實在講自己
  assert.equal(rawTextVeto({ text: '不是我朋友，是我喝酒了', category: 'alcohol' }).vetoed, false);
  // 否定的是酒，不是熬夜 —— 對準 late_sleep 時不該被擋
  assert.equal(rawTextVeto({ text: '我沒有喝酒，但我昨晚熬夜了', category: 'late_sleep' }).vetoed, false);
  // 同一句對準 alcohol 時必須否決
  assert.equal(rawTextVeto({ text: '我沒有喝酒，但我昨晚熬夜了', category: 'alcohol' }).vetoed, true);
});

test('★★★ B5: 明確記錄指令帶否定 → 誠實說明限制，不記反向事件', async () => {
  const { db, user, cleanup } = await seed();
  try {
    const reply = await bot(db, user, rawCoach(validParse()))('幫我記錄今天沒有喝酒');
    assert.equal((await rows(db, user.id)).length, 0, '★ 絕不可以記成一筆飲酒');
    assert.match(reply, /只能記下發生過的事|沒有辦法記/, '★ 要說明限制');
    assert.doesNotMatch(reply, /✅ 已記錄/, '★ 不可以假裝記到了');
  } finally { cleanup(); }
  assert.equal(categoryHintOf('幫我記錄今天沒有喝酒'), 'alcohol');
});

test('★★★ B6: 明確記錄指令（沒有否定）照舊工作', async () => {
  for (const text of ['幫我記錄喝酒吧', '記一下我昨晚熬夜', '幫我登記今天喝了兩杯']) {
    const { db, user, cleanup } = await seed();
    try {
      const cat = text.includes('熬夜') ? 'late_sleep' : 'alcohol';
      const reply = await bot(db, user, rawCoach(validParse({ category: cat })))(text);
      assert.equal((await rows(db, user.id)).length, 1, `★ 「${text}」應寫入一筆`);
      assert.match(reply, /已記錄|記下/, `★ 「${text}」要確認`);
    } finally { cleanup(); }
  }
});

test('★★★ B7: 追問的短答（主詞省略）仍然記得下來', async () => {
  const { db, user, cleanup } = await seed();
  try {
    await db.openPendingQuestion(user.id, {
      chatId: '5001', question: '昨天有喝酒嗎？', intent: 'today_status',
      contextJson: { health_date: HD, question_target_date: '2026-09-10' },
      ttlMs: 3600_000,
    }, { now: NOW });
    const reply = await bot(db, user, rawCoach(validParse({ time_precision: 'date' })))('喝了三杯酒');
    assert.match(reply, /已記錄|記下/, '★ 追問的答覆要被收下');
    assert.equal((await rows(db, user.id)).length, 1);
  } finally { cleanup(); }
});

test('★★★ B8: 兩道關卡是獨立的（任一道就足以否決）', () => {
  // 欄位不合格、原文清楚 → 契約擋下
  const a = authorizeJournalMutation({
    text: '我剛剛喝酒了', raw: { asserted: true, about_self: true }, category: 'alcohol',
  });
  assert.equal(a.ok, false); assert.equal(a.gate, 'semantic_fields');
  // 欄位合格、原文否定 → 否決權擋下
  const b = authorizeJournalMutation({
    text: '我今天沒有喝酒', raw: { ...AUTHORIZED_SEMANTICS }, category: 'alcohol',
  });
  assert.equal(b.ok, false); assert.equal(b.gate, 'raw_text_veto'); assert.equal(b.reason, 'negated');
  // 兩者都合格 → 通過
  const c = authorizeJournalMutation({
    text: '我剛剛喝酒了', raw: { ...AUTHORIZED_SEMANTICS }, category: 'alcohol',
  });
  assert.equal(c.ok, true);
});

// ===========================================================================
// C — 同步真相表
// ===========================================================================

const EXPECTED = WHOOP_SYNC.RESOURCES;
const st = (resource, over = {}) => ({
  resource, last_success_at: null, last_error: null, last_error_at: null, ...over,
});
const okAt = (t) => ({ last_success_at: t });
const T_NOW = new Date('2026-09-11T09:05:00Z');
const RECENT = '2026-09-11T04:32:23.000Z';
const OLD = '2026-08-20T04:32:23.000Z';

test('★★★ C0: 預期資源只有一份來源（config 的 canonical 清單）', () => {
  const a = assessSync({ states: [], now: T_NOW });
  assert.deepEqual(a.expected_resources, EXPECTED);
  assert.deepEqual(EXPECTED, ['sleep', 'recovery', 'cycle', 'workout', 'body_measurement']);
});

test('★★★ C1: 沒有任何狀態列 → never_synced', () => {
  const a = assessSync({ states: [], now: T_NOW });
  assert.equal(a.verdict, SYNC_VERDICT.NEVER_SYNCED);
  assert.match(renderSyncAnswer({ ...a, intent: 'sync_status' }), /從來沒有跑成功過|還沒有任何同步紀錄/);
});

test('★★★ C2: 每個預期資源最近一次都成功 → latest_success_complete', () => {
  const a = assessSync({ states: EXPECTED.map((r) => st(r, okAt(RECENT))), now: T_NOW });
  assert.equal(a.verdict, SYNC_VERDICT.LATEST_SUCCESS_COMPLETE);
  assert.equal(a.complete, true);
  assert.deepEqual(a.missing_resources, []);
  assert.match(renderSyncAnswer(a), /最近一次完整同步成功/);
});

test('★★★ C3: 只有 sleep 成功 → 不可以宣稱完整（Codex 實測的謊）', () => {
  const a = assessSync({ states: [st('sleep', okAt(RECENT))], now: T_NOW });
  assert.equal(a.verdict, SYNC_VERDICT.LATEST_SUCCESS_PARTIAL);
  assert.equal(a.complete, false);
  assert.deepEqual(a.covered_resources, ['sleep']);
  assert.deepEqual(a.missing_resources, ['recovery', 'cycle', 'workout', 'body_measurement']);
  const reply = renderSyncAnswer(a);
  assert.match(reply, /部分/, '★ 必須說是部分');
  assert.doesNotMatch(reply, /完整同步成功/, '★ 不可以宣稱完整');
});

test('★★★ C4: sleep + recovery 成功，其餘缺列 → partial', () => {
  const a = assessSync({
    states: [st('sleep', okAt(RECENT)), st('recovery', okAt(RECENT))], now: T_NOW,
  });
  assert.equal(a.verdict, SYNC_VERDICT.LATEST_SUCCESS_PARTIAL);
  assert.deepEqual(a.missing_resources, ['cycle', 'workout', 'body_measurement']);
});

test('★★★ C5: 全部有列但其中一個最近一次失敗 → historical_success_but_latest_failed', () => {
  const states = EXPECTED.map((r) => st(r, okAt(RECENT)));
  states[2] = st('cycle', {
    last_success_at: OLD, last_error: 'HTTP 500', last_error_at: '2026-09-11T05:00:00.000Z',
  });
  const a = assessSync({ states, now: T_NOW });
  assert.equal(a.verdict, SYNC_VERDICT.HISTORICAL_SUCCESS_LATEST_FAILED);
  assert.deepEqual(a.failing_resources, ['cycle']);
  const reply = renderSyncAnswer(a);
  assert.match(reply, /之前成功過/);
  assert.doesNotMatch(reply, /完整同步成功/);
});

test('★★★ C6: 失敗而且從來沒成功過 → latest_failed', () => {
  const a = assessSync({
    states: EXPECTED.map((r) => st(r, { last_error: 'HTTP 401', last_error_at: RECENT })),
    now: T_NOW,
  });
  assert.equal(a.verdict, SYNC_VERDICT.LATEST_FAILED);
  assert.match(renderSyncAnswer(a), /同步是失敗的/);
});

test('★★★ C7: 全部成功但太舊 → stale_success', () => {
  const stale = new Date(T_NOW.getTime() - STALE_AFTER_MS - 3600_000).toISOString();
  const a = assessSync({ states: EXPECTED.map((r) => st(r, okAt(stale))), now: T_NOW });
  assert.equal(a.verdict, SYNC_VERDICT.STALE_SUCCESS);
  assert.equal(a.stale, true);
  assert.match(renderSyncAnswer(a), /一段時間沒有更新/);
});

test('★★★ C8: capability 說拿不到的資源不算進預期（不支援 ≠ 不完整）', () => {
  const supported = EXPECTED.filter((r) => r !== 'workout');
  const a = assessSync({
    states: supported.map((r) => st(r, okAt(RECENT))),
    capabilities: { workout: { status: STATUS.UNAUTHORIZED } },
    now: T_NOW,
  });
  assert.equal(a.verdict, SYNC_VERDICT.LATEST_SUCCESS_COMPLETE, '★ 排除不支援的之後算完整');
  assert.deepEqual(a.excluded_resources, ['workout']);
  assert.ok(!a.expected_resources.includes('workout'));
  // 洩漏檢查
  const reply = renderSyncAnswer(a);
  for (const leak of ['workout', 'capability', 'UNAUTHORIZED', 'endpoint', 'backfill', 'probe']) {
    assert.ok(!reply.includes(leak), `★ 不可以洩漏「${leak}」`);
  }
});

test('★★★ C9: capability 未知 → 不可以宣稱完整', () => {
  const a = assessSync({
    states: EXPECTED.map((r) => st(r, okAt(RECENT))),
    capabilities: { workout: { status: STATUS.UNKNOWN } },
    now: T_NOW,
  });
  assert.equal(a.verdict, SYNC_VERDICT.LATEST_SUCCESS_PARTIAL, '★ 預期本身不確定就不能說完整');
  assert.deepEqual(a.unknown_capability_resources, ['workout']);
});

test('★★★ C10: 有錯誤字串但沒有時間 → 證據不足，不算成功', () => {
  const states = EXPECTED.map((r) => st(r, okAt(RECENT)));
  states[1] = st('recovery', { last_success_at: RECENT, last_error: 'boom', last_error_at: null });
  const a = assessSync({ states, now: T_NOW });
  assert.equal(a.verdict, SYNC_VERDICT.INCOMPLETE_EVIDENCE);
  assert.match(renderSyncAnswer(a), /只能確認部分狀態/);
});

test('★★★ C11: 未來的時間戳是壞資料，不是「非常新」', () => {
  const future = new Date(T_NOW.getTime() + 86_400_000).toISOString();
  const states = EXPECTED.map((r) => st(r, okAt(RECENT)));
  states[0] = st('sleep', okAt(future));
  const a = assessSync({ states, now: T_NOW });
  assert.equal(a.verdict, SYNC_VERDICT.INCOMPLETE_EVIDENCE);
  assert.deepEqual(a.invalid_timestamp_resources, ['sleep']);
  // 無效的時間戳不可以變成 last_success_at
  assert.notEqual(a.last_success_at, future);
});

test('★★★ C12: 同一資源重複列 → 取最新的成功，不重複計算', () => {
  const states = [
    ...EXPECTED.map((r) => st(r, okAt(OLD))),
    st('sleep', okAt(RECENT)),
  ];
  const a = assessSync({ states, now: T_NOW });
  assert.equal(a.covered_resources.length, EXPECTED.length, '★ 覆蓋率不可以被重複列放大');
  assert.equal(a.last_success_at, RECENT);
});

test('★★★ C13: 同步成功但沒有新的量測 → 分開講，不當成失敗', () => {
  const a = assessSync({
    states: EXPECTED.map((r) => st(r, okAt(RECENT))), now: T_NOW,
    latestHealthDate: '2026-09-09',
  });
  assert.equal(a.verdict, SYNC_VERDICT.LATEST_SUCCESS_COMPLETE);
  const reply = renderSyncAnswer({ ...a, no_new_data: true });
  assert.match(reply, /還沒有今天的新資料/);
  assert.doesNotMatch(reply, /失敗/, '★ 不是失敗');
});

test('★★★ C14: 端到端 —— 只有 sleep 有紀錄時不可以說「有，最後一次成功同步」', async () => {
  const { db, user, cleanup } = await seed();
  try {
    await db.saveSyncState(user.id, 'sleep', { lastSuccessAt: RECENT }, { now: NOW });
    const reply = await bot(db, user, rawCoach(validParse()))('WHOOP 有同步成功嗎');
    assert.match(reply, /部分/, '★ 要誠實說只有部分');
    assert.doesNotMatch(reply, /完整同步成功/, '★ 不可以宣稱完整');
    for (const leak of ['capability', 'backfill', 'probe', 'endpoint', 'sleep', 'recovery']) {
      assert.ok(!reply.includes(leak), `★ 不可以洩漏「${leak}」`);
    }
  } finally { cleanup(); }
});

test('★★★ C15: 端到端 —— 全部資源成功時才說完整', async () => {
  const { db, user, cleanup } = await seed();
  try {
    for (const r of EXPECTED) await db.saveSyncState(user.id, r, { lastSuccessAt: RECENT }, { now: NOW });
    const reply = await bot(db, user, rawCoach(validParse()))('WHOOP 有同步成功嗎');
    assert.match(reply, /完整同步成功/);
  } finally { cleanup(); }
});

// ===========================================================================
// D — triage 精確度
// ===========================================================================

const MUST_BE_URGENT = [
  '我現在喘不過氣', '我胸痛又喘不過氣', '我快昏倒了', '我喝酒後一直吐',
  '我朋友叫不醒', '他意識不清', '我心跳很快而且頭暈', '我突然冒冷汗又胸痛',
  '我累到快昏倒了', '我喝酒後胸痛又喘不過氣',
];
const MUST_NOT_BE_URGENT = [
  '這部電影讓我笑到喘不過氣', '我的 recovery 低到快昏倒', '我想知道胸痛通常是什麼',
  '胸痛通常有哪些原因？', '「喘不過氣」是什麼意思？', '昨天有點頭暈但已經好了',
  '運動後有點喘，休息後好了', '這個工作累到讓人昏倒', '這數字低得嚇死人',
  '我沒有胸痛也沒有呼吸困難',
];

test('★★★ D1: 真正的緊急一個都不能漏（含第三人稱轉述）', () => {
  for (const t of MUST_BE_URGENT) {
    assert.equal(assessUrgency(t).urgent, true, `★ 「${t}」必須是緊急`);
  }
});

test('★★★ D2: 譬喻／衛教／否定／已緩解一律不觸發急診回應', () => {
  for (const t of MUST_NOT_BE_URGENT) {
    const r = assessUrgency(t);
    assert.equal(r.urgent, false, `★ 「${t}」不該是緊急（matched=${r.matched}）`);
  }
});

test('★★★ D3: 端到端 —— 誤判的句子不會收到急診指引', async () => {
  // ⚠️「運動後有點喘，休息後好了」確實在報告一件可記錄的事（運動），所以它
  // 會寫入一筆是**正確的**。這個測試驗的是 triage，不是寫入授權（那在 B 組）。
  const NO_EVENT = MUST_NOT_BE_URGENT.filter((t) => !t.includes('運動後'));
  for (const t of MUST_NOT_BE_URGENT) {
    const { db, user, cleanup } = await seed();
    try {
      const reply = await bot(db, user, rawCoach(validParse()))(t);
      assert.doesNotMatch(reply, /立刻尋求醫療協助|緊急醫療服務/, `★ 「${t}」不該收到急診指引`);
      if (NO_EVENT.includes(t)) {
        assert.equal((await rows(db, user.id)).length, 0, `★ 「${t}」不該寫 journal`);
      }
    } finally { cleanup(); }
  }
});

test('★★★ D3b: 症狀類問題得到安全回覆 —— 不是急診指引，也不是指令清單', async () => {
  const { isSymptomEducationQuestion } = await import('../src/bot/triage.js');
  for (const t of ['我想知道胸痛通常是什麼', '胸痛通常有哪些原因？', '「喘不過氣」是什麼意思？']) {
    assert.equal(isSymptomEducationQuestion(t), true, `★ 「${t}」應該是症狀類問題`);
    const r = await route(t, validParse());
    assert.doesNotMatch(r.reply, /立刻尋求醫療協助/, `★ 「${t}」不是急診`);
    assert.doesNotMatch(r.reply, /我不太確定你想問什麼/, `★ 「${t}」不可以回指令清單`);
    assert.match(r.reply, /沒辦法幫你判斷/, '★ 要說明界線');
    // 刻意不給成因清單 —— 那會讓人自己排除掉危險的可能
    assert.doesNotMatch(r.reply, /常見原因包括|可能的原因有|第一|第二/, '★ 不可以列成因');
    assert.equal(r.delta, 0);
  }
  // 譬喻不走這條路（它根本不是健康問題）
  assert.equal(isSymptomEducationQuestion('這部電影讓我笑到喘不過氣'), false);
  // 真正的緊急也不走這條路
  assert.equal(isSymptomEducationQuestion('我現在喘不過氣'), false);
});

test('★★★ D4: 緊急仍然排在寫入之前', async () => {
  const { db, user, cleanup } = await seed();
  try {
    const reply = await bot(db, user, rawCoach(validParse()))('我喝酒後胸痛又喘不過氣');
    assert.match(reply, /立刻尋求醫療協助/);
    assert.equal((await rows(db, user.id)).length, 0, '★ 緊急時零寫入');
  } finally { cleanup(); }
});

// ===========================================================================
// E — 「的話」碰撞
// ===========================================================================

const BARE_DE_HUA = [
  '你的話讓我安心', '老實說的話，我今天很累', '我的話是指今天的 recovery',
  '照你的話做', '有資料的話再告訴我', '我的話，今天其實沒有喝酒', '喝酒的話題先不要談',
];
const REAL_CONDITIONALS = [
  '如果我喝酒的話，明天會累嗎？', '假如昨晚喝酒的話，今天 recovery 會低嗎？',
  '要是喝酒的話會怎樣？', '若有喝酒的話，HRV 會改變嗎？',
];

test('★★★ E1: 裸的「的話」不再被當成假設語氣', () => {
  for (const t of BARE_DE_HUA) {
    const p = resolvePerspective({ text: t });
    assert.notEqual(p.source, 'hypothetical', `★ 「${t}」不是假設語氣`);
  }
  // 真正的條件句仍然是
  for (const t of REAL_CONDITIONALS) {
    const p = resolvePerspective({ text: t });
    assert.equal(p.usePersonalData, false, `★ 「${t}」不該動用個人資料`);
  }
});

test('★★★ E2: 「的話」的每一種用法：視角、個人資料、寫入、路由', async () => {
  const expect = [
    // [text, 不可以動用個人資料?, 預期寫入筆數]
    ['你的話讓我安心', null, 0],
    ['老實說的話，我今天很累', false, 0],
    ['我的話是指今天的 recovery', false, 0],
    ['照你的話做', null, 0],
    ['有資料的話再告訴我', null, 0],
    ['我的話，今天其實沒有喝酒', false, 0],
    ['喝酒的話題先不要談', null, 0],
  ];
  for (const [text, , delta] of expect) {
    const r = await route(text, validParse());
    assert.equal(r.delta, delta, `★ 「${text}」寫入筆數應為 ${delta}`);
    assert.ok(r.reply.length > 0, `★ 「${text}」要有回覆`);
  }
  // 「老實說的話，我今天很累」是在講自己 → 可以用個人資料
  assert.equal(resolvePerspective({ text: '老實說的話，我今天很累' }).perspective, PERSPECTIVE.SELF);
  // 「有資料的話再告訴我」不該被導去衛教
  assert.notEqual(resolvePerspective({ text: '有資料的話再告訴我' }).source, 'hypothetical');
});

test('★★★ E3: 真正的條件句 → 零寫入（事件是假設的）', async () => {
  for (const t of REAL_CONDITIONALS) {
    const r = await route(t, validParse());
    assert.equal(r.delta, 0, `★ 「${t}」不可以寫入`);
  }
  // 「有喝酒的話」沒有明確連接詞，但線索詞後面緊跟「的話」就是條件
  assert.equal(rawTextVeto({ text: '有喝酒的話，HRV 會降低嗎？', category: 'alcohol' }).vetoed, true);
  // 「喝酒的話題」不是條件
  assert.equal(
    rawTextVeto({ text: '喝酒的話題先不要談', category: 'alcohol' }).reason !== 'hypothetical', true,
  );
});

test('★★★ E4: 明確記錄指令不受「的話」影響', async () => {
  const { db, user, cleanup } = await seed();
  try {
    await bot(db, user, rawCoach(validParse()))('幫我記錄喝酒吧');
    assert.equal((await rows(db, user.id)).length, 1);
  } finally { cleanup(); }
});

// ===========================================================================
// F — 衛教措辭
// ===========================================================================

/** 過度肯定的說法。出現在**回答**裡就是問題（註解不算）。 */
const CATEGORICAL = [
  '一定會', '就是因為', '必然', '保證', '絕對', '肯定會',
  '很直接的因果', '最主要的輸入', '優先補深睡', '確實會',
];
/** WHOOP 專有演算法的組成 —— 這個 repo 沒有權威來源，一律不可宣稱。 */
const ALGORITHM_CLAIMS = ['恢復分數本來就', '恢復分數主要由', '最主要的輸入', '演算法會'];

test('★★★ F1: 所有主題 × 所有面向的措辭都通過檢查', () => {
  const topics = ['喝酒', '睡太少', '熬夜', '運動', '壓力', '咖啡因', '生病'];
  const aspects = ['會讓人累嗎', '會影響睡眠嗎', '會影響 HRV 嗎', '會影響 recovery 嗎'];
  let checked = 0;
  for (const topic of topics) {
    for (const aspect of aspects) {
      const a = educationAnswer({ text: `${topic}${aspect}`, perspective: PERSPECTIVE.GENERAL });
      assert.ok(a && a.text.length > 20, `★ ${topic}${aspect} 要有答案`);
      for (const bad of CATEGORICAL) {
        assert.ok(!a.text.includes(bad), `★ ${topic}${aspect} 出現過度肯定的「${bad}」：${a.text}`);
      }
      for (const bad of ALGORITHM_CLAIMS) {
        assert.ok(!a.text.includes(bad), `★ ${topic}${aspect} 宣稱了演算法組成「${bad}」`);
      }
      // 限定詞必須出現在**機轉那一段**，不是只靠結尾那句通用免責。
      // 否則這個斷言會被固定的結尾句自動滿足，等於什麼都沒驗。
      const body = a.text.split('\n\n')[0];
      assert.match(body, /可能|常見|常常|並不少見|一般認為|因人而異|有些人|常被認為|不太一樣/,
        `★ ${topic}${aspect} 機轉段要有限定詞：${body}`);
      checked += 1;
    }
  }
  assert.equal(checked, 28, '★ 28 種組合都要檢查到');
});

test('★★★ F2: 限定詞不可以取代內容 —— 每個答案都要有實際機轉', () => {
  const cases = [
    ['喝酒會讓人累嗎', /後半夜|水分/],
    ['酒精會影響 HRV 嗎', /自律神經|靜息心率/],
    ['熬夜會讓人沒精神嗎', /睡眠時間|作息/],
    ['運動完很累是什麼原因', /肌肉疲勞|能量消耗|電解質/],
    ['壓力會影響睡眠嗎', /入睡|睡得比較淺|半夜醒來/],
    ['咖啡因會影響睡眠嗎', /代謝|入睡/],
    ['生病會影響 HRV 嗎', /靜息心率|觀察/],
    ['睡太少會影響 recovery 嗎', /恢復分數/],
  ];
  for (const [q, expect] of cases) {
    const a = educationAnswer({ text: q, perspective: PERSPECTIVE.GENERAL });
    assert.match(a.text, expect, `★ 「${q}」要保留實際內容`);
  }
});

test('★★★ F3: 衛教路徑不碰個人資料、不回指令清單（回歸）', async () => {
  for (const t of ['喝酒會讓人累嗎？', '壓力可能讓 HRV 改變嗎？', '睡太少會影響 recovery 嗎？']) {
    const r = await route(t, validParse({ asserted: false, about_self: false }));
    assert.equal(r.delta, 0);
    assert.doesNotMatch(r.reply, /7h16m|63%|66ms|54bpm/, `★ 「${t}」不可以有個人量測值`);
    assert.doesNotMatch(r.reply, /我不太確定你想問什麼/, `★ 「${t}」不可以回指令清單`);
  }
});

// ===========================================================================
// G — 既有行為的回歸保護
// ===========================================================================

test('★★★ G1: 複合訊息仍然「先記下、再回答」', async () => {
  const { db, user, cleanup } = await seed();
  try {
    const reply = await bot(db, user, rawCoach(validParse()))('我怎麼感覺那麼累 是因為剛剛也喝酒嗎');
    assert.equal((await rows(db, user.id)).length, 1, '★ 要記一筆');
    assert.match(reply, /記下/, '★ 要確認記錄');
    assert.ok(reply.length > 60, '★ 也要回答問題');
    assert.doesNotMatch(reply, /\balcohol\b/, '★ 不可以洩漏內部鍵');
  } finally { cleanup(); }
});

test('★★★ G2: intent 碰撞 —— 新的否決權沒有偷走既有路徑', () => {
  for (const [text, want] of [
    ['我今天狀態怎樣', 'today_status'],
    ['最近 HRV 如何', 'trend_query'],
    ['因為數據不夠嗎', 'readiness_query'],
    ['WHOOP 有同步成功嗎', 'sync_status'],
    ['我剛剛喝酒了，為什麼這麼累？', 'cause_query'],
  ]) {
    assert.equal(deterministicIntent(text)?.intent, want, `★ 「${text}」`);
  }
});
