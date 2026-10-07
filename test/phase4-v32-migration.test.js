import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createOwnedDb} from './stage5OwnedDb.js';import {fixtureKeys} from './localDb.js';
import {createPhase4Keys} from '../src/phase4Keys.js';import {admitRuntime} from '../src/runtimeAdmission.js';
import {controlledMigration,main} from '../scripts/phase4-migrate.js';
async function fixture(t){const dir=await mkdtemp(join(tmpdir(),'p4-v32-migrate-')),db=createOwnedDb({url:`file:${join(dir,'db.sqlite')}`});
 t.after(async()=>{await db.close();await rm(dir,{recursive:true,force:true});});await db.migrate({targetVersion:31});return db;}
test('operator CLI explicitly upgrades v31 to v32 and rejects an invalid allocation before accessing a database',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'p4-v32-cli-')),url=`file:${join(dir,'db.sqlite')}`;
 t.after(()=>rm(dir,{recursive:true,force:true}));const db=createOwnedDb({url});await db.migrate({targetVersion:31});await db.close();
 const env={TURSO_DATABASE_URL:url,PHASE4_LOOKUP_KEY:Buffer.alloc(32,71).toString('hex'),PHASE4_AUDIT_KEY:Buffer.alloc(32,83).toString('hex')};
 const args=['--apply','--expected-target',url,'--target-version','32'];
 const result=await main(args,env);assert.equal(result.from,31);assert.equal(result.target,32);assert.deepEqual(result.versionsApplied,[32]);
 assert.deepEqual((await main(args,env)).versionsApplied,[]);
 await assert.rejects(()=>main(['--apply','--expected-target',url,'--target-version','33'],{}),/MIGRATION_VERSION_OUT_OF_RANGE/);
});
test('v32 narrow controlled migration preserves health/keys, verifies authority, no legacy DDL/backfill, repeated no-op',async t=>{
 const db=await fixture(t);await db.createUser({id:'synthetic',displayName:'Synthetic',timezone:'Asia/Taipei',status:'ACTIVE'});
 await db.raw.execute("INSERT INTO whoop_cycles(user_id,id,synced_at) VALUES('synthetic','isolated','2026-10-08')");
 const snapshot=async()=>JSON.stringify((await db.raw.execute('SELECT * FROM whoop_cycles')).rows),before=await snapshot();
 const authority=JSON.stringify((await db.raw.execute('SELECT * FROM phase4_migration_checkpoints WHERE target_version<32 ORDER BY target_version,step_key')).rows);
 const execute=db.raw.execute,sql=[];db.raw.execute=async q=>{sql.push(typeof q==='string'?q:q.sql);return execute(q);};
 const result=await controlledMigration(db.raw,{apply:true,keys:fixtureKeys,targetVersion:32});assert.deepEqual(result.versionsApplied,[32]);
 assert.equal(await snapshot(),before);assert.equal(JSON.stringify((await db.raw.execute('SELECT * FROM phase4_migration_checkpoints WHERE target_version<32 ORDER BY target_version,step_key')).rows),authority);
 assert.ok(sql.filter(q=>/^CREATE/i.test(q)).every(q=>/phase4_execution|p4_execution|idx_p4_execution/.test(q)));
 assert.ok(!sql.some(q=>/^\s*(UPDATE|DELETE).*\b(whoop_|users|health_|phase4_source)/i.test(q)));
 sql.length=0;const noOp=await controlledMigration(db.raw,{apply:true,keys:fixtureKeys,targetVersion:32});assert.deepEqual(noOp.versionsApplied,[]);
 assert.ok(!sql.some(q=>/^CREATE|^ALTER|^DROP/i.test(q)));await admitRuntime(db.raw,fixtureKeys);
 assert.equal((await db.raw.execute('PRAGMA integrity_check')).rows[0].integrity_check,'ok');assert.equal((await db.raw.execute('PRAGMA foreign_key_check')).rows.length,0);
 assert.equal((await db.raw.execute("SELECT count(*) n FROM sqlite_master WHERE name LIKE '%stage7%' OR name LIKE '%stage8%'")).rows[0].n,0);
});
for(const stop of ['ddl','version'])test(`v32 interrupted ${stop} resumes without inventing historical execution success`,async t=>{
 const db=await fixture(t),execute=db.raw.execute;let hit=false;
 db.raw.execute=async q=>{const sql=typeof q==='string'?q:q.sql;
  if(!hit&&(stop==='ddl'?sql.includes('CREATE TABLE IF NOT EXISTS phase4_execution_work_receipts'):q?.args?.[0]===32&&sql.includes('INSERT INTO schema_version'))){hit=true;throw Error('ISOLATED_INTERRUPTION');}
  return execute(q);};await assert.rejects(()=>db.migrate({targetVersion:32}),/ISOLATED_INTERRUPTION/);assert.equal(hit,true);
 db.raw.execute=execute;await assert.rejects(()=>admitRuntime(db.raw,fixtureKeys));await db.migrate({targetVersion:32});await admitRuntime(db.raw,fixtureKeys);
 assert.equal((await db.raw.execute('SELECT count(*) n FROM phase4_executions')).rows[0].n,0);
});
test('v32 migration rejects wrong/missing original keys before new writes; v31 admission requires controlled upgrade',async t=>{
 const db=await fixture(t);await assert.rejects(()=>admitRuntime(db.raw,fixtureKeys),/CONTROLLED_MIGRATION_REQUIRED|schema_version_mismatch|schema_postcondition_failed/);
 for(const keys of [undefined,createPhase4Keys({lookupKey:Buffer.alloc(32,72),auditKey:Buffer.alloc(32,83)}),createPhase4Keys({lookupKey:Buffer.alloc(32,71),auditKey:Buffer.alloc(32,84)})])
  await assert.rejects(()=>controlledMigration(db.raw,{apply:true,keys,targetVersion:32}));
 assert.equal((await db.raw.execute("SELECT count(*) n FROM sqlite_master WHERE name='phase4_executions'")).rows[0].n,0);
});
for(const change of ["DROP TRIGGER p4_execution_transition","DROP TRIGGER p4_execution_finalize_authority","DROP TRIGGER p4_execution_initial_authority",
 "DROP INDEX idx_p4_execution_unfinalized","ALTER TABLE phase4_executions DROP COLUMN observed_outcome",
 "UPDATE phase4_migration_checkpoints SET postcondition_state='PENDING' WHERE target_version=32",
 "INSERT INTO schema_version VALUES(33,'2026-10-08','unapproved')"])
