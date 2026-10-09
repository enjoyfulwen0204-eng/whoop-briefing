import test from 'node:test';import assert from 'node:assert/strict';
import {deliveryFixture} from './deliveryDefaultFixture.js';
import {handleOnboardingMessage,handleLocaleOnlyMessage} from '../src/onboarding.js';
for(const path of ['onboarding','locale-only'])test(`READY user may explicitly choose each locale through existing ${path} flow without resetting identity`,async t=>{
 const {db}=await deliveryFixture(t);await db.admitRuntime();await db.createUser({id:'alice',displayName:'Alice',status:'ACTIVE',timezone:'Asia/Taipei'});await db.linkTelegram({userId:'alice',chatId:'1001'});await db.setLocale('alice','zh-TW');await db.ensureOnboarding('alice',{state:'READY'});
 await db.saveTokens('alice',{accessToken:'synthetic',refreshToken:'synthetic',expiresAt:new Date(Date.now()+3600000),whoopUserId:'12345'});
 const user=await db.getUser('alice'),before=await db.getOnboarding('alice'),tokens=await db.getTokens('alice');
 const handle=path==='onboarding'?handleOnboardingMessage:handleLocaleOnlyMessage;
 for(const [text,locale] of [['English','en'],['Tiếng Việt','vi'],['繁體中文','zh-TW']]){const reply=await handle({db,user,text,clientId:'synthetic',redirectUri:'https://isolated.invalid/callback'});assert.equal(await db.getLocale('alice'),locale);assert.doesNotMatch(reply,/Kelvin|Body Energy/);}
 assert.deepEqual(await db.getUser('alice'),user);assert.deepEqual(await db.getOnboarding('alice'),before);assert.deepEqual(await db.getTokens('alice'),tokens);
 assert.equal(await handle({db,user,text:'/not-a-language'}),null);
});
