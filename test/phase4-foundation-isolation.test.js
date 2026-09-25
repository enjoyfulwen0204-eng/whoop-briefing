import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syntheticPhase4Fixture } from './phase4Fixture.js';
import { journalQuestion,inboundAnswer } from './journalQuestionFixture.js';
import { bodyInput,seedBodyInput } from './bodyEnergyFixture.js';
import { createPhase4Foundation } from '../src/phase4Foundation.js';
import { FOUNDATION_FLAGS,FOUNDATION_FLAG_NAMES,foundationFlags } from '../src/phase4Flags.js';
import { addPrivacyLink } from '../src/phase4V22Backfill.js';

const at=Date.parse('2026-09-19T00:00:00.000Z'),request={asOfEpochMs:at,targetHealthDate:'2026-09-19'};
const coverage={sourceText:'none',candidate:{confirmed:true,extractionConfidence:1,excerptStart:0,excerptEnd:4}};
const answer=(q,extra={})=>({questionRequestId:q.selected.questionRequestId,replyToQuestionRequestId:q.selected.questionRequestId,
  expectedRevision:q.slot.revision,...coverage,...extra});

test('Aggregate isolation: every derived store family rejects foreign actual parents and restart never imports transient authority',async t=>{
  const f=await syntheticPhase4Fixture(t),s=f.stores,q=await journalQuestion(f,{coverage:true});
  const accepted=await s.journalAnswers.accept(q.context,answer(q,{sourceUpdateId:'shadow:aggregate'}));
  const item=(await f.db.raw.execute('SELECT * FROM evidence_items')).rows[0];
  const insight=await s.insights.create(q.context,{identity:{subject:'synthetic',outcome:'synthetic',direction:'DOWN',exposureCategory:'synthetic',algorithmFamily:'synthetic',evidenceContractMajor:'1'},
    claim:'Synthetic candidate only',creationKey:'aggregate',evidenceContractVersion:'fixture',supportingEvidenceIds:[item.evidence_item_id],
    expiresAt:'2026-10-01T00:00:00.000Z',semanticAt:'2026-09-19T00:00:00.000Z'});
  const root=await s.root(q.context,'USER','a');
  const message=await s.messages.propose(q.context,{semantic:{family:'MORNING_BRIEF_V1',identity:'2026-09-19'},
    message:{payload_text:'Synthetic unsent brief',expires_at:'2026-09-20T00:00:00.000Z'},sourceRefs:[root.ref]});
  const body=await s.bodyEnergy.compute(q.context,request);
  const b=await s.capture('b',{executionMode:'SHADOW'}),bc=await s.captureControl('b');
  const cases=[
    ['bodyEnergy',()=>s.bodyEnergy.audit(b,body.row.result_id)],
    ['evidence',()=>s.evidence.addItem(b,{run_id:item.run_id,item_key:'foreign',exposure_classification_version:'fixture',factor_set_version:'fixture'})],
    ['episodes',()=>s.episodes.read(b,q.question.episode_id)],
    ['insights',()=>s.insights.read(b,insight.row.id)],
    ['decisions',()=>s.readArtifact(b,'phase4_proactive_decisions',{decision_id:q.selected.decisionId})],
    ['messages',()=>s.readArtifact(b,'outbound_messages',{message_id:message.row.message_id})],
    ['slots',()=>s.slots.acquire(b,{question:q.question,decision:{deterministic_decision_key:'foreign'},sourceRefs:[]})],
    ['transport',()=>s.transport.makeEligible(b,{messageId:message.row.message_id,expectedRevision:0})],
    ['journalAnswers',()=>s.journalAnswers.accept(b,answer(q,{sourceUpdateId:'shadow:foreign'}))],
  ];
  for(const [family,call] of cases)await assert.rejects(call(),/PARENT_NOT_FOUND/,family);
  assert.equal(await s.messages.readReservation(bc,'SHADOW',{family:'CONTEXT_QUESTION',identity:q.selected.questionRequestId}),null);
  assert.equal(await s.slots.read(bc,'SHADOW'),null);
  await s.cache.set(q.context,'same-key',{value:'synthetic-only'});assert.equal(await s.cache.get(b,'same-key'),undefined);
  const restarted=(await f.restart()).stores,newA=await restarted.capture('a',{executionMode:'SHADOW'});
  await assert.rejects(restarted.cache.get(q.context,'same-key'),/SERVER_CONTEXT_REQUIRED/);
  assert.equal(await restarted.cache.get(newA,'same-key'),undefined);
  assert.equal((await restarted.readArtifact(newA,'structured_answer_events',{answer_event_id:accepted.answerEventId})).row.answer_event_id,accepted.answerEventId);
  assert.equal((await restarted.bodyEnergy.compute(newA,request)).row.result_id,body.row.result_id);
  await assert.rejects(restarted.preferences.read(q.control),/SOURCE_CONTROL_REQUIRED/);
  assert.equal((await f.db.raw.execute("SELECT count(*) n FROM outbound_delivery_attempts")).rows[0].n,0);
});

