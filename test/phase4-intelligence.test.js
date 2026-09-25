import test from 'node:test';
import assert from 'node:assert/strict';
import { PHASE4_METRICS, phase4Metric, EVIDENCE_METHOD_REGISTRY } from '../src/phase4IntelligenceRegistry.js';
import { assessDataQuality, benjaminiHochberg, buildPersonalBaseline, evaluateJournalAssociation,
  evaluateBodyEnergyDriverEvidence, evaluateCorrelationEvidence, evaluateMeaningfulChange, evaluateMonotonicTrend,
  evaluateSimilarDayEvidence, evidenceConfidence, linearQuantile, median,
  recencyWeight, validMetricValue } from '../src/phase4Intelligence.js';

const asOf = '2026-09-25T12:00:00.000Z';
const day = (offset, value = 50, extra = {}) => {
  const date = new Date(Date.parse('2026-09-25T08:00:00.000Z') - offset * 86_400_000);
  return { sourceType: 'recovery', sourceId: `source-${offset}`, sourceVersion: `v-${offset}`,
    healthDate: date.toISOString().slice(0, 10), observedAt: date.toISOString(), ingestedAt: date.toISOString(), value, ...extra };
};
const mature = (metricKey = 'recovery_score', value = 50) => buildPersonalBaseline({ metricKey,
  targetHealthDate: '2026-09-25', asOfUtc: asOf,
  observations: Array.from({ length: 30 }, (_, index) => day(index + 1, value + (index % 5) - 2)) });
const wideBaseline = () => buildPersonalBaseline({ metricKey: 'recovery_score', targetHealthDate: '2026-09-25', asOfUtc: asOf,
  observations: Array.from({ length: 30 }, (_, index) => day(index + 1, [40, 45, 50, 55, 60][index % 5])) });
const quality = (metricKey = 'recovery_score', baseline = mature(metricKey), current = day(0, 20)) => assessDataQuality({
  metricKey, current: { ...current, ingestedAt: '2026-09-25T11:00:00.000Z' }, baseline, asOfUtc: asOf,
  inputGeneration: 4, lifecycleGeneration: 2, authGeneration: 3, provenance: [['recovery', current.sourceId]],
});

test('Stage 5 metric and evidence registries are closed, processed-record-only product contracts', () => {
  assert.deepEqual(Object.keys(PHASE4_METRICS).sort(), ['body_energy', 'cycle_strain', 'hrv', 'recovery_score',
    'respiratory_rate', 'rhr', 'sleep_duration_minutes', 'sleep_efficiency', 'sleep_performance']);
  assert.equal(phase4Metric('hrv').baselineMethod, 'MEDIAN_MAD_IQR');
  assert.equal(phase4Metric('rhr').polarity, 'LOWER_IS_BETTER');
  assert.equal(phase4Metric('body_energy').notificationCapable, false);
  assert.equal(EVIDENCE_METHOD_REGISTRY.JOURNAL_ASSOCIATION.method, 'EXPOSED_VS_CONFIRMED_UNEXPOSED');
  assert.throws(() => phase4Metric('raw_ppg'), /METRIC_UNREGISTERED/);
  assert.equal(validMetricValue('recovery_score', 0), true);
  assert.equal(validMetricValue('recovery_score', 101), false);
  assert.equal(validMetricValue('hrv', 0), false);
});

test('Robust baseline uses exact median, MAD, and linear IQR fallback', () => {
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(linearQuantile([0, 10, 20, 30], 0.25), 7.5);
  const mad = buildPersonalBaseline({ metricKey: 'rhr', targetHealthDate: '2026-09-25', asOfUtc: asOf,
    observations: [50, 51, 52, 53, 54, 55, 100].map((value, index) => day(index + 1, value)) });
  assert.equal(mad.median, 53);
  assert.equal(mad.mad, 2);
  assert.equal(mad.scale, 2 * 1.4826);
  assert.equal(mad.scaleMethod, 'MAD_X_1_4826');
  const iqr = buildPersonalBaseline({ metricKey: 'rhr', targetHealthDate: '2026-09-25', asOfUtc: asOf,
    observations: [50, 50, 50, 50, 55, 55, 55].map((value, index) => day(index + 1, value)) });
  assert.equal(iqr.mad, 0);
  assert.equal(iqr.scale, 5 / 1.349);
  assert.equal(iqr.scaleMethod, 'IQR_DIV_1_349');
  const zero = buildPersonalBaseline({ metricKey: 'rhr', targetHealthDate: '2026-09-25', asOfUtc: asOf,
    observations: Array.from({ length: 7 }, (_, index) => day(index + 1, 50)) });
  assert.equal(zero.scale, null);
  assert.equal(zero.sufficient, false);
});

