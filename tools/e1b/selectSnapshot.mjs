import {DatabaseSync} from 'node:sqlite';
import {mkdtemp, link, rm} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {assertErasureTables, ERASURE_TABLES} from '../../src/erasureCatalog.js';
import {fail, failureFields, atTable, isRemoteExpiry} from './rehearsalDiagnostics.mjs';
import {snapshotConnection, checkMemory, fallbackTimeLeft, identifier} from './snapshotStream.mjs';

export {identifier, assertSelect} from './snapshotStream.mjs';
const schemaSql = "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE type IN ('table','index','trigger') ORDER BY type,name LIMIT 2049";
const maxRetries = 2;

async function readSchema(conn) {
  try {
    const rows=await conn.rows(schemaSql);
    if (rows.length >= 2049) fail('SNAPSHOT_SCHEMA_BOUND');
    const schema=rows.map(({type,name,tbl_name,sql})=>({type,name,tbl_name,sql}));
    if (schema.some(s=>!Object.hasOwn(ERASURE_TABLES,s.tbl_name))) fail('SNAPSHOT_UNKNOWN_TABLE');
    assertErasureTables(schema.filter(s=>s.type==='table').map(s=>s.name));
    return schema;
  } catch (error) { throw atTable(error,'sqlite_schema'); }
}

async function rowCount(conn, table) {
  const rows=await conn.rows('SELECT COUNT(*) AS n FROM '+identifier(table));
  const n=Number(rows[0]?.n);
  if (rows.length!==1 || !Number.isSafeInteger(n) || n<0 || rows[0].n==null) fail('SNAPSHOT_COUNT_INVALID');
  return n;
}

async function copyTable({conn, local, table, fallback, guard, report, onProgress, total}) {
  const id=identifier(table);
  const columns=local.prepare('SELECT * FROM '+id+' LIMIT 0').columns().map(c=>c.name);
  const placeholders=columns.map(()=>'?').join(',');
  const insert=local.prepare('INSERT INTO '+id+' ('+columns.map(identifier).join(',')+') VALUES ('+placeholders+')');
  for (let attempt=0;;attempt++) {
    guard();
    local.exec('SAVEPOINT copy_table');
    try {
      // Rebuild sqlite_sequence last; explicit indexes/triggers are installed
      // only after all data. Re-reads roll back their local changes together.
      if (table==='sqlite_sequence') local.exec('DELETE FROM sqlite_sequence');
      const before=await rowCount(conn,table);
      const copied=await conn.copyRows(table,columns,insert,count=>{
        if ((total+count)%1000===0) {checkMemory();onProgress(total+count);}
      });
      const after=await rowCount(conn,table);
      const saved=local.prepare('SELECT COUNT(*) AS n FROM '+id).get().n;
      if (before!==copied || after!==copied || saved!==copied) fail('SNAPSHOT_COUNT_MISMATCH');
      local.exec('RELEASE copy_table');
      return copied;
    } catch (error) {
      local.exec('ROLLBACK TO copy_table; RELEASE copy_table');
      const fields=failureFields(atTable(error,table));
      if (!fallback || fields.code!=='SNAPSHOT_COUNT_MISMATCH' || attempt>=maxRetries) throw error;
      report({phase:'EXPORT_TABLE_RETRY',...fields});
    }
  }
}

