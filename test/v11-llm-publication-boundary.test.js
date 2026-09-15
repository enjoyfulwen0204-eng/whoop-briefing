/**
 * V1.1 final audit — H-05：LLM 的發布權限。
 *
 * ## 被推翻的架構
 *
 *     模型自由寫一段話 → 規則檢查 → 通過就原文發布
 *
 * 稽核用一句話證明它守不住：
 *
 *     「熬夜使你的免疫力下降。」
 *
 * 沒有數字、沒有指標名、沒有拉丁字母、沒有藥名病名 —— 每一條規則都放行，
 * 而它是一個毫無根據的因果生理宣稱。再加一條規則只會換來下一句。
 *
 * ## 現在的架構
 *
 * 應用程式把所有可以說的話寫好，每句一個 id；模型唯一能回的是一串 id。
 * 發布出去的文字 100% 來自那份清單。
 *
 * 所以這一支測試的**判準不是「有沒有擋掉某句話」**，而是更強的東西：
 *
 *     已發布的每一個字，都必須能在應用程式的句子清單裡找到出處。
 *
 * 這個判準對「我們沒想到的攻擊」同樣成立 —— 那正是前三輪缺的性質。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildNarrative, deterministicNarrative, NARRATIVE_SOURCE, NARRATIVE_FAILURE } from '../src/narrative.js';
import {
  buildFragmentCatalogue, validatePlan, renderFragments, catalogueForModel, MAX_FRAGMENTS,
} from '../src/narrativePlan.js';
import { createCoach } from '../src/coach.js';

const BRIEFING = {
  stage: 'full',
  sampleCount: 30,
  healthDate: '2026-09-12',
  trends: { alerts: [{ label: 'HRV' }] },
  metrics: [
    { key: 'recovery_score', label: '恢復', display: '28%', available: true, baselineDisplay: '62%', severity: 'red', calibrating: false },
    { key: 'sleep_total', label: '睡眠', display: '7h12m', available: true, baselineDisplay: '7h05m', severity: 'normal', calibrating: false },
    { key: 'hrv', label: 'HRV', display: '33ms', available: true, baselineDisplay: '48ms', severity: 'red', calibrating: false },
    { key: 'spo2', label: '血氧', display: '96%', available: true, baselineDisplay: null, severity: null, calibrating: false },
  ],
};

const EMPTY_BRIEFING = {
  stage: 'cold', sampleCount: 0, healthDate: '2026-09-12', trends: null, metrics: [],
};

const run = (payload, briefing = BRIEFING) => buildNarrative({
  briefing, plan: async () => payload,
});

/** 已發布的文字必須完全由清單裡的句子組成 —— 這是最強的那個判準。 */
function assertEveryWordIsOurs(text, briefing = BRIEFING, period = 'daily') {
  const catalogue = buildFragmentCatalogue(briefing, { period });
  let remaining = text;
  for (const f of catalogue.fragments) remaining = remaining.split(f.text).join('');
  assert.equal(remaining.trim(), '',
    `★★★ 已發布的文字含有不在清單裡的內容：${JSON.stringify(remaining.slice(0, 80))}`);
}

// ===========================================================================
// 稽核重現的那一句，以及它的同類
// ===========================================================================

const UNSUPPORTED_CLAIMS = [
  ['稽核重現：無證據的因果生理', '熬夜使你的免疫力下降。'],
  ['發明生理機轉', '長期壓力會讓你的自律神經失衡，讓身體更難進入深層修復。'],
  ['發明生理概念', '你的粒線體效率今天特別低落。'],
  ['發明指標', '你的細胞含水指數偏低。'],
  ['發明數字', '你的恢復分數其實應該是 91 分。'],
  ['發明處方', '多做一些高強度間歇訓練會讓你明天更有精神。'],
  ['診斷', '你可能有慢性發炎。'],
  ['用藥', '睡前吃一顆褪黑激素會有幫助。'],
  ['非中文越獄', 'Your immune system is weakened by staying up late.'],
  ['表情符號夾帶', '熬🌙夜🌙使你的免🌙疫🌙力下降'],
];

test('★★★ H-05/1: 每一種未經支持的宣稱都不會被發布', async () => {
  for (const [label, claim] of UNSUPPORTED_CLAIMS) {
    const r = await run(claim);
    assert.equal(r.source, NARRATIVE_SOURCE.DETERMINISTIC, `★ ${label}`);
    assert.equal(r.failureCategory, NARRATIVE_FAILURE.INVALID_PLAN, `★ ${label} 分類`);
    assertEveryWordIsOurs(r.text);
  }
});

