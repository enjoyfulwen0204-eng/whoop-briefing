// One fresh synthetic nonempty SQLD database. Bounded canonical preparations,
// one original115ms final EOF and exact identity replay. No Production data or authority.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,open,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PipelineRespBody} from '../node_modules/@libsql/hrana-client/lib-esm/http/json_decode.js';
import {createDb} from '../src/db.js';
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
const directory=await mkdtemp(join(tmpdir(),'stage6-real-positive-hrana-eof-')),log=await open(join(directory,'sqld.log'),'wx',0o600),started=performance.now();
const server=spawn('/usr/local/bin/isolated-sqld',['-d',join(directory,'physical'),'--http-listen-addr','127.0.0.1:18080','--no-welcome'],{stdio:['ignore',log.fd,log.fd],env:{PATH:process.env.PATH,HOME:'/tmp',LANG:'C.UTF-8'}});
let serverError=false;server.on('error',()=>{serverError=true;});
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
async function closeClient(transport){if(db){await db.close();db=null;}for(let i=0;i<3;i++){await new Promise(r=>setImmediate(r));await transport.awaitIdle();}const s=transport.snapshot();assert.equal(s.adapter.terminalComplete,true);assert.equal(s.adapter.retainedStreams,0);assert.equal(s.physicalTerminalObservationComplete,true);return s;}
const allRows=async table=>(await db.raw.execute('SELECT * FROM '+table+' ORDER BY 1,2')).rows;
function preparationBudgetFor(pending,catalog){
 if(!Array.isArray(catalog)||catalog.length<1||catalog.length>512||new Set(catalog).size!==catalog.length)throw Error('SYNTHETIC_PROGRESS_CATALOG_INVALID');
 for(const row of pending){
  const index=row.full_scan_cursor===null?-1:catalog.indexOf(row.full_scan_cursor);
  if(row.full_scan_cursor!==null&&index<0)throw Error('SYNTHETIC_PROGRESS_CURSOR_INVALID');
  const remaining=catalog.length-index-1;
  if(remaining<=6)return {maxItems:1,maxItemsPerTenant:1};
 }
 return {maxItemsPerTenant:6};
}

function failureClassification(error){
 const allowed=new Set(['BOUNDED_SETUP_AND_RECOVERY_RESERVE_REQUIRED','ORIGINAL_NONEMPTY_CURSOR_REQUIRED','REAL_SYNTHETIC_POSITIVE_FAMILY_REQUIRED','ORIGINAL_CALL_AND_RECOVERY_RESERVE_REQUIRED','ORIGINAL_RECEIPT_CHANGED_OR_MISSING']);
 return allowed.has(error?.message)?error.message:error?.code==='ERR_ASSERTION'?'OTHER_ASSERTION':'OTHER_ERROR';
}

