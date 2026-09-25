import { phase4Metric, isPhase4Metric, INTELLIGENCE_VERSIONS } from './phase4IntelligenceRegistry.js';
import { pearson, spearman, pValue } from './analytics/correlation.js';
import { findSimilarDays } from './analytics/similarDays.js';

const DAY_MS = 86_400_000;
const clamp = (minimum, maximum, value) => Math.min(maximum, Math.max(minimum, value));
const finite = value => typeof value === 'number' && Number.isFinite(value);
const validInstant = value => typeof value === 'string' && value.length > 0 && Number.isFinite(Date.parse(value));
const comparisonTolerance = (left, right) => Number.EPSILON * 8 * Math.max(1, Math.abs(left), Math.abs(right));
const thresholdEqual = (left, right) => finite(left) && finite(right) && Math.abs(left - right) <= comparisonTolerance(left, right);
const thresholdAtLeast = (left, right) => finite(left) && finite(right) && (left > right || thresholdEqual(left, right));
const thresholdBelow = (left, right) => finite(left) && finite(right) && left < right && !thresholdEqual(left, right);
const validHealthDate = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const instant = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(instant) && new Date(instant).toISOString().slice(0, 10) === value;
};
const dayNumber = value => Date.parse(`${value}T00:00:00.000Z`) / DAY_MS;

export function linearQuantile(values, probability) {
  if (!Array.isArray(values) || !values.length || !finite(probability) || probability < 0 || probability > 1) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const h = (sorted.length - 1) * probability;
  const lower = Math.floor(h), upper = Math.ceil(h);
  return sorted[lower] + (h - lower) * (sorted[upper] - sorted[lower]);
}

export function median(values) {
  return linearQuantile(values, 0.5);
}

export function validMetricValue(metricKey, value) {
  if (!isPhase4Metric(metricKey) || !finite(value)) return false;
  const contract = phase4Metric(metricKey);
  if (contract.minimum !== undefined && value < contract.minimum) return false;
  if (contract.minimumExclusive !== undefined && value <= contract.minimumExclusive) return false;
  return contract.maximum === undefined || value <= contract.maximum;
}

// Shared by sampling and provenance before any manifest/identity construction.
// Stable semantic source identity, never caller or database row order.
export const compareBaselineSources = (a,b) =>
  String(b?.healthDate ?? '').localeCompare(String(a?.healthDate ?? ''))
  || (Date.parse(b?.observedAt)-Date.parse(a?.observedAt) || 0)
  || String(b?.sourceVersion ?? '').localeCompare(String(a?.sourceVersion ?? ''))
  || String(a?.sourceId ?? '').localeCompare(String(b?.sourceId ?? ''))
  || String(a?.sourceType ?? '').localeCompare(String(b?.sourceType ?? ''))
  || String(a?.ingestedAt ?? '').localeCompare(String(b?.ingestedAt ?? ''))
  || String(a?.value ?? '').localeCompare(String(b?.value ?? ''));

function normalizeObservations(metricKey, observations, targetHealthDate, asOfUtc) {
  const contract = phase4Metric(metricKey), asOf = Date.parse(asOfUtc), target = dayNumber(targetHealthDate);
  const exclusions = [], candidates = [];
  for (const raw of [...(Array.isArray(observations) ? observations : [])].sort(compareBaselineSources)) {
    const observation = { ...raw };
    let reason = null;
    if (!validHealthDate(observation.healthDate)) reason = 'INVALID_HEALTH_DATE';
    else if (!validInstant(observation.observedAt) || !validInstant(observation.ingestedAt)) reason = 'INVALID_TIMESTAMP';
    else if (Date.parse(observation.observedAt) > asOf || Date.parse(observation.ingestedAt) > asOf) reason = 'SOURCE_AFTER_AS_OF';
    else if (!validMetricValue(metricKey, observation.value)) reason = 'VALUE_OUT_OF_RANGE';
    else {
      const age = target - dayNumber(observation.healthDate);
      if (age < 1) reason = 'NOT_EARLIER_THAN_TARGET';
      else if (age > contract.baselineLookbackDays) reason = 'OUTSIDE_BASELINE_LOOKBACK';
    }
    if (reason) exclusions.push({ sourceId: observation.sourceId ?? null, healthDate: observation.healthDate ?? null, reason });
    else candidates.push(observation);
  }
  candidates.sort(compareBaselineSources);
  const days = new Set(), samples = [];
  for (const candidate of candidates) {
    if (days.has(candidate.healthDate)) {
      exclusions.push({ sourceId: candidate.sourceId ?? null, healthDate: candidate.healthDate, reason: 'DUPLICATE_HEALTH_DAY' });
      continue;
    }
    days.add(candidate.healthDate);
    if (samples.length < contract.baselineTarget) samples.push(candidate);
    else exclusions.push({ sourceId: candidate.sourceId ?? null, healthDate: candidate.healthDate, reason: 'BEYOND_BASELINE_TARGET' });
  }
  return { samples, exclusions };
}

