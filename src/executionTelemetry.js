import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { currentExecutionBudget } from './executionBudget.js';
import { log } from './logger.js';

// Operational diagnostics never accept facts, SQL, URLs, user identifiers or
// provider errors. Categories and counters are closed sets; no new authority.
export const TELEMETRY_OPERATIONS = Object.freeze([
  'PHASE_ADMISSION','PHASE_CLAIM','PHASE_WORK','PHASE_SETTLEMENT','WEBHOOK_DRAIN','ONBOARDING','USER_RUN','USER_MAINTENANCE',
  'WHOOP_AUTH','DAILY_REPORT','WEEKLY_REPORT','WHOOP_SYNC','FAST_RECONCILIATION','PROACTIVE',
  'ANALYSIS_INPUTS','PREDICTION','HEALTHSPAN','SYSTEM_MAINTENANCE','DB_QUERY','DB_METADATA','RUNTIME_READMISSION','DB_HTTP',
  'WHOOP_HTTP','WHOOP_BODY','MODEL_HTTP','MODEL_BODY','TELEGRAM_HTTP','TELEGRAM_BODY',
]);
const operations = new Set(TELEMETRY_OPERATIONS);
const counters = new Set(['query_count','metadata_query_count','runtime_readmissions','db_http_requests','whoop_requests','model_requests','telegram_requests','retry_count']);
const outcomes = new Set(['COMPLETE','PARTIAL','FAILED','TIMEOUT','CANCELLED','COMMIT_INDETERMINATE',
  'COMPLETE_SUCCESS','NO_NEW_DATA_SUCCESS','INTENTIONALLY_INAPPLICABLE','REQUIRED_RESOURCE_FAILED','AUTH_FAILED',
  'NO_WORK','NO_ELIGIBLE_WORK','BUDGET_EXHAUSTED','DISABLED','POLICY_DEFERRED']);
