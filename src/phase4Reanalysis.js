import {stage6CurrentCaptureTime} from './stage6CurrentCaptureTime.js';
import {bodyEnergyMetricAnalysisTime} from './bodyEnergyDerivedTime.js';
import { buildPhase4Core,fail } from './phase4Core.js';
import { composePhase4Stores } from './phase4Repositories.js';
import { createReanalysisQueue } from './phase4ReanalysisQueue.js';
import { createReanalysisInputs } from './phase4ReanalysisInputs.js';
import { PHASE4_METRICS,INTELLIGENCE_VERSIONS,phase4Metric } from './phase4IntelligenceRegistry.js';
import { canonicalEpisodeData,canonicalAssociationClaim } from './phase4IntelligenceStore.js';
import { insightIdentityKey } from './phase4InsightStore.js';
import { foundationFlags } from './phase4Flags.js';
import { stage6Budget,requireTriggerSource } from './phase4DrainPolicy.js';
import { phase4Backlog } from './phase4Diagnostics.js';
import { createPhase4QueueStore } from './phase4QueueStore.js';
import { createOperationReceipts } from './phase4OperationReceipts.js';
import { createFamilyDirectory } from './phase4FamilyDirectory.js';
import { log } from './logger.js';
import {pilotPrefixFrom} from './betaPilotBoundedReads.js';
import {workStepOptions} from './phase4WorkStep.js';
import {requireSettledOperation} from './phase4ExecutionContext.js';
import {requireBetaPilotGrant,requireCurrentBetaPilotAttempt} from './betaPilotPermit.js';

const capabilities=new WeakSet();
// Both names resolve to the frozen Stage 5 registry. Adding a future
// calculation bundle requires a code-reviewed registry change, not a flag.
export const STAGE6_ALGORITHM_SET='phase4-stage5-canonical-v1';
/** Server composition only. A JSON request or an environment flag cannot
 * manufacture this capability. The default production factories never call
 * this issuer; the explicit Public Beta composition may do so for SHADOW. */
export function authorizeStage6ShadowWorker({executionMode}={}) {
  if(executionMode!=='SHADOW')fail('PHASE4_STAGE6_SHADOW_REQUIRED');
  const capability=Object.freeze({});capabilities.add(capability);return capability;
}
const errorCodes=new Map([
  ['PHASE4_INPUT_FENCED','STALE_GENERATION'],['PHASE4_TIMEZONE_FENCED','STALE_GENERATION'],
  ['PHASE4_PARENT_STALE','STALE_GENERATION'],['PHASE4_AUTH_FENCED','AUTH_CHANGED'],
  ['PHASE4_LIFECYCLE_FENCED','LIFECYCLE_CHANGED'],['PHASE4_PURGE_FENCED','CONTENT_REDACTED'],
  ['CONTENT_REDACTED','CONTENT_REDACTED'],['PHASE4_LEASE_CAS_LOST','LEASE_LOST'],
  ['PHASE4_RESOURCE_FENCED','SOURCE_UNAVAILABLE'],['PHASE4_CAPABILITY_FENCED','SOURCE_UNAVAILABLE'],
  ['PHASE4_REQUIRED_ROOT_VERSION_MISMATCH','SOURCE_UNAVAILABLE'],
  ['PHASE4_OPERATION_RECEIPT_INTEGRITY','INVARIANT_VIOLATION'],['PHASE4_METRIC_REFRESH_AUTHORITY_INVALID','INVARIANT_VIOLATION'],
  ['PHASE4_EPISODE_RECURRENCE_AUTHORITY_INVALID','INVARIANT_VIOLATION'],['PHASE4_EPISODE_PREDECESSOR_AMBIGUOUS','INVARIANT_VIOLATION'],
  ['PHASE4_OPERATION_RESULT_BOUNDS_UNAVAILABLE','SOURCE_UNAVAILABLE'],
  ['PHASE4_RECEIPT_ROUTE_LEGACY_UNKNOWN','SOURCE_UNAVAILABLE'],
  ['PHASE4_RECEIPT_ROUTE_AUTHORITY_INVALID','INVARIANT_VIOLATION'],
  ['PHASE4_FAMILY_DIRECTORY_LEGACY_UNKNOWN','SOURCE_UNAVAILABLE'],
  ['PHASE4_FAMILY_DIRECTORY_DESCRIPTOR_UNAVAILABLE','SOURCE_UNAVAILABLE'],
  ['PHASE4_FAMILY_DIRECTORY_AUTHORITY_INVALID','INVARIANT_VIOLATION'],
  ['PHASE4_ASSOCIATION_DEPENDENCY_SCOPE_INVALID','INVARIANT_VIOLATION'],
]);
export const stage6ErrorCode=error=>errorCodes.get(error?.code)??'CALCULATION_FAILED';