/** Earlier-only robust personal baseline: latest 30 valid days within 45. */
export function buildPersonalBaseline({ metricKey, targetHealthDate, asOfUtc, observations = [] }) {
  const contract = phase4Metric(metricKey);
  if (!validHealthDate(targetHealthDate) || !validInstant(asOfUtc)) throw new Error('PHASE4_BASELINE_BOUNDARY_INVALID');
  if (!Array.isArray(observations) || observations.length > 512) throw new Error('PHASE4_BASELINE_INPUT_BOUNDED');
  const { samples, exclusions } = normalizeObservations(metricKey, observations, targetHealthDate, asOfUtc);
  const values = samples.map(sample => sample.value), center = median(values);
  const mad = center === null ? null : median(values.map(value => Math.abs(value - center)));
  const q1 = linearQuantile(values, 0.25), q3 = linearQuantile(values, 0.75), iqr = q1 === null ? null : q3 - q1;
  const madScale = mad > 0 ? mad * 1.4826 : null;
  const iqrScale = iqr > 0 ? iqr / 1.349 : null;
  const scale = madScale ?? iqrScale;
  return Object.freeze({
    metricKey, unit: contract.unit, method: contract.baselineMethod, version: INTELLIGENCE_VERSIONS.baseline,
    targetHealthDate, asOfUtc, lookbackDays: contract.baselineLookbackDays, targetSamples: contract.baselineTarget,
    minimumSamples: contract.baselineMinimum, sampleCount: samples.length, sufficient: samples.length >= contract.baselineMinimum && scale !== null,
    mature: samples.length >= contract.baselineTarget && scale !== null, median: center, mad, q1, q3, iqr,
    scale, scaleMethod: madScale !== null ? 'MAD_X_1_4826' : iqrScale !== null ? 'IQR_DIV_1_349' : null,
    samples: samples.map(sample => ({ ...sample })), exclusions: exclusions.map(item => ({ ...item })),
  });
}

