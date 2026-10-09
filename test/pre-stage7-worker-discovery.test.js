import test from 'node:test';import assert from 'node:assert/strict';
import {invoke,MAX_CONFIGURED_WINDOW_MS} from '../cloudflare/briefing-scheduler/worker.js';
import {verifyTriggerRequest} from '../src/briefingTriggerAuth.js';
const env={BRIEFING_ENDPOINT_URL:'https://isolated.invalid/internal/briefing/run',BRIEFING_TRIGGER_SECRET:'synthetic-only-more-than-32-byte-secret',BRIEFING_RELEASE_SHA:'a'.repeat(40),BRIEFING_CONFIG_PROOF:'b'.repeat(64),BRIEFING_EXECUTION_MODE:'SHADOW',BRIEFING_CONTINUATION_DISCOVERY:'on'};
const canonical=r=>JSON.stringify(Object.fromEntries(Object.keys(r).sort().map(k=>[k,r[k]])));
const saved=canonical({releaseSha:env.BRIEFING_RELEASE_SHA,requestId:'saved-request-identity-before-worker-death',phase:'SYNC',triggerSource:'cloudflare',executionMode:'SHADOW',configProof:env.BRIEFING_CONFIG_PROOF});
const response=(body,status=200)=>new Response(JSON.stringify(body),{status});
const finalized=r=>({ok:true,phase:r.phase,source:'cloudflare',syncComplete:r.phase==='SYNC',drainAuthorized:r.phase==='SYNC',handoff:'c'.repeat(64),result:{settlementState:'FINALIZED_SUCCESS',outcome:'COMPLETE'}});
test('new Worker invocation rediscovers exact saved bytes and uses a stable DRAIN identity',async()=>{
 const children=[];
 for(let invocation=0;invocation<2;invocation++){
  const phases=[];
  const result=await invoke(env,{fetchImpl:async(url,init)=>{
   const path=new URL(url).pathname,h=init.headers;
   assert.equal(verifyTriggerRequest({timestamp:h['x-briefing-timestamp'],requestId:h['x-briefing-request-id'],method:'POST',path,body:init.body,signature:h['x-briefing-signature'],secret:env.BRIEFING_TRIGGER_SECRET}).ok,true);
   if(path.endsWith('/continuation'))return response({ok:true,state:'INCOMPLETE_RESUMABLE',requestBody:saved,workReceipts:12});
   const r=JSON.parse(init.body);phases.push(r.phase);
   if(r.phase==='SYNC')assert.equal(init.body,saved);else{assert.equal(r.syncRequestId,JSON.parse(saved).requestId);children.push(r.requestId);}
   return response(finalized(r));
  }});
  assert.equal(result.ok,true);assert.deepEqual(phases,['SYNC','STAGE6_DRAIN']);
 }
 assert.equal(children[0],children[1]);
});
test('four bounded SYNC segments and DRAIN fit the unchanged 561-second Worker window',async()=>{
 const started=Date.now();let clock=started,segments=0,calls=0;
 const result=await invoke(env,{now:()=>clock,sleep:async ms=>{clock+=ms;},fetchImpl:async(url,init)=>{
  calls++;if(new URL(url).pathname.endsWith('/continuation')){clock+=2000;return response({ok:true,state:'NONE',requestBody:null});}
  const r=JSON.parse(init.body);assert.equal(init.body,canonical(r));
  if(r.phase==='SYNC'){segments++;clock+=segments<=3?121000:70000;
   if(segments<=3)return response({ok:false,phase:'SYNC',source:'cloudflare',syncComplete:false,result:{resumable:true,retryAfterMs:15000,outcome:'TIMEOUT'}},202);
  }else clock+=50000;
  return response(finalized(r));
 }});
 assert.equal(result.ok,true);assert.equal(segments,4);assert.equal(calls,6);assert.equal(MAX_CONFIGURED_WINDOW_MS,561000);assert.equal(clock-started,530000);
});
test('window exhaustion leaves a resumable identity and never authorizes DRAIN',async()=>{
 let clock=Date.now(),phases=0,drains=0;
 await assert.rejects(()=>invoke(env,{now:()=>clock,sleep:async ms=>{clock+=ms;},fetchImpl:async(url,init)=>{
  if(new URL(url).pathname.endsWith('/continuation'))return response({ok:true,state:'INCOMPLETE_RESUMABLE',requestBody:saved});
  const r=JSON.parse(init.body);if(r.phase==='STAGE6_DRAIN')drains++;phases++;clock+=121000;
  return response({ok:false,phase:'SYNC',source:'cloudflare',syncComplete:false,result:{resumable:true,retryAfterMs:15000,outcome:'TIMEOUT'}},202);
 }}),e=>e.category==='timeout');
 assert.equal(drains,0);assert.ok(phases<=5);
});
test('invalid or failed discovery cannot fall back to an unrelated fresh mutation request',async()=>{
 for(const payload of [{ok:true,state:'NONE',requestBody:saved},{ok:true,state:'INCOMPLETE_RESUMABLE',requestBody:saved.replace('cloudflare','github')},{ok:true,state:'INCOMPLETE_RESUMABLE',requestBody:'{}'},{ok:false,error:'SYNTHETIC_PRIVATE_ERROR'}]){
  let phases=0;await assert.rejects(()=>invoke(env,{fetchImpl:async url=>{if(!new URL(url).pathname.endsWith('/continuation'))phases++;return response(payload);}}),e=>e.nonRetryable===true);
  assert.equal(phases,0);
 }
});
test('live-owner wait is bounded by the original Worker deadline and cancellation stops discovery',async()=>{
 let clock=Date.now(),waits=[],calls=0;
 const result=await invoke({...env,BRIEFING_EXECUTION_MODE:'OFF'},{now:()=>clock,sleep:async ms=>{waits.push(ms);clock+=ms;},fetchImpl:async(url,init)=>{
  if(new URL(url).pathname.endsWith('/continuation'))return response({ok:true,state:'NONE',requestBody:null});
  calls++;const r=JSON.parse(init.body);
  if(calls===1)return response({ok:false,error:'REQUEST_PENDING',retryAfterMs:120000},409);
  return response({...finalized(r),drainAuthorized:false});
 }});
 assert.equal(result.ok,true);assert.deepEqual(waits,[120000]);
 const controller=new AbortController();let requests=0;
 const pending=invoke(env,{signal:controller.signal,fetchImpl:async()=>{requests++;return new Promise(()=>{});}});
 controller.abort();await assert.rejects(()=>pending);assert.ok(requests<=1);
});
test('recovered DRAIN uses exact saved bytes and never enters ordinary SYNC',async()=>{
 const child=canonical({...JSON.parse(saved),phase:'STAGE6_DRAIN',requestId:'saved-drain-before-worker-death',syncRequestId:JSON.parse(saved).requestId,handoff:'c'.repeat(64)}),phases=[];
 const result=await invoke(env,{fetchImpl:async(url,init)=>{
  if(new URL(url).pathname.endsWith('/continuation'))return response({ok:true,state:'INCOMPLETE_RESUMABLE',requestBody:child,workReceipts:1});
  const r=JSON.parse(init.body);phases.push(r.phase);assert.equal(init.body,child);return response(finalized(r));
 }});
 assert.equal(result.ok,true);assert.deepEqual(phases,['STAGE6_DRAIN']);
});
