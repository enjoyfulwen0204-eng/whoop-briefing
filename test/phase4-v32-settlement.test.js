import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createDb as applicationDb} from '../src/db.js';import {fixtureKeys} from './localDb.js';import {createOwnedDb} from './stage5OwnedDb.js';
import {hranaTransport} from './hranaTransport.js';import {runExecutionPhase} from '../src/phase4Execution.js';
import {configurationProof,readExecution,claimPhaseRequest,readPhaseProgress,requireSyncHandoff,commitPhaseWork,finalizePhaseWork} from '../src/phase4ExecutionStore.js';
import {runningReleaseSha} from '../src/phase4Release.js';import {createExecutionBudget} from '../src/executionBudget.js';
const environment={PHASE4_BETA_SHADOW_RUNTIME:'on',PHASE4_PUBLIC_BETA_MODE:'off'},env={timezone:'Asia/Taipei',dryRun:true,maxUserConcurrency:1};
const request=(extra={})=>({requestId:randomUUID(),releaseSha:runningReleaseSha(),phase:'SYNC',triggerSource:'manual',executionMode:'SHADOW',
 configProof:configurationProof(fixtureKeys,{runtime:'on',mode:'off'},environment),...extra});
const success=()=>({syncComplete:true,syncOutcome:'NO_NEW_DATA_SUCCESS',users:0,failed:0}),pause=ms=>new Promise(r=>setTimeout(r,ms));
async function fixture(t){const dir=await mkdtemp(join(tmpdir(),'p4-v32-http-')),url=`file:${join(dir,'db.sqlite')}`,seed=createOwnedDb({url});
 await seed.migrate({targetVersion:32});await seed.close();const transport=hranaTransport(url);
 const db=applicationDb({url:'https://isolated.invalid',fetch:transport.fetch,phase4Keys:fixtureKeys});
 t.after(async()=>{db.close();transport.close();await rm(dir,{recursive:true,force:true});});return {db,transport};}
