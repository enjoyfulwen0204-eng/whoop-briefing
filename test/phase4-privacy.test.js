import test from 'node:test';
import assert from 'node:assert/strict';
import { syntheticPhase4Fixture } from './phase4Fixture.js';
import { addPrivacyLink, REDACTED_RECEIPT } from '../src/phase4V22Backfill.js';
import { createUpdateProcessor } from '../src/bot/updateProcessor.js';

async function seedFact(f,userId='a',id='fact-1') {
  await f.db.raw.execute({sql:`INSERT INTO journal_events(user_id,event_at,health_date,category,numeric_value,source,created_at,updated_at,
    logical_fact_id,revision,fact_status,privacy_artifact_id,content_state,source_linkage_state)
    VALUES (?,'2026-09-18T10:00:00.000Z','2026-09-18','caffeine',100,'synthetic',?,?,?,1,'ACTIVE',?,'PRESENT','COMPLETE')`,
    args:[userId,f.core.timestamp(),f.core.timestamp(),id,`privacy-${userId}-${id}`]});
  return `privacy-${userId}-${id}`;
}
async function evidence(f,context,source) {
  const run=await f.stores.evidence.start(context,{deterministic_run_key:'run-1',method:'SYNTHETIC',algorithm_version:'test-v1',
    registry_version:'test-v1',evidence_contract_version:'test-v1',promotion_confound_version:'test-v1',
    exposure_classification_version:'test-v1',factor_set_version:'test-v1',started_at:f.core.timestamp()},[source]);
  await f.stores.evidence.complete(context,run.row.run_id,{sample_count:1,unknown_eligible_days:0,eligible_observation_days:1,unknown_fraction:0});
  return f.stores.evidence.addItem(context,{run_id:run.row.run_id,item_key:'item-1',claim_key:'synthetic-secret-claim',effect:7,
    exposure_classification_version:'test-v1',factor_set_version:'test-v1'});
}

