import test from 'node:test';
import assert from 'node:assert/strict';
import { setup,request } from './stage5HistoryFixture.js';
import { call } from './stage5ClosureFixture.js';
import { guards,durable } from './stage5ReviewBFixture.js';
import { createOperationReceipts } from '../src/phase4OperationReceipts.js';
import { setup as associationSetup,hypothesis,family } from './stage5AssociationFixture.js';
import { fixture as recurrenceFixture,NEXT } from './stage6RecurrenceFixture.js';
import { canonicalEpisodeData } from '../src/phase4IntelligenceStore.js';

const T='2026-09-25T12:00:00.000Z';

test('Unrelated rhr metric receipt must not poison recovery episode inventory',async t=>{
  const f=await setup(t,{targetVersion:29});
  const base=request(f.initialRefs[0],f.initialRefs.slice(1),T);
  const recovery=await call(f,'intelligence','analyzeMetric',base);
  assert.ok(recovery.episode?.episode?.row);
  const unrelated=await call(f,'intelligence','analyzeMetric',{...base,metricKey:'rhr',windowFamily:'DAILY_RHR'});
  assert.ok(unrelated.item?.row);
  const receipts=(await f.db.raw.execute("SELECT operation_key,request_json FROM phase4_operation_receipts WHERE operation_kind='analyzeMetric'")).rows;
  const rhr=receipts.find(row=>row.request_json?.includes('DAILY_RHR'));
  assert.ok(rhr,'real unrelated metric receipt exists');
  const api=createOperationReceipts(f.core);
  const first=await f.stores.withContext('a',{executionMode:'SHADOW'},c=>api.episodeRecurrenceInventory(c,{metricKey:'recovery_score'}));
  assert.ok([...first.latest.values()].some(value=>value.row.subject_key==='recovery_score'));
  await guards(f,'phase4_operation_receipts',()=>f.db.raw.execute({sql:'UPDATE phase4_operation_receipts SET receipt_hmac=? WHERE operation_key=?',args:['0'.repeat(64),rhr.operation_key]}));
  const scoped=await f.stores.withContext('a',{executionMode:'SHADOW'},c=>api.episodeRecurrenceInventory(c,{metricKey:'recovery_score'}));
  assert.equal(scoped.latest.size,1);
});

test('Required recovery receipt corruption remains fail-closed',async t=>{
  const f=await setup(t,{targetVersion:29});
  const base=request(f.initialRefs[0],f.initialRefs.slice(1),T);
  const recovery=await call(f,'intelligence','analyzeMetric',base);
  assert.ok(recovery.episode?.episode?.row);
  const row=(await f.db.raw.execute("SELECT operation_key FROM phase4_operation_receipts WHERE operation_kind='EPISODE_OPEN' LIMIT 1")).rows[0];
  assert.ok(row);
  await guards(f,'phase4_operation_receipts',()=>f.db.raw.execute({sql:'UPDATE phase4_operation_receipts SET receipt_hmac=? WHERE operation_key=?',args:['0'.repeat(64),row.operation_key]}));
  const before=await durable(f),api=createOperationReceipts(f.core);
  await assert.rejects(f.stores.withContext('a',{executionMode:'SHADOW'},c=>api.episodeRecurrenceInventory(c,{metricKey:'recovery_score'})),
    /PHASE4_OPERATION_RECEIPT_INTEGRITY/);
  assert.deepEqual(await durable(f),before);
});

