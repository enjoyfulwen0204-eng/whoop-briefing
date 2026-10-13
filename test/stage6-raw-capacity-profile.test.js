import test from 'node:test';import assert from 'node:assert/strict';
import {mod,fixtureKeys,residualFixture} from './stage6JournalBoundaryFixture.js';
const {createPhase4Stage6,authorizeStage6ShadowWorker}=await mod('src/phase4Reanalysis.js');
const {request,claim}=await mod('test/v32ReviewFixture.js');
const {commitPhaseWork,finalizePhaseWork,configurationProof}=await mod('src/phase4ExecutionStore.js');
const {withDurableExecution}=await mod('src/phase4ExecutionContext.js');
const {createExecutionBudget,withExecutionBudget}=await mod('src/executionBudget.js');
const {runExecutionPhase}=await mod('src/phase4Execution.js');
const {runningReleaseSha}=await mod('src/phase4Release.js');
const {publicBetaConfiguration}=await mod('src/publicBetaConfig.js');
const {OWNER_PILOT_APPROVAL_SHA256}=await mod('src/betaPilotAllowance.js');
const {requireCurrentBetaPilotAttempt}=await mod('src/betaPilotPermit.js');
test('profile exact retained USER successor over installed Hrana at115ms',async t=>{
 const f=await residualFixture(t),syncReq=request(),syncOwner=await claim(f.db,syncReq),authority={assert(){}};
 await commitPhaseWork(f.db,syncReq,syncOwner,{outcome:'NO_NEW_DATA_SUCCESS',durationMs:0},authority);
 const sync=await finalizePhaseWork(f.db,syncReq,syncOwner,fixtureKeys,authority);
 for(let n=0;n<40;n++){
  await f.fresh();const admission=await f.db.admitRuntime(),worker=await createPhase4Stage6({db:f.db,keys:fixtureKeys,admission,executionMode:'SHADOW',workerCapability:authorizeStage6ShadowWorker({executionMode:'SHADOW'})});
  const req=request({phase:'STAGE6_DRAIN',syncRequestId:syncReq.requestId,handoff:sync.handoff}),owner=await claim(f.db,req),budget=createExecutionBudget({budgetMs:45000}),a={assert:()=>budget.assert()};
  try{const result=await withDurableExecution({claim:owner,keys:fixtureKeys,pending:new Set(),authority:a,presentationClock:()=>new Date()},()=>withExecutionBudget(budget,()=>budget.run(()=>worker.drain({triggerSource:'manual',userId:'a',budget:{maxItems:1,maxItemsPerTenant:1}}))));
   assert.equal(result.failedJobs,0);await commitPhaseWork(f.db,req,owner,{outcome:result.outcome,durationMs:result.elapsedMs},a);await finalizePhaseWork(f.db,req,owner,fixtureKeys,a);
  }finally{budget.close()}
  const jobs=await f.jobs();if(jobs.every(j=>j.full_scan_cursor===JSON.stringify(['USER','a'])))break;
 }
 assert.ok((await f.jobs()).every(j=>j.full_scan_cursor===JSON.stringify(['USER','a'])));
 await f.toHttp();const environment={PHASE4_BETA_SHADOW_RUNTIME:'on',PHASE4_PUBLIC_BETA_MODE:'off',PHASE4_BETA_PILOT_ID:'a'.repeat(64),PHASE4_BETA_PILOT_USER_ID:'a',PHASE4_BETA_PILOT_START_AT:new Date(Date.now()-1000).toISOString(),PHASE4_BETA_PILOT_CONSENT_SHA256:'b'.repeat(64),PHASE4_BETA_PILOT_ALLOWANCE_ID:OWNER_PILOT_APPROVAL_SHA256};
 const releaseSha=runningReleaseSha(),configProof=configurationProof(fixtureKeys,publicBetaConfiguration(environment),environment,releaseSha),makeReq=phase=>({requestId:crypto.randomUUID(),releaseSha,configProof,executionMode:'SHADOW',triggerSource:'manual',phase});
 const common=()=>({db:f.db,keys:fixtureKeys,environment,env:{dryRun:false}}),sr=makeReq('SYNC'),s=await runExecutionPhase({...common(),request:sr,deps:{runBriefing:async()=>({syncComplete:true,syncOutcome:'NO_NEW_DATA_SUCCESS'})}});
 const observations=[];let origin,ready;globalThis.__stage6Measure=async(label,work)=>{const before=structuredClone(f.transport.counts),start=performance.now();try{return await work()}finally{observations.push({label,http:f.transport.counts.httpRequests-before.httpRequests,sql:f.transport.counts.sqlStatements-before.sqlStatements,ms:performance.now()-start,remainingMs:ready===undefined?null:30000-(performance.now()-origin-ready)})}};
 for(let leg=1;leg<=7;leg++){
 await f.fresh();observations.length=0;ready=undefined;
 f.setLatency(115);const before=structuredClone(f.transport.counts);origin=performance.now();
 const req={...makeReq('STAGE6_DRAIN'),syncRequestId:sr.requestId,handoff:s.body.handoff},runtime={phase4Stage6:{drain:async args=>{const pilotGrant=requireCurrentBetaPilotAttempt('a',f.db.raw),admission=await f.db.admitRuntime(),worker=await createPhase4Stage6({db:f.db,keys:fixtureKeys,admission,executionMode:'SHADOW',pilotGrant,workerCapability:authorizeStage6ShadowWorker({executionMode:'SHADOW'})});ready=performance.now()-origin;return worker.drain({...args,budget:{maxItems:1,maxItemsPerTenant:1}})}}};
 const result=await runExecutionPhase({...common(),request:req,deps:{runtime}}),wholeMs=performance.now()-origin;f.setLatency(0);
 console.log('RAW_PROFILE '+JSON.stringify({leg,wholeMs,http:f.transport.counts.httpRequests-before.httpRequests,sql:f.transport.counts.sqlStatements-before.sqlStatements,ready,observations,result:result.body.result,jobs:await f.jobs(),counts:await f.counts()}));
 assert.equal(result.body.result.settlementState,'FINALIZED_SUCCESS');assert.equal(result.body.result.jobsFailed,0);
 assert.ok((result.body.result.unitsCommitted??0)>0||(result.body.result.itemsProcessed??0)>0,'each raw continuation must commit durable progress');
 }
 delete globalThis.__stage6Measure;
});
