import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {syntheticPhase4Fixture} from './phase4Fixture.js';
import {runExecutionPhase} from '../src/phase4Execution.js';
import {configurationProof} from '../src/phase4ExecutionStore.js';
import {runningReleaseSha} from '../src/phase4Release.js';
import {createSync} from '../src/sync.js';
import {recordStage8SyncSubject,createStage8PostSync} from '../src/stage8PostSync.js';

async function fixture(t){
 const f=await syntheticPhase4Fixture(t,{targetVersion:35,now:()=>new Date()});
 const users=['a','b','c'];
 await f.db.createUser({id:'c',displayName:'Synthetic',timezone:'Asia/Taipei',status:'ACTIVE'});
 await f.core.initializeTenant('c','SHADOW');
 for(const [index,userId] of users.entries()){
  await f.db.saveTokens(userId,{accessToken:'SYNTHETIC_NOT_A_TOKEN',refreshToken:'SYNTHETIC_NOT_A_TOKEN',expiresAt:new Date(Date.now()+3600000).toISOString(),scope:''});
  await f.db.ensureOnboarding(userId,{state:'READY'});
  await f.db.linkTelegram({userId,chatId:String(10001+index)});
  for(const resource of ['sleep','recovery','cycle','workout'])await f.db.saveSyncState(userId,resource,{backfillComplete:true,lastSuccessAt:new Date().toISOString()});
 }
 const environment={PHASE4_BETA_SHADOW_RUNTIME:'off',PHASE4_PUBLIC_BETA_MODE:'off'};
 const request={phase:'SYNC',triggerSource:'manual',requestId:randomUUID(),releaseSha:runningReleaseSha(),executionMode:'OFF',configProof:configurationProof(f.keys,{runtime:'off',mode:'off'},environment)};
 const response=await runExecutionPhase({...f,request,environment,env:{dryRun:true,timezone:'Asia/Taipei',telegramBotToken:'SYNTHETIC_NOT_A_TOKEN'},deps:{runBriefing:async()=>{
  for(const userId of users){
   const whoop={sleeps:async()=>[],recoveries:async()=>[],cycles:async()=>[],workouts:async()=>[],bodyMeasurement:async()=>({})};
   const sync=await createSync({...f,whoop,userId,timezone:'Asia/Taipei',expectedLifecycleGeneration:1}).syncAll({force:true});
   assert.equal(sync.complete,true);await recordStage8SyncSubject({...f,userId,sync});
  }
  return {syncComplete:true,syncOutcome:'NO_NEW_DATA_SUCCESS',users:users.length,failed:0};
 }}});
 assert.equal(response.body.syncComplete,true);
 const calls=[],eligible=new Set(users);let failNext=false;
 const producer={run:async value=>{calls.push(value);if(failNext){failNext=false;throw Error('SYNTHETIC_BOUNDED_LEG_FAILURE');}return {publication:{status:'ANALYSIS_UPDATING'},replayed:false,executionId:value.requestId};}};
 const restart=()=>createStage8PostSync({...f,environment,userIds:users,eligible:id=>eligible.has(id),enabled:()=>true,producer});
 return {...f,calls,eligible,restart,failNext:()=>{failNext=true;}};
}

test('three-subject discovery rotates partial work and failures without changing durable request ordinals',async t=>{
 const f=await fixture(t),app=f.restart();
 for(let n=0;n<6;n++)assert.equal((await app.resume()).status,'ANALYSIS_UPDATING');
 assert.deepEqual(f.calls.map(call=>call.userId),['a','b','c','a','b','c']);
 assert.equal(new Set(f.calls.map(call=>call.requestId)).size,6,'each subject has its own signed next ordinal');
 const progress=(await f.db.raw.execute("SELECT value FROM telegram_state WHERE key LIKE 'stage8:sync-progress:%'")).rows.map(row=>JSON.parse(row.value));
 assert.equal(progress.length,3);assert.ok(progress.every(row=>row.ordinal===2&&!row.done));
 f.failNext();await assert.rejects(app.resume(),/SYNTHETIC_BOUNDED_LEG_FAILURE/);const failed=f.calls.at(-1);
 await app.resume();await app.resume();await app.resume();
 assert.deepEqual(f.calls.slice(-4).map(call=>call.userId),['a','b','c','a']);
 assert.equal(f.calls.at(-1).requestId,failed.requestId,'failure reuses its original durable ordinal when the subject returns');
 f.eligible.delete('b');await app.resume();assert.equal(f.calls.at(-1).userId,'c');
 const original=Date.now,before=f.calls.length;Date.now=()=>original()+16*60000;
 try{assert.deepEqual(await app.resume(),{status:'IDLE',invoked:0});}finally{Date.now=original;}
 assert.equal(f.calls.length,before,'fair scheduling never extends the original parent expiry');
});

test('one unavailable subject surfaces its denial and does not monopolize later discovery ticks',async t=>{
 const f=await fixture(t),app=f.restart();await f.db.setOnboardingState('a','ACTION_REQUIRED',{from:['READY']});
 await assert.rejects(app.resume(),/FINALIZED_SYNC_REQUIRED/);
 assert.equal(f.calls.length,0);
 assert.equal((await app.resume()).status,'ANALYSIS_UPDATING');assert.equal(f.calls.at(-1).userId,'b');
 assert.equal((await app.resume()).status,'ANALYSIS_UPDATING');assert.equal(f.calls.at(-1).userId,'c');
});
