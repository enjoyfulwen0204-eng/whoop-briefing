import {fail,readableRow} from './phase4Core.js';
const synthetic=new WeakSet();
/** No function/URL/token/provider supplied by caller is executed. */
export function createSyntheticJournalTelegram({outcomes=[]}={}){
 const calls=[],queue=[...outcomes];let sequence=700;
 const provider=Object.freeze({calls,async send(card){
  calls.push(structuredClone(card));const result=queue.shift()??'DELIVERED';
  if(result==='FAILED_DEFINITE')throw Object.assign(Error('SYNTHETIC_NON_ACCEPTANCE'),{definite:true});
  if(result==='AMBIGUOUS')throw Error('SYNTHETIC_TIMEOUT');
  if(result==='MALFORMED')return {};
  return {messageId:String(++sequence)};
 }});synthetic.add(provider);return provider;
}
export function createStage7Dispatcher({core,db,companion,provider}){
 if(!synthetic.has(provider))fail('STAGE7_FAKE_PROVIDER_REQUIRED');
 const {client,transaction,timestamp}=core;
 async function dispatch({user,chatId,deliveryId}){
  const started=await transaction(async()=>{
   const actor=await companion.interactions.authenticate({user,chatId}),row=(await client.execute({sql:'SELECT * FROM journal_prompt_deliveries WHERE user_id=? AND delivery_id=?',args:[user.id,deliveryId]})).rows[0];
   if(!row)return {status:'NOT_FOUND'};
   if(['DELIVERED','AMBIGUOUS','DELIVERY_STARTED','SUPPRESSED'].includes(row.state))return {status:row.state};
   if(row.attempt_count>=3)return {status:'RETRY_EXHAUSTED'};
   const prefs=await companion.preferences(actor),interaction=row.interaction_id?await companion.interactions.read(user.id,row.interaction_id):null;
   const paused=(await client.execute({sql:'SELECT notifications_paused FROM user_notification_preferences WHERE user_id=?',args:[user.id]})).rows[0];
   const valid=readableRow(row)&&row.lifecycle_generation===actor.state.lifecycle_generation&&row.auth_generation===actor.state.auth_generation
    &&row.chat_id===actor.chat&&row.expires_at>timestamp()&&prefs.revision===row.preference_revision&&!paused?.notifications_paused
    &&(row.kind==='DAILY'?prefs.daily_enabled&&readableRow(interaction)&&interaction.timezone===actor.state.timezone:false);
   const occupied=(await client.execute({sql:"SELECT 1 FROM pending_questions WHERE user_id=? AND status='OPEN' UNION ALL SELECT 1 FROM phase4_question_interaction_slots WHERE user_id=? AND state IN ('RESERVED','DELIVERY_STARTED','AMBIGUOUS_WAIT','AWAITING_ANSWER')",args:[user.id,user.id]})).rows.length;
   // Weekly automatic rollout is intentionally unavailable. Preference is not rollout authority.
   if(!valid||occupied){await client.execute({sql:"UPDATE journal_prompt_deliveries SET state='SUPPRESSED',revision=revision+1,updated_at=? WHERE user_id=? AND delivery_id=?",args:[timestamp(),user.id,deliveryId]});return {status:'SUPPRESSED'};}
   const at=timestamp(),attemptId=core.newId(),attemptNumber=row.attempt_count+1;
   await client.execute({sql:"UPDATE journal_prompt_deliveries SET state='DELIVERY_STARTED',attempt_count=?,revision=revision+1,updated_at=? WHERE user_id=? AND delivery_id=? AND revision=? AND state IN ('PROPOSED','FAILED_DEFINITE')",args:[attemptNumber,at,user.id,deliveryId,row.revision]});
   await companion.interactions.insert('journal_delivery_attempts',{user_id:user.id,delivery_id:deliveryId,attempt_id:attemptId,attempt_number:attemptNumber,state:'DELIVERY_STARTED',started_at:at});
   // Refresh presentation from the current canonical locale without changing answer semantics.
   const card=await companion.card(actor,interaction);
   return {status:'STARTED',actor,attemptId,card,interactionId:row.interaction_id};
  });
  if(started.status!=='STARTED')return started;
  let state,messageId=null;
  try{const result=await provider.send({...started.card,chatId:String(chatId)});if(!/^\d+$/.test(result?.messageId??''))state='AMBIGUOUS';else{state='DELIVERED';messageId=result.messageId;}}
  catch(error){state=error?.definite===true?'FAILED_DEFINITE':'AMBIGUOUS';}
  await transaction(async()=>{
   // Settlement retains provider truth even if account/content changed after start.
   await core.assertPrivacyControl(started.actor.control);
   await client.execute({sql:"UPDATE journal_delivery_attempts SET state=?,settled_at=?,message_id=? WHERE user_id=? AND attempt_id=? AND state='DELIVERY_STARTED'",args:[state,timestamp(),messageId,user.id,started.attemptId]});
   await client.execute({sql:"UPDATE journal_prompt_deliveries SET state=?,message_id=?,revision=revision+1,updated_at=? WHERE user_id=? AND delivery_id=? AND state='DELIVERY_STARTED'",args:[state,messageId,timestamp(),user.id,deliveryId]});
   if(state==='DELIVERED'){try{await companion.interactions.bind(started.actor,started.interactionId,messageId);}catch{/* no health read or resend after lifecycle transition */}}
  });
  return {status:state,messageId};
 }
 async function recover({user,chatId,deliveryId}){
  return transaction(async()=>{
   const actor=await companion.interactions.authenticate({user,chatId}),userId=actor.control.userId;
   await client.execute({sql:"UPDATE journal_delivery_attempts SET state='AMBIGUOUS',settled_at=? WHERE user_id=? AND delivery_id=? AND state='DELIVERY_STARTED'",args:[timestamp(),userId,deliveryId]});
   await client.execute({sql:"UPDATE journal_prompt_deliveries SET state='AMBIGUOUS',revision=revision+1,updated_at=? WHERE user_id=? AND delivery_id=? AND state='DELIVERY_STARTED'",args:[timestamp(),userId,deliveryId]});
   return {status:'AMBIGUOUS'};
  });
 }
 return {dispatch,recover};
}

