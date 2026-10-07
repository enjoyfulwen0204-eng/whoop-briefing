/** Sanitized v32 execution authority and derived heartbeat projections.
 * Generic heartbeat writers still discard free text. Accept only fixed enums,
 * nonnegative counts, timestamps and authenticated opaque transport hashes;
 * it cannot store tenant IDs, health data, names or arbitrary narrative. */
import { randomUUID } from 'node:crypto';
import {databaseNowMs,CommitIndeterminateError} from './phase4ExecutionContext.js';
import { BRIEFING_TRIGGER, bodySha256 } from './briefingTriggerAuth.js';
import { requireTriggerSource } from './phase4DrainPolicy.js';
import { requireReleaseSha, runningReleaseSha } from './phase4Release.js';
import { syncAuthorizesDrain } from './syncResult.js';
export const PHASES=Object.freeze(['SYNC','STAGE6_DRAIN']);
export const HANDOFF_TTL_MS=15*60_000;
const OUTCOMES=new Set(['PENDING','COMPLETE','PARTIAL','FAILED','TIMEOUT','CANCELLED','NO_WORK','NO_ELIGIBLE_WORK',
 'COMPLETE_SUCCESS','NO_NEW_DATA_SUCCESS','INTENTIONALLY_INAPPLICABLE','REQUIRED_RESOURCE_FAILED','AUTH_FAILED','DISABLED','POLICY_DEFERRED','BUDGET_EXHAUSTED','COMMIT_INDETERMINATE']);
const COUNTS=['durationMs','jobsConsidered','itemsAttempted','itemsProcessed','jobsCompleted','jobsFailed','remainingJobs','users','failed'];
const HASH=/^[a-f0-9]{64}$/;
const fail=code=>{const e=new Error(code);e.code=code;throw e;};
export function requirePhase(phase) {if(!PHASES.includes(phase))fail('EXECUTION_PHASE_INVALID');return phase;}
export function validatePhaseRequest(request) {
 requirePhase(request?.phase);requireTriggerSource(request.triggerSource);requireReleaseSha(request.releaseSha);
 if(!BRIEFING_TRIGGER.REQUEST_ID_RE.test(request.requestId)||!['OFF','SHADOW'].includes(request.executionMode)
   ||!HASH.test(request.configProof))fail('EXECUTION_REQUEST_INVALID');
 const allowed=['phase','releaseSha','triggerSource','requestId','executionMode','configProof','syncRequestId','handoff','legacyBodyDigest'];
 if(request.legacyBodyDigest!==undefined&&!HASH.test(request.legacyBodyDigest))fail('EXECUTION_REQUEST_INVALID');
 if(Object.keys(request).some(k=>!allowed.includes(k)))fail('EXECUTION_REQUEST_INVALID');
 if(request.phase==='SYNC'&&(request.syncRequestId!==undefined||request.handoff!==undefined))fail('EXECUTION_REQUEST_INVALID');
 if(request.phase==='STAGE6_DRAIN'&&(!BRIEFING_TRIGGER.REQUEST_ID_RE.test(request.syncRequestId)||!HASH.test(request.handoff)
   ||request.requestId===request.syncRequestId))fail('SYNC_HANDOFF_REQUIRED');
 return request;
}
export const configurationProof=(keys,config,environment,releaseSha=runningReleaseSha(environment))=>keys.lookup(['phase4-configuration-v2',requireReleaseSha(releaseSha),config.runtime,config.mode,
 (environment.PHASE4_PUBLIC_BETA_USER_IDS??'').split(',').filter(Boolean).map(x=>x.trim()).sort()]);
