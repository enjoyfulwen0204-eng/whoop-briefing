import test from 'node:test';
import assert from 'node:assert/strict';
import { setup,request } from './stage5HistoryFixture.js';
import { setup as association,hypothesis,family } from './stage5AssociationFixture.js';
import { call } from './stage5ClosureFixture.js';
import { guards,durable,semantic,leases,T } from './stage5ReviewBFixture.js';

// A short legitimate expiry (direct lifecycle API) keeps the input universe
// fixed at each millisecond boundary without changing statistical thresholds.
for(const delta of [-1,0,1])test(`M001: association selects current incarnation at expiry ${delta}ms`,async t=>{
  const f=await association(t,{days:30}),h=hypothesis(f,Array.from({length:30},(_,i)=>i));
  const req=family('expiry-initial',h),initial=await call(f,'intelligence','analyzeAssociationFamily',req);
  const old=initial.items[0].insight.current;
  await call(f,'insights','transition',{insightId:old.row.id,expectedRevision:old.row.current_revision,status:'RETIRED',
    disposition:'EXPIRED',claim:old.row.statement,supportingEvidenceIds:[initial.items[0].item.row.evidence_item_id],reason:'EXPIRED',semanticAt:T});
  const expiry='2026-09-25T12:00:01.000Z';
  const current=await call(f,'insights','create',{identity:{subject:'journal:caffeine',outcome:'recovery_score',direction:'LOWER',
    exposureCategory:'caffeine',algorithmFamily:'journal-association',evidenceContractMajor:'1'},
    claim:old.row.statement,evidenceContractVersion:'phase4-evidence-v1',supportingEvidenceIds:[initial.items[0].item.row.evidence_item_id],
    expiresAt:expiry,creationKey:'short-lived-incarnation',supersedesId:old.row.id,semanticAt:T});
  assert.equal(current.row.insight_key,old.row.insight_key);
  const at=new Date(Date.parse(expiry)+delta).toISOString();f.setNow(at);
  const result=await call(f,'intelligence','analyzeAssociationFamily',family(`expiry-${delta}`,h,at)),selected=result.items[0].insight.current;
  if(delta<0)assert.equal(selected.row.id,current.row.id);
  else {assert.notEqual(selected.row.id,current.row.id);assert.equal(selected.row.supersedes_id,current.row.id);
    assert.equal((await f.db.raw.execute({sql:'SELECT status FROM health_insights WHERE id=?',args:[current.row.id]})).rows[0].status,'RETIRED');}
  const before=await durable(f);
  assert.deepEqual(semantic(await call(f,'intelligence','analyzeAssociationFamily',req)),semantic(initial));
  assert.deepEqual(await durable(f),before);assert.equal(await leases(f),0);
});

test('M001: future-created incarnation is unavailable to a new past request; exact historical replay survives',async t=>{
  const f=await association(t,{days:30}),h=hypothesis(f,Array.from({length:30},(_,i)=>i)),future='2026-09-25T12:00:01.000Z';
  f.setNow(future);const req=family('future-incarnation',h,future),result=await call(f,'intelligence','analyzeAssociationFamily',req);
  const before=await durable(f);
  await assert.rejects(call(f,'intelligence','analyzeAssociationFamily',family('past-new',h,T)),/INSIGHT_AS_OF_UNAVAILABLE/);
  await assert.rejects(f.stores.withContext('a',{executionMode:'SHADOW'},c=>f.stores.insights.read(c,result.items[0].insight.current.row.id,{asOfUtc:T})),/INSIGHT_NOT_CURRENT/);
  assert.deepEqual(await durable(f),before);
  assert.deepEqual(semantic(await call(f,'intelligence','analyzeAssociationFamily',req)),semantic(result));assert.equal(await leases(f),0);
});

