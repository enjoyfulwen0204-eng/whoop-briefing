import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {createDb,fixtureKeys} from './localDb.js';
import {betaPilotConfiguration,createBetaPilotPermit,reviewedPilotReservation,PILOT_DURATION_MS,withBetaPilotAttempt,requireCurrentBetaPilotAttempt} from '../src/betaPilotPermit.js';
import {runExecutionPhase} from '../src/phase4Execution.js';
import {configurationProof} from '../src/phase4ExecutionStore.js';
import {publicBetaConfiguration} from '../src/publicBetaConfig.js';
import {runningReleaseSha} from '../src/phase4Release.js';
import {runPhase4Stage6} from '../src/shadowDrainScheduler.js';
import {createPhase4Stage6,authorizeStage6ShadowWorker} from '../src/phase4Reanalysis.js';
import {createPublicBetaRuntime,createPublicBetaPresentation,authorizePublicBetaRuntime} from '../src/publicBeta.js';

// Synthetic arithmetic only. This is not a provider-measured cost bound.
const reservation={id:'c'.repeat(64),evidenceSha256:'d'.repeat(64),
 perAttempt:{rowsRead:10,rowsWritten:5,storageBytes:100,bytesSynced:0,microUsd:100},
 maximum:{rowsRead:480,rowsWritten:240,storageBytes:4800,bytesSynced:0,microUsd:4800}};
const environment=(start=Date.now()-1000)=>({PHASE4_BETA_SHADOW_RUNTIME:'on',PHASE4_PUBLIC_BETA_MODE:'off',
 PHASE4_BETA_PILOT_ID:'a'.repeat(64),PHASE4_BETA_PILOT_USER_ID:'pilot-user',
 PHASE4_BETA_PILOT_START_AT:new Date(start).toISOString(),PHASE4_BETA_PILOT_CONSENT_SHA256:'b'.repeat(64),PHASE4_BETA_PILOT_COST_BOUND_ID:reservation.id});
const component='phase4_beta_pilot_permit_v1';
const request=(env,phase='SYNC',extra={})=>({releaseSha:runningReleaseSha(),requestId:randomUUID(),phase,triggerSource:'manual',executionMode:'SHADOW',
 configProof:configurationProof(fixtureKeys,publicBetaConfiguration(env),env),...extra});
const runtimeEnv={timezone:'Asia/Taipei',dryRun:true,maxUserConcurrency:1,telegramBotToken:'SYNTHETIC',telegramChatId:'SYNTHETIC'};
const success=()=>({syncComplete:true,syncOutcome:'NO_NEW_DATA_SUCCESS',users:0,failed:0});

async function fixture(t){
 const dir=await mkdtemp(join(tmpdir(),'beta-pilot-')),url=`file:${join(dir,'fixture.db')}`,db=createDb({url});
 t.after(async()=>{db.close();await rm(dir,{recursive:true,force:true});});
 await db.migrate();await db.admitRuntime();
 for(const id of ['pilot-user','other-user']){
  await db.createUser({id,displayName:'Synthetic',timezone:'Asia/Taipei',status:'ACTIVE'});
  await db.ensureOnboarding(id);
  await db.raw.execute({sql:"UPDATE user_onboarding SET state='READY' WHERE user_id=?",args:[id]});
 }
 return {db,url};
}
const store=(db,env,units=reservation)=>createBetaPilotPermit({db,keys:fixtureKeys,config:betaPilotConfiguration(env),reservation:units});
const record=async db=>JSON.parse((await db.raw.execute({sql:"SELECT last_detail FROM system_heartbeats WHERE scope='global' AND component=?",args:[component]})).rows[0].last_detail);