export function assessDataQuality({ metricKey, current = null, baseline = null, asOfUtc,
  lifecycleValid = true, authorizationValid = true, sourceValid = true, discrepancy = false,
  completenessRatio = 1, missingReasons = [], inputGeneration = null, lifecycleGeneration = null,
  authGeneration = null, provenance = [] }) {
  const reasons = new Set(missingReasons), supported = isPhase4Metric(metricKey);
  let status, freshnessAgeMs = null, freshnessStatus = 'UNKNOWN', validCurrent = false;
  if (!supported || !lifecycleValid || !authorizationValid) {
    status = 'UNAVAILABLE';
    if (!supported) reasons.add('UNSUPPORTED_METRIC');
    if (!lifecycleValid) reasons.add('LIFECYCLE_MISMATCH');
    if (!authorizationValid) reasons.add('AUTHORIZATION_MISMATCH');
  } else {
    const contract = phase4Metric(metricKey);
    if (current?.ingestedAt && validInstant(current.ingestedAt) && validInstant(asOfUtc)) {
      freshnessAgeMs = Date.parse(asOfUtc) - Date.parse(current.ingestedAt);
      freshnessStatus = freshnessAgeMs < 0 ? 'INVALID' : freshnessAgeMs <= contract.freshnessTargetMs ? 'FRESH'
        : freshnessAgeMs <= contract.stalenessLimitMs ? 'AGING' : 'STALE';
    }
    validCurrent = current !== null && validMetricValue(metricKey, current.value)
      && validInstant(current.observedAt) && validInstant(current.ingestedAt) && validInstant(asOfUtc)
      && Date.parse(current.observedAt) <= Date.parse(asOfUtc) && freshnessAgeMs >= 0;
    if (!current) { status = 'NO_DATA'; reasons.add('NOT_COLLECTED'); }
    else if (!validCurrent || !sourceValid || discrepancy || freshnessStatus === 'STALE'
      || !finite(completenessRatio) || completenessRatio < 0.5) {
      status = 'DEGRADED';
      if (!validCurrent) reasons.add('SOURCE_INVALID');
      if (!sourceValid) reasons.add('SOURCE_VALIDITY_FAILED');
      if (discrepancy) reasons.add('RECONCILIATION_DISCREPANCY');
      if (freshnessStatus === 'STALE') reasons.add('STALE');
      if (!finite(completenessRatio) || completenessRatio < 0.5) reasons.add('INCOMPLETE_RECORD');
    } else if (!baseline || baseline.sampleCount < contract.baselineMinimum || baseline.scale === null) {
      status = 'WARMING_UP'; reasons.add('INSUFFICIENT_BASELINE');
      if (baseline && baseline.scale === null) reasons.add('INSUFFICIENT_VARIANCE');
    } else {
      const baselineFraction = clamp(0, 1, baseline.sampleCount / contract.baselineTarget);
      const freshness = freshnessStatus === 'FRESH' ? 1 : freshnessStatus === 'AGING' ? 0.5 : 0;
      const confidence = clamp(0, 1, 0.35 + 0.20 * clamp(0, 1, completenessRatio) + 0.30 * baselineFraction + 0.15 * freshness);
      status = baseline.sampleCount < contract.baselineTarget || freshnessStatus !== 'FRESH' || confidence < 0.8 ? 'LIMITED' : 'AVAILABLE';
      if (baseline.sampleCount < contract.baselineTarget) reasons.add('BASELINE_NOT_MATURE');
      if (freshnessStatus === 'AGING') reasons.add('FRESHNESS_AGING');
    }
  }
  const contract = supported ? phase4Metric(metricKey) : null;
  const baselineFraction = baseline && contract ? clamp(0, 1, baseline.sampleCount / contract.baselineTarget) : 0;
  const freshness = freshnessStatus === 'FRESH' ? 1 : freshnessStatus === 'AGING' ? 0.5 : 0;
  const confidence = status === 'NO_DATA' || status === 'UNAVAILABLE' ? 0
    : clamp(0, 1, (validCurrent ? 0.35 : 0) + 0.20 * clamp(0, 1, finite(completenessRatio) ? completenessRatio : 0)
      + 0.30 * baselineFraction + 0.15 * freshness);
  return Object.freeze({ status, reasonCodes: [...reasons].sort(), completenessRatio: finite(completenessRatio) ? completenessRatio : 0,
    freshnessAgeMs, freshnessStatus, sourceValid: Boolean(sourceValid), lifecycleValid: Boolean(lifecycleValid),
    authorizationValid: Boolean(authorizationValid), baselineCount: baseline?.sampleCount ?? 0,
    sampleSufficient: Boolean(baseline?.sufficient), lookbackDays: contract?.baselineLookbackDays ?? null,
    discrepancy: Boolean(discrepancy), inputGeneration, lifecycleGeneration, authGeneration,
    algorithmVersion: INTELLIGENCE_VERSIONS.algorithm, confidence, provenance: structuredClone(provenance) });
}

function semanticImpact(contract, direction) {
  if (contract.polarity === 'HIGHER_IS_BETTER') return direction === 'HIGHER' ? 'FAVORABLE' : 'UNFAVORABLE';
  if (contract.polarity === 'LOWER_IS_BETTER') return direction === 'LOWER' ? 'FAVORABLE' : 'UNFAVORABLE';
  if (contract.polarity === 'BIDIRECTIONAL') return 'DEVIATION';
  return 'CONTEXT_DEPENDENT';
}

function severityOf(contract, absoluteRobustZ) {
  let severity = 0;
  for (const threshold of contract.severityRobustZ) if (thresholdAtLeast(absoluteRobustZ, threshold)) severity += 1;
  return severity;
}

