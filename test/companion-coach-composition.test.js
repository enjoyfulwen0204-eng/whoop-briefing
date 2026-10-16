import test from 'node:test';
import assert from 'node:assert/strict';
import {stage8Fixture} from './stage8Fixture.js';
import {createStage7Runtime} from '../src/stage7Runtime.js';
import {createStage8Runtime} from '../src/stage8Runtime.js';
import {createCompanionCoachContext} from '../src/companionCoachContext.js';
import {createStage7PresentationSender} from '../src/stage7PresentationSender.js';
import {createStage8PresentationSender} from '../src/stage8PresentationSender.js';

test('composed Coach callbacks carry both authorities and cannot send after the scoped reader is disabled',async t=>{
 const f=await stage8Fixture(t);let stage8;
 const coachContext=createCompanionCoachContext({getScopes:()=>stage8?.scopes});
 const stage7=await createStage7Runtime({...f,environment:{STAGE7_COMPANION:'on',STAGE7_COMPANION_USER_IDS:'a',PHASE4_BETA_PILOT_USER_ID:'a'},env:f.env,coachContext,now:f.now});
 stage8=await createStage8Runtime({...f,environment:f.environment,env:f.env,stage7,now:f.now});
 let sends=0;
 const base=async input=>{assert.equal(await input.beforeSend(),true);sends++;return {sent:true,messageId:44};};
 const sender=createStage8PresentationSender(stage8,createStage7PresentationSender(stage7,base));
 let reply,updateId=100;
 async function handle(extra){
  const input={...f.input,updateId:updateId++,...extra},handled=await stage7.stage7Inbound(input);
  assert.ok(handled);reply=await stage7.stage7Reply({...input,reply:handled.reply});
  return sender({userId:'a',chatId:'123',reply});
 }
 assert.equal((await handle({text:'/coach'})).sent,true);
 async function tap(index){
  const button=reply.replyMarkup.inline_keyboard.flat()[index];assert.ok(button);
  return handle({callback:{id:'synthetic-'+updateId,data:button.callback_data,from:{id:123,is_bot:false},message:{message_id:44,chat:{id:123,type:'private'}}}});
 }
 assert.equal((await tap(1)).sent,true);
 assert.equal((await tap(4)).sent,true);
 assert.ok(reply.stage7ReplyGuard);assert.ok(reply.stage7CoachContextGuard);
 assert.match(reply.text,/No verified current analysis/);
 const current=sends;
 stage8=null;
 assert.equal((await sender({userId:'a',chatId:'123',reply})).sent,false);assert.equal(sends,current);
 const off=createStage7PresentationSender(null,base);
 assert.equal((await off({userId:'a',chatId:'123',reply})).sent,false);assert.equal(sends,current);
});
