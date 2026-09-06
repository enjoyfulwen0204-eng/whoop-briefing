/**
 * LLM 輸出驗證（Phase AB）。
 *
 * 兩個方向都要測：
 *  - 必須攔下來的（幻覺數字、因果語言、診斷措辭、壞掉的結構）
 *  - **必須放行的**（中文標點、%、ms、bpm、°C、祈使句的「一定要」）
 *    誤判會讓正常回答被換成乾巴巴的 fallback，那也是傷害。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  validateStructured, structuredWithRetry, validateNarrative,
  guardNarrative, allowedNumbersFrom,
} from '../src/llmValidation.js';
import { INTENT_SCHEMA, resolveIntent } from '../src/bot/intent.js';
import { JOURNAL_SCHEMA, parseNaturalJournal } from '../src/bot/router.js';

const TZ = 'Asia/Taipei';
const NOW = new Date('2026-09-01T04:00:00Z');

// ===========================================================================
// 結構化輸出
// ===========================================================================

test('AB: schema —— 合法輸入通過', () => {
  const r = validateStructured(
    { intent: 'trend_query', metric: 'hrv', window_days: 30 },
    INTENT_SCHEMA,
  );
  assert.equal(r.ok, true);
  assert.equal(r.value.intent, 'trend_query');
  assert.equal(r.value.window_days, 30);
});

test('★ AB: 拒絕未知欄位（模型自己加欄位＝在自由發揮）', () => {
  const r = validateStructured(
    { intent: 'trend_query', metric: 'hrv', window_days: 30, sql: 'DROP TABLE x' },
    INTENT_SCHEMA,
  );
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.startsWith('unknown_field:sql')));
  assert.equal(r.value, null);
});

test('★ AB: 拒絕非法 enum', () => {
  const r = validateStructured({ intent: '我自己發明的 intent' }, INTENT_SCHEMA);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.startsWith('invalid_enum:intent')));
});

test('★ AB: 拒絕超出範圍的數值', () => {
  assert.equal(validateStructured(
    { intent: 'trend_query', window_days: 9999 }, INTENT_SCHEMA,
  ).ok, false);
  assert.equal(validateStructured(
    { intent: 'trend_query', window_days: -5 }, INTENT_SCHEMA,
  ).ok, false);
  assert.equal(validateStructured(
    { intent: 'trend_query', window_days: 1.5 }, INTENT_SCHEMA,
  ).ok, false, '整數欄位不接受小數');
});

test('AB: journal schema 擋掉負數量與超大數值', () => {
  assert.equal(validateStructured(
    { category: 'alcohol', numeric_value: -3 }, JOURNAL_SCHEMA,
  ).ok, false);
  assert.equal(validateStructured(
    { category: 'alcohol', numeric_value: 999_999_999 }, JOURNAL_SCHEMA,
  ).ok, false);
  assert.equal(validateStructured(
    { category: 'alcohol', numeric_value: 3, day_offset: -1, confidence: 0.9 }, JOURNAL_SCHEMA,
  ).ok, true);
  assert.equal(validateStructured(
    { category: 'alcohol', day_offset: 5 }, JOURNAL_SCHEMA,
  ).ok, false, '未來的 day_offset 不合法');
});

test('AB: 非物件一律拒絕', () => {
  for (const v of [null, 'string', 42, [1, 2, 3]]) {
    assert.equal(validateStructured(v, INTENT_SCHEMA).ok, false);
  }
});

test('★ AB: 壞掉的 JSON 最多重試一次，第二次仍失敗就走 fallback', async () => {
  let calls = 0;
  const r = await structuredWithRetry({
    label: 'test',
    spec: INTENT_SCHEMA,
    call: async () => { calls += 1; return null; },   // 永遠解析不出來
    fallbackFn: () => ({ intent: 'unknown' }),
  });
  assert.equal(calls, 2, '★ 剛好兩次，不會無限重試');
  assert.equal(r.ok, false);
  assert.equal(r.usedFallback, true);
  assert.deepEqual(r.value, { intent: 'unknown' });
});

test('AB: 第一次壞、第二次好 → 用第二次的結果', async () => {
  let calls = 0;
  const r = await structuredWithRetry({
    label: 'test',
    spec: INTENT_SCHEMA,
    call: async () => {
      calls += 1;
      return calls === 1 ? { intent: '亂編' } : { intent: 'today_status' };
    },
    fallbackFn: () => null,
  });
  assert.equal(r.ok, true);
  assert.equal(r.attempts, 2);
  assert.equal(r.value.intent, 'today_status');
});

test('AB: call 本身丟例外也算一次失敗，不會炸出來', async () => {
  const r = await structuredWithRetry({
    label: 'test',
    spec: INTENT_SCHEMA,
    call: async () => { throw new Error('network'); },
    fallbackFn: () => ({ intent: 'unknown' }),
  });
  assert.equal(r.usedFallback, true);
});

test('★ AB: intent parser 端到端 —— 模型亂回，最後回 unknown 不是照著查', async () => {
  const coach = { async json() { return { intent: 'DROP_TABLE', evil: true }; } };
  const out = await resolveIntent('隨便一句看不懂的話', { coach });
  assert.equal(out.intent, 'unknown');
  assert.equal(out.source, 'llm_fallback');
});

test('★ AB: journal parser 端到端 —— schema 不合法就不寫入', async () => {
  const coach = { async json() { return { category: 'alcohol', numeric_value: -5 }; } };
  const out = await parseNaturalJournal({
    text: '昨天喝了酒', now: NOW, timezone: TZ, coach,
  });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'schema_invalid');
});

// ===========================================================================
// 敘述性回答
// ===========================================================================

const CONTEXT = [
  '使用者的問題：我今天狀態怎樣',
  '分析類型：today_status',
  '最新健康日：2026-09-01',
  '今日指標（程式已算好）：',
  '- HRV：42ms，30 天基準 55ms（n=30），z=-2.10，偏離程度：STRONG',
  '- 靜息心率：58bpm，30 天基準 51bpm（n=30），z=1.80，偏離程度：NOTABLE',
  '- 睡眠：6h30m，30 天基準 7h05m（n=28），z=-1.20，偏離程度：MILD',
].join('\n');

test('★ AB: 正常回答不可以被誤判（%、ms、bpm、中文標點都要放行）', () => {
  const good = 'Kelvin 早安 ☀️ 今天 HRV 是 42ms，比你平常的 55ms 低了一些；'
    + '靜息心率 58bpm 也比基準 51bpm 高。睡眠 6h30m 稍短。'
    + '今天強度先放緩一點，多補水、早點休息會有幫助 💛';
  const v = validateNarrative(good, CONTEXT);
  assert.equal(v.ok, true, `不該被擋：${JSON.stringify(v.problems)}`);
});

test('★ AB: 攔下 context 裡沒有的數字（幻覺）', () => {
  const bad = '今天 HRV 是 42ms，而你上個月平均是 73ms，掉了 31%。';
  const v = validateNarrative(bad, CONTEXT);
  assert.equal(v.ok, false);
  assert.ok(v.problems.some((p) => p.includes('73')), `應該抓到 73ms：${JSON.stringify(v.problems)}`);
});

test('AB: 允許合理的四捨五入（55ms 講成 55、-2.10 講成 2.1）', () => {
  const ok = 'HRV 42ms 比基準 55ms 低，z 分數大約 -2.1。';
  assert.equal(validateNarrative(ok, CONTEXT).ok, true);
});

test('★ AB: 攔下編造的日期', () => {
  const bad = '你在 2026-07-15 那天的表現比較好。';
  const v = validateNarrative(bad, CONTEXT);
  assert.equal(v.ok, false);
  assert.ok(v.problems.some((p) => p.startsWith('unsupported_date')));
  // context 裡有的日期要放行
  assert.equal(validateNarrative('2026-09-01 的數字如上。', CONTEXT).ok, true);
});

test('★ AB: 攔下 context 沒有的指標（憑空冒出血氧）', () => {
  const bad = '你的血氧偏低，要注意一下。';
  const v = validateNarrative(bad, CONTEXT);
  assert.equal(v.ok, false);
  assert.ok(v.problems.some((p) => p.includes('血氧')));
});

test('★ AB: 攔下強因果語言', () => {
  const cases = [
    '這一定是因為你昨天喝酒。',
    '這證明了睡眠不足會影響恢復。',
    '熬夜導致你的 HRV 下降。',
    '喝酒造成恢復變差。',
    'This definitely proves the pattern.',
    'Alcohol causes your recovery to drop.',
  ];
  for (const c of cases) {
    const v = validateNarrative(c, CONTEXT, { checkNumbers: false, checkMetrics: false });
    assert.equal(v.ok, false, `應該擋下：${c}`);
    assert.ok(v.problems.some((p) => p.startsWith('causal_language')));
  }
});

test('★ AB: 「一定要早點睡」是祈使句，不可以被誤判成因果宣稱', () => {
  const fine = '今天一定要早點休息，明天會好很多。';
  const v = validateNarrative(fine, CONTEXT, { checkNumbers: false, checkMetrics: false });
  assert.equal(v.ok, true, `祈使句不該被擋：${JSON.stringify(v.problems)}`);
});

test('★ AB: 攔下醫學診斷措辭，但保留「不舒服就去看醫生」的提醒', () => {
  const bad = [
    '你可能得了感冒。',
    '這是確診的徵兆。',
    'You may have an infection, this looks like a diagnosis.',
  ];
  for (const c of bad) {
    const v = validateNarrative(c, CONTEXT, { checkNumbers: false, checkMetrics: false });
    assert.equal(v.ok, false, `應該擋下：${c}`);
  }

  const fine = '如果你也覺得疲倦或喉嚨不舒服，別硬撐，去看醫生比較保險。';
  const v = validateNarrative(fine, CONTEXT, { checkNumbers: false, checkMetrics: false });
  assert.equal(v.ok, true, `正確的就醫提醒不該被擋：${JSON.stringify(v.problems)}`);
});

test('AB: allowedNumbersFrom 會收進四捨五入的變體', () => {
  const s = allowedNumbersFrom('平均 55.4ms，z=-2.13');
  assert.ok(s.has(55.4));
  assert.ok(s.has(55));
  assert.ok(s.has(2.13), '絕對值也要允許');
  assert.ok(s.has(2.1));
});

test('★ AB: guardNarrative 驗證失敗時原文絕不外流', () => {
  const bad = '這一定是因為你昨天喝酒，你的血氧只有 88%。';
  const g = guardNarrative({
    answer: bad, context: CONTEXT, fallback: '（安全的 fallback 文字）', label: 'test',
  });
  assert.equal(g.used, 'fallback');
  assert.equal(g.text, '（安全的 fallback 文字）');
  assert.notEqual(g.text, bad, '★ 有問題的原文不可以被送出去');
  assert.ok(g.problems.length > 0);
});

test('AB: guardNarrative 驗證通過就原文放行', () => {
  const good = '今天 HRV 42ms 比平常的 55ms 低一些，先放緩一點。';
  const g = guardNarrative({ answer: good, context: CONTEXT, fallback: 'fb' });
  assert.equal(g.used, 'llm');
  assert.equal(g.text, good);
});

test('AB: 空回答走 fallback', () => {
  assert.equal(guardNarrative({ answer: '', context: CONTEXT, fallback: 'fb' }).text, 'fb');
  assert.equal(guardNarrative({ answer: null, context: CONTEXT, fallback: 'fb' }).text, 'fb');
});
