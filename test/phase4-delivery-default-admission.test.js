import test from 'node:test';
import assert from 'node:assert/strict';
import {deliveryFixture,deliveryColumn,fixtureKeys} from './deliveryDefaultFixture.js';
import {admitRuntime,canonicalRuntimeContract} from '../src/runtimeAdmission.js';
import {controlledMigration} from '../scripts/phase4-migrate.js';
import {buildV32} from '../src/phase4V32Schema.js';
import {createHash} from 'node:crypto';
import {createBriefingEndpoint} from '../src/briefingEndpoint.js';
import {runExecutionPhase} from '../src/phase4Execution.js';
import {BRIEFING_TRIGGER,signTriggerRequest} from '../src/briefingTriggerAuth.js';
test('production-history v7 DELIVERED default survives v31→v32 and admits without schema/data writes',async t=>{
 const {db}=await deliveryFixture(t);
 assert.equal((await deliveryColumn(db)).dflt_value,"'DELIVERED'");
 assert.equal((await db.raw.execute('SELECT max(version) version FROM schema_version')).rows[0].version,32);
 assert.equal(canonicalRuntimeContract().objects.size,520);
 const execute=db.raw.execute,queries=[];
 db.raw.execute=async statement=>{queries.push(typeof statement==='string'?statement:statement.sql);return execute(statement);};
 try{await admitRuntime(db.raw,fixtureKeys);}finally{db.raw.execute=execute;}
 assert.equal(queries.length,5);assert.ok(queries.every(sql=>/^SELECT|^PRAGMA (foreign_keys|ignore_check_constraints)/.test(sql)));
 assert.equal((await db.raw.execute('PRAGMA integrity_check')).rows[0].integrity_check,'ok');
 assert.deepEqual((await db.raw.execute('PRAGMA foreign_key_check')).rows,[]);
 assert.equal((await deliveryColumn(db)).dflt_value,"'DELIVERED'");
});
for(const defaultValue of ['ACTION_READY','AMBIGUOUS'])test(`exact separately-reviewed ${defaultValue} installation history remains admitted`,async t=>{
 const {db}=await deliveryFixture(t,{defaultValue});
 assert.equal((await deliveryColumn(db)).dflt_value,`'${defaultValue}'`);await admitRuntime(db.raw,fixtureKeys);
});
async function replaceDefinition(db,change){
 const row=(await db.raw.execute("SELECT sql FROM sqlite_master WHERE name='telegram_operations' AND type='table'")).rows[0];
 const dependents=(await db.raw.execute("SELECT sql FROM sqlite_master WHERE tbl_name='telegram_operations' AND type IN ('index','trigger') AND sql IS NOT NULL ORDER BY type,name")).rows;
 const altered=change(row.sql);assert.notEqual(altered,row.sql,'the external-style corruption must change the actual SQL');
 await db.raw.execute('DROP TABLE telegram_operations');await db.raw.execute(altered);
 for(const dependent of dependents)await db.raw.execute(dependent.sql);
}
const definition="delivery_state TEXT NOT NULL DEFAULT 'DELIVERED'";
for(const [name,replacement] of [
 ['missing default','delivery_state TEXT NOT NULL'],
 ['unrelated default',"delivery_state TEXT NOT NULL DEFAULT 'UNRELATED'"],
 ['legal enum is not a default authority',"delivery_state TEXT NOT NULL DEFAULT 'NOT_REQUIRED'"],
 ['in-flight enum is not a default authority',"delivery_state TEXT NOT NULL DEFAULT 'DELIVERY_STARTED'"],
 ['wrong quoted value case',"delivery_state TEXT NOT NULL DEFAULT 'delivered'"],
 ['different quote form','delivery_state TEXT NOT NULL DEFAULT "DELIVERED"'],
 ['altered type',"delivery_state INTEGER NOT NULL DEFAULT 'DELIVERED'"],
 ['altered nullability',"delivery_state TEXT DEFAULT 'DELIVERED'"],
 ['incorrect CHECK',"delivery_state TEXT NOT NULL DEFAULT 'DELIVERED' CHECK(delivery_state <> 'DELIVERED')"],
 ['incompatible enum CHECK',"delivery_state TEXT NOT NULL DEFAULT 'DELIVERED' CHECK(delivery_state IN ('DELIVERED','ACTION_READY'))"],
])test(`historical default compatibility rejects ${name}`,async t=>{
 const {db}=await deliveryFixture(t);await replaceDefinition(db,sql=>sql.replace(definition,replacement));
 await assert.rejects(()=>admitRuntime(db.raw,fixtureKeys),/schema_postcondition_failed: telegram_operations/);
});
test('historical default compatibility rejects missing delivery_state',async t=>{
 const {db}=await deliveryFixture(t);await replaceDefinition(db,sql=>sql.replace(new RegExp(',\\s*'+definition),''));
 await assert.rejects(()=>admitRuntime(db.raw,fixtureKeys),/schema_postcondition_failed: telegram_operations/);
});
for(const [name,drop,create] of [
 ['wrong v32 trigger','DROP TRIGGER p4_execution_transition',"CREATE TRIGGER p4_execution_transition BEFORE UPDATE ON phase4_executions BEGIN SELECT 1; END"],
 ['wrong v32 index','DROP INDEX idx_p4_execution_unfinalized','CREATE INDEX idx_p4_execution_unfinalized ON phase4_executions(execution_id)'],
])test(`historical default compatibility still rejects ${name}`,async t=>{
 const {db}=await deliveryFixture(t);await db.raw.execute(drop);await db.raw.execute(create);await assert.rejects(()=>admitRuntime(db.raw,fixtureKeys));
});
test('historical v31→v32 controlled migration and same-key no-op preserve every existing table fingerprint and original keys',async t=>{
 const {db}=await deliveryFixture(t,{version:31});
 await db.createUser({id:'synthetic',displayName:'Synthetic',timezone:'Asia/Taipei',status:'ACTIVE'});
 await db.raw.execute("INSERT INTO whoop_cycles(user_id,id,synced_at) VALUES('synthetic','isolated','2026-10-09')");
 const tables=(await db.raw.execute("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('schema_version','phase4_migration_checkpoints') ORDER BY name")).rows;
 const fingerprint=async()=>Object.fromEntries(await Promise.all(tables.map(async table=>[table.name,createHash('sha256').update(JSON.stringify([table.sql,(await db.raw.execute(`SELECT * FROM ${table.name}`)).rows])).digest('hex')])));
 const before=await fingerprint(),columnBefore=await deliveryColumn(db);
 const keyAuthority=JSON.stringify((await db.raw.execute('SELECT * FROM phase4_migration_checkpoints WHERE target_version<32 ORDER BY target_version,step_key')).rows);
 const execute=db.raw.execute,submitted=[];db.raw.execute=async q=>{submitted.push(typeof q==='string'?q:q.sql);return execute(q);};
 const migrated=await controlledMigration(db.raw,{apply:true,keys:fixtureKeys,targetVersion:32});
 assert.deepEqual(migrated.versionsApplied,[32]);assert.deepEqual(await fingerprint(),before);
 assert.equal(JSON.stringify((await db.raw.execute('SELECT * FROM phase4_migration_checkpoints WHERE target_version<32 ORDER BY target_version,step_key')).rows),keyAuthority);
 assert.deepEqual(await deliveryColumn(db),columnBefore);
 assert.ok(!submitted.some(sql=>/^\s*(ALTER|DROP|UPDATE|INSERT|REPLACE|DELETE)\b.*telegram_operations/i.test(sql)));
 for(const ddl of buildV32().ddl){const name=/^CREATE (?:TABLE|(?:UNIQUE )?INDEX|TRIGGER) IF NOT EXISTS (\w+)/.exec(ddl)[1];assert.equal((await db.raw.execute({sql:'SELECT count(*) n FROM sqlite_master WHERE name=?',args:[name]})).rows[0].n,1,name);}
 submitted.length=0;assert.deepEqual((await controlledMigration(db.raw,{apply:true,keys:fixtureKeys,targetVersion:32})).versionsApplied,[]);
 assert.ok(!submitted.some(sql=>/^\s*(CREATE|ALTER|DROP|INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sql)));
 db.raw.execute=execute;await admitRuntime(db.raw,fixtureKeys);assert.deepEqual(await fingerprint(),before);
 assert.equal((await db.raw.execute('PRAGMA integrity_check')).rows[0].integrity_check,'ok');assert.deepEqual((await db.raw.execute('PRAGMA foreign_key_check')).rows,[]);
 assert.equal((await db.raw.execute("SELECT count(*) n FROM phase4_computation_state WHERE execution_mode='LIVE'")).rows[0].n,0);
 assert.equal((await db.raw.execute("SELECT count(*) n FROM sqlite_master WHERE name LIKE '%stage7%' OR name LIKE '%stage8%'")).rows[0].n,0);
});
test('production-like DELIVERED default supports v32-compatible OFF/OFF rollback with legacy signed ingress and replay',async t=>{
 const {db}=await deliveryFixture(t),environment={PHASE4_EXECUTION_PROFILE:'RC2_V32_ROLLBACK',PHASE4_BETA_SHADOW_RUNTIME:'off',PHASE4_PUBLIC_BETA_MODE:'off',
  PHASE4_LOOKUP_KEY:Buffer.alloc(32,71).toString('hex'),PHASE4_AUDIT_KEY:Buffer.alloc(32,83).toString('hex')};
 const secret='synthetic-default-rollback-secret-32',at=Date.now();let syncs=0,drains=0;
 const endpoint=createBriefingEndpoint({secret,environment,now:()=>at,runPhase:args=>runExecutionPhase({...args,db,environment,keys:fixtureKeys,
  env:{timezone:'Asia/Taipei',dryRun:true,maxUserConcurrency:1},deps:{runBriefing:async()=>{syncs++;return {syncComplete:true,syncOutcome:'NO_NEW_DATA_SUCCESS'};},runtime:{phase4Stage6:{drain:()=>{drains++;throw Error('ROLLBACK_DRAIN_FORBIDDEN');}}}}})});
 const requestId='default_legacy_signed_request',body='{}',timestamp=String(at);
 const req={method:'POST',url:BRIEFING_TRIGGER.PATH,headers:{'content-type':'application/json','x-briefing-request-id':requestId,
  'x-briefing-timestamp':timestamp,'x-briefing-signature':signTriggerRequest({timestamp,requestId,method:'POST',path:BRIEFING_TRIGGER.PATH,body},secret)}};
 const first=await endpoint(req,body);assert.equal(first.status,200);assert.equal(first.body.drainAuthorized,false);
 assert.deepEqual(await endpoint(req,body),first);assert.equal(syncs,1);assert.equal(drains,0);
 assert.equal((await deliveryColumn(db)).dflt_value,"'DELIVERED'");
 assert.equal((await db.raw.execute('SELECT max(version) v FROM schema_version')).rows[0].v,32);
});
