// Schema-compatible algorithm convergence; native isolated transport only.
// HTTP/Hrana latency and pilot admission are separately qualified fixtures.
import test from 'node:test';import assert from 'node:assert/strict';
import {mod,fixtureKeys,residualFixture} from './stage6JournalBoundaryFixture.js';
const {createPhase4Stage6,authorizeStage6ShadowWorker}=await mod('src/phase4Reanalysis.js');
const {request,claim}=await mod('test/v32ReviewFixture.js');
const {commitPhaseWork,finalizePhaseWork}=await mod('src/phase4ExecutionStore.js');
const {withDurableExecution}=await mod('src/phase4ExecutionContext.js');
const {createExecutionBudget,withExecutionBudget}=await mod('src/executionBudget.js');
const {createOperationReceipts}=await mod('src/phase4OperationReceipts.js');
const {bodySha256}=await mod('src/briefingTriggerAuth.js');
test('six representative native isolated jobs retain exact signed full-pass completion across fresh application connections',async t=>{
 const evidence=[];
 for(let fixture=1;fixture<=3;fixture++){
  const f=await residualFixture(t),syncReq=request(),syncOwner=await claim(f.db,syncReq),authority={assert(){}};
  await commitPhaseWork(f.db,syncReq,syncOwner,{outcome:'NO_NEW_DATA_SUCCESS'},authority);
  const sync=await finalizePhaseWork(f.db,syncReq,syncOwner,fixtureKeys,authority);
  const legs=[];
  for(let leg=1;leg<=100;leg++){
   await f.fresh();const admission=await f.db.admitRuntime(),worker=await createPhase4Stage6({db:f.db,keys:fixtureKeys,admission,executionMode:'SHADOW',workerCapability:authorizeStage6ShadowWorker({executionMode:'SHADOW'})});
   const req=request({phase:'STAGE6_DRAIN',syncRequestId:syncReq.requestId,handoff:sync.handoff}),owner=await claim(f.db,req),budget=createExecutionBudget({budgetMs:90000}),a={assert:()=>budget.assert()};
   const started=performance.now();let result;
   try{
    result=await withDurableExecution({claim:owner,keys:fixtureKeys,pending:new Set(),authority:a},()=>withExecutionBudget(budget,()=>budget.run(()=>worker.drain({triggerSource:'github',userId:'a',budget:{maxJobs:1,maxItems:32,maxItemsPerTenant:32}}))));
    await commitPhaseWork(f.db,req,owner,{outcome:result.outcome,itemsProcessed:result.processedItems,jobsCompleted:result.completedJobs,jobsFailed:result.failedJobs,unitsCommitted:result.unitsCommitted},a);
    await finalizePhaseWork(f.db,req,owner,fixtureKeys,a);
   }finally{budget.close();}
   const jobs=await f.jobs(),entry={fixture,leg,ms:performance.now()-started,items:result.processedItems,units:result.unitsCommitted,completed:result.completedJobs,failed:result.failedJobs,jobs};legs.push(entry);console.log('SIX_NATIVE_LEG '+JSON.stringify(entry));
   assert.equal(result.failedJobs,0);
   assert.ok(result.processedItems>0||result.unitsCommitted>0||result.completedJobs>0,'native convergence requires actual durable work, not a timeout-only PASS');
   if(jobs.every(job=>job.completed_generation===job.requested_generation))break;
  }
  await f.fresh();const jobs=await f.jobs();assert.equal(jobs.length,2);assert.ok(jobs.every(job=>job.completed_generation===job.requested_generation&&job.full_scan_cursor===null&&job.lease_owner===null));
  const state=(await f.db.raw.execute("SELECT u.timezone,u.lifecycle_generation,coalesce(w.auth_generation,0) auth_generation,p.source_generation,p.purge_generation,c.input_generation,c.algorithm_set_version FROM users u LEFT JOIN user_whoop_tokens w ON w.user_id=u.id JOIN phase4_user_state p ON p.user_id=u.id JOIN phase4_computation_state c ON c.user_id=u.id AND c.execution_mode='SHADOW' WHERE u.id='a'")).rows[0],
   context={userId:'a',executionMode:'SHADOW',timezone:state.timezone,lifecycleGeneration:state.lifecycle_generation,authGeneration:state.auth_generation,sourceGeneration:state.source_generation,purgeGeneration:state.purge_generation,inputGeneration:state.input_generation,algorithmSetVersion:state.algorithm_set_version};
  const verifier=createOperationReceipts({client:f.db.raw,keys:fixtureKeys,schemaVersion:32}),receipts=(await f.db.raw.execute("SELECT * FROM phase4_operation_receipts WHERE user_id='a' AND execution_mode='SHADOW'")).rows;
  assert.ok(receipts.length>0,'operation receipt authentication must not be vacuous');
  for(const receipt of receipts)verifier.authenticate(context,receipt);
  const producers=(await f.db.raw.execute("SELECT p.*,e.* FROM phase4_execution_producers p JOIN phase4_executions e ON e.execution_id=p.producing_execution_id WHERE p.user_id='a' AND p.execution_mode='SHADOW'")).rows;
  assert.ok(producers.length>0,'producer authentication must not be vacuous');
  for(const e of producers){assert.equal(e.state,'FINALIZED_SUCCESS');assert.equal(bodySha256(e.result_json),e.result_digest);assert.equal(e.tenant_proof,fixtureKeys.lookup(['execution-producer-v1','a','SHADOW',e.input_generation,e.execution_id,e.execution_seq,e.producing_generation]));}
  const workReceipts=(await f.db.raw.execute("SELECT r.*,e.identity_digest,e.scope_key owner_scope,e.generation owner_generation,e.state owner_state FROM phase4_execution_work_receipts r JOIN phase4_executions e ON e.execution_id=r.execution_id WHERE e.phase='STAGE6_DRAIN'")).rows;
  assert.ok(workReceipts.length>0);for(const r of workReceipts){assert.equal(r.request_digest,r.identity_digest);assert.equal(r.scope_key,r.owner_scope);assert.ok(r.generation<=r.owner_generation);assert.equal(r.owner_state,'FINALIZED_SUCCESS');assert.equal(r.step_key,r.receipt_key);}
  const completedKinds=new Set();for(const leg of legs)for(const job of leg.jobs)if(job.completed_generation===job.requested_generation)completedKinds.add(job.job_kind);assert.equal(completedKinds.size,2);
  const duplicateRuns=(await f.db.raw.execute("SELECT deterministic_run_key,count(*) n FROM evidence_runs WHERE user_id='a' GROUP BY deterministic_run_key HAVING count(*)>1")).rows;assert.equal(duplicateRuns.length,0);
  evidence.push({fixture,transport:'native isolated file',sources:f.sourceCounts,jobs,legs:legs.length,signedReceipts:receipts.length,sealedFinalizedProducers:producers.length,validatedWorkReceipts:workReceipts.length,noDuplicateDeterministicRun:true,counts:await f.counts()});
 }
 assert.equal(evidence.flatMap(x=>x.jobs).filter(j=>j.completed_generation===j.requested_generation).length,6);
 console.log('SIX_NATIVE_COMPLETION '+JSON.stringify({synthetic:true,capturedProductionJobsCompleted:false,http115msQualified:false,production:false,evidence}));
});
