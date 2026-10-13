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
  const started=await store.transport.start(current,lease);let outcome='FAILED_DEFINITE',errorCode='STALE_GENERATION',messageId=null,sendBegan=false;
  try{
   const final=await core.artifact(current,'outbound_messages',{message_id:row.message_id});await store.plans.validate(current,final.row);
   if(!eligible(userId)||await store.transport.destination(current)!==started.destinationBindingId)fail('MORNING_DESTINATION_CHANGED');
   const binding=(await db.raw.execute({sql:"SELECT telegram_chat_id FROM user_telegram WHERE user_id=? AND status='ACTIVE'",args:[userId]})).rows;
   if(binding.length!==1||!/^\d+$/.test(binding[0].telegram_chat_id))fail('MORNING_DESTINATION_CHANGED');
   await core.assertContext(current);await db.assertRuntimeFences?.();sendBegan=true;
   const result=await api.sendMessage(binding[0].telegram_chat_id,{text:started.payloadText});
   if(!validMessageId(result?.message_id))throw Error('MORNING_ACK_INVALID');messageId=String(result.message_id);outcome='DELIVERED';errorCode=null;
  }catch(error){outcome=!sendBegan||error?.sendOutcome===SEND_OUTCOME.DEFINITE_FAILURE?'FAILED_DEFINITE':'AMBIGUOUS';errorCode=sendBegan?outcome==='AMBIGUOUS'?'NETWORK_UNCERTAIN':'PROVIDER_DEFINITE_NON_ACCEPTANCE':'STALE_GENERATION';messageId=null;}
  await store.transport.settle(control,'LIVE',{attemptId:started.attemptId,outcome,providerMessageId:messageId,errorCode,...(outcome==='AMBIGUOUS'?{ambiguityReason:'UNKNOWN_ACCEPTANCE'}:{})});
  // Definite failure remains durable and does not create a fresh date/key. The
  // existing bounded transport retry policy can be applied by a later tick.
  return {status:outcome==='DELIVERED'?'sent':outcome,typed:true,healthDate:day,messageId};
 }
 return Object.freeze({eligible,settled,daily,store,core});
}
