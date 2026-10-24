import test from 'node:test';import assert from 'node:assert/strict';
import {resolve} from 'node:path';import {pathToFileURL,fileURLToPath} from 'node:url';
import {createAttribution} from './stage6-native-attribution.mjs';
import {createDiagnosticFetch} from './stage6-native-diagnostic-observer.mjs';
import {createDiagnosticWall,createDiagnosticTelemetrySink,observeOriginalResult,safeProgress,progressDelta,failureSourceSites} from './stage6-native-diagnostic-contract.mjs';
// This optional test-only path selects already installed PURE JS decoder code; no dependency/native load or installation.
const dependencyRoot=process.env.NATIVE_DIAGNOSTIC_MOCK_DEPENDENCY_ROOT??fileURLToPath(new URL('..',import.meta.url));
const {PipelineRespBody}=await import(pathToFileURL(resolve(dependencyRoot,'node_modules/@libsql/hrana-client/lib-esm/http/json_decode.js')));
const stmt={cols:[],rows:[],affected_row_count:0,last_insert_rowid:null},ok=(type,result)=>({type:'ok',response:{type,...(result?{result}:{})}}),json=value=>new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
const request=(requests,baton)=>new Request('http://127.0.0.1:18080/v2/pipeline',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({requests,...(baton?{baton}:{})})});
const execute=sql=>({type:'execute',stmt:{sql,want_rows:false}});
const adapter=(fetch,options={})=>createDiagnosticFetch({fetch,decodePipelineReply:PipelineRespBody,...options});

test('real SDK-decoded late BEGIN ACK uses request-start SETUP owner, exact token and rotated baton',async()=>{
 let clock=0,release,entered=0;const observer=createAttribution({now:()=>clock});observer.setPhase('SETUP_SCHEMA1_TO35_SYNTHETIC_ONLY','MIGRATE');
 const t=adapter(()=>new Promise(resolve=>{entered++;release=resolve;}),{observer,now:()=>clock});
 const p=t.fetch(request([execute('BEGIN')]));observer.setPhase('ADMISSION_AND_COMPOSITION','RUNTIME_ADMISSION');
 while(entered<1)await new Promise(resolve=>setImmediate(resolve));clock=20;release(json({baton:'private-baton-1',results:[ok('execute',stmt)]}));await p;
 const next=t.fetch(request([execute('COMMIT'),{type:'close'}],'private-baton-1'));while(entered<2)await new Promise(resolve=>setImmediate(resolve));clock=35;release(json({baton:null,results:[ok('execute',stmt),ok('close')]}));await next;
 const s=t.snapshot();assert.equal(s.bins.SETUP_SCHEMA1_TO35_SYNTHETIC_ONLY.transactions.committed,1);assert.equal(s.bins.ADMISSION_AND_COMPOSITION.transactions.begun,0);
 assert.deepEqual([s.transactionSamples[0].startedPhase,s.transactionSamples[0].outerWorkUnit,s.transactionSamples[0].callOrdinal,s.transactionSamples[0].durationUpperBoundMs],['SETUP_SCHEMA1_TO35_SYNTHETIC_ONLY','MIGRATE',0,35]);assert.equal(s.adapter.terminalComplete,true);assert.equal(JSON.stringify(s).includes('private-baton'),false);
});

test('batch success/error/skipped steps build dense ACKs; failed COMMIT cannot finalize',async()=>{
 let call=0;const t=adapter(async()=>++call===1?json({baton:'batch-private',results:[ok('batch',{step_results:[stmt,stmt,null],step_errors:[null,null,{message:'PRIVATE_SQL_ERROR',code:'PRIVATE'}]})]}):json({baton:null,results:[ok('execute',stmt),ok('close')]}));
 await t.fetch(request([{type:'batch',batch:{steps:[{stmt:{sql:'BEGIN'}},{stmt:{sql:'SELECT 1'}},{stmt:{sql:'COMMIT'}}]}}]));
 let s=t.snapshot();assert.equal(s.bins.UNKNOWN.categories.TX_BEGIN.executed,1);assert.equal(s.bins.UNKNOWN.categories.TX_COMMIT.executed,0);assert.equal(s.bins.UNKNOWN.transactions.committed,0);assert.equal(s.unsettledTransactions,1);
 await t.fetch(request([execute('ROLLBACK'),{type:'close'}],'batch-private'));s=t.snapshot();assert.equal(s.bins.UNKNOWN.transactions.rolledBack,1);assert.equal(s.adapter.terminalComplete,true);assert.equal(JSON.stringify(s).includes('PRIVATE'),false);
});

