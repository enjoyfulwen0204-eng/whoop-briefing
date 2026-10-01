import test from 'node:test';
import assert from 'node:assert/strict';
import { setup,request,recoveryRefs } from './stage5HistoryFixture.js';
import { call } from './stage5ClosureFixture.js';
import { guards,durable } from './stage5ReviewBFixture.js';
import { fixture as recurrenceFixture,journal,NEXT,TERMINAL } from './stage6RecurrenceFixture.js';
import { canonicalEpisodeData } from '../src/phase4IntelligenceStore.js';
import { createOperationReceipts } from '../src/phase4OperationReceipts.js';
import { createReceiptRouting } from '../src/phase4ReceiptRouting.js';
import { canonicalJson } from '../src/phase4EntityStore.js';
import { OPERATION_RECEIPT_VERSION } from '../src/phase4V27Schema.js';
import { createPhase4Stage6,authorizeStage6ShadowWorker } from '../src/phase4Reanalysis.js';

const ZERO='0'.repeat(64),DAILY='DAILY_RECOVERY',SECONDARY='SECONDARY_RECOVERY';
const familyKey=(f,windowFamily)=>f.keys.lookup(['episode-family-v1','a','recovery','recovery_score',
  'phase4-intelligence-v1','recovery_score',windowFamily]);
const episodeInventory=(f,windowFamily)=>f.stores.withContext('a',{executionMode:'SHADOW'},context=>
  createOperationReceipts(f.core).episodeRecurrenceInventory(context,{metricKey:'recovery_score',
    episodeFamilyKey:familyKey(f,windowFamily)}));
async function receipt(f,windowFamily,kind='analyzeMetric') {
  const rows=(await f.db.raw.execute({sql:'SELECT * FROM phase4_operation_receipts WHERE operation_kind=?',args:[kind]})).rows;
  const found=rows.filter(row=>row.request_json?.includes(`"windowFamily":"${windowFamily}"`));
  assert.ok(found.length);return found.at(-1);
}
const corrupt=async(f,row)=>guards(f,'phase4_operation_receipts',()=>f.db.raw.execute({sql:
  'UPDATE phase4_operation_receipts SET receipt_hmac=? WHERE operation_key=?',args:[ZERO,row.operation_key]}));

async function normalFixture(t) {
  const f=await setup(t,{targetVersion:29}),at='2026-09-25T12:00:00.000Z',base=request(f.initialRefs[0],f.initialRefs.slice(1),at);
  const prepared=await call(f,'intelligence','analyzeMetric',{...base,windowFamily:DAILY,refresh:true});
  const other=await call(f,'intelligence','analyzeMetric',{...base,windowFamily:SECONDARY});
  assert.ok(other.episode?.episode?.row);
  const manifest=JSON.parse(prepared.run.row.input_manifest_json),calculation=prepared.calculation;
  const open={identity:{algorithmMajor:'phase4-intelligence-v1',domain:'recovery',metric:'recovery_score',
    subject:'recovery_score',windowFamily:DAILY,direction:calculation.direction},
    data:canonicalEpisodeData({timezone:'Asia/Taipei'},{current:manifest.current,calculation,asOfUtc:at,
      confidence:JSON.parse(prepared.item.row.provenance_json).confidence}),
    evidenceItemId:prepared.item.row.evidence_item_id,semanticAt:at,
    semanticEvent:{eventKind:'OPENED',severityOrdinal:calculation.severity,claimKey:'metric:recovery_score',
      semanticContentHash:calculation.semanticHash}};
  return {f,open,other,prepared};
}

test('R6-06 normal DAILY open ignores corrupt SECONDARY receipt',async t=>{
  const {f,open}=await normalFixture(t);
  await corrupt(f,await receipt(f,SECONDARY,'EPISODE_OPEN'));
  assert.equal((await episodeInventory(f,DAILY)).latest.size,0);
  const opened=await call(f,'episodes','open',open);
  assert.equal(opened.row.episode_family_key,familyKey(f,DAILY));
});

