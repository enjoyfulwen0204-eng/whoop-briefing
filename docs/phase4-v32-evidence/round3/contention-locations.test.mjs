import test from 'node:test';import assert from 'node:assert/strict';import {createClient} from '@libsql/client/sqlite3';
import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {composeDb} from '../../src/db.js';import {fixtureKeys} from '../../test/localDb.js';
import {createOwnedDb} from '../../test/stage5OwnedDb.js';import {admitRuntime} from '../../src/runtimeAdmission.js';
async function fixture(t){const dir=await mkdtemp(join(tmpdir(),'p4-r3-busy-')),url=`file:${join(dir,'db.sqlite')}`,seed=createOwnedDb({url});
 await seed.migrate({targetVersion:31});await seed.raw.execute('PRAGMA journal_mode=DELETE');await seed.close();
 const reader=createClient({url}),writer=createClient({url});
 t.after(async()=>{reader.close();writer.close();await rm(dir,{recursive:true,force:true});});return {reader,writer,url};}
test('R3 actual normal driver: genuine SQLITE_BUSY at COMMIT retains its uncommitted transaction',async t=>{
 const {reader,writer}=await fixture(t),read=await reader.transaction('read');await read.execute('SELECT count(*) FROM system_heartbeats');
 const write=await writer.transaction('write');await write.execute("INSERT INTO system_heartbeats(scope,component,last_ok_at,last_detail,updated_at) VALUES ('global','isolated_commit_probe','2026-10-08',NULL,'2026-10-08')");
 let error;try{await write.commit();}catch(e){error=e;}
 console.log(JSON.stringify({probe:'native_commit_busy',transactionAttempt:1,admissionAttempt:0,retry:0,
  code:error?.code??null,location:'COMMIT',transactionClosed:write.closed,durableWorkAlreadyCommitted:false}));
 try{assert.equal(error?.code,'SQLITE_BUSY');assert.equal(write.closed,false);await read.rollback();await write.commit();
  assert.equal((await writer.execute("SELECT count(*) n FROM system_heartbeats WHERE component='isolated_commit_probe'")).rows[0].n,1);
 }finally{if(!read.closed)await read.rollback();if(!write.closed)await write.rollback();read.close();write.close();}
});
test('R3 fresh admission under transient native contention must retain all assertions and retry within original budget',async t=>{
 const {reader,writer}=await fixture(t),db=composeDb(reader,{phase4Keys:fixtureKeys});await db.admitRuntime();
 // The exported admission accepts the actual composed underlying client too.
 // This is genuine engine contention, with no mocked error or metadata result.
 await writer.execute('BEGIN EXCLUSIVE');const release=setTimeout(()=>{void writer.execute('ROLLBACK');},150);
 let error;const started=Date.now();try{await admitRuntime(reader,fixtureKeys);}catch(e){error=e;}finally{clearTimeout(release);await writer.execute('ROLLBACK');}
 console.log(JSON.stringify({probe:'native_fresh_admission_busy',transactionAttempt:0,admissionAttempt:1,retry:0,
  code:error?.code??null,location:'sqlite_master',elapsedMs:Date.now()-started,deadlineRemainingMs:15000-(Date.now()-started),durableWorkAlreadyCommitted:false}));
 assert.equal(error,undefined,'fresh metadata admission must survive bounded transient native contention');
});
