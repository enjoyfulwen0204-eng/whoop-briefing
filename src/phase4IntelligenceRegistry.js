/**
 * Phase 4 Stage 5 deterministic intelligence registry.
 *
 * These entries are product contracts, not population norms. They describe
 * how a user's current canonical value may be compared with that same user's
 * earlier values. Nothing in this registry authorizes publication or delivery.
 */

export const INTELLIGENCE_VERSIONS = Object.freeze({
  algorithm: 'phase4-intelligence-v1',
  registry: 'phase4-metric-registry-v1',
  evidenceContract: 'phase4-evidence-v1',
  baseline: 'robust-baseline-v1',
  exposureClassification: 'journal-exposure-v1',
  promotionConfound: 'unknown-promotion-confound-v1',
  factorSet: 'journal-factors-v1',
});

const common = Object.freeze({
  baselineMethod: 'MEDIAN_MAD_IQR',
  baselineMinimum: 7,
  baselineTarget: 30,
  baselineLookbackDays: 45,
  openRobustZ: 2.5,
  closeRobustZ: 1.5,
  persistenceMinimum: 2,
  persistenceMinimumSeparationMs: 30 * 60 * 1000,
  persistenceMaximumSeparationMs: 36 * 60 * 60 * 1000,
  severeSingleRobustZ: 4,
  severeSingleConfidence: 0.80,
  resolutionHoldMs: 24 * 60 * 60 * 1000,
  episodeExpiryMs: 7 * 24 * 60 * 60 * 1000,
  evidenceExpiryMs: 90 * 24 * 60 * 60 * 1000,
  freshnessTargetMs: 36 * 60 * 60 * 1000,
  stalenessLimitMs: 48 * 60 * 60 * 1000,
  severityRobustZ: Object.freeze([2.5, 3.25, 4]),
  notificationCapable: false,
});

function metric(definition) {
  return Object.freeze({ ...common, ...definition });
}

// The fields below are all present in the retained v20 canonical WHOOP tables
// or in the v23 Body Energy result. No raw or minute-level sensor metric is
// registered here.
export const PHASE4_METRICS = Object.freeze({
  recovery_score: metric({
    domain: 'recovery', sourceType: 'recovery', field: 'recovery_score', unit: 'score',
    minimum: 0, maximum: 100, absoluteFloor: 12, relativeFloor: 0.15,
    denominatorFloor: 10, polarity: 'HIGHER_IS_BETTER', associationEffectFloor: 5,
  }),
  hrv: metric({
    domain: 'autonomic', sourceType: 'recovery', field: 'hrv_rmssd_milli', unit: 'ms',
    minimumExclusive: 0, maximum: 500, absoluteFloor: 8, relativeFloor: 0.15,
    denominatorFloor: 5, polarity: 'HIGHER_IS_BETTER', associationEffectFloor: 5,
  }),
  rhr: metric({
    domain: 'autonomic', sourceType: 'recovery', field: 'resting_heart_rate', unit: 'bpm',
    minimum: 20, maximum: 220, absoluteFloor: 5, relativeFloor: 0.08,
    denominatorFloor: 20, polarity: 'LOWER_IS_BETTER', associationEffectFloor: 3,
  }),
  sleep_performance: metric({
    domain: 'sleep', sourceType: 'sleep', field: 'sleep_performance_percentage', unit: 'percent',
    minimum: 0, maximum: 100, absoluteFloor: 10, relativeFloor: 0.12,
    denominatorFloor: 10, polarity: 'HIGHER_IS_BETTER', associationEffectFloor: 5,
  }),
  sleep_duration_minutes: metric({
    domain: 'sleep', sourceType: 'sleep', field: 'total_sleep_milli', divisor: 60000, unit: 'minutes',
    minimum: 0, maximum: 24 * 60, absoluteFloor: 45, relativeFloor: 0.10,
    denominatorFloor: 60, polarity: 'HIGHER_IS_BETTER', associationEffectFloor: 30,
  }),
  sleep_efficiency: metric({
    domain: 'sleep', sourceType: 'sleep', field: 'sleep_efficiency_percentage', unit: 'percent',
    minimum: 0, maximum: 100, absoluteFloor: 5, relativeFloor: 0.07,
    denominatorFloor: 10, polarity: 'HIGHER_IS_BETTER', associationEffectFloor: 3,
  }),
  respiratory_rate: metric({
    domain: 'respiratory', sourceType: 'sleep', field: 'respiratory_rate', unit: 'breaths_per_minute',
    minimumExclusive: 0, maximum: 60, absoluteFloor: 1, relativeFloor: 0.08,
    denominatorFloor: 5, polarity: 'BIDIRECTIONAL', associationEffectFloor: 0.75,
  }),
  cycle_strain: metric({
    domain: 'load', sourceType: 'cycle', field: 'strain', unit: 'strain',
    minimum: 0, maximum: 21, absoluteFloor: 3, relativeFloor: 0.20,
    denominatorFloor: 1, polarity: 'CONTEXT_DEPENDENT', associationEffectFloor: 2,
  }),
  body_energy: metric({
    domain: 'body_energy', sourceType: 'body_energy_results', field: 'value', unit: 'score',
    minimum: 0, maximum: 100, absoluteFloor: 12, relativeFloor: 0.15,
    denominatorFloor: 10, polarity: 'HIGHER_IS_BETTER', associationEffectFloor: 5,
  }),
});

export const EVIDENCE_METHOD_REGISTRY = Object.freeze({
  PERSONAL_BASELINE_DEVIATION: Object.freeze({ minimumSamples: 7, method: 'CURRENT_VS_ROBUST_BASELINE' }),
  MONOTONIC_TREND: Object.freeze({ minimumSamples: 7, method: 'DECLARED_WINDOW_LINEAR_TREND' }),
  JOURNAL_ASSOCIATION: Object.freeze({ minimumGroupSamples: 5, minimumClassifiedSamples: 20,
    repeatedGroupSamples: 8, repeatedClassifiedSamples: 30, method: 'EXPOSED_VS_CONFIRMED_UNEXPOSED' }),
  SIMILAR_DAY: Object.freeze({ minimumSharedFeatures: 4, method: 'SAME_USER_SIMILAR_DAY' }),
  CORRELATION: Object.freeze({ minimumSamples: 20, method: 'PEARSON_AND_SPEARMAN' }),
  BODY_ENERGY_DECOMPOSITION: Object.freeze({ minimumSamples: 1, method: 'DETERMINISTIC_DRIVER_DECOMPOSITION' }),
  DATA_QUALITY: Object.freeze({ minimumSamples: 0, method: 'TYPED_MISSINGNESS_EXPLANATION' }),
});

export function phase4Metric(metricKey) {
  const value = PHASE4_METRICS[metricKey];
  if (!value) {
    const error = new Error('PHASE4_METRIC_UNREGISTERED');
    error.code = error.message;
    throw error;
  }
  return value;
}

export function isPhase4Metric(metricKey) {
  return Object.hasOwn(PHASE4_METRICS, metricKey);
}
