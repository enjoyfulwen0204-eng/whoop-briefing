import { fail } from './phase4Core.js';
import { addPrivacyLink,REDACTED_RECEIPT } from './phase4V22Backfill.js';

/** Dedicated inbound control adapter. LIVE authority is still issued only by
 * the isolated-memory factory; no production entry point constructs a route.
 * An owned private-chat binding, processing lease and ordered lane are all
 * checked from durable server state. JSON or a Telegram chat ID is not proof. */
export function createPhase4JournalInbound(core,privacy,journal) {
  const {client,keys,transaction,timestamp}=core,proofs=new WeakMap();
  async function validate(control,proof,sourceUpdateId,{purge=null}={}) {
    const issued=proofs.get(proof);if(!issued||issued.userId!==control.userId||String(sourceUpdateId)!==String(issued.updateId))
      fail('PHASE4_INBOUND_CONTROL_AUTHORITY_REQUIRED');
    const state=await core.assertPrivacyControl(control),at=timestamp();
    if(!purge||purge.operation_kind==='CORRECTION') {
      await core.assertControl(control);
      if(state.lifecycle_generation!==issued.lifecycleGeneration||state.auth_generation!==issued.authGeneration)fail('PHASE4_INBOUND_GENERATION_STALE');
      if(!(await client.execute({sql:"SELECT 1 FROM user_telegram WHERE user_id=? AND telegram_chat_id=? AND status='ACTIVE'",
        args:[issued.userId,issued.chatId]})).rows.length)fail('PHASE4_INBOUND_BINDING_STALE');
    }
    const claim=(await client.execute({sql:`SELECT 1 FROM telegram_processed_updates WHERE update_id=? AND user_id=?
      AND owner=? AND status='PROCESSING' AND lease_expires_at>?`,args:[issued.updateId,issued.conversation,issued.owner,at]})).rows.length;
    const lane=(await client.execute({sql:'SELECT 1 FROM resource_locks WHERE name=? AND owner=? AND expires_at>?',
      args:[`telegram_lane:${issued.conversation}`,issued.owner,at]})).rows.length;
    const earlier=(await client.execute({sql:`SELECT 1 FROM telegram_processed_updates WHERE user_id=? AND update_id<? AND status NOT IN ('COMPLETED','ABANDONED')`,
      args:[issued.conversation,issued.updateId]})).rows.length;
    if(!claim||!lane||earlier)fail('PHASE4_INBOUND_LEASE_FENCED');
    return issued;
  }
  async function capture(control,{updateId,owner,expectedLifecycleGeneration=control.lifecycleGeneration}) {
    if(!Number.isSafeInteger(updateId)||updateId<0||typeof owner!=='string'||!owner)fail('PHASE4_SOURCE_UPDATE_REQUIRED');
    return core.runControl(control,'LIVE',async()=>{
      const state=await core.assertControl(control);
      if(state.lifecycle_generation!==expectedLifecycleGeneration)fail('PHASE4_INBOUND_GENERATION_STALE');
      const row=(await client.execute({sql:`SELECT p.user_id AS conversation,t.telegram_chat_id FROM telegram_processed_updates p
        JOIN user_telegram t ON p.user_id='tg:'||t.telegram_chat_id WHERE p.update_id=? AND p.owner=? AND t.user_id=? AND t.status='ACTIVE'`,
        args:[updateId,owner,control.userId]})).rows[0];
      if(!row||!/^\d+$/.test(row.telegram_chat_id)||Number(row.telegram_chat_id)<=0)fail('PHASE4_INBOUND_OWNER_MISMATCH');
      const proof=Object.freeze({purpose:'JOURNAL_INBOUND_CONTROL'});
      proofs.set(proof,{userId:control.userId,updateId,owner,chatId:row.telegram_chat_id,conversation:row.conversation,
        lifecycleGeneration:state.lifecycle_generation,authGeneration:state.auth_generation});
      await validate(control,proof,String(updateId));return proof;
    });
  }
  async function commitReceipt(control,proof,purge) {
    if(!core.processing.active())fail('PHASE4_TRANSACTION_REQUIRED');
    const issued=await validate(control,proof,purge.source_update_id,{purge});
    const prior=(await client.execute({sql:'SELECT * FROM telegram_operations WHERE update_id=?',args:[issued.updateId]})).rows[0];
    if(prior)fail(prior.owner_user_id===control.userId?'PHASE4_ORIGIN_RECEIPT_ALREADY_COMMITTED':'PHASE4_RECEIPT_OWNER_MISMATCH');
    const state=await core.userState(control.userId),at=timestamp();
    const artifact=keys.lookup(['privacy-artifact-v1','telegram_operations',control.userId,'SHARED',[issued.updateId]]);
    const result={reply:purge.operation_kind==='CORRECTION'?'Health record updated.':'Health record deleted.',userId:control.userId,
      chatId:issued.chatId,expectedLifecycleGeneration:issued.lifecycleGeneration};
    await client.execute({sql:`INSERT INTO telegram_operations(update_id,owner_user_id,source_update_key,result_json,committed_at,
      delivery_state,operation_state,content_state,source_linkage_state,privacy_artifact_id,purge_generation)
      VALUES (?,?,?,?,?,'ACTION_READY','COMMITTED','PRESENT','COMPLETE',?,?)`,
      args:[issued.updateId,control.userId,String(issued.updateId),JSON.stringify(result),at,artifact,state.purge_generation]});
    await addPrivacyLink(client,{userId:control.userId,table:'telegram_operations',artifactId:artifact,sourceType:'USER',sourceId:control.userId,at,
      relationship:`RECEIPT_FENCE:${issued.lifecycleGeneration}:${issued.authGeneration}:${state.purge_generation}`});
    if(purge.operation_kind==='CORRECTION'&&purge.target_source_type==='JOURNAL_FACT') {
      const fact=(await client.execute({sql:"SELECT privacy_artifact_id FROM journal_events WHERE user_id=? AND logical_fact_id=? AND fact_status='ACTIVE'",args:[control.userId,purge.target_source_id]})).rows[0];
      if(!fact)fail('PHASE4_ANSWER_ASSERTION_REQUIRED');
      await addPrivacyLink(client,{userId:control.userId,table:'telegram_operations',artifactId:artifact,sourceType:'JOURNAL_FACT',sourceId:fact.privacy_artifact_id,at});
      const answers=(await client.execute({sql:"SELECT privacy_artifact_id FROM structured_answer_events WHERE user_id=? AND execution_mode='LIVE' AND source_update_id=? AND content_state='PRESENT'",args:[control.userId,String(issued.updateId)]})).rows;
      for(const answer of answers)await addPrivacyLink(client,{userId:control.userId,mode:'LIVE',table:'structured_answer_events',artifactId:answer.privacy_artifact_id,
        sourceType:'TELEGRAM_OPERATION',sourceId:String(issued.updateId),at});
    }
    await client.execute({sql:'UPDATE health_plaintext_purges SET replacement_receipt_id=? WHERE user_id=? AND purge_id=?',
      args:[String(issued.updateId),control.userId,purge.purge_id]});
  }
  privacy.registerInbound({validate,commitReceipt});
  async function answerReceipt(control,proof,sourceUpdateId) {
    if(!core.processing.active())fail('PHASE4_TRANSACTION_REQUIRED');
    const issued=await validate(control,proof,sourceUpdateId),state=await core.assertControl(control),at=timestamp();
    if(state.pending_purge_count)fail('PHASE4_PURGE_FENCED');
    if((await client.execute({sql:'SELECT 1 FROM telegram_operations WHERE update_id=?',args:[issued.updateId]})).rows.length)fail('PHASE4_ORIGIN_RECEIPT_ALREADY_COMMITTED');
    const artifact=keys.lookup(['privacy-artifact-v1','telegram_operations',control.userId,'SHARED',[issued.updateId]]);
    await client.execute({sql:`INSERT INTO telegram_operations(update_id,owner_user_id,source_update_key,result_json,committed_at,
      delivery_state,operation_state,content_state,source_linkage_state,privacy_artifact_id,purge_generation)
      VALUES (?,?,?,?,?,'ACTION_READY','COMMITTED','PRESENT','COMPLETE',?,?)`,args:[issued.updateId,control.userId,String(issued.updateId),
        JSON.stringify({reply:null,userId:control.userId,chatId:issued.chatId,expectedLifecycleGeneration:issued.lifecycleGeneration}),at,artifact,state.purge_generation]});
    await addPrivacyLink(client,{userId:control.userId,table:'telegram_operations',artifactId:artifact,sourceType:'USER',sourceId:control.userId,at,
      relationship:`RECEIPT_FENCE:${issued.lifecycleGeneration}:${issued.authGeneration}:${state.purge_generation}`});
    return artifact;
  }
  async function process(control,proof,command) {
    if(core.processing.active())fail('PHASE4_T0_MUST_BE_STANDALONE');
    const issued=proofs.get(proof);if(!issued)fail('PHASE4_INBOUND_CONTROL_AUTHORITY_REQUIRED');
    await core.runControl(control,'LIVE',()=>validate(control,proof,String(issued.updateId)));
    const receipt=(await client.execute({sql:'SELECT owner_user_id,content_state FROM telegram_operations WHERE update_id=?',args:[issued.updateId]})).rows[0];
    if(receipt?.content_state==='REDACTED')return {handled:true,complete:true,...JSON.parse(REDACTED_RECEIPT)};
    if(receipt&&receipt.owner_user_id!==control.userId)fail('PHASE4_RECEIPT_OWNER_MISMATCH');
    const prior=(await client.execute({sql:'SELECT * FROM health_plaintext_purges WHERE user_id=? AND source_update_id=?',args:[control.userId,String(issued.updateId)]})).rows;
    if(prior.length>1)fail('PHASE4_INBOUND_PURGE_IDENTITY_CONFLICT');
    let purgeId=prior[0]?.purge_id;
    if(!purgeId) {
      if(receipt)return {handled:true,complete:true,reply:null}; // committed action barrier: never rerun any original action
      if(!command||!['CORRECTION','DELETION'].includes(command.operation)||typeof command.logicalFactId!=='string')fail('JOURNAL_CONTROL_COMMAND_REQUIRED');
      const options={...command,idempotencyKey:`telegram-journal-control:${issued.updateId}`,sourceUpdateId:String(issued.updateId),inboundAuthority:proof};
      const result=command.operation==='CORRECTION'?await journal.correct(control,options):await journal.remove(control,options);
      if(result.unchanged) {
        await transaction(async()=>{
          const artifact=await answerReceipt(control,proof,String(issued.updateId));
          const fact=(await client.execute({sql:"SELECT privacy_artifact_id FROM journal_events WHERE user_id=? AND logical_fact_id=? AND fact_status='ACTIVE'",args:[control.userId,result.logicalFactId]})).rows[0];
          if(!fact)fail('PHASE4_ANSWER_ASSERTION_REQUIRED');
          await addPrivacyLink(client,{userId:control.userId,table:'telegram_operations',artifactId:artifact,sourceType:'JOURNAL_FACT',sourceId:fact.privacy_artifact_id,at:timestamp()});
        });
        return {handled:true,complete:true,reply:null,answerEventId:result.answerEventId};
      }
      if(!result.purgeId) {
        if(!result.deleted&&!['REJECT','REQUIRE_CLARIFICATION'].includes(result.status))fail('JOURNAL_CONTROL_RESULT_INVALID');
        await transaction(()=>answerReceipt(control,proof,String(issued.updateId)));
        return {handled:true,complete:true,reply:null,status:result.status??'ALREADY_DELETED'};
      }
      purgeId=result.purgeId;
    } else if(prior[0].state==='ADMITTED')await privacy.redact(control,purgeId,{inboundAuthority:proof});
    try {await privacy.complete(control,purgeId);}catch(error) {
      if(error.code!=='PHASE4_CACHE_ACK_PENDING')throw error;
      return {handled:true,complete:false,reply:null,purgeId,state:'DB_REDACTED'};
    }
    // This foundation never returns a sendable reply. The durable fixed ack is
    // ready only after T2, for a separately authorized future delivery cutover.
    return {handled:true,complete:true,reply:null,purgeId,state:'COMPLETE'};
  }
  async function route({user,updateId,owner,text}) {
    // Ledger lookup precedes even command parsing. The callback is supplied
    // only by an explicit owning fixture/server; no production caller installs it.
    const admitted=(await client.execute({sql:'SELECT 1 FROM health_plaintext_purges WHERE user_id=? AND source_update_id=?',
      args:[user.id,String(updateId)]})).rows.length;
    if(!admitted&&!/^\/journal_(delete|correct)(?:\s|$)/u.test(text))return {handled:false};
    const control=await core.captureControl(user.id),proof=await capture(control,{updateId,owner,expectedLifecycleGeneration:user.lifecycleGeneration});
    if(admitted)return process(control,proof,null);
    const deletion=/^\/journal_delete ([a-f0-9]{64})\s*$/u.exec(text);
    if(deletion)return process(control,proof,{operation:'DELETION',logicalFactId:deletion[1]});
    const correction=/^\/journal_correct ([a-f0-9]{64}) ([1-9]\d*) ([\s\S]+)$/u.exec(text);
    if(!correction||text.length>16000)fail('JOURNAL_CONTROL_COMMAND_REQUIRED');
    let payload;try{payload=JSON.parse(correction[3]);}catch{fail('JOURNAL_CONTROL_COMMAND_REQUIRED');}
    if(!payload||Object.keys(payload).sort().join(',')!=='candidate,sourceText')fail('JOURNAL_CONTROL_COMMAND_REQUIRED');
    return process(control,proof,{operation:'CORRECTION',logicalFactId:correction[1],expectedRevision:Number(correction[2]),...payload});
  }
  return {capture,process,route,validate,answerReceipt};
}
