import {canonicalOwnedRow,fingerprintOwnedFile} from './stage6-owned-file-batch-control.mjs';
import {STAGE8_LIVE_DRAIN_BUDGET} from "../src/stage8LiveDrainPolicy.js";
import {joinIssuedTransport,transportIsJoined,waitIssuedIdleBefore} from "./stage6-native-join-barrier.mjs";
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
import {createDb,createOwnedFileDb} from "../src/db.js";
import {fixtureKeys as keys} from "./localDb.js";
import {createPhase4Foundation} from "../src/phase4Foundation.js";
import {createStage8LiveProducer} from "../src/stage8LiveProducer.js";
import {authorizeStage8LiveProducer} from "../src/stage8LiveProducerAuthority.js";
import {buildPhase4Core} from "../src/phase4Core.js";
import {createPhase4Stage6} from "../src/phase4Reanalysis.js";
import {createStage8LiveExecutionRunner} from "../src/stage8LiveExecution.js";
import {runningReleaseSha} from "../src/phase4Release.js";
import {createReanalysisInputs} from "../src/phase4ReanalysisInputs.js";
import {composePhase4Stores} from "../src/phase4Repositories.js";
import {createExecutionBudget,withExecutionBudget} from "../src/executionBudget.js";
import {verifyLiveExecutionResult} from "../src/stage8LiveExecution.js";
import {offlineLiveFixtureInput,OFFLINE_LIVE_TABLES} from "./stage8LiveLinuxFixture.js";
import {seedBodyInput} from "./bodyEnergyFixture.js";
import {createDiagnosticFetch} from "./stage6-native-diagnostic-observer.mjs";
import {createAttribution} from "./stage6-native-attribution.mjs";
import {writeSync} from 'node:fs';

import {readFileSync,writeFileSync,openSync,fsyncSync,closeSync,lstatSync,realpathSync} from 'node:fs';
import {basename,dirname} from 'node:path';
import {createHash} from 'node:crypto';
const [suppliedRoot,mode,ordinalText,previousName]=process.argv.slice(2);
assert.equal(process.argv.length,6);assert.ok(['INIT','BATCH','VERIFY'].includes(mode));assert.ok(/^(0|[1-9][0-9]?)$/.test(ordinalText??''));
assert.equal(process.platform,'linux');assert.equal(process.arch,'x64');assert.equal(process.version,'v22.23.2');assert.match(process.env.EXPECTED_CANDIDATE_SHA??'',/^[a-f0-9]{40}$/);assert.equal(runningReleaseSha({}),process.env.EXPECTED_CANDIDATE_SHA);
const ordinal=Number(ordinalText),directory=realpathSync(suppliedRoot);
assert.equal(dirname(directory),realpathSync(tmpdir()));assert.match(basename(directory),/^healthos-local-owned-file-batch-[a-zA-Z0-9_-]+$/);assert.equal(lstatSync(suppliedRoot).isSymbolicLink(),false);
assert.ok(mode==='INIT'?ordinal===0:mode==='BATCH'?ordinal<=63:ordinal<=64);assert.ok(mode==='INIT'?previousName==='NONE':/^(init|batch-(0|[1-9][0-9]?))$/.test(previousName??''));
const selected=mode==='INIT'?'init':mode==='VERIFY'?'verify-'+ordinal:'batch-'+ordinal;
const previous=mode==='INIT'?null:previousName;const last=JSON.stringify(['workout','workout-39']);
const boundaryReady=pending=>pending.length===1&&pending[0].full_scan_cursor===last;
const started=performance.now();let db,failed=false,closed=false,failureType=null,after=null,catalogDigest=null,prior=null,completedCalls=0,sourceAcknowledgments=0,unitsCommitted=0,ready=false;
const exact=(o,fields)=>o&&Object.getPrototypeOf(o)===Object.prototype&&Object.keys(o).length===fields.length&&fields.every(k=>Object.hasOwn(o,k));
const digest=o=>keys.lookup(['native-physical-batch-fingerprint-v1',o]);
const canonical=canonicalOwnedRow,rows=async table=>(await db.raw.execute('SELECT * FROM '+table)).rows;
const snapshot=()=>fingerprintOwnedFile(db,keys);
function readPrior(){
 const p=join(directory,previous+'.private.json');assert.equal(lstatSync(p).isSymbolicLink(),false);const raw=readFileSync(p);assert.ok(raw.length<32768);const packet=JSON.parse(raw);
 assert.ok(exact(packet,['contract','selected','mode','ordinal','nextOrdinal','snapshot','catalogDigest','closed','ready','seal']));const {seal,...body}=packet;
 assert.equal(body.contract,'native-owned-file-batch-durable-ack-v1');assert.equal(body.selected,previous);assert.equal(body.mode,previous==='init'?'INIT':'BATCH');assert.equal(body.ordinal,previous==='init'?0:Number(previous.slice(6)));assert.ok(previous==='init'||body.ordinal<ordinal);assert.equal(typeof body.ready,'boolean');assert.equal(body.nextOrdinal,ordinal);assert.equal(body.closed,true);assert.equal(seal,keys.lookup(['native-owned-file-batch-ack-v1',body]));assert.match(body.catalogDigest,/^[a-f0-9]{64}$/);
 return body;
}
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

