import test from 'node:test';
import assert from 'node:assert/strict';
import { syntheticPhase4Fixture } from './phase4Fixture.js';
import { journalQuestion,inboundAnswer } from './journalQuestionFixture.js';
const coverageAnswer={sourceText:'none',candidate:{confirmed:true,extractionConfidence:1,excerptStart:0,excerptEnd:4}};
const factAnswer={sourceText:'caffeine 100mg',candidate:{category:'caffeine',eventAt:'2026-09-18T00:00:00.000Z',valueKind:'NUMERIC',numericValue:100,
  unit:'mg',exposureState:'EXPOSED',extractionConfidence:1,excerptStart:0,excerptEnd:14}};
const request=(p,patch={})=>({questionRequestId:p.selected.questionRequestId,replyToQuestionRequestId:p.selected.questionRequestId,expectedRevision:p.slot.revision,...patch});
const mutationTables=['journal_events','journal_coverage_windows','structured_answer_events','telegram_operations','pending_questions',
  'context_questions','phase4_question_interaction_slots','phase4_source_links','phase4_jobs','phase4_invalidations','health_plaintext_purges',
  'health_purge_targets','health_purge_replacements','phase4_user_state','phase4_computation_state','outbound_messages','outbound_delivery_attempts'];
async function durableState(f) {
  const state={};
  for(const table of mutationTables)state[table]=(await f.db.raw.execute(`SELECT * FROM ${table}`)).rows.map(row=>({...row}));
  return state;
}
function presenceAnswer(p,sourceText,excerpt,{exposureState='EXPOSED',category='caffeine'}={}) {
  const offset=sourceText.indexOf(excerpt),start=[...sourceText.slice(0,offset)].length;
  return {sourceText,candidate:{category,eventAt:p.question.target_window_start_utc,valueKind:'PRESENCE',exposureState,extractionConfidence:1,
    excerptStart:start,excerptEnd:start+[...excerpt].length}};
}

test('SHADOW validated answers stay synthetic; invalid, cross-tenant and mismatched answers cannot resolve an occupied request',async t=>{
  const f=await syntheticPhase4Fixture(t),p=await journalQuestion(f,{coverage:true}),options=request(p,{...coverageAnswer,sourceUpdateId:'shadow:1'});
  const b=await f.stores.capture('b',{executionMode:'SHADOW'});
  await assert.rejects(f.stores.journalAnswers.accept(b,options),/PARENT_NOT_FOUND/);
  await assert.rejects(f.stores.journalAnswers.accept(p.context,{...options,sourceUpdateId:'123'}),/SHADOW_SIMULATION/);
  await assert.rejects(f.stores.journalAnswers.accept(p.context,{...options,replyToQuestionRequestId:'other'}),/EXACT_QUESTION/);
  const ambiguous=await f.stores.journalAnswers.accept(p.context,{...options,candidate:{...options.candidate,confirmed:false}});
  assert.equal(ambiguous.status,'REQUIRE_CLARIFICATION');assert.equal((await f.stores.slots.read(p.control,'SHADOW')).state,'AMBIGUOUS_WAIT');
  const accepted=await f.stores.journalAnswers.accept(p.context,options);assert.equal(accepted.status,'ACCEPT');assert.equal(accepted.slot.state,'RESOLVED');
  const replay=await f.stores.journalAnswers.accept(p.context,{sourceUpdateId:'shadow:1',candidate:new Proxy({}, {get(){throw Error('parser invoked');}})});
  assert.equal(replay.created,false);assert.equal(replay.answerEventId,accepted.answerEventId);
  for(const table of ['journal_events','journal_coverage_windows','telegram_operations','pending_questions','outbound_delivery_attempts'])
    assert.equal((await f.db.raw.execute(`SELECT count(*) n FROM ${table}`)).rows[0].n,0,table);
  const answer=(await f.db.raw.execute('SELECT * FROM structured_answer_events')).rows[0];
  assert.equal(answer.logical_fact_id,null);assert.equal(answer.coverage_window_id,null);
});

