import test from 'node:test';
import assert from 'node:assert/strict';
import { setup as associationSetup,hypothesis,family } from './stage5AssociationFixture.js';
import { call } from './stage5ClosureFixture.js';
import { guards } from './stage5ReviewBFixture.js';
import { createFamilyDirectory } from '../src/phase4FamilyDirectory.js';
import { createReceiptRouting } from '../src/phase4ReceiptRouting.js';
import { createOperationReceipts } from '../src/phase4OperationReceipts.js';
import { canonicalJson } from '../src/phase4EntityStore.js';
import { OPERATION_RECEIPT_VERSION } from '../src/phase4V27Schema.js';

const T='2026-09-25T12:00:00.000Z';
const dailyKey=f=>f.keys.lookup(['episode-family-v1','a','recovery','recovery_score',
  'phase4-intelligence-v1','recovery_score','DAILY_RECOVERY']);
const precise=(f,context)=>createReceiptRouting(f.db.raw,f.keys).inventory(context,'EPISODE_FAMILY',dailyKey(f));
const insightUnknown=(f,context)=>createReceiptRouting(f.db.raw,f.keys).inventory(context,'INSIGHT','missing-insight');
async function redactReceipt(f,kind) {
  const row=(await f.db.raw.execute({sql:`SELECT operation_key FROM phase4_operation_receipts
    WHERE user_id='a' AND operation_kind=? ORDER BY created_at LIMIT 1`,args:[kind]})).rows[0];
  assert.ok(row,`expected ${kind} receipt`);
  await guards(f,'phase4_operation_receipts',()=>f.db.raw.execute({sql:`UPDATE phase4_operation_receipts SET
    content_state='REDACTED',source_linkage_state='DISCONNECTED',health_content_redacted_at=?,
    health_content_redaction_reason='SOURCE_DELETED',content_digest_salt=NULL,semantic_at=NULL,request_json=NULL,
    result_json=NULL,related_results_json=NULL,required_roots_json=NULL,schema_contract_json=NULL,receipt_hmac=NULL
    WHERE operation_key=?`,args:[T,row.operation_key]}));
  return row.operation_key;
}
async function makeInsight(f) {
  const initial=await call(f,'intelligence','analyzeAssociationFamily',
    family('legacy-initial',hypothesis(f,Array.from({length:30},(_,i)=>i))));
  assert.ok(initial.items[0].insight?.current?.row);
}
async function makeEpisode(f) {
  await f.db.raw.execute("UPDATE whoop_recoveries SET recovery_score=15 WHERE user_id='a' AND sleep_id='sleep-00'");
  const result=await call(f,'intelligence','analyzeMetric',{metricKey:'recovery_score',
    currentSource:f.outcomeRefs[0],baselineSources:f.outcomeRefs.slice(1),asOfUtc:T,windowFamily:'DAILY_RECOVERY'});
  assert.ok(result.episode?.episode?.row);
  return result;
}
async function unclassifiedLegacyReceipt(f) {
  // A signed v27 receipt whose producer kind is unavailable to the v30
  // classifier: after redaction, its old result cannot be inferred from the
  // mutable projection copied here. The migration must retain uncertainty.
  const source=(await f.db.raw.execute("SELECT * FROM phase4_operation_receipts WHERE operation_kind='INSIGHT_CREATE' LIMIT 1")).rows[0];
  assert.ok(source);
  const request=JSON.parse(source.request_json);request.operation_kind='UNCLASSIFIED_LEGACY';
  const row={...source,operation_kind:'UNCLASSIFIED_LEGACY',request_json:canonicalJson(request)};
  row.operation_key=f.keys.lookup(['stage5-operation-key-v1',row.request_json]);
  row.privacy_artifact_id=f.keys.lookup(['privacy-artifact-v1','phase4_operation_receipts',row.user_id,row.execution_mode,
    [row.operation_kind,row.operation_key]]);
  row.receipt_hmac=f.keys.digest(row.content_digest_salt,canonicalJson([OPERATION_RECEIPT_VERSION,
    Object.fromEntries(Object.entries(row).filter(([name])=>!['receipt_hmac','health_content_redacted_at',
      'health_content_redaction_reason','source_subject_deleted_at'].includes(name)))]));
  const names=Object.keys(row);
  await f.db.raw.execute({sql:`INSERT INTO phase4_operation_receipts(${names.join(',')}) VALUES (${names.map(()=>'?').join(',')})`,
    args:names.map(name=>row[name])});
}
async function migrate(f) {
  await f.db.migrate({targetVersion:29});
  const unknown=(await f.db.raw.execute("SELECT operation_kind,route_state FROM phase4_receipt_routes WHERE route_state='LEGACY_ROUTE_UNKNOWN'")).rows;
  assert.ok(unknown.length>0);
  await f.db.migrate({targetVersion:30});
  await f.db.migrate({targetVersion:30});
  const context=await f.stores.capture('a',{executionMode:'SHADOW'});
  return {unknown,directory:createFamilyDirectory(f.db.raw,f.keys),context};
}

