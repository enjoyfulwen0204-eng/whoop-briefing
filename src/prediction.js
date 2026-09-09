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

/**
 * 直接對**已經配好對**的樣本擬合。
 *
 * ⚠️ 存在的理由（很重要）：`train()` 吃的是原始 daily_metrics，它自己會先
 * 跑一次 buildSupervised。如果把已經配好對的樣本再餵進 train()，
 * buildSupervised 會**再配一次對**——特徵來自 sample[i]、結果來自
 * sample[i+1]，等於把目標整整多推了一天，訓練出來的是一個錯的模型，
 * 而且完全不會報錯。時序切分之後必須用這個函式，不能再走 train()。
 */
export function trainOnSamples(samples, { target = 'recovery', features = DEFAULT_FEATURES } = {}) {
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
  // 區間算不出來時一律回 null，**絕不回 NaN**。
  // NaN 會一路流進 DB（libSQL 直接拒絕）、流進涵蓋率計算（`actual >= NaN`
  // 永遠是 false，靜靜地把涵蓋率壓成 0）。算不出來就誠實說沒有。
  const ssr = num(model.fit?.ss_residual);
  const n = num(model.fit?.n);
  const rmse = ssr !== null && n !== null && n > 0 ? Math.sqrt(ssr / Math.max(1, n)) : null;
  const hasInterval = rmse !== null && Number.isFinite(rmse);

  return {
    status: PREDICTION_STATUS.OK,
    predicted_value: value,
    predicted_low: hasInterval ? value - rmse : null,
    predicted_high: hasInterval ? value + rmse : null,
    interval_kind: hasInterval ? 'rough_residual_sd' : null,
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
  let intervalN = 0;
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
    // 只有真的有區間的樣本才計入涵蓋率。少了這個判斷，`actual >= null`
    // 會被當成 `actual >= 0`（多半為真），涵蓋率就變成一個假數字。
    if (p.predicted_low !== null && p.predicted_high !== null) {
      intervalN += 1;
      if (actual >= p.predicted_low && actual <= p.predicted_high) covered += 1;
    }
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
    // 沒有任何樣本有區間時回 null（不是 0）——「算不出來」與「都沒涵蓋到」
    // 是完全不同的兩件事。
    interval_coverage: intervalN > 0 ? covered / intervalN : null,
    interval_n: intervalN,
    model_version: MODEL_VERSION,
  };
}

// ---------------------------------------------------------------------------
// 樸素基準線（V1.1 Phase 10）
// ---------------------------------------------------------------------------

/**
 * 「就用歷史平均猜」的基準線。
 *
 * ## 為什麼一定要有這個
 *
 * 一個 MAE = 8 的恢復預測到底算好還是爛？在沒有任何真實資料的現在，
 * 這個問題無法回答——但**「它有沒有贏過完全不看特徵、只用歷史平均猜」**
 * 這個問題現在就能回答，而且不需要任何憑空想像的門檻。這正是唯一一個
 * 我們現在就能誠實設定的品質條件。
 *
 * ## 為什麼用訓練集的平均，而不是滾動平均
 *
 * 滾動平均（每一筆測試樣本都用「該日之前的所有資料」）在現實中是合法的
 * ——預測 D+1 時本來就知道 D 的實際值。但那會讓基準線拿到比模型更多的
 * 資訊（模型是凍結在訓練集上的），比較就不公平了。
 *
 * 用**訓練集的平均**則兩邊資訊完全對等，而且百分之百不可能洩漏：
 * 訓練集在時間上整段早於測試集（temporalSplit + assertNoLeakage 保證）。
 */
export function naiveBaseline(trainSamples, { target = 'recovery' } = {}) {
  const values = trainSamples
    .map((s) => num(s[target]))
    .filter((v) => v !== null);
  if (!values.length) return { ok: false, kind: 'train_mean', value: null };
  return { ok: true, kind: 'train_mean', value: mean(values) };
}

/** 基準線在測試集上的 MAE。 */
export function evaluateBaseline(baseline, testSamples, { target = 'recovery' } = {}) {
  if (!baseline?.ok || !testSamples.length) return { ok: false, mae: null, n: 0 };
  const errs = [];
  for (const s of testSamples) {
    const actual = num(s[target]);
    if (actual === null) continue;
    errs.push(Math.abs(actual - baseline.value));
  }
  if (!errs.length) return { ok: false, mae: null, n: 0 };
  return { ok: true, mae: mean(errs), n: errs.length };
}

