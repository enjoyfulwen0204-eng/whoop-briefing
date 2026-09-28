import test from 'node:test';
import assert from 'node:assert/strict';
import { setup,request } from './stage5HistoryFixture.js';
import { call } from './stage5ClosureFixture.js';
import { snapshot } from './stage5M007Fixture.js';
import { guards } from './stage5ReviewBFixture.js';

const T='2026-09-25T12:00:00.000Z',NEXT='2026-09-25T12:00:01.000Z';
const semantic=value=>Array.isArray(value)?value.map(semantic):value&&typeof value==='object'
  ?Object.fromEntries(Object.entries(value).filter(([key])=>!['created','replayed'].includes(key)).map(([key,entry])=>[key,semantic(entry)])):value;
const identity={algorithmMajor:'phase4-intelligence-v1',domain:'recovery',metric:'recovery_score',
  subject:'recovery_score',windowFamily:'DAILY_RECOVERY',direction:'LOWER'};
async function mutation(f,key) {
  const eventAt='2026-09-25T11:00:00.000Z',sourceText=`caffeine at ${eventAt}`;
  const result=await f.stores.journal.create(await f.stores.captureControl('a'),{sourceEventKey:key,sourceText,
    candidate:{category:'caffeine',eventAt,valueKind:'PRESENCE',exposureState:'EXPOSED',extractionConfidence:1,
      excerptStart:0,excerptEnd:[...sourceText].length}});
  assert.equal(result.status,'ACCEPT');return result;
}
async function fixture(t,{terminal=false}={}) {
  const f=await setup(t,{targetVersion:28});
  for(let i=0;i<15;i++)await mutation(f,`metric-initial-${i}`);
  const initial=await call(f,'intelligence','analyzeMetric',request(f.initialRefs[0],f.initialRefs.slice(1),T));
  let old=initial.episode.episode.row;assert.equal(old.input_generation,15);
  let next=NEXT;
  if(terminal) {
    f.setNow('2026-10-03T12:00:00.000Z');
    old=(await call(f,'intelligence','expireEpisode',{episodeId:old.episode_id,asOfUtc:'2026-10-03T12:00:00.000Z'})).row;
    next='2026-10-03T12:00:01.000Z';
  }
  f.setNow(next);await mutation(f,'metric-generation-16');
  const analysis={...request(f.initialRefs[0],f.initialRefs.slice(1),next),refresh:true};
  const refresh=evidence=>({episodeId:old.episode_id,expectedRevision:old.revision,identity,
    metricRefresh:true,evidenceItemId:evidence.item.row.evidence_item_id,semanticAt:next});
  return {f,initial,old,analysis,refresh};
}

test('Stage 6 metric: public 15→16 preparation and refresh preserve stale fences, converge and survive restart between steps',async t=>{
  const {f,old,analysis,refresh}=await fixture(t);
  await assert.rejects(call(f,'intelligence','analyzeMetric',request(f.initialRefs[0],f.initialRefs.slice(1),NEXT)),/REANALYSIS_REQUIRED/);
  await assert.rejects(f.stores.withContext('a',{executionMode:'SHADOW'},c=>f.stores.episodes.read(c,old.episode_id)),/PARENT_STALE/);
  const prepared=await call(f,'intelligence','analyzeMetric',analysis);
  assert.equal(prepared.resultState,'REFRESH_PREPARED');assert.equal(prepared.episode,null);
  assert.equal(prepared.run.row.input_generation,16);assert.equal(prepared.calculation.qualified,true);
  f.stores=(await f.restart()).stores;f.context=undefined;
  assert.deepEqual(semantic(await call(f,'intelligence','analyzeMetric',analysis)),semantic(prepared));
  const req=refresh(prepared);
  const [first,second]=await Promise.all([call(f,'episodes','refresh',req),call(f,'episodes','refresh',req)]);
  assert.deepEqual(first,second);assert.equal(first.row.input_generation,16);assert.equal(first.row.revision,old.revision+1);
  assert.equal(first.metricRefreshAuthority.predecessor.inputGeneration,15);
  assert.equal((await f.stores.withContext('a',{executionMode:'SHADOW'},c=>f.stores.episodes.read(c,old.episode_id))).row.input_generation,16);
  const before=await snapshot(f);f.stores=(await f.restart()).stores;f.context=undefined;
  assert.deepEqual(await call(f,'episodes','refresh',req),first);
  assert.deepEqual(semantic(await call(f,'intelligence','analyzeMetric',analysis)),semantic(prepared));
  assert.deepEqual(await snapshot(f),before);
  assert.equal((await f.db.raw.execute('SELECT count(*) n FROM phase4_episode_revisions')).rows[0].n,2);
});