test('★★★ H-05/2: 零證據 —— 沒有任何指標時也不會生出健康宣稱', async () => {
  const r = await run('熬夜使你的免疫力下降。', EMPTY_BRIEFING);
  assert.equal(r.source, NARRATIVE_SOURCE.DETERMINISTIC);
  assert.doesNotMatch(r.text, /免疫|熬夜/);
  assertEveryWordIsOurs(r.text, EMPTY_BRIEFING);
  // 而且仍然要是一段有用的話，不是錯誤訊息。
  assert.ok(r.text.length > 10);
  assert.doesNotMatch(r.text, /錯誤|失敗|無法生成/);
});

test('★★★ H-05/3: 把宣稱藏在計畫的任何角落都沒有用', async () => {
  const catalogue = buildFragmentCatalogue(BRIEFING, { period: 'daily' });
  const legal = catalogue.defaultOrder;
  const payloads = [
    ['額外欄位', { order: legal, text: '熬夜使你的免疫力下降。' }],
    ['巢狀欄位', { order: legal, meta: { note: '你的粒線體效率低落' } }],
    ['id 後面接句子', { order: [...legal, '另外，你的免疫力下降了。'] }],
    ['把句子當 id', { order: ['熬夜使你的免疫力下降。'] }],
    ['物件當 id', { order: [{ id: legal[0], text: '你有慢性發炎' }] }],
  ];
  for (const [label, payload] of payloads) {
    const r = await run(payload);
    assert.doesNotMatch(r.text, /免疫|粒線體|慢性發炎|熬夜/, `★ ${label} 不可以洩漏`);
    assertEveryWordIsOurs(r.text);
  }
});

// ===========================================================================
// 計畫驗證的結構性規則
// ===========================================================================

test('★★★ H-05/4: 編造的 id → 整包拒絕（不是略過那一個）', () => {
  const c = buildFragmentCatalogue(BRIEFING, { period: 'daily' });
  const withFake = validatePlan(c, { order: [...c.defaultOrder, 'f_immune_collapse'] });
  assert.equal(withFake.ok, false);
  assert.equal(withFake.reason, 'plan_unknown_id');
});

test('★★★ H-05/5: 事實骨幹不可以被丟掉', () => {
  const c = buildFragmentCatalogue(BRIEFING, { period: 'daily' });
  const required = c.fragments.filter((f) => f.required).map((f) => f.id);
  assert.ok(required.length > 0, '★ 一定要有必要片段，否則模型可以把事實全刪掉');
  const onlyOptional = c.defaultOrder.filter((id) => !required.includes(id));
  const r = validatePlan(c, { order: onlyOptional });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'plan_missing_required');
});

test('★★★ H-05/6: 重複、超長、空計畫都被拒絕', () => {
  const c = buildFragmentCatalogue(BRIEFING, { period: 'daily' });
  assert.equal(validatePlan(c, { order: [] }).reason, 'plan_empty');
  assert.equal(validatePlan(c, { order: [c.defaultOrder[0], c.defaultOrder[0]] }).reason,
    'plan_duplicate_id');
  assert.equal(
    validatePlan(c, { order: Array(MAX_FRAGMENTS + 1).fill(c.defaultOrder[0]) }).reason,
    'plan_too_long',
  );
  assert.equal(validatePlan(c, 'not an array').reason, 'plan_not_array');
  assert.equal(validatePlan(c, { order: [42] }).reason, 'plan_non_string_id');
});

test('★★★ H-05/7: 合法計畫只改順序，一個字都不會多', async () => {
  const c = buildFragmentCatalogue(BRIEFING, { period: 'daily' });
  const reordered = [...c.defaultOrder].reverse();
  const r = await run({ order: reordered });
  assert.equal(r.source, NARRATIVE_SOURCE.MODEL);
  assert.equal(r.text, renderFragments(c, reordered));
  assertEveryWordIsOurs(r.text);
});

test('★★★ H-05/8: 模型看不到內部狀態（看不到的東西就洩漏不了）', () => {
  const c = buildFragmentCatalogue(BRIEFING, { period: 'daily' });
  const forModel = catalogueForModel(c);
  for (const item of forModel) {
    assert.deepEqual(Object.keys(item).sort(), ['id', 'required', 'text'],
      '★ 只可以看到 id / 句子 / 是否必要');
  }
  const serialized = JSON.stringify(forModel);
  // 原始指標鍵與 briefing 內部欄位絕不可以出現在餵給模型的東西裡。
  for (const leak of ['recovery_score', 'baselineDisplay', 'severity', 'healthDate', 'sampleCount']) {
    assert.ok(!serialized.includes(leak), `★ 不可以洩漏內部欄位 ${leak}`);
  }
});

// ===========================================================================
// 模型不可用 / 壞掉時仍然可用
// ===========================================================================

