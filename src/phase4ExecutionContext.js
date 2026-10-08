import {AsyncLocalStorage} from 'node:async_hooks';
const scope=new AsyncLocalStorage();
export const databaseNowMs="(CAST(strftime('%s','now') AS INTEGER)*1000+CAST(substr(strftime('%f','now'),4,3) AS INTEGER))";
export class CommitIndeterminateError extends Error {
 constructor(){super('COMMIT_INDETERMINATE');this.code='COMMIT_INDETERMINATE';}
}
export const withDurableExecution=(context,fn)=>scope.run(context,fn);
export const currentDurableExecution=()=>scope.getStore();
export function requireSettledOperation(error){
 const context=scope.getStore();
 if(error?.code==='COMMIT_INDETERMINATE'||context?.indeterminate||context?.pending?.size)throw new CommitIndeterminateError();
 if(context?.workRejected)throw context.workRejected;
}
const fail=code=>{throw Object.assign(Error(code),{code});};
export async function assertExecutionWorkOwner(client){
 const context=scope.getStore();if(!context||context.receipts===false)return;
 context.authority.assert();const {claim}=context;
 const row=(await client.execute({sql:`SELECT * FROM phase4_executions WHERE execution_id=? AND owner=? AND generation=?
  AND state='ESTABLISHED' AND lease_until>${databaseNowMs} AND deadline_at>${databaseNowMs}`,
  args:[claim.executionId,claim.owner,claim.generation]})).rows[0];
 if(!row)fail('REQUEST_OWNER_FENCED');
 const request=claim.request;
 const canonical=request&&JSON.stringify(Object.fromEntries(Object.keys(request).sort().map(key=>[key,request[key]])));
 if(!request||row.execution_id!==request.requestId||row.identity_digest!==claim.identity||row.scope_key!==claim.scopeKey
  ||row.canonical_request_json!==canonical
  ||row.release_sha!==request.releaseSha||row.phase!==request.phase||row.trigger_source!==request.triggerSource
  ||row.execution_mode!==request.executionMode||row.config_proof!==request.configProof||row.sync_execution_id!==(request.syncRequestId??null))fail('REQUEST_ID_CONFLICT');
 context.authority.assert();return row;
}
export const workStepKey=(context,step)=>context.keys.lookup(['execution-work-step-v2',context.claim.identity,context.claim.scopeKey,step]);
export async function readWorkStep(client,step){
 const context=scope.getStore();if(!context||context.receipts===false)return null;
 await assertExecutionWorkOwner(client);
 const key=workStepKey(context,step);
 const row=(await client.execute({sql:'SELECT * FROM phase4_execution_work_receipts WHERE receipt_key=?',args:[key]})).rows[0];
 if(row&&(row.execution_id!==context.claim.executionId||row.request_digest!==context.claim.identity||row.scope_key!==context.claim.scopeKey||row.generation>context.claim.generation))fail('EXECUTION_RECEIPT_CORRUPT');
 return row??null;
}
/** Only counters/boolean/hash aggregates are receipt results, never health text. */
function receiptResult(result){
 if(result===undefined||result===null)return null;
 if(typeof result==='boolean'||typeof result==='number'&&Number.isFinite(result)||typeof result==='string'&&/^[a-f0-9]{64}$/.test(result))return JSON.stringify(result);
 fail('EXECUTION_WORK_STEP_RESULT_UNSAFE');
}
/** Runs inside the SAME work transaction. Keys are deterministic across owners. */
export async function appendExecutionReceipt(client,{step,result,explicit=false}={}){
 const context=scope.getStore();if(!context||context.receipts===false)return;
 await assertExecutionWorkOwner(client);const {claim}=context;
 const key=workStepKey(context,step),prior=await readWorkStep(client,step);
 if(prior)fail('EXECUTION_WORK_STEP_ALREADY_COMMITTED');
 await client.execute({sql:'INSERT INTO phase4_execution_work_receipts(execution_id,receipt_key,scope_key,request_digest,step_key,generation,committed_at,result_json) VALUES(?,?,?,?,?,?,?,?)',
  args:[claim.executionId,key,claim.scopeKey,claim.identity,key,claim.generation,Date.now(),explicit?receiptResult(result):null]});
 context.authority.assert();
}
export async function bindProducingExecution(client,context){
 const execution=scope.getStore();if(!execution||execution.receipts===false)return;
 const row=await assertExecutionWorkOwner(client);
 if(row.phase!=='STAGE6_DRAIN')fail('EXECUTION_PRODUCER_PHASE_INVALID');
 const proof=execution.keys.lookup(['execution-producer-v1',context.userId,context.executionMode,context.inputGeneration,row.execution_id,row.execution_seq,row.generation]);
 await client.execute({sql:`INSERT INTO phase4_execution_producers(user_id,execution_mode,input_generation,producing_execution_id,producing_generation,execution_seq,tenant_proof)
  VALUES(?,?,?,?,?,?,?) ON CONFLICT(user_id,execution_mode,input_generation,producing_execution_id) DO UPDATE SET producing_execution_id=excluded.producing_execution_id,
  producing_generation=excluded.producing_generation,execution_seq=excluded.execution_seq,tenant_proof=excluded.tenant_proof`,
  args:[context.userId,context.executionMode,context.inputGeneration,row.execution_id,row.generation,row.execution_seq,proof]});
}
