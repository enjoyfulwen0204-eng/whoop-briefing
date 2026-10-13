import {createTelegramApi} from './bot/api.js';
import {SEND_OUTCOME} from './sendOutcome.js';
import {validMessageId} from './telegramAcknowledgment.js';
const copy={
 'zh-TW':{title:'已追蹤使用者的健康摘要',asof:'資料截至',association:'觀察性關聯，不代表因果。'},
 en:{title:'Followed user health summary',asof:'Data as of',association:'Observational association only; not causation.'},
 vi:{title:'Tóm tắt sức khỏe người được theo dõi',asof:'Dữ liệu tính đến',association:'Chỉ là mối liên hệ quan sát, không phải quan hệ nhân quả.'},
};
/** Server-owned provider boundary. A request cannot supply credentials,
 * transport, destination or claims. Only a freshly validated durable plan
 * reaches Telegram. An uncertain prior attempt permanently prevents resend. */
export function createStage8OwnerDispatcher({db,monitoring,env,enabled}){
 const api=createTelegramApi({botToken:env.telegramBotToken});
 async function dispatch(input,{subjectId,notificationClass}){
  if(!enabled())throw Error('OWNER_ROLLOUT_FENCED');
  const actor=await monitoring.authenticate(input),approved=await monitoring.authorize(actor,{subjectId,notificationClass});
  if(approved.status!=='APPROVED')return approved;
  const proposal=await monitoring.propose(actor,approved.ticket),messageId=proposal.messageId;
  if(proposal.status==='DELIVERY_STARTED'){
   const attempt=(await db.raw.execute({sql:"SELECT attempt_id FROM owner_monitoring_attempts WHERE user_id=? AND message_id=? AND state='DELIVERY_STARTED'",args:[subjectId,messageId]})).rows[0];
   if(!attempt)throw Error('OWNER_ATTEMPT_NOT_FOUND');
   await monitoring.settle({subjectId,messageId,attemptId:attempt.attempt_id,outcome:'AMBIGUOUS'});
   return {status:'AMBIGUOUS',messageId,recovered:true};
  }
  if(proposal.status!=='PROPOSED')return proposal;
  const initial=await monitoring.validate(actor,subjectId,messageId);
  const start=await monitoring.start(actor,{subjectId,messageId,expectedRevision:initial.row.revision});
  let outcome='FAILED_DEFINITE',providerMessageId=null,sendBegan=false;
  try{
   const fresh=await monitoring.validate(actor,subjectId,messageId);
   if(!enabled())throw Error('OWNER_ROLLOUT_FENCED');
   const resolved=await db.resolveUserByChatId(input.chatId);
   if(resolved?.user?.id!==actor.ownerId)throw Error('OWNER_DESTINATION_FENCED');
   const locale=await db.getLocale(actor.ownerId),c=copy[locale]??copy.en;
   const text=`${c.title}\n${fresh.payload.claims.map(claim=>claim.kind==='SOURCE_FACT_SUMMARY'?`${claim.metric}: ${claim.value}`:claim.claim+(claim.nonCausal?`\n${c.association}`:'')).join('\n')}\n${c.asof}: ${fresh.payload.asOfUtc}`;
   if(text.length>3800)throw Error('OWNER_PAYLOAD_BOUNDS');
   // Revalidate after all asynchronous wording/identity reads at the final boundary.
   await monitoring.validate(actor,subjectId,messageId);
   if(!enabled())throw Error('OWNER_ROLLOUT_FENCED');
   await db.assertRuntimeFences?.();sendBegan=true;
   const sent=await api.sendMessage(actor.chatId,{text});
   if(!validMessageId(sent?.message_id))throw Error('OWNER_ACK_INVALID');
   providerMessageId=String(sent.message_id);outcome='DELIVERED';
  }catch(error){outcome=!sendBegan||error?.sendOutcome===SEND_OUTCOME.DEFINITE_FAILURE?'FAILED_DEFINITE':'AMBIGUOUS';}
  await monitoring.settle({subjectId,messageId,attemptId:start.attemptId,outcome,providerMessageId});
  const durable=(await db.raw.execute({sql:'SELECT state FROM owner_monitoring_outbox WHERE user_id=? AND owner_id=? AND message_id=?',args:[subjectId,actor.ownerId,messageId]})).rows[0];
  return {status:durable.state,providerOutcome:outcome,messageId};
 }
 return Object.freeze({dispatch});
}
