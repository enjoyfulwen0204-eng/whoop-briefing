import {canonicalJson} from './phase4EntityStore.js';
import {liveScopeDigest} from './stage8LiveProducerAuthority.js';
import {verifyLiveExecutionResult} from './stage8LiveExecution.js';
const fail=()=>{throw Error('STAGE8_SUBJECT_ALERT_SOURCE_FENCED');};
export const subjectAlertExecutionId=(keys,ctx)=>keys.lookup(['stage8-live-subject-alert-execution-v1',ctx.userId,liveScopeDigest(keys,ctx)]);
/** Bounded exact source artifact snapshot. Only its keyed digest is persisted. */
export async function subjectAlertDigest(core,ctx){
 await core.assertContext(ctx);if(ctx.executionMode!=='LIVE'||!ctx.providerRequired)fail();
 const manifest=[];
 for(const [table,id,max] of [['phase4_proactive_decisions','decision_id',10],['outbound_messages','message_id',10],['outbound_delivery_attempts','attempt_id',30]]){
  const columns=(await core.client.execute(`PRAGMA table_info(${table})`)).rows.map(r=>r.name),args=[ctx.userId,ctx.inputGeneration];
  const predicate=table==='outbound_delivery_attempts'?"EXISTS(SELECT 1 FROM outbound_messages m WHERE m.user_id=r.user_id AND m.execution_mode=r.execution_mode AND m.message_id=r.message_id AND m.input_generation=?)":'r.input_generation=?';
  const bound=(await core.client.execute({sql:`SELECT count(*) n,COALESCE(sum(bytes),0) bytes FROM
   (SELECT ${columns.map(c=>`6*COALESCE(length(CAST("${c}" AS BLOB)),0)+${128+Buffer.byteLength(c)*6}`).join('+')} bytes FROM ${table} r
    WHERE r.user_id=? AND r.execution_mode='LIVE' AND ${predicate} LIMIT ${max+1})`,args})).rows[0];
  if(bound.n>max||bound.bytes>4*1024*1024)fail();const hashes=[];
  for(let offset=0;offset<bound.n;offset+=10){const rows=(await core.client.execute({sql:`SELECT r.* FROM ${table} r WHERE r.user_id=? AND r.execution_mode='LIVE' AND ${predicate} ORDER BY r.${id} LIMIT 10 OFFSET ?`,args:[...args,offset]})).rows;
   if(rows.length!==Math.min(10,bound.n-offset))fail();for(const row of rows)hashes.push(core.keys.lookup(['stage8-subject-alert-row-v1',table,canonicalJson({...row})]));
  }manifest.push([table,hashes]);
 }
 return core.keys.lookup(['stage8-subject-alert-manifest-v1',manifest]);
}
export async function verifySubjectAlertExecution(core,ctx){
 try{
  const id=subjectAlertExecutionId(core.keys,ctx),e=(await core.client.execute({sql:'SELECT * FROM stage8_live_executions WHERE execution_id=?',args:[id]})).rows[0];
  if(!e||e.state!=='FINALIZED_SUCCESS'||e.generation!==1||e.finalized_at>e.created_at+45000||JSON.parse(e.canonical_request_json).tenantScope!==liveScopeDigest(core.keys,ctx))return false;
  const result=verifyLiveExecutionResult(core.keys,e);if(result.outcome!=='COMPLETE'||!result.alertSourceDigest||result.alertSourceDigest!==await subjectAlertDigest(core,ctx))return false;
  const p=(await core.client.execute({sql:"SELECT * FROM stage8_live_execution_producers WHERE user_id=? AND execution_mode='LIVE' AND input_generation=? AND producing_execution_id=?",args:[ctx.userId,ctx.inputGeneration,id]})).rows[0];
  if(!p||p.producing_generation!==1||p.execution_seq!==e.execution_seq||p.tenant_proof!==core.keys.lookup(['execution-producer-v1',ctx.userId,'LIVE',ctx.inputGeneration,id,e.execution_seq,1]))return false;
  const logical=core.keys.lookup(['phase4-logical-work-v1','stage8.subject-alert.manifest',[ctx.userId,ctx.inputGeneration]]),receiptKey=core.keys.lookup(['execution-work-step-v2',e.identity_digest,e.scope_key,['named',logical]]);
  const r=(await core.client.execute({sql:'SELECT * FROM stage8_live_execution_work_receipts WHERE receipt_key=?',args:[receiptKey]})).rows[0];
  return Boolean(r&&r.execution_id===id&&r.request_digest===e.identity_digest&&r.scope_key===e.scope_key&&r.generation===1&&r.committed_at<=e.finalized_at&&r.result_json===JSON.stringify(result.alertSourceDigest));
 }catch{return false;}
}
