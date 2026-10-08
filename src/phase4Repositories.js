import {workStepOptions} from './phase4WorkStep.js';
import { createLegacyDiscovery } from './phase4LegacyDiscovery.js';
import { createOperationReceipts } from './phase4OperationReceipts.js';
import { fail, requireInteger } from './phase4Core.js';
import { createPhase4QueueStore } from './phase4QueueStore.js';
import { createPhase4EntityStore } from './phase4EntityStore.js';
import { createPhase4PrivacyStore } from './phase4PrivacyStore.js';
import { createPhase4EpisodeStore } from './phase4EpisodeStore.js';
import { createPhase4MessageStore } from './phase4MessageStore.js';
import { createPhase4SlotStore } from './phase4SlotStore.js';
import { createPhase4ExperimentStore } from './phase4ExperimentStore.js';
import { createPhase4InsightStore, requireCurrentInsightAt } from './phase4InsightStore.js';
import { createPhase4TransportStore } from './phase4TransportStore.js';
import { createBodyEnergyStore } from './bodyEnergyStore.js';
import { createPhase4JournalStore } from './phase4JournalStore.js';
import { createPhase4JournalInbound } from './phase4JournalInbound.js';
import { createPhase4CoverageStore } from './phase4CoverageStore.js';
import { createPhase4JournalAnswers } from './phase4JournalAnswers.js';
import { createPhase4IntelligenceStore } from './phase4IntelligenceStore.js';
import { createResultAuthority } from './phase4ResultAuthority.js';
import { OPERATION_RECEIPT_TABLE } from './phase4V27Schema.js';
import { RESULT_AUTHORITY_TABLE } from './phase4V26Schema.js';
import { PHASE4_METRICS } from './phase4IntelligenceRegistry.js';

/** Composition is internal to the server factory and the synthetic fixture;
 * it does not issue execution contexts or accept request-owned authority. */
