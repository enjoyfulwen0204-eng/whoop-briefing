/**
 * 預測的成熟度與發布政策（V1.1 Phase 10）。
 *
 * ## 為什麼 readiness 與 maturity 是兩件事
 *
 * `readiness.assessPrediction()` 回答的是：**「資料夠不夠訓練？」**
 * 這裡回答的是：**「訓練出來的東西夠不夠好到可以拿去告訴使用者？」**
 *
 * 兩者完全不同，而且很容易被混為一談：
 *
 *   READINESS_STATUS.READY  = 有 30 組 D→D+1 配對，可以跑最小平方法
 *   MATURITY.EVALUATED_UNQUALIFIED = 真的訓練了、也真的評估了，
 *                                     但表現沒有被證明夠好
 *
 * 「可訓練」離「可信」還很遠。以前 `/predictions` 在 READY 時說「可訓練」，
 * 那是誠實的，但系統內部沒有任何東西表達得出第二種狀態。現在有了。
 *
 * ## Fail-closed（不可放寬）
 *
 * 品質門檻**現在全部是 null**，而 null 的語義是
 * **「還沒有被設定」→ 一律不合格**，不是「沒有限制」。
 *
 * 這是刻意的：這個系統目前有零筆真實生理資料。任何 MAE 上限、R² 下限、
 * 區間涵蓋率下限，現在填進去都只是憑空想像的數字，而一個憑空想像的門檻
 * 比沒有門檻更危險——它會讓人以為那個數字有意義。
 *
 * 所以現在的結果是：**任何模型都不可能被標成 QUALIFIED**，
 * 因此任何預測數字都不會被發布。等真實資料累積出來、能做真正的評估之後，
 * 只要把這幾個 null 換成有依據的數字就好，閘門的程式碼一行都不用動。
 *
 * ## 唯一現在就能設定的門檻
 *
 * `REQUIRE_BEATS_BASELINE` 可以現在就開啟，因為它是**相對比較**
 * （模型有沒有贏過「就用歷史平均猜」），不需要任何憑空想像的絕對數字。
 * 一個連歷史平均都贏不了的模型，不管 MAE 是多少都不該發布。
 */

import { ANALYTICS } from './config.js';

export const PREDICTION_POLICY_VERSION = 'prediction-policy-v1';

/**
 * 預測模型的成熟度。
 *
 * 這是一條**單向的階梯**，每一階都對應一個明確可查證的事實：
 *
 *   NO_DATA               連一組 D→D+1 配對都沒有
 *   INSUFFICIENT_DATA     有配對，但不到 MIN_TRAIN_ROWS
 *   MODEL_UNAVAILABLE     樣本夠了，但結構上算不出來（退化矩陣 / 無變異特徵）
 *   TRAINABLE             訓練成功，但還沒有可用的測試集，無從評估
 *   EVALUATED_UNQUALIFIED 訓練了、評估了，但**沒有被證明夠好**
 *   QUALIFIED             通過所有已設定的品質門檻
 *   STALE                 曾經評估過，但訓練資料已經跟現在的基準窗脫節
 *   UNSUPPORTED           目標指標經 capability probe 證實拿不到
 */
export const PREDICTION_MATURITY = Object.freeze({
  NO_DATA: 'NO_DATA',
  INSUFFICIENT_DATA: 'INSUFFICIENT_DATA',
  MODEL_UNAVAILABLE: 'MODEL_UNAVAILABLE',
  TRAINABLE: 'TRAINABLE',
  EVALUATED_UNQUALIFIED: 'EVALUATED_UNQUALIFIED',
  QUALIFIED: 'QUALIFIED',
  STALE: 'STALE',
  UNSUPPORTED: 'UNSUPPORTED',
});

/** 只有這一個狀態允許把預測數字拿給使用者看。 */
export const PUBLISHABLE_MATURITY = new Set([PREDICTION_MATURITY.QUALIFIED]);

export const PREDICTION_QUALITY_POLICY = Object.freeze({
  /**
   * ⚠️ 以下三個門檻**刻意是 null = 尚未設定 = 一律不合格**。
   *
   * 絕不可以把 null 解讀成「沒有限制」。零筆真實資料的現在，填任何數字
   * 進去都是憑空想像，而憑空想像的門檻比沒有門檻更危險。
   */
  MAX_MAE: null,
  MIN_R2: null,
  MIN_INTERVAL_COVERAGE: null,

  /**
   * 模型必須贏過「就用歷史平均猜」。
   *
   * 這一條現在就可以開，因為它是**相對比較**，不需要任何憑空想像的絕對
   * 數字。一個連歷史平均都贏不了的模型，MAE 再漂亮也不該發布。
   */
  REQUIRE_BEATS_BASELINE: true,

  /**
   * 測試集至少要幾筆才談得上「評估過」。
   *
   * **不是新發明的數字**：直接沿用 ANALYTICS.MIN_SAMPLES（既有的
   * 「少於這麼多樣本就不下統計結論」門檻），跟 readiness 借同一個常數。
   */
  MIN_TEST_SAMPLES: ANALYTICS.MIN_SAMPLES,

  /**
   * 訓練資料的結束日距離現在超過幾天就算過期。
   *
   * **不是新發明的數字**：用 ANALYTICS.DEFAULT_BASELINE_WINDOW（30 天，
   * 個人基準窗）。理由是可以講清楚的——如果模型的訓練期已經完全滑出
   * 目前的個人基準窗，它描述的是另一段時期的身體，不該再被當成現在的模型。
   * 這不是「多久該重訓練」的最佳解，只是一個有依據的過期定義。
   */
  STALE_AFTER_DAYS: ANALYTICS.DEFAULT_BASELINE_WINDOW,
});