export const requestIdentity=body=>bodySha256(body);
function safeRecord(record) {
 const out={version:2,releaseSha:requireReleaseSha(record.releaseSha),phase:requirePhase(record.phase),source:requireTriggerSource(record.source),outcome:record.outcome};
 if(!OUTCOMES.has(out.outcome))fail('EXECUTION_OUTCOME_INVALID');
 for(const key of COUNTS)if(record[key]!==undefined&&record[key]!==null) {
   if(!Number.isFinite(record[key])||record[key]<0||(key!=='durationMs'&&!Number.isSafeInteger(record[key])))fail('EXECUTION_COUNT_INVALID');out[key]=record[key];
 }
 for(const key of ['identity','configProof','handoff'])if(record[key]!==undefined) {
   if(!HASH.test(record[key]))fail('EXECUTION_PROOF_INVALID');out[key]=record[key];
 }
 if(record.completion!==undefined){if(!['PARTIAL','COMPLETE'].includes(record.completion))fail('EXECUTION_COMPLETION_INVALID');out.completion=record.completion;}
 if(record.stopReason!==undefined){if(!['FAILURE','WALL_OR_ITEM_LIMIT','QUEUE_COMPLETE','ITEM_LIMIT','TENANT_LIMIT','NO_ELIGIBLE_WORK','POLICY_DEFERRED','DISABLED'].includes(record.stopReason))fail('EXECUTION_STOP_REASON_INVALID');out.stopReason=record.stopReason;}
 if(record.executionMode!==undefined){if(!['OFF','SHADOW'].includes(record.executionMode))fail('EXECUTION_MODE_INVALID');out.executionMode=record.executionMode;}
 if(record.finishedAt!==undefined){if(!Number.isSafeInteger(record.finishedAt))fail('EXECUTION_TIME_INVALID');out.finishedAt=record.finishedAt;}
 return out;
}
async function read(db,name) {
 const row=(await db.raw.execute({sql:'SELECT last_detail,last_ok_at,updated_at FROM system_heartbeats WHERE scope=? AND component=?',args:['global',name]})).rows[0];
 if(!row)return null;
 try{return {...safeRecord(JSON.parse(row.last_detail)),startedAt:Date.parse(row.last_ok_at),updatedAt:Date.parse(row.updated_at)};}catch{fail('EXECUTION_RECORD_CORRUPT');}
}
async function write(db,name,record,{startedAt=Date.now(),finishedAt=Date.now()}={}) {
 const data=safeRecord(record);
 await db.raw.execute({sql:`INSERT INTO system_heartbeats(scope,component,last_ok_at,last_detail,updated_at) VALUES (?,?,?,?,?)
  ON CONFLICT(scope,component) DO UPDATE SET last_ok_at=excluded.last_ok_at,last_detail=excluded.last_detail,updated_at=excluded.updated_at`,
  args:['global',name,new Date(startedAt).toISOString(),JSON.stringify(data),new Date(finishedAt).toISOString()]});
}
export async function recordPhaseEvent(db,{phase,source,event,...record}) {
 if(!['start','discovery_start','discovery_complete','drain_start','complete'].includes(event))fail('EXECUTION_EVENT_INVALID');
 return write(db,`phase4_${phase.toLowerCase()}:${source}:${event}`,{phase,source,...record});
}
export async function readPhaseProgress(db,phase,source) {
 const version=Number((await db.raw.execute('SELECT MAX(version) v FROM schema_version')).rows[0]?.v);
 if(version<32)return {state:'LEGACY_UNKNOWN',complete:null,starts:null};
 if(version!==32)fail('phase4_schema_version_mismatch');
 const rows=await db.raw.execute({sql:'SELECT * FROM phase4_executions WHERE phase=? AND trigger_source=? ORDER BY created_at DESC,updated_at DESC LIMIT 1',args:[phase,source]});
 const execution=rows.rows[0];
 if(execution){
  const result=decodeExecution(execution);
  const receipts=Number((await db.raw.execute({sql:'SELECT count(*) n FROM phase4_execution_work_receipts WHERE execution_id=?',args:[execution.execution_id]})).rows[0].n);
  const expired=!finalized(execution)&&execution.deadline_at<=Date.now();
  const state=finalized(execution)?result.outcome:execution.state==='WORK_COMMITTED'?'WORK_COMMITTED_UNFINALIZED':execution.state==='ABORTED'?execution.abort_outcome??'FAILED':
    execution.observed_outcome==='COMMIT_INDETERMINATE'?'COMMIT_INDETERMINATE':receipts?'DURABLE_PROGRESS_UNFINALIZED':expired?'TIMEOUT':'IN_PROGRESS';
  return {state,expired,settlementState:execution.state,complete:finalized(execution)?{...result,updatedAt:execution.finalized_at}:null,
    durableWork:result,workReceipts:receipts,execution,starts:{identity:execution.identity_digest,updatedAt:execution.created_at}};
 }
 const starts=await read(db,`phase4_${phase.toLowerCase()}:${source}:start`);
 const complete=await read(db,`phase4_${phase.toLowerCase()}:${source}:complete`);
 const discovery=await read(db,`phase4_${phase.toLowerCase()}:${source}:discovery_complete`);
 const drain=await read(db,`phase4_${phase.toLowerCase()}:${source}:drain_start`);
 if(complete)return {state:'LEGACY_UNKNOWN',complete:null,starts,legacyProjection:complete};
 return {state:!starts?'NOT_ENTERED':discovery&&discovery.identity===starts.identity&&discovery.updatedAt>=starts.updatedAt?'DISCOVERY_ONLY':
   drain&&drain.identity===starts.identity?'IN_PROGRESS':'STARTED',complete:null,starts};
}
const finalized=row=>['FINALIZED_SUCCESS','FINALIZED_FAILURE'].includes(row.state);
const decodeExecution=row=>{
 if(!row?.result_json)return null;
 if(bodySha256(row.result_json)!==row.result_digest)fail('EXECUTION_RESULT_CORRUPT');
 const result=safeRecord(JSON.parse(row.result_json));
 if(result.identity!==row.identity_digest||result.releaseSha!==row.release_sha||result.phase!==row.phase
  ||result.source!==row.trigger_source||result.executionMode!==row.execution_mode||result.configProof!==row.config_proof)fail('EXECUTION_RESULT_CORRUPT');
 return result;
};
export async function readExecution(db,id){return (await db.raw.execute({sql:'SELECT * FROM phase4_executions WHERE execution_id=?',args:[id]})).rows[0]??null;}
function requestMatches(row,request,identity){
 if(row.identity_digest!==identity||row.phase!==request.phase||row.release_sha!==request.releaseSha
  ||row.trigger_source!==request.triggerSource||row.execution_mode!==request.executionMode||row.config_proof!==request.configProof
  ||row.sync_execution_id!==(request.syncRequestId??null))fail('REQUEST_ID_CONFLICT');
}
function completionRecord(row,keys){
 if(!finalized(row))fail('EXECUTION_NOT_FINALIZED');
 const record={...decodeExecution(row),settlementState:row.state,finalizedAt:row.finalized_at};
 if(row.state==='FINALIZED_SUCCESS'&&record.phase==='SYNC'&&syncAuthorizesDrain(record))
  record.handoff=keys.lookup(['phase4-sync-handoff-v3',row.execution_id,row.identity_digest,row.release_sha,row.trigger_source,
    row.execution_mode,row.config_proof,row.result_digest,row.finalized_at]);
 return record;
}
export async function claimPhaseRequest(db,request,body,{leaseMs=225_000,deadlineAt=Date.now()+leaseMs,keys}={}) {
 validatePhaseRequest(request);
 let parsed;try{parsed=validatePhaseRequest(JSON.parse(body));}catch{fail('EXECUTION_BODY_MISMATCH');}
 if(Object.keys(request).length!==Object.keys(parsed).length||Object.keys(request).some(key=>request[key]!==parsed[key]))fail('EXECUTION_BODY_MISMATCH');
 const identity=requestIdentity(body),owner=randomUUID(),at=Date.now(),leaseUntil=Math.max(deadlineAt,at+leaseMs);
 const scopeKey=bodySha256(JSON.stringify(['phase4-execution-scope-v1',request.phase,request.executionMode,request.configProof]));
 return db.transaction(async()=>{
  const previous=await readExecution(db,request.requestId);
  if(previous){
   requestMatches(previous,request,identity);
   if(finalized(previous))return {cached:keys?completionRecord(previous,keys):decodeExecution(previous),row:previous};
   if(previous.lease_until>at&&previous.state!=='WORK_COMMITTED')fail('REQUEST_PENDING');
   const changed=await db.raw.execute({sql:`UPDATE phase4_executions SET owner=?,generation=generation+1,lease_until=?,deadline_at=?,updated_at=?,
     state=CASE WHEN state='ABORTED' THEN 'ESTABLISHED' ELSE state END,abort_outcome=NULL,observed_outcome='IN_PROGRESS' WHERE execution_id=? AND generation=? AND (lease_until<=${databaseNowMs} OR state='WORK_COMMITTED')`,
     args:[owner,leaseUntil,deadlineAt,at,request.requestId,previous.generation]});
   if(changed.rowsAffected!==1)fail('REQUEST_PENDING');
  }else await db.raw.execute({sql:`INSERT INTO phase4_executions(execution_id,identity_digest,scope_key,phase,release_sha,execution_mode,trigger_source,
   config_proof,sync_execution_id,owner,generation,lease_until,deadline_at,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,1,?,?,'ESTABLISHED',?,?)`,
   args:[request.requestId,identity,scopeKey,request.phase,request.releaseSha,request.executionMode,request.triggerSource,request.configProof,
    request.syncRequestId??null,owner,leaseUntil,deadlineAt,at,at]});
  const row=await readExecution(db,request.requestId);
  return {executionId:request.requestId,name:`phase4:request:${request.requestId}`,owner,generation:row.generation,scopeKey,
   expiresAt:new Date(row.lease_until).toISOString(),identity,startedAt:row.created_at,workCommitted:row.state==='WORK_COMMITTED',result:decodeExecution(row)};
 });
}
const successOutcome=record=>record.phase==='SYNC'?syncAuthorizesDrain(record):
 ['COMPLETE','PARTIAL','NO_WORK','NO_ELIGIBLE_WORK','BUDGET_EXHAUSTED','DISABLED','POLICY_DEFERRED'].includes(record.outcome);