test('Baseline is earlier-only, as-of-correct, unique by health day, 45-day bounded, and capped at 30 valid days', () => {
  const observations = Array.from({ length: 50 }, (_, index) => day(index + 1, 40 + index));
  observations.push(day(0, 99));
  observations.push(day(2, 1, { sourceId: 'duplicate-old', observedAt: '2026-09-23T01:00:00.000Z' }));
  observations.push(day(3, 2, { sourceId: 'future-ingest', ingestedAt: '2026-09-26T00:00:00.000Z' }));
  const result = buildPersonalBaseline({ metricKey: 'recovery_score', targetHealthDate: '2026-09-25', asOfUtc: asOf, observations });
  assert.equal(result.sampleCount, 30);
  assert.equal(new Set(result.samples.map(item => item.healthDate)).size, 30);
  assert.equal(result.samples.some(item => item.value === 99), false);
  assert.equal(result.samples.some(item => item.sourceId === 'future-ingest'), false);
  assert.ok(result.exclusions.some(item => item.reason === 'SOURCE_AFTER_AS_OF'));
  assert.ok(result.exclusions.some(item => item.reason === 'NOT_EARLIER_THAN_TARGET'));
  assert.ok(result.exclusions.some(item => item.reason === 'DUPLICATE_HEALTH_DAY'));
  assert.ok(result.exclusions.some(item => item.reason === 'OUTSIDE_BASELINE_LOOKBACK'));
});

test('Data quality precedence is fail-closed and missing never becomes neutral evidence', () => {
  const baseline = mature(), current = { ...day(0, 20), ingestedAt: '2026-09-25T11:00:00.000Z' };
  assert.equal(assessDataQuality({ metricKey: 'unknown', asOfUtc: asOf }).status, 'UNAVAILABLE');
  assert.equal(assessDataQuality({ metricKey: 'recovery_score', asOfUtc: asOf, baseline }).status, 'NO_DATA');
  assert.equal(assessDataQuality({ metricKey: 'recovery_score', asOfUtc: asOf, current: { ...current, value: 999 }, baseline }).status, 'DEGRADED');
  const short = buildPersonalBaseline({ metricKey: 'recovery_score', targetHealthDate: '2026-09-25', asOfUtc: asOf,
    observations: Array.from({ length: 6 }, (_, index) => day(index + 1, 50 + index)) });
  assert.equal(assessDataQuality({ metricKey: 'recovery_score', asOfUtc: asOf, current, baseline: short }).status, 'WARMING_UP');
  const limited = buildPersonalBaseline({ metricKey: 'recovery_score', targetHealthDate: '2026-09-25', asOfUtc: asOf,
    observations: Array.from({ length: 7 }, (_, index) => day(index + 1, 50 + index)) });
  assert.equal(assessDataQuality({ metricKey: 'recovery_score', asOfUtc: asOf, current, baseline: limited }).status, 'LIMITED');
  const available = assessDataQuality({ metricKey: 'recovery_score', asOfUtc: asOf, current, baseline });
  assert.equal(available.status, 'AVAILABLE');
  assert.equal(available.inputGeneration, null);
  assert.deepEqual(available.reasonCodes, []);
  const unavailable = assessDataQuality({ metricKey: 'recovery_score', asOfUtc: asOf, current, baseline, lifecycleValid: false });
  assert.equal(unavailable.status, 'UNAVAILABLE');
  assert.ok(unavailable.reasonCodes.includes('LIFECYCLE_MISMATCH'));
});

