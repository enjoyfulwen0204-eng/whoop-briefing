import {currentDurableExecution,assertExecutionWorkOwner,workStepKey} from './phase4ExecutionContext.js';
import {workStepOptions} from './phase4WorkStep.js';
import {liveScopeDigest,isLiveExecution,liveProducerConfiguration} from './stage8LiveProducerAuthority.js';
import {verifyLiveExecutionResult} from './stage8LiveExecution.js';
import {canonicalJson} from './phase4EntityStore.js';
import {V23_TABLES} from './phase4V23Schema.js';
const fail=()=>{throw Object.assign(Error('STAGE8_LIVE_PUBLICATION_FENCED'),{code:'STAGE8_LIVE_PUBLICATION_FENCED'});};
const JOBS=['RECOMPUTE_DERIVED','REPAIR_CURRENTNESS'];
const ARTIFACTS=Object.freeze([...V23_TABLES,'health_insights','phase4_episode_revisions',
 'stage8_live_evidence_result_authorities','stage8_live_operation_receipts']);
export const liveCompletionCursorHash=(keys,cursor)=>keys.lookup(['stage8-live-cursor-v1',cursor]);
export const liveCompletionWork=(context,b,cursorHash)=>workStepOptions('stage6.complete',[context.userId,b.jobKind,b.requestedGeneration,b.scopeRevision,cursorHash],{discardResult:true});
const signCompletion=(keys,row)=>keys.lookup(['stage8-live-completion-v1',canonicalJson(row)]);
const signPublication=(keys,row)=>keys.lookup(['stage8-live-publication-v1',canonicalJson(row)]);
/** Called only in the canonical queue's opaque EOF/family-complete transaction.
 * Its deferred FK binds the ACK appended by that same root COMMIT. */
