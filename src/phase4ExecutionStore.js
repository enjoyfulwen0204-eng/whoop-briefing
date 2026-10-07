/** Closed operational metadata in v31 heartbeat storage. Generic heartbeat
 * writers still discard free text. This writer accepts only fixed enums,
 * nonnegative counts, timestamps and authenticated opaque transport hashes;
 * it cannot store tenant IDs, health data, names or arbitrary narrative. */
import { randomUUID } from 'node:crypto';
import { BRIEFING_TRIGGER, bodySha256 } from './briefingTriggerAuth.js';
import { requireTriggerSource } from './phase4DrainPolicy.js';
import { requireReleaseSha, runningReleaseSha } from './phase4Release.js';
import { syncAuthorizesDrain } from './syncResult.js';
export const PHASES=Object.freeze(['SYNC','STAGE6_DRAIN']);
export const HANDOFF_TTL_MS=15*60_000;
const OUTCOMES=new Set(['PENDING','COMPLETE','PARTIAL','FAILED','TIMEOUT','CANCELLED','NO_WORK','NO_ELIGIBLE_WORK',
 'COMPLETE_SUCCESS','NO_NEW_DATA_SUCCESS','INTENTIONALLY_INAPPLICABLE','REQUIRED_RESOURCE_FAILED','AUTH_FAILED','DISABLED','POLICY_DEFERRED','BUDGET_EXHAUSTED']);
