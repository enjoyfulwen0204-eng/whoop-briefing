import test from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {AsyncLocalStorage} from 'node:async_hooks';

// Test-only observations, following the existing diagnostic-loader seam. The
// actual predicate, callback and original control functions are left intact;
// opaque identities never leave this synthetic process or grant authority.
const coreUrl=new URL('../src/phase4Core.js',import.meta.url).href;
registerHooks({load(url,context,next){
 const result=next(url,context);if(url!==coreUrl)return result;let source=String(result.source);
 const replace=(before,after)=>{assert.equal(source.split(before).length,2,'EXACT_CONTROL_OBSERVATION_REQUIRED');source=source.replace(before,after);};
 replace('const check=cached??controlOnlyProcessingCheck(async()=>{','const check=cached??controlOnlyProcessingCheck(async()=>{globalThis.__stage8TerminalTrace?.guard(context,job?.check);');
 replace('const work=()=>transaction(()=>fn(context),','const observedRun=globalThis.__stage8TerminalTrace?.register({context,jobCheck:job?.check,check,coalescible,budget,execution});\n    const observeWork=fn=>globalThis.__stage8TerminalTrace?globalThis.__stage8TerminalTrace.enter(observedRun,fn):fn();\n    const work=()=>observeWork(()=>transaction(()=>{globalThis.__stage8TerminalTrace?.callback(context,check);return fn(context);},');
 replace('...(job?{commitFence:check}:{})});','...(job?{commitFence:check}:{})}));');
 return {...result,source};
}});
const [{syntheticPhase4Fixture},{buildPhase4Core},{composePhase4Stores},{createPhase4Stage6},{createReanalysisQueue},
 {authorizeStage8LiveProducer},{createStage8LiveExecutionRunner},{seedBodyInput,bodyInput},{runningReleaseSha},
 {createExecutionBudget,withExecutionBudget}]=await Promise.all([
 import('./phase4Fixture.js'),import('../src/phase4Core.js'),import('../src/phase4Repositories.js'),import('../src/phase4Reanalysis.js'),
 import('../src/phase4ReanalysisQueue.js'),import('../src/stage8LiveProducerAuthority.js'),import('../src/stage8LiveExecution.js'),
 import('./bodyEnergyFixture.js'),import('../src/phase4Release.js'),import('../src/executionBudget.js')]);