test('Ambiguous multi-factor negation cannot resolve a factor slot or create any durable answer state',async t=>{
  const f=await syntheticPhase4Fixture(t),p=await journalQuestion(f),before=await f.stores.slots.read(p.control,'SHADOW');
  const sourceText='no alcohol, had coffee',result=await f.stores.journalAnswers.accept(p.context,request(p,{sourceUpdateId:'shadow:m1-factor',sourceText,
    candidate:{category:'caffeine',eventAt:p.question.target_window_start_utc,valueKind:'PRESENCE',exposureState:'CONFIRMED_UNEXPOSED',
      extractionConfidence:1,excerptStart:0,excerptEnd:[...sourceText].length}}));
  assert.equal(result.status,'REQUIRE_CLARIFICATION');assert.deepEqual(await f.stores.slots.read(p.control,'SHADOW'),before);
  for(const table of ['journal_events','journal_coverage_windows','structured_answer_events','telegram_operations'])
    assert.equal((await f.db.raw.execute(`SELECT count(*) n FROM ${table}`)).rows[0].n,0,table);
});

test('Uncertainty cannot resolve an exact coverage slot or create facts, coverage, receipts or generation changes',async t=>{
  const f=await syntheticPhase4Fixture(t),p=await journalQuestion(f,{coverage:true}),before=await f.stores.slots.read(p.control,'SHADOW');
  const state=(await f.db.raw.execute("SELECT source_generation,purge_generation,pending_purge_count FROM phase4_user_state WHERE user_id='a'")).rows[0];
  const sourceText='no idea',result=await f.stores.journalAnswers.accept(p.context,request(p,{sourceUpdateId:'shadow:m1-coverage',sourceText,
    candidate:{confirmed:true,extractionConfidence:1,excerptStart:0,excerptEnd:[...sourceText].length}}));
  assert.equal(result.status,'REQUIRE_CLARIFICATION');assert.deepEqual(await f.stores.slots.read(p.control,'SHADOW'),before);
  assert.deepEqual((await f.db.raw.execute("SELECT source_generation,purge_generation,pending_purge_count FROM phase4_user_state WHERE user_id='a'")).rows[0],state);
  for(const table of ['journal_events','journal_coverage_windows','structured_answer_events','telegram_operations'])
    assert.equal((await f.db.raw.execute(`SELECT count(*) n FROM ${table}`)).rows[0].n,0,table);
});

test('Full-source ambiguity cannot be hidden by a retained excerpt and leaves answer state untouched',async t=>{
  const f=await syntheticPhase4Fixture(t),p=await journalQuestion(f),before=await f.stores.slots.read(p.control,'SHADOW');
  const state=(await f.db.raw.execute("SELECT source_generation,purge_generation,pending_purge_count FROM phase4_user_state WHERE user_id='a'")).rows[0];
  const sourceText="don't know, no caffeine",excerpt='no caffeine',start=[...sourceText.slice(0,sourceText.indexOf(excerpt))].length;
  const result=await f.stores.journalAnswers.accept(p.context,request(p,{sourceUpdateId:'shadow:m1-trimmed',sourceText,
    candidate:{category:'caffeine',eventAt:p.question.target_window_start_utc,valueKind:'PRESENCE',exposureState:'CONFIRMED_UNEXPOSED',
      extractionConfidence:1,excerptStart:start,excerptEnd:start+[...excerpt].length}}));
  assert.equal(result.status,'REQUIRE_CLARIFICATION');assert.deepEqual(await f.stores.slots.read(p.control,'SHADOW'),before);
  assert.deepEqual((await f.db.raw.execute("SELECT source_generation,purge_generation,pending_purge_count FROM phase4_user_state WHERE user_id='a'")).rows[0],state);
  for(const table of ['journal_events','journal_coverage_windows','structured_answer_events','telegram_operations'])
    assert.equal((await f.db.raw.execute(`SELECT count(*) n FROM ${table}`)).rows[0].n,0,table);
});

