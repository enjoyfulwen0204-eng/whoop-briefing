import test from 'node:test';
import assert from 'node:assert/strict';
import {createDiagnosticFetch} from './stage6-native-diagnostic-observer.mjs';
import {nativeTraceJoined,nativeTraceSummary,awaitNativeTraceJoined,assertNativeObservedTransactions,throwNativeCloseFailures} from './stage6ShadowNativeTrace.mjs';
const {PipelineRespBody}=await import(new URL('./http/json_decode.js',import.meta.resolve('@libsql/hrana-client')));
const stmt={cols:[],rows:[],affected_row_count:0,last_insert_rowid:null};
const ok=(type,result)=>({type:'ok',response:{type,...(result?{result}:{})}});
const json=value=>new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
const execute=sql=>({type:'execute',stmt:{sql,want_rows:false}});
const request=(requests,baton)=>new Request('http://127.0.0.1:18080/v2/pipeline',{method:'POST',body:JSON.stringify({requests,...(baton?{baton}:{})})});
const adapter=(fetch,options={})=>createDiagnosticFetch({fetch,decodePipelineReply:PipelineRespBody,...options});

test('trace and shutdown failures preserve both errors with the original trace cause',()=>{
 const trace=Error('synthetic join failure'),shutdown=Error('synthetic shutdown failure');
 assert.throws(()=>throwNativeCloseFailures(trace,shutdown),error=>{
  assert.ok(error instanceof AggregateError);assert.equal(error.cause,trace);assert.deepEqual(error.errors,[trace,shutdown]);return true;
 });
 assert.throws(()=>throwNativeCloseFailures(trace),error=>error===trace);
 assert.throws(()=>throwNativeCloseFailures(undefined,shutdown),error=>error===shutdown);
 assert.doesNotThrow(()=>throwNativeCloseFailures());
});

test('join refuses an idle baton until its actual SDK-decoded close ACK, without dispatching cleanup',async()=>{
 let calls=0,clock=0;
 const trace=adapter(async()=>++calls===1?json({baton:'PRIVATE_IDLE_BATON',results:[ok('execute',stmt)]}):json({baton:null,results:[ok('close')]}));
 await trace.fetch(request([execute('SELECT 1')]));
 assert.equal(trace.snapshot().adapter.terminalComplete,true);
 assert.equal(nativeTraceJoined(trace.snapshot()),false);
 await assert.rejects(awaitNativeTraceJoined(trace,{now:()=>clock,wait:async ms=>{clock+=ms;}}),error=>{
  assert.equal(error.message,'SYNTHETIC_NATIVE_STREAMS_NOT_JOINED');assert.equal(error.trace.retainedStreams,1);
  assert.equal(JSON.stringify(error.trace).includes('PRIVATE'),false);return true;
 });
 assert.equal(calls,1,'the join observer must never dispatch its own close or SQL');
 await trace.fetch(request([{type:'close'}],'PRIVATE_IDLE_BATON'));
 assert.equal(nativeTraceJoined(await awaitNativeTraceJoined(trace)),true);
});

test('bounded join awaits an in-flight physical response rather than crediting close dispatch',async()=>{
 let release,entered=false,clock=0;
 const trace=adapter(()=>new Promise(resolve=>{entered=true;release=resolve;}));
 const pending=trace.fetch(request([execute('BEGIN'),execute('COMMIT'),{type:'close'}]));
 while(!entered)await new Promise(resolve=>setImmediate(resolve));
 assert.equal(nativeTraceJoined(trace.snapshot()),false);
 let waited=false;
 const joined=await awaitNativeTraceJoined(trace,{now:()=>clock,wait:async ms=>{
  waited=true;clock+=ms;release(json({baton:null,results:[ok('execute',stmt),ok('execute',stmt),ok('close')]}));await pending;
 }});
 assert.equal(waited,true);assert.equal(assertNativeObservedTransactions(joined).begun,1);
});

test('join yields driver turns before accepting a previously empty trace with queued dispatch',async()=>{
 let pending,release,entered=false,returned=false;
 const trace=adapter(()=>new Promise(resolve=>{entered=true;release=resolve;}));
 queueMicrotask(()=>{pending=trace.fetch(request([execute('BEGIN'),execute('COMMIT'),{type:'close'}]));});
 const joining=awaitNativeTraceJoined(trace).then(snapshot=>{returned=true;return snapshot;});
 while(!entered)await new Promise(resolve=>setImmediate(resolve));
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(returned,false,'a queued physical dispatch must prevent premature join');
 release(json({baton:null,results:[ok('execute',stmt),ok('execute',stmt),ok('close')]}));
 await pending;assert.equal(assertNativeObservedTransactions(await joining).begun,1);
});

test('lost commit ACK preserves unresolved transaction and cannot pass after server-independent idle',async()=>{
 let calls=0,clock=0;const lost=Error('PRIVATE_LOST_ACK');
 const trace=adapter(async()=>++calls===1?json({baton:'PRIVATE_ACTIVE',results:[ok('execute',stmt)]}):Promise.reject(lost));
 await trace.fetch(request([execute('BEGIN')]));
 await assert.rejects(trace.fetch(request([execute('COMMIT')],'PRIVATE_ACTIVE')),error=>error===lost);
 await trace.awaitIdle();
 await assert.rejects(awaitNativeTraceJoined(trace,{now:()=>clock,wait:async ms=>{clock+=ms;}}),/STREAMS_NOT_JOINED/);
 const summary=nativeTraceSummary(trace.snapshot());
 assert.equal(summary.committed,0);assert.equal(summary.rolledBack,0);assert.equal(summary.unsettledTransactions,1);assert.equal(summary.activeFetches,0);
 assert.throws(()=>assertNativeObservedTransactions(trace.snapshot()));
});

test('transaction upper bound includes native BEGIN request dispatch through terminal ACK',async()=>{
 let clock=0;
 const trace=adapter(async()=>{clock+=4999;return json({baton:null,results:[ok('execute',stmt),ok('execute',stmt),ok('close')]});},{now:()=>clock});
 await trace.fetch(request([execute('BEGIN'),execute('COMMIT'),{type:'close'}]));
 const summary=assertNativeObservedTransactions(await awaitNativeTraceJoined(trace));
 assert.equal(summary.maxDurationUpperBoundMs,4999);assert.equal(summary.atOrAbove5s,0);
 assert.equal(summary.serverEnforcedAbsoluteTransactionLimit,'UNKNOWN');
});

test('5s violation beyond bounded transaction sample retention still fails from complete aggregates',async()=>{
 let clock=0,calls=0;
 const trace=adapter(async()=>{clock+=++calls===66?5000:1;return json({baton:null,results:[ok('execute',stmt),ok('execute',stmt),ok('close')]});},{now:()=>clock});
 for(let i=0;i<66;i++)await trace.fetch(request([execute('BEGIN'),execute('COMMIT'),{type:'close'}]));
 const joined=await awaitNativeTraceJoined(trace),summary=nativeTraceSummary(joined);
 assert.equal(joined.droppedTransactionSamples,2);assert.equal(summary.begun,66);
 assert.equal(summary.atOrAbove5s,1);assert.equal(summary.maxDurationUpperBoundMs,5000);
 assert.equal(nativeTraceJoined(joined),true);
 assert.throws(()=>assertNativeObservedTransactions(joined),/below 5s/);
});
