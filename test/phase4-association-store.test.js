import test from 'node:test';
import assert from 'node:assert/strict';
import { syntheticPhase4Fixture } from './phase4Fixture.js';
import { bodyInput, seedBodyInput } from './bodyEnergyFixture.js';
import { addDays } from '../src/time.js';

const nowMs = Date.parse('2026-09-25T12:00:00.000Z');

async function insertCoverage(f, { startDate, endDate, id = 'coverage-caffeine' }) {
  const state = (await f.db.raw.execute("SELECT u.lifecycle_generation,COALESCE(t.auth_generation,0) auth_generation,p.purge_generation,c.input_generation FROM users u LEFT JOIN user_whoop_tokens t ON t.user_id=u.id JOIN phase4_user_state p ON p.user_id=u.id JOIN phase4_computation_state c ON c.user_id=u.id AND c.execution_mode='SHADOW' WHERE u.id='a'")).rows[0];
  const at = new Date(nowMs).toISOString(), privacyId = f.keys.lookup(['synthetic-coverage', id]);
  await f.db.raw.execute({ sql: `INSERT INTO journal_coverage_windows(user_id,coverage_window_id,window_start_utc,window_end_utc,
    health_date_start,health_date_end,recorded_timezone,factor_set_version,factor_keys_json,source_event_key,confirmation_text_hash,
    parser_version,normalizer_version,lifecycle_generation,auth_generation,input_generation,status,revision,answer_confidence,
    created_at,updated_at,content_state,source_linkage_state,privacy_artifact_id,content_digest_salt,purge_generation)
    VALUES ('a',?,?,?,?,?,'Asia/Taipei','journal-factors-v1','["caffeine"]',?,'synthetic-confirmation',
    'journal-candidate-v1','journal-normalizer-v1',?,?,?,'ACTIVE',1,1,?,?,'PRESENT','COMPLETE',?,?,?)`,
  args: [id, `${startDate}T00:00:00.000Z`, `${addDays(endDate, 1)}T00:00:00.000Z`, startDate, endDate,
    `coverage-source-${id}`, state.lifecycle_generation, state.auth_generation, state.input_generation, at, at,
    privacyId, f.keys.newSalt(), state.purge_generation] });
  return id;
}

async function setup(t, { days = 60, createFacts = true,wallClock=nowMs } = {}) {
  let clock = new Date(wallClock);
  const f = await syntheticPhase4Fixture(t, { now: () => clock });
  const input = bodyInput({ asOf: nowMs, days: days - 1 });
  for (let index = 0; index < input.sources.recovery.length; index += 1) {
    input.sources.recovery[index].recovery_score = index % 2 === 0 ? 40 : 50;
  }
  await f.db.transaction(() => seedBodyInput(f.db, input));
  const logicalFacts = [], control = await f.stores.captureControl('a');
  if (createFacts) for (let index = 0; index < input.sources.recovery.length; index += 2) {
    const factorDate = addDays(input.sources.recovery[index].health_date, -1), eventAt = `${factorDate}T13:00:00.000Z`;
    const sourceText = `caffeine at ${eventAt}`;
    const created = await f.stores.journal.create(control, { sourceEventKey: `caffeine-${index}`, sourceText,
      candidate: { category: 'caffeine', eventAt, valueKind: 'PRESENCE', exposureState: 'EXPOSED', extractionConfidence: 1,
        excerptStart: 0, excerptEnd: [...sourceText].length } });
    assert.equal(created.status, 'ACCEPT'); logicalFacts.push(created.logicalFactId);
  }
  const factorDates = input.sources.recovery.map(row => addDays(row.health_date, -1)).sort();
  const coverageId = await insertCoverage(f, { startDate: factorDates[0], endDate: factorDates.at(-1) });
  const context = await f.stores.capture('a', { executionMode: 'SHADOW' });
  const outcomeRefs = [];
  for (const row of input.sources.recovery) outcomeRefs.push((await f.stores.root(context, 'recovery', row.sleep_id)).ref);
  const factRows = (await f.db.raw.execute("SELECT logical_fact_id,privacy_artifact_id FROM journal_events WHERE user_id='a' AND fact_status='ACTIVE' ORDER BY health_date")).rows;
  const factRefs = [];
  for (const row of factRows) factRefs.push((await f.stores.root(context, 'JOURNAL_FACT', row.privacy_artifact_id)).ref);
  const coverageRef = (await f.stores.root(context, 'JOURNAL_COVERAGE', coverageId)).ref;
  return { ...f, context, control, input, outcomeRefs, factRefs, coverageRef, logicalFacts,
    setNow(value) { clock = new Date(value); } };
}

