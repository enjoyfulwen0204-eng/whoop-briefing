import test from 'node:test';
import assert from 'node:assert/strict';
import { syntheticPhase4Fixture } from './phase4Fixture.js';
import { createPhase4Stage6,authorizeStage6ShadowWorker } from '../src/phase4Reanalysis.js';
import { createPhase4Foundation } from '../src/phase4Foundation.js';
import { createReanalysisQueue,STAGE6_RETRY_MS } from '../src/phase4ReanalysisQueue.js';
import { snapshot } from './stage5M007Fixture.js';
import { setup,request } from './stage5HistoryFixture.js';
import { call } from './stage5ClosureFixture.js';
import { setup as associationSetup,hypothesis,family } from './stage5AssociationFixture.js';

const T=Date.parse('2026-09-25T12:00:00.000Z');
const capability=()=>authorizeStage6ShadowWorker({executionMode:'SHADOW'});
const worker=(f,now)=>createPhase4Stage6({db:f.db,keys:f.keys,executionMode:'SHADOW',workerCapability:capability(),now});
const enqueue=(f,id='a')=>f.stores.captureControl(id).then(control=>f.stores.queue.sourceChanged(control));

test('Stage 6 worker requires explicit branded SHADOW admission; Foundation runtime stays OFF',async t=>{
  const f=await syntheticPhase4Fixture(t,{targetVersion:28});
  for(const [executionMode,workerCapability,code] of [['LIVE',capability(),/SHADOW_REQUIRED/],['SHADOW',{},/CAPABILITY_REQUIRED/]])
    await assert.rejects(createPhase4Stage6({db:f.db,keys:f.keys,executionMode,workerCapability}),code);
  await assert.rejects(createPhase4Foundation({db:f.db,keys:f.keys,configuration:{PHASE4_REANALYSIS_WORKER:true}}),/RUNTIME_NOT_AUTHORIZED/);
});

test('Stage 6 worker makes fair bounded progress, resumes a durable cursor after composition restart, and only completes at end',async t=>{
  let now=new Date(T);const f=await syntheticPhase4Fixture(t,{targetVersion:28,now:()=>now});
  await enqueue(f,'a');await enqueue(f,'b');
  let w=await worker(f,()=>now);
  const first=await w.drain({budget:{maxItems:2,maxItemsPerTenant:1}});
  assert.equal(first.processedItems,2);assert.equal(first.completedJobs,0);assert.equal(first.failedJobs,0);
  const partial=(await f.db.raw.execute("SELECT * FROM phase4_jobs WHERE full_scan_cursor IS NOT NULL ORDER BY user_id")).rows;
  assert.deepEqual(partial.map(row=>row.user_id),['a','b']);
  for(const row of partial) {
    assert.deepEqual(JSON.parse(row.full_scan_cursor),['USER',row.user_id]);
    assert.equal(row.completed_generation,0);assert.equal(row.unresolved_since,new Date(T).toISOString());
  }
  const receipts=(await f.db.raw.execute('SELECT count(*) n FROM phase4_operation_receipts')).rows[0].n;
  now=new Date(T+10000);w=await worker(f,()=>now);
  for(let i=0;i<4;i++)await w.drain();
  const diagnostics=await w.diagnostics();assert.equal(diagnostics.pendingJobs,0);assert.equal(diagnostics.ageAuthority,'IDLE');
  assert.ok(diagnostics.latestSuccessfulCompletion);assert.equal(diagnostics.generationLag,0);
  assert.equal((await f.db.raw.execute('SELECT count(*) n FROM phase4_operation_receipts')).rows[0].n,receipts);
  const jobs=(await f.db.raw.execute('SELECT * FROM phase4_jobs')).rows;
  assert.equal(jobs.length,4);for(const job of jobs){assert.equal(job.scope_kind,'NONE');assert.equal(job.unresolved_since,null);}
});

