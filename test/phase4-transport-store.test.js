import test from 'node:test';
import assert from 'node:assert/strict';
import { syntheticPhase4Fixture } from './phase4Fixture.js';
import { addPrivacyLink } from '../src/phase4V22Backfill.js';

async function live(t) {
  let time=new Date('2026-09-19T00:00:00.000Z');
  const f=await syntheticPhase4Fixture(t,{now:()=>time}),{db,stores}=f;
  await db.saveTokens('a',{accessToken:'synthetic-access',refreshToken:'synthetic-refresh',expiresAt:new Date(+time+3600000),scope:'offline',whoopUserId:'synthetic-only'});
  await db.linkTelegram({userId:'a',chatId:'123',now:time});
  await db.raw.execute({sql:`INSERT INTO user_onboarding(user_id,state,state_changed_at,created_at,updated_at) VALUES ('a','READY',?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET state='READY'`,args:[time.toISOString(),time.toISOString(),time.toISOString()]});
  await stores.initializeTenant('a','LIVE');
  // Only this owned in-memory fixture models completed computation/cutover.
  // No production factory or worker can manufacture these test postconditions.
  await db.raw.execute("UPDATE phase4_computation_state SET last_completed_generation=input_generation WHERE user_id='a' AND execution_mode='LIVE'");
  await db.raw.execute("UPDATE phase4_invalidations SET scope_kind='NONE' WHERE user_id='a' AND execution_mode='LIVE'");
  const context=await stores.capture('a',{executionMode:'LIVE'}),source=await stores.root(context,'USER','a');
  const initial=await stores.transport.mode(context,'MORNING_BRIEF_V1');assert.equal(initial.mode,'LEGACY');
  const proposal=await stores.messages.propose(context,{semantic:{family:'MORNING_BRIEF_V1',identity:'2026-09-19'},
    message:{payload_text:'Synthetic frozen brief',expires_at:'2026-09-20T00:00:00.000Z'},sourceRefs:[source.ref]});
  await assert.rejects(stores.transport.makeEligible(context,{messageId:proposal.row.message_id,expectedRevision:0}),/CUTOVER_REQUIRED/);
  await db.raw.execute({sql:`UPDATE tenant_delivery_modes SET mode='PHASE4',cutover_boundary=?,timezone='Asia/Taipei',revision=revision+1,reason_code='CUTOVER_COMMITTED'
    WHERE user_id='a' AND execution_mode='LIVE' AND message_family='MORNING_BRIEF_V1'`,args:[time.toISOString()]});
  await stores.transport.makeEligible(context,{messageId:proposal.row.message_id,expectedRevision:0});
  return {...f,context,messageId:proposal.row.message_id,setTime:value=>{time=value;}};
}

test('LIVE storage claim/start requires an issued exact lease, bound destination and current computation; SHADOW cannot create attempts',async t=>{
  const f=await live(t),{stores,context,messageId,db}=f;
  const lease=await stores.transport.claim(context,{messageId,owner:'synthetic-worker'});
  assert.equal(await stores.transport.claim(context,{messageId,owner:'competitor'}),null);
  await assert.rejects(stores.transport.start(context,{...lease}),/SERVER_LEASE_REQUIRED/);
  const started=await stores.transport.start(context,lease);
  assert.equal(started.payloadText,'Synthetic frozen brief');assert.ok(started.attemptId);
  assert.equal((await db.raw.execute('SELECT count(*) n FROM outbound_delivery_attempts')).rows[0].n,1);
  await assert.rejects(stores.transport.start(context,lease),/LEASE_LOST/);
  const shadow=await stores.capture('a',{executionMode:'SHADOW'});
  await assert.rejects(stores.transport.destination(shadow),/LIVE_REQUIRED/);
});

test('Late acceptance records only transport truth after disable; ambiguity remains permanently consumed and non-retryable',async t=>{
  const f=await live(t),{stores,context,messageId,db}=f;
  const lease=await stores.transport.claim(context,{messageId,owner:'synthetic-worker'});
  const {attemptId}=await stores.transport.start(context,lease),control=await stores.capturePrivacyControl('a');
  await db.transitionUserLifecycle({userId:'a',targetStatus:'DISABLED'});
  await stores.transport.settle(control,'LIVE',{attemptId,outcome:'AMBIGUOUS',ambiguityReason:'CONNECTION_LOST',errorCode:'NETWORK_UNCERTAIN'});
  const late=await stores.transport.settle(control,'LIVE',{attemptId,outcome:'DELIVERED',providerMessageId:'synthetic-42'});
  assert.equal(late.state,'AMBIGUOUS');
  const message=(await db.raw.execute('SELECT state,provider_message_id FROM outbound_messages')).rows[0];
  assert.equal(message.state,'AMBIGUOUS');assert.equal(message.provider_message_id,'synthetic-42');
  const before=(await db.raw.execute('SELECT revision FROM outbound_messages')).rows[0].revision;
  assert.equal((await stores.transport.settle(control,'LIVE',{attemptId,outcome:'DELIVERED',providerMessageId:'synthetic-42'})).replayed,true);
  assert.equal((await db.raw.execute('SELECT revision FROM outbound_messages')).rows[0].revision,before);
  await assert.rejects(stores.transport.settle(control,'LIVE',{attemptId,outcome:'DELIVERED',providerMessageId:'different'}),/REPLAY_CONFLICT/);
  const reservation=(await db.raw.execute('SELECT state,consumed_outcome FROM outbound_semantic_reservations')).rows[0];
  assert.equal(reservation.state,'CONSUMED');assert.equal(reservation.consumed_outcome,'AMBIGUOUS');
  await assert.rejects(stores.transport.settle(control,'LIVE',{attemptId,outcome:'FAILED_DEFINITE'}),/ATTEMPT_TERMINAL/);
  await assert.rejects(stores.transport.claim(context,{messageId,owner:'retry'}),/LIFECYCLE_FENCED/);
  await assert.rejects(stores.transport.settle(await stores.capturePrivacyControl('b'),'LIVE',{attemptId,outcome:'DELIVERED'}),/ATTEMPT_NOT_FOUND/);
});

