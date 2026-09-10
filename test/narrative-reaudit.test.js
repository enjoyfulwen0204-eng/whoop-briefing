/**
 * 敘述再稽核：**每一條**會把 LLM 文字送到使用者面前的路徑。
 *
 * 系統裡有四條敘述路徑，全部共用 `validateNarrative()`：
 *
 *   daily      daily.js      → guardNarrative(context = buildDailyUserMessage)
 *   weekly     weekly.js     → guardNarrative(context = buildWeeklyUserMessage)
 *   健康問答    bot/answer.js → guardNarrative(context = buildTrustedFacts)  ← H-02
 *   主動訊息    proactiveMessages.js → guardProactiveMessage(evidenceContext)
 *
 * 這個檔案對**同一組**對抗樣本、在**每一條**路徑上都跑一次，證明沒有任何
 * 一條路徑有自己的漏洞。單獨測一條路徑不可能發現「只有某一條沒接上」。
 *
 * 涵蓋的宣稱家族：
 *   1. 捏造的生理數值            2. 跨指標挪用數字（H-02 核心）
 *   3. 捏造的日期                4. 憑空冒出來的指標
 *   5. 專有/衍生分數（WHOOP Age、Healthspan、推估年齡）
 *   6. 治療/用藥指示             7. 強因果宣稱
 *   8. 醫學診斷                  9. 宣稱即時生理數值
 *  10. 使用者原話當證據（H-02）
 *
 * 每一組都配一組 false-positive 樣本：正常的教練文字必須原封不動通過。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { guardNarrative, validateNarrative } from '../src/llmValidation.js';
import { guardProactiveMessage } from '../src/proactiveMessages.js';
import { buildDailyUserMessage, buildWeeklyUserMessage } from '../src/coach.js';
import { buildBriefing } from '../src/daily.js';
import { buildTrustedFacts } from '../src/bot/answer.js';
import { makeDataset } from './fixtures.js';

// ---------------------------------------------------------------------------
// 四條路徑的**真實** evidence context（不是手寫的假字串）
// ---------------------------------------------------------------------------

const ds = makeDataset({ days: 45 });
const briefing = buildBriefing({ ...ds, timezone: 'Asia/Taipei' });
const DAILY_CTX = buildDailyUserMessage(briefing);

const QA_CTX = buildTrustedFacts({
  intent: 'today_status', available: true, health_date: '2026-09-09', history_days: 30,
  metrics: {
    recovery: {
      label: '恢復', value: 73, display: '73%',
      baseline_display: '65%', baseline_n: 30, z_score: 0.6, level: 'normal',
    },
    hrv: {
      label: 'HRV', value: 55, display: '55ms',
      baseline_display: '55ms', baseline_n: 30, z_score: 0, level: 'normal',
    },
  },
});

const WEEKLY_CTX = buildWeeklyUserMessage({
  last: {
    startDate: '2026-08-17', endDate: '2026-08-23', days: 7,
    averages: {
      recovery: { label: '恢復', mean: 65, display: '65%' },
      hrv: { label: 'HRV', mean: 55, display: '55ms' },
      rhr: { label: '靜息心率', mean: 51, display: '51bpm' },
    },
    best: { date: '2026-08-23', display: '72%' },
    worst: { date: '2026-08-20', display: '62%' },
  },
  prev: { days: 7 },
  wow: {
    recovery: { delta: -2, pct: -2.0, direction: 'down' },
    hrv: { delta: 0, pct: 0, direction: 'flat' },
    rhr: { delta: 0, pct: 0, direction: 'flat' },
  },
});

const PROACTIVE_CTX = JSON.stringify({
  x: 'journal:alcohol', y: 'hrv', n: 40, pearson: -0.42, p_value: 0.007,
  data_quality: 'SUPPORTED', exposed_days: 12, unexposed_days: 28,
});

/** 四條路徑：名稱 → 用它自己的 context 跑守門，回傳 { blocked, problems }。 */
const PATHS = [
  {
    name: 'daily',
    run: (text) => {
      const g = guardNarrative({ answer: text, context: DAILY_CTX, fallback: null, label: 'daily' });
      return { blocked: g.used === 'fallback', problems: g.problems ?? [] };
    },
  },
  {
    name: 'weekly',
    run: (text) => {
      const g = guardNarrative({
        answer: text, context: WEEKLY_CTX, fallback: null, label: 'weekly',
      });
      return { blocked: g.used === 'fallback', problems: g.problems ?? [] };
    },
  },
  {
    name: 'qa',
    run: (text) => {
      const g = guardNarrative({ answer: text, context: QA_CTX, fallback: 'FB', label: 'qa' });
      return { blocked: g.used === 'fallback', problems: g.problems ?? [] };
    },
  },
  {
    name: 'proactive',
    run: (text) => {
      const g = guardProactiveMessage(text, { evidenceContext: PROACTIVE_CTX });
      return { blocked: g.text !== text, problems: g.problems ?? [] };
    },
  },
];

