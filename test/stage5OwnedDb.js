/** Synthetic file-backed regression fixture. Real installed SQL/transactions,
 * with connection ownership isolated from the native finalizer race. */
import Database from 'libsql';
import { Sqlite3Client,Sqlite3Transaction } from '@libsql/client/sqlite3';
import { fileURLToPath } from 'node:url';
import { composeDb,fixtureKeys } from './localDb.js';

export function createOwnedDb({url}) {
  if(typeof url!=='string'||!url.startsWith('file:'))throw Error('SYNTHETIC_FILE_DATABASE_REQUIRED');
  const filename=fileURLToPath(url),anchor=new Database(filename),client=new Sqlite3Client(filename,{},anchor,'number');
  client.transaction=async(mode='write')=>{
    await client.execute(mode==='write'?'BEGIN IMMEDIATE':mode==='read'?'BEGIN DEFERRED':'BEGIN');
    return new Sqlite3Transaction(anchor,'number');
  };
  const db=composeDb(client,{phase4Keys:fixtureKeys}),close=db.close;
  const collect=async()=>{global.gc?.();await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve));};
  // Frozen migration regressions explicitly target the Stage 5 schema. New
  // Stage 6 migration tests pass targetVersion:28 instead of changing them.
  return {...db,migrate:options=>db.migrate({targetVersion:27,...options}),close:async()=>{await collect();close();await collect();}};
}
