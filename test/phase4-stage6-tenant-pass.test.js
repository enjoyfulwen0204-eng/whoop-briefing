import test from 'node:test';
import assert from 'node:assert/strict';
import { syntheticPhase4Fixture } from './phase4Fixture.js';
import { createReanalysisQueue } from '../src/phase4ReanalysisQueue.js';
import { createPhase4Stage6,authorizeStage6ShadowWorker } from '../src/phase4Reanalysis.js';
import { runPhase4Stage6 } from '../src/shadowDrainScheduler.js';
import { durable } from './stage5ReviewBFixture.js';
const T='2026-09-25T01:30:00.000Z';
const enqueue=(f,id)=>f.stores.captureControl(id).then(c=>f.stores.queue.sourceChanged(c));
const worker=(f,now)=>createPhase4Stage6({db:f.db,keys:f.keys,executionMode:'SHADOW',
  workerCapability:authorizeStage6ShadowWorker({executionMode:'SHADOW'}),now});

for(const provider of ['github','cloudflare','event','manual'])test(`R6-02 ${provider}: same-tenant other kind excluded; limit-one selection reaches another tenant`,async t=>{
  const now=()=>new Date(T),f=await syntheticPhase4Fixture(t,{targetVersion:28,now});
  await enqueue(f,'a');await enqueue(f,'b');
  const q=createReanalysisQueue(f.core),c=await f.stores.capture('a',{executionMode:'SHADOW'});
  const lease=await q.claim(c,'RECOMPUTE_DERIVED');assert.ok(lease);
  const restart=await f.restart(),q2=createReanalysisQueue(restart.core),c2=await restart.stores.capture('a',{executionMode:'SHADOW'});
  assert.equal(await q2.claim(c2,'REPAIR_CURRENTNESS'),null);
  assert.deepEqual((await q2.select({limit:1})).map(row=>row.userId),['b']);
  const result=await runPhase4Stage6({db:f.db,worker:await worker(f,now),triggerSource:provider,now:now()});
  assert.equal(result.failedJobs,0);assert.equal(result.claimedJobs,1);
  assert.equal((await f.db.raw.execute("SELECT state FROM phase4_jobs WHERE user_id='a' AND job_kind='REPAIR_CURRENTNESS'")).rows[0].state,'PENDING');
  await q.release(c,lease);await f.stores.release(c);await restart.stores.release(c2);
  assert.equal((await f.db.raw.execute("SELECT count(*) n FROM resource_locks WHERE name LIKE 'phase4-stage6-pass:%'")).rows[0].n,0);
});

test('R6-02 owner death: expiry allows takeover across kinds; stale owner cannot write, settle or delete the new tenant lease',async t=>{
  let clock=new Date(T);const f=await syntheticPhase4Fixture(t,{targetVersion:28,now:()=>clock});await enqueue(f,'a');
  const q=createReanalysisQueue(f.core),c=await f.stores.capture('a',{executionMode:'SHADOW'}),old=await q.claim(c,'RECOMPUTE_DERIVED',{leaseMs:1000});
  clock=new Date(clock.getTime()+1001);const restarted=await f.restart(),q2=createReanalysisQueue(restarted.core);
  const c2=await restarted.stores.capture('a',{executionMode:'SHADOW'}),next=await q2.claim(c2,'REPAIR_CURRENTNESS');assert.ok(next);
  await assert.rejects(q.owned(c,old,()=>assert.fail('stale worker entered')),{code:'PHASE4_LEASE_CAS_LOST'});
  await assert.rejects(q.end(c,old,async()=>[]),{code:'PHASE4_LEASE_CAS_LOST'});
  await q.abandon(old);await q2.check(c2,next);await q2.release(c2,next);
  await f.stores.release(c);await restarted.stores.release(c2);
});

for(const lost of ['tenant','job'])test(`R6-02 ${lost} ownership lost alone fences derived writes and full completion`,async t=>{
  const f=await syntheticPhase4Fixture(t,{targetVersion:28,now:()=>new Date(T)});await enqueue(f,'a');
  const q=createReanalysisQueue(f.core),c=await f.stores.capture('a',{executionMode:'SHADOW'}),lease=await q.claim(c,'RECOMPUTE_DERIVED');
  const proof=await q.end(c,lease,async()=>[]);
  if(lost==='tenant')await f.db.raw.execute({sql:'UPDATE resource_locks SET owner=? WHERE name=?',args:['replacement',lease.binding.tenantPass]});
  else await f.db.raw.execute("UPDATE phase4_jobs SET lease_owner='replacement' WHERE user_id='a' AND job_kind='RECOMPUTE_DERIVED'");
  const before=await durable(f);
  await assert.rejects(q.owned(c,lease,()=>f.stores.bodyEnergy.compute(c,{asOfEpochMs:Date.parse(T)})),{code:'PHASE4_LEASE_CAS_LOST'});
  await assert.rejects(q.complete(c,lease,proof),{code:'PHASE4_LEASE_CAS_LOST'});
  assert.deepEqual(await durable(f),before);await q.abandon(lease);await f.stores.release(c);
});

test('R6-02 tenant ownership lost in a deferred check rolls back the derived write at commit',async t=>{
  const f=await syntheticPhase4Fixture(t,{targetVersion:28,now:()=>new Date(T)});await enqueue(f,'a');
  const q=createReanalysisQueue(f.core),c=await f.stores.capture('a',{executionMode:'SHADOW'}),lease=await q.claim(c,'RECOMPUTE_DERIVED');
  const before=await durable(f);
  await assert.rejects(q.owned(c,lease,async()=>{
    await f.stores.bodyEnergy.compute(c,{asOfEpochMs:Date.parse(T)});
    await f.db.transaction(async()=>{}, {beforeCommit:()=>f.db.raw.execute({sql:'DELETE FROM resource_locks WHERE name=?',args:[lease.binding.tenantPass]})});
  }),{code:'PHASE4_LEASE_CAS_LOST'});
  assert.deepEqual(await durable(f),before);await q.abandon(lease);await f.stores.release(c);
});
