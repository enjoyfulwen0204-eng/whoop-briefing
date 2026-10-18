/** Temporary WHOOP metadata intake on the existing Render/Turso service.
 * It runs before the business runtime during an authorized bounded migration.
 * Original signatures and canonical deduplication remain authoritative; only a
 * positive durable row receipt permits200. All business routes return503.
 * The signed original-window binding and migration append authority are separate.
 */
import {createHash,timingSafeEqual} from 'node:crypto';
import {Readable} from 'node:stream';
import {createClient} from '@libsql/client';
import {createWhoopWebhookIngest,statusForIngest} from './whoopWebhookIngest.js';
import {verifyWhoopWebhook} from './whoopWebhookAuth.js';
import {parseWhoopEvent} from './whoopWebhookEvent.js';
import {createWhoopWebhookStore} from './whoopWebhookStore.js';
import {SCHEMA,ADDITIVE_COLUMNS,PHASE4_MIGRATIONS} from './schema.js';
import {requirePhase4Keys} from './phase4Keys.js';

export const WHOOP_BRIDGE_ORIGIN='https://whoop-telegram-webhook.onrender.com';
export const WHOOP_BRIDGE_SOURCE_SHA='ca4bff7b711737527ca6c4e306d4a3ef555c9f3b';
export const WHOOP_BRIDGE_DATABASE_URL='libsql://whoop-briefing-enjoyfulwen0204-eng.aws-ap-northeast-1.turso.io';
export const WHOOP_BRIDGE_PATH='/whoop/webhook';
export const WHOOP_BRIDGE_MAX_BYTES=16*1024;
export const WHOOP_BRIDGE_MAX_ACTIVE_MS=60*60_000;
const TABLE='whoop_webhook_events',CONTRACT='stage8-existing-render-whoop-ingress-v1';
const fail=code=>{throw Object.assign(Error(code),{code});};
const exact=(value,keys)=>value&&Object.getPrototypeOf(value)===Object.prototype&&Reflect.ownKeys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const positive=value=>Number.isSafeInteger(value)&&value>0;
const validTimeout=value=>Number.isSafeInteger(value)&&value>=1&&value<=15_000;
const normalize=sql=>String(sql).split(/('(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`)/g)
 .map((part,i)=>i%2?part:part.replace(/\bIF NOT EXISTS\s+/gi,'').replace(/\s+/g,' ')).join('').trim().replace(/;$/,'');
function uncomment(sql){
 let result='',quote=null;
 for(let i=0;i<sql.length;i++){
  const c=sql[i];
  if(quote){result+=c;if(c===quote){if(sql[i+1]===quote)result+=sql[++i];else quote=null;}continue;}
  if(['\'', '"','`'].includes(c)){quote=c;result+=c;continue;}
  if(c==='-'&&sql[i+1]==='-'){while(i<sql.length&&sql[i]!=='\n')i++;result+=' ';continue;}
  if(c==='/'&&sql[i+1]==='*'){i+=2;while(i<sql.length&&!(sql[i]==='*'&&sql[i+1]==='/'))i++;i++;result+=' ';continue;}
  result+=c;
 }
 return result;
}
function tableParts(sql){
 sql=uncomment(sql);const opening=sql.indexOf('('),closing=sql.lastIndexOf(')');
 if(opening<0||closing<opening)fail('WHOOP_BRIDGE_METADATA_INVALID');
 const body=sql.slice(opening+1,closing),parts=[];let start=0,depth=0,quote=null;
 for(let i=0;i<body.length;i++){
  const c=body[i];if(quote){if(c===quote){if(body[i+1]===quote)i++;else quote=null;}continue;}
  if(['\'', '"','`'].includes(c)){quote=c;continue;}if(c==='(')depth++;if(c===')')depth--;
  if(c===','&&depth===0){parts.push(normalize(body.slice(start,i)));start=i+1;}
 }
 parts.push(normalize(body.slice(start)));return {prefix:normalize(sql.slice(0,opening)),suffix:normalize(sql.slice(closing+1)),parts:parts.sort()};
}
function compileCommonInbox(){
 const base=SCHEMA.find(sql=>/^CREATE TABLE IF NOT EXISTS whoop_webhook_events\b/.test(sql));
 if(!base)fail('WHOOP_BRIDGE_FROZEN_CONTRACT_MISSING');
 const parts=tableParts(base),columns=[...ADDITIVE_COLUMNS.map(item=>({table:item.table,column:item.column,definition:item.ddl.split(`ADD COLUMN ${item.column} `)[1]})),
  ...PHASE4_MIGRATIONS.filter(item=>item.version<=33).flatMap(item=>item.columns??[])].filter(item=>item.table===TABLE);
 for(const column of columns)if(!parts.parts.some(part=>part.startsWith(column.column+' ')))parts.parts.push(normalize(column.column+' '+column.definition));
 parts.parts.sort();
 const indexes=new Map();
 for(const sql of [...SCHEMA,...PHASE4_MIGRATIONS.filter(item=>item.version<=33).flatMap(item=>[...item.ddl,...(item.indexes??[]),...(item.triggers??[])])]){
  const match=/^CREATE (?:UNIQUE )?INDEX IF NOT EXISTS (\w+)\s+ON whoop_webhook_events\b/.exec(sql);
  if(match)indexes.set(match[1],normalize(uncomment(sql)));
  if(/^CREATE TRIGGER\b/.test(sql)&&/\bwhoop_webhook_events\b/i.test(sql))fail('WHOOP_BRIDGE_FROZEN_TRIGGER_REVIEW_REQUIRED');
 }
 if(indexes.size!==6)fail('WHOOP_BRIDGE_FROZEN_INDEX_CONTRACT_CHANGED');
 const versions=SCHEMA.find(sql=>/^CREATE TABLE IF NOT EXISTS schema_version\b/.test(sql));
 return {table:parts,indexes,versions:tableParts(versions)};
}
const common=compileCommonInbox();
const metadataSql="SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name IN ('schema_version','sqlite_sequence') OR tbl_name='whoop_webhook_events' OR (type='trigger' AND instr(lower(sql),'whoop_webhook_events')>0) ORDER BY type,name";
const versionsSql='SELECT version,note FROM schema_version ORDER BY version';
const constraintsSql='SELECT ignore_check_constraints FROM pragma_ignore_check_constraints()';
const continuitySql="SELECT step_key,last_cursor,postcondition_state FROM phase4_migration_checkpoints WHERE target_version=22 AND step_key IN ('lookup_key_check','audit_key_check') ORDER BY step_key";
const rosterSql=`SELECT u.id user_id,u.status,u.lifecycle_generation,t.whoop_user_id,t.auth_generation,p.source_generation,p.purge_generation,p.pending_purge_count
 FROM user_whoop_tokens t JOIN users u ON u.id=t.user_id JOIN phase4_user_state p ON p.user_id=u.id
 WHERE t.whoop_user_id IN (?,?,?) ORDER BY t.whoop_user_id`;
function sameTable(actual,expected){const got=tableParts(actual);return got.prefix===expected.prefix&&got.suffix===expected.suffix&&JSON.stringify(got.parts)===JSON.stringify(expected.parts);}
/** Read-only, inbox-only metadata admission. This deliberately issues NO full
 * runtime capability, does NOT inspect tenants/health/history, and never repairs
 * schema. Both versions use the same frozen inbox DDL, indexes and defaults. */
export async function admitWhoopBridgeCommonInbox(client){
 if(typeof client?.execute!=='function')fail('WHOOP_BRIDGE_DATABASE_REQUIRED');
 const metadata=(await client.execute(metadataSql)).rows;
 const objects=new Map(metadata.map(row=>[row.name,row]));
 if(objects.size!==metadata.length)fail('WHOOP_BRIDGE_METADATA_INVALID');
 const table=objects.get(TABLE),versionTable=objects.get('schema_version'),sequence=objects.get('sqlite_sequence');
 if(table?.type!=='table'||!sameTable(table.sql,common.table)||versionTable?.type!=='table'||!sameTable(versionTable.sql,common.versions)
  ||sequence?.type!=='table'||normalize(sequence.sql)!=='CREATE TABLE sqlite_sequence(name,seq)')fail('WHOOP_BRIDGE_COMMON_TABLE_MISMATCH');
 const allowed=new Set([TABLE,'schema_version','sqlite_sequence',...common.indexes.keys()]);
 for(const row of metadata)if(!allowed.has(row.name))fail('WHOOP_BRIDGE_UNEXPECTED_INBOX_OBJECT');
 for(const [name,sql] of common.indexes)if(objects.get(name)?.type!=='index'||normalize(uncomment(objects.get(name).sql))!==sql)fail('WHOOP_BRIDGE_COMMON_INDEX_MISMATCH');
 const versions=(await client.execute(versionsSql)).rows;
 if(versions.some(row=>!positive(row.version)))fail('WHOOP_BRIDGE_SCHEMA_AUTHORITY_INVALID');
 const version=Math.max(0,...versions.map(row=>row.version));
 if(![33,35].includes(version))fail('WHOOP_BRIDGE_COMMITTED_SCHEMA_REQUIRED');
 for(let v=21;v<=version;v++)if(versions.filter(row=>row.version===v&&row.note===`phase4 v${v} postconditions verified`).length!==1)fail('WHOOP_BRIDGE_SCHEMA_AUTHORITY_INVALID');
 const constraints=(await client.execute(constraintsSql)).rows;
 if(constraints.length!==1||constraints[0].ignore_check_constraints!==0)fail('WHOOP_BRIDGE_CONSTRAINTS_REQUIRED');
 return Object.freeze({contract:'whoop-common-inbox-admission-v1',schema:version,metadataDigest:createHash('sha256').update(JSON.stringify(metadata)).digest('hex')});
}
function canonicalTenant(value){
 if(typeof value==='number'){if(!positive(value))fail('WHOOP_BRIDGE_TENANT_INVALID');return String(value);}
 if(typeof value!=='string'||!(/^[1-9]\d{0,19}$/).test(value))fail('WHOOP_BRIDGE_TENANT_INVALID');return value;
}
const bindingFields=['contract','approvalId','sourceSha','candidateSha','originalWindowId','originalWindowStartMs','originalWindowEndMs','origin','acceptFromMs','acceptUntilMs','resourceApiVersion','tenants'];
function unsignedBinding(value){
 if(!exact(value,bindingFields)||value.contract!==CONTRACT
  ||typeof value.approvalId!=='string'||!/^owner-[A-Za-z0-9_.-]{1,90}$/.test(value.approvalId)||value.sourceSha!==WHOOP_BRIDGE_SOURCE_SHA||value.origin!==WHOOP_BRIDGE_ORIGIN
  ||typeof value.candidateSha!=='string'||!(/^[a-f0-9]{40}$/).test(value.candidateSha)||typeof value.originalWindowId!=='string'||!(/^[A-Za-z0-9_.:-]{1,128}$/).test(value.originalWindowId)||value.resourceApiVersion!=='v2'
  ||!Number.isSafeInteger(value.originalWindowStartMs)||!Number.isSafeInteger(value.originalWindowEndMs)||value.originalWindowStartMs<0||value.originalWindowEndMs<=value.originalWindowStartMs||value.originalWindowEndMs-value.originalWindowStartMs>WHOOP_BRIDGE_MAX_ACTIVE_MS
  ||!Number.isSafeInteger(value.acceptFromMs)||!Number.isSafeInteger(value.acceptUntilMs)||value.acceptFromMs<0||value.acceptUntilMs<=value.acceptFromMs||value.acceptUntilMs-value.acceptFromMs>WHOOP_BRIDGE_MAX_ACTIVE_MS
  ||value.acceptFromMs<value.originalWindowStartMs||value.acceptUntilMs>value.originalWindowEndMs
  ||!Array.isArray(value.tenants)||Reflect.ownKeys(value.tenants).length!==4||value.tenants.length!==3)fail('WHOOP_BRIDGE_SOURCE_BINDING_REQUIRED');
 const tenants=value.tenants.map(tenant=>{
  const fields=['userId','whoopUserId','lifecycleGeneration','authGeneration','sourceGeneration','purgeGeneration'];
  if(!exact(tenant,fields)||typeof tenant.userId!=='string'||tenant.userId!==tenant.userId.trim()||!tenant.userId||tenant.userId.length>128||/[\x00-\x1f\x7f]/.test(tenant.userId)
   ||!positive(tenant.lifecycleGeneration)||!positive(tenant.authGeneration)||![tenant.sourceGeneration,tenant.purgeGeneration].every(n=>Number.isSafeInteger(n)&&n>=0))fail('WHOOP_BRIDGE_SOURCE_BINDING_REQUIRED');
  return Object.fromEntries(fields.map(field=>[field,field==='whoopUserId'?canonicalTenant(tenant[field]):tenant[field]]));
 });
 if(new Set(tenants.map(tenant=>tenant.userId)).size!==3||new Set(tenants.map(tenant=>tenant.whoopUserId)).size!==3)fail('WHOOP_BRIDGE_SOURCE_BINDING_REQUIRED');
 return {...Object.fromEntries(bindingFields.map(field=>[field,value[field]])),tenants};
}
/** Trusted original-window operator only. A seal authenticates its supplied
 * scope; it does not invent owner/user permission or provider-state proof. */
export function sealWhoopRenderIngressBinding({keys,binding}){
 requirePhase4Keys(keys);const body=unsignedBinding(structuredClone(binding));
 return Object.freeze({...body,seal:keys.lookup(['whoop-render-ingress-original-window-binding-v1',body])});
}
function bindingOf(value,keys){
 requirePhase4Keys(keys);if(!exact(value,[...bindingFields,'seal'])||typeof value.seal!=='string'||!(/^[a-f0-9]{64}$/).test(value.seal))fail('WHOOP_BRIDGE_SIGNED_SOURCE_BINDING_REQUIRED');
 const {seal,...raw}=value,body=unsignedBinding(raw),expected=keys.lookup(['whoop-render-ingress-original-window-binding-v1',body]);
 if(!timingSafeEqual(Buffer.from(seal,'hex'),Buffer.from(expected,'hex')))fail('WHOOP_BRIDGE_SIGNED_SOURCE_BINDING_REQUIRED');return body;
}
function activeBinding({approvedBinding,keys,clientSecret,releaseSha,now}){
 const binding=bindingOf(approvedBinding,keys),at=now();
 if(typeof clientSecret!=='string'||!clientSecret||releaseSha!==binding.candidateSha||!Number.isSafeInteger(at)||at<binding.acceptFromMs||at>=binding.acceptUntilMs)fail('WHOOP_BRIDGE_STARTUP_BINDING_REQUIRED');
 return binding;
}
/** Exposed for source/local qualification. Production uses the owned-client
 * initializer below, so databaseUrl is never a label on an arbitrary client. */
export async function validateWhoopRenderIngressStartup({client,databaseUrl,keys,clientSecret,approvedBinding,releaseSha,now=Date.now,operationTimeoutMs=10_000}={}){
 if(Number(process.versions.node.split('.')[0])!==22||![WHOOP_BRIDGE_DATABASE_URL,WHOOP_BRIDGE_DATABASE_URL+'/'].includes(databaseUrl)||!validTimeout(operationTimeoutMs))fail('WHOOP_BRIDGE_FIXED_RUNTIME_TARGET_REQUIRED');
 const binding=activeBinding({approvedBinding,keys,clientSecret,releaseSha,now}),admission=await admitWhoopBridgeCommonInbox(client);
 const checkpoints=(await client.execute(continuitySql)).rows;
 if(checkpoints.length!==2||checkpoints.some(row=>row.postcondition_state!=='COMPLETE'||!(row.step_key==='lookup_key_check'?keys.verifyLookupCheckpoint(row.last_cursor):row.step_key==='audit_key_check'&&keys.verifyAuditCheckpoint(row.last_cursor))))fail('WHOOP_BRIDGE_KEY_CONTINUITY_REQUIRED');
 const roster=(await client.execute({sql:rosterSql,args:binding.tenants.map(tenant=>tenant.whoopUserId)})).rows;
 if(roster.length!==3)fail('WHOOP_BRIDGE_CURRENT_ROSTER_REQUIRED');
 for(const tenant of binding.tenants){
  const matches=roster.filter(row=>row.user_id===tenant.userId&&row.whoop_user_id===tenant.whoopUserId),row=matches[0];
  if(matches.length!==1||row.status!=='ACTIVE'||row.pending_purge_count!==0||row.lifecycle_generation!==tenant.lifecycleGeneration||row.auth_generation!==tenant.authGeneration||row.source_generation!==tenant.sourceGeneration||row.purge_generation!==tenant.purgeGeneration)fail('WHOOP_BRIDGE_CURRENT_ROSTER_REQUIRED');
 }
 activeBinding({approvedBinding,keys,clientSecret,releaseSha,now});
 return Object.freeze({...admission,rosterVerified:true,originalWindowBound:true});
}
// Preserve literal top-level lexemes, rejecting duplicate/escaped keys and
// numeric aliases that JSON.parse would silently round into an approved ID.
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
const insertSql=normalize(`INSERT INTO whoop_webhook_events
 (provider, whoop_user_id, event_type, resource_type, resource_id, trace_id,
 event_at, received_at, state, attempt_count, created_at, updated_at)
 VALUES ('whoop', ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`);
const duplicateSql=normalize(`SELECT id FROM whoop_webhook_events WHERE whoop_user_id = ? AND event_type = ? AND resource_id = ? AND trace_id = ?`);
const rowSql='SELECT * FROM whoop_webhook_events WHERE id = ?';
const response=(status,body={ok:status===200})=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json','cache-control':'no-store'}});
async function boundedBody(request,check,signal){
 const reader=request.body?.getReader();if(!reader)return Buffer.alloc(0);const chunks=[];let size=0;
 const cancel=()=>{try{void reader.cancel().catch(()=>{});}catch{}};signal.addEventListener('abort',cancel,{once:true});
 try{for(;;){check();const next=await reader.read();check();if(next.done)break;size+=next.value.length;if(size>WHOOP_BRIDGE_MAX_BYTES)fail('WHOOP_BRIDGE_BODY_TOO_LARGE');chunks.push(Buffer.from(next.value));}return Buffer.concat(chunks);}
 finally{signal.removeEventListener('abort',cancel);cancel();try{reader.releaseLock();}catch{}}
}
/** No I/O at construction. approvedBinding must be root-reviewed source, never
 * request input, an environment-created roster or a claim of provider approval.
 * This returns an HTTP boundary only; no business callback is accepted. */
export function createWhoopRenderIngressBridge({client=null,databaseUrl=WHOOP_BRIDGE_DATABASE_URL,keys=null,clientSecret=null,approvedBinding=null,releaseSha=null,mode='off',now=Date.now,operationTimeoutMs=10_000}={}){
 const binding=approvedBinding?structuredClone(approvedBinding):null;
 let startupReady=false;
 const initialize=async()=>{
  startupReady=false;if(mode!=='ingress-only')fail('WHOOP_BRIDGE_MODE_REQUIRED');
  const result=await validateWhoopRenderIngressStartup({client,databaseUrl,keys,clientSecret,approvedBinding:binding,releaseSha,now,operationTimeoutMs});startupReady=true;return result;
 };
 const handler=async request=>{
  let url;try{url=new URL(request.url);}catch{return response(400);}
  if(url.origin!==WHOOP_BRIDGE_ORIGIN)return response(400);
  if(url.pathname==='/health'&&!url.search&&request.method==='GET'){
   let active=false;try{active=mode==='ingress-only'&&startupReady&&Boolean(activeBinding({approvedBinding:binding,keys,clientSecret,releaseSha,now}));}catch{}
   return response(active?200:503,{ok:active,mode:active?'WHOOP_INGRESS_ONLY':'UNAVAILABLE',businessAvailable:false});
  }
  // All Telegram/business paths deny BEFORE body parsing/auth callbacks/SQL.
  if(url.pathname!==WHOOP_BRIDGE_PATH)return response(503);
  if(url.search||url.hash)return response(400);if(request.method!=='POST')return response(405);
  if(mode!=='ingress-only'||!binding||typeof clientSecret!=='string'||!clientSecret||typeof client?.execute!=='function'
   ||!validTimeout(operationTimeoutMs))return response(503);
  let pin;try{pin=activeBinding({approvedBinding:binding,keys,clientSecret,releaseSha,now});}catch{return response(503);}
  let stopped=false,timer,raw;const controller=new AbortController();
  const started=now(),realDeadline=Date.now()+operationTimeoutMs;
  const check=()=>{const at=now();if(stopped||Date.now()>=realDeadline||!Number.isSafeInteger(at)||at<started||at<pin.acceptFromMs||at>=pin.acceptUntilMs)fail('WHOOP_BRIDGE_WINDOW_OR_DEADLINE');};
  const work=async()=>{
   try{
    check();raw=await boundedBody(request,check,controller.signal);check();
    const headers=Object.fromEntries(request.headers),auth=verifyWhoopWebhook({headers,rawBody:raw,clientSecret,now:started});
    if(auth.ok!==true)return response(401);
    const metadata=approvedMetadata(raw);if(!metadata)return response(400);
    if(!pin.tenants.some(tenant=>tenant.whoopUserId===metadata.tenant))return response(403);
    // Metadata admission cannot progress to a write after the request expired.
    const readOnly={execute:async statement=>{check();const sql=typeof statement==='string'?statement:statement.sql;if(![metadataSql,versionsSql,constraintsSql,continuitySql,rosterSql].includes(sql))fail('WHOOP_BRIDGE_METADATA_READ_REQUIRED');const result=await client.execute(statement);check();return result;}};
    try{await validateWhoopRenderIngressStartup({client:readOnly,databaseUrl,keys,clientSecret,approvedBinding:binding,releaseSha,now:()=>started,operationTimeoutMs});startupReady=true;}catch(error){startupReady=false;throw error;}check();
    const limited={execute:async statement=>{
     check();const sql=typeof statement==='string'?statement:statement.sql;
     if(![insertSql,duplicateSql,normalize(rowSql)].includes(normalize(sql)))fail('WHOOP_BRIDGE_CANONICAL_SQL_REQUIRED');
     const result=await client.execute(statement);check();return result;
    }};
    const store=createWhoopWebhookStore(limited);
    const onlyRecord=Object.freeze({recordWhoopEvent:async args=>{
     check();if(String(args.whoopUserId)!==metadata.tenant||args.eventType!==metadata.event.eventType||args.resourceType!==metadata.event.resourceType
      ||String(args.resourceId)!==metadata.event.resourceId||String(args.traceId)!==metadata.event.traceId)fail('WHOOP_BRIDGE_CANONICAL_IDENTITY_REQUIRED');
     const receipt=await store.recordWhoopEvent(args);check();
     if(!positive(receipt?.id)||typeof receipt.inserted!=='boolean'||typeof receipt.duplicate!=='boolean'||receipt.inserted===receipt.duplicate)fail('WHOOP_BRIDGE_COMMIT_RECEIPT_REQUIRED');
     const rows=(await limited.execute({sql:rowSql,args:[receipt.id]})).rows,row=rows[0];
     if(rows.length!==1||row.provider!=='whoop'||row.whoop_user_id!==String(args.whoopUserId)||row.event_type!==args.eventType||row.resource_type!==args.resourceType||row.resource_id!==String(args.resourceId)||row.trace_id!==String(args.traceId))fail('WHOOP_BRIDGE_DURABLE_ROW_REQUIRED');
     if(receipt.inserted&&(row.state!=='RECEIVED'||row.attempt_count!==0||['user_id','owner','lease_expires_at','next_attempt_at','last_error_class','last_error_detail','processed_at','health_content_redacted_at','health_content_redaction_reason','source_subject_deleted_at','content_digest_salt','privacy_artifact_id'].some(field=>row[field]!==null)
      ||row.content_state!=='LEGACY_UNLINKED'||row.source_linkage_state!=='LEGACY_UNLINKED'||row.purge_generation!==0||row.event_at!==String(auth.timestampMs)||row.received_at!==new Date(started).toISOString()||row.created_at!==row.received_at||row.updated_at!==row.received_at))fail('WHOOP_BRIDGE_NEW_ROW_DEFAULTS_REQUIRED');
     return receipt;
    }});
    const ingest=createWhoopWebhookIngest({db:onlyRecord,clientSecret,now:()=>new Date(started)});
    const result=await ingest({headers,rawBody:raw});check();
    if(!['recorded','duplicate'].includes(result?.outcome))return response(statusForIngest(result?.outcome));
    return response(200,{ok:true,outcome:result.outcome});
   }catch(error){return response(error?.code==='WHOOP_BRIDGE_BODY_TOO_LARGE'?413:503);}
   finally{raw?.fill(0);}
  };
  try{return await Promise.race([work(),new Promise(resolve=>{timer=setTimeout(()=>{stopped=true;controller.abort();resolve(response(503));},operationTimeoutMs);})]);}
  finally{stopped=true;clearTimeout(timer);controller.abort();}
 };
 const nodeHandler=async(req,res)=>{
  try{
   const method=req.method??'GET',request=new Request(WHOOP_BRIDGE_ORIGIN+(req.url??'/'),{method,headers:req.headers,
    ...(!['GET','HEAD'].includes(method)?{body:Readable.toWeb(req),duplex:'half'}:{})});
   const result=await handler(request);res.writeHead(result.status,Object.fromEntries(result.headers));res.end(Buffer.from(await result.arrayBuffer()));
  }catch{if(!res.headersSent)res.writeHead(503,{'content-type':'application/json','cache-control':'no-store'});res.end('{"ok":false}');}
 };
 return Object.freeze({handle:handler,nodeHandler,initialize});
}

/** Production integration seam: explicit values only, no environment loading or
 * provider control. Own the ONE existing fixed-host raw libSQL client and admit
 * it before returning a handler that may be passed to http.listen. Root's
 * dynamic dispatcher calls this before importing the full business webhook.
 * A timed-out dispatched SQL operation can still commit; its canonical inbox
 * delta remains durable and must remain inside migration/recovery accounting. */
export async function initializeWhoopRenderIngressBridge({databaseUrl,authToken,keys,clientSecret,approvedBinding,releaseSha,mode='off',now=Date.now,operationTimeoutMs=10_000}={}){
 if(Number(process.versions.node.split('.')[0])!==22||![WHOOP_BRIDGE_DATABASE_URL,WHOOP_BRIDGE_DATABASE_URL+'/'].includes(databaseUrl)||typeof authToken!=='string'||!authToken||mode!=='ingress-only'||!validTimeout(operationTimeoutMs))fail('WHOOP_BRIDGE_FIXED_RUNTIME_TARGET_REQUIRED');
 activeBinding({approvedBinding,keys,clientSecret,releaseSha,now});
 const client=createClient({url:databaseUrl,authToken,fetch:(input,init)=>globalThis.fetch(input,{...init,signal:AbortSignal.any([AbortSignal.timeout(operationTimeoutMs),...[input?.signal,init?.signal].filter(Boolean)])})});
 try{const runtime=createWhoopRenderIngressBridge({client,databaseUrl,keys,clientSecret,approvedBinding,releaseSha,mode,now,operationTimeoutMs});const admission=await runtime.initialize();return Object.freeze({...runtime,admission,close:()=>client.close()});}
 catch(error){client.close();throw error;}
}