test('production qualification is absent and missing/invalid pilot configuration cannot create authority',()=>{
 assert.equal(reviewedPilotReservation(reservation.id),null);
 assert.equal(betaPilotConfiguration({}),null);
 assert.throws(()=>betaPilotConfiguration({PHASE4_BETA_PILOT_ID:'a'.repeat(64)}),/BETA_PILOT_DENIED|userId/);
 assert.throws(()=>betaPilotConfiguration({...environment(),PHASE4_BETA_PILOT_USER_ID:' pilot-user'}),/BETA_PILOT_DENIED/);
 assert.throws(()=>betaPilotConfiguration({...environment(),PHASE4_BETA_PILOT_START_AT:'2026-10-10'}),/BETA_PILOT_DENIED/);
});

test('parallel submissions, retries, continuations and recreation share one atomic 48-attempt ceiling without refunds',async t=>{
 const {db,url}=await fixture(t),env=environment(),another=createDb({url});t.after(()=>another.close());await another.admitRuntime();
 const permits=[store(db,env),store(another,env)];
 const results=await Promise.allSettled(Array.from({length:60},(_,i)=>permits[i%2].reserve()));
 assert.equal(results.filter(r=>r.status==='fulfilled').length,48);
 assert.equal((await record(db)).attempts,48);
 assert.deepEqual(new Set(results.filter(r=>r.status==='fulfilled').map(r=>r.value.attempt)),new Set(Array.from({length:48},(_,i)=>i+1)));
 await assert.rejects(()=>store(db,env).reserve(),/BETA_PILOT_DENIED/);
 // A consumer failure/uncertain reply never invokes a refund operation.
 assert.equal(typeof permits[0].refund,'undefined');assert.equal((await record(db)).attempts,48);
 const altered={...env,PHASE4_BETA_PILOT_ID:'e'.repeat(64),PHASE4_BETA_PILOT_START_AT:new Date(Date.now()).toISOString()};
 await assert.rejects(()=>store(db,altered).reserve(),/BETA_PILOT_DENIED/);
 assert.equal((await record(db)).attempts,48);
 assert.equal(Number((await db.raw.execute('SELECT MAX(version) v FROM schema_version')).rows[0].v),32);
});

test('pre-submission unit reservations deny the next attempt before exhausting the operational margin',async t=>{
 const {db}=await fixture(t),env=environment();
 const limited={...reservation,maximum:{...reservation.maximum,rowsWritten:10}};
 const permit=store(db,env,limited);await permit.reserve();await permit.reserve();
 await assert.rejects(()=>permit.reserve(),/BETA_PILOT_DENIED/);assert.equal((await record(db)).attempts,2);
 assert.throws(()=>store(db,env,{...reservation,maximum:{...reservation.maximum,microUsd:500000}}),/BETA_PILOT_DENIED/);
 assert.throws(()=>store(db,env,null),/BETA_PILOT_DENIED/);
});

test('observed expiry is durably closed; restart or database-clock rollback cannot reopen it',async t=>{
 const {db}=await fixture(t),ends=Date.now()+300,env=environment(ends-PILOT_DURATION_MS),permit=store(db,env);
 const grant=await permit.reserve();await new Promise(resolve=>setTimeout(resolve,Math.max(0,ends-Date.now()+10)));
 await assert.rejects(()=>permit.reserve(),/BETA_PILOT_DENIED/);
 const before=await record(db);assert.equal(before.closed,true);assert.equal(before.attempts,1);
 const execute=db.raw.execute.bind(db.raw);
 db.raw.execute=async statement=>{const result=await execute(statement);if(typeof statement?.sql==='string'&&statement.sql.startsWith('SELECT (CAST(strftime'))
  result.rows[0].observed_at=ends-100;return result;};
 await assert.rejects(()=>store(db,env).reserve(),/BETA_PILOT_DENIED/);
 await assert.rejects(()=>grant.assert(),/BETA_PILOT_DENIED/);assert.equal((await record(db)).closed,true);
});

