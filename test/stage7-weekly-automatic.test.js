import test from 'node:test';
import assert from 'node:assert/strict';
import {stage7Fixture} from './stage7Fixture.js';
import {confirmedLegacyBrief} from './confirmedLegacyBriefFixture.js';
import {createSyntheticJournalTelegram,createStage7Dispatcher} from '../src/stage7Dispatcher.js';
import {createStage7ProductionProvider} from '../src/stage7TransportAuthority.js';
import {JOURNAL_COPY} from '../src/stage7Registry.js';
import {localDate} from '../src/time.js';

async function fixture(t,{records=true,optIn=true,locale='en'}={}){
 let clock=new Date('2026-09-21T04:10:00.000Z');
 const f=await stage7Fixture(t,{now:()=>new Date(clock)});
 await f.db.setLocale('a','en',{now:f.core.now()});
 await f.db.ensureOnboarding('a',{state:'READY',now:f.core.now()});
 const actor=await f.companion.interactions.authenticate({user:f.user,chatId:'123'});
 let saved;
 if(records){let card=await f.command();card=await f.tap(card,'Alcohol');card=await f.tap(card,'Yes');saved=await f.tap(card,'Confirm');}
 await f.db.setLocale('a',locale,{now:f.core.now()});
 const current=await f.companion.interactions.authenticate({user:f.user,chatId:'123'});
 await f.core.transaction(async()=>{const prefs=await f.companion.preferences(current);await f.companion.changePreferences(current,prefs,{weekly_enabled:Number(optIn),topics_json:'["alcohol"]'});});
 const freshActor=()=>f.companion.interactions.authenticate({user:f.user,chatId:'123'});
 async function brief(){
  const day=localDate(f.core.now(),'Asia/Taipei');
  await f.db.raw.execute({sql:"INSERT INTO report_claims(user_id,report_type,local_date,owner,claimed_at,expires_at,lifecycle_generation,delivery_state,telegram_message_id) VALUES('a','daily',?,'synthetic',?,?,?,'DELIVERED',11)",args:[day,f.core.timestamp(),f.core.timestamp(),f.user.lifecycleGeneration]});
  await confirmedLegacyBrief(f,{day});
 }
 await brief();
 const read=async id=>(await f.db.raw.execute({sql:'SELECT * FROM journal_prompt_deliveries WHERE user_id=? AND delivery_id=?',args:['a',id]})).rows[0];
 const prepare=async()=>f.companion.weekly.prepare(await freshActor(),{automatic:true});
 return {...f,actor:current,saved,brief,read,prepare,freshActor,setTime:at=>{clock=new Date(at);},request:{user:f.user,chatId:'123'}};
}

test('weekly opt-in stays default-off and empty or unanswered weeks create no delivery',async t=>{
 const f=await fixture(t,{records:false,optIn:false});
 assert.equal((await f.prepare()).status,'DISABLED');
 await f.core.transaction(async()=>{const prefs=await f.companion.preferences(f.actor);await f.companion.changePreferences(f.actor,prefs,{weekly_enabled:1});});
 assert.equal((await f.prepare()).status,'NO_RECORDS');
 await f.companion.interactions.issue(f.actor,{kind:'DAILY',category:'alcohol',targetDate:'2026-09-20'});
 assert.equal((await f.prepare()).status,'INTERACTION_BUSY');
 assert.equal((await f.db.raw.execute('SELECT count(*) n FROM journal_prompt_deliveries')).rows[0].n,0);
 assert.equal((await f.db.raw.execute('SELECT count(*) n FROM journal_delivery_attempts')).rows[0].n,0);
});

test('explicit skipped Journal records remain missingness and global notification pause prevents delivery',async t=>{
 const f=await fixture(t,{records:false}),issued=await f.companion.interactions.issue(f.actor,{kind:'DAILY',category:'alcohol',targetDate:'2026-09-20'});
 let card=await f.companion.card(f.actor,issued.row);await f.tap(card,'Not sure');
 const p=await f.prepare();assert.equal(p.status,'PROPOSED');assert.equal(p.summary.daysRecorded,0);assert.equal(p.summary.responses.NOT_SURE,1);
 assert.equal((await f.db.raw.execute('SELECT count(*) n FROM journal_events')).rows[0].n,0);
 await f.core.transaction(async()=>{const control=await f.core.captureControl('a'),prefs=await f.stores.preferences.read(control);await f.stores.preferences.update(control,prefs.preference_version,{notifications_paused:1});});
 const provider=createSyntheticJournalTelegram(),dispatcher=createStage7Dispatcher({...f,provider});
 assert.equal((await f.prepare()).status,'NOTIFICATIONS_PAUSED');assert.equal((await dispatcher.dispatch({...f.request,deliveryId:p.deliveryId})).status,'NOTIFICATIONS_PAUSED');
 assert.equal((await f.read(p.deliveryId)).attempt_count,0);assert.equal(provider.calls.length,0);
});

