/** Stable production supervision and original-window recovery. No caller runtime/client/fetch or
 * Boolean can mint startup/maintenance authority. The protected local operator
 * alone owns B/atomic/revocation dispatch. This controller owns ONE listener,
 * local runtime lifetimes and authenticated fixed-window prepare/resume only.
 * Every timeout retains ownership; local drain is not remote SQL cancellation.
 */
import http from 'node:http';
import {runtimeHeapLimitBytes} from './runtimeHeapObservation.js';
import {captureProductionFastControl,takeProductionFastControlStatements,productionFastControlEvidence} from './productionFastControl.js';
import {discoverProductionCurrentTerminalRuntime} from './currentTerminalRuntime.js';
import {revokeProductionUninitializedAttempt,observeProductionInitializationRevocation,requireProductionInitializationRevocation} from './productionInitializationRevocation.js';
import {createClient} from '@libsql/client';
import {stage8PreservationSnapshot} from '../scripts/stage8-migration-safety.mjs';
import {createHash,timingSafeEqual} from 'node:crypto';
import {phase4AuthorityKeys} from './phase4EnvironmentKeys.js';
import {requirePhase4Keys} from './phase4Keys.js';
import {runningReleaseSha} from './phase4Release.js';
import {assertSchemaTransitionProfile,schemaTransitionRuntimeProfileFor} from './schemaTransitionProfile.js';
import {canonicalRuntimeContract} from './runtimeAdmission.js';
import {normalizeSql} from './phase4Migrations.js';
import {RETAINED_LEGACY_TABLE_DDL} from './schema.js';
import {PROFILE_REVISION_PREFIX} from './profileRevision.js';
import {createDb} from './db.js';
import {main as managedMain} from './bot/webhook.js';
import {captureProductionSupervisorEpochAdmission} from './epochPermitClient.js';
import {createSupervisorRuntimeEpochScope,revokeSupervisorRuntimeEpochScope} from './runtimeEpochScope.js';
import {PRODUCTION_EPOCH_QUALIFICATION_KEY} from './productionEpochManifest.js';
import {PRODUCTION_EPOCH_TARGET as P,authenticateProductionEpochQualification,createProductionEpochBootstrap,discoverOriginalQualification,initializeProductionEpochIngress,requireProductionEpochBootstrap,advanceProductionSupervisorBoot} from './productionEpochBootstrap.js';
import {createStableWebhookRouter,createColdStableWebhookRouter} from './stableWebhookRouter.js';
const fail=code=>{throw Object.assign(Error(code),{code});},sha=x=>createHash('sha256').update(x).digest('hex'),same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const exact=(v,fields)=>v&&Object.getPrototypeOf(v)===Object.prototype&&Reflect.ownKeys(v).length===fields.length&&fields.every(k=>Object.hasOwn(v,k));
const COMMAND='production-supervisor-owner-command-v2',UNINITIALIZED_COMMAND='production-supervisor-owner-command-v3',CONTROL_PATH='/internal/production-transition-control',allOperatorPrefix=PROFILE_REVISION_PREFIX+'operator:';
const baseCommandFields=['contract','action','originalWindowId','commandId','issuedAtMs','expiresAtMs'];
const commandDomain=body=>body?.action==='abort-uninitialized'?UNINITIALIZED_COMMAND:COMMAND;
const mac=(keys,body)=>{const domain=commandDomain(body);return keys.digest(keys.lookup([domain]),[domain,body]);};
function commandOf(body){if(!exact(body,body?.action==='prepare'?[...baseCommandFields,'operatorQualification']:baseCommandFields)||body.contract!==commandDomain(body)||!['prepare','resume','status','abort-before-b','abort-uninitialized'].includes(body.action)||!/^[A-Za-z0-9_-]{16,128}$/.test(body.originalWindowId??'')||!/^[a-f0-9]{64}$/.test(body.commandId??'')||![body.issuedAtMs,body.expiresAtMs].every(Number.isSafeInteger)||body.issuedAtMs<=0||body.expiresAtMs<=body.issuedAtMs||body.expiresAtMs-body.issuedAtMs>120000)fail('SUPERVISOR_EXACT_BOUNDED_COMMAND_REQUIRED');return structuredClone(body);}
/** Protected local owner command sealing only; does not create an operator
 * qualification, consent, DB grant or native settlement proof. */
export function sealProductionSupervisorCommand({keys,command}={}){requirePhase4Keys(keys);const body=commandOf(command);if(body.action==='abort-uninitialized')fail('SUPERVISOR_SEPARATE_UNINITIALIZED_COMMAND_REQUIRED');return Object.freeze({body,signature:mac(keys,body)});}
export function sealProductionUninitializedAbortCommand({keys,command}={}){requirePhase4Keys(keys);const body=commandOf(command);if(body.action!=='abort-uninitialized')fail('SUPERVISOR_EXACT_UNINITIALIZED_COMMAND_REQUIRED');return Object.freeze({body,signature:mac(keys,body)});}
function authenticateCommand(value,keys){if(!exact(value,['body','signature'])||!/^[a-f0-9]{64}$/.test(value.signature??''))fail('SUPERVISOR_OWNER_AUTHENTICATION_REQUIRED');const expected=mac(keys,value.body);if(!timingSafeEqual(Buffer.from(value.signature,'hex'),Buffer.from(expected,'hex')))fail('SUPERVISOR_OWNER_AUTHENTICATION_REQUIRED');const body=commandOf(value.body),now=Date.now();if(now<body.issuedAtMs||now>=body.expiresAtMs)fail('SUPERVISOR_OWNER_COMMAND_EXPIRED');return body;}
function commandLive(command,signal){signal.throwIfAborted();const now=Date.now();if(now<command.issuedAtMs||now>=command.expiresAtMs)fail('SUPERVISOR_OWNER_COMMAND_EXPIRED');}
function fixedNative(environment){if(environment.TURSO_DATABASE_URL!==P.databaseUrl||typeof environment.TURSO_AUTH_TOKEN!=='string'||!environment.TURSO_AUTH_TOKEN)fail('SUPERVISOR_FIXED_DATABASE_REQUIRED');return createClient({url:P.databaseUrl,authToken:environment.TURSO_AUTH_TOKEN,intMode:'number',fetch:(input,init)=>{const u=new URL(typeof input==='string'?input:input.url);if(u.origin!=='https://'+new URL(P.databaseUrl).hostname)fail('SUPERVISOR_FIXED_DATABASE_REQUIRED');return fetch(input,{...init,redirect:'error',signal:AbortSignal.any([...(init?.signal?[init.signal]:[]),AbortSignal.timeout(15000)])});}});}
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