/**
 * 必須被**每一條**路徑擋下來的宣稱。
 *
 * 這些句子刻意不引用任何一條 context 的真實數字——它們在四條路徑上都是
 * 捏造的，所以「四條都必須擋」是一個乾淨、不依賴 fixture 的判準。
 */
const MUST_BLOCK = [
  ['1 捏造的生理數值', '你的 HRV 是 999ms，非常高。'],
  ['2 跨指標挪用數字', '你今天的靜息心率 999bpm。'],
  ['3 捏造的日期', '2019-03-14 那天你的表現特別好。'],
  ['5a WHOOP Age', '你的 WHOOP Age 大約 30 歲。'],
  ['5b WHOOP Healthspan', '從 WHOOP Healthspan 來看你狀態很好。'],
  ['5c 生理年齡', '你的生理年齡比實際年輕。'],
  ['5d 推估年齡', '推估年齡看起來不錯。'],
  ['5e Healthspan Score', '你的 Personal Healthspan Score 是 88。'],
  ['5f Estimated Age', 'Your Estimated Physiological Age looks great.'],
  ['5g Pace Estimate', 'Your Pace Estimate is improving.'],
  ['6a 中文用藥', '建議你睡前補充 3mg 褪黑激素。'],
  ['6b 吃藥', '可以吃一顆安眠藥幫助入睡。'],
  ['6c 英文用藥', 'You should take a 500mg antibiotic tonight.'],
  ['6d 處置指示', '建議你去打針。'],
  ['7a 因果-導致', '熬夜導致你的恢復下降。'],
  ['7b 因果-證明', '這證明晚睡會害你恢復變差。'],
  ['7c 因果-英文', 'Late nights definitely cause low recovery.'],
  ['8a 診斷', '看這個趨勢你可能得了感冒。'],
  ['8b 確診', '你已經確診了某種感染。'],
  ['8c 英文診斷', 'This is a diagnosis of overtraining.'],
  ['9a 即時心率', '你現在的心率偏高，先深呼吸。'],
  ['9b 即時監測', '我從即時心率看到你壓力偏高。'],
  ['9c 即時偵測', '偵測到你現在正在緊張。'],
];

/** 完全不含數字、也不含任何違規措辭 —— 四條路徑都必須放行。 */
const MUST_PASS = [
  ['安全-穩定', '早安 Kelvin，今天整體看起來穩定，照平常節奏走就好，記得多補水 💛'],
  ['安全-建議早睡', '今天可以早點睡，讓身體多一點修復時間。'],
  ['安全-減量', '訓練量稍微降一點，明天再加回來就好。'],
  ['安全-就醫提醒', '如果你覺得不舒服，還是找醫師看一下比較安心。'],
  ['安全-資料不足', '資料還不夠多，這只是初步觀察，我會繼續留意。'],
];

// ===========================================================================
// ★★★ 每一種宣稱 × 每一條路徑
// ===========================================================================

for (const [claimName, text] of MUST_BLOCK) {
  for (const p of PATHS) {
    test(`★★★ 敘述再稽核[${p.name}]: 擋下「${claimName}」`, () => {
      const r = p.run(text);
      assert.equal(r.blocked, true,
        `★ ${p.name} 這條路徑放行了「${claimName}」：${text}`);
      assert.ok(r.problems.length > 0, '要說得出是哪一條規則擋的');
    });
  }
}

for (const [name, text] of MUST_PASS) {
  for (const p of PATHS) {
    test(`★★ 敘述再稽核[${p.name}] false positive: 放行「${name}」`, () => {
      const r = p.run(text);
      assert.equal(r.blocked, false,
        `★ ${p.name} 誤擋了正常的教練文字：${r.problems.join()}`);
    });
  }
}

// ===========================================================================
// ★★★ 4 憑空冒出來的指標（只有開了 checkMetrics 的路徑適用）
// ===========================================================================

