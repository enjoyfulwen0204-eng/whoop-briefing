import test from 'node:test';
import assert from 'node:assert/strict';
import { syntheticPhase4Fixture } from './phase4Fixture.js';
import { createPhase4Foundation } from '../src/phase4Foundation.js';
import { createUpdateProcessor } from '../src/bot/updateProcessor.js';

async function setup(t,options={}) {
  const f=await syntheticPhase4Fixture(t,options),{db,stores,core}=f,control=await stores.captureControl('a');
  await db.linkTelegram({userId:'a',chatId:'123',now:core.now()});
  const sourceText='caffeine 100mg',candidate={category:'caffeine',eventAt:core.timestamp(),valueKind:'NUMERIC',numericValue:100,unit:'mg',
    exposureState:'EXPOSED',extractionConfidence:1,excerptStart:0,excerptEnd:[...sourceText].length};
  const fact=await stores.journal.create(control,{candidate,sourceText,sourceEventKey:'fact-create'});
  await db.claimTelegramUpdate(9001,{owner:'owner',conversationKey:'tg:123',now:core.now()});
  await db.markTelegramUpdateProcessing(9001,{owner:'owner',now:core.now()});
  await db.acquireLock('telegram_lane:tg:123',{owner:'owner',ttlMs:120000,now:core.now()});
  return {...f,control,fact,candidate};
}

test('Journal inbound authority requires the actual private tenant binding, owned durable processing lease and lane, never caller JSON or public LIVE',async t=>{
  let now=new Date('2026-09-19T00:00:00.000Z');const f=await setup(t,{now:()=>now}),{stores,control,db,keys}=f;
  await assert.rejects(stores.journalInbound.capture(await stores.captureControl('b'),{updateId:9001,owner:'owner'}),/OWNER_MISMATCH/);
  await assert.rejects(stores.journalInbound.capture(control,{updateId:9001,owner:'wrong'}),/OWNER_MISMATCH/);
  await assert.rejects(stores.journalInbound.process(control,{purpose:'JOURNAL_INBOUND_CONTROL'},{operation:'DELETION',logicalFactId:f.fact.logicalFactId}),/AUTHORITY_REQUIRED/);
  await assert.rejects(stores.privacy.admit(control,{targetType:'JOURNAL_FACT',targetId:f.fact.logicalFactId,idempotencyKey:'forged',sourceUpdateId:'9001'}),/AUTHORITY_REQUIRED/);
  const publicStores=await createPhase4Foundation({db,keys});
  await assert.rejects(publicStores.journalInbound.capture(await publicStores.captureControl('a'),{updateId:9001,owner:'owner'}),/LIVE_NOT_AUTHORIZED/);
  const proof=await stores.journalInbound.capture(control,{updateId:9001,owner:'owner'});
  await assert.rejects(db.transaction(()=>stores.journalInbound.process(control,proof,{operation:'DELETION',logicalFactId:f.fact.logicalFactId})),/T0_MUST_BE_STANDALONE/);
  now=new Date(now.getTime()+120001);
  await assert.rejects(stores.journalInbound.process(control,proof,{operation:'DELETION',logicalFactId:f.fact.logicalFactId}),/LEASE_FENCED/);
  assert.equal((await db.raw.execute('SELECT count(*) n FROM health_plaintext_purges')).rows[0].n,0);
});

