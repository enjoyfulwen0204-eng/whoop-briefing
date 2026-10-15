import assert from 'node:assert/strict';import {fixtureKeys} from './localDb.js';
import {bodySha256} from '../src/briefingTriggerAuth.js';
// Authenticate this request's producer/result and match its exact cursor ACK.
// Full-history receipt verification is a separate caller responsibility; do
// not substitute an older cycle DOMAIN retained in the starting fixture.
export async function verifyCurrentRuntimeProof(db,executionId,oldOperations){
 const producer=(await db.raw.execute({sql:`SELECT p.*,e.identity_digest,e.scope_key,e.state,e.finalized_at,e.result_json,e.result_digest FROM phase4_execution_producers p JOIN phase4_executions e ON e.execution_id=p.producing_execution_id WHERE p.producing_execution_id=? AND p.user_id='a' AND p.execution_mode='SHADOW'`,args:[executionId]})).rows[0];assert.ok(producer);assert.equal(producer.state,'FINALIZED_SUCCESS');assert.equal(bodySha256(producer.result_json),producer.result_digest);assert.equal(producer.tenant_proof,fixtureKeys.lookup(['execution-producer-v1','a','SHADOW',producer.input_generation,executionId,producer.execution_seq,producer.producing_generation]));
 const work=(await db.raw.execute({sql:'SELECT * FROM phase4_execution_work_receipts WHERE execution_id=?',args:[executionId]})).rows;
 const named=(kind,facts)=>fixtureKeys.lookup(['execution-work-step-v2',producer.identity_digest,producer.scope_key,['named',fixtureKeys.lookup(['phase4-logical-work-v1',kind,facts])]]);
 const accepted=key=>{const row=work.find(r=>r.receipt_key===key);assert.ok(row);assert.equal(row.generation,producer.producing_generation);assert.ok(row.committed_at<=producer.finalized_at);return key;};
 const jobs=(await db.raw.execute("SELECT job_kind,requested_generation,scope_revision,full_scan_cursor FROM phase4_jobs WHERE user_id='a' AND execution_mode='SHADOW'")).rows;
 const newOperations=(await db.raw.execute("SELECT operation_kind,operation_key,input_generation,request_json FROM phase4_operation_receipts WHERE user_id='a' AND execution_mode='SHADOW'")).rows.filter(r=>!oldOperations.includes(r.operation_key)).map(r=>{
  const request=JSON.parse(r.request_json).request,metrics=[...new Set((request.hypotheses??[]).map(h=>h.outcomeMetric))],candidates=[{kind:'domain.operation',key:named('domain.operation',['a','SHADOW',r.input_generation,r.operation_kind,r.operation_key])}];
  for(const j of jobs)if(j.full_scan_cursor)for(const metric of metrics){const [type,id]=JSON.parse(j.full_scan_cursor);candidates.push({kind:'stage6.associations',key:named('stage6.associations',['a','SHADOW',j.job_kind,j.requested_generation,j.scope_revision,[type,id,j.full_scan_cursor,metric,request.asOfUtc]])});}
  const match=candidates.find(c=>work.some(w=>w.receipt_key===c.key));assert.ok(match,JSON.stringify({operationKind:r.operation_kind,requestFields:Object.keys(request),metricCount:metrics.length}));
  return {operationKind:r.operation_kind,operationKey:r.operation_key,executionId,producingGeneration:producer.producing_generation,workKind:match.kind,receiptKey:accepted(match.key),exactNamedAck:true};
 });
 const cursor=jobs.map(j=>({jobKind:j.job_kind,cursor:j.full_scan_cursor,key:named('stage6.checkpoint',['a','SHADOW',j.job_kind,j.requested_generation,j.scope_revision,[j.full_scan_cursor]])})).find(j=>work.some(r=>r.receipt_key===j.key));assert.ok(cursor);accepted(cursor.key);
 return {executionId,producerHmac:true,resultDigest:true,newOperations,cursor:{jobKind:cursor.jobKind,cursor:cursor.cursor,receiptKey:cursor.key,exactNamedAck:true}};
}
