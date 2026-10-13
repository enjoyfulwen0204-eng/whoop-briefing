import {createRecipientIdentity} from './recipientIdentity.js';
import {createScopedHealthContext} from './scopedHealthContext.js';
import {createStage8SelfQa} from './stage8SelfQa.js';
import {requireRuntimeAdmission} from './runtimeAdmission.js';
export function stage8Configuration(environment){
 const enabled=environment.PHASE4_STAGE8_RUNTIME==='on';
 const owner=String(environment.PHASE4_BETA_PILOT_USER_ID??'').trim();
 const users=String(environment.STAGE8_USER_IDS??'').split(',').map(s=>s.trim()).filter(Boolean);
 if(enabled&&(!owner||users.length!==1||users[0]!==owner))throw Error('STAGE8_OWNER_COHORT_REQUIRED');
 return Object.freeze({enabled,userIds:Object.freeze(enabled?users:[])});
}
export async function createStage8Runtime({db,keys,environment,bodyEnergy,stage7=null,now=()=>new Date()}){
 const config=stage8Configuration(environment);if(!config.enabled)return null;
 const admission=await db.admitRuntime();if(requireRuntimeAdmission(db.raw,admission,keys,db.transaction)!==34)throw Error('STAGE8_V34_REQUIRED');
 const identity=await createRecipientIdentity({db,keys,now});
 const scopes=await createScopedHealthContext({db,keys,admission,now}),qa=createStage8SelfQa({scopes,db,bodyEnergy,decorate:stage7?.decorate,now});
 const eligible=uid=>stage8Configuration(environment).userIds.includes(uid);
 async function handle(input){return eligible(input.user?.id)?qa.handle(input):null;}
 async function sendReply(send,input){
  const guarded=Boolean(input.reply?.stage8ReplyGuard),previous=input.beforeSend;
  const beforeSend=async()=> (!previous||await previous())&&(!guarded||eligible(input.userId)&&await scopes.verifyReply(input));
  if(!await beforeSend())return {sent:false,messageId:null,reason:'stage8_reply_changed'};
  return send({...input,beforeSend});
 }
 return Object.freeze({config,handle,sendReply,scopes,identity});
}
