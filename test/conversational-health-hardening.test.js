/**
 * Codex gate 第二輪：對話式健康問答的加固。
 *
 * 這一輪修的是「第一輪修法本身不夠安全」的地方：
 *
 *   1. 只靠關鍵字就寫個人健康紀錄（「喝酒會讓人累嗎？」也會被寫進去）
 *   2. 緊急症狀沒有優先權（會先寫 journal、再列數據）
 *   3. 成熟度用最大值代表全部（睡眠有基準 ⇒ 宣稱恢復也有）
 *   4. 同步問題被導到基準說明或診斷區塊
 *   5. 吧／呢／嘛 一律當問句
 *   6. 內部類別鍵外洩、貢獻因素沒有過濾、時序沒有確定性分級
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createDb } from '../src/db.js';
import { createRouter, parseNaturalJournal } from '../src/bot/router.js';
import { assessUrgency } from '../src/bot/triage.js';
import { deterministicIntent } from '../src/bot/intent.js';
import { looksLikeQuestion, isExplicitLogCommand } from '../src/bot/conversation.js';
import { labelForCategory } from '../src/journal.js';
import { createHealthQuery, temporalRelation } from '../src/healthQuery.js';

const NOW = new Date('2026-09-11T09:05:00Z');
const HD = '2026-09-11';
const TZ = 'Asia/Taipei';

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chh-'));
  const db = createDb({ url: `file:${path.join(dir, 't.db')}` });
  return { db, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const L = 13_000_000; const SW = 7_000_000; const RM = 6_160_000;

async function seed({ days = 1, calibrating = true, sleepOnlyDays = 0 } = {}) {
  const { db, cleanup } = tempDb();
  await db.migrate();
  const u = await db.createUser({ displayName: 'Kelvin', timezone: TZ });
  await db.linkTelegram({ chatId: '5001', userId: u.id });
  const total = Math.max(days, sleepOnlyDays);
  for (let i = 0; i < total; i += 1) {
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
    if (i < days) {
      await db.raw.execute({
        sql: `INSERT INTO whoop_recoveries (user_id,sleep_id,cycle_id,health_date,score_state,
                recovery_score,hrv_rmssd_milli,resting_heart_rate,user_calibrating,
                created_at,updated_at,synced_at,raw_json)
              VALUES (?,?,?,?,'SCORED',63,65.5599,54,?,?,?,?,?)`,
        args: [u.id, `s-${i}`, `c-${i}`, hd, calibrating ? 1 : 0, start, end, end,
          JSON.stringify({
            cycle_id: `c-${i}`, sleep_id: `s-${i}`, score_state: 'SCORED',
            score: {
              recovery_score: 63, hrv_rmssd_milli: 65.5599, resting_heart_rate: 54,
              user_calibrating: calibrating,
            },
          })],
      });
    }
  }
  return { db, user: u, cleanup: () => { db.close(); cleanup(); } };
}

/** 模擬一個**會**回報語意欄位的解析器。 */
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

// ===========================================================================
// REPAIR 1 — Journal 寫入必須 fail closed
// ===========================================================================

const ZERO_WRITE = [
  ['喝酒會讓人累嗎？', { asserted: false }],
  ['如果我喝酒，明天會比較累嗎？', { hypothetical: true }],
  ['我今天沒有喝酒，為什麼還是很累？', { negated: true }],
  ['我朋友喝酒後很累是正常的嗎？', { about_self: false }],
  ['你覺得我昨天有喝酒嗎？', { asserted: false }],
  ['為什麼有人運動完會累？', { asserted: false, about_self: false, category: 'exercise_note' }],
  ['喝酒跟 HRV 有什麼關係？', { asserted: false }],
  ['我是不是喝酒了？', { asserted: false }],
  ['我不確定剛才那杯有沒有酒精', { asserted: false }],
  ['如果昨晚有喝酒，今天 recovery 會怎樣？', { hypothetical: true }],
  ['我沒有熬夜，只是覺得很累', { negated: true, category: 'late_sleep' }],
  ['我朋友昨晚熬夜到三點', { about_self: false, category: 'late_sleep' }],
  ['運動後疲勞通常是什麼原因？', { asserted: false, category: 'exercise_note' }],
];

test('★★★ REPAIR 1: 非主張的句子一律零寫入', async () => {
  for (const [text, over] of ZERO_WRITE) {
    const { db, user, cleanup } = await seed();
    try {
      const reply = await bot(db, user, coachWith(over))(text);
      assert.equal((await rows(db, user.id)).length, 0, `★ 「${text}」不可以寫入 journal`);
      assert.ok(reply.length > 0, `★ 「${text}」仍然要有回答`);
      assert.doesNotMatch(reply, /已記錄|幫你記下/, `★ 「${text}」不可以宣稱記錄了`);
    } finally { cleanup(); }
  }
});

