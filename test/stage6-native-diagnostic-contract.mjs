// Portable test-only allowlists/bounds. No application, DB, fetch or provider imports.
import {createHash} from 'node:crypto';
import {safeExecutionObservation} from './stage6-native-attribution.mjs';
export const DIAGNOSTIC_LIMITS=Object.freeze({wallMs:120000,maximumCalls:1,producerMs:45000,producerCleanupMs:5000,readbackMs:5000,harnessCleanupMs:5000,minimumCallReserveMs:60000});
const fail=code=>{throw Object.assign(Error(code),{code});};
export const digest=value=>createHash('sha256').update(String(value)).digest('hex');
export const integer=value=>Number.isSafeInteger(value)&&value>=0?value:null;
export function createDiagnosticWall({startedMonoMs,now=()=>performance.now()}={}){
 if(!Number.isFinite(startedMonoMs)||startedMonoMs<0||now()<startedMonoMs||now()-startedMonoMs>120000)fail('DIAGNOSTIC_CLOCK_OR_START_INVALID');
 let calls=0;const elapsed=()=>Math.max(0,now()-startedMonoMs),remaining=()=>Math.max(0,120000-elapsed());
 const assert=()=>{if(now()<startedMonoMs||remaining()<=0)fail('DIAGNOSTIC_WALL_EXHAUSTED');};
 return Object.freeze({elapsed,remaining,assert,get callsStarted(){return calls;},admitOriginalCall(){assert();if(calls!==0)fail('DIAGNOSTIC_SECOND_CALL_FORBIDDEN');if(remaining()<60000)return false;calls++;return true;},finalize({cleanupJoined,terminalKnown}={}){return Object.freeze({elapsedMs:elapsed(),wallCompliant:elapsed()<=120000,cleanupJoined:cleanupJoined===true,terminalKnown:terminalKnown===true,withinBoundAndSettled:elapsed()<=120000&&cleanupJoined===true&&terminalKnown===true});}});
}
export const JOB_KINDS=Object.freeze(['RECOMPUTE_DERIVED','REPAIR_CURRENTNESS']);
const JOB_STATES=Object.freeze(['PENDING','RUNNING','RETRY_WAIT','REPAIR_REQUIRED','COMPLETED']);
export function safeProgress({jobs=[],computation,execution,executionResult,receiptCount,sourceRows,outboundMessages,pilotLedgers,currentPublications,callAcknowledgement='UNKNOWN'}={}){
 const input=integer(computation?.input_generation),completed=integer(computation?.last_completed_generation),list=[];
 for(const kind of JOB_KINDS){
  const matches=Array.isArray(jobs)?jobs.filter(row=>row.job_kind===kind):[],row=matches.length===1?matches[0]:null;
  const requested=integer(row?.requested_generation),done=integer(row?.completed_generation),cursor=row?.full_scan_cursor;
  list.push(Object.freeze({kind,observed:row!==null,state:JOB_STATES.includes(row?.state)?row.state:'UNKNOWN',generationEquality:requested!==null&&done!==null?requested===done:null,generationLag:requested!==null&&done!==null&&requested>=done?requested-done:null,hasFullScanCursor:row?typeof cursor==='string'?true:cursor===null?false:null:null,cursorSha256:typeof cursor==='string'?digest(cursor):null,completedScope:row?.scope_kind==='NONE',requestedGeneration:requested,completedGeneration:done}));
 }
 const originalJobsCompleted=Array.isArray(jobs)&&jobs.length===2&&list.every(j=>j.observed&&j.state==='COMPLETED'&&j.generationEquality===true&&j.completedScope&&j.hasFullScanCursor===false)?2:0;
 return Object.freeze({readbackStatus:'OBSERVED',jobs:Object.freeze(list),originalJobsCompleted,currentComputation:input!==null&&completed!==null?input===completed:null,inputGeneration:input,lastCompletedGeneration:completed,computationGenerationLag:input!==null&&completed!==null&&input>=completed?input-completed:null,execution:safeExecutionObservation({executionState:execution?.state,resultOutcome:executionResult?.outcome,callAcknowledgement}),executionWorkReceiptCount:integer(receiptCount),executionWorkReceiptReadback:integer(receiptCount)===null?'UNKNOWN':receiptCount===0?'NONE':'OBSERVED',sourceRows:integer(sourceRows),outboundMessages:integer(outboundMessages),pilotLedgers:integer(pilotLedgers),currentPublications:integer(currentPublications)});
}
export function progressDelta(before,after){
 if(before?.readbackStatus!=='OBSERVED'||after?.readbackStatus!=='OBSERVED')return Object.freeze({status:'UNKNOWN'});
 const change=(a,b)=>integer(a)!==null&&integer(b)!==null?b-a:null;
 return Object.freeze({status:'OBSERVED',inputGenerationDelta:change(before.inputGeneration,after.inputGeneration),completedGenerationDelta:change(before.lastCompletedGeneration,after.lastCompletedGeneration),originalJobsCompletedDelta:after.originalJobsCompleted-before.originalJobsCompleted,jobs:JOB_KINDS.map(kind=>{const a=before.jobs.find(j=>j.kind===kind),b=after.jobs.find(j=>j.kind===kind);return {kind,cursorChanged:a?.observed&&b?.observed?a.cursorSha256!==b.cursorSha256:null,requestedGenerationDelta:change(a?.requestedGeneration,b?.requestedGeneration),completedGenerationDelta:change(a?.completedGeneration,b?.completedGeneration)};})});
}
const OPERATIONS=new Set(['PHASE_ADMISSION','PHASE_CLAIM','PHASE_WORK','PHASE_SETTLEMENT','WEBHOOK_DRAIN','ONBOARDING','USER_RUN','USER_MAINTENANCE','WHOOP_AUTH','DAILY_REPORT','WEEKLY_REPORT','WHOOP_SYNC','FAST_RECONCILIATION','PROACTIVE','ANALYSIS_INPUTS','PREDICTION','HEALTHSPAN','SYSTEM_MAINTENANCE','DB_QUERY','DB_METADATA','RUNTIME_READMISSION','DB_HTTP','WHOOP_HTTP','WHOOP_BODY','MODEL_HTTP','MODEL_BODY','TELEGRAM_HTTP','TELEGRAM_BODY']);
const OUTCOMES=new Set(['COMPLETE','PARTIAL','FAILED','TIMEOUT','CANCELLED','COMMIT_INDETERMINATE','COMPLETE_SUCCESS','NO_NEW_DATA_SUCCESS','INTENTIONALLY_INAPPLICABLE','REQUIRED_RESOURCE_FAILED','AUTH_FAILED','NO_WORK','NO_ELIGIBLE_WORK','BUDGET_EXHAUSTED','DISABLED','POLICY_DEFERRED']);
const SUMMARY_NUMBERS=['query_count','metadata_query_count','runtime_readmissions','db_http_requests','whoop_requests','model_requests','telegram_requests','retry_count','duration_ms','operation_count','outstanding_operations','dropped_events'];
const TOTAL_NUMBERS=['count','completed_operations','failed_operations','timed_out','cancelled','duration_ms','max_duration_ms'];
export function createDiagnosticTelemetrySink(){
 const totals={},outstanding={};let summary=null,invalid=0;
 const pick=(fields,names)=>Object.fromEntries(names.map(name=>[name,integer(fields?.[name])]));
 return Object.freeze({emit(event,fields){
  if(event==='phase4_trace_summary'){summary={outcome:OUTCOMES.has(fields?.outcome)?fields.outcome:'UNKNOWN',...pick(fields,SUMMARY_NUMBERS)};return;}
  if(event==='phase4_operation_totals'||event==='phase4_operation_outstanding'){
   if(!OPERATIONS.has(fields?.operation)){invalid++;return;}
   if(event==='phase4_operation_totals')totals[fields.operation]=pick(fields,TOTAL_NUMBERS);
   else outstanding[fields.operation]=pick(fields,['count','duration_ms']);
  }
 },snapshot(){return structuredClone({summary,totals,outstanding,invalidEnumEvents:invalid});}});
}
export async function observeOriginalResult({run,withTelemetry,releaseSha,sink}){
 let original;await withTelemetry({phase:'STAGE6_DRAIN',source:'manual',releaseSha,emit:sink.emit},async()=>{
  original=await run();return {body:{result:{outcome:OUTCOMES.has(original?.result?.outcome)?original.result.outcome:'FAILED'}}};
 });return original;
}

/** Evidence on the exact pinned b1 source only; these are frame matches, never inferred semantic duration or completion. */
export function failureSourceSites(frames=[]){
 return Object.freeze({producerContextCleanupFrameObserved:Array.isArray(frames)&&frames.some(f=>f.sourceBasename==='stage8LiveProducer.js'&&f.line===97),sharedContextReleaseFrameObserved:Array.isArray(frames)&&frames.some(f=>f.sourceBasename==='phase4Cache.js'&&f.line>=24&&f.line<=27||f.sourceBasename==='phase4Coordination.js'&&f.line===8),innerSemanticWorkUnit:'UNKNOWN_NOT_INSTRUMENTED',interpretation:'PINNED_SOURCE_FRAME_EVIDENCE_ONLY'});
}
