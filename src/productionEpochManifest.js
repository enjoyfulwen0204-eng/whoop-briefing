/** Permanent production epoch manifest compiler. Exact DML trigger logic copied
 * from frozen R2 7bedebb6; no old ca4 plan, authority or permit is relabelled.
 * This pure compiler does not grant observation, ownership or Production GO.
 */
import {createHash} from 'node:crypto';
import {requirePhase4Keys} from './phase4Keys.js';
import {PROFILE_REVISION_PREFIX} from './profileRevision.js';
const fail=code=>{throw Object.assign(Error(code),{code});},sha=x=>createHash('sha256').update(x).digest('hex'),json=JSON.stringify;
const literal=x=>"'"+String(x).replaceAll("'","''")+"'",ident=x=>{if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(x))fail('PRODUCTION_EPOCH_IDENTIFIER_REQUIRED');return '"'+x+'"';};
const freeze=x=>{if(x&&typeof x==='object'){Object.values(x).forEach(freeze);Object.freeze(x);}return x;};
export const PRODUCTION_SUPERVISOR_BOOT_KEY=PROFILE_REVISION_PREFIX+'supervisor:boot-generation:v1';
export const PRODUCTION_EPOCH_QUALIFICATION_KEY=PROFILE_REVISION_PREFIX+'operator:production-transition-r3-original-qualification';
export const PRODUCTION_EPOCH_PREFIX=PROFILE_REVISION_PREFIX+'operator:production-transition-r3-epoch:v1:';
const TYPES=['sleep.updated','sleep.deleted','recovery.updated','recovery.deleted','workout.updated','workout.deleted'];
const DEFAULTS={provider:'whoop',user_id:null,state:'RECEIVED',attempt_count:0,owner:null,lease_expires_at:null,next_attempt_at:null,last_error_class:null,last_error_detail:null,processed_at:null,content_state:'LEGACY_UNLINKED',health_content_redacted_at:null,health_content_redaction_reason:null,source_subject_deleted_at:null,purge_generation:0,source_linkage_state:'LEGACY_UNLINKED',content_digest_salt:null,privacy_artifact_id:null};
function metadataPredicate(binding){
 const trace='NEW.trace_id',resource='NEW.resource_id',whitespace='9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279';
 return `NEW.whoop_user_id IN (${binding.tenants.map(t=>literal(String(t.whoopUserId))).join(',')}) AND NEW.event_type IN (${TYPES.map(literal).join(',')}) AND NEW.resource_type=substr(NEW.event_type,1,instr(NEW.event_type,'.')-1) AND typeof(${resource})='text' AND length(${resource})=36 AND length(CAST(${resource} AS BLOB))=36 AND substr(${resource},9,1)='-' AND substr(${resource},14,1)='-' AND substr(${resource},19,1)='-' AND substr(${resource},24,1)='-' AND length(replace(${resource},'-',''))=32 AND replace(${resource},'-','') NOT GLOB '*[^0-9a-fA-F]*' AND typeof(${trace})='text' AND length(${trace}) BETWEEN 1 AND 128 AND instr(${trace},char(0))=0 AND unicode(substr(${trace},1,1)) NOT IN (${whitespace}) AND unicode(substr(${trace},-1,1)) NOT IN (${whitespace}) AND (WITH RECURSIVE chars(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM chars WHERE n<length(${trace})) SELECT sum(CASE WHEN unicode(substr(${trace},n,1))>65535 THEN 2 ELSE 1 END)<=128 AND max(CASE WHEN unicode(substr(${trace},n,1)) BETWEEN 0 AND 31 OR unicode(substr(${trace},n,1))=127 THEN 1 ELSE 0 END)=0 FROM chars) AND ${Object.entries(DEFAULTS).map(([k,v])=>`NEW.${ident(k)} IS ${v===null?'NULL':typeof v==='number'?v:literal(v)}`).join(' AND ')} AND NEW.received_at=NEW.created_at AND NEW.received_at=NEW.updated_at AND typeof(NEW.received_at)='text' AND strftime('%Y-%m-%dT%H:%M:%fZ',julianday(NEW.received_at))=NEW.received_at AND NEW.received_at>=${literal(new Date(binding.acceptFromMs).toISOString())} AND NEW.received_at<${literal(new Date(binding.acceptUntilMs).toISOString())} AND typeof(NEW.event_at)='text' AND length(NEW.event_at)=13 AND length(CAST(NEW.event_at AS BLOB))=13 AND NEW.event_at NOT GLOB '*[^0-9]*' AND abs(CAST(NEW.event_at AS INTEGER)-(CAST(strftime('%s',NEW.received_at) AS INTEGER)*1000+CAST(substr(NEW.received_at,21,3) AS INTEGER)))<=300000`;
}
const rowIs=(alias,row)=>`${alias}.key=${literal(row.key)} AND ${alias}.value=${literal(row.value)} AND ${alias}.updated_at=${literal(row.updated_at)}`;
const rowExists=row=>`EXISTS(SELECT 1 FROM telegram_state r WHERE ${rowIs('r',row)})`;
function record(keys,attempt,windowId,label,mode,schema,key){
 const epochToken=keys.lookup(['production-transition-r3-fixed-epoch-v1',attempt,windowId,label]);
 const body={contract:'production-transition-r3-epoch-registry-v1',originalAttempt:attempt,originalWindowId:windowId,label,mode,schema,epochToken,boundAt:attempt.startedAt},signature=keys.digest(keys.lookup(['production-transition-r3-epoch-registry-sign-v1']),body);
 // New contract only: full original signed body remains in the authenticated
 // plan. SQL matches its fixed keyed digest rather than repeating that JSON.
 const value=keys.lookup(['production-transition-r3-record-value-v1',body,signature]);
 return freeze({label,mode,schema,epochToken,key,value,updated_at:new Date(attempt.startedAt).toISOString(),body,signature});
}
function currentThree(binding){
 return binding.tenants.map(t=>`EXISTS(SELECT 1 FROM users u JOIN user_whoop_tokens t ON t.user_id=u.id JOIN phase4_user_state p ON p.user_id=u.id WHERE u.id=${literal(t.userId)} AND t.whoop_user_id=${literal(t.whoopUserId)} AND u.status='ACTIVE' AND u.lifecycle_generation=${t.lifecycleGeneration} AND t.auth_generation=${t.authGeneration} AND p.source_generation=${t.sourceGeneration} AND p.purge_generation=${t.purgeGeneration} AND p.pending_purge_count=0)`).join(' AND ');
}
function compile(s,tables){
 const {records,registryKey,permitKey,namespace}=s,business=records.filter(r=>r.mode==='BUSINESS'),active=r=>`(${rowExists(r)} AND (SELECT MAX(version) FROM schema_version)=${r.schema})`;
 const ingressPhase=records.map(r=>r.label==='B_INGRESS_ONLY'?`(${rowExists(r)} AND (SELECT MAX(version) FROM schema_version) IN (33,35))`:active(r)).join(' OR '),databaseNow="CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)",ingress=`((${ingressPhase}) AND ${currentThree(s.bridge)} AND ${databaseNow}>=${s.bridge.acceptFromMs} AND ${databaseNow}<${s.bridge.acceptUntilMs})`,transport=s.qualificationTransport,transportKey=alias=>`${alias}.key=${literal(transport.key)}`,bootKey=alias=>`${alias}.key=${literal(s.bootRow.key)}`;
 const durableBoot=`EXISTS(SELECT 1 FROM telegram_state q WHERE q.key=${literal(s.bootRow.key)} AND q.updated_at=${literal(s.bootRow.updated_at)} AND length(CAST(q.value AS BLOB))=${new TextEncoder().encode(s.bootRow.value).length} AND json_valid(q.value) AND json_extract(q.value,'$.digest')=${literal(s.bootRow.digest)})`;
 const durableTransport=`${durableBoot} AND EXISTS(SELECT 1 FROM telegram_state q WHERE q.key=${literal(transport.key)} AND q.updated_at=${literal(transport.updated_at)} AND length(CAST(q.value AS BLOB))=${new TextEncoder().encode(transport.value).length} AND json_valid(q.value) AND json_extract(q.value,'$.digest')=${literal(transport.digest)})`;
 const permit=r=>({key:permitKey,value:r.epochToken,updated_at:r.updated_at}),allowed=business.map(r=>`(${durableTransport} AND ${active(r)} AND ${rowExists(permit(r))})`).join(' OR '),isOperator=alias=>`substr(${alias}.key,1,${namespace.length})=${literal(namespace)}`;
 const newPermit=business.map(r=>`(${active(r)} AND ${rowIs('NEW',permit(r))})`).join(' OR ');
 const newInitial=`(${durableTransport} AND ${rowIs('NEW',records[0])} AND NOT EXISTS(SELECT 1 FROM telegram_state WHERE key=${literal(registryKey)}))`;
 const graph=[[records[0],records[1]],[records[1],records[2]],[records[1],records[3]]];
 const transition=graph.map(([a,b])=>`(${rowIs('OLD',a)} AND ${rowIs('NEW',b)} AND (SELECT MAX(version) FROM schema_version)=${b.mode==='INGRESS_ONLY'?33:b.schema})`).join(' OR ');
 const oldPermit=business.map(r=>`(${active(r)} AND ${rowIs('OLD',permit(r))})`).join(' OR '),statements=[];
 for(const table of tables)for(const operation of ['INSERT','UPDATE','DELETE']){
  let deny=`NOT (${allowed})`;
  if(table==='telegram_state'){
   if(operation==='INSERT')deny=`(${isOperator('NEW')} AND NOT (${newInitial} OR ${newPermit})) OR (NOT (${isOperator('NEW')}) AND NOT (${allowed}))`;
   if(operation==='UPDATE')deny=`((${isOperator('OLD')} OR ${isOperator('NEW')}) AND NOT (${transition})) OR (NOT (${isOperator('OLD')} OR ${isOperator('NEW')}) AND NOT (${allowed}))`;
   if(operation==='DELETE')deny=`(${isOperator('OLD')} AND NOT (${oldPermit})) OR (NOT (${isOperator('OLD')}) AND NOT (${allowed}))`;
   if(operation==='INSERT')deny=`(${transportKey('NEW')} OR ${bootKey('NEW')}) OR (${deny})`;
   if(operation==='UPDATE')deny=`(${transportKey('OLD')} OR ${transportKey('NEW')} OR ${bootKey('OLD')} OR ${bootKey('NEW')}) OR (${deny})`;
   if(operation==='DELETE')deny=`(${transportKey('OLD')} OR ${bootKey('OLD')}) OR (${deny})`;
  }else if(table==='whoop_webhook_events'&&operation==='INSERT')deny=`NOT (${allowed}) AND NOT (${durableTransport} AND ${ingress} AND coalesce((${metadataPredicate(s.bridge)}),0))`;
  const name=s.triggerPrefix+sha(table+':'+operation).slice(0,20);
  if(table==='whoop_webhook_events'&&operation==='INSERT'){
   // Prevent OR REPLACE from deleting an old row even when recursive_triggers
   // is off. A genuine duplicate retains the canonical store's existing unique
   // conflict/dedup path; no frozen helper or sequence allocation is changed.
   const duplicate=`NOT (${allowed}) AND (${ingress}) AND EXISTS(SELECT 1 FROM whoop_webhook_events e WHERE e.id=NEW.id OR (e.whoop_user_id=NEW.whoop_user_id AND e.event_type=NEW.event_type AND e.resource_id=NEW.resource_id AND e.trace_id=NEW.trace_id))`;
   statements.push(freeze({sql:`CREATE TRIGGER ${ident(name)} BEFORE INSERT ON ${ident(table)} BEGIN SELECT CASE WHEN (${deny}) THEN RAISE(ABORT,'STAGE8_TRANSITION_WRITER_FENCED') END; SELECT CASE WHEN (${duplicate}) THEN RAISE(ABORT,'UNIQUE constraint failed: whoop_webhook_events.transition_append_identity') END; END`,args:[]}));
  }else statements.push(freeze({sql:`CREATE TRIGGER ${ident(name)} BEFORE ${operation} ON ${ident(table)} WHEN (${deny}) BEGIN SELECT RAISE(ABORT,'STAGE8_TRANSITION_WRITER_FENCED'); END`,args:[]}));
 }
 return freeze(statements);
}

