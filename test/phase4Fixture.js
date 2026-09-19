/** Test-only authority. Callers cannot supply a database, URL, client, transport,
 * binding or credentials. Each invocation owns a fresh in-memory fixture. */
import { randomUUID } from 'node:crypto';
import Database from 'libsql';
import { Sqlite3Client } from '@libsql/client/sqlite3';
import { composeDb } from '../src/db.js';
import { fixtureKeys } from './localDb.js';
import { buildPhase4Core, fail } from '../src/phase4Core.js';
import { composePhase4Stores } from '../src/phase4Repositories.js';

export async function syntheticPhase4Fixture(t,options={}) {
  if(Object.keys(options).some(k=>k!=='now'))fail('SYNTHETIC_FIXTURE_EXTERNAL_INPUT_FORBIDDEN');
  const {now=()=>new Date('2026-09-19T00:00:00.000Z')}=options;
  // The installed client's transaction() rotates its connection. An unnamed
  // :memory: URL therefore loses the database; a private named memory URI plus
  // an anchor survives rotation without ever creating a file.
  const uri=`file:p4-${randomUUID()}?mode=memory&cache=shared`,anchor=new Database(uri);
  const client=new Sqlite3Client(uri,{},anchor,'number');
  const db=composeDb(client,{phase4Keys:fixtureKeys});t.after(()=>{db.close();anchor.close();});
  if((await db.raw.execute('PRAGMA database_list')).rows.some(r=>r.file!==''))fail('SYNTHETIC_DATABASE_NOT_MEMORY');
  await db.migrate();
  const connection=db.raw;
  const build=()=>buildPhase4Core({processing:{client:connection,transaction:db.transaction,active:db.processingTransactionActive,afterCommit:db.afterProcessingCommit},keys:fixtureKeys,now,
    authorizeMode(mode,client){if(client!==connection || !['SHADOW','LIVE'].includes(mode))fail('SYNTHETIC_AUTHORITY_MISMATCH');}});
  const core=await build();
  for(const id of ['a','b']) {
    await db.createUser({id,displayName:'Synthetic',timezone:'Asia/Taipei',status:'ACTIVE'},{now:now()});
    await core.initializeTenant(id,'SHADOW');
  }
  return {db,core,stores:composePhase4Stores(core),keys:fixtureKeys,fakeTransport:Object.freeze({kind:'IN_MEMORY_FAKE_ONLY'}),
    restart:async()=>{const restarted=await build();return {core:restarted,stores:composePhase4Stores(restarted)};}};
}
