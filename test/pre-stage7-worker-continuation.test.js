import test from 'node:test';import assert from 'node:assert/strict';
import {invoke,MAX_ATTEMPTS,MAX_CONFIGURED_WINDOW_MS} from '../cloudflare/briefing-scheduler/worker.js';
const env={BRIEFING_ENDPOINT_URL:'https://isolated.invalid/internal/briefing/run',BRIEFING_TRIGGER_SECRET:'synthetic-secret-with-more-than-32-bytes',BRIEFING_RELEASE_SHA:'a'.repeat(40),BRIEFING_CONFIG_PROOF:'b'.repeat(64),BRIEFING_EXECUTION_MODE:'SHADOW'};
const response=x=>new Response(JSON.stringify(x),{status:x.result.resumable?202:200});
for(const mode of ['resume','exhausted','bad-delay','wrong-source'])test(`Worker same identity continuation: ${mode}`,async()=>{
 let clock=Date.now(),calls=[],waits=[];
 const run=()=>invoke(env,{now:()=>clock,sleep:async ms=>{waits.push(ms);clock+=ms;},fetchImpl:async(_url,init)=>{
  const r=JSON.parse(init.body);calls.push(init.body);
  if(mode==='resume' && calls.length>1)return response({ok:true,phase:r.phase,source:'cloudflare',syncComplete:true,drainAuthorized:r.phase==='SYNC',handoff:'c'.repeat(64),result:{settlementState:'FINALIZED_SUCCESS',outcome:'COMPLETE'}});
  return response({ok:false,phase:r.phase,source:mode==='wrong-source'?'manual':'cloudflare',syncComplete:false,result:{resumable:true,retryAfterMs:mode==='bad-delay'?999999:15000,outcome:'TIMEOUT'}});
 }});
 if(mode==='resume'){const out=await run();assert.equal(out.ok,true);assert.equal(calls[0],calls[1]);assert.equal(JSON.parse(calls[2]).phase,'STAGE6_DRAIN');assert.deepEqual(waits,[15000]);}
 else {await assert.rejects(run(),e=>mode==='exhausted'?e.resumable===true:e.nonRetryable===true);assert.equal(calls.length,mode==='exhausted'?MAX_ATTEMPTS:1);assert.ok(calls.every(x=>JSON.parse(x).phase==='SYNC'));}
 assert.ok(clock-Date.now()<MAX_CONFIGURED_WINDOW_MS);
});

for(const code of ['REQUEST_PENDING','REQUEST_SCOPE_PENDING'])test('Worker preserves bounded coordination pending across caller exhaustion: '+code,async()=>{
 let clock=Date.now(),calls=0;const bodies=[];
 await assert.rejects(()=>invoke({...env,BRIEFING_CONTINUATION_DISCOVERY:'on'},{now:()=>clock,sleep:async ms=>{clock+=ms;},fetchImpl:async(url,init)=>{
  if(url.endsWith('/continuation'))return new Response(JSON.stringify({ok:true,state:'NONE',requestBody:null}));
  calls++;bodies.push(init.body);return new Response(JSON.stringify({ok:false,error:code,retryAfterMs:225000}),{status:409});
 }}),e=>e.category==='continuation_pending'&&e.resumable===true);
 assert.equal(calls,3);assert.ok(bodies.every(b=>b===bodies[0]));assert.ok(clock-Date.now()<MAX_CONFIGURED_WINDOW_MS);
});
test('Worker does not convert a conflicting identity into coordination pending',async()=>{
 let calls=0;await assert.rejects(()=>invoke({...env,BRIEFING_CONTINUATION_DISCOVERY:'on'},{fetchImpl:async(url)=>{
  if(url.endsWith('/continuation'))return new Response(JSON.stringify({ok:true,state:'NONE',requestBody:null}));
  calls++;return new Response(JSON.stringify({ok:false,error:'REQUEST_ID_CONFLICT'}),{status:409});
 }}),e=>e.category==='http_4xx'&&e.nonRetryable===true);assert.equal(calls,1);
});
