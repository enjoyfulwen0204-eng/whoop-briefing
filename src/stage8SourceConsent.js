import {requireRuntimeAdmission,followRuntimeRenewal} from './runtimeAdmission.js';
import {OWNER_NOTIFICATION_CLASSES} from './phase4V34Schema.js';
import {canonicalJson} from './phase4EntityStore.js';
import {resolveRecipientName} from './recipientIdentity.js';

const fail=code=>{throw Object.assign(Error(code),{code});};
const VERSION='stage8-source-consent-v1';
const MAX_AGE_MS=15*60000;
const issued=new WeakMap();
export function requireStage8SourceConsent(value,{db,keys,ownerId}){
 const grant=issued.get(value);if(!grant||grant.client!==db.raw||grant.keys!==keys||grant.ownerId!==ownerId)fail('SOURCE_CONSENT_STORE_REQUIRED');
 return value;
}
/** Durable, non-health control metadata in the existing server KV store.
 * Opaque keys, signed heads/events, CAS, and retained revision/operation barriers
 * are separate from both owner follow preferences and expiring Settings state. */
export async function createStage8SourceConsent({db,keys,ownerId,enabled=()=>false,now=()=>new Date()}){
 if(typeof ownerId!=='string'||!ownerId||typeof enabled!=='function')fail('SOURCE_CONSENT_CONFIGURATION_REQUIRED');
 let admission=await db.admitRuntime();
 if(![34,35].includes(requireRuntimeAdmission(db.raw,admission,keys,db.transaction)))fail('SOURCE_CONSENT_V34_REQUIRED');
 followRuntimeRenewal(db.raw,admission,keys,db.transaction,next=>{admission=next;});
 const client=db.raw,stamp=()=>now().toISOString(),row=async(sql,args=[])=>(await client.execute({sql,args})).rows[0]??null;
 const fence=()=>requireRuntimeAdmission(client,admission,keys,db.transaction);
 const prefix=(uid,klass)=>'stage8-source-consent:v1:'+keys.lookup([VERSION,uid,ownerId,klass]);
 const signed=(tag,body)=>({...body,seal:keys.lookup([VERSION,tag,canonicalJson(body)])});
 function verified(tag,value){
  if(!value||typeof value!=='object')fail('SOURCE_CONSENT_INTEGRITY');
  const {seal,...body}=value;if(seal!==keys.lookup([VERSION,tag,canonicalJson(body)]))fail('SOURCE_CONSENT_INTEGRITY');return body;
 }
 const parse=raw=>{try{return JSON.parse(raw);}catch{fail('SOURCE_CONSENT_INTEGRITY');}};
 const classCheck=klass=>{if(!OWNER_NOTIFICATION_CLASSES.includes(klass))fail('SOURCE_CONSENT_CLASS_REQUIRED');};
 async function principal(uid){
  const value=await row(`SELECT u.status,u.lifecycle_generation,COALESCE(t.auth_generation,0) auth_generation,
   o.state,o.enrollment_revision,p.purge_generation,p.pending_purge_count
   FROM users u JOIN phase4_user_state p ON p.user_id=u.id LEFT JOIN user_whoop_tokens t ON t.user_id=u.id
   LEFT JOIN user_onboarding o ON o.user_id=u.id WHERE u.id=?`,[uid]);
  if(!value)return null;
  const bindings=(await client.execute({sql:"SELECT telegram_chat_id,linked_at FROM user_telegram WHERE user_id=? AND status='ACTIVE'",args:[uid]})).rows;
  if(bindings.length!==1||!/^\d+$/.test(String(bindings[0].telegram_chat_id)))return null;
  return {...value,profileRevision:await db.getProfileRevision(uid),destination:keys.lookup(['destination-binding-v1',uid,bindings[0].telegram_chat_id,bindings[0].linked_at])};
 }
 const ready=p=>Boolean(p&&p.status==='ACTIVE'&&p.auth_generation>0&&p.state==='READY'&&Number.isSafeInteger(p.enrollment_revision)&&p.pending_purge_count===0);
 async function authenticate(input){
  fence();const {user,chatId,callback}=input??{},chat=String(chatId);
  if(!/^\d+$/.test(chat)||!user?.id||user.id===ownerId)fail('SOURCE_CONSENT_SELF_ACTOR_REQUIRED');
  if(callback&&(String(callback.from?.id)!==chat||callback.from?.is_bot||callback.message?.chat?.type!=='private'||String(callback.message.chat.id)!==chat))fail('SOURCE_CONSENT_SELF_ACTOR_REQUIRED');
  const current=(await db.resolveUserByChatId(chat))?.user;
  if(!current||current.id!==user.id||current.status!=='ACTIVE'||current.lifecycleGeneration!==user.lifecycleGeneration)fail('SOURCE_CONSENT_SELF_ACTOR_REQUIRED');
  const source=await principal(current.id);if(!source||source.lifecycle_generation!==current.lifecycleGeneration)fail('SOURCE_CONSENT_SELF_ACTOR_REQUIRED');
  return {userId:current.id,source,recipient:await principal(ownerId)};
 }
 async function load(uid,klass){
  classCheck(klass);const base=prefix(uid,klass),raw=await db.getState(base+':head');if(raw===null)return {base,raw,record:null};
  const record=parse(raw),body=verified('record',record);
  if(body.version!==1||body.notificationClass!==klass||body.subject!==keys.lookup([VERSION,'subject',uid])||body.recipient!==keys.lookup([VERSION,'recipient',ownerId])
   ||!Number.isSafeInteger(body.revision)||body.revision<1||typeof body.enabled!=='boolean')fail('SOURCE_CONSENT_INTEGRITY');
  const audit=await db.getState(base+':revision:'+body.revision);
  if(audit!==raw||await db.getState(base+':revision:'+(body.revision+1))!==null)fail('SOURCE_CONSENT_INTEGRITY');
  return {base,raw,record};
 }
 function matches(record,source,recipient){return Boolean(enabled()&&record?.enabled&&ready(source)&&ready(recipient)
  &&canonicalJson(record.sourceAuthority)===canonicalJson(source)&&canonicalJson(record.recipientAuthority)===canonicalJson(recipient));}
 async function check(subjectId,notificationClass){return db.transaction(async()=>{
  fence();try{
   if(subjectId===ownerId)return null;
   const {record}=await load(subjectId,notificationClass),source=await principal(subjectId),recipient=await principal(ownerId);
   if(!matches(record,source,recipient))return null;
   fence();return Object.freeze({revision:record.revision,seal:record.seal});
  }catch(error){if(error?.code==='SOURCE_CONSENT_INTEGRITY')return null;throw error;}
 });}
 async function read(input){return db.transaction(async()=>{
  const actor=await authenticate(input),classes={};
  for(const klass of OWNER_NOTIFICATION_CLASSES){
   const {record}=await load(actor.userId,klass),revision=record?.revision??0;
   const authority=signed('display',{subject:keys.lookup([VERSION,'subject',actor.userId]),recipient:keys.lookup([VERSION,'recipient',ownerId]),notificationClass:klass,
    revision,sourceAuthority:actor.source,recipientAuthority:actor.recipient,expiresAt:now().getTime()+MAX_AGE_MS});
   classes[klass]={enabled:matches(record,actor.source,actor.recipient),revision,authority};
  }
  return {recipientLabel:await resolveRecipientName({db,userId:ownerId}),recipientAlias:keys.lookup([VERSION,'recipient-label',ownerId]).slice(0,8),canGrant:Boolean(enabled()&&ready(actor.source)&&ready(actor.recipient)),classes};
 });}
 async function update(input,{notificationClass,enabled:enable,expectedRevision,authority,operationKey}={}){
  classCheck(notificationClass);
  if(typeof enable!=='boolean'||!Number.isSafeInteger(expectedRevision)||expectedRevision<0||expectedRevision>=Number.MAX_SAFE_INTEGER
   ||typeof operationKey!=='string'||!operationKey||operationKey.length>128)fail('SOURCE_CONSENT_REQUEST_INVALID');
  return db.transaction(async()=>{
   const actor=await authenticate(input),{base,raw,record}=await load(actor.userId,notificationClass),display=verified('display',authority);
   if(display.expiresAt<=now().getTime()||display.expiresAt>now().getTime()+MAX_AGE_MS||display.notificationClass!==notificationClass||display.revision!==expectedRevision
    ||display.subject!==keys.lookup([VERSION,'subject',actor.userId])||display.recipient!==keys.lookup([VERSION,'recipient',ownerId])
    ||canonicalJson(display.sourceAuthority)!==canonicalJson(actor.source)||canonicalJson(display.recipientAuthority)!==canonicalJson(actor.recipient))fail('SOURCE_CONSENT_DISPLAY_FENCED');
   if(enable&&(!enabled()||!ready(actor.source)||!ready(actor.recipient)))fail('SOURCE_CONSENT_NOT_READY');
   const operation=keys.lookup([VERSION,'operation',actor.userId,ownerId,operationKey]),opKey='stage8-source-consent:operation:'+operation,prior=await db.getState(opKey);
   if(prior!==null){const replay=verified('operation',parse(prior));if(replay.notificationClass!==notificationClass||replay.enabled!==enable)fail('SOURCE_CONSENT_OPERATION_CONFLICT');return read(input);}
   if((record?.revision??0)!==expectedRevision)fail('SOURCE_CONSENT_CAS');
   const next=signed('record',{version:1,subject:display.subject,recipient:display.recipient,notificationClass,enabled:enable,revision:expectedRevision+1,
    sourceAuthority:actor.source,recipientAuthority:actor.recipient,previous:record?.seal??null,operation,changedAt:stamp()}),serialized=JSON.stringify(next);
   await client.execute({sql:'INSERT INTO telegram_state(key,value,updated_at) VALUES(?,?,?)',args:[base+':revision:'+next.revision,serialized,stamp()]});
   const changed=await client.execute({sql:`INSERT INTO telegram_state(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at WHERE telegram_state.value IS ?`,args:[base+':head',serialized,stamp(),raw]});
   if(changed.rowsAffected!==1)fail('SOURCE_CONSENT_CAS');
   const audit=signed('operation',{operation,notificationClass,enabled:enable,revision:next.revision,recordSeal:next.seal});
   await client.execute({sql:'INSERT INTO telegram_state(key,value,updated_at) VALUES(?,?,?)',args:[opKey,JSON.stringify(audit),stamp()]});
   // Revoke/regrant never revives an already prepared cross-user payload.
   await client.execute({sql:`UPDATE owner_monitoring_outbox SET state=CASE WHEN state='DELIVERY_STARTED' THEN 'AMBIGUOUS' ELSE 'SUPPRESSED' END,revision=revision+1,updated_at=?
    WHERE user_id=? AND owner_id=? AND notification_class=? AND state IN ('PROPOSED','FAILED_DEFINITE','DELIVERY_STARTED')`,args:[stamp(),actor.userId,ownerId,notificationClass]});
   // Consent is a source of the cross-user authorization. Correcting that
   // authority retracts copied health content while retaining delivery truth.
   for(const [table,fields] of [['owner_monitoring_authorizations',['claims_json','scope_json','as_of_utc']],['owner_monitoring_outbox',['payload_json']]])
    await client.execute({sql:`UPDATE ${table} SET ${fields.map(field=>field+'=NULL').join(',')},content_state='REDACTED',source_linkage_state='DISCONNECTED',content_digest_salt=NULL,
     health_content_redacted_at=?,health_content_redaction_reason='SOURCE_CORRECTED' WHERE user_id=? AND owner_id=? AND notification_class=? AND content_state<>'REDACTED'`,args:[stamp(),actor.userId,ownerId,notificationClass]});
   return read(input);
  });
 }
 const store=Object.freeze({read,update,check});issued.set(store,{client,keys,ownerId});return store;
}
