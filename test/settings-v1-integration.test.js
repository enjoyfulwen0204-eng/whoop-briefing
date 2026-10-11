import test from 'node:test';import assert from 'node:assert/strict';
import {deliveryFixture} from './deliveryDefaultFixture.js';
import {createSettings,SETTINGS_TTL_MS,settingsKey} from '../src/bot/settings.js';
import {createUpdateProcessor,UPDATE_OUTCOME,conversationKeyOf} from '../src/bot/updateProcessor.js';
import {SEND_OUTCOME,tagOutcome} from '../src/sendOutcome.js';
import {createTelegramApi} from '../src/bot/api.js';
const msg=(id,text,chat='1001')=>({update_id:id,message:{message_id:id,text,chat:{id:Number(chat),type:'private'},from:{id:Number(chat),is_bot:false}}});
const cb=(id,data,chat='1001')=>({update_id:id,callback_query:{id:'query-'+id,data,from:{id:Number(chat),is_bot:false},message:{message_id:1,text:'settings',from:{id:999,is_bot:true},chat:{id:Number(chat),type:'private'}}}});
const action=(r,code)=>r.replyMarkup.inline_keyboard.flat().find(b=>b.callback_data.endsWith('.'+code)).callback_data;
async function fixture(t){
 const {db,transport}=await deliveryFixture(t);await db.admitRuntime();for(const [id,chat] of [['alice','1001'],['bob','1002']]){await db.createUser({id,displayName:id,status:'ACTIVE'});await db.linkTelegram({userId:id,chatId:chat});await db.setLocale(id,'en');}
 let sendFailure=false,ackFailure=false;let at=Date.now(),flow=createSettings({db,now:()=>new Date(at)});const sent=[],acks=[],other=[],events=[];
 const options={db,resolveUser:c=>db.resolveUserByChatId(c),handleMessage:async x=>{const reply=await flow(x);if(reply!==null)return reply;other.push(x.text);return 'Ordinary reply';},sendReply:async r=>{events.push('send');sent.push(r.reply);if(sendFailure){sendFailure=false;throw tagOutcome(Error('synthetic ambiguous send'),SEND_OUTCOME.AMBIGUOUS);}return {sent:true,messageId:sent.length};},answerCallback:async id=>{events.push('ack:'+id);acks.push(id);if(ackFailure)throw Error('synthetic ack network failure');},now:()=>new Date(at)};
 let processor=createUpdateProcessor(options);
 return {db,transport,sent,acks,other,events,failSend:()=>sendFailure=true,failAck:()=>ackFailure=true,process:x=>processor.processUpdate(x),advance:ms=>at+=ms,restart:()=>{flow=createSettings({db,now:()=>new Date(at)});processor=createUpdateProcessor(options);}};
}
test('durable command/name edit/callback save, restart and duplicate delivery retain one action and actor',async t=>{
 const f=await fixture(t);assert.equal((await f.process(msg(100,'/name'))).outcome,UPDATE_OUTCOME.PROCESSED);
 assert.equal((await f.process(msg(101,'Lan <&>'))).outcome,UPDATE_OUTCOME.PROCESSED);const data=action(f.sent.at(-1),'save');f.restart();
 const update=cb(102,data);assert.equal(conversationKeyOf(update),'tg:1001');assert.equal((await f.process(update)).outcome,UPDATE_OUTCOME.PROCESSED);assert.equal((await f.db.getUser('alice')).displayName,'Lan <&>');
 const sends=f.sent.length;await f.process(update);assert.equal(f.sent.length,sends);assert.deepEqual(f.acks,['query-102','query-102']);
 await f.process(cb(103,data,'1002'));assert.equal((await f.db.getUser('bob')).displayName,'bob');assert.equal((await f.db.getUser('alice')).displayName,'Lan <&>');
 for(const forged of [{...cb(104,data),callback_query:{...cb(104,data).callback_query,from:{id:1002}}},{...cb(105,data),callback_query:{...cb(105,data).callback_query,message:{chat:{id:1001,type:'group'}}}}]){assert.equal(conversationKeyOf(forged),null);await f.process(forged);}
 assert.equal((await f.db.getUser('alice')).displayName,'Lan <&>');assert.ok(f.acks.includes('query-105'));
});
test('expired or malformed name session cannot trap subsequent Coach/Journal messages',async t=>{
 const f=await fixture(t);await f.process(msg(200,'/name'));f.advance(SETTINGS_TTL_MS+1);await f.process(msg(201,'Why was recovery low?'));assert.ok(f.other.includes('Why was recovery low?'));assert.equal(await f.db.getState(settingsKey('alice')),null);
 await f.db.setState(settingsKey('alice'),'{malformed');await f.process(msg(202,'/log alcohol 1'));assert.ok(f.other.includes('/log alcohol 1'));await f.process(msg(203,'How did I sleep?'));assert.ok(f.other.includes('How did I sleep?'));
});
test('lost DB COMMIT acknowledgement reconciles callback receipt; no second profile update or send',async t=>{
 const f=await fixture(t);await f.process(msg(300,'/name'));await f.process(msg(301,'Committed name'));const update=cb(302,action(f.sent.at(-1),'save'));
 f.transport.arm({matchSql:/UPDATE users SET display_name/,loseAcknowledgement:true});const first=await f.process(update);assert.equal(first.outcome,UPDATE_OUTCOME.RETRY);
 f.restart();const immediate=await f.process(update);
 if(immediate.outcome===UPDATE_OUTCOME.RETRY)f.advance(10*60_000);
 const resumed=immediate.outcome===UPDATE_OUTCOME.RETRY?await f.process(update):immediate;assert.ok([UPDATE_OUTCOME.PROCESSED,UPDATE_OUTCOME.REPLAYED].includes(resumed.outcome),JSON.stringify(resumed));
 const receipt=(await f.db.raw.execute('SELECT delivery_state FROM telegram_operations WHERE update_id=302')).rows[0];assert.equal(receipt.delivery_state,'DELIVERED');
 assert.equal((await f.db.raw.execute('SELECT status FROM telegram_processed_updates WHERE update_id=302')).rows[0].status,'COMPLETED');
 assert.equal(f.sent.filter(r=>r.text==='✅ Settings saved.').length,1);
 assert.equal((await f.db.getUser('alice')).displayName,'Committed name');assert.equal(await f.db.getState(settingsKey('alice')),null);const sends=f.sent.length;await f.process(update);assert.equal(f.sent.length,sends);
});
test('Telegram structured Settings replies stay plain text; buttons and callback acknowledgments use native APIs',async()=>{
 const requests=[];const api=createTelegramApi({botToken:'synthetic',fetchImpl:async(url,init)=>{requests.push({url,body:JSON.parse(init.body)});return new Response(JSON.stringify({ok:true,result:url.endsWith('/answerCallbackQuery')?true:{message_id:42,date:1791586800,chat:{id:1001,type:'private'}}}));}});
 await api.sendMessage('1001',{text:'<name> & *literal*',replyMarkup:{inline_keyboard:[[{text:'✅ Save',callback_data:'synthetic'}]]}});await api.answerCallbackQuery('query-1');
 assert.equal(requests[0].body.text,'<name> & *literal*');assert.equal(requests[0].body.parse_mode,undefined);assert.equal(requests[0].body.reply_markup.inline_keyboard[0][0].text,'✅ Save');assert.equal(requests[1].body.callback_query_id,'query-1');
});
test('invalid structured reply is a definite pre-send failure and initiates no Telegram request',async()=>{
 let calls=0;const api=createTelegramApi({botToken:'synthetic',fetchImpl:async()=>{calls++;throw Error('UNEXPECTED_REQUEST');}});
 for(const reply of [null,{}, {text:''},{text:123}])await assert.rejects(()=>api.sendMessage('1001',reply),e=>e.sendOutcome===SEND_OUTCOME.DEFINITE_FAILURE&&e.sendStage==='preflight');
 assert.equal(calls,0);
});
test('ambiguous Settings confirmation is terminal; replay sends zero additional confirmations',async t=>{
 const f=await fixture(t);await f.process(msg(400,'/name'));await f.process(msg(401,'Ambiguous name'));const update=cb(402,action(f.sent.at(-1),'save'));f.failSend();
 const first=await f.process(update);assert.equal(first.outcome,UPDATE_OUTCOME.AMBIGUOUS_DELIVERY);assert.equal((await f.db.getUser('alice')).displayName,'Ambiguous name');assert.equal((await f.db.raw.execute('SELECT delivery_state FROM telegram_operations WHERE update_id=402')).rows[0].delivery_state,'AMBIGUOUS');
 const count=f.sent.length;f.restart();await f.process(update);assert.equal(f.sent.length,count);
});
test('callback is acknowledged before delivery; acknowledgment network failure does not repeat or roll back the action',async t=>{
 const f=await fixture(t);await f.process(msg(500,'/settings'));const update=cb(501,action(f.sent.at(-1),'cancel'));f.failAck();const before=f.events.length;
 assert.equal((await f.process(update)).outcome,UPDATE_OUTCOME.PROCESSED);assert.equal(f.events[before],'ack:query-501');assert.equal(f.events[before+1],'send');assert.equal(await f.db.getState(settingsKey('alice')),null);
 const count=f.sent.length;await f.process(update);assert.equal(f.sent.length,count);
});