/**
 * 「要能訓練 **並且** 留一段測試集」所需的最少配對數。
 *
 * 純推導，不是新的門檻：訓練集拿 (1 - testRatio)，要讓它達到
 * MIN_TRAIN_ROWS，總配對數就必須是 MIN_TRAIN_ROWS / (1 - testRatio)。
 */
export function requiredPairsFor(testRatio = 0.25) {
  const trainShare = 1 - testRatio;
  if (!(trainShare > 0)) return MIN_TRAIN_ROWS;
  return Math.ceil(MIN_TRAIN_ROWS / trainShare);
}

/**
 * 完整的「訓練 → 時序切分 → 評估 → 對照基準線」。
 *
 * **絕不 shuffle**，而且每一次都重新斷言沒有時間洩漏——洩漏檢查不是
 * 一次性的設計決定，是每次執行都要通過的條件。
 *
 * @returns 一個可以直接寫進 prediction_models 的評估結果
 */
export function trainEvaluateAndCompare(rows, {
  target = 'recovery', features = DEFAULT_FEATURES, testRatio = 0.25,
} = {}) {
  const samples = buildSupervised(rows, { target, features });

  if (!samples.length) {
    return {
      ok: false, status: PREDICTION_STATUS.INSUFFICIENT_DATA, n_pairs: 0,
      required: requiredPairsFor(testRatio),
    };
  }
  // ★ 要留一段測試集出來，所以總配對數必須比 MIN_TRAIN_ROWS 更多。
  // 這個數字是**推導**出來的，不是另外發明的門檻：訓練集拿到
  // (1 - testRatio) 的比例，要讓它達到 MIN_TRAIN_ROWS，總數就得是
  // MIN_TRAIN_ROWS / (1 - testRatio)。
  //
  // 這也正是「readiness READY」與「模型可評估」的差別：readiness 說的是
  // 「有 30 組配對，夠 train() 跑」，這裡說的是「還要夠切出一個沒被看過的
  // 測試集」。兩者本來就不是同一個問題。
  const requiredPairs = requiredPairsFor(testRatio);
  if (samples.length < requiredPairs) {
    return {
      ok: false,
      status: PREDICTION_STATUS.INSUFFICIENT_DATA,
      n_pairs: samples.length,
      required: requiredPairs,
    };
  }

  const split = temporalSplit(samples, { testRatio });
  const leak = assertNoLeakage(split.train, split.test);
  if (!leak.ok) {
    // 走到這裡代表 temporalSplit 出了嚴重的 bug。寧可完全不輸出，
    // 也絕不用一個可能洩漏的評估去決定要不要發布預測。
    return {
      ok: false,
      status: PREDICTION_STATUS.MODEL_UNAVAILABLE,
      reason: 'temporal_leakage_detected',
      n_pairs: samples.length,
    };
  }

  // 只用訓練集擬合。
  // ★ 必須用 trainOnSamples 而不是 train：split.train 已經是配好對的樣本，
  // 再走 train() 會被 buildSupervised 二次配對，把目標多推一天。
  const model = trainOnSamples(split.train, { target, features });
  if (!model.ok) {
    return {
      ok: false,
      status: model.status,
      reason: model.reason ?? null,
      warnings: model.warnings ?? [],
      n_pairs: samples.length,
      n_train: split.train.length,
    };
  }

  const evaluation = evaluate(model, split.test, { target });
  const baseline = naiveBaseline(split.train, { target });
  const baselineEval = evaluateBaseline(baseline, split.test, { target });

  const dates = (arr) => {
    const d = arr.map((s) => s.health_date).sort();
    return { start: d[0] ?? null, end: d[d.length - 1] ?? null };
  };
  const trainDates = dates(split.train);
  const testDates = dates(split.test);

  const beatsBaseline = evaluation.ok && baselineEval.ok
    ? evaluation.mae < baselineEval.mae
    : null;

  return {
    ok: evaluation.ok === true,
    status: evaluation.ok ? PREDICTION_STATUS.OK : PREDICTION_STATUS.INSUFFICIENT_DATA,
    model,
    model_version: MODEL_VERSION,
    features,
    target,
    n_pairs: samples.length,
    n_train: split.train.length,
    n_test: evaluation.n ?? 0,
    train_start: trainDates.start,
    train_end: trainDates.end,
    test_start: testDates.start,
    test_end: testDates.end,
    boundary_date: split.boundaryDate,
    mae: evaluation.mae ?? null,
    rmse: evaluation.rmse ?? null,
    r2: evaluation.r2 ?? null,
    interval_coverage: evaluation.interval_coverage ?? null,
    baseline_kind: baseline.kind,
    baseline_mae: baselineEval.mae,
    beats_baseline: beatsBaseline,
    leakage_checked: true,
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