function hypothesis(f, indexes) {
  return { factor: 'caffeine', outcomeMetric: 'recovery_score', lagDays: 1,
    comparisonHealthDates: indexes.map(index=>f.input.sources.recovery[index].health_date),
    outcomeSources: indexes.map(index => f.outcomeRefs[index]), journalFactSources: f.factRefs, coverageSources: [f.coverageRef] };
}
const family = (name, hypothesisValue, asOfUtc = new Date(nowMs).toISOString()) => ({
  asOfUtc, multipleTestingFamily: name, hypotheses: [hypothesisValue],
});

test('Tri-state Journal association persists exact classified counts, multiplicity and non-causal provenance', async t => {
  const f = await setup(t), result = await f.stores.intelligence.analyzeAssociationFamily(f.context,
    family('caffeine-recovery-old', hypothesis(f, Array.from({ length: 30 }, (_, index) => index + 30))));
  const output = result.items[0];
  assert.equal(result.runs.length, 1);
  assert.equal(result.runs[0].row.state, 'COMPLETED');
  assert.equal(result.runs[0].row.multiple_testing_family, 'caffeine-recovery-old');
  assert.equal(result.runs[0].row.unknown_eligible_days, 0);
  assert.equal(result.runs[0].row.eligible_observation_days, 30);
  assert.equal(output.analysis.exposedCount, 15);
  assert.equal(output.analysis.confirmedUnexposedCount, 15);
  assert.equal(output.analysis.unknownCount, 0);
  assert.equal(output.analysis.effect, -10);
  assert.equal(output.analysis.causalStatus, 'ASSOCIATION_ONLY');
  assert.equal(output.analysis.insightSupporting, true);
  assert.ok(output.item.row.adjusted_significance <= 0.10);
  assert.equal(output.item.row.causal_status, 'ASSOCIATION_ONLY');
  const durableConfidence=JSON.parse(output.item.row.provenance_json).confidence;
  assert.equal(durableConfidence.version,'evidence-confidence-v1');
  assert.equal(durableConfidence.score,output.analysis.confidence.score);
  assert.equal(output.insight.current.row.status, 'EMERGING');
  assert.match(output.insight.current.row.statement, /may be associated/);
  assert.doesNotMatch(output.insight.current.row.statement, /causes|prevents|diagnoses/i);
});

