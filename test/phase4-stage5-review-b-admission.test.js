import test from 'node:test';
import assert from 'node:assert/strict';
import { setup,request } from './stage5HistoryFixture.js';
import { setup as association,hypothesis,family } from './stage5AssociationFixture.js';
import { call,read } from './stage5ClosureFixture.js';
import { guards,durable,semantic,leases,T } from './stage5ReviewBFixture.js';

const child=item=>({identity:{subject:'direct',outcome:'recovery_score',direction:'LOWER',exposureCategory:'caffeine',
  algorithmFamily:'JOURNAL_ASSOCIATION',evidenceContractMajor:'phase4-evidence-v1'},claim:'A direct child',
  evidenceContractVersion:'phase4-evidence-v1',supportingEvidenceIds:[item],creationKey:'admission',semanticAt:T,expiresAt:'2026-10-01T12:00:00Z'});
for(const fault of ['missing-v26','run-count','run-timezone','missing-root','missing-v27'])
  test(`H002: direct child rejects ${fault} parent with zero durable writes`,async t=>{
    const f=await setup(t),result=await call(f,'intelligence','analyzeMetric',request(f.initialRefs[0],[]));
    if(fault==='missing-v26')await guards(f,'phase4_evidence_result_authorities',()=>f.db.raw.execute('DELETE FROM phase4_evidence_result_authorities'));
    if(fault==='missing-v27')await guards(f,'phase4_operation_receipts',()=>f.db.raw.execute('DELETE FROM phase4_operation_receipts'));
    if(fault==='run-count')await guards(f,'evidence_runs',()=>f.db.raw.execute('UPDATE evidence_runs SET sample_count=999'));
    if(fault==='run-timezone')await guards(f,'evidence_runs',()=>f.db.raw.execute("UPDATE evidence_runs SET timezone='UTC'"));
    if(fault==='missing-root')await f.db.raw.execute({sql:'DELETE FROM whoop_recoveries WHERE sleep_id=?',args:[f.recoveryIds[0]]});
    const before=await durable(f);
    await assert.rejects(read(f,'evidence_items',{evidence_item_id:result.item.row.evidence_item_id}));
    await assert.rejects(call(f,'insights','create',child(result.item.row.evidence_item_id)),/UNAVAILABLE|INTEGRITY|AUTHORITY|SOURCE_NOT_FOUND/);
    assert.deepEqual(await durable(f),before);assert.equal(await leases(f),0);
  });

test('H002: same-transaction producer, create, promotion and exact retry retain one logical result',async t=>{
  const f=await association(t,{days:30}),req=family('producer-child',hypothesis(f,Array.from({length:30},(_,i)=>i)));
  const result=await call(f,'intelligence','analyzeAssociationFamily',req);
  assert.equal(result.items[0].insight.current.row.status,'EMERGING');
  const before=await durable(f),replay=await call(f,'intelligence','analyzeAssociationFamily',req);
  assert.deepEqual(semantic(replay),semantic(result));assert.deepEqual(await durable(f),before);
  assert.equal(before.evidence_runs.length,1);assert.equal(before.evidence_items.length,1);
  assert.equal(before.health_insights.length,1);assert.equal(before.insight_revisions.length,2);
  assert.equal(before.phase4_operation_receipts.length,3);assert.equal(await leases(f),0);
});

test('H002: failure to seal producer authority rolls back admitted children',async t=>{
  const f=await association(t,{days:30}),req=family('producer-failure',hypothesis(f,Array.from({length:30},(_,i)=>i)));
  await f.db.raw.execute("CREATE TRIGGER review_b_drop_authority BEFORE INSERT ON phase4_evidence_result_authorities BEGIN SELECT RAISE(IGNORE); END");
  const before=await durable(f);
  await assert.rejects(call(f,'intelligence','analyzeAssociationFamily',req),/AUTHORITY|UNAVAILABLE/);
  assert.deepEqual(await durable(f),before);assert.equal(await leases(f),0);
});
