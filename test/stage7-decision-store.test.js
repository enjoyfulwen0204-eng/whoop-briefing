import test from 'node:test';import assert from 'node:assert/strict';
import {syntheticPhase4Fixture} from './phase4Fixture.js';
import {bodyInput,seedBodyInput} from './bodyEnergyFixture.js';
import {createStage7DecisionStore} from '../src/stage7DecisionStore.js';

test('Stage 7 decision reads typed current evidence, does not invent association utility, and replay retains its original NO_NOTIFICATION',async t=>{
 const at=Date.parse('2026-09-25T12:00:00.000Z'),f=await syntheticPhase4Fixture(t,{targetVersion:33,now:()=>new Date(at)}),input=bodyInput({asOf:at,days:30});
 for(let i=0;i<input.sources.recovery.length;i++)input.sources.recovery[i].recovery_score=i===0?15:[40,45,50,55,60][(i-1)%5];
 await f.db.transaction(()=>seedBodyInput(f.db,input));await f.db.linkTelegram({userId:'a',chatId:'123',now:f.core.now()});
 await f.db.raw.execute("INSERT INTO user_onboarding(user_id,state,state_changed_at,created_at,updated_at) VALUES('a','READY','2026-09-25','2026-09-25','2026-09-25')");
 const result=await f.stores.withContext('a',{executionMode:'SHADOW'},async context=>{
  const refs=[];for(const row of input.sources.recovery)refs.push((await f.stores.root(context,'recovery',row.sleep_id)).ref);
  return f.stores.intelligence.analyzeMetric(context,{metricKey:'recovery_score',currentSource:refs[0],baselineSources:refs.slice(1),asOfUtc:f.core.timestamp(),windowFamily:'DAILY_RECOVERY'});
 });
 await f.db.raw.execute("UPDATE phase4_computation_state SET last_completed_generation=input_generation WHERE user_id='a'");
 await f.db.raw.execute("UPDATE phase4_invalidations SET scope_kind='NONE' WHERE user_id='a'");
 const engine=createStage7DecisionStore(f),request={episodeId:result.episode.episode.row.episode_id,semanticEventId:result.episode.episode.row.last_semantic_event_id,triggerKey:'synthetic-trigger'};
 const first=await f.stores.withContext('a',{executionMode:'SHADOW'},context=>engine.evaluate(context,request));
 assert.equal(first.row.action,'NO_NOTIFICATION');
 const second=await f.stores.withContext('a',{executionMode:'SHADOW'},context=>engine.evaluate(context,request));assert.equal(second.created,false);assert.equal(second.row.action,'NO_NOTIFICATION');
 assert.equal((await f.db.raw.execute('SELECT count(*) n FROM phase4_proactive_decisions')).rows[0].n,1);
 assert.equal((await f.db.raw.execute('SELECT count(*) n FROM context_questions')).rows[0].n,0);
});
