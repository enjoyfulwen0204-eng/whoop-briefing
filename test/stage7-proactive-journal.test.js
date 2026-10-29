import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createOwnedFileDb} from '../src/db.js';
import {fixtureKeys} from './localDb.js';
import {buildPhase4Core} from '../src/phase4Core.js';
import {composePhase4Stores} from '../src/phase4Repositories.js';
import {createSchemaTransitionRuntimeProfile,SCHEMA_TRANSITION_PROFILE} from '../src/schemaTransitionProfile.js';
async function syntheticPhase4Fixture(t,{targetVersion,now}){
 const directory=await mkdtemp(join(tmpdir(),'stage7-proactive-synthetic-'));
 const runtimeProfile=createSchemaTransitionRuntimeProfile({keys:fixtureKeys,environment:{PHASE4_EXECUTION_PROFILE:SCHEMA_TRANSITION_PROFILE}});
 const db=createOwnedFileDb({url:'file:'+join(directory,'fixture.db'),phase4Keys:fixtureKeys,runtimeProfile});
 t.after(async()=>{global.gc?.();await new Promise(r=>setImmediate(r));db.close();await rm(directory,{recursive:true,force:true});});
 await db.migrate({targetVersion});const admission=await db.admitRuntime();
 const core=await buildPhase4Core({processing:{client:db.raw,transaction:db.transaction,active:db.processingTransactionActive,afterCommit:db.afterProcessingCommit,afterCompletion:db.afterProcessingCompletion},keys:fixtureKeys,admission,now,authorizeMode(mode){assert.equal(mode,'SHADOW');}});
 for(const id of ['a','b']){await db.createUser({id,displayName:'Synthetic',timezone:'Asia/Taipei',status:'ACTIVE'},{now:now()});await core.initializeTenant(id,'SHADOW');}
 return {db,core,keys:fixtureKeys,stores:composePhase4Stores(core)};
}
import {createStage7Composition} from '../src/stage7Composition.js';
import {createStage7ProactiveJournal} from '../src/stage7ProactiveJournal.js';
import {createStage7Dispatcher,createSyntheticJournalTelegram} from '../src/stage7Dispatcher.js';
import {JOURNAL_COPY} from '../src/stage7Registry.js';
import {confirmedLegacyBrief} from './confirmedLegacyBriefFixture.js';

