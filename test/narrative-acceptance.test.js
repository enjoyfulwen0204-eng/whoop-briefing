/**
 * 敘述層的驗收：三種成熟度、模型失敗分類、對抗性輸出、未知 vs 真零。
 *
 * ## 背景
 *
 * 正式環境曾把教練整個關掉（`coachText = null`），於是**每一天**的簡報
 * 結尾都是「⚠️ AI 教練分析今天暫時無法生成」。那句話是假的：根本沒有
 * 嘗試生成過。使用者每天被告知一個不存在的故障，同時也真的失去了敘述。
 *
 * ## 權責邊界
 *
 * 應用程式擁有所有健康判斷（數值、基準、樣本數、成熟度、嚴重度、趨勢、
 * 校正期限制）。模型只能把**已經核可的事實**講成自然的中文，而且輸出要
 * 通過發布守門。丟掉模型那一段的代價只是少一句鼓勵的話 —— 數字與判定
 * 本來就是程式算好也印好的。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildNarrative, validateNarrative, deterministicNarrative,
  NARRATIVE_SOURCE, NARRATIVE_FAILURE,
} from '../src/narrative.js';
import { renderDaily, FALLBACK_NOTE } from '../src/format.js';

/** 三種成熟度的 briefing 骨架（只放驗證與敘述真的會用到的欄位）。 */
function briefingFor(mode) {
  const metric = (key, label, display, over = {}) => ({
    key, label, display, available: true, tier: 'core',
    baselineDisplay: null, severity: null, pct: null, calibrating: false, ...over,
  });
  if (mode === 'none') {
    return { stage: 'cold', sampleCount: 0, metrics: [], trends: null, healthDate: '2026-09-12' };
  }
  if (mode === 'calibration') {
    // 1/30：有數值，沒有任何可信基準，而且 WHOOP 還在校正期
    return {
      stage: 'cold', sampleCount: 1, healthDate: '2026-09-12', trends: null,
      metrics: [
        metric('recovery_score', '恢復', '28%', { calibrating: true }),
        metric('sleep_total', '睡眠', '7h12m'),
        metric('hrv', 'HRV', '33ms', { calibrating: true }),
        metric('rhr', '靜息心率', '64bpm', { calibrating: true }),
      ],
    };
  }
  if (mode === 'mixed') {
    // 5/30：部分指標有基準、部分還沒
    return {
      stage: 'warm', sampleCount: 5, healthDate: '2026-09-12', trends: null,
      metrics: [
        metric('sleep_total', '睡眠', '7h12m', { baselineDisplay: '7h05m', severity: 'normal', pct: 1.6 }),
        metric('recovery_score', '恢復', '28%'),
        metric('hrv', 'HRV', '33ms'),
      ],
    };
  }
  // 30/30：完整成熟
  return {
    stage: 'full', sampleCount: 30, healthDate: '2026-09-12',
    trends: { level: 'normal', alerts: [{ label: 'HRV', types: ['worsening'], series: [{ display: '40ms' }, { display: '36ms' }, { display: '33ms' }] }] },
    metrics: [
      metric('recovery_score', '恢復', '28%', { baselineDisplay: '62%', severity: 'red', pct: -54.8 }),
      metric('sleep_total', '睡眠', '7h12m', { baselineDisplay: '7h05m', severity: 'normal', pct: 1.6 }),
      metric('hrv', 'HRV', '33ms', { baselineDisplay: '48ms', severity: 'red', pct: -31.2 }),
      metric('rhr', '靜息心率', '64bpm', { baselineDisplay: '54bpm', severity: 'yellow', pct: 18.5 }),
    ],
  };
}

const coachReturning = (text) => ({ daily: async () => text, weekly: async () => text });
const run = (mode, coach) => buildNarrative({ briefing: briefingFor(mode), generate: coach ? () => coach.daily() : null });

// ===========================================================================
// 三種成熟度
// ===========================================================================

