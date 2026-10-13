import {SCHEMA_VERSION} from '../src/schema.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {deliveryFixture,fixtureKeys} from './deliveryDefaultFixture.js';
import {runMorningReadiness,MORNING_READINESS_PATH,validateMorningReadinessRequest} from '../src/morningReadiness.js';
import {runForUser} from '../src/index.js';
import {runDaily} from '../src/daily.js';
import {configurationProof} from '../src/phase4ExecutionStore.js';
import {runningReleaseSha} from '../src/phase4Release.js';
import {createBriefingEndpoint} from '../src/briefingEndpoint.js';
import {signTriggerRequest} from '../src/briefingTriggerAuth.js';
import {invokeReadiness,READINESS_CRON,MORNING_CRON} from '../cloudflare/briefing-scheduler/worker.js';
import {schedulerWindow,morningServiceProviderState,stage6SchedulerDecision} from '../src/schedulerPolicy.js';
import {fakeDb,fakeCoach,fakeTelegram} from './fakes.js';
import {makeDataset} from './fixtures.js';
import {LIFECYCLE_UNFENCED} from '../src/accountLifecycle.js';
const environment={PHASE4_BETA_SHADOW_RUNTIME:'off',PHASE4_PUBLIC_BETA_MODE:'off',BODY_ENERGY_PUBLICATION:'off',PHASE4_BETA_PILOT_STOP:'on'};
const req=()=>({kind:'MORNING_READINESS_V1',requestId:randomUUID(),releaseSha:runningReleaseSha(),executionMode:'OFF',triggerSource:'cloudflare',configProof:configurationProof(fixtureKeys,{runtime:'off',mode:'off'},environment)});
const env={dryRun:true,maxUserConcurrency:2,telegramBotToken:'synthetic',whoopClientId:'synthetic',whoopClientSecret:'synthetic'};
const impossible=()=>{throw Error('UNRELATED_WORK_REACHED');};
async function seed(db){await db.createUser({id:'readiness',displayName:'Synthetic',timezone:'Asia/Taipei',status:'ACTIVE'});await db.setLocale('readiness','zh-TW');await db.linkTelegram({userId:'readiness',chatId:'12345'});await db.ensureOnboarding('readiness',{state:'READY'});}
const isolatedDeps=(daily)=>({makeTelegram:()=>({send:impossible,notifyError:impossible}),makeWhoop:()=>({getAccessToken:async()=> 'synthetic'}),makeCoach:()=>({}),makeSource:()=>({}),daily,weekly:impossible,makeSync:impossible,reap:impossible,proactive:impossible,predictionCycle:impossible,healthspan:impossible,makeReconciler:impossible});
test('real admitted current-schema composition runs daily-only while optional pilot stopped; no phase or permit rows',async t=>{
 const {db}=await deliveryFixture(t,{version:SCHEMA_VERSION});await db.admitRuntime({source:'fixture'});await seed(db);let calls=0;
 const result=await runMorningReadiness({request:req(),environment,db,keys:fixtureKeys,env,deps:isolatedDeps(async()=>{calls++;return {status:'not_ready'};})});
 assert.equal(result.status,200,JSON.stringify(result));assert.equal(calls,1);assert.equal(result.body.syncComplete,false);assert.equal(result.body.drainAuthorized,false);assert.equal(result.body.handoff,undefined);
 assert.equal((await db.raw.execute('SELECT count(*) n FROM phase4_executions')).rows[0].n,0);
 assert.equal((await db.raw.execute("SELECT count(*) n FROM system_heartbeats WHERE component LIKE 'phase4_beta_pilot%'")).rows[0].n,0);
 assert.ok(await db.getHeartbeat('global','morning_readiness_v1'));
});
test('sent and uncertain current day skip provider, model, maintenance and unrelated work',async t=>{
 const {db}=await deliveryFixture(t,{version:SCHEMA_VERSION});await db.admitRuntime({source:'fixture'});await seed(db);
 const now=new Date('2026-10-13T05:10:00Z'),user=await db.getUser('readiness');
 for(const deliveryState of ['SENT','AMBIGUOUS','DELIVERY_STARTED']){
  const wrapped={...db,isSent:async()=>deliveryState==='SENT',getClaim:async()=>({deliveryState})};
  const result=await runForUser({db:wrapped,env,user,now,readinessOnly:true,deps:{...isolatedDeps(impossible),makeWhoop:impossible,makeCoach:impossible}});
  assert.equal(result.skipped,'nothing_due');
 }
});
test('strict signed readiness dispatch rejects extra scope or forged source and never reaches SYNC',async()=>{
 let calls=0;const secret='synthetic-readiness-secret-32bytes',request=req(),at=Date.now();
 const endpoint=createBriefingEndpoint({secret,now:()=>at,runPhase:impossible,runReadiness:async()=>{calls++;return {status:200,body:{ok:true}};}});
 const send=async value=>{const body=JSON.stringify(value),timestamp=String(at),path=MORNING_READINESS_PATH;return endpoint({url:path,method:'POST',headers:{'content-type':'application/json','x-briefing-timestamp':timestamp,'x-briefing-request-id':value.requestId,'x-briefing-signature':signTriggerRequest({timestamp,requestId:value.requestId,method:'POST',path,body},secret)}},body);};
 assert.equal((await send(request)).status,200);assert.equal((await send(request)).status,200);assert.equal(calls,1);
 for(const delta of [{phase:'SYNC'},{userId:'someone'},{triggerSource:'manual'},{kind:'ANYTHING'}])assert.equal((await send({...request,...delta,requestId:randomUUID()})).status,400);
 assert.throws(()=>validateMorningReadinessRequest({...request,scope:'all'}));
});
test('Worker readiness signs exactly one narrow request, including cold/ambiguous failure without retry',async()=>{
 const request=req(),workerEnv={BRIEFING_ENDPOINT_URL:'https://fixture.invalid/internal/briefing/run',BRIEFING_TRIGGER_SECRET:'synthetic-worker-secret-at-least32',BRIEFING_RELEASE_SHA:request.releaseSha,BRIEFING_CONFIG_PROOF:request.configProof,BRIEFING_EXECUTION_MODE:'OFF'};
 let count=0;
 const fetchImpl=async(url,opts)=>{count++;assert.equal(new URL(url).pathname,MORNING_READINESS_PATH);assert.equal(opts.redirect,'manual');const body=JSON.parse(opts.body);assert.equal(body.kind,'MORNING_READINESS_V1');assert.equal(body.phase,undefined);return new Response(JSON.stringify({ok:true,kind:body.kind,source:'cloudflare',releaseSha:body.releaseSha,readinessChecked:true,syncComplete:false,drainAuthorized:false}));};
 assert.equal((await invokeReadiness(workerEnv,{fetchImpl})).ok,true);assert.equal(count,1);
 count=0;await assert.rejects(()=>invokeReadiness(workerEnv,{fetchImpl:async()=>{count++;return new Response('cold',{status:503});}}));assert.equal(count,1);
});
test('24-hour Taipei table is 24 morning + 20 other ticks and keeps Stage6 morning window',()=>{
 assert.equal(MORNING_CRON,'*/10 0-3 * * *');assert.equal(READINESS_CRON,'10 4-23 * * *');let morning=0,other=0;
 for(let hour=0;hour<24;hour++)for(let minute=0;minute<60;minute++){
  const at=new Date(Date.UTC(2026,9,13,hour,minute)),isMorning=hour<4,scheduled=isMorning?minute%10===0:minute===10;
  if(scheduled)isMorning?morning++:other++;
  assert.equal(schedulerWindow(at).cloudflareExpected,isMorning);
  assert.equal(stage6SchedulerDecision({source:'cloudflare',now:at}).drain,isMorning);
 }
 assert.equal(morning,24);assert.equal(other,20);
 for(const time of ['2026-10-13T03:50:00Z','2026-10-13T04:10:00Z','2026-10-13T16:10:00Z'])assert.equal(morningServiceProviderState({lastOkAt:time},'cloudflare',new Date(time)).state,'healthy');
 assert.equal(morningServiceProviderState(null,'github',new Date()).state,'not_expected');
});
for(const [name,at,tz] of [['early','2026-10-12T22:10:00Z','Asia/Taipei'],['late','2026-10-13T06:10:00Z','Asia/Taipei'],['midnight','2026-10-13T16:10:00Z','Asia/Taipei'],['dst','2026-11-01T07:10:00Z','America/New_York']])test(`actual daily eligibility preserves ${name} wake in user timezone`,async()=>{
 const now=new Date(at),data=makeDataset({now,wakeMinutesAgo:45}),db=fakeDb(),telegram=fakeTelegram();
 const args={db,userId:'synthetic',source:{poll:async()=>data,history:async()=>data},coach:fakeCoach(),telegram,timezone:tz,now,presentationClock:()=>now,expectedLifecycleGeneration:LIFECYCLE_UNFENCED};
 assert.equal((await runDaily(args)).status,'sent');assert.equal((await runDaily(args)).status,'already_sent');
});
test('11:50 to 12:10 delay/scoring and stale clock after generation do not cause premature/late sends',async()=>{
 const start=new Date('2026-10-13T03:50:00Z'),data=makeDataset({now:start,wakeMinutesAgo:15}),db=fakeDb(),telegram=fakeTelegram();let clock=start;
 const args={db,userId:'synthetic',source:{poll:async()=>data,history:async()=>data},coach:fakeCoach(),telegram,timezone:'Asia/Taipei',now:start,presentationClock:()=>clock,expectedLifecycleGeneration:LIFECYCLE_UNFENCED};
 assert.equal((await runDaily(args)).status,'not_ready');clock=new Date('2026-10-13T04:10:00Z');assert.equal((await runDaily(args)).status,'sent');
 const late=makeDataset({now:start,wakeMinutesAgo:40});let later=start;
 const stale={...args,db:fakeDb(),source:{poll:async()=>late,history:async()=>{later=new Date(start.getTime()+48*3600000);return late;}},presentationClock:()=>later};
 assert.notEqual((await runDaily(stale)).status,'sent');
});
test('delayed recovery scoring remains nonnumeric waiting until matched scored input arrives',async()=>{
 const now=new Date('2026-10-13T04:10:00Z'),data=makeDataset({now,wakeMinutesAgo:45}),db=fakeDb();
 let recovery=data.recoveries.map((r,i)=>i? r:{...r,score_state:'PENDING_SCORE'});
 const args={db,userId:'synthetic',source:{poll:async()=>({...data,recoveries:recovery}),history:async()=>data},coach:fakeCoach(),telegram:fakeTelegram(),timezone:'Asia/Taipei',now,presentationClock:()=>now,expectedLifecycleGeneration:LIFECYCLE_UNFENCED};
 assert.equal((await runDaily(args)).status,'not_ready');recovery=data.recoveries;assert.equal((await runDaily(args)).status,'sent');
});
test('overlapping readiness requests share existing durable user ownership',async t=>{
 const {db,url}=await deliveryFixture(t,{version:SCHEMA_VERSION});await db.admitRuntime({source:'fixture'});await seed(db);
 const {openHttpFixture}=await import('./deliveryDefaultFixture.js');const second=openHttpFixture(url);t.after(()=>second.close());
 let entered;const began=new Promise(r=>{entered=r;});let release;const gate=new Promise(r=>{release=r;});let calls=0;
 const first=runMorningReadiness({request:req(),environment,db,keys:fixtureKeys,env,deps:isolatedDeps(async()=>{calls++;entered();await gate;return {status:'not_ready'};})});
 await began;
 try{const other=await runMorningReadiness({request:req(),environment,db:second.db,keys:fixtureKeys,env,deps:isolatedDeps(impossible)});assert.equal(other.status,503);}
 finally{release();}
 assert.equal((await first).status,200);assert.equal(calls,1);
});
