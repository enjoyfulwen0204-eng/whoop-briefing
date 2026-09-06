/**
 * 統計 / z-score / 偏離 / 趨勢 / What Changed。
 *
 * 全部是純函式，用手算得出來的數字驗證 —— 不是「跑一次看看輸出什麼」。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  mean, median, stddev, percentileOf, quantile, describeWindow, summarise, windowSlice,
} from '../src/analytics/statistics.js';
import { zScore, levelOf, evaluateDeviation, isNoteworthy, DEVIATION } from '../src/analytics/anomaly.js';
import { linearRegression, classifySlope, trendsFor, detectBaselineShift, TREND } from '../src/analytics/trend.js';
import { changeFor, importanceOf, whatChangedToday } from '../src/analytics/whatChanged.js';
import { ANALYTICS } from '../src/config.js';

/** 造一段連續日期的序列（舊→新）。 */
function series(startDate, values) {
  const t0 = Date.parse(`${startDate}T00:00:00Z`);
  return values.map((value, i) => ({
    date: new Date(t0 + i * 86_400_000).toISOString().slice(0, 10),
    value,
  }));
}

const close = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

// ---------------------------------------------------------------------------
// 描述性統計
// ---------------------------------------------------------------------------

test('stats: mean / median / min / max 手算驗證', () => {
  assert.equal(mean([1, 2, 3, 4]), 2.5);
  assert.equal(median([1, 2, 3]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5, '偶數取中間兩個平均');
  assert.equal(mean([]), null);
  assert.equal(median([]), null);
});

test('stats: 標準差用 n-1（樣本標準差）', () => {
  // [2,4,4,4,5,5,7,9] → mean 5，母體 SD 2，樣本 SD = sqrt(32/7)
  const v = [2, 4, 4, 4, 5, 5, 7, 9];
  assert.ok(close(stddev(v), Math.sqrt(32 / 7)), `實際 ${stddev(v)}`);
  assert.notEqual(stddev(v), 2, '不可以是母體標準差');
  assert.equal(stddev([5]), null, '單點沒有離散度');
  assert.equal(stddev([]), null);
  assert.equal(stddev([3, 3, 3]), 0, '完全相同 → 0');
});

test('stats: percentile 用 midrank，相同值不會跳到極端', () => {
  assert.equal(percentileOf(5, [1, 2, 3, 4]), 100);
  assert.equal(percentileOf(0, [1, 2, 3, 4]), 0);
  assert.equal(percentileOf(3, [1, 2, 3, 4]), 62.5, '2 個小於 + 1 個相等的一半 = 2.5/4');
  assert.equal(percentileOf(5, [5, 5, 5, 5]), 50, '全部相同 → 50，不是 0 或 100');
  assert.equal(percentileOf(1, []), null);
});

test('stats: quantile 線性內插', () => {
  assert.equal(quantile([1, 2, 3, 4, 5], 50), 3);
  assert.equal(quantile([1, 2, 3, 4], 50), 2.5);
  assert.equal(quantile([10], 90), 10);
});

test('★ stats: window 是日曆天數，n 是有效樣本數 —— 兩者不可混用', () => {
  // 30 天的窗口，但中間有一大段沒戴錶，只有 8 筆
  const s = [
    ...series('2026-08-01', [50, 51, 52, 53, 54]),
    ...series('2026-08-25', [55, 56, 57]),
  ];
  const w = describeWindow(s, { endDate: '2026-08-30', days: 30 });
  assert.equal(w.windowDays, 30, 'windowDays 永遠是設定的日曆天數');
  assert.equal(w.n, 8, 'n 是實際樣本數');
  assert.ok(w.coverage < 0.3, 'coverage 要如實反映缺很多');
  assert.equal(w.sufficient, true, '8 >= MIN_SAMPLES');
});

test('stats: 樣本不足時 sufficient=false（上層據此不下結論）', () => {
  const w = describeWindow(series('2026-08-28', [50, 51]), { endDate: '2026-08-30', days: 30 });
  assert.equal(w.n, 2);
  assert.equal(w.sufficient, false);
  assert.ok(ANALYTICS.MIN_SAMPLES > 2);
});

test('stats: excludeEndDate 排除今天（今天不可以把自己的基準拉走）', () => {
  const s = series('2026-08-25', [50, 50, 50, 50, 50, 100]); // 最後一天是 08-30 = 100
  const withToday = describeWindow(s, { endDate: '2026-08-30', days: 7 });
  const without = describeWindow(s, { endDate: '2026-08-30', days: 7, excludeEndDate: true });
  assert.equal(withToday.n, 6);
  assert.equal(without.n, 5);
  assert.equal(without.mean, 50, '排除今天後基準乾淨');
});

test('stats: summarise 產出 7/14/30/90 四個窗口，各自帶 n', () => {
  const s = series('2026-06-01', Array.from({ length: 100 }, (_, i) => 50 + (i % 5)));
  const out = summarise(s, { endDate: '2026-09-08', current: 60 });
  for (const k of ['7d', '14d', '30d', '90d']) {
    assert.ok(out[k], `${k} 要存在`);
    assert.equal(out[k].windowDays, Number(k.replace('d', '')));
    assert.equal(typeof out[k].n, 'number');
    assert.ok(out[k].percentile_of_current !== null);
  }
  assert.ok(out['7d'].n <= 7, '7 天窗口不可能有超過 7 筆');
  assert.ok(out['90d'].n > out['7d'].n);
});

// ---------------------------------------------------------------------------
// z-score / 偏離
// ---------------------------------------------------------------------------

test('z-score: 手算驗證', () => {
  assert.equal(zScore(60, { mean: 50, stddev: 5 }), 2);
  assert.equal(zScore(40, { mean: 50, stddev: 5 }), -2);
  assert.equal(zScore(50, { mean: 50, stddev: 5 }), 0);
});

test('★ z-score: 變異為 0 時回 null，不可以爆成無限大', () => {
  assert.equal(zScore(60, { mean: 50, stddev: 0 }), null);
  assert.equal(zScore(60, { mean: 50, stddev: null }), null);
  assert.equal(zScore(null, { mean: 50, stddev: 5 }), null);
  // 相對於平均值極小的變異也視為沒有變異
  assert.equal(zScore(50.001, { mean: 50, stddev: 0.00001 }), null);
});

test('z-score: 分級門檻（1 / 1.5 / 2）', () => {
  assert.equal(levelOf(0.5), DEVIATION.NORMAL);
  assert.equal(levelOf(0.99), DEVIATION.NORMAL);
  assert.equal(levelOf(1), DEVIATION.MILD);
  assert.equal(levelOf(1.49), DEVIATION.MILD);
  assert.equal(levelOf(1.5), DEVIATION.NOTABLE);
  assert.equal(levelOf(1.99), DEVIATION.NOTABLE);
  assert.equal(levelOf(2), DEVIATION.STRONG);
  assert.equal(levelOf(-2.5), DEVIATION.STRONG, '用絕對值');
});

test('★ 偏離方向要 metric-aware：HRV 偏高不是問題，RHR 偏高才是', () => {
  assert.equal(isNoteworthy('hrv', -2), true, 'HRV 偏低要留意');
  assert.equal(isNoteworthy('hrv', 2), false, 'HRV 偏高是好事');
  assert.equal(isNoteworthy('rhr', 2), true, 'RHR 偏高要留意');
  assert.equal(isNoteworthy('rhr', -2), false, 'RHR 偏低不是問題');
  assert.equal(isNoteworthy('recovery', -2), true);
  assert.equal(isNoteworthy('sleep_debt', 2), true, '睡眠債偏高要留意');
  // 兩個方向都值得看的
  assert.equal(isNoteworthy('respiratory_rate', 2), true);
  assert.equal(isNoteworthy('respiratory_rate', -2), true);
  assert.equal(isNoteworthy('skin_temp', -2), true);
});

test('偏離評估：完整輸出與各種資料不足情境', () => {
  const baseline = { mean: 50, stddev: 5, n: 20, sufficient: true, windowDays: 30 };

  const strong = evaluateDeviation('hrv', 38, baseline);
  assert.ok(close(strong.z_score, -2.4));
  assert.equal(strong.level, DEVIATION.STRONG);
  assert.equal(strong.direction, 'low');
  assert.equal(strong.noteworthy, true);
  assert.equal(strong.baseline_n, 20);
  assert.equal(strong.direction_rule, 'higher_better');

  // HRV 偏高：等級一樣強，但不值得「留意」
  const high = evaluateDeviation('hrv', 62, baseline);
  assert.equal(high.level, DEVIATION.STRONG);
  assert.equal(high.noteworthy, false);

  // 樣本不足
  const thin = evaluateDeviation('hrv', 38, { mean: 50, stddev: 5, n: 2, sufficient: false });
  assert.equal(thin.level, DEVIATION.INSUFFICIENT_DATA);

  // 變異不足
  const flat = evaluateDeviation('hrv', 38, { mean: 50, stddev: 0, n: 20, sufficient: true });
  assert.equal(flat.level, DEVIATION.INSUFFICIENT_VARIANCE);

  // 今天沒有值
  assert.equal(evaluateDeviation('hrv', null, baseline).level, DEVIATION.INSUFFICIENT_DATA);
});

// ---------------------------------------------------------------------------
// 趨勢
// ---------------------------------------------------------------------------

test('迴歸: 完美直線的斜率與 R² 手算驗證', () => {
  const reg = linearRegression(series('2026-08-01', [10, 12, 14, 16, 18]));
  assert.ok(close(reg.slope_per_day, 2), `斜率應為 2，實際 ${reg.slope_per_day}`);
  assert.ok(close(reg.r2, 1), '完美直線 R² = 1');
  assert.equal(reg.n, 5);
  assert.ok(close(reg.total_change, 8), '跨 4 天 × 每天 2 = 8');
});

test('★ 迴歸: 缺日不會被當成等距（用真實日期算 x）', () => {
  // 08-01=10, 08-02=12, 然後跳到 08-11=30
  const points = [
    { date: '2026-08-01', value: 10 },
    { date: '2026-08-02', value: 12 },
    { date: '2026-08-11', value: 30 },
  ];
  const reg = linearRegression(points);
  // 若錯誤地把三點當等距，斜率會是 10；用真實日期則接近 2
  assert.ok(reg.slope_per_day < 3, `缺日必須用真實間距，實際斜率 ${reg.slope_per_day}`);
  assert.equal(reg.span_days, 10);
});

test('迴歸: 點太少或同一天回 null', () => {
  assert.equal(linearRegression([{ date: '2026-08-01', value: 1 }]), null);
  assert.equal(linearRegression([]), null);
  assert.equal(linearRegression([
    { date: '2026-08-01', value: 1 }, { date: '2026-08-01', value: 2 },
  ]), null, '所有點同一天算不出斜率');
});

test('★ 趨勢方向 metric-aware：HRV 上升=改善，RHR 上升=惡化', () => {
  const up = linearRegression(series('2026-08-01', [50, 52, 54, 56, 58]));
  const down = linearRegression(series('2026-08-01', [58, 56, 54, 52, 50]));

  assert.equal(classifySlope('hrv', up, 54), TREND.IMPROVING);
  assert.equal(classifySlope('hrv', down, 54), TREND.DECLINING);
  assert.equal(classifySlope('rhr', up, 54), TREND.DECLINING, 'RHR 上升是變差');
  assert.equal(classifySlope('rhr', down, 54), TREND.IMPROVING);
  assert.equal(classifySlope('skin_temp', up, 54), TREND.STABLE, "'both' 沒有好方向");
});

test('趨勢: 幾乎沒動 → STABLE（不可以每天都報方向）', () => {
  const flat = linearRegression(series('2026-08-01', [50, 50.01, 49.99, 50.02, 50]));
  assert.equal(classifySlope('hrv', flat, 50), TREND.STABLE);
});

test('趨勢: trendsFor 產出 7/30/90，樣本不足標 insufficient_data', () => {
  const s = series('2026-06-10', Array.from({ length: 90 }, (_, i) => 50 + i * 0.1));
  const t = trendsFor('hrv', s, { endDate: '2026-09-07' });
  assert.equal(t['7d'].windowDays, 7);
  assert.equal(t['30d'].sufficient, true);
  assert.equal(t['90d'].direction, TREND.IMPROVING);
  assert.ok(t['90d'].r2 > 0.9);

  const thin = trendsFor('hrv', series('2026-09-05', [50, 51]), { endDate: '2026-09-07' });
  assert.equal(thin['30d'].sufficient, false);
  assert.equal(thin['30d'].direction, TREND.INSUFFICIENT_DATA);
});

test('★ baseline shift: 真的位移才報，正常波動不報', () => {
  // 前 14 天在 50 附近，後 14 天在 42 附近 → 明顯下移
  const shifted = [
    ...series('2026-08-04', [50, 51, 49, 50, 52, 48, 50, 51, 49, 50, 51, 49, 50, 50]),
    ...series('2026-08-18', [42, 43, 41, 42, 44, 40, 42, 43, 41, 42, 43, 41, 42, 42]),
  ];
  const r = detectBaselineShift('hrv', shifted, { endDate: '2026-08-31' });
  assert.equal(r.shift, true);
  assert.equal(r.status, 'possible_baseline_shift');
  assert.ok(r.effect_size < -1, `effect size 應該明顯為負，實際 ${r.effect_size}`);
  assert.equal(r.interpretation, 'worse', 'HRV 下移 = 變差');

  // 正常波動 → 不報
  const stable = series('2026-08-04', Array.from({ length: 28 }, (_, i) => 50 + (i % 3) - 1));
  const s = detectBaselineShift('hrv', stable, { endDate: '2026-08-31' });
  assert.equal(s.shift, false);
  assert.equal(s.status, 'stable');
});

test('baseline shift: 樣本不足時明講，不硬算', () => {
  const r = detectBaselineShift('hrv', series('2026-08-28', [50, 51, 52]), { endDate: '2026-08-30' });
  assert.equal(r.shift, false);
  assert.equal(r.reason, 'insufficient_data');
});

// ---------------------------------------------------------------------------
// What Changed Today
// ---------------------------------------------------------------------------

test('What Changed: 單一指標的完整變化描述', () => {
  const s = series('2026-08-01', [...Array.from({ length: 30 }, () => 55), 40]); // 最後一天 40
  const anchor = s[s.length - 1].date;
  const c = changeFor('hrv', s, anchor);

  assert.equal(c.current, 40);
  assert.equal(c.yesterday, 55);
  assert.equal(c.vs_yesterday_absolute, -15);
  assert.ok(close(c.vs_30d_pct, ((40 - 55) / 55) * 100));
  assert.equal(c.baseline_30d_mean, 55);
  assert.equal(c.favourability, 'unfavourable', 'HRV 掉了是不好的');
});

test('★ What Changed: 排序完全確定性，且不由 LLM 決定', () => {
  const flat = (v) => Array.from({ length: 30 }, () => v);
  const seriesByMetric = {
    // HRV 崩跌 → 應該排第一
    hrv: series('2026-08-01', [...flat(55).map((v, i) => v + (i % 3) - 1), 35]),
    // RHR 小幅上升
    rhr: series('2026-08-01', [...flat(50).map((v, i) => v + (i % 3) - 1), 53]),
    // 睡眠幾乎沒變 → 不該出現
    sleep_total: series('2026-08-01', [...flat(25_200_000), 25_200_000]),
  };
  const anchor = '2026-08-31';

  const out = whatChangedToday(seriesByMetric, anchor);
  assert.ok(out.length >= 1);
  assert.equal(out[0].metric, 'hrv', 'HRV 崩跌應該最重要');
  assert.ok(out.every((c) => typeof c.importance === 'number'));
  assert.ok(out.every((c) => c.importance >= 0 && c.importance <= 1));

  // 完全沒變的指標不該入選
  assert.ok(!out.some((c) => c.metric === 'sleep_total'), '沒變的東西不可以報');

  // 跑兩次結果必須完全一樣（確定性）
  assert.deepEqual(whatChangedToday(seriesByMetric, anchor), out);
});

test('What Changed: 最多 3 項，且 importance 由高到低', () => {
  const mk = (base, today) => series('2026-08-01', [
    ...Array.from({ length: 30 }, (_, i) => base + (i % 4) - 1.5), today,
  ]);
  const out = whatChangedToday({
    hrv: mk(55, 30), rhr: mk(50, 62), recovery: mk(65, 25),
    sleep_total: mk(25_200_000, 14_000_000), respiratory_rate: mk(15, 18),
  }, '2026-08-31');

  assert.ok(out.length <= 3, `最多 3 項，實際 ${out.length}`);
  for (let i = 1; i < out.length; i++) {
    assert.ok(out[i - 1].importance >= out[i].importance, 'importance 必須遞減');
  }
});

test('★ What Changed: 樣本不足時 importance 打折（資料品質納入排序）', () => {
  const rich = series('2026-08-01', [...Array.from({ length: 30 }, (_, i) => 55 + (i % 3) - 1), 35]);
  const thin = series('2026-08-28', [55, 56, 54, 35]);

  const richChange = changeFor('hrv', rich, '2026-08-31');
  const thinChange = changeFor('hrv', thin, '2026-08-31');
  assert.ok(
    importanceOf(richChange) > importanceOf(thinChange),
    '同樣的變化，樣本多的應該更重要',
  );
});

test('What Changed: 今天沒有值的指標直接略過，不會爆', () => {
  const out = whatChangedToday({
    hrv: series('2026-08-01', Array.from({ length: 20 }, () => 55)), // 沒有 08-31
  }, '2026-08-31');
  assert.deepEqual(out, []);
});

test('windowSlice: 邊界日期包含正確', () => {
  const s = series('2026-08-25', [1, 2, 3, 4, 5, 6, 7]); // 08-25 ~ 08-31
  const w = windowSlice(s, { endDate: '2026-08-31', days: 3 });
  assert.deepEqual(w.map((p) => p.date), ['2026-08-29', '2026-08-30', '2026-08-31']);
});
