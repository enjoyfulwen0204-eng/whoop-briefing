import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {mod,fixtureKeys,residualFixture} from './stage6JournalBoundaryFixture.js';
const {runExecutionPhase}=await mod('src/phase4Execution.js');
const {configurationProof}=await mod('src/phase4ExecutionStore.js');const {runningReleaseSha}=await mod('src/phase4Release.js');
const {publicBetaConfiguration}=await mod('src/publicBetaConfig.js');const {OWNER_PILOT_APPROVAL_SHA256}=await mod('src/betaPilotAllowance.js');
const {requireCurrentBetaPilotAttempt}=await mod('src/betaPilotPermit.js');
const {createPublicBetaRuntime,authorizePublicBetaRuntime}=await mod('src/publicBeta.js');
test('current USER checkpoint yields safely before starting a successor whose admission consumed the productive budget',async t=>{
 const f=await residualFixture(t,{http:true}),environment={PHASE4_BETA_SHADOW_RUNTIME:'on',PHASE4_PUBLIC_BETA_MODE:'off',PHASE4_BETA_PILOT_ID:'a'.repeat(64),PHASE4_BETA_PILOT_USER_ID:'a',PHASE4_BETA_PILOT_START_AT:new Date(Date.now()-1000).toISOString(),PHASE4_BETA_PILOT_CONSENT_SHA256:'b'.repeat(64),PHASE4_BETA_PILOT_ALLOWANCE_ID:OWNER_PILOT_APPROVAL_SHA256};
 const releaseSha=runningReleaseSha(),configProof=configurationProof(fixtureKeys,publicBetaConfiguration(environment),environment,releaseSha),request=phase=>({requestId:randomUUID(),releaseSha,configProof,executionMode:'SHADOW',triggerSource:'manual',phase});
 const common=()=>({db:f.db,keys:fixtureKeys,environment,env:{dryRun:false}}),syncReq=request('SYNC'),sync=await runExecutionPhase({...common(),request:syncReq,deps:{runBriefing:async()=>({syncComplete:true,syncOutcome:'NO_NEW_DATA_SUCCESS'})}});assert.equal(sync.body.syncComplete,true);
 let sawDomain=false,measured=false;
 for(let leg=1;leg<=11;leg++){
  await f.fresh();const probe=sawDomain;f.setLatency(probe?115:0);if(probe)f.startTrace();const before=structuredClone(f.transport.counts),start=performance.now();let workerReadyAt;const boundaries=[];
  if(probe)f.transport.arm({matchSql:/UPDATE phase4_jobs SET full_scan_cursor=/,after:()=>{
   boundaries.push({event:'USER_CURSOR_COMMITTED',atMs:performance.now()-start});
   f.transport.arm({matchSql:/SELECT source_type,source_id,json_array/,after:()=>boundaries.push({event:'SUCCESSOR_ENUMERATION_COMMITTED',atMs:performance.now()-start})});
  }});
  const req={...request('STAGE6_DRAIN'),syncRequestId:syncReq.requestId,handoff:sync.body.handoff};
  const runtime={phase4Stage6:{drain:async args=>{const pilotGrant=requireCurrentBetaPilotAttempt('a',f.db.raw),admission=await f.db.admitRuntime(),w=(await createPublicBetaRuntime({db:f.db,keys:fixtureKeys,admission,executionMode:'SHADOW',pilotGrant,runtimeCapability:authorizePublicBetaRuntime({executionMode:'SHADOW'})})).phase4Stage6;workerReadyAt=performance.now()-start;return w.drain(args);}}};
  const result=await runExecutionPhase({...common(),request:req,deps:{runtime}}),ms=performance.now()-start,httpRequests=f.transport.counts.httpRequests-before.httpRequests,timeline=f.stopTrace();f.setLatency(0);
  const counts=await f.counts(),jobs=await f.jobs();sawDomain=counts.domain>0;
  if(probe){
   console.log('USER_SUCCESSOR_MEASURED '+JSON.stringify({leg,wholeMs:ms,httpRequests,outcome:result.body.result?.outcome,settlement:result.body.result?.settlementState,workerReadyAt,productiveDeadlineAt:workerReadyAt+30000,boundaries,jobs,counts,timeline}));
   measured=true;assert.equal(result.body.result?.settlementState,'FINALIZED_SUCCESS');assert.ok(ms<45000);assert.ok(jobs.some(j=>j.full_scan_cursor===JSON.stringify(['USER','a'])));assert.ok(jobs.every(j=>j.state==='PENDING'&&j.attempt===0));break;
  }
  assert.equal(result.body.result?.settlementState,'FINALIZED_SUCCESS');
 }
 assert.equal(measured,true);
});
