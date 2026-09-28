import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture,NEXT,TERMINAL,journal } from './stage6RecurrenceFixture.js';
import { call } from './stage5ClosureFixture.js';
import { snapshot } from './stage5M007Fixture.js';
import { guards } from './stage5ReviewBFixture.js';
import { stage5PrivacyIndex } from '../src/phase4Stage5Privacy.js';
import { createPhase4Stage6,authorizeStage6ShadowWorker } from '../src/phase4Reanalysis.js';

const semantic=value=>Array.isArray(value)?value.map(semantic):value&&typeof value==='object'
  ?Object.fromEntries(Object.entries(value).filter(([key])=>!['created','replayed'].includes(key)).map(([key,entry])=>[key,semantic(entry)])):value;

test('Stage 6 recurrence: public 15→16 creates one linked successor, preserves terminal history and replays across restart',async t=>{
  const {f,old,analysis,prepared,openRequest,identity}=await fixture(t);
  const {refresh,...ordinary}=analysis;
  await assert.rejects(call(f,'intelligence','analyzeMetric',ordinary),/INCOMPLETE_PROVENANCE/);
  await assert.rejects(f.stores.withContext('a',{executionMode:'SHADOW'},c=>f.stores.episodes.read(c,old.episode_id)),/PARENT_STALE/);
  await assert.rejects(call(f,'episodes','refresh',{episodeId:old.episode_id,expectedRevision:old.revision,identity,
    metricRefresh:true,evidenceItemId:prepared.item.row.evidence_item_id,semanticAt:NEXT}),/TERMINAL_REFRESH/);
  const req=openRequest(),[first,second]=await Promise.all([call(f,'episodes','open',req),call(f,'episodes','open',req)]);
  assert.deepEqual(semantic(first),semantic(second));
  assert.notEqual(first.row.episode_id,old.episode_id);assert.equal(first.row.reopens_episode_id,old.episode_id);
  assert.equal(first.row.input_generation,16);assert.equal(first.terminalRecurrenceAuthority.predecessor.inputGeneration,15);
  const rows=(await f.db.raw.execute('SELECT * FROM observation_episodes')).rows;assert.equal(rows.length,2);
  assert.deepEqual(rows.find(row=>row.episode_id===old.episode_id),old);
  const read=()=>f.stores.withContext('a',{executionMode:'SHADOW'},async c=>{
    const typed=await f.stores.episodes.read(c,first.row.episode_id),generic=await f.stores.readArtifact(c,'observation_episodes',{episode_id:first.row.episode_id});
    assert.deepEqual(typed.row,generic.row);assert.equal(typed.row.reopens_episode_id,old.episode_id);
  });
  await read();const before=await snapshot(f);f.stores=(await f.restart()).stores;f.context=undefined;
  assert.deepEqual(semantic(await call(f,'episodes','open',{...req,semanticAt:'2026-09-28T20:00:01+08:00'})),semantic(first));
  await read();assert.deepEqual(await snapshot(f),before);
});

for(const [label,at,accepted] of [['before','2026-09-27T11:59:59.999Z',false],['exact',TERMINAL,true],
  ['after','2026-09-27T12:00:00.001Z',true],['outside-seven-days','2026-10-04T12:00:00.001Z',false]])
test(`Stage 6 recurrence: ${label} authenticated terminal boundary follows frozen chronology`,async t=>{
  const {f,old,openRequest}=await fixture(t,{asOfUtc:at}),before=await snapshot(f);
  if(accepted)assert.equal((await call(f,'episodes','open',openRequest())).row.reopens_episode_id,old.episode_id);
  else {
    await assert.rejects(call(f,'episodes','open',openRequest()),/CHRONOLOGY_INVALID|INVALID_REOPEN/);
    assert.deepEqual(await snapshot(f),before);
  }
});

