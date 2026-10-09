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
