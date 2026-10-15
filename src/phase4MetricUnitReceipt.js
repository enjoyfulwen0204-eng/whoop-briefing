import {analysisTable} from './stage8LiveAllocation.js';
import {currentDurableExecution,assertExecutionWorkOwner,requireSettledOperation} from './phase4ExecutionContext.js';
import {workStepOptions} from './phase4WorkStep.js';
import {bodySha256} from './briefingTriggerAuth.js';
import {AsyncLocalStorage} from 'node:async_hooks';
import {JOB_KINDS} from './phase4V24Schema.js';
import {phase4Metric,INTELLIGENCE_VERSIONS} from './phase4IntelligenceRegistry.js';

const kinds=new Set(['RUN','RUN_START','RUN_COMPLETE','ITEM','AUTHORITY']),proofs=new WeakMap();
const continuationScope=new AsyncLocalStorage();
export function withMetricPreparationContinuation(core,context,work){
 if(![32,33,34,35].includes(core.schemaVersion)||!core.jobAuthority()||currentDurableExecution()?.claim?.request?.phase!=='STAGE6_DRAIN')fail();
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
// The original analyzeMetric domain operation already has its exact v32
// named work receipt. A later owned leg requires that actual receipt and
// sealed finalized producer; the domain row alone cannot complete a family.
export async function metricPreparationDomainReceipt(core,context,operationKey,request){
 if(typeof operationKey!=='string'||!/^[a-f0-9]{64}$/.test(operationKey))fail();
 if(!request?.metricKey||request.refresh!==true||typeof request.windowFamily!=='string'||!request.windowFamily
  ||typeof request.asOfUtc!=='string'||!Number.isFinite(Date.parse(request.asOfUtc)))fail();
 const steps=[workStepOptions('domain.operation',[context.userId,context.executionMode,context.inputGeneration,'analyzeMetric',operationKey]).workStep];
 // Earlier exact v32 workers committed the same domain inside their original
 // stage6.family root. Preserve that authentic completed parent alternative;
 // an unfinalized/unknown-COMMIT family producer still fails the same verifier.
 const family=core.keys.lookup(['episode-family-v1',context.userId,phase4Metric(request.metricKey).domain,request.metricKey,
  INTELLIGENCE_VERSIONS.algorithm,request.metricKey,request.windowFamily]),job=core.jobAuthority();
 for(const kind of JOB_KINDS)steps.push(workStepOptions('stage6.family',[context.userId,context.executionMode,kind,
  job.requestedGeneration,job.scopeRevision,[request.metricKey,request.asOfUtc,family]]).workStep);
 return Boolean(await namedUnitReceipt(core,context,steps));
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
const producerSql=core=>`SELECT p.*,e.state,e.phase,e.generation final_generation,
 e.execution_seq final_seq,e.identity_digest,e.scope_key,e.created_at,e.deadline_at,e.finalized_at,
 e.result_json,e.result_digest,e.release_sha,e.trigger_source,e.config_proof FROM ${analysisTable(core,'phase4_execution_producers')} p
 JOIN ${analysisTable(core,'phase4_executions')} e ON e.execution_id=p.producing_execution_id
 WHERE p.user_id=? AND p.execution_mode=? AND p.input_generation=?
 AND p.producing_execution_id>? COLLATE BINARY
 ORDER BY p.producing_execution_id COLLATE BINARY LIMIT 65`;
function requireUnitPurpose(core,context){
 requireSettledOperation();core.assertAnalysisWrite(context);const execution=currentDurableExecution();
 if(![32,33,34,35].includes(core.schemaVersion)||!core.analysisModeAllowed(context)||!core.jobAuthority()
  ||!execution||execution.receipts===false)fail();
}
async function finishUnitObservation(core,context){
 // Both original non-health observations remain fresh. Settle both and
 // preserve context-before-owner failure priority before any next branch.
 const controls=await Promise.allSettled([
  Promise.resolve().then(()=>core.assertContext(context)),
  Promise.resolve().then(()=>assertExecutionWorkOwner(core.client)),
 ]);
 for(const result of controls)if(result.status==='rejected')throw result.reason;
 requireSettledOperation();
}
// One bounded observation page, never a cached receipt/authority result. The
// existing immutable RAM receiver/publication snapshot owns consistency; every
// page also retains fresh original context and execution-owner checks. Match
// only exact (producer,key) pairs, not a broad tenant work-receipt prefix.
// Seek the existing producer primary key; no chronological prefix rescan or
// schema/index change is needed. Sequence/HMAC validation remains mandatory.
async function* namedObservations(core,context,steps){
 if(!steps.length||steps.length>3)fail();
 let cursor='',count=0,bytes=0;
 for(;;){
  requireUnitPurpose(core,context);
  const rows=(await core.client.execute({sql:producerSql(core),args:[context.userId,context.executionMode,context.inputGeneration,cursor]})).rows;
  if(rows.length>65)fail();const page=rows.slice(0,64),observations=[];
  if(!count&&!page.length)fail();
  for(const p of page){
   if(!Number.isSafeInteger(p.execution_seq)||p.execution_seq<1||typeof p.producing_execution_id!=='string'
    ||Buffer.compare(Buffer.from(p.producing_execution_id),Buffer.from(cursor))<=0)fail();
   cursor=p.producing_execution_id;count++;bytes+=Buffer.byteLength(JSON.stringify(p));
   if(count>16000||bytes>2*1024*1024)fail();
   try{validateProducer(core,context,p);const keys=steps.map(step=>core.keys.lookup(['execution-work-step-v2',p.identity_digest,p.scope_key,['named',step]]));observations.push({status:'fulfilled',p,keys,receipts:[]});}
   catch(reason){observations.push({status:'rejected',reason});}
  }
  const valid=observations.filter(o=>o.status==='fulfilled'),pairs=valid.flatMap(o=>o.keys.map(key=>[o.p.producing_execution_id,key]));
  if(pairs.length){
   try{
    const selected=(await core.client.execute({sql:`WITH expected(execution_id,receipt_key) AS (VALUES ${pairs.map(()=>'(?,?)').join(',')})
     SELECT r.* FROM expected x JOIN ${analysisTable(core,'phase4_execution_producers')} p ON p.producing_execution_id=x.execution_id
      AND p.user_id=? AND p.execution_mode=? AND p.input_generation=?
     JOIN ${analysisTable(core,'phase4_execution_work_receipts')} r ON r.execution_id=x.execution_id AND r.receipt_key=x.receipt_key`,
     args:[...pairs.flat(),context.userId,context.executionMode,context.inputGeneration]})).rows;
    bytes+=Buffer.byteLength(JSON.stringify(selected));if(bytes>2*1024*1024||selected.length>pairs.length)fail();
    for(const r of selected){const o=valid.find(o=>o.p.producing_execution_id===r.execution_id&&o.keys.includes(r.receipt_key));if(!o)fail();o.receipts.push(r);}
   }catch(reason){for(const o of valid){o.status='rejected';o.reason=reason;}}
  }
  yield observations;
  await finishUnitObservation(core,context);
  if(rows.length<=64)return;
 }
}
/** Closed RUN alternatives retain RUN -> START -> COMPLETE failure and
 * short-circuit semantics. Only bounded per-branch booleans/errors survive a
 * page; unused START/COMPLETE errors cannot veto an independently valid RUN. */
async function namedRunReceipt(core,context,plan){
 requireUnitPurpose(core,context);
 const owner=await assertExecutionWorkOwner(core.client);if(owner?.phase!=='STAGE6_DRAIN')fail();
 const steps=['RUN','RUN_START','RUN_COMPLETE'].map(kind=>metricUnitWork(context,plan,kind).workStep),branches=steps.map(()=>({found:false,error:null}));
 for await(const observations of namedObservations(core,context,steps))for(const o of observations)for(let index=0;index<branches.length;index++){
  const branch=branches[index];if(branch.error)continue;
  try{
   if(o.status==='rejected')throw o.reason;
   const {p,keys,receipts}=o;validateProducer(core,context,p);
   if(receipts.length>keys.length||receipts.some(row=>!keys.includes(row.receipt_key)))fail();
   const rows=receipts.filter(row=>row.receipt_key===keys[index]);if(rows.length>1)fail();
   for(const receipt of rows){validateReceipt(core,context,owner,p,receipt,[keys[index]]);branch.found=true;}
  }catch(error){branch.error=error;}
 }
 const branch=index=>{if(branches[index].error)throw branches[index].error;return branches[index].found;};
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
 let found=false;
 for await(const observations of namedObservations(core,context,steps))for(const o of observations){
  if(o.status==='rejected')throw o.reason;
  const {p,keys,receipts}=o;
  if(receipts.length>keys.length)fail();
  for(const receipt of receipts){validateReceipt(core,context,owner,p,receipt,keys);found=true;}
 }
 await finishUnitObservation(core,context);
 if(!found)return null;
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