test('Full comparison universe retains both 30-day groups with only 16 outcomes each and blocks >40% missingness',async t=>{
  const f=await setup(t),exposedIndexes=Array.from({length:30},(_,index)=>index*2),
    unexposedIndexes=Array.from({length:30},(_,index)=>index*2+1),indexes=[...exposedIndexes,...unexposedIndexes],
    withOutcome=[...exposedIndexes.slice(0,16),...unexposedIndexes.slice(0,16)];
  const input={factor:'caffeine',outcomeMetric:'recovery_score',lagDays:1,
    comparisonHealthDates:indexes.map(index=>f.input.sources.recovery[index].health_date),
    outcomeSources:withOutcome.map(index=>f.outcomeRefs[index]),journalFactSources:f.factRefs,coverageSources:[f.coverageRef]};
  const result=await f.stores.intelligence.analyzeAssociationFamily(f.context,family('missing-outcome-mutation',input)),analysis=result.items[0].analysis;
  assert.equal(analysis.comparisonDayCount,60);assert.equal(analysis.classifiedExposedDays,30);
  assert.equal(analysis.classifiedConfirmedUnexposedDays,30);
  assert.equal(analysis.exposedOutcomePresentCount,16);assert.equal(analysis.exposedOutcomeMissingCount,14);
  assert.equal(analysis.confirmedUnexposedOutcomePresentCount,16);assert.equal(analysis.confirmedUnexposedOutcomeMissingCount,14);
  assert.equal(analysis.missingOutcomeFractionExposed,14/30);assert.equal(analysis.candidate,false);
  assert.equal(analysis.missingOutcomeFractionUnexposed,14/30);
  assert.ok(analysis.reasonCodes.includes('DIFFERENTIAL_MISSINGNESS'));
  const missing=JSON.parse(result.runs[0].row.missingness_json);
  assert.equal(missing.comparison_day_count,60);assert.equal(missing.exposed_outcome_missing_count,14);
  assert.equal(missing.confirmed_unexposed_outcome_missing_count,14);
  const ordered=[...input.comparisonHealthDates].sort(),nextDay=`${addDays(ordered.at(-1),1)}T00:00:00.000Z`,asOf=new Date(nowMs).toISOString();
  assert.equal(result.runs[0].row.window_start_utc,`${ordered[0]}T00:00:00.000Z`);
  assert.equal(result.runs[0].row.window_end_utc,nextDay<asOf?nextDay:asOf);
});

test('UNKNOWN-heavy valid-outcome windows remain UNKNOWN and fail the promotion confound',async t=>{
  const f=await setup(t,{days:30,createFacts:false}),input={factor:'stress',outcomeMetric:'recovery_score',lagDays:1,
    comparisonHealthDates:f.input.sources.recovery.map(row=>row.health_date),outcomeSources:f.outcomeRefs,
    journalFactSources:[],coverageSources:[]};
  const result=await f.stores.intelligence.analyzeAssociationFamily(f.context,family('unknown-heavy-mutation',input)),analysis=result.items[0].analysis;
  assert.equal(analysis.unknownCount,30);assert.equal(analysis.unknownFraction,1);assert.equal(analysis.insightSupporting,false);
  assert.ok(analysis.reasonCodes.includes('UNKNOWN_FRACTION_EXCEEDED'));
  assert.equal(result.runs[0].row.unknown_eligible_days,30);
});

test('Shuffled hypotheses and source arrays converge on identical association hashes and identities',async t=>{
  const f=await setup(t),indexes=Array.from({length:30},(_,index)=>index),caffeine=hypothesis(f,indexes),stress={...hypothesis(f,indexes),factor:'stress'};
  const first=await f.stores.intelligence.analyzeAssociationFamily(f.context,{asOfUtc:new Date(nowMs).toISOString(),
    multipleTestingFamily:'canonical-order-mutation',hypotheses:[stress,caffeine]});
  const shuffled=value=>({...value,outcomeSources:[...value.outcomeSources].reverse(),
    journalFactSources:[...value.journalFactSources].reverse(),coverageSources:[...value.coverageSources].reverse(),
    comparisonHealthDates:[...value.comparisonHealthDates].reverse()});
  const second=await f.stores.intelligence.analyzeAssociationFamily(f.context,{asOfUtc:new Date(nowMs).toISOString(),
    multipleTestingFamily:'canonical-order-mutation',hypotheses:[shuffled(caffeine),shuffled(stress)]});
  assert.deepEqual(second.runs.map(run=>[run.row.subject_key,run.row.deterministic_run_key,run.row.input_manifest_hash]),
    first.runs.map(run=>[run.row.subject_key,run.row.deterministic_run_key,run.row.input_manifest_hash]));
  assert.deepEqual(second.items.map(output=>output.item.row.evidence_item_id),first.items.map(output=>output.item.row.evidence_item_id));
});

