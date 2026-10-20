import test from 'node:test';
import assert from 'node:assert/strict';
import {invoke,invokeReadiness,invokeCompanion} from '../cloudflare/briefing-scheduler/worker.js';

// An async crypto completion can run before an already-due timer callback.
// A fixed clock proves no POST is sent when signing uses the remaining budget.
const environment={BRIEFING_ENDPOINT_URL:'https://fixture.invalid/internal/briefing/run',
 BRIEFING_TRIGGER_SECRET:'synthetic-worker-secret-at-least-32-bytes',
 BRIEFING_EXECUTION_MODE:'OFF',BRIEFING_RELEASE_SHA:'a'.repeat(40),
 BRIEFING_CONFIG_PROOF:'b'.repeat(64),BRIEFING_CONTINUATION_DISCOVERY:'on',
 BRIEFING_CONTINUATION_SCOPE:'sync',BRIEFING_COMPANION_ENABLED:'on'};
const timers={setTimer:()=>1,clearTimer:()=>{}};
const response=body=>new Response(JSON.stringify(body),{status:200});
function acknowledgement(url,body){
 if(new URL(url).pathname.endsWith('/continuation'))return response({ok:true,state:'NONE',requestBody:null});
 if(body.kind==='MORNING_READINESS_V1')return response({ok:true,kind:body.kind,source:'cloudflare',releaseSha:body.releaseSha,readinessChecked:true,syncComplete:false,drainAuthorized:false});
 if(body.kind==='COMPANION_V1')return response({ok:true,kind:body.kind,source:'cloudflare',releaseSha:body.releaseSha,enabled:true,drainAuthorized:false});
 return response({ok:true,phase:'SYNC',source:'cloudflare',syncComplete:true,drainAuthorized:false,result:{settlementState:'FINALIZED_SUCCESS',outcome:'NO_NEW_DATA_SUCCESS'}});
}
for(const [name,run,advance] of [
 ['continuation original whole deadline',(options)=>invoke(environment,{...options,deadlineAt:1001}),1],
 ['continuation local discovery deadline',(options)=>invoke(environment,{...options,deadlineAt:61000}),30000],
 ['morning readiness deadline',(options)=>invokeReadiness(environment,{...options,timeoutMs:10}),10],
 ['companion deadline',(options)=>invokeCompanion(environment,{...options,timeoutMs:10}),10],
])test(`Worker ${name}: signing at exact boundary refuses before POST even if timer is delayed`,async()=>{
 let at=1000,posts=0;
 const options={...timers,now:()=>at,signImpl:async()=>{at+=advance;return 'synthetic-signature';},fetchImpl:async(url,request)=>{posts++;return acknowledgement(url,JSON.parse(request.body));}};
 await assert.rejects(()=>run(options),error=>error.category==='timeout');
 assert.equal(posts,0,'an expired crypto completion must not initiate a request');
});
test('Worker bounded signing still permits narrow discovery/SYNC, readiness and companion',async()=>{
 const observed=[];
 const options={...timers,now:()=>1000,signImpl:async()=> 'synthetic-signature',fetchImpl:async(url,request)=>{
  assert.equal(request.signal.aborted,false);assert.equal(request.redirect,'manual');
  const body=JSON.parse(request.body);observed.push({path:new URL(url).pathname,body});return acknowledgement(url,body);
 }};
 assert.equal((await invoke(environment,options)).ok,true);
 assert.equal((await invokeReadiness(environment,options)).ok,true);
 assert.equal((await invokeCompanion(environment,options)).ok,true);
 assert.deepEqual(observed.map(r=>r.path),['/internal/briefing/continuation','/internal/briefing/run','/internal/briefing/readiness','/internal/briefing/companion']);
 assert.equal(observed[2].body.phase,undefined);assert.equal(observed[3].body.phase,undefined);
});
