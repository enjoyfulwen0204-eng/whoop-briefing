/**
 * Data Readiness Engine（Phase PA1）。
 *
 * ## 目的
 *
 * 這是整個 Proactive Physiological Agent 的地基：任何一個分析能力
 * （z-score、趨勢、相關、迴歸、預測……）在被 AI 拿去講話之前，
 * 都要先問過這裡：「這個使用者現在的資料，撐不撐得起這個結論？」
 *
 * DETERMINISTIC READINESS → ANALYSIS → AI INTERPRETATION
 *
 * LLM 永遠不判斷樣本夠不夠。這個檔案裡沒有任何一行呼叫 AI。
 *
 * ## 重用原則（不可違反）
 *
 * 每一個能力的「樣本夠不夠」判斷，一律呼叫既有模組自己的常數或函式
 * （BASELINE.*／ANALYTICS.*／TREND_ENGINE.*／correlation.dataQualityOf／
 * regression 的動態公式／prediction 的時序切分……），不重新發明數字、
 * 也不複製貼上既有的門檻常數。唯一新增的數字都收在
 * config.js 的 READINESS_HEURISTICS，而且明確標成「產品啟發式」。
 *
 * ## Readiness 是 per-user 的
 *
 * 這個檔案裡所有函式都是純函式：吃呼叫端已經用某個 userId 撈出來的資料，
 * 自己不碰 DB、不知道有沒有其他使用者存在。Alice 的資料永遠不會流進
 * Bob 的 readiness —— 因為呼叫端本來就是分別對每個 userId 撈資料、
 * 分別呼叫這裡的函式。
 *
 * ## 完全無副作用（PA1 review 明文化）
 *
 * 這個檔案裡**沒有一個 export 是 async、沒有一個 export 接受 db 參數、
 * 沒有一行 await**。全部是同步純函式：輸入資料 → 輸出 readiness 判斷，
 * 不寫 DB、不呼叫 WHOOP／Telegram／OpenRouter、不改變任何狀態。
 * 呼叫兩次、呼叫一百次，結果永遠一樣，也永遠不會有任何副作用。
 *
 * 這裡重用的 analyzeRecoveryDrivers() / train() / trendsFor() /
 * detectBaselineShift() / analyseAssociation() 等既有函式本身也都是純函式
 * （它們對應的「寫入」版本是 persistPrediction()／snapshotContributors()
 * 之類的獨立函式，readiness 從來不呼叫那些）。
 *
 * ## KNOWN_UNAVAILABLE vs NOT_YET_VERIFIED（PA1 review 明文化）
 *
 * UNAVAILABLE 只能用在**已經證實**拿不到的情況（capabilities.js 的
 * APP_ONLY／UNAVAILABLE／UNAUTHORIZED，見下面 capabilityGate() 的說明）。
 * 「還沒 probe」「樣本不足無法判斷」「根本沒有 WHOOP 授權」一律不是
 * UNAVAILABLE，而是用既有的 NO_DATA / WARMING_UP 表達，並在
 * missing_requirements / reason 裡誠實說明原因，不可以講成「這個功能
 * 不支援」。
 */

import {
  BASELINE, ANALYTICS, TREND_ENGINE, READINESS_HEURISTICS,
} from './config.js';
import { ANALYSED_METRICS } from './analytics/index.js';
import { describeWindow } from './analytics/statistics.js';
import { trendsFor, detectBaselineShift } from './analytics/trend.js';
import {
  dataQualityOf, CONFIDENCE, analyseAssociation, journalAssociation,
} from './analytics/correlation.js';
import {
  distanceBetween, buildScaler, DEFAULT_FEATURES as SIMILAR_DAYS_FEATURES, MIN_SHARED_FEATURES,
} from './analytics/similarDays.js';
import { analyzeRecoveryDrivers, MIN_ROWS_PER_FEATURE } from './analytics/regression.js';
import {
  train, MIN_TRAIN_ROWS, DEFAULT_FEATURES as PREDICTION_FEATURES, PREDICTION_STATUS,
} from './prediction.js';
import { EXPERIMENT_STATUS, MIN_PERIOD_DAYS } from './experiments.js';
import { AVAILABILITY } from './healthspan.js';
import { STATUS as CAPABILITY_STATUS } from './capabilities.js';

