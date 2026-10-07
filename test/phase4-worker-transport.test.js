import test from 'node:test';import assert from 'node:assert/strict';
import {invoke,MAX_ATTEMPTS,MAX_RESPONSE_BYTES,MAX_CONFIGURED_WINDOW_MS} from '../cloudflare/briefing-scheduler/worker.js';
import {verifyTriggerRequest,BRIEFING_TRIGGER} from '../src/briefingTriggerAuth.js';
const secret='synthetic-secret-with-at-least-32-bytes',env={BRIEFING_ENDPOINT_URL:'https://synthetic.invalid/internal/briefing/run',BRIEFING_TRIGGER_SECRET:secret,
 BRIEFING_EXECUTION_MODE:'OFF',BRIEFING_RELEASE_SHA:'b'.repeat(40),BRIEFING_CONFIG_PROOF:'a'.repeat(64)};
const response=(body,status=200)=>new Response(JSON.stringify(body),{status});
const ok=(phase='SYNC',extra={})=>({ok:true,phase,source:'cloudflare',syncComplete:true,drainAuthorized:false,...extra,result:{...extra.result,settlementState:'FINALIZED_SUCCESS'}});
const delay=ms=>new Promise(r=>setTimeout(r,ms));
for(const boundary of ['headers','body'])test(`Worker overall transport timeout covers stalled ${boundary}, abort and bounded retries`,async()=>{
 let calls=0,aborts=0,cancels=0;
 await assert.rejects(()=>invoke(env,{timeoutMs:20,signImpl:async()=> 'synthetic-signed-transport-seam',sleep:async()=>{},fetchImpl:async(_url,{signal})=>{calls++;signal.addEventListener('abort',()=>aborts++);
  return boundary==='headers'?new Promise(()=>{}):new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('{'));},cancel(){cancels++;}}));
 }}),e=>e.category==='timeout');assert.equal(calls,MAX_ATTEMPTS);assert.equal(aborts,MAX_ATTEMPTS);if(boundary==='body')assert.equal(cancels,MAX_ATTEMPTS);
});
test('oversized endless body is cancelled before materializing arbitrary text',async()=>{
 let reads=0,cancelled=false,calls=0;
 await assert.rejects(()=>invoke(env,{timeoutMs:100,sleep:async()=>{},fetchImpl:async()=>{calls++;return new Response(new ReadableStream({
  pull(c){reads++;c.enqueue(new Uint8Array(1024));},cancel(){cancelled=true;}}));}}),e=>e.category==='body_too_large');
 assert.equal(calls,1);assert.equal(cancelled,true);assert.ok(reads<=MAX_RESPONSE_BYTES/1024+3);
});
test('completion before deadline succeeds and late success cannot turn timeout into success or authorize drain',async()=>{
 const success=await invoke(env,{timeoutMs:100,fetchImpl:async()=>{await delay(30);return response(ok());}});assert.equal(success.ok,true);
 let calls=0,drains=0;
 await assert.rejects(()=>invoke({...env,BRIEFING_EXECUTION_MODE:'SHADOW'},{timeoutMs:20,signImpl:async()=> 'synthetic-signed-transport-seam',sleep:async()=>{},fetchImpl:async(_url,{body})=>{
  calls++;if(JSON.parse(body).phase==='STAGE6_DRAIN')drains++;await delay(50);return response(ok('SYNC',{drainAuthorized:true,handoff:'b'.repeat(64)}));
 }}),e=>e.category==='timeout');await delay(60);assert.equal(calls,2);assert.equal(drains,0);
});
test('external abort stops retries and reader cleanup',async()=>{
 const controller=new AbortController();let calls=0,cancels=0;
 const pending=invoke(env,{timeoutMs:1000,signal:controller.signal,sleep:async()=>{},fetchImpl:async()=>{calls++;return new Response(new ReadableStream({cancel(){cancels++;}}));}});
 await delay(10);controller.abort();await assert.rejects(()=>pending,e=>e.category==='cancelled');assert.equal(calls,1);assert.equal(cancels,1);
});
test('failed sync and HTTP 207 never authorize drain, including misleading HTTP 200',async()=>{
 for(const status of [200,207,424]){const phases=[];await assert.rejects(()=>invoke({...env,BRIEFING_EXECUTION_MODE:'SHADOW'},{sleep:async()=>{},fetchImpl:async(_u,{body})=>{
  phases.push(JSON.parse(body).phase);return response({ok:false,phase:'SYNC',syncComplete:false,drainAuthorized:true},status);
 }}));assert.deepEqual(phases,['SYNC']);}
});
test('v32 Worker blocks unfinalized success and retries indeterminate SYNC without ever entering drain',async()=>{
 for(const state of ['WORK_COMMITTED','ESTABLISHED',undefined]){
  let drains=0;await assert.rejects(()=>invoke({...env,BRIEFING_EXECUTION_MODE:'SHADOW'},{sleep:async()=>{},fetchImpl:async(_u,{body})=>{
   if(JSON.parse(body).phase==='STAGE6_DRAIN')drains++;
   return response({...ok(),drainAuthorized:true,result:{settlementState:state}});
  }}));assert.equal(drains,0);
 }
 let attempts=0;await assert.rejects(()=>invoke({...env,BRIEFING_EXECUTION_MODE:'SHADOW'},{sleep:async()=>{},fetchImpl:async(_u,{body})=>{
  attempts++;assert.equal(JSON.parse(body).phase,'SYNC');return response({ok:false,phase:'SYNC',syncComplete:false,drainAuthorized:false,result:{outcome:'COMMIT_INDETERMINATE'}},503);
 }}));assert.equal(attempts,2);
});
test('Worker default whole invocation ceiling also bounds retry backoff',async()=>{
 let clock=0,calls=0;await assert.rejects(()=>invoke(env,{now:()=>clock,signImpl:async()=> 'synthetic-signature',
  sleep:async()=>{clock=MAX_CONFIGURED_WINDOW_MS+1;},fetchImpl:async()=>{calls++;return response({ok:false},503);}}),error=>error.category==='timeout');
 assert.equal(calls,1);
});
test('authenticated retries bind exact phase/body; legitimate sync then drain uses distinct identities and a 561s maximum',async()=>{
 const requests=[];let fail=true;
 const result=await invoke({...env,BRIEFING_EXECUTION_MODE:'SHADOW'},{sleep:async()=>{},fetchImpl:async(_url,options)=>{
  requests.push(options);const request=JSON.parse(options.body);
  const h=options.headers;assert.equal(verifyTriggerRequest({timestamp:h['x-briefing-timestamp'],requestId:h['x-briefing-request-id'],method:'POST',path:BRIEFING_TRIGGER.PATH,
   body:options.body,signature:h['x-briefing-signature'],secret,now:Number(h['x-briefing-timestamp'])}).ok,true);
  assert.equal(options.redirect,'manual');if(fail){fail=false;return response({ok:false},503);}
  return response(request.phase==='SYNC'?ok('SYNC',{drainAuthorized:true,handoff:'b'.repeat(64)}):ok('STAGE6_DRAIN',{result:{outcome:'PARTIAL'}}));
 }});
 assert.equal(result.phase,'STAGE6_DRAIN');assert.equal(requests.length,3);assert.equal(requests[0].body,requests[1].body);
 assert.notEqual(requests[1].headers['x-briefing-request-id'],requests[2].headers['x-briefing-request-id']);
 assert.equal(JSON.parse(requests[2].body).syncRequestId,JSON.parse(requests[1].body).requestId);assert.equal(MAX_CONFIGURED_WINDOW_MS,561000);
 assert.ok(MAX_CONFIGURED_WINDOW_MS<10*60000-30000);
});
test('redirects, bad endpoint/config and error payloads remain terminal and private',async()=>{
 for(const status of [301,302,307,308,401,403,400]){let calls=0;await assert.rejects(()=>invoke(env,{fetchImpl:async()=>{calls++;return new Response('secret-bearing arbitrary text',{status});}}),e=>{
  assert.doesNotMatch(e.message,/secret-bearing/);return e.nonRetryable;});assert.equal(calls,1);}
 for(const url of ['http://synthetic.invalid/internal/briefing/run','https://placeholder.invalid/internal/briefing/run','https://synthetic.invalid/other','https://synthetic.invalid/internal/briefing/run?q=1']){
  let calls=0;await assert.rejects(()=>invoke({...env,BRIEFING_ENDPOINT_URL:url},{fetchImpl:async()=>{calls++;}}),e=>e.category==='configuration');assert.equal(calls,0);}
});
