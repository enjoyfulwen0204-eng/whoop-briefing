/** Bootstrap/read authority; not a Production GO or migration permit.
 * Operator provider credentials stay local. App verifies signed qualification,
 * actual checkout/static config and its OWN fixed production SDK connection.
 * No client/fetch/Boolean/registry JSON injection can mint an observation.
 * Atomic migration/revocation dispatch remains a protected operator action.
 * Verified completed C35 may restart after expiry, with separately qualified
 * current normal configuration. That path cannot issue maintenance commands.
 */
import {createClient} from '@libsql/client';
import {createHash,timingSafeEqual,randomBytes} from 'node:crypto';
import {Readable} from 'node:stream';
import {verifyWhoopWebhook} from './whoopWebhookAuth.js';
import {parseWhoopEvent} from './whoopWebhookEvent.js';
import {createWhoopWebhookStore} from './whoopWebhookStore.js';
import {phase4AuthorityKeys} from './phase4EnvironmentKeys.js';
import {requirePhase4Keys} from './phase4Keys.js';
import {runningReleaseSha} from './phase4Release.js';
import {assertSchemaTransitionProfile} from './schemaTransitionProfile.js';
import {executionProfile} from './phase4Rollback.js';
import {canonicalRuntimeContract} from './runtimeAdmission.js';
import {normalizeSql} from './phase4Migrations.js';
import {RETAINED_LEGACY_TABLE_DDL} from './schema.js';
import {PROFILE_REVISION_PREFIX} from './profileRevision.js';
import {assertCleanStage8Release} from '../scripts/stage8-migration-safety.mjs';
import {fileURLToPath} from 'node:url';
import {compileProductionEpochManifest,productionEpochManifestStatements,PRODUCTION_EPOCH_PREFIX,PRODUCTION_EPOCH_QUALIFICATION_KEY,PRODUCTION_SUPERVISOR_BOOT_KEY} from './productionEpochManifest.js';

const HOST='whoop-briefing-enjoyfulwen0204-eng.aws-ap-northeast-1.turso.io';
export const PRODUCTION_EPOCH_TARGET=Object.freeze({databaseUrl:'libsql://'+HOST,origin:'https://whoop-telegram-webhook.onrender.com',service:'srv-dahs71qd0e5s738n94c0',owner:'tea-d8ptktu8bjmc73c5f9sg',repo:'https://github.com/enjoyfulwen0204-eng/whoop-briefing'});
const P=PRODUCTION_EPOCH_TARGET,CA4='ca4bff7b711737527ca6c4e306d4a3ef555c9f3b',WINDOW='production-transition-r3-original-window-v1',QUALIFIED='production-transition-r3-operator-qualification-v1';
const fail=code=>{throw Object.assign(Error(code),{code});},sha=x=>createHash('sha256').update(x).digest('hex'),same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const exact=(v,fields)=>v&&Object.getPrototypeOf(v)===Object.prototype&&Reflect.ownKeys(v).length===fields.length&&fields.every(k=>Object.hasOwn(v,k));
const hex=(v,n=64)=>typeof v==='string'&&new RegExp('^[a-f0-9]{'+n+'}$').test(v);
const equal=(a,b)=>hex(a)&&hex(b)&&timingSafeEqual(Buffer.from(a,'hex'),Buffer.from(b,'hex'));
const sign=(keys,domain,body)=>keys.digest(keys.lookup([domain]),[domain,body]);
const authenticate=(keys,domain,record)=>{if(!exact(record,['body','signature'])||!equal(record.signature,sign(keys,domain,record.body)))fail('PRODUCTION_EPOCH_SIGNED_AUTHORITY_REQUIRED');return structuredClone(record.body);};
const windowFields=['contract','approvalId','originalWindowId','originalWindowStartMs','originalWindowEndMs','attemptNonce','startIdentity','source33RuntimeSha','targetRuntimeSha','historicalCa4BaselineSha','origin','databaseUrl','resourceApiVersion','acceptFromMs','acceptUntilMs','tenants'];
function windowOf(value){
 if(!exact(value,windowFields)||value.contract!==WINDOW||value.historicalCa4BaselineSha!==CA4||![value.source33RuntimeSha,value.targetRuntimeSha].every(x=>hex(x,40))
  ||value.origin!==P.origin||value.databaseUrl!==P.databaseUrl||value.resourceApiVersion!=='v2'||!/^owner-[A-Za-z0-9_.-]{1,90}$/.test(value.approvalId??'')||!/^[A-Za-z0-9_-]{16,128}$/.test(value.originalWindowId??'')
  ||![value.attemptNonce,value.startIdentity].every(x=>hex(x))||![value.originalWindowStartMs,value.originalWindowEndMs,value.acceptFromMs,value.acceptUntilMs].every(Number.isSafeInteger)
  ||value.originalWindowStartMs<=0||value.originalWindowEndMs<=value.originalWindowStartMs||value.originalWindowEndMs-value.originalWindowStartMs>3600000
  ||value.acceptFromMs<value.originalWindowStartMs||value.acceptUntilMs>value.originalWindowEndMs||value.acceptUntilMs<=value.acceptFromMs
  ||!Array.isArray(value.tenants)||value.tenants.length!==3||Reflect.ownKeys(value.tenants).length!==4)fail('PRODUCTION_EPOCH_EXACT_ORIGINAL_WINDOW_REQUIRED');
 for(const t of value.tenants)if(!exact(t,['userId','whoopUserId','lifecycleGeneration','authGeneration','sourceGeneration','purgeGeneration'])||typeof t.userId!=='string'||!t.userId||t.userId.length>128||t.userId!==t.userId.trim()||/[\x00-\x1f\x7f]/.test(t.userId)||typeof t.whoopUserId!=='string'||!/^[1-9][0-9]{0,19}$/.test(t.whoopUserId)||!['lifecycleGeneration','authGeneration'].every(k=>Number.isSafeInteger(t[k])&&t[k]>0)||!['sourceGeneration','purgeGeneration'].every(k=>Number.isSafeInteger(t[k])&&t[k]>=0))fail('PRODUCTION_EPOCH_EXACT_CURRENT_THREE_REQUIRED');
 if(new Set(value.tenants.map(t=>t.userId)).size!==3||new Set(value.tenants.map(t=>t.whoopUserId)).size!==3)fail('PRODUCTION_EPOCH_EXACT_CURRENT_THREE_REQUIRED');return structuredClone(value);
}
/** Authenticates already authorized operator scope, not consent by itself. */
export function sealProductionTransitionWindow({keys,window}={}){requirePhase4Keys(keys);const body=windowOf(window);return {body,signature:sign(keys,'production-transition-r3-window-seal-v1',body)};}
function active(window){const now=Date.now();if(now<window.originalWindowStartMs||now>=window.originalWindowEndMs)fail('PRODUCTION_EPOCH_ORIGINAL_WINDOW_INACTIVE');return now;}
// A fresh READ-ONLY operation deadline is not a renewed maintenance window.
const readLease=()=>({kind:'READ_ONLY_TERMINAL_OBSERVATION',readStartedAtMs:Date.now(),readDeadlineAtMs:Date.now()+15000});
const deadline=policy=>policy.kind==='READ_ONLY_TERMINAL_OBSERVATION'?policy.readDeadlineAtMs:policy.originalWindowEndMs;
function readBudget(policy){if(policy.kind!=='READ_ONLY_TERMINAL_OBSERVATION')return active(policy);const now=Date.now();if(now<policy.readStartedAtMs||now>=policy.readDeadlineAtMs)fail('PRODUCTION_EPOCH_READ_DEADLINE');return now;}
function boundedFetch(window,input,init){
 const now=readBudget(window),url=new URL(typeof input==='string'?input:input.url);if(url.origin!=='https://'+HOST)fail('PRODUCTION_EPOCH_FIXED_DATABASE_REQUIRED');
 return fetch(input,{...init,redirect:'error',signal:AbortSignal.any([...(init?.signal?[init.signal]:[]),AbortSignal.timeout(Math.min(15000,deadline(window)-now))])});
}
function ownedNative(environment,window){if(environment.TURSO_DATABASE_URL!==P.databaseUrl||typeof environment.TURSO_AUTH_TOKEN!=='string'||!environment.TURSO_AUTH_TOKEN)fail('PRODUCTION_EPOCH_FIXED_DATABASE_REQUIRED');return createClient({url:P.databaseUrl,authToken:environment.TURSO_AUTH_TOKEN,intMode:'number',fetch:(input,init)=>boundedFetch(window,input,init)});}
// Release identity is checked separately for the actual33/35 phase, permitting
// an explicitly different source33 and target release without a ca4 alias.
const staticFields=Object.freeze(['PHASE4_EXECUTION_PROFILE','PHASE4_STAGE8_RUNTIME','PHASE4_STAGE8_OWNER_MONITORING','STAGE8_MORNING_BRIEF','STAGE8_LIVE_ANALYSIS','STAGE8_POST_SYNC','STAGE8_SUBJECT_ALERTS','PHASE4_DELIVERY_CUTOVER','BODY_ENERGY_PUBLICATION','BODY_ENERGY_ALERTS','PHASE4_BETA_SHADOW_RUNTIME','PHASE4_PUBLIC_BETA_MODE','PHASE4_PUBLIC_BETA_USER_IDS','STAGE8_USER_IDS','STAGE7_COMPANION','STAGE7_COMPANION_USER_IDS','STAGE7_AUTOMATIC','BRIEFING_SCHEDULER_TOPOLOGY','BRIEFING_CONTINUATION_SCOPE','WHOOP_WEBHOOK_ENABLED','WHOOP_CLIENT_SECRET','TELEGRAM_BOT_TOKEN','TELEGRAM_WEBHOOK_SECRET','BRIEFING_TRIGGER_SECRET','TURSO_DATABASE_URL']);
const configDigest=(keys,env)=>keys.lookup(['production-transition-r3-static-config-v1',staticFields.map(name=>[name,env[name]??null])]);
const keyContinuity=(a,b)=>equal(a.lookupCheckpoint(),b.lookupCheckpoint())&&equal(a.auditCheckpoint(),b.auditCheckpoint());
const catalogSql="SELECT type,name,tbl_name,sql FROM sqlite_master WHERE type IN ('table','index','trigger','view') ORDER BY type,name";
const registrySql='SELECT key,value,updated_at FROM telegram_state WHERE substr(key,1,?)=? ORDER BY key';
const allOperatorPrefix=PROFILE_REVISION_PREFIX+'operator:';
const versionsSql='SELECT version,note FROM schema_version ORDER BY version';
const checkpointsSql="SELECT target_version,step_key,last_cursor,postcondition_state FROM phase4_migration_checkpoints WHERE target_version IN (21,22,23,32)";
const cohortSql=`SELECT u.id user_id,u.status,u.lifecycle_generation,t.whoop_user_id,t.auth_generation,p.source_generation,p.purge_generation,p.pending_purge_count
 FROM user_whoop_tokens t JOIN users u ON u.id=t.user_id JOIN phase4_user_state p ON p.user_id=u.id
 WHERE t.whoop_user_id IN (?,?,?) ORDER BY t.whoop_user_id`;