const catalogSql="SELECT type,name,tbl_name,rootpage,sql FROM sqlite_master WHERE type IN ('table','index','trigger','view') ORDER BY type,name";
/** Own actual startup classification. An absent row is never inferred from a
 * caught verification error. No health/history values are queried here. */
async function readStartup(environment,keys){const native=fixedNative(environment);let tx;try{tx=await native.transaction('read');const versions=(await tx.execute('SELECT version,note FROM schema_version ORDER BY version')).rows,schema=Math.max(0,...versions.map(r=>r.version)),rows=(await tx.execute({sql:'SELECT key,value,updated_at FROM telegram_state WHERE substr(key,1,?)=? ORDER BY key',args:[allOperatorPrefix.length,allOperatorPrefix]})).rows,catalog=(await tx.execute(catalogSql)).rows;
 if(![33,35].includes(schema)||versions.some(r=>!Number.isSafeInteger(r.version)))fail('SUPERVISOR_COMMITTED_33_OR_35_REQUIRED');for(let v=21;v<=schema;v++)if(versions.filter(r=>r.version===v&&r.note===`phase4 v${v} postconditions verified`).length!==1)fail('SUPERVISOR_CANONICAL_VERSION_MARKERS_REQUIRED');
 const checkpoints=(await tx.execute("SELECT step_key,last_cursor,postcondition_state FROM phase4_migration_checkpoints WHERE target_version=22 AND step_key IN ('lookup_key_check','audit_key_check') ORDER BY step_key")).rows;if(checkpoints.length!==2||checkpoints.some(r=>r.postcondition_state!=='COMPLETE'||!(r.step_key==='lookup_key_check'?keys.verifyLookupCheckpoint(r.last_cursor):r.step_key==='audit_key_check'&&keys.verifyAuditCheckpoint(r.last_cursor))))fail('SUPERVISOR_KEY_CONTINUITY_REQUIRED');
 if(rows.length===0){if(schema!==33)fail('SUPERVISOR_UNSCOPED_START_REQUIRES33');validateCatalog(catalog,33,null,false);await tx.commit();return {kind:'PREFENCE33',schema,phase:'PREFENCE33',operatorQualification:null};}
 const transport=rows.find(r=>r.key===PRODUCTION_EPOCH_QUALIFICATION_KEY);if(!transport||typeof transport.value!=='string'||Buffer.byteLength(transport.value)>65536)fail('SUPERVISOR_IMMUTABLE_QUALIFICATION_REQUIRED');let wire;try{wire=JSON.parse(transport.value);}catch{fail('SUPERVISOR_IMMUTABLE_QUALIFICATION_REQUIRED');}if(!exact(wire,['contract','qualification','digest'])||wire.contract!=='production-transition-r3-immutable-qualification-transport-v1')fail('SUPERVISOR_IMMUTABLE_QUALIFICATION_REQUIRED');
 const {s,window}=authenticateProductionEpochQualification({keys,operatorQualification:wire.qualification});if(rows.length!==2||transport.value!==s.qualificationTransport.value||transport.updated_at!==s.qualificationTransport.updated_at)fail('SUPERVISOR_IMMUTABLE_QUALIFICATION_REQUIRED');const actual=rows.find(r=>r.key===s.registryKey),epoch=s.records.find(r=>r.value===actual?.value&&r.updated_at===actual.updated_at);if(!epoch||(epoch.label==='B_INGRESS_ONLY'?![33,35].includes(schema):epoch.schema!==schema))fail('SUPERVISOR_EXACT_DURABLE_PHASE_REQUIRED');validateCatalog(catalog,schema,s,true);await tx.commit();return {kind:'ORIGINAL_TRANSITION',schema,phase:epoch.label,operatorQualification:wire.qualification,s,window};
 }catch(error){try{await tx?.rollback();}catch{}throw error;}finally{tx?.close();native.close();}}
async function proveUnscoped33(environment,keys){const db=createDb({url:P.databaseUrl,authToken:environment.TURSO_AUTH_TOKEN,phase4Keys:keys,runtimeProfile:schemaTransitionRuntimeProfileFor({environment,keys})});try{const cap=await db.admitRuntime({source:'event'});if(db.requireRuntimeAdmission(cap)!==33)fail('SUPERVISOR_UNSCOPED_START_REQUIRES33');}finally{db.close();}}

