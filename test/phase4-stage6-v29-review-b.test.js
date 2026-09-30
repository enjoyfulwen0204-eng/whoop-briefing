import test from 'node:test';
import assert from 'node:assert/strict';
import { syntheticPhase4Fixture } from './phase4Fixture.js';
import { setup as associationSetup,hypothesis,family } from './stage5AssociationFixture.js';
import { call } from './stage5ClosureFixture.js';
import { createReanalysisQueue } from '../src/phase4ReanalysisQueue.js';
import { createPhase4Stage6,authorizeStage6ShadowWorker } from '../src/phase4Reanalysis.js';
import { runPhase4Stage6 } from '../src/shadowDrainScheduler.js';
import { phase4Metric } from '../src/phase4IntelligenceRegistry.js';
const T='2026-09-25T12:00:00.000Z',N='2026-09-25T12:00:01.000Z';
const cap=()=>authorizeStage6ShadowWorker({executionMode:'SHADOW'});
const enqueue=(f,id='a')=>f.stores.captureControl(id).then(c=>f.stores.queue.sourceChanged(c));
const worker=(f,now=()=>new Date(T))=>createPhase4Stage6({db:f.db,keys:f.keys,executionMode:'SHADOW',workerCapability:cap(),now});
const job=async(f,id='a',kind='RECOMPUTE_DERIVED')=>(await f.db.raw.execute({sql:'SELECT * FROM phase4_jobs WHERE user_id=? AND job_kind=?',args:[id,kind]})).rows[0];

test('P08 CF/GitHub overlap must not claim duplicate tenant recompute through the other job kind',async t=>{
  const now=new Date('2026-09-25T09:00:00+08:00'),f=await syntheticPhase4Fixture(t,{targetVersion:29,now:()=>now});await enqueue(f);
  const q=createReanalysisQueue(f.core),c=await f.stores.capture('a',{executionMode:'SHADOW'}),l=await q.claim(c,'RECOMPUTE_DERIVED');assert.ok(l);
  const w=await worker(f,()=>now),result=await runPhase4Stage6({db:f.db,worker:w,triggerSource:'github',now});
  console.log('REVIEW_OVERLAP',JSON.stringify({held:l.binding,github:result,jobs:(await f.db.raw.execute("SELECT job_kind,state,lease_owner FROM phase4_jobs WHERE user_id='a'")).rows}));
  await q.release(c,l);await f.stores.release(c);
  assert.equal(result.claimedJobs,0,'An in-flight CF tenant pass must exclude its equivalent repair job from GitHub');
});

test('P11 privacy-deleted unrelated historical receipts must not permanently poison retained metric recomputation',async t=>{
  const f=await associationSetup(t,{days:30,targetVersion:29});await call(f,'intelligence','analyzeAssociationFamily',family('before-privacy',hypothesis(f,Array.from({length:30},(_,i)=>i))));
  if(f.context){await f.stores.release(f.context);f.context=undefined;}
  const control=await f.stores.capturePrivacyControl('a'),purge=await f.stores.privacy.admit(control,{targetType:'JOURNAL_FACT',targetId:f.logicalFacts[0],idempotencyKey:'review-delete'});
  await f.stores.privacy.redact(control,purge.purge_id);const completed=await f.stores.privacy.complete(control,purge.purge_id);assert.equal(completed.state,'COMPLETE');
  const redacted=(await f.db.raw.execute("SELECT count(*) n FROM phase4_operation_receipts WHERE content_state='REDACTED'")).rows[0].n;assert.ok(redacted>0);
  const w=await worker(f),results=[];for(let i=0;i<8&&(await w.diagnostics()).pendingJobs;i++)results.push(await w.drain({budget:{maxItemsPerTenant:32,maxItems:64,maxWallMs:90000,leaseMs:120000}}));
  console.log('REVIEW_POST_PRIVACY',JSON.stringify({purge:completed.state,redacted,results,diagnostics:await w.diagnostics()}));
  assert.equal(results.reduce((n,r)=>n+r.failedJobs,0),0,'Canonical completed deletion must permit retained, unrelated metric work');assert.equal((await w.diagnostics()).pendingJobs,0);
});

