// LOCAL synthetic controller journal only. Never creates a computation grant.
// Existing system_heartbeats CAS rows; original permit ledger is never written.
import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {canonicalPhaseRequest} from '../src/phase4ExecutionStore.js';
import {bodySha256} from '../src/briefingTriggerAuth.js';
import {decodeState} from './stage6SyntheticState.mjs';
import {canRetryUnadmittedStartup,observeUnadmittedStartup} from './stage6SyntheticStartupRecovery.mjs';
const fail=code=>{throw Object.assign(Error(code),{code});};
export const syntheticDispatchJobsSql='SELECT user_id,job_kind,state,requested_generation,scope_revision,completed_generation,full_scan_cursor,lease_owner,last_error_code,attempt FROM phase4_jobs WHERE user_id=? ORDER BY user_id,job_kind';
export function createSyntheticDispatchJournal({db,keys,origin,databaseId,manifestDigest,codeSha,tenantIds,endpoint='http://127.0.0.1:8082/drain'}){
 if(!Array.isArray(tenantIds)||tenantIds.length!==3||new Set(tenantIds).size!==3||tenantIds.some(x=>!/^s6syn-(alpha|bravo|charlie)$/.test(x)))fail('SYNTHETIC_DISPATCH_COHORT_REQUIRED');
 if(!/^[a-f0-9]{64}$/.test(origin)||!/^[a-f0-9]{64}$/.test(manifestDigest)||!/^[a-f0-9]{40}$/.test(codeSha)||endpoint!=='http://127.0.0.1:8082/drain')fail('SYNTHETIC_DISPATCH_BINDING_REQUIRED');
 const prefix='stage6_local_dispatch_v1:'+origin+':',pointer=prefix+'current';
 const component=id=>prefix+bodySha256(id);
 const common={version:1,origin,databaseId,endpoint,cohort:[...tenantIds].sort()};
 const pack=value=>{const raw=JSON.stringify({...value,hmac:keys.lookup(['stage6-local-dispatch-row-v1',value])});if(Buffer.byteLength(raw)>262144)fail('SYNTHETIC_DISPATCH_RECORD_BOUND');return raw;};
 const unpack=raw=>{if(raw==null)return null;try{const {hmac,...v}=JSON.parse(raw);if(JSON.stringify({...v,hmac})!==raw||hmac!==keys.lookup(['stage6-local-dispatch-row-v1',v])||Object.entries(common).some(([k,x])=>!isDeepStrictEqual(v[k],x)))fail('SYNTHETIC_DISPATCH_RECORD_INVALID');return v;}catch{fail('SYNTHETIC_DISPATCH_RECORD_INVALID');}};
 const read=async name=>{const row=(await db.raw.execute({sql:"SELECT last_detail FROM system_heartbeats WHERE scope='global' AND component=?",args:[name]})).rows[0];return {raw:row?.last_detail??null,value:unpack(row?.last_detail)};};
 const save=async(name,value,prior)=>{const raw=pack(value),at=new Date().toISOString(),stmt=prior==null?{sql:"INSERT INTO system_heartbeats(scope,component,last_ok_at,last_detail,updated_at) VALUES('global',?,?,?,?) ON CONFLICT(scope,component) DO NOTHING",args:[name,at,raw,at]}:{sql:"UPDATE system_heartbeats SET last_detail=?,updated_at=? WHERE scope='global' AND component=? AND last_detail=?",args:[raw,at,name,prior]};if((await db.raw.execute(stmt)).rowsAffected!==1)fail('SYNTHETIC_DISPATCH_CAS_REJECTED');};
 const requireIdentity=(r,userId,request)=>{if(!r||r.kind!=='REQUEST'||r.userId!==userId||r.codeSha!==codeSha||r.manifestDigest!==manifestDigest||r.bodySha!==bodySha256(canonicalPhaseRequest(request))||!isDeepStrictEqual(r.request,request))fail('SYNTHETIC_DISPATCH_IDENTITY_MISMATCH');};
 const current=async()=>{const p=await read(pointer);if(!p.value)return null;if(p.value.kind!=='POINTER')fail('SYNTHETIC_DISPATCH_RECORD_INVALID');const r=await read(component(p.value.requestId));if(!r.value||r.value.request.requestId!==p.value.requestId)fail('SYNTHETIC_DISPATCH_RECORD_INVALID');return r.value;};
 const own=async(userId,request,dispatchId)=>{const p=await read(pointer),r=await read(component(request.requestId));if(p.value?.requestId!==request.requestId)fail('SYNTHETIC_DISPATCH_NOT_CURRENT');requireIdentity(r.value,userId,request);const a=r.value.attempts.at(-1);if(!a||a.id!==dispatchId)fail('SYNTHETIC_DISPATCH_OWNER_REJECTED');return {...r,attempt:a};};
 const update=async(r,value)=>save(component(value.request.requestId),{...value,revision:value.revision+1},r.raw);
 const retryProof=async v=>{
  const a=v.attempts.at(-1),s=a.response;
  if(v.attempts.length!==1||!['RESPONSE','RETRY_READY'].includes(a.state)||!s||bodySha256(JSON.stringify(s))!==a.responseSha)fail('SYNTHETIC_DISPATCH_RETRY_SPENT');
  const observation=await observeUnadmittedStartup(db.raw,keys,v.userId,v.request),after=(await db.raw.execute({sql:syntheticDispatchJobsSql,args:[v.userId]})).rows;
  const entry={requestId:v.request.requestId,userId:v.userId,status:s.status,result:s.body.result,response:{status:s.status,ok:s.body.ok===true,error:s.body.error,resumable:s.body.resumable===true},childLifecycle:s.childLifecycle,child:s.child};
  if(!canRetryUnadmittedStartup({request:v.request,userId:v.userId,codeSha,startupRetries:0,entry,observation,before:v.beforeJobs,after}))fail('SYNTHETIC_DISPATCH_RETRY_NOT_PROVEN');return observation;
 };
 return Object.freeze({current,
  async reserve({userId,request,beforeJobs}){return db.transaction(async()=>{
   if(!tenantIds.includes(userId)||request.releaseSha!==codeSha||request.phase!=='STAGE6_DRAIN'||request.executionMode!=='SHADOW'||request.triggerSource!=='manual')fail('SYNTHETIC_DISPATCH_IDENTITY_MISMATCH');
   const campaign=(await db.raw.execute({sql:"SELECT last_detail,(CAST(strftime('%s','now') AS INTEGER)*1000+CAST(substr(strftime('%f','now'),4,3) AS INTEGER)) observed_at FROM system_heartbeats WHERE scope='global' AND component=?",args:['stage6_local_synthetic_http_v1:'+origin]})).rows[0];
   const ledger=decodeState(campaign?.last_detail,{keys,manifestDigest:origin});
   if(ledger.databaseId!==databaseId||ledger.closed||!Number.isSafeInteger(campaign.observed_at)||campaign.observed_at<ledger.lastObservedAt||campaign.observed_at>=ledger.endAt||ledger.attempts>=4096||ledger.scopes.qualification>=4093)fail('SYNTHETIC_DISPATCH_CAMPAIGN_CLOSED');
   const window={startAt:ledger.startAt,endAt:ledger.endAt};
   const p=await read(pointer),r=await read(component(request.requestId));
   if(p.value&&p.value.requestId!==request.requestId){const old=await read(component(p.value.requestId));if(old.value?.completed!==true)fail('SYNTHETIC_DISPATCH_ACTIVE_REQUEST');}
   let v=r.value;if(v){requireIdentity(v,userId,request);if(!isDeepStrictEqual(v.window,window))fail('SYNTHETIC_DISPATCH_WINDOW_MISMATCH');if(v.completed||v.attempts.length!==1||v.attempts[0].state!=='RETRY_READY')fail('SYNTHETIC_DISPATCH_SPENT_OR_UNCERTAIN');await retryProof(v);}
   else{const rows=beforeJobs.filter(j=>j.user_id===userId);if(rows.length!==2||new Set(rows.map(j=>j.job_kind)).size!==2)fail('SYNTHETIC_DISPATCH_JOB_SNAPSHOT_REQUIRED');v={...common,kind:'REQUEST',codeSha,manifestDigest,userId,request,bodySha:bodySha256(canonicalPhaseRequest(request)),revision:0,beforeJobs:rows,window,completed:false,attempts:[]};}
   const a={id:randomUUID(),number:v.attempts.length+1,state:'RESERVED',reservedAt:campaign.observed_at,permitAttemptsBefore:ledger.attempts,permitScopesBefore:ledger.scopes},next={...v,revision:v.revision+1,attempts:[...v.attempts,a]};
   await save(component(request.requestId),next,r.raw);await save(pointer,{...common,kind:'POINTER',requestId:request.requestId,revision:(p.value?.revision??0)+1},p.raw);return structuredClone(a);
  });},
  async accept({userId,request,dispatchId}){return db.transaction(async()=>{const r=await own(userId,request,dispatchId);if(r.value.completed||r.attempt.state!=='RESERVED')fail('SYNTHETIC_DISPATCH_ALREADY_ACCEPTED');r.attempt.state='ACCEPTED';r.attempt.acceptedAt=Date.now();await update(r,r.value);});},
  async respond({userId,request,dispatchId,response,childLifecycle,child}){return db.transaction(async()=>{const r=await own(userId,request,dispatchId);if(r.value.completed||r.attempt.state!=='ACCEPTED'||!Number.isInteger(response.status)||typeof response.body!=='object'||!response.body)fail('SYNTHETIC_DISPATCH_RESPONSE_REJECTED');r.attempt.state='RESPONSE';r.attempt.response={...response,childLifecycle,child};r.attempt.responseSha=bodySha256(JSON.stringify(r.attempt.response));await update(r,r.value);});},
  async allowRetry({userId,request,dispatchId}){return db.transaction(async()=>{
   const r=await own(userId,request,dispatchId);if(r.value.completed||r.value.attempts.length!==1||r.attempt.state!=='RESPONSE')fail('SYNTHETIC_DISPATCH_RETRY_SPENT');
   const observation=await retryProof(r.value);
   r.attempt.state='RETRY_READY';r.attempt.zeroWorkObservation=observation;await update(r,r.value);return observation;
  });},
  async complete({userId,request,dispatchId,response,metadataReconciliation=false}){return db.transaction(async()=>{
   const r=await own(userId,request,dispatchId);if(r.value.completed){if(r.value.completionSha!==bodySha256(JSON.stringify(response)))fail('SYNTHETIC_DISPATCH_COMPLETION_MISMATCH');return;}
   // Caller MUST first run original fresh replay + producer/HMAC/named work verification.
   // This journal is bookkeeping, never proof that computation completed.
   if(response.status!==200||response.body?.ok!==true||!(r.attempt.state==='RESPONSE'&&!metadataReconciliation||r.attempt.state==='ACCEPTED'&&metadataReconciliation))fail('SYNTHETIC_DISPATCH_COMPLETION_REJECTED');
   if(!metadataReconciliation&&!isDeepStrictEqual(response,{status:r.attempt.response.status,body:r.attempt.response.body}))fail('SYNTHETIC_DISPATCH_COMPLETION_MISMATCH');
   r.value.completed=true;r.value.completionResponse=response;r.value.completionSha=bodySha256(JSON.stringify(response));r.value.completionKind=metadataReconciliation?'ORIGINAL_RUNTIME_RECONCILIATION':'VERIFIED_RESPONSE';await update(r,r.value);
  });},
 });
}

