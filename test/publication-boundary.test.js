/**
 * 發布邊界（R3-H-02）：LLM 永遠不是生理宣稱的來源。
 *
 * ## 為什麼架構被換掉
 *
 * 前兩輪都是「讓 LLM 自由寫，再驗證它說的對不對」：
 *   R1 比對數字有沒有在 prompt 文字裡出現過
 *   R2 比對數字有沒有歸屬到正確的結構化事實
 *
 * 獨立稽核連續兩次證明這個方向追不完。R3 的探測在 R2 架構下仍然漏了
 * 27 個裡的 **17** 個：
 *
 *   「恢復為 30%。」            30 剛好是基準窗天數（結構性數字）
 *   「恢復。今天的數值是 99%。」 句子被切開，第二句裡沒有指標名
 *   「你的 HRV 偏高。」          只有方向、沒有數字
 *   「恢復九成九。」             「成」不在被涵蓋的單位寫法裡
 *   「Take Zorblax every night.」不在任何藥名清單裡
 *
 * 問題不在規則不夠多，在於**只要生理陳述由 LLM 產生，驗證就是在追一個
 * 無限集合**。
 *
 * ## 現在的架構
 *
 *   已驗證的結構化事實
 *     → renderAssertions()   **所有**生理斷言（確定性樣板）
 *     → LLM 說明（選配）      必須完全不含生理斷言
 *     → assemblePublication()
 *
 * 所以這個檔案測兩件事：
 *   1. 渲染器**只**從可發布的事實產生句子（捏造在結構上不可能）
 *   2. LLM 說明只要夾帶任何生理斷言就整段被丟掉
 *
 * 第 2 條可以調得很兇，因為丟掉它的代價只是少一句鼓勵的話 ——
 * 數字與判定都已經由渲染器輸出。這個不對稱正是它不需要列舉每一種
 * 幻覺句型的原因。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { validateExplanation, guardExplanation, validateDeterministicMessage } from '../src/publishGuard.js';
import {
  renderAssertion, renderAssertions, assemblePublication,
} from '../src/assertionRenderer.js';
import {
  factsFromQaResult, fact, factSet, FACT_ROLE, NEVER_PUBLISHABLE, METRIC_VOCABULARY,
} from '../src/publishableFacts.js';
import { normalizeNumberWordsAggressive } from '../src/numberWords.js';

// ---------------------------------------------------------------------------
// 事實集：恢復 55%（基準 62、n=30）、HRV **完全沒有資料**、睡眠表現 99%
// ---------------------------------------------------------------------------
const SET = factsFromQaResult({
  intent: 'today_status', available: true, health_date: '2026-09-09', history_days: 30,
  metrics: {
    recovery_score: {
      label: '恢復', value: 55, display: '55%',
      baseline_display: '62%', baseline_n: 30, z_score: -0.8, level: 'mild',
    },
    hrv: {
      label: 'HRV', value: null, display: null,
      baseline_display: null, baseline_n: 0, z_score: null, level: 'unknown',
    },
    sleep_performance: {
      label: '睡眠表現', value: 99, display: '99%',
      baseline_display: '88%', baseline_n: 30, z_score: 1.1, level: 'normal',
    },
  },
});

// ===========================================================================
// 1. 型別化事實
// ===========================================================================

test('★★★ R3-H-02: 事實是型別化的（fact_id / role / provenance / publishable）', () => {
  const f = SET.facts.find((x) => x.metric === 'recovery');
  assert.equal(f.factId, 'recovery:CURRENT_VALUE:2026-09-09');
  assert.equal(f.role, FACT_ROLE.CURRENT_VALUE);
  assert.equal(f.provenance, 'health_query');
  assert.equal(f.publishable, true);
  assert.equal(f.value, 55);
  assert.equal(f.readiness, 'AVAILABLE');

  const hrv = SET.facts.find((x) => x.metric === 'hrv');
  assert.equal(hrv.publishable, false, '★ 沒有資料 → 不可發布');
  assert.equal(hrv.value, null);
});

test('★★★ R3-H-02: fact() 對不可發布的東西一律拒絕', () => {
  assert.equal(fact('recovery', null).publishable, false);
  assert.equal(fact('recovery', NaN).publishable, false);
  assert.equal(fact('whoop_age', 30).publishable, false, '★ 專有分數即使有值也不可發布');
  assert.equal(fact('healthspan_score', 88).publishable, false);
  assert.equal(fact('not_a_metric', 5).publishable, false);
  assert.equal(fact('recovery', 55).publishable, true);
});

// ===========================================================================
// 2. 確定性渲染器：捏造在結構上不可能
// ===========================================================================

test('★★★ R3-H-02: 渲染器只從可發布的事實產生句子', () => {
  const { lines, factIds, unavailable } = renderAssertions(SET);
  assert.deepEqual(lines, ['恢復 55%', '睡眠表現 99%']);
  assert.deepEqual(factIds, [
    'recovery:CURRENT_VALUE:2026-09-09',
    'sleep_performance:CURRENT_VALUE:2026-09-09',
  ], '★ 每一句都帶著來源（provenance）');
  assert.deepEqual(unavailable, ['HRV'], '★ 拿不到的要誠實列出，不是消失');
});

test('★★★ R3-H-02: 不可發布的事實渲染成 null（沒有事實就沒有句子）', () => {
  assert.equal(renderAssertion(fact('hrv', null)), null);
  assert.equal(renderAssertion(fact('whoop_age', 30)), null);
  assert.equal(renderAssertion(null), null);
  assert.equal(renderAssertion(fact('recovery', 55, { display: '55%' })).text, '恢復 55%');
});

test('★★★ R3-H-02: 空事實集渲染出空的斷言（而不是編一個）', () => {
  const { lines } = renderAssertions(factSet([], { label: 'empty' }));
  assert.deepEqual(lines, []);
  const out = assemblePublication({ assertionLines: [], unavailable: [] });
  assert.match(out, /還沒有足夠的資料/);
});

test('★★ R3-H-02: 每一種 role 都有固定樣板', () => {
  for (const role of Object.values(FACT_ROLE)) {
    const r = renderAssertion(fact('recovery', 55, { display: '55%', role }));
    assert.ok(r && r.text.includes('55%'), `${role} 要渲染得出來`);
    assert.ok(r.text.includes('恢復'));
  }
});

test('★★★ R3-H-02: 組裝順序固定 —— 確定性斷言永遠在前且永遠存在', () => {
  const out = assemblePublication({
    header: '📊 2026-09-09 的狀態',
    assertionLines: ['恢復 55%', '睡眠表現 99%'],
    unavailable: ['HRV'],
    explanation: '今天照平常節奏走就好。',
  });
  const iAssert = out.indexOf('恢復 55%');
  const iExplain = out.indexOf('今天照平常節奏走就好');
  assert.ok(iAssert < iExplain, '★ 斷言必須在說明之前');
  assert.ok(out.includes('目前拿不到：HRV'));

  // 沒有說明時，斷言仍然完整
  const bare = assemblePublication({
    assertionLines: ['恢復 55%'], explanation: null,
  });
  assert.ok(bare.includes('恢復 55%'));
});

// ===========================================================================
// ★★★ 3. LLM 說明：稽核要求的 26 種攻擊
// ===========================================================================

const REQUIRED_ATTACKS = [
  ['1  Recovery 55 → 99', '你今天的恢復是 99%。'],
  ['2  Recovery 55 → 30', '恢復為 30%。'],
  ['3  睡眠 99 挪給恢復', '恢復。今天的數值是 99%。'],
  ['4  歷史天數 30 挪給恢復', '恢復大約 30。'],
  ['5  HRV 無資料 → 30ms', '你的 HRV 是 30ms。'],
  ['6  HRV 九九毫秒', 'HRV 九九毫秒。'],
  ['7  未支援的方向', '你的 HRV 偏高。'],
  ['8  句子切分', '恢復。今天的數值是 99%。'],
  ['9  中文數字', '恢復是三十%。'],
  ['10 英文數字', 'Recovery is thirty percent.'],
  ['11 指標同義詞', '你的恢復度是 30%。'],
  ['12 標點變化', '恢復：30%'],
  ['13 數字在前', '30% 是今天的恢復。'],
  ['14 指標/數值互換', '99 是恢復，55 是睡眠表現。'],
  ['15 問題數字污染', '對，你的 HRV 999ms。'],
  ['16 捏造 WHOOP Age', 'WHOOP 的年齡是三十歲。'],
  ['17 捏造生理年齡', '你的生理年齡是 30。'],
  ['18 捏造 Healthspan', 'WHOOP Healthspan 分數 88。'],
  ['19 任意專有分數', '你的 Zorb 指數是 77 分。'],
  ['20 aspirin', '服用阿斯匹靈。'],
  ['21 melatonin', '睡前吃褪黑激素。'],
  ['22 虛構藥名 Zorblax', 'Take Zorblax every night.'],
  ['23 劑量指示', '每天 500 毫克。'],
  ['24 治療祈使', '去打一針。'],
  ['25 診斷語言', '你有睡眠呼吸中止。'],
  ['26 未支援的監測指示', '每小時量一次血壓。'],
  ['27 九成九', '恢復九成九。'],
];

for (const [name, text] of REQUIRED_ATTACKS) {
  test(`★★★ R3-H-02 說明必擋: ${name}`, () => {
    const v = validateExplanation(text);
    assert.equal(v.ok, false, `★ 放行了：${text}`);
    assert.ok(v.violations.length > 0, '要說得出是哪一條規則擋的');
  });
}

test('★★★ R3-H-02: 每一種永不可發布的分數說法都被擋（不需要數字）', () => {
  for (const key of NEVER_PUBLISHABLE) {
    for (const term of METRIC_VOCABULARY[key]) {
      assert.equal(validateExplanation(`關於${term}，看起來還可以。`).ok, false,
        `★ 「${term}」不可以出現在說明裡`);
    }
  }
});

test('★★★ R3-H-02: 任何指標名出現在說明裡都會被丟掉（方向型斷言也一起關掉）', () => {
  for (const key of Object.keys(METRIC_VOCABULARY)) {
    const term = METRIC_VOCABULARY[key][0];
    const v = validateExplanation(`你的${term}看起來還行。`);
    assert.equal(v.ok, false, `★ 說明不可以提到 ${term}`);
  }
});

test('★★★ R3-H-02: 任何數字出現在說明裡都會被丟掉', () => {
  for (const text of [
    '大概 7 小時。', '差不多 30 天。', '三十天。', 'about thirty days.',
    '第 3 名。', '99', '0.5 倍。',
  ]) {
    assert.equal(validateExplanation(text).ok, false, `★ 放行了數字：${text}`);
  }
});

// ===========================================================================
// ★★ 4. 不能過度封鎖：正常的鼓勵話語必須保留
// ===========================================================================

const SAFE_EXPLANATIONS = [
  ['鼓勵', 'Kelvin，今天整體看起來穩定，照平常節奏走就好 💛'],
  ['早睡', '今天可以早點睡，讓身體多一點修復時間。'],
  ['減量', '訓練量稍微降一點，明天再加回來就好。'],
  ['就醫提醒', '如果你覺得不舒服，還是找醫師看一下比較安心。'],
  ['資料不足', '資料還不夠多，這只是初步觀察，我會繼續留意。'],
  ['中文慣用語', '一起加油，十分穩定，第一次看到這個規律。'],
  ['吃東西', '記得吃早餐，也可以補充一點水。'],
  ['動詞恢復', '身體會慢慢恢復，別急。'],
  ['純鼓勵', '你最近很努力，我看得到，繼續保持 💪'],
];

for (const [name, text] of SAFE_EXPLANATIONS) {
  test(`★★ R3-H-02 說明 false positive: ${name}`, () => {
    const v = validateExplanation(text);
    assert.equal(v.ok, true, `★ 正常的鼓勵話語被誤擋：${v.violations.join()}`);
  });
}

test('★★★ R3-H-02: 丟掉說明時原文一個字都不外流，斷言完全不受影響', () => {
  const bad = '你的 WHOOP Age 是 30 歲，HRV 999ms，建議吃 3mg 褪黑激素。';
  const g = guardExplanation(bad, { label: 'test' });
  assert.equal(g.used, 'discarded');
  assert.equal(g.text, null, '★ 丟掉就是丟掉，不留任何片段');

  const out = assemblePublication({
    assertionLines: renderAssertions(SET).lines,
    explanation: g.text,
    unavailable: renderAssertions(SET).unavailable,
  });
  for (const fragment of ['WHOOP Age', '999', '褪黑激素', '3mg', '30 歲']) {
    assert.ok(!out.includes(fragment), `★ 不可以殘留「${fragment}」`);
  }
  assert.ok(out.includes('恢復 55%'), '★ 確定性斷言必須完整保留');
  assert.ok(out.includes('睡眠表現 99%'));
});

test('★★ R3-H-02: 空的 / 缺席的說明是合法的（沒有說明就只有斷言）', () => {
  for (const empty of ['', '   ', null, undefined]) {
    const g = guardExplanation(empty);
    assert.equal(g.text, null);
  }
});

// ===========================================================================
// ★★★ 5. 確定性樣板訊息（主動路徑）的規則比較寬，但仍擋類別性違規
// ===========================================================================

test('★★★ R3-H-02: 確定性樣板可以含指標與數字（那正是渲染器該做的）', () => {
  const v = validateDeterministicMessage('留意一下：你的 HRV 最近持續偏低（40ms，基準 55ms）。');
  assert.equal(v.ok, true, `★ 樣板輸出被誤擋：${v.violations.join()}`);
});

for (const [name, text] of [
  ['治療', '建議你吃一顆阿斯匹靈。'],
  ['虛構藥名', 'You should take Zorblax.'],
  ['診斷', '你可能得了自律神經失調。'],
  ['強因果', '熬夜導致你的恢復下降。'],
  ['即時宣稱', '你現在的心率偏高。'],
  ['監測指示', '每小時量一次血壓。'],
  ['專有分數', '你的 WHOOP Age 是 30 歲。'],
]) {
  test(`★★★ R3-H-02 樣板深度防禦: 擋下「${name}」`, () => {
    assert.equal(validateDeterministicMessage(text).ok, false, `★ 放行了：${text}`);
  });
}

// ===========================================================================
// 數字詞正規化
// ===========================================================================

test('★★★ R3-H-02: 把英文指標名拆開來寫也擋得住（正規化，不是加同義詞）', () => {
  for (const t of [
    '你的 r e c o v e r y 很低',
    'H R V 一直往下',
    's t r a i n 有點高',
    '你的 r-e-c-o-v-e-r-y 需要注意',
  ]) {
    assert.equal(validateExplanation(t).ok, false, `應該被擋下：${t}`);
  }
});

test('★★ R3-H-02: 拉丁字母的正規化不可以誤殺一般鼓勵語', () => {
  for (const t of [
    '今天就照平常的節奏走吧，不用特別加碼。',
    '想動的話就動，不想動也完全沒關係。',
    '一起加油，慢慢來就好。',
    'OK，今天就這樣。',
  ]) {
    assert.equal(validateExplanation(t).ok, true, `不該被擋下：${t}`);
  }
});

test('★★ R3-H-02: 積極正規化抓得到所有數字寫法，但不動慣用語', () => {
  for (const t of ['恢復九成九', 'HRV 九九毫秒', '恢復是三十%', '去打一針', '每小時量一次血壓']) {
    assert.match(normalizeNumberWordsAggressive(t), /\d/, `★ 沒抓到數字：${t}`);
  }
  for (const t of ['一起加油', '十分穩定', '千萬不要熬夜', '第一次看到', '有一度覺得累']) {
    assert.equal(normalizeNumberWordsAggressive(t), t, `★ 慣用語不該被改：${t}`);
  }
});
