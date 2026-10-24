import test from 'node:test';import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createAttribution} from './stage6-native-attribution.mjs';
import {createWorkCorrelation,validateWorkJoin,WORK_LABELS} from './stage6-native-work-join.mjs';
import {transformWorkJoin} from './stage6-native-work-join-loader.mjs';
const tx=(o,ms=1)=>{const r=o.startRequest(['BEGIN','SELECT 1','COMMIT']),b=o.finishRequest(r,{successMask:[true,true,true]}),t=o.startTransaction(b[0].owner,r,1);o.transactionStorage(t,'OTHER');o.finishTransaction(t,{outcome:'COMMITTED',durationUpperBoundMs:ms});};
test('request-start semantic owner survives delayed ACK and later work context',async()=>{
 const c=createWorkCorrelation(),o=c.decorate(createAttribution());let request;
 c.preparation(17,()=>c.owned({workKind:'stage6.family',workFacts:['recovery_score']},()=>{request=o.startRequest(['BEGIN']);}));
 c.preparation(2,()=>c.owned({workKind:'stage6.family',workFacts:['hrv']},()=>{const b=o.finishRequest(request,{successMask:[true]}),t=o.startTransaction(b[0].owner,request,1);o.transactionStorage(t,'SOURCE_DATA');o.finishTransaction(t,{outcome:'COMMITTED',durationUpperBoundMs:8300});}));
 const x=o.snapshot().namedWorkJoin;assert.equal(validateWorkJoin(x),true);assert.equal(x.terminalJoinComplete,true);assert.equal(x.slowest8[0].workLabel,'stage6.family:recovery_score');assert.equal(x.slowest8[0].preparationOrdinal,17);assert.equal(x.byWork[0].atOrAbove5s,1);
});
test('async work propagation invokes original once and preserves exact return/error',async()=>{
 const c=createWorkCorrelation(),o=c.decorate(createAttribution()),value=Object.freeze({}),error=Error('PRIVATE');let n=0;
 const v=await c.preparation(3,()=>c.owned({workKind:'stage6.source',workFacts:['PRIVATE_METRIC']},async()=>{await new Promise(r=>setImmediate(r));n++;tx(o);return value;}));assert.equal(v,value);assert.equal(n,1);
 await assert.rejects(c.preparation(4,()=>c.owned({workKind:'stage6.family',workFacts:['PRIVATE']},async()=>{tx(o);throw error;})),e=>e===error);
 const x=o.snapshot().namedWorkJoin;assert.equal(x.byWork[0].workLabel,'stage6.source');assert.equal(x.byWork[1].workLabel,'stage6.family:UNKNOWN');assert.equal(JSON.stringify(x).includes('PRIVATE'),false);
});
test('interleaved original BEGIN ACK tokens cannot be rebound by current async context',async()=>{
 const c=createWorkCorrelation(),o=c.decorate(createAttribution());let a,b;
 c.preparation(1,()=>c.owned({workKind:'stage6.family',workFacts:['hrv']},()=>{a=o.startRequest(['BEGIN']);}));c.preparation(2,()=>c.owned({workKind:'stage6.family',workFacts:['rhr']},()=>{b=o.startRequest(['BEGIN']);}));
 for(const [request,ms]of [[b,20],[a,10]]){const ack=o.finishRequest(request,{successMask:[true]}),t=o.startTransaction(ack[0].owner,request,1);o.finishTransaction(t,{outcome:'ROLLED_BACK',durationUpperBoundMs:ms});}
 const x=o.snapshot().namedWorkJoin;assert.equal(x.terminalJoinComplete,true);assert.deepEqual(x.slowest8.map(x=>[x.preparationOrdinal,x.workLabel]),[[2,'stage6.family:rhr'],[1,'stage6.family:hrv']]);
});
test('same-request multiple BEGINs use their exact original ordinal and scope',()=>{
 const c=createWorkCorrelation(),o=c.decorate(createAttribution());const r=o.startRequest(['BEGIN','COMMIT','BEGIN','ROLLBACK']),bs=o.finishRequest(r,{successMask:[true,true,true,true]});for(const b of bs){const t=o.startTransaction(b.owner,r,b.statementOrdinal);o.finishTransaction(t,{outcome:b.statementOrdinal===1?'COMMITTED':'ROLLED_BACK',durationUpperBoundMs:1});}
 const x=o.snapshot().namedWorkJoin;assert.equal(x.terminalJoinComplete,true);assert.equal(x.byWork[0].transactions,2);assert.equal(x.byWork[0].workLabel,'OUTSIDE');
});
test('lost ACK, failed BEGIN and forged owner never become complete joined evidence',()=>{
 for(const mode of ['lost','failed','forged']){const c=createWorkCorrelation(),o=c.decorate(createAttribution()),r=o.startRequest(['BEGIN']);const b=o.finishRequest(r,{successMask:mode==='lost'?[]:[mode!=='failed'],requestError:mode==='lost'});if(mode==='forged')o.startTransaction({},r,1);const x=o.snapshot().namedWorkJoin;assert.equal(x.terminalJoinComplete,mode==='failed');if(mode==='forged')assert.ok(x.lostJoins>0);if(mode!=='forged')assert.equal(x.linkedTransactionCount,0);}
});
test('bounded slowest8 retains every aggregate after underlying sample truncation',()=>{
 const c=createWorkCorrelation(),o=c.decorate(createAttribution());for(let i=1;i<=140;i++)c.preparation(i%17+1,()=>c.owned({workKind:'stage6.family',workFacts:['sleep_efficiency']},()=>tx(o,i)));
 const s=o.snapshot(),x=s.namedWorkJoin;assert.equal(s.transactionSampleCoverageComplete,false);assert.equal(x.terminalJoinComplete,true);assert.equal(x.allPhysicalTransactions,140);assert.equal(x.byWork.reduce((a,b)=>a+b.transactions,0),140);assert.equal(x.slowest8.length,8);assert.equal(x.slowest8[0].durationUpperBoundMs,140);assert.ok(x.byWork.length<=18*WORK_LABELS.length);
});
test('unknown terminal remains unknown and finite output schema rejects leaks or invented labels',()=>{
 const c=createWorkCorrelation(),o=c.decorate(createAttribution()),r=o.startRequest(['BEGIN']),b=o.finishRequest(r,{successMask:[true]}),t=o.startTransaction(b[0].owner,r,1);o.finishTransaction(t,{outcome:'BATON_LOST_UNRESOLVED',durationUpperBoundMs:5});const x=o.snapshot().namedWorkJoin;assert.equal(x.terminalJoinComplete,false);assert.equal(x.slowest8[0].outcome,'UNKNOWN');assert.throws(()=>validateWorkJoin({...x,privateSQL:'PRIVATE'}));const bad=structuredClone(x);bad.slowest8[0].workLabel='PRIVATE';assert.throws(()=>validateWorkJoin(bad));assert.throws(()=>c.preparation(18,()=>{}));
});
test('loader transforms only exact queue and calls original once; unrelated source unchanged',async()=>{
 const url=new URL('../src/phase4ReanalysisQueue.js',import.meta.url).href,source=await readFile(new URL(url),'utf8'),out=transformWorkJoin(url,source);
 assert.equal(transformWorkJoin('file:///OTHER','PRIVATE'),'PRIVATE');assert.throws(()=>transformWorkJoin(url,source+' '),/EXACT_QUEUE_REQUIRED/);assert.equal(out.split('const call=()=>ownedOriginal(...args)').length,2);assert.ok(out.includes('globalThis.__stage6WorkJoin.owned(args[3],call)'));assert.equal(out.includes('__stage6CPUStats'),false);
});

