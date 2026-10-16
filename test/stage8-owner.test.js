import {grantSourceConsent} from './stage8SourceConsentFixture.js';
import test from 'node:test';import assert from 'node:assert/strict';
import {syntheticPhase4Fixture} from './phase4Fixture.js';import {bodyInput,seedBodyInput} from './bodyEnergyFixture.js';
import {createOwnerMonitoring} from '../src/stage8OwnerMonitoring.js';import {createStage8MorningPlan} from '../src/stage8MorningPlan.js';
async function fixture(t){const now=()=>new Date('2026-09-19T01:10:00Z'),f=await syntheticPhase4Fixture(t,{targetVersion:34,now});
 for(const [uid,chat] of [['a','123'],['b','456']]){const input=bodyInput({days:2});input.userId=uid;
  for(const group of [...Object.values(input.sources),input.access,input.sync,input.capabilities])for(const row of group)row.user_id=uid;
  await seedBodyInput(f.db,input);await f.db.linkTelegram({userId:uid,chatId:chat,now:now()});await f.db.setLocale(uid,'en',{now:now()});
  await f.db.raw.execute({sql:"INSERT INTO user_onboarding(user_id,state,state_changed_at,created_at,updated_at) VALUES(?,'READY',?,?,?)",args:[uid,now().toISOString(),now().toISOString(),now().toISOString()]});
 }
 const owner=await createOwnerMonitoring({...f,ownerId:'a',enabled:()=>true,now}),user=await f.db.getUser('a'),actor=await owner.authenticate({user,chatId:'123'});
 const follow=async(klass='DAILY_SUMMARY',enabled=true,expectedRevision=0)=>{if(enabled&&['DAILY_SUMMARY','IMPORTANT_ALERT','WEEKLY_SUMMARY'].includes(klass))await grantSourceConsent(f,{notificationClass:klass});return owner.configure(actor,{subjectId:'b',notificationClass:klass,enabled,expectedRevision,operationKey:`test-${klass}-${expectedRevision}`});};
 const plan=async()=>{await f.core.initializeTenant('b','LIVE');const ctx=await f.core.capture('b',{executionMode:'LIVE'}),plans=createStage8MorningPlan({...f,preferences:f.stores.preferences});return plans.persist(ctx,await plans.build(ctx,{healthDate:'2026-09-19'}));};
 return {...f,owner,actor,user,follow,plan};
}
test('owner monitoring starts with no subscriptions and denies ordinary actor / non-enrolled subject',async t=>{
 const f=await fixture(t);assert.deepEqual(await f.owner.subscriptions(f.actor),[]);
 await assert.rejects(f.owner.authenticate({user:await f.db.getUser('b'),chatId:'456'}),/AUTHORITY_REQUIRED/);
 await assert.rejects(f.owner.authorize(f.actor,{subjectId:'b',notificationClass:'DAILY_SUMMARY'}),/SUBSCRIPTION_FENCED|SOURCE_CONSENT_REQUIRED/);
 await assert.rejects(f.follow('FAMILY_VIEW'),/CLASS_NOT_ALLOWED/);
 await f.db.raw.execute("UPDATE user_onboarding SET state='ACTION_REQUIRED' WHERE user_id='b'");await assert.rejects(f.follow(),/PRINCIPAL_FENCED|SOURCE_CONSENT_NOT_READY/);
 assert.equal((await f.db.raw.execute('SELECT count(*) n FROM owner_monitoring_outbox')).rows[0].n,0);
});
test('explicit follow is revisioned and missing current producer is an honest state',async t=>{
 const f=await fixture(t);const first=await f.follow();assert.equal(first.revision,1);assert.equal((await f.follow()).replayed,true);
 assert.equal((await f.owner.authorize(f.actor,{subjectId:'b',notificationClass:'DAILY_SUMMARY'})).status,'NO_CURRENT_SYNTHESIS');
 await assert.rejects(f.owner.configure(f.actor,{subjectId:'b',notificationClass:'DAILY_SUMMARY',enabled:false,expectedRevision:0,operationKey:'new'}),/SUBSCRIPTION_CAS/);
});
test('genuine fixture source plan produces only approved summary and permanent ambiguous barrier',async t=>{
 const f=await fixture(t);await f.follow();await f.plan();
 const allowed=await f.owner.authorize(f.actor,{subjectId:'b',notificationClass:'DAILY_SUMMARY'});assert.equal(allowed.status,'APPROVED');
 await assert.rejects(f.owner.propose(f.actor,{}),/APPROVED_TICKET_REQUIRED/);
 const proposed=await f.owner.propose(f.actor,allowed.ticket);assert.equal(proposed.status,'PROPOSED');
 const attempt=await f.owner.start(f.actor,{subjectId:'b',messageId:proposed.messageId,expectedRevision:0});assert.equal(attempt.payload.subjectId,'b');
 assert.ok(attempt.payload.claims.every(c=>c.kind==='SOURCE_FACT_SUMMARY'));
 await f.owner.settle({subjectId:'b',messageId:proposed.messageId,attemptId:attempt.attemptId,outcome:'AMBIGUOUS'});
 const again=await f.owner.authorize(f.actor,{subjectId:'b',notificationClass:'DAILY_SUMMARY'}),duplicate=await f.owner.propose(f.actor,again.ticket);
 assert.equal(duplicate.status,'AMBIGUOUS');assert.equal(duplicate.messageId,proposed.messageId);
});
test('revocation fences proposal/dispatch; enrollment ABA does not inherit the old subscription',async t=>{
 const f=await fixture(t);await f.follow();await f.plan();const approved=await f.owner.authorize(f.actor,{subjectId:'b',notificationClass:'DAILY_SUMMARY'}),out=await f.owner.propose(f.actor,approved.ticket);
 await f.follow('DAILY_SUMMARY',false,1);await assert.rejects(f.owner.start(f.actor,{subjectId:'b',messageId:out.messageId,expectedRevision:0}),/SUBSCRIPTION_FENCED|MESSAGE_FENCED|START_CAS/);
 await f.follow('DAILY_SUMMARY',true,2);await f.db.raw.execute("UPDATE user_onboarding SET state='ACTION_REQUIRED' WHERE user_id='b'");await f.db.raw.execute("UPDATE user_onboarding SET state='READY' WHERE user_id='b'");
 await assert.rejects(f.owner.authorize(f.actor,{subjectId:'b',notificationClass:'DAILY_SUMMARY'}),/SUBSCRIPTION_FENCED|SOURCE_CONSENT_REQUIRED/);
});
test('subject source correction physically erases both authorization and copied payload',async t=>{
 const f=await fixture(t);await f.follow();await f.plan();const approved=await f.owner.authorize(f.actor,{subjectId:'b',notificationClass:'DAILY_SUMMARY'});await f.owner.propose(f.actor,approved.ticket);
 await f.stores.queue.sourceChanged(await f.core.captureControl('b'),{reasonCode:'SOURCE_CHANGED'});
 for(const [table,field] of [['owner_monitoring_authorizations','claims_json'],['owner_monitoring_outbox','payload_json']]){const row=(await f.db.raw.execute(`SELECT * FROM ${table}`)).rows[0];assert.equal(row.content_state,'REDACTED');assert.equal(row[field],null);assert.equal(row.content_digest_salt,null);}
});
