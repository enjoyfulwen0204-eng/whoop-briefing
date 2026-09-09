/**
 * Evidence Card（Phase AC）—— 統一的「證據」格式。
 *
 * ## 為什麼需要
 *
 * 相關、迴歸、預測、insight、實驗、趨勢各自有不同的輸出形狀。
 * 當使用者問「你憑什麼這樣說？」「樣本多少？」時，
 * 必須能用同一套語言回答，而不是每種分析各講一套。
 *
 * ## 這個模組不做計算
 *
 * 它只是把既有 deterministic 計算的結果**翻譯**成統一格式。
 * 所有數字都來自原本的分析模組，這裡一個都不重算。
 *
 * ## causal 永遠是 false
 *
 * 這個系統做的全部是 n=1 的個人層級觀察。沒有任何一張卡片可以宣稱因果。
 */

import { CONFIDENCE, dataQualityOf } from './analytics/correlation.js';
import { log } from './logger.js';
import { requireUserId } from './userContext.js';

export const EVIDENCE_METHODS = {
  PEARSON: 'pearson_correlation',
  SPEARMAN: 'spearman_correlation',
  JOURNAL_ASSOCIATION: 'journal_next_day_association',
  REGRESSION: 'multiple_linear_regression',
  PREDICTION: 'prediction_scorecard',
  EXPERIMENT: 'within_person_before_after',
  TREND: 'linear_trend',
  DEVIATION: 'personal_deviation_zscore',
  BASELINE_SHIFT: 'rolling_mean_shift',
};

/**
 * 建一張 evidence card。
 * 所有欄位都有明確語義，缺的就是 null（不填假值）。
 */
export function makeEvidenceCard({
  metric,
  dateRange = null,
  sampleCount = null,
  method,
  effect = null,
  effectUnit = null,
  confidence = null,
  warnings = [],
  recalculatedAt = null,
  detail = null,
  sufficient = null,
}) {
  return {
    metric,
    date_range: dateRange,           // { from, to } 或 null
    sample_count: sampleCount,
    method,
    effect,                          // 這個方法的主要效果量
    effect_unit: effectUnit,
    confidence: confidence ?? (sampleCount === null ? null : dataQualityOf(sampleCount)),
    // ★ 永遠是 false —— 這個系統不產生因果證據
    causal: false,
    interpretation: 'within-person observed association',
    recalculated_at: recalculatedAt,
    warnings: Array.isArray(warnings) ? warnings : [],
    // 樣本夠不夠到值得一看（不是統計顯著性）
    sufficient: sufficient ?? (sampleCount !== null && sampleCount >= 10),
    detail,
  };
}

const rangeOf = (series) => (series?.length
  ? { from: series[0].date, to: series[series.length - 1].date }
  : null);

// ---------------------------------------------------------------------------
// 各分析 → evidence card
// ---------------------------------------------------------------------------

/** analyseAssociation() / journalAssociation() 的輸出 → card */
export function fromCorrelation(result, { metric, dateRange = null, recalculatedAt = null } = {}) {
  if (!result) return null;
  const warnings = [];
  if (result.usable === false) warnings.push('no_control_group');
  if (result.n < 10) warnings.push('insufficient_sample');
  if (result.pearson === null) warnings.push('no_variance');

  return makeEvidenceCard({
    metric: metric ?? `${result.x} → ${result.y}`,
    dateRange,
    sampleCount: result.n,
    method: result.lag_days
      ? EVIDENCE_METHODS.JOURNAL_ASSOCIATION
      : EVIDENCE_METHODS.PEARSON,
    effect: result.pearson,
    effectUnit: 'r',
    confidence: result.data_quality,
    warnings,
    recalculatedAt,
    sufficient: result.usable !== false && result.n >= 10,
    detail: {
      pearson: result.pearson,
      spearman: result.spearman,
      p_value: result.p_value,
      lag_days: result.lag_days,
      exposed_days: result.exposed_days ?? null,
      unexposed_days: result.unexposed_days ?? null,
    },
  });
}

/** analyzeRecoveryDrivers() → card */
export function fromRegression(fit, { dateRange = null, recalculatedAt = null } = {}) {
  if (!fit) return null;
  if (!fit.ok) {
    return makeEvidenceCard({
      metric: fit.target,
      dateRange,
      sampleCount: fit.n,
      method: EVIDENCE_METHODS.REGRESSION,
      effect: null,
      confidence: CONFIDENCE.INSUFFICIENT,
      warnings: [...(fit.warnings ?? []), fit.reason ?? 'not_fitted'],
      recalculatedAt,
      sufficient: false,
      detail: { reason: fit.reason, required_n: fit.required_n ?? null },
    });
  }
  return makeEvidenceCard({
    metric: fit.target,
    dateRange,
    sampleCount: fit.n,
    method: EVIDENCE_METHODS.REGRESSION,
    effect: fit.adjusted_r2 ?? fit.r2,
    effectUnit: 'adjusted_R2',
    warnings: fit.warnings ?? [],
    recalculatedAt,
    detail: {
      r2: fit.r2,
      adjusted_r2: fit.adjusted_r2,
      features_used: fit.features_used,
      standardized_coefficients: fit.standardized_coefficients,
      dropped_rows: fit.dropped_rows,
      vif: fit.vif,
    },
  });
}