const currentCohortSql=cohortSql.replace('WHERE t.whoop_user_id IN (?,?,?) ORDER BY t.whoop_user_id','WHERE u.id IN (?,?,?) ORDER BY u.id');
// Same quoted-string/nested-column handling as original runtime admission.
function elements(sql){let out='',quote=null;for(let i=0;i<sql.length;i++){const c=sql[i];if(quote){out+=c;if(c===quote){if(sql[i+1]===quote)out+=sql[++i];else quote=null;}continue;}if(["'",'"','`'].includes(c)){quote=c;out+=c;continue;}if(c==='-'&&sql[i+1]==='-'){while(i<sql.length&&sql[i]!=='\n')i++;out+=' ';continue;}if(c==='/'&&sql[i+1]==='*'){i+=2;while(i<sql.length&&!(sql[i]==='*'&&sql[i+1]==='/'))i++;i++;out+=' ';continue;}out+=c;}const body=out.slice(out.indexOf('(')+1,out.lastIndexOf(')')),parts=[];let start=0,depth=0;quote=null;for(let i=0;i<body.length;i++){const c=body[i];if(quote){if(c===quote){if(body[i+1]===quote)i++;else quote=null;}continue;}if(["'",'"','`'].includes(c)){quote=c;continue;}if(c==='(')depth++;if(c===')')depth--;if(c===','&&!depth){parts.push(body.slice(start,i).trim());start=i+1;}}parts.push(body.slice(start).trim());return parts;}
function tableMatches(actual,expected){if(normalizeSql(actual.slice(actual.lastIndexOf(')')+1))!==normalizeSql(expected.ddl.slice(expected.ddl.lastIndexOf(')')+1)))return false;const parts=elements(actual).map(normalizeSql),wanted=elements(expected.ddl).map(normalizeSql);return parts.length===wanted.length&&wanted.every(part=>parts.includes(part)||(expected.variants??[]).some(c=>c.column===/^(\w+)\s/.exec(part)?.[1]&&parts.includes(normalizeSql(c.column+' '+c.definition))));}
function manifestMap(statements){return new Map(statements.map(q=>{const m=/^CREATE TRIGGER "([^"]+)" BEFORE (?:INSERT|UPDATE|DELETE) ON "([^"]+)"/.exec(q.sql);if(!m)fail('PRODUCTION_EPOCH_FIXED_TRIGGER_SOURCE_REQUIRED');return [m[1],{table:m[2],sql:q.sql}];}));}
function validateCatalog(rows,schema,s,installed){
 const canonical=canonicalRuntimeContract(schema),actual=new Map(),expected=manifestMap(schema===33?s?.sourceTriggers??[]:s?.targetTriggers??[]),found=new Set();
 if(rows.length>5000)fail('PRODUCTION_EPOCH_CATALOG_BOUNDS');
 for(const row of rows){
  if(row.name.startsWith('sqlite_'))continue;
  const item=canonical.objects.get(row.name);
  if(item){if(actual.has(row.name)||row.type!==item.type||(item.type==='table'?!tableMatches(row.sql,item):normalizeSql(row.sql)!==normalizeSql(item.ddl)))fail('PRODUCTION_EPOCH_CANONICAL_CATALOG_REQUIRED');actual.set(row.name,row);continue;}
  if(Object.hasOwn(RETAINED_LEGACY_TABLE_DDL,row.name)){if(row.type!=='table'||normalizeSql(row.sql)!==normalizeSql(RETAINED_LEGACY_TABLE_DDL[row.name]))fail('PRODUCTION_EPOCH_RETAINED_CATALOG_REQUIRED');continue;}
  const trigger=expected.get(row.name);if(!installed||!trigger||row.type!=='trigger'||row.tbl_name!==trigger.table||normalizeSql(row.sql)!==normalizeSql(trigger.sql)||found.has(row.name))fail('PRODUCTION_EPOCH_EXACT_TRIGGER_MANIFEST_REQUIRED');found.add(row.name);
 }
 if(actual.size!==canonical.objects.size||installed&&found.size!==expected.size||[...canonical.retired].some(name=>rows.some(r=>r.name===name)))fail('PRODUCTION_EPOCH_CANONICAL_CATALOG_REQUIRED');
 if(s){const tables=rows.filter(r=>r.type==='table'&&!r.name.startsWith('sqlite_')).map(r=>r.name).sort(),wanted=schema===33?s.sourceTables:s.targetTables;if(!same(tables,wanted))fail('PRODUCTION_EPOCH_EXACT_TABLE_MANIFEST_REQUIRED');}
}
const processBoots=new WeakMap(),BOOT='production-supervisor-monotonic-boot-v1';
function makeBootRow(keys,body){const signature=sign(keys,BOOT,body),digest=keys.lookup([BOOT,body,signature]);return {key:PRODUCTION_SUPERVISOR_BOOT_KEY,value:JSON.stringify({body,signature,digest}),updated_at:new Date(body.issuedAtMs).toISOString(),digest};}
function bootRowOf(row,keys){if(!exact(row,['key','value','updated_at','digest'])||row.key!==PRODUCTION_SUPERVISOR_BOOT_KEY||typeof row.value!=='string'||Buffer.byteLength(row.value)>2048)fail('PRODUCTION_EPOCH_AUTHENTIC_BOOT_ROW_REQUIRED');let wire;try{wire=JSON.parse(row.value);}catch{fail('PRODUCTION_EPOCH_AUTHENTIC_BOOT_ROW_REQUIRED');}if(!exact(wire,['body','signature','digest'])||!exact(wire.body,['contract','generation','nonce','issuedAtMs','releaseSha'])||wire.body.contract!==BOOT||!Number.isSafeInteger(wire.body.generation)||wire.body.generation<1||wire.body.generation>=Number.MAX_SAFE_INTEGER||!hex(wire.body.nonce)||!hex(wire.body.releaseSha,40)||!Number.isSafeInteger(wire.body.issuedAtMs)||wire.body.issuedAtMs<=0)fail('PRODUCTION_EPOCH_AUTHENTIC_BOOT_ROW_REQUIRED');authenticate(keys,BOOT,{body:wire.body,signature:wire.signature});const expected=makeBootRow(keys,wire.body);if(!same(row,expected)||!equal(wire.digest,expected.digest))fail('PRODUCTION_EPOCH_AUTHENTIC_BOOT_ROW_REQUIRED');return structuredClone(row);}
async function actualBootRow(tx,keys,{allowAbsent=false}={}){const rows=(await tx.execute({sql:'SELECT key,value,updated_at FROM telegram_state WHERE key=?',args:[PRODUCTION_SUPERVISOR_BOOT_KEY]})).rows;if(!rows.length&&allowAbsent)return null;if(rows.length!==1)fail('PRODUCTION_EPOCH_AUTHENTIC_BOOT_ROW_REQUIRED');let parsed;try{parsed=JSON.parse(rows[0].value);}catch{fail('PRODUCTION_EPOCH_AUTHENTIC_BOOT_ROW_REQUIRED');}return bootRowOf({...rows[0],digest:parsed.digest},keys);}
function capturedBoot(reference,keys,releaseSha){const b=processBoots.get(reference);requirePhase4Keys(keys);if(!b||!keyContinuity(keys,b.keys)||b.releaseSha!==releaseSha)fail('PRODUCTION_EPOCH_OPAQUE_PROCESS_BOOT_REQUIRED');return b.row;}
/** Own fixed writer-serialized pre-window cold33 boot revocation. A confirmed
 * rotation permanently invalidates old q.bootRow before any delayed firstDDL.
 * Unknown COMMIT never issues a process-boot capability. No row/schema reset. */
