import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,fixtureKeys,request,claim,authority} from './v32ReviewFixture.js';
import {bodyInput,seedBodyInput} from './bodyEnergyFixture.js';
import {createPhase4Foundation} from '../src/phase4Foundation.js';
import {buildPhase4Core} from '../src/phase4Core.js';
import {createReanalysisQueue} from '../src/phase4ReanalysisQueue.js';
import {betaPilotConfiguration,createBetaPilotPermit,withBetaPilotAttempt} from '../src/betaPilotPermit.js';
import {OWNER_PILOT_APPROVAL_SHA256,reviewedPilotAllowance} from '../src/betaPilotAllowance.js';
import {commitPhaseWork,finalizePhaseWork} from '../src/phase4ExecutionStore.js';
import {withDurableExecution} from '../src/phase4ExecutionContext.js';

const component='phase4_beta_pilot_permit_v1';
const physicalSources=transport=>transport.counts.byFamily.CANONICAL??0;
const rawRecord=async db=>(await db.raw.execute({sql:"SELECT last_detail FROM system_heartbeats WHERE scope='global' AND component=?",args:[component]})).rows[0].last_detail;
const record=async db=>JSON.parse(await rawRecord(db));
async function setup(t) {
 const {db,transport}=await fixture(t);
 await db.createUser({id:'a',displayName:'Synthetic',status:'ACTIVE',timezone:'Asia/Taipei'});
 await db.ensureOnboarding('a',{state:'READY'});
 const admission=await db.admitRuntime();
 const config=betaPilotConfiguration({PHASE4_BETA_PILOT_ID:'a'.repeat(64),PHASE4_BETA_PILOT_USER_ID:'a',
  PHASE4_BETA_PILOT_START_AT:new Date(Date.now()-1000).toISOString(),PHASE4_BETA_PILOT_CONSENT_SHA256:'b'.repeat(64),
  PHASE4_BETA_PILOT_ALLOWANCE_ID:OWNER_PILOT_APPROVAL_SHA256});
 const reservation=reviewedPilotAllowance(OWNER_PILOT_APPROVAL_SHA256);
 const restart=()=>createBetaPilotPermit({db,keys:fixtureKeys,config,reservation});
 const permit=restart(),grant=await permit.reserve();
 return {db,transport,admission,config,grant,restart};
}
function assertOriginalSingleton(state,config) {
 assert.equal(state.attempts,1);assert.equal(state.startAt,config.startAt);assert.equal(state.endAt,config.endAt);
 assert.equal(state.closed,true);
}

test('an actual authenticated closed singleton fences an already issued remote grant without resetting its original dates or attempt',async t=>{
 const {db,transport,config,grant,restart}=await setup(t),before=await rawRecord(db);
 const {signature,...state}=JSON.parse(before),closed={...state,closed:true};
 const detail=JSON.stringify({...closed,signature:fixtureKeys.lookup(['beta-pilot-state-v1',closed])});
 assert.equal((await db.raw.execute({sql:"UPDATE system_heartbeats SET last_detail=? WHERE scope='global' AND component=? AND last_detail=?",
  args:[detail,component,before]})).rowsAffected,1);
 const clocks=transport.counts.byFamily.PILOT_CLOCK??0,sources=physicalSources(transport);
 await assert.rejects(()=>grant.assert(),/BETA_PILOT_DENIED/);
 assert.ok((transport.counts.byFamily.PILOT_CLOCK??0)>clocks,'assertion reads the actual compound authority statement');
 assert.equal(physicalSources(transport),sources);
 await assert.rejects(()=>restart().reserve(),/BETA_PILOT_DENIED/);
 assertOriginalSingleton(await record(db),config);
 assert.equal((await record(db)).fingerprint,state.fingerprint);
});

test('actual READY and lifecycle invalidation durably close the grant; restoring eligibility cannot reopen or refund it',async t=>{
 for(const change of ['READY','LIFECYCLE']) {
  const {db,transport,config,grant,restart}=await setup(t),sources=physicalSources(transport);
  await db.raw.execute(change==='READY'?"UPDATE user_onboarding SET state='ACTION_REQUIRED' WHERE user_id='a'"
   :"UPDATE users SET lifecycle_generation=lifecycle_generation+1 WHERE id='a'");
  await assert.rejects(()=>grant.assert(),/BETA_PILOT_DENIED/);
  assertOriginalSingleton(await record(db),config);
  await db.raw.execute(change==='READY'?"UPDATE user_onboarding SET state='READY' WHERE user_id='a'"
   :"UPDATE users SET lifecycle_generation=lifecycle_generation-1 WHERE id='a'");
  await assert.rejects(()=>restart().reserve(),/BETA_PILOT_DENIED/);
  assertOriginalSingleton(await record(db),config);assert.equal(physicalSources(transport),sources);
 }
});

