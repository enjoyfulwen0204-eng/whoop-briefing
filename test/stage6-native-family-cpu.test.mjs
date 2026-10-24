import test from 'node:test';
import assert from 'node:assert/strict';
import {createFamilyCPU,validateFamilyCPU} from './stage6-native-family-cpu.mjs';
import {createWorkCorrelation} from './stage6-native-work-join.mjs';
const owner=Object.freeze({preparationOrdinal:17,workInvocationOrdinal:2,workLabel:'stage6.family:recovery_score'});
const raw=()=>({nodes:[{id:1,callFrame:{url:'file:///src/phase4IntelligenceStore.js',functionName:'analyzeMetric',lineNumber:755}}],samples:[1],timeDeltas:[1000]});
function factory({fault,events=[]}={}){let disconnected=false;return ()=>({connect(){events.push('connect');if(fault==='connect')throw Error('private');},post(method,callback){events.push(method);if(fault===method)return callback(Error('private'));if(fault==='timeout'&&method==='Profiler.start')return;callback(null,method==='Profiler.stop'?{profile:fault==='profile'?{}:raw()}:{});},disconnect(){events.push('disconnect');disconnected=true;if(fault==='disconnect')throw Error('private');}});}
test('only exact immutable owned metadata starts one process-wide profile',async()=>{
 let calls=0,created=0;const events=[],p=createFamilyCPU({sessionFactory:()=>{created++;return factory({events})();}});for(const m of [{...owner,preparationOrdinal:16},{...owner,workInvocationOrdinal:3},{...owner,workLabel:'stage6.family:hrv'}])assert.equal(await p.around(m,()=>++calls),calls);assert.equal(created,0);const value={opaque:'not printed'};assert.equal(await p.around(owner,()=>{calls++;return value;}),value);assert.equal(calls,4);assert.equal(created,1);const s=p.snapshot();assert.equal(s.profileCaptures,1);assert.equal(s.profileFailures,0);assert.equal(s.sessionDisconnected,true);assert.equal(s.profilerDisabled,true);assert.equal(s.profile.top20[0].file,'phase4IntelligenceStore.js');assert.equal(s.physicalTransactionCPUAttribution,false);assert.equal(s.samplingOverheadNotSubtracted,true);assert.ok(!JSON.stringify(s).includes('opaque'));assert.equal(validateFamilyCPU(s),true);
});
test('setup/stop/sanitize/disable/disconnect faults never replace original success',async()=>{
 for(const fault of ['connect','Profiler.enable','Profiler.start','Profiler.stop','Profiler.disable','disconnect','profile']){const p=createFamilyCPU({sessionFactory:factory({fault})});let calls=0;const value={};assert.equal(await p.around(owner,()=>{calls++;return value;}),value);assert.equal(calls,1);assert.ok(p.snapshot().profileFailures>0);}
});
test('original failure identity survives every independent profiler fault',async()=>{
 for(const fault of [undefined,'connect','Profiler.enable','Profiler.start','Profiler.stop','Profiler.disable','disconnect','profile']){const p=createFamilyCPU({sessionFactory:factory({fault})}),error=Error('PRIVATE_ORIGINAL_PAYLOAD');let calls=0;await assert.rejects(()=>p.around(owner,async()=>{calls++;throw error;}),e=>e===error);assert.equal(calls,1);assert.equal(p.snapshot().originalOutcome,'THREW');assert.ok(!JSON.stringify(p.snapshot()).includes('PRIVATE_ORIGINAL_PAYLOAD'));}
});
test('bounded uncertain inspector setup disconnects before calling original once',async()=>{
 const events=[],p=createFamilyCPU({sessionFactory:factory({fault:'timeout',events})});let calls=0;assert.equal(await p.around(owner,()=>{events.push('work');calls++;return 7;}),7);assert.equal(calls,1);assert.ok(events.indexOf('disconnect')<events.indexOf('work'));assert.equal(p.snapshot().profileCaptures,0);assert.ok(p.snapshot().profileFailures>0);assert.equal(p.snapshot().sessionDisconnected,true);
});
test('unknown metadata accessors/proxies cause no getters/traps or sampling',async()=>{
 let gets=0,traps=0,created=0;const p=createFamilyCPU({sessionFactory:()=>{created++;return factory()();}}),m={get preparationOrdinal(){gets++;return 17;}};assert.equal(await p.around(m,()=>3),3);const proxy=new Proxy(owner,{get(){traps++;throw Error('trap');},getOwnPropertyDescriptor(){traps++;throw Error('trap');}});assert.equal(await p.around(proxy,()=>4),4);assert.equal(gets,0);assert.equal(traps,0);assert.equal(created,0);
});
test('closed schema forbids private keys, labels, rawframes and false attribution',async()=>{
 const p=createFamilyCPU({sessionFactory:factory()});await p.around(owner,()=>1);const v=p.snapshot();for(const change of [x=>x.PRIVATE=1,x=>x.target.PRIVATE=1,x=>x.profile.PRIVATE=1,x=>x.profile.top20[0].file='/private/user',x=>x.profile.top20[0].fn='PRIVATE',x=>x.profile.top20[0].line=Infinity,x=>x.physicalTransactionCPUAttribution=true,x=>x.profile.rawProfilePersisted=true,x=>x.profile.sourceTotalsMs.PRIVATE=1,x=>x.profile.sampleCount=200001]){const x=structuredClone(v);change(x);assert.throws(()=>validateFamilyCPU(x));}
});
test('unknown profile frame text is never persisted',async()=>{
 const session=factory()();const post=session.post;session.post=(method,cb)=>method==='Profiler.stop'?cb(null,{profile:{nodes:[{id:1,callFrame:{url:'file:///private/PRIVATE_CANARY.js',functionName:'PRIVATE_CANARY',lineNumber:5}}],samples:[1],timeDeltas:[1000]}}):post(method,cb);const p=createFamilyCPU({sessionFactory:()=>session});await p.around(owner,()=>1);assert.ok(!JSON.stringify(p.snapshot()).includes('PRIVATE_CANARY'));assert.deepEqual(p.snapshot().profile.top20[0],{file:'V8_OR_OTHER',fn:'OTHER',line:0,sampledMs:1,percent:100});
});
test('sink failure and repeated target do not suppress or replay original calls',async()=>{
 let calls=0;const p=createFamilyCPU({sessionFactory:factory(),emit(){throw Error('sink');}});assert.equal(await p.around(owner,()=>++calls),1);assert.equal(await p.around(owner,()=>++calls),2);assert.equal(calls,2);assert.equal(p.snapshot().targetCalls,2);assert.equal(p.snapshot().profileCaptures,1);assert.equal(p.snapshot().droppedReports,1);
});
test('profile emits on original failure before caller cleanup can remain unresolved',async()=>{
 const packets=[],p=createFamilyCPU({sessionFactory:factory(),emit:v=>packets.push(v)}),e=Error('original');await assert.rejects(()=>p.around(owner,()=>{throw e;}),x=>x===e);assert.equal(packets.length,1);assert.equal(packets[0].originalOutcome,'THREW');assert.equal(packets[0].profileCaptures,1);assert.equal(packets[0].sessionDisconnected,true);
});
test('work correlation captures exact target and default scope preserves original returns',async()=>{
 const p=createFamilyCPU({sessionFactory:factory()}),c=createWorkCorrelation({around:p.around});await c.preparation(17,async()=>{assert.equal(await c.owned({workKind:'stage6.checkpoint'},()=>3),3);assert.equal(await c.owned({workKind:'stage6.family',workFacts:['recovery_score']},()=>5),5);});assert.equal(p.snapshot().targetCalls,1);assert.equal(p.snapshot().profileCaptures,1);const d=createWorkCorrelation();d.preparation(1,()=>assert.equal(d.owned({},()=>3),3));
});

test('actual installed Node inspector captures a bounded window and disconnects',async()=>{
 const p=createFamilyCPU();let calls=0;assert.equal(await p.around(owner,async()=>{calls++;let total=0;for(let i=0;i<100000;i++)total+=Math.sqrt(i);return total>0?7:0;}),7);const v=p.snapshot();assert.equal(calls,1);assert.equal(v.profileCaptures,1);assert.equal(v.profileFailures,0);assert.equal(v.profilerDisabled,true);assert.equal(v.sessionDisconnected,true);assert.equal(validateFamilyCPU(v),true);
});