test('A started synthetic transport settles after transitive purge without reading payload or permitting a definite retry',async t=>{
  const f=await live(t),{db,stores,context,messageId}=f;
  await db.raw.execute({sql:`INSERT INTO journal_events(user_id,event_at,health_date,category,numeric_value,source,created_at,updated_at,
    logical_fact_id,revision,fact_status,privacy_artifact_id,content_state,source_linkage_state)
    VALUES ('a','2026-09-18T10:00:00.000Z','2026-09-18','caffeine',100,'synthetic',?,?,'transport-source',1,'ACTIVE','transport-fact','PRESENT','COMPLETE')`,
    args:[f.core.timestamp(),f.core.timestamp()]});
  const message=(await db.raw.execute('SELECT privacy_artifact_id FROM outbound_messages')).rows[0];
  await addPrivacyLink(db.raw,{userId:'a',mode:'LIVE',table:'outbound_messages',artifactId:message.privacy_artifact_id,
    sourceType:'JOURNAL_FACT',sourceId:'transport-fact',at:f.core.timestamp()});
  const lease=await stores.transport.claim(context,{messageId,owner:'fake-only'}),{attemptId}=await stores.transport.start(context,lease);
  const control=await stores.capturePrivacyControl('a');
  const purge=await stores.privacy.admit(control,{targetType:'JOURNAL_FACT',targetId:'transport-source',idempotencyKey:'transport-delete'});
  await stores.privacy.redact(control,purge.purge_id);
  const erased=(await db.raw.execute('SELECT payload_text,payload_json,content_state,state FROM outbound_messages')).rows[0];
  assert.equal(erased.payload_text,null);assert.equal(erased.payload_json,null);assert.equal(erased.content_state,'REDACTED');assert.equal(erased.state,'DELIVERY_STARTED');
  await stores.transport.settle(control,'LIVE',{attemptId,outcome:'FAILED_DEFINITE',errorCode:'PROVIDER_UNAVAILABLE'});
  assert.equal((await db.raw.execute('SELECT state FROM outbound_messages')).rows[0].state,'FAILED_TERMINAL');
  assert.equal((await db.raw.execute('SELECT state FROM outbound_semantic_reservations')).rows[0].state,'CLOSED');
  await assert.rejects(stores.privacy.complete(control,purge.purge_id),/CACHE_ACK_PENDING/);
  await stores.release(context);await stores.privacy.complete(control,purge.purge_id);
});

test('Lease recovery never retries a started attempt, while only registered definite failures can back off the frozen non-question payload',async t=>{
  const f=await live(t),{stores,context,messageId,db}=f,control=await stores.capturePrivacyControl('a');
  const old=await stores.transport.claim(context,{messageId,owner:'first',leaseMs:1000});
  f.setTime(new Date('2026-09-19T00:00:02.000Z'));
  assert.equal((await stores.transport.recover(control,'LIVE',{messageId,expectedRevision:old.revision})).state,'ELIGIBLE');
  await assert.rejects(stores.transport.start(context,old),/LEASE_LOST/);
  const current=await stores.transport.claim(context,{messageId,owner:'second',leaseMs:1000});
  const first=await stores.transport.start(context,current);
  await stores.transport.settle(control,'LIVE',{attemptId:first.attemptId,outcome:'FAILED_DEFINITE',errorCode:'PROVIDER_RATE_LIMIT'});
  let revision=(await db.raw.execute('SELECT revision FROM outbound_messages')).rows[0].revision;
  const retry=await stores.transport.retryDefinite(context,{messageId,expectedRevision:revision});
  assert.equal(retry.nextAttemptAt,'2026-09-19T00:01:02.000Z');
  assert.equal(await stores.transport.claim(context,{messageId,owner:'too-early'}),null);
  f.setTime(new Date(retry.nextAttemptAt));
  const next=await stores.transport.claim(context,{messageId,owner:'third',leaseMs:1000});
  const second=await stores.transport.start(context,next);assert.equal(second.payloadText,first.payloadText);
  f.setTime(new Date('2026-09-19T00:01:04.000Z'));
  revision=(await db.raw.execute('SELECT revision FROM outbound_messages')).rows[0].revision;
  assert.equal((await stores.transport.recover(control,'LIVE',{messageId,expectedRevision:revision})).state,'AMBIGUOUS');
  assert.equal((await db.raw.execute('SELECT state FROM outbound_semantic_reservations')).rows[0].state,'CONSUMED');
  assert.equal(await stores.transport.claim(context,{messageId,owner:'must-not-retry'}),null);
  assert.equal((await db.raw.execute('SELECT count(*) n FROM outbound_delivery_attempts')).rows[0].n,2);
});