const scope = new AsyncLocalStorage();
const MAX_EVENTS = 192, MAX_ACTIVE = 128;
const highLevel = new Set(TELEMETRY_OPERATIONS.filter(op=>!['DB_QUERY','DB_METADATA','DB_HTTP','WHOOP_HTTP','WHOOP_BODY','MODEL_HTTP','MODEL_BODY','TELEGRAM_HTTP','TELEGRAM_BODY'].includes(op)));
const boundedNumber = value => Number.isFinite(value) && value >= 0 ? Math.min(Number.MAX_SAFE_INTEGER,Math.floor(value)) : 0;
const safeCall = fn => { try { return fn(); } catch {} };
const remaining = () => safeCall(() => {const budget=currentExecutionBudget();return budget?boundedNumber(budget.remainingMs()):undefined;});
function failureOutcome(error) {
  return safeCall(() => {
    let code=error?.code;try{currentExecutionBudget()?.assert();}catch(budgetError){code=budgetError.code;}
    return ['SYNC_TIMEOUT','WHOOP_MAINTENANCE_DEADLINE'].includes(code)?'TIMEOUT'
      :code==='SYNC_CANCELLED'?'CANCELLED':code==='COMMIT_INDETERMINATE'?'COMMIT_INDETERMINATE':'FAILED';
  }) ?? 'FAILED';
}
function emit(state,event,fields={},bounded=true) {
  const bucket=highLevel.has(fields.operation)?'highEvents':'lowEvents';
  if (state.closed || bounded && state[bucket] >= MAX_EVENTS/2) { if (!state.closed) state.dropped++; return; }
  if (bounded) state[bucket]++;
  safeCall(() => state.emit(event,{request_id:state.correlation,phase:state.phase,source:state.source,
    release_sha:state.releaseSha,execution_seq:state.executionSeq,...fields}));
}
export function countExecutionTelemetry(counter,amount=1) {
  const state=scope.getStore();
  if (!state || state.closed || !counters.has(counter) || !Number.isSafeInteger(amount) || amount<0) return;
  state.counts[counter]=Math.min(Number.MAX_SAFE_INTEGER,state.counts[counter]+amount);
}
export function setExecutionTelemetrySequence(sequence){
 const state=scope.getStore();if(state&&!state.closed&&Number.isSafeInteger(sequence)&&sequence>0)state.executionSeq=sequence;
}
export async function traceExecutionOperation(operation,work) {
  const state=scope.getStore();
  if (!state || state.closed || !operations.has(operation)) return work();
  const sequence=++state.sequence,started=performance.now(),tracked=state.active.size<MAX_ACTIVE;
  const total=state.totals.get(operation)??{count:0,completed_operations:0,failed_operations:0,timed_out:0,cancelled:0,duration_ms:0,max_duration_ms:0};
  total.count++;state.totals.set(operation,total);
  if(tracked)state.active.set(sequence,{operation,started});else state.untracked++;
  emit(state,'phase4_operation_start',{operation,operation_sequence:sequence,remaining_ms:remaining(),outstanding_operations:state.active.size+state.untracked});
  let outcome='OK';
  try {return await work();} catch(error) {outcome=failureOutcome(error);throw error;}
  finally {
    if(tracked)state.active.delete(sequence);else state.untracked--;
    if(!state.closed){
      const duration=boundedNumber(performance.now()-started);total.completed_operations++;
      if(outcome!=='OK')total.failed_operations++;if(outcome==='TIMEOUT')total.timed_out++;if(outcome==='CANCELLED')total.cancelled++;
      total.duration_ms=Math.min(Number.MAX_SAFE_INTEGER,total.duration_ms+duration);total.max_duration_ms=Math.max(total.max_duration_ms,duration);
    }
    emit(state,'phase4_operation_end',{operation,operation_sequence:sequence,outcome,
      duration_ms:boundedNumber(performance.now()-started),remaining_ms:remaining(),outstanding_operations:state.active.size+state.untracked});
  }
}
export async function withPhaseTelemetry({phase,source,releaseSha,emit:emitFn=(event,fields)=>log.info(event,fields)}={},work) {
  if (!['SYNC','STAGE6_DRAIN'].includes(phase) || !['manual','cloudflare','github','event'].includes(source)
    || typeof releaseSha!=='string' || !/^[a-f0-9]{40}$/.test(releaseSha)) return work();
  const state={phase,source,releaseSha,emit:emitFn,correlation:randomUUID(),started:performance.now(),
    active:new Map(),totals:new Map(),untracked:0,counts:Object.fromEntries([...counters].map(key=>[key,0])),sequence:0,highEvents:0,lowEvents:0,dropped:0,closed:false};
  emit(state,'phase4_trace_start',{},false);
  let outcome='FAILED';
  try {
    const result=await scope.run(state,work);
    const reported=result?.body?.result?.outcome;
    outcome=outcomes.has(reported)?reported:'FAILED';return result;
  } catch(error) {outcome=failureOutcome(error);throw error;}
  finally {
    emit(state,'phase4_trace_summary',{outcome,stop_reason:outcome,...state.counts,duration_ms:boundedNumber(performance.now()-state.started),
      operation_count:state.sequence,outstanding_operations:state.active.size+state.untracked,dropped_events:state.dropped},false);
    // Always retain per-category inclusive durations/counters even after the
    // bounded detail budget is exhausted. Nested time is not additive wall time.
    for(const [operation,total] of state.totals)emit(state,'phase4_operation_totals',{operation,...total},false);
    const grouped=new Map();
    for(const value of state.active.values()){
      const previous=grouped.get(value.operation)??{count:0,started:value.started};
      previous.count++;previous.started=Math.min(previous.started,value.started);grouped.set(value.operation,previous);
    }
    for(const [operation,total] of state.totals){
      const count=total.count-total.completed_operations;if(!count)continue;const tracked=grouped.get(operation);
      emit(state,'phase4_operation_outstanding',{operation,count,
        ...(tracked?{duration_ms:boundedNumber(performance.now()-tracked.started)}:{}),outcome:'PENDING'},false);
    }
    // Abandoned async work retains its original authority/cancellation. It must
    // never append diagnostic events to a later caller or falsely finish here.
    state.closed=true;
  }
}
