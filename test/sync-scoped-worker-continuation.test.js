import test from 'node:test';
import assert from 'node:assert/strict';
import {invoke,signRequest,MAX_ATTEMPTS,MAX_SYNC_CONTINUATION_SEGMENTS,MAX_CONFIGURED_WINDOW_MS} from '../cloudflare/briefing-scheduler/worker.js';

const base={BRIEFING_ENDPOINT_URL:'https://isolated.invalid/internal/briefing/run',
 BRIEFING_TRIGGER_SECRET:'synthetic-only-scoped-worker-secret-32bytes',BRIEFING_RELEASE_SHA:'a'.repeat(40),
 BRIEFING_CONFIG_PROOF:'b'.repeat(64),BRIEFING_EXECUTION_MODE:'SHADOW',BRIEFING_CONTINUATION_DISCOVERY:'on'};
const canonical=value=>JSON.stringify(Object.fromEntries(Object.keys(value).sort().map(key=>[key,value[key]])));
const response=(body,status=200)=>new Response(JSON.stringify(body),{status});
const partial=()=>({ok:false,phase:'SYNC',source:'cloudflare',syncComplete:false,drainAuthorized:false,
 result:{outcome:'PARTIAL',resumable:true,continuationState:'INCOMPLETE_RESUMABLE',retryAfterMs:0,yieldReason:'COMPLETED_UNITS_BUDGET',users:3,failed:3}});
const complete=(drain=false)=>({ok:true,phase:'SYNC',source:'cloudflare',syncComplete:true,drainAuthorized:drain,
 ...(drain?{handoff:'c'.repeat(64)}:{}),result:{outcome:'NO_NEW_DATA_SUCCESS',settlementState:'FINALIZED_SUCCESS'}});
const savedRequest=(overrides={})=>({requestId:'p4s1_saved-scoped-sync-exact-body',releaseSha:base.BRIEFING_RELEASE_SHA,
 configProof:base.BRIEFING_CONFIG_PROOF,executionMode:base.BRIEFING_EXECUTION_MODE,triggerSource:'cloudflare',phase:'SYNC',...overrides});
function harness(scope,{mode='SHADOW',discovery={ok:true,state:'NONE',requestBody:null},onPhase,signal}={}){
 const env={...base,BRIEFING_CONTINUATION_SCOPE:scope,BRIEFING_EXECUTION_MODE:mode};
 const started=Date.now(),calls=[],waits=[],timers=[];let clock=started,discovered=0;
 const options={now:()=>clock,signal,setTimer:(_fn,ms)=>{timers.push(ms);return {};},clearTimer:()=>{},
  sleep:async ms=>{waits.push(ms);clock+=ms;},fetchImpl:async(url,init)=>{
   assert.equal(init.redirect,'manual');
   assert.equal(init.headers['x-briefing-signature'],await signRequest({timestamp:init.headers['x-briefing-timestamp'],
    requestId:init.headers['x-briefing-request-id'],method:'POST',path:new URL(url).pathname,body:init.body},env.BRIEFING_TRIGGER_SECRET));
   if(url.endsWith('/continuation')){discovered++;assert.equal(JSON.parse(init.body).scope,scope);return response(discovery);}
   const request=JSON.parse(init.body);assert.equal(init.body,canonical(request));
   assert.equal(init.headers['x-briefing-request-id'],request.requestId);
   calls.push({request,body:init.body,timestamp:init.headers['x-briefing-timestamp'],signature:init.headers['x-briefing-signature']});
   return onPhase?.(request,calls.length,{advance:ms=>{clock+=ms;}})??response(complete());
  }};
 return {env,options,calls,waits,timers,run:()=>invoke(env,options),elapsed:()=>clock-started,discovered:()=>discovered};
}