test('An origin-receipt failure rolls back all of T1 but not T0; a restarted adapter resumes the admitted purge without parsing or the original action',async t=>{
  const f=await setup(t),{stores,db,control}=f;
  const proof=await stores.journalInbound.capture(control,{updateId:9001,owner:'owner'});
  await db.raw.execute("CREATE TRIGGER synthetic_receipt_failure BEFORE INSERT ON telegram_operations BEGIN SELECT RAISE(ABORT,'synthetic_receipt_failure'); END");
  await assert.rejects(stores.journalInbound.process(control,proof,{operation:'DELETION',logicalFactId:f.fact.logicalFactId}),/synthetic_receipt_failure/);
  let purge=(await db.raw.execute('SELECT * FROM health_plaintext_purges')).rows[0];assert.equal(purge.state,'ADMITTED');assert.equal(purge.source_update_id,'9001');
  assert.equal((await db.raw.execute('SELECT count(*) n FROM journal_events')).rows[0].n,1);
  assert.equal((await db.raw.execute('SELECT count(*) n FROM telegram_operations')).rows[0].n,0);
  assert.equal((await db.raw.execute("SELECT pending_purge_count FROM phase4_user_state WHERE user_id='a'")).rows[0].pending_purge_count,1);
  await db.raw.execute('DROP TRIGGER synthetic_receipt_failure');
  const restarted=await f.restart(),nextControl=await restarted.stores.captureControl('a');
  const nextProof=await restarted.stores.journalInbound.capture(nextControl,{updateId:9001,owner:'owner'});
  const forbidden=new Proxy({}, {get(){throw new Error('original_parser_or_handler_reexecuted');}});
  const result=await restarted.stores.journalInbound.process(nextControl,nextProof,forbidden);
  assert.equal(result.state,'COMPLETE');assert.equal(result.reply,null);assert.equal(result.complete,true);
  purge=(await db.raw.execute('SELECT * FROM health_plaintext_purges')).rows[0];assert.equal(purge.state,'COMPLETE');assert.equal(purge.replacement_receipt_id,'9001');
  const receipt=(await db.raw.execute('SELECT * FROM telegram_operations')).rows[0];assert.equal(receipt.operation_state,'COMMITTED');
  assert.equal(receipt.owner_user_id,'a');assert.equal(JSON.parse(receipt.result_json).reply,'Health record deleted.');
  assert.ok(!receipt.result_json.includes('caffeine'));assert.ok(!receipt.result_json.includes('100mg'));
  assert.equal((await db.raw.execute('SELECT count(*) n FROM journal_events')).rows[0].n,0);
});

test('Correction T1 commits new fact plus fixed receipt atomically; T2 and stale-cache acknowledgment are required before reply authority',async t=>{
  const f=await setup(t),{stores,db,control}=f,context=await stores.capture('a',{executionMode:'SHADOW'});
  await stores.journal.read(context,f.fact.logicalFactId);
  const proof=await stores.journalInbound.capture(control,{updateId:9001,owner:'owner'}),sourceText='caffeine 200mg';
  const result=await stores.journalInbound.process(control,proof,{operation:'CORRECTION',logicalFactId:f.fact.logicalFactId,expectedRevision:1,
    candidate:{...f.candidate,numericValue:200,excerptEnd:[...sourceText].length},sourceText});
  assert.equal(result.state,'DB_REDACTED');assert.equal(result.complete,false);assert.equal(result.reply,null);
  assert.equal((await db.raw.execute("SELECT numeric_value FROM journal_events WHERE fact_status='ACTIVE'")).rows[0].numeric_value,200);
  const receipt=(await db.raw.execute('SELECT * FROM telegram_operations')).rows[0];assert.equal(JSON.parse(receipt.result_json).reply,'Health record updated.');
  assert.equal(await db.markDeliveryStarted(9001,{owner:'owner',conversationKey:'tg:123',now:f.core.now()}),false);
  await stores.release(context);
  const done=await stores.journalInbound.process(control,proof,null);assert.equal(done.state,'COMPLETE');assert.equal(done.reply,null);
  assert.equal((await db.raw.execute('SELECT count(*) n FROM health_plaintext_purges')).rows[0].n,1);
  assert.equal((await db.raw.execute('SELECT count(*) n FROM outbound_messages')).rows[0].n,0);
});

