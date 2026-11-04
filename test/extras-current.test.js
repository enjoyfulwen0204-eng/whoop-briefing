import test from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {syntheticStage7V33Fixture} from './stage7-v33-fixture.js';
import {configurationProof} from '../src/phase4ExecutionStore.js';
import {publicBetaConfiguration} from '../src/publicBetaConfig.js';
import {runningReleaseSha} from '../src/phase4Release.js';
import {signTriggerRequest} from '../src/briefingTriggerAuth.js';
import {invokeExtras,MAX_SCHEDULED_WINDOW_MS} from '../cloudflare/briefing-scheduler/worker.js';
registerHooks({load(url,context,next){
 if(url.endsWith('/src/stage7Cohort.js'))return {format:'module',source:'export const isApprovedStage7Three=ids=>ids.join(",")==="a";',shortCircuit:true};
 return next(url,context);
}});
const {createBriefingEndpoint}=await import('../src/briefingEndpoint.js');
const {processNightAnalytics}=await import('../src/nightAnalytics.js');
const {runExtrasService,runCompanionService,EXTRAS_KIND,EXTRAS_PATH,COMPANION_KIND}=await import('../src/companionService.js');
const environment={STAGE7_COMPANION:'on',STAGE7_AUTOMATIC:'on',STAGE7_COMPANION_USER_IDS:'a'};
async function fixture(t){
 const f=await syntheticStage7V33Fixture(t,{now:()=>new Date('2026-11-03T13:14:00Z')});
 await f.db.linkTelegram({userId:'a',chatId:'123',now:f.core.now()});await f.db.ensureOnboarding('a',{state:'READY',now:f.core.now()});
 const releaseSha=runningReleaseSha(environment),request={kind:EXTRAS_KIND,requestId:'synthetic-extras-request-001',releaseSha,configProof:configurationProof(f.keys,publicBetaConfiguration(environment),environment,releaseSha),executionMode:'OFF',triggerSource:'cloudflare'};
 return {...f,request,args:{db:f.db,keys:f.keys,environment,env:{telegramBotToken:'SYNTHETIC'},now:f.core.now,request}};
}
test('actual extras auth/release/proof/identity checks reject before admitted work and cache same request',async t=>{
 const f=await fixture(t),secret='x'.repeat(32);let calls=0;
 const endpoint=createBriefingEndpoint({secret,now:()=>+f.core.now(),runPhase:()=>assert.fail('SYNC forbidden'),runExtras:({request})=>runExtrasService({...f.args,request,deps:{createFamily:()=>null,notifyPrediction:async()=>{calls++;return {status:'MODEL_UNQUALIFIED'};}}})});
 const call=async(r,signature)=>{const body=JSON.stringify(r),args={timestamp:String(+f.core.now()),requestId:r.requestId,method:'POST',path:EXTRAS_PATH,body};return endpoint({url:EXTRAS_PATH,method:'POST',headers:{'content-type':'application/json','x-briefing-timestamp':args.timestamp,'x-briefing-request-id':r.requestId,'x-briefing-signature':signature??signTriggerRequest(args,secret)}},body);};
 assert.equal((await call(f.request,'bad')).status,401);
 assert.equal((await call({...f.request,releaseSha:'a'.repeat(40)})).status,403);
 assert.equal((await call({...f.request,configProof:'b'.repeat(64)})).status,503);assert.equal(calls,0);
 assert.equal((await call(f.request)).status,200);assert.equal((await call(f.request)).status,200);assert.equal(calls,1);
});
test('companion never creates family or runs prediction; extras never creates companion, deferrals visible at HTTP 200',async t=>{
 const f=await fixture(t);let family=0,prediction=0,companion=0,briefUpdate=0,noSleep=0;
 const deps={createMorningFollowups:()=>({briefUpdate:async()=>{briefUpdate++;return {status:'DEFERRED_BUDGET'};},noSleep:async()=>{noSleep++;return {status:'HAS_SLEEP_OR_REPORT'};}}),createRuntime:async()=>({tick:async()=>{companion++;return {daily:'DEFERRED_BUDGET',coach:'DISABLED'};}}),createFamily:()=>({tick:async()=>{family++;return {results:[],deferredSteps:{family_daily:1,family_alert:1,family_weekly:1}};}}),notifyPrediction:async()=>{prediction++;return {status:'DEFERRED_BUDGET'};}};
 const regular=await runCompanionService({...f.args,request:{...f.request,kind:COMPANION_KIND},deps});
 assert.deepEqual([companion,family,prediction,briefUpdate,noSleep],[1,0,0,0,0]);assert.equal(regular.status,200);assert.deepEqual(regular.body.deferredSteps,{daily:1});assert.equal(regular.body.deferred,true);
 const extra=await runExtrasService({...f.args,deps});assert.deepEqual([companion,family,prediction,briefUpdate,noSleep],[1,1,1,1,1]);assert.equal(extra.status,200);assert.equal(extra.body.failed,0);
 assert.deepEqual(extra.body.deferredSteps,{family_daily:1,family_alert:1,family_weekly:1,prediction:1,brief_update:1});assert.equal(extra.body.deferred,true);
});
test('extras transport binds distinct path/kind and preserves sanitized skip summary',async t=>{
 const f=await fixture(t),logs=[];t.mock.method(console,'log',s=>logs.push(JSON.parse(s)));
 const env={BRIEFING_ENDPOINT_URL:'https://synthetic.invalid/internal/briefing/run',BRIEFING_TRIGGER_SECRET:'x'.repeat(32),BRIEFING_RELEASE_SHA:f.request.releaseSha,BRIEFING_CONFIG_PROOF:f.request.configProof,BRIEFING_EXECUTION_MODE:'OFF',BRIEFING_COMPANION_ENABLED:'on'};
 const r=await invokeExtras(env,{signImpl:async input=>{assert.equal(input.path,EXTRAS_PATH);return 'synthetic';},fetchImpl:async(url,{body})=>{assert.equal(new URL(url).pathname,EXTRAS_PATH);assert.equal(JSON.parse(body).kind,EXTRAS_KIND);return Response.json({ok:true,kind:EXTRAS_KIND,source:'cloudflare',releaseSha:f.request.releaseSha,drainAuthorized:false,deferredSteps:{family_daily:2,private_payload:'forbidden'}});}});
 assert.deepEqual(r.deferredSteps,{family_daily:2});assert.deepEqual(logs[0].deferred_steps,{family_daily:2});assert.doesNotMatch(JSON.stringify(logs),/private_payload|forbidden/);
 assert.equal(MAX_SCHEDULED_WINDOW_MS,771000);assert.ok(MAX_SCHEDULED_WINDOW_MS<900000);
});
test('night budget reports exact unstarted LIGHT/HEAVY/MEMORY units',async()=>{
 let remaining=90000;
 const out=await processNightAnalytics({db:{getUser:async id=>({id,status:'ACTIVE',lifecycleGeneration:1}),getOnboarding:async()=>({state:'READY'}),getState:async()=>null,setState:async()=>{}},keys:{lookup:JSON.stringify},userIds:['a','b'],reader:{},budget:{remainingMs:()=>remaining,assert(){}},now:()=>new Date('2026-11-03T19:14Z'),emit(){},processUser:async()=>{remaining=24000;return {result:'SUCCESS'};}});
 assert.equal(out.deferred,true);assert.deepEqual(out.deferredSteps,{HEAVY:2,MEMORY:2,LIGHT:1});
});


import {followFixture} from './morningFollowupsFixture.js';
import {createMorningFollowups} from '../src/morningFollowups.js';
for(const kind of ['briefUpdate','noSleep'])test(`extras keeps the legacy ${kind} claim: a fresh request cannot send it again`,async t=>{
 const f=await fixture(t),report=followFixture(kind==='noSleep'?{gap:1,nap:true}:{});
 if(kind==='briefUpdate')await report.capture();
 // The same production method previously called by stage7Runtime sends once.
 assert.equal((await createMorningFollowups(report.input)[kind]()).status,'DELIVERED');
 const before=structuredClone([...report.db.claims]);
 const deps={createFamily:()=>null,notifyPrediction:async()=>({status:'NOT_DUE'}),createMorningFollowups:()=>createMorningFollowups(report.input)};
 for(const suffix of ['002','003']){
  const result=await runExtrasService({...f.args,request:{...f.request,requestId:'synthetic-extras-repeat-'+suffix},deps});
  assert.equal(result.status,200);assert.equal(result.body.failed,0);
  assert.equal(result.body.outcomes.ALREADY_DELIVERED,1);
 }
 assert.equal(report.sent.length,1);assert.deepEqual([...report.db.claims],before);
});
