import test from 'node:test';
import assert from 'node:assert/strict';
import { syntheticPhase4Fixture } from './phase4Fixture.js';
import { bodyInput,seedBodyInput } from './bodyEnergyFixture.js';
import { createPhase4Redactor } from '../src/phase4Redaction.js';
import { createPhase4Foundation } from '../src/phase4Foundation.js';

const at=Date.parse('2026-09-19T00:00:00.000Z'),date='2026-09-19';
const request={asOfEpochMs:at,targetHealthDate:date};
async function setup(t,options={}) {
  const fixture=await syntheticPhase4Fixture(t,options);
  await fixture.db.transaction(()=>seedBodyInput(fixture.db));
  const context=await fixture.stores.capture('a',{executionMode:'SHADOW'});
  return {...fixture,context};
}

test('Body exact result replay converges with stable salt/hash, rejects arbitrary captures and same-identity content conflicts',async t=>{
  const {stores,db,context}=await setup(t),body=stores.bodyEnergy;
  await assert.rejects(body.persist(context,{kind:'BODY_ENERGY_CAPTURE'}),/CAPTURE_REQUIRED/);
  const tickets=await Promise.all([body.prepare(context,request),body.prepare(context,request)]);
  const results=await Promise.all(tickets.map(ticket=>body.persist(context,ticket)));
  assert.equal(results[0].row.result_id,results[1].row.result_id);assert.equal(results[0].row.input_manifest_hash,results[1].row.input_manifest_hash);
  assert.equal(results[0].row.content_digest_salt,results[1].row.content_digest_salt);assert.equal(results.filter(r=>r.created).length,1);
  assert.equal(results[0].row.value,70);assert.equal(results[0].row.quality_state,'AVAILABLE');
  assert.equal((await body.compute(context,request)).row.result_id,results[0].row.result_id);
  const manifest=results[0].row.input_manifest_json;assert.ok(!manifest.includes('recovery_score'));assert.ok(!manifest.includes('raw_json'));
  await db.raw.execute("UPDATE whoop_sleeps SET sleep_performance_percentage=75 WHERE user_id='a' AND id='sleep-00'");
  const competing=await body.prepare(context,request);
  await assert.rejects(body.persist(context,competing),/IDENTITY_CONTENT_CONFLICT/);
  assert.equal((await body.audit(context,results[0].row.result_id)).row.value,70);
  assert.equal((await body.readExact(context,{healthDate:date,asOfEpochMs:at})).row.result_id,results[0].row.result_id);
});

test('Body separate checkpoint converges on the exact closing instant; same-bucket arbitrary instants remain distinct',async t=>{
  let now=new Date(at+15*60000);const {stores,db,context}=await setup(t,{now:()=>now}),body=stores.bodyEnergy;
  const first=await body.compute(context,request),second=await body.compute(context,{...request,asOfEpochMs:at+14*60000});
  assert.notEqual(first.row.result_id,second.row.result_id);assert.notEqual(first.row.as_of_epoch_ms,second.row.as_of_epoch_ms);
  const closing=await body.compute(context,{...request,asOfEpochMs:at+15*60000});
  const checkpoints=await Promise.all([body.checkpoint(context,{bucketStart:at}),body.checkpoint(context,{bucketStart:at})]);
  assert.equal(checkpoints[0].row.checkpoint_id,checkpoints[1].row.checkpoint_id);assert.equal(checkpoints[0].row.result_id,closing.row.result_id);
  assert.equal(checkpoints[0].result.row.as_of_utc,new Date(at+15*60000).toISOString());
  assert.equal((await body.auditCheckpoint(context,checkpoints[0].row.checkpoint_id)).result.row.as_of_epoch_ms,at+15*60000);
  assert.equal((await db.raw.execute('SELECT count(*) n FROM body_energy_results')).rows[0].n,3);
  await assert.rejects(body.checkpoint(context,{bucketStart:at+1}),/INVALID_CHECKPOINT/);
  await assert.rejects(body.checkpoint(context,{bucketStart:at+900000}),/INVALID_CHECKPOINT/);
  await assert.rejects(body.compute(context,{asOfEpochMs:at+0.5}),/INVALID_EXACT_AS_OF/);
  await assert.rejects(body.compute(context,{asOfEpochMs:at,asOfUtc:'2026-09-19T00:00:00Z'}),/INVALID_EXACT_AS_OF/);
});

