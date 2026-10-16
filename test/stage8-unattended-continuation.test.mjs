import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {syntheticPhase4Fixture} from './phase4Fixture.js';
import {bodyInput,seedBodyInput} from './bodyEnergyFixture.js';
import {runExecutionPhase} from '../src/phase4Execution.js';
import {configurationProof} from '../src/phase4ExecutionStore.js';
import {runningReleaseSha} from '../src/phase4Release.js';
import {recordStage8SyncSubject} from '../src/stage8PostSync.js';
import {createStage8Runtime} from '../src/stage8Runtime.js';
import {createSync} from '../src/sync.js';
import {createStage8ContinuationLoop} from '../src/stage8ContinuationLoop.js';
const env={dryRun:true,timezone:'Asia/Taipei',telegramBotToken:'SYNTHETIC_NOT_A_TOKEN'};
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
async function setup(t){
 const f=await syntheticPhase4Fixture(t,{targetVersion:35,ownedConnection:true,now:()=>new Date()});
 await f.db.transaction(()=>seedBodyInput(f.db,bodyInput({asOf:Date.now()-1000,days:0})));
 await f.db.ensureOnboarding('a',{state:'READY'});await f.db.linkTelegram({userId:'a',chatId:'10001'});
 for(const resource of ['sleep','recovery','cycle','workout'])await f.db.saveSyncState('a',resource,{backfillComplete:true,lastSuccessAt:new Date().toISOString()});
 const control=await f.stores.captureControl('a');await f.stores.preferences.read(control);
 const environment={PHASE4_BETA_SHADOW_RUNTIME:'off',PHASE4_PUBLIC_BETA_MODE:'off',PHASE4_STAGE8_RUNTIME:'on',PHASE4_BETA_PILOT_USER_ID:'a',STAGE8_USER_IDS:'a',STAGE8_LIVE_ANALYSIS:'on',STAGE8_POST_SYNC:'on'};
 const request=()=>({phase:'SYNC',triggerSource:'manual',requestId:randomUUID(),releaseSha:runningReleaseSha(),executionMode:'OFF',configProof:configurationProof(f.keys,{runtime:'off',mode:'off'},environment)});
 let syncs=0;const parent=request();
 const response=await runExecutionPhase({...f,keys:f.keys,request:parent,environment,env,deps:{runBriefing:async()=>{
  syncs++;const whoop={sleeps:async()=>[],recoveries:async()=>[],cycles:async()=>[],workouts:async()=>[],bodyMeasurement:async()=>({})};
  const sync=await createSync({...f,whoop,userId:'a',timezone:'Asia/Taipei',expectedLifecycleGeneration:1}).syncAll({force:true});
  assert.equal(sync.complete,true);await recordStage8SyncSubject({...f,userId:'a',sync});return {syncComplete:true,syncOutcome:sync.outcome,users:1,failed:0};
 }}});
 assert.equal(response.body.syncComplete,true);assert.equal(response.body.drainAuthorized,false);
 const counts=async()=>Object.fromEntries(await Promise.all(['phase4_executions','stage8_live_executions','stage8_live_execution_work_receipts'].map(async table=>[table,(await f.db.raw.execute(`SELECT count(*) n FROM ${table}`)).rows[0].n])));
 return {...f,environment,parent,request,counts,syncs:()=>syncs,app:await createStage8Runtime({...f,environment,env})};
}
test('restart discovers only the same authenticated finalized SYNC and completes genuine work without another SYNC',async t=>{
 const f=await setup(t);let app=f.app,result;
 const original=f.db.setState;let lost=false;
 f.db.setState=async function(key,value){
  if(!lost&&key.startsWith('stage8:sync-progress:')){lost=true;throw Error('SYNTHETIC_BEFORE_PROGRESS_COMMIT');}
  return original.call(this,key,value);
 };
 await assert.rejects(app.analysis.resume(),/SYNTHETIC_BEFORE_PROGRESS_COMMIT/);assert.equal(lost,true);f.db.setState=original;
 const afterCrash=await f.counts();assert.equal(afterCrash.phase4_executions,1);
 assert.ok(afterCrash.stage8_live_executions>1);
 const replay=await app.analysis.resume();assert.equal(replay.replayed,true);assert.equal((await f.counts()).stage8_live_execution_work_receipts,afterCrash.stage8_live_execution_work_receipts);
 app=await createStage8Runtime({...f,environment:f.environment,env});
 for(let leg=0;leg<32;leg++){result=await app.analysis.resume();assert.equal(result.invoked,1);if(result.status==='CURRENT')break;}
 assert.equal(result.status,'CURRENT');assert.equal(f.syncs(),1);assert.equal((await f.counts()).phase4_executions,1);
 assert.equal((await f.db.raw.execute("SELECT count(*) n FROM phase4_jobs WHERE execution_mode='LIVE' AND state='COMPLETED'")).rows[0].n,2);
 const before=await f.counts();assert.deepEqual(await app.analysis.resume(),{status:'IDLE',invoked:0});assert.deepEqual(await f.counts(),before);
 // A later global success lacks the authenticated per-subject receipt.
 await runExecutionPhase({...f,keys:f.keys,request:f.request(),environment:f.environment,env,deps:{runBriefing:async()=>({syncComplete:true,syncOutcome:'NO_NEW_DATA_SUCCESS'})}});
 const afterGlobal=await f.counts();assert.equal((await app.analysis.resume()).invoked,0);assert.deepEqual(await f.counts(),afterGlobal);
});
test('local overlap, policy revocation and original parent expiry cannot mint an unattended execution',async t=>{
 const f=await setup(t),get=f.db.getState,entered=deferred(),release=deferred();let gated=false;
 f.db.getState=async function(key){const value=await get.call(this,key);if(!gated&&key.startsWith('stage8:sync-subject:')){gated=true;entered.resolve();await release.promise;}return value;};
 const first=f.app.analysis.resume();await entered.promise;assert.deepEqual(await f.app.analysis.resume(),{status:'BUSY',invoked:0});release.resolve();await first;f.db.getState=get;
 let revoked=false;
 f.db.getState=async function(key){const value=await get.call(this,key);if(!revoked&&key.startsWith('stage8:sync-subject:')){revoked=true;f.environment.STAGE8_POST_SYNC='off';}return value;};
 const before=await f.counts();await assert.rejects(f.app.analysis.resume(),/FINALIZED_SYNC_REQUIRED/);f.db.getState=get;
 assert.deepEqual(await f.counts(),before);assert.deepEqual(await f.app.analysis.resume(),{status:'DISABLED',invoked:0});
 f.environment.STAGE8_POST_SYNC='on';const original=Date.now;Date.now=()=>original()+16*60000;
 try{assert.deepEqual(await f.app.analysis.resume(),{status:'IDLE',invoked:0});}finally{Date.now=original;}
 assert.deepEqual(await f.counts(),before);
});