async function cloneReceipts(f,source,count,start=0) {
  const keys=f.core.keys,routing=createReceiptRouting(f.db.raw,keys),related=JSON.parse(source.related_results_json);
  for(let index=0;index<count;index++) {
    const request=JSON.parse(source.request_json);request.request.routingHistoryOrdinal=start+index;
    const row={...source,request_json:canonicalJson(request),created_at:new Date(Date.parse(source.created_at)+index+1).toISOString()};
    row.operation_key=keys.lookup(['stage5-operation-key-v1',row.request_json]);
    row.privacy_artifact_id=keys.lookup(['privacy-artifact-v1','phase4_operation_receipts',row.user_id,row.execution_mode,
      [row.operation_kind,row.operation_key]]);
    row.receipt_hmac=keys.digest(row.content_digest_salt,canonicalJson([OPERATION_RECEIPT_VERSION,
      Object.fromEntries(Object.entries(row).filter(([name])=>!['receipt_hmac','health_content_redacted_at',
        'health_content_redaction_reason','source_subject_deleted_at'].includes(name)))]));
    await routing.register(row,{request,related});
    const names=Object.keys(row);
    await f.db.raw.execute({sql:`INSERT INTO phase4_operation_receipts(${names.join(',')})
      VALUES (${names.map(()=>'?').join(',')})`,args:names.map(name=>row[name])});
  }
}

test('R6-06 1001 SECONDARY receipts cannot overflow a small DAILY open',async t=>{
  const {f,open}=await normalFixture(t),source=await receipt(f,SECONDARY,'EPISODE_OPEN');
  await f.db.transaction(()=>cloneReceipts(f,source,1001));
  const opened=await call(f,'episodes','open',open);
  assert.equal(opened.row.episode_family_key,familyKey(f,DAILY));
});

test('R6-06 required DAILY receipt still blocks normal open without a derived write',async t=>{
  const {f,open}=await normalFixture(t);
  await corrupt(f,await receipt(f,DAILY));
  const before=await durable(f);
  await assert.rejects(call(f,'episodes','open',open),/PHASE4_OPERATION_RECEIPT_INTEGRITY/);
  assert.deepEqual(await durable(f),before);
});

test('R6-06 normal absence authenticates every routed DAILY receipt, including non-input history',async t=>{
  const {f,open}=await normalFixture(t),source=await receipt(f,DAILY);
  await f.db.transaction(()=>cloneReceipts(f,source,1,5000));
  const required=(await f.db.raw.execute({sql:"SELECT * FROM phase4_operation_receipts WHERE operation_kind='analyzeMetric'"})).rows
    .find(row=>row.request_json?.includes('routingHistoryOrdinal'));
  assert.ok(required);
  await corrupt(f,required);
  const before=await durable(f);
  await assert.rejects(call(f,'episodes','open',open),/PHASE4_OPERATION_RECEIPT_INTEGRITY/);
  assert.deepEqual(await durable(f),before);
});

test('R6-06 mutable receipt window names cannot add or hide a routed family member',async t=>{
  const {f,open}=await normalFixture(t),other=await receipt(f,SECONDARY,'EPISODE_OPEN');
  const forgedOther=JSON.parse(other.request_json);
  forgedOther.request.identity.windowFamily=DAILY;
  await guards(f,'phase4_operation_receipts',()=>f.db.raw.execute({sql:
    'UPDATE phase4_operation_receipts SET request_json=? WHERE operation_key=?',
    args:[canonicalJson(forgedOther),other.operation_key]}));
  const routed=windowFamily=>f.stores.withContext('a',{executionMode:'SHADOW'},context=>
    createReceiptRouting(f.db.raw,f.core.keys).inventory(context,'EPISODE_FAMILY',familyKey(f,windowFamily)));
  assert.ok(!(await routed(DAILY)).receipts.some(row=>row.operation_key===other.operation_key));
  const opened=await call(f,'episodes','open',open);
  assert.equal(opened.row.episode_family_key,familyKey(f,DAILY));
  const target=(await f.db.raw.execute({sql:"SELECT * FROM phase4_operation_receipts WHERE operation_kind='EPISODE_OPEN'"})).rows
    .find(row=>row.related_results_json?.includes(opened.row.episode_id));
  assert.ok(target);
  const forgedTarget=JSON.parse(target.request_json);
  forgedTarget.request.identity.windowFamily=SECONDARY;
  await guards(f,'phase4_operation_receipts',()=>f.db.raw.execute({sql:
    'UPDATE phase4_operation_receipts SET request_json=? WHERE operation_key=?',
    args:[canonicalJson(forgedTarget),target.operation_key]}));
  assert.ok((await routed(DAILY)).receipts.some(row=>row.operation_key===target.operation_key));
  await assert.rejects(episodeInventory(f,DAILY),/PHASE4_OPERATION_RECEIPT_INTEGRITY/);
});