test('wrong execute reply kind, truncated batch shape and HTTP failure never mint BEGIN ACK',async()=>{
 for(const reply of [{baton:null,results:[ok('close')]},{baton:null,results:[ok('batch',{step_results:[],step_errors:[]})]}]){
  const t=adapter(async()=>json(reply)),body=reply.results[0].response.type==='batch'?[{type:'batch',batch:{steps:[{stmt:{sql:'BEGIN'}}]}}]:[execute('BEGIN')];
  await t.fetch(request(body));const s=t.snapshot();assert.equal(s.bins.UNKNOWN.transactions.begun,0);assert.equal(s.bins.UNKNOWN.unknownReplies,1);assert.equal(s.adapter.terminalComplete,false);
 }
 const t=adapter(async()=>new Response('PRIVATE',{status:500}));await t.fetch(request([execute('BEGIN')]));assert.equal(t.snapshot().bins.UNKNOWN.transactions.begun,0);assert.equal(t.snapshot().adapter.terminalComplete,false);
});

test('lost COMMIT ACK preserves exact rejection and unresolved original transaction, never fake rollback',async()=>{
 let call=0;const lost=Object.assign(Error('PRIVATE_LOST_ACK'),{code:'COMMIT_INDETERMINATE'}),t=adapter(async()=>{if(++call===1)return json({baton:'lost-private',results:[ok('execute',stmt)]});throw lost;});
 await t.fetch(request([execute('BEGIN')]));await assert.rejects(t.fetch(request([execute('COMMIT')],'lost-private')),error=>error===lost);await t.awaitIdle();
 const s=t.snapshot();assert.equal(s.bins.UNKNOWN.transactions.committed,0);assert.equal(s.bins.UNKNOWN.transactions.rolledBack,0);assert.equal(s.unsettledTransactions,1);assert.equal(s.adapter.unresolvedStreams,1);assert.equal(s.adapter.terminalComplete,false);assert.equal(s.allTransactionTerminalsKnown,false);assert.equal(JSON.stringify(s).includes('PRIVATE'),false);
});

test('SQL ID resolution stays stream-local and close without terminal ACK is UNKNOWN',async()=>{
 let call=0;const t=adapter(async()=>++call===1?json({baton:'id-private',results:[ok('store_sql'),ok('execute',stmt)]}):json({baton:null,results:[ok('close_sql'),ok('close')]}));
 await t.fetch(request([{type:'store_sql',sql_id:1,sql:'BEGIN'},{type:'execute',stmt:{sql_id:1}}]));await t.fetch(request([{type:'close_sql',sql_id:1},{type:'close'}],'id-private'));
 const s=t.snapshot();assert.equal(s.bins.UNKNOWN.transactions.begun,1);assert.equal(s.bins.UNKNOWN.transactions.unknownTerminal,1);assert.equal(s.bins.UNKNOWN.transactions.committed,0);assert.equal(s.adapter.terminalComplete,false);
});

