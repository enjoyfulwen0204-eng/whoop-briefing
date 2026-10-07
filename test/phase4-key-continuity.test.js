import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createOwnedDb} from './stage5OwnedDb.js';
import {fixtureKeys} from './localDb.js';
import {createPhase4Keys} from '../src/phase4Keys.js';
import {admitRuntime} from '../src/runtimeAdmission.js';

test('v22 operator upgrade preserves original keys, tenant roots and completed authority at v31',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'p4-vietnam-key-continuity-')),db=createOwnedDb({url:`file:${join(dir,'isolated.db')}`});
 t.after(async()=>{await db.close();await rm(dir,{recursive:true,force:true});});
 await db.migrate({targetVersion:22});
 const ts='2026-10-07T00:00:00.000Z';
 await db.raw.execute({sql:`INSERT INTO users(id,display_name,status,created_at,updated_at) VALUES (?,?,?,?,?)`,args:['synthetic-continuity','Synthetic','ACTIVE',ts,ts]});
 const before=(await db.raw.execute(`SELECT step_key,last_cursor FROM phase4_migration_checkpoints
   WHERE step_key IN ('lookup_key_check','audit_key_check') ORDER BY step_key`)).rows;
 assert.equal(before.length,2);
 await db.migrate({targetVersion:31});
 const after=(await db.raw.execute(`SELECT step_key,last_cursor FROM phase4_migration_checkpoints
   WHERE step_key IN ('lookup_key_check','audit_key_check') ORDER BY step_key`)).rows;
 assert.deepEqual(after,before);
 assert.equal((await db.raw.execute("SELECT display_name FROM users WHERE id='synthetic-continuity'")).rows[0].display_name,'Synthetic');
 const admission=await db.admitRuntime();assert.equal(db.requireRuntimeAdmission(admission),31);
 for(const [lookup,audit,code] of [[72,83,'LOOKUP'],[71,84,'AUDIT']]) {
   const wrong=createPhase4Keys({lookupKey:Buffer.alloc(32,lookup),auditKey:Buffer.alloc(32,audit)});
   await assert.rejects(()=>admitRuntime(db.raw,wrong),new RegExp(`PHASE4_${code}_KEY_MISMATCH`));
 }
 await assert.rejects(()=>admitRuntime(db.raw,undefined),/PHASE4_PRIVACY_KEYS_REQUIRED/);
 assert.equal(fixtureKeys.verifyLookupCheckpoint(after.find(r=>r.step_key==='lookup_key_check').last_cursor),true);
 assert.equal(fixtureKeys.verifyAuditCheckpoint(after.find(r=>r.step_key==='audit_key_check').last_cursor),true);
 assert.equal((await db.raw.execute('SELECT MAX(version) AS version FROM schema_version')).rows[0].version,31);
});