export async function recordLiveJobCompletion(core,context,b,cursor){
 core.assertAnalysisWrite(context);const execution=currentDurableExecution();
 if(!core.processing.active()||!isLiveExecution(execution,core.client,core.keys,context.userId,context))fail();
 const owner=await assertExecutionWorkOwner(core.client),at=Date.now(),deadline=owner.created_at+45000;
 if(owner.generation!==1||at>=deadline)fail();
 const cursorHash=liveCompletionCursorHash(core.keys,cursor),step=liveCompletionWork(context,b,cursorHash);
 const row={user_id:context.userId,execution_mode:'LIVE',input_generation:context.inputGeneration,job_kind:b.jobKind,
  scope_revision:b.scopeRevision,scope_hash:liveScopeDigest(core.keys,context),execution_id:owner.execution_id,
  producing_generation:owner.generation,receipt_key:workStepKey(execution,['named',step.workStep]),
  cursor_hash:cursorHash,original_deadline_at:deadline,completed_at:at};
 row.completion_hmac=signCompletion(core.keys,row);const fields=Object.keys(row);
 await core.client.execute({sql:`INSERT INTO stage8_live_job_completions(${fields.join(',')}) VALUES(${fields.map(()=>'?')})`,args:fields.map(k=>row[k])});
}
/** Bounded exact physical inventory; no health bytes are persisted in certificates. */
async function manifests(core,ctx){
 const client=core.client,keys=core.keys;
 const bounds=(await client.execute({sql:`SELECT count(*) n,COALESCE(sum(bytes),0) bytes FROM
  (SELECT COALESCE(length(e.result_json),0)+COALESCE(length(e.canonical_request_json),0)+4096 bytes FROM stage8_live_execution_producers p
   JOIN stage8_live_executions e ON e.execution_id=p.producing_execution_id WHERE p.user_id=? AND p.execution_mode='LIVE' AND p.input_generation=? LIMIT 4097)`,args:[ctx.userId,ctx.inputGeneration]})).rows[0];
 if(!bounds.n||bounds.n>4096||bounds.bytes>16*1024*1024)fail();
 const producers=[];
 for(let offset=0;offset<bounds.n;offset+=64)producers.push(...(await client.execute({sql:`SELECT p.*,e.*,p.execution_seq producing_seq FROM stage8_live_execution_producers p
  JOIN stage8_live_executions e ON e.execution_id=p.producing_execution_id WHERE p.user_id=? AND p.execution_mode='LIVE' AND p.input_generation=?
  ORDER BY p.execution_seq LIMIT 64 OFFSET ?`,args:[ctx.userId,ctx.inputGeneration,offset]})).rows);
 if(!producers.length||producers.length>4096)fail();
 for(const p of producers){
  if(p.execution_seq!==p.producing_seq||p.state!=='FINALIZED_SUCCESS'||p.phase!=='STAGE6_DRAIN'||p.producing_generation!==1||p.generation!==1
   ||p.finalized_at>p.created_at+45000||p.finalized_at<p.created_at
   ||p.tenant_proof!==keys.lookup(['execution-producer-v1',ctx.userId,'LIVE',ctx.inputGeneration,p.producing_execution_id,p.execution_seq,p.producing_generation])
   ||JSON.parse(p.canonical_request_json).tenantScope!==liveScopeDigest(keys,ctx))fail();
  if(verifyLiveExecutionResult(keys,p).outcome==='FAILED')fail();
 }
 const hashes=[];let count=0,bytes=0;
 for(const table of ARTIFACTS){
  const info=(await client.execute(`PRAGMA table_info(${table})`)).rows,columns=info.map(r=>r.name);
  if(!columns.includes('user_id')||!columns.includes('execution_mode'))fail();
  const current=columns.includes('input_generation'),where=`user_id=? AND execution_mode='LIVE'${current?' AND input_generation=?':''}`,
   args=[ctx.userId,...(current?[ctx.inputGeneration]:[])];
  // Count and worst-case escaped JSON bytes before transferring health rows.
  // Schema-owned names only. Six bytes cover each escaped input byte; fixed
  // per-column overhead also bounds numbers, keys, separators and nulls.
  const bound=(await client.execute({sql:`SELECT count(*) n,COALESCE(sum(${columns.map(c=>`6*COALESCE(length(CAST("${c}" AS BLOB)),0)+${128+Buffer.byteLength(c)*6}`).join('+')}),0) bytes FROM ${table} WHERE ${where}`,args})).rows[0];
  count+=bound.n;bytes+=bound.bytes;if(count>10000||bytes>64*1024*1024)fail();
  const order=info.filter(c=>c.pk).sort((a,b)=>a.pk-b.pk).map(c=>`"${c.name}"`).join(',');if(!order)fail();
  const entries=[];
  for(let offset=0;offset<bound.n;offset+=64){
   const rows=(await client.execute({sql:`SELECT * FROM ${table} WHERE ${where} ORDER BY ${order} LIMIT 64 OFFSET ?`,args:[...args,offset]})).rows;
   if(rows.length!==Math.min(64,bound.n-offset))fail();
   for(const row of rows)entries.push(keys.lookup(['stage8-live-artifact-row-v1',table,canonicalJson(row)]));
  }
  hashes.push([table,entries.sort()]);
 }
 return {producer_hash:keys.lookup(['stage8-live-producer-manifest-v1',canonicalJson(producers)]),artifact_hash:keys.lookup(['stage8-live-artifact-manifest-v1',hashes])};
}
async function completionProofs(core,ctx){
 const keys=core.keys,client=core.client,{computation}=await core.assertContext(ctx);
 if(!ctx.providerRequired||computation.last_completed_generation!==ctx.inputGeneration)fail();
 if((await client.execute({sql:"SELECT 1 FROM phase4_invalidations WHERE user_id=? AND execution_mode='LIVE' AND scope_kind<>'NONE' LIMIT 1",args:[ctx.userId]})).rows.length)fail();
 const proofs=[];
 for(const kind of JOBS){
  const job=(await client.execute({sql:"SELECT * FROM phase4_jobs WHERE user_id=? AND execution_mode='LIVE' AND job_kind=?",args:[ctx.userId,kind]})).rows[0];
  if(!job||job.state!=='COMPLETED'||job.scope_kind!=='NONE'||job.requested_generation!==ctx.inputGeneration||job.completed_generation!==ctx.inputGeneration||job.lease_owner!==null)fail();
  const row=(await client.execute({sql:"SELECT * FROM stage8_live_job_completions WHERE user_id=? AND execution_mode='LIVE' AND input_generation=? AND job_kind=? AND scope_revision=?",args:[ctx.userId,ctx.inputGeneration,kind,job.scope_revision]})).rows[0];
  if(!row)fail();const {completion_hmac,...payload}=row;
  if(completion_hmac!==signCompletion(keys,payload)||row.scope_hash!==liveScopeDigest(keys,ctx))fail();
  const e=(await client.execute({sql:'SELECT * FROM stage8_live_executions WHERE execution_id=?',args:[row.execution_id]})).rows[0],
   r=(await client.execute({sql:'SELECT * FROM stage8_live_execution_work_receipts WHERE receipt_key=?',args:[row.receipt_key]})).rows[0];
  if(!e||!r||e.state!=='FINALIZED_SUCCESS'||e.phase!=='STAGE6_DRAIN'||e.execution_mode!=='LIVE'
   ||e.generation!==1||e.created_at+45000!==row.original_deadline_at||e.finalized_at>row.original_deadline_at
   ||JSON.parse(e.canonical_request_json).tenantScope!==row.scope_hash
   ||r.execution_id!==row.execution_id||r.generation!==row.producing_generation||r.generation!==1
   ||r.request_digest!==e.identity_digest||r.scope_key!==e.scope_key||r.step_key!==row.receipt_key
   ||r.committed_at<row.completed_at||r.committed_at>e.finalized_at)fail();
  const producer=(await client.execute({sql:`SELECT * FROM stage8_live_execution_producers WHERE user_id=? AND execution_mode='LIVE'
   AND input_generation=? AND producing_execution_id=?`,args:[ctx.userId,ctx.inputGeneration,e.execution_id]})).rows[0];
  const logical=keys.lookup(['phase4-logical-work-v1','stage6.complete',[ctx.userId,kind,ctx.inputGeneration,row.scope_revision,row.cursor_hash]]);
  const expected=keys.lookup(['execution-work-step-v2',e.identity_digest,e.scope_key,['named',logical]]);
  if(row.receipt_key!==expected||!producer||producer.producing_generation!==row.producing_generation||producer.execution_seq!==e.execution_seq
   ||producer.tenant_proof!==keys.lookup(['execution-producer-v1',ctx.userId,'LIVE',ctx.inputGeneration,e.execution_id,e.execution_seq,row.producing_generation]))fail();
  if(verifyLiveExecutionResult(keys,e).outcome==='FAILED')fail();
  proofs.push({jobKind:kind,receiptKey:row.receipt_key,completionHmac:completion_hmac});
 }
 return proofs;
}
/** Atomic metadata publication, after genuine canonical source/family EOF ACKs
 * and finalized original execution seals. No transport or caller result input. */
