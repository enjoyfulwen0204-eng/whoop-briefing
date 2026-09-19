import { fail,readableRow,requireInteger } from './phase4Core.js';
import { canonicalJson } from './phase4EntityStore.js';
import { addPrivacyLink,REDACTED_RECEIPT } from './phase4V22Backfill.js';
import { JOURNAL_VERSIONS } from './journalFoundationValidation.js';
import { answerSemantics } from './journalAnswerRevision.js';

/** No question-selection, parsing provider or follow-up send capability.
 * LIVE exists only inside the memory-owning fixture and requires a separately
 * captured durable inbound lease. SHADOW writes only its answer envelope. */
export function createPhase4JournalAnswers(core,journal,coverage,slots,inbound,queue) {
  const {client,transaction,keys,timestamp}=core;
  async function accept(context,{questionRequestId,replyToQuestionRequestId,expectedRevision,sourceUpdateId,candidate,sourceText,inboundAuthority=null}) {
    if(core.processing.active())fail('PHASE4_ANSWER_MUST_BE_STANDALONE');
    // Finish the old-generation read transaction before the source mutation.
    // Recheck its exact immutable snapshot and all fences under the write lock.
    // Never suppress the generic nested-transaction after-check.
    const replay=await transaction(async()=>{
      await core.assertContext(context);
      if(typeof sourceUpdateId!=='string'||!sourceUpdateId||sourceUpdateId.length>256)fail('PHASE4_ANSWER_SOURCE_REQUIRED');
      if(context.executionMode==='LIVE')await inbound.validate(await core.captureControl(context.userId),inboundAuthority,sourceUpdateId);
      else if(!sourceUpdateId.startsWith('shadow:')||inboundAuthority!==null)fail('PHASE4_SHADOW_SIMULATION_REQUIRED');
      const row=(await client.execute({sql:'SELECT * FROM structured_answer_events WHERE user_id=? AND execution_mode=? AND source_update_id=?',
        args:[context.userId,context.executionMode,sourceUpdateId]})).rows[0];
      return !row?null:readableRow(row)?{status:'ACCEPT',created:false,answerEventId:row.answer_event_id,reply:null}:JSON.parse(REDACTED_RECEIPT);
    });
    if(replay)return replay;
    // A mismatched reply never reads question health content.
    if(replyToQuestionRequestId!==questionRequestId)fail('PHASE4_EXACT_QUESTION_REFERENCE_REQUIRED');
    const snapshot=(await core.artifact(context,'context_questions',{question_request_id:questionRequestId})).row;
    return transaction(async()=>{
      await core.assertContext(context);
      const control=await core.captureControl(context.userId),mode=context.executionMode;
      if(typeof sourceUpdateId!=='string'||!sourceUpdateId||sourceUpdateId.length>256)fail('PHASE4_ANSWER_SOURCE_REQUIRED');
      if(mode==='LIVE')await inbound.validate(control,inboundAuthority,sourceUpdateId);
      else if(!sourceUpdateId.startsWith('shadow:')||inboundAuthority!==null)fail('PHASE4_SHADOW_SIMULATION_REQUIRED');
      const prior=(await client.execute({sql:'SELECT * FROM structured_answer_events WHERE user_id=? AND execution_mode=? AND source_update_id=?',
        args:[context.userId,mode,sourceUpdateId]})).rows[0];
      if(prior)return readableRow(prior)?{status:'ACCEPT',created:false,answerEventId:prior.answer_event_id,reply:null}:JSON.parse(REDACTED_RECEIPT);
      if(mode==='LIVE') {
        const receipt=(await client.execute({sql:'SELECT owner_user_id,content_state FROM telegram_operations WHERE update_id=?',args:[sourceUpdateId]})).rows[0];
        if(receipt?.content_state==='REDACTED')return JSON.parse(REDACTED_RECEIPT);
        if(receipt)fail('PHASE4_ORIGIN_RECEIPT_ALREADY_COMMITTED');
      }
      requireInteger(expectedRevision);
      const slot=(await client.execute({sql:'SELECT * FROM phase4_question_interaction_slots WHERE user_id=? AND execution_mode=?',args:[context.userId,mode]})).rows[0];
      if(!slot||slot.question_request_id!==questionRequestId||slot.revision!==expectedRevision)fail('PHASE4_SLOT_CAS_LOST');
      if(!['AWAITING_ANSWER','AMBIGUOUS_WAIT'].includes(slot.state)||slot.answer_deadline<=timestamp())fail('PHASE4_ANSWER_WINDOW_CLOSED');
      if(replyToQuestionRequestId!==questionRequestId)fail('PHASE4_EXACT_QUESTION_REFERENCE_REQUIRED');
      if(slot.lifecycle_generation!==context.lifecycleGeneration||slot.auth_generation!==context.authGeneration)fail('PHASE4_ANSWER_GENERATION_STALE');
      const question=(await client.execute({sql:'SELECT * FROM context_questions WHERE user_id=? AND execution_mode=? AND question_request_id=?',
        args:[context.userId,mode,questionRequestId]})).rows[0];
      if(!question||canonicalJson({...question})!==canonicalJson(snapshot))fail('PHASE4_QUESTION_SNAPSHOT_STALE');
      const isCoverage=question.factor_question_kind.startsWith('COVERAGE:'),state=await core.assertControl(control);
      if(!isCoverage&&question.question_template_version!=='journal-factor-v1')fail('JOURNAL_ANSWER_TEMPLATE_REQUIRED');
      const parsed=isCoverage?coverage.prepare(question,candidate,sourceText,state):await journal.prepareAnswer(control,question,candidate,sourceText);
      if(parsed.status!=='ACCEPT')return parsed;
      const normalized=parsed.coverage??parsed.fact;
      // Parser confidence/wording are diagnostics, not semantic identity.
      const semantics=answerSemantics(normalized);
      let assertion=null,receiptArtifact=null,fresh=context;
      if(mode==='LIVE') {
        receiptArtifact=await inbound.answerReceipt(control,inboundAuthority,sourceUpdateId);
        assertion=isCoverage?await coverage.forAnswer(control,context,question,normalized,sourceUpdateId):
          await journal.forAnswer(control,context,question,normalized,sourceUpdateId);
        await queue.advanceSource(control.userId,'JOURNAL_CREATED');
        fresh=await core.capture(context.userId,{executionMode:mode});
      }
      const at=timestamp(),id=core.newId(),logicalId=keys.lookup(['question-answer-lineage-v1',context.userId,mode,questionRequestId]);
      const row={...core.envelope(fresh,'structured_answer_events',[sourceUpdateId]),answer_event_id:id,logical_answer_id:logicalId,
        answer_revision:1,question_request_id:questionRequestId,logical_fact_id:assertion?.logicalFactId??null,fact_revision:assertion?.logicalFactId?1:null,
        coverage_window_id:assertion?.coverageWindowId??null,source_update_id:sourceUpdateId,normalized_answer_json:canonicalJson(normalized),
        selected_followup_kind:null,supersedes_answer_event_id:null,input_generation:fresh.inputGeneration,lifecycle_generation:fresh.lifecycleGeneration,
        auth_generation:fresh.authGeneration,committed_at:at};
      row.answer_semantics_hash=keys.digest(row.content_digest_salt,canonicalJson([JOURNAL_VERSIONS.taxonomy,semantics]));
      const names=Object.keys(row);
      await client.execute({sql:`INSERT INTO structured_answer_events(${names.join(',')}) VALUES (${names.map(()=>'?').join(',')})`,args:names.map(k=>row[k])});
      const next=await slots.resolveValidated(control,mode,{questionRequestId,expectedRevision,logicalFactId:assertion?.logicalFactId??null});
      const refs=[];
      if(mode==='LIVE') {
        const source=isCoverage?await core.root(fresh,'JOURNAL_COVERAGE',assertion.coverageWindowId):await journal.read(fresh,assertion.logicalFactId);
        refs.push(source.ref,(await core.root(fresh,'TELEGRAM_OPERATION',sourceUpdateId)).ref);
        await addPrivacyLink(client,{userId:context.userId,table:'telegram_operations',artifactId:receiptArtifact,sourceType:isCoverage?'JOURNAL_COVERAGE':'JOURNAL_FACT',
          sourceId:isCoverage?assertion.coverageWindowId:source.row.privacy_artifact_id,at});
      } else refs.push((await core.root(fresh,'USER',context.userId)).ref);
      await core.link(fresh,'structured_answer_events',row.privacy_artifact_id,refs);
      await addPrivacyLink(client,{userId:context.userId,mode,table:'structured_answer_events',artifactId:row.privacy_artifact_id,
        sourceMode:mode,sourceType:'context_questions',sourceId:question.privacy_artifact_id,relationship:'ANSWER_LINEAGE',at});
      await core.artifact(fresh,'structured_answer_events',{answer_event_id:id});
      if(mode==='LIVE') {
        await inbound.validate(control,inboundAuthority,sourceUpdateId);
        core.processing.afterCommit(()=>transaction(()=>core.contextRegistry.release(fresh)));
      } else await core.assertContext(context);
      return {status:'ACCEPT',created:true,answerEventId:id,slot:next,...assertion,reply:null};
    });
  }
  return {accept};
}