test('Purge T0 survives failed T1; complete transitive content transaction and cache acknowledgment are both mandatory',async t=>{
  const f=await syntheticPhase4Fixture(t),{stores,db}=f;
  const id=await seedFact(f),other=await seedFact(f,'b');
  const context=await stores.capture('a',{executionMode:'SHADOW'});
  const source=await stores.root(context,'JOURNAL_FACT',id),item=await evidence(f,context,source.ref);
  await stores.cache.set(context,'answer',{text:'synthetic-sensitive'});
  const control=await stores.captureControl('a');
  await assert.rejects(db.transaction(()=>stores.privacy.admit(control,{targetType:'JOURNAL_FACT',targetId:'fact-1',idempotencyKey:'delete-1'})),/T0_MUST_BE_STANDALONE/);
  const purge=await stores.privacy.admit(control,{targetType:'JOURNAL_FACT',targetId:'fact-1',idempotencyKey:'delete-1'});
  assert.equal(purge.state,'ADMITTED');assert.equal(purge.purge_generation,1);
  assert.equal((await stores.privacy.admit(control,{targetType:'JOURNAL_FACT',targetId:'fact-1',idempotencyKey:'delete-1'})).purge_id,purge.purge_id);
  await assert.rejects(stores.cache.get(context,'answer'),/PURGE_FENCED/);
  await assert.rejects(stores.assertCurrent(context,{allowPurge:true}),/PURGE_FENCED/);
  await assert.rejects(stores.capture('a',{executionMode:'SHADOW'}),/PURGE_FENCED/);
  await assert.rejects(stores.privacy.complete(control,purge.purge_id),/CONTENT_PENDING/);
  await db.raw.execute(`CREATE TRIGGER synthetic_failure BEFORE UPDATE ON evidence_items BEGIN SELECT RAISE(ABORT,'synthetic_t1_failure'); END`);
  await assert.rejects(stores.privacy.redact(control,purge.purge_id),/synthetic_t1_failure/);
  assert.equal((await stores.privacy.status(control,purge.purge_id)).state,'ADMITTED');
  assert.equal((await db.raw.execute("SELECT count(*) n FROM journal_events WHERE user_id='a'")).rows[0].n,1);
  assert.equal((await db.raw.execute("SELECT claim_key FROM evidence_items WHERE user_id='a'")).rows[0].claim_key,'synthetic-secret-claim');
  await db.raw.execute('DROP TRIGGER synthetic_failure');
  assert.equal((await stores.privacy.redact(control,purge.purge_id)).state,'DB_REDACTED');
  const redacted=(await db.raw.execute("SELECT * FROM evidence_items WHERE user_id='a'")).rows[0];
  assert.equal(redacted.content_state,'REDACTED');assert.equal(redacted.claim_key,null);assert.equal(redacted.effect,null);
  assert.equal(redacted.content_digest_salt,null);
  assert.equal((await db.raw.execute("SELECT count(*) n FROM journal_events WHERE user_id='a'")).rows[0].n,0);
  assert.equal((await db.raw.execute("SELECT privacy_artifact_id FROM journal_events WHERE user_id='b'")).rows[0].privacy_artifact_id,other);
  await assert.rejects(stores.privacy.complete(control,purge.purge_id),/CACHE_ACK_PENDING/);
  await stores.release(context);
  assert.equal((await stores.privacy.complete(control,purge.purge_id)).state,'COMPLETE');
  assert.equal((await stores.privacy.complete(control,purge.purge_id)).state,'COMPLETE');
  const state=(await db.raw.execute("SELECT * FROM phase4_user_state WHERE user_id='a'")).rows[0];
  assert.equal(state.pending_purge_count,0);assert.equal(state.source_generation,1);
  const fresh=await stores.capture('a',{executionMode:'SHADOW'});
  await assert.rejects(stores.readArtifact(fresh,'evidence_items',{evidence_item_id:item.row.evidence_item_id}),/CONTENT_REDACTED/);
  const job=await stores.queue.read(fresh,'RECOMPUTE_DERIVED');assert.equal(job.freshness,'PENDING');assert.equal(job.scope_kind,'FULL_TENANT_RECOMPUTE');
});

test('Concurrent purges count independently, expire bounded cache leases, preserve other tenants and no LIVE creation',async t=>{
  let now=new Date('2026-09-19T00:00:00.000Z');
  const f=await syntheticPhase4Fixture(t,{now:()=>now}),{stores,db}=f;
  await seedFact(f,'a','one');await seedFact(f,'a','two');
  const context=await stores.capture('a',{executionMode:'SHADOW'}),control=await stores.captureControl('a');
  const one=await stores.privacy.admit(control,{targetType:'JOURNAL_FACT',targetId:'one',idempotencyKey:'one'});
  const two=await stores.privacy.admit(control,{targetType:'JOURNAL_FACT',targetId:'two',idempotencyKey:'two'});
  assert.equal(two.purge_generation,2);
  await stores.privacy.redact(control,one.purge_id);await stores.privacy.redact(control,two.purge_id);
  now=new Date(now.getTime()+15*60*1000);
  await stores.privacy.complete(control,one.purge_id);
  assert.equal((await db.raw.execute("SELECT pending_purge_count FROM phase4_user_state WHERE user_id='a'")).rows[0].pending_purge_count,1);
  await assert.rejects(stores.capture('a',{executionMode:'SHADOW'}),/PURGE_FENCED/);
  await stores.privacy.complete(control,two.purge_id);
  await assert.rejects(stores.assertCurrent(context),/CONTEXT_EXPIRED/);
  assert.equal((await db.raw.execute("SELECT count(*) n FROM phase4_computation_state WHERE execution_mode='LIVE'")).rows[0].n,0);
  assert.equal((await db.raw.execute("SELECT source_generation FROM phase4_user_state WHERE user_id='b'")).rows[0].source_generation,0);
});

