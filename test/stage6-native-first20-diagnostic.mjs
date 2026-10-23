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
const directory=await mkdtemp(join(tmpdir(),'stage6-real-first20-hrana-')),log=await open(join(directory,'sqld.log'),'wx',0o600),started=performance.now();
const server=spawn('/usr/local/bin/isolated-sqld',['-d',join(directory,'physical'),'--http-listen-addr','127.0.0.1:18080','--no-welcome'],{stdio:['ignore',log.fd,log.fd],env:{PATH:process.env.PATH,HOME:'/tmp',LANG:'C.UTF-8'}});
let serverError=false;server.on('error',()=>{serverError=true;});
const networkFetch=globalThis.fetch.bind(globalThis);let latency=false,db,a,b,stage='SERVER_START',failure=null,report=null,closed=false;
const progress={startedPreparations:0,completedPreparations:0,check:'NOT_STARTED'};
const mappedCodes=new Set(['INVARIANT_VIOLATION','CALCULATION_FAILED','STALE_GENERATION','SOURCE_UNAVAILABLE','AUTH_CHANGED','LIFECYCLE_CHANGED','CONTENT_REDACTED','LEASE_LOST','REPAIR_REQUIRED']);
const kinds=new Set(['RECOMPUTE_DERIVED','REPAIR_CURRENTNESS']);
const protocolCodes=new Set(['SQLITE_BUSY','SQLITE_LOCKED','SQLITE_ERROR','SQLITE_CONSTRAINT','SQLITE_CONSTRAINT_UNIQUE','TRANSACTION_TIMEOUT','TRANSACTION_CLOSED','STREAM_EXPIRED','STREAM_NOT_FOUND','HRANA_PROTO_ERROR','INTERNAL','TOO_MANY_REQUESTS']);
const protocol={responses:0,non2xx:0,parseUnknown:0,errors:0,codes:{}};
function safeProtocolCode(value){return protocolCodes.has(value)?value:'OTHER';}
function safeMappedCode(value){return mappedCodes.has(value)?value:'OTHER';}
function safeKind(value){return kinds.has(value)?value:'OTHER';}
function noteProtocolError(error,requestOrdinal){protocol.errors++;const code=safeProtocolCode(error?.code);protocol.codes[code]=(protocol.codes[code]??0)+1;if(Number.isSafeInteger(requestOrdinal)&&requestOrdinal>=1&&requestOrdinal<=20){const event=Object.freeze({layer:'HTTP_PROTOCOL',code,ordinal:requestOrdinal,elapsedMs:performance.now()-started});firstPreparationProtocolError??=event;firstProtocolErrors[requestOrdinal]??=event;}}
const preparations=[];let lastWorker=null,activeOrdinal=0,firstPreparationProtocolError=null;const firstProtocolErrors=Array(21).fill(null);

const nativeFetch=async(input,init)=>{const requestOrdinal=activeOrdinal;const r=new Request(input,init),url=new URL(r.url);assert.equal(url.origin,'http://127.0.0.1:18080');assert.equal(url.username,'');assert.equal(url.password,'');const response=await networkFetch(r,{signal:AbortSignal.any([r.signal,AbortSignal.timeout(10000)])});
 protocol.responses++;if(!response.ok)protocol.non2xx++;
 try{const raw=await response.clone().json();if(!Array.isArray(raw.results)||raw.results.length>4096)throw Error('DIAGNOSTIC_REPLY_UNKNOWN');for(const x of raw.results){if(x?.type==='error')noteProtocolError(x.error,requestOrdinal);if(x?.type==='ok'&&x.response?.type==='batch'){const errors=x.response.result?.step_errors;if(!Array.isArray(errors)||errors.length>4096)throw Error('DIAGNOSTIC_REPLY_UNKNOWN');for(const error of errors)if(error)noteProtocolError(error,requestOrdinal);}}}catch{protocol.parseUnknown++;}
 return response;};
