import {confirmedLegacyBrief} from './confirmedLegacyBriefFixture.js';
import test from 'node:test';import assert from 'node:assert/strict';
import {syntheticPhase4Fixture} from './phase4Fixture.js';
import {createStage7Companion} from '../src/stage7Companion.js';
import {selectDailyQuestion} from '../src/questionEngine.js';
import {TOPICS} from '../src/stage7Registry.js';
import {addDays} from '../src/time.js';

test('daily policy rotates neutral days, tracking raises relevance, known context suppresses, missing is not NO',()=>{
 const history=[],seen=new Set();
 for(let d=0;d<14;d++){
  const targetDate=addDays('2026-09-01',d),result=selectDailyQuestion({topics:TOPICS,history,knownFacts:[],healthDay:addDays(targetDate,1),targetDate});
  assert.ok(result);assert.equal(result.reason,'ROTATION_NEUTRAL');assert.notEqual(result.category,history.at(-1)?.category);seen.add(result.category);history.push({category:result.category,target_date:targetDate});
  assert.deepEqual(result,selectDailyQuestion({topics:TOPICS,history:history.slice(0,-1),knownFacts:[],healthDay:addDays(targetDate,1),targetDate}));
 }
 assert.equal(seen.size,7);
 const result=selectDailyQuestion({topics:TOPICS,trackingTopics:['stress'],healthDay:'2026-09-19',targetDate:'2026-09-18'});assert.equal(result.category,'stress');
 assert.notEqual(selectDailyQuestion({topics:TOPICS,trackingTopics:['stress'],healthDay:'2026-09-19',targetDate:'2026-09-18',knownFacts:[{category:'stress',health_date:'2026-09-18',exposure_state:'EXPOSED'}]}).category,'stress');
});

test('confirmed Morning Brief is prerequisite; post-brief state is independent, durable and default disabled',async t=>{
 const f=await syntheticPhase4Fixture(t,{targetVersion:34});await f.db.linkTelegram({userId:'a',chatId:'123',now:f.core.now()});await f.db.saveTokens('a',{accessToken:'synthetic',refreshToken:'synthetic',expiresAt:new Date('2026-12-01T00:00:00.000Z'),scope:'offline',whoopUserId:'synthetic'},{now:f.core.now()});const user=await f.db.getUser('a');let c=createStage7Companion({...f});
 const actor=await c.interactions.authenticate({user,chatId:'123'});await f.db.transaction(async()=>{const p=await c.preferences(actor);await c.changePreferences(actor,p,{daily_enabled:1});});
 const request={user,chatId:'123',healthDay:'2026-09-19'};
 assert.equal((await c.prepareAfterBrief(request)).status,'BRIEF_NOT_CONFIRMED');
 await f.db.raw.execute({sql:"INSERT INTO report_claims(user_id,report_type,local_date,owner,claimed_at,expires_at,lifecycle_generation,delivery_state) VALUES('a','daily','2026-09-19','synthetic',?,?,?,'AMBIGUOUS')",args:[f.core.timestamp(),f.core.timestamp(),user.lifecycleGeneration]});
 assert.equal((await c.prepareAfterBrief(request)).status,'BRIEF_NOT_CONFIRMED');
 await f.db.raw.execute("UPDATE report_claims SET delivery_state='DELIVERED',telegram_message_id=7 WHERE user_id='a'");
 await confirmedLegacyBrief({...f,companion:c,user},{messageId:7});
 const claim=(await f.db.raw.execute('SELECT * FROM report_claims')).rows[0];
 const result=await c.prepareAfterBrief(request);assert.equal(result.status,'PROPOSED');
 const row=await c.interactions.read('a',result.interactionId);assert.equal(row.target_date,'2026-09-18');assert.equal(Date.parse(row.expires_at)-Date.parse(row.created_at),48*3600000);
 const restarted=await f.restart();c=createStage7Companion({...restarted,db:f.db});assert.equal((await c.prepareAfterBrief(request)).status,'EXISTING');
 assert.deepEqual((await f.db.raw.execute('SELECT * FROM report_claims')).rows[0],claim);
 assert.equal((await f.db.raw.execute('SELECT count(*) n FROM journal_prompt_deliveries')).rows[0].n,1);
 assert.equal((await f.db.raw.execute('SELECT count(*) n FROM journal_events')).rows[0].n,0);
});
