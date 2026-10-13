import test from 'node:test';
import assert from 'node:assert/strict';
import {createDb,fixtureKeys} from './localDb.js';
import {createPhase4Keys} from '../src/phase4Keys.js';
import {applyPhase4Migrations,verifyPhase4Schema} from '../src/phase4Migrations.js';
import {buildV34} from '../src/phase4V34Schema.js';
import {controlledMigration,main} from '../scripts/phase4-migrate.js';
async function fixture(t,version=33){const db=createDb({url:':memory:'});t.after(()=>db.close());await db.migrate({targetVersion:version});await db.createUser({id:'migration-user',displayName:'Synthetic',timezone:'Asia/Taipei',status:'ACTIVE'});return db;}
const sql=q=>typeof q==='string'?q:q.sql;
const legacy=async db=>(await db.raw.execute("SELECT name,sql FROM sqlite_master WHERE name IN ('users','whoop_sleeps','phase4_execution_work_receipts','journal_events') ORDER BY name")).rows;
test('v34 controlled local preflight, narrow upgrade and repeated no-op preserve users, v33 DDL, key authority and LIVE count',async t=>{
 const db=await fixture(t),before=await legacy(db),users=(await db.raw.execute('SELECT * FROM users')).rows;
 const preflight=await controlledMigration(db.raw,{apply:false,keys:fixtureKeys,targetVersion:34});assert.equal(preflight.target,34);
 assert.equal((await db.raw.execute('SELECT max(version) v FROM schema_version')).rows[0].v,33);
 const statements=[],client={protocol:'file',execute:q=>{statements.push(sql(q));return db.raw.execute(q);}};
 const result=await controlledMigration(client,{apply:true,keys:fixtureKeys,targetVersion:34});assert.deepEqual(result.versionsApplied,[34]);assert.equal(result.liveRows,0);
 assert.deepEqual(await legacy(db),before);assert.deepEqual((await db.raw.execute('SELECT * FROM users')).rows,users);
 assert.ok(!statements.some(q=>/^CREATE TABLE IF NOT EXISTS users|^UPDATE health_insights SET legacy_classification/.test(q)));
 assert.equal((await controlledMigration(db.raw,{apply:true,keys:fixtureKeys,targetVersion:34})).versionsApplied.length,0);
 await db.admitRuntime();
});
test('v33 must precede v34; direct controlled v32-to-v34 request is rejected, ordered engine installs both',async t=>{
 const db=await fixture(t,32);await assert.rejects(controlledMigration(db.raw,{apply:true,keys:fixtureKeys,targetVersion:34}),/VERSION_OUT_OF_RANGE/);
 assert.deepEqual((await db.migrate({targetVersion:34})).versionsApplied,[33,34]);
 const versions=(await db.raw.execute('SELECT version,note FROM schema_version WHERE version>=33 ORDER BY version')).rows;
 assert.deepEqual(versions.map(r=>r.version),[33,34]);assert.equal(versions[0].note,'phase4 v33 postconditions verified');
});
test('v34 requires authentic contiguous v33 marker before any v34 object or marker',async t=>{
 const db=await fixture(t);await db.raw.execute("UPDATE schema_version SET note='unreviewed' WHERE version=33");
 await assert.rejects(db.migrate({targetVersion:34}),/VERSION_AUTHORITY_INCOMPLETE/);
 assert.equal((await db.raw.execute("SELECT count(*) n FROM sqlite_master WHERE name='morning_brief_plans'")).rows[0].n,0);
 assert.equal((await db.raw.execute('SELECT max(version) v FROM schema_version')).rows[0].v,33);
});
const definition=buildV34(),mutations=[...definition.ddl,...definition.columns.map(c=>`ALTER TABLE ${c.table} ADD COLUMN ${c.column} ${c.definition}`),...definition.indexes,...definition.triggers,...definition.replacements.flatMap(r=>[r.ddl,`DROP ${r.kind} IF EXISTS ${r.oldName}`]),'VERSION'];
const boundaries=[0,1,definition.ddl.length-1,definition.ddl.length,definition.ddl.length+1,definition.ddl.length+definition.columns.length+definition.indexes.length,mutations.length-5,mutations.length-4,mutations.length-3,mutations.length-2,mutations.length-1];
for(const boundary of boundaries)test(`v34 crash before mutation ${boundary} resumes without premature version or legacy damage`,async t=>{
 const db=await fixture(t),before=await legacy(db);let index=0;
 const faulty={execute:async q=>{if(/^(CREATE|ALTER|DROP) |^INSERT INTO schema_version/.test(sql(q).trim())&&index++===boundary)throw Error('SYNTHETIC_MIGRATION_CRASH');return db.raw.execute(q);}};
 await assert.rejects(applyPhase4Migrations(faulty,33,34,{privacyKeys:fixtureKeys}),/SYNTHETIC_MIGRATION_CRASH/);
 assert.equal((await db.raw.execute('SELECT max(version) v FROM schema_version')).rows[0].v,33);
 await db.migrate({targetVersion:34});await db.migrate({targetVersion:34});await verifyPhase4Schema(db.raw,34);await db.admitRuntime();assert.deepEqual(await legacy(db),before);
 assert.equal((await db.raw.execute('SELECT count(*) n FROM owner_monitoring_outbox')).rows[0].n,0);
});
test('v34 wrong keys and incompatible partial object reject without a marker',async t=>{
 const db=await fixture(t),wrong=createPhase4Keys({lookupKey:Buffer.alloc(32,99),auditKey:Buffer.alloc(32,83)});
 await assert.rejects(applyPhase4Migrations(db.raw,33,34,{privacyKeys:wrong}),/KEY_MISMATCH/);
 await db.raw.execute('CREATE TABLE morning_brief_plans(user_id TEXT)');await assert.rejects(db.migrate({targetVersion:34}),/postcondition/);
 assert.equal((await db.raw.execute('SELECT max(version) v FROM schema_version')).rows[0].v,33);
});
for(const object of ['p4_owner_copy_fence','p4_outbound_messages_envelope_v34','p4_morning_refresh_consume','p4_morning_brief_plans_privacy_id'])test(`v34 admission rejects missing ${object}`,async t=>{
 const db=await fixture(t,34);await db.raw.execute(`DROP ${object.endsWith('privacy_id')?'INDEX':'TRIGGER'} ${object}`);await assert.rejects(db.admitRuntime(),/postcondition/);
});
test('v34 CLI and exported apply reject remote targets before network or database access',async t=>{
 let calls=0;t.mock.method(globalThis,'fetch',()=>{calls++;throw Error('NETWORK_FORBIDDEN');});
 await assert.rejects(main(['--apply','--expected-target','synthetic.invalid','--target-version','34'],{TURSO_DATABASE_URL:'libsql://synthetic.invalid'}),/V34_LOCAL_ONLY/);
 await assert.rejects(controlledMigration({protocol:'hrana',execute(){calls++;throw Error('DATABASE_FORBIDDEN');}},{apply:true,keys:fixtureKeys,targetVersion:34}),/V34_LOCAL_ONLY/);assert.equal(calls,0);
});
