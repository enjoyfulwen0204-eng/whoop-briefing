/**
 * 分析基礎建設：相似日 / 相關 / 迴歸 / 預測（Phase U / V / W / X）。
 *
 * 全部 synthetic data，而且盡量用「手算得出答案」的例子驗證，
 * 不是「跑一次看看輸出什麼」。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  findSimilarDays, bedtimeToMinutes, buildScaler, distanceBetween, DEFAULT_FEATURES,
} from '../src/analytics/similarDays.js';
import {
  pearson, spearman, rankOf, pValue, dataQualityOf, CONFIDENCE,
  alignSeries, analyseAssociation, journalAssociation,
} from '../src/analytics/correlation.js';
import {
  ordinaryLeastSquares, solveLinearSystem, varianceInflationFactors,
  analyzeRecoveryDrivers, predictFrom,
} from '../src/analytics/regression.js';
import {
  temporalSplit, assertNoLeakage, buildSupervised, train, predict, evaluate,
  PREDICTION_STATUS, MIN_TRAIN_ROWS,
} from '../src/prediction.js';

const close = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;
const DAY = 86_400_000;

/** 造連續日期的 daily_metrics 列。 */
function makeRows(startDate, n, fn) {
  const t0 = Date.parse(`${startDate}T00:00:00Z`);
  return Array.from({ length: n }, (_, i) => ({
    health_date: new Date(t0 + i * DAY).toISOString().slice(0, 10),
    ...fn(i),
  }));
}

const series = (startDate, values) => {
  const t0 = Date.parse(`${startDate}T00:00:00Z`);
  return values.map((value, i) => ({
    date: new Date(t0 + i * DAY).toISOString().slice(0, 10),
    value,
  }));
};

// ===========================================================================
// Phase U — 相似歷史日
// ===========================================================================

test('★ U: 就寢時間跨午夜要用連續的軸（23:50 與 00:10 只差 20 分）', () => {
  assert.equal(bedtimeToMinutes('23:50'), 23 * 60 + 50 - 1440);
  assert.equal(bedtimeToMinutes('00:10'), 10);
  const diff = Math.abs(bedtimeToMinutes('00:10') - bedtimeToMinutes('23:50'));
  assert.equal(diff, 20, `★ 應該差 20 分鐘，實際 ${diff}`);
  assert.equal(bedtimeToMinutes('壞掉'), null);
  assert.equal(bedtimeToMinutes(null), null);
});

test('U: 找出最相似的日子（目標日自己一定被排除）', () => {
  const rows = [
    { health_date: '2026-08-01', hrv: 55, rhr: 50, recovery: 70, sleep_total: 25_200_000, sleep_performance: 90, sleep_debt: 0, previous_day_strain: 12, respiratory_rate: 15, bedtime_local: '23:00' },
    { health_date: '2026-08-02', hrv: 54, rhr: 51, recovery: 68, sleep_total: 25_000_000, sleep_performance: 89, sleep_debt: 0, previous_day_strain: 12, respiratory_rate: 15, bedtime_local: '23:05' },
    { health_date: '2026-08-03', hrv: 30, rhr: 65, recovery: 30, sleep_total: 15_000_000, sleep_performance: 60, sleep_debt: 3_600_000, previous_day_strain: 18, respiratory_rate: 17, bedtime_local: '02:00' },
    { health_date: '2026-08-04', hrv: 56, rhr: 49, recovery: 72, sleep_total: 25_500_000, sleep_performance: 91, sleep_debt: 0, previous_day_strain: 11, respiratory_rate: 14.9, bedtime_local: '22:55' },
  ];
  const out = findSimilarDays(rows, '2026-08-01', { topN: 3 });
  assert.ok(!out.some((d) => d.health_date === '2026-08-01'), '★ 不可以把目標日自己算進去');
  assert.equal(out[0].health_date === '2026-08-02' || out[0].health_date === '2026-08-04', true);
  assert.equal(out.at(-1).health_date, '2026-08-03', '差最多的那天要排最後');
  assert.ok(out[0].distance < out.at(-1).distance);
});

