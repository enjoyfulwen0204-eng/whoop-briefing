import test from 'node:test';
import assert from 'node:assert/strict';
import { syntheticPhase4Fixture } from './phase4Fixture.js';
import { seedBodyInput,bodyInput } from './bodyEnergyFixture.js';
import { journalQuestion,inboundAnswer } from './journalQuestionFixture.js';
import { addPrivacyLink,HEALTH_REDACTED } from '../src/phase4V22Backfill.js';

async function experiment(stores,control,key='experiment') {
  const assertion=await stores.experiments.assertDirect(control,{field:'name',value:'Synthetic independent',sourceUpdateKey:key});
  return stores.experiments.create(control,{creationKey:key,fields:{name:'Synthetic independent'},proofs:{name:assertion}});
}
async function fact(stores,control) {
  return stores.journal.create(control,{sourceEventKey:'aggregate-fact',sourceText:'100 mg caffeine',
    candidate:{category:'caffeine',eventAt:'2026-09-19T00:00:00.000Z',valueKind:'NUMERIC',numericValue:100,unit:'mg',exposureState:'EXPOSED',
      extractionConfidence:1,excerptStart:0,excerptEnd:15}});
}

test('Aggregate: SQLite numeric aliases cannot create a different whole-experiment deletion identity',async t=>{
  const f=await syntheticPhase4Fixture(t),s=f.stores,c=await s.captureControl('a'),e=await experiment(s,c),id=String(e.experimentId);
  for(const targetId of [`0${id}`,`${id}.0`,`${id}e0`,`+${id}`,` ${id}`,`${id} `,'9007199254740992'])
    await assert.rejects(s.privacy.admit(c,{targetType:'EXPERIMENT',targetId,idempotencyKey:`alias:${targetId}`}),/EXPERIMENT_ID_REQUIRED/);
  assert.equal((await f.db.raw.execute('SELECT count(*) n FROM health_plaintext_purges')).rows[0].n,0);
  const p=await s.privacy.admit(c,{targetType:'EXPERIMENT',targetId:id,idempotencyKey:'canonical'});
  await s.privacy.redact(c,p.purge_id);await s.privacy.complete(c,p.purge_id);
  const assertion=await s.experiments.assertDirect(c,{field:'name',value:'Synthetic replacement',sourceUpdateKey:'fresh'});
  await assert.rejects(s.experiments.correct(c,{experimentId:e.experimentId,field:'name',expectedRevision:1,assertion,idempotencyKey:'resurrection'}),/EXPERIMENT_DELETED/);
});

test('Aggregate: whole experiment deletion permanently fences every field write across restart, without deleting independent experiments',async t=>{
  const f=await syntheticPhase4Fixture(t);let s=f.stores,c=await s.captureControl('a');
  const deleted=await experiment(s,c),retained=await experiment(s,c,'independent');
  const p=await s.privacy.admit(c,{targetType:'EXPERIMENT',targetId:String(deleted.experimentId),idempotencyKey:'whole-delete'});
  await s.privacy.redact(c,p.purge_id);await s.privacy.complete(c,p.purge_id);
  s=(await f.restart()).stores;c=await s.captureControl('a');
  const assertion=await s.experiments.assertDirect(c,{field:'name',value:'Synthetic replacement',sourceUpdateKey:'fresh'});
  await assert.rejects(s.experiments.correct(c,{experimentId:deleted.experimentId,field:'name',expectedRevision:1,assertion,idempotencyKey:'resurrection'}),/EXPERIMENT_DELETED/);
  await assert.rejects(s.experiments.writeNewFields(c,{experimentId:deleted.experimentId,fields:{name:'Synthetic replacement'},proofs:{name:assertion},sourceKey:'resurrection'}),/EXPERIMENT_DELETED/);
  assert.equal((await s.experiments.read(c,deleted.experimentId)).row.name,HEALTH_REDACTED);
  assert.equal((await s.experiments.read(c,retained.experimentId)).row.name,'Synthetic independent');
  assert.equal((await f.db.raw.execute("SELECT count(*) n FROM health_plaintext_purges WHERE user_id='a'")).rows[0].n,1);
});

