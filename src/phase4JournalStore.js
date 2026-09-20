import { fail,readableRow,requireInteger } from './phase4Core.js';
import { canonicalJson } from './phase4EntityStore.js';
import { addPrivacyLink } from './phase4V22Backfill.js';
import { validateJournalCandidate,alignJournalFact,classifyJournalExposure,JOURNAL_VERSIONS } from './journalFoundationValidation.js';
import { appendCorrectedAnswer,answerSemantics } from './journalAnswerRevision.js';

const SOURCE='phase4_journal';
const FACT_FIELDS=['category','subtype','numeric_value','text_value','unit','severity','note','event_at','event_end_at','time_scope',
  'health_date','health_date_alignment','recorded_timezone','exposure_state','extraction_confidence','raw_answer_excerpt',
  'parser_version','normalizer_version','alignment_version'];
const accepted=result=>{if(result.status!=='ACCEPT')fail(`JOURNAL_${result.status}`);return result.fact;};

/** Shared Journal sources require a separately branded source controller.
 * A SHADOW calculation context is never authority to create a real fact.
 * This module supplies persistence, not an enabled bot command or worker. */
export function createPhase4JournalStore(core,privacy,queue) {
  const {client,keys,transaction,timestamp}=core;
  const sourceKey=(uid,key)=>{
    if(typeof key!=='string'||!key||key.length>256)fail('JOURNAL_SOURCE_KEY_REQUIRED');
    return keys.lookup(['journal-source-v1',uid,SOURCE,key]);
  };
  const logical=(uid,key)=>keys.lookup(['journal-logical-v1',uid,SOURCE,key]);
  async function healthyControl(control) {
    const state=await core.assertControl(control);
    if(state.purge_generation===null||state.pending_purge_count!==0)fail('PHASE4_PURGE_FENCED');
    return state;
  }
  async function latest(uid,logicalId) {
    return (await client.execute({sql:'SELECT * FROM journal_events WHERE user_id=? AND logical_fact_id=? ORDER BY revision DESC LIMIT 1',args:[uid,logicalId]})).rows[0];
  }
  async function tombstone(uid,logicalId) {
    return (await client.execute({sql:'SELECT logical_fact_id FROM journal_event_tombstones WHERE user_id=? AND logical_fact_id=?',args:[uid,logicalId]})).rows[0];
  }
  async function wakes(uid,state) {
    if(state.auth_generation<1)return [];
    return [...(await client.execute({sql:`SELECT s.id,s.end_at FROM whoop_sleeps s WHERE s.user_id=? AND s.nap=0 AND s.score_state='SCORED'
      AND julianday(s.start_at)<julianday(s.end_at) AND julianday(s.end_at)<=julianday(?) AND julianday(s.synced_at)<=julianday(?)
      AND (s.updated_at IS NULL OR julianday(s.updated_at)<=julianday(?))
      AND EXISTS (SELECT 1 FROM whoop_resource_access a WHERE a.user_id=s.user_id AND a.resource='sleep' AND a.status='ACCESSIBLE'
        AND a.lifecycle_generation=? AND a.auth_generation=?)
      AND NOT EXISTS (SELECT 1 FROM whoop_resource_tombstones t WHERE t.user_id=s.user_id AND t.resource_type='sleep' AND t.resource_id=s.id AND t.state='ACTIVE')`,
      args:[uid,timestamp(),timestamp(),timestamp(),state.lifecycle_generation,state.auth_generation]})).rows];
  }
  async function normalize(control,candidate,sourceText,{prior=null}={}) {
    const state=await healthyControl(control);
    const result=validateJournalCandidate(candidate,{sourceText,timezone:state.timezone,now:core.now(),
      trustedEventAt:prior?.event_at??null,trustedEventEndAt:prior?.event_end_at??null,
      displayedWindow:prior?.time_scope==='HEALTH_DAY'?{start:prior.event_at,end:prior.event_end_at}:null});
    if(result.status!=='ACCEPT')return result;
    return {...result,fact:alignJournalFact(result.fact,await wakes(control.userId,state))};
  }
  async function insertFact(control,fact,{logicalId,revision,eventKey,purgeGeneration,supersedes=null,questionId=null,episodeId=null,coverageId=null}={}) {
    const id=keys.lookup(['journal-artifact-v1',control.userId,logicalId,revision]),at=timestamp();
    const row={...fact,user_id:control.userId,logical_fact_id:logicalId,revision,fact_status:'ACTIVE',source:SOURCE,source_event_key:eventKey,
      supersedes_event_id:supersedes,question_id:questionId,episode_id:episodeId,coverage_window_id:coverageId,created_at:at,updated_at:at,
      privacy_artifact_id:id,content_state:'PRESENT',source_linkage_state:'COMPLETE',content_digest_salt:keys.newSalt(),purge_generation:purgeGeneration};
    const fields=Object.keys(row);
    await client.execute({sql:`INSERT INTO journal_events(${fields.join(',')}) VALUES (${fields.map(()=>'?').join(',')})`,args:fields.map(k=>row[k])});
    await addPrivacyLink(client,{userId:control.userId,table:'journal_events',artifactId:id,sourceType:'JOURNAL_FACT',sourceId:id,
      relationship:`USER_ASSERTION:${JOURNAL_VERSIONS.taxonomy}`,at});
    if(coverageId)await addPrivacyLink(client,{userId:control.userId,table:'journal_events',artifactId:id,sourceType:'JOURNAL_COVERAGE',sourceId:coverageId,at});
    return {logicalFactId:logicalId,revision,created:true};
  }
  async function create(control,{candidate,sourceText,sourceEventKey}) {
    return transaction(async()=>{
      const state=await healthyControl(control),key=sourceKey(control.userId,sourceEventKey),logicalId=logical(control.userId,key);
      if(await tombstone(control.userId,logicalId))return {logicalFactId:logicalId,revision:null,created:false,redacted:true};
      const existing=(await client.execute({sql:'SELECT logical_fact_id,revision,content_state FROM journal_events WHERE user_id=? AND source_event_key=?',args:[control.userId,key]})).rows[0];
      if(existing)return {logicalFactId:existing.logical_fact_id,revision:existing.revision,created:false,redacted:existing.content_state==='REDACTED'};
      const validation=await normalize(control,candidate,sourceText);
      if(validation.status!=='ACCEPT')return validation;
      const result=await insertFact(control,validation.fact,{logicalId,revision:1,eventKey:key,purgeGeneration:state.purge_generation});
      await queue.advanceSource(control.userId,'JOURNAL_CREATED');
      const current=await healthyControl(control);if(current.purge_generation!==state.purge_generation)fail('PHASE4_PURGE_FENCED');
      return {...result,status:'ACCEPT'};
    });
  }
  async function read(context,logicalId) {
    return core.run(context,async()=>{
      const row=await latest(context.userId,logicalId);
      if(!row||row.fact_status!=='ACTIVE')return null;
      if(!readableRow(row))fail('CONTENT_REDACTED');
      const source=await core.root(context,'JOURNAL_FACT',row.privacy_artifact_id);
      return {...source,taxonomyVersion:JOURNAL_VERSIONS.taxonomy};
    });
  }
  async function list(context,{limit=100}={}) {
    requireInteger(limit,1);if(limit>500)fail('JOURNAL_PAGE_TOO_LARGE');
    return core.run(context,async()=>{
      const rows=(await client.execute({sql:`SELECT * FROM journal_events WHERE user_id=? AND fact_status='ACTIVE' AND content_state='PRESENT'
        AND source_linkage_state='COMPLETE' AND health_content_redacted_at IS NULL ORDER BY event_at DESC,logical_fact_id LIMIT ?`,args:[context.userId,limit]})).rows;
      return rows.map(row=>({...row,taxonomyVersion:row.normalizer_version==='legacy-v20'?'legacy-v20':JOURNAL_VERSIONS.taxonomy}));
    });
  }
  async function classify(context,window) {
    return core.run(context,async()=>{
      const facts=(await client.execute({sql:`SELECT * FROM journal_events WHERE user_id=? AND fact_status='ACTIVE' AND content_state='PRESENT'
        AND source_linkage_state='COMPLETE' AND health_content_redacted_at IS NULL`,args:[context.userId]})).rows;
      const coverage=(await client.execute({sql:`SELECT * FROM journal_coverage_windows WHERE user_id=? AND status='ACTIVE' AND content_state='PRESENT'
        AND source_linkage_state='COMPLETE' AND health_content_redacted_at IS NULL`,args:[context.userId]})).rows;
      return classifyJournalExposure({...window,facts,coverage});
    });
  }
  function normalizedCandidate(fact) {
    return {category:fact.category,eventAt:fact.event_at,eventEndAt:fact.event_end_at,timeScope:fact.time_scope,
      valueKind:fact.numeric_value!==null?'NUMERIC':fact.severity!==null?'ORDINAL':fact.text_value?'TEXT':fact.subtype?'CATEGORICAL':'PRESENCE',
      numericValue:fact.numeric_value,unit:fact.unit,severity:fact.severity,subtype:fact.subtype,textValue:fact.text_value,note:fact.note,
      exposureState:fact.exposure_state,extractionConfidence:fact.extraction_confidence,excerptStart:0,excerptEnd:[...fact.raw_answer_excerpt].length};
  }
  privacy.registerReplacement('JOURNAL_FACT',{
    async authorityStale(control,value) {
      const state=await core.assertControl(control);
      if(!value||!Object.hasOwn(value,'lifecycleGeneration')||!Object.hasOwn(value,'authGeneration')||!Object.hasOwn(value,'timezone'))return false;
      return value.lifecycleGeneration!==state.lifecycle_generation||value.authGeneration!==state.auth_generation||value.timezone!==state.timezone;
    },
    async validate(control,value) {
      const state=await core.assertControl(control);
      if(!value||Object.keys(value).some(k=>!['logicalId','expectedRevision','fact','lifecycleGeneration','authGeneration','timezone'].includes(k))
        ||typeof value.logicalId!=='string'||!Number.isSafeInteger(value.expectedRevision)||value.expectedRevision<1
        ||value.lifecycleGeneration!==state.lifecycle_generation||value.authGeneration!==state.auth_generation||value.timezone!==state.timezone
        ||!value.fact||Object.keys(value.fact).length!==FACT_FIELDS.length||FACT_FIELDS.some(k=>!Object.hasOwn(value.fact,k)))fail('JOURNAL_REPLACEMENT_INVALID');
      if(await tombstone(control.userId,value.logicalId))fail('JOURNAL_SUBJECT_DELETED');
      const prior=await latest(control.userId,value.logicalId);
      if(!prior||prior.revision!==value.expectedRevision)fail('JOURNAL_REVISION_CONFLICT');
      const f=value.fact,normalized=accepted(validateJournalCandidate(normalizedCandidate(f),{sourceText:f.raw_answer_excerpt,timezone:state.timezone,now:core.now(),
        trustedEventAt:f.event_at,trustedEventEndAt:f.event_end_at,
        displayedWindow:f.time_scope==='HEALTH_DAY'?{start:f.event_at,end:f.event_end_at}:null}));
      const aligned=alignJournalFact(normalized,await wakes(control.userId,state));
      if(canonicalJson(aligned)!==canonicalJson(f))fail('JOURNAL_REPLACEMENT_INVALID');
      return value;
    },
    async commit(control,purge,value,staged) {
      const prior=await latest(control.userId,value.logicalId);
      if(purge.target_source_id!==value.logicalId||prior?.revision!==value.expectedRevision||prior.content_state!=='REDACTED'
        ||prior.fact_status!=='SUPERSEDED')fail('JOURNAL_REVISION_CONFLICT');
      await insertFact(control,value.fact,{logicalId:value.logicalId,revision:prior.revision+1,eventKey:staged.replacement_source_key,
        purgeGeneration:purge.purge_generation,supersedes:prior.id,questionId:prior.question_id,episodeId:prior.episode_id});
      await appendCorrectedAnswer(core,control,purge,{priorLogicalId:value.logicalId,logicalId:value.logicalId,factRevision:prior.revision+1,normalized:value.fact});
    },
  });
  async function priorCommand(control,{logicalFactId,idempotencyKey,kind,sourceUpdateId=null}) {
    await core.assertPrivacyControl(control);
    const prior=(await client.execute({sql:'SELECT * FROM health_plaintext_purges WHERE user_id=? AND deletion_or_correction_idempotency_key=?',
      args:[control.userId,keys.lookup(['purge-command-v1',control.userId,idempotencyKey])]})).rows[0];
    if(prior&&(prior.target_source_type!=='JOURNAL_FACT'||prior.target_source_id!==logicalFactId||prior.operation_kind!==kind||prior.source_update_id!==sourceUpdateId))
      fail('PHASE4_PURGE_REPLAY_CONFLICT');
    return prior;
  }
  async function correct(control,{logicalFactId,expectedRevision,candidate,sourceText,idempotencyKey,sourceUpdateId=null,inboundAuthority=null}) {
    requireInteger(expectedRevision,1);
    const previous=await priorCommand(control,{logicalFactId,idempotencyKey,kind:'CORRECTION',sourceUpdateId});
    if(previous){await privacy.redact(control,previous.purge_id,{inboundAuthority});return {purgeId:previous.purge_id};}
    const prepared=await transaction(async()=>{
      const state=await healthyControl(control),prior=await latest(control.userId,logicalFactId);
      if(!prior||prior.fact_status!=='ACTIVE'||!readableRow(prior)||prior.revision!==expectedRevision)fail('JOURNAL_REVISION_CONFLICT');
      const validation=await normalize(control,candidate,sourceText,{prior});if(validation.status!=='ACCEPT')return validation;
      const answer=(await client.execute({sql:`SELECT answer_event_id FROM structured_answer_events WHERE user_id=? AND execution_mode='LIVE'
        AND logical_fact_id=? AND fact_revision=? AND content_state='PRESENT'`,args:[control.userId,logicalFactId,expectedRevision]})).rows[0];
      if(answer&&canonicalJson(answerSemantics(validation.fact))===canonicalJson(answerSemantics(Object.fromEntries(FACT_FIELDS.map(k=>[k,prior[k]])))))
        return {unchanged:true,logicalFactId,revision:expectedRevision,answerEventId:answer.answer_event_id};
      const replacement=await privacy.prepareReplacement(control,{targetType:'JOURNAL_FACT',targetId:logicalFactId,kind:'JOURNAL_FACT',
        value:{logicalId:logicalFactId,expectedRevision,fact:validation.fact,lifecycleGeneration:state.lifecycle_generation,authGeneration:state.auth_generation,timezone:state.timezone},
        sourceKey:sourceKey(control.userId,`correction:${idempotencyKey}`),parserVersion:JOURNAL_VERSIONS.parser,normalizerVersion:JOURNAL_VERSIONS.normalizer});
      return {replacement};
    });
    if(!prepared.replacement)return prepared;
    const purge=await privacy.admit(control,{targetType:'JOURNAL_FACT',targetId:logicalFactId,operationKind:'CORRECTION',
      idempotencyKey,replacement:prepared.replacement,sourceUpdateId,inboundAuthority});
    await privacy.redact(control,purge.purge_id,{inboundAuthority});return {purgeId:purge.purge_id};
  }
  async function remove(control,{logicalFactId,idempotencyKey,sourceUpdateId=null,inboundAuthority=null}) {
    const prior=await priorCommand(control,{logicalFactId,idempotencyKey,kind:'DELETION',sourceUpdateId});
    if(prior){await privacy.redact(control,prior.purge_id,{inboundAuthority});return {purgeId:prior.purge_id};}
    if(await tombstone(control.userId,logicalFactId))return {purgeId:null,deleted:true,replayed:true};
    const purge=await privacy.admit(control,{targetType:'JOURNAL_FACT',targetId:logicalFactId,idempotencyKey,sourceUpdateId,inboundAuthority});
    await privacy.redact(control,purge.purge_id,{inboundAuthority});return {purgeId:purge.purge_id};
  }
  async function realign(control,{logicalFactId,expectedRevision,idempotencyKey}) {
    const prior=await priorCommand(control,{logicalFactId,idempotencyKey,kind:'CORRECTION'});
    if(prior){await privacy.redact(control,prior.purge_id);return {purgeId:prior.purge_id};}
    const input=await transaction(async()=>{
      const state=await healthyControl(control),row=await latest(control.userId,logicalFactId);
      if(!row||!readableRow(row)||row.fact_status!=='ACTIVE'||row.revision!==expectedRevision)fail('JOURNAL_REVISION_CONFLICT');
      if(row.normalizer_version!==JOURNAL_VERSIONS.normalizer||typeof row.raw_answer_excerpt!=='string')fail('JOURNAL_EXPLICIT_REVALIDATION_REQUIRED');
      const fact=Object.fromEntries(FACT_FIELDS.map(k=>[k,row[k]]));
      const aligned=alignJournalFact({...fact,recorded_timezone:state.timezone},await wakes(control.userId,state));
      if(aligned.health_date===row.health_date&&aligned.health_date_alignment===row.health_date_alignment&&state.timezone===row.recorded_timezone)return null;
      return {candidate:normalizedCandidate(fact),sourceText:fact.raw_answer_excerpt};
    });
    if(!input)return {changed:false};
    return {...await correct(control,{logicalFactId,expectedRevision,idempotencyKey,...input}),changed:true};
  }
  async function resumeCorrection(control,{purgeId,expectedRevision,candidate,sourceText,inboundAuthority=null}) {
    requireInteger(expectedRevision,1);
    const prepared=await transaction(async()=>{
      const state=await core.assertControl(control),purge=await privacy.status(control,purgeId);
      if(purge.target_source_type!=='JOURNAL_FACT'||purge.operation_kind!=='CORRECTION'||purge.state!=='ADMITTED')fail('PHASE4_VALIDATED_REPLACEMENT_REQUIRED');
      const prior=await latest(control.userId,purge.target_source_id);
      if(!readableRow(prior)||prior.fact_status!=='ACTIVE'||prior.revision!==expectedRevision)fail('JOURNAL_REVISION_CONFLICT');
      const validation=validateJournalCandidate(candidate,{sourceText,timezone:state.timezone,now:core.now(),trustedEventAt:prior.event_at,trustedEventEndAt:prior.event_end_at,
        displayedWindow:prior.time_scope==='HEALTH_DAY'?{start:prior.event_at,end:prior.event_end_at}:null});
      if(validation.status!=='ACCEPT')return validation;
      const fact=alignJournalFact(validation.fact,await wakes(control.userId,state));
      const replacement=await privacy.prepareReplacement(control,{targetType:'JOURNAL_FACT',targetId:purge.target_source_id,kind:'JOURNAL_FACT',
        value:{logicalId:purge.target_source_id,expectedRevision,fact,lifecycleGeneration:state.lifecycle_generation,authGeneration:state.auth_generation,timezone:state.timezone},
        sourceKey:sourceKey(control.userId,`restaged:${purgeId}`),parserVersion:JOURNAL_VERSIONS.parser,normalizerVersion:JOURNAL_VERSIONS.normalizer});
      return {replacement};
    });
    if(!prepared.replacement)return prepared;
    await privacy.restage(control,purgeId,prepared.replacement,{inboundAuthority});await privacy.redact(control,purgeId,{inboundAuthority});return {purgeId};
  }
  async function prepareAnswer(control,question,candidate,sourceText) {
    const state=await healthyControl(control);
    const result=validateJournalCandidate(candidate,{sourceText,timezone:state.timezone,now:core.now(),
      displayedWindow:{start:question.target_window_start_utc,end:question.target_window_end_utc},displayedFactors:[question.factor_question_kind]});
    if(result.status!=='ACCEPT')return result;
    if(result.fact.category!==question.factor_question_kind||result.fact.event_at<question.target_window_start_utc
      ||result.fact.event_at>=question.target_window_end_utc||(result.fact.event_end_at&&result.fact.event_end_at>question.target_window_end_utc))
      return {status:'REQUIRE_CLARIFICATION',reasons:['QUESTION_FACTOR_WINDOW_MISMATCH']};
    return {...result,fact:alignJournalFact(result.fact,await wakes(control.userId,state))};
  }
  async function forAnswer(control,context,question,fact,sourceUpdateId) {
    if(!core.processing.active()||context.executionMode!=='LIVE')fail('PHASE4_LIVE_TRANSACTION_REQUIRED');
    await core.assertContext(context);await healthyControl(control);
    if(control.userId!==context.userId||question.user_id!==control.userId||question.execution_mode!=='LIVE')fail('PHASE4_TENANT_MISMATCH');
    const key=sourceKey(control.userId,`answer:${sourceUpdateId}`),logicalId=logical(control.userId,key);
    if(await tombstone(control.userId,logicalId))fail('JOURNAL_SUBJECT_DELETED');
    return insertFact(control,fact,{logicalId,revision:1,eventKey:key,purgeGeneration:context.purgeGeneration,
      questionId:question.question_request_id,episodeId:question.episode_id});
  }
  return {create,read,list,classify,correct,remove,realign,resumeCorrection,prepareAnswer,forAnswer};
}