test('Aggregate isolation: shared Journal/coverage/experiment/privacy/inbound controllers cannot cross tenant ownership',async t=>{
  const f=await syntheticPhase4Fixture(t),s=f.stores,q=await journalQuestion(f,{mode:'LIVE',coverage:true});
  const authority=await inboundAnswer(f,q.control),accepted=await s.journalAnswers.accept(q.context,answer(q,{sourceUpdateId:'9101',inboundAuthority:authority}));
  const b=await s.capture('b',{executionMode:'SHADOW'}),bc=await s.captureControl('b');
  assert.equal(await s.journalCoverage.read(b,accepted.coverageWindowId),null);
  await assert.rejects(s.journalCoverage.correct(bc,{coverageWindowId:accepted.coverageWindowId,expectedRevision:1,idempotencyKey:'foreign',...coverage}),/REVISION_CONFLICT/);
  await assert.rejects(s.journalCoverage.remove(bc,{coverageWindowId:accepted.coverageWindowId,idempotencyKey:'foreign'}),/TARGET_NOT_FOUND/);
  await assert.rejects(s.journalInbound.capture(bc,{updateId:9101,owner:'answer-owner'}),/INBOUND_/);
  const created=await s.journal.create(q.control,{sourceEventKey:'shared',sourceText:'caffeine 100mg',candidate:{category:'caffeine',eventAt:'2026-09-19T00:00:00.000Z',
    valueKind:'NUMERIC',numericValue:100,unit:'mg',exposureState:'EXPOSED',extractionConfidence:1,excerptStart:0,excerptEnd:14}});
  assert.equal(await s.journal.read(b,created.logicalFactId),null);
  await assert.rejects(s.journal.remove(bc,{logicalFactId:created.logicalFactId,idempotencyKey:'foreign-fact'}),/TARGET_NOT_FOUND/);
  const proof=await s.experiments.assertDirect(q.control,{field:'name',value:'Synthetic independent',sourceUpdateKey:'shared'});
  const exp=await s.experiments.create(q.control,{creationKey:'shared',fields:{name:'Synthetic independent'},proofs:{name:proof}});
  assert.equal(await s.experiments.read(bc,exp.experimentId),null);
  await assert.rejects(s.experiments.correct(bc,{experimentId:exp.experimentId,field:'name',expectedRevision:1,assertion:proof,idempotencyKey:'foreign'}),/PROOF_MISMATCH/);
  const p=await s.journal.remove(q.control,{logicalFactId:created.logicalFactId,idempotencyKey:'own'});
  await assert.rejects(s.privacy.status(bc,p.purgeId),/PURGE_NOT_FOUND/);
  await assert.rejects(s.privacy.complete(bc,p.purgeId),/PURGE_NOT_FOUND/);
  assert.equal((await s.preferences.read(bc)).preference_version,0);
  assert.equal((await f.db.raw.execute("SELECT pending_purge_count FROM phase4_user_state WHERE user_id='b'")).rows[0].pending_purge_count,0);
});