test('★ U: 缺欄位不會讓整天被排除，只要共用特徵夠多', () => {
  // 多個特徵都要有變異，否則標準化後可用特徵不足（那是另一回事）
  const rows = makeRows('2026-08-01', 10, (i) => ({
    hrv: 55 + i,
    rhr: 50 + (i % 4),
    recovery: 70 - (i % 5),
    sleep_total: 25_000_000 + i * 100_000,
    sleep_performance: 90 - (i % 3),
    sleep_debt: (i % 6) * 60_000,
    previous_day_strain: 12 + (i % 4),
    respiratory_rate: 15 + (i % 3) * 0.2,
    bedtime_local: '23:00',
    // 第 3 天（2026-08-04）缺一個欄位
    ...(i === 3 ? { respiratory_rate: null } : {}),
  }));
  const out = findSimilarDays(rows, '2026-08-01', { topN: 20 });
  assert.ok(
    out.some((d) => d.health_date === '2026-08-04'),
    '★ 缺一個欄位的那天仍然要被納入比較',
  );
  const partial = out.find((d) => d.health_date === '2026-08-04');
  assert.ok(partial.shared_count >= 4);
  assert.ok(!partial.shared_features.includes('respiratory_rate'));
});

test('U: 共用特徵太少 → 該天被跳過（不硬算）', () => {
  const rows = [
    { health_date: '2026-08-01', hrv: 55, rhr: 50, recovery: 70, sleep_total: 25_000_000, sleep_performance: 90, sleep_debt: 0, previous_day_strain: 12, respiratory_rate: 15, bedtime_local: '23:00' },
    { health_date: '2026-08-02', hrv: 54, rhr: 51, recovery: 69, sleep_total: 25_000_000, sleep_performance: 89, sleep_debt: 0, previous_day_strain: 12, respiratory_rate: 15, bedtime_local: '23:00' },
    // 只有一個欄位
    { health_date: '2026-08-03', hrv: 50 },
  ];
  const out = findSimilarDays(rows, '2026-08-01', { topN: 5 });
  assert.ok(!out.some((d) => d.health_date === '2026-08-03'), '共用特徵不足要跳過');
});

test('★ U: 沒有歷史時回 []，不拋錯', () => {
  assert.deepEqual(findSimilarDays([], '2026-08-01'), []);
  assert.deepEqual(findSimilarDays([{ health_date: '2026-08-01', hrv: 50 }], '2026-08-01'), []);
  assert.deepEqual(findSimilarDays([{ health_date: '2026-08-01' }], '2026-08-99'), [], '目標日不存在也回 []');
});

test('U: 結果是確定性的（跑兩次完全一樣）', () => {
  const rows = makeRows('2026-08-01', 20, (i) => ({
    hrv: 50 + (i % 5), rhr: 50 + (i % 3), recovery: 60 + (i % 7),
    sleep_total: 25_000_000, sleep_performance: 88, sleep_debt: 0,
    previous_day_strain: 12, respiratory_rate: 15, bedtime_local: '23:00',
  }));
  assert.deepEqual(findSimilarDays(rows, '2026-08-10'), findSimilarDays(rows, '2026-08-10'));
});

test('U: 沒有變異的特徵不會被拿來算距離（避免除以 0）', () => {
  const rows = makeRows('2026-08-01', 5, () => ({
    hrv: 55, rhr: 50, recovery: 70, sleep_total: 25_000_000,
    sleep_performance: 90, sleep_debt: 0, previous_day_strain: 12,
    respiratory_rate: 15, bedtime_local: '23:00',
  }));
  const scaler = buildScaler(rows, DEFAULT_FEATURES);
  assert.equal(scaler.hrv.stddev, null, '完全相同 → stddev 標成 null');
  assert.equal(distanceBetween(rows[0], rows[1], scaler), null, '沒有可用特徵 → 回 null');
});

// ===========================================================================
// Phase V — 相關
// ===========================================================================

