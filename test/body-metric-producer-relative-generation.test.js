// Actual installed-Hrana regression for S6-PERF-RELGEN-1; original reviewer failure retained.
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
import {randomUUID,createHash} from 'node:crypto';
import {createBodyEnergyIntegration} from '../src/bodyEnergyIntegration.js';
import {BODY_ENERGY_QUALIFICATION_REGISTRATION,authorizeBodyEnergyPublication} from '../src/bodyEnergyQualificationAuthority.js';

const latencyMs=Number(process.env.BODY_CORE_HTTP_LATENCY_MS??0);
assert.ok(Number.isSafeInteger(latencyMs)&&latencyMs>=0&&latencyMs<=150);
const cancellation=process.env.BODY_CORE_CANCEL_ON_SOURCE==='1',controller=new AbortController();
const requireDurableBody=process.env.BODY_CORE_REQUIRE_DURABLE_BODY==='1',continueDrain=process.env.BODY_CORE_CONTINUE_DRAIN==='1';
const metricContinuation=process.env.BODY_CORE_METRIC_CONTINUATION==='1';
const bundleFault=process.env.BODY_CORE_BUNDLE_FAULT??'';
assert.ok(['','missing','extra_foreign','corrupt_source','corrupt_receipt','corrupt_body','source_generation','lifecycle','auth','purge','unknown_commit','cancel'].includes(bundleFault));
const diagnosticSafetyMs=Number(process.env.BODY_CORE_DIAGNOSTIC_SAFETY_MS??15000);
assert.ok([12000,15000].includes(diagnosticSafetyMs));
const cancelAfterBody=process.env.BODY_CORE_CANCEL_AFTER_BODY==='1',loseBodyAck=process.env.BODY_CORE_LOSE_BODY_ACK==='1'||bundleFault==='unknown_commit';
assert.ok(!(cancelAfterBody&&loseBodyAck));
const triggerSource=process.env.BODY_CORE_TRIGGER_SOURCE??'manual';
assert.ok(['manual','github'].includes(triggerSource));
const baselineDays=Number(process.env.BODY_CORE_BASELINE_DAYS??30);
assert.ok([7,30].includes(baselineDays));
const copy=value=>structuredClone(value);
const delta=(after,before)=>({httpRequests:after.httpRequests-before.httpRequests,sqlStatements:after.sqlStatements-before.sqlStatements,
 ...Object.fromEntries(['byFamily','byHttpMix','byHttpFamily'].map(kind=>[kind,Object.fromEntries(Object.entries(after[kind]).map(([key,value])=>[key,value-(before[kind]?.[key]??0)]))]))});