test('R6-06 missing materialized window name cannot erase authenticated family membership',async t=>{
  const {f,open,prepared}=await normalFixture(t),target=await receipt(f,DAILY),
    routing=createReceiptRouting(f.db.raw,f.core.keys);
  const run=(await f.db.raw.execute({sql:'SELECT * FROM evidence_runs WHERE run_id=?',args:[prepared.run.row.run_id]})).rows[0];
  const manifest=JSON.parse(run.input_manifest_json);delete manifest.window_family;
  await guards(f,'evidence_runs',()=>f.db.raw.execute({sql:'UPDATE evidence_runs SET input_manifest_json=? WHERE run_id=?',
    args:[canonicalJson(manifest),run.run_id]}));
  const routed=await f.stores.withContext('a',{executionMode:'SHADOW'},context=>routing.inventory(context,
    'EPISODE_FAMILY',familyKey(f,DAILY)));
  assert.ok(routed.receipts.some(row=>row.operation_key===target.operation_key));
  const before=await durable(f);
  await assert.rejects(call(f,'episodes','open',open));
  assert.deepEqual(await durable(f),before);
});

test('R6-06 pre-v29 redacted SECONDARY receipt remains unknown for DAILY absence proof',async t=>{
  const f=await setup(t,{targetVersion:28}),base=request(f.initialRefs[0],f.initialRefs.slice(1));
  await call(f,'intelligence','analyzeMetric',{...base,windowFamily:SECONDARY});
  const source=await receipt(f,SECONDARY);
  await guards(f,'phase4_operation_receipts',()=>f.db.raw.execute({sql:`UPDATE phase4_operation_receipts SET
    content_state='REDACTED',source_linkage_state='DISCONNECTED',health_content_redacted_at='2026-09-25T12:00:00.000Z',
    health_content_redaction_reason='SOURCE_DELETED',content_digest_salt=NULL,semantic_at=NULL,request_json=NULL,
    result_json=NULL,related_results_json=NULL,required_roots_json=NULL,schema_contract_json=NULL,receipt_hmac=NULL
    WHERE operation_key=?`,args:[source.operation_key]}));
  await f.db.migrate({targetVersion:29});Object.assign(f,await f.restart());
  await assert.rejects(episodeInventory(f,DAILY),/PHASE4_RECEIPT_ROUTE_LEGACY_UNKNOWN/);
});

