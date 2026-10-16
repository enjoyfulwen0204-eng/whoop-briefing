import {randomBytes,createHash} from 'node:crypto';
import {lstat} from 'node:fs/promises';
import {dirname,isAbsolute,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createClient} from '@libsql/client';
import {PHASE4_MIGRATIONS,SCHEMA} from '../src/schema.js';
import {runMigrations} from '../src/migrations.js';
import {assertPhase4Schema,normalizeSql} from '../src/phase4Migrations.js';
import {requirePhase4Keys} from '../src/phase4Keys.js';
import {stage8ProtectedFile,stage8PreservationSnapshot,verifyStage8RecoveryClient} from './stage8-migration-safety.mjs';
import {readDatabaseControl} from './stage8-production-control.mjs';

const plans=new WeakMap(),fail=code=>{throw Object.assign(Error(code),{code});};
const serial=value=>JSON.stringify(value,(_,v)=>typeof v==='bigint'?{int64:v.toString()}:v instanceof ArrayBuffer?{blob:Buffer.from(v).toString('base64')}:ArrayBuffer.isView(v)?{blob:Buffer.from(v.buffer,v.byteOffset,v.byteLength).toString('base64')}:v);
const identifier=name=>{if(!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name))fail('STAGE8_ATOMIC_IDENTIFIER_INVALID');return '"'+name+'"';};
const catalogSql=`SELECT json_group_array(json_array(type,name,tbl_name,sql)) value FROM
 (SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' OR name='sqlite_sequence' ORDER BY type,name)`;
const versionsSql=`SELECT json_group_array(json_array(version,applied_at,note)) value FROM (SELECT version,applied_at,note FROM schema_version ORDER BY version)`;
const checkpointsSql=`SELECT json_group_array(json_array(target_version,step_key,last_cursor,postcondition_state,updated_at)) value FROM
 (SELECT target_version,step_key,last_cursor,postcondition_state,updated_at FROM phase4_migration_checkpoints ORDER BY target_version,step_key)`;
const scalar=async(client,sql,args=[])=>String((await client.execute({sql,args})).rows[0]?.value);
const registered=PHASE4_MIGRATIONS.filter(m=>m.version===34||m.version===35);
const markerSql=`INSERT INTO schema_version (version, applied_at, note) VALUES (?, ?, ?)
        ON CONFLICT(version) DO NOTHING`;
const orderedWrites=registered.flatMap(m=>[...m.ddl,...(m.columns??[]).map(c=>`ALTER TABLE ${c.table} ADD COLUMN ${c.column} ${c.definition}`),
 ...(m.indexes??[]),...(m.triggers??[]),...(m.replacements??[]).flatMap(r=>[r.ddl,`DROP ${r.kind??'INDEX'} IF EXISTS ${r.oldName}`]),markerSql]);
const introducedObjects=orderedWrites.flatMap(sql=>{
 const name=/^CREATE (?:UNIQUE )?(?:TABLE|INDEX|TRIGGER) IF NOT EXISTS (\w+)/i.exec(sql)?.[1];return name?[name]:[];
});
const keyBinding=keys=>{requirePhase4Keys(keys);return serial([keys.lookup(['stage8-atomic-plan-key-continuity-v1']),
 keys.digest(keys.lookup(['stage8-atomic-plan-audit-domain-v1']),'stage8-atomic-plan-key-continuity-v1')]);};
function details(plan){const result=plans.get(plan);if(!result)fail('STAGE8_ATOMIC_PLAN_REQUIRED');return result;}
function countsSql(tables){return `SELECT json_group_array(json_array(name,n)) value FROM (${tables.map(table=>`SELECT '${table}' name,count(*) n FROM ${identifier(table)}`).join(' UNION ALL ')})`;}
const freezeStatement=value=>Object.freeze({sql:value.sql,args:Object.freeze([...(value.args??[])])});

/** Compile only the original registered ordered engine on an authenticated,
 * disposable local source33. The caller must retain its sealed original image.
 * No caller SQL, serialized plan, client or Production permit is accepted.
 * Compilation migrates this disposable local copy to35. */
