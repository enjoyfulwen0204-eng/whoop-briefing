import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {deliveryFixture,fixtureKeys} from './deliveryDefaultFixture.js';
import {runExecutionPhase} from '../src/phase4Execution.js';
import {claimPhaseRequest,commitPhaseWork,configurationProof,readExecution,readPhaseProgress,requireSyncHandoff,EXECUTION_WORK_MAX_AGE_MS} from '../src/phase4ExecutionStore.js';
import {createExecutionBudget} from '../src/executionBudget.js';import {runningReleaseSha} from '../src/phase4Release.js';
import {withDurableExecution} from '../src/phase4ExecutionContext.js';
import {createBriefingEndpoint} from '../src/briefingEndpoint.js';import {signTriggerRequest} from '../src/briefingTriggerAuth.js';
const environment={PHASE4_BETA_SHADOW_RUNTIME:'on',PHASE4_PUBLIC_BETA_MODE:'off'};
const request=()=>({releaseSha:runningReleaseSha(),requestId:randomUUID(),phase:'SYNC',triggerSource:'cloudflare',executionMode:'SHADOW',configProof:configurationProof(fixtureKeys,{runtime:'on',mode:'off'},environment)});
const success={syncComplete:true,syncOutcome:'NO_NEW_DATA_SUCCESS',users:0,failed:0};
async function agedClaim(db,r,age){
 const original=Date.now,at=original();
 try{Date.now=()=>at-age;return await claimPhaseRequest(db,r,JSON.stringify(r),{deadlineAt:at+120000});}
 finally{Date.now=original;}
}
const run=(db,r,deps={})=>runExecutionPhase({request:r,db,keys:fixtureKeys,environment,env:{dryRun:true},deps});
test('stale incomplete identity is rejected before takeover or new work; expired receipts remain reconcilable',async t=>{
 const {db}=await deliveryFixture(t),r=request();await db.createUser({id:'alice',status:'ACTIVE',displayName:'Before'});
 const claim=await agedClaim(db,r,EXECUTION_WORK_MAX_AGE_MS+1),authority=createExecutionBudget({budgetMs:5000});
 try{await withDurableExecution({claim,keys:fixtureKeys,pending:new Set(),authority},()=>db.updateUser('alice',{displayName:'Committed progress'}));}finally{authority.close();}
 const receiptsBefore=(await db.raw.execute({sql:'SELECT count(*) n FROM phase4_execution_work_receipts WHERE execution_id=?',args:[r.requestId]})).rows[0].n;assert.equal(receiptsBefore,1);
 await db.raw.execute({sql:'UPDATE phase4_executions SET lease_until=?,deadline_at=? WHERE execution_id=?',args:[Date.now()-1,Date.now()-1,r.requestId]});
 const before=await readExecution(db,r.requestId);let calls=0;
 await assert.rejects(()=>run(db,r,{runBriefing:async()=>{calls++;return success;}}),e=>e.code==='EXECUTION_STALE_REQUEST');
 assert.equal(calls,0);assert.deepEqual(await readExecution(db,r.requestId),before);assert.equal((await readPhaseProgress(db,'SYNC','cloudflare')).state,'STALE_REQUEST');
 assert.equal((await db.getUser('alice')).displayName,'Committed progress');assert.equal((await db.raw.execute({sql:'SELECT count(*) n FROM phase4_execution_work_receipts WHERE execution_id=?',args:[r.requestId]})).rows[0].n,receiptsBefore);
 assert.equal((await run(db,request(),{runBriefing:async()=>success})).status,200);
});
test('signed stale request receives privacy-safe 410 and cannot poison a fresh identity',async t=>{
 const {db}=await deliveryFixture(t),r=request();await agedClaim(db,r,EXECUTION_WORK_MAX_AGE_MS+10);
 const secret='synthetic-context-age-secret-only'.repeat(2),endpoint=createBriefingEndpoint({secret,environment,runPhase:o=>runExecutionPhase({...o,db,keys:fixtureKeys,environment,env:{dryRun:true},deps:{runBriefing:async()=>{throw Error('NEW_WORK_FORBIDDEN');}}})});
 const body=JSON.stringify(r),timestamp=String(Date.now()),headers={'content-type':'application/json','x-briefing-timestamp':timestamp,'x-briefing-request-id':r.requestId,'x-briefing-signature':signTriggerRequest({timestamp,requestId:r.requestId,method:'POST',path:'/internal/briefing/run',body},secret)};
 const result=await endpoint({url:'/internal/briefing/run',method:'POST',headers},body);assert.deepEqual(result,{status:410,body:{ok:false,error:'EXECUTION_STALE_REQUEST'}});
});
test('a permitted continuation clamps durable and child deadlines to the immutable context age',async t=>{
 const {db}=await deliveryFixture(t),r=request();const old=await agedClaim(db,r,EXECUTION_WORK_MAX_AGE_MS-3000);
 await db.raw.execute({sql:'UPDATE phase4_executions SET lease_until=?,deadline_at=? WHERE execution_id=?',args:[Date.now()-1,Date.now()-1,r.requestId]});
 let entered=false;const result=await run(db,r,{runBriefing:async({deps})=>{
  entered=true;const row=await readExecution(db,r.requestId);assert.equal(row.deadline_at,old.startedAt+EXECUTION_WORK_MAX_AGE_MS);
  assert.ok(deps.executionBudget.remainingMs()<3000);await new Promise(resolve=>setTimeout(resolve,3500));return success;
 }});
 assert.equal(entered,true);assert.equal(result.status,410);assert.equal(result.body.result.resumable,false);assert.equal(result.body.result.continuationState,'STALE_REQUEST');assert.equal(result.body.syncComplete,false);assert.equal(result.body.handoff,undefined);
});
test('old acknowledged work can finalize without new business work or a renewed drain handoff',async t=>{
 const {db}=await deliveryFixture(t),r=request(),claim=await agedClaim(db,r,EXECUTION_WORK_MAX_AGE_MS+1),authority=createExecutionBudget({budgetMs:5000});
 try{await commitPhaseWork(db,r,claim,{outcome:'NO_NEW_DATA_SUCCESS'},authority);}finally{authority.close();}
 const result=await run(db,r,{runBriefing:async()=>{throw Error('COMMITTED_WORK_REPLAYED');}});assert.equal(result.status,200);assert.equal(result.body.syncComplete,true);assert.equal(result.body.drainAuthorized,false);assert.equal(result.body.handoff,undefined);
 const row=await readExecution(db,r.requestId);assert.equal(row.state,'FINALIZED_SUCCESS');
 const hypothetical=fixtureKeys.lookup(['phase4-sync-handoff-v3',row.execution_id,row.identity_digest,row.release_sha,row.trigger_source,row.execution_mode,row.config_proof,row.result_digest,row.finalized_at]);
 await assert.rejects(()=>requireSyncHandoff(db,{...r,phase:'STAGE6_DRAIN',requestId:randomUUID(),syncRequestId:r.requestId,handoff:hypothetical},fixtureKeys),/SYNC_HANDOFF_REJECTED/);
});
test('finalized success keeps its immutable replay while expired context cannot authorize a new drain',async t=>{
 const {db}=await deliveryFixture(t),r=request(),first=await run(db,r,{runBriefing:async()=>success}),original=Date.now;
 try{Date.now=()=>original()+EXECUTION_WORK_MAX_AGE_MS+100;assert.deepEqual(await run(db,r),first);
  await assert.rejects(()=>requireSyncHandoff(db,{...r,phase:'STAGE6_DRAIN',requestId:randomUUID(),syncRequestId:r.requestId,handoff:first.body.handoff},fixtureKeys),/SYNC_HANDOFF_REJECTED/);
 }finally{Date.now=original;}
});
test('finalized drain replay remains immutable after parent expiry and never enters the worker again',async t=>{
 const {db}=await deliveryFixture(t),r=request(),sync=await run(db,r,{runBriefing:async()=>success});
 const child={...r,requestId:randomUUID(),phase:'STAGE6_DRAIN',syncRequestId:r.requestId,handoff:sync.body.handoff};
 const worker={drain:async()=>({outcome:'NO_WORK',jobsConsidered:0,itemsAttempted:0,processedItems:0,completedJobs:0,remainingJobs:0,completion:'COMPLETE'})};
 const first=await run(db,child,{runtime:{phase4Stage6:worker}});assert.equal(first.status,200);
 const original=Date.now;
 try{Date.now=()=>original()+EXECUTION_WORK_MAX_AGE_MS+100;
  assert.deepEqual(await run(db,child,{runtime:{phase4Stage6:{drain:async()=>{throw Error('FINALIZED_DRAIN_REPLAYED');}}}}),first);
 }finally{Date.now=original;}
});
test('a caller cannot request metadata-only age bypass for an incomplete SYNC',async t=>{
 const {db}=await deliveryFixture(t),r=request();await agedClaim(db,r,EXECUTION_WORK_MAX_AGE_MS+1);
 await assert.rejects(()=>claimPhaseRequest(db,r,JSON.stringify(r),{keys:fixtureKeys,reconciliationOnly:true,maxWorkAgeMs:EXECUTION_WORK_MAX_AGE_MS}),/EXECUTION_RECONCILIATION_AUTHORITY_INVALID/);
});
