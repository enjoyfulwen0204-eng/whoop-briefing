import test from 'node:test';
import assert from 'node:assert/strict';
import { setup,hypothesis,family } from './stage5AssociationFixture.js';
import { call } from './stage5ClosureFixture.js';
import { guards } from './stage5ReviewBFixture.js';
import { createPhase4Stage6,authorizeStage6ShadowWorker } from '../src/phase4Reanalysis.js';
import { createFamilyDirectory } from '../src/phase4FamilyDirectory.js';
import { createReceiptRouting } from '../src/phase4ReceiptRouting.js';
import { canonicalJson } from '../src/phase4EntityStore.js';
import { OPERATION_RECEIPT_VERSION } from '../src/phase4V27Schema.js';
import { canonicalAssociationClaim } from '../src/phase4IntelligenceStore.js';
import { INTELLIGENCE_VERSIONS } from '../src/phase4IntelligenceRegistry.js';

const T='2026-09-25T12:00:00.000Z',ZERO='0'.repeat(64);
const worker=f=>createPhase4Stage6({db:f.db,keys:f.keys,executionMode:'SHADOW',
  workerCapability:authorizeStage6ShadowWorker({executionMode:'SHADOW'}),now:()=>new Date(T)});
const episodeRows=f=>f.db.raw.execute("SELECT * FROM observation_episodes WHERE user_id='a' AND execution_mode='SHADOW'");
const receipts=f=>f.db.raw.execute("SELECT * FROM phase4_operation_receipts WHERE user_id='a' AND execution_mode='SHADOW'");

async function setupInsightAndSibling(t) {
  const f=await setup(t,{days:30,targetVersion:30});
  // A low current score makes the sibling a real, retained episode. The
  // association is still rooted in canonical WHOOP and Journal evidence.
  await f.db.raw.execute("UPDATE whoop_recoveries SET recovery_score=15 WHERE user_id='a' AND sleep_id='sleep-00'");
  const initial=await call(f,'intelligence','analyzeAssociationFamily',
    family('worker-initial',hypothesis(f,Array.from({length:30},(_,i)=>i))));
  const old=initial.items[0].insight.current.row;
  assert.equal(old.input_generation,15);
  const secondary=await call(f,'intelligence','analyzeMetric',{metricKey:'recovery_score',currentSource:f.outcomeRefs[0],
    baselineSources:f.outcomeRefs.slice(1),asOfUtc:T,windowFamily:'SECONDARY_RECOVERY'});
  assert.ok(secondary.episode?.episode?.row);
  await f.stores.queue.sourceChanged(await f.stores.captureControl('a'));
  return {f,old,secondary:secondary.episode.episode.row};
}