async function fixture(t){
 const f=await syntheticPhase4Fixture(t,{targetVersion:35,ownedConnection:true,now:()=>new Date()});
 await f.db.transaction(()=>seedBodyInput(f.db,bodyInput({asOf:Date.now()-1000,days:7})));await f.db.ensureOnboarding('a',{state:'READY'});
 const admission=await f.db.admitRuntime(),capability=await authorizeStage8LiveProducer({...f,admission,releaseSha:runningReleaseSha(),configProof:'b'.repeat(64),enabled:()=>true,eligible:id=>id==='a'});
 const core=await buildPhase4Core({keys:f.keys,admission,liveProducingAuthority:capability,
  processing:{client:f.db.raw,transaction:f.db.transaction,active:f.db.processingTransactionActive,assertFences:f.db.assertRuntimeFences,afterCommit:f.db.afterProcessingCommit,afterCompletion:f.db.afterProcessingCompletion},authorizeMode(){}});
 await core.initializeTenant('a','LIVE');const worker=await createPhase4Stage6({...f,admission,executionMode:'LIVE',liveProducingAuthority:capability});await worker.rolloutAlgorithm({userId:'a'});
 const stores=composePhase4Stores(core),queue=createReanalysisQueue(core),observerScope=new AsyncLocalStorage(),observed={registrations:[],guards:[],callbacks:[],afterReceipt:false,bodyActive:false,committed:false};
 globalThis.__stage8TerminalTrace={
  register:row=>{const ticket={...row,beforeCalls:0};observed.registrations.push(ticket);return ticket;},
  enter:(ticket,work)=>observerScope.run(ticket,work),
  guard:(context,jobCheck)=>{const ticket=observerScope.getStore();if(ticket?.context===context&&ticket.jobCheck===jobCheck)ticket.beforeCalls++;observed.guards.push({context,jobCheck,afterReceipt:observed.afterReceipt,committed:observed.committed});},
  callback:(context,check)=>observed.callbacks.push({context,check,ownBeforeCalls:observerScope.getStore()?.beforeCalls??0}),
 };
 t.after(()=>{delete globalThis.__stage8TerminalTrace;});
 const runner=(work,{providerRequired=true}={})=>createStage8LiveExecutionRunner({...f,capability,
  capture:id=>core.capture(id,{executionMode:'LIVE',providerRequired}),assertContext:ctx=>core.assertContext(ctx),work});
 const counts=async()=>{const out={};for(const table of ['body_energy_results','stage8_live_operation_receipts','stage8_live_execution_work_receipts','stage8_live_job_completions','stage8_live_publications'])out[table]=(await f.db.raw.execute(`SELECT count(*) n FROM ${table}`)).rows[0].n;return out;};
 const assertBudget=()=>{};
 async function bodyUnit(userId,_runnerContext,{interpose}={}){
  return stores.withContext(userId,{executionMode:'LIVE',providerRequired:true},async context=>{
  const lease=await queue.claim(context,'RECOMPUTE_DERIVED',{leaseMs:60000});assert.ok(lease);
  observed.bodyLease=lease;
  observed.bodyActive=true;
  try{
   const result=await queue.owned(context,lease,async()=>{
    for(let n=0;n<3;n++)await core.run(context,()=>core.root(context,'USER','a'));
    const body=await stores.bodyEnergy.computeForCurrentDrain(context);
    if(interpose)await interpose(context);
    f.db.afterProcessingCommit(()=>{observed.committed=true;});return body;
   },{assertBudget,workKind:'stage6.body-source',workFacts:['USER','a',JSON.stringify(['USER','a']),lease.asOfUtc]});
   assert.ok(result.created);observed.bodyActive=false;await queue.release(context,lease);return {outcome:'PARTIAL',unitsCommitted:1};
  }finally{observed.bodyActive=false;}
  });
 }
 return {...f,core,stores,queue,runner,counts,observed,bodyUnit,assertBudget};
}

