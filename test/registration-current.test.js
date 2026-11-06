import test from 'node:test';import assert from 'node:assert/strict';
import {registrationMode,registrationClosedReply} from '../src/registrationPolicy.js';
import {resolveOrCreateUser,handleUnlinkedMessage} from '../src/onboarding.js';
import {createUpdateProcessor} from '../src/bot/updateProcessor.js';
import {urgentReply} from '../src/bot/triage.js';
function closed(t){const previous=process.env.REGISTRATION_MODE;process.env.REGISTRATION_MODE='closed';t.after(()=>{if(previous===undefined)delete process.env.REGISTRATION_MODE;else process.env.REGISTRATION_MODE=previous;});}
const update=(text,language_code='en')=>({update_id:1,message:{chat:{id:123,type:'private'},from:{id:123,language_code},text}});
test('registration defaults closed; invalid and invite modes fail closed until supported',()=>{
 for(const value of [undefined,'','invalid'])assert.equal(registrationMode({REGISTRATION_MODE:value}),'closed');
 for(const value of ['closed','invite','open'])assert.equal(registrationMode({REGISTRATION_MODE:value}),value);
});
for(const lang of ['zh-TW','vi','en','de'])test(`new ${lang} chat: no user, binding, receipt, OAuth, LLM or other database writes`,async t=>{
 closed(t);const sent=[];
 const db=new Proxy({getTelegramLink:async()=>null},{get:(o,k)=>k in o?o[k]:(()=>assert.fail(`unexpected DB access ${String(k)}`))});
 const p=createUpdateProcessor({db,resolveUser:async()=>null,handleUnlinked:()=>assert.fail('onboarding'),handleMessage:()=>assert.fail('LLM'),sendReply:async x=>{sent.push(x.reply);return {sent:true,messageId:101};}});
 for(const text of ['/start','hello','/connect'])assert.equal((await p.processUpdate(update(text,lang))).outcome,'processed');
 const photo=update(undefined,lang);photo.message.photo=[{}];await p.processUpdate(photo);
 assert.deepEqual(sent,Array(4).fill(registrationClosedReply(update('',lang).message)));
});
test('new chat emergency still wins without any database writes',async t=>{
 closed(t);const sent=[];
 const p=createUpdateProcessor({db:{getTelegramLink:async()=>null},resolveUser:async()=>null,handleUnlinked:()=>assert.fail('onboarding'),sendReply:async x=>{sent.push(x.reply);return {sent:true,messageId:101};}});
 await p.processUpdate(update('我不是没有胸痛','zh-TW'));assert.deepEqual(sent,[{text:urgentReply('en')}]);
});
test('resolve/create defense rejects new accounts but preserves bound users',async t=>{
 closed(t);const db={resolveUserByChatId:async()=>null,getTelegramLink:async()=>null,createUser:()=>assert.fail('create')};
 assert.equal((await resolveOrCreateUser({db,chatId:'123'})).blocked,'registration_closed');
 const user={id:'existing',status:'ACTIVE'};db.resolveUserByChatId=async()=>({user});db.ensureOnboardingDerived=async()=>({state:'READY'});
 assert.deepEqual((await resolveOrCreateUser({db,chatId:'123'})).user,user);
 assert.deepEqual(await handleUnlinkedMessage({db,text:'/start',chatId:'123',message:update('').message,isPrivateChat:true}),registrationClosedReply(update('').message));
});
test('existing account retains the original handler and receipt path',async t=>{
 closed(t);let handled=0,claimed=0;const sent=[];
 const db={claimTelegramUpdate:async()=>{claimed++;return {state:'claimed'};},markTelegramUpdateProcessing:async()=>true,completeTelegramUpdate:async()=>true};
 const p=createUpdateProcessor({db,resolveUser:async()=>({user:{id:'existing'}}),handleMessage:async()=>{handled++;return 'existing reply';},sendReply:async x=>{sent.push(x.reply);return {sent:true,messageId:101};}});
 assert.equal((await p.processUpdate(update('/start'))).outcome,'processed');assert.equal(handled,1);assert.equal(claimed,1);assert.deepEqual(sent,['existing reply']);
});
