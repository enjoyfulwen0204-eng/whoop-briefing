import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {syntheticPhase4Fixture} from './phase4Fixture.js';
import {createOwnedDb} from './stage5OwnedDb.js';
import {fixtureKeys} from './localDb.js';
import {hranaTransport} from './hranaTransport.js';
import {createDb} from '../src/db.js';
import {buildPhase4Core} from '../src/phase4Core.js';
import {authorizeStage8LiveProducer} from '../src/stage8LiveProducerAuthority.js';
import {createStage8LiveExecutionRunner} from '../src/stage8LiveExecution.js';
import {createStage8LiveProducer} from '../src/stage8LiveProducer.js';
import {createExecutionBudget,withExecutionBudget,currentExecutionBudget,ExecutionBudgetError} from '../src/executionBudget.js';
import {bindProducingExecution} from '../src/phase4ExecutionContext.js';
import {workStepOptions} from '../src/phase4WorkStep.js';
import {closeOnlyPayload} from '../src/hranaCleanup.js';

const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const sqls=body=>{
 const values=[];const visit=value=>{if(!value||typeof value!=='object')return;if(typeof value.sql==='string')values.push(value.sql);for(const child of Object.values(value))if(child&&typeof child==='object')visit(child);};visit(body);return values;
};
async function kernel(f){
 const admission=await f.db.admitRuntime(),capability=await authorizeStage8LiveProducer({...f,admission,releaseSha:'a'.repeat(40),configProof:'b'.repeat(64),enabled:()=>true,eligible:id=>id==='a'});
 const core=await buildPhase4Core({keys:f.keys,admission,liveProducingAuthority:capability,
  processing:{client:f.db.raw,transaction:f.db.transaction,active:f.db.processingTransactionActive,afterCommit:f.db.afterProcessingCommit,afterCompletion:f.db.afterProcessingCompletion},authorizeMode(mode,_client,id){assert.equal(mode,'LIVE');assert.equal(id,'a');}});
 await core.initializeTenant('a','LIVE');
 return {...f,core,capability,runner:work=>createStage8LiveExecutionRunner({...f,capability,capture:id=>core.capture(id,{executionMode:'LIVE'}),assertContext:ctx=>core.assertContext(ctx),work})};
}
async function httpFixture(t,{producer=false}={}){
 const dir=await mkdtemp(join(tmpdir(),'stage8-live-abort-')),url=`file:${join(dir,'isolated.db')}`,seed=createOwnedDb({url});
 try{
  await seed.migrate({targetVersion:35});await seed.createUser({id:'a',displayName:'Synthetic',timezone:'Asia/Taipei',status:'ACTIVE'});
  if(producer){await seed.raw.execute("INSERT INTO user_whoop_tokens(user_id,access_token,refresh_token,access_token_expires_at,updated_at,auth_generation) VALUES('a','SYNTHETIC','SYNTHETIC','2099-01-01','2026-10-16',1)");await seed.ensureOnboarding('a',{state:'READY'});}
 }finally{await seed.close();}
 const transport=hranaTransport(url),events=[];let hook;
 const db=createDb({url:'https://isolated.invalid',phase4Keys:fixtureKeys,fetch:async request=>{
  assert.equal(new URL(request.url).hostname,'isolated.invalid');const body=await request.clone().json(),budget=currentExecutionBudget();
  events.push({body,sql:sqls(body),aborted:request.signal.aborted,budgetMs:budget?budget.deadlineAt-budget.startedAt:null});
  return hook?hook({request,body,sql:sqls(body),transport,budget}):transport.fetch(request);
 }});
 t.after(async()=>{db.close();transport.close();await rm(dir,{recursive:true,force:true});});
 return {db,keys:fixtureKeys,transport,events,setHook:value=>{hook=value;}};
}
async function executionRows(db){return (await db.raw.execute('SELECT * FROM stage8_live_executions ORDER BY execution_seq')).rows;}
async function count(db,table){return (await db.raw.execute(`SELECT count(*) n FROM ${table}`)).rows[0].n;}

