import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createOwnedDb } from './stage5OwnedDb.js';
import { fixtureKeys } from './localDb.js';
import { runMigrations,currentVersion } from './localMigrations.js';
import { createPhase4Foundation } from '../src/phase4Foundation.js';
import { assertPhase4Schema } from '../src/phase4Migrations.js';
import { phase4Backlog } from '../src/phase4Diagnostics.js';
import { syntheticPhase4Fixture } from './phase4Fixture.js';

const T='2026-09-25T00:00:00.000Z';
async function database(t,version=27) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'stage6-v28-')),url=`file:${path.join(dir,'synthetic.db')}`;
  let db=createOwnedDb({url});t.after(async()=>{await db.close();fs.rmSync(dir,{recursive:true,force:true});});
  await db.migrate({targetVersion:version});return {get db(){return db;},async reopen(){await db.close();db=createOwnedDb({url});}};
}
const rows=async(db,table)=>(await db.raw.execute(`SELECT * FROM ${table}`)).rows;

test('v28 fresh and v27 upgrade preserve rows and retain UNKNOWN_LEGACY rather than manufacture age',async t=>{
  const f=await database(t);
  await f.db.createUser({id:'legacy',displayName:'Synthetic',timezone:'UTC',status:'ACTIVE'});
  const stores=await createPhase4Foundation({db:f.db,keys:fixtureKeys,now:()=>new Date(T)});
  await stores.initializeTenant('legacy','SHADOW');await stores.queue.sourceChanged(await stores.captureControl('legacy'));
  const tables=(await f.db.raw.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT IN ('schema_version','phase4_migration_checkpoints') ORDER BY name")).rows;
  const before={};for(const {name} of tables)before[name]=await rows(f.db,name);
  await f.db.migrate({targetVersion:28});await f.reopen();await f.db.migrate({targetVersion:28});
  await assertPhase4Schema(f.db.raw,28);assert.equal(await currentVersion(f.db.raw),28);
  for(const {name} of tables) {
    const after=await rows(f.db,name);
    assert.deepEqual(name==='phase4_jobs'?after.map(({unresolved_since,...row})=>row):after,before[name],name);
  }
  const backlog=await phase4Backlog(f.db,{now:new Date('2026-09-25T08:00:00Z')});
  assert.equal(backlog.ageAuthority,'UNKNOWN_LEGACY');assert.equal(backlog.oldestUnresolvedAgeMs,null);
  assert.equal(backlog.unknownLegacyJobs,2);assert.equal(backlog.severity,'DEGRADED');
  assert.equal((await f.db.raw.execute('PRAGMA integrity_check')).rows[0].integrity_check,'ok');
  const fresh=await database(t,28);await assertPhase4Schema(fresh.db.raw,28);
  assert.equal((await phase4Backlog(fresh.db)).ageAuthority,'IDLE');
});

for(const boundary of ['COLUMN','INDEX','TRIGGER','VERSION_ROW'])test(`v28 interrupted ${boundary} resumes idempotently`,async t=>{
  const f=await database(t),execute=f.db.raw.execute.bind(f.db.raw);let injected=false;
  const interrupted={execute:async statement=>{
    const result=await execute(statement),sql=typeof statement==='string'?statement:statement.sql;
    const matches={COLUMN:sql.startsWith('ALTER TABLE phase4_jobs ADD COLUMN unresolved_since'),
      INDEX:sql.includes('CREATE INDEX IF NOT EXISTS p4_job_unresolved_age'),
      TRIGGER:sql.includes('CREATE TRIGGER IF NOT EXISTS p4_job_cycle_immutable'),
      VERSION_ROW:sql.includes('INSERT INTO schema_version')&&statement.args?.[0]===28};
    if(!injected&&matches[boundary]){injected=true;throw Error('V28_INTERRUPTION');}return result;
  }};
  await assert.rejects(runMigrations(interrupted,{targetVersion:28}),/V28_INTERRUPTION/);assert.equal(injected,true);
  await f.reopen();await f.db.migrate({targetVersion:28});await f.db.migrate({targetVersion:28});await assertPhase4Schema(f.db.raw,28);
});

test('v28 backlog follows the oldest active cycle through coalescing and preserves UNKNOWN alongside known cycles',async t=>{
  let now=new Date(T);const f=await syntheticPhase4Fixture(t,{targetVersion:28,now:()=>now});
  const enqueue=id=>f.stores.captureControl(id).then(c=>f.stores.queue.sourceChanged(c));
  await enqueue('a');now=new Date(Date.parse(T)+4*3600000);await enqueue('b');
  now=new Date(Date.parse(T)+7*3600000);await enqueue('a');
  const backlog=await phase4Backlog(f.db,{now});
  assert.equal(backlog.oldestKnownUnresolvedSince,T);assert.equal(backlog.oldestUnresolvedAgeMs,7*3600000);
  assert.equal(backlog.severity,'ACTIONABLE');assert.equal(backlog.pendingTenants,2);assert.equal(backlog.pendingJobs,4);
  await assert.rejects(f.db.raw.execute("UPDATE phase4_jobs SET unresolved_since=updated_at WHERE user_id='a'"),/unresolved_cycle_invalid/);
  await assert.rejects(f.db.raw.execute("UPDATE phase4_jobs SET unresolved_since='yesterday'"),/unresolved_cycle_invalid|CHECK/);
});
