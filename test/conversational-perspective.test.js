/**
 * 視角、衛教、時間信任與語氣（pre-regate 修復）。
 *
 * 上一輪把「關鍵字不等於授權寫入」修好了，但 about_self 這個訊號**只保護
 * 寫入**，沒有流進回答規劃。於是：
 *
 *   使用者：我朋友喝酒後很累是正常的嗎？
 *   Bot  ：你會覺得累…（接著列出**使用者自己**的睡眠、恢復、HRV）
 *
 *   使用者：喝酒會讓人累嗎？
 *   Bot  ：我不太確定你想問什麼。可以試試：· 我今天狀態怎樣？…
 *
 * 前者是人稱錯誤加個人資料誤用，後者是把一個清楚的健康問題當成聽不懂。
 *
 * 這一組測試守的是四件事：
 *   1. 個人資料的使用必須**正面確立**在問使用者本人（fail closed）
 *   2. 一般健康問題有真正的答案，不是指令清單
 *   3. 時間精確度由原文決定，LLM 只能下修不能上修
 *   4. 個人化回答維持對話長度，不是報表
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createDb } from '../src/db.js';
import { createRouter } from '../src/bot/router.js';
import { deterministicIntent } from '../src/bot/intent.js';
import { resolvePerspective, PERSPECTIVE } from '../src/bot/perspective.js';
import { educationAnswer, detectTopic, detectAspect } from '../src/bot/healthEducation.js';
import { validateTimePrecision, textSupportedPrecision } from '../src/bot/timePrecision.js';
import { temporalRelation } from '../src/healthQuery.js';
import { assessUrgency } from '../src/bot/triage.js';
import { isSelfRecallQuestion, isExplicitLogCommand } from '../src/bot/conversation.js';

const NOW = new Date('2026-09-11T09:05:00Z');
const HD = '2026-09-11';
const TZ = 'Asia/Taipei';

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-'));
  const db = createDb({ url: `file:${path.join(dir, 't.db')}` });
  return { db, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const L = 13_000_000; const SW = 7_000_000; const RM = 6_160_000;

async function seed({ days = 1 } = {}) {
  const { db, cleanup } = tempDb();
  await db.migrate();
  const u = await db.createUser({ displayName: 'Kelvin', timezone: TZ });
  await db.linkTelegram({ chatId: '5001', userId: u.id });
  for (let i = 0; i < days; i += 1) {
    const date = new Date(Date.parse(`${HD}T00:00:00Z`) - i * 86_400_000);
    const hd = date.toISOString().slice(0, 10);
    const end = new Date(date.getTime() + 16 * 60_000).toISOString();
    const start = new Date(date.getTime() - 7 * 3600_000).toISOString();
    await db.raw.execute({
      sql: `INSERT INTO whoop_sleeps (user_id,id,health_date,start_at,end_at,nap,score_state,
              sleep_performance_percentage,total_sleep_milli,light_sleep_milli,slow_wave_sleep_milli,
              rem_sleep_milli,created_at,updated_at,synced_at,raw_json)
            VALUES (?,?,?,?,?,0,'SCORED',87,?,?,?,?,?,?,?,?)`,
      args: [u.id, `s-${i}`, hd, start, end, L + SW + RM, L, SW, RM, start, end, end,
        JSON.stringify({
          id: `s-${i}`, score_state: 'SCORED',
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
      args: [u.id, `s-${i}`, `c-${i}`, hd, start, end, end,
        JSON.stringify({
          cycle_id: `c-${i}`, sleep_id: `s-${i}`, score_state: 'SCORED',
          score: {
            recovery_score: 63, hrv_rmssd_milli: 65.5599, resting_heart_rate: 54,
            user_calibrating: true,
          },
        })],
    });
  }
  return { db, user: u, cleanup: () => { db.close(); cleanup(); } };
}

/** 解析器可以被指定回報任何東西（含刻意錯誤的），用來驗確定性防線。 */
const coachWith = (over = {}) => () => ({
  async json() {
    return {
      category: 'alcohol', subtype: null, numeric_value: null, unit: null, confidence: 0.9,
      asserted: true, about_self: true, negated: false, hypothetical: false,
      time_precision: 'now', ...over,
    };
  },
  async ask() { return 'x'; },
});

