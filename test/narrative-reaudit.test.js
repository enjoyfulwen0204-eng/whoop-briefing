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

import { guardPublication, validatePublication } from '../src/publishGuard.js';
import { guardProactiveMessage } from '../src/proactiveMessages.js';
import { buildBriefing } from '../src/daily.js';
import {
  factsFromBriefing, factsFromWeekly, factsFromQaResult, factsFromProactive,
} from '../src/publishableFacts.js';
import { makeDataset } from './fixtures.js';

// ---------------------------------------------------------------------------
// 四條路徑的**真實** evidence context（不是手寫的假字串）
// ---------------------------------------------------------------------------

const ds = makeDataset({ days: 45 });
const briefing = buildBriefing({ ...ds, timezone: 'Asia/Taipei' });
const DAILY_FACTS = factsFromBriefing(briefing);

const WEEKLY_FACTS = factsFromWeekly({
  last: {
    startDate: '2026-08-17', endDate: '2026-08-23', days: 7,
    averages: {
      recovery_score: { label: '恢復', mean: 65, display: '65%' },
      hrv: { label: 'HRV', mean: 55, display: '55ms' },
      rhr: { label: '靜息心率', mean: 51, display: '51bpm' },
    },
    best: { date: '2026-08-23', display: '72%' },
    worst: { date: '2026-08-20', display: '62%' },
  },
  prev: { days: 7 },
  wow: {
    recovery_score: { delta: -2, pct: -2.0, direction: 'down' },
    hrv: { delta: 0, pct: 0, direction: 'flat' },
    rhr: { delta: 0, pct: 0, direction: 'flat' },
  },
});

const QA_FACTS = factsFromQaResult({
  intent: 'today_status', available: true, health_date: '2026-09-09', history_days: 30,
  metrics: {
    recovery_score: {
      label: '恢復', value: 73, display: '73%',
      baseline_display: '65%', baseline_n: 30, z_score: 0.6, level: 'normal',
    },
    hrv: {
      label: 'HRV', value: 55, display: '55ms',
      baseline_display: '55ms', baseline_n: 30, z_score: 0, level: 'normal',
    },
  },
});

const PROACTIVE_FACTS = factsFromProactive({
  signal: {
    metric: 'hrv', current: 40, baseline_mean: 55, baseline_n: 30,
    z_score: -2.1, health_date: '2026-09-09',
  },
  association: {
    metric: 'hrv', n: 40, pearson: -0.42, p_value: 0.007,
    exposed_days: 12, unexposed_days: 28, lag_days: 1,
  },
});

/** 四條路徑：名稱 → 用它自己的事實集跑發布邊界。 */
const PATHS = [
  {
    name: 'daily',
    run: (text) => {
      const g = guardPublication({
        narrative: text, factSet: DAILY_FACTS, fallback: null, label: 'daily',
      });
      return { blocked: g.used === 'fallback', problems: g.violations ?? [] };
    },
  },
  {
    name: 'weekly',
    run: (text) => {
      const g = guardPublication({
        narrative: text, factSet: WEEKLY_FACTS, fallback: null, label: 'weekly',
      });
      return { blocked: g.used === 'fallback', problems: g.violations ?? [] };
    },
  },
  {
    name: 'qa',
    run: (text) => {
      const g = guardPublication({
        narrative: text, factSet: QA_FACTS, fallback: 'FB', label: 'qa',
      });
      return { blocked: g.used === 'fallback', problems: g.violations ?? [] };
    },
  },
  {
    name: 'proactive',
    run: (text) => {
      const g = guardProactiveMessage(text, { factSet: PROACTIVE_FACTS });
      return { blocked: g.text !== text, problems: g.violations ?? [] };
    },
  },
];

/**
 * 必須被**每一條**路徑擋下來的宣稱。
 *
 * 這些句子刻意不引用任何一條事實集的真實數字 —— 它們在四條路徑上都是
 * 捏造的，所以「四條都必須擋」是一個乾淨、不依賴 fixture 的判準。
 *
 * 這份清單同時涵蓋 R2 稽核明確要求的攻擊，以及它們的**改寫**：
 * 逗號斷開、數字前置、英文指標名、中文／英文數字詞、專有分數的各種說法。
 */
