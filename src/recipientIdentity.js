import {advanceProfileRevision} from './profileRevision.js';
import {isVerifiedWhoopProfile} from './whoop.js';
import {requireRuntimeAdmission} from './runtimeAdmission.js';
import {addPrivacyLink} from './phase4V22Backfill.js';
import {normalizeSettingsName} from './bot/settings.js';
/** Unproven legacy display_name never supplies an identity fallback. */
export async function resolveRecipientName({db,userId}){
 const user=await db.getUser(userId);if(!user||user.id!==userId||user.status!=='ACTIVE')return '';
 const rows=(await db.raw.execute({sql:"SELECT * FROM recipient_identity_sources WHERE user_id=? AND content_state='PRESENT' AND source_linkage_state='COMPLETE' AND health_content_redacted_at IS NULL ORDER BY revision DESC LIMIT 1",args:[userId]})).rows;
 const source=rows[0];if(!source)return '';
 const safe=value=>{try{return normalizeSettingsName(value);}catch{return '';}};
 if(source.explicit_name_revision!==null&&source.explicit_display_name===user.displayName){const name=safe(user.displayName);if(name)return name;}
 const binding=(await db.raw.execute({sql:"SELECT telegram_chat_id,linked_at FROM user_telegram WHERE user_id=? AND status='ACTIVE'",args:[userId]})).rows;
 if(binding.length===1&&source.telegram_binding===JSON.stringify([binding[0].telegram_chat_id,binding[0].linked_at])){const name=safe(source.telegram_first_name);if(name)return name;}
 const token=await db.getTokens(userId);if(token?.authGeneration===source.whoop_auth){const name=safe(source.whoop_first_name);if(name)return name;}
 return '';
}
export async function createRecipientIdentity({db,keys,now=()=>new Date()}){
 const admission=await db.admitRuntime();if(requireRuntimeAdmission(db.raw,admission,keys,db.transaction)!==34)throw Error('RECIPIENT_V34_REQUIRED');
 async function recordExplicit({user,chatId,name}){return db.transaction(async()=>{
  const canonical=(await db.resolveUserByChatId(chatId))?.user;if(canonical?.id!==user?.id||canonical.lifecycleGeneration!==user.lifecycleGeneration||canonical.displayName!==normalizeSettingsName(name))throw Error('RECIPIENT_ACTOR_CHANGED');
  const state=(await db.raw.execute({sql:'SELECT purge_generation,pending_purge_count FROM phase4_user_state WHERE user_id=?',args:[user.id]})).rows[0];if(!state||state.pending_purge_count)throw Error('RECIPIENT_PRIVACY_FENCED');
  const profile=await db.getProfileRevision(user.id),revision=Number((await db.raw.execute({sql:'SELECT COALESCE(MAX(revision),0)+1 n FROM recipient_identity_sources WHERE user_id=?',args:[user.id]})).rows[0].n),artifact=keys.lookup(['recipient-identity-v1',user.id,revision]);
  await db.raw.execute({sql:`INSERT INTO recipient_identity_sources(user_id,explicit_name_revision,explicit_display_name,revision,updated_at,content_state,source_linkage_state,content_digest_salt,purge_generation,privacy_artifact_id) VALUES(?,?,?,?,?,'PRESENT','COMPLETE',?,?,?)`,args:[user.id,profile,name,revision,now().toISOString(),keys.newSalt(),state.purge_generation,artifact]});
  await addPrivacyLink(db.raw,{userId:user.id,mode:'SHARED',table:'recipient_identity_sources',artifactId:artifact,sourceType:'USER',sourceId:user.id,sourceMode:'SHARED',at:now().toISOString()});
 });}
 async function capture(user,patch){return db.transaction(async()=>{
  const current=await db.getUser(user?.id);if(!current||current.status!=='ACTIVE'||current.lifecycleGeneration!==user.lifecycleGeneration)throw Error('RECIPIENT_ACTOR_CHANGED');
  const state=(await db.raw.execute({sql:'SELECT purge_generation,pending_purge_count FROM phase4_user_state WHERE user_id=?',args:[current.id]})).rows[0];if(!state||state.pending_purge_count)throw Error('RECIPIENT_PRIVACY_FENCED');
  const prior=(await db.raw.execute({sql:"SELECT * FROM recipient_identity_sources WHERE user_id=? AND content_state='PRESENT' ORDER BY revision DESC LIMIT 1",args:[current.id]})).rows[0]??{};
  const fields=['explicit_name_revision','explicit_display_name','telegram_first_name','telegram_binding','whoop_first_name','whoop_auth'];
  const values=Object.fromEntries(fields.map(k=>[k,prior[k]??null]));Object.assign(values,patch);
  if(fields.every(k=>values[k]===(prior[k]??null)))return {changed:false};
  const revision=Number((await db.raw.execute({sql:'SELECT COALESCE(MAX(revision),0)+1 n FROM recipient_identity_sources WHERE user_id=?',args:[current.id]})).rows[0].n),artifact=keys.lookup(['recipient-identity-v1',current.id,revision]);
  await db.raw.execute({sql:`INSERT INTO recipient_identity_sources(user_id,${fields.join(',')},revision,updated_at,content_state,source_linkage_state,content_digest_salt,purge_generation,privacy_artifact_id) VALUES(?,?,?,?,?,?,?,?,?,'PRESENT','COMPLETE',?,?,?)`,args:[current.id,...fields.map(k=>values[k]),revision,now().toISOString(),keys.newSalt(),state.purge_generation,artifact]});
  await addPrivacyLink(db.raw,{userId:current.id,mode:'SHARED',table:'recipient_identity_sources',artifactId:artifact,sourceType:'USER',sourceId:current.id,sourceMode:'SHARED',at:now().toISOString()});
  await advanceProfileRevision(db.raw,current.id,await db.getProfileRevision(current.id),now());return {changed:true};
 });}
 async function recordTelegram({user,chatId,message}){return db.transaction(async()=>{
  if(message?.chat?.type!=='private'||String(message.chat.id)!==String(chatId)||String(message.from?.id)!==String(chatId)||message.from?.is_bot===true)throw Error('RECIPIENT_TELEGRAM_UNAUTHENTICATED');
  const canonical=(await db.resolveUserByChatId(chatId))?.user;if(canonical?.id!==user?.id||canonical.lifecycleGeneration!==user.lifecycleGeneration)throw Error('RECIPIENT_ACTOR_CHANGED');
  const binding=(await db.raw.execute({sql:"SELECT telegram_chat_id,linked_at FROM user_telegram WHERE user_id=? AND status='ACTIVE'",args:[user.id]})).rows;if(binding.length!==1)throw Error('RECIPIENT_BINDING_CHANGED');
  let name;try{name=normalizeSettingsName(message.from.first_name);}catch{return {changed:false};}
  return capture(user,{telegram_first_name:name,telegram_binding:JSON.stringify([binding[0].telegram_chat_id,binding[0].linked_at])});
 });}
 async function recordWhoop({user,profile,expectedAuthGeneration}){return db.transaction(async()=>{
  if(!isVerifiedWhoopProfile(profile))throw Error('RECIPIENT_WHOOP_PROVENANCE_REQUIRED');
  const token=await db.getTokens(user.id);if(!token||token.authGeneration!==expectedAuthGeneration||token.whoopUserId!==profile.whoopUserId)throw Error('RECIPIENT_AUTH_CHANGED');
  let name;try{name=normalizeSettingsName(profile.firstName);}catch{return {changed:false};}
  return capture(user,{whoop_first_name:name,whoop_auth:expectedAuthGeneration});
 });}
 async function erase({user,chatId}){return db.transaction(async()=>{
  const current=(await db.resolveUserByChatId(chatId))?.user;if(current?.id!==user?.id||current.status!=='ACTIVE'||current.lifecycleGeneration!==user.lifecycleGeneration)throw Error('RECIPIENT_ACTOR_CHANGED');
  const changed=await db.raw.execute({sql:"UPDATE recipient_identity_sources SET explicit_display_name=NULL,telegram_first_name=NULL,whoop_first_name=NULL,content_state='REDACTED',source_linkage_state='DISCONNECTED',content_digest_salt=NULL,health_content_redacted_at=?,health_content_redaction_reason='INCIDENT_COPY' WHERE user_id=? AND content_state='PRESENT'",args:[now().toISOString(),user.id]});
  if(changed.rowsAffected)await advanceProfileRevision(db.raw,user.id,await db.getProfileRevision(user.id),now());return {erased:changed.rowsAffected};
 });}
 return Object.freeze({recordExplicit,recordTelegram,recordWhoop,erase,resolve:userId=>resolveRecipientName({db,userId})});
}