test('★ V: Pearson 手算驗證（完美正相關 / 完美負相關）', () => {
  assert.ok(close(pearson([1, 2, 3, 4, 5], [2, 4, 6, 8, 10]), 1), '完美正相關 = 1');
  assert.ok(close(pearson([1, 2, 3, 4, 5], [10, 8, 6, 4, 2]), -1), '完美負相關 = -1');
  // 手算例子：x=[1,2,3], y=[1,3,2] → r = 0.5
  assert.ok(close(pearson([1, 2, 3], [1, 3, 2]), 0.5), `實際 ${pearson([1, 2, 3], [1, 3, 2])}`);
});

test('★ V: 沒有變異時回 null，不是 0', () => {
  assert.equal(pearson([1, 1, 1], [1, 2, 3]), null);
  assert.equal(pearson([1, 2, 3], [5, 5, 5]), null);
  assert.equal(pearson([1, 2], [1, 2]), null, '樣本太少');
  assert.equal(spearman([1, 1, 1], [1, 2, 3]), null);
});

test('V: rankOf 正確處理並列', () => {
  assert.deepEqual(rankOf([10, 20, 30]), [1, 2, 3]);
  assert.deepEqual(rankOf([10, 10, 30]), [1.5, 1.5, 3], '並列取平均排名');
  assert.deepEqual(rankOf([5, 5, 5, 5]), [2.5, 2.5, 2.5, 2.5]);
});

test('★ V: Spearman 對單調但非線性的關係比 Pearson 敏感', () => {
  const xs = [1, 2, 3, 4, 5];
  const ys = [1, 4, 9, 16, 25]; // 完美單調，但不是線性
  assert.ok(close(spearman(xs, ys), 1), 'Spearman 應該是 1');
  assert.ok(pearson(xs, ys) < 1, 'Pearson 會小於 1');
});

test('V: 資料充分度分級（這不是統計顯著性）', () => {
  assert.equal(dataQualityOf(5), CONFIDENCE.INSUFFICIENT);
  assert.equal(dataQualityOf(9), CONFIDENCE.INSUFFICIENT);
  assert.equal(dataQualityOf(10), CONFIDENCE.LOW);
  assert.equal(dataQualityOf(19), CONFIDENCE.LOW);
  assert.equal(dataQualityOf(20), CONFIDENCE.MODERATE);
  assert.equal(dataQualityOf(39), CONFIDENCE.MODERATE);
  assert.equal(dataQualityOf(40), CONFIDENCE.BETTER);
});

test('V: p-value 對強相關會很小、對無相關會很大', () => {
  const strong = pValue(0.95, 30);
  const none = pValue(0.02, 30);
  assert.ok(strong < 0.01, `強相關 p 應該很小，實際 ${strong}`);
  assert.ok(none > 0.5, `無相關 p 應該很大，實際 ${none}`);
  assert.equal(pValue(null, 30), null);
});

test('★ V: lag 對齊 —— 前一天的 x 對到隔天的 y', () => {
  const x = series('2026-08-01', [1, 2, 3]);
  const y = series('2026-08-01', [10, 20, 30]);
  const { xs, ys, dates } = alignSeries(x, y, { lagDays: 1 });
  assert.deepEqual(xs, [1, 2]);
  assert.deepEqual(ys, [20, 30], '★ x 的第 D 天要對到 y 的第 D+1 天');
  assert.equal(dates[0].x, '2026-08-01');
  assert.equal(dates[0].y, '2026-08-02');
});

test('★ V: 所有輸出都標明是關聯不是因果', () => {
  const r = analyseAssociation({
    xSeries: series('2026-08-01', [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]),
    ySeries: series('2026-08-01', [2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24]),
  });
  assert.equal(r.causal, false, '★ 永遠不可以宣稱因果');
  assert.equal(r.interpretation, 'within-person observed association');
  assert.ok(close(r.pearson, 1));
  assert.equal(r.n, 12);
  assert.equal(r.data_quality, CONFIDENCE.LOW);
  assert.equal(r.direction, 'positive');
});