test('LIVE cancellation joins the actual late callback and revokes its original durable write authority',async t=>{
 const f=await kernel(await syntheticPhase4Fixture(t,{targetVersion:35})),entered=deferred(),release=deferred(),controller=new AbortController();let callbackFinished=false,lateError,settled=false,workBudget;
 const run=f.runner(async(_id,ctx)=>{
  workBudget=currentExecutionBudget();assert.equal(workBudget.deadlineAt-workBudget.startedAt,45000);entered.resolve();await release.promise;
  try{await f.core.run(ctx,()=>bindProducingExecution(f.db.raw,ctx),workStepOptions('live.late-abort-unit',['a'],{discardResult:true}));}catch(error){lateError=error;}
  callbackFinished=true;return {outcome:'PARTIAL',unitsCommitted:0};
 });
 const parent=createExecutionBudget({budgetMs:60000,signal:controller.signal}),pending=withExecutionBudget(parent,()=>run({userId:'a',requestId:'late-callback-budget-request'}));pending.then(()=>{settled=true;},()=>{settled=true;});
 try{
  await entered.promise;controller.abort();await tick();assert.equal(settled,false,'abort revokes authority but must not race-return an unsettled callback');assert.equal(callbackFinished,false);
  release.resolve();await assert.rejects(pending,error=>error.code==='SYNC_CANCELLED');assert.equal(callbackFinished,true);assert.equal(lateError.code,'SYNC_CANCELLED');assert.equal(workBudget.signal.aborted,true);
 }finally{release.resolve();parent.close();}
 const [row]=await executionRows(f.db);assert.equal(row.state,'ESTABLISHED');assert.equal(row.result_json,null);assert.equal(row.generation,1);assert.equal(row.deadline_at-row.created_at,45000);assert.equal(row.lease_until-row.created_at,60000);
 assert.equal(await count(f.db,'stage8_live_execution_work_receipts'),0);assert.equal(await count(f.db,'stage8_live_publications'),0);
 await assert.rejects(run({userId:'a',requestId:'late-callback-budget-request'}),/REQUEST_PENDING/);assert.equal((await executionRows(f.db)).length,1);
});

test('LIVE parent timeout aborts blocked real HTTP SQL and retains the original unfinalized identity',async t=>{
 const f=await kernel(await httpFixture(t)),entered=deferred(),controller=new AbortController();let blockedSignal,callbackFinished=false;
 const run=f.runner(async(id,ctx)=>{
  try{await f.core.run(ctx,async()=>{await bindProducingExecution(f.db.raw,ctx);await f.db.raw.execute('SELECT 424242 AS blocked_live_http');},workStepOptions('live.blocked-http',[id],{discardResult:true}));}
  finally{callbackFinished=true;}
  return {outcome:'PARTIAL',unitsCommitted:1};
 });
 f.setHook(({request,sql,transport})=>{
  if(sql.some(value=>value.includes('blocked_live_http'))){blockedSignal=request.signal;entered.resolve();return new Promise((_,reject)=>{const abort=()=>reject(request.signal.reason);if(request.signal.aborted)abort();else request.signal.addEventListener('abort',abort,{once:true});});}
  return transport.fetch(request);
 });
 const parent=createExecutionBudget({budgetMs:60000,signal:controller.signal}),pending=withExecutionBudget(parent,()=>run({userId:'a',requestId:'blocked-http-budget-request'}));
 try{await entered.promise;const after=f.events.length;controller.abort(new ExecutionBudgetError('SYNC_TIMEOUT'));await assert.rejects(pending,/SYNC_TIMEOUT/);assert.equal(blockedSignal.aborted,true);assert.equal(callbackFinished,true);await tick();assert.ok(f.events.slice(after).every(event=>closeOnlyPayload(event.body)),'after abort only existing-baton protocol close may reach physical transport');}
 finally{parent.close();f.setHook(null);}
 const [row]=await executionRows(f.db);assert.equal(row.state,'ESTABLISHED');assert.equal(row.result_json,null);assert.equal(row.generation,1);assert.equal(row.deadline_at-row.created_at,45000);
 assert.equal(await count(f.db,'stage8_live_execution_work_receipts'),0);assert.equal(await count(f.db,'stage8_live_execution_producers'),0);assert.equal(await count(f.db,'stage8_live_publications'),0);
});