test('A correction created after T cannot replace the readable revision authoritative at T',async t=>{
  const f=await setup(t,{days:10}),factorDate=addDays(f.input.sources.recovery[0].health_date,-1);
  const old=(await f.db.raw.execute({sql:"SELECT * FROM journal_events WHERE user_id='a' AND health_date=? LIMIT 1",args:[factorDate]})).rows[0];
  await f.db.raw.execute({sql:"UPDATE journal_events SET fact_status='SUPERSEDED' WHERE user_id='a' AND id=?",args:[old.id]});
  const replacement={...old};delete replacement.id;Object.assign(replacement,{revision:2,fact_status:'ACTIVE',category:'stress',
    source_event_key:`post-t-correction-${old.id}`,supersedes_event_id:old.id,created_at:'2026-09-25T13:00:00.000Z',
    updated_at:'2026-09-25T13:00:00.000Z',privacy_artifact_id:f.keys.lookup(['post-t-correction',old.logical_fact_id]),
    content_digest_salt:f.keys.newSalt()});
  const names=Object.keys(replacement);await f.db.raw.execute({sql:`INSERT INTO journal_events(${names.join(',')}) VALUES (${names.map(()=>'?').join(',')})`,
    args:names.map(name=>replacement[name])});
  f.setNow('2026-09-25T14:00:00.000Z');const context=await f.stores.capture('a',{executionMode:'SHADOW'}),
    outcome=(await f.stores.root(context,'recovery',f.input.sources.recovery[0].sleep_id)).ref,
    corrected=(await f.stores.root(context,'JOURNAL_FACT',replacement.privacy_artifact_id)).ref;
  const input={factor:'caffeine',outcomeMetric:'recovery_score',lagDays:1,
    comparisonHealthDates:[f.input.sources.recovery[0].health_date],outcomeSources:[outcome],journalFactSources:[corrected],coverageSources:[]};
  const result=await f.stores.intelligence.analyzeAssociationFamily(context,family('journal-as-of-mutation',input,new Date(nowMs).toISOString()));
  const manifest=JSON.parse(result.runs[0].row.input_manifest_json),focus=manifest.hypotheses[0];
  assert.equal(focus.journal_authority[0].revision,1);assert.equal(focus.days[0].exposureState,'EXPOSED');
  assert.match((await f.db.raw.execute({sql:"SELECT relationship FROM phase4_source_links WHERE artifact_type='evidence_runs' AND source_id=?",
    args:[old.privacy_artifact_id]})).rows[0].relationship,/^DEPENDS_ON_AS_OF:/);
});