async function fixture(t,{outcomes=[],locale='en',hour='04',category='alcohol',targetDate='2026-09-17'}={}){
 const f=await syntheticPhase4Fixture(t,{targetVersion:33,now:()=>new Date(`2026-09-19T${hour}:00:00Z`)});
 await f.db.linkTelegram({userId:'a',chatId:'123',now:f.core.now()});
 await f.db.linkTelegram({userId:'b',chatId:'456',now:f.core.now()});
 await f.db.saveTokens('a',{accessToken:'synthetic',refreshToken:'synthetic',expiresAt:new Date('2026-12-01'),scope:'offline',whoopUserId:'synthetic'},{now:f.core.now()});
 await f.db.setLocale('a',locale);await f.db.ensureOnboarding('a',{state:'READY',now:f.core.now()});
 const user=await f.db.getUser('a'),companion=await createStage7Composition(f),actor=await companion.interactions.authenticate({user,chatId:'123'});
 const proactiveJournal=createStage7ProactiveJournal({...f,companion}),provider=createSyntheticJournalTelegram({outcomes}),dispatcher=createStage7Dispatcher({...f,companion,provider,proactiveJournal});
 const claim=await f.db.claimProactiveEvent('a',{healthDate:'2026-09-18',idempotencyKey:'synthetic-original',decision:'ASK_CONTEXT',policyVersion:'synthetic',signals:[],reason:{question_category:category,question_target_date:targetDate}},{now:f.core.now(),expectedLifecycleGeneration:user.lifecycleGeneration});
 const prepare=()=>proactiveJournal.prepare({user,chatId:'123',eventId:claim.id});
 const dispatch=deliveryId=>dispatcher.dispatch({user,chatId:'123',deliveryId});
 let sequence=0;
 async function tap(reply,label,{chat='123',messageId=reply.editMessageId??701}={}){
  const button=reply.replyMarkup.inline_keyboard.flat().find(b=>b.text.slice(b.text.indexOf(' ')+1)===label);assert.ok(button,label);
  return companion.handle({user,chatId:chat,callback:{id:String(++sequence),data:button.callback_data,from:{id:Number(chat)},message:{message_id:Number(messageId),chat:{id:Number(chat),type:'private'}}}});
 }
 return {...f,user,actor,companion,proactiveJournal,provider,dispatcher,prepare,dispatch,tap,claim,c:JOURNAL_COPY[locale]};
}
for(const locale of ['zh-TW','en','vi'])test(`v33 original event sends one localized trusted keyboard; note/navigation create no fact (${locale})`,async t=>{
 const f=await fixture(t,{locale}),p=await f.prepare();assert.equal(p.status,'PROPOSED');
 assert.equal((await f.dispatch(p.deliveryId)).status,'DELIVERED');assert.equal((await f.dispatch(p.deliveryId)).status,'DELIVERED');assert.equal(f.provider.calls.length,1);
 let card=f.provider.calls[0];assert.match(card.text,/2026-09-17/);
 const buttons=card.replyMarkup.inline_keyboard.flat();
 for(const label of [f.c.yes,f.c.no,f.c.unsure,f.c.skip,f.c.note])assert.ok(buttons.some(b=>b.text.endsWith(label)));
 assert.ok(buttons.every(b=>/\p{Extended_Pictographic}/u.test(b.text)&&/^j7:[A-Za-z0-9_-]{32}$/.test(b.callback_data)));
 assert.equal((await f.db.raw.execute('SELECT count(*) n FROM pending_questions')).rows[0].n,0);
 assert.equal((await f.companion.preferences(f.actor)).daily_enabled,0);
 card=await f.tap(card,f.c.note);card=await f.tap(card,f.c.back);
 assert.equal((await f.db.raw.execute('SELECT state,selected_choice FROM quick_action_interactions')).rows[0].selected_choice,null);
 assert.ok(card.text.includes(f.c.questions[1]));
 card=await f.companion.handleNote({user:f.user,chatId:'123',text:'Synthetic optional detail'});
 assert.ok(card.text.includes(f.c.questions[1]));
 assert.equal((await f.db.raw.execute('SELECT count(*) n FROM journal_events')).rows[0].n,0);
 card=await f.tap(card,f.c.yes);card=await f.tap(card,f.c.confirm);
 const fact=(await f.db.raw.execute("SELECT * FROM journal_events WHERE fact_status='ACTIVE'")).rows[0];
 assert.equal(fact.health_date,'2026-09-17');assert.equal(fact.provenance_mode,'TRUSTED_REGISTRY');assert.equal(fact.exposure_state,'EXPOSED');
 card=await f.tap(card,f.c.edit);card=await f.tap(card,f.c.no);card=await f.tap(card,f.c.confirm);
 assert.equal((await f.db.raw.execute("SELECT exposure_state FROM journal_events WHERE fact_status='ACTIVE'")).rows[0].exposure_state,'CONFIRMED_UNEXPOSED');
 await f.tap(card,f.c.undo);assert.equal((await f.db.raw.execute("SELECT count(*) n FROM journal_events WHERE fact_status='ACTIVE'")).rows[0].n,0);
});
for(const outcome of ['AMBIGUOUS','FAILED_DEFINITE','MALFORMED'])test(`original claim never gains another transport attempt after ${outcome}`,async t=>{
 const f=await fixture(t,{outcomes:[outcome]}),p=await f.prepare();const first=await f.dispatch(p.deliveryId);
 assert.equal(first.status,outcome==='MALFORMED'?'AMBIGUOUS':outcome);await f.dispatch(p.deliveryId);assert.equal(f.provider.calls.length,1);
 assert.equal((await f.db.raw.execute('SELECT count(*) n FROM journal_events')).rows[0].n,0);
});
for(const category of ['stress','sickness'])test(`unsupported legacy ${category} is not moved or reinterpreted`,async t=>{
 const f=await fixture(t,{category,targetDate:'2026-09-19'});assert.equal((await f.prepare()).status,'UNSUPPORTED_OR_FENCED_QUESTION');assert.equal(f.provider.calls.length,0);
});
test('preserve an unanswered legacy question byte for byte and suppress new question',async t=>{
 const f=await fixture(t);await f.db.openPendingQuestion('a',{chatId:'123',question:'Synthetic old question',intent:'proactive_context',contextJson:{question_target_date:'2026-09-16'},ttlMs:3600000},{now:f.core.now()});
 const before=(await f.db.raw.execute('SELECT * FROM pending_questions')).rows;
 assert.equal((await f.prepare()).status,'INTERACTION_BUSY');assert.deepEqual((await f.db.raw.execute('SELECT * FROM pending_questions')).rows,before);
});
for(const gate of ['disabled','quiet','paused','excluded','not-ready'])test(`original legacy consent path remains fenced by ${gate}`,async t=>{
 const f=await fixture(t,{hour:gate==='quiet'?'16':'04'});
 if(gate==='disabled')await f.db.setProactiveEnabled('a',false,{now:f.core.now()});
 if(gate==='paused')await f.db.raw.execute("INSERT INTO user_notification_preferences(user_id,notifications_paused,created_at,updated_at) VALUES('a',1,'2026-09-19T04:00:00Z','2026-09-19T04:00:00Z') ON CONFLICT(user_id) DO UPDATE SET notifications_paused=1");
 if(gate==='excluded')await f.core.transaction(async()=>{const p=await f.companion.preferences(f.actor);await f.companion.changePreferences(f.actor,p,{excluded_topics_json:'["alcohol"]'});});
 if(gate==='not-ready')await f.db.raw.execute("UPDATE user_onboarding SET state='SYNCING' WHERE user_id='a'");
 assert.equal((await f.prepare()).status,'PREFERENCE_OR_ENROLLMENT_FENCED');assert.equal(f.provider.calls.length,0);
});
test('shared local delivery-day reservation blocks ordinary Daily and overlapping events',async t=>{
 const f=await fixture(t),p=await f.prepare();assert.equal(p.status,'PROPOSED');
 await f.core.transaction(async()=>{const pref=await f.companion.preferences(f.actor);await f.companion.changePreferences(f.actor,pref,{daily_enabled:1});});
 await confirmedLegacyBrief(f);
 const daily=await f.companion.prepareAfterBrief({user:f.user,chatId:'123',healthDay:'2026-09-19'});
 assert.equal(daily.status,'EXISTING');assert.equal(daily.deliveryId,p.deliveryId);
 assert.equal((await f.db.raw.execute('SELECT count(*) n FROM quick_action_interactions')).rows[0].n,1);
});
test('forged ownership, target mutation and stale preference revision cannot dispatch',async t=>{
 const f=await fixture(t),p=await f.prepare();
 await assert.rejects(f.proactiveJournal.prepare({user:await f.db.getUser('b'),chatId:'123',eventId:f.claim.id}),/ACTOR_FENCED/);
 await f.db.raw.execute("UPDATE quick_action_interactions SET target_date='2026-09-18' WHERE user_id='a'");
 assert.equal((await f.dispatch(p.deliveryId)).status,'SUPPRESSED');assert.equal(f.provider.calls.length,0);
});
test('unpunctuated unrelated questions keep normal routing and direct answers preserve the old target',async t=>{
 const f=await fixture(t),p=await f.prepare();await f.dispatch(p.deliveryId);
 for(const text of ['為什麼今天這麼累','why am I tired today','tại sao hôm nay tôi mệt'])assert.equal(await f.companion.handleNote({user:f.user,chatId:'123',text}),null);
 const reply=await f.companion.handleNote({user:f.user,chatId:'123',text:'Synthetic direct context'});
 assert.match(reply.text,/2026-09-17/);assert.ok(reply.text.includes(f.c.questions[1]));
 assert.equal((await f.db.raw.execute('SELECT count(*) n FROM journal_events')).rows[0].n,0);
});
for(const [locale,queries,context] of [
 ['zh-TW',['看一下我的 HRV','我最近的 HRV','我最近7天的 HRV'],'我的 HRV 下班後很低'],
 ['en',['show my HRV','my HRV trend','HRV over the last 7 days'],'HRV was low after work'],
 ['vi',['cho tôi xem HRV','xu hướng HRV'],'Strain cao sau buổi tập'],
])test(`implicit Journal notes preserve metric query routing and explicit note intent (${locale})`,async t=>{
 const f=await fixture(t,{locale}),p=await f.prepare();await f.dispatch(p.deliveryId);
 const original=(await f.db.raw.execute('SELECT * FROM quick_action_interactions')).rows;
 for(const text of queries){
  assert.equal(await f.companion.handleNote({user:f.user,chatId:'123',text}),null,'UNRELATED_METRIC_QUERY_MUST_REACH_NORMAL_ROUTER');
  assert.deepEqual((await f.db.raw.execute('SELECT * FROM quick_action_interactions')).rows,original,'UNANSWERED_ORIGINAL_QUESTION_UNCHANGED');
 }
 for(const text of ['HRV 42','Strain 16.2','my HRV 42',`HRV ${'1'.repeat(80)}X`]){
  const start=performance.now(),reply=await f.companion.handleNote({user:f.user,chatId:'123',text});assert.ok(reply,'MEASUREMENT_AND_NON_QUERY_CONTEXT_MUST_REMAIN_NOTES');
  assert.ok(performance.now()-start<5000,'SHORT_CONTEXT_MUST_NOT_BLOCK_ROUTING');
  const current=(await f.db.raw.execute('SELECT * FROM quick_action_interactions')).rows[0];assert.equal(current.note,text);assert.equal(current.target_date,original[0].target_date);
 }
 const card=await f.companion.handleNote({user:f.user,chatId:'123',text:context});assert.ok(card);
 const noted=(await f.db.raw.execute('SELECT * FROM quick_action_interactions')).rows[0];
 assert.equal(noted.note,context);assert.equal(noted.state,'ISSUED');assert.equal(noted.target_date,original[0].target_date);
 const explicit=await f.tap(card,f.c.note);assert.ok(explicit);
 const reply=await f.companion.handleNote({user:f.user,chatId:'123',text:queries[0]});assert.ok(reply,'EXPLICIT_NOTE_MODE_RETAINS_USER_TEXT');
 const after=(await f.db.raw.execute('SELECT * FROM quick_action_interactions')).rows[0];
 assert.equal(after.note,queries[0]);assert.equal(after.selected_choice,null);assert.equal(after.target_date,original[0].target_date);
 assert.equal((await f.db.raw.execute('SELECT count(*) n FROM journal_events')).rows[0].n,0);
 assert.equal((await f.db.raw.execute('SELECT count(*) n FROM pending_questions')).rows[0].n,0);assert.equal(f.provider.calls.length,1);
});
test('reactive broad follow-up offers topic navigation without assuming a fact or overriding old questions',async t=>{
 const f=await fixture(t),card=await f.companion.prepareContextQuestion({user:f.user,chatId:'123',healthDate:'2026-09-18'});
 assert.equal(card.replyMarkup.inline_keyboard.length>5,true);
 const row=await f.companion.interactions.read('a',card.stage7InteractionId);assert.equal(row.target_date,'2026-09-17');assert.equal(row.category,null);assert.equal(row.selected_choice,null);
 assert.equal((await f.db.raw.execute('SELECT count(*) n FROM journal_events')).rows[0].n,0);
 assert.equal((await f.prepare()).status,'INTERACTION_BUSY');
});
test('preferences changed after reservation fence the original dispatch',async t=>{
 const f=await fixture(t),p=await f.prepare();
 await f.core.transaction(async()=>{const pref=await f.companion.preferences(f.actor);await f.companion.changePreferences(f.actor,pref,{excluded_topics_json:'["alcohol"]'});});
 assert.equal((await f.dispatch(p.deliveryId)).status,'SUPPRESSED');assert.equal(f.provider.calls.length,0);
});
test('an own keyboard rejects cross-user and stale clicks; unsure and skip never become negative facts',async t=>{
 const f=await fixture(t),p=await f.prepare();await f.dispatch(p.deliveryId);const card=f.provider.calls[0];
 const foreign=await f.companion.handle({user:await f.db.getUser('b'),chatId:'456',callback:{id:'foreign',from:{id:456},data:card.replyMarkup.inline_keyboard[0][0].callback_data,message:{message_id:701,chat:{id:456,type:'private'}}}});
 assert.equal(foreign.text,f.c.expired);let reply=await f.tap(card,f.c.unsure);
 const before=(await f.db.raw.execute('SELECT state,revision FROM quick_action_interactions')).rows[0];
 await f.tap(card,f.c.no);assert.deepEqual((await f.db.raw.execute('SELECT state,revision FROM quick_action_interactions')).rows[0],before);
 reply=await f.tap(reply,f.c.edit);await f.tap(reply,f.c.skip);
 assert.equal((await f.db.raw.execute('SELECT count(*) n FROM journal_events')).rows[0].n,0);
});
test('real Proactive detection routes its original claim to one keyboard and no new legacy pending row',async t=>{
 const f=await fixture(t),{checkAndAct}=await import('../src/proactiveAgent.js');
 // Independent synthetic physiology: thirty-five baseline days, then two
 // persistently low HRV days. No accepted insight or episode is fabricated.
 const origin=Date.parse('2026-08-14T00:00:00Z');
 async function day(n){
  const end=new Date(origin+n*86400000).toISOString(),start=new Date(origin+n*86400000-8*3600000).toISOString(),id=`synthetic-proactive-${n}`;
  await f.db.upsertSleeps('a',[{id,start,end,nap:false,score_state:'SCORED',timezone_offset:'+08:00',score:{sleep_performance_percentage:85,respiratory_rate:15,stage_summary:{total_light_sleep_time_milli:14000000,total_slow_wave_sleep_time_milli:7000000,total_rem_sleep_time_milli:6000000,total_awake_time_milli:1000000,total_no_data_time_milli:0,total_in_bed_time_milli:28000000},sleep_needed:{baseline_milli:28000000,need_from_sleep_debt_milli:0,need_from_recent_strain_milli:0,need_from_recent_nap_milli:0}}}],{timezone:'Asia/Taipei'});
  await f.db.upsertRecoveries('a',[{sleep_id:id,score_state:'SCORED',score:{recovery_score:60+n%3-1,hrv_rmssd_milli:n<35?50+n%4-2:n===35?15:14,resting_heart_rate:55+n%3-1,user_calibrating:false}}]);
 }
 for(let n=0;n<=35;n++)await day(n);
 await f.db.saveCapabilities('a',['hrv','rhr','recovery_score'].map(key=>({key,status:'SUPPORTED',reason:'synthetic'})),{expectedLifecycleGeneration:1,now:f.core.now()});
 // The generic fixture's unused original claim must not count as a delivered
 // observation or an artificial continuity signal for this separate pipeline.
 await f.db.raw.execute("UPDATE proactive_events SET decision='LOG_ONLY' WHERE id=1");
 const telegram={send(){throw Error('PLAIN_TEXT_SELECTION_MUST_NOT_SEND');}};
 const request={db:f.db,userId:'a',timezone:'Asia/Taipei',locale:'en',chatId:'123',expectedLifecycleGeneration:1,telegram,
  proactiveJournal:async({eventId})=>{const p=await f.proactiveJournal.prepare({user:f.user,chatId:'123',eventId});return p.deliveryId?f.dispatch(p.deliveryId):p;}};
 const first=await checkAndAct({...request,now:new Date('2026-09-18T04:00:00Z')});assert.equal(first.messageSent,false);
 await day(36);const result=await checkAndAct({...request,now:f.core.now()});
 assert.equal(result.decision,'ASK_CONTEXT');assert.equal(result.messageSent,true);assert.equal(f.provider.calls.length,1);
 assert.equal((await f.db.raw.execute('SELECT count(*) n FROM pending_questions')).rows[0].n,0);
 assert.equal((await f.db.raw.execute('SELECT count(*) n FROM journal_events')).rows[0].n,0);
 const event=(await f.db.raw.execute("SELECT * FROM proactive_events WHERE decision='ASK_CONTEXT'")).rows[0];
 assert.equal(event.outcome,'DELIVERED');assert.equal(JSON.parse(event.reason_json).question_target_date,'2026-09-18');
 assert.deepEqual(await f.db.listUnresolvableProactiveEvents('a',{olderThanIso:'2026-09-21T00:00:00Z'}),[]);
 await checkAndAct({...request,now:f.core.now()});assert.equal(f.provider.calls.length,1);
});
test('simultaneous original-event preparations and dispatches reserve one question and one transport',async t=>{
 const f=await fixture(t),prepared=await Promise.all([f.prepare(),f.prepare()]);
 assert.equal(prepared[0].deliveryId,prepared[1].deliveryId);
 const results=await Promise.all(prepared.map(p=>f.dispatch(p.deliveryId)));
 assert.ok(results.some(r=>r.status==='DELIVERED'));assert.equal(f.provider.calls.length,1);
 assert.equal((await f.db.raw.execute('SELECT count(*) n FROM journal_prompt_deliveries')).rows[0].n,1);
 assert.equal((await f.db.raw.execute('SELECT count(*) n FROM journal_delivery_attempts')).rows[0].n,1);
});
