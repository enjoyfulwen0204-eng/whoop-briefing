import test from 'node:test';import assert from 'node:assert/strict';
import {invoke,MAX_CONFIGURED_WINDOW_MS} from '../cloudflare/briefing-scheduler/worker.js';
import {verifyTriggerRequest} from '../src/briefingTriggerAuth.js';
const env={BRIEFING_ENDPOINT_URL:'https://isolated.invalid/internal/briefing/run',BRIEFING_TRIGGER_SECRET:'synthetic-only-more-than-32-byte-secret',BRIEFING_RELEASE_SHA:'a'.repeat(40),BRIEFING_CONFIG_PROOF:'b'.repeat(64),BRIEFING_EXECUTION_MODE:'SHADOW',BRIEFING_CONTINUATION_DISCOVERY:'on',BRIEFING_CONTINUATION_SCOPE:'stage6-shadow'};
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
   if(path.endsWith('/continuation'))return response({ok:true,state:'FINALIZED_SUCCESS',requestBody:saved,workReceipts:12});
   const r=JSON.parse(init.body);phases.push(r.phase);
   if(r.phase==='SYNC')assert.equal(init.body,saved);else{assert.equal(r.syncRequestId,JSON.parse(saved).requestId);children.push(r.requestId);}
   return response(finalized(r));
  }});
  assert.equal(result.ok,true);assert.deepEqual(phases,['SYNC','STAGE6_DRAIN']);
 }
 assert.equal(children[0],children[1]);
});
test('ordinary SYNC keeps two attempts with scoped continuation and never obtains a partial handoff',async()=>{
 let clock=Date.now(),segments=0,drains=0;const bodies=[];
 await assert.rejects(()=>invoke(env,{now:()=>clock,sleep:async ms=>{clock+=ms;},fetchImpl:async(url,init)=>{
  if(url.endsWith('/continuation'))return response({ok:true,state:'NONE',requestBody:null});
  const r=JSON.parse(init.body);assert.equal(init.body,canonical(r));bodies.push(init.body);
  if(r.phase==='STAGE6_DRAIN')drains++;else segments++;
  assert.doesNotMatch(r.requestId,/^p4c1_/);clock+=121000;
  return response({ok:false,phase:'SYNC',source:'cloudflare',syncComplete:false,result:{resumable:true,retryAfterMs:15000,outcome:'TIMEOUT'}},202);
 }}),e=>e.category==='continuation_pending'&&e.resumable===true);
 assert.equal(segments,2);assert.equal(drains,0);assert.equal(bodies[0],bodies[1]);assert.equal(MAX_CONFIGURED_WINDOW_MS,561000);
});
test('unfinished SYNC discovery including acknowledged work fails closed without any phase request',async()=>{
 for(const state of ['IN_PROGRESS','INCOMPLETE_RESUMABLE','COMMIT_UNCERTAIN','WORK_COMMITTED_UNFINALIZED']){
  let phases=0;await assert.rejects(()=>invoke(env,{fetchImpl:async url=>{
   if(!url.endsWith('/continuation'))phases++;return response({ok:true,state,requestBody:saved});
  }}),e=>e.category==='invalid_discovery'&&e.nonRetryable===true);assert.equal(phases,0);
 }
});
test('invalid or failed discovery cannot fall back to an unrelated fresh mutation request',async()=>{
 for(const payload of [{ok:true,state:'NONE',requestBody:saved},{ok:true,state:'INCOMPLETE_RESUMABLE',requestBody:saved.replace('cloudflare','github')},{ok:true,state:'INCOMPLETE_RESUMABLE',requestBody:'{}'},{ok:false,error:'SYNTHETIC_PRIVATE_ERROR'}]){
  let phases=0;await assert.rejects(()=>invoke(env,{fetchImpl:async url=>{if(!new URL(url).pathname.endsWith('/continuation'))phases++;return response(payload);}}),e=>e.nonRetryable===true);
  assert.equal(phases,0);
 }
});
test('missing, malformed, disabled or OFF scope rejects before discovery or phase network',async()=>{
 for(const change of [{BRIEFING_CONTINUATION_SCOPE:undefined},{BRIEFING_CONTINUATION_SCOPE:'off'},{BRIEFING_CONTINUATION_SCOPE:'wrong'},{BRIEFING_EXECUTION_MODE:'OFF'},{BRIEFING_CONTINUATION_DISCOVERY:'off'}]){
  let calls=0;await assert.rejects(()=>invoke({...env,...change},{fetchImpl:async()=>{calls++;throw Error('NETWORK_FORBIDDEN');}}),e=>e.category==='configuration');assert.equal(calls,0);
 }
 const controller=new AbortController();let requests=0;
 const pending=invoke(env,{signal:controller.signal,fetchImpl:async()=>{requests++;return new Promise(()=>{});}});
 controller.abort();await assert.rejects(()=>pending);assert.ok(requests<=1);
});
test('recovered DRAIN uses exact saved bytes and never enters ordinary SYNC',async()=>{
 const child=canonical({...JSON.parse(saved),phase:'STAGE6_DRAIN',requestId:'p4c1_saved-drain-before-worker-death',syncRequestId:JSON.parse(saved).requestId,handoff:'c'.repeat(64)}),phases=[];
 const result=await invoke(env,{fetchImpl:async(url,init)=>{
  if(new URL(url).pathname.endsWith('/continuation'))return response({ok:true,state:'INCOMPLETE_RESUMABLE',requestBody:child,workReceipts:1});
  const r=JSON.parse(init.body);phases.push(r.phase);assert.equal(init.body,child);return response(finalized(r));
 }});
 assert.equal(result.ok,true);assert.deepEqual(phases,['STAGE6_DRAIN']);
});
test('cancellation during a retained-owner backoff ends immediately and emits no later POST',async()=>{
 const controller=new AbortController();let entered,calls=0;
 const sleeping=new Promise(resolve=>{entered=resolve;});
 const pending=invoke(env,{signal:controller.signal,sleep:async()=>{entered();return new Promise(()=>{});},fetchImpl:async url=>{
  calls++;return new URL(url).pathname.endsWith('/continuation')?response({ok:true,state:'INCOMPLETE_RESUMABLE',requestBody:canonical({...JSON.parse(saved),phase:'STAGE6_DRAIN',requestId:'p4c1_saved-drain-backoff',syncRequestId:JSON.parse(saved).requestId,handoff:'c'.repeat(64)})}):response({ok:false,error:'REQUEST_PENDING',retryAfterMs:225000},409);
 }});
 await sleeping;controller.abort();
 await assert.rejects(()=>Promise.race([pending,new Promise((_,reject)=>setTimeout(()=>reject(Error('CANCELLATION_DID_NOT_SETTLE')),200))]),e=>e.category==='cancelled');
 assert.equal(calls,2);
});

test('recovered DRAIN retains two identical attempts, re-signing, and no ordinary SYNC',async()=>{
 const child=canonical({...JSON.parse(saved),phase:'STAGE6_DRAIN',requestId:'p4c1_bounded-drain-retry',syncRequestId:JSON.parse(saved).requestId,handoff:'c'.repeat(64)});
 let clock=Date.now();const phases=[],signatures=[];
 await assert.rejects(()=>invoke(env,{now:()=>clock,sleep:async ms=>{clock+=ms;},fetchImpl:async(url,init)=>{
  if(url.endsWith('/continuation')){assert.equal(JSON.parse(init.body).scope,'stage6-shadow');return response({ok:true,state:'COMMIT_UNCERTAIN',requestBody:child});}
  phases.push(init.body);signatures.push(init.headers['x-briefing-signature']);
  return response({ok:false,phase:'STAGE6_DRAIN',source:'cloudflare',result:{resumable:true,retryAfterMs:15000,outcome:'COMMIT_INDETERMINATE'}},202);
 }}),e=>e.category==='continuation_pending'&&e.resumable===true);
 assert.deepEqual(phases,[child,child]);assert.notEqual(signatures[0],signatures[1]);
});
