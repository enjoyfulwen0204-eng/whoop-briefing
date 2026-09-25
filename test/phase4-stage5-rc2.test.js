import test from 'node:test';
import assert from 'node:assert/strict';
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

test('RC2 exact historical replay remains stable after forward episode progression', async t => {
  const f = await setup(t);
  const first = await f.stores.intelligence.analyzeMetric(f.context,
    request(f.initialRefs[0], f.initialRefs.slice(1)));
  const progressed = await progressOneDay(f);
  assert.equal(progressed.episode.episode.row.episode_id, first.episode.episode.row.episode_id);
  assert.equal(progressed.episode.episode.row.revision, 2);

  const fresh = await f.stores.capture('a', { executionMode: 'SHADOW' });
  const replayRefs = await recoveryRefs(f.stores, fresh, f.recoveryIds);
  const replay = await f.stores.intelligence.analyzeMetric(fresh,
    request(replayRefs[0], replayRefs.slice(1)));

  assert.equal(replay.run.row.run_id, first.run.row.run_id);
  assert.equal(replay.item.row.evidence_item_id, first.item.row.evidence_item_id);
  assert.equal(replay.episode.episode.row.episode_id, first.episode.episode.row.episode_id);
  assert.equal(replay.episode.replayed, true);
  assert.equal(replay.episode.episode.row.revision, 1);
  assert.equal((await f.db.raw.execute({ sql: 'SELECT revision FROM observation_episodes WHERE episode_id=?',
    args: [first.episode.episode.row.episode_id] })).rows[0].revision, 2);
});

test('RC2 repeated historical replay converges without semantic or provenance writes', async t => {
  const f=await setup(t),first=await f.stores.intelligence.analyzeMetric(f.context,
    request(f.initialRefs[0],f.initialRefs.slice(1)));
  await progressOneDay(f);
  const before=await durableCounts(f.db),results=[];
  for(let index=0;index<3;index+=1)results.push(await replayInitial(f));
  for(const replay of results) {
    assert.equal(replay.run.row.run_id,first.run.row.run_id);
    assert.equal(replay.item.row.evidence_item_id,first.item.row.evidence_item_id);
    assert.equal(replay.episode.episode.row.episode_id,first.episode.episode.row.episode_id);
    assert.equal(replay.episode.episode.row.revision,1);
    assert.equal(replay.episode.episode.row.last_observed_at,first.episode.episode.row.last_observed_at);
    assert.equal(replay.calculation.classification,first.calculation.classification);
  }
  assert.deepEqual(await durableCounts(f.db),before);
});

test('RC2 historical replay stays stable after two forward revisions',async t=>{
  const f=await setup(t),first=await f.stores.intelligence.analyzeMetric(f.context,
    request(f.initialRefs[0],f.initialRefs.slice(1)));
  await progressOneDay(f);
  const third=await analyzeInserted(f,{id:'third-low',healthDate:'2026-09-27',observedAt:'2026-09-27T10:00:00.000Z',
    asOfUtc:'2026-09-27T12:00:00.000Z',baselineIds:['next-low',...f.recoveryIds.slice(0,29)]});
  assert.equal(third.episode.episode.row.revision,3);
  const before=await durableCounts(f.db),replay=await replayInitial(f);
  assert.equal(replay.episode.episode.row.revision,1);
  assert.equal(replay.episode.episode.row.state,first.episode.episode.row.state);
  assert.equal((await f.db.raw.execute('SELECT revision FROM observation_episodes LIMIT 1')).rows[0].revision,3);
  assert.deepEqual(await durableCounts(f.db),before);
});

test('RC2 durable reload resolves replay without process-local cache authority',async t=>{
  const f=await setup(t),first=await f.stores.intelligence.analyzeMetric(f.context,
    request(f.initialRefs[0],f.initialRefs.slice(1)));
  await progressOneDay(f);
  const restarted=await f.restart(),replay=await replayInitial(f,'a',f.recoveryIds,restarted.stores);
  assert.equal(replay.run.row.run_id,first.run.row.run_id);
  assert.equal(replay.item.row.evidence_item_id,first.item.row.evidence_item_id);
  assert.equal(replay.episode.episode.row.episode_id,first.episode.episode.row.episode_id);
  assert.equal(replay.episode.episode.row.revision,1);
});