test('Unrelated rhr association receipt must not poison recovery insight refresh',async t=>{
  const f=await associationSetup(t,{days:30,targetVersion:29}),days=Array.from({length:30},(_,i)=>i);
  const recovery=await call(f,'intelligence','analyzeAssociationFamily',family('scope-recovery',hypothesis(f,days)));
  const old=recovery.items[0].insight.current;
  const rhr=await call(f,'intelligence','analyzeAssociationFamily',family('scope-rhr',{...hypothesis(f,days),outcomeMetric:'rhr'}));
  assert.ok(rhr.items[0].item?.row);
  const row=(await f.db.raw.execute("SELECT operation_key,request_json FROM phase4_operation_receipts WHERE operation_kind='analyzeAssociationFamily'")).rows
    .find(value=>value.request_json?.includes('scope-rhr'));
  assert.ok(row);
  f.setNow('2026-09-25T12:00:01.000Z');
  const text='caffeine at 2026-09-25T11:00:00.000Z';
  const created=await f.stores.journal.create(await f.stores.captureControl('a'),{sourceEventKey:'scope-generation',sourceText:text,
    candidate:{category:'caffeine',eventAt:'2026-09-25T11:00:00.000Z',valueKind:'PRESENCE',exposureState:'EXPOSED',extractionConfidence:1,excerptStart:0,excerptEnd:text.length}});
  assert.equal(created.status,'ACCEPT');
  const fresh=await call(f,'intelligence','analyzeAssociationFamily',{
    ...family('scope-fresh',hypothesis(f,days),'2026-09-25T12:00:01.000Z'),lifecycleMode:'EVIDENCE_ONLY'});
  await guards(f,'phase4_operation_receipts',()=>f.db.raw.execute({sql:'UPDATE phase4_operation_receipts SET receipt_hmac=? WHERE operation_key=?',
    args:['0'.repeat(64),row.operation_key]}));
  const identity={subject:'journal:caffeine',outcome:'recovery_score',direction:'LOWER',exposureCategory:'caffeine',
    algorithmFamily:'journal-association',evidenceContractMajor:'1'};
  const request={insightId:old.row.id,expectedRevision:old.row.current_revision,identity,refresh:true,status:'EMERGING',
    claim:'Caffeine may be associated with lower recovery; further evidence is needed.',
    supportingEvidenceIds:[fresh.items[0].item.row.evidence_item_id],reason:'REPEATED_EVIDENCE',semanticAt:'2026-09-25T12:00:01.000Z'};
  const transitioned=await call(f,'insights','transition',request);
  assert.equal(transitioned.row.current_revision,old.row.current_revision+1);
});

test('Unrelated rhr metric receipt must not poison public recovery recurrence',async t=>{
  const {f,openRequest}=await recurrenceFixture(t,{targetVersion:29}),requestToOpen=openRequest();
  const base=request(f.initialRefs[0],f.initialRefs.slice(1),NEXT);
  const unrelated=await call(f,'intelligence','analyzeMetric',{...base,metricKey:'rhr',windowFamily:'DAILY_RHR',refresh:true});
  assert.ok(unrelated.item?.row);
  const row=(await f.db.raw.execute("SELECT operation_key,request_json FROM phase4_operation_receipts WHERE operation_kind='analyzeMetric'")).rows
    .find(value=>value.request_json?.includes('DAILY_RHR'));
  assert.ok(row);
  await guards(f,'phase4_operation_receipts',()=>f.db.raw.execute({sql:'UPDATE phase4_operation_receipts SET receipt_hmac=? WHERE operation_key=?',
    args:['0'.repeat(64),row.operation_key]}));
  const reopened=await call(f,'episodes','open',requestToOpen);
  assert.equal(reopened.row.reopens_episode_id,requestToOpen.reopensEpisodeId);
});

test('Unrelated rhr metric receipt must not poison public active recovery refresh',async t=>{
  const f=await setup(t,{targetVersion:29});
  const journal=async key=>{
    const text='caffeine at 2026-09-25T11:00:00.000Z';
    const result=await f.stores.journal.create(await f.stores.captureControl('a'),{sourceEventKey:key,sourceText:text,
      candidate:{category:'caffeine',eventAt:'2026-09-25T11:00:00.000Z',valueKind:'PRESENCE',exposureState:'EXPOSED',
        extractionConfidence:1,excerptStart:0,excerptEnd:text.length}});
    assert.equal(result.status,'ACCEPT');
  };
  for(let i=0;i<15;i++)await journal(`scope-initial-${i}`);
  const old=(await call(f,'intelligence','analyzeMetric',request(f.initialRefs[0],f.initialRefs.slice(1),T))).episode.episode.row;
  assert.equal(old.input_generation,15);
  const next='2026-09-25T12:00:01.000Z';f.setNow(next);await journal('scope-next');
  const base=request(f.initialRefs[0],f.initialRefs.slice(1),next);
  const prepared=await call(f,'intelligence','analyzeMetric',{...base,refresh:true});
  const unrelated=await call(f,'intelligence','analyzeMetric',{...base,metricKey:'rhr',windowFamily:'DAILY_RHR',refresh:true});
  assert.ok(unrelated.item?.row);
  const row=(await f.db.raw.execute("SELECT operation_key,request_json FROM phase4_operation_receipts WHERE operation_kind='analyzeMetric'")).rows
    .find(value=>value.request_json?.includes('DAILY_RHR'));
  assert.ok(row);
  await guards(f,'phase4_operation_receipts',()=>f.db.raw.execute({sql:'UPDATE phase4_operation_receipts SET receipt_hmac=? WHERE operation_key=?',
    args:['0'.repeat(64),row.operation_key]}));
  const refresh={episodeId:old.episode_id,expectedRevision:old.revision,
    identity:{algorithmMajor:'phase4-intelligence-v1',domain:'recovery',metric:'recovery_score',subject:'recovery_score',
      windowFamily:'DAILY_RECOVERY',direction:'LOWER'},metricRefresh:true,
    evidenceItemId:prepared.item.row.evidence_item_id,semanticAt:next};
  const refreshed=await call(f,'episodes','refresh',refresh);
  assert.equal(refreshed.row.revision,old.revision+1);
});

