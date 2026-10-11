import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {randomUUID} from 'node:crypto';
import {createDb,fixtureKeys} from './localDb.js';
import {OWNER_PILOT_APPROVAL_SHA256,reviewedPilotAllowance,pilotStopRequested} from '../src/betaPilotAllowance.js';
import {betaPilotConfiguration,reviewedPilotAdmission,reviewedPilotReservation,createBetaPilotPermit,withBetaPilotAttempt} from '../src/betaPilotPermit.js';
import {runExecutionPhase} from '../src/phase4Execution.js';import {configurationProof} from '../src/phase4ExecutionStore.js';
import {publicBetaConfiguration} from '../src/publicBetaConfig.js';import {runningReleaseSha} from '../src/phase4Release.js';import {operationalLogFields} from '../src/logger.js';
const environment=(start=Date.now()-1000)=>({PHASE4_BETA_SHADOW_RUNTIME:'on',PHASE4_PUBLIC_BETA_MODE:'off',
 PHASE4_BETA_PILOT_ID:'a'.repeat(64),PHASE4_BETA_PILOT_USER_ID:'pilot-user',PHASE4_BETA_PILOT_START_AT:new Date(start).toISOString(),
 PHASE4_BETA_PILOT_CONSENT_SHA256:'b'.repeat(64),PHASE4_BETA_PILOT_ALLOWANCE_ID:OWNER_PILOT_APPROVAL_SHA256,PHASE4_BETA_PILOT_STOP:'off'});
const reservation=reviewedPilotAllowance(OWNER_PILOT_APPROVAL_SHA256),component='phase4_beta_pilot_permit_v1';
const permit=(db,env)=>createBetaPilotPermit({db,keys:fixtureKeys,config:betaPilotConfiguration(env),reservation});
const record=async db=>JSON.parse((await db.raw.execute({sql:"SELECT last_detail FROM system_heartbeats WHERE scope='global' AND component=?",args:[component]})).rows[0].last_detail);
const request=(env,phase='SYNC',extra={})=>({releaseSha:runningReleaseSha(),requestId:randomUUID(),phase,triggerSource:'manual',executionMode:publicBetaConfiguration(env).runtime==='on'?'SHADOW':'OFF',
 configProof:configurationProof(fixtureKeys,publicBetaConfiguration(env),env),...extra});
