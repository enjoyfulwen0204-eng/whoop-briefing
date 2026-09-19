import { fail } from './phase4Core.js';
import { canonicalJson } from './phase4EntityStore.js';
import { addPrivacyLink } from './phase4V22Backfill.js';
import { JOURNAL_VERSIONS } from './journalFoundationValidation.js';

export const answerSemantics=value=>Object.fromEntries(Object.entries(value).filter(([k])=>!['raw_answer_excerpt','confirmation_excerpt',
  'extraction_confidence','answer_confidence','parser_version','normalizer_version','alignment_version','note'].includes(k)));

/** T1-only, separately validated new assertion. Opaque question/revision IDs
 * preserve lineage without recreating erased health-dependency edges. The new
 * event cannot reopen a slot or authorize an answer-followup send. */
export async function appendCorrectedAnswer(core,control,purge,{priorLogicalId=null,priorCoverageId=null,logicalId=null,factRevision=null,coverageId=null,normalized}) {
  if(!core.processing.active()||purge.operation_kind!=='CORRECTION')fail('PHASE4_TRANSACTION_REQUIRED');
  const {client,keys,timestamp}=core;
  const prior=(await client.execute({sql:`SELECT * FROM structured_answer_events WHERE user_id=? AND execution_mode='LIVE'
    AND ${priorLogicalId?'logical_fact_id=?':'coverage_window_id=?'} ORDER BY answer_revision DESC LIMIT 1`,args:[control.userId,priorLogicalId??priorCoverageId]})).rows[0];
  if(!prior)return null;
  if(prior.content_state!=='REDACTED')fail('PHASE4_PRIOR_ANSWER_NOT_REDACTED');
  const state=await core.assertControl(control),computation=(await client.execute({sql:"SELECT input_generation FROM phase4_computation_state WHERE user_id=? AND execution_mode='LIVE'",args:[control.userId]})).rows[0];
  if(!computation)fail('PHASE4_LIVE_STATE_REQUIRED');
  const sourceId=coverageId??(await client.execute({sql:'SELECT privacy_artifact_id FROM journal_events WHERE user_id=? AND logical_fact_id=? AND revision=?',args:[control.userId,logicalId,factRevision]})).rows[0]?.privacy_artifact_id;
  if(!sourceId)fail('PHASE4_ANSWER_ASSERTION_REQUIRED');
  const updateId=purge.source_update_id??`control:${purge.purge_id}`,id=core.newId(),salt=keys.newSalt(),at=timestamp();
  const row={user_id:control.userId,execution_mode:'LIVE',answer_event_id:id,logical_answer_id:prior.logical_answer_id,answer_revision:prior.answer_revision+1,
    question_request_id:prior.question_request_id,logical_fact_id:logicalId,fact_revision:factRevision,coverage_window_id:coverageId,
    source_update_id:updateId,normalized_answer_json:canonicalJson(normalized),answer_semantics_hash:keys.digest(salt,canonicalJson([JOURNAL_VERSIONS.taxonomy,answerSemantics(normalized)])),
    selected_followup_kind:null,supersedes_answer_event_id:prior.answer_event_id,input_generation:computation.input_generation+1,
    lifecycle_generation:state.lifecycle_generation,auth_generation:state.auth_generation,committed_at:at,content_state:'PRESENT',source_linkage_state:'COMPLETE',
    privacy_artifact_id:keys.lookup(['privacy-artifact-v1','structured_answer_events',control.userId,'LIVE',[updateId]]),content_digest_salt:salt,purge_generation:purge.purge_generation};
  const fields=Object.keys(row);
  await client.execute({sql:`INSERT INTO structured_answer_events(${fields.join(',')}) VALUES (${fields.map(()=>'?').join(',')})`,args:fields.map(k=>row[k])});
  await addPrivacyLink(client,{userId:control.userId,mode:'LIVE',table:'structured_answer_events',artifactId:row.privacy_artifact_id,
    sourceType:coverageId?'JOURNAL_COVERAGE':'JOURNAL_FACT',sourceId,at});
  // A controller-origin correction has the durable authenticated T0 command as
  // its source receipt; it must not fabricate an inbound Telegram operation.
  await addPrivacyLink(client,{userId:control.userId,mode:'LIVE',table:'structured_answer_events',artifactId:row.privacy_artifact_id,
    sourceType:'USER',sourceId:control.userId,relationship:`CORRECTION_RECEIPT:${purge.purge_id}`,at});
  return id;
}