for(const locale of ['zh-TW','en','vi'])test(`automatic weekly uses actual own completed-week records and explicit missingness in ${locale}`,async t=>{
 const f=await fixture(t,{locale}),proposal=await f.prepare(),row=await f.read(proposal.deliveryId);
 assert.equal(proposal.status,'PROPOSED');assert.equal(proposal.summary.daysRecorded,1);assert.equal(proposal.summary.responses.NOT_ASKED,7);
 assert.equal(row.kind,'WEEKLY');assert.equal(row.execution_mode,'SHADOW');assert.equal(row.interaction_id,null);
 assert.equal(row.state,'PROPOSED');assert.equal(row.attempt_count,0);
 const schedule=JSON.parse(row.schedule_json);assert.equal(schedule.weekStart,'2026-09-14');assert.equal(schedule.weekEnd,'2026-09-20');
 assert.equal(schedule.enrollment.state,'READY');assert.equal(row.expires_at,'2026-09-23T16:00:00.000Z');
 const provider=createSyntheticJournalTelegram(),dispatcher=createStage7Dispatcher({...f,provider});
 const result=await dispatcher.dispatch({...f.request,deliveryId:row.delivery_id});
 assert.equal(result.status,'DELIVERED');assert.equal(result.deliveredNow,true);
 assert.match(provider.calls[0].text,/2026-09-14–2026-09-20/);assert.ok(provider.calls[0].text.includes(JOURNAL_COPY[locale].missing));
 assert.equal(provider.calls[0].text.includes('undefined'),false);assert.deepEqual(provider.calls[0].replyMarkup,{inline_keyboard:[]});
 assert.equal((await f.read(row.delivery_id)).message_id,result.messageId);
 assert.equal((await f.db.raw.execute('SELECT count(*) n FROM journal_events')).rows[0].n,1);
});

test('unattempted manual reservation is reused, concurrent automatic preparation and delivery own one real attempt',async t=>{
 const f=await fixture(t,{optIn:false}),manual=await f.companion.weekly.prepare(f.actor);
 await f.core.transaction(async()=>{const prefs=await f.companion.preferences(f.actor);await f.companion.changePreferences(f.actor,prefs,{weekly_enabled:1});});
 const prepared=await Promise.all([f.prepare(),f.prepare()]);assert.ok(prepared.every(p=>p.deliveryId===manual.deliveryId));
 const provider=createSyntheticJournalTelegram(),dispatcher=createStage7Dispatcher({...f,provider});
 await Promise.all([dispatcher.dispatch({...f.request,deliveryId:manual.deliveryId}),dispatcher.dispatch({...f.request,deliveryId:manual.deliveryId})]);
 assert.equal(provider.calls.length,1);assert.equal((await f.prepare()).status,'DELIVERED');
 assert.equal((await f.db.raw.execute('SELECT count(*) n FROM journal_prompt_deliveries')).rows[0].n,1);
 assert.equal((await f.db.raw.execute('SELECT count(*) n FROM journal_delivery_attempts')).rows[0].n,1);
 const other=await f.db.getUser('b');assert.equal((await dispatcher.dispatch({user:other,chatId:'456',deliveryId:manual.deliveryId})).status,'NOT_FOUND');
});

test('quiet hours and incomplete/missing-current-Morning windows defer without consuming a week or attempt',async t=>{
 const f=await fixture(t),p=await f.prepare(),provider=createSyntheticJournalTelegram(),dispatcher=createStage7Dispatcher({...f,provider});
 f.setTime('2026-09-21T14:10:00Z');
 assert.equal((await dispatcher.dispatch({...f.request,deliveryId:p.deliveryId})).status,'QUIET_HOURS');
 f.setTime('2026-09-22T00:59:00Z');assert.equal((await f.prepare()).status,'NOT_DUE');
 f.setTime('2026-09-22T04:10:00Z');assert.equal((await f.prepare()).status,'BRIEF_NOT_CONFIRMED');
 await f.brief();const again=await f.prepare();assert.equal(again.deliveryId,p.deliveryId);
 assert.equal((await f.read(p.deliveryId)).attempt_count,0);assert.equal(provider.calls.length,0);
 f.setTime('2026-09-24T04:10:00Z');assert.equal((await f.prepare()).status,'NOT_DUE');
});