test('★★★ H-05/9: 模型完全不可用時，報告仍然有用', async () => {
  for (const [label, plan] of [
    ['沒有設定', null],
    ['回 null', async () => null],
    ['拋錯', async () => { throw new Error('503 upstream'); }],
    ['逾時', async () => { throw new Error('request timeout'); }],
    ['回 undefined', async () => undefined],
  ]) {
    const r = await buildNarrative({ briefing: BRIEFING, plan });
    assert.equal(r.source, NARRATIVE_SOURCE.DETERMINISTIC, `★ ${label}`);
    // 「有用」的定義：講得出事實、講得出要注意什麼、給得出一句建議。
    assert.match(r.text, /28%/, `★ ${label} 事實要在`);
    assert.match(r.text, /基準/, `★ ${label} 判斷要在`);
    assert.match(r.text, /放輕|節奏/, `★ ${label} 建議要在`);
    assert.doesNotMatch(r.text, /暫時無法生成|錯誤/, `★ ${label} 不可以把故障丟給使用者`);
    assertEveryWordIsOurs(r.text);
  }
});

test('★★★ H-05/10: 模型輸出畸形（各種形狀）都不會讓流程壞掉', async () => {
  for (const payload of [
    0, '', '   ', [], {}, { order: null }, { order: {} }, { order: [null] },
    { order: [undefined] }, NaN, true, Symbol.iterator.toString(),
  ]) {
    const r = await run(payload);
    assert.ok(r.text.length > 10, `★ ${String(payload)} 仍然要有敘述`);
    assertEveryWordIsOurs(r.text);
  }
});

test('★★★ H-05/11: 確定性敘述本身就是預設順序（兩條路產生同一段話）', () => {
  const c = buildFragmentCatalogue(BRIEFING, { period: 'daily' });
  assert.equal(deterministicNarrative(BRIEFING), renderFragments(c, c.defaultOrder));
});

test('★★★ H-05/12: 週報用自己的一套句子（不可以講「今天」）', async () => {
  const weekly = await buildNarrative({ briefing: BRIEFING, plan: null, period: 'weekly' });
  assert.match(weekly.text, /上週/);
  assert.doesNotMatch(weekly.text, /今天恢復|今天的指標/);
  assertEveryWordIsOurs(weekly.text, BRIEFING, 'weekly');
});

// ===========================================================================
// 真正的 coach 接線（不打真的 OpenRouter）
// ===========================================================================

/** 假的 OpenRouter：回傳指定的 assistant 內容。 */
function fakeProvider(content) {
  return async () => ({
    ok: true,
    status: 200,
    async text() {
      return JSON.stringify({
        choices: [{ message: { content } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
        model: 'fake',
      });
    },
  });
}

const coachWith = (content) => createCoach({
  apiKey: 'test-key', fetchImpl: fakeProvider(content),
});

test('★★★ H-05/13: 真的 coach.narrativePlan —— 合法計畫可用，散文一律丟掉', async () => {
  const c = buildFragmentCatalogue(BRIEFING, { period: 'daily' });
  const fragments = catalogueForModel(c);

  // (a) 模型乖乖回 JSON id 陣列
  const good = coachWith(JSON.stringify({ order: c.defaultOrder }));
  const plan = await good.narrativePlan(fragments, { period: 'daily' });
  assert.deepEqual(plan.order, c.defaultOrder);
  const okNarrative = await buildNarrative({
    briefing: BRIEFING, plan: () => good.narrativePlan(fragments, { period: 'daily' }),
  });
  assert.equal(okNarrative.source, NARRATIVE_SOURCE.MODEL);
  assertEveryWordIsOurs(okNarrative.text);

  // (b) 模型無視指示，回一段健康散文
  const bad = coachWith('熬夜使你的免疫力下降。你的粒線體效率也很低。');
  const badNarrative = await buildNarrative({
    briefing: BRIEFING, plan: () => bad.narrativePlan(fragments, { period: 'daily' }),
  });
  assert.equal(badNarrative.source, NARRATIVE_SOURCE.DETERMINISTIC);
  assert.doesNotMatch(badNarrative.text, /免疫|粒線體|熬夜/);
  assertEveryWordIsOurs(badNarrative.text);
});

test('★★★ H-05/14: 餵給模型的 prompt 本身不含任何內部欄位', async () => {
  const c = buildFragmentCatalogue(BRIEFING, { period: 'daily' });
  let seenBody = null;
  const capture = createCoach({
    apiKey: 'test-key',
    fetchImpl: async (url, opts) => {
      seenBody = String(opts?.body ?? '');
      return (await fakeProvider(JSON.stringify({ order: c.defaultOrder }))())
        ;
    },
  });
  await capture.narrativePlan(catalogueForModel(c), { period: 'daily' });
  assert.ok(seenBody, '★ 要真的送出過請求');
  for (const leak of ['recovery_score', 'baselineDisplay', 'severity', 'sampleCount']) {
    assert.ok(!seenBody.includes(leak), `★ prompt 不可以帶內部欄位 ${leak}`);
  }
});