/** prediction scorecard → card */
export function fromPrediction(scorecard, { metric = 'recovery', recalculatedAt = null } = {}) {
  if (!scorecard || scorecard.available === false) {
    return makeEvidenceCard({
      metric,
      sampleCount: 0,
      method: EVIDENCE_METHODS.PREDICTION,
      effect: null,
      confidence: CONFIDENCE.INSUFFICIENT,
      warnings: [scorecard?.reason ?? 'no_predictions'],
      recalculatedAt,
      sufficient: false,
      detail: { total_runs: scorecard?.total_runs ?? 0 },
    });
  }
  return makeEvidenceCard({
    metric,
    sampleCount: scorecard.n,
    method: EVIDENCE_METHODS.PREDICTION,
    effect: scorecard.mae,
    effectUnit: 'MAE',
    recalculatedAt,
    detail: {
      mae: scorecard.mae,
      rmse: scorecard.rmse,
      bias: scorecard.bias,
      interval_coverage: scorecard.interval_coverage,
    },
  });
}

/** analyseExperimentData() 的單一 metric → card */
export function fromExperiment(experimentResult, metricKey, { recalculatedAt = null } = {}) {
  const m = experimentResult?.metrics?.[metricKey];
  if (!m) return null;
  if (!m.sufficient) {
    return makeEvidenceCard({
      metric: metricKey,
      sampleCount: (m.baseline_n ?? 0) + (m.intervention_n ?? 0),
      method: EVIDENCE_METHODS.EXPERIMENT,
      effect: null,
      confidence: CONFIDENCE.INSUFFICIENT,
      warnings: [m.reason ?? 'insufficient_data'],
      recalculatedAt,
      sufficient: false,
      detail: { baseline_n: m.baseline_n, intervention_n: m.intervention_n },
    });
  }
  return makeEvidenceCard({
    metric: metricKey,
    sampleCount: m.baseline_n + m.intervention_n,
    method: EVIDENCE_METHODS.EXPERIMENT,
    effect: m.effect_size,
    effectUnit: 'cohens_d',
    recalculatedAt,
    detail: {
      baseline_n: m.baseline_n,
      intervention_n: m.intervention_n,
      baseline_mean: m.baseline_mean,
      intervention_mean: m.intervention_mean,
      mean_difference: m.mean_difference,
      median_difference: m.median_difference,
    },
  });
}

/** trendsFor() 的單一窗口 → card */
export function fromTrend(trend, { metric, series = null, recalculatedAt = null } = {}) {
  if (!trend) return null;
  const warnings = [];
  if (!trend.sufficient) warnings.push('insufficient_sample');
  if (trend.r2 !== null && trend.r2 !== undefined && trend.r2 < 0.2) warnings.push('low_fit');

  return makeEvidenceCard({
    metric,
    dateRange: rangeOf(series),
    sampleCount: trend.n,
    method: EVIDENCE_METHODS.TREND,
    effect: trend.slope_per_day ?? null,
    effectUnit: 'per_day',
    warnings,
    recalculatedAt,
    sufficient: Boolean(trend.sufficient),
    detail: {
      window_days: trend.windowDays,
      direction: trend.direction,
      total_change: trend.total_change ?? null,
      r2: trend.r2 ?? null,
    },
  });
}

/** evaluateDeviation() → card */
export function fromDeviation(dev, { recalculatedAt = null } = {}) {
  if (!dev) return null;
  const warnings = [];
  if (dev.level === 'insufficient_data') warnings.push('insufficient_sample');
  if (dev.level === 'insufficient_variance') warnings.push('no_variance');

  return makeEvidenceCard({
    metric: dev.metric,
    sampleCount: dev.baseline_n,
    method: EVIDENCE_METHODS.DEVIATION,
    effect: dev.z_score,
    effectUnit: 'z',
    warnings,
    recalculatedAt,
    sufficient: dev.z_score !== null,
    detail: {
      current: dev.current,
      baseline_mean: dev.baseline_mean,
      baseline_stddev: dev.baseline_stddev,
      baseline_window_days: dev.baseline_window_days,
      level: dev.level,
      direction: dev.direction,
    },
  });
}

