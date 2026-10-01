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

const capabilities=new WeakSet();
// Both names resolve to the frozen Stage 5 registry. Adding a future
// calculation bundle requires a code-reviewed registry change, not a flag.
export const STAGE6_ALGORITHM_SET='phase4-stage5-canonical-v1';
/** Server composition only. A JSON request or an environment flag cannot
 * manufacture this capability. Production factories never call this issuer. */
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
  ['PHASE4_FAMILY_DIRECTORY_LEGACY_UNKNOWN','SOURCE_UNAVAILABLE'],
  ['PHASE4_FAMILY_DIRECTORY_DESCRIPTOR_UNAVAILABLE','SOURCE_UNAVAILABLE'],
  ['PHASE4_FAMILY_DIRECTORY_AUTHORITY_INVALID','INVARIANT_VIOLATION'],
  ['PHASE4_ASSOCIATION_DEPENDENCY_SCOPE_INVALID','INVARIANT_VIOLATION'],
]);
export const stage6ErrorCode=error=>errorCodes.get(error?.code)??'CALCULATION_FAILED';

export async function createPhase4Stage6({db,keys,executionMode,workerCapability,now=()=>new Date(),
  monotonicNow=()=>performance.now(),configuration={}}={}) {
  if(executionMode!=='SHADOW')fail('PHASE4_STAGE6_SHADOW_REQUIRED');
  if(!capabilities.has(workerCapability))fail('PHASE4_STAGE6_CAPABILITY_REQUIRED');
  foundationFlags(configuration);
  const core=await buildPhase4Core({processing:{client:db.raw,transaction:db.transaction,active:db.processingTransactionActive,
    afterCommit:db.afterProcessingCommit,afterCompletion:db.afterProcessingCompletion},keys,now,
    authorizeMode(mode){if(mode!=='SHADOW')fail('PHASE4_LIVE_NOT_AUTHORIZED');}});
  if(![28,29,30].includes(core.schemaVersion))fail('PHASE4_STAGE6_SCHEMA_REQUIRED');
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

  async function metricsV30(context,req,lease,assertBudget) {
    const directory=await queue.owned(context,lease,()=>familyDirectory.inventory(context,req.metricKey),{assertBudget});
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
      const outcome=await queue.owned(context,lease,async()=>{
        const current=await familyDirectory.inventory(context,req.metricKey),
          entry=current.entries.find(row=>row.family_key===candidate.familyKey);
        if(entry&&!(await familyDirectory.work(context,entry)).due)return 'ALREADY_COMPLETE';
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
        const result=await metric(context,{...req,windowFamily},precise);
        const settled=await familyDirectory.inventory(context,req.metricKey),
          owned=settled.entries.find(row=>row.family_key===candidate.familyKey);
        if(owned)await familyDirectory.complete(context,owned);
        return result;
      },{assertBudget});
      units.push({kind:'EPISODE_FAMILY',familyKey:candidate.familyKey,status:'COMPLETE',outcome});
    } catch(error) {
      if(error?.code==='PHASE4_DRAIN_DEADLINE_REACHED')throw error;
      units.push({kind:'EPISODE_FAMILY',familyKey:candidate.familyKey,status:'UNRESOLVED',code:error?.code??'UNKNOWN'});
      firstFailure??=error;
    }
    return {kind:'METRIC_FAMILIES',status:firstFailure?'UNRESOLVED':'COMPLETE',failure:firstFailure,units};
  }

  async function metric(context,req,history) {
    const prepared=await stores.intelligence.analyzeMetric(context,{...req,refresh:true});
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
        await metrics(context,await inputs.metric(context,'body_energy',current,asOfUtc));
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
  async function processSourceV30(context,source,asOfUtc,lease,assertBudget) {
    const root=await core.run(context,()=>stores.root(context,source.source_type,source.source_id));
    if(source.source_type==='USER') {
      const body=await queue.owned(context,lease,()=>stores.bodyEnergy.compute(context,{asOfEpochMs:Date.parse(asOfUtc)}),
        {assertBudget});
      if(['AVAILABLE','LIMITED'].includes(body.row.quality_state)) {
        const current=await core.run(context,()=>stores.readArtifact(context,'body_energy_results',{result_id:body.row.result_id}));
        const request=await core.run(context,()=>inputs.metric(context,'body_energy',current,asOfUtc));
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
      try {
        const request=await core.run(context,()=>inputs.metric(context,metricKey,root,asOfUtc));
        units.push({kind:'METRIC_SOURCE',metricKey,status:'COMPLETE'});
        const episodeWork=await metricsV30(context,request,lease,assertBudget);
        units.push(episodeWork);
        firstFailure??=episodeWork.failure;
      } catch(error) {
        if(error?.code==='PHASE4_DRAIN_DEADLINE_REACHED')throw error;
        units.push({kind:'METRIC_SOURCE',metricKey,status:'UNRESOLVED',code:error?.code??'UNKNOWN'});
        firstFailure??=error;
      }
      // The association request and public insight operation prove their own
      // source/evidence/predecessor closure. A failed sibling episode family
      // remains unresolved but cannot veto an independent insight unit.
      try {
        const outcome=await queue.owned(context,lease,()=>associations(context,metricKey,asOfUtc),{assertBudget});
        units.push({kind:'ASSOCIATION_INSIGHT',metricKey,status:'COMPLETE',outcome});
      }
      catch(error) {
        if(error?.code==='PHASE4_DRAIN_DEADLINE_REACHED')throw error;
        units.push({kind:'ASSOCIATION_INSIGHT',metricKey,status:'UNRESOLVED',code:error?.code??'UNKNOWN'});
        firstFailure??=error;
      }
    }
    return {kind:'SOURCE',status:firstFailure?'UNRESOLVED':'COMPLETE',failure:firstFailure,units};
  }
  async function drain({triggerSource='manual',userId=null,budget:overrides={}}={}) {
    requireTriggerSource(triggerSource);const budget=stage6Budget(triggerSource,overrides),started=monotonicNow();
    const deadline=started+budget.maxWallMs-budget.safetyMarginMs;
    const assertBudget=()=>{if(monotonicNow()>=deadline)fail('PHASE4_DRAIN_DEADLINE_REACHED');};
    const out={triggerSource,attemptedJobs:0,claimedJobs:0,processedItems:0,completedJobs:0,failedJobs:0,failures:[],stoppedForBudget:false};
    const selected=await queue.select({limit:budget.maxJobs,userId});
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
              const page=await core.run(context,()=>inputs.enumerate(context,cursor,1));
              if(!page.length) {
                const proof=await queue.end(context,lease,(last,limit)=>inputs.enumerate(context,last,limit),{assertBudget});
                await queue.complete(context,lease,proof,{assertBudget});out.completedJobs++;return;
              }
              const source=page[0];
              if(familyDirectory) {
                const outcome=await processSourceV30(context,source,lease.asOfUtc,lease,assertBudget);
                if(outcome.failure)throw outcome.failure;
                await queue.owned(context,lease,()=>queue.checkpoint(context,lease,source.cursor),{assertBudget});
              } else await queue.owned(context,lease,async()=>{
                await processSource(context,source,lease.asOfUtc);
                await queue.checkpoint(context,lease,source.cursor);
              },{assertBudget});
              cursor=source.cursor;handled++;out.processedItems++;
            }
            await queue.release(context,lease);
          } catch(error) {
            const deadlineReached=error?.code==='PHASE4_DRAIN_DEADLINE_REACHED';
            if(deadlineReached)out.stoppedForBudget=true;
            else {out.failedJobs++;out.failures.push({userId:candidate.userId,jobKind:candidate.jobKind,code:stage6ErrorCode(error)});}
            try {await queue.release(context,lease,{errorCode:deadlineReached?null:stage6ErrorCode(error)});}
            catch(fenceError) {
              // Supersession/takeover owns the durable row. Never overwrite it
              // just to record an old owner's failure or clear its lease.
              if(!['PHASE4_LEASE_CAS_LOST','PHASE4_INPUT_FENCED','PHASE4_AUTH_FENCED','PHASE4_LIFECYCLE_FENCED',
                'PHASE4_PURGE_FENCED','PHASE4_TIMEZONE_FENCED'].includes(fenceError?.code))throw fenceError;
            }
          } finally {await queue.abandon(lease);}
        });
      } catch(error) {
        if(!out.failures.some(failure=>failure.userId===candidate.userId&&failure.jobKind===candidate.jobKind)) {
          out.failedJobs++;out.failures.push({userId:candidate.userId,jobKind:candidate.jobKind,code:stage6ErrorCode(error)});
        }
      }
    }
    out.outcome=out.failedJobs&&out.failedJobs===out.attemptedJobs?'FAILED'
      :out.failedJobs?'PARTIAL':out.claimedJobs?'DRAINED':'NOTHING_DUE';
    out.elapsedMs=monotonicNow()-started;return Object.freeze(out);
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
