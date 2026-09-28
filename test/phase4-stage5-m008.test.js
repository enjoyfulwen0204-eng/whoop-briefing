import test from 'node:test';
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { setup,hypothesis,family } from './stage5AssociationFixture.js';
import { call } from './stage5ClosureFixture.js';
import { guards,semantic,leases,T } from './stage5ReviewBFixture.js';
import { snapshot,identity } from './stage5M007Fixture.js';
import { insightIdentityKey } from '../src/phase4InsightStore.js';

const tables=['evidence_runs','evidence_items','health_insights','insight_revisions',
  'phase4_evidence_result_authorities','phase4_operation_receipts','resource_locks'];
const counts=rows=>Object.fromEntries(tables.map(table=>[table,rows[table].length]));
const logicalKey=(f,value)=>insightIdentityKey(f.keys,{userId:'a'},value);
async function candidateFixture(t,{opposite=false,matching=false,status='EMERGING',
  semanticAt=T,expiresAt='2026-09-26T12:00:00.000Z'}={}) {
  const f=await setup(t,{days:30}),h=hypothesis(f,Array.from({length:30},(_,i)=>i));
  const originalRequest=family('m008-original',h),original=await call(f,'intelligence','analyzeAssociationFamily',originalRequest);
  const old=original.items[0].insight.current,evidenceId=original.items[0].item.row.evidence_item_id;
  await call(f,'insights','transition',{insightId:old.row.id,expectedRevision:old.row.current_revision,
    status:'RETIRED',disposition:'EXPIRED',claim:old.row.statement,supportingEvidenceIds:[evidenceId],reason:'EXPIRED',semanticAt:T});
  f.setNow(semanticAt);
  const requestedIdentity={...identity,direction:opposite?'HIGHER':'LOWER'};
  const selectedIdentity=matching?Object.fromEntries(Object.entries(requestedIdentity).map(([key,value])=>[key,`  ${value.toUpperCase()}  `]))
    :{...requestedIdentity,subject:'journal:other-factor',exposureCategory:'other-factor'};
  const createRequest={identity:selectedIdentity,claim:'A directly recorded candidate',evidenceContractVersion:'phase4-evidence-v1',
    supportingEvidenceIds:[evidenceId],expiresAt,creationKey:'m008-candidate',semanticAt};
  let current=await call(f,'insights','create',createRequest);
  if(status!=='HYPOTHESIS')current=await call(f,'insights','transition',{insightId:current.row.id,
    expectedRevision:current.row.current_revision,status:'EMERGING',claim:current.row.statement,
    supportingEvidenceIds:[evidenceId],reason:'REPEATED_EVIDENCE',semanticAt});
  if(status==='WEAKENED')current=await call(f,'insights','transition',{insightId:current.row.id,
    expectedRevision:current.row.current_revision,status,claim:current.row.statement,supportingEvidenceIds:[],
    contradictingEvidenceIds:[evidenceId],reason:'CONTRADICTORY_EVIDENCE',semanticAt});
  const requestedKey=logicalKey(f,requestedIdentity);
  if(!matching)await guards(f,'health_insights',()=>f.db.raw.execute({sql:'UPDATE health_insights SET insight_key=? WHERE id=?',
    args:[requestedKey,current.row.id]}));
  const request=(name='m008-reuse',at=T)=>family(name,h,at);
  const reuse=(name,at)=>call(f,'intelligence','analyzeAssociationFamily',request(name,at));
  return {f,old,current,original,originalRequest,requestedIdentity,requestedKey,selectedIdentity,createRequest,evidenceId,request,reuse};
}

test('M008: exact Review B wrong-family reuse authenticates then rejects with zero writes',async t=>{
  const {f,current,requestedKey,reuse}=await candidateFixture(t);
  const selected=await f.stores.withContext('a',{executionMode:'SHADOW'},c=>f.stores.insights.read(c,current.row.id,{history:true}));
  assert.equal(selected.row.subject,'journal:other-factor');assert.equal(selected.row.insight_key,current.row.insight_key);
  assert.notEqual(selected.row.insight_key,requestedKey);
  const before=await snapshot(f);let result,error;
  try{result=await reuse();}catch(value){error=value;}
  const after=await snapshot(f);
  t.diagnostic(JSON.stringify({kind:'review-b-m008',requestedKey,selectedAuthenticatedKey:selected.row.insight_key,
    selectedSubject:selected.row.subject,error:error?.code??null,returnedSubject:result?.items[0].insight.current.row.subject??null,
    wrongResultExactReplay:result?isDeepStrictEqual(semantic(await reuse()),semantic(result)):null,
    before:counts(before),after:counts(after)}));
  assert.equal(error?.code,'PHASE4_INSIGHT_IDENTITY_MISMATCH');
  assert.equal(result,undefined);assert.deepEqual(after,before);assert.equal(await leases(f),0);
});

