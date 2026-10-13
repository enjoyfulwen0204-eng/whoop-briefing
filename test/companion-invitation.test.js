import {createPhase4Redactor,physicallyScrubbed} from '../src/phase4Redaction.js';
import test from 'node:test';import assert from 'node:assert/strict';
import {syntheticPhase4Fixture} from './phase4Fixture.js';
import {bodyInput,seedBodyInput} from './bodyEnergyFixture.js';
import {createStage7Development} from '../src/stage7Development.js';
import {createCompanionCoach} from '../src/companionCoach.js';
import {createCompanionInvitation} from '../src/companionInvitation.js';
import {createSyntheticJournalTelegram,createStage7Dispatcher} from '../src/stage7Dispatcher.js';
import {COMPANION_DEFAULTS} from '../src/companionTimingPolicy.js';
import {stage7Configuration} from '../src/stage7Runtime.js';
import {trustedJournalFact} from '../src/stage7TrustedRegistry.js';
async function fixture(t,{daily=0,topics=['sleep','recovery'],hour=1,outcome='DELIVERED'}={}){
 let at=Date.parse('2026-09-19T00:00:00.000Z')+hour*3600000;
 const f=await syntheticPhase4Fixture(t,{targetVersion:33,now:()=>new Date(at)});await seedBodyInput(f.db,bodyInput({days:2}));
 await f.db.linkTelegram({userId:'a',chatId:'123',now:f.core.now()});await f.db.setLocale('a','en',{now:f.core.now()});
 const user=await f.db.getUser('a'),companion=await createStage7Development(f),coach=createCompanionCoach({...f,companion}),invitations=createCompanionInvitation({...f,companion,coach,configuration:COMPANION_DEFAULTS});
 const actor=await companion.interactions.authenticate({user,chatId:'123'});
 await f.core.transaction(async()=>{const p=await companion.preferences(actor);await companion.changePreferences(actor,p,{daily_enabled:daily,coach_enabled:1,coach_topics_json:JSON.stringify(topics)});
  await f.db.raw.execute({sql:"INSERT INTO report_claims(user_id,report_type,local_date,owner,claimed_at,expires_at,lifecycle_generation,delivery_state,telegram_message_id) VALUES('a','daily','2026-09-19','fixture',?,?,1,'DELIVERED',11)",args:[f.core.timestamp(),f.core.timestamp()]});
  const row={user_id:'a',report_type:'daily',local_date:'2026-09-19',health_date:'2026-09-19',sleep_id:'sleep-00',telegram_message_id:11,status:'SENT',sent_at:'2026-09-19T00:30:00.000Z',...companion.interactions.privacyFields(actor.state)};
  await companion.interactions.insert('report_runs',row);await companion.interactions.link('report_runs',row);
 });
 const provider=createSyntheticJournalTelegram({outcomes:[outcome]}),dispatcher=createStage7Dispatcher({...f,companion,provider,invitations}),request={user,chatId:'123'};
 const read=async id=>(await f.db.raw.execute({sql:'SELECT * FROM journal_prompt_deliveries WHERE delivery_id=?',args:[id]})).rows[0];
 return {...f,user,companion,coach,invitations,provider,dispatcher,request,actor,read,setTime:value=>{at=typeof value==='number'?value:Date.parse(value);}};
}
test('durable one-slot plan survives reconstruction; due dispatch creates navigation only then, ambiguous is never resent',async t=>{
 const f=await fixture(t,{outcome:'AMBIGUOUS'}),p=await f.invitations.prepare(f.request),row=await f.read(p.deliveryId);
 assert.equal(p.status,'PROPOSED');assert.equal(row.interaction_id,null);const schedule=JSON.parse(row.schedule_json);
 assert.ok(schedule.selectedAt>=schedule.wakeAt+4*3600000&&schedule.selectedAt<=schedule.wakeAt+6*3600000);
 assert.equal((await f.dispatcher.dispatch({...f.request,deliveryId:p.deliveryId})).status,'NOT_DUE');assert.equal(f.provider.calls.length,0);
 const again=createCompanionInvitation({...f,configuration:COMPANION_DEFAULTS});assert.equal((await again.prepare(f.request)).deliveryId,p.deliveryId);
 await assert.rejects(f.db.raw.execute({sql:'UPDATE journal_prompt_deliveries SET due_at=? WHERE delivery_id=?',args:['2026-09-19T05:50:00.000Z',p.deliveryId]}),/immutable/);
 f.setTime(schedule.selectedAt);assert.equal((await f.dispatcher.dispatch({...f.request,deliveryId:p.deliveryId})).status,'AMBIGUOUS');
 assert.equal((await f.dispatcher.dispatch({...f.request,deliveryId:p.deliveryId})).status,'AMBIGUOUS');assert.equal(f.provider.calls.length,1);
 assert.equal((await f.db.raw.execute('SELECT count(*) n FROM journal_events')).rows[0].n,0);
});
for(const cause of ['unanswered','conversation','preference','quiet','timezone','expired','no_topic','late_planning'])test(`automatic invitation suppresses ${cause} without replacement`,async t=>{
 const f=await fixture(t,{topics:cause==='no_topic'?[]:undefined,hour:cause==='late_planning'?7:1});const p=await f.invitations.prepare(f.request),row=await f.read(p.deliveryId),schedule=JSON.parse(row.schedule_json);
 if(['no_topic','late_planning'].includes(cause))assert.equal(row.state,'SUPPRESSED');
 else{
  f.setTime(schedule.selectedAt);
  if(cause==='unanswered')await f.companion.interactions.issue(f.actor,{kind:'DAILY',category:'alcohol',targetDate:'2026-09-18'});
  if(cause==='conversation')await f.db.acquireLock('telegram_lane:tg:123',{owner:'fixture',ttlMs:300000,now:f.core.now()});
  if(cause==='preference'||cause==='quiet')await f.core.transaction(async()=>{const prefs=await f.companion.preferences(f.actor);await f.companion.changePreferences(f.actor,prefs,cause==='preference'?{coach_enabled:0}:{quiet_start:'12:00',quiet_end:'19:00'});});
  if(cause==='timezone')await f.db.updateUser('a',{timezone:'Asia/Ho_Chi_Minh'});
  if(cause==='expired')f.setTime(schedule.expiresAt+60000);
  assert.equal((await f.dispatcher.dispatch({...f.request,user:await f.db.getUser('a'),deliveryId:p.deliveryId})).status,'SUPPRESSED');
 }
 assert.equal(f.provider.calls.length,0);assert.equal((await f.invitations.prepare({...f.request,user:await f.db.getUser('a')})).deliveryId,p.deliveryId);
});
test('Coach controls are independent, require owner rollout, and missing consent remains off',async t=>{
 assert.equal(stage7Configuration({}).mode,'off');assert.throws(()=>stage7Configuration({STAGE7_COMPANION:'on',STAGE7_COMPANION_USER_IDS:'b',PHASE4_BETA_PILOT_USER_ID:'a'}),/OWNER/);
 assert.throws(()=>stage7Configuration({STAGE7_COACH_MIN_HOURS:'NaN'}),/TIMING/);
 const f=await fixture(t);await f.core.transaction(async()=>{const p=await f.companion.preferences(f.actor);const next=await f.companion.changePreferences(f.actor,p,{coach_enabled:0});assert.equal(next.daily_enabled,0);assert.equal(next.weekly_enabled,0);});
 assert.equal((await f.invitations.prepare(f.request)).status,'DISABLED');
});
test('navigation queries only own chosen scope and never creates a lifestyle fact; registry rejects forged Coach fact',async t=>{
 const f=await fixture(t);let reply=await f.coach.handle({...f.request,text:'/coach',requestKey:'fixture'}),n=0;
 async function tap(label){await f.companion.interactions.bind(f.actor,reply.stage7InteractionId,44);const b=reply.replyMarkup.inline_keyboard.flat().find(x=>x.text.includes(label));assert.ok(b,label);
  reply=await f.coach.handle({...f.request,callback:{id:`cb-${++n}`,data:b.callback_data,from:{id:123},message:{message_id:44,chat:{id:123,type:'private'}}}});return reply;}
 await tap('Recovery');await tap('Today');assert.match(reply.text,/99\.0 %/);assert.match(reply.text,/2026-09-19/);
 await tap('Last 7 days');assert.match(reply.text,/3 scored records/);
 assert.equal((await f.db.raw.execute('SELECT count(*) n FROM journal_events')).rows[0].n,0);
 const row=await f.companion.interactions.read('a',reply.stage7InteractionId);
 await f.db.raw.execute({sql:"UPDATE quick_action_interactions SET state='CONFIRM',category='alcohol',registry_id='fixture',selected_choice='YES' WHERE interaction_id=?",args:[row.interaction_id]});
 await assert.rejects(f.core.transaction(()=>trustedJournalFact(f.core,f.actor.control,{interactionId:row.interaction_id,expectedRevision:row.revision,callbackReceipt:'x'.repeat(64)})),/REGISTRY_AUTHORITY/);
});
test('enabled Daily Journal must be acknowledged; actual late Journal delivery leaves no future Coach slot',async t=>{
 const f=await fixture(t,{daily:1,hour:4});
 assert.equal((await f.invitations.prepare(f.request)).status,'JOURNAL_NOT_CONFIRMED');
 const daily=await f.companion.prepareAfterBrief({...f.request,healthDay:'2026-09-19'});
 assert.equal((await f.dispatcher.dispatch({...f.request,deliveryId:daily.deliveryId})).status,'DELIVERED');
 const proposed=await f.invitations.prepare(f.request),row=await f.read(proposed.deliveryId),schedule=JSON.parse(row.schedule_json);
 assert.equal(schedule.journalAt,Date.parse('2026-09-19T04:00:00Z'));assert.equal(row.state,'SUPPRESSED');
 assert.equal(f.provider.calls.length,1);
});

test('schedule plaintext is physically erased while day/occasion dedupe survives and no card is sent',async t=>{
 const f=await fixture(t),p=await f.invitations.prepare(f.request),before=await f.read(p.deliveryId),redactor=createPhase4Redactor(f.core);
 const node={type:'journal_prompt_deliveries',id:before.privacy_artifact_id,mode:'SHADOW'};
 await f.core.transaction(async()=>{const result=await redactor.apply('a',node,{operation_kind:'DELETION',purge_generation:f.actor.state.purge_generation,target_source_type:'USER',target_source_id:'a'});await redactor.verify('a',node,result);});
 const after=await f.read(p.deliveryId);assert.equal(physicallyScrubbed('journal_prompt_deliveries',after),true);assert.equal(after.state,'SUPPRESSED');
 assert.equal(after.schedule_json,null);assert.equal(after.due_at,null);assert.equal(after.occasion_key,before.occasion_key);
 assert.equal((await f.invitations.prepare(f.request)).deliveryId,p.deliveryId);assert.equal((await f.dispatcher.dispatch({...f.request,deliveryId:p.deliveryId})).status,'SUPPRESSED');assert.equal(f.provider.calls.length,0);
});