export async function advanceProductionSupervisorBoot({environment}={}){
 const env=Object.freeze({...environment});if(Object.hasOwn(env,'RENDER_API_KEY'))fail('PRODUCTION_EPOCH_OPERATOR_LOGIN_MUST_STAY_LOCAL');assertSchemaTransitionProfile(env);const keys=phase4AuthorityKeys(env),releaseSha=runningReleaseSha(env);assertCleanStage8Release(releaseSha,fileURLToPath(new URL('../',import.meta.url)));const lease=readLease(),native=ownedNative(env,lease);let tx;
 try{tx=await native.transaction('write');const operator=(await tx.execute({sql:registrySql,args:[allOperatorPrefix.length,allOperatorPrefix]})).rows;if(operator.length)fail('PRODUCTION_BOOT_TRANSITION_ALREADY_PRESENT');
  const versions=(await tx.execute(versionsSql)).rows;if(Math.max(0,...versions.map(r=>r.version))!==33)fail('PRODUCTION_BOOT_UNTOUCHED33_REQUIRED');for(let v=21;v<=33;v++)if(versions.filter(r=>r.version===v&&r.note===`phase4 v${v} postconditions verified`).length!==1)fail('PRODUCTION_BOOT_UNTOUCHED33_REQUIRED');validateCatalog((await tx.execute(catalogSql)).rows,33,null,false);
  const checkpoints=(await tx.execute(checkpointsSql)).rows;for(const [v,k]of [[21,'tenant_metadata'],[22,'privacy_backfill'],[22,'lookup_key_check'],[22,'audit_key_check'],[23,'legacy_insights'],[32,'execution_authority']]){const r=checkpoints.find(r=>r.target_version===v&&r.step_key===k);if(r?.postcondition_state!=='COMPLETE'||k==='lookup_key_check'&&!keys.verifyLookupCheckpoint(r.last_cursor)||k==='audit_key_check'&&!keys.verifyAuditCheckpoint(r.last_cursor)||k==='execution_authority'&&r.last_cursor!=='phase4-execution-v2')fail('PRODUCTION_EPOCH_ACTUAL_KEY_AUTHORITY_REQUIRED');}
  if((await tx.execute('PRAGMA foreign_keys')).rows[0]?.foreign_keys!==1||(await tx.execute('SELECT ignore_check_constraints FROM pragma_ignore_check_constraints()')).rows[0]?.ignore_check_constraints!==0)fail('PRODUCTION_EPOCH_CONSTRAINTS_REQUIRED');const previous=await actualBootRow(tx,keys,{allowAbsent:true}),generation=previous?JSON.parse(previous.value).body.generation+1:1,row=makeBootRow(keys,{contract:BOOT,generation,nonce:randomBytes(32).toString('hex'),issuedAtMs:Date.now(),releaseSha});bootRowOf(row,keys);readBudget(lease);
  const result=previous?await tx.execute({sql:'UPDATE telegram_state SET value=?,updated_at=? WHERE key=? AND value=? AND updated_at=?',args:[row.value,row.updated_at,row.key,previous.value,previous.updated_at]}):await tx.execute({sql:'INSERT INTO telegram_state(key,value,updated_at) VALUES(?,?,?)',args:[row.key,row.value,row.updated_at]});if(result.rowsAffected!==1)fail('PRODUCTION_BOOT_EXACT_PREDECESSOR_REQUIRED');readBudget(lease);await tx.commit();readBudget(lease);const reference=Object.freeze({contract:'production-supervisor-captured-process-boot-v1',productionAuthority:'NONE'});processBoots.set(reference,{keys,row:Object.freeze(row),releaseSha});return reference;
 }catch(error){try{await tx?.rollback();}catch{}throw error;}finally{tx?.close();native.close();}}
