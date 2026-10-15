import test from 'node:test';import assert from 'node:assert/strict';
import {syntheticPhase4Fixture} from './phase4Fixture.js';
import {buildPhase4Core} from '../src/phase4Core.js';
import {authorizeStage8LiveProducer} from '../src/stage8LiveProducerAuthority.js';
import {createStage8LiveExecutionRunner} from '../src/stage8LiveExecution.js';
import {workStepOptions} from '../src/phase4WorkStep.js';
import {bindProducingExecution,withDurableExecution,assertExecutionWorkOwner} from '../src/phase4ExecutionContext.js';

test('closed LIVE execution binds tenant, actual named transaction receipts and immutable finalization; replay executes no work',async t=>{
 const f=await syntheticPhase4Fixture(t,{targetVersion:35});await f.core.initializeTenant('a','LIVE');
 let enabled=true,calls=0;const admission=await f.db.admitRuntime(),capability=await authorizeStage8LiveProducer({...f,admission,releaseSha:'a'.repeat(40),configProof:'b'.repeat(64),enabled:()=>enabled,eligible:id=>id==='a'});
 const core=await buildPhase4Core({keys:f.keys,admission,liveProducingAuthority:capability,processing:{client:f.db.raw,transaction:f.db.transaction,active:f.db.processingTransactionActive,afterCommit:f.db.afterProcessingCommit,afterCompletion:f.db.afterProcessingCompletion},authorizeMode(mode,client,id){assert.equal(mode,'LIVE');assert.equal(id,'a');}});
 const capture=id=>core.capture(id,{executionMode:'LIVE'}),ctx=await capture('a');assert.throws(()=>core.assertAnalysisWrite(ctx),/SHADOW_ONLY/);
 const run=createStage8LiveExecutionRunner({...f,capability,capture,assertContext:ctx=>core.assertContext(ctx),work:async(id,ctx)=>{
  calls++;await core.run(ctx,async()=>{core.assertAnalysisWrite(ctx);await core.root(ctx,'USER',id);await bindProducingExecution(f.db.raw,ctx);},workStepOptions('live.kernel-unit',[id,ctx.inputGeneration],{discardResult:true}));
  return {outcome:'PARTIAL',unitsCommitted:1};
 }});
 const first=await run({userId:'a',requestId:'synthetic-kernel-request'});assert.equal(first.replayed,false);assert.equal(calls,1);
 const execution=(await f.db.raw.execute('SELECT * FROM stage8_live_executions')).rows[0];assert.equal(execution.state,'FINALIZED_SUCCESS');
 assert.equal((await f.db.raw.execute('SELECT count(*) n FROM stage8_live_execution_work_receipts')).rows[0].n,1);
 const producer=(await f.db.raw.execute('SELECT * FROM stage8_live_execution_producers')).rows[0];assert.equal(producer.tenant_proof,f.keys.lookup(['execution-producer-v1','a','LIVE',ctx.inputGeneration,execution.execution_id,execution.execution_seq,execution.generation]));
 const replay=await run({userId:'a',requestId:'synthetic-kernel-request'});assert.equal(replay.replayed,true);assert.equal(calls,1);
 await assert.rejects(run({userId:'b',requestId:'synthetic-peer-request'}),/PRODUCING_AUTHORITY/);
 await assert.rejects(f.db.raw.execute("UPDATE stage8_live_executions SET result_json='{}'"),/execution/);
 await assert.rejects(withDurableExecution({claim:{request:{executionMode:'LIVE'}},keys:f.keys,authority:{assert(){}}},()=>assertExecutionWorkOwner(f.db.raw)),/PRODUCING_AUTHORITY/);
 assert.equal((await f.db.raw.execute('SELECT count(*) n FROM phase4_execution_producers')).rows[0].n,0);
 assert.equal((await f.db.raw.execute("SELECT last_completed_generation n FROM phase4_computation_state WHERE user_id='a' AND execution_mode='LIVE'")).rows[0].n,0);
 enabled=false;await assert.rejects(run({userId:'a',requestId:'synthetic-revoked-request'}),/PRODUCING_AUTHORITY/);
});

test('a LIVE producing grant enforces tenant policy even with a permissive memory-only fixture mode callback',async t=>{
 const f=await syntheticPhase4Fixture(t,{targetVersion:35});await f.core.initializeTenant('b','LIVE');
 const admission=await f.db.admitRuntime(),capability=await authorizeStage8LiveProducer({...f,admission,releaseSha:'a'.repeat(40),configProof:'b'.repeat(64),enabled:()=>true,eligible:id=>id==='a'});
 const core=await buildPhase4Core({keys:f.keys,admission,liveProducingAuthority:capability,processing:{client:f.db.raw,transaction:f.db.transaction,active:f.db.processingTransactionActive},authorizeMode(){}});
 await assert.rejects(core.capture('b',{executionMode:'LIVE'}),/LIVE_FIXTURE|PRODUCING_AUTHORITY/);
});