test('R6-06 target and mixed window histories receive independent precise bounds',async t=>{
  const {f}=await normalFixture(t),base=request(f.initialRefs[0],f.initialRefs.slice(1));
  await call(f,'intelligence','analyzeMetric',{...base,windowFamily:'TERTIARY_RECOVERY',refresh:true});
  const daily=await receipt(f,DAILY),secondary=await receipt(f,SECONDARY,'EPISODE_OPEN'),third=await receipt(f,'TERTIARY_RECOVERY');
  await f.db.transaction(async()=>{
    await cloneReceipts(f,secondary,1001);
    await cloneReceipts(f,third,1001);
    await cloneReceipts(f,daily,99);
  });
  assert.equal((await episodeInventory(f,DAILY)).latest.size,0);
  await assert.rejects(episodeInventory(f,SECONDARY),/PHASE4_OPERATION_RESULT_BOUNDS_UNAVAILABLE/);
  await assert.rejects(episodeInventory(f,'TERTIARY_RECOVERY'),/PHASE4_OPERATION_RESULT_BOUNDS_UNAVAILABLE/);
  await f.db.transaction(()=>cloneReceipts(f,daily,901,99));
  await f.stores.withContext('a',{executionMode:'SHADOW'},context=>assert.rejects(
    createReceiptRouting(f.db.raw,f.core.keys).inventory(context,'EPISODE_FAMILY',familyKey(f,DAILY)),
    /PHASE4_OPERATION_RESULT_BOUNDS_UNAVAILABLE/));
  await assert.rejects(episodeInventory(f,DAILY),/PHASE4_OPERATION_RESULT_BOUNDS_UNAVAILABLE/);
});

test('R6-06 active DAILY refresh ignores corrupt SECONDARY receipt',async t=>{
  const f=await setup(t,{targetVersion:29});
  for(let i=0;i<15;i++)await journal(f,`window-family-initial-${i}`,'2026-09-25T11:00:00.000Z');
  const base=request(f.initialRefs[0],f.initialRefs.slice(1));
  const daily=(await call(f,'intelligence','analyzeMetric',{...base,windowFamily:DAILY})).episode.episode.row;
  const secondary=(await call(f,'intelligence','analyzeMetric',{...base,windowFamily:SECONDARY})).episode.episode.row;
  f.setNow(NEXT);
  const observedAt=new Date(Date.parse(NEXT)-7200000).toISOString();
  await f.db.raw.execute({sql:`INSERT INTO whoop_recoveries(user_id,sleep_id,health_date,score_state,recovery_score,
    hrv_rmssd_milli,resting_heart_rate,user_calibrating,updated_at,synced_at)
    VALUES ('a','window-family-low',?,'SCORED',10,50,60,0,?,?)`,args:[observedAt.slice(0,10),observedAt,NEXT]});
  await journal(f,'window-family-next',new Date(Date.parse(NEXT)-3600000).toISOString());
  const context=await f.stores.capture('a',{executionMode:'SHADOW'}),refs=await recoveryRefs(f.stores,context,
    ['window-family-low',...f.recoveryIds.slice(1)]),fresh=request(refs[0],refs.slice(1),NEXT);
  const dailyEvidence=await call(f,'intelligence','analyzeMetric',{...fresh,windowFamily:DAILY,refresh:true});
  const secondaryEvidence=await call(f,'intelligence','analyzeMetric',{...fresh,windowFamily:SECONDARY,refresh:true});
  const identity=windowFamily=>({algorithmMajor:'phase4-intelligence-v1',domain:'recovery',metric:'recovery_score',
    subject:'recovery_score',windowFamily,direction:'LOWER'});
  const beforeWrongEvidence=await durable(f);
  await assert.rejects(call(f,'episodes','refresh',{episodeId:daily.episode_id,expectedRevision:daily.revision,
    identity:identity(DAILY),metricRefresh:true,evidenceItemId:secondaryEvidence.item.row.evidence_item_id,
    semanticAt:NEXT}),/PHASE4_METRIC_REFRESH_EVIDENCE_IDENTITY/);
  assert.deepEqual(await durable(f),beforeWrongEvidence);
  const other=await call(f,'episodes','refresh',{episodeId:secondary.episode_id,expectedRevision:secondary.revision,
    identity:identity(SECONDARY),metricRefresh:true,evidenceItemId:secondaryEvidence.item.row.evidence_item_id,semanticAt:NEXT});
  assert.equal(other.row.revision,secondary.revision+1);
  const secondaryReceipt=await receipt(f,SECONDARY,'EPISODE_REFRESH');
  await f.db.transaction(()=>cloneReceipts(f,secondaryReceipt,1001));
  await corrupt(f,secondaryReceipt);
  const result=await call(f,'episodes','refresh',{episodeId:daily.episode_id,expectedRevision:daily.revision,
    identity:identity(DAILY),metricRefresh:true,evidenceItemId:dailyEvidence.item.row.evidence_item_id,semanticAt:NEXT});
  assert.equal(result.row.revision,daily.revision+1);
});

