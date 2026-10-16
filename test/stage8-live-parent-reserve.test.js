import test from 'node:test';
import assert from 'node:assert/strict';
import {syntheticPhase4Fixture} from './phase4Fixture.js';
import {buildPhase4Core} from '../src/phase4Core.js';
import {createPhase4Stage6,authorizeStage6ShadowWorker} from '../src/phase4Reanalysis.js';
import {authorizeStage8LiveProducer} from '../src/stage8LiveProducerAuthority.js';
import {createStage8LiveExecutionRunner} from '../src/stage8LiveExecution.js';
import {createStage8LiveProducer} from '../src/stage8LiveProducer.js';
import {createExecutionBudget,currentExecutionBudget,withExecutionBudget} from '../src/executionBudget.js';
import {bindProducingExecution} from '../src/phase4ExecutionContext.js';
import {workStepOptions} from '../src/phase4WorkStep.js';

const count=async(db,table)=>(await db.raw.execute(`SELECT count(*) n FROM ${table}`)).rows[0].n;
async function kernel(t){
 const f=await syntheticPhase4Fixture(t,{targetVersion:35,ownedConnection:true,now:()=>new Date()});
 const admission=await f.db.admitRuntime(),capability=await authorizeStage8LiveProducer({...f,admission,releaseSha:'a'.repeat(40),configProof:'b'.repeat(64),enabled:()=>true,eligible:id=>id==='a'});
 const core=await buildPhase4Core({keys:f.keys,admission,liveProducingAuthority:capability,
  processing:{client:f.db.raw,transaction:f.db.transaction,active:f.db.processingTransactionActive,afterCommit:f.db.afterProcessingCommit,afterCompletion:f.db.afterProcessingCompletion},authorizeMode(){}});
 await core.initializeTenant('a','LIVE');
 return {...f,core,admission,capability,runner:work=>createStage8LiveExecutionRunner({...f,capability,capture:id=>core.capture(id,{executionMode:'LIVE'}),assertContext:ctx=>core.assertContext(ctx),work})};
}

test('short LIVE parent limits the actual child deadline while durable identity, lease and replay receipts remain unchanged',async t=>{
 const f=await kernel(t);let calls=0,observed;
 const run=f.runner(async(id,ctx)=>{
  calls++;observed=currentExecutionBudget();
  await f.core.run(ctx,()=>bindProducingExecution(f.db.raw,ctx),workStepOptions('live.parent-reserve-unit',[id],{discardResult:true}));
  return {outcome:'PARTIAL',unitsCommitted:1};
 });
 const request={userId:'a',requestId:'short-parent-original-identity'},parent=createExecutionBudget({budgetMs:10000});
 try{
  const first=await withExecutionBudget(parent,()=>run(request));assert.equal(first.result.outcome,'PARTIAL');
  assert.ok(observed.deadlineAt<=parent.deadlineAt);assert.ok(observed.deadlineAt-observed.startedAt<=10000);
 }finally{parent.close();}
 const [before]=(await f.db.raw.execute('SELECT * FROM stage8_live_executions')).rows;
 assert.equal(before.deadline_at-before.created_at,45000);assert.equal(before.lease_until-before.created_at,60000);
 assert.equal(before.execution_id,request.requestId);assert.equal(before.generation,1);assert.equal(before.state,'FINALIZED_SUCCESS');
 assert.equal(await count(f.db,'stage8_live_execution_work_receipts'),1);assert.equal(await count(f.db,'stage8_live_publications'),0);
 const replayParent=createExecutionBudget({budgetMs:5000});
 try{const replay=await withExecutionBudget(replayParent,()=>run(request));assert.equal(replay.replayed,true);assert.equal(replay.result.outcome,'PARTIAL');}
 finally{replayParent.close();}
 assert.equal(calls,1);assert.deepEqual((await f.db.raw.execute('SELECT * FROM stage8_live_executions')).rows,[before]);
 assert.equal(await count(f.db,'stage8_live_execution_work_receipts'),1);assert.equal(await count(f.db,'stage8_live_publications'),0);
});

