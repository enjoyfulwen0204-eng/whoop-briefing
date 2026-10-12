import test from 'node:test';
import assert from 'node:assert/strict';
import {syntheticPhase4Fixture} from './phase4Fixture.js';
import {journalQuestion} from './journalQuestionFixture.js';
import {createStage7Phase4Dispatcher,createSyntheticJournalTelegram} from '../src/stage7Dispatcher.js';

// Boundary injection only: count=9 models the existing registered runaway threshold.
// All targets, reservations, parent/source graphs and writes use the native synthetic DB.
const countNineCore=core=>({...core,client:{protocol:core.client.protocol,execute:q=>{
  if(typeof q?.sql==='string'&&q.sql.startsWith('SELECT count(*) n FROM outbound_messages'))return Promise.resolve({rows:[{n:9}]});
  return core.client.execute(q);
}}});

test('proactive runaway suppression leaves a valid Morning Brief target independent',async t=>{
  const f=await syntheticPhase4Fixture(t,{targetVersion:33}),q=await journalQuestion(f,{mode:'LIVE'}),context=q.context,source=await f.stores.root(context,'USER','a');
  await f.stores.transport.mode(context,'MORNING_BRIEF_V1');
  await f.db.raw.execute("UPDATE tenant_delivery_modes SET mode='PHASE4',revision=revision+1,reason_code='CUTOVER_COMMITTED',cutover_boundary='2026-09-19T00:00:00.000Z',timezone='Asia/Taipei' WHERE user_id='a' AND execution_mode='LIVE' AND message_family='MORNING_BRIEF_V1'");
  const message=await f.stores.messages.propose(context,{semantic:{family:'MORNING_BRIEF_V1',identity:'2026-09-19'},message:{payload_text:'Synthetic Morning Brief',expires_at:'2026-09-20T00:00:00.000Z'},sourceRefs:[source.ref]});
  const d=await createStage7Phase4Dispatcher({...f,core:countNineCore(f.core),provider:createSyntheticJournalTelegram()});
  const result=await d.dispatch({context,messageId:message.row.message_id});
  assert.equal(result.state,'DELIVERED');
});

test('pre-send breaker cancellation releases its own RESERVED question slot',async t=>{
  const f=await syntheticPhase4Fixture(t,{targetVersion:33});
  const deferred={...f,stores:{...f.stores,slots:{...f.stores.slots,beginSimulation:async()=>({}),classifySimulation:async()=>({})}}};
  const q=await journalQuestion(deferred,{mode:'SHADOW'}),question=await f.stores.readArtifact(q.context,'context_questions',{question_request_id:q.selected.questionRequestId});
  const message=await f.stores.messages.propose(q.context,{semantic:{family:'CONTEXT_QUESTION',identity:q.selected.questionRequestId},message:{decision_id:q.selected.decisionId,question_request_id:q.selected.questionRequestId,episode_id:question.row.episode_id,payload_text:'Synthetic question',expires_at:'2026-09-20T00:00:00.000Z'},sourceRefs:[question.ref]});
  await f.stores.slots.bindProposal(q.context,{questionRequestId:q.selected.questionRequestId,messageId:message.row.message_id});
  const d=await createStage7Phase4Dispatcher({...f,core:countNineCore(f.core),provider:createSyntheticJournalTelegram()});
  const result=await d.dispatch({context:q.context,messageId:message.row.message_id});
  const slot=(await f.db.raw.execute("SELECT * FROM phase4_question_interaction_slots WHERE user_id='a' AND execution_mode='SHADOW'")).rows[0];
  assert.equal(slot.state,'CANCELLED_PRE_SEND');
});