const COUNTS=['durationMs','jobsConsidered','itemsAttempted','itemsProcessed','jobsCompleted','jobsFailed','remainingJobs','users','failed'];
const HASH=/^[a-f0-9]{64}$/;
const fail=code=>{const e=new Error(code);e.code=code;throw e;};
export function requirePhase(phase) {if(!PHASES.includes(phase))fail('EXECUTION_PHASE_INVALID');return phase;}
export function validatePhaseRequest(request) {
 requirePhase(request?.phase);requireTriggerSource(request.triggerSource);requireReleaseSha(request.releaseSha);
 if(!BRIEFING_TRIGGER.REQUEST_ID_RE.test(request.requestId)||!['OFF','SHADOW'].includes(request.executionMode)
   ||!HASH.test(request.configProof))fail('EXECUTION_REQUEST_INVALID');
 const allowed=['phase','releaseSha','triggerSource','requestId','executionMode','configProof','syncRequestId','handoff'];
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
const component=id=>`phase4_request:${id}`;
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
 const starts=await read(db,`phase4_${phase.toLowerCase()}:${source}:start`);
 const complete=await read(db,`phase4_${phase.toLowerCase()}:${source}:complete`);
 const discovery=await read(db,`phase4_${phase.toLowerCase()}:${source}:discovery_complete`);
 const drain=await read(db,`phase4_${phase.toLowerCase()}:${source}:drain_start`);
 return {state:!starts?'NOT_ENTERED':(!complete||complete.identity!==starts.identity||complete.updatedAt<starts.updatedAt)?
   (!drain||drain.identity!==starts.identity||drain.updatedAt<starts.updatedAt)?discovery&&discovery.identity===starts.identity&&discovery.updatedAt>=starts.updatedAt?'DISCOVERY_ONLY':'STARTED':'IN_PROGRESS'
   :complete.outcome,complete,starts};
}
export async function claimPhaseRequest(db,request,body,{leaseMs=225_000}={}) {
 validatePhaseRequest(request);
 let parsed;try{parsed=validatePhaseRequest(JSON.parse(body));}catch{fail('EXECUTION_BODY_MISMATCH');}
 if(Object.keys(request).length!==Object.keys(parsed).length||Object.keys(request).some(key=>request[key]!==parsed[key]))fail('EXECUTION_BODY_MISMATCH');
 const identity=requestIdentity(body),name=`phase4:request:${request.requestId}`,owner=randomUUID();
 const at=Date.now(),expiresAt=new Date(at+leaseMs).toISOString();
 return db.transaction(async()=>{
   let previous=await read(db,component(request.requestId));
   if(previous&&(previous.identity!==identity||previous.phase!==request.phase||previous.source!==request.triggerSource
     ||previous.releaseSha!==request.releaseSha||previous.configProof!==request.configProof||previous.executionMode!==request.executionMode))fail('REQUEST_ID_CONFLICT');
   if(previous&&previous.outcome!=='PENDING')return {cached:previous};
   const changed=await db.raw.execute({sql:`INSERT INTO resource_locks(name,owner,acquired_at,expires_at) VALUES(?,?,?,?)
    ON CONFLICT(name) DO UPDATE SET owner=excluded.owner,acquired_at=excluded.acquired_at,expires_at=excluded.expires_at
    WHERE resource_locks.expires_at<=excluded.acquired_at`,args:[name,owner,new Date(at).toISOString(),expiresAt]});
   if(changed.rowsAffected!==1)fail('REQUEST_PENDING');
   await write(db,component(request.requestId),{phase:request.phase,releaseSha:request.releaseSha,source:request.triggerSource,outcome:'PENDING',identity,
     configProof:request.configProof,executionMode:request.executionMode},{startedAt:at});
   return {name,owner,expiresAt,identity,startedAt:at};
 });
}
export async function settlePhaseRequest(db,request,claim,result,keys,authority) {
 if(claim.cached)fail('EXECUTION_CLAIM_REQUIRED');
 if(typeof authority?.assert!=='function')fail('EXECUTION_AUTHORITY_REQUIRED');
 let ownedUntil;
 const assertOwnerTime=()=>{authority.assert();if(!Number.isFinite(ownedUntil)||Date.now()>=ownedUntil)fail('REQUEST_OWNER_FENCED');};
 authority.assert();
 return db.transaction(async()=>{
   const lease=(await db.raw.execute({sql:'SELECT expires_at FROM resource_locks WHERE name=? AND owner=? AND expires_at>?',
     args:[claim.name,claim.owner,new Date().toISOString()]})).rows[0];
   ownedUntil=Date.parse(lease?.expires_at);assertOwnerTime();
   authority.assert();
   const finishedAt=Date.now(),record={phase:request.phase,releaseSha:request.releaseSha,source:request.triggerSource,identity:claim.identity,
     configProof:request.configProof,executionMode:request.executionMode,finishedAt,...result};
   if(request.phase==='SYNC'&&syncAuthorizesDrain(record))record.handoff=keys.lookup(['phase4-sync-handoff-v2',request.releaseSha,request.requestId,
     claim.identity,request.executionMode,request.triggerSource,request.configProof,finishedAt]);
   authority.assert();
   await write(db,component(request.requestId),record,{startedAt:claim.startedAt,finishedAt});
   authority.assert();
   const latest=await read(db,`phase4_${request.phase.toLowerCase()}:${request.triggerSource}:start`);
   authority.assert();
   if(latest?.identity===claim.identity)await recordPhaseEvent(db,{...record,event:'complete'});
   assertOwnerTime();
   const released=await db.raw.execute({sql:'DELETE FROM resource_locks WHERE name=? AND owner=? AND expires_at>?',args:[claim.name,claim.owner,new Date().toISOString()]});
   if(released.rowsAffected!==1)fail('REQUEST_OWNER_FENCED');
   assertOwnerTime();
   return safeRecord(record);
 },{commitAuthority:assertOwnerTime});
}
export async function requireSyncHandoff(db,request,keys) {
 const prior=await read(db,component(request.syncRequestId));
 if(!prior||prior.phase!=='SYNC'||!syncAuthorizesDrain(prior)||prior.releaseSha!==request.releaseSha||prior.releaseSha!==runningReleaseSha()||prior.source!==request.triggerSource
   ||prior.executionMode!==request.executionMode||prior.configProof!==request.configProof||prior.handoff!==request.handoff
   ||Date.now()-prior.finishedAt>HANDOFF_TTL_MS||prior.finishedAt>Date.now()
   ||keys.lookup(['phase4-sync-handoff-v2',prior.releaseSha,request.syncRequestId,prior.identity,prior.executionMode,prior.source,prior.configProof,prior.finishedAt])!==request.handoff)
   fail('SYNC_HANDOFF_REJECTED');
 return prior;
}
