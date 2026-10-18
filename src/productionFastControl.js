/** Fixed registry control. No import-time I/O or supplied client.
 * Full original comparisons belong BEFORE/AFTER this short native batch.
 * This metadata gate is not a full-base or drained-runtime certification.
 */
import {createClient} from '@libsql/client';
import {createHash} from 'node:crypto';
import {isProxy} from 'node:util/types';
import {phase4AuthorityKeys} from './phase4EnvironmentKeys.js';
import {PROFILE_REVISION_PREFIX} from './profileRevision.js';
import {
 PRODUCTION_EPOCH_TARGET as P,authenticateProductionEpochQualification,
 createProductionEpochBootstrap,requireProductionEpochBootstrap,
 captureProductionEpochCatalogContract,projectProductionEpochCatalogRows,
} from './productionEpochBootstrap.js';

const DOMAIN='production-fast-epoch-control-r4-v1',ALL=PROFILE_REVISION_PREFIX+'operator:';
const held=new WeakMap(),fail=code=>{throw Object.assign(Error(code),{code});};
const serial=JSON.stringify,sha=x=>createHash('sha256').update(typeof x==='string'?x:serial(x)).digest('hex');
const same=(a,b)=>serial(a)===serial(b);
const freeze=x=>{if(x&&typeof x==='object'){Object.values(x).forEach(freeze);Object.freeze(x);}return x;};
function owned(x,depth=0){
 if(depth>50||isProxy(x))fail('FAST_CONTROL_OWNED_DATA_REQUIRED');
 if(x===null||typeof x==='string'||typeof x==='boolean')return x;
 if(typeof x==='number'&&Number.isSafeInteger(x)&&!Object.is(x,-0))return x;
 if(!x||typeof x!=='object')fail('FAST_CONTROL_OWNED_DATA_REQUIRED');
 const a=Array.isArray(x),ks=Reflect.ownKeys(x),ds=Object.getOwnPropertyDescriptors(x);
 if(Object.getPrototypeOf(x)!==(a?Array.prototype:Object.prototype)||ks.some(k=>typeof k!=='string'||k==='__proto__'||!Object.hasOwn(ds[k],'value')))fail('FAST_CONTROL_OWNED_DATA_REQUIRED');
 if(a){if(ks.length!==x.length+1||ks.some((k,i)=>i<x.length&&k!==String(i)))fail('FAST_CONTROL_OWNED_DATA_REQUIRED');return x.map(v=>owned(v,depth+1));}
 return Object.fromEntries(ks.map(k=>[k,owned(ds[k].value,depth+1)]));
}
function exact(x,names){if(isProxy(x)||!x||Object.getPrototypeOf(x)!==Object.prototype||Reflect.ownKeys(x).length!==names.length||names.some(k=>!Object.hasOwn(x,k))||Object.values(Object.getOwnPropertyDescriptors(x)).some(d=>!Object.hasOwn(d,'value')))fail('FAST_CONTROL_EXACT_OPTIONS_REQUIRED');}
function clock(w){const now=Date.now();if(now<w.originalWindowStartMs||now>=w.originalWindowEndMs)fail('FAST_CONTROL_ORIGINAL_WINDOW_EXPIRED');return now;}
const catalogRead="SELECT type,name,tbl_name,rootpage,sql FROM sqlite_master WHERE type IN ('table','index','trigger','view') ORDER BY type,name";
const catalogScalar=`SELECT json_group_array(json_array(type,name,tbl_name,rootpage,sql)) FROM (${catalogRead})`;
const versionsRead='SELECT version,applied_at,note FROM schema_version ORDER BY version';
const versionsScalar=`SELECT json_group_array(json_array(version,applied_at,note)) FROM (${versionsRead})`;
const checkpointsRead='SELECT target_version,step_key,last_cursor,postcondition_state,updated_at FROM phase4_migration_checkpoints ORDER BY target_version,step_key';
const checkpointsScalar=`SELECT json_group_array(json_array(target_version,step_key,last_cursor,postcondition_state,updated_at)) FROM (${checkpointsRead})`;
const operatorRead='SELECT key,value,updated_at FROM telegram_state WHERE substr(key,1,?)=? ORDER BY key';
const operatorScalar=`SELECT json_group_array(json_array(key,value,updated_at)) FROM (${operatorRead})`;
const rowRead='SELECT key,value,updated_at FROM telegram_state WHERE key=?';
const rowScalar=`SELECT json_group_array(json_array(key,value,updated_at)) FROM (${rowRead})`;
const rosterRead=`SELECT u.id user_id,u.status,u.lifecycle_generation,t.whoop_user_id,t.auth_generation,p.source_generation,p.purge_generation,p.pending_purge_count
 FROM users u JOIN user_whoop_tokens t ON t.user_id=u.id JOIN phase4_user_state p ON p.user_id=u.id
 WHERE u.id IN (?,?,?) ORDER BY u.id`;
