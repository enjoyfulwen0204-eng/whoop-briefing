import {isApprovedStage7Three} from './stage7Cohort.js';
import {requireRuntimeAdmission} from './runtimeAdmission.js';
import {createTelegramApi} from './bot/api.js';
import {SEND_OUTCOME} from './sendOutcome.js';
import {fail} from './phase4Core.js';
const providers=new WeakSet();
export const isStage7ProductionProvider=provider=>providers.has(provider);
/** Server-owned adapter. No request can provide a provider, URL or destination.
 * The caller's exact admitted connection and closed rollout remain authoritative. */
export function createStage7ProductionProvider({db,core,keys,admission,env,userIds,beforeSend}){
 requireRuntimeAdmission(db.raw,admission,keys,db.transaction);
 if(core.schemaVersion!==33||!Array.isArray(userIds)||!(userIds.length===1||isApprovedStage7Three(userIds))||typeof beforeSend!=='function')fail('STAGE7_PRODUCTION_AUTHORITY_REQUIRED');
 const api=createTelegramApi({botToken:env.telegramBotToken});
 const provider=Object.freeze({async send({chatId,...card},authority){
  if(!authority||!userIds.includes(authority.userId)||String(authority.chatId)!==String(chatId))throw Object.assign(Error('STAGE7_ROLLOUT_FENCED'),{definite:true});
  // A rejected final fence happened before any provider request. Preserve that
  // definite non-send instead of manufacturing an ambiguous Telegram attempt.
  try{await beforeSend(authority);}catch(error){error.definite=true;throw error;}
  try{const sent=await api.sendMessage(chatId,card);return {messageId:String(sent.message_id)};}
  catch(error){if(error?.sendOutcome===SEND_OUTCOME.DEFINITE_FAILURE)error.definite=true;throw error;}
 }});providers.add(provider);return provider;
}
