import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {parentRequestBody, phaseHttpBody,terminalPredecessorMetadata} from './stage6SyntheticControllerContract.mjs';
import {canonicalPhaseRequest} from '../src/phase4ExecutionStore.js';

test('HTTP controller preserves original phase status/body for success, retry and rejection',async()=>{
 const server=createServer((req,res)=>{const status=Number(req.url.slice(1)),out={status,body:{ok:status===200,result:{resumable:status===202},error:status>=400?'REJECTED':null}};res.writeHead(out.status,{'content-type':'application/json'}).end(phaseHttpBody(out));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));try{for(const status of [200,202,409,424,503]){const r=await fetch('http://127.0.0.1:'+server.address().port+'/'+status);assert.equal(r.status,status);const body=await r.json();assert.equal(body.ok,status===200);assert.equal(body.status,undefined);assert.equal(body.result.resumable,status===202);}}finally{await new Promise(r=>server.close(r));}
});
test('canonical parent bytes survive sorted durable request storage and process restart',()=>{
 const req={requestId:'synthetic',releaseSha:'a'.repeat(40),phase:'SYNC',triggerSource:'manual',executionMode:'SHADOW',configProof:'b'.repeat(64)},body=parentRequestBody(req),restart=JSON.parse(body);
 assert.notEqual(JSON.stringify(req),JSON.stringify(restart));assert.equal(parentRequestBody(restart),body);const hash=x=>createHash('sha256').update(x).digest('hex');assert.equal(hash(parentRequestBody(restart)),hash(body));assert.notEqual(hash(JSON.stringify(req)),hash(body));
});
test('malformed phase wrappers cannot be emitted as HTTP success',()=>{for(const value of [null,{}, {status:200},{status:0,body:{}},{status:'200',body:{}}])assert.throws(()=>phaseHttpBody(value));});
test('authentic terminal failure resumes only controller bookkeeping without inventing a health producer',()=>{
 const hash=x=>createHash('sha256').update(x).digest('hex'),request={requestId:'synthetic-failed',releaseSha:'a'.repeat(40),phase:'STAGE6_DRAIN',triggerSource:'manual',executionMode:'SHADOW',configProof:'b'.repeat(64)},identity=hash(JSON.stringify(request)),scope=hash(JSON.stringify(['phase4-execution-scope-v1',request.phase,request.executionMode,request.configProof]));
 const result={identity,releaseSha:request.releaseSha,configProof:request.configProof,phase:request.phase,executionMode:'SHADOW',source:'manual',outcome:'FAILED',finishedAt:200},resultJson=JSON.stringify(result),row={execution_id:request.requestId,release_sha:request.releaseSha,config_proof:request.configProof,phase:request.phase,execution_mode:'SHADOW',trigger_source:'manual',canonical_request_json:canonicalPhaseRequest(request),identity_digest:identity,scope_key:scope,result_json:resultJson,result_digest:hash(resultJson),state:'FINALIZED_FAILURE',generation:1,created_at:100,deadline_at:400,finalized_at:250},work=[{execution_id:request.requestId,request_digest:identity,scope_key:scope,step_key:'named-claim',receipt_key:'named-claim',generation:1,committed_at:150}],entry={requestId:request.requestId,status:424};
 const before=JSON.stringify({request,row,work,entry});assert.equal(terminalPredecessorMetadata(request,row,work,entry),'FAILURE');assert.equal(JSON.stringify({request,row,work,entry}),before);assert.equal(row.tenant_proof,undefined);
 for(const change of [{state:'ESTABLISHED'},{canonical_request_json:'{}'},{result_digest:'0'.repeat(64)},{identity_digest:'0'.repeat(64)},{scope_key:'foreign'},{config_proof:'foreign'},{finalized_at:401}])assert.throws(()=>terminalPredecessorMetadata(request,{...row,...change},work,entry));
 assert.throws(()=>terminalPredecessorMetadata(request,row,[],entry));assert.throws(()=>terminalPredecessorMetadata(request,row,[{...work[0],generation:2}],entry));assert.throws(()=>terminalPredecessorMetadata(request,row,work,{...entry,status:200}));
});
