import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers/promises';
import {createStage6OwnedMemoryDb} from '../src/db.js';
import {readOnlyProcessingCheck} from '../src/processingTransaction.js';
import {fixtureKeys} from './localDb.js';
for(const reject of [false,true,'undefined'])test('all readonly terminal checks settle with bounded fanout and original first-failure rollback '+reject,async t=>{
 const db=await createStage6OwnedMemoryDb(async c=>c.execute('CREATE TABLE synthetic_checks(n INTEGER)'),fixtureKeys);t.after(()=>db.close());
 let active=0,peak=0,settled=0;const started=new Set(),first=reject==='undefined'?undefined:Error('SYNTHETIC_EARLIER_ARRAY_FAILURE'),later=Error('SYNTHETIC_LATER_ARRAY_FAILURE');
 const run=()=>db.transaction(async()=>{
  await db.raw.execute('INSERT INTO synthetic_checks VALUES(1)');
  for(let i=0;i<300;i++)await db.transaction(()=>{},{after:readOnlyProcessingCheck(async client=>{
   started.add(i);active++;peak=Math.max(peak,active);
   try{
    await setImmediate();assert.equal((await client.execute('SELECT count(*) n FROM synthetic_checks')).rows[0].n,1);
    if(reject&&i===20){await setImmediate();throw first;}
    if(reject&&i===90)throw later;
   }finally{active--;settled++;}
  })});
 });
 if(reject){let failed=false;try{await run();}catch(error){failed=true;assert.equal(error,first);}assert.equal(failed,true,'even an undefined rejection must roll back');}else await run();
 assert.equal(started.size,300);assert.equal(settled,300);assert.equal(active,0);
 assert.ok(peak>1&&peak<=32,'metadata transport stays bounded without serializing every check');
 assert.equal((await db.raw.execute('SELECT count(*) n FROM synthetic_checks')).rows[0].n,reject?0:1);
});
