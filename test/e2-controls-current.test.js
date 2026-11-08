import test from 'node:test';
import assert from 'node:assert/strict';
import {attachKeyboard,privateKeyboard,commandsFor,privateShortcut,fixedJournal,privateContext,createCommandMenus,timedEnergyEnabled} from '../src/bot/privateControls.js';
import {createUpdateProcessor} from '../src/bot/updateProcessor.js';
import {createAccountSelfService} from '../src/accountSelfService.js';
import {createBetaEnrollment,DISCLAIMER_VERSION} from '../src/betaEnrollment.js';
import {createSettings} from '../src/bot/settings.js';
import {createTelegram} from '../src/telegram.js';
import {buildBriefing} from '../src/daily.js';
import {renderDaily} from '../src/format.js';
import {syntheticStage7V33Fixture} from './stage7-v33-fixture.js';
import {makeDataset} from './fixtures.js';
import {startWebhookBackground} from '../src/bot/webhook.js';
import {createBusinessWebhookLifecycle} from '../src/businessWebhookLifecycle.js';
test('menu bootstrap starts without an incoming request, runs once and drains before the DB closes',async()=>{
 const order=[];let finish;const hold=new Promise(r=>{finish=r;});
 const life=createBusinessWebhookLifecycle({closeDatabase:async()=>order.push('closed')});
 assert.throws(()=>life.fork(()=>{}),{code:'TRANSITION_ACTIVE_PARENT_REQUIRED'});
 const run=()=>startWebhookBackground(life,null,{initialize:async()=>{order.push('begin');await hold;order.push('menus');}});
 run();run();await Promise.resolve();assert.deepEqual(order,['begin']);
 life.closeAdmission('e2_menu_shutdown_window');const disposed=life.dispose({signal:new AbortController().signal});
 assert.deepEqual(order,['begin']);finish();await disposed;assert.deepEqual(order,['begin','menus','closed']);
 const closed=createBusinessWebhookLifecycle({closeDatabase:async()=>{}});closed.closeAdmission('e2_closed_startup_window');
 assert.throws(()=>startWebhookBackground(closed,null,{initialize:async()=>{}}),{code:'TRANSITION_BUSINESS_ADMISSION_CLOSED'});
});
const locales=['zh-TW','en','vi'],now=()=>new Date('2026-11-03T07:10:00Z');
for(const locale of locales)test('private shortcuts bypass free text and preserve canonical routes: '+locale,async()=>{
 const user={id:'synthetic',status:'ACTIVE',timezone:'Asia/Taipei',lifecycleGeneration:1};
 const calls=[],sent=[],db={claimTelegramUpdate:async()=>({ok:true,state:'claimed'}),completeTelegramUpdate:async()=>true,markTelegramUpdateProcessing:async()=>true,getLocale:async()=>locale};
 const p=createUpdateProcessor({db,resolveUser:async()=>({user}),stage7Inbound:async()=>assert.fail('free-text Journal intercepted shortcut'),stage7Reply:async()=>assert.fail(),phase4JournalControl:async()=>assert.fail('Journal parser saw shortcut'),
  handleMessage:async({text,fixedLog})=>{calls.push([text,fixedLog]);return 'fixture';},sendReply:async o=>{sent.push(o.reply);return {sent:true,messageId:15};}});
 const keyboard=privateKeyboard(locale);
 assert.deepEqual([keyboard.is_persistent,keyboard.resize_keyboard,keyboard.one_time_keyboard],[true,true,false]);
 let seq=100;for(const {text} of keyboard.keyboard[0]){
  const msg={chat:{id:123,type:'private'},from:{id:123,is_bot:false},date:1,text:'  '+text+'  ',message_id:seq};
  await p.processUpdate({update_id:seq++,message:msg});
  await p.processUpdate({update_id:seq++,message:{...msg,chat:{id:-77,type:'group'}}});
  assert.equal(privateShortcut(text+'?'),null);
 }
 assert.deepEqual(calls,[['/energy',false],['/journal 7',true],['/settings',false]]);assert.deepEqual(sent,['fixture','fixture','fixture']);
 const query=await fixedJournal({db:{getLocale:async()=>locale,getJournalEvents:async(_,q)=>{assert.equal(q.from,'2026-10-28');assert.equal(q.to,'2026-11-03');return [];}},
  user,now:now()});assert.match(query,/^📝 [^\n]+\n\n.+/u);
});
test('exact localized chat menu, ordering and Owner-only command; changes are reconciled without sending messages',async()=>{
 const names='energy log journal settings healthdata insights predictions experiment cost status help'.split(' ');
 const expected=[['🔋 現在的 Body Energy','🩺 系統狀態','🛠 管理'],['🔋 Current Body Energy','🩺 System status','🛠 Admin'],['🔋 Body Energy hiện tại','🩺 Trạng thái hệ thống','🛠 Quản trị']];
 let locale='zh-TW',active=true,consented=true;const calls=[],user={id:'a',status:'ACTIVE',lifecycleGeneration:1};
 const enrollment={eligible:async()=>active&&consented,owners:()=>['a']},db={resolveUserByChatId:async()=>active?{user}:null,getLocale:async()=>locale,listActiveUsers:async()=>[user],getActiveChatIdForUser:async()=>'101'};
 const menus=createCommandMenus({db,enrollment,api:{setMyCommands:async v=>calls.push(v),deleteMyCommands:async v=>calls.push({...v,remove:true})}});
 assert.deepEqual(await menus.initialize(),{defaults:4,chats:1,failed:0});
 assert.deepEqual(calls.slice(0,4).map(v=>v.language_code??null),[null,'en','zh','vi']);
 assert.ok(calls.slice(0,4).every(v=>v.commands.map(c=>c.command).join()==='start,help'));
 for(const [i,l] of locales.entries()){locale=l;await menus.sync('101');const c=calls.at(-1);
  assert.deepEqual(c.scope,{type:'chat',chat_id:'101'});assert.equal(c.language_code,undefined);
  assert.deepEqual(c.commands.map(x=>x.command),[...names,'admin']);assert.deepEqual([c.commands[0],c.commands[9],c.commands.at(-1)].map(x=>x.description),expected[i]);
  assert.deepEqual(commandsFor(l).map(x=>x.command),names);}
 consented=false;assert.equal(await privateContext(db,'101','a',enrollment),null);active=false;
 await menus.sync('101',{remove:true});assert.deepEqual(calls.at(-1),{scope:{type:'chat',chat_id:'101'},remove:true});
 assert.equal(await privateContext(db,'-101','a',enrollment),null);
});
test('settings shortcut includes account actions; toggling signed preference preserves consent and rejects stale presses',async t=>{
 const {db,keys}=await syntheticStage7V33Fixture(t,{now});
 await db.saveTokens('a',{accessToken:'fixture',refreshToken:'fixture',expiresAt:new Date('2027-01-01'),whoopUserId:'fixture-a'});await db.linkTelegram({userId:'a',chatId:'101'});
 await db.setLocale('a','en');await db.ensureOnboarding('a',{state:'READY'});const user=await db.getUser('a');
 const e=createBetaEnrollment({db,keys,environment:{BETA_MAX_USERS:'7'},now});
 assert.equal(await privateContext(db,'101','a',e),null);
 const consent={version:DISCLAIMER_VERSION,at:now().toISOString()};await e.write('member','a',{invited:true,consent});
 const settings=createSettings({db,now}),account=createAccountSelfService({db,keys,erasure:{},now});
 const input={chatId:'101',user,text:privateShortcut('⚙️ Cài đặt')},view=await settings(input),decorated=await db.transaction(()=>account.decorate({...input,reply:view}));
 const labels=decorated.replyMarkup.inline_keyboard.flat().map(x=>x.text);
 for(const icon of ['🔌','🛑','🗑','🔋'])assert.ok(labels.some(x=>x.startsWith(icon)));
 const toggle=view.replyMarkup.inline_keyboard.flat().find(x=>x.text==='🔋 Scheduled energy: on');
 const click={...input,text:'',callback:{data:toggle.callback_data}};const off=await settings(click);
 assert.ok(off.replyMarkup.inline_keyboard.flat().some(x=>x.text==='🔋 Scheduled energy: off'));await settings(click);
 assert.equal(await timedEnergyEnabled(e,'a'),false);assert.deepEqual((await e.read('member','a')).consent,consent);
 // Actual scheduled Telegram wire: preserve every UTF-8 byte of the morning and leave inline cards untouched.
 const b=buildBriefing({...makeDataset({now:now()}),timezone:user.timezone,healthDate:'2026-11-03'}),text=renderDaily(b,null,{locale:'en'});
 let wire;const transport=createTelegram({db,chatId:'101',botToken:'fixture',fetchImpl:async(_url,opts)=>{wire=JSON.parse(opts.body);return Response.json({ok:true,result:{message_id:31,date:123,chat:{id:101,type:'private'}}});}});
 await transport.send(text);assert.ok(Buffer.from(wire.text).equals(Buffer.from(text)));assert.deepEqual(wire.reply_markup,privateKeyboard('en'));assert.equal(wire.disable_notification,undefined);
 assert.equal(attachKeyboard(decorated,{locale:'en'}),decorated);assert.equal(attachKeyboard(text,null),text);
});
