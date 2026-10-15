import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {syntheticPhase4Fixture} from './phase4Fixture.js';import {bodyInput,seedBodyInput} from './bodyEnergyFixture.js';
import {runForUser} from '../src/index.js';import {runExecutionPhase} from '../src/phase4Execution.js';
import {configurationProof} from '../src/phase4ExecutionStore.js';import {runningReleaseSha} from '../src/phase4Release.js';
test('actual canonical runForUser records its genuine completed SYNC subject and finalized wrapper starts separate LIVE',async t=>{
 const f=await syntheticPhase4Fixture(t,{targetVersion:35,now:()=>new Date()});await f.db.transaction(()=>seedBodyInput(f.db,bodyInput({asOf:Date.now()-1000,days:0})));
 await f.db.ensureOnboarding('a',{state:'READY'});await f.db.linkTelegram({userId:'a',chatId:'10001'});await f.db.setLocale('a','en');
 for(const resource of ['sleep','recovery','cycle','workout'])await f.db.saveSyncState('a',resource,{backfillComplete:true,lastSuccessAt:new Date(Date.now()-3600000).toISOString()});
 const environment={PHASE4_BETA_SHADOW_RUNTIME:'off',PHASE4_PUBLIC_BETA_MODE:'off',PHASE4_STAGE8_RUNTIME:'on',PHASE4_BETA_PILOT_USER_ID:'a',STAGE8_USER_IDS:'a',STAGE8_LIVE_ANALYSIS:'on',STAGE8_POST_SYNC:'on'},env={dryRun:true,timezone:'Asia/Taipei',telegramBotToken:'SYNTHETIC_NOT_A_TOKEN'};
 const request={phase:'SYNC',triggerSource:'manual',requestId:randomUUID(),releaseSha:runningReleaseSha(),executionMode:'OFF',configProof:configurationProof(f.keys,{runtime:'off',mode:'off'},environment)};let providerCalls=0,sends=0;
 const empty=async()=>{providerCalls++;assert.equal(f.db.processingTransactionActive(),false);return [];};
 const response=await runExecutionPhase({...f,keys:f.keys,request,environment,env,deps:{runBriefing:async({deps})=>{
  const out=await runForUser({db:f.db,env,user:await f.db.getUser('a'),now:new Date(),deps:{...deps,
   makeWhoop:()=>({getAccessToken:async()=>'SYNTHETIC',sleeps:empty,recoveries:empty,cycles:empty,workouts:empty,bodyMeasurement:async()=>{providerCalls++;return {};}}),
   makeTelegram:()=>({send:async()=>{sends++;throw Error('REAL_SEND_FORBIDDEN');},notifyError:async()=>false}),
   daily:async()=>({status:'not_ready'}),weekly:async()=>({status:'not_ready'}),proactive:async()=>({triggered:false}),reap:async()=>({}),predictionCycle:async()=>({}),healthspan:async()=>({}),
  }});console.log('CANONICAL_SYNTHETIC_USER_OUTCOME',JSON.stringify({complete:out.sync?.complete,errors:out.errors}));assert.equal(out.sync?.complete,true);
  return {syncComplete:out.sync.complete,syncOutcome:out.sync.outcome,users:1,failed:0};
 }}});
 assert.equal(response.status,200);assert.equal(response.body.syncComplete,true);assert.equal(response.body.drainAuthorized,false);assert.equal(sends,0);assert.ok(providerCalls>=5);
 assert.equal((await f.db.raw.execute("SELECT count(*) n FROM telegram_state WHERE key LIKE 'stage8:sync-subject:%'")).rows[0].n,1);
 assert.ok((await f.db.raw.execute('SELECT count(*) n FROM stage8_live_executions')).rows[0].n>0);
});
