import test from 'node:test';
import assert from 'node:assert/strict';
import {AsyncResource} from 'node:async_hooks';
import {syntheticPhase4Fixture} from './phase4Fixture.js';
import {bodyInput,seedBodyInput} from './bodyEnergyFixture.js';
import {createStage8LiveProducer} from '../src/stage8LiveProducer.js';
import {authorizeStage8LiveProducer} from '../src/stage8LiveProducerAuthority.js';
import {createStage8LiveExecutionRunner} from '../src/stage8LiveExecution.js';
import {buildPhase4Core} from '../src/phase4Core.js';
import {runningReleaseSha} from '../src/phase4Release.js';
import {bindProducingExecution} from '../src/phase4ExecutionContext.js';
import {workStepOptions} from '../src/phase4WorkStep.js';
import {observeOwnedFileTransactions} from './stage6-owned-file-observer.mjs';

test('same RID cannot finalize between authoritative absence and fresh preparation; original write root stays below 5s locally',async t=>{
 const f=await syntheticPhase4Fixture(t,{targetVersion:35,ownedConnection:true,now:()=>new Date()});
 await f.db.transaction(()=>seedBodyInput(f.db,bodyInput({asOf:Date.now()-1000,days:7})));
 await f.db.ensureOnboarding('a',{state:'READY'});
 const admission=await f.db.admitRuntime(),producer=await createStage8LiveProducer({...f,admission,userIds:['a'],enabled:()=>true,eligible:id=>id==='a'});
 const observer=observeOwnedFileTransactions();let observerClosed=false;observer.arm();t.after(()=>{if(!observerClosed)observer.close();});
 // Real original factory work establishes the current canonical algorithm.
 await producer.run({userId:'a',requestId:'atomic-prepare-real-initial-leg'});
 const releaseSha=runningReleaseSha({}),configProof=f.keys.lookup(['stage8-live-server-config-v1',releaseSha,35,['a'],'phase4-stage5-canonical-v1']);
 const capability=await authorizeStage8LiveProducer({...f,admission,releaseSha,configProof,enabled:()=>true,eligible:id=>id==='a'});
 const core=await buildPhase4Core({keys:f.keys,admission,liveProducingAuthority:capability,
  processing:{client:f.db.raw,transaction:f.db.transaction,active:f.db.processingTransactionActive,afterCommit:f.db.afterProcessingCommit,afterCompletion:f.db.afterProcessingCompletion},authorizeMode(){}});
 // This genuine signed failure has an actual named work COMMIT/producer. It
 // exposes generation-changing preparation if a losing same-ID call sees it.
 const competing=createStage8LiveExecutionRunner({...f,capability,capture:id=>core.capture(id,{executionMode:'LIVE',providerRequired:true}),assertContext:ctx=>core.assertContext(ctx),work:async(id,ctx)=>{
  await core.run(ctx,()=>bindProducingExecution(f.db.raw,ctx),workStepOptions('live.atomic-interleaved-failure',[id,ctx.inputGeneration],{discardResult:true}));
  return {outcome:'FAILED',unitsCommitted:1};
 }});
 const actor=new AsyncResource('independent-live-request'),requestId='atomic-same-original-request',executionId=f.keys.lookup(['stage8-live-request-v1','a',requestId]);
 const before=(await f.db.raw.execute("SELECT * FROM phase4_computation_state WHERE user_id='a' AND execution_mode='LIVE'")).rows;
 const jobs=(await f.db.raw.execute("SELECT * FROM phase4_jobs WHERE user_id='a' AND execution_mode='LIVE' ORDER BY job_kind")).rows;
 const execute=f.db.raw.execute;let observed=false,insideRoot=false,other;
 f.db.raw.execute=async statement=>{
  const value=await execute(statement);
  if(!observed&&statement?.sql==='SELECT 1 FROM stage8_live_executions WHERE execution_id=?'&&statement.args[0]===executionId){
   observed=true;assert.equal(value.rows.length,0);insideRoot=f.db.processingTransactionActive();
   // Outside the root (old code), the other real request may fully settle here.
   // Inside it, that request queues behind the SQLite root and cannot insert.
   other=actor.runInAsyncScope(()=>competing({userId:'a',requestId:executionId}));other.catch(()=>{});
   if(!insideRoot)await other;
  }
  return value;
 };
 let value,error,observation;
 try{
  try{value=await producer.run({userId:'a',requestId});}catch(e){error=e;}
  const competitor=await other;assert.equal(competitor.result.outcome,'FAILED');assert.equal(competitor.replayed,false);
  assert.equal(observed,true);assert.equal(insideRoot,true,'authoritative lookup must share the original write root with preparation');
  if(error)assert.equal(error.code,'STAGE8_LIVE_REQUEST_PENDING');else{assert.equal(value.replayed,true);assert.equal(value.result.outcome,'FAILED');}
  assert.deepEqual((await execute("SELECT * FROM phase4_computation_state WHERE user_id='a' AND execution_mode='LIVE'")).rows,before,'losing same-ID call must not mark a fresh generation');
  assert.deepEqual((await execute("SELECT * FROM phase4_jobs WHERE user_id='a' AND execution_mode='LIVE' ORDER BY job_kind")).rows,jobs);
  const row=(await execute({sql:'SELECT * FROM stage8_live_executions WHERE execution_id=?',args:[executionId]})).rows[0];assert.equal(row.state,'FINALIZED_FAILURE');assert.equal(row.generation,1);
  assert.equal((await execute('SELECT count(*) n FROM stage8_live_publications')).rows[0].n,0);
  assert.equal((await execute('SELECT count(*) n FROM outbound_messages')).rows[0].n,0);
  observation=observer.assertComplete();
 }finally{f.db.raw.execute=execute;actor.emitDestroy();observer.close();observerClosed=true;}
 t.diagnostic(JSON.stringify({contract:'same-live-rid-atomic-original-preparation-v1',trueOverlappingRequests:true,authorityLookupInsideOriginalRoot:insideRoot,originalJobGenerationPreserved:true,
  explicitNativeTransactions:observation.committed+observation.rolledBack,maxObservedMs:observation.maxDurationMs,linuxResourceQualification:false,productionEvidence:false}));
});