export const READINESS_STATUS = Object.freeze({
  NO_DATA: 'NO_DATA',
  WARMING_UP: 'WARMING_UP',
  LIMITED: 'LIMITED',
  READY: 'READY',
  DEGRADED: 'DEGRADED',
  UNAVAILABLE: 'UNAVAILABLE',
});

export const CAPABILITY = Object.freeze({
  DAILY_STATE: 'DAILY_STATE',
  BASELINE: 'BASELINE',
  DEVIATION: 'DEVIATION',
  ZSCORE: 'ZSCORE',
  TREND_SHORT: 'TREND_SHORT',
  TREND_LONG: 'TREND_LONG',
  WHAT_CHANGED: 'WHAT_CHANGED',
  SIMILAR_DAYS: 'SIMILAR_DAYS',
  CORRELATION: 'CORRELATION',
  JOURNAL_ASSOCIATION: 'JOURNAL_ASSOCIATION',
  REGRESSION: 'REGRESSION',
  PREDICTION: 'PREDICTION',
  CHANGE_DETECTION: 'CHANGE_DETECTION',
  EXPERIMENT_ANALYSIS: 'EXPERIMENT_ANALYSIS',
  INSIGHT_DISCOVERY: 'INSIGHT_DISCOVERY',
  HEALTHSPAN_FOUNDATION: 'HEALTHSPAN_FOUNDATION',
  PROACTIVE_MONITORING: 'PROACTIVE_MONITORING',
});

function isoNow(now) {
  return (now instanceof Date ? now : new Date()).toISOString();
}

/** 統一的回傳形狀。每個能力的 assess 函式都只吐這個形狀。 */
function result({
  status, usable = 0, required = null, missing = [], quality = null, reason = null, now,
}) {
  return {
    status,
    usable_samples: usable,
    required_samples: required,
    missing_requirements: missing,
    data_quality: quality,
    reason,
    updated_at: isoNow(now),
  };
}

/**
 * 結構性不可用先擋在最前面——但只擋「已經被證實」的不可用。
 *
 * ## KNOWN_UNAVAILABLE vs NOT_YET_VERIFIED（PA1 review 修正）
 *
 * capabilities.js 的 STATUS 分成兩種完全不同的語意，這裡絕不能混為一談：
 *
 *   KNOWN_UNAVAILABLE（真的探測過，確認拿不到）——才可以回 UNAVAILABLE：
 *     - APP_ONLY        官方 API 文件本來就沒有這個欄位（靜態事實，不需要 probe）
 *     - UNAVAILABLE     probe 已經拿到 ≥3 筆樣本，而且每一筆都是 null
 *     - UNAUTHORIZED    token 缺這個 scope（探測到「沒有權限」這個事實）
 *
 *   NOT_YET_VERIFIED（還沒問過、或問了但樣本太少無法下判斷）——絕不能回
 *   UNAVAILABLE，一律放行給下面的樣本數邏輯去判斷 NO_DATA / WARMING_UP：
 *     - UNKNOWN         capabilities.js 自己的定義：「樣本不足，無從判斷」
 *     - undefined/null  這個 userId 根本還沒 probe 過（例如真實 WHOOP 帳號
 *                       還沒授權、還沒跑過 npm run probe），呼叫端可能完全
 *                       沒有把 capabilityStatus 傳進來
 *     - SUPPORTED/PARTIAL 探測到「有」，但當下樣本可能還不夠 —— 這是純粹
 *                       的樣本數問題，不是結構性問題，一樣要放行
 *
 * 絕對不可以把「還沒探測」講成「這個功能不支援」——真實 WHOOP 帳號
 * 在完成 npm run authorize / npm run probe 之前，永遠是 NOT_YET_VERIFIED。
 */
