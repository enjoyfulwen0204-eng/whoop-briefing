import {readableRow,fail} from './phase4Core.js';
import {JOURNAL_REGISTRY_VERSION} from './stage7Registry.js';

/** A persisted reply is a capability to send exactly that projection. Checking
 * it never renders a card, issues tokens, or repeats the committed action. */
export function createStage7ReplyAuthority({core,db,companion}){
 const {interactions}=companion;
 const stateKeys=['id','status','timezone','lifecycle_generation','auth_generation','source_generation','purge_generation','pending_purge_count'];
 const stateOf=state=>stateKeys.map(k=>state[k]);
 async function stamp(actor){
  const state=await core.assertControl(actor.control);
  if(state.pending_purge_count!==0||JSON.stringify(stateOf(state))!==JSON.stringify(stateOf(actor.state)))fail('STAGE7_REPLY_FENCED');
  const profile=await db.getProfileRevision(actor.control.userId);
  if(profile!==actor.profileRevision)fail('STAGE7_REPLY_FENCED');
  const computation=(await core.client.execute({sql:'SELECT execution_mode,input_generation,last_completed_generation,source_generation_seen,algorithm_set_version,revision FROM phase4_computation_state WHERE user_id=? ORDER BY execution_mode',args:[actor.control.userId]})).rows;
  return {userId:actor.control.userId,chat:actor.chat,state:stateOf(state),profile,locale:await db.getLocale(actor.control.userId),computation};
 }
 async function assertInteractions(actor,reply){
  const ids=[[reply.stage7InteractionId,reply.stage7Revision],[reply.stage7AdditionalInteractionId,reply.stage7AdditionalRevision]].filter(([id])=>id);
  for(const [id,revision] of ids){
   const row=await interactions.read(actor.control.userId,id);
   if(!readableRow(row)||row.revision!==revision||row.chat_id!==actor.chat||row.expires_at<=core.timestamp()
    ||row.lifecycle_generation!==actor.state.lifecycle_generation||row.auth_generation!==actor.state.auth_generation||row.timezone!==actor.state.timezone
    ||row.registry_version!==JOURNAL_REGISTRY_VERSION||JSON.parse(row.diagnostics_json??'null')?.profileRevision!==actor.profileRevision
    ||row.message_id&&String(reply.editMessageId)!==row.message_id)fail('STAGE7_REPLY_FENCED');
  }
  for(const button of reply.replyMarkup?.inline_keyboard?.flat()??[]){
   if(!button.callback_data?.startsWith('j7:'))continue;
   const token=(await core.client.execute({sql:'SELECT interaction_id,revision,expires_at FROM journal_callback_tokens WHERE user_id=? AND token_hash=?',args:[actor.control.userId,core.keys.lookup(['stage7-callback',button.callback_data.slice(3)])]})).rows[0];
   if(!token||token.expires_at<=core.timestamp()||!ids.some(([id,revision])=>token.interaction_id===id&&token.revision===revision))fail('STAGE7_REPLY_FENCED');
  }
 }
 async function seal(actor,reply){
  if(!reply)return reply;
  await assertInteractions(actor,reply);
  const captured=await stamp(actor),expiresAt=new Date(core.now().getTime()+15*60000).toISOString();
  return {...reply,stage7ReplyGuard:{captured,expiresAt,signature:core.keys.lookup(['stage7-reply-v1',reply,captured,expiresAt])}};
 }
 async function verify({user,chatId,reply}){
  try{return await core.transaction(async()=>{
   const {stage7ReplyGuard:guard,...payload}=reply??{};
   if(!guard||guard.expiresAt<=core.timestamp()||guard.signature!==core.keys.lookup(['stage7-reply-v1',payload,guard.captured,guard.expiresAt]))return false;
   const actor=await interactions.authenticate({user,chatId});
   if(JSON.stringify(guard.captured)!==JSON.stringify(await stamp(actor)))return false;
   await assertInteractions(actor,payload);return true;
  });}catch{return false;}
 }
 return {seal,verify};
}
