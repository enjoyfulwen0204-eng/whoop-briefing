import test from 'node:test';
import assert from 'node:assert/strict';
import {journalCard} from '../src/stage7Cards.js';
import {TOPICS,DETAILS,JOURNAL_COPY} from '../src/stage7Registry.js';
import {createSettings} from '../src/bot/settings.js';
import {createCompanionCoach,COACH_TOPICS} from '../src/companionCoach.js';
import {inStage7QuietHours as inCompanionQuietHours,inCompanionQuietHours as sharedQuietHours} from '../src/companionTimingPolicy.js';
import {journalWeeklyWindow} from '../src/stage7WeeklyReview.js';
import {syntheticStage7V33Fixture as syntheticPhase4Fixture} from './stage7-v33-fixture.js';
import {createStage7Development} from '../src/stage7Development.js';
import {confirmedLegacyBrief} from './confirmedLegacyBriefFixture.js';
import {createStage7Dispatcher,createSyntheticJournalTelegram} from '../src/stage7Dispatcher.js';
import {selectDailyQuestion} from '../src/questionEngine.js';
const locales=['zh-TW','vi','en'];
const icons=buttons=>{assert.ok(buttons.length);for(const b of buttons)assert.match(b.text??b.label,/^(?:\p{Extended_Pictographic}|\p{Regional_Indicator})/u,JSON.stringify(b));};

for(const locale of locales)test(`all basic inline keyboard generators and states start with icons: ${locale}`,async()=>{
 const prefs={daily_enabled:0,weekly_enabled:0,coach_enabled:0,topics_json:'[]',excluded_topics_json:'[]',coach_topics_json:'[]',revision:0};
 for(const enabled of [0,1]){
  const p={...prefs,daily_enabled:enabled,weekly_enabled:enabled,coach_enabled:enabled,topics_json:JSON.stringify(enabled?TOPICS:[])};
  for(const row of [{kind:'PREFERENCES',category:null},{kind:'QUICK',category:null},...TOPICS.flatMap(category=>['ISSUED','EDITING','CONFIRM','NOTE','COMPLETED','NOT_SURE','SKIPPED',...(DETAILS[category]?['AWAITING_DETAIL']:[])].map(state=>({kind:'DAILY',category,state,target_date:'2026-10-30',selected_choice:'YES'})))])icons(journalCard(row,{locale,preferences:p}).buttons.flat());
 }
 const user={id:'synthetic',status:'ACTIVE',lifecycleGeneration:1,displayName:'Synthetic'},state=new Map();
 const db={transaction:fn=>fn(),resolveUserByChatId:async()=>user,getProfileRevision:async()=>0,getLocale:async()=>locale,getState:async k=>state.get(k),setState:async(k,v)=>state.set(k,v)};
 const settings=createSettings({db,now:()=>new Date('2026-10-31T01:00Z'),nonce:()=> 'a'.repeat(22)});
 const call=text=>settings({text,user,chatId:'123'}),tap=(reply,action)=>settings({user,chatId:'123',callback:{data:reply.replyMarkup.inline_keyboard.flat().find(b=>b.callback_data.endsWith('.'+action)).callback_data}});
 let reply=await call('/settings');icons(reply.replyMarkup.inline_keyboard.flat());
 reply=await tap(reply,'language');icons(reply.replyMarkup.inline_keyboard.flat());
 reply=await tap(reply,'vi');icons(reply.replyMarkup.inline_keyboard.flat());
 reply=await call('/name');icons(reply.replyMarkup.inline_keyboard.flat());
 reply=await call('Synthetic name');icons(reply.replyMarkup.inline_keyboard.flat());
 const interactions={render:async()=>({}),button:async(_a,_r,b)=>({text:b.text,callback_data:'synthetic'})};
 const coach=createCompanionCoach({core:{},stores:{},db,companion:{interactions}});
 for(const topic of [null,...COACH_TOPICS])for(const range of [null,'today','week'])for(const automatic of [false,true]){
  const card=await coach.card({}, {user_id:'synthetic',state:'ISSUED',diagnostics_json:JSON.stringify({coachTopic:topic,coachRange:range,automatic})},{includeQuery:false});
  icons(card.replyMarkup.inline_keyboard.flat());
 }
});