test('SHADOW factor answers reject generic and positive-authority excerpt attacks with no durable or slot mutation',async t=>{
  const f=await syntheticPhase4Fixture(t),p=await journalQuestion(f),attacks=[
    ['no alcohol, had coffee','no',{exposureState:'CONFIRMED_UNEXPOSED'}],
    ['no caffeine','caffeine',{}],["didn't drink coffee",'drink coffee',{}],['沒有喝咖啡','喝咖啡',{}],
    ['I think I had coffee','had coffee',{}],['probably had coffee','had coffee',{}],['maybe had coffee','had coffee',{}],
    ["I don't remember, had coffee",'had coffee',{}],
  ];
  for(const [index,[sourceText,excerpt,options]] of attacks.entries()) {
    const before=await durableState(f),result=await f.stores.journalAnswers.accept(p.context,request(p,{sourceUpdateId:`shadow:authority-${index}`,
      ...presenceAnswer(p,sourceText,excerpt,options)}));
    assert.equal(result.status,'REQUIRE_CLARIFICATION',`${sourceText} -> ${excerpt}`);assert.deepEqual(await durableState(f),before);
  }
});

test('LIVE factor answers reject complete-source polarity attacks before receipts, facts, classification or any durable state changes',async t=>{
  const f=await syntheticPhase4Fixture(t),p=await journalQuestion(f,{mode:'LIVE'}),proof=await inboundAnswer(f,p.control),window={factor:'caffeine',
    windowStart:p.question.target_window_start_utc,windowEnd:p.question.target_window_end_utc};
  const beforeClassify=await f.stores.journal.classify(p.context,window),attacks=[
    ['no alcohol, had coffee','no',{exposureState:'CONFIRMED_UNEXPOSED'}],
    ['no caffeine','caffeine',{}],['did not drink coffee','drink coffee',{}],['沒有喝咖啡','咖啡',{}],
  ];
  for(const [sourceText,excerpt,options] of attacks) {
    const before=await durableState(f),result=await f.stores.journalAnswers.accept(p.context,request(p,{sourceUpdateId:'9101',inboundAuthority:proof,
      ...presenceAnswer(p,sourceText,excerpt,options)}));
    assert.equal(result.status,'REQUIRE_CLARIFICATION',`${sourceText} -> ${excerpt}`);assert.deepEqual(await durableState(f),before);
    assert.deepEqual(await f.stores.journal.classify(p.context,window),beforeClassify);
  }
});

test('Closed positive authority still accepts a bounded independent fact through the answer path',async t=>{
  const f=await syntheticPhase4Fixture(t),p=await journalQuestion(f),sourceText='no alcohol, had coffee',excerpt='had coffee';
  const accepted=await f.stores.journalAnswers.accept(p.context,request(p,{sourceUpdateId:'shadow:independent-positive',
    ...presenceAnswer(p,sourceText,excerpt)}));
  assert.equal(accepted.status,'ACCEPT');assert.equal(accepted.slot.state,'RESOLVED');
  const normalized=JSON.parse((await f.db.raw.execute('SELECT normalized_answer_json FROM structured_answer_events')).rows[0].normalized_answer_json);
  assert.equal(normalized.category,'caffeine');assert.equal(normalized.exposure_state,'EXPOSED');assert.equal(normalized.raw_answer_excerpt,'had coffee');
});

test('An exact complete-source generic negative remains valid for one server-owned factor and window',async t=>{
  const f=await syntheticPhase4Fixture(t),p=await journalQuestion(f),sourceText='no';
  const accepted=await f.stores.journalAnswers.accept(p.context,request(p,{sourceUpdateId:'shadow:generic-negative',
    ...presenceAnswer(p,sourceText,sourceText,{exposureState:'CONFIRMED_UNEXPOSED'})}));
  assert.equal(accepted.status,'ACCEPT');assert.equal(accepted.slot.state,'RESOLVED');
  const normalized=JSON.parse((await f.db.raw.execute('SELECT normalized_answer_json FROM structured_answer_events')).rows[0].normalized_answer_json);
  assert.equal(normalized.category,'caffeine');assert.equal(normalized.exposure_state,'CONFIRMED_UNEXPOSED');assert.equal(normalized.raw_answer_excerpt,'no');
});

