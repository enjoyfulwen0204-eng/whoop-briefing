import {stage8BodyEnergyProjection} from './stage8BodyEnergyProjection.js';
import {verifyStage8LivePublication} from './stage8LivePublication.js';
import {requireRuntimeAdmission,followRuntimeRenewal} from './runtimeAdmission.js';
import {buildPhase4Core} from './phase4Core.js';
import {composePhase4Stores} from './phase4Repositories.js';
import {issueStage8LiveAuthority} from './stage8LiveAuthority.js';
import {PHASE4_METRICS} from './phase4IntelligenceRegistry.js';
export const STAGE8_DERIVED_CONTRACT=Object.freeze({version:'stage8-live-derived-reader-v1',mode:'LIVE',producerContract:'execution-producer-v1',kinds:Object.freeze(['BODY_ENERGY','INSIGHTS','EPISODES','EVIDENCE']),maxItems:10});
export const STAGE8_DERIVED_SELECTIONS=Object.freeze({
 BODY_ENERGY:Object.freeze({table:'body_energy_results',id:'result_id',time:'created_at',filter:"quality_state IN ('AVAILABLE','LIMITED') AND invalidated_at IS NULL AND as_of_utc<=?"}),
 EPISODES:Object.freeze({table:'observation_episodes',id:'episode_id',time:'last_material_change_at',filter:"state IN ('OPEN','UPDATING','ESCALATED','EXPLAINED','STABILIZING','RESOLVED') AND invalidated_at IS NULL AND expires_at>?"}),
 EVIDENCE:Object.freeze({table:'evidence_runs',id:'run_id',time:'started_at',filter:"state='COMPLETED' AND invalidated_at IS NULL AND completed_at<=?"}),
});
const json=value=>{try{return JSON.parse(value);}catch{return null;}};
const metric=key=>key!=='body_energy'&&Object.hasOwn(PHASE4_METRICS,key);
const count=value=>Number.isSafeInteger(value)&&value>=0;
const factors=new Set(['alcohol','caffeine','stress','late_meal','late_sleep','sickness','travel','exercise_note','sauna','supplement','medication','flight','location','massage','food','custom']);
const time=value=>typeof value==='string'&&Number.isFinite(Date.parse(value));
/** Pure bounded projection, used only after canonical artifact/receipt reads.
 * A completed calculation can legitimately contain insufficient evidence. */