test('Meaningful change requires magnitude plus persistence, with a registered severe single-observation exception', () => {
  const baseline = wideBaseline(), current = { ...day(0, 30), observedAt: '2026-09-25T10:00:00.000Z', ingestedAt: '2026-09-25T11:00:00.000Z' };
  const q = quality('recovery_score', baseline, current);
  const once = evaluateMeaningfulChange({ metricKey: 'recovery_score', current, baseline, quality: q });
  assert.equal(once.openPass, true);
  assert.equal(once.persistent, false);
  assert.equal(once.severeSingle, false);
  assert.equal(once.classification, 'NO_MEANINGFUL_CHANGE');
  const twice = evaluateMeaningfulChange({ metricKey: 'recovery_score', current, baseline, quality: q,
    priorQualifying: [{ direction: 'LOWER', robustZ: -3, observedAt: '2026-09-24T10:00:00.000Z' }] });
  assert.equal(twice.persistent, true);
  assert.equal(twice.qualified, true);
  assert.equal(twice.classification, 'NEW_CHANGE');
  assert.equal(twice.semanticImpact, 'UNFAVORABLE');
  const severeCurrent = { ...current, value: 15 };
  const severe = evaluateMeaningfulChange({ metricKey: 'recovery_score', current: severeCurrent, baseline,
    quality: quality('recovery_score', baseline, severeCurrent) });
  assert.equal(severe.severeSingle, true);
  assert.equal(severe.classification, 'NEW_CHANGE');
});

test('Persistence uses elapsed 30-minute/36-hour boundaries and novelty is semantic, not calendar based', () => {
  const baseline = wideBaseline(), current = { ...day(0, 30), observedAt: '2026-09-25T10:00:00.000Z', ingestedAt: '2026-09-25T11:00:00.000Z' };
  const q = quality('recovery_score', baseline, current), prior = robustZ => ({ direction: 'LOWER', robustZ, observedAt: '2026-09-25T09:30:00.000Z' });
  const atBoundary = evaluateMeaningfulChange({ metricKey: 'recovery_score', current, baseline, quality: q, priorQualifying: [prior(-3)] });
  assert.equal(atBoundary.persistent, true);
  const tooClose = evaluateMeaningfulChange({ metricKey: 'recovery_score', current, baseline, quality: q,
    priorQualifying: [{ ...prior(-3), observedAt: '2026-09-25T09:30:00.001Z' }] });
  assert.equal(tooClose.persistent, false);
  const repeat = evaluateMeaningfulChange({ metricKey: 'recovery_score', current, baseline, quality: q,
    priorQualifying: [prior(-3)], recentSemanticHashes: [atBoundary.semanticHash] });
  assert.equal(repeat.novelty, false);
  assert.equal(repeat.semanticHash, atBoundary.semanticHash);
  assert.ok(repeat.meaningfulness < atBoundary.meaningfulness);
});

test('Hysteresis holds between open and close, stabilizes below close, and resolves only after 24 elapsed hours', () => {
  const baseline = mature(), scale = baseline.scale, active = { state: 'ESCALATED', direction: 'LOWER', severity: 2 };
  const between = { ...day(0, baseline.median - 2 * scale), observedAt: '2026-09-25T10:00:00.000Z', ingestedAt: '2026-09-25T11:00:00.000Z' };
  const held = evaluateMeaningfulChange({ metricKey: 'recovery_score', current: between, baseline,
    quality: quality('recovery_score', baseline, between), activeEpisode: active });
  assert.equal(held.openPass, false);
  assert.equal(held.closePass, false);
  assert.equal(held.classification, 'CONTINUING_CHANGE');
  const close = { ...between, value: baseline.median - scale };
  const improving = evaluateMeaningfulChange({ metricKey: 'recovery_score', current: close, baseline,
    quality: quality('recovery_score', baseline, close), activeEpisode: active, nowUtc: '2026-09-25T12:00:00.000Z' });
  assert.equal(improving.closePass, true);
  assert.equal(improving.classification, 'IMPROVING');
  assert.equal(improving.targetEpisodeState, 'STABILIZING');
  const beforeHold = evaluateMeaningfulChange({ metricKey: 'recovery_score', current: close, baseline,
    quality: quality('recovery_score', baseline, close), activeEpisode: { ...active, state: 'STABILIZING', stabilizationStartedAt: '2026-09-24T12:00:00.001Z' }, nowUtc: asOf });
  assert.equal(beforeHold.classification, 'IMPROVING');
  const heldLongEnough = evaluateMeaningfulChange({ metricKey: 'recovery_score', current: close, baseline,
    quality: quality('recovery_score', baseline, close), activeEpisode: { ...active, state: 'STABILIZING', stabilizationStartedAt: '2026-09-24T12:00:00.000Z' }, nowUtc: asOf });
  assert.equal(heldLongEnough.classification, 'RESOLVED');
});