/** Pure Stage 5 meaningful-change and hysteresis evaluation. */
export function evaluateMeaningfulChange({ metricKey, current, baseline, quality, priorQualifying = [], activeEpisode = null,
  recentSemanticHashes = [], nowUtc = null }) {
  const contract = phase4Metric(metricKey), now = nowUtc ?? current?.observedAt;
  if (!current || !baseline || !quality || !validInstant(now)) throw new Error('PHASE4_CHANGE_INPUT_REQUIRED');
  const absoluteDelta = validMetricValue(metricKey, current.value) && finite(baseline.median) ? current.value - baseline.median : null;
  const relativeDelta = absoluteDelta !== null && Math.abs(baseline.median) >= contract.denominatorFloor
    ? absoluteDelta / Math.abs(baseline.median) : null;
  const robustZ = absoluteDelta !== null && finite(baseline.scale) && baseline.scale > 0 ? absoluteDelta / baseline.scale : null;
  const absoluteRobustZ = robustZ === null ? null : Math.abs(robustZ), direction = robustZ === null ? null : robustZ >= 0 ? 'HIGHER' : 'LOWER';
  const magnitudePass = absoluteDelta !== null && (Math.abs(absoluteDelta) >= contract.absoluteFloor
    || relativeDelta !== null && Math.abs(relativeDelta) >= contract.relativeFloor);
  const openPass = magnitudePass && absoluteRobustZ !== null && thresholdAtLeast(absoluteRobustZ, contract.openRobustZ);
  const closePass = absoluteRobustZ !== null && thresholdBelow(absoluteRobustZ, contract.closeRobustZ);
  const eligibleQuality = ['LIMITED', 'AVAILABLE'].includes(quality.status) && quality.confidence > 0;
  const prior = (Array.isArray(priorQualifying) ? priorQualifying : []).filter(item => item.direction === direction
    && finite(item.robustZ) && thresholdAtLeast(Math.abs(item.robustZ), contract.openRobustZ) && validInstant(item.observedAt)
    && Date.parse(current.observedAt) - Date.parse(item.observedAt) >= contract.persistenceMinimumSeparationMs
    && Date.parse(current.observedAt) - Date.parse(item.observedAt) <= contract.persistenceMaximumSeparationMs);
  const persistent = openPass && prior.length + 1 >= contract.persistenceMinimum;
  const severeSingle = openPass && thresholdAtLeast(absoluteRobustZ, contract.severeSingleRobustZ)
    && thresholdAtLeast(quality.confidence, contract.severeSingleConfidence);
  const qualified = eligibleQuality && (persistent || severeSingle);
  const severity = absoluteRobustZ === null ? 0 : severityOf(contract, absoluteRobustZ);
  const semanticHash = `${INTELLIGENCE_VERSIONS.algorithm}:${metricKey}:${direction}:${severity}:${semanticImpact(contract, direction)}`;
  const novelty = !recentSemanticHashes.includes(semanticHash);
  let classification = 'NO_MEANINGFUL_CHANGE', targetEpisodeState = null;
  if (activeEpisode && !eligibleQuality) classification = 'INSUFFICIENT_QUALITY';
  else if (activeEpisode) {
    if (qualified && activeEpisode.direction !== direction) classification = 'DIRECTION_REVERSAL';
    else if (qualified && severity > (activeEpisode.severity ?? 0)) classification = 'WORSENING';
    else if (qualified || thresholdAtLeast(absoluteRobustZ, contract.closeRobustZ)) classification = 'CONTINUING_CHANGE';
    else if (closePass) {
      const elapsed = activeEpisode.stabilizationStartedAt ? Date.parse(now) - Date.parse(activeEpisode.stabilizationStartedAt) : 0;
      classification = activeEpisode.state === 'STABILIZING' && elapsed >= contract.resolutionHoldMs ? 'RESOLVED' : 'IMPROVING';
    }
  } else if (qualified) classification = 'NEW_CHANGE';
  if (classification === 'NEW_CHANGE') targetEpisodeState = 'OPEN';
  else if (classification === 'WORSENING' || classification === 'DIRECTION_REVERSAL') targetEpisodeState = 'ESCALATED';
  else if (classification === 'CONTINUING_CHANGE') targetEpisodeState = activeEpisode?.state === 'STABILIZING' ? 'UPDATING' : (activeEpisode?.state ?? 'UPDATING');
  else if (classification === 'IMPROVING') targetEpisodeState = 'STABILIZING';
  else if (classification === 'RESOLVED') targetEpisodeState = 'RESOLVED';
  const magnitudeComponent = absoluteRobustZ === null ? 0 : clamp(0, 1, absoluteRobustZ / contract.severeSingleRobustZ);
  const persistenceComponent = severeSingle ? 1 : clamp(0, 1, (prior.length + 1) / contract.persistenceMinimum);
  const recencyComponent = quality.freshnessAgeMs === null ? 0 : 2 ** (-(quality.freshnessAgeMs / DAY_MS) / 30);
  const meaningfulness = clamp(0, 1, 0.35 * magnitudeComponent + 0.20 * persistenceComponent
    + 0.15 * recencyComponent + 0.15 * Number(novelty) + 0.15 * quality.confidence);
  return Object.freeze({ metricKey, absoluteDelta, relativeDelta, robustZ, direction, semanticImpact: semanticImpact(contract, direction),
    magnitudePass, openPass, closePass, persistent, severeSingle, qualified, severity, novelty, semanticHash,
    classification, targetEpisodeState, meaningfulness, confidence: quality.confidence, qualityStatus: quality.status,
    components: Object.freeze({ magnitude: magnitudeComponent, persistence: persistenceComponent, recency: recencyComponent,
      novelty: Number(novelty), quality: quality.confidence }) });
}

export function recencyWeight(ageDays) {
  return finite(ageDays) && ageDays >= 0 ? 2 ** (-ageDays / 30) : 0;
}