test('LIVE worker subtracts settlement reserve from actual inherited time and never extends the thirty-second productive cap',async t=>{
 const f=await kernel(t);let elapsed=0,calls=0;
 const worker=await createPhase4Stage6({...f,executionMode:'LIVE',liveProducingAuthority:f.capability,monotonicNow:()=>elapsed});
 await worker.rolloutAlgorithm({userId:'a'});
 const run=f.runner(async()=>{
  calls++;return worker.drain({userId:'a',onProgress:async event=>{if(event.event==='discovery_complete')elapsed=advance;}});
 });
 let advance;
 for(const [budgetMs,discoveryMs] of [[14000,0],[18000,4000],[60000,30000]]){
  elapsed=0;advance=discoveryMs;const parent=createExecutionBudget({budgetMs});
  try{
   const value=await withExecutionBudget(parent,()=>run({userId:'a',requestId:`reserve-bound-${budgetMs}`}));
   assert.equal(value.result.outcome,'BUDGET_EXHAUSTED');assert.equal(value.result.unitsCommitted,0);
  }finally{parent.close();}
 }
 assert.equal(calls,3);assert.equal(await count(f.db,'stage8_live_execution_work_receipts'),0);
 assert.equal(await count(f.db,'stage8_live_job_completions'),0);assert.equal(await count(f.db,'stage8_live_publications'),0);
 const jobs=(await f.db.raw.execute("SELECT * FROM phase4_jobs WHERE user_id='a' AND execution_mode='LIVE'")).rows;
 assert.equal(jobs.length,2);assert.ok(jobs.every(row=>row.state==='PENDING'&&row.attempt===0&&row.lease_owner===null&&row.completed_generation===0));
 const before=(await f.db.raw.execute('SELECT * FROM stage8_live_executions ORDER BY execution_seq')).rows;
 const parent=createExecutionBudget({budgetMs:5000});
 try{assert.equal((await withExecutionBudget(parent,()=>run({userId:'a',requestId:'reserve-bound-14000'}))).replayed,true);}
 finally{parent.close();}
 assert.equal(calls,3);assert.deepEqual((await f.db.raw.execute('SELECT * FROM stage8_live_executions ORDER BY execution_seq')).rows,before);
 assert.equal(await count(f.db,'stage8_live_execution_work_receipts'),0);
});

test('a parent expiring between initial assertion and remaining-time capture cannot receive a one-millisecond LIVE authority window',async t=>{
 const f=await kernel(t);let captures=0,work=0;
 const run=createStage8LiveExecutionRunner({...f,capability:f.capability,capture:async id=>{captures++;return f.core.capture(id,{executionMode:'LIVE'});},assertContext:ctx=>f.core.assertContext(ctx),work:async()=>{work++;return {outcome:'NO_WORK'};}});
 const now=Date.now();let reads=0,expireAt=Infinity;
 const parent=createExecutionBudget({budgetMs:60000,nowMs:()=>now+(++reads>=expireAt?60000:0)});
 reads=0;expireAt=2;
 try{await assert.rejects(withExecutionBudget(parent,()=>run({userId:'a',requestId:'expired-parent-max-one'})),error=>error.code==='SYNC_TIMEOUT');}
 finally{parent.close();}
 const cancelled=createExecutionBudget({budgetMs:60000});cancelled.cancel();
 try{await assert.rejects(withExecutionBudget(cancelled,()=>run({userId:'a',requestId:'cancelled-parent-max-one'})),error=>error.code==='SYNC_CANCELLED');}
 finally{cancelled.close();}
 assert.equal(captures,0);assert.equal(work,0);assert.equal(await count(f.db,'stage8_live_executions'),0);
 assert.equal(await count(f.db,'stage8_live_execution_work_receipts'),0);assert.equal(await count(f.db,'stage8_live_publications'),0);
});