const literal=x=>"'"+String(x).replaceAll("'","''")+"'",ident=x=>{if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(x))fail('SUPERVISOR_SAFE_IDENTIFIER_REQUIRED');return '"'+x+'"';};
const TYPES=['sleep.updated','sleep.deleted','recovery.updated','recovery.deleted','workout.updated','workout.deleted'];
const DEFAULTS={provider:'whoop',user_id:null,state:'RECEIVED',attempt_count:0,owner:null,lease_expires_at:null,next_attempt_at:null,last_error_class:null,last_error_detail:null,processed_at:null,content_state:'LEGACY_UNLINKED',health_content_redacted_at:null,health_content_redaction_reason:null,source_subject_deleted_at:null,purge_generation:0,source_linkage_state:'LEGACY_UNLINKED',content_digest_salt:null,privacy_artifact_id:null};
function metadataPredicate(binding){
 const trace='NEW.trace_id',resource='NEW.resource_id',whitespace='9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279';
 return `NEW.whoop_user_id IN (${binding.tenants.map(t=>literal(String(t.whoopUserId))).join(',')}) AND NEW.event_type IN (${TYPES.map(literal).join(',')}) AND NEW.resource_type=substr(NEW.event_type,1,instr(NEW.event_type,'.')-1) AND typeof(${resource})='text' AND length(${resource})=36 AND length(CAST(${resource} AS BLOB))=36 AND substr(${resource},9,1)='-' AND substr(${resource},14,1)='-' AND substr(${resource},19,1)='-' AND substr(${resource},24,1)='-' AND length(replace(${resource},'-',''))=32 AND replace(${resource},'-','') NOT GLOB '*[^0-9a-fA-F]*' AND typeof(${trace})='text' AND length(${trace}) BETWEEN 1 AND 128 AND instr(${trace},char(0))=0 AND unicode(substr(${trace},1,1)) NOT IN (${whitespace}) AND unicode(substr(${trace},-1,1)) NOT IN (${whitespace}) AND (WITH RECURSIVE chars(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM chars WHERE n<length(${trace})) SELECT sum(CASE WHEN unicode(substr(${trace},n,1))>65535 THEN 2 ELSE 1 END)<=128 AND max(CASE WHEN unicode(substr(${trace},n,1)) BETWEEN 0 AND 31 OR unicode(substr(${trace},n,1))=127 THEN 1 ELSE 0 END)=0 FROM chars) AND ${Object.entries(DEFAULTS).map(([k,v])=>`NEW.${ident(k)} IS ${v===null?'NULL':typeof v==='number'?v:literal(v)}`).join(' AND ')} AND NEW.received_at=NEW.created_at AND NEW.received_at=NEW.updated_at AND typeof(NEW.received_at)='text' AND strftime('%Y-%m-%dT%H:%M:%fZ',julianday(NEW.received_at))=NEW.received_at AND NEW.received_at>=${literal(new Date(binding.acceptFromMs).toISOString())} AND NEW.received_at<${literal(new Date(binding.acceptUntilMs).toISOString())} AND typeof(NEW.event_at)='text' AND length(NEW.event_at)=13 AND length(CAST(NEW.event_at AS BLOB))=13 AND NEW.event_at NOT GLOB '*[^0-9]*' AND abs(CAST(NEW.event_at AS INTEGER)-(CAST(strftime('%s',NEW.received_at) AS INTEGER)*1000+CAST(substr(NEW.received_at,21,3) AS INTEGER)))<=300000`;
}