try{
 for(let i=0;i<40;i++){if(serverError||server.exitCode!==null)throw Error('OWN_SERVER_EXITED');try{const r=await nativeFetch('http://127.0.0.1:18080/v2/pipeline',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({requests:[{type:'execute',stmt:{sql:'SELECT 1',want_rows:false}},{type:'close'}]})});if(r.ok&&(await r.json()).results?.[0]?.type==='ok')break;}catch{}if(i===39)throw Error('OWN_SERVER_NOT_READY');await new Promise(r=>setTimeout(r,100));}
 stage='SYNTHETIC_SETUP';a=observer();db=createDb({url:'http://127.0.0.1:18080',phase4Keys:keys,fetch:a.fetch});assert.equal(db.raw.protocol,'http');
 assert.equal((await db.raw.execute("SELECT count(*) n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")).rows[0].n,0);
 await db.migrate({targetVersion:35});const foundation=await createPhase4Foundation({db,keys,admission:await db.admitRuntime()});
 await db.createUser({id:'a',displayName:'Synthetic native EOF',timezone:'Asia/Taipei',status:'ACTIVE'});await db.ensureOnboarding('a',{state:'READY'});await foundation.initializeTenant('a','SHADOW');const input=offlineLiveFixtureInput({profile:'dense',userId:'a',asOf:Date.now()-3600000});for(let i=0;i<input.sources.recovery.length;i++)input.sources.recovery[i].recovery_score=i===0?15:40+(i%5)*5;await db.transaction(()=>seedBodyInput(db,input));
 stage='BOUNDED_CANONICAL_NONEMPTY_PREPARATIONS';progress.preparationSnapshotState='PROVISIONAL';a.observer.setPhase('GENUINE_ORIGINAL_PRODUCER_CALL','ORIGINAL_PRODUCER_RUN',1);
 let producer=await createStage8LiveProducer({db,keys,admission:await db.admitRuntime(),userIds:['a'],enabled:()=>true,eligible:id=>id==='a'});
 let setupCalls=0,ready=false;const last=JSON.stringify(['workout','workout-39']);
 const admission=await db.admitRuntime(),releaseSha=runningReleaseSha({}),configProof=keys.lookup(['stage8-live-server-config-v1',releaseSha,35,['a'],'phase4-stage5-canonical-v1']);
 const capability=await authorizeStage8LiveProducer({db,keys,admission,releaseSha,configProof,enabled:()=>true,eligible:id=>id==='a'});
 const core=await buildPhase4Core({keys,admission,liveProducingAuthority:capability,processing:{client:db.raw,transaction:db.transaction,active:db.processingTransactionActive,assertFences:db.assertRuntimeFences,afterCommit:db.afterProcessingCommit,afterCompletion:db.afterProcessingCompletion},authorizeMode(mode,client,id){assert.equal(mode,'LIVE');assert.equal(client,db.raw);assert.equal(id,'a');}});
 await core.initializeTenant('a','LIVE');const worker=await createPhase4Stage6({db,keys,admission,executionMode:'LIVE',liveProducingAuthority:capability});await worker.rolloutAlgorithm({userId:'a'});
 // Read the actual canonical ordered metadata catalog with the original
 // scoped input enumerator. It selects source identities, not health values.
 const inputs=createReanalysisInputs(core,composePhase4Stores(core));let sourceCatalog=[],catalogContext,catalogFailure,catalogFailed=false;
 try{
  catalogContext=await core.capture('a',{executionMode:'LIVE',providerRequired:true});let cursor=null;
  for(let page=0;page<6;page++){
   const rows=await core.run(catalogContext,()=>inputs.enumerate(catalogContext,cursor,100));
   sourceCatalog.push(...rows.map(r=>r.cursor));assert.ok(sourceCatalog.length<=512,'SYNTHETIC_PROGRESS_CATALOG_INVALID');
   if(rows.length<100)break;cursor=rows.at(-1).cursor;
  }
 }catch(error){catalogFailed=true;catalogFailure=error;}
 const catalogCleanup=createExecutionBudget({budgetMs:5000});
 try{if(catalogContext)await withExecutionBudget(catalogCleanup,()=>core.transaction(()=>core.contextRegistry.release(catalogContext),{readOnly:true}));}
 catch(error){if(!catalogFailed){catalogFailed=true;catalogFailure=error;}}
 finally{catalogCleanup.cancel();catalogCleanup.close();}
 if(catalogFailed)throw catalogFailure;
 progress.catalogRows=sourceCatalog.length;assert.equal(sourceCatalog.length,161,'SYNTHETIC_PROGRESS_CATALOG_INVALID');
 let preparationContexts=[],preparationBudget={maxItemsPerTenant:6};
 const runPreparationWork=createStage8LiveExecutionRunner({db,keys,capability,capture:async id=>{const ctx=await core.capture(id,{executionMode:'LIVE',providerRequired:true});preparationContexts.push(ctx);return ctx;},assertContext:ctx=>core.assertContext(ctx),work:async()=>{const v=await worker.drain({userId:'a',budget:preparationBudget});return {outcome:v.outcome,itemsProcessed:v.processedItems,jobsCompleted:v.completedJobs,jobsFailed:v.failedJobs,remainingJobs:v.remainingJobs,unitsCommitted:v.unitsCommitted};}});
 // Match the real producer's separately bounded post-settlement context cleanup.
 // It grants no new computation time and preserves the original work failure.
 async function runPreparation(request){
  preparationContexts=[];let result,failure,failed=false;
  try{result=await runPreparationWork(request);}catch(error){failed=true;failure=error;}
  const cleanup=createExecutionBudget({budgetMs:5000});
  try{await withExecutionBudget(cleanup,async()=>{for(const ctx of preparationContexts)await core.transaction(()=>core.contextRegistry.release(ctx),{readOnly:true});});}
  catch(error){if(!failed){failed=true;failure=error;}}
  finally{cleanup.cancel();cleanup.close();}
  if(failed)throw failure;return result;
 }
 for(let i=0;i<512;i++){
  const pending=(await db.raw.execute("SELECT state,full_scan_cursor FROM phase4_jobs WHERE execution_mode='LIVE' AND state<>'COMPLETED'")).rows;
  if(pending.length===1&&pending[0].full_scan_cursor===last){ready=true;break;}
  if(pending.length===0)break;
  preparationBudget=preparationBudgetFor(pending,sourceCatalog);progress.lastPendingJobs=pending.length;progress.lastBudgetPerTenant=preparationBudget.maxItemsPerTenant;progress.startedPreparations++;progress.check='CANONICAL_WORK';
  const result=await runPreparation({userId:'a',requestId:'synthetic-native-positive-hybrid-eof-prepare-'+i});setupCalls++;progress.completedPreparations=setupCalls;progress.sourceAcknowledgments+=result.result.itemsProcessed;progress.unitsCommitted+=result.result.unitsCommitted;
  capturePreparationProgress();
  progress.check='NOT_REPLAYED';assert.equal(result.replayed,false);progress.check='NO_FAILED_JOBS';assert.equal(result.result.jobsFailed,0);progress.check='SETUP_TIME';assert.ok(performance.now()-started<320000,'BOUNDED_SETUP_AND_RECOVERY_RESERVE_REQUIRED');
 }
 a.observer.setPhase('READBACK','READBACK');
 assert.equal(ready,true,'ORIGINAL_NONEMPTY_CURSOR_REQUIRED');
 assert.equal((await db.raw.execute("SELECT count(*) n FROM phase4_jobs WHERE state='COMPLETED' AND execution_mode='LIVE'")).rows[0].n,1);
 const positiveEpisodeRows=Number((await db.raw.execute("SELECT count(*) n FROM observation_episodes WHERE user_id='a' AND execution_mode='LIVE' AND subject_key='recovery_score'")).rows[0].n);assert.ok(positiveEpisodeRows>=1,'REAL_SYNTHETIC_POSITIVE_FAMILY_REQUIRED');
 const before=await allRows('stage8_live_executions'),beforeReceipts=await allRows('stage8_live_execution_work_receipts');assert.equal(before.length,setupCalls);assert.ok(beforeReceipts.length>0);for(const r of before){assert.equal(r.state,'FINALIZED_SUCCESS');verifyLiveExecutionResult(keys,r);}
 const aFinal=await closeClient(a),preparation=aFinal.bins.GENUINE_ORIGINAL_PRODUCER_CALL,preparationTransactions=preparation.transactions;
 progress.check='PREPARATION_TRANSACTION_BOUND';capturePreparationProgress(true);assert.equal(progress.preparationSnapshotState,'TERMINAL');
 assert.equal(preparation.requestErrors,0);assert.equal(preparation.responseErrors,0);assert.equal(preparation.unknownReplies,0);assert.ok(preparationTransactions.begun>0);assert.equal(preparationTransactions.open,0);assert.equal(preparationTransactions.unknownTerminal,0);assert.equal(preparationTransactions.begun,preparationTransactions.committed+preparationTransactions.rolledBack);assert.equal(preparationTransactions.atOrAbove5s,0);assert.ok(preparationTransactions.maxDurationUpperBoundMs>0&&preparationTransactions.maxDurationUpperBoundMs<5000);
 stage='GENUINE_NATIVE_EOF';b=observer();db=createDb({url:'http://127.0.0.1:18080',phase4Keys:keys,fetch:b.fetch});producer=await createStage8LiveProducer({db,keys,admission:await db.admitRuntime(),userIds:['a'],enabled:()=>true,eligible:id=>id==='a'});
 assert.ok(performance.now()-started<350000,'ORIGINAL_CALL_AND_RECOVERY_RESERVE_REQUIRED');b.observer.setPhase('GENUINE_ORIGINAL_PRODUCER_CALL','ORIGINAL_PRODUCER_RUN',1);latency=true;const at=performance.now();
 const result=await producer.run({userId:'a',requestId:'synthetic-native-positive-hybrid-eof-original'}),eofMs=performance.now()-at;latency=false;
 assert.equal(result.replayed,false);assert.equal(result.result.outcome,'COMPLETE');assert.equal(result.result.remainingJobs,0);assert.equal(result.result.jobsCompleted,1);assert.ok(eofMs<45000);
 b.observer.setPhase('READBACK','READBACK');
 const jobs=await allRows('phase4_jobs');assert.equal(jobs.length,2);for(const r of jobs){assert.equal(r.state,'COMPLETED');assert.equal(r.completed_generation,r.requested_generation);assert.equal(r.scope_kind,'NONE');assert.equal(r.lease_owner,null);assert.equal(r.attempt,0);}
 const final=await allRows('stage8_live_executions');assert.equal(final.length,setupCalls+1);for(const r of final){assert.equal(r.state,'FINALIZED_SUCCESS');verifyLiveExecutionResult(keys,r);}for(const r of before)assert.ok(final.some(x=>JSON.stringify(x)===JSON.stringify(r)));
 const receipts=await allRows('stage8_live_execution_work_receipts');for(const r of beforeReceipts)assert.ok(receipts.some(x=>JSON.stringify(x)===JSON.stringify(r)),'ORIGINAL_RECEIPT_CHANGED_OR_MISSING');assert.equal((await allRows('stage8_live_publications')).length,1);
 let sourceRows=0;for(const table of Object.values(OFFLINE_LIVE_TABLES))sourceRows+=Number((await db.raw.execute('SELECT count(*) n FROM '+table)).rows[0].n);assert.equal(sourceRows,160);assert.equal((await allRows('outbound_messages')).length,0);
 stage='EXACT_ORIGINAL_IDENTITY_REPLAY';latency=true;b.observer.setPhase('EXACT_ORIGINAL_REPLAY','ORIGINAL_REQUEST_REPLAY');const replay=await producer.run({userId:'a',requestId:'synthetic-native-positive-hybrid-eof-original'});latency=false;assert.equal(replay.replayed,true);assert.deepEqual(replay.result,result.result);assert.deepEqual(await allRows('stage8_live_executions'),final);assert.deepEqual(await allRows('stage8_live_execution_work_receipts'),receipts);
 stage='JOINED_CLIENT_CLEANUP';b.observer.setPhase('CLEANUP','CLEANUP');const bFinal=await closeClient(b),eof=bFinal.bins.GENUINE_ORIGINAL_PRODUCER_CALL;
 assert.equal(eof.requestErrors,0);assert.equal(eof.responseErrors,0);assert.equal(eof.unknownReplies,0);assert.equal(eof.transactions.open,0);assert.equal(eof.transactions.unknownTerminal,0);assert.equal(eof.transactions.atOrAbove5s,0);assert.ok(eof.transactions.begun>0&&eof.transactions.maxDurationUpperBoundMs<5000);
 report={contract:'one-native-hrana-positive-hybrid-eof-regression-v1',status:'PASS_NATIVE_SQLD_POSITIVE_EOF_ONE_USER_ONLY',sourceHealthRows:sourceRows,positiveEpisodeRows,users:1,jobsCompleted:2,setupProducerCalls:setupCalls,setupProgress:{...progress},preparationTransactions,preparationAddedLatencyMs:0,original115msCalls:1,exactOriginalReplays:1,exactReplayLatencyMs:115,eofMs,httpRequests:eof.requests,statementCount:eof.submittedStatements,transactions:eof.transactions.begun,maxObservedTransactionUpperBoundMs:eof.transactions.maxDurationUpperBoundMs,originalReceiptCount:beforeReceipts.length,allOriginalExecutionsAndReceiptsPreserved:true,exactReplayVerified:true,priorClientTerminalComplete:aFinal.adapter.terminalComplete,finalClientTerminalComplete:bFinal.adapter.terminalComplete,finalRetainedStreams:bFinal.adapter.retainedStreams,physicalTerminalObservationComplete:bFinal.physicalTerminalObservationComplete,optionalTransactionSamplesComplete:bFinal.transactionSampleCoverageComplete,addedLatencyMs:115,absoluteServerDeadline:'UNKNOWN',productionEvidence:false,denseCapacityQualified:false,representativeWholePipelineQualified:false,realUserInteraction:false};
}catch(error){capturePreparationProgress(progress.preparationSnapshotState==='TERMINAL');failure={stage,type:error.name,code:/^[A-Z0-9_]{1,80}$/.test(error.code??'')?error.code:'OTHER',classification:failureClassification(error),progress:{...progress},elapsedMs:performance.now()-started};console.log('STAGE6_NATIVE_POSITIVE_EOF_FAILURE '+JSON.stringify(failure));}
finally{
 latency=false;
 try{if(db)await closeClient(b??a);closed=(!a||a.snapshot().adapter.terminalComplete)&&(!b||b.snapshot().adapter.terminalComplete);}
 catch{closed=false;}
 if(closed&&server.exitCode===null&&!serverError){const exit=once(server,'exit');server.kill('SIGTERM');const terminal=await exit;assert.ok(terminal[0]===0||terminal[1]==='SIGTERM');await log.close();await rm(directory,{recursive:true,force:true});}
 else if(server.exitCode!==null){closed=false;await log.close();}
 else{console.log('STAGE6_NATIVE_POSITIVE_EOF_UNRESOLVED '+JSON.stringify({stage,productionEvidence:false}));await new Promise(()=>{});}
}
console.log('STAGE6_NATIVE_POSITIVE_EOF_TERMINAL '+JSON.stringify({closed,ownedServerExited:server.exitCode!==null||server.signalCode!==null,clientTerminalComplete:(b??a)?.snapshot().adapter.terminalComplete===true,retainedStreams:(b??a)?.snapshot().adapter.retainedStreams??null,physicalTerminalObservationComplete:(b??a)?.snapshot().physicalTerminalObservationComplete===true}));
assert.equal(closed,true,'JOINED_NATIVE_SERVER_REQUIRED');assert.equal(failure,null,JSON.stringify(failure));assert.ok(report);report.elapsedMs=performance.now()-started;report.ownedServerExited=true;console.log('STAGE6_NATIVE_POSITIVE_EOF_RESULT '+JSON.stringify(report));