export function compileProductionEpochManifest({keys,window,sourceTables,targetTables,qualificationTransport,bootRow}){
 requirePhase4Keys(keys);
 if(!bootRow||bootRow.key!==PRODUCTION_SUPERVISOR_BOOT_KEY||typeof bootRow.value!=='string'||new TextEncoder().encode(bootRow.value).length>2048||!/^[a-f0-9]{64}$/.test(bootRow.digest))fail('PRODUCTION_EPOCH_EXACT_BOOT_ROW_REQUIRED');
 if(!qualificationTransport||qualificationTransport.key!==PRODUCTION_EPOCH_QUALIFICATION_KEY||typeof qualificationTransport.value!=='string'||qualificationTransport.value.length>65536||!Number.isSafeInteger(Date.parse(qualificationTransport.updated_at))||!/^[a-f0-9]{64}$/.test(qualificationTransport.digest))fail('PRODUCTION_EPOCH_QUALIFICATION_TRANSPORT_REQUIRED');
 for(const tables of [sourceTables,targetTables])if(!Array.isArray(tables)||tables.length<4||tables.length>500||new Set(tables).size!==tables.length||tables.some(t=>!/^[A-Za-z_][A-Za-z0-9_]*$/.test(t)))fail('PRODUCTION_EPOCH_EXACT_TABLE_MANIFEST_REQUIRED');
 const attempt={contract:'production-transition-r3-original-attempt-v1',approvalId:window.approvalId,originalWindowId:window.originalWindowId,attemptNonce:window.attemptNonce,startIdentity:window.startIdentity,startedAt:window.originalWindowStartMs,deadlineAt:window.originalWindowEndMs,source33RuntimeSha:window.source33RuntimeSha,targetRuntimeSha:window.targetRuntimeSha,historicalCa4BaselineSha:window.historicalCa4BaselineSha,bootDigest:bootRow.digest,cohortDigest:keys.lookup(['production-transition-r3-original-cohort-v1',window.tenants])};
 const namespace=PRODUCTION_EPOCH_PREFIX+keys.lookup(['production-transition-r3-namespace-v1',attempt])+':',registryKey=namespace+'registry',permitKey=namespace+'permit';
 const records=[record(keys,attempt,window.originalWindowId,'A_BUSINESS33','BUSINESS',33,registryKey),record(keys,attempt,window.originalWindowId,'B_INGRESS_ONLY','INGRESS_ONLY',33,registryKey),record(keys,attempt,window.originalWindowId,'C_BUSINESS35','BUSINESS',35,registryKey),record(keys,attempt,window.originalWindowId,'D_ABORT33','BUSINESS',33,registryKey)];
 const s={keys,bootRow:{...bootRow},qualificationTransport:{...qualificationTransport},attempt,originalWindowId:window.originalWindowId,namespace,registryKey,permitKey,records,bridge:window,triggerPrefix:'production_transition_'+keys.lookup(['production-transition-r3-trigger-prefix-v1',attempt]).slice(0,16)+'_',sourceTables:[...sourceTables],targetTables:[...targetTables]};
 s.sourceTriggers=compile(s,sourceTables);s.targetTriggers=compile(s,targetTables);return freeze(s);
}
export function productionEpochManifestStatements(s,kind){
 if(kind==='create33')return s.sourceTriggers;if(kind==='create35')return s.targetTriggers;
 if(kind==='install33')return freeze([{sql:'INSERT INTO telegram_state(key,value,updated_at) VALUES(?,?,?)',args:[s.qualificationTransport.key,s.qualificationTransport.value,s.qualificationTransport.updated_at]},...s.sourceTriggers,{sql:'INSERT INTO telegram_state(key,value,updated_at) VALUES(?,?,?)',args:[s.records[0].key,s.records[0].value,s.records[0].updated_at]}]);
 fail('PRODUCTION_EPOCH_FIXED_MANIFEST_KIND_REQUIRED');
}