async function inspectOwned(client,keys,window,s,{uninitialized=false,allowUninitialized=false,lease=window,terminalOnly=false,businessObservation=false}={}){
 readBudget(lease);const tx=await client.transaction('read');try{
  const versions=(await tx.execute(versionsSql)).rows,schema=Math.max(0,...versions.map(r=>r.version));if(![33,35].includes(schema)||versions.some(r=>!Number.isSafeInteger(r.version)))fail('PRODUCTION_EPOCH_COMMITTED_33_OR_35_REQUIRED');
  for(let v=21;v<=schema;v++)if(versions.filter(r=>r.version===v&&r.note===`phase4 v${v} postconditions verified`).length!==1)fail('PRODUCTION_EPOCH_CANONICAL_VERSION_MARKERS_REQUIRED');
  const bootRow=await actualBootRow(tx,keys);if(s&&!same(bootRow,s.bootRow))fail('PRODUCTION_EPOCH_ORIGINAL_BOOT_REVOKED');
  const catalog=(await tx.execute(catalogSql)).rows,registry=(await tx.execute({sql:registrySql,args:[allOperatorPrefix.length,allOperatorPrefix]})).rows;
  const actualUninitialized=uninitialized||allowUninitialized&&registry.length===0;let epoch=null;if(actualUninitialized){if(schema!==33||registry.length)fail('PRODUCTION_EPOCH_FRESH_33_REQUIRED');}else{
   if(!s||registry.length!==2||!registry.some(r=>r.key===s.qualificationTransport.key&&r.value===s.qualificationTransport.value&&r.updated_at===s.qualificationTransport.updated_at))fail('PRODUCTION_EPOCH_EXACT_DURABLE_PHASE_REQUIRED');epoch=s.records.find(r=>registry.some(actual=>actual.key===s.registryKey&&r.value===actual.value&&r.updated_at===actual.updated_at));if(!epoch||(epoch.label==='B_INGRESS_ONLY'?![33,35].includes(schema):epoch.schema!==schema))fail('PRODUCTION_EPOCH_EXACT_DURABLE_PHASE_REQUIRED');
  }
  if(terminalOnly&&!['C_BUSINESS35','D_ABORT33'].includes(epoch?.label))fail('PRODUCTION_EPOCH_TERMINAL_C_OR_D_REQUIRED');
  const normalC=['C_BUSINESS35','D_ABORT33'].includes(epoch?.label)&&(businessObservation||terminalOnly||Date.now()>=window.originalWindowEndMs);
  validateCatalog(catalog,schema,s,!actualUninitialized);
  const checkpoints=(await tx.execute(checkpointsSql)).rows;
  for(const [v,k]of [[21,'tenant_metadata'],[22,'privacy_backfill'],[22,'lookup_key_check'],[22,'audit_key_check'],[23,'legacy_insights'],[32,'execution_authority']]){const r=checkpoints.find(r=>r.target_version===v&&r.step_key===k);if(r?.postcondition_state!=='COMPLETE'||k==='lookup_key_check'&&!keys.verifyLookupCheckpoint(r.last_cursor)||k==='audit_key_check'&&!keys.verifyAuditCheckpoint(r.last_cursor)||k==='execution_authority'&&r.last_cursor!=='phase4-execution-v2')fail('PRODUCTION_EPOCH_ACTUAL_KEY_AUTHORITY_REQUIRED');}
  const roster=(await tx.execute(normalC?{sql:currentCohortSql,args:window.tenants.map(t=>t.userId)}:{sql:cohortSql,args:window.tenants.map(t=>t.whoopUserId)})).rows;if(normalC){if(roster.length>3||new Set(roster.map(r=>r.user_id)).size!==roster.length||roster.some(r=>!window.tenants.some(t=>t.userId===r.user_id)||!Number.isSafeInteger(r.pending_purge_count)||r.pending_purge_count<0))fail('PRODUCTION_EPOCH_CURRENT_COHORT_REQUIRED');}else if(roster.length!==3)fail('PRODUCTION_EPOCH_CURRENT_COHORT_REQUIRED');
  for(const t of window.tenants){const matches=roster.filter(r=>r.user_id===t.userId&&(normalC||r.whoop_user_id===t.whoopUserId)),r=matches[0];if(normalC&&matches.length===0)continue;if(matches.length!==1||!normalC&&(r.status!=='ACTIVE'||r.pending_purge_count!==0))fail('PRODUCTION_EPOCH_CURRENT_COHORT_REQUIRED');
   if(normalC){if(typeof r.whoop_user_id!=='string'||!/^[1-9][0-9]{0,19}$/.test(r.whoop_user_id)||!['lifecycle_generation','auth_generation'].every(k=>Number.isSafeInteger(r[k])&&r[k]>0)||!['source_generation','purge_generation'].every(k=>Number.isSafeInteger(r[k])&&r[k]>=0))fail('PRODUCTION_EPOCH_CURRENT_COHORT_REQUIRED');}
   else if(r.lifecycle_generation!==t.lifecycleGeneration||r.auth_generation!==t.authGeneration||r.source_generation!==t.sourceGeneration||r.purge_generation!==t.purgeGeneration)fail('PRODUCTION_EPOCH_CURRENT_COHORT_REQUIRED');
  }
  if((await tx.execute('PRAGMA foreign_keys')).rows[0]?.foreign_keys!==1||(await tx.execute('SELECT ignore_check_constraints FROM pragma_ignore_check_constraints()')).rows[0]?.ignore_check_constraints!==0)fail('PRODUCTION_EPOCH_CONSTRAINTS_REQUIRED');
  await tx.commit();readBudget(lease);return {schema,epoch,catalog,bootRow,uninitialized:actualUninitialized,currentCohortDigest:keys.lookup(['production-transition-r3-current-cohort-v1',roster]),authorityDigest:keys.lookup(['production-transition-r3-actual-authority-v1',versions,checkpoints,roster]),sourceTables:catalog.filter(r=>r.type==='table'&&!r.name.startsWith('sqlite_')).map(r=>r.name).sort(),catalogDigest:keys.lookup(['production-transition-r3-actual-catalog-v1',catalog])};
 }catch(error){try{await tx.rollback();}catch{}throw error;}finally{tx.close();}
}
function qualificationTransportOf(qualification,keys){const signature=sign(keys,'production-transition-r3-operator-qualification-seal-v1',qualification),digest=keys.lookup(['production-transition-r3-immutable-qualification-transport-v1',qualification,signature]);return {key:PRODUCTION_EPOCH_QUALIFICATION_KEY,value:JSON.stringify({contract:'production-transition-r3-immutable-qualification-transport-v1',qualification:{body:qualification,signature},digest}),updated_at:new Date(qualification.qualifiedAtMs).toISOString(),digest};}
function planFrom(qualification,keys){const sourceTables=qualification.sourceTables,targetTables=[...new Set([...sourceTables,...[...canonicalRuntimeContract(35).objects.values()].filter(v=>v.type==='table').map(v=>v.name)])].sort();return compileProductionEpochManifest({keys,window:qualification.window,sourceTables,targetTables,qualificationTransport:qualificationTransportOf(qualification,keys),bootRow:qualification.bootRow});}
async function providerJson(path,token,window){const now=readBudget(window);const response=await fetch('https://api.render.com/v1/'+path,{headers:{Authorization:'Bearer '+token,accept:'application/json'},redirect:'error',signal:AbortSignal.timeout(Math.min(15000,deadline(window)-now))});try{
 if(response.status!==200)fail('PRODUCTION_EPOCH_OPERATOR_RENDER_READ_FAILED');const date=Date.parse(response.headers.get('date'));if(!Number.isFinite(date)||Math.abs(Date.now()-date)>120000)fail('PRODUCTION_EPOCH_OPERATOR_FRESHNESS_REQUIRED');const reader=response.body?.getReader();if(!reader)fail('PRODUCTION_EPOCH_PROVIDER_RESPONSE_REQUIRED');const chunks=[];let count=0;try{for(;;){const next=await reader.read();readBudget(window);if(next.done)break;count+=next.value.length;if(count>1048576)fail('PRODUCTION_EPOCH_PROVIDER_RESPONSE_BOUNDS');chunks.push(next.value);}}finally{try{await reader.cancel();}catch{}reader.releaseLock();}let value;try{value=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{fail('PRODUCTION_EPOCH_PROVIDER_RESPONSE_REQUIRED');}return {value,date};
 }finally{try{await response.body?.cancel();}catch{}}}
async function providerList(path,token,window){const out=[],seen=new Set();let cursor='';for(let n=0;n<100;n++){const {value}=await providerJson(path+'?limit=100'+(cursor?'&cursor='+encodeURIComponent(cursor):''),token,window);if(!Array.isArray(value)||value.length>100)fail('PRODUCTION_EPOCH_PROVIDER_PAGINATION_REQUIRED');out.push(...value);if(value.length<100)return out;const next=value.at(-1)?.cursor;if(typeof next!=='string'||!next||seen.has(next))fail('PRODUCTION_EPOCH_PROVIDER_PAGINATION_REQUIRED');seen.add(next);cursor=next;}fail('PRODUCTION_EPOCH_PROVIDER_PAGINATION_REQUIRED');}
async function observeRenderRuntime(environment,keys,policy,expectedSha){
 if(typeof environment.RENDER_API_KEY!=='string'||!environment.RENDER_API_KEY)fail('PRODUCTION_EPOCH_LOCAL_OPERATOR_RENDER_LOGIN_REQUIRED');
 const [serviceRead,deploys,variables]=await Promise.all([providerJson('services/'+P.service,environment.RENDER_API_KEY,policy),providerList('services/'+P.service+'/deploys',environment.RENDER_API_KEY,policy),providerList('services/'+P.service+'/env-vars',environment.RENDER_API_KEY,policy)]),service=serviceRead.value;
 if(service?.id!==P.service||service.ownerId!==P.owner||service.repo!==P.repo||service.autoDeploy!=='no'||service.suspended!=='not_suspended'||service.type!=='web_service'||service.serviceDetails?.maintenanceMode?.enabled!==false||(service.serviceDetails?.envSpecificDetails?.startCommand??service.serviceDetails?.startCommand)!=='npm run bot:webhook')fail('PRODUCTION_EPOCH_EXACT_RENDER_RUNTIME_REQUIRED');
 const entries=deploys.map(r=>r.deploy??r),live=entries.filter(r=>r.status==='live');if(live.length!==1||!hex(live[0].commit?.id,40)||expectedSha!==undefined&&live[0].commit.id!==expectedSha||entries.some(r=>typeof r.id!=='string'||!r.id||!['live','deactivated','canceled','build_failed','update_failed','pre_deploy_failed'].includes(r.status))||new Set(entries.map(r=>r.id)).size!==entries.length)fail('PRODUCTION_EPOCH_SETTLED_RENDER_RUNTIME_REQUIRED');
 const remote={};for(const entry of variables){const r=entry.envVar??entry;if(!exact(r,['key','value'])||typeof r.key!=='string'||typeof r.value!=='string'||Object.hasOwn(remote,r.key))fail('PRODUCTION_EPOCH_EXACT_RENDER_VARIABLES_REQUIRED');remote[r.key]=r.value;}
 if(remote.PHASE4_RELEASE_SHA!==live[0].commit.id||remote.TURSO_DATABASE_URL!==P.databaseUrl||!keyContinuity(keys,phase4AuthorityKeys(remote)))fail('PRODUCTION_EPOCH_REMOTE_KEY_STATIC_BINDING_REQUIRED');
 return {remote,currentRuntimeSha:live[0].commit.id,deployId:live[0].id,observedAtMs:serviceRead.date};
}
/** PROTECTED OPERATOR ONLY. Render login is passed here from the local operator
 * boundary; no Render key is copied into qualification or app environment. */
export async function qualifyProductionEpochOperator({operatorEnvironment,signedWindow}={}){
 const environment=Object.freeze({...operatorEnvironment}),keys=phase4AuthorityKeys(environment),window=windowOf(authenticate(keys,'production-transition-r3-window-seal-v1',signedWindow));active(window);
 const provider=await observeRenderRuntime(environment,keys,window,window.source33RuntimeSha),remote=provider.remote;assertSchemaTransitionProfile(remote);
 const client=ownedNative(environment,window);let observed;try{observed=await inspectOwned(client,keys,window,null,{uninitialized:true});}finally{client.close();}
 const body={contract:QUALIFIED,window,bootRow:observed.bootRow,sourceTables:observed.sourceTables,sourceCatalogDigest:observed.catalogDigest,staticConfigurationDigest:configDigest(keys,remote),lookupCheckpoint:keys.lookupCheckpoint(),auditCheckpoint:keys.auditCheckpoint(),provider:{service:P.service,owner:P.owner,deployId:provider.deployId,source33RuntimeSha:window.source33RuntimeSha,observedAtMs:provider.observedAtMs,settled:true},qualifiedAtMs:Date.now(),expiresAtMs:window.originalWindowEndMs};
 return {body,signature:sign(keys,'production-transition-r3-operator-qualification-seal-v1',body)};
}
function qualificationOf(value,keys){const q=authenticate(keys,'production-transition-r3-operator-qualification-seal-v1',value);if(!exact(q,['contract','window','bootRow','sourceTables','sourceCatalogDigest','staticConfigurationDigest','lookupCheckpoint','auditCheckpoint','provider','qualifiedAtMs','expiresAtMs'])||q.contract!==QUALIFIED)fail('PRODUCTION_EPOCH_OPERATOR_QUALIFICATION_REQUIRED');q.window=windowOf(q.window);q.bootRow=bootRowOf(q.bootRow,keys);
 if(!Array.isArray(q.sourceTables)||q.sourceTables.length<4||q.sourceTables.length>500||q.sourceTables.some(t=>typeof t!=='string'||!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(t))||!same(q.sourceTables,[...new Set(q.sourceTables)].sort())||![q.sourceCatalogDigest,q.staticConfigurationDigest].every(x=>hex(x))||!equal(q.lookupCheckpoint,keys.lookupCheckpoint())||!equal(q.auditCheckpoint,keys.auditCheckpoint())||q.expiresAtMs!==q.window.originalWindowEndMs||!Number.isSafeInteger(q.qualifiedAtMs)||q.qualifiedAtMs<q.window.originalWindowStartMs||q.qualifiedAtMs>=q.expiresAtMs||!exact(q.provider,['service','owner','deployId','source33RuntimeSha','observedAtMs','settled'])||q.provider.service!==P.service||q.provider.owner!==P.owner||q.provider.source33RuntimeSha!==q.window.source33RuntimeSha||q.provider.settled!==true||typeof q.provider.deployId!=='string'||!q.provider.deployId||!Number.isSafeInteger(q.provider.observedAtMs)||Math.abs(q.qualifiedAtMs-q.provider.observedAtMs)>120000)fail('PRODUCTION_EPOCH_OPERATOR_QUALIFICATION_REQUIRED');return q;}
const currentRuntimeDomain='production-transition-r3-current-terminal-runtime-qualification-v1';
/** Separate normal-service qualification after actual C35. It preserves the
 * ORIGINAL registry/window/target. It cannot renew maintenance or authorize a
 * feature by itself; operator must already have authorized the observed config.
 */
export async function qualifyCurrentTerminalRuntime({operatorEnvironment,originalOperatorQualification}={}){
 const environment=Object.freeze({...operatorEnvironment}),keys=phase4AuthorityKeys(environment),q=qualificationOf(originalOperatorQualification,keys),s=planFrom(q,keys),lease=readLease(),provider=await observeRenderRuntime(environment,keys,lease);
 const profile=executionProfile(provider.remote);if(!['PHASE4','STAGE8_SCHEMA_TRANSITION'].includes(profile))fail('PRODUCTION_EPOCH_CURRENT_BUSINESS_PROFILE_REQUIRED');
 const client=ownedNative(environment,lease);let actual;try{actual=await inspectOwned(client,keys,q.window,s,{lease,terminalOnly:true});}finally{client.close();}if(actual.schema===33)assertSchemaTransitionProfile(provider.remote);
 const body={contract:currentRuntimeDomain,originalQualificationDigest:keys.lookup(['production-transition-r3-original-qualification-v1',q]),originalWindowId:q.window.originalWindowId,originalTerminalRecordValue:actual.epoch.value,terminalLabel:actual.epoch.label,currentRuntimeSha:provider.currentRuntimeSha,currentStaticConfigurationDigest:configDigest(keys,provider.remote),profile,service:P.service,deployId:provider.deployId,providerObservedAtMs:provider.observedAtMs,qualifiedAtMs:Date.now(),currentCohortDigestAtQualification:actual.currentCohortDigest};return {body,signature:sign(keys,currentRuntimeDomain,body)};
}
function currentRuntimeOf(value,keys,q,s){const r=authenticate(keys,currentRuntimeDomain,value);if(!exact(r,['contract','originalQualificationDigest','originalWindowId','originalTerminalRecordValue','terminalLabel','currentRuntimeSha','currentStaticConfigurationDigest','profile','service','deployId','providerObservedAtMs','qualifiedAtMs','currentCohortDigestAtQualification'])||r.contract!==currentRuntimeDomain||r.originalQualificationDigest!==keys.lookup(['production-transition-r3-original-qualification-v1',q])||r.originalWindowId!==q.window.originalWindowId||!s.records.some(v=>['C_BUSINESS35','D_ABORT33'].includes(v.label)&&v.label===r.terminalLabel&&v.value===r.originalTerminalRecordValue)||!hex(r.currentRuntimeSha,40)||!hex(r.currentStaticConfigurationDigest)||!hex(r.currentCohortDigestAtQualification)||!['PHASE4','STAGE8_SCHEMA_TRANSITION'].includes(r.profile)||r.service!==P.service||typeof r.deployId!=='string'||!r.deployId||!Number.isSafeInteger(r.qualifiedAtMs)||r.qualifiedAtMs>Date.now()||!Number.isSafeInteger(r.providerObservedAtMs)||Math.abs(r.providerObservedAtMs-r.qualifiedAtMs)>120000)fail('PRODUCTION_EPOCH_CURRENT_RUNTIME_QUALIFICATION_REQUIRED');return r;}
const observations=new WeakMap(),bootstrapContexts=new WeakMap();
/** Sole application issuer. Tests may replace the SDK module in an isolated
 * graph; the exported API accepts no native receiver or transport injection. */
export function createProductionEpochBootstrap(options={}){
 if(!exact(options,['environment','operatorQualification',...(Object.hasOwn(options,'currentRuntimeQualification')?['currentRuntimeQualification']:[]),...(Object.hasOwn(options,'processBoot')?['processBoot']:[])]))fail('PRODUCTION_EPOCH_OWNED_BOOTSTRAP_REQUIRED');
 const environment=Object.freeze({...options.environment}),keys=phase4AuthorityKeys(environment),qualification=qualificationOf(options.operatorQualification,keys),window=qualification.window,s=planFrom(qualification,keys);
 const current=options.currentRuntimeQualification===undefined?null:currentRuntimeOf(options.currentRuntimeQualification,keys,qualification,s);
 if(Object.hasOwn(environment,'RENDER_API_KEY'))fail('PRODUCTION_EPOCH_OPERATOR_LOGIN_MUST_STAY_LOCAL');
 if(current){if(executionProfile(environment)!==current.profile)fail('PRODUCTION_EPOCH_CURRENT_BUSINESS_PROFILE_REQUIRED');if(current.terminalLabel==='D_ABORT33')assertSchemaTransitionProfile(environment);}else assertSchemaTransitionProfile(environment);
 if(environment.RENDER_GIT_COMMIT===undefined||environment.PHASE4_RELEASE_SHA===undefined||configDigest(keys,environment)!==(current?.currentStaticConfigurationDigest??qualification.staticConfigurationDigest))fail('PRODUCTION_EPOCH_ACTUAL_STATIC_CONFIG_REQUIRED');
 const actualRelease=runningReleaseSha(environment);if(current?actualRelease!==current.currentRuntimeSha:actualRelease!==window.source33RuntimeSha&&actualRelease!==window.targetRuntimeSha)fail('PRODUCTION_EPOCH_ACTUAL_CHECKOUT_REQUIRED');
 if(options.processBoot!==undefined&&!same(capturedBoot(options.processBoot,keys,actualRelease),qualification.bootRow))fail('PRODUCTION_EPOCH_PROCESS_BOOT_QUALIFICATION_MISMATCH');
 let busy=false,closed=false,uncertain=false,generation=0;const identity=Object.freeze({});
 const check=()=>{if(closed)fail('PRODUCTION_EPOCH_BOOTSTRAP_CLOSED');if(runningReleaseSha(environment)!==actualRelease)fail('PRODUCTION_EPOCH_ACTUAL_CHECKOUT_REQUIRED');assertCleanStage8Release(actualRelease,fileURLToPath(new URL('../',import.meta.url)));};
 const maintenance=()=>{check();active(window);if(current)fail('PRODUCTION_EPOCH_NORMAL_QUALIFICATION_CANNOT_REOPEN_MAINTENANCE');};
 async function observeRestart(){
  check();if(busy)fail('PRODUCTION_EPOCH_BOOTSTRAP_BUSY');busy=true;const capturedGeneration=++generation,lease=readLease();let native;try{native=ownedNative(environment,lease);const terminalOnly=Boolean(current)||Date.now()>=window.originalWindowEndMs,result=await inspectOwned(native,keys,window,s,{lease,terminalOnly,businessObservation:true});check();if(current?result.epoch.label!==current.terminalLabel:actualRelease!==(result.schema===33?window.source33RuntimeSha:window.targetRuntimeSha))fail('PRODUCTION_EPOCH_SCHEMA_RUNTIME_SHA_MISMATCH');if(!['C_BUSINESS35','D_ABORT33'].includes(result.epoch.label))active(window);uncertain=false;
   const observation=Object.freeze({contract:'production-transition-r3-owned-restart-observation-v1',productionAuthority:'NONE',phase:result.epoch.label,schema:result.schema});observations.set(observation,{identity,s,epoch:result.epoch,actualSchema:result.schema,targetUrl:P.databaseUrl,manifestSha:sha(JSON.stringify(result.schema===33?s.sourceTriggers:s.targetTriggers)),observedAtMs:Date.now(),window,keys,actualRelease,currentCohortDigest:result.currentCohortDigest,owner:()=>!closed&&!uncertain&&capturedGeneration===generation});return observation;
  }catch(error){uncertain=true;throw error;}finally{try{native?.close();}catch(error){uncertain=true;throw error;}finally{busy=false;}}}
 const api=Object.freeze({observeRestart,
  async initializeBusiness33(){maintenance();const processBoot=capturedBoot(options.processBoot,keys,actualRelease);if(!same(processBoot,qualification.bootRow))fail('PRODUCTION_EPOCH_PROCESS_BOOT_QUALIFICATION_MISMATCH');if(busy||uncertain)fail('PRODUCTION_EPOCH_INITIALIZATION_UNCERTAIN');busy=true;let native;try{native=ownedNative(environment,window);
   if(Date.now()<qualification.qualifiedAtMs||Date.now()-qualification.qualifiedAtMs>120000)fail('PRODUCTION_EPOCH_FRESH_OPERATOR_BOOTSTRAP_REQUIRED');
   const prior=await inspectOwned(native,keys,window,null,{uninitialized:true});if(!same(prior.bootRow,qualification.bootRow)||prior.catalogDigest!==qualification.sourceCatalogDigest||!same(prior.sourceTables,s.sourceTables)||actualRelease!==window.source33RuntimeSha)fail('PRODUCTION_EPOCH_INITIAL_CATALOG_CHANGED');
   // Actual owned BEGIN IMMEDIATE: repeat canonical metadata under the same
   // writer lock before installing the exact permanent manifest and signed A.
   const tx=await native.transaction('write');try{if(!same(await actualBootRow(tx,keys),qualification.bootRow)||!same(capturedBoot(options.processBoot,keys,actualRelease),qualification.bootRow))fail('PRODUCTION_EPOCH_ORIGINAL_BOOT_REVOKED');const catalog=(await tx.execute(catalogSql)).rows,versions=(await tx.execute(versionsSql)).rows,checkpoints=(await tx.execute(checkpointsSql)).rows,roster=(await tx.execute({sql:cohortSql,args:window.tenants.map(t=>t.whoopUserId)})).rows;if(keys.lookup(['production-transition-r3-actual-catalog-v1',catalog])!==qualification.sourceCatalogDigest||keys.lookup(['production-transition-r3-actual-authority-v1',versions,checkpoints,roster])!==prior.authorityDigest||(await tx.execute({sql:registrySql,args:[allOperatorPrefix.length,allOperatorPrefix]})).rows.length)fail('PRODUCTION_EPOCH_INITIAL_CATALOG_CHANGED');for(const statement of productionEpochManifestStatements(s,'install33')){maintenance();await tx.execute(statement);}maintenance();await tx.commit();}catch(error){uncertain=true;try{await tx.rollback();}catch{}throw error;}finally{tx.close();}
  }catch(error){uncertain=true;throw error;}finally{try{native?.close();}catch(error){uncertain=true;throw error;}finally{busy=false;}}return observeRestart();
  },
  inspect(observation){const o=observations.get(observation);if(!o||o.identity!==identity)fail('PRODUCTION_EPOCH_ORIGINAL_ACTUAL_OBSERVATION_REQUIRED');check();return {productionAuthority:'NONE',phase:o.epoch.label,schema:o.actualSchema,source33RuntimeSha:window.source33RuntimeSha,targetRuntimeSha:window.targetRuntimeSha,historicalCa4BaselineSha:window.historicalCa4BaselineSha,currentRuntimeSha:actualRelease,currentRuntimeConfiguration:current?'SEPARATELY_OPERATOR_QUALIFIED':'ORIGINAL_SETTLED_CONFIGURATION',currentCohortDigest:o.currentCohortDigest,originalWindowId:window.originalWindowId,originalWindowEndMs:window.originalWindowEndMs,maintenanceCommandsAllowed:!current&&Date.now()>=window.originalWindowStartMs&&Date.now()<window.originalWindowEndMs,manifestSha256:o.manifestSha,observedAtMs:o.observedAtMs,uncertain,stableListener:'UNWIRED',migrationAndRevocationDispatch:'UNWIRED',postWindowRestart:'VERIFIED_TERMINAL_C35_OR_D33_ONLY',remoteSqlFinality:false};},
  close(){if(busy)fail('PRODUCTION_EPOCH_BOOTSTRAP_BUSY');closed=true;},
 });bootstrapContexts.set(api,{environment,keys,qualification,window,s,actualRelease,check,current,processBoot:options.processBoot});return api;
}
/** Fixed import bridge for the captured epoch issuer. Protected RAM contains
 * no new credential destination. Caller JSON/client cannot enter this WeakMap.
 * Captured scope MUST store once; constructors/reconnect never observe again.
 */
export function requireProductionEpochBootstrap(observation,keys){
 requirePhase4Keys(keys);const o=observations.get(observation);if(!o||!o.owner()||!keyContinuity(keys,o.keys))fail('PRODUCTION_EPOCH_ORIGINAL_ACTUAL_OBSERVATION_REQUIRED');if(!['C_BUSINESS35','D_ABORT33'].includes(o.epoch.label))active(o.window);
 if(Date.now()<o.observedAtMs||Date.now()-o.observedAtMs>30000||o.epoch.mode!=='BUSINESS')fail('PRODUCTION_EPOCH_FRESH_BUSINESS_OBSERVATION_REQUIRED');
 return {s:o.s,epoch:o.epoch,manifestSha:o.manifestSha,targetUrl:o.targetUrl,productionAuthority:'NONE',releaseSha:o.actualRelease};
}
const catalogContracts=new WeakMap();
/** Capture once beside the epoch admission. This returns neither keys nor
 * cohort-bearing trigger SQL. Reconnect must reuse the same opaque contract.
 */
export function captureProductionEpochCatalogContract(observation,keys){
 const a=requireProductionEpochBootstrap(observation,keys),reference=Object.freeze({contract:'production-transition-r3-exact-catalog-contract-v1',productionAuthority:'NONE'});
 catalogContracts.set(reference,{s:a.s,schema:a.epoch.schema,manifestSha:a.manifestSha,keys:a.s.keys});return reference;
}
/** Controlled exception for the original full runtime catalog check. Caller
 * must supply its ACTUAL complete catalog result in its admission read. Every
 * canonical object, optional retained DDL and exact expected fence is checked;
 * only those exact verified trigger rows are removed. No prefix whitelist.
 * This pure projection never creates a runtime/DB/provider authority itself.
 */
export function projectProductionEpochCatalogRows(reference,keys,rows){
 requirePhase4Keys(keys);const a=catalogContracts.get(reference);if(!a||!keyContinuity(keys,a.keys)||!Array.isArray(rows))fail('PRODUCTION_EPOCH_OPAQUE_CATALOG_CONTRACT_REQUIRED');
 const expected=manifestMap(a.schema===33?a.s.sourceTriggers:a.s.targetTriggers),complete=rows.map(row=>({type:row.type,name:row.name,tbl_name:row.tbl_name??expected.get(row.name)?.table,sql:row.sql}));
 validateCatalog(complete,a.schema,a.s,true);
 return {rows:rows.filter(row=>!expected.has(row.name)).map(row=>({...row})),evidence:Object.freeze({contract:'production-transition-r3-exact-catalog-projection-v1',productionAuthority:'NONE',schema:a.schema,exactFenceCount:expected.size,manifestSha256:a.manifestSha,controlledException:true})};
}

/** Pure seal authentication/manifest derivation. No actual observation or Production grant. */
export function authenticateProductionEpochQualification({keys,operatorQualification}={}){
 requirePhase4Keys(keys);const qualification=qualificationOf(operatorQualification,keys),s=planFrom(qualification,keys);
 return Object.freeze({s,window:s.bridge,qualificationTransport:s.qualificationTransport,productionAuthority:'NONE'});
}
/** Owned fixed-target read-only cold-start transport discovery. The signed full
 * original scope survives process death without a new environment/provider write. */
export async function discoverOriginalQualification({environment,currentRuntimeQualification}={}){
 const env=Object.freeze({...environment});if(env.RENDER_API_KEY!==undefined)fail('PRODUCTION_EPOCH_OPERATOR_LOGIN_MUST_STAY_LOCAL');
 const keys=phase4AuthorityKeys(env),lease=readLease(),client=ownedNative(env,lease);let record;
 try{const rows=(await client.execute({sql:'SELECT key,value,updated_at FROM telegram_state WHERE key=?',args:[PRODUCTION_EPOCH_QUALIFICATION_KEY]})).rows;readBudget(lease);if(rows.length!==1||typeof rows[0].value!=='string'||Buffer.byteLength(rows[0].value)>65536)fail('PRODUCTION_EPOCH_IMMUTABLE_QUALIFICATION_REQUIRED');
  let wire;try{wire=JSON.parse(rows[0].value);}catch{fail('PRODUCTION_EPOCH_IMMUTABLE_QUALIFICATION_REQUIRED');}
  if(!exact(wire,['contract','qualification','digest'])||wire.contract!=='production-transition-r3-immutable-qualification-transport-v1')fail('PRODUCTION_EPOCH_IMMUTABLE_QUALIFICATION_REQUIRED');
  const q=qualificationOf(wire.qualification,keys),expected=qualificationTransportOf(q,keys);if(rows[0].value!==expected.value||rows[0].updated_at!==expected.updated_at||!equal(wire.digest,expected.digest))fail('PRODUCTION_EPOCH_IMMUTABLE_QUALIFICATION_REQUIRED');record=wire.qualification;
 }finally{client.close();}
 const bootstrap=createProductionEpochBootstrap({environment:env,operatorQualification:record,...(currentRuntimeQualification===undefined?{}:{currentRuntimeQualification})});
 try{const observation=await bootstrap.observeRestart();return Object.freeze({bootstrap,observation,productionAuthority:'NONE'});}catch(error){bootstrap.close();throw error;}
}

// Literal top-level signed wire admission copied from the reviewed original
// bridge. No full health payload, extra fields, user aliases or duplicate keys.
function canonicalTenant(value){if(typeof value==='number'){if(!Number.isSafeInteger(value)||value<=0)fail('PRODUCTION_EPOCH_INGRESS_TENANT_REQUIRED');return String(value);}if(typeof value!=='string'||!/^[1-9][0-9]{0,19}$/.test(value))fail('PRODUCTION_EPOCH_INGRESS_TENANT_REQUIRED');return value;}
function wireFields(text){
 let at=0;const fields=[],space=()=>{while(at<text.length&&/[\x20\t\r\n]/.test(text[at]))at++;};
 const string=()=>{const start=at;if(text[at++]!=='"')return null;while(at<text.length){const c=text[at++];if(c==='\\')at++;else if(c==='"')return text.slice(start,at);}return null;};
 space();if(text[at++]!=='{')return null;
 for(;;){space();const key=string();if(key===null)return null;space();if(text[at++]!==':')return null;space();const start=at;
  if(text[at]==='"'){if(string()===null)return null;}else while(at<text.length&&!/[\x20\t\r\n,}]/.test(text[at]))at++;
  const token=text.slice(start,at);if(!token)return null;fields.push({key,token});space();
  if(text[at]===','){at++;continue;}if(text[at++]==='}')break;return null;
 }space();return at===text.length?fields:null;
}
function approvedMetadata(raw){
 let text,value;try{text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(raw);value=JSON.parse(text);}catch{return null;}
 if(!exact(value,['user_id','id','type','trace_id']))return null;
 const fields=wireFields(text),names=fields?.map(field=>field.key);
 if(!names||names.length!==4||new Set(names).size!==4||names.some(name=>!['"user_id"','"id"','"type"','"trace_id"'].includes(name)))return null;
 let tenant;try{tenant=canonicalTenant(value.user_id);}catch{return null;}
 if(fields.find(field=>field.key==='"user_id"').token!==(typeof value.user_id==='number'?tenant:'"'+tenant+'"'))return null;
 const uuid=id=>typeof id==='string'&&/^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$/.test(id);
 if(!uuid(value.id)||typeof value.trace_id!=='string'||!value.trace_id.trim()||value.trace_id.trim().length>128||/[\x00-\x1f\x7f]/.test(value.trace_id.trim()))return null;
 const parsed=parseWhoopEvent(text);return parsed.ok?{tenant,event:parsed.event}:null;
}

