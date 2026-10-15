import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {parentRequestBody, phaseHttpBody} from './stage6SyntheticControllerContract.mjs';

test('HTTP controller preserves original phase status/body for success, retry and rejection',async()=>{
 const server=createServer((req,res)=>{const status=Number(req.url.slice(1)),out={status,body:{ok:status===200,result:{resumable:status===202},error:status>=400?'REJECTED':null}};res.writeHead(out.status,{'content-type':'application/json'}).end(phaseHttpBody(out));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));try{for(const status of [200,202,409,424,503]){const r=await fetch('http://127.0.0.1:'+server.address().port+'/'+status);assert.equal(r.status,status);const body=await r.json();assert.equal(body.ok,status===200);assert.equal(body.status,undefined);assert.equal(body.result.resumable,status===202);}}finally{await new Promise(r=>server.close(r));}
});
test('canonical parent bytes survive sorted durable request storage and process restart',()=>{
 const req={requestId:'synthetic',releaseSha:'a'.repeat(40),phase:'SYNC',triggerSource:'manual',executionMode:'SHADOW',configProof:'b'.repeat(64)},body=parentRequestBody(req),restart=JSON.parse(body);
 assert.notEqual(JSON.stringify(req),JSON.stringify(restart));assert.equal(parentRequestBody(restart),body);const hash=x=>createHash('sha256').update(x).digest('hex');assert.equal(hash(parentRequestBody(restart)),hash(body));assert.notEqual(hash(JSON.stringify(req)),hash(body));
});
test('malformed phase wrappers cannot be emitted as HTTP success',()=>{for(const value of [null,{}, {status:200},{status:0,body:{}},{status:'200',body:{}}])assert.throws(()=>phaseHttpBody(value));});
