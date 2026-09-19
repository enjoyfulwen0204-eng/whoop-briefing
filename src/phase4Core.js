/** Internal persistence kernel. No application entry point imports this module
 * directly. The public Foundation factory supplies SHADOW-only authority;
 * isolated tests supply a distinct factory that owns its in-memory database. */
import { randomUUID } from 'node:crypto';
import { assertPhase4Schema } from './phase4Migrations.js';
import { requirePhase4Keys } from './phase4Keys.js';
import { requireUserId } from './userContext.js';
import { addPrivacyLink } from './phase4V22Backfill.js';
import { V23_TABLES } from './phase4V23Schema.js';
import { V24_TABLES } from './phase4V24Schema.js';
import { createPhase4ContextRegistry } from './phase4Cache.js';

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
export const DERIVED_TABLES = Object.freeze(['context_questions','structured_answer_events',...V23_TABLES,'health_insights',...V24_TABLES]);
const ROOTS = Object.freeze({
  sleep:['whoop_sleeps','id'],recovery:['whoop_recoveries','sleep_id'],cycle:['whoop_cycles','id'],workout:['whoop_workouts','id'],
  JOURNAL_FACT:['journal_events','privacy_artifact_id'],JOURNAL_COVERAGE:['journal_coverage_windows','coverage_window_id'],
  EXPERIMENT_DIRECT_ASSERTION:['experiment_field_groups','assertion_id'],TELEGRAM_OPERATION:['telegram_operations','update_id'],
});

/** Server-owned context and source references are branded within this instance.
 * A JSON object, a context from another connection, or a changed mode is not a
 * capability. Authority is supplied only by the owning server/fixture factory. */