test('★★★ REPAIR 1: 語意欄位缺席／矛盾一律不寫（fail closed）', async () => {
  const bad = [
    {},                                   // 全部缺席
    { asserted: true },                   // 只有一半
    { asserted: true, about_self: true, negated: true },       // 矛盾
    { asserted: true, about_self: true, hypothetical: true },  // 矛盾
    { asserted: 'yes', about_self: true },                     // 型別錯
  ];
  for (const over of bad) {
    const { db, user, cleanup } = await seed();
    try {
      const base = {
        category: 'alcohol', confidence: 0.9,
        negated: false, hypothetical: false, about_self: false, asserted: false,
      };
      const coachFor = () => ({ async json() { return { ...base, ...over }; }, async ask() { return 'x'; } });
      await bot(db, user, coachFor)('我剛剛喝酒了，為什麼這麼累？');
      assert.equal((await rows(db, user.id)).length, 0,
        `★ ${JSON.stringify(over)} 不可以寫入`);
    } finally { cleanup(); }
  }
});

test('★★★ REPAIR 1: 真正的主張仍然會寫入，而且問題有被回答', async () => {
  const positives = [
    ['我剛剛喝酒了，為什麼這麼累？', {}],
    ['我剛喝了兩杯，現在很累，會有關係嗎？', {}],
    ['我昨晚喝酒，今天 recovery 很低是因為這樣嗎？', { time_precision: 'date' }],
    ['我昨晚熬夜到三點，為什麼今天沒精神？', { category: 'late_sleep', time_precision: 'date' }],
    ['我剛運動完，為什麼現在還這麼累？', { category: 'exercise_note' }],
  ];
  for (const [text, over] of positives) {
    const { db, user, cleanup } = await seed();
    try {
      const reply = await bot(db, user, coachWith(over))(text);
      assert.equal((await rows(db, user.id)).length, 1, `★ 「${text}」應該寫入一筆`);
      assert.ok(reply.length > 40, `★ 「${text}」必須真的回答問題`);
      assert.doesNotMatch(reply, /\balcohol\b|late_sleep|exercise_note/,
        `★ 「${text}」不可以洩漏內部類別鍵`);
    } finally { cleanup(); }
  }
});

// ===========================================================================
// REPAIR 2 — 緊急優先
// ===========================================================================

const URGENT = [
  '我累到快昏倒了', '我快要失去意識', '我喝酒後胸痛又喘不過氣',
  '我現在心跳很快而且頭暈', '我全身無力站不起來', '喝酒後一直吐，為什麼這麼累',
  '我喘不過氣，為什麼', '我胸口很痛', '我心跳很快又呼吸困難', '我突然非常虛弱而且冒冷汗',
];

test('★★★ REPAIR 2: 緊急訊息優先，而且escalation 之前零寫入', async () => {
  for (const text of URGENT) {
    const { db, user, cleanup } = await seed();
    try {
      assert.equal(assessUrgency(text).urgent, true, `★ 「${text}」必須判為緊急`);
      const reply = await bot(db, user)(text);
      assert.equal((await rows(db, user.id)).length, 0, `★ 「${text}」不可以寫 journal`);
      assert.match(reply, /醫療|協助|安全/, `★ 「${text}」要優先講安全`);
      assert.doesNotMatch(reply, /66ms|54bpm|7h16m|基準|z=/, `★ 「${text}」不可以列數據`);
      assert.doesNotMatch(reply, /已記錄|幫你記下/);
      assert.ok(reply.length < 300, '★ 要簡潔');
    } finally { cleanup(); }
  }
});

test('★★★ REPAIR 2: 一般疲倦不會被誤判成緊急', async () => {
  for (const text of ['我只是今天比較疲倦', '今天有點沒精神', '運動後有點累', '為什麼我那麼累']) {
    assert.equal(assessUrgency(text).urgent, false, `★ 「${text}」不該是緊急`);
    const { db, user, cleanup } = await seed();
    try {
      const reply = await bot(db, user)(text);
      assert.doesNotMatch(reply, /立刻尋求醫療協助|緊急醫療服務/, `★ 「${text}」不該被警告`);
    } finally { cleanup(); }
  }
});

// ===========================================================================
// REPAIR 3 — 逐指標成熟度
// ===========================================================================