for(const mode of ['OFF','SHADOW'])test(`explicit sync scope completes its third acknowledged leg in ${mode} without Stage6`,async()=>{
 const f=harness('sync',{mode,onPhase:(_request,count)=>response(count<3?partial():complete(true),count<3?202:200)});
 const result=await f.run();assert.equal(result.ok,true);assert.equal(result.phase,'SYNC');assert.equal(result.drain,'DISABLED');
 assert.equal(result.attempt,MAX_SYNC_CONTINUATION_SEGMENTS);assert.equal(f.calls.length,3);assert.equal(f.discovered(),1);
 assert.ok(f.calls.every(call=>call.request.phase==='SYNC'&&/^p4s1_/.test(call.request.requestId)&&call.request.executionMode===mode));
 assert.ok(f.calls.every(call=>call.body===f.calls[0].body));assert.deepEqual(f.waits,[500,1000]);
 assert.equal(new Set(f.calls.map(call=>call.timestamp)).size,3);assert.equal(new Set(f.calls.map(call=>call.signature)).size,3);
 assert.ok(f.elapsed()<MAX_CONFIGURED_WINDOW_MS);
});

test('combined scope reaches Stage6 only after the third finalized complete SYNC and retains two DRAIN legs',async()=>{
 let syncs=0,drains=0;
 const f=harness('sync-and-stage6-shadow',{onPhase:request=>{
  if(request.phase==='SYNC'){syncs++;return response(syncs<3?partial():complete(true),syncs<3?202:200);}
  drains++;assert.equal(syncs,3);assert.match(request.requestId,/^p4c1_/);assert.equal(request.syncRequestId,f.calls[0].request.requestId);
  assert.equal(request.handoff,'c'.repeat(64));
  return response(drains===1?{ok:false,phase:'STAGE6_DRAIN',source:'cloudflare',result:{resumable:true,retryAfterMs:15000,outcome:'TIMEOUT'}}:
   {ok:true,phase:'STAGE6_DRAIN',source:'cloudflare',result:{outcome:'NO_WORK',settlementState:'FINALIZED_SUCCESS'}},drains===1?202:200);
 }});
 const result=await f.run();assert.equal(result.phase,'STAGE6_DRAIN');assert.equal(f.calls.length,5);
 assert.ok(f.calls.slice(0,3).every(call=>call.body===f.calls[0].body));assert.equal(f.calls[3].body,f.calls[4].body);
 assert.notEqual(f.calls[0].request.requestId,f.calls[3].request.requestId);
});

for(const scope of ['sync','sync-and-stage6-shadow'])for(const state of ['IN_PROGRESS','INCOMPLETE_RESUMABLE','COMMIT_UNCERTAIN','WORK_COMMITTED_UNFINALIZED','FINALIZED_SUCCESS'])
 test(`scoped discovery ${scope}/${state} re-signs exact saved SYNC bytes`,async()=>{
  const body=canonical(savedRequest()),f=harness(scope,{discovery:{ok:true,state,requestBody:body}});
  const result=await f.run();assert.equal(result.phase,'SYNC');assert.equal(f.calls.length,1);assert.equal(f.calls[0].body,body);
  assert.equal(f.calls[0].request.requestId,savedRequest().requestId);
 });

test('known PARTIAL stays resumable after three legs and never starts DRAIN',async()=>{
 const f=harness('sync-and-stage6-shadow',{onPhase:()=>response(partial(),202)});
 await assert.rejects(f.run(),e=>e.category==='continuation_pending'&&e.resumable===true);
 assert.equal(f.calls.length,3);assert.ok(f.calls.every(call=>call.request.phase==='SYNC'&&call.body===f.calls[0].body));
});

test('sync-only OFF discovery resumes exact unfinished identity without gaining Stage6 authority',async()=>{
 const body=canonical(savedRequest({executionMode:'OFF'})),f=harness('sync',{mode:'OFF',discovery:{ok:true,state:'INCOMPLETE_RESUMABLE',requestBody:body}});
 assert.equal((await f.run()).drain,'DISABLED');assert.equal(f.calls.length,1);assert.equal(f.calls[0].body,body);
});

test('combined scope can recover a saved DRAIN without beginning another SYNC',async()=>{
 const body=canonical(savedRequest({phase:'STAGE6_DRAIN',requestId:'p4c1_recovered-combined-drain',syncRequestId:savedRequest().requestId,handoff:'c'.repeat(64)}));
 const f=harness('sync-and-stage6-shadow',{discovery:{ok:true,state:'COMMIT_UNCERTAIN',requestBody:body},onPhase:()=>response({ok:true,phase:'STAGE6_DRAIN',source:'cloudflare',result:{outcome:'NO_WORK',settlementState:'FINALIZED_SUCCESS'}})});
 assert.equal((await f.run()).phase,'STAGE6_DRAIN');assert.equal(f.calls.length,1);assert.equal(f.calls[0].body,body);
});

