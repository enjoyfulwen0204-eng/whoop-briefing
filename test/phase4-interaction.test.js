import test from 'node:test';
import assert from 'node:assert/strict';
import { syntheticPhase4Fixture } from './phase4Fixture.js';
import { semanticReservationKey } from '../src/phase4MessageStore.js';
import { QUESTION_WINDOW_MS } from '../src/phase4SlotStore.js';
import { V23_HEALTH_FIELDS } from '../src/phase4V23Schema.js';

async function prepared(f,key='one',executionMode='SHADOW') {
  const {stores,core}=f,context=await stores.capture('a',{executionMode});
  const source=await stores.root(context,'USER','a');
  const run=await stores.evidence.start(context,{deterministic_run_key:key,method:'SYNTHETIC',algorithm_version:'fixture',registry_version:'fixture',
    evidence_contract_version:'fixture',promotion_confound_version:'fixture',exposure_classification_version:'fixture',factor_set_version:'fixture',started_at:core.timestamp()},[source.ref]);
  await stores.evidence.complete(context,run.row.run_id,{});
  const item=await stores.evidence.addItem(context,{run_id:run.row.run_id,item_key:key,exposure_classification_version:'fixture',factor_set_version:'fixture'});
  const episode=await stores.episodes.open(context,{identity:{algorithmMajor:'fixture',direction:'DOWN',domain:'sleep',metric:'synthetic',subject:'synthetic',windowFamily:key},
    data:{episode_type:'SYNTHETIC',severity:1,expires_at:'2026-09-26T00:00:00.000Z'},evidenceItemId:item.row.evidence_item_id,
    semanticAt:core.timestamp()});
  const question={episode_id:episode.row.episode_id,episode_revision:1,factor_question_kind:'synthetic',
    target_window_start_utc:'2026-09-18T00:00:00.000Z',target_window_end_utc:'2026-09-19T00:00:00.000Z',
    question_template_version:'fixture',policy_version:'fixture',question_utility_version:'fixture',counterfactual_evaluator_version:'fixture'};
  const decision={deterministic_decision_key:`decision-${key}`,policy_version:'fixture',metric_registry_version:'fixture',evidence_version:'fixture',
    template_version:'fixture',expires_at:'2026-09-20T00:00:00.000Z'};
  return {context,item,episode,question,decision,sourceRefs:[item.ref]};
}

test('Semantic keys are exact stable four-family compact tuples and never contain versions or mode',()=>{
  assert.equal(semanticReservationKey('a','MORNING_BRIEF_V1','2026-09-19'),'["a","MORNING_BRIEF_V1","2026-09-19"]');
  assert.equal(semanticReservationKey('a','EPISODE_NOTIFICATION','event'),'["a","EPISODE_NOTIFICATION","event"]');
  assert.equal(semanticReservationKey('a','CONTEXT_QUESTION','question'),'["a","CONTEXT_QUESTION","question"]');
  assert.equal(semanticReservationKey('a','ANSWER_FOLLOWUP','answer','OBSERVATION_PLAN'),'["a","ANSWER_FOLLOWUP","answer","OBSERVATION_PLAN"]');
  assert.throws(()=>semanticReservationKey('a','ANSWER_FOLLOWUP','answer','new-wording'),/FOLLOWUP_KIND/);
  assert.throws(()=>semanticReservationKey('a','MORNING_BRIEF_V1','2026-02-31'),/HEALTH_DATE/);
});