test('diagnostic options add no getter read, proxy trap, Symbol or object coercion',()=>{
 const c=createWorkCorrelation();let reads=0,calls=0,traps=0,coercions=0;
 const cases=[{get workKind(){reads++;return 'stage6.source';}}, {workKind:'stage6.family',workFacts:[Symbol('PRIVATE')]},{workKind:'stage6.family',workFacts:[{toString(){coercions++;return 'PRIVATE';}}]},new Proxy({},{getOwnPropertyDescriptor(){traps++;throw Error('PRIVATE');},get(){traps++;return null;}})];
 for(const options of cases)c.preparation(1,()=>c.owned(options,()=>{calls++;return options;}));
 assert.deepEqual([reads,calls,traps,coercions],[0,4,0,0]);
});
test('original getter, value and rejection are observed only by original invocation',()=>{
 const c=createWorkCorrelation();let reads=0,calls=0;const marker=Error('PRIVATE');const options={get workKind(){reads++;throw marker;}};
 assert.throws(()=>c.preparation(1,()=>c.owned(options,()=>{calls++;return options.workKind;})),e=>e===marker);assert.deepEqual([reads,calls],[1,1]);
});
test('slow terminal is emitted before later unresolved cleanup and failed sink never changes original return',()=>{
 const packets=[],c=createWorkCorrelation({emit:x=>packets.push(x)}),o=c.decorate(createAttribution());c.preparation(17,()=>c.owned({workKind:'stage6.family',workFacts:['recovery_score']},()=>tx(o,8300)));
 assert.equal(packets.length,1);assert.equal(packets[0].slowest8[0].preparationOrdinal,17);assert.equal(packets[0].slowest8[0].workLabel,'stage6.family:recovery_score');assert.equal(packets[0].terminalJoinComplete,true);
 const bad=createWorkCorrelation({emit:()=>{throw Error('PRIVATE');}}),b=bad.decorate(createAttribution());assert.equal(bad.preparation(1,()=>bad.owned({workKind:'stage6.source'},()=>{tx(b,6000);return 7;})),7);assert.equal(b.snapshot().namedWorkJoin.terminalJoinComplete,false);assert.ok(b.snapshot().namedWorkJoin.lostJoins>0);
});
test('metadata invocation bound does not prevent original calls or conceal lost attribution',()=>{
 const c=createWorkCorrelation(),o=c.decorate(createAttribution());let calls=0;for(let i=0;i<4097;i++)c.preparation(1,()=>c.owned({},()=>{calls++;}));assert.equal(calls,4097);assert.equal(o.snapshot().namedWorkJoin.terminalJoinComplete,false);assert.ok(o.snapshot().namedWorkJoin.lostJoins>0);
});
