/** Read-only v32 contract compiled from the same frozen DDL used by migrations.
 * No tenant/history query, migration, checkpoint initialization or schema repair. */
import { SCHEMA, ADDITIVE_COLUMNS, PHASE4_MIGRATIONS, SCHEMA_VERSION, RETAINED_LEGACY_TABLE_DDL } from './schema.js';
import { normalizeSql, withAddedColumns, Phase4SchemaError } from './phase4Migrations.js';
import { requirePhase4Keys } from './phase4Keys.js';
import { log } from './logger.js';
import {withRuntimeMetadata} from './runtimeMetadataContext.js';
import {currentExecutionBudget} from './executionBudget.js';
import {currentDurableExecution} from './phase4ExecutionContext.js';
import {requireSchemaTransitionRuntimeProfile,bindSchemaTransitionRuntimeProfile} from './schemaTransitionProfile.js';
import {requireSupervisorRuntimeEpochCatalog} from './runtimeEpochScope.js';

const connections = new WeakMap(), capabilities = new WeakMap();
const fail = (code, object) => { throw new Phase4SchemaError(code, object); };

// Capability identity is useful inside a private runtime. Caller-owned raw
// clients have no observable native lifetime primitive: their privileged SQL
// boundaries must always perform a new complete metadata admission.
export function bindConnectionLifetime(base, executor, transaction, {runtimeProfile,runtimeEpoch,keys}={}) {
  if(runtimeProfile!==undefined)bindSchemaTransitionRuntimeProfile(runtimeProfile,keys,base);
  if(runtimeEpoch!==undefined)requireSupervisorRuntimeEpochCatalog(runtimeEpoch,keys);
  let state=connections.get(base);
  if(!state){state={lifetime:{revoked:false},closed:false,ended:false,renewals:new Set(),runtimeProfile,runtimeEpoch,profileKeys:keys};connections.set(base,state);}
  else if(state.runtimeProfile!==runtimeProfile||state.runtimeEpoch!==runtimeEpoch||(runtimeProfile!==undefined||runtimeEpoch!==undefined)&&state.profileKeys!==keys)fail('SCHEMA_TRANSITION_CONNECTION_PROFILE_CHANGED');
  connections.set(executor,state);state.transaction=transaction;
  state.retryMetadata=async()=>{
    if(state.ended)fail('PHASE4_RUNTIME_CONNECTION_REQUIRED');
    if(currentDurableExecution())fail('RUNTIME_REPLACEMENT_REQUIRED');
    if(base.protocol==='file') {await base.reconnect();replaceObservedRuntimeLifetime(executor);}
  };
}
export function replaceObservedRuntimeLifetime(client){
 const state=connections.get(client);if(state?.ended)fail('PHASE4_RUNTIME_CONNECTION_REQUIRED');
 if(state){state.lifetime.revoked=true;state.lifetime={revoked:false};state.closed=false;}
}
export function endRuntimeLifetime(client) {
 const state=connections.get(client);if(state){state.ended=true;state.closed=true;state.lifetime.revoked=true;state.renewals.clear();}
}
export const runtimeWasAdmitted=client=>Boolean(connections.get(client)?.admitted);
// Only already-authorized server factories can follow the kernel's explicit
// read-only re-admission after idle contention reconnect. Old capabilities are
// still permanently rejected by requireRuntimeAdmission.
export function followRuntimeRenewal(client,capability,keys,transaction,replace) {
  requireRuntimeAdmission(client,capability,keys,transaction);
  const listeners=connections.get(client).renewals,listener={keys,transaction,replace};
  listeners.add(listener);return ()=>listeners.delete(listener);
}
export async function renewRuntimeAfterContention(client,keys,transaction) {
  if(!connections.get(client)?.admitted)return undefined; // Historical v27-30 factories retain their explicit assertion contract.
  const next=await admitRuntime(client,keys);
  requireRuntimeAdmission(client,next,keys,transaction);
  for(const listener of connections.get(client).renewals)
    if(listener.keys===keys&&listener.transaction===transaction)listener.replace(next);
  return next;
}

