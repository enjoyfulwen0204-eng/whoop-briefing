import {captureStage7Enrollment,assertStage7Enrollment} from './stage7Enrollment.js';
import {companionEngagementBusy} from './companionEngagementGuard.js';
import {inCompanionQuietHours} from './companionTimingPolicy.js';
import {TOPICS} from './stage7Registry.js';
import {readableRow} from './phase4Core.js';
import {localDate,localMidnightUtc,addDays} from './time.js';
import {workStepOptions} from './phase4WorkStep.js';

const SOURCE='legacy-proactive-journal-v1';
const decode=value=>{try{return JSON.parse(value??'null');}catch{return null;}};
export const isProactiveJournalDelivery=row=>decode(row?.schedule_json)?.source===SOURCE;
/** Internal server composition: the original durable event, never a callback
 * payload, grants this presentation. Daily opt-in remains a separate purpose. */
export function createStage7ProactiveJournal({core,db,companion}){
 const {client,keys,timestamp}=core;
 async function original(actor,eventId){
  if(!Number.isSafeInteger(eventId)||eventId<1)return null;
  const event=(await client.execute({sql:'SELECT * FROM proactive_events WHERE user_id=? AND id=?',args:[actor.control.userId,eventId]})).rows[0];
  const reason=decode(event?.reason_json),category=reason?.question_category,targetDate=reason?.question_target_date;
  if(!readableRow(event)||event.decision!=='ASK_CONTEXT'||event.lifecycle_generation!==actor.state.lifecycle_generation
   ||event.sent_at||event.pending_question_id||event.outcome||!TOPICS.includes(category)||category==='stress'
   ||!/^\d{4}-\d{2}-\d{2}$/.test(targetDate??''))return null;
  // Preserve the original date exactly. No current-day or vague recent-period
  // answer is converted into a completed-day exposure observation.
  if(localMidnightUtc(addDays(targetDate,1),actor.state.timezone)>core.now())return null;
  return {event,category,targetDate};
 }
 async function permitted(actor,prefs,category){
  const paused=(await client.execute({sql:'SELECT notifications_paused FROM user_notification_preferences WHERE user_id=?',args:[actor.control.userId]})).rows[0];
  const excluded=decode(prefs.excluded_topics_json);
  if(!Array.isArray(excluded)||excluded.some(topic=>!TOPICS.includes(topic)))return false;
  return actor.state.auth_generation>=1&&!paused?.notifications_paused&&await db.isProactiveEnabled(actor.control.userId)
   &&!excluded.includes(category)
   &&!inCompanionQuietHours(core.now(),actor.state.timezone,prefs.quiet_start,prefs.quiet_end);
 }
 const semantic=(uid,id)=>keys.lookup([SOURCE,uid,id]);
 async function authorized(actor,row,interaction,prefs){
  const schedule=decode(row?.schedule_json);
  if(!isProactiveJournalDelivery(row)||row.kind!=='DAILY'||!readableRow(interaction))return false;
  const proof=await original(actor,schedule.eventId);
  if(!proof||row.semantic_key!==semantic(actor.control.userId,proof.event.id)||interaction.semantic_key!==row.semantic_key
   ||interaction.category!==proof.category||interaction.target_date!==proof.targetDate||interaction.interaction_id!==row.interaction_id)return false;
  await assertStage7Enrollment({core,db,actor,row});
  return permitted(actor,prefs,proof.category);
 }
 async function prepare({user,chatId,eventId}){
  return core.transaction(async()=>{
   const actor=await companion.interactions.authenticate({user,chatId}),proof=await original(actor,eventId);
   if(!proof)return {status:'UNSUPPORTED_OR_FENCED_QUESTION'};
   const prefs=await companion.preferences(actor),enrollment=await captureStage7Enrollment({core,db,actor});
   if(!enrollment||!await permitted(actor,prefs,proof.category))return {status:'PREFERENCE_OR_ENROLLMENT_FENCED'};
   const key=semantic(user.id,eventId),previous=(await client.execute({sql:'SELECT delivery_id FROM journal_prompt_deliveries WHERE user_id=? AND semantic_key=?',args:[user.id,key]})).rows[0];
   if(previous)return {status:'EXISTING',deliveryId:previous.delivery_id};
   const dayKey=keys.lookup(['journal-day-v1',user.id,localDate(core.now(),actor.state.timezone)]);
   if((await client.execute({sql:'SELECT 1 FROM quick_action_interactions WHERE user_id=? AND day_key=?',args:[user.id,dayKey]})).rows.length)return {status:'DAILY_ALREADY_RESERVED'};
   // Reserve the canonical interaction atomically, before transport. Never open
   // a legacy mirror: openPendingQuestion supersedes older unanswered rows.
   if(await companionEngagementBusy({core,db,actor}))return {status:'INTERACTION_BUSY'};
   const issued=await companion.interactions.issue(actor,{kind:'DAILY',semanticKey:key,dayKey,category:proof.category,targetDate:proof.targetDate,reason:SOURCE});
   await companion.interactions.link('quick_action_interactions',issued.row,'proactive_events',proof.event.privacy_artifact_id);
   const at=timestamp(),reply=await companion.card(actor,issued.row),delivery={user_id:user.id,delivery_id:core.newId(),interaction_id:issued.row.interaction_id,
    semantic_key:key,kind:'DAILY',execution_mode:'SHADOW',state:'PROPOSED',payload_json:JSON.stringify(reply),schedule_json:JSON.stringify({source:SOURCE,eventId,enrollment}),
    lifecycle_generation:actor.state.lifecycle_generation,auth_generation:actor.state.auth_generation,chat_id:actor.chat,preference_revision:prefs.revision,
    created_at:at,updated_at:at,expires_at:issued.row.expires_at,...companion.interactions.privacyFields(actor.state)};
   await companion.interactions.insert('journal_prompt_deliveries',delivery);await companion.interactions.link('journal_prompt_deliveries',delivery);
   await companion.interactions.link('journal_prompt_deliveries',delivery,'quick_action_interactions',issued.row.privacy_artifact_id);
   await companion.interactions.link('journal_prompt_deliveries',delivery,'proactive_events',proof.event.privacy_artifact_id);
   return {status:'PROPOSED',deliveryId:delivery.delivery_id};
  },workStepOptions('stage7.proactive.prepare',[user.id,String(chatId),eventId],{discardResult:true,replay:async()=>{
   // A work receipt never serializes an actor, card or grant. Recover only the
   // canonical delivery handle under fresh actor/original-event authority.
   const actor=await companion.interactions.authenticate({user,chatId,initializeProfile:false}),proof=await original(actor,eventId);
   if(!proof)return {status:'UNSUPPORTED_OR_FENCED_QUESTION'};
   const previous=(await client.execute({sql:'SELECT delivery_id FROM journal_prompt_deliveries WHERE user_id=? AND semantic_key=?',args:[user.id,semantic(user.id,eventId)]})).rows[0];
   return previous?{status:'EXISTING',deliveryId:previous.delivery_id}:{status:'RECONCILIATION_REQUIRED'};
  }}));
 }
 return {prepare,authorized};
}