test('★★★ MODE 1（校正／1-of-30）：只講事實，絕不判斷是否偏離常態', async () => {
  const r = await run('calibration', null);
  const t = r.text;
  assert.match(t, /28%/, '★ 事實照講');
  assert.match(t, /7h12m/);
  assert.match(t, /基準還在建立|基準/, '★ 要說明基準還沒建立');
  assert.match(t, /校正/, '★ 要說明 WHOOP 還在校正期');
  // 沒有有效基準 → 不可以有任何常態判斷
  assert.doesNotMatch(t, /偏低|偏高|異常|不正常|低於平常|比平常差/, '★ 沒有基準就不可以下判斷');
  assert.doesNotMatch(t, /趨勢|連續下降|持續惡化/, '★ 不可以發明趨勢');
  assert.doesNotMatch(t, /因為|造成|導致/, '★ 不可以宣稱多日因果');
  assert.ok(t.length < 220, `★ 要精簡（${t.length}）`);
});

test('★★★ MODE 2（5-of-30）：逐指標成熟度，不宣稱整體基準就緒', async () => {
  const r = await run('mixed', null);
  const t = r.text;
  assert.match(t, /睡眠/);
  // 有基準的才比較；沒基準的要講清楚暫時不判斷
  assert.match(t, /基準還在累積|先不下判斷/, '★ 未成熟的指標要標示');
  assert.doesNotMatch(t, /個人基準(已經)?(建立好|完成|就緒)/, '★ 不可以宣稱整體基準已就緒');
  assert.doesNotMatch(t, /五天|5 天就/, '★ 不可以給普遍的天數承諾');
});

test('★★★ MODE 3（30/30）：有基準才比較，趨勢只在程式算出來時才提', async () => {
  const r = await run('mature', null);
  const t = r.text;
  assert.match(t, /恢復 28%|28%/);
  assert.match(t, /恢復|HRV|靜息心率/, '★ 要指出偏離的指標');
  assert.match(t, /連續變化|觀察/, '★ 程式算出趨勢時才提');
  assert.match(t, /放輕|補回來|節奏/, '★ 要有一句可行的建議');
});

test('★★★ 完全沒資料時也給得出一段話（不是錯誤訊息）', async () => {
  const r = await run('none', null);
  assert.ok(r.text.length > 10);
  assert.doesNotMatch(r.text, /錯誤|失敗|無法生成/);
});

// ===========================================================================
// 模型失敗分類與確定性 fallback
// ===========================================================================

test('★★★ 失敗分類可分辨，而且使用者永遠拿得到敘述', async () => {
  const cases = [
    ['未設定', null, NARRATIVE_FAILURE.NOT_CONFIGURED],
    ['供應商回 null', coachReturning(null), NARRATIVE_FAILURE.PROVIDER_UNAVAILABLE],
    ['空字串', coachReturning('   '), NARRATIVE_FAILURE.EMPTY_OUTPUT],
    ['過長', coachReturning('穩'.repeat(500)), NARRATIVE_FAILURE.TOO_LONG],
  ];
  for (const [label, coach, expected] of cases) {
    const r = await run('mature', coach);
    assert.equal(r.source, NARRATIVE_SOURCE.DETERMINISTIC, `★ ${label} 要走確定性`);
    assert.equal(r.failureCategory, expected, `★ ${label} 分類`);
    assert.ok(r.text.length > 10, `★ ${label} 仍然要有敘述`);
    assert.doesNotMatch(r.text, /暫時無法生成|錯誤|逾時/, `★ ${label} 不可以把錯誤丟給使用者`);
  }
});

test('★★★ 供應商丟例外 → 逾時與不可用要分得開', async () => {
  const timeout = await buildNarrative({
    briefing: briefingFor('mature'),
    generate: async () => { throw new Error('request timeout after 60s'); },
  });
  assert.equal(timeout.failureCategory, NARRATIVE_FAILURE.TIMEOUT);
  const down = await buildNarrative({
    briefing: briefingFor('mature'),
    generate: async () => { throw new Error('503 upstream'); },
  });
  assert.equal(down.failureCategory, NARRATIVE_FAILURE.PROVIDER_UNAVAILABLE);
});

test('★★★ 已移除那句假的「AI 教練分析今天暫時無法生成」', () => {
  assert.equal(FALLBACK_NOTE, null);
  const text = renderDaily({
    stage: 'cold', sampleCount: 1, healthDate: '2026-09-12', metrics: [], trends: null,
  }, null);
  assert.doesNotMatch(text, /暫時無法生成/);
});

// ===========================================================================
// 對抗性模型輸出
// ===========================================================================