function capabilityGate(capabilityStatus, now) {
  if (capabilityStatus === CAPABILITY_STATUS.APP_ONLY) {
    return result({
      status: READINESS_STATUS.UNAVAILABLE, required: null,
      reason: 'not_provided_by_whoop_developer_api', now,
    });
  }
  if (capabilityStatus === CAPABILITY_STATUS.UNAVAILABLE) {
    return result({
      status: READINESS_STATUS.UNAVAILABLE, required: null,
      reason: 'field_unavailable_for_this_account', now,
    });
  }
  if (capabilityStatus === CAPABILITY_STATUS.UNAUTHORIZED) {
    return result({
      status: READINESS_STATUS.UNAVAILABLE, required: null,
      missing: ['reauthorize_whoop_scope'], reason: 'missing_oauth_scope', now,
    });
  }
  // NOT_YET_VERIFIED：UNKNOWN、undefined、SUPPORTED、PARTIAL 全部在這裡放行，
  // 交給樣本數邏輯決定 NO_DATA / WARMING_UP / LIMITED / READY。
  return null;
}

/** 純粹「樣本數 vs 門檻」的通用分級：NO_DATA / WARMING_UP / READY。 */
function classifyByCount({
  usable, required, now, missing = [], reason,
}) {
  if (usable <= 0) {
    return result({
      status: READINESS_STATUS.NO_DATA, usable: 0, required, missing,
      reason: reason ?? 'no_usable_samples', now,
    });
  }
  if (usable < required) {
    return result({
      status: READINESS_STATUS.WARMING_UP, usable, required,
      missing: [...missing, `need_${required - usable}_more_samples`],
      reason: reason ?? 'below_minimum_sample_size', now,
    });
  }
  return result({
    status: READINESS_STATUS.READY, usable, required, missing, reason: reason ?? null, now,
  });
}

// ===========================================================================
// DAILY_STATE — 今天的快照
// ===========================================================================

/**
 * 這一列**真的帶著至少一個可用的指標數值**嗎（L-02）。
 *
 * ## 為什麼「有這一列」不等於「有資料」
 *
 * `computeDailyMetrics()` 對每一個觀測到的睡眠都會產生一列，
 * 即使 WHOOP 對那一天**沒有回傳任何評分**（score_state 不是 SCORED、
 * 感測器沒戴好、資料還在計算中）。那樣的列每一個指標都是 null。
 *
 * 舊版的 `assessDailyState` 只確認「這一天有沒有列」，`assessBaseline`
 * 只數「窗口內有幾列」。實測：40 列全 null 的資料，兩者都回報 **READY**——
 * 系統於是宣稱「個人基準已建立」，然後對著一片空白算紅黃綠燈。
 *
 * readiness 的語義是「這件事現在做得出來嗎」，所以計數的單位必須是
 * **可用的數值**，不是資料庫裡有幾列。
 */
function hasUsableMetric(row) {
  if (!row || typeof row !== 'object') return false;
  for (const key of ANALYSED_METRICS) {
    const v = row[key];
    if (v === null || v === undefined || v === '') continue;
    if (typeof v === 'number' ? Number.isFinite(v) : Number.isFinite(Number(v))) return true;
  }
  return false;
}

/** @param {object[]} rows daily_metrics（loadDailyMetrics 的輸出） */
export function assessDailyState({ rows = [], anchorDate, now = new Date() } = {}) {
  if (!rows.length) {
    return result({ status: READINESS_STATUS.NO_DATA, required: 1, reason: 'no_health_data_yet', now });
  }
  const today = rows.find((r) => r.health_date === anchorDate);
  if (!today) {
    return result({
      status: READINESS_STATUS.DEGRADED, usable: 0, required: 1,
      missing: ['today_row_missing'],
      reason: 'historical_data_exists_but_today_not_synced_yet', now,
    });
  }
  // L-02：列存在但一個數值都沒有 —— 那是「今天的資料還沒算出來」，
  // 不是「今天的狀態已經可以講」。與「完全沒有這一列」是不同的情況，
  // 所以理由分開講，讓使用者知道到底卡在哪裡。
  if (!hasUsableMetric(today)) {
    return result({
      status: READINESS_STATUS.DEGRADED, usable: 0, required: 1,
      missing: ['today_row_has_no_scored_values'],
      reason: 'today_row_exists_but_whoop_has_not_scored_it_yet', now,
    });
  }
  return result({ status: READINESS_STATUS.READY, usable: 1, required: 1, now });
}

// ===========================================================================
// BASELINE — 個人基準（紅黃綠燈的地基）
// ===========================================================================

