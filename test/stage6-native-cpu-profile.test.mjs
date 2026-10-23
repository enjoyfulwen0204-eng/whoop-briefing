import test from 'node:test';import assert from 'node:assert/strict';
import {summarizeCpuProfile,profileCpuWork,createCpuDiagnosticStats} from './stage6-native-cpu-profile.mjs';
import {readFile} from 'node:fs/promises';
import {transformCpuDiagnostic} from './stage6-native-first17-cpu-loader.mjs';
import {validateDiagnostic,validateLeg,projectFailure,projectTerminal} from '../tools/stage8-qualification/first17-cpu-supervisor.mjs';
const node=(id,url,functionName,lineNumber=0)=>({id,callFrame:{url,functionName,lineNumber}});
test('closed CPU projection retains finite aggregates and drops source directories',()=>{
 const r=summarizeCpuProfile({nodes:[node(1,'file:///private/secret/src/a.js','f'),node(2,'','(idle)')],samples:[1,2,1],timeDeltas:[1000,2000,1000]});
 assert.equal(r.sampledMs,4);assert.equal(r.sampleCount,3);assert.equal(r.rawProfilePersisted,false);assert.ok(!JSON.stringify(r).includes('/private/'));assert.equal(r.top20.length,2);
});
test('unknown names, URLs and positions cannot export arbitrary private strings',()=>{
 const r=summarizeCpuProfile({nodes:[node(1,'private/?token=secret','secret/user-data',Infinity)],samples:[1],timeDeltas:[1000]});
 assert.deepEqual(r.top20[0],{file:'V8_OR_OTHER',fn:'OTHER',line:0,sampledMs:1,percent:100});
});
test('invalid, oversized, missing-node or nonfinite profiles fail closed',()=>{
 for(const p of [null,{}, {nodes:[],samples:[1],timeDeltas:[1]}, {nodes:[node(1,'','')],samples:[1],timeDeltas:[NaN]}, {nodes:[],samples:[],timeDeltas:[1]}, {nodes:new Array(100001),samples:[],timeDeltas:[]}])assert.throws(()=>summarizeCpuProfile(p));
});
test('work runs once and sampling never grants qualification',async()=>{
 let calls=0;const r=await profileCpuWork(async()=>{calls++;for(let i=0;i<1000;i++)Math.sqrt(i);return 3;});assert.equal(calls,1);assert.equal(r.result,3);assert.equal(r.profile.qualification,false);assert.equal(r.profile.setupIncluded,false);
});
test('original work failure survives profiler cleanup and is not retried',async()=>{
 const error=Error('original');let calls=0;await assert.rejects(()=>profileCpuWork(async()=>{calls++;throw error;}),e=>e===error);assert.equal(calls,1);
});
test('owned counters retain closed labels and propagate original errors',async()=>{
 const s=createCpuDiagnosticStats();s.start();s.project(true);s.project(false);const error=Error('original');let calls=0;
 await assert.rejects(()=>s.measure('secret','private',async()=>{calls++;throw error;}),e=>e===error);
 const r=s.finish();assert.equal(calls,1);assert.equal(r.contextLeaseSupportedProjections,1);assert.equal(r.contextLeaseUnsupportedProjections,1);assert.deepEqual(Object.keys(r.ownedWork),['READ_ONLY_OR_OTHER']);assert.ok(!JSON.stringify(r).includes('secret'));
});
test('two pass-through app transforms invert byte-exactly to their pinned original',async()=>{
 const cache=new URL('../src/phase4Cache.js',import.meta.url),queue=new URL('../src/phase4ReanalysisQueue.js',import.meta.url);
 const a=await readFile(cache,'utf8'),b=await readFile(queue,'utf8');
 const extra=`\nexport function projectContextLeaseData(row,at){const r=projectContextLeaseDataOriginal(row,at);globalThis.__stage6CPUStats?.project(r.supported===true);return r;}\n`;
 assert.equal(transformCpuDiagnostic(cache.href,a).replace(extra,'').replace('function projectContextLeaseDataOriginal(row,at){','export function projectContextLeaseData(row,at){'),a);
 const wrapper=`  const owned=(...args)=>{const call=()=>ownedOriginal(...args);return globalThis.__stage6CPUStats?globalThis.__stage6CPUStats.measure(args[3]?.workKind,args[3]?.workFacts?.[0],call):call();};\n`;
 assert.equal(transformCpuDiagnostic(queue.href,b).replace(wrapper,'').replace('const ownedOriginal=','const owned='),b);
});
test('app source mutations and unrecognized URLs cannot receive permissive transforms',async()=>{
 for(const name of ['phase4Cache.js','phase4ReanalysisQueue.js']){
  const u=new URL('../src/'+name,import.meta.url),s=await readFile(u,'utf8');assert.throws(()=>transformCpuDiagnostic(u.href,s+'\n'));
 }
 assert.equal(transformCpuDiagnostic('file:///unrecognized.js','untouched'),'untouched');
});
const fakeLeg=ordinal=>({ordinal,kind:'RETURNED_CANONICAL_PREPARATION',postconditionsNotYetChecked:true,replayed:false,wallMs:1,processedItems:0,unitsCommitted:0,failedJobs:0,
 contextLeaseSupportedProjections:1,contextLeaseUnsupportedProjections:0,ownedWork:{READ_ONLY_OR_OTHER:{calls:1,inclusiveMs:1,maxInclusiveMs:1}},
 cpu:{sampledMs:1,sampleCount:1,wallMs:1,nodeUserCpuMs:1,nodeSystemCpuMs:0,qualification:false,rawProfilePersisted:false,setupIncluded:false,onlyPreparationOrdinal:ordinal,includesOriginalPostSettlementContextCleanup:true,profilingOverheadNotSubtracted:true,top20:[]}});
