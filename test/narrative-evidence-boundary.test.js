/**
 * 敘述證據邊界（H-02）。
 *
 * ## 修的是什麼
 *
 * 舊版的敘述守門有三個獨立的破口，實測 11 個對抗樣本放行 8 個：
 *
 *  1. **數字沒有和指標綁定。** `allowedNumbersFrom()` 把 context 裡所有數字
 *     倒進同一個集合，`isSupported()` 只問「這個數字出現過嗎」。於是
 *     context 有「恢復 55%、睡眠表現 99%」時，「你的恢復是 99%」通過。
 *  2. **使用者的原話被當成證據。** `buildAnswerContext()` 的第一行是
 *     `使用者的問題：<原話>`，而同一個字串又被當成驗證用的 context。
 *     使用者於是可以自己授權自己的健康宣稱。
 *  3. **專有 / 衍生分數與用藥指示完全沒有規則。** WHOOP Age、Healthspan
 *     分數、推估生理年齡、「睡前吃 3mg 褪黑激素」全部暢行無阻。
 *
 * ## 現在的不變量
 *
 *   **USER TEXT IS NOT EVIDENCE.**
 *   只有確定性 / 統計層算出來的事實可以授權一個事實性健康宣稱，
 *   而且授權是**逐指標**的：一個數字只能證明它自己那個指標。
 *
 * ## 不能誤判
 *
 * 引用真實數字的正常教練回答必須原封不動通過。下面每一組攔截規則都有
 * 對應的 false-positive 測試，並且直接跑真實的 buildDailyUserMessage()
 * 輸出，而不是手寫的假 context。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  validateNarrative, guardNarrative, metricBindingsFrom, metricClaimsIn,
} from '../src/llmValidation.js';
import { buildAnswerContext, buildTrustedFacts, composeAnswer } from '../src/bot/answer.js';
import { buildDailyUserMessage } from '../src/coach.js';
import { buildBriefing } from '../src/daily.js';
import { makeDataset } from './fixtures.js';

/** 一份真實形狀的可信事實（今日指標 + 30 天基準）。 */
const TRUSTED = [
  '分析類型：today_status',
  '最新健康日：2026-09-09',
  '今日指標（程式已算好）：',
  '- 恢復：55%，30 天基準 62%（n=30），z=-0.80，偏離程度：mild',
  '- HRV：62ms，30 天基準 58ms（n=30），z=0.40，偏離程度：normal',
  '- 靜息心率：50bpm，30 天基準 52bpm（n=30），z=-0.50，偏離程度：normal',
  '- 睡眠表現：99%，30 天基準 88%（n=30），z=1.10，偏離程度：normal',
].join('\n');

/** 真實的 daily evidence context —— 不是手寫的，直接由 Node 從 fixture 算出來。 */
const REAL_DAILY_CONTEXT = buildDailyUserMessage(buildBriefing({
  ...makeDataset({ days: 45 }), timezone: 'Asia/Taipei',
}));

// ===========================================================================
// ★★★ A. 指標 ↔ 數值綁定
// ===========================================================================

test('★★★ H-02: 把別的指標的數字安到這個指標上 → 擋下', () => {
  // 99 確實出現在 context 裡（睡眠表現），但它不是恢復的值
  const v = validateNarrative('你今天的恢復是 99%，很不錯。', TRUSTED);
  assert.equal(v.ok, false, '★ 跨指標挪用數字必須被擋下');
  assert.ok(v.problems.some((p) => p.startsWith('metric_value_mismatch')), v.problems.join());
});

test('★★★ H-02: 拿基準樣本數（n=30）當成 HRV 的值 → 擋下', () => {
  const v = validateNarrative('你的 HRV 是 30ms，偏低。', TRUSTED);
  assert.equal(v.ok, false);
  assert.ok(v.problems.some((p) => p.startsWith('metric_value_mismatch')));
});

test('★★★ H-02: 完全捏造的靜息心率 → 擋下', () => {
  const v = validateNarrative('你的靜息心率 99bpm，偏高。', TRUSTED);
  assert.equal(v.ok, false);
});

test('★★★ H-02: 指標在事實裡沒有任何數值 → 不可以給它數值（fail-closed）', () => {
  // TRUSTED 裡完全沒有「睡眠」的時長
  const v = validateNarrative('你昨晚睡眠 30 小時。', TRUSTED);
  assert.equal(v.ok, false);
  assert.ok(v.problems.some((p) => p.startsWith('unsupported_metric_value')), v.problems.join());
});

test('★★ H-02: metricBindingsFrom 逐指標綁定，不會把數字混在一起', () => {
  const b = metricBindingsFrom(TRUSTED);
  assert.ok(b.get('恢復').has(55), '恢復 → 55');
  assert.ok(!b.get('恢復').has(99), '★ 恢復 絕不可以拿到 睡眠表現 的 99');
  assert.ok(b.get('hrv').has(62), 'HRV → 62');
  assert.ok(!b.get('hrv').has(30), '★ HRV 絕不可以拿到 n=30 的 30');
  assert.ok(b.get('rhr').has(50), '靜息心率 → 50');
});