test('V: 樣本太少時不會硬算相關', () => {
  const r = analyseAssociation({
    xSeries: series('2026-08-01', [1, 2]),
    ySeries: series('2026-08-01', [3, 4]),
  });
  assert.equal(r.pearson, null);
  assert.equal(r.data_quality, CONFIDENCE.INSUFFICIENT);
});

test('★ V: journal 關聯 —— 沒喝酒的日子也要是對照組（x=0）', () => {
  // 30 天，每 5 天喝一次酒；有喝酒的隔天恢復比較低
  const metricSeries = series('2026-08-01', Array.from({ length: 30 }, (_, i) => (
    (i % 5 === 1) ? 50 : 70   // 第 1、6、11… 天恢復低（前一天喝酒）
  )));
  const events = [];
  for (let i = 0; i < 30; i += 5) {
    const d = new Date(Date.parse('2026-08-01T00:00:00Z') + i * DAY).toISOString().slice(0, 10);
    events.push({ category: 'alcohol', health_date: d, numeric_value: 3 });
  }

  const r = journalAssociation({
    journalEvents: events, metricSeries, category: 'alcohol', metricLabel: 'recovery',
  });
  assert.ok(r.exposed_days > 0, '有喝酒的日子');
  assert.ok(r.unexposed_days > 0, '★ 一定要有沒喝酒的對照日，否則相關係數沒有意義');
  assert.equal(r.usable, true);
  assert.ok(r.pearson < 0, `喝酒隔天恢復較低 → 負相關，實際 ${r.pearson}`);
  assert.equal(r.causal, false);
});

test('★ V: 每天都喝或都沒喝 → usable=false（沒有對照組）', () => {
  const metricSeries = series('2026-08-01', Array.from({ length: 20 }, () => 70));
  const r = journalAssociation({
    journalEvents: [], metricSeries, category: 'alcohol', metricLabel: 'recovery',
  });
  assert.equal(r.usable, false, '★ 完全沒有暴露日 → 不可用');
  assert.equal(r.exposed_days, 0);
});

// ===========================================================================
// Phase W — 迴歸
// ===========================================================================

test('W: 解線性方程組', () => {
  // 2x + y = 5, x + 3y = 10  → x=1, y=3
  const sol = solveLinearSystem([[2, 1], [1, 3]], [5, 10]);
  assert.ok(close(sol[0], 1), `x=${sol[0]}`);
  assert.ok(close(sol[1], 3), `y=${sol[1]}`);
  assert.equal(solveLinearSystem([[1, 2], [2, 4]], [1, 2]), null, '奇異矩陣回 null');
});

test('★ W: OLS 能完美還原已知係數 y = 3 + 2*x1 - 1*x2', () => {
  const X = [];
  const y = [];
  for (let i = 0; i < 20; i++) {
    const x1 = i;
    const x2 = (i * 7) % 11;
    X.push([x1, x2]);
    y.push(3 + 2 * x1 - 1 * x2);
  }
  const fit = ordinaryLeastSquares(X, y);
  assert.ok(close(fit.intercept, 3, 1e-6), `intercept=${fit.intercept}`);
  assert.ok(close(fit.coefficients[0], 2, 1e-6), `b1=${fit.coefficients[0]}`);
  assert.ok(close(fit.coefficients[1], -1, 1e-6), `b2=${fit.coefficients[1]}`);
  assert.ok(close(fit.r2, 1, 1e-9), '完全確定的關係 R²=1');
});

test('★ W: 共線性會被偵測出來（VIF）', () => {
  // x2 = 2 * x1 → 完全共線
  const X = Array.from({ length: 20 }, (_, i) => [i, 2 * i + 0.0001 * ((i * 13) % 7)]);
  const vif = varianceInflationFactors(X, ['x1', 'x2']);
  assert.ok(vif.x1 > 10, `x1 VIF 應該很大，實際 ${vif.x1}`);
  assert.ok(vif.x2 > 10);
});

