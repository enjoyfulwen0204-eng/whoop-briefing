import test from 'node:test';
import assert from 'node:assert/strict';
import {runDaily} from '../src/daily.js';
import {runForUser} from '../src/index.js';
import {buildBriefing} from '../src/daily.js';
import {readMorningHistory,morningInsights,MORNING_RESOURCES} from '../src/morningSources.js';
import {renderDaily,renderWhatChanged} from '../src/format.js';
import {makeDataset} from './fixtures.js';
import {fakeDb,fakeTelegram,fakeCoach} from './fakes.js';
import {LIFECYCLE_UNFENCED} from '../src/accountLifecycle.js';
import {WHOOP_SYNC} from '../src/config.js';
import {typedSyncResult} from '../src/syncResult.js';
import {selectBodyEnergyInputs} from '../src/bodyEnergyInputs.js';
import {calculateBodyEnergy,calculateWakeBodyEnergy} from '../src/bodyEnergy.js';
import {bodyInput,seedBodyInput} from './bodyEnergyFixture.js';
import {syntheticStage7V33Fixture} from './stage7-v33-fixture.js';
import {createOnDemandBodyEnergy} from '../src/onDemandBodyEnergy.js';
import {morningCoachFooter} from '../src/morningCoachFooter.js';
import {createExecutionBudget,withExecutionBudget} from '../src/executionBudget.js';
import {createCoach} from '../src/coach.js';