test('Stage 6 retry schedule preserves cycle age and poison history through generation coalescing',async t=>{
  let now=new Date(T);const f=await syntheticPhase4Fixture(t,{targetVersion:28,now:()=>now}),q=createReanalysisQueue(f.core);await enqueue(f);
  for(let failure=1;failure<=5;failure++) {
    await f.stores.withContext('a',{executionMode:'SHADOW'},async context=>{
      const lease=await q.claim(context,'RECOMPUTE_DERIVED');assert.ok(lease);
      const result=await q.release(context,lease,{errorCode:'CALCULATION_FAILED'});
      assert.equal(result.attempt,failure);assert.equal(Date.parse(result.nextAttemptAt)-now.getTime(),STAGE6_RETRY_MS[failure-1]);
      assert.equal(result.state,failure===5?'REPAIR_REQUIRED':'RETRY_WAIT');
      assert.equal(await q.claim(context,'RECOMPUTE_DERIVED'),null);
      const row=(await f.db.raw.execute("SELECT * FROM phase4_jobs WHERE user_id='a' AND job_kind='RECOMPUTE_DERIVED'")).rows[0];
      assert.equal(row.unresolved_since,new Date(T).toISOString());
      if(failure<5)now=new Date(result.nextAttemptAt);
    });
  }
  const before=(await f.db.raw.execute("SELECT * FROM phase4_jobs WHERE user_id='a' AND job_kind='RECOMPUTE_DERIVED'")).rows[0];
  await enqueue(f);
  const after=(await f.db.raw.execute("SELECT * FROM phase4_jobs WHERE user_id='a' AND job_kind='RECOMPUTE_DERIVED'")).rows[0];
  for(const key of ['attempt','last_error_code','next_attempt_at','unresolved_since'])assert.equal(after[key],before[key]);
  assert.equal(after.requested_generation,before.requested_generation+1);assert.equal(after.state,'REPAIR_REQUIRED');
  now=new Date(after.next_attempt_at);const w=await worker(f,()=>now);
  for(let i=0;i<4;i++)await w.drain();
  const done=(await f.db.raw.execute("SELECT * FROM phase4_jobs WHERE user_id='a' AND job_kind='RECOMPUTE_DERIVED'")).rows[0];
  assert.equal(done.state,'COMPLETED');assert.equal(done.attempt,0);assert.equal(done.last_error_code,null);assert.equal(done.unresolved_since,null);
  now=new Date(now.getTime()+1000);await enqueue(f);
  assert.equal((await w.diagnostics()).oldestKnownUnresolvedSince,now.toISOString());
});

test('Stage 6 ownership expires during derived writes: the complete transaction rolls back and a new owner resumes',async t=>{
  let now=new Date(T);const f=await syntheticPhase4Fixture(t,{targetVersion:28,now:()=>now}),q=createReanalysisQueue(f.core);await enqueue(f);
  await f.stores.withContext('a',{executionMode:'SHADOW'},async context=>{
    const lease=await q.claim(context,'RECOMPUTE_DERIVED',{leaseMs:1000}),before=await snapshot(f);
    const execute=f.db.raw.execute.bind(f.db.raw);let expired=false;
    f.db.raw.execute=async statement=>{
      const result=await execute(statement),sql=typeof statement==='string'?statement:statement.sql;
      if(!expired&&sql.startsWith('INSERT INTO phase4_operation_receipts')){expired=true;now=new Date(T+1001);}
      return result;
    };
    await assert.rejects(q.owned(context,lease,()=>f.stores.bodyEnergy.compute(context,{asOfEpochMs:T})),/LEASE_CAS_LOST/);
    f.db.raw.execute=execute;assert.equal(expired,true);assert.deepEqual(await snapshot(f),before);
    const replacement=await q.claim(context,'RECOMPUTE_DERIVED');assert.ok(replacement);
    await assert.rejects(q.owned(context,lease,()=>f.stores.bodyEnergy.compute(context,{asOfEpochMs:T})),/LEASE_CAS_LOST/);
    await assert.rejects(q.complete(context,lease,{}),/FULL_PASS_NOT_AUTHORIZED/);
    await q.owned(context,replacement,()=>f.stores.bodyEnergy.compute(context,{asOfEpochMs:T}));
    await q.release(context,replacement);
  });
});

