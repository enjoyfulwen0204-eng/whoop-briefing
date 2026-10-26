import test from 'node:test';
import assert from 'node:assert/strict';
import {observeContextAndWorkOwner} from '../src/phase4ReadControls.js';
import {withDurableExecution} from '../src/phase4ExecutionContext.js';
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
function fixture(){
 const request={requestId:'synthetic-owner',releaseSha:'a'.repeat(40),phase:'STAGE6_DRAIN',triggerSource:'manual',executionMode:'SHADOW',configProof:'synthetic-only'};
 const claim={request,executionId:request.requestId,owner:'synthetic',generation:1,identity:'synthetic-identity',scopeKey:'synthetic-scope'};
 const row={execution_id:request.requestId,identity_digest:claim.identity,scope_key:claim.scopeKey,
  canonical_request_json:JSON.stringify(Object.fromEntries(Object.keys(request).sort().map(k=>[k,request[k]]))),
  release_sha:request.releaseSha,phase:request.phase,trigger_source:request.triggerSource,execution_mode:'SHADOW',config_proof:request.configProof,sync_execution_id:null};
 const state=deferred(),owner=deferred(),calls=[];
 const execution={claim,pending:new Set(),authority:{assert(){calls.push('authority');}}};
 const core={client:{execute:()=>{calls.push('owner');return owner.promise;}},assertContext:()=>{calls.push('context');return state.promise;}};
 return {row,state,owner,calls,execution,core,run:(options)=>withDurableExecution(execution,()=>observeContextAndWorkOwner(core,{},options))};
}
test('independent context and owner metadata start together and all settle before original owner is returned',async()=>{
 const f=fixture();let settled=false;const value=f.run().then(x=>{settled=true;return x;});await Promise.resolve();
 assert.ok(f.calls.includes('context'));assert.ok(f.calls.includes('owner'));
 f.owner.resolve({rows:[f.row]});await Promise.resolve();await Promise.resolve();assert.equal(settled,false);
 f.state.resolve({state:{}});assert.equal(await value,f.row);
 assert.equal(f.calls.filter(x=>x==='owner').length,1);assert.equal(f.calls.filter(x=>x==='context').length,1);
});
for(const ownerFirst of [false,true])test('opposite completion order retains original '+(ownerFirst?'owner':'context')+' failure priority',async()=>{
 const f=fixture(),contextError=Error('CONTEXT_REVOKED'),ownerError=Error('OWNER_SQL_FAILURE'),value=f.run({ownerFirst});
 await Promise.resolve();
 if(ownerFirst){f.state.reject(contextError);await Promise.resolve();f.owner.reject(ownerError);}
 else{f.owner.reject(ownerError);await Promise.resolve();f.state.reject(contextError);}
 await assert.rejects(value,e=>e===(ownerFirst?ownerError:contextError));
 assert.equal(f.calls.filter(x=>x==='owner').length,1);assert.equal(f.calls.filter(x=>x==='context').length,1);
});
test('synchronous authority cancellation still settles context and emits no owner SQL',async()=>{
 const f=fixture(),error=Error('CANCELLED');f.execution.authority.assert=()=>{throw error;};
 let settled=false;const value=f.run().finally(()=>{settled=true;});value.catch(()=>{});await Promise.resolve();await Promise.resolve();
 assert.equal(settled,false);assert.ok(f.calls.includes('context'));assert.ok(!f.calls.includes('owner'));
 f.state.resolve({});await assert.rejects(value,e=>e===error);
});
test('each invocation obtains a new owner row; a prior successful observation cannot mask revocation',async()=>{
 const f=fixture();f.owner.resolve({rows:[f.row]});f.state.resolve({});assert.equal(await f.run(),f.row);
 f.core.client.execute=async()=>{f.calls.push('owner');return {rows:[]};};
 await assert.rejects(f.run(),/REQUEST_OWNER_FENCED/);assert.equal(f.calls.filter(x=>x==='owner').length,2);
});