test('Robust-z thresholds are stable at 2.49/2.50/2.51 and 1.49/1.50/1.51 in both directions', () => {
  const baseline={median:50,scale:5},q={status:'AVAILABLE',confidence:1,freshnessAgeMs:0};
  const calculate=(z,activeEpisode=null)=>evaluateMeaningfulChange({metricKey:'recovery_score',baseline,quality:q,
    current:{...day(0,50+z*5),observedAt:'2026-09-25T10:00:00.000Z',ingestedAt:'2026-09-25T11:00:00.000Z'},activeEpisode});
  for(const sign of [-1,1]) {
    assert.equal(calculate(sign*2.49).openPass,false);
    assert.equal(calculate(sign*2.50).openPass,true);
    assert.equal(calculate(sign*2.51).openPass,true);
    const active={state:'OPEN',direction:sign<0?'LOWER':'HIGHER',severity:1};
    assert.equal(calculate(sign*1.49,active).closePass,true);
    assert.equal(calculate(sign*1.50,active).closePass,false);
    assert.equal(calculate(sign*1.51,active).closePass,false);
  }
  const floating=(median,scale,value,activeEpisode=null)=>evaluateMeaningfulChange({metricKey:'recovery_score',
    baseline:{median,scale},quality:q,current:{...day(0,value),observedAt:'2026-09-25T10:00:00.000Z',
      ingestedAt:'2026-09-25T11:00:00.000Z'},activeEpisode});
  assert.equal(floating(10,1.23,13.075).robustZ,2.4999999999999996);
  assert.equal(floating(10,1.23,13.075).openPass,true);
  assert.equal(floating(10,1.24,6.9).robustZ,-2.4999999999999996);
  assert.equal(floating(10,1.24,6.9).openPass,true);
  assert.equal(Math.abs(floating(.11,.026,.07100000000000001).robustZ),1.4999999999999998);
  assert.equal(floating(.11,.026,.07100000000000001,{state:'OPEN',direction:'LOWER',severity:1}).closePass,false);
});

test('Metric polarity is explicit and opposite qualified direction requests reversal', () => {
  const rhrBaseline = mature('rhr', 60), high = { ...day(0, 75), observedAt: '2026-09-25T10:00:00.000Z', ingestedAt: '2026-09-25T11:00:00.000Z' };
  const highChange = evaluateMeaningfulChange({ metricKey: 'rhr', current: high, baseline: rhrBaseline,
    quality: quality('rhr', rhrBaseline, high) });
  assert.equal(highChange.semanticImpact, 'UNFAVORABLE');
  const recoveryBaseline = mature(), highRecovery = { ...high, value: 65 };
  const favorable = evaluateMeaningfulChange({ metricKey: 'recovery_score', current: highRecovery, baseline: recoveryBaseline,
    quality: quality('recovery_score', recoveryBaseline, highRecovery), priorQualifying: [{ direction: 'HIGHER', robustZ: 3, observedAt: '2026-09-24T10:00:00.000Z' }],
    activeEpisode: { state: 'OPEN', direction: 'LOWER', severity: 1 } });
  assert.equal(favorable.semanticImpact, 'FAVORABLE');
  assert.equal(favorable.classification, 'DIRECTION_REVERSAL');
});

test('Evidence confidence implements exact weights and hard/missing-uncertainty caps', () => {
  const full = evidenceConfidence({ dataQuality: 1, sampleSufficiency: 1, replication: 1, effectStability: 1,
    recency: 1, multiplicityControl: 1, softConfoundFraction: 0 });
  assert.equal(full.score, 1);
  assert.equal(full.label, 'HIGH');
  assert.equal(evidenceConfidence({ dataQuality: 1, sampleSufficiency: 1, replication: 1, effectStability: 1,
    recency: 1, multiplicityControl: 1, softConfoundFraction: 0, hardConfound: true }).score, 0.399999);
  assert.equal(evidenceConfidence({ dataQuality: 1, sampleSufficiency: 1, replication: 1, effectStability: 1,
    recency: 1, multiplicityControl: 1, softConfoundFraction: 0, uncertaintyAvailable: false }).score, 0.599999);
  assert.equal(recencyWeight(0), 1);
  assert.equal(recencyWeight(30), 0.5);
  assert.equal(recencyWeight(-1), 0);
});

