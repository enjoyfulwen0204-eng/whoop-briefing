import test from 'node:test';import assert from 'node:assert/strict';import {invoke,MAX_RESPONSE_BYTES} from '../cloudflare/briefing-scheduler/worker.js';
const env={BRIEFING_ENDPOINT_URL:'https://synthetic.invalid/internal/briefing/run',BRIEFING_TRIGGER_SECRET:'synthetic-secret-with-at-least-32-bytes',
 BRIEFING_EXECUTION_MODE:'OFF',BRIEFING_CONFIG_PROOF:'a'.repeat(64),BRIEFING_RELEASE_SHA:'b'.repeat(40)};
const payload={ok:true,phase:'SYNC',source:'cloudflare',syncComplete:true,drainAuthorized:false,result:{settlementState:'FINALIZED_SUCCESS'}};const pause=ms=>new Promise(r=>setTimeout(r,ms));
for(const at of ['before','during','after'])test(`R2 signing: cancellation ${at} signing never starts fetch`,async()=>{
 const controller=new AbortController();let signs=0,fetches=0;if(at==='before')controller.abort();
 await assert.rejects(()=>invoke(env,{signal:controller.signal,signImpl:async()=>{signs++;if(at==='during')await pause(15);controller.abort();return 'unused';},
 fetchImpl:async()=>{fetches++;return new Response(JSON.stringify(payload));}}),e=>e.category==='cancelled');assert.equal(fetches,0);assert.equal(signs,at==='before'?0:1);
});
test('R2 signing: absolute caller deadline during uninterruptible sign ignores late result',async()=>{
 let fetches=0,signs=0;await assert.rejects(()=>invoke(env,{deadlineAt:Date.now()+20,timeoutMs:200,signImpl:async()=>{signs++;await pause(60);return 'late';},
 fetchImpl:async()=>{fetches++;}}),e=>e.category==='timeout');await pause(70);assert.equal(signs,1);assert.equal(fetches,0);
});
test('R2 signing: signing error starts no fetch; each attempt clock also bounds signing',async()=>{
 for(const mode of ['error','stall']){let fetches=0;await assert.rejects(()=>invoke(env,{timeoutMs:10,sleep:async()=>{},signImpl:async()=>{
 if(mode==='error')throw Error('synthetic sign failure');await pause(30);return 'late';},fetchImpl:async()=>{fetches++;}}));await pause(40);assert.equal(fetches,0);}
});
for(const boundary of ['headers','body'])test(`R2 signing: surviving caller cancellation reaches ${boundary}`,async()=>{
 const controller=new AbortController();let calls=0,cancelled=0;
 const pending=invoke(env,{signal:controller.signal,fetchImpl:async(_u,{signal})=>{calls++;assert.equal(signal.aborted,false);
 return boundary==='headers'?new Promise(()=>{}):new Response(new ReadableStream({cancel(){cancelled++;}}));}});
 await pause(15);controller.abort();await assert.rejects(()=>pending,e=>e.category==='cancelled');assert.equal(calls,1);if(boundary==='body')assert.equal(cancelled,1);
});
for(const extra of [0,1])test(`R2 transport: ${MAX_RESPONSE_BYTES+extra} response bytes ${extra?'reject':'pass'}`,async()=>{
 const base=JSON.stringify({...payload,pad:''}),body=JSON.stringify({...payload,pad:' '.repeat(MAX_RESPONSE_BYTES+extra-Buffer.byteLength(base))});
 assert.equal(Buffer.byteLength(body),MAX_RESPONSE_BYTES+extra);const pending=invoke(env,{fetchImpl:async()=>new Response(body)});
 if(extra)await assert.rejects(()=>pending,e=>e.category==='body_too_large');else assert.equal((await pending).ok,true);
});
test('R2 transport: slow drip is bounded by the whole attempt clock and cleans up',async()=>{
 let calls=0,cancels=0;await assert.rejects(()=>invoke(env,{timeoutMs:25,sleep:async()=>{},fetchImpl:async()=>{calls++;
 let timer;return new Response(new ReadableStream({start(c){timer=setInterval(()=>c.enqueue(new TextEncoder().encode(' ')),5);},cancel(){clearInterval(timer);cancels++;}}));}}),e=>e.category==='timeout');
 assert.equal(calls,2);assert.equal(cancels,2);
});
