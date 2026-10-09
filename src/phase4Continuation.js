import {createDb} from './db.js';
import {loadEnv} from './config.js';
import {publicBetaKeys,publicBetaConfiguration} from './publicBetaConfig.js';
import {runningReleaseSha} from './phase4Release.js';
import {createExecutionBudget,withExecutionBudget} from './executionBudget.js';
import {requireRuntimeAdmission} from './runtimeAdmission.js';
import {databaseNowMs} from './phase4ExecutionContext.js';
import {configurationProof,canonicalPhaseRequest,reconcileExecution,requestIdentity,EXECUTION_WORK_MAX_AGE_MS,validatePhaseRequest} from './phase4ExecutionStore.js';
export const CONTINUATION_PATH='/internal/briefing/continuation';
const fail=code=>{throw Object.assign(Error(code),{code});};
export function validateContinuationQuery(query){
 if(!query||typeof query!=='object'||Array.isArray(query)||Object.keys(query).sort().join(',')!=='configProof,executionMode,releaseSha,triggerSource'
  ||query.triggerSource!=='cloudflare'||!['OFF','SHADOW'].includes(query.executionMode)||!/^[a-f0-9]{40}$/.test(query.releaseSha)||!/^[a-f0-9]{64}$/.test(query.configProof))fail('CONTINUATION_QUERY_INVALID');
 return query;
}
/** Read-only discovery grants no lease or authority. Each returned canonical
 * identity must still enter the ordinary authenticated/admitted phase runner.
 * Only canonical transport bytes can be reconstructed from existing v32 rows;
 * never substitute a new body digest for an older request's committed receipts. */
export async function discoverPhaseContinuation({query,db:providedDb,keys:providedKeys,environment=process.env,env:providedEnv,signal}={}){
 validateContinuationQuery(query);
 const keys=providedKeys??publicBetaKeys(environment),config=publicBetaConfiguration(environment),releaseSha=runningReleaseSha(environment);
 const mode=config.runtime==='on'?'SHADOW':'OFF';
 if(query.releaseSha!==releaseSha)fail('RELEASE_CHECKOUT_MISMATCH');
 if(query.executionMode!==mode||query.configProof!==configurationProof(keys,config,environment,releaseSha))fail('EXECUTION_CONFIG_CHANGED');
 const env=providedDb?null:providedEnv??loadEnv(),db=providedDb??createDb({url:env.tursoUrl,authToken:env.tursoToken,phase4Keys:keys});
 const budget=createExecutionBudget({budgetMs:30000,signal});
 try{return await withExecutionBudget(budget,()=>budget.run(async()=>{
  const admission=await db.admitRuntime({source:'cloudflare',fresh:true});
  const assert=()=>{budget.assert();requireRuntimeAdmission(db.raw,admission,keys,db.transaction);};
  assert();
  return db.withRuntimeFence(assert,async()=>{
   const rows=(await db.raw.execute({sql:`SELECT e.* FROM phase4_executions e WHERE
    e.release_sha=? AND e.execution_mode=? AND e.trigger_source='cloudflare' AND e.config_proof=?
    AND ((e.phase='STAGE6_DRAIN' AND (e.state='WORK_COMMITTED' OR (e.state='ESTABLISHED' AND
      (EXISTS(SELECT 1 FROM phase4_execution_work_receipts r WHERE r.execution_id=e.execution_id) OR
       EXISTS(SELECT 1 FROM phase4_executions p WHERE p.execution_id=e.sync_execution_id AND p.state='FINALIZED_SUCCESS' AND p.created_at>${databaseNowMs}-?)))))
     OR (e.phase='SYNC' AND (e.state='WORK_COMMITTED' OR (e.created_at>${databaseNowMs}-? AND
      (e.state='ESTABLISHED' OR (e.state='FINALIZED_SUCCESS' AND e.execution_mode='SHADOW' AND NOT EXISTS
       (SELECT 1 FROM phase4_executions d WHERE d.sync_execution_id=e.execution_id AND d.state IN ('FINALIZED_SUCCESS','FINALIZED_FAILURE','ABORTED'))))))))
    ORDER BY CASE WHEN e.phase='STAGE6_DRAIN' THEN 0 WHEN e.state='WORK_COMMITTED' THEN 1 ELSE 2 END,e.execution_seq LIMIT 1`,args:[releaseSha,mode,query.configProof,EXECUTION_WORK_MAX_AGE_MS,EXECUTION_WORK_MAX_AGE_MS]})).rows;
   if(!rows.length){assert();return {status:200,body:{ok:true,state:'NONE',requestBody:null}};}
   const row=rows[0];let request;try{request=validatePhaseRequest(JSON.parse(row.canonical_request_json));}catch{fail('EXECUTION_RECORD_CORRUPT');}
   const body=canonicalPhaseRequest(request);
   if(requestIdentity(body)!==row.identity_digest)fail('CONTINUATION_TRANSPORT_IDENTITY_UNAVAILABLE');
   const reconciled=await reconcileExecution(db,request,row.identity_digest);assert();
   const observed=reconciled.row;
   if(!['ESTABLISHED','WORK_COMMITTED','FINALIZED_SUCCESS','FINALIZED_FAILURE','ABORTED'].includes(observed.state))fail('EXECUTION_RECORD_CORRUPT');
   const state=observed.state==='WORK_COMMITTED'?'WORK_COMMITTED_UNFINALIZED':observed.state==='FINALIZED_SUCCESS'?'FINALIZED_SUCCESS':
    ['FINALIZED_FAILURE','ABORTED'].includes(observed.state)?'TERMINAL_FAILURE':
    observed.observed_outcome==='COMMIT_INDETERMINATE'?'COMMIT_UNCERTAIN':observed.deadline_at>Date.now()?'IN_PROGRESS':'INCOMPLETE_RESUMABLE';
   // No tenant, payload, receipt keys or authority owner is returned.
   return {status:200,body:{ok:true,state,requestBody:body,workReceipts:reconciled.receipts.length}};
  });
 }));}finally{budget.cancel();budget.close();if(!providedDb)db.close();}
}
