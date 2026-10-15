import test from 'node:test';import assert from 'node:assert/strict';
import {syntheticPhase4Fixture} from './phase4Fixture.js';
import {bodyInput,seedBodyInput} from './bodyEnergyFixture.js';
import {createStage8MorningStore} from '../src/stage8MorningStore.js';
import {morningWallInstant,morningPlanTiming} from '../src/morningBriefPolicy.js';
async function fixture(t){let at=new Date('2026-09-19T00:00:00Z');const now=()=>new Date(at),f=await syntheticPhase4Fixture(t,{targetVersion:34,now});
 await seedBodyInput(f.db,bodyInput({days:2}));await f.db.linkTelegram({userId:'a',chatId:'123',now:now()});await f.db.setLocale('a','en',{now:now()});
 await f.db.raw.execute({sql:"INSERT INTO user_onboarding(user_id,state,state_changed_at,created_at,updated_at) VALUES('a','READY',?,?,?)",args:[now().toISOString(),now().toISOString(),now().toISOString()]});
 await f.core.initializeTenant('a','LIVE');
 const store=createStage8MorningStore({...f,preferences:f.stores.preferences,enabled:uid=>uid==='a'}),control=await f.core.captureControl('a');
 return {...f,store,control,setTime:value=>{at=new Date(value);}};
}
async function cutover(f){await f.store.requestCutover(f.control,{expectedRevision:0});f.setTime('2026-09-20T02:10:00Z');}
test('wall time chooses first repeated occurrence and first time after DST gap',()=>{
 assert.equal(new Date(morningWallInstant('2026-11-01','01:30','America/New_York')).toISOString(),'2026-11-01T05:30:00.000Z');
 assert.equal(new Date(morningWallInstant('2026-03-08','02:30','America/New_York')).toISOString(),'2026-03-08T07:00:00.000Z');
});
test('fallback does not turn missing wake into zero delay; next preferred time is explicit expiry',()=>{
 const prefs={morning_brief_mode:'AFTER_WAKE',after_wake_delay_minutes:30,fallback_local_time:'10:00',notifications_paused:0};
 assert.equal(morningPlanTiming({now:Date.parse('2026-09-20T01:50Z'),day:'2026-09-20',timezone:'Asia/Taipei',preferences:prefs}).eligible,false);
 assert.equal(morningPlanTiming({now:Date.parse('2026-09-20T02:10Z'),day:'2026-09-20',timezone:'Asia/Taipei',preferences:prefs}).eligible,true);
});
test('typed missing-data brief has real reservation, source plan and ambiguous permanent dedupe',async t=>{
 const f=await fixture(t);await cutover(f);const ready=await f.store.prepare(f.control);assert.equal(ready.status,'READY');
 const ctx=await f.store.context(f.control),row=await f.core.artifact(ctx,'outbound_messages',{message_id:ready.messageId});
 assert.match(row.row.payload_text,/Not available yet/);assert.match(row.row.payload_text,/Analysis is updating/);
 const eligible=await f.store.transport.makeEligible(ctx,{messageId:ready.messageId,expectedRevision:ready.revision});
 const lease=await f.store.transport.claim(ctx,{messageId:ready.messageId,owner:'fixture-dispatcher'});assert.ok(lease);
 const start=await f.store.transport.start(ctx,lease);assert.equal(start.messageId,ready.messageId);
 await f.store.transport.settle(f.control,'LIVE',{attemptId:start.attemptId,outcome:'AMBIGUOUS',ambiguityReason:'UNKNOWN_ACCEPTANCE'});
 assert.equal((await f.store.prepare(f.control)).status,'ALREADY_SETTLED');
 assert.equal((await f.db.raw.execute("SELECT count(*) n FROM outbound_messages")).rows[0].n,1);
 assert.equal((await f.db.raw.execute("SELECT last_completed_generation FROM phase4_computation_state WHERE user_id='a' AND execution_mode='LIVE'")).rows[0].last_completed_generation,0);
});
test('unstarted generation/profile refresh preserves message and consumes exactly one permit',async t=>{
 const f=await fixture(t);await cutover(f);const first=await f.store.prepare(f.control);
 await f.db.setLocale('a','vi');await f.stores.queue.sourceChanged(f.control,{reasonCode:'SOURCE_CHANGED'});
 const second=await f.store.prepare(f.control);assert.equal(second.status,'READY');assert.equal(second.refreshed,true);assert.equal(second.messageId,first.messageId);
 assert.equal((await f.db.raw.execute('SELECT count(*) n FROM morning_projection_consumptions')).rows[0].n,1);
 const third=await f.store.prepare(f.control);assert.equal(third.refreshed,undefined);assert.equal(third.messageId,first.messageId);
 const ctx=await f.store.context(f.control),row=await f.core.artifact(ctx,'outbound_messages',{message_id:first.messageId});await f.store.plans.validate(ctx,row.row);
 await assert.rejects(f.db.raw.execute({sql:"UPDATE outbound_messages SET payload_text='forged',revision=revision+1 WHERE message_id=?",args:[first.messageId]}),/append_only|immutable/);
});
test('future local cutover leaves preceding date legal and rejects legacy claims on new date',async t=>{
 const f=await fixture(t);await f.store.requestCutover(f.control,{expectedRevision:0});f.setTime('2026-09-20T00:00:00Z');
 await f.store.commitCutover(await f.store.context(f.control));
 const insert=day=>f.db.raw.execute({sql:"INSERT INTO report_claims(user_id,report_type,local_date,owner,claimed_at,expires_at,lifecycle_generation) VALUES('a','daily',?,'fixture',?,?,1)",args:[day,'2026-09-19T23:00:00Z','2026-09-19T23:01:00Z']});
 await insert('2026-09-19');await assert.rejects(insert('2026-09-20'),/morning_phase4_delivery_owner/);
});
test('late service recovery expires original brief and closes its date without sending',async t=>{
 const f=await fixture(t);await cutover(f);const ready=await f.store.prepare(f.control);f.setTime('2026-09-21T02:10:00Z');
 assert.equal((await f.store.prepare(f.control,{healthDate:'2026-09-20'})).status,'EXPIRED_SYSTEM_OUTAGE');
 assert.equal((await f.db.raw.execute('SELECT reason FROM morning_expiry_audit')).rows[0].reason,'EXPIRED_SYSTEM_OUTAGE');
 assert.equal((await f.db.raw.execute('SELECT state FROM outbound_semantic_reservations')).rows[0].state,'CLOSED');
});
