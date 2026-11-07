import {PREDICTION_QUALITY_POLICY} from '../src/predictionPolicy.js';
import test from 'node:test';import assert from 'node:assert/strict';
import {stage7Fixture} from './stage7Fixture.js';
import {processAnalyticsForUser} from '../src/analyticsWorker.js';
import {processNightAnalytics,validateAnalyticsRequest,nightAnalyticsWindow} from '../src/nightAnalytics.js';
import {analyticsScheduledAt,invokeAnalytics} from '../cloudflare/briefing-scheduler/worker.js';
import {createExecutionBudget} from '../src/executionBudget.js';
import {assertAnalyticsBinding} from '../src/nightAnalytics.js';
import {createBriefingEndpoint} from '../src/briefingEndpoint.js';
import {signTriggerRequest} from '../src/briefingTriggerAuth.js';
import worker,{READINESS_CRON,MORNING_CRON} from '../cloudflare/briefing-scheduler/worker.js';
import {runPredictionCycle} from '../src/predictionPipeline.js';
import {trainableRows} from './predictionFixtures.js';
const req={requestId:'synthetic_request_123456',releaseSha:'a'.repeat(40),configProof:'b'.repeat(64),kind:'NIGHT_ANALYTICS_V1',triggerSource:'cloudflare',executionMode:'OFF'};
function partialNightFixture(){
 const states=new Map(),calls=[],logs=[];let remaining=90000,parts=0;
 const input={db:{transaction:async fn=>fn(),assertAccountActive:async()=>{},getUser:async id=>({id,status:'ACTIVE',lifecycleGeneration:1}),getOnboarding:async()=>({state:'READY'}),getState:async key=>states.get(key),setState:async(k,v)=>states.set(k,v)},
  keys:{lookup:JSON.stringify},userIds:['a'],reader:{inspect:async()=>({})},now:()=>new Date('2026-11-02T19:14:00Z'),
  budget:{remainingMs:()=>remaining,assert(){assert.ok(remaining>0);}},emit:line=>logs.push(JSON.parse(line)),
  processUser:async({userId,cls,force,owner})=>{assert.equal(userId,'a');assert.equal(force,true);assert.match(owner,/^night:/);calls.push(cls);remaining-=10000;
   return {result:cls==='light'&&++parts<3?'PARTIAL':'SUCCESS'};},
  updateMemory:async()=>{calls.push('memory');remaining-=10000;return {status:'SUCCESS'};}};
 return {input,states,calls,logs,setRemaining:n=>{remaining=n;}};
}
test('LIGHT resumes two partial slices in the same call before HEAVY and MEMORY',async()=>{
 const f=partialNightFixture(),out=await processNightAnalytics(f.input);
 assert.deepEqual(f.calls,['light','light','light','heavy','memory']);
 assert.deepEqual(f.logs.map(r=>r.status),['PARTIAL','PARTIAL','SUCCESS','SUCCESS','SUCCESS']);
 assert.equal(out.deferred,false);assert.equal(f.states.size,3);
});
test('LIGHT yields below 25 seconds without a completion marker and resumes next call',async()=>{
 const f=partialNightFixture();f.setRemaining(25000);
 const first=await processNightAnalytics(f.input);
 assert.equal(first.deferred,true);assert.deepEqual(f.calls,['light']);assert.equal(f.states.size,0);
 f.setRemaining(90000);const second=await processNightAnalytics(f.input);
 assert.equal(second.deferred,false);assert.deepEqual(f.calls,['light','light','light','heavy','memory']);assert.equal(f.states.size,3);
 const before=f.calls.length;await processNightAnalytics(f.input);assert.equal(f.calls.length,before);
});
test('non-success worker outcomes keep their original stop and deferred semantics',async()=>{
 for(const status of ['SKIPPED','FENCED','FAILED']){
  const f=partialNightFixture();f.input.processUser=async()=>{f.calls.push('light');return {result:status};};
  const out=await processNightAnalytics(f.input);
  assert.deepEqual(f.calls,['light']);assert.equal(f.states.size,0);assert.equal(out.deferred,status==='SKIPPED');
 }
 const f=partialNightFixture();f.input.processUser=async({cls})=>{f.calls.push(cls);return {result:cls==='light'?'SUCCESS':'PARTIAL'};};
 const out=await processNightAnalytics(f.input);
 assert.deepEqual(f.calls,['light','heavy']);assert.equal(f.states.size,1);assert.equal(out.deferred,true);
});
test('v33 training persists model and candidate, backfills actuals, but never publishes unqualified values',async t=>{
 const f=await stage7Fixture(t),rows=trainableRows(80),anchor=rows.map(r=>r.health_date).sort().at(-1);
 const first=await runPredictionCycle({db:f.db,userId:'a',rows,anchorDate:anchor,policy:{...PREDICTION_QUALITY_POLICY,QUALIFICATION_MODE:'STRICT'}});
 assert.equal(first.modelSaved,true);assert.equal(first.predictionSaved,true);assert.equal(first.qualified,false);assert.equal(first.publishedValue,null);
 const newer=trainableRows(81),nextAnchor=newer.map(r=>r.health_date).sort().at(-1);
 const second=await runPredictionCycle({db:f.db,userId:'a',rows:newer,anchorDate:nextAnchor,policy:{...PREDICTION_QUALITY_POLICY,QUALIFICATION_MODE:'STRICT'}});
 assert.ok(second.actualsBackfilled>=1);assert.equal(second.publishedValue,null);
 assert.ok((await f.db.getPredictions('a',{targetMetric:'recovery'})).length>=2);
});
test('night window is only three original cron instants; delayed authenticated work stays bounded',()=>{
 for(let h=0;h<24;h++)assert.equal(analyticsScheduledAt(Date.UTC(2026,10,2,h,10)),[19,20,21].includes(h));
 assert.equal(analyticsScheduledAt(Date.UTC(2026,10,2,19,11)),false);
 assert.equal(nightAnalyticsWindow(new Date('2026-11-02T19:14:00Z')),true);
 assert.equal(nightAnalyticsWindow(new Date('2026-11-02T19:25:00Z')),false);
 assert.equal(validateAnalyticsRequest(req),req);assert.throws(()=>validateAnalyticsRequest({...req,executionMode:'SHADOW'}));
});
test('real v33 analytics claims and writes with original generation fencing',async t=>{
 const f=await stage7Fixture(t);await f.db.ensureOnboarding('a',{state:'READY',now:f.core.now()});
 const light=await processAnalyticsForUser({db:f.db,userId:'a',cls:'light',owner:'synthetic-night',now:f.core.now,force:true});
 assert.equal(light.result,'SUCCESS');
 const heavy=await processAnalyticsForUser({db:f.db,userId:'a',cls:'heavy',owner:'synthetic-night',now:f.core.now,force:true});
 assert.equal(heavy.result,'SUCCESS');
 assert.equal((await f.db.getAnalyticsWorkState('a','heavy')).status,'SUCCESS');
});
test('safe-unit yielding and three windows cover three users; completed night is not rerun',async()=>{
 const states=new Map(),calls=[];const db={transaction:async fn=>fn(),assertAccountActive:async()=>{},getUser:async id=>({id,status:'ACTIVE',lifecycleGeneration:1}),getOnboarding:async()=>({state:'READY'}),getState:async key=>states.get(key),setState:async(k,v)=>states.set(k,v)};
 const keys={lookup:x=>JSON.stringify(x)},reader={inspect:async()=>({})};
 for(let hour=19;hour<=21;hour++){
  let remaining=90000;
  const out=await processNightAnalytics({db,keys,userIds:['a','b','c'],reader,now:()=>new Date(`2026-11-02T${hour}:14:00Z`),budget:{remainingMs:()=>remaining,assert(){}},emit(){},
   processUser:async({userId,cls,force})=>{assert.equal(force,true);calls.push(userId+cls);remaining-=22000;return {result:'SUCCESS'};},updateMemory:async()=>{remaining-=22000;return {status:'SUCCESS'};}});
  assert.ok(out.results.length>=3);
 }
 assert.equal(new Set(calls).size,6);assert.equal(calls.length,6);assert.equal(states.size,9);
});
test('deadline abort rejects late units and closed budget cannot authorize more writes',async()=>{
 const budget=createExecutionBudget({budgetMs:5});try{await assert.rejects(budget.run(()=>new Promise(r=>setTimeout(r,15))));assert.throws(()=>budget.assert());}finally{budget.close();}
});
test('analytics transport signs its own path; wrong release in response is rejected',async()=>{
 const env={BRIEFING_ENDPOINT_URL:'https://fixture.example/internal/briefing/run',BRIEFING_TRIGGER_SECRET:'x'.repeat(32),BRIEFING_RELEASE_SHA:req.releaseSha,BRIEFING_CONFIG_PROOF:req.configProof,BRIEFING_EXECUTION_MODE:'OFF'};
 let path;
 const fetchImpl=async(url,options)=>{assert.equal(new URL(url).pathname,'/internal/briefing/analytics');assert.equal(JSON.parse(options.body).kind,req.kind);return new Response(JSON.stringify({ok:true,kind:req.kind,source:'cloudflare',releaseSha:req.releaseSha,drainAuthorized:false}),{status:200});};
 assert.equal((await invokeAnalytics(env,{fetchImpl,signImpl:async input=>{path=input.path;return 'synthetic';}})).ok,true);assert.equal(path,'/internal/briefing/analytics');
 await assert.rejects(invokeAnalytics(env,{fetchImpl:async()=>new Response(JSON.stringify({ok:true,kind:req.kind,source:'cloudflare',releaseSha:'c'.repeat(40),drainAuthorized:false}),{status:200}),signImpl:async()=>''}));
});
test('actual analytics endpoint rejects HMAC, release, proof and identity mismatch before work',async()=>{
 const at=new Date('2026-11-02T19:14:00Z'),secret='synthetic-secret-at-least-32-bytes',body=JSON.stringify(req);let runs=0;
 const endpoint=createBriefingEndpoint({secret,now:()=>+at,runPhase:async()=>assert.fail('no SYNC'),runAnalytics:async({request})=>{
  assertAnalyticsBinding(request,{releaseSha:req.releaseSha,configProof:req.configProof,at});runs++;return {status:200,body:{ok:true}};
 }});
 const call=async(value,{signature,headerId=value.requestId}={})=>{const body=JSON.stringify(value),args={timestamp:String(+at),requestId:headerId,method:'POST',path:'/internal/briefing/analytics',body};return endpoint({url:args.path,method:args.method,headers:{'content-type':'application/json','x-briefing-timestamp':args.timestamp,'x-briefing-request-id':headerId,'x-briefing-signature':signature??signTriggerRequest(args,secret)}},body);};
 assert.equal((await call(req,{signature:'v1=invalid'})).status,401);assert.equal(runs,0);
 assert.equal((await call({...req,releaseSha:'c'.repeat(40)})).status,403);assert.equal(runs,0);
 assert.equal((await call({...req,configProof:'c'.repeat(64)})).status,503);assert.equal(runs,0);
 assert.equal((await call(req,{headerId:'other_request_123456'})).status,400);assert.equal(runs,0);
 assert.equal((await call(req)).status,200);assert.equal((await call(req)).status,200);assert.equal(runs,1);
 assert.throws(()=>assertAnalyticsBinding(req,{releaseSha:req.releaseSha,configProof:req.configProof,at:new Date('2026-11-02T22:14Z')}),/ANALYTICS_WINDOW_CLOSED/);
});
test('scheduled Worker performs SYNC then companion then analytics only at three night slots',async()=>{
 const previous=globalThis.fetch;
 const env={BRIEFING_ENDPOINT_URL:'https://fixture.example/internal/briefing/run',BRIEFING_TRIGGER_SECRET:'x'.repeat(32),BRIEFING_RELEASE_SHA:req.releaseSha,BRIEFING_CONFIG_PROOF:req.configProof,BRIEFING_EXECUTION_MODE:'OFF',BRIEFING_COMPANION_ENABLED:'on'};
 try{for(const hour of [1,13,19,20,21,22]){
  const calls=[];globalThis.fetch=async(url,options)=>{
   const path=new URL(url).pathname,request=JSON.parse(options.body);calls.push(path);
   return new Response(JSON.stringify(path.endsWith('/run')?{ok:true,phase:'SYNC',source:'cloudflare',syncComplete:true,drainAuthorized:false,result:{settlementState:'FINALIZED_SUCCESS'}}:{ok:true,kind:request.kind,releaseSha:req.releaseSha,source:'cloudflare',drainAuthorized:false,failed:0}),{status:200});
  };let work;worker.scheduled({cron:hour<4?MORNING_CRON:READINESS_CRON,scheduledTime:Date.UTC(2026,10,2,hour,10)},env,{waitUntil:p=>{work=p;}});await work;
  assert.deepEqual(calls,['/internal/briefing/run','/internal/briefing/companion','/internal/briefing/extras',...([19,20,21].includes(hour)?['/internal/briefing/analytics']:[])]);
 }}finally{globalThis.fetch=previous;}
});

test('night completion cannot recreate KV after an overlapping lifecycle fence',async()=>{
 const f=partialNightFixture();let checked=0;
 f.input.db.assertAccountActive=async()=>{checked++;throw Object.assign(Error(),{code:'ACCOUNT_INACTIVE'});};
 await assert.rejects(processNightAnalytics(f.input),{code:'ACCOUNT_INACTIVE'});
 assert.equal(checked,1);assert.equal(f.states.size,0);
 assert.deepEqual(f.calls,['light','light','light']);
});