test('Legacy receipt and physiological range redaction preserve action barriers and requested/completed progress',async t=>{
  const f=await syntheticPhase4Fixture(t),{stores,db}=f;await seedFact(f);
  await db.raw.execute({sql:`INSERT INTO telegram_operations(update_id,committed_at,result_json,delivery_state,owner_user_id,
    privacy_artifact_id,content_state,source_linkage_state) VALUES ('99',?,'{"reply":"synthetic-private","nested":{"value":7}}','ACTION_READY','a','receipt-99','PRESENT','COMPLETE')`,args:[f.core.timestamp()]});
  await db.raw.execute({sql:`INSERT INTO analytics_invalidation(user_id,generation,affected_from,affected_to,resources,reasons,
    created_at,updated_at,scope_kind,privacy_artifact_id,content_state,source_linkage_state)
    VALUES ('a',9,'2026-09-01','2026-09-18','sleep','synthetic-private',?,?,'HEALTH_DATE_RANGE','legacy-range','PRESENT','COMPLETE')`,args:[f.core.timestamp(),f.core.timestamp()]});
  for(const [table,id] of [['telegram_operations','receipt-99'],['analytics_invalidation','legacy-range']])await addPrivacyLink(db.raw,
    {userId:'a',table,artifactId:id,sourceType:'TENANT_LEGACY',sourceId:'a',at:f.core.timestamp()});
  const control=await stores.captureControl('a'),purge=await stores.privacy.admit(control,{targetType:'JOURNAL_FACT',targetId:'fact-1',idempotencyKey:'delete'});
  await stores.privacy.redact(control,purge.purge_id);await stores.privacy.complete(control,purge.purge_id);
  const receipt=(await db.raw.execute("SELECT * FROM telegram_operations WHERE update_id='99'")).rows[0];
  assert.equal(receipt.result_json,REDACTED_RECEIPT);assert.equal(receipt.operation_state,'COMMITTED');assert.equal(receipt.delivery_state,'NOT_REQUIRED');
  const inv=(await db.raw.execute("SELECT * FROM analytics_invalidation WHERE user_id='a'")).rows[0];
  assert.equal(inv.generation,9);assert.equal(inv.affected_from,null);assert.equal(inv.affected_to,null);assert.equal(inv.scope_kind,'FULL_TENANT_RECOMPUTE');
});

test('Redacted replay never reaches identity/router/Q&A/LLM/mutation/typing/sender even after processed receipt pruning',async t=>{
  const f=await syntheticPhase4Fixture(t),{db}=f;
  for(const updateId of [401,402])await db.raw.execute({sql:`INSERT INTO telegram_operations(update_id,committed_at,result_json,
    delivery_state,owner_user_id,privacy_artifact_id,content_state,source_linkage_state,health_content_redacted_at,health_content_redaction_reason)
    VALUES (?, ?, ?, 'NOT_REQUIRED','a',?,'REDACTED','DISCONNECTED',?,'SOURCE_DELETED')`,
    args:[updateId,f.core.timestamp(),REDACTED_RECEIPT,`receipt-${updateId}`,f.core.timestamp()]});
  await db.claimTelegramUpdate(401,{owner:'prior',now:f.core.now(),conversationKey:'tg:123'});
  await db.markTelegramUpdateProcessing(401,{owner:'prior',now:f.core.now()});
  await db.completeTelegramUpdate(401,{owner:'prior',now:f.core.now()});
  let calls=0;const forbidden=()=>{calls++;throw new Error('forbidden_external_or_health_path');};
  const processor=createUpdateProcessor({db,resolveUser:forbidden,handleMessage:forbidden,handleUnlinked:forbidden,
    sendReply:forbidden,sendTyping:forbidden,now:f.core.now});
  for(const updateId of [401,402]) {
    const result=await processor.processUpdate({update_id:updateId,message:{chat:{id:123,type:'private'},from:{id:123,is_bot:false},text:'synthetic health question'}});
    assert.equal(result.outcome,'replayed');assert.equal(result.replied,false);
    assert.deepEqual(await db.getRedactedTelegramReplay(updateId),JSON.parse(REDACTED_RECEIPT));
  }
  assert.equal(calls,0);
});