test('Stage 6 recurrence: old evidence, wrong family, changed projection and ordinary stale-parent open cannot bypass authority',async t=>{
  const {f,opened,analysis,openRequest}=await fixture(t);
  const wrong=await call(f,'intelligence','analyzeMetric',{...analysis,windowFamily:'ANOTHER_FAMILY'});
  const req=openRequest(),{recurrence,predecessorRevision,...ordinary}=req;
  for(const [request,error] of [[{...req,evidenceItemId:opened.item.row.evidence_item_id},/PARENT_STALE/],
    [openRequest(wrong),/EVIDENCE_IDENTITY/],[{...req,data:{...req.data,severity:req.data.severity+1}},/PROJECTION_INVALID/],
    [ordinary,/PARENT_STALE/],[{...req,predecessorRevision:1},/CAS_LOST/]]) {
    const before=await snapshot(f);await assert.rejects(call(f,'episodes','open',request),error);assert.deepEqual(await snapshot(f),before);
  }
});

test('Stage 6 recurrence: a stale active predecessor must use refresh, never terminal recurrence',async t=>{
  const {f,openRequest}=await fixture(t,{active:true}),before=await snapshot(f);
  await assert.rejects(call(f,'episodes','open',openRequest()),/TERMINAL_PREDECESSOR_REQUIRED/);
  assert.deepEqual(await snapshot(f),before);
});

for(const fault of ['corrupt','redacted','missing-snapshot','missing-parent','deleted-source'])
test(`Stage 6 recurrence: ${fault} historical authority fails closed`,async t=>{
  const {f,old,openRequest}=await fixture(t);
  if(fault==='deleted-source')await f.db.raw.execute({sql:'DELETE FROM whoop_recoveries WHERE user_id=? AND sleep_id=?',args:['a',f.recoveryIds[0]]});
  else if(fault==='missing-parent')await guards(f,'observation_episodes',()=>f.db.raw.execute('DELETE FROM observation_episodes'));
  else await guards(f,'phase4_episode_revisions',()=>f.db.raw.execute({sql:fault==='missing-snapshot'
    ?'DELETE FROM phase4_episode_revisions WHERE episode_id=? AND revision=?'
    :fault==='corrupt'?`UPDATE phase4_episode_revisions SET snapshot_hash='${'0'.repeat(64)}' WHERE episode_id=? AND revision=?`
      :"UPDATE phase4_episode_revisions SET health_content_redacted_at='2026-09-28T12:00:00.000Z' WHERE episode_id=? AND revision=?",
    args:[old.episode_id,old.revision]}));
  const before=await snapshot(f);await assert.rejects(call(f,'episodes','open',openRequest()),/AUTHORITY_INVALID|CONTENT_REDACTED|HISTORY_UNAVAILABLE|SOURCE_NOT_FOUND/);
  assert.deepEqual(await snapshot(f),before);
});

test('Stage 6 recurrence: existing successor cannot gain a conflicting sibling or be hidden by mutable lookup absence',async t=>{
  const {f,openRequest}=await fixture(t),req=openRequest(),first=await call(f,'episodes','open',req);
  let before=await snapshot(f);
  const altered={...req,semanticAt:'2026-09-28T12:00:00.000Z'};
  await assert.rejects(call(f,'episodes','open',altered),/PREDECESSOR_AMBIGUOUS/);assert.deepEqual(await snapshot(f),before);
  await guards(f,'observation_episodes',()=>f.db.raw.execute({sql:'DELETE FROM observation_episodes WHERE episode_id=?',args:[first.row.episode_id]}));
  before=await snapshot(f);
  for(const request of [req,altered]) {
    await assert.rejects(call(f,'episodes','open',request),/HISTORY_UNAVAILABLE/);assert.deepEqual(await snapshot(f),before);
  }
});

