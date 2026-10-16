import test from 'node:test';
import assert from 'node:assert/strict';
import {stage8Fixture} from './stage8Fixture.js';
import {createStage7Development} from '../src/stage7Development.js';
import {createCompanionCoach} from '../src/companionCoach.js';
import {createCompanionCoachContext,COACH_CONTEXT_COPY,COACH_FOLLOWUPS} from '../src/companionCoachContext.js';
import {createScopedHealthContext} from '../src/scopedHealthContext.js';

const projection={text:'Synthetic source summary',stage7View:'COACH',replyMarkup:{inline_keyboard:[]}};
const projectInput=f=>({...f.input,topic:'recovery',range:'week',focus:'baseline',locale:'en',reply:projection});

test('Coach context uses a real private self scope; no producer stays explicitly unavailable and send authority fences source or actor changes',async t=>{
 const f=await stage8Fixture(t),adapter=createCompanionCoachContext({scopes:f.app.scopes}),reply=await adapter.project(projectInput(f));
 assert.match(reply.text,/No verified current analysis/);assert.ok(reply.stage7CoachContextGuard);
 assert.equal(await adapter.verifyReply({userId:'a',chatId:'123',reply:{...reply,stage7ReplyGuard:{downstream:true}}}),true);
 assert.equal(await adapter.verifyReply({userId:'b',chatId:'456',reply}),false);
 assert.equal(await adapter.verifyReply({userId:'a',chatId:'123',reply:{...reply,text:'Altered claim'}}),false);
 await f.db.raw.execute("UPDATE phase4_user_state SET source_generation=source_generation+1 WHERE user_id='a'");
 assert.equal(await adapter.verifyReply({userId:'a',chatId:'123',reply}),false);
 const noRuntime=createCompanionCoachContext({getScopes:()=>null});
 assert.equal(await noRuntime.verifyReply({userId:'a',chatId:'123',reply}),false);
 assert.match((await noRuntime.project(projectInput(f))).text,/No verified current analysis/);
 await assert.rejects(adapter.project({...projectInput(f),topic:'user:b'}),/REGISTERED_QUERY/);
});

for(const locale of ['zh-TW','en','vi'])test(`Coach ${locale} topic/range follow-ups use registry callbacks, keep free text, and never create Journal facts`,async t=>{
 const f=await stage8Fixture(t);await f.db.setLocale('a',locale,{now:f.now()});
 const companion=await createStage7Development(f),actor=await companion.interactions.authenticate(f.input),adapter=createCompanionCoachContext({getScopes:()=>f.app.scopes}),coach=createCompanionCoach({...f,companion,coachContext:adapter});
 let reply=await coach.handle({...f.input,text:'/coach',requestKey:`context-${locale}`}),seq=0;
 const tap=async index=>{
  await companion.interactions.bind(actor,reply.stage7InteractionId,44);const button=reply.replyMarkup.inline_keyboard.flat()[index];assert.ok(button);
  const callback={id:`context-${locale}-${++seq}`,data:button.callback_data,from:{id:123,is_bot:false},message:{message_id:44,chat:{id:123,type:'private'}}};
  reply=await coach.handle({...f.input,callback});return callback;
 };
 await tap(1);assert.match(reply.text,new RegExp(COACH_CONTEXT_COPY[locale].choose));
 await tap(4);assert.ok(reply.stage7CoachContextGuard);assert.equal(reply.replyMarkup.inline_keyboard.flat().length,10);
 for(const button of reply.replyMarkup.inline_keyboard.flat())assert.match(button.text,/\p{Extended_Pictographic}/u);
 for(let i=0;i<COACH_FOLLOWUPS.length;i++){
  await tap(5+i);const row=await companion.interactions.read('a',reply.stage7InteractionId),d=JSON.parse(row.diagnostics_json);
  assert.equal(d.coachTopic,'recovery');assert.equal(d.coachRange,'week');assert.equal(d.coachFocus,COACH_FOLLOWUPS[i]);
  assert.match(reply.text,new RegExp(COACH_CONTEXT_COPY[locale].unavailable));
 }
 const stale=await tap(9);assert.equal(JSON.parse((await companion.interactions.read('a',reply.stage7InteractionId)).diagnostics_json).coachFree,true);
 assert.equal(reply.stage7CoachContextGuard,undefined);
 const before=(await companion.interactions.read('a',reply.stage7InteractionId)).revision;
 await coach.handle({...f.input,callback:stale});
 assert.equal((await companion.interactions.read('a',reply.stage7InteractionId)).revision,before);
 assert.equal((await f.db.raw.execute('SELECT count(*) n FROM journal_events')).rows[0].n,0);
 const own=await coach.handle({...f.input,text:'/coach',requestKey:'cross-user'}),foreign=own.replyMarkup.inline_keyboard.flat()[0];
 assert.equal(await coach.handle({user:await f.db.getUser('b'),chatId:'456',callback:{id:'foreign',data:foreign.callback_data,from:{id:456},message:{message_id:44,chat:{id:456,type:'private'}}}}),null);
 assert.equal(JSON.parse((await companion.interactions.read('a',own.stage7InteractionId)).diagnostics_json).coachTopic,null);
});

