/**
 * 預測框架（Phase X）—— **只有骨架，不訓練 production 模型**。
 *
 * ## 絕對規則：時間序列不可以隨機切分
 *
 * 用未來的資料訓練、再回頭預測過去，會得到漂亮但完全造假的分數。
 * 這裡只提供 temporalSplit()，而且 evaluate 會檢查沒有洩漏。
 *
 * ## 資料不足時
 *
 * status = INSUFFICIENT_DATA，predicted_value = null。
 * **絕不硬輸出一個恢復預測。**
 */

import { num } from './config.js';
import { requireUserId } from './userContext.js';
import { analyzeRecoveryDrivers, predictFrom } from './analytics/regression.js';
import { mean } from './analytics/statistics.js';
import { addDays } from './time.js';
import { log } from './logger.js';

export const MODEL_VERSION = 'linear-v0';

export const PREDICTION_STATUS = {
  OK: 'OK',
  INSUFFICIENT_DATA: 'INSUFFICIENT_DATA',
  MODEL_UNAVAILABLE: 'MODEL_UNAVAILABLE',
};

/** 這一版預設用來預測隔日恢復的特徵（全部是「當天就知道」的量）。 */
export const DEFAULT_FEATURES = [
  'sleep_total', 'previous_day_strain', 'hrv', 'rhr', 'sleep_debt',
];

export const MIN_TRAIN_ROWS = 30;

/**
 * 依日期切分訓練 / 測試。**永遠不 shuffle。**
 * @param {number} testRatio 測試集比例（取時間上最後那一段）
 */
export function temporalSplit(rows, { testRatio = 0.25 } = {}) {
  const sorted = [...rows].sort((a, b) => (a.health_date < b.health_date ? -1 : 1));
  const testSize = Math.max(1, Math.floor(sorted.length * testRatio));
  const cut = sorted.length - testSize;
  return {
    train: sorted.slice(0, cut),
    test: sorted.slice(cut),
    boundaryDate: sorted[cut]?.health_date ?? null,
  };
}

/** 檢查有沒有時間洩漏：測試集的任何一天都不可以早於或等於訓練集的最後一天。 */
export function assertNoLeakage(train, test) {
  if (!train.length || !test.length) return { ok: true, reason: 'empty' };
  const lastTrain = train.map((r) => r.health_date).sort().pop();
  const firstTest = test.map((r) => r.health_date).sort()[0];
  return {
    ok: firstTest > lastTrain,
    lastTrain,
    firstTest,
    reason: firstTest > lastTrain ? null : 'test_overlaps_train',
  };
}

/**
 * 把 daily_metrics 轉成「用第 D 天的特徵預測第 D+1 天的 target」。
 * 這一步是預測與相關性分析的差別所在：特徵必須早於結果。
 */
export function buildSupervised(rows, { target = 'recovery', features = DEFAULT_FEATURES } = {}) {
  const byDate = new Map(rows.map((r) => [r.health_date, r]));
  const out = [];
  for (const r of rows) {
    const nextDate = addDays(r.health_date, 1);
    const next = byDate.get(nextDate);
    if (!next) continue;
    // num() 而不是 Number()：null 會被 Number 變成 0，把缺資料的日子
    // 悄悄當成「值是 0」餵進模型（見 regression.js 的同一個註解）
    const y = num(next[target]);
    if (y === null) continue;
    const sample = { health_date: nextDate, feature_date: r.health_date, [target]: y };
    let usable = true;
    for (const f of features) {
      const v = num(r[f]);
      if (v === null) { usable = false; break; }
      sample[f] = v;
    }
    if (usable) out.push(sample);
  }
  return out;
}

/** 訓練。資料不足就明講，不硬解。 */
export function train(rows, { target = 'recovery', features = DEFAULT_FEATURES } = {}) {
  const samples = buildSupervised(rows, { target, features });
  if (samples.length < MIN_TRAIN_ROWS) {
    return {
      ok: false,
      status: PREDICTION_STATUS.INSUFFICIENT_DATA,
      n: samples.length,
      required: MIN_TRAIN_ROWS,
      model_version: MODEL_VERSION,
    };
  }
  const fit = analyzeRecoveryDrivers({ rows: samples, target, features });
  if (!fit.ok) {
    return {
      ok: false,
      status: PREDICTION_STATUS.MODEL_UNAVAILABLE,
      reason: fit.reason,
      warnings: fit.warnings,
      n: samples.length,
      model_version: MODEL_VERSION,
    };
  }
  return { ok: true, status: PREDICTION_STATUS.OK, fit, n: samples.length, model_version: MODEL_VERSION };
}

/**
 * 預測。
 * 區間用訓練殘差的標準差當粗略估計 —— 明確標成 rough，不是統計上的信賴區間。
 */
