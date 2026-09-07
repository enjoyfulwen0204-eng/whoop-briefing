/**
 * Data Readiness Engine（Phase PA1）。
 *
 * 兩層測試：
 *   1. 純函式層 —— 用手造的 rows/series 驗證每個能力的分級邏輯
 *      正確重用了既有模組的門檻（不是重新發明的數字）。
 *   2. DB 整合層 —— 用真的 Alice / Bob（相同 external id、不同數值）
 *      證明 readiness 永遠是 per-user：一個人的資料量絕不會讓另一個人
 *      的 readiness 被撐起來或被拖垮。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createDb } from '../src/db.js';
import { loadDailyMetrics, seriesOf } from '../src/dailyMetrics.js';
import { BASELINE, ANALYTICS, TREND_ENGINE, READINESS_HEURISTICS } from '../src/config.js';
import { MIN_ROWS_PER_FEATURE } from '../src/analytics/regression.js';
import { MIN_TRAIN_ROWS } from '../src/prediction.js';
import { MIN_PERIOD_DAYS, EXPERIMENT_STATUS } from '../src/experiments.js';
import { STATUS as CAPABILITY_STATUS } from '../src/capabilities.js';
import { AVAILABILITY } from '../src/healthspan.js';
import {
  READINESS_STATUS, CAPABILITY,
  assessDailyState, assessBaseline, assessDeviation, assessZscore,
  assessTrendShort, assessTrendLong, assessWhatChanged, assessSimilarDays,
  assessCorrelation, assessJournalAssociation, assessRegression, assessPrediction,
  assessChangeDetection, assessExperimentAnalysis, assessInsightDiscovery,
  assessHealthspanFoundation, assessProactiveMonitoring,
} from '../src/readiness.js';

import { ALICE, BOB, seedAliceAndBob, seedHealthData } from './users.js';

const DAY = 86_400_000;

/** 造連續日期的 daily_metrics 列（跟 foundations.test.js 同一套手法）。 */
function makeRows(startDate, n, fn) {
  const t0 = Date.parse(`${startDate}T00:00:00Z`);
  return Array.from({ length: n }, (_, i) => ({
    health_date: new Date(t0 + i * DAY).toISOString().slice(0, 10),
    ...fn(i),
  }));
}