test('typed current Coach observations are topic/date scoped, evidence-backed, non-causal and preserve historical limitations',async t=>{
 // The only substitute reader is inside this owned synthetic in-memory test.
 // It exercises presentation; it does not establish a genuine LIVE publication.
 const f=await stage8Fixture(t);await f.core.initializeTenant('a','LIVE');
 await f.db.raw.execute("UPDATE phase4_computation_state SET last_completed_generation=input_generation WHERE user_id='a' AND execution_mode='LIVE'");
 const evidence={metricKey:'recovery_score',method:'PERSONAL_BASELINE_DEVIATION',unit:'score',nonCausal:true,asOfUtc:f.now().toISOString(),period:{from:'2026-08-01T00:00:00Z',to:f.now().toISOString()},healthDate:'2026-09-19',samples:20,quality:'AVAILABLE',outcome:'PERSONAL_BASELINE_COMPARISON',current:40,baseline:{median:60,q1:50,q3:70},delta:-20};
 const {healthDate,...associationBase}=evidence,association={...associationBase,period:{from:evidence.period.from,to:'2026-09-18T18:00:00Z'},method:'JOURNAL_ASSOCIATION',factor:'alcohol',direction:'LOWER',outcome:'REPEATED_ASSOCIATION_EVIDENCE',exposedCount:9,unexposedCount:22,unknownCount:4};
 const reader=async({scope,kind})=>({status:'CURRENT',kind,asOfUtc:scope.asOfUtc,validUntil:scope.asOfEpochMs+60000,historyScope:'RETAINED_CURRENT_GENERATION_ONLY',items:kind==='INSIGHTS'?[{kind,metricKey:'recovery_score',factor:'alcohol',direction:'LOWER',nonCausal:true,evidence:[association]}]:kind==='EPISODES'?[{kind,metricKey:'recovery_score',direction:'LOWER',state:'RESOLVED',nonCausal:true,lastObservedAt:f.now().toISOString(),resolvedAt:f.now().toISOString(),history:[{state:'OPEN',at:'2026-09-18T01:00:00Z'},{state:'RESOLVED',at:f.now().toISOString()}],evidence:[evidence]}]:[{kind,evidence:[evidence,{...evidence,metricKey:'sleep_duration_minutes',current:777},{...evidence,healthDate:'2026-08-01',current:999}]}]});
 const scopes=await createScopedHealthContext({...f,derivedReader:reader,now:f.now}),adapter=createCompanionCoachContext({scopes});
 const baseline=await adapter.project(projectInput(f));assert.match(baseline.text,/Current value: 40/);assert.match(baseline.text,/Personal baseline median: 60/);assert.match(baseline.text,/Baseline samples: 20/);assert.doesNotMatch(baseline.text,/777|999/);
 const patterns=await adapter.project({...projectInput(f),focus:'patterns',range:'today'});assert.match(patterns.text,/Alcohol.*associated/);assert.match(patterns.text,/not causation/);
 const history=await adapter.project({...projectInput(f),focus:'history'});assert.match(history.text,/Observation resolved/);assert.match(history.text,/not a complete health history/);assert.doesNotMatch(history.text,/remains under observation/);
 const sleep=await adapter.project({...projectInput(f),topic:'exercise'});assert.match(sleep.text,/No qualifying current analysis/);assert.doesNotMatch(sleep.text,/Current value: 40/);
 assert.equal(await adapter.verifyReply({userId:'a',chatId:'123',reply:baseline}),true);
});