test('LIVE pending projection requires the current exact accepted slot, is idempotent and is hidden from legacy question routing',async t=>{
  const f=await syntheticPhase4Fixture(t),{db,stores}=f;
  await db.saveTokens('a',{accessToken:'synthetic',refreshToken:'synthetic',expiresAt:new Date('2026-09-20T00:00:00.000Z'),scope:'offline',whoopUserId:'synthetic'});
  await db.linkTelegram({userId:'a',chatId:'123',now:f.core.now()});
  await db.raw.execute(`INSERT INTO user_onboarding(user_id,state,state_changed_at,created_at,updated_at)
    VALUES ('a','READY','2026-09-19T00:00:00.000Z','2026-09-19T00:00:00.000Z','2026-09-19T00:00:00.000Z')`);
  await stores.initializeTenant('a','LIVE');
  const p=await prepared(f,'live','LIVE');
  await stores.transport.mode(p.context,'CONTEXT_QUESTION');
  await db.raw.execute(`UPDATE tenant_delivery_modes SET mode='PHASE4',revision=revision+1,reason_code='CUTOVER_COMMITTED',
    cutover_boundary='2026-09-19T00:00:00.000Z',timezone='Asia/Taipei' WHERE user_id='a' AND execution_mode='LIVE'`);
  await db.raw.execute("UPDATE phase4_computation_state SET last_completed_generation=input_generation WHERE user_id='a' AND execution_mode='LIVE'");
  await db.raw.execute("UPDATE phase4_invalidations SET scope_kind='NONE' WHERE user_id='a' AND execution_mode='LIVE'");
  const selected=await stores.slots.acquire(p.context,{...p,message:{payload_text:'Synthetic question only.',expires_at:'2026-09-20T00:00:00.000Z'}});
  await assert.rejects(stores.slots.projectPending(p.context,{questionRequestId:selected.questionRequestId,expectedRevision:selected.slot.revision}),/CAS_LOST/);
  await stores.transport.makeEligible(p.context,{messageId:selected.messageId,expectedRevision:0});
  const lease=await stores.transport.claim(p.context,{messageId:selected.messageId,owner:'synthetic'});
  const attempt=await stores.transport.start(p.context,lease,{slotRevision:selected.slot.revision});
  const control=await stores.capturePrivacyControl('a');
  await stores.transport.settle(control,'LIVE',{attemptId:attempt.attemptId,outcome:'DELIVERED',providerMessageId:'synthetic-42'});
  const slot=await stores.slots.read(control,'LIVE');
  const request={questionRequestId:selected.questionRequestId,expectedRevision:slot.revision};
  const projection=await stores.slots.projectPending(p.context,request);
  assert.equal(projection.created,true);assert.equal((await stores.slots.projectPending(p.context,request)).created,false);
  assert.equal((await db.raw.execute('SELECT count(*) n FROM pending_questions')).rows[0].n,1);
  assert.equal(await db.getOpenPendingQuestion('a',{now:f.core.now()}),null);
  await assert.rejects(db.resolvePendingQuestion('a',projection.id,'not authorized'),/STRUCTURED_ANSWER_ROUTE_REQUIRED/);
  await db.transitionUserLifecycle({userId:'a',targetStatus:'DISABLED'});
  await assert.rejects(stores.slots.projectPending(p.context,request),/LIFECYCLE_FENCED/);
});

test('Episode refresh keeps logical identity while requiring a complete fresh projection and retaining historical purge dependencies',async t=>{
  const f=await syntheticPhase4Fixture(t),old=await prepared(f,'refresh');
  await f.stores.queue.sourceChanged(await f.stores.captureControl('a'));
  const context=await f.stores.capture('a',{executionMode:'SHADOW'}),source=await f.stores.root(context,'USER','a');
  const run=await f.stores.evidence.start(context,{deterministic_run_key:'refresh-run',method:'SYNTHETIC',algorithm_version:'fixture',registry_version:'fixture',
    evidence_contract_version:'fixture',promotion_confound_version:'fixture',exposure_classification_version:'fixture',factor_set_version:'fixture',started_at:f.core.timestamp()},[source.ref]);
  await f.stores.evidence.complete(context,run.row.run_id,{});
  const item=await f.stores.evidence.addItem(context,{run_id:run.row.run_id,item_key:'fresh',exposure_classification_version:'fixture',factor_set_version:'fixture'});
  const identity={algorithmMajor:'fixture',direction:'DOWN',domain:'sleep',metric:'synthetic',subject:'synthetic',windowFamily:'refresh'};
  const projection=Object.fromEntries(V23_HEALTH_FIELDS.observation_episodes.filter(k=>k!=='max_semantic_severity_ordinal').map(k=>[k,null]));
  Object.assign(projection,{episode_type:'SYNTHETIC',domain:'sleep',subject_key:'synthetic',direction:'DOWN',severity:2});
  const request={episodeId:old.episode.row.episode_id,expectedRevision:1,identity,projection,evidenceItemId:item.row.evidence_item_id};
  await assert.rejects(f.stores.episodes.read(context,request.episodeId),/PARENT_STALE/);
  await assert.rejects(f.stores.episodes.refresh(context,{...request,projection:{severity:2}}),/COMPLETE_CURRENT_PROJECTION/);
  const fresh=await f.stores.episodes.refresh(context,request);
  assert.equal(fresh.row.episode_id,request.episodeId);assert.equal(fresh.row.input_generation,1);assert.equal(fresh.row.revision,2);
  assert.equal((await f.db.raw.execute("SELECT count(*) n FROM phase4_source_links WHERE artifact_type='observation_episodes' AND unlinked_at IS NULL")).rows[0].n,2);
});