/** Existing Phase 4 outbox/slots/attempts remain canonical for episode sends.
 * The only accepted adapter here is the closed synthetic implementation. */
export async function createStage7Phase4Dispatcher({core,stores,db,provider}){
 const files=(await core.client.execute('PRAGMA database_list')).rows;
 if(!synthetic.has(provider)||core.client.protocol!=='file'||files.some(r=>r.file!==''||!['main','temp'].includes(r.name)))fail('STAGE7_FAKE_PROVIDER_REQUIRED');
 async function dispatch({context,messageId,slotRevision=null}){
  const control=await stores.captureControl(context.userId);
  const current=(await core.client.execute({sql:'SELECT state,revision FROM outbound_messages WHERE user_id=? AND execution_mode=? AND message_id=?',args:[context.userId,context.executionMode,messageId]})).rows[0];
  if(!current)return {state:'NOT_FOUND'};
  if(['DELIVERY_STARTED','AMBIGUOUS','DELIVERED','SUPPRESSED','INVALIDATED','FAILED_TERMINAL'].includes(current.state))return {state:current.state};
  if(current.state==='PROPOSED')await stores.transport.makeEligible(context,{messageId,expectedRevision:current.revision});
  const lease=await stores.transport.claim(context,{messageId,owner:'stage7-synthetic-dispatcher'});if(!lease)return {state:'UNCLAIMED'};
  const attempt=await stores.transport.start(context,lease,{slotRevision});
  let outcome,providerMessageId=null;
  try{const result=await provider.send({text:attempt.payloadText,payloadJson:attempt.payloadJson,destinationBindingId:attempt.destinationBindingId});if(/^\d+$/.test(result?.messageId??'')){outcome='DELIVERED';providerMessageId=result.messageId;}else outcome='AMBIGUOUS';}
  catch(error){outcome=error?.definite===true?'FAILED_DEFINITE':'AMBIGUOUS';}
  return stores.transport.settle(control,context.executionMode,{attemptId:attempt.attemptId,outcome,
   ...(providerMessageId?{providerMessageId}:{}),...(outcome==='AMBIGUOUS'?{ambiguityReason:'UNKNOWN_ACCEPTANCE'}:{}),...(outcome==='FAILED_DEFINITE'?{errorCode:'PROVIDER_DEFINITE_NON_ACCEPTANCE'}:{})});
 }
 return {dispatch};
}
