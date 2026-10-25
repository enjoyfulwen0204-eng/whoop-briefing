import {runOwnedPreparationBatches,fingerprintOwnedFile} from './stage6-owned-file-batch-control.mjs';
import {runningReleaseSha as physicalBatchReleaseSha} from '../src/phase4Release.js';
import {STAGE8_LIVE_DRAIN_BUDGET} from '../src/stage8LiveDrainPolicy.js';
import {joinIssuedTransport,transportIsJoined,waitIssuedIdleBefore} from './stage6-native-join-barrier.mjs';
// One fresh synthetic ownedFILE preparation followed by supported SQLD legacy startup.
// Only final115ms HTTP EOF/persistence and exact identity replay are targeted.
// Original full HTTP preparation240s failures, six-job and capacity conclusions remain unchanged.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,open,rm,mkdir,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {PipelineRespBody} from '../node_modules/@libsql/hrana-client/lib-esm/http/json_decode.js';
import {createDb,createOwnedFileDb} from '../src/db.js';
import {fixtureKeys as keys} from './localDb.js';
import {createPhase4Foundation} from '../src/phase4Foundation.js';
import {createStage8LiveProducer} from '../src/stage8LiveProducer.js';
import {authorizeStage8LiveProducer} from '../src/stage8LiveProducerAuthority.js';
import {buildPhase4Core} from '../src/phase4Core.js';
import {createPhase4Stage6} from '../src/phase4Reanalysis.js';
import {createStage8LiveExecutionRunner} from '../src/stage8LiveExecution.js';
import {runningReleaseSha} from '../src/phase4Release.js';
import {createReanalysisInputs} from '../src/phase4ReanalysisInputs.js';
import {composePhase4Stores} from '../src/phase4Repositories.js';
import {createExecutionBudget,withExecutionBudget} from '../src/executionBudget.js';
import {verifyLiveExecutionResult} from '../src/stage8LiveExecution.js';
import {offlineLiveFixtureInput,OFFLINE_LIVE_TABLES} from './stage8LiveLinuxFixture.js';
import {seedBodyInput} from './bodyEnergyFixture.js';
import {createDiagnosticFetch} from './stage6-native-diagnostic-observer.mjs';
import {createAttribution} from './stage6-native-attribution.mjs';
const directory=await mkdtemp(join(tmpdir(),'healthos-local-owned-file-batch-')),log=await open(join(directory,'sqld.log'),'wx',0o600),started=performance.now();
let server=null,serverError=false;
const networkFetch=globalThis.fetch.bind(globalThis);let latency=false,db,a,b,stage='SERVER_START',failure=null,report=null,closed=false;
const progress={startedPreparations:0,completedPreparations:0,sourceAcknowledgments:0,unitsCommitted:0,lastPendingJobs:null,lastBudgetPerTenant:null,check:'NOT_STARTED',preparationSnapshotState:'NOT_STARTED'};
function capturePreparationProgress(terminal=false){
 if(progress.preparationSnapshotState==='NOT_STARTED')return;
 try{
  const t=a.snapshot().bins.GENUINE_ORIGINAL_PRODUCER_CALL.transactions;
  const fields={preparationTransactionCount:'begun',preparationMaxUpperMs:'maxDurationUpperBoundMs',preparationAtOrAbove5s:'atOrAbove5s',preparationUnknown:'unknownTerminal',preparationOpen:'open'};
  const values=Object.entries(fields).map(([key,name])=>[key,t[name]]);
  if(!values.every(([,v])=>typeof v==='number'&&Number.isFinite(v)&&v>=0))throw Error('UNSAFE_PROVISIONAL_METRIC');
  Object.assign(progress,Object.fromEntries(values));progress.preparationSnapshotState=terminal?'TERMINAL':'PROVISIONAL';
 }catch{progress.preparationSnapshotState='UNKNOWN';}
}
const nativeFetch=async(input,init)=>{const r=new Request(input,init),url=new URL(r.url);assert.equal(url.origin,'http://127.0.0.1:18080');assert.equal(url.username,'');assert.equal(url.password,'');return networkFetch(r,{signal:AbortSignal.any([r.signal,AbortSignal.timeout(10000)])});};
const observer=()=>{const o=createAttribution();return createDiagnosticFetch({fetch:nativeFetch,decodePipelineReply:PipelineRespBody,observer:o,latencyEnabled:()=>latency});};
const joinWindows=new WeakMap();
function observeEOFCounters(snapshot,terminal){
 if(!b||!snapshot)return;
 try{
  const packet=snapshot.bins.GENUINE_ORIGINAL_PRODUCER_CALL,t=packet.transactions;
  const values={eofRequests:packet.requests,eofRequestErrors:packet.requestErrors,eofResponseErrors:packet.responseErrors,eofUnknownReplies:packet.unknownReplies,eofTransactions:t.begun,eofMaxUpperMs:t.maxDurationUpperBoundMs,eofAtOrAbove5s:t.atOrAbove5s,eofOpen:t.open,eofUnknownTerminal:t.unknownTerminal};
  if(!Object.values(values).every(v=>Number.isFinite(v)&&v>=0))throw Error('UNKNOWN_EOF_COUNTER');
  Object.assign(progress,values);progress.eofSnapshotState=terminal?'TERMINAL':'PROVISIONAL';
 }catch{progress.eofSnapshotState='UNKNOWN';}
}
async function closeClient(transport,{finalObservation=false}={}){
 let window=joinWindows.get(transport);if(!window){const at=performance.now();window={startedAt:at,deadlineAt:at+5000};joinWindows.set(transport,window);}
 if(db){await db.close();db=null;}
 // Preserve the original first three-turn observation separately. Driver
 // decode/flush may still be pending after observer awaitIdle returned.
 if(!finalObservation)progress.joinInitialIdleWithinBudget=1;
 for(let i=0;i<3;i++){
  await new Promise(r=>setImmediate(r));
  if(finalObservation)await transport.awaitIdle();
  else{progress.check='JOIN_INITIAL_IDLE';if(!await waitIssuedIdleBefore(transport,window)){progress.joinInitialIdleWithinBudget=0;break;}}
 }
 let s=transport.snapshot();
 if(!finalObservation){
  progress.joinTransport=transport===b?'EOF':'PREPARATION';
  progress.joinInitialActive=s.adapter.activeFetches;progress.joinInitialRetained=s.adapter.retainedStreams;
  progress.joinInitialAdapterTerminal=s.adapter.terminalComplete?1:0;progress.joinInitialPhysicalTerminal=s.physicalTerminalObservationComplete?1:0;
  if(transport===b)observeEOFCounters(s,false);
  const joined=await joinIssuedTransport(transport,window);s=joined.lastSnapshot??s;
  progress.joinElapsedMs=joined.elapsedMs;progress.joinProbes=joined.probes;progress.joinWithinBudget=joined.settled?1:0;
  if(transport===b)observeEOFCounters(s,joined.settled);
  progress.check='JOIN_PHYSICAL_DEADLINE';assert.equal(joined.settled,true);
 }
 // Final failure cleanup observes physical state only; it never creates a
 // fresh join window or clears the original qualification failure.
 progress.check='JOIN_ADAPTER_TERMINAL';assert.equal(s.adapter.terminalComplete,true);
 progress.check='JOIN_RETAINED_STREAMS';assert.equal(s.adapter.retainedStreams,0);
 progress.check='JOIN_PHYSICAL_TERMINAL';assert.equal(s.physicalTerminalObservationComplete,true);return s;
}
function canonicalRow(row){
 const typed=value=>value===null?['null']:typeof value==='string'?['string',value]:typeof value==='number'&&Number.isFinite(value)?['number',value]:typeof value==='bigint'?['bigint',String(value)]:value instanceof ArrayBuffer?['bytes',Buffer.from(value).toString('base64')]:ArrayBuffer.isView(value)?['bytes',Buffer.from(value.buffer,value.byteOffset,value.byteLength).toString('base64')]:(()=>{throw Error('UNSUPPORTED_TYPED_ROW_VALUE');})();
 return JSON.stringify(Object.keys(row).sort().map(key=>[key,typed(row[key])]));
}
const allRows=async table=>(await db.raw.execute('SELECT * FROM '+table+' ORDER BY 1,2')).rows;
function preparationBudgetFor(pending,catalog){
 const ceiling=STAGE8_LIVE_DRAIN_BUDGET.maxItemsPerTenant;
 if(!Array.isArray(catalog)||catalog.length<1||catalog.length>512||new Set(catalog).size!==catalog.length)throw Error('SYNTHETIC_PROGRESS_CATALOG_INVALID');
 for(const row of pending){
  const index=row.full_scan_cursor===null?-1:catalog.indexOf(row.full_scan_cursor);
  if(row.full_scan_cursor!==null&&index<0)throw Error('SYNTHETIC_PROGRESS_CURSOR_INVALID');
  const remaining=catalog.length-index-1;
  if(remaining<=ceiling)return {maxItems:1,maxItemsPerTenant:1};
 }
 return STAGE8_LIVE_DRAIN_BUDGET;
}