/** @param {object[]} rows daily_metrics，anchorDate 往回 LOOKBACK_DAYS 天內 */
export function assessBaseline({ rows = [], anchorDate, now = new Date() } = {}) {
  const cutoff = anchorDate
    ? new Date(Date.parse(`${anchorDate}T00:00:00Z`) - (BASELINE.LOOKBACK_DAYS - 1) * 86_400_000)
      .toISOString().slice(0, 10)
    : null;
  // L-02：只數**真的帶著數值**的列。舊版只數「窗口內有幾列」，
  // 於是 40 列全 null 也會回報 READY。
  const usable = rows.filter(
    (r) => (!cutoff || (r.health_date >= cutoff && r.health_date <= anchorDate))
      && hasUsableMetric(r),
  ).length;

  if (usable === 0) {
    return result({ status: READINESS_STATUS.NO_DATA, required: BASELINE.MIN_FOR_LIGHTS, now });
  }
  if (usable < BASELINE.MIN_FOR_LIGHTS) {
    return result({
      status: READINESS_STATUS.WARMING_UP, usable, required: BASELINE.MIN_FOR_LIGHTS,
      missing: [`need_${BASELINE.MIN_FOR_LIGHTS - usable}_more_samples`], now,
    });
  }
  if (usable < BASELINE.TARGET_SAMPLES) {
    return result({
      status: READINESS_STATUS.LIMITED, usable, required: BASELINE.TARGET_SAMPLES,
      missing: [`below_target_of_${BASELINE.TARGET_SAMPLES}`],
      reason: 'usable_but_below_full_baseline_target', now,
    });
  }
  return result({ status: READINESS_STATUS.READY, usable, required: BASELINE.TARGET_SAMPLES, now });
}

// ===========================================================================
// DEVIATION / ZSCORE — 個人偏離（同一套機制，直接重用 describeWindow）
// ===========================================================================

/**
 * @param {{date:string,value:number}[]} series seriesOf(rows, metricKey) 的輸出
 * @param {string} capabilityStatus 選填。capabilities.js 對這個欄位的判定。
 */
export function assessDeviation({
  series = [], anchorDate, capabilityStatus = null, now = new Date(),
} = {}) {
  const gated = capabilityGate(capabilityStatus, now);
  if (gated) return gated;
  const w = describeWindow(series, {
    endDate: anchorDate, days: ANALYTICS.DEFAULT_BASELINE_WINDOW, excludeEndDate: true,
  });
  // 樣本是 0、而且這個欄位「還沒被 probe 過」時，講清楚是哪一種 NO_DATA——
  // 不要讓人誤以為是「這個功能不支援」，而其實只是還沒跑過 npm run probe。
  const notYetVerified = w.n === 0 && capabilityStatus === CAPABILITY_STATUS.UNKNOWN
    ? ['capability_not_yet_verified']
    : [];
  return classifyByCount({
    usable: w.n, required: ANALYTICS.MIN_SAMPLES, missing: notYetVerified, now,
  });
}

/** z-score 用的是跟 deviation 完全同一套基準窗口，語意上是同一件事。 */
export const assessZscore = assessDeviation;

// ===========================================================================
// TREND_SHORT / TREND_LONG — 重用 trend.js 的 trendsFor
// ===========================================================================

function assessTrendWindow({ metricKey, series = [], anchorDate, windowDays, now }) {
  const out = trendsFor(metricKey, series, { endDate: anchorDate, windows: [windowDays] });
  const w = out[`${windowDays}d`];
  return classifyByCount({ usable: w.n, required: TREND_ENGINE.MIN_SAMPLES, now });
}

const SHORT_WINDOW = Math.min(...TREND_ENGINE.WINDOWS);
const LONG_WINDOW = Math.max(...TREND_ENGINE.WINDOWS);

export function assessTrendShort({ metricKey, series, anchorDate, now = new Date() } = {}) {
  return assessTrendWindow({
    metricKey, series, anchorDate, windowDays: SHORT_WINDOW, now,
  });
}

export function assessTrendLong({ metricKey, series, anchorDate, now = new Date() } = {}) {
  return assessTrendWindow({
    metricKey, series, anchorDate, windowDays: LONG_WINDOW, now,
  });
}

// ===========================================================================
// WHAT_CHANGED — 今天要有值，而且至少一個指標的基準要足夠
// ===========================================================================

