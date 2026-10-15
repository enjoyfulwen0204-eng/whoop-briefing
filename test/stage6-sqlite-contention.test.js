import test from 'node:test';import assert from 'node:assert/strict';import {createClient} from '@libsql/client/sqlite3';
import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createClient as createHttpClient} from '@libsql/client';import {hranaTransport} from './hranaTransport.js';
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
test('115ms native Hrana fixture records the exact failed BEGIN and live writer connection',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'stage6-hrana-holder-')),url='file:'+join(directory,'fixture.sqlite'),seed=createClient({url});
 await seed.execute('PRAGMA journal_mode=WAL');await seed.execute('CREATE TABLE resource_locks(name TEXT PRIMARY KEY,owner TEXT)');seed.close();
 const transport=hranaTransport(url,{traceTransactions:true,transactionMaxMs:5000});
 const client=role=>createHttpClient({url:'https://isolated.invalid',fetch:async(r,i)=>{await new Promise(resolve=>setTimeout(resolve,115));return transport.fetch(new Request(r,i),{role});}});
 const left=client('service-parent'),right=client('drain-parent');let owner,contender;
 try{
  owner=await left.transaction('write');await owner.execute('SELECT 1');contender=await right.transaction('write');await assert.rejects(contender.execute('SELECT 2'),{code:'SQLITE_BUSY'});
  const failure=transport.evidence.find(e=>e.code==='SQLITE_BUSY');assert.equal(failure.verb,'BEGIN');assert.equal(failure.role,'drain-parent');assert.equal(failure.lockHolders.length,1);assert.equal(failure.lockHolders[0].role,'service-parent');assert.equal(failure.lockHolders[0].mode,'IMMEDIATE');assert.notEqual(failure.connectionId,failure.lockHolders[0].connectionId);
  await owner.rollback();console.log('HRANA_EXACT_HOLDER '+JSON.stringify({latencyMs:115,errors:transport.evidence,counts:transport.counts,transactionLimitMs:5000,retries:0}));
 }finally{owner?.close();contender?.close();left.close();right.close();transport.close();await rm(directory,{recursive:true,force:true});}
});
