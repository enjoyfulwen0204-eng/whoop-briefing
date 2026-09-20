import test from 'node:test';
import assert from 'node:assert/strict';
import { syntheticPhase4Fixture } from './phase4Fixture.js';
import { seedBodyInput,bodyInput } from './bodyEnergyFixture.js';
import { HEALTH_REDACTED } from '../src/phase4V22Backfill.js';

const at='2026-09-19T00:00:00.000Z';
function input(amount=100,key='create-1') {
  const sourceText=`caffeine ${amount}mg`;
  return {sourceEventKey:key,sourceText,candidate:{category:'caffeine',eventAt:at,valueKind:'NUMERIC',numericValue:amount,unit:'mg',
    exposureState:'EXPOSED',extractionConfidence:1,excerptStart:0,excerptEnd:[...sourceText].length}};
}

test('Journal create is source-controller-only, validated, idempotent and atomically invalidates without touching another tenant',async t=>{
  const {stores,db}=await syntheticPhase4Fixture(t),control=await stores.captureControl('a');
  const c=await stores.capture('a',{executionMode:'SHADOW'});await assert.rejects(stores.journal.create(c,input()),/SOURCE_CONTROL_REQUIRED/);await stores.release(c);
  const first=await stores.journal.create(control,input()),replay=await stores.journal.create(control,{...input(),candidate:{userId:'b'}});
  assert.equal(first.status,'ACCEPT');assert.equal(first.revision,1);assert.equal(replay.created,false);assert.equal(replay.logicalFactId,first.logicalFactId);
  const state=(await db.raw.execute("SELECT * FROM phase4_user_state WHERE user_id='a'")).rows[0];assert.equal(state.source_generation,1);
  assert.equal((await db.raw.execute("SELECT count(*) n FROM phase4_jobs WHERE execution_mode='LIVE'")).rows[0].n,0);
  const current=await stores.capture('a',{executionMode:'SHADOW'}),row=await stores.journal.read(current,first.logicalFactId);
  assert.equal(row.row.numeric_value,100);assert.equal(row.row.raw_answer_excerpt,'caffeine 100mg');assert.equal((await stores.journal.list(current)).length,1);
  assert.equal((await stores.journal.classify(current,{factor:'caffeine',windowStart:'2026-09-18T23:00:00Z',windowEnd:'2026-09-19T01:00:00Z'})).state,'EXPOSED');
  assert.equal((await stores.journal.classify(current,{factor:'alcohol',windowStart:'2026-09-18T23:00:00Z',windowEnd:'2026-09-19T01:00:00Z'})).state,'UNKNOWN');
  const other=await stores.capture('b',{executionMode:'SHADOW'});assert.equal(await stores.journal.read(other,first.logicalFactId),null);
  const ambiguous=input(100,'ambiguous');ambiguous.candidate.extractionConfidence=0.74;
  assert.equal((await stores.journal.create(control,ambiguous)).status,'REQUIRE_CLARIFICATION');
  assert.equal((await db.raw.execute('SELECT count(*) n FROM journal_events')).rows[0].n,1);
});

test('Journal correction redacts prior revision, preserves its immutable identity, and delete removes all revisions with a permanent no-resurrection tombstone',async t=>{
  const {stores,db}=await syntheticPhase4Fixture(t),control=await stores.captureControl('a');
  const first=await stores.journal.create(control,input()),secondInput=input(200);
  const corrected=await stores.journal.correct(control,{logicalFactId:first.logicalFactId,expectedRevision:1,idempotencyKey:'correct-1',...secondInput});
  await assert.rejects(stores.capture('a',{executionMode:'SHADOW'}),/PURGE_FENCED/);
  await stores.privacy.complete(control,corrected.purgeId);
  const rows=(await db.raw.execute('SELECT * FROM journal_events ORDER BY revision')).rows;
  assert.equal(rows.length,2);assert.equal(rows[0].content_state,'REDACTED');assert.equal(rows[0].category,HEALTH_REDACTED);
  assert.equal(rows[0].numeric_value,null);assert.equal(rows[0].raw_answer_excerpt,null);assert.equal(rows[0].fact_status,'SUPERSEDED');
  assert.equal(rows[1].numeric_value,200);assert.equal(rows[1].logical_fact_id,rows[0].logical_fact_id);assert.equal(rows[1].revision,2);
  assert.equal(rows[1].supersedes_event_id,rows[0].id);assert.notEqual(rows[1].privacy_artifact_id,rows[0].privacy_artifact_id);
  assert.equal((await db.raw.execute({sql:'SELECT count(*) n FROM phase4_source_links WHERE artifact_id=? OR source_id=?',args:[rows[0].privacy_artifact_id,rows[0].privacy_artifact_id]})).rows[0].n,0);
  assert.equal((await stores.journal.correct(control,{logicalFactId:first.logicalFactId,expectedRevision:1,idempotencyKey:'correct-1'})).purgeId,corrected.purgeId);
  const deleted=await stores.journal.remove(control,{logicalFactId:first.logicalFactId,idempotencyKey:'delete-1'});await stores.privacy.complete(control,deleted.purgeId);
  assert.equal((await db.raw.execute('SELECT count(*) n FROM journal_events')).rows[0].n,0);
  const tombstone=(await db.raw.execute('SELECT * FROM journal_event_tombstones')).rows[0];
  assert.deepEqual(Object.keys(tombstone).sort(),['deleted_at','deletion_idempotency_key','logical_fact_id','source_event_hash','user_id']);
  assert.equal((await stores.journal.create(control,input())).redacted,true);
  const fresh=await stores.capture('a',{executionMode:'SHADOW'});
  assert.equal((await stores.journal.classify(fresh,{factor:'caffeine',windowStart:'2026-09-18T23:00:00Z',windowEnd:'2026-09-19T01:00:00Z'})).state,'UNKNOWN');
});

