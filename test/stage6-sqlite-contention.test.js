import test from 'node:test';import assert from 'node:assert/strict';import {createClient} from '@libsql/client/sqlite3';
import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
for(const mode of ['DELETE','WAL'])test(`physical SQLite ${mode}: reader/writer and writer/writer lock classification`,async()=>{
 const dir=await mkdtemp(join(tmpdir(),'stage6-lock-control-')),url='file:'+join(dir,'fixture.sqlite'),clients=[0,1,2].map(()=>createClient({url})),[seed,reader,writer]=clients;
 try{
  await seed.execute('CREATE TABLE resource_locks(name TEXT PRIMARY KEY,owner TEXT)');await seed.execute("INSERT INTO resource_locks VALUES('synthetic','initial')");
  assert.equal(String((await seed.execute('PRAGMA journal_mode='+mode)).rows[0][0]).toUpperCase(),mode);assert.equal((await writer.execute('PRAGMA busy_timeout')).rows[0][0],0);
  await reader.execute('BEGIN DEFERRED');assert.equal((await reader.execute('SELECT owner FROM resource_locks')).rows[0][0],'initial');
  await writer.execute('BEGIN IMMEDIATE');await writer.execute("UPDATE resource_locks SET owner='first'");
  let readerBlocksCommit=false;try{await writer.execute('COMMIT');}catch(e){assert.equal(e.code,'SQLITE_BUSY');readerBlocksCommit=true;}
  assert.equal(readerBlocksCommit,mode==='DELETE');await reader.execute('ROLLBACK');if(readerBlocksCommit)await writer.execute('COMMIT');
  assert.equal((await seed.execute('SELECT owner FROM resource_locks')).rows[0][0],'first');
  await writer.execute('BEGIN IMMEDIATE');await assert.rejects(reader.execute('BEGIN IMMEDIATE'),{code:'SQLITE_BUSY'});await writer.execute('ROLLBACK');
  await reader.execute('BEGIN IMMEDIATE');await reader.execute('ROLLBACK');
  console.log('LOCK_CONTROL '+JSON.stringify({mode,busyTimeoutMs:0,readerBlocksCommit,overlappingWriterBeginBusy:true,releasedWriterAllowsNext:true,manualGc:false}));
 }finally{for(const c of clients)c.close();await rm(dir,{recursive:true,force:true});}
});