export function composePhase4Stores(core) {
  const {client,transaction,timestamp}=core;
  const receipts=createOperationReceipts(core),discover=createLegacyDiscovery(core);
  const contextScopes=new WeakSet();
  async function finishContext(context) {
    const cleanup=()=>transaction(()=>core.contextRegistry.release(context),{readOnly:true});
    if(core.processing.active()) {
      if(!core.processing.afterCompletion)fail('PHASE4_STRUCTURED_SCOPE_REQUIRED');
      core.processing.afterCompletion(cleanup);
    } else await cleanup();
  }
  const owned=fn=>async(context,request)=>{
    try{return await fn(context,request);}
    finally {
      if(!contextScopes.has(context))await finishContext(context);
    }
  };
  const recorded=(kind,fn)=>(context,request)=>receipts.execute(context,kind,request,semanticRequest=>fn(context,semanticRequest),{discover});
  const operation=(kind,fn)=>owned(recorded(kind,fn));
  const queue=createPhase4QueueStore(core);
  const entities=createPhase4EntityStore(core),privacy=createPhase4PrivacyStore(core,queue);
  const episodeStore=createPhase4EpisodeStore(core,entities,{metricRefreshPlan:receipts.metricRefreshPlan,
    episodeRecurrencePlan:receipts.episodeRecurrencePlan,operationAuthority:async(context,episodeId,revision)=>{
    const authority=await receipts.forArtifact(context,'observation_episodes',{}, {episodeId,revision,verifyOnly:true});
    return authority.operationKind.startsWith('EPISODE_');
  }}),insightStore=createPhase4InsightStore(core,entities,{terminalPredecessor:receipts.terminalInsightPredecessor});
  const episodes={...episodeStore,...Object.fromEntries(['open','revise','reverse','refresh']
    .map(name=>[name,recorded(`EPISODE_${name.toUpperCase()}`,episodeStore[name])])),
    semantic:(context,request)=>core.run(context,async()=>{
      const result=await episodeStore.semantic(context,request);
      return receipts.forArtifact(context,'episode_semantic_events',{episode_semantic_event_id:result.row.episode_semantic_event_id});
    })};
  const insights={...insightStore,read:(context,id,options)=>core.run(context,async()=>{
    const sealed=await receipts.resolveInsightLifecycle(context,{insightId:id});
    if(!options?.history)requireCurrentInsightAt(sealed.row,options?.asOfUtc);
    return sealed;
  }),create:recorded('INSIGHT_CREATE',insightStore.create),transition:recorded('INSIGHT_TRANSITION',insightStore.transition)};
  const intelligence=createPhase4IntelligenceStore(core,entities,episodes,insights,{producedEvidence:receipts.producedEvidence,
    discoverInsightPredecessor:receipts.discoverInsightPredecessor,resolveInsightLifecycle:receipts.resolveInsightLifecycle});
  const messages=createPhase4MessageStore(core,entities),slots=createPhase4SlotStore(core,entities,messages);
  const experiments=createPhase4ExperimentStore(core,privacy,queue);
  const journal=createPhase4JournalStore(core,privacy,queue),journalInbound=createPhase4JournalInbound(core,privacy,journal);
  const coverage=createPhase4CoverageStore(core,privacy);
  const journalAnswers=createPhase4JournalAnswers(core,journal,coverage,slots,journalInbound,queue);
  const body=createBodyEnergyStore(core,entities,queue);
  async function newBody(context,request,perform,{checkpoint=false}={}) {
    const table=checkpoint?'body_energy_checkpoints':'body_energy_results';
    const existing=(await client.execute({sql:`SELECT 1 FROM ${table} WHERE user_id=? AND execution_mode=? AND input_generation=?
      AND ${checkpoint?'checkpoint_bucket_start':'as_of_epoch_ms'}=? AND algorithm_version=?
      ${!checkpoint&&request.targetHealthDate!==null?'AND health_date=?':''} LIMIT 1`,args:[context.userId,context.executionMode,
        context.inputGeneration,checkpoint?request.bucketStart:request.asOfEpochMs,request.algorithmVersion,
        ...(!checkpoint&&request.targetHealthDate!==null?[request.targetHealthDate]:[])]})).rows.length;
    if(existing)fail('PHASE4_OPERATION_RESULT_UNAVAILABLE');
    return perform();
  }
  const bodyCompute=operation('BODY_ENERGY_COMPUTE',(context,request)=>newBody(context,request,()=>body.compute(context,request)));
  const bodyCheckpoint=operation('BODY_ENERGY_CHECKPOINT',(context,request)=>newBody(context,request,()=>body.checkpoint(context,request),{checkpoint:true}));
  async function initializeTenant(userId,mode) {
    return transaction(async()=>{
      const result=await core.initializeTenant(userId,mode);
      if(result.created && mode==='LIVE') {
        const state=await core.userState(userId);
        await queue.markFull(userId,mode,1,state.purge_generation,'ALGORITHM_CHANGED');
      }
      return result;
    },workStepOptions('tenant.initialize',[userId,mode],{discardResult:true}));
  }
  async function readArtifact(context,table,key) {
    if(table==='health_insights') {
      return receipts.resolveInsightLifecycle(context,{insightId:key.id});
    }
    if(['evidence_runs','evidence_items','health_insights','insight_revisions','episode_events','episode_semantic_events',
      'episode_evidence','episode_observations'].includes(table))return receipts.forArtifact(context,table,key);
    if(table==='observation_episodes') {
      const current=await core.artifact(context,table,key);
      await receipts.forArtifact(context,table,key,{episodeId:current.row.episode_id,revision:current.row.revision,verifyOnly:true});
      return episodes.readRevision(context,{episodeId:current.row.episode_id,revision:current.row.revision});
    }
    if(['body_energy_results','body_energy_checkpoints'].includes(table))return receipts.forArtifact(context,table,key);
    if(table===OPERATION_RECEIPT_TABLE)return core.run(context,async()=>{
      const artifact=await core.artifact(context,table,key);await receipts.read(context,artifact.row);return artifact;
    });
    if(table===RESULT_AUTHORITY_TABLE)return core.run(context,async()=>{
      const artifact=await core.artifact(context,table,key);
      await createResultAuthority(core).read(context,artifact.row.evidence_item_id,artifact.row.result_scope);
      await receipts.forArtifact(context,table,key,{verifyOnly:true});
      return artifact;
    });
    if(table!=='phase4_episode_revisions')return core.artifact(context,table,key);
    return core.run(context,async()=>{
      const artifact=await core.artifact(context,table,key);
      await receipts.forArtifact(context,'observation_episodes',{},
        {episodeId:artifact.row.episode_id,revision:artifact.row.revision,verifyOnly:true});
      await episodes.readRevision(context,{episodeId:artifact.row.episode_id,revision:artifact.row.revision});
      return artifact;
    });
  }
  async function preferences(control) {
    return transaction(async()=>{
      await core.assertControl(control);
      await client.execute({sql:`INSERT INTO user_notification_preferences(user_id,created_at,updated_at)
        VALUES (?,?,?) ON CONFLICT DO NOTHING`,args:[control.userId,timestamp(),timestamp()]});
      return {...(await client.execute({sql:'SELECT * FROM user_notification_preferences WHERE user_id=?',args:[control.userId]})).rows[0]};
    });
  }
  async function updatePreferences(control,expectedVersion,patch) {
    requireInteger(expectedVersion);
    const allowed=['notifications_paused','morning_brief_mode','morning_brief_local_time','after_wake_delay_minutes','fallback_local_time'];
    if(!patch || !Object.keys(patch).length || Object.keys(patch).some(k=>!allowed.includes(k)))fail('PHASE4_INVALID_PREFERENCE_PATCH');
    return transaction(async()=>{
      await core.assertControl(control);
      const current=await preferences(control);
      if(current.preference_version!==expectedVersion)fail('PHASE4_PREFERENCE_CAS_LOST');
      if(core.schemaVersion>=28&&Object.entries(patch).every(([key,value])=>current[key]===value))return current;
      const entries=Object.entries(patch);
      const result=await client.execute({sql:`UPDATE user_notification_preferences SET ${entries.map(([k])=>`${k}=?`).join(',')},
        preference_version=preference_version+1,updated_at=? WHERE user_id=? AND preference_version=?`,
      args:[...entries.map(([,v])=>v),timestamp(),control.userId,expectedVersion]});
      if(result.rowsAffected!==1)fail('PHASE4_PREFERENCE_CAS_LOST');
      if(patch.notifications_paused===1)await slots.pauseExisting(control);
      await core.assertControl(control);return preferences(control);
    });
  }
  /** Public beta inventory. Candidate IDs are discovered here, inside the
   * typed repository; every returned item then passes its canonical public
   * reader and the current context/receipt/provenance fences. */
  async function readBetaSummary(context,{asOfUtc}) {
    if(typeof asOfUtc!=='string'||!Number.isFinite(Date.parse(asOfUtc)))fail('PHASE4_BETA_TIME_REQUIRED');
    return core.run(context,async()=>{
      const {computation}=await core.assertContext(context);
      if(context.executionMode!=='SHADOW'||computation.last_completed_generation!==context.inputGeneration)
        return {userId:context.userId,executionMode:context.executionMode,episodes:[],insights:[]};
      // A facade retained across a controlled migration cannot keep the old
      // publication contract. Read the durable schema, never a captured version.
      const runtimeVersion=Number((await client.execute('SELECT MAX(version) AS v FROM schema_version')).rows[0].v);
      if(runtimeVersion>32)fail('phase4_schema_version_mismatch');
      if(runtimeVersion>=32){
        const producers=(await client.execute({sql:`SELECT p.*,e.state,e.phase,e.generation AS final_generation,e.execution_seq AS final_seq
          FROM phase4_execution_producers p JOIN phase4_executions e ON e.execution_id=p.producing_execution_id
          WHERE p.user_id=? AND p.execution_mode=? AND p.input_generation=? ORDER BY p.execution_seq DESC`,args:[context.userId,context.executionMode,context.inputGeneration]})).rows;
        if(!producers.length||producers.some(producer=>producer.state!=='FINALIZED_SUCCESS'||producer.phase!=='STAGE6_DRAIN'
          ||producer.execution_seq!==producer.final_seq||producer.producing_generation>producer.final_generation
          ||producer.tenant_proof!==core.keys.lookup(['execution-producer-v1',context.userId,context.executionMode,context.inputGeneration,
            producer.producing_execution_id,producer.execution_seq,producer.producing_generation])))
          return {userId:context.userId,executionMode:context.executionMode,episodes:[],insights:[]};
      }
      const scope=[context.userId,context.executionMode,context.inputGeneration,asOfUtc];
      const episodeIds=(await client.execute({sql:`SELECT episode_id FROM observation_episodes
        WHERE user_id=? AND execution_mode=? AND input_generation=?
          AND state IN ('OPEN','UPDATING','ESCALATED','EXPLAINED','STABILIZING')
          AND julianday(expires_at)>julianday(?) ORDER BY last_material_change_at DESC,episode_id LIMIT 10`,args:scope})).rows;
      const insightIds=(await client.execute({sql:`SELECT id FROM health_insights
        WHERE user_id=? AND execution_mode=? AND input_generation=?
          AND status IN ('EMERGING','SUPPORTED') AND julianday(expires_at)>julianday(?)
          AND legacy_classification='PHASE4' ORDER BY last_recalculated_at DESC,id LIMIT 10`,args:scope})).rows;
      const selected={userId:context.userId,executionMode:context.executionMode,episodes:[],insights:[]};
      for(const {episode_id:id} of episodeIds)try {
        const {row}=await readArtifact(context,'observation_episodes',{episode_id:id});
        if(row.state==='EXPIRED'||Date.parse(row.expires_at)<=Date.parse(asOfUtc)||row.subject_key==='body_energy'
          ||!Object.hasOwn(PHASE4_METRICS,row.subject_key)||row.input_generation!==context.inputGeneration)continue;
        selected.episodes.push({metricKey:row.subject_key,direction:row.direction,severity:row.severity,
          resultId:row.episode_id});
      } catch { /* One invalid item never authorizes a fallback. */ }
      for(const {id} of insightIds)try {
        const sealed=await insights.read(context,id,{asOfUtc});
        if(!['EMERGING','SUPPORTED'].includes(sealed.row.status))continue;
        const ids=JSON.parse(sealed.revision.supporting_evidence_ids_json??'null');
        if(!Array.isArray(ids)||!ids.length||ids.length>20)continue;
        const outcomes=[];
        for(const evidenceId of ids) {
          const item=await readArtifact(context,'evidence_items',{evidence_item_id:evidenceId});
          const provenance=JSON.parse(item.row.provenance_json??'null');
          if(provenance?.method!=='EXPOSED_VS_CONFIRMED_UNEXPOSED'
            ||!Object.hasOwn(PHASE4_METRICS,provenance.outcome_metric)
            ||provenance.outcome_metric==='body_energy'||item.row.causal_status!=='ASSOCIATION_ONLY')
            fail('PHASE4_BETA_INSIGHT_NOT_APPROVED');
          outcomes.push(provenance.outcome_metric);
        }
        if(new Set(outcomes).size!==1)continue;
        const claim=sealed.revision.normalized_claim;
        if(typeof claim!=='string'||!claim.trim()||claim.length>300)continue;
        selected.insights.push({status:sealed.row.status,claim:claim.trim(),resultId:sealed.row.id});
      } catch { /* Corrupt or unapproved association stays hidden. */ }
      await core.assertContext(context);
      return selected;
    });
  }
  return Object.freeze({initializeTenant,withContext:async(userId,options,work)=>{
      const context=await core.capture(userId,options);
      contextScopes.add(context);
      try{return await work(context);}finally{contextScopes.delete(context);await finishContext(context);}
    },capture:core.capture,captureControl:core.captureControl,capturePrivacyControl:core.capturePrivacyControl,
    assertCurrent:context=>core.assertContext(context),root:core.root,readArtifact,
    release:context=>transaction(()=>core.contextRegistry.release(context),{readOnly:true}),
    cache:Object.freeze({
      get:(context,key)=>core.run(context,()=>structuredClone(core.contextRegistry.get(context,key))),
      set:(context,key,value)=>core.run(context,()=>{core.contextRegistry.set(context,key,value);}),
    }),
    privacy:Object.freeze({admit:privacy.admit,redact:privacy.redact,complete:privacy.complete,status:privacy.status}),
    episodes:Object.freeze({...episodes,read:(context,id)=>readArtifact(context,'observation_episodes',{episode_id:id}),
      readRevision:(context,request)=>core.run(context,async()=>{
        await receipts.forArtifact(context,'observation_episodes',{},
          {episodeId:request.episodeId,revision:request.revision,verifyOnly:true});
        return episodes.readRevision(context,request);
      }),...Object.fromEntries(['open','revise','reverse','refresh','semantic']
      .map(name=>[name,owned(episodes[name])]))}),
    intelligence:Object.freeze(Object.fromEntries(Object.entries(intelligence).map(([name,fn])=>[name,operation(name,fn)]))),
    insights:Object.freeze({...insights,create:owned(insights.create),transition:owned(insights.transition)}),
    messages:Object.freeze({propose:messages.propose,readReservation:messages.readReservation,simulate:messages.simulate}),
    slots:Object.freeze(Object.fromEntries(Object.entries(slots).filter(([name])=>!['pauseExisting','transportStart','transportSettle','answer','resolveValidated'].includes(name)))),
    transport:Object.freeze(createPhase4TransportStore(core,entities,{start:slots.transportStart,settle:slots.transportSettle})),
    experiments:Object.freeze(experiments),
    bodyEnergy:Object.freeze({prepare:body.prepare,compute:bodyCompute,checkpoint:bodyCheckpoint,
      persist:(context,ticket)=>operation('BODY_ENERGY_COMPUTE',(context,request)=>newBody(context,request,()=>body.persist(context,ticket)))(context,body.describeTicket(context,ticket)),
      read:(context,id)=>readArtifact(context,'body_energy_results',{result_id:id}),
      audit:(context,id)=>core.run(context,async()=>{
        const result=await body.audit(context,id);
        await receipts.forArtifact(context,'body_energy_results',{result_id:id},{verifyOnly:true,retainedBody:true});return result;
      }),
      readExact:(context,request)=>core.run(context,async()=>{
        const result=await body.readExact(context,request);
        await receipts.forArtifact(context,'body_energy_results',{result_id:result.row.result_id},{verifyOnly:true,retainedBody:true});return result;
      }),
      readLatestCurrent:(context,request)=>core.run(context,async()=>{
        const result=await body.readLatestCurrent(context,request);
        if(!result)return null;
        await receipts.forArtifact(context,'body_energy_results',{result_id:result.row.result_id},{verifyOnly:true,retainedBody:true});
        return result;
      }),
      auditCheckpoint:(context,id)=>core.run(context,async()=>{
        const result=await body.auditCheckpoint(context,id);
        await receipts.forArtifact(context,'body_energy_checkpoints',{checkpoint_id:id},{verifyOnly:true,retainedBody:true});return result;
      }),
    }),
    journal:Object.freeze(Object.fromEntries(Object.entries(journal).filter(([name])=>!['prepareAnswer','forAnswer'].includes(name)))),
    journalInbound:Object.freeze({capture:journalInbound.capture,process:journalInbound.process,route:journalInbound.route}),
    journalCoverage:Object.freeze({read:coverage.read,correct:coverage.correct,remove:coverage.remove}),journalAnswers:Object.freeze(journalAnswers),
    betaSummary:Object.freeze({readCurrent:readBetaSummary}),
    decisions:Object.freeze({append:(context,data,refs)=>entities.append(context,'phase4_proactive_decisions',data,refs)}),
    evidence:Object.freeze({
      start:(context,data,refs)=>entities.append(context,'evidence_runs',{...data,state:'STARTED'},refs),
      complete:entities.completeEvidence,
      addItem:(context,data,refs)=>entities.append(context,'evidence_items',data,refs),
    }),
    queue:Object.freeze({sourceChanged:queue.sourceChanged,read:queue.read,claim:queue.claim,complete:queue.complete,fail:queue.fail}),
    preferences:Object.freeze({read:preferences,update:updatePreferences})});
}