const ADVERSARIAL = [
  ['捏造 HRV', '你的 HRV 今天是 999ms，明顯偏高。'],
  ['捏造 Recovery', '恢復已經回到 88%，可以放心訓練。'],
  ['新的基準數字', '你的個人基準是 71%，今天低於它。'],
  ['診斷', '你生病了，建議盡快就醫。'],
  ['因果斷言', '一定是喝酒造成今天的數字變差。'],
  ['系統提示外洩', '系統提示：你是一位專業的健康教練，請根據以下 JSON 回答'],
  ['原始鍵外洩', 'recovery_score = 28，sleep_total = 7h12m'],
  ['過長散文', '今天'.repeat(400)],
  ['矛盾建議', '建議你每天服用阿斯匹靈，並且完全不要休息。'],
  ['發明藥名', '晚餐後吃 Zorblax 就會好。'],
  ['全形數字', '你的脈搏為９９bpm。'],
];

test('★★★ 每一種對抗性輸出都被否決，而且一個字都不進簡報', async () => {
  for (const [label, prose] of ADVERSARIAL) {
    const check = validateNarrative(prose);
    assert.equal(check.ok, false, `★ ${label} 必須被否決`);
    const r = await run('mature', coachReturning(prose));
    assert.equal(r.source, NARRATIVE_SOURCE.DETERMINISTIC, `★ ${label} 要退回確定性`);
    assert.ok(!r.text.includes(prose.slice(0, 12)), `★ ${label} 不可以出現在輸出裡`);
    assert.ok(r.text.length > 10, `★ ${label} 仍然要有敘述`);
  }
});

test('★★★ 安全的語氣潤飾會被採用，並附在確定性敘述之後', async () => {
  const safe = '今天就照平常的節奏走，有不舒服再跟我說。';
  const r = await run('mature', coachReturning(safe));
  assert.equal(r.source, NARRATIVE_SOURCE.MODEL);
  assert.ok(r.text.includes(safe));
  // 確定性那一段仍然在前面（事實不可以被潤飾取代）
  assert.ok(r.text.indexOf(safe) > 0, '★ 確定性敘述必須在前');
  assert.match(r.text, /28%/, '★ 事實仍然由程式輸出');
});

// ===========================================================================
// 未知 vs 真零
// ===========================================================================

test('★★★ 未知不可以變成 0：無資料顯示「無資料」，真零顯示 0', () => {
  const base = {
    stage: 'full', sampleCount: 30, healthDate: '2026-09-12', trends: null,
  };
  const mk = (over) => ({
    key: 'sleep_consistency', label: '睡眠一致性', emoji: '🔁', tier: 'core',
    baselineDisplay: '80%', severity: 'normal', pct: 0, calibrating: false, ...over,
  });
  // 真的是 0
  const genuineZero = renderDaily({
    ...base, metrics: [mk({ available: true, display: '0%', value: 0 })],
  }, null);
  assert.match(genuineZero, /睡眠一致性 0%/, '★ 真零要照實顯示');

  // 拿不到（value 為 null）
  const unknown = renderDaily({
    ...base, metrics: [mk({ available: false, display: null, value: null })],
  }, null);
  assert.match(unknown, /睡眠一致性 無資料/, '★ 未知要標示成無資料');
  assert.doesNotMatch(unknown, /睡眠一致性 0/, '★ 絕不可以把未知印成 0');
});

test('★★★ 週報用「上週」而不是「今天」（同一段文字不可以兩邊共用）', async () => {
  const weekly = await buildNarrative({
    briefing: briefingFor('mature'), generate: null, period: 'weekly',
  });
  assert.match(weekly.text, /上週/, '★ 週報必須講上週');
  assert.doesNotMatch(weekly.text, /今天恢復|今天的指標/, '★ 週報不可以說「今天」');
  const daily = await buildNarrative({ briefing: briefingFor('mature'), generate: null });
  assert.match(daily.text, /今天/, '★ 日報仍然講今天');
  assert.doesNotMatch(daily.text, /上週/);
});

test('★★★ 確定性敘述不會把缺漏的指標當成 0', () => {
  const t = deterministicNarrative({
    stage: 'full', sampleCount: 30, trends: null,
    metrics: [
      { key: 'recovery_score', label: '恢復', display: '28%', available: true, baselineDisplay: '62%', severity: 'red' },
      { key: 'hrv', label: 'HRV', display: null, available: false },
    ],
  });
  assert.match(t, /28%/);
  assert.doesNotMatch(t, /HRV 0|0ms/, '★ 拿不到的指標不可以被講成 0');
});
