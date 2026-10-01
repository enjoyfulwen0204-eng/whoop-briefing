import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, NEXT } from './stage6RecurrenceFixture.js';
import { call } from './stage5ClosureFixture.js';
import { createReceiptRouting } from '../src/phase4ReceiptRouting.js';
import { canonicalJson } from '../src/phase4EntityStore.js';
import { OPERATION_RECEIPT_VERSION } from '../src/phase4V27Schema.js';
import { createPhase4Stage6, authorizeStage6ShadowWorker } from '../src/phase4Reanalysis.js';
import { createFamilyDirectory } from '../src/phase4FamilyDirectory.js';
import { guards } from './stage5ReviewBFixture.js';

async function cloneReceipts(f,source,count) {
  const keys=f.core.keys,routing=createReceiptRouting(f.db.raw,keys),related=JSON.parse(source.related_results_json);
  for(let index=0;index<count;index++) {
    const request=JSON.parse(source.request_json);
    request.request.routingHistoryOrdinal=index;
    const row={...source,request_json:canonicalJson(request),created_at:new Date(Date.parse(source.created_at)+index+1).toISOString()};
    row.operation_key=keys.lookup(['stage5-operation-key-v1',row.request_json]);
    row.privacy_artifact_id=keys.lookup(['privacy-artifact-v1','phase4_operation_receipts',row.user_id,row.execution_mode,
      [row.operation_kind,row.operation_key]]);
    row.receipt_hmac=keys.digest(row.content_digest_salt,canonicalJson([OPERATION_RECEIPT_VERSION,
      Object.fromEntries(Object.entries(row).filter(([name])=>!['receipt_hmac','health_content_redacted_at',
        'health_content_redaction_reason','source_subject_deleted_at'].includes(name)))]));
    await routing.register(row,{request,related});
    const names=Object.keys(row);
    await f.db.raw.execute({sql:`INSERT INTO phase4_operation_receipts(${names.join(',')}) VALUES (${names.map(()=>'?').join(',')})`,
      args:names.map(name=>row[name])});
  }
  // The test's direct signed-receipt insertion bypasses the public capture
  // path, so advance the v30 source fence in this same transaction.
  await createFamilyDirectory(f.db.raw,keys).touchSource({userId:source.user_id,
    executionMode:source.execution_mode},'recovery_score');
}

test('v30 oversized secondary route leaves healthy daily family complete', async t => {
  const {f,old,analysis} = await fixture(t,{targetVersion:30});
  const {refresh,...otherAnalysis} = analysis;
  const secondary = await call(f,'intelligence','analyzeMetric',{
    ...otherAnalysis,windowFamily:'SECONDARY_RECOVERY'
  });
  assert.ok(secondary.episode?.episode?.row);
  const rows=(await f.db.raw.execute({sql:"SELECT * FROM phase4_operation_receipts WHERE operation_kind='EPISODE_OPEN'"})).rows;
  const source=rows.find(row=>row.request_json?.includes('"windowFamily":"SECONDARY_RECOVERY"'));
  assert.ok(source);
  await f.db.transaction(()=>cloneReceipts(f,source,1001));
  const worker=await createPhase4Stage6({db:f.db,keys:f.keys,executionMode:'SHADOW',
    workerCapability:authorizeStage6ShadowWorker({executionMode:'SHADOW'}),now:()=>new Date(NEXT)});
  const result=await worker.drain({budget:{maxItemsPerTenant:32,maxItems:64,maxWallMs:90000,leaseMs:120000}});
  const episodes=(await f.db.raw.execute({sql:'SELECT * FROM observation_episodes WHERE episode_family_key=?',
    args:[old.episode_family_key]})).rows;
  const diagnostics=await worker.diagnostics();
  assert.ok(result.failedJobs>0);
  assert.equal(result.failures[0].code,'SOURCE_UNAVAILABLE');
  assert.equal(episodes.length,2);
  assert.ok(diagnostics.pendingJobs>0);
  const directory=createFamilyDirectory(f.db.raw,f.keys),context=await f.stores.capture('a',{executionMode:'SHADOW'}),
    entries=(await directory.inventory(context,'recovery_score')).entries;
  const daily=entries.find(row=>row.family_key===old.episode_family_key);
  const sibling=entries.find(row=>row.family_key!==old.episode_family_key);
  assert.equal((await directory.work(context,daily)).due,false);
  assert.equal((await directory.work(context,sibling)).due,true);
  Object.assign(f,await f.restart());
  const resumed=await f.stores.capture('a',{executionMode:'SHADOW'});
  assert.equal((await directory.work(resumed,daily)).due,false);
  assert.equal((await directory.work(resumed,sibling)).due,true);
});