async function abortDefinitions(tx,s){const definition={};for(const table of s.sourceTables)if(table!=='sqlite_sequence')definition[table]={columns:(await tx.execute('PRAGMA table_info('+ident(table)+')')).rows.map(r=>r.name)};return definition;}
async function abortSnapshot(tx,keys,s,base,{normalizeRegistry=false}={}){
 const projected={execute:async statement=>{const sql=typeof statement==='string'?statement:statement.sql;
  if(sql.includes(' FROM "whoop_webhook_events" ORDER BY "id" LIMIT 1024 OFFSET ?'))return tx.execute({sql:sql.replace(' FROM "whoop_webhook_events" ORDER BY',' FROM "whoop_webhook_events" WHERE id<='+base.max+' ORDER BY'),args:statement.args});
  const result=await tx.execute(statement);if(normalizeRegistry&&sql.includes(' FROM "telegram_state" ORDER BY '))return {...result,rows:result.rows.map(row=>row.key===s.registryKey?{...row,value:s.records[0].value,updated_at:s.records[0].updated_at}:row)};return result;
 }};return stage8PreservationSnapshot(projected,keys,base.definition);
}
function assertAbortRegistryUpdateHasNoSideEffects(s){
 const canonical=canonicalRuntimeContract(33);
 // The exact catalog validator below admits no other object. Canonical33 has
 // no trigger on telegram_state or FK pointing to it. Its key is not updated.
 if([...canonical.objects.values()].some(r=>r.type==='trigger'&&/\bON\s+["`\[]?telegram_state\b/i.test(r.ddl)||/\bREFERENCES\s+["`\[]?telegram_state\b/i.test(r.ddl)))fail('SUPERVISOR_ABORT_REGISTRY_SIDE_EFFECT_CONTRACT_CHANGED');
 const relevant=s.sourceTriggers.filter(q=>/ BEFORE (?:INSERT|UPDATE|DELETE) ON "telegram_state"/.test(q.sql));
 if(relevant.length!==3)fail('SUPERVISOR_ABORT_REGISTRY_GUARDS_REQUIRED');
 for(const q of relevant){const body=q.sql.slice(q.sql.indexOf(' BEGIN ')+7).replace(/'(?:''|[^'])*'|"(?:""|[^"])*"/g,'');if(!body.startsWith('SELECT ')||/\b(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|PRAGMA|ATTACH|DETACH)\b/i.test(body))fail('SUPERVISOR_ABORT_REGISTRY_SIDE_EFFECT_CONTRACT_CHANGED');}
}
async function readAbortAuthority(tx,keys,s,expected=s.records[0]){const versions=(await tx.execute('SELECT version,note FROM schema_version ORDER BY version')).rows;if(Math.max(...versions.map(r=>r.version))!==33)fail('SUPERVISOR_ABORT_ONLY_ACTUAL_A33');for(let v=21;v<=33;v++)if(versions.filter(r=>r.version===v&&r.note===`phase4 v${v} postconditions verified`).length!==1)fail('SUPERVISOR_ABORT_CANONICAL_MARKERS_REQUIRED');const catalog=(await tx.execute(catalogSql)).rows;validateCatalog(catalog,33,s,true);assertAbortRegistryUpdateHasNoSideEffects(s);
 const control=(await tx.execute({sql:'SELECT key,value,updated_at FROM telegram_state WHERE substr(key,1,?)=? ORDER BY key',args:[allOperatorPrefix.length,allOperatorPrefix]})).rows,a=s.records[0],transport=s.qualificationTransport;if(control.length!==2||!control.some(r=>r.key===expected.key&&r.value===expected.value&&r.updated_at===expected.updated_at)||!control.some(r=>r.key===transport.key&&r.value===transport.value&&r.updated_at===transport.updated_at))fail('SUPERVISOR_ABORT_ONLY_ACTUAL_A33');
 const boot=(await tx.execute({sql:'SELECT key,value,updated_at FROM telegram_state WHERE key=?',args:[s.bootRow.key]})).rows;if(boot.length!==1||boot[0].key!==s.bootRow.key||boot[0].value!==s.bootRow.value||boot[0].updated_at!==s.bootRow.updated_at)fail('SUPERVISOR_ABORT_ORIGINAL_BOOT_CHANGED');
 const checkpoints=(await tx.execute("SELECT step_key,last_cursor,postcondition_state FROM phase4_migration_checkpoints WHERE target_version=22 AND step_key IN ('lookup_key_check','audit_key_check') ORDER BY step_key")).rows;if(checkpoints.length!==2||checkpoints.some(r=>r.postcondition_state!=='COMPLETE'||!(r.step_key==='lookup_key_check'?keys.verifyLookupCheckpoint(r.last_cursor):r.step_key==='audit_key_check'&&keys.verifyAuditCheckpoint(r.last_cursor))))fail('SUPERVISOR_ABORT_KEYS_REQUIRED');
 const roster=(await tx.execute({sql:'SELECT u.id user_id,u.status,u.lifecycle_generation,t.whoop_user_id,t.auth_generation,p.source_generation,p.purge_generation,p.pending_purge_count FROM users u JOIN user_whoop_tokens t ON t.user_id=u.id JOIN phase4_user_state p ON p.user_id=u.id WHERE t.whoop_user_id IN (?,?,?) ORDER BY t.whoop_user_id',args:s.bridge.tenants.map(t=>t.whoopUserId)})).rows;if(roster.length!==3||s.bridge.tenants.some(t=>{const r=roster.find(r=>r.user_id===t.userId&&r.whoop_user_id===t.whoopUserId);return !r||r.status!=='ACTIVE'||r.lifecycle_generation!==t.lifecycleGeneration||r.auth_generation!==t.authGeneration||r.source_generation!==t.sourceGeneration||r.purge_generation!==t.purgeGeneration||r.pending_purge_count!==0;}))fail('SUPERVISOR_ABORT_CURRENT_ORIGINAL_THREE_REQUIRED');
 if((await tx.execute('PRAGMA foreign_keys')).rows[0]?.foreign_keys!==1||(await tx.execute('SELECT ignore_check_constraints FROM pragma_ignore_check_constraints()')).rows[0]?.ignore_check_constraints!==0)fail('SUPERVISOR_ABORT_CONSTRAINTS_REQUIRED');const normalized=control.map(r=>({key:r.key,value:r.key===s.registryKey?a.value:r.value,updated_at:r.key===s.registryKey?a.updated_at:r.updated_at}));return keys.lookup(['supervisor-abort-A-authority-v1',versions,catalog,normalized,boot,checkpoints,roster]);
}
async function verifyAbortRetainedRows(tx,keys,s,held,expected){
 const {base,snapshot,authority}=held;if(await readAbortAuthority(tx,keys,s,expected)!==authority)fail('SUPERVISOR_ABORT_ORIGINAL_AUTHORITY_CHANGED');if(!same(await abortSnapshot(tx,keys,s,base,{normalizeRegistry:expected.label==='D_ABORT33'}),snapshot))fail('SUPERVISOR_ABORT_ORIGINAL_HISTORY_CHANGED');
 const currentSequences=(await tx.execute('SELECT rowid,name,seq FROM sqlite_sequence ORDER BY name')).rows,other=rows=>rows.filter(r=>r.name!=='whoop_webhook_events');if(!same(other(base.sequences),other(currentSequences)))fail('SUPERVISOR_ABORT_OTHER_SEQUENCE_CHANGED');const currentMax=Number((await tx.execute('SELECT coalesce(max(id),0) n FROM whoop_webhook_events')).rows[0].n),originalSeq=base.sequences.find(r=>r.name==='whoop_webhook_events'),currentSeq=currentSequences.find(r=>r.name==='whoop_webhook_events'),expectedSeq=Math.max(originalSeq?.seq??0,currentMax);if(!Number.isSafeInteger(currentMax)||currentMax<base.max||((expectedSeq===0&&!originalSeq)?Boolean(currentSeq):!currentSeq||currentSeq.seq!==expectedSeq||originalSeq&&currentSeq.rowid!==originalSeq.rowid))fail('SUPERVISOR_ABORT_CANONICAL_SEQUENCE_REQUIRED');
 const appended=Number((await tx.execute({sql:'SELECT count(*) n FROM whoop_webhook_events WHERE id>?',args:[base.max]})).rows[0].n),predicate=metadataPredicate(s.bridge).replaceAll('NEW.','e.');if(!Number.isSafeInteger(appended)||appended>10000||(await tx.execute({sql:'SELECT count(*) n FROM whoop_webhook_events e WHERE id>? AND (id<=? OR NOT coalesce(('+predicate+'),0))',args:[base.max,Math.max(base.max,originalSeq?.seq??0)]})).rows[0].n!==0)fail('SUPERVISOR_ABORT_APPEND_INVALID');return appended;
}
/** Full original history is read only outside the short writer. Retained RAM
 * baseline survives lost ACK/caller timeout. A submitted local abort must finish
 * its exact D proof before this process can reopen business. No SQL cancellation
 * or predeployment drain authority is inferred by the pure metadata compiler. */
async function exactAbortBeforeB(environment,keys,s,qualification,signal,held,actualPhase){
 const w=s.bridge,check=()=>{signal.throwIfAborted();if(Date.now()<w.originalWindowStartMs||Date.now()>=w.originalWindowEndMs)fail('SUPERVISOR_ABORT_ORIGINAL_WINDOW_INACTIVE');};check();const native=fixedNative(environment);let tx;
 try{
  if(!held.base){if(actualPhase!=='A_BUSINESS33')fail('SUPERVISOR_ABORT_ORIGINAL_A_BASE_REQUIRED');tx=await native.transaction('read');const authority=await readAbortAuthority(tx,keys,s),definition=await abortDefinitions(tx,s),max=Number((await tx.execute('SELECT coalesce(max(id),0) n FROM whoop_webhook_events')).rows[0].n),sequences=(await tx.execute('SELECT rowid,name,seq FROM sqlite_sequence ORDER BY name')).rows;if(!Number.isSafeInteger(max)||max<0||sequences.some(r=>!Number.isSafeInteger(r.seq)||r.seq<0))fail('SUPERVISOR_ABORT_CANONICAL_SEQUENCE_REQUIRED');const base={definition,max,sequences},snapshot=await abortSnapshot(tx,keys,s,base);await tx.commit();tx.close();tx=null;held.base=base;held.snapshot=snapshot;held.authority=authority;held.fullReads=1;check();
  }else if(actualPhase==='A_BUSINESS33'){
   // Only a NEW explicit owner call can reach this retry. Read the genuine
   // original A/full baseline before taking another once-only fixed packet.
   tx=await native.transaction('read');await verifyAbortRetainedRows(tx,keys,s,held,s.records[0]);await tx.commit();tx.close();tx=null;held.fullReads++;check();
  }
  if(actualPhase==='A_BUSINESS33'){
   const gate=await captureProductionFastControl({environment,operatorQualification:qualification});check();const evidence=productionFastControlEvidence(gate),packet=takeProductionFastControlStatements({gate,transition:'A_TO_D'});held.submitted=true;held.nativeSettled=false;held.metadataEvidence=evidence;
   try{await native.batch(packet,'write');held.nativeAck=true;}finally{held.nativeSettled=true;}check();
  }else if(actualPhase!=='D_ABORT33'||!held.submitted)fail('SUPERVISOR_ABORT_ACTUAL_A_OR_OWN_D_REQUIRED');
  tx=await native.transaction('read');const appended=await verifyAbortRetainedRows(tx,keys,s,held,s.records[3]);await tx.commit();tx.close();tx=null;held.fullReads++;check();
  held.report=Object.freeze({productionAuthority:'NONE',phase:'D_ABORT33',schema:33,historyPreservedAcrossFreshOwnedAbort:true,historyComparison:'EXPLICIT_REGISTRY_NORMALIZATION_AND_VERIFIED_CANONICAL_APPEND',fullHistorySnapshotsOutsideWriter:held.fullReads,wholeHistoryReadsInsideWriter:0,nativeBatchCommitAckObserved:Boolean(held.nativeAck),actualDReadbackVerified:true,protectedOperatorRows:2,protectedBootRows:1,totalProtectedRows:3,appendedRows:appended,originalMigrationNeverIssued:false,trafficReopened:false,remoteSqlCancelled:false});return held.report;
 }catch(error){try{await tx?.rollback();}catch{}throw Object.assign(error,{supervisorAbortOutcome:held.submitted?'SUBMITTED_REQUIRES_ACTUAL_D_OR_ORIGINAL_A_PROOF':'NO_SUCCESS_RECEIPT'});}finally{tx?.close();native.close();}
}
const reject=(res,code=503,body={ok:false})=>{if(!res.headersSent)res.writeHead(code,{'content-type':'application/json','cache-control':'no-store'});if(!res.writableEnded)res.end(JSON.stringify(body));};
function joinOwned(promise,signal){signal.throwIfAborted();return new Promise((resolve,reject)=>{const clean=()=>signal.removeEventListener('abort',abort),abort=()=>{clean();reject(signal.reason);};signal.addEventListener('abort',abort,{once:true});promise.then(v=>{clean();resolve(v);},e=>{clean();reject(e);});if(signal.aborted)abort();});}
function nativeAdapter(raw){let closed=false,joining=null;return Object.freeze({handler:raw.nodeHandler,closeAdmission(){return raw.closeAdmission();},waitForDrained({signal}={}){if(!signal?.throwIfAborted)fail('SUPERVISOR_ABORT_SIGNAL_REQUIRED');joining??=raw.drain();return joinOwned(joining,signal);},async dispose({signal}={}){signal.throwIfAborted();await joinOwned(joining??=raw.drain(),signal);signal.throwIfAborted();if(raw.inspect().remainingNativeOperations)fail('SUPERVISOR_NATIVE_OPERATIONS_RETAINED');if(!closed){raw.close();closed=true;}},status:()=>raw.inspect()});}
function expiredIntake(){return Object.freeze({handler:(_req,res)=>reject(res),closeAdmission(){},async waitForDrained({signal}){signal.throwIfAborted();},async dispose({signal}){signal.throwIfAborted();}});}
async function commandBody(req,deadline){let bytes=0;const chunks=[],timer=setTimeout(()=>req.destroy(Object.assign(Error('SUPERVISOR_COMMAND_BODY_DEADLINE'),{code:'SUPERVISOR_COMMAND_BODY_DEADLINE'})),Math.max(1,deadline-Date.now()));try{for await(const chunk of req){if(Date.now()>=deadline)fail('SUPERVISOR_COMMAND_BODY_DEADLINE');bytes+=chunk.length;if(bytes>98304)fail('SUPERVISOR_COMMAND_BODY_TOO_LARGE');chunks.push(Buffer.from(chunk));}let value;const raw=Buffer.concat(chunks);try{value=JSON.parse(raw.toString('utf8'));}catch{fail('SUPERVISOR_COMMAND_JSON_REQUIRED');}finally{raw.fill(0);}return value;}finally{clearTimeout(timer);for(const chunk of chunks)chunk.fill(0);}}
export async function createProductionSupervisorRuntime(options={}){
 if(!exact(options,['environment']))fail('SUPERVISOR_FIXED_CONSTRUCTION_REQUIRED');const environment=Object.freeze({...options.environment});if(Object.hasOwn(environment,'RENDER_API_KEY'))fail('SUPERVISOR_OPERATOR_LOGIN_MUST_STAY_LOCAL');const keys=phase4AuthorityKeys(environment),releaseSha=runningReleaseSha(environment),port=Number(environment.PORT??3000);if(!Number.isSafeInteger(port)||port<0||port>65535)fail('SUPERVISOR_PORT_REQUIRED');
 let terminalStartup=null;if(environment.PHASE4_EXECUTION_PROFILE==='PHASE4')terminalStartup=await discoverProductionCurrentTerminalRuntime({environment});else assertSchemaTransitionProfile(environment);
 let router,business=null,scope=null,bootstrap=null,nativeIngress=null,original=null,qualification=null,phase='UNKNOWN',lastObservedAtMs=null,installSubmitted=false,closed=false,closing=false,closeWork=null,controlWork=null,lastControlError=null,terminalCaptured=null,startedBackground=false,reconstructionUncertain=false;
 let uninitializedRecoveryFresh=null,initializationRevoked=null,initializationRevocationReport=null;
 let abortVerification=null;const shutdownAbort=new AbortController(),ids=new Map();let processBoot=null,classify=terminalStartup?{kind:'ORIGINAL_TRANSITION',schema:35,phase:'C_BUSINESS35',operatorQualification:terminalStartup.originalOperatorQualification,window:terminalStartup.originalOperatorQualification.body.window}:await readStartup(environment,keys);if(classify.kind==='PREFENCE33'){try{processBoot=await advanceProductionSupervisorBoot({environment});}catch(error){if(error?.code!=='PRODUCTION_BOOT_TRANSITION_ALREADY_PRESENT')throw error;classify=await readStartup(environment,keys);if(classify.kind==='PREFENCE33')fail('SUPERVISOR_BOOT_ROTATION_STATE_UNCERTAIN');}}phase=classify.phase;lastObservedAtMs=Date.now();
 const capture=observation=>{const a=requireProductionEpochBootstrap(observation,keys);if(!['C_BUSINESS35','D_ABORT33'].includes(a.epoch.label))fail('SUPERVISOR_TERMINAL_ACTUAL_PHASE_REQUIRED');const captured=createSupervisorRuntimeEpochScope({epochAdmission:captureProductionSupervisorEpochAdmission({observation,keys}),keys});return {captured,label:a.epoch.label,recordValue:a.epoch.value};};
 try{if(classify.kind==='PREFENCE33'){await proveUnscoped33(environment,keys);business=await managedMain({managed:true,environment});router=createStableWebhookRouter({business});}
 else{qualification=classify.operatorQualification;original=classify.window;const now=Date.now();if(['C_BUSINESS35','D_ABORT33'].includes(phase)){const found=terminalStartup??await discoverOriginalQualification({environment});bootstrap=found.bootstrap;const a=capture(found.observation);scope=a.captured;terminalCaptured=a.recordValue;business=await managedMain({managed:true,environment,runtimeEpoch:scope});router=createStableWebhookRouter({business});}
 else{bootstrap=createProductionEpochBootstrap({environment,operatorQualification:qualification});if(now<original.acceptUntilMs&&now>=original.acceptFromMs){nativeIngress=nativeAdapter(await initializeProductionEpochIngress({environment,operatorQualification:qualification}));}else nativeIngress=expiredIntake();router=createColdStableWebhookRouter({nativeIngress,originalWindowId:original.originalWindowId});installSubmitted=true;}}
 }catch(error){if(scope)revokeSupervisorRuntimeEpochScope(scope,keys);if(business){business.closeAdmission(original?.originalWindowId??'supervisor_startup_failure_0001');await business.dispose({signal:new AbortController().signal});}bootstrap?.close();throw error;}
 const status=()=>Object.freeze({productionAuthority:'NONE',releaseSha,phase,lastObservedAtMs,businessReady:startedBackground&&!closing&&!closed&&router.status().routingMode==='BUSINESS'&&business?.status().admission==='OPEN',maintenance:router.status().routingMode!=='BUSINESS',originalWindowId:original?.originalWindowId??null,routing:router.status(),lastControlError,controlPending:Boolean(controlWork),reconstructionNeedsOperator:reconstructionUncertain,initializationRevocation:initializationRevocationReport,abortProofPending:Boolean(abortVerification?.submitted&&!abortVerification.report),normalRuntimeConfiguration:terminalStartup?.evidence??null,remoteSqlCancelled:false,externalAtomicDispatch:'PROTECTED_OPERATOR_ONLY_UNWIRED_HERE'});
 const observe=async()=>{const observation=await bootstrap.observeRestart();phase=observation.phase;lastObservedAtMs=Date.now();return observation;};
 async function prepare(command,signal){commandLive(command,signal);const parsed=authenticateProductionEpochQualification({keys,operatorQualification:command.operatorQualification}),qWindow=parsed.window;if(command.originalWindowId!==qWindow.originalWindowId||qWindow.source33RuntimeSha!==releaseSha||qWindow.targetRuntimeSha!==releaseSha)fail('SUPERVISOR_EXACT_SAME_RUNTIME_WINDOW_REQUIRED');
  if(original){if(original.originalWindowId!==qWindow.originalWindowId||qualification&&sha(JSON.stringify(qualification))!==sha(JSON.stringify(command.operatorQualification)))fail('SUPERVISOR_ORIGINAL_QUALIFICATION_CHANGED');if(terminalCaptured||router.status().routingMode==='BUSINESS')fail('SUPERVISOR_TERMINAL_CANNOT_REOPEN_MAINTENANCE');}
  if(!original){if(Date.now()<command.operatorQualification.body.qualifiedAtMs||Date.now()-command.operatorQualification.body.qualifiedAtMs>120000)fail('SUPERVISOR_FRESH_QUALIFICATION_REQUIRED');const raw=await initializeProductionEpochIngress({environment,operatorQualification:command.operatorQualification,processBoot});try{commandLive(command,signal);}catch(error){raw.close();throw error;}nativeIngress=nativeAdapter(raw);qualification=structuredClone(command.operatorQualification);original=qWindow;bootstrap=createProductionEpochBootstrap({environment,operatorQualification:qualification,processBoot});router.stageMaintenanceIngress({nativeIngress,originalWindowId:original.originalWindowId});router.closeBusinessAdmission();if(scope)revokeSupervisorRuntimeEpochScope(scope,keys);}
  if(router.status().routingMode==='CLOSING')await router.drainAndDisposeBusiness({signal});commandLive(command,signal);if(router.status().routingMode!=='DRAINED')fail('SUPERVISOR_DRAINED_BEFORE_A_REQUIRED');
  let observation;if(!installSubmitted){installSubmitted=true;observation=await bootstrap.initializeBusiness33();}else observation=await observe();phase=observation.phase;lastObservedAtMs=Date.now();return status();
 }
 async function resume(command,signal){if(abortVerification?.submitted&&!abortVerification.report)fail('SUPERVISOR_ABORT_FULL_PROOF_REQUIRED');if(initializationRevoked)return abortUninitialized(command,signal);if(!original||command.originalWindowId!==original.originalWindowId||!bootstrap)fail('SUPERVISOR_ORIGINAL_WINDOW_REQUIRED');const observation=await observe(),a=requireProductionEpochBootstrap(observation,keys);if(!['C_BUSINESS35','D_ABORT33'].includes(a.epoch.label))fail('SUPERVISOR_TERMINAL_ACTUAL_PHASE_REQUIRED');if(terminalCaptured&&terminalCaptured!==a.epoch.value)fail('SUPERVISOR_CAPTURED_TERMINAL_CHANGED');
  if(router.status().routingMode==='BUSINESS'){if(!terminalCaptured)fail('SUPERVISOR_FRESH_TERMINAL_SCOPE_REQUIRED');return status();}
  if(terminalCaptured&&router.status().routingMode==='DRAINED'){
   if(reconstructionUncertain)fail('SUPERVISOR_FACTORY_CLEANUP_UNCERTAIN');
   if(!business||business.status().admission!=='CLOSED')fail('SUPERVISOR_RETAINED_FRESH_OWNERSHIP_REQUIRED');
   await business.dispose({signal});business=null;scope=null;terminalCaptured=null;
  }
  if(!terminalCaptured){signal.throwIfAborted();const priorBusiness=business,captured=capture(observation);let fresh;
   scope=captured.captured;terminalCaptured=captured.recordValue;
   try{fresh=await managedMain({managed:true,environment,runtimeEpoch:scope});business=fresh;signal.throwIfAborted();router.stageFreshBusiness({freshBusiness:fresh});}
   catch(error){revokeSupervisorRuntimeEpochScope(scope,keys);
    if(fresh){fresh.closeAdmission(original.originalWindowId);try{await fresh.dispose({signal});business=null;scope=null;terminalCaptured=null;}catch(cleanup){throw Object.assign(new AggregateError([error,cleanup],'SUPERVISOR_FRESH_DISPOSAL_PENDING'),{code:'SUPERVISOR_FRESH_DISPOSAL_PENDING'});}}
    else if(error?.code==='BUSINESS_CONSTRUCTION_CLEANUP_FAILED')reconstructionUncertain=true;
    else{business=priorBusiness;scope=null;terminalCaptured=null;}
    throw error;
   }
  }
  try{await router.finishReopen({signal});startedBackground=true;}catch(error){if(router.status().backgroundStartSubmitted&&business?.status().admission==='OPEN'){business.closeAdmission(original.originalWindowId);revokeSupervisorRuntimeEpochScope(scope,keys);reconstructionUncertain=true;}throw error;}return status();
 }
 async function abortBeforeB(command,signal){if(!original||command.originalWindowId!==original.originalWindowId||!bootstrap||router.status().routingMode!=='DRAINED')fail('SUPERVISOR_ABORT_ORIGINAL_DRAINED_A_REQUIRED');const parsed=authenticateProductionEpochQualification({keys,operatorQualification:qualification});if(parsed.window.source33RuntimeSha!==releaseSha||parsed.window.targetRuntimeSha!==releaseSha)fail('SUPERVISOR_EXACT_SAME_RUNTIME_WINDOW_REQUIRED');
  const observed=await observe();if(observed.phase==='D_ABORT33'&&!abortVerification)return status();if(observed.phase==='D_ABORT33'&&abortVerification?.report)return Object.freeze({...status(),abort:abortVerification.report});if(!['A_BUSINESS33','D_ABORT33'].includes(observed.phase))fail('SUPERVISOR_ABORT_ONLY_ACTUAL_A33');abortVerification??={};const report=await exactAbortBeforeB(environment,keys,parsed.s,qualification,signal,abortVerification,observed.phase);const after=await observe();if(after.phase!=='D_ABORT33')fail('SUPERVISOR_ABORT_D_READBACK_REQUIRED');return Object.freeze({...status(),abort:report});
 }
 async function disposeUninitializedFresh(signal){
  const fresh=uninitializedRecoveryFresh;if(!fresh)return;
  if(fresh.status().admission==='OPEN')fresh.closeAdmission(original.originalWindowId);
  await fresh.dispose({signal});uninitializedRecoveryFresh=null;
 }
 async function finishUninitializedReopen(signal){
  try{await router.finishReopen({signal});startedBackground=true;}
  catch(error){if(router.status().backgroundStartSubmitted){if(business?.status().admission==='OPEN')business.closeAdmission(original.originalWindowId);reconstructionUncertain=true;}throw error;}
  return status();
 }
 async function abortUninitialized(command,signal){
  if(!original||!qualification||command.originalWindowId!==original.originalWindowId)fail('SUPERVISOR_ABORT_ORIGINAL_WINDOW_REQUIRED');
  if(reconstructionUncertain)fail('SUPERVISOR_FACTORY_CLEANUP_UNCERTAIN');
  if(initializationRevoked){
   initializationRevoked=await observeProductionInitializationRevocation({environment,operatorQualification:qualification});initializationRevocationReport=requireProductionInitializationRevocation(initializationRevoked,keys);phase=initializationRevocationReport.phase;lastObservedAtMs=Date.now();signal.throwIfAborted();
   if(router.status().routingMode==='BUSINESS')return status();
   if(router.status().routingMode==='RECOVERING')return finishUninitializedReopen(signal);
  }
  if(router.status().routingMode==='CLOSING')await router.drainAndDisposeBusiness({signal});
  signal.throwIfAborted();if(router.status().routingMode!=='DRAINED')fail('SUPERVISOR_ABORT_UNINITIALIZED_DRAINED_REQUIRED');
  await disposeUninitializedFresh(signal);signal.throwIfAborted();
  let fresh;
  try{
   // Fresh main owns no listener/background yet. Router keeps external business
   // admission closed and the original durable intake mounted during construction.
   fresh=await managedMain({managed:true,environment});uninitializedRecoveryFresh=fresh;signal.throwIfAborted();
   const proof=await revokeProductionUninitializedAttempt({environment,operatorQualification:qualification,processBoot});signal.throwIfAborted();
   initializationRevocationReport=requireProductionInitializationRevocation(proof,keys);initializationRevoked=proof;phase=initializationRevocationReport.phase;lastObservedAtMs=Date.now();
   bootstrap?.close();bootstrap=null;signal.throwIfAborted();
   // Rotation is durable before WHOOP switches. Its old q can never install A.
   // Existing intake work is still joined by finishReopen before producer start.
   router.stageFreshBusiness({freshBusiness:fresh});business=fresh;uninitializedRecoveryFresh=null;
  }catch(error){
   if(fresh){fresh.closeAdmission(original.originalWindowId);try{await disposeUninitializedFresh(signal);}catch(cleanup){throw Object.assign(new AggregateError([error,cleanup],'SUPERVISOR_UNINITIALIZED_FRESH_DISPOSAL_PENDING'),{code:'SUPERVISOR_UNINITIALIZED_FRESH_DISPOSAL_PENDING'});}}
   else if(error?.code==='BUSINESS_CONSTRUCTION_CLEANUP_FAILED')reconstructionUncertain=true;
   if(error?.code==='UNINITIALIZED_ABORT_TRANSITION_ALREADY_PRESENT'&&bootstrap){try{await observe();}catch{phase='UNKNOWN';lastObservedAtMs=null;}}
   throw error;
  }
  return finishUninitializedReopen(signal);
 }
 async function execute(sealed){if(closing||closed)fail('SUPERVISOR_CLOSING');const command=authenticateCommand(sealed,keys),digest=sha(JSON.stringify(command));if(ids.has(command.commandId)&&ids.get(command.commandId)!==digest)fail('SUPERVISOR_COMMAND_ID_CHANGED');if(!ids.has(command.commandId)&&ids.size>=128)fail('SUPERVISOR_COMMAND_LIMIT');ids.set(command.commandId,digest);const signal=AbortSignal.any([shutdownAbort.signal,AbortSignal.timeout(Math.max(1,command.expiresAtMs-Date.now()))]);if(controlWork){if(controlWork.digest!==digest)fail('SUPERVISOR_COMMAND_BUSY');return joinOwned(controlWork.promise,signal);}
  const entry={digest,promise:null};controlWork=entry;entry.promise=Promise.resolve().then(async()=>{try{if(command.action==='prepare')return await prepare(command,signal);if(original&&command.originalWindowId!==original.originalWindowId)fail('SUPERVISOR_ORIGINAL_WINDOW_REQUIRED');if(command.action==='resume')return await resume(command,signal);if(command.action==='abort-before-b')return await abortBeforeB(command,signal);if(command.action==='abort-uninitialized')return await abortUninitialized(command,signal);if(initializationRevoked){initializationRevoked=await observeProductionInitializationRevocation({environment,operatorQualification:qualification});initializationRevocationReport=requireProductionInitializationRevocation(initializationRevoked,keys);phase=initializationRevocationReport.phase;lastObservedAtMs=Date.now();}else if(bootstrap)await observe();return status();}catch(error){lastControlError=/^[A-Z0-9_]{1,100}$/.test(error?.code??'')?error.code:'SUPERVISOR_COMMAND_UNCONFIRMED';throw error;}finally{if(controlWork===entry)controlWork=null;}});const result=await joinOwned(entry.promise,signal);signal.throwIfAborted();if(Date.now()>=command.expiresAtMs)fail('SUPERVISOR_OWNER_COMMAND_EXPIRED');return result;
 }
 const handler=async(req,res)=>{const path=typeof req.url==='string'?req.url.split('?')[0]:null;
  if(path==='/health'&&req.url==='/health'&&['GET','HEAD'].includes(req.method)){const current=status(),body={ok:!closed,liveness:'SUPERVISOR',businessReady:current.businessReady,maintenance:current.maintenance,lastObservedPhase:phase,lastObservedAtMs,productionAuthority:'NONE',runtimeHeapLimitBytes:req.method==='GET'?runtimeHeapLimitBytes():null};if(req.method==='HEAD'){res.writeHead(closed?503:200,{'content-type':'application/json','cache-control':'no-store'});return res.end();}return reject(res,closed?503:200,body);}
  if(path===CONTROL_PATH){if(req.url!==CONTROL_PATH||req.method!=='POST')return reject(res,405);let ownerAuthenticated=false;
   try{const wire=await commandBody(req,Date.now()+10000);authenticateCommand(wire,keys);ownerAuthenticated=true;const result=await execute(wire);return reject(res,200,{ok:true,state:result});}
   catch(error){if(!ownerAuthenticated||['SUPERVISOR_OWNER_AUTHENTICATION_REQUIRED','SUPERVISOR_OWNER_COMMAND_EXPIRED'].includes(error?.code))return reject(res,401,{ok:false,code:'SUPERVISOR_OWNER_AUTHENTICATION_REQUIRED'});return reject(res,503,{ok:false,code:'SUPERVISOR_COMMAND_UNCONFIRMED',state:status()});}}
  if(closing||closed||router.status().routingMode==='BUSINESS'&&!startedBackground)return reject(res);return router.handler(req,res);
 };
 const server=http.createServer((req,res)=>{void handler(req,res).catch(()=>{reject(res);res.destroy?.();});});server.requestTimeout=15000;server.headersTimeout=10000;server.keepAliveTimeout=5000;
 async function close(){if(closeWork)return closeWork;closing=true;shutdownAbort.abort(Object.assign(Error('SUPERVISOR_SHUTDOWN_ADMISSION_CLOSED'),{code:'SUPERVISOR_SHUTDOWN_ADMISSION_CLOSED'}));closeWork=(async()=>{const signal=AbortSignal.timeout(30000);if(controlWork)await joinOwned(controlWork.promise,signal).catch(error=>{if(signal.aborted)throw error;});nativeIngress?.closeAdmission(original?.originalWindowId);if(business&&business.status().admission==='OPEN')business.closeAdmission(original?.originalWindowId??'supervisor_shutdown_0001');if(scope)revokeSupervisorRuntimeEpochScope(scope,keys);if(business){await business.waitForDrained({signal});await business.dispose({signal});}await disposeUninitializedFresh(signal);if(nativeIngress){await nativeIngress.waitForDrained({signal});await nativeIngress.dispose({signal});}bootstrap?.close();await joinOwned(new Promise((resolve,reject)=>server.listening?server.close(error=>error?reject(error):resolve()):resolve()),signal);closed=true;process.removeListener('SIGTERM',onSignal);process.removeListener('SIGINT',onSignal);return status();})().catch(error=>{closeWork=null;throw error;});return closeWork;}
 const onSignal=()=>{void close().catch(()=>{});};
 try{await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'0.0.0.0',()=>{server.removeListener('error',reject);resolve();});});if(business){await business.startBackground();startedBackground=true;}process.on('SIGTERM',onSignal);process.on('SIGINT',onSignal);}
 catch(error){await close();throw error;}
 return Object.freeze({server,handler,status,close,productionAuthority:'NONE'});
}