export async function prepareStage8AtomicMigration(options){
 const plain=options!==null&&typeof options==='object'&&Object.getPrototypeOf(options)===Object.prototype;
 const names=plain?Reflect.ownKeys(options):[],expected=['keys','releaseSha','sourcePath','sourceSha'];
 if(arguments.length!==1||!plain||names.length!==expected.length
  ||names.some(name=>typeof name!=='string')||names.sort().join(',')!==expected.join(',')
  ||Object.values(Object.getOwnPropertyDescriptors(options)).some(value=>!Object.hasOwn(value,'value')))fail('STAGE8_ATOMIC_LOCAL_PREPARATION_REQUIRED');
 const {sourcePath,keys,releaseSha,sourceSha}=options;
 if(typeof sourcePath!=='string'||!isAbsolute(sourcePath)||sourcePath!==resolve(sourcePath)||sourcePath.includes('\0'))fail('STAGE8_ATOMIC_LOCAL_PREPARATION_REQUIRED');
 const file=await stage8ProtectedFile(sourcePath);
 if(((await lstat(file.path)).mode&0o7777)!==0o600||((await lstat(dirname(file.path))).mode&0o7777)!==0o700)fail('STAGE8_ATOMIC_LOCAL_PREPARATION_REQUIRED');
 // A fixed, encoded file URL and no auth/sync options select the installed
 // driver's actual local implementation. A caller cannot relabel a remote
 // client or pass a wrapper into the mutation-recording compiler.
 const client=createClient({url:pathToFileURL(file.path).href,intMode:'number'});
 try{return await compileStage8AtomicMigration(client,{keys,releaseSha,sourceSha});}finally{client.close();}
}
async function compileStage8AtomicMigration(client,{keys,releaseSha,sourceSha}){
 if(![releaseSha,sourceSha].every(value=>/^[a-f0-9]{40}$/.test(value??'')))fail('STAGE8_ATOMIC_RELEASE_REQUIRED');
 if(registered.length!==2||registered[0].version!==34||registered[1].version!==35)fail('STAGE8_ATOMIC_REGISTRY_CHANGED');
 const source=await readDatabaseControl(client,keys);if(source.schema!==33)fail('STAGE8_ATOMIC_SOURCE33_REQUIRED');
 const versionDefinition=(await client.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='schema_version'")).rows[0]?.sql;
 // The only data DML is marker insertion. It must have neither an unexpected
 // table definition nor a trigger capable of changing original durable rows.
 if(normalizeSql(versionDefinition)!==normalizeSql(SCHEMA.find(sql=>/^CREATE TABLE IF NOT EXISTS schema_version\b/.test(sql)))
  ||(await client.execute("SELECT 1 FROM sqlite_master WHERE type='trigger' AND tbl_name='schema_version' LIMIT 1")).rows.length)fail('STAGE8_ATOMIC_MARKER_STORAGE_INVALID');
 // This path intentionally accepts a clean33 only. Recovery from previously
 // committed/partial work retains the separate original recovery protocol.
 const sourceCatalog=await scalar(client,catalogSql),existingObjects=new Set(JSON.parse(sourceCatalog).map(row=>row[1].toLowerCase()));
 if(introducedObjects.some(name=>existingObjects.has(name.toLowerCase()))||source.snapshot.user_onboarding.columns.includes('enrollment_revision')
  ||source.snapshot.tenant_delivery_modes.columns.includes('cutover_health_date'))fail('STAGE8_ATOMIC_CLEAN33_REQUIRED');
 const tables=Object.keys(source.snapshot),sourceVersions=await scalar(client,versionsSql),sourceCheckpoints=await scalar(client,checkpointsSql);
 const sourceCounts=await scalar(client,countsSql(tables)),fixedAt=new Date().toISOString();
 const guardName='stage8_atomic_guard_'+randomBytes(12).toString('hex'),guard=identifier(guardName),statements=[{sql:`CREATE TEMP TABLE ${guard}(ok INTEGER NOT NULL CHECK(ok=1))`}];
 const check=(predicate,args=[])=>statements.push({sql:`INSERT INTO temp.${guard}(ok) SELECT CASE WHEN (${predicate}) THEN 1 ELSE 0 END`,args});
 check(`(${catalogSql})=?`,[sourceCatalog]);check(`(${versionsSql})=?`,[sourceVersions]);check(`(${checkpointsSql})=?`,[sourceCheckpoints]);check(`(${countsSql(tables)})=?`,[sourceCounts]);
 const steps=[];let mutation=0;
 const boundary=async version=>{
  check(`(${catalogSql})=?`,[await scalar(client,catalogSql)]);
  check(`(${countsSql(tables)})=?`,[sourceCounts]);
  check(`(${checkpointsSql})=?`,[sourceCheckpoints]);
  const introduced=registered.filter(m=>m.version<=version).flatMap(m=>m.ddl.map(sql=>/^CREATE TABLE IF NOT EXISTS (\w+)/.exec(sql)?.[1]).filter(Boolean));
  check(introduced.map(table=>`NOT EXISTS(SELECT 1 FROM ${identifier(table)} LIMIT 1)`).join(' AND '));
  check(`NOT EXISTS(SELECT 1 FROM user_onboarding WHERE enrollment_revision<>0) AND NOT EXISTS(SELECT 1 FROM tenant_delivery_modes WHERE cutover_health_date IS NOT NULL)`);
  check(`(SELECT count(*)=1 AND min(integrity_check)='ok' FROM pragma_integrity_check) AND NOT EXISTS(SELECT 1 FROM pragma_foreign_key_check)`);
 };
 const recording={execute:async query=>{
  const sql=typeof query==='string'?query:query.sql;
  if(!/^(CREATE|ALTER|DROP|INSERT|UPDATE|DELETE)\b/i.test(sql.trim()))return client.execute(query);
  if(sql!==orderedWrites[mutation])fail('STAGE8_ATOMIC_UNREGISTERED_MUTATION');
  let statement={sql,args:typeof query==='string'?[]:[...(query.args??[])]};
  const marker=sql===markerSql;
  if(marker){
   const version=statement.args[0];if(![34,35].includes(version)||statement.args[2]!==`phase4 v${version} postconditions verified`)fail('STAGE8_ATOMIC_MARKER_INVALID');
   await boundary(version);statement.args[1]=fixedAt;
  }
  mutation++;const result=await client.execute(statement);statements.push(statement);
  // Exact authoritative schema definitions are checked within the server batch,
  // immediately after each DDL, including ALTER and the two trigger replacements.
  const created=/^CREATE (?:UNIQUE )?(?:TABLE|INDEX|TRIGGER) IF NOT EXISTS (\w+)/i.exec(sql),altered=/^ALTER TABLE (\w+)/i.exec(sql),dropped=/^DROP (?:TABLE|INDEX|TRIGGER) IF EXISTS (\w+)/i.exec(sql);
  if(created||altered){const name=(created??altered)[1],row=(await client.execute({sql:'SELECT type,tbl_name,sql FROM sqlite_master WHERE name=?',args:[name]})).rows[0];
   if(!row)fail('STAGE8_ATOMIC_SCHEMA_OBJECT_MISSING');
   check(`(SELECT count(*) FROM sqlite_master WHERE name=? AND type=? AND tbl_name=? AND sql=?)=1`,[name,row.type,row.tbl_name,row.sql]);
  }else if(dropped)check(`NOT EXISTS(SELECT 1 FROM sqlite_master WHERE name=?)`,[dropped[1]]);
  return result;
 },batch:()=>fail('STAGE8_ATOMIC_UNEXPECTED_ENGINE_BATCH')};
 for(const [from,to] of [[33,34],[34,35]]){
  const before=await stage8PreservationSnapshot(client,keys),result=await runMigrations(recording,{allowRebuild:false,targetVersion:to,privacyKeys:keys});
  if(serial(result.versionsApplied)!==serial([to]))fail('STAGE8_ATOMIC_ORDER_CHANGED');
  await assertPhase4Schema(client,to);await verifyStage8RecoveryClient(client,keys);
  if(serial(before)!==serial(await stage8PreservationSnapshot(client,keys,before))||serial(source.snapshot)!==serial(await stage8PreservationSnapshot(client,keys,source.snapshot)))fail('STAGE8_PRESERVED_DATA_CHANGED');
  const verified=await readDatabaseControl(client,keys);
  if(Object.entries(verified.snapshot).some(([table,value])=>!before[table]&&value.count!==0))fail('STAGE8_UNEXPECTED_MIGRATION_DATA');
  if(await scalar(client,checkpointsSql)!==sourceCheckpoints||await scalar(client,`${versionsSql.replace('FROM schema_version ORDER BY version','FROM schema_version WHERE version<=33 ORDER BY version')}`)!==sourceVersions)fail('STAGE8_CHECKPOINT_HISTORY_CHANGED');
  steps.push(Object.freeze({from,to,versionsApplied:Object.freeze([to]),preservedTables:Object.keys(before).length,integrity:'ok'}));
 }
 if(mutation!==orderedWrites.length)fail('STAGE8_ATOMIC_ORDER_CHANGED');
 const noop=await runMigrations(recording,{allowRebuild:false,targetVersion:35,privacyKeys:keys});if(noop.versionsApplied.length)fail('STAGE8_ATOMIC_ORDER_CHANGED');
 await assertPhase4Schema(client,35);await verifyStage8RecoveryClient(client,keys);
 const target=await readDatabaseControl(client,keys),targetCatalog=await scalar(client,catalogSql),targetVersions=await scalar(client,versionsSql);
 if(serial(source.snapshot)!==serial(await stage8PreservationSnapshot(client,keys,source.snapshot)))fail('STAGE8_PRESERVED_DATA_CHANGED');
 await boundary(35);check(`(${versionsSql})=?`,[targetVersions]);
 statements.push({sql:`DROP TABLE temp.${guard}`});
 const frozen=Object.freeze(statements.map(freezeStatement)),plan=Object.freeze({contract:'stage8-original-ordered-atomic-plan-v1',from:33,to:35,versionsApplied:Object.freeze([34,35]),statementCount:frozen.length,mutationCount:mutation});
 plans.set(plan,{keys:keyBinding(keys),releaseSha,sourceSha,source,target,sourceCatalog,targetCatalog,sourceVersions,targetVersions,sourceCheckpoints,statements:frozen,
  steps:Object.freeze([...steps,Object.freeze({from:35,to:35,versionsApplied:Object.freeze([]),preservedTables:Object.keys(target.snapshot).length,integrity:'ok'})])});
 return plan;
}

/** Only the private Production operator owns remote execution authority. These
 * immutable statements are issued solely from a local original-engine plan. */
export function stage8AtomicPlanStatements(plan){return details(plan).statements;}
export function stage8AtomicPlanSteps(plan){return details(plan).steps;}
export function assertStage8AtomicPlanBinding(plan,{keys,releaseSha,sourceSha,sourceDigest}){
 const value=details(plan);if(value.keys!==keyBinding(keys)||value.releaseSha!==releaseSha||value.sourceSha!==sourceSha||value.source.digest!==sourceDigest)fail('STAGE8_ATOMIC_PLAN_BINDING_REQUIRED');
 return {sourceDigest:value.source.digest,targetDigest:value.target.digest};
}

/** Durable reconciliation metadata only. This contains no statements, client,
 * permit or deserialization path back into the private executable plan. */
export function stage8AtomicPlanEvidence(plan,binding){
 assertStage8AtomicPlanBinding(plan,binding);const value=details(plan),markers=serialized=>Object.freeze(JSON.parse(serialized)
  .map(([version,appliedAt,note])=>Object.freeze({version,appliedAt,note})));
 return Object.freeze({contract:'stage8-atomic-reconciliation-evidence-v1',from:33,to:35,releaseSha:value.releaseSha,sourceSha:value.sourceSha,
  sourceDigest:value.source.digest,targetDigest:value.target.digest,sourceHistoryDigest:value.source.history,targetHistoryDigest:value.target.history,
  sourceCatalogDigest:binding.keys.lookup(['stage8-atomic-recovery-catalog-v1',value.sourceCatalog]),
  targetCatalogDigest:binding.keys.lookup(['stage8-atomic-recovery-catalog-v1',value.targetCatalog]),
  targetPreservation:binding.keys.lookup(['stage8-preservation-all-v1',value.target.snapshot]),keyContinuity:value.keys,
  statementPacketSha256:createHash('sha256').update(serial(value.statements)).digest('hex'),statementCount:plan.statementCount,mutationCount:plan.mutationCount,
  originalVersionMarkers:markers(value.sourceVersions),preparedMarkers:Object.freeze(markers(value.targetVersions).filter(marker=>marker.version>33))});
}

/** A fresh authenticated read can prove the complete prepared35. Observing33
 * after a lost response does NOT prove a queued request can never commit later.
 * The operator keeps maintenance closed for every other outcome. */
export async function reconcileStage8AtomicPlan(client,plan,{keys}){
 const value=details(plan);if(value.keys!==keyBinding(keys))fail('STAGE8_ATOMIC_PLAN_BINDING_REQUIRED');
 try{
  const observed=await readDatabaseControl(client,keys),catalog=await scalar(client,catalogSql);
  if(observed.schema===35&&observed.digest===value.target.digest&&catalog===value.targetCatalog)return {status:'PREPARED35_VERIFIED',digest:observed.digest,schema:35,commitVerified:true};
  if(observed.schema===33&&observed.digest===value.source.digest&&catalog===value.sourceCatalog)return {status:'SOURCE33_OBSERVED_COMMIT_UNCERTAIN',digest:observed.digest,schema:33,commitVerified:false};
 }catch{}
 return {status:'UNKNOWN_KEEP_MAINTENANCE',commitVerified:false};
}
