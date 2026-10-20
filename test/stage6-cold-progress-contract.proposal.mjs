/** UNACTIVATED SOURCE PROPOSAL. Pure orchestration/metadata contract only.
 * No native adapter, provider, DB, process spawn, credential, runner grant or CLI.
 * Synthetic tests do not establish Linux/OS/HMAC/transport provenance.
 */
import assert from 'node:assert/strict';
export const APPLICATION_BASELINE='ca01f63d2bd948f24a3a0400decdaca898811f39';
export const CANDIDATE=APPLICATION_BASELINE; // synthetic mock candidate only; actual candidate is separately pinned
export const KINDS=Object.freeze(['RECOMPUTE_DERIVED','REPAIR_CURRENTNESS']);
export const PROFILE=Object.freeze({schema:35,fixture:'EMPTY_ONE_SYNTHETIC_USER',maximumOriginalCalls:3,processLegs:2,
 proposedOuterMs:300000,producerMs:45000,contextCleanupMs:5000,readbackMs:5000,workerSafetyMs:15000,
 maxItemsPerTenant:6,addedHttpLatencyMs:115,memoryBytes:536870912,cpuQuota:50000,cpuPeriod:100000,
 sourceProposalOnly:true,actualRunnerWired:false,executionAuthorized:false});
/** Finite public failure vocabulary. Unknown code values are never persisted;
 * inspect only an own data property, without invoking caller getters. */
export function safeFailureCode(error){
 let code;try{code=Object.getOwnPropertyDescriptor(error??{},'code')?.value;}catch{}
 return code==='ERR_ASSERTION'?'ERR_ASSERTION':'NATIVE_COLD_PROOF_REFUSED';
}
const clone=x=>structuredClone(x),hash=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
function state(s){
 assert.match(s.candidateSha,/^[a-f0-9]{40}$/);assert.equal(s.applicationBaselineSha,APPLICATION_BASELINE);assert.equal(s.schema,35);
 for(const k of ['sourceRows','outboundMessages','pilotLedgers','currentPublications'])assert.equal(s[k],0,'HEALTH_FREE_PARTIAL_SCOPE');
 if(s.initialized===false){assert.equal(s.inputGeneration,null);assert.deepEqual(s.jobs,[]);assert.deepEqual(s.receipts,[]);return s;}
 assert.ok(Number.isSafeInteger(s.inputGeneration)&&s.inputGeneration>0);assert.equal(s.lastCompletedGeneration,0);
 assert.ok(hash(s.tenantScopeHash));assert.equal(s.jobs.length,2);assert.deepEqual(s.jobs.map(j=>j.kind).sort(),KINDS);
 for(const j of s.jobs){assert.equal(j.requestedGeneration,s.inputGeneration);assert.equal(j.completedGeneration,0);
  assert.equal(j.state,'PENDING');assert.equal(j.attempt,0);assert.equal(j.leaseOwner,null);assert.equal(j.lastError,null);
  assert.ok(Number.isSafeInteger(j.scopeRevision)&&j.scopeRevision>=0);assert.ok(Number.isSafeInteger(j.updatedAt));
  assert.ok([0,1].includes(j.cursorRank));assert.ok(j.cursorRank===0?j.cursorHash===null:hash(j.cursorHash));
 }
 assert.ok(Array.isArray(s.receipts)&&s.receipts.length<=256);
 const keys=s.receipts.map(r=>r.keyHash);assert.equal(new Set(keys).size,keys.length);
 for(const r of s.receipts)assert.ok(hash(r.keyHash)&&hash(r.rowHash));
 return s;
}
const byKind=s=>new Map(s.jobs.map(j=>[j.kind,j]));
export function selectedKind(s){state(s);return s.jobs.slice().sort((a,b)=>a.updatedAt-b.updatedAt||a.kind.localeCompare(b.kind))[0].kind;}
export function checkStep(before,after,result,requestId){
 state(before);state(after);assert.equal(after.candidateSha,before.candidateSha);assert.ok(KINDS.includes(result.selectedJobKind));
 if(before.initialized!==false)assert.equal(after.inputGeneration,before.inputGeneration,'NO_GENERATION_RESET');
 if(before.initialized!==false)assert.equal(after.tenantScopeHash,before.tenantScopeHash,'SAME_CONTEXT_BINDINGS');
 assert.equal(result.requestId,requestId);assert.equal(result.replayed,false,'FINALIZED_ID_REPLAY_IS_NOT_PRODUCTIVE');
 assert.equal(result.executionState,'FINALIZED_SUCCESS');assert.equal(result.executionGeneration,1);
 assert.equal(result.outcome,'PARTIAL','HONEST_PARTIAL_ONLY');assert.ok(Number.isSafeInteger(result.unitsCommitted)&&result.unitsCommitted>0);
 const priorExecutions=new Map((before.executionPins??[]).map(r=>[r.keyHash,r.rowHash])),nextExecutions=new Map((after.executionPins??[]).map(r=>[r.keyHash,r.rowHash]));
 for(const [key,row]of priorExecutions)assert.equal(nextExecutions.get(key),row,'ORIGINAL_EXECUTION_IMMUTABLE');
 const oldProducers=new Map((before.producerPins??[]).map(r=>[r.keyHash,r.rowHash])),newProducers=new Map((after.producerPins??[]).map(r=>[r.keyHash,r.rowHash]));for(const [key,row]of oldProducers)assert.equal(newProducers.get(key),row,'ORIGINAL_TENANT_PRODUCER_IMMUTABLE');
 const prior=new Map(before.receipts.map(r=>[r.keyHash,r.rowHash])),next=new Map(after.receipts.map(r=>[r.keyHash,r.rowHash]));
 for(const [key,row]of prior)assert.equal(next.get(key),row,'ORIGINAL_RECEIPT_IMMUTABLE');
 assert.ok(next.size>prior.size,'ACTUAL_NEW_WORK_RECEIPT_REQUIRED');
 if(before.initialized===false){assert.equal(after.initialized,true);return {selectedJobKind:result.selectedJobKind,newReceipts:next.size,bootstrapFromObservedAbsence:true};}
 const old=byKind(before),fresh=byKind(after);
 for(const kind of KINDS){const a=old.get(kind),b=fresh.get(kind);assert.equal(b.scopeRevision,a.scopeRevision,'NO_SCOPE_RESET');
  assert.ok(b.cursorRank>=a.cursorRank,'NO_CURSOR_RESET');if(a.cursorRank===1)assert.equal(b.cursorHash,a.cursorHash,'ORIGINAL_EMPTY_USER_CURSOR_IMMUTABLE');
 }
 const picked=selectedKind(before);assert.equal(result.selectedJobKind,picked,'NO_JOB_SELECTOR_OVERRIDE');
 assert.ok(fresh.get(picked).updatedAt>old.get(picked).updatedAt,'REAL_JOB_RELEASE_ORDER');
 return {selectedJobKind:picked,newReceipts:next.size-prior.size};
}
/** Caller is a future separately reviewed native adapter. This function grants
 * none of its callbacks process/HMAC/transport provenance. Counter is shared
 * across two legs; no retries, random identities, convergence loop or resets.
 */