// Separate top-level table elements; quoted strings and nested CHECK/FK clauses
// remain intact. Column order may differ across approved ALTER histories.
function withoutComments(sql) {
  let out = '', quote = null;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (quote) { out += c; if (c === quote) { if (sql[i+1] === quote) out += sql[++i]; else quote = null; } continue; }
    if (["'", '"', '`'].includes(c)) { quote = c; out += c; continue; }
    if (c === '-' && sql[i+1] === '-') { while (i < sql.length && sql[i] !== '\n') i++; out += ' '; continue; }
    if (c === '/' && sql[i+1] === '*') { i += 2; while (i < sql.length && !(sql[i] === '*' && sql[i+1] === '/')) i++; i++; out += ' '; continue; }
    out += c;
  }
  return out;
}
function elements(sql) {
  sql = withoutComments(sql);
  const body = sql.slice(sql.indexOf('(') + 1, sql.lastIndexOf(')'));
  const parts = []; let start = 0, depth = 0, quote = null;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (quote) { if (c === quote) { if (body[i+1] === quote) i++; else quote = null; } continue; }
    if (["'", '"', '`'].includes(c)) { quote = c; continue; }
    if (c === '(') depth++;
    if (c === ')') depth--;
    if (c === ',' && depth === 0) { parts.push(body.slice(start, i).trim()); start = i + 1; }
  }
  parts.push(body.slice(start).trim());
  return parts;
}
const columnName = part => /^(\w+)\s/.exec(part)?.[1];
const object = ddl => {
  const [, kind, name] = /^CREATE (TABLE|(?:UNIQUE )?INDEX|TRIGGER) IF NOT EXISTS (\w+)/i.exec(ddl) ?? [];
  if (!name) fail('phase4_invalid_migration_definition');
  return { type: kind.toLowerCase().replace('unique ', ''), name, ddl };
};

export function canonicalRuntimeContract(version=SCHEMA_VERSION) {
  const objects = new Map();
  for (const ddl of SCHEMA) { const item = object(ddl); objects.set(item.name, item); }
  const additions = ADDITIVE_COLUMNS.map(c => ({...c,
    definition: c.ddl.slice(c.ddl.indexOf(`ADD COLUMN ${c.column} `) + `ADD COLUMN ${c.column} `.length),
  }));
  const retired = new Set();
  for (const migration of PHASE4_MIGRATIONS.filter(m=>m.version<=version)) {
    additions.push(...(migration.columns ?? []));
    for (const ddl of [...migration.ddl, ...(migration.indexes ?? []), ...(migration.triggers ?? [])]) {
      const item = object(ddl); objects.set(item.name, item);
    }
    for (const r of migration.replacements ?? []) {
      retired.add(r.oldName); objects.delete(r.oldName);
      const item = object(r.ddl); objects.set(item.name, item);
    }
  }
  for (const item of objects.values()) if (item.type === 'table') {
    const names = new Set(elements(item.ddl).map(columnName));
    const added = additions.filter(c => c.table === item.name && !names.has(c.column));
    item.ddl = withAddedColumns(withoutComments(item.ddl), added);
    // Legacy columns can have an approved historical ADD COLUMN default which
    // differs from a fresh CREATE. Exact retained definitions are declared in
    // schema.js; runtime enum membership never grants default compatibility.
    item.variants = additions.filter(c => c.table === item.name && names.has(c.column))
      .flatMap(c => [c, ...(c.historicalDefinitions ?? []).map(definition => ({...c, definition}))]);
  }
  return { objects, retired };
}
const contracts = new Map([33,34,35].map(version=>[version,canonicalRuntimeContract(version)]));
function tableMatches(actual, expected) {
  if (normalizeSql(actual.slice(actual.lastIndexOf(')') + 1)) !== normalizeSql(expected.ddl.slice(expected.ddl.lastIndexOf(')') + 1))) return false;
  const parts = elements(actual).map(normalizeSql).sort();
  const wanted = elements(expected.ddl).map(normalizeSql);
  if (parts.length !== wanted.length) return false;
  return wanted.every(part => {
    if (parts.includes(part)) return true;
    const name = columnName(part);
    return expected.variants.some(c => c.column === name && parts.includes(normalizeSql(`${c.column} ${c.definition}`)));
  });
}

export function requireRuntimeAdmission(client, capability, keys, transaction) {
  const issued = capabilities.get(capability), state = connections.get(client);
  if(state&&client.closed){state.lifetime.revoked=true;state.closed=true;}
  if (!issued || issued.client !== client || !state || state.closed || client.closed
      || issued.lifetime.revoked || issued.lifetime !== state.lifetime || issued.keys !== keys || (transaction && state.transaction !== transaction))
    fail('PHASE4_RUNTIME_ADMISSION_REQUIRED');
  if(state.runtimeProfile!==undefined)requireSchemaTransitionRuntimeProfile(state.runtimeProfile,keys);
  if(state.runtimeEpoch!==undefined&&requireSupervisorRuntimeEpochCatalog(state.runtimeEpoch,keys).schema!==issued.version)fail('RUNTIME_EPOCH_SCHEMA_ADMISSION_MISMATCH');
  return issued.version;
}

// Runner reuse checks the private issuer record, never a caller's facade method.
export function requireRuntimeConnection(client, capability, transaction) {
  return requireRuntimeAdmission(client, capability, capabilities.get(capability)?.keys, transaction);
}

