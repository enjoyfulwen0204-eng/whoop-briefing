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

/** Composition is internal to the server factory and the synthetic fixture;
 * it does not issue execution contexts or accept request-owned authority. */
export function composePhase4Stores(core) {
  const {client,transaction,timestamp}=core;
  const receipts=createOperationReceipts(core),discover=createLegacyDiscovery(core);
  const contextScopes=new WeakSet();
  async function finishContext(context) {
    const cleanup=()=>transaction(()=>core.contextRegistry.release(context));
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
    });
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
  return Object.freeze({initializeTenant,withContext:async(userId,options,work)=>{
      const context=await core.capture(userId,options);
      contextScopes.add(context);
      try{return await work(context);}finally{contextScopes.delete(context);await finishContext(context);}
    },capture:core.capture,captureControl:core.captureControl,capturePrivacyControl:core.capturePrivacyControl,
    assertCurrent:context=>core.assertContext(context),root:core.root,readArtifact,
    release:context=>transaction(()=>core.contextRegistry.release(context)),
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
    decisions:Object.freeze({append:(context,data,refs)=>entities.append(context,'phase4_proactive_decisions',data,refs)}),
    evidence:Object.freeze({
      start:(context,data,refs)=>entities.append(context,'evidence_runs',{...data,state:'STARTED'},refs),
      complete:entities.completeEvidence,
      addItem:(context,data,refs)=>entities.append(context,'evidence_items',data,refs),
    }),
    queue:Object.freeze({sourceChanged:queue.sourceChanged,read:queue.read,claim:queue.claim,complete:queue.complete,fail:queue.fail}),
    preferences:Object.freeze({read:preferences,update:updatePreferences})});
}