export async function runLeg({phase,pid,requestIds,carry=null,now,deadlineMs,capture,runOriginal}){
 assert.ok(['A','B'].includes(phase));assert.ok(Number.isSafeInteger(pid)&&pid>0);
 assert.equal(requestIds.length,3);assert.equal(new Set(requestIds).size,3);
 assert.ok(requestIds.every(x=>typeof x==='string'&&/^[a-zA-Z0-9_-]{8,128}$/.test(x)));
 assert.ok(Number.isFinite(deadlineMs));const guard=()=>{assert.ok(Number.isFinite(now())&&now()<deadlineMs,'ORIGINAL_GLOBAL_DEADLINE');};
 guard();let count=phase==='A'?0:carry?.callsStarted;const steps=[];
 if(phase==='A')assert.equal(carry,null);else{
  assert.equal(count,2);assert.equal(carry.applicationBaselineSha,APPLICATION_BASELINE);assert.equal(carry.deadlineMs,deadlineMs,'NO_DEADLINE_RESET');
  assert.deepEqual(carry.requestIds,requestIds);assert.notEqual(pid,carry.pidA,'REAL_NEW_OS_PID_REQUIRED_BY_NATIVE_ADAPTER');
 }
 let before=state(await capture());guard();
 if(phase==='B')assert.deepEqual(before,carry.afterA,'EXACT_DURABLE_BOUNDARY_NO_NEW_GENERATION_OR_RECEIPT_LOSS');
 const initial=clone(before),limit=phase==='A'?2:3;
 while(count<limit){guard();const requestId=requestIds[count];count++; // reserve BEFORE invoke, never refund/retry
  const result=await runOriginal(requestId,count);guard();const after=state(await capture());guard();
  steps.push(checkStep(before,after,result,requestId));before=after;
 }
 if(phase==='A')return {candidateSha:before.candidateSha,applicationBaselineSha:APPLICATION_BASELINE,pidA:pid,callsStarted:count,deadlineMs,requestIds:clone(requestIds),afterA:clone(before),steps,sourceProposalOnly:true};
 const selected=steps[0].selectedJobKind,prior=byKind(initial).get(selected);
 assert.equal(prior.cursorRank,1,'COLD_EXISTING_CURSOR_RESUME_NOT_OBSERVED');
 assert.equal(selected,carry.steps[0].selectedJobKind,'THIRD_CALL_RESUMES_ORIGINAL_FIRST_JOB');
 return {status:'PROPOSAL_METADATA_THREE_PRODUCTIVE_CALLS_TWO_PID_BOUNDARY_VALID',callsStarted:count,steps,
 sameGeneration:true,originalReceiptsPreserved:true,coldCursorResumeMetadataObserved:true,
 originalJobsCompleted:0,wholeJobCompletionQualified:false,capacityQualified:false,
 actualNativeQualified:false,physicalProcessAndReceiptProvenance:'REQUIRES_SEPARATELY_REVIEWED_NATIVE_ADAPTER',executionAuthorized:false};
}
