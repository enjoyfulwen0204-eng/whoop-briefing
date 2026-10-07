import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createDb,fixtureKeys} from './localDb.js';
import {createPhase4Keys} from '../src/phase4Keys.js';
import {admitRuntime,requireRuntimeAdmission,canonicalRuntimeContract} from '../src/runtimeAdmission.js';

async function fixture(t) { const db=createDb({url:':memory:'});t.after(()=>db.close());await db.migrate();return db; }
test('complete canonical v32 admission is five read-only bounded queries and same live connection reuse',async t=>{
 const db=await fixture(t),queries=[],execute=db.raw.execute;
 db.raw.execute=async s=>{queries.push(typeof s==='string'?s:s.sql);return execute(s);};
 const started=performance.now(),cap=await db.admitRuntime();
 assert.equal(db.requireRuntimeAdmission(cap),32);assert.equal(await db.admitRuntime(),cap);
 assert.equal(queries.length,5);assert.ok(queries.every(q=>/^SELECT|^PRAGMA (foreign_keys|ignore_check_constraints)/.test(q)));
 assert.ok(canonicalRuntimeContract().objects.has('p4_outbox_transition'));assert.ok(canonicalRuntimeContract().objects.has('uniq_report_sent'));
 console.log(JSON.stringify({measurement:'admission_local',queries:queries.length,elapsedMs:performance.now()-started}));
 for(const bad of [{},{...cap},JSON.parse(JSON.stringify(cap))])assert.throws(()=>db.requireRuntimeAdmission(bad),/ADMISSION_REQUIRED/);
 const other=await fixture(t);assert.throws(()=>other.requireRuntimeAdmission(cap),/ADMISSION_REQUIRED/);
 db.raw.close();assert.throws(()=>db.requireRuntimeAdmission(cap),/ADMISSION_REQUIRED/);
});
const controls=[
 ['missing trigger',"DROP TRIGGER p4_outbox_transition"],
 ['wrong trigger',"DROP TRIGGER p4_outbox_transition","CREATE TRIGGER p4_outbox_transition BEFORE UPDATE ON outbound_messages BEGIN SELECT 1; END"],
 ['missing unique index',"DROP INDEX uniq_report_sent"],
 ['same-name nonunique index',"DROP INDEX uniq_report_sent","CREATE INDEX uniq_report_sent ON report_runs(user_id,report_type,local_date) WHERE status='SENT'"],
 ['wrong index columns',"DROP INDEX uniq_report_sent","CREATE UNIQUE INDEX uniq_report_sent ON report_runs(user_id,report_type) WHERE status='SENT'"],
 ['wrong index predicate',"DROP INDEX uniq_report_sent","CREATE UNIQUE INDEX uniq_report_sent ON report_runs(user_id,report_type,local_date) WHERE status='FAILED'"],
 ['SQL-literal predicate substitution',"DROP INDEX uniq_report_sent","CREATE UNIQUE INDEX uniq_report_sent ON report_runs (user_id, report_type, local_date) WHERE status = 'IF NOT EXISTS SENT'"],
 ['altered column',"DROP TABLE user_locale_prompts","CREATE TABLE user_locale_prompts(user_id TEXT PRIMARY KEY,prompted_at INTEGER NOT NULL,FOREIGN KEY(user_id) REFERENCES users(id))"],
 ['altered constraint',"DROP TABLE user_locales","CREATE TABLE user_locales(user_id TEXT NOT NULL PRIMARY KEY,locale TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,FOREIGN KEY(user_id) REFERENCES users(id))"],
 ['missing FK',"DROP TABLE user_locale_prompts","CREATE TABLE user_locale_prompts(user_id TEXT NOT NULL PRIMARY KEY,prompted_at TEXT NOT NULL)"],
 ['incomplete checkpoint',"UPDATE phase4_migration_checkpoints SET postcondition_state='PENDING' WHERE step_key='privacy_backfill'"],
 ['missing checkpoint',"DELETE FROM phase4_migration_checkpoints WHERE step_key='audit_key_check'"],
 ['corrupt checkpoint',"UPDATE phase4_migration_checkpoints SET last_cursor='corrupt' WHERE step_key='lookup_key_check'"],
 ['old schema',"DELETE FROM schema_version WHERE version=32"],
 ['future schema',"INSERT INTO schema_version VALUES(33,'2026-10-07','synthetic')"],
];
for(const [name,...sql] of controls)test(`admission rejects ${name}`,async t=>{const db=await fixture(t);for(const s of sql)await db.raw.execute(s);await assert.rejects(()=>admitRuntime(db.raw,fixtureKeys));});
test('admission rejects missing/wrong independent keys, and 150ms injected latency remains bounded',async t=>{
 const db=await fixture(t);
 await assert.rejects(()=>admitRuntime(db.raw,undefined),/KEYS_REQUIRED/);
 for(const kind of ['lookup','audit']) {
 const keys=createPhase4Keys({lookupKey:Buffer.alloc(32,kind==='lookup'?72:71),auditKey:Buffer.alloc(32,kind==='audit'?84:83)});
 await assert.rejects(()=>admitRuntime(db.raw,keys),new RegExp(`${kind.toUpperCase()}_KEY_MISMATCH`)); }
 const execute=db.raw.execute;let calls=0;db.raw.execute=async s=>{calls++;await new Promise(r=>setTimeout(r,150));return execute(s);};
 const started=performance.now();await admitRuntime(db.raw,fixtureKeys);
 const elapsedMs=performance.now()-started;assert.equal(calls,5);assert.ok(elapsedMs<10000);
 console.log(JSON.stringify({measurement:'admission_injected_150ms',queries:calls,elapsedMs}));
});

