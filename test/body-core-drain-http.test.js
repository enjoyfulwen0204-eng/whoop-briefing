import test from 'node:test';
import assert from 'node:assert/strict';
import {fixtureKeys} from './localDb.js';
import {createOwnedDb} from './stage5OwnedDb.js';
import {createDb} from '../src/db.js';
import {hranaTransport} from './hranaTransport.js';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {bodyInput,seedBodyInput} from './bodyEnergyFixture.js';
import {bodyHealthDate} from '../src/bodyEnergyInputs.js';
import {createPhase4Foundation} from '../src/phase4Foundation.js';
import {createPublicBetaRuntime,authorizePublicBetaRuntime} from '../src/publicBeta.js';
import {runExecutionPhase} from '../src/phase4Execution.js';
import {configurationProof} from '../src/phase4ExecutionStore.js';
import {publicBetaConfiguration} from '../src/publicBetaConfig.js';
import {runningReleaseSha} from '../src/phase4Release.js';
import {OWNER_PILOT_APPROVAL_SHA256} from '../src/betaPilotAllowance.js';
import {requireCurrentBetaPilotAttempt} from '../src/betaPilotPermit.js';
import {randomUUID} from 'node:crypto';

const latencyMs=Number(process.env.BODY_CORE_HTTP_LATENCY_MS??0);
assert.ok(Number.isSafeInteger(latencyMs)&&latencyMs>=0&&latencyMs<=150);
const cancellation=process.env.BODY_CORE_CANCEL_ON_SOURCE==='1',controller=new AbortController();
const requireDurableBody=process.env.BODY_CORE_REQUIRE_DURABLE_BODY==='1',continueDrain=process.env.BODY_CORE_CONTINUE_DRAIN==='1';
const metricContinuation=process.env.BODY_CORE_METRIC_CONTINUATION==='1';
const diagnosticSafetyMs=Number(process.env.BODY_CORE_DIAGNOSTIC_SAFETY_MS??15000);
assert.ok([12000,15000].includes(diagnosticSafetyMs));
const cancelAfterBody=process.env.BODY_CORE_CANCEL_AFTER_BODY==='1',loseBodyAck=process.env.BODY_CORE_LOSE_BODY_ACK==='1';
assert.ok(!(cancelAfterBody&&loseBodyAck));
const triggerSource=process.env.BODY_CORE_TRIGGER_SOURCE??'manual';
assert.ok(['manual','github'].includes(triggerSource));
const baselineDays=Number(process.env.BODY_CORE_BASELINE_DAYS??30);
assert.ok([7,30].includes(baselineDays));
const copy=value=>structuredClone(value);
const delta=(after,before)=>({httpRequests:after.httpRequests-before.httpRequests,sqlStatements:after.sqlStatements-before.sqlStatements,
 ...Object.fromEntries(['byFamily','byHttpMix','byHttpFamily'].map(kind=>[kind,Object.fromEntries(Object.entries(after[kind]).map(([key,value])=>[key,value-(before[kind]?.[key]??0)]))]))});

