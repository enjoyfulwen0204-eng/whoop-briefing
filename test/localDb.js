/** Synthetic local fixtures only. These keys are never application defaults. */
import { randomUUID } from 'node:crypto';
import Database from 'libsql';
import { Sqlite3Client,Sqlite3Transaction } from '@libsql/client/sqlite3';
import { composeDb, createDb as createApplicationDb } from '../src/db.js';
import { createPhase4Keys } from '../src/phase4Keys.js';
export * from '../src/db.js';
export const fixtureKeys = createPhase4Keys({ lookupKey: Buffer.alloc(32, 71), auditKey: Buffer.alloc(32, 83) });
export function createDb(options) {
  if (options.url !== ':memory:' && !options.url?.startsWith('file:')) throw new Error('synthetic_local_database_only');
  if(options.url === ':memory:'){
    const uri=`file:local-fixture-${randomUUID()}?mode=memory&cache=shared`,anchor=new Database(uri);
    const client=new Sqlite3Client(uri,{},anchor,'number');
    client.transaction=async(mode='write')=>{await client.execute(mode==='write'?'BEGIN IMMEDIATE':mode==='read'?'BEGIN DEFERRED':'BEGIN');return new Sqlite3Transaction(anchor,'number');};
    return composeDb(client,{phase4Keys:fixtureKeys});
  }
  return createApplicationDb({ phase4Keys: fixtureKeys, ...options });
}