test('specified Journal action icons are exact in all locales and preserve topic icons',()=>{
 for(const locale of locales){
  const opts={locale},base={kind:'DAILY',category:'caffeine',target_date:'2026-10-30'};
  const all=['ISSUED','CONFIRM','COMPLETED','NOTE','AWAITING_DETAIL'].flatMap(state=>journalCard({...base,state,selected_choice:'YES'},opts).buttons.flat());
  for(const [action,icon]of Object.entries({YES:'✅',NO:'❌',NOT_SURE:'🤔',SKIPPED:'⏭️',note:'📝',edit:'✏️',undo:'↩️',confirm:'👍',back:'⬅️',cancel:'✖️',skipDetail:'⏭️','detail:morning':'🌅','detail:afternoon':'☀️','detail:evening':'🌙'}))assert.ok(all.filter(b=>b.action===action).every(b=>b.label.startsWith(icon)),action);
  assert.ok(journalCard({kind:'QUICK',category:null},opts).buttons.flat().find(b=>b.action==='category:caffeine').label.startsWith('☕'));
 }
});

async function fixture(t,timezone='Asia/Taipei'){
 let clock=new Date('2026-11-02T00:59:00Z');
 t.mock.method(globalThis,'fetch',async()=>{throw Error('SYNTHETIC_NETWORK_FORBIDDEN');});
 const f=await syntheticPhase4Fixture(t,{targetVersion:33,now:()=>new Date(clock)});
 await f.db.updateUser('a',{timezone},{now:f.core.now()});
 await f.db.linkTelegram({userId:'a',chatId:'123',now:f.core.now()});
 await f.db.saveTokens('a',{accessToken:'synthetic',refreshToken:'synthetic',expiresAt:new Date('2026-12-01'),scope:'offline',whoopUserId:'synthetic'},{now:f.core.now()});
 await f.db.ensureOnboarding('a',{state:'READY',now:f.core.now()});await f.db.setLocale('a','en',{now:f.core.now()});
 const user=await f.db.getUser('a'),companion=await createStage7Development(f),actor=await companion.interactions.authenticate({user,chatId:'123'});
 await f.core.transaction(async()=>{const p=await companion.preferences(actor);await companion.changePreferences(actor,p,{daily_enabled:1,weekly_enabled:1,coach_enabled:1});});
 let seq=0;
 const tap=async(card,label)=>{const b=card.replyMarkup.inline_keyboard.flat().find(b=>b.text.includes(label));assert.ok(b,label);await companion.interactions.bind(actor,card.stage7InteractionId,42);return companion.handle({user,chatId:'123',callback:{id:String(++seq),data:b.callback_data,from:{id:123},message:{message_id:42,chat:{id:123,type:'private'}}}});};
 return {...f,user,actor,companion,tap,setTime:at=>{clock=new Date(at);},request:{user,chatId:'123'}};
}
for(const timezone of ['Asia/Taipei','Asia/Ho_Chi_Minh'])test(`weekly actual preparation uses Taiwan Monday 09:00 for ${timezone}`,async t=>{
 const f=await fixture(t,timezone);
 let card=await f.companion.handle({...f.request,text:'/journal'});card=await f.tap(card,'Alcohol');card=await f.tap(card,'Yes');await f.tap(card,'Confirm');
 await f.db.raw.execute({sql:"INSERT INTO report_claims(user_id,report_type,local_date,owner,claimed_at,expires_at,lifecycle_generation,delivery_state,telegram_message_id) VALUES('a','daily','2026-11-02','synthetic',?,?,?,'DELIVERED',11)",args:[f.core.timestamp(),f.core.timestamp(),f.user.lifecycleGeneration]});
 await confirmedLegacyBrief(f,{day:'2026-11-02'});
 assert.equal((await f.companion.weekly.prepare(f.actor,{automatic:true})).status,timezone==='Asia/Taipei'?'NOT_DUE':'QUIET_HOURS');
 f.setTime('2026-11-02T01:00:00Z');
 const p=await f.companion.weekly.prepare(f.actor,{automatic:true});assert.equal(p.status,'PROPOSED');
 assert.equal(p.summary.startDate,'2026-10-26');assert.equal(p.summary.endDate,'2026-11-01');
 const provider=createSyntheticJournalTelegram(),dispatcher=createStage7Dispatcher({...f,provider});
 assert.equal((await dispatcher.dispatch({...f.request,deliveryId:p.deliveryId})).status,'DELIVERED');assert.equal(provider.calls.length,1);
 assert.equal((await dispatcher.dispatch({...f.request,deliveryId:p.deliveryId})).status,'DELIVERED');assert.equal(provider.calls.length,1);
});

