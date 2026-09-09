/**
 * 預測的生產迴圈（V1.1 Phase 10）。
 *
 * 在這之前，prediction.js 的數學是完整的（時序切分、洩漏斷言、MAE/RMSE/R²、
 * 記分卡），但**沒有任何地方呼叫 persistPrediction 或 backfillActuals**——
 * 所以 prediction_runs 永遠是空的，記分卡永遠算不出東西，整條路是死的。
 *
 * 這個檔案把它接起來：
 *
 *   daily_metrics
 *     → buildSupervised（D 天特徵 → D+1 結果）
 *     → temporalSplit + assertNoLeakage
 *     → 訓練（只用訓練集）
 *     → 評估 + 對照樸素基準線
 *     → 判定成熟度與是否合格（predictionPolicy，fail-closed）
 *     → 寫進 prediction_models
 *     → 產生明天的候選預測 → 寫進 prediction_runs
 *     → 回填已經知道實際值的舊預測
 *
 * ## 發布是關著的，而且是刻意的
 *
 * 候選預測**照樣算、照樣存**（不然永遠不會有記分卡，也永遠無法證明模型
 * 好不好）。但要不要把數字**拿給使用者看**，是完全獨立的一道閘門
 * （predictionPolicy.publishableValue）。目前品質門檻全部是 null =
 * 尚未設定 = 一律不合格，所以現在沒有任何預測數字會被發布。
 *
 * 「算出來並存起來」與「拿給使用者看」是兩件事——把它們混在一起，就會
 * 變成「因為還不能給看，所以乾脆不算」，然後永遠不會有資料證明它能不能給看。
 */

import { addDays } from './time.js';
import { num } from './config.js';
import {
  trainEvaluateAndCompare, predict, persistPrediction, backfillActuals,
  DEFAULT_FEATURES, MODEL_VERSION, PREDICTION_STATUS, requiredPairsFor,
} from './prediction.js';
import {
  PREDICTION_MATURITY, PREDICTION_POLICY_VERSION, PREDICTION_QUALITY_POLICY,
  qualifyModel, isStale, publishableValue,
} from './predictionPolicy.js';
import { requireUserId } from './userContext.js';
import { log, describeError } from './logger.js';

/**
 * 由「訓練評估結果」推導成熟度。**純函式。**
 *
 * 這裡刻意不看 readiness——readiness 回答的是「資料夠不夠訓練」，
 * 這裡回答的是「訓練出來的東西處於哪一階」。兩者是不同的問題。
 */
export function maturityOf(run, {
  anchorDate = null, policy = PREDICTION_QUALITY_POLICY, capabilityUnavailable = false,
} = {}) {
  if (capabilityUnavailable) {
    return {
      maturity: PREDICTION_MATURITY.UNSUPPORTED,
      qualified: false,
      reasons: ['target_metric_unavailable_for_this_account'],
    };
  }
  if (!run || run.n_pairs === 0) {
    return { maturity: PREDICTION_MATURITY.NO_DATA, qualified: false, reasons: ['no_day_pairs'] };
  }
  if (run.status === PREDICTION_STATUS.INSUFFICIENT_DATA && !run.ok) {
    return {
      maturity: PREDICTION_MATURITY.INSUFFICIENT_DATA,
      qualified: false,
      reasons: [`need_${Math.max(0, (run.required ?? requiredPairsFor()) - (run.n_pairs ?? 0))}_more_day_pairs`],
    };
  }
  if (run.status === PREDICTION_STATUS.MODEL_UNAVAILABLE) {
    return {
      maturity: PREDICTION_MATURITY.MODEL_UNAVAILABLE,
      qualified: false,
      reasons: [run.reason ?? 'model_unavailable'],
    };
  }

  const verdict = qualifyModel(run, { policy });

  // 過期優先於「合格」：一個訓練期已經滑出目前基準窗的模型，
  // 就算當初評估得很好也不該再被當成現在的模型。
  if (anchorDate && isStale(run.train_end, anchorDate, { policy })) {
    return {
      maturity: PREDICTION_MATURITY.STALE,
      qualified: false,
      reasons: [...verdict.reasons, `train_end_older_than_${policy.STALE_AFTER_DAYS}_days`],
    };
  }
  return verdict;
}

/**
 * 跑一次完整的預測迴圈。
 *
 * **永遠不拋錯**：預測是附加能力，絕不能拖垮簡報或同步。
 *
 * @param {object[]} rows daily_metrics（呼叫端已經用 userId 撈好）
 * @param {string} anchorDate 目前最新的 health_date
 */
