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
 return Object.freeze({recordExplicit,resolve:userId=>resolveRecipientName({db,userId})});
}
