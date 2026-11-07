import {EXECUTION_RECONCILIATION_MAX_AGE_MS} from './phase4ExecutionStore.js';

export const OPERATIONAL_RETENTION_MS=30*86400000;
// This exception is only for the already-existing backlog authorized on Nov 6.
// Newly created unfinished work always uses the ordinary 30-day retention.
export const INITIAL_DEAD_BACKLOG_CUTOFF=Date.parse('2026-11-06T15:00:00Z');
export const terminalExecution=row=>['FINALIZED_SUCCESS','FINALIZED_FAILURE','ABORTED'].includes(row?.state);

/** Decisions are deliberately separate from SQL mutation. Unknown closure or
 * unverified runtime readers never become permission to delete anything. */
export function classifyExecutionRetirement(row,{now,latestSequence,readPathsClosed,retainedReferences,existingUserReceiptCount}={}){
 const reasons=[];
 if(!Number.isSafeInteger(now)||!Number.isSafeInteger(latestSequence)||readPathsClosed!==true||!Array.isArray(retainedReferences))
  return {dead:false,retirable:false,reasons:['RETIREMENT_EVIDENCE_INCOMPLETE']};
 if(row.execution_seq===latestSequence)reasons.push('LATEST_PHASE_SOURCE');
 if(retainedReferences.length)reasons.push('RETAINED_REFERENCE');
 const unfinished=['ESTABLISHED','WORK_COMMITTED'].includes(row.state);
 if(unfinished){
  if(!Number.isSafeInteger(row.created_at)||now-row.created_at<=EXECUTION_RECONCILIATION_MAX_AGE_MS)reasons.push('AGE_NOT_OVER_24H');
  if(!Number.isSafeInteger(row.lease_until)||!Number.isSafeInteger(row.deadline_at)||row.lease_until>=now||row.deadline_at>=now)reasons.push('AUTHORITY_NOT_EXPIRED');
 }else if(!terminalExecution(row))reasons.push('STATE_UNSUPPORTED');
 const dead=unfinished&&reasons.length===0;
 // A dead execution is not necessarily disposable. Receipt ownership blocks
 // retirement of the whole execution, never the erasure of one subject's
 // receipts. Keep these decisions separate so deleting a subject does not
 // destroy another subject's original work in the same execution.
 if(!Number.isSafeInteger(existingUserReceiptCount)||existingUserReceiptCount<0)reasons.push('RECEIPT_OWNERSHIP_UNPROVEN');
 else if(existingUserReceiptCount>0)reasons.push('EXISTING_USER_RECEIPT');
 const old=Number.isSafeInteger(row.created_at)&&now-row.created_at>OPERATIONAL_RETENTION_MS;
 const backlog=dead&&row.created_at<INITIAL_DEAD_BACKLOG_CUTOFF;
 return {dead,retirable:reasons.length===0&&(old||backlog),reasons:reasons.length?reasons:old||backlog?[]:['RETENTION_NOT_DUE']};
}

/** Ownership is a verified derivation, not a substring/hash heuristic. The
 * caller must recheck this plan in the same atomic batch as its deletes. */
export function classifySubjectReceipt(row,{ownershipVerified,retainedReceiptReferences,...evidence}={}){
 if(ownershipVerified!==true||!Array.isArray(retainedReceiptReferences))return {action:'BLOCKED',reason:'RECEIPT_OWNERSHIP_UNPROVEN'};
 if(retainedReceiptReferences.length)return {action:'BLOCKED',reason:'RECEIPT_RETAINED_BY_OTHER_SUBJECT'};
 const classification=classifyExecutionRetirement(row,{...evidence,existingUserReceiptCount:0});
 if(evidence.readPathsClosed!==true)return {action:'BLOCKED',reason:'RETIREMENT_EVIDENCE_INCOMPLETE'};
 if(terminalExecution(row)||classification.dead)return {action:'DELETE',reason:terminalExecution(row)?'TERMINAL_EXECUTION':'DEAD_EXECUTION'};
 return {action:'PENDING',reason:'EXECUTION_NOT_TERMINAL_OR_DEAD'};
}

/** Exhaustive named read surfaces for the v33 execution family. Schema files
 * are included so dynamic aliases/new readers cannot be mistaken for absence.
 * Finalized publication proofs remain protected by retained references. */
export const EXECUTION_READ_PATHS=Object.freeze({
 'phase4ExecutionStore.js':'readPhaseProgress protects latest phase/source; reconcile/claim/requireSyncHandoff reject unfinished age >=24h; owner settlement requires unexpired lease/deadline; finalized source replay is protected by references',
 'phase4Continuation.js':'discovery SQL excludes unfinished age >=24h, then reconcile rechecks age; ordinary SYNC work still expires after 15m',
 'phase4ExecutionContext.js':'work/read receipt admission requires same live owner/generation and unexpired lease/deadline',
 'processingTransaction.js':'first admission requires live owner/generation and lease/deadline; uncertain commits use capped reconcileExecution',
 'stage6ShortPublication.js':'closure includes current execution and retained user producers/parents; final batch rechecks owner lease/deadline; uncertainty uses capped reconcileExecution',
 'phase4MetricUnitReceipt.js':'only retained producer/source proof closure or current live owner; keep referenced historical receipts',
 'bodyEnergySourceUnitAuthority.js':'only retained producer and exact source-unit receipt; preserve that entire authority closure',
 'bodyEnergyDerivedTime.js':'retained producer proof must be finalized success, except the current live owner',
 'bodyEnergyDrainAuthority.js':'requires FINALIZED_SUCCESS STAGE6_DRAIN and an unchanged signed grant; cannot accept unfinished execution',
 'phase4Repositories.js':'retained producers for requested user/generation; protected by the reference closure',
 'phase4Diagnostics.js':'retained producers and their sibling producers; protected by the reference closure',
 'stage8PostSync.js':'disabled in v33; even when enabled requires matching release/config, finalized SYNC and 15m handoff',
 'stage8LiveAllocation.js':'maps these names to distinct v35 live tables; no v33 resumption authority',
 'syncCommitSnapshot.js':'in-flight read cache only; no independent claim or continuation authority',
 'identityStore.js':'PRAGMA table existence during new identity initialization, not execution resumption',
 'phase4V32Schema.js':'schema/triggers; monotonic sequence and FK closure require latest/parent preservation',
 'erasureCatalog.js':'ownership inventory and exact user work-key derivation; no resume authority',
 'executionRetirement.js':'read-only retention policy; unknown evidence denies deletion',
 'erasureExecutionScan.js':'bounded keyset pages of execution authority and per-execution receipts; global latest phase/source retained; no resume authority',
 'erasureReceiptPlan.js':'exact individual receipt ownership, whole-execution existing-user exclusion and subject-only atomic delete plan; no resume authority',
 'userErasure.js':'disabled-subject erasure snapshots execution/receipt/producers and fences the atomic personal delete; no execution continuation',
 'executionErasureReferences.js':'typed and text/JSON/KV reference predicates; rechecked in atomic retirement batch',
 'operationalRetention.js':'bounded retirement preserves existing-user receipt executions, latest progress and all retained references',
});
