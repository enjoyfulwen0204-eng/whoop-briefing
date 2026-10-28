import {registerReceiverScopes,shareReceiverScopes} from './receiverScopeLifetime.js';
import {currentExecutionBudget} from './executionBudget.js';
import {hasLiveProducingAuthority,isLiveExecution} from './stage8LiveProducerAuthority.js';
import {LIVE_HEALTH_FIELDS} from './stage8LiveAllocation.js';
import {allowsStage8LiveAuthority} from './stage8LiveAuthority.js';
import {assertFreshContextAndWorkOwner} from './phase4ReadControls.js';
import {assertRegisteredJournalProvenance} from './stage7JournalProvenance.js';
import {readOnlyProcessingCheck,processingSourceControlStatement} from './processingTransaction.js';
import {workStepOptions} from './phase4WorkStep.js';
import {coalescibleControlProcessingCheck,controlOnlyProcessingCheck,processingReadObservationEpoch,processingOwnedLiveObservationEpoch} from './processingTransaction.js';
import { compareExact } from './phase4CanonicalOrder.js';
import {readPilotSourceLinkRows,pilotPrefixFrom} from './betaPilotBoundedReads.js';
import { coverageLineage } from './phase4CoverageLineage.js';
/** Internal persistence kernel. No application entry point imports this module
 * directly. The public Foundation factory supplies SHADOW-only authority;
 * isolated tests supply a distinct factory that owns its in-memory database. */
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import {currentDurableExecution,currentExecutionReceiptTransactionMarker,assertExecutionWorkOwner,requireSettledOperation} from './phase4ExecutionContext.js';
import {READ_SNAPSHOT_LIMITS} from './processingReadSnapshot.js';
import {requireOwnedBodyMetricPurpose,currentOwnedBodyMetricObservation} from './phase4IntelligenceStore.js';
import {requireOwnedCurrentBodyData} from './phase4OperationReceipts.js';
import { assertPhase4Schema } from './phase4Migrations.js';
import { requirePhase4Keys } from './phase4Keys.js';
import { requireUserId } from './userContext.js';
import {addPrivacyLinks} from './phase4V22Backfill.js';
import { V23_TABLES } from './phase4V23Schema.js';
import { V27_TABLES } from './phase4V27Schema.js';
import { V26_TABLES } from './phase4V26Schema.js';
import { V25_TABLES } from './phase4V25Schema.js';
import { V24_TABLES } from './phase4V24Schema.js';
import { createPhase4ContextRegistry } from './phase4Cache.js';
import { requireRuntimeAdmission, admitRuntime, followRuntimeRenewal } from './runtimeAdmission.js';

export class Phase4InvariantError extends Error {
  constructor(code) { super(code); this.name='Phase4InvariantError'; this.code=code; }
}
export const fail = code => { throw new Phase4InvariantError(code); };
export const requireInteger = (value, minimum=0) => {
  if(!Number.isSafeInteger(value) || value<minimum)fail('PHASE4_INVALID_INTEGER');
  return value;
};
export const readableRow = row => Boolean(row && row.content_state==='PRESENT'
  && row.source_linkage_state==='COMPLETE' && row.health_content_redacted_at===null);
// Finite in-flight raw observations for the complete original 30-day Body
// graph. This controls transport overlap only, never semantic input limits.
export const RAW_SOURCE_READ_BATCH=64;
export const DERIVED_TABLES = Object.freeze(['context_questions','structured_answer_events',...V23_TABLES,'health_insights',...V24_TABLES,...V25_TABLES,...V26_TABLES,...V27_TABLES,...Object.keys(LIVE_HEALTH_FIELDS),'morning_brief_plans']);
const ROOTS = Object.freeze({
  sleep:['whoop_sleeps','id'],recovery:['whoop_recoveries','sleep_id'],cycle:['whoop_cycles','id'],workout:['whoop_workouts','id'],
  JOURNAL_FACT:['journal_events','privacy_artifact_id'],JOURNAL_COVERAGE:['journal_coverage_windows','coverage_window_id'],
  EXPERIMENT_DIRECT_ASSERTION:['experiment_field_groups','assertion_id'],TELEGRAM_OPERATION:['telegram_operations','update_id'],
});

// Pure data comparison shared by generic roots and the closed read purpose.
function compareRootObservation(context,type,id,values){
  if(values[0].status==='rejected')throw values[0].reason;
  const row=type==='USER'?values[0].value:values[0].value.rows[0];
  if(type==='USER'){if(id!==context.userId)fail('PHASE4_CROSS_TENANT_REFERENCE');return row;}
  if(!row)fail('PHASE4_SOURCE_NOT_FOUND');
  if(context.authGeneration<1)fail('PHASE4_AUTH_FENCED');
  if(values[1].status==='rejected')throw values[1].reason;
  if(values[1].value.rows[0]?.status!=='ACCESSIBLE')fail('PHASE4_RESOURCE_FENCED');
  if(values[2].status==='rejected')throw values[2].reason;
  if(values[2].value.rows.length)fail('PHASE4_CAPABILITY_FENCED');
  if(values[3].status==='rejected')throw values[3].reason;
  if(values[3].value.rows.length)fail('PHASE4_SOURCE_DELETED');return row;
}

/** Server-owned context and source references are branded within this instance.
 * A JSON object, a context from another connection, or a changed mode is not a
 * capability. Authority is supplied only by the owning server/fixture factory. */