test('Benjamini-Hochberg adjustment is deterministic and retains the complete family', () => {
  const adjusted = benjaminiHochberg([{ key: 'b', pValue: 0.04 }, { key: 'a', pValue: 0.01 }, { key: 'c', pValue: 0.03 }]);
  assert.deepEqual(adjusted.map(item => item.key), ['b', 'a', 'c']);
  assert.deepEqual(adjusted.map(item => item.adjusted), [0.04, 0.03, 0.04]);
  assert.throws(() => benjaminiHochberg([]), /MULTIPLICITY_FAMILY_INVALID/);
  assert.throws(() => benjaminiHochberg([{ key: 'x', pValue: 2 }]), /MULTIPLICITY_FAMILY_INVALID/);
});

function associationDays({ unknown = 0, exposed = 25, unexposed = 25, start = '2026-06-01' } = {}) {
  const states = [...Array(exposed).fill('EXPOSED'), ...Array(unexposed).fill('CONFIRMED_UNEXPOSED'), ...Array(unknown).fill('UNKNOWN')];
  return states.map((exposureState, index) => ({
    healthDate: new Date(Date.parse(`${start}T00:00:00.000Z`) + index * 86_400_000).toISOString().slice(0, 10),
    exposureState, outcome: exposureState === 'EXPOSED' ? 40 : 50, quality: 'AVAILABLE',
  }));
}
const windows = [{ start: '2026-06-01T00:00:00.000Z', end: '2026-06-16T00:00:00.000Z', direction: 'LOWER' },
  { start: '2026-06-16T00:00:00.000Z', end: '2026-09-20T00:00:00.000Z', direction: 'LOWER' }];

test('Journal association uses only EXPOSED and CONFIRMED_UNEXPOSED, never UNKNOWN as absence', () => {
  const result = evaluateJournalAssociation({ factor: 'alcohol', outcomeMetric: 'recovery_score', days: associationDays({ unknown: 50 }),
    replicationWindows: windows, adjustedSignificance: 0.05, asOfUtc: asOf });
  assert.equal(result.exposedCount, 25);
  assert.equal(result.confirmedUnexposedCount, 25);
  assert.equal(result.unknownCount, 50);
  assert.equal(result.unknownFraction, 0.5);
  assert.equal(result.effect, -10);
  assert.equal(result.causalStatus, 'ASSOCIATION_ONLY');
  assert.equal(result.insightSupporting, true);
  assert.equal(result.readiness, 'INSIGHT_SUPPORTING');
});

test('UNKNOWN promotion confound has exact 0.50 pass and 0.51 block boundaries', () => {
  for (const [unknown, exposed, unexposed, expected] of [[0, 50, 50, true], [49, 26, 25, true], [50, 25, 25, true], [51, 25, 24, false], [100, 0, 0, false]]) {
    const result = evaluateJournalAssociation({ factor: 'stress', outcomeMetric: 'recovery_score',
      days: associationDays({ unknown, exposed, unexposed }), replicationWindows: windows, adjustedSignificance: 0.05, asOfUtc: asOf });
    assert.equal(result.insightSupporting, expected, `${unknown}/${unknown + exposed + unexposed}`);
    assert.equal(result.reasonCodes.includes('UNKNOWN_FRACTION_EXCEEDED'), unknown / (unknown + exposed + unexposed) > 0.5);
  }
  const none = evaluateJournalAssociation({ factor: 'stress', outcomeMetric: 'recovery_score', days: [], asOfUtc: asOf });
  assert.equal(none.unknownFraction, null);
  assert.equal(none.insightSupporting, false);
  assert.ok(none.reasonCodes.includes('NO_ELIGIBLE_OBSERVATION_DAYS'));
});