test('P17 privacy generation advance must preserve poison error and six-hour eligibility',async t=>{
  let clock=new Date(T);const f=await syntheticPhase4Fixture(t,{targetVersion:29,now:()=>clock});
  const text='caffeine at 2026-09-25T11:00:00.000Z';const created=await f.stores.journal.create(await f.stores.captureControl('a'),{sourceEventKey:'poison-private',sourceText:text,candidate:{category:'caffeine',eventAt:'2026-09-25T11:00:00.000Z',valueKind:'PRESENCE',exposureState:'EXPOSED',extractionConfidence:1,excerptStart:0,excerptEnd:text.length}});assert.equal(created.status,'ACCEPT');
  const q=createReanalysisQueue(f.core);for(let i=0;i<5;i++)await f.stores.withContext('a',{executionMode:'SHADOW'},async c=>{const l=await q.claim(c,'RECOMPUTE_DERIVED');const r=await q.release(c,l,{errorCode:'INVARIANT_VIOLATION'});if(i<4)clock=new Date(r.nextAttemptAt);});
  const before=await job(f),control=await f.stores.capturePrivacyControl('a'),p=await f.stores.privacy.admit(control,{targetType:'JOURNAL_FACT',targetId:created.logicalFactId,idempotencyKey:'delete-poison-fact'});
  await f.stores.privacy.redact(control,p.purge_id);assert.equal((await f.stores.privacy.complete(control,p.purge_id)).state,'COMPLETE');const after=await job(f);
  console.log('REVIEW_POISON_PRIVACY',JSON.stringify({before:{attempt:before.attempt,state:before.state,error:before.last_error_code,next:before.next_attempt_at,age:before.unresolved_since},after:{attempt:after.attempt,state:after.state,error:after.last_error_code,next:after.next_attempt_at,age:after.unresolved_since},eligible:await q.select()}));
  assert.equal(after.attempt,before.attempt);assert.equal(after.unresolved_since,before.unresolved_since);assert.equal(after.last_error_code,before.last_error_code);assert.equal(after.next_attempt_at,before.next_attempt_at);assert.equal(after.state,'REPAIR_REQUIRED');
  await enqueue(f);Object.assign(f,await f.restart());
  const resumed=createReanalysisQueue(f.core);
  for(const key of ['attempt','unresolved_since','last_error_code','next_attempt_at','state'])assert.equal((await job(f))[key],after[key]);
  assert.ok(!(await resumed.select()).some(row=>row.jobKind==='RECOMPUTE_DERIVED'));
  clock=new Date(after.next_attempt_at);
  const oldContext=await f.stores.capture('a',{executionMode:'SHADOW'}),oldLease=await resumed.claim(oldContext,'RECOMPUTE_DERIVED',{leaseMs:1000});assert.ok(oldLease);
  clock=new Date(clock.getTime()+1001);
  const restart=await f.restart(),takeover=createReanalysisQueue(restart.core),context=await restart.stores.capture('a',{executionMode:'SHADOW'});
  const lease=await takeover.claim(context,'RECOMPUTE_DERIVED');assert.ok(lease);
  for(const key of ['attempt','unresolved_since','last_error_code','next_attempt_at'])assert.equal((await job(f))[key],after[key]);
  await assert.rejects(resumed.release(oldContext,oldLease),{code:'PHASE4_LEASE_CAS_LOST'});
  await takeover.release(context,lease);assert.equal((await job(f)).state,'REPAIR_REQUIRED');
  await f.stores.release(oldContext);await restart.stores.release(context);
  const w=await worker(f,()=>clock);for(let i=0;i<4;i++)assert.equal((await w.drain()).failedJobs,0);
  const done=await job(f);assert.equal(done.state,'COMPLETED');assert.equal(done.attempt,0);
  for(const key of ['unresolved_since','last_error_code','next_attempt_at'])assert.equal(done[key],null);
});

test('P18 expired insight with fresh supported evidence must not stall the canonical full pass',async t=>{
  const f=await associationSetup(t,{days:30,targetVersion:29}),h=hypothesis(f,Array.from({length:30},(_,i)=>i));
  const prepared=await call(f,'intelligence','analyzeAssociationFamily',{...family('expiry-evidence',h),lifecycleMode:'EVIDENCE_ONLY'});
  const identity={subject:'journal:caffeine',outcome:'recovery_score',direction:'LOWER',exposureCategory:'caffeine',algorithmFamily:'journal-association',evidenceContractMajor:'1'};
  const prior=await call(f,'insights','create',{identity,claim:'Caffeine may be associated with lower recovery.',evidenceContractVersion:'phase4-evidence-v1',supportingEvidenceIds:[prepared.items[0].item.row.evidence_item_id],expiresAt:N,creationKey:'review-short-expiry',semanticAt:T});
  const currentTime='2026-09-25T12:00:02.000Z';f.setNow(currentTime);await enqueue(f);const w=await worker(f,()=>new Date(currentTime)),results=[];
  for(let i=0;i<12&&(await w.diagnostics()).pendingJobs;i++)results.push(await w.drain({budget:{maxItemsPerTenant:32,maxItems:64,maxWallMs:90000,leaseMs:120000}}));
  const rows=(await f.db.raw.execute("SELECT id,input_generation,status,expires_at FROM health_insights WHERE user_id='a'")).rows;
  let currentRead='OK';await f.stores.withContext('a',{executionMode:'SHADOW'},async c=>{
    try {await f.stores.insights.read(c,prior.row.id,{asOfUtc:currentTime});} catch(error) {currentRead=error.code??error.message;}
  });
  console.log('REVIEW_EXPIRED_INSIGHT',JSON.stringify({old:prior.row.id,results,rows,currentRead,diagnostics:await w.diagnostics()}));
  assert.equal(results.reduce((n,r)=>n+r.failedJobs,0),0,'Fresh evidence must take the canonical expiry/refresh path');assert.equal((await w.diagnostics()).pendingJobs,0);
  const successor=(await f.db.raw.execute({sql:'SELECT * FROM health_insights WHERE supersedes_id=?',args:[prior.row.id]})).rows;
  assert.equal(successor.length,1);assert.equal(successor[0].input_generation,16);
  assert.equal(successor[0].expires_at,new Date(Date.parse(currentTime)+phase4Metric('recovery_score').evidenceExpiryMs).toISOString());
  assert.equal(currentRead,'PHASE4_INSIGHT_NOT_CURRENT');
  assert.equal(rows.find(row=>row.id===prior.row.id).status,'RETIRED');
  await f.stores.withContext('a',{executionMode:'SHADOW'},c=>f.stores.insights.read(c,successor[0].id,{asOfUtc:currentTime}));
  Object.assign(f,await f.restart());const restarted=await worker(f,()=>new Date(currentTime));
  assert.equal((await restarted.drain()).claimedJobs,0);
  assert.equal((await f.db.raw.execute({sql:'SELECT count(*) n FROM health_insights WHERE supersedes_id=?',args:[prior.row.id]})).rows[0].n,1);
});