const bot = (db, user, coachFor = coachWith()) => {
  const r = createRouter({ db, coachFor, now: () => NOW });
  return (text) => r.handle({ text, chatId: '5001', user: { id: user.id, timezone: TZ } });
};
const rows = async (db, uid) => db.getJournalEvents(uid, { from: '2026-08-01', to: '2026-10-01', limit: 200 });

/** 個人生理數值出現在文字裡的樣子（用來證明第三人稱／一般問題沒有洩漏）。 */
const PERSONAL_VALUE = /7h16m|63%|66ms|65\.5|54\s*bpm|87%|2026-09-11/;
/** 個人化判斷用語。 */
const PERSONAL_FRAME = /(你的個人基準|你的常態|你會覺得累|你今天|你的恢復|你的 ?HRV|你的睡眠)/;

// ===========================================================================
// 1 — 視角解析
// ===========================================================================

const PERSPECTIVE_CASES = [
  ['我剛喝酒，現在很累', PERSPECTIVE.SELF, true],
  ['我剛喝酒，為什麼現在很累？', PERSPECTIVE.SELF, true],
  ['我朋友喝酒後很累', PERSPECTIVE.THIRD_PARTY, false],
  ['我朋友喝酒後很累是正常的嗎？', PERSPECTIVE.THIRD_PARTY, false],
  ['他昨晚喝酒，今天很累', PERSPECTIVE.THIRD_PARTY, false],
  ['喝酒會讓人累嗎？', PERSPECTIVE.GENERAL, false],
  ['為什麼喝酒後容易疲倦？', PERSPECTIVE.GENERAL, false],
  ['如果喝酒，隔天 recovery 可能會變差嗎？', PERSPECTIVE.GENERAL, false],
  ['喝完酒很累正常嗎？', PERSPECTIVE.GENERAL, false],
  ['有人喝酒後 HRV 會降低嗎？', PERSPECTIVE.GENERAL, false],
  ['我今天沒有喝酒，為什麼還是累？', PERSPECTIVE.SELF, true],
  ['我是不是喝酒了？', PERSPECTIVE.SELF, true],
];

test('★★★ 視角：12 個必測句型都解析正確，個人資料授權跟著視角走', () => {
  for (const [text, want, personal] of PERSPECTIVE_CASES) {
    const r = resolvePerspective({ text });
    assert.equal(r.perspective, want, `★ 「${text}」視角應為 ${want}（得到 ${r.perspective}）`);
    assert.equal(r.usePersonalData, personal, `★ 「${text}」個人資料授權應為 ${personal}`);
  }
});

test('★★★ 視角：個人資料需要「正面確立」，不是「沒被否定」', () => {
  // 沒有主詞、也不是一般問法 → ambiguous，一律不開放個人資料
  for (const t of ['很累', '累死了', '今天好累喔']) {
    const r = resolvePerspective({ text: t });
    assert.equal(r.usePersonalData, false, `★ 「${t}」沒有確立主詞就不可以用個人資料`);
  }
});

test('★★★ 視角：解析器可以下修，不可以上修', () => {
  // 下修：文字有「我」，但解析器說不是在講他自己 → ambiguous（fail closed）
  const down = resolvePerspective({ text: '我朋友說他喝酒後很累', signals: { aboutSelf: false } });
  assert.equal(down.usePersonalData, false);
  // 上修不可能：文字完全沒有第一人稱，解析器說 aboutSelf 也救不回來
  const up = resolvePerspective({ text: '喝酒會讓人累嗎？', signals: { aboutSelf: true } });
  assert.equal(up.perspective, PERSPECTIVE.GENERAL, '★ LLM 不可以把一般問題升級成個人問題');
  assert.equal(up.usePersonalData, false);
});