test('genuine LIVE producer preparation and nested execution share a short parent without claiming work or publishing a result',async t=>{
 const f=await syntheticPhase4Fixture(t,{targetVersion:35,ownedConnection:true,now:()=>new Date()});
 await f.db.raw.execute("INSERT INTO user_whoop_tokens(user_id,access_token,refresh_token,access_token_expires_at,updated_at,auth_generation) VALUES('a','SYNTHETIC','SYNTHETIC','2099-01-01','2026-10-16',1)");
 await f.db.ensureOnboarding('a',{state:'READY'});
 const producer=await createStage8LiveProducer({...f,admission:await f.db.admitRuntime(),userIds:['a'],enabled:()=>true,eligible:id=>id==='a'});
 const parent=createExecutionBudget({budgetMs:14000}),execute=f.db.raw.execute.bind(f.db.raw);let preparationDeadline,nestedDeadline;
 f.db.raw.execute=async statement=>{
  const sql=typeof statement==='string'?statement:statement.sql,budget=currentExecutionBudget();
  if(sql.startsWith('SELECT expires_at FROM stage8_live_publications'))preparationDeadline=budget.deadlineAt;
  if(sql.startsWith('INSERT INTO stage8_live_executions('))nestedDeadline=budget.deadlineAt;
  return execute(statement);
 };
 let first;
 try{first=await withExecutionBudget(parent,()=>producer.run({userId:'a',requestId:'genuine-short-parent-original'}));}
 finally{f.db.raw.execute=execute;parent.close();}
 assert.equal(first.result.outcome,'BUDGET_EXHAUSTED');assert.equal(first.result.unitsCommitted,0);assert.equal(first.publication.status,'ANALYSIS_UPDATING');
 assert.ok(Number.isFinite(preparationDeadline)&&preparationDeadline<=parent.deadlineAt);
 assert.ok(Number.isFinite(nestedDeadline)&&nestedDeadline<=preparationDeadline);
 const [before]=(await f.db.raw.execute('SELECT * FROM stage8_live_executions')).rows;
 assert.equal(before.state,'FINALIZED_SUCCESS');assert.equal(before.deadline_at-before.created_at,45000);assert.equal(before.lease_until-before.created_at,60000);
 assert.equal(await count(f.db,'stage8_live_execution_work_receipts'),0);assert.equal(await count(f.db,'stage8_live_job_completions'),0);assert.equal(await count(f.db,'stage8_live_publications'),0);
 const replayParent=createExecutionBudget({budgetMs:14000});
 try{const replay=await withExecutionBudget(replayParent,()=>producer.run({userId:'a',requestId:'genuine-short-parent-original'}));assert.equal(replay.replayed,true);assert.equal(replay.publication.status,'ANALYSIS_UPDATING');}
 finally{replayParent.close();}
 assert.deepEqual((await f.db.raw.execute('SELECT * FROM stage8_live_executions')).rows,[before]);
 assert.equal(await count(f.db,'stage8_live_execution_work_receipts'),0);assert.equal(await count(f.db,'stage8_live_publications'),0);
});

test('SHADOW worker retains its original productive window even inside a short parent',async t=>{
 const f=await syntheticPhase4Fixture(t,{targetVersion:28,ownedConnection:true,now:()=>new Date()});
 await f.stores.queue.sourceChanged(await f.stores.captureControl('a'));
 let elapsed=0;
 const worker=await createPhase4Stage6({...f,executionMode:'SHADOW',workerCapability:authorizeStage6ShadowWorker({executionMode:'SHADOW'}),monotonicNow:()=>elapsed});
 const parent=createExecutionBudget({budgetMs:14000});let result;
 try{result=await withExecutionBudget(parent,()=>worker.drain({userId:'a',onProgress:async event=>{if(event.event==='discovery_complete')elapsed=1000;}}));}
 finally{parent.close();}
 assert.equal(result.claimedJobs,1);assert.equal(result.stoppedForBudget,false);assert.equal(result.failedJobs,0);
});
