import test from 'node:test';import assert from 'node:assert/strict';import {createServer} from 'node:http';
import {syntheticPhase4Fixture} from './phase4Fixture.js';import {fixtureKeys} from './localDb.js';
import {createStage7Runtime} from '../src/stage7Runtime.js';import {createUpdateProcessor} from '../src/bot/updateProcessor.js';
import {createSendReply} from '../src/bot/index.js';import {createTelegramApi} from '../src/bot/api.js';
import {createWebhookHandler} from '../src/bot/webhook.js';import {createSettings,isSettingsCallback} from '../src/bot/settings.js';
const environment={STAGE7_COMPANION:'on',STAGE7_COMPANION_USER_IDS:'a',PHASE4_BETA_PILOT_USER_ID:'a'};
test('real HTTP authenticated callbacks: three localized icon keyboards, Journal persistence/edit/undo/skip, duplicate and wrong-actor fences',async t=>{
 const f=await syntheticPhase4Fixture(t,{targetVersion:33}),calls=[];let messageId=800,seq=12001;
 await f.db.linkTelegram({userId:'a',chatId:'123',now:f.core.now()});await f.db.linkTelegram({userId:'b',chatId:'456',now:f.core.now()});
 await f.db.saveTokens('a',{accessToken:'synthetic',refreshToken:'synthetic',expiresAt:new Date('2026-12-01'),scope:'offline',whoopUserId:'synthetic'},{now:f.core.now()});
 const originalFetch=globalThis.fetch;
 t.mock.method(globalThis,'fetch',async(url,options)=>{
  if(String(url).startsWith('http://127.0.0.1:'))return originalFetch(url,options);
  assert.match(String(url),/^https:\/\/api\.telegram\.org\/botSYNTHETIC_NOT_A_TOKEN\/(sendMessage|editMessageText|answerCallbackQuery)$/);
  const body=JSON.parse(options.body),method=String(url).split('/').at(-1);calls.push({method,body});
  const result=method==='answerCallbackQuery'?true:{message_id:body.message_id??++messageId,date:Math.floor(Date.now()/1000),chat:{id:Number(body.chat_id),type:'private'},text:body.text};
  return new Response(JSON.stringify({ok:true,result}),{status:200,headers:{'content-type':'application/json'}});
 });
 const app=await createStage7Runtime({db:f.db,keys:fixtureKeys,environment,env:{telegramBotToken:'SYNTHETIC_NOT_A_TOKEN'},now:f.core.now});
 const api=createTelegramApi({botToken:'SYNTHETIC_NOT_A_TOKEN'}),settings=createSettings({db:f.db,now:f.core.now}),send=createSendReply({db:f.db,api});
 const processor=createUpdateProcessor({db:f.db,now:f.core.now,resolveUser:chat=>f.db.resolveUserByChatId(chat),stage7Inbound:app.stage7Inbound,stage7Reply:app.stage7Reply,
  handleMessage:async input=>app.decorate({...input,reply:await settings(input)??'Synthetic free-text answer.'}),sendReply:input=>app.sendReply(send,input),answerCallback:id=>api.answerCallbackQuery(id)});
 const secret='synthetic-coach-journal-webhook',server=createServer(createWebhookHandler({secret,processUpdate:u=>processor.processUpdate(u)}));
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 t.after(()=>new Promise(resolve=>server.close(resolve)));const url=`http://127.0.0.1:${server.address().port}/telegram/webhook`;
 const post=async(update,token=secret)=>{const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json','x-telegram-bot-api-secret-token':token},body:JSON.stringify(update)});await r.text();return r.status;};
 const command=text=>({update_id:seq++,message:{message_id:seq,text,chat:{id:123,type:'private'},from:{id:123,is_bot:false}}});
 const latest=()=>calls.filter(c=>c.method!=='answerCallbackQuery').at(-1);
 function buttons(){const all=latest().body.reply_markup.inline_keyboard.flat();for(const b of all){assert.match(b.text,/\p{Extended_Pictographic}|[▫✅☀🌙]/u);assert.ok(/^j7:[A-Za-z0-9_-]{32}$/.test(b.callback_data)||isSettingsCallback(b.callback_data));}return all;}
 async function tap(label,{actor=123}={}){const b=buttons().find(b=>b.text.includes(label));assert.ok(b,label);const update={update_id:seq++,callback_query:{id:`cb-${seq}`,data:b.callback_data,from:{id:actor,is_bot:false},message:{message_id:latest().body.message_id??messageId,chat:{id:123,type:'private'}}}};assert.equal(await post(update),200);return update;}
 assert.equal(await post(command('/coach'),'wrong-secret'),401);assert.equal(calls.length,0);
 for(const [locale,sleep,range,free] of [['zh-TW','睡眠','今天','自由提問'],['en','Sleep','Today','Type a question'],['vi','Giấc ngủ','Hôm nay','Nhập câu hỏi']]){
  await f.db.setLocale('a',locale,{now:f.core.now()});assert.equal(await post(command('/coach')),200);buttons();await tap(sleep);await tap(range);assert.equal(latest().method,'editMessageText');await tap(free);
 }
 await f.db.setLocale('a','en',{now:f.core.now()});await post(command('/journal'));await tap('Caffeine');await tap('Yes');await tap('Evening');const confirmed=await tap('Confirm');
 let facts=(await f.db.raw.execute("SELECT * FROM journal_events WHERE fact_status='ACTIVE'")).rows;assert.equal(facts.length,1);assert.equal(facts[0].provenance_mode,'TRUSTED_REGISTRY');assert.equal(facts[0].answer_polarity,'YES');
 const sends=calls.filter(c=>c.method!=='answerCallbackQuery').length;await post(confirmed);assert.equal(calls.filter(c=>c.method!=='answerCallbackQuery').length,sends);assert.equal((await f.db.raw.execute('SELECT count(*) n FROM journal_events')).rows[0].n,1);
 await tap('Edit');await tap('No');await tap('Confirm');facts=(await f.db.raw.execute("SELECT * FROM journal_events WHERE fact_status='ACTIVE'")).rows;assert.equal(facts.length,1);assert.equal(facts[0].answer_polarity,'NO');await tap('Retract');assert.equal((await f.db.raw.execute('SELECT count(*) n FROM journal_events')).rows[0].n,0);
 await post(command('/journal'));await tap('Alcohol');await tap('Skip');assert.equal((await f.db.raw.execute('SELECT count(*) n FROM journal_events')).rows[0].n,0);
 await post(command('/settings'));assert.ok(buttons().some(b=>b.text.includes('Journal and Coach')));
 await post(command('/coach'));const before=calls.filter(c=>c.method!=='answerCallbackQuery').length;await tap('Sleep',{actor:456});assert.equal(calls.filter(c=>c.method!=='answerCallbackQuery').length,before);
 assert.equal(await app.stage7Inbound({user:await f.db.getUser('b'),chatId:'456',text:'/coach',updateId:999}),null);
 assert.equal((await f.db.raw.execute("SELECT count(*) n FROM journal_events WHERE user_id='b'")).rows[0].n,0);
 assert.deepEqual((await f.db.raw.execute('PRAGMA foreign_key_check')).rows,[]);
});