export function evidenceConfidence({ dataQuality, sampleSufficiency, replication, effectStability, recency,
  multiplicityControl, softConfoundFraction = 0, hardConfound = false, uncertaintyAvailable = true }) {
  const parts = [dataQuality, sampleSufficiency, replication, effectStability, recency, multiplicityControl, softConfoundFraction];
  if (parts.some(value => !finite(value) || value < 0 || value > 1)) throw new Error('PHASE4_EVIDENCE_CONFIDENCE_INPUT_INVALID');
  let score = clamp(0, 1, 0.25 * dataQuality + 0.20 * sampleSufficiency + 0.20 * replication
    + 0.15 * effectStability + 0.10 * recency + 0.10 * multiplicityControl - 0.15 * softConfoundFraction);
  if (hardConfound) score = Math.min(score, 0.399999);
  if (!uncertaintyAvailable) score = Math.min(score, 0.599999);
  return Object.freeze({ version: INTELLIGENCE_VERSIONS.evidenceConfidence,
    score, label: score >= 0.8 ? 'HIGH' : score >= 0.5 ? 'MEDIUM' : 'LOW',
    components: Object.freeze({ dataQuality, sampleSufficiency, replication, effectStability, recency, multiplicityControl,
      softConfoundFraction }), hardConfound: Boolean(hardConfound), uncertaintyAvailable: Boolean(uncertaintyAvailable) });
}

export function validateEvidenceConfidence(value) {
  const names=['dataQuality','sampleSufficiency','replication','effectStability','recency','multiplicityControl','softConfoundFraction'];
  if(!value||value.version!==INTELLIGENCE_VERSIONS.evidenceConfidence||!value.components
    ||typeof value.hardConfound!=='boolean'||typeof value.uncertaintyAvailable!=='boolean')
    throw new Error('PHASE4_EVIDENCE_CONFIDENCE_INVALID');
  let expected;
  try {expected=evidenceConfidence({...Object.fromEntries(names.map(name=>[name,value.components[name]])),
    hardConfound:value.hardConfound,uncertaintyAvailable:value.uncertaintyAvailable});}
  catch {throw new Error('PHASE4_EVIDENCE_CONFIDENCE_INVALID');}
  if(!finite(value.score)||!thresholdEqual(value.score,expected.score)||value.label!==expected.label)
    throw new Error('PHASE4_EVIDENCE_CONFIDENCE_INVALID');
  return value;
}

/** Benjamini-Hochberg correction over the complete declared family. */
export function benjaminiHochberg(hypotheses) {
  if (!Array.isArray(hypotheses) || !hypotheses.length || hypotheses.length > 1000
    || hypotheses.some(item => !item || typeof item.key !== 'string' || !finite(item.pValue) || item.pValue < 0 || item.pValue > 1))
    throw new Error('PHASE4_MULTIPLICITY_FAMILY_INVALID');
  const ordered = hypotheses.map((item, index) => ({ ...item, index })).sort((a, b) => a.pValue - b.pValue || a.key.localeCompare(b.key));
  let next = 1;
  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    const adjusted = Math.min(next, ordered[index].pValue * ordered.length / (index + 1));
    ordered[index].adjusted = adjusted; next = adjusted;
  }
  return ordered.sort((a, b) => a.index - b.index).map(({ index, ...item }) => Object.freeze(item));
}

/**
 * Tri-state Journal association. Absence is UNKNOWN; only explicit facts or a
 * factor-covering confirmation may produce CONFIRMED_UNEXPOSED.
 */