export function stage8EvidenceProjection(run,item){
 const p=json(item.provenance_json),manifest=json(run.input_manifest_json);
 if(run.state!=='COMPLETED'||run.invalidated_at||item.invalidated_at||item.run_id!==run.run_id||item.causal_status!=='ASSOCIATION_ONLY'
  ||!time(run.as_of_utc)||!time(run.window_start_utc)||!time(run.window_end_utc)||!count(run.sample_count))return null;
 const common={method:run.method,asOfUtc:run.as_of_utc,period:{from:run.window_start_utc,to:run.window_end_utc},samples:run.sample_count,quality:item.quality,nonCausal:true};
 if(run.method==='PERSONAL_BASELINE_DEVIATION'&&p?.method==='CURRENT_VS_ROBUST_BASELINE'&&manifest?.manifest_version==='phase4-metric-evidence-input-v2'&&metric(manifest.metric_key)){
  const key=manifest.metric_key,baseline=manifest.baseline;
  if(item.claim_key!==`metric:${key}`||item.unit!==PHASE4_METRICS[key].unit)return null;
  const result={...common,metricKey:key,unit:item.unit,source:'WHOOP',outcome:'INSUFFICIENT_EVIDENCE'};
  if(Number.isFinite(p.current?.value)&&time(p.current?.observedAt))Object.assign(result,{current:p.current.value,observedAt:p.current.observedAt,healthDate:p.current.healthDate});
  if(['AVAILABLE','LIMITED'].includes(item.quality)&&run.sample_count>=PHASE4_METRICS[key].baselineMinimum
   &&[result.current,baseline?.median,baseline?.q1,baseline?.q3,item.effect].every(Number.isFinite))
   Object.assign(result,{outcome:'PERSONAL_BASELINE_COMPARISON',baseline:{median:baseline.median,q1:baseline.q1,q3:baseline.q3,lookbackDays:baseline.lookback_days},delta:item.effect});
  return result;
 }
 if(run.method==='JOURNAL_ASSOCIATION'&&p?.method==='EXPOSED_VS_CONFIRMED_UNEXPOSED'&&factors.has(p.factor)&&metric(p.outcome_metric)
  &&[item.exposed_count,item.confirmed_unexposed_count,item.unknown_count].every(count))return {...common,metricKey:p.outcome_metric,factor:p.factor,
   unit:item.unit,direction:item.direction,source:'WHOOP_AND_EXPLICIT_JOURNAL',outcome:p.readiness==='REPEATED'?'REPEATED_ASSOCIATION_EVIDENCE':'INSUFFICIENT_EVIDENCE',
   exposedCount:item.exposed_count,unexposedCount:item.confirmed_unexposed_count,unknownCount:item.unknown_count,
   ...(Number.isFinite(item.effect)?{effect:item.effect}:{})};
 return null;
}
export function stage8AssociationProjection(claim){
 const match=/^([a-z_]+) has been repeatedly associated in your data with (higher|lower) ([a-z_]+)\.$/.exec(claim??'');
 return match&&factors.has(match[1])&&metric(match[3])?{factor:match[1],direction:match[2].toUpperCase(),metricKey:match[3]}:null;
}
export function stage8DerivedSelection(kind,scope,inputGeneration){
 const spec=STAGE8_DERIVED_SELECTIONS[kind];if(!spec)throw Error('STAGE8_DERIVED_KIND_REQUIRED');
 return {sql:`SELECT ${spec.id} id FROM ${spec.table} WHERE user_id=? AND execution_mode='LIVE' AND input_generation=? AND content_state='PRESENT' AND ${spec.filter} ORDER BY ${spec.time} DESC,${spec.id} LIMIT 10`,args:[scope.userId,inputGeneration,scope.asOfUtc]};
}
export function stage8EvidenceItemSelection(scope,inputGeneration,runId){
 // Items inherit generation from their authenticated run; the item table has
 // no input_generation column in the authoritative v23-v35 contract.
 return {sql:"SELECT i.evidence_item_id FROM evidence_items i JOIN evidence_runs r ON r.user_id=i.user_id AND r.execution_mode=i.execution_mode AND r.run_id=i.run_id WHERE i.user_id=? AND i.execution_mode='LIVE' AND r.input_generation=? AND i.run_id=? AND i.content_state='PRESENT' AND i.invalidated_at IS NULL ORDER BY i.created_at DESC,i.evidence_item_id LIMIT 2",args:[scope.userId,inputGeneration,runId]};
}
/** Completion metadata never substitutes for a finalized authenticated producer.
 * v34's frozen producer table is SHADOW-only and remains UPDATING. v35 reads
 * require the genuine LIVE publication and canonical artifact authorities.
 * No caller/model can provide results, SQL, a producer receipt or a transport. */