const ingressInsertSql=`INSERT INTO whoop_webhook_events
 (provider, whoop_user_id, event_type, resource_type, resource_id, trace_id,
 event_at, received_at, state, attempt_count, created_at, updated_at)
 VALUES ('whoop', ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`;
const ingressDuplicateSql=`SELECT id FROM whoop_webhook_events WHERE whoop_user_id = ? AND event_type = ? AND resource_id = ? AND trace_id = ?`,ingressRowSql='SELECT * FROM whoop_webhook_events WHERE id = ?';
const ingressResponse=(status,body={ok:status===200})=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json','cache-control':'no-store'}});
async function ingressBody(request,check,signal){const reader=request.body?.getReader();if(!reader)return Buffer.alloc(0);const chunks=[];let size=0;const cancel=()=>{try{void reader.cancel().catch(()=>{});}catch{}};signal.addEventListener('abort',cancel,{once:true});try{for(;;){check();const next=await reader.read();check();if(next.done)break;size+=next.value.length;if(size>16384)fail('PRODUCTION_EPOCH_INGRESS_BODY_TOO_LARGE');chunks.push(Buffer.from(next.value));}return Buffer.concat(chunks);}finally{signal.removeEventListener('abort',cancel);cancel();try{reader.releaseLock();}catch{}}}
/** Dedicated original-window intake, independent of permanently revoked business
 * scopes. Initialize BEFORE initial business admission closes. The same handler
 * survives exact pre-fence33 -> A33 -> B33/B35 -> C35/D33 and uses no business
 * factory. Own fixed native SDK only; caller JSON/client/Boolean cannot grant it.
 * A timed-out native operation remains tracked until it settles; timeout/close
 * is never treated as remote SQL finality or permission to ACK.
 */