export function evaluateJournalAssociation({ factor, outcomeMetric, days, replicationWindows = [], adjustedSignificance = null,
  hardConfoundFlags = [], softConfoundFraction = 0, asOfUtc, minimumEffectSize = null }) {
  const contract = phase4Metric(outcomeMetric), effectFloor = minimumEffectSize ?? contract.associationEffectFloor;
  if (typeof factor !== 'string' || !factor || !Array.isArray(days) || days.length > 400 || !validInstant(asOfUtc))
    throw new Error('PHASE4_ASSOCIATION_INPUT_INVALID');
  const seen = new Set(), eligible = [], classifiedWithMissingOutcome = [];
  for (const day of days) {
    if (!validHealthDate(day.healthDate) || seen.has(day.healthDate)
      || !['EXPOSED', 'CONFIRMED_UNEXPOSED', 'UNKNOWN'].includes(day.exposureState)) throw new Error('PHASE4_ASSOCIATION_DAY_INVALID');
    seen.add(day.healthDate);
    const qualityEligible = ['LIMITED', 'AVAILABLE'].includes(day.quality);
    const outcomeValid = validMetricValue(outcomeMetric, day.outcome);
    const outcomeStatus=day.outcomeStatus??(outcomeValid?'PRESENT':'MISSING');
    if(!['PRESENT','MISSING','INVALID'].includes(outcomeStatus)||(outcomeStatus==='PRESENT')!==outcomeValid)
      throw new Error('PHASE4_ASSOCIATION_DAY_INVALID');
    if (day.exposureState !== 'UNKNOWN') classifiedWithMissingOutcome.push({ ...day, outcomeValid, outcomeStatus });
    if (qualityEligible && outcomeValid) eligible.push(day);
  }
  const exposed = eligible.filter(day => day.exposureState === 'EXPOSED');
  const unexposed = eligible.filter(day => day.exposureState === 'CONFIRMED_UNEXPOSED');
  const unknown = eligible.filter(day => day.exposureState === 'UNKNOWN');
  const classified = exposed.length + unexposed.length, denominator = eligible.length;
  const unknownFraction = denominator === 0 ? null : unknown.length / denominator;
  const exposedMissingBase = classifiedWithMissingOutcome.filter(day => day.exposureState === 'EXPOSED');
  const unexposedMissingBase = classifiedWithMissingOutcome.filter(day => day.exposureState === 'CONFIRMED_UNEXPOSED');
  const missingExposedCount = exposedMissingBase.filter(day => day.outcomeStatus==='MISSING').length;
  const missingUnexposedCount = unexposedMissingBase.filter(day => day.outcomeStatus==='MISSING').length;
  const invalidExposedCount = exposedMissingBase.filter(day => day.outcomeStatus==='INVALID').length;
  const invalidUnexposedCount = unexposedMissingBase.filter(day => day.outcomeStatus==='INVALID').length;
  const missingExposed = exposedMissingBase.length ? (missingExposedCount+invalidExposedCount) / exposedMissingBase.length : 0;
  const missingUnexposed = unexposedMissingBase.length ? (missingUnexposedCount+invalidUnexposedCount) / unexposedMissingBase.length : 0;
  const mean = rows => rows.length ? rows.reduce((total, day) => total + day.outcome, 0) / rows.length : null;
  const rawExposedMean = mean(exposed), rawUnexposedMean = mean(unexposed);
  const rawEffect = rawExposedMean === null || rawUnexposedMean === null ? null : rawExposedMean - rawUnexposedMean;
  const classifiedFraction = denominator === 0 ? 0 : classified / denominator;
  const comparisonEligible = exposed.length >= 5 && unexposed.length >= 5 && classified >= 20 && classifiedFraction >= 0.25
    && rawEffect !== null && missingExposed <= 0.4 && missingUnexposed <= 0.4;
  // The ADR forbids emitting an exposed-vs-unexposed statistic before every
  // comparison floor passes. Keep the internal candidate check deterministic,
  // but fail closed at the public evidence boundary.
  const effect = comparisonEligible ? rawEffect : null;
  const exposedMean = comparisonEligible ? rawExposedMean : null;
  const unexposedMean = comparisonEligible ? rawUnexposedMean : null;
  const candidate = comparisonEligible && Math.abs(effect) >= effectFloor;
  const windows = replicationWindows.map(window => ({ ...window,
    start: validInstant(window.start) ? new Date(window.start).toISOString() : window.start,
    end: validInstant(window.end) ? new Date(window.end).toISOString() : window.end,
  })).sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  const replicationValid = windows.length >= 2 && windows.every((window, index) => validInstant(window.start) && validInstant(window.end)
    && Date.parse(window.start) < Date.parse(window.end) && window.direction === (effect >= 0 ? 'HIGHER' : 'LOWER')
    && (index === 0 || Date.parse(windows[index - 1].end) <= Date.parse(window.start)))
    && Date.parse(windows.at(-1).end) - Date.parse(windows[0].start) >= 7 * DAY_MS;
  const promotionConfound = denominator === 0 ? 'NO_ELIGIBLE_OBSERVATION_DAYS'
    : unknownFraction > 0.5 ? 'UNKNOWN_FRACTION_EXCEEDED' : null;
  const repeated = candidate && exposed.length >= 8 && unexposed.length >= 8 && classified >= 30
    && replicationValid && hardConfoundFlags.length === 0 && promotionConfound === null;
  const currentWindow = windows.some(window => Date.parse(window.end) >= Date.parse(asOfUtc) - 30 * DAY_MS);
  const supporting = repeated && adjustedSignificance !== null && finite(adjustedSignificance)
    && adjustedSignificance <= 0.10 && currentWindow;
  const reasons = [];
  if (denominator === 0) reasons.push('NO_ELIGIBLE_OBSERVATION_DAYS');
  if (exposed.length < 5) reasons.push('INSUFFICIENT_EXPOSED_DAYS');
  if (unexposed.length < 5) reasons.push('INSUFFICIENT_CONFIRMED_UNEXPOSED_DAYS');
  if (classified < 20) reasons.push('INSUFFICIENT_CLASSIFIED_DAYS');
  if (classifiedFraction < 0.25) reasons.push('INSUFFICIENT_EXPOSURE_CLASSIFICATION');
  if (rawEffect === null || Math.abs(rawEffect) < effectFloor) reasons.push('EFFECT_BELOW_FLOOR');
  if (missingExposed > 0.4 || missingUnexposed > 0.4) reasons.push('DIFFERENTIAL_MISSINGNESS');
  if (promotionConfound) reasons.push(promotionConfound);
  if (hardConfoundFlags.length) reasons.push('HARD_CONFOUND');
  const confidence = evidenceConfidence({ dataQuality: denominator ? Math.min(1, classifiedFraction * 2) : 0,
    sampleSufficiency: Math.min(1, classified / 30), replication: replicationValid ? 1 : 0,
    effectStability: candidate ? 1 : 0, recency: currentWindow ? 1 : 0,
    multiplicityControl: adjustedSignificance !== null && adjustedSignificance <= 0.10 ? 1 : 0,
    softConfoundFraction, hardConfound: hardConfoundFlags.length > 0, uncertaintyAvailable: adjustedSignificance !== null });
  return Object.freeze({ factor, outcomeMetric, causalStatus: 'ASSOCIATION_ONLY', readiness: supporting ? 'INSIGHT_SUPPORTING'
    : repeated ? 'REPEATED' : candidate ? 'CANDIDATE' : 'INSUFFICIENT_EXPOSURE_CLASSIFICATION',
    eligibleObservationDays: denominator, exposedCount: exposed.length, confirmedUnexposedCount: unexposed.length,
    unknownCount: unknown.length, unknownFraction, maxUnknownFractionForPromotion: 0.5,
    comparisonDayCount: days.length, classifiedExposedDays: exposedMissingBase.length,
    classifiedConfirmedUnexposedDays: unexposedMissingBase.length,
    exposedOutcomePresentCount: exposedMissingBase.length-missingExposedCount-invalidExposedCount, exposedOutcomeMissingCount: missingExposedCount,
    confirmedUnexposedOutcomePresentCount: unexposedMissingBase.length-missingUnexposedCount-invalidUnexposedCount,
    confirmedUnexposedOutcomeMissingCount: missingUnexposedCount,exposedOutcomeInvalidCount:invalidExposedCount,
    confirmedUnexposedOutcomeInvalidCount:invalidUnexposedCount,
    promotionConfoundVersion: INTELLIGENCE_VERSIONS.promotionConfound, exposedMean, confirmedUnexposedMean: unexposedMean,
    effect, unit: contract.unit, direction: effect === null ? null : effect >= 0 ? 'HIGHER' : 'LOWER',
    minimumEffectSize: effectFloor, candidate, repeated, insightSupporting: supporting,
    adjustedSignificance, replicationWindows: windows.map(window => ({ ...window })),
    missingOutcomeFractionExposed: missingExposed, missingOutcomeFractionUnexposed: missingUnexposed,
    hardConfoundFlags: [...hardConfoundFlags].sort(), reasonCodes: [...new Set(reasons)].sort(), confidence });
}

