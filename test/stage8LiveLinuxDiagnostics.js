// Synthetic/offline diagnostics only. No SQL bodies, bound values, row contents,
// request identities, stack text or credentials survive this collector.
import {createHash} from 'node:crypto';
export const LINUX_HTTP_PHASES=Object.freeze(['SETUP','MIGRATION','FOUNDATION','SEED','ADMISSION','PRODUCER_CONSTRUCTOR','READER_CONSTRUCTOR','LEG_BEFORE','PRODUCER_LEG','LEG_READBACK','VERIFY','FINAL']);
const categories=new Set(['PRINCIPAL_READY_METADATA','LIVE_EXECUTION','LIVE_RESULT','DURABLE_JOBS','SCHEMA','TENANT_FENCE','OTHER']);
const stages=['UNCLASSIFIED','TENANT_INITIALIZATION','ALGORITHM_ROLLOUT','FRESH_GENERATION','WORKER_DRAIN','DURABLE_EXECUTION','CONTEXT_CAPTURE','PRINCIPAL_READY'];
const verbs=new Set(['SELECT','INSERT','UPDATE','DELETE','BEGIN','COMMIT','ROLLBACK','PRAGMA','CREATE','ALTER','DROP','SAVEPOINT','RELEASE']);
export function linuxSqlLabel(sql){
 const text=String(sql??''),verb=/^\s*([A-Za-z]+)/.exec(text)?.[1]?.toUpperCase();
 // A single token pass is required: comment markers inside a quoted literal
 // are data, and quotes inside a comment cannot start a literal token.
 const normalized=text.replace(/'(?:''|[^'])*'|"(?:""|[^"])*"|\/\*[\s\S]*?\*\/|--[^\n]*|\b(?:0x[0-9a-f]+|\d+(?:\.\d+)?(?:e[+-]?\d+)?)\b/gi,token=>token.startsWith('--')||token.startsWith('/*')?' ':'?').replace(/\s+/g,' ').trim();
 const category=/FROM\s+users\s+u\s+JOIN\s+phase4_user_state\s+p[\s\S]*JOIN\s+user_onboarding\s+o/i.test(text)?'PRINCIPAL_READY_METADATA':/stage8_live_execution/i.test(text)?'LIVE_EXECUTION':/stage8_live_(?:operation_receipts|job_completions|publications)/i.test(text)?'LIVE_RESULT':/phase4_jobs/i.test(text)?'DURABLE_JOBS':/sqlite_master|sqlite_schema|^\s*PRAGMA/i.test(text)?'SCHEMA':/phase4_(?:user_state|computation_state)/i.test(text)?'TENANT_FENCE':'OTHER';
 return {category,verb:verbs.has(verb)?verb:'OTHER',template:createHash('sha256').update(normalized).digest('hex')};
}
export function linuxRuntimeStage(stack){
 const text=String(stack??'');
 for(const [label,pattern] of [
  ['WORKER_DRAIN',/\bdrain\b[^\n]*phase4Reanalysis[.]js/],['FRESH_GENERATION',/\bprepareFreshGeneration\b[^\n]*stage8LiveProducer[.]js/],
  ['TENANT_INITIALIZATION',/\binitializeTenant\b[^\n]*(?:phase4Core|phase4Foundation)[.]js/],['ALGORITHM_ROLLOUT',/\brolloutAlgorithm\b[^\n]*phase4Reanalysis[.]js/],
  ['DURABLE_EXECUTION',/\brunBounded\b[^\n]*stage8LiveExecution[.]js/],['CONTEXT_CAPTURE',/\bcapture\b[^\n]*(?:stage8LiveProducer|phase4Core)[.]js/],
  ['PRINCIPAL_READY',/\bready\b[^\n]*stage8LiveProducer[.]js/]])if(pattern.test(text))return label;
 return 'UNCLASSIFIED';
}
export function createLinuxHttpDiagnostics({nowMs=Date.now,maximumGroups=128}={}){
 if(!Number.isSafeInteger(maximumGroups)||maximumGroups<1||maximumGroups>128)throw Error('BOUNDED_SQL_GROUPS_REQUIRED');
 const phases=new Map(),groups=new Map(),pending=new WeakMap();let phase='SETUP',at=nowMs(),overflow=0,open=0,last=null;
 const row=name=>{if(!phases.has(name))phases.set(name,{phase:name,elapsedMs:0,requests:0,attemptedStatements:0,requestErrors:0,httpEnvelopeMs:0});return phases.get(name);};
 row(phase);
 function switchPhase(next){if(!LINUX_HTTP_PHASES.includes(next))throw Error('DIAGNOSTIC_PHASE_INVALID');const now=nowMs();row(phase).elapsedMs+=Math.max(0,now-at);phase=next;at=now;row(next);}
 function start(labels=[],stage='UNCLASSIFIED'){
  if(!stages.includes(stage))stage='UNCLASSIFIED';const token={},entries=[];
  for(const label of labels){if(!verbs.has(label.verb)&&label.verb!=='OTHER'||!/^[a-f0-9]{64}$/.test(label.template??''))throw Error('DIAGNOSTIC_SQL_LABEL_INVALID');entries.push({category:categories.has(label.category)?label.category:'OTHER',verb:label.verb,template:label.template});}
  const state={phase,stage,at:nowMs(),entries};pending.set(token,state);open++;const value=row(phase);value.requests++;value.attemptedStatements+=entries.length;
  last={phase,stage,sql:entries.at(-1)??null,state:'IN_FLIGHT'};return token;
 }
 function end(token,{failed=false}={}){
  const state=pending.get(token);if(!state)throw Error('DIAGNOSTIC_REQUEST_UNKNOWN');pending.delete(token);open--;
  const elapsedMs=Math.max(0,nowMs()-state.at),value=row(state.phase);value.httpEnvelopeMs+=elapsedMs;if(failed)value.requestErrors++;
  // Setup can contain thousands of schema/seed templates. Reserve the entire
  // bounded detail budget for the actual producer leg, while every phase's
  // request/statement/error/time counters above remain complete.
  const unique=new Map();for(const entry of state.phase==='PRODUCER_LEG'?state.entries:[]){const key=[state.phase,state.stage,entry.verb,entry.template].join(':');let count=unique.get(key);if(!count)unique.set(key,count={...entry,statements:0});count.statements++;}
  for(const [key,item]of unique){
   if(!groups.has(key)){if(groups.size>=maximumGroups){overflow+=item.statements;continue;}groups.set(key,{phase:state.phase,stage:state.stage,category:item.category,verb:item.verb,template:item.template,statements:0,envelopes:0,requestErrors:0,envelopeUpperBoundMsSum:0,maximumEnvelopeMs:0});}
   const group=groups.get(key);group.statements+=item.statements;group.envelopes++;if(failed)group.requestErrors++;group.envelopeUpperBoundMsSum+=elapsedMs;group.maximumEnvelopeMs=Math.max(group.maximumEnvelopeMs,elapsedMs);
  }
  last={phase:state.phase,stage:state.stage,sql:state.entries.at(-1)??null,state:failed?'REQUEST_ERROR':'SETTLED',elapsedMs};
 }
 function snapshot(){return {contract:'stage8-safe-http-phase-diagnostics-v1',sqlDetailPhase:'PRODUCER_LEG',phases:[...phases.values()].map(value=>({...value,elapsedMs:value.elapsedMs+(value.phase===phase?Math.max(0,nowMs()-at):0)})),sqlGroups:[...groups.values()].sort((a,b)=>b.statements-a.statements||a.template.localeCompare(b.template)),overflowStatements:overflow,openRequests:open,lastRequest:last,timing:'HTTP envelope upper bounds include injected latency; SQL group durations overlap and are not server SQL timings.'};}
 return Object.freeze({switchPhase,start,end,snapshot});
}
export function linuxDurableCounts(value){
 if(!value)return null;const jobs=value.jobs??[],computation=value.computation??[];
 return {jobs:jobs.length,completedJobs:jobs.filter(row=>row.state==='COMPLETED'&&row.requested_generation===row.completed_generation).length,
  runningJobs:jobs.filter(row=>row.state==='RUNNING').length,pendingJobs:jobs.filter(row=>row.state==='PENDING').length,
  jobsWithCursor:jobs.filter(row=>typeof row.cursorSha256==='string').length,fullScopes:jobs.filter(row=>row.scope_kind==='FULL_TENANT_RECOMPUTE').length,
  currentComputations:computation.filter(row=>row.input_generation===row.last_completed_generation).length,
  completionProofs:value.completionProofs,publications:value.publications,workReceipts:value.workReceipts,operationReceipts:value.operationReceipts,
  executions:(value.executions??[]).reduce((n,row)=>n+Number(row.n),0),
  ...Object.fromEntries(['ESTABLISHED','WORK_COMMITTED','FINALIZED_SUCCESS','FINALIZED_FAILURE'].map(state=>[state,Number(value.executions?.find(row=>row.state===state)?.n??0)]))};
}