test('RC2 exact replay is independent of later processing wall clocks',async t=>{
  const f=await setup(t),first=await f.stores.intelligence.analyzeMetric(f.context,
    request(f.initialRefs[0],f.initialRefs.slice(1)));
  await progressOneDay(f);
  const snapshots=[];
  for(const wallClock of ['2026-10-15T12:00:00.000Z','2027-02-01T12:00:00.000Z']) {
    f.setNow(wallClock);const replay=await replayInitial(f);
    snapshots.push({run:replay.run.row.run_id,item:replay.item.row.evidence_item_id,
      calculation:replay.calculation,episode:Object.fromEntries(['episode_id','revision','state','severity','current_confidence',
        'current_novelty','first_observed_at','last_observed_at','last_material_change_at','expires_at','semantic_summary_hash']
        .map(field=>[field,replay.episode.episode.row[field]]))});
  }
  assert.deepEqual(snapshots[1],snapshots[0]);
  assert.equal(snapshots[0].episode.revision,first.episode.episode.row.revision);
});

test('RC2 lower episode and insight stores require explicit semantic time',async t=>{
  const f=await setup(t),analyzed=await f.stores.intelligence.analyzeMetric(f.context,
    request(f.initialRefs[0],f.initialRefs.slice(1))),item=analyzed.item;
  await assert.rejects(f.stores.episodes.open(f.context,{identity:{algorithmMajor:'fixture',direction:'LOWER',domain:'recovery',
    metric:'synthetic',subject:'synthetic',windowFamily:'NO_CLOCK'},data:{episode_type:'SYNTHETIC',severity:1},
    evidenceItemId:item.row.evidence_item_id}),/SEMANTIC_TIME_REQUIRED/);
  await assert.rejects(f.stores.episodes.revise(f.context,{episodeId:analyzed.episode.episode.row.episode_id,expectedRevision:1,
    toState:'UPDATING',patch:{last_observed_at:'2026-09-25T12:00:00.000Z'},sourceRefs:[item.ref],reasonCode:'NEW_EVIDENCE'}),
  /SEMANTIC_TIME_REQUIRED/);
  const candidate={identity:{subject:'synthetic-clock',outcome:'recovery',direction:'lower',exposureCategory:'synthetic',
    algorithmFamily:'synthetic',evidenceContractMajor:'1'},claim:'Synthetic clock candidate.',creationKey:'clock-candidate',
    evidenceContractVersion:'phase4-evidence-v1',
    supportingEvidenceIds:[item.row.evidence_item_id],expiresAt:'2026-10-01T12:00:00.000Z'};
  await assert.rejects(f.stores.insights.create(f.context,candidate),/SEMANTIC_TIME_REQUIRED/);
  const created=await f.stores.insights.create(f.context,{...candidate,semanticAt:new Date(T).toISOString()});
  await assert.rejects(f.stores.insights.read(f.context,created.row.id),/SEMANTIC_TIME_REQUIRED/);
  await assert.rejects(f.stores.insights.transition(f.context,{insightId:created.row.id,expectedRevision:1,status:'RETIRED',
    disposition:'USER_DISMISSED',claim:candidate.claim,supportingEvidenceIds:candidate.supportingEvidenceIds,
    reason:'USER_DISMISSED'}),/SEMANTIC_TIME_REQUIRED/);
});

test('RC2 lifecycle ABA rejects stale replay context while a fresh same-generation context succeeds',async t=>{
  const f=await setup(t),first=await f.stores.intelligence.analyzeMetric(f.context,
    request(f.initialRefs[0],f.initialRefs.slice(1)));
  await progressOneDay(f);
  const validContext=await f.stores.capture('a',{executionMode:'SHADOW'}),validRefs=await recoveryRefs(f.stores,validContext,f.recoveryIds);
  const replay=await f.stores.intelligence.analyzeMetric(validContext,request(validRefs[0],validRefs.slice(1)));
  assert.equal(replay.run.row.run_id,first.run.row.run_id);
  await f.db.transitionUserLifecycle({userId:'a',targetStatus:'DISABLED'});
  await f.db.transitionUserLifecycle({userId:'a',targetStatus:'ACTIVE'});
  await assert.rejects(f.stores.intelligence.analyzeMetric(validContext,request(validRefs[0],validRefs.slice(1))),/LIFECYCLE_FENCED/);
});