async function exportAttempt(options, fallback) {
  const {path,onReadStart,onProgress,report,now}=options;
  let local, scratch, inTransaction=false;
  const guard=()=>fallback ? Math.min(300000,fallbackTimeLeft(now)) : 300000;
  guard();checkMemory();
  const conn=await snapshotConnection({...options,guard});
  try {
    await conn.negotiate();
    onReadStart();
    if (!fallback) {
      // Only these literal transaction controls can bypass assertSelect.
      // BEGIN is deferred, and all statements inside it are generated SELECTs.
      await conn.remote(()=>conn.stream.run('BEGIN'));
      inTransaction=true;
      if (await conn.remote(()=>conn.stream.getAutocommit())) fail('SNAPSHOT_TRANSACTION_LOST');
    }
    const schema=await readSchema(conn);
    const tables=schema.filter(s=>s.type==='table').sort((a,b)=>Number(a.name==='sqlite_sequence')-Number(b.name==='sqlite_sequence'));
    scratch=await mkdtemp(join(dirname(path),'.e1b-copy-'));
    const staged=join(scratch,'copy.sqlite');
    local=new DatabaseSync(staged);
    local.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=OFF; BEGIN');
    for (const table of tables) {
      try { if (table.name!=='sqlite_sequence') local.exec(table.sql); }
      catch (error) { throw atTable(error,table.name); }
    }
    let rows=0;
    for (const {name} of tables) {
      checkMemory();
      try {
        rows+=await copyTable({conn,local,table:name,fallback,guard,report,onProgress,total:rows});
      } catch (error) { throw atTable(error,name); }
    }
    if (fallback) {
      if (JSON.stringify(await readSchema(conn))!==JSON.stringify(schema)) fail('SNAPSHOT_SCHEMA_CHANGED');
    } else {
      if (await conn.remote(()=>conn.stream.getAutocommit())) fail('SNAPSHOT_TRANSACTION_LOST');
      await conn.remote(()=>conn.stream.run('COMMIT'));
      inTransaction=false;
    }
    for (const s of schema) {
      try { if (s.type!=='table' && s.sql) local.exec(s.sql); }
      catch (error) { throw atTable(error,s.tbl_name); }
    }
    if (JSON.stringify(local.prepare(schemaSql).all())!==JSON.stringify(schema)) fail('SNAPSHOT_SCHEMA_CHANGED');
    if (local.prepare('SELECT MAX(version) AS v FROM schema_version').get().v!==33) fail('SNAPSHOT_V33_REQUIRED');
    const fk=local.prepare('PRAGMA foreign_key_check').get();
    if (fk) {
      try { fail('SNAPSHOT_FOREIGN_KEY_FAILED'); } catch (error) { throw atTable(error,fk.table); }
    }
    // SQLite returns exactly one 'ok' row on success. Inspect one row only;
    // integrity error text can contain row values and must never be logged.
    if (local.prepare('PRAGMA integrity_check').get()?.integrity_check!=='ok') fail('SNAPSHOT_INTEGRITY_FAILED');
    guard();
    local.exec('COMMIT; PRAGMA foreign_keys=ON');
    local.close();local=null;
    guard();
    // Atomic no-overwrite publication. Failed attempts leave no partial
    // destination and do not reuse a database or WAL from an earlier attempt.
    await link(staged,path);
    return {tables:tables.length,rows};
  } catch (error) {
    if (inTransaction && isRemoteExpiry(error)) return {expired:failureFields(error)};
    throw error;
  } finally {
    try {
      if (inTransaction && !conn.stream.closed) {
        try { await conn.remote(()=>conn.stream.run('ROLLBACK')); } catch { /* closing also abandons the read transaction */ }
      }
    } finally {
      conn.close();
      try { local?.close(); }
      finally { if (scratch) await rm(scratch,{recursive:true,force:true}); }
    }
  }
}

export async function exportSelectSnapshot({url,token,path,fetchImpl,openClient,now=Date.now,
  onProgress=()=>{},onReadStart=()=>{},report=()=>{}}) {
  const options={url,token,path,fetchImpl,openClient,now,onProgress,onReadStart,report};
  const result=await exportAttempt(options,false);
  if (!result.expired) return result;
  report({phase:'EXPORT_TRANSACTION_EXPIRED',...result.expired});
  for (let attempt=0;;attempt++) {
    try { return await exportAttempt(options,true); }
    catch (error) {
      const fields=failureFields(error);
      if (!['SNAPSHOT_FOREIGN_KEY_FAILED','SNAPSHOT_INTEGRITY_FAILED'].includes(fields.code) || attempt>=maxRetries) throw error;
      report({phase:'EXPORT_COPY_RETRY',...fields});
    }
  }
}