export async function buildPhase4Core({processing,keys,authorizeMode:modeAuthority,now=()=>new Date()}) {
  requirePhase4Keys(keys);
  if(typeof modeAuthority!=='function' || typeof processing?.transaction!=='function')fail('PHASE4_SERVER_FACTORY_REQUIRED');
  const {client,transaction}=processing;
  await assertPhase4Schema(client,24);
  const databases=(await client.execute('PRAGMA database_list')).rows;
  const isolatedMemory=client.protocol==='file'&&databases.length===1&&databases[0].name==='main'&&databases[0].file==='';
  function authorizeMode(mode,connection) {
    if(mode==='LIVE'&&!isolatedMemory)fail('PHASE4_LIVE_FIXTURE_MEMORY_REQUIRED');
    return modeAuthority(mode,connection);
  }
  const keyCheck=(await client.execute("SELECT last_cursor FROM phase4_migration_checkpoints WHERE target_version=22 AND step_key='lookup_key_check'")).rows[0];
  if(keyCheck?.last_cursor!==keys.lookup(['phase4-lookup-key-check-v1']))fail('PHASE4_LOOKUP_KEY_MISMATCH');
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
    authorizeMode(mode,client);
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
    });
  }
  async function capture(userId,{executionMode,providerRequired=false}={}) {
    // Missing mode is an error despite the SQL default. Never infer LIVE from a
    // payload, flag, prior row or destination binding.
    if(!['SHADOW','LIVE'].includes(executionMode))fail('PHASE4_EXECUTION_MODE_REQUIRED');
    authorizeMode(executionMode,client);
    const uid=requireUserId(userId,'phase4');
    return transaction(async()=>{
      const state=await userState(uid);
      if(state.purge_generation===null)fail('PHASE4_TENANT_STATE_MISSING');
      const computation=(await client.execute({sql:'SELECT * FROM phase4_computation_state WHERE user_id=? AND execution_mode=?',args:[uid,executionMode]})).rows[0];
      if(!computation)fail('PHASE4_COMPUTATION_STATE_MISSING');
      const context=Object.freeze({userId:uid,executionMode,lifecycleGeneration:state.lifecycle_generation,
        authGeneration:state.auth_generation,inputGeneration:computation.input_generation,purgeGeneration:state.purge_generation,
        sourceGeneration:state.source_generation,timezone:state.timezone,providerRequired:Boolean(providerRequired),
        algorithmSetVersion:computation.algorithm_set_version});
      contexts.add(context);await contextRegistry.register(context);await assertContext(context);return context;
    });
  }
  async function assertContext(context,{allowPurge=false,allowInactive=false,ignoreInput=false}={}) {
    if(!contexts.has(context))fail('PHASE4_SERVER_CONTEXT_REQUIRED');
    authorizeMode(context.executionMode,client);
    await contextRegistry.assertLease(context);
    const state=await userState(context.userId);
    if(state.purge_generation===null || state.pending_purge_count===null)fail('PHASE4_PRIVACY_STATE_MISSING');
    if(!allowPurge && (state.pending_purge_count!==0 || state.purge_generation!==context.purgeGeneration))fail('PHASE4_PURGE_FENCED');
    if(!allowInactive && (state.status!=='ACTIVE' || state.lifecycle_generation!==context.lifecycleGeneration))fail('PHASE4_LIFECYCLE_FENCED');
    if(state.auth_generation!==context.authGeneration || (context.providerRequired && state.auth_generation<1))fail('PHASE4_AUTH_FENCED');
    const current=(await client.execute({sql:'SELECT * FROM phase4_computation_state WHERE user_id=? AND execution_mode=?',args:[context.userId,context.executionMode]})).rows[0];
    if(!current || (!ignoreInput && (current.input_generation!==context.inputGeneration
      || current.source_generation_seen!==state.source_generation || current.algorithm_set_version!==context.algorithmSetVersion)))fail('PHASE4_INPUT_FENCED');
    return {state,computation:current};
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
    return transaction(()=>fn(context),{before:()=>assertContext(context,options),after:()=>assertContext(context,options)});
  }
  async function runControl(control,mode,fn) {
    if(!['SHADOW','LIVE'].includes(mode))fail('PHASE4_EXECUTION_MODE_REQUIRED');
    authorizeMode(mode,client);
    return transaction(async()=>{await assertControl(control);const result=await fn();await assertControl(control);return result;});
  }
  async function runMaintenance(control,mode,fn) {
    if(!['SHADOW','LIVE'].includes(mode))fail('PHASE4_EXECUTION_MODE_REQUIRED');
    authorizeMode(mode,client);
    return transaction(async()=>{await assertPrivacyControl(control);return fn();});
  }
  async function tableInfo(table) {
    if(!DERIVED_TABLES.includes(table) && !Object.values(ROOTS).some(([t])=>t===table))fail('PHASE4_UNKNOWN_ENTITY');
    if(!columns.has(table))columns.set(table,(await client.execute(`PRAGMA table_info(${table})`)).rows);
    return columns.get(table);
  }
  function reference(context,type,id,mode,row) {
    const ref=Object.freeze({type,id:String(id),executionMode:mode});
    sources.set(ref,{context,type,id:String(id),mode,row});return ref;
  }
  function validateReferences(context,refs) {
    if(!Array.isArray(refs))fail('PHASE4_SOURCE_REFERENCES_REQUIRED');
    return refs.map(ref=>{
      const source=sources.get(ref);
      if(!source || source.context!==context || (source.mode!=='SHARED' && source.mode!==context.executionMode))fail('PHASE4_INVALID_SOURCE_REFERENCE');
      return source;
    });
  }
  async function root(context,type,id) {
    return run(context,async()=>{
      if(type==='USER') {
        if(id!==context.userId)fail('PHASE4_CROSS_TENANT_REFERENCE');
        return {row:await userState(context.userId),ref:reference(context,type,id,'SHARED',null)};
      }
      const spec=ROOTS[type];if(!spec)fail('PHASE4_ROOT_TYPE_REQUIRED');
      const [table,key]=spec,owner=type==='TELEGRAM_OPERATION'?'owner_user_id':'user_id';
      const row=(await client.execute({sql:`SELECT * FROM ${table} WHERE ${owner}=? AND ${key}=?`,args:[context.userId,id]})).rows[0];
      if(!row)fail('PHASE4_SOURCE_NOT_FOUND');
      if(['sleep','recovery','cycle','workout'].includes(type)) {
        if(context.authGeneration<1)fail('PHASE4_AUTH_FENCED');
        const access=(await client.execute({sql:`SELECT status FROM whoop_resource_access
          WHERE user_id=? AND resource=? AND auth_generation=? AND lifecycle_generation=?`,
        args:[context.userId,type,context.authGeneration,context.lifecycleGeneration]})).rows[0];
        if(access?.status!=='ACCESSIBLE')fail('PHASE4_RESOURCE_FENCED');
        const unsupported=(await client.execute({sql:`SELECT 1 FROM whoop_capabilities
          WHERE user_id=? AND key=? AND lifecycle_generation=? AND status IN ('UNSUPPORTED','UNAVAILABLE')`,
        args:[context.userId,type,context.lifecycleGeneration]})).rows.length;
        if(unsupported)fail('PHASE4_CAPABILITY_FENCED');
        if((await client.execute({sql:`SELECT 1 FROM whoop_resource_tombstones WHERE user_id=? AND resource_type=? AND resource_id=? AND state='ACTIVE'`,args:[context.userId,type,String(id)]})).rows.length)fail('PHASE4_SOURCE_DELETED');
      } else {
        if(!readableRow(row))fail('CONTENT_REDACTED');
        if(type==='JOURNAL_FACT' && row.fact_status!=='ACTIVE')fail('PHASE4_SOURCE_NOT_CURRENT');
        if(type==='JOURNAL_COVERAGE' && row.status!=='ACTIVE')fail('PHASE4_SOURCE_NOT_CURRENT');
        if(type==='EXPERIMENT_DIRECT_ASSERTION' && (row.is_current!==1 || row.provenance_state!=='DIRECT'
          || row.source_kind!=='EXPERIMENT_DIRECT_ASSERTION'))fail('PHASE4_UNPROVEN_ASSERTION');
      }
      return {row:{...row},ref:reference(context,type,id,'SHARED',row)};
    });
  }
  async function artifact(context,table,key) {
    if(!DERIVED_TABLES.includes(table))fail('PHASE4_UNKNOWN_ENTITY');
    return run(context,async()=>{
      const info=await tableInfo(table),pk=info.filter(c=>c.pk && !['user_id','execution_mode'].includes(c.name)).sort((a,b)=>a.pk-b.pk);
      if(!key || Object.keys(key).length!==pk.length || pk.some(c=>!Object.hasOwn(key,c.name)))fail('PHASE4_ENTITY_KEY_REQUIRED');
      const row=(await client.execute({sql:`SELECT * FROM ${table} WHERE user_id=? AND execution_mode=?${pk.map(c=>` AND ${c.name}=?`).join('')}`,
        args:[context.userId,context.executionMode,...pk.map(c=>key[c.name])]})).rows[0];
      if(!row)fail('PHASE4_PARENT_NOT_FOUND');
      if(Object.hasOwn(row,'content_state') && !readableRow(row))fail('CONTENT_REDACTED');
      for(const [column,value] of [['input_generation',context.inputGeneration],['lifecycle_generation',context.lifecycleGeneration],['auth_generation',context.authGeneration]])
        if(Object.hasOwn(row,column) && row[column]!==value)fail('PHASE4_PARENT_STALE');
      if(row.invalidated_at || (table==='health_insights' && row.legacy_classification!=='PHASE4'))fail('PHASE4_PARENT_STALE');
      if(!row.privacy_artifact_id)fail('PHASE4_HEALTH_PARENT_REQUIRED');
      await validateStoredGraph(context,table,row.privacy_artifact_id);
      return {row:{...row},ref:reference(context,table,row.privacy_artifact_id,context.executionMode,row)};
    });
  }
  async function validateStoredGraph(context,table,artifactId,path=new Set(),verified=new Set()) {
    const node=JSON.stringify([table,artifactId]);
    if(path.has(node) || path.size>128 || verified.size>10000)fail('PHASE4_PROVENANCE_CYCLE');
    if(verified.has(node))return;
    path.add(node);
    const logical=['observation_episodes','health_insights'].includes(table);
    const links=(await client.execute({sql:`SELECT source_execution_mode,source_type,source_id FROM phase4_source_links
      WHERE user_id=? AND artifact_execution_mode=? AND artifact_type=? AND artifact_id=? AND unlinked_at IS NULL
      ${logical?'AND relationship=?':''}`,
    args:[context.userId,context.executionMode,table,artifactId,...(logical?[`INPUT_GENERATION:${context.inputGeneration}`]:[])]})).rows;
    if(!links.length)fail('PHASE4_INCOMPLETE_PROVENANCE');
    for(const link of links) {
      if(link.source_execution_mode==='SHARED')await root(context,link.source_type,link.source_id);
      else {
        if(link.source_execution_mode!==context.executionMode || !DERIVED_TABLES.includes(link.source_type))fail('PHASE4_MIXED_MODE_PARENT');
        const parent=(await client.execute({sql:`SELECT * FROM ${link.source_type} WHERE user_id=? AND execution_mode=? AND privacy_artifact_id=?`,
          args:[context.userId,context.executionMode,link.source_id]})).rows[0];
        if(!readableRow(parent) || parent.invalidated_at
          || (link.source_type==='health_insights' && parent.legacy_classification!=='PHASE4'))fail('PHASE4_PARENT_STALE');
        for(const [column,value] of [['input_generation',context.inputGeneration],['lifecycle_generation',context.lifecycleGeneration],['auth_generation',context.authGeneration]])
          if(Object.hasOwn(parent,column) && parent[column]!==value)fail('PHASE4_PARENT_STALE');
        await validateStoredGraph(context,link.source_type,link.source_id,path,verified);
      }
    }
    path.delete(node);verified.add(node);
  }
  async function revalidateSources(context,refs) {
    const list=validateReferences(context,refs);
    for(const source of list) {
      if(source.mode==='SHARED') {
        const current=await root(context,source.type,source.id);
        if(source.row && JSON.stringify(current.row)!==JSON.stringify(source.row))fail('PHASE4_PARENT_STALE');
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
    for(const source of list)await addPrivacyLink(client,{userId:context.userId,mode:context.executionMode,table,artifactId,
      sourceMode:source.mode,sourceType:source.type,sourceId:source.id,at:timestamp(),
      relationship:['observation_episodes','health_insights'].includes(table)?`INPUT_GENERATION:${context.inputGeneration}`:'DEPENDS_ON'});
  }
  function envelope(context,table,identity,{salt=keys.newSalt()}={}) {
    if(!contexts.has(context))fail('PHASE4_SERVER_CONTEXT_REQUIRED');
    return {user_id:context.userId,execution_mode:context.executionMode,content_state:'PRESENT',source_linkage_state:'COMPLETE',
      privacy_artifact_id:keys.lookup(['privacy-artifact-v1',table,context.userId,context.executionMode,identity]),
      content_digest_salt:salt,purge_generation:context.purgeGeneration};
  }
  return Object.freeze({client,processing,transaction,keys,now,timestamp,userState,initializeTenant,capture,assertContext,captureControl,assertControl,
    capturePrivacyControl,assertPrivacyControl,run,runControl,runMaintenance,contextRegistry,
    tableInfo,root,artifact,link,envelope,validateReferences,revalidateSources,validateStoredGraph,newId:()=>randomUUID()});
}
