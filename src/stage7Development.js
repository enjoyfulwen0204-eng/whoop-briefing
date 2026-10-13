import {createStage7DecisionStore} from './stage7DecisionStore.js';
import {createStage7InteractionPrivacy} from './stage7InteractionPrivacy.js';
import {createStage7WeeklyReview} from './stage7WeeklyReview.js';
import {createStage7Companion} from './stage7Companion.js';
import {fail,readableRow} from './phase4Core.js';
import {TOPICS,JOURNAL_REGISTRY_VERSION,registryQuestion} from './stage7Registry.js';

/** Development composition cannot accept a file/network DB or live provider.
 * Activation is intentionally absent. The owner authorized synthetic acceptance. */
export async function createStage7Development({core,stores,db,...options}){
 const files=(await core.client.execute('PRAGMA database_list')).rows;
 if(core.client.protocol!=='file'||!files.some(r=>r.name==='main')||files.some(r=>!['main','temp'].includes(r.name)||r.file!==''))fail('STAGE7_SYNTHETIC_MEMORY_REQUIRED');
 const interactionPrivacy=createStage7InteractionPrivacy(core);
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
    if(result.redacted)fail('JOURNAL_SUBJECT_DELETED');
    if(row.kind==='QUICK')await core.client.execute({sql:"DELETE FROM phase4_source_links WHERE user_id=? AND artifact_type='quick_action_interactions' AND artifact_execution_mode='SHADOW' AND artifact_id=? AND source_type='quick_action_interactions'",args:[row.user_id,row.privacy_artifact_id]});
    await completeFact(actor,row,result.logicalFactId,result.revision);
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
 async function finishMissing(actor,row){
  const staged=await core.transaction(async()=>{
   const state=await core.assertControl(actor.control),current=await companion.interactions.read(actor.control.userId,row.interaction_id),d=JSON.parse(current?.diagnostics_json??'null'),intent=d?.missingCorrection;
   if(!readableRow(current)||current.chat_id!==actor.chat||current.lifecycle_generation!==state.lifecycle_generation||current.auth_generation!==state.auth_generation)fail('STAGE7_ACTOR_FENCED');
   if(!intent)return current;
   if(current.state!=='CONFIRM'||current.logical_fact_id||!['NOT_SURE','SKIPPED'].includes(intent.choice)||intent.choice!==current.selected_choice
    ||!TOPICS.includes(current.category)||current.registry_id!==registryQuestion(current.category)||current.question_identity!==current.registry_id
    ||current.registry_version!==JOURNAL_REGISTRY_VERSION||typeof intent.logicalFactId!=='string'||!current.correction_key)fail('STAGE7_REGISTRY_AUTHORITY_INVALID');
   return current;
  });
  const diagnostics=JSON.parse(staged.diagnostics_json??'null'),intent=diagnostics?.missingCorrection;
  if(!intent)return staged;
  const result=await stores.journal.remove(actor.control,{logicalFactId:intent.logicalFactId,idempotencyKey:`stage7-undo:${staged.correction_key}`});
  if(result.purgeId)await stores.privacy.complete(actor.control,result.purgeId);
  return core.transaction(async()=>{
   const current=await companion.interactions.read(actor.control.userId,staged.interaction_id),d=JSON.parse(current?.diagnostics_json??'null');
   if(!d?.missingCorrection)return current;
   // This row never held old answer/detail/note content or issued buttons.
   // Only independently submitted missingness survives canonical deletion.
   delete d.missingCorrection;d.profileRevision=actor.profileRevision;
   return companion.interactions.update(actor,current,{state:intent.choice,selected_choice:intent.choice,timezone:(await core.assertControl(actor.control)).timezone,diagnostics_json:JSON.stringify(d)});
  });
 }
 async function correctToMissing(actor,row,receipt,choice){
  const staged=await core.transaction(async()=>{
   const authority=await core.assertControl(actor.control),current=await companion.interactions.read(actor.control.userId,row.interaction_id);
   if(!readableRow(current)||current.revision!==row.revision||current.expires_at<=core.timestamp()||!['ISSUED','EDITING'].includes(current.state)||!current.logical_fact_id
    ||!['NOT_SURE','SKIPPED'].includes(choice)||!TOPICS.includes(current.category)||current.registry_id!==registryQuestion(current.category)
    ||current.registry_version!==JOURNAL_REGISTRY_VERSION||current.question_identity!==current.registry_id)fail('STAGE7_REGISTRY_AUTHORITY_INVALID');
   const fact=await stores.withContext(actor.control.userId,{executionMode:'SHADOW'},async context=>(await stores.journal.read(context,current.logical_fact_id))?.row);
   if(fact?.provenance_mode!=='TRUSTED_REGISTRY'||fact.revision!==current.fact_revision||fact.category!==current.category||fact.health_date!==current.target_date||fact.event_at!==current.window_start||fact.event_end_at!==current.window_end)fail('JOURNAL_REVISION_CONFLICT');
   const origin=(await core.client.execute({sql:"SELECT * FROM quick_action_interactions WHERE user_id=? AND logical_fact_id=? AND content_state='PRESENT' AND (kind='DAILY' OR json_extract(diagnostics_json,'$.dailyAnswerKey') IS NOT NULL) ORDER BY created_at LIMIT 1",args:[current.user_id,current.logical_fact_id]})).rows[0];
   const dailyAnswerKey=origin?(JSON.parse(origin.diagnostics_json??'null')?.dailyAnswerKey??origin.semantic_key):null;
   const obsolete=(await core.client.execute({sql:"SELECT * FROM quick_action_interactions WHERE user_id=? AND content_state='PRESENT' AND json_extract(diagnostics_json,'$.missingCorrection.logicalFactId')=? AND (lifecycle_generation<>? OR auth_generation<>?) LIMIT 21",args:[current.user_id,current.logical_fact_id,authority.lifecycle_generation,authority.auth_generation]})).rows;
   if(obsolete.length>20)fail('STAGE7_RECOVERY_BOUNDS');
   for(const old of obsolete)await interactionPrivacy.retract(actor.control,old);
   const issued=await companion.interactions.issue(actor,{category:current.category,targetDate:current.target_date,recordedTimezone:fact.recorded_timezone,
    semanticKey:core.keys.lookup(['stage7-missing-correction-v1',current.user_id,current.logical_fact_id,fact.revision,authority.lifecycle_generation,authority.auth_generation]),
    diagnostics:{...(dailyAnswerKey?{dailyAnswerKey}:{}),missingCorrection:{logicalFactId:current.logical_fact_id,choice}}});
   if(!issued.created)fail('STAGE7_QUESTION_SEMANTIC_RESERVED');
   await companion.interactions.bind(actor,issued.row.interaction_id,current.message_id);
   await companion.interactions.update(actor,current,{correction_key:receipt});
   // Persist the accepted intent before T0. It has independent USER lineage,
   // no factual descendant edge and no copied prior answer or optional note.
   return companion.interactions.update(actor,await companion.interactions.read(current.user_id,issued.row.interaction_id),{state:'CONFIRM',selected_choice:choice,answered_at:core.timestamp(),correction_key:receipt});
  });
  return finishMissing(actor,staged);
 }
 const undo=async(actor,row,receipt,{missingChoice=null}={})=>{
  if(missingChoice)return correctToMissing(actor,row,receipt,missingChoice);
  await core.transaction(async()=>{const current=await companion.interactions.read(row.user_id,row.interaction_id);
   if(current.correction_key&&current.correction_key!==receipt&&current.state==='CONFIRM')fail('STAGE7_CORRECTION_COMMAND_CONFLICT');
   await core.client.execute({sql:'UPDATE quick_action_interactions SET correction_key=? WHERE user_id=? AND interaction_id=?',args:[receipt,row.user_id,row.interaction_id]});});
  if(row.logical_fact_id){const result=await stores.journal.remove(actor.control,{logicalFactId:row.logical_fact_id,idempotencyKey:`stage7-undo:${receipt}`});if(result.purgeId)await stores.privacy.complete(actor.control,result.purgeId);}
  else{
   const originalId=JSON.parse(row.diagnostics_json??'null')?.retractInteractionId;
   const original=originalId?await companion.interactions.read(actor.control.userId,originalId):row;
   if(!original||original.user_id!==actor.control.userId)fail('STAGE7_PRIVACY_FENCED');
   await interactionPrivacy.retract(actor.control,original);
  }
 };
 companion=createStage7Companion({core,stores,db,...options,onAccept:accepted,onUndo:undo,onWeekly:actor=>weekly.prepare(actor)});
 const weekly=createStage7WeeklyReview({core,stores,db,companion});
 const handle=companion.handle,handleNote=companion.handleNote;
 async function resumePending({user,chatId,callback=null}){
  const actor=await core.transaction(()=>companion.interactions.authenticate({user,chatId,callback,allowPendingPurge:true}));
  const missing=(await core.client.execute({sql:"SELECT * FROM quick_action_interactions WHERE user_id=? AND content_state='PRESENT' AND json_extract(diagnostics_json,'$.missingCorrection') IS NOT NULL ORDER BY created_at LIMIT 21",args:[user.id]})).rows;
  if(missing.length>20)fail('STAGE7_RECOVERY_BOUNDS');
  const retired=[];
  for(const row of missing){
   if(row.lifecycle_generation===actor.state.lifecycle_generation&&row.auth_generation===actor.state.auth_generation)continue;
   const intent=JSON.parse(row.diagnostics_json).missingCorrection,key=core.keys.lookup(['purge-command-v1',user.id,`stage7-undo:${row.correction_key}`]);
   const purge=(await core.client.execute({sql:'SELECT * FROM health_plaintext_purges WHERE user_id=? AND deletion_or_correction_idempotency_key=?',args:[user.id,key]})).rows[0];
   if(!purge)continue; // Never admit a new mutation from obsolete authority.
   if(purge.operation_kind!=='DELETION'||purge.target_source_type!=='JOURNAL_FACT'||purge.target_source_id!==intent.logicalFactId)fail('STAGE7_REGISTRY_AUTHORITY_INVALID');
   retired.push({row,purge});
  }
  // Current self privacy authority may settle an already-admitted cleanup.
  // It cannot finalize the obsolete answer or restore any scrubbed content.
  for(const {purge} of retired.sort((a,b)=>a.purge.purge_generation-b.purge.purge_generation)){
   await stores.privacy.redact(actor.control,purge.purge_id);await stores.privacy.complete(actor.control,purge.purge_id);
  }
  for(const row of missing){if(row.lifecycle_generation===actor.state.lifecycle_generation&&row.auth_generation===actor.state.auth_generation)await finishMissing(actor,row);}
  if((await core.assertControl(actor.control)).pending_purge_count===0){for(const {row} of retired)await interactionPrivacy.retract(actor.control,row);return;}
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
 return {...companion,decisions:createStage7DecisionStore({core,stores}),weekly,resumePending,handle:async input=>{
  if(input.callback||typeof input.text==='string'&&/^\/journal(?:@[A-Za-z0-9_]+)?\s*$/i.test(input.text.trim()))await resumePending(input);
  return handle(input);
 },handleNote};
}
