import test from 'node:test';
import assert from 'node:assert/strict';
import {createDb,fixtureKeys} from './localDb.js';
import {applyPhase4Migrations,verifyPhase4Schema} from '../src/phase4Migrations.js';
import {buildV33} from '../src/phase4V33Schema.js';

test('v33 additive restart at every DDL/column/index/trigger boundary withholds marker and preserves v32',async t=>{
 const objects=buildV33();
 for(const stop of [0,1,objects.ddl.length,objects.ddl.length+3,objects.ddl.length+objects.columns.length+2]){
  const db=createDb({url:':memory:'});
  try{
   await db.migrate({targetVersion:32});await db.createUser({id:'a',displayName:'Synthetic',timezone:'America/New_York',status:'ACTIVE'});
   const old=(await db.raw.execute("SELECT sql FROM sqlite_master WHERE name='phase4_execution_work_receipts'")).rows[0].sql;
   let n=0;const faulty={execute:async q=>{if(/^(?:CREATE|ALTER)/.test(typeof q==='string'?q:q.sql)&&n++===stop)throw Error('SYNTHETIC_CRASH');return db.raw.execute(q);}};
   await assert.rejects(applyPhase4Migrations(faulty,32,33,{privacyKeys:fixtureKeys}),/SYNTHETIC_CRASH/);
   assert.equal((await db.raw.execute('SELECT max(version) v FROM schema_version')).rows[0].v,32);
   await db.migrate({targetVersion:33});await db.migrate({targetVersion:33});await verifyPhase4Schema(db.raw,33);
   assert.equal((await db.raw.execute("SELECT sql FROM sqlite_master WHERE name='phase4_execution_work_receipts'")).rows[0].sql,old);
   assert.equal((await db.raw.execute('SELECT count(*) n FROM quick_action_interactions')).rows[0].n,0);
  }finally{db.close();}
 }
});
test('v33 rejects partial incompatible objects and never commits version',async()=>{
 const db=createDb({url:':memory:'});try{
  await db.migrate({targetVersion:32});await db.raw.execute('CREATE TABLE quick_action_interactions(user_id TEXT)');
  await assert.rejects(db.migrate({targetVersion:33}),/postcondition/);
  assert.equal((await db.raw.execute('SELECT max(version) v FROM schema_version')).rows[0].v,32);
 }finally{db.close();}
});