test('Taiwan catch-up days and Monday threshold do not change Morning Brief policy',()=>{
 assert.equal(journalWeeklyWindow(new Date('2026-11-02T00:59:59Z')),false);
 assert.equal(journalWeeklyWindow(new Date('2026-11-02T01:00:00Z')),true);
 assert.equal(journalWeeklyWindow(new Date('2026-11-04T01:00:00Z')),true);
 assert.equal(journalWeeklyWindow(new Date('2026-11-05T01:00:00Z')),false);
});

test('one-click pause atomically disables only Stage 7 automatic messages and fences old cards',async t=>{
 const f=await fixture(t);let card=await f.companion.handle({...f.request,text:'/journal'});card=await f.tap(card,JOURNAL_COPY.en.preferences);
 const old=structuredClone(card),before=(await f.db.raw.execute("SELECT * FROM user_notification_preferences WHERE user_id='a'")).rows;
 await f.tap(card,JOURNAL_COPY.en.pause);
 const read=async()=> (await f.db.raw.execute("SELECT * FROM journal_tracking_preferences WHERE user_id='a'")).rows[0],p=await read();
 assert.equal(p.daily_enabled+p.weekly_enabled+p.coach_enabled,0);
 assert.equal(await f.db.isProactiveEnabled('a'),false);
 assert.deepEqual((await f.db.raw.execute("SELECT * FROM user_notification_preferences WHERE user_id='a'")).rows,before);
 assert.equal((await f.tap(old,JOURNAL_COPY.en.pause)).text,JOURNAL_COPY.en.expired);
 assert.deepEqual(await read(),p);
 assert.equal((await f.companion.prepareAfterBrief({...f.request,healthDay:'2026-11-02'})).status,'DISABLED');
 assert.equal((await f.companion.weekly.prepare(f.actor,{automatic:true})).status,'DISABLED');
});

test('daily rotation preserves seven topics and three-day cooldown even when tracked',()=>{
 const history=[];
 for(let day=1;day<=14;day++){
  const targetDate=`2026-11-${String(day).padStart(2,'0')}`;
  const p=selectDailyQuestion({topics:TOPICS,trackingTopics:['stress'],history,healthDay:targetDate,targetDate});
  for(const h of history.filter(h=>h.category===p.category))assert.ok(Date.parse(targetDate)-Date.parse(h.target_date)>=3*86400000);
  history.push({category:p.category,target_date:targetDate});
 }
 assert.equal(new Set(history.map(h=>h.category)).size,7);
});


test('current verified abnormal context wins topic ranking without overriding cooldown, exclusions or known facts',()=>{
 const input={topics:TOPICS,trackingTopics:['stress'],healthDay:'2026-11-02',targetDate:'2026-11-01',signal:{metric:'sleep_performance',level:'NOTABLE',relevantTopics:['late_sleep']}};
 assert.equal(selectDailyQuestion(input).category,'late_sleep');
 assert.equal(selectDailyQuestion(input).reason,'MISSING_CONTEXT');
 assert.notEqual(selectDailyQuestion({...input,history:[{category:'late_sleep',target_date:'2026-10-31'}]}).category,'late_sleep');
 assert.notEqual(selectDailyQuestion({...input,excludedTopics:['late_sleep']}).category,'late_sleep');
 assert.notEqual(selectDailyQuestion({...input,knownFacts:[{category:'late_sleep',health_date:'2026-11-01',exposure_state:'EXPOSED'}]}).category,'late_sleep');
 assert.equal(selectDailyQuestion({...input,signal:null}).category,'stress');
});


test('custom quiet preferences cannot shorten 22:00–08:00, but may extend it',()=>{
 assert.throws(()=>inCompanionQuietHours(new Date('2026-11-02T14:00:00Z'),'Asia/Taipei','25:00','08:00'),/QUIET_HOURS_INVALID/);
 assert.equal(sharedQuietHours(new Date('2026-11-02T14:00:00Z'),'Asia/Taipei','23:00','07:00'),false,'Stage 8 shared semantics unchanged');
 for(const [at,expected]of [['2026-11-02T14:00:00Z',true],['2026-11-02T23:59:59Z',true],['2026-11-03T00:00:00Z',false]]){
  assert.equal(inCompanionQuietHours(new Date(at),'Asia/Taipei','23:00','07:00'),expected);
  assert.equal(inCompanionQuietHours(new Date(at),'Asia/Taipei','00:00','00:00'),expected);
 }
 assert.equal(inCompanionQuietHours(new Date('2026-11-03T00:30:00Z'),'Asia/Taipei','21:00','09:00'),true);
});