test('Atomic question selection has one winner; losing decision/request/reservation all roll back, replay does not extend',async t=>{
  const f=await syntheticPhase4Fixture(t),one=await prepared(f),two=await prepared(f,'two');
  const attempts=await Promise.allSettled([f.stores.slots.acquire(one.context,one),f.stores.slots.acquire(two.context,two)]);
  assert.equal(attempts.filter(r=>r.status==='fulfilled').length,1);
  assert.match(attempts.find(r=>r.status==='rejected').reason.message,/SLOT_OCCUPIED/);
  for(const table of ['context_questions','phase4_proactive_decisions','outbound_semantic_reservations'])
    assert.equal((await f.db.raw.execute(`SELECT count(*) n FROM ${table}`)).rows[0].n,1,table);
  assert.equal((await f.db.raw.execute('SELECT count(*) n FROM outbound_messages')).rows[0].n,0);
  const winner=attempts[0].value,replay=await f.stores.slots.acquire(one.context,one);
  assert.equal(replay.created,false);assert.equal(replay.slot.revision,winner.slot.revision);assert.equal(replay.slot.reserved_at,winner.slot.reserved_at);
  await assert.rejects(f.stores.slots.acquire({...one.context,executionMode:'LIVE'},one),/SERVER_CONTEXT_REQUIRED/);
});

test('Ambiguous occupancy requires exact reply lineage; replayed classification cannot extend the 30-minute window',async t=>{
  let time=new Date('2026-09-19T00:00:00.000Z');
  const f=await syntheticPhase4Fixture(t,{now:()=>time}),p=await prepared(f),control=await f.stores.captureControl('a');
  Object.assign(p.question,{factor_question_kind:'COVERAGE:caffeine',question_template_version:'journal-coverage-v1',utility_score:0.9,eligibility_threshold:0.5});
  const selected=await f.stores.slots.acquire(p.context,p);
  let slot=await f.stores.slots.beginSimulation(p.context,{questionRequestId:selected.questionRequestId,expectedRevision:selected.slot.revision});
  time=new Date(+time+60000);
  slot=await f.stores.slots.classifySimulation(control,'SHADOW',{questionRequestId:selected.questionRequestId,expectedRevision:slot.revision,outcome:'AMBIGUOUS'});
  assert.equal(slot.state,'AMBIGUOUS_WAIT');const deadline=slot.answer_deadline;
  time=new Date(+time+60000);
  const replay=await f.stores.slots.classifySimulation(control,'SHADOW',{questionRequestId:selected.questionRequestId,expectedRevision:slot.revision,outcome:'AMBIGUOUS'});
  assert.equal(replay.answer_deadline,deadline);assert.equal(replay.revision,slot.revision);
  await f.stores.preferences.update(control,0,{notifications_paused:1});
  assert.equal((await f.stores.slots.reconcile(control,'SHADOW')).state,'AMBIGUOUS_WAIT');
  const answer={sourceUpdateId:'shadow:answer',sourceText:'none',candidate:{confirmed:true,extractionConfidence:1,excerptStart:0,excerptEnd:4}};
  await assert.rejects(f.stores.journalAnswers.accept(p.context,{questionRequestId:selected.questionRequestId,expectedRevision:slot.revision,...answer}),/EXACT_QUESTION_REFERENCE/);
  const accepted=await f.stores.journalAnswers.accept(p.context,{questionRequestId:selected.questionRequestId,replyToQuestionRequestId:selected.questionRequestId,expectedRevision:slot.revision,...answer});
  assert.equal(accepted.slot.state,'RESOLVED');
  for(const table of ['journal_events','pending_questions','telegram_operations','outbound_delivery_attempts'])
    assert.equal((await f.db.raw.execute(`SELECT count(*) n FROM ${table}`)).rows[0].n,0,table);
  const reservation=await f.stores.messages.readReservation(control,'SHADOW',{family:'CONTEXT_QUESTION',identity:selected.questionRequestId});
  assert.equal(reservation.state,'CONSUMED');assert.equal(reservation.consumed_outcome,'AMBIGUOUS');
});

test('Unresolved start recovers to a full ambiguity window, not immediate expiration; terminal late proof does not reopen',async t=>{
  let time=new Date('2026-09-19T00:00:00.000Z');
  const f=await syntheticPhase4Fixture(t,{now:()=>time}),p=await prepared(f),control=await f.stores.captureControl('a');
  const selected=await f.stores.slots.acquire(p.context,p);
  let slot=await f.stores.slots.beginSimulation(p.context,{questionRequestId:selected.questionRequestId,expectedRevision:selected.slot.revision});
  time=new Date(+time+QUESTION_WINDOW_MS+1000);
  slot=await f.stores.slots.expire(control,'SHADOW',{expectedRevision:slot.revision});
  assert.equal(slot.state,'AMBIGUOUS_WAIT');assert.equal(Date.parse(slot.answer_deadline)-+time,QUESTION_WINDOW_MS);
  assert.equal((await f.stores.messages.readReservation(control,'SHADOW',{family:'CONTEXT_QUESTION',identity:selected.questionRequestId})).state,'CONSUMED');
  const retainedQuestion=(await f.db.raw.execute({sql:'SELECT expires_at FROM context_questions WHERE user_id=? AND question_request_id=?',args:['a',selected.questionRequestId]})).rows[0];
  assert.equal(retainedQuestion.expires_at,slot.answer_deadline);
  time=new Date(+time+QUESTION_WINDOW_MS);
  slot=await f.stores.slots.expire(control,'SHADOW',{expectedRevision:slot.revision});assert.equal(slot.state,'EXPIRED');
  const late=await f.stores.slots.classifySimulation(control,'SHADOW',{questionRequestId:selected.questionRequestId,expectedRevision:slot.revision,outcome:'DELIVERED'});
  assert.equal(late.state,'EXPIRED');assert.equal(late.revision,slot.revision);
});