test('connection close/reconnect paths and a replaced connection invalidate capabilities; fresh reopen admission succeeds',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'p4-admission-life-')),db=createDb({url:`file:${join(dir,'isolated.db')}`});
 t.after(async()=>{db.close();await rm(dir,{recursive:true,force:true});});await db.migrate();
 await db.createUser({id:'synthetic',displayName:'Synthetic',timezone:'Asia/Taipei',status:'ACTIVE'});
 const cap=await db.admitRuntime();assert.deepEqual(await db.listExperiments('synthetic'),[]);
 assert.throws(()=>db.raw.reconnect(),/RUNTIME_REPLACEMENT_REQUIRED/);assert.throws(()=>db.requireRuntimeAdmission(cap),/ADMISSION_REQUIRED/);
 await assert.rejects(()=>db.admitRuntime(),/CONNECTION_REQUIRED/);
 const nextDb=createDb({url:`file:${join(dir,'isolated.db')}`});t.after(()=>nextDb.close());
 const next=await nextDb.admitRuntime();assert.notEqual(next,cap);assert.equal(nextDb.requireRuntimeAdmission(next),32);
 assert.deepEqual(await nextDb.listExperiments('synthetic'),[],'replacement runtime re-admits and builds new stores');
 db.close();assert.throws(()=>db.requireRuntimeAdmission(next),/ADMISSION_REQUIRED/);
});
test('concurrent nested factory admission shares one read-only contract, and swapped transaction connection fails',async t=>{
 const db=await fixture(t),queries=[],execute=db.raw.execute;
 db.raw.execute=async s=>{queries.push(typeof s==='string'?s:s.sql);return execute(s);};
 const [a,b]=await Promise.all([db.admitRuntime(),db.admitRuntime()]);assert.equal(a,b);assert.equal(queries.length,5);
 const {createPublicBetaRuntime,authorizePublicBetaRuntime,publicBetaPolicy}=await import('../src/publicBeta.js');
 await createPublicBetaRuntime({db,keys:fixtureKeys,admission:a,executionMode:'SHADOW',runtimeCapability:authorizePublicBetaRuntime({executionMode:'SHADOW'}),presentationPolicy:publicBetaPolicy()});
 assert.equal(queries.filter(sql=>sql.includes('FROM sqlite_master')).length,1);
 assert.ok(queries.every(sql=>/^SELECT|^PRAGMA database_list|^PRAGMA (foreign_keys|ignore_check_constraints)/.test(sql)),'factories must replay no historical DDL/DML');
 const {createPhase4Foundation}=await import('../src/phase4Foundation.js'),other=await fixture(t);
 await assert.rejects(()=>createPhase4Foundation({db:{...db,transaction:other.transaction},keys:fixtureKeys,admission:a}),/ADMISSION_REQUIRED/);
});
for(const [name,sql] of [
 ['missing required column',"ALTER TABLE user_locales DROP COLUMN updated_at"],
 ['corrupt migration authority',"UPDATE schema_version SET note='unverified' WHERE version=30"],
 ['missing migration authority',"DELETE FROM schema_version WHERE version=24"],
 ['disabled FK enforcement','PRAGMA foreign_keys=OFF'],
 ['disabled CHECK enforcement','PRAGMA ignore_check_constraints=ON'],
])test(`complete contract rejects ${name}`,async t=>{const db=await fixture(t);await db.raw.execute(sql);await assert.rejects(()=>admitRuntime(db.raw,fixtureKeys));});