for(const cancelAfterCommit of [false,true])test(`LIVE lost COMMIT acknowledgement preserves durable receipts and uncertainty${cancelAfterCommit?' despite parent cancellation and swallowed work error':''}`,async t=>{
 const f=await kernel(await httpFixture(t)),controller=new AbortController();let observed;
 const run=f.runner(async(id,ctx)=>{
  try{await f.core.run(ctx,async()=>{await bindProducingExecution(f.db.raw,ctx);await f.db.raw.execute({sql:"INSERT INTO telegram_state(key,value,updated_at) VALUES(?,'synthetic','2026-10-16')",args:[`ack-${cancelAfterCommit}`]});},workStepOptions('live.unknown-ack',[id,cancelAfterCommit],{discardResult:true}));}
  catch(error){observed=error;if(!cancelAfterCommit)throw error;}
  return {outcome:'PARTIAL',unitsCommitted:1};
 });
 f.transport.arm({matchSql:/INSERT INTO telegram_state/,loseAcknowledgement:true,...(cancelAfterCommit?{after:()=>controller.abort()}: {})});
 const parent=createExecutionBudget({budgetMs:60000,signal:controller.signal});
 try{await assert.rejects(withExecutionBudget(parent,()=>run({userId:'a',requestId:`unknown-http-ack-${cancelAfterCommit}`})),error=>error.code==='COMMIT_INDETERMINATE');}
 finally{parent.close();}
 assert.equal(observed.code,'COMMIT_INDETERMINATE');const [row]=await executionRows(f.db);assert.equal(row.state,'ESTABLISHED');assert.equal(row.result_json,null);assert.equal(row.generation,1);
 assert.equal(await count(f.db,'telegram_state'),1);assert.equal(await count(f.db,'stage8_live_execution_work_receipts'),1);assert.equal(await count(f.db,'stage8_live_execution_producers'),1);assert.equal(await count(f.db,'stage8_live_publications'),0);
 await assert.rejects(run({userId:'a',requestId:`unknown-http-ack-${cancelAfterCommit}`}),/REQUEST_PENDING/);assert.equal(await count(f.db,'telegram_state'),1);
});

test('outer LIVE budget covers initialization and independent context cleanup cannot replace the original failure',async t=>{
 const f=await httpFixture(t,{producer:true}),admission=await f.db.admitRuntime();let cleanupAttempted=false;
 const producer=await createStage8LiveProducer({...f,admission,userIds:['a'],enabled:()=>true,eligible:id=>id==='a'});
 f.setHook(async({request,body,sql,transport,budget})=>{
  if(sql.some(value=>/DELETE FROM resource_locks WHERE name=\? AND owner=\?/.test(value))&&budget?.deadlineAt-budget?.startedAt===5000){cleanupAttempted=true;throw Error('INDEPENDENT_CLEANUP_FAILURE');}
  if(sql.some(value=>/SELECT expires_at FROM stage8_live_publications/.test(value))){
   assert.equal(budget.deadlineAt-budget.startedAt,45000);const changed=structuredClone(body),replace=value=>{if(!value||typeof value!=='object')return;if(typeof value.sql==='string'&&/SELECT expires_at FROM stage8_live_publications/.test(value.sql))value.sql='SELECT * FROM original_live_failure WHERE user_id=? AND input_generation=?';for(const child of Object.values(value))if(child&&typeof child==='object')replace(child);};replace(changed);
   return transport.fetch(new Request(request,{body:JSON.stringify(changed)}));
  }
  return transport.fetch(request);
 });
 await assert.rejects(producer.run({userId:'a',requestId:'outer-live-original-failure'}),error=>error.code==='SQLITE_ERROR'&&/original_live_failure/.test(error.message));
 assert.equal(cleanupAttempted,true);f.setHook(null);assert.equal(await count(f.db,'stage8_live_publications'),0);
 assert.ok(f.events.filter(event=>event.budgetMs===5000).every(event=>event.sql.every(value=>!/\b(?:INSERT|UPDATE|DELETE)\b/i.test(value)||/^DELETE FROM resource_locks WHERE name=\? AND owner=\?/.test(value))),'independent cleanup submits only captured lease deletion and metadata reads');
});

