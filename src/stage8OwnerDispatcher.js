import {OWNER_MAX_ATTEMPTS,ownerRetryAt} from './stage8OwnerMonitoring.js';
import {createTelegramApi} from './bot/api.js';
import {SEND_OUTCOME} from './sendOutcome.js';
import {validMessageId} from './telegramAcknowledgment.js';
import {stage8AssociationProjection} from './stage8DerivedReader.js';
import {labelForCategory} from './journal.js';
import {t,localizedDisplay} from './localization.js';
import {readStage8RecipientQuietHours,stage8RecipientIsQuiet,sendStage8RecipientNotification} from './stage8NotificationQuietHours.js';
const copy={
 'zh-TW':{title:'已追蹤使用者的健康摘要',asof:'資料截至',association:'觀察性關聯，不代表因果。',associationClaim:'{factor}與{metric}{direction}在已追蹤使用者的資料中多次呈現關聯。'},
 en:{title:'Followed user health summary',asof:'Data as of',association:'Observational association only; not causation.',associationClaim:'Repeated associations in the followed user’s data: {factor} and {direction} {metric}.'},
 vi:{title:'Tóm tắt sức khỏe người được theo dõi',asof:'Dữ liệu tính đến',association:'Chỉ là mối liên hệ quan sát, không phải quan hệ nhân quả.',associationClaim:'Dữ liệu của người được theo dõi nhiều lần cho thấy {factor} có liên quan đến {metric} {direction}.'},
};
const dailyMetrics=Object.freeze({sleep:'sleep_duration_minutes',recovery:'recovery_score',load:'cycle_strain'});
/** Pure presentation only. The dispatcher still requires the same freshly
 * validated durable authorization; this formatter never grants send authority
 * or rewrites canonical claims. Unsupported claims have no raw-text fallback. */
export function renderStage8OwnerPayload(payload,requestedLocale){
 const locale=Object.hasOwn(copy,requestedLocale)?requestedLocale:'en',c=copy[locale];
 const fail=()=>{throw Error('OWNER_CLAIM_UNRENDERABLE');};
 if(!Array.isArray(payload?.claims)||!payload.claims.length||payload.claims.length>3
  ||typeof payload.asOfUtc!=='string'||!Number.isFinite(Date.parse(payload.asOfUtc)))fail();
 const lines=payload.claims.map(claim=>{
  if(payload.notificationClass==='DAILY_SUMMARY'&&claim?.kind==='SOURCE_FACT_SUMMARY'){
   if(!Object.hasOwn(dailyMetrics,claim.metric)||typeof claim.value!=='string'||!claim.value.trim())fail();
   return `${t(locale,`metric.${dailyMetrics[claim.metric]}`)}: ${localizedDisplay(locale,claim.value)}`;
  }
  if(payload.notificationClass==='WEEKLY_SUMMARY'&&claim?.kind==='OBSERVATIONAL_ASSOCIATION'){
   if(typeof claim.claim!=='string'||claim.nonCausal!==true)fail();
   const association=stage8AssociationProjection(claim.claim);if(!association)fail();
   const values={factor:labelForCategory(association.factor,locale),
    metric:t(locale,association.metricKey==='respiratory_rate'?'qa.metric.respiratory_rate':`metric.${association.metricKey}`),
    direction:t(locale,`beta.direction${association.direction==='HIGHER'?'Higher':'Lower'}`)};
   return c.associationClaim.replace(/\{(factor|metric|direction)\}/g,(_,key)=>values[key])+`\n${c.association}`;
  }
  // IMPORTANT retains the exact source-approved alert text. Translating that
  // signed copy requires a separate typed alert presentation contract.
  if(payload.notificationClass==='IMPORTANT_ALERT'&&claim?.kind==='APPROVED_IMPORTANT_ALERT'
   &&typeof claim.claim==='string'&&claim.claim.trim())return claim.claim;
  fail();
 });
 return `${c.title}\n${lines.join('\n')}\n${c.asof}: ${payload.asOfUtc}`;
}
/** Server-owned provider boundary. A request cannot supply credentials,
 * transport, destination or claims. Only a freshly validated durable plan
 * reaches Telegram. An uncertain prior attempt permanently prevents resend. */
