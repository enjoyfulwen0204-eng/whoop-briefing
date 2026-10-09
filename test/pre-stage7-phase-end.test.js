import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {deliveryFixture,fixtureKeys} from './deliveryDefaultFixture.js';import {runExecutionPhase} from '../src/phase4Execution.js';import {createCoach} from '../src/coach.js';
import {configurationProof,readExecution} from '../src/phase4ExecutionStore.js';import {runningReleaseSha} from '../src/phase4Release.js';import {publicBetaConfiguration} from '../src/publicBetaConfig.js';
const environment={PHASE4_BETA_SHADOW_RUNTIME:'off',PHASE4_PUBLIC_BETA_MODE:'off'},pause=ms=>new Promise(r=>setTimeout(r,ms));
const request=()=>({releaseSha:runningReleaseSha(),requestId:randomUUID(),phase:'SYNC',triggerSource:'cloudflare',executionMode:'OFF',configProof:configurationProof(fixtureKeys,publicBetaConfiguration(environment),environment)});
test('phase completion revokes nested Coach continuations even before the nominal work deadline',async t=>{
 const {db}=await deliveryFixture(t);let calls=0,pending,entered;const first=new Promise(r=>entered=r);
 const coach=createCoach({apiKey:'synthetic',model:'synthetic',env:{},maxRetries:3,backoffFor:()=>0,fetchImpl:async()=>{calls++;entered();await pause(100);return new Response('{"error":{"message":"temporary unavailable"}}',{status:503});}});
 const result=await runExecutionPhase({request:request(),db,keys:fixtureKeys,environment,env:{dryRun:true},budgetMs:5000,deps:{runBriefing:async()=>{pending=coach.ask({system:'synthetic',user:'synthetic'});await first;return {syncComplete:true,syncOutcome:'NO_NEW_DATA_SUCCESS',users:0,failed:0};}}});
 assert.equal(result.status,200);assert.equal(await pending,null);await pause(150);assert.equal(calls,1,'phase end cannot dispatch a second cached-fragment request');
});
test('production default continuation clock stays bound to durable creation across a changed calendar',async t=>{
 const {db}=await deliveryFixture(t),r=request(),seen=[];let retry=false;
 const deps={runBriefing:async({now})=>{seen.push(now.toISOString());return {syncComplete:retry,syncOutcome:retry?'NO_NEW_DATA_SUCCESS':'TIMEOUT',users:0,failed:0};}};
 const options={request:r,db,keys:fixtureKeys,environment,env:{dryRun:true},budgetMs:5000,deps};
 const first=await runExecutionPhase(options);assert.equal(first.status,202);const created=(await readExecution(db,r.requestId)).created_at;
 const OriginalDate=globalThis.Date;
 try{
  globalThis.Date=class extends OriginalDate{constructor(...args){super(...(args.length?args:[OriginalDate.now()+24*60*60_000]));}static now(){return OriginalDate.now();}};
  retry=true;const second=await runExecutionPhase(options);assert.equal(second.status,200,JSON.stringify(second));assert.deepEqual(seen,[new OriginalDate(created).toISOString(),new OriginalDate(created).toISOString()]);
 }finally{globalThis.Date=OriginalDate;}
});
test('standalone provider timeout never retries or accepts a late response',async()=>{
 let calls=0,release;const keepAlive=setInterval(()=>{},1000),late=new Promise(r=>release=r);
 const coach=createCoach({apiKey:'synthetic',model:'synthetic',env:{},maxRetries:3,fetchImpl:async()=>{calls++;return late;}});
 try{assert.equal(await coach.ask({system:'synthetic',user:'synthetic'}),null);assert.equal(calls,1);release(new Response('{"choices":[{"message":{"content":"late"}}]}'));await pause(20);assert.equal(calls,1);}
 finally{clearInterval(keepAlive);}
});