test('v30 corrupt sibling cannot roll back DAILY worker completion',async t=>{
  const {f,old,analysis}=await fixture(t,{targetVersion:30}),{refresh,...other}=analysis;
  assert.ok((await call(f,'intelligence','analyzeMetric',{...other,windowFamily:'SECONDARY_RECOVERY'})).episode?.episode?.row);
  const row=(await f.db.raw.execute({sql:`SELECT * FROM phase4_operation_receipts
    WHERE operation_kind='EPISODE_OPEN' ORDER BY created_at` })).rows
    .find(value=>value.request_json?.includes('"windowFamily":"SECONDARY_RECOVERY"'));
  assert.ok(row);
  await guards(f,'phase4_operation_receipts',()=>f.db.raw.execute({sql:`UPDATE phase4_operation_receipts
    SET receipt_hmac=? WHERE operation_key=?`,args:['0'.repeat(64),row.operation_key]}));
  const worker=await createPhase4Stage6({db:f.db,keys:f.keys,executionMode:'SHADOW',
    workerCapability:authorizeStage6ShadowWorker({executionMode:'SHADOW'}),now:()=>new Date(NEXT)});
  const result=await worker.drain({budget:{maxItemsPerTenant:32,maxItems:64,maxWallMs:90000,leaseMs:120000}});
  const episodes=(await f.db.raw.execute({sql:'SELECT * FROM observation_episodes WHERE episode_family_key=?',
    args:[old.episode_family_key]})).rows;
  assert.equal(episodes.length,2);
  assert.equal(episodes.find(value=>value.episode_id!==old.episode_id).reopens_episode_id,old.episode_id);
  assert.equal(result.failures[0].code,'INVARIANT_VIOLATION');
});

test('v30 corrupt required DAILY receipt prevents DAILY worker write',async t=>{
  const {f,old}=await fixture(t,{targetVersion:30});
  const row=(await f.db.raw.execute({sql:`SELECT * FROM phase4_operation_receipts
    WHERE operation_kind='EPISODE_OPEN' ORDER BY created_at LIMIT 1`})).rows[0];
  await guards(f,'phase4_operation_receipts',()=>f.db.raw.execute({sql:`UPDATE phase4_operation_receipts
    SET receipt_hmac=? WHERE operation_key=?`,args:['0'.repeat(64),row.operation_key]}));
  const worker=await createPhase4Stage6({db:f.db,keys:f.keys,executionMode:'SHADOW',
    workerCapability:authorizeStage6ShadowWorker({executionMode:'SHADOW'}),now:()=>new Date(NEXT)});
  const result=await worker.drain({budget:{maxItemsPerTenant:32,maxItems:64,maxWallMs:90000,leaseMs:120000}});
  assert.equal(result.failures[0].code,'INVARIANT_VIOLATION');
  const episodes=(await f.db.raw.execute({sql:'SELECT * FROM observation_episodes WHERE episode_family_key=?',
    args:[old.episode_family_key]})).rows;
  assert.equal(episodes.length,1);
});

test('v30 DAILY target overflow is scoped and fails without a DAILY write',async t=>{
  const {f,old}=await fixture(t,{targetVersion:30});
  const source=(await f.db.raw.execute({sql:`SELECT * FROM phase4_operation_receipts
    WHERE operation_kind='EPISODE_OPEN' ORDER BY created_at LIMIT 1`})).rows[0];
  await f.db.transaction(()=>cloneReceipts(f,source,1001));
  const worker=await createPhase4Stage6({db:f.db,keys:f.keys,executionMode:'SHADOW',
    workerCapability:authorizeStage6ShadowWorker({executionMode:'SHADOW'}),now:()=>new Date(NEXT)});
  const result=await worker.drain({budget:{maxItemsPerTenant:32,maxItems:64,maxWallMs:90000,leaseMs:120000}});
  assert.equal(result.failures[0].code,'SOURCE_UNAVAILABLE');
  const episodes=(await f.db.raw.execute({sql:'SELECT * FROM observation_episodes WHERE episode_family_key=?',
    args:[old.episode_family_key]})).rows;
  assert.equal(episodes.length,1);
  const directory=createFamilyDirectory(f.db.raw,f.keys),context=await f.stores.capture('a',{executionMode:'SHADOW'}),
    entry=(await directory.inventory(context,'recovery_score')).entries.find(row=>row.family_key===old.episode_family_key);
  assert.equal((await directory.work(context,entry)).due,true);
});

test('v30 mixed large sibling families retain independent work tips',async t=>{
  const {f,old,analysis}=await fixture(t,{targetVersion:30}),{refresh,...other}=analysis;
  for(const windowFamily of ['SECONDARY_RECOVERY','TERTIARY_RECOVERY'])
    assert.ok((await call(f,'intelligence','analyzeMetric',{...other,windowFamily})).episode?.episode?.row);
  const rows=(await f.db.raw.execute({sql:"SELECT * FROM phase4_operation_receipts WHERE operation_kind='EPISODE_OPEN'"})).rows;
  await f.db.transaction(async()=>{
    for(const windowFamily of ['SECONDARY_RECOVERY','TERTIARY_RECOVERY']) {
      const source=rows.find(row=>row.request_json?.includes(`"windowFamily":"${windowFamily}"`));
      assert.ok(source);
      await cloneReceipts(f,source,1001);
    }
  });
  const worker=await createPhase4Stage6({db:f.db,keys:f.keys,executionMode:'SHADOW',
    workerCapability:authorizeStage6ShadowWorker({executionMode:'SHADOW'}),now:()=>new Date(NEXT)});
  const result=await worker.drain({budget:{maxItemsPerTenant:32,maxItems:64,maxWallMs:90000,leaseMs:120000}});
  assert.equal(result.failures[0].code,'SOURCE_UNAVAILABLE');
  const directory=createFamilyDirectory(f.db.raw,f.keys),context=await f.stores.capture('a',{executionMode:'SHADOW'}),
    entries=(await directory.inventory(context,'recovery_score')).entries;
  assert.equal(entries.length,3);
  for(const entry of entries)assert.equal((await directory.work(context,entry)).due,entry.family_key!==old.episode_family_key);
});
