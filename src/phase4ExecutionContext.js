import {AsyncLocalStorage} from 'node:async_hooks';
import {randomUUID} from 'node:crypto';
const scope=new AsyncLocalStorage();
export const databaseNowMs="(CAST(strftime('%s','now') AS INTEGER)*1000+CAST(substr(strftime('%f','now'),4,3) AS INTEGER))";
export class CommitIndeterminateError extends Error {
 constructor(){super('COMMIT_INDETERMINATE');this.code='COMMIT_INDETERMINATE';}
}
export const withDurableExecution=(context,fn)=>scope.run(context,fn);
export const currentDurableExecution=()=>scope.getStore();
/** Runs inside the SAME work transaction. It contains no payload/result text. */
export async function appendExecutionReceipt(client){
 const context=scope.getStore();if(!context||context.receipts===false)return;
 context.authority.assert();const {claim,keys}=context;
 const valid=await client.execute({sql:`SELECT 1 FROM phase4_executions WHERE execution_id=? AND owner=? AND generation=?
  AND state='ESTABLISHED' AND lease_until>${databaseNowMs} AND deadline_at>${databaseNowMs}`,
  args:[claim.executionId,claim.owner,claim.generation]});
 if(!valid.rows.length)throw Object.assign(Error('REQUEST_OWNER_FENCED'),{code:'REQUEST_OWNER_FENCED'});
 await client.execute({sql:'INSERT INTO phase4_execution_work_receipts(execution_id,receipt_key,scope_key,generation,committed_at) VALUES(?,?,?,?,?)',
  args:[claim.executionId,keys.lookup(['execution-work-receipt-v1',claim.executionId,claim.generation,randomUUID()]),claim.scopeKey,claim.generation,Date.now()]});
 context.authority.assert();
}
