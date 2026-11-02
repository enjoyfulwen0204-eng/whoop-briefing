import test from 'node:test';
import assert from 'node:assert/strict';
import worker,{READINESS_CRON,MORNING_CRON,TIMEOUT_MS} from '../cloudflare/briefing-scheduler/worker.js';
import {resourceSyncDue} from '../src/sync.js';
import {bodyInput,seedBodyInput} from './bodyEnergyFixture.js';
import {selectBodyEnergyInputs,bodyEnergyDataTime} from '../src/bodyEnergyInputs.js';
import {calculateBodyEnergy,bodyFreshness} from '../src/bodyEnergy.js';
import {createOnDemandBodyEnergy,renderOnDemandBody} from '../src/onDemandBodyEnergy.js';
import {syntheticStage7V33Fixture} from './stage7-v33-fixture.js';
import {runForUser} from '../src/index.js';
import {stage6SchedulerDecision} from '../src/schedulerPolicy.js';

globalThis.fetch=async()=>{throw Error('TEST_NETWORK_FORBIDDEN');};
const hour=3600000,env={BRIEFING_ENDPOINT_URL:'https://synthetic.invalid/internal/briefing/run',BRIEFING_TRIGGER_SECRET:'s'.repeat(32),
 BRIEFING_RELEASE_SHA:'a'.repeat(40),BRIEFING_CONFIG_PROOF:'b'.repeat(64),BRIEFING_CONTINUATION_DISCOVERY:'on',BRIEFING_CONTINUATION_SCOPE:'sync',BRIEFING_EXECUTION_MODE:'OFF',BRIEFING_COMPANION_ENABLED:'on'};
