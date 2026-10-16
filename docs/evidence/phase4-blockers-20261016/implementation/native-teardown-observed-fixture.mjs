import {writeSync as diagnosticWrite} from 'node:fs';
/** Test-only authority. Callers cannot supply a database, URL, client, transport,
 * binding or credentials. Each invocation owns a fresh in-memory fixture. */
import { randomUUID } from 'node:crypto';
import Database from 'file:///Users/kelvin/Desktop/whoop-briefing/node_modules/libsql/index.js';
import { Sqlite3Client, Sqlite3Transaction } from 'file:///Users/kelvin/Desktop/whoop-briefing/node_modules/@libsql/client/lib-esm/sqlite3.js';
import { composeDb,createStage6OwnedMemoryDb } from 'file:///Users/kelvin/.codex/worktrees/phase4-final-integration/whoop-briefing/src/db.js';
import { fixtureKeys } from 'file:///Users/kelvin/.codex/worktrees/phase4-final-integration/whoop-briefing/test/localDb.js';
import { buildPhase4Core, fail } from 'file:///Users/kelvin/.codex/worktrees/phase4-final-integration/whoop-briefing/src/phase4Core.js';
import { composePhase4Stores } from 'file:///Users/kelvin/.codex/worktrees/phase4-final-integration/whoop-briefing/src/phase4Repositories.js';

export async function syntheticPhase4Fixture(t,options={}) {
  if(Object.keys(options).some(k=>!['now','targetVersion','ownedConnection'].includes(k)))fail('SYNTHETIC_FIXTURE_EXTERNAL_INPUT_FORBIDDEN');
  const {now=()=>new Date('2026-09-19T00:00:00.000Z'),targetVersion=27,ownedConnection=false}=options;
  if(typeof ownedConnection!=='boolean')fail('SYNTHETIC_FIXTURE_EXTERNAL_INPUT_FORBIDDEN');
  if(![27,28,29,30,33,34,35].includes(targetVersion))fail('SYNTHETIC_FIXTURE_VERSION_INVALID');
  // This synthetic authority owns one native in-memory connection. Use the
  // installed driver's SQL executor and transaction implementation on that
  // connection. Application processing serializes root transactions. The
  // driver's normal rotating-connection lifecycle is probed separately.
  const collectStatements=async()=>{
    diagnosticMark('COLLECT_BEFORE_GC');global.gc?.();diagnosticMark('COLLECT_AFTER_GC');
    await new Promise(resolve=>setImmediate(()=>{diagnosticMark('IMMEDIATE1_CALLBACK');resolve();}));diagnosticMark('AFTER_IMMEDIATE1');
    await new Promise(resolve=>setImmediate(()=>{diagnosticMark('IMMEDIATE2_CALLBACK');resolve();}));diagnosticMark('AFTER_IMMEDIATE2');
  };
  let db;
  if(ownedConnection){
    // Real application-owned receiver/lifetime, used only for capacity evidence.
    // Generic caller-owned/reconnect tests keep their full admission fallback.
    db=await createStage6OwnedMemoryDb(async()=>{},fixtureKeys);
  }else{
  const uri=`file:p4-${randomUUID()}?mode=memory&cache=shared`,anchor=new Database(uri);
  const client=new Sqlite3Client(uri,{},anchor,'number');
  client.transaction=async(mode='write')=>{
    await client.execute(mode==='write'?'BEGIN IMMEDIATE':mode==='read'?'BEGIN DEFERRED':'BEGIN');
    return new Sqlite3Transaction(anchor,'number');
  };
  db=composeDb(client,{phase4Keys:fixtureKeys});
  }
  t.after(async()=>{
    diagnosticMark('FIXTURE_AFTER_ENTER');await collectStatements();diagnosticMark('DB_CLOSE_BEFORE');db.close();diagnosticMark('DB_CLOSE_RETURNED');
    await collectStatements();
  });
  if((await db.raw.execute('PRAGMA database_list')).rows.some(r=>r.file!==''))fail('SYNTHETIC_DATABASE_NOT_MEMORY');
  await db.migrate({targetVersion});
  const connection=db.raw;
  const build=()=>buildPhase4Core({processing:{client:connection,transaction:db.transaction,active:db.processingTransactionActive,afterCommit:db.afterProcessingCommit,afterCompletion:db.afterProcessingCompletion},keys:fixtureKeys,now,
    authorizeMode(mode,client){if(client!==connection || !['SHADOW','LIVE'].includes(mode))fail('SYNTHETIC_AUTHORITY_MISMATCH');}});
  const core=await build();
  for(const id of ['a','b']) {
    await db.createUser({id,displayName:'Synthetic',timezone:'Asia/Taipei',status:'ACTIVE'},{now:now()});
    await core.initializeTenant(id,'SHADOW');
  }
  return {db,core,stores:composePhase4Stores(core),keys:fixtureKeys,fakeTransport:Object.freeze({kind:'IN_MEMORY_FAKE_ONLY'}),
    restart:async()=>{const restarted=await build();return {core:restarted,stores:composePhase4Stores(restarted)};}};
}

function diagnosticMark(value){diagnosticWrite(1,'# NATIVE_TEARDOWN_MARK '+JSON.stringify({at:new Date().toISOString(),pid:process.pid,value,gcType:typeof global.gc,execArgv:process.execArgv,nodeOptionsPresent:Boolean(process.env.NODE_OPTIONS),memory:process.memoryUsage()})+'\n');}