// ===========================================================================
// 2 — 個人資料發布邊界（端到端）
// ===========================================================================

const NON_SELF_QUESTIONS = [
  '我朋友喝酒後很累是正常的嗎？',
  '我朋友喝酒後很累',
  '他昨晚喝酒，今天很累',
  '喝酒會讓人累嗎？',
  '為什麼喝酒後容易疲倦？',
  '酒精會影響睡眠嗎？',
  '酒精可能影響 HRV 嗎？',
  '有人喝酒後 HRV 會降低嗎？',
  '熬夜為什麼會讓人沒精神？',
  '運動完很累通常是什麼原因？',
  '壓力可能讓 HRV 改變嗎？',
  '睡太少會影響 recovery 嗎？',
  '如果我喝酒，明天會比較累嗎？',
  '喝完酒很累正常嗎？',
];

test('★★★ 邊界：第三人稱／一般問題絕不輸出個人量測值或個人化判斷', async () => {
  for (const text of NON_SELF_QUESTIONS) {
    const { db, user, cleanup } = await seed();
    try {
      const reply = await bot(db, user, coachWith({ asserted: false, about_self: false }))(text);
      assert.doesNotMatch(reply, PERSONAL_VALUE, `★ 「${text}」洩漏了個人量測值：${reply}`);
      assert.doesNotMatch(reply, PERSONAL_FRAME, `★ 「${text}」用了個人化人稱：${reply}`);
      assert.equal((await rows(db, user.id)).length, 0, `★ 「${text}」不可以寫 journal`);
      assert.doesNotMatch(reply, /我不太確定你想問什麼/, `★ 「${text}」不可以回指令清單`);
      assert.ok(reply.length > 20, `★ 「${text}」要有實質回答`);
    } finally { cleanup(); }
  }
});

test('★★★ 邊界：非自己的問題完全不讀個人健康資料表', async () => {
  const { db, user, cleanup } = await seed();
  try {
    // 只攔截「個人健康資料」的讀取。Journal 解析與追問狀態不算。
    const reads = [];
    const spy = new Proxy(db, {
      get(target, prop) {
        const v = target[prop];
        if (typeof v !== 'function') return v;
        if (['getSleeps', 'getRecoveries', 'getCycles', 'getWorkouts', 'getAllSyncState'].includes(prop)) {
          return (...args) => { reads.push(prop); return v.apply(target, args); };
        }
        return v.bind(target);
      },
    });
    const r = createRouter({ db: spy, coachFor: coachWith({ asserted: false, about_self: false }), now: () => NOW });
    await r.handle({
      text: '我朋友喝酒後很累是正常的嗎？', chatId: '5001',
      user: { id: user.id, timezone: TZ },
    });
    assert.deepEqual(reads, [], `★ 第三人稱問題不該讀個人健康資料（讀了：${reads.join(',')}）`);
  } finally { cleanup(); }
});

test('★★★ 邊界：自己的問題仍然可以（也應該）使用個人資料', async () => {
  const { db, user, cleanup } = await seed();
  try {
    const reply = await bot(db, user)('我剛剛喝酒了，為什麼這麼累？');
    assert.match(reply, /7h16m|63%/, '★ 本人的問題要用得到自己的數據');
    assert.equal((await rows(db, user.id)).length, 1, '★ 本人的主張要寫一筆');
  } finally { cleanup(); }
});

// ===========================================================================
// 3 — 衛教路徑
// ===========================================================================