for(const fault of ['clean','required'])test(`v29 terminal recurrence ${fault} target authority`,async t=>{
  const {f,old,openRequest}=await recurrenceFixture(t,{targetVersion:29}),open=openRequest();
  if(fault==='required') {
    const receipt=(await f.db.raw.execute("SELECT * FROM phase4_operation_receipts WHERE operation_kind='EPISODE_OPEN'")).rows
      .find(row=>row.related_results_json?.includes(old.episode_id));
    assert.ok(receipt);
    await guards(f,'phase4_operation_receipts',()=>f.db.raw.execute({sql:`UPDATE phase4_operation_receipts
      SET receipt_hmac=? WHERE operation_key=?`,args:['0'.repeat(64),receipt.operation_key]}));
  }
  const before=await durable(f);
  if(fault==='required') {
    await assert.rejects(call(f,'episodes','open',open),/PHASE4_OPERATION_RECEIPT_INTEGRITY/);
    assert.deepEqual(await durable(f),before);
  } else assert.equal((await call(f,'episodes','open',open)).row.reopens_episode_id,old.episode_id);
});

for(const fault of ['clean','required'])test(`v29 active metric refresh ${fault} target authority`,async t=>{
  const {f,old,prepared,identity}=await recurrenceFixture(t,{targetVersion:29,active:true});
  const refresh={episodeId:old.episode_id,expectedRevision:old.revision,identity,metricRefresh:true,
    evidenceItemId:prepared.item.row.evidence_item_id,semanticAt:NEXT};
  if(fault==='required') {
    const receipt=(await f.db.raw.execute("SELECT * FROM phase4_operation_receipts WHERE operation_kind='EPISODE_OPEN'")).rows
      .find(row=>row.related_results_json?.includes(old.episode_id));
    assert.ok(receipt);
    await guards(f,'phase4_operation_receipts',()=>f.db.raw.execute({sql:`UPDATE phase4_operation_receipts
      SET receipt_hmac=? WHERE operation_key=?`,args:['0'.repeat(64),receipt.operation_key]}));
  }
  const before=await durable(f);
  if(fault==='required') {
    await assert.rejects(call(f,'episodes','refresh',refresh),/PHASE4_OPERATION_RECEIPT_INTEGRITY/);
    assert.deepEqual(await durable(f),before);
  } else assert.equal((await call(f,'episodes','refresh',refresh)).row.revision,old.revision+1);
});