test('R6-06 terminal DAILY recurrence ignores corrupt SECONDARY receipt',async t=>{
  const {f,old,analysis,openRequest}=await recurrenceFixture(t,{targetVersion:29});
  const {refresh,...otherAnalysis}=analysis;
  const other=await call(f,'intelligence','analyzeMetric',{...otherAnalysis,windowFamily:SECONDARY});
  assert.ok(other.episode?.episode?.row);
  const secondaryReceipt=await receipt(f,SECONDARY,'EPISODE_OPEN');
  await f.db.transaction(()=>cloneReceipts(f,secondaryReceipt,1001));
  await corrupt(f,secondaryReceipt);
  const result=await call(f,'episodes','open',openRequest());
  assert.equal(result.row.reopens_episode_id,old.episode_id);
});

test('R6-06 required same-family predecessor remains fail-closed',async t=>{
  const {f,old,openRequest}=await recurrenceFixture(t,{targetVersion:29});
  const target=(await f.db.raw.execute({sql:"SELECT * FROM phase4_operation_receipts WHERE operation_kind='EPISODE_OPEN'"})).rows
    .find(row=>row.related_results_json?.includes(old.episode_id));
  assert.ok(target);
  await corrupt(f,target);
  const before=await durable(f);
  await assert.rejects(call(f,'episodes','open',openRequest()),/PHASE4_OPERATION_RECEIPT_INTEGRITY/);
  assert.deepEqual(await durable(f),before);
});