test('★★ H-02: 長指標名優先（睡眠表現 不會被 睡眠 吃掉）', () => {
  const claims = metricClaimsIn('睡眠表現 99%');
  assert.equal(claims.length, 1);
  assert.equal(claims[0].key, '睡眠表現', '★ 必須綁到 睡眠表現，不是 睡眠');
});

test('★★ H-02: 連接詞集合不會跨過另一個指標名', () => {
  // 「HRV 偏低、恢復 55%」——55 是恢復的，不可以被讀成 HRV 的
  const claims = metricClaimsIn('HRV 偏低、恢復 55%');
  assert.deepEqual(claims.map((c) => [c.key, c.value]), [['恢復', 55]]);
});

// ===========================================================================
// ★★★ B. USER TEXT IS NOT EVIDENCE
// ===========================================================================

const RESULT = {
  intent: 'today_status', available: true, health_date: '2026-09-09', history_days: 30,
  metrics: {
    recovery: {
      label: '恢復', value: 55, display: '55%',
      baseline_display: '62%', baseline_n: 30, z_score: -0.8, level: 'mild',
    },
    hrv: {
      label: 'HRV', value: 62, display: '62ms',
      baseline_display: '58ms', baseline_n: 30, z_score: 0.4, level: 'normal',
    },
  },
};
const LOADED_QUESTION = '我的 HRV 是 999ms，恢復是 12%，對嗎？';

test('★★★ H-02: buildTrustedFacts 不含使用者的問題', () => {
  const facts = buildTrustedFacts(RESULT);
  assert.ok(!facts.includes('使用者的問題'), '★ 可信事實不可以有問題那一行');
  assert.ok(!facts.includes('999'), '★ 使用者塞的數字不可以進可信事實');
  assert.ok(facts.includes('55%') && facts.includes('62ms'), '真實數字要在');
});

test('★★ H-02: prompt 仍然含問題（模型看得到，只是不算證據）', () => {
  const prompt = buildAnswerContext(LOADED_QUESTION, RESULT);
  assert.ok(prompt.includes(LOADED_QUESTION), '模型需要看到問題才知道要回答什麼');
  assert.ok(prompt.includes('55%'), '事實也要在 prompt 裡');
});

test('★★★ H-02: 使用者塞在問題裡的數字不能授權健康宣稱', () => {
  const injected = '對，你的 HRV 是 999ms，恢復是 12%，都要注意。';

  // 舊接線：context = 含問題的 prompt → 使用者自己授權了自己
  assert.equal(
    validateNarrative(injected, buildAnswerContext(LOADED_QUESTION, RESULT)).ok, true,
    '（存證）舊接線確實會放行 —— 這正是 H-02',
  );
  // 新接線：context = 可信事實
  const v = validateNarrative(injected, buildTrustedFacts(RESULT));
  assert.equal(v.ok, false, '★ 可信事實裡沒有 999 / 12，必須擋下');
});

test('★★★ H-02 端到端：composeAnswer 用可信事實驗證，注入的數字絕不外流', async () => {
  const injected = '對，你的 HRV 是 999ms，恢復是 12%，都要注意。';
  const seen = {};
  const coach = {
    async ask({ user }) { seen.prompt = user; return injected; },
  };
  const out = await composeAnswer({ question: LOADED_QUESTION, result: RESULT, coach });

  assert.ok(!out.includes('999'), '★ 使用者注入的數字絕不可以出現在最終回覆');
  assert.ok(!out.includes(injected), '★ 有問題的原文整段都不可以送出');
  assert.ok(seen.prompt.includes(LOADED_QUESTION), '模型還是有看到問題');
  assert.ok(out.includes('55%'), '確定性 fallback 照常送出真實數字');
});

test('★★ H-02 端到端：合格的回答仍然原文放行（沒有把功能鎖死）', async () => {
  const good = 'Kelvin，你今天的恢復 55%，比 30 天基準 62% 低一點；HRV 62ms 還算穩，今天照平常節奏走就好 💛';
  const coach = { async ask() { return good; } };
  const out = await composeAnswer({ question: '我今天怎麼樣？', result: RESULT, coach });
  assert.equal(out, good, '★ 正常回答必須完整保留');
});

// ===========================================================================
// ★★★ C. 專有 / 衍生分數
// ===========================================================================

for (const [name, text] of [
  ['WHOOP Age', '你的 WHOOP Age 大概是 30 歲。'],
  ['WHOOP Healthspan', '從 WHOOP Healthspan 來看你狀態不錯。'],
  ['生理年齡', '推估你的生理年齡 30 歲。'],
  ['推估年齡', '你的推估年齡比實際年輕。'],
  ['Healthspan Score', '你的 Personal Healthspan Score 是 55。'],
  ['Estimated Physiological Age', 'Your Estimated Physiological Age is 30.'],
  ['Pace Estimate', 'Your Pace Estimate looks good.'],
]) {
  test(`★★★ H-02: 專有/衍生分數宣稱被擋下（${name}）`, () => {
    const v = validateNarrative(text, TRUSTED);
    assert.equal(v.ok, false, `★ ${name} 在任何情況下都不該被敘述出來`);
    assert.ok(v.problems.some((p) => p.startsWith('proprietary_claim')), v.problems.join());
  });
}