test('Aggregate: whole and field experiment admissions serialize in both directions, then converge after a failed T1 restart',async t=>{
  const f=await syntheticPhase4Fixture(t),s=f.stores,c=await s.captureControl('a'),e=await experiment(s,c);
  const assertion=await s.experiments.assertDirect(c,{field:'name',value:'Synthetic corrected',sourceUpdateKey:'new'});
  await f.db.raw.execute("CREATE TRIGGER synthetic_t1_failure BEFORE UPDATE ON experiment_field_groups BEGIN SELECT RAISE(ABORT,'synthetic_t1_failure'); END");
  await assert.rejects(s.experiments.correct(c,{experimentId:e.experimentId,field:'name',expectedRevision:1,assertion,idempotencyKey:'field-first'}),/synthetic_t1_failure/);
  await assert.rejects(s.privacy.admit(c,{targetType:'EXPERIMENT',targetId:String(e.experimentId),idempotencyKey:'whole-second'}),/SUBJECT_PURGE_PENDING/);
  await f.db.raw.execute('DROP TRIGGER synthetic_t1_failure');
  const restarted=(await f.restart()).stores,cleanup=await restarted.captureControl('a');
  const p=(await f.db.raw.execute('SELECT purge_id FROM health_plaintext_purges')).rows[0];
  await restarted.privacy.redact(cleanup,p.purge_id);await restarted.privacy.complete(cleanup,p.purge_id);
  const whole=await restarted.privacy.admit(cleanup,{targetType:'EXPERIMENT',targetId:String(e.experimentId),idempotencyKey:'whole-second'});
  const leaf=(await f.db.raw.execute("SELECT privacy_artifact_id FROM experiment_field_groups WHERE field_name='name' AND is_current=1")).rows[0];
  await assert.rejects(restarted.privacy.admit(cleanup,{targetType:'EXPERIMENT_FIELD',targetId:leaf.privacy_artifact_id,idempotencyKey:'leaf-second'}),/SUBJECT_PURGE_PENDING/);
  await restarted.privacy.redact(cleanup,whole.purge_id);await restarted.privacy.complete(cleanup,whole.purge_id);
  assert.equal((await restarted.experiments.read(cleanup,e.experimentId)).row.name,HEALTH_REDACTED);
});

test('Aggregate: stale experiment assertion is rejected before durable T0 admission',async t=>{
  const f=await syntheticPhase4Fixture(t),s=f.stores,c=await s.captureControl('a'),e=await experiment(s,c);
  const assertion=await s.experiments.assertDirect(c,{field:'name',value:'Synthetic stale',sourceUpdateKey:'stale'});
  await f.db.transitionUserLifecycle({userId:'a',targetStatus:'DISABLED'});
  await f.db.transitionUserLifecycle({userId:'a',targetStatus:'ACTIVE'});
  const current=await s.captureControl('a');
  await assert.rejects(s.experiments.correct(current,{experimentId:e.experimentId,field:'name',expectedRevision:1,assertion,idempotencyKey:'stale'}),/PROOF_STALE/);
  assert.equal((await f.db.raw.execute('SELECT count(*) n FROM health_plaintext_purges')).rows[0].n,0);
  assert.equal((await f.db.raw.execute("SELECT pending_purge_count FROM phase4_user_state WHERE user_id='a'")).rows[0].pending_purge_count,0);
});

for(const disabled of [false,true])test(`Aggregate: canonical deletion between T1/T2 (${disabled?'disabled':'active'}) cannot reset purge scope or strand cleanup`,async t=>{
  const f=await syntheticPhase4Fixture(t),s=f.stores;
  await f.db.transaction(()=>seedBodyInput(f.db,bodyInput()));await s.initializeTenant('a','LIVE');
  const c=await s.captureControl('a'),j=await fact(s,c);assert.equal(j.status,'ACCEPT');
  const p=await s.journal.remove(c,{logicalFactId:j.logicalFactId,idempotencyKey:'journal-delete'});
  const before=(await f.db.raw.execute("SELECT * FROM phase4_jobs WHERE user_id='a' ORDER BY execution_mode,job_kind")).rows;
  const other=(await f.db.raw.execute("SELECT * FROM phase4_user_state WHERE user_id='b'")).rows[0];
  if(disabled)await f.db.transitionUserLifecycle({userId:'a',targetStatus:'DISABLED'});
  const remove=()=>f.db.deleteWhoopResource({userId:'a',resourceType:'sleep',resourceId:'sleep-00',now:f.core.now()});
  if(disabled)await remove();else await assert.rejects(remove(),/PURGE_FENCED/);
  const after=(await f.db.raw.execute("SELECT * FROM phase4_jobs WHERE user_id='a' ORDER BY execution_mode,job_kind")).rows;
  for(let i=0;i<after.length;i++) {
    const row=after[i];assert.equal(row.content_state,'REDACTED');assert.equal(row.source_linkage_state,'DISCONNECTED');
    assert.equal(row.scope_kind,'FULL_TENANT_RECOMPUTE');assert.equal(row.affected_from,null);assert.equal(row.affected_to,null);
    assert.equal(row.completed_generation,before[i].completed_generation);assert.equal(row.requested_generation,before[i].requested_generation+(disabled?1:0));
    assert.equal(row.reason_codes_json,'["HEALTH_SCOPE_REDACTED"]');assert.ok(row.health_scope_redacted_at);
  }
  assert.equal((await f.db.raw.execute("SELECT count(*) n FROM phase4_source_links WHERE user_id='a' AND artifact_type IN ('phase4_jobs','phase4_invalidations')")).rows[0].n,0);
  const restart=(await f.restart()).stores,cleanup=await restart.capturePrivacyControl('a');
  assert.equal((await restart.privacy.complete(cleanup,p.purgeId)).state,'COMPLETE');
  if(!disabled)await remove();
  assert.equal((await f.db.raw.execute("SELECT count(*) n FROM whoop_sleeps WHERE user_id='a' AND id='sleep-00'")).rows[0].n,0);
  assert.deepEqual((await f.db.raw.execute("SELECT * FROM phase4_user_state WHERE user_id='b'")).rows[0],other);
  assert.equal((await f.db.raw.execute('PRAGMA integrity_check')).rows[0].integrity_check,'ok');
});

