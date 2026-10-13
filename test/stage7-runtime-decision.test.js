import test from 'node:test';
import assert from 'node:assert/strict';
import {syntheticPhase4Fixture} from './phase4Fixture.js';
import {bodyInput,seedBodyInput} from './bodyEnergyFixture.js';
import {setup,hypothesis,family} from './stage5AssociationFixture.js';
import {call} from './stage5ClosureFixture.js';
import {finalizedFixtureDrain} from './finalizedStage6Fixture.js';
import {bindProducingExecution} from '../src/phase4ExecutionContext.js';
import {workStepOptions} from '../src/phase4WorkStep.js';
import {createStage7DecisionStore} from '../src/stage7DecisionStore.js';
import {createStage7Development} from '../src/stage7Development.js';
import {createStage7TelegramDevelopment} from '../src/stage7TelegramDevelopment.js';
const AT=Date.parse('2026-09-25T12:00:00.000Z');
async function ready(f){
 await f.db.linkTelegram({userId:'a',chatId:'123',now:f.core.now()});
 await f.stores.preferences.read(await f.stores.captureControl('a'));
 await f.db.raw.execute("INSERT INTO user_onboarding(user_id,state,state_changed_at,created_at,updated_at) VALUES('a','READY','2026-09-25','2026-09-25','2026-09-25')");
 await f.db.raw.execute("UPDATE phase4_computation_state SET last_completed_generation=input_generation WHERE user_id='a'");
 await f.db.raw.execute("UPDATE phase4_invalidations SET scope_kind='NONE' WHERE user_id='a'");
}
async function metric(f,input,index=0){
 return f.stores.withContext('a',{executionMode:'SHADOW'},async context=>{
  const refs=[];for(const row of input.sources.recovery)refs.push((await f.stores.root(context,'recovery',row.sleep_id)).ref);
  return f.stores.intelligence.analyzeMetric(context,{metricKey:'recovery_score',currentSource:refs[index],baselineSources:refs.slice(index+1,index+31),asOfUtc:f.core.timestamp(),windowFamily:'STAGE7_RUNTIME'});
 });
}
async function produced(f,work){
 let value;await finalizedFixtureDrain(f.db,{drain:async()=>{
  await f.stores.withContext('a',{executionMode:'SHADOW'},context=>f.core.run(context,async()=>{await bindProducingExecution(f.core.client,context);},workStepOptions('stage7-test-producing-domain',[context.userId,context.inputGeneration],{discardResult:true})));
  value=await work();
  return {outcome:'COMPLETE',processedItems:1,completedJobs:0,failedJobs:0,remainingJobs:0,completion:'COMPLETE'};
 }},{});return value;
}
const request=(episode,triggerKey)=>({episodeId:episode.episode_id,semanticEventId:episode.last_semantic_event_id,triggerKey});
const evaluate=(f,engine,episode,key)=>f.stores.withContext('a',{executionMode:'SHADOW'},context=>engine.evaluate(context,request(episode,key)));

test('real current metric evidence reaches NOTIFY, typed localized proposal and consumed semantic replay; pause and staleness reach NO/DEFER',async t=>{
 let clock=AT;const f=await syntheticPhase4Fixture(t,{targetVersion:33,now:()=>new Date(clock)}),input=bodyInput({asOf:AT,days:30});
 for(let i=0;i<input.sources.recovery.length;i++)input.sources.recovery[i].recovery_score=i===0?0:[40,45,50,55,60][(i-1)%5];
 await f.db.transaction(()=>seedBodyInput(f.db,input));const analyzed=await metric(f,input);await ready(f);
 const engine=createStage7DecisionStore(f),episode=analyzed.episode.episode.row;
 const first=await evaluate(f,engine,episode,'notify');assert.equal(first.row.action,'NOTIFY',JSON.stringify(JSON.parse(first.row.gate_results_json)));
 const diagnostics=JSON.parse(first.row.candidate_diagnostics_json);assert.ok(diagnostics.every(c=>c.components.T===1&&c.components.U===0&&c.components.R===0));
 await f.db.setLocale('a','vi',{now:f.core.now()});
 const proposal=await f.stores.withContext('a',{executionMode:'SHADOW'},context=>engine.propose(context,{decisionId:first.row.decision_id}));
 assert.equal(proposal.row.message_class,'EPISODE_NOTIFICATION');assert.equal(JSON.parse(proposal.row.payload_json).locale,'vi');assert.match(proposal.row.payload_text,/phục hồi|hồi phục/i);
 await f.stores.withContext('a',{executionMode:'SHADOW'},context=>f.stores.messages.simulate(context,proposal.row.message_id,'AMBIGUOUS'));
 assert.equal((await evaluate(f,engine,episode,'after-consumption')).row.action,'NO_NOTIFICATION');
 assert.equal((await evaluate(f,engine,episode,'notify')).row.action,'NOTIFY');
 const control=await f.stores.captureControl('a'),prefs=await f.stores.preferences.read(control);
 await f.stores.preferences.update(control,prefs.preference_version,{notifications_paused:1});
 assert.equal((await evaluate(f,engine,episode,'paused')).row.action,'NO_NOTIFICATION');
 await f.stores.preferences.update(control,(await f.stores.preferences.read(control)).preference_version,{notifications_paused:0});
 clock+=3*86400000;
 assert.equal((await evaluate(f,engine,episode,'stale')).row.action,'DEFER_OBSERVATION');
});

