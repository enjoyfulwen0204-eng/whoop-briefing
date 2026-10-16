import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {syntheticPhase4Fixture} from 'file:///private/tmp/phase4-final-independent-review/unattended-59cb-checkout/test/phase4Fixture.js';
import {bodyInput,seedBodyInput} from 'file:///private/tmp/phase4-final-independent-review/unattended-59cb-checkout/test/bodyEnergyFixture.js';
import {runExecutionPhase} from 'file:///private/tmp/phase4-final-independent-review/unattended-59cb-checkout/src/phase4Execution.js';
import {configurationProof} from 'file:///private/tmp/phase4-final-independent-review/unattended-59cb-checkout/src/phase4ExecutionStore.js';
import {runningReleaseSha} from 'file:///private/tmp/phase4-final-independent-review/unattended-59cb-checkout/src/phase4Release.js';
import {recordStage8SyncSubject} from 'file:///private/tmp/phase4-final-independent-review/unattended-59cb-checkout/src/stage8PostSync.js';
import {createStage8Runtime} from 'file:///private/tmp/phase4-final-independent-review/unattended-59cb-checkout/src/stage8Runtime.js';
import {createSync} from 'file:///private/tmp/phase4-final-independent-review/unattended-59cb-checkout/src/sync.js';
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

export {setup,env,deferred};
