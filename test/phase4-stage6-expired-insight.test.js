import test from 'node:test';
import assert from 'node:assert/strict';
import { setup,hypothesis,family } from './stage5AssociationFixture.js';
import { call } from './stage5ClosureFixture.js';
import { guards,durable } from './stage5ReviewBFixture.js';
import { createPhase4Stage6,authorizeStage6ShadowWorker } from '../src/phase4Reanalysis.js';
import { phase4Metric } from '../src/phase4IntelligenceRegistry.js';
const T='2026-09-25T12:00:00.000Z',N='2026-09-25T12:00:01.000Z',NOW='2026-09-25T12:00:02.000Z';
const identity={subject:'journal:caffeine',outcome:'recovery_score',direction:'LOWER',
  exposureCategory:'caffeine',algorithmFamily:'journal-association',evidenceContractMajor:'1'};
const worker=f=>createPhase4Stage6({db:f.db,keys:f.keys,executionMode:'SHADOW',
  workerCapability:authorizeStage6ShadowWorker({executionMode:'SHADOW'}),now:()=>new Date(NOW)});
const job=async f=>(await f.db.raw.execute("SELECT * FROM phase4_jobs WHERE user_id='a' AND job_kind='RECOMPUTE_DERIVED'")).rows[0];
async function expired(t) {
  const f=await setup(t,{days:30,targetVersion:28});
  const h=hypothesis(f,Array.from({length:30},(_,i)=>i));
  const initial=await call(f,'intelligence','analyzeAssociationFamily',{...family('expired-original',h),lifecycleMode:'EVIDENCE_ONLY'});
  const old=await call(f,'insights','create',{identity,claim:'Caffeine may be associated with lower recovery.',
    evidenceContractVersion:'phase4-evidence-v1',supportingEvidenceIds:[initial.items[0].item.row.evidence_item_id],
    creationKey:'expired-original',expiresAt:N,semanticAt:T});
  f.setNow(NOW);await f.stores.queue.sourceChanged(await f.stores.captureControl('a'));
  return {f,h,old};
}

test('R6-04 unsupported fresh evidence yields no current insight and finishes the full pass',async t=>{
  const {f,old}=await expired(t);
  // The synthetic clock owns this fixture. A raw fixture mutation followed by
  // the canonical source invalidation keeps all semantic times at NOW.
  await f.db.raw.execute({sql:'UPDATE whoop_recoveries SET recovery_score=50,updated_at=?,synced_at=? WHERE user_id=?',args:[NOW,NOW,'a']});
  await f.stores.queue.sourceChanged(await f.stores.captureControl('a'));
  const w=await worker(f),results=[];
  for(let i=0;i<12&&(await w.diagnostics()).pendingJobs;i++)results.push(await w.drain({budget:{maxItems:64,maxItemsPerTenant:32,maxWallMs:90000,leaseMs:120000}}));
  t.diagnostic(JSON.stringify(results));
  assert.equal(results.reduce((n,r)=>n+r.failedJobs,0),0);assert.equal((await w.diagnostics()).pendingJobs,0);
  assert.equal((await f.db.raw.execute('SELECT count(*) n FROM health_insights')).rows[0].n,1);
  assert.equal((await job(f)).state,'COMPLETED');
  await assert.rejects(f.stores.withContext('a',{executionMode:'SHADOW'},c=>f.stores.insights.read(c,old.row.id,{asOfUtc:NOW})),
    /PARENT_STALE|INSIGHT_NOT_CURRENT/);
  const evidence=(await f.db.raw.execute("SELECT original_result_json FROM phase4_evidence_result_authorities WHERE result_scope='INSIGHT_CURRENT' AND input_generation>15")).rows;
  assert.ok(evidence.every(row=>row.original_result_json==='null'));
});

test('R6-04 expired parent terminal replay and concurrent equivalent successor creation converge',async t=>{
  const {f,h,old}=await expired(t);
  const fresh=await call(f,'intelligence','analyzeAssociationFamily',{...family('expired-fresh',h,NOW),lifecycleMode:'EVIDENCE_ONLY'});
  const support=fresh.items[0].item.row.evidence_item_id;
  const terminal={insightId:old.row.id,expectedRevision:old.row.current_revision,identity,refresh:true,status:'RETIRED',
    disposition:'REJECTED',claim:old.row.statement,supportingEvidenceIds:[support],reason:'REJECTED',semanticAt:NOW};
  const retired=await call(f,'insights','transition',terminal);
  assert.deepEqual(await call(f,'insights','transition',terminal),retired);
  const creation={identity,claim:old.row.statement,evidenceContractVersion:'phase4-evidence-v1',supportingEvidenceIds:[support],
    creationKey:'expired-successor',expiresAt:new Date(Date.parse(NOW)+phase4Metric('recovery_score').evidenceExpiryMs).toISOString(),
    semanticAt:NOW};
  const created=await Promise.all([call(f,'insights','create',creation),call(f,'insights','create',creation)]);
  assert.equal(created[0].row.id,created[1].row.id);assert.equal(created[0].row.supersedes_id,old.row.id);
  assert.equal((await f.db.raw.execute('SELECT count(*) n FROM health_insights')).rows[0].n,2);
  await f.stores.withContext('a',{executionMode:'SHADOW'},c=>f.stores.insights.read(c,created[0].row.id,{asOfUtc:NOW}));
  assert.equal((await call(f,'insights','create',creation)).row.id,created[0].row.id);
  Object.assign(f,await f.restart());f.context=undefined;
  assert.equal((await call(f,'insights','create',creation)).row.id,created[0].row.id);
  assert.equal((await f.db.raw.execute('SELECT count(*) n FROM health_insights')).rows[0].n,2);
});

test('R6-04 expired predecessor still rejects wrong-family evidence and corrupt receipt',async t=>{
  const {f,h,old}=await expired(t);
  const wrong=await call(f,'intelligence','analyzeAssociationFamily',{...family('wrong-family',{...h,outcomeMetric:'rhr'},NOW),lifecycleMode:'EVIDENCE_ONLY'});
  const request={insightId:old.row.id,expectedRevision:old.row.current_revision,identity,refresh:true,status:'RETIRED',
    disposition:'REJECTED',claim:old.row.statement,supportingEvidenceIds:[wrong.items[0].item.row.evidence_item_id],
    reason:'REJECTED',semanticAt:NOW};
  const before=await durable(f);
  await assert.rejects(call(f,'insights','transition',request),/REFRESH_EVIDENCE_IDENTITY/);
  assert.deepEqual(await durable(f),before);
  const fresh=await call(f,'intelligence','analyzeAssociationFamily',{...family('right-family',h,NOW),lifecycleMode:'EVIDENCE_ONLY'});
  const receipt=(await f.db.raw.execute("SELECT * FROM phase4_operation_receipts WHERE operation_kind='INSIGHT_CREATE'")).rows[0];
  await guards(f,'phase4_operation_receipts',()=>f.db.raw.execute({sql:'UPDATE phase4_operation_receipts SET receipt_hmac=? WHERE operation_key=?',
    args:['0'.repeat(64),receipt.operation_key]}));
  const tampered=await durable(f);
  await assert.rejects(call(f,'insights','transition',{...request,supportingEvidenceIds:[fresh.items[0].item.row.evidence_item_id]}),
    /RECEIPT_INTEGRITY/);
  assert.deepEqual(await durable(f),tampered);
});