for(const outcome of ['AMBIGUOUS','MALFORMED','FAILED_DEFINITE'])test(`weekly durable settlement preserves ${outcome} without fabricated success`,async t=>{
 const f=await fixture(t),p=await f.prepare(),provider=createSyntheticJournalTelegram({outcomes:[outcome]}),dispatcher=createStage7Dispatcher({...f,provider}),request={...f.request,deliveryId:p.deliveryId};
 const first=await dispatcher.dispatch(request);assert.equal(first.status,outcome==='MALFORMED'?'AMBIGUOUS':outcome);
 const next=await f.prepare();
 if(outcome==='FAILED_DEFINITE'){
  assert.equal(next.deliveryId,p.deliveryId);assert.equal((await dispatcher.dispatch(request)).status,'DELIVERED');assert.equal(provider.calls.length,2);
 }else{
  assert.equal(next.status,'AMBIGUOUS');assert.equal(next.deliveryId,null);assert.equal((await dispatcher.dispatch(request)).status,'AMBIGUOUS');assert.equal(provider.calls.length,1);
 }
 assert.equal((await f.db.raw.execute('SELECT count(*) n FROM journal_prompt_deliveries')).rows[0].n,1);
});

test('weekly privacy lineage retracts the copied summary and preserves its permanent week barrier',async t=>{
 const f=await fixture(t),p=await f.prepare(),row=await f.read(p.deliveryId);
 assert.ok((await f.db.raw.execute({sql:"SELECT 1 FROM phase4_source_links WHERE user_id='a' AND artifact_type='journal_prompt_deliveries' AND artifact_id=? AND source_type='JOURNAL_FACT' AND unlinked_at IS NULL",args:[row.privacy_artifact_id]})).rows.length);
 await f.tap(f.saved,'Retract');
 const after=await f.read(p.deliveryId);assert.equal(after.content_state,'REDACTED');assert.equal(after.payload_json,null);assert.equal(after.schedule_json,null);
 const provider=createSyntheticJournalTelegram(),dispatcher=createStage7Dispatcher({...f,provider});
 assert.equal((await dispatcher.dispatch({...f.request,deliveryId:p.deliveryId})).status,'SUPPRESSED');assert.equal(provider.calls.length,0);
 assert.equal((await f.db.raw.execute('SELECT count(*) n FROM journal_prompt_deliveries')).rows[0].n,1);
});

for(const mutation of ['source','preference','enrollment','locale'])test(`weekly final registered-provider fence rejects ${mutation} drift after card selection`,async t=>{
 const f=await fixture(t),p=await f.prepare();let apiCalls=0;
 t.mock.method(globalThis,'fetch',async()=>{apiCalls++;throw Error('SYNTHETIC_NETWORK_FORBIDDEN');});
 const admission=await f.db.admitRuntime(),provider=createStage7ProductionProvider({...f,admission,env:{telegramBotToken:'SYNTHETIC_NOT_A_TOKEN'},userIds:['a'],beforeSend:async authority=>{
  const actor=await f.freshActor(),current=await f.companion.weekly.due(actor,await f.read(p.deliveryId));
  if(current.status!=='READY'||current.projectionDigest!==authority.weeklyProjectionDigest)throw Error('SYNTHETIC_WEEKLY_FINAL_FENCE');
 }});
 const due=f.companion.weekly.due;let selected=false;
 f.companion.weekly.due=async(...args)=>{
  const result=await due(...args);
  if(!selected&&result.status==='READY'){
   selected=true;
   if(mutation==='source')await f.db.raw.execute("UPDATE journal_events SET note='synthetic changed',raw_answer_excerpt='synthetic changed' WHERE user_id='a'");
   if(mutation==='preference'){const prefs=await f.companion.preferences(f.actor);await f.companion.changePreferences(f.actor,prefs,{weekly_enabled:0});}
   if(mutation==='enrollment')await f.db.raw.execute("UPDATE user_onboarding SET state='SYNCING' WHERE user_id='a'");
   if(mutation==='locale')await f.db.setLocale('a','vi',{now:f.core.now()});
  }
  return result;
 };
 const dispatcher=createStage7Dispatcher({...f,provider}),result=await dispatcher.dispatch({...f.request,deliveryId:p.deliveryId});
 assert.equal(result.status,'FAILED_DEFINITE');assert.equal(apiCalls,0);
 assert.equal((await f.db.raw.execute('SELECT state FROM journal_delivery_attempts')).rows[0].state,'FAILED_DEFINITE');
});