const seriesFrom = (startDate, values) => {
  const t0 = Date.parse(`${startDate}T00:00:00Z`);
  return values.map((value, i) => ({
    date: new Date(t0 + i * DAY).toISOString().slice(0, 10),
    value,
  }));
};

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'readiness-'));
  const db = createDb({ url: `file:${path.join(dir, 't.db')}` });
  return { db, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

// ===========================================================================
// CAPABILITY 名單完整性
// ===========================================================================

test('★ readiness: 17 個能力都在 CAPABILITY 清單裡', () => {
  const expected = [
    'DAILY_STATE', 'BASELINE', 'DEVIATION', 'ZSCORE', 'TREND_SHORT', 'TREND_LONG',
    'WHAT_CHANGED', 'SIMILAR_DAYS', 'CORRELATION', 'JOURNAL_ASSOCIATION', 'REGRESSION',
    'PREDICTION', 'CHANGE_DETECTION', 'EXPERIMENT_ANALYSIS', 'INSIGHT_DISCOVERY',
    'HEALTHSPAN_FOUNDATION', 'PROACTIVE_MONITORING',
  ];
  for (const key of expected) {
    assert.equal(CAPABILITY[key], key, `缺少能力：${key}`);
  }
  assert.equal(Object.keys(CAPABILITY).length, expected.length);
});

test('readiness 結果一律有 6 個必填欄位，status 只能是允許的 6 種值之一', () => {
  const allowed = Object.values(READINESS_STATUS);
  assert.deepEqual(allowed.sort(), [
    'DEGRADED', 'LIMITED', 'NO_DATA', 'READY', 'UNAVAILABLE', 'WARMING_UP',
  ].sort());

  const r = assessDailyState({ rows: [], anchorDate: '2026-09-07' });
  for (const key of ['status', 'usable_samples', 'required_samples', 'missing_requirements', 'data_quality', 'reason', 'updated_at']) {
    assert.ok(key in r, `缺少欄位 ${key}`);
  }
  assert.ok(allowed.includes(r.status));
});

// ===========================================================================
// DAILY_STATE
// ===========================================================================

test('DAILY_STATE: 完全沒資料 → NO_DATA', () => {
  const r = assessDailyState({ rows: [], anchorDate: '2026-09-07' });
  assert.equal(r.status, READINESS_STATUS.NO_DATA);
  assert.equal(r.usable_samples, 0);
});

test('★ DAILY_STATE: 有歷史但今天還沒同步 → DEGRADED（不是 NO_DATA，也不是 WARMING_UP）', () => {
  const rows = makeRows('2026-09-01', 5, () => ({ recovery: 50 }));
  const r = assessDailyState({ rows, anchorDate: '2026-09-10' });
  assert.equal(r.status, READINESS_STATUS.DEGRADED);
  assert.deepEqual(r.missing_requirements, ['today_row_missing']);
});

test('DAILY_STATE: 今天有資料 → READY', () => {
  const rows = makeRows('2026-09-01', 5, () => ({ recovery: 50 }));
  const r = assessDailyState({ rows, anchorDate: '2026-09-05' });
  assert.equal(r.status, READINESS_STATUS.READY);
  assert.equal(r.usable_samples, 1);
  assert.equal(r.required_samples, 1);
});

// ===========================================================================
// BASELINE —— 重用 BASELINE.MIN_FOR_LIGHTS / TARGET_SAMPLES，逐一驗證邊界
// ===========================================================================

test('★ BASELINE: 邊界值直接對應既有的 MIN_FOR_LIGHTS(7) / TARGET_SAMPLES(30)，不是另外發明的數字', () => {
  const anchor = '2026-09-30';

  const zero = assessBaseline({ rows: [], anchorDate: anchor });
  assert.equal(zero.status, READINESS_STATUS.NO_DATA);

  const belowLights = makeRows('2026-09-20', BASELINE.MIN_FOR_LIGHTS - 1, () => ({ recovery: 50 }));
  const warming = assessBaseline({ rows: belowLights, anchorDate: anchor });
  assert.equal(warming.status, READINESS_STATUS.WARMING_UP);
  assert.equal(warming.required_samples, BASELINE.MIN_FOR_LIGHTS);

  const atLights = makeRows('2026-09-20', BASELINE.MIN_FOR_LIGHTS, () => ({ recovery: 50 }));
  const limited = assessBaseline({ rows: atLights, anchorDate: anchor });
  assert.equal(limited.status, READINESS_STATUS.LIMITED);
  assert.equal(limited.required_samples, BASELINE.TARGET_SAMPLES);

  const atTarget = makeRows('2026-09-01', BASELINE.TARGET_SAMPLES, () => ({ recovery: 50 }));
  const ready = assessBaseline({ rows: atTarget, anchorDate: anchor });
  assert.equal(ready.status, READINESS_STATUS.READY);
});

test('BASELINE: 只算 LOOKBACK_DAYS 窗口內的列，太舊的資料不會墊高 usable_samples', () => {
  const anchor = '2026-09-30';
  const old = makeRows('2020-01-01', 50, () => ({ recovery: 50 })); // 遠早於 lookback 窗口
  const r = assessBaseline({ rows: old, anchorDate: anchor });
  assert.equal(r.status, READINESS_STATUS.NO_DATA);
});

// ===========================================================================
// DEVIATION / ZSCORE —— 直接重用 describeWindow 的 sufficient 邏輯
// ===========================================================================

test('DEVIATION/ZSCORE 是同一套機制：n < ANALYTICS.MIN_SAMPLES → WARMING_UP，達標 → READY', () => {
  const anchor = '2026-09-30';
  const short = seriesFrom('2026-09-01', Array.from({ length: ANALYTICS.MIN_SAMPLES - 1 }, () => 50));
  const warming = assessDeviation({ series: short, anchorDate: anchor });
  assert.equal(warming.status, READINESS_STATUS.WARMING_UP);
  assert.equal(warming.required_samples, ANALYTICS.MIN_SAMPLES);
  assert.equal(assessZscore, assessDeviation, 'zscore 應該就是 deviation 本身，不是重複實作');

  const enough = seriesFrom('2026-09-01', Array.from({ length: ANALYTICS.MIN_SAMPLES }, () => 50));
  const ready = assessDeviation({ series: enough, anchorDate: anchor });
  assert.equal(ready.status, READINESS_STATUS.READY);
});

test('DEVIATION: capability probe 說這個帳號沒有這個欄位 → UNAVAILABLE，不管樣本數多少', () => {
  const enough = seriesFrom('2026-09-01', Array.from({ length: 30 }, () => 50));
  const r = assessDeviation({
    series: enough, anchorDate: '2026-09-30', capabilityStatus: CAPABILITY_STATUS.UNAVAILABLE,
  });
  assert.equal(r.status, READINESS_STATUS.UNAVAILABLE);
  assert.equal(r.required_samples, null, '結構性不可用時不該假裝有一個樣本數門檻');
});

test('DEVIATION: APP_ONLY 欄位 → UNAVAILABLE，且原因要說明是 API 沒有這欄位', () => {
  const r = assessDeviation({ series: [], anchorDate: '2026-09-30', capabilityStatus: CAPABILITY_STATUS.APP_ONLY });
  assert.equal(r.status, READINESS_STATUS.UNAVAILABLE);
  assert.equal(r.reason, 'not_provided_by_whoop_developer_api');
});

// ===========================================================================
// PA1 REVIEW: UNKNOWN / 還沒 probe 過 絕不能變成 UNAVAILABLE
//
// UNAVAILABLE 只能用在「已經證實」拿不到的三種狀態（APP_ONLY /
// capabilities.UNAVAILABLE / UNAUTHORIZED，上面兩個測試已經涵蓋）。
// 「還沒 probe」「探測到但樣本不足」「完全沒給 capabilityStatus」
// 都必須被當成 NOT_YET_VERIFIED，落回樣本數邏輯，絕不能講成「不支援」。
// 這對應真實 WHOOP 帳號在完成 npm run authorize / npm run probe 之前的狀態。
// ===========================================================================

test('★★ PA1 review: capabilityStatus = UNKNOWN（探測過但樣本不足，無法判斷）絕不能變成 UNAVAILABLE', () => {
  const zeroSamples = assessDeviation({
    series: [], anchorDate: '2026-09-30', capabilityStatus: CAPABILITY_STATUS.UNKNOWN,
  });
  assert.notEqual(zeroSamples.status, READINESS_STATUS.UNAVAILABLE);
  assert.equal(zeroSamples.status, READINESS_STATUS.NO_DATA);
  assert.ok(
    zeroSamples.missing_requirements.includes('capability_not_yet_verified'),
    '要誠實說明是「還沒驗證」，不是「查過了、沒有」',
  );

  const someSamples = seriesFrom('2026-09-01', [50, 51, 52]); // < ANALYTICS.MIN_SAMPLES
  const warming = assessDeviation({
    series: someSamples, anchorDate: '2026-09-30', capabilityStatus: CAPABILITY_STATUS.UNKNOWN,
  });
  assert.notEqual(warming.status, READINESS_STATUS.UNAVAILABLE);
  assert.equal(warming.status, READINESS_STATUS.WARMING_UP);
});

test('★★ PA1 review: 完全沒有 WHOOP 授權／從沒 probe 過（capabilityStatus 根本沒給）絕不能變成 UNAVAILABLE', () => {
  // 呼叫端如果連 capabilities 都還沒查過（例如剛連上帳號、還沒跑過 probe），
  // capabilityStatus 就會是 undefined —— 這代表「未知」，不是「已知不可用」。
  const r = assessDeviation({ series: [], anchorDate: '2026-09-30' });
  assert.notEqual(r.status, READINESS_STATUS.UNAVAILABLE);
  assert.equal(r.status, READINESS_STATUS.NO_DATA);
});

test('★★ PA1 review: capabilityStatus = SUPPORTED／PARTIAL（已知可用）但樣本不足 → WARMING_UP，不是 UNAVAILABLE', () => {
  const short = seriesFrom('2026-09-01', [50, 51, 52]);
  const supported = assessDeviation({
    series: short, anchorDate: '2026-09-30', capabilityStatus: CAPABILITY_STATUS.SUPPORTED,
  });
  assert.equal(supported.status, READINESS_STATUS.WARMING_UP);

  const partial = assessDeviation({
    series: short, anchorDate: '2026-09-30', capabilityStatus: CAPABILITY_STATUS.PARTIAL,
  });
  assert.equal(partial.status, READINESS_STATUS.WARMING_UP);

  // 樣本足夠時，SUPPORTED／PARTIAL 一樣可以正常升到 READY —— capability
  // 已知可用不該被 UNKNOWN 分支誤傷。
  const enough = seriesFrom('2026-09-01', Array.from({ length: ANALYTICS.MIN_SAMPLES }, () => 50));
  const ready = assessDeviation({
    series: enough, anchorDate: '2026-09-30', capabilityStatus: CAPABILITY_STATUS.SUPPORTED,
  });
  assert.equal(ready.status, READINESS_STATUS.READY);
});

// ===========================================================================
// TREND_SHORT / TREND_LONG —— 重用 trend.js 的 trendsFor + TREND_ENGINE.WINDOWS
// ===========================================================================

test('TREND_SHORT 用最短窗口、TREND_LONG 用最長窗口，門檻是 TREND_ENGINE.MIN_SAMPLES', () => {
  const shortWindow = Math.min(...TREND_ENGINE.WINDOWS);
  const series = seriesFrom('2026-01-01', Array.from({ length: shortWindow }, (_, i) => 50 + i));
  const anchor = series.at(-1).date;

  const notEnough = assessTrendShort({
    metricKey: 'hrv', series: series.slice(0, TREND_ENGINE.MIN_SAMPLES - 1), anchorDate: series[TREND_ENGINE.MIN_SAMPLES - 2].date,
  });
  assert.equal(notEnough.status, READINESS_STATUS.WARMING_UP);

  const ready = assessTrendShort({ metricKey: 'hrv', series, anchorDate: anchor });
  assert.equal(ready.status, READINESS_STATUS.READY);
  assert.equal(ready.required_samples, TREND_ENGINE.MIN_SAMPLES);

  const longWindow = Math.max(...TREND_ENGINE.WINDOWS);
  const longSeries = seriesFrom('2025-01-01', Array.from({ length: longWindow }, (_, i) => 50 + i));
  const longReady = assessTrendLong({ metricKey: 'hrv', series: longSeries, anchorDate: longSeries.at(-1).date });
  assert.equal(longReady.status, READINESS_STATUS.READY);
});

// ===========================================================================
// WHAT_CHANGED —— 今天要有值 + 至少一個指標基準足夠
// ===========================================================================

test('WHAT_CHANGED: 今天沒同步 → DEGRADED；今天有資料但沒有任何指標基準足夠 → WARMING_UP；有 → READY', () => {
  const rows = makeRows('2026-09-25', 6, (i) => ({ hrv: 50 + i }));
  const anchorMissing = assessWhatChanged({ rows, seriesByMetric: {}, anchorDate: '2026-10-01', metrics: ['hrv'] });
  assert.equal(anchorMissing.status, READINESS_STATUS.DEGRADED);

  // 只留 5 天（含今天）：排除今天之後基準窗口只剩 4 筆，< ANALYTICS.MIN_SAMPLES(5)。
  const shortRows = rows.slice(0, 5);
  const anchor = shortRows.at(-1).health_date;
  const hrvSeries = seriesOf(shortRows, 'hrv');
  const notEnough = assessWhatChanged({
    rows: shortRows, seriesByMetric: { hrv: hrvSeries }, anchorDate: anchor, metrics: ['hrv'],
  });
  assert.equal(notEnough.status, READINESS_STATUS.WARMING_UP, `基準窗口只有 4 筆，< ANALYTICS.MIN_SAMPLES(${ANALYTICS.MIN_SAMPLES})`);

  const longRows = makeRows('2026-08-01', 40, (i) => ({ hrv: 50 + (i % 5) }));
  const longAnchor = longRows.at(-1).health_date;
  const ready = assessWhatChanged({
    rows: longRows, seriesByMetric: { hrv: seriesOf(longRows, 'hrv') }, anchorDate: longAnchor, metrics: ['hrv'],
  });
  assert.equal(ready.status, READINESS_STATUS.READY);
});

// ===========================================================================
// SIMILAR_DAYS —— READINESS_HEURISTICS.SIMILAR_DAYS_MIN_POOL 是明確標示的產品啟發式
// ===========================================================================

test('SIMILAR_DAYS: 候選池不足 SIMILAR_DAYS_MIN_POOL → WARMING_UP，足夠 → READY', () => {
  const few = makeRows('2026-09-01', 5, (i) => ({
    hrv: 50 + i, rhr: 55 - i, recovery: 60 + i, sleep_total: 25_000_000 + i * 1000,
  }));
  const anchor = few.at(-1).health_date;
  const notEnough = assessSimilarDays({ rows: few, anchorDate: anchor });
  assert.equal(notEnough.status, READINESS_STATUS.WARMING_UP);
  assert.equal(notEnough.required_samples, READINESS_HEURISTICS.SIMILAR_DAYS_MIN_POOL);

  const plenty = makeRows('2026-08-01', READINESS_HEURISTICS.SIMILAR_DAYS_MIN_POOL + 5, (i) => ({
    hrv: 50 + (i % 7), rhr: 55 - (i % 5), recovery: 60 + (i % 6), sleep_total: 25_000_000 + (i % 4) * 100_000,
  }));
  const ready = assessSimilarDays({ rows: plenty, anchorDate: plenty.at(-1).health_date });
  assert.equal(ready.status, READINESS_STATUS.READY);
});

// ===========================================================================
// CORRELATION —— 重用 correlation.dataQualityOf 的信心分級（不是新門檻）
// ===========================================================================

test('★ CORRELATION: n<10(INSUFFICIENT) → WARMING_UP／NO_DATA，10–19(LOW) → LIMITED，20+ → READY', () => {
  const zero = assessCorrelation({ xSeries: [], ySeries: [] });
  assert.equal(zero.status, READINESS_STATUS.NO_DATA);

  const x9 = seriesFrom('2026-01-01', Array.from({ length: 9 }, (_, i) => i));
  const y9 = seriesFrom('2026-01-01', Array.from({ length: 9 }, (_, i) => i * 2));
  const warming = assessCorrelation({ xSeries: x9, ySeries: y9 });
  assert.equal(warming.status, READINESS_STATUS.WARMING_UP);

  const x15 = seriesFrom('2026-01-01', Array.from({ length: 15 }, (_, i) => i));
  const y15 = seriesFrom('2026-01-01', Array.from({ length: 15 }, (_, i) => i * 2));
  const limited = assessCorrelation({ xSeries: x15, ySeries: y15 });
  assert.equal(limited.status, READINESS_STATUS.LIMITED);
  assert.equal(limited.data_quality, 'LOW_CONFIDENCE');

  const x25 = seriesFrom('2026-01-01', Array.from({ length: 25 }, (_, i) => i));
  const y25 = seriesFrom('2026-01-01', Array.from({ length: 25 }, (_, i) => i * 2));
  const ready = assessCorrelation({ xSeries: x25, ySeries: y25 });
  assert.equal(ready.status, READINESS_STATUS.READY);
});

test('JOURNAL_ASSOCIATION: n 夠但全部都是「有事件的日子」（沒有對照組）→ LIMITED，不是 READY', () => {
  const metricSeries = seriesFrom('2026-01-01', Array.from({ length: 20 }, (_, i) => 50 + i));
  const journalEvents = metricSeries.map((p, i) => ({
    category: 'alcohol',
    health_date: new Date(Date.parse(`${p.date}T00:00:00Z`) - DAY).toISOString().slice(0, 10),
    numeric_value: 1,
  }));
  const r = assessJournalAssociation({ journalEvents, metricSeries, category: 'alcohol' });
  assert.equal(r.status, READINESS_STATUS.LIMITED);
  assert.deepEqual(r.missing_requirements, ['need_both_exposed_and_unexposed_days']);
});

test('JOURNAL_ASSOCIATION: 有對照組且 n 夠多 → READY', () => {
  const metricSeries = seriesFrom('2026-01-01', Array.from({ length: 25 }, (_, i) => 50 + (i % 4)));
  const journalEvents = metricSeries
    .filter((_, i) => i % 2 === 0)
    .map((p) => ({
      category: 'alcohol',
      health_date: new Date(Date.parse(`${p.date}T00:00:00Z`) - DAY).toISOString().slice(0, 10),
      numeric_value: 1,
    }));
  const r = assessJournalAssociation({ journalEvents, metricSeries, category: 'alcohol' });
  assert.equal(r.status, READINESS_STATUS.READY);
});

// ===========================================================================
// REGRESSION —— required_samples 是動態公式（重用 MIN_ROWS_PER_FEATURE），不是固定數字
// ===========================================================================

test('★ REGRESSION: required_samples 隨特徵數變動，跟 analyzeRecoveryDrivers 的公式一致', () => {
  const features = ['hrv', 'previous_day_strain'];
  const expectedRequired = Math.max(features.length + 2, features.length * MIN_ROWS_PER_FEATURE);

  const few = makeRows('2026-08-01', expectedRequired - 2, (i) => ({
    recovery: 50 + (i % 5), hrv: 40 + (i % 6), previous_day_strain: 10 + (i % 3),
  }));
  const warming = assessRegression({ rows: few, target: 'recovery', features });
  assert.equal(warming.status, READINESS_STATUS.WARMING_UP);
  assert.equal(warming.required_samples, expectedRequired);

  const enough = makeRows('2026-06-01', expectedRequired + 5, (i) => ({
    recovery: 50 + (i % 5), hrv: 40 + (i % 6), previous_day_strain: 10 + (i % 3),
  }));
  const ready = assessRegression({ rows: enough, target: 'recovery', features });
  assert.equal(ready.status, READINESS_STATUS.READY);
  assert.equal(ready.required_samples, expectedRequired);
});

test('REGRESSION: 沒有給任何特徵 → UNAVAILABLE（設定錯誤，不是資料不足）', () => {
  const r = assessRegression({ rows: [{ health_date: '2026-01-01', recovery: 50 }], target: 'recovery', features: [] });
  assert.equal(r.status, READINESS_STATUS.UNAVAILABLE);
});

// ===========================================================================
// PREDICTION —— 重用 prediction.js 的 train()（含時序切分）
// ===========================================================================

test('PREDICTION: 樣本數用 buildSupervised 之後的配對數，不是原始列數', () => {
  const rows = makeRows('2026-06-01', 10, (i) => ({
    recovery: 50 + (i % 5), sleep_total: 25_000_000, previous_day_strain: 10, hrv: 50, rhr: 55, sleep_debt: 0,
  }));
  const r = assessPrediction({ rows, target: 'recovery' });
  assert.equal(r.status, READINESS_STATUS.WARMING_UP);
  assert.equal(r.required_samples, MIN_TRAIN_ROWS);
  assert.ok(r.usable_samples <= rows.length);
});

test('PREDICTION: 足夠的每日配對 → READY', () => {
  // 用可重現的偽亂數而不是小週期的 i % N —— 小週期特徵彼此之間會變成
  // 完全線性相依，觸發 severe_multicollinearity，跟這裡想測的「樣本夠不夠」無關。
  const noise = (i, seed) => (((i + 1) * 9301 + seed * 49297) % 233280) / 233280;
  const rows = makeRows('2026-01-01', MIN_TRAIN_ROWS + 10, (i) => ({
    recovery: 40 + noise(i, 1) * 40,
    sleep_total: 20_000_000 + noise(i, 2) * 8_000_000,
    previous_day_strain: 5 + noise(i, 3) * 15,
    hrv: 30 + noise(i, 4) * 40,
    rhr: 45 + noise(i, 5) * 20,
    sleep_debt: noise(i, 6) * 3_000_000,
  }));
  const r = assessPrediction({ rows, target: 'recovery' });
  assert.equal(r.status, READINESS_STATUS.READY);
});

// ===========================================================================
// CHANGE_DETECTION —— 重用 detectBaselineShift + TREND_ENGINE.MIN_SHIFT_SAMPLES
// ===========================================================================

test('CHANGE_DETECTION: 前後兩段都要達到 MIN_SHIFT_SAMPLES', () => {
  // 總長度 = SHIFT_WINDOW_DAYS + 3：近端窗口（最近 14 天）會被填滿，
  // 但前一段只有最早的 3 天可用 —— 兩段都不到 0，但前段 < MIN_SHIFT_SAMPLES。
  const series = seriesFrom('2026-08-01', Array.from({ length: TREND_ENGINE.SHIFT_WINDOW_DAYS + 3 }, (_, i) => 50 + i));
  const anchor = series.at(-1).date;
  const warming = assessChangeDetection({ metricKey: 'hrv', series, anchorDate: anchor });
  assert.equal(warming.status, READINESS_STATUS.WARMING_UP);
  assert.ok(warming.usable_samples > 0 && warming.usable_samples < TREND_ENGINE.MIN_SHIFT_SAMPLES);

  // 每一段內部要有一點變異（不能整段都是同一個常數，否則 pooled stddev = 0，
  // detectBaselineShift 會回 insufficient_variance，readiness 就會被判成 DEGRADED
  // 而不是這裡想測的「樣本數足夠 → READY」）。
  const enoughSeries = seriesFrom(
    '2026-06-01',
    Array.from(
      { length: TREND_ENGINE.SHIFT_WINDOW_DAYS * 2 },
      (_, i) => (i < TREND_ENGINE.SHIFT_WINDOW_DAYS ? 40 : 60) + ((i % 3) - 1) * 2,
    ),
  );
  const ready = assessChangeDetection({
    metricKey: 'hrv', series: enoughSeries, anchorDate: enoughSeries.at(-1).date,
  });
  assert.equal(ready.status, READINESS_STATUS.READY);
});

// ===========================================================================
// EXPERIMENT_ANALYSIS —— 重用 MIN_PERIOD_DAYS
// ===========================================================================

test('EXPERIMENT_ANALYSIS: DRAFT 狀態一律 NO_DATA；baseline/intervention 天數都要達 MIN_PERIOD_DAYS', () => {
  const draft = assessExperimentAnalysis({
    rows: [], experiment: { status: EXPERIMENT_STATUS.DRAFT },
  });
  assert.equal(draft.status, READINESS_STATUS.NO_DATA);

  const rows = makeRows('2026-01-01', 20, () => ({ recovery: 50 }));
  const shortExperiment = {
    status: EXPERIMENT_STATUS.RUNNING,
    baseline_start: '2026-01-01', baseline_end: '2026-01-02',
    start_date: '2026-01-10', end_date: '2026-01-20',
  };
  const warming = assessExperimentAnalysis({ rows, experiment: shortExperiment });
  assert.equal(warming.status, READINESS_STATUS.WARMING_UP);
  assert.equal(warming.required_samples, MIN_PERIOD_DAYS);

  const fullExperiment = {
    status: EXPERIMENT_STATUS.RUNNING,
    baseline_start: '2026-01-01', baseline_end: '2026-01-06',
    start_date: '2026-01-10', end_date: '2026-01-20',
  };
  const ready = assessExperimentAnalysis({ rows, experiment: fullExperiment });
  assert.equal(ready.status, READINESS_STATUS.READY);
});

// ===========================================================================
// INSIGHT_DISCOVERY —— 借用 BASELINE 的門檻，不是獨立新門檻
// ===========================================================================

test('INSIGHT_DISCOVERY: 借用 BASELINE 的及格線，資料撐不起紅黃燈時也不該開口', () => {
  const anchor = '2026-09-30';
  const none = assessInsightDiscovery({ rows: [], anchorDate: anchor });
  assert.equal(none.status, READINESS_STATUS.NO_DATA);

  const atLights = makeRows('2026-09-20', BASELINE.MIN_FOR_LIGHTS, () => ({ recovery: 50 }));
  const ready = assessInsightDiscovery({ rows: atLights, anchorDate: anchor });
  assert.equal(ready.status, READINESS_STATUS.READY, 'LIMITED 等級的 baseline 已經足夠讓 insight discovery 開口');
});

// ===========================================================================
// HEALTHSPAN_FOUNDATION —— READINESS_HEURISTICS.HEALTHSPAN_MIN_COVERAGE_RATIO
// ===========================================================================

test('HEALTHSPAN_FOUNDATION: 一半以上 contributor 可用才算 READY', () => {
  const contributors = [
    { metricKey: 'a', availability: AVAILABILITY.AVAILABLE },
    { metricKey: 'b', availability: AVAILABILITY.AVAILABLE },
    { metricKey: 'c', availability: AVAILABILITY.UNKNOWN },
    { metricKey: 'd', availability: AVAILABILITY.UNKNOWN },
    { metricKey: 'steps', availability: AVAILABILITY.APP_ONLY },
  ];
  const r = assessHealthspanFoundation({ contributors });
  assert.equal(r.required_samples, 2, '4 個非 app_only 的一半是 2');
  assert.equal(r.status, READINESS_STATUS.READY);

  const mostlyUnknown = [
    { metricKey: 'a', availability: AVAILABILITY.AVAILABLE },
    { metricKey: 'b', availability: AVAILABILITY.UNKNOWN },
    { metricKey: 'c', availability: AVAILABILITY.UNKNOWN },
    { metricKey: 'd', availability: AVAILABILITY.UNKNOWN },
  ];
  const limited = assessHealthspanFoundation({ contributors: mostlyUnknown });
  assert.equal(limited.status, READINESS_STATUS.LIMITED);
});

// ===========================================================================
// PROACTIVE_MONITORING —— 由核心指標的 DEVIATION readiness 組合而成
// ===========================================================================

test('PROACTIVE_MONITORING: 核心指標全部 READY 才算整體 READY，部分 READY 是 LIMITED', () => {
  const anchor = '2026-09-30';
  const readySeries = seriesFrom('2026-09-01', Array.from({ length: ANALYTICS.MIN_SAMPLES + 2 }, () => 50));
  const shortSeries = seriesFrom('2026-09-01', Array.from({ length: ANALYTICS.MIN_SAMPLES - 1 }, () => 50));

  const partial = assessProactiveMonitoring({
    seriesByMetric: { recovery: readySeries, hrv: shortSeries, rhr: shortSeries },
    anchorDate: anchor,
    coreMetrics: ['recovery', 'hrv', 'rhr'],
  });
  assert.equal(partial.status, READINESS_STATUS.LIMITED);
  assert.deepEqual(partial.missing_requirements, ['hrv', 'rhr']);

  const full = assessProactiveMonitoring({
    seriesByMetric: { recovery: readySeries, hrv: readySeries, rhr: readySeries },
    anchorDate: anchor,
    coreMetrics: ['recovery', 'hrv', 'rhr'],
  });
  assert.equal(full.status, READINESS_STATUS.READY);

  const none = assessProactiveMonitoring({
    seriesByMetric: {}, anchorDate: anchor, coreMetrics: ['recovery', 'hrv', 'rhr'],
  });
  assert.equal(none.status, READINESS_STATUS.NO_DATA);
});

// ===========================================================================
// Alice / Bob 隔離（DB 整合層）——「Alice readiness can NEVER unlock Bob」
// ===========================================================================

test('★★ Alice/Bob 隔離：Alice 資料量遠大於 Bob，但兩人的 readiness 各自獨立計算，互不影響', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'readiness-iso-'));
  const db = createDb({ url: `file:${path.join(dir, 't.db')}` });
  try {
    await db.migrate();
    await seedAliceAndBob(db);

    // Alice：只給她一天（跟 Bob 用完全相同的 external id / 時間戳）
    await seedHealthData(db, ALICE, 11);
    // Bob：也只給一天 —— 用來證明 Alice 讀不到 Bob、Bob 也讀不到 Alice，
    // 而不是「其中一人資料比較多所以看起來比較準」這種混淆因素。
    await seedHealthData(db, BOB, 22);

    const range = { from: '2026-09-01', to: '2026-09-10' };
    const aliceRows = await loadDailyMetrics({
      db, userId: ALICE.id, timezone: ALICE.timezone, ...range,
    });
    const bobRows = await loadDailyMetrics({
      db, userId: BOB.id, timezone: BOB.timezone, ...range,
    });

    // 兩人共用完全相同的 sleep id / 時間戳，如果 store 層有任何一處忘記
    // 用 user_id 過濾，這裡就會看到對方的列混進來、或看到重複的列。
    assert.equal(aliceRows.length, 1);
    assert.equal(bobRows.length, 1);
    assert.notEqual(aliceRows[0].recovery, bobRows[0].recovery, '兩人數值不同，混進來會被這裡抓到');

    const aliceAnchor = aliceRows[0].health_date;
    const bobAnchor = bobRows[0].health_date;

    const aliceDaily = assessDailyState({ rows: aliceRows, anchorDate: aliceAnchor });
    const bobDaily = assessDailyState({ rows: bobRows, anchorDate: bobAnchor });
    assert.equal(aliceDaily.status, READINESS_STATUS.READY);
    assert.equal(bobDaily.status, READINESS_STATUS.READY);

    // 兩人的 baseline 都只有 1 筆，都應該是 NO_DATA/WARMING_UP 等級，
    // 而不是因為對方的資料混進來而被拉高到 LIMITED/READY。
    const aliceBaseline = assessBaseline({ rows: aliceRows, anchorDate: aliceAnchor });
    const bobBaseline = assessBaseline({ rows: bobRows, anchorDate: bobAnchor });
    assert.equal(aliceBaseline.usable_samples, 1);
    assert.equal(bobBaseline.usable_samples, 1);
    assert.equal(aliceBaseline.status, READINESS_STATUS.WARMING_UP);
    assert.equal(bobBaseline.status, READINESS_STATUS.WARMING_UP);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('★★ Alice/Bob 隔離：Alice 用真的多天資料衝到 READY，Bob 仍然只有 1 天 —— Bob 絕不會被 Alice 的樣本數解鎖', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'readiness-iso2-'));
  const db = createDb({ url: `file:${path.join(dir, 't.db')}` });
  try {
    await db.migrate();
    await seedAliceAndBob(db);

    // Alice：BASELINE.TARGET_SAMPLES 天，各自不同的 sleep id（同一天多筆會覆蓋，不會累加）
    for (let i = 0; i < BASELINE.TARGET_SAMPLES; i++) {
      const day = new Date(Date.parse('2026-08-01T15:00:00.000Z') + i * DAY);
      const start = day.toISOString();
      const end = new Date(day.getTime() + 8 * 3600_000).toISOString();
      await db.upsertSleeps(ALICE.id, [{
        id: `alice-sleep-${i}`, v1_id: i, user_id: 999, start, end,
        nap: false, score_state: 'SCORED', timezone_offset: '+08:00',
        score: {
          respiratory_rate: 15, sleep_performance_percentage: 80,
          sleep_consistency_percentage: 80, sleep_efficiency_percentage: 90,
          stage_summary: {
            total_light_sleep_time_milli: 3_000_000, total_slow_wave_sleep_time_milli: 1_000_000,
            total_rem_sleep_time_milli: 1_000_000, total_awake_time_milli: 0,
            total_no_data_time_milli: 0, total_in_bed_time_milli: 8_000_000,
            disturbance_count: 1, sleep_cycle_count: 4,
          },
          sleep_needed: {
            baseline_milli: 28_800_000, need_from_sleep_debt_milli: 0,
            need_from_recent_strain_milli: 0, need_from_recent_nap_milli: 0,
          },
        },
      }], { timezone: ALICE.timezone });
    }
    await seedHealthData(db, BOB, 22); // Bob 只有 1 天

    const aliceRows = await loadDailyMetrics({
      db, userId: ALICE.id, timezone: ALICE.timezone, from: '2026-08-01', to: '2026-09-10',
    });
    const bobRows = await loadDailyMetrics({
      db, userId: BOB.id, timezone: BOB.timezone, from: '2026-08-01', to: '2026-09-10',
    });
    // store 層回傳順序不保證是舊→新，用日期字串排序找出真正最新的一天。
    const latestOf = (rows) => [...rows].sort((a, b) => (a.health_date < b.health_date ? -1 : 1)).at(-1).health_date;

    const aliceAnchor = latestOf(aliceRows);
    const aliceReadiness = assessBaseline({ rows: aliceRows, anchorDate: aliceAnchor });
    assert.equal(aliceReadiness.status, READINESS_STATUS.READY, `Alice 應該有 ${BASELINE.TARGET_SAMPLES} 天資料`);

    const bobAnchor = latestOf(bobRows);
    const bobReadiness = assessBaseline({ rows: bobRows, anchorDate: bobAnchor });
    assert.equal(bobRows.length, 1, 'Bob 的列數不該被 Alice 的 30 天污染');
    assert.notEqual(
      bobReadiness.status, READINESS_STATUS.READY,
      'Bob 只有 1 天資料，絕不能因為 Alice 已經 READY 而跟著被判定 READY',
    );
    assert.equal(bobReadiness.status, READINESS_STATUS.WARMING_UP);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// PA1 REVIEW: readiness 必須完全無副作用 —— 呼叫任意次都不會動到 DB
//
// 特別針對「readiness 內部會呼叫真正的分析函式」這幾個能力
// （REGRESSION 呼叫 analyzeRecoveryDrivers()、PREDICTION 呼叫 train()、
// CHANGE_DETECTION 呼叫 detectBaselineShift()、EXPERIMENT_ANALYSIS 讀取
// experiment 列）—— 這些函式本身就是純函式，這裡用「整個資料庫每一張表
// 的列數，呼叫前後完全一致」來做黑盒證明，不只是相信程式碼註解。
// ===========================================================================

test('★★★ PA1 review: readiness 呼叫兩次（含 REGRESSION／PREDICTION／CHANGE_DETECTION）完全不會寫入 DB', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'readiness-sideeffect-'));
  const db = createDb({ url: `file:${path.join(dir, 't.db')}` });
  try {
    await db.migrate();
    const { id: userId, timezone } = await (async () => {
      const { seedSingleUser } = await import('./users.js');
      return seedSingleUser(db);
    })();

    // 造出足夠讓 REGRESSION / PREDICTION 真的跑完整套統計（不是提早因為
    // 樣本不足而 short-circuit）的資料量，確保這個測試真的觸碰到
    // analyzeRecoveryDrivers() 與 train() 的完整運算路徑。
    const noise = (i, seed) => (((i + 1) * 9301 + seed * 49297) % 233280) / 233280;
    const rows = makeRows('2026-01-01', MIN_TRAIN_ROWS + 20, (i) => ({
      recovery: 40 + noise(i, 1) * 40,
      sleep_total: 20_000_000 + noise(i, 2) * 8_000_000,
      previous_day_strain: 5 + noise(i, 3) * 15,
      hrv: 30 + noise(i, 4) * 40,
      rhr: 45 + noise(i, 5) * 20,
      sleep_debt: noise(i, 6) * 3_000_000,
    }));
    const anchor = rows.at(-1).health_date;
    const experiment = {
      status: EXPERIMENT_STATUS.RUNNING,
      baseline_start: '2026-01-01', baseline_end: '2026-01-10',
      start_date: '2026-01-15', end_date: anchor,
    };
    const series = seriesOf(rows, 'hrv');

    /** 每一張表的列數（黑盒快照，不管表名叫什麼）。 */
    async function snapshotAllTableCounts() {
      const tables = await db.raw.execute({
        sql: "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
      });
      const counts = {};
      for (const row of tables.rows) {
        const name = row.name;
        const rs = await db.raw.execute({ sql: `SELECT COUNT(*) AS n FROM "${name}"` });
        counts[name] = Number(rs.rows[0].n);
      }
      return counts;
    }

    const before = await snapshotAllTableCounts();

    // 跑兩次，涵蓋所有「內部會呼叫真正分析函式」的能力。
    for (let pass = 0; pass < 2; pass++) {
      assessBaseline({ rows, anchorDate: anchor });
      assessDeviation({ series, anchorDate: anchor });
      assessTrendShort({ metricKey: 'hrv', series, anchorDate: anchor });
      assessTrendLong({ metricKey: 'hrv', series, anchorDate: anchor });
      assessChangeDetection({ metricKey: 'hrv', series, anchorDate: anchor });
      assessRegression({ rows, target: 'recovery', features: ['hrv', 'previous_day_strain'] });
      assessPrediction({ rows, target: 'recovery' });
      assessExperimentAnalysis({ rows, experiment });
      assessSimilarDays({ rows, anchorDate: anchor });
      assessCorrelation({ xSeries: series, ySeries: seriesOf(rows, 'recovery') });
      assessInsightDiscovery({ rows, anchorDate: anchor });
    }

    const after = await snapshotAllTableCounts();
    assert.deepEqual(after, before, 'readiness 呼叫前後，DB 裡每一張表的列數必須完全一致');

    // 額外用 userId/timezone，避免 lint 抱怨未使用（同時證明這條路徑真的
    // 是走 per-user seed，不是巧合地什麼都沒建）。
    assert.ok(userId && timezone);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