const timezone='Asia/Taipei',now=new Date('2026-11-05T02:00:00Z');
const data=()=>makeDataset({now,withNaps:false,overrides:{0:{hrv:90,strain:4,recovery_score:46}}});
test('stale DB cannot supply a different report block; one freshly prepared history and cycle are shared',async()=>{
 const fresh=data(),db=fakeDb(),telegram=fakeTelegram();let prepared=0,bodyCalls=0;
 db.getSleeps=db.getRecoveries=db.getCycles=async()=>{throw Error('OLD_DB_READ_FORBIDDEN');};
 const b=buildBriefing({...fresh,timezone,healthDate:'2026-11-05'}),changes=morningInsights(fresh,timezone,b.healthDate);
 assert.equal(changes.whatChanged.find(c=>c.metric==='hrv').current,b.metrics.find(m=>m.key==='hrv').value);
 const bodyEnergy={currentSection:async({healthDate,morning})=>{bodyCalls++;assert.equal(healthDate,b.healthDate);assert.equal(morning,true);return null;}};
 const result=await runDaily({db,telegram,bodyEnergy,userId:'a',timezone,now,coach:fakeCoach(),expectedLifecycleGeneration:LIFECYCLE_UNFENCED,
  source:{poll:async()=>fresh,history:async()=>{throw Error('SECOND_PROVIDER_SNAPSHOT_FORBIDDEN');}},
  prepareMorningSources:async()=>{prepared++;return{history:fresh,coach:fakeCoach()};}});
 assert.equal(result.status,'sent');assert.equal(prepared,1);assert.equal(bodyCalls,1);assert.equal(telegram.sent.length,1);
 assert.equal(db.runs[0].cycleId,b.cycleId);assert.match(telegram.sent[0],/90ms/);
});
test('incomplete required sync never claims or sends; next call can continue with the same normal claim key',async()=>{
 const fresh=data(),db=fakeDb(),telegram=fakeTelegram(),args={db,telegram,userId:'a',timezone,now,coach:fakeCoach(),expectedLifecycleGeneration:LIFECYCLE_UNFENCED,
  source:{poll:async()=>fresh,history:async()=>fresh},prepareMorningSources:async()=>null};
 assert.equal((await runDaily(args)).reason,'MORNING_SYNC_PENDING');assert.equal(db.claims.size,0);assert.equal(telegram.sent.length,0);
 args.prepareMorningSources=async()=>({history:fresh,coach:fakeCoach()});assert.equal((await runDaily(args)).status,'sent');
 assert.equal((await runDaily(args)).status,'already_sent');assert.equal(telegram.sent.length,1);
});
test('canonical user path commits required sources before daily content and never syncs them twice',async()=>{
 const fresh=data(),calls=[];let canonical={sleeps:[],recoveries:[],cycles:[]};
 const rows=key=>async()=>canonical[key].map(r=>({raw_json:JSON.stringify(r)}));
 const db={assertAccountActive:async()=>{},getActiveChatIdForUser:async()=> 'synthetic',getLocale:async()=> 'en',isSent:async()=>false,
  getAllSyncState:async()=>[],getSyncState:async()=>null,coverage:async()=>({last_date:null}),getSleeps:rows('sleeps'),getRecoveries:rows('recoveries'),getCycles:rows('cycles')};
 const result=await runForUser({db,env:{dryRun:true},user:{id:'synthetic',timezone,lifecycleGeneration:1},now,deps:{
  reap:async()=>({}),makeTelegram:()=>({notifyError:async()=>{}}),makeWhoop:()=>({getAccessToken:async()=> 'synthetic'}),makeCoach:()=>({}),makeSource:()=>({}),
  daily:async ctx=>{const result=await ctx.prepareMorningSources();assert.deepEqual(result.history.sleeps,fresh.sleeps);calls.push('report');return {status:'sent'};},
  weekly:async()=>({}),makeSync:()=>({syncAll:async options=>{calls.push([...options.resources]);if(options.force)canonical=fresh;return typedSyncResult(options.resources.map(resource=>({resource,status:'ok',fetched:1})),{expectedResources:options.resources});}}),proactive:async()=>({})}});
 assert.deepEqual(calls,[[...MORNING_RESOURCES],'report',WHOOP_SYNC.RESOURCES.filter(r=>!MORNING_RESOURCES.includes(r))]);
 assert.equal(result.sync.complete,true);assert.deepEqual(result.errors,[]);
});
test('missing canonical JSON fails closed, never substitutes unadmitted provider data',async()=>{
 const db={getSleeps:async()=>[{id:'x'}],getRecoveries:async()=>[],getCycles:async()=>[]};
 await assert.rejects(readMorningHistory({db,userId:'a',timezone,now}),{code:'MORNING_SOURCE_UNAVAILABLE'});
});
for(const locale of ['zh-TW','en','vi'])test(`${locale}: WHOOP Recovery bands, relative warning, and no Strain highlights`,()=>{
 for(const [value,light] of [[46,'🟡'],[70,'🟢'],[30,'🔴']]){
  const b=buildBriefing({...makeDataset({now,overrides:{0:{recovery_score:value}}}),timezone,healthDate:'2026-11-05'});
  const recovery=b.metrics.find(m=>m.key==='recovery_score');recovery.severity='green';
  assert.ok(renderDaily(b,null,{locale}).split('\n')[1].includes(light));
  recovery.severity='red';recovery.baseline=90;assert.ok(renderDaily(b,null,{locale}).split('\n')[1].includes(light+'⚠️'));
 }
 assert.deepEqual(renderWhatChanged([{metric:'previous_day_strain',current:4,vs_30d_pct:-70,z_score:-3},{metric:'strain',current:19,vs_30d_pct:70,z_score:3}],locale),[]);
});
test('wake estimate alone treats absent load as informational; no other eligibility changes',()=>{
 const input=bodyInput();input.sources.cycle=[];const {manifest}=selectBodyEnergyInputs(input),before=structuredClone(manifest);
 assert.equal(calculateBodyEnergy(manifest).quality_state,'DEGRADED');const wake=calculateWakeBodyEnergy(manifest);
 assert.equal(wake.quality_state,'AVAILABLE');assert.ok(Number.isFinite(wake.drivers.initial_charge));assert.ok(wake.reasons.includes('LOAD_UNAVAILABLE'));assert.deepEqual(manifest,before);
 const invalid=structuredClone(manifest);invalid.warnings.push('HEALTH_DATE_REALIGNMENT');assert.equal(calculateWakeBodyEnergy(invalid).quality_state,'DEGRADED');
 invalid.eligibility.required_sync_valid=false;assert.equal(calculateWakeBodyEnergy(invalid).quality_state,'NO_DATA');
});
test('actual read-only Body path and reply guard preserve morning/daytime separation without stored results',async t=>{
 const f=await syntheticStage7V33Fixture(t,{targetVersion:33,now:()=>now}),input=bodyInput({asOf:now.getTime()});input.sources.cycle=[];
 await f.db.linkTelegram({userId:'a',chatId:'123',now});await f.db.setLocale('a','zh-TW',{now});await seedBodyInput(f.db,input);await f.db.ensureOnboarding('a',{state:'READY',now});
 const body=createOnDemandBodyEnergy({...f,environment:{BODY_ENERGY_ON_DEMAND:'on'},now:()=>now});
 const morning=await body.currentSection({userId:'a',requestedAt:now,morning:true,expectedSleepId:'sleep-00'});assert.equal(morning.status,'AVAILABLE');assert.match(morning.message,/70\/100/);assert.equal(await morning.verifyCurrent(),true);
 assert.equal((await body.currentSection({userId:'a',requestedAt:now})).status,'DEGRADED');
 await assert.rejects(body.currentSection({userId:'a',requestedAt:now,morning:true,expectedSleepId:'different-sleep'}),{code:'BODY_ENERGY_MORNING_SOURCE_CHANGED'});
 await assert.rejects(body.verifyReplyGuard({...morning.replyGuard,morning:false},'a'));
 assert.equal((await f.db.raw.execute('SELECT count(*) n FROM body_energy_results')).rows[0].n,0);
});
const text='Recovery 65%.',answer='Plan your demanding tasks for when you feel alert. Leave time to unwind after dinner.';
test('context time does not spend the LLM timeout, and both timings are sanitized',async t=>{
 const logs=[];t.mock.method(console,'log',s=>logs.push(JSON.parse(s)));
 const tail=await morningCoachFooter({text,locale:'en',userId:'a',timeoutMs:60,db:{getRecentInsights:async()=>{await new Promise(r=>setTimeout(r,80));return[];}},coach:{footerText:async()=>{await new Promise(r=>setTimeout(r,20));return answer;}}});
 assert.match(tail,/Coach/);assert.ok(logs[0].context_duration_ms>=70);assert.ok(logs[0].llm_duration_ms>=15);assert.equal(logs[0].reason,'OK');assert.doesNotMatch(JSON.stringify(logs),/Recovery|dinner/);
 assert.deepEqual(Object.keys(logs[0]).sort(),['context_duration_ms','event','llm_duration_ms','reason','user']);
});
test('budget is rechecked after context; insufficient parent time performs zero LLM requests',async t=>{
 const logs=[];t.mock.method(console,'log',s=>logs.push(JSON.parse(s)));let remaining=45000,called=0;
 const budget={remainingMs:()=>remaining,assert:()=>{}};
 assert.equal(await withExecutionBudget(budget,()=>morningCoachFooter({text,locale:'en',userId:'a',db:{getRecentInsights:async()=>{remaining=29999;return[];}},coach:{footerText:async()=>{called++;return answer;}}})), '');
 assert.equal(called,0);assert.equal(logs[0].reason,'BUDGET_TOO_LOW');
});
test('footer model is independently routed, with MODEL_DAILY fallback and unchanged narrative model',async()=>{
 for(const configured of [true,false]){
  const models=[],env={MODEL_DAILY:'anthropic/claude-sonnet-5',...(configured?{MODEL_COACH_FOOTER:'anthropic/claude-haiku-5.5'}:{})};
  const coach=createCoach({apiKey:'SYNTHETIC',userId:null,env,maxRetries:1,fetchImpl:async(url,options)=>{models.push(JSON.parse(options.body).model);return Response.json({choices:[{message:{content:answer}}]});}});
  await coach.footerText({report:text});await coach.daily({localDate:'2026-11-05',stage:'cold',sampleCount:0,metrics:[],trends:{}});
  assert.deepEqual(models,[configured?env.MODEL_COACH_FOOTER:env.MODEL_DAILY,env.MODEL_DAILY]);
 }
});
