import test from 'node:test';import assert from 'node:assert/strict';
import {joinIssuedTransport,transportIsJoined,waitIssuedIdleBefore} from './stage6-native-join-barrier.mjs';
const packet=(retained=0)=>({adapter:{terminalComplete:true,activeFetches:0,retainedStreams:retained,unresolvedStreams:0,droppedObservations:0,unknownProtocolReplies:0},physicalTerminalObservationComplete:true});
test('one original deadline joins only after two stable physical observations',async()=>{
 let clock=0,n=0,waits=0;const r=await joinIssuedTransport({snapshot(){n++;return packet(n<3?1:0);}},{startedAt:0,deadlineAt:40,now:()=>clock,wait:async ms=>{waits++;clock+=ms;}});
 assert.equal(r.settled,true);assert.equal(r.probes,4);assert.equal(waits,3);assert.equal(r.elapsedMs,15);
});
test('permanently unsettled transport fails at the original deadline without another close/query',async()=>{
 let clock=10,waits=0;const r=await joinIssuedTransport({snapshot:()=>packet(1)},{startedAt:0,deadlineAt:30,now:()=>clock,wait:async ms=>{clock+=ms;waits++;}});
 assert.equal(r.settled,false);assert.equal(clock,30);assert.equal(waits,4);
});
test('a transient clean observation cannot hide later unresolved work',async()=>{
 let clock=0,n=0;const r=await joinIssuedTransport({snapshot(){const p=packet();if(++n!==1)p.adapter.unresolvedStreams=1;return p;}},{startedAt:0,deadlineAt:20,now:()=>clock,wait:async ms=>{clock+=ms;}});
 assert.equal(r.settled,false);
});
test('invalid snapshots never satisfy the physical barrier',()=>{
 for(const mutate of [p=>p.adapter.activeFetches=1,p=>p.adapter.retainedStreams=NaN,p=>delete p.adapter.unresolvedStreams,p=>p.adapter.droppedObservations=1,p=>p.adapter.unknownProtocolReplies=1,p=>p.physicalTerminalObservationComplete=false,p=>p.adapter.terminalComplete=false]){const p=packet();mutate(p);assert.equal(transportIsJoined(p),false);}
});
test('snapshot time cannot pass the original deadline while claiming settlement',async()=>{
 let clock=0;const r=await joinIssuedTransport({snapshot(){clock=101;return packet();}},{startedAt:0,deadlineAt:100,now:()=>clock,wait:async()=>{throw Error('NO_WAIT');}});
 assert.equal(r.settled,false);
});
test('invalid or expanded windows and backwards clocks fail closed',async()=>{
 for(const [startedAt,deadlineAt]of [[0,5001],[1,0],[NaN,1],[0,Infinity]])await assert.rejects(joinIssuedTransport({snapshot:()=>packet()},{startedAt,deadlineAt,now:()=>0}),/PHYSICAL_JOIN_WINDOW_INVALID/);
 await assert.rejects(joinIssuedTransport({snapshot:()=>packet()},{startedAt:1,deadlineAt:2,now:()=>0}),/PHYSICAL_JOIN_CLOCK_INVALID/);
});
test('original wait rejection is preserved without a replacement operation',async()=>{
 const original=Error('SYNTHETIC_WAIT_FAILURE');let waits=0;
 await assert.rejects(joinIssuedTransport({snapshot:()=>packet(1)},{startedAt:0,deadlineAt:20,now:()=>0,wait:async()=>{waits++;throw original;}}),x=>x===original);assert.equal(waits,1);
});


test('final clock resample cannot grant settlement after the deadline',async()=>{
 let n=0;const r=await joinIssuedTransport({snapshot:()=>packet()},{startedAt:0,deadlineAt:50,now:()=>++n>=5?100:0,wait:async()=>{}});assert.equal(r.settled,false);assert.equal(r.elapsedMs,100);
});

test('initial awaitIdle cannot hang past its original deadline',async()=>{
 const startedAt=performance.now();let calls=0;const result=await waitIssuedIdleBefore({awaitIdle(){calls++;return new Promise(()=>{});}},{startedAt,deadlineAt:startedAt+20});assert.equal(result,false);assert.equal(calls,1);assert.ok(performance.now()-startedAt<1000);
});
test('initial idle observation may settle once within the same window',async()=>{
 const startedAt=performance.now();let calls=0;const result=await waitIssuedIdleBefore({awaitIdle(){calls++;return Promise.resolve();}},{startedAt,deadlineAt:startedAt+1000});assert.equal(result,true);assert.equal(calls,1);
});
test('expired initial window cannot start a new idle observation',async()=>{
 let calls=0;assert.equal(await waitIssuedIdleBefore({awaitIdle(){calls++;return Promise.resolve();}},{startedAt:0,deadlineAt:1,now:()=>2}),false);assert.equal(calls,0);
});
test('initial idle rejection retains the original error without another observation',async()=>{
 const error=Error('SYNTHETIC_IDLE_FAILURE');let calls=0;const startedAt=performance.now();await assert.rejects(waitIssuedIdleBefore({awaitIdle(){calls++;return Promise.reject(error);}},{startedAt,deadlineAt:startedAt+1000}),x=>x===error);assert.equal(calls,1);
});

test('the original absolute deadline formula accepts fractional monotonic clocks',async()=>{
 const startedAt=0.123456789,deadlineAt=startedAt+5000;const r=await joinIssuedTransport({snapshot:()=>packet()},{startedAt,deadlineAt,now:()=>startedAt,wait:async()=>{}});assert.equal(r.settled,true);
});
