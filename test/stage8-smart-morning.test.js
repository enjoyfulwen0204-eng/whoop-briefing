import test from 'node:test';
import assert from 'node:assert/strict';
import {stage8Fixture} from './stage8Fixture.js';
import {syntheticPhase4Fixture} from './phase4Fixture.js';
import {bodyInput,seedBodyInput} from './bodyEnergyFixture.js';
import {createStage8MorningPlan,renderMorningPlan,SMART_MORNING_PLAN_VERSION} from '../src/stage8MorningPlan.js';
import {MORNING_PLAN_VERSION} from '../src/morningBriefPolicy.js';
import {canonicalJson,createPhase4EntityStore} from '../src/phase4EntityStore.js';
import {createStage8MorningRuntime} from '../src/stage8MorningRuntime.js';
import {createStage8LiveProducer} from '../src/stage8LiveProducer.js';

test('Smart Morning v34 keeps source availability, localizes unavailable estimates, and reads the original v1 plan contract unchanged',async t=>{
 const f=await stage8Fixture(t);await f.core.initializeTenant('a','LIVE');
 const ctx=await f.core.capture('a',{executionMode:'LIVE',providerRequired:true}),plans=createStage8MorningPlan({...f,preferences:f.stores.preferences}),built=await plans.build(ctx,{healthDate:'2026-09-19'});
 assert.equal(built.plan.version,SMART_MORNING_PLAN_VERSION);assert.equal(built.plan.intelligence.status,'ANALYSIS_UPDATING');assert.equal(built.plan.bodyEnergy.status,'UNAVAILABLE');
 const stored=await plans.persist(ctx,built);assert.equal((await plans.read(ctx,stored.row.plan_id)).plan.version,SMART_MORNING_PLAN_VERSION);
 for(const [locale,unavailable] of [['en',/No qualified estimate/],['zh-TW',/目前沒有合格的估計/],['vi',/Chưa có ước tính đủ điều kiện/]]){
  const text=renderMorningPlan({...built.plan,locale});assert.match(text,unavailable);assert.doesNotMatch(text,/Body Energy \(estimate\):\s*\d/);
 }
 // Closed in-memory compatibility fixture for an already-issued application
 // v1 plan. It is not an analysis publication or completion receipt.
 const {intelligence,bodyEnergy,...legacy}=built.plan;legacy.version=MORNING_PLAN_VERSION;
 const planId='synthetic-legacy-plan',json=canonicalJson(legacy),entities=createPhase4EntityStore(f.core);
 await entities.append(ctx,'morning_brief_plans',{plan_id:planId,health_date:legacy.healthDate,as_of_utc:legacy.asOfUtc,plan_version:MORNING_PLAN_VERSION,plan_json:json,plan_hmac:f.keys.lookup(['morning-plan-v1','a','LIVE',planId,json]),preference_version:legacy.preferenceVersion,profile_revision:legacy.profileRevision,source_generation:ctx.sourceGeneration,expires_at:legacy.expiresAt},built.refs);
 const read=await plans.read(ctx,planId);assert.equal(read.plan.version,MORNING_PLAN_VERSION);assert.match(renderMorningPlan(read.plan),/Body Energy: Analysis is updating/);
});