async function cloneReceipts(f,source,count) {
  const keys=f.core.keys,routing=createReceiptRouting(f.db.raw,keys),related=JSON.parse(source.related_results_json);
  for(let index=0;index<count;index++) {
    const request=JSON.parse(source.request_json);request.request.routingHistoryOrdinal=index;
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
  await createFamilyDirectory(f.db.raw,keys).touchSource({userId:source.user_id,
    executionMode:source.execution_mode},'recovery_score');
}

for(const fault of ['CORRUPT_SIBLING','OVERSIZED_SIBLING'])test(`v30 insight refresh commits independently of ${fault}`,async t=>{
  const {f,old,secondary}=await setupInsightAndSibling(t);
  const sibling=(await receipts(f)).rows.find(row=>row.operation_kind==='EPISODE_OPEN'
    &&row.request_json?.includes('"windowFamily":"SECONDARY_RECOVERY"'));
  assert.ok(sibling);
  if(fault==='CORRUPT_SIBLING')await guards(f,'phase4_operation_receipts',()=>f.db.raw.execute({sql:
    'UPDATE phase4_operation_receipts SET receipt_hmac=? WHERE operation_key=?',args:[ZERO,sibling.operation_key]}));
  else await f.db.transaction(()=>cloneReceipts(f,sibling,1001));
  const running=await worker(f),result=await running.drain({budget:{maxItemsPerTenant:32,maxItems:64,
    maxWallMs:90000,leaseMs:120000}});
  assert.ok(result.failedJobs>0,JSON.stringify(result));
  assert.equal(result.failures[0].code,fault==='CORRUPT_SIBLING'?'INVARIANT_VIOLATION':'SOURCE_UNAVAILABLE');
  const current=await f.stores.withContext('a',{executionMode:'SHADOW'},context=>
    f.stores.insights.read(context,old.id,{asOfUtc:T}));
  assert.equal(current.row.input_generation,16);
  assert.equal(current.row.current_revision,old.current_revision+1);
  const directory=createFamilyDirectory(f.db.raw,f.keys),context=await f.stores.capture('a',{executionMode:'SHADOW'}),
    entries=(await directory.inventory(context,'recovery_score')).entries,
    siblingEntry=entries.find(entry=>entry.family_key===secondary.episode_family_key);
  assert.equal((await directory.work(context,siblingEntry)).due,true);
  const dailyEntry=entries.find(entry=>entry.family_key!==secondary.episode_family_key);
  assert.ok(dailyEntry);
  assert.equal((await directory.work(context,dailyEntry)).due,false);
  assert.ok((await running.diagnostics()).pendingJobs>0);
  assert.ok((await episodeRows(f)).rows.some(row=>row.window_family==='DAILY_RECOVERY'||row.episode_family_key!==secondary.episode_family_key));
});

test('v30 insight refresh fails closed when its authenticated predecessor receipt is corrupt',async t=>{
  const {f,old}=await setupInsightAndSibling(t);
  const predecessor=(await receipts(f)).rows.find(row=>row.operation_kind==='INSIGHT_CREATE');
  assert.ok(predecessor);
  await guards(f,'phase4_operation_receipts',()=>f.db.raw.execute({sql:
    'UPDATE phase4_operation_receipts SET receipt_hmac=? WHERE operation_key=?',args:[ZERO,predecessor.operation_key]}));
  const running=await worker(f),result=await running.drain({budget:{maxItemsPerTenant:32,maxItems:64,
    maxWallMs:90000,leaseMs:120000}});
  assert.ok(result.failedJobs>0,JSON.stringify(result));
  assert.equal(result.failures[0].code,'INVARIANT_VIOLATION');
  const row=(await f.db.raw.execute({sql:'SELECT input_generation,current_revision FROM health_insights WHERE id=?',
    args:[old.id]})).rows[0];
  assert.equal(row.input_generation,15);
  assert.equal(row.current_revision,old.current_revision);
  assert.ok((await running.diagnostics()).pendingJobs>0);
});

test('v30 insight requiring a SECONDARY metric evidence root cannot refresh when that root fails',async t=>{
  const f=await setup(t,{days:30,targetVersion:30});
  await f.db.raw.execute("UPDATE whoop_recoveries SET recovery_score=15 WHERE user_id='a' AND sleep_id='sleep-00'");
  const observed=await call(f,'intelligence','analyzeAssociationFamily',{
    ...family('required-secondary',hypothesis(f,Array.from({length:30},(_,i)=>i))),lifecycleMode:'EVIDENCE_ONLY'});
  const direction=observed.items[0].analysis.direction;
  assert.ok(direction);
  const secondary=await call(f,'intelligence','analyzeMetric',{metricKey:'recovery_score',currentSource:f.outcomeRefs[0],
    baselineSources:f.outcomeRefs.slice(1),asOfUtc:T,windowFamily:'SECONDARY_RECOVERY'});
  assert.ok(secondary.episode?.episode?.row);
  const old=(await call(f,'insights','create',{identity:{subject:'journal:caffeine',outcome:'recovery_score',
    direction,exposureCategory:'caffeine',algorithmFamily:'journal-association',evidenceContractMajor:'1'},
    claim:canonicalAssociationClaim({factor:'caffeine',outcomeMetric:'recovery_score'},direction,'HYPOTHESIS'),
    evidenceContractVersion:INTELLIGENCE_VERSIONS.evidenceContract,
    supportingEvidenceIds:[secondary.item.row.evidence_item_id],creationKey:'required-secondary-metric-evidence',
    semanticAt:T,expiresAt:new Date(Date.parse(T)+7*86400000).toISOString()})).row;
  assert.equal(old.input_generation,15);
  await f.stores.queue.sourceChanged(await f.stores.captureControl('a'));
  await guards(f,'evidence_items',()=>f.db.raw.execute({sql:`UPDATE evidence_items SET invalidated_at=?
    WHERE evidence_item_id=?`,args:[T,secondary.item.row.evidence_item_id]}));
  const running=await worker(f),result=await running.drain({budget:{maxItemsPerTenant:32,maxItems:64,
    maxWallMs:90000,leaseMs:120000}});
  assert.ok(result.failedJobs>0,JSON.stringify(result));
  assert.notEqual(result.failures[0].code,'CALCULATION_FAILED',JSON.stringify(result));
  const row=(await f.db.raw.execute({sql:'SELECT input_generation,current_revision FROM health_insights WHERE id=?',
    args:[old.id]})).rows[0];
  assert.equal(row.input_generation,15);
  assert.equal(row.current_revision,old.current_revision);
  const context=await f.stores.capture('a',{executionMode:'SHADOW'}),directory=createFamilyDirectory(f.db.raw,f.keys),
    entry=(await directory.inventory(context,'recovery_score')).entries.find(value=>
      value.family_key===secondary.episode.episode.row.episode_family_key);
  assert.equal((await directory.work(context,entry)).due,true);
  assert.ok((await running.diagnostics()).pendingJobs>0);
});