test('LIVE accepted fact, source generation, answer receipt and matching slot resolve commit atomically without send capability',async t=>{
  const f=await syntheticPhase4Fixture(t),p=await journalQuestion(f,{mode:'LIVE'}),proof=await inboundAnswer(f,p.control);
  const options=request(p,{...factAnswer,sourceUpdateId:'9101',inboundAuthority:proof});
  await assert.rejects(f.stores.journalAnswers.accept(p.context,{...options,inboundAuthority:{}}),/AUTHORITY_REQUIRED/);
  await f.db.raw.execute("CREATE TRIGGER synthetic_answer_failure BEFORE INSERT ON structured_answer_events BEGIN SELECT RAISE(ABORT,'synthetic_answer_failure'); END");
  await assert.rejects(f.stores.journalAnswers.accept(p.context,options),/synthetic_answer_failure/);
  for(const table of ['journal_events','telegram_operations','structured_answer_events'])assert.equal((await f.db.raw.execute(`SELECT count(*) n FROM ${table}`)).rows[0].n,0);
  assert.equal((await f.stores.slots.read(p.control,'LIVE')).state,'AMBIGUOUS_WAIT');
  await f.db.raw.execute('DROP TRIGGER synthetic_answer_failure');
  const accepted=await f.stores.journalAnswers.accept(p.context,options);assert.equal(accepted.status,'ACCEPT');assert.equal(accepted.reply,null);
  const context=await f.stores.capture('a',{executionMode:'LIVE'});
  assert.equal((await f.stores.journal.read(context,accepted.logicalFactId)).row.numeric_value,100);
  const answer=await f.stores.readArtifact(context,'structured_answer_events',{answer_event_id:accepted.answerEventId});
  assert.equal(answer.row.input_generation,context.inputGeneration);assert.equal(answer.row.logical_fact_id,accepted.logicalFactId);
  assert.equal((await f.stores.journalAnswers.accept(context,{sourceUpdateId:'9101',inboundAuthority:proof})).answerEventId,accepted.answerEventId);
  assert.equal((await f.db.raw.execute('SELECT count(*) n FROM outbound_delivery_attempts')).rows[0].n,1); // synthetic question only
  assert.equal((await f.db.raw.execute('SELECT count(*) n FROM outbound_messages')).rows[0].n,1);
});

test('Coverage confirmation, window correction and deletion recompute exact tri-state classification and redact prior answer/receipt without expanding factors',async t=>{
  const f=await syntheticPhase4Fixture(t),p=await journalQuestion(f,{mode:'LIVE',coverage:true}),proof=await inboundAnswer(f,p.control);
  const accepted=await f.stores.journalAnswers.accept(p.context,request(p,{...coverageAnswer,sourceUpdateId:'9101',inboundAuthority:proof}));
  assert.equal(accepted.status,'ACCEPT');assert.ok(accepted.coverageWindowId);await f.stores.release(p.context);
  let context=await f.stores.capture('a',{executionMode:'SHADOW'});
  const window={factor:'caffeine',windowStart:p.question.target_window_start_utc,windowEnd:p.question.target_window_end_utc};
  assert.equal((await f.stores.journal.classify(context,window)).state,'CONFIRMED_UNEXPOSED');
  assert.equal((await f.stores.journal.classify(context,{...window,factor:'sauna'})).state,'UNKNOWN');await f.stores.release(context);
  const start='2026-09-18T12:00:00.000Z',sourceText=`none ${start}`;
  const change={coverageWindowId:accepted.coverageWindowId,expectedRevision:1,candidate:{...coverageAnswer.candidate,excerptEnd:sourceText.length},
    sourceText,windowStart:start,factors:['caffeine'],idempotencyKey:'coverage-correct'};
  await assert.rejects(f.stores.journalCoverage.correct(p.control,{...change,factors:['sauna']}),/EXPANSION_FORBIDDEN/);
  const correction=await f.stores.journalCoverage.correct(p.control,change);await f.stores.privacy.complete(p.control,correction.purgeId);
  context=await f.stores.capture('a',{executionMode:'SHADOW'});
  assert.equal((await f.stores.journal.classify(context,window)).state,'UNKNOWN');
  assert.equal((await f.stores.journal.classify(context,{...window,windowStart:start})).state,'CONFIRMED_UNEXPOSED');
  assert.equal((await f.stores.journal.classify(context,{...window,factor:'alcohol',windowStart:start})).state,'UNKNOWN');await f.stores.release(context);
  const rows=(await f.db.raw.execute('SELECT * FROM journal_coverage_windows ORDER BY revision')).rows;
  assert.equal(rows[0].content_state,'REDACTED');assert.equal(rows[1].revision,2);assert.equal(rows[1].supersedes_coverage_window_id,rows[0].coverage_window_id);
  assert.equal((await f.db.raw.execute('SELECT content_state FROM structured_answer_events ORDER BY answer_revision')).rows[0].content_state,'REDACTED');
  const revisions=(await f.db.raw.execute('SELECT * FROM structured_answer_events ORDER BY answer_revision')).rows;
  assert.equal(revisions.length,2);assert.equal(revisions[1].answer_revision,2);assert.equal(revisions[1].coverage_window_id,rows[1].coverage_window_id);
  assert.equal(revisions[1].supersedes_answer_event_id,revisions[0].answer_event_id);assert.equal(revisions[1].logical_answer_id,revisions[0].logical_answer_id);
  assert.equal((await f.db.raw.execute('SELECT content_state FROM telegram_operations')).rows[0].content_state,'REDACTED');
  const deletion=await f.stores.journalCoverage.remove(p.control,{coverageWindowId:rows[1].coverage_window_id,idempotencyKey:'coverage-delete'});
  await f.stores.privacy.complete(p.control,deletion.purgeId);
  context=await f.stores.capture('a',{executionMode:'SHADOW'});assert.equal((await f.stores.journal.classify(context,{...window,windowStart:start})).state,'UNKNOWN');
});