const EDUCATION_QS = [
  ['喝酒會讓人累嗎？', 'alcohol', 'tired'],
  ['酒精會影響睡眠嗎？', 'alcohol', 'sleep'],
  ['酒精可能影響 HRV 嗎？', 'alcohol', 'hrv'],
  ['為什麼喝酒後容易疲倦？', 'alcohol', 'tired'],
  ['熬夜為什麼會讓人沒精神？', 'late_sleep', 'tired'],
  ['運動完很累通常是什麼原因？', 'exercise', 'tired'],
  ['壓力可能讓 HRV 改變嗎？', 'stress', 'hrv'],
  ['睡太少會影響 recovery 嗎？', 'short_sleep', 'recovery'],
];

test('★★★ 衛教：8 個一般問題都有實質答案，主題／面向判定正確', () => {
  for (const [text, topic, aspect] of EDUCATION_QS) {
    assert.equal(detectTopic(text), topic, `★ 「${text}」主題`);
    assert.equal(detectAspect(text), aspect, `★ 「${text}」面向`);
    const a = educationAnswer({ text, perspective: PERSPECTIVE.GENERAL });
    assert.ok(a && a.text.length > 30, `★ 「${text}」要有答案`);
    assert.match(a.text, /可能|常見|通常|並不少見/, `★ 「${text}」要用可能性語氣`);
    assert.doesNotMatch(a.text, /一定會|就是因為|必然|保證/, `★ 「${text}」不可以講死`);
    assert.doesNotMatch(a.text, /\balcohol\b|late_sleep|short_sleep|\bhrv\b:/, '★ 不可以有內部鍵');
  }
});

/** 每一題都必須真的答到它的主題 —— 不是「沒回指令清單」就算過關。 */
const EDUCATION_EXPECT = {
  '喝酒會讓人累嗎？': /睡眠結構|脫水/,
  '酒精會影響睡眠嗎？': /深睡|REM|睡眠品質/,
  '酒精可能影響 HRV 嗎？': /自律神經|交感/,
  '為什麼喝酒後容易疲倦？': /睡眠結構|脫水/,
  '熬夜為什麼會讓人沒精神？': /睡眠債|作息|節律/,
  '運動完很累通常是什麼原因？': /肌肉疲勞|能量消耗|電解質/,
  '壓力可能讓 HRV 改變嗎？': /自律神經/,
  '睡太少會影響 recovery 嗎？': /恢復分數/,
};

test('★★★ 衛教：端到端真的答到主題，而且不回指令清單', async () => {
  for (const [text] of EDUCATION_QS) {
    const { db, user, cleanup } = await seed();
    try {
      const reply = await bot(db, user, coachWith({ asserted: false, about_self: false }))(text);
      assert.doesNotMatch(reply, /我不太確定你想問什麼|輸入 \/help/, `★ 「${text}」不可以回指令清單`);
      assert.doesNotMatch(reply, /沒有足夠把握/, `★ 「${text}」應該答得出來，不是推掉`);
      assert.match(reply, EDUCATION_EXPECT[text], `★ 「${text}」要答到主題本身`);
      assert.ok(reply.length > 30, `★ 「${text}」要有實質內容`);
    } finally { cleanup(); }
  }
});

test('★★★ 衛教：認不出主題時誠實說沒把握，仍然不回指令清單', async () => {
  const { db, user, cleanup } = await seed();
  try {
    const reply = await bot(db, user, coachWith({ asserted: false, about_self: false }))(
      '磁場會不會影響身體的能量場？',
    );
    assert.doesNotMatch(reply, /我不太確定你想問什麼/);
    assert.match(reply, /沒有足夠把握|沒把握/, '★ 要誠實說沒把握');
  } finally { cleanup(); }
});

// ===========================================================================
// 4 — 第三人稱安全回應
// ===========================================================================