const rosterScalar=`SELECT json_group_array(json_array(user_id,status,lifecycle_generation,whoop_user_id,auth_generation,source_generation,purge_generation,pending_purge_count)) FROM (${rosterRead})`;
const toArrays=(rows,columns)=>rows.map(r=>columns.map(k=>r[k]));
const controls=(s,label)=>[s.records.find(r=>r.label===label),s.qualificationTransport].map(r=>({key:r.key,value:r.value,updated_at:r.updated_at})).sort((a,b)=>a.key<b.key?-1:1);
const serverNow="CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)";

function validateMetadata(m,s,q,keys,reference){
 const projected=projectProductionEpochCatalogRows(reference,keys,m.catalog.map(({type,name,tbl_name,sql})=>({type,name,tbl_name,sql})));
 if(keys.lookup(['production-transition-r3-actual-catalog-v1',projected.rows])!==q.body.sourceCatalogDigest)fail('FAST_CONTROL_ORIGINAL_CANONICAL_CATALOG_REQUIRED');
 const expected=new Map(),coverage=new Map(s.sourceTables.map(t=>[t,new Set()]));
 for(const statement of s.sourceTriggers){
  const hit=/^CREATE TRIGGER "([^"]+)" BEFORE (INSERT|UPDATE|DELETE) ON "([^"]+)"/.exec(statement.sql);
  if(!hit||expected.has(hit[1])||!coverage.has(hit[3])||coverage.get(hit[3]).has(hit[2]))fail('FAST_CONTROL_EXACT_THREE_FENCES_PER_TABLE_REQUIRED');
  expected.set(hit[1],{table:hit[3],sql:statement.sql});coverage.get(hit[3]).add(hit[2]);
 }
 if(expected.size!==s.sourceTables.length*3||[...coverage.values()].some(v=>v.size!==3))fail('FAST_CONTROL_EXACT_THREE_FENCES_PER_TABLE_REQUIRED');
 for(const [name,e]of expected){const found=m.catalog.filter(r=>r.name===name);if(found.length!==1||found[0].type!=='trigger'||found[0].tbl_name!==e.table||found[0].sql!==e.sql||found[0].rootpage!==0)fail('FAST_CONTROL_EXACT_THREE_FENCES_PER_TABLE_REQUIRED');}
 const tables=m.catalog.filter(r=>r.type==='table'&&!r.name.startsWith('sqlite_')).map(r=>r.name).sort();
 if(!same(tables,s.sourceTables)||m.catalog.some(r=>!Number.isSafeInteger(r.rootpage)||r.rootpage<0))fail('FAST_CONTROL_EXACT_SOURCE_TABLES_REQUIRED');
 if(!same(m.operators,controls(s,'A_BUSINESS33')))fail('FAST_CONTROL_EXACT_TWO_CONTROLS_NO_PERMIT_REQUIRED');
 const boot={key:s.bootRow.key,value:s.bootRow.value,updated_at:s.bootRow.updated_at},transport={key:s.qualificationTransport.key,value:s.qualificationTransport.value,updated_at:s.qualificationTransport.updated_at};
 if(!same(m.boot,[boot])||!same(m.transport,[transport]))fail('FAST_CONTROL_EXACT_BOOT_AND_QUALIFICATION_REQUIRED');
 if(Math.max(...m.versions.map(r=>r.version))!==33)fail('FAST_CONTROL_SOURCE33_REQUIRED');
 for(let version=21;version<=33;version++)if(m.versions.filter(r=>r.version===version&&r.note===`phase4 v${version} postconditions verified`).length!==1)fail('FAST_CONTROL_EXACT_VERSION_HISTORY_REQUIRED');
 for(const [version,step]of [[21,'tenant_metadata'],[22,'privacy_backfill'],[22,'lookup_key_check'],[22,'audit_key_check'],[23,'legacy_insights'],[32,'execution_authority']]){
  const rows=m.checkpoints.filter(r=>r.target_version===version&&r.step_key===step),r=rows[0];
  if(rows.length!==1||r.postcondition_state!=='COMPLETE'||step==='lookup_key_check'&&!keys.verifyLookupCheckpoint(r.last_cursor)||step==='audit_key_check'&&!keys.verifyAuditCheckpoint(r.last_cursor)||step==='execution_authority'&&r.last_cursor!=='phase4-execution-v2')fail('FAST_CONTROL_EXACT_KEY_AUTHORITY_REQUIRED');
 }
 if(m.roster.length!==3||s.bridge.tenants.some(t=>{const rows=m.roster.filter(r=>r.user_id===t.userId&&r.whoop_user_id===t.whoopUserId),r=rows[0];return rows.length!==1||r.status!=='ACTIVE'||r.lifecycle_generation!==t.lifecycleGeneration||r.auth_generation!==t.authGeneration||r.source_generation!==t.sourceGeneration||r.purge_generation!==t.purgeGeneration||r.pending_purge_count!==0;}))fail('FAST_CONTROL_EXACT_ORIGINAL_THREE_REQUIRED');
 if(m.foreignKeys!==1||m.ignoredChecks!==0)fail('FAST_CONTROL_CONSTRAINTS_REQUIRED');
 return expected.size;
}