for(const cron of [READINESS_CRON,MORNING_CRON])test(`${cron}: discovery then canonical SYNC then companion, with bounded timing log`,async t=>{
 const calls=[],logs=[];t.mock.method(console,'log',line=>logs.push(JSON.parse(line)));
 t.mock.method(globalThis,'fetch',async(url,options)=>{
  const path=new URL(url).pathname,body=JSON.parse(options.body);calls.push(path);
  assert.equal(options.method,'POST');assert.equal(options.redirect,'manual');
  if(path.endsWith('/continuation')){assert.equal(body.scope,'sync');return Response.json({ok:true,state:'NONE',requestBody:null});}
  if(path.endsWith('/run')){assert.equal(body.phase,'SYNC');assert.equal(body.executionMode,'OFF');return Response.json({ok:true,phase:'SYNC',source:'cloudflare',syncComplete:true,drainAuthorized:false,result:{settlementState:'FINALIZED_SUCCESS',outcome:'COMPLETE_SUCCESS',resumable:false}});}
  assert.ok(path.endsWith('/companion'));return Response.json({ok:true,kind:'COMPANION_V1',source:'cloudflare',releaseSha:env.BRIEFING_RELEASE_SHA,drainAuthorized:false,enabled:true});
 });
 let promise;worker.scheduled({cron},env,{waitUntil:p=>{promise=p;}});await promise;
 assert.deepEqual(calls,['/internal/briefing/continuation','/internal/briefing/run','/internal/briefing/companion']);
 const summary=logs.find(x=>x.event==='scheduled_tick_completed');assert.equal(summary.sync_status,200);assert.equal(summary.companion_status,200);
 assert.ok(summary.sync_duration_ms>=0&&summary.sync_duration_ms<TIMEOUT_MS);assert.ok(summary.total_duration_ms>=summary.sync_duration_ms);
 assert.ok(!JSON.stringify(logs).includes(env.BRIEFING_TRIGGER_SECRET));
});
test('unknown cron rejects before all I/O; failed SYNC still gives companion its independent attempt',async t=>{
 let calls=0,promise;t.mock.method(console,'error',()=>{});t.mock.method(console,'log',()=>{});
 t.mock.method(globalThis,'fetch',async url=>{calls++;return new URL(url).pathname.endsWith('/companion')
  ?Response.json({ok:true,kind:'COMPANION_V1',source:'cloudflare',releaseSha:env.BRIEFING_RELEASE_SHA,drainAuthorized:false}):Response.json({ok:false},{status:401});});
 worker.scheduled({cron:'unsupported'},env,{waitUntil:p=>{promise=p;}});await assert.rejects(promise,/unsupported_cron/);assert.equal(calls,0);
 worker.scheduled({cron:READINESS_CRON},env,{waitUntil:p=>{promise=p;}});await assert.rejects(promise,/continuation_discovery_failed/);assert.equal(calls,2);
});
test('hourly drift: 59.5 minutes is due, 49 is throttled; unfinished backfill unchanged',()=>{
 const now=new Date('2026-11-02T10:10:00Z'),state=minutes=>({lastSuccessAt:new Date(now- minutes*60000).toISOString(),backfillComplete:true});
 assert.equal(resourceSyncDue(state(59.5),{now}),true);assert.equal(resourceSyncDue(state(49),{now}),false);
 assert.equal(resourceSyncDue({...state(49),backfillComplete:false},{now}),true);
});
const inspect=input=>{const {manifest}=selectBodyEnergyInputs(input);return {manifest,calculation:calculateBodyEnergy(manifest)};};
test('two-hour sources remain numeric; timestamp is oldest selected resource, never unrelated workout',()=>{
 const input=bodyInput();for(const row of input.sync)row.last_success_at=new Date(input.asOfEpochMs-(row.resource==='workout'?23:2)*hour).toISOString();
 input.sync.find(r=>r.resource==='recovery').last_success_at=new Date(input.asOfEpochMs-3*hour).toISOString();
 const {manifest,calculation}=inspect(input);assert.equal(calculation.quality_state,'AVAILABLE');assert.ok(Number.isFinite(calculation.value));
 assert.deepEqual(manifest.warnings,[]);assert.deepEqual(calculation.reasons,['CYCLE_STALE','RECOVERY_STALE','SLEEP_STALE']);
 assert.equal(calculation.drivers.confidence_components.freshness,bodyFreshness(3*hour));
 const dataAsOfUtc=bodyEnergyDataTime(manifest);assert.equal(dataAsOfUtc,new Date(input.asOfEpochMs-3*hour).toISOString());
 for(const [locale,phrase] of [['zh-TW','05:00 的資料'],['en','data as of 05:00'],['vi','dữ liệu lúc 05:00']])for(const morning of [true,false]){
  const output=renderOnDemandBody(calculation,{locale,morning,dataAsOfUtc,timezone:'Asia/Taipei',details:!morning});assert.ok(output.includes(phrase));assert.match(output,/\/100/);
  assert.match(renderOnDemandBody({...calculation,quality_state:'LIMITED'},{locale,morning,dataAsOfUtc,timezone:'Asia/Taipei'}),/參考值|reference estimate|tham khảo/);
 }
 assert.match(renderOnDemandBody(calculation,{dataAsOfUtc,timezone:'Asia/Ho_Chi_Minh'}),/04:00 的資料/);
});
test('expiry, load six-hour limit, missing sleep and permission fences stay closed',()=>{
 const expired=bodyInput();expired.sync.find(r=>r.resource==='sleep').last_success_at=new Date(expired.asOfEpochMs-24*hour-1).toISOString();
 const result=inspect(expired).calculation;assert.equal(result.quality_state,'NO_DATA');assert.ok(result.reasons.includes('SLEEP_SYNC_EXPIRED'));assert.doesNotMatch(renderOnDemandBody(result),/\/100/);
 const load=bodyInput();load.sync.find(r=>r.resource==='cycle').last_success_at=new Date(load.asOfEpochMs-6*hour-1).toISOString();assert.ok(inspect(load).manifest.warnings.includes('LOAD_UNAVAILABLE'));
 const missing=bodyInput();missing.sources.sleep=[];assert.equal(inspect(missing).calculation.quality_state,'NO_DATA');
 const denied=bodyInput();denied.access.find(r=>r.resource==='sleep').auth_generation=2;assert.equal(inspect(denied).calculation.quality_state,'UNAVAILABLE');
 assert.equal(bodyEnergyDataTime(inspect(bodyInput()).manifest),null);
});
test('real v33 read-only capture feeds morning/query timestamp and reply-currentness guard without result persistence',async t=>{
 const at=new Date('2026-11-02T07:00:00Z'),f=await syntheticStage7V33Fixture(t,{targetVersion:33,now:()=>at}),input=bodyInput({asOf:at.getTime()});
 for(const row of input.sync)row.last_success_at=new Date(at-2*hour).toISOString();
 await f.db.linkTelegram({userId:'a',chatId:'123',now:at});await f.db.setLocale('a','zh-TW',{now:at});await seedBodyInput(f.db,input);await f.db.ensureOnboarding('a',{state:'READY',now:at});
 const body=createOnDemandBodyEnergy({...f,environment:{BODY_ENERGY_ON_DEMAND:'on'},now:()=>at});
 for(const morning of [true,false]){const reply=await body.currentSection({userId:'a',requestedAt:at,morning});assert.match(reply.message,/13:00 的資料/);assert.equal(await reply.verifyCurrent(),true);}
 assert.equal((await f.db.raw.execute('SELECT count(*) n FROM body_energy_results')).rows[0].n,0);
});
test('06:10 Taipei canonical user path checks daily before SYNC; Stage6 remains outside its window',async()=>{
 const now=new Date('2026-11-01T22:10:00Z'),calls=[],db={assertAccountActive:async()=>{},getActiveChatIdForUser:async()=> 'synthetic',getLocale:async()=> 'en',isSent:async()=>false,
  getAllSyncState:async()=>[],getSyncState:async()=>null,coverage:async()=>({last_date:null})};
 const result=await runForUser({db,env:{dryRun:true},user:{id:'synthetic',timezone:'Asia/Taipei',lifecycleGeneration:1},now,deps:{
  reap:async()=>({}),makeTelegram:()=>({notifyError:async()=>{}}),makeWhoop:()=>({getAccessToken:async()=> 'synthetic'}),makeCoach:()=>({}),makeSource:()=>({}),
  daily:async()=>{calls.push('daily');return {status:'not_ready'};},weekly:async()=>({}),makeSync:()=>({syncAll:async()=>{calls.push('sync');return {complete:true,resources:[]};}}),proactive:async()=>({})}});
 assert.deepEqual(calls,['daily','sync']);assert.deepEqual(result.errors,[]);assert.equal(stage6SchedulerDecision({source:'cloudflare',now}).drain,false);
});
