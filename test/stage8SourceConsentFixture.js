import {createStage8SourceConsent} from '../src/stage8SourceConsent.js';
/** Explicit source-side action for owned synthetic fixtures only. Owner follow
 * alone never invokes this helper and production code never imports it. */
export async function grantSourceConsent(f,{ownerId='a',subjectId='b',notificationClass='DAILY_SUMMARY'}={}){
 if(!['a','b','c','d'].includes(ownerId)||!['a','b','c','d'].includes(subjectId))throw Error('SYNTHETIC_CONSENT_IDENTITIES_REQUIRED');
 const files=(await f.db.raw.execute('PRAGMA database_list')).rows;
 if(f.db.raw.protocol!=='file'||files.some(r=>r.file!==''||!['main','temp'].includes(r.name)))throw Error('SYNTHETIC_CONSENT_MEMORY_REQUIRED');
 const now=f.now??f.core.now,consent=await createStage8SourceConsent({...f,ownerId,enabled:()=>true,now});
 const user=await f.db.getUser(subjectId),chatId=await f.db.getActiveChatIdForUser(subjectId,{expectedLifecycleGeneration:user.lifecycleGeneration}),input={user,chatId};
 const value=(await consent.read(input)).classes[notificationClass];
 if(value?.enabled)return consent;
 await consent.update(input,{notificationClass,enabled:true,expectedRevision:value.revision,authority:value.authority,operationKey:`synthetic-source-grant:${ownerId}:${subjectId}:${notificationClass}:${value.revision}`});
 return consent;
}
