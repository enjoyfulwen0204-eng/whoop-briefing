/**
 * 結構化事實 → 敘述 的發布邊界（R2-H-02）。
 *
 * ## 不變量
 *
 *   **LLM 不是生理事實的權威。**
 *   被發布的生理宣稱一律來自已驗證的結構化事實。
 *
 * ## 為什麼上一輪的做法不夠
 *
 * 上一輪問的是「這個數字在 evidence context 這段**文字**裡出現過嗎」，
 * 歸屬靠「數字有沒有緊貼指標名」。兩者都在列舉措辭，所以獨立稽核用改寫
 * 就繞過了 13/22：
 *
 *   逗號斷開鄰接、數字前置、英文指標名、中文數字詞、
 *   WHOOP Age 的各種改寫、阿斯匹靈（不在藥名清單裡）、病名改寫……
 *
 * ## 現在的判準
 *
 * R1 數字閉合    敘述裡每一個數字都要歸屬到一筆事實的值／支援值／結構性數字
 * R2 指標歸屬    數字歸給句子裡**它前面最近**的指標，該指標必須允許這個數字
 * R3 封閉詞彙表  提到這次沒算出來的指標 → 違規；提到永不可發布的衍生分數
 *                （WHOOP Age / Healthspan）→ 光提起就違規
 * R4 語言規則    因果／診斷／即時宣稱／治療用藥（非數值的類別宣稱）
 *
 * 關鍵性質：R1–R3 **不依賴列舉句子**。它們依賴「這次算出了哪些事實」，
 * 而那是我們自己產生的、有限的、確定性的清單。所以改寫、換語言、換標點、
 * 換語序都不會改變結果。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { validatePublication, guardPublication } from '../src/publishGuard.js';
import {
  factsFromQaResult, factsFromBriefing, factsFromWeekly, factsFromProactive,
  fact, factSet, NEVER_PUBLISHABLE, METRIC_VOCABULARY,
} from '../src/publishableFacts.js';
import { normalizeNumberWords, parseChineseNumber, parseEnglishNumber } from '../src/numberWords.js';

// ---------------------------------------------------------------------------
// 基準事實集：恢復 55%（基準 62、n=30）、HRV **完全沒有資料**、睡眠表現 99%
//
// 「HRV 沒有資料」與「睡眠表現 99%」是刻意的：前者測「不可用的指標不能被
// 給任何值」，後者測「別的指標的真實值不能被挪用」。
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

const blocked = (text, set = SET) => {
  const v = validatePublication(text, set);
  return { ok: v.ok, violations: v.violations };
};

// ===========================================================================
// 前置：事實集的形狀
// ===========================================================================

test('前置：事實集正確標記哪些指標可發布', () => {
  const byMetric = new Map(SET.facts.map((f) => [f.metric, f]));
  assert.equal(byMetric.get('recovery').publishable, true);
  assert.equal(byMetric.get('recovery').value, 55);
  assert.equal(byMetric.get('hrv').publishable, false, '★ 沒有資料的指標不可發布');
  assert.equal(byMetric.get('hrv').value, null);
  assert.equal(byMetric.get('sleep_performance').value, 99);
});

test('前置：事實集裡沒有任何自由文字容器（使用者原話沒有進入管道）', () => {
  for (const f of SET.facts) {
    for (const [k, v] of Object.entries(f)) {
      if (k === 'labels' || k === 'metric' || k === 'unit'
          || k === 'display' || k === 'healthDate' || k === 'readiness') continue;
      assert.ok(typeof v !== 'string' || v.length < 40,
        `★ ${k} 不可以是長字串（那會變成夾帶原話的管道）`);
    }
  }
});

// ===========================================================================
// ★★★ R2 稽核明確要求的攻擊
// ===========================================================================

const REQUIRED_ATTACKS = [
  ['恢復 55 → 宣稱 99', '你今天的恢復是 99%。'],
  ['HRV 無資料 → 宣稱 30ms', '你的 HRV 是 30ms，偏低。'],
  ['使用者問題含 999 → 宣稱 HRV 999', '對，你的 HRV 999ms 確實偏高。'],
  ['恢復 999', '你的恢復 999%。'],
  ['捏造 WHOOP Age', '你的 WHOOP Age 是 30 歲。'],
  ['捏造 Healthspan', '你的 Healthspan 分數是 88。'],
  ['aspirin', 'You should take an aspirin.'],
  ['阿斯匹靈', '建議你吃一顆阿斯匹靈。'],
  ['褪黑激素', '睡前補充 3mg 褪黑激素。'],
  ['劑量指示', 'Take 100 mg of aspirin tonight.'],
  ['診斷語言', '根據數據你可能得了自律神經失調。'],
];

for (const [name, text] of REQUIRED_ATTACKS) {
  test(`★★★ R2-H-02 必擋: ${name}`, () => {
    const r = blocked(text);
    assert.equal(r.ok, false, `★ 放行了：${text}`);
    assert.ok(r.violations.length > 0, '要說得出是哪一條規則擋的');
  });
}

// ===========================================================================
// ★★★ 改寫不可以繞過（這是判準「不依賴列舉」的證明）
// ===========================================================================

const PARAPHRASES = [
  ['逗號斷開鄰接', '今天的恢復，99%，很不錯。'],
  ['數字前置', '99% 的恢復，狀態很好。'],
  ['英文指標名', 'Your Recovery is 99% today.'],
  ['英文完整句', 'Recovery came in at 99 percent this morning.'],
  ['中文數字詞', '你今天的恢復是九十九%。'],
  ['英文數字詞', 'Your recovery is ninety nine percent.'],
  ['省略單位', '你的恢復 99。'],
  ['子句重排', '睡眠表現不錯；恢復同樣是 99%。'],
  ['換句話說', '恢復方面，數字落在 99 這個位置。'],
  ['全形標點', '你的恢復：９９％。'.replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0))],
  ['HRV 英文數字詞', 'HRV came in at thirty milliseconds.'],
  ['HRV 中文數字詞', '你的 HRV 大約三十毫秒。'],
  ['身體年紀（WHOOP Age 改寫）', '你的身體年紀大概 30 歲。'],
  ['估算年齡（WHOOP Age 改寫）', 'WHOOP 估算的年齡是三十。'],
  ['健康壽命指數（Healthspan 改寫）', '你的健康壽命指數是 88 分。'],
  ['fitness age（英文改寫）', 'Your fitness age looks younger than expected.'],
  ['病名標籤改寫', '這個模式看起來是過度訓練症候群。'],
  ['英文 syndrome', 'This looks like overtraining syndrome.'],
  ['處置文法（清單外藥名）', '建議你吃一顆普拿疼。'],
  ['英文處置（清單外）', 'You should take some ibuprofen.'],
];

for (const [name, text] of PARAPHRASES) {
  test(`★★★ R2-H-02 改寫不可繞過: ${name}`, () => {
    const r = blocked(text);
    assert.equal(r.ok, false, `★ 改寫繞過了判準：${text}`);
  });
}

// ===========================================================================
// ★★★ R1 數字閉合：句子裡沒有指標名時的兜底
// ===========================================================================
//
// 這一條是最後一道防線：一個句子裡完全沒有指標名，但有一個數字。
// 那個數字仍然必須歸屬到某一筆事實或結構性數字，否則就是憑空冒出來的。
//
// 沒有這一條，「你昨晚睡了 7 小時」會整句通過 —— 因為「睡了」不是指標詞
// （「睡眠」才是），所以 R2 的歸屬與 R3 的詞彙表都不會被觸發。

for (const [name, text, expected] of [
  ['睡眠時長憑空（沒有指標詞）', '你昨晚睡了 7 小時。', 7],
  ['步數憑空（「步」不是指標詞）', '你今天走了 8000 步。', 8000],
  ['純數字', '這個數字是 4242。', 4242],
  ['時數憑空', '昨天大概 12 個小時都在坐著。', 12],
  ['分數憑空', '你的分數是 77。', 77],
]) {
  test(`★★★ R2-H-02 數字閉合: ${name} → 擋下`, () => {
    const r = blocked(text);
    assert.equal(r.ok, false, `★ 放行了無法歸屬的數字：${text}`);
    assert.ok(r.violations.includes(`unattributable_number:${expected}`),
      `★ 要標成 unattributable_number，實際：${r.violations.join()}`);
  });
}

test('★★ R2-H-02 數字閉合: 結構性數字（日期、樣本數、z 值）不受影響', () => {
  // 30 是 baseline_n、-0.80 是 z 值——都是確定性層算出來的
  assert.equal(blocked('過去 30 天的樣本裡，z 值是 -0.80。').ok, true);
});

test('★★ R2-H-02 數字閉合: 沒有數字的句子完全不受這一條影響', () => {
  assert.equal(blocked('今天整體看起來穩定，照平常節奏走就好。').ok, true);
});

// ===========================================================================
// ★★★ 不可用的指標：任何數字都不行
// ===========================================================================

test('★★★ R2-H-02: 沒有資料的指標不可以被給任何數值（連結構性數字也不行）', () => {
  // 30 剛好是基準窗天數（結構性數字）——上一輪就是這樣漏掉的
  assert.equal(blocked('你的 HRV 是 30ms。').ok, false);
  assert.equal(blocked('你的 HRV 是 55ms。').ok, false, '★ 別的指標的真實值也不行');
  assert.equal(blocked('你的 HRV 是 62ms。').ok, false, '★ 恢復的基準值也不行');
});

test('★★ R2-H-02: 沒有資料的指標可以被**誠實地**提起（不給數值）', () => {
  const r = blocked('HRV 今天拿不到資料，所以我只能就恢復跟睡眠表現跟你說。');
  assert.equal(r.ok, true, `★ 誠實說沒資料不可以被誤擋：${r.violations.join()}`);
});

// ===========================================================================
// ★★★ 跨指標挪用
// ===========================================================================

test('★★★ R2-H-02: 每一個真實值都只屬於它自己的指標', () => {
  // 55 是恢復的、99 是睡眠表現的、62 是恢復的基準
  assert.equal(blocked('你的恢復 55%。').ok, true, '★ 自己的值可以');
  assert.equal(blocked('你的睡眠表現 99%。').ok, true);
  assert.equal(blocked('你的恢復 99%。').ok, false, '★ 挪用睡眠表現的值 → 擋');
  assert.equal(blocked('你的睡眠表現 55%。').ok, false, '★ 挪用恢復的值 → 擋');
});

test('★★★ R2-H-02: 歸屬取「數字前面最近」的指標，不是字元距離最近', () => {
  // 62 是恢復的基準；如果只比距離會被歸給後面的睡眠表現而誤判
  const text = '恢復 55%，比 30 天基準 62% 低一點；睡眠表現 99% 很漂亮。';
  const r = blocked(text);
  assert.equal(r.ok, true, `★ 正常敘述被誤擋：${r.violations.join()}`);
});

// ===========================================================================
// ★★★ 永不可發布的衍生分數：光提起就違規
// ===========================================================================

test('★★★ R2-H-02: WHOOP Age / Healthspan 的每一種說法都被擋（不需要數字）', () => {
  for (const key of NEVER_PUBLISHABLE) {
    for (const term of METRIC_VOCABULARY[key]) {
      const r = blocked(`關於${term}，看起來還可以。`);
      assert.equal(r.ok, false, `★ 「${term}」不可以被提起`);
      assert.ok(r.violations.some((v) => v.startsWith('forbidden_metric')),
        `★ 要標成 forbidden_metric：${term} → ${r.violations.join()}`);
    }
  }
});

test('★★ R2-H-02: 誠實說「這個系統算不出那種分數」不會被誤判', () => {
  const r = blocked('這個系統目前算不出那種綜合分數，我只能就手上的指標跟你說。');
  assert.equal(r.ok, true, r.violations.join());
});

// ===========================================================================
// ★★★ 封閉詞彙表：沒算出來的指標
// ===========================================================================

test('★★★ R2-H-02: 提到這次沒算出來的指標 → 擋', () => {
  for (const text of [
    '你的步數今天不錯。',
    '你的最大攝氧量看起來很好。',
    '你的體重穩定。',
    'Your VO2 Max is improving.',
  ]) {
    assert.equal(blocked(text).ok, false, `★ 放行了沒算出來的指標：${text}`);
  }
});

test('★★ R2-H-02: 中文裡當動詞用的「恢復」不算指標提及', () => {
  const proactive = factsFromProactive({
    signal: { metric: 'hrv', current: 40, baseline_mean: 55, baseline_n: 30 },
  });
  for (const text of [
    '一起加油，兩三天內會恢復。',
    '你已經恢復了，很好。',
    '身體會慢慢恢復，別急。',
  ]) {
    const r = blocked(text, proactive);
    assert.equal(r.ok, true, `★ 動詞用法被誤判成指標宣稱：${text} ${r.violations.join()}`);
  }
});

// ===========================================================================
// ★★★ 空／缺席的事實集一律 fail closed
// ===========================================================================

for (const [name, set] of [
  ['null', null], ['undefined', undefined], ['沒有 facts 欄位', {}],
  ['空事實集', factSet([], { label: 'empty' })],
]) {
  test(`★★★ R2-H-02 fail closed: 事實集是 ${name} → 任何數值宣稱都擋`, () => {
    const v = validatePublication('你的恢復 55%。', set);
    assert.equal(v.ok, false, '★ 沒有事實就沒有任何數字可以被發布');
  });
}

test('★★★ R2-H-02 fail closed: 空敘述不可以被發布', () => {
  for (const empty of ['', '   ', null, undefined]) {
    assert.equal(validatePublication(empty, SET).ok, false);
  }
});

// ===========================================================================
// ★★★ guardPublication：原文一個字都不外流
// ===========================================================================

test('★★★ R2-H-02: 被擋下時原文完全不外流，且 fallback 仍然有用', () => {
  const bad = '你的 WHOOP Age 是 30 歲，HRV 999ms，建議吃 3mg 褪黑激素。';
  const g = guardPublication({
    narrative: bad, factSet: SET, fallback: '（確定性版本：恢復 55%）', label: 'test',
  });
  assert.equal(g.used, 'fallback');
  assert.equal(g.text, '（確定性版本：恢復 55%）', '★ fallback 必須仍然有資訊');
  for (const fragment of ['WHOOP Age', '999', '褪黑激素', '30 歲']) {
    assert.ok(!g.text.includes(fragment), `★ 不可以殘留「${fragment}」`);
  }
  assert.ok(g.violations.length >= 2, '要列出所有違規');
});

test('★★ R2-H-02: 驗證通過時原文原封不動放行', () => {
  const good = 'Kelvin，你今天的恢復 55%，比基準 62% 低一點；睡眠表現 99% 很漂亮 💛';
  const g = guardPublication({ narrative: good, factSet: SET, fallback: 'FB' });
  assert.equal(g.used, 'llm');
  assert.equal(g.text, good);
});

// ===========================================================================
// ★★ 不能過度封鎖：正常的教練文字
// ===========================================================================

const SAFE = [
  ['引用真實數字', 'Kelvin，你今天的恢復 55%，比 30 天基準 62% 低一點；睡眠表現 99% 很漂亮 💛'],
  ['完全不含數字', 'Kelvin，今天恢復比平常略低，睡眠品質不錯，照平常節奏走就好。'],
  ['相對描述', '今天的恢復比平常低一些，睡眠表現則比平常好。'],
  ['生活建議', '今天可以早點睡，記得多喝水，訓練量稍微降一點。'],
  ['吃東西是安全的', '記得吃早餐，也可以補充一點水。'],
  ['就醫提醒', '如果你覺得不舒服，還是找醫師看一下比較安心。'],
  ['資料不足的誠實說法', '資料還不夠多，這只是初步觀察，我會繼續留意。'],
  ['中文慣用語', '一起加油，第一次看到這個規律，十分穩定。'],
  ['z 值與樣本數', '恢復 55%（z=-0.80，基準 62%，n=30）算是輕微偏低。'],
  ['日期', '2026-09-09 的恢復是 55%。'],
];

for (const [name, text] of SAFE) {
  test(`★★ R2-H-02 false positive: ${name}`, () => {
    const r = blocked(text);
    assert.equal(r.ok, true, `★ 正常敘述被誤擋：${r.violations.join()}`);
  });
}

// ===========================================================================
// 數字詞正規化（發布邊界的前置零件）
// ===========================================================================

test('★★ R2-H-02: 中文數字詞在「宣稱一個量」時才會被轉換', () => {
  assert.equal(parseChineseNumber('九十九'), 99);
  assert.equal(parseChineseNumber('三十'), 30);
  assert.equal(parseChineseNumber('一百'), 100);
  assert.equal(parseChineseNumber('兩三'), null, '★ 約略說法不是數字');
  assert.equal(parseEnglishNumber('ninety nine'), 99);
  assert.equal(parseEnglishNumber('one hundred'), 100);
});

test('★★ R2-H-02: 慣用語不會被誤轉成數字（否則正常句子會憑空多出數字）', () => {
  const M = ['恢復', 'HRV'];
  for (const idiom of [
    '一起加油', '第一次看到', '十分穩定', '千萬不要熬夜', '一下子就好',
    '再一次確認', '一天一天累積', '進步了一成', '有一度覺得累',
    '兩三天內會恢復', '第三次了', '三四次深呼吸', '七八分飽',
    'one of your best days',
  ]) {
    assert.equal(normalizeNumberWords(idiom, { metricTerms: M }), idiom,
      `★ 「${idiom}」不該被改動`);
  }
});

// ===========================================================================
// 每一條發布路徑都用同一個邊界
// ===========================================================================

test('★★★ R2-H-02: 四個事實建構器都產生合法形狀的事實集', () => {
  const sets = [
    factsFromBriefing({ metrics: [], localDate: '2026-09-09', sampleCount: 30 }),
    factsFromWeekly({ last: { averages: {}, days: 7 }, prev: { days: 7 }, wow: {} }),
    factsFromQaResult({ available: false }),
    factsFromProactive({}),
  ];
  for (const s of sets) {
    assert.ok(Array.isArray(s.facts));
    assert.ok(Array.isArray(s.structural));
    assert.equal(typeof s.label, 'string');
    // 空事實集必須 fail closed
    if (!s.facts.length) {
      assert.equal(validatePublication('你的恢復 55%。', s).ok, false);
    }
  }
});

test('★★★ R2-H-02: 事實不可發布時，fact() 一律拒絕（值是 null / 未知指標 / 專有分數）', () => {
  assert.equal(fact('recovery', null).publishable, false);
  assert.equal(fact('recovery', NaN).publishable, false);
  assert.equal(fact('recovery', undefined).publishable, false);
  assert.equal(fact('whoop_age', 30).publishable, false, '★ 專有分數即使有值也不可發布');
  assert.equal(fact('healthspan_score', 88).publishable, false);
  assert.equal(fact('not_a_real_metric', 5).publishable, false, '★ 詞彙表外的指標不可發布');
  assert.equal(fact('recovery', 55).publishable, true);
});