export function createStage8OwnerDispatcher({db,monitoring,env,enabled,now=()=>new Date()}){
 const api=createTelegramApi({botToken:env.telegramBotToken});
 async function dispatch(input,{subjectId,notificationClass}){
  if(!enabled())throw Error('OWNER_ROLLOUT_FENCED');
  const actor=await monitoring.authenticate(input),pending=await monitoring.pending(actor,subjectId,notificationClass);
  // Recover an already-started unknown send even during quiet hours. This is
  // settlement of provider truth, never another network request.
  if(pending?.state==='DELIVERY_STARTED'){
   const attempt=(await db.raw.execute({sql:"SELECT attempt_id FROM owner_monitoring_attempts WHERE user_id=? AND message_id=? AND state='DELIVERY_STARTED'",args:[subjectId,pending.message_id]})).rows[0];
   if(!attempt)throw Error('OWNER_ATTEMPT_NOT_FOUND');
   await monitoring.settle({subjectId,messageId:pending.message_id,attemptId:attempt.attempt_id,outcome:'AMBIGUOUS'});
   return {status:'AMBIGUOUS',messageId:pending.message_id,recovered:true};
  }
  if(stage8RecipientIsQuiet(await readStage8RecipientQuietHours(db,actor.ownerId),now()))return {status:'QUIET_HOURS',messageId:pending?.message_id??null};
  let proposal=pending?{status:pending.state,messageId:pending.message_id}:null;
  if(!proposal){const approved=await monitoring.authorize(actor,{subjectId,notificationClass});if(approved.status!=='APPROVED')return approved;proposal=await monitoring.propose(actor,approved.ticket);}
  const messageId=proposal.messageId;
  if(proposal.status==='DELIVERY_STARTED'){
   const attempt=(await db.raw.execute({sql:"SELECT attempt_id FROM owner_monitoring_attempts WHERE user_id=? AND message_id=? AND state='DELIVERY_STARTED'",args:[subjectId,messageId]})).rows[0];
   if(!attempt)throw Error('OWNER_ATTEMPT_NOT_FOUND');
   await monitoring.settle({subjectId,messageId,attemptId:attempt.attempt_id,outcome:'AMBIGUOUS'});
   return {status:'AMBIGUOUS',messageId,recovered:true};
  }
  if(!['PROPOSED','FAILED_DEFINITE'].includes(proposal.status))return proposal;
  if(pending&&(pending.expires_at<=now().toISOString()||pending.attempt_count>=OWNER_MAX_ATTEMPTS))return monitoring.close(actor,subjectId,messageId);
  if(pending?.state==='FAILED_DEFINITE'&&now().getTime()<ownerRetryAt(pending))return {status:'FAILED_DEFINITE',messageId,nextAttemptAt:new Date(ownerRetryAt(pending)).toISOString()};
  let initial;try{initial=await monitoring.validate(actor,subjectId,messageId);}catch(error){await monitoring.close(actor,subjectId,messageId);return {status:'SUPPRESSED',messageId,reason:'AUTHORITY_CHANGED'};}
  if(stage8RecipientIsQuiet(await readStage8RecipientQuietHours(db,actor.ownerId),now()))return {status:'QUIET_HOURS',messageId};
  const start=await monitoring.start(actor,{subjectId,messageId,expectedRevision:initial.row.revision});
  let outcome='FAILED_DEFINITE',providerMessageId=null,sendBegan=false;
  try{
   const fresh=await monitoring.validate(actor,subjectId,messageId);
   if(!enabled())throw Error('OWNER_ROLLOUT_FENCED');
   const resolved=await db.resolveUserByChatId(input.chatId);
   if(resolved?.user?.id!==actor.ownerId)throw Error('OWNER_DESTINATION_FENCED');
   const locale=await db.getLocale(actor.ownerId);
   const text=renderStage8OwnerPayload(fresh.payload,locale);
   if(text.length>3800)throw Error('OWNER_PAYLOAD_BOUNDS');
   // Revalidate after all asynchronous wording/identity reads at the final boundary.
   await monitoring.validate(actor,subjectId,messageId);
   if(!enabled())throw Error('OWNER_ROLLOUT_FENCED');
   await db.assertRuntimeFences?.();
   // Runtime admission may yield; source withdrawal during that wait must
   // invalidate this copy before any provider request begins.
   const sent=await sendStage8RecipientNotification({db,userId:actor.ownerId,now,verify:async()=>{
    await monitoring.validate(actor,subjectId,messageId);
    if(!enabled())throw Error('OWNER_ROLLOUT_FENCED');
   },send:()=>{if(!enabled())throw Error('OWNER_ROLLOUT_FENCED');sendBegan=true;return api.sendMessage(actor.chatId,{text});}});
   if(!validMessageId(sent?.message_id))throw Error('OWNER_ACK_INVALID');
   providerMessageId=String(sent.message_id);outcome='DELIVERED';
  }catch(error){outcome=!sendBegan||error?.sendOutcome===SEND_OUTCOME.DEFINITE_FAILURE?'FAILED_DEFINITE':'AMBIGUOUS';}
  await monitoring.settle({subjectId,messageId,attemptId:start.attemptId,outcome,providerMessageId});
  const durable=(await db.raw.execute({sql:'SELECT state FROM owner_monitoring_outbox WHERE user_id=? AND owner_id=? AND message_id=?',args:[subjectId,actor.ownerId,messageId]})).rows[0];
  return {status:durable.state,providerOutcome:outcome,messageId};
 }
 return Object.freeze({dispatch});
}