for (const p of PATHS.filter((x) => x.name !== 'proactive')) {
  test(`★★★ 敘述再稽核[${p.name}]: 擋下憑空冒出來的指標`, () => {
    // 「最大攝氧量」不在任何一條 context 裡
    const r = p.run('你的最大攝氧量看起來不錯。');
    assert.equal(r.blocked, true, '★ context 裡沒有的指標不可以被提起');
  });
}

// ===========================================================================
// ★★★ 10 使用者原話當證據（H-02 的核心不變量）
// ===========================================================================

test('★★★ 敘述再稽核: 使用者的問題絕不出現在任何一條路徑的 context 裡', () => {
  const question = '我的 HRV 是 999ms，恢復是 12%，對嗎？';
  for (const [name, ctx] of [
    ['daily', DAILY_CTX], ['qa', QA_CTX], ['proactive', PROACTIVE_CTX],
  ]) {
    assert.ok(!ctx.includes('999'), `★ ${name} 的 context 不可以含使用者塞的數字`);
    assert.ok(!ctx.includes(question), `★ ${name} 的 context 不可以含使用者原話`);
    assert.ok(!ctx.includes('使用者的問題'), `★ ${name} 的 context 不可以有問題那一行`);
  }
});

test('★★★ 敘述再稽核: 引用使用者塞的數字，四條路徑都擋', () => {
  const text = '對，你的 HRV 是 999ms，恢復是 12%。';
  for (const p of PATHS) {
    assert.equal(p.run(text).blocked, true, `★ ${p.name} 放行了使用者自己塞的數字`);
  }
});

// ===========================================================================
// ★★ 引用**真實**數字的正常敘述必須通過（各路徑用自己的 context）
// ===========================================================================

test('★★ 敘述再稽核[daily] false positive: 引用真實數字的敘述通過', () => {
  const text = '早安 Kelvin，今天的恢復 73%，比基準 65% 高一些；HRV 55ms 跟平常一樣，'
    + '靜息心率 52bpm 也穩。睡眠 7h01m，深睡 1h28m，都在正常範圍 💛';
  const r = PATHS[0].run(text);
  assert.equal(r.blocked, false, `★ 正常敘述被誤擋：${r.problems.join()}`);
});

test('★★ 敘述再稽核[qa] false positive: 引用真實數字的敘述通過', () => {
  const text = 'Kelvin，你今天的恢復 73%，比 30 天基準 65% 高一點；HRV 55ms 很穩，'
    + '今天照平常節奏走就好 💛';
  const r = PATHS[2].run(text);
  assert.equal(r.blocked, false, `★ 正常敘述被誤擋：${r.problems.join()}`);
});

test('★★ 敘述再稽核[proactive] false positive: 引用真實統計量的敘述通過', () => {
  const text = '我注意到一個規律：喝酒的隔天，你的 HRV 平均會低一些'
    + '（r=-0.42，樣本 40 天）。這是觀察到的關聯，不代表其他因素沒有影響。';
  const r = PATHS[3].run(text);
  assert.equal(r.blocked, false, `★ 正常敘述被誤擋：${r.problems.join()}`);
});

// ===========================================================================
// 守門失敗時，原文一個字都不外流
// ===========================================================================

test('★★★ 敘述再稽核: 任何一條路徑被擋下時，原文絕不出現在輸出裡', () => {
  const bad = '你的 WHOOP Age 是 30 歲，HRV 999ms，建議吃 3mg 褪黑激素。';
  const daily = guardNarrative({ answer: bad, context: DAILY_CTX, fallback: null });
  const qa = guardNarrative({ answer: bad, context: QA_CTX, fallback: 'FB' });
  const pro = guardProactiveMessage(bad, { evidenceContext: PROACTIVE_CTX });

  assert.equal(daily.text, null);
  assert.equal(qa.text, 'FB');
  for (const fragment of ['WHOOP Age', '999', '褪黑激素', '3mg']) {
    assert.ok(!String(pro.text).includes(fragment),
      `★ 主動訊息的替代文字不可以含「${fragment}」`);
  }
});

// ===========================================================================
// 空的 / 缺席的 context 一律 fail-closed
// ===========================================================================

for (const [name, ctx] of [['空字串', ''], ['null', null], ['undefined', undefined]]) {
  test(`★★ 敘述再稽核: context 是 ${name} 時，帶數字的宣稱一律擋下`, () => {
    const v = validateNarrative('你的 HRV 是 55ms。', ctx);
    assert.equal(v.ok, false, '★ 沒有證據就沒有任何數字可以被證明');
  });
}