test('Smart Morning uses genuine finalized LIVE evidence, rejects changed copies, and falls back once to a source-only single briefing',async t=>{
 let sends=0;t.mock.method(globalThis,'fetch',async(url,options)=>{assert.equal(String(url),'https://api.telegram.org/botSYNTHETIC_NOT_A_TOKEN/sendMessage');const body=JSON.parse(options.body);assert.match(body.text,/Morning Brief/);assert.doesNotMatch(body.text,/Personal baseline median/);sends++;return new Response(JSON.stringify({ok:true,result:{message_id:77,date:1,chat:{id:10001,type:'private'}}}),{status:200});});
 const sourceAt=Date.now()-1000;let at=sourceAt-86400000;const now=()=>new Date(at),f=await syntheticPhase4Fixture(t,{targetVersion:35,now});
 const input=bodyInput({asOf:sourceAt,days:10});input.sources.sleep=input.sources.sleep.slice(0,1);
 for(let i=0;i<input.sources.recovery.length;i++)input.sources.recovery[i].recovery_score=i===0?10:60+i%5;
 // The clock is earlier only to request the existing next-day cutover. No
 // health calculation runs until the fixture clock reaches source time.
 await f.db.transaction(()=>seedBodyInput(f.db,input));await f.db.ensureOnboarding('a',{state:'READY',now:now()});await f.db.linkTelegram({userId:'a',chatId:'10001',now:now()});await f.db.setLocale('a','en',{now:now()});
 const environment={PHASE4_STAGE8_RUNTIME:'on',PHASE4_BETA_PILOT_USER_ID:'a',STAGE8_USER_IDS:'a',STAGE8_MORNING_BRIEF:'on'},env={telegramBotToken:'SYNTHETIC_NOT_A_TOKEN'},admission=await f.db.admitRuntime(),runtime=await createStage8MorningRuntime({...f,environment,env,admission,now});
 await runtime.core.initializeTenant('a','LIVE');const control=await runtime.core.captureControl('a'),preferenceControl=await f.core.captureControl('a'),prefs=await f.stores.preferences.read(preferenceControl);
 await f.stores.preferences.update(preferenceControl,prefs.preference_version,{morning_brief_mode:'FIXED_LOCAL_TIME',morning_brief_local_time:'00:00'});await runtime.store.requestCutover(control,{expectedRevision:0});
 at=Date.now();
 const producer=await createStage8LiveProducer({...f,admission,userIds:['a'],enabled:()=>true,eligible:id=>id==='a'});let result,legs=0;
 for(;legs<40;legs++){result=await producer.run({userId:'a',requestId:`smart-morning-genuine-${legs}`});t.diagnostic(`Genuine bounded producer leg ${legs+1}: ${result.publication.status}`);if(result.publication.status==='CURRENT')break;}
 assert.equal(result.publication.status,'CURRENT');
 at=Date.now(); // The briefing is created after the genuine work completed.
 const ready=await runtime.store.prepare(control);assert.equal(ready.status,'READY');
 let ctx=await runtime.store.context(control),message=(await runtime.core.artifact(ctx,'outbound_messages',{message_id:ready.messageId})).row,found=await runtime.store.plans.validate(ctx,message);
 assert.equal(found.plan.intelligence.status,'CURRENT');assert.ok(found.plan.intelligence.observations.length>0&&found.plan.intelligence.observations.length<=2);assert.ok(found.plan.intelligence.observations.some(value=>value.metricKey==='recovery_score'));
 assert.match(message.payload_text,/Personal baseline median/);assert.match(message.payload_text,/Baseline samples/);assert.match(message.payload_text,/No qualified estimate/);
 const link=(await f.db.raw.execute({sql:"SELECT source_type,source_id FROM phase4_source_links WHERE user_id='a' AND artifact_type='morning_brief_plans' AND artifact_id=? AND source_type IN ('observation_episodes','evidence_items','evidence_runs') AND unlinked_at IS NULL LIMIT 1",args:[found.row.privacy_artifact_id]})).rows[0];assert.ok(link,'derived evidence belongs to the plan privacy closure');
 await t.test('an actual source correction without changed computation metadata cannot validate the copied observation',async()=>{
  const stop=Error('OWNED_TEST_ROLLBACK');try{await f.db.transaction(async()=>{await f.db.raw.execute("UPDATE whoop_recoveries SET recovery_score=recovery_score+1 WHERE user_id='a'");await assert.rejects(runtime.store.plans.validate(ctx,message),/MORNING_INTELLIGENCE_CHANGED|SOURCE|PROVENANCE/);throw stop;});}catch(error){if(error!==stop)throw error;}
 });
 // Deliberately corrupt only this fixture's derived graph. Optional content
 // must not poison the source-only retry or authorize an unverified claim.
 await f.db.raw.execute({sql:"UPDATE phase4_source_links SET unlinked_at=? WHERE user_id='a' AND artifact_execution_mode='LIVE' AND artifact_type='evidence_runs' AND unlinked_at IS NULL",args:[now().toISOString()]});
 const fallback=await runtime.store.prepare(control);assert.equal(fallback.status,'READY');assert.equal(fallback.messageId,ready.messageId);assert.equal(fallback.refreshed,true);
 ctx=await runtime.store.context(control);message=(await runtime.core.artifact(ctx,'outbound_messages',{message_id:ready.messageId})).row;found=await runtime.store.plans.validate(ctx,message);
 assert.equal(found.plan.intelligence.status,'UNAVAILABLE');assert.doesNotMatch(message.payload_text,/Personal baseline median/);assert.match(message.payload_text,/available source records remain/);
 const request={userId:'a',expectedLifecycleGeneration:1,timezone:'Asia/Taipei',source:{poll:async()=>({sleeps:[],recoveries:[]})}};
 assert.equal((await runtime.daily(request)).status,'sent');assert.equal((await runtime.daily(request)).status,'already_sent');assert.equal(sends,1);
 assert.equal((await f.db.raw.execute("SELECT count(*) n FROM outbound_messages WHERE user_id='a' AND message_class='MORNING_BRIEF_V1'")).rows[0].n,1);
 t.diagnostic(`${legs+1} genuine owned synthetic producer legs; no Production, health-model or external-provider evidence.`);
});