export function createStage8DerivedReader({db,keys,admission,eligible,now=()=>new Date()}){
 if(![34,35].includes(requireRuntimeAdmission(db.raw,admission,keys,db.transaction))||typeof eligible!=='function')throw Error('STAGE8_DERIVED_SERVER_REQUIRED');
 followRuntimeRenewal(db.raw,admission,keys,db.transaction,next=>{admission=next;});
 const updating=(scope,kind)=>({status:'ANALYSIS_UPDATING',kind,asOfUtc:scope.asOfUtc,items:[]});
 return async function read({scope,kind,inputGeneration}){
  if(!STAGE8_DERIVED_CONTRACT.kinds.includes(kind)||!scope?.permitted||scope.purpose!=='SELF_QA'||scope.executionMode!=='LIVE'||!eligible(scope.userId)||!Number.isSafeInteger(inputGeneration))throw Error('STAGE8_DERIVED_SCOPE_REQUIRED');
  return db.transaction(async()=>{
   requireRuntimeAdmission(db.raw,admission,keys,db.transaction);await db.assertRuntimeFences?.();
   const completion=(await db.raw.execute({sql:"SELECT c.* FROM phase4_computation_state c JOIN phase4_user_state p ON p.user_id=c.user_id WHERE c.user_id=? AND c.execution_mode='LIVE' AND c.input_generation=? AND c.last_completed_generation=c.input_generation AND c.source_generation_seen=p.source_generation AND p.pending_purge_count=0 AND NOT EXISTS(SELECT 1 FROM phase4_invalidations i WHERE i.user_id=c.user_id AND i.execution_mode='LIVE' AND i.scope_kind<>'NONE')",args:[scope.userId,inputGeneration]})).rows[0];
   if(!completion)return updating(scope,kind);
   if(requireRuntimeAdmission(db.raw,admission,keys,db.transaction)!==35)return updating(scope,kind);
   const grant=issueStage8LiveAuthority({db,keys,admission,userIds:[scope.userId],enabled:()=>eligible(scope.userId)}),core=await buildPhase4Core({keys,admission,liveAuthority:grant,now,processing:{client:db.raw,transaction:db.transaction,active:db.processingTransactionActive,assertFences:db.assertRuntimeFences,afterCommit:db.afterProcessingCommit,afterCompletion:db.afterProcessingCompletion},authorizeMode(mode,client,uid){if(mode!=='LIVE'||client!==db.raw||uid!==scope.userId||!eligible(uid))throw Error('STAGE8_DERIVED_SCOPE_REQUIRED');}});
   const ctx=await core.capture(scope.userId,{executionMode:'LIVE',providerRequired:true});try{
   if(ctx.inputGeneration!==inputGeneration)throw Error('STAGE8_DERIVED_GENERATION_CHANGED');
   if(!await verifyStage8LivePublication(core,ctx))return updating(scope,kind);
   // Publication uses epoch milliseconds; artifact expiry uses ISO timestamps.
   const stores=composePhase4Stores(core),items=[],expires=[Number((await db.raw.execute({sql:'SELECT expires_at FROM stage8_live_publications WHERE user_id=? AND input_generation=?',args:[scope.userId,inputGeneration]})).rows[0]?.expires_at)],evidenceCache=new Map();
   const evidence=async id=>{
    if(evidenceCache.has(id))return evidenceCache.get(id);
    const item=(await stores.readArtifact(ctx,'evidence_items',{evidence_item_id:id})).row,
     run=(await stores.readArtifact(ctx,'evidence_runs',{run_id:item.run_id})).row;
    if(Date.parse(run.as_of_utc)>Date.parse(scope.asOfUtc)||Date.parse(run.completed_at)>Date.parse(scope.asOfUtc))return null;
    const value=stage8EvidenceProjection(run,item),projection=value?{...value,id:keys.lookup(['stage8-derived-item-v1',scope.userId,'EVIDENCE',id])}:null;evidenceCache.set(id,projection);return projection;
   };
   const history=async(table,idKey,id)=>{
    const isEpisode=table==='phase4_episode_revisions',at=isEpisode?'semantic_at':'created_at',rows=(await db.raw.execute({sql:`SELECT revision FROM ${table} WHERE user_id=? AND execution_mode='LIVE' AND input_generation=? AND ${idKey}=? AND content_state='PRESENT' AND ${at}<=? ORDER BY revision DESC LIMIT 5`,args:[scope.userId,inputGeneration,id,scope.asOfUtc]})).rows,values=[];
    for(const {revision} of rows){
     if(isEpisode){const value=await stores.episodes.readRevision(ctx,{episodeId:id,revision});values.push({revision,state:value.row.state,at:value.row.last_semantic_at??value.row.last_material_change_at});}
     else{const value=(await stores.readArtifact(ctx,table,{[idKey]:id,revision})).row;values.push({revision,status:value.status,at:value.created_at,...(value.status==='SUPPORTED'?stage8AssociationProjection(value.normalized_claim):{})});}
    }
    return values;
   };
   if(kind==='INSIGHTS'){
    const ids=(await db.raw.execute({sql:"SELECT id FROM health_insights WHERE user_id=? AND execution_mode='LIVE' AND input_generation=? AND status='SUPPORTED' AND legacy_classification='PHASE4' AND expires_at>? ORDER BY last_recalculated_at DESC,id LIMIT 10",args:[scope.userId,inputGeneration,scope.asOfUtc]})).rows;
    for(const {id} of ids){const value=await stores.insights.read(ctx,id,{asOfUtc:scope.asOfUtc}),association=stage8AssociationProjection(value?.revision?.normalized_claim),support=json(value?.revision?.supporting_evidence_ids_json);
     if(!association||value.row.status!=='SUPPORTED'||!Array.isArray(support)||!support.length||support.length>20)continue;
     const sources=[];for(const evidenceId of support){const item=await evidence(evidenceId);if(!item||item.outcome!=='REPEATED_ASSOCIATION_EVIDENCE'||item.factor!==association.factor||item.metricKey!==association.metricKey||item.direction!==association.direction)throw Error('STAGE8_INSIGHT_EVIDENCE_REQUIRED');if(sources.length<2)sources.push(item);}
     expires.push(Date.parse(value.row.expires_at));items.push({kind,id:keys.lookup(['stage8-derived-item-v1',scope.userId,kind,id]),claim:value.revision.normalized_claim,...association,nonCausal:true,evidence:sources,history:await history('insight_revisions','insight_id',id)});
    }
   }else{
    const spec=STAGE8_DERIVED_SELECTIONS[kind],ids=(await db.raw.execute(stage8DerivedSelection(kind,scope,inputGeneration))).rows;
    for(const {id} of ids){const value=await stores.readArtifact(ctx,spec.table,{[spec.id]:id});
     let projection;
     if(kind==='BODY_ENERGY')projection=stage8BodyEnergyProjection(value.row,Date.parse(scope.asOfUtc));
     else if(kind==='EPISODES'){
      const row=value.row;if(!metric(row.subject_key)||!['HIGHER','LOWER'].includes(row.direction))continue;
      const source=await evidence(row.latest_evidence_item_id);if(!source||source.metricKey!==row.subject_key||source.outcome!=='PERSONAL_BASELINE_COMPARISON')continue;
      expires.push(Date.parse(row.expires_at));projection={metricKey:row.subject_key,direction:row.direction,state:row.state,openedAt:row.opened_at,lastObservedAt:row.last_observed_at,resolvedAt:row.resolved_at,nonCausal:true,evidence:[source],history:await history('phase4_episode_revisions','episode_id',id)};
     }else{
      const evidenceIds=(await db.raw.execute(stage8EvidenceItemSelection(scope,inputGeneration,id))).rows,entries=[];
      for(const {evidence_item_id} of evidenceIds){const item=await evidence(evidence_item_id);if(item)entries.push(item);}projection=entries.length?{evidence:entries}:null;
     }
     if(projection)items.push({kind,id:keys.lookup(['stage8-derived-item-v1',scope.userId,kind,id]),...projection});
    }
   }
   await core.assertContext(ctx);if(!await verifyStage8LivePublication(core,ctx)||!expires.every(Number.isFinite)||Math.min(...expires)<=Date.parse(scope.asOfUtc))return updating(scope,kind);if(!eligible(scope.userId))throw Error('STAGE8_DERIVED_SCOPE_REQUIRED');return {status:'CURRENT',kind,asOfUtc:scope.asOfUtc,validUntil:Math.min(...expires),historyScope:'RETAINED_CURRENT_GENERATION_ONLY',items};
   }finally{db.afterProcessingCompletion(()=>core.transaction(()=>core.contextRegistry.release(ctx),{readOnly:true}));}
  });
 };
}