test('recovered weekly DELIVERY_STARTED becomes ambiguous and is never replayed',async t=>{
 const f=await fixture(t),p=await f.prepare();
 await f.db.raw.execute({sql:"UPDATE journal_prompt_deliveries SET state='DELIVERY_STARTED' WHERE delivery_id=?",args:[p.deliveryId]});
 const provider=createSyntheticJournalTelegram(),dispatcher=createStage7Dispatcher({...f,provider});
 assert.equal((await dispatcher.recover({...f.request,deliveryId:p.deliveryId})).status,'AMBIGUOUS');
 assert.equal((await f.prepare()).status,'AMBIGUOUS');assert.equal((await dispatcher.dispatch({...f.request,deliveryId:p.deliveryId})).status,'AMBIGUOUS');assert.equal(provider.calls.length,0);
});

test('weekly shares the existing two-optional-message daily ceiling with actual Daily delivery',async t=>{
 const f=await fixture(t),provider=createSyntheticJournalTelegram(),dispatcher=createStage7Dispatcher({...f,provider});
 await f.core.transaction(async()=>{const prefs=await f.companion.preferences(f.actor);await f.companion.changePreferences(f.actor,prefs,{daily_enabled:1,topics_json:'["caffeine"]'});});
 const daily=await f.companion.prepareAfterBrief({...f.request,healthDay:'2026-09-21'});
 const sent=await dispatcher.dispatch({...f.request,deliveryId:daily.deliveryId});assert.equal(sent.status,'DELIVERED');
 const dailyRow=await f.companion.interactions.read('a',daily.interactionId),card=await f.companion.card(await f.freshActor(),dailyRow);
 await f.tap(card,'Not sure');
 const weekly=await f.prepare();assert.equal(weekly.status,'PROPOSED');
 assert.equal((await dispatcher.dispatch({...f.request,deliveryId:weekly.deliveryId})).status,'DELIVERED');assert.equal(provider.calls.length,2);
 const actor=await f.freshActor();
 assert.equal(await f.companion.weekly.optionalSlotAvailable(actor,{kind:'COACH',delivery_id:'synthetic-next-coach'}),false);
 assert.equal(await f.companion.weekly.optionalSlotAvailable(actor,{kind:'WEEKLY',delivery_id:'synthetic-next-weekly'}),false);
 f.setTime('2026-09-22T04:10:00Z');assert.equal(await f.companion.weekly.optionalSlotAvailable(await f.freshActor(),{kind:'WEEKLY',delivery_id:'synthetic-next-weekly'}),true);
});

test('historical optional attempts cannot hide weekly participation beyond the first three rows',async t=>{
 const f=await fixture(t),proposal=await f.prepare(),base=await f.read(proposal.deliveryId);
 // Explicit historical fixture only: adjacent-day identities may share a local
 // day after a timezone edit. This is not a provider acceptance or live receipt.
 for(const [index,kind]of ['DAILY','COACH','DAILY','WEEKLY'].entries()){
  const delivery={...base,delivery_id:f.core.newId(),semantic_key:f.core.newId(),kind,state:'DELIVERED',attempt_count:1,message_id:String(900+index),...f.companion.interactions.privacyFields(f.actor.state)};
  await f.companion.interactions.insert('journal_prompt_deliveries',delivery);
  await f.companion.interactions.insert('journal_delivery_attempts',{user_id:'a',delivery_id:delivery.delivery_id,attempt_id:f.core.newId(),attempt_number:1,state:'DELIVERED',started_at:f.core.timestamp(),settled_at:f.core.timestamp(),message_id:delivery.message_id});
 }
 assert.equal(await f.companion.weekly.optionalSlotAvailable(await f.freshActor(),{kind:'COACH',delivery_id:'synthetic-next-coach'}),false);
 await f.db.raw.execute("UPDATE journal_delivery_attempts SET started_at='2026-09-20T00:00:00Z' WHERE delivery_id IN (SELECT delivery_id FROM journal_prompt_deliveries WHERE kind='WEEKLY')");
 assert.equal(await f.companion.weekly.optionalSlotAvailable(await f.freshActor(),{kind:'COACH',delivery_id:'synthetic-next-coach'}),false,'Daily and Coach also share the two-message ceiling without a weekly attempt');
});