for(const outcome of ['AMBIGUOUS','DELIVERED'])test(`Aggregate: purge erases a ${outcome} question without releasing its occupied answer window`,async t=>{
  const f=await syntheticPhase4Fixture(t),s=f.stores,q=await journalQuestion(f,{mode:'LIVE',outcome});
  if(outcome==='DELIVERED')await s.slots.projectPending(q.context,{questionRequestId:q.selected.questionRequestId,expectedRevision:q.slot.revision});
  await s.release(q.context);
  const j=await fact(s,q.control);assert.equal(j.status,'ACCEPT');
  const row=(await f.db.raw.execute({sql:'SELECT privacy_artifact_id FROM context_questions WHERE user_id=? AND question_request_id=?',args:['a',q.selected.questionRequestId]})).rows[0];
  const source=(await f.db.raw.execute({sql:'SELECT privacy_artifact_id FROM journal_events WHERE user_id=? AND logical_fact_id=?',args:['a',j.logicalFactId]})).rows[0];
  await addPrivacyLink(f.db.raw,{userId:'a',mode:'LIVE',table:'context_questions',artifactId:row.privacy_artifact_id,sourceType:'JOURNAL_FACT',sourceId:source.privacy_artifact_id,at:f.core.timestamp()});
  const p=await s.journal.remove(q.control,{logicalFactId:j.logicalFactId,idempotencyKey:'question-source-delete'});
  await s.privacy.complete(q.control,p.purgeId);
  const slot=await s.slots.read(q.control,'LIVE');assert.equal(slot.state,q.slot.state);assert.equal(slot.answer_deadline,q.slot.answer_deadline);
  const question=(await f.db.raw.execute('SELECT * FROM context_questions')).rows[0];assert.equal(question.content_state,'REDACTED');assert.equal(question.factor_question_kind,null);
  const message=(await f.db.raw.execute('SELECT * FROM outbound_messages')).rows[0];assert.equal(message.payload_text,null);assert.equal(message.content_state,'REDACTED');
  for(const pending of (await f.db.raw.execute('SELECT * FROM pending_questions')).rows)assert.equal(pending.content_state,'REDACTED');
  const context=await s.capture('a',{executionMode:'LIVE'}),authority=await inboundAnswer(f,q.control);
  await assert.rejects(s.journalAnswers.accept(context,{questionRequestId:q.selected.questionRequestId,replyToQuestionRequestId:q.selected.questionRequestId,
    expectedRevision:slot.revision,sourceUpdateId:'9101',inboundAuthority:authority,sourceText:'caffeine 100mg',
    candidate:{category:'caffeine',eventAt:'2026-09-18T00:00:00.000Z',valueKind:'NUMERIC',numericValue:100,unit:'mg',
      exposureState:'EXPOSED',extractionConfidence:1,excerptStart:0,excerptEnd:14}}),/CONTENT_REDACTED/);
  assert.equal((await f.db.raw.execute('SELECT count(*) n FROM structured_answer_events')).rows[0].n,0);
  assert.equal((await f.db.raw.execute('SELECT count(*) n FROM journal_events')).rows[0].n,0);
});
