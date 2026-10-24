// Explicit one-call EMPTY native diagnostic. No replay/convergence/capacity claim.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,readdirSync,realpathSync,existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {PipelineRespBody} from '../node_modules/@libsql/hrana-client/lib-esm/http/json_decode.js';
import {createDb} from '../src/db.js';
import {createPhase4Keys} from '../src/phase4Keys.js';
import {createPhase4Foundation} from '../src/phase4Foundation.js';
import {createStage8LiveProducer} from '../src/stage8LiveProducer.js';
import {verifyLiveExecutionResult} from '../src/stage8LiveExecution.js';
import {canonicalJson} from '../src/phase4EntityStore.js';
import {runningReleaseSha} from '../src/phase4Release.js';
import {createExecutionBudget,withExecutionBudget} from '../src/executionBudget.js';
import {withPhaseTelemetry} from '../src/executionTelemetry.js';
import {seedBodyInput} from './bodyEnergyFixture.js';
import {offlineLiveFixtureInput,OFFLINE_LIVE_RESOURCES,OFFLINE_LIVE_TABLES} from './stage8LiveLinuxFixture.js';
import {assertNativeResources,NATIVE_NODE} from './stage6-linux-native-contract.mjs';
import {createAttribution,safeFailureFrames,safeExecutionObservation} from './stage6-native-attribution.mjs';
import {createDiagnosticFetch} from './stage6-native-diagnostic-observer.mjs';
import {createDiagnosticWall,createDiagnosticTelemetrySink,observeOriginalResult,safeProgress,progressDelta,integer,digest,failureSourceSites} from './stage6-native-diagnostic-contract.mjs';
assert.equal(process.argv.length,3);assert.equal(process.argv[2],'one-original-empty-120s','EXPLICIT_DIAGNOSTIC_INTENT_REQUIRED');
const root=fileURLToPath(new URL('..',import.meta.url)),OUT='/qualification',text=path=>readFileSync(path,'utf8').trim();
assert.ok(existsSync('/.dockerenv'));assert.equal(realpathSync(process.cwd()),realpathSync(root));assert.equal(realpathSync(OUT),OUT);
for(const name of Object.keys(process.env))if(/^(?:GIT_|TURSO_|WHOOP_|TELEGRAM_|OPENROUTER_|PHASE4_|RENDER_|CLOUDFLARE_)/.test(name))assert.ok(!process.env[name],'EXTERNAL_ENVIRONMENT_FORBIDDEN');
const nativeHost=JSON.parse(text('/native-host-proof.json'));
const resources=()=>({node:process.version,platform:process.platform,architecture:process.arch,nativeHost,memoryMax:text('/sys/fs/cgroup/memory.max'),swapMax:text('/sys/fs/cgroup/memory.swap.max'),cpuMax:text('/sys/fs/cgroup/cpu.max'),interfaces:readdirSync('/sys/class/net').sort(),memoryPeak:text('/sys/fs/cgroup/memory.peak'),memoryEvents:text('/sys/fs/cgroup/memory.events')});
assertNativeResources(resources());assert.equal(process.version,NATIVE_NODE);assert.equal(nativeHost.diagnosticContract,'one-original-empty-120s-v1');
assert.match(nativeHost.nativeStartedMonotonicNs??'',/^[0-9]{10,30}$/);assert.equal(nativeHost.monotonicClock,'LINUX_CLOCK_MONOTONIC_SHARED_KERNEL');
const now=()=>Number(process.hrtime.bigint())/1e6,startedMonoMs=Number(BigInt(nativeHost.nativeStartedMonotonicNs))/1e6;
// Linux host/container share CLOCK_MONOTONIC; if the observed domain/start does not fit, refuse before DB work.
const wall=createDiagnosticWall({startedMonoMs,now}),abort=new AbortController();
const wallTimer=setTimeout(()=>abort.abort(Object.assign(Error('DIAGNOSTIC_WALL_EXHAUSTED'),{code:'SYNC_TIMEOUT'})),Math.max(1,Math.floor(wall.remaining())));
const sha=runningReleaseSha({}),keys=createPhase4Keys({lookupKey:Buffer.alloc(32,71),auditKey:Buffer.alloc(32,83)});assert.equal(nativeHost.candidateSha,sha);
const tracked=['src/db.js','src/phase4Reanalysis.js','src/stage8LiveProducer.js','src/stage8LiveExecution.js','src/stage8LivePublication.js','src/executionBudget.js','src/executionTelemetry.js','test/bodyEnergyFixture.js','test/stage8LiveLinuxFixture.js','test/stage6-linux-native-contract.mjs','test/stage6-linux-native-diagnostic.mjs','test/stage6-native-attribution.mjs','test/stage6-native-diagnostic-observer.mjs','test/stage6-native-diagnostic-contract.mjs'];
const sourceHashes=Object.fromEntries(tracked.map(p=>[p,digest(readFileSync(resolve(root,p)))]));
const observer=createAttribution({now}),sink=createDiagnosticTelemetrySink();let latency=false,phase='UNKNOWN',db,callSettled=true,cleanupJoined=false,closeCalled=false,callAcknowledgement='UNKNOWN';
const networkFetch=globalThis.fetch.bind(globalThis);
const offlineFetch=(input,init)=>{
 wall.assert();const r=new Request(input,init),u=new URL(r.url);assert.ok(u.origin==='http://127.0.0.1:18080'&&!u.username&&!u.password,'ONLY_FRESH_LOOPBACK_SQLD_ALLOWED');
 return networkFetch(r,{signal:AbortSignal.any([r.signal,abort.signal,AbortSignal.timeout(Math.max(1,Math.floor(wall.remaining())))])});
};
globalThis.fetch=offlineFetch;
const transport=createDiagnosticFetch({fetch:offlineFetch,decodePipelineReply:PipelineRespBody,observer,now,latencyEnabled:()=>latency});
const requestId='synthetic-linux-empty-0',executionId=keys.lookup(['stage8-live-request-v1','a',requestId]);
let report={contract:'stage6-native-empty-attribution-diagnostic-v1',productionEvidence:false,capacityQualified:false,status:'DIAGNOSTIC_RUNNING_UNQUALIFIED',releaseSha:sha,sourceHashes,serverEnforcedAbsoluteTransactionLimit:'UNKNOWN',scope:'ONE_EMPTY_SYNTHETIC_USER_ONE_ORIGINAL_CALL_NO_REPLAY',producerScopeIncludesOriginalWorkAndContextCleanup:true,producerWorkBudgetMsUnchanged:45000,producerContextCleanupBudgetMsUnchanged:5000,callsStarted:0,before:{readbackStatus:'UNKNOWN'},after:{readbackStatus:'UNKNOWN'},originalCallReturned:false,exactOriginalIdentityReplay:false};
const save=()=>writeFileSync(OUT+'/diagnostic-report.json',JSON.stringify({...report,callsStarted:wall.callsStarted,attribution:transport.snapshot(),telemetry:sink.snapshot(),resources:resources()},null,2)+'\n',{mode:0o600});
function setPhase(value,unit,ordinal=0){phase=value;observer.setPhase(value,unit,ordinal);}
function failureEvidence(error){const frames=safeFailureFrames(error);return {phase,code:observer.typedCode(error),frames,sourceSites:failureSourceSites(frames)};}
async function bounded(maxMs,work){
 wall.assert();const budget=createExecutionBudget({budgetMs:Math.max(1,Math.min(maxMs,Math.floor(wall.remaining()))),signal:abort.signal,localAuthority:wall.assert});
 // Direct await is deliberate: aborting the clock is never proof that callback/COMMIT cleanup joined.
 try{return await withExecutionBudget(budget,async()=>{budget.assert();const value=await work();budget.assert();wall.assert();return value;});}finally{budget.cancel();budget.close();}
}
async function readback(){
 const jobs=(await db.raw.execute({sql:"SELECT job_kind,state,requested_generation,completed_generation,scope_kind,full_scan_cursor FROM phase4_jobs WHERE user_id=? AND execution_mode='LIVE' AND job_kind IN ('RECOMPUTE_DERIVED','REPAIR_CURRENTNESS') ORDER BY job_kind",args:['a']})).rows;
 const computation=(await db.raw.execute({sql:"SELECT input_generation,last_completed_generation FROM phase4_computation_state WHERE user_id=? AND execution_mode='LIVE'",args:['a']})).rows[0];
 const execution=(await db.raw.execute({sql:'SELECT * FROM stage8_live_executions WHERE execution_id=?',args:[executionId]})).rows[0];let executionResult,receiptCount=null;
 if(execution){
  const request=JSON.parse(execution.canonical_request_json),configProof=keys.lookup(['stage8-live-server-config-v1',sha,35,['a'],'phase4-stage5-canonical-v1']);
  assert.equal(request.requestId,executionId);assert.equal(request.contract,'stage8-live-producer-v1');assert.equal(request.phase,'STAGE6_DRAIN');assert.equal(request.releaseSha,sha);assert.equal(request.executionMode,'LIVE');assert.equal(request.triggerSource,'manual');assert.equal(request.configProof,configProof);assert.equal(execution.execution_id,executionId);assert.equal(execution.release_sha,sha);assert.equal(execution.phase,'STAGE6_DRAIN');assert.equal(execution.execution_mode,'LIVE');assert.equal(execution.trigger_source,'manual');assert.equal(execution.config_proof,configProof);assert.equal(execution.scope_key,digest(JSON.stringify(['phase4-execution-scope-v1','STAGE6_DRAIN','LIVE',configProof])));assert.equal(execution.canonical_request_json,canonicalJson(request));assert.equal(execution.identity_digest,digest(canonicalJson(request)));
  if(['WORK_COMMITTED','FINALIZED_SUCCESS','FINALIZED_FAILURE'].includes(execution.state))executionResult=verifyLiveExecutionResult(keys,execution);
  const receipts=(await db.raw.execute({sql:'SELECT request_digest,scope_key,generation FROM stage8_live_execution_work_receipts WHERE execution_id=?',args:[executionId]})).rows;
  assert.ok(receipts.length<=4096);for(const r of receipts){assert.equal(r.request_digest,execution.identity_digest);assert.equal(r.scope_key,execution.scope_key);assert.ok(Number.isSafeInteger(r.generation)&&r.generation>=0&&r.generation<=execution.generation);}receiptCount=receipts.length;
 }else receiptCount=0;
 const count=async table=>Number((await db.raw.execute('SELECT count(*) n FROM '+table)).rows[0].n);
 const sourceRows=(await Promise.all(Object.values(OFFLINE_LIVE_TABLES).map(count))).reduce((a,b)=>a+b,0);
 return safeProgress({jobs,computation,execution,executionResult,receiptCount,sourceRows,outboundMessages:await count('outbound_messages'),currentPublications:await count('stage8_live_publications'),pilotLedgers:Number((await db.raw.execute("SELECT count(*) n FROM system_heartbeats WHERE scope='global' AND component LIKE 'phase4_beta_pilot_permit%'")).rows[0].n),callAcknowledgement});
}
async function observeReadback(){setPhase('READBACK','READBACK');try{return await bounded(5000,readback);}catch(error){report.readbackFailure=failureEvidence(error);return {readbackStatus:'UNKNOWN'};}}
try{
 setPhase('SETUP_SCHEMA1_TO35_SYNTHETIC_ONLY','CREATE_DB');db=createDb({url:'http://127.0.0.1:18080',phase4Keys:keys,fetch:transport.fetch});assert.equal(db.raw.protocol,'http');
 await bounded(Math.max(1,Math.floor(wall.remaining()-10000)),async()=>{
  assert.equal(Number((await db.raw.execute("SELECT count(*) n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")).rows[0].n),0,'FRESH_DATABASE_ONLY');
  setPhase('SETUP_SCHEMA1_TO35_SYNTHETIC_ONLY','MIGRATE');await db.migrate({targetVersion:35});
  setPhase('SETUP_EMPTY_FIXTURE','SEED_EMPTY_FIXTURE');const stores=await createPhase4Foundation({db,keys}),asOf=Date.now()-1000;
  await db.createUser({id:'a',displayName:'Synthetic empty Linux qualification',timezone:'Asia/Taipei',status:'ACTIVE'});await stores.initializeTenant('a','SHADOW');
  await db.transaction(()=>seedBodyInput(db,offlineLiveFixtureInput({profile:'empty',userId:'a',asOf})));await db.ensureOnboarding('a',{state:'READY'});await db.linkTelegram({userId:'a',chatId:'10001'});await db.setLocale('a','en');
  for(const resource of OFFLINE_LIVE_RESOURCES)await db.saveSyncState('a',resource,{backfillComplete:true,lastSuccessAt:new Date(asOf).toISOString()});await stores.preferences.read(await stores.captureControl('a'));
 });
 latency=true;setPhase('ADMISSION_AND_COMPOSITION','RUNTIME_ADMISSION');const admission=await bounded(10000,()=>db.admitRuntime({fresh:true}));
 setPhase('ADMISSION_AND_COMPOSITION','BUILD_LIVE_PRODUCER');const producer=await bounded(10000,()=>createStage8LiveProducer({db,keys,admission,userIds:['a'],enabled:()=>true,eligible:id=>id==='a',environment:{}}));
 report.before=await observeReadback();save();
 if(report.before.readbackStatus==='OBSERVED'){assert.equal(report.before.sourceRows,0);assert.equal(report.before.outboundMessages,0);assert.equal(report.before.pilotLedgers,0);}
 if(wall.remaining()>=60000){
  report.intentSha256=digest(canonicalJson({contract:'one-original-empty-120s-v1',releaseSha:sha,requestId,userId:'a'}));
  writeFileSync(OUT+'/diagnostic-intent.json',JSON.stringify({contract:'one-original-empty-120s-v1',synthetic:true,releaseSha:sha,intentSha256:report.intentSha256,callOrdinal:1,replay:false})+'\n',{mode:0o600});
  setPhase('GENUINE_ORIGINAL_PRODUCER_CALL','ORIGINAL_PRODUCER_RUN',1);report.observationPoint='BEFORE_ORIGINAL_INVOCATION';save();
  try{
   await bounded(50000,()=>observeOriginalResult({
    run:async()=>{
     if(!wall.admitOriginalCall())throw Object.assign(Error('DIAGNOSTIC_CALL_NOT_ADMITTED'),{code:'DIAGNOSTIC_CALL_NOT_ADMITTED'});
     callSettled=false;
     try{
      const value=await producer.run({userId:'a',requestId});
      // Observe the actual producer boundary before telemetry or outer wall assertions can throw.
      callAcknowledgement='RETURNED';report.originalCallReturned=true;
      report.returned={...safeExecutionObservation({resultOutcome:value.result?.outcome,callAcknowledgement}),...Object.fromEntries(['itemsProcessed','jobsCompleted','jobsFailed','remainingJobs','unitsCommitted'].map(k=>[k,integer(value.result?.[k])]))};
      return value;
     }catch(error){callAcknowledgement='THREW';report.commitAcknowledgement=error?.code==='COMMIT_INDETERMINATE'?'UNKNOWN':'NOT_INFERRED';throw error;}
     finally{callSettled=true;}
    },withTelemetry:withPhaseTelemetry,releaseSha:sha,sink
   }));
  }catch(error){report.failure=failureEvidence(error);}

  report.after=await observeReadback();report.progressDelta=progressDelta(report.before,report.after);
 }else report.skipReason='SETUP_AND_OBSERVATION_LEFT_INSUFFICIENT_ORIGINAL_CALL_RESERVE';
 report.status='DIAGNOSTIC_OBSERVATIONS_ONLY_UNQUALIFIED';
}catch(error){report.status='DIAGNOSTIC_FAILURE_OR_UNKNOWN';report.failure=failureEvidence(error);}
finally{
 setPhase('CLEANUP','CLEANUP');report.observationPoint='JOINING_OWNED_CLEANUP';report.ownedCleanupEligible=false;save();
 // Never force-close an active/unknown native transaction to manufacture clean evidence.
 await transport.awaitIdle();
 if(callSettled&&transport.snapshot().adapter.terminalComplete){
  try{await bounded(5000,async()=>{if(db){await db.close();closeCalled=true;}for(let n=0;n<2;n++){await new Promise(resolve=>setImmediate(resolve));await transport.awaitIdle();}});cleanupJoined=transport.snapshot().adapter.terminalComplete&&transport.snapshot().adapter.retainedStreams===0;}
  catch(error){report.cleanupFailure=failureEvidence(error);}
 }
 report.cleanup={callSettled,closeCalled,joined:cleanupJoined};save();
 report.final=wall.finalize({cleanupJoined,terminalKnown:transport.snapshot().adapter.terminalComplete});
 report.ownedCleanupEligible=cleanupJoined&&callSettled&&transport.snapshot().adapter.terminalComplete;report.observationPoint='AFTER_AWAITED_CLEANUP';
 if(!report.final.withinBoundAndSettled)report.status='DIAGNOSTIC_UNQUALIFIED_WALL_OR_SETTLEMENT';
 save();if(wall.elapsed()>120000){report.status='DIAGNOSTIC_UNQUALIFIED_WALL_OR_SETTLEMENT';report.final=wall.finalize({cleanupJoined,terminalKnown:transport.snapshot().adapter.terminalComplete});save();}
 clearTimeout(wallTimer);process.exitCode=report.final.withinBoundAndSettled?0:2;
 console.log(JSON.stringify({productionEvidence:false,capacityQualified:false,status:report.status,callsStarted:wall.callsStarted,output:'/qualification/diagnostic-report.json'}));
}