test('Aggregate isolation: exact Body insert/checkpoint races and durable queue takeover survive restart without mode/cache/lease crossover',async t=>{
  let now=new Date(at);const f=await syntheticPhase4Fixture(t,{now:()=>now}),s=f.stores;
  await f.db.transaction(()=>seedBodyInput(f.db,bodyInput()));await s.initializeTenant('a','LIVE');
  const shadow=await s.capture('a',{executionMode:'SHADOW'}),live=await s.capture('a',{executionMode:'LIVE'});
  const restarted=(await f.restart()).stores,other=await restarted.capture('a',{executionMode:'SHADOW'});
  const results=await Promise.all([s.bodyEnergy.compute(shadow,request),restarted.bodyEnergy.compute(other,request)]);
  assert.equal(results.filter(r=>r.created).length,1);assert.equal(results[0].row.result_id,results[1].row.result_id);
  assert.equal((await s.bodyEnergy.compute(live,request)).row.value,70);
  await assert.rejects(s.bodyEnergy.read(live,results[0].row.result_id),/PARENT_NOT_FOUND/);
  const checkpoints=await Promise.all([s.bodyEnergy.checkpoint(shadow,{bucketStart:at-900000}),restarted.bodyEnergy.checkpoint(other,{bucketStart:at-900000})]);
  assert.equal(checkpoints[0].row.checkpoint_id,checkpoints[1].row.checkpoint_id);
  await s.cache.set(shadow,'same',{value:70});assert.equal(await s.cache.get(live,'same'),undefined);assert.equal(await restarted.cache.get(other,'same'),undefined);
  const lease=await s.queue.claim(live,{jobKind:'RECOMPUTE_DERIVED',owner:'old',leaseMs:1000});assert.ok(lease);
  const restartedLive=await restarted.capture('a',{executionMode:'LIVE'});
  assert.equal(await restarted.queue.claim(restartedLive,{jobKind:'RECOMPUTE_DERIVED',owner:'new'}),null);
  now=new Date(at+1001);
  const takeover=await restarted.queue.claim(restartedLive,{jobKind:'RECOMPUTE_DERIVED',owner:'new'});assert.ok(takeover);
  await assert.rejects(restarted.queue.fail(restartedLive,lease,{errorCode:'CALCULATION_FAILED'}),/SERVER_LEASE_REQUIRED/);
  await assert.rejects(s.queue.fail(live,lease,{errorCode:'CALCULATION_FAILED'}),/LEASE_CAS_LOST/);
  await assert.rejects(restarted.queue.complete(other,takeover),/LEASE_SCOPE_MISMATCH/);
  await assert.rejects(restarted.queue.complete(restartedLive,takeover),/FULL_PASS_NOT_AUTHORIZED/);
});

test('Aggregate provenance: ANSWER_LINEAGE cannot bypass freshness for numeric or unrelated parents',async t=>{
  const f=await syntheticPhase4Fixture(t),s=f.stores,q=await journalQuestion(f,{coverage:true});
  await s.journalAnswers.accept(q.context,answer(q,{sourceUpdateId:'shadow:lineage'}));
  const item=(await f.db.raw.execute('SELECT * FROM evidence_items')).rows[0];
  const question=(await f.db.raw.execute('SELECT * FROM context_questions')).rows[0];
  await addPrivacyLink(f.db.raw,{userId:'a',mode:'SHADOW',table:'evidence_items',artifactId:item.privacy_artifact_id,
    sourceMode:'SHADOW',sourceType:'context_questions',sourceId:question.privacy_artifact_id,relationship:'ANSWER_LINEAGE',at:f.core.timestamp()});
  await assert.rejects(s.readArtifact(q.context,'evidence_items',{evidence_item_id:item.evidence_item_id}),/ANSWER_LINEAGE_INVALID/);
});