test('★ W: 樣本不足時拒絕擬合，不硬解', () => {
  const rows = Array.from({ length: 6 }, (_, i) => ({
    recovery: 60 + i, sleep_total: 20 + i, previous_day_strain: 10 + i, hrv: 50 + i,
  }));
  const fit = analyzeRecoveryDrivers({
    rows, target: 'recovery', features: ['sleep_total', 'previous_day_strain', 'hrv'],
  });
  assert.equal(fit.ok, false);
  assert.equal(fit.reason, 'insufficient_data');
  assert.ok(fit.required_n > fit.n);
});

test('W: 缺資料的列整列剔除，並回報剔掉幾列', () => {
  const rows = Array.from({ length: 40 }, (_, i) => ({
    recovery: 60 + (i % 10),
    sleep_total: 20 + (i % 7),
    hrv: i % 5 === 0 ? null : 50 + (i % 6),   // 每 5 列缺一次
  }));
  const fit = analyzeRecoveryDrivers({
    rows, target: 'recovery', features: ['sleep_total', 'hrv'],
  });
  assert.equal(fit.dropped_rows, 8, '40 列裡有 8 列缺 hrv');
  assert.equal(fit.n, 32);
});

test('W: 沒有變異的特徵會被剔除並警告', () => {
  const rows = Array.from({ length: 40 }, (_, i) => ({
    recovery: 60 + (i % 9), sleep_total: 20 + (i % 7), constant: 42,
  }));
  const fit = analyzeRecoveryDrivers({
    rows, target: 'recovery', features: ['sleep_total', 'constant'],
  });
  assert.ok(fit.warnings.some((w) => w.includes('constant')));
  assert.deepEqual(fit.features_used, ['sleep_total']);
});

test('★ W: 標準化係數讓不同單位的特徵可以比較', () => {
  const rows = Array.from({ length: 60 }, (_, i) => {
    const sleepMs = 25_000_000 + ((i % 11) - 5) * 600_000; // 量級 10^7
    const hrv = 55 + ((i % 7) - 3);                        // 量級 10^1
    return {
      recovery: 0.000001 * sleepMs + 0.5 * hrv,
      sleep_total: sleepMs,
      hrv,
    };
  });
  const fit = analyzeRecoveryDrivers({
    rows, target: 'recovery', features: ['sleep_total', 'hrv'],
  });
  assert.equal(fit.ok, true);
  assert.ok(fit.standardized_coefficients, '要有標準化係數');
  // 原始係數量級差很多，標準化之後才可比
  assert.ok(Math.abs(fit.coefficients.sleep_total) < Math.abs(fit.coefficients.hrv));
  assert.ok(fit.r2 > 0.99);
  assert.equal(fit.causal, false, '★ 迴歸也不是因果');
});

test('W: predictFrom 用擬合結果預測', () => {
  const rows = Array.from({ length: 40 }, (_, i) => ({
    recovery: 10 + 2 * (i % 13), sleep_total: i % 13,
  }));
  const fit = analyzeRecoveryDrivers({ rows, target: 'recovery', features: ['sleep_total'] });
  assert.ok(close(predictFrom(fit, { sleep_total: 5 }), 20, 1e-6));
  assert.equal(predictFrom(fit, { sleep_total: null }), null, '缺特徵回 null');
  assert.equal(predictFrom({ ok: false }, {}), null);
});

// ===========================================================================
// Phase X — 預測框架
// ===========================================================================

test('★ X: temporalSplit 一定按時間切，測試集永遠在訓練集之後', () => {
  const rows = makeRows('2026-08-01', 40, (i) => ({ recovery: i }));
  const { train: tr, test: te } = temporalSplit(rows, { testRatio: 0.25 });
  assert.equal(tr.length, 30);
  assert.equal(te.length, 10);

  const check = assertNoLeakage(tr, te);
  assert.equal(check.ok, true, '★ 不可以有時間洩漏');
  assert.ok(check.firstTest > check.lastTrain);

  // 洩漏一定要被抓出來
  const leaked = assertNoLeakage(rows, rows);
  assert.equal(leaked.ok, false);
  assert.equal(leaked.reason, 'test_overlaps_train');
});