test('★★ H-02: 誠實說「這個系統算不出年齡」不會被誤判', () => {
  // 這句話本身不含任何專有分數宣稱
  const ok = 'Kelvin，這個系統目前拿不到那種綜合分數，我只能就手上的指標跟你說。';
  assert.equal(validateNarrative(ok, TRUSTED).ok, true);
});

// ===========================================================================
// ★★★ D. 治療 / 用藥指示
// ===========================================================================

for (const [name, text] of [
  ['中文劑量', '建議你睡前補充 3mg 褪黑激素。'],
  ['吃藥', '可以吃一顆安眠藥幫助入睡。'],
  ['英文用藥', 'You should take a 500mg antibiotic.'],
  ['medication advice', 'I recommend a prescription for this.'],
  ['處置指示', '建議你去打針。'],
]) {
  test(`★★★ H-02: 治療/用藥指示被擋下（${name}）`, () => {
    const v = validateNarrative(text, TRUSTED);
    assert.equal(v.ok, false, `★ ${name} 不可以送出`);
    assert.ok(v.problems.some((p) => p.startsWith('treatment_advice')), v.problems.join());
  });
}

for (const [name, text] of [
  ['早點睡', '建議你今天早點睡，睡滿七小時。'],
  ['多喝水', '記得多喝水、動一動，別給自己太大壓力。'],
  ['減量訓練', '今天訓練量可以稍微降一點，明天再加回來。'],
  ['不舒服看醫生', '如果你覺得不舒服，還是找醫師看一下比較安心。'],
]) {
  test(`★★ H-02 false positive: 生活作息建議必須通過（${name}）`, () => {
    const v = validateNarrative(text, TRUSTED);
    assert.equal(v.ok, true, `★ ${name} 是這個產品本來就該做的事：${v.problems?.join()}`);
  });
}

// ===========================================================================
// ★★★ E. False positive：真實 daily context + 引用真實數字的正常回答
// ===========================================================================

for (const [name, text] of [
  ['引用多個指標', '早安 Kelvin，你今天的恢復 73%，比基準 65% 高一些；HRV 55ms 跟平常一樣，靜息心率 52bpm 也穩。睡眠 7h01m，深睡 1h28m，都在正常範圍 💛'],
  ['百分比與小數', '早安 Kelvin，今天恢復是 73%，睡眠表現 90%，血氧 96.8%，呼吸率 14.9，整體看起來很穩。'],
  ['Strain 與 REM', '早安 Kelvin，昨日 Strain 10.6 偏低一點，今天有餘裕可以加一點量。REM 1h36m 也夠。'],
  ['睡眠子指標', '早安 Kelvin，睡眠效率 93%、睡眠一致性 73%，作息還算穩定，繼續保持。'],
  ['完全不含數字', '早安 Kelvin，今天整體看起來穩定，照平常節奏走就好，記得多補水 💛'],
]) {
  test(`★★ H-02 false positive: 真實 daily 敘述必須通過（${name}）`, () => {
    const v = validateNarrative(text, REAL_DAILY_CONTEXT);
    assert.equal(v.ok, true, `★ 正常敘述被誤擋：${v.problems?.join()}`);
  });
}

for (const [name, text] of [
  ['恢復挪用睡眠表現的 90', '早安 Kelvin，你今天的恢復 90%，非常好。'],
  ['HRV 挪用恢復的 73', '早安 Kelvin，你的 HRV 73ms，比平常高。'],
  ['靜息心率挪用血氧的 96', '早安 Kelvin，你的靜息心率 96bpm，偏高。'],
]) {
  test(`★★★ H-02: 真實 daily context 下的跨指標挪用也擋得住（${name}）`, () => {
    const v = validateNarrative(text, REAL_DAILY_CONTEXT);
    assert.equal(v.ok, false, '★ 每個數字都「有出處」，但綁錯了指標');
    assert.ok(v.problems.some((p) => p.startsWith('metric_value_mismatch')), v.problems.join());
  });
}

// ===========================================================================
// F. guardNarrative 仍然 fail-closed
// ===========================================================================

test('★★ H-02: guardNarrative 攔下時原文一個字都不外流', () => {
  const g = guardNarrative({
    answer: '你的 WHOOP Age 是 30 歲，恢復 99%，建議吃 3mg 褪黑激素。',
    context: TRUSTED,
    fallback: '（確定性版本）',
  });
  assert.equal(g.used, 'fallback');
  assert.equal(g.text, '（確定性版本）');
  assert.ok(!g.text.includes('WHOOP Age'));
});