test('Stage 6 drains retained WHOOP inputs and refreshes an existing canonical episode through public authority',async t=>{
  const f=await setup(t,{targetVersion:28});
  const initial=await call(f,'intelligence','analyzeMetric',{...request(f.initialRefs[0],f.initialRefs.slice(1),new Date(T).toISOString()),windowFamily:'EXISTING_CANONICAL_CUSTOM_FAMILY'});
  await enqueue(f);const w=await worker(f,()=>new Date(T));
  for(let i=0;i<12&&(await w.diagnostics()).pendingJobs;i++) {
    const result=await w.drain({budget:{maxItemsPerTenant:32,maxItems:64}});
    assert.equal(result.failedJobs,0,JSON.stringify(result));
  }
  assert.equal((await w.diagnostics()).pendingJobs,0);
  const current=await f.stores.withContext('a',{executionMode:'SHADOW'},context=>f.stores.episodes.read(context,initial.episode.episode.row.episode_id));
  assert.equal(current.row.input_generation,1);assert.equal(current.row.revision,2);
});

test('Stage 6 full drain refreshes a stale insight from retained Journal and WHOOP facts',async t=>{
  const f=await associationSetup(t,{days:30,targetVersion:28});
  const initial=await call(f,'intelligence','analyzeAssociationFamily',family('worker-initial',hypothesis(f,Array.from({length:30},(_,i)=>i))));
  const old=initial.items[0].insight.current.row;await enqueue(f);
  const w=await worker(f,()=>new Date(T));
  for(let i=0;i<16&&(await w.diagnostics()).pendingJobs;i++) {
    const result=await w.drain({budget:{maxItemsPerTenant:32,maxItems:64,maxWallMs:90000,leaseMs:120000}});
    assert.equal(result.failedJobs,0,JSON.stringify(result));
  }
  assert.equal((await w.diagnostics()).pendingJobs,0);
  const current=await f.stores.withContext('a',{executionMode:'SHADOW'},c=>f.stores.insights.read(c,old.id,{asOfUtc:new Date(T).toISOString()}));
  assert.equal(current.row.input_generation,16);assert.equal(current.row.current_revision,old.current_revision+1);
});

test('Stage 6 newer generation discards partial cursor while preserving the active cycle',async t=>{
  let now=new Date(T);const f=await syntheticPhase4Fixture(t,{targetVersion:28,now:()=>now});await enqueue(f);
  const w=await worker(f,()=>now);await w.drain({budget:{maxItemsPerTenant:1,maxItems:1}});
  const prior=(await f.db.raw.execute("SELECT * FROM phase4_jobs WHERE full_scan_cursor IS NOT NULL")).rows[0];assert.ok(prior);
  now=new Date(T+1000);await enqueue(f);
  const next=(await f.db.raw.execute({sql:'SELECT * FROM phase4_jobs WHERE user_id=? AND job_kind=?',args:[prior.user_id,prior.job_kind]})).rows[0];
  assert.equal(next.full_scan_cursor,null);assert.equal(next.unresolved_since,prior.unresolved_since);
  assert.equal(next.scope_revision,prior.scope_revision+1);assert.equal(next.completed_generation,0);
  for(let i=0;i<4;i++)await w.drain();assert.equal((await w.diagnostics()).generationLag,0);
});