for(const reversal of [false,true])test(`M002: ${reversal?'reversal':'reopen'} predecessor lower bound, equality, bad time and exact replay`,async t=>{
  const f=await setup(t),evidence=await call(f,'intelligence','analyzeMetric',request(f.initialRefs[0],[]));
  const identity={algorithmMajor:'phase4-intelligence-v1',direction:'LOWER',domain:'recovery',metric:'recovery_score',subject:'recovery_score',windowFamily:'CHRONOLOGY'};
  const open={identity,data:{episode_type:'METRIC_DEVIATION'},evidenceItemId:evidence.item.row.evidence_item_id,semanticAt:T};
  const opened=await call(f,'episodes','open',open),id=opened.row.episode_id,base={episodeId:id,sourceRefs:[evidence.item.ref]};
  const resolvedAt='2026-09-26T12:00:00.000Z';f.setNow(resolvedAt);
  if(reversal) {
    const opposite=await call(f,'episodes','reverse',{prior:{...base,expectedRevision:1},opposite:{...open,identity:{...identity,direction:'HIGHER'}},semanticAt:resolvedAt});
    // Remove the active opposite by a valid terminal transition; the linked
    // opening below independently exercises the same predecessor contract.
    await call(f,'episodes','revise',{episodeId:opposite.row.episode_id,expectedRevision:1,sourceRefs:[evidence.item.ref],
      toState:'INVALIDATED',reasonCode:'SOURCE_INVALIDATED',semanticAt:resolvedAt});
  } else {
    await call(f,'episodes','revise',{...base,expectedRevision:1,toState:'STABILIZING',closeThresholdPassed:true,reasonCode:'CLOSE_THRESHOLD',semanticAt:T});
    await call(f,'episodes','revise',{...base,expectedRevision:2,toState:'RESOLVED',closeThresholdPassed:true,reasonCode:'RESOLUTION_HOLD',semanticAt:resolvedAt});
  }
  const linked={...open,identity:reversal?{...identity,direction:'HIGHER'}:identity,
    [reversal?'reversesEpisodeId':'reopensEpisodeId']:id,semanticAt:resolvedAt};
  let before=await durable(f);
  await assert.rejects(call(f,'episodes','open',{...linked,semanticAt:'2026-09-26T11:59:59.999Z'}),/CHRONOLOGY/);
  assert.deepEqual(await durable(f),before);
  await guards(f,'observation_episodes',()=>f.db.raw.execute({sql:'UPDATE observation_episodes SET resolved_at=? WHERE episode_id=?',args:['invalid',id]}));
  before=await durable(f);await assert.rejects(call(f,'episodes','open',linked),/SEMANTIC_TIME_INVALID/);assert.deepEqual(await durable(f),before);
  await guards(f,'observation_episodes',()=>f.db.raw.execute({sql:'UPDATE observation_episodes SET resolved_at=? WHERE episode_id=?',args:[resolvedAt,id]}));
  const exact=await call(f,'episodes','open',linked);assert.equal(exact.row.opened_at,resolvedAt);
  const after=new Date(Date.parse(resolvedAt)+1).toISOString();f.setNow(after);
  await call(f,'episodes','revise',{episodeId:exact.row.episode_id,expectedRevision:1,sourceRefs:[evidence.item.ref],
    toState:'INVALIDATED',reasonCode:'SOURCE_INVALIDATED',semanticAt:after});
  const later=await call(f,'episodes','open',{...linked,semanticAt:after});
  assert.notEqual(later.row.episode_id,exact.row.episode_id);assert.equal(later.row.opened_at,after);
  f.setNow('2026-10-10T12:00:00Z');before=await durable(f);
  assert.deepEqual(semantic(await call(f,'episodes','open',linked)),semantic(exact));assert.deepEqual(await durable(f),before);
  await assert.rejects(call(f,'episodes','open',{...linked,semanticAt:'2026-09-26T11:59:59.999Z'}),/CHRONOLOGY/);
  if(!reversal)await assert.rejects(call(f,'episodes','open',{...linked,semanticAt:'2026-10-03T12:00:00.001Z'}),/INVALID_REOPEN/);
  assert.deepEqual(await durable(f),before);assert.equal(await leases(f),0);
});