const fakePacket=()=>({elapsedMs:1,ownedServerExited:true,originalPostconditionsPassed:true,httpRequests:1,statementCount:1,contract:'one-native-first17-cpu-diagnostic-v1',status:'DIAGNOSTIC_FIRST17_COMPLETE_NO_QUALIFICATION',applicationSource:'de262df36aea6199db41405963fb7cf45a0453f4',
 productionEvidence:false,EOFQualified:false,sixJobCompletionQualified:false,capacityQualified:false,rawCpuProfilePersisted:false,setupIncludedInCpuProfile:false,
 profiledOrdinals:Array.from({length:17},(_,i)=>i+1),maxPreparations:17,sourceHealthRows:160,users:1,addedLatencyMs:0,diagnosticLegs:Array.from({length:17},(_,i)=>fakeLeg(i+1)),
 preparationTransactions:{begun:1,committed:1,rolledBack:0,open:0,unknownTerminal:0,atOrAbove5s:1,sumDurationUpperBoundMs:6000,maxDurationUpperBoundMs:6000}});
test('a timing failure may remain diagnostic evidence but cannot qualify EOF',()=>{
 const v=fakePacket();assert.equal(validateDiagnostic(v),true);
 for(const k of ['productionEvidence','EOFQualified','sixJobCompletionQualified','capacityQualified','rawCpuProfilePersisted','setupIncludedInCpuProfile'])assert.throws(()=>validateDiagnostic({...v,[k]:true}));
});
test('ordinal, raw label, missing profile and unbalanced terminal defects are rejected',()=>{
 const v=fakePacket();assert.throws(()=>validateDiagnostic({...v,maxPreparations:18}));assert.throws(()=>validateDiagnostic({...v,diagnosticLegs:v.diagnosticLegs.slice(1)}));
 assert.throws(()=>validateLeg({...fakeLeg(1),cpu:null},0));assert.throws(()=>validateLeg({...fakeLeg(1),ownedWork:{private:{calls:1,inclusiveMs:1,maxInclusiveMs:1}}},0));
 assert.throws(()=>validateDiagnostic({...v,preparationTransactions:{...v.preparationTransactions,open:1}}));
});
test('regex-shaped private canaries are mapped to finite public labels',()=>{
 const r=summarizeCpuProfile({nodes:[node(1,'file:///PRIVATE_CANARY.js','PRIVATE_CANARY',42)],samples:[1],timeDeltas:[1000]});
 assert.deepEqual(r.top20,[{file:'V8_OR_OTHER',fn:'OTHER',line:0,sampledMs:1,percent:100}]);assert.ok(!JSON.stringify(r).includes('PRIVATE_CANARY'));
});
test('unknown keys at every persisted metadata level are rejected',()=>{
 for(const mutate of [v=>v.PRIVATE_CANARY=1,v=>v.diagnosticLegs[0].PRIVATE_CANARY=1,v=>v.diagnosticLegs[0].cpu.PRIVATE_CANARY=1,v=>v.diagnosticLegs[0].ownedWork.READ_ONLY_OR_OTHER.PRIVATE_CANARY=1,v=>v.preparationTransactions.PRIVATE_CANARY=1,v=>v.diagnosticLegs[0].cpu.top20.push({file:'phase4Cache.js',fn:'assertLease',line:1,sampledMs:1,percent:100,PRIVATE_CANARY:1})]){
  const v=fakePacket();mutate(v);assert.throws(()=>validateDiagnostic(v));
 }
 const failed=fakePacket();failed.diagnosticLegs[0].failedJobs=1;assert.doesNotThrow(()=>validateLeg(failed.diagnosticLegs[0],0));assert.throws(()=>validateDiagnostic(failed));
});
test('failure and terminal output are fresh closed projections',()=>{
 const a=projectFailure({stage:'PRIVATE_CANARY',type:'PRIVATE_CANARY',code:'PRIVATE_CANARY',classification:'PRIVATE_CANARY',elapsedMs:1,PRIVATE_CANARY:1,progress:{PRIVATE_CANARY:1,check:'PRIVATE_CANARY',completedPreparations:2}});
 const b=projectTerminal({closed:true,ownedServerExited:true,clientTerminalComplete:true,physicalTerminalObservationComplete:true,retainedStreams:0,PRIVATE_CANARY:1});
 assert.ok(!JSON.stringify([a,b]).includes('PRIVATE_CANARY'));assert.equal(a.progress.completedPreparations,2);assert.equal(a.progress.check,'OTHER');assert.equal(b.closed,true);
});
test('exact-source returned CPU is emitted before replay, worker and setup checks',async()=>{
 const source=await readFile(new URL('./stage6-native-first17-cpu.mjs',import.meta.url),'utf8');
 const a=source.indexOf("  diagnosticLegs.push({ordinal:i+1,kind:'RETURNED_CANONICAL_PREPARATION'"),b=source.indexOf('\n }',a);assert.ok(a>=0&&b>a);const code=source.slice(a,b);
 for(const change of [{replayed:true,jobsFailed:0,now:1},{replayed:false,jobsFailed:1,now:1},{replayed:false,jobsFailed:0,now:240001}]){
  const observations=[],lines=[],profile={marker:'CPU_ONLY'};const result={replayed:change.replayed,result:{itemsProcessed:0,unitsCommitted:0,jobsFailed:change.jobsFailed}};
  const fn=new Function('i','result','profiled','diagnosticLegs','diagnosticAt','globalThis','progress','performance','started','assert','console',code);
  assert.throws(()=>fn(0,result,{profile},observations,0,{__stage6CPUStats:{finish:()=>({})}},{},{now:()=>change.now},0,assert,{log:x=>lines.push(x)}));
  assert.equal(observations.length,1);assert.equal(lines.length,1);assert.equal(observations[0].cpu,profile);assert.equal(observations[0].postconditionsNotYetChecked,true);assert.equal(observations[0].kind,'RETURNED_CANONICAL_PREPARATION');
 }
});
