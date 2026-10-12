import {currentDurableExecution,assertExecutionWorkOwner,requireSettledOperation} from './phase4ExecutionContext.js';
import {workStepOptions} from './phase4WorkStep.js';
import {bodySha256} from './briefingTriggerAuth.js';
import {AsyncLocalStorage} from 'node:async_hooks';
import {JOB_KINDS} from './phase4V24Schema.js';

const kinds=new Set(['RUN','RUN_START','RUN_COMPLETE','ITEM','AUTHORITY']),proofs=new WeakMap();
const continuationScope=new AsyncLocalStorage();
export function withMetricPreparationContinuation(core,context,work){
 if(core.schemaVersion!==32||!core.jobAuthority()||currentDurableExecution()?.claim?.request?.phase!=='STAGE6_DRAIN')fail();
 return continuationScope.run({core,context,execution:currentDurableExecution(),job:core.jobAuthority()},work);
}
export function metricPreparationContinuation(core,context){
 const scope=continuationScope.getStore();return scope?.core===core&&scope.context===context
  &&scope.execution===currentDurableExecution()&&scope.job===core.jobAuthority();
}
const fail=()=>{throw Object.assign(Error('PHASE4_METRIC_UNIT_RECEIPT_REQUIRED'),{code:'PHASE4_METRIC_UNIT_RECEIPT_REQUIRED'});};
export function metricUnitFacts(context,plan,kind){
 if(!kinds.has(kind))fail();
 return ['metric-preparation-unit-v1',context.userId,context.executionMode,context.inputGeneration,
  context.sourceGeneration,context.lifecycleGeneration,context.authGeneration,context.purgeGeneration,
  context.algorithmSetVersion,context.timezone,plan.runKey,plan.inputHash,plan.itemKey,kind];
}
export function metricUnitWork(context,plan,kind){
 return workStepOptions('stage6.metric-preparation-unit',metricUnitFacts(context,plan,kind),{discardResult:true});
}
/** Existing v32 named work receipts authorize only their exact immutable unit.
 * This is not a producer or execution grant. Every use rechecks the current
 * owner plus the old durable receipt/producer; no observation is cached. */
