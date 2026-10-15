import {resolveRecipientName} from './recipientIdentity.js';
import {randomBytes} from 'node:crypto';
import {fail,readableRow} from './phase4Core.js';
import {addPrivacyLink} from './phase4V22Backfill.js';
import {localMidnightUtc,addDays} from './time.js';
import {journalCard,isJournalCallback} from './stage7Cards.js';
import {JOURNAL_COPY,JOURNAL_REGISTRY_VERSION,TOPICS,registryQuestion,presentationLocale,DAILY_ANSWER_WINDOW_MS} from './stage7Registry.js';

/** Internal server composition, default SHADOW only. Callbacks are opaque
 * random handles resolved under tenant, lifecycle, auth, timezone and revision. */
export function createStage7InteractionStore({core,db,answerWindowMs=DAILY_ANSWER_WINDOW_MS}){
 if(![33,34,35].includes(core.schemaVersion)||!Number.isSafeInteger(answerWindowMs)||answerWindowMs<3600000||answerWindowMs>7*86400000)fail('STAGE7_V33_CONFIG_REQUIRED');
 const {client,keys,timestamp,transaction}=core;
 const hash=token=>keys.lookup(['stage7-callback',token]);
 async function authenticate({user,chatId,callback=null,allowPendingPurge=false}){
  const chat=String(chatId);
  if(!/^\d+$/.test(chat))fail('STAGE7_PRIVATE_ACTOR_REQUIRED');
  if(callback&&(typeof callback.id!=='string'||callback.id.length<1||callback.id.length>128||String(callback.from?.id)!==chat||callback.from?.is_bot||callback.message?.chat?.type!=='private'||String(callback.message.chat.id)!==chat))fail('STAGE7_PRIVATE_ACTOR_REQUIRED');
  const result=await db.resolveUserByChatId(chat),current=result?.user??result;
  if(!current||current.id!==user?.id||current.lifecycleGeneration!==user.lifecycleGeneration)fail('STAGE7_ACTOR_FENCED');
  const control=await core.captureControl(current.id),state=await core.assertControl(control);
  if(state.pending_purge_count!==0&&!allowPendingPurge)fail('PHASE4_PURGE_FENCED');
  return {control,state,user:current,chat,profileRevision:await db.getProfileRevision(current.id)};
 }
 const privacyFields=state=>({privacy_artifact_id:core.newId(),content_state:'PRESENT',source_linkage_state:'COMPLETE',content_digest_salt:keys.newSalt(),purge_generation:state.purge_generation});
 async function link(table,row,sourceType='USER',sourceId=row.user_id){
  // A copied confirmed delivery receipt is shared presentation provenance.
  // This edge never promotes a SHADOW computation or relaxes semantic reads.
  await addPrivacyLink(client,{userId:row.user_id,mode:sourceType==='outbound_messages'?'SHARED':row.execution_mode??'SHARED',table,artifactId:row.privacy_artifact_id,sourceType,sourceId,sourceMode:sourceType==='outbound_messages'?'LIVE':['quick_action_interactions','journal_prompt_deliveries','evidence_items'].includes(sourceType)?'SHADOW':'SHARED',at:timestamp()});
 }
 async function insert(table,row){const fields=Object.keys(row);await client.execute({sql:`INSERT INTO ${table}(${fields.join(',')}) VALUES(${fields.map(()=>'?').join(',')})`,args:fields.map(k=>row[k])});}
 async function read(uid,id){return (await client.execute({sql:'SELECT * FROM quick_action_interactions WHERE user_id=? AND interaction_id=?',args:[uid,id]})).rows[0]??null;}
 async function issue(actor,{kind='QUICK',semanticKey=core.newId(),category=null,targetDate=null,reason=null,diagnostics=null,dayKey=null,recordedTimezone=null}={}){
  return transaction(async()=>{
   const state=await core.assertControl(actor.control);
   if(state.pending_purge_count!==0||state.timezone!==actor.state.timezone||await db.getProfileRevision(actor.control.userId)!==actor.profileRevision)fail('STAGE7_STATE_FENCED');
   const previous=(await client.execute({sql:'SELECT * FROM quick_action_interactions WHERE user_id=? AND semantic_key=?',args:[actor.control.userId,semanticKey]})).rows[0];
   if(previous)return {row:previous,created:false};
   if(category!==null&&!TOPICS.includes(category))fail('STAGE7_UNREGISTERED_QUESTION');
   const targetTimezone=recordedTimezone??state.timezone;
   if(recordedTimezone!==null){if(kind!=='QUICK')fail('STAGE7_TARGET_TIMEZONE_REQUIRED');new Intl.DateTimeFormat('en',{timeZone:targetTimezone}).format();diagnostics={...diagnostics,recordedTimezone:targetTimezone};}
   diagnostics={...diagnostics,profileRevision:actor.profileRevision};
   await client.execute({sql:'DELETE FROM journal_callback_tokens WHERE user_id=? AND expires_at<=?',args:[actor.control.userId,timestamp()]});
   const at=timestamp(),expiry=new Date(Date.parse(at)+(kind==='DAILY'?answerWindowMs:15*60000)).toISOString();
   const row={user_id:actor.control.userId,interaction_id:core.newId(),execution_mode:'SHADOW',semantic_key:semanticKey,day_key:dayKey,kind,
    registry_id:category?registryQuestion(category):null,registry_version:JOURNAL_REGISTRY_VERSION,question_identity:category?registryQuestion(category):null,
    category,target_date:targetDate,timezone:state.timezone,
    window_start:targetDate?localMidnightUtc(targetDate,targetTimezone).toISOString():null,
    window_end:targetDate?localMidnightUtc(addDays(targetDate,1),targetTimezone).toISOString():null,
    selection_reason:reason,diagnostics_json:diagnostics?JSON.stringify(diagnostics):null,state:'ISSUED',revision:0,
    lifecycle_generation:state.lifecycle_generation,auth_generation:state.auth_generation,chat_id:actor.chat,created_at:at,expires_at:expiry,...privacyFields(state)};
   await insert('quick_action_interactions',row);await link('quick_action_interactions',row);return {row:await read(row.user_id,row.interaction_id),created:true};
  });
 }
 async function render(actor,row,preferences=null){
  const state=await core.assertControl(actor.control);
  if(row.user_id!==actor.control.userId||row.chat_id!==actor.chat||state.pending_purge_count!==0||!readableRow(row)||row.lifecycle_generation!==state.lifecycle_generation||row.auth_generation!==state.auth_generation||row.timezone!==state.timezone
   ||JSON.parse(row.diagnostics_json??'null')?.profileRevision!==await db.getProfileRevision(actor.control.userId))fail('STAGE7_STATE_FENCED');
  const locale=await db.getLocale(row.user_id),card=journalCard(row,{locale,displayName:[34,35].includes(core.schemaVersion)?await resolveRecipientName({db,userId:row.user_id}):actor.user.displayName,preferences});
  const keyboard=[];
  for(const buttons of card.buttons){const list=[];for(const button of buttons){
   const token=randomBytes(24).toString('base64url');
   await insert('journal_callback_tokens',{user_id:row.user_id,token_hash:hash(token),interaction_id:row.interaction_id,revision:row.revision,action:button.action,created_at:timestamp(),expires_at:row.expires_at});
   list.push({text:button.label,callback_data:'j7:'+token});
  }keyboard.push(list);}
  return {text:card.text,replyMarkup:{inline_keyboard:keyboard},...(row.message_id?{editMessageId:row.message_id}:{}),stage7InteractionId:row.interaction_id,stage7Revision:row.revision};
 }
 async function resolve(actor,callback,{recovery=false}={}){
  if(!isJournalCallback(callback?.data))return null;
  const token=(await client.execute({sql:'SELECT * FROM journal_callback_tokens WHERE user_id=? AND token_hash=?',args:[actor.control.userId,hash(callback.data.slice(3))]})).rows[0];
  if(!token||token.expires_at<=timestamp())return null;
  const row=await read(actor.control.userId,token.interaction_id),state=await core.assertControl(actor.control);
  if(!readableRow(row)||row.revision!==token.revision||row.expires_at<=timestamp()||row.chat_id!==actor.chat||!row.message_id
   ||String(callback.message?.message_id)!==row.message_id||row.lifecycle_generation!==state.lifecycle_generation||row.auth_generation!==state.auth_generation
   ||row.timezone!==state.timezone||JSON.parse(row.diagnostics_json??'null')?.profileRevision!==await db.getProfileRevision(actor.control.userId)
   ||state.pending_purge_count!==0&&!(recovery&&row.correction_key===hash(callback.id))||row.registry_version!==JOURNAL_REGISTRY_VERSION)return null;
  const anchor=JSON.parse(row.diagnostics_json??'null')?.answerAnchor;
  if(anchor&&!row.logical_fact_id){const origin=await read(row.user_id,anchor.id);if(!readableRow(origin)||origin.revision!==anchor.revision||origin.kind==='DAILY'&&origin.state==='ISSUED'&&origin.expires_at<=timestamp())return null;}
  return {row,action:token.action,receipt:hash(callback.id)};
 }
 async function update(actor,row,patch){
  const state=await core.assertControl(actor.control);
  if(row.user_id!==actor.control.userId||row.chat_id!==actor.chat||row.lifecycle_generation!==state.lifecycle_generation||row.auth_generation!==state.auth_generation||await db.getProfileRevision(actor.control.userId)!==actor.profileRevision)fail('STAGE7_ACTOR_FENCED');
  const fields=Object.keys(patch),changed=await client.execute({sql:`UPDATE quick_action_interactions SET ${fields.map(k=>`${k}=?`).join(',')}${fields.length?',':''}revision=revision+1 WHERE user_id=? AND interaction_id=? AND revision=?`,args:[...fields.map(k=>patch[k]),row.user_id,row.interaction_id,row.revision]});
  if(changed.rowsAffected!==1)fail('STAGE7_CAS_LOST');return read(row.user_id,row.interaction_id);
 }
 async function completeMissing(actor,row,choice){
  return transaction(async()=>{
   const state=await core.assertControl(actor.control),diagnostics=JSON.parse(row.diagnostics_json??'null'),anchor=diagnostics?.answerAnchor;
   if(!['NOT_SURE','SKIPPED'].includes(choice)||row.logical_fact_id||!['ISSUED','EDITING'].includes(row.state)||!readableRow(row)
    ||!TOPICS.includes(row.category)||row.registry_id!==registryQuestion(row.category)||row.registry_version!==JOURNAL_REGISTRY_VERSION
    ||row.question_identity!==registryQuestion(row.category)||row.timezone!==state.timezone||row.expires_at<=timestamp()
    ||diagnostics?.profileRevision!==actor.profileRevision)fail('STAGE7_REGISTRY_AUTHORITY_INVALID');
   const at=timestamp();let nextDiagnostics=diagnostics;
   if(anchor){
    const origin=await read(actor.control.userId,anchor.id);
    if(!readableRow(origin)||origin.logical_fact_id||origin.revision!==anchor.revision||!['ISSUED','NOT_SURE','SKIPPED'].includes(origin.state)
     ||['category','registry_id','registry_version','question_identity','target_date','window_start','window_end'].some(k=>origin[k]!==row[k])
     ||origin.kind==='DAILY'&&origin.state==='ISSUED'&&origin.expires_at<=at)fail('STAGE7_QUESTION_SEMANTIC_RESERVED');
    // A renewed capability owns the original answer identity. Its own card
    // remains editable; all concurrent/older aliases retain the stale revision.
    const changed=await client.execute({sql:"UPDATE quick_action_interactions SET state=?,selected_choice=?,detail_choice=NULL,note=NULL,answered_at=?,revision=revision+1 WHERE user_id=? AND interaction_id=? AND revision=?",args:[choice,choice,at,row.user_id,origin.interaction_id,origin.revision]});
    if(changed.rowsAffected!==1)fail('STAGE7_CAS_LOST');
    nextDiagnostics={...diagnostics,answerAnchor:{id:origin.interaction_id,revision:origin.revision+1}};
   }
   // This and the original answer CAS commit or roll back together. Explicit
   // missingness is never a Journal fact or a negative exposure observation.
   return update(actor,row,{state:choice,selected_choice:choice,detail_choice:null,note:null,answered_at:at,diagnostics_json:JSON.stringify(nextDiagnostics)});
  });
 }
 async function bind(actor,id,messageId){
  if(!/^\d+$/.test(String(messageId)))fail('STAGE7_MESSAGE_ID_REQUIRED');
  return transaction(async()=>{
   await core.assertControl(actor.control);const row=await read(actor.control.userId,id);
   if(!row||row.chat_id!==actor.chat||row.lifecycle_generation!==actor.state.lifecycle_generation||row.auth_generation!==actor.state.auth_generation)fail('STAGE7_ACTOR_FENCED');
   if(row.message_id&&row.message_id!==String(messageId))fail('STAGE7_MESSAGE_BINDING_CONFLICT');
   await client.execute({sql:'UPDATE quick_action_interactions SET message_id=? WHERE user_id=? AND interaction_id=? AND message_id IS NULL',args:[String(messageId),row.user_id,id]});
  });
 }
 async function expired(actor){return {text:JOURNAL_COPY[presentationLocale(await db.getLocale(actor.control.userId))].expired};}
 async function button(actor,row,b){
  const token=randomBytes(24).toString('base64url');
  await insert('journal_callback_tokens',{user_id:row.user_id,token_hash:hash(token),interaction_id:row.interaction_id,revision:row.revision,action:b.action,created_at:timestamp(),expires_at:row.expires_at});
  return {text:b.text,callback_data:'j7:'+token};
 }
 return {authenticate,issue,render,resolve,read,update,completeMissing,bind,expired,link,insert,privacyFields,button,answerWindowMs};
}