test('actual registered LIVE Body-source interns identities while every nested before and post-receipt COMMIT control stays fresh',async t=>{
 const f=await fixture(t),execute=f.db.raw.execute.bind(f.db.raw);
 f.db.raw.execute=async statement=>{const result=await execute(statement),sql=typeof statement==='string'?statement:statement.sql;if(f.observed.bodyActive&&sql.startsWith('INSERT INTO stage8_live_execution_work_receipts'))f.observed.afterReceipt=true;return result;};
 const run=f.runner(f.bodyUnit),request={userId:'a',requestId:'terminal-body-original-identity'};
 try{assert.equal((await run(request)).result.unitsCommitted,1);}finally{f.db.raw.execute=execute;}
 const eligible=f.observed.registrations.filter(row=>row.coalescible),byContext=new Map();
 for(const row of eligible){const checks=byContext.get(row.context)??new Set();checks.add(row.check);byContext.set(row.context,checks);}
 assert.ok(eligible.length>10);assert.ok([...byContext.values()].every(checks=>checks.size===1),'only callback identity is reused in one matching context/job/execution/budget');
 let verifiedCallbacks=0;for(const row of f.observed.callbacks){const registered=f.observed.registrations.find(item=>item.context===row.context&&item.check===row.check);if(!registered?.coalescible)continue;assert.ok(row.ownBeforeCalls>=1,'each nested business callback receives its own fresh guard invocation, including parallel roots');verifiedCallbacks++;}
 assert.ok(f.observed.guards.some(row=>row.afterReceipt&&!row.committed),'a fresh control runs after actual named work receipt INSERT and before COMMIT');assert.equal(f.observed.committed,true);
 const before=await f.counts();assert.equal(before.body_energy_results,1);assert.equal(before.stage8_live_operation_receipts,1);assert.equal(before.stage8_live_job_completions,0);assert.equal(before.stage8_live_publications,0);
 const lease=f.observed.bodyLease,b=lease.binding,e=(await f.db.raw.execute({sql:'SELECT identity_digest,scope_key FROM stage8_live_executions WHERE execution_id=?',args:[request.requestId]})).rows[0],named=new Map();
 for(const [kind,facts]of [
  ['stage6.claim',['a','LIVE',b.jobKind,b.requestedGeneration]],
  ['stage6.body-source',['a','LIVE',b.jobKind,b.requestedGeneration,b.scopeRevision,['USER','a',JSON.stringify(['USER','a']),lease.asOfUtc]]],
  ['stage6.release',['a',b.jobKind,b.requestedGeneration,b.scopeRevision,null,null]],
 ]){const logical=f.keys.lookup(['phase4-logical-work-v1',kind,facts]);named.set(f.keys.lookup(['execution-work-step-v2',e.identity_digest,e.scope_key,['named',logical]]),kind);}
 const receipts=(await f.db.raw.execute({sql:'SELECT step_key FROM stage8_live_execution_work_receipts WHERE execution_id=?',args:[request.requestId]})).rows.map(row=>named.get(row.step_key));
 assert.deepEqual(receipts.sort(),['stage6.body-source','stage6.claim','stage6.release']);
 assert.equal((await run(request)).replayed,true);assert.deepEqual(await f.counts(),before);
 t.diagnostic(JSON.stringify({synthetic:true,productionEvidence:false,nestedEligibleRegistrations:eligible.length,uniqueChecks:[...byContext.values()].reduce((n,set)=>n+set.size,0),freshBeforeCallbacks:verifiedCallbacks,postReceiptFreshControl:true,actualNamedReceipts:receipts}));
});

test('post-receipt generation and job-owner withdrawal rolls back canonical Body/domain/work, joins the late sibling and retains context-first rejection',async t=>{
 const f=await fixture(t),execute=f.db.raw.execute.bind(f.db.raw);let injected=false,siblingSettled=false;
 f.db.raw.execute=async statement=>{
  const sql=typeof statement==='string'?statement:statement.sql,result=await execute(statement);
  if(f.observed.bodyActive&&!injected&&sql.startsWith('INSERT INTO stage8_live_execution_work_receipts')){
   injected=true;f.observed.afterReceipt=true;
   await execute("UPDATE phase4_computation_state SET input_generation=input_generation+1 WHERE user_id='a' AND execution_mode='LIVE'");
   await execute("UPDATE phase4_jobs SET lease_owner='SYNTHETIC_REVOKED_OWNER' WHERE user_id='a' AND execution_mode='LIVE' AND state='RUNNING'");
  }
  if(injected&&sql.startsWith('SELECT state,lease_owner,lease_expires_at,requested_generation')){await new Promise(resolve=>setTimeout(resolve,20));siblingSettled=true;}
  return result;
 };
 try{await assert.rejects(f.runner(f.bodyUnit)({userId:'a',requestId:'terminal-body-final-withdrawal'}),error=>error.code==='PHASE4_INPUT_FENCED');}
 finally{f.db.raw.execute=execute;}
 assert.equal(injected,true);assert.equal(siblingSettled,true);assert.equal(f.observed.committed,false);
 const final=await f.counts();assert.equal(final.body_energy_results,0);assert.equal(final.stage8_live_operation_receipts,0);assert.equal(final.stage8_live_execution_work_receipts,1,'only the previously committed original claim remains');assert.equal(final.stage8_live_job_completions,0);assert.equal(final.stage8_live_publications,0);
 assert.ok((await f.db.raw.execute("SELECT completed_generation,full_scan_cursor FROM phase4_jobs WHERE execution_mode='LIVE'")).rows.every(row=>row.completed_generation===0&&row.full_scan_cursor===null));
});