export async function metricUnitReceipt(core,context,plan,kind){
 const receipt=await namedUnitReceipt(core,context,[metricUnitWork(context,plan,kind).workStep]);
 if(!receipt)return null;
 const proof=Object.freeze({});proofs.set(proof,{core,context,execution:currentDurableExecution(),job:core.jobAuthority(),
  kind,runKey:plan.runKey,inputHash:plan.inputHash,itemKey:plan.itemKey});return proof;
}
export async function metricRunReceipt(core,context,plan){
 if(core.processing.active?.())return namedRunReceipt(core,context,plan);
 if(await metricUnitReceipt(core,context,plan,'RUN'))return true;
 return Boolean(await metricUnitReceipt(core,context,plan,'RUN_START')&&await metricUnitReceipt(core,context,plan,'RUN_COMPLETE'));
}
function validateProducer(core,context,p){
 // Metadata-only reconciliation can finalize a later owner generation. The
 // sealed producer and immutable work receipt retain their producing owner;
 // a still-active producing owner must match the fresh current owner below.
 if(p.phase!=='STAGE6_DRAIN'||p.execution_seq!==p.final_seq
  ||!Number.isSafeInteger(p.producing_generation)||p.producing_generation<1
  ||!Number.isSafeInteger(p.final_generation)||p.final_generation<1||p.producing_generation>p.final_generation
  ||p.tenant_proof!==core.keys.lookup(['execution-producer-v1',context.userId,context.executionMode,
   context.inputGeneration,p.producing_execution_id,p.execution_seq,p.producing_generation]))fail();
}
function validateReceipt(core,context,owner,p,receipt,keys){
 if(!keys.includes(receipt.receipt_key)||receipt.execution_id!==p.producing_execution_id||receipt.step_key!==receipt.receipt_key
  ||receipt.request_digest!==p.identity_digest||receipt.scope_key!==p.scope_key
  ||receipt.generation!==p.producing_generation||receipt.committed_at<p.created_at||receipt.committed_at>p.deadline_at)fail();
 const active=p.producing_execution_id===owner.execution_id&&p.producing_generation===owner.generation
  &&receipt.generation===owner.generation&&p.execution_seq===owner.execution_seq&&p.state==='ESTABLISHED';
 if(!active){
  if(p.state!=='FINALIZED_SUCCESS'||!Number.isSafeInteger(p.finalized_at)
   ||p.finalized_at<receipt.committed_at||p.finalized_at>p.deadline_at
   ||typeof p.result_json!=='string'||bodySha256(p.result_json)!==p.result_digest)fail();
  let record;try{record=JSON.parse(p.result_json);}catch{fail();}
  if(record.identity!==p.identity_digest||record.phase!=='STAGE6_DRAIN'||record.releaseSha!==p.release_sha
   ||record.source!==p.trigger_source||record.configProof!==p.config_proof||record.executionMode!==context.executionMode
   ||!['COMPLETE','PARTIAL','NO_WORK','NO_ELIGIBLE_WORK','BUDGET_EXHAUSTED','DISABLED','POLICY_DEFERRED'].includes(record.outcome))fail();
 }
}
const producerSql=`SELECT p.*,e.state,e.phase,e.generation final_generation,
 e.execution_seq final_seq,e.identity_digest,e.scope_key,e.created_at,e.deadline_at,e.finalized_at,
 e.result_json,e.result_digest,e.release_sha,e.trigger_source,e.config_proof FROM phase4_execution_producers p
 JOIN phase4_executions e ON e.execution_id=p.producing_execution_id
 WHERE p.user_id=? AND p.execution_mode=? AND p.input_generation=? ORDER BY p.execution_seq LIMIT 129`;
function requireUnitPurpose(core,context){
 requireSettledOperation();const execution=currentDurableExecution();
 if(core.schemaVersion!==32||context.executionMode!=='SHADOW'||!core.jobAuthority()
  ||!execution||execution.receipts===false)fail();
}
async function finishUnitObservation(core,context){
 await core.assertContext(context);await assertExecutionWorkOwner(core.client);requireSettledOperation();
}
/** A closed RUN alternative observation, inside the same original owned unit.
 * Fetch only the three exact named keys once; compare RUN, then START, then
 * COMPLETE in the original short-circuit order. Raw rows never leave this
 * call and no accepted producer/owner observation survives another operation. */