test('★★★ REPAIR 3: 成熟度逐指標計算，不用最大值', async () => {
  // 睡眠 5 天、recovery 0 天
  const { db, user, cleanup } = await seed({ days: 0, sleepOnlyDays: 6 });
  try {
    const q = createHealthQuery({ db, userId: user.id, timezone: TZ, now: NOW });
    const r = await q.readinessState();
    assert.equal(r.per_metric.sleep_total.eligible_prior >= 5, true, '睡眠有先前樣本');
    assert.equal(r.per_metric.recovery.eligible_prior, 0);
    assert.equal(r.per_metric.hrv.eligible_prior, 0);
    assert.equal(r.all_ready, false, '★ 睡眠合格不代表全部合格');

    const reply = await bot(db, user)('因為數據不夠嗎');
    assert.doesNotMatch(reply, /基準已經建立得起來/, '★ 不可以宣稱基準已建立');
  } finally { cleanup(); }
});

test('★★★ REPAIR 3: 生產樣態 —— 睡眠 1、恢復/HRV/RHR 0，不可以說「有 1 天可以比較」', async () => {
  const { db, user, cleanup } = await seed({ days: 1, calibrating: true });
  try {
    const q = createHealthQuery({ db, userId: user.id, timezone: TZ, now: NOW });
    const r = await q.readinessState();
    for (const m of ['recovery', 'hrv', 'rhr']) {
      assert.equal(r.per_metric[m].eligible_prior, 0, `★ ${m} 先前合格樣本必須是 0`);
      assert.equal(r.per_metric[m].has_current, true, `★ ${m} 當下的值看得到`);
    }
    const reply = await bot(db, user)('因為數據不夠嗎');
    assert.doesNotMatch(reply, /目前有 1 天可以拿來比較|可以拿來比較的大約是 1 天/,
      '★ 一筆睡眠觀察不可以被說成所有指標都有 1 天可比較');
  } finally { cleanup(); }
});

test('★★★ REPAIR 3: 恰好 5 —— 只有 4 筆先前樣本時不可以宣稱基準就緒', async () => {
  const four = await seed({ days: 5, calibrating: false });   // 今天 + 4 天先前
  try {
    const q = createHealthQuery({ db: four.db, userId: four.user.id, timezone: TZ, now: NOW });
    const r = await q.readinessState();
    assert.equal(r.per_metric.recovery.eligible_total, 5, '總共 5 筆');
    assert.equal(r.per_metric.recovery.eligible_prior, 4, '★ 但先前只有 4 筆');
    assert.equal(r.per_metric.recovery.ready, false, '★ 4 筆先前樣本不算就緒');
  } finally { four.cleanup(); }
  const five = await seed({ days: 6, calibrating: false });   // 今天 + 5 天先前
  try {
    const q = createHealthQuery({ db: five.db, userId: five.user.id, timezone: TZ, now: NOW });
    const r = await q.readinessState();
    assert.equal(r.per_metric.recovery.eligible_prior, 5);
    assert.equal(r.per_metric.recovery.ready, true);
  } finally { five.cleanup(); }
});

test('★★★ REPAIR 3: 校正期的值看得到，但一律不進合格樣本', async () => {
  const { db, user, cleanup } = await seed({ days: 8, calibrating: true });
  try {
    const q = createHealthQuery({ db, userId: user.id, timezone: TZ, now: NOW });
    const r = await q.readinessState();
    assert.equal(r.per_metric.recovery.has_current, true, '★ 事實看得到');
    assert.equal(r.per_metric.recovery.eligible_total, 0, '★ 但完全不進統計');
    assert.equal(r.per_metric.sleep_total.eligible_prior >= 5, true, '睡眠不受校正期影響');
    assert.equal(r.all_ready, false);
  } finally { cleanup(); }
});

// ===========================================================================
// REPAIR 4 — 門檻措辭
// ===========================================================================

test('★★★ REPAIR 4: 不把五天講成「找得出原因」的universal 承諾', async () => {
  const { db, user, cleanup } = await seed({ days: 1 });
  try {
    const reply = await bot(db, user)('因為數據不夠嗎');
    assert.doesNotMatch(reply, /累積五天就|五天就足以|5 天就能找出/, '★ 不可以承諾五天找出原因');
    if (/5\s*筆|5\s*天/.test(reply)) {
      assert.match(reply, /每個指標|最基本的比較/, '★ 提到 5 一定要講清楚是哪一種比較的最低值');
    }
    assert.match(reply, /關聯|不是單一原因/, '★ 要講明即使足夠也只能談關聯');
  } finally { cleanup(); }
});

// ===========================================================================
// REPAIR 5 — 同步狀態
// ===========================================================================

