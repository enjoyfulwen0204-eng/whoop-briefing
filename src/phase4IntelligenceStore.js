import {analysisTable} from './stage8LiveAllocation.js';
import {assertFreshContextAndWorkOwner} from './phase4ReadControls.js';
import {AsyncLocalStorage} from 'node:async_hooks';
import { compareExact } from './phase4CanonicalOrder.js';
import { healthSourceVersion, canonicalSourceTime, canonicalSourceVersion } from './phase4SourceVersion.js';
import { createResultAuthority } from './phase4ResultAuthority.js';
import { requireSemanticTime } from './phase4EpisodeHistory.js';
import { fail, readableRow } from './phase4Core.js';
import { canonicalJson } from './phase4EntityStore.js';
import { insightIdentityKey } from './phase4InsightStore.js';
import { addDays, localDate } from './time.js';
import { phase4Metric, INTELLIGENCE_VERSIONS } from './phase4IntelligenceRegistry.js';
import { assessDataQuality, benjaminiHochberg, buildPersonalBaseline, evaluateJournalAssociation,
  evaluateMeaningfulChange, evidenceConfidence, recencyWeight, validMetricValue,
  validateEvidenceConfidence, compareBaselineSources } from './phase4Intelligence.js';
import { pearson, pValue } from './analytics/correlation.js';
import {metricUnitReceipt,metricRunReceipt,metricUnitWork,metricPreparationContinuation,withMetricPreparationContinuation,requireMetricUnitProof} from './phase4MetricUnitReceipt.js';
import {assertExecutionWorkOwner,currentDurableExecution,currentExecutionReceiptTransactionMarker,requireSettledOperation} from './phase4ExecutionContext.js';
import {createFamilyDirectory} from './phase4FamilyDirectory.js';
import {workStepOptions} from './phase4WorkStep.js';
import {processingReadObservationEpoch} from './processingTransaction.js';
import {requireOwnedCurrentBodyData,hasOwnedCurrentBodyData} from './phase4OperationReceipts.js';

// Data-transport selection only. Only the actual owned refresh calculation
// result can issue this one-use, same-root token; it grants no authority.
const metricResults=new WeakMap(),metricCaptures=new WeakMap(),ownedBodyMetricPurposes=new WeakMap();
const ownedBodyMetricObservations=new AsyncLocalStorage();
function ownedMetricRequestData(core,context,request){
  return canonicalJson({metricKey:request.metricKey,asOfUtc:request.asOfUtc,windowFamily:request.windowFamily,refresh:request.refresh,
    currentSource:core.validateReferences(context,[request.currentSource]).map(source=>[source.type,source.id,source.mode,source.historicalAsOf,source.row]),
    baselineSources:core.validateReferences(context,request.baselineSources).map(source=>[source.type,source.id,source.mode,source.historicalAsOf,source.row])});
}
export function requireOwnedBodyMetricPurpose(core,context,purpose){
  const data=ownedBodyMetricPurposes.get(purpose);
  if(!data||data.core!==core||data.context!==context||data.execution!==currentDurableExecution()||data.job!==core.jobAuthority()
    ||data.marker!==currentExecutionReceiptTransactionMarker()||data.epoch!==processingReadObservationEpoch(core.client)
    ||!['DOMAIN','AUTHORITY'].includes(data.purposeKind)||!metricPreparationContinuation(core,context)||data.request.metricKey!=='body_energy'||data.request.refresh!==true
    ||data.request.windowFamily!=='STAGE6_CURRENT_BODY_ENERGY'||data.request.baselineSources.length!==0
    ||data.planJson!==canonicalJson(data.prepared.plan)||data.requestJson!==ownedMetricRequestData(core,context,data.request)
    ||data.requestJson!==ownedMetricRequestData(core,context,data.prepared.request)
    ||data.runKey!==data.prepared.plan.runKey||data.inputHash!==data.prepared.plan.inputHash||data.itemKey!==data.prepared.plan.itemKey)fail('PHASE4_METRIC_PREPARATION_CAPTURE_REQUIRED');
  requireOwnedCurrentBodyData(core,context,data.request.currentSource);return data;
}
// Private DOMAIN/AUTHORITY read-purpose transport scope. The frame contains DATA only;
// each semantic use repeats the original row/control comparators. A mutation
// discards this transport and resumes the complete original generic reads.
export function currentOwnedBodyMetricObservation(core,context){
  const scope=ownedBodyMetricObservations.getStore();
  if(!scope||scope.core!==core||scope.context!==context||scope.execution!==currentDurableExecution()
    ||scope.job!==core.jobAuthority()||scope.marker!==currentExecutionReceiptTransactionMarker())return null;
  if(scope.epoch!==processingReadObservationEpoch(core.client))return null;
  return requireOwnedBodyMetricPurpose(core,context,scope.purpose);
}
function withOwnedBodyMetricObservations(core,context,purpose,work){
  const data=requireOwnedBodyMetricPurpose(core,context,purpose);
  return ownedBodyMetricObservations.run({core,context,purpose,execution:data.execution,job:data.job,
    marker:data.marker,epoch:data.epoch},work);
}
function markBodyMetricPreparationResult(core,context,request,result,ownedPurpose=null){
  const marker=currentExecutionReceiptTransactionMarker();
  if(request.metricKey==='body_energy'&&request.refresh===true&&request.baselineSources.length===0
    &&result.resultState==='REFRESH_PREPARED'&&marker&&metricPreparationContinuation(core,context))
    metricResults.set(result,{core,context,execution:currentDurableExecution(),job:core.jobAuthority(),marker,
      body:request.currentSource,item:result.item.ref,runId:result.run.row.run_id,ownedPurpose});
  return result;
}
export function issueBodyMetricPreparationCapture(core,context,result){
  const recorded=metricResults.get(result);metricResults.delete(result);
  if(!recorded||recorded.core!==core||recorded.context!==context||recorded.execution!==currentDurableExecution()
    ||recorded.job!==core.jobAuthority()||recorded.marker!==currentExecutionReceiptTransactionMarker())return null;
  requireSettledOperation();const token=Object.freeze({});metricCaptures.set(token,recorded);return token;
}

export function requireBodyMetricPreparationCapture(core,context,token,refs){
  const recorded=metricCaptures.get(token);metricCaptures.delete(token);
  if(!recorded||recorded.core!==core||recorded.context!==context||recorded.execution!==currentDurableExecution()
    ||recorded.job!==core.jobAuthority()||!recorded.marker||recorded.marker!==currentExecutionReceiptTransactionMarker()
    ||!metricPreparationContinuation(core,context))fail('PHASE4_METRIC_PREPARATION_CAPTURE_REQUIRED');
  const inputs=core.validateReferences(context,refs),body=core.validateReferences(context,[recorded.body])[0],item=core.validateReferences(context,[recorded.item])[0];
  if(!inputs.some(source=>source.type===body.type&&source.id===body.id)||!inputs.some(source=>source.type===item.type&&source.id===item.id)
    ||inputs.some(source=>source.type===body.type&&source.id===body.id?canonicalJson(source.row)!==canonicalJson(body.row)
      :source.type===item.type&&source.id===item.id?canonicalJson(source.row)!==canonicalJson(item.row):true))
    fail('PHASE4_METRIC_PREPARATION_CAPTURE_REQUIRED');
  requireSettledOperation();return recorded;
}

const ACTIVE = ['OPEN','UPDATING','ESCALATED','EXPLAINED','STABILIZING'];
const MERGE_GAP_MS = 36*60*60*1000;
const exactKeys = (value, keys) => value && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const validInstant = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const validHealthDate = value => typeof value==='string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && new Date(`${value}T00:00:00.000Z`).toISOString().slice(0,10)===value;
const sourceTimestamp = row => row.as_of_utc ?? row.end_at ?? row.updated_at ?? row.created_at ?? row.synced_at ?? null;
const ingestedTimestamp = row => row.synced_at ?? row.created_at ?? row.as_of_utc ?? null;

export function canonicalEpisodeData(context,{current,calculation,asOfUtc,confidence}) {
  const contract=phase4Metric(calculation.metricKey);
  return {episode_type:'METRIC_DEVIATION',severity:calculation.severity,current_confidence:Math.min(calculation.confidence,confidence.score),
    current_novelty:Number(calculation.novelty),explained_status:0,first_observed_at:current.observedAt,
    last_observed_at:current.observedAt,last_material_change_at:current.observedAt,
    expires_at:new Date(Date.parse(current.observedAt)+contract.episodeExpiryMs).toISOString(),
    health_window_start:current.observedAt,health_window_end:asOfUtc,timezone:context.timezone,
    semantic_summary_hash:calculation.semanticHash,max_semantic_severity_ordinal:calculation.severity};
}
export const canonicalAssociationClaim=(hypothesis,direction,status)=>status==='SUPPORTED'
  ? `${hypothesis.factor} has been repeatedly associated in your data with ${direction.toLowerCase()} ${hypothesis.outcomeMetric}.`
  : `${hypothesis.factor} may be associated with ${direction.toLowerCase()} ${hypothesis.outcomeMetric}; we are still checking.`;

export function canonicalMetricSourceValue(metricKey, source, context, asOfUtc) {
    const contract=phase4Metric(metricKey),row=source.row;
    if(!row||source.type!==contract.sourceType)fail('PHASE4_METRIC_SOURCE_MISMATCH');
    if(source.type==='sleep'&&(row.score_state!=='SCORED'||row.nap!==0))fail('PHASE4_METRIC_SOURCE_INVALID');
    if(source.type==='recovery'&&(row.score_state!=='SCORED'||row.user_calibrating!==0))fail('PHASE4_METRIC_SOURCE_INVALID');
    if(source.type==='cycle'&&row.score_state!==null&&row.score_state!==undefined&&row.score_state!=='SCORED')fail('PHASE4_METRIC_SOURCE_INVALID');
    if(source.type==='body_energy_results'&&!['LIMITED','AVAILABLE'].includes(row.quality_state))fail('PHASE4_METRIC_SOURCE_INVALID');
    const raw=row[contract.field],value=typeof raw==='number'&&Number.isFinite(raw)?raw/(contract.divisor??1):raw;
    const observedAt=canonicalSourceTime(sourceTimestamp(row)),ingestedAt=canonicalSourceTime(ingestedTimestamp(row));
    if(!validInstant(observedAt)||!validInstant(ingestedAt)||!validInstant(asOfUtc)
      ||Date.parse(observedAt)>Date.parse(asOfUtc)||Date.parse(ingestedAt)>Date.parse(asOfUtc)
      ||(row.updated_at!==null&&row.updated_at!==undefined
        &&(!validInstant(row.updated_at)||Date.parse(row.updated_at)>Date.parse(asOfUtc))))fail('PHASE4_METRIC_SOURCE_INVALID');
    const healthDate=row.health_date??localDate(new Date(observedAt),context.timezone);
    const versionKnown=!['sleep','recovery','cycle'].includes(source.type)||row.updated_at!==null&&row.updated_at!==undefined;
    return {sourceType:source.type,sourceId:source.id,sourceVersion:healthSourceVersion(row),healthDate,observedAt,ingestedAt,value,versionKnown};
}

export function canonicalAssociationOutcomeValue(metricKey,source,context,asOfUtc) {
    const contract=phase4Metric(metricKey),row=source.row;
    if(!row||source.type!==contract.sourceType)fail('PHASE4_METRIC_SOURCE_MISMATCH');
    const raw=row[contract.field],value=typeof raw==='number'&&Number.isFinite(raw)?raw/(contract.divisor??1):raw,
      observedAt=canonicalSourceTime(sourceTimestamp(row)),ingestedAt=canonicalSourceTime(ingestedTimestamp(row));
    if(!validInstant(observedAt)||!validInstant(ingestedAt)||Date.parse(observedAt)>Date.parse(asOfUtc)
      ||Date.parse(ingestedAt)>Date.parse(asOfUtc)||(row.updated_at!=null&&(!validInstant(row.updated_at)
        ||Date.parse(row.updated_at)>Date.parse(asOfUtc))))fail('PHASE4_METRIC_SOURCE_INVALID');
    const healthDate=row.health_date??localDate(new Date(observedAt),context.timezone);
    if(!validHealthDate(healthDate))fail('PHASE4_METRIC_SOURCE_INVALID');
    const scored=source.type==='sleep'?row.score_state==='SCORED'&&row.nap===0
      :source.type==='recovery'?row.score_state==='SCORED'&&row.user_calibrating===0
      :source.type==='cycle'?row.score_state==null||row.score_state==='SCORED'
      :source.type==='body_energy_results'?['LIMITED','AVAILABLE'].includes(row.quality_state):true;
    const versionKnown=!['sleep','recovery','cycle'].includes(source.type)||row.updated_at!=null;
    return {sourceType:source.type,sourceId:source.id,sourceVersion:healthSourceVersion(row),healthDate,observedAt,ingestedAt,value:scored&&versionKnown
        &&validMetricValue(metricKey,value)?value:null,outcomeStatus:scored&&versionKnown&&validMetricValue(metricKey,value)
        ?'PRESENT':'INVALID',versionKnown};
  }