test('Stage 6 metric: old evidence and wrong fresh family cannot create a lifecycle revision',async t=>{
  const {f,initial,analysis,refresh}=await fixture(t);
  const wrong=await call(f,'intelligence','analyzeMetric',{...analysis,metricKey:'hrv'});
  for(const [evidence,code] of [[initial,/PARENT_STALE/],[wrong,/EVIDENCE_IDENTITY/]]) {
    const before=await snapshot(f);await assert.rejects(call(f,'episodes','refresh',refresh(evidence)),code);
    assert.deepEqual(await snapshot(f),before);
  }
});

for(const fault of ['corrupt','redacted','missing'])test(`Stage 6 metric: ${fault} historical snapshot fails closed`,async t=>{
  const {f,analysis,refresh}=await fixture(t),prepared=await call(f,'intelligence','analyzeMetric',analysis);
  await guards(f,'phase4_episode_revisions',()=>f.db.raw.execute(fault==='missing'?'DELETE FROM phase4_episode_revisions'
    :fault==='corrupt'?`UPDATE phase4_episode_revisions SET snapshot_hash='${'0'.repeat(64)}'`
      :"UPDATE phase4_episode_revisions SET health_content_redacted_at='2026-09-25T12:00:00.000Z'"));
  const before=await snapshot(f);
  await assert.rejects(call(f,'episodes','refresh',refresh(prepared)),/AUTHORITY_INVALID|CONTENT_REDACTED|HISTORY_UNAVAILABLE/);
  assert.deepEqual(await snapshot(f),before);
});

test('Stage 6 metric: authenticated expired episode is never resurrected',async t=>{
  const {f,analysis,refresh}=await fixture(t,{terminal:true}),prepared=await call(f,'intelligence','analyzeMetric',analysis);
  const before=await snapshot(f);
  await assert.rejects(call(f,'episodes','refresh',refresh(prepared)),/TERMINAL_REFRESH/);
  assert.deepEqual(await snapshot(f),before);
});

for(const fence of ['input','auth','lifecycle','purge','algorithm'])test(`Stage 6 metric: ${fence} race rolls back refresh while preserving complete preparation`,async t=>{
  const {f,analysis,refresh}=await fixture(t),prepared=await call(f,'intelligence','analyzeMetric',analysis);
  const before=await snapshot(f),execute=f.db.raw.execute.bind(f.db.raw);let changed=false;
  f.db.raw.execute=async statement=>{
    const result=await execute(statement),sql=typeof statement==='string'?statement:statement.sql;
    if(!changed&&sql.startsWith('INSERT INTO phase4_episode_revisions')) {
      changed=true;
      await execute({input:"UPDATE phase4_computation_state SET input_generation=input_generation+1 WHERE user_id='a'",
        auth:"UPDATE user_whoop_tokens SET auth_generation=auth_generation+1 WHERE user_id='a'",
        lifecycle:"UPDATE users SET lifecycle_generation=lifecycle_generation+1 WHERE id='a'",
        purge:"UPDATE phase4_user_state SET purge_generation=purge_generation+1 WHERE user_id='a'",
        algorithm:"UPDATE phase4_computation_state SET algorithm_set_version='changed' WHERE user_id='a'"}[fence]);
    }
    return result;
  };
  await assert.rejects(call(f,'episodes','refresh',refresh(prepared)),/FENCED|STALE/);
  f.db.raw.execute=execute;assert.equal(changed,true);assert.deepEqual(await snapshot(f),before);
  assert.deepEqual(semantic(await call(f,'intelligence','analyzeMetric',analysis)),semantic(prepared));
});

test('Stage 6 metric: preparation without a predecessor is a complete independent result; ordinary new-episode analysis remains available',async t=>{
  const f=await setup(t),base=request(f.initialRefs[0],f.initialRefs.slice(1),T);
  const prepared=await call(f,'intelligence','analyzeMetric',{...base,refresh:true});
  assert.equal(prepared.episode,null);assert.equal(prepared.calculation.qualified,true);
  const normal=await call(f,'intelligence','analyzeMetric',base);
  assert.equal(normal.resultState,'POSITIVE');assert.equal(normal.episode.episode.row.state,'OPEN');
  assert.notEqual(normal.run.row.run_id,prepared.run.row.run_id);
});

test('Stage 6 metric: a complete insufficient-quality result cannot make a historical episode current',async t=>{
  const {f,old,analysis,refresh}=await fixture(t);
  const prepared=await call(f,'intelligence','analyzeMetric',{...analysis,baselineSources:[]});
  assert.equal(prepared.episode,null);assert.equal(prepared.calculation.qualified,false);
  const before=await snapshot(f);await assert.rejects(call(f,'episodes','refresh',refresh(prepared)),/METRIC_REFRESH_NO_EPISODE/);
  assert.deepEqual(await snapshot(f),before);
  await assert.rejects(f.stores.withContext('a',{executionMode:'SHADOW'},context=>f.stores.episodes.read(context,old.episode_id)),/PARENT_STALE/);
});