async function namedRunReceipt(core,context,plan){
 requireUnitPurpose(core,context);
 const owner=await assertExecutionWorkOwner(core.client);if(owner?.phase!=='STAGE6_DRAIN')fail();
 const producers=(await core.client.execute({sql:producerSql,args:[context.userId,context.executionMode,context.inputGeneration]})).rows;
 if(!producers.length||producers.length>128)fail();
 const steps=['RUN','RUN_START','RUN_COMPLETE'].map(kind=>metricUnitWork(context,plan,kind).workStep),observed=[];
 for(let start=0;start<producers.length;start+=64){
  const group=producers.slice(start,start+64),values=await Promise.allSettled(group.map(p=>Promise.resolve().then(async()=>{
   validateProducer(core,context,p);
   const keys=steps.map(step=>core.keys.lookup(['execution-work-step-v2',p.identity_digest,p.scope_key,['named',step]]));
   const receipts=(await core.client.execute({sql:`SELECT * FROM phase4_execution_work_receipts WHERE execution_id=? AND receipt_key IN (?,?,?)`,
    args:[p.producing_execution_id,...keys]})).rows;
   return {p,keys,receipts};
  })));
  observed.push(...values);
 }
 const branch=index=>{
  let found=false;
  for(const value of observed){
   if(value.status==='rejected')throw value.reason;
   const {p,keys,receipts}=value.value;validateProducer(core,context,p);
   if(receipts.length>keys.length||receipts.some(row=>!keys.includes(row.receipt_key)))fail();
   const rows=receipts.filter(row=>row.receipt_key===keys[index]);if(rows.length>1)fail();
   for(const receipt of rows){validateReceipt(core,context,owner,p,receipt,[keys[index]]);found=true;}
  }
  return found;
 };
 // Even an absent branch retains its original post-observation freshness.
 const whole=branch(0);await finishUnitObservation(core,context);if(whole)return true;
 const started=branch(1);await finishUnitObservation(core,context);if(!started)return false;
 const completed=branch(2);await finishUnitObservation(core,context);return completed;
}
export async function currentBodySourceReceipt(core,context,asOfUtc){
 const job=core.jobAuthority();
 if(!job||job.userId!==context.userId||job.executionMode!==context.executionMode||job.requestedGeneration!==context.inputGeneration
  ||job.sourceGeneration!==context.sourceGeneration||job.lifecycleGeneration!==context.lifecycleGeneration
  ||job.authGeneration!==context.authGeneration||job.purgeGeneration!==context.purgeGeneration
  ||job.algorithmSetVersion!==context.algorithmSetVersion)fail();
 const {computation}=await core.assertContext(context);
 if(asOfUtc!==computation.updated_at)fail();
 // Both original named jobs can consume the same committed Body source. Its
 // receipt proves only this source subunit; the current job retains its own
 // freshly checked lease and still must finish every required family/cursor.
 const steps=JOB_KINDS.map(kind=>workStepOptions('stage6.body-source',[context.userId,context.executionMode,kind,job.requestedGeneration,
  job.scopeRevision,['USER',context.userId,JSON.stringify(['USER',context.userId]),asOfUtc]],{discardResult:true}).workStep);
 return namedUnitReceipt(core,context,steps);
}
async function namedUnitReceipt(core,context,steps){
 requireUnitPurpose(core,context);
 const owner=await assertExecutionWorkOwner(core.client);if(owner?.phase!=='STAGE6_DRAIN')fail();
 const producers=(await core.client.execute({sql:producerSql,
  args:[context.userId,context.executionMode,context.inputGeneration]})).rows;
 if(!producers.length||producers.length>128)fail();
 const found=[];
 for(let start=0;start<producers.length;start+=64){
  const group=producers.slice(start,start+64),observations=await Promise.allSettled(group.map(p=>Promise.resolve().then(async()=>{
   validateProducer(core,context,p);
   const keys=steps.map(step=>core.keys.lookup(['execution-work-step-v2',p.identity_digest,p.scope_key,['named',step]]));
   const receipts=(await core.client.execute({sql:keys.length===1
    ?'SELECT * FROM phase4_execution_work_receipts WHERE execution_id=? AND receipt_key=?'
    :`SELECT * FROM phase4_execution_work_receipts WHERE execution_id=? AND receipt_key IN (${keys.map(()=>'?').join(',')})`,
    args:[p.producing_execution_id,...keys]})).rows;
   if(!receipts.length)return null;if(receipts.length>keys.length)fail();
   for(const receipt of receipts){
   validateReceipt(core,context,owner,p,receipt,keys);
   }
   return true;
  })));
  for(const value of observations){if(value.status==='rejected')throw value.reason;if(value.value)found.push(value.value);}
 }
 await finishUnitObservation(core,context);
 if(!found.length)return null;
 // Multiple actual executions may independently verify the same unit, but
 // all receipts remain bound to their own original producer/generation.
 return true;
}
export function requireMetricUnitProof(core,context,proof,plan,kind){
 const issued=proofs.get(proof);
 if(!issued||issued.core!==core||issued.context!==context||issued.execution!==currentDurableExecution()
  ||issued.job!==core.jobAuthority()||issued.kind!==kind||issued.runKey!==plan.runKey
  ||issued.inputHash!==plan.inputHash||issued.itemKey!==plan.itemKey)fail();
 requireSettledOperation();currentDurableExecution().authority.assert();return true;
}