test(`v32 fast admission rejects settlement corruption/future schema: ${change}`,async t=>{
 const db=await fixture(t);await db.migrate({targetVersion:32});
 if(change.includes('DROP COLUMN')){
  const {buildV32}=await import('../src/phase4V32Schema.js');
  await db.raw.execute('DROP TRIGGER p4_execution_initial_authority');await db.raw.execute(change);
  await db.raw.execute(buildV32().ddl.find(sql=>sql.includes('CREATE TRIGGER IF NOT EXISTS p4_execution_initial_authority')));
  await assert.rejects(()=>admitRuntime(db.raw,fixtureKeys),/schema_postcondition_failed: phase4_executions/);
 }else{await db.raw.execute(change);await assert.rejects(()=>admitRuntime(db.raw,fixtureKeys));}
});
test('v32 admission rejects a weakened receipt CHECK while all canonical receipt triggers remain present',async t=>{
 const db=await fixture(t);await db.migrate({targetVersion:32});const {buildV32}=await import('../src/phase4V32Schema.js'),ddl=buildV32().ddl;
 await db.raw.execute('DROP TABLE phase4_execution_work_receipts');
 const table=ddl.find(sql=>sql.startsWith('CREATE TABLE IF NOT EXISTS phase4_execution_work_receipts'));
 const weakened=table.replace("CHECK(typeof(generation)='integer' AND generation>=0)",'');assert.notEqual(weakened,table);
 await db.raw.execute(weakened);
 for(const trigger of ddl.filter(sql=>sql.startsWith('CREATE TRIGGER IF NOT EXISTS p4_execution_receipt_')))await db.raw.execute(trigger);
 await assert.rejects(()=>admitRuntime(db.raw,fixtureKeys),/schema_postcondition_failed: phase4_execution_work_receipts/);
});
test('v32 allocation implements only settlement; Stage 7/8 remain v33/v34 and Settings remains deferred',async()=>{
 const {SCHEMA_VERSION,PHASE4_MIGRATIONS}=await import('../src/schema.js');assert.equal(SCHEMA_VERSION,32);
 assert.equal(PHASE4_MIGRATIONS.at(-1).version,32);assert.ok(PHASE4_MIGRATIONS.every(m=>m.version<=32));
 const {readFile}=await import('node:fs/promises');const document=await readFile(new URL('../docs/phase4-localization-gate.md',import.meta.url),'utf8');
 assert.match(document,/\| v32 \| Execution Settlement Authority/);assert.match(document,/\| v33 \| Future Stage 7/);assert.match(document,/\| v34 \| Future Stage 8/);
});