// One controller iteration, shared by the real runner and deterministic crash
// tests. Only a newly won CAS can call send(); restart never resends RESERVED.
export async function dispatchSyntheticRequest({journal,userId,request,beforeJobs,send,reconcile}){
 let record=await journal.current(),dispatch,response,transport='DURABLE_RESPONSE_RECONCILIATION',metadataReconciliation=false;
 if(record?.request.requestId!==request.requestId||record.attempts.at(-1).state==='RETRY_READY'){
  dispatch=await journal.reserve({userId,request,beforeJobs});response=await send(dispatch);transport='HTTP_DISPATCH';record=await journal.current();
  if(record?.request.requestId!==request.requestId||record.attempts.at(-1).id!==dispatch.id||record.attempts.at(-1).state!=='RESPONSE')fail('SYNTHETIC_DISPATCH_OUTCOME_UNCERTAIN');
  if(!isDeepStrictEqual(response,{status:record.attempts.at(-1).response.status,body:record.attempts.at(-1).response.body}))fail('SYNTHETIC_DISPATCH_RESPONSE_MISMATCH');
 }else{
  if(record.userId!==userId||record.codeSha!==request.releaseSha||!isDeepStrictEqual(record.request,request))fail('SYNTHETIC_DISPATCH_IDENTITY_MISMATCH');dispatch=record.attempts.at(-1);
  if(record.completed)response=record.completionResponse;
  else if(dispatch.state==='RESPONSE')response={status:dispatch.response.status,body:dispatch.response.body};
  else if(dispatch.state==='ACCEPTED'){response=await reconcile();if(response?.status!==200||response.body?.ok!==true)fail('SYNTHETIC_DISPATCH_OUTCOME_UNCERTAIN');metadataReconciliation=true;transport='ORIGINAL_RUNTIME_METADATA_RECONCILIATION';}
  else fail('SYNTHETIC_DISPATCH_SPENT_OR_UNCERTAIN');
 }
 return {record,dispatch:record.attempts.at(-1),response,transport,metadataReconciliation};
}
// Duplicate delivery must fail its accept CAS before any child/worker call.
export async function runSyntheticDispatch({journal,userId,request,dispatchId,run,observation}){
 await journal.accept({userId,request,dispatchId});const response=await run();
 await journal.respond({userId,request,dispatchId,response,...observation()});return response;
}
