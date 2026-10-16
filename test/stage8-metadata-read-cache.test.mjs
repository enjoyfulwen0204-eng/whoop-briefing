import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,copyFile,chmod,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {createClient} from '@libsql/client';
import {createOwnedDb} from './stage5OwnedDb.js';
import {fixtureKeys} from './localDb.js';
import {readDatabaseControl} from '../scripts/stage8-production-control.mjs';
import {withStage8MetadataReadCache} from '../scripts/stage8-metadata-read-cache.mjs';
import {stage8PreservationSnapshot} from '../scripts/stage8-migration-safety.mjs';
import {originalStage8PreservationSnapshot} from './fixtures/stage8-preservation-v1.mjs';
import {runMigrations} from '../src/migrations.js';

const sql=query=>typeof query==='string'?query:query.sql;
const readOriginal=(client,keys)=>readDatabaseControl({protocol:client.protocol,execute:client.execute.bind(client)},keys);
const connect=path=>createClient({url:'file:'+path,intMode:'number'});
test('metadata prewarm observes actual batches only and bounded full-row reads retain the original keyed contract',async t=>{
 let network=0;t.mock.method(globalThis,'fetch',()=>{network++;throw Error('NETWORK_FORBIDDEN');});
 const dir=await mkdtemp('/private/tmp/stage8-metadata-cache-');await chmod(dir,0o700);t.after(()=>rm(dir,{recursive:true,force:true}));
 const source=join(dir,'source.sqlite'),db=createOwnedDb({url:'file:'+source});
 try{
  await db.migrate({targetVersion:33});
  await db.raw.execute('CREATE TABLE synthetic_snapshot_rows(a INTEGER NOT NULL,b TEXT NOT NULL,n INTEGER NULL,x REAL NULL,v BLOB NULL,payload TEXT NULL,PRIMARY KEY(a,b)) WITHOUT ROWID');
  await db.raw.execute('CREATE TABLE synthetic_snapshot_heap(value TEXT,other BLOB)');await db.raw.execute('CREATE TABLE synthetic_snapshot_empty(value TEXT)');
  for(let start=0;start<5120;start+=64)await db.raw.batch(Array.from({length:64},(_,index)=>{const i=5119-start-index;return {sql:'INSERT INTO synthetic_snapshot_rows VALUES(?,?,?,?,?,?)',args:[Math.floor(i/7),'k'+i%7,i%3?i:null,i%4?i/7:null,Buffer.from([i%256,(i>>8)%256]),i%5?'synthetic-'+i:null]};}),'write');
  await db.raw.batch(Array.from({length:129},(_,i)=>({sql:'INSERT INTO synthetic_snapshot_heap VALUES(?,?)',args:[i%2?'synthetic-'+i:null,Buffer.from([i%256])]})),'write');
 }finally{await db.close();}
 await t.test('1024-row pages and four table readers produce byte-identical snapshots to original128 serial algorithm',async()=>{
  const client=connect(source);try{
   const oldCounts={calls:0,pages:0},newCounts={calls:0,pages:0,maxActive:0};let active=0;
   const old=await originalStage8PreservationSnapshot({execute:query=>{oldCounts.calls++;if(/ LIMIT 128 OFFSET /.test(sql(query)))oldCounts.pages++;return client.execute(query);}},fixtureKeys);
   const current=await stage8PreservationSnapshot({execute:async query=>{newCounts.calls++;if(/ LIMIT 1024 OFFSET /.test(sql(query)))newCounts.pages++;active++;newCounts.maxActive=Math.max(newCounts.maxActive,active);try{return await client.execute(query);}finally{active--;}}},fixtureKeys);
   assert.deepEqual(current,old);assert.equal(JSON.stringify(current),JSON.stringify(old));assert.equal(current.synthetic_snapshot_rows.count,5120);assert.equal(current.synthetic_snapshot_heap.count,129);assert.equal(current.synthetic_snapshot_empty.count,0);assert.ok(newCounts.pages<oldCounts.pages);assert.ok(newCounts.maxActive<=4);
   assert.deepEqual(await stage8PreservationSnapshot(client,fixtureKeys,old),old);
   t.diagnostic('snapshot parity '+JSON.stringify({old:oldCounts,current:newCounts,fullRowsRead:5249,wholeTableCache:false}));
  }finally{client.close();}
 });
 await t.test('canonical33/34/35 cached reads equal original real algorithms and collapse unique metadata transport',async()=>{
  const client=connect(source);try{for(const version of [33,34,35]){
   if(version>33)await runMigrations(client,{allowRebuild:false,targetVersion:version,privacyKeys:fixtureKeys});
   let oldCalls=0;const expected=await readOriginal({protocol:client.protocol,execute:query=>{oldCalls++;return client.execute(query);}},fixtureKeys);
   const count={execute:0,batches:0,prewarmed:0,maxChunk:0,authorityReads:0},actual={protocol:client.protocol,execute:query=>{count.execute++;if(/phase4_migration_checkpoints|integrity_check|foreign_key_check|lease_until|lease_expires_at|FROM schema_version/.test(sql(query))&&!/sqlite_master|^PRAGMA table_info/.test(sql(query)))count.authorityReads++;return client.execute(query);},batch:(queries,mode)=>{count.batches++;count.prewarmed+=queries.length;count.maxChunk=Math.max(count.maxChunk,queries.length);assert.equal(mode,'read');assert.ok(queries.every(query=>/\bsqlite_master\b|^PRAGMA (table_info|index_info|index_list|foreign_key_list)\(/.test(sql(query))));assert.ok(queries.every(query=>!/^PRAGMA (integrity_check|foreign_key_check)/.test(sql(query))));return client.batch(queries,mode);}};
   const result=await withStage8MetadataReadCache(actual,fixtureKeys,readOriginal);assert.deepEqual(result,expected);assert.ok(count.batches<=12);assert.ok(count.maxChunk<=64);assert.ok(count.authorityReads>20);assert.ok(count.execute+count.batches<oldCalls/2);
   const batches=count.batches;assert.deepEqual(await withStage8MetadataReadCache(actual,fixtureKeys,readOriginal),expected);assert.equal(count.batches,batches*2,'a new call must observe metadata anew');
   t.diagnostic('actual installed-driver cache parity '+JSON.stringify({version,originalExecuteCalls:oldCalls,cachedExecuteCalls:count.execute/2,metadataBatches:batches,prewarmedStatements:count.prewarmed/2,transportCalls:count.execute/2+batches,maxChunk:count.maxChunk,authorityDataReads:count.authorityReads/2,providerCapacityProof:false}));
  }}finally{client.close();}
 });
 const copy=async(name,work)=>{const path=join(dir,name+'.sqlite');await copyFile(source,path);const client=connect(path);try{return await work(client);}finally{client.close();}};
 await t.test('schema/version drift and batch failure/mismatch fail closed without synthetic replacement data',async()=>{
  await copy('catalog-drift',async client=>{
   let changed=false;const actual={protocol:client.protocol,batch:client.batch.bind(client),execute:async query=>{const result=await client.execute(query);if(!changed&&sql(query)==='SELECT * FROM schema_version ORDER BY version'){changed=true;await client.execute('CREATE INDEX synthetic_changed_catalog ON synthetic_snapshot_heap(value)');}return result;}};
   await assert.rejects(withStage8MetadataReadCache(actual,fixtureKeys,readOriginal),/METADATA_SCHEMA_CHANGED_DURING_READ/);assert.ok(changed);
  });
  await copy('version-drift',async client=>{
   let changed=false;const actual={protocol:client.protocol,batch:client.batch.bind(client),execute:async query=>{const result=await client.execute(query);if(!changed&&sql(query)==='SELECT * FROM schema_version ORDER BY version'){changed=true;await client.execute("INSERT INTO schema_version VALUES(99,'synthetic','synthetic')");}return result;}};
   await assert.rejects(withStage8MetadataReadCache(actual,fixtureKeys,readOriginal),/METADATA_SCHEMA_(REQUIRED|CHANGED_DURING_READ)/);assert.ok(changed);
  });
  for(const fault of ['transport','length','columns'])await copy('batch-'+fault,async client=>{
   const actual={protocol:client.protocol,execute:client.execute.bind(client),batch:async(queries,mode)=>{const results=await client.batch(queries,mode);if(fault==='transport')throw Error('SYNTHETIC_RESPONSE_LOSS');if(fault==='length')return results.slice(1);const changed=results.findIndex(result=>JSON.stringify(result.columns)!==JSON.stringify(results[0].columns));[results[0],results[changed]]=[results[changed],results[0]];return results;}};
   await assert.rejects(withStage8MetadataReadCache(actual,fixtureKeys,readOriginal),/METADATA_BATCH_(FAILED|RESULT_INVALID)/);
  });
 });
 await t.test('caller argument/result mutation cannot change cached observations; mutable data and integrity reads always hit the database',async()=>{
  await copy('mutable-args',async client=>{
   let integrity=0,missing=0;const actual={protocol:client.protocol,batch:client.batch.bind(client),execute:query=>{if(sql(query)==='PRAGMA integrity_check')integrity++;if(sql(query)==='PRAGMA table_info("synthetic_snapshot_heap")')missing++;return client.execute(query);}};
   const probe=async(observed,keys)=>{
    const result=await readOriginal(observed,keys),query={sql:"SELECT sql FROM sqlite_master WHERE type='table' AND name=?",args:['users']};
    const first=await observed.execute(query),original=first.rows[0].sql;first.rows[0].sql='tampered';first.columns[0]='tampered';query.args[0]='schema_version';
    const next=observed.execute(query);query.args[0]='users';assert.match((await next).rows[0].sql,/CREATE TABLE schema_version/);assert.equal((await observed.execute(query)).rows[0].sql,original);
    await observed.execute('PRAGMA integrity_check');await observed.execute('PRAGMA integrity_check');return result;
   };
   const expected=await readOriginal(client,fixtureKeys);assert.deepEqual(await withStage8MetadataReadCache(actual,fixtureKeys,probe),expected);assert.ok(integrity>=3);assert.equal(missing,1,'unplanned actual metadata is fetched once within this call');
  });
 });
 assert.equal(network,0);
});
