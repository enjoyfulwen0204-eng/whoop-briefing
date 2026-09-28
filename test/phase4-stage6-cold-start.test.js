import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createOwnedDb } from './stage5OwnedDb.js';
import { fixtureKeys } from './localDb.js';
import { createPhase4Foundation } from '../src/phase4Foundation.js';
import { createPhase4Stage6,authorizeStage6ShadowWorker } from '../src/phase4Reanalysis.js';
import { syntheticPhase4Fixture } from './phase4Fixture.js';
const T=Date.parse('2026-09-25T12:00:00.000Z');

test('Stage 6 real process death leaves a durable checkpoint; a cold process expires ownership and finishes without duplication',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'stage6-crash-')),filename=path.join(dir,'synthetic.db');
  let db=createOwnedDb({url:`file:${filename}`});t.after(async()=>{await db.close();fs.rmSync(dir,{recursive:true,force:true});});
  await db.migrate({targetVersion:28});await db.createUser({id:'a',displayName:'Synthetic',timezone:'UTC',status:'ACTIVE'});
  const stores=await createPhase4Foundation({db,keys:fixtureKeys,now:()=>new Date(T)});await stores.initializeTenant('a','SHADOW');
  await stores.queue.sourceChanged(await stores.captureControl('a'));await db.close();
  const child=spawnSync(process.execPath,['--expose-gc','test/stage6CrashChild.js',filename],{encoding:'utf8',timeout:30000});
  assert.equal(child.error,undefined);assert.equal(child.signal,null);assert.equal(child.status,99,child.stderr);
  db=createOwnedDb({url:`file:${filename}`});
  const interrupted=(await db.raw.execute("SELECT * FROM phase4_jobs WHERE job_kind='RECOMPUTE_DERIVED'")).rows[0];
  assert.equal(interrupted.state,'RUNNING');assert.equal(interrupted.full_scan_cursor,'["USER","a"]');assert.equal(interrupted.completed_generation,0);
  const worker=await createPhase4Stage6({db,keys:fixtureKeys,executionMode:'SHADOW',workerCapability:authorizeStage6ShadowWorker({executionMode:'SHADOW'}),now:()=>new Date(T+61000)});
  for(let i=0;i<3;i++)assert.equal((await worker.drain()).failedJobs,0);
  assert.equal((await worker.diagnostics()).pendingJobs,0);
  assert.equal((await db.raw.execute('SELECT count(*) n FROM phase4_operation_receipts')).rows[0].n,1);
  assert.equal((await db.raw.execute('SELECT count(*) n FROM body_energy_results')).rows[0].n,1);
});

test('Stage 6 stop-before-deadline rolls back current work and yields without poisoning the job',async t=>{
  const f=await syntheticPhase4Fixture(t,{targetVersion:28,now:()=>new Date(T)});
  await f.stores.queue.sourceChanged(await f.stores.captureControl('a'));
  let elapsed=0;const execute=f.db.raw.execute.bind(f.db.raw);
  f.db.raw.execute=async statement=>{
    const result=await execute(statement),sql=typeof statement==='string'?statement:statement.sql;
    if(sql.startsWith('INSERT INTO phase4_operation_receipts'))elapsed=30001;return result;
  };
  const worker=await createPhase4Stage6({db:f.db,keys:f.keys,executionMode:'SHADOW',workerCapability:authorizeStage6ShadowWorker({executionMode:'SHADOW'}),
    now:()=>new Date(T),monotonicNow:()=>elapsed});
  const result=await worker.drain();f.db.raw.execute=execute;
  assert.equal(result.stoppedForBudget,true);assert.equal(result.failedJobs,0);assert.equal(result.processedItems,0);
  for(const row of (await f.db.raw.execute('SELECT * FROM phase4_jobs')).rows) {
    assert.equal(row.attempt,0);assert.equal(row.completed_generation,0);assert.equal(row.full_scan_cursor,null);assert.equal(row.lease_owner,null);
  }
  assert.equal((await f.db.raw.execute('SELECT count(*) n FROM phase4_operation_receipts')).rows[0].n,0);
});
