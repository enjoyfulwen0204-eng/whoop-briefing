import test from 'node:test';
import assert from 'node:assert/strict';
import { syntheticPhase4Fixture } from './phase4Fixture.js';
import { createPhase4Stage6,authorizeStage6ShadowWorker } from '../src/phase4Reanalysis.js';

const generation=async(f,id='a')=>(await f.db.raw.execute({sql:'SELECT source_generation FROM phase4_user_state WHERE user_id=?',args:[id]})).rows[0].source_generation;
test('Stage 6 semantic timezone/lifecycle/token/access/capability changes coalesce; identical writes do not enqueue twice',async t=>{
  const f=await syntheticPhase4Fixture(t,{targetVersion:28});let expected=0;
  const changed=async fn=>{await fn();assert.equal(await generation(f),++expected);};
  const noop=async fn=>{await fn();assert.equal(await generation(f),expected);};
  await noop(()=>f.db.updateUser('a',{displayName:'New name'}));
  await noop(()=>f.db.updateUser('a',{timezone:'Asia/Taipei'}));
  await changed(()=>f.db.updateUser('a',{timezone:'UTC'}));
  await changed(()=>f.db.transitionUserLifecycle({userId:'a',targetStatus:'DISABLED'}));
  await noop(()=>f.db.transitionUserLifecycle({userId:'a',targetStatus:'DISABLED'}));
  await changed(()=>f.db.transitionUserLifecycle({userId:'a',targetStatus:'ACTIVE'}));
  const tokens={accessToken:'SYNTHETIC',refreshToken:'SYNTHETIC',expiresAt:new Date('2026-10-01T00:00:00Z'),scope:'read:recovery'};
  await changed(()=>f.db.saveTokens('a',tokens));
  await noop(()=>f.db.saveTokens('a',{...tokens,accessToken:'SYNTHETIC_ROTATED'}));
  await changed(()=>f.db.saveTokens('a',tokens,{bumpAuthGeneration:true}));
  const access=()=>f.db.recordResourceAccess('a',[{resource:'recovery',status:'ACCESSIBLE'}],{expectedAuthGeneration:2,expectedLifecycleGeneration:3});
  await changed(access);await noop(access);
  const capabilities=()=>f.db.saveCapabilities('a',[{key:'hrv',status:'SUPPORTED',sampleCount:30}],{expectedLifecycleGeneration:3});
  await changed(capabilities);await noop(capabilities);
  assert.equal(await generation(f,'b'),0);
  const rows=(await f.db.raw.execute("SELECT * FROM phase4_jobs WHERE user_id='a'")).rows;
  assert.equal(rows.length,2);assert.ok(rows.every(row=>row.execution_mode==='SHADOW'&&row.requested_generation===expected));
  for(const row of rows)assert.deepEqual(JSON.parse(row.reason_codes_json),['AUTH_CHANGED','LIFECYCLE_CHANGED','SOURCE_CHANGED','TIMEZONE_CHANGED']);
  assert.equal((await f.db.raw.execute("SELECT count(*) n FROM phase4_computation_state WHERE execution_mode='LIVE'")).rows[0].n,0);
});

test('Stage 6 calculation bundle rollout is explicit, supported, idempotent, and SHADOW-isolated',async t=>{
  const f=await syntheticPhase4Fixture(t,{targetVersion:28});await f.core.initializeTenant('a','LIVE');
  const live=(await f.db.raw.execute("SELECT * FROM phase4_computation_state WHERE user_id='a' AND execution_mode='LIVE'")).rows[0];
  const worker=await createPhase4Stage6({db:f.db,keys:f.keys,executionMode:'SHADOW',workerCapability:authorizeStage6ShadowWorker({executionMode:'SHADOW'})});
  assert.deepEqual(await worker.rolloutAlgorithm({userId:'a'}),{changed:true,inputGeneration:1});
  assert.deepEqual(await worker.rolloutAlgorithm({userId:'a'}),{changed:false,inputGeneration:1});
  await assert.rejects(worker.rolloutAlgorithm({userId:'a',algorithmSetVersion:'invented'}),/ALGORITHM_UNSUPPORTED/);
  assert.deepEqual((await f.db.raw.execute("SELECT * FROM phase4_computation_state WHERE user_id='a' AND execution_mode='LIVE'")).rows[0],live);
  assert.equal(await generation(f),0);
});

test('Stage 6 notification-only preferences do not recalculate health; identical patches preserve their version',async t=>{
  const f=await syntheticPhase4Fixture(t,{targetVersion:28}),control=await f.stores.captureControl('a'),prior=await f.stores.preferences.read(control);
  const same=await f.stores.preferences.update(control,prior.preference_version,{morning_brief_mode:prior.morning_brief_mode});
  assert.deepEqual(same,prior);
  await f.stores.preferences.update(control,prior.preference_version,{notifications_paused:1});
  assert.equal(await generation(f),0);
  await assert.rejects(f.stores.preferences.update(control,prior.preference_version,{notifications_paused:1}),/CAS_LOST/);
});