test('★★★ 第三人稱：不診斷、不用本人資料、但給得出升級指引', async () => {
  const { db, user, cleanup } = await seed();
  try {
    const reply = await bot(db, user, coachWith({ asserted: false, about_self: false }))(
      '我朋友喝酒後很累是正常的嗎？',
    );
    assert.doesNotMatch(reply, /你會覺得累/, '★ 人稱不可以錯');
    assert.doesNotMatch(reply, /你的 ?(恢復|Recovery|HRV|睡眠)/i, '★ 不可以用本人的數據');
    assert.doesNotMatch(reply, PERSONAL_VALUE, '★ 不可以有本人的量測值');
    assert.match(reply, /不少見|常見|可能/, '★ 要回答一般情況');
    assert.doesNotMatch(reply, /他沒事|很正常，不用擔心|酒精中毒/, '★ 不可以下診斷');
    assert.match(reply, /看不到他的|沒辦法判斷他/, '★ 要說明看不到他的資料');
    assert.match(reply, /呼吸困難|胸痛|意識不清|叫不醒/, '★ 要有升級指引');
    assert.equal((await rows(db, user.id)).length, 0, '★ 別人的事不可以寫進他的紀錄');
  } finally { cleanup(); }
});

test('★★★ 第三人稱：描述嚴重症狀時升級指引要更強', () => {
  const mild = educationAnswer({ text: '我朋友喝酒後很累', perspective: PERSPECTIVE.THIRD_PARTY });
  const severe = educationAnswer({ text: '我朋友喝酒後一直吐，叫不醒', perspective: PERSPECTIVE.THIRD_PARTY });
  assert.match(mild.text, /輕微疲倦/, '★ 輕微 → 觀察為主');
  assert.match(severe.text, /立刻尋求緊急醫療協助/, '★ 嚴重 → 立即升級');
  assert.doesNotMatch(severe.text, /只是輕微疲倦，先休息/, '★ 嚴重時不可以淡化');
});

// ===========================================================================
// 5 — 時間精確度：原文說了算
// ===========================================================================

test('★★★ 時間：原文支撐的上限', () => {
  assert.equal(textSupportedPrecision('我剛剛喝酒'), 'now');
  assert.equal(textSupportedPrecision('我剛才喝的'), 'now');
  assert.equal(textSupportedPrecision('我三十分鐘前喝的'), 'now');
  assert.equal(textSupportedPrecision('我昨晚十點喝的'), 'time');
  assert.equal(textSupportedPrecision('我今天喝酒'), 'date');
  assert.equal(textSupportedPrecision('我昨晚喝酒'), 'date');
  assert.equal(textSupportedPrecision('最近有喝酒'), 'date');
  assert.equal(textSupportedPrecision('我喝酒了'), 'unknown');
});

test('★★★ 時間：LLM 只能下修，不能上修（對抗性解析結果）', () => {
  // 文字說今天，模型宣稱 now → 壓回 date
  const a = validateTimePrecision({ text: '我今天喝酒', proposed: 'now' });
  assert.equal(a.precision, 'date'); assert.equal(a.downgraded, true);
  // 文字說昨晚，模型宣稱精確時刻 → 壓回 date
  const b = validateTimePrecision({ text: '我昨晚喝酒', proposed: 'time' });
  assert.equal(b.precision, 'date'); assert.equal(b.downgraded, true);
  // 文字完全沒有時間線索，模型宣稱 time → 壓回 unknown
  const c = validateTimePrecision({ text: '我喝酒了', proposed: 'time' });
  assert.equal(c.precision, 'unknown'); assert.equal(c.downgraded, true);
  // 文字說剛剛，模型保守地說只有日期 → 尊重模型的下修
  const d = validateTimePrecision({ text: '我剛剛喝酒', proposed: 'date' });
  assert.equal(d.precision, 'date'); assert.equal(d.downgraded, false);
  // 文字說剛剛，模型也說 now → 維持（訊息時間是有界代理）
  const e = validateTimePrecision({ text: '我剛剛喝酒', proposed: 'now' });
  assert.equal(e.precision, 'now'); assert.equal(e.downgraded, false);
  // 無效值一律當 unknown
  assert.equal(validateTimePrecision({ text: '我剛剛喝酒', proposed: 'yesterday' }).precision, 'unknown');
  assert.equal(validateTimePrecision({ text: '我剛剛喝酒', proposed: null }).precision, 'unknown');
});

