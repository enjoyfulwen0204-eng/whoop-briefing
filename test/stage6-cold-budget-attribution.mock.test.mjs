/** Pure synthetic source tests: no native DB, network, application entry or CI. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {createExecutionBudget,currentExecutionBudget,withExecutionBudget,ExecutionBudgetError} from '../src/executionBudget.js';
import {createAttribution} from './stage6-cold-three-attribution.proposal.mjs';
import {createDiagnosticFetch} from './stage6-cold-three-observer.proposal.mjs';
import {createFetchBudgetProbe,budgetAttributionRecord,typedDiagnosticCode,BUDGET_ATTRIBUTION_MAX_BYTES} from './stage6-cold-budget-attribution.proposal.mjs';
const CANDIDATE='a'.repeat(40),HASH='b'.repeat(64),CANARY='SYNTHETIC_PRIVATE_CANARY';
const request=sql=>new Request('http://127.0.0.1:18080/v3/pipeline',{method:'POST',body:JSON.stringify({requests:[{type:'execute',stmt:{sql,args:[]}}]})});
const reply=()=>new Response(JSON.stringify({baton:null,results:[{type:'ok',response:{type:'execute',result:{}}}]}),{status:200});
function fixture(){
 let time=0,outer=300000;
 const probe=createFetchBudgetProbe({getBudget:currentExecutionBudget,elapsedMs:()=>time,clocks:()=>({workRemainingMs:Math.max(0,outer-15000),outerRemainingMs:Math.max(0,outer)})});
 probe.notePhase('GENUINE_ORIGINAL_PRODUCER_CALL',3);
 return {probe,get time(){return time;},set time(value){time=value;},set outer(value){outer=value;}};
}
function record(observer,probe){return budgetAttributionRecord({candidateSha:CANDIDATE,phase:'B',stage:'APP_FAILURE',callIntents:3,elapsedMs:197000,failureCode:'NATIVE_COLD_PROOF_REFUSED',errorMessageSha256:HASH,error:Object.assign(Error(CANARY),{code:'SYNC_TIMEOUT'}),attribution:observer.snapshot(),budgetObservations:probe.snapshot()});}
test('real ALS budget captured before first await and bound to its own45s/5s failed request',async()=>{
 const f=fixture(),observer=createAttribution({now:()=>f.time});observer.setPhase('GENUINE_ORIGINAL_PRODUCER_CALL','ORIGINAL_PRODUCER_RUN',3);
 for(const [width,sql,category] of [[45000,"SELECT * FROM whoop_sleeps WHERE user_id='SYNTHETIC_PRIVATE_CANARY'",'SOURCE_DATA'],[5000,'DELETE FROM resource_locks WHERE name=? AND owner=?','CONTEXT_LEASE_RELEASE']]){
  f.time=0;const abort=new AbortController(),budget=createExecutionBudget({budgetMs:width,nowMs:()=>f.time,startedAtMs:0,signal:abort.signal});
  const failure=new ExecutionBudgetError();failure.privateMessage=CANARY;
  const transport=createDiagnosticFetch({observer,decodePipelineReply:x=>x,onFetchEntry:f.probe.captureEntry,onFetchSettled:f.probe.settle,now:()=>f.time,fetch:async()=>{f.time=width+1;abort.abort(failure);throw failure;}});
  try{
   const pending=withExecutionBudget(budget,()=>transport.fetch(request(sql)));
   assert.equal(f.probe.snapshot().recentEntries.at(-1).widthMs,width,'capture must precede body/transport awaits');
   await assert.rejects(pending,error=>error===failure);
   const last=f.probe.snapshot().recentEntries.at(-1);assert.equal(last.widthMs,width);assert.equal(last.remainingMs,width);assert.equal(last.remainingMsAtSettlement,0);assert.equal(last.signalAbortedAtSettlement,true);assert.equal(last.typedErrorCode,'SYNC_TIMEOUT');assert.equal(last.requestError,true);
   assert.equal(observer.snapshot().bins.GENUINE_ORIGINAL_PRODUCER_CALL.categories[category].submitted,1);
  }finally{budget.cancel();budget.close();}
 }
 const projected=record(observer,f.probe);assert.equal(projected.fetchBudgets.widthBins.find(x=>x.widthBucket==='MS_45000').requestErrors,1);assert.equal(projected.fetchBudgets.widthBins.find(x=>x.widthBucket==='MS_5000').requestErrors,1);
 assert.equal(projected.phaseBins.find(x=>x.phase==='GENUINE_ORIGINAL_PRODUCER_CALL').requestErrors,2);assert.ok(!JSON.stringify(projected).includes(CANARY));assert.ok(!JSON.stringify(projected).includes('DELETE FROM'));
});
test('outer remaining clock is an observation and never changes budget, work or transport',async()=>{
 const f=fixture();f.outer=10000;const budget=createExecutionBudget({budgetMs:5000,nowMs:()=>0,startedAtMs:0});
 const observer=createAttribution(),transport=createDiagnosticFetch({observer,decodePipelineReply:x=>x,onFetchEntry:f.probe.captureEntry,onFetchSettled:f.probe.settle,fetch:async()=>reply()});
 try{await withExecutionBudget(budget,()=>transport.fetch(request('SELECT 1')));const row=f.probe.snapshot().recentEntries[0];assert.equal(row.workRemainingMs,0);assert.equal(row.outerRemainingMs,10000);assert.equal(row.widthMs,5000);assert.equal(row.requestError,false);assert.equal(budget.remainingMs(),5000);}finally{budget.cancel();budget.close();}
});
test('hook failure cannot replace the exact original transport error or successful response',async()=>{
 const error=Object.assign(Error(CANARY),{code:'SYNC_TIMEOUT'}),hooks={onFetchEntry:()=>{throw Error(CANARY);},onFetchSettled:()=>{throw Error(CANARY);}};
 const fail=createDiagnosticFetch({...hooks,decodePipelineReply:x=>x,fetch:async()=>{throw error;}});await assert.rejects(fail.fetch(request('SELECT 1')),caught=>caught===error);
 const response=reply(),success=createDiagnosticFetch({...hooks,decodePipelineReply:x=>x,fetch:async()=>response});assert.equal(await success.fetch(request('SELECT 1')),response);
});
test('negative canaries/getters/nonfinite fields never serialize and missing observations stay null',()=>{
 let getters=0;const hostile={secret:CANARY};for(const key of ['startedAt','deadlineAt','remainingMs','signal'])Object.defineProperty(hostile,key,{get(){getters++;return CANARY;}});
 const probe=createFetchBudgetProbe({getBudget:()=>hostile,elapsedMs:()=>1,clocks:()=>({workRemainingMs:NaN,outerRemainingMs:Infinity})});probe.notePhase(CANARY,99);const token=probe.captureEntry();const error={message:CANARY};Object.defineProperty(error,'code',{get(){getters++;return CANARY;}});Object.defineProperty(error,'stack',{get(){getters++;return CANARY;}});probe.settle(token,true,error);
 const attribution={bins:{},adapter:{rawSql:CANARY}};Object.defineProperty(attribution,'health',{get(){getters++;return CANARY;}});
 const output=budgetAttributionRecord({candidateSha:CANARY,phase:CANARY,stage:CANARY,callIntents:false,elapsedMs:NaN,failureCode:CANARY,errorMessageSha256:CANARY,error,attribution,budgetObservations:probe.snapshot()});
 assert.equal(getters,0);assert.ok(!JSON.stringify(output).includes(CANARY));assert.equal(output.candidateSha,null);assert.equal(output.callIntents,null);assert.equal(output.adapter.activeFetches,null);assert.equal(output.fetchBudgets.recentEntries[0].widthMs,null);assert.equal(output.fetchBudgets.recentEntries[0].signalAborted,null);assert.equal(output.safeFrames.length,0);assert.equal(output.coverage.pendingAcknowledgedBegins,null);
 const framed=budgetAttributionRecord({candidateSha:CANDIDATE,phase:'B',stage:'APP_FAILURE',error:{code:'SYNC_TIMEOUT',stack:'Error: '+CANARY+'\n at /synthetic/'+CANARY+'/src/processingTransaction.js:441:9'}});assert.deepEqual(framed.safeFrames,[{sourceBasename:'processingTransaction.js',line:441}]);assert.ok(!JSON.stringify(framed).includes(CANARY));
});
test('probe retains bounded128 request owners and last8 observations with explicit dropped coverage',()=>{
 const f=fixture(),tokens=[];for(let i=0;i<200;i++)tokens.push(f.probe.captureEntry());const snapshot=f.probe.snapshot();assert.equal(snapshot.captures,200);assert.equal(snapshot.inflight,128);assert.equal(snapshot.droppedCaptures,72);assert.equal(snapshot.recentEntries.length,8);assert.equal(snapshot.recentEvictions,120);
 for(const token of tokens)f.probe.settle(token,false,null);assert.equal(f.probe.snapshot().inflight,0);assert.equal(f.probe.snapshot().widthBins.find(x=>x.widthBucket==='NONE').settled,128);
 const output=record(createAttribution(),f.probe);assert.ok(Buffer.byteLength(JSON.stringify(output))<=BUDGET_ATTRIBUTION_MAX_BYTES);
 const maximum=createAttribution().snapshot();for(const bin of Object.values(maximum.bins)){for(const key of Object.keys(bin))if(typeof bin[key]==='number')bin[key]=999999999;for(const row of Object.values(bin.categories)){row.submitted=999999999;row.executed=999999999;}for(const key of Object.keys(bin.transactions))bin.transactions[key]=999999999;}
 const full=record({snapshot:()=>maximum},f.probe);assert.ok(Buffer.byteLength(JSON.stringify(full))<=BUDGET_ATTRIBUTION_MAX_BYTES);
});
test('source-derived writer captures A metadata-ready and B failure before cleanup without hiding errors',()=>{
 const source=readFileSync(new URL('./stage6-native-cold-progress.mjs',import.meta.url),'utf8'),start=source.indexOf('function attributionSnapshot('),end=source.indexOf('\n// Diagnostic writes',start);assert.ok(start>0&&end>start);
 const body=source.slice(start,end),report={failure:{code:'NATIVE_COLD_PROOF_REFUSED',messageSha256:HASH}},events=[],observer=createAttribution();observer.setPhase('GENUINE_ORIGINAL_PRODUCER_CALL','ORIGINAL_PRODUCER_RUN',3);const f=fixture();let data='';
 const context={assert,Buffer,report,phase:'B',callCount:3,candidateSha:CANDIDATE,now:()=>197000,started:0,OUT:'/synthetic-output',budgetAttributionRecord,typedDiagnosticCode,BUDGET_ATTRIBUTION_MAX_BYTES,fetchBudgets:f.probe,transport:{observer,snapshot:()=>{events.push('SNAPSHOT');return {...observer.snapshot(),adapter:{}};}},openSync:()=>{events.push('OPEN');return 1;},writeSync:(_fd,bytes)=>{events.push('WRITE');data=bytes.toString();},fsyncSync:()=>events.push('FSYNC'),closeSync:()=>events.push('CLOSE')};
 const fn=vm.runInNewContext('('+body+')',context);fn('APP_FAILURE',report.failure,Object.assign(Error(CANARY),{code:'SYNC_TIMEOUT'}));events.push('DB_CLOSE');assert.equal(events[0],'SNAPSHOT');assert.ok(events.indexOf('WRITE')<events.indexOf('DB_CLOSE'));assert.ok(!data.includes(CANARY));assert.equal(JSON.parse(data).phaseBins.find(x=>x.phase==='GENUINE_ORIGINAL_PRODUCER_CALL').lastTypedCode,'SYNC_TIMEOUT');
 assert.ok(source.indexOf("attributionSnapshot('APP_FAILURE',report.failure,error);")<source.indexOf("progress('DB_CLOSE_ENTER')"));
 context.phase='A';context.callCount=2;fn('LEG_METADATA_READY');const control=JSON.parse(data);assert.equal(control.phase,'A');assert.equal(control.stage,'LEG_METADATA_READY');assert.equal(control.failureCode,null);assert.equal(control.errorMessageSha256,null);
 context.openSync=()=>{throw Error(CANARY);};const refused=vm.runInNewContext('('+body+')',context);assert.doesNotThrow(()=>refused('APP_FAILURE',report.failure,Object.assign(Error(CANARY),{code:'SYNC_TIMEOUT'})));assert.equal(report.failure.messageSha256,HASH);
});
test('request hooks are synchronous source additions without an extra await or altered core observer statements',()=>{
 const source=readFileSync(new URL('./stage6-cold-three-observer.proposal.mjs',import.meta.url),'utf8');assert.ok(source.indexOf('budgetToken=onFetchEntry()')<source.indexOf('await request.clone().text()'));assert.ok(source.includes('onFetchSettled(budgetToken,diagnosticFailed,diagnosticError)'));assert.ok(!source.includes('await onFetch'));
 const native=readFileSync(new URL('./stage6-native-cold-progress.mjs',import.meta.url),'utf8');assert.ok(native.includes('getBudget:currentExecutionBudget'));assert.ok(native.includes('onFetchEntry:fetchBudgets.captureEntry,onFetchSettled:fetchBudgets.settle'));assert.ok(native.includes('Math.floor(workDeadlineMs-now())'));
});
