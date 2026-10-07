import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join} from 'node:path';import {createOwnedDb} from '../../test/stage5OwnedDb.js';
import {fixtureKeys} from '../../test/localDb.js';import {admitRuntime} from '../../src/runtimeAdmission.js';
test('R3 unchanged candidate fresh admission: empty vs 1000 tenants/50000 history rows',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'p4-r3-perf-')),db=createOwnedDb({url:`file:${join(dir,'db.sqlite')}`});
 t.after(async()=>{await db.close();await rm(dir,{recursive:true,force:true});});await db.migrate({targetVersion:31});const execute=db.raw.execute;
 for(const populated of [false,true]){
  if(populated){await execute(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<1000)
   INSERT INTO users(id,display_name,timezone,status,created_at,updated_at) SELECT 'tenant-'||x,'Synthetic','Asia/Taipei','ACTIVE','2026-10-08','2026-10-08' FROM n`);
   await execute(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<50000)
   INSERT INTO whoop_cycles(user_id,id,synced_at) SELECT 'tenant-1','cycle-'||x,'2026-10-08' FROM n`);}
  for(const latencyMs of [0,20,50,150]){const statements=[];
   db.raw.execute=async stmt=>{statements.push(typeof stmt==='string'?stmt:stmt.sql);if(latencyMs)await new Promise(r=>setTimeout(r,latencyMs));return execute(stmt);};
   const started=performance.now();await admitRuntime(db.raw,fixtureKeys);const elapsedMs=performance.now()-started;
   assert.equal(statements.length,5);assert.ok(statements.every(sql=>/^SELECT type,name,sql FROM sqlite_master|^SELECT version,note FROM schema_version|^SELECT target_version|^PRAGMA (foreign_keys|ignore_check_constraints)/.test(sql)));
   assert.ok(elapsedMs<10000);console.log(JSON.stringify({probe:'unchanged_candidate_admission',tenants:populated?1000:0,historyRows:populated?50000:0,latencyMs,queries:statements.length,elapsedMs}));
  }db.raw.execute=execute;
 }
});