test('Late wake alignment is an explicit new purged revision and never deletes independent WHOOP canonical records',async t=>{
  const {stores,db}=await syntheticPhase4Fixture(t),control=await stores.captureControl('a');
  const data=input();data.candidate.eventAt='2026-09-18T21:00:00.000Z';data.sourceText+=' at '+data.candidate.eventAt;
  data.candidate.excerptEnd=[...data.sourceText].length;
  const fact=await stores.journal.create(control,data);
  let row=(await db.raw.execute('SELECT * FROM journal_events')).rows[0];assert.equal(row.health_date,'2026-09-19');assert.equal(row.health_date_alignment,'PROVISIONAL');
  await db.transaction(()=>seedBodyInput(db,bodyInput()));
  const newControl=await stores.captureControl('a');
  const changed=await stores.journal.realign(newControl,{logicalFactId:fact.logicalFactId,expectedRevision:1,idempotencyKey:'realign-1'});
  await stores.privacy.complete(newControl,changed.purgeId);
  row=(await db.raw.execute("SELECT * FROM journal_events WHERE fact_status='ACTIVE'")).rows[0];
  assert.equal(row.revision,2);assert.equal(row.health_date,'2026-09-18');assert.equal(row.health_date_alignment,'ALIGNED');
  assert.equal(row.numeric_value,100);assert.equal((await db.raw.execute('SELECT count(*) n FROM whoop_sleeps')).rows[0].n,31);
  assert.equal((await stores.journal.realign(newControl,{logicalFactId:fact.logicalFactId,expectedRevision:2,idempotencyKey:'same-alignment'})).changed,false);
  const deletion=await stores.journal.remove(newControl,{logicalFactId:fact.logicalFactId,idempotencyKey:'delete-aligned'});
  await stores.privacy.complete(newControl,deletion.purgeId);
  assert.equal((await db.raw.execute('SELECT count(*) n FROM whoop_sleeps')).rows[0].n,31);
});

test('Expired correction staging is physically destroyed outside failed T1; only a freshly validated same-subject assertion can resume the original fence',async t=>{
  let now=new Date(at);const f=await syntheticPhase4Fixture(t,{now:()=>now}),{stores,db}=f,control=await stores.captureControl('a');
  const fact=await stores.journal.create(control,input());
  await db.raw.execute("CREATE TRIGGER synthetic_stage_failure BEFORE UPDATE ON journal_events BEGIN SELECT RAISE(ABORT,'synthetic_stage_failure'); END");
  await assert.rejects(stores.journal.correct(control,{logicalFactId:fact.logicalFactId,expectedRevision:1,idempotencyKey:'expire-correction',...input(200)}),/synthetic_stage_failure/);
  const purge=(await db.raw.execute('SELECT * FROM health_plaintext_purges')).rows[0];
  assert.equal((await db.raw.execute('SELECT count(*) n FROM health_purge_replacements')).rows[0].n,1);
  await assert.rejects(stores.privacy.admit(control,{targetType:'JOURNAL_FACT',targetId:fact.logicalFactId,idempotencyKey:'competing-deletion'}),/SUBJECT_PURGE_PENDING/);
  await db.raw.execute('DROP TRIGGER synthetic_stage_failure');now=new Date(now.getTime()+30*86400000);
  await assert.rejects(stores.privacy.redact(control,purge.purge_id),/REPLACEMENT_EXPIRED/);
  assert.equal((await db.raw.execute('SELECT count(*) n FROM health_purge_replacements')).rows[0].n,0);
  assert.equal((await db.raw.execute("SELECT count(*) n FROM phase4_source_links WHERE artifact_type='health_purge_replacements'")).rows[0].n,0);
  assert.equal((await db.raw.execute("SELECT pending_purge_count FROM phase4_user_state WHERE user_id='a'")).rows[0].pending_purge_count,1);
  await assert.rejects(stores.journal.resumeCorrection(await stores.captureControl('b'),{purgeId:purge.purge_id,expectedRevision:1,...input(300)}),/PURGE_NOT_FOUND/);
  assert.equal((await stores.journal.resumeCorrection(control,{purgeId:purge.purge_id,expectedRevision:1,...input(300)})).purgeId,purge.purge_id);
  await stores.privacy.complete(control,purge.purge_id);
  const current=(await db.raw.execute("SELECT * FROM journal_events WHERE fact_status='ACTIVE'")).rows[0];assert.equal(current.numeric_value,300);assert.equal(current.revision,2);
  assert.equal((await db.raw.execute('SELECT count(*) n FROM health_plaintext_purges')).rows[0].n,1);
});