export async function admitRuntime(client, keys, { source = 'manual' } = {}) {
  const started = performance.now();
  log.info('runtime_admission_start', { source });
  try {
    const stats={queries:0};const budget=currentExecutionBudget(),deadline=Math.min(budget?.deadlineAt??Infinity,Date.now()+15000);
    let capability;
    for(let attempt=0;;attempt++){
      budget?.assert();
      try{capability=await withRuntimeMetadata(()=>admitChecked(client,keys,stats));break;}
      catch(error){
        if(!/^(SQLITE_BUSY|SQLITE_LOCKED)(_|$)/.test(error?.code??'')||attempt>=64||Date.now()>=deadline)throw error;
        await connections.get(client)?.retryMetadata?.();
        budget?.assert();await new Promise(resolve=>setTimeout(resolve,Math.max(0,Math.min(25*2**Math.min(attempt,4)+Math.floor(Math.random()*10),250,deadline-Date.now()))));
      }
    }
    log.info('runtime_admission_complete', { source, outcome: 'COMPLETE', duration_ms: performance.now()-started, query_count:stats.queries });
    return capability;
  } catch (error) {
    log.info('runtime_admission_complete', { source, outcome: 'FAILED', duration_ms: performance.now()-started });
    throw error;
  }
}

async function admitChecked(client, keys,stats) {
  const read=async sql=>{
    currentExecutionBudget()?.assert();stats.queries++;
    const result=await client.execute(sql);currentExecutionBudget()?.assert();return result;
  };
  requirePhase4Keys(keys);
  const state = connections.get(client);
  if (!state || state.closed || client.closed) fail('PHASE4_RUNTIME_CONNECTION_REQUIRED');
  if(state.runtimeProfile!==undefined)requireSchemaTransitionRuntimeProfile(state.runtimeProfile,keys);
  const lifetime = state.lifetime;
  const epochCatalog=state.runtimeEpoch===undefined?undefined:requireSupervisorRuntimeEpochCatalog(state.runtimeEpoch,keys);
  const metadata = await read(state.runtimeProfile!==undefined||epochCatalog!==undefined
    ?"SELECT type,name,tbl_name,sql FROM sqlite_master WHERE type IN ('table','index','trigger','view')"
    :"SELECT type,name,sql FROM sqlite_master WHERE type IN ('table','index','trigger')");
  const versions=(await read('SELECT version,note FROM schema_version')).rows;
  const version=Math.max(0,...versions.map(r=>Number(r.version)));
   if(version!==33)fail('RECOVERY_V33_REQUIRED');
  if(version<SCHEMA_VERSION&&!(version===33&&state.runtimeProfile!==undefined))fail('PHASE4_CONTROLLED_MIGRATION_REQUIRED',`${version}/${SCHEMA_VERSION}`);
  if(state.runtimeProfile!==undefined&&![33,35].includes(version))fail('SCHEMA_TRANSITION_COMMITTED_VERSION_REQUIRED');
  if (!contracts.has(version)) fail('phase4_schema_version_mismatch', `${version}/${SCHEMA_VERSION}`);
  const contract=contracts.get(version);
  // A fixed supervisor scope authorizes only the exact authenticated permanent
  // trigger manifest. No prefix/name/JSON option can widen the base contract.
  // Validate EVERY row before Map collapse, including a same-name trigger on a
  // canonical table. A later reconnect retains this scope and cannot adopt C/D.
  if(epochCatalog!==undefined&&epochCatalog.schema!==version)
    fail('RUNTIME_EPOCH_SCHEMA_ADMISSION_MISMATCH');
  if(version===33&&state.runtimeProfile!==undefined||epochCatalog!==undefined){
    const expectedEpoch=new Map(),seenEpoch=new Set(),seenCatalog=new Set();
    for(const row of epochCatalog?.rows??[]){
      if(row.type!=='trigger'||typeof row.name!=='string'||typeof row.tbl_name!=='string'||typeof row.sql!=='string'
        ||row.name.startsWith('sqlite_')||contract.objects.has(row.name)||Object.hasOwn(RETAINED_LEGACY_TABLE_DDL,row.name)||expectedEpoch.has(row.name))
        fail('RUNTIME_EPOCH_CAPTURED_MANIFEST_INVALID');
      expectedEpoch.set(row.name,row);
    }
    for(const row of metadata.rows){
      const identity=row.type+'\0'+row.name;
      if(seenCatalog.has(identity))fail('SCHEMA_TRANSITION_DUPLICATE_SCHEMA_OBJECT',row.name);
      seenCatalog.add(identity);
      if(row.name.startsWith('sqlite_'))continue;
      const expected=contract.objects.get(row.name);
      if(expected){
        if(row.type!==expected.type||(expected.type==='table'?!tableMatches(row.sql,expected):normalizeSql(row.sql)!==normalizeSql(expected.ddl)))
          fail('phase4_schema_postcondition_failed',row.name);
        continue;
      }
      const extra=expectedEpoch.get(row.name);
      if(extra){
        if(row.type!==extra.type||row.tbl_name!==extra.tbl_name||normalizeSql(row.sql)!==normalizeSql(extra.sql)||seenEpoch.has(row.name))
          fail('RUNTIME_EPOCH_EXACT_FENCE_MANIFEST_REQUIRED',row.name);
        seenEpoch.add(row.name);continue;
      }
      if(!Object.hasOwn(RETAINED_LEGACY_TABLE_DDL,row.name))
        fail('SCHEMA_TRANSITION_UNEXPECTED_SCHEMA_OBJECT',row.name);
      if(row.type!=='table'||normalizeSql(row.sql)!==normalizeSql(RETAINED_LEGACY_TABLE_DDL[row.name]))
        fail('SCHEMA_TRANSITION_RETAINED_LEGACY_DEFINITION_INVALID',row.name);
    }
    if(seenEpoch.size!==expectedEpoch.size)fail('RUNTIME_EPOCH_EXACT_FENCE_MANIFEST_REQUIRED');
  }
  const actual = new Map(metadata.rows.map(r => [r.name, r]));
  for (const expected of contract.objects.values()) {
    const got = actual.get(expected.name);
    if (!got || got.type !== expected.type || (expected.type === 'table'
        ? !tableMatches(got.sql, expected) : normalizeSql(got.sql) !== normalizeSql(expected.ddl)))
      fail('phase4_schema_postcondition_failed', expected.name);
  }
  for (const name of contract.retired) if (actual.has(name)) fail('phase4_retired_index_present', name);
  for(const migration of PHASE4_MIGRATIONS.filter(m=>m.version<=version))if(!versions.some(r=>Number(r.version)===migration.version&&r.note===`phase4 v${migration.version} postconditions verified`))fail('PHASE4_VERSION_AUTHORITY_INCOMPLETE',String(migration.version));
  const rows = (await read(`SELECT target_version,step_key,last_cursor,postcondition_state
    FROM phase4_migration_checkpoints WHERE target_version IN (21,22,23,32)`)).rows;
  for (const [v, step] of [[21,'tenant_metadata'],[22,'privacy_backfill'],[22,'lookup_key_check'],[22,'audit_key_check'],[23,'legacy_insights'],[32,'execution_authority']]) {
    const row = rows.find(r => r.target_version === v && r.step_key === step);
    if (row?.postcondition_state !== 'COMPLETE') fail('PHASE4_AUTHORITY_CHECKPOINT_INCOMPLETE', step);
    if(step==='execution_authority'&&row.last_cursor!=='phase4-execution-v2')fail('PHASE4_AUTHORITY_CHECKPOINT_INCOMPLETE',step);
    if (step === 'lookup_key_check' && !keys.verifyLookupCheckpoint(row.last_cursor)) fail('PHASE4_LOOKUP_KEY_MISMATCH');
    if (step === 'audit_key_check' && !keys.verifyAuditCheckpoint(row.last_cursor)) fail('PHASE4_AUDIT_KEY_MISMATCH');
  }
  const foreignKeys = (await read('PRAGMA foreign_keys')).rows[0];
  if (Number(foreignKeys?.foreign_keys) !== 1) fail('PHASE4_FOREIGN_KEYS_DISABLED');
  // Turso's SQL gateway rejects this PRAGMA spelling. Its read-only table
  // function exposes the same connection setting without changing enforcement.
  const checkConstraints = (await read('SELECT ignore_check_constraints FROM pragma_ignore_check_constraints()')).rows;
  if (checkConstraints.length !== 1 || checkConstraints[0]?.ignore_check_constraints !== 0) fail('PHASE4_CHECK_CONSTRAINTS_DISABLED');
  if (lifetime.revoked || lifetime !== state.lifetime || state.closed) fail('PHASE4_RUNTIME_CONNECTION_CHANGED');
  if(state.runtimeProfile!==undefined)requireSchemaTransitionRuntimeProfile(state.runtimeProfile,keys);
  currentExecutionBudget()?.assert();
  if(state.runtimeEpoch!==undefined&&requireSupervisorRuntimeEpochCatalog(state.runtimeEpoch,keys).schema!==version)fail('RUNTIME_EPOCH_SCHEMA_ADMISSION_MISMATCH');
  state.admitted=true;
  const capability = Object.freeze({}); capabilities.set(capability, { client, lifetime, keys, version });
  return capability;
}