export async function initializeProductionEpochIngress(options={}){
 if(!exact(options,['environment','operatorQualification',...(Object.hasOwn(options,'processBoot')?['processBoot']:[])]))fail('PRODUCTION_EPOCH_OWNED_INGRESS_REQUIRED');
 const bootstrap=createProductionEpochBootstrap(options),c=bootstrapContexts.get(bootstrap),{environment,keys,qualification,window,s,actualRelease}=c;
 // Migration-first imports can reach this module through the epoch graph.
 // Imported normalizers are used only after module initialization completes.
 const canonicalIngressSql=new Set([ingressInsertSql,ingressDuplicateSql,ingressRowSql].map(normalizeSql));
 if(typeof environment.WHOOP_CLIENT_SECRET!=='string'||!environment.WHOOP_CLIENT_SECRET)fail('PRODUCTION_EPOCH_INGRESS_SECRET_REQUIRED');
 let accepting=true,closed=false;const activeWork=new Set(),operationTimeoutMs=10000;
 const windowCheck=()=>{const now=Date.now();if(now<window.acceptFromMs||now>=window.acceptUntilMs||now<window.originalWindowStartMs||now>=window.originalWindowEndMs)fail('PRODUCTION_EPOCH_INGRESS_WINDOW_INACTIVE');};
 async function validate(client,lease){windowCheck();const actual=await inspectOwned(client,keys,window,s,{allowUninitialized:true,lease});windowCheck();if(actual.uninitialized&&!same(capturedBoot(c.processBoot,keys,actualRelease),qualification.bootRow))fail('PRODUCTION_EPOCH_PROCESS_BOOT_QUALIFICATION_MISMATCH');if(actualRelease!==(actual.schema===33?window.source33RuntimeSha:window.targetRuntimeSha)||actual.uninitialized&&actual.catalogDigest!==qualification.sourceCatalogDigest)fail('PRODUCTION_EPOCH_INGRESS_CURRENT_RUNTIME_REQUIRED');return actual;}
 try{c.check();windowCheck();const lease=readLease(),client=ownedNative(environment,lease);try{await validate(client,lease);}finally{client.close();}c.check();}catch(error){bootstrap.close();throw error;}
 const handle=async request=>{
  let url;try{url=new URL(request.url);}catch{return ingressResponse(400);}if(url.origin!==P.origin)return ingressResponse(400);if(url.pathname!=='/whoop/webhook')return ingressResponse(503);if(url.search||url.hash)return ingressResponse(400);if(request.method!=='POST')return ingressResponse(405);
  if(!accepting||closed||activeWork.size>=16)return ingressResponse(503);try{windowCheck();}catch{return ingressResponse(503);}
  const started=Date.now(),deadlineAt=Math.min(started+operationTimeoutMs,window.acceptUntilMs,window.originalWindowEndMs),abort=new AbortController();let stopped=false,timer,raw;
  const check=()=>{if(stopped||Date.now()<started||Date.now()>=deadlineAt)fail('PRODUCTION_EPOCH_INGRESS_DEADLINE');windowCheck();};
  const work=(async()=>{let client;try{
   check();raw=await ingressBody(request,check,abort.signal);check();const headers=Object.fromEntries(request.headers),auth=verifyWhoopWebhook({headers,rawBody:raw,clientSecret:environment.WHOOP_CLIENT_SECRET,now:started});if(!auth.ok)return ingressResponse(401);
   const metadata=approvedMetadata(raw);if(!metadata)return ingressResponse(400);if(!window.tenants.some(t=>t.whoopUserId===metadata.tenant))return ingressResponse(403);
   const lease={...window,originalWindowEndMs:deadlineAt};client=ownedNative(environment,lease);await validate(client,lease);check();
   const limited={execute:async statement=>{check();const sql=normalizeSql(typeof statement==='string'?statement:statement.sql);if(!canonicalIngressSql.has(sql))fail('PRODUCTION_EPOCH_INGRESS_CANONICAL_SQL_REQUIRED');const result=await client.execute(statement);check();return result;}};
   const store=createWhoopWebhookStore(limited),e=metadata.event,args={whoopUserId:e.whoopUserId,eventType:e.eventType,resourceType:e.resourceType,resourceId:e.resourceId,traceId:e.traceId,eventAt:String(auth.timestampMs),now:new Date(started)},receipt=await store.recordWhoopEvent(args);check();
   if(!Number.isSafeInteger(receipt?.id)||receipt.id<=0||typeof receipt.inserted!=='boolean'||typeof receipt.duplicate!=='boolean'||receipt.inserted===receipt.duplicate)fail('PRODUCTION_EPOCH_INGRESS_DURABLE_RECEIPT_REQUIRED');
   const rows=(await limited.execute({sql:ingressRowSql,args:[receipt.id]})).rows,row=rows[0];if(rows.length!==1||row.provider!=='whoop'||row.whoop_user_id!==metadata.tenant||row.event_type!==e.eventType||row.resource_type!==e.resourceType||row.resource_id!==e.resourceId||row.trace_id!==e.traceId)fail('PRODUCTION_EPOCH_INGRESS_DURABLE_IDENTITY_REQUIRED');
   if(receipt.inserted&&(row.state!=='RECEIVED'||row.attempt_count!==0||['user_id','owner','lease_expires_at','next_attempt_at','last_error_class','last_error_detail','processed_at','health_content_redacted_at','health_content_redaction_reason','source_subject_deleted_at','content_digest_salt','privacy_artifact_id'].some(field=>row[field]!==null)||row.content_state!=='LEGACY_UNLINKED'||row.source_linkage_state!=='LEGACY_UNLINKED'||row.purge_generation!==0||row.event_at!==String(auth.timestampMs)||row.received_at!==new Date(started).toISOString()||row.created_at!==row.received_at||row.updated_at!==row.received_at))fail('PRODUCTION_EPOCH_INGRESS_NEW_DEFAULTS_REQUIRED');
   check();return ingressResponse(200,{ok:true,outcome:receipt.duplicate?'duplicate':'recorded'});
  }catch(error){return ingressResponse(error?.code==='PRODUCTION_EPOCH_INGRESS_BODY_TOO_LARGE'?413:503);}finally{raw?.fill(0);if(client)client.close();}})();activeWork.add(work);work.finally(()=>activeWork.delete(work)).catch(()=>{});
  try{return await Promise.race([work,new Promise(resolve=>{timer=setTimeout(()=>{stopped=true;abort.abort();resolve(ingressResponse(503));},Math.max(1,deadlineAt-Date.now()));})]);}finally{stopped=true;clearTimeout(timer);abort.abort();}
 };
 const nodeHandler=async(req,res)=>{try{const method=req.method??'GET',request=new Request(P.origin+(req.url??'/'),{method,headers:req.headers,...(!['GET','HEAD'].includes(method)?{body:Readable.toWeb(req),duplex:'half'}:{})}),result=await handle(request);res.writeHead(result.status,Object.fromEntries(result.headers));res.end(Buffer.from(await result.arrayBuffer()));}catch{if(!res.headersSent)res.writeHead(503,{'content-type':'application/json','cache-control':'no-store'});res.end('{"ok":false}');}};
 return Object.freeze({handle,nodeHandler,productionAuthority:'NONE',originalWindowId:window.originalWindowId,
  closeAdmission(){accepting=false;return Object.freeze({admissionClosed:true,remainingNativeOperations:activeWork.size,remoteSqlFinality:false});},
  async drain(){await Promise.allSettled([...activeWork]);return Object.freeze({remainingNativeOperations:activeWork.size,remoteSqlFinality:false});},
  inspect(){return Object.freeze({accepting:accepting&&!closed,remainingNativeOperations:activeWork.size,productionAuthority:'NONE',remoteSqlFinality:false});},
  close(){if(activeWork.size)fail('PRODUCTION_EPOCH_INGRESS_ACTIVE_NATIVE_OPERATIONS');accepting=false;closed=true;bootstrap.close();}
 });
}