test('Journal association fails closed on sample, effect, missingness, replication, multiplicity, recency and confounds', () => {
  const insufficient = evaluateJournalAssociation({ factor: 'caffeine', outcomeMetric: 'recovery_score',
    days: associationDays({ exposed: 5, unexposed: 5 }), asOfUtc: asOf });
  assert.equal(insufficient.candidate, false);
  assert.equal(insufficient.effect, null, 'comparative effect stays closed until every comparison floor passes');
  assert.equal(insufficient.exposedMean, null);
  assert.equal(insufficient.confirmedUnexposedMean, null);
  assert.equal(insufficient.readiness, 'INSUFFICIENT_EXPOSURE_CLASSIFICATION');
  const candidate = evaluateJournalAssociation({ factor: 'caffeine', outcomeMetric: 'recovery_score',
    days: associationDays({ exposed: 10, unexposed: 10 }), asOfUtc: asOf });
  assert.equal(candidate.candidate, true);
  assert.equal(candidate.repeated, false);
  const confounded = evaluateJournalAssociation({ factor: 'caffeine', outcomeMetric: 'recovery_score', days: associationDays(),
    replicationWindows: windows, adjustedSignificance: 0.05, hardConfoundFlags: ['TRAVEL'], asOfUtc: asOf });
  assert.equal(confounded.insightSupporting, false);
  assert.ok(confounded.confidence.score < 0.4);
  const noMultiplicity = evaluateJournalAssociation({ factor: 'caffeine', outcomeMetric: 'recovery_score', days: associationDays(),
    replicationWindows: windows, asOfUtc: asOf });
  assert.equal(noMultiplicity.repeated, true);
  assert.equal(noMultiplicity.insightSupporting, false);
});

test('Journal association rejects duplicate health days and invalid exposure states', () => {
  const duplicate = associationDays({ exposed: 10, unexposed: 10 }); duplicate[1].healthDate = duplicate[0].healthDate;
  assert.throws(() => evaluateJournalAssociation({ factor: 'travel', outcomeMetric: 'recovery_score', days: duplicate, asOfUtc: asOf }), /ASSOCIATION_DAY_INVALID/);
  const invalid = associationDays({ exposed: 10, unexposed: 10 }); invalid[0].exposureState = 'ABSENT';
  assert.throws(() => evaluateJournalAssociation({ factor: 'travel', outcomeMetric: 'recovery_score', days: invalid, asOfUtc: asOf }), /ASSOCIATION_DAY_INVALID/);
});

test('Journal missingness distinguishes absent from present-but-invalid outcomes while gating on both',()=>{
  const days=associationDays({exposed:10,unexposed:10});
  Object.assign(days[0],{outcome:null,outcomeStatus:'MISSING',quality:'NO_DATA'});
  Object.assign(days[1],{outcome:null,outcomeStatus:'INVALID',quality:'DEGRADED'});
  const result=evaluateJournalAssociation({factor:'travel',outcomeMetric:'recovery_score',days,asOfUtc:asOf});
  assert.equal(result.exposedOutcomeMissingCount,1);assert.equal(result.exposedOutcomeInvalidCount,1);
  assert.equal(result.exposedOutcomePresentCount,8);assert.equal(result.missingOutcomeFractionExposed,.2);
});

test('Exactly 40% group missingness remains eligible while UNKNOWN never becomes unexposed',()=>{
  const days=associationDays({exposed:20,unexposed:20,unknown:5});
  for(const day of days.filter(value=>value.exposureState==='EXPOSED').slice(0,8))
    Object.assign(day,{outcome:null,outcomeStatus:'MISSING',quality:'NO_DATA'});
  const result=evaluateJournalAssociation({factor:'travel',outcomeMetric:'recovery_score',days,asOfUtc:asOf});
  assert.equal(result.missingOutcomeFractionExposed,.4);assert.equal(result.missingOutcomeFractionUnexposed,0);
  assert.equal(result.confirmedUnexposedCount,20);assert.equal(result.unknownCount,5);
  assert.ok(!result.reasonCodes.includes('DIFFERENTIAL_MISSINGNESS'));
  assert.equal(result.candidate,true);
});

test('Monotonic trend has an explicit bounded window, real elapsed-day slope and serial-correlation caveat', () => {
  const observations = Array.from({ length: 10 }, (_, index) => ({ ...day(10 - index, 40 + index), observedAt: new Date(Date.parse(asOf) - (10 - index) * 86_400_000).toISOString() }));
  const trend = evaluateMonotonicTrend({ metricKey: 'recovery_score', observations, windowDays: 30, asOfUtc: asOf });
  assert.equal(trend.sampleCount, 10);
  assert.equal(trend.sufficient, true);
  assert.equal(trend.slopePerDay, 1);
  assert.equal(trend.direction, 'HIGHER');
  assert.equal(trend.rSquared, 1);
  assert.equal(trend.caveat, 'SERIAL_CORRELATION_NOT_MODELED');
  assert.throws(() => evaluateMonotonicTrend({ metricKey: 'recovery_score', observations, windowDays: 0, asOfUtc: asOf }), /TREND_WINDOW_INVALID/);
});