export async function createPhase4Stage6({db,keys,admission,executionMode,workerCapability,pilotGrant,now=()=>new Date(),
  monotonicNow=()=>performance.now(),configuration={}}={}) {
  if(executionMode!=='SHADOW')fail('PHASE4_STAGE6_SHADOW_REQUIRED');
  if(!capabilities.has(workerCapability))fail('PHASE4_STAGE6_CAPABILITY_REQUIRED');
  if(db?.raw?.protocol!=='file')requireBetaPilotGrant(pilotGrant,pilotGrant?.userId,db?.raw);
  foundationFlags(configuration);
  const core=await buildPhase4Core({processing:{client:db.raw,transaction:db.transaction,withReadSnapshot:db.withProcessingReadSnapshot,assertFences:db.assertRuntimeFences,active:db.processingTransactionActive,
    afterCommit:db.afterProcessingCommit,afterCompletion:db.afterProcessingCompletion},keys,admission,now,
    authorizeMode(mode){if(mode!=='SHADOW')fail('PHASE4_LIVE_NOT_AUTHORIZED');}});
  if(![28,29,30,31,32].includes(core.schemaVersion))fail('PHASE4_STAGE6_SCHEMA_REQUIRED');
  const stores=composePhase4Stores(core),queue=createReanalysisQueue(core),inputs=createReanalysisInputs(core,stores),client=core.client;
  const familyDirectory=core.schemaVersion>=30?createFamilyDirectory(client,keys):null;

  async function metricFamilies(context,req,history) {
    const contract=phase4Metric(req.metricKey);
    const active=[...history.latest.values()].filter(({row,snapshot})=>row.domain===contract.domain&&row.subject_key===req.metricKey
      &&(['OPEN','UPDATING','ESCALATED','EXPLAINED','STABILIZING'].includes(row.state)
        ||row.state==='RESOLVED'&&snapshot.semantic_at<=req.asOfUtc
          &&Date.parse(req.asOfUtc)-Date.parse(snapshot.semantic_at)<=7*86400000)).map(entry=>entry.row);
    if(active.length>64)fail('PHASE4_EPISODE_HISTORY_UNAVAILABLE');
    if(!active.length)return [req.windowFamily];
    const unresolved=new Set(active.map(row=>row.episode_family_key)),families=new Set(),receipts=createOperationReceipts(core);
    const rows=[...new Set([...history.histories.values()].flatMap(entries=>[...entries.values()].map(entry=>entry.receipt)))];
    if(rows.length>1000)fail('PHASE4_OPERATION_RESULT_BOUNDS_UNAVAILABLE');
    let bytes=0;
    for(const row of rows) {
      bytes+=Buffer.byteLength(row.related_results_json??'');if(bytes>64*1024*1024)fail('PHASE4_OPERATION_RESULT_BOUNDS_UNAVAILABLE');
      const request=receipts.authenticate(context,row).request_json.request;
      const identity=row.operation_kind==='analyzeMetric'?{metric:request.metricKey,domain:phase4Metric(request.metricKey).domain,
        subject:request.metricKey,algorithmMajor:INTELLIGENCE_VERSIONS.algorithm,windowFamily:request.windowFamily}:request.identity;
      if(!identity||identity.metric!==req.metricKey||identity.domain!==contract.domain||identity.subject!==req.metricKey
        ||identity.algorithmMajor!==INTELLIGENCE_VERSIONS.algorithm)continue;
      const family=keys.lookup(['episode-family-v1',context.userId,identity.domain,identity.metric,identity.algorithmMajor,identity.subject,identity.windowFamily]);
      if(unresolved.delete(family))families.add(identity.windowFamily);
    }
    if(unresolved.size)fail('PHASE4_EPISODE_HISTORY_UNAVAILABLE');
    return [...families].sort();
  }
  async function metrics(context,req) {
    const receipts=createOperationReceipts(core);
    // This inventory is explicitly cross-family: the worker must discover
    // retained custom windows before deciding which ones to recompute.
    const history=await receipts.episodeRecurrenceInventory(context,{metricKey:req.metricKey});
    for(const windowFamily of await metricFamilies(context,req,history)) {
      const precise=core.schemaVersion>=29?await receipts.episodeRecurrenceInventory(context,{metricKey:req.metricKey,
        episodeFamilyKey:keys.lookup(['episode-family-v1',context.userId,phase4Metric(req.metricKey).domain,
          req.metricKey,INTELLIGENCE_VERSIONS.algorithm,req.metricKey,windowFamily])}):history;
      await metric(context,{...req,windowFamily},precise);
    }
  }

  async function performMetricFamily(context,req,candidate,defaultKey,{replayOnly=false,readOnlyReplay=false}={}) {
    const current=await familyDirectory.inventory(context,req.metricKey),
      entry=current.entries.find(row=>row.family_key===candidate.familyKey);
    // A completed family tip cannot stand in for its DOMAIN receipt. Even
    // this early exit first performs the original full typed replay once.
    const replayPrepared=replayOnly?await stores.intelligence.replayExistingMetricPreparation(context,{...req,refresh:true}):null;
    if(entry&&!(await familyDirectory.work(context,entry)).due)return 'ALREADY_COMPLETE';
    if(readOnlyReplay)fail('PHASE4_REANALYSIS_REQUIRED');
    const precise=await createOperationReceipts(core).episodeRecurrenceInventory(context,
      {metricKey:req.metricKey,episodeFamilyKey:candidate.familyKey});
    const windowFamily=candidate.windowFamily??familyDirectory.resolveIdentity(context,entry,precise).windowFamily;
    if(entry&&candidate.familyKey!==defaultKey) {
      const relevant=[...precise.latest.values()].some(({row,snapshot})=>
        ['OPEN','UPDATING','ESCALATED','EXPLAINED','STABILIZING'].includes(row.state)
        ||row.state==='RESOLVED'&&snapshot.semantic_at<=req.asOfUtc
          &&Date.parse(req.asOfUtc)-Date.parse(snapshot.semantic_at)<=7*86400000);
      if(!relevant){await familyDirectory.complete(context,entry);return 'VALID_NO_LIFECYCLE_WORK';}
    }
    const result=await metric(context,{...req,windowFamily},precise,{replayOnly,replayPrepared});
    const settled=await familyDirectory.inventory(context,req.metricKey),
      owned=settled.entries.find(row=>row.family_key===candidate.familyKey);
    if(owned)await familyDirectory.complete(context,owned);
    return result;
  }

  async function metricsV30(context,req,lease,assertBudget,{preparedDefault=false,defaultReplay=null}={}) {
    const directory=defaultReplay?.inventory??await queue.owned(context,lease,()=>familyDirectory.inventory(context,req.metricKey),
      {assertBudget,workKind:'stage6.family-inventory',workFacts:[req.metricKey,req.asOfUtc]});
    if(core.schemaVersion===32&&req.metricKey==='body_energy'&&directory.created)
      return {kind:'METRIC_FAMILIES',status:'INCOMPLETE',failure:null,
        units:[{kind:'FAMILY_DIRECTORY',status:'COMPLETE'}],committedUnits:1};
    const defaultKey=keys.lookup(['episode-family-v1',context.userId,phase4Metric(req.metricKey).domain,
      req.metricKey,INTELLIGENCE_VERSIONS.algorithm,req.metricKey,req.windowFamily]);
    const candidates=[{familyKey:defaultKey,windowFamily:req.windowFamily},
      ...directory.entries.filter(entry=>entry.family_key!==defaultKey)
        .sort((a,b)=>a.family_token.localeCompare(b.family_token)).map(entry=>({familyKey:entry.family_key,
          familyToken:entry.family_token}))];
    let firstFailure=directory.unknownEntries.length?Object.assign(new Error('PHASE4_FAMILY_DIRECTORY_LEGACY_UNKNOWN'),
      {code:'PHASE4_FAMILY_DIRECTORY_LEGACY_UNKNOWN'}):null;
    const units=[];
    for(const candidate of candidates)try {
      assertBudget();
      if(defaultReplay&&candidate.familyKey===defaultKey){
        units.push({kind:'EPISODE_FAMILY',familyKey:defaultKey,status:'COMPLETE',outcome:defaultReplay.outcome});continue;
      }
      if(core.schemaVersion===32&&req.metricKey==='body_energy'&&candidate.windowFamily&&!preparedDefault){
        const unit=await queue.withOwnership(context,lease,()=>stores.intelligence.metricPreparationUnit(context,
          {...req,windowFamily:candidate.windowFamily,refresh:true},'NEXT'),{assertBudget});
        if(unit?.created)return {kind:'METRIC_FAMILIES',status:'INCOMPLETE',failure:firstFailure,
          units:[...units,{kind:'METRIC_PREPARATION_UNIT',unit:unit.unit,status:'COMPLETE'}],committedUnits:1};
      }
      const performFamily=req=>performMetricFamily(context,req,candidate,defaultKey);
      const outcome=await queue.owned(context,lease,()=>preparedDefault&&req.metricKey==='body_energy'
        ?stores.intelligence.withCurrentBodyMetricObservation(context,req,lease.asOfUtc,performFamily):performFamily(req),
        {assertBudget,workKind:'stage6.family',workFacts:[req.metricKey,req.asOfUtc,candidate.familyKey]});
      units.push({kind:'EPISODE_FAMILY',familyKey:candidate.familyKey,status:'COMPLETE',outcome});
    } catch(error) {
        requireSettledOperation(error);
      if(error?.code==='PHASE4_DRAIN_DEADLINE_REACHED')throw error;
      units.push({kind:'EPISODE_FAMILY',familyKey:candidate.familyKey,status:'UNRESOLVED',code:error?.code??'UNKNOWN'});
      firstFailure??=error;
    }
    return {kind:'METRIC_FAMILIES',status:firstFailure?'UNRESOLVED':'COMPLETE',failure:firstFailure,units};
  }

  async function metric(context,req,history,{replayOnly=false,replayPrepared=null}={}) {
    const prepared=replayPrepared??await (replayOnly?stores.intelligence.replayExistingMetricPreparation(context,{...req,refresh:true}):core.schemaVersion===32&&req.metricKey==='body_energy'
      ?stores.intelligence.resumeMetricPreparation(context,{...req,refresh:true})
      :stores.intelligence.analyzeMetric(context,{...req,refresh:true}));
    if(!['LIMITED','AVAILABLE'].includes(prepared.quality.status)||prepared.quality.confidence<=0)
      return 'VALID_INSUFFICIENT_METRIC_QUALITY';
    const contract=phase4Metric(req.metricKey),baseIdentity={algorithmMajor:INTELLIGENCE_VERSIONS.algorithm,domain:contract.domain,
      metric:req.metricKey,subject:req.metricKey,windowFamily:req.windowFamily};
    const family=keys.lookup(['episode-family-v1',context.userId,baseIdentity.domain,baseIdentity.metric,
      baseIdentity.algorithmMajor,baseIdentity.subject,baseIdentity.windowFamily]);
    const rows=(await client.execute({sql:`SELECT episode_id,revision,direction,input_generation FROM observation_episodes
      WHERE user_id=? AND execution_mode='SHADOW' AND episode_family_key=?
        AND state IN ('OPEN','UPDATING','ESCALATED','EXPLAINED','STABILIZING') LIMIT 2`,args:[context.userId,family]})).rows;
    if(rows.length>1)fail('PHASE4_EPISODE_PREDECESSOR_AMBIGUOUS');
    let prior=rows[0],reversesEpisodeId=null;
    if(prior) {
      if(prior.input_generation===context.inputGeneration) {
        await stores.episodes.read(context,prior.episode_id);return 'CURRENT';
      }
      const refreshed=await stores.episodes.refresh(context,{episodeId:prior.episode_id,expectedRevision:prior.revision,
        identity:{...baseIdentity,direction:prior.direction},metricRefresh:true,evidenceItemId:prepared.item.row.evidence_item_id,semanticAt:req.asOfUtc});
      if(!['RESOLVED','EXPIRED'].includes(refreshed.row.state))return 'REFRESHED';
      if(refreshed.row.resolution_reason==='DIRECTION_REVERSAL')reversesEpisodeId=prior.episode_id;
      else if(refreshed.row.state==='RESOLVED')return 'RESOLVED';
    }
    if(!prepared.calculation.qualified||!prepared.calculation.direction)return 'VALID_NO_EPISODE';
    const manifest=JSON.parse(prepared.run.row.input_manifest_json),confidence=JSON.parse(prepared.item.row.provenance_json).confidence;
    const data=canonicalEpisodeData(context,{current:manifest.current,calculation:prepared.calculation,asOfUtc:req.asOfUtc,confidence});
    if(data.expires_at<=req.asOfUtc)return 'VALID_EXPIRED_EVIDENCE';
    // Candidate discovery uses authenticated snapshots, including terminal
    // custom window families. Public open independently revalidates authority.
    const resolvedCandidates=!reversesEpisodeId?[...history.latest.values()].filter(({row,snapshot})=>
      row.fingerprint===keys.lookup(['episode-fingerprint-v1',family,prepared.calculation.direction])&&row.state==='RESOLVED'
      &&snapshot.semantic_at<=req.asOfUtc&&Date.parse(req.asOfUtc)-Date.parse(snapshot.semantic_at)<=7*86400000)
      .sort((a,b)=>b.snapshot.semantic_at.localeCompare(a.snapshot.semantic_at)):[];
    if(resolvedCandidates.length>1&&resolvedCandidates[0].snapshot.semantic_at===resolvedCandidates[1].snapshot.semantic_at)
      fail('PHASE4_EPISODE_PREDECESSOR_AMBIGUOUS');
    const resolved=resolvedCandidates[0]?.row;
    await stores.episodes.open(context,{identity:{...baseIdentity,direction:prepared.calculation.direction},data,
      evidenceItemId:prepared.item.row.evidence_item_id,semanticAt:req.asOfUtc,reversesEpisodeId,reopensEpisodeId:resolved?.episode_id??null,
      ...(resolved&&resolved.input_generation<context.inputGeneration?{recurrence:true,predecessorRevision:resolved.revision}:{}),
      semanticEvent:{eventKind:'OPENED',severityOrdinal:prepared.calculation.severity,claimKey:`metric:${req.metricKey}`,
        semanticContentHash:prepared.calculation.semanticHash}});
    return 'CREATED';
  }
  const insightIdentity=(factor,outcome,direction)=>({subject:`journal:${factor}`,outcome,direction,
    exposureCategory:factor,algorithmFamily:'journal-association',evidenceContractMajor:'1'});
  async function activeInsight(context,identity) {
    const rows=(await client.execute({sql:`SELECT id,current_revision,status,input_generation,expires_at FROM health_insights
      WHERE user_id=? AND execution_mode='SHADOW' AND insight_key=? AND status<>'RETIRED' LIMIT 2`,
      args:[context.userId,insightIdentityKey(keys,context,identity)]})).rows;
    if(rows.length>1)fail('PHASE4_INSIGHT_PREDECESSOR_AMBIGUOUS');return rows[0]??null;
  }
  async function associations(context,metricKey,asOfUtc) {
    const requests=[];for(let window=0;window<2;window++) {
      const request=await inputs.associations(context,metricKey,asOfUtc,window);
      if(request) {
        // The frozen association request's authenticated roots are WHOOP
        // outcomes and Journal facts/coverage. Episode-family state is not a
        // prerequisite. Public insight refresh still authenticates its own
        // historical evidence and predecessor closure below.
        const expected=phase4Metric(metricKey).sourceType;
        for(const hypothesis of request.hypotheses)for(const [refs,kind] of [
          [hypothesis.outcomeSources,expected],[hypothesis.journalFactSources,'JOURNAL_FACT'],
          [hypothesis.coverageSources,'JOURNAL_COVERAGE']])
          if(core.validateReferences(context,refs).some(source=>source.type!==kind))
            fail('PHASE4_ASSOCIATION_DEPENDENCY_SCOPE_INVALID');
        requests.push(request);
      }
    }
    if(!requests.length)return 'VALID_NO_JOURNAL_INPUTS';
    const results=[];for(const request of requests)results.push(await stores.intelligence.analyzeAssociationFamily(context,
      {...request,lifecycleMode:'EVIDENCE_ONLY'}));
    // Evidence calculations and their multiplicity families remain canonical.
    // The public lifecycle operation enforces promotion/replication thresholds.
    const candidates=new Map();
    for(let i=0;i<results.length;i++)for(const output of results[i].items) {
      const manifest=JSON.parse(results[i].runs.find(run=>run.row.run_id===output.item.row.run_id).row.input_manifest_json);
      const h=manifest.hypotheses.find(h=>`${h.factor}:${h.outcome_metric}:lag-${h.lag_days}`===manifest.focus_key);
      if(!output.analysis.candidate||!output.analysis.direction)continue;
      const identity=insightIdentity(h.factor,metricKey,output.analysis.direction),key=insightIdentityKey(keys,context,identity);
      let group=candidates.get(key);if(!group)candidates.set(key,group={identity,hypothesis:{factor:h.factor,outcomeMetric:metricKey},items:[]});
      group.items.push(output);
    }
    for(const {identity,hypothesis,items} of candidates.values()) {
      let existing=await activeInsight(context,identity);
      if(existing&&Date.parse(existing.expires_at)<=Date.parse(asOfUtc)) {
        const disposition=existing.status==='HYPOTHESIS'?'REJECTED':'EXPIRED';
        await stores.insights.transition(context,{insightId:existing.id,expectedRevision:existing.current_revision,
          ...(existing.input_generation<context.inputGeneration?{identity,refresh:true}:{}),status:'RETIRED',disposition,
          claim:canonicalAssociationClaim(hypothesis,identity.direction,'HYPOTHESIS'),
          supportingEvidenceIds:[items[0].item.row.evidence_item_id],reason:disposition,semanticAt:asOfUtc});
        existing=null;
      }
      if(existing?.input_generation===context.inputGeneration) {
        await stores.insights.read(context,existing.id,{asOfUtc});continue;
      }
      const ready=items.filter(item=>item.analysis.repeated&&JSON.parse(item.item.row.provenance_json).confidence.score>=.5);
      if(ready.length) {
        const opposite={...identity,direction:identity.direction==='LOWER'?'HIGHER':'LOWER'};
        const contradicted=await activeInsight(context,opposite);
        if(contradicted&&Date.parse(contradicted.expires_at)>Date.parse(asOfUtc)) {
          const terminal=['WEAKENED','HYPOTHESIS'].includes(contradicted.status);
          await stores.insights.transition(context,{insightId:contradicted.id,expectedRevision:contradicted.current_revision,
            ...(contradicted.input_generation<context.inputGeneration?{identity:opposite,refresh:true}:{}),
            status:terminal?'RETIRED':'WEAKENED',...(terminal?{disposition:'REFUTED'}:{}),
            claim:canonicalAssociationClaim(hypothesis,opposite.direction,'HYPOTHESIS'),supportingEvidenceIds:[],
            contradictingEvidenceIds:[ready[0].item.row.evidence_item_id],reason:terminal?'REFUTED':'CONTRADICTORY_EVIDENCE',semanticAt:asOfUtc});
        }
      }
      const supporting=items.map(item=>item.item.row.evidence_item_id);
      if(existing) {
        const status=['HYPOTHESIS','WEAKENED'].includes(existing.status)&&ready.length?'EMERGING':existing.status;
        await stores.insights.transition(context,{insightId:existing.id,expectedRevision:existing.current_revision,identity,refresh:true,status,
          claim:canonicalAssociationClaim(hypothesis,identity.direction,status),supportingEvidenceIds:supporting,
          // Refresh replaces the generation's evidence. It is not an
          // incremental claim of a third replication over old support.
          reason:'REPEATED_EVIDENCE',semanticAt:asOfUtc});
      } else {
        // Public lifecycle APIs own predecessor discovery, promotion guards,
        // complete projections and receipts. Do not run auto-lifecycle a
        // second time over the contradiction just processed above.
        let current=await stores.insights.create(context,{identity,
          claim:canonicalAssociationClaim(hypothesis,identity.direction,'HYPOTHESIS'),
          evidenceContractVersion:INTELLIGENCE_VERSIONS.evidenceContract,supportingEvidenceIds:[items[0].item.row.evidence_item_id],
          creationKey:keys.lookup(['stage6-insight-incarnation-v1',context.userId,insightIdentityKey(keys,context,identity),items[0].item.row.evidence_item_id]),
          semanticAt:asOfUtc,expiresAt:new Date(Date.parse(asOfUtc)+phase4Metric(metricKey).evidenceExpiryMs).toISOString()});
        if(ready.length)current=await stores.insights.transition(context,{insightId:current.row.id,expectedRevision:current.row.current_revision,
          status:'EMERGING',claim:canonicalAssociationClaim(hypothesis,identity.direction,'EMERGING'),supportingEvidenceIds:supporting,
          reason:'REPEATED_EVIDENCE',semanticAt:asOfUtc});
        if(ready.filter(item=>item.analysis.insightSupporting).length>=2)
          await stores.insights.transition(context,{insightId:current.row.id,expectedRevision:current.row.current_revision,
            status:'SUPPORTED',claim:canonicalAssociationClaim(hypothesis,identity.direction,'SUPPORTED'),supportingEvidenceIds:supporting,
            reason:'REPLICATED_SUPPORT',semanticAt:asOfUtc});
      }
    }
    return candidates.size?'PROCESSED':'VALID_NO_INSIGHT';
  }
  async function processSource(context,source,asOfUtc) {
    const root=await stores.root(context,source.source_type,source.source_id);
    if(source.source_type==='USER') {
      const body=await stores.bodyEnergy.compute(context,{asOfEpochMs:Date.parse(asOfUtc)});
      if(['AVAILABLE','LIMITED'].includes(body.row.quality_state)) {
        const current=await stores.readArtifact(context,'body_energy_results',{result_id:body.row.result_id});
        await metrics(context,await inputs.metric(context,'body_energy',current,await bodyEnergyMetricAnalysisTime(core,context,current,asOfUtc)));
      }
      return body.row.quality_state;
    }
    const registeredMetrics=Object.entries(PHASE4_METRICS).filter(([,definition])=>definition.sourceType===source.source_type);
    if(!registeredMetrics.length)return 'RETAINED_CANONICAL_INPUT';
    if(!inputs.eligible(source.source_type,root.row))return 'VALID_UNSCORED_INPUT';
    const latest=await inputs.latest(context,source.source_type),idKey=source.source_type==='recovery'?'sleep_id':'id';
    if(!latest||String(latest[idKey])!==source.source_id)return 'RETAINED_NON_TARGET_INPUT';
    for(const [metricKey] of registeredMetrics) {
      await metrics(context,await inputs.metric(context,metricKey,root,asOfUtc));
      await associations(context,metricKey,asOfUtc);
    }
    return 'PROCESSED';
  }
  async function processSourceV30(context,source,asOfUtc,lease,assertBudget,admittedRoot=null,bodyCandidate=false,bodyReplayHint=false) {
    const root=admittedRoot??await core.run(context,()=>stores.root(context,source.source_type,source.source_id));
    if(source.source_type==='USER') {
      if(core.schemaVersion===32&&bodyReplayHint){
        const defaultKey=keys.lookup(['episode-family-v1',context.userId,phase4Metric('body_energy').domain,
          'body_energy',INTELLIGENCE_VERSIONS.algorithm,'body_energy','STAGE6_CURRENT_BODY_ENERGY']);
        const replay=await queue.withOwnership(context,lease,()=>stores.intelligence.replayCurrentBodyMetricFamily(context,asOfUtc,
          req=>workStepOptions('stage6.family',[context.userId,context.executionMode,lease.binding.jobKind,
            lease.binding.requestedGeneration,lease.binding.scopeRevision,[req.metricKey,req.asOfUtc,defaultKey]],{discardResult:true}).workStep,
          (req,{replaying=false}={})=>performMetricFamily(context,req,{familyKey:defaultKey,windowFamily:req.windowFamily},defaultKey,{replayOnly:true,readOnlyReplay:replaying})),{assertBudget});
        if(replay)return metricsV30(context,replay.request,lease,assertBudget,{preparedDefault:true,defaultReplay:replay});
      }
      if(core.schemaVersion===32&&bodyCandidate){
        const unit=await queue.withOwnership(context,lease,()=>stores.intelligence.metricPreparationUnitFromCurrentBody(context,asOfUtc),{assertBudget});
        if(unit.created)return {kind:'METRIC_FAMILIES',status:'INCOMPLETE',failure:null,
          units:[{kind:'METRIC_PREPARATION_UNIT',unit:unit.unit,status:'COMPLETE'}],committedUnits:1};
        if(unit.prepared){
          const domain=await queue.withOwnership(context,lease,()=>stores.intelligence.completeMetricPreparationDomain(context,unit.request),{assertBudget});
          assertBudget();
          if(domain.created)return {kind:'METRIC_FAMILIES',status:'INCOMPLETE',failure:null,
            units:[{kind:'METRIC_DOMAIN',status:'COMPLETE'}],committedUnits:1};
          return metricsV30(context,unit.request,lease,assertBudget,{preparedDefault:true});
        }
      }
      const metricRequest=async body=>{
        const current=await stores.readArtifact(context,'body_energy_results',{result_id:body.row.result_id});assertBudget();
        const analysisTime=await bodyEnergyMetricAnalysisTime(core,context,current,body.row.as_of_utc);assertBudget();
        return inputs.metric(context,'body_energy',current,analysisTime);
      };
      const prior=core.schemaVersion===32&&bodyCandidate?await queue.owned(context,lease,async()=>{
        const retained=await stores.bodyEnergy.readForCurrentDrain(context,asOfUtc);if(!retained)return null;
        assertBudget();return {body:retained.body,...(['AVAILABLE','LIMITED'].includes(retained.body.row.quality_state)
          ?{request:await inputs.metric(context,'body_energy',retained.current,retained.analysisTime)}:{})};
      },{assertBudget}):null;
      const recorded=prior??await queue.owned(context,lease,async()=>{
        const body=await (core.schemaVersion===32?stores.bodyEnergy.computeForCurrentDrain(context)
          :stores.bodyEnergy.compute(context,{asOfEpochMs:Date.parse(asOfUtc)}));
        // Replayed Body and its required metric inputs use the same current
        // owned transaction. Every original typed artifact/domain/root check
        // still runs; deterministic read transport can reuse that snapshot.
        // A newly produced Body commits at its original source boundary first.
        return {body,...(!body.created&&['AVAILABLE','LIMITED'].includes(body.row.quality_state)?{request:await metricRequest(body)}:{})};
      },
        {assertBudget,workKind:'stage6.body-source',workFacts:[source.source_type,source.source_id,source.cursor,asOfUtc]});
      const {body}=recorded;
      // The original Body/domain/work receipts have committed together. A
      // budget yield here retains that replayable subunit, without advancing
      // the USER cursor or claiming its required metric families completed.
      assertBudget();
      if(['AVAILABLE','LIMITED'].includes(body.row.quality_state)) {
        // These required read-only observations still belong to the same job.
        // Its existing deadline/context fence applies throughout the nested
        // artifact/source checks, including when the Body subunit just used
        // the remaining productive wall time.
        const request=recorded.request??await queue.owned(context,lease,()=>metricRequest(body),{assertBudget});
        assertBudget();
        return await metricsV30(context,request,lease,assertBudget);
      }
      return {kind:'SOURCE',status:'COMPLETE',failure:null,units:[]};
    }
    const registeredMetrics=Object.entries(PHASE4_METRICS).filter(([,definition])=>definition.sourceType===source.source_type);
    if(!registeredMetrics.length||!inputs.eligible(source.source_type,root.row))
      return {kind:'SOURCE',status:'COMPLETE',failure:null,units:[]};
    const latest=await core.run(context,()=>inputs.latest(context,source.source_type)),
      idKey=source.source_type==='recovery'?'sleep_id':'id';
    if(!latest||String(latest[idKey])!==source.source_id)
      return {kind:'SOURCE',status:'COMPLETE',failure:null,units:[]};
    let firstFailure=null;const units=[];
    for(const [metricKey] of registeredMetrics) {
      let analysisAsOf=asOfUtc;
      try {
        if(core.schemaVersion===32)analysisAsOf=await core.run(context,()=>stage6CurrentCaptureTime(core,context,metricKey,root));
        const request=await core.run(context,()=>inputs.metric(context,metricKey,root,analysisAsOf));
        units.push({kind:'METRIC_SOURCE',metricKey,status:'COMPLETE'});
        const episodeWork=await metricsV30(context,request,lease,assertBudget);
        units.push(episodeWork);
        firstFailure??=episodeWork.failure;
      } catch(error) {
        requireSettledOperation(error);
        if(error?.code==='PHASE4_DRAIN_DEADLINE_REACHED')throw error;
        units.push({kind:'METRIC_SOURCE',metricKey,status:'UNRESOLVED',code:error?.code??'UNKNOWN'});
        firstFailure??=error;
      }
      // The association request and public insight operation prove their own
      // source/evidence/predecessor closure. A failed sibling episode family
      // remains unresolved but cannot veto an independent insight unit.
      try {
        const outcome=await queue.owned(context,lease,()=>associations(context,metricKey,analysisAsOf),{assertBudget,workKind:'stage6.associations',workFacts:[source.source_type,source.source_id,source.cursor,metricKey,analysisAsOf]});
        units.push({kind:'ASSOCIATION_INSIGHT',metricKey,status:'COMPLETE',outcome});
      }
      catch(error) {
        requireSettledOperation(error);
        if(error?.code==='PHASE4_DRAIN_DEADLINE_REACHED')throw error;
        units.push({kind:'ASSOCIATION_INSIGHT',metricKey,status:'UNRESOLVED',code:error?.code??'UNKNOWN'});
        firstFailure??=error;
      }
    }
    return {kind:'SOURCE',status:firstFailure?'UNRESOLVED':'COMPLETE',failure:firstFailure,units};
  }
  async function drain({triggerSource='manual',userId=null,budget:overrides={},onProgress=async()=>{}}={}) {
    if(db.raw.protocol!=='file'){requireBetaPilotGrant(pilotGrant,userId,db.raw);if(requireCurrentBetaPilotAttempt(userId,db.raw)!==pilotGrant)fail('BETA_PILOT_DENIED');}
    requireTriggerSource(triggerSource);const budget=stage6Budget(triggerSource,overrides),started=monotonicNow();
    const deadline=started+budget.maxWallMs-budget.safetyMarginMs;
    const assertBudget=()=>{if(monotonicNow()>=deadline)fail('PHASE4_DRAIN_DEADLINE_REACHED');};
    const out={triggerSource,attemptedJobs:0,claimedJobs:0,itemsAttempted:0,processedItems:0,completedJobs:0,failedJobs:0,failures:[],stoppedForBudget:false,unitsCommitted:0};
    log.info('stage6_discovery_start',{source:triggerSource});
    await onProgress({event:'discovery_start'});
    const selected=await queue.select({limit:budget.maxJobs,userId});
    out.jobsConsidered=selected.length;
    log.info('stage6_discovery_complete',{source:triggerSource,jobs_considered:selected.length,duration_ms:monotonicNow()-started});
    await onProgress({event:'discovery_complete',jobsConsidered:selected.length});
    log.info('stage6_drain_start',{source:triggerSource,jobs_considered:selected.length});
    await onProgress({event:'drain_start',jobsConsidered:selected.length});
    for(const candidate of selected) {
      if(monotonicNow()>=deadline||out.processedItems>=budget.maxItems){out.stoppedForBudget=true;break;}
      out.attemptedJobs++;
      try {
        await stores.withContext(candidate.userId,{executionMode:'SHADOW'},async context=>{
          const lease=await queue.claim(context,candidate.jobKind,budget);if(!lease)return;
          out.claimedJobs++;let cursor=lease.cursor,handled=0;
          try {
            while(handled<budget.maxItemsPerTenant&&out.processedItems<budget.maxItems) {
              assertBudget();
              // A page and its first raw root are read-only observations in
              // the same owned Core transaction. Every original root/context
              // guard still runs; later producer units independently recheck
              // their source references and current context before any write.
              const lookedUp=await core.run(context,async()=>{
                const page=await inputs.enumerate(context,cursor,1);
                const root=familyDirectory&&page.length?await stores.root(context,page[0].source_type,page[0].source_id):null;
                const receiptHintFrom=core.schemaVersion===32&&page[0]?.source_type==='USER'
                  ?await pilotPrefixFrom(client,context,'phase4_operation_receipts',[context.userId,context.executionMode],'p',true):null;
                const bodyHints=core.schemaVersion===32&&page[0]?.source_type==='USER'
                  ?(await client.execute({sql:`SELECT result_id,EXISTS(SELECT 1 FROM ${receiptHintFrom}
                    WHERE p.user_id=b.user_id AND p.execution_mode=b.execution_mode AND p.input_generation=b.input_generation
                      AND p.operation_kind='analyzeMetric' LIMIT 1) replay_hint
                    FROM body_energy_results b WHERE user_id=? AND execution_mode=?
                      AND input_generation=? AND invalidated_at IS NULL LIMIT 1`,args:[context.userId,context.executionMode,context.inputGeneration]})).rows[0]:null;
                return {page,root,bodyCandidate:Boolean(bodyHints),bodyReplayHint:Boolean(bodyHints?.replay_hint)};
              }),page=lookedUp.page;
              if(!page.length) {
                const proof=await queue.end(context,lease,(last,limit)=>inputs.enumerate(context,last,limit),{assertBudget});
                await queue.complete(context,lease,proof,{assertBudget});out.completedJobs++;return;
              }
              const source=page[0];out.itemsAttempted++;
              if(familyDirectory) {
                const outcome=await processSourceV30(context,source,lease.asOfUtc,lease,assertBudget,lookedUp.root,lookedUp.bodyCandidate,lookedUp.bodyReplayHint);
                out.unitsCommitted+=outcome.committedUnits??0;
                if(outcome.failure)throw outcome.failure;
                if(outcome.status==='INCOMPLETE'){
                  // Only the actual named unit committed. Its original source
                  // cursor/family/generation stay pending for a fresh owner.
                  await queue.release(context,lease);return;
                }
                await queue.owned(context,lease,()=>queue.checkpoint(context,lease,source.cursor),{assertBudget,workKind:'stage6.checkpoint',workFacts:[source.cursor]});
              } else await queue.owned(context,lease,async()=>{
                await processSource(context,source,lease.asOfUtc);
                await queue.checkpoint(context,lease,source.cursor);
              },{assertBudget,workKind:'stage6.source',workFacts:[source.source_type,source.source_id,source.cursor,lease.asOfUtc]});
              cursor=source.cursor;handled++;out.processedItems++;
            }
            await queue.release(context,lease);
          } catch(error) {
        requireSettledOperation(error);
            const deadlineReached=error?.code==='PHASE4_DRAIN_DEADLINE_REACHED';
            if(deadlineReached)out.stoppedForBudget=true;
            else {out.failedJobs++;out.failures.push({userId:candidate.userId,jobKind:candidate.jobKind,code:stage6ErrorCode(error)});}
            try {await queue.release(context,lease,{errorCode:deadlineReached?null:stage6ErrorCode(error)});}
            catch(fenceError) {
              requireSettledOperation(fenceError);
              // Supersession/takeover owns the durable row. Never overwrite it
              // just to record an old owner's failure or clear its lease.
              if(!['PHASE4_LEASE_CAS_LOST','PHASE4_INPUT_FENCED','PHASE4_AUTH_FENCED','PHASE4_LIFECYCLE_FENCED',
                'PHASE4_PURGE_FENCED','PHASE4_TIMEZONE_FENCED'].includes(fenceError?.code))throw fenceError;
            }
          } finally {await queue.abandon(lease);}
        });
      } catch(error) {
        requireSettledOperation(error);
        if(!out.failures.some(failure=>failure.userId===candidate.userId&&failure.jobKind===candidate.jobKind)) {
          out.failedJobs++;out.failures.push({userId:candidate.userId,jobKind:candidate.jobKind,code:stage6ErrorCode(error)});
        }
      }
    }
    const remaining=(await client.execute({sql:`SELECT COUNT(*) n FROM phase4_jobs j JOIN users u ON u.id=j.user_id
      JOIN phase4_user_state p ON p.user_id=j.user_id WHERE j.execution_mode='SHADOW' AND u.status='ACTIVE'
      AND p.pending_purge_count=0 AND (j.scope_kind<>'NONE' OR j.completed_generation<j.requested_generation)
      ${userId?'AND j.user_id=?':''}`,args:userId?[userId]:[]})).rows[0].n;
    out.remainingJobs=Number(remaining);
    out.outcome=out.failedJobs&&out.processedItems===0?'FAILED':out.remainingJobs===0&&!out.failedJobs?(out.claimedJobs?'COMPLETE':'NO_WORK')
      :out.processedItems||out.completedJobs||out.unitsCommitted?'PARTIAL':out.stoppedForBudget?'BUDGET_EXHAUSTED':'NO_ELIGIBLE_WORK';
    out.completion=out.remainingJobs===0&&!out.failedJobs?'COMPLETE':'PARTIAL';
    out.stopReason=out.failedJobs?'FAILURE':out.stoppedForBudget?'WALL_OR_ITEM_LIMIT':out.remainingJobs===0?'QUEUE_COMPLETE'
      :out.processedItems>=budget.maxItems?'ITEM_LIMIT':selected.length?'TENANT_LIMIT':'NO_ELIGIBLE_WORK';
    out.elapsedMs=monotonicNow()-started;
    log.info('stage6_worker_complete',{source:triggerSource,outcome:out.outcome,duration_ms:out.elapsedMs,
      jobs_considered:out.jobsConsidered,items_attempted:out.itemsAttempted,items_processed:out.processedItems,
      jobs_completed:out.completedJobs,remaining_jobs:out.remainingJobs});
    return Object.freeze(out);
  }
  async function rolloutAlgorithm({userId,algorithmSetVersion=STAGE6_ALGORITHM_SET}={}) {
    if(algorithmSetVersion!==STAGE6_ALGORITHM_SET)fail('PHASE4_ALGORITHM_UNSUPPORTED');
    return core.transaction(async()=>{
      const control=await core.captureControl(userId),state=await core.assertControl(control);
      const row=(await client.execute({sql:"SELECT * FROM phase4_computation_state WHERE user_id=? AND execution_mode='SHADOW'",args:[userId]})).rows[0];
      if(!row)fail('PHASE4_COMPUTATION_REQUIRED');
      if(row.algorithm_set_version===algorithmSetVersion)return {changed:false,inputGeneration:row.input_generation};
      if(state.pending_purge_count)fail('PHASE4_PURGE_FENCED');
      await client.execute({sql:`UPDATE phase4_computation_state SET algorithm_set_version=?,input_generation=input_generation+1,
        revision=revision+1,updated_at=? WHERE user_id=? AND execution_mode='SHADOW'`,args:[algorithmSetVersion,core.timestamp(),userId]});
      await createPhase4QueueStore(core).markFull(userId,'SHADOW',row.input_generation+1,state.purge_generation,'ALGORITHM_CHANGED');
      return {changed:true,inputGeneration:row.input_generation+1};
    });
  }
  return Object.freeze({drain,rolloutAlgorithm,diagnostics:()=>phase4Backlog(db,{now:now()})});
}
