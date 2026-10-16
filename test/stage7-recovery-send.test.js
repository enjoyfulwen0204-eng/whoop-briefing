import test from 'node:test';
import assert from 'node:assert/strict';
import {syntheticPhase4Fixture} from './phase4Fixture.js';
import {createStage7Runtime} from '../src/stage7Runtime.js';
import {createStage7PresentationSender} from '../src/stage7PresentationSender.js';
import {createStage5PresentationSender} from '../src/stage5PresentationReader.js';

test('a persisted authentic Coach card cannot escape its runtime on feature-off recovery, while ordinary replies remain available',async t=>{
 const f=await syntheticPhase4Fixture(t,{targetVersion:33,now:()=>new Date()});
 await f.db.linkTelegram({userId:'a',chatId:'123'});
 await f.db.saveTokens('a',{accessToken:'synthetic',refreshToken:'synthetic',expiresAt:new Date('2027-01-01'),scope:'offline',whoopUserId:'synthetic'});
 await f.db.ensureOnboarding('a',{state:'READY'});
 const runtime=await createStage7Runtime({...f,env:{telegramBotToken:'SYNTHETIC_NOT_A_TOKEN'},environment:{STAGE7_COMPANION:'on',STAGE7_COMPANION_USER_IDS:'a',PHASE4_BETA_PILOT_USER_ID:'a'}});
 const user=await f.db.getUser('a'),input={user,chatId:'123'},inbound=await runtime.stage7Inbound({...input,text:'/coach',updateId:'saved-recovery-card'}),reply=JSON.parse(JSON.stringify(await runtime.stage7Reply({...input,reply:inbound.reply})));
 assert.ok(reply.stage7ReplyGuard);assert.ok(reply.stage7InteractionId);
 let sends=0;const base=async value=>{if(value.beforeSend&&!await value.beforeSend())return {sent:false};sends++;return {sent:true,messageId:101};};
 const off=createStage7PresentationSender(null,createStage5PresentationSender(null,base));
 assert.equal((await off({userId:'a',chatId:'123',reply})).sent,false);assert.equal(sends,0);
 assert.equal((await off({userId:'a',chatId:'123',reply:'ordinary'})).sent,true);assert.equal(sends,1);
 assert.equal((await off({reply:{text:'saved analysis',stage5PresentationGuard:{signature:'saved'}}})).sent,false);assert.equal(sends,1);
 const on=createStage7PresentationSender(runtime,base);
 assert.equal((await on({userId:'a',chatId:'123',reply,beforeSend:async()=>false})).sent,false);assert.equal(sends,1);
 let checks=0;
 assert.equal((await on({userId:'a',chatId:'123',reply,beforeSend:async()=>++checks===1})).sent,false);
 assert.equal(checks,2,'the prior authority is rechecked at actual send, not only before projection');assert.equal(sends,1);
 for(const field of ['stage7View','stage7InteractionId','stage7ReplyGuard','stage7CoachContextGuard'])assert.equal((await off({reply:{text:'saved', [field]:'opaque'}})).sent,false);
 assert.equal(sends,1);
});
