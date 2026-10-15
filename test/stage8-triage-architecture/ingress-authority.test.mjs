import test from 'node:test';import assert from 'node:assert/strict';
import {stage8Fixture} from '../stage8Fixture.js';
import {createStage7Runtime} from '../../src/stage7Runtime.js';
import {createSettings,settingsKey} from '../../src/bot/settings.js';
import {createRouter} from '../../src/bot/router.js';
import {createSendReply} from '../../src/bot/index.js';
import {createUpdateProcessor} from '../../src/bot/updateProcessor.js';
import {urgentReply,interpretUrgentSymptoms,TRIAGE_DECISION} from '../../src/bot/triage.js';
import {JOURNAL_COPY} from '../../src/stage7Registry.js';
async function tap(app,f,card,label){
 const actor=await app.companion.interactions.authenticate(f.input);await app.companion.interactions.bind(actor,card.stage7InteractionId,42);
 const b=card.replyMarkup.inline_keyboard.flat().find(b=>b.text===label||b.text.endsWith(' '+label));assert.ok(b);
 return app.companion.handle({...f.input,callback:{id:'synthetic',data:b.callback_data,from:{id:123},message:{message_id:42,chat:{id:123,type:'private'}}}});
}
const update=(id,text,from=123)=>({update_id:id,message:{text,message_id:id,chat:{id:123,type:'private'},from:{id:from,is_bot:false,first_name:'Synthetic'}}});
for(const locale of ['en','vi','zh-TW'])for(const lane of ['name','note','coach','health'])test('possible ingress '+locale+' '+lane,async t=>{
 t.mock.method(globalThis,'fetch',()=>{throw Error('NETWORK_FORBIDDEN');});
 const f=await stage8Fixture(t);await f.db.setLocale('a',locale);
 await f.app.identity.recordTelegram({...f.input,message:update(1,'').message});
 const app=await createStage7Runtime({...f,environment:{STAGE7_COMPANION:'on',STAGE7_COMPANION_USER_IDS:'a',PHASE4_BETA_PILOT_USER_ID:'a'},now:f.now});
 const settings=createSettings({db:f.db,stage8:f.app,now:f.now}),router=createRouter({db:f.db,stage8:f.app,now:f.now,coachFor(){throw Error('MODEL_FORBIDDEN');}});
 if(lane==='name')await settings({...f.input,text:'/name'});
 if(lane==='coach')await app.coach.handle({...f.input,text:'/coach'});
 if(lane==='note'){const c=JOURNAL_COPY[locale];let card=await app.companion.handle({...f.input,text:'/journal'});card=await tap(app,f,card,c.topics[0]);card=await tap(app,f,card,c.yes);card=await tap(app,f,card,c.details[0]);await tap(app,f,card,c.note);}
 const oldName=await f.db.getState(settingsKey('a')),rows=async()=>JSON.stringify((await f.db.raw.execute("SELECT * FROM quick_action_interactions WHERE user_id='a'")).rows);
 const oldRows=await rows(),identities=async()=>JSON.stringify((await f.db.raw.execute('SELECT * FROM recipient_identity_sources')).rows),oldIdentity=await identities();
 let sent,sends=0,consumers=0,captures=0;
 const p=createUpdateProcessor({db:f.db,now:f.now,resolveUser:id=>f.db.resolveUserByChatId(id),authenticatedIdentity:input=>{captures++;return f.app.captureIdentity(input);},stage7Inbound:input=>{consumers++;return app.stage7Inbound(input);},stage7Reply:app.stage7Reply,
 handleMessage:async input=>{consumers++;return (await settings(input))??router.handle(input);},
 sendReply:input=>f.app.sendReply(value=>app.sendReply(async delivered=>{sent=delivered.reply;sends++;return {sent:true,messageId:84};},value),input)});
 const text={en:'chest pain',vi:'khó thở','zh-TW':'胸痛'}[locale];assert.equal(interpretUrgentSymptoms(text).decision,TRIAGE_DECISION.POSSIBLE_CURRENT_URGENT);
 const u=update(98601,text);assert.equal((await p.processUpdate(u)).outcome,'processed');assert.equal(sent.text,urgentReply(locale));
 assert.equal(await f.db.getState(settingsKey('a')),oldName);assert.equal(await rows(),oldRows);assert.equal(await identities(),oldIdentity);
 assert.equal(consumers,0);assert.equal(captures,0);assert.equal((await f.db.raw.execute('SELECT count(*) n FROM stage8_scoped_read_audit')).rows[0].n,0);
 assert.equal((await p.processUpdate(u)).outcome,'replayed');assert.equal(sends,1);
 const normal=lane==='name'?'Ordinary Name':lane==='note'?'Ordinary free text note':lane==='coach'?'/coach':'my HRV today';
 assert.equal((await p.processUpdate(update(98602,normal))).outcome,'processed');assert.notEqual(sent.text,urgentReply(locale));assert.equal(sends,2);
 if(lane==='name')assert.equal(JSON.parse(await f.db.getState(settingsKey('a'))).pendingName,normal);
 if(lane==='note'){const row=(await f.db.raw.execute("SELECT state,note FROM quick_action_interactions WHERE user_id='a' AND category='caffeine'")).rows[0];assert.equal(row.state,'CONFIRM');assert.equal(row.note,normal);}
 if(lane==='coach')assert.ok(sent.replyMarkup.inline_keyboard.flat().length>0);
 if(lane==='health'){assert.match(sent.text,/HRV: 50\.0/);assert.equal((await f.db.raw.execute('SELECT count(*) n FROM stage8_scoped_read_audit')).rows[0].n,1);}
});
for(const boundary of ['forged_sender','stale_lifecycle','cross_tenant_destination'])test('possible-current authority '+boundary,async t=>{
 const f=await stage8Fixture(t);let calls=0;
 const p=createUpdateProcessor({db:f.db,now:f.now,resolveUser:async id=>{
  const result=await f.db.resolveUserByChatId(id);
  if(result&&boundary==='stale_lifecycle')await f.db.transitionUserLifecycle({userId:'a',targetStatus:'PAUSED'});
  if(result&&boundary==='cross_tenant_destination'){await f.db.revokeTelegramLink('123');await f.db.linkTelegram({chatId:'123',userId:'b'});}
  return result;
 },handleMessage:async()=>{calls++;return {text:'FORBIDDEN'};},sendReply:createSendReply({db:f.db,api:{sendMessage:async()=>{calls++;return {message_id:2,date:1,chat:{id:123,type:'private'}};}}})});
 await p.processUpdate(update(98701,'chest pain',boundary==='forged_sender'?456:123));
 assert.equal(calls,0);
 assert.equal((await f.db.raw.execute('SELECT count(*) n FROM stage8_scoped_read_audit')).rows[0].n,0);
});