for(const opposite of [false,true]) {
  const path=opposite?'opposite/contradiction':'current/support';
  for(const status of ['HYPOTHESIS','EMERGING','WEAKENED']) {
    if(!opposite&&status==='EMERGING')continue; // The exact reproduction above.
    test(`M008: ${path} ${status} rejects the authenticated wrong family before reuse/transition`,async t=>{
      const {f,reuse}=await candidateFixture(t,{opposite,status}),before=await snapshot(f);
      await assert.rejects(reuse(),{code:'PHASE4_INSIGHT_IDENTITY_MISMATCH'});
      assert.deepEqual(await snapshot(f),before);assert.equal(await leases(f),0);
    });
  }
  for(const temporal of ['future','expired'])test(`M008: ${path} mismatch cannot become ${temporal} absence`,async t=>{
    const boundary='2026-09-25T12:00:01.000Z';
    const {f,reuse}=await candidateFixture(t,{opposite,...(temporal==='future'?{semanticAt:boundary}:{expiresAt:boundary})});
    f.setNow(boundary);const before=await snapshot(f);
    await assert.rejects(reuse(`m008-${temporal}`,temporal==='future'?T:boundary),{code:'PHASE4_INSIGHT_IDENTITY_MISMATCH'});
    assert.deepEqual(await snapshot(f),before);assert.equal(await leases(f),0);
  });

  test(`M008: ${path} missing/corrupt/redacted/stale authority never becomes absence`,async t=>{
    const {f,current,reuse}=await candidateFixture(t,{opposite});
    const receipt=(await f.db.raw.execute("SELECT * FROM phase4_operation_receipts WHERE operation_kind='INSIGHT_TRANSITION'"))
      .rows.find(row=>JSON.parse(row.request_json).request.insightId===current.row.id);
    const revision=(await f.db.raw.execute({sql:'SELECT * FROM insight_revisions WHERE insight_id=? AND revision=?',
      args:[current.row.id,current.row.current_revision]})).rows[0];
    const parent=(await f.db.raw.execute({sql:'SELECT * FROM health_insights WHERE id=?',args:[current.row.id]})).rows[0];
    for(const [table,row,column,value] of [
      ['phase4_operation_receipts',receipt,'receipt_hmac','0'.repeat(64)],
      ['insight_revisions',revision,'normalized_claim','CORRUPT'],
      ['health_insights',parent,'health_content_redacted_at',T],
      ['health_insights',parent,'input_generation',parent.input_generation+1],
    ])for(const fault of table==='health_insights'?['corrupt']:['missing','corrupt']) {
      await guards(f,table,()=>f.db.raw.execute(fault==='missing'
        ?{sql:`DELETE FROM ${table} WHERE privacy_artifact_id=?`,args:[row.privacy_artifact_id]}
        :{sql:`UPDATE ${table} SET ${column}=? WHERE privacy_artifact_id=?`,args:[value,row.privacy_artifact_id]}));
      const before=await snapshot(f);
      await assert.rejects(reuse(`${path}-${table}-${column}-${fault}`),
        /RECEIPT_INTEGRITY|OPERATION_RESULT_UNAVAILABLE|PARENT_NOT_FOUND|PARENT_STALE|CONTENT_REDACTED/);
      assert.deepEqual(await snapshot(f),before);assert.equal(await leases(f),0);
      await guards(f,table,()=>f.db.raw.execute({sql:`INSERT OR REPLACE INTO ${table}(${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(()=>'?').join(',')})`,args:Object.values(row)}));
    }
    const before=await snapshot(f);
    await assert.rejects(reuse('restored-authority-still-wrong-family'),{code:'PHASE4_INSIGHT_IDENTITY_MISMATCH'});
    assert.deepEqual(await snapshot(f),before);assert.equal(await leases(f),0);
  });
}