export async function buildPhase4Core({processing,keys,admission,authorizeMode:modeAuthority,liveAuthority,liveProducingAuthority,now=()=>new Date()}) {
  const jobScope=new AsyncLocalStorage(),terminalControlChecks=new WeakMap(),readerControlChecks=new WeakMap();
  requirePhase4Keys(keys);
  if(typeof modeAuthority!=='function' || typeof processing?.transaction!=='function')fail('PHASE4_SERVER_FACTORY_REQUIRED');
  const {client,transaction}=processing;registerReceiverScopes(client,jobScope);
  // The frozen Stage 5 composition remains usable on v27. A Stage 6 worker
  // must separately require v28; unsupported versions still fail closed.
  const schemaVersion=admission ? requireRuntimeAdmission(client,admission,keys,transaction)
    :Number((await client.execute('SELECT MAX(version) v FROM schema_version')).rows[0]?.v);
  if(![27,28,29,30,31,32,33,34,35].includes(schemaVersion))fail('phase4_schema_version_mismatch');
  if (!admission && [32,33,34,35].includes(schemaVersion)) admission=await admitRuntime(client,keys);
  if (!admission) await assertPhase4Schema(client,schemaVersion);
  if(admission)followRuntimeRenewal(client,admission,keys,transaction,next=>{admission=next;});
  const databases=(await client.execute('PRAGMA database_list')).rows;
  const isolatedMemory=client.protocol==='file'&&databases.some(r=>r.name==='main')&&databases.every(r=>['main','temp'].includes(r.name)&&r.file==='');
  function authorizeMode(mode,connection,userId) {
    if(admission)requireRuntimeAdmission(client,admission,keys,transaction);
    if(mode==='LIVE'&&liveProducingAuthority&&!hasLiveProducingAuthority(liveProducingAuthority,client,keys,userId))fail('PHASE4_LIVE_FIXTURE_MEMORY_REQUIRED');
    if(mode==='LIVE'&&!isolatedMemory&&!allowsStage8LiveAuthority(liveAuthority,client,keys,userId)&&!hasLiveProducingAuthority(liveProducingAuthority,client,keys,userId))fail('PHASE4_LIVE_FIXTURE_MEMORY_REQUIRED');
    return modeAuthority(mode,connection,userId);
  }
  if (!admission) {
  const keyCheck=(await client.execute("SELECT last_cursor FROM phase4_migration_checkpoints WHERE target_version=22 AND step_key='lookup_key_check'")).rows[0];
  if(!keys.verifyLookupCheckpoint(keyCheck?.last_cursor))fail('PHASE4_LOOKUP_KEY_MISMATCH');
  const auditCheck=(await client.execute("SELECT last_cursor FROM phase4_migration_checkpoints WHERE target_version=22 AND step_key='audit_key_check'")).rows[0];
  if(!keys.verifyAuditCheckpoint(auditCheck?.last_cursor))fail('PHASE4_AUDIT_KEY_MISMATCH');
  }
  const liveAllocation=schemaVersion===35&&Boolean(liveAuthority||hasLiveProducingAuthority(liveProducingAuthority,client,keys));
  const analysisModeAllowed=context=>context.executionMode==='SHADOW'&&!liveAllocation
    ||context.executionMode==='LIVE'&&liveAllocation;
  function assertAnalysisWrite(context){
    if(!analysisModeAllowed(context)||context.executionMode==='LIVE'&&(!hasLiveProducingAuthority(liveProducingAuthority,client,keys)
      ||!isLiveExecution(currentDurableExecution(),client,keys,context.userId,context)))fail('PHASE4_INTELLIGENCE_SHADOW_ONLY');
  }
  const rootObservations=new WeakMap(),ownedEvidenceData=new WeakMap(),ownedMetricUnions=new WeakMap();
  const contexts=new WeakSet(),controls=new WeakSet(),privacyControls=new WeakSet(),sources=new WeakMap(),columns=new Map();
  const timestamp=()=>{const value=now();if(!(value instanceof Date) || !Number.isFinite(value.getTime()))fail('PHASE4_INVALID_CLOCK');return value.toISOString();};
  const contextRegistry=createPhase4ContextRegistry({client,keys,now,timestamp,newId:()=>randomUUID()});
  async function userState(userId) {
    const uid=requireUserId(userId,'phase4');
    const row=(await client.execute({sql:`SELECT u.id,u.status,u.timezone,u.lifecycle_generation,
      COALESCE(t.auth_generation,0) auth_generation,p.source_generation,p.purge_generation,p.pending_purge_count
      FROM users u LEFT JOIN user_whoop_tokens t ON t.user_id=u.id
      LEFT JOIN phase4_user_state p ON p.user_id=u.id WHERE u.id=?`,args:[uid]})).rows[0];
    if(!row)fail('PHASE4_TENANT_NOT_FOUND');
    return row;
  }
  async function initializeTenant(userId,mode) {
    authorizeMode(mode,client,userId);
    const uid=requireUserId(userId,'phase4');
    return transaction(async()=>{
      const user=await userState(uid),at=timestamp();
      if(user.status!=='ACTIVE')fail('PHASE4_LIFECYCLE_FENCED');
      await client.execute({sql:`INSERT INTO phase4_user_state(user_id,created_at,updated_at) VALUES (?,?,?) ON CONFLICT DO NOTHING`,args:[uid,at,at]});
      const current=await userState(uid);
      if(current.pending_purge_count!==0)fail('PHASE4_PURGE_PENDING');
      const inserted=await client.execute({sql:`INSERT INTO phase4_computation_state
        (user_id,execution_mode,input_generation,source_generation_seen,algorithm_set_version,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`,args:[uid,mode,mode==='LIVE'?1:0,current.source_generation,'phase4-foundation-v1',at,at]});
      const stored=(await client.execute({sql:'SELECT input_generation FROM phase4_computation_state WHERE user_id=? AND execution_mode=?',args:[uid,mode]})).rows[0];
      return {created:inserted.rowsAffected===1,mode,inputGeneration:stored.input_generation};
    },workStepOptions('tenant.initialize',[uid,mode],{discardResult:true}));
  }
  async function capture(userId,{executionMode,providerRequired=false}={}) {
    // Missing mode is an error despite the SQL default. Never infer LIVE from a
    // payload, flag, prior row or destination binding.
    if(!['SHADOW','LIVE'].includes(executionMode))fail('PHASE4_EXECUTION_MODE_REQUIRED');
    authorizeMode(executionMode,client,userId);
    const uid=requireUserId(userId,'phase4');
    return transaction(async()=>{
      const observed=await Promise.allSettled([Promise.resolve().then(()=>userState(uid)),Promise.resolve().then(()=>
        client.execute({sql:'SELECT * FROM phase4_computation_state WHERE user_id=? AND execution_mode=?',args:[uid,executionMode]}))]);
      if(observed[0].status==='rejected')throw observed[0].reason;
      const state=observed[0].value;
      if(state.purge_generation===null)fail('PHASE4_TENANT_STATE_MISSING');
      if(observed[1].status==='rejected')throw observed[1].reason;
      const computation=observed[1].value.rows[0];
      if(!computation)fail('PHASE4_COMPUTATION_STATE_MISSING');
      const context=Object.freeze({userId:uid,executionMode,lifecycleGeneration:state.lifecycle_generation,
        authGeneration:state.auth_generation,inputGeneration:computation.input_generation,purgeGeneration:state.purge_generation,
        sourceGeneration:state.source_generation,timezone:state.timezone,providerRequired:Boolean(providerRequired),
        algorithmSetVersion:computation.algorithm_set_version});
      contexts.add(context);await contextRegistry.register(context);await assertContext(context);return context;
    },{readOnly:true});
  }
  async function assertContext(context,{allowPurge=false,allowInactive=false,ignoreInput=false}={}) {
    if(!contexts.has(context))fail('PHASE4_SERVER_CONTEXT_REQUIRED');
    authorizeMode(context.executionMode,client,context.userId);
    try {
    // The brand remains first; all three non-health metadata observations use
    // the same owned transaction and settle before any source/business work.
    // Preserve lease-first failure priority and every original comparison.
    const observations=await Promise.allSettled([Promise.resolve().then(()=>contextRegistry.assertLease(context)),
      Promise.resolve().then(()=>userState(context.userId)),Promise.resolve().then(()=>client.execute({
      sql:'SELECT * FROM phase4_computation_state WHERE user_id=? AND execution_mode=?',args:[context.userId,context.executionMode]}))]);
    if(observations[0].status==='rejected')throw observations[0].reason;
    if(observations[1].status==='rejected')throw observations[1].reason;
    const state=observations[1].value;
    if(state.purge_generation===null || state.pending_purge_count===null)fail('PHASE4_PRIVACY_STATE_MISSING');
    if(!allowPurge && (state.pending_purge_count!==0 || state.purge_generation!==context.purgeGeneration))fail('PHASE4_PURGE_FENCED');
    if(!allowInactive && (state.status!=='ACTIVE' || state.lifecycle_generation!==context.lifecycleGeneration))fail('PHASE4_LIFECYCLE_FENCED');
    if(state.timezone!==context.timezone)fail('PHASE4_TIMEZONE_FENCED');
    if(state.auth_generation!==context.authGeneration || (context.providerRequired && state.auth_generation<1))fail('PHASE4_AUTH_FENCED');
    if(observations[2].status==='rejected')throw observations[2].reason;
    const current=observations[2].value.rows[0];
    if(!current || (!ignoreInput && (current.input_generation!==context.inputGeneration
      || current.source_generation_seen!==state.source_generation||state.source_generation!==context.sourceGeneration
      || current.algorithm_set_version!==context.algorithmSetVersion)))fail('PHASE4_INPUT_FENCED');
    return {state,computation:current};
    } catch(error) {contextRegistry.clear(context);throw error;}
  }
  // Shared source/privacy control is a separate authenticated purpose, never a
  // SHADOW context promoted into authority over real Journal/receipt roots.
  async function captureControl(userId) {
    const state=await userState(userId);
    if(state.status!=='ACTIVE')fail('PHASE4_LIFECYCLE_FENCED');
    const control=Object.freeze({userId:String(state.id),lifecycleGeneration:state.lifecycle_generation,authGeneration:state.auth_generation});
    controls.add(control);return control;
  }
  async function assertControl(control) {
    if(!controls.has(control))fail('PHASE4_SOURCE_CONTROL_REQUIRED');
    const state=await userState(control.userId);
    if(state.status!=='ACTIVE' || state.lifecycle_generation!==control.lifecycleGeneration)fail('PHASE4_LIFECYCLE_FENCED');
    if(state.auth_generation!==control.authGeneration)fail('PHASE4_AUTH_FENCED');
    return state;
  }
  // Privacy cleanup is not permission to read health data or create new
  // assertions. It must remain possible after logout/disable while a durable
  // purge fence is pending. Identity still comes from the server factory.
  async function capturePrivacyControl(userId) {
    const state=await userState(userId);
    const control=Object.freeze({userId:String(state.id),purpose:'PRIVACY_CLEANUP'});
    privacyControls.add(control);return control;
  }
  async function assertPrivacyControl(control) {
    if(!controls.has(control)&&!privacyControls.has(control))fail('PHASE4_PRIVACY_CONTROL_REQUIRED');
    return userState(control.userId);
  }
  async function run(context,fn,options={}) {
    const job=jobScope.getStore();
    // Intern an identical LIVE producer control callback, never its result.
    // Every nested before-check and the fresh original terminal/COMMIT checks
    // still run; one owned unit need not enqueue hundreds of identical tips.
    const defaultControl=['allowPurge','allowInactive','ignoreInput'].every(key=>options[key]===undefined||options[key]===false);
    const coalescibleJob=job&&(schemaVersion===32&&context.executionMode==='SHADOW'
      ||schemaVersion===35&&liveAllocation&&context.executionMode==='LIVE'&&context.providerRequired
        &&isLiveExecution(currentDurableExecution(),client,keys,context.userId,context))
      &&currentDurableExecution()?.claim?.request?.phase==='STAGE6_DRAIN'
      &&defaultControl;
    // A canonical LIVE reader has no execution or job permission. Intern only
    // its identical non-health control callback within this original root.
    // Every nested entry and the fresh final runtime/context/lease check still
    // execute. No successful guard, artifact or publication proof is cached.
    const execution=currentDurableExecution(),budget=currentExecutionBudget(),marker=currentExecutionReceiptTransactionMarker(),
      coalescibleReader=!job&&!execution&&marker&&processing.active?.()&&schemaVersion===35&&liveAllocation
        &&context.executionMode==='LIVE'&&context.providerRequired&&defaultControl
        &&options.workStep===undefined&&options.workStepFrom===undefined
        &&allowsStage8LiveAuthority(liveAuthority,client,keys,context.userId),coalescible=coalescibleJob||coalescibleReader;
    const prior=coalescibleJob?terminalControlChecks.get(context)?.get(job.check):coalescibleReader?readerControlChecks.get(context):null;
    const cached=prior&&prior.execution===execution&&prior.budget===budget&&(!coalescibleReader||prior.marker===marker)?prior.check:null;
    const controlOptions=coalescible?Object.freeze({allowPurge:false,allowInactive:false,ignoreInput:false}):options;
    const check=cached??controlOnlyProcessingCheck(async()=>{
      // Explicitly bracket coalesced metadata checks with their enclosing
      // runtime guards: read-only checking suppresses recursive interception,
      // but must retain fresh permit/configuration checks before and after.
      // These checks inspect only independent non-health control metadata.
      // Settle all three in the owned transaction, preserve runtime/context/
      // job failure priority, and pass the fresh final runtime bracket before
      // the health callback or any mutation/COMMIT can proceed.
      const observations=await Promise.allSettled([
        Promise.resolve().then(()=>processing.assertFences?.()),
        Promise.resolve().then(()=>assertContext(context,controlOptions)),
        ...(job?[Promise.resolve().then(()=>job.check(context))]:[]),
      ]);
      for(const result of observations)if(result.status==='rejected')throw result.reason;
      await processing.assertFences?.();
    });
    if(coalescible&&!cached){coalescibleControlProcessingCheck(check);
      if(coalescibleJob){const checks=terminalControlChecks.get(context)??new WeakMap();checks.set(job.check,{check,execution,budget});terminalControlChecks.set(context,checks);}
      else readerControlChecks.set(context,{check,execution,budget,marker});}
    const work=()=>transaction(()=>fn(context),{readOnly:options.workStep===undefined&&options.workStepFrom===undefined,...options,before:check,after:check,...(job?{commitFence:check}:{})});
    return processing.withReadSnapshot?processing.withReadSnapshot(context,work):work();
  }
  async function runControl(control,mode,fn) {
    if(!['SHADOW','LIVE'].includes(mode))fail('PHASE4_EXECUTION_MODE_REQUIRED');
    authorizeMode(mode,client,control.userId);
    return transaction(async()=>{await assertControl(control);const result=await fn();await assertControl(control);return result;});
  }
  async function runMaintenance(control,mode,fn) {
    if(!['SHADOW','LIVE'].includes(mode))fail('PHASE4_EXECUTION_MODE_REQUIRED');
    authorizeMode(mode,client,control.userId);
    return transaction(async()=>{await assertPrivacyControl(control);return fn();});
  }
  async function tableInfo(table) {
    if(!DERIVED_TABLES.includes(table) && !Object.values(ROOTS).some(([t])=>t===table))fail('PHASE4_UNKNOWN_ENTITY');
    if(!columns.has(table))columns.set(table,(await client.execute(`PRAGMA table_info(${table})`)).rows);
    return columns.get(table);
  }
  function reference(context,type,id,mode,row,{historicalAsOf=null}={}) {
    const ref=Object.freeze({type,id:String(id),executionMode:mode});
    const snapshotKey=row===null?null:['source-snapshot-v1',randomUUID()];
    if(snapshotKey)contextRegistry.set(context,snapshotKey,row);
    sources.set(ref,{context,type,id:String(id),mode,snapshotKey,historicalAsOf});return ref;
  }
  function validateReferences(context,refs) {
    if(!Array.isArray(refs))fail('PHASE4_SOURCE_REFERENCES_REQUIRED');
    return refs.map(ref=>{
      const source=sources.get(ref);
      if(!source || source.context!==context || (source.mode!=='SHARED' && source.mode!==context.executionMode))fail('PHASE4_INVALID_SOURCE_REFERENCE');
      const row=source.snapshotKey?contextRegistry.get(context,source.snapshotKey):null;
      if(source.snapshotKey&&!row)fail('PHASE4_SOURCE_SNAPSHOT_EVICTED');
      return {...source,row};
    });
  }
  async function root(context,type,id) {
    return run(context,async()=>{
      if(type==='USER') {
        if(id!==context.userId)fail('PHASE4_CROSS_TENANT_REFERENCE');
        const row=await userState(context.userId),result={row,ref:reference(context,type,id,'SHARED',null)};
        if(processing.active?.())rootObservations.set(result,{context,type,id:String(id),values:[{status:'fulfilled',value:row}],
          execution:currentDurableExecution(),job:jobScope.getStore(),marker:currentExecutionReceiptTransactionMarker(),epoch:processingReadObservationEpoch(client)});
        return result;
      }
      const spec=ROOTS[type];if(!spec)fail('PHASE4_ROOT_TYPE_REQUIRED');
      const [table,key]=spec,owner=type==='TELEGRAM_OPERATION'?'owner_user_id':'user_id';
      const whoop=['sleep','recovery','cycle','workout'].includes(type);
      // The enclosing Core check has already admitted context/runtime before
      // this health callback. Observe the canonical row and its independent
      // resource controls together; every execute keeps its original fresh
      // runtime fence, and source/access/capability/tombstone priority remains.
      const calls=[()=>client.execute({sql:`SELECT * FROM ${table} WHERE ${owner}=? AND ${key}=?`,args:[context.userId,id]})];
      if(whoop&&context.authGeneration>=1)calls.push(
          ()=>client.execute(processingSourceControlStatement(client,context,{sql:`SELECT status FROM whoop_resource_access
          WHERE user_id=? AND resource=? AND auth_generation=? AND lifecycle_generation=?`,
            args:[context.userId,type,context.authGeneration,context.lifecycleGeneration]})),
          ()=>client.execute(processingSourceControlStatement(client,context,{sql:`SELECT 1 FROM whoop_capabilities
            WHERE user_id=? AND key=? AND lifecycle_generation=? AND status IN ('UNSUPPORTED','UNAVAILABLE')`,
            args:[context.userId,type,context.lifecycleGeneration]})),
          ()=>client.execute(processingSourceControlStatement(client,context,{sql:`SELECT 1 FROM whoop_resource_tombstones
            WHERE user_id=? AND resource_type=? AND resource_id=? AND state='ACTIVE'`,args:[context.userId,type,String(id)]})),
      );
      const values=await Promise.allSettled(calls.map(call=>Promise.resolve().then(call)));
      if(values[0].status==='rejected')throw values[0].reason;
      const row=values[0].value.rows[0];if(!row)fail('PHASE4_SOURCE_NOT_FOUND');
      if(whoop) {
        compareRootObservation(context,type,String(id),values);
      } else {
        if(!readableRow(row))fail('CONTENT_REDACTED');
        if(type==='JOURNAL_FACT'){if(row.fact_status!=='ACTIVE')fail('PHASE4_SOURCE_NOT_CURRENT');assertRegisteredJournalProvenance(row);}
        if(type==='JOURNAL_COVERAGE') {
          if(row.status!=='ACTIVE')fail('PHASE4_SOURCE_NOT_CURRENT');
          await coverageLineage(client,context.userId,id);
        }
        if(type==='EXPERIMENT_DIRECT_ASSERTION' && (row.is_current!==1 || row.provenance_state!=='DIRECT'
          || row.source_kind!=='EXPERIMENT_DIRECT_ASSERTION'))fail('PHASE4_UNPROVEN_ASSERTION');
      }
      // A nested Core after-check also belongs to its parent's COMMIT. Keep
      // an immediate fresh runtime bracket here so revocation while these
      // reads settle cannot expose the source to the next business callback.
      await processing.assertFences?.();
      const result={row:{...row},ref:reference(context,type,id,'SHARED',row)};
      if(whoop&&processing.active?.())rootObservations.set(result,{context,type,id:String(id),values,
        execution:currentDurableExecution(),job:jobScope.getStore(),marker:currentExecutionReceiptTransactionMarker(),
        epoch:processingReadObservationEpoch(client)});
      return result;
    });
  }
  function copyOwnedRootObservation(context,result){
    const value=rootObservations.get(result);
    if(!value||value.context!==context||value.execution!==currentDurableExecution()||value.job!==jobScope.getStore()
      ||!value.marker||value.marker!==currentExecutionReceiptTransactionMarker()||value.epoch===null
      ||value.epoch!==processingReadObservationEpoch(client))fail('PHASE4_METRIC_PREPARATION_CAPTURE_REQUIRED');
    return {type:value.type,id:value.id,values:value.values.map(result=>result.status==='rejected'
      ?{status:'rejected',reason:result.reason}:{status:'fulfilled',value:value.type==='USER'?{...result.value}:
        {rows:result.value.rows.map(row=>({...row}))}})};
  }
  // Closed selected DOMAIN raw Source observations. This never returns a
  // reference or accepted authority and cannot select arbitrary SQL/roots.
  function ownedBodyMetricRootData(context,type,id){
    const selected=currentOwnedBodyMetricObservation(core,context);
    if(!selected||!['sleep','recovery','cycle','workout','USER'].includes(type))return null;
    const source=requireOwnedCurrentBodyData(core,context,selected.request.currentSource),
      data=source.rawRoots.get(JSON.stringify([type,String(id)]));
    if(!data)return null;
    return {row:{...compareRootObservation(context,type,String(id),data.values)}};
  }
  function ownedEvidenceFrame(context){
    const selected=currentOwnedBodyMetricObservation(core,context);if(!selected)return null;
    let frame=ownedEvidenceData.get(selected);
    if(!frame){
      const source=requireOwnedCurrentBodyData(core,context,selected.request.currentSource);
      const bytes=Buffer.byteLength(JSON.stringify([source.row,source.receipt,source.contracts,source.schemas,source.actual,[...source.rawRoots.values()]]));
      if(bytes>READ_SNAPSHOT_LIMITS.bytes)return null;
      frame={selected,epoch:processingReadObservationEpoch(client),rows:new Map(),links:new Map(),bytes};ownedEvidenceData.set(selected,frame);
    }
    if(frame.epoch!==processingReadObservationEpoch(client))return null;return frame;
  }
  function retainOwnedEvidenceData(frame,map,key,value){
    const copy=JSON.parse(JSON.stringify(value));frame.bytes+=Buffer.byteLength(JSON.stringify(copy));
    if(frame.bytes>READ_SNAPSHOT_LIMITS.bytes)fail('PHASE4_REQUIRED_ROOT_BOUNDS_UNAVAILABLE');map.set(key,copy);return copy;
  }
  async function ownedArtifactRow(context,frame,table,key){
    const identity=JSON.stringify([table,key]);
    if(frame.rows.has(identity))return frame.rows.get(identity);
    const columns=Object.keys(key),row=(await client.execute({sql:`SELECT * FROM ${table} WHERE user_id=? AND execution_mode=?${columns.map(column=>` AND ${column}=?`).join('')}`,
      args:[context.userId,context.executionMode,...columns.map(column=>key[column])]})).rows[0];
    return retainOwnedEvidenceData(frame,frame.rows,identity,row??null);
  }
  function ownedDefaultArtifact(context,frame,table,row){
    if(table==='body_energy_results')return row.privacy_artifact_id===frame.selected.currentBody.row.privacy_artifact_id;
    if(table==='evidence_runs')return row.run_id===frame.selected.runId&&row.deterministic_run_key===frame.selected.runKey;
    if(table==='evidence_items')return row.evidence_item_id===frame.selected.itemId&&row.run_id===frame.selected.runId&&row.item_key===frame.selected.itemKey;
    return false;
  }
  async function ownedDefaultGraph(context,frame,table,row,path=new Set(),verified=new Set()){
    const identity=JSON.stringify([table,row.privacy_artifact_id]);
    if(path.has(identity)||path.size>128||verified.size>10000)fail('PHASE4_PROVENANCE_CYCLE');
    if(verified.has(identity))return true;path.add(identity);
    // Keep every original logical prefix reservation and original bounded
    // probe. Payload rows alone are reused as raw same-snapshot DATA.
    const from=await pilotPrefixFrom(client,context,'phase4_source_links',[context.userId,context.executionMode,table,row.privacy_artifact_id]);
    let links=frame.links.get(identity);
    if(!links)links=retainOwnedEvidenceData(frame,frame.links,identity,(await client.execute({sql:`SELECT source_execution_mode,source_type,source_id,relationship FROM ${from}
      WHERE user_id=? AND artifact_execution_mode=? AND artifact_type=? AND artifact_id=? AND unlinked_at IS NULL`,
      args:[context.userId,context.executionMode,table,row.privacy_artifact_id]})).rows);
    if(!links.length)fail('PHASE4_INCOMPLETE_PROVENANCE');
    for(const link of links){
      if(link.source_execution_mode==='SHARED'){
        if(link.relationship.startsWith('DEPENDS_ON_AS_OF:')||!['sleep','recovery','cycle','workout','USER'].includes(link.source_type))return false;
        const shared=JSON.stringify(['SHARED',link.source_type,link.source_id,null]);
        if(verified.has(shared))continue;
        if(!ownedBodyMetricRootData(context,link.source_type,link.source_id))return false;verified.add(shared);
      }else{
        if(link.source_execution_mode!==context.executionMode||!DERIVED_TABLES.includes(link.source_type))fail('PHASE4_MIXED_MODE_PARENT');
        if(link.relationship==='ANSWER_LINEAGE'||!['body_energy_results','evidence_runs'].includes(link.source_type))return false;
        const parent=await ownedArtifactRow(context,frame,link.source_type,{privacy_artifact_id:link.source_id});
        if(!readableRow(parent)||parent.invalidated_at)fail('PHASE4_PARENT_STALE');
        if(!ownedDefaultArtifact(context,frame,link.source_type,parent))return false;
        for(const [column,value] of [['input_generation',context.inputGeneration],['lifecycle_generation',context.lifecycleGeneration],['auth_generation',context.authGeneration]])
          if(Object.hasOwn(parent,column)&&parent[column]!==value)fail('PHASE4_PARENT_STALE');
        if(!await ownedDefaultGraph(context,frame,link.source_type,parent,path,verified))return false;
      }
      currentOwnedBodyMetricObservation(core,context);
    }
    path.delete(identity);verified.add(identity);return true;
  }
  async function ownedBodyMetricArtifact(context,table,key){
    const frame=ownedEvidenceFrame(context);if(!frame||!['body_energy_results','evidence_runs','evidence_items'].includes(table))return null;
    const info=await tableInfo(table),pk=info.filter(column=>column.pk&&!['user_id','execution_mode'].includes(column.name)).sort((a,b)=>a.pk-b.pk);
    if(!key||Object.keys(key).length!==pk.length||pk.some(column=>!Object.hasOwn(key,column.name)))fail('PHASE4_ENTITY_KEY_REQUIRED');
    const row=await ownedArtifactRow(context,frame,table,key);compareArtifactRow(context,table,row);
    if(!ownedDefaultArtifact(context,frame,table,row)||!await ownedDefaultGraph(context,frame,table,row))return null;
    if(!currentOwnedBodyMetricObservation(core,context))return null;
    // Internal refs may participate only in the enclosing closed comparison
    // purpose; its mandatory delivery fence precedes calculation/effect/public
    // return. The frame never stores these refs or an accepted graph/guard.
    return {row:{...row},ref:reference(context,table,row.privacy_artifact_id,context.executionMode,row)};
  }
  async function validateHistoricalJournal(context,source) {
    if(!['JOURNAL_FACT','JOURNAL_COVERAGE'].includes(source.type)||!source.historicalAsOf
      ||!Number.isFinite(Date.parse(source.historicalAsOf)))fail('PHASE4_HISTORICAL_SOURCE_INVALID');
    const [table,key]=ROOTS[source.type];
    const row=(await client.execute({sql:`SELECT * FROM ${table} WHERE user_id=? AND ${key}=?`,
      args:[context.userId,source.id]})).rows[0];
    if(!readableRow(row))fail('CONTENT_REDACTED');
    if(!row.created_at||Date.parse(row.created_at)>Date.parse(source.historicalAsOf))fail('PHASE4_HISTORICAL_SOURCE_INVALID');
    if(source.type==='JOURNAL_FACT') {
      const authoritative=(await client.execute({sql:`SELECT privacy_artifact_id FROM journal_events
        WHERE user_id=? AND logical_fact_id=? AND julianday(created_at)<=julianday(?) ORDER BY revision DESC,created_at DESC LIMIT 1`,
      args:[context.userId,row.logical_fact_id,source.historicalAsOf]})).rows[0];
      const tombstone=(await client.execute({sql:`SELECT deleted_at FROM journal_event_tombstones
        WHERE user_id=? AND logical_fact_id=?`,args:[context.userId,row.logical_fact_id]})).rows[0];
      if(!authoritative||authoritative.privacy_artifact_id!==source.id
        ||Date.parse(tombstone?.deleted_at)<=Date.parse(source.historicalAsOf))fail('PHASE4_HISTORICAL_SOURCE_INVALID');
    } else {
      const lineage=await coverageLineage(client,context.userId,source.id),descendantIds=new Set([source.id]);
      for(const candidate of lineage.rows)if(descendantIds.has(candidate.supersedes_coverage_window_id))descendantIds.add(candidate.coverage_window_id);
      const authoritative=lineage.rows.filter(candidate=>descendantIds.has(candidate.coverage_window_id)
        &&Date.parse(candidate.created_at)<=Date.parse(source.historicalAsOf))
        .sort((a,b)=>b.revision-a.revision||Date.parse(b.created_at)-Date.parse(a.created_at)
          ||compareExact(a.coverage_window_id,b.coverage_window_id))[0];
      if(!authoritative||authoritative.coverage_window_id!==source.id)fail('PHASE4_HISTORICAL_SOURCE_INVALID');
    }
    if(source.row&&JSON.stringify(row)!==JSON.stringify(source.row))fail('PHASE4_PARENT_STALE');
    return row;
  }
  async function journalSourcesAsOf(context,refs,asOfUtc) {
    if(!Number.isFinite(Date.parse(asOfUtc)))fail('PHASE4_HISTORICAL_AS_OF_REQUIRED');
    asOfUtc=new Date(asOfUtc).toISOString();
    return run(context,async()=>{
      const inputs=await revalidateSources(context,refs),selected=[];
      for(const source of inputs) {
        if(!['JOURNAL_FACT','JOURNAL_COVERAGE'].includes(source.type))fail('PHASE4_JOURNAL_SOURCE_REQUIRED');
        let row=null;
        if(source.type==='JOURNAL_FACT') {
          row=(await client.execute({sql:`SELECT * FROM journal_events WHERE user_id=? AND logical_fact_id=?
            AND julianday(created_at)<=julianday(?) ORDER BY revision DESC,created_at DESC LIMIT 1`,
          args:[context.userId,source.row.logical_fact_id,asOfUtc]})).rows[0]??null;
        } else {
          const lineage=await coverageLineage(client,context.userId,source.id);
          row=lineage.byId.get(source.id);
          while(row&&Date.parse(row.created_at)>Date.parse(asOfUtc))row=row.supersedes_coverage_window_id
            ?lineage.byId.get(row.supersedes_coverage_window_id):null;
        }
        // A genuinely new assertion after T did not exist at T. A correction
        // whose prior revision was purged is different: historical replay is
        // unavailable and must fail closed instead of adopting the correction.
        if(!row) {
          if((source.row.revision??1)>1||source.row.supersedes_coverage_window_id)fail('CONTENT_REDACTED');
          continue;
        }
        if(!readableRow(row))fail('CONTENT_REDACTED');
        const id=source.type==='JOURNAL_FACT'?row.privacy_artifact_id:row.coverage_window_id;
        const ref=reference(context,source.type,id,'SHARED',{...row},{historicalAsOf:asOfUtc});
        const historical={context,type:source.type,id:String(id),mode:'SHARED',row:{...row},historicalAsOf:asOfUtc};
        await validateHistoricalJournal(context,historical);
        selected.push({...historical,ref});
      }
      return selected;
    });
  }
  async function artifact(context,table,key) {
    if(!DERIVED_TABLES.includes(table))fail('PHASE4_UNKNOWN_ENTITY');
    // The smaller nested processing boundary keeps fresh execution/pilot
    // entry and records any pure/SQL failure on the original parent. Catching
    // a failed comparison cannot permit a later effect or COMMIT.
    try{if(currentOwnedBodyMetricObservation(core,context)){
      const closed=await transaction(()=>ownedBodyMetricArtifact(context,table,key),{readOnly:true});if(closed)return closed;
    }}catch(error){await transaction(()=>{throw error;},{readOnly:true});throw error;}
    return run(context,async()=>{
      const info=await tableInfo(table),pk=info.filter(c=>c.pk && !['user_id','execution_mode'].includes(c.name)).sort((a,b)=>a.pk-b.pk);
      if(!key || Object.keys(key).length!==pk.length || pk.some(c=>!Object.hasOwn(key,c.name)))fail('PHASE4_ENTITY_KEY_REQUIRED');
      const row=(await client.execute({sql:`SELECT * FROM ${table} WHERE user_id=? AND execution_mode=?${pk.map(c=>` AND ${c.name}=?`).join('')}`,
        args:[context.userId,context.executionMode,...pk.map(c=>key[c.name])]})).rows[0];
      compareArtifactRow(context,table,row);
      await validateStoredGraph(context,table,row.privacy_artifact_id);
      return {row:{...row},ref:reference(context,table,row.privacy_artifact_id,context.executionMode,row)};
    });
  }
  function compareArtifactRow(context,table,row){
    if(!row)fail('PHASE4_PARENT_NOT_FOUND');
    if(Object.hasOwn(row,'content_state') && !readableRow(row))fail('CONTENT_REDACTED');
    for(const [column,value] of [['input_generation',context.inputGeneration],['lifecycle_generation',context.lifecycleGeneration],['auth_generation',context.authGeneration]])
      if(Object.hasOwn(row,column) && row[column]!==value)fail('PHASE4_PARENT_STALE');
    if(row.invalidated_at || (table==='health_insights' && row.legacy_classification!=='PHASE4'))fail('PHASE4_PARENT_STALE');
    if(!row.privacy_artifact_id)fail('PHASE4_HEALTH_PARENT_REQUIRED');
  }
  // Fresh post-link DATA for the actual scalar raw ITEM writer. Observe the
  // complete flat ITEM -> RUN -> WHOOP closure together, then repeat every
  // row/edge/source comparison. Nothing crosses a write epoch or supplies a
  // source capability. Historical or complex graphs keep artifact() below.
  async function newRawMetricItemData(context,record,refs){
    if(schemaVersion!==35||!liveAllocation||context.executionMode!=='LIVE'||!context.providerRequired
      ||!processing.active?.()||!jobScope.getStore()||processingOwnedLiveObservationEpoch(client,context)===null
      ||!isLiveExecution(currentDurableExecution(),client,keys,context.userId,context))return null;
    const list=validateReferences(context,refs),parents=list.filter(source=>source.mode===context.executionMode&&source.type==='evidence_runs'),
      raw=list.filter(source=>source.mode==='SHARED'&&['sleep','recovery','cycle','workout'].includes(source.type)&&!source.historicalAsOf);
    if(parents.length!==1||!raw.length||raw.length+1!==list.length||list.length>64||parents[0].historicalAsOf)return null;
    const parent=parents[0];
    if(parent.row?.run_id!==record.run_id)return null;
    return run(context,async()=>{
      const epoch=processingReadObservationEpoch(client),marker=currentExecutionReceiptTransactionMarker();
      if(epoch===null||!marker)fail('PHASE4_METRIC_UNIT_RECEIPT_REQUIRED');
      const observed=await Promise.allSettled([
        Promise.resolve().then(()=>client.execute({sql:'SELECT * FROM evidence_items WHERE user_id=? AND execution_mode=? AND evidence_item_id=?',
          args:[context.userId,context.executionMode,record.evidence_item_id]})),
        Promise.resolve().then(()=>client.execute({sql:'SELECT * FROM evidence_runs WHERE user_id=? AND execution_mode=? AND privacy_artifact_id=?',
          args:[context.userId,context.executionMode,parent.id]})),
        Promise.resolve().then(()=>readPilotSourceLinkRows(client,context,'evidence_items',record.privacy_artifact_id,false)),
        Promise.resolve().then(()=>readPilotSourceLinkRows(client,context,'evidence_runs',parent.id,false)),
        Promise.resolve().then(()=>readRoots(context,raw,{compareRows:true})),
      ]);
      // All submitted observation promises settle, even when a comparator rejects.
      // No fallback retries an SQL/ownership/privacy failure.
      for(const result of observed)if(result.status==='rejected')throw result.reason;
      const actual=observed[0].value.rows[0],runRow=observed[1].value.rows[0];
      compareArtifactRow(context,'evidence_items',actual);compareArtifactRow(context,'evidence_runs',runRow);
      if(runRow.state!=='COMPLETED')fail('PHASE4_EVIDENCE_NOT_COMPLETED');
      if(Object.keys(record).some(field=>actual[field]!==record[field]))fail('PHASE4_IDENTITY_CONTENT_CONFLICT');
      if(JSON.stringify({...runRow})!==JSON.stringify({...parent.row}))fail('PHASE4_PARENT_STALE');
      const identities=rows=>[...new Set(rows.map(row=>JSON.stringify(row)))].sort();
      const expected=sources=>identities(sources.map(source=>[source.mode,source.type,source.id,'DEPENDS_ON']));
      const edges=rows=>identities(rows.map(row=>[row.source_execution_mode,row.source_type,row.source_id,row.relationship]));
      if(JSON.stringify(edges(observed[2].value))!==JSON.stringify(expected(list)))fail('PHASE4_INCOMPLETE_PROVENANCE');
      const runLinks=observed[3].value;
      if(runLinks.some(edge=>edge.source_execution_mode!=='SHARED'||!['sleep','recovery','cycle','workout'].includes(edge.source_type)
        ||edge.relationship!=='DEPENDS_ON'))return null;
      if(JSON.stringify(edges(runLinks))!==JSON.stringify(expected(raw)))fail('PHASE4_INCOMPLETE_PROVENANCE');
      // These actual complete edge sets close the entire two-level graph:
      // exactly one completed RUN, only the same freshly checked WHOOP roots,
      // no historical/derived/answer edges, cycles or hidden dependencies.
      await assertFreshContextAndWorkOwner(core,context);requireSettledOperation();
      if(epoch!==processingReadObservationEpoch(client)||marker!==currentExecutionReceiptTransactionMarker())fail('PROCESSING_READ_OBSERVATION_CHANGED');
      return {row:{...actual},created:true};
    });
  }
  async function validateStoredGraph(context,table,artifactId,path=new Set(),verified=new Set()) {
    // The same closed data purpose used by artifact() can serve a top-level
    // source revalidation. Compare every actual link/root again, then perform
    // fresh context/job/owner controls. Writes discard the frame immediately;
    // recursive, historical and unmatched graphs keep the original reader.
    if(path.size===0&&verified.size===0&&['body_energy_results','evidence_runs','evidence_items'].includes(table)
      &&currentOwnedBodyMetricObservation(core,context)){
      const observed=await transaction(async()=>{
        const frame=ownedEvidenceFrame(context);if(!frame)return false;
        const row=await ownedArtifactRow(context,frame,table,{privacy_artifact_id:artifactId});
        if(!row||!ownedDefaultArtifact(context,frame,table,row)||!await ownedDefaultGraph(context,frame,table,row))return false;
        await assertFreshContextAndWorkOwner(core,context);requireSettledOperation();
        return Boolean(currentOwnedBodyMetricObservation(core,context));
      },{readOnly:true});
      if(observed)return;
    }
    const node=JSON.stringify([table,artifactId]);
    if(path.has(node) || path.size>128 || verified.size>10000)fail('PHASE4_PROVENANCE_CYCLE');
    if(verified.has(node))return;
    path.add(node);
    const logical=['observation_episodes','health_insights'].includes(table);
    const links=await readPilotSourceLinkRows(client,context,table,artifactId,logical);
    if(!links.length)fail('PHASE4_INCOMPLETE_PROVENANCE');
    for(let index=0;index<links.length;index++) {
      const link=links[index];
      if(link.source_execution_mode==='SHARED'&&!link.relationship.startsWith('DEPENDS_ON_AS_OF:')
        &&['sleep','recovery','cycle','workout','USER'].includes(link.source_type)){
        const pending=[],identities=new Set();
        for(;index<links.length;index++){const item=links[index];
          if(item.source_execution_mode!=='SHARED'||item.relationship.startsWith('DEPENDS_ON_AS_OF:')
            ||!['sleep','recovery','cycle','workout','USER'].includes(item.source_type)){index--;break;}
          const identity=JSON.stringify(['SHARED',item.source_type,item.source_id,null]);
          if(!verified.has(identity)&&!identities.has(identity)){identities.add(identity);pending.push({type:item.source_type,id:item.source_id});}
        }
        await readRoots(context,pending);for(const identity of identities)verified.add(identity);continue;
      }
      if(link.source_execution_mode==='SHARED') {
        // One read-only traversal can reach the same root through many evidence
        // revisions. Verify each root/as-of pair once within this traversal;
        // never cache across calls, writes, contexts, or transactions.
        const shared=JSON.stringify(['SHARED',link.source_type,link.source_id,
          link.relationship.startsWith('DEPENDS_ON_AS_OF:')?link.relationship:null]);
        if(verified.has(shared))continue;
        if(link.relationship.startsWith('DEPENDS_ON_AS_OF:'))await validateHistoricalJournal(context,{type:link.source_type,
          id:link.source_id,mode:'SHARED',historicalAsOf:link.relationship.slice('DEPENDS_ON_AS_OF:'.length),row:null});
        else await root(context,link.source_type,link.source_id);
        verified.add(shared);
      }
      else {
        if(link.source_execution_mode!==context.executionMode || !DERIVED_TABLES.includes(link.source_type))fail('PHASE4_MIXED_MODE_PARENT');
        const parent=(await client.execute({sql:`SELECT * FROM ${link.source_type} WHERE user_id=? AND execution_mode=? AND privacy_artifact_id=?`,
          args:[context.userId,context.executionMode,link.source_id]})).rows[0];
        if(!readableRow(parent) || parent.invalidated_at
          || (link.source_type==='health_insights' && parent.legacy_classification!=='PHASE4'))fail('PHASE4_PARENT_STALE');
        if(link.relationship==='ANSWER_LINEAGE') {
          // The independently authenticated answer supplies its own assertion
          // root. This edge records the question it answered, NOT old numeric
          // evidence. It still participates fully in tenant/mode/purge closure.
          const answer=table==='structured_answer_events'?(await client.execute({sql:`SELECT question_request_id FROM structured_answer_events
            WHERE user_id=? AND execution_mode=? AND privacy_artifact_id=?`,args:[context.userId,context.executionMode,artifactId]})).rows[0]:null;
          if(link.source_type!=='context_questions'||!answer||answer.question_request_id!==parent.question_request_id||parent.status!=='RESOLVED'
            ||parent.lifecycle_generation!==context.lifecycleGeneration||parent.auth_generation!==context.authGeneration)fail('PHASE4_ANSWER_LINEAGE_INVALID');
          continue;
        }
        for(const [column,value] of [['input_generation',context.inputGeneration],['lifecycle_generation',context.lifecycleGeneration],['auth_generation',context.authGeneration]])
          if(Object.hasOwn(parent,column) && parent[column]!==value)fail('PHASE4_PARENT_STALE');
        await validateStoredGraph(context,link.source_type,link.source_id,path,verified);
      }
    }
    path.delete(node);verified.add(node);
  }
  // Read observations overlap only inside an already owned processing
  // transaction. Bound in-flight roots, settle every submitted read, retain
  // original result/failure order, and run every original root/context guard.
  async function readRoots(context,descriptors,{compareRows=false,verify=null}={}) {
    const observe=async source=>{const current=await root(context,source.type,source.id);
      if(compareRows&&source.row&&JSON.stringify(current.row)!==JSON.stringify(source.row))fail('PHASE4_PARENT_STALE');
      if(verify)await verify(source,current);return current;};
    const out=[];
    if(!processing.active?.()){for(const source of descriptors)out.push(await observe(source));return out;}
    for(let start=0;start<descriptors.length;start+=RAW_SOURCE_READ_BATCH){
      const results=await Promise.allSettled(descriptors.slice(start,start+RAW_SOURCE_READ_BATCH).map(source=>
        Promise.resolve().then(()=>observe(source))));
      const rejected=results.find(result=>result.status==='rejected');if(rejected)throw rejected.reason;
      out.push(...results.map(result=>result.value));
    }return out;
  }
  // Closed current-Body readonly input. Complex/historical actual graphs keep
  // the original general verifier. The finite raw graph case observes every
  // actual link plus every expected audit/domain root once; callers compare
  // their original purposes against these data before the final fresh gate.
  async function currentBodyRawUnion(context,row,expected){
    if(!processing.active?.()||!jobScope.getStore()||!contexts.has(context)||![32,33,34,35].includes(schemaVersion)||!analysisModeAllowed(context)
      ||currentDurableExecution()?.claim?.request?.phase!=='STAGE6_DRAIN'||currentDurableExecution().receipts===false)
      fail('BODY_ENERGY_CURRENT_DRAIN_REQUIRED');
    if(row.user_id!==context.userId||row.execution_mode!==context.executionMode||!readableRow(row))fail('CONTENT_REDACTED');
    for(const [field,value] of [['input_generation',context.inputGeneration],['lifecycle_generation',context.lifecycleGeneration],['auth_generation',context.authGeneration]])
      if(row[field]!==value)fail('PHASE4_PARENT_STALE');
    if(row.invalidated_at||!row.privacy_artifact_id)fail('PHASE4_PARENT_STALE');
    const from=await pilotPrefixFrom(client,context,'phase4_source_links',[context.userId,context.executionMode,'body_energy_results',row.privacy_artifact_id]);
    const links=(await client.execute({sql:`SELECT source_execution_mode,source_type,source_id,relationship FROM ${from}
      WHERE user_id=? AND artifact_execution_mode=? AND artifact_type='body_energy_results' AND artifact_id=? AND unlinked_at IS NULL`,
      args:[context.userId,context.executionMode,row.privacy_artifact_id]})).rows;
    if(!links.length)fail('PHASE4_INCOMPLETE_PROVENANCE');
    const raw=value=>['sleep','recovery','cycle','workout','USER'].includes(value.type);
    if(links.some(link=>link.source_execution_mode!=='SHARED'||link.relationship.startsWith('DEPENDS_ON_AS_OF:')||!raw({type:link.source_type})))
      return {fallback:true};
    if(!Array.isArray(expected)||expected.length>10000||expected.some(value=>!raw(value)))fail('PHASE4_REQUIRED_ROOT_BOUNDS_UNAVAILABLE');
    const actual=links.map(link=>({type:link.source_type,id:link.source_id})),descriptors=[],seen=new Set();
    for(const source of [...actual,...expected]){
      const key=JSON.stringify([source.type,String(source.id)]);if(seen.has(key))continue;seen.add(key);
      if(seen.size>10000)fail('PHASE4_PROVENANCE_CYCLE');descriptors.push({type:source.type,id:String(source.id)});
    }
    const values=new Map();let bytes=0;
    for(let start=0;start<descriptors.length;start+=RAW_SOURCE_READ_BATCH){
      const group=descriptors.slice(start,start+RAW_SOURCE_READ_BATCH),observations=await Promise.allSettled(group.map(source=>
        Promise.resolve().then(()=>root(context,source.type,source.id))));
      for(let index=0;index<group.length;index++){
        const observed=observations[index];if(observed.status==='fulfilled')bytes+=Buffer.byteLength(JSON.stringify(observed.value.row,
          (_key,value)=>typeof value==='bigint'?String(value):value),'utf8');
        values.set(JSON.stringify([group[index].type,group[index].id]),observed);
      }
      if(bytes>READ_SNAPSHOT_LIMITS.bytes)return {fallback:true};
    }
    return {fallback:false,actual,values};
  }
  // Closed post-calculation metric-domain input. This reads actual Body,
  // ITEM and RUN graphs plus expected flattened raw roots in one owned root.
  // It returns raw observations only: its caller executes each original
  // purpose comparator in order and fences again before a receipt effect.
  async function bodyMetricPreparationRawUnion(context,refs,expected,ownedPurpose=null){
    if(!processing.active?.()||!jobScope.getStore()||!contexts.has(context)||![32,33,34,35].includes(schemaVersion)||!analysisModeAllowed(context)
      ||currentDurableExecution()?.claim?.request?.phase!=='STAGE6_DRAIN'||currentDurableExecution().receipts===false)
      fail('PHASE4_METRIC_UNIT_RECEIPT_REQUIRED');
    requireSettledOperation();
    const owned=ownedPurpose?requireOwnedBodyMetricPurpose(core,context,ownedPurpose):null,
      sourceData=owned?requireOwnedCurrentBodyData(core,context,owned.request.currentSource):null;
    const inputs=validateReferences(context,refs),unique=[...new Map(inputs.map(source=>[JSON.stringify([source.type,source.id]),source])).values()],
      body=unique.filter(source=>source.type==='body_energy_results'),items=unique.filter(source=>source.type==='evidence_items');
    if(body.length!==1||items.length!==1||unique.length!==2||inputs.some(source=>source.mode!==context.executionMode||source.historicalAsOf))return {fallback:true};
    const rawType=type=>['sleep','recovery','cycle','workout','USER'].includes(type);
    if(!Array.isArray(expected)||expected.length>10000||expected.some(source=>!rawType(source.type)||source.mode&&source.mode!=='SHARED'||source.as_of!=null))return {fallback:true};
    return run(context,async()=>{
      await assertExecutionWorkOwner(client);
      const observationEpoch=processingReadObservationEpoch(client);
      if(observationEpoch===null)return {fallback:true};
      const retained=owned?ownedMetricUnions.get(owned):null;
      if(retained?.observationEpoch===observationEpoch
        &&unique.every(source=>retained.inputRows.has(JSON.stringify([source.type,String(source.id)])))
        &&expected.every(source=>sourceData.rawRoots.has(JSON.stringify([source.type,String(source.id)])))){
        // DATA only from this exact purpose/root/epoch. Every original prefix
        // reservation and bounded probe still runs; independent probes share
        // transport. Consumers repeat their full pure graph/hash/row checks
        // and their mandatory fresh delivery gate. No accepted guard survives.
        const probes=await Promise.allSettled([...retained.nodes.values()].map(node=>Promise.resolve().then(()=>
          pilotPrefixFrom(client,context,'phase4_source_links',[context.userId,context.executionMode,node.table,node.row.privacy_artifact_id]))));
        for(const value of probes)if(value.status==='rejected')throw value.reason;
        requireOwnedBodyMetricPurpose(core,context,ownedPurpose);
        if(processingReadObservationEpoch(client)!==observationEpoch)fail('PHASE4_METRIC_PREPARATION_CAPTURE_REQUIRED');
        return {...retained,inputs};
      }
      const nodes=new Map(),values=new Map(),raw=new Map(),nodeKey=(table,id)=>JSON.stringify([table,String(id)]);
      const initial=await Promise.allSettled(unique.map(source=>Promise.resolve().then(()=>client.execute({
        sql:`SELECT * FROM ${source.type} WHERE user_id=? AND execution_mode=? AND privacy_artifact_id=?`,args:[context.userId,context.executionMode,source.id]}))));
      const pending=[],inputRows=new Map();let bytes=0;
      for(let index=0;index<unique.length;index++){
        const value=initial[index];inputRows.set(nodeKey(unique[index].type,unique[index].id),value.status==='fulfilled'?{row:value.value.rows[0]}:{error:value.reason});
        if(value.status==='fulfilled'&&value.value.rows[0])pending.push({table:unique[index].type,row:value.value.rows[0]});
      }
      const itemRow=inputRows.get(nodeKey('evidence_items',items[0].id))?.row;
      let runObservation={row:null};
      if(itemRow){
        try{runObservation={row:(await client.execute({sql:'SELECT * FROM evidence_runs WHERE user_id=? AND execution_mode=? AND run_id=?',
          args:[context.userId,context.executionMode,itemRow.run_id]})).rows[0]};}catch(error){runObservation={error};}
        if(runObservation.row)pending.push({table:'evidence_runs',row:runObservation.row});
      }
      while(pending.length){
        const node=pending.shift(),identity=nodeKey(node.table,node.row.privacy_artifact_id);if(nodes.has(identity))continue;
        if(nodes.size>=10000)return {fallback:true};
        let links;
        try{
          const from=await pilotPrefixFrom(client,context,'phase4_source_links',[context.userId,context.executionMode,node.table,node.row.privacy_artifact_id]);
          links=(await client.execute({sql:`SELECT source_execution_mode,source_type,source_id,relationship FROM ${from}
            WHERE user_id=? AND artifact_execution_mode=? AND artifact_type=? AND artifact_id=? AND unlinked_at IS NULL`,
            args:[context.userId,context.executionMode,node.table,node.row.privacy_artifact_id]})).rows;
        }catch(error){nodes.set(identity,{row:node.row,error});continue;}
        nodes.set(identity,{table:node.table,row:node.row,links});bytes+=Buffer.byteLength(JSON.stringify([node.row,links]));
        if(bytes>READ_SNAPSHOT_LIMITS.bytes)return {fallback:true};
        for(const link of links){
          if(link.source_execution_mode==='SHARED'){
            if(link.relationship.startsWith('DEPENDS_ON_AS_OF:')||!rawType(link.source_type))return {fallback:true};
            raw.set(nodeKey(link.source_type,link.source_id),{type:link.source_type,id:String(link.source_id)});
          }else if(link.source_execution_mode===context.executionMode&&['body_energy_results','evidence_runs'].includes(link.source_type)){
            if(link.relationship==='ANSWER_LINEAGE')return {fallback:true};
            const key=nodeKey(link.source_type,link.source_id);if(nodes.has(key)||pending.some(value=>nodeKey(value.table,value.row.privacy_artifact_id)===key))continue;
            let parent;
            try{parent=(await client.execute({sql:`SELECT * FROM ${link.source_type} WHERE user_id=? AND execution_mode=? AND privacy_artifact_id=?`,
              args:[context.userId,context.executionMode,link.source_id]})).rows[0];}catch(error){nodes.set(key,{error});continue;}
            if(parent)pending.push({table:link.source_type,row:parent});else nodes.set(key,{row:null,links:[]});
          }else return {fallback:true};
          if(raw.size>10000)return {fallback:true};
        }
      }
      for(const source of expected)raw.set(nodeKey(source.type,source.id),{type:source.type,id:String(source.id)});
      if(raw.size>10000)return {fallback:true};
      const descriptors=[...raw.values()];
      if(sourceData){
        // Raw source data belongs to this complete owned purpose, not a prior
        // authorization. Every consumer below repeats the original controls.
        requireOwnedBodyMetricPurpose(core,context,ownedPurpose);
        if(descriptors.some(source=>!sourceData.rawRoots.has(nodeKey(source.type,source.id))))return {fallback:true};
        bytes+=Buffer.byteLength(JSON.stringify(descriptors.map(source=>sourceData.rawRoots.get(nodeKey(source.type,source.id)))));
        if(bytes>READ_SNAPSHOT_LIMITS.bytes)return {fallback:true};
        // Defer fresh SQL to the closed owner's post-comparison delivery gate;
        // a later raw SQL failure must not suppress an earlier pure error.
        if(processingReadObservationEpoch(client)!==observationEpoch)return {fallback:true};
        const result={fallback:false,inputs,inputRows,runObservation,nodes,values,observationEpoch,sourceData,ownedPurpose};
        if([...nodes.values()].every(node=>node.table&&node.row&&Array.isArray(node.links)))ownedMetricUnions.set(owned,result);
        return result;
      }
      for(let start=0;start<descriptors.length;start+=RAW_SOURCE_READ_BATCH){
        const group=descriptors.slice(start,start+RAW_SOURCE_READ_BATCH),observed=await Promise.allSettled(group.map(source=>Promise.resolve().then(()=>root(context,source.type,source.id))));
        for(let index=0;index<group.length;index++){
          const value=observed[index];if(value.status==='fulfilled')bytes+=Buffer.byteLength(JSON.stringify(value.value.row));
          values.set(nodeKey(group[index].type,group[index].id),value);
        }
        if(bytes>READ_SNAPSHOT_LIMITS.bytes)return {fallback:true};
      }
      await assertFreshContextAndWorkOwner(core,context);requireSettledOperation();
      if(processingReadObservationEpoch(client)!==observationEpoch)return {fallback:true};
      return {fallback:false,inputs,inputRows,runObservation,nodes,values,observationEpoch};
    });
  }
  // Only the owned metric-ITEM entity purpose uses this closure. The complete
  // actual RUN and Body graphs are observed once, then the original parent and
  // source comparators run in their original order. A later mutation phase
  // invokes a NEW closure; no successful graph check or permit is reused.
  async function metricPreparationItemSources(context,runId,bodyRefs,runRef=null){
    if(!processing.active?.()||!jobScope.getStore()||![32,33,34,35].includes(schemaVersion)||!analysisModeAllowed(context)
      ||currentDurableExecution()?.claim?.request?.phase!=='STAGE6_DRAIN'||currentDurableExecution().receipts===false)
      fail('PHASE4_METRIC_UNIT_RECEIPT_REQUIRED');
    requireSettledOperation();
    const bodies=validateReferences(context,bodyRefs),priorRun=runRef?validateReferences(context,[runRef])[0]:null;
    if(!bodies.length||bodies.length>64||bodies.some(source=>source.mode!==context.executionMode||source.type!=='body_energy_results'
      ||source.historicalAsOf)||priorRun&&(priorRun.type!=='evidence_runs'||priorRun.mode!==context.executionMode))return {fallback:true};
    return run(context,async()=>{
      await assertExecutionWorkOwner(client);
      const captured=new Map(),raw=new Map(),nodeKey=(table,id)=>JSON.stringify([table,String(id)]);
      const runRow=(await client.execute(priorRun?{
        sql:'SELECT * FROM evidence_runs WHERE user_id=? AND execution_mode=? AND privacy_artifact_id=?',
        args:[context.userId,context.executionMode,priorRun.id]}:{
        sql:'SELECT * FROM evidence_runs WHERE user_id=? AND execution_mode=? AND run_id=?',
        args:[context.userId,context.executionMode,runId]})).rows[0];
      if(!priorRun)compareArtifactRow(context,'evidence_runs',runRow);
      const pending=runRow?[{table:'evidence_runs',row:runRow}]:[];
      // Body references are caller-independent branded calculation inputs.
      // Every row observation remains tenant/mode scoped and freshly guarded.
      const bodyRows=await Promise.allSettled(bodies.map(source=>Promise.resolve().then(()=>client.execute({
        sql:'SELECT * FROM body_energy_results WHERE user_id=? AND execution_mode=? AND privacy_artifact_id=?',
        args:[context.userId,context.executionMode,source.id]}))));
      const observedBodies=[];
      for(let index=0;index<bodies.length;index++){
        const value=bodyRows[index];observedBodies.push(value.status==='fulfilled'?{row:value.value.rows[0]}:{error:value.reason});
        if(value.status==='fulfilled'&&value.value.rows[0])pending.push({table:'body_energy_results',row:value.value.rows[0]});
      }
      let bytes=Buffer.byteLength(JSON.stringify(runRow??null));
      // Only the fixed RUN plus one Body input overlaps their original link
      // observations. Each invocation is fresh (including after INSERT); no
      // graph, successful guard or pre-mutation data survives this call.
      const firstLinks=new Map();
      if(bodies.length===1&&pending.length===2&&pending[0].table==='evidence_runs'&&pending[1].table==='body_energy_results'){
        const observations=await Promise.allSettled(pending.map(node=>Promise.resolve().then(async()=>{
          const from=await pilotPrefixFrom(client,context,'phase4_source_links',[context.userId,context.executionMode,node.table,node.row.privacy_artifact_id]);
          return (await client.execute({sql:`SELECT source_execution_mode,source_type,source_id,relationship FROM ${from}
            WHERE user_id=? AND artifact_execution_mode=? AND artifact_type=? AND artifact_id=? AND unlinked_at IS NULL`,
            args:[context.userId,context.executionMode,node.table,node.row.privacy_artifact_id]})).rows;
        })));
        for(let index=0;index<pending.length;index++)firstLinks.set(nodeKey(pending[index].table,pending[index].row.privacy_artifact_id),observations[index]);
      }
      while(pending.length){
        const node=pending.shift(),identity=nodeKey(node.table,node.row.privacy_artifact_id);if(captured.has(identity))continue;
        if(captured.size>=10000)return {fallback:true};
        const prior=firstLinks.get(identity);let links;
        if(prior){if(prior.status==='rejected')throw prior.reason;links=prior.value;}
        else{
          const from=await pilotPrefixFrom(client,context,'phase4_source_links',[context.userId,context.executionMode,node.table,node.row.privacy_artifact_id]);
          links=(await client.execute({sql:`SELECT source_execution_mode,source_type,source_id,relationship FROM ${from}
            WHERE user_id=? AND artifact_execution_mode=? AND artifact_type=? AND artifact_id=? AND unlinked_at IS NULL`,
            args:[context.userId,context.executionMode,node.table,node.row.privacy_artifact_id]})).rows;
        }
        bytes+=Buffer.byteLength(JSON.stringify([node.row,links]));if(bytes>READ_SNAPSHOT_LIMITS.bytes)return {fallback:true};
        captured.set(identity,{row:node.row,links});
        for(const link of links){
          if(link.source_execution_mode==='SHARED'){
            if(link.relationship.startsWith('DEPENDS_ON_AS_OF:')||!['sleep','recovery','cycle','workout','USER'].includes(link.source_type))return {fallback:true};
            raw.set(nodeKey(link.source_type,link.source_id),{type:link.source_type,id:link.source_id});if(raw.size>10000)return {fallback:true};
          }else if(link.source_execution_mode===context.executionMode&&link.source_type==='body_energy_results'){
            const key=nodeKey(link.source_type,link.source_id);if(captured.has(key)||pending.some(value=>nodeKey(value.table,value.row.privacy_artifact_id)===key))continue;
            const parent=(await client.execute({sql:'SELECT * FROM body_energy_results WHERE user_id=? AND execution_mode=? AND privacy_artifact_id=?',
              args:[context.userId,context.executionMode,link.source_id]})).rows[0];
            // Missing parents are retained for the original ordered comparator.
            if(parent)pending.push({table:link.source_type,row:parent});else captured.set(key,{row:null,links:[]});
          }else return {fallback:true};
        }
      }
      const rootValues=new Map(),descriptors=[...raw.values()];
      for(let start=0;start<descriptors.length;start+=RAW_SOURCE_READ_BATCH){
        const group=descriptors.slice(start,start+RAW_SOURCE_READ_BATCH),values=await Promise.allSettled(group.map(source=>Promise.resolve().then(()=>root(context,source.type,source.id))));
        for(let index=0;index<group.length;index++){
          const value=values[index];if(value.status==='fulfilled')bytes+=Buffer.byteLength(JSON.stringify(value.value.row));
          rootValues.set(nodeKey(group[index].type,group[index].id),value);
        }
        if(bytes>READ_SNAPSHOT_LIMITS.bytes)return {fallback:true};
      }
      const graph=(table,id,path=new Set(),verified=new Set())=>{
        const identity=nodeKey(table,id);if(path.has(identity)||path.size>128||verified.size>10000)fail('PHASE4_PROVENANCE_CYCLE');
        if(verified.has(identity))return;path.add(identity);
        const node=captured.get(identity);if(!node?.links.length)fail('PHASE4_INCOMPLETE_PROVENANCE');
        for(const link of node.links){
          if(link.source_execution_mode==='SHARED'){
            const key=nodeKey(link.source_type,link.source_id);if(verified.has(key))continue;
            const observed=rootValues.get(key);if(!observed)fail('PHASE4_SOURCE_NOT_FOUND');if(observed.status==='rejected')throw observed.reason;verified.add(key);
          }else{
            const parent=captured.get(nodeKey(link.source_type,link.source_id))?.row;
            if(!readableRow(parent)||parent.invalidated_at)fail('PHASE4_PARENT_STALE');
            for(const [column,value] of [['input_generation',context.inputGeneration],['lifecycle_generation',context.lifecycleGeneration],['auth_generation',context.authGeneration]])
              if(Object.hasOwn(parent,column)&&parent[column]!==value)fail('PHASE4_PARENT_STALE');
            graph(link.source_type,link.source_id,path,verified);
          }
        }
        path.delete(identity);verified.add(identity);
      };
      if(!priorRun){graph('evidence_runs',runRow.privacy_artifact_id);if(runRow.state!=='COMPLETED')fail('PHASE4_EVIDENCE_NOT_COMPLETED');}
      for(let index=0;index<bodies.length;index++){
        const observed=observedBodies[index];if(observed.error)throw observed.error;
        const row=observed.row,source=bodies[index];if(!readableRow(row)||row.invalidated_at)fail('PHASE4_PARENT_STALE');
        for(const column of ['input_generation','lifecycle_generation','auth_generation'])if(Object.hasOwn(row,column)&&row[column]!==source.row[column])fail('PHASE4_PARENT_STALE');
        graph(source.type,source.id);
      }
      if(priorRun){
        if(!readableRow(runRow)||runRow.invalidated_at)fail('PHASE4_PARENT_STALE');
        for(const column of ['input_generation','lifecycle_generation','auth_generation'])if(Object.hasOwn(runRow,column)&&runRow[column]!==priorRun.row[column])fail('PHASE4_PARENT_STALE');
        graph(priorRun.type,priorRun.id);
      }
      await assertFreshContextAndWorkOwner(core,context);requireSettledOperation();
      return {fallback:false,refs:[...bodyRefs,runRef??reference(context,'evidence_runs',runRow.privacy_artifact_id,context.executionMode,runRow)]};
    });
  }
  async function revalidateSources(context,refs) {
    const list=validateReferences(context,refs);
    for(let index=0;index<list.length;index++) {
      const source=list[index];
      if(source.mode==='SHARED'&&!source.historicalAsOf&&['sleep','recovery','cycle','workout','USER'].includes(source.type)){
        const group=[source];while(index+1<list.length&&list[index+1].mode==='SHARED'&&!list[index+1].historicalAsOf
          &&['sleep','recovery','cycle','workout','USER'].includes(list[index+1].type))group.push(list[++index]);
        await readRoots(context,group,{compareRows:true});
        continue;
      }
      if(source.mode==='SHARED') {
        if(source.historicalAsOf)await validateHistoricalJournal(context,source);
        else {
          const current=await root(context,source.type,source.id);
          if(source.row && JSON.stringify(current.row)!==JSON.stringify(source.row))fail('PHASE4_PARENT_STALE');
        }
      }
      else {
        const row=(await client.execute({sql:`SELECT * FROM ${source.type} WHERE user_id=? AND execution_mode=? AND privacy_artifact_id=?`,
          args:[context.userId,context.executionMode,source.id]})).rows[0];
        if(!readableRow(row) || row.invalidated_at)fail('PHASE4_PARENT_STALE');
        for(const col of ['input_generation','lifecycle_generation','auth_generation'])
          if(Object.hasOwn(row,col) && row[col]!==source.row[col])fail('PHASE4_PARENT_STALE');
        await validateStoredGraph(context,source.type,source.id);
      }
    }
    return list;
  }
  async function link(context,table,artifactId,refs) {
    if(!processing.active())fail('PHASE4_TRANSACTION_REQUIRED');
    const list=await revalidateSources(context,refs);
    if(!list.length)fail('PHASE4_COMPLETE_PROVENANCE_REQUIRED');
    await addPrivacyLinks(client,list.map(source=>({userId:context.userId,mode:context.executionMode,table,artifactId,
      sourceMode:source.mode,sourceType:source.type,sourceId:source.id,at:timestamp(),
      relationship:['observation_episodes','health_insights'].includes(table)?`INPUT_GENERATION:${context.inputGeneration}`
        :source.historicalAsOf?`DEPENDS_ON_AS_OF:${source.historicalAsOf}`:'DEPENDS_ON'})));
  }
  async function linkMetricPreparationItem(context,artifactId,refs){
    const sources=validateReferences(context,refs),parent=sources.at(-1);
    if(parent?.type!=='evidence_runs')fail('PHASE4_METRIC_UNIT_RECEIPT_REQUIRED');
    const observed=await metricPreparationItemSources(context,parent.row.run_id,refs.slice(0,-1),refs.at(-1));
    if(observed.fallback)return link(context,'evidence_items',artifactId,refs);
    const list=validateReferences(context,observed.refs);if(!list.length)fail('PHASE4_COMPLETE_PROVENANCE_REQUIRED');
    await addPrivacyLinks(client,list.map(source=>({userId:context.userId,mode:context.executionMode,table:'evidence_items',artifactId,
      sourceMode:source.mode,sourceType:source.type,sourceId:source.id,at:timestamp(),relationship:'DEPENDS_ON'})));
  }
  function envelope(context,table,identity,{salt=keys.newSalt()}={}) {
    if(!contexts.has(context))fail('PHASE4_SERVER_CONTEXT_REQUIRED');
    return {user_id:context.userId,execution_mode:context.executionMode,content_state:'PRESENT',source_linkage_state:'COMPLETE',
      privacy_artifact_id:keys.lookup(['privacy-artifact-v1',table,context.userId,context.executionMode,identity]),
      content_digest_salt:salt,purge_generation:context.purgeGeneration};
  }
  const core=Object.freeze({client,processing,transaction,keys,now,timestamp,schemaVersion,liveAllocation,analysisModeAllowed,assertAnalysisWrite,userState,initializeTenant,capture,assertContext,captureControl,assertControl,
    withJobFence:(binding,check,fn)=>jobScope.run({binding,check},fn),jobAuthority:()=>jobScope.getStore()?.binding??null,
    capturePrivacyControl,assertPrivacyControl,run,runControl,runMaintenance,contextRegistry,
    tableInfo,root,ownedBodyMetricRootData,copyOwnedRootObservation,compareRootObservation,readRoots,currentBodyRawUnion,bodyMetricPreparationRawUnion,metricPreparationItemSources,linkMetricPreparationItem,newRawMetricItemData,artifact,link,envelope,reference,isReference:value=>sources.has(value),validateReferences,revalidateSources,journalSourcesAsOf,validateHistoricalJournal,validateStoredGraph,newId:()=>randomUUID()});return core;
}