/**
 * @param {object} seriesByMetric { metricKey: [{date,value}] }
 * @param {string[]} metrics 要檢查哪些指標（預設由呼叫端傳 ANALYSED_METRICS）
 */
export function assessWhatChanged({
  rows = [], seriesByMetric = {}, anchorDate, metrics = [], now = new Date(),
} = {}) {
  const daily = assessDailyState({ rows, anchorDate, now });
  if (daily.status === READINESS_STATUS.NO_DATA) {
    return result({ status: READINESS_STATUS.NO_DATA, required: 1, now });
  }
  if (daily.status === READINESS_STATUS.DEGRADED) {
    return result({
      status: READINESS_STATUS.DEGRADED, required: 1, missing: ['today_row_missing'],
      reason: 'historical_data_exists_but_today_not_synced_yet', now,
    });
  }
  const readyMetrics = metrics.filter((m) => assessDeviation({
    series: seriesByMetric[m] ?? [], anchorDate, now,
  }).status === READINESS_STATUS.READY);

  // 走到這裡代表今天已經有資料（上面 daily state 檢查過了），只是還沒有
  // 任何指標的基準夠深 —— 這是「還在累積」，不是「完全沒資料」，
  // 所以不能借用 classifyByCount 在 usable=0 時回 NO_DATA 的通用邏輯。
  if (!readyMetrics.length) {
    return result({
      status: READINESS_STATUS.WARMING_UP, required: 1,
      missing: ['no_metric_has_a_sufficient_baseline_yet'], now,
    });
  }
  return result({ status: READINESS_STATUS.READY, usable: readyMetrics.length, required: 1, now });
}

// ===========================================================================
// SIMILAR_DAYS — 候選池大小是產品啟發式（既有模組沒有定義過這個數字）
// ===========================================================================

export function assessSimilarDays({ rows = [], anchorDate, now = new Date() } = {}) {
  if (!rows.length) {
    return result({
      status: READINESS_STATUS.NO_DATA, required: READINESS_HEURISTICS.SIMILAR_DAYS_MIN_POOL, now,
    });
  }
  const target = rows.find((r) => r.health_date === anchorDate);
  if (!target) {
    return result({
      status: READINESS_STATUS.NO_DATA, required: READINESS_HEURISTICS.SIMILAR_DAYS_MIN_POOL,
      missing: ['today_row_missing'], now,
    });
  }
  const scaler = buildScaler(rows, SIMILAR_DAYS_FEATURES);
  const usable = rows.filter((r) => {
    if (r.health_date === anchorDate) return false;
    return Boolean(distanceBetween(target, r, scaler, {
      features: SIMILAR_DAYS_FEATURES, minShared: MIN_SHARED_FEATURES,
    }));
  }).length;

  return classifyByCount({
    usable, required: READINESS_HEURISTICS.SIMILAR_DAYS_MIN_POOL, now,
  });
}

// ===========================================================================
// CORRELATION — 重用 correlation.js 自己的信心分級，不重複定義門檻數字
// ===========================================================================

/** 從 dataQualityOf 本身反推「不再是 INSUFFICIENT」的最小 n，避免重複寫死 10。 */
const CORRELATION_MIN_N = (() => {
  let n = 0;
  while (dataQualityOf(n) === CONFIDENCE.INSUFFICIENT) n += 1;
  return n;
})();

function classifyByConfidence({
  n, quality, usableGate = true, missingIfNotUsable = [], now,
}) {
  if (n <= 0) {
    return result({ status: READINESS_STATUS.NO_DATA, required: CORRELATION_MIN_N, now });
  }
  if (n < CORRELATION_MIN_N) {
    return result({
      status: READINESS_STATUS.WARMING_UP, usable: n, required: CORRELATION_MIN_N,
      missing: [`need_${CORRELATION_MIN_N - n}_more_samples`], quality, now,
    });
  }
  if (!usableGate) {
    return result({
      status: READINESS_STATUS.LIMITED, usable: n, required: CORRELATION_MIN_N,
      missing: missingIfNotUsable, quality,
      reason: 'no_contrast_group_yet', now,
    });
  }
  if (quality === CONFIDENCE.LOW) {
    return result({
      status: READINESS_STATUS.LIMITED, usable: n, required: CORRELATION_MIN_N, quality,
      reason: 'usable_but_low_confidence', now,
    });
  }
  return result({
    status: READINESS_STATUS.READY, usable: n, required: CORRELATION_MIN_N, quality, now,
  });
}

