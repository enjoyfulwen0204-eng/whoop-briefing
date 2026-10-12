import {createPhase4Redactor} from './phase4Redaction.js';
import {fail} from './phase4Core.js';

/** Missing/declined responses are transport state, not Journal facts. Their
 * retraction uses the same physical redactor and dependency graph, atomically.
 * Accepted facts continue to use canonical Journal T0/T1/T2 and tombstones. */
export function createStage7InteractionPrivacy(core){
 const redactor=createPhase4Redactor(core),allowed=new Set(['quick_action_interactions','journal_prompt_deliveries','telegram_operations']);
 async function retract(control,row){
  return core.transaction(async()=>{
   const state=await core.assertControl(control);
   if(row.user_id!==control.userId||state.pending_purge_count!==0)fail('STAGE7_PRIVACY_FENCED');
   const queue=[{type:'quick_action_interactions',id:row.privacy_artifact_id,mode:'SHADOW'}],seen=new Set();
   while(queue.length){
    const node=queue.shift(),key=JSON.stringify(node);if(seen.has(key))continue;seen.add(key);
    if(seen.size>1000||!allowed.has(node.type))fail('STAGE7_COPY_POLICY_REQUIRED');
    const dependents=(await core.client.execute({sql:'SELECT artifact_type,artifact_id,artifact_execution_mode FROM phase4_source_links WHERE user_id=? AND source_type=? AND source_id=? AND source_execution_mode=? AND unlinked_at IS NULL',args:[control.userId,node.type,node.id,node.mode]})).rows;
    for(const d of dependents)queue.push({type:d.artifact_type,id:d.artifact_id,mode:d.artifact_execution_mode});
    const result=await redactor.apply(control.userId,node,{operation_kind:'DELETION',purge_generation:state.purge_generation,target_source_type:'INTERACTION',target_source_id:row.interaction_id});
    await core.client.execute({sql:'DELETE FROM phase4_source_links WHERE user_id=? AND ((artifact_type=? AND artifact_id=? AND artifact_execution_mode=?) OR (source_type=? AND source_id=? AND source_execution_mode=?))',args:[control.userId,node.type,node.id,node.mode,node.type,node.id,node.mode]});
    await redactor.verify(control.userId,node,result);
   }
   await core.assertControl(control);
  });
 }
 return {retract};
}
