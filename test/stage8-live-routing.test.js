import test from 'node:test';
import assert from 'node:assert/strict';
import {createRouter} from '../src/bot/router.js';
import {stage8LivePresentationUnavailable} from '../src/stage8SelfQa.js';
import {handleInsights,handleEvidence} from '../src/bot/commands.js';
import {urgentReply} from '../src/bot/triage.js';

const user={id:'SYNTHETIC-READER',timezone:'UTC'},chatId='123';
const commands=['/insights live','/evidence live','/episodes','/insights LIVE history',
 '/evidence@Fixture_bot live','/episodes@Fixture_bot live history',
 '/insights live another-user','/evidence live SHADOW','/episodes another-user'];

test('explicit LIVE namespace stays unavailable in three locales when its runtime is disabled, without legacy/model reads',async()=>{
 for(const [locale,pattern]of[['zh-TW',/目前無法使用當期 LIVE/],['en',/Current LIVE analysis is unavailable/],['vi',/Hiện chưa thể xem phân tích LIVE/]]){
  let reads=0,models=0;
  const db={getLocale:async()=>locale,getActiveInsights:async()=>{reads++;throw Error('LEGACY_READ_FORBIDDEN');}};
  const router=createRouter({db,coachFor:()=>{models++;throw Error('MODEL_FORBIDDEN');}});
  for(const text of commands){const reply=await router.handle({text,chatId,user});assert.deepEqual(reply,{text:stage8LivePresentationUnavailable(locale)});assert.match(reply.text,pattern);assert.equal(reply.stage8ReplyGuard,undefined);}
  assert.equal(reads,0);assert.equal(models,0);
 }
});

test('enabled runtime refusing an authenticated actor cannot send the explicit LIVE request to legacy analysis',async()=>{
 let attempted=0,reads=0;
 const db={getLocale:async()=> 'en',getActiveInsights:async()=>{reads++;return [];}};
 const router=createRouter({db,coachFor:()=>assert.fail('legacy/model path'),stage8:{handle:async input=>{assert.equal(input.user,user);assert.equal(input.chatId,chatId);attempted++;return null;}}});
 for(const text of commands)assert.deepEqual(await router.handle({text,chatId,user}),{text:stage8LivePresentationUnavailable('en')});
 assert.equal(attempted,commands.length);assert.equal(reads,0);
});

test('authorized LIVE reply is delegated exactly once and its source/currentness guard is returned unchanged',async()=>{
 let calls=0;
 const reply={text:'SYNTHETIC verified projection',stage8ReplyGuard:{signature:'SYNTHETIC-NOT-AUTHORITY'}};
 const router=createRouter({db:{getLocale:async()=> 'en'},coachFor:()=>assert.fail('legacy/model path'),stage8:{handle:async input=>{assert.equal(input.text,'/insights live history');calls++;return reply;}}});
 assert.equal(await router.handle({text:'/insights live history',chatId,user}),reply);assert.equal(calls,1);
});

test('bare legacy insights/history/evidence and explicit SHADOW forms retain their existing separate handlers',async()=>{
 let history=0,shadow=0;
 const db={getLocale:async()=> 'en',getActiveInsights:async()=>[{id:3,subject:'caffeine_vs_hrv',status:'SUPPORTED',effect_size:-0.2,sample_count:20,version:2,supersedes_id:2}],getInsightHistory:async()=>{history++;return [{version:2,status:'SUPPORTED'},{version:1,status:'EMERGING'}];}};
 const phase4Reply={text:'SYNTHETIC separate SHADOW projection'};
 const router=createRouter({db,coachFor:()=>({}),stage8:{handle:async()=>null},phase4Reader:{handle:async()=>{shadow++;return phase4Reply;}}});
 for(const [text,argsText]of[['/insights',''],['/insights history','history']])assert.equal(await router.handle({text,chatId,user}),await handleInsights({db,userId:user.id,argsText,locale:'en'}));
 assert.equal(history,2);
 const at=new Date('2026-10-20T00:00:00Z'),fixed=createRouter({db,coachFor:()=>({}),now:()=>at});
 assert.equal(await fixed.handle({text:'/evidence',chatId,user}),await handleEvidence({db,userId:user.id,locale:'en',now:at}));
 for(const text of['/insights phase4','/evidence phase4'])assert.equal(await router.handle({text,chatId,user}),phase4Reply);
 assert.equal(shadow,2);
});

test('urgent symptoms retain priority over an explicit malformed LIVE command',async()=>{
 const router=createRouter({db:{getLocale:async()=> 'en'},coachFor:()=>assert.fail('model path'),stage8:{handle:async()=>assert.fail('LIVE reader path')}});
 assert.equal(await router.handle({text:'/insights live 我現在胸痛而且呼吸困難',chatId,user}),urgentReply('en'));
});
