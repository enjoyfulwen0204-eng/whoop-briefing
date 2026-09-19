import test from 'node:test';
import assert from 'node:assert/strict';
import { createPhase4Foundation } from '../src/phase4Foundation.js';
import { foundationFlags, FOUNDATION_FLAGS } from '../src/phase4Flags.js';
import { syntheticPhase4Fixture } from './phase4Fixture.js';

test('Foundation contexts are explicit, branded, tenant-bound, generation-fenced and SHADOW-only in the public factory',async t=>{
  const {db,keys,stores}=await syntheticPhase4Fixture(t);
  const publicStore=await createPhase4Foundation({db,keys});
  await assert.rejects(publicStore.capture('a'),/EXECUTION_MODE_REQUIRED/);
  await assert.rejects(publicStore.capture('a',{executionMode:'LIVE'}),/LIVE_NOT_AUTHORIZED/);
  await assert.rejects(publicStore.capture('a',{executionMode:'unknown'}),/EXECUTION_MODE_REQUIRED/);
  const context=await publicStore.capture('a',{executionMode:'SHADOW'});
  await assert.rejects(publicStore.assertCurrent({...context}),/SERVER_CONTEXT_REQUIRED/);
  await assert.rejects(stores.assertCurrent(context),/SERVER_CONTEXT_REQUIRED/);
  await assert.rejects(publicStore.root(context,'USER','b'),/CROSS_TENANT_REFERENCE/);
  await db.raw.execute("UPDATE phase4_computation_state SET input_generation=input_generation+1 WHERE user_id='a' AND execution_mode='SHADOW'");
  await assert.rejects(publicStore.assertCurrent(context),/INPUT_FENCED/);
  const b=await publicStore.capture('b',{executionMode:'SHADOW'});await publicStore.assertCurrent(b);
  assert.ok(Object.values(FOUNDATION_FLAGS).every(v=>v===false));
  assert.throws(()=>foundationFlags({PHASE4_OUTBOUND_DELIVERY:'true'}),/RUNTIME_NOT_AUTHORIZED/);
});

test('Shared preferences require separate source-control authority and expected version CAS',async t=>{
  const {stores}=await syntheticPhase4Fixture(t);
  const shadow=await stores.capture('a',{executionMode:'SHADOW'});
  await assert.rejects(stores.preferences.update(shadow,0,{notifications_paused:1}),/SOURCE_CONTROL_REQUIRED/);
  const control=await stores.captureControl('a');
  assert.equal((await stores.preferences.read(control)).preference_version,0);
  const result=await stores.preferences.update(control,0,{notifications_paused:1});assert.equal(result.preference_version,1);
  await assert.rejects(stores.preferences.update(control,0,{notifications_paused:0}),/CAS_LOST/);
  await assert.rejects(stores.preferences.update(control,1,{user_id:'b'}),/INVALID_PREFERENCE_PATCH/);
  assert.equal((await stores.preferences.read(await stores.captureControl('b'))).notifications_paused,0);
});

test('Source fanout advances existing modes only; LIVE starts fresh, and FULL cannot fake completion',async t=>{
  let time=new Date('2026-09-19T00:00:00.000Z');
  const {stores,db}=await syntheticPhase4Fixture(t,{now:()=>time});
  const shadow=await stores.capture('a',{executionMode:'SHADOW'});
  await assert.rejects(stores.queue.sourceChanged(shadow),/SOURCE_CONTROL_REQUIRED/);
  assert.equal((await db.raw.execute("SELECT count(*) n FROM phase4_computation_state WHERE execution_mode='LIVE'")).rows[0].n,0);
  await stores.initializeTenant('a','LIVE');
  const live=(await db.raw.execute("SELECT * FROM phase4_computation_state WHERE user_id='a' AND execution_mode='LIVE'")).rows[0];
  assert.equal(live.input_generation,1);assert.equal(live.last_completed_generation,0);
  const control=await stores.captureControl('a');
  await stores.queue.sourceChanged(control,{reasonCode:'SOURCE_CHANGED'});
  const modes=(await db.raw.execute("SELECT execution_mode,input_generation,source_generation_seen,last_completed_generation FROM phase4_computation_state WHERE user_id='a' ORDER BY execution_mode")).rows;
  assert.deepEqual(modes.map(r=>[r.execution_mode,r.input_generation,r.source_generation_seen,r.last_completed_generation]),[['LIVE',2,1,0],['SHADOW',1,1,0]]);
  await assert.rejects(stores.assertCurrent(shadow),/INPUT_FENCED/);
  const current=await stores.capture('a',{executionMode:'SHADOW'}),jobKind='RECOMPUTE_DERIVED';
  const job=await stores.queue.read(current,jobKind);assert.equal(job.freshness,'PENDING');assert.equal(job.affected_from,null);
  const lease=await stores.queue.claim(current,{jobKind,owner:'worker-1',leaseMs:1000});assert.ok(lease);
  assert.equal(await stores.queue.claim(current,{jobKind,owner:'worker-2'}),null);
  await assert.rejects(stores.queue.complete(current,lease),/FULL_PASS_NOT_AUTHORIZED/);
  time=new Date('2026-09-19T00:00:02.000Z');
  const replacement=await stores.queue.claim(current,{jobKind,owner:'worker-2'});assert.equal(replacement.owner,'worker-2');
  await assert.rejects(stores.queue.fail(current,{...replacement},{errorCode:'CALCULATION_FAILED'}),/SERVER_LEASE_REQUIRED/);
  await assert.rejects(stores.queue.fail(current,lease,{errorCode:'CALCULATION_FAILED'}),/LEASE_CAS_LOST/);
  const failed=await stores.queue.fail(current,replacement,{errorCode:'CALCULATION_FAILED'});
  assert.equal(failed.state,'RETRY_WAIT');assert.equal(failed.completed_generation,0);assert.equal(failed.scope_kind,'FULL_TENANT_RECOMPUTE');
  assert.equal(await stores.queue.claim(current,{jobKind,owner:'before-backoff'}),null);
  const b=await stores.capture('b',{executionMode:'SHADOW'});
  await assert.rejects(stores.queue.complete(b,lease),/LEASE_SCOPE_MISMATCH/);
  assert.equal((await db.raw.execute("SELECT count(*) n FROM phase4_jobs WHERE user_id='b'")).rows[0].n,0);
});
