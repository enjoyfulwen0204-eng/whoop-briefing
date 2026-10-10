import test from 'node:test';import assert from 'node:assert/strict';import {AsyncResource} from 'node:async_hooks';import {randomUUID} from 'node:crypto';
import {deliveryFixture,fixtureKeys,openHttpFixture} from './deliveryDefaultFixture.js';import {createCoach} from '../src/coach.js';
import {runExecutionPhase} from '../src/phase4Execution.js';import {configurationProof,canonicalPhaseRequest} from '../src/phase4ExecutionStore.js';
import {runningReleaseSha} from '../src/phase4Release.js';import {publicBetaConfiguration} from '../src/publicBetaConfig.js';import {withSyncOwnership} from '../src/syncOwnership.js';import {currentExecutionBudget} from '../src/executionBudget.js';
for(const [mode,revocation] of [['retry','disable'],['parameter','disable'],['fallback','disable'],['late','disable'],['retry','lifecycle_aba'],['retry','reauthorize'],['retry','purge'],['retry','snapshot']])test(`F01: per-user Coach ${mode} after ${revocation}`,async t=>{
 const {db,url}=await deliveryFixture(t);await db.admitRuntime();await db.createUser({id:'alice',status:'ACTIVE',displayName:'Alice'});await db.getCapabilities('alice');
 const operator=openHttpFixture(url);t.after(()=>operator.close());await operator.db.admitRuntime();const external=new AsyncResource('independent-operator');t.after(()=>external.emitDestroy());
 const environment={PHASE4_BETA_SHADOW_RUNTIME:'off',PHASE4_PUBLIC_BETA_MODE:'off'};
 const request={requestId:`p4c1_${randomUUID()}`,releaseSha:runningReleaseSha(),phase:'SYNC',triggerSource:'cloudflare',executionMode:'OFF',configProof:configurationProof(fixtureKeys,publicBetaConfiguration(environment),environment)};
 if(revocation==='reauthorize')await db.saveTokens('alice',{accessToken:'synthetic-before',refreshToken:'synthetic-before',expiresAt:new Date(Date.now()+3600000),whoopUserId:'12345'});
 const requests=[];let revokedAt,answer;
 const result=await runExecutionPhase({request,body:canonicalPhaseRequest(request),db,keys:fixtureKeys,environment,env:{dryRun:true},budgetMs:5000,deps:{runBriefing:async()=>{
  await withSyncOwnership({db,userId:'alice',budget:currentExecutionBudget()},async()=>{
   const coach=createCoach({apiKey:'synthetic',model:'synthetic',env:mode==='fallback'?{MODEL_QA:'synthetic-missing'}:{},db,userId:'alice',maxRetries:2,backoffFor:()=>0,fetchImpl:async(_url,init)=>{
    requests.push({at:Date.now(),body:JSON.parse(init.body),aborted:init.signal.aborted});
    if(requests.length===1){await external.runInAsyncScope(async()=>{
     if(['purge','snapshot'].includes(revocation))await operator.db.raw.execute({sql:`UPDATE phase4_user_state SET ${revocation==='purge'?'purge_generation':'source_generation'}=${revocation==='purge'?'purge_generation':'source_generation'}+1 WHERE user_id=?`,args:['alice']});
     else if(revocation==='reauthorize')await operator.db.saveTokens('alice',{accessToken:'synthetic-after',refreshToken:'synthetic-after',expiresAt:new Date(Date.now()+3600000),whoopUserId:'12345'},{bumpAuthGeneration:true,expectedLifecycleGeneration:1});
     else{await operator.db.transitionUserLifecycle({userId:'alice',targetStatus:'DISABLED'});if(revocation==='lifecycle_aba')await operator.db.transitionUserLifecycle({userId:'alice',targetStatus:'ACTIVE'});}
    });revokedAt=Date.now();if(mode!=='late')return new Response(JSON.stringify({error:{message:mode==='fallback'?'model not found':'synthetic parameter rejection'}}),{status:mode==='parameter'?400:mode==='fallback'?404:503});}
    return new Response(JSON.stringify({choices:[{message:{content:'synthetic'}}]}));
   }});
   answer=await coach.ask({system:'synthetic',user:'synthetic private recovery fragment'});
  });return {syncComplete:false,syncOutcome:'PARTIAL',users:1,failed:1};
 }}});
 if(revocation==='disable')assert.equal((await operator.db.getUser('alice')).status,'DISABLED');
 if(revocation==='lifecycle_aba')assert.equal((await operator.db.getUser('alice')).lifecycleGeneration,3);
 if(revocation==='reauthorize')assert.equal((await operator.db.getTokens('alice')).authGeneration,2);
 assert.equal(requests.length,1,'no retransmission after observed revocation');assert.equal(answer,null,'late health result rejected');
 console.log('COUNTEREXAMPLE '+JSON.stringify({issue:'COACH_TENANT_REVOCATION',mode,revocation,providerCalls:requests.length,newCallAfterRevocation:false,lateResultAccepted:false,phaseStatus:result.status}));
});
for(const change of ['source_generation','purge_generation'])test('F01 originating snapshot changes before initial dispatch: '+change,async t=>{
 const {db}=await deliveryFixture(t);await db.createUser({id:'alice',displayName:'Alice',status:'ACTIVE'});let dispatches=0;
 const coach=createCoach({apiKey:'synthetic',db,userId:'alice',fetchImpl:async()=>{dispatches++;throw Error('FORBIDDEN_PROVIDER');}});
 const bound=await coach.bindSnapshot();await db.raw.execute(`UPDATE phase4_user_state SET ${change}=${change}+1 WHERE user_id='alice'`);
 assert.equal(await bound.ask({system:'synthetic',user:'cached synthetic health'}),null);assert.equal(dispatches,0);
});
test('F01 inflight observation aborts provider and leaves a second tenant healthy',async t=>{
 const {db,url}=await deliveryFixture(t);for(const id of ['alice','bob'])await db.createUser({id,displayName:id,status:'ACTIVE'});
 const operator=openHttpFixture(url);t.after(()=>operator.close());let calls=0,providerSignal;const external=new AsyncResource('operator');t.after(()=>external.emitDestroy());
 const alice=createCoach({apiKey:'synthetic',db,userId:'alice',fetchImpl:async(_url,init)=>{calls++;providerSignal=init.signal;
   await external.runInAsyncScope(()=>operator.db.transitionUserLifecycle({userId:'alice',targetStatus:'DISABLED'}));return new Promise(()=>{});
 }});
 const bob=createCoach({apiKey:'synthetic',db,userId:'bob',fetchImpl:async()=>new Response(JSON.stringify({choices:[{message:{content:'healthy bob'}}]}))});
 const results=await Promise.all([alice.ask({system:'synthetic',user:'alice private'}),bob.ask({system:'synthetic',user:'bob private'})]);
 assert.deepEqual(results,[null,'healthy bob']);assert.equal(calls,1);assert.equal(providerSignal.aborted,true);
});