test('outer LIVE parent abort fences actual publication after canonical work without forging or deleting its completion',async t=>{
 const f=await httpFixture(t,{producer:true}),admission=await f.db.admitRuntime(),producer=await createStage8LiveProducer({...f,admission,userIds:['a'],enabled:()=>true,eligible:id=>id==='a'}),controller=new AbortController(),parent=createExecutionBudget({budgetMs:60000,signal:controller.signal});let publicationAttempted=false,attemptBudget;
 f.setHook(({request,sql,transport,budget})=>{
  if(sql.some(value=>/INSERT INTO stage8_live_publications\(/.test(value))){publicationAttempted=true;attemptBudget=budget;controller.abort(new ExecutionBudgetError('SYNC_TIMEOUT'));return Promise.reject(request.signal.reason);}
  return transport.fetch(request);
 });
 let failure,lastLeg;
 try{for(let leg=0;leg<8;leg++){lastLeg=leg;try{await withExecutionBudget(parent,()=>producer.run({userId:'a',requestId:`outer-publication-abort-${leg}`}));}catch(error){failure=error;break;}}}
 finally{parent.close();f.setHook(null);}
 assert.equal(publicationAttempted,true,'a genuine canonical empty business result must reach publication');assert.match(failure?.message??'',/SYNC_TIMEOUT/);assert.equal(attemptBudget.deadlineAt-attemptBudget.startedAt,45000);
 assert.equal(await count(f.db,'stage8_live_publications'),0);assert.equal(await count(f.db,'stage8_live_job_completions'),2);
 const jobs=(await f.db.raw.execute("SELECT * FROM phase4_jobs WHERE user_id='a' AND execution_mode='LIVE'")).rows;assert.equal(jobs.length,2);assert.ok(jobs.every(row=>row.state==='COMPLETED'&&row.completed_generation===row.requested_generation));
 const rows=await executionRows(f.db);assert.ok(rows.length>0);assert.ok(rows.every(row=>row.state==='FINALIZED_SUCCESS'&&row.generation===1));assert.equal((await f.db.raw.execute("SELECT last_completed_generation=input_generation complete FROM phase4_computation_state WHERE user_id='a' AND execution_mode='LIVE'")).rows[0].complete,1);
 // Exact old RID replay grants no new publication or alert effects, even when
 // its canonical jobs had genuinely finished before the original interruption.
 const receipts=(await f.db.raw.execute('SELECT * FROM stage8_live_execution_work_receipts ORDER BY receipt_key')).rows;
 const replay=await producer.run({userId:'a',requestId:`outer-publication-abort-${lastLeg}`});assert.equal(replay.replayed,true);assert.equal(replay.publication.status,'ANALYSIS_UPDATING');
 assert.equal(await count(f.db,'stage8_live_publications'),0);assert.deepEqual(await executionRows(f.db),rows);
 assert.deepEqual((await f.db.raw.execute('SELECT * FROM stage8_live_execution_work_receipts ORDER BY receipt_key')).rows,receipts);
 // Model a stale initial absence, as when another real caller finalizes this
 // exact RID after the preflight SELECT. The runner still observes and verifies
 // the actual finalized execution. This early hint cannot authorize effects.
 const execute=f.db.raw.execute;let staleHint=false;
 f.db.raw.execute=async statement=>{if(!staleHint&&statement?.sql==='SELECT 1 FROM stage8_live_executions WHERE execution_id=?'){staleHint=true;const value=await execute(statement);assert.equal(value.rows.length,1);return {...value,rows:[]};}return execute(statement);};
 try{const raced=await producer.run({userId:'a',requestId:`outer-publication-abort-${lastLeg}`});assert.equal(staleHint,true);assert.equal(raced.replayed,true);assert.equal(raced.publication.status,'ANALYSIS_UPDATING');}
 finally{f.db.raw.execute=execute;}
 assert.equal(await count(f.db,'stage8_live_publications'),0);assert.deepEqual(await executionRows(f.db),rows);
 const fresh=await producer.run({userId:'a',requestId:'new-authorized-publication-after-interruption'});assert.equal(fresh.replayed,false);assert.equal(fresh.publication.status,'CURRENT');assert.equal(await count(f.db,'stage8_live_publications'),1);
});