test('Restaging an inbound correction revalidates the exact current source-update authority after auth drift',async t=>{
  const f=await setup(t),{stores,db,control,core}=f,proof=await stores.journalInbound.capture(control,{updateId:9001,owner:'owner'}),sourceText='caffeine 200mg';
  await db.raw.execute("CREATE TRIGGER synthetic_inbound_restage_failure BEFORE UPDATE ON journal_events BEGIN SELECT RAISE(ABORT,'synthetic_inbound_restage_failure'); END");
  await assert.rejects(stores.journalInbound.process(control,proof,{operation:'CORRECTION',logicalFactId:f.fact.logicalFactId,expectedRevision:1,
    candidate:{...f.candidate,numericValue:200,excerptEnd:sourceText.length},sourceText}),/synthetic_inbound_restage_failure/);
  const purge=(await db.raw.execute('SELECT * FROM health_plaintext_purges')).rows[0],stage=(await db.raw.execute('SELECT * FROM health_purge_replacements')).rows[0];
  await db.raw.execute({sql:`INSERT INTO user_whoop_tokens
    (user_id,access_token,refresh_token,access_token_expires_at,updated_at,auth_generation) VALUES ('a','synthetic','synthetic',?,?,1)`,
    args:[new Date(core.now().getTime()+3600000).toISOString(),core.timestamp()]});
  const freshControl=await stores.captureControl('a'),freshText='caffeine 300mg',resume={purgeId:purge.purge_id,expectedRevision:1,sourceText:freshText,
    candidate:{...f.candidate,numericValue:300,excerptEnd:freshText.length}};
  await assert.rejects(stores.journal.resumeCorrection(freshControl,{...resume,inboundAuthority:proof}),/INBOUND_GENERATION_STALE/);
  assert.deepEqual((await db.raw.execute('SELECT * FROM health_purge_replacements')).rows[0],stage);
  const freshProof=await stores.journalInbound.capture(freshControl,{updateId:9001,owner:'owner'});
  await db.raw.execute('DROP TRIGGER synthetic_inbound_restage_failure');
  assert.equal((await stores.journal.resumeCorrection(freshControl,{...resume,inboundAuthority:freshProof})).purgeId,purge.purge_id);
  await stores.privacy.complete(freshControl,purge.purge_id);
  const final=(await db.raw.execute('SELECT * FROM health_plaintext_purges')).rows[0];
  assert.equal(final.source_update_id,'9001');assert.equal(final.replacement_receipt_id,'9001');assert.equal(final.state,'COMPLETE');
  assert.equal((await db.raw.execute("SELECT numeric_value FROM journal_events WHERE fact_status='ACTIVE'")).rows[0].numeric_value,300);
});

test('Existing update processing uses the opt-in control adapter before the ordinary action transaction and sends nothing, including after T0 crash/restart',async t=>{
  let now=new Date('2026-09-19T00:00:00.000Z');
  const f=await syntheticPhase4Fixture(t,{now:()=>now}),{db,stores}=f;
  await db.linkTelegram({userId:'a',chatId:'123',now});
  const control=await stores.captureControl('a'),sourceText='caffeine 100mg';
  const fact=await stores.journal.create(control,{sourceText,sourceEventKey:'route-create',candidate:{category:'caffeine',eventAt:now.toISOString(),
    valueKind:'NUMERIC',numericValue:100,unit:'mg',exposureState:'EXPOSED',extractionConfidence:1,excerptStart:0,excerptEnd:14}});
  let forbiddenCalls=0;
  const forbidden=()=>{forbiddenCalls++;throw Error('forbidden ordinary handler or provider');};
  const processor=adapter=>createUpdateProcessor({db,resolveUser:chatId=>db.resolveUserByChatId(chatId),handleMessage:forbidden,
    sendReply:forbidden,sendTyping:forbidden,phase4JournalControl:adapter,now:()=>now,newAttemptId:()=>`route-owner-${now.getTime()}`});
  const update={update_id:9301,message:{message_id:1,chat:{id:123,type:'private'},from:{id:123,is_bot:false},text:`/journal_delete ${fact.logicalFactId}`}};
  await db.raw.execute("CREATE TRIGGER synthetic_route_failure BEFORE INSERT ON telegram_operations BEGIN SELECT RAISE(ABORT,'synthetic_route_failure'); END");
  const failed=await processor(stores.journalInbound.route).processUpdate(update);assert.equal(failed.outcome,'retry');
  assert.equal((await db.raw.execute('SELECT state FROM health_plaintext_purges')).rows[0].state,'ADMITTED');assert.equal(forbiddenCalls,0);
  await db.raw.execute('DROP TRIGGER synthetic_route_failure');now=new Date(now.getTime()+300000);
  const restarted=await f.restart();
  const result=await processor(restarted.stores.journalInbound.route).processUpdate({...update,message:{...update.message,text:'not a command anymore'}});
  assert.equal(result.outcome,'processed');assert.equal(result.replied,false);assert.equal(forbiddenCalls,0);
  assert.equal((await db.raw.execute('SELECT state FROM health_plaintext_purges')).rows[0].state,'COMPLETE');
  assert.equal((await db.raw.execute('SELECT status FROM telegram_processed_updates')).rows[0].status,'COMPLETED');
});
