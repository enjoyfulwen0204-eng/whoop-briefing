import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createClient } from '@libsql/client';
import { runMigrations,currentVersion } from '../src/migrations.js';
import { assertPhase4Schema } from '../src/phase4Migrations.js';
import { fixtureKeys } from './localDb.js';
import { EXPERIMENT_SENTINELS } from '../src/phase4V22Backfill.js';

const at='2026-09-19T00:00:00.000Z',options={privacyKeys:fixtureKeys};
async function populated20(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'foundation-aggregate-')),url=`file:${path.join(dir,'synthetic.db')}`;
  let db=createClient({url});t.after(()=>{db.close();fs.rmSync(dir,{recursive:true,force:true});});
  await runMigrations(db,{targetVersion:20});
  for(const user of ['a','b']) {
    await db.execute({sql:`INSERT INTO users(id,display_name,status,created_at,updated_at) VALUES (?,'Synthetic','ACTIVE',?,?)`,args:[user,at,at]});
    await db.execute({sql:`INSERT INTO whoop_sleeps(user_id,id,health_date,start_at,end_at,nap,score_state,sleep_performance_percentage,synced_at)
      VALUES (?,?,'2026-09-19','2026-09-18T16:00:00.000Z',?,0,'SCORED',50,?)`,args:[user,`synthetic-${user}`,at,at]});
    await db.execute({sql:`INSERT INTO journal_events(user_id,event_at,health_date,category,numeric_value,source,created_at,updated_at)
      VALUES (?,?,'2026-09-19','caffeine',100,'manual',?,?)`,args:[user,at,at,at]});
    await db.execute({sql:`INSERT INTO experiments(user_id,name,result_json,status,created_at,updated_at)
      VALUES (?,'Unproven synthetic name','{"synthetic":100}','DRAFT',?,?)`,args:[user,at,at]});
    await db.execute({sql:`INSERT INTO analytics_invalidation(user_id,generation,affected_from,affected_to,created_at,updated_at)
      VALUES (?,7,'2026-09-01','2026-09-19',?,?)`,args:[user,at,at]});
  }
  const preserved={};
  for(const table of ['users','whoop_sleeps','journal_events','analytics_invalidation']) {
    const columns=(await db.execute(`PRAGMA table_info(${table})`)).rows.map(c=>c.name);
    preserved[table]={columns,rows:(await db.execute(`SELECT ${columns.join(',')} FROM ${table} ORDER BY user_id`.replace('FROM users ORDER BY user_id','FROM users ORDER BY id'))).rows};
  }
  return {get db(){return db;},preserved,reopen(){db.close();db=createClient({url});return db;}};
}
async function assertPreserved(f) {
  for(const [table,{columns,rows}] of Object.entries(f.preserved))assert.deepEqual(
    (await f.db.execute(`SELECT ${columns.join(',')} FROM ${table} ORDER BY ${table==='users'?'id':'user_id'}`)).rows,rows,table);
}

test('Aggregate migration: populated v20 passes every exact intermediate version and physical restart without changing unrelated legacy columns',async t=>{
  const f=await populated20(t);
  for(const version of [21,22,23,24,25]) {
    await runMigrations(f.db,{...options,targetVersion:version});await assertPhase4Schema(f.db,version);await assertPreserved(f);
    assert.equal(await currentVersion(f.db),version);
    assert.deepEqual((await f.db.execute('SELECT version FROM schema_version ORDER BY version')).rows.map(r=>r.version),Array.from({length:version-19},(_,i)=>i+20));
    f.reopen();await runMigrations(f.db,{...options,targetVersion:version});await assertPhase4Schema(f.db,version);await assertPreserved(f);
    assert.equal((await f.db.execute('PRAGMA integrity_check')).rows[0].integrity_check,'ok');
    assert.equal((await f.db.execute("SELECT count(*) n FROM phase4_computation_state WHERE execution_mode='LIVE'")).rows[0].n,0);
    if(version>=22) {
      const experiments=(await f.db.execute('SELECT * FROM experiments')).rows;
      for(const e of experiments)for(const [field,sentinel] of Object.entries(EXPERIMENT_SENTINELS))assert.equal(e[field],sentinel);
      const leaves=(await f.db.execute('SELECT * FROM experiment_field_groups')).rows;
      assert.equal(leaves.length,20);assert.ok(leaves.every(r=>r.field_revision===1&&r.is_current===1&&r.content_state==='REDACTED'));
    }
  }
  for(const table of ['body_energy_results','evidence_runs','phase4_episode_revisions','phase4_jobs','phase4_proactive_decisions','outbound_messages','outbound_delivery_attempts'])
    assert.equal((await f.db.execute(`SELECT count(*) n FROM ${table}`)).rows[0].n,0,table);
});

test('Aggregate migration: committed partial v24 DDL forward-fixes after reopening, while exact-definition drift fails without rewriting data',async t=>{
  const f=await populated20(t);await runMigrations(f.db,{...options,targetVersion:23});let stopped=false;
  const interrupted={execute:async statement=>{
    const result=await f.db.execute(statement),sql=typeof statement==='string'?statement:statement.sql;
    if(!stopped&&sql.startsWith('CREATE TABLE IF NOT EXISTS outbound_messages')){stopped=true;throw Error('synthetic_after_ddl');}
    return result;
  }};
  await assert.rejects(runMigrations(interrupted,{...options,targetVersion:24}),/synthetic_after_ddl/);
  assert.equal(await currentVersion(f.db),23);f.reopen();await runMigrations(f.db,{...options,targetVersion:24});
  await assertPhase4Schema(f.db,24);await assertPreserved(f);
  const trigger=(await f.db.execute("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name='phase4_computation_state_mode_immutable'")).rows[0];
  await f.db.execute(`DROP TRIGGER ${trigger.name}`);
  await f.db.execute(`CREATE TRIGGER ${trigger.name} BEFORE UPDATE OF execution_mode ON phase4_computation_state BEGIN SELECT 1; END`);
  const before=(await f.db.execute("SELECT type,name,sql FROM sqlite_master ORDER BY type,name")).rows;
  await assert.rejects(runMigrations(f.db,{...options,targetVersion:24}),/postcondition_failed/);
  assert.deepEqual((await f.db.execute("SELECT type,name,sql FROM sqlite_master ORDER BY type,name")).rows,before);
  assert.equal(await currentVersion(f.db),24);await assertPreserved(f);
  await f.db.execute(`DROP TRIGGER ${trigger.name}`);await f.db.execute(trigger.sql);
  await runMigrations(f.db,{...options,targetVersion:24});await assertPhase4Schema(f.db,24);
  assert.equal((await f.db.execute('PRAGMA integrity_check')).rows[0].integrity_check,'ok');
});