export async function runPredictionCycle({
  db, userId, rows = [], anchorDate = null,
  target = 'recovery', features = DEFAULT_FEATURES,
  policy = PREDICTION_QUALITY_POLICY,
  capabilityUnavailable = false,
  now = new Date(),
}) {
  const uid = requireUserId(userId, 'runPredictionCycle');
  const out = {
    maturity: PREDICTION_MATURITY.NO_DATA,
    qualified: false,
    reasons: [],
    modelSaved: false,
    predictionSaved: false,
    actualsBackfilled: 0,
    publishedValue: null,
  };

  try {
    // ---- 1. 訓練 + 時序評估 + 對照基準線 ----
    const run = trainEvaluateAndCompare(rows, { target, features });

    // ---- 2. 成熟度與合格判定（fail-closed）----
    const verdict = maturityOf(run, { anchorDate, policy, capabilityUnavailable });
    out.maturity = verdict.maturity;
    out.qualified = verdict.qualified;
    out.reasons = verdict.reasons;

    // ---- 3. 只有真的訓練評估過才有模型可以存 ----
    if (run.ok && run.train_end) {
      try {
        await db.savePredictionModel(uid, {
          targetMetric: target,
          modelVersion: run.model_version ?? MODEL_VERSION,
          features,
          trainStart: run.train_start,
          trainEnd: run.train_end,
          testStart: run.test_start,
          testEnd: run.test_end,
          nTrain: run.n_train,
          nTest: run.n_test,
          mae: run.mae,
          rmse: run.rmse,
          r2: run.r2,
          intervalCoverage: run.interval_coverage,
          baselineKind: run.baseline_kind,
          baselineMae: run.baseline_mae,
          beatsBaseline: run.beats_baseline,
          maturity: verdict.maturity,
          qualified: verdict.qualified,
          unqualifiedReason: verdict.reasons.length ? verdict.reasons.join('; ').slice(0, 500) : null,
          policyVersion: PREDICTION_POLICY_VERSION,
        }, { now });
        out.modelSaved = true;
      } catch (err) {
        log.warn('prediction_model_save_failed', { user_id: uid, error: describeError(err) });
      }
    }

    // ---- 4. 候選預測：算出來、存起來（但不一定拿給使用者看）----
    //
    // 為什麼不合格也要存：不存就永遠沒有記分卡，永遠沒有資料能證明模型
    // 到底好不好，於是永遠不可能從「不合格」畢業。這是刻意的。
    if (run.ok && anchorDate) {
      const anchorRow = rows.find((r) => r.health_date === anchorDate);
      const featureValues = {};
      let usable = Boolean(anchorRow);
      for (const f of features) {
        const v = num(anchorRow?.[f]);
        if (v === null) { usable = false; break; }
        featureValues[f] = v;
      }

      if (usable) {
        const p = predict(run.model, featureValues);
        const targetDate = addDays(anchorDate, 1);
        try {
          await persistPrediction(db, uid, {
            targetDate,
            targetMetric: target,
            prediction: p,
            features: featureValues,
          }, { now });
          out.predictionSaved = true;
          out.targetDate = targetDate;

          // ★ 發布閘門：唯一決定「數字能不能給使用者看」的地方
          out.publishedValue = publishableValue({
            maturity: verdict.maturity,
            qualified: verdict.qualified,
            predictedValue: p.predicted_value,
          });
        } catch (err) {
          log.warn('prediction_persist_failed', { user_id: uid, error: describeError(err) });
        }
      }
    }

    // ---- 5. 回填已經知道實際值的舊預測（記分卡的基礎）----
    try {
      out.actualsBackfilled = await backfillActuals(db, uid, rows, {
        targetMetric: target, modelVersion: MODEL_VERSION, now,
      });
    } catch (err) {
      log.warn('prediction_backfill_failed', { user_id: uid, error: describeError(err) });
    }

    log.info('prediction_cycle_done', {
      user_id: uid,
      maturity: out.maturity,
      qualified: out.qualified,
      model_saved: out.modelSaved,
      prediction_saved: out.predictionSaved,
      actuals_backfilled: out.actualsBackfilled,
      // 絕不記錄預測值本身
      published: out.publishedValue !== null,
    });
    return out;
  } catch (err) {
    log.error('prediction_cycle_failed', { user_id: uid, error: describeError(err) });
    out.reasons = [...out.reasons, 'cycle_error'];
    return out;
  }
}
