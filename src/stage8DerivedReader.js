import {requireRuntimeAdmission,followRuntimeRenewal} from './runtimeAdmission.js';
import {buildPhase4Core} from './phase4Core.js';
import {composePhase4Stores} from './phase4Repositories.js';
import {issueStage8LiveAuthority} from './stage8LiveAuthority.js';
export const STAGE8_DERIVED_CONTRACT=Object.freeze({version:'stage8-live-derived-reader-v1',mode:'LIVE',producerContract:'execution-producer-v1',kinds:Object.freeze(['BODY_ENERGY','INSIGHTS','EPISODES','EVIDENCE']),maxItems:10});
/** Completion metadata never substitutes for a finalized authenticated producer.
 * v34's frozen producer table is SHADOW-only. This boundary remains UPDATING
 * until a separately reviewed successor producer allocation can supply LIVE.
 * No caller/model can provide results, SQL, a producer receipt or a transport. */
export function createStage8DerivedReader({db,keys,admission,eligible,now=()=>new Date()}){
 if(requireRuntimeAdmission(db.raw,admission,keys,db.transaction)!==34||typeof eligible!=='function')throw Error('STAGE8_DERIVED_SERVER_REQUIRED');
 followRuntimeRenewal(db.raw,admission,keys,db.transaction,next=>{admission=next;});
 const updating=(scope,kind)=>({status:'ANALYSIS_UPDATING',kind,asOfUtc:scope.asOfUtc,items:[]});
 return async function read({scope,kind,inputGeneration}){
  if(!STAGE8_DERIVED_CONTRACT.kinds.includes(kind)||!scope?.permitted||scope.purpose!=='SELF_QA'||scope.executionMode!=='LIVE'||!eligible(scope.userId)||!Number.isSafeInteger(inputGeneration))throw Error('STAGE8_DERIVED_SCOPE_REQUIRED');
  return db.transaction(async()=>{
   requireRuntimeAdmission(db.raw,admission,keys,db.transaction);await db.assertRuntimeFences?.();
   const completion=(await db.raw.execute({sql:"SELECT c.* FROM phase4_computation_state c JOIN phase4_user_state p ON p.user_id=c.user_id WHERE c.user_id=? AND c.execution_mode='LIVE' AND c.input_generation=? AND c.last_completed_generation=c.input_generation AND c.source_generation_seen=p.source_generation AND p.pending_purge_count=0 AND NOT EXISTS(SELECT 1 FROM phase4_invalidations i WHERE i.user_id=c.user_id AND i.execution_mode='LIVE' AND i.scope_kind<>'NONE')",args:[scope.userId,inputGeneration]})).rows[0];
   if(!completion)return updating(scope,kind);
   const producers=(await db.raw.execute({sql:"SELECT p.*,e.state,e.phase,e.generation final_generation,e.execution_seq final_seq,e.finalized_at,e.deadline_at FROM phase4_execution_producers p JOIN phase4_executions e ON e.execution_id=p.producing_execution_id WHERE p.user_id=? AND p.execution_mode='LIVE' AND p.input_generation=? ORDER BY p.execution_seq LIMIT 129",args:[scope.userId,inputGeneration]})).rows;
   if(!producers.length||producers.length>128||producers.some(p=>p.state!=='FINALIZED_SUCCESS'||p.phase!=='STAGE6_DRAIN'||p.execution_seq!==p.final_seq||p.producing_generation>p.final_generation||!p.finalized_at||p.finalized_at>p.deadline_at||p.tenant_proof!==keys.lookup(['execution-producer-v1',scope.userId,'LIVE',inputGeneration,p.producing_execution_id,p.execution_seq,p.producing_generation])))return updating(scope,kind);
   const grant=issueStage8LiveAuthority({db,keys,admission,userIds:[scope.userId],enabled:()=>eligible(scope.userId)}),core=await buildPhase4Core({keys,admission,liveAuthority:grant,now,processing:{client:db.raw,transaction:db.transaction,active:db.processingTransactionActive,assertFences:db.assertRuntimeFences,afterCommit:db.afterProcessingCommit,afterCompletion:db.afterProcessingCompletion},authorizeMode(mode,client,uid){if(mode!=='LIVE'||client!==db.raw||uid!==scope.userId||!eligible(uid))throw Error('STAGE8_DERIVED_SCOPE_REQUIRED');}});
   const ctx=await core.capture(scope.userId,{executionMode:'LIVE',providerRequired:true});if(ctx.inputGeneration!==inputGeneration)throw Error('STAGE8_DERIVED_GENERATION_CHANGED');
   const stores=composePhase4Stores(core),items=[];
   if(kind==='INSIGHTS'){
    const ids=(await db.raw.execute({sql:"SELECT id FROM health_insights WHERE user_id=? AND execution_mode='LIVE' AND input_generation=? AND status='SUPPORTED' AND legacy_classification='PHASE4' AND expires_at>? ORDER BY last_recalculated_at DESC,id LIMIT 10",args:[scope.userId,inputGeneration,scope.asOfUtc]})).rows;
    for(const {id} of ids){const value=await stores.insights.read(ctx,id,{asOfUtc:scope.asOfUtc});items.push({claim:value.revision.normalized_claim,nonCausal:true});}
   }else{
    const spec={BODY_ENERGY:['body_energy_results','result_id','created_at'],EPISODES:['observation_episodes','episode_id','last_material_change_at'],EVIDENCE:['evidence_runs','run_id','created_at']}[kind];
    const ids=(await db.raw.execute({sql:`SELECT ${spec[1]} id FROM ${spec[0]} WHERE user_id=? AND execution_mode='LIVE' AND input_generation=? AND content_state='PRESENT' ORDER BY ${spec[2]} DESC,${spec[1]} LIMIT 10`,args:[scope.userId,inputGeneration]})).rows;
    for(const {id} of ids){const value=await stores.readArtifact(ctx,spec[0],{[spec[1]]:id});items.push({kind,id:keys.lookup(['stage8-derived-item-v1',scope.userId,kind,id]),value:value.row.value??null});}
   }
   await core.assertContext(ctx);if(!eligible(scope.userId))throw Error('STAGE8_DERIVED_SCOPE_REQUIRED');return {status:'CURRENT',kind,asOfUtc:scope.asOfUtc,items};
  });
 };
}