async function preserveOriginal(before){
 for(const table of ['stage8_live_executions','stage8_live_execution_work_receipts']){const got=new Set((await rows(table)).map(canonical));for(const row of before[table])assert.ok(got.has(row),'ORIGINAL_DURABLE_ROW_CHANGED');}
}
try{
 if(mode==='INIT'){
  await mkdir(join(directory,'physical'),{mode:0o700});
 db=createOwnedFileDb({url:pathToFileURL(join(directory,'physical','data')).href,phase4Keys:keys});assert.equal(db.raw.protocol,'file');
 await db.migrate({targetVersion:35});
 const foundation=await createPhase4Foundation({db,keys,admission:await db.admitRuntime()});
 await db.createUser({id:'a',displayName:'Synthetic native EOF',timezone:'Asia/Taipei',status:'ACTIVE'});await db.ensureOnboarding('a',{state:'READY'});await foundation.initializeTenant('a','SHADOW');const input=offlineLiveFixtureInput({profile:'dense',userId:'a',asOf:Date.now()-3600000});for(let i=0;i<input.sources.recovery.length;i++)input.sources.recovery[i].recovery_score=i===0?15:40+(i%5)*5;await db.transaction(()=>seedBodyInput(db,input));

 }else{
  prior=readPrior();db=createOwnedFileDb({url:pathToFileURL(join(directory,'physical','data')).href,phase4Keys:keys});assert.equal(db.raw.protocol,'file');await db.admitRuntime();assert.equal((await db.raw.execute('SELECT max(version) n FROM schema_version')).rows[0].n,35);
  assert.deepEqual(await snapshot(),prior.snapshot,'CROSS_PROCESS_DURABLE_STATE_CHANGED');assert.equal(prior.snapshot.executionCount,ordinal);assert.equal(prior.ready,mode==='VERIFY');
 }
 if(mode==='VERIFY'){
  assert.equal((await db.raw.execute('PRAGMA quick_check')).rows[0].quick_check,'ok');after=await snapshot();catalogDigest=prior.catalogDigest;ready=prior.ready;
 }else{
 let producer=await createStage8LiveProducer({db,keys,admission:await db.admitRuntime(),userIds:['a'],enabled:()=>true,eligible:id=>id==='a'});const progress={};
 const admission=await db.admitRuntime(),releaseSha=runningReleaseSha({}),configProof=keys.lookup(['stage8-live-server-config-v1',releaseSha,35,['a'],'phase4-stage5-canonical-v1']);
 const capability=await authorizeStage8LiveProducer({db,keys,admission,releaseSha,configProof,enabled:()=>true,eligible:id=>id==='a'});
 const core=await buildPhase4Core({keys,admission,liveProducingAuthority:capability,processing:{client:db.raw,transaction:db.transaction,active:db.processingTransactionActive,assertFences:db.assertRuntimeFences,afterCommit:db.afterProcessingCommit,afterCompletion:db.afterProcessingCompletion},authorizeMode(mode,client,id){assert.equal(mode,'LIVE');assert.equal(client,db.raw);assert.equal(id,'a');}});
 if(mode==='INIT')await core.initializeTenant('a','LIVE');const worker=await createPhase4Stage6({db,keys,admission,executionMode:'LIVE',liveProducingAuthority:capability});if(mode==='INIT')await worker.rolloutAlgorithm({userId:'a'});
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
 let preparationContexts=[],preparationBudget=STAGE8_LIVE_DRAIN_BUDGET;
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


  catalogDigest=digest(sourceCatalog);if(prior)assert.equal(catalogDigest,prior.catalogDigest);
  if(mode==='BATCH'){
   const before={};for(const table of ['stage8_live_executions','stage8_live_execution_work_receipts'])before[table]=(await rows(table)).map(canonical);
   for(let j=0;j<2;j++){
    const pending=(await db.raw.execute("SELECT state,full_scan_cursor FROM phase4_jobs WHERE execution_mode='LIVE' AND state<>'COMPLETED'")).rows;assert.ok(pending.length>0,'ORIGINAL_NONEMPTY_CURSOR_REQUIRED');if(boundaryReady(pending)){ready=true;break;}assert.ok(ordinal+j<64,'ORIGINAL_PREPARATION_CALL_LIMIT');
    preparationBudget=preparationBudgetFor(pending,sourceCatalog);
    const result=await runPreparation({userId:'a',requestId:'synthetic-native-physical-batch-prepare-'+(ordinal+j)});assert.equal(result.replayed,false);assert.equal(result.result.jobsFailed,0);completedCalls++;sourceAcknowledgments+=result.result.itemsProcessed;unitsCommitted+=result.result.unitsCommitted;
   }
   await preserveOriginal(before);assert.ok(completedCalls>=1&&completedCalls<=2);const pendingAfter=(await db.raw.execute("SELECT state,full_scan_cursor FROM phase4_jobs WHERE execution_mode='LIVE' AND state<>'COMPLETED'")).rows;assert.ok(pendingAfter.length>0,'ORIGINAL_NONEMPTY_CURSOR_REQUIRED');ready=boundaryReady(pendingAfter);
  }
  after=await snapshot();assert.equal(after.executionCount,mode==='INIT'?0:ordinal+completedCalls);if(prior){assert.equal(after.sourceDigest,prior.snapshot.sourceDigest);assert.equal(after.generationDigest,prior.snapshot.generationDigest);assert.ok(after.receiptCount>=prior.snapshot.receiptCount);}
 }
}catch(error){failed=true;failureType=['Error','AssertionError'].includes(error?.name)?error.name:'OTHER';}
finally{
 try{if(db){await new Promise(r=>setImmediate(r));await new Promise(r=>setImmediate(r));await db.close();db=null;await new Promise(r=>setImmediate(r));await new Promise(r=>setImmediate(r));}closed=true;}catch{failed=true;failureType='CLOSE_FAILURE';}
}
let descriptorSHA256=null;
if(!failed&&closed){
 const body={contract:'native-owned-file-batch-durable-ack-v1',selected,mode,ordinal,nextOrdinal:mode==='BATCH'?ordinal+completedCalls:ordinal,snapshot:after,catalogDigest,closed:true,ready};const raw=JSON.stringify({...body,seal:keys.lookup(['native-owned-file-batch-ack-v1',body])});const path=join(directory,selected+'.private.json'),fd=openSync(path,'wx',0o600);try{writeFileSync(fd,raw);fsyncSync(fd);}finally{closeSync(fd);}const dirfd=openSync(directory,'r');try{fsyncSync(dirfd);}finally{closeSync(dirfd);}descriptorSHA256=createHash('sha256').update(raw).digest('hex');
}
const {rss,heapUsed,heapTotal,external}=process.memoryUsage();
writeSync(1,'STAGE6_NATIVE_PHYSICAL_BATCH_PACKET '+JSON.stringify({contract:'native-physical-owned-file-batch-child-v1',mode,ordinal,pid:process.pid,parentPID:process.ppid,closed,failed,failureType,completedCalls,sourceAcknowledgments,unitsCommitted,ready,descriptorSHA256,after,catalogDigest,elapsedMs:performance.now()-started,memory:{rss,heapUsed,heapTotal,external},productionEvidence:false,LinuxQualification:false,EOFQualified:false,capacityQualified:false})+'\n');process.exitCode=failed||!closed?2:0;
