import test from 'node:test';
import assert from 'node:assert/strict';
import {syntheticStage7V33Fixture} from './stage7-v33-fixture.js';
import {createAccountSelfService,revokeWhoopAccess} from '../src/accountSelfService.js';
import {createUpdateProcessor} from '../src/bot/updateProcessor.js';
import {createFamilySharing} from '../src/familySharing.js';
import {createWhoopClient} from '../src/whoop.js';
import {handleOnboardingMessage} from '../src/onboarding.js';
const now=()=>new Date('2026-11-01T06:00:00Z');
async function setup(t,{remote=true}={}){
 const f=await syntheticStage7V33Fixture(t,{now});
 for(const [id,chat] of [['a','101'],['b','102']]){await f.db.saveTokens(id,{accessToken:'SYNTHETIC_ACCESS',refreshToken:'SYNTHETIC_REFRESH',expiresAt:new Date('2027-01-01'),whoopUserId:'synthetic-'+id});await f.db.linkTelegram({userId:id,chatId:chat,now:now()});await f.db.setLocale(id,'zh-TW');await f.db.ensureOnboarding(id,{state:'READY',now:now()});}
 const family=createFamilySharing({db:f.db,keys:f.keys,environment:{FAMILY_SHARING:'on',FAMILY_GROUP_USER_IDS:'a,b'},now,send:()=>{throw Error('NO_SEND');}});
 let calls=0;const control=createAccountSelfService({db:f.db,keys:f.keys,family,now,revoke:async token=>{assert.equal(token,'SYNTHETIC_ACCESS');calls++;return remote;}});
 const user=await f.db.getUser('a'),input={user,chatId:'101'},sent=[];
 const processor=createUpdateProcessor({db:f.db,now,accountControl:control,resolveUser:id=>f.db.resolveUserByChatId(id),handleMessage:()=>{throw Error('NO_HEALTH');},sendReply:control.wrapSender(async x=>{sent.push(x);return {sent:true,messageId:80};}),answerCallback:async()=>{}});
 let n=1;
 async function click(reply,action){const button=reply.replyMarkup.inline_keyboard.flat().find(b=>b.callback_data.endsWith('.'+action));assert.ok(button,action);const update={update_id:n++,callback_query:{id:'callback'+n,data:button.callback_data,from:{id:101},message:{message_id:80,chat:{id:101,type:'private'}}}};const result=await processor.processUpdate(update);assert.equal(result.outcome,'processed');return sent.at(-1)?.reply;}
 return {...f,family,control,input,click,sent,calls:()=>calls,open:async()=>{const reply=await f.db.transaction(()=>control.decorate({...input,text:'/settings',reply:{text:'settings'}}));await control.wrapSender(async()=>({sent:true,messageId:80}))({reply});return reply;}};
}
test('disconnect is durable through real receipt root; remote failure still erases tokens, fences auth, preserves rows and reconnects',async t=>{
 const f=await setup(t,{remote:false});const before=await f.db.getTokens('a');let view=await f.open();view=await f.click(view,'disconnect');view=await f.click(view,'confirm');
 assert.match(view.text,/WHOOP 那邊可能還保留授權/);const after=await f.db.getTokens('a');assert.equal(after.accessToken,'');assert.equal(after.refreshToken,'');assert.equal(after.authGeneration,before.authGeneration+1);assert.equal((await f.db.getOnboarding('a')).failureCode,'REAUTH_REQUIRED');assert.equal((await f.db.getUser('a')).status,'ACTIVE');assert.equal(f.calls(),1);
 const reconnect=await f.db.transaction(()=>handleOnboardingMessage({db:f.db,user:f.input.user,text:'/connect',clientId:'synthetic',redirectUri:'https://example.invalid/callback',now:now()}));assert.ok(reconnect);
 assert.equal(Number((await f.db.raw.execute("SELECT count(*) n FROM user_whoop_tokens WHERE user_id='a'")).rows[0].n),1);
});
test('deactivation requires two confirmations, revokes both sharing directions and link, retains records, repeat is safe',async t=>{
 const f=await setup(t);const rows=await f.family.store.members();for(const [a,b] of [[0,1],[1,0]])await f.db.transaction(()=>f.family.store.change({actor:rows[a],peer:rows[b],kind:'grant',category:'daily',value:true}));
 let view=await f.open();view=await f.click(view,'stop');assert.equal((await f.db.getUser('a')).status,'ACTIVE');view=await f.click(view,'confirm');assert.equal((await f.db.getUser('a')).status,'ACTIVE');const finalButton=view.replyMarkup.inline_keyboard[0][0];view=await f.click(view,'final');assert.match(view.text,/已停用/);
 assert.equal((await f.db.getUser('a')).status,'DISABLED');assert.equal(await f.db.resolveUserByChatId('101'),null);assert.ok(Object.values((await f.family.store.state()).grants).every(g=>!g.daily&&!g.alert&&!g.weekly));
 assert.equal(Number((await f.db.raw.execute("SELECT count(*) n FROM user_telegram WHERE user_id='a'")).rows[0].n),1);
 const repeated=await f.db.transaction(()=>f.control.handle({...f.input,callback:{data:finalButton.callback_data}}));assert.match(repeated.text,/失效/);assert.equal(f.calls(),1);
});
test('all account buttons have emoji in all locales; old/cross-chat callbacks cannot mutate',async t=>{
 const f=await setup(t);for(const locale of ['zh-TW','en','vi']){await f.db.setLocale('a',locale);const view=await f.open();for(const b of view.replyMarkup.inline_keyboard.flat())assert.match(b.text,/^\p{Extended_Pictographic}/u);const result=await f.db.transaction(()=>f.control.handle({...f.input,chatId:'102',callback:{data:view.replyMarkup.inline_keyboard[0][0].callback_data}}));assert.ok(result.text);assert.equal(f.calls(),0);}
});
test('official revoke uses only fixed endpoint, bounded DELETE, no response payload and fail-safe result',async()=>{
 let called=0;assert.equal(await revokeWhoopAccess('SYNTHETIC',{fetchImpl:async(url,opts)=>{called++;assert.equal(url,'https://api.prod.whoop.com/developer/v2/user/access');assert.equal(opts.method,'DELETE');assert.ok(opts.signal);return {ok:true};}}),true);assert.equal(called,1);assert.equal(await revokeWhoopAccess('SYNTHETIC',{fetchImpl:async()=>{throw Error('private');}}),false);
});
test('disconnect shows only white family placeholder; never loads health history or sends to disconnected recipient',async t=>{
 const f=await setup(t),rows=await f.family.store.members();await f.db.transaction(()=>f.family.store.change({actor:rows[0],peer:rows[1],category:'daily',kind:'grant',value:true}));
 let view=await f.open();view=await f.click(view,'disconnect');await f.click(view,'confirm');
 const current=await f.family.store.members(),state=await f.family.store.state();assert.equal(current.find(r=>r.id==='a').connected,0);assert.equal(f.family.store.allowed(state,current,'a','b','daily'),true);assert.equal(f.family.store.allowed(state,current,'a','b','alert'),false);
 let reads=0,sent=[];const family=createFamilySharing({db:f.db,keys:f.keys,environment:{FAMILY_SHARING:'on',FAMILY_GROUP_USER_IDS:'a,b'},now,send:async x=>{sent.push(x);return {message_id:99};}});
 t.mock.method(f.db,'getSleeps',()=>{reads++;throw Error('NO_HISTORY');});t.mock.method(f.db,'getRecoveries',()=>{reads++;throw Error('NO_HISTORY');});
 await family.tick();assert.equal(reads,0);assert.equal(sent.length,1);assert.match(sent[0].reply.text,/⚪/);assert.equal(sent[0].chatId,'102');
});

test('cleared tokens cannot refresh or call WHOOP, even through an existing client',async t=>{
 const f=await setup(t);let calls=0;const client=createWhoopClient({db:f.db,userId:'a',clientId:'synthetic',clientSecret:'synthetic',expectedLifecycleGeneration:f.input.user.lifecycleGeneration,fetchImpl:()=>{calls++;throw Error('FORBIDDEN');}});
 let view=await f.open();view=await f.click(view,'disconnect');await f.click(view,'confirm');
 await assert.rejects(client.apiGet('/user/profile/basic'),/WHOOP/);assert.equal(calls,0);
});