test('interposed distinct AFTER mutation preserves A,B,A ordering and a fresh last control rejects its revoked generation',async t=>{
 const f=await fixture(t);let interposed=false,afterCalls=0;
 const interpose=async context=>{
  await f.db.transaction(async()=>{}, {after:async()=>{afterCalls++;await f.db.raw.execute("UPDATE phase4_computation_state SET input_generation=input_generation+1 WHERE user_id='a' AND execution_mode='LIVE'");interposed=true;}});
  await f.core.run(context,async()=>{});
 };
 await assert.rejects(f.runner((id,context)=>f.bodyUnit(id,context,{interpose}))({userId:'a',requestId:'terminal-interposed-after'}),error=>error.code==='PHASE4_INPUT_FENCED');
 assert.equal(interposed,true);assert.equal(afterCalls,1);assert.equal(f.observed.committed,false);
 const final=await f.counts();assert.equal(final.body_energy_results,0);assert.equal(final.stage8_live_operation_receipts,0);assert.equal(final.stage8_live_execution_work_receipts,1);assert.equal(final.stage8_live_publications,0);
});

test('distinct context/budget and permissive or provider-optional observations never reuse an eligible control identity',async t=>{
 const f=await fixture(t),captured=[];
 const work=async(_id,context)=>{
  const lease=await f.queue.claim(context,'RECOMPUTE_DERIVED',{leaseMs:60000});assert.ok(lease);
  await f.queue.withOwnership(context,lease,async()=>{
   for(let n=0;n<2;n++){const budget=createExecutionBudget({budgetMs:1000});try{await withExecutionBudget(budget,async()=>{await f.core.run(context,async()=>{});await f.core.run(context,async()=>{});});}finally{budget.close();}}
   await f.core.run(context,async()=>{}, {allowPurge:true});await f.core.run(context,async()=>{}, {allowPurge:true});
   const other=await f.core.capture('a',{executionMode:'LIVE',providerRequired:true});captured.push(other);await assert.rejects(f.core.run(other,async()=>{}),error=>error.code==='PHASE4_LEASE_SCOPE_MISMATCH');
  },{assertBudget:f.assertBudget});
  await f.queue.release(context,lease);return {outcome:'NO_WORK'};
 };
 // The mismatched context's separate readonly root is rejected and rolled
 // back; the genuine outer execution still releases its original lease.
 await f.runner(work)({userId:'a',requestId:'terminal-distinct-boundaries'});
 const byBudget=new Map();for(const row of f.observed.registrations.filter(row=>row.coalescible)){const set=byBudget.get(row.budget)??new Set();set.add(row.check);byBudget.set(row.budget,set);}
 assert.ok(byBudget.size>=2);const short=[...byBudget.values()].filter(set=>set.size===1);assert.ok(short.length>=2);assert.notEqual([...short[0]][0],[...short[1]][0]);
 const permissive=f.observed.registrations.filter(row=>!row.coalescible&&row.jobCheck&&row.context.providerRequired);assert.ok(permissive.length>=2);assert.notEqual(permissive[0].check,permissive[1].check);
 const optional=f.runner(async(_id,context)=>{
  const lease=await f.queue.claim(context,'REPAIR_CURRENTNESS',{leaseMs:60000});assert.ok(lease);
  await f.queue.owned(context,lease,async()=>{await f.core.run(context,async()=>{});await f.core.run(context,async()=>{});},{assertBudget:f.assertBudget});
  await f.queue.release(context,lease);return {outcome:'NO_WORK'};
 },{providerRequired:false});
 await optional({userId:'a',requestId:'terminal-provider-optional'});
 const excluded=f.observed.registrations.filter(row=>row.jobCheck&&!row.context.providerRequired);assert.ok(excluded.length>=2);assert.ok(excluded.every(row=>!row.coalescible));assert.ok(new Set(excluded.map(row=>row.check)).size>1);
 assert.equal((await f.counts()).stage8_live_publications,0);
});