export async function publishStage8Live(core,ctx,capability){
 liveProducerConfiguration(capability,core.client,core.keys,ctx.userId);
 return core.transaction(async()=>{
  liveProducerConfiguration(capability,core.client,core.keys,ctx.userId);await core.assertContext(ctx);
  const prior=(await core.client.execute({sql:'SELECT * FROM stage8_live_publications WHERE user_id=? AND input_generation=?',args:[ctx.userId,ctx.inputGeneration]})).rows[0];
  if(prior){if(!await verifyStage8LivePublication(core,ctx))fail();return {replayed:true,inputGeneration:ctx.inputGeneration};}
  const proofs=await completionProofs(core,ctx),manifest=await manifests(core,ctx),at=Date.now();
  const row={user_id:ctx.userId,execution_mode:'LIVE',input_generation:ctx.inputGeneration,scope_hash:liveScopeDigest(core.keys,ctx),...manifest,
   proofs_json:canonicalJson(proofs),issued_at:at,expires_at:at+900000};
  row.publication_hmac=signPublication(core.keys,row);const fields=Object.keys(row);
  await core.client.execute({sql:`INSERT INTO stage8_live_publications(${fields.join(',')}) VALUES(${fields.map(()=>'?')})`,args:fields.map(k=>row[k])});
  await core.assertContext(ctx);liveProducerConfiguration(capability,core.client,core.keys,ctx.userId);
  return {replayed:false,inputGeneration:ctx.inputGeneration};
 },{before:()=>core.assertContext(ctx),commitFence:()=>{liveProducerConfiguration(capability,core.client,core.keys,ctx.userId);return core.assertContext(ctx);}});
}
/** Reader failure is closed; typed artifact readers still authenticate roots. */
export async function verifyStage8LivePublication(core,ctx){
 try{
  if(!core.liveAllocation||ctx.executionMode!=='LIVE'||!ctx.providerRequired)return false;
  await core.assertContext(ctx);
  const row=(await core.client.execute({sql:'SELECT * FROM stage8_live_publications WHERE user_id=? AND input_generation=?',args:[ctx.userId,ctx.inputGeneration]})).rows[0];
  if(!row)return false;const {publication_hmac,...payload}=row,at=Date.now();
  if(row.scope_hash!==liveScopeDigest(core.keys,ctx)||publication_hmac!==signPublication(core.keys,payload)||row.issued_at>at||row.expires_at<=at)return false;
  const proofs=await completionProofs(core,ctx),manifest=await manifests(core,ctx);
  if(row.proofs_json!==canonicalJson(proofs)||row.producer_hash!==manifest.producer_hash||row.artifact_hash!==manifest.artifact_hash)return false;
  await core.assertContext(ctx);return true;
 }catch{return false;}
}
