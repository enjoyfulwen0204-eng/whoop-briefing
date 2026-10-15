import test from 'node:test';
import assert from 'node:assert/strict';
import {createStage6OwnedMemoryDb} from '../src/db.js';
import {fixtureKeys} from './localDb.js';
test('owned native RAM SQL yields to the event loop while retaining the processing transaction owner',async t=>{
 const db=await createStage6OwnedMemoryDb(async client=>client.execute('CREATE TABLE synthetic_fairness(n INTEGER)'),fixtureKeys);
 t.after(()=>db.close());
 let turn=false,competing=false,queued;
 const marker=setImmediate(()=>{turn=true;queued=db.transaction(async()=>{competing=true;await db.raw.execute('INSERT INTO synthetic_fairness VALUES(2)');});});
 t.after(()=>clearImmediate(marker));
 await db.transaction(async()=>{
  await db.raw.execute('INSERT INTO synthetic_fairness VALUES(1)');
  for(let i=0;i<3000;i++)assert.equal((await db.raw.execute('SELECT count(*) n FROM synthetic_fairness')).rows[0].n,1);
  assert.equal(turn,true,'timer must run before the long synchronous SQL chain finishes');
  assert.equal(competing,false,'event-loop fairness must not release the transaction root');
 });
 await queued;
 assert.deepEqual((await db.raw.execute('SELECT n FROM synthetic_fairness ORDER BY n')).rows.map(r=>r.n),[1,2]);
 await assert.rejects(db.transaction(async()=>{await db.raw.execute('INSERT INTO synthetic_fairness VALUES(3)');throw Error('SYNTHETIC_ROLLBACK');}),/SYNTHETIC_ROLLBACK/);
 assert.deepEqual((await db.raw.execute('SELECT n FROM synthetic_fairness ORDER BY n')).rows.map(r=>r.n),[1,2]);
});
test('revocation during a native fairness turn still fences and rolls back the active writer',async t=>{
 const db=await createStage6OwnedMemoryDb(async client=>client.execute('CREATE TABLE synthetic_revocation(n INTEGER)'),fixtureKeys);
 t.after(()=>db.close());let revoked=false,timer;
 try{
  await assert.rejects(db.withRuntimeFence(()=>{if(revoked)throw Error('SYNTHETIC_NATIVE_AUTHORITY_REVOKED');},()=>db.transaction(async()=>{
   await db.raw.execute('INSERT INTO synthetic_revocation VALUES(1)');
   timer=setImmediate(()=>{revoked=true;});
   for(let i=0;i<3000;i++)await db.raw.execute('SELECT count(*) n FROM synthetic_revocation');
  })),/SYNTHETIC_NATIVE_AUTHORITY_REVOKED/);
 }finally{clearImmediate(timer);revoked=false;}
 assert.equal((await db.raw.execute('SELECT count(*) n FROM synthetic_revocation')).rows[0].n,0);
});