/** Own fixed native coherent METADATA read, with genuine original A bootstrap.
 * The caller cannot supply metadata, clients, a phase Boolean, or SQL.
 * No table-row scan occurs here; original full-base comparisons are separate.
 */
export async function captureProductionFastControl(input){
 exact(input,['environment','operatorQualification']);const environment=owned(input.environment),qualification=owned(input.operatorQualification);
 if(Object.hasOwn(environment,'RENDER_API_KEY')||environment.TURSO_DATABASE_URL!==P.databaseUrl||typeof environment.TURSO_AUTH_TOKEN!=='string'||!environment.TURSO_AUTH_TOKEN)fail('FAST_CONTROL_FIXED_APP_ENVIRONMENT_REQUIRED');
 const keys=phase4AuthorityKeys(environment),{s,window}=authenticateProductionEpochQualification({keys,operatorQualification:qualification}),start=clock(window),mono=performance.now(),end=Math.min(start+15000,window.originalWindowEndMs);
 const check=()=>{const now=clock(window);if(now<start||now>=end||performance.now()-mono>=15000)fail('FAST_CONTROL_METADATA_DEADLINE');return now;};
 const bootstrap=createProductionEpochBootstrap({environment,operatorQualification:qualification});let client,tx;
 try{
  const observation=await bootstrap.observeRestart(),a=requireProductionEpochBootstrap(observation,keys);if(a.epoch.label!=='A_BUSINESS33'||!same(a.s.attempt,s.attempt))fail('FAST_CONTROL_OWNED_ORIGINAL_A_REQUIRED');
  const reference=captureProductionEpochCatalogContract(observation,keys);check();
  client=createClient({url:P.databaseUrl,authToken:environment.TURSO_AUTH_TOKEN,intMode:'number',fetch:(input,init)=>{
   check();const url=new URL(typeof input==='string'?input:input.url);if(url.origin!=='https://'+new URL(P.databaseUrl).hostname||url.username||url.password||url.hash)fail('FAST_CONTROL_FIXED_NATIVE_TARGET_REQUIRED');
   return fetch(input,{...init,redirect:'error',signal:AbortSignal.any([...(init?.signal?[init.signal]:[]),AbortSignal.timeout(Math.max(1,Math.floor(Math.min(15000,end-Date.now(),15000-(performance.now()-mono)))))])});
  }});
  tx=await client.transaction('read');const read=async q=>{check();const r=await tx.execute(q);check();return r.rows;};
  const m={catalog:await read(catalogRead),versions:await read(versionsRead),checkpoints:await read(checkpointsRead),operators:await read({sql:operatorRead,args:[ALL.length,ALL]}),boot:await read({sql:rowRead,args:[s.bootRow.key]}),transport:await read({sql:rowRead,args:[s.qualificationTransport.key]}),roster:await read({sql:rosterRead,args:window.tenants.map(t=>t.userId)}),foreignKeys:(await read('PRAGMA foreign_keys'))[0]?.foreign_keys,ignoredChecks:(await read('SELECT ignore_check_constraints FROM pragma_ignore_check_constraints()'))[0]?.ignore_check_constraints};
  const fenceCount=validateMetadata(m,s,qualification,keys,reference);await tx.commit();const capturedAtMs=check(),gate=Object.freeze({contract:DOMAIN+'-opaque-metadata-gate',productionAuthority:'NONE'});
  const evidence=freeze({contract:DOMAIN+'-evidence',productionAuthority:'NONE',fullBaseCertified:false,drainedRuntimeCertified:false,qualificationDigest:sha(qualification),originalWindowId:window.originalWindowId,originalWindowEndMs:window.originalWindowEndMs,attemptDigest:sha(s.attempt),bootDigest:s.bootRow.digest,capturedAtMs,catalogDigest:keys.lookup([DOMAIN,'catalog',m.catalog]),metadataDigest:keys.lookup([DOMAIN,'metadata',m]),sourceTables:s.sourceTables.length,exactSourceFenceCount:fenceCount,exactOperatorRows:2,durablePermitRows:0,sourceSchema:33,coherentMetadataRead:true});
  held.set(gate,{s,window,m,evidence,capturedAtMs,monoCaptured:performance.now(),consumed:false});return gate;
 }catch(error){try{await tx?.rollback();}catch{}throw error;}finally{tx?.close();client?.close();bootstrap.close();}
}

