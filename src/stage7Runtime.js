import {checkAndAct} from './proactiveAgent.js';
import {createTelegram} from './telegram.js';
import {checkLowEnergy} from './onDemandBodyAlerts.js';
import {createBodyEnergyRuntime} from './bodyEnergyRuntime.js';
import {onDemandBodyEnabled} from './onDemandBodyEnergy.js';
import {createStage7ProactiveJournal,isProactiveJournalDelivery} from './stage7ProactiveJournal.js';
import {captureStage7Enrollment,assertStage7Enrollment} from './stage7Enrollment.js';
import {confirmedMorningReceipt} from './confirmedMorningReceipt.js';
import {isApprovedStage7Three} from './stage7Cohort.js';
import {buildPhase4Core,fail,readableRow} from './phase4Core.js';
import {composePhase4Stores} from './phase4Repositories.js';
import {createStage7Composition} from './stage7Composition.js';
import {createStage7Dispatcher} from './stage7Dispatcher.js';
import {createStage7ProductionProvider} from './stage7TransportAuthority.js';
import {createCompanionCoach,COACH_COPY} from './companionCoach.js';
import {createCompanionInvitation} from './companionInvitation.js';
import {companionEngagementBusy} from './companionEngagementGuard.js';
import {COMPANION_DEFAULTS,inStage7QuietHours as inCompanionQuietHours} from './companionTimingPolicy.js';
import {presentationLocale,JOURNAL_COPY} from './stage7Registry.js';
import {labelForCategory} from './journal.js';
import {requireUserId} from './userContext.js';
import {localDate} from './time.js';
import {createStage7ReplyAuthority} from './stage7ReplyAuthority.js';
import {workStepOptions} from './phase4WorkStep.js';
export function stage7Configuration(environment={}){
 const mode=environment.STAGE7_COMPANION??'off',raw=environment.STAGE7_COMPANION_USER_IDS??'',automatic=environment.STAGE7_AUTOMATIC??'off';
 if(!['off','on'].includes(mode)||!['off','on'].includes(automatic)||automatic==='on'&&mode!=='on'||typeof raw!=='string')fail('STAGE7_CONFIG_INVALID');
 const userIds=raw?raw.split(',').map(v=>requireUserId(v.trim(),'stage7')):[];
 if(mode==='on'&&!isApprovedStage7Three(userIds)&&!(userIds.length===1&&userIds[0]===environment.PHASE4_BETA_PILOT_USER_ID))fail('STAGE7_OWNER_ROLLOUT_REQUIRED');
 if(automatic==='on'&&!isApprovedStage7Three(userIds))fail('STAGE7_APPROVED_THREE_REQUIRED');
 const number=(name,fallback)=>environment[name]===undefined?fallback:Number(environment[name]);
 const timing=Object.freeze({...COMPANION_DEFAULTS,coachAfterWakeMinimumHours:number('STAGE7_COACH_MIN_HOURS',4),coachAfterWakeMaximumHours:number('STAGE7_COACH_MAX_HOURS',6),journalGapHours:number('STAGE7_JOURNAL_GAP_HOURS',2)});
 if(![timing.coachAfterWakeMinimumHours,timing.coachAfterWakeMaximumHours,timing.journalGapHours].every(Number.isFinite)||timing.coachAfterWakeMinimumHours<4||timing.coachAfterWakeMaximumHours>6||timing.coachAfterWakeMinimumHours>timing.coachAfterWakeMaximumHours||timing.journalGapHours<2||timing.journalGapHours>6)fail('STAGE7_TIMING_CONFIG_INVALID');
 return Object.freeze({mode,automatic:automatic==='on',userIds:Object.freeze(userIds),timing});
}
/** Production composition is separate from the closed synthetic entry point.
 * It owns no SYNC, DRAIN, pilot renewal or Foundation LIVE capability. */
