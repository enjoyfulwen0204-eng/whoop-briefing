import {fileURLToPath} from 'node:url';
import test from 'node:test';import assert from 'node:assert/strict';
const root=fileURLToPath(new URL('../..',import.meta.url));
const {stage8Fixture}=await import(root+'/test/stage8Fixture.js');const {createStage8Runtime}=await import(root+'/src/stage8Runtime.js');
test('Twelve enabled subscriptions are all visited across runtime restart with six per tick',async t=>{
 const f=await stage8Fixture(t,{owner:true});t.mock.method(globalThis,'fetch',()=>new Response(JSON.stringify({ok:false,error_code:429,description:'Synthetic'}),{status:429}));
 for(const [id,chat] of [['c','789'],['d','987'],['e','654']]){await f.db.createUser({id,displayName:'Synthetic',timezone:'Asia/Taipei',status:'ACTIVE'});await f.db.linkTelegram({userId:id,chatId:chat,now:f.now()});await f.db.ensureOnboarding(id,{state:'READY'});await f.db.saveTokens(id,{accessToken:'SYNTHETIC_NOT_A_TOKEN',refreshToken:'SYNTHETIC_NOT_A_TOKEN',expiresAt:new Date('2026-12-01'),scope:'offline',whoopUserId:'synthetic-'+id},{now:f.now(),bumpAuthGeneration:true});}
 for(const subjectId of ['b','c','d','e'])for(const notificationClass of ['DAILY_SUMMARY','WEEKLY_SUMMARY','IMPORTANT_ALERT'])await f.app.owner.configure(f.input,{subjectId,notificationClass,enabled:true,expectedRevision:0,operationKey:'fairness-'+subjectId+notificationClass});
 const first=await f.app.owner.tick(f.input),next=await createStage8Runtime({...f,now:f.now}),second=await next.owner.tick(f.input),third=await next.owner.tick(f.input);
 assert.equal(first.checked,6);assert.equal(second.checked,6);assert.equal(third.checked,6);const keys=r=>r.results.map(v=>v.subjectId+v.notificationClass);assert.equal(new Set([...keys(first),...keys(second)]).size,12);assert.deepEqual(keys(first),keys(third));
 console.log('FAIRNESS_PROBE',JSON.stringify({first:keys(first),second:keys(second),third:keys(third),allVisited:12,bound:6}));
});