/**
 * @param {{date:string,value:number}[]} xSeries
 * @param {{date:string,value:number}[]} ySeries
 */
export function assessCorrelation({
  xSeries = [], ySeries = [], lagDays = 0, now = new Date(),
} = {}) {
  const res = analyseAssociation({ xSeries, ySeries, lagDays });
  return classifyByConfidence({ n: res.n, quality: res.data_quality, now });
}

// ===========================================================================
// JOURNAL_ASSOCIATION — 同一套信心分級，額外要求「有對照組」
// ===========================================================================

/**
 * @param {object[]} journalEvents db.getJournalEvents() 的輸出
 * @param {{date:string,value:number}[]} metricSeries
 */
export function assessJournalAssociation({
  journalEvents = [], metricSeries = [], category, lagDays = 1, useCount = false, now = new Date(),
} = {}) {
  const res = journalAssociation({
    journalEvents, metricSeries, category, lagDays, useCount,
  });
  return classifyByConfidence({
    n: res.n,
    quality: res.data_quality,
    usableGate: res.usable,
    missingIfNotUsable: ['need_both_exposed_and_unexposed_days'],
    now,
  });
}

// ===========================================================================
// REGRESSION — 重用 analyzeRecoveryDrivers 的動態樣本公式（不拉平成固定數字）
// ===========================================================================

/**
 * @param {object[]} rows daily_metrics
 * @param {string} target
 * @param {string[]} features
 */
export function assessRegression({
  rows = [], target = 'recovery', features = [], now = new Date(),
} = {}) {
  const fit = analyzeRecoveryDrivers({ rows, target, features });

  if (fit.reason === 'no_features') {
    return result({
      status: READINESS_STATUS.UNAVAILABLE, required: null,
      reason: 'no_features_requested', now,
    });
  }
  if (fit.reason === 'no_usable_features') {
    return result({
      status: fit.n > 0 ? READINESS_STATUS.WARMING_UP : READINESS_STATUS.NO_DATA,
      usable: fit.n, required: features.length * MIN_ROWS_PER_FEATURE,
      missing: fit.warnings, reason: 'no_feature_has_variance_yet', now,
    });
  }
  if (fit.reason === 'insufficient_data') {
    return result({
      status: READINESS_STATUS.WARMING_UP, usable: fit.n, required: fit.required_n,
      missing: [`need_${fit.required_n - fit.n}_more_complete_rows`], now,
    });
  }
  if (fit.reason === 'singular_matrix') {
    // 樣本數已經達標，但矩陣退化（通常是特徵之間完全共線）——
    // 這不是「還在累積資料」，是「這批資料結構性算不出來」。
    const required = Math.max(fit.features_used.length + 2, fit.features_used.length * MIN_ROWS_PER_FEATURE);
    return result({
      status: READINESS_STATUS.DEGRADED, usable: fit.n, required,
      missing: fit.warnings, reason: 'singular_matrix', now,
    });
  }

  const required = Math.max(fit.features_used.length + 2, fit.features_used.length * MIN_ROWS_PER_FEATURE);
  const hasMulticollinearityWarning = fit.warnings.some((w) => w.startsWith('multicollinearity')
    || w.startsWith('severe_multicollinearity'));
  return result({
    status: hasMulticollinearityWarning ? READINESS_STATUS.LIMITED : READINESS_STATUS.READY,
    usable: fit.n, required,
    missing: hasMulticollinearityWarning ? fit.warnings : [],
    reason: hasMulticollinearityWarning ? 'multicollinearity_among_features' : null,
    now,
  });
}

// ===========================================================================
// PREDICTION — 重用 prediction.js 的 train()（含時序切分邏輯）
// ===========================================================================