test('a backwards database observation closes the permit rather than extending its original 24h',async t=>{
 const {db}=await fixture(t),env=environment(),permit=store(db,env);await permit.reserve();const state=await record(db);
 const execute=db.raw.execute.bind(db.raw);
 db.raw.execute=async statement=>{const result=await execute(statement);if(typeof statement?.sql==='string'&&statement.sql.startsWith('SELECT (CAST(strftime'))
  result.rows[0].observed_at=state.lastObservedAt-1;return result;};
 await assert.rejects(()=>permit.reserve(),/BETA_PILOT_DENIED/);assert.equal((await record(db)).closed,true);
});

test('canonical READY/lifecycle and consent-profile changes fail closed without changing authority/receipt history',async t=>{
 const {db}=await fixture(t),env=environment(),permit=store(db,env),grant=await permit.reserve();
 await db.raw.execute("UPDATE user_onboarding SET state='ACTION_REQUIRED' WHERE user_id='pilot-user'");
 await assert.rejects(()=>grant.assert(),/BETA_PILOT_DENIED/);
 await assert.rejects(()=>permit.reserve(),/BETA_PILOT_DENIED/);assert.equal((await record(db)).closed,true);
 await db.raw.execute("UPDATE user_onboarding SET state='READY' WHERE user_id='pilot-user'");
 await assert.rejects(()=>store(db,env).reserve(),/BETA_PILOT_DENIED/);
 await assert.rejects(()=>store(db,{...env,PHASE4_BETA_PILOT_CONSENT_SHA256:'f'.repeat(64)}).reserve(),/BETA_PILOT_DENIED/);
 assert.equal(Number((await db.raw.execute('SELECT count(*) n FROM phase4_execution_work_receipts')).rows[0].n),0);
});

test('ordinary heartbeat writes preserve the dedicated global record; generic overwrite corruption denies rather than resets',async t=>{
 const {db}=await fixture(t),env=environment(),permit=store(db,env);await permit.reserve();const before=await record(db);
 await db.recordHeartbeat('global','cron',{detail:'discarded'});
 await db.recordHeartbeat('user:other-user','whoop_sync',{detail:'discarded'});
 assert.deepEqual(await record(db),before);
 assert.ok(!JSON.stringify(before).includes('pilot-user'));
 await db.recordHeartbeat('global',component);
 await assert.rejects(()=>store(db,env).reserve(),/BETA_PILOT_DENIED/);
 assert.equal((await db.raw.execute({sql:"SELECT last_detail FROM system_heartbeats WHERE component=?",args:[component]})).rows[0].last_detail,null);
});

test('unknown cost qualification denies SHADOW before admission while ordinary SYNC and its cached replay remain operational',async t=>{
 const {db}=await fixture(t),env=environment();let admissions=0,drains=0,syncs=0;
 const admit=db.admitRuntime;db.admitRuntime=async(...args)=>{admissions++;return admit(...args);};
 const drain=request(env,'STAGE6_DRAIN',{syncRequestId:randomUUID(),handoff:'a'.repeat(64)});
 const response=await runExecutionPhase({request:drain,environment:env,env:runtimeEnv,keys:fixtureKeys,db,deps:{runtime:{phase4Stage6:{drain:()=>drains++}}}});
 assert.equal(response.body.result.outcome,'DISABLED');assert.equal(admissions,0);assert.equal(drains,0);
 assert.equal(Number((await db.raw.execute('SELECT count(*) n FROM phase4_executions')).rows[0].n),0);
 const sync=request(env),options={request:sync,environment:env,env:runtimeEnv,keys:fixtureKeys,db,deps:{runBriefing:()=>{syncs++;return success();}}};
 const completed=await runExecutionPhase(options),cached=await runExecutionPhase(options);
 assert.equal(completed.body.syncComplete,true);assert.equal(completed.body.drainAuthorized,false);
 assert.deepEqual(cached,completed);assert.equal(syncs,1);
});

