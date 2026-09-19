import { fail,readableRow,requireInteger } from './phase4Core.js';
import { canonicalJson } from './phase4EntityStore.js';
import { addPrivacyLink } from './phase4V22Backfill.js';
import { validateCoverageCandidate,JOURNAL_VERSIONS } from './journalFoundationValidation.js';
import { appendCorrectedAnswer,answerSemantics } from './journalAnswerRevision.js';

/** Shared assertions, never a daily coverage scheduler. Initial creation is
 * internal to acceptance of an occupied, utility-selected LIVE question. */
export function createPhase4CoverageStore(core,privacy) {
  const {client,keys,transaction,timestamp}=core;
  const get=async(uid,id)=>(await client.execute({sql:'SELECT * FROM journal_coverage_windows WHERE user_id=? AND coverage_window_id=?',args:[uid,id]})).rows[0];
  function normalize(candidate,sourceText,window,factors,state) {
    return validateCoverageCandidate(candidate,{sourceText,displayedWindow:window,displayedFactors:factors,timezone:state.timezone,now:core.now()});
  }
  async function insert(control,coverage,{id,key,generation,inputGeneration,revision=1,supersedes=null}) {
    const state=await core.assertControl(control),salt=keys.newSalt(),at=timestamp();
    const {confirmation_excerpt,...fields}=coverage;
    const row={...fields,user_id:control.userId,coverage_window_id:id,source_event_key:key,
      confirmation_text_hash:keys.digest(salt,confirmation_excerpt),lifecycle_generation:state.lifecycle_generation,auth_generation:state.auth_generation,
      input_generation:inputGeneration,status:'ACTIVE',revision,supersedes_coverage_window_id:supersedes,created_at:at,updated_at:at,
      content_state:'PRESENT',source_linkage_state:'COMPLETE',privacy_artifact_id:keys.lookup(['coverage-artifact-v1',control.userId,id]),
      content_digest_salt:salt,purge_generation:generation};
    const names=Object.keys(row);
    await client.execute({sql:`INSERT INTO journal_coverage_windows(${names.join(',')}) VALUES (${names.map(()=>'?').join(',')})`,args:names.map(k=>row[k])});
    await addPrivacyLink(client,{userId:control.userId,table:'journal_coverage_windows',artifactId:row.privacy_artifact_id,
      sourceType:'JOURNAL_COVERAGE',sourceId:id,relationship:`USER_CONFIRMATION:${JOURNAL_VERSIONS.factors}`,at});
    return {coverageWindowId:id,revision};
  }
  function validateQuestion(question) {
    if(question.question_template_version!=='journal-coverage-v1'||!question.factor_question_kind?.startsWith('COVERAGE:')
      ||!Number.isFinite(question.utility_score)||!Number.isFinite(question.eligibility_threshold)
      ||question.eligibility_threshold<=0||question.utility_score<question.eligibility_threshold)fail('JOURNAL_COVERAGE_UTILITY_QUESTION_REQUIRED');
    return question.factor_question_kind.slice(9).split(',');
  }
  function prepare(question,candidate,sourceText,state) {
    return normalize(candidate,sourceText,{start:question.target_window_start_utc,end:question.target_window_end_utc},validateQuestion(question),state);
  }
  async function forAnswer(control,context,question,coverage,sourceUpdateId) {
    if(!core.processing.active()||context.executionMode!=='LIVE')fail('PHASE4_LIVE_TRANSACTION_REQUIRED');
    await core.assertContext(context);await core.assertControl(control);
    if(context.userId!==control.userId||question.user_id!==control.userId||question.execution_mode!=='LIVE')fail('PHASE4_TENANT_MISMATCH');
    validateQuestion(question);
    const key=keys.lookup(['coverage-answer-source-v1',control.userId,sourceUpdateId]);
    return insert(control,coverage,{id:keys.lookup(['coverage-id-v1',control.userId,key]),key,generation:context.purgeGeneration,inputGeneration:context.inputGeneration+1});
  }
  privacy.registerReplacement('JOURNAL_COVERAGE',{
    async validate(control,value) {
      const state=await core.assertControl(control),prior=await get(control.userId,value?.coverageId);
      if(!prior||prior.revision!==value.expectedRevision||value.lifecycle!==state.lifecycle_generation||value.auth!==state.auth_generation
        ||value.timezone!==state.timezone||!value.coverage)fail('JOURNAL_COVERAGE_REVISION_CONFLICT');
      const c=value.coverage,checked=normalize({confirmed:true,extractionConfidence:c.answer_confidence,excerptStart:0,
        excerptEnd:[...c.confirmation_excerpt].length},c.confirmation_excerpt,{start:c.window_start_utc,end:c.window_end_utc},JSON.parse(c.factor_keys_json),state);
      if(checked.status!=='ACCEPT'||canonicalJson(checked.coverage)!==canonicalJson(c))fail('JOURNAL_COVERAGE_REPLACEMENT_INVALID');
      return value;
    },
    async commit(control,purge,value,staged) {
      const prior=await get(control.userId,value.coverageId);
      if(purge.target_source_id!==value.coverageId||prior.status!=='SUPERSEDED'||prior.content_state!=='REDACTED')fail('JOURNAL_COVERAGE_REVISION_CONFLICT');
      const computation=(await client.execute({sql:"SELECT input_generation FROM phase4_computation_state WHERE user_id=? AND execution_mode='LIVE'",args:[control.userId]})).rows[0];
      const replacement=await insert(control,value.coverage,{id:keys.lookup(['coverage-revision-v1',control.userId,value.coverageId,prior.revision+1]),
        key:staged.replacement_source_key,generation:purge.purge_generation,inputGeneration:(computation?.input_generation??0)+1,
        revision:prior.revision+1,supersedes:value.coverageId});
      await appendCorrectedAnswer(core,control,purge,{priorCoverageId:value.coverageId,coverageId:replacement.coverageWindowId,normalized:value.coverage});
    },
  });
  async function correct(control,{coverageWindowId,expectedRevision,candidate,sourceText,windowStart,windowEnd,factors,idempotencyKey}) {
    requireInteger(expectedRevision,1);await core.assertControl(control);
    const replay=(await client.execute({sql:'SELECT * FROM health_plaintext_purges WHERE user_id=? AND deletion_or_correction_idempotency_key=?',
      args:[control.userId,keys.lookup(['purge-command-v1',control.userId,idempotencyKey])]})).rows[0];
    if(replay) {
      if(replay.target_source_type!=='JOURNAL_COVERAGE'||replay.target_source_id!==coverageWindowId||replay.operation_kind!=='CORRECTION')fail('PHASE4_PURGE_REPLAY_CONFLICT');
      await privacy.redact(control,replay.purge_id);return {purgeId:replay.purge_id};
    }
    const prepared=await transaction(async()=>{
      const state=await core.assertControl(control),prior=await get(control.userId,coverageWindowId);
      if(state.pending_purge_count)fail('PHASE4_PURGE_FENCED');
      if(!readableRow(prior)||prior.status!=='ACTIVE'||prior.revision!==expectedRevision)fail('JOURNAL_COVERAGE_REVISION_CONFLICT');
      const original=JSON.parse(prior.factor_keys_json),set=factors??original,start=windowStart??prior.window_start_utc,end=windowEnd??prior.window_end_utc;
      // The existing displayed assertion may be narrowed, never silently
      // expanded to unlisted factors. Changed bounds require literal evidence.
      if(!Array.isArray(set)||set.some(f=>!original.includes(f)))fail('JOURNAL_COVERAGE_FACTOR_EXPANSION_FORBIDDEN');
      if((start!==prior.window_start_utc&&!sourceText.includes(start))||(end!==prior.window_end_utc&&!sourceText.includes(end)))
        return {status:'REQUIRE_CLARIFICATION',reasons:['EXPLICIT_COVERAGE_WINDOW_REQUIRED']};
      const result=normalize(candidate,sourceText,{start,end},set,state);if(result.status!=='ACCEPT')return result;
      const semantics=answerSemantics(result.coverage);
      if(canonicalJson(semantics)===canonicalJson(Object.fromEntries(Object.keys(semantics).map(k=>[k,prior[k]]))))
        return {unchanged:true,coverageWindowId,revision:expectedRevision};
      const replacement=await privacy.prepareReplacement(control,{targetType:'JOURNAL_COVERAGE',targetId:coverageWindowId,kind:'JOURNAL_COVERAGE',
        value:{coverageId:coverageWindowId,expectedRevision,coverage:result.coverage,lifecycle:state.lifecycle_generation,auth:state.auth_generation,timezone:state.timezone},
        sourceKey:keys.lookup(['coverage-correction-source-v1',control.userId,idempotencyKey]),parserVersion:JOURNAL_VERSIONS.parser,normalizerVersion:JOURNAL_VERSIONS.normalizer});
      return {replacement};
    });
    if(!prepared.replacement)return prepared;
    const purge=await privacy.admit(control,{targetType:'JOURNAL_COVERAGE',targetId:coverageWindowId,operationKind:'CORRECTION',idempotencyKey,replacement:prepared.replacement});
    await privacy.redact(control,purge.purge_id);return {purgeId:purge.purge_id};
  }
  async function remove(control,{coverageWindowId,idempotencyKey}) {
    const purge=await privacy.admit(control,{targetType:'JOURNAL_COVERAGE',targetId:coverageWindowId,idempotencyKey});
    await privacy.redact(control,purge.purge_id);return {purgeId:purge.purge_id};
  }
  return {prepare,forAnswer,correct,remove,read:(context,id)=>core.run(context,async()=>{
    const row=await get(context.userId,id);if(!row||row.status!=='ACTIVE')return null;
    return (await core.root(context,'JOURNAL_COVERAGE',id)).row;
  })};
}