export async function createStage7Runtime({db,keys,env,environment={},admission,coachContext=null,now=()=>new Date()}={}){
 const config=stage7Configuration(environment);if(config.mode==='off')return null;
 admission??=await db.admitRuntime();
 const core=await buildPhase4Core({processing:{client:db.raw,transaction:db.transaction,withReadSnapshot:db.withProcessingReadSnapshot,assertFences:db.assertRuntimeFences,active:db.processingTransactionActive,afterCommit:db.afterProcessingCommit,afterCompletion:db.afterProcessingCompletion},keys,admission,now,
  authorizeMode(mode){if(mode!=='SHADOW')fail('PHASE4_LIVE_NOT_AUTHORIZED');}});
 if(![33,34,35].includes(core.schemaVersion))fail('STAGE7_V33_CONFIG_REQUIRED');
 const stores=composePhase4Stores(core),companion=await createStage7Composition({core,stores,db}),coach=createCompanionCoach({core,stores,db,companion,coachContext}),invitations=createCompanionInvitation({core,stores,db,companion,coach,configuration:config.timing});
 const proactiveJournal=createStage7ProactiveJournal({core,db,companion});
 const eligible=user=>Boolean(user&&config.userIds.includes(user.id)&&user.status==='ACTIVE');
 const replies=createStage7ReplyAuthority({core,db,companion});
 const beforeSend=async authority=>core.transaction(async()=>{
  const user=await db.getUser(authority.userId),currentConfig=stage7Configuration(environment);
  if(currentConfig.mode!=='on'||!eligible(user)||!currentConfig.userIds.includes(user.id))fail('STAGE7_ROLLOUT_FENCED');
  const actor=await companion.interactions.authenticate({user,chatId:authority.chatId});
  if(actor.state.lifecycle_generation!==authority.actor.state.lifecycle_generation||actor.state.auth_generation!==authority.actor.state.auth_generation||actor.profileRevision!==authority.actor.profileRevision)fail('STAGE7_ACTOR_FENCED');
  const row=(await core.client.execute({sql:'SELECT * FROM journal_prompt_deliveries WHERE user_id=? AND delivery_id=?',args:[user.id,authority.deliveryId]})).rows[0],prefs=await companion.preferences(actor);
  const paused=(await core.client.execute({sql:'SELECT notifications_paused FROM user_notification_preferences WHERE user_id=?',args:[user.id]})).rows[0];
  const legacy=isProactiveJournalDelivery(row),interaction=row?.interaction_id?await companion.interactions.read(user.id,row.interaction_id):null;
  if(legacy?!await proactiveJournal.authorized(actor,row,interaction,prefs):!currentConfig.automatic)fail('STAGE7_ROLLOUT_FENCED');
  await assertStage7Enrollment({core,db,actor,row});
  if(!await companion.weekly.optionalSlotAvailable(actor,row))fail('STAGE7_DELIVERY_FENCED');
  if(!readableRow(row)||row.state!=='DELIVERY_STARTED'||row.preference_revision!==prefs.revision||row.expires_at<=core.timestamp()||paused?.notifications_paused
   ||inCompanionQuietHours(core.now(),actor.state.timezone,prefs.quiet_start,prefs.quiet_end)
   ||row.kind==='DAILY'&&!legacy&&!prefs.daily_enabled||row.kind==='COACH'&&!prefs.coach_enabled||row.kind==='WEEKLY'&&!prefs.weekly_enabled
   ||await companionEngagementBusy({core,db,actor,excludeInteractionId:authority.interactionId}))fail('STAGE7_DELIVERY_FENCED');
  if(row.kind==='DAILY'&&!legacy){
   const proof=await confirmedMorningReceipt({core,actor,day:localDate(core.now(),actor.state.timezone)});
   const linked=proof&&(await core.client.execute({sql:"SELECT 1 FROM phase4_source_links WHERE user_id=? AND artifact_type='journal_prompt_deliveries' AND artifact_id=? AND source_type=? AND source_id=? AND unlinked_at IS NULL LIMIT 1",args:[user.id,row.privacy_artifact_id,proof.reportType,proof.reportSource]})).rows.length;
   if(!linked)fail('STAGE7_DELIVERY_FENCED');
  }
  if(row.kind==='COACH'&&(await invitations.due(actor,row)).status!=='READY')fail('STAGE7_DELIVERY_FENCED');
  if(row.kind==='WEEKLY'){
   const current=await companion.weekly.due(actor,row);
   if(current.status!=='READY'||current.projectionDigest!==authority.weeklyProjectionDigest)fail('STAGE7_DELIVERY_FENCED');
  }
 },workStepOptions('stage7.delivery.authorize',[authority.userId,authority.deliveryId,authority.interactionId],{discardResult:true,replay:()=>{
  // A recorded fence is never a reusable grant to send. A replayed start must
  // reconcile canonical state; it cannot replay actor authority into Telegram.
  fail('STAGE7_DELIVERY_FENCED');
 }}));
 const provider=createStage7ProductionProvider({db,core,keys,admission,env,userIds:config.userIds,beforeSend}),dispatcher=createStage7Dispatcher({core,db,companion,provider,invitations,proactiveJournal});
 async function stage7Inbound(input){
  if(!eligible(input.user))return null;
  const request={...input,requestKey:String(input.updateId)},reply=await coach.handle({...request,deferQuery:true})??await companion.handle(request)??await companion.handleNote(input);
  return reply?{handled:true,reply}:null;
 }
 async function projectReply({user,chatId,reply}){
  if(!eligible(user)||!reply)return null;
  const actor=await companion.interactions.authenticate({user,chatId});
  if(reply.stage7View==='WEEKLY'){const fresh=await companion.weekly.build(actor);return {text:fresh.text,editMessageId:reply.editMessageId,replyMarkup:{inline_keyboard:[]},stage7SourceFacts:fresh.sourceFactIds,stage7SourceInteractions:fresh.sourceInteractionIds,stage7SourceEvidence:fresh.sourceEvidenceIds};}
  if(!reply.stage7InteractionId)return reply;
  const row=await companion.interactions.read(user.id,reply.stage7InteractionId);
  if(!row||row.revision!==reply.stage7Revision)return companion.interactions.expired(actor);
  if(row.kind==='COACH')return coach.card(actor,row);
  if(reply.stage7View==='RECENT'){
   const facts=await companion.ownFacts(actor),locale=presentationLocale(await db.getLocale(user.id)),c=JOURNAL_COPY[locale];
   return {...reply,text:facts.length?facts.slice(0,10).map(f=>`${f.health_date} · ${labelForCategory(f.category,locale)} · ${f.exposure_state==='CONFIRMED_UNEXPOSED'?c.no:c.yes}`).join('\n'):c.empty};
  }
  const card=await companion.card(actor,row);
  if(row.state==='COMPLETED'){
   // Inline invitation in the acknowledged Journal confirmation; no extra send.
   const navigation=await coach.issue(actor,{semanticKey:keys.lookup(['coach-after-journal-v1',user.id,row.interaction_id,row.revision])});
   // A single reply may own two callback rows, both bound at the send boundary.
   return {...card,replyMarkup:{inline_keyboard:[...card.replyMarkup.inline_keyboard,...navigation.replyMarkup.inline_keyboard]},stage7AdditionalInteractionId:navigation.stage7InteractionId,stage7AdditionalRevision:navigation.stage7Revision};
  }
  return card;
 }
 async function stage7Reply(input){
  if(!eligible(input.user)||!input.reply)return null;
  const actor=await companion.interactions.authenticate(input),reply=await projectReply(input);
  return replies.seal(actor,reply);
 }
 async function decorate({user,chatId,text,reply}){
  if(!eligible(user)||!reply||typeof reply!=='string'&&(reply.stage7ReplyGuard||reply.bodyEnergyReplyGuard||reply.stage8ReplyGuard||reply.stage5PresentationGuard))return reply;
  const settings=typeof text==='string'&&/^\/settings(?:@[A-Za-z0-9_]+)?\s*$/i.test(text.trim());
  const natural=typeof text==='string'&&!text.trim().startsWith('/')&&/[?？]|睡|恢復|運動|sleep|recovery|exercise|ngủ|phục hồi|vận động|tập luyện/i.test(text);
  if(!settings&&!natural)return reply;
  const actor=await companion.interactions.authenticate({user,chatId});
  if(settings){
   const issued=await companion.interactions.issue(actor,{kind:'QUICK',diagnostics:{settingsEntry:true}}),base=await companion.card(actor,issued.row),c=COACH_COPY[presentationLocale(await db.getLocale(user.id))];
   const button=await companion.interactions.button(actor,issued.row,{text:c.preferences,action:'preferences'});
   return replies.seal(actor,{...base,text:typeof reply==='string'?reply:reply.text,replyMarkup:{inline_keyboard:[...(reply.replyMarkup?.inline_keyboard??[]),[button]]},stage7View:'SETTINGS_LINK'});
  }
  const navigation=await coach.issue(actor);return replies.seal(actor,{...(typeof reply==='object'?reply:{}),...navigation,text:typeof reply==='string'?reply:reply.text});
 }
 async function sendReply(send,input){
  const protectedReply=input.reply?.stage7ReplyGuard||input.reply?.stage7InteractionId||input.reply?.stage7View||input.reply?.stage7CoachContextGuard;
  const beforeSend=async()=>(!input.beforeSend||await input.beforeSend())
   &&(!protectedReply||eligible(await db.getUser(input.userId))&&await replies.verify({user:await db.getUser(input.userId),chatId:input.chatId,reply:input.reply}))
   &&(!input.reply?.stage7CoachContextGuard||Boolean(coachContext)&&await coachContext.verifyReply(input));
  if(!await beforeSend())return {sent:false,messageId:null,reason:'stage7_reply_changed'};
  const result=await send({...input,beforeSend});
  if(result?.sent&&input.userId&&eligible(await db.getUser(input.userId))&&input.reply?.stage7InteractionId){
   const user=await db.getUser(input.userId),actor=await companion.interactions.authenticate({user,chatId:input.chatId});
   for(const id of [input.reply.stage7InteractionId,input.reply.stage7AdditionalInteractionId].filter(Boolean))await companion.interactions.bind(actor,id,input.reply.editMessageId??result.messageId);
  }
  return result;
 }
 async function tick({user,chatId}){
  if(!eligible(user))return {status:'NOT_AUTHORIZED'};
  if(!stage7Configuration(environment).automatic)return {status:'AUTOMATIC_DISABLED'};
  const day=localDate(now(),user.timezone),actor=await companion.interactions.authenticate({user,chatId});
  if(!await captureStage7Enrollment({core,db,actor}))return {status:'ENROLLMENT_NOT_READY'};
  const locale=await db.getLocale(user.id),telegram=createTelegram({botToken:env.telegramBotToken,chatId,db,locale,dryRun:env.dryRun});
  // Health decisions precede all optional work; the shared durable count also
  // covers the separately running SYNC producer and uncertain delivery.
  const health=await checkAndAct({db,userId:user.id,timezone:user.timezone,locale,telegram,chatId,expectedLifecycleGeneration:user.lifecycleGeneration,now:now(),proactiveJournal:sendProactiveJournal});
  let low=null;
  if(onDemandBodyEnabled(environment)){
   const runtime=await createBodyEnergyRuntime({db,keys,admission,environment,env,now});
   low=await checkLowEnergy({db,bodyEnergy:runtime.bodyEnergy,keys,user,telegram,now:now()});
  }
  const daily=await companion.prepareAfterBrief({user,chatId,healthDay:day});
  const dailyResult=daily.deliveryId?await dispatcher.dispatch({user,chatId,deliveryId:daily.deliveryId}):daily;
  const weekly=await companion.weekly.prepare(actor,{automatic:true}),weeklyResult=weekly.deliveryId?await dispatcher.dispatch({user,chatId,deliveryId:weekly.deliveryId}):weekly;
  // Defer Coach for this tick after a new weekly send, without changing its
  // original schedule or manufacturing a Coach interaction for the review.
  const invitation=weeklyResult.deliveredNow?{status:'DEFERRED_AFTER_WEEKLY'}:await invitations.prepare({user,chatId}),coachResult=invitation.deliveryId?await dispatcher.dispatch({user,chatId,deliveryId:invitation.deliveryId}):invitation;
  return {health:health.reason,low:low?.status,daily:dailyResult.status,coach:coachResult.status,weekly:weeklyResult.status};
 }
 async function contextJournal({userId,chatId,healthDate,answer}){
  const user=await db.getUser(userId);if(!eligible(user))return null;
  const card=await companion.prepareContextQuestion({user,chatId,healthDate});if(!card)return null;
  const actor=await companion.interactions.authenticate({user,chatId});
  return replies.seal(actor,{...card,text:`${answer}\n\n${card.text}`});
 }
 async function sendProactiveJournal({userId,chatId,eventId}){
  const user=await db.getUser(userId);
  if(!eligible(user)||env.dryRun)return {status:'NOT_AUTHORIZED'};
  const prepared=await proactiveJournal.prepare({user,chatId,eventId});
  return prepared.deliveryId?dispatcher.dispatch({user,chatId,deliveryId:prepared.deliveryId}):prepared;
 }
 return Object.freeze({contextJournal,sendProactiveJournal,stage7Inbound,stage7Reply,decorate,sendReply,tick,config,companion,coach,invitations,dispatcher});
}
