import test from 'node:test';import assert from 'node:assert/strict';import {createClient} from '@libsql/client';
import {Sqlite3Client} from '@libsql/client/sqlite3';import {WsClient} from '@libsql/client/ws';
import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {composeDb} from '../src/db.js';import {createOwnedDb} from './stage5OwnedDb.js';import {fixtureKeys} from './localDb.js';
import {admitRuntime} from '../src/runtimeAdmission.js';
for(const path of ['facade','raw','underlying','retained','prototype','http-retained'])test(`R2 lifetime: permanent revocation through ${path} close/reconnect`,async t=>{
 const dir=await mkdtemp(join(tmpdir(),'p4-lifetime-')),url=`file:${join(dir,'db.sqlite')}`,seed=createOwnedDb({url});
 await seed.migrate({targetVersion:31});await seed.close();
 const base=createClient({url:path==='http-retained'?'https://synthetic.invalid':url});
 // Real HTTP driver's lifecycle, synthetic metadata adapter: no network call.
 const local=path==='http-retained'?createClient({url}):null;if(local)base.execute=local.execute.bind(local);
 const savedClose=base.close.bind(base),savedReconnect=base.reconnect.bind(base),db=composeDb(base,{phase4Keys:fixtureKeys});
 t.after(async()=>{db.close();local?.close();await rm(dir,{recursive:true,force:true});});const cap=await db.admitRuntime();assert.equal(db.requireRuntimeAdmission(cap),31);
 for(const bad of [{},{...cap},JSON.parse(JSON.stringify(cap))])assert.throws(()=>db.requireRuntimeAdmission(bad));
 const other=composeDb(createClient({url}),{phase4Keys:fixtureKeys});assert.throws(()=>other.requireRuntimeAdmission(cap));other.close();
 if(path==='facade')db.close();else if(path==='raw')db.raw.close();else if(path==='underlying')base.close();else if(path==='prototype')Sqlite3Client.prototype.close.call(base);else savedClose();
 assert.throws(()=>db.requireRuntimeAdmission(cap));if(Object.hasOwn(base,'closed'))base.closed=false;assert.throws(()=>db.requireRuntimeAdmission(cap));
 await (path==='prototype'?Sqlite3Client.prototype.reconnect.call(base):savedReconnect());assert.throws(()=>db.requireRuntimeAdmission(cap));
 const fresh=await db.admitRuntime();assert.notEqual(fresh,cap);assert.equal(db.requireRuntimeAdmission(fresh),31);
 savedClose();const change=createClient({url});await change.execute('DROP TRIGGER p4_outbox_transition');change.close();await savedReconnect();
 assert.throws(()=>db.requireRuntimeAdmission(fresh));await assert.rejects(()=>db.admitRuntime());
});
test('R2 admission performance: five queries at local/20/50/150ms, independent of synthetic tenant/history volume',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'p4-admission-perf-')),db=createOwnedDb({url:`file:${join(dir,'db.sqlite')}`});
 t.after(async()=>{await db.close();await rm(dir,{recursive:true,force:true});});await db.migrate({targetVersion:31});const execute=db.raw.execute;
 for(const populated of [false,true]){
 if(populated){await execute(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<100)
 INSERT INTO users(id,display_name,timezone,status,created_at,updated_at) SELECT 'tenant-'||x,'Synthetic','Asia/Taipei','ACTIVE','2026-10-07','2026-10-07' FROM n`);
 await execute(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<10000)
 INSERT INTO whoop_cycles(user_id,id,synced_at) SELECT 'tenant-1','cycle-'||x,'2026-10-07' FROM n`);}
 for(const latencyMs of [0,20,50,150]){let queries=[];db.raw.execute=async q=>{queries.push(typeof q==='string'?q:q.sql);if(latencyMs)await new Promise(r=>setTimeout(r,latencyMs));return execute(q);};
 const started=performance.now();await admitRuntime(db.raw,fixtureKeys);const elapsedMs=performance.now()-started;
 assert.equal(queries.length,5);assert.ok(queries.every(q=>/^SELECT type,name,sql FROM sqlite_master|^SELECT version,note FROM schema_version|^SELECT target_version|^PRAGMA (foreign_keys|ignore_check_constraints)/.test(q)));
 assert.ok(elapsedMs<10000);console.log(JSON.stringify({measurement:'round2_admission',latencyMs,populated,tenants:populated?100:0,historyRows:populated?10000:0,queries:queries.length,elapsedMs}));}
 db.raw.execute=execute;
 }
});

test('R2 lifetime: real WebSocket client retained close revokes permanently without any network',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'p4-ws-lifetime-')),local=createOwnedDb({url:`file:${join(dir,'db.sqlite')}`});
 t.after(async()=>{await local.close();await rm(dir,{recursive:true,force:true});});await local.migrate({targetVersion:31});let closes=0;
 // Actual driver class and close method; constructor receives an owned synthetic
 // Hrana connection so no socket/DNS/provider request is created.
 const base=new WsClient({close(){closes++;}},new URL('ws://synthetic.invalid'),undefined,'number',1);
 base.execute=local.raw.execute.bind(local.raw);const close=base.close.bind(base),db=composeDb(base,{phase4Keys:fixtureKeys});
 const cap=await db.admitRuntime();assert.equal(db.requireRuntimeAdmission(cap),31);close();assert.equal(closes,1);
 base.closed=false;assert.throws(()=>db.requireRuntimeAdmission(cap));await assert.rejects(()=>db.admitRuntime(),/CONNECTION_REQUIRED/);
});