test('Stage 6 failing tenant remains incomplete while another tenant progresses; retry reuses committed work',async t=>{
  let now=new Date(T);const f=await syntheticPhase4Fixture(t,{targetVersion:28,now:()=>now});await enqueue(f,'a');await enqueue(f,'b');
  const execute=f.db.raw.execute.bind(f.db.raw);f.db.raw.execute=async statement=>{
    if(typeof statement!=='string'&&statement.sql.startsWith('INSERT INTO phase4_operation_receipts')&&statement.args.includes('a'))throw Error('SYNTHETIC_CALCULATION_FAILURE');
    return execute(statement);
  };
  const w=await worker(f,()=>now),first=await w.drain();
  assert.equal(first.failedJobs,1);assert.equal(first.completedJobs,1);assert.equal(first.outcome,'PARTIAL');
  const bad=(await f.db.raw.execute("SELECT * FROM phase4_jobs WHERE user_id='a' AND attempt=1")).rows[0];
  assert.equal(bad.completed_generation,0);assert.equal(bad.full_scan_cursor,null);assert.equal(bad.last_error_code,'CALCULATION_FAILED');
  f.db.raw.execute=execute;now=new Date(T+60000);for(let i=0;i<4;i++)await w.drain();
  assert.equal((await w.diagnostics()).pendingJobs,0);
  assert.equal((await f.db.raw.execute("SELECT count(*) n FROM phase4_operation_receipts WHERE operation_kind='BODY_ENERGY_COMPUTE'")).rows[0].n,2);
});

for(const fence of ['scope','auth','lifecycle','purge','algorithm'])test(`Stage 6 ${fence} change during owned writes rolls back derived work and checkpoint`,async t=>{
  const f=await syntheticPhase4Fixture(t,{targetVersion:28,now:()=>new Date(T)});await enqueue(f);const q=createReanalysisQueue(f.core);
  await f.stores.withContext('a',{executionMode:'SHADOW'},async context=>{
    const lease=await q.claim(context,'RECOMPUTE_DERIVED'),before=await snapshot(f),execute=f.db.raw.execute.bind(f.db.raw);let injected=false;
    f.db.raw.execute=async statement=>{
      const result=await execute(statement),sql=typeof statement==='string'?statement:statement.sql;
      if(!injected&&sql.startsWith('INSERT INTO phase4_operation_receipts')) {
        injected=true;await execute({scope:"UPDATE phase4_jobs SET scope_revision=scope_revision+1 WHERE user_id='a'",
          auth:"INSERT INTO user_whoop_tokens(user_id,access_token,refresh_token,access_token_expires_at,updated_at) VALUES ('a','SYNTHETIC','SYNTHETIC','2026-10-01','2026-09-25')",
          lifecycle:"UPDATE users SET lifecycle_generation=lifecycle_generation+1 WHERE id='a'",
          purge:"UPDATE phase4_user_state SET purge_generation=purge_generation+1 WHERE user_id='a'",
          algorithm:"UPDATE phase4_computation_state SET algorithm_set_version='SYNTHETIC_CHANGED' WHERE user_id='a'"}[fence]);
      }
      return result;
    };
    await assert.rejects(q.owned(context,lease,async()=>{
      await f.stores.bodyEnergy.compute(context,{asOfEpochMs:T});await q.checkpoint(context,lease,'["USER","a"]');
    }),/FENCED|LEASE_CAS_LOST/);
    f.db.raw.execute=execute;assert.ok(injected);assert.deepEqual(await snapshot(f),before);
  });
});