export function predict(model, featureValues) {
  if (!model?.ok) {
    return {
      status: model?.status ?? PREDICTION_STATUS.MODEL_UNAVAILABLE,
      predicted_value: null,
      predicted_low: null,
      predicted_high: null,
      model_version: MODEL_VERSION,
    };
  }
  const value = predictFrom(model.fit, featureValues);
  if (value === null) {
    return {
      status: PREDICTION_STATUS.INSUFFICIENT_DATA,
      predicted_value: null,
      predicted_low: null,
      predicted_high: null,
      model_version: MODEL_VERSION,
    };
  }
  const rmse = Math.sqrt(model.fit.ss_residual / Math.max(1, model.fit.n));
  return {
    status: PREDICTION_STATUS.OK,
    predicted_value: value,
    predicted_low: value - rmse,
    predicted_high: value + rmse,
    interval_kind: 'rough_residual_sd',
    model_version: MODEL_VERSION,
    n_train: model.n,
  };
}

/** 評估：MAE / RMSE / R² / 區間涵蓋率。 */
export function evaluate(model, testSamples, { target = 'recovery' } = {}) {
  if (!model?.ok || !testSamples.length) {
    return { ok: false, status: PREDICTION_STATUS.INSUFFICIENT_DATA, n: testSamples.length };
  }
  const errors = [];
  let covered = 0;
  const actuals = [];
  const preds = [];

  for (const s of testSamples) {
    const p = predict(model, s);
    if (p.predicted_value === null) continue;
    const actual = num(s[target]);
    if (actual === null) continue;
    errors.push(actual - p.predicted_value);
    actuals.push(actual);
    preds.push(p.predicted_value);
    if (actual >= p.predicted_low && actual <= p.predicted_high) covered += 1;
  }

  if (!errors.length) return { ok: false, status: PREDICTION_STATUS.INSUFFICIENT_DATA, n: 0 };

  const mae = mean(errors.map(Math.abs));
  const rmse = Math.sqrt(mean(errors.map((e) => e * e)));
  const yMean = mean(actuals);
  const ssTot = actuals.reduce((a, v) => a + (v - yMean) ** 2, 0);
  const ssRes = errors.reduce((a, e) => a + e * e, 0);

  return {
    ok: true,
    status: PREDICTION_STATUS.OK,
    n: errors.length,
    mae,
    rmse,
    r2: ssTot === 0 ? null : 1 - ssRes / ssTot,
    interval_coverage: covered / errors.length,
    model_version: MODEL_VERSION,
  };
}

/** 把一次預測寫進 prediction_runs（之後才能做記分卡）。 */
export async function persistPrediction(db, userId, {
  targetDate, targetMetric = 'recovery', prediction, features,
}, { now = new Date() } = {}) {
  const uid = requireUserId(userId, 'persistPrediction');
  await db.savePrediction(uid, {
    targetDate,
    targetMetric,
    modelVersion: prediction.model_version ?? MODEL_VERSION,
    status: prediction.status,
    features,
    predictedValue: prediction.predicted_value,
    predictedLow: prediction.predicted_low,
    predictedHigh: prediction.predicted_high,
    nTrain: prediction.n_train ?? null,
  }, { now });
  log.info('prediction_saved', {
    target_date: targetDate, status: prediction.status,
  });
  return true;
}

/** 回填實際值。這是預測記分卡的基礎。 */
export async function backfillActuals(db, userId, rows, {
  targetMetric = 'recovery', modelVersion = MODEL_VERSION, now = new Date(),
} = {}) {
  let updated = 0;
  for (const r of rows) {
    const actual = num(r[targetMetric]);
    if (actual === null) continue;
    const ok = await db.recordPredictionActual({
      userId: requireUserId(userId, 'backfillActuals'),
      targetDate: r.health_date, targetMetric, modelVersion, actualValue: actual,
    }, { now });
    if (ok) updated += 1;
  }
  return updated;
}

/** 記分卡：已經有實際值的那些預測表現如何。 */
export async function scorecard(db, userId, { targetMetric = 'recovery' } = {}) {
  const uid = requireUserId(userId, 'scorecard');
  const runs = await db.getPredictions(uid, { targetMetric });
  const evaluated = runs.filter((r) => r.actual_value !== null && r.predicted_value !== null);
  if (!evaluated.length) {
    return { available: false, reason: 'no_evaluated_predictions', total_runs: runs.length };
  }
  const errs = evaluated.map((r) => Number(r.actual_value) - Number(r.predicted_value));
  const covered = evaluated.filter(
    (r) => r.predicted_low !== null
      && Number(r.actual_value) >= Number(r.predicted_low)
      && Number(r.actual_value) <= Number(r.predicted_high),
  ).length;
  return {
    available: true,
    n: evaluated.length,
    mae: mean(errs.map(Math.abs)),
    rmse: Math.sqrt(mean(errs.map((e) => e * e))),
    bias: mean(errs),
    interval_coverage: covered / evaluated.length,
  };
}
