import test from 'node:test';
import assert from 'node:assert/strict';
import {syntheticStage7V33Fixture as syntheticPhase4Fixture} from './stage7-v33-fixture.js';
import {bodyInput,seedBodyInput} from './bodyEnergyFixture.js';
import {selectBodyEnergyInputs} from '../src/bodyEnergyInputs.js';
import {calculateBodyEnergy} from '../src/bodyEnergy.js';
import {createOnDemandBodyEnergy,renderOnDemandBody} from '../src/onDemandBodyEnergy.js';
import {proactiveQuota,proactiveSlotAllowed} from '../src/proactiveQuota.js';
import {healthReminderTiming} from '../src/healthReminderPolicy.js';
import {checkLowEnergy,LOW_ENERGY_FLOOR} from '../src/onDemandBodyAlerts.js';
import {createStage7Development} from '../src/stage7Development.js';
import {journalCard} from '../src/stage7Cards.js';
import {assertSchemaTransitionProfile,SCHEMA_TRANSITION_PROFILE} from '../src/schemaTransitionProfile.js';
import {decide} from '../src/attention.js';
import {checkAndAct} from '../src/proactiveAgent.js';
import {confirmedLegacyBrief} from './confirmedLegacyBriefFixture.js';
globalThis.fetch=async()=>{throw Error('TEST_NETWORK_FORBIDDEN');};
const instant=new Date('2026-10-31T04:00:00Z');
async function fixture(t){
 const f=await syntheticPhase4Fixture(t,{targetVersion:33,now:()=>new Date(instant)});
 await f.db.linkTelegram({userId:'a',chatId:'123',now:instant});await f.db.setLocale('a','en',{now:instant});
 await seedBodyInput(f.db,bodyInput({asOf:instant.getTime()}));
 await f.db.ensureOnboarding('a',{state:'READY',now:instant});
 const body=createOnDemandBodyEnergy({...f,environment:{BODY_ENERGY_ON_DEMAND:'on'},now:()=>new Date(instant)});
 return {...f,body,user:await f.db.getUser('a')};
}
test('unified optional budget and sole daily health exception; coach/daily exclusions',()=>{
 assert.equal(proactiveSlotAllowed({total:1,health:0,ask:0},'DAILY'),true);
 assert.equal(proactiveSlotAllowed({total:2,health:0,ask:0},'WEEKLY'),false);
 assert.equal(proactiveSlotAllowed({total:2,health:0,ask:0},'HEALTH'),true);
 assert.equal(proactiveSlotAllowed({total:3,health:1,ask:0},'HEALTH'),false);
 assert.equal(proactiveSlotAllowed({total:1,health:1,ask:0},'COACH'),false);
 assert.equal(proactiveSlotAllowed({total:1,health:1,ask:1},'DAILY'),false);
});
test('read-only live-schema calculation equals original calculator and does not store results',async t=>{
 const f=await fixture(t),before=Number((await f.db.raw.execute('SELECT count(*) n FROM body_energy_results')).rows[0].n);
 const result=await f.body.inspect({userId:'a',requestedAt:instant});
 assert.deepEqual(result.calculation,calculateBodyEnergy(selectBodyEnergyInputs(bodyInput({asOf:instant.getTime()})).manifest));
 assert.equal(Number((await f.db.raw.execute('SELECT count(*) n FROM body_energy_results')).rows[0].n),before);
 const section=await f.body.currentSection({userId:'a',requestedAt:instant,morning:true});
 assert.match(section.message,/at wake-up/);assert.equal(await section.verifyCurrent(),true);
});
test('LIMITED shows reference estimate; unavailable states never display a score',()=>{
 const good=calculateBodyEnergy(selectBodyEnergyInputs(bodyInput()).manifest);
 for(const locale of ['zh-TW','en','vi']){
  assert.match(renderOnDemandBody({...good,quality_state:'LIMITED'},{locale}),/參考值|reference estimate|tham khảo/);
  for(const quality_state of ['WARMING_UP','NO_DATA','DEGRADED','UNAVAILABLE'])assert.doesNotMatch(renderOnDemandBody({...good,quality_state,reasons:['INSUFFICIENT_BASELINE']},{locale}),/\/100/);
 }
 assert.match(renderOnDemandBody({...good,quality_state:'WARMING_UP',reasons:['INSUFFICIENT_BASELINE']}),/7 天/);
 const detail=renderOnDemandBody({...good,drivers:{...good.drivers,time_depletion:20,load_depletion:19,nap_recharge:4}},{details:true});
 assert.match(detail,/時間消耗 −20/);assert.match(detail,/今天活動 −19/);assert.match(detail,/小睡 \+4/);
});
test('read-only reply rejects lifecycle change and disabled flag',async t=>{
 const f=await fixture(t),reply=await f.body.currentSection({userId:'a',requestedAt:instant});
 await f.db.raw.execute("UPDATE users SET lifecycle_generation=lifecycle_generation+1 WHERE id='a'");
 await assert.rejects(reply.verifyCurrent);
});
test('concurrent health reservations share one durable limit including uncertain sends',async t=>{
 const f=await fixture(t),reserve=i=>f.db.transaction(()=>f.db.claimProactiveEvent('a',{healthDate:'2026-10-31',idempotencyKey:'synthetic-'+i,signals:[],decision:'NOTIFY',reason:{},policyVersion:'fixture',messageText:'synthetic'},{now:instant,expectedLifecycleGeneration:f.user.lifecycleGeneration}));
 const results=await Promise.all([reserve(1),reserve(2)]);assert.equal(results.filter(r=>r.claimed).length,1);
 assert.deepEqual(await proactiveQuota(f.db.raw,{userId:'a',timezone:f.user.timezone,now:instant}),{total:1,health:1,ask:0});
 assert.equal((await reserve(3)).claimed,false,'no ACK must not release the reservation');
});
test('actual two optional attempts allow only one health exception; ASK card is counted once',async t=>{
 const f=await fixture(t),companion=await createStage7Development(f),actor=await companion.interactions.authenticate({user:f.user,chatId:'123'});
 await f.core.transaction(async()=>{const p=await companion.preferences(actor);await companion.changePreferences(actor,p,{daily_enabled:1});});
 await f.db.raw.execute({sql:"INSERT INTO report_claims(user_id,report_type,local_date,owner,claimed_at,expires_at,lifecycle_generation,delivery_state,telegram_message_id) VALUES('a','daily','2026-10-31','synthetic',?,?,?,'DELIVERED',11)",args:[f.core.timestamp(),f.core.timestamp(),f.user.lifecycleGeneration]});
 await confirmedLegacyBrief({...f,companion},{day:'2026-10-31'});
 const proposed=await companion.prepareAfterBrief({user:f.user,chatId:'123',healthDay:'2026-10-31'});
 assert.equal(proposed.status,'PROPOSED');
 const base=(await f.db.raw.execute({sql:'SELECT * FROM journal_prompt_deliveries WHERE delivery_id=?',args:[proposed.deliveryId]})).rows[0];assert.ok(base);
 for(const kind of ['DAILY','WEEKLY']){
  const d={...base,delivery_id:f.core.newId(),semantic_key:f.core.newId(),occasion_key:null,kind,state:'DELIVERED',attempt_count:1,...companion.interactions.privacyFields(actor.state)};
  await companion.interactions.insert('journal_prompt_deliveries',d);
  await companion.interactions.insert('journal_delivery_attempts',{user_id:'a',delivery_id:d.delivery_id,attempt_id:f.core.newId(),attempt_number:1,state:'AMBIGUOUS',started_at:f.core.timestamp()});
 }
 const count=()=>proactiveQuota(f.db.raw,{userId:'a',timezone:f.user.timezone,now:instant});
 assert.deepEqual(await count(),{total:2,health:0,ask:0});
 const reserve=id=>f.db.transaction(()=>f.db.claimProactiveEvent('a',{healthDate:'2026-10-31',idempotencyKey:id,signals:[],decision:'ASK_CONTEXT',reason:{},policyVersion:'fixture'},{now:instant,expectedLifecycleGeneration:f.user.lifecycleGeneration}));
 const claim=await reserve('health-exception');assert.equal(claim.claimed,true);
 assert.deepEqual(await count(),{total:3,health:1,ask:1});assert.equal((await reserve('another-health')).claimed,false);
 const d={...base,delivery_id:f.core.newId(),semantic_key:f.core.newId(),occasion_key:null,schedule_json:JSON.stringify({source:'legacy-proactive-journal-v1',eventId:claim.id}),state:'DELIVERED',attempt_count:1,...companion.interactions.privacyFields(actor.state)};
 await companion.interactions.insert('journal_prompt_deliveries',d);
 await companion.interactions.insert('journal_delivery_attempts',{user_id:'a',delivery_id:d.delivery_id,attempt_id:f.core.newId(),attempt_number:1,state:'DELIVERED',started_at:f.core.timestamp()});
 assert.deepEqual(await count(),{total:3,health:1,ask:1});
 assert.equal(await companion.weekly.optionalSlotAvailable(actor,{kind:'COACH'}),false);
});
test('quiet B4 keeps its cursor and re-evaluates after quiet instead of discarding',async t=>{
 const f=await fixture(t),before=await f.db.getProactiveState('a'),telegram={send:async()=>{throw Error('UNEXPECTED_SEND');}};
 const result=await checkAndAct({db:f.db,userId:'a',timezone:'Asia/Taipei',expectedLifecycleGeneration:f.user.lifecycleGeneration,telegram,now:new Date('2026-10-31T23:50:00Z')});
 assert.equal(result.reason,'quiet_deferred');assert.deepEqual(await f.db.getProactiveState('a'),before);
 assert.equal((await f.db.raw.execute('SELECT count(*) n FROM proactive_events')).rows[0].n,0);
 const next=await checkAndAct({db:f.db,userId:'a',timezone:'Asia/Taipei',expectedLifecycleGeneration:f.user.lifecycleGeneration,telegram,now:new Date('2026-11-01T00:00:00Z')});
 assert.notEqual(next.reason,'quiet_deferred');
});
test('quiet floor and longer user interval apply to health reminders',async t=>{
 const f=await fixture(t);
 assert.equal((await healthReminderTiming(f.db,'a','Asia/Taipei',new Date('2026-10-31T23:59:00Z'))).quiet,true);
 assert.equal((await healthReminderTiming(f.db,'a','Asia/Taipei',new Date('2026-11-01T00:00:00Z'))).quiet,false);
});
test('low alert uses absolute 12, commits reservation before send and never resends unknown ACK',async t=>{
 const f=await fixture(t);assert.equal(LOW_ENERGY_FLOOR,12);
 await f.body.notificationControl.handle({text:'/energy alerts on',user:f.user,chatId:'123'});
 const actual=await f.body.inspect({userId:'a',requestedAt:instant});
 const body={...f.body,inspect:async()=>({...actual,calculation:{...actual.calculation,value:11,quality_state:'AVAILABLE'}})};
 let sends=0;const telegram={send:async(_text,{authorize})=>{assert.equal(await authorize(),true);assert.equal((await proactiveQuota(f.db.raw,{userId:'a',timezone:f.user.timezone,now:instant})).health,1);sends++;throw Error('SYNTHETIC_LOST_ACK');}};
 await assert.rejects(checkLowEnergy({...f,bodyEnergy:body,telegram,now:instant}),/SYNTHETIC_LOST_ACK/);
 await checkLowEnergy({...f,bodyEnergy:body,telegram,now:instant});assert.equal(sends,1);
});
test('quiet low alert is discarded, not delivered after quiet with unchanged source',async t=>{
 const f=await fixture(t);await f.body.notificationControl.handle({text:'/energy alerts on',user:f.user,chatId:'123'});
 const view=await f.body.inspect({userId:'a',requestedAt:instant}),body={...f.body,inspect:async()=>({...view,calculation:{...view.calculation,value:11,quality_state:'AVAILABLE'}})};
 let sends=0;const telegram={send:async()=>{sends++;return {messageId:1};}};
 assert.equal((await checkLowEnergy({...f,bodyEnergy:body,telegram,now:new Date('2026-10-31T23:50:00Z')})).status,'QUIET_DISCARDED');
 assert.equal((await checkLowEnergy({...f,bodyEnergy:body,telegram,now:new Date('2026-11-01T00:00:00Z')})).status,'QUIET_DISCARDED');assert.equal(sends,0);
});
test('all three preference keyboards show current switch states and icons',()=>{
 for(const locale of ['zh-TW','vi','en'])for(const enabled of [0,1]){
  const buttons=journalCard({kind:'PREFERENCES'},{locale,preferences:{daily_enabled:enabled,weekly_enabled:enabled,coach_enabled:enabled,proactive_enabled:enabled,low_energy_enabled:enabled,revision:0}}).buttons.flat();
  for(const kind of ['daily','weekly','coach','proactive','lowEnergy']){
   const b=buttons.find(b=>b.action.startsWith('prefs:'+kind+':'));assert.ok(b);assert.ok(b.label.startsWith(enabled?'✅':'⛔'));
   assert.ok(b.action.endsWith(`:${enabled?0:1}:0`));
  }
  for(const b of buttons)assert.match(b.label,/^(?:\p{Extended_Pictographic}|\p{Emoji_Presentation})/u);
 }
});
test('preference callbacks persist only user-selected opt-in and fence replay',async t=>{
 const f=await fixture(t),companion=await createStage7Development(f),actor=await companion.interactions.authenticate({user:f.user,chatId:'123'});
 let card=await companion.handle({text:'/journal',user:f.user,chatId:'123'}),seq=0;
 async function tap(action){
  await companion.interactions.bind(actor,card.stage7InteractionId,42);
  const b=card.replyMarkup.inline_keyboard.flat().find(b=>b.text.includes(action));assert.ok(b,action);
  card=await companion.handle({user:f.user,chatId:'123',callback:{id:String(++seq),data:b.callback_data,from:{id:123},message:{message_id:42,chat:{id:123,type:'private'}}}});
 }
 await tap('Tracking preferences');assert.equal((await f.body.notificationControl.read('a')).alertsEnabled,false);
 await tap('Low energy');assert.equal((await f.body.notificationControl.read('a')).alertsEnabled,true);
 await tap('Proactive health');assert.equal(await f.db.isProactiveEnabled('a'),false);
 await tap('Pause');assert.equal((await f.body.notificationControl.read('a')).alertsEnabled,false);
 assert.equal((await f.db.raw.execute('SELECT count(*) n FROM journal_events')).rows[0].n,0);
});
test('two consecutive health dates, not two observations on the same date, corroborate B4',()=>{
 const signal={code:'HRV_LOW',metric:'hrv',level:'STRONG'},event={decision:'LOG_ONLY',createdAt:'2026-10-31T03:00:00Z',signals:[signal]};
 const run=healthDate=>decide({signals:[signal],now:instant,healthDate:'2026-10-31',recentEvents:[{...event,healthDate}],sharedHealthQuota:true});
 assert.equal(run('2026-10-31').decision,'LOG_ONLY');assert.equal(run('2026-10-30').decision,'ASK_CONTEXT');
});
test('on-demand flag leaves recovery advanced publication/alerts OFF',()=>{
 assert.doesNotThrow(()=>assertSchemaTransitionProfile({PHASE4_EXECUTION_PROFILE:SCHEMA_TRANSITION_PROFILE,PHASE4_RELEASE_SHA:'a'.repeat(40),RENDER_GIT_COMMIT:'a'.repeat(40),BODY_ENERGY_ON_DEMAND:'on',BODY_ENERGY_PUBLICATION:'off',BODY_ENERGY_ALERTS:'off',BRIEFING_CONTINUATION_SCOPE:'sync'}));
});