test('process-start wall admits calls0 after setup, one call only, and final oracle follows awaited cleanup',async()=>{
 let clock=0;const wall=createDiagnosticWall({startedMonoMs:0,now:()=>clock});clock=60001;assert.equal(wall.admitOriginalCall(),false);assert.equal(wall.callsStarted,0);
 clock=0;const original=createDiagnosticWall({startedMonoMs:0,now:()=>clock});clock=60000;assert.equal(original.admitOriginalCall(),true);assert.throws(()=>original.admitOriginalCall(),/DIAGNOSTIC_SECOND_CALL_FORBIDDEN/);
 clock=119990;await Promise.resolve().then(()=>{clock=120001;});const final=original.finalize({cleanupJoined:true,terminalKnown:true});assert.equal(final.withinBoundAndSettled,false);assert.equal(final.wallCompliant,false);assert.throws(()=>original.assert(),/DIAGNOSTIC_WALL_EXHAUSTED/);
 const unsettled=wall.finalize({cleanupJoined:false,terminalKnown:false});assert.equal(unsettled.withinBoundAndSettled,false);
});

test('telemetry mapping retains exact returned result, one invocation and only closed counters',async()=>{
 const sink=createDiagnosticTelemetrySink(),original=Object.freeze({result:Object.freeze({outcome:'PARTIAL',unitsCommitted:1}),publication:{status:'ANALYSIS_UPDATING'}});let calls=0;
 const returned=await observeOriginalResult({run:async()=>{calls++;return original;},releaseSha:'a'.repeat(40),sink,withTelemetry:async(options,work)=>{
  assert.deepEqual([options.phase,options.source],['STAGE6_DRAIN','manual']);const telemetryShape=await work();assert.equal(telemetryShape.body.result.outcome,'PARTIAL');
  options.emit('phase4_trace_summary',{outcome:'PARTIAL',query_count:2,duration_ms:1,request_id:'PRIVATE_USER',raw:'PRIVATE_SQL'});options.emit('phase4_operation_totals',{operation:'DB_HTTP',count:2,completed_operations:2,failed_operations:0,timed_out:0,cancelled:0,duration_ms:3,max_duration_ms:2,raw:'PRIVATE_SQL'});options.emit('phase4_operation_totals',{operation:'PRIVATE_OPERATION',count:1});return telemetryShape;
 }});assert.equal(returned,original);assert.equal(calls,1);const s=sink.snapshot();assert.equal(s.summary.query_count,2);assert.equal(s.summary.outcome,'PARTIAL');assert.equal(s.totals.DB_HTTP.count,2);assert.equal(s.invalidEnumEvents,1);assert.equal(JSON.stringify(s).includes('PRIVATE'),false);
 const hints=failureSourceSites([{sourceBasename:'stage8LiveProducer.js',line:97},{sourceBasename:'phase4Coordination.js',line:8}]);assert.equal(hints.producerContextCleanupFrameObserved,true);assert.equal(hints.sharedContextReleaseFrameObserved,true);assert.equal(hints.innerSemanticWorkUnit,'UNKNOWN_NOT_INSTRUMENTED');assert.equal(failureSourceSites([]).producerContextCleanupFrameObserved,false);
});

test('whole two-job criterion and cursor/generation progress survive PARTIAL without fabricated completion',()=>{
 const jobs=['RECOMPUTE_DERIVED','REPAIR_CURRENTNESS'].map(job_kind=>({job_kind,state:'PENDING',requested_generation:3,completed_generation:1,scope_kind:'FULL',full_scan_cursor:'PRIVATE_CURSOR_DATE'}));
 const before=safeProgress({jobs,computation:{input_generation:3,last_completed_generation:1},execution:{state:'WORK_COMMITTED'},executionResult:{outcome:'PARTIAL'},receiptCount:1,sourceRows:0});assert.equal(before.originalJobsCompleted,0);assert.equal(before.execution.terminalStateObserved,false);
 const done=jobs.map(j=>({...j,state:'COMPLETED',completed_generation:3,scope_kind:'NONE',full_scan_cursor:null})),after=safeProgress({jobs:done,computation:{input_generation:3,last_completed_generation:3},execution:{state:'FINALIZED_SUCCESS'},executionResult:{outcome:'PARTIAL'},receiptCount:2,callAcknowledgement:'THREW'});
 assert.equal(after.originalJobsCompleted,2);assert.equal(after.execution.resultOutcome,'PARTIAL');assert.equal(after.execution.callAcknowledgement,'THREW');assert.equal(progressDelta(before,after).completedGenerationDelta,2);assert.equal(progressDelta(before,after).jobs[0].cursorChanged,true);assert.equal(JSON.stringify(before).includes('PRIVATE'),false);
 assert.equal(safeProgress({jobs:[...done,done[0]]}).originalJobsCompleted,0);assert.equal(safeProgress({receiptCount:NaN}).executionWorkReceiptReadback,'UNKNOWN');assert.equal(progressDelta(null,after).status,'UNKNOWN');
});

