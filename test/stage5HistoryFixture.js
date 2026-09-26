import { syntheticPhase4Fixture } from './phase4Fixture.js';
import { bodyInput, seedBodyInput } from './bodyEnergyFixture.js';

const T = Date.parse('2026-09-25T12:00:00.000Z');
const request = (currentSource, baselineSources, asOfUtc = new Date(T).toISOString()) => ({
  metricKey: 'recovery_score', currentSource, baselineSources, asOfUtc, windowFamily: 'DAILY_RECOVERY',
});

async function recoveryRefs(stores, context, ids) {
  const refs = [];
  for (const id of ids) refs.push((await stores.root(context, 'recovery', id)).ref);
  return refs;
}

async function setup(t) {
  let now = new Date(T);
  const fixture = await syntheticPhase4Fixture(t, { now: () => now });
  const input = bodyInput({ asOf: T, days: 30 });
  for (let index = 0; index < input.sources.recovery.length; index += 1) {
    input.sources.recovery[index].recovery_score = index === 0 ? 15 : [40, 45, 50, 55, 60][(index - 1) % 5];
  }
  await fixture.db.transaction(() => seedBodyInput(fixture.db, input));
  const recoveryIds = input.sources.recovery.map(row => row.sleep_id);
  const context = await fixture.stores.capture('a', { executionMode: 'SHADOW' });
  const refs = await recoveryRefs(fixture.stores, context, recoveryIds);
  return { ...fixture, context, recoveryIds, initialRefs: refs, setNow(value) { now = new Date(value); } };
}

async function analyzeInserted(f,{userId='a',id='next-low',healthDate='2026-09-26',observedAt='2026-09-26T10:00:00.000Z',
  asOfUtc='2026-09-26T12:00:00.000Z',value=10,baselineIds=f.recoveryIds.slice(0,30)}={}) {
  f.setNow(asOfUtc);
  await f.db.raw.execute({ sql: `INSERT INTO whoop_recoveries(user_id,sleep_id,health_date,score_state,recovery_score,
    hrv_rmssd_milli,resting_heart_rate,user_calibrating,updated_at,synced_at) VALUES (?,?,?,'SCORED',?,50,60,0,?,?)`,
  args: [userId,id,healthDate,value,observedAt,asOfUtc] });
  const context = await f.stores.capture(userId, { executionMode: 'SHADOW' });
  const refs = await recoveryRefs(f.stores, context, [id, ...baselineIds]);
  return f.stores.intelligence.analyzeMetric(context, request(refs[0], refs.slice(1), asOfUtc));
}

const progressOneDay = (f,id='next-low',extra={}) => analyzeInserted(f,{id,...extra});

async function replayInitial(f,userId='a',ids=f.recoveryIds,stores=f.stores) {
  const context = await stores.capture(userId, { executionMode: 'SHADOW' });
  const refs = await recoveryRefs(stores, context, ids);
  return stores.intelligence.analyzeMetric(context, request(refs[0], refs.slice(1)));
}

async function durableCounts(db) {
  return (await db.raw.execute(`SELECT
    (SELECT count(*) FROM evidence_runs) runs,(SELECT count(*) FROM evidence_items) items,
    (SELECT count(*) FROM observation_episodes) episodes,(SELECT count(*) FROM episode_observations) observations,
    (SELECT count(*) FROM episode_evidence) memberships,(SELECT count(*) FROM episode_events) events,
    (SELECT count(*) FROM episode_semantic_events) semantic,(SELECT count(*) FROM health_insights) insights,
    (SELECT count(*) FROM insight_revisions) insight_revisions,(SELECT count(*) FROM phase4_source_links) source_links`)).rows[0];
}


export { T, request, recoveryRefs, setup, analyzeInserted, progressOneDay, replayInitial, durableCounts };

// Deliberately independent of the production projection: unknown future
// episode fields participate automatically in full-field equality assertions.
const NON_SEMANTIC = new Set(['created_at','updated_at','content_digest_salt','content_state','source_linkage_state',
  'health_content_redacted_at','health_content_redaction_reason','source_subject_deleted_at',
  'last_question_id','last_delivered_notification_id','last_ambiguous_attempt_id']);
export const semanticProjection = row => Object.fromEntries(Object.entries(row).filter(([k])=>!NON_SEMANTIC.has(k)));

export async function syntheticEvidence(f,context,key,refs=null) {
  refs??=[(await f.stores.root(context,'USER',context.userId)).ref];
  const run=await f.stores.evidence.start(context,{deterministic_run_key:key,method:'SYNTHETIC',algorithm_version:'fixture',registry_version:'fixture',
    evidence_contract_version:'fixture',promotion_confound_version:'fixture',exposure_classification_version:'fixture',
    factor_set_version:'fixture',started_at:f.core.timestamp()},refs);
  await f.stores.evidence.complete(context,run.row.run_id,{});
  return f.stores.evidence.addItem(context,{run_id:run.row.run_id,item_key:key,exposure_classification_version:'fixture',factor_set_version:'fixture'});
}
export const historyCounts = async db => ({...await durableCounts(db),
  snapshots:(await db.raw.execute('SELECT count(*) n FROM phase4_episode_revisions')).rows[0].n});

// Real registered no-artifact evidence for historical fixtures that require
// v26 authority. It never fabricates or backfills authority for synthetic rows.
export async function authoritativeEvidence(f,context,identity='registered-history') {
  const source=(await f.db.raw.execute({sql:'SELECT * FROM whoop_recoveries WHERE user_id=? AND sleep_id=?',
    args:[context.userId,f.recoveryIds[0]]})).rows[0];
  const copy={...source,sleep_id:`history-${f.keys.lookup(['history-fixture-source-v1',identity])}`};
  await f.db.raw.execute({sql:`INSERT INTO whoop_recoveries(${Object.keys(copy).join(',')}) VALUES (${Object.keys(copy).map(()=>'?').join(',')})
    ON CONFLICT(user_id,sleep_id) DO NOTHING`,args:Object.values(copy)});
  const current=(await f.stores.root(context,'recovery',copy.sleep_id)).ref;
  const result=await f.stores.intelligence.analyzeMetric(context,{metricKey:'hrv',currentSource:current,
    baselineSources:[],asOfUtc:new Date(T).toISOString(),windowFamily:'HISTORY_FIXTURE'});
  if(result.episode!==null)throw Error('HISTORY_FIXTURE_EXPECTED_NULL_RESULT');
  return result.item;
}