function state(gate){const r=held.get(gate);if(!r)fail('FAST_CONTROL_ORIGINAL_OPAQUE_GATE_REQUIRED');return r;}
export function productionFastControlEvidence(gate){const r=state(gate);return freeze({...r.evidence,packetConsumed:r.consumed});}
function predicate(r,label){
 const {s,m,window:w}=r;
 const clauses=[`(SELECT MAX(version) FROM schema_version)=33`,`(SELECT foreign_keys FROM pragma_foreign_keys())=1`,`(SELECT ignore_check_constraints FROM pragma_ignore_check_constraints())=0`,`${serverNow}>=?`,`${serverNow}<?`,`(${catalogScalar})=?`,`(${versionsScalar})=?`,`(${checkpointsScalar})=?`,`(${operatorScalar})=?`,`(${rowScalar})=?`,`(${rowScalar})=?`,`(${rosterScalar})=?`];
 const args=[w.originalWindowStartMs,w.originalWindowEndMs,serial(toArrays(m.catalog,['type','name','tbl_name','rootpage','sql'])),serial(toArrays(m.versions,['version','applied_at','note'])),serial(toArrays(m.checkpoints,['target_version','step_key','last_cursor','postcondition_state','updated_at'])),ALL.length,ALL,serial(toArrays(controls(s,label),['key','value','updated_at'])),s.bootRow.key,serial(toArrays(m.boot,['key','value','updated_at'])),s.qualificationTransport.key,serial(toArrays(m.transport,['key','value','updated_at'])),...w.tenants.map(t=>t.userId),serial(toArrays(m.roster,['user_id','status','lifecycle_generation','whoop_user_id','auth_generation','source_generation','purge_generation','pending_purge_count']))];
 return {sql:clauses.map(v=>'('+v+')').join(' AND '),args};
}
/** One short native batch: SDK BEGIN IMMEDIATE + all guards/transitions +
 * conditional COMMIT/ROLLBACK in ONE HTTP request. A_TO_D never exposes B.
 * Original packet dispatch requires a complete fresh full-base B read afterward.
 */
export function takeProductionFastControlStatements(input){
 exact(input,['gate','transition']);if(!['A_TO_B','A_TO_D'].includes(input.transition))fail('FAST_CONTROL_EXACT_TRANSITION_REQUIRED');const r=state(input.gate),now=clock(r.window);
 if(r.consumed||now<r.capturedAtMs||now-r.capturedAtMs>15000||performance.now()-r.monoCaptured>15000)fail('FAST_CONTROL_ONE_FRESH_PACKET_REQUIRED');r.consumed=true;
 const name='production_fast_epoch_guard_r4_'+r.evidence.attemptDigest.slice(0,16),table='temp."'+name+'"',initial=predicate(r,'A_BUSINESS33'),terminal=input.transition==='A_TO_B'?'B_INGRESS_ONLY':'D_ABORT33',tail=predicate(r,terminal),[a,b,,d]=r.s.records;
 // NULL fails NOT NULL even when ignore_check_constraints disables CHECK.
 const packet=[{sql:'CREATE TEMP TABLE "'+name+'" (ok INTEGER NOT NULL CHECK(ok=1))',args:[]},{sql:`INSERT INTO ${table}(ok) SELECT CASE WHEN (${initial.sql}) THEN 1 ELSE NULL END`,args:initial.args}];
 for(const [from,to]of input.transition==='A_TO_B'?[[a,b]]:[[a,b],[b,d]]){
  packet.push({sql:'UPDATE telegram_state SET value=?,updated_at=? WHERE key=? AND value=? AND updated_at=? AND (SELECT MAX(version) FROM schema_version)=33',args:[to.value,to.updated_at,r.s.registryKey,from.value,from.updated_at]});
  packet.push({sql:`INSERT INTO ${table}(ok) SELECT CASE WHEN changes()=1 THEN 1 ELSE NULL END`,args:[]});
 }
 packet.push({sql:`INSERT INTO ${table}(ok) SELECT CASE WHEN (${tail.sql}) THEN 1 ELSE NULL END`,args:tail.args},{sql:'DROP TABLE '+table,args:[]});
 const result=freeze(packet);r.s=null;r.m=null;return result;
}
