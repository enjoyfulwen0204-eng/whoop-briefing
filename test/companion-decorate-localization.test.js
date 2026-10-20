import test from 'node:test';
import assert from 'node:assert/strict';
import {syntheticPhase4Fixture} from './phase4Fixture.js';
import {createStage7Runtime} from '../src/stage7Runtime.js';
import {fixtureKeys} from './localDb.js';

const environment={STAGE7_COMPANION:'on',STAGE7_COMPANION_USER_IDS:'a',PHASE4_BETA_PILOT_USER_ID:'a'};
test('ordinary localized Coach navigation is sealed for its own actor and preserves command/privacy boundaries',async t=>{
 const f=await syntheticPhase4Fixture(t,{targetVersion:35});let networkCalls=0;
 t.mock.method(globalThis,'fetch',async()=>{networkCalls++;throw Error('EXTERNAL_IO_FORBIDDEN');});
 await f.db.linkTelegram({userId:'a',chatId:'123',now:f.core.now()});
 await f.db.linkTelegram({userId:'b',chatId:'456',now:f.core.now()});
 const app=await createStage7Runtime({db:f.db,keys:fixtureKeys,environment,env:{telegramBotToken:'SYNTHETIC_NOT_A_TOKEN'},now:f.core.now});
 const user=await f.db.getUser('a'),other=await f.db.getUser('b'),base='Synthetic ordinary answer.';
 let senderEntries=0,lastReply;
 const noSend=async input=>{assert.equal(await input.beforeSend(),true);senderEntries++;return {sent:false,messageId:null};};
 const cases=[
  ['vi','Hôm nay tôi vận động ít.','🏃 Vận động'],
  ['vi','Hôm nay tôi tập luyện ít.','🏃 Vận động'],
  ['vi','Hôm nay tôi ngủ ít.','😴 Giấc ngủ'],
  ['vi','Hôm nay tôi phục hồi chậm.','🌿 Phục hồi'],
  ['en','I slept poorly; my sleep was short.','😴 Sleep'],
  ['en','My recovery was lower today.','🌿 Recovery'],
  ['zh-TW','今天睡得不好','😴 睡眠'],
  ['zh-TW','今天恢復較慢','🌿 恢復'],
 ];
 for(const [locale,text,expected] of cases){
  await f.db.setLocale('a',locale,{now:f.core.now()});
  const reply=await app.decorate({user,chatId:'123',text,reply:base});
  assert.equal(reply.text,base);assert.ok(reply.stage7InteractionId);assert.ok(reply.stage7ReplyGuard);
  assert.equal(reply.stage7ReplyGuard.captured.userId,'a');assert.equal(reply.stage7ReplyGuard.captured.chat,'123');
  const buttons=reply.replyMarkup.inline_keyboard.flat();assert.ok(buttons.some(button=>button.text===expected));
  for(const button of buttons){assert.match(button.text,/\p{Extended_Pictographic}/u);assert.ok(button.text.length>2);assert.ok(button.callback_data.startsWith('j7:'));}
  const before=senderEntries;
  await app.sendReply(noSend,{userId:'a',chatId:'123',reply});assert.equal(senderEntries,before+1,'sealed own reply reaches only the inert sender');
  assert.equal((await app.sendReply(noSend,{userId:'b',chatId:'456',reply})).sent,false);
  assert.equal((await app.sendReply(noSend,{userId:'a',chatId:'456',reply})).sent,false);
  assert.equal((await app.sendReply(noSend,{userId:'a',chatId:'123',reply:{...reply,text:'Altered projection'}})).sent,false);
  assert.equal(senderEntries,before+1,'foreign actor/chat and altered reply never reach the sender');
  lastReply=reply;
 }
 const before=(await f.db.raw.execute('SELECT count(*) n FROM quick_action_interactions')).rows[0].n;
 for(const text of ['Cảm ơn bạn.','/coach','/sleep','/journal'])assert.equal(await app.decorate({user,chatId:'123',text,reply:base}),base);
 for(const guard of ['stage8ReplyGuard','bodyEnergyReplyGuard','stage5PresentationGuard']){
  const protectedReply={text:base,[guard]:{synthetic:true}};
  assert.equal(await app.decorate({user,chatId:'123',text:'Hôm nay tôi tập luyện ít.',reply:protectedReply}),protectedReply);
 }
 assert.equal(await app.decorate({user:other,chatId:'456',text:'Hôm nay tôi vận động ít.',reply:base}),base);
 assert.equal(await app.stage7Inbound({user:other,chatId:'456',text:'/coach',updateId:999}),null);
 assert.equal((await f.db.raw.execute('SELECT count(*) n FROM quick_action_interactions')).rows[0].n,before);
 assert.equal((await f.db.raw.execute("SELECT count(*) n FROM quick_action_interactions WHERE user_id='b'")).rows[0].n,0);
 const actor=await app.companion.interactions.authenticate({user,chatId:'123'}),prefs=await app.companion.preferences(actor);
 assert.deepEqual([prefs.daily_enabled,prefs.weekly_enabled,prefs.coach_enabled],[0,0,0]);
 assert.equal((await f.db.raw.execute('SELECT count(*) n FROM journal_events')).rows[0].n,0);
 assert.equal(networkCalls,0);assert.ok(lastReply.stage7ReplyGuard);
});
