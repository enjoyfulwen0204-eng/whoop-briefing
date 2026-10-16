import {assertStage8Recovery,stage8ConfigurationFence} from './stage8Policy.js';
import {buildPhase4Core} from './phase4Core.js';
import {composePhase4Stores} from './phase4Repositories.js';
import {issueStage8LiveAuthority} from './stage8LiveAuthority.js';
import {createStage8MorningStore} from './stage8MorningStore.js';
import {stage8Configuration} from './stage8Runtime.js';
import {createTelegramApi} from './bot/api.js';
import {SEND_OUTCOME} from './sendOutcome.js';
import {validMessageId} from './telegramAcknowledgment.js';
import {localDate} from './time.js';
import {profileRevisionKey} from './profileRevision.js';
import {isSafePrivateChatId} from './schema.js';
const fail=code=>{throw Error(code);};
export async function createStage8MorningRuntime({db,keys,environment,env,admission,now=()=>new Date()}){
 assertStage8Recovery(environment);const fence=stage8ConfigurationFence(environment);
 if((environment.STAGE8_MORNING_BRIEF??'off')!=='on')return null;
 const config=stage8Configuration({...environment,PHASE4_STAGE8_RUNTIME:'on'}),eligible=uid=>{try{fence();return environment.STAGE8_MORNING_BRIEF==='on'&&stage8Configuration({...environment,PHASE4_STAGE8_RUNTIME:'on'}).userIds.includes(uid);}catch{return false;}};
 admission??=await db.admitRuntime();
 const liveAuthority=issueStage8LiveAuthority({db,keys,admission,userIds:config.userIds,enabled:()=>eligible(config.userIds[0])});
 const core=await buildPhase4Core({keys,admission,liveAuthority,now,processing:{client:db.raw,transaction:db.transaction,active:db.processingTransactionActive,assertFences:db.assertRuntimeFences,afterCommit:db.afterProcessingCommit,afterCompletion:db.afterProcessingCompletion},
  authorizeMode(mode,client,userId){if(mode!=='LIVE'||client!==db.raw||!eligible(userId))fail('MORNING_ROLLOUT_FENCED');}});
 const stores=composePhase4Stores(core),store=createStage8MorningStore({core,db,preferences:stores.preferences,enabled:eligible}),api=createTelegramApi({botToken:env.telegramBotToken});
 // Capture enrollment before starting an attempt. Final content and controls
 // share one consistent transaction, followed by no unrelated awaited work
 // before provider IO. READY -> other -> READY cannot inherit the original
 // authority because v34/v35 enrollment revision is monotonic.
 async function deliveryAdmission(context,lease,{captured=null,started=null}={}){
  return core.run(context,async()=>{
   let contentUntil=Infinity;
   if(started){
    const message=await core.artifact(context,'outbound_messages',{message_id:lease.messageId}),found=await store.plans.validate(context,message.row),plan=found.plan;
    const deadlines=[Date.parse(plan.asOfUtc)+90*60000,Date.parse(plan.expiresAt)];
    if(plan.intelligence?.validUntil)deadlines.push(Date.parse(plan.intelligence.validUntil));
    for(const proof of plan.proofs){
     if(proof.type==='cycle'){
      const source=(await db.raw.execute({sql:'SELECT synced_at FROM whoop_cycles WHERE user_id=? AND id=?',args:[context.userId,proof.id]})).rows[0];
      deadlines.push(Date.parse(source?.synced_at)+90*60000);
     }else{
      const sync=(await db.raw.execute({sql:`SELECT
       (SELECT last_success_at FROM whoop_sync_state WHERE user_id=? AND resource=?) last_success_at,
       (SELECT captured_at FROM morning_readiness_refreshes WHERE user_id=? AND resource=? AND auth_generation=? AND lifecycle_generation=?) captured_at`,
       args:[context.userId,proof.type,context.userId,proof.type,context.authGeneration,context.lifecycleGeneration]})).rows[0];
      const fresh=Math.max(...[sync?.last_success_at,sync?.captured_at].map(value=>Number.isFinite(Date.parse(value))?Date.parse(value):0));
      deadlines.push(fresh+90*60000);
     }
    }
    if(!deadlines.every(Number.isFinite))fail('MORNING_FINAL_ADMISSION_FENCED');contentUntil=Math.min(...deadlines);
   }
   const rows=(await db.raw.execute({sql:`SELECT u.status,u.timezone,u.lifecycle_generation,COALESCE(t.auth_generation,0) auth_generation,
    s.source_generation,s.purge_generation,s.pending_purge_count,o.state enrollment_state,o.enrollment_revision,
    p.preference_version,p.notifications_paused,profile.value profile_revision,b.telegram_chat_id,b.linked_at,
    d.mode delivery_mode,d.revision delivery_revision,d.timezone delivery_timezone,d.cutover_boundary,d.cutover_health_date,
    d.lifecycle_generation delivery_lifecycle,d.auth_generation delivery_auth,
    m.state message_state,m.revision message_revision,m.message_id,m.reservation_id,m.destination_binding_id,
    m.payload_text,m.payload_json,m.payload_hash,m.content_digest_salt,m.attempt_count,m.lease_owner,m.lease_expires_at,m.expires_at,
    m.content_state,m.source_linkage_state,m.health_content_redacted_at,m.input_generation,m.lifecycle_generation message_lifecycle,
    m.auth_generation message_auth,m.purge_generation message_purge,r.state reservation_state,r.message_id reservation_message_id,
    r.message_family,r.local_health_date,a.state attempt_state,a.attempt_number,a.request_hash,a.completed_at,a.provider_message_id,
    a.content_state attempt_content_state,a.source_linkage_state attempt_linkage_state,a.health_content_redacted_at attempt_redacted_at
    FROM users u JOIN phase4_user_state s ON s.user_id=u.id
    LEFT JOIN user_whoop_tokens t ON t.user_id=u.id JOIN user_onboarding o ON o.user_id=u.id
    JOIN user_notification_preferences p ON p.user_id=u.id JOIN telegram_state profile ON profile.key=?
    JOIN user_telegram b ON b.user_id=u.id AND b.status='ACTIVE'
    JOIN tenant_delivery_modes d ON d.user_id=u.id AND d.execution_mode='LIVE' AND d.message_family='MORNING_BRIEF_V1'
    JOIN outbound_messages m ON m.user_id=u.id AND m.execution_mode='LIVE' AND m.message_id=?
    JOIN outbound_semantic_reservations r ON r.user_id=m.user_id AND r.execution_mode=m.execution_mode AND r.reservation_id=m.reservation_id
    LEFT JOIN outbound_delivery_attempts a ON a.user_id=m.user_id AND a.execution_mode=m.execution_mode AND a.message_id=m.message_id AND a.attempt_id=?
    WHERE u.id=?`,args:[profileRevisionKey(context.userId),lease.messageId,started?.attemptId??'',context.userId]})).rows;
   if(rows.length!==1)fail('MORNING_FINAL_ADMISSION_FENCED');const r=rows[0],binding=keys.lookup(['destination-binding-v1',context.userId,r.telegram_chat_id,r.linked_at]);
   if(!eligible(context.userId)||r.status!=='ACTIVE'||r.timezone!==context.timezone||r.lifecycle_generation!==context.lifecycleGeneration||r.auth_generation!==context.authGeneration
    ||r.source_generation!==context.sourceGeneration||r.purge_generation!==context.purgeGeneration||r.pending_purge_count!==0
    ||r.enrollment_state!=='READY'||!Number.isSafeInteger(r.enrollment_revision)||r.notifications_paused
    ||!isSafePrivateChatId(r.telegram_chat_id)||binding!==r.destination_binding_id
    ||r.delivery_mode!=='PHASE4'||r.delivery_timezone!==context.timezone||r.delivery_lifecycle!==context.lifecycleGeneration||r.delivery_auth!==context.authGeneration
    ||!r.cutover_health_date||r.local_health_date<r.cutover_health_date||r.reservation_state!=='RESERVED'||r.reservation_message_id!==r.message_id||r.message_family!=='MORNING_BRIEF_V1'
    ||r.content_state!=='PRESENT'||r.source_linkage_state!=='COMPLETE'||r.health_content_redacted_at!==null
    ||r.input_generation!==context.inputGeneration||r.message_lifecycle!==context.lifecycleGeneration||r.message_auth!==context.authGeneration||r.message_purge!==context.purgeGeneration
    ||r.lease_owner!==lease.owner||r.lease_expires_at!==lease.expiresAt||r.lease_expires_at<=core.timestamp()||r.expires_at<=core.timestamp()
    ||contentUntil<=core.now().getTime())fail('MORNING_FINAL_ADMISSION_FENCED');
   const stamp=[r.status,r.timezone,r.lifecycle_generation,r.auth_generation,r.source_generation,r.purge_generation,r.enrollment_revision,
    r.preference_version,r.profile_revision,binding,r.delivery_revision,r.delivery_timezone,r.cutover_boundary,r.cutover_health_date,r.reservation_id,
    r.local_health_date,r.payload_hash,r.expires_at];
   if(!started){
    if(r.message_state!=='CLAIMED'||r.message_revision!==lease.revision)fail('MORNING_FINAL_ADMISSION_FENCED');
    return Object.freeze({stamp:JSON.stringify(stamp),attemptCount:r.attempt_count});
   }
   if(!captured||captured.stamp!==JSON.stringify(stamp)||r.message_state!=='DELIVERY_STARTED'||r.message_revision!==lease.revision+1
    ||r.attempt_count!==captured.attemptCount+1||r.attempt_state!=='DELIVERY_STARTED'||r.attempt_number!==r.attempt_count
    ||r.attempt_content_state!=='PRESENT'||r.attempt_linkage_state!=='COMPLETE'||r.attempt_redacted_at!==null
    ||r.completed_at!==null||r.provider_message_id!==null||started.destinationBindingId!==binding||started.payloadText!==r.payload_text||started.payloadJson!==r.payload_json
    ||r.request_hash!==keys.digest(r.content_digest_salt,JSON.stringify([r.payload_hash,r.destination_binding_id,r.attempt_number])))fail('MORNING_FINAL_ADMISSION_FENCED');
   return {chatId:r.telegram_chat_id,validUntil:Math.min(contentUntil,Date.parse(r.lease_expires_at),Date.parse(r.expires_at))};
  });
 }
 async function settled(userId,day){
  if(!eligible(userId))return false;
  const rows=(await db.raw.execute({sql:"SELECT state FROM outbound_semantic_reservations WHERE user_id=? AND execution_mode='LIVE' AND message_family='MORNING_BRIEF_V1' AND local_health_date=?",args:[userId,day]})).rows;
  return rows.some(r=>r.state==='CONSUMED'||r.state==='CLOSED');
 }
 async function daily(input){
  const {userId,expectedLifecycleGeneration,source,timezone}=input;if(!eligible(userId))return null;
  await core.initializeTenant(userId,'LIVE');const control=await core.captureControl(userId),ctx=await store.context(control),mode=await store.transport.mode(ctx,'MORNING_BRIEF_V1');
  if(mode.mode==='LEGACY'){
   if(environment.PHASE4_DELIVERY_CUTOVER==='on')await store.requestCutover(control,{expectedRevision:mode.revision});
   return null;
  }
  await store.expirePending(control);
  const day=localDate(now(),timezone);if(!await store.owns(control,day))return null;
  if(await settled(userId,day))return {status:'already_sent',typed:true,healthDate:day};
  // Only the existing bounded sleep/recovery poll is persisted. No full sync,
  // reconciliation, baseline history, model, analytics or DRAIN is invoked.
  const before=await db.getTokens(userId),polled=await source.poll();
  fence();
  if(!Array.isArray(polled.sleeps)||!Array.isArray(polled.recoveries)||polled.sleeps.length>50||polled.recoveries.length>50)fail('MORNING_REFRESH_BOUNDS');
  await db.transaction(async()=>{
   await db.assertAccountActive(userId,expectedLifecycleGeneration);
   const current=await db.getTokens(userId);if(current?.authGeneration!==before?.authGeneration||!current)fail('MORNING_REFRESH_AUTH_CHANGED');
   await db.upsertSleeps(userId,polled.sleeps,{timezone,now:now()});await db.upsertRecoveries(userId,polled.recoveries,{now:now()});
   for(const resource of ['sleep','recovery'])await db.raw.execute({sql:'INSERT INTO morning_readiness_refreshes(user_id,resource,captured_at,auth_generation,lifecycle_generation) VALUES(?,?,?,?,?) ON CONFLICT(user_id,resource) DO UPDATE SET captured_at=excluded.captured_at,auth_generation=excluded.auth_generation,lifecycle_generation=excluded.lifecycle_generation',args:[userId,resource,now().toISOString(),control.authGeneration,control.lifecycleGeneration]});
   await db.assertAccountActive(userId,expectedLifecycleGeneration);
  });
  const ready=await store.prepare(control);if(ready.status!=='READY'){
   if(['CLAIMED','DELIVERY_STARTED'].includes(ready.status)&&ready.messageId){
    const row=(await db.raw.execute({sql:"SELECT revision FROM outbound_messages WHERE user_id=? AND execution_mode='LIVE' AND message_id=?",args:[userId,ready.messageId]})).rows[0];
    await store.transport.recover(control,'LIVE',{messageId:ready.messageId,expectedRevision:row.revision});
   }
   return {status:ready.status,typed:true,healthDate:day};
  }
  const current=await store.context(control),row=(await core.artifact(current,'outbound_messages',{message_id:ready.messageId})).row;
  if(row.state==='PROPOSED')await store.transport.makeEligible(current,{messageId:row.message_id,expectedRevision:row.revision});
  const lease=await store.transport.claim(current,{messageId:row.message_id,owner:core.newId(),leaseMs:120000});if(!lease)return {status:'overlap',typed:true};
  const captured=await deliveryAdmission(current,lease);
  const started=await store.transport.start(current,lease);let outcome='FAILED_DEFINITE',errorCode='STALE_GENERATION',messageId=null,sendBegan=false;
  try{
   const final=await core.artifact(current,'outbound_messages',{message_id:row.message_id});await store.plans.validate(current,final.row);
   if(!eligible(userId)||await store.transport.destination(current)!==started.destinationBindingId)fail('MORNING_DESTINATION_CHANGED');
   const binding=(await db.raw.execute({sql:"SELECT telegram_chat_id FROM user_telegram WHERE user_id=? AND status='ACTIVE'",args:[userId]})).rows;
   if(binding.length!==1||!/^\d+$/.test(binding[0].telegram_chat_id))fail('MORNING_DESTINATION_CHANGED');
   await core.assertContext(current);await db.assertRuntimeFences?.();
   // Final source graph, content, expiry and delivery controls are observed
   // in one consistent transaction after the last unrelated runtime fence.
   const admitted=await deliveryAdmission(current,lease,{captured,started});
   if(!eligible(userId)||core.now().getTime()>=admitted.validUntil)fail('MORNING_ROLLOUT_FENCED');sendBegan=true;
   const result=await api.sendMessage(admitted.chatId,{text:started.payloadText});
   if(!validMessageId(result?.message_id))throw Error('MORNING_ACK_INVALID');messageId=String(result.message_id);outcome='DELIVERED';errorCode=null;
  }catch(error){outcome=!sendBegan||error?.sendOutcome===SEND_OUTCOME.DEFINITE_FAILURE?'FAILED_DEFINITE':'AMBIGUOUS';errorCode=sendBegan?outcome==='AMBIGUOUS'?'NETWORK_UNCERTAIN':error?.status===429?'PROVIDER_RATE_LIMIT':error?.status>=500?'PROVIDER_UNAVAILABLE':'PROVIDER_DEFINITE_NON_ACCEPTANCE':'STALE_GENERATION';messageId=null;}
  try{await store.transport.settle(control,'LIVE',{attemptId:started.attemptId,outcome,providerMessageId:messageId,errorCode,...(outcome==='AMBIGUOUS'?{ambiguityReason:'UNKNOWN_ACCEPTANCE'}:{})});}
  catch(error){
   if(sendBegan||error?.message!=='PHASE4_ATTEMPT_TERMINAL')throw error;
   // An expired-lease recovery can settle the attempt while this invocation
   // is still verifying content. No provider IO began here; retain that
   // existing attempt truth and its no-resend barrier without overwriting it.
   const actual=(await db.raw.execute({sql:"SELECT state FROM outbound_delivery_attempts WHERE user_id=? AND execution_mode='LIVE' AND attempt_id=?",args:[userId,started.attemptId]})).rows[0];
   if(!actual||actual.state==='DELIVERY_STARTED')throw error;
   return {status:actual.state,typed:true,healthDate:day,messageId:null};
  }
  // Definite failure remains durable and does not create a fresh date/key. The
  // existing bounded transport retry policy can be applied by a later tick.
  return {status:outcome==='DELIVERED'?'sent':outcome,typed:true,healthDate:day,messageId};
 }
 return Object.freeze({eligible,settled,daily,store,core});
}