test('140 acknowledged SETUP transactions keep exact aggregates with 64 samples, explicit truncation and safe physical cleanup',async()=>{
 let clock=0;const observer=createAttribution({now:()=>clock});observer.setPhase('SETUP_SCHEMA1_TO35_SYNTHETIC_ONLY','MIGRATE');
 const t=adapter(async()=>{clock+=10;return json({baton:null,results:[ok('execute',stmt),ok('execute',stmt),ok('close')]});},{observer,now:()=>clock});
 for(let i=0;i<140;i++)await t.fetch(request([execute('BEGIN'),execute('COMMIT'),{type:'close'}]));
 await t.awaitIdle();const s=t.snapshot(),setup=s.bins.SETUP_SCHEMA1_TO35_SYNTHETIC_ONLY;
 assert.equal(setup.requests,140);assert.equal(setup.submittedStatements,280);assert.equal(setup.observedExecutedStatements,280);
 assert.equal(setup.transactions.begun,140);assert.equal(setup.transactions.committed,140);assert.equal(setup.transactions.rolledBack,0);assert.equal(setup.transactions.unknownTerminal,0);assert.equal(setup.transactions.open,0);assert.equal(setup.transactions.sumDurationUpperBoundMs,1400);
 assert.equal(s.transactionSamples.length,64);assert.equal(s.droppedTransactionSamples,76);assert.equal(s.transactionSampleCoverageComplete,false);
 assert.equal(s.droppedObservations,0);assert.equal(s.observationCoverageComplete,true);assert.equal(s.physicalTerminalObservationComplete,true);assert.equal(s.terminalObservationComplete,true);assert.equal(s.attributionComplete,false);
 assert.equal(s.adapter.activeFetches,0);assert.equal(s.adapter.retainedStreams,0);assert.equal(s.adapter.unresolvedStreams,0);assert.equal(s.adapter.terminalComplete,true);assert.equal(s.adapter.attributionComplete,false);assert.equal(s.capacityQualified,false);
});

test('lost ownership still refuses physical cleanup even after every tracked owner has settled',()=>{
 const observer=createAttribution({maxInflight:1});observer.setPhase('SETUP_SCHEMA1_TO35_SYNTHETIC_ONLY','MIGRATE');
 const kept=observer.startRequest([]);assert.equal(observer.startRequest([]),null);observer.finishRequest(kept,{successMask:[]});
 const t=adapter(async()=>{throw Error('MOCK_TRANSPORT_MUST_NOT_RUN');},{observer});const s=t.snapshot();
 assert.equal(s.inflightRequests,0);assert.equal(s.unsettledTransactions,0);assert.equal(s.allRequestsSettled,true);assert.equal(s.allTransactionsSettled,true);assert.equal(s.droppedTransactionSamples,0);assert.equal(s.transactionSampleCoverageComplete,true);
 assert.equal(s.droppedObservations,1);assert.equal(s.observationCoverageComplete,false);assert.equal(s.physicalTerminalObservationComplete,false);assert.equal(s.terminalObservationComplete,false);assert.equal(s.attributionComplete,false);assert.equal(s.adapter.terminalComplete,false);
 assert.throws(()=>createAttribution({maxInflight:129}),/DIAGNOSTIC_FIXED_BOUND_REQUIRED/);assert.throws(()=>createAttribution({maxTransactionSamples:65}),/DIAGNOSTIC_FIXED_BOUND_REQUIRED/);
});
