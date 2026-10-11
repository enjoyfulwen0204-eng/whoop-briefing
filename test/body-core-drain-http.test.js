import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,fixtureKeys} from './v32ReviewFixture.js';
import {bodyInput,seedBodyInput} from './bodyEnergyFixture.js';
import {bodyHealthDate} from '../src/bodyEnergyInputs.js';
import {createPhase4Foundation} from '../src/phase4Foundation.js';
import {createPhase4Stage6,authorizeStage6ShadowWorker} from '../src/phase4Reanalysis.js';
import {runExecutionPhase} from '../src/phase4Execution.js';
import {configurationProof} from '../src/phase4ExecutionStore.js';
import {publicBetaConfiguration} from '../src/publicBetaConfig.js';
import {runningReleaseSha} from '../src/phase4Release.js';
import {OWNER_PILOT_APPROVAL_SHA256} from '../src/betaPilotAllowance.js';
import {requireCurrentBetaPilotAttempt} from '../src/betaPilotPermit.js';
import {randomUUID} from 'node:crypto';

const latencyMs=Number(process.env.BODY_CORE_HTTP_LATENCY_MS??0);
assert.ok(Number.isSafeInteger(latencyMs)&&latencyMs>=0&&latencyMs<=150);
const baselineDays=Number(process.env.BODY_CORE_BASELINE_DAYS??7);
assert.ok([7,30].includes(baselineDays));
const copy=value=>structuredClone(value);
const delta=(after,before)=>({httpRequests:after.httpRequests-before.httpRequests,sqlStatements:after.sqlStatements-before.sqlStatements,
 byFamily:Object.fromEntries(Object.entries(after.byFamily).map(([key,value])=>[key,value-(before.byFamily[key]??0)]))});

test('actual admitted v32 DRAIN claims and checkpoints one original Body job unit over physical Hrana',async t=>{
 const {db,transport}=await fixture(t),fetch=transport.fetch;let activeLatency=0;
 transport.fetch=async request=>{if(activeLatency)await new Promise(resolve=>setTimeout(resolve,activeLatency));return fetch(request);};
 // The installed client captured fetch at construction. Its private handle is
 // never replaced: this supported fetch function routes the timing control.
 const {createDb}=await import('../src/db.js');
 const timed=createDb({url:'https://isolated.invalid',phase4Keys:fixtureKeys,fetch:request=>transport.fetch(request)});
 t.after(()=>timed.close());
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
 const makeRequest=extra=>({releaseSha:runningReleaseSha(),requestId:randomUUID(),phase:'SYNC',triggerSource:'manual',executionMode:'SHADOW',
  configProof:configurationProof(fixtureKeys,publicBetaConfiguration(environment),environment),...extra});
 const options={db:timed,keys:fixtureKeys,environment,env:{timezone:'Asia/Taipei',dryRun:true,maxUserConcurrency:1},deps:{runBriefing:async()=>({syncComplete:true,syncOutcome:'NO_NEW_DATA_SUCCESS'})}};
 const syncRequest=makeRequest(),sync=await runExecutionPhase({...options,request:syncRequest});
 assert.equal(sync.body.syncComplete,true);
 let actualWorkerCalls=0;
 options.deps.runtime={phase4Stage6:{drain:async args=>{
  actualWorkerCalls++;
  const pilotGrant=requireCurrentBetaPilotAttempt('a',timed.raw);
  const worker=await createPhase4Stage6({db:timed,keys:fixtureKeys,admission,executionMode:'SHADOW',pilotGrant,
   workerCapability:authorizeStage6ShadowWorker({executionMode:'SHADOW'})});
  const drained=await worker.drain({...args,budget:{maxJobs:1,maxItems:1,maxItemsPerTenant:1}});
  console.log('BODY_CORE_WORKER_RESULT '+JSON.stringify(drained));return drained;
 }}};
 const request=makeRequest({phase:'STAGE6_DRAIN',syncRequestId:syncRequest.requestId,handoff:sync.body.handoff});
 activeLatency=latencyMs;const before=copy(transport.counts),started=performance.now();
 const result=await runExecutionPhase({...options,request});
 const measurement={baselineDays,latencyPerRequestMs:latencyMs,elapsedMs:performance.now()-started,...delta(transport.counts,before),status:result.status,result:result.body.result};
 activeLatency=0;
 console.log('BODY_CORE_ADMITTED_DRAIN_HTTP '+JSON.stringify(measurement));
 assert.equal(actualWorkerCalls,1);
 const rows=(await timed.raw.execute("SELECT value,quality_state FROM body_energy_results WHERE user_id='a'")).rows;
 const jobs=(await timed.raw.execute("SELECT job_kind,full_scan_cursor,completed_generation,requested_generation,state FROM phase4_jobs WHERE user_id='a' ORDER BY job_kind")).rows;
 const work=(await timed.raw.execute({sql:'SELECT step_key FROM phase4_execution_work_receipts WHERE execution_id=?',args:[request.requestId]})).rows;
 console.log('BODY_CORE_ADMITTED_DRAIN_DURABLE '+JSON.stringify({bodyRows:rows.length,qualityStates:rows.map(row=>row.quality_state),
  checkpointedJobs:jobs.filter(row=>row.full_scan_cursor!==null).length,completeJobs:jobs.filter(row=>row.completed_generation===row.requested_generation).length,
  remainingJobs:jobs.filter(row=>row.completed_generation<row.requested_generation).length,workReceiptCount:work.length,
  declaration:'SYNTHETIC_ADMITTED_PHYSICAL_HRANA_UNIT_NOT_PRODUCTION_COST_CAPACITY_OR_PUBLICATION'}));
 if(result.body.result.outcome==='PARTIAL'){
  assert.equal(result.body.result.itemsProcessed,1);assert.equal(result.body.result.jobsCompleted,0);assert.equal(result.body.result.completion,'PARTIAL');
  assert.equal(result.body.result.settlementState,'FINALIZED_SUCCESS');assert.equal(result.body.result.remainingJobs,2);
  assert.equal(rows.length,1);assert.equal(rows[0].quality_state,'LIMITED');assert.ok(Number.isFinite(rows[0].value));
  assert.equal(jobs.filter(row=>row.full_scan_cursor!==null).length,1);assert.equal(jobs.filter(row=>row.completed_generation===row.requested_generation).length,0);
  assert.ok(work.length>=3);assert.ok(measurement.elapsedMs<45000);
 } else if(baselineDays===30&&latencyMs===0){
  assert.equal(result.body.result.outcome,'FAILED');assert.equal(result.body.result.settlementState,'FINALIZED_FAILURE');
  assert.equal(rows.length,0);assert.equal(jobs.filter(row=>row.full_scan_cursor!==null).length,0);
  assert.equal(jobs.filter(row=>row.completed_generation===row.requested_generation).length,0);
 } else {
  assert.ok(['TIMEOUT','CANCELLED','COMMIT_INDETERMINATE'].includes(result.body.result.outcome),JSON.stringify(result));
  assert.equal(result.body.result.completion,'PARTIAL');assert.equal(result.body.drainAuthorized,false);
  assert.equal(jobs.filter(row=>row.completed_generation===row.requested_generation).length,0);
 }
});