test('A valid unexpired correction staging cannot be replaced by arbitrary content or cross-tenant authority',async t=>{
  const f=await syntheticPhase4Fixture(t),{stores,db}=f,control=await stores.captureControl('a'),fact=await stores.journal.create(control,input());
  await db.raw.execute("CREATE TRIGGER synthetic_unexpired_failure BEFORE UPDATE ON journal_events BEGIN SELECT RAISE(ABORT,'synthetic_unexpired_failure'); END");
  await assert.rejects(stores.journal.correct(control,{logicalFactId:fact.logicalFactId,expectedRevision:1,idempotencyKey:'unexpired',...input(200)}),/synthetic_unexpired_failure/);
  const purge=(await db.raw.execute('SELECT * FROM health_plaintext_purges')).rows[0],before=(await db.raw.execute('SELECT * FROM health_purge_replacements')).rows[0];
  await db.raw.execute('DROP TRIGGER synthetic_unexpired_failure');
  await assert.rejects(stores.journal.resumeCorrection(control,{purgeId:purge.purge_id,expectedRevision:1,...input(300)}),/REPLACEMENT_NOT_EXPIRED/);
  await assert.rejects(stores.journal.resumeCorrection(await stores.captureControl('b'),{purgeId:purge.purge_id,expectedRevision:1,...input(300)}),/PURGE_NOT_FOUND/);
  await assert.rejects(stores.journal.resumeCorrection({}, {purgeId:purge.purge_id,expectedRevision:1,...input(300)}),/SOURCE_CONTROL_REQUIRED/);
  assert.deepEqual((await db.raw.execute('SELECT * FROM health_purge_replacements')).rows[0],before);
  assert.equal((await db.raw.execute("SELECT pending_purge_count FROM phase4_user_state WHERE user_id='a'")).rows[0].pending_purge_count,1);
  await stores.privacy.redact(control,purge.purge_id);await stores.privacy.complete(control,purge.purge_id);
  assert.equal((await db.raw.execute("SELECT numeric_value FROM journal_events WHERE fact_status='ACTIVE'")).rows[0].numeric_value,200);
});

