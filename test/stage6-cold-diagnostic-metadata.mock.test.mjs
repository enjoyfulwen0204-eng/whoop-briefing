import test from 'node:test';import assert from 'node:assert/strict';
import {diagnosticRecord,createDiagnosticPublisher,MAX_NATIVE_RECORDS,SETTLEMENT_RESERVE_MS}from './stage6-cold-diagnostic-metadata.proposal.mjs';
import {runDiagnosticEntry}from './stage6-native-cold-entry.proposal.mjs';
const payload=()=>({stage:'APP_FAILURE',callIntents:2,failureCode:'ERR_ASSERTION',errorMessageSha256:'a'.repeat(64),terminalComplete:false,activeFetches:1,unresolvedStreams:1,unknownProtocolReplies:0});
test('typed diagnostics expose observed intents and hash only; no authority or owner-settlement claim',()=>{
 const records=[],publish=createDiagnosticPublisher({phase:'A',elapsedMs:()=>100,writeExclusive:(name,row)=>records.push({name,row})});const row=publish(payload());
 assert.equal(row.callIntents,2);assert.equal(row.failureCode,'ERR_ASSERTION');assert.equal(records[0].name,'A-progress-01.private.json');assert.equal(SETTLEMENT_RESERVE_MS,15000);
 for(const key of ['message','health','keys','executionAuthorized','actualNativeQualified','ownerSettled'])assert.equal(Object.hasOwn(row,key),false);
});
test('unknown stages, messages, nonfinite numbers, extra phase and getters fail before diagnostic write',()=>{
 let writes=0,getters=0;const publish=createDiagnosticPublisher({phase:'B',elapsedMs:()=>100,writeExclusive:()=>writes++});
 for(const change of [{stage:'SYNTHETIC_PRIVATE_CANARY'},{failureCode:'SYNTHETIC_PRIVATE_CANARY'},{errorMessageSha256:'SYNTHETIC_PRIVATE_CANARY'},{callIntents:4},{callIntents:true},{activeFetches:Infinity},{phase:'A'},{message:'SYNTHETIC_PRIVATE_CANARY'}])assert.throws(()=>publish({...payload(),...change}));
 const row=payload();Object.defineProperty(row,'failureCode',{enumerable:true,get(){getters++;return 'ERR_ASSERTION';}});assert.throws(()=>publish(row));assert.equal(writes,0);assert.equal(getters,0);
});
test('diagnostic sequence is finite and consumed on write failure, without retries',()=>{
 let attempts=0;const names=[];const publish=createDiagnosticPublisher({phase:'A',elapsedMs:()=>1,writeExclusive:name=>{names.push(name);if(++attempts===1)throw Error('SYNTHETIC_WRITE_FAILURE');}});
 assert.throws(()=>publish(payload()));for(let n=1;n<MAX_NATIVE_RECORDS;n++)publish(payload());assert.throws(()=>publish(payload()),/FINITE_DIAGNOSTIC_RECORD_LIMIT/);
 assert.equal(attempts,23);assert.equal(names[0],'A-progress-01.private.json');assert.equal(names.at(-1),'A-progress-23.private.json');
});
test('terminal metadata remains nullable and cannot include raw object-valued data',()=>{
 const input={phase:'A',elapsedMs:0,...payload(),terminalComplete:null,activeFetches:null,unresolvedStreams:null,unknownProtocolReplies:null};assert.equal(diagnosticRecord(input).terminalComplete,null);
 for(const terminalComplete of [0,'true',{},undefined])assert.throws(()=>diagnosticRecord({...input,terminalComplete}));
});

test('same-process entry publishes bootstrap before application import and hashes rejection with UNKNOWN state',async()=>{
 const records=[];let entered=false;const state=await runDiagnosticEntry({phase:'B',writeRecord:(n,row)=>records.push({n,row}),importApplication:async()=>{entered=true;assert.equal(records[0].row.stage,'APP_IMPORT_ENTER');throw Object.assign(Error('SYNTHETIC_PRIVATE_CANARY'),{code:'SYNTHETIC_PRIVATE_CANARY'});}});
 assert.equal(entered,true);assert.equal(state,'MODULE_REJECTED');assert.deepEqual(records.map(x=>x.n),[0,24]);const failure=records[1].row;assert.equal(failure.callIntents,null);assert.equal(failure.terminalComplete,null);assert.equal(failure.failureCode,'NATIVE_COLD_PROOF_REFUSED');assert.match(failure.errorMessageSha256,/^[a-f0-9]{64}$/);assert.equal(JSON.stringify(records).includes('SYNTHETIC_PRIVATE_CANARY'),false);
});
test('entry diagnostic write failure neither retries import nor turns module evaluation into qualification',async()=>{
 let calls=0,writes=0;const state=await runDiagnosticEntry({phase:'A',writeRecord:()=>{writes++;throw Error('SYNTHETIC_WRITE_REFUSAL');},importApplication:async()=>{calls++;}});assert.equal(state,'MODULE_EVALUATED');assert.equal(calls,1);assert.equal(writes,1);
});