const observer=()=>{const o=createAttribution();return createDiagnosticFetch({fetch:nativeFetch,decodePipelineReply:PipelineRespBody,observer:o,latencyEnabled:()=>latency});};
async function closeClient(transport){if(db){await db.close();db=null;}for(let i=0;i<3;i++){await new Promise(r=>setImmediate(r));await transport.awaitIdle();}const s=transport.snapshot();assert.equal(s.adapter.terminalComplete,true);assert.equal(s.adapter.retainedStreams,0);assert.equal(s.physicalTerminalObservationComplete,true);return s;}
const allRows=async table=>(await db.raw.execute('SELECT * FROM '+table+' ORDER BY 1,2')).rows;
try{
 for(let i=0;i<40;i++){if(serverError||server.exitCode!==null)throw Error('OWN_SERVER_EXITED');try{const r=await nativeFetch('http://127.0.0.1:18080/v2/pipeline',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({requests:[{type:'execute',stmt:{sql:'SELECT 1',want_rows:false}},{type:'close'}]})});if(r.ok&&(await r.json()).results?.[0]?.type==='ok')break;}catch{}if(i===39)throw Error('OWN_SERVER_NOT_READY');await new Promise(r=>setTimeout(r,100));}
 stage='SYNTHETIC_SETUP';a=observer();a.observer.setPhase('SETUP_SCHEMA1_TO35_SYNTHETIC_ONLY','UNKNOWN');db=createDb({url:'http://127.0.0.1:18080',phase4Keys:keys,fetch:a.fetch});assert.equal(db.raw.protocol,'http');
 assert.equal((await db.raw.execute("SELECT count(*) n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")).rows[0].n,0);
 await db.migrate({targetVersion:35});const foundation=await createPhase4Foundation({db,keys,admission:await db.admitRuntime()});
 await db.createUser({id:'a',displayName:'Synthetic native EOF',timezone:'Asia/Taipei',status:'ACTIVE'});await db.ensureOnboarding('a',{state:'READY'});await foundation.initializeTenant('a','SHADOW');const input=offlineLiveFixtureInput({profile:'dense',userId:'a',asOf:Date.now()-3600000});for(let i=0;i<input.sources.recovery.length;i++)input.sources.recovery[i].recovery_score=i===0?15:40+(i%5)*5;await db.transaction(()=>seedBodyInput(db,input));
 let producer=await createStage8LiveProducer({db,keys,admission:await db.admitRuntime(),userIds:['a'],enabled:()=>true,eligible:id=>id==='a'});
 stage='BOUNDED_CANONICAL_NONEMPTY_PREPARATIONS';let setupCalls=0;
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
 const runPreparationWork=createStage8LiveExecutionRunner({db,keys,capability,capture:async id=>{const ctx=await core.capture(id,{executionMode:'LIVE',providerRequired:true});preparationContexts.push(ctx);return ctx;},assertContext:ctx=>core.assertContext(ctx),work:async()=>{const v=await worker.drain({userId:'a',budget:preparationBudget});lastWorker={outcome:v.outcome,stopReason:v.stopReason,processedItems:v.processedItems,unitsCommitted:v.unitsCommitted,completedJobs:v.completedJobs,failedJobs:v.failedJobs,remainingJobs:v.remainingJobs,failures:v.failures.slice(0,8).map(x=>({kind:safeKind(x.jobKind),code:safeMappedCode(x.code)}))};console.log('STAGE6_NATIVE_FIRST20_WORKER_RETURNED '+JSON.stringify({ordinal:activeOrdinal,runnerSettled:false,worker:lastWorker,firstLegProtocolError:firstProtocolErrors[activeOrdinal]}));return {outcome:v.outcome,itemsProcessed:v.processedItems,jobsCompleted:v.completedJobs,jobsFailed:v.failedJobs,remainingJobs:v.remainingJobs,unitsCommitted:v.unitsCommitted};}});
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

 function projectJob(x){return {kind:safeKind(x.job_kind),state:['PENDING','RUNNING','RETRY_WAIT','COMPLETED','REPAIR_REQUIRED'].includes(x.state)?x.state:'OTHER',lastError:x.last_error_code===null?null:safeMappedCode(x.last_error_code),attempt:x.attempt,hasCursor:x.full_scan_cursor!==null,catalogCursorOrdinal:x.full_scan_cursor===null?-1:sourceCatalog.indexOf(x.full_scan_cursor)};}
 a.observer.setPhase('UNKNOWN','UNKNOWN');const prepStarted=performance.now(),protocolBefore=structuredClone(protocol);let observedWorkerFailure=false;
 for(let i=0;i<20;i++){
  const before=(await db.raw.execute("SELECT job_kind,state,last_error_code,attempt,full_scan_cursor FROM phase4_jobs WHERE execution_mode='LIVE' AND state<>'COMPLETED' ORDER BY job_kind")).rows.map(projectJob);activeOrdinal=i+1;
  progress.startedPreparations++;progress.check='CANONICAL_WORK';lastWorker=null;const at=performance.now();
  const result=await runPreparation({userId:'a',requestId:'synthetic-native-first20-diagnostic-'+i});setupCalls++;progress.completedPreparations=setupCalls;
  assert.equal(result.replayed,false);assert.ok(lastWorker);const snap=a.snapshot();preparations.push({ordinal:i+1,before,elapsedMs:performance.now()-at,...lastWorker,firstLegProtocolError:firstProtocolErrors[i+1],transportCumulativeAfter:{requests:snap.bins.UNKNOWN.requests,requestErrors:snap.bins.UNKNOWN.requestErrors,responseErrors:snap.bins.UNKNOWN.responseErrors,unknownReplies:snap.bins.UNKNOWN.unknownReplies,transactions:snap.bins.UNKNOWN.transactions}});console.log('STAGE6_NATIVE_FIRST20_SETTLED '+JSON.stringify(preparations.at(-1)));activeOrdinal=0;
  if(lastWorker.failedJobs>0){observedWorkerFailure=true;break;}
  assert.ok(performance.now()-prepStarted<260000,'FIRST20_WALL_BOUND_REQUIRED');
 }
 const prepSnapshot=a.snapshot();a.observer.setPhase('READBACK','READBACK');
 const jobs=(await db.raw.execute("SELECT job_kind,state,last_error_code,attempt,full_scan_cursor FROM phase4_jobs WHERE execution_mode='LIVE' ORDER BY job_kind")).rows.map(projectJob);
 report={contract:'one-native-first20-worker-diagnostic-v1',status:observedWorkerFailure?'DIAGNOSTIC_WORKER_FAILURE_OBSERVED':'DIAGNOSTIC_FIRST20_NO_WORKER_FAILURE',maxPreparations:20,preparations,jobs,protocolBeforePreparations:protocolBefore,protocolAfterPreparations:structuredClone(protocol),firstPreparationProtocolError,requestBoundProtocolErrors:firstProtocolErrors.filter(Boolean),preparationTransactions:prepSnapshot.bins.UNKNOWN.transactions,preparationRequests:prepSnapshot.bins.UNKNOWN.requests,preparationResponseErrors:prepSnapshot.bins.UNKNOWN.responseErrors,preparationRequestErrors:prepSnapshot.bins.UNKNOWN.requestErrors,preparationUnknownReplies:prepSnapshot.bins.UNKNOWN.unknownReplies,protocolCodeCoverage:'Native HTTP pipeline top-level and batch step error.code allowlist; OTHER/parseUnknown is not an absence-of-error proof',instrumentationChangesTiming:true,syntheticWHOOPRows:160,productionEvidence:false,EOFQualified:false,sixJobCompletionQualified:false,capacityQualified:false};console.log('STAGE6_NATIVE_FIRST20_OBSERVATION '+JSON.stringify(report));
}catch(error){failure={stage,type:['Error','AssertionError'].includes(error.name)?error.name:'OTHER',code:['SYNC_TIMEOUT','SYNC_CANCELLED','PHASE4_DRAIN_DEADLINE_REACHED','COMMIT_INDETERMINATE','RUNTIME_REPLACEMENT_REQUIRED','ERR_ASSERTION'].includes(error.code)?error.code:safeProtocolCode(error.code),progress:{...progress},elapsedMs:performance.now()-started};console.log('STAGE6_NATIVE_FIRST20_FAILURE '+JSON.stringify(failure));}
finally{
 latency=false;
 try{if(db)await closeClient(b??a);closed=(!a||a.snapshot().adapter.terminalComplete)&&(!b||b.snapshot().adapter.terminalComplete);}
 catch{closed=false;}
 if(closed&&server.exitCode===null&&!serverError){const exit=once(server,'exit');server.kill('SIGTERM');const terminal=await exit;assert.ok(terminal[0]===0||terminal[1]==='SIGTERM');await log.close();await rm(directory,{recursive:true,force:true});}
 else if(server.exitCode!==null){closed=false;await log.close();}
 else{console.log('STAGE6_NATIVE_FIRST20_UNRESOLVED '+JSON.stringify({stage,productionEvidence:false}));await new Promise(()=>{});}
}
console.log('STAGE6_NATIVE_FIRST20_TERMINAL '+JSON.stringify({closed,ownedServerExited:server.exitCode!==null||server.signalCode!==null,clientTerminalComplete:(b??a)?.snapshot().adapter.terminalComplete===true,retainedStreams:(b??a)?.snapshot().adapter.retainedStreams??null,physicalTerminalObservationComplete:(b??a)?.snapshot().physicalTerminalObservationComplete===true}));
assert.equal(closed,true,'JOINED_NATIVE_SERVER_REQUIRED');assert.equal(failure,null,JSON.stringify(failure));assert.ok(report);report.elapsedMs=performance.now()-started;console.log('STAGE6_NATIVE_FIRST20_RESULT '+JSON.stringify(report));
