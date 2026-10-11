import {createExecutionBudget,withExecutionBudget} from './executionBudget.js';
import {requireRuntimeAdmission} from './runtimeAdmission.js';
import {databaseNowMs} from './phase4ExecutionContext.js';
import {canonicalPhaseRequest,reconcileExecution,requestIdentity,EXECUTION_WORK_MAX_AGE_MS,validatePhaseRequest} from './phase4ExecutionStore.js';
import {isContinuationRequest,isSyncContinuationRequest} from './phase4ExecutionStore.js';
import {scopeIncludesSync,scopeIncludesDrain,continuationScope} from './phase4ContinuationScope.js';
export const CONTINUATION_PATH='/internal/briefing/continuation';
const fail=code=>{throw Object.assign(Error(code),{code});};
export function validateContinuationQuery(query){
 if(!query||typeof query!=='object'||Array.isArray(query)||Object.keys(query).sort().join(',')!=='configProof,executionMode,releaseSha,scope,triggerSource'
  ||query.triggerSource!=='cloudflare'||!['OFF','SHADOW'].includes(query.executionMode)||!/^[a-f0-9]{40}$/.test(query.releaseSha)||!/^[a-f0-9]{64}$/.test(query.configProof))fail('CONTINUATION_QUERY_INVALID');
 try{if(continuationScope({BRIEFING_CONTINUATION_SCOPE:query.scope},query.executionMode)!==query.scope||!query.scope)fail('CONTINUATION_QUERY_INVALID');}
 catch{fail('CONTINUATION_QUERY_INVALID');}
 return query;
}
/** Read-only discovery grants no lease or authority. Each returned canonical
 * identity must still enter the ordinary authenticated/admitted phase runner.
 * Only canonical transport bytes can be reconstructed from existing v32 rows;
 * never substitute a new body digest for an older request's committed receipts. */
export async function discoverPhaseContinuation({query,db,keys,releaseSha,mode,configProof,scope,allowDrain=true,signal}={}){
 validateContinuationQuery(query);
 if(scope!==query.scope||continuationScope({BRIEFING_CONTINUATION_SCOPE:scope},mode)!==scope)fail('CONTINUATION_SCOPE_REJECTED');
 if(!db?.raw||typeof db.admitRuntime!=='function'||!keys||!releaseSha||!mode||!configProof)fail('CONTINUATION_DEPENDENCIES_REQUIRED');
 if(query.releaseSha!==releaseSha)fail('RELEASE_CHECKOUT_MISMATCH');
 if(query.executionMode!==mode||query.configProof!==configProof)fail('EXECUTION_CONFIG_CHANGED');
 const budget=createExecutionBudget({budgetMs:30000,signal});
 try{return await withExecutionBudget(budget,()=>budget.run(async()=>{
  const admission=await db.admitRuntime({source:'cloudflare',fresh:true});
  const assert=()=>{budget.assert();requireRuntimeAdmission(db.raw,admission,keys,db.transaction);};
  assert();
  return db.withRuntimeFence(assert,async()=>{
   const rows=(await db.raw.execute({sql:`SELECT e.*,${databaseNowMs} observed_at FROM phase4_executions e WHERE
    e.release_sha=? AND e.execution_mode=? AND e.trigger_source='cloudflare' AND e.config_proof=?
    AND ((?=1 AND e.phase='STAGE6_DRAIN' AND substr(e.execution_id,1,5)='p4c1_' AND (e.state='WORK_COMMITTED' OR (e.state='ESTABLISHED' AND
      (EXISTS(SELECT 1 FROM phase4_execution_work_receipts r WHERE r.execution_id=e.execution_id) OR
       EXISTS(SELECT 1 FROM phase4_executions p WHERE p.execution_id=e.sync_execution_id AND p.state='FINALIZED_SUCCESS' AND p.created_at>${databaseNowMs}-?)))))
     OR (?=1 AND e.phase='SYNC' AND substr(e.execution_id,1,5)='p4s1_' AND (e.state='WORK_COMMITTED' OR
      (e.state='ESTABLISHED' AND e.created_at>${databaseNowMs}-?)))
     OR (?=1 AND e.phase='SYNC' AND e.state='FINALIZED_SUCCESS' AND e.created_at>${databaseNowMs}-? AND e.execution_id NOT IN
       (SELECT d.sync_execution_id FROM phase4_executions d WHERE d.phase='STAGE6_DRAIN' AND d.sync_execution_id IS NOT NULL AND d.state IN ('FINALIZED_SUCCESS','FINALIZED_FAILURE','ABORTED'))))
    ORDER BY CASE WHEN e.phase='STAGE6_DRAIN' THEN 0 ELSE 1 END,e.execution_seq LIMIT 16`,args:[releaseSha,mode,query.configProof,Number(scopeIncludesDrain(scope)&&allowDrain),EXECUTION_WORK_MAX_AGE_MS,Number(scopeIncludesSync(scope)),EXECUTION_WORK_MAX_AGE_MS,Number(scopeIncludesDrain(scope)&&allowDrain),EXECUTION_WORK_MAX_AGE_MS]})).rows;
   if(!rows.length){assert();return {status:200,body:{ok:true,state:'NONE',requestBody:null}};}
   let row,request,body;
   for(const candidate of rows){
    try{request=validatePhaseRequest(JSON.parse(candidate.canonical_request_json));}catch{fail('EXECUTION_RECORD_CORRUPT');}
    body=canonicalPhaseRequest(request);
    // A finalized ordinary SYNC can only be replayed if these are its exact
    // original transport bytes. Unfinished SYNC is limited to the explicit new
    // canonical namespace; ordinary historical SYNC requests remain untouched.
    if(requestIdentity(body)!==candidate.identity_digest){
     if(candidate.phase==='SYNC')continue;fail('CONTINUATION_TRANSPORT_IDENTITY_UNAVAILABLE');
    }
    if(candidate.phase==='STAGE6_DRAIN'&&!isContinuationRequest(request))fail('CONTINUATION_TRANSPORT_IDENTITY_UNAVAILABLE');
    if(candidate.phase==='SYNC'&&candidate.state!=='FINALIZED_SUCCESS'&&!isSyncContinuationRequest(request))fail('CONTINUATION_TRANSPORT_IDENTITY_UNAVAILABLE');
    row=candidate;break;
   }
   if(!row){assert();return {status:200,body:{ok:true,state:'NONE',requestBody:null}};}
   const reconciled=await reconcileExecution(db,request,row.identity_digest);assert();
   const observed=reconciled.row;
   if(!['ESTABLISHED','WORK_COMMITTED','FINALIZED_SUCCESS','FINALIZED_FAILURE','ABORTED'].includes(observed.state))fail('EXECUTION_RECORD_CORRUPT');
   const state=observed.state==='WORK_COMMITTED'?'WORK_COMMITTED_UNFINALIZED':observed.state==='FINALIZED_SUCCESS'?'FINALIZED_SUCCESS':
    ['FINALIZED_FAILURE','ABORTED'].includes(observed.state)?'TERMINAL_FAILURE':
    observed.observed_outcome==='COMMIT_INDETERMINATE'?'COMMIT_UNCERTAIN':observed.deadline_at>Date.now()?'IN_PROGRESS':'INCOMPLETE_RESUMABLE';
   // No tenant, payload, receipt keys or authority owner is returned.
   return {status:200,body:{ok:true,state,requestBody:body,workReceipts:reconciled.receipts.length}};
  });
 }));}finally{budget.cancel();budget.close();}
}