test('discovery timeout retains the in-flight metadata join and cannot schedule production work',async t=>{
 const f=await setup(t),get=f.db.getState,entered=deferred(),release=deferred();let gated=false,ackSettled=false,stopped=false,scheduled;
 const before=await f.counts();
 f.db.getState=async function(key){const value=await get.call(this,key);if(!gated&&key.startsWith('stage8:sync-subject:')){gated=true;entered.resolve();await release.promise;ackSettled=true;}return value;};
 const errors=[],loop=createStage8ContinuationLoop({resume:()=>f.app.analysis.resume(),onError:error=>errors.push(error.code),timers:{set(fn){scheduled=fn;return 1;},clear(){scheduled=null;}}});
 loop.start();const tick=scheduled;scheduled=null;tick();await entered.promise;const stopping=loop.stop().then(()=>{stopped=true;});
 try{
  await new Promise(resolve=>setTimeout(resolve,5200));
  assert.equal(stopped,false,'timeout is revocation, not proof that the query joined');assert.equal(ackSettled,false);
  assert.deepEqual(await f.app.analysis.resume(),{status:'BUSY',invoked:0});
 }finally{release.resolve();await stopping;f.db.getState=get;}
 assert.equal(ackSettled,true);assert.deepEqual(errors,['SYNC_TIMEOUT']);assert.equal(scheduled,null);assert.deepEqual(await f.counts(),before);
});