test('M008: canonical direct identity matches association reuse, origins and unchanged historical replay',async t=>{
  const {f,current,old,original,originalRequest,createRequest,requestedKey,reuse}=await candidateFixture(t,{matching:true});
  assert.equal(current.row.insight_key,requestedKey);assert.equal(current.row.subject,'journal:caffeine');
  assert.equal(current.row.supersedes_id,old.row.id);
  const before=await snapshot(f),result=await reuse(),selected=result.items[0].insight.current;
  assert.equal(selected.row.id,current.row.id);assert.equal(selected.row.current_revision,current.row.current_revision);
  assert.equal(selected.row.insight_key,requestedKey);
  const after=await snapshot(f);assert.deepEqual(after.health_insights,before.health_insights);
  assert.deepEqual(after.insight_revisions,before.insight_revisions);
  const origin=after.phase4_evidence_result_authorities.find(row=>row.evidence_item_id===result.items[0].item.row.evidence_item_id
    &&row.result_scope==='INSIGHT_CURRENT');
  assert.equal(JSON.parse(origin.original_result_json).insight_id,current.row.id);
  // Current lookup metadata can later drift without changing an exact valid
  // historical request's sealed identity or full semantic result.
  await guards(f,'health_insights',()=>f.db.raw.execute({sql:'UPDATE health_insights SET insight_key=? WHERE id=?',
    args:['e'.repeat(64),current.row.id]}));
  const historyBefore=await snapshot(f);
  assert.deepEqual(semantic(await reuse()),semantic(result));
  assert.deepEqual(semantic(await call(f,'intelligence','analyzeAssociationFamily',originalRequest)),semantic(original));
  const created=await call(f,'insights','create',createRequest);
  assert.equal(created.row.insight_key,requestedKey);assert.equal(created.row.current_revision,1);
  assert.deepEqual(await snapshot(f),historyBefore);assert.equal(await leases(f),0);
  t.diagnostic(JSON.stringify({kind:'matching-reuse-m008',insightId:current.row.id,requestedKey,
    selectedAuthenticatedKey:selected.row.insight_key,insightsBefore:before.health_insights.length,insightsAfter:after.health_insights.length,
    revisionsBefore:before.insight_revisions.length,revisionsAfter:after.insight_revisions.length}));
});

test('M008: matching authenticated opposite family remains eligible for contradiction',async t=>{
  const {f,current,requestedKey,reuse}=await candidateFixture(t,{opposite:true,matching:true});
  const result=await reuse(),opposite=result.items[0].insight.contradiction;
  assert.equal(opposite.row.id,current.row.id);assert.equal(opposite.row.insight_key,requestedKey);
  assert.equal(opposite.row.status,'WEAKENED');assert.equal(opposite.row.current_revision,current.row.current_revision+1);
  assert.equal(result.items[0].insight.current.row.insight_key,logicalKey(f,identity));
  const before=await snapshot(f),origin=before.phase4_evidence_result_authorities.find(row=>
    row.evidence_item_id===result.items[0].item.row.evidence_item_id&&row.result_scope==='INSIGHT_CONTRADICTION');
  assert.equal(JSON.parse(origin.original_result_json).insight_id,current.row.id);
  assert.deepEqual(semantic(await reuse()),semantic(result));assert.deepEqual(await snapshot(f),before);assert.equal(await leases(f),0);
});

test('M008: direct creation and association reject the same authenticated wrong-family selection',async t=>{
  const {f,current,createRequest,requestedIdentity,requestedKey,reuse}=await candidateFixture(t);
  const canonicalAlias=Object.fromEntries(Object.entries(requestedIdentity).map(([key,value])=>[key,` ${value.toUpperCase()} `]));
  assert.equal(logicalKey(f,canonicalAlias),requestedKey);assert.notEqual(current.row.insight_key,requestedKey);
  const before=await snapshot(f);
  await assert.rejects(call(f,'insights','create',{...createRequest,identity:canonicalAlias,
    creationKey:'m008-direct-wrong-family',supersedesId:current.row.id}),{code:'PHASE4_INSIGHT_INCARNATION_INVALID'});
  assert.deepEqual(await snapshot(f),before);
  await assert.rejects(reuse(),{code:'PHASE4_INSIGHT_IDENTITY_MISMATCH'});
  assert.deepEqual(await snapshot(f),before);assert.equal(await leases(f),0);
});