async function ownerCheck(db,claim){
 const row=await readExecution(db,claim.executionId);
 if(!row||row.owner!==claim.owner||row.generation!==claim.generation||row.lease_until<=Date.now()||row.deadline_at<=Date.now())fail('REQUEST_OWNER_FENCED');
 return row;
}
export async function commitPhaseWork(db,request,claim,result,authority){
 if(db.processingTransactionActive?.())fail('EXECUTION_SETTLEMENT_MUST_BE_ROOT');
 if(result.handoff!==undefined||result.settlementState!==undefined||result.finalizedAt!==undefined)fail('EXECUTION_RESULT_AUTHORITY_INVALID');
 authority.assert();
 return db.transaction(async()=>{
  const row=await ownerCheck(db,claim);authority.assert();
  if(row.state==='WORK_COMMITTED')return decodeExecution(row);
  const record=safeRecord({...result,phase:request.phase,releaseSha:request.releaseSha,source:request.triggerSource,identity:claim.identity,
    configProof:request.configProof,executionMode:request.executionMode,finishedAt:Date.now()});
  const json=JSON.stringify(record),at=Date.now();
  const updated=await db.raw.execute({sql:`UPDATE phase4_executions SET state='WORK_COMMITTED',result_json=?,result_digest=?,work_committed_at=?,updated_at=?
   WHERE execution_id=? AND owner=? AND generation=? AND state='ESTABLISHED' AND lease_until>${databaseNowMs} AND deadline_at>${databaseNowMs}`,
   args:[json,bodySha256(json),at,at,claim.executionId,claim.owner,claim.generation]});
  if(updated.rowsAffected!==1)fail('REQUEST_OWNER_FENCED');return record;
 },{commitAuthority:authority.assert});
}
export async function finalizePhaseWork(db,request,claim,keys,authority){
 if(db.processingTransactionActive?.())fail('EXECUTION_SETTLEMENT_MUST_BE_ROOT');
 authority.assert();const existing=await ownerCheck(db,claim);authority.assert();
 requestMatches(existing,request,claim.identity);const result=decodeExecution(existing);
 if(existing.state!=='WORK_COMMITTED')fail('EXECUTION_NOT_COMMITTED');
 await db.transaction(async()=>{
  authority.assert();
  const changed=await db.raw.execute({sql:`UPDATE phase4_executions SET state=?,finalized_at=${databaseNowMs},updated_at=${databaseNowMs}
   WHERE execution_id=? AND owner=? AND generation=? AND result_digest=? AND release_sha=? AND state='WORK_COMMITTED'
    AND lease_until>${databaseNowMs} AND deadline_at>${databaseNowMs}`,
   args:[successOutcome(result)?'FINALIZED_SUCCESS':'FINALIZED_FAILURE',claim.executionId,claim.owner,claim.generation,existing.result_digest,request.releaseSha]});
  if(changed.rowsAffected!==1)fail('REQUEST_OWNER_FENCED');
 },{commitAuthority:authority.assert});
 // A transport acknowledgement is never final success authority. Read durable
 // state while this caller still has authority. Cancellation here is indeterminate.
 authority.assert();const row=await readExecution(db,claim.executionId);authority.assert();
 requestMatches(row,request,claim.identity);if(!finalized(row))throw new CommitIndeterminateError();
 return completionRecord(row,keys);
}
export async function projectPhaseCompletion(db,request,record){
 // Best effort projection only. Readers below consult the v32 authority first.
 const latest=await read(db,`phase4_${request.phase.toLowerCase()}:${request.triggerSource}:start`);
 const {handoff,...projection}=record;
 if(latest?.identity===record.identity)await write(db,`phase4_${request.phase.toLowerCase()}:${request.triggerSource}:complete`,projection,
   {startedAt:record.finalizedAt,finishedAt:record.finalizedAt});
}
export async function settlePhaseRequest(db,request,claim,result,keys,authority){
 if(claim.cached)fail('EXECUTION_CLAIM_REQUIRED');if(typeof authority?.assert!=='function')fail('EXECUTION_AUTHORITY_REQUIRED');
 if(!claim.workCommitted)await commitPhaseWork(db,request,claim,result,authority);
 authority.assert();const record=await finalizePhaseWork(db,request,claim,keys,authority);
 authority.assert();try{await projectPhaseCompletion(db,request,record);}catch{/* authoritative row remains recoverable */}
 authority.assert();return record;
}
export async function abortPhaseExecution(db,claim,outcome='FAILED'){
 // Cleanup releases only this generation. It cannot erase committed work or
 // change a finalized row. Never pretend an uncertain COMMIT was rolled back.
 await db.raw.execute({sql:`UPDATE phase4_executions SET lease_until=${databaseNowMs}-1,deadline_at=${databaseNowMs}-1,updated_at=${databaseNowMs},
  state=CASE WHEN state='ESTABLISHED' THEN 'ABORTED' ELSE state END,abort_outcome=? WHERE execution_id=? AND owner=? AND generation=? AND finalized_at IS NULL`,
  args:[outcome,claim.executionId,claim.owner,claim.generation]});
}
export async function noteIndeterminateExecution(db,claim){
 await db.raw.execute({sql:`UPDATE phase4_executions SET observed_outcome='COMMIT_INDETERMINATE',updated_at=${databaseNowMs}
   WHERE execution_id=? AND owner=? AND generation=? AND finalized_at IS NULL`,args:[claim.executionId,claim.owner,claim.generation]});
}
export async function requireSyncHandoff(db,request,keys){
 const row=await readExecution(db,request.syncRequestId);
 if(!row||row.phase!=='SYNC'||row.state!=='FINALIZED_SUCCESS'||row.release_sha!==request.releaseSha
  ||row.release_sha!==runningReleaseSha()||row.trigger_source!==request.triggerSource||row.execution_mode!==request.executionMode
  ||row.config_proof!==request.configProof||Date.now()-row.finalized_at>HANDOFF_TTL_MS||row.finalized_at>Date.now())fail('SYNC_HANDOFF_REJECTED');
 const prior=completionRecord(row,keys);if(!syncAuthorizesDrain(prior)||prior.handoff!==request.handoff)fail('SYNC_HANDOFF_REJECTED');return prior;
}
