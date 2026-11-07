import {requirePhase4Keys} from './phase4Keys.js';
import {userErrorClearReceiptKey} from './erasureCatalog.js';
import {classifyExecutionRetirement,classifySubjectReceipt} from './executionRetirement.js';

const fail=code=>{throw Object.assign(Error(code),{code});};
/** Exact ownership chain for the individual API receipts produced by the
 * current SYNC path. Opaque receipts are not guessed from their result. */
export function executionReceiptOwners({keys,users,executions,receipts}){
 requirePhase4Keys(keys);
 const byKey=new Map(receipts.map(r=>[r.receipt_key,r]));
 if(byKey.size!==receipts.length)fail('ERASURE_RECEIPT_AMBIGUOUS');
 const owners=new Map();
 for(const user of users){
  if(typeof user.id!=='string'||!Number.isSafeInteger(user.lifecycle_generation)||user.lifecycle_generation<1||user.lifecycle_generation>10000)fail('ERASURE_GENERATION_UNPROVEN');
  for(let generation=1;generation<=user.lifecycle_generation;generation++)for(const execution of executions){
   const key=userErrorClearReceiptKey(keys,execution,user.id,generation),receipt=byKey.get(key);
   if(!receipt)continue;
   if(receipt.execution_id!==execution.execution_id||owners.has(key)&&owners.get(key)!==user.id)fail('ERASURE_RECEIPT_AMBIGUOUS');
   owners.set(key,user.id);
  }
 }
 return owners;
}

/** Reference sets come from the exhaustive typed + JSON/KV closure scanner.
 * Absence of a scan is different from a verified empty set. */
export function planExecutionErasure({keys,users,executions,receipts,subject=null,now,references}){
 if(!(references instanceof Map))fail('ERASURE_REFERENCES_UNPROVEN');
 const subjects=subject&&!users.some(u=>u.id===subject.id)?[...users,subject]:users;
 const owners=executionReceiptOwners({keys,users:subjects,executions,receipts});
 const existing=new Set(users.filter(u=>u.id!==subject?.id).map(u=>u.id));
 const latest=new Map();for(const e of executions){const pair=JSON.stringify([e.phase,e.trigger_source]);latest.set(pair,Math.max(latest.get(pair)??0,e.execution_seq));}
 const removeReceipts=[],pendingReceipts=[],retireExecutions=[],decisions=[];
 for(const e of executions){
  const refs=references.get(e.execution_id);if(!refs||!Array.isArray(refs.execution)||!(refs.receipts instanceof Map))fail('ERASURE_REFERENCES_UNPROVEN');
  const rows=receipts.filter(r=>r.execution_id===e.execution_id);
  const evidence={now,latestSequence:latest.get(JSON.stringify([e.phase,e.trigger_source])),readPathsClosed:true,retainedReferences:refs.execution,
   existingUserReceiptCount:rows.filter(r=>existing.has(owners.get(r.receipt_key))).length};
  const result=classifyExecutionRetirement(e,evidence);decisions.push({executionId:e.execution_id,...result});
  if(subject){
   for(const r of rows.filter(r=>owners.get(r.receipt_key)===subject.id)){
    const disposition=classifySubjectReceipt(e,{...evidence,ownershipVerified:true,retainedReceiptReferences:refs.receipts.get(r.receipt_key)});
    if(disposition.action==='BLOCKED')fail(disposition.reason);
    (disposition.action==='DELETE'?removeReceipts:pendingReceipts).push(r.receipt_key);
   }
  }else if(result.retirable)retireExecutions.push(e.execution_id);
 }
 return {removeReceipts,pendingReceipts,retireExecutions,decisions};
}

/** The caller owns the write transaction and rechecks its snapshot, fences and
 * reference closure before passing this single batch to libSQL. Never execute
 * DROP/DELETE/CREATE as separate commits. Only the exact captured DDL returns. */
export function receiptDeleteBatch({receiptKeys,guard}){
 if(!Array.isArray(receiptKeys)||new Set(receiptKeys).size!==receiptKeys.length||receiptKeys.some(k=>!/^[a-f0-9]{64}$/.test(k)))fail('ERASURE_RECEIPT_PLAN_INVALID');
 if(!receiptKeys.length)return [];
 if(guard?.name!=='p4_execution_receipt_no_delete'||guard.tbl_name!=='phase4_execution_work_receipts'
  ||typeof guard.sql!=='string'||!/^CREATE TRIGGER(?: IF NOT EXISTS)? p4_execution_receipt_no_delete BEFORE DELETE ON phase4_execution_work_receipts\s+BEGIN SELECT RAISE\(ABORT,'p4_execution_receipt_no_delete'\); END$/i.test(guard.sql))fail('ERASURE_TRIGGER_UNPROVEN');
 // Chunking limits parameters; all chunks still share the one outer batch.
 const statements=[{sql:'DROP TRIGGER p4_execution_receipt_no_delete',args:[]}];
 for(let i=0;i<receiptKeys.length;i+=100){const args=receiptKeys.slice(i,i+100);statements.push({sql:`DELETE FROM phase4_execution_work_receipts WHERE receipt_key IN (${args.map(()=>'?').join(',')})`,args});}
 statements.push({sql:guard.sql,args:[]});return statements;
}
