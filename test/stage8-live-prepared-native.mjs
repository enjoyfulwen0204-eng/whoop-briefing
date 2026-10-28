// Explicit isolated Linux component gate. One original execution, no EOF loop,
// external network, provider credentials, historical permit or real user data.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {createDb} from '../src/db.js';
import {createPhase4Foundation} from '../src/phase4Foundation.js';
import {authorizeStage8LiveProducer} from '../src/stage8LiveProducerAuthority.js';
import {buildPhase4Core} from '../src/phase4Core.js';
import {createPhase4Stage6} from '../src/phase4Reanalysis.js';
import {createStage8LiveExecutionRunner} from '../src/stage8LiveExecution.js';
import {createStage8LivePreparedWorker} from '../src/stage8LivePreparedWork.js';
import {fixtureKeys as keys} from './localDb.js';
import {bodyInput,seedBodyInput} from './bodyEnergyFixture.js';
import {log} from '../src/logger.js';
import {createPreparedNativeObserver} from './stage8-prepared-native-observer.mjs';
for(const name of ['info','warn','error'])log[name]=()=>{};
assert.equal(process.argv[2],'ONE_ORIGINAL_PREPARED_UNIT');assert.equal(process.argv.length,3);
assert.equal(process.version,'v22.23.2');assert.equal(process.platform,'linux');
for(const [name,value] of Object.entries(process.env))if(/^(?:GIT_|TURSO_|WHOOP_|TELEGRAM_|OPENROUTER_|PHASE4_|RENDER_|CLOUDFLARE_)/.test(name))assert.ok(!value,'NO_EXTERNAL_ENVIRONMENT');
const root=resolve(new URL('..',import.meta.url).pathname),manifest=JSON.parse(readFileSync(resolve(root,'source-manifest.json'),'utf8'));
assert.equal(manifest.scope,'R22_PREPARED_NATIVE_COMPONENT');assert.match(manifest.baseCommit,/^[a-f0-9]{40}$/);
for(const [path,sha] of Object.entries(manifest.files))assert.equal(createHash('sha256').update(readFileSync(resolve(root,path))).digest('hex'),sha,'EXACT_LOADED_SOURCE');
const url='http://127.0.0.1:18083',nativeFetch=globalThis.fetch.bind(globalThis),observer=createPreparedNativeObserver(),{streams,transactions}=observer;
let phase='SETUP',requests=0,pending=0,errors=0;
const fetchOwned=async(input,init)=>{
 const request=new Request(input,init);assert.equal(new URL(request.url).origin,url);const body=await request.clone().json(),at=performance.now();
 const observation=observer.submitted(body,phase,at);requests++;pending++;
 try{
  const response=await nativeFetch(request,{signal:AbortSignal.any([request.signal,AbortSignal.timeout(10000)]),redirect:'error'}),reply=await response.clone().json(),end=performance.now();
  assert.ok(response.ok);
  observer.acknowledged(observation,reply,end);
  for(let i=0;i<(body.requests??[]).length;i++){
   const observed=reply.results?.[i];
   if(observed?.type==='error')errors++;
   for(const error of observed?.response?.result?.step_errors??[])if(error)errors++;
  }
  return response;
 }catch(error){errors++;throw error;}finally{pending--;}
};
globalThis.fetch=fetchOwned;
const db=createDb({url,phase4Keys:keys,fetch:fetchOwned});let prepared,report,failure;
try{
 assert.equal((await db.raw.execute("SELECT count(*) n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")).rows[0].n,0);
 await db.migrate({targetVersion:35});await db.createUser({id:'a',displayName:'Synthetic native prepared gate',timezone:'Asia/Taipei',status:'ACTIVE'});
 const admission=await db.admitRuntime(),foundation=await createPhase4Foundation({db,keys,admission});await foundation.initializeTenant('a','SHADOW');
 await db.transaction(()=>seedBodyInput(db,bodyInput({asOf:Date.now()-1000,days:0})));await db.ensureOnboarding('a',{state:'READY'});await db.linkTelegram({userId:'a',chatId:'10001'});
 const capability=await authorizeStage8LiveProducer({db,keys,admission,releaseSha:manifest.baseCommit,configProof:keys.lookup(['isolated-r22-native-component',manifest.files]),enabled:()=>true,eligible:id=>id==='a'});
 const core=await buildPhase4Core({keys,admission,liveProducingAuthority:capability,processing:{client:db.raw,transaction:db.transaction,active:db.processingTransactionActive,assertFences:db.assertRuntimeFences,afterCommit:db.afterProcessingCommit,afterCompletion:db.afterProcessingCompletion},authorizeMode(mode,client,id){assert.equal(mode,'LIVE');assert.equal(client,db.raw);assert.equal(id,'a');}});
 await core.initializeTenant('a','LIVE');const worker=await createPhase4Stage6({db,keys,admission,executionMode:'LIVE',liveProducingAuthority:capability});await worker.rolloutAlgorithm({userId:'a'});
 prepared=createStage8LivePreparedWorker({db,keys,capability});
 const run=createStage8LiveExecutionRunner({db,keys,capability,capture:id=>core.capture(id,{executionMode:'LIVE',providerRequired:true}),assertContext:c=>core.assertContext(c),work:async(userId,context)=>{
  const value=await prepared.drain({userId,context});return {outcome:value.outcome,itemsProcessed:value.processedItems,unitsCommitted:value.unitsCommitted,jobsCompleted:value.completedJobs,jobsFailed:value.failedJobs,remainingJobs:value.remainingJobs};
 }});
 phase='ONE_PREPARED_WORK_UNIT';const before=requests,at=performance.now(),value=await run({userId:'a',requestId:'r22-native-one-original-prepared'}),elapsedMs=performance.now()-at;
 assert.equal(value.replayed,false);assert.equal(value.result.jobsFailed,0);assert.ok(value.result.unitsCommitted>0);
 const row=(await db.raw.execute('SELECT state,generation,created_at,deadline_at,lease_until FROM stage8_live_executions')).rows[0];
 assert.equal(row.state,'FINALIZED_SUCCESS');assert.equal(row.generation,1);assert.equal(row.deadline_at-row.created_at,45000);assert.equal(row.lease_until-row.created_at,60000);
 assert.equal((await db.raw.execute('SELECT count(*) n FROM outbound_messages')).rows[0].n,0);
 assert.equal((await db.raw.execute("SELECT count(*) n FROM system_heartbeats WHERE component LIKE 'phase4_beta_pilot_permit%'")).rows[0].n,0);
 const actual=observer.assertComplete('ONE_PREPARED_WORK_UNIT');assert.ok(actual.every(x=>x.outcome==='COMMIT'&&x.upperBoundMs<5000));assert.ok(prepared.status().publication.transactionUpperBoundMs<5000);
 assert.equal(prepared.status().disposal.holdReleased,true);assert.equal((await db.raw.execute("SELECT count(*) n FROM resource_locks WHERE name LIKE '%:prepared-disposal:%'")).rows[0].n,0);
 report={status:'ONE_ORIGINAL_PREPARED_NATIVE_UNIT_PASS',result:{outcome:value.result.outcome,units:value.result.unitsCommitted,items:value.result.itemsProcessed,jobs:value.result.jobsCompleted},elapsedMs,workHttp:requests-before,publication:prepared.status().publication,workTransactions:actual,sourceManifestSha256:createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),scope:manifest.scope,baseCommit:manifest.baseCommit,fullEOFQualified:false,stage6HranaQualified:false,productionEvidence:false,actualProviderEvidence:false,absoluteServerInterruption:'UNKNOWN'};
}catch(error){failure=error;report={status:'ONE_ORIGINAL_PREPARED_NATIVE_UNIT_FAILED',phase,errorCode:error.code??error.name,message:String(error.message).slice(0,300),publication:prepared?.status(),productionEvidence:false,fullEOFQualified:false};}
finally{
 db.close();const until=performance.now()+4000;while((streams.size||pending)&&performance.now()<until)await new Promise(r=>setTimeout(r,20));
 if(streams.size||pending)failure??=Error('NATIVE_PREPARED_STREAM_JOIN_UNKNOWN');
 console.log('R22_NATIVE_PREPARED '+JSON.stringify({...report,status:failure?'ONE_ORIGINAL_PREPARED_NATIVE_UNIT_FAILED':report.status,cleanupFailure:failure?.message,requests,errors,openStreams:streams.size,pendingRequests:pending,transactionsObserved:transactions.length,observation:observer.counts}));
}
if(failure)process.exitCode=1;