const run=(db,value,extra={})=>runExecutionPhase({db,request:value,environment,env,keys:fixtureKeys,deps:{runBriefing:success},...extra});
for(const attack of ['cancel','deadline','lost-ack'])test(`v32 real HTTP work COMMIT ${attack}: indeterminate, read receipt/result, no replay, finalize once`,async t=>{
 const {db,transport}=await fixture(t),value=request(),controller=new AbortController();let work=0;
 const deps={runBriefing:async()=>{work++;transport.arm({before:async()=>{if(attack==='cancel')controller.abort();else if(attack==='deadline')await pause(1200);},
  loseAcknowledgement:attack==='lost-ack'});return success();}};
 const original=await run(db,value,{signal:controller.signal,...(attack==='deadline'?{budgetMs:5000,overallBudgetMs:1000}:{}),deps});
 assert.equal(original.body.ok,false);assert.equal(original.body.drainAuthorized,false);assert.equal(original.body.handoff,undefined);
 assert.ok(['COMMIT_INDETERMINATE','TIMEOUT','CANCELLED'].includes(original.body.result.outcome));
 const readDeadline=Date.now()+2500;while(!transport.evidence.some(event=>event.event==='commit_durable')&&Date.now()<readDeadline)await pause(10);
 assert.ok(transport.evidence.some(event=>event.event==='commit_durable'),'controlled late COMMIT must land before reconciliation');
 assert.equal((await readExecution(db,value.requestId)).state,'WORK_COMMITTED');
 assert.equal((await readPhaseProgress(db,'SYNC','manual')).state,'WORK_COMMITTED_UNFINALIZED');
 await assert.rejects(()=>requireSyncHandoff(db,{...value,syncRequestId:value.requestId,handoff:'a'.repeat(64)},fixtureKeys));
 const reconciled=await run(db,value,{deps});assert.equal(reconciled.body.syncComplete,true);assert.equal(work,1);
 const retry=await run(db,value,{deps});assert.deepEqual(retry,reconciled);assert.equal(work,1);
 assert.equal((await readExecution(db,value.requestId)).state,'FINALIZED_SUCCESS');
});
for(const attack of ['cancel','deadline','lost-ack'])test(`v32 real HTTP finalization COMMIT ${attack}: durable truth on fresh read, one deterministic handoff`,async t=>{
 const {db,transport}=await fixture(t),value=request(),claim=await claimPhaseRequest(db,value,JSON.stringify(value),{keys:fixtureKeys}),budget=createExecutionBudget();
 await commitPhaseWork(db,value,claim,{outcome:'NO_NEW_DATA_SUCCESS'},budget);budget.close();
 const controller=new AbortController(),authority=createExecutionBudget({budgetMs:5000,signal:controller.signal});
 transport.arm({before:async()=>{if(attack==='cancel')controller.abort();else if(attack==='deadline')await pause(Math.max(0,authority.deadlineAt-Date.now())+25);},loseAcknowledgement:attack==='lost-ack'});
 await assert.rejects(()=>finalizePhaseWork(db,value,claim,fixtureKeys,authority));authority.close();
 const row=await readExecution(db,value.requestId);assert.equal(row.state,'FINALIZED_SUCCESS');
 const finalizedAt=row.finalized_at;let called=0;const deps={runBriefing:async()=>{called++;return success();}};
 const first=await run(db,value,{deps}),second=await run(db,value,{deps});assert.equal(first.body.syncComplete,true);assert.deepEqual(first,second);
 assert.equal(called,0);assert.equal((await readExecution(db,value.requestId)).finalized_at,finalizedAt);
});
test('v32 real HTTP lease expiry during submitted work COMMIT cannot finalize; fresh generation reconciles without replay',async t=>{
 const {db,transport}=await fixture(t),value=request();let work=0;
 const deps={runBriefing:async()=>{
  work++;const expires=Date.now()+500;
  await db.raw.execute({sql:'UPDATE phase4_executions SET lease_until=?,deadline_at=? WHERE execution_id=?',args:[expires,expires,value.requestId]});
  transport.arm({onlyWorkResult:true,before:()=>pause(650)});return success();
 }};
 const first=await run(db,value,{deps});assert.equal(first.body.ok,false);assert.equal(first.body.drainAuthorized,false);assert.equal(first.body.handoff,undefined);
 assert.equal((await readExecution(db,value.requestId)).state,'WORK_COMMITTED');
 assert.equal((await db.raw.execute("SELECT count(*) n FROM system_heartbeats WHERE component='phase4_sync:manual:complete'")).rows[0].n,0);
 const retry=await run(db,value,{deps});assert.equal(retry.body.syncComplete,true);assert.equal(work,1);
 assert.equal((await readExecution(db,value.requestId)).generation,2);
});
for(const outcome of ['NO_WORK','PARTIAL','COMPLETE'])test(`v32 Stage6 ${outcome} committed/unfinalized is not completion; reconciliation preserves bounded counts`,async t=>{
 const {db,transport}=await fixture(t),sync=request(),s=await run(db,sync),value=request({phase:'STAGE6_DRAIN',syncRequestId:sync.requestId,handoff:s.body.handoff});
 const controller=new AbortController();let drains=0;
 const deps={runtime:{phase4Stage6:{drain:async()=>{drains++;transport.arm({before:async()=>{controller.abort();await pause(20);}});
  return {outcome,jobsConsidered:1,itemsAttempted:outcome==='NO_WORK'?0:3,processedItems:outcome==='NO_WORK'?0:3,
   completedJobs:outcome==='COMPLETE'?1:0,remainingJobs:outcome==='PARTIAL'?1:0,completion:outcome==='PARTIAL'?'PARTIAL':'COMPLETE'};}}}};
 const first=await run(db,value,{deps,signal:controller.signal});assert.equal(first.body.ok,false);await pause(100);
 assert.equal((await readPhaseProgress(db,'STAGE6_DRAIN','manual')).state,'WORK_COMMITTED_UNFINALIZED');
 const reconciled=await run(db,value,{deps});assert.equal(reconciled.body.ok,true);assert.equal(reconciled.body.result.outcome,outcome);assert.equal(drains,1);
 assert.equal(reconciled.body.result.itemsProcessed,outcome==='NO_WORK'?0:3);
});
test('v32 cancellation before submission and stale generation cannot finalize; definite work failure leaves no committed result',async t=>{
 const {db}=await fixture(t),value=request(),claim=await claimPhaseRequest(db,value,JSON.stringify(value),{keys:fixtureKeys});
 const controller=new AbortController(),authority=createExecutionBudget({signal:controller.signal});controller.abort();
 await assert.rejects(()=>commitPhaseWork(db,value,claim,{outcome:'NO_NEW_DATA_SUCCESS'},authority));authority.close();
 assert.equal((await readExecution(db,value.requestId)).state,'ESTABLISHED');
 await db.raw.execute({sql:'UPDATE phase4_executions SET owner=?,generation=generation+1 WHERE execution_id=?',args:['successor',value.requestId]});
 const valid=createExecutionBudget();try{await assert.rejects(()=>commitPhaseWork(db,value,claim,{outcome:'NO_NEW_DATA_SUCCESS'},valid),/OWNER_FENCED/);}finally{valid.close();}
});
test('v32 cannot insert fabricated finalized authority or mutate an immutable finalized generation',async t=>{
 const {db}=await fixture(t),value=request();await run(db,value);
 const row=await readExecution(db,value.requestId),columns=Object.keys(row);
 const args=columns.map(column=>column==='execution_id'?randomUUID():row[column]);
 await assert.rejects(()=>db.raw.execute({sql:`INSERT INTO phase4_executions(${columns.join(',')}) VALUES(${columns.map(()=>'?').join(',')})`,args}),/initial_authority/);
 await assert.rejects(()=>db.raw.execute({sql:'UPDATE phase4_executions SET generation=generation+1,owner=? WHERE execution_id=?',args:['forged-successor',value.requestId]}),/execution_finalize_authority/);
 assert.deepEqual(await readExecution(db,value.requestId),row);
});
test('v32 each actual work transaction carries a receipt, with failed work rolling back receipt and effect',async t=>{
 const {db}=await fixture(t),value=request();const response=await run(db,value,{deps:{runBriefing:async()=>{
  await db.transaction(()=>db.raw.execute("INSERT INTO telegram_state(key,value,updated_at) VALUES('isolated_work','1','2026-10-08')"));
  await assert.rejects(()=>db.transaction(async()=>{await db.raw.execute("INSERT INTO telegram_state(key,value,updated_at) VALUES('isolated_rollback','1','2026-10-08')");throw Error('DEFINITE_WORK_FAILURE');}));
  return success();}}});assert.equal(response.body.ok,true);
 assert.equal((await db.raw.execute("SELECT count(*) n FROM telegram_state WHERE key='isolated_rollback'")).rows[0].n,0);
 assert.equal((await db.raw.execute({sql:'SELECT count(*) n FROM phase4_execution_work_receipts WHERE execution_id=?',args:[value.requestId]})).rows[0].n,1);
});
test('v32 real HTTP definite COMMIT constraint rejection rolls back effect and never replays the callback',async t=>{
 const {db}=await fixture(t);let callbacks=0;
 await assert.rejects(()=>db.transaction(async()=>{
  callbacks++;await db.raw.execute('PRAGMA defer_foreign_keys=ON');
  await db.raw.execute("INSERT INTO user_locale_prompts(user_id,prompted_at) VALUES('isolated_missing_fk_user','2026-10-08')");
 }),error=>/^SQLITE_CONSTRAINT/.test(error.code));
 assert.equal(callbacks,1);assert.equal((await db.raw.execute("SELECT count(*) n FROM user_locale_prompts WHERE user_id='isolated_missing_fk_user'")).rows[0].n,0);
 assert.equal((await db.raw.execute('PRAGMA foreign_key_check')).rows.length,0);
});
test('v32 failed heartbeat projection is reconstructed from immutable finalized truth without a new timestamp/handoff',async t=>{
 const {db}=await fixture(t),value=request(),execute=db.raw.execute;let fail=true,work=0;
 db.raw.execute=async statement=>{if(fail&&statement?.args?.[1]?.endsWith(':complete'))throw Error('ISOLATED_PROJECTION_FAILURE');return execute(statement);};
 const options={deps:{runBriefing:async()=>{work++;return success();}}};
 const first=await run(db,value,options);assert.equal(first.body.syncComplete,true);
 const row=await readExecution(db,value.requestId);assert.equal(row.state,'FINALIZED_SUCCESS');
 assert.equal((await db.raw.execute("SELECT count(*) n FROM system_heartbeats WHERE component='phase4_sync:manual:complete'")).rows[0].n,0);
 fail=false;const retry=await run(db,value,options);assert.deepEqual(retry,first);assert.equal(work,1);
 const heartbeat=(await db.raw.execute("SELECT updated_at,last_detail FROM system_heartbeats WHERE component='phase4_sync:manual:complete'")).rows[0];
 assert.equal(Date.parse(heartbeat.updated_at),row.finalized_at);assert.equal(JSON.parse(heartbeat.last_detail).handoff,undefined);
});
test('v32 reconciling an older execution cannot hide a newer unfinalized invocation in phase diagnostics',async t=>{
 const {db}=await fixture(t),older=request(),first=await claimPhaseRequest(db,older,JSON.stringify(older),{keys:fixtureKeys}),authority=createExecutionBudget();
 try{
  await commitPhaseWork(db,older,first,{outcome:'NO_NEW_DATA_SUCCESS'},authority);
  await pause(5);const newer=request();await claimPhaseRequest(db,newer,JSON.stringify(newer),{keys:fixtureKeys});
  const finalized=await finalizePhaseWork(db,older,first,fixtureKeys,authority);assert.equal(finalized.settlementState,'FINALIZED_SUCCESS');
  const progress=await readPhaseProgress(db,'SYNC','manual');assert.equal(progress.execution.execution_id,newer.requestId);
  assert.equal(progress.state,'IN_PROGRESS');assert.equal(progress.complete,null);
 }finally{authority.close();}
});
