import test from 'node:test';
import assert from 'node:assert/strict';
import {selfQueryPerspective} from '../src/scopedHealthContext.js';
import {bodyEnergyQueryPage} from '../src/bodyEnergyPresentation.js';
import {createBodyEnergyRuntime} from '../src/bodyEnergyRuntime.js';
import {createRouter} from '../src/bot/router.js';
import {createStage8Runtime} from '../src/stage8Runtime.js';
import {stage8Fixture} from './stage8Fixture.js';

const valid=['/energy sources 1','/energy sources 2','/energy@Synthetic_Bot SOURCES 099','  /energy\tsources\t999  '];
const invalid=['/energy sources','/energy sources 0','/energy sources -1','/energy sources 1000',
 '/energy sources 1.5','/energy sources 1 b','/energy sources 1 LIVE','/energy sources 1 user b',
 '/energy@bad-mention sources 1','/energy sources 1 for my friend','/energy sources 1 for someone',
 '/energy sources 1 if I exercise','/energy sources 1 can people use this?'];
const noModel=()=>{throw Error('SYNTHETIC_LEGACY_FALLTHROUGH');};

test('existing strict Body source-page grammar is self-positive without upgrading third/general/extra arguments',()=>{
 for(const text of valid){assert.notEqual(bodyEnergyQueryPage(text),null,text);assert.equal(selfQueryPerspective({text}).usePersonalData,true,text);}
 for(const text of invalid){assert.equal(bodyEnergyQueryPage(text),null,text);assert.equal(selfQueryPerspective({text}).usePersonalData,false,text);}
 assert.equal(selfQueryPerspective({text:'/energy sources 1',signals:{aboutSelf:false}}).usePersonalData,false);
 for(const text of ['/energy sources 1 for me','/energy sources 1 我自己的資料'])assert.equal(bodyEnergyQueryPage(text),null,'ordinary first-person language cannot change the registered page grammar');
});

test('legacy router reaches the existing qualification-pending Body page in each locale, without publishing a number',async t=>{
 const f=await stage8Fixture(t),runtime=await createBodyEnergyRuntime({...f,environment:{},env:f.env,now:f.now});
 const body=runtime.bodyEnergy,accepted=[],wrapped={...body,query:async request=>{const result=await body.query(request);if(result)accepted.push(request);return result;}};
 const router=createRouter({db:f.db,bodyEnergy:wrapped,coachFor:noModel,now:f.now});
 for(const [locale,word] of [['zh-TW',/尚待真實資料品質/],['en',/awaiting genuine-data quality/],['vi',/đang chờ xác minh/]]){
  await f.db.setLocale('a',locale);
  for(const text of valid){
   const reply=await router.handle({...f.input,text});assert.match(reply.reply,word,text);assert.doesNotMatch(reply.reply,/\d+\/100/);
   assert.equal(reply.bodyEnergyReplyGuard.status,'QUALIFICATION_PENDING');
   assert.equal(await body.verifyReplyGuard(reply.bodyEnergyReplyGuard,'a'),true);
   assert.equal(accepted.at(-1).userId,'a');
  }
 }
 assert.equal(accepted.length,valid.length*3);
 for(const text of [...invalid,'/energy sources 1 for me']){
  await assert.rejects(router.handle({...f.input,text}),/SYNTHETIC_LEGACY_FALLTHROUGH/);
 }
 assert.equal(accepted.length,valid.length*3);
 assert.equal((await f.db.raw.execute('SELECT count(*) n FROM outbound_messages')).rows[0].n,0);
 assert.equal(runtime.publicationQualified,false);
});

test('Stage8 real router preserves the registered Body source-page route and rejects extra subject/mode arguments',async t=>{
 const f=await stage8Fixture(t),runtime=await createBodyEnergyRuntime({...f,environment:{},env:f.env,now:f.now});
 const body=runtime.bodyEnergy,accepted=[],wrapped={...body,query:async request=>{const result=await body.query(request);if(result)accepted.push(request);return result;}};
 const stage8=await createStage8Runtime({...f,environment:f.environment,env:f.env,bodyEnergy:wrapped,now:f.now}),router=createRouter({db:f.db,stage8,bodyEnergy:wrapped,coachFor:noModel,now:f.now});
 for(const [locale,word] of [['zh-TW',/尚待真實資料品質/],['en',/awaiting genuine-data quality/],['vi',/đang chờ xác minh/]]){
  await f.db.setLocale('a',locale);
  for(const text of valid){
   const reply=await router.handle({...f.input,text});assert.match(reply.text,word,text);assert.doesNotMatch(reply.text,/\d+\/100/);
   assert.equal(reply.stage8BodyEnergyGuard.qualified,false);assert.ok(reply.stage8ReplyGuard);
   const sent=await stage8.sendReply(async input=>({sent:await input.beforeSend()}),{userId:'a',chatId:'123',reply});
   assert.equal(sent.sent,true);
  }
 }
 const reads=(await f.db.raw.execute('SELECT count(*) n FROM stage8_scoped_read_audit')).rows[0].n;
 assert.equal(reads,valid.length*3);
 for(const text of invalid){
  try{await router.handle({...f.input,text});}catch(error){assert.equal(error.message,'SYNTHETIC_LEGACY_FALLTHROUGH');}
 }
 assert.equal(accepted.length,0,'dedicated LIVE bridge does not invoke legacy SHADOW query');
 assert.equal((await f.db.raw.execute('SELECT count(*) n FROM stage8_scoped_read_audit')).rows[0].n,reads);
 assert.equal((await f.db.raw.execute('SELECT count(*) n FROM outbound_messages')).rows[0].n,0);
 assert.equal((await f.db.raw.execute("SELECT count(*) n FROM phase4_computation_state WHERE execution_mode='LIVE'")).rows[0].n,0);
 assert.equal(runtime.publicationQualified,false);
});
