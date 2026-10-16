import {confirmedLegacyBrief} from './confirmedLegacyBriefFixture.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {stage7Fixture} from './stage7Fixture.js';
import {createStage7TelegramDevelopment} from '../src/stage7TelegramDevelopment.js';
import {syntheticPhase4Fixture} from './phase4Fixture.js';
import {bodyInput,seedBodyInput} from './bodyEnergyFixture.js';
import {createStage7DecisionStore} from '../src/stage7DecisionStore.js';

async function confirmedBrief(f, day) {
  await f.db.raw.execute({sql:"INSERT INTO report_claims(user_id,report_type,local_date,owner,claimed_at,expires_at,lifecycle_generation,delivery_state,telegram_message_id) VALUES('a','daily',?,'synthetic-reviewer',?,?,?,'DELIVERED',11)",args:[day,f.core.timestamp(),f.core.timestamp(),f.user.lifecycleGeneration]});
  await confirmedLegacyBrief(f,{day});
}
async function enableDaily(f) {
  const actor=await f.companion.interactions.authenticate({user:f.user,chatId:'123'});
  await f.db.transaction(async()=>{const p=await f.companion.preferences(actor);await f.companion.changePreferences(actor,p,{daily_enabled:1});});
  return actor;
}

test('deleting a selection input physically removes dependent daily diagnostics',async t=>{
  let now=new Date('2026-09-19T00:00:00.000Z');
  const f=await stage7Fixture(t,{now:()=>now});await f.db.setLocale('a','en',{now});
  let card=await f.command();card=await f.tap(card,'Alcohol');card=await f.tap(card,'No');await f.tap(card,'Confirm');
  const fact=(await f.db.raw.execute("SELECT * FROM journal_events WHERE fact_status='ACTIVE'")).rows[0];
  now=new Date('2026-09-20T00:00:00.000Z');const actor=await enableDaily(f);await confirmedBrief(f,'2026-09-20');
  const prompt=await f.companion.prepareAfterBrief({user:f.user,chatId:'123',healthDay:'2026-09-20'});
  const before=await f.companion.interactions.read('a',prompt.interactionId);
  assert.equal(JSON.parse(before.diagnostics_json).candidates.find(c=>c.category==='alcohol').missingness,13/14);
  const purge=await f.stores.journal.remove(actor.control,{logicalFactId:fact.logical_fact_id,idempotencyKey:'independent-input-delete'});
  await f.stores.privacy.complete(actor.control,purge.purgeId);
  const after=await f.companion.interactions.read('a',prompt.interactionId);
  assert.equal((await f.db.raw.execute('SELECT count(*) n FROM journal_events')).rows[0].n,0);
  assert.equal(after.diagnostics_json,null,'Journal-derived selection diagnostics must be physically scrubbed');
});

test('Skip Today recent entries render a registered localized category',async t=>{
  const f=await stage7Fixture(t);await f.db.setLocale('a','en',{now:f.core.now()});
  let card=await f.command();await f.tap(card,'Skip today');card=await f.command();card=await f.tap(card,'Recent entries');
  assert.ok(!JSON.stringify(card.replyMarkup).includes('undefined'),'category-less day barriers must not be rendered as fact entries');
});

test('the Telegram daily reconciliation forwards authorized missing-context inputs',async t=>{
  const f=await stage7Fixture(t);await f.db.setLocale('a','en',{now:f.core.now()});await enableDaily(f);await confirmedBrief(f,'2026-09-19');
  const app=await createStage7TelegramDevelopment(f);
  await app.reconcileDaily({user:f.user,chatId:'123',healthDay:'2026-09-19',signal:{level:'STRONG',metric:'recovery',health_date:'2026-09-19'},metricSeries:[]});
  const row=(await f.db.raw.execute("SELECT * FROM quick_action_interactions WHERE kind='DAILY'")).rows[0];
  assert.equal(row.selection_reason,'MISSING_CONTEXT');
});