test('Receipt action owner is a server argument, pending purge blocks new action and stale reply start is fenced',async t=>{
  const f=await syntheticPhase4Fixture(t),{db,stores}=f;await seedFact(f);
  const claim=async id=>{await db.claimTelegramUpdate(id,{owner:'worker',now:f.core.now(),conversationKey:'tg:123'});
    await db.markTelegramUpdateProcessing(id,{owner:'worker',now:f.core.now()});};
  await claim(501);
  await assert.rejects(db.processTelegramOperation(501,{owner:'worker',now:f.core.now},()=>({userId:'a',reply:'private'})),/RECEIPT_OWNER_REQUIRED/);
  await assert.rejects(db.processTelegramOperation(501,{owner:'worker',ownerUserId:'a',now:f.core.now},()=>({userId:'untrusted-b',reply:'private'})),/RESULT_OWNER_MISMATCH/);
  const reply=await db.processTelegramOperation(501,{owner:'worker',ownerUserId:'a',now:f.core.now},()=>({userId:'a',reply:'private'}));
  assert.equal((await db.raw.execute('SELECT owner_user_id FROM telegram_operations WHERE update_id=501')).rows[0].owner_user_id,'a');
  const control=await stores.captureControl('a'),purge=await stores.privacy.admit(control,{targetType:'JOURNAL_FACT',targetId:'fact-1',idempotencyKey:'one'});
  assert.equal(await db.markDeliveryStarted(501,{owner:'worker',conversationKey:'tg:123',now:f.core.now()}),false);
  await claim(502);let calls=0;
  await assert.rejects(db.processTelegramOperation(502,{owner:'worker',ownerUserId:'a',now:f.core.now},()=>{calls++;return {reply:'private'};}),/PURGE_FENCED/);
  assert.equal(calls,0);
  await stores.privacy.redact(control,purge.purge_id);
  await assert.rejects(stores.privacy.complete(control,purge.purge_id),/CACHE_ACK_PENDING/);
  await db.releaseTelegramReply(reply);await stores.privacy.complete(control,purge.purge_id);
  assert.equal(await db.markDeliveryStarted(501,{owner:'worker',conversationKey:'tg:123',now:f.core.now()}),false);
});

test('An external reply computation cannot survive purge by transaction retry, and T2 waits for its durable lease',async t=>{
  const f=await syntheticPhase4Fixture(t),{db,stores}=f;
  await seedFact(f);
  await db.claimTelegramUpdate(701,{owner:'worker',conversationKey:'tg:123',now:f.core.now()});
  await db.markTelegramUpdateProcessing(701,{owner:'worker',now:f.core.now()});
  let signalEntered,releaseProvider;
  const entered=new Promise(resolve=>{signalEntered=resolve;});
  const provider=new Promise(resolve=>{releaseProvider=resolve;});
  let calls=0;
  const action=db.processTelegramOperation(701,{owner:'worker',ownerUserId:'a',now:f.core.now},async()=>{
    const text=await db.outsideProcessingTransaction('synthetic-provider',async()=>{
      calls++;signalEntered();await provider;return 'synthetic private answer';
    });
    return {userId:'a',reply:text};
  });
  const rejected=assert.rejects(action,/PURGE_FENCED/);
  await entered;
  const control=await stores.captureControl('a');
  const purge=await stores.privacy.admit(control,{targetType:'JOURNAL_FACT',targetId:'fact-1',idempotencyKey:'provider-delete'});
  await stores.privacy.redact(control,purge.purge_id);
  await assert.rejects(stores.privacy.complete(control,purge.purge_id),/CACHE_ACK_PENDING/);
  releaseProvider();await rejected;
  assert.equal(calls,1);
  assert.equal((await db.raw.execute('SELECT count(*) n FROM telegram_operations WHERE update_id=701')).rows[0].n,0);
  assert.equal((await stores.privacy.complete(control,purge.purge_id)).state,'COMPLETE');
});