test('v30 insight-only legacy unknown preserves insight uncertainty but leaves empty episode directory complete',async t=>{
  const f=await associationSetup(t,{days:30,targetVersion:27});
  await makeInsight(f);await redactReceipt(f,'INSIGHT_CREATE');
  const {unknown,directory,context}=await migrate(f);
  assert.ok(unknown.some(row=>row.operation_kind==='INSIGHT_CREATE'));
  const inventory=await directory.inventory(context,'recovery_score');
  assert.equal(inventory.manifest.directory_state,'COMPLETE');
  assert.equal(inventory.entries.length,0);
  assert.equal(inventory.unknownEntries.length,0);
  assert.equal((await directory.allComplete(context,'recovery_score')),true);
  assert.equal((await precise(f,context)).unknown,0);
  assert.equal((await insightUnknown(f,context)).unknown,1);
  const route=(await f.db.raw.execute("SELECT * FROM phase4_receipt_routes WHERE operation_kind='INSIGHT_CREATE' AND route_state='LEGACY_ROUTE_UNKNOWN'" )).rows[0];
  const receipt=(await f.db.raw.execute({sql:`SELECT * FROM phase4_operation_receipts WHERE operation_kind=?
    AND operation_key=?`,args:[route.operation_kind,route.operation_key]})).rows[0];
  assert.equal(createReceiptRouting(f.db.raw,f.keys).legacyUnknownMayAffect(route,
    {...receipt,mutable_kind:'EPISODE_OPEN',windowFamily:'DAILY_RECOVERY',
      request_json:'{"identity":{"windowFamily":"DAILY_RECOVERY"}}'},'EPISODE_FAMILY'),false);
  Object.assign(f,await f.restart());f.context=null;
  await f.db.raw.execute("UPDATE whoop_recoveries SET recovery_score=15 WHERE user_id='a' AND sleep_id='sleep-00'");
  const opened=await call(f,'intelligence','analyzeMetric',{metricKey:'recovery_score',
    currentSource:f.outcomeRefs[0],baselineSources:f.outcomeRefs.slice(1),asOfUtc:T,
    windowFamily:'DAILY_RECOVERY'});
  assert.equal(opened.episode.episode.row.episode_family_key,dailyKey(f));
  assert.equal((await f.stores.withContext('a',{executionMode:'SHADOW'},c=>
    createFamilyDirectory(f.db.raw,f.keys).inventory(c,'recovery_score'))).entries.length,1);
});

test('v30 episode-related legacy unknown keeps directory completeness unknown',async t=>{
  const f=await associationSetup(t,{days:30,targetVersion:27});
  await makeEpisode(f);await redactReceipt(f,'EPISODE_OPEN');
  const {unknown,directory,context}=await migrate(f);
  assert.ok(unknown.some(row=>row.operation_kind==='EPISODE_OPEN'));
  await assert.rejects(directory.inventory(context,'recovery_score'),/PHASE4_FAMILY_DIRECTORY_LEGACY_UNKNOWN/);
  await assert.rejects(directory.allComplete(context,'recovery_score'),/PHASE4_FAMILY_DIRECTORY_LEGACY_UNKNOWN/);
  assert.equal((await precise(f,context)).unknown,1);
  assert.equal((await insightUnknown(f,context)).unknown,0);
  const route=(await f.db.raw.execute("SELECT * FROM phase4_receipt_routes WHERE operation_kind='EPISODE_OPEN' AND route_state='LEGACY_ROUTE_UNKNOWN'" )).rows[0];
  const receipt=(await f.db.raw.execute({sql:`SELECT * FROM phase4_operation_receipts WHERE operation_kind=?
    AND operation_key=?`,args:[route.operation_kind,route.operation_key]})).rows[0];
  assert.equal(createReceiptRouting(f.db.raw,f.keys).legacyUnknownMayAffect(route,
    {...receipt,mutable_kind:'INSIGHT_CREATE',windowFamily:'SECONDARY_RECOVERY'},'EPISODE_FAMILY'),true);
  Object.assign(f,await f.restart());f.context=null;
  await assert.rejects(f.stores.withContext('a',{executionMode:'SHADOW'},c=>
    createOperationReceipts(f.core).episodeRecurrenceInventory(c,{metricKey:'recovery_score',
      episodeFamilyKey:dailyKey(f)})),/PHASE4_RECEIPT_ROUTE_LEGACY_UNKNOWN/);
});