test('Authenticated restaging replaces stale unexpired authority atomically and converges once after lifecycle, auth or timezone drift',async t=>{
  const scenarios=[
    ['lifecycle',async ({db})=>{await db.transitionUserLifecycle({userId:'a',targetStatus:'DISABLED'});await db.transitionUserLifecycle({userId:'a',targetStatus:'ACTIVE'});}],
    ['authorization',async ({db,core})=>db.raw.execute({sql:`INSERT INTO user_whoop_tokens
      (user_id,access_token,refresh_token,access_token_expires_at,updated_at,auth_generation) VALUES ('a','synthetic','synthetic',?,?,1)`,
      args:[new Date(core.now().getTime()+3600000).toISOString(),core.timestamp()]})],
    ['timezone',async ({db})=>db.updateUser('a',{timezone:'UTC'})],
  ];
  for(const [name,drift] of scenarios)await t.test(name,async t=>{
    const f=await syntheticPhase4Fixture(t),{stores,db}=f,control=await stores.captureControl('a'),fact=await stores.journal.create(control,input());
    await db.raw.execute({sql:`CREATE TRIGGER synthetic_${name}_failure BEFORE UPDATE ON journal_events BEGIN SELECT RAISE(ABORT,'synthetic_${name}_failure'); END`});
    await assert.rejects(stores.journal.correct(control,{logicalFactId:fact.logicalFactId,expectedRevision:1,idempotencyKey:`${name}-restage`,...input(200)}),
      new RegExp(`synthetic_${name}_failure`));
    const purge=(await db.raw.execute('SELECT * FROM health_plaintext_purges')).rows[0],oldStage=(await db.raw.execute('SELECT * FROM health_purge_replacements')).rows[0];
    const counters=(await db.raw.execute("SELECT purge_generation,pending_purge_count FROM phase4_user_state WHERE user_id='a'")).rows[0];
    await drift(f);
    if(name!=='timezone')await assert.rejects(stores.journal.resumeCorrection(control,{purgeId:purge.purge_id,expectedRevision:1,...input(300)}),
      name==='lifecycle'?/LIFECYCLE_FENCED/:/AUTH_FENCED/);
    const freshControl=await stores.captureControl('a');
    const invalid=input(300);invalid.candidate.extractionConfidence=0.5;
    assert.equal((await stores.journal.resumeCorrection(freshControl,{purgeId:purge.purge_id,expectedRevision:1,...invalid})).status,'REQUIRE_CLARIFICATION');
    assert.deepEqual((await db.raw.execute('SELECT * FROM health_purge_replacements')).rows[0],oldStage);
    await assert.rejects(stores.journal.resumeCorrection(freshControl,{purgeId:purge.purge_id,expectedRevision:1,...input(300)}),
      new RegExp(`synthetic_${name}_failure`));
    const freshStage=(await db.raw.execute('SELECT * FROM health_purge_replacements')).rows[0],value=JSON.parse(freshStage.normalized_replacement_json);
    assert.equal(value.fact.numeric_value,300);assert.notEqual(freshStage.normalized_replacement_json,oldStage.normalized_replacement_json);
    assert.equal((await db.raw.execute('SELECT count(*) n FROM health_purge_replacements')).rows[0].n,1);
    const links=(await db.raw.execute("SELECT relationship FROM phase4_source_links WHERE artifact_type='health_purge_replacements'")).rows;
    assert.equal(links.length,1);assert.ok(links[0].relationship.includes(freshStage.replacement_source_key));
    assert.ok(!links[0].relationship.includes(oldStage.replacement_source_key));
    assert.equal((await db.raw.execute('SELECT purge_generation FROM health_plaintext_purges')).rows[0].purge_generation,purge.purge_generation);
    assert.deepEqual((await db.raw.execute("SELECT purge_generation,pending_purge_count FROM phase4_user_state WHERE user_id='a'")).rows[0],counters);
    await db.raw.execute(`DROP TRIGGER synthetic_${name}_failure`);
    assert.equal((await stores.journal.resumeCorrection(freshControl,{purgeId:purge.purge_id,expectedRevision:1,...input(300)})).purgeId,purge.purge_id);
    assert.equal((await db.raw.execute('SELECT count(*) n FROM health_purge_replacements')).rows[0].n,0);
    assert.equal((await db.raw.execute("SELECT count(*) n FROM phase4_source_links WHERE artifact_type='health_purge_replacements'")).rows[0].n,0);
    await stores.privacy.complete(freshControl,purge.purge_id);await stores.privacy.complete(freshControl,purge.purge_id);
    const current=(await db.raw.execute("SELECT * FROM journal_events WHERE fact_status='ACTIVE'")).rows[0];
    assert.equal(current.numeric_value,300);assert.equal(current.revision,2);
    const final=(await db.raw.execute("SELECT purge_generation,pending_purge_count FROM phase4_user_state WHERE user_id='a'")).rows[0];
    assert.equal(final.purge_generation,counters.purge_generation);assert.equal(final.pending_purge_count,0);
    assert.equal((await db.raw.execute('SELECT state FROM health_plaintext_purges')).rows[0].state,'COMPLETE');
  });
});

test('A later deletion may finish before the earlier correction cache acknowledgment without invalidating T2 proof or leaving old revision edges',async t=>{
  const {stores,db}=await syntheticPhase4Fixture(t),control=await stores.captureControl('a'),fact=await stores.journal.create(control,input());
  const old=await stores.capture('a',{executionMode:'SHADOW'});await stores.journal.read(old,fact.logicalFactId);
  const correction=await stores.journal.correct(control,{logicalFactId:fact.logicalFactId,expectedRevision:1,idempotencyKey:'first',...input(200)});
  const deletion=await stores.journal.remove(control,{logicalFactId:fact.logicalFactId,idempotencyKey:'second'});
  await assert.rejects(stores.privacy.complete(control,correction.purgeId),/CACHE_ACK_PENDING/);await stores.release(old);
  await stores.privacy.complete(control,deletion.purgeId);await stores.privacy.complete(control,correction.purgeId);
  assert.equal((await db.raw.execute("SELECT pending_purge_count FROM phase4_user_state WHERE user_id='a'")).rows[0].pending_purge_count,0);
  assert.equal((await db.raw.execute('SELECT count(*) n FROM journal_events')).rows[0].n,0);
  assert.equal((await db.raw.execute("SELECT count(*) n FROM phase4_source_links WHERE source_type='JOURNAL_FACT' OR artifact_type='journal_events'")).rows[0].n,0);
  assert.match((await db.raw.execute('SELECT source_event_hash FROM journal_event_tombstones')).rows[0].source_event_hash,/^[a-f0-9]{64}$/);
});