test('★★★ 時間：被下修之後就不再宣稱先後關係（端到端）', async () => {
  const { db, user, cleanup } = await seed();
  try {
    // 原文只說「今天」，但解析器自信地回 now
    const reply = await bot(db, user, coachWith({ time_precision: 'now' }))(
      '我今天喝酒了，為什麼這麼累？',
    );
    assert.doesNotMatch(reply, /之前量到的|時間早於/, '★ 原文撐不起精確時間就不可以講先後');
    assert.equal((await rows(db, user.id)).length, 1, '★ 仍然會記錄（只是不談時序）');
  } finally { cleanup(); }
});

test('★★★ 時間：「剛剛」才可以談先後', async () => {
  const { db, user, cleanup } = await seed();
  try {
    const reply = await bot(db, user, coachWith({ time_precision: 'now' }))(
      '我剛剛喝酒了，為什麼這麼累？',
    );
    assert.match(reply, /之前量到的/, '★ 明確的「剛剛」可以談先後');
  } finally { cleanup(); }
});

test('★★★ 時間：時序關係缺任何一邊都是 unknown', () => {
  const end = '2026-09-11T00:16:00.000Z';
  assert.equal(temporalRelation(end, { event_at: '2026-09-11T08:00:00.000Z', time_precision: 'now' }), 'after');
  assert.equal(temporalRelation(end, { event_at: '2026-09-11T08:00:00.000Z', time_precision: 'date' }), 'unknown');
  assert.equal(temporalRelation(null, { event_at: '2026-09-11T08:00:00.000Z', time_precision: 'now' }), 'unknown');
  assert.equal(temporalRelation(end, { event_at: null, time_precision: 'now' }), 'unknown');
});

/**
 * 健康日的切點是**凌晨 4 點**（DAY_BOUNDARY_HOUR），不是午夜：凌晨 2 點喝的
 * 那杯屬於「前一天的晚上」，這是既有而且刻意的產品行為。這個測試釘住它，
 * 順便證明視角／衛教的改動沒有動到日期歸屬。
 */
test('★★ 時間：台北時區的健康日切點（凌晨 4 點）', async () => {
  const { db, cleanup } = tempDb();
  try {
    await db.migrate();
    const u = await db.createUser({ displayName: 'K', timezone: TZ });
    await db.linkTelegram({ chatId: '5001', userId: u.id });
    // UTC 2026-09-11 15:30 = 台北 2026-09-11 23:30（仍是 11 號）
    const before = new Date('2026-09-11T15:30:00Z');
    // UTC 2026-09-11 16:30 = 台北 2026-09-12 00:30（已經 12 號）
    const after = new Date('2026-09-11T16:30:00Z');
    // 台北 00:30 仍然屬於 09-11（還沒過凌晨 4 點）；台北 05:30 才是 09-12。
    const nextMorning = new Date('2026-09-11T21:30:00Z');
    for (const [now, want] of [[before, '2026-09-11'], [after, '2026-09-11'],
      [nextMorning, '2026-09-12']]) {
      const r = createRouter({ db, coachFor: coachWith(), now: () => now });
      await r.handle({ text: '幫我記錄喝酒吧', chatId: '5001', user: { id: u.id, timezone: TZ } });
      const ev = await db.getJournalEvents(u.id, { from: want, to: want, limit: 10 });
      assert.equal(ev.length >= 1, true, `★ 台北時間應記在 ${want}`);
    }
  } finally { db.close(); cleanup(); }
});

// ===========================================================================
// 6 — 長度與語氣
// ===========================================================================