test('synthetic source health dates follow the tenant day across UTC boundaries',()=>{
 for(const [timezone,instant,expected] of [['Asia/Taipei','2026-10-12T16:30:00Z','2026-10-13'],['America/New_York','2026-10-12T02:30:00Z','2026-10-11']]){
  const input=bodyInput({asOf:Date.parse(instant),days:1,timezone});
  assert.equal(input.sources.sleep[0].health_date,expected);assert.equal(input.sources.recovery[0].health_date,expected);
 }
});

test('actual replicated association and unknown current context reach ASK with owned slot/proposal and exact registered components',async t=>{
 const f=await setup(t,{targetVersion:33,days:60,wallClock:AT+12*3600000});
 await f.stores.release(f.context);f.context=null;
 await f.db.raw.execute("UPDATE whoop_recoveries SET recovery_score=20 WHERE user_id='a' AND sleep_id='sleep-00'");
 await produced(f,()=>metric(f,f.input));
 await produced(f,()=>call(f,'intelligence','analyzeAssociationFamily',family('stage7-old',hypothesis(f,Array.from({length:30},(_,i)=>i+30)),f.core.timestamp())));
 const supported=await produced(f,()=>call(f,'intelligence','analyzeAssociationFamily',family('stage7-recent',hypothesis(f,Array.from({length:30},(_,i)=>i)),f.core.timestamp())));
 assert.ok(supported.items[0].insight,JSON.stringify(supported.items[0].analysis));
 assert.equal(supported.items[0].insight.current.row.status,'SUPPORTED');
 const next={...f.input.sources.recovery[0],sleep_id:'stage7-next-day',health_date:'2026-09-26',recovery_score:20,updated_at:f.core.timestamp(),synced_at:f.core.timestamp()};
 const fields=Object.keys(next);await f.db.raw.execute({sql:`INSERT INTO whoop_recoveries(${fields.join(',')}) VALUES(${fields.map(()=>'?').join(',')})`,args:fields.map(k=>next[k])});
 f.input.sources.recovery.unshift(next);
 const analyzed=await produced(f,()=>metric(f,f.input));await ready(f);const episode=analyzed.episode.episode.row;
 const engine=createStage7DecisionStore(f),selected=await evaluate(f,engine,episode,'ask');
 assert.equal(selected.action,'ASK_ONE_HIGHEST_VALUE_QUESTION');
 const row=(await f.db.raw.execute({sql:'SELECT * FROM phase4_proactive_decisions WHERE decision_id=?',args:[selected.decisionId]})).rows[0],winner=JSON.parse(row.candidate_diagnostics_json).find(c=>c.category==='caffeine');
 assert.equal(winner.components.U,1);assert.equal(winner.components.R,1);assert.equal(winner.components.T,1);assert.equal(winner.components.P,0);assert.equal(winner.components.F,0);
 const proposed=await f.stores.withContext('a',{executionMode:'SHADOW'},context=>engine.propose(context,{decisionId:selected.decisionId}));
 assert.equal(proposed.row.message_class,'CONTEXT_QUESTION');
 assert.match(proposed.row.payload_text,/\n🗓 .*2026-09-25$/);
 const slot=await f.stores.slots.read(await f.stores.captureControl('a'),'SHADOW');assert.equal(slot.question_request_id,selected.questionRequestId);assert.equal(slot.outbound_message_id,proposed.row.message_id);
 assert.equal((await evaluate(f,engine,episode,'ask')).created,false);
 const companion=await createStage7Development(f),user=await f.db.getUser('a'),actor=await companion.interactions.authenticate({user,chatId:'123'}),weekly=await companion.weekly.build(actor);
 assert.ok(weekly.summary.associations.some(a=>a.factor==='caffeine'&&a.metric==='recovery_score'));
 assert.ok(weekly.sourceEvidenceIds.length>0);
});

test('fully composed post-brief journal derives context from existing typed evidence without caller hints or another sync',async t=>{
 const f=await syntheticPhase4Fixture(t,{targetVersion:33,now:()=>new Date(AT)}),input=bodyInput({asOf:AT,days:30});
 for(let i=0;i<input.sources.recovery.length;i++)input.sources.recovery[i].recovery_score=i===0?0:[40,45,50,55,60][(i-1)%5];
 await f.db.transaction(()=>seedBodyInput(f.db,input));await produced(f,()=>metric(f,input));await ready(f);
 const app=await createStage7TelegramDevelopment(f),user=await f.db.getUser('a'),actor=await app.companion.interactions.authenticate({user,chatId:'123'});
 await f.db.transaction(async()=>{const p=await app.companion.preferences(actor);await app.companion.changePreferences(actor,p,{daily_enabled:1});});
 await f.db.raw.execute({sql:"INSERT INTO report_claims(user_id,report_type,local_date,owner,claimed_at,expires_at,lifecycle_generation,delivery_state,telegram_message_id) VALUES('a','daily','2026-09-25','synthetic',?,?,?,'DELIVERED',11)",args:[f.core.timestamp(),f.core.timestamp(),user.lifecycleGeneration]});
 const result=await app.reconcileDaily({user,chatId:'123',healthDay:'2026-09-25'});assert.equal(result.status,'DELIVERED');
 const row=(await f.db.raw.execute("SELECT * FROM quick_action_interactions WHERE kind='DAILY'")).rows[0];assert.equal(row.selection_reason,'MISSING_CONTEXT');
 assert.ok((await f.db.raw.execute({sql:"SELECT 1 FROM phase4_source_links WHERE user_id='a' AND artifact_id=? AND source_type='evidence_items'",args:[row.privacy_artifact_id]})).rows.length);
});