function failureClassification(error){
 const allowed=new Set(['BOUNDED_SETUP_AND_RECOVERY_RESERVE_REQUIRED','ORIGINAL_NONEMPTY_CURSOR_REQUIRED','REAL_SYNTHETIC_POSITIVE_FAMILY_REQUIRED','ORIGINAL_CALL_AND_RECOVERY_RESERVE_REQUIRED','ORIGINAL_RECEIPT_CHANGED_OR_MISSING']);
 return allowed.has(error?.message)?error.message:error?.code==='ERR_ASSERTION'?'OTHER_ASSERTION':'OTHER_ERROR';
}

try{
 stage='BOUNDED_PHYSICAL_FILE_PREPARATION';
 const physicalPreparation=await runOwnedPreparationBatches({directory,keys,started,candidateSha:physicalBatchReleaseSha({}),onProgress:value=>Object.assign(progress,value)});
 let setupCalls=physicalPreparation.workCalls,ready=physicalPreparation.ready,producer;
 db=createOwnedFileDb({url:pathToFileURL(join(directory,'physical','data')).href,phase4Keys:keys});assert.equal(db.raw.protocol,'file');await db.admitRuntime();
 assert.equal((await db.raw.execute('SELECT max(version) n FROM schema_version')).rows[0].n,35);
 assert.equal((await db.raw.execute('PRAGMA quick_check')).rows[0].quick_check,'ok');
 const parentFileSnapshot=await fingerprintOwnedFile(db,keys);assert.deepEqual(parentFileSnapshot,physicalPreparation.snapshot,'FINAL_CROSS_PROCESS_FILE_STATE_CHANGED');
 assert.ok(performance.now()-started<120000,'BOUNDED_SETUP_AND_RECOVERY_RESERVE_REQUIRED');
 stage='VERIFY_GENUINE_FILE_PREPARATION';
 assert.equal(ready,true,'ORIGINAL_NONEMPTY_CURSOR_REQUIRED');
 assert.equal((await db.raw.execute("SELECT count(*) n FROM phase4_jobs WHERE state='COMPLETED' AND execution_mode='LIVE'")).rows[0].n,1);
 const positiveEpisodeRows=Number((await db.raw.execute("SELECT count(*) n FROM observation_episodes WHERE user_id='a' AND execution_mode='LIVE' AND subject_key='recovery_score'")).rows[0].n);assert.ok(positiveEpisodeRows>=1,'REAL_SYNTHETIC_POSITIVE_FAMILY_REQUIRED');
 const before=await allRows('stage8_live_executions'),beforeReceipts=await allRows('stage8_live_execution_work_receipts');assert.equal(before.length,setupCalls);assert.ok(beforeReceipts.length>0);for(const r of before){assert.equal(r.state,'FINALIZED_SUCCESS');verifyLiveExecutionResult(keys,r);}
 const schemaBefore=(await db.raw.execute("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name")).rows.map(canonicalRow);
 const applicationTables=(await db.raw.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")).rows.map(r=>r.name);
 const fileRows=new Map();let retainedBytes=0;
 for(const table of applicationTables){assert.match(table,/^[a-z_][a-z0-9_]*$/);const rows=(await db.raw.execute('SELECT * FROM '+table)).rows.map(canonicalRow).sort();retainedBytes+=rows.reduce((sum,r)=>sum+Buffer.byteLength(r),0);assert.ok(retainedBytes<=32*1024*1024,'FILE_SNAPSHOT_BOUNDED');fileRows.set(table,rows);}
 await new Promise(r=>setImmediate(r));await new Promise(r=>setImmediate(r));await db.close();db=null;await new Promise(r=>setImmediate(r));await new Promise(r=>setImmediate(r));
 progress.fileClientClosed=1;
 for(const suffix of ['-wal','-shm']){let value;try{value=await stat(join(directory,'physical','data')+suffix);}catch(error){if(error.code!=='ENOENT')throw error;}assert.ok(!value||value.size===0,'FILE_WAL_NOT_JOINED');}
 assert.ok(performance.now()-started<120000,'BOUNDED_SETUP_AND_RECOVERY_RESERVE_REQUIRED');
 // Fresh parent connection opens only after every physical preparation child
 // joins. This replaces the redundant VERIFY child, never its integrity gate.
 // The receipt is emitted only after full typed rows/schema, close and WAL/SHM.
 const parentFileVerification={contract:'fresh-parent-owned-file-verification-v1',candidateSha:physicalBatchReleaseSha({}),parentPID:process.pid,
  finalWorkerPID:physicalPreparation.evidence.at(-1).pid,finalWorkerOrdinal:physicalPreparation.evidence.at(-1).ordinal,
  lastWorkerDescriptorSHA256:physicalPreparation.evidence.at(-1).packet.descriptorSHA256,snapshot:parentFileSnapshot,schemaVersion:35,
  freshAdmissionVerified:true,quickCheckPassed:true,authenticatedLastChildFingerprintMatches:true,allTypedApplicationRowsAndSchemaCaptured:true,
  fileClientClosed:true,WALAndSHMVerified:true,applicationTables:applicationTables.length,elapsedMs:performance.now()-started};
 assert.ok(parentFileVerification.elapsedMs<120000,'BOUNDED_SETUP_AND_RECOVERY_RESERVE_REQUIRED');
 stage='ONE_SQLD_LEGACY_STARTUP';
 server=spawn('/usr/local/bin/isolated-sqld',['-d',join(directory,'physical'),'--http-listen-addr','127.0.0.1:18080','--no-welcome'],{stdio:['ignore',log.fd,log.fd],env:{PATH:process.env.PATH,HOME:'/tmp',LANG:'C.UTF-8'}});server.on('error',()=>{serverError=true;});
 for(let i=0;i<40;i++){if(serverError||server.exitCode!==null)throw Error('OWN_SERVER_EXITED');try{const r=await nativeFetch('http://127.0.0.1:18080/v2/pipeline',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({requests:[{type:'execute',stmt:{sql:'SELECT 1',want_rows:false}},{type:'close'}]})});if(r.ok&&(await r.json()).results?.[0]?.type==='ok')break;}catch{}if(i===39)throw Error('OWN_SERVER_NOT_READY');await new Promise(r=>setTimeout(r,100));}
 stage='GENUINE_NATIVE_EOF';b=observer();db=createDb({url:'http://127.0.0.1:18080',phase4Keys:keys,fetch:b.fetch});stage='FULL_TYPED_APPLICATION_FILE_HANDOFF_READBACK';
 const schemaAfter=(await db.raw.execute("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name")).rows.map(canonicalRow);
 for(const row of schemaBefore)assert.ok(schemaAfter.includes(row),'ORIGINAL_SCHEMA_CHANGED');
 for(const table of applicationTables)assert.deepEqual((await db.raw.execute('SELECT * FROM '+table)).rows.map(canonicalRow).sort(),fileRows.get(table));
 assert.equal((await db.raw.execute('PRAGMA quick_check')).rows[0].quick_check,'ok');
 assert.deepEqual(await allRows('stage8_live_executions'),before);assert.deepEqual(await allRows('stage8_live_execution_work_receipts'),beforeReceipts);
 progress.originalApplicationTablesPreserved=applicationTables.length;progress.fullTypedRowsPreserved=1;fileRows.clear();
 producer=await createStage8LiveProducer({db,keys,admission:await db.admitRuntime(),userIds:['a'],enabled:()=>true,eligible:id=>id==='a'});
 stage='GENUINE_NATIVE_EOF';assert.ok(performance.now()-started<180000,'ORIGINAL_CALL_AND_RECOVERY_RESERVE_REQUIRED');b.observer.setPhase('GENUINE_ORIGINAL_PRODUCER_CALL','ORIGINAL_PRODUCER_RUN',1);latency=true;const at=performance.now();
 const result=await producer.run({userId:'a',requestId:'synthetic-file-prepared-eof-original'}),eofMs=performance.now()-at;latency=false;
 assert.equal(result.replayed,false);assert.equal(result.result.outcome,'COMPLETE');assert.equal(result.result.remainingJobs,0);assert.equal(result.result.jobsCompleted,1);assert.ok(eofMs<45000);
 b.observer.setPhase('READBACK','READBACK');
 const jobs=await allRows('phase4_jobs');assert.equal(jobs.length,2);for(const r of jobs){assert.equal(r.state,'COMPLETED');assert.equal(r.completed_generation,r.requested_generation);assert.equal(r.scope_kind,'NONE');assert.equal(r.lease_owner,null);assert.equal(r.attempt,0);}
 const final=await allRows('stage8_live_executions');assert.equal(final.length,setupCalls+1);for(const r of final){assert.equal(r.state,'FINALIZED_SUCCESS');verifyLiveExecutionResult(keys,r);}for(const r of before)assert.ok(final.some(x=>JSON.stringify(x)===JSON.stringify(r)));
 const receipts=await allRows('stage8_live_execution_work_receipts');for(const r of beforeReceipts)assert.ok(receipts.some(x=>JSON.stringify(x)===JSON.stringify(r)),'ORIGINAL_RECEIPT_CHANGED_OR_MISSING');assert.equal((await allRows('stage8_live_publications')).length,1);
 let sourceRows=0;for(const table of Object.values(OFFLINE_LIVE_TABLES))sourceRows+=Number((await db.raw.execute('SELECT count(*) n FROM '+table)).rows[0].n);assert.equal(sourceRows,160);assert.equal((await allRows('outbound_messages')).length,0);
 stage='EXACT_ORIGINAL_IDENTITY_REPLAY';latency=true;b.observer.setPhase('EXACT_ORIGINAL_REPLAY','ORIGINAL_REQUEST_REPLAY');const replay=await producer.run({userId:'a',requestId:'synthetic-file-prepared-eof-original'});latency=false;assert.equal(replay.replayed,true);assert.deepEqual(replay.result,result.result);assert.deepEqual(await allRows('stage8_live_executions'),final);assert.deepEqual(await allRows('stage8_live_execution_work_receipts'),receipts);
 stage='JOINED_CLIENT_CLEANUP';b.observer.setPhase('CLEANUP','CLEANUP');const bFinal=await closeClient(b),eof=bFinal.bins.GENUINE_ORIGINAL_PRODUCER_CALL;
 observeEOFCounters(bFinal,true);
 progress.check='EOF_REQUEST_ERRORS';assert.equal(eof.requestErrors,0);progress.check='EOF_RESPONSE_ERRORS';assert.equal(eof.responseErrors,0);progress.check='EOF_UNKNOWN_REPLIES';assert.equal(eof.unknownReplies,0);progress.check='EOF_TX_OPEN';assert.equal(eof.transactions.open,0);progress.check='EOF_TX_UNKNOWN';assert.equal(eof.transactions.unknownTerminal,0);progress.check='EOF_TX_5S_COUNT';assert.equal(eof.transactions.atOrAbove5s,0);progress.check='EOF_TX_BEGIN_AND_MAX';assert.ok(eof.transactions.begun>0&&eof.transactions.maxDurationUpperBoundMs<5000);
 report={preparationLifecycle:'PHYSICAL_JOINED_BATCHES_FRESH_PARENT_VERIFIED',parentFileVerification,physicalPreparationBatches:physicalPreparation.batches,physicalPreparationChildrenJoined:physicalPreparation.physicalChildrenJoined,allPhysicalBatchAcksAndResourceSamplesVerified:true,physicalPreparationEvidence:physicalPreparation.evidence,contract:'one-owned-file-batched-parent-verified-native-hrana-positive-eof-component-v1',status:'PASS_FILE_PREPARED_NATIVE_SQLD_EOF_COMPONENT_ONLY',preparationTransport:'OWNED_NATIVE_FILE_NOT_HTTP',filePreparationBudgetMs:120000,sourceHealthRows:sourceRows,positiveEpisodeRows,users:1,jobsCompleted:2,setupProducerCalls:setupCalls,setupProgress:{...progress},originalApplicationTablesPreserved:applicationTables.length,allOriginalTypedApplicationRowsPreserved:true,fileClientClosed:true,original115msCalls:1,exactOriginalReplays:1,exactReplayLatencyMs:115,eofMs,httpRequests:eof.requests,statementCount:eof.submittedStatements,transactions:eof.transactions.begun,maxObservedTransactionUpperBoundMs:eof.transactions.maxDurationUpperBoundMs,originalReceiptCount:beforeReceipts.length,allOriginalExecutionsAndReceiptsPreserved:true,exactReplayVerified:true,finalClientTerminalComplete:bFinal.adapter.terminalComplete,finalRetainedStreams:bFinal.adapter.retainedStreams,physicalTerminalObservationComplete:bFinal.physicalTerminalObservationComplete,optionalTransactionSamplesComplete:bFinal.transactionSampleCoverageComplete,addedLatencyMs:115,absoluteServerDeadline:'UNKNOWN',productionEvidence:false,originalHTTPPreparationQualified:false,denseCapacityQualified:false,representativeWholePipelineQualified:false,sixJobCompletionQualified:false,realUserInteraction:false};
}catch(error){capturePreparationProgress(progress.preparationSnapshotState==='TERMINAL');failure={stage,type:error.name,code:/^[A-Z0-9_]{1,80}$/.test(error.code??'')?error.code:'OTHER',classification:failureClassification(error),progress:{...progress},elapsedMs:performance.now()-started};console.log('STAGE6_FILE_PREPARED_NATIVE_EOF_FAILURE '+JSON.stringify(failure));}
finally{
 latency=false;
 try{if(db){if(db.raw.protocol==='file'){await new Promise(r=>setImmediate(r));await new Promise(r=>setImmediate(r));await db.close();db=null;await new Promise(r=>setImmediate(r));await new Promise(r=>setImmediate(r));}else await closeClient(b??a,{finalObservation:true});}closed=(!a||transportIsJoined(a.snapshot()))&&(!b||transportIsJoined(b.snapshot()));}
 catch{closed=false;}
 if(!server){await log.close();}
 else if(closed&&server.exitCode===null&&!serverError){const exit=once(server,'exit');server.kill('SIGTERM');const terminal=await exit;assert.ok(terminal[0]===0||terminal[1]==='SIGTERM');await log.close();await rm(directory,{recursive:true,force:true});}
 else if(server.exitCode!==null){closed=false;await log.close();}
 else{console.log('STAGE6_FILE_PREPARED_NATIVE_EOF_UNRESOLVED '+JSON.stringify({stage,productionEvidence:false}));await new Promise(()=>{});}
}
console.log('STAGE6_FILE_PREPARED_NATIVE_EOF_TERMINAL '+JSON.stringify({closed,ownedServerExited:server!==null&&(server.exitCode!==null||server.signalCode!==null),clientTerminalComplete:(b??a)?.snapshot().adapter.terminalComplete===true,retainedStreams:(b??a)?.snapshot().adapter.retainedStreams??null,physicalTerminalObservationComplete:(b??a)?.snapshot().physicalTerminalObservationComplete===true}));
assert.equal(closed,true,'JOINED_NATIVE_SERVER_REQUIRED');assert.equal(failure,null,JSON.stringify(failure));assert.ok(report);report.elapsedMs=performance.now()-started;report.ownedServerExited=server!==null&&(server.exitCode!==null||server.signalCode!==null);console.log('STAGE6_FILE_PREPARED_NATIVE_EOF_RESULT '+JSON.stringify(report));