const SYNC_QS = [
  'WHOOP 有同步成功嗎', '今天的資料同步了嗎', '最後同步時間是什麼時候',
  '為什麼今天的 sleep 還沒進來', '我的 WHOOP 資料有更新嗎', '剛剛有同步到嗎',
  'WHOOP 現在連線正常嗎',
];

test('★★★ REPAIR 5: 同步問題走同步路徑（不是基準說明、不是診斷）', () => {
  for (const q of SYNC_QS) {
    assert.equal(deterministicIntent(q)?.intent, 'sync_status', `★ ${q}`);
  }
});

test('★★★ REPAIR 5: 同步回答用真實證據，且不洩漏內部細節', async () => {
  const { db, user, cleanup } = await seed({ days: 1 });
  try {
    await db.saveSyncState(user.id, 'sleep', { lastSuccessAt: '2026-09-11T04:32:23.000Z' }, { now: NOW });
    const reply = await bot(db, user)('WHOOP 有同步成功嗎');
    assert.match(reply, /有|成功/, '★ 要根據證據回答');
    for (const leak of ['capability', 'backfill', 'probe', 'endpoint', '涵蓋率', 'SUPPORTED']) {
      assert.ok(!reply.includes(leak), `★ 不可以洩漏「${leak}」`);
    }
    assert.doesNotMatch(reply, /個人基準|合格歷史/, '★ 同步問題不該回基準說明');
  } finally { cleanup(); }
});

test('★★★ REPAIR 5: 從來沒同步過 → 不可以宣稱成功', async () => {
  const { db, user, cleanup } = await seed({ days: 0, sleepOnlyDays: 0 });
  try {
    const reply = await bot(db, user)('今天的資料同步了嗎');
    assert.doesNotMatch(reply, /^有，/, '★ 沒有證據就不可以說有');
    assert.match(reply, /沒有|還沒|無法確認/, '★ 要誠實說不確定或沒有');
  } finally { cleanup(); }
});

test('★★★ REPAIR 5: 明確診斷指令仍然保留完整輸出', async () => {
  const { db, user, cleanup } = await seed({ days: 1 });
  try {
    const diag = await bot(db, user)('/healthdata');
    assert.ok(diag.length > 100, '★ /healthdata 要保留完整診斷');
  } finally { cleanup(); }
});

// ===========================================================================
// REPAIR 6 — 問句判定與明確記錄指令
// ===========================================================================

test('★★★ REPAIR 6: 吧／呢／嘛 不可以一律當問句', () => {
  for (const t of ['好吧', '記錄一下吧', '今天就這樣吧', '我很累呢', '算了吧',
    '幫我記錄喝酒吧', '今天真的很累嘛']) {
    assert.equal(looksLikeQuestion(t), false, `★ 「${t}」不是問句`);
  }
  for (const t of ['為什麼我很累呢', '今天狀態怎麼樣呢', '是因為喝酒嗎', '這會影響 HRV 嗎',
    '我是不是睡太少了', '要再累積幾天呢', '你還不能判斷嗎', '這樣算異常吧？', '難道不是資料不足嗎']) {
    assert.equal(looksLikeQuestion(t), true, `★ 「${t}」是問句`);
  }
});

test('★★★ REPAIR 6: 明確記錄指令優先於問句／複合路由', async () => {
  for (const t of ['幫我記錄喝酒吧', '記一下我昨晚熬夜', '幫我登記今天喝了兩杯']) {
    assert.equal(isExplicitLogCommand(t), true, `★ 「${t}」是明確記錄指令`);
    const { db, user, cleanup } = await seed();
    try {
      const reply = await bot(db, user)(t);
      assert.equal((await rows(db, user.id)).length, 1, `★ 「${t}」應該寫入一筆`);
      assert.match(reply, /已記錄|記下/, `★ 「${t}」要確認記錄`);
    } finally { cleanup(); }
  }
});

test('★★ REPAIR 6: 「酒吧」不會被當成飲酒事件', async () => {
  const { db, user, cleanup } = await seed();
  try {
    await bot(db, user, coachWith({ asserted: false }))('這杯是酒吧的調酒嗎');
    assert.equal((await rows(db, user.id)).length, 0);
  } finally { cleanup(); }
});

// ===========================================================================
// REPAIR 8 / 12 — 貢獻因素過濾與中文標籤
// ===========================================================================

test('★★★ REPAIR 12: 內部類別鍵永遠不出現在使用者看到的文字', () => {
  assert.equal(labelForCategory('alcohol'), '飲酒');
  assert.equal(labelForCategory('late_sleep'), '晚睡');
  assert.equal(labelForCategory('totally_unknown_key'), '一則紀錄');
  assert.doesNotMatch(labelForCategory('totally_unknown_key'), /totally_unknown_key/);
});