test('actual admitted v32 DRAIN claims and checkpoints one original Body job unit over physical Hrana',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'body-core-http-')),url=`file:${join(dir,'db.sqlite')}`,seed=createOwnedDb({url});
 await seed.migrate({targetVersion:32});assert.equal((await seed.raw.execute('PRAGMA journal_mode=WAL')).rows[0].journal_mode,'wal');seed.close();
 const transport=hranaTransport(url);let activeLatency=0,workerEntered=false,canonicalAtStart=Infinity;
 const db=createDb({url:'https://isolated.invalid',phase4Keys:fixtureKeys,fetch:async request=>{
  if(activeLatency)await new Promise(resolve=>setTimeout(resolve,activeLatency));
  const response=await transport.fetch(request);
  if(cancellation&&workerEntered&&(transport.counts.byFamily.CANONICAL??0)>canonicalAtStart)controller.abort();
  return response;
 }}),timed=db;
 t.after(async()=>{await new Promise(resolve=>setImmediate(resolve));timed.close();transport.close();await rm(dir,{recursive:true,force:true});});
 await db.createUser({id:'a',displayName:'Synthetic',timezone:'Asia/Taipei',status:'ACTIVE'});
 await db.ensureOnboarding('a',{state:'READY'});
 const admission=await timed.admitRuntime(),stores=await createPhase4Foundation({db:timed,keys:fixtureKeys,admission});
 await stores.initializeTenant('a','SHADOW');
 const input=bodyInput({asOf:Date.now()-1000,days:baselineDays});
 for(const sleep of input.sources.sleep){sleep.health_date=bodyHealthDate(Date.parse(sleep.end_at),input.timezone);
  input.sources.recovery.find(row=>row.sleep_id===sleep.id).health_date=sleep.health_date;}
 await timed.transaction(()=>seedBodyInput(timed,input));
 await stores.queue.sourceChanged(await stores.captureControl('a'));
 const environment={PHASE4_BETA_SHADOW_RUNTIME:'on',PHASE4_PUBLIC_BETA_MODE:'off',
  PHASE4_BETA_PILOT_ID:'a'.repeat(64),PHASE4_BETA_PILOT_USER_ID:'a',PHASE4_BETA_PILOT_START_AT:new Date(Date.now()-1000).toISOString(),
  PHASE4_BETA_PILOT_CONSENT_SHA256:'b'.repeat(64),PHASE4_BETA_PILOT_ALLOWANCE_ID:OWNER_PILOT_APPROVAL_SHA256};
 const makeRequest=extra=>({releaseSha:runningReleaseSha(),requestId:randomUUID(),phase:'SYNC',triggerSource,executionMode:'SHADOW',
  configProof:configurationProof(fixtureKeys,publicBetaConfiguration(environment),environment),...extra});
 const options={db:timed,keys:fixtureKeys,environment,env:{timezone:'Asia/Taipei',dryRun:true,maxUserConcurrency:1},deps:{runBriefing:async()=>({syncComplete:true,syncOutcome:'NO_NEW_DATA_SUCCESS'})}};
 const syncRequest=makeRequest(),sync=await runExecutionPhase({...options,request:syncRequest});
 assert.equal(sync.body.syncComplete,true);
 const initialJob=(await timed.raw.execute("SELECT * FROM phase4_jobs WHERE user_id='a' ORDER BY updated_at,user_id,job_kind LIMIT 1")).rows[0];
 const initialComputation=(await timed.raw.execute("SELECT * FROM phase4_computation_state WHERE user_id='a' AND execution_mode='SHADOW'")).rows[0];
 let actualWorkerCalls=0,workerStartedAt=null,bodyCommittedAt=null,bodyCommitCounts=null;
 options.deps.runtime={phase4Stage6:{drain:async args=>{
  actualWorkerCalls++;workerEntered=true;workerStartedAt=performance.now();
  const pilotGrant=requireCurrentBetaPilotAttempt('a',timed.raw);
  const runtime=await createPublicBetaRuntime({db:timed,keys:fixtureKeys,admission,executionMode:'SHADOW',pilotGrant,
   runtimeCapability:authorizePublicBetaRuntime({executionMode:'SHADOW'})});
  const drained=await runtime.phase4Stage6.drain({...args,budget:{maxJobs:1,maxItems:1,maxItemsPerTenant:1,
   ...(diagnosticSafetyMs===12000?{maxWallMs:45000,safetyMarginMs:12000}:{})}});
  console.log('BODY_CORE_WORKER_RESULT '+JSON.stringify(drained));return drained;
 }}};
 const request=makeRequest({phase:'STAGE6_DRAIN',syncRequestId:syncRequest.requestId,handoff:sync.body.handoff});
 activeLatency=latencyMs;canonicalAtStart=transport.counts.byFamily.CANONICAL??0;const before=copy(transport.counts),started=performance.now();
 transport.arm({matchSql:/INSERT INTO body_energy_results\(/,loseAcknowledgement:loseBodyAck,after:()=>{
  bodyCommittedAt=performance.now();bodyCommitCounts=copy(transport.counts);if(cancelAfterBody)controller.abort();
 }});
 const result=await runExecutionPhase({...options,request,...(cancellation||cancelAfterBody?{signal:controller.signal}:{})});
 const topTemplates=Object.entries(transport.counts.byTemplate).map(([hash,item])=>({hash,family:item.family,count:item.count-(before.byTemplate[hash]?.count??0)}))
  .filter(item=>item.count>0).sort((a,b)=>b.count-a.count).slice(0,12);
 const measurement={topTemplates,triggerSource,baselineDays,latencyPerRequestMs:latencyMs,parentCancellation:cancellation||cancelAfterBody,
  diagnosticSafetyMs,extraProductiveMs:15000-diagnosticSafetyMs,productionDefaultsChanged:false,
  elapsedMs:performance.now()-started,workerAdmissionMs:workerStartedAt===null?null:workerStartedAt-started,
  durableBodyAtMs:bodyCommittedAt===null?null:bodyCommittedAt-started,
  ...(bodyCommitCounts?{throughBodyCommit:delta(bodyCommitCounts,before)}:{}),
  ...delta(transport.counts,before),status:result.status,result:result.body.result};
 activeLatency=0;
 console.log('BODY_CORE_ADMITTED_DRAIN_HTTP '+JSON.stringify(measurement));
 assert.equal(actualWorkerCalls,1);
 const rows=(await timed.raw.execute("SELECT * FROM body_energy_results WHERE user_id='a'")).rows;
 const jobs=(await timed.raw.execute("SELECT job_kind,full_scan_cursor,completed_generation,requested_generation,state FROM phase4_jobs WHERE user_id='a' ORDER BY job_kind")).rows;
 const work=(await timed.raw.execute({sql:'SELECT * FROM phase4_execution_work_receipts WHERE execution_id=?',args:[request.requestId]})).rows;
 const execution=(await timed.raw.execute({sql:'SELECT * FROM phase4_executions WHERE execution_id=?',args:[request.requestId]})).rows[0];
 const domain=(await timed.raw.execute("SELECT * FROM phase4_operation_receipts WHERE user_id='a' AND operation_kind='BODY_ENERGY_COMPUTE'")).rows;
 const producers=(await timed.raw.execute({sql:'SELECT * FROM phase4_execution_producers WHERE producing_execution_id=?',args:[request.requestId]})).rows;
 let sourceWorkReceipt=false,producerBindingValid=false;
 if(rows.length){
  const step=fixtureKeys.lookup(['phase4-logical-work-v1','stage6.body-source',['a','SHADOW',initialJob.job_kind,
   initialJob.requested_generation,initialJob.scope_revision,['USER','a',JSON.stringify(['USER','a']),initialComputation.updated_at]]]);
  const expected=fixtureKeys.lookup(['execution-work-step-v2',execution.identity_digest,execution.scope_key,['named',step]]);
  sourceWorkReceipt=work.some(row=>row.step_key===expected&&row.receipt_key===expected&&row.request_digest===execution.identity_digest
   &&row.scope_key===execution.scope_key&&row.generation<=execution.generation);
  producerBindingValid=producers.length===1&&producers.every(p=>p.user_id==='a'&&p.execution_mode==='SHADOW'&&p.input_generation===rows[0].input_generation
   &&p.execution_seq===execution.execution_seq&&p.producing_generation<=execution.generation
   &&p.tenant_proof===fixtureKeys.lookup(['execution-producer-v1','a','SHADOW',p.input_generation,request.requestId,p.execution_seq,p.producing_generation]));
  await stores.withContext('a',{executionMode:'SHADOW',providerRequired:true},async context=>{
   const verified=await stores.readArtifact(context,'body_energy_results',{result_id:rows[0].result_id});
   assert.equal(verified.row.result_hash,rows[0].result_hash);
  });
 }
 const publication=await stores.withContext('a',{executionMode:'SHADOW',providerRequired:true},context=>stores.bodyEnergy.readForPublication(context,
  {healthDate:bodyHealthDate(Date.now(),'Asia/Taipei'),asOfEpochMs:Date.now()}));
 assert.equal(publication.status,'PROCESSING');assert.equal(Object.hasOwn(publication,'value'),false);
 console.log('BODY_CORE_ADMITTED_DRAIN_DURABLE '+JSON.stringify({publicationState:publication.status,bodyRows:rows.length,qualityStates:rows.map(row=>row.quality_state),
  checkpointedJobs:jobs.filter(row=>row.full_scan_cursor!==null).length,completeJobs:jobs.filter(row=>row.completed_generation===row.requested_generation).length,
  remainingJobs:jobs.filter(row=>row.completed_generation<row.requested_generation).length,workReceiptCount:work.length,
  domainBodyReceiptCount:domain.length,sourceWorkReceipt,producerBindingValid,
  declaration:'SYNTHETIC_ADMITTED_PHYSICAL_HRANA_UNIT_NOT_PRODUCTION_COST_CAPACITY_OR_PUBLICATION'}));
 if(result.body.result.outcome==='PARTIAL'){
  const subunit=result.body.result.unitsCommitted===1;
  assert.equal(result.body.result.itemsProcessed,subunit?0:1);assert.equal(result.body.result.jobsCompleted,0);assert.equal(result.body.result.completion,'PARTIAL');
  assert.equal(result.body.result.settlementState,'FINALIZED_SUCCESS');assert.equal(result.body.result.remainingJobs,2);
  assert.equal(rows.length,1);assert.equal(rows[0].quality_state,baselineDays===30?'AVAILABLE':'LIMITED');assert.ok(Number.isFinite(rows[0].value));
  assert.equal(jobs.filter(row=>row.full_scan_cursor!==null).length,subunit?0:1);assert.equal(jobs.filter(row=>row.completed_generation===row.requested_generation).length,0);
  assert.ok(work.length>=3);assert.ok(measurement.elapsedMs<45000);
 } else {
  assert.ok(['TIMEOUT','CANCELLED','COMMIT_INDETERMINATE','BUDGET_EXHAUSTED'].includes(result.body.result.outcome),JSON.stringify(result));
  assert.equal(result.body.result.completion,'PARTIAL');assert.notEqual(result.body.drainAuthorized,true);
  assert.equal(jobs.filter(row=>row.completed_generation===row.requested_generation).length,0);
  assert.ok(measurement.elapsedMs<52000,'original45s work plus bounded cleanup');
  if(cancellation)assert.equal(result.body.result.outcome,'CANCELLED');
  // Cancellation after the server makes COMMIT durable and before the client
  // acknowledges it must retain the original uncertain-commit contract.
  if(cancelAfterBody)assert.equal(result.body.result.outcome,'COMMIT_INDETERMINATE');
  if(loseBodyAck)assert.equal(result.body.result.outcome,'COMMIT_INDETERMINATE');
 }
 if(requireDurableBody){
  assert.equal(baselineDays,30);assert.equal(rows.length,1);assert.equal(rows[0].quality_state,'AVAILABLE');
  assert.equal(domain.length,1);assert.equal(sourceWorkReceipt,true);assert.equal(producerBindingValid,true);
  assert.ok(bodyCommittedAt!==null&&bodyCommittedAt-started<45000);
  assert.ok(measurement.elapsedMs<45000,'supported physical 45-second phase including settlement');
  assert.ok(['PARTIAL','BUDGET_EXHAUSTED','CANCELLED','COMMIT_INDETERMINATE'].includes(result.body.result.outcome));
 }
 if(continueDrain){
  assert.equal(requireDurableBody,true);assert.equal(result.body.result.outcome,'BUDGET_EXHAUSTED');
  const next=makeRequest({phase:'STAGE6_DRAIN',syncRequestId:syncRequest.requestId,handoff:sync.body.handoff});
  const beforeNext=copy(transport.counts),nextStarted=performance.now();activeLatency=latencyMs;
  const resumed=await runExecutionPhase({...options,request:next});
  const nextMeasurement={elapsedMs:performance.now()-nextStarted,...delta(transport.counts,beforeNext),status:resumed.status,result:resumed.body.result};
  activeLatency=0;
  const afterRows=(await timed.raw.execute("SELECT * FROM body_energy_results WHERE user_id='a'")).rows;
  const afterDomain=(await timed.raw.execute("SELECT * FROM phase4_operation_receipts WHERE user_id='a' AND operation_kind='BODY_ENERGY_COMPUTE'")).rows;
  const afterJobs=(await timed.raw.execute("SELECT * FROM phase4_jobs WHERE user_id='a' ORDER BY job_kind")).rows;
  console.log('BODY_CORE_CONTINUATION_HTTP '+JSON.stringify(nextMeasurement));
  console.log('BODY_CORE_CONTINUATION_DURABLE '+JSON.stringify({bodyRows:afterRows.length,domainBodyReceiptCount:afterDomain.length,
   checkpointedJobs:afterJobs.filter(row=>row.full_scan_cursor!==null).length,remainingJobs:afterJobs.filter(row=>row.completed_generation<row.requested_generation).length}));
  assert.equal(actualWorkerCalls,2);assert.deepEqual(afterRows,rows);assert.deepEqual(afterDomain,domain);
  assert.ok(nextMeasurement.elapsedMs<45000);assert.equal(afterJobs.filter(row=>row.full_scan_cursor!==null).length,1);
  assert.equal(resumed.body.result.outcome,'PARTIAL');assert.equal(resumed.body.result.itemsProcessed,1);
 }
 if(metricContinuation){
  let checkpointed=jobs.some(row=>row.full_scan_cursor!==null),legs=1;
  const unitCounts=async()=>({runs:Number((await timed.raw.execute("SELECT count(*) n FROM evidence_runs WHERE user_id='a'")).rows[0].n),
   completedRuns:Number((await timed.raw.execute("SELECT count(*) n FROM evidence_runs WHERE user_id='a' AND state='COMPLETED'")).rows[0].n),
   items:Number((await timed.raw.execute("SELECT count(*) n FROM evidence_items WHERE user_id='a'")).rows[0].n),
   authorities:Number((await timed.raw.execute("SELECT count(*) n FROM phase4_evidence_result_authorities WHERE user_id='a'")).rows[0].n)});
  const stages=[await unitCounts()];
  while(!checkpointed&&legs<8){
   const next=makeRequest({phase:'STAGE6_DRAIN',syncRequestId:syncRequest.requestId,handoff:sync.body.handoff});
   const countBefore=copy(transport.counts),startNext=performance.now();activeLatency=latencyMs;
   const resumed=await runExecutionPhase({...options,request:next});legs++;activeLatency=0;
   const nextMeasurement={leg:legs,elapsedMs:performance.now()-startNext,...delta(transport.counts,countBefore),status:resumed.status,result:resumed.body.result};
   const afterJobs=(await timed.raw.execute("SELECT * FROM phase4_jobs WHERE user_id='a' ORDER BY job_kind")).rows;
   const counts=await unitCounts();stages.push(counts);checkpointed=afterJobs.some(row=>row.full_scan_cursor!==null);
   console.log('BODY_CORE_METRIC_CONTINUATION '+JSON.stringify({...nextMeasurement,counts,checkpointed}));
   assert.deepEqual((await timed.raw.execute("SELECT * FROM body_energy_results WHERE user_id='a'")).rows,rows);
   assert.deepEqual((await timed.raw.execute("SELECT * FROM phase4_operation_receipts WHERE user_id='a' AND operation_kind='BODY_ENERGY_COMPUTE'")).rows,domain);
   assert.equal(afterJobs.filter(row=>row.completed_generation===row.requested_generation).length,0);
   assert.ok(nextMeasurement.elapsedMs<45000);
   assert.equal(resumed.body.result.outcome,'PARTIAL',JSON.stringify(nextMeasurement));
   if(!checkpointed){assert.equal(resumed.body.result.unitsCommitted,1);assert.equal(resumed.body.result.itemsProcessed,0);}
   else assert.equal(resumed.body.result.itemsProcessed,1);
  }
  assert.equal(checkpointed,true,'fresh admitted invocations must advance actual USER work');
  const changedStages=stages.filter((stage,index)=>!index||JSON.stringify(stage)!==JSON.stringify(stages[index-1]));
  assert.deepEqual(changedStages,[{runs:0,completedRuns:0,items:0,authorities:0},{runs:1,completedRuns:0,items:0,authorities:0},
   {runs:1,completedRuns:1,items:0,authorities:0},{runs:1,completedRuns:1,items:1,authorities:0},{runs:1,completedRuns:1,items:1,authorities:1}]);
  assert.ok(stages.every(counts=>counts.runs<=1&&counts.items<=1&&counts.authorities<=1),'immutable metric effects do not duplicate');
  const finalPublication=await stores.withContext('a',{executionMode:'SHADOW',providerRequired:true},context=>stores.bodyEnergy.readForPublication(context,
   {healthDate:bodyHealthDate(Date.now(),'Asia/Taipei'),asOfEpochMs:Date.now()}));
  assert.equal(finalPublication.status,'PROCESSING');assert.equal(Object.hasOwn(finalPublication,'value'),false);
 }
});