test('★ X: 打亂順序的切分會被 assertNoLeakage 抓到', () => {
  const rows = makeRows('2026-08-01', 40, (i) => ({ recovery: i }));
  const shuffled = [...rows].sort(() => 0.5 - Math.random());
  const badTrain = shuffled.slice(0, 30);
  const badTest = shuffled.slice(30);
  const check = assertNoLeakage(badTrain, badTest);
  // 隨機切分幾乎必然重疊；就算僥倖沒重疊，也不該用這種方式
  assert.ok(check.ok === false || check.firstTest > check.lastTrain);
});

test('★ X: buildSupervised 用第 D 天的特徵預測第 D+1 天（特徵必須早於結果）', () => {
  const rows = makeRows('2026-08-01', 5, (i) => ({
    recovery: 60 + i, sleep_total: 100 + i, previous_day_strain: 10 + i,
    hrv: 50 + i, rhr: 50, sleep_debt: 0,
  }));
  const samples = buildSupervised(rows, { target: 'recovery' });
  assert.equal(samples.length, 4, '5 天只能造出 4 組（最後一天沒有隔天）');
  assert.equal(samples[0].health_date, '2026-08-02', '結果是隔天');
  assert.equal(samples[0].feature_date, '2026-08-01', '特徵是當天');
  assert.equal(samples[0].recovery, 61, '結果取隔天的值');
  assert.equal(samples[0].sleep_total, 100, '★ 特徵取的是前一天的值');
});

test('★ X: 資料不足時 status=INSUFFICIENT_DATA，絕不硬給預測值', () => {
  const rows = makeRows('2026-08-01', 10, (i) => ({
    recovery: 60 + i, sleep_total: 100 + i, previous_day_strain: 10,
    hrv: 50, rhr: 50, sleep_debt: 0,
  }));
  const model = train(rows);
  assert.equal(model.ok, false);
  assert.equal(model.status, PREDICTION_STATUS.INSUFFICIENT_DATA);
  assert.ok(model.required === MIN_TRAIN_ROWS);

  const p = predict(model, { sleep_total: 100 });
  assert.equal(p.predicted_value, null, '★ 沒有模型就不可以給數字');
  assert.equal(p.predicted_low, null);
  assert.equal(p.status, PREDICTION_STATUS.INSUFFICIENT_DATA);
});

test('X: 資料足夠時可以訓練、預測、評估', () => {
  // 造一個確定性關係：隔天 recovery = 0.5*sleep + 0.3*hrv - 0.4*strain
  const rows = makeRows('2026-06-01', 90, (i) => ({
    sleep_total: 100 + (i % 17),
    hrv: 50 + (i % 11),
    rhr: 50 + (i % 5),
    sleep_debt: (i % 7) * 10,
    previous_day_strain: 8 + (i % 9),
  }));
  for (let i = 0; i < rows.length - 1; i++) {
    rows[i + 1].recovery = 0.5 * rows[i].sleep_total + 0.3 * rows[i].hrv - 0.4 * rows[i].previous_day_strain;
  }
  rows[0].recovery = 60;

  const { train: tr, test: te } = temporalSplit(rows, { testRatio: 0.25 });
  assert.equal(assertNoLeakage(tr, te).ok, true);

  const model = train(tr);
  assert.equal(model.ok, true);
  assert.equal(model.status, PREDICTION_STATUS.OK);

  const testSamples = buildSupervised(te);
  const ev = evaluate(model, testSamples);
  assert.equal(ev.ok, true);
  assert.ok(ev.mae < 1, `關係是確定性的，MAE 應該極小，實際 ${ev.mae}`);
  assert.ok(ev.rmse >= 0);
  assert.ok(ev.interval_coverage >= 0 && ev.interval_coverage <= 1);
  assert.ok(typeof ev.r2 === 'number');
});

test('X: 評估在沒有測試樣本時安全回報', () => {
  assert.equal(evaluate({ ok: true }, []).ok, false);
  assert.equal(evaluate({ ok: false }, [{}]).ok, false);
});