test('Semantically changed answer correction creates exactly one fresh revision; equivalent wording reuses it and deletion creates no answer event or slot transition',async t=>{
  const f=await syntheticPhase4Fixture(t),p=await journalQuestion(f,{mode:'LIVE'}),proof=await inboundAnswer(f,p.control);
  const first=await f.stores.journalAnswers.accept(p.context,request(p,{...factAnswer,sourceUpdateId:'9101',inboundAuthority:proof}));
  await f.stores.release(p.context);await f.db.completeTelegramUpdate(9101,{owner:'answer-owner',now:f.core.now()});
  const correctedProof=await inboundAnswer(f,p.control,9102),sourceText='caffeine 200mg';
  const corrected=await f.stores.journalInbound.process(p.control,correctedProof,{operation:'CORRECTION',logicalFactId:first.logicalFactId,expectedRevision:1,
    sourceText,candidate:{...factAnswer.candidate,numericValue:200,excerptEnd:sourceText.length}});
  assert.equal(corrected.complete,true);
  const answers=(await f.db.raw.execute('SELECT * FROM structured_answer_events ORDER BY answer_revision')).rows;
  assert.equal(answers.length,2);assert.equal(answers[0].content_state,'REDACTED');assert.equal(answers[1].answer_revision,2);assert.equal(answers[1].fact_revision,2);
  assert.equal(answers[1].logical_answer_id,answers[0].logical_answer_id);assert.equal(answers[1].source_update_id,'9102');assert.equal(answers[1].selected_followup_kind,null);
  const live=await f.stores.capture('a',{executionMode:'LIVE'});await f.stores.readArtifact(live,'structured_answer_events',{answer_event_id:answers[1].answer_event_id});await f.stores.release(live);
  const before=await f.stores.slots.read(p.control,'LIVE');assert.equal(before.state,'RESOLVED');
  const same=await f.stores.journal.correct(p.control,{logicalFactId:first.logicalFactId,expectedRevision:2,idempotencyKey:'wording-only',sourceText:'caffeine 200mg today',
    candidate:{...factAnswer.candidate,numericValue:200,extractionConfidence:0.95,excerptEnd:14}});
  assert.equal(same.unchanged,true);assert.equal(same.answerEventId,answers[1].answer_event_id);
  assert.equal((await f.db.raw.execute('SELECT count(*) n FROM structured_answer_events')).rows[0].n,2);
  const deletion=await f.stores.journal.remove(p.control,{logicalFactId:first.logicalFactId,idempotencyKey:'delete-answer'});await f.stores.privacy.complete(p.control,deletion.purgeId);
  assert.equal((await f.db.raw.execute('SELECT count(*) n FROM structured_answer_events')).rows[0].n,2);
  assert.equal((await f.db.raw.execute("SELECT count(*) n FROM structured_answer_events WHERE content_state='PRESENT'")).rows[0].n,0);
  assert.equal((await f.db.raw.execute("SELECT count(*) n FROM telegram_operations WHERE content_state='PRESENT'")).rows[0].n,0);
  assert.deepEqual(await f.stores.slots.read(p.control,'LIVE'),before);
});