test('RC2 equivalent users cannot resolve each other durable replay state',async t=>{
  const f=await setup(t),bInput=bodyInput({asOf:T,days:30});
  bInput.userId='b';
  for(const type of Object.keys(bInput.sources))for(const row of bInput.sources[type]) {
    row.user_id='b';if(row.id)row.id=`b-${row.id}`;if(row.sleep_id)row.sleep_id=`b-${row.sleep_id}`;
  }
  for(const rows of [bInput.access,bInput.sync,bInput.capabilities])for(const row of rows)row.user_id='b';
  for(let index=0;index<bInput.sources.recovery.length;index+=1)
    bInput.sources.recovery[index].recovery_score=index===0?15:[40,45,50,55,60][(index-1)%5];
  await f.db.transaction(()=>seedBodyInput(f.db,bInput));
  const aFirst=await f.stores.intelligence.analyzeMetric(f.context,request(f.initialRefs[0],f.initialRefs.slice(1))),
    bIds=bInput.sources.recovery.map(row=>row.sleep_id),bContext=await f.stores.capture('b',{executionMode:'SHADOW'}),
    bRefs=await recoveryRefs(f.stores,bContext,bIds),bFirst=await f.stores.intelligence.analyzeMetric(bContext,request(bRefs[0],bRefs.slice(1)));
  await progressOneDay(f);
  await analyzeInserted(f,{userId:'b',id:'b-next-low',baselineIds:bIds.slice(0,30)});
  const aReplay=await replayInitial(f),bReplay=await replayInitial(f,'b',bIds);
  assert.equal(aReplay.run.row.run_id,aFirst.run.row.run_id);assert.equal(bReplay.run.row.run_id,bFirst.run.row.run_id);
  assert.notEqual(aReplay.run.row.run_id,bReplay.run.row.run_id);
  assert.notEqual(aReplay.episode.episode.row.episode_id,bReplay.episode.episode.row.episode_id);
  assert.equal((await f.db.raw.execute("SELECT count(*) n FROM evidence_runs WHERE user_id='a'")).rows[0].n,2);
  assert.equal((await f.db.raw.execute("SELECT count(*) n FROM evidence_runs WHERE user_id='b'")).rows[0].n,2);
});

test('RC2 SHADOW replay cannot resolve or mutate LIVE state',async t=>{
  const f=await setup(t);await f.stores.intelligence.analyzeMetric(f.context,request(f.initialRefs[0],f.initialRefs.slice(1)));
  await progressOneDay(f);await f.stores.initializeTenant('a','LIVE');
  const live=await f.stores.capture('a',{executionMode:'LIVE'});
  await assert.rejects(f.stores.intelligence.analyzeMetric(live,request(f.initialRefs[0],f.initialRefs.slice(1))),/SHADOW_ONLY/);
  assert.equal((await f.db.raw.execute("SELECT count(*) n FROM evidence_runs WHERE execution_mode='LIVE'")).rows[0].n,0);
  assert.equal((await f.db.raw.execute("SELECT count(*) n FROM observation_episodes WHERE execution_mode='LIVE'")).rows[0].n,0);
});

test('RC2 unseen older observation remains deterministic fail-closed and cannot move the episode backward',async t=>{
  const f=await setup(t);await f.stores.intelligence.analyzeMetric(f.context,request(f.initialRefs[0],f.initialRefs.slice(1)));
  const progressed=await progressOneDay(f),before=await durableCounts(f.db),activeBefore=progressed.episode.episode.row;
  const attempt=()=>analyzeInserted(f,{id:'unseen-old',healthDate:'2026-09-25',observedAt:'2026-09-25T11:00:00.000Z',
    asOfUtc:'2026-09-26T12:00:00.000Z',baselineIds:f.recoveryIds.slice(1)});
  await assert.rejects(attempt(),/EPISODE_TIME_ORDER_INVALID/);
  await f.db.raw.execute("DELETE FROM whoop_recoveries WHERE user_id='a' AND sleep_id='unseen-old'");
  await assert.rejects(attempt(),/EPISODE_TIME_ORDER_INVALID/);
  const active=(await f.db.raw.execute({sql:'SELECT * FROM observation_episodes WHERE episode_id=?',
    args:[activeBefore.episode_id]})).rows[0];
  assert.equal(active.revision,activeBefore.revision);assert.equal(active.last_observed_at,activeBefore.last_observed_at);
  assert.deepEqual(await durableCounts(f.db),before);
});
