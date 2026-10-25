import test from 'node:test';
import assert from 'node:assert/strict';
import {STAGE8_LIVE_DRAIN_BUDGET} from '../src/stage8LiveDrainPolicy.js';
import {stage6Budget,STAGE6_BUDGETS} from '../src/phase4DrainPolicy.js';
import {syntheticPhase4Fixture} from './phase4Fixture.js';
import {authorizeStage8LiveProducer} from '../src/stage8LiveProducerAuthority.js';
import {buildPhase4Core} from '../src/phase4Core.js';
import {createPhase4Stage6} from '../src/phase4Reanalysis.js';
import {createStage8LiveExecutionRunner} from '../src/stage8LiveExecution.js';
import {createExecutionBudget,withExecutionBudget} from '../src/executionBudget.js';

test('selected LIVE-only override preserves every default time, lease, global and SHADOW limit',()=>{
 assert.deepEqual(STAGE8_LIVE_DRAIN_BUDGET,{maxItemsPerTenant:12});assert.equal(Object.isFrozen(STAGE8_LIVE_DRAIN_BUDGET),true);
 const original=stage6Budget('manual'),selected=stage6Budget('manual',STAGE8_LIVE_DRAIN_BUDGET);
 assert.equal(original.maxItemsPerTenant,6);assert.deepEqual({...selected,maxItemsPerTenant:6},original);
 assert.deepEqual(original,{maxWallMs:45000,safetyMarginMs:15000,maxJobs:8,maxItems:48,maxItemsPerTenant:6,leaseMs:60000});
 assert.equal(STAGE6_BUDGETS.cloudflare.maxItemsPerTenant,6);assert.equal(STAGE6_BUDGETS.github.maxItemsPerTenant,8);assert.equal(STAGE6_BUDGETS.event.maxItemsPerTenant,4);
 assert.throws(()=>{STAGE8_LIVE_DRAIN_BUDGET.maxItemsPerTenant=33;},TypeError);
 for(const invalid of [{maxItemsPerTenant:33},{maxItemsPerTenant:0},{attempt:0},{quota:100},{leaseMs:1},{safetyMarginMs:0}])assert.throws(()=>stage6Budget('manual',invalid),/PHASE4_DRAIN_BUDGET_INVALID/);
});
async function kernel(t){
 const f=await syntheticPhase4Fixture(t,{targetVersion:35,ownedConnection:true,now:()=>new Date()});
 await f.db.saveTokens('a',{accessToken:'SYNTHETIC_NOT_A_TOKEN',refreshToken:'SYNTHETIC_NOT_A_TOKEN',expiresAt:'2099-01-01T00:00:00.000Z',scope:''});await f.db.ensureOnboarding('a',{state:'READY'});
 const admission=await f.db.admitRuntime(),capability=await authorizeStage8LiveProducer({...f,admission,releaseSha:'a'.repeat(40),configProof:'b'.repeat(64),enabled:()=>true,eligible:id=>id==='a'});
 const core=await buildPhase4Core({keys:f.keys,admission,liveProducingAuthority:capability,processing:{client:f.db.raw,transaction:f.db.transaction,active:f.db.processingTransactionActive,afterCommit:f.db.afterProcessingCommit,afterCompletion:f.db.afterProcessingCompletion},authorizeMode(mode,_client,id){assert.equal(mode,'LIVE');assert.equal(id,'a');}});
 await core.initializeTenant('a','LIVE');let clock=0;
 const worker=await createPhase4Stage6({...f,admission,executionMode:'LIVE',liveProducingAuthority:capability,monotonicNow:()=>clock});await worker.rolloutAlgorithm({userId:'a'});
 const jobs=async()=>(await f.db.raw.execute("SELECT * FROM phase4_jobs WHERE user_id='a' AND execution_mode='LIVE' ORDER BY job_kind")).rows;
 const run=(request,stopAt)=>createStage8LiveExecutionRunner({...f,capability,capture:id=>core.capture(id,{executionMode:'LIVE',providerRequired:true}),assertContext:ctx=>core.assertContext(ctx),work:async()=>{
  const v=await worker.drain({userId:'a',budget:STAGE8_LIVE_DRAIN_BUDGET,onProgress:async e=>{if(e.event==='drain_start')clock=stopAt;}});
  return {outcome:v.outcome,itemsProcessed:v.processedItems,jobsCompleted:v.completedJobs,jobsFailed:v.failedJobs,remainingJobs:v.remainingJobs,unitsCommitted:v.unitsCommitted};
 }})(request);
 return {...f,jobs,run};
}
for(const parentMs of [null,20000])test(`LIVE12 stops before claim at productive boundary without advancing jobs${parentMs?' under a shorter parent':''}`,async t=>{
 const f=await kernel(t),before=await f.jobs(),request={userId:'a',requestId:`live12-clock-boundary-${parentMs??45000}`};
 let result,parent;
 try{
  if(parentMs){parent=createExecutionBudget({budgetMs:parentMs,nowMs:()=>0});result=await withExecutionBudget(parent,()=>f.run(request,5000));}
  else result=await f.run(request,30000);
 }finally{parent?.cancel();parent?.close();}
 assert.equal(result.result.outcome,'BUDGET_EXHAUSTED');assert.equal(result.result.itemsProcessed,0);assert.equal(result.result.unitsCommitted,0);assert.equal(result.result.jobsCompleted,0);assert.equal(result.result.jobsFailed,0);
 assert.deepEqual(await f.jobs(),before);assert.equal((await f.db.raw.execute('SELECT count(*) n FROM stage8_live_job_completions')).rows[0].n,0);
});
test('a cancelled parent never admits new LIVE12 work or changes original job identities',async t=>{
 const f=await kernel(t),before=await f.jobs(),parent=createExecutionBudget({budgetMs:60000});parent.cancel();
 try{await assert.rejects(withExecutionBudget(parent,()=>f.run({userId:'a',requestId:'live12-already-cancelled'},0)),/SYNC_CANCELLED/);}finally{parent.close();}
 assert.deepEqual(await f.jobs(),before);assert.equal((await f.db.raw.execute('SELECT count(*) n FROM stage8_live_executions')).rows[0].n,0);
});