test('Future-created Journal facts and coverage stay UNKNOWN at T and replay identically later',async t=>{
  const f=await setup(t,{days:10}),future='2026-09-25T13:00:00.000Z',later='2026-11-01T12:00:00.000Z',
    date=f.input.sources.recovery[0].health_date,factorDate=addDays(date,-1);
  const fact=(await f.db.raw.execute({sql:"SELECT privacy_artifact_id FROM journal_events WHERE user_id='a' AND health_date=? LIMIT 1",
    args:[factorDate]})).rows[0],coverage=(await f.db.raw.execute("SELECT coverage_window_id FROM journal_coverage_windows WHERE user_id='a' LIMIT 1")).rows[0];
  await f.db.raw.execute({sql:'UPDATE journal_events SET created_at=?,updated_at=? WHERE privacy_artifact_id=?',
    args:[future,future,fact.privacy_artifact_id]});
  await f.db.raw.execute({sql:'UPDATE journal_coverage_windows SET created_at=?,updated_at=? WHERE coverage_window_id=?',
    args:[future,future,coverage.coverage_window_id]});
  const references=async context=>({outcome:(await f.stores.root(context,'recovery',f.input.sources.recovery[0].sleep_id)).ref,
    futureFact:(await f.stores.root(context,'JOURNAL_FACT',fact.privacy_artifact_id)).ref,
    futureCoverage:(await f.stores.root(context,'JOURNAL_COVERAGE',coverage.coverage_window_id)).ref});
  f.setNow('2026-09-25T14:00:00.000Z');const context=await f.stores.capture('a',{executionMode:'SHADOW'}),refs=await references(context);
  const analyze=(activeContext,activeRefs,name,journalFactSources,coverageSources)=>f.stores.intelligence.analyzeAssociationFamily(activeContext,
    family(name,{factor:'caffeine',outcomeMetric:'recovery_score',lagDays:1,comparisonHealthDates:[date],
      outcomeSources:[activeRefs.outcome],journalFactSources,coverageSources},new Date(nowMs).toISOString()));
  const factResult=await analyze(context,refs,'future-fact-as-of',[refs.futureFact],[]),
    coverageResult=await analyze(context,refs,'future-coverage-as-of',[],[refs.futureCoverage]);
  for(const result of [factResult,coverageResult]) {
    const manifest=JSON.parse(result.runs[0].row.input_manifest_json).hypotheses[0];
    assert.equal(result.items[0].analysis.unknownCount,1);assert.equal(manifest.days[0].exposureState,'UNKNOWN');
    assert.deepEqual(manifest.journal_authority,[]);
  }
  f.setNow(later);const laterContext=await f.stores.capture('a',{executionMode:'SHADOW'}),laterRefs=await references(laterContext);
  const replay=await analyze(laterContext,laterRefs,'future-fact-as-of',[laterRefs.futureFact],[]);
  assert.equal(replay.runs[0].row.run_id,factResult.runs[0].row.run_id);
  assert.equal(replay.runs[0].row.input_manifest_hash,factResult.runs[0].row.input_manifest_hash);
});

test('Insight expiry uses explicit semantic time even when processing happens much later',async t=>{
  const f=await setup(t),result=await f.stores.intelligence.analyzeAssociationFamily(f.context,
    family('semantic-expiry-mutation',hypothesis(f,Array.from({length:30},(_,index)=>index))));
  const current=result.items[0].insight.current;f.setNow('2027-01-31T12:00:00.000Z');
  const context=await f.stores.capture('a',{executionMode:'SHADOW'});
  await assert.rejects(f.stores.intelligence.expireInsight(context,{insightId:current.row.id,
    asOfUtc:new Date(nowMs).toISOString()}),/NOT_EXPIRED/);
  const expired=await f.stores.intelligence.expireInsight(context,{insightId:current.row.id,
    asOfUtc:new Date(Date.parse(current.row.expires_at)+1).toISOString()});
  assert.equal(expired.row.status,'RETIRED');assert.equal(expired.row.retired_at,new Date(Date.parse(current.row.expires_at)+1).toISOString());
});