/** 需要被設定、否則一律不合格的絕對門檻。 */
const REQUIRED_ABSOLUTE_GATES = ['MAX_MAE', 'MIN_R2', 'MIN_INTERVAL_COVERAGE'];

/**
 * 判定一次評估結果夠不夠格發布。**完全確定性，沒有 LLM。**
 *
 * @param {object} evaluation  evaluateAgainstBaseline() 的輸出
 * @param {object} policy      可注入，預設是上面那份（測試用來證明
 *                             「門檻設定好之後閘門真的會開」，而不必改
 *                             出貨的預設值）
 * @returns {{qualified:boolean, maturity:string, reasons:string[]}}
 */
export function qualifyModel(evaluation, { policy = PREDICTION_QUALITY_POLICY } = {}) {
  const reasons = [];

  if (!evaluation || evaluation.ok !== true) {
    return {
      qualified: false,
      maturity: PREDICTION_MATURITY.TRAINABLE,
      reasons: ['not_evaluated'],
    };
  }

  if (Number(evaluation.n_test ?? 0) < policy.MIN_TEST_SAMPLES) {
    return {
      qualified: false,
      maturity: PREDICTION_MATURITY.TRAINABLE,
      reasons: [`test_set_too_small:${evaluation.n_test ?? 0}<${policy.MIN_TEST_SAMPLES}`],
    };
  }

  // ---- 相對比較：贏不過歷史平均就直接出局 ----
  if (policy.REQUIRE_BEATS_BASELINE && evaluation.beats_baseline !== true) {
    reasons.push('does_not_beat_naive_baseline');
  }

  // ---- 絕對門檻：**沒設定就是不合格**（fail-closed）----
  //
  // ⚠️ 量測值本身也必須是有限數。`Number(null)` 是 0，所以如果直接比
  // `Number(evaluation.mae) <= threshold`，一個 **mae 是 null** 的模型會
  // 因為 0 <= threshold 而**通過**——這是一個 fail-open 的洞。
  // 目前踩不到（門檻都還是 null，根本走不到比較那一步），但只要有人把
  // 門檻填上去就會踩到，而且完全不會報錯。
  // ⚠️ 這個 helper 自己也差點踩同一個坑：`Number(null)` 是 0，而 0 是有限數，
  // 所以只檢查 Number.isFinite 完全擋不住 null。null / undefined / 空字串
  // 必須在轉型**之前**就先擋掉。（config.js 的 num() 是同一個立場。）
  const metricOf = (v) => {
    if (v === null || v === undefined || v === '') return null;
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? n : null;
  };

  for (const gate of REQUIRED_ABSOLUTE_GATES) {
    const threshold = policy[gate];
    if (threshold === null || threshold === undefined) {
      reasons.push(`quality_threshold_not_configured:${gate}`);
      continue;
    }

    const field = {
      MAX_MAE: 'mae',
      MIN_R2: 'r2',
      MIN_INTERVAL_COVERAGE: 'interval_coverage',
    }[gate];
    const value = metricOf(evaluation[field]);

    // 量測不出來 → 不合格。「算不出 R²」不等於「R² 通過了」。
    if (value === null) {
      reasons.push(`metric_not_measurable:${field}`);
      continue;
    }

    if (gate === 'MAX_MAE' && !(value <= threshold)) {
      reasons.push(`mae_above_threshold:${value}>${threshold}`);
    }
    if (gate === 'MIN_R2' && !(value >= threshold)) {
      reasons.push(`r2_below_threshold:${value}<${threshold}`);
    }
    if (gate === 'MIN_INTERVAL_COVERAGE' && !(value >= threshold)) {
      reasons.push(`coverage_below_threshold:${value}<${threshold}`);
    }
  }

  return reasons.length
    ? { qualified: false, maturity: PREDICTION_MATURITY.EVALUATED_UNQUALIFIED, reasons }
    : { qualified: true, maturity: PREDICTION_MATURITY.QUALIFIED, reasons: [] };
}

/**
 * 模型過期了嗎？
 * @param {string} trainEnd    訓練資料的最後一個 health_date（YYYY-MM-DD）
 * @param {string} anchorDate  現在的錨點 health_date
 */
export function isStale(trainEnd, anchorDate, { policy = PREDICTION_QUALITY_POLICY } = {}) {
  if (!trainEnd || !anchorDate) return false;
  const a = Date.parse(`${trainEnd}T00:00:00Z`);
  const b = Date.parse(`${anchorDate}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  return (b - a) / 86_400_000 > policy.STALE_AFTER_DAYS;
}

/**
 * **唯一**允許把預測數字放出去的地方。
 *
 * 不合格 → null。這不是禮貌性的預設值，是這個系統的核心規則：
 * 沒有被證明夠好的預測，一個數字都不給。
 */
export function publishableValue({ maturity, qualified, predictedValue }) {
  if (qualified !== true) return null;
  if (!PUBLISHABLE_MATURITY.has(maturity)) return null;
  return predictedValue ?? null;
}