test('a fresh same-body reconciliation acknowledgement after an unknown response permits the third known leg',async()=>{
 const f=harness('sync',{onPhase:(_request,count)=>{
  if(count===1)throw new TypeError('Synthetic acknowledgement unavailable');
  return response(count===2?partial():complete(),count===2?202:200);
 }});
 assert.equal((await f.run()).attempt,3);assert.ok(f.calls.every(call=>call.body===f.calls[0].body));
 assert.equal(new Set(f.calls.map(call=>call.signature)).size,3);
});

for(const kind of ['transport','indeterminate','partial-then-transport'])test(`scoped SYNC does not add a blind third attempt after ${kind}`,async()=>{
 const f=harness('sync',{onPhase:(_request,count)=>{
  if(kind==='partial-then-transport'&&count===1)return response(partial(),202);
  if(kind==='indeterminate')return response({ok:false,phase:'SYNC',source:'cloudflare',syncComplete:false,drainAuthorized:false,result:{outcome:'COMMIT_INDETERMINATE'}},503);
  throw new TypeError('Synthetic acknowledgement unavailable');
 }});
 await assert.rejects(f.run(),e=>e.category===(kind==='indeterminate'?'http_5xx':'transport'));
 assert.equal(f.calls.length,MAX_ATTEMPTS);assert.equal(f.calls[0].body,f.calls[1].body);
});

for(const outcome of ['TIMEOUT','CANCELLED'])test(`resumable 202 ${outcome} keeps the ordinary two-attempt bound`,async()=>{
 const f=harness('sync',{onPhase:()=>response({...partial(),result:{...partial().result,outcome}},202)});
 await assert.rejects(f.run(),e=>e.category==='continuation_pending'&&e.resumable===true);
 assert.equal(f.calls.length,MAX_ATTEMPTS);assert.equal(f.calls[0].body,f.calls[1].body);
});

test('a PARTIAL reply with another continuation state cannot obtain a third leg',async()=>{
 const f=harness('sync',{onPhase:()=>response({...partial(),result:{...partial().result,continuationState:'COMMIT_UNCERTAIN'}},202)});
 await assert.rejects(f.run(),e=>e.category==='continuation_pending'&&e.resumable===true);assert.equal(f.calls.length,MAX_ATTEMPTS);
});
for(const result of [{yieldReason:undefined},{yieldReason:'UNREVIEWED_PARTIAL'},{retryAfterMs:15000}])test('only the closed completed-unit budget proof authorizes another known leg '+JSON.stringify(result),async()=>{
 const f=harness('sync',{onPhase:()=>response({...partial(),result:{...partial().result,...result}},202)});
 await assert.rejects(f.run(),e=>e.category==='continuation_pending'&&e.resumable===true);assert.equal(f.calls.length,MAX_ATTEMPTS);
});

for(const change of [{syncComplete:true},{drainAuthorized:true},{handoff:'c'.repeat(64)},
 {result:{...partial().result,settlementState:'WORK_COMMITTED'}},{result:{...partial().result,settlementState:'FINALIZED_SUCCESS'}}])
 test('scoped PARTIAL rejects fabricated completion or handoff '+JSON.stringify(change),async()=>{
  const f=harness('sync-and-stage6-shadow',{onPhase:()=>response({...partial(),...change},202)});
  await assert.rejects(f.run(),e=>e.category==='invalid_response'&&e.nonRetryable===true);assert.equal(f.calls.length,1);
 });

for(const change of [{outcome:'PARTIAL'},{resumable:true}])test('scoped finalized reply must actually be complete '+JSON.stringify(change),async()=>{
 const f=harness('sync-and-stage6-shadow',{onPhase:()=>response({...complete(true),result:{...complete().result,...change}})});
 await assert.rejects(f.run(),e=>e.category==='invalid_response'&&e.nonRetryable===true);assert.equal(f.calls.length,1);
});