test('v30 unknown insight receipt does not poison intact authenticated episode family',async t=>{
  const f=await associationSetup(t,{days:30,targetVersion:27});
  await makeInsight(f);const prior=await makeEpisode(f);await redactReceipt(f,'INSIGHT_CREATE');
  const {directory,context}=await migrate(f),inventory=await directory.inventory(context,'recovery_score');
  assert.equal(inventory.manifest.directory_state,'COMPLETE');
  assert.equal(inventory.entries.length,1);
  assert.equal(inventory.unknownEntries.length,0);
  assert.equal(inventory.entries[0].entry_state,'KNOWN');
  assert.equal((await precise(f,context)).unknown,0);
  assert.equal((await insightUnknown(f,context)).unknown,1);
  Object.assign(f,await f.restart());f.context=null;
  const history=await f.stores.withContext('a',{executionMode:'SHADOW'},c=>
    createOperationReceipts(f.core).episodeRecurrenceInventory(c,{metricKey:'recovery_score',
      episodeFamilyKey:dailyKey(f)}));
  assert.equal(history.latest.size,1);
  const next='2026-09-25T12:00:01.000Z';f.setNow(next);
  await f.stores.queue.sourceChanged(await f.stores.captureControl('a'));
  const refreshed=await call(f,'intelligence','analyzeMetric',{metricKey:'recovery_score',
    currentSource:f.outcomeRefs[0],baselineSources:f.outcomeRefs.slice(1),asOfUtc:next,
    windowFamily:'DAILY_RECOVERY',refresh:true});
  assert.ok(refreshed.item?.row);
  const old=prior.episode.episode.row;
  const episode=await call(f,'episodes','refresh',{episodeId:old.episode_id,expectedRevision:old.revision,
    identity:{algorithmMajor:'phase4-intelligence-v1',domain:'recovery',metric:'recovery_score',
      subject:'recovery_score',windowFamily:'DAILY_RECOVERY',direction:old.direction},metricRefresh:true,
    evidenceItemId:refreshed.item.row.evidence_item_id,semanticAt:next});
  assert.equal(episode.row.input_generation,16);
  assert.equal(episode.row.revision,old.revision+1);
});

test('v30 fully unclassified legacy operation retains conservative directory uncertainty',async t=>{
  const f=await associationSetup(t,{days:30,targetVersion:27});
  await makeInsight(f);await unclassifiedLegacyReceipt(f);await redactReceipt(f,'UNCLASSIFIED_LEGACY');
  const {unknown,directory,context}=await migrate(f);
  assert.ok(unknown.some(row=>row.operation_kind==='UNCLASSIFIED_LEGACY'));
  await assert.rejects(directory.inventory(context,'recovery_score'),/PHASE4_FAMILY_DIRECTORY_LEGACY_UNKNOWN/);
  assert.equal((await precise(f,context)).unknown,1);
  assert.equal((await insightUnknown(f,context)).unknown,1);
});

test('v30 insight-looking route without its surviving v27 kind binding cannot narrow uncertainty',async t=>{
  const f=await associationSetup(t,{days:30,targetVersion:27});
  await makeInsight(f);
  const key=await redactReceipt(f,'INSIGHT_CREATE');
  await guards(f,'phase4_operation_receipts',()=>f.db.raw.execute({sql:`UPDATE phase4_operation_receipts
    SET privacy_artifact_id=? WHERE operation_key=?`,args:['0'.repeat(64),key]}));
  const {unknown,directory,context}=await migrate(f);
  assert.ok(unknown.some(row=>row.operation_kind==='INSIGHT_CREATE'));
  await assert.rejects(directory.inventory(context,'recovery_score'),/PHASE4_FAMILY_DIRECTORY_LEGACY_UNKNOWN/);
  assert.equal((await precise(f,context)).unknown,1);
  assert.equal((await insightUnknown(f,context)).unknown,1);
});

test('v29 route kind HMAC corruption cannot narrow a redacted legacy unknown',async t=>{
  const f=await associationSetup(t,{days:30,targetVersion:27});
  await makeInsight(f);await redactReceipt(f,'INSIGHT_CREATE');
  await migrate(f);
  await guards(f,'phase4_receipt_routes',()=>f.db.raw.execute({sql:`UPDATE phase4_receipt_routes
    SET route_hmac=? WHERE operation_kind='INSIGHT_CREATE' AND route_state='LEGACY_ROUTE_UNKNOWN'`,
    args:['0'.repeat(64)]}));
  const context=await f.stores.capture('a',{executionMode:'SHADOW'});
  await assert.rejects(precise(f,context),/PHASE4_RECEIPT_ROUTE_AUTHORITY_INVALID/);
});
