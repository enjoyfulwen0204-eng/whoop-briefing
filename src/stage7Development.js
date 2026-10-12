import {createStage7WeeklyReview} from './stage7WeeklyReview.js';
import {createStage7Companion} from './stage7Companion.js';
import {fail} from './phase4Core.js';

/** Development composition cannot accept a file/network DB or live provider.
 * Activation is intentionally absent. The owner authorized synthetic acceptance. */
export async function createStage7Development({core,stores,db,...options}){
 const files=(await core.client.execute('PRAGMA database_list')).rows;
 if(core.client.protocol!=='file'||!files.some(r=>r.name==='main')||files.some(r=>!['main','temp'].includes(r.name)||r.file!==''))fail('STAGE7_SYNTHETIC_MEMORY_REQUIRED');
 let companion;
 const accepted=async(actor,row,receipt)=>{
  const request=await core.transaction(async()=>{
   await core.assertControl(actor.control);
   const current=await companion.interactions.read(row.user_id,row.interaction_id);
   if(current.state==='COMPLETED')return null;
   if(current.state!=='CONFIRM'||current.revision!==row.revision)fail('STAGE7_CAS_LOST');
   if(current.correction_key&&current.correction_key!==receipt)fail('STAGE7_CORRECTION_COMMAND_CONFLICT');
   await core.client.execute({sql:'UPDATE quick_action_interactions SET answered_at=COALESCE(answered_at,?),correction_key=COALESCE(correction_key,?) WHERE user_id=? AND interaction_id=? AND revision=?',args:[core.timestamp(),receipt,row.user_id,row.interaction_id,row.revision]});
   return {interactionId:row.interaction_id,expectedRevision:row.revision,callbackReceipt:receipt};
  });
  if(!request)return;
  let result;
  if(row.logical_fact_id){
   result=await stores.journal.correctTrusted(actor.control,{...request,logicalFactId:row.logical_fact_id,
    // Fact revision and interaction revision are independent CAS authorities.
    idempotencyKey:`stage7-correct:${receipt}`,expectedRevision:row.fact_revision,interactionRevision:row.revision});
   if(result.purgeId)await stores.privacy.complete(actor.control,result.purgeId);
  }else{
   // The create + result binding + privacy links are one atomic unit.
   return core.transaction(async()=>{
    result=await stores.journal.createTrusted(actor.control,request);
    if(result.redacted)fail('JOURNAL_SUBJECT_DELETED');await completeFact(actor,row,result.logicalFactId,result.revision);
   });
  }
  await core.transaction(async()=>{
   const fact=(await core.client.execute({sql:"SELECT revision FROM journal_events WHERE user_id=? AND logical_fact_id=? AND fact_status='ACTIVE'",args:[row.user_id,row.logical_fact_id]})).rows[0];
   if(!fact)fail('STAGE7_CORRECTION_NOT_COMMITTED');await completeFact(actor,row,row.logical_fact_id,fact.revision);
  });
 };
 async function completeFact(actor,row,id,revision){
  const current=await companion.interactions.read(row.user_id,row.interaction_id);
  const fact=(await core.client.execute({sql:"SELECT privacy_artifact_id FROM journal_events WHERE user_id=? AND logical_fact_id=? AND revision=? AND fact_status='ACTIVE'",args:[row.user_id,id,revision]})).rows[0];
  if(!fact)fail('STAGE7_JOURNAL_NOT_COMMITTED');
  const next=await companion.interactions.update(actor,current,{state:'COMPLETED',logical_fact_id:id,fact_revision:revision});
  await companion.interactions.link('quick_action_interactions',next,'JOURNAL_FACT',fact.privacy_artifact_id);
  // Any cached card is explicitly linked to the accepted fact as well.
  const deliveries=(await core.client.execute({sql:'SELECT * FROM journal_prompt_deliveries WHERE user_id=? AND interaction_id=?',args:[row.user_id,row.interaction_id]})).rows;
  for(const delivery of deliveries)await companion.interactions.link('journal_prompt_deliveries',delivery,'JOURNAL_FACT',fact.privacy_artifact_id);
 }
 const undo=async(actor,row,receipt)=>{
  await core.transaction(async()=>{const current=await companion.interactions.read(row.user_id,row.interaction_id);
   if(current.correction_key&&current.correction_key!==receipt&&current.state==='CONFIRM')fail('STAGE7_CORRECTION_COMMAND_CONFLICT');
   await core.client.execute({sql:'UPDATE quick_action_interactions SET correction_key=? WHERE user_id=? AND interaction_id=?',args:[receipt,row.user_id,row.interaction_id]});});
  if(row.logical_fact_id){const result=await stores.journal.remove(actor.control,{logicalFactId:row.logical_fact_id,idempotencyKey:`stage7-undo:${receipt}`});if(result.purgeId)await stores.privacy.complete(actor.control,result.purgeId);}
 };
 companion=createStage7Companion({core,stores,db,...options,onAccept:accepted,onUndo:undo,onWeekly:actor=>weekly.prepare(actor)});
 const weekly=createStage7WeeklyReview({core,stores,db,companion});
 const handle=companion.handle,handleNote=companion.handleNote;
 async function resumePending({user,chatId,callback=null}){
  const actor=await core.transaction(()=>companion.interactions.authenticate({user,chatId,callback,allowPendingPurge:true}));
  if(actor.state.pending_purge_count===0)return;
  const rows=(await core.client.execute({sql:'SELECT * FROM quick_action_interactions WHERE user_id=? AND correction_key IS NOT NULL ORDER BY created_at DESC LIMIT 20',args:[user.id]})).rows;
  for(const row of rows){
   if(row.lifecycle_generation!==actor.state.lifecycle_generation||row.auth_generation!==actor.state.auth_generation)continue;
   for(const kind of ['correct','undo']){
    const key=core.keys.lookup(['purge-command-v1',user.id,`stage7-${kind}:${row.correction_key}`]);
    const purge=(await core.client.execute({sql:"SELECT purge_id,state FROM health_plaintext_purges WHERE user_id=? AND deletion_or_correction_idempotency_key=? AND state<>'COMPLETE'",args:[user.id,key]})).rows[0];
    if(!purge)continue;
    await stores.privacy.redact(actor.control,purge.purge_id);await stores.privacy.complete(actor.control,purge.purge_id);
    if(kind==='correct')await core.transaction(async()=>{
     const fact=(await core.client.execute({sql:"SELECT revision FROM journal_events WHERE user_id=? AND logical_fact_id=? AND fact_status='ACTIVE'",args:[user.id,row.logical_fact_id]})).rows[0];
     if(fact)await completeFact(actor,row,row.logical_fact_id,fact.revision);
    });
   }
  }
 }
 return {...companion,weekly,resumePending,handle:async input=>{
  if(input.callback||typeof input.text==='string'&&/^\/journal(?:@[A-Za-z0-9_]+)?\s*$/i.test(input.text.trim()))await resumePending(input);
  return handle(input);
 },handleNote};
}