test('authenticated composition passes only the pilot user to SHADOW despite presentation OFF, and cached execution does not resubmit',async t=>{
 const {db}=await fixture(t),env=environment(),calls=[];
 const deps={pilotReservation:reservation,runBriefing:success,runtime:{phase4Stage6:{drain:async input=>{calls.push(input.userId);
  return {outcome:'NO_WORK',jobsConsidered:0,itemsAttempted:0,processedItems:0,completedJobs:0,remainingJobs:0};}}}};
 const options={environment:env,env:runtimeEnv,keys:fixtureKeys,db,deps},syncRequest=request(env),sync=await runExecutionPhase({...options,request:syncRequest});
 const drainRequest=request(env,'STAGE6_DRAIN',{syncRequestId:syncRequest.requestId,handoff:sync.body.handoff});
 const first=await runExecutionPhase({...options,request:drainRequest}),cached=await runExecutionPhase({...options,request:drainRequest});
 assert.equal(first.body.result.outcome,'NO_WORK');assert.deepEqual(cached,first);assert.deepEqual(calls,['pilot-user']);assert.equal((await record(db)).attempts,1);
 const retry=request(env,'STAGE6_DRAIN',{syncRequestId:syncRequest.requestId,handoff:sync.body.handoff});
 await runExecutionPhase({...options,request:retry});assert.deepEqual(calls,['pilot-user','pilot-user']);assert.equal((await record(db)).attempts,2);
});

test('lower-level remote factories and every scheduler source deny missing or forged pilot authority before provider queries',async()=>{
 let calls=0;const db={getUser:()=>{calls++;},raw:{protocol:'http',execute:()=>{calls++;throw Error('unexpected remote query');}},transaction:()=>{calls++;throw Error('unexpected transaction');}};
 const env=environment();
 assert.throws(()=>store(db,env),/BETA_PILOT_DENIED/);
 await assert.rejects(()=>createPhase4Stage6({db,keys:fixtureKeys,executionMode:'SHADOW',workerCapability:authorizeStage6ShadowWorker({executionMode:'SHADOW'})}),/BETA_PILOT_DENIED/);
 await assert.rejects(()=>createPublicBetaRuntime({db,keys:fixtureKeys,executionMode:'SHADOW',runtimeCapability:authorizePublicBetaRuntime({executionMode:'SHADOW'})}),/BETA_PILOT_DENIED/);
 assert.throws(()=>createPublicBetaPresentation({db,stores:{withContext(){},assertCurrent(){},betaSummary:{readCurrent(){}}},policy:{eligible:()=>true},
  runtimeCapability:authorizePublicBetaRuntime({executionMode:'SHADOW'})}),/BETA_PILOT_DENIED/);
 for(const triggerSource of ['cloudflare','github','event','manual']){
  const result=await runPhase4Stage6({db,triggerSource,userId:'pilot-user',worker:{drain:()=>calls++}});
  assert.equal(result.outcome,'DISABLED');
 }
 await assert.rejects(()=>withBetaPilotAttempt({userId:'pilot-user',assertTime(){}},'pilot-user',()=>calls++),/BETA_PILOT_DENIED/);
 assert.equal(calls,0);
});

test('one reserved in-flight attempt cannot be submitted twice concurrently, reused later, or applied to another tenant',async t=>{
 const {db}=await fixture(t),env=environment(),grant=await store(db,env).reserve();let calls=0,release;
 await assert.rejects(()=>withBetaPilotAttempt(grant,'other-user',()=>calls++),/BETA_PILOT_DENIED/);
 const pending=withBetaPilotAttempt(grant,'pilot-user',async()=>{calls++;assert.equal(requireCurrentBetaPilotAttempt('pilot-user'),grant);await new Promise(resolve=>release=resolve);});
 await new Promise(resolve=>setImmediate(resolve));
 await assert.rejects(()=>withBetaPilotAttempt(grant,'pilot-user',()=>calls++),/BETA_PILOT_DENIED/);
 release();await pending;
 await assert.rejects(()=>withBetaPilotAttempt(grant,'pilot-user',()=>calls++),/BETA_PILOT_DENIED/);
 assert.throws(()=>requireCurrentBetaPilotAttempt('pilot-user'),/BETA_PILOT_DENIED/);
 assert.equal(calls,1);assert.equal((await record(db)).attempts,1);
 const otherReceiver={raw:{protocol:'http'}};
 assert.equal((await runPhase4Stage6({db:otherReceiver,worker:{drain:()=>calls++},userId:'pilot-user',pilotGrant:grant})).outcome,'DISABLED');
 assert.equal(calls,1);
});