const MUST_BLOCK = [
  ['1a 捏造的生理數值', '你的 HRV 是 999ms，非常高。'],
  ['1b 捏造（逗號斷開）', '今天的 HRV，999ms，非常高。'],
  ['1c 捏造（數字前置）', '999ms 的 HRV，非常高。'],
  ['1d 捏造（英文）', 'Your HRV is 999 milliseconds.'],
  ['1e 捏造（中文數字）', '你的靜息心率是九十九 bpm。'],
  ['2a 跨指標挪用', '你今天的靜息心率 999bpm。'],
  ['2b 恢復 999', '你的恢復 999%。'],
  ['3  捏造的日期', '2019-03-14 那天你的表現特別好。'],
  ['5a WHOOP Age', '你的 WHOOP Age 大約 30 歲。'],
  ['5b WHOOP Healthspan', '從 WHOOP Healthspan 來看你狀態很好。'],
  ['5c 生理年齡', '你的生理年齡比實際年輕。'],
  ['5d 推估年齡', '推估年齡看起來不錯。'],
  ['5e Healthspan Score', '你的 Personal Healthspan Score 是 88。'],
  ['5f Estimated Age', 'Your Estimated Physiological Age looks great.'],
  ['5g Pace Estimate', 'Your Pace Estimate is improving.'],
  ['5h 身體年紀（改寫）', '你的身體年紀大概 30 歲。'],
  ['5i 健康壽命指數（改寫）', '你的健康壽命指數是 88 分。'],
  ['6a 中文用藥', '建議你睡前補充 3mg 褪黑激素。'],
  ['6b 吃藥', '可以吃一顆安眠藥幫助入睡。'],
  ['6c 英文用藥', 'You should take a 500mg antibiotic tonight.'],
  ['6d 處置指示', '建議你去打針。'],
  ['6e 阿斯匹靈（清單外）', '建議你吃一顆阿斯匹靈。'],
  ['6f aspirin（清單外）', 'You should take an aspirin.'],
  ['7a 因果-導致', '熬夜導致你的恢復下降。'],
  ['7b 因果-證明', '這證明晚睡會害你恢復變差。'],
  ['7c 因果-英文', 'Late nights definitely cause low recovery.'],
  ['8a 診斷', '看這個趨勢你可能得了感冒。'],
  ['8b 確診', '你已經確診了某種感染。'],
  ['8c 英文診斷', 'This is a diagnosis of overtraining.'],
  ['8d 病名標籤（改寫）', '這個模式看起來是過度訓練症候群。'],
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
  ['安全-中文慣用語', '一起加油，第一次看到這個規律，十分穩定，兩三天內會恢復。'],
  ['安全-吃東西', '記得吃早餐，也可以補充一點水。'],
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

for (const p of PATHS) {
  test(`★★★ 敘述再稽核[${p.name}]: 擋下憑空冒出來的指標`, () => {
    // 「最大攝氧量」不在任何一條路徑的事實集裡
    const r = p.run('你的最大攝氧量看起來不錯。');
    assert.equal(r.blocked, true, '★ 事實集裡沒有的指標不可以被提起');
  });
}

// ===========================================================================
// ★★★ 10 使用者原話當證據（H-02 的核心不變量）
// ===========================================================================

test('★★★ 敘述再稽核: 事實集是結構化的，使用者原話沒有任何進入管道', () => {
  const question = '我的 HRV 是 999ms，恢復是 12%，對嗎？';
  for (const [name, set] of [
    ['daily', DAILY_FACTS], ['weekly', WEEKLY_FACTS],
    ['qa', QA_FACTS], ['proactive', PROACTIVE_FACTS],
  ]) {
    const serialized = JSON.stringify(set);
    assert.ok(!serialized.includes('999'), `★ ${name} 的事實集不可以含使用者塞的數字`);
    assert.ok(!serialized.includes(question), `★ ${name} 的事實集不可以含使用者原話`);
    // 事實集只有結構化欄位，沒有任何自由文字容器
    for (const f of set.facts) {
      assert.deepEqual(
        Object.keys(f).sort(),
        ['allowsStructural', 'display', 'healthDate', 'labels', 'metric', 'publishable',
          'readiness', 'supporting', 'unit', 'value', 'windowDays'].sort(),
        '★ 事實的形狀必須是封閉的',
      );
    }
  }
});

test('★★★ 敘述再稽核: 引用使用者塞的數字，四條路徑都擋', () => {
  const text = '對，你的 HRV 是 999ms，恢復是 12%。';
  for (const p of PATHS) {
    assert.equal(p.run(text).blocked, true, `★ ${p.name} 放行了使用者自己塞的數字`);
  }
});

// ===========================================================================
// ★★ 引用**真實**數字的正常敘述必須通過（各路徑用自己的事實集）
// ===========================================================================

test('★★ 敘述再稽核[daily] false positive: 引用真實數字的敘述通過', () => {
  const text = '早安 Kelvin，今天的恢復 73%，比基準 65% 高一些；HRV 55ms 跟平常一樣，'
    + '靜息心率 52bpm 也穩。睡眠 7h01m，深睡 1h28m，都在正常範圍 💛';
  const r = PATHS[0].run(text);
  assert.equal(r.blocked, false, `★ 正常敘述被誤擋：${r.problems.join()}`);
});

test('★★ 敘述再稽核[weekly] false positive: 引用真實數字的敘述通過', () => {
  const text = '上週恢復平均 65%，比前週低 2%；HRV 55ms 與前週差不多，'
    + '靜息心率 51bpm 也穩定。最好的一天是 8/23，恢復 72%。';
  const r = PATHS[1].run(text);
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
  const daily = guardPublication({ narrative: bad, factSet: DAILY_FACTS, fallback: null });
  const qa = guardPublication({ narrative: bad, factSet: QA_FACTS, fallback: 'FB' });
  const pro = guardProactiveMessage(bad, { factSet: PROACTIVE_FACTS });

  assert.equal(daily.text, null);
  assert.equal(qa.text, 'FB');
  for (const fragment of ['WHOOP Age', '999', '褪黑激素', '3mg']) {
    assert.ok(!String(pro.text).includes(fragment),
      `★ 主動訊息的替代文字不可以含「${fragment}」`);
  }
});

// ===========================================================================
// 空的 / 缺席的事實集一律 fail-closed
// ===========================================================================

for (const [name, set] of [
  ['null', null], ['undefined', undefined],
  ['空事實集', { label: 'x', facts: [], structural: [] }],
]) {
  test(`★★ 敘述再稽核: 事實集是 ${name} 時，帶數字的宣稱一律擋下`, () => {
    const v = validatePublication('你的 HRV 是 55ms。', set);
    assert.equal(v.ok, false, '★ 沒有事實就沒有任何數字可以被發布');
  });
}