test('Registered correlation reports Pearson and Spearman without causal language or UNKNOWN substitution', () => {
  const pairs = Array.from({ length: 20 }, (_, index) => ({ healthDate: new Date(Date.parse('2026-08-01T00:00:00Z') + index * 86_400_000).toISOString().slice(0, 10),
    x: 40 + index, y: 80 - index, quality: 'AVAILABLE' }));
  const result = evaluateCorrelationEvidence({ xMetric: 'hrv', yMetric: 'recovery_score', pairs, asOfUtc: asOf });
  assert.equal(result.sampleCount, 20);
  assert.equal(result.sufficient, true);
  assert.equal(result.pearson, -1);
  assert.equal(result.spearman, -1);
  assert.equal(result.direction, 'NEGATIVE');
  assert.equal(result.causalStatus, 'ASSOCIATION_ONLY');
});

test('Registered similar-day adapter is bounded and deterministic', () => {
  const rows = Array.from({ length: 8 }, (_, index) => ({ health_date: new Date(Date.parse('2026-09-01T00:00:00Z') + index * 86_400_000).toISOString().slice(0, 10),
    hrv: 40 + index, rhr: 70 - index, recovery: 50 + index, sleep_total: 400 + index * 5,
    sleep_performance: 70 + index, sleep_debt: 30 - index, previous_day_strain: 5 + index, respiratory_rate: 14 + index / 10 }));
  const first = evaluateSimilarDayEvidence({ rows, targetHealthDate: rows.at(-1).health_date, topN: 3 });
  const second = evaluateSimilarDayEvidence({ rows: [...rows].reverse(), targetHealthDate: rows.at(-1).health_date, topN: 3 });
  assert.equal(first.matches.length, 3);
  assert.deepEqual(first.matches, second.matches);
  assert.equal(first.causalStatus, 'ASSOCIATION_ONLY');
});

test('Body Energy evidence consumes the existing deterministic result without recalculating its formula', () => {
  const result = evaluateBodyEnergyDriverEvidence({ value: 72, quality_state: 'AVAILABLE', confidence: 0.9,
    algorithm_version: 'body-energy-v1.2.0', metric_registry_version: 'body-energy-metrics-v1',
    driver_json: JSON.stringify({ sleep: 80, autonomic: 65, load: 4 }) });
  assert.equal(result.value, 72);
  assert.deepEqual(result.drivers, { sleep: 80, autonomic: 65, load: 4 });
  assert.equal(result.method, 'DETERMINISTIC_DRIVER_DECOMPOSITION');
  assert.throws(() => evaluateBodyEnergyDriverEvidence({ value: 72, quality_state: 'DEGRADED',
    metric_registry_version: 'body-energy-metrics-v1' }), /EVIDENCE_UNAVAILABLE/);
});

test('RC4 baseline exclusions and duplicate-day decisions are canonical across permutations without erasing source changes',()=>{
  const rows=Array.from({length:35},(_,i)=>day(i+1,40+i));
  rows.push(day(0),day(50),day(3,999),day(2,51,{sourceId:'duplicate'}),null,{});
  const baseline=observations=>buildPersonalBaseline({metricKey:'recovery_score',targetHealthDate:'2026-09-25',asOfUtc:asOf,observations});
  const expected=baseline(rows);
  assert.deepEqual(baseline([...rows].reverse()),expected);
  assert.deepEqual(baseline([...rows.slice(15),...rows.slice(0,15)]),expected);
  assert.equal(expected.sampleCount,30);assert.equal(expected.exclusions.length,rows.length-30);
  assert.ok(expected.exclusions.some(x=>x.reason==='DUPLICATE_HEALTH_DAY'));
  assert.equal(expected.exclusions.filter(x=>x.reason==='INVALID_HEALTH_DATE').length,2);
  const changed=rows.map((row,i)=>i===0?{...row,sourceVersion:'new-source-version'}:row);
  assert.notDeepEqual(baseline(changed),expected);
});