export function evaluateMonotonicTrend({ metricKey, observations, windowDays, asOfUtc }) {
  phase4Metric(metricKey);
  if (!Number.isSafeInteger(windowDays) || windowDays < 2 || windowDays > 90 || !validInstant(asOfUtc)
    || !Array.isArray(observations) || observations.length > 512) throw new Error('PHASE4_TREND_WINDOW_INVALID');
  const threshold = Date.parse(asOfUtc) - windowDays * DAY_MS, seen = new Set();
  const points = observations.filter(item => validInstant(item.observedAt) && Date.parse(item.observedAt) <= Date.parse(asOfUtc)
    && Date.parse(item.observedAt) >= threshold && validMetricValue(metricKey, item.value))
    .sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt) || String(a.sourceId).localeCompare(String(b.sourceId)))
    .filter(item => { if (seen.has(item.healthDate)) return false; seen.add(item.healthDate); return true; });
  if (points.length < 2) return Object.freeze({ metricKey, windowDays, sampleCount: points.length, sufficient: false,
    slopePerDay: null, direction: null, rSquared: null, caveat: 'SERIAL_CORRELATION_NOT_MODELED' });
  const x0 = Date.parse(points[0].observedAt), xs = points.map(item => (Date.parse(item.observedAt) - x0) / DAY_MS);
  const ys = points.map(item => item.value), xMean = xs.reduce((a, b) => a + b, 0) / xs.length, yMean = ys.reduce((a, b) => a + b, 0) / ys.length;
  let numerator = 0, denominator = 0;
  for (let index = 0; index < xs.length; index += 1) { numerator += (xs[index] - xMean) * (ys[index] - yMean); denominator += (xs[index] - xMean) ** 2; }
  const slope = denominator === 0 ? null : numerator / denominator;
  let total = 0, residual = 0;
  if (slope !== null) for (let index = 0; index < xs.length; index += 1) {
    const predicted = yMean + slope * (xs[index] - xMean); total += (ys[index] - yMean) ** 2; residual += (ys[index] - predicted) ** 2;
  }
  const rSquared = slope === null || total === 0 ? null : clamp(0, 1, 1 - residual / total);
  return Object.freeze({ metricKey, windowDays, sampleCount: points.length, distinctHealthDays: seen.size,
    sufficient: points.length >= 7 && slope !== null, slopePerDay: slope,
    direction: slope === null ? null : slope > 0 ? 'HIGHER' : slope < 0 ? 'LOWER' : 'STABLE', rSquared,
    caveat: 'SERIAL_CORRELATION_NOT_MODELED' });
}

