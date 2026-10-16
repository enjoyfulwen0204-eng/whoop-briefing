import {confirmedLegacyBrief} from './confirmedLegacyBriefFixture.js';
import test from 'node:test';import assert from 'node:assert/strict';
import {stage7Fixture} from './stage7Fixture.js';
import {createSyntheticJournalTelegram,createStage7Dispatcher,createStage7Phase4Dispatcher} from '../src/stage7Dispatcher.js';
import {syntheticPhase4Fixture} from './phase4Fixture.js';
import {journalQuestion} from './journalQuestionFixture.js';
async function proposal(f){const actor=await f.companion.interactions.authenticate({user:f.user,chatId:'123'});await f.db.transaction(async()=>{const p=await f.companion.preferences(actor);await f.companion.changePreferences(actor,p,{daily_enabled:1});});await f.db.raw.execute({sql:"INSERT INTO report_claims(user_id,report_type,local_date,owner,claimed_at,expires_at,lifecycle_generation,delivery_state,telegram_message_id) VALUES('a','daily','2026-09-19','synthetic',?,?,?,'DELIVERED',11)",args:[f.core.timestamp(),f.core.timestamp(),f.user.lifecycleGeneration]});await confirmedLegacyBrief(f);return f.companion.prepareAfterBrief({user:f.user,chatId:'123',healthDay:'2026-09-19'});}

test('daily ambiguous send and restart are permanently suppressed; definite failure alone can retry',async t=>{
 for(const outcome of ['AMBIGUOUS','MALFORMED','FAILED_DEFINITE','DELIVERED']){
  const f=await stage7Fixture(t),p=await proposal(f),provider=createSyntheticJournalTelegram({outcomes:[outcome]}),dispatcher=createStage7Dispatcher({...f,provider});
  const request={user:f.user,chatId:'123',deliveryId:p.deliveryId};
  const first=await dispatcher.dispatch(request);assert.equal(first.status,outcome==='MALFORMED'?'AMBIGUOUS':outcome);
  const second=await dispatcher.dispatch(request);assert.equal(provider.calls.length,outcome==='FAILED_DEFINITE'?2:1);
  if(outcome==='FAILED_DEFINITE')assert.equal(second.status,'DELIVERED');
  assert.equal((await f.db.raw.execute('SELECT count(*) n FROM journal_prompt_deliveries')).rows[0].n,1);
  const claim=(await f.db.raw.execute('SELECT delivery_state FROM report_claims')).rows[0];assert.equal(claim.delivery_state,'DELIVERED');
 }
});
test('privacy/preference change before delivery prevents provider IO and callback capability cannot cross tenant',async t=>{
 const f=await stage7Fixture(t),p=await proposal(f),provider=createSyntheticJournalTelegram(),d=createStage7Dispatcher({...f,provider});
 const actor=await f.companion.interactions.authenticate({user:f.user,chatId:'123'});await f.db.transaction(async()=>{const prefs=await f.companion.preferences(actor);await f.companion.changePreferences(actor,prefs,{daily_enabled:0});});
 assert.equal((await d.dispatch({user:f.user,chatId:'123',deliveryId:p.deliveryId})).status,'SUPPRESSED');assert.equal(provider.calls.length,0);
 assert.throws(()=>createStage7Dispatcher({...f,provider:{send(){throw Error('LIVE_FORBIDDEN');}}}),/FAKE_PROVIDER/);
 const user=await f.db.getUser('b');assert.equal((await d.dispatch({user,chatId:'456',deliveryId:p.deliveryId})).status,'NOT_FOUND');
});
test('existing Phase 4 reservation and durable attempts retain ambiguous provider outcome without ASK-to-NOTIFY mutation',async t=>{
 const f=await syntheticPhase4Fixture(t,{targetVersion:33}),q=await journalQuestion(f,{mode:'LIVE',outcome:'AMBIGUOUS'}),provider=createSyntheticJournalTelegram();
 const d=await createStage7Phase4Dispatcher({...f,provider});
 const result=await d.dispatch({context:q.context,messageId:q.selected.messageId});assert.equal(result.state,'AMBIGUOUS');assert.equal(provider.calls.length,0);
 const action=(await f.db.raw.execute('SELECT action FROM phase4_proactive_decisions')).rows[0].action;assert.equal(action,'ASK_ONE_HIGHEST_VALUE_QUESTION');
});

test('concurrent dispatch has one attempt, and recovered DELIVERY_STARTED never calls the provider again',async t=>{
 const f=await stage7Fixture(t),p=await proposal(f),provider=createSyntheticJournalTelegram(),dispatcher=createStage7Dispatcher({...f,provider}),request={user:f.user,chatId:'123',deliveryId:p.deliveryId};
 await Promise.all([dispatcher.dispatch(request),dispatcher.dispatch(request)]);assert.equal(provider.calls.length,1);assert.equal((await f.db.raw.execute('SELECT count(*) n FROM journal_delivery_attempts')).rows[0].n,1);
 const other=await stage7Fixture(t),second=await proposal(other),fake=createSyntheticJournalTelegram();
 await other.db.raw.execute({sql:"UPDATE journal_prompt_deliveries SET state='DELIVERY_STARTED' WHERE user_id=? AND delivery_id=?",args:['a',second.deliveryId]});
 const recovered=createStage7Dispatcher({...other,provider:fake});await recovered.recover({user:other.user,chatId:'123',deliveryId:second.deliveryId});
 assert.equal((await recovered.dispatch({user:other.user,chatId:'123',deliveryId:second.deliveryId})).status,'AMBIGUOUS');assert.equal(fake.calls.length,0);
});