test('Stage 6 recurrence: two authenticated same-generation historical successors make cross-generation lineage ambiguous',async t=>{
  // Build retained history through the frozen public same-generation path.
  // No receipt, revision or HMAC is fabricated by this ambiguity fixture.
  const {f,old,prepared,openRequest}=await fixture(t,{mutate:false});
  const {recurrence,predecessorRevision,...ordinary}=openRequest();
  const first=await call(f,'episodes','open',ordinary);
  const later='2026-09-30T12:00:01.000Z';f.setNow(later);
  await f.stores.withContext('a',{executionMode:'SHADOW'},async context=>{
    const evidence=await f.stores.readArtifact(context,'evidence_items',{evidence_item_id:prepared.item.row.evidence_item_id});
    await f.stores.episodes.revise(context,{episodeId:first.row.episode_id,expectedRevision:1,toState:'EXPIRED',
      sourceRefs:[evidence.ref],patch:{},reasonCode:'CONTINUITY_GAP',continuityGapPassed:true,semanticAt:later});
  });
  const second=await call(f,'episodes','open',{...ordinary,semanticAt:later});
  assert.notEqual(first.row.episode_id,second.row.episode_id);
  await f.stores.withContext('a',{executionMode:'SHADOW'},async context=>{
    const evidence=await f.stores.readArtifact(context,'evidence_items',{evidence_item_id:prepared.item.row.evidence_item_id});
    await f.stores.episodes.revise(context,{episodeId:second.row.episode_id,expectedRevision:1,toState:'EXPIRED',
      sourceRefs:[evidence.ref],patch:{},reasonCode:'CONTINUITY_GAP',continuityGapPassed:true,semanticAt:later});
  });
  await journal(f,'ambiguous-generation-16','2026-09-30T11:00:00.000Z');
  const before=await snapshot(f);
  await assert.rejects(call(f,'episodes','open',openRequest()),/PARENT_STALE|PREDECESSOR_AMBIGUOUS/);
  // Use fresh current evidence as well, so the lineage rejection cannot be
  // attributed only to the stale evidence used by the first negative call.
  const context=await f.stores.capture('a',{executionMode:'SHADOW'});
  const current=(await f.stores.root(context,'recovery','recur-low')).ref,baseline=[];
  for(const id of f.recoveryIds.slice(1))baseline.push((await f.stores.root(context,'recovery',id)).ref);
  const fresh=await f.stores.intelligence.analyzeMetric(context,{metricKey:'recovery_score',currentSource:current,baselineSources:baseline,
    windowFamily:ordinary.identity.windowFamily,asOfUtc:NEXT,refresh:true});
  const afterPreparation=await snapshot(f);
  await assert.rejects(call(f,'episodes','open',openRequest(fresh)),/PREDECESSOR_AMBIGUOUS/);
  assert.deepEqual(await snapshot(f),afterPreparation);
  assert.equal(before.observation_episodes.filter(row=>row.reopens_episode_id===old.episode_id).length,2);
});

for(const fence of ['input','source','auth','lifecycle','purge','algorithm'])
test(`Stage 6 recurrence: ${fence} changes before receipt settlement roll back the successor and receipt`,async t=>{
  const {f,openRequest}=await fixture(t),before=await snapshot(f),execute=f.db.raw.execute.bind(f.db.raw);let changed=false;
  f.db.raw.execute=async statement=>{
    const result=await execute(statement),sql=typeof statement==='string'?statement:statement.sql;
    if(!changed&&sql.startsWith('INSERT INTO phase4_episode_revisions')) {
      changed=true;
      await execute({input:"UPDATE phase4_computation_state SET input_generation=input_generation+1 WHERE user_id='a'",
        source:"UPDATE phase4_user_state SET source_generation=source_generation+1 WHERE user_id='a'",
        auth:"UPDATE user_whoop_tokens SET auth_generation=auth_generation+1 WHERE user_id='a'",
        lifecycle:"UPDATE users SET lifecycle_generation=lifecycle_generation+1 WHERE id='a'",
        purge:"UPDATE phase4_user_state SET purge_generation=purge_generation+1 WHERE user_id='a'",
        algorithm:"UPDATE phase4_computation_state SET algorithm_set_version='changed' WHERE user_id='a'"}[fence]);
    }
    return result;
  };
  await assert.rejects(call(f,'episodes','open',openRequest()),/FENCED|STALE/);assert.equal(changed,true);f.db.raw.execute=execute;
  assert.deepEqual(await snapshot(f),before);
});