export function evaluateCorrelationEvidence({ xMetric, yMetric, pairs, asOfUtc }) {
  phase4Metric(xMetric); phase4Metric(yMetric);
  if (!Array.isArray(pairs) || pairs.length > 400 || !validInstant(asOfUtc)) throw new Error('PHASE4_CORRELATION_INPUT_INVALID');
  const seen = new Set(), eligible = [];
  for (const pair of pairs) {
    if (!validHealthDate(pair.healthDate) || seen.has(pair.healthDate)) throw new Error('PHASE4_CORRELATION_DAY_INVALID');
    seen.add(pair.healthDate);
    if (validMetricValue(xMetric, pair.x) && validMetricValue(yMetric, pair.y)
      && ['LIMITED', 'AVAILABLE'].includes(pair.quality)) eligible.push(pair);
  }
  const xs = eligible.map(pair => pair.x), ys = eligible.map(pair => pair.y), r = pearson(xs, ys), rho = spearman(xs, ys);
  return Object.freeze({ xMetric, yMetric, sampleCount: eligible.length, sufficient: eligible.length >= 20 && r !== null && rho !== null,
    pearson: r, spearman: rho, rawSignificance: pValue(r, eligible.length), direction: r === null ? null : r > 0 ? 'POSITIVE' : r < 0 ? 'NEGATIVE' : 'FLAT',
    causalStatus: 'ASSOCIATION_ONLY', caveats: Object.freeze(['AUTOCORRELATION_NOT_MODELED', 'OBSERVATIONAL_WITHIN_PERSON']) });
}

export function evaluateSimilarDayEvidence({ rows, targetHealthDate, topN = 5 }) {
  if (!Array.isArray(rows) || rows.length > 400 || !validHealthDate(targetHealthDate)
    || !Number.isSafeInteger(topN) || topN < 1 || topN > 20) throw new Error('PHASE4_SIMILAR_DAY_INPUT_INVALID');
  const seen = new Set();
  for (const row of rows) {
    if (!validHealthDate(row.health_date) || seen.has(row.health_date)) throw new Error('PHASE4_SIMILAR_DAY_DUPLICATE');
    seen.add(row.health_date);
  }
  const matches = findSimilarDays(rows, targetHealthDate, { topN });
  return Object.freeze({ targetHealthDate, sampleCount: rows.length, matches: matches.map(match => Object.freeze({ ...match })),
    sufficient: matches.length > 0, causalStatus: 'ASSOCIATION_ONLY' });
}

export function evaluateBodyEnergyDriverEvidence(result) {
  if (!result || result.metric_registry_version !== 'body-energy-metrics-v1'
    || !['LIMITED', 'AVAILABLE'].includes(result.quality_state) || !Number.isSafeInteger(result.value)
    || result.value < 0 || result.value > 100) throw new Error('PHASE4_BODY_ENERGY_EVIDENCE_UNAVAILABLE');
  let drivers;
  try { drivers = typeof result.driver_json === 'string' ? JSON.parse(result.driver_json) : structuredClone(result.driver_json); }
  catch { throw new Error('PHASE4_BODY_ENERGY_DRIVER_INVALID'); }
  if (!drivers || Object.getPrototypeOf(drivers) !== Object.prototype) throw new Error('PHASE4_BODY_ENERGY_DRIVER_INVALID');
  return Object.freeze({ method: 'DETERMINISTIC_DRIVER_DECOMPOSITION', value: result.value, unit: 'score',
    quality: result.quality_state, confidence: result.confidence, algorithmVersion: result.algorithm_version,
    metricRegistryVersion: result.metric_registry_version, drivers: Object.freeze(drivers), causalStatus: 'ASSOCIATION_ONLY' });
}