test('R6-06 resolved SECONDARY terminal history cannot replace or block DAILY predecessor',async t=>{
  const f=await setup(t,{targetVersion:29});
  for(let i=0;i<15;i++)await journal(f,`dual-terminal-initial-${i}`,'2026-09-25T11:00:00.000Z');
  const initial=request(f.initialRefs[0],f.initialRefs.slice(1));
  for(const windowFamily of [DAILY,SECONDARY]) {
    const opened=await call(f,'intelligence','analyzeMetric',{...initial,windowFamily});
    assert.equal(opened.episode.episode.row.state,'OPEN');
  }
  f.setNow('2026-09-26T12:00:00.000Z');
  await f.db.raw.execute(`INSERT INTO whoop_recoveries(user_id,sleep_id,health_date,score_state,recovery_score,
    hrv_rmssd_milli,resting_heart_rate,user_calibrating,updated_at,synced_at)
    VALUES ('a','dual-stable','2026-09-26','SCORED',50,50,60,0,'2026-09-26T10:00:00.000Z','2026-09-26T12:00:00.000Z')`);
  let context=await f.stores.capture('a',{executionMode:'SHADOW'});
  const stableRefs=await recoveryRefs(f.stores,context,['dual-stable',...f.recoveryIds.slice(0,30)]);
  const stable=request(stableRefs[0],stableRefs.slice(1),'2026-09-26T12:00:00.000Z');
  for(const windowFamily of [DAILY,SECONDARY])assert.equal((await call(f,'intelligence','analyzeMetric',
    {...stable,windowFamily})).episode.episode.row.state,'STABILIZING');
  f.setNow(TERMINAL);
  const terminal={...stable,asOfUtc:TERMINAL},resolved={};
  for(const windowFamily of [DAILY,SECONDARY]) {
    resolved[windowFamily]=(await call(f,'intelligence','analyzeMetric',{...terminal,windowFamily})).episode.episode.row;
    assert.equal(resolved[windowFamily].state,'RESOLVED');
  }
  assert.notEqual(resolved[DAILY].episode_id,resolved[SECONDARY].episode_id);
  f.setNow(NEXT);
  const observedAt=new Date(Date.parse(NEXT)-7200000).toISOString();
  await f.db.raw.execute({sql:`INSERT INTO whoop_recoveries(user_id,sleep_id,health_date,score_state,recovery_score,
    hrv_rmssd_milli,resting_heart_rate,user_calibrating,updated_at,synced_at)
    VALUES ('a','dual-recur-low',?,'SCORED',10,50,60,0,?,?)`,args:[observedAt.slice(0,10),observedAt,NEXT]});
  await journal(f,'dual-terminal-next',new Date(Date.parse(NEXT)-3600000).toISOString());
  context=await f.stores.capture('a',{executionMode:'SHADOW'});
  const nextRefs=await recoveryRefs(f.stores,context,['dual-recur-low',...f.recoveryIds.slice(1)]);
  const prepared=await call(f,'intelligence','analyzeMetric',
    {...request(nextRefs[0],nextRefs.slice(1),NEXT),windowFamily:DAILY,refresh:true});
  const calculation=prepared.calculation,manifest=JSON.parse(prepared.run.row.input_manifest_json);
  const open={recurrence:true,predecessorRevision:resolved[DAILY].revision,
    identity:{algorithmMajor:'phase4-intelligence-v1',domain:'recovery',metric:'recovery_score',
      subject:'recovery_score',windowFamily:DAILY,direction:'LOWER'},reopensEpisodeId:resolved[DAILY].episode_id,
    data:canonicalEpisodeData({timezone:'Asia/Taipei'},{current:manifest.current,calculation,asOfUtc:NEXT,
      confidence:JSON.parse(prepared.item.row.provenance_json).confidence}),
    evidenceItemId:prepared.item.row.evidence_item_id,semanticAt:NEXT,
    semanticEvent:{eventKind:'OPENED',severityOrdinal:calculation.severity,claimKey:'metric:recovery_score',
      semanticContentHash:calculation.semanticHash}};
  const secondaryReceipt=(await f.db.raw.execute({sql:`SELECT * FROM phase4_operation_receipts
    WHERE operation_kind LIKE 'EPISODE_%' ORDER BY created_at,operation_key`})).rows
    .filter(row=>row.related_results_json?.includes(resolved[SECONDARY].episode_id)).at(-1);
  assert.ok(secondaryReceipt);
  await corrupt(f,secondaryReceipt);
  const scoped=await episodeInventory(f,DAILY);
  assert.ok(scoped.latest.has(resolved[DAILY].episode_id));
  assert.ok(!scoped.latest.has(resolved[SECONDARY].episode_id));
  const reopened=await call(f,'episodes','open',open);
  assert.equal(reopened.row.reopens_episode_id,resolved[DAILY].episode_id);
});

test('R6-06 v29 worker discovers a custom window, then reopens from its precise family',async t=>{
  const {f,old}=await recurrenceFixture(t,{targetVersion:29,windowFamily:'CUSTOM_RETAINED_FAMILY'});
  const worker=await createPhase4Stage6({db:f.db,keys:f.keys,executionMode:'SHADOW',
    workerCapability:authorizeStage6ShadowWorker({executionMode:'SHADOW'}),now:()=>new Date(NEXT)});
  for(let i=0;i<8;i++) {
    const result=await worker.drain({budget:{maxItemsPerTenant:32,maxItems:64,maxWallMs:90000,leaseMs:120000}});
    assert.equal(result.failedJobs,0,JSON.stringify(result));
    if((await worker.diagnostics()).pendingJobs===0)break;
  }
  assert.equal((await worker.diagnostics()).pendingJobs,0);
  const rows=(await f.db.raw.execute({sql:'SELECT * FROM observation_episodes WHERE episode_family_key=?',
    args:[old.episode_family_key]})).rows;
  assert.equal(rows.length,2);
  assert.equal(rows.find(row=>row.episode_id!==old.episode_id).reopens_episode_id,old.episode_id);
});