test('★★★ REPAIR 8: 只有白名單類別會被當成可能因素，而且會去重', async () => {
  const { db, user, cleanup } = await seed({ days: 1 });
  try {
    // 兩筆同類別 + 一筆不在白名單的
    for (const c of ['alcohol', 'alcohol', 'location']) {
      await db.addJournalEvent(user.id, {
        eventAt: `${HD}T10:00:00.000Z`, healthDate: HD, category: c,
        note: null, source: 'manual',
      }, { now: NOW });
    }
    const q = createHealthQuery({ db, userId: user.id, timezone: TZ, now: NOW });
    const r = await q.causeExplanation({});
    assert.equal(r.contributors.length, 1, '★ 同類別去重、非白名單排除');
    assert.equal(r.contributors[0].category, 'alcohol');
    assert.equal(r.contributors[0].label, '飲酒');
  } finally { cleanup(); }
});

// ===========================================================================
// REPAIR 9 — 時序確定性
// ===========================================================================

test('★★★ REPAIR 9: 時序只有在兩邊時間都可信時才下判斷', () => {
  const end = '2026-09-11T00:16:00.000Z';
  assert.equal(temporalRelation(end, { event_at: '2026-09-11T08:00:00.000Z', time_precision: 'now' }), 'after');
  assert.equal(temporalRelation(end, { event_at: '2026-09-10T20:00:00.000Z', time_precision: 'time' }), 'before');
  // 只有日期 → 不可以宣稱先後
  assert.equal(temporalRelation(end, { event_at: '2026-09-11T08:00:00.000Z', time_precision: 'date' }), 'unknown');
  assert.equal(temporalRelation(end, { event_at: '2026-09-11T08:00:00.000Z', time_precision: 'unknown' }), 'unknown');
  // 缺任何一邊 → unknown
  assert.equal(temporalRelation(null, { event_at: '2026-09-11T08:00:00.000Z', time_precision: 'now' }), 'unknown');
  assert.equal(temporalRelation(end, { event_at: null, time_precision: 'now' }), 'unknown');
  assert.equal(temporalRelation(end, {}), 'unknown');
});

test('★★★ REPAIR 9: 只有日期的紀錄，回覆用保守措辭', async () => {
  const { db, user, cleanup } = await seed({ days: 1 });
  try {
    const reply = await bot(db, user, coachWith({ time_precision: 'date' }))(
      '我昨晚喝酒，今天 recovery 很低是因為這樣嗎？',
    );
    assert.doesNotMatch(reply, /時間早於這件事/, '★ 時間不精確就不可以宣稱先後');
  } finally { cleanup(); }
});

// ===========================================================================
// REPAIR 10 — 追問狀態轉移
// ===========================================================================

test('★★★ REPAIR 10: 複合新話題會收掉過期的追問，不會留著吃掉後續短句', async () => {
  const { db, user, cleanup } = await seed({ days: 1 });
  try {
    await db.openPendingQuestion(user.id, {
      chatId: '5001', question: '昨天有喝酒嗎？', intent: 'today_status',
      contextJson: { health_date: HD, question_target_date: '2026-09-10' },
      ttlMs: 3600_000,
    }, { now: NOW });

    await bot(db, user)('我怎麼感覺那麼累，是因為剛剛也喝酒嗎？');
    const still = await db.getOpenPendingQuestion(user.id, { now: NOW });
    assert.equal(still, null, '★ 換話題之後，舊追問不可以還開著');

    const events = await rows(db, user.id);
    assert.equal(events.length, 1, '★ 只寫一筆');
    assert.equal(events[0].health_date, HD, '★ 必須記在今天，不是追問問的昨天');
  } finally { cleanup(); }
});

// ===========================================================================
// REPAIR 11 — 回覆長度
// ===========================================================================

test('★★★ REPAIR 11: 一般疲勞回覆維持精簡', async () => {
  const { db, user, cleanup } = await seed({ days: 1 });
  try {
    const reply = await bot(db, user)('我怎麼感覺那麼累 是因為剛剛也喝酒嗎');
    const lines = reply.split('\n').filter((l) => l.trim());
    assert.ok(lines.length <= 8, `★ 應該在 8 行以內（實際 ${lines.length}）`);
    assert.ok(reply.length < 500, `★ 長度要適合 Telegram（實際 ${reply.length}）`);
    assert.doesNotMatch(reply, /你的不正常/, '★ 不可以用這種措辭');
    assert.doesNotMatch(reply, /\balcohol\b|previous_day_strain/, '★ 不可以有內部鍵');
  } finally { cleanup(); }
});
