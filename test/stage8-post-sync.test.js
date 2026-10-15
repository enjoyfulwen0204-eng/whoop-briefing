import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {syntheticPhase4Fixture} from './phase4Fixture.js';import {bodyInput,seedBodyInput} from './bodyEnergyFixture.js';
import {runExecutionPhase} from '../src/phase4Execution.js';import {claimPhaseRequest,configurationProof} from '../src/phase4ExecutionStore.js';
import {runningReleaseSha} from '../src/phase4Release.js';import {recordStage8SyncSubject} from '../src/stage8PostSync.js';
import {createStage8Runtime} from '../src/stage8Runtime.js';import {createSync} from '../src/sync.js';
const env={dryRun:true,timezone:'Asia/Taipei',telegramBotToken:'SYNTHETIC_NOT_A_TOKEN'};
test('genuine finalized per-subject SYNC invokes separate LIVE exactly, resumes without a new SYNC, and fences stale authority',async t=>{
 const f=await syntheticPhase4Fixture(t,{targetVersion:35,now:()=>new Date()});await f.db.transaction(()=>seedBodyInput(f.db,bodyInput({asOf:Date.now()-1000,days:7})));
 await f.db.raw.execute("UPDATE whoop_sync_state SET backfill_complete=1 WHERE user_id='a'");
 await f.db.ensureOnboarding('a',{state:'READY'});await f.db.linkTelegram({userId:'a',chatId:'10001'});
 for(const resource of ['sleep','recovery','cycle','workout'])await f.db.saveSyncState('a',resource,{backfillComplete:true,lastSuccessAt:new Date().toISOString()});
 const control=await f.stores.captureControl('a');await f.stores.preferences.read(control);
 const environment={PHASE4_BETA_SHADOW_RUNTIME:'off',PHASE4_PUBLIC_BETA_MODE:'off',PHASE4_STAGE8_RUNTIME:'on',PHASE4_BETA_PILOT_USER_ID:'a',STAGE8_USER_IDS:'a',STAGE8_LIVE_ANALYSIS:'on',STAGE8_POST_SYNC:'on'};
 const request=()=>({phase:'SYNC',triggerSource:'manual',requestId:randomUUID(),releaseSha:runningReleaseSha(),executionMode:'OFF',configProof:configurationProof(f.keys,{runtime:'off',mode:'off'},environment)}),r=request();let calls=0;
 const deps={runBriefing:async()=>{
  calls++;const whoop={sleeps:async()=>[],recoveries:async()=>[],cycles:async()=>[],workouts:async()=>[],bodyMeasurement:async()=>({})};
  console.log('SYNTHETIC_SYNC_STATE',JSON.stringify(await f.db.getSyncState('a','sleep')));
  const sync=await createSync({...f,whoop,userId:'a',timezone:'Asia/Taipei',expectedLifecycleGeneration:1}).syncAll({force:true});
  console.log('SYNTHETIC_SYNC_RESULT',JSON.stringify(sync));console.log('SYNTHETIC_PRINCIPAL',JSON.stringify((await f.db.raw.execute("SELECT u.status,o.state,t.auth_generation,p.pending_purge_count,n.preference_version FROM users u LEFT JOIN user_onboarding o ON o.user_id=u.id LEFT JOIN user_whoop_tokens t ON t.user_id=u.id LEFT JOIN phase4_user_state p ON p.user_id=u.id LEFT JOIN user_notification_preferences n ON n.user_id=u.id WHERE u.id='a'")).rows));assert.equal(sync.complete,true,JSON.stringify(sync));try{await recordStage8SyncSubject({...f,userId:'a',sync});}catch(error){console.log('SYNC_SUBJECT_RECORD_ERROR',error.code,error.message,error.stack);throw error;}
  return {syncComplete:sync.complete,syncOutcome:sync.outcome,users:1,failed:0};
 }};
 const response=await runExecutionPhase({...f,keys:f.keys,request:r,environment,env,deps});assert.equal(response.body.syncComplete,true);assert.equal(response.body.drainAuthorized,false);
 assert.ok((await f.db.raw.execute('SELECT count(*) n FROM stage8_live_executions')).rows[0].n>0,'the actual post-settlement wrapper invokes the separate producer');
 let app=await createStage8Runtime({...f,environment,env}),result;
 for(let i=0;i<32;i++){result=await app.analysis.afterSync({executionId:r.requestId,userId:'a'});if(result.status==='CURRENT')break;}
 assert.equal(result.status,'CURRENT');assert.equal(calls,1,'continuations never initiate a new full SYNC');
 const before=(await f.db.raw.execute('SELECT count(*) n FROM stage8_live_execution_work_receipts')).rows[0].n;
 await t.test('restart and exact replay do not duplicate work or publication',async()=>{
  app=await createStage8Runtime({...f,environment,env});assert.equal((await app.analysis.afterSync({executionId:r.requestId,userId:'a'})).status,'CURRENT');
  assert.equal((await f.db.raw.execute('SELECT count(*) n FROM stage8_live_execution_work_receipts')).rows[0].n,before);
  assert.equal((await f.db.raw.execute('SELECT count(*) n FROM stage8_live_publications')).rows[0].n,1);
  assert.equal((await runExecutionPhase({...f,keys:f.keys,request:r,environment,env,deps})).body.syncComplete,true);assert.equal(calls,1);
 });
 await t.test('a global finalized success without a genuine subject receipt cannot invoke LIVE',async()=>{
  const other=request();await runExecutionPhase({...f,keys:f.keys,request:other,environment,env,deps:{runBriefing:async()=>({syncComplete:true,syncOutcome:'NO_NEW_DATA_SUCCESS'})}});
  await assert.rejects(app.analysis.afterSync({executionId:other.requestId,userId:'a'}),/FINALIZED_SYNC_REQUIRED/);
 });
 for(const outcome of ['PARTIAL','REQUIRED_RESOURCE_FAILED','AUTH_FAILED'])await t.test(`reject ${outcome} SYNC`,async()=>{
  const other=request();await runExecutionPhase({...f,keys:f.keys,request:other,environment,env,deps:{runBriefing:async()=>({syncComplete:false,syncOutcome:outcome})}});
  await assert.rejects(app.analysis.afterSync({executionId:other.requestId,userId:'a'}),/FINALIZED_SYNC_REQUIRED/);
 });
 await t.test('stale original SYNC cannot initiate new LIVE work',async()=>{const original=Date.now;Date.now=()=>original()+16*60000;try{await assert.rejects(app.analysis.afterSync({executionId:r.requestId,userId:'a'}),/FINALIZED_SYNC_REQUIRED/);}finally{Date.now=original;}});
 await t.test('unknown/unfinalized parent and peer are rejected',async()=>{const pending=request();await claimPhaseRequest(f.db,pending,JSON.stringify(pending),{keys:f.keys});for(const value of [{executionId:pending.requestId,userId:'a'},{executionId:'unfinalized-parent',userId:'a'},{executionId:r.requestId,userId:'b'}])await assert.rejects(app.analysis.afterSync(value),/FINALIZED_SYNC_REQUIRED/);});
 const rollback=async fn=>{const stop=Error('ROLLBACK');try{await f.db.transaction(async()=>{await fn();throw stop;});}catch(e){if(e!==stop)throw e;}};
 for(const [name,sql] of [
  ['source',"UPDATE phase4_user_state SET source_generation=source_generation+1 WHERE user_id='a'"],
  ['provider',"UPDATE user_whoop_tokens SET auth_generation=auth_generation+1 WHERE user_id='a'"],
  ['lifecycle',"UPDATE users SET lifecycle_generation=lifecycle_generation+1 WHERE id='a'"],
  ['purge',"UPDATE phase4_user_state SET pending_purge_count=1 WHERE user_id='a'"],
  ['enrollment',"UPDATE user_onboarding SET state='ACTION_REQUIRED' WHERE user_id='a'"],
  ['preference',"UPDATE user_notification_preferences SET preference_version=preference_version+1 WHERE user_id='a'"],
 ])await t.test(`reject changed ${name} before existing invocation replay`,()=>rollback(async()=>{await f.db.raw.execute(sql);await assert.rejects(app.analysis.afterSync({executionId:r.requestId,userId:'a'}),/FINALIZED_SYNC_REQUIRED/);}));
 assert.equal((await f.db.raw.execute('SELECT count(*) n FROM outbound_messages')).rows[0].n,0);
 await t.test('automatic Production activation remains off by default',async()=>{const disabled=await createStage8Runtime({...f,environment:{...environment,STAGE8_POST_SYNC:'off'},env});await assert.rejects(disabled.analysis.afterSync({executionId:r.requestId,userId:'a'}),/FINALIZED_SYNC_REQUIRED/);});
});

test('optional LIVE v35 composition failure never changes a finalized v34 SYNC response',async t=>{
 const f=await syntheticPhase4Fixture(t,{targetVersion:34,now:()=>new Date()}),environment={PHASE4_BETA_SHADOW_RUNTIME:'off',PHASE4_PUBLIC_BETA_MODE:'off',PHASE4_STAGE8_RUNTIME:'on',PHASE4_BETA_PILOT_USER_ID:'a',STAGE8_USER_IDS:'a',STAGE8_LIVE_ANALYSIS:'on',STAGE8_POST_SYNC:'on'};
 const request={phase:'SYNC',triggerSource:'manual',requestId:randomUUID(),releaseSha:runningReleaseSha(),executionMode:'OFF',configProof:configurationProof(f.keys,{runtime:'off',mode:'off'},environment)};
 const response=await runExecutionPhase({...f,keys:f.keys,request,environment,env,deps:{runBriefing:async()=>({syncComplete:true,syncOutcome:'NO_NEW_DATA_SUCCESS'})}});assert.equal(response.status,200);assert.equal(response.body.syncComplete,true);assert.equal(response.body.drainAuthorized,false);
});