test('expired crash after actual unit COMMIT is recovered as partial, never as completed analysis',async t=>{
 const f=await syntheticPhase4Fixture(t,{targetVersion:35});await f.core.initializeTenant('a','LIVE');let calls=0;
 const admission=await f.db.admitRuntime(),capability=await authorizeStage8LiveProducer({...f,admission,releaseSha:'a'.repeat(40),configProof:'b'.repeat(64),enabled:()=>true,eligible:id=>id==='a'});
 const core=await buildPhase4Core({keys:f.keys,admission,liveProducingAuthority:capability,processing:{client:f.db.raw,transaction:f.db.transaction,active:f.db.processingTransactionActive,afterCommit:f.db.afterProcessingCommit,afterCompletion:f.db.afterProcessingCompletion},authorizeMode(){}});
 const run=createStage8LiveExecutionRunner({...f,capability,capture:id=>core.capture(id,{executionMode:'LIVE'}),assertContext:ctx=>core.assertContext(ctx),work:async(id,ctx)=>{
  calls++;await core.run(ctx,()=>bindProducingExecution(f.db.raw,ctx),workStepOptions('live.crash-unit',[id,ctx.inputGeneration],{discardResult:true}));throw Error('SYNTHETIC_CRASH_AFTER_UNIT_COMMIT');
 }});
 const request={userId:'a',requestId:'synthetic-crashed-request'};await assert.rejects(run(request),/SYNTHETIC_CRASH/);await assert.rejects(run(request),/REQUEST_PENDING/);
 await f.db.raw.execute({sql:'UPDATE stage8_live_executions SET deadline_at=?,lease_until=?',args:[Date.now()-2,Date.now()-1]});
 const recovered=await run(request);assert.equal(recovered.recovered,true);assert.equal(recovered.result.outcome,'PARTIAL');assert.equal(calls,1);
 const row=(await f.db.raw.execute('SELECT * FROM stage8_live_executions')).rows[0];assert.equal(row.generation,2);assert.equal(row.state,'FINALIZED_SUCCESS');
 assert.equal((await f.db.raw.execute('SELECT count(*) n FROM stage8_live_execution_work_receipts')).rows[0].n,1);
 assert.equal((await f.db.raw.execute("SELECT last_completed_generation n FROM phase4_computation_state WHERE user_id='a' AND execution_mode='LIVE'")).rows[0].n,0);
 const {verifyLiveExecutionResult}=await import('../src/stage8LiveExecution.js');assert.equal(verifyLiveExecutionResult(f.keys,row).outcome,'PARTIAL');
 assert.throws(()=>verifyLiveExecutionResult(f.keys,{...row,result_digest:'0'.repeat(64)}),/INTEGRITY/);
 const result=JSON.parse(row.result_json);result.outcome='COMPLETE';const json=JSON.stringify(result),{bodySha256}=await import('../src/briefingTriggerAuth.js');
 assert.throws(()=>verifyLiveExecutionResult(f.keys,{...row,result_json:json,result_digest:bodySha256(json)}),/INTEGRITY/);
});

test('scope change after committed work fences aggregate publication and same-user generation reuse',async t=>{
 const f=await syntheticPhase4Fixture(t,{targetVersion:35});await f.core.initializeTenant('a','LIVE');
 const admission=await f.db.admitRuntime(),capability=await authorizeStage8LiveProducer({...f,admission,releaseSha:'a'.repeat(40),configProof:'b'.repeat(64),enabled:()=>true,eligible:id=>id==='a'});
 const core=await buildPhase4Core({keys:f.keys,admission,liveProducingAuthority:capability,processing:{client:f.db.raw,transaction:f.db.transaction,active:f.db.processingTransactionActive,afterCommit:f.db.afterProcessingCommit,afterCompletion:f.db.afterProcessingCompletion},authorizeMode(){}});
 const run=createStage8LiveExecutionRunner({...f,capability,capture:id=>core.capture(id,{executionMode:'LIVE'}),assertContext:ctx=>core.assertContext(ctx),work:async(id,ctx)=>{
  assert.throws(()=>core.assertAnalysisWrite({...ctx,inputGeneration:ctx.inputGeneration+1}),/SHADOW_ONLY/);
  await f.db.transaction(()=>f.db.raw.execute("UPDATE phase4_computation_state SET input_generation=input_generation+1 WHERE user_id='a' AND execution_mode='LIVE'"),workStepOptions('live.synthetic-concurrent-generation',[id,ctx.inputGeneration],{discardResult:true}));
  return {outcome:'COMPLETE'};
 }});
 const request={userId:'a',requestId:'synthetic-stale-request'};await assert.rejects(run(request),/INPUT_FENCED/);
 const row=(await f.db.raw.execute('SELECT * FROM stage8_live_executions')).rows[0];assert.equal(row.state,'ESTABLISHED');assert.equal(row.result_json,null);
 await assert.rejects(run(request),/REQUEST_CONFLICT/);
});
