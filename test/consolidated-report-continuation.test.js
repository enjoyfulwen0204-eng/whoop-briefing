import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {deliveryFixture,fixtureKeys} from './deliveryDefaultFixture.js';import {runExecutionPhase} from '../src/phase4Execution.js';
import {configurationProof,canonicalPhaseRequest} from '../src/phase4ExecutionStore.js';import {publicBetaConfiguration} from '../src/publicBetaConfig.js';import {runningReleaseSha} from '../src/phase4Release.js';
const pause=ms=>new Promise(r=>setTimeout(r,ms));
for(const started of [false,true])test('Same request report continuation '+(started?'never reacquires an ambiguous send':'reacquires only an expired unstarted lease'),async t=>{
 const {db}=await deliveryFixture(t);await db.createUser({id:'alice',displayName:'Alice',status:'ACTIVE'});
 const environment={PHASE4_BETA_SHADOW_RUNTIME:'off',PHASE4_PUBLIC_BETA_MODE:'off'},request={requestId:'p4c1_'+randomUUID(),releaseSha:runningReleaseSha(),phase:'SYNC',triggerSource:'cloudflare',executionMode:'OFF',configProof:configurationProof(fixtureKeys,publicBetaConfiguration(environment),environment)};
 const common={db,keys:fixtureKeys,request,body:canonicalPhaseRequest(request),environment,env:{dryRun:true},budgetMs:3000};
 const claimKey={userId:'alice',reportType:'daily',localDateKey:'2026-10-10',expectedLifecycleGeneration:1};let oldOwner;
 const cancelled=new AbortController();
 const first=await runExecutionPhase({...common,signal:cancelled.signal,deps:{runBriefing:async()=>{
  const claim=await db.claimReport({...claimKey,ttlMs:150});assert.equal(claim.granted,true);oldOwner=claim.owner;
  assert.equal(await db.renewClaim({...claimKey,owner:oldOwner,ttlMs:150}),true);
  if(started)assert.equal(await db.authorizeReportDelivery({...claimKey,owner:oldOwner}),true);
  cancelled.abort();return {syncComplete:false,syncOutcome:'PARTIAL',users:1,failed:1};
 }}});assert.equal(first.body.result.resumable,true);await pause(180);let granted;
 const final=await runExecutionPhase({...common,deps:{runBriefing:async()=>{
  const claim=await db.claimReport({...claimKey,ttlMs:1500});granted=claim.granted;
  if(started){assert.equal(claim.granted,false);assert.equal(claim.ambiguous,true);}
  else{
   assert.equal(claim.granted,true);assert.notEqual(claim.owner,oldOwner);
   assert.equal(await db.renewClaim({...claimKey,owner:oldOwner,ttlMs:150}),false,'no stale true renewal receipt');
   assert.equal(await db.renewClaim({...claimKey,owner:claim.owner,ttlMs:150}),true);
   assert.equal(await db.authorizeReportDelivery({...claimKey,owner:oldOwner}),false);
   assert.equal(await db.authorizeReportDelivery({...claimKey,owner:claim.owner}),true);
   assert.equal(await db.markClaimSent({...claimKey,owner:claim.owner,messageId:101}),true);
  }return {syncComplete:true,syncOutcome:'NO_NEW_DATA_SUCCESS',users:1,failed:0};
 }}});assert.equal(final.status,200);assert.equal(granted,!started);
 const replay=await runExecutionPhase({...common,deps:{runBriefing:async()=>{throw Error('REPLAY_MUST_NOT_RUN');}}});assert.deepEqual(replay,final);
 const row=(await db.raw.execute("SELECT * FROM report_claims WHERE user_id='alice'")).rows[0];assert.equal(row.delivery_attempts,1);assert.equal(row.delivery_state,started?'DELIVERY_STARTED':'DELIVERED');
});

test('Report coordination pending cannot finalize a permanent failure',async t=>{
 const {db}=await deliveryFixture(t),environment={PHASE4_BETA_SHADOW_RUNTIME:'off',PHASE4_PUBLIC_BETA_MODE:'off'};
 const request={requestId:'p4c1_'+randomUUID(),releaseSha:runningReleaseSha(),phase:'SYNC',triggerSource:'cloudflare',executionMode:'OFF',configProof:configurationProof(fixtureKeys,publicBetaConfiguration(environment),environment)};
 const common={db,keys:fixtureKeys,request,body:canonicalPhaseRequest(request),environment,env:{dryRun:true}};
 const pending=await runExecutionPhase({...common,deps:{runBriefing:async()=>({coordinationPending:true,syncComplete:false,syncOutcome:'PARTIAL',users:1,failed:1})}});
 assert.equal(pending.status,202);assert.equal(pending.body.result.resumable,true);
 const row=(await db.raw.execute({sql:'SELECT state FROM phase4_executions WHERE execution_id=?',args:[request.requestId]})).rows[0];assert.equal(row.state,'ESTABLISHED');
 const final=await runExecutionPhase({...common,deps:{runBriefing:async()=>({syncComplete:true,syncOutcome:'NO_NEW_DATA_SUCCESS',users:1,failed:0})}});assert.equal(final.status,200);
});