test('A second non-overlapping supporting run promotes EMERGING to SUPPORTED, never HYPOTHESIS directly', async t => {
  const f = await setup(t), oldIndexes = Array.from({ length: 30 }, (_, index) => index + 30),
    recentIndexes = Array.from({ length: 30 }, (_, index) => index),oldRequest=family('caffeine-recovery-old',hypothesis(f,oldIndexes));
  const first = await f.stores.intelligence.analyzeAssociationFamily(f.context,oldRequest);
  assert.equal(first.items[0].insight.current.row.status, 'EMERGING');
  assert.equal(first.items[0].insight.current.row.current_revision, 2);
  const second = await f.stores.intelligence.analyzeAssociationFamily(f.context,
    family('caffeine-recovery-recent', hypothesis(f, recentIndexes)));
  assert.equal(second.items[0].insight.current.row.status, 'SUPPORTED');
  assert.equal(second.items[0].insight.current.row.current_revision, 3);
  assert.match(second.items[0].insight.current.row.statement, /repeatedly associated in your data/);
  const history = (await f.db.raw.execute('SELECT status FROM insight_revisions ORDER BY revision')).rows.map(row => row.status);
  assert.deepEqual(history, ['HYPOTHESIS', 'EMERGING', 'SUPPORTED']);
  assert.equal((await f.db.raw.execute('SELECT count(*) n FROM health_insights')).rows[0].n, 1);
  const before=(await f.db.raw.execute(`SELECT (SELECT count(*) FROM evidence_runs) runs,
    (SELECT count(*) FROM evidence_items) items,(SELECT count(*) FROM insight_revisions) revisions`)).rows[0];
  const replay=await f.stores.intelligence.analyzeAssociationFamily(f.context,oldRequest);
  assert.equal(replay.items[0].replayed,true);
  assert.equal(replay.items[0].insight.current.row.status,'EMERGING');
  assert.equal(replay.items[0].insight.current.row.current_revision,2);
  assert.equal((await f.db.raw.execute('SELECT status FROM health_insights')).rows[0].status,'SUPPORTED');
  assert.deepEqual((await f.db.raw.execute(`SELECT (SELECT count(*) FROM evidence_runs) runs,
    (SELECT count(*) FROM evidence_items) items,(SELECT count(*) FROM insight_revisions) revisions`)).rows[0],before);
});

test('Association replay is byte-stable and does not append evidence or insight revisions', async t => {
  const f = await setup(t), input = family('caffeine-recovery-replay', hypothesis(f, Array.from({ length: 30 }, (_, index) => index)));
  const first = await f.stores.intelligence.analyzeAssociationFamily(f.context, input);
  const before = (await f.db.raw.execute(`SELECT (SELECT count(*) FROM evidence_runs) runs,(SELECT count(*) FROM evidence_items) items,
    (SELECT count(*) FROM health_insights) insights,(SELECT count(*) FROM insight_revisions) revisions`)).rows[0];
  const second = await f.stores.intelligence.analyzeAssociationFamily(f.context, input);
  assert.equal(second.runs[0].row.run_id, first.runs[0].row.run_id);
  assert.equal(second.items[0].item.row.evidence_item_id, first.items[0].item.row.evidence_item_id);
  assert.deepEqual((await f.db.raw.execute(`SELECT (SELECT count(*) FROM evidence_runs) runs,(SELECT count(*) FROM evidence_items) items,
    (SELECT count(*) FROM health_insights) insights,(SELECT count(*) FROM insight_revisions) revisions`)).rows[0], before);
});

test('Insufficient samples and UNKNOWN absence persist evidence but cannot create an insight', async t => {
  const f = await setup(t, { days: 10, createFacts: false });
  const request = family('unknown-is-not-unexposed', { factor: 'stress', outcomeMetric: 'recovery_score', lagDays: 1,
    comparisonHealthDates:f.input.sources.recovery.map(row=>row.health_date),outcomeSources: f.outcomeRefs, journalFactSources: [], coverageSources: [] });
  const result = await f.stores.intelligence.analyzeAssociationFamily(f.context, request);
  assert.equal(result.items[0].analysis.unknownCount, 10);
  assert.equal(result.items[0].analysis.confirmedUnexposedCount, 0);
  assert.equal(result.items[0].analysis.candidate, false);
  assert.equal(result.items[0].insight, null);
  assert.equal((await f.db.raw.execute('SELECT count(*) n FROM health_insights')).rows[0].n, 0);
  assert.equal((await f.db.raw.execute('SELECT count(*) n FROM evidence_items')).rows[0].n, 1);
});