test('SHADOW outbox freezes payload and permanently consumes simulated ambiguous reservation without attempts',async t=>{
  const f=await syntheticPhase4Fixture(t),context=await f.stores.capture('a',{executionMode:'SHADOW'}),root=await f.stores.root(context,'USER','a');
  const proposal={semantic:{family:'MORNING_BRIEF_V1',identity:'2026-09-19'},message:{payload_text:'Synthetic frozen content',expires_at:'2026-09-20T00:00:00.000Z'},sourceRefs:[root.ref]};
  const first=await f.stores.messages.propose(context,proposal),again=await f.stores.messages.propose(context,proposal);
  assert.equal(again.created,false);assert.equal(again.row.message_id,first.row.message_id);
  await assert.rejects(f.stores.messages.propose(context,{...proposal,message:{...proposal.message,payload_text:'changed'}}),/FROZEN_MESSAGE_CONFLICT/);
  await f.stores.messages.simulate(context,first.row.message_id,'AMBIGUOUS');
  const blocked=await f.stores.messages.propose(context,proposal);assert.equal(blocked.terminal,true);assert.equal(blocked.reservation.state,'CONSUMED');
  assert.equal((await f.db.raw.execute('SELECT count(*) n FROM outbound_delivery_attempts')).rows[0].n,0);
});

test('Legacy guard imports only owned transport metadata, preserves deadline, CAS-resolves and defers unknown sends',async t=>{
  const f=await syntheticPhase4Fixture(t),{db,stores}=f,control=await stores.capturePrivacyControl('a');
  await db.raw.execute({sql:`INSERT INTO pending_questions(user_id,chat_id,question,asked_at,expires_at,status)
    VALUES ('a','synthetic','synthetic legacy step','2026-09-18T23:55:00.000Z','2026-09-19T00:25:00.000Z','OPEN')`,args:[]});
  const first=await stores.slots.syncLegacy(control,'LIVE');
  assert.equal(first.blocked,true);assert.equal(first.slot.origin,'LEGACY');assert.equal(first.slot.state,'AWAITING_ANSWER');
  assert.equal(first.slot.question_request_id,null);assert.equal(first.slot.answer_deadline,'2026-09-19T00:25:00.000Z');
  const repeated=await stores.slots.syncLegacy(control,'LIVE',{expectedRevision:first.slot.revision});
  assert.equal(repeated.slot.revision,first.slot.revision);assert.equal(repeated.slot.answer_deadline,first.slot.answer_deadline);
  await assert.rejects(stores.slots.syncLegacy(control,'LIVE'),/CAS_LOST/);
  assert.equal((await stores.slots.syncLegacy(await stores.capturePrivacyControl('b'),'LIVE')).blocked,false);
  await db.raw.execute("UPDATE pending_questions SET status='ANSWERED' WHERE user_id='a'");
  const resolved=await stores.slots.syncLegacy(control,'LIVE',{expectedRevision:first.slot.revision});
  assert.equal(resolved.slot.state,'RESOLVED');assert.equal(resolved.blocked,false);
  await db.raw.execute(`INSERT INTO proactive_events(user_id,health_date,idempotency_key,decision,policy_version,created_at)
    VALUES ('a','2026-09-19','legacy-in-flight','ASK_CONTEXT','synthetic','2026-09-19T00:00:00.000Z')`);
  const uncertain=await stores.slots.syncLegacy(control,'LIVE',{expectedRevision:resolved.slot.revision});
  assert.equal(uncertain.blocked,true);assert.equal(uncertain.reason,'UNCLASSIFIABLE_LEGACY_SEND');
  assert.equal((await db.raw.execute('SELECT count(*) n FROM context_questions')).rows[0].n,0);
  await assert.rejects(stores.slots.syncLegacy(control,'SHADOW'),/LIVE_ONLY/);
});