test('optional presentation remains on the same pilot even with a broad presentation policy',async t=>{
 const {db}=await fixture(t),env={...environment(),PHASE4_PUBLIC_BETA_MODE:'all'},delivered=[];let verified=0;
 const deps={pilotReservation:reservation,runBriefing:success,runtime:{phase4Stage6:{drain:async()=>({outcome:'NO_WORK',jobsConsidered:0,itemsAttempted:0,processedItems:0,completedJobs:0,remainingJobs:0})},
  betaPresentation:{eligible:()=>true,withCurrentSummary:(req,work)=>work('SYNTHETIC',async()=>verified++)}},
  deliverBetaSummary:async({user,presentation})=>{
   delivered.push(user.id);assert.equal(presentation.eligible('other-user'),false);
   assert.equal(presentation.eligible('pilot-user'),true);
   assert.equal(await presentation.withCurrentSummary({userId:'other-user'},()=>assert.fail('cross-user presentation')),null);
   await presentation.withCurrentSummary({userId:user.id},async(_text,verify)=>verify());
  }};
 const options={environment:env,env:runtimeEnv,keys:fixtureKeys,db,deps},syncRequest=request(env),sync=await runExecutionPhase({...options,request:syncRequest});
 const drainRequest=request(env,'STAGE6_DRAIN',{syncRequestId:syncRequest.requestId,handoff:sync.body.handoff});
 assert.equal((await runExecutionPhase({...options,request:drainRequest})).body.result.outcome,'NO_WORK');
 assert.deepEqual(delivered,['pilot-user']);assert.equal(verified,1);
});

test('missing qualification leaves DELIVERY_STARTED/AMBIGUOUS claims and real local immutable execution receipts byte-for-byte unchanged',async t=>{
 const {db}=await fixture(t),env=environment();
 for(const [id,ambiguous] of [['pilot-user',false],['other-user',true]]){
  const key={userId:id,reportType:'daily',localDateKey:'2026-10-10',expectedLifecycleGeneration:1,ttlMs:60000};
  const claim=await db.claimReport(key);assert.equal(claim.granted,true);
  assert.equal(await db.authorizeReportDelivery({...key,owner:claim.owner}),true);
  if(ambiguous)assert.equal(await db.markClaimAmbiguous({...key,owner:claim.owner}),true);
 }
 const syncRequest=request(env),options={environment:env,env:runtimeEnv,keys:fixtureKeys,db};
 await runExecutionPhase({...options,request:syncRequest,deps:{runBriefing:async()=>{await db.recordHeartbeat('global','synthetic-sync');return success();}}});
 const snapshot=async()=>({claims:JSON.stringify((await db.raw.execute('SELECT * FROM report_claims ORDER BY user_id')).rows),
  receipts:JSON.stringify((await db.raw.execute('SELECT * FROM phase4_execution_work_receipts ORDER BY receipt_key')).rows),
  executions:JSON.stringify((await db.raw.execute('SELECT * FROM phase4_executions ORDER BY execution_seq')).rows)});
 const before=await snapshot();assert.notEqual(before.receipts,'[]');
 const drainRequest=request(env,'STAGE6_DRAIN',{syncRequestId:syncRequest.requestId,handoff:'a'.repeat(64)});
 assert.equal((await runExecutionPhase({...options,request:drainRequest})).body.result.outcome,'DISABLED');
 assert.deepEqual(await snapshot(),before);
});