test('Aggregate concurrency: independently rebuilt stores race to one semantic reservation and never revive its consumed identity',async t=>{
  const f=await syntheticPhase4Fixture(t),s=f.stores,r=(await f.restart()).stores;
  const c=await s.capture('a',{executionMode:'SHADOW'}),other=await r.capture('a',{executionMode:'SHADOW'});
  const propose=async(stores,context)=>stores.messages.propose(context,{semantic:{family:'MORNING_BRIEF_V1',identity:'2026-09-19'},
    message:{payload_text:'Synthetic frozen race',expires_at:'2026-09-20T00:00:00.000Z'},sourceRefs:[(await stores.root(context,'USER',context.userId)).ref]});
  const winners=await Promise.all([propose(s,c),propose(r,other)]);
  assert.equal(winners.filter(w=>w.created).length,1);assert.equal(winners[0].row.message_id,winners[1].row.message_id);
  assert.equal((await f.db.raw.execute('SELECT count(*) n FROM outbound_semantic_reservations')).rows[0].n,1);
  await s.messages.simulate(c,winners[0].row.message_id,'AMBIGUOUS');
  const replay=await propose(r,other);assert.equal(replay.terminal,true);assert.equal(replay.reservation.state,'CONSUMED');
  const b=await s.capture('b',{executionMode:'SHADOW'});assert.equal((await propose(s,b)).created,true);
  assert.equal((await f.db.raw.execute("SELECT count(*) n FROM outbound_messages WHERE execution_mode='LIVE'")).rows[0].n,0);
  assert.equal((await f.db.raw.execute('SELECT count(*) n FROM outbound_delivery_attempts')).rows[0].n,0);
});

test('Aggregate release boundary: all 13 flags are false, every enable request fails, and new foundation code has no production IO or entry-point wiring',async t=>{
  assert.equal(FOUNDATION_FLAG_NAMES.length,13);assert.ok(Object.values(FOUNDATION_FLAGS).every(value=>value===false));
  for(const name of FOUNDATION_FLAG_NAMES)for(const value of [true,'true','1'])assert.throws(()=>foundationFlags({[name]:value}),/RUNTIME_NOT_AUTHORIZED/);
  const f=await syntheticPhase4Fixture(t),s=await createPhase4Foundation({db:f.db,keys:f.keys,now:f.core.now});
  for(const mode of [undefined,null,'','live','UNKNOWN'])await assert.rejects(s.capture('a',{executionMode:mode}),/EXECUTION_MODE_REQUIRED/);
  await assert.rejects(s.initializeTenant('a','LIVE'),/LIVE_NOT_AUTHORIZED/);
  await assert.rejects(s.capture('a',{executionMode:'LIVE'}),/LIVE_NOT_AUTHORIZED/);
  const files=fs.readdirSync(new URL('../src/',import.meta.url)).filter(name=>/^(phase4|bodyEnergy|journalFoundation|journalAnswerRevision)/.test(name)&&name.endsWith('.js'));
  assert.ok(files.length>25);
  for(const file of files) {
    const source=fs.readFileSync(new URL(`../src/${file}`,import.meta.url),'utf8');
    assert.doesNotMatch(source,/\b(?:fetch|setInterval|setTimeout)\s*\(/,file);
    assert.doesNotMatch(source,/from\s+['"][^'"]*(?:telegram|whoopApi|openrouter|scheduler|analyticsWorker|test\/)[^'"]*['"]/i,file);
    assert.doesNotMatch(source,/process\.env|\.env['"]|https?:\/\//,file);
  }
  for(const file of ['index.js','bot/index.js','bot/webhook.js','schedulerWatchdog.js']) {
    const source=fs.readFileSync(new URL(`../src/${file}`,import.meta.url),'utf8');
    assert.doesNotMatch(source,/phase4JournalControl\s*:|journalInbound|bodyEnergy|phase4Transport|phase4Foundation/,file);
  }
  for(const table of ['outbound_messages','outbound_delivery_attempts','telegram_operations','phase4_jobs'])
    assert.equal((await f.db.raw.execute(`SELECT count(*) n FROM ${table}`)).rows[0].n,0,table);
});
