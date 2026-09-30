import test from 'node:test';
import assert from 'node:assert/strict';
import { setup,hypothesis,family } from './stage5AssociationFixture.js';
import { fixture as recurrenceFixture } from './stage6RecurrenceFixture.js';
import { call } from './stage5ClosureFixture.js';
import { guards,durable } from './stage5ReviewBFixture.js';
import { createOperationReceipts } from '../src/phase4OperationReceipts.js';
import { createTargetAuthorityClosure } from '../src/phase4AuthorityClosure.js';
import { createPhase4Stage6,authorizeStage6ShadowWorker } from '../src/phase4Reanalysis.js';
const T='2026-09-25T12:00:00.000Z';
const worker=f=>createPhase4Stage6({db:f.db,keys:f.keys,executionMode:'SHADOW',
  workerCapability:authorizeStage6ShadowWorker({executionMode:'SHADOW'}),now:()=>new Date(T)});

test('R6-01 multiple erased Journal families with lost naming links allow both retained WHOOP passes without rehydration',async t=>{
  const f=await setup(t,{days:30,targetVersion:28}),h=hypothesis(f,Array.from({length:30},(_,i)=>i));
  for(const metric of ['recovery_score','rhr'])await call(f,'intelligence','analyzeAssociationFamily',family(`deleted-${metric}`,{...h,outcomeMetric:metric}));
  await f.db.raw.execute("DELETE FROM phase4_source_links WHERE user_id='a'");
  const control=await f.stores.capturePrivacyControl('a');
  const purge=await f.stores.privacy.admit(control,{targetType:'JOURNAL_FACT',targetId:f.logicalFacts[0],idempotencyKey:'multiple-erased-families'});
  await f.stores.privacy.redact(control,purge.purge_id);assert.equal((await f.stores.privacy.complete(control,purge.purge_id)).state,'COMPLETE');
  const audits=(await f.db.raw.execute("SELECT * FROM phase4_operation_receipts WHERE content_state='REDACTED'")).rows;
  assert.ok(audits.filter(row=>row.operation_kind==='analyzeAssociationFamily').length>=2);
  await f.db.raw.execute("DELETE FROM phase4_source_links WHERE user_id='a'");
  const w=await worker(f);
  for(let i=0;i<10&&(await w.diagnostics()).pendingJobs;i++)assert.equal((await w.drain({budget:{maxItems:64,maxItemsPerTenant:32,maxWallMs:90000,leaseMs:120000}})).failedJobs,0);
  assert.equal((await w.diagnostics()).pendingJobs,0);
  assert.deepEqual((await f.db.raw.execute("SELECT * FROM phase4_operation_receipts WHERE content_state='REDACTED'")).rows,audits);
  assert.ok((await f.db.raw.execute("SELECT state FROM phase4_jobs WHERE user_id='a'")).rows.every(row=>row.state==='COMPLETED'));
});

test('R6-01 explicit same-family erased predecessor remains required',async t=>{
  const {f,openRequest}=await recurrenceFixture(t),request=openRequest();
  const parent=(await f.db.raw.execute({sql:'SELECT * FROM observation_episodes WHERE episode_id=?',args:[request.reopensEpisodeId]})).rows[0];
  const snapshots=(await f.db.raw.execute({sql:'SELECT * FROM phase4_episode_revisions WHERE episode_id=?',args:[parent.episode_id]})).rows;
  const signed=(await f.db.raw.execute('SELECT * FROM phase4_operation_receipts')).rows.find(row=>row.related_results_json?.includes(snapshots[0].snapshot_hash));
  await guards(f,'phase4_operation_receipts',()=>f.db.raw.execute({sql:`UPDATE phase4_operation_receipts SET content_state='REDACTED',
    source_linkage_state='DISCONNECTED',health_content_redacted_at=?,health_content_redaction_reason='SOURCE_DELETED',content_digest_salt=NULL,
    semantic_at=NULL,request_json=NULL,result_json=NULL,related_results_json=NULL,required_roots_json=NULL,schema_contract_json=NULL,receipt_hmac=NULL
    WHERE operation_key=?`,args:[T,signed.operation_key]}));
  const before=await durable(f);await assert.rejects(call(f,'episodes','open',request),/CONTENT_REDACTED|RESULT_UNAVAILABLE|HISTORY_UNAVAILABLE/);
  assert.deepEqual(await durable(f),before);
});

test('R6-01 signed family discovery survives lost materialized names; foreign tenant and mode never enter inventory',async t=>{
  const {f,old,openRequest}=await recurrenceFixture(t);
  await f.db.raw.execute("DELETE FROM phase4_source_links WHERE user_id='a'");
  const api=createOperationReceipts(f.core),closure=createTargetAuthorityClosure(f.core,api.authenticate);
  await f.stores.withContext('a',{executionMode:'SHADOW'},async c=>{
    const tables=await closure.inventory(c,{kind:'EPISODE',metricKey:'recovery_score'});
    assert.ok(tables.observation_episodes.some(row=>row.episode_id===old.episode_id));
    for(const rows of Object.values(tables))assert.ok(rows.every(row=>row.user_id==='a'&&row.execution_mode==='SHADOW'));
    const foreign=await closure.inventory({...c,userId:'b'},{kind:'EPISODE',metricKey:'recovery_score'});
    const live=await closure.inventory({...c,executionMode:'LIVE'},{kind:'EPISODE',metricKey:'recovery_score'});
    assert.ok(Object.values(foreign).every(rows=>rows.length===0));assert.ok(Object.values(live).every(rows=>rows.length===0));
  });
  await guards(f,'observation_episodes',()=>f.db.raw.execute({sql:"UPDATE observation_episodes SET subject_key='lost-name',episode_family_key=? WHERE episode_id=?",args:['0'.repeat(64),old.episode_id]}));
  const before=await durable(f);
  await f.stores.withContext('a',{executionMode:'SHADOW'},async c=>assert.rejects(
    api.episodeRecurrenceInventory(c,{metricKey:'recovery_score'}),/AUTHORITY_INVALID/));
  await assert.rejects(call(f,'episodes','open',openRequest()),/AUTHORITY_INVALID|INCOMPLETE_PROVENANCE/);
  assert.deepEqual(await durable(f),before);
});