test('★★★ 語氣：個人化回答維持對話長度', async () => {
  const { db, user, cleanup } = await seed();
  try {
    const reply = await bot(db, user)('我怎麼感覺那麼累，是因為剛剛喝酒嗎？');
    assert.ok(reply.length < 450, `★ 應在 450 字以內（實際 ${reply.length}）`);
    const paras = reply.split('\n\n').filter((p) => p.trim());
    assert.ok(paras.length <= 5, `★ 應在 5 段以內（實際 ${paras.length}）`);
    assert.doesNotMatch(reply, /都有可能讓人短時間覺得疲倦/, '★ 不自然的說法要改掉');
    assert.match(reply, /確實可能/, '★ 要用自然的說法');
    assert.doesNotMatch(reply, /你的不正常|\balcohol\b|previous_day_strain/, '★ 不可以有壞措辭或內部鍵');
    assert.doesNotMatch(reply, /目前這一天的數字：/, '★ 不可以是報表格式');
    // 一般疲倦不自動附加急診警語（那是 triage 的職責）
    assert.doesNotMatch(reply, /立刻尋求協助|緊急醫療服務/, '★ 輕微疲倦不要自動附急診指引');
  } finally { cleanup(); }
});

test('★★★ 語氣：不確定性只講一次', async () => {
  const { db, user, cleanup } = await seed();
  try {
    const reply = await bot(db, user)('我怎麼感覺那麼累，是因為剛剛喝酒嗎？');
    const hits = (reply.match(/沒辦法判斷|無法確定|不能確定/g) ?? []).length;
    assert.ok(hits <= 2, `★ 不確定性重複太多次（${hits}）`);
  } finally { cleanup(); }
});

// ===========================================================================
// 7 — intent 碰撞：衛教不可以偷走任何既有路徑
// ===========================================================================

test('★★★ 碰撞：衛教語彙不可以偷走個人查詢、同步、記錄與緊急', async () => {
  const matrix = [
    ['我今天狀態怎樣', 'today_status', true],
    ['最近 HRV 如何', 'trend_query', true],
    ['最近睡眠有沒有變差', 'sleep_quality', true],
    ['最近 30 天最好是哪一天', 'best_worst_day', true],
    ['因為數據不夠嗎', 'readiness_query', true],
    ['WHOOP 有同步成功嗎', 'sync_status', true],
    ['今天的資料同步了嗎', 'sync_status', true],
    ['我剛剛喝酒了，為什麼這麼累？', 'cause_query', true],
  ];
  for (const [text, wantIntent, personal] of matrix) {
    assert.equal(deterministicIntent(text)?.intent, wantIntent, `★ 「${text}」intent`);
    const r = resolvePerspective({ text });
    if (personal && r.perspective === PERSPECTIVE.GENERAL) {
      assert.fail(`★ 「${text}」被誤判成一般衛教問題`);
    }
  }
  // 明確記錄指令仍然優先
  assert.equal(isExplicitLogCommand('幫我記錄喝酒吧'), true);
  // 緊急仍然優先於一切
  assert.equal(assessUrgency('我喝酒後胸痛又喘不過氣').urgent, true);
});

test('★★★ 碰撞：個人查詢端到端仍然拿得到自己的數據', async () => {
  const { db, user, cleanup } = await seed();
  try {
    for (const [text, expect] of [
      ['我今天狀態怎樣', /7h16m|63%/],
      ['因為數據不夠嗎', /個人基準|合格歷史/],
      ['WHOOP 有同步成功嗎', /同步/],
    ]) {
      const reply = await bot(db, user)(text);
      assert.match(reply, expect, `★ 「${text}」應該仍然回個人資料`);
      assert.doesNotMatch(reply, /我不太確定你想問什麼/, `★ 「${text}」不可以退化成指令清單`);
    }
  } finally { cleanup(); }
});

// ===========================================================================
// 8 — 安全優先仍然在最前面
// ===========================================================================