test('Stage 6 final completion settlement checks lease after writes and rolls back on expiry',async t=>{
  let now=new Date(T);const f=await syntheticPhase4Fixture(t,{targetVersion:28,now:()=>now});await enqueue(f);
  const w=await worker(f,()=>now);await w.drain({budget:{maxItemsPerTenant:1,maxItems:1}});
  const q=createReanalysisQueue(f.core);
  await f.stores.withContext('a',{executionMode:'SHADOW'},async context=>{
    const row=(await f.db.raw.execute("SELECT job_kind FROM phase4_jobs WHERE full_scan_cursor IS NOT NULL")).rows[0];
    const lease=await q.claim(context,row.job_kind,{leaseMs:1000});
    // The trusted internal enumerator must genuinely see the end; here the
    // synthetic tenant has only the already checkpointed USER identity.
    const proof=await q.end(context,lease,async()=>[]),before=await snapshot(f),execute=f.db.raw.execute.bind(f.db.raw);
    f.db.raw.execute=async statement=>{
      const result=await execute(statement),sql=typeof statement==='string'?statement:statement.sql;
      if(sql.startsWith('UPDATE phase4_jobs SET completed_generation'))now=new Date(T+1001);return result;
    };
    await assert.rejects(q.complete(context,lease,proof),/LEASE_CAS_LOST/);f.db.raw.execute=execute;
    assert.deepEqual(await snapshot(f),before);
  });
});

test('Stage 6 refreshes SUPPORTED insight with two independently recalculated current-generation windows',async t=>{
  const f=await associationSetup(t,{days:60,targetVersion:28});
  await call(f,'intelligence','analyzeAssociationFamily',family('worker-prior-old',hypothesis(f,Array.from({length:30},(_,i)=>i+30))));
  const initial=await call(f,'intelligence','analyzeAssociationFamily',family('worker-prior-current',hypothesis(f,Array.from({length:30},(_,i)=>i))));
  const old=initial.items[0].insight.current.row;assert.equal(old.status,'SUPPORTED');await enqueue(f);
  const w=await worker(f,()=>new Date(T));
  for(let i=0;i<24&&(await w.diagnostics()).pendingJobs;i++) {
    const result=await w.drain({budget:{maxItemsPerTenant:32,maxItems:64,maxWallMs:90000,leaseMs:120000}});
    assert.equal(result.failedJobs,0,JSON.stringify(result));
  }
  assert.equal((await w.diagnostics()).pendingJobs,0);
  const current=await f.stores.withContext('a',{executionMode:'SHADOW'},c=>f.stores.insights.read(c,old.id,{asOfUtc:new Date(T).toISOString()}));
  assert.equal(current.row.status,'SUPPORTED');assert.equal(current.row.input_generation,31);
  assert.equal(current.row.current_revision,old.current_revision+1);
});

test('Stage 6 fresh contrary evidence weakens a stale insight once and creates the opposite canonical identity',async t=>{
  const f=await associationSetup(t,{days:30,targetVersion:28});
  const initial=await call(f,'intelligence','analyzeAssociationFamily',family('contrary-prior',hypothesis(f,Array.from({length:30},(_,i)=>i))));
  const old=initial.items[0].insight.current.row,next=new Date(T+1000).toISOString();f.setNow(next);
  await f.db.raw.execute({sql:"UPDATE whoop_recoveries SET recovery_score=90-recovery_score,updated_at=? WHERE user_id='a'",args:[next]});
  await enqueue(f);const w=await worker(f,()=>new Date(T+1000));
  for(let i=0;i<20&&(await w.diagnostics()).pendingJobs;i++) {
    const result=await w.drain({budget:{maxItemsPerTenant:32,maxItems:64,maxWallMs:90000,leaseMs:120000}});
    assert.equal(result.failedJobs,0,JSON.stringify(result));
  }
  assert.equal((await w.diagnostics()).pendingJobs,0);
  const prior=await f.stores.withContext('a',{executionMode:'SHADOW'},c=>f.stores.insights.read(c,old.id,{asOfUtc:next}));
  assert.equal(prior.row.status,'WEAKENED');assert.equal(prior.row.current_revision,old.current_revision+1);
  const insights=(await f.db.raw.execute("SELECT status,input_generation FROM health_insights WHERE user_id='a' ORDER BY id")).rows;
  assert.deepEqual(insights.map(row=>row.status),['WEAKENED','EMERGING']);assert.ok(insights.every(row=>row.input_generation===16));
});
