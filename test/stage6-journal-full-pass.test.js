import test from 'node:test';import assert from 'node:assert/strict';
import {mod,fixtureKeys,residualFixture} from './stage6JournalBoundaryFixture.js';
const {createPhase4Stage6,authorizeStage6ShadowWorker}=await mod('src/phase4Reanalysis.js');
const {request,claim}=await mod('test/v32ReviewFixture.js');
const {commitPhaseWork,finalizePhaseWork}=await mod('src/phase4ExecutionStore.js');
const {withDurableExecution}=await mod('src/phase4ExecutionContext.js');
const {createExecutionBudget,withExecutionBudget}=await mod('src/executionBudget.js');
test('v32 repaired two residual jobs reach actual full-pass completion at original six-item tenant bound over144 synthetic roots',async t=>{
 const f=await residualFixture(t);let drains=0,items=0,previous=new Map(),completed=0,lastRequest;
 const syncReq=request(),syncOwner=await claim(f.db,syncReq),setupAuthority={assert(){}};
 await commitPhaseWork(f.db,syncReq,syncOwner,{outcome:'NO_NEW_DATA_SUCCESS',durationMs:0},setupAuthority);
 const sync=await finalizePhaseWork(f.db,syncReq,syncOwner,fixtureKeys,setupAuthority);
 for(;drains<100;drains++){
  await f.fresh();const admission=await f.db.admitRuntime();
  const worker=await createPhase4Stage6({db:f.db,keys:fixtureKeys,admission,executionMode:'SHADOW',workerCapability:authorizeStage6ShadowWorker({executionMode:'SHADOW'})});
  const req=request({phase:'STAGE6_DRAIN',syncRequestId:syncReq.requestId,handoff:sync.handoff}),owner=await claim(f.db,req),budget=createExecutionBudget({budgetMs:45000});
  lastRequest=req;
  const authority={assert:()=>budget.assert()},execution={claim:owner,keys:fixtureKeys,pending:new Set(),authority,presentationClock:()=>new Date()};let result;
  try{result=await withDurableExecution(execution,()=>withExecutionBudget(budget,()=>budget.run(()=>worker.drain({triggerSource:'manual',userId:'a'}))));
   await commitPhaseWork(f.db,req,owner,{outcome:result.outcome,durationMs:result.elapsedMs,jobsCompleted:result.completedJobs,itemsProcessed:result.processedItems,completion:result.completion,remainingJobs:result.remainingJobs},authority);
   const settled=await finalizePhaseWork(f.db,req,owner,fixtureKeys,authority);assert.equal(settled.settlementState,'FINALIZED_SUCCESS');
  }finally{budget.close();}
  const jobs=await f.jobs();items+=result.processedItems;completed+=result.completedJobs;
  console.log('RESIDUAL_FULL_PASS '+JSON.stringify({drain:drains+1,outcome:result.outcome,items:result.processedItems,units:result.unitsCommitted,completed:result.completedJobs,failed:result.failedJobs,failures:result.failures,remaining:result.remainingJobs,cursors:jobs.map(j=>({kind:j.job_kind,state:j.state,cursorType:j.full_scan_cursor?JSON.parse(j.full_scan_cursor)[0]:null,attempt:j.attempt}))}));
  assert.equal(result.failedJobs,0);assert.ok(result.processedItems<=6);
  for(const j of jobs){assert.equal(j.attempt,0);if(j.claimed_generation!==null)assert.equal(j.requested_generation,j.claimed_generation);if(j.full_scan_cursor&&previous.get(j.job_kind))assert.ok(j.full_scan_cursor>=previous.get(j.job_kind));if(j.full_scan_cursor)previous.set(j.job_kind,j.full_scan_cursor);}
  if(result.remainingJobs===0){drains++;break;}
 }
 const jobs=await f.jobs(),counts=await f.counts();assert.equal(completed,2);assert.equal(items,288);
 for(const j of jobs){assert.equal(j.state,'COMPLETED');assert.equal(j.completed_generation,j.requested_generation);assert.equal(j.full_scan_cursor,null);}
 const c=(await f.db.raw.execute("SELECT input_generation,last_completed_generation FROM phase4_computation_state WHERE user_id='a' AND execution_mode='SHADOW'")).rows[0];assert.equal(c.input_generation,c.last_completed_generation);assert.ok(counts.body>0);assert.ok(counts.domain>0);
 const executions=[...(await f.db.raw.execute("SELECT * FROM phase4_executions WHERE phase='STAGE6_DRAIN'")).rows];
 const {bodySha256}=await mod('src/briefingTriggerAuth.js');
 for(const job of jobs){
  const step=fixtureKeys.lookup(['phase4-logical-work-v1','stage6.complete',['a',job.job_kind,job.requested_generation,job.scope_revision,JSON.stringify(['workout','synthetic-workout-32'])]]);let found=false;
  for(const e of executions){
   const key=fixtureKeys.lookup(['execution-work-step-v2',e.identity_digest,e.scope_key,['named',step]]);
   const ack=(await f.db.raw.execute({sql:'SELECT * FROM phase4_execution_work_receipts WHERE execution_id=? AND receipt_key=?',args:[e.execution_id,key]})).rows[0];if(!ack)continue;
   assert.equal(e.state,'FINALIZED_SUCCESS');assert.equal(bodySha256(e.result_json),e.result_digest);assert.equal(ack.generation,e.generation);assert.equal(ack.request_digest,e.identity_digest);assert.equal(ack.scope_key,e.scope_key);assert.equal(ack.step_key,key);
   const producer=(await f.db.raw.execute({sql:"SELECT * FROM phase4_execution_producers WHERE producing_execution_id=? AND user_id='a' AND execution_mode='SHADOW'",args:[e.execution_id]})).rows[0];assert.ok(producer);
   assert.equal(producer.tenant_proof,fixtureKeys.lookup(['execution-producer-v1','a','SHADOW',job.requested_generation,e.execution_id,e.execution_seq,e.generation]));
   assert.ok(ack.committed_at<=e.finalized_at&&e.finalized_at<=e.deadline_at);found=true;
  }assert.ok(found,'authentic full-pass completion ACK for '+job.job_kind);
 }
 await f.fresh();assert.deepEqual(await f.jobs(),jobs);
 const replay=await claim(f.db,lastRequest);assert.equal(replay.cached.settlementState,'FINALIZED_SUCCESS');assert.equal(replay.cached.completion,'COMPLETE');
 assert.deepEqual(await f.jobs(),jobs);assert.deepEqual(await f.counts(),counts);
 console.log('RESIDUAL_COMPLETE_LOCAL_ONLY '+JSON.stringify({drains,items,completed,counts,sourceCounts:f.sourceCounts,production:false,fileOnly:true,managedPhaseOrRemoteCapacityProof:false}));
});