test('Corrected inputs create new generation/as-of, leave retained historical manifests intact and never fabricate overwritten history',async t=>{
  let now=new Date(at);const {stores,db,context}=await setup(t,{now:()=>now}),body=stores.bodyEnergy;
  const first=await body.compute(context,request),oldManifest=first.row.input_manifest_json;
  await stores.release(context);
  now=new Date(at+60000);
  await db.raw.execute({sql:"UPDATE whoop_sleeps SET sleep_performance_percentage=75,updated_at=?,synced_at=? WHERE user_id='a' AND id='sleep-00'",args:[now.toISOString(),now.toISOString()]});
  await stores.queue.sourceChanged(await stores.captureControl('a'),{reasonCode:'SOURCE_CHANGED'});
  const next=await stores.capture('a',{executionMode:'SHADOW'});
  const corrected=await body.compute(next,{...request,asOfEpochMs:now.getTime(),supersedesResultId:first.row.result_id});
  assert.equal(corrected.row.value,80);assert.notEqual(corrected.row.result_id,first.row.result_id);
  assert.equal(corrected.row.input_generation,first.row.input_generation+1);
  const audit=await body.audit(next,first.row.result_id);assert.equal(audit.row.input_manifest_json,oldManifest);assert.ok(audit.row.invalidated_at);
  assert.equal(audit.calculation.value,70);assert.equal(Object.hasOwn(audit,'ref'),false);
  await assert.rejects(body.read(next,first.row.result_id),/PARENT_STALE/);
  await assert.rejects(body.compute(next,request),/NOT_REPRODUCIBLE_FROM_RETAINED_INPUTS/);
  assert.equal((await body.readExact(next,{healthDate:date,asOfEpochMs:at,inputGeneration:context.inputGeneration})).calculation.value,70);
  await assert.rejects(body.checkpoint(next,{bucketStart:at-900000}),/NOT_REPRODUCIBLE_FROM_RETAINED_INPUTS/);
  assert.equal((await db.raw.execute('SELECT count(*) n FROM body_energy_checkpoints')).rows[0].n,0);
  // A generation change alone can create a new exact-instant result when its
  // sources really were visible at that instant.
  await stores.release(next);await stores.queue.sourceChanged(await stores.captureControl('a'),{reasonCode:'SOURCE_CHANGED'});
  const latest=await stores.capture('a',{executionMode:'SHADOW'});
  const revision=await body.compute(latest,{...request,asOfEpochMs:now.getTime()});
  assert.notEqual(revision.row.result_id,corrected.row.result_id);assert.equal(revision.row.as_of_epoch_ms,corrected.row.as_of_epoch_ms);
});

test('Body facade is tenant/mode/lifecycle/purge fenced and the public factory cannot issue LIVE',async t=>{
  const {stores,db,keys,context}=await setup(t),body=stores.bodyEnergy;
  const shadow=await body.compute(context,request),other=await stores.capture('b',{executionMode:'SHADOW'});
  await assert.rejects(body.audit(other,shadow.row.result_id),/PARENT_NOT_FOUND/);
  await assert.rejects(body.read({...context,userId:'b'},shadow.row.result_id),/SERVER_CONTEXT_REQUIRED/);
  await stores.initializeTenant('a','LIVE');const live=await stores.capture('a',{executionMode:'LIVE'});
  await assert.rejects(body.audit(live,shadow.row.result_id),/PARENT_NOT_FOUND/);
  const liveResult=await body.compute(live,request);assert.notEqual(liveResult.row.result_id,shadow.row.result_id);
  assert.equal(liveResult.row.value,shadow.row.value);assert.equal(liveResult.row.execution_mode,'LIVE');
  const publicStores=await createPhase4Foundation({db,keys});await assert.rejects(publicStores.capture('a',{executionMode:'LIVE'}),/LIVE_NOT_AUTHORIZED/);
  const ticket=await body.prepare(context,request);await db.raw.execute("UPDATE phase4_user_state SET purge_generation=purge_generation+1,pending_purge_count=1 WHERE user_id='a'");
  await assert.rejects(body.persist(context,ticket),/PURGE_FENCED/);await assert.rejects(body.audit(context,shadow.row.result_id),/PURGE_FENCED/);
  assert.equal((await db.raw.execute('SELECT count(*) n FROM outbound_messages')).rows[0].n,0);
  assert.equal((await db.raw.execute('SELECT count(*) n FROM telegram_operations')).rows[0].n,0);
});

test('Body null results persist explicit unanchored days and all retained exact JS Date instants are representable',async t=>{
  const {stores}=await syntheticPhase4Fixture(t),context=await stores.capture('a',{executionMode:'SHADOW'});
  const result=await stores.bodyEnergy.compute(context,{asOfEpochMs:at,targetHealthDate:'2026-09-18'});
  assert.equal(result.row.value,null);assert.equal(result.row.quality_state,'UNAVAILABLE');assert.equal(result.manifest.day_assignment,'REQUESTED_UNANCHORED');
  const automatic=await stores.bodyEnergy.compute(context,{asOfEpochMs:at});assert.equal(automatic.manifest.day_assignment,'AS_OF_UNANCHORED');
  const earliest=await stores.bodyEnergy.compute(context,{asOfEpochMs:-8640000000000000});
  assert.equal(earliest.row.as_of_utc,'-271821-04-20T00:00:00.000Z');assert.equal(earliest.row.as_of_epoch_ms,-8640000000000000);
});