/** @param {object[]} rows daily_metrics（未切分；train() 內部自己做時序配對） */
export function assessPrediction({
  rows = [], target = 'recovery', features = PREDICTION_FEATURES, now = new Date(),
} = {}) {
  const res = train(rows, { target, features });

  if (res.status === PREDICTION_STATUS.INSUFFICIENT_DATA) {
    return result({
      status: res.n > 0 ? READINESS_STATUS.WARMING_UP : READINESS_STATUS.NO_DATA,
      usable: res.n, required: MIN_TRAIN_ROWS,
      missing: [`need_${Math.max(0, MIN_TRAIN_ROWS - res.n)}_more_day_pairs`], now,
    });
  }
  if (res.status === PREDICTION_STATUS.MODEL_UNAVAILABLE) {
    return result({
      status: READINESS_STATUS.DEGRADED, usable: res.n, required: MIN_TRAIN_ROWS,
      missing: res.warnings ?? [], reason: res.reason ?? 'model_unavailable', now,
    });
  }
  const hasMulticollinearityWarning = (res.fit?.warnings ?? []).some(
    (w) => w.startsWith('multicollinearity') || w.startsWith('severe_multicollinearity'),
  );
  return result({
    status: hasMulticollinearityWarning ? READINESS_STATUS.LIMITED : READINESS_STATUS.READY,
    usable: res.n, required: MIN_TRAIN_ROWS,
    missing: hasMulticollinearityWarning ? res.fit.warnings : [],
    now,
  });
}

// ===========================================================================
// CHANGE_DETECTION — 重用 trend.js 的 detectBaselineShift
// ===========================================================================

/**
 * ## M-04：capability 閘門對**所有**訊號型別一視同仁
 *
 * 舊版這支函式的參數列裡根本沒有 `capabilityStatus`。`baselineShiftSignal()`
 * 一直有把它傳進來，但它只是一個被默默丟掉的多餘屬性 —— 於是
 * `capabilityGate` 對 BASELINE_SHIFT **完全沒有生效**。
 *
 * 實測：把 HRV 標成 APP_ONLY / UNAVAILABLE / UNAUTHORIZED，
 * `deviationSignal()` 正確回 null，`baselineShiftSignal()` 照樣吐出
 * `HRV_SHIFT_LOW`。也就是說一個「已經證實拿不到」的欄位，只要庫裡還有
 * 舊資料，就能拿去推論基準漂移、觸發主動追問、寫進使用者看得到的敘述。
 *
 * 不變量：**已經證實拿不到的指標，任何分析都不可能是 READY。**
 * 判準與 assessDeviation 共用同一個 capabilityGate，不另外發明一套。
 */
export function assessChangeDetection({
  metricKey, series = [], anchorDate, capabilityStatus = null, now = new Date(),
} = {}) {
  const gated = capabilityGate(capabilityStatus, now);
  if (gated) return gated;
  const r = detectBaselineShift(metricKey, series, { endDate: anchorDate });
  const usable = Math.min(r.recent_n, r.previous_n);
  const classified = classifyByCount({ usable, required: TREND_ENGINE.MIN_SHIFT_SAMPLES, now });
  if (classified.status === READINESS_STATUS.READY && r.reason === 'insufficient_variance') {
    return result({
      status: READINESS_STATUS.DEGRADED, usable, required: TREND_ENGINE.MIN_SHIFT_SAMPLES,
      reason: 'insufficient_variance', now,
    });
  }
  return classified;
}

// ===========================================================================
// EXPERIMENT_ANALYSIS — 重用 experiments.js 的 MIN_PERIOD_DAYS
// ===========================================================================

/** @param {object} experiment db.getExperiment() 的一列 */
export function assessExperimentAnalysis({ rows = [], experiment, now = new Date() } = {}) {
  if (!experiment) {
    return result({ status: READINESS_STATUS.NO_DATA, required: MIN_PERIOD_DAYS, reason: 'no_experiment', now });
  }
  if (experiment.status === EXPERIMENT_STATUS.DRAFT) {
    return result({
      status: READINESS_STATUS.NO_DATA, required: MIN_PERIOD_DAYS,
      reason: 'experiment_not_started', now,
    });
  }
  const inRange = (date, start, end) => start && date >= start && (!end || date <= end);
  const baselineN = rows.filter(
    (r) => inRange(r.health_date, experiment.baseline_start, experiment.baseline_end),
  ).length;
  const interventionN = rows.filter(
    (r) => inRange(r.health_date, experiment.start_date, experiment.end_date),
  ).length;
  const usable = Math.min(baselineN, interventionN);

  return classifyByCount({
    usable, required: MIN_PERIOD_DAYS,
    missing: usable < MIN_PERIOD_DAYS
      ? [`baseline_days:${baselineN}`, `intervention_days:${interventionN}`]
      : [],
    now,
  });
}