/** health_insights 的一列 → card */
export function fromInsight(row, { recalculatedAt = null } = {}) {
  if (!row) return null;
  let evidence = null;
  try {
    evidence = row.evidence_json ? JSON.parse(row.evidence_json) : null;
  } catch { /* 壞掉的 JSON 就當沒有 */ }

  return makeEvidenceCard({
    metric: row.subject,
    sampleCount: row.sample_count === null || row.sample_count === undefined
      ? null : Number(row.sample_count),
    method: row.insight_type ?? 'insight',
    effect: row.effect_size === null || row.effect_size === undefined
      ? null : Number(row.effect_size),
    effectUnit: 'effect_size',
    confidence: row.confidence,
    recalculatedAt: recalculatedAt ?? row.last_recalculated_at,
    warnings: row.status === 'WEAKENED' ? ['evidence_weakened'] : [],
    sufficient: ['SUPPORTED', 'EMERGING'].includes(row.status),
    detail: {
      status: row.status,
      version: row.version,
      statement: row.statement,
      first_detected_at: row.first_detected_at,
      evidence,
    },
  });
}

// ---------------------------------------------------------------------------
// 查詢入口
// ---------------------------------------------------------------------------

/**
 * 「這個結論的證據呢？」
 *
 * 目前的來源是 health_insights 與 prediction scorecard —— 也就是系統
 * 真的保存下來的長期結論。沒有任何證據時**明講**，不編。
 */
/** @param {string} userId **必填**。只回這個使用者的 evidence。 */
export async function getEvidence({ db, userId, subject = null, now = new Date() }) {
  const uid = requireUserId(userId, 'getEvidence');
  const cards = [];

  try {
    if (typeof db.getActiveInsights === 'function') {
      const insights = await db.getActiveInsights(uid, { subject });
      for (const row of insights) cards.push(fromInsight(row));
    }
  } catch (err) {
    log.warn('evidence_insights_failed', { error: String(err?.message ?? err).slice(0, 200) });
  }

  try {
    if (typeof db.getPredictions === 'function') {
      const { scorecard } = await import('./prediction.js');
      // ⚠️ 稽核修正：這裡原本是 `scorecard(db, {})`。`{}` 是 truthy，
      // requireUserId 又用 String() 正規化，所以 `String({})` 會變成
      // 字面上的 "[object Object]" —— 守衛不會拋錯，查詢卻是
      // `WHERE user_id = '[object Object]'`，永遠 0 列。結果是預測記分卡
      // **從來不曾**出現在 /evidence，而且完全靜默（外層 catch 也不會觸發）。
      // 沒有跨使用者外洩（那個 id 是垃圾字串，不是別人的 id），但
      // requireUserId 的保護在這條路徑上等於被繞過。
      const sc = await scorecard(db, uid);
      if (sc.available) cards.push(fromPrediction(sc, { recalculatedAt: now.toISOString() }));
    }
  } catch (err) {
    log.warn('evidence_prediction_failed', { error: String(err?.message ?? err).slice(0, 200) });
  }

  return {
    available: cards.length > 0,
    generated_at: now.toISOString(),
    cards: cards.filter(Boolean),
    note: cards.length
      ? null
      : '目前還沒有累積足夠的資料形成任何有證據支持的結論。',
  };
}

/** evidence cards → Telegram 文字。 */
export function renderEvidence(result) {
  if (!result?.available) {
    return [
      '🔍 目前的證據',
      '',
      '目前還沒有足夠的資料形成任何結論，所以也沒有證據可以給你。',
      '等 WHOOP 開始同步、累積一段時間之後，我才會開始建立長期規律。',
    ].join('\n');
  }

  const lines = ['🔍 目前的證據', ''];
  for (const c of result.cards) {
    lines.push(`· ${c.metric}`);
    lines.push(`  方法：${c.method}`);
    lines.push(`  樣本數：${c.sample_count ?? '不明'}`);
    if (c.effect !== null && c.effect !== undefined) {
      lines.push(`  效果量：${Number(c.effect).toFixed(3)}${c.effect_unit ? ` (${c.effect_unit})` : ''}`);
    }
    lines.push(`  資料充分度：${c.confidence ?? '不明'}`);
    if (c.date_range) lines.push(`  區間：${c.date_range.from} ～ ${c.date_range.to}`);
    if (c.warnings.length) lines.push(`  ⚠️ ${c.warnings.join('、')}`);
    lines.push('');
  }
  lines.push('註：以上全部是個人層級的觀察到的關聯（within-person observed association），');
  lines.push('不是因果關係，也不是醫學結論。');
  return lines.join('\n');
}