test('expiry observed from the real compound authority row closes durably; a later database-clock rollback cannot reopen or reset attempts',async t=>{
 const {db,config,grant,restart}=await setup(t),execute=db.raw.execute.bind(db.raw);
 let observed=config.endAt,compoundObservations=0;
 db.raw.execute=async statement=>{
  const result=await execute(statement);
  if(statement?.sql?.includes('observed_at')&&statement.sql.includes('user_onboarding')) {
   assert.equal(result.rows.length,1);
   assert.equal(result.rows[0].lifecycle_generation,1,'the lifecycle value comes from the actual READY row');
   if(statement.sql.includes('last_detail')){assert.equal(typeof result.rows[0].last_detail,'string');compoundObservations++;}
   // Fault-inject only the observed database clock after all real SQL fields
   // have returned. No singleton/lifecycle result is fabricated or bypassed.
   result.rows[0].observed_at=observed;
  }
  return result;
 };
 try {
  await assert.rejects(()=>grant.assert(),/BETA_PILOT_DENIED/);
  const expired=await record(db);assertOriginalSingleton(expired,config);
  assert.equal(expired.lastObservedAt,config.endAt);assert.ok(compoundObservations>0);
  observed=config.startAt+1000;
  await assert.rejects(()=>restart().reserve(),/BETA_PILOT_DENIED/);
  await assert.rejects(()=>grant.assert(),/BETA_PILOT_DENIED/);
  const later=await record(db);assertOriginalSingleton(later,config);
  assert.equal(later.lastObservedAt,config.endAt);assert.equal(later.fingerprint,expired.fingerprint);
 } finally {db.raw.execute=execute;}
});

test('actual owned v32 DRAIN rejects changed or expired job/context leases before health reads and preserves incomplete progress',async t=>{
 const {db,transport,admission,grant}=await setup(t),stores=await createPhase4Foundation({db,keys:fixtureKeys,admission});
 await stores.initializeTenant('a','SHADOW');
 await db.transaction(()=>seedBodyInput(db,bodyInput({asOf:Date.now()-1000,days:1})));
 await stores.queue.sourceChanged(await stores.captureControl('a'));
 const sync=request(),syncClaim=await claim(db,sync);
 await commitPhaseWork(db,sync,syncClaim,{outcome:'NO_NEW_DATA_SUCCESS'},authority);
 const finalized=await finalizePhaseWork(db,sync,syncClaim,fixtureKeys,authority);
 const drain=request({phase:'STAGE6_DRAIN',syncRequestId:sync.requestId,handoff:finalized.handoff}),owner=await claim(db,drain);
 let clock=Date.now();const originalClock=clock;
 const core=await buildPhase4Core({keys:fixtureKeys,admission,now:()=>new Date(clock),authorizeMode:mode=>assert.equal(mode,'SHADOW'),
  processing:{client:db.raw,transaction:db.transaction,active:db.processingTransactionActive,
   withReadSnapshot:db.withProcessingReadSnapshot,assertFences:db.assertRuntimeFences,
   afterCommit:db.afterProcessingCommit,afterCompletion:db.afterProcessingCompletion}}),queue=createReanalysisQueue(core);
 const execute=fn=>withDurableExecution({claim:owner,keys:fixtureKeys,pending:new Set(),authority},fn);
 await withBetaPilotAttempt(grant,'a',()=>db.withRuntimeFence(client=>grant.assert(client),()=>execute(async()=>{
  const context=await core.capture('a',{executionMode:'SHADOW',providerRequired:true});
  const lease=await queue.claim(context,'RECOMPUTE_DERIVED',{leaseMs:1000});assert.ok(lease);
  const sources=physicalSources(transport);
  let callbackEntered=false;
  const business=()=>{callbackEntered=true;return core.root(context,'sleep','sleep-00');};
  try {
   const changes=[
    ["UPDATE phase4_jobs SET lease_owner='SYNTHETIC_FOREIGN_OWNER' WHERE user_id='a' AND execution_mode='SHADOW' AND job_kind='RECOMPUTE_DERIVED'",'PHASE4_LEASE_CAS_LOST'],
    ["UPDATE resource_locks SET owner='SYNTHETIC_REVOKED_CONTEXT' WHERE name LIKE 'p4ctx:%'",'PHASE4_CONTEXT_REVOKED'],
   ];
   for(const [sql,code] of changes) {
    await assert.rejects(()=>db.transaction(async()=>{
     await db.raw.execute(sql);return queue.owned(context,lease,business);
    },{workStep:'synthetic.local.queue-authority-'+code,discardResult:true}),error=>error.code===code);
    assert.equal(callbackEntered,false);assert.equal(physicalSources(transport),sources);
   }
   clock=Date.parse(lease.binding.expiresAt);
   await assert.rejects(()=>queue.owned(context,lease,business),error=>error.code==='PHASE4_LEASE_CAS_LOST');
   assert.equal(callbackEntered,false);assert.equal(physicalSources(transport),sources);
   clock=originalClock+15*60*1000+1;
   await assert.rejects(()=>queue.owned(context,lease,business),error=>error.code==='PHASE4_CONTEXT_EXPIRED');
   assert.equal(callbackEntered,false);assert.equal(physicalSources(transport),sources);
   clock=originalClock;
   const job=(await db.raw.execute("SELECT * FROM phase4_jobs WHERE user_id='a' AND execution_mode='SHADOW' AND job_kind='RECOMPUTE_DERIVED'")).rows[0];
   assert.equal(job.lease_owner,lease.binding.owner);assert.equal(job.full_scan_cursor,null);
   assert.ok(job.completed_generation<job.requested_generation);assert.equal(job.state,'RUNNING');
   assert.equal((await db.raw.execute({sql:'SELECT count(*) n FROM phase4_execution_work_receipts WHERE execution_id=?',args:[drain.requestId]})).rows[0].n,1);
  } finally {clock=originalClock;await queue.abandon(lease);await core.contextRegistry.release(context);}
 })));
});
