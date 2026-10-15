import {subjectAlertDigest} from './stage8SubjectAlertManifest.js';
import {bindProducingExecution} from './phase4ExecutionContext.js';
import {createStage7DecisionStore} from './stage7DecisionStore.js';
import {liveProducerConfiguration,isLiveExecution} from './stage8LiveProducerAuthority.js';
import {currentDurableExecution} from './phase4ExecutionContext.js';
import {assertStage8LiveJobsFinalized} from './stage8LivePublication.js';
import {workStepOptions} from './phase4WorkStep.js';
import {ANTI_SPAM_POLICY} from './proactivePolicy.js';
import {createTelegramApi} from './bot/api.js';
import {validMessageId} from './telegramAcknowledgment.js';
import {SEND_OUTCOME} from './sendOutcome.js';
import {followRuntimeRenewal,requireRuntimeAdmission} from './runtimeAdmission.js';
const providers=new WeakMap();
const fail=()=>{throw Object.assign(Error('STAGE8_SUBJECT_ALERT_AUTHORITY_REQUIRED'),{code:'STAGE8_SUBJECT_ALERT_AUTHORITY_REQUIRED'});};
/** Opaque server adapter: no request-supplied transport, credentials or outcome. */
export function createStage8SubjectAlertProvider({db,keys,admission,environment,env,eligible}){
 if(environment.STAGE8_SUBJECT_ALERTS!=='on')return null;
 followRuntimeRenewal(db.raw,admission,keys,db.transaction,next=>{admission=next;});
 const api=createTelegramApi({botToken:env.telegramBotToken}),provider=Object.freeze({});
 providers.set(provider,{db,async send({userId,text,destinationBindingId,verify}){
  let sendBegan=false;try{
  if(environment.STAGE8_SUBJECT_ALERTS!=='on'||environment.STAGE8_LIVE_ANALYSIS!=='on'||!eligible(userId)||requireRuntimeAdmission(db.raw,admission,keys,db.transaction)!==35)fail();
  const rows=(await db.raw.execute({sql:"SELECT telegram_chat_id,linked_at FROM user_telegram WHERE user_id=? AND status='ACTIVE'",args:[userId]})).rows;
  if(rows.length!==1||!/^\d+$/.test(rows[0].telegram_chat_id)||destinationBindingId!==keys.lookup(['destination-binding-v1',userId,rows[0].telegram_chat_id,rows[0].linked_at]))fail();
  await verify();
  sendBegan=true;const result=await api.sendMessage(rows[0].telegram_chat_id,{text});if(!validMessageId(result?.message_id))throw Error('STAGE8_SUBJECT_ALERT_ACK_INVALID');return String(result.message_id);
  }catch(error){if(!sendBegan)error.sendOutcome=SEND_OUTCOME.DEFINITE_FAILURE;throw error;}
 }});return provider;
}
/** Closed test transport, accepted only on an owned empty-file in-memory DB. */
export function createSyntheticStage8SubjectAlertProvider({db,outcomes=[]}){
 const calls=[],remaining=[...outcomes],provider=Object.freeze({calls});providers.set(provider,{db,synthetic:true,async send(input){
  try{await input.verify();}catch(error){error.sendOutcome=SEND_OUTCOME.DEFINITE_FAILURE;throw error;}calls.push({userId:input.userId,text:input.text,destinationBindingId:input.destinationBindingId});const outcome=remaining.shift()??'DELIVERED';
  if(outcome==='FAILED_DEFINITE')throw Object.assign(Error('SYNTHETIC_NON_ACCEPTANCE'),{sendOutcome:SEND_OUTCOME.DEFINITE_FAILURE});
  if(outcome==='AMBIGUOUS')throw Error('SYNTHETIC_UNKNOWN_ACCEPTANCE');return String(800+calls.length);
 }});return provider;
}
export async function createStage8SubjectAlerts({core,stores,db,capability,provider}){
 const transport=providers.get(provider);if(!transport||transport.db!==db)fail();
 liveProducerConfiguration(capability,core.client,core.keys);
 if(transport.synthetic){const files=(await db.raw.execute('PRAGMA database_list')).rows;if(db.raw.protocol!=='file'||files.some(r=>r.file!==''||!['main','temp'].includes(r.name)))fail();}
 const decisions=createStage7DecisionStore({core,stores,liveProducingAuthority:capability});
 async function produce(ctx){
  liveProducerConfiguration(capability,core.client,core.keys,ctx.userId);
  if(!isLiveExecution(currentDurableExecution(),core.client,core.keys,ctx.userId,ctx))fail();
  await assertStage8LiveJobsFinalized(core,ctx);
  const step=(kind,facts,work)=>core.transaction(work,workStepOptions('stage8.subject-alert.'+kind,[ctx.userId,ctx.inputGeneration,...facts],{discardResult:true}));
  const eligible=async()=>{
   liveProducerConfiguration(capability,core.client,core.keys,ctx.userId);await core.assertContext(ctx);
   const row=(await core.client.execute({sql:`SELECT d.mode,d.lifecycle_generation,d.auth_generation,n.notifications_paused,o.state
    FROM tenant_delivery_modes d JOIN user_notification_preferences n ON n.user_id=d.user_id JOIN user_onboarding o ON o.user_id=d.user_id
    WHERE d.user_id=? AND d.execution_mode='LIVE' AND d.message_family='EPISODE_NOTIFICATION'`,args:[ctx.userId]})).rows[0];
   return row?.mode==='PHASE4'&&row.lifecycle_generation===ctx.lifecycleGeneration&&row.auth_generation===ctx.authGeneration&&!row.notifications_paused&&row.state==='READY';
  };
  await step('begin',[],()=>bindProducingExecution(core.client,ctx));
  const pending=(await core.client.execute({sql:"SELECT message_id,revision FROM outbound_messages WHERE user_id=? AND execution_mode='LIVE' AND message_class='EPISODE_NOTIFICATION' AND state='DELIVERY_STARTED' ORDER BY created_at,message_id LIMIT 4",args:[ctx.userId]})).rows;
  if(pending.length>3)fail();
  for(const row of pending)await step('recover',[row.message_id,row.revision],async()=>stores.transport.recover(await stores.captureControl(ctx.userId),'LIVE',{messageId:row.message_id,expectedRevision:row.revision}));
  if(!await eligible())return {outcome:'NO_ELIGIBLE_WORK',itemsProcessed:0};
  const episodes=(await core.client.execute({sql:"SELECT episode_id,last_semantic_event_id FROM observation_episodes WHERE user_id=? AND execution_mode='LIVE' AND input_generation=? AND state IN ('OPEN','UPDATING','ESCALATED','EXPLAINED','STABILIZING') AND expires_at>? ORDER BY last_material_change_at DESC,episode_id LIMIT 10",args:[ctx.userId,ctx.inputGeneration,core.timestamp()]})).rows;
  let sent=0;
  for(const row of episodes){
   const episode=await stores.episodes.read(ctx,row.episode_id),since=new Date(core.now().getTime()-ANTI_SPAM_POLICY.TOPIC_COOLDOWN_HOURS*3600000).toISOString();
   const history=(await core.client.execute({sql:`SELECT e.subject_key FROM outbound_messages m JOIN observation_episodes e ON e.user_id=m.user_id AND e.execution_mode=m.execution_mode AND e.episode_id=m.episode_id
    WHERE m.user_id=? AND m.execution_mode='LIVE' AND m.message_class='EPISODE_NOTIFICATION' AND m.state IN ('DELIVERY_STARTED','DELIVERED','AMBIGUOUS') AND m.created_at>? LIMIT 3`,args:[ctx.userId,since]})).rows;
   if(history.length>=ANTI_SPAM_POLICY.DAILY_PROACTIVE_CAP||history.some(r=>r.subject_key===episode.row.subject_key))continue;
   const decision=await step('decision',[row.episode_id,row.last_semantic_event_id],()=>decisions.evaluate(ctx,{episodeId:row.episode_id,semanticEventId:row.last_semantic_event_id,triggerKey:'stage8-live-important-v1'}));
   if(decision.row?.action!=='NOTIFY')continue;
   const proposed=await step('proposal',[decision.row.decision_id],()=>decisions.propose(ctx,{decisionId:decision.row.decision_id}));if(!proposed.row||proposed.terminal)continue;
   const id=proposed.row.message_id;if(['DELIVERED','AMBIGUOUS','DELIVERY_STARTED'].includes(proposed.row.state))continue;
   if(proposed.row.state!=='PROPOSED')continue;
   const attempt=await step('start',[id],async()=>{
    if(!await eligible())fail();await stores.transport.makeEligible(ctx,{messageId:id,expectedRevision:proposed.row.revision});
    const lease=await stores.transport.claim(ctx,{messageId:id,owner:'stage8-live-subject-alert'});if(!lease)fail();return stores.transport.start(ctx,lease);
   });
   let outcome='FAILED_DEFINITE',providerMessageId=null,sendBegan=false;
   try{if(!await eligible())fail();await core.assertContext(ctx);sendBegan=true;providerMessageId=await transport.send({userId:ctx.userId,text:attempt.payloadText,destinationBindingId:attempt.destinationBindingId,verify:async()=>{if(!await eligible()||attempt.destinationBindingId!==await stores.transport.destination(ctx))fail();await core.assertContext(ctx);}});outcome='DELIVERED';}
   catch(error){outcome=!sendBegan||error.sendOutcome===SEND_OUTCOME.DEFINITE_FAILURE?'FAILED_DEFINITE':'AMBIGUOUS';}
   await step('settle',[attempt.attemptId],async()=>{
    const control=await stores.captureControl(ctx.userId);return stores.transport.settle(control,'LIVE',{attemptId:attempt.attemptId,outcome,...(providerMessageId?{providerMessageId}:{}),...(outcome==='AMBIGUOUS'?{ambiguityReason:'UNKNOWN_ACCEPTANCE'}:{}),...(outcome==='FAILED_DEFINITE'?{errorCode:'PROVIDER_DEFINITE_NON_ACCEPTANCE'}:{})});
   });sent++;
  }
  const alertSourceDigest=await core.transaction(async()=>{await bindProducingExecution(core.client,ctx);return subjectAlertDigest(core,ctx);},workStepOptions('stage8.subject-alert.manifest',[ctx.userId,ctx.inputGeneration]));
  return {outcome:'COMPLETE',itemsProcessed:sent,alertSourceDigest};
 }
 return Object.freeze({produce});
}
