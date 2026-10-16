import test from 'node:test';import assert from 'node:assert/strict';
import {syntheticPhase4Fixture} from './phase4Fixture.js';
import {createStage7Runtime} from '../src/stage7Runtime.js';
import {fixtureKeys} from './localDb.js';
import {createSendReply} from '../src/bot/index.js';
const environment={STAGE7_COMPANION:'on',STAGE7_COMPANION_USER_IDS:'a',PHASE4_BETA_PILOT_USER_ID:'a'};
async function fixture(t){
 let at=Date.parse('2026-09-19T00:00:00Z');const f=await syntheticPhase4Fixture(t,{targetVersion:33,now:()=>new Date(at)});
 await f.db.linkTelegram({userId:'a',chatId:'123',now:f.core.now()});await f.db.setLocale('a','en',{now:f.core.now()});
 const app=await createStage7Runtime({db:f.db,keys:fixtureKeys,environment,env:{telegramBotToken:'SYNTHETIC_NOT_A_TOKEN'},now:f.core.now}),user=await f.db.getUser('a'),input={user,chatId:'123',text:'/coach',updateId:1};
 const inbound=await app.stage7Inbound(input),reply=await app.stage7Reply({...input,reply:inbound.reply});
 return {...f,app,user,reply,setTime:value=>{at=value;},input:{userId:'a',chatId:'123',reply,expectedLifecycleGeneration:1}};
}
for(const change of ['profile_ABA','locale_ABA','expiry','revision','source_generation','purge_generation','reply_tampering','additional_row_revision'])test(`persisted card suppresses ${change} before any send and without issuing replacement tokens`,async t=>{
 const f=await fixture(t);let reply=f.reply;
 if(change==='additional_row_revision'){
  const actor=await f.app.companion.interactions.authenticate({user:f.user,chatId:'123'});
  // A second signed row is exercised through the actual Journal confirmation path.
  const row=await f.app.companion.interactions.issue(actor,{category:'alcohol',targetDate:'2026-09-18'});
  await f.db.raw.execute({sql:"UPDATE quick_action_interactions SET state='COMPLETED' WHERE interaction_id=?",args:[row.row.interaction_id]});
  reply=await f.app.stage7Reply({user:f.user,chatId:'123',reply:{stage7InteractionId:row.row.interaction_id,stage7Revision:0}});
  await f.db.raw.execute({sql:'UPDATE quick_action_interactions SET revision=revision+1 WHERE interaction_id=?',args:[reply.stage7AdditionalInteractionId]});
 }
 if(change==='profile_ABA'){await f.db.updateUser('a',{displayName:'changed'});await f.db.updateUser('a',{displayName:f.user.displayName});}
 if(change==='locale_ABA'){await f.db.setLocale('a','vi');await f.db.setLocale('a','en');}
 if(change==='expiry')f.setTime(f.core.now().getTime()+16*60000);
 if(change==='revision')await f.db.raw.execute({sql:'UPDATE quick_action_interactions SET revision=revision+1 WHERE interaction_id=?',args:[reply.stage7InteractionId]});
 if(change==='source_generation'||change==='purge_generation')await f.db.raw.execute(`UPDATE phase4_user_state SET ${change}=${change}+1 WHERE user_id='a'`);
 if(change==='reply_tampering')reply={...reply,text:'changed projection'};
 const before=(await f.db.raw.execute('SELECT count(*) n FROM journal_callback_tokens')).rows[0].n;let sends=0;
 const result=await f.app.sendReply(async()=>{sends++;return {sent:true,messageId:1};},{...f.input,reply:JSON.parse(JSON.stringify(reply))});
 assert.equal(result.sent,false);assert.equal(sends,0);assert.equal((await f.db.raw.execute('SELECT count(*) n FROM journal_callback_tokens')).rows[0].n,before);
});
test('production provider boundary checks again after the generic snapshot await',async t=>{
 const f=await fixture(t);let sends=0;
 t.mock.method(f.db,'assertTelegramReplySnapshot',async()=>{await f.db.updateUser('a',{displayName:'ABA'});await f.db.updateUser('a',{displayName:f.user.displayName});return true;});
 const send=createSendReply({db:f.db,api:{sendMessage(){sends++;return {message_id:1};}}});
 const result=await f.app.sendReply(send,{...f.input,updateId:1});assert.equal(result.sent,false);assert.equal(sends,0);
});