test('Stage 6 recurrence: a terminal authority change after receipt insertion is checked again before COMMIT',async t=>{
  const {f,old,openRequest}=await fixture(t),before=await snapshot(f),execute=f.db.raw.execute.bind(f.db.raw);let changed=false;
  f.db.raw.execute=async statement=>{
    const result=await execute(statement),sql=typeof statement==='string'?statement:statement.sql;
    if(!changed&&sql.startsWith('INSERT INTO phase4_operation_receipts')) {
      changed=true;
      await guards(f,'observation_episodes',()=>execute({sql:"UPDATE observation_episodes SET resolved_at='2026-09-27T12:00:00.001Z' WHERE episode_id=?",args:[old.episode_id]}));
    }
    return result;
  };
  await assert.rejects(call(f,'episodes','open',openRequest()),/AUTHORITY_INVALID/);assert.equal(changed,true);f.db.raw.execute=execute;
  assert.deepEqual(await snapshot(f),before);
});

test('Stage 6 recurrence: privacy closure includes the historical parent receipt, and redaction prevents replay',async t=>{
  const {f,openRequest}=await fixture(t),req=openRequest(),opened=await call(f,'episodes','open',req);
  const binding=opened.terminalRecurrenceAuthority.predecessor;
  const receipts=(await f.db.raw.execute("SELECT * FROM phase4_operation_receipts WHERE operation_kind='EPISODE_OPEN'")).rows;
  const current=receipts.find(row=>JSON.parse(row.result_json).row?.episode_id===opened.row.episode_id);
  const parent=(await f.db.raw.execute({sql:'SELECT * FROM phase4_operation_receipts WHERE operation_kind=? AND operation_key=?',args:[binding.operationKind,binding.receiptKey]})).rows[0];
  const edges=await stage5PrivacyIndex(f.core,'a');
  assert.ok(edges.some(edge=>edge.artifact_id===current.privacy_artifact_id&&edge.source_id===parent.privacy_artifact_id));
  await guards(f,'phase4_operation_receipts',()=>f.db.raw.execute({sql:"UPDATE phase4_operation_receipts SET health_content_redacted_at=? WHERE operation_key=?",args:[NEXT,binding.receiptKey]}));
  const before=await snapshot(f);
  await assert.rejects(call(f,'episodes','open',req),/CONTENT_REDACTED/);assert.deepEqual(await snapshot(f),before);
});

test('Stage 6 worker completes recurrence for a resolved custom family through the public authority path',async t=>{
  const {f,old}=await fixture(t,{windowFamily:'CUSTOM_RETAINED_FAMILY'});
  const worker=await createPhase4Stage6({db:f.db,keys:f.keys,executionMode:'SHADOW',
    workerCapability:authorizeStage6ShadowWorker({executionMode:'SHADOW'}),now:()=>new Date(NEXT)});
  for(let i=0;i<8;i++) {
    const result=await worker.drain({budget:{maxItemsPerTenant:32,maxItems:64,maxWallMs:90000,leaseMs:120000}});
    assert.equal(result.failedJobs,0,JSON.stringify(result));
    if((await worker.diagnostics()).pendingJobs===0)break;
  }
  assert.equal((await worker.diagnostics()).pendingJobs,0);
  const rows=(await f.db.raw.execute({sql:'SELECT * FROM observation_episodes WHERE episode_family_key=?',args:[old.episode_family_key]})).rows;
  assert.equal(rows.length,2);const successor=rows.find(row=>row.episode_id!==old.episode_id);
  assert.equal(successor.input_generation,16);assert.equal(successor.reopens_episode_id,old.episode_id);
  assert.deepEqual(rows.find(row=>row.episode_id===old.episode_id),old);
  assert.equal((await f.db.raw.execute("SELECT last_completed_generation FROM phase4_computation_state WHERE user_id='a' AND execution_mode='SHADOW'")).rows[0].last_completed_generation,16);
});