test('★★★ 安全：緊急優先於視角與衛教兩條新路徑', async () => {
  for (const text of ['我喝酒後胸痛又喘不過氣', '我累到快昏倒了', '我心跳很快又呼吸困難']) {
    const { db, user, cleanup } = await seed();
    try {
      const reply = await bot(db, user)(text);
      assert.match(reply, /醫療|協助|安全/, `★ 「${text}」要先講安全`);
      assert.doesNotMatch(reply, /每個人的差異很大/, `★ 「${text}」不可以被衛教路徑吃掉`);
      assert.doesNotMatch(reply, PERSONAL_VALUE, `★ 「${text}」不可以列數據`);
      assert.equal((await rows(db, user.id)).length, 0, `★ 「${text}」不可以寫 journal`);
    } finally { cleanup(); }
  }
});

// ===========================================================================
// 9 — 自我查詢（我是不是喝酒了？）
// ===========================================================================

test('★★★ 自我查詢：讀自己的紀錄回答，不寫入、不回指令清單', async () => {
  assert.equal(isSelfRecallQuestion('我是不是喝酒了？'), true);
  assert.equal(isSelfRecallQuestion('我今天有沒有熬夜'), true);
  assert.equal(isSelfRecallQuestion('喝酒會讓人累嗎？'), false);

  const { db, user, cleanup } = await seed();
  try {
    const empty = await bot(db, user)('我是不是喝酒了？');
    assert.equal((await rows(db, user.id)).length, 0, '★ 問句不可以寫入');
    assert.doesNotMatch(empty, /我不太確定你想問什麼/, '★ 不可以回指令清單');
    assert.match(empty, /沒有/, '★ 沒紀錄就說沒紀錄');
    assert.match(empty, /不代表沒發生/, '★ 要說明系統只看得到使用者說過的事');

    await bot(db, user)('幫我記錄喝酒吧');
    const found = await bot(db, user)('我是不是喝酒了？');
    assert.match(found, /飲酒/, '★ 有紀錄要講出來');
    assert.doesNotMatch(found, /\balcohol\b/, '★ 不可以洩漏內部鍵');
  } finally { cleanup(); }
});

// ===========================================================================
// 10 — 追問狀態回歸（新路徑不可以把它弄壞）
// ===========================================================================

test('★★★ 回歸：視角／衛教改動之後，過期追問仍然會被收掉', async () => {
  const { db, user, cleanup } = await seed();
  try {
    await db.openPendingQuestion(user.id, {
      chatId: '5001', question: '昨天有喝酒嗎？', intent: 'today_status',
      contextJson: { health_date: HD, question_target_date: '2026-09-10' },
      ttlMs: 3600_000,
    }, { now: NOW });
    await bot(db, user)('我怎麼感覺那麼累，是因為剛剛也喝酒嗎？');
    assert.equal(await db.getOpenPendingQuestion(user.id, { now: NOW }), null,
      '★ 換話題之後舊追問不可以還開著');
    const ev = await rows(db, user.id);
    assert.equal(ev.length, 1);
    assert.equal(ev[0].health_date, HD, '★ 要記在今天，不是追問問的昨天');
  } finally { cleanup(); }
});

test('★★★ 回歸：一般衛教問題不會誤收掉正在等待的追問', async () => {
  const { db, user, cleanup } = await seed();
  try {
    await db.openPendingQuestion(user.id, {
      chatId: '5001', question: '昨天有喝酒嗎？', intent: 'today_status',
      contextJson: { health_date: HD, question_target_date: '2026-09-10' },
      ttlMs: 3600_000,
    }, { now: NOW });
    // 這句沒有事件詞，不該進複合分支，也就不該碰追問狀態
    await bot(db, user, coachWith({ asserted: false, about_self: false }))('壓力可能讓 HRV 改變嗎？');
    const still = await db.getOpenPendingQuestion(user.id, { now: NOW });
    assert.ok(still, '★ 無關的一般問題不該把追問收掉');
  } finally { cleanup(); }
});