for(const fault of ['clean','required'])test(`v29 insight refresh ${fault} target authority`,async t=>{
  const f=await associationSetup(t,{days:30,targetVersion:29}),days=Array.from({length:30},(_,i)=>i);
  const analyzed=await call(f,'intelligence','analyzeAssociationFamily',family('r605-insight-old',hypothesis(f,days)));
  const old=analyzed.items[0].insight.current;
  f.setNow('2026-09-25T12:00:01.000Z');
  const text='caffeine at 2026-09-25T11:00:00.000Z';
  await f.stores.journal.create(await f.stores.captureControl('a'),{sourceEventKey:'r605-insight-generation',sourceText:text,
    candidate:{category:'caffeine',eventAt:'2026-09-25T11:00:00.000Z',valueKind:'PRESENCE',exposureState:'EXPOSED',
      extractionConfidence:1,excerptStart:0,excerptEnd:text.length}});
  const fresh=await call(f,'intelligence','analyzeAssociationFamily',{
    ...family('r605-insight-fresh',hypothesis(f,days),'2026-09-25T12:00:01.000Z'),lifecycleMode:'EVIDENCE_ONLY'});
  const identity={subject:'journal:caffeine',outcome:'recovery_score',direction:'LOWER',exposureCategory:'caffeine',
    algorithmFamily:'journal-association',evidenceContractMajor:'1'};
  const transition={insightId:old.row.id,expectedRevision:old.row.current_revision,identity,refresh:true,status:'EMERGING',
    claim:'Caffeine may be associated with lower recovery; further evidence is needed.',
    supportingEvidenceIds:[fresh.items[0].item.row.evidence_item_id],reason:'REPEATED_EVIDENCE',
    semanticAt:'2026-09-25T12:00:01.000Z'};
  if(fault==='required') {
    const receipt=(await f.db.raw.execute("SELECT * FROM phase4_operation_receipts WHERE operation_kind='INSIGHT_CREATE'")).rows
      .find(row=>row.related_results_json?.includes(`\"id\":${old.row.id}`));
    assert.ok(receipt);
    await guards(f,'phase4_operation_receipts',()=>f.db.raw.execute({sql:`UPDATE phase4_operation_receipts
      SET receipt_hmac=? WHERE operation_key=?`,args:['0'.repeat(64),receipt.operation_key]}));
  }
  const before=await durable(f);
  if(fault==='required') {
    await assert.rejects(call(f,'insights','transition',transition),/PHASE4_OPERATION_RECEIPT_INTEGRITY/);
    assert.deepEqual(await durable(f),before);
  } else assert.equal((await call(f,'insights','transition',transition)).row.current_revision,old.row.current_revision+1);
});

for(const fault of ['clean','unrelated','required'])test(`v29 normal no-predecessor episode open ${fault} authority`,async t=>{
  const f=await setup(t,{targetVersion:29}),base=request(f.initialRefs[0],f.initialRefs.slice(1),T);
  const prepared=await call(f,'intelligence','analyzeMetric',{...base,windowFamily:'SECONDARY_RECOVERY',refresh:true});
  const calculation=prepared.calculation,manifest=JSON.parse(prepared.run.row.input_manifest_json),
    identity={algorithmMajor:'phase4-intelligence-v1',domain:'recovery',metric:'recovery_score',
      subject:'recovery_score',windowFamily:'SECONDARY_RECOVERY',direction:calculation.direction};
  const open={identity,data:canonicalEpisodeData({timezone:'Asia/Taipei'},{current:manifest.current,calculation,
    asOfUtc:T,confidence:JSON.parse(prepared.item.row.provenance_json).confidence}),
    evidenceItemId:prepared.item.row.evidence_item_id,semanticAt:T,
    semanticEvent:{eventKind:'OPENED',severityOrdinal:calculation.severity,
      claimKey:'metric:recovery_score',semanticContentHash:calculation.semanticHash}};
  if(fault!=='clean') {
    let receipt;
    if(fault==='unrelated') {
      await call(f,'intelligence','analyzeMetric',{...base,metricKey:'rhr',windowFamily:'DAILY_RHR'});
      receipt=(await f.db.raw.execute("SELECT * FROM phase4_operation_receipts WHERE operation_kind='analyzeMetric'")).rows
        .find(row=>row.request_json.includes('DAILY_RHR'));
    } else receipt=(await f.db.raw.execute("SELECT * FROM phase4_operation_receipts WHERE operation_kind='analyzeMetric'")).rows
      .find(row=>row.request_json.includes('SECONDARY_RECOVERY'));
    assert.ok(receipt);
    await guards(f,'phase4_operation_receipts',()=>f.db.raw.execute({sql:`UPDATE phase4_operation_receipts SET receipt_hmac=?
      WHERE operation_key=?`,args:['0'.repeat(64),receipt.operation_key]}));
  }
  if(fault==='required') {
    const before=await durable(f);
    await assert.rejects(call(f,'episodes','open',open),/PHASE4_OPERATION_RECEIPT_INTEGRITY/);
    assert.deepEqual(await durable(f),before);
  } else {
    const result=await call(f,'episodes','open',open);
    assert.equal(result.row.reopens_episode_id,null);
  }
});
