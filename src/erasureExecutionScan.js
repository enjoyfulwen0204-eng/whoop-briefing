import {executionReceiptOwners} from './erasureReceiptPlan.js';
const fail=code=>{throw Object.assign(Error(code),{code});};
const q=(sql,args=[])=>({sql,args});

/** Keyset pagination bounds memory independently of retained history. The
 * latest authority is read separately: a page boundary is never a retirement
 * boundary. Callers still assert state, generation and references atomically. */
export async function* scanErasureExecutions(client,{budget,pageSize=32,afterSequence=0}={}){
 if(!Number.isInteger(pageSize)||pageSize<1||pageSize>64)fail('ERASURE_PAGE_INVALID');
 const latestRows=(await client.execute('SELECT phase,trigger_source,MAX(execution_seq) execution_seq FROM phase4_executions GROUP BY phase,trigger_source')).rows;
 const latest=new Map(latestRows.map(r=>[JSON.stringify([r.phase,r.trigger_source]),r.execution_seq]));
 if(!Number.isSafeInteger(afterSequence)||afterSequence<0)fail('ERASURE_PAGE_INVALID');
 let after=afterSequence;
 for(;;){
  budget?.assert();
  const page=(await client.execute(q('SELECT * FROM phase4_executions WHERE execution_seq>? ORDER BY execution_seq LIMIT ?',[after,pageSize]))).rows;
  if(!page.length)return;
  for(const execution of page){
   budget?.assert();let cursor='',receipts=[];
   for(;;){
    const rows=(await client.execute(q('SELECT * FROM phase4_execution_work_receipts WHERE execution_id=? AND receipt_key>? ORDER BY receipt_key LIMIT 256',[execution.execution_id,cursor]))).rows;
    receipts.push(...rows);if(receipts.length>8192)fail('ERASURE_EXECUTION_RECEIPT_BOUND');
    if(rows.length<256)break;cursor=rows.at(-1).receipt_key;budget?.assert();
   }
   const children=(await client.execute(q('SELECT 1 FROM phase4_executions WHERE sync_execution_id=? LIMIT 1',[execution.execution_id]))).rows.length;
   yield {execution,receipts,latestSequence:latest.get(JSON.stringify([execution.phase,execution.trigger_source])),children};
   after=execution.execution_seq;
  }
  if(page.length<pageSize)return;
 }
}
export function ownersForExecution(keys,users,execution,receipts){return executionReceiptOwners({keys,users,executions:[execution],receipts});}