for(const control of ['HEALTHY_RELATIVE_FINAL','FUTURE_GENERATION','NONINTEGER_FINAL','RECLAIMED_OWNER','INPUT_CURRENTNESS','OWNER_EXPIRY'])
test('actual lost phase ACK reconciliation preserves immutable producer generation: '+control,async t=>{
 const dir=await mkdtemp(join(tmpdir(),'body-core-http-')),url=`file:${join(dir,'db.sqlite')}`,seed=createOwnedDb({url});
 await seed.migrate({targetVersion:32});assert.equal((await seed.raw.execute('PRAGMA journal_mode=WAL')).rows[0].journal_mode,'wal');seed.close();
 const transport=hranaTransport(url);let activeLatency=0,workerEntered=false,canonicalAtStart=Infinity,cancelBundleRead=false,cancelBundleAt=Infinity;
 const db=createDb({url:'https://isolated.invalid',phase4Keys:fixtureKeys,fetch:async request=>{
  if(activeLatency)await new Promise(resolve=>setTimeout(resolve,activeLatency));
  const response=await transport.fetch(request);
  if(cancellation&&workerEntered&&(transport.counts.byFamily.CANONICAL??0)>canonicalAtStart)controller.abort();
  if(cancelBundleRead&&(transport.counts.byFamily.CANONICAL??0)>cancelBundleAt)controller.abort();
  return response;
 }}),timed=db;
 t.after(async()=>{await new Promise(resolve=>setImmediate(resolve));timed.close();transport.close();await rm(dir,{recursive:true,force:true});});
 await db.createUser({id:'a',displayName:'Synthetic',timezone:'Asia/Taipei',status:'ACTIVE'});
 await db.setLocale('a','en');
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
 let actualWorkerCalls=0,workerStartedAt=null,bodyCommittedAt=null,bodyCommitCounts=null,workerCountStart=null,workerClockStart=null;
 options.deps.runtime={phase4Stage6:{drain:async args=>{
  actualWorkerCalls++;workerEntered=true;workerStartedAt=performance.now();
  const pilotGrant=requireCurrentBetaPilotAttempt('a',timed.raw);
  const runtime=await createPublicBetaRuntime({db:timed,keys:fixtureKeys,admission,executionMode:'SHADOW',pilotGrant,
   runtimeCapability:authorizePublicBetaRuntime({executionMode:'SHADOW'})});
  const beforeWorker=copy(transport.counts),workerClock=performance.now();
  workerCountStart=beforeWorker;workerClockStart=workerClock;
  const drained=await runtime.phase4Stage6.drain({...args,budget:{maxJobs:1,maxItems:1,maxItemsPerTenant:1,
   ...(diagnosticSafetyMs===12000?{maxWallMs:45000,safetyMarginMs:12000}:{})}});
  console.log('BODY_CORE_WORKER_UNIT_HTTP '+JSON.stringify({leg:actualWorkerCalls,httpRequests:transport.counts.httpRequests-beforeWorker.httpRequests,
   elapsedMs:performance.now()-workerClock,unitsCommitted:drained.unitsCommitted,processedItems:drained.processedItems,outcome:drained.outcome}));
  console.log('BODY_CORE_WORKER_RESULT '+JSON.stringify(drained));return drained;
 }}};
 const request=makeRequest({phase:'STAGE6_DRAIN',syncRequestId:syncRequest.requestId,handoff:sync.body.handoff});
 activeLatency=latencyMs;canonicalAtStart=transport.counts.byFamily.CANONICAL??0;const before=copy(transport.counts),started=performance.now();
 transport.arm({matchSql:/INSERT INTO body_energy_results\(/,loseAcknowledgement:false,after:()=>{transport.arm({onlyWorkResult:true,loseAcknowledgement:true});
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
 // The reviewed source-unit consumer distinguishes complete Body from the
 // still-incomplete historical family. Unknown/unfinalized source parents
 // retain PROCESSING; a complete mature synthetic source may be AVAILABLE.
 const sourceFinalized=sourceWorkReceipt&&producerBindingValid&&execution.state==='FINALIZED_SUCCESS';
 const expectedPublication=sourceFinalized?(baselineDays===30?'AVAILABLE':'LIMITED'):'PROCESSING';
 assert.equal(publication.status,expectedPublication);assert.equal(Object.hasOwn(publication,'value'),expectedPublication==='AVAILABLE');
 assert.equal(BODY_ENERGY_QUALIFICATION_REGISTRATION.state,'PENDING_GENUINE_EVIDENCE_AND_FINAL_GATE');
 assert.equal(BODY_ENERGY_QUALIFICATION_REGISTRATION.approvedPacket,null);
 const publicationCapability=authorizeBodyEnergyPublication({db:timed,userIds:['a'],qualificationId:'on'});assert.equal(publicationCapability,null);
 const gated=createBodyEnergyIntegration({db:timed,stores,keys:fixtureKeys,publicationCapability});
 const query=await gated.query({text:'/energy',userId:'a'});assert.equal(query.status,'QUALIFICATION_PENDING');assert.doesNotMatch(query.message,/\d+\/100/);
 console.log('BODY_CORE_ADMITTED_DRAIN_DURABLE '+JSON.stringify({sourceConsumerState:publication.status,publicationState:query.status,bodyRows:rows.length,qualityStates:rows.map(row=>row.quality_state),
  sourceParent:{state:execution.state,workCommittedAt:execution.work_committed_at,finalizedAt:execution.finalized_at,deadlineAt:execution.deadline_at,
    leaseUntil:execution.lease_until,digestVerified:typeof execution.result_json==='string'&&createHash('sha256').update(execution.result_json).digest('hex')===execution.result_digest},
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
 assert.equal(execution.state,'WORK_COMMITTED');
 assert.equal(result.body.result.outcome,'COMMIT_INDETERMINATE');
 const reconciled=await runExecutionPhase({...options,request});
 assert.equal(reconciled.body.result.settlementState,'FINALIZED_SUCCESS');
 assert.equal(actualWorkerCalls,1,'phase metadata reconciliation cannot rerun Source work');
 const reconciledParent=(await timed.raw.execute({sql:'SELECT generation,state FROM phase4_executions WHERE execution_id=?',args:[request.requestId]})).rows[0];
 const retainedProducer=(await timed.raw.execute({sql:'SELECT producing_generation FROM phase4_execution_producers WHERE producing_execution_id=?',args:[request.requestId]})).rows[0];
 assert.equal(reconciledParent.generation,2);assert.equal(retainedProducer.producing_generation,1);
 const resumedRequest=makeRequest({phase:'STAGE6_DRAIN',syncRequestId:syncRequest.requestId,handoff:sync.body.handoff});
 const originalExecute=timed.raw.execute.bind(timed.raw);let attacked=false;
 if(control!=='HEALTHY_RELATIVE_FINAL')timed.raw.execute=async statement=>{
  const value=await originalExecute(statement),sql=(typeof statement==='string'?statement:statement?.sql??'').replace(/\s+/g,' ');
  // Fault only the original metric helper's actual installed SQL, after the
  // original source and parent are durable. No fabricated receipt is seeded.
  if(!attacked&&sql.includes('e.execution_seq final_seq,e.identity_digest,e.scope_key,e.created_at,e.deadline_at,e.finalized_at')
    &&sql.includes('FROM phase4_execution_producers p')&&value.rows.some(p=>p.producing_execution_id===request.requestId)){
   attacked=true;const producer=value.rows.find(p=>p.producing_execution_id===request.requestId);
   if(control==='FUTURE_GENERATION'){
    // Observation corruption after real SQL; a matching fixture tenant seal
    // still cannot authorize a generation newer than the finalized parent.
    producer.producing_generation=producer.final_generation+1;
    producer.tenant_proof=fixtureKeys.lookup(['execution-producer-v1','a','SHADOW',producer.input_generation,
     producer.producing_execution_id,producer.execution_seq,producer.producing_generation]);
   }else if(control==='NONINTEGER_FINAL')producer.final_generation=String(producer.final_generation);
   else if(control==='INPUT_CURRENTNESS')await originalExecute("UPDATE phase4_computation_state SET input_generation=input_generation+1 WHERE user_id='a' AND execution_mode='SHADOW'");
   else{
    await originalExecute({sql:'UPDATE phase4_executions SET deadline_at=0,lease_until=0 WHERE execution_id=?',args:[resumedRequest.requestId]});
    if(control==='RECLAIMED_OWNER'){
     const now=Date.now();await originalExecute({sql:'UPDATE phase4_executions SET owner=?,generation=generation+1,deadline_at=?,lease_until=? WHERE execution_id=?',
      args:['synthetic_reclaimed_owner',now+90000,now+240000,resumedRequest.requestId]});
    }
   }
  }return value;
 };
 let resumed;try{resumed=await runExecutionPhase({...options,request:resumedRequest});}finally{timed.raw.execute=originalExecute;}

 const resumedCounts={runs:Number((await timed.raw.execute("SELECT count(*) n FROM evidence_runs WHERE user_id='a'")).rows[0].n),
  items:Number((await timed.raw.execute("SELECT count(*) n FROM evidence_items WHERE user_id='a'")).rows[0].n)};
 console.log('INDEPENDENT_RELATIVE_GENERATION_RESUME '+JSON.stringify({reconciledParent,retainedProducer,
  control,attacked,observationCorruptionOnly:['FUTURE_GENERATION','NONINTEGER_FINAL'].includes(control),
  resumed:resumed.body.result,counts:resumedCounts,workerCalls:actualWorkerCalls}));
 if(control==='HEALTHY_RELATIVE_FINAL'){
  assert.equal(resumed.body.result.jobsFailed,0,'legitimate metadata-only generation takeover must not invalidate its original producer');
  assert.equal(resumed.body.result.unitsCommitted,1);assert.equal(resumedCounts.runs,1);
  assert.equal(resumed.body.result.settlementState,'FINALIZED_SUCCESS');assert.equal(resumed.body.result.completion,'PARTIAL');
 }else{
  assert.equal(attacked,true,'negative must reach the metric helper after original Source and parent reconciliation');
  assert.equal(resumed.body.result.unitsCommitted??0,0);assert.equal(resumed.body.result.itemsProcessed??0,0);
  assert.deepEqual(resumedCounts,{runs:0,items:0},'no metric effect can escape a changed generation/current owner/input');
 }
 const originalProducer=(await timed.raw.execute({sql:'SELECT producing_generation FROM phase4_execution_producers WHERE producing_execution_id=?',args:[request.requestId]})).rows[0];
 const originalParent=(await timed.raw.execute({sql:'SELECT generation,state,result_json,result_digest FROM phase4_executions WHERE execution_id=?',args:[request.requestId]})).rows[0];
 assert.equal(originalProducer.producing_generation,1);assert.equal(originalParent.generation,2);assert.equal(originalParent.state,'FINALIZED_SUCCESS');
 assert.equal(createHash('sha256').update(originalParent.result_json).digest('hex'),originalParent.result_digest);
 assert.equal((await timed.raw.execute("SELECT count(*) n FROM phase4_jobs WHERE user_id='a' AND completed_generation=requested_generation")).rows[0].n,0);
 assert.deepEqual((await timed.raw.execute("SELECT * FROM body_energy_results WHERE user_id='a'")).rows,rows);
 assert.deepEqual((await timed.raw.execute("SELECT * FROM phase4_operation_receipts WHERE user_id='a' AND operation_kind='BODY_ENERGY_COMPUTE'")).rows,domain);
});
