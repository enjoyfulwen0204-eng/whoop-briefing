import {canonicalPhaseRequest} from '../src/phase4ExecutionStore.js';
import assert from 'node:assert/strict';
import {bodySha256} from '../src/briefingTriggerAuth.js';

export const parentRequestBody = request => canonicalPhaseRequest(request);
export function phaseHttpBody(response) {
  if (!Number.isInteger(response?.status) || response.status < 100 || response.status > 599
      || !response.body || typeof response.body !== 'object') throw Error('SYNTHETIC_PHASE_RESPONSE_INVALID');
  return JSON.stringify(response.body);
}
// Controller bookkeeping only. This neither grants work nor authenticates a
// health result. A pre-publication failure legitimately has no health producer.
export function terminalPredecessorMetadata(request,row,work,entry){
 assert.ok(row);assert.ok(['FINALIZED_SUCCESS','FINALIZED_FAILURE'].includes(row.state));
 assert.equal(row.execution_id,request.requestId);assert.equal(entry.requestId,request.requestId);
 assert.equal(row.release_sha,request.releaseSha);assert.equal(row.config_proof,request.configProof);
 assert.equal(row.phase,request.phase);assert.equal(row.execution_mode,request.executionMode);assert.equal(row.trigger_source,request.triggerSource);
 assert.equal(row.canonical_request_json,canonicalPhaseRequest(request));assert.equal(row.identity_digest,bodySha256(JSON.stringify(request)));
 assert.equal(row.scope_key,bodySha256(JSON.stringify(['phase4-execution-scope-v1',request.phase,request.executionMode,request.configProof])));
 assert.equal(row.result_digest,bodySha256(row.result_json));const result=JSON.parse(row.result_json);
 for(const [field,value] of [['identity',row.identity_digest],['releaseSha',request.releaseSha],['configProof',request.configProof],['phase',request.phase],['executionMode',request.executionMode],['source',request.triggerSource]])assert.equal(result[field],value);
 assert.ok(Number.isSafeInteger(row.generation)&&row.generation>=1);assert.ok(Number.isSafeInteger(row.finalized_at)&&row.finalized_at>=row.created_at&&row.finalized_at<=row.deadline_at);
 assert.ok(Number.isSafeInteger(result.finishedAt)&&result.finishedAt>=row.created_at&&result.finishedAt<=row.finalized_at);
 assert.ok(work.length);for(const r of work){assert.equal(r.execution_id,row.execution_id);assert.equal(r.request_digest,row.identity_digest);assert.equal(r.scope_key,row.scope_key);assert.equal(r.step_key,r.receipt_key);assert.ok(Number.isSafeInteger(r.generation)&&r.generation>=1&&r.generation<=row.generation);assert.ok(r.committed_at>=row.created_at&&r.committed_at<=row.finalized_at);}
 if(row.state==='FINALIZED_FAILURE'){assert.equal(result.outcome,'FAILED');assert.equal(entry.status,424);return 'FAILURE';}
 assert.equal(entry.status,200);assert.notEqual(result.outcome,'FAILED');return 'SUCCESS';
}