test('Repeated opposite evidence weakens a supported insight and records contradiction without causal refutation', async t => {
  const f = await setup(t), oldIndexes = Array.from({ length: 30 }, (_, index) => index + 30), recentIndexes = Array.from({ length: 30 }, (_, index) => index);
  await f.stores.intelligence.analyzeAssociationFamily(f.context, family('support-old', hypothesis(f, oldIndexes)));
  const supported = await f.stores.intelligence.analyzeAssociationFamily(f.context, family('support-recent', hypothesis(f, recentIndexes)));
  const supportedId = supported.items[0].insight.current.row.id;
  for (let index = 0; index < 30; index += 1) {
    const source = f.input.sources.recovery[index], id = `opposite-${index}`;
    await f.db.raw.execute({ sql: `INSERT INTO whoop_recoveries(user_id,sleep_id,health_date,score_state,recovery_score,
      hrv_rmssd_milli,resting_heart_rate,user_calibrating,updated_at,synced_at) VALUES ('a',?,?,'SCORED',?,50,60,0,?,?)`,
    args: [id, source.health_date, index % 2 === 0 ? 60 : 40, source.updated_at, source.synced_at] });
  }
  const oppositeRefs = [];
  for (let index = 0; index < 30; index += 1) oppositeRefs.push((await f.stores.root(f.context, 'recovery', `opposite-${index}`)).ref);
  const oppositeRequest=family('opposite-recent',{
    factor: 'caffeine', outcomeMetric: 'recovery_score', lagDays: 1,
    comparisonHealthDates:f.input.sources.recovery.slice(0,30).map(row=>row.health_date),outcomeSources: oppositeRefs,
    journalFactSources: f.factRefs, coverageSources: [f.coverageRef] }),
    opposite=await f.stores.intelligence.analyzeAssociationFamily(f.context,oppositeRequest);
  assert.equal(opposite.items[0].analysis.direction, 'HIGHER');
  assert.equal(opposite.items[0].insight.contradiction.row.id, supportedId);
  assert.equal(opposite.items[0].insight.contradiction.row.status, 'WEAKENED');
  assert.equal(opposite.items[0].insight.contradiction.revision.transition_reason, 'CONTRADICTORY_EVIDENCE');
  assert.equal(opposite.items[0].insight.current.row.status, 'EMERGING');
  const before=(await f.db.raw.execute('SELECT count(*) n FROM insight_revisions')).rows[0].n,
    replay=await f.stores.intelligence.analyzeAssociationFamily(f.context,oppositeRequest);
  assert.equal(replay.items[0].replayed,true);
  assert.equal(replay.items[0].insight.contradiction.row.status,'WEAKENED');
  assert.equal(replay.items[0].insight.current.row.status,'EMERGING');
  assert.equal((await f.db.raw.execute('SELECT count(*) n FROM insight_revisions')).rows[0].n,before);
});

test('Insight expiry is an explicit retained revision and expired memory is not current', async t => {
  const f = await setup(t), result = await f.stores.intelligence.analyzeAssociationFamily(f.context,
    family('expiry', hypothesis(f, Array.from({ length: 30 }, (_, index) => index))));
  const id = result.items[0].insight.current.row.id, expiresAt = result.items[0].insight.current.row.expires_at;
  await assert.rejects(f.stores.intelligence.expireInsight(f.context, { insightId: id,asOfUtc:new Date(nowMs).toISOString() }), /NOT_EXPIRED/);
  f.setNow(new Date(Date.parse(expiresAt) + 1).toISOString());
  const fresh = await f.stores.capture('a', { executionMode: 'SHADOW' });
  const expired = await f.stores.intelligence.expireInsight(fresh, { insightId: id,asOfUtc:new Date(Date.parse(expiresAt)+1).toISOString() });
  assert.equal(expired.row.status, 'RETIRED');
  assert.equal(expired.row.lifecycle_disposition, 'EXPIRED');
  assert.equal(expired.revision.transition_reason, 'EXPIRED');
  await assert.rejects(f.stores.insights.read(fresh, id,{asOfUtc:new Date(Date.parse(expiresAt)+1).toISOString()}), /NOT_CURRENT/);
  assert.equal((await f.db.raw.execute({ sql: 'SELECT count(*) n FROM insight_revisions WHERE insight_id=?', args: [id] })).rows[0].n, 3);
});

