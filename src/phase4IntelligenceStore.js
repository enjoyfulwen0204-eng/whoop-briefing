import { fail, readableRow } from './phase4Core.js';
import { canonicalJson } from './phase4EntityStore.js';
import { addDays, localDate } from './time.js';
import { phase4Metric, INTELLIGENCE_VERSIONS } from './phase4IntelligenceRegistry.js';
import { assessDataQuality, benjaminiHochberg, buildPersonalBaseline, evaluateJournalAssociation,
  evaluateMeaningfulChange, evidenceConfidence, recencyWeight, validMetricValue,
  validateEvidenceConfidence, compareBaselineSources } from './phase4Intelligence.js';
import { pearson, pValue } from './analytics/correlation.js';

const ACTIVE = ['OPEN','UPDATING','ESCALATED','EXPLAINED','STABILIZING'];
const MERGE_GAP_MS = 36*60*60*1000;
const exactKeys = (value, keys) => value && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const validInstant = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const validHealthDate = value => typeof value==='string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && new Date(`${value}T00:00:00.000Z`).toISOString().slice(0,10)===value;
const sourceTimestamp = row => row.as_of_utc ?? row.end_at ?? row.updated_at ?? row.created_at ?? row.synced_at ?? null;
const ingestedTimestamp = row => row.synced_at ?? row.created_at ?? row.as_of_utc ?? null;