test('deleting a known-context input physically removes persisted decision diagnostics',async t=>{
  const at=Date.parse('2026-09-25T12:00:00.000Z'),f=await syntheticPhase4Fixture(t,{targetVersion:33,now:()=>new Date(at)}),input=bodyInput({asOf:at,days:30});
  for(let i=0;i<input.sources.recovery.length;i++)input.sources.recovery[i].recovery_score=i===0?15:[40,45,50,55,60][(i-1)%5];
  await f.db.transaction(()=>seedBodyInput(f.db,input));await f.db.linkTelegram({userId:'a',chatId:'123',now:f.core.now()});
  await f.db.raw.execute("INSERT INTO user_onboarding(user_id,state,state_changed_at,created_at,updated_at) VALUES('a','READY','2026-09-25','2026-09-25','2026-09-25')");
  const control=await f.stores.captureControl('a'),sourceText='caffeine 100mg at 2026-09-24T12:00:00.000Z';
  const fact=await f.stores.journal.create(control,{sourceEventKey:'independent-decision-known',sourceText,candidate:{category:'caffeine',eventAt:'2026-09-24T12:00:00.000Z',valueKind:'NUMERIC',numericValue:100,unit:'mg',exposureState:'EXPOSED',extractionConfidence:1,excerptStart:0,excerptEnd:sourceText.length}});
  assert.equal(fact.status,'ACCEPT');
  const result=await f.stores.withContext('a',{executionMode:'SHADOW'},async context=>{
    const refs=[];for(const row of input.sources.recovery)refs.push((await f.stores.root(context,'recovery',row.sleep_id)).ref);
    return f.stores.intelligence.analyzeMetric(context,{metricKey:'recovery_score',currentSource:refs[0],baselineSources:refs.slice(1),asOfUtc:f.core.timestamp(),windowFamily:'DAILY_RECOVERY'});
  });
  await f.db.raw.execute("UPDATE phase4_computation_state SET last_completed_generation=input_generation WHERE user_id='a'");
  await f.db.raw.execute("UPDATE phase4_invalidations SET scope_kind='NONE' WHERE user_id='a'");
  const episode=result.episode.episode.row,engine=createStage7DecisionStore(f);
  const decision=await f.stores.withContext('a',{executionMode:'SHADOW'},context=>engine.evaluate(context,{episodeId:episode.episode_id,semanticEventId:episode.last_semantic_event_id,triggerKey:'independent-known-delete'}));
  const before=decision.row,known=JSON.parse(before.candidate_diagnostics_json).find(c=>c.category==='caffeine');assert.equal(known.components.K,1);
  const purge=await f.stores.journal.remove(control,{logicalFactId:fact.logicalFactId,idempotencyKey:'independent-known-remove'});await f.stores.privacy.complete(control,purge.purgeId);
  const after=(await f.db.raw.execute({sql:'SELECT * FROM phase4_proactive_decisions WHERE decision_id=?',args:[before.decision_id]})).rows[0];
  assert.equal(after.candidate_diagnostics_json,null,'Journal-derived decision K/U/known diagnostics must be scrubbed');
});

test('v33 direct canonical user-text create/correct/delete preserves Foundation boundaries',async t=>{
  const f=await syntheticPhase4Fixture(t,{targetVersion:33}),control=await f.stores.captureControl('a');
  const make=amount=>{const sourceText=`caffeine ${amount}mg`;return {sourceText,sourceEventKey:'independent-direct',candidate:{category:'caffeine',eventAt:f.core.timestamp(),valueKind:'NUMERIC',numericValue:amount,unit:'mg',exposureState:'EXPOSED',extractionConfidence:1,excerptStart:0,excerptEnd:sourceText.length}};};
  const first=await f.stores.journal.create(control,make(100));assert.equal(first.status,'ACCEPT');
  const corrected=await f.stores.journal.correct(control,{...make(200),logicalFactId:first.logicalFactId,expectedRevision:1,idempotencyKey:'independent-direct-correct'});await f.stores.privacy.complete(control,corrected.purgeId);
  const rows=(await f.db.raw.execute('SELECT * FROM journal_events ORDER BY revision')).rows;assert.equal(rows[0].content_state,'REDACTED');assert.equal(rows[1].numeric_value,200);assert.equal(rows[1].provenance_mode,'USER_TEXT');
  const deleted=await f.stores.journal.remove(control,{logicalFactId:first.logicalFactId,idempotencyKey:'independent-direct-delete'});await f.stores.privacy.complete(control,deleted.purgeId);
  assert.equal((await f.db.raw.execute('SELECT count(*) n FROM journal_events')).rows[0].n,0);assert.equal((await f.stores.journal.create(control,make(100))).redacted,true);
});
