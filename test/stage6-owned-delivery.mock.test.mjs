/** Pure owned-delivery regressions. No DB/native/provider/network/CI invocation. */
import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import {readFileSync} from 'node:fs';
import {createDiagnosticFetch} from './stage6-cold-three-observer.proposal.mjs';
const error=()=>Object.assign(Error('SYNTHETIC_PRIVATE_CANARY'),{code:'SYNC_TIMEOUT'});
const req=(sql='SELECT 1',signal,baton=null)=>new Request('http://127.0.0.1:18080/v2/pipeline',{method:'POST',signal,body:JSON.stringify({baton,requests:[{type:'execute',stmt:{sql,args:[]}}]})});
const reply=(baton=null,type='execute')=>new Response(JSON.stringify({baton,results:[{type:'ok',response:{type,result:{}}}]}));
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const make=options=>createDiagnosticFetch({decodePipelineReply:x=>x,onFailureSettlementRevoked:()=>{},...options});
test('default115ms wait abort has owned NOT_SENT proof without changing original unknown reply or error',async()=>{
 const abort=new AbortController(),failure=error();let invoked=0,classification;
 const t=make({latencyEnabled:()=>{queueMicrotask(()=>abort.abort(failure));return true;},fetch:async()=>{invoked++;return reply();},onFetchSettled:(_token,_failed,_error,delivery)=>classification=delivery});
 await assert.rejects(t.fetch(req('SELECT 1',abort.signal)),caught=>caught===failure);assert.equal(invoked,0);assert.equal(classification,'NOT_SENT');
 const s=t.snapshot();assert.equal(s.adapter.delivery.notSent,1);assert.equal(s.allRepliesKnown,false);assert.equal(s.adapter.terminalComplete,false);assert.equal(s.bins.UNKNOWN.requestErrors,1);assert.equal(s.bins.UNKNOWN.unknownReplies,1);
 const token=t.proveFailedTransportSettlement();assert.ok(token);assert.equal(t.consumeFailedTransportSettlement({}),false);assert.equal(t.consumeFailedTransportSettlement(structuredClone(token)),false);assert.equal(t.consumeFailedTransportSettlement(token),true);assert.equal(t.consumeFailedTransportSettlement(token),false);
});
test('fetch-called rejection and abort-at-call race are UNKNOWN even with zero replies or no presumed send',async()=>{
 for(const mode of ['throw','abort']){
  const abort=new AbortController(),failure=error();let called=0;const t=make({fetch:()=>{called++;if(mode==='abort')abort.abort(failure);throw failure;}});
  await assert.rejects(t.fetch(req('SELECT 1',abort.signal)),caught=>caught===failure);assert.equal(called,1);assert.equal(t.snapshot().adapter.delivery.unknown,1);assert.equal(t.snapshot().adapter.delivery.notSent,0);assert.equal(t.proveFailedTransportSettlement(),null);
 }
});
test('only original decoded SENT_REPLY settles; pending, malformed, HTTP error and custom wait/observer refuse',async()=>{
 const gate=deferred(),entered=deferred(),t=make({fetch:async()=>{entered.resolve();return gate.promise;}}),work=t.fetch(req());await entered.promise;assert.equal(t.proveFailedTransportSettlement(),null);gate.resolve(reply());await work;
 assert.equal(t.snapshot().adapter.delivery.sentReply,1);assert.ok(t.proveFailedTransportSettlement());
 for(const options of [{fetch:async()=>new Response('invalid')},{fetch:async()=>new Response('{}',{status:500})},{fetch:async()=>reply(),wait:async()=>{},latencyEnabled:()=>true},{fetch:async()=>reply(),observer:t.observer}]){
  const other=make(options);await other.fetch(req());assert.equal(other.proveFailedTransportSettlement(),null);
 }
});
test('retained stream or acknowledged transaction blocks failure proof; explicit original close can settle an idle stream',async()=>{
 let next=reply('owned-idle');const t=make({fetch:async()=>next});await t.fetch(req());assert.equal(t.proveFailedTransportSettlement(),null);
 next=reply(null,'close');await t.fetch(new Request('http://127.0.0.1:18080/v2/pipeline',{method:'POST',body:JSON.stringify({baton:'owned-idle',requests:[{type:'close'}]})}));assert.ok(t.proveFailedTransportSettlement());
 const abort=new AbortController(),failure=error();let latency=false;const active=make({latencyEnabled:()=>{if(latency){queueMicrotask(()=>abort.abort(failure));return true;}return false;},fetch:async()=>reply('owned-tx')});
 await active.fetch(req('BEGIN IMMEDIATE'));latency=true;await assert.rejects(active.fetch(req('SELECT 1',abort.signal,'owned-tx')));assert.equal(active.snapshot().adapter.delivery.notSent,1);assert.equal(active.snapshot().allTransactionTerminalsKnown,false);assert.equal(active.proveFailedTransportSettlement(),null);
});
test('proof identity, epoch and late entry revoke a reserved failure exit; native gate never changes report or normal result',async()=>{
 const native=readFileSync(new URL('./stage6-native-cold-progress.mjs',import.meta.url),'utf8'),owner={exitCode:2},report={failure:{code:'NATIVE_COLD_PROOF_REFUSED'},status:'CLEANUP_OR_GLOBAL_DEADLINE_UNKNOWN',elapsedMs:197000};
 const callback=/onFailureSettlementRevoked:(\(\)=>\{if\(process.exitCode===3\)process.exitCode=2;\})/.exec(native);assert.ok(callback);
 const revoke=vm.runInNewContext('('+callback[1]+')',{process:owner});const t=make({fetch:async()=>reply(),onFailureSettlementRevoked:revoke});await t.fetch(req());
 const stale=t.proveFailedTransportSettlement();await t.fetch(req());assert.equal(t.consumeFailedTransportSettlement(stale),false);
 const other=make({fetch:async()=>reply()});await other.fetch(req());assert.equal(other.consumeFailedTransportSettlement(t.proveFailedTransportSettlement()),false);
 const line=native.split('\n').find(line=>line.startsWith(' if(report.failure&&process.exitCode===2'));assert.ok(line);const before=structuredClone(report);vm.runInNewContext(line,{report,process:owner,PROFILE:{proposedOuterMs:300000},transport:t});assert.equal(owner.exitCode,3);assert.deepEqual(report,before);
 const late=t.fetch(req());assert.equal(owner.exitCode,2);await late;
 owner.exitCode=0;vm.runInNewContext(line,{report,process:owner,PROFILE:{proposedOuterMs:300000},transport:t});assert.equal(owner.exitCode,0);
});
test('owner-bound coverage loss is sticky; more than128 pending request owners cannot mint a settlement proof',async()=>{
 const gates=Array.from({length:129},deferred);let called=0;const allEntered=deferred(),t=make({fetch:async()=>{const index=called++;if(called===129)allEntered.resolve();return gates[index].promise;}});
 const work=Array.from({length:129},()=>t.fetch(req()));await allEntered.promise;assert.equal(t.snapshot().adapter.delivery.coverageComplete,false);assert.equal(t.proveFailedTransportSettlement(),null);for(const gate of gates)gate.resolve(reply());await Promise.all(work);assert.equal(t.snapshot().adapter.delivery.coverageComplete,false);assert.equal(t.proveFailedTransportSettlement(),null);
});
test('source preserves original conservative reply/ACK computation and adds no retry, statement or shortened latency',()=>{
 const source=readFileSync(new URL('./stage6-cold-three-observer.proposal.mjs',import.meta.url),'utf8');assert.ok(source.includes('await wait(115,request.signal)'));assert.ok(source.indexOf("callStage='CALLED'")<source.indexOf('const response=await fetch(request)'));
 assert.ok(source.includes('requestError:true,successMask:[]'));assert.ok(!source.includes('allRepliesKnown='));assert.ok(source.includes('attribution.physicalTerminalObservationComplete'));assert.ok(!source.includes('setInterval'));
});