export function createPhase4IntelligenceStore(core, entities, episodes, insights,{producedEvidence=()=>{},recordedMetricPreparation=async()=>false,
  prepareCurrentBodyMetricRequest=()=>fail('BODY_ENERGY_CURRENT_DRAIN_REQUIRED'),
  metricDomainWork=()=>fail('PHASE4_METRIC_UNIT_RECEIPT_REQUIRED'),
  performMetricDomain=()=>fail('PHASE4_METRIC_UNIT_RECEIPT_REQUIRED'),replayMetricDomain=()=>fail('PHASE4_METRIC_UNIT_RECEIPT_REQUIRED'),takeMetricDomainProgress=()=>false,
  discoverInsightPredecessor=()=>fail('PHASE4_OPERATION_RESULT_UNAVAILABLE'),
  resolveInsightLifecycle=()=>fail('PHASE4_OPERATION_RESULT_UNAVAILABLE')}={}) {
  const {client,keys}=core,authorities=createResultAuthority(core),sourceValue=canonicalMetricSourceValue,associationOutcomeValue=canonicalAssociationOutcomeValue;
  async function sources(context,metricKey,currentSource,baselineSources,asOfUtc) {
    if(!Array.isArray(baselineSources)||baselineSources.length>64)fail('PHASE4_BASELINE_INPUT_BOUNDED');
    const refs=[currentSource,...baselineSources];
    if(!currentSource||new Set(refs).size!==refs.length)fail('PHASE4_METRIC_SOURCES_REQUIRED');
    const resolved=await core.revalidateSources(context,refs);
    return {refs,current:sourceValue(metricKey,resolved[0],context,asOfUtc),
      baseline:resolved.slice(1).map(source=>sourceValue(metricKey,source,context,asOfUtc)).sort(compareBaselineSources)};
  }
  function family(context,identity) {
    return keys.lookup(['episode-family-v1',context.userId,identity.domain,identity.metric,identity.algorithmMajor,identity.subject,identity.windowFamily]);
  }
  async function activeEpisode(context,identity,observedAt) {
    const row=(await client.execute({sql:`SELECT * FROM observation_episodes WHERE user_id=? AND execution_mode=?
      AND episode_family_key=? AND state IN ('OPEN','UPDATING','ESCALATED','EXPLAINED','STABILIZING')`,
    args:[context.userId,context.executionMode,family(context,identity)]})).rows[0];
    if(!row)return null;
    if(!readableRow(row))fail('CONTENT_REDACTED');
    if(row.input_generation!==context.inputGeneration||row.lifecycle_generation!==context.lifecycleGeneration
      ||row.auth_generation!==context.authGeneration||row.invalidated_at)fail('PHASE4_REANALYSIS_REQUIRED');
    await core.validateStoredGraph(context,'observation_episodes',row.privacy_artifact_id);
    const gap=Date.parse(observedAt)-Date.parse(row.last_observed_at);
    if(!Number.isFinite(gap)||gap<0)fail('PHASE4_EPISODE_TIME_ORDER_INVALID');
    return {row,continuous:gap<=MERGE_GAP_MS,gapMs:gap};
  }
  async function recentResolvedEpisode(context,identity,direction,asOfUtc) {
    const fingerprint=keys.lookup(['episode-fingerprint-v1',family(context,identity),direction]);
    const row=(await client.execute({sql:`SELECT * FROM observation_episodes WHERE user_id=? AND execution_mode=?
      AND fingerprint=? AND state='RESOLVED' AND resolved_at IS NOT NULL ORDER BY resolved_at DESC LIMIT 1`,
    args:[context.userId,context.executionMode,fingerprint]})).rows[0];
    if(!row||Date.parse(asOfUtc)-Date.parse(row.resolved_at)>7*86400000
      ||Date.parse(asOfUtc)<Date.parse(row.resolved_at))return null;
    if(!readableRow(row))fail('CONTENT_REDACTED');
    await core.validateStoredGraph(context,'observation_episodes',row.privacy_artifact_id);
    return row;
  }
  function manifest(metricKey,current,baseline,quality,calculation,asOfUtc,windowFamily) {
    return {manifest_version:'phase4-metric-evidence-input-v2',identity_profile:'stage5-metric-request-v2',window_family:windowFamily,metric_key:metricKey,as_of_utc:asOfUtc,current,
      baseline:{version:baseline.version,target_health_date:baseline.targetHealthDate,lookback_days:baseline.lookbackDays,
        samples:baseline.samples,exclusions:baseline.exclusions,median:baseline.median,mad:baseline.mad,q1:baseline.q1,q3:baseline.q3,
        scale:baseline.scale,scale_method:baseline.scaleMethod},quality,calculation};
  }
  function metricEvidencePlan(context,{metricKey,sourceSet,baseline,quality,calculation,asOfUtc,windowFamily,refresh=false}) {
    const input={...manifest(metricKey,sourceSet.current,baseline,quality,calculation,asOfUtc,windowFamily),
      ...(refresh?{refresh_preparation:true,prior_qualifying:sourceSet.baseline.map(source=>({observedAt:source.observedAt,
        robustZ:baseline.scale?(source.value-baseline.median)/baseline.scale:null,
        direction:baseline.scale?source.value>=baseline.median?'HIGHER':'LOWER':null}))}:{}),
      request_scope:{timezone:context.timezone,algorithm:context.algorithmSetVersion,versions:INTELLIGENCE_VERSIONS,
        ...(refresh?{source:context.sourceGeneration}:{}),
        input:context.inputGeneration,lifecycle:context.lifecycleGeneration,auth:context.authGeneration,purge:context.purgeGeneration}},json=canonicalJson(input);
    const inputHash=keys.lookup(['phase4-evidence-input-v2',context.userId,context.executionMode,context.inputGeneration,json]);
    const runKey=keys.lookup(['phase4-evidence-run-v2',context.userId,context.executionMode,'PERSONAL_BASELINE_DEVIATION',
      metricKey,asOfUtc,context.inputGeneration,inputHash]);
    const recency=recencyWeight((Date.parse(asOfUtc)-Date.parse(sourceSet.current.observedAt))/86400000);
    const confidence=evidenceConfidence({dataQuality:quality.confidence,
      sampleSufficiency:Math.min(1,baseline.sampleCount/phase4Metric(metricKey).baselineTarget),
      replication:calculation.persistent?1:calculation.severeSingle?.5:0,effectStability:calculation.openPass?1:0,
      recency,multiplicityControl:1,uncertaintyAvailable:baseline.scale!==null});
    const itemKey=keys.lookup(['phase4-evidence-item-v1',runKey,'baseline-deviation']);
    return {input,inputHash,runKey,itemKey,recency,confidence};
  }
  function metricItemData(metricKey,sourceSet,baseline,quality,calculation,plan) {
    return {run_id:null,item_key:plan.itemKey,claim_key:`metric:${metricKey}`,direction:calculation.direction,
      unit:phase4Metric(metricKey).unit,effect:calculation.absoluteDelta,lower_bound:baseline.q1,upper_bound:baseline.q3,
      raw_significance:null,adjusted_significance:null,exposed_count:null,confirmed_unexposed_count:null,unknown_count:null,
      effective_sample_count:baseline.sampleCount,exposure_classification_version:INTELLIGENCE_VERSIONS.exposureClassification,
      factor_set_version:INTELLIGENCE_VERSIONS.factorSet,quality:quality.status,recency_weight:plan.recency,
      causal_status:'ASSOCIATION_ONLY',provenance_json:{method:'CURRENT_VS_ROBUST_BASELINE',baseline_version:baseline.version,
        registry_version:INTELLIGENCE_VERSIONS.registry,current:sourceSet.current,absolute_delta:calculation.absoluteDelta,
        relative_delta:calculation.relativeDelta,robust_z:calculation.robustZ,meaningfulness:calculation.meaningfulness,
        persistent:calculation.persistent,severe_single:calculation.severeSingle,semantic_hash:calculation.semanticHash,
        confidence:plan.confidence},confound_json:{hard_flags:quality.status==='DEGRADED'?quality.reasonCodes:[],
        soft_flags:quality.status==='LIMITED'?quality.reasonCodes:[]}};
  }
  function validateMetricItem(row,data,runId) {
    for(const [key,value] of Object.entries({...data,run_id:runId})) {
      const expected=key.endsWith('_json')&&value!==null?canonicalJson(value):value;
      if(row[key]!==expected)fail('PHASE4_EVIDENCE_REPLAY_CONFLICT');
    }
  }
  async function durableEvidence(context,{metricKey,sourceSet,baseline,quality,calculation,asOfUtc,plan}) {
    const {input,inputHash,runKey}=plan;
    let runRow=(await client.execute({sql:'SELECT * FROM evidence_runs WHERE user_id=? AND execution_mode=? AND deterministic_run_key=?',
      args:[context.userId,context.executionMode,runKey]})).rows[0],run;
    if(runRow) {
      if(!readableRow(runRow)||runRow.invalidated_at)fail('CONTENT_REDACTED');
      if(runRow.state!=='COMPLETED'||runRow.input_manifest_hash!==inputHash
        ||runRow.input_manifest_json!==canonicalJson(input))fail('PHASE4_EVIDENCE_REPLAY_CONFLICT');
      run=await core.artifact(context,'evidence_runs',{run_id:runRow.run_id});
    } else {
      run=await entities.append(context,'evidence_runs',{deterministic_run_key:runKey,subject_key:metricKey,
        method:'PERSONAL_BASELINE_DEVIATION',window_start_utc:baseline.samples.at(-1)?.observedAt??sourceSet.current.observedAt,
        window_end_utc:sourceSet.current.observedAt,as_of_utc:asOfUtc,timezone:context.timezone,
        algorithm_version:INTELLIGENCE_VERSIONS.algorithm,registry_version:INTELLIGENCE_VERSIONS.registry,
        evidence_contract_version:INTELLIGENCE_VERSIONS.evidenceContract,
        promotion_confound_version:INTELLIGENCE_VERSIONS.promotionConfound,
        exposure_classification_version:INTELLIGENCE_VERSIONS.exposureClassification,
        factor_set_version:INTELLIGENCE_VERSIONS.factorSet,state:'STARTED',started_at:asOfUtc},sourceSet.refs);
      run=await entities.completeEvidence(context,run.row.run_id,{sample_count:baseline.sampleCount,
        exclusion_count:baseline.exclusions.length,input_manifest_json:input,input_manifest_hash:inputHash,
        missingness_json:{quality_state:quality.status,reason_codes:quality.reasonCodes}});
    }
    const itemData=metricItemData(metricKey,sourceSet,baseline,quality,calculation,plan);
    const item=await entities.append(context,'evidence_items',{...itemData,run_id:run.row.run_id},sourceSet.refs);
    const storedConfidence=durableConfidence(item);
    if(canonicalJson(storedConfidence)!==canonicalJson(plan.confidence))fail('PHASE4_EVIDENCE_CONFIDENCE_REPLAY_CONFLICT');
    if(!runRow&&item.created)producedEvidence(context,{run,item});
    return {run,item,inputHash,confidence:storedConfidence};
  }
  async function linkMembership(context,episode,item,sourceSet,calculation,confidence) {
    if(!['LIMITED','AVAILABLE'].includes(calculation.qualityStatus)
      ||confidence?.version!==INTELLIGENCE_VERSIONS.evidenceConfidence||!Number.isFinite(confidence.score))
      fail('PHASE4_EPISODE_EVIDENCE_NOT_QUALIFIED');
    const observationKey=keys.lookup(['phase4-observation-v1',context.userId,context.executionMode,episode.row.episode_id,
      sourceSet.current.sourceType,sourceSet.current.sourceId,sourceSet.current.sourceVersion]);
    const candidates=(await client.execute({sql:`SELECT * FROM episode_observations WHERE user_id=? AND execution_mode=?
      AND episode_id=? AND source_type=? AND source_id=? LIMIT 1001`,args:[context.userId,context.executionMode,episode.row.episode_id,
        sourceSet.current.sourceType,sourceSet.current.sourceId]})).rows;
    if(candidates.length>1000)fail('PHASE4_OBSERVATION_DISCOVERY_UNAVAILABLE');
    const aliases=candidates.filter(row=>canonicalSourceVersion(row.source_version)===sourceSet.current.sourceVersion);
    if(aliases.length>1)fail('PHASE4_LEGACY_IDENTITY_AMBIGUOUS');
    const prior=aliases[0];
    const observation=prior?await core.artifact(context,'episode_observations',{episode_id:episode.row.episode_id,observation_key:prior.observation_key})
      :await entities.append(context,'episode_observations',{episode_id:episode.row.episode_id,observation_key:observationKey,
        source_type:sourceSet.current.sourceType,source_id:sourceSet.current.sourceId,source_version:sourceSet.current.sourceVersion,
        observed_at:sourceSet.current.observedAt,health_date:sourceSet.current.healthDate,normalized_value:sourceSet.current.value,
        unit:phase4Metric(calculation.metricKey).unit,robust_z:calculation.robustZ,meaningfulness:calculation.meaningfulness,
        quality:calculation.qualityStatus,added_at:sourceSet.current.observedAt},[item.ref,...sourceSet.refs]);
    const evidence=await entities.append(context,'episode_evidence',{episode_id:episode.row.episode_id,evidence_item_id:item.row.evidence_item_id,
      episode_revision:episode.row.revision,relationship_type:calculation.qualified?'SUPPORTING':'RESOLVING',
      linked_at:sourceSet.current.observedAt},[item.ref]);
    return {observation,evidence};
  }
  function semanticEvent(eventKind,calculation) {
    return {eventKind,severityOrdinal:calculation.severity,claimKey:`metric:${calculation.metricKey}`,
      semanticContentHash:calculation.semanticHash};
  }
  function episodeData(context,sourceSet,calculation,asOfUtc,confidence) {
    return canonicalEpisodeData(context,{current:sourceSet.current,calculation,asOfUtc,confidence});
  }
  function replayClassification(event,episodeRow,observationCalculation) {
    if(event.resulting_revision===1)return episodeRow.reverses_episode_id?'DIRECTION_REVERSAL':observationCalculation.classification;
    return {NEW_EVIDENCE:'CONTINUING_CHANGE',SEVERITY_CROSSING:'WORSENING',CLOSE_THRESHOLD:'IMPROVING',
      RESOLUTION_HOLD:'RESOLVED'}[event.reason]??observationCalculation.classification;
  }
  function replayTargetState(classification,event) {
    if(classification==='NEW_CHANGE')return 'OPEN';
    if(['WORSENING','DIRECTION_REVERSAL'].includes(classification))return 'ESCALATED';
    if(classification==='CONTINUING_CHANGE')return event.from_state==='STABILIZING'?'UPDATING':event.from_state;
    if(classification==='IMPROVING')return 'STABILIZING';
    if(classification==='RESOLVED')return 'RESOLVED';
    return null;
  }
  async function historicalEpisodeReplay(context,{item,sourceSet,baseline,quality,priorQualifying,
    observationCalculation,asOfUtc}) {
    const authority=await authorities.metricOrigin(context,item.row.evidence_item_id);
    const links=(await client.execute({sql:`SELECT * FROM episode_evidence WHERE user_id=? AND execution_mode=?
      AND evidence_item_id=? ORDER BY episode_revision`,args:[context.userId,context.executionMode,item.row.evidence_item_id]})).rows;
    if(!links.length) {
      if(authority.origin!==null)fail('PHASE4_DURABLE_REPLAY_BINDING_INVALID');
      if(!authority.calculation)fail('PHASE4_EVIDENCE_RESULT_AUTHORITY_UNAVAILABLE');
      return {calculation:Object.freeze(authority.calculation),episode:null};
    }
    if(links.length!==1||links[0].unlinked_at!==null||!readableRow(links[0]))fail('CONTENT_REDACTED');
    const binding=await core.artifact(context,'episode_evidence',{episode_id:links[0].episode_id,
      evidence_item_id:item.row.evidence_item_id});
    const historical=await episodes.readRevision(context,{episodeId:binding.row.episode_id,revision:binding.row.episode_revision,
      evidenceItemId:item.row.evidence_item_id,semanticAt:asOfUtc});
    const observationRows=(await client.execute({sql:`SELECT * FROM episode_observations WHERE user_id=? AND execution_mode=?
      AND episode_id=? AND source_type=? AND source_id=? AND source_version=?`,args:[context.userId,context.executionMode,
      binding.row.episode_id,sourceSet.current.sourceType,sourceSet.current.sourceId,sourceSet.current.sourceVersion]})).rows;
    if(observationRows.length!==1)fail('PHASE4_DURABLE_REPLAY_BINDING_INVALID');
    const observation=await core.artifact(context,'episode_observations',{episode_id:binding.row.episode_id,
      observation_key:observationRows[0].observation_key});
    const eventRow=(await client.execute({sql:`SELECT * FROM episode_events WHERE user_id=? AND execution_mode=?
      AND episode_id=? AND resulting_revision=?`,args:[context.userId,context.executionMode,binding.row.episode_id,
      binding.row.episode_revision]})).rows[0];
    if(!eventRow)fail('PHASE4_DURABLE_REPLAY_BINDING_INVALID');
    const event=await core.artifact(context,'episode_events',{episode_event_id:eventRow.episode_event_id});
    if(event.row.resulting_revision!==binding.row.episode_revision)fail('PHASE4_DURABLE_REPLAY_BINDING_INVALID');
    // This is an immutable calculation input captured at original commit;
    // later membership ordering cannot change historical novelty.
    const priorHash=authority.origin.prior_semantic_hash;
    const replayBase=evaluateMeaningfulChange({metricKey:observationCalculation.metricKey,current:sourceSet.current,baseline,quality,
      priorQualifying,recentSemanticHashes:priorHash?[priorHash]:[],nowUtc:asOfUtc});
    const classification=replayClassification(event.row,historical.row,observationCalculation);
    const calculation=Object.freeze({...replayBase,classification,targetEpisodeState:replayTargetState(classification,event.row)});
    if(observation.row.observed_at!==sourceSet.current.observedAt||observation.row.robust_z!==calculation.robustZ
      ||observation.row.quality!==calculation.qualityStatus)fail('PHASE4_DURABLE_REPLAY_BINDING_INVALID');
    return {calculation,episode:{episode:historical,created:false,replayed:true,
      historicalRevision:binding.row.episode_revision}};
  }
  async function exactMetricReplay(context,{metricKey,sourceSet,baseline,quality,priorQualifying,observationCalculation,asOfUtc,plan}) {
    const runRow=(await client.execute({sql:`SELECT * FROM evidence_runs WHERE user_id=? AND execution_mode=? AND deterministic_run_key=?`,
      args:[context.userId,context.executionMode,plan.runKey]})).rows[0];
    if(!runRow)return null;
    if(!readableRow(runRow)||runRow.invalidated_at)fail('CONTENT_REDACTED');
    if(runRow.state!=='COMPLETED'||runRow.input_manifest_hash!==plan.inputHash
      ||runRow.input_manifest_json!==canonicalJson(plan.input))fail('PHASE4_EVIDENCE_REPLAY_CONFLICT');
    const run=await core.artifact(context,'evidence_runs',{run_id:runRow.run_id});
    const itemRow=(await client.execute({sql:`SELECT * FROM evidence_items WHERE user_id=? AND execution_mode=? AND run_id=? AND item_key=?`,
      args:[context.userId,context.executionMode,run.row.run_id,plan.itemKey]})).rows[0];
    if(!itemRow)fail('PHASE4_DURABLE_REPLAY_BINDING_INVALID');
    if(!readableRow(itemRow)||itemRow.invalidated_at)fail('CONTENT_REDACTED');
    const item=await core.artifact(context,'evidence_items',{evidence_item_id:itemRow.evidence_item_id});
    validateMetricItem(item.row,metricItemData(metricKey,sourceSet,baseline,quality,observationCalculation,plan),run.row.run_id);
    const storedConfidence=durableConfidence(item);
    if(canonicalJson(storedConfidence)!==canonicalJson(plan.confidence))fail('PHASE4_EVIDENCE_CONFIDENCE_REPLAY_CONFLICT');
    const historical=await historicalEpisodeReplay(context,{item,sourceSet,baseline,quality,priorQualifying,
      observationCalculation,confidence:storedConfidence,asOfUtc});
    return {run,item,inputHash:plan.inputHash,confidence:storedConfidence,...historical};
  }
  async function episodeForEvidence(context,{identity,active,staleActive,sourceSet,calculation,item,asOfUtc,confidence}) {
    if(calculation.classification==='NO_MEANINGFUL_CHANGE'||!calculation.targetEpisodeState)return null;
    if((await client.execute({sql:`SELECT 1 FROM episode_evidence WHERE user_id=? AND execution_mode=? AND evidence_item_id=?`,
      args:[context.userId,context.executionMode,item.row.evidence_item_id]})).rows.length) {
      fail('PHASE4_DURABLE_REPLAY_BINDING_INVALID');
    }
    if(staleActive)await episodes.revise(context,{episodeId:staleActive.episode_id,expectedRevision:staleActive.revision,toState:'EXPIRED',
      patch:{latest_evidence_item_id:staleActive.latest_evidence_item_id},sourceRefs:[item.ref],reasonCode:'CONTINUITY_GAP',
      continuityGapPassed:true,semanticAt:asOfUtc,resolutionHoldMs:phase4Metric(calculation.metricKey).resolutionHoldMs});
    if(!active) {
      const reopened=await recentResolvedEpisode(context,identity,calculation.direction,asOfUtc);
      const opened=await episodes.open(context,{identity:{...identity,direction:calculation.direction},data:episodeData(context,sourceSet,calculation,asOfUtc,confidence),
        evidenceItemId:item.row.evidence_item_id,reopensEpisodeId:reopened?.episode_id??null,semanticAt:asOfUtc,semanticEvent:semanticEvent('OPENED',calculation)});
      await linkMembership(context,opened,item,sourceSet,calculation,confidence);
      return {episode:await episodes.read(context,opened.row.episode_id),created:true,replayed:false};
    }
    const patch={severity:calculation.severity,current_confidence:Math.min(calculation.confidence,confidence.score),current_novelty:Number(calculation.novelty),
      last_observed_at:sourceSet.current.observedAt,latest_evidence_item_id:item.row.evidence_item_id,
      semantic_summary_hash:calculation.semanticHash,max_semantic_severity_ordinal:Math.max(active.max_semantic_severity_ordinal??0,calculation.severity)};
    if(calculation.classification==='DIRECTION_REVERSAL') {
      const reversed=await episodes.reverse(context,{prior:{episodeId:active.episode_id,expectedRevision:active.revision,patch,
        sourceRefs:[item.ref],reasonCode:'DIRECTION_REVERSAL'},opposite:{identity:{...identity,direction:calculation.direction},
        data:episodeData(context,sourceSet,calculation,asOfUtc,confidence),evidenceItemId:item.row.evidence_item_id,semanticEvent:semanticEvent('OPENED',calculation)},semanticAt:asOfUtc});
      await linkMembership(context,reversed,item,sourceSet,calculation,confidence);
      return {episode:await episodes.read(context,reversed.row.episode_id),created:true,replayed:false,reversedEpisodeId:active.episode_id};
    }
    let toState=active.state,reasonCode='NEW_EVIDENCE',closeThresholdPassed=false,semanticKind=null;
    if(calculation.classification==='WORSENING') {
      toState='ESCALATED';reasonCode='SEVERITY_CROSSING';
      semanticKind=active.state==='ESCALATED'?'MATERIAL_ESCALATION':'ESCALATED';
    } else if(calculation.classification==='CONTINUING_CHANGE'&&active.state==='OPEN')toState='UPDATING';
    else if(calculation.classification==='CONTINUING_CHANGE'&&active.state==='STABILIZING')toState='UPDATING';
    else if(calculation.classification==='IMPROVING'){toState='STABILIZING';reasonCode='CLOSE_THRESHOLD';closeThresholdPassed=true;}
    else if(calculation.classification==='RESOLVED'){toState='RESOLVED';reasonCode='RESOLUTION_HOLD';closeThresholdPassed=true;}
    const revised=await episodes.revise(context,{episodeId:active.episode_id,expectedRevision:active.revision,toState,patch,
      sourceRefs:[item.ref],reasonCode,closeThresholdPassed,resolutionHoldMs:phase4Metric(calculation.metricKey).resolutionHoldMs,
      semanticAt:asOfUtc,semanticEvent:semanticKind?semanticEvent(semanticKind,calculation):null});
    const current=await episodes.read(context,active.episode_id,{history:true});
    await linkMembership(context,current,item,sourceSet,calculation,confidence);
    return {episode:await episodes.read(context,active.episode_id),created:false,replayed:false,event:revised};
  }
  async function metricPreparation(context,request,currentBody=null) {
      if(context.executionMode!=='SHADOW')fail('PHASE4_INTELLIGENCE_SHADOW_ONLY');
      if(!exactKeys(request,['metricKey','currentSource','baselineSources','asOfUtc','windowFamily',...(request.refresh===true?['refresh']:[])])||!validInstant(request.asOfUtc)
        ||Date.parse(request.asOfUtc)>core.now().getTime()||typeof request.windowFamily!=='string'||!request.windowFamily)
        fail('PHASE4_METRIC_ANALYSIS_REQUEST_INVALID');
      request={...request,asOfUtc:requireSemanticTime(request.asOfUtc)};
      const contract=phase4Metric(request.metricKey);let sourceSet;
      if(currentBody&&request.metricKey==='body_energy'&&request.currentSource===currentBody.ref
        &&Array.isArray(request.baselineSources)&&request.baselineSources.length===0){
        // Only the fixed current-Body factory supplies this data inside the
        // same readonly preparation. The original baseline selector really
        // selected zero samples; a nonempty baseline follows the full reader.
        // Recheck context/job/runtime/owner immediately before pure planning.
        // Independent fresh control observations settle before pure planning.
        // Keep the original context-before-owner failure order.
        const controls=await Promise.allSettled([
          Promise.resolve().then(()=>core.run(context,async()=>{})),
          Promise.resolve().then(()=>assertExecutionWorkOwner(client)),
        ]);
        for(const result of controls)if(result.status==='rejected')throw result.reason;
        const [source]=core.validateReferences(context,[request.currentSource]);
        if(source.type!=='body_energy_results'||source.mode!==context.executionMode
          ||canonicalJson(source.row)!==canonicalJson(currentBody.row)||!readableRow(source.row)||source.row.invalidated_at)
          fail('PHASE4_PARENT_STALE');
        sourceSet={refs:[request.currentSource],current:sourceValue(request.metricKey,source,context,request.asOfUtc),baseline:[]};
      }else sourceSet=await sources(context,request.metricKey,request.currentSource,request.baselineSources,request.asOfUtc);
      const baseline=buildPersonalBaseline({metricKey:request.metricKey,targetHealthDate:sourceSet.current.healthDate,
        asOfUtc:request.asOfUtc,observations:sourceSet.baseline});
      const quality=assessDataQuality({metricKey:request.metricKey,current:sourceSet.current,baseline,asOfUtc:request.asOfUtc,
        lifecycleValid:true,authorizationValid:true,
        sourceValid:[sourceSet.current,...sourceSet.baseline].every(source=>source.versionKnown),completenessRatio:1,
        missingReasons:[sourceSet.current,...sourceSet.baseline].some(source=>!source.versionKnown)?['SOURCE_VERSION_UNKNOWN']:[],
        inputGeneration:context.inputGeneration,
        lifecycleGeneration:context.lifecycleGeneration,authGeneration:context.authGeneration,
        provenance:[sourceSet.current,...sourceSet.baseline].map(source=>[source.sourceType,source.sourceId,source.sourceVersion])});
      const baseIdentity={algorithmMajor:'phase4-intelligence-v1',domain:contract.domain,metric:request.metricKey,
        subject:request.metricKey,windowFamily:request.windowFamily};
      const priorQualifying=sourceSet.baseline.map(source=>({observedAt:source.observedAt,
        robustZ:baseline.scale? (source.value-baseline.median)/baseline.scale:null,
        direction:baseline.scale?source.value>=baseline.median?'HIGHER':'LOWER':null}));
      const observationCalculation=evaluateMeaningfulChange({metricKey:request.metricKey,current:sourceSet.current,baseline,quality,priorQualifying});
      const plan=metricEvidencePlan(context,{metricKey:request.metricKey,sourceSet,baseline,quality,
        calculation:observationCalculation,asOfUtc:request.asOfUtc,windowFamily:request.windowFamily,refresh:request.refresh===true});
      return {request,contract,sourceSet,baseline,quality,baseIdentity,priorQualifying,observationCalculation,plan};
  }
  async function currentBodyMetricHints(context,plan){
    return (await client.execute({sql:`SELECT r.run_id,r.state,i.evidence_item_id,a.evidence_item_id authority_id
      FROM evidence_runs r LEFT JOIN evidence_items i ON i.user_id=r.user_id AND i.execution_mode=r.execution_mode
        AND i.run_id=r.run_id AND i.item_key=?
      LEFT JOIN ${analysisTable(core,'phase4_evidence_result_authorities')} a ON a.user_id=i.user_id AND a.execution_mode=i.execution_mode
        AND a.evidence_item_id=i.evidence_item_id AND a.result_scope='METRIC'
      WHERE r.user_id=? AND r.execution_mode=? AND r.deterministic_run_key=?`,
      args:[plan.itemKey,context.userId,context.executionMode,plan.runKey]})).rows[0];
  }
  async function issueCurrentBodyMetricPurpose(context,request,prepared,currentBody,runId,itemId,domainHint){
    requireOwnedCurrentBodyData(core,context,request.currentSource);
    const requestJson=ownedMetricRequestData(core,context,request),planJson=canonicalJson(prepared.plan),
      domain=domainHint?await metricDomainWork(context,request):null;
    if(requestJson!==ownedMetricRequestData(core,context,request)||planJson!==canonicalJson(prepared.plan))
      fail('PHASE4_METRIC_PREPARATION_CAPTURE_REQUIRED');
    requireOwnedCurrentBodyData(core,context,request.currentSource);
    const purpose=Object.freeze({});ownedBodyMetricPurposes.set(purpose,Object.freeze({core,context,request,prepared,
      currentBody,execution:currentDurableExecution(),job:core.jobAuthority(),marker:currentExecutionReceiptTransactionMarker(),
      epoch:processingReadObservationEpoch(client),requestJson,planJson,runKey:prepared.plan.runKey,
      inputHash:prepared.plan.inputHash,itemKey:prepared.plan.itemKey,runId,itemId,
      purposeKind:domainHint?'DOMAIN':'AUTHORITY',...(domain??{})}));
    return {purpose,domain};
  }
  async function withCurrentBodyMetricObservation(context,request,sourceAsOfUtc,work){
    if(typeof work!=='function')fail('PHASE4_METRIC_PREPARATION_CAPTURE_REQUIRED');
    if(![32,33,34].includes(core.schemaVersion)||request.metricKey!=='body_energy'||request.windowFamily!=='STAGE6_CURRENT_BODY_ENERGY'
      ||!Array.isArray(request.baselineSources)||request.baselineSources.length||typeof sourceAsOfUtc!=='string')return work(request);
    if(!core.processing.active?.())fail('PHASE4_TRANSACTION_REQUIRED');
    return withMetricPreparationContinuation(core,context,async()=>{
      // Every root acquires a new genuine current source/receipt/producer union.
      // No DATA or accepted guard crosses transaction markers. The old typed
      // consumer still performs its complete replay and result verification.
      const body=await prepareCurrentBodyMetricRequest(context,sourceAsOfUtc),fresh=body.request;
      if(!fresh||fresh.baselineSources.length||!hasOwnedCurrentBodyData(core,context,fresh.currentSource))return work(request);
      if(ownedMetricRequestData(core,context,{...request,refresh:true})!==ownedMetricRequestData(core,context,fresh))
        fail('PHASE4_METRIC_PREPARATION_CAPTURE_REQUIRED');
      const prepared=await metricPreparation(context,fresh,body.current),hint=await currentBodyMetricHints(context,prepared.plan);
      if(hint?.state!=='COMPLETED'||!hint.evidence_item_id||!hint.authority_id)return work(request);
      const {purpose}=await issueCurrentBodyMetricPurpose(context,fresh,prepared,body.current,hint.run_id,hint.evidence_item_id,true);
      return withOwnedBodyMetricObservations(core,context,purpose,()=>work(fresh));
    });
  }
  async function metricPreparationUnit(context,request,kind){return performMetricPreparationUnit(context,request,kind);}
  async function replayCurrentBodyMetricFamily(context,sourceAsOfUtc,workStepFor,work){
    if(![32,33,34].includes(core.schemaVersion)||!core.jobAuthority()||typeof workStepFor!=='function'||typeof work!=='function')
      fail('PHASE4_METRIC_PREPARATION_CAPTURE_REQUIRED');
    return withMetricPreparationContinuation(core,context,async()=>{
      let request,inventory,purpose;
      const workStepFrom=async()=>{
        const body=await prepareCurrentBodyMetricRequest(context,sourceAsOfUtc);request=body.request;
        if(!request||request.baselineSources.length||!hasOwnedCurrentBodyData(core,context,request.currentSource))return null;
        inventory=await createFamilyDirectory(client,keys,{live:core.liveAllocation}).inventory(context,'body_energy',{create:false});
        if(!inventory)return null;
        if(inventory.unknownEntries.length)fail('PHASE4_FAMILY_DIRECTORY_LEGACY_UNKNOWN');
        const prepared=await metricPreparation(context,request,body.current),hint=await currentBodyMetricHints(context,prepared.plan);
        if(hint?.state!=='COMPLETED'||!hint.evidence_item_id||!hint.authority_id)return null;
        const issued=await issueCurrentBodyMetricPurpose(context,request,prepared,body.current,hint.run_id,hint.evidence_item_id,true);
        purpose=issued.purpose;
        // This is an existence hint only. Acceptance remains the original
        // complete typed DOMAIN replay inside the family business callback.
        const domain=(await client.execute({sql:`SELECT 1 FROM ${analysisTable(core,'phase4_operation_receipts')} WHERE user_id=? AND execution_mode=?
          AND operation_kind='analyzeMetric' AND operation_key=?`,args:[context.userId,context.executionMode,issued.domain.operationKey]})).rows[0];
        if(!domain)return null;
        return workStepFor(request);
      };
      const perform=(replaying=false)=>withOwnedBodyMetricObservations(core,context,purpose,async()=>({request,inventory,outcome:await work(request,{replaying})}));
      return core.run(context,()=>perform(false),{workStepFrom,discardResult:true,replay:()=>perform(true)});
    });
  }
  async function metricPreparationUnitFromCurrentBody(context,asOfUtc){
    return withMetricPreparationContinuation(core,context,()=>performMetricPreparationUnit(context,null,'NEXT',()=>prepareCurrentBodyMetricRequest(context,asOfUtc)));
  }
  async function performMetricPreparationUnit(context,request,kind,requestFrom=null) {
    if(![32,33,34].includes(core.schemaVersion)||!core.jobAuthority()||!requestFrom&&request?.refresh!==true
      ||!['RUN','RUN_START','RUN_COMPLETE','ITEM','AUTHORITY','NEXT'].includes(kind))
      fail('PHASE4_METRIC_UNIT_RECEIPT_REQUIRED');
    let prepared,alreadyRecorded=false,bodySource=null,ownedPurpose=null,domainWorkStep=null;
    const directory=createFamilyDirectory(client,keys,{live:core.liveAllocation});
    const sourceWork=(name,facts)=>{const job=core.jobAuthority();return workStepOptions(name,[context.userId,context.executionMode,
      job.jobKind,job.requestedGeneration,job.scopeRevision,facts],{discardResult:true}).workStep;};
    const workStepFrom=async()=>{
      if(!requestFrom){const owner=await assertExecutionWorkOwner(client);if(owner?.phase!=='STAGE6_DRAIN')fail('PHASE4_METRIC_UNIT_RECEIPT_REQUIRED');}
      if(requestFrom){
        bodySource=await requestFrom();request=bodySource.request;
        if(!request){kind='SOURCE';return sourceWork('stage6.body-source',['USER',context.userId,JSON.stringify(['USER',context.userId]),bodySource.asOfUtc]);}
        const inventory=await directory.inventory(context,'body_energy',{create:false});
        if(!inventory){
          kind='DIRECTORY';return sourceWork('stage6.family-inventory',['body_energy',request.asOfUtc]);
        }
        if(inventory.unknownEntries.length)fail('PHASE4_FAMILY_DIRECTORY_LEGACY_UNKNOWN');
      }
      prepared=await metricPreparation(context,request,requestFrom?bodySource.current:null);
      if(kind==='NEXT'){
        const closed=requestFrom&&request.metricKey==='body_energy'&&request.baselineSources.length===0
          &&prepared.plan.input.baseline.samples.length===0&&hasOwnedCurrentBodyData(core,context,request.currentSource);
        // The exact current-Body selector only obtains immutable IDs/hints.
        // All acceptance still comes from the original full row/receipt and
        // producer verifiers below, never this joined existence observation.
        const run=closed?await currentBodyMetricHints(context,prepared.plan):(await client.execute({
          sql:'SELECT run_id,state FROM evidence_runs WHERE user_id=? AND execution_mode=? AND deterministic_run_key=?',
          args:[context.userId,context.executionMode,prepared.plan.runKey]})).rows[0];
        if(!run)kind='RUN_START';else if(run.state==='STARTED')kind='RUN_COMPLETE';else{
          const item=closed?(run.evidence_item_id?{evidence_item_id:run.evidence_item_id}:null)
            :(await client.execute({sql:'SELECT evidence_item_id FROM evidence_items WHERE user_id=? AND execution_mode=? AND run_id=? AND item_key=?',
            args:[context.userId,context.executionMode,run.run_id,prepared.plan.itemKey]})).rows[0];
          kind=item?'AUTHORITY':'ITEM';
          if(item&&requestFrom&&request.metricKey==='body_energy'&&request.baselineSources.length===0
            &&prepared.plan.input.baseline.samples.length===0&&hasOwnedCurrentBodyData(core,context,request.currentSource)){
            const authority=closed?run.authority_id:(await client.execute({sql:`SELECT evidence_item_id FROM ${analysisTable(core,'phase4_evidence_result_authorities')}
              WHERE user_id=? AND execution_mode=? AND evidence_item_id=? AND result_scope='METRIC'`,
              args:[context.userId,context.executionMode,item.evidence_item_id]})).rows[0];
            {
              // AUTHORITY uses the same data-only raw observation purpose.
              // It grants no result authority: the original ITEM receipt and
              // null-origin continuation checks still gate persist below.
              // The actual current selector, canonical zero-baseline plan and
              // raw Body data issue this same-owned-root purpose. Caller empty
              // arrays, copied contexts/flags cannot register it.
              const issued=await issueCurrentBodyMetricPurpose(context,request,prepared,bodySource.current,run.run_id,item.evidence_item_id,Boolean(authority));
              ownedPurpose=issued.purpose;const domain=issued.domain;
              kind=authority?'DOMAIN':'AUTHORITY';domainWorkStep=domain?.workStep??null;
            }
          }
        }
        // Hints above select only DATA transport. The original complete typed
        // replay still runs, including its signed DOMAIN producer/work proof,
        // before any unit may be selected. Missing/complex rows keep its full
        // generic reader; the exact current Body can reuse its fresh raw frame.
        if(await (ownedPurpose?withOwnedBodyMetricObservations(core,context,ownedPurpose,
          ()=>recordedMetricPreparation(context,request)):recordedMetricPreparation(context,request))){
          alreadyRecorded=true;kind='AUTHORITY';return metricUnitWork(context,prepared.plan,kind).workStep;
        }
      }
      if(kind==='DOMAIN')return domainWorkStep;
      return metricUnitWork(context,prepared.plan,kind).workStep;
    };
    const perform=async()=>{
      if(kind==='SOURCE')return {unit:'SOURCE',status:'COMPLETE',created:false,prepared:false};
      if(kind==='DIRECTORY'){
        const inventory=await directory.inventory(context,'body_energy');
        if(!inventory.created)fail('PHASE4_FAMILY_DIRECTORY_AUTHORITY_INVALID');
        return {unit:'DIRECTORY',status:'COMPLETE',created:true,prepared:false};
      }
      if(alreadyRecorded)return {unit:'AUTHORITY',status:'COMPLETE',created:false,prepared:true,recorded:true};
      const {plan,sourceSet,baseline,quality,observationCalculation:calculation}=prepared;
      request=prepared.request;
      if(kind==='DOMAIN'){
        // DOMAIN is the existing public analyzeMetric operation. Its refresh
        // path below already reopens and validates the complete RUN/ITEM,
        // exact item payload/confidence, AUTHORITY receipt, sealed producer,
        // null origin and calculation before any receipt effect. Repeating
        // that whole preparation here costs another authenticated traversal
        // of the same immutable inputs in the same owned write snapshot.
        // The domain's actual legacy discovery obtains all three original
        // named proofs. Its analyzer below requires the opaque ITEM proof
        // against its independently recomputed canonical plan, avoiding a
        // second identical receipt/producer traversal. Keep fresh delivery
        // and owner fences; the selector hint grants no authority.
        await assertFreshContextAndWorkOwner(core,context);requireSettledOperation();
        requireOwnedBodyMetricPurpose(core,context,ownedPurpose);
        return {unit:'DOMAIN',status:'COMPLETE',created:false,prepared:false,
          domainResult:await performMetricDomain(context,request,ownedPurpose)};
      }
      const runData={deterministic_run_key:plan.runKey,subject_key:request.metricKey,
        method:'PERSONAL_BASELINE_DEVIATION',window_start_utc:baseline.samples.at(-1)?.observedAt??sourceSet.current.observedAt,
        window_end_utc:sourceSet.current.observedAt,as_of_utc:request.asOfUtc,timezone:context.timezone,
        algorithm_version:INTELLIGENCE_VERSIONS.algorithm,registry_version:INTELLIGENCE_VERSIONS.registry,
        evidence_contract_version:INTELLIGENCE_VERSIONS.evidenceContract,promotion_confound_version:INTELLIGENCE_VERSIONS.promotionConfound,
        exposure_classification_version:INTELLIGENCE_VERSIONS.exposureClassification,factor_set_version:INTELLIGENCE_VERSIONS.factorSet,
        state:'STARTED',started_at:request.asOfUtc};
      const itemRunProof=kind==='ITEM'?Promise.resolve().then(()=>metricRunReceipt(core,context,plan)):null;
      const runObservations=await Promise.allSettled([
        Promise.resolve().then(()=>client.execute({sql:'SELECT * FROM evidence_runs WHERE user_id=? AND execution_mode=? AND deterministic_run_key=?',
          args:[context.userId,context.executionMode,plan.runKey]})),
        ...(itemRunProof?[itemRunProof]:[]),
      ]);
      if(runObservations[0].status==='rejected')throw runObservations[0].reason;
      const runRow=runObservations[0].value.rows[0];
      let run;
      if(runRow){
        if(kind==='RUN_COMPLETE'&&runRow.state==='STARTED'){
          if(!readableRow(runRow)||runRow.invalidated_at||runRow.input_manifest_hash!==null||runRow.input_manifest_json!==null
            ||runRow.completed_at!==null||!await metricUnitReceipt(core,context,plan,'RUN_START'))fail('PHASE4_METRIC_UNIT_RECEIPT_REQUIRED');
          for(const [field,value] of Object.entries(runData))if(runRow[field]!==value)fail('PHASE4_EVIDENCE_REPLAY_CONFLICT');
          // completeEvidence freshly acquires this exact artifact before its
          // update and again afterward. The unit's separate preceding artifact
          // traversal supplied no additional binding to those original fences.
          run=await entities.completeEvidence(context,runRow.run_id,{sample_count:baseline.sampleCount,exclusion_count:baseline.exclusions.length,
            input_manifest_json:plan.input,input_manifest_hash:plan.inputHash,missingness_json:{quality_state:quality.status,reason_codes:quality.reasonCodes}});
          return {unit:'RUN_COMPLETE',status:'COMPLETE',created:true};
        }
        if(!readableRow(runRow)||runRow.invalidated_at||runRow.state!=='COMPLETED'
          ||runRow.input_manifest_hash!==plan.inputHash||runRow.input_manifest_json!==canonicalJson(plan.input))
          fail('PHASE4_EVIDENCE_REPLAY_CONFLICT');
        if(itemRunProof){
          if(runObservations[1].status==='rejected')throw runObservations[1].reason;
          if(!runObservations[1].value)fail('PHASE4_METRIC_UNIT_RECEIPT_REQUIRED');
        }else if(!await metricRunReceipt(core,context,plan))fail('PHASE4_METRIC_UNIT_RECEIPT_REQUIRED');
        // ITEM only needs the immutable parent ID here. append independently
        // acquires and validates the complete completed-run artifact before
        // its first effect; its link and returned-artifact checks stay fresh.
        // The other purposes still require the original run reference.
        run=kind==='ITEM'?{row:runRow}:await core.artifact(context,'evidence_runs',{run_id:runRow.run_id});
      }else{
        if(!['RUN','RUN_START'].includes(kind))fail('PHASE4_METRIC_UNIT_RECEIPT_REQUIRED');
        run=await entities.append(context,'evidence_runs',runData,sourceSet.refs);
        if(kind==='RUN_START')return {unit:'RUN_START',status:'COMPLETE',created:true};
        run=await entities.completeEvidence(context,run.row.run_id,{sample_count:baseline.sampleCount,exclusion_count:baseline.exclusions.length,
          input_manifest_json:plan.input,input_manifest_hash:plan.inputHash,missingness_json:{quality_state:quality.status,reason_codes:quality.reasonCodes}});
      }
      if(['RUN','RUN_START','RUN_COMPLETE'].includes(kind))return {unit:kind,status:'COMPLETE',created:!runRow};
      if(['AUTHORITY','DOMAIN'].includes(kind)&&!(await client.execute({sql:`SELECT 1 FROM evidence_items WHERE user_id=? AND execution_mode=? AND run_id=? AND item_key=?`,
        args:[context.userId,context.executionMode,run.row.run_id,plan.itemKey]})).rows.length)fail('PHASE4_METRIC_UNIT_RECEIPT_REQUIRED');
      const itemData=metricItemData(request.metricKey,sourceSet,baseline,quality,calculation,plan),item=await (kind==='ITEM'&&request.metricKey==='body_energy'
        ?entities.appendMetricPreparationItem(context,{...itemData,run_id:run.row.run_id},sourceSet.refs)
        :entities.append(context,'evidence_items',{...itemData,run_id:run.row.run_id},sourceSet.refs));
      validateMetricItem(item.row,itemData,run.row.run_id);
      if(canonicalJson(durableConfidence(item))!==canonicalJson(plan.confidence))fail('PHASE4_EVIDENCE_CONFIDENCE_REPLAY_CONFLICT');
      const itemProof=!item.created?await metricUnitReceipt(core,context,plan,'ITEM'):null;
      if(!item.created&&!itemProof)fail('PHASE4_METRIC_UNIT_RECEIPT_REQUIRED');
      if(kind==='ITEM')return {unit:'ITEM',status:'COMPLETE',created:item.created};
      const prior=(await client.execute({sql:`SELECT evidence_item_id FROM ${analysisTable(core,'phase4_evidence_result_authorities')}
        WHERE user_id=? AND execution_mode=? AND evidence_item_id=? AND result_scope='METRIC'`,
        args:[context.userId,context.executionMode,item.row.evidence_item_id]})).rows[0];
      if(prior){
        if(!await metricUnitReceipt(core,context,plan,'AUTHORITY'))fail('PHASE4_METRIC_UNIT_RECEIPT_REQUIRED');
        const verified=await authorities.read(context,item.row.evidence_item_id,'METRIC');
        if(verified.origin!==null||canonicalJson(verified.calculation)!==canonicalJson(calculation))fail('PHASE4_DURABLE_REPLAY_BINDING_INVALID');
        if(kind==='DOMAIN'){
          await assertFreshContextAndWorkOwner(core,context);requireSettledOperation();
          requireOwnedBodyMetricPurpose(core,context,ownedPurpose);
          return {unit:'DOMAIN',status:'COMPLETE',created:false,prepared:false,domainResult:await performMetricDomain(context,request,ownedPurpose)};
        }
        return {unit:'AUTHORITY',status:'COMPLETE',created:false,prepared:true};
      }
      if(kind==='DOMAIN')fail('PHASE4_METRIC_UNIT_RECEIPT_REQUIRED');
      // An independently created/legacy item cannot acquire a later origin.
      // Only this exact same-context, current-owner ITEM receipt proof permits
      // its original null-origin preparation authority to finish durably.
      await authorities.persist(context,{item,run,scope:'METRIC',origin:null,calculation,sourceRefs:sourceSet.refs,
        continuation:itemProof?{proof:itemProof,plan}:null});
      return {unit:'AUTHORITY',status:'COMPLETE',created:true,prepared:true};
    };
    const performOwned=()=>ownedPurpose?withOwnedBodyMetricObservations(core,context,ownedPurpose,perform):perform();
    const result=await core.run(context,performOwned,{workStepFrom,discardResult:true,replay:async()=>kind==='DOMAIN'
      ?{unit:'DOMAIN',status:'COMPLETE',created:false,prepared:false,domainResult:await replayMetricDomain(context,request)}:performOwned()});
    if(kind==='DOMAIN')return {unit:'DOMAIN',status:'COMPLETE',prepared:false,
      created:await takeMetricDomainProgress(context,result.domainResult)};
    // This is only the original immutable source-reference request, never an
    // authority result. The final domain operation freshly checks its entire
    // source, historical origin, receipt and producer closure again.
    const returned=requestFrom&&result.prepared&&!result.created?{...result,request}:result;
    return returned;
  }
  async function analyzeMetric(context,request,ownedPurpose=null,discoveredPreparation=null) {
    const observe=async()=>{
      if(ownedPurpose&&ownedMetricRequestData(core,context,request)!==requireOwnedBodyMetricPurpose(core,context,ownedPurpose).requestJson)
        fail('PHASE4_METRIC_PREPARATION_CAPTURE_REQUIRED');
      const {request:normalized,contract,sourceSet,baseline,quality,baseIdentity,priorQualifying,observationCalculation,plan}=await metricPreparation(context,request,ownedPurpose?requireOwnedBodyMetricPurpose(core,context,ownedPurpose).currentBody:null);
      request=normalized;
      if(ownedPurpose){
        requireOwnedBodyMetricPurpose(core,context,ownedPurpose);
        requireMetricUnitProof(core,context,discoveredPreparation?.itemProof,plan,'ITEM');
      }
      // A complete, independent calculation. It deliberately has no episode
      // dependency and cannot make a historical episode current. The explicit
      // request and manifest dimension separate it from ordinary analysis.
      if(request.refresh===true) {
        const closed=ownedPurpose?await authorities.readOwnedMetricDomainEvidence(context,ownedPurpose,{plan,
          itemData:metricItemData(request.metricKey,sourceSet,baseline,quality,observationCalculation,plan),discovered:discoveredPreparation}):null;
        const evidence=closed??await durableEvidence(context,{metricKey:request.metricKey,sourceSet,baseline,quality,
          calculation:observationCalculation,asOfUtc:request.asOfUtc,plan});
        if(closed&&canonicalJson(durableConfidence(evidence.item))!==canonicalJson(plan.confidence))
          fail('PHASE4_EVIDENCE_CONFIDENCE_REPLAY_CONFLICT');
        if(!evidence.item.created&&metricPreparationContinuation(core,context)){
          if(!closed&&!await metricUnitReceipt(core,context,plan,'AUTHORITY'))fail('PHASE4_METRIC_UNIT_RECEIPT_REQUIRED');
          const verified=closed?.authority??await authorities.read(context,evidence.item.row.evidence_item_id,'METRIC');
          if(verified.origin!==null||canonicalJson(verified.calculation)!==canonicalJson(observationCalculation))
            fail('PHASE4_DURABLE_REPLAY_BINDING_INVALID');
        }else await authorities.persist(context,{item:evidence.item,run:evidence.run,scope:'METRIC',origin:null,
          calculation:observationCalculation,sourceRefs:sourceSet.refs});
        if(ownedPurpose){await assertFreshContextAndWorkOwner(core,context);requireSettledOperation();
          requireOwnedBodyMetricPurpose(core,context,ownedPurpose);}
        return markBodyMetricPreparationResult(core,context,request,Object.freeze({resultState:'REFRESH_PREPARED',baseline,quality,calculation:observationCalculation,
          run:evidence.run,item:evidence.item,episode:null}),ownedPurpose);
      }
      const replay=await exactMetricReplay(context,{metricKey:request.metricKey,sourceSet,baseline,quality,priorQualifying,
        observationCalculation,asOfUtc:request.asOfUtc,plan});
      if(replay)return Object.freeze({baseline,quality,calculation:replay.calculation,run:replay.run,item:replay.item,
        episode:replay.episode});
      const identity={...baseIdentity,direction:observationCalculation.direction??'UNKNOWN'},activeResult=observationCalculation.direction
        ?await activeEpisode(context,identity,sourceSet.current.observedAt):null;
      const active=activeResult?.continuous?activeResult.row:null,staleActive=activeResult&&!activeResult.continuous
        &&observationCalculation.qualified?activeResult.row:null;
      const calculation=evaluateMeaningfulChange({metricKey:request.metricKey,current:sourceSet.current,baseline,quality,priorQualifying,
        activeEpisode:active?{state:active.state,direction:active.direction,severity:active.severity,
          stabilizationStartedAt:active.stabilization_started_at}:null,
        recentSemanticHashes:active?.semantic_summary_hash?[active.semantic_summary_hash]:[],nowUtc:request.asOfUtc});
      const evidence=await durableEvidence(context,{metricKey:request.metricKey,sourceSet,baseline,quality,
        calculation:observationCalculation,asOfUtc:request.asOfUtc,plan});
      const episode=await episodeForEvidence(context,{identity:baseIdentity,active,staleActive,sourceSet,calculation,item:evidence.item,
        asOfUtc:request.asOfUtc,confidence:evidence.confidence});
      const result=episode?.episode.row??null;
      const event=result?(await client.execute({sql:`SELECT episode_event_id FROM episode_events WHERE user_id=? AND execution_mode=?
        AND episode_id=? AND resulting_revision=?`,args:[context.userId,context.executionMode,result.episode_id,result.revision]})).rows[0]:null;
      const dependencies=await authorities.episodeDependencies(context,active);
      if(result?.reopens_episode_id) {
        const previous=await core.artifact(context,'observation_episodes',{episode_id:result.reopens_episode_id});
        dependencies.push(...await authorities.episodeDependencies(context,previous.row));
      }
      await authorities.persist(context,{item:evidence.item,run:evidence.run,scope:'METRIC',
        origin:result?{episode_id:result.episode_id,revision:result.revision,episode_event_id:event.episode_event_id,
          prior_semantic_hash:active?.semantic_summary_hash??null}:null,calculation,
        sourceRefs:[...sourceSet.refs,...dependencies]});
      return Object.freeze({resultState:episode?'POSITIVE':sourceSet.current.value==null?'NO_DATA':quality.status==='WARMING_UP'?'WARMING_UP':quality.status==='NO_DATA'?'NO_DATA':
        ['UNAVAILABLE','DEGRADED'].includes(quality.status)?'INSUFFICIENT_QUALITY':
        calculation.classification==='NO_MEANINGFUL_CHANGE'?(calculation.openPass?'INSUFFICIENT_EVIDENCE':'NO_CHANGE'):
          calculation.qualified?'NO_ARTIFACT':'INSUFFICIENT_EVIDENCE',
        baseline,quality,calculation,run:evidence.run,item:evidence.item,episode});
    };
    return core.run(context,()=>ownedPurpose?withOwnedBodyMetricObservations(core,context,ownedPurpose,observe):observe());
  }
  function parseFactorKeys(row) {
    let values;
    try {values=JSON.parse(row.factor_keys_json??'null');}catch {fail('PHASE4_COVERAGE_FACTOR_SET_INVALID');}
    if(!Array.isArray(values)||values.some(value=>typeof value!=='string'))fail('PHASE4_COVERAGE_FACTOR_SET_INVALID');
    return values;
  }
  function associationWindows(days,direction) {
    const classified=days.filter(day=>day.exposureState!=='UNKNOWN'&&Number.isFinite(day.outcome))
      .sort((a,b)=>compareExact(a.healthDate,b.healthDate));
    if(classified.length<20)return [];
    const midpoint=Math.floor(classified.length/2),parts=[classified.slice(0,midpoint),classified.slice(midpoint)],windows=[];
    for(const part of parts) {
      const exposed=part.filter(day=>day.exposureState==='EXPOSED'),unexposed=part.filter(day=>day.exposureState==='CONFIRMED_UNEXPOSED');
      if(exposed.length<5||unexposed.length<5)return [];
      const mean=rows=>rows.reduce((sum,row)=>sum+row.outcome,0)/rows.length,effect=mean(exposed)-mean(unexposed);
      const partDirection=effect>=0?'HIGHER':'LOWER';if(partDirection!==direction)return [];
      windows.push({start:`${part[0].healthDate}T00:00:00.000Z`,end:`${addDays(part.at(-1).healthDate,1)}T00:00:00.000Z`,direction:partDirection});
    }
    return windows;
  }
  async function associationHypothesis(context,hypothesis,asOfUtc) {
    const fields=['factor','outcomeMetric','lagDays','comparisonHealthDates','outcomeSources','journalFactSources','coverageSources'];
    if(!exactKeys(hypothesis,fields)||typeof hypothesis.factor!=='string'||!/^[a-z][a-z0-9_]{0,63}$/.test(hypothesis.factor)
      ||![0,1].includes(hypothesis.lagDays)||!Array.isArray(hypothesis.outcomeSources)||hypothesis.outcomeSources.length>400
      ||!Array.isArray(hypothesis.comparisonHealthDates)||!hypothesis.comparisonHealthDates.length||hypothesis.comparisonHealthDates.length>400
      ||!Array.isArray(hypothesis.journalFactSources)||!Array.isArray(hypothesis.coverageSources)
      ||hypothesis.journalFactSources.length+hypothesis.coverageSources.length>400)fail('PHASE4_ASSOCIATION_HYPOTHESIS_INVALID');
    phase4Metric(hypothesis.outcomeMetric);
    const comparisonHealthDates=[...hypothesis.comparisonHealthDates].sort();
    if(comparisonHealthDates.some(date=>!validHealthDate(date)||date>localDate(new Date(asOfUtc),context.timezone))
      ||new Set(comparisonHealthDates).size!==comparisonHealthDates.length)fail('PHASE4_ASSOCIATION_COMPARISON_DAYS_INVALID');
    const inputRefs=[...hypothesis.outcomeSources,...hypothesis.journalFactSources,...hypothesis.coverageSources];
    if(new Set(inputRefs).size!==inputRefs.length)fail('PHASE4_ASSOCIATION_SOURCES_DUPLICATE');
    const outcomeResolved=await core.revalidateSources(context,hypothesis.outcomeSources);
    const outcomeEntries=outcomeResolved.map((source,index)=>({source,
      value:associationOutcomeValue(hypothesis.outcomeMetric,source,context,asOfUtc),ref:hypothesis.outcomeSources[index]}))
      .sort((a,b)=>compareExact(a.value.healthDate,b.value.healthDate)||compareExact(a.value.sourceId,b.value.sourceId)
        ||compareExact(a.value.sourceVersion,b.value.sourceVersion));
    if(new Set(outcomeEntries.map(entry=>entry.value.healthDate)).size!==outcomeEntries.length
      ||outcomeEntries.some(entry=>!comparisonHealthDates.includes(entry.value.healthDate)))fail('PHASE4_ASSOCIATION_OUTCOME_DAYS_INVALID');
    const journal=await core.journalSourcesAsOf(context,[...hypothesis.journalFactSources,...hypothesis.coverageSources],asOfUtc);
    const facts=journal.filter(source=>source.type==='JOURNAL_FACT').sort((a,b)=>compareExact(a.row.logical_fact_id,b.row.logical_fact_id)
      ||a.row.revision-b.row.revision||compareExact(a.id,b.id));
    const coverage=journal.filter(source=>source.type==='JOURNAL_COVERAGE').sort((a,b)=>compareExact(a.row.health_date_start,b.row.health_date_start)
      ||compareExact(a.row.health_date_end,b.row.health_date_end)||a.row.revision-b.row.revision||compareExact(a.id,b.id));
    if(facts.some(source=>source.type!=='JOURNAL_FACT')||coverage.some(source=>source.type!=='JOURNAL_COVERAGE'))
      fail('PHASE4_ASSOCIATION_SOURCE_MISMATCH');
    const journalIds=journal.map(source=>`${source.type}:${source.id}`);
    if(new Set(journalIds).size!==journalIds.length)fail('PHASE4_ASSOCIATION_SOURCES_DUPLICATE');
    const outcomes=outcomeEntries.map(entry=>entry.value),outcomeByDate=new Map(outcomes.map(outcome=>[outcome.healthDate,outcome]));
    const days=comparisonHealthDates.map(healthDate=>{
      const outcome=outcomeByDate.get(healthDate)??null,factorDate=addDays(healthDate,-hypothesis.lagDays);
      const currentFacts=facts.filter(source=>source.row.category===hypothesis.factor&&source.row.health_date===factorDate);
      const exposedFacts=currentFacts.filter(source=>source.row.exposure_state==='EXPOSED');
      const negativeFacts=currentFacts.filter(source=>source.row.exposure_state==='CONFIRMED_UNEXPOSED'
        &&source.row.time_scope==='HEALTH_DAY');
      const covered=coverage.some(source=>parseFactorKeys(source.row).includes(hypothesis.factor)
        &&source.row.health_date_start<=factorDate&&source.row.health_date_end>=factorDate);
      const exposureState=exposedFacts.length?'EXPOSED':negativeFacts.length||covered?'CONFIRMED_UNEXPOSED':'UNKNOWN';
      return {healthDate,factorHealthDate:factorDate,outcome:outcome?.value??null,
        outcomeStatus:outcome?.outcomeStatus??'MISSING',quality:outcome?.outcomeStatus==='PRESENT'?'AVAILABLE':outcome?'DEGRADED':'NO_DATA',
        exposureState,outcomeSource:outcome?[outcome.sourceType,outcome.sourceId,outcome.sourceVersion]:null,
        exposureSources:[...exposedFacts,...negativeFacts].map(source=>[source.type,source.id,source.row.revision])
          .concat(coverage.filter(source=>parseFactorKeys(source.row).includes(hypothesis.factor)
            &&source.row.health_date_start<=factorDate&&source.row.health_date_end>=factorDate)
            .map(source=>[source.type,source.id,source.row.revision])).sort((a,b)=>compareExact(canonicalJson(a),canonicalJson(b)))};
    });
    const first=evaluateJournalAssociation({factor:hypothesis.factor,outcomeMetric:hypothesis.outcomeMetric,days,asOfUtc});
    const classified=days.filter(day=>day.exposureState!=='UNKNOWN'&&Number.isFinite(day.outcome)),xs=classified.map(day=>day.exposureState==='EXPOSED'?1:0),
      ys=classified.map(day=>day.outcome),rawSignificance=first.candidate?pValue(pearson(xs,ys),classified.length):null;
    const canonicalJournal=[...facts,...coverage],refs=[...outcomeEntries.map(entry=>entry.ref),...canonicalJournal.map(source=>source.ref)];
    return {hypothesis:{...hypothesis,comparisonHealthDates},refs,outcomes,days,rawSignificance,
      journalAuthority:canonicalJournal.map(source=>({type:source.type,id:source.id,revision:source.row.revision,
        createdAt:canonicalSourceTime(source.row.created_at),asOfUtc})),
      replicationWindows:associationWindows(days,first.direction),first};
  }
  function insightIdentity(hypothesis,direction) {
    return {subject:`journal:${hypothesis.factor}`,outcome:hypothesis.outcomeMetric,direction,
      exposureCategory:hypothesis.factor,algorithmFamily:'journal-association',evidenceContractMajor:'1'};
  }
  const hypothesisKey=hypothesis=>`${hypothesis.factor}:${hypothesis.outcomeMetric}:lag-${hypothesis.lagDays}`;
  function durableConfidence(item) {
    let provenance;try {provenance=JSON.parse(item.row.provenance_json??'null');}catch {fail('PHASE4_EVIDENCE_CONFIDENCE_INVALID');}
    const confidence=provenance?.confidence;
    try {validateEvidenceConfidence(confidence);}catch {fail('PHASE4_EVIDENCE_CONFIDENCE_INVALID');}
    return confidence;
  }
  const insightKey=(context,identity)=>insightIdentityKey(keys,context,identity);
  async function currentInsight(context,identity,asOfUtc,{replaceExpired=false}={}) {
    const requestedKey=insightKey(context,identity);
    const current=await resolveInsightLifecycle(context,{insightKey:requestedKey,matchLookup:true});
    if(!current)return null;
    const row=current.row;
    if(row.status==='RETIRED'&&replaceExpired)return null; // Successor admission enforces sealed terminal chronology.
    const at=Date.parse(requireSemanticTime(asOfUtc));
    // A new past request cannot borrow a future incarnation/revision. Exact
    // historical requests have already returned through the receipt boundary.
    if(Date.parse(requireSemanticTime(row.first_detected_at))>at
      ||Date.parse(requireSemanticTime(row.last_recalculated_at??row.first_detected_at))>at) {
      fail('PHASE4_INSIGHT_AS_OF_UNAVAILABLE');
    }
    if(row.status==='RETIRED')return null;
    if(row.lifecycle_disposition)fail('PHASE4_INSIGHT_NOT_CURRENT');
    if(Date.parse(requireSemanticTime(row.expires_at))<=at) {
      if(replaceExpired)await expireInsight(context,{insightId:row.id,asOfUtc});
      return null;
    }
    return current;
  }
  function revisionEvidenceIds(row,field) {
    let ids;try {ids=JSON.parse(row[field]??'[]');}catch {fail('PHASE4_INSIGHT_POINTER_INVALID');}
    if(!Array.isArray(ids)||ids.some(id=>typeof id!=='string'))fail('PHASE4_INSIGHT_POINTER_INVALID');
    return ids;
  }
  async function historicalInsightArtifact() { fail('PHASE4_OPERATION_RESULT_UNAVAILABLE'); }
  const insightBinding=value=>value?{insight_id:value.row.id,revision:value.revision.revision,
    revision_json:canonicalJson(value.revision),projection_version:'stage5-insight-result-v2',
    last_recalculated_at:value.row.last_recalculated_at,retired_at:value.row.retired_at}:null;
  async function replayAssociationInsight(context,hypothesis,analysis,item,asOfUtc) {
    const results={};
    for(const [scope,label] of [['INSIGHT_CURRENT','current'],['INSIGHT_CONTRADICTION','contradiction']]) {
      const {origin}=await authorities.read(context,item.row.evidence_item_id,scope);
      if(origin===null){results[label]=null;continue;}
      if(origin.projection_version!=='stage5-insight-result-v2')fail('PHASE4_EVIDENCE_RESULT_AUTHORITY_UNAVAILABLE');
      const found=await historicalInsightArtifact(context,origin.insight_id,origin.revision,origin);
      if(canonicalJson(found.revision)!==origin.revision_json)fail('PHASE4_DURABLE_REPLAY_BINDING_INVALID');
      results[label]=found;
    }
    if(!analysis.candidate||!analysis.direction) {
      if(results.current||results.contradiction)fail('PHASE4_DURABLE_REPLAY_BINDING_INVALID');
      return null;
    }
    if(!results.current||results.current.row.insight_key!==insightKey(context,insightIdentity(hypothesis,analysis.direction)))
      fail('PHASE4_DURABLE_REPLAY_BINDING_INVALID');
    return results;
  }
  const associationClaim=canonicalAssociationClaim;
  async function reviseContradiction(context,hypothesis,analysis,item,asOfUtc) {
    if(!analysis.repeated||durableConfidence(item).score<.5)return null;
    const opposite=analysis.direction==='HIGHER'?'LOWER':'HIGHER',existing=await currentInsight(context,insightIdentity(hypothesis,opposite),asOfUtc);
    if(!existing)return null;
    const base={insightId:existing.row.id,expectedRevision:existing.row.current_revision,claim:existing.row.statement,
      contradictingEvidenceIds:[item.row.evidence_item_id]};
    if(existing.row.status==='WEAKENED'||existing.row.status==='HYPOTHESIS')return insights.transition(context,{...base,status:'RETIRED',
      disposition:'REFUTED',supportingEvidenceIds:[],reason:'REFUTED',semanticAt:asOfUtc});
    return insights.transition(context,{...base,status:'WEAKENED',supportingEvidenceIds:[],reason:'CONTRADICTORY_EVIDENCE',semanticAt:asOfUtc});
  }
  async function updateInsight(context,hypothesis,analysis,item,asOfUtc) {
    if(!analysis.candidate||!analysis.direction)return null;
    const confidence=durableConfidence(item),promotionReady=confidence.score>=.5;
    const identity=insightIdentity(hypothesis,analysis.direction),claim=associationClaim(hypothesis,analysis.direction,'HYPOTHESIS');
    const contradiction=await reviseContradiction(context,hypothesis,analysis,item,asOfUtc);
    let current=await currentInsight(context,identity,asOfUtc,{replaceExpired:true});
    if(!current) {
      const predecessorId=await discoverInsightPredecessor(context,insightKey(context,identity),asOfUtc);
      current=await insights.create(context,{identity,claim,evidenceContractVersion:INTELLIGENCE_VERSIONS.evidenceContract,
        supportingEvidenceIds:[item.row.evidence_item_id],creationKey:keys.lookup(['insight-incarnation-v1',insightKey(context,identity),
          predecessorId,item.row.evidence_item_id]),supersedesId:predecessorId,
        expiresAt:new Date(Date.parse(asOfUtc)+phase4Metric(hypothesis.outcomeMetric).evidenceExpiryMs).toISOString(),semanticAt:asOfUtc});
    }
    if(analysis.repeated&&promotionReady&&['HYPOTHESIS','WEAKENED'].includes(current.row.status))current=await insights.transition(context,{insightId:current.row.id,
      expectedRevision:current.row.current_revision,status:'EMERGING',claim,supportingEvidenceIds:[item.row.evidence_item_id],
      reason:'REPEATED_EVIDENCE',semanticAt:asOfUtc});
    else if(analysis.insightSupporting&&promotionReady&&['EMERGING','SUPPORTED','WEAKENED'].includes(current.row.status)) {
      const prior=JSON.parse(current.revision.supporting_evidence_ids_json??'[]'),supporting=[...new Set([...prior,item.row.evidence_item_id])];
      const windows=[];for(const id of supporting) {
        const evidence=await core.artifact(context,'evidence_items',{evidence_item_id:id});
        const run=await core.artifact(context,'evidence_runs',{run_id:evidence.row.run_id});windows.push([run.row.window_start_utc,run.row.window_end_utc]);
      }
      const newest=windows.at(-1),independent=windows.length>1&&windows.slice(0,-1).every(prior=>
        Date.parse(newest[1])<=Date.parse(prior[0])||Date.parse(prior[1])<=Date.parse(newest[0]));
      if(supporting.length>=2&&independent)current=await insights.transition(context,{insightId:current.row.id,expectedRevision:current.row.current_revision,
        status:'SUPPORTED',claim:associationClaim(hypothesis,analysis.direction,'SUPPORTED'),supportingEvidenceIds:supporting,
        reason:'REPLICATED_SUPPORT',semanticAt:asOfUtc,
        expiresAt:new Date(Date.parse(asOfUtc)+phase4Metric(hypothesis.outcomeMetric).evidenceExpiryMs).toISOString()});
    }
    if(current.row.status==='RETIRED')fail('PHASE4_INSIGHT_NOT_CURRENT');
    return {current,contradiction};
  }
  async function analyzeAssociationFamily(context,request) {
    return core.run(context,async()=>{
      if(context.executionMode!=='SHADOW')fail('PHASE4_INTELLIGENCE_SHADOW_ONLY');
      const evidenceOnly=request?.lifecycleMode==='EVIDENCE_ONLY';
      if(!exactKeys(request,['asOfUtc','multipleTestingFamily','hypotheses',...(evidenceOnly?['lifecycleMode']:[])])||!validInstant(request.asOfUtc)
        ||Date.parse(request.asOfUtc)>core.now().getTime()||typeof request.multipleTestingFamily!=='string'
        ||!request.multipleTestingFamily||request.multipleTestingFamily.length>128||!Array.isArray(request.hypotheses)
        ||!request.hypotheses.length||request.hypotheses.length>16)fail('PHASE4_ASSOCIATION_FAMILY_INVALID');
      request={...request,asOfUtc:requireSemanticTime(request.asOfUtc)};
      const orderedHypotheses=[...request.hypotheses].sort((a,b)=>compareExact(hypothesisKey(a),hypothesisKey(b)));
      if(new Set(orderedHypotheses.map(hypothesisKey)).size!==orderedHypotheses.length)fail('PHASE4_ASSOCIATION_HYPOTHESIS_DUPLICATE');
      const prepared=[];for(const hypothesis of orderedHypotheses)prepared.push(await associationHypothesis(context,hypothesis,request.asOfUtc));
      const adjusted=benjaminiHochberg(prepared.map(value=>({key:hypothesisKey(value.hypothesis),
        pValue:value.rawSignificance??1})));
      const finalized=prepared.map((value,index)=>({...value,analysis:evaluateJournalAssociation({factor:value.hypothesis.factor,
        outcomeMetric:value.hypothesis.outcomeMetric,days:value.days,replicationWindows:value.replicationWindows,
        adjustedSignificance:adjusted[index].adjusted,asOfUtc:request.asOfUtc})}));
      const familyManifest={manifest_version:'phase4-association-family-input-v2',identity_profile:'stage5-association-request-v2',multiple_testing_family:request.multipleTestingFamily,
        ...(evidenceOnly?{lifecycle_mode:'EVIDENCE_ONLY'}:{}),
        as_of_utc:request.asOfUtc,request_scope:{timezone:context.timezone,algorithm:context.algorithmSetVersion,versions:INTELLIGENCE_VERSIONS,
          ...(evidenceOnly?{source:context.sourceGeneration}:{}),
          input:context.inputGeneration,lifecycle:context.lifecycleGeneration,auth:context.authGeneration,purge:context.purgeGeneration},hypotheses:finalized.map(value=>({factor:value.hypothesis.factor,outcome_metric:value.hypothesis.outcomeMetric,
          lag_days:value.hypothesis.lagDays,comparison_health_dates:value.hypothesis.comparisonHealthDates,
          journal_authority:value.journalAuthority,days:value.days,raw_significance:value.rawSignificance,
          adjusted_significance:value.analysis.adjustedSignificance,replication_windows:value.replicationWindows}))};
      const outputs=[],runs=[],familyRefs=finalized.flatMap(value=>value.refs);
      if(!familyRefs.length)familyRefs.push((await core.root(context,'USER',context.userId)).ref);
      for(let index=0;index<finalized.length;index+=1) {
        const value=finalized[index],analysis=value.analysis,hypothesis=value.hypothesis,focusKey=hypothesisKey(hypothesis),
          manifest={...familyManifest,focus_key:focusKey},
          manifestJson=canonicalJson(manifest),inputHash=keys.lookup(['phase4-association-input-v2',context.userId,
            context.executionMode,context.inputGeneration,manifestJson]),runKey=keys.lookup(['phase4-evidence-run-v2',context.userId,
            context.executionMode,'JOURNAL_ASSOCIATION',request.multipleTestingFamily,focusKey,request.asOfUtc,context.inputGeneration,inputHash]);
        let runRow=(await client.execute({sql:'SELECT * FROM evidence_runs WHERE user_id=? AND execution_mode=? AND deterministic_run_key=?',
          args:[context.userId,context.executionMode,runKey]})).rows[0],run;
        const durableReplay=Boolean(runRow);
        if(runRow) {
          if(!readableRow(runRow)||runRow.invalidated_at||runRow.state!=='COMPLETED'||runRow.input_manifest_hash!==inputHash)
            fail('PHASE4_EVIDENCE_REPLAY_CONFLICT');
          run=await core.artifact(context,'evidence_runs',{run_id:runRow.run_id});
        } else {
          const windowStart=`${hypothesis.comparisonHealthDates[0]}T00:00:00.000Z`,
            nextDayEnd=`${addDays(hypothesis.comparisonHealthDates.at(-1),1)}T00:00:00.000Z`,
            windowEnd=nextDayEnd<request.asOfUtc?nextDayEnd:request.asOfUtc;
          run=await entities.append(context,'evidence_runs',{deterministic_run_key:runKey,
            subject_key:`association:${hypothesis.factor}:${hypothesis.outcomeMetric}:lag-${hypothesis.lagDays}`,
            method:'JOURNAL_ASSOCIATION',window_start_utc:windowStart,window_end_utc:windowEnd,
            as_of_utc:request.asOfUtc,timezone:context.timezone,algorithm_version:INTELLIGENCE_VERSIONS.algorithm,
            registry_version:INTELLIGENCE_VERSIONS.registry,evidence_contract_version:INTELLIGENCE_VERSIONS.evidenceContract,
            promotion_confound_version:INTELLIGENCE_VERSIONS.promotionConfound,
            exposure_classification_version:INTELLIGENCE_VERSIONS.exposureClassification,factor_set_version:INTELLIGENCE_VERSIONS.factorSet,
            multiple_testing_family:request.multipleTestingFamily,state:'STARTED',started_at:request.asOfUtc},familyRefs);
          run=await entities.completeEvidence(context,run.row.run_id,{sample_count:analysis.eligibleObservationDays,exclusion_count:0,
            unknown_eligible_days:analysis.unknownCount,eligible_observation_days:analysis.eligibleObservationDays,
            unknown_fraction:analysis.unknownFraction,input_manifest_json:manifest,input_manifest_hash:inputHash,
            missingness_json:{factor:hypothesis.factor,reason_codes:analysis.reasonCodes,comparison_day_count:analysis.comparisonDayCount,
              classified_exposed_days:analysis.classifiedExposedDays,classified_confirmed_unexposed_days:analysis.classifiedConfirmedUnexposedDays,
              exposed_outcome_present_count:analysis.exposedOutcomePresentCount,exposed_outcome_missing_count:analysis.exposedOutcomeMissingCount,
              exposed_outcome_invalid_count:analysis.exposedOutcomeInvalidCount,
              confirmed_unexposed_outcome_present_count:analysis.confirmedUnexposedOutcomePresentCount,
              confirmed_unexposed_outcome_missing_count:analysis.confirmedUnexposedOutcomeMissingCount,
              confirmed_unexposed_outcome_invalid_count:analysis.confirmedUnexposedOutcomeInvalidCount},
            multiple_testing_family:request.multipleTestingFamily});
        }
        runs.push(run);
        const itemKey=keys.lookup(['phase4-evidence-item-v1',runKey,focusKey,
          hypothesis.factor,hypothesis.outcomeMetric,hypothesis.lagDays]);
        const item=await entities.append(context,'evidence_items',{run_id:run.row.run_id,item_key:itemKey,
          claim_key:`association:${hypothesis.factor}:${hypothesis.outcomeMetric}:lag-${hypothesis.lagDays}`,
          direction:analysis.direction,unit:analysis.unit,effect:analysis.effect,raw_significance:value.rawSignificance,
          adjusted_significance:analysis.adjustedSignificance,exposed_count:analysis.exposedCount,
          confirmed_unexposed_count:analysis.confirmedUnexposedCount,unknown_count:analysis.unknownCount,
          effective_sample_count:analysis.exposedCount+analysis.confirmedUnexposedCount,
          exposure_classification_version:INTELLIGENCE_VERSIONS.exposureClassification,factor_set_version:INTELLIGENCE_VERSIONS.factorSet,
          quality:analysis.repeated?'AVAILABLE':'LIMITED',recency_weight:recencyWeight(Math.max(0,(Date.parse(request.asOfUtc)
            -Date.parse(run.row.window_end_utc))/86400000)),causal_status:'ASSOCIATION_ONLY',
          provenance_json:{method:'EXPOSED_VS_CONFIRMED_UNEXPOSED',factor:hypothesis.factor,outcome_metric:hypothesis.outcomeMetric,
            lag_days:hypothesis.lagDays,replication_windows:analysis.replicationWindows,minimum_effect_size:analysis.minimumEffectSize,
            readiness:analysis.readiness,eligible_observation_days:analysis.eligibleObservationDays,unknown_eligible_days:analysis.unknownCount,
            confidence:analysis.confidence},
          confound_json:{hard_flags:analysis.hardConfoundFlags,outcome_missing_fraction_exposed:analysis.missingOutcomeFractionExposed,
            outcome_missing_fraction_unexposed:analysis.missingOutcomeFractionUnexposed,soft_confound_fraction:analysis.confidence.components.softConfoundFraction}},familyRefs);
        if(durableReplay&&item.created)fail('PHASE4_DURABLE_REPLAY_BINDING_INVALID');
        if(canonicalJson(durableConfidence(item))!==canonicalJson(analysis.confidence))fail('PHASE4_EVIDENCE_CONFIDENCE_REPLAY_CONFLICT');
        if(!durableReplay&&item.created)producedEvidence(context,{run,item});
        const insight=evidenceOnly?null:durableReplay?await replayAssociationInsight(context,hypothesis,analysis,item,request.asOfUtc)
          :await updateInsight(context,hypothesis,analysis,item,request.asOfUtc);
        if(!durableReplay) {
          const dependencies=[],ids=new Set();
          for(const value of [insight?.current,insight?.contradiction].filter(Boolean)) {
            const revisions=(await client.execute({sql:`SELECT * FROM insight_revisions WHERE user_id=? AND execution_mode=?
              AND insight_id=? AND revision<=? AND input_generation=?`,args:[context.userId,context.executionMode,
              value.row.id,value.revision.revision,context.inputGeneration]})).rows;
            for(const revision of revisions)for(const id of [...revisionEvidenceIds(revision,'supporting_evidence_ids_json'),
              ...revisionEvidenceIds(revision,'contradicting_evidence_ids_json')])ids.add(id);
          }
          for(const id of ids)if(id!==item.row.evidence_item_id)
            dependencies.push((await core.artifact(context,'evidence_items',{evidence_item_id:id})).ref);
          for(const [scope,value] of [['INSIGHT_CURRENT',insight?.current],['INSIGHT_CONTRADICTION',insight?.contradiction]])
            await authorities.persist(context,{item,run,scope,origin:insightBinding(value),sourceRefs:[...familyRefs,...dependencies]});
        }
        outputs.push(Object.freeze({analysis,item,insight,replayed:durableReplay}));
      }
      return Object.freeze({resultState:evidenceOnly?'EVIDENCE_ONLY':outputs.some(value=>value.insight)?'POSITIVE':finalized.every(value=>!value.outcomes.length)?'EMPTY_ASSOCIATION_UNIVERSE':'NO_INSIGHT',
        runs:Object.freeze(runs),items:Object.freeze(outputs)});
    });
  }
  async function expireInsight(context,request) {
    return core.run(context,async()=>{
      if(context.executionMode!=='SHADOW')fail('PHASE4_INTELLIGENCE_SHADOW_ONLY');
      if(!exactKeys(request,['insightId','asOfUtc'])||!validInstant(request.asOfUtc)
        ||Date.parse(request.asOfUtc)>core.now().getTime())fail('PHASE4_INSIGHT_EXPIRY_REQUEST_INVALID');
      const {insightId}=request,asOfUtc=requireSemanticTime(request.asOfUtc);
      if(!Number.isSafeInteger(insightId)||insightId<1)fail('PHASE4_INSIGHT_ID_REQUIRED');
      const current=await insights.read(context,insightId,{history:true});
      if(current.row.status==='RETIRED')return current;
      if(!current.row.expires_at||Date.parse(current.row.expires_at)>Date.parse(asOfUtc))fail('PHASE4_INSIGHT_NOT_EXPIRED');
      const supporting=JSON.parse(current.revision.supporting_evidence_ids_json??'[]');
      const disposition=current.row.status==='HYPOTHESIS'?'REJECTED':'EXPIRED';
      return insights.transition(context,{insightId,expectedRevision:current.row.current_revision,status:'RETIRED',disposition,
        claim:current.row.statement,supportingEvidenceIds:supporting,reason:disposition,semanticAt:asOfUtc});
    });
  }
  async function expireEpisode(context,request) {
    return core.run(context,async()=>{
      if(context.executionMode!=='SHADOW')fail('PHASE4_INTELLIGENCE_SHADOW_ONLY');
      if(!exactKeys(request,['episodeId','asOfUtc'])||!validInstant(request.asOfUtc)
        ||Date.parse(request.asOfUtc)>core.now().getTime())fail('PHASE4_EPISODE_EXPIRY_REQUEST_INVALID');
      const {episodeId}=request,asOfUtc=requireSemanticTime(request.asOfUtc);
      if(typeof episodeId!=='string'||!episodeId)fail('PHASE4_EPISODE_ID_REQUIRED');
      const current=await episodes.read(context,episodeId),row=current.row;
      if(!ACTIVE.includes(row.state))return current;
      if(!row.expires_at||Date.parse(row.expires_at)>Date.parse(asOfUtc))fail('PHASE4_EPISODE_NOT_EXPIRED');
      const item=await core.artifact(context,'evidence_items',{evidence_item_id:row.latest_evidence_item_id});
      await episodes.revise(context,{episodeId,expectedRevision:row.revision,toState:'EXPIRED',patch:{latest_evidence_item_id:row.latest_evidence_item_id},
        sourceRefs:[item.ref],reasonCode:'WINDOW_EXPIRED',resolutionHoldMs:phase4Metric(row.subject_key).resolutionHoldMs,semanticAt:asOfUtc});
      return episodes.read(context,episodeId);
    });
  }
  return Object.freeze({analyzeMetric,analyzeAssociationFamily,expireInsight,expireEpisode,metricPreparationUnit,metricPreparationUnitFromCurrentBody,withCurrentBodyMetricObservation,replayCurrentBodyMetricFamily});
}