test('A candidate that ages out before repetition is retired as REJECTED, not promoted or silently deleted', async t => {
  const f = await setup(t), result = await f.stores.intelligence.analyzeAssociationFamily(f.context,
    family('candidate-expiry', hypothesis(f, Array.from({ length: 20 }, (_, index) => index))));
  const current = result.items[0].insight.current;
  assert.equal(result.items[0].analysis.candidate, true);
  assert.equal(result.items[0].analysis.repeated, false);
  assert.equal(current.row.status, 'HYPOTHESIS');
  f.setNow(new Date(Date.parse(current.row.expires_at) + 1).toISOString());
  const fresh = await f.stores.capture('a', { executionMode: 'SHADOW' });
  const rejected = await f.stores.intelligence.expireInsight(fresh, { insightId: current.row.id,
    asOfUtc:new Date(Date.parse(current.row.expires_at)+1).toISOString() });
  assert.equal(rejected.row.status, 'RETIRED');
  assert.equal(rejected.row.lifecycle_disposition, 'REJECTED');
  assert.equal(rejected.revision.transition_reason, 'REJECTED');
});

test('Deleting a linked Journal fact redacts transitive evidence and insight content and prevents source replay resurrection', async t => {
  const f = await setup(t), result = await f.stores.intelligence.analyzeAssociationFamily(f.context,
    family('purge-lineage', hypothesis(f, Array.from({ length: 30 }, (_, index) => index))));
  const insightId = result.items[0].insight.current.row.id;
  const target = (await f.db.raw.execute({ sql: "SELECT logical_fact_id,privacy_artifact_id FROM journal_events WHERE user_id='a' AND fact_status='ACTIVE' ORDER BY health_date LIMIT 1" })).rows[0];
  await f.stores.release(f.context);
  const deletion = await f.stores.journal.remove(f.control, { logicalFactId: target.logical_fact_id, idempotencyKey: 'stage5-purge' });
  await f.stores.privacy.complete(f.control, deletion.purgeId);
  assert.equal((await f.db.raw.execute('SELECT content_state FROM evidence_runs')).rows[0].content_state, 'REDACTED');
  assert.equal((await f.db.raw.execute('SELECT content_state FROM evidence_items')).rows[0].content_state, 'REDACTED');
  assert.equal((await f.db.raw.execute({ sql: 'SELECT content_state FROM health_insights WHERE id=?', args: [insightId] })).rows[0].content_state, 'REDACTED');
  const fresh = await f.stores.capture('a', { executionMode: 'SHADOW' });
  await assert.rejects(f.stores.root(fresh, 'JOURNAL_FACT', target.privacy_artifact_id), /SOURCE_NOT_FOUND/);
  await assert.rejects(f.stores.insights.read(fresh, insightId, { history: true }), /CONTENT_REDACTED/);
});

test('Association inputs remain tenant-bound and LIVE authority cannot execute Stage 5', async t => {
  const f = await setup(t), other = await f.stores.capture('b', { executionMode: 'SHADOW' }), input = family('isolation', hypothesis(f, Array.from({ length: 30 }, (_, index) => index)));
  await assert.rejects(f.stores.intelligence.analyzeAssociationFamily(other, input), /INVALID_SOURCE_REFERENCE/);
  await f.stores.initializeTenant('a', 'LIVE');
  const live = await f.stores.capture('a', { executionMode: 'LIVE' });
  await assert.rejects(f.stores.intelligence.analyzeAssociationFamily(live, input), /SHADOW_ONLY/);
  assert.equal((await f.db.raw.execute("SELECT count(*) n FROM evidence_runs WHERE user_id='b' OR execution_mode='LIVE'")).rows[0].n, 0);
});
