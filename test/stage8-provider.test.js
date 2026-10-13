import test from 'node:test';import assert from 'node:assert/strict';
import {stage8Fixture} from './stage8Fixture.js';
import {createStage8Runtime,stage8Configuration} from '../src/stage8Runtime.js';
import {createStage7Runtime} from '../src/stage7Runtime.js';
import {createRouter} from '../src/bot/router.js';
import {createSettings} from '../src/bot/settings.js';
import {createUpdateProcessor} from '../src/bot/updateProcessor.js';
import {createSendReply} from '../src/bot/index.js';
import {createTelegramApi} from '../src/bot/api.js';
import {createStage8MorningPlan} from '../src/stage8MorningPlan.js';
const count=async(db,table)=>(await db.raw.execute(`SELECT count(*) n FROM ${table}`)).rows[0].n;
const tap=(reply,action)=>({data:reply.replyMarkup.inline_keyboard.flat().find(button=>button.callback_data.endsWith('.'+action)).callback_data});
test('Stage 8 default-off touches no database; invalid gates and widened cohort fail closed',async()=>{
 const db=new Proxy({},{get(){throw Error('DATABASE_FORBIDDEN');}});assert.equal(await createStage8Runtime({db,environment:{}}),null);
 assert.throws(()=>stage8Configuration({PHASE4_STAGE8_RUNTIME:'true'}),/CONFIG_INVALID/);
 assert.throws(()=>stage8Configuration({PHASE4_STAGE8_RUNTIME:'on',PHASE4_BETA_PILOT_USER_ID:'a',STAGE8_USER_IDS:'a,b'}),/COHORT_REQUIRED/);
});
test('real router resolves self source facts through Stage 8 without a model; third-party and general never open health scope',async t=>{
 const f=await stage8Fixture(t),router=createRouter({db:f.db,stage8:f.app,now:f.now,coachFor(){throw Error('LEGACY_MODEL_FORBIDDEN');}});
 const self=await router.handle({...f.input,text:'my HRV today'});assert.match(self.text,/HRV:|No usable source/);assert.ok(self.stage8ReplyGuard);
 const reads=await count(f.db,'stage8_scoped_read_audit');
 for(const text of ['How is Alice’s recovery?','What is HRV?','What is my wife’s sleep score?'])await router.handle({...f.input,text});
 assert.equal(await count(f.db,'stage8_scoped_read_audit'),reads);
 assert.match((await router.handle({...f.input,text:'/evidence'})).text,/Analysis is updating/);
 assert.equal((await f.db.raw.execute("SELECT count(*) n FROM phase4_computation_state WHERE execution_mode='LIVE'")).rows[0].n,0);
});
test('missing LIVE producer remains updating even if SQL completion metadata says current-empty',async t=>{
 const f=await stage8Fixture(t);await f.core.initializeTenant('a','LIVE');await f.db.raw.execute("UPDATE phase4_computation_state SET last_completed_generation=input_generation WHERE user_id='a' AND execution_mode='LIVE'");
 const reply=await f.app.handle({...f.input,text:'/insights'});assert.match(reply.text,/Analysis is updating/);assert.doesNotMatch(reply.text,/No usable source/);
});
test('notification Settings buttons persist fixed time, delay and pause; stale preferences and cross-user actor are rejected',async t=>{
 const f=await stage8Fixture(t),settings=createSettings({db:f.db,stage8:f.app,now:f.now});let card=await settings({...f.input,text:'/settings'});
 card=await settings({...f.input,callback:tap(card,'notifications')});assert.match(card.text,/Morning Brief/);
 card=await settings({...f.input,callback:tap(card,'fixed')});card=await settings({...f.input,text:'09:45'});
 let preferences=await f.app.preferences.read(f.input);assert.equal(preferences.morning_brief_local_time,'09:45');assert.equal(preferences.morning_brief_mode,'FIXED_LOCAL_TIME');
 const stale=preferences;card=await settings({...f.input,callback:tap(card,'pause')});preferences=await f.app.preferences.read(f.input);assert.equal(preferences.notifications_paused,1);
 await assert.rejects(f.app.preferences.update(f.input,stale.preference_version,{notifications_paused:0}),/CAS_LOST/);
 await assert.rejects(f.app.preferences.read({user:await f.db.getUser('b'),chatId:'123'}),/ACTOR_FENCED/);
 f.environment.PHASE4_STAGE8_RUNTIME='off';await assert.rejects(f.app.preferences.read(f.input),/ACTOR_FENCED/);
});
test('owner Settings wiring starts empty and persists explicit class follow/disable with revisions',async t=>{
 const f=await stage8Fixture(t,{owner:true}),settings=createSettings({db:f.db,stage8:f.app,now:f.now});assert.deepEqual(await f.app.owner.read(f.input,'b'),{});
 let card=await settings({...f.input,text:'/settings'});card=await settings({...f.input,callback:tap(card,'owner')});card=await settings({...f.input,callback:tap(card,'subject0')});card=await settings({...f.input,callback:tap(card,'daily')});
 assert.equal((await f.app.owner.read(f.input,'b')).DAILY_SUMMARY.enabled,1);
 await settings({...f.input,callback:tap(card,'daily')});assert.equal((await f.app.owner.read(f.input,'b')).DAILY_SUMMARY.enabled,0);
 assert.equal(await count(f.db,'owner_monitoring_subscription_events'),2);
});
test('persisted scoped replies survive JSON replay and reject changed content, destination and profile ABA at send boundary',async t=>{
 const f=await stage8Fixture(t),reply=JSON.parse(JSON.stringify(await f.app.handle({...f.input,text:'my HRV today'})));let sends=0;
 const send=async()=>{sends++;return {sent:true,messageId:12};};const request={userId:'a',chatId:'123',reply};
 assert.equal((await f.app.sendReply(send,request)).sent,true);assert.equal((await f.app.sendReply(send,{...request,reply:{...reply,text:'forged'}})).sent,false);
 assert.equal((await f.app.sendReply(send,{...request,chatId:'456'})).sent,false);await f.db.setLocale('a','vi');await f.db.setLocale('a','en');assert.equal((await f.app.sendReply(send,request)).sent,false);assert.equal(sends,1);
});
test('integrated Stage 7/8 Telegram processor sends source answer plus clickable navigation once and handles callbacks',async t=>{
 const f=await stage8Fixture(t),calls=[];let sequence=44000,messageId=100;
 t.mock.method(globalThis,'fetch',async(url,options)=>{
  assert.match(String(url),/^https:\/\/api\.telegram\.org\/botSYNTHETIC_NOT_A_TOKEN\/(sendMessage|editMessageText|answerCallbackQuery)$/);
  const body=JSON.parse(options.body),method=String(url).split('/').at(-1);calls.push({method,body});
  return new Response(JSON.stringify({ok:true,result:method==='answerCallbackQuery'?true:{message_id:body.message_id??++messageId,date:1,chat:{id:Number(body.chat_id),type:'private'},text:body.text}}),{status:200});
 });
 const stage7=await createStage7Runtime({...f,environment:{STAGE7_COMPANION:'on',STAGE7_COMPANION_USER_IDS:'a',PHASE4_BETA_PILOT_USER_ID:'a'},now:f.now});
 const app=await createStage8Runtime({...f,environment:f.environment,env:f.env,stage7,now:f.now});
 const router=createRouter({db:f.db,stage8:app,coachFor(){throw Error('MODEL_FORBIDDEN');},now:f.now}),api=createTelegramApi({botToken:f.env.telegramBotToken}),send=createSendReply({db:f.db,api});
 const processor=createUpdateProcessor({db:f.db,now:f.now,resolveUser:chat=>f.db.resolveUserByChatId(chat),stage7Inbound:stage7.stage7Inbound,stage7Reply:stage7.stage7Reply,
  handleMessage:async input=>stage7.decorate({...input,reply:await router.handle(input)}),sendReply:input=>app.sendReply(value=>stage7.sendReply(send,value),input),answerCallback:id=>api.answerCallbackQuery(id)});
 const update={update_id:sequence++,message:{message_id:1,text:'my HRV today?',chat:{id:123,type:'private'},from:{id:123,is_bot:false}}};await processor.processUpdate(update);
 let sent=calls.filter(c=>c.method!=='answerCallbackQuery').at(-1);assert.ok(sent);assert.match(sent.body.text,/HRV:|No usable source/);assert.ok(sent.body.reply_markup.inline_keyboard.length);
 const before=calls.length;await processor.processUpdate(update);assert.equal(calls.length,before);
 const button=sent.body.reply_markup.inline_keyboard.flat()[0];await processor.processUpdate({update_id:sequence++,callback_query:{id:'synthetic',data:button.callback_data,from:{id:123,is_bot:false},message:{message_id:messageId,chat:{id:123,type:'private'}}}});
 assert.ok(calls.some(c=>c.method==='answerCallbackQuery'));assert.ok(calls.some(c=>c.method==='editMessageText'));
});
for(const acceptance of ['delivered','network-uncertain','malformed-ack','definite-failure'])test(`owner provider ${acceptance} settles durable state and never duplicates`,async t=>{
 const f=await stage8Fixture(t,{owner:true});let sends=0;
 t.mock.method(globalThis,'fetch',async(url,options)=>{
  assert.equal(String(url),'https://api.telegram.org/botSYNTHETIC_NOT_A_TOKEN/sendMessage');const body=JSON.parse(options.body);assert.equal(body.chat_id,'123');assert.match(body.text,/Followed user health summary/);sends++;
  if(acceptance==='network-uncertain')throw Error('SYNTHETIC_NETWORK_UNCERTAIN');
  if(acceptance==='definite-failure')return new Response(JSON.stringify({ok:false,error_code:403,description:'Synthetic'}),{status:403});
  return new Response(JSON.stringify({ok:true,result:{message_id:acceptance==='malformed-ack'?'101':101,date:1,chat:{id:123,type:'private'}}}),{status:200});
 });
 // Rebuild after installing the mock so the real API captures the isolated transport.
 const app=await createStage8Runtime({...f,environment:f.environment,env:f.env,now:f.now});
 await app.owner.configure(f.input,{subjectId:'b',notificationClass:'DAILY_SUMMARY',enabled:true,expectedRevision:0,operationKey:'synthetic-follow'});
 await f.core.initializeTenant('b','LIVE');const ctx=await f.core.capture('b',{executionMode:'LIVE'}),plans=createStage8MorningPlan({...f,preferences:f.stores.preferences});await plans.persist(ctx,await plans.build(ctx,{healthDate:'2026-09-19'}));
 const request={subjectId:'b',notificationClass:'DAILY_SUMMARY'},first=await app.owner.dispatch(f.input,request),second=await app.owner.dispatch(f.input,request);
 assert.equal(first.status,acceptance==='delivered'?'DELIVERED':acceptance==='definite-failure'?'FAILED_DEFINITE':'AMBIGUOUS');assert.equal(second.status,first.status);assert.equal(sends,1);
 assert.equal(await count(f.db,'owner_monitoring_attempts'),1);assert.equal(await count(f.db,'owner_monitoring_outbox'),1);
});

test('explicit Journal writes retain the existing route; verified name confirmation is recorded for the same recipient only',async t=>{
 const f=await stage8Fixture(t),settings=createSettings({db:f.db,stage8:f.app,now:f.now});
 assert.equal(await f.app.handle({...f.input,text:'/journal alcohol 1 drinks'}),null);assert.equal(await f.app.handle({...f.input,text:'/log alcohol 1 drinks'}),null);
 assert.equal(await f.app.identity.resolve('a'),'');let card=await settings({...f.input,text:'/name'});card=await settings({...f.input,text:'Verified Synthetic Name'});await settings({...f.input,callback:tap(card,'save')});
 assert.equal(await f.app.identity.resolve('a'),'Verified Synthetic Name');assert.equal(await f.app.identity.resolve('b'),'');
 assert.equal((await f.db.raw.execute('SELECT count(*) n FROM recipient_identity_sources')).rows[0].n,1);
});