for(const change of [{requestId:'p4c1_wrong-phase-saved-request'},{requestId:'ordinary-unfinished-saved-request'},
 {releaseSha:'d'.repeat(40)},{configProof:'d'.repeat(64)},{triggerSource:'manual'},{executionMode:'OFF'}])
 test('unfinished scoped discovery rejects identity substitution '+JSON.stringify(change),async()=>{
  const f=harness('sync',{discovery:{ok:true,state:'INCOMPLETE_RESUMABLE',requestBody:canonical(savedRequest(change))}});
  await assert.rejects(f.run(),e=>e.category==='invalid_discovery'&&e.nonRetryable===true);assert.equal(f.calls.length,0);
 });

test('unfinished scoped discovery rejects noncanonical bytes without a fresh phase fallback',async()=>{
 const f=harness('sync',{discovery:{ok:true,state:'INCOMPLETE_RESUMABLE',requestBody:JSON.stringify(savedRequest())}});
 await assert.rejects(f.run(),e=>e.category==='invalid_discovery');assert.equal(f.calls.length,0);
});

test('sync-only discovery cannot start a saved DRAIN',async()=>{
 const f=harness('sync',{discovery:{ok:true,state:'INCOMPLETE_RESUMABLE',requestBody:canonical(savedRequest({phase:'STAGE6_DRAIN',
  requestId:'p4c1_saved-drain-in-wrong-scope',syncRequestId:savedRequest().requestId,handoff:'c'.repeat(64)}))}});
 await assert.rejects(f.run(),e=>e.category==='invalid_discovery');assert.equal(f.calls.length,0);
});

for(const code of ['REQUEST_PENDING','REQUEST_SCOPE_PENDING'])test('scoped known coordination retains exact body within three bounded attempts: '+code,async()=>{
 const f=harness('sync',{onPhase:()=>response({ok:false,error:code,retryAfterMs:225000},409)});
 await assert.rejects(f.run(),e=>e.category==='continuation_pending'&&e.resumable===true);
 assert.equal(f.calls.length,3);assert.ok(f.calls.every(call=>call.body===f.calls[0].body));assert.equal(f.elapsed(),450000);
});

test('combined SYNC and DRAIN still share the unchanged whole deadline and discard late final success',async()=>{
 let syncs=0;
 const f=harness('sync-and-stage6-shadow',{onPhase:(request,_count,{advance})=>{
  if(request.phase==='SYNC'){syncs++;advance(170000);return response(syncs<3?partial():complete(true),syncs<3?202:200);}
  advance(50000);return response({ok:true,phase:'STAGE6_DRAIN',source:'cloudflare',result:{outcome:'NO_WORK',settlementState:'FINALIZED_SUCCESS'}});
 }});
 await assert.rejects(f.run(),e=>e.category==='timeout'&&e.nonRetryable===true);
 assert.equal(MAX_CONFIGURED_WINDOW_MS,561000);assert.equal(f.calls.length,4);assert.equal(f.elapsed(),561500);
 assert.equal(f.timers.at(-1),49500,'remaining whole deadline truncates the DRAIN attempt');
});

test('cancellation during scoped continuation backoff emits no later phase request',async()=>{
 const controller=new AbortController(),f=harness('sync',{signal:controller.signal,onPhase:()=>response(partial(),202)});
 f.options.sleep=async()=>{controller.abort();};
 await assert.rejects(f.run(),e=>e.category==='cancelled'&&e.nonRetryable===true);assert.equal(f.calls.length,1);
});

for(const change of [{BRIEFING_CONTINUATION_DISCOVERY:'off'},{BRIEFING_CONTINUATION_SCOPE:'wrong'},
 {BRIEFING_CONTINUATION_SCOPE:'sync-and-stage6-shadow',BRIEFING_EXECUTION_MODE:'OFF'}])
 test('new scope configuration fails before any discovery or phase transport '+JSON.stringify(change),async()=>{
  const f=harness('sync');Object.assign(f.env,change);
  await assert.rejects(f.run(),e=>e.category==='configuration'&&e.nonRetryable===true);assert.equal(f.calls.length,0);assert.equal(f.discovered(),0);
 });