test('Privacy cleanup survives lifecycle change but its purpose-specific authority cannot read health or mutate preferences',async t=>{
  const f=await syntheticPhase4Fixture(t),{db,stores}=f;
  await seedFact(f);
  const control=await stores.captureControl('a');
  const purge=await stores.privacy.admit(control,{targetType:'JOURNAL_FACT',targetId:'fact-1',idempotencyKey:'disable-mid-purge'});
  await db.transitionUserLifecycle({userId:'a',targetStatus:'DISABLED'});
  const cleanup=await stores.capturePrivacyControl('a');
  await assert.rejects(stores.capture('a',{executionMode:'SHADOW'}),/PURGE_FENCED|LIFECYCLE_FENCED/);
  await assert.rejects(stores.preferences.read(cleanup),/SOURCE_CONTROL_REQUIRED/);
  await assert.rejects(stores.experiments.read(cleanup,1),/SOURCE_CONTROL_REQUIRED/);
  await assert.rejects(stores.privacy.status({...cleanup},purge.purge_id),/PRIVACY_CONTROL_REQUIRED/);
  await stores.privacy.redact(cleanup,purge.purge_id);
  assert.equal((await stores.privacy.complete(cleanup,purge.purge_id)).state,'COMPLETE');
  assert.equal((await db.raw.execute("SELECT count(*) n FROM journal_events WHERE user_id='a'")).rows[0].n,0);
});

test('Owned reply receipt cannot replay or start after disable/reactivate ABA, and late acceptance after purge preserves ambiguity',async t=>{
  const f=await syntheticPhase4Fixture(t),{db,stores}=f;await seedFact(f);
  const claim=async id=>{await db.claimTelegramUpdate(id,{owner:'worker',conversationKey:'tg:123',now:f.core.now()});
    await db.markTelegramUpdateProcessing(id,{owner:'worker',now:f.core.now()});};
  await claim(801);
  const old=await db.processTelegramOperation(801,{owner:'worker',ownerUserId:'a',now:f.core.now},()=>({userId:'a',reply:'synthetic old reply'}));
  await db.releaseTelegramReply(old);
  await db.transitionUserLifecycle({userId:'a',targetStatus:'DISABLED'});
  await db.transitionUserLifecycle({userId:'a',targetStatus:'ACTIVE'});
  assert.equal(await db.markDeliveryStarted(801,{owner:'worker',conversationKey:'tg:123',now:f.core.now()}),false);
  await assert.rejects(db.processTelegramOperation(801,{owner:'worker',ownerUserId:'a',now:f.core.now},()=>{throw new Error('must not rerun');}),/RECEIPT_GENERATION_STALE/);
  await db.completeTelegramUpdate(801,{owner:'worker',now:f.core.now()});
  await claim(802);
  const live=await db.processTelegramOperation(802,{owner:'worker',ownerUserId:'a',now:f.core.now},()=>({userId:'a',reply:'synthetic current reply'}));
  assert.equal(await db.markDeliveryStarted(802,{owner:'worker',conversationKey:'tg:123',replyContext:live,now:f.core.now()}),true);
  const control=await stores.capturePrivacyControl('a'),purge=await stores.privacy.admit(control,{targetType:'JOURNAL_FACT',targetId:'fact-1',idempotencyKey:'late-receipt'});
  await stores.privacy.redact(control,purge.purge_id);
  assert.equal(await db.markDelivered(802,{owner:'worker',messageId:1234,now:f.core.now()}),true);
  const operation=await db.getTelegramOperation(802);
  assert.equal(operation.deliveryState,'AMBIGUOUS');assert.equal(operation.telegramMessageId,1234);
  assert.deepEqual(await db.getRedactedTelegramReplay(802),JSON.parse(REDACTED_RECEIPT));
  await db.releaseTelegramReply(live);await stores.privacy.complete(control,purge.purge_id);
});