const runtimeEnv={timezone:'Asia/Taipei',dryRun:true,maxUserConcurrency:1,telegramBotToken:'SYNTHETIC',telegramChatId:'SYNTHETIC'};
const success=()=>({syncComplete:true,syncOutcome:'NO_NEW_DATA_SUCCESS',users:0,failed:0});
async function fixture(t){
 const dir=await mkdtemp(join(tmpdir(),'pilot-allowance-')),url='file:'+join(dir,'fixture.db'),db=createDb({url});
 const owned=[db];t.after(async()=>{for(const client of owned.reverse())client.close();await rm(dir,{recursive:true,force:true});});await db.migrate();await db.admitRuntime();
 for(const id of ['pilot-user','other-user']){await db.createUser({id,displayName:'Synthetic',timezone:'Asia/Taipei',status:'ACTIVE'});await db.ensureOnboarding(id);await db.raw.execute({sql:"UPDATE user_onboarding SET state='READY' WHERE user_id=?",args:[id]});}
 return {db,url,own:client=>{owned.push(client);return client;}};
}
test('exact financial policy is typed owner approval without fabricated billed units; legacy cost registry remains null',()=>{
 assert.equal(reservation.kind,'OWNER_APPROVED_MONITORED_ALLOWANCE');assert.equal(Object.isFrozen(reservation),true);
 assert.equal(reservation.budgetMicroUsd,2000000);assert.equal(reservation.maxAttempts,12);assert.equal(reservation.estimatedMicroUsdPerAttempt*12,1200000);
 for(const field of ['perAttempt','maximum','rowsRead','rowsWritten','storageBytes','bytesSynced'])assert.equal(Object.hasOwn(reservation,field),false);
 assert.equal(reviewedPilotReservation(),null);assert.equal(reviewedPilotAdmission(betaPilotConfiguration(environment())),reservation);
 assert.equal(betaPilotConfiguration({}),null);assert.equal(reviewedPilotAllowance('f'.repeat(64)),null);
 assert.throws(()=>betaPilotConfiguration({...environment(),PHASE4_BETA_PILOT_COST_BOUND_ID:'c'.repeat(64)}),/BETA_PILOT_DENIED/);
 assert.throws(()=>betaPilotConfiguration({...environment(),PHASE4_BETA_PILOT_ALLOWANCE_ID:'f'.repeat(64)}),/BETA_PILOT_DENIED/);
});
test('a copied financial policy cannot grant remote authority and all policy/stop changes fence authenticated profile',()=>{
 const env=environment(),config=betaPilotConfiguration(env),db={raw:{protocol:'http'},transaction(){throw Error('must not run');}};
 assert.doesNotThrow(()=>createBetaPilotPermit({db,keys:fixtureKeys,config,reservation}));
 assert.throws(()=>createBetaPilotPermit({db,keys:fixtureKeys,config,reservation:{...reservation}}),/BETA_PILOT_DENIED/);
 const proof=configurationProof(fixtureKeys,publicBetaConfiguration(env),env),stopped={...env,PHASE4_BETA_PILOT_STOP:'on'};
 assert.notEqual(configurationProof(fixtureKeys,publicBetaConfiguration(stopped),stopped),proof);
 assert.equal(pilotStopRequested(stopped),true);assert.throws(()=>pilotStopRequested({PHASE4_BETA_PILOT_STOP:'invalid'}),/BETA_PILOT_DENIED/);
});
test('stop or invalid monitoring policy disables new optional drain before database admission',async()=>{
 for(const value of ['on','invalid']){
  const env={...environment(),PHASE4_BETA_PILOT_STOP:value};let admissions=0;
  const db={raw:{protocol:'http'},admitRuntime:async()=>{admissions++;throw Error('unexpected admission');}};
  const result=await runExecutionPhase({db,request:request(env,'STAGE6_DRAIN',{syncRequestId:randomUUID(),handoff:'c'.repeat(64)}),environment:env,keys:fixtureKeys,env:runtimeEnv});
  assert.equal(result.body.result.outcome,'DISABLED');assert.equal(admissions,0);
 }
});
test('concurrent monitored reservations, restart and new identities retain a single 12-attempt ceiling with no reset/refund',async t=>{
 const {db,url,own}=await fixture(t),other=own(createDb({url}));await other.admitRuntime();const env=environment();
 const permits=[permit(db,env),permit(other,env)],results=await Promise.allSettled(Array.from({length:20},(_,n)=>permits[n%2].reserve()));
 assert.equal(results.filter(r=>r.status==='fulfilled').length,12);assert.equal((await record(db)).attempts,12);
 assert.deepEqual(new Set(results.filter(r=>r.status==='fulfilled').map(r=>r.value.attempt)),new Set(Array.from({length:12},(_,i)=>i+1)));
 await assert.rejects(()=>permit(db,env).reserve(),/BETA_PILOT_DENIED/);
 await assert.rejects(()=>permit(db,{...env,PHASE4_BETA_PILOT_ID:'e'.repeat(64),PHASE4_BETA_PILOT_START_AT:new Date().toISOString()}).reserve(),/BETA_PILOT_DENIED/);
 assert.equal((await record(db)).attempts,12);assert.equal(typeof permits[0].refund,'undefined');assert.equal((await db.raw.execute('SELECT MAX(version) version FROM schema_version')).rows[0].version,32);
});
test('READY/lifecycle invalidation durably closes the monitored policy and restart cannot refund consumed attempts',async t=>{
 const {db}=await fixture(t),env=environment(),store=permit(db,env),grant=await store.reserve();
 await db.raw.execute("UPDATE user_onboarding SET state='ACTION_REQUIRED' WHERE user_id='pilot-user'");
 await assert.rejects(()=>grant.assert(),/BETA_PILOT_DENIED/);assert.equal((await record(db)).closed,true);
 await db.raw.execute("UPDATE user_onboarding SET state='READY' WHERE user_id='pilot-user'");await assert.rejects(()=>permit(db,env).reserve(),/BETA_PILOT_DENIED/);
 assert.equal((await record(db)).attempts,1);
});
test('observed monitored expiry remains closed across restart and later database-clock rollback',async t=>{
 const {db}=await fixture(t),env=environment(),store=permit(db,env),grant=await store.reserve(),config=betaPilotConfiguration(env),execute=db.raw.execute.bind(db.raw);let observed=config.endAt;
 db.raw.execute=async statement=>{const result=await execute(statement);
  if(statement?.sql?.includes('observed_at')&&statement.sql.includes('user_onboarding')){
   result.rows[0].observed_at=observed;result.rows[0].lifecycle_generation=1;
  }return result;};
 await assert.rejects(()=>grant.assert(),/BETA_PILOT_DENIED/);assert.equal((await record(db)).closed,true);
 observed=config.startAt+1000;await assert.rejects(()=>permit(db,env).reserve(),/BETA_PILOT_DENIED/);assert.equal((await record(db)).attempts,1);
});
test('actual composition admits only the consenting pilot and stop leaves ordinary SYNC usable without drain authorization',async t=>{
 const {db}=await fixture(t),env=environment(),calls=[];
 const deps={runBriefing:success,runtime:{phase4Stage6:{drain:async input=>{calls.push(input.userId);return {outcome:'NO_WORK',jobsConsidered:0,itemsAttempted:0,processedItems:0,completedJobs:0,remainingJobs:0};}}}};
 const options={db,environment:env,keys:fixtureKeys,env:runtimeEnv,deps},syncRequest=request(env),sync=await runExecutionPhase({...options,request:syncRequest});
 assert.equal(sync.body.drainAuthorized,true);
 const drain=request(env,'STAGE6_DRAIN',{syncRequestId:syncRequest.requestId,handoff:sync.body.handoff});
 const result=await runExecutionPhase({...options,request:drain});assert.equal(result.body.result.outcome,'NO_WORK');assert.deepEqual(calls,['pilot-user']);
 assert.deepEqual(await runExecutionPhase({...options,request:drain}),result);assert.equal((await record(db)).attempts,1);
 env.PHASE4_BETA_PILOT_STOP='on';const stoppedSync=await runExecutionPhase({...options,request:request(env)});assert.equal(stoppedSync.body.syncComplete,true);assert.equal(stoppedSync.body.drainAuthorized,false);
 assert.equal((await record(db)).attempts,1);assert.deepEqual(calls,['pilot-user']);
});
test('stop configuration change fences an in-flight optional mutation without altering ordinary user state',async t=>{
 const {db}=await fixture(t),env=environment(),options={db,environment:env,keys:fixtureKeys,env:runtimeEnv},syncRequest=request(env);
 const sync=await runExecutionPhase({...options,request:syncRequest,deps:{runBriefing:success}});
 let attempted=false;
 const deps={runtime:{phase4Stage6:{drain:async()=>{env.PHASE4_BETA_PILOT_STOP='on';attempted=true;
  await db.transaction(()=>db.raw.execute("UPDATE users SET display_name='MUST_NOT_COMMIT' WHERE id='pilot-user'"),{workStep:'synthetic-stop'});
  return {outcome:'NO_WORK'};}}}};
 const result=await runExecutionPhase({...options,request:request(env,'STAGE6_DRAIN',{syncRequestId:syncRequest.requestId,handoff:sync.body.handoff}),deps});
 assert.equal(attempted,true);assert.equal(result.body.ok,false);assert.equal((await db.getUser('pilot-user')).displayName,'Synthetic');assert.equal((await record(db)).attempts,1);
});
test('financial estimate alert fields survive real operational log filtering without exposing identity/health fields',()=>{
 assert.deepEqual(operationalLogFields({attempt:10,attempts:12,estimated_micro_usd:1000000,budget_micro_usd:2000000,user_id:'pilot-user',display_name:'Synthetic',hrv:42}),
  {attempt:10,attempts:12,estimated_micro_usd:1000000,budget_micro_usd:2000000});
});