// ===========================================================================
// INSIGHT_DISCOVERY — 重用 BASELINE 的「夠不夠格開口」門檻
// ===========================================================================

/**
 * Insight discovery 是對既有分析結果做綜合判讀，不是獨立的新統計方法，
 * 所以直接借用 BASELINE 的門檻：資料連紅黃燈都撐不起的時候，
 * 更不該讓 AI 去「發現洞察」。
 */
export function assessInsightDiscovery({ rows = [], anchorDate, now = new Date() } = {}) {
  const baseline = assessBaseline({ rows, anchorDate, now });
  if (baseline.status === READINESS_STATUS.READY || baseline.status === READINESS_STATUS.LIMITED) {
    return result({
      status: READINESS_STATUS.READY, usable: baseline.usable_samples,
      required: BASELINE.MIN_FOR_LIGHTS, now,
    });
  }
  return result({
    status: baseline.status, usable: baseline.usable_samples,
    required: BASELINE.MIN_FOR_LIGHTS, missing: baseline.missing_requirements, now,
  });
}

// ===========================================================================
// HEALTHSPAN_FOUNDATION — 「一半以上的 contributor 算得出值」是產品啟發式
// ===========================================================================

/** @param {object[]} contributors healthspan.buildContributors() 的輸出 */
export function assessHealthspanFoundation({ contributors = [], now = new Date() } = {}) {
  const scoped = contributors.filter((c) => c.availability !== AVAILABILITY.APP_ONLY);
  if (!scoped.length) {
    return result({ status: READINESS_STATUS.NO_DATA, required: 1, now });
  }
  const usable = scoped.filter(
    (c) => c.availability === AVAILABILITY.AVAILABLE || c.availability === AVAILABILITY.PARTIAL,
  ).length;
  const required = Math.max(1, Math.ceil(scoped.length * READINESS_HEURISTICS.HEALTHSPAN_MIN_COVERAGE_RATIO));

  if (usable === 0) {
    return result({ status: READINESS_STATUS.WARMING_UP, required, now });
  }
  if (usable < required) {
    return result({
      status: READINESS_STATUS.LIMITED, usable, required,
      reason: 'below_half_of_contributors_computable', now,
    });
  }
  return result({ status: READINESS_STATUS.READY, usable, required, now });
}

// ===========================================================================
// PROACTIVE_MONITORING — 由核心指標各自的 DEVIATION readiness 組合而成
// ===========================================================================

/**
 * @param {object} seriesByMetric { metricKey: [{date,value}] }
 * @param {string[]} coreMetrics 預設用 READINESS_HEURISTICS.PROACTIVE_CORE_METRICS
 */
export function assessProactiveMonitoring({
  seriesByMetric = {}, anchorDate, coreMetrics = READINESS_HEURISTICS.PROACTIVE_CORE_METRICS,
  now = new Date(),
} = {}) {
  const perMetric = coreMetrics.map((m) => assessDeviation({
    series: seriesByMetric[m] ?? [], anchorDate, now,
  }));
  const readyCount = perMetric.filter((r) => r.status === READINESS_STATUS.READY).length;
  const anyData = perMetric.some((r) => r.status !== READINESS_STATUS.NO_DATA);
  const required = coreMetrics.length;

  if (readyCount === 0 && !anyData) {
    return result({ status: READINESS_STATUS.NO_DATA, required, now });
  }
  if (readyCount === 0) {
    return result({ status: READINESS_STATUS.WARMING_UP, required, now });
  }
  if (readyCount < required) {
    return result({
      status: READINESS_STATUS.LIMITED, usable: readyCount, required,
      missing: coreMetrics.filter((_, i) => perMetric[i].status !== READINESS_STATUS.READY),
      now,
    });
  }
  return result({ status: READINESS_STATUS.READY, usable: readyCount, required, now });
}
