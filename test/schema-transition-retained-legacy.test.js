import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,chmod,copyFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {createClient} from '@libsql/client';
import {createOwnedDb} from './stage5OwnedDb.js';
import {fixtureKeys as keys} from './localDb.js';
import {runMigrations} from '../src/migrations.js';
import {LEGACY_TABLES,RETAINED_LEGACY_TABLE_DDL} from '../src/schema.js';
import {runningReleaseSha} from '../src/phase4Release.js';
import {SCHEMA_TRANSITION_PROFILE,createSchemaTransitionRuntimeProfile} from '../src/schemaTransitionProfile.js';
import {bindConnectionLifetime,admitRuntime,requireRuntimeAdmission} from '../src/runtimeAdmission.js';

const sha=x=>createHash('sha256').update(x).digest('hex'),connect=path=>createClient({url:'file:'+path,intMode:'number'});
test('strict optional retained legacy33 catalog only, actual synthetic SQLite, no network',async t=>{
 let network=0;t.mock.method(globalThis,'fetch',()=>{network++;throw Error('NETWORK_FORBIDDEN');});
 const directory=await mkdtemp('/private/tmp/stage8-retained-legacy-');await chmod(directory,0o700);t.after(()=>rm(directory,{recursive:true,force:true}));
 const seedPath=join(directory,'source33.sqlite'),seed=createOwnedDb({url:'file:'+seedPath});try{await seed.migrate({targetVersion:33});}finally{await seed.close();}await chmod(seedPath,0o600);
 let sequence=0;
 async function fixture({legacy=[],version=33,profile=true,ddls=[]}={}){
  const path=join(directory,'case-'+(++sequence)+'.sqlite');await copyFile(seedPath,path);await chmod(path,0o600);const client=connect(path);t.after(()=>client.close());
  if(version!==33)await runMigrations(client,{allowRebuild:false,targetVersion:version,privacyKeys:keys});
  for(const name of legacy)await client.execute(RETAINED_LEGACY_TABLE_DDL[name]);for(const sql of ddls)await client.execute(sql);
  const environment={PHASE4_EXECUTION_PROFILE:SCHEMA_TRANSITION_PROFILE,PHASE4_RELEASE_SHA:runningReleaseSha({})},runtimeProfile=profile?createSchemaTransitionRuntimeProfile({environment,keys}):undefined,transaction=()=>{};
  bindConnectionLifetime(client,client,transaction,{runtimeProfile,keys});return {client,transaction};
 }
 const admit=async f=>requireRuntimeAdmission(f.client,await admitRuntime(f.client,keys),keys,f.transaction);
 await t.test('retained definitions are exactly the two original audited fixture tables',async()=>{
  assert.deepEqual(Object.keys(RETAINED_LEGACY_TABLE_DDL),LEGACY_TABLES);
  const migrationFixture=await readFile(new URL('./migration.test.js',import.meta.url),'utf8');
  for(const name of LEGACY_TABLES){const ddl=new RegExp('`(CREATE TABLE '+name+' \\([\\s\\S]*?\\n   \\))`').exec(migrationFixture)[1];assert.equal(RETAINED_LEGACY_TABLE_DDL[name],ddl);}
 });
 for(const legacy of [[],['whoop_tokens'],['app_state'],['whoop_tokens','app_state']])await t.test('optional exact retained33 tables admit '+(legacy.join('+')||'absent')+' with same five metadata queries',async()=>{
  const f=await fixture({legacy}),execute=f.client.execute.bind(f.client),queries=[];f.client.execute=async query=>{queries.push(typeof query==='string'?query:query.sql);return execute(query);};assert.equal(await admit(f),33);assert.equal(queries.length,5);assert.ok(queries.every(sql=>/^SELECT\b|^PRAGMA foreign_keys\b/.test(sql)));assert.ok(queries.every(sql=>!/^SELECT .* FROM (whoop_tokens|app_state)\b/.test(sql)));
 });
 await t.test('admission reads no legacy credential/state rows and performs no deletion or mutation',async()=>{
  const f=await fixture({legacy:LEGACY_TABLES});await f.client.execute("INSERT INTO whoop_tokens VALUES(1,'SYNTHETIC-NOT-LIVE','SYNTHETIC-NOT-LIVE','2026-10-18T00:00:00.000Z',NULL,'2026-10-18T00:00:00.000Z')");await f.client.execute("INSERT INTO app_state VALUES('SYNTHETIC','SYNTHETIC','2026-10-18T00:00:00.000Z')");const before=sha(JSON.stringify((await f.client.execute("SELECT type,name,sql FROM sqlite_master ORDER BY type,name")).rows)),execute=f.client.execute.bind(f.client),queries=[];f.client.execute=async query=>{const sql=typeof query==='string'?query:query.sql;queries.push(sql);assert.match(sql,/^SELECT\b|^PRAGMA foreign_keys\b/);return execute(query);};assert.equal(await admit(f),33);assert.equal(queries.length,5);f.client.execute=execute;assert.equal(sha(JSON.stringify((await f.client.execute("SELECT type,name,sql FROM sqlite_master ORDER BY type,name")).rows)),before);assert.equal((await f.client.execute('SELECT count(*) n FROM whoop_tokens')).rows[0].n,1);assert.equal((await f.client.execute('SELECT count(*) n FROM app_state')).rows[0].n,1);
 });
 for(const name of LEGACY_TABLES)await t.test('retained name cannot authorize a view or same-name trigger: '+name,async()=>{
  const view=await fixture({ddls:['CREATE VIEW '+name+' AS SELECT 1 value']});await assert.rejects(admit(view),/RETAINED_LEGACY_DEFINITION_INVALID/);
  const trigger=await fixture({legacy:LEGACY_TABLES,ddls:['CREATE TRIGGER '+name+' BEFORE UPDATE ON '+(name==='whoop_tokens'?'app_state':'whoop_tokens')+' BEGIN SELECT 1; END']});await assert.rejects(admit(trigger),/RETAINED_LEGACY_DEFINITION_INVALID/);
 });
 await t.test('optional tables do not admit arbitrary attached trigger, custom index, or future partial catalog object',async()=>{
  for(const sql of ['CREATE TRIGGER synthetic_retained_trigger BEFORE UPDATE ON whoop_tokens BEGIN SELECT 1; END','CREATE INDEX synthetic_retained_index ON app_state(value)','CREATE TABLE synthetic_future_object(id INTEGER)','CREATE VIEW synthetic_future_view AS SELECT 1 value']){const f=await fixture({legacy:LEGACY_TABLES,ddls:[sql]});await assert.rejects(admit(f),/UNEXPECTED_SCHEMA_OBJECT/);}
 });
 await t.test('changed CHECK/type/nullability/default/column/order/storage shape never inherits retained name trust',async()=>{
  const whoop=RETAINED_LEGACY_TABLE_DDL.whoop_tokens,app=RETAINED_LEGACY_TABLE_DDL.app_state;
  for(const sql of [whoop.replace('CHECK (id = 1)','CHECK (id IN (1,2))'),whoop.replace(' CHECK (id = 1)',''),whoop.replace('TEXT NOT NULL','TEXT'),whoop.replace('scope                   TEXT','scope                   TEXT DEFAULT \'SYNTHETIC\''),whoop.replace('updated_at              TEXT NOT NULL','updated_at              INTEGER NOT NULL'),whoop.replace('\n   )',', extra TEXT\n   )'),app.replace('value      TEXT NOT NULL','value      TEXT'),app.replace('value      TEXT NOT NULL','value      TEXT NOT NULL DEFAULT \'SYNTHETIC\''),'CREATE TABLE app_state(value TEXT NOT NULL,key TEXT PRIMARY KEY,updated_at TEXT NOT NULL)',app+' WITHOUT ROWID']){const f=await fixture({ddls:[sql]});await assert.rejects(admit(f),/RETAINED_LEGACY_DEFINITION_INVALID/);}
 });
 await t.test('legacy allowance cannot bypass original key continuity or canonical index contract',async()=>{
  const f=await fixture({legacy:LEGACY_TABLES});await f.client.execute("UPDATE phase4_migration_checkpoints SET last_cursor='SYNTHETIC-WRONG' WHERE target_version=22 AND step_key='lookup_key_check'");await assert.rejects(admit(f),/LOOKUP_KEY_MISMATCH/);await f.client.execute({sql:"UPDATE phase4_migration_checkpoints SET last_cursor=? WHERE target_version=22 AND step_key='lookup_key_check'",args:[keys.lookupCheckpoint()]});await f.client.execute('DROP INDEX uniq_whoop_webhook_event');await assert.rejects(admit(f),/schema_postcondition_failed/);
 });
 await t.test('normal33 stays refused, committed34 stays refused, normal/transition35 canonical behavior stays intact',async()=>{
  await assert.rejects(admit(await fixture({legacy:LEGACY_TABLES,profile:false})),/CONTROLLED_MIGRATION_REQUIRED/);await assert.rejects(admit(await fixture({legacy:LEGACY_TABLES,version:34})),/COMMITTED_VERSION_REQUIRED/);assert.equal(await admit(await fixture({legacy:LEGACY_TABLES,version:35})),35);assert.equal(await admit(await fixture({legacy:LEGACY_TABLES,version:35,profile:false})),35);
 });
 assert.equal(network,0);
});