export function createPhase4IntelligenceStore(core, entities, episodes, insights) {
  const {client,keys}=core;
  function sourceValue(metricKey, source, context, asOfUtc) {
    const contract=phase4Metric(metricKey),row=source.row;
    if(!row||source.type!==contract.sourceType)fail('PHASE4_METRIC_SOURCE_MISMATCH');
    if(source.type==='sleep'&&(row.score_state!=='SCORED'||row.nap!==0))fail('PHASE4_METRIC_SOURCE_INVALID');
    if(source.type==='recovery'&&(row.score_state!=='SCORED'||row.user_calibrating!==0))fail('PHASE4_METRIC_SOURCE_INVALID');
    if(source.type==='cycle'&&row.score_state!==null&&row.score_state!==undefined&&row.score_state!=='SCORED')fail('PHASE4_METRIC_SOURCE_INVALID');
    if(source.type==='body_energy_results'&&!['LIMITED','AVAILABLE'].includes(row.quality_state))fail('PHASE4_METRIC_SOURCE_INVALID');
    const raw=row[contract.field],value=typeof raw==='number'&&Number.isFinite(raw)?raw/(contract.divisor??1):raw;
    const observedAt=sourceTimestamp(row),ingestedAt=ingestedTimestamp(row);
    if(!validInstant(observedAt)||!validInstant(ingestedAt)||!validInstant(asOfUtc)
      ||Date.parse(observedAt)>Date.parse(asOfUtc)||Date.parse(ingestedAt)>Date.parse(asOfUtc)
      ||(row.updated_at!==null&&row.updated_at!==undefined
        &&(!validInstant(row.updated_at)||Date.parse(row.updated_at)>Date.parse(asOfUtc))))fail('PHASE4_METRIC_SOURCE_INVALID');
    const healthDate=row.health_date??localDate(new Date(observedAt),context.timezone);
    const versionKnown=!['sleep','recovery','cycle'].includes(source.type)||row.updated_at!==null&&row.updated_at!==undefined;
    return {sourceType:source.type,sourceId:source.id,sourceVersion:canonicalJson([row.updated_at??null,row.synced_at??null,
      row.as_of_utc??null,row.score_state??null]),healthDate,observedAt,ingestedAt,value,versionKnown};
  }
  function associationOutcomeValue(metricKey,source,context,asOfUtc) {
    const contract=phase4Metric(metricKey),row=source.row;
    if(!row||source.type!==contract.sourceType)fail('PHASE4_METRIC_SOURCE_MISMATCH');
    const raw=row[contract.field],value=typeof raw==='number'&&Number.isFinite(raw)?raw/(contract.divisor??1):raw,
      observedAt=sourceTimestamp(row),ingestedAt=ingestedTimestamp(row);
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
    return {sourceType:source.type,sourceId:source.id,sourceVersion:canonicalJson([row.updated_at??null,row.synced_at??null,
      row.as_of_utc??null,row.score_state??null]),healthDate,observedAt,ingestedAt,value:scored&&versionKnown
        &&validMetricValue(metricKey,value)?value:null,outcomeStatus:scored&&versionKnown&&validMetricValue(metricKey,value)
        ?'PRESENT':'INVALID',versionKnown};
  }
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
  function manifest(metricKey,current,baseline,quality,calculation,asOfUtc) {
    return {manifest_version:'phase4-metric-evidence-input-v1',metric_key:metricKey,as_of_utc:asOfUtc,current,
      baseline:{version:baseline.version,target_health_date:baseline.targetHealthDate,lookback_days:baseline.lookbackDays,
        samples:baseline.samples,exclusions:baseline.exclusions,median:baseline.median,mad:baseline.mad,q1:baseline.q1,q3:baseline.q3,
        scale:baseline.scale,scale_method:baseline.scaleMethod},quality,calculation};
  }
  function metricEvidencePlan(context,{metricKey,sourceSet,baseline,quality,calculation,asOfUtc}) {
    const input=manifest(metricKey,sourceSet.current,baseline,quality,calculation,asOfUtc),json=canonicalJson(input);
    const inputHash=keys.lookup(['phase4-evidence-input-v1',context.userId,context.executionMode,context.inputGeneration,json]);
    const runKey=keys.lookup(['phase4-evidence-run-v1',context.userId,context.executionMode,'PERSONAL_BASELINE_DEVIATION',
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
      if(runRow.state!=='COMPLETED'||runRow.input_manifest_hash!==inputHash)fail('PHASE4_EVIDENCE_REPLAY_CONFLICT');
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
    return {run,item,inputHash,confidence:storedConfidence};
  }
  async function linkMembership(context,episode,item,sourceSet,calculation,confidence) {
    if(!['LIMITED','AVAILABLE'].includes(calculation.qualityStatus)
      ||confidence?.version!==INTELLIGENCE_VERSIONS.evidenceConfidence||!Number.isFinite(confidence.score))
      fail('PHASE4_EPISODE_EVIDENCE_NOT_QUALIFIED');
    const observationKey=keys.lookup(['phase4-observation-v1',context.userId,context.executionMode,episode.row.episode_id,
      sourceSet.current.sourceType,sourceSet.current.sourceId,sourceSet.current.sourceVersion]);
    const prior=(await client.execute({sql:`SELECT * FROM episode_observations WHERE user_id=? AND execution_mode=?
      AND episode_id=? AND observation_key=?`,args:[context.userId,context.executionMode,episode.row.episode_id,observationKey]})).rows[0];
    const observation=prior?await core.artifact(context,'episode_observations',{episode_id:episode.row.episode_id,observation_key:observationKey})
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
    const contract=phase4Metric(calculation.metricKey);
    return {episode_type:'METRIC_DEVIATION',severity:calculation.severity,current_confidence:Math.min(calculation.confidence,confidence.score),
      current_novelty:Number(calculation.novelty),explained_status:0,first_observed_at:sourceSet.current.observedAt,
      last_observed_at:sourceSet.current.observedAt,last_material_change_at:sourceSet.current.observedAt,
      expires_at:new Date(Date.parse(sourceSet.current.observedAt)+contract.episodeExpiryMs).toISOString(),
      health_window_start:sourceSet.current.observedAt,health_window_end:asOfUtc,timezone:context.timezone,
      semantic_summary_hash:calculation.semanticHash,max_semantic_severity_ordinal:calculation.severity};
  }
  async function priorEpisodeSemanticHash(context,episodeId,revision) {
    const row=(await client.execute({sql:`SELECT i.evidence_item_id FROM episode_evidence x JOIN evidence_items i
      ON i.user_id=x.user_id AND i.execution_mode=x.execution_mode AND i.evidence_item_id=x.evidence_item_id
      WHERE x.user_id=? AND x.execution_mode=? AND x.episode_id=? AND x.episode_revision<?
        AND x.unlinked_at IS NULL ORDER BY x.episode_revision DESC LIMIT 1`,
    args:[context.userId,context.executionMode,episodeId,revision]})).rows[0];
    if(!row)return null;
    const item=await core.artifact(context,'evidence_items',{evidence_item_id:row.evidence_item_id});
    let provenance;try {provenance=JSON.parse(item.row.provenance_json??'null');}catch {fail('PHASE4_EVIDENCE_REPLAY_CONFLICT');}
    return typeof provenance?.semantic_hash==='string'?provenance.semantic_hash:null;
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
    const links=(await client.execute({sql:`SELECT * FROM episode_evidence WHERE user_id=? AND execution_mode=?
      AND evidence_item_id=? ORDER BY episode_revision`,args:[context.userId,context.executionMode,item.row.evidence_item_id]})).rows;
    if(!links.length) {
      if(observationCalculation.targetEpisodeState)fail('PHASE4_DURABLE_REPLAY_BINDING_INVALID');
      return {calculation:observationCalculation,episode:null};
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
    let priorHash=await priorEpisodeSemanticHash(context,binding.row.episode_id,binding.row.episode_revision);
    if(!priorHash&&binding.row.episode_revision===1&&historical.row.reverses_episode_id)
      priorHash=await priorEpisodeSemanticHash(context,historical.row.reverses_episode_id,Number.MAX_SAFE_INTEGER);
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
  async function analyzeMetric(context,request) {
    return core.run(context,async()=>{
      if(context.executionMode!=='SHADOW')fail('PHASE4_INTELLIGENCE_SHADOW_ONLY');
      if(!exactKeys(request,['metricKey','currentSource','baselineSources','asOfUtc','windowFamily'])||!validInstant(request.asOfUtc)
        ||Date.parse(request.asOfUtc)>core.now().getTime()||typeof request.windowFamily!=='string'||!request.windowFamily)
        fail('PHASE4_METRIC_ANALYSIS_REQUEST_INVALID');
      const contract=phase4Metric(request.metricKey),sourceSet=await sources(context,request.metricKey,request.currentSource,
        request.baselineSources,request.asOfUtc);
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
        calculation:observationCalculation,asOfUtc:request.asOfUtc});
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
      return Object.freeze({baseline,quality,calculation,run:evidence.run,item:evidence.item,episode});
    });
  }
  function parseFactorKeys(row) {
    let values;
    try {values=JSON.parse(row.factor_keys_json??'null');}catch {fail('PHASE4_COVERAGE_FACTOR_SET_INVALID');}
    if(!Array.isArray(values)||values.some(value=>typeof value!=='string'))fail('PHASE4_COVERAGE_FACTOR_SET_INVALID');
    return values;
  }
  function associationWindows(days,direction) {
    const classified=days.filter(day=>day.exposureState!=='UNKNOWN'&&Number.isFinite(day.outcome))
      .sort((a,b)=>a.healthDate.localeCompare(b.healthDate));
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
      .sort((a,b)=>a.value.healthDate.localeCompare(b.value.healthDate)||a.value.sourceId.localeCompare(b.value.sourceId)
        ||a.value.sourceVersion.localeCompare(b.value.sourceVersion));
    if(new Set(outcomeEntries.map(entry=>entry.value.healthDate)).size!==outcomeEntries.length
      ||outcomeEntries.some(entry=>!comparisonHealthDates.includes(entry.value.healthDate)))fail('PHASE4_ASSOCIATION_OUTCOME_DAYS_INVALID');
    const journal=await core.journalSourcesAsOf(context,[...hypothesis.journalFactSources,...hypothesis.coverageSources],asOfUtc);
    const facts=journal.filter(source=>source.type==='JOURNAL_FACT').sort((a,b)=>a.row.logical_fact_id.localeCompare(b.row.logical_fact_id)
      ||a.row.revision-b.row.revision||a.id.localeCompare(b.id));
    const coverage=journal.filter(source=>source.type==='JOURNAL_COVERAGE').sort((a,b)=>a.row.health_date_start.localeCompare(b.row.health_date_start)
      ||a.row.health_date_end.localeCompare(b.row.health_date_end)||a.row.revision-b.row.revision||a.id.localeCompare(b.id));
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
            .map(source=>[source.type,source.id,source.row.revision])).sort((a,b)=>canonicalJson(a).localeCompare(canonicalJson(b)))};
    });
    const first=evaluateJournalAssociation({factor:hypothesis.factor,outcomeMetric:hypothesis.outcomeMetric,days,asOfUtc});
    const classified=days.filter(day=>day.exposureState!=='UNKNOWN'&&Number.isFinite(day.outcome)),xs=classified.map(day=>day.exposureState==='EXPOSED'?1:0),
      ys=classified.map(day=>day.outcome),rawSignificance=first.candidate?pValue(pearson(xs,ys),classified.length):null;
    const canonicalJournal=[...facts,...coverage],refs=[...outcomeEntries.map(entry=>entry.ref),...canonicalJournal.map(source=>source.ref)];
    return {hypothesis:{...hypothesis,comparisonHealthDates},refs,outcomes,days,rawSignificance,
      journalAuthority:canonicalJournal.map(source=>({type:source.type,id:source.id,revision:source.row.revision,
        createdAt:source.row.created_at,asOfUtc})),
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
  function insightKey(context,identity) {
    const normalized=value=>value.normalize('NFC').trim().replace(/\s+/g,' ').toLowerCase();
    return keys.lookup(['insight-key-v1',context.userId,...['subject','outcome','direction','exposureCategory','algorithmFamily','evidenceContractMajor']
      .map(key=>normalized(identity[key]))]);
  }
  async function currentInsight(context,identity) {
    const row=(await client.execute({sql:`SELECT * FROM health_insights WHERE user_id=? AND execution_mode=? AND insight_key=?
      AND status<>'RETIRED' AND legacy_classification='PHASE4'`,args:[context.userId,context.executionMode,insightKey(context,identity)]})).rows[0];
    return row?insights.read(context,row.id,{history:true}):null;
  }
  function revisionEvidenceIds(row,field) {
    let ids;try {ids=JSON.parse(row[field]??'[]');}catch {fail('PHASE4_INSIGHT_POINTER_INVALID');}
    if(!Array.isArray(ids)||ids.some(id=>typeof id!=='string'))fail('PHASE4_INSIGHT_POINTER_INVALID');
    return ids;
  }
  async function historicalInsightArtifact(context,insightId,revisionNumber,asOfUtc) {
    const parent=await core.artifact(context,'health_insights',{id:insightId});
    const revision=await core.artifact(context,'insight_revisions',{insight_id:insightId,revision:revisionNumber});
    const row={...parent.row,status:revision.row.status,lifecycle_disposition:revision.row.lifecycle_disposition,
      statement:revision.row.normalized_claim,current_revision:revision.row.revision,version:revision.row.revision,
      last_recalculated_at:revision.row.revision>1?asOfUtc:null,retired_at:revision.row.status==='RETIRED'?asOfUtc:null};
    return {...parent,row,revision:revision.row};
  }
  async function revisionBoundToEvidence(context,itemId,field,{expectedInsightKey=null,asOfUtc}) {
    const rows=(await client.execute({sql:`SELECT * FROM insight_revisions WHERE user_id=? AND execution_mode=? ORDER BY insight_id,revision`,
      args:[context.userId,context.executionMode]})).rows;
    const candidates=[];
    for(const row of rows)if(revisionEvidenceIds(row,field).includes(itemId))candidates.push(row);
    const matches=[];
    for(const first of candidates.filter((row,index,array)=>!array.some(other=>other.insight_id===row.insight_id&&other.revision<row.revision))) {
      const parent=(await client.execute({sql:`SELECT insight_key FROM health_insights WHERE user_id=? AND execution_mode=? AND id=?`,
        args:[context.userId,context.executionMode,first.insight_id]})).rows[0];
      if(!parent||expectedInsightKey!==null&&parent.insight_key!==expectedInsightKey)continue;
      const preceding=rows.filter(row=>row.insight_id===first.insight_id&&row.revision<first.revision).at(-1),allowed=new Set([
        ...revisionEvidenceIds(preceding??{},'supporting_evidence_ids_json'),
        ...revisionEvidenceIds(preceding??{},'contradicting_evidence_ids_json'),
        ...revisionEvidenceIds(first,'supporting_evidence_ids_json'),...revisionEvidenceIds(first,'contradicting_evidence_ids_json')]);
      const allowedReasons=field==='supporting_evidence_ids_json'
        ?new Set(['CANDIDATE_EVIDENCE','REPEATED_EVIDENCE','REPLICATED_SUPPORT'])
        :new Set(['CONTRADICTORY_EVIDENCE','REFUTED']);
      let selected=first;
      for(const next of rows.filter(row=>row.insight_id===first.insight_id&&row.revision>first.revision)) {
        const all=[...revisionEvidenceIds(next,'supporting_evidence_ids_json'),...revisionEvidenceIds(next,'contradicting_evidence_ids_json')];
        if(!allowedReasons.has(next.transition_reason)||!revisionEvidenceIds(next,field).includes(itemId)
          ||all.some(id=>!allowed.has(id)))break;
        selected=next;
      }
      matches.push(selected);
    }
    if(matches.length>1)fail('PHASE4_DURABLE_REPLAY_BINDING_INVALID');
    return matches[0]?historicalInsightArtifact(context,matches[0].insight_id,matches[0].revision,asOfUtc):null;
  }
  async function replayAssociationInsight(context,hypothesis,analysis,item,asOfUtc) {
    if(!analysis.candidate||!analysis.direction)return null;
    const identity=insightIdentity(hypothesis,analysis.direction),current=await revisionBoundToEvidence(context,
      item.row.evidence_item_id,'supporting_evidence_ids_json',{expectedInsightKey:insightKey(context,identity),asOfUtc});
    if(!current)fail('PHASE4_DURABLE_REPLAY_BINDING_INVALID');
    const contradiction=await revisionBoundToEvidence(context,item.row.evidence_item_id,'contradicting_evidence_ids_json',{asOfUtc});
    return {current,contradiction};
  }
  const associationClaim=(hypothesis,direction,status)=>status==='SUPPORTED'
    ? `${hypothesis.factor} has been repeatedly associated in your data with ${direction.toLowerCase()} ${hypothesis.outcomeMetric}.`
    : `${hypothesis.factor} may be associated with ${direction.toLowerCase()} ${hypothesis.outcomeMetric}; we are still checking.`;
  async function reviseContradiction(context,hypothesis,analysis,item,asOfUtc) {
    if(!analysis.repeated||durableConfidence(item).score<.5)return null;
    const opposite=analysis.direction==='HIGHER'?'LOWER':'HIGHER',existing=await currentInsight(context,insightIdentity(hypothesis,opposite));
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
    let current=await currentInsight(context,identity);
    if(!current)current=await insights.create(context,{identity,claim,evidenceContractVersion:INTELLIGENCE_VERSIONS.evidenceContract,
      supportingEvidenceIds:[item.row.evidence_item_id],creationKey:insightKey(context,identity),
      expiresAt:new Date(Date.parse(asOfUtc)+phase4Metric(hypothesis.outcomeMetric).evidenceExpiryMs).toISOString(),semanticAt:asOfUtc});
    if(analysis.repeated&&promotionReady&&current.row.status==='HYPOTHESIS')current=await insights.transition(context,{insightId:current.row.id,
      expectedRevision:current.row.current_revision,status:'EMERGING',claim,supportingEvidenceIds:[item.row.evidence_item_id],
      reason:'REPEATED_EVIDENCE',semanticAt:asOfUtc});
    else if(analysis.insightSupporting&&promotionReady&&current.row.status==='EMERGING') {
      const prior=JSON.parse(current.revision.supporting_evidence_ids_json??'[]'),supporting=[...new Set([...prior,item.row.evidence_item_id])];
      const windows=[];for(const id of supporting) {
        const evidence=await core.artifact(context,'evidence_items',{evidence_item_id:id});
        const run=await core.artifact(context,'evidence_runs',{run_id:evidence.row.run_id});windows.push([run.row.window_start_utc,run.row.window_end_utc]);
      }
      const independent=windows.some((a,index)=>windows.some((b,other)=>index!==other&&(a[1]<=b[0]||b[1]<=a[0])));
      if(supporting.length>=2&&independent)current=await insights.transition(context,{insightId:current.row.id,expectedRevision:current.row.current_revision,
        status:'SUPPORTED',claim:associationClaim(hypothesis,analysis.direction,'SUPPORTED'),supportingEvidenceIds:supporting,
        reason:'REPLICATED_SUPPORT',semanticAt:asOfUtc});
    }
    return {current,contradiction};
  }
  async function analyzeAssociationFamily(context,request) {
    return core.run(context,async()=>{
      if(context.executionMode!=='SHADOW')fail('PHASE4_INTELLIGENCE_SHADOW_ONLY');
      if(!exactKeys(request,['asOfUtc','multipleTestingFamily','hypotheses'])||!validInstant(request.asOfUtc)
        ||Date.parse(request.asOfUtc)>core.now().getTime()||typeof request.multipleTestingFamily!=='string'
        ||!request.multipleTestingFamily||request.multipleTestingFamily.length>128||!Array.isArray(request.hypotheses)
        ||!request.hypotheses.length||request.hypotheses.length>16)fail('PHASE4_ASSOCIATION_FAMILY_INVALID');
      const orderedHypotheses=[...request.hypotheses].sort((a,b)=>hypothesisKey(a).localeCompare(hypothesisKey(b)));
      if(new Set(orderedHypotheses.map(hypothesisKey)).size!==orderedHypotheses.length)fail('PHASE4_ASSOCIATION_HYPOTHESIS_DUPLICATE');
      const prepared=[];for(const hypothesis of orderedHypotheses)prepared.push(await associationHypothesis(context,hypothesis,request.asOfUtc));
      const adjusted=benjaminiHochberg(prepared.map(value=>({key:hypothesisKey(value.hypothesis),
        pValue:value.rawSignificance??1})));
      const finalized=prepared.map((value,index)=>({...value,analysis:evaluateJournalAssociation({factor:value.hypothesis.factor,
        outcomeMetric:value.hypothesis.outcomeMetric,days:value.days,replicationWindows:value.replicationWindows,
        adjustedSignificance:adjusted[index].adjusted,asOfUtc:request.asOfUtc})}));
      const familyManifest={manifest_version:'phase4-association-family-input-v1',multiple_testing_family:request.multipleTestingFamily,
        as_of_utc:request.asOfUtc,hypotheses:finalized.map(value=>({factor:value.hypothesis.factor,outcome_metric:value.hypothesis.outcomeMetric,
          lag_days:value.hypothesis.lagDays,comparison_health_dates:value.hypothesis.comparisonHealthDates,
          journal_authority:value.journalAuthority,days:value.days,raw_significance:value.rawSignificance,
          adjusted_significance:value.analysis.adjustedSignificance,replication_windows:value.replicationWindows}))};
      const outputs=[],runs=[];
      for(let index=0;index<finalized.length;index+=1) {
        const value=finalized[index],analysis=value.analysis,hypothesis=value.hypothesis,focusKey=hypothesisKey(hypothesis),
          manifest={...familyManifest,focus_key:focusKey},
          manifestJson=canonicalJson(manifest),inputHash=keys.lookup(['phase4-association-input-v1',context.userId,
            context.executionMode,context.inputGeneration,manifestJson]),runKey=keys.lookup(['phase4-evidence-run-v1',context.userId,
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
            multiple_testing_family:request.multipleTestingFamily,state:'STARTED',started_at:request.asOfUtc},value.refs);
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
            outcome_missing_fraction_unexposed:analysis.missingOutcomeFractionUnexposed,soft_confound_fraction:analysis.confidence.components.softConfoundFraction}},value.refs);
        if(durableReplay&&item.created)fail('PHASE4_DURABLE_REPLAY_BINDING_INVALID');
        if(canonicalJson(durableConfidence(item))!==canonicalJson(analysis.confidence))fail('PHASE4_EVIDENCE_CONFIDENCE_REPLAY_CONFLICT');
        const insight=durableReplay?await replayAssociationInsight(context,hypothesis,analysis,item,request.asOfUtc)
          :await updateInsight(context,hypothesis,analysis,item,request.asOfUtc);
        outputs.push(Object.freeze({analysis,item,insight,replayed:durableReplay}));
      }
      return Object.freeze({runs:Object.freeze(runs),items:Object.freeze(outputs)});
    });
  }
  async function expireInsight(context,request) {
    return core.run(context,async()=>{
      if(context.executionMode!=='SHADOW')fail('PHASE4_INTELLIGENCE_SHADOW_ONLY');
      if(!exactKeys(request,['insightId','asOfUtc'])||!validInstant(request.asOfUtc)
        ||Date.parse(request.asOfUtc)>core.now().getTime())fail('PHASE4_INSIGHT_EXPIRY_REQUEST_INVALID');
      const {insightId,asOfUtc}=request;
      if(!Number.isSafeInteger(insightId)||insightId<1)fail('PHASE4_INSIGHT_ID_REQUIRED');
      const current=await insights.read(context,insightId,{history:true});
      if(current.row.status==='RETIRED')return current;
      if(!current.row.expires_at||current.row.expires_at>asOfUtc)fail('PHASE4_INSIGHT_NOT_EXPIRED');
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
      const {episodeId,asOfUtc}=request;
      if(typeof episodeId!=='string'||!episodeId)fail('PHASE4_EPISODE_ID_REQUIRED');
      const current=await episodes.read(context,episodeId),row=current.row;
      if(!ACTIVE.includes(row.state))return current;
      if(!row.expires_at||row.expires_at>asOfUtc)fail('PHASE4_EPISODE_NOT_EXPIRED');
      const item=await core.artifact(context,'evidence_items',{evidence_item_id:row.latest_evidence_item_id});
      await episodes.revise(context,{episodeId,expectedRevision:row.revision,toState:'EXPIRED',patch:{latest_evidence_item_id:row.latest_evidence_item_id},
        sourceRefs:[item.ref],reasonCode:'WINDOW_EXPIRED',resolutionHoldMs:phase4Metric(row.subject_key).resolutionHoldMs,semanticAt:asOfUtc});
      return episodes.read(context,episodeId);
    });
  }
  return Object.freeze({analyzeMetric,analyzeAssociationFamily,expireInsight,expireEpisode});
}