test('Health-date discrepancies enqueue dormant same-mode repair and stale timezone/capture authority is rejected',async t=>{
  const {stores,db,context,core}=await setup(t),body=stores.bodyEnergy;
  await db.raw.execute("UPDATE whoop_sleeps SET health_date='2026-09-18' WHERE user_id='a' AND id='sleep-00'");
  const result=await body.compute(context,request);assert.equal(result.row.quality_state,'DEGRADED');
  const job=await stores.queue.read(context,'REPAIR_CURRENTNESS');assert.equal(job.state,'PENDING');assert.equal(job.scope_kind,'FULL_TENANT_RECOMPUTE');
  assert.equal(job.requested_generation,context.inputGeneration);assert.equal(job.reason_codes_json,'["REPAIR_REQUIRED"]');
  assert.equal((await db.raw.execute("SELECT count(*) n FROM phase4_jobs WHERE execution_mode='LIVE'")).rows[0].n,0);
  const source=await stores.root(context,'sleep','sleep-00'),ticket=await body.prepare(context,request);
  await stores.cache.set(context,'sensitive-copy',{synthetic:'health'});
  await db.raw.execute("UPDATE users SET timezone='America/New_York' WHERE id='a'");
  await assert.rejects(body.persist(context,ticket),/TIMEZONE_FENCED/);
  assert.equal(core.contextRegistry.get(context,'sensitive-copy'),undefined);
  assert.throws(()=>core.validateReferences(context,[source.ref]),/SNAPSHOT_EVICTED/);
  await stores.release(context);await assert.rejects(body.persist(context,ticket),/CONTEXT_RELEASED/);
});

test('An uncaptured old source whose corrected end moved into the future is not reconstructed from an older substitute',async t=>{
  let now=new Date(at);const {stores,db,context}=await setup(t,{now:()=>now});
  await db.raw.execute({sql:"UPDATE whoop_sleeps SET end_at=?,updated_at=?,synced_at=? WHERE user_id='a' AND id='sleep-00'",
    args:[new Date(at+3600000).toISOString(),new Date(at+60000).toISOString(),new Date(at+60000).toISOString()]});
  await assert.rejects(stores.bodyEnergy.compute(context,request),/NOT_REPRODUCIBLE_FROM_RETAINED_INPUTS/);
  assert.equal((await db.raw.execute('SELECT count(*) n FROM body_energy_results')).rows[0].n,0);
});

test('The actual redactor removes Body and checkpoint health content while stable opaque lookup barriers prevent rehydration',async t=>{
  const {stores,db,core,context}=await setup(t),body=stores.bodyEnergy;
  const result=await body.compute(context,request),checkpoint=await body.checkpoint(context,{bucketStart:at-900000});
  const redactor=createPhase4Redactor(core),purge={operation_kind:'INCIDENT',purge_generation:1};
  // Unit-test the real shared policy directly; this does not invent a Journal
  // dependency or expose a new production incident-admission route.
  await db.transaction(async()=>{
    for(const [type,row] of [['body_energy_checkpoints',checkpoint.row],['body_energy_results',result.row]]) {
      const node={type,mode:'SHADOW',id:row.privacy_artifact_id};
      const status=await redactor.apply('a',node,purge);await redactor.verify('a',node,status);
    }
  });
  await assert.rejects(body.audit(context,result.row.result_id),/CONTENT_REDACTED/);
  await assert.rejects(body.compute(context,request),/CONTENT_REDACTED/);
  await assert.rejects(body.readExact(context,{healthDate:date,asOfEpochMs:at}),/CONTENT_REDACTED/);
  await assert.rejects(body.checkpoint(context,{bucketStart:at-900000}),/CONTENT_REDACTED/);
  const row=(await db.raw.execute('SELECT * FROM body_energy_results')).rows[0];
  assert.equal(row.content_digest_salt,null);assert.equal(row.input_manifest_json,null);assert.equal(row.value,null);
  assert.equal(row.result_lookup_key,result.row.result_lookup_key);assert.equal(row.result_hash,result.row.result_hash);
  assert.equal((await db.raw.execute('SELECT count(*) n FROM whoop_sleeps')).rows[0].n,31);
});
