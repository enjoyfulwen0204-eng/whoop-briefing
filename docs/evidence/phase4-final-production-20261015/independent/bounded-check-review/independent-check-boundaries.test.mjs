import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers/promises';
import {createStage6OwnedMemoryDb} from './checkout/src/db.js';
import {readOnlyProcessingCheck} from './checkout/src/processingTransaction.js';
import {fixtureKeys} from './checkout/test/localDb.js';
async function fixture(t){const db=await createStage6OwnedMemoryDb(c=>c.execute('CREATE TABLE review_checks(n INTEGER)'),fixtureKeys);t.after(()=>db.close());return db;}
test('same marked function is invoked seventy times while an external root writer waits',async t=>{
 const db=await fixture(t);let ready,release;const entered=new Promise(r=>ready=r),gate=new Promise(r=>release=r);let calls=0,finished=false;
 // This continuation is created outside the transaction ALS context.
 const writer=(async()=>{await entered;await db.transaction(()=>db.raw.execute('INSERT INTO review_checks VALUES(2)'));assert.equal(finished,true);})();
 const check=readOnlyProcessingCheck(async client=>{calls++;if(calls===1){ready();await setImmediate();release();}await gate;assert.equal((await client.execute('SELECT count(*) n FROM review_checks')).rows[0].n,1);});
 await db.transaction(async()=>{await db.raw.execute('INSERT INTO review_checks VALUES(1)');for(let i=0;i<70;i++)await db.transaction(()=>{},{after:check});},{beforeCommit:()=>{finished=true;}});
 await writer;assert.equal(calls,70);assert.equal((await db.raw.execute('SELECT count(*) n FROM review_checks')).rows[0].n,2);
});
for(const forbiddenIndex of [0,33,64])test('read-only guard survives awaited callbacks and later batches '+forbiddenIndex,async t=>{
 const db=await fixture(t);let invoked=0,settled=0;
 await assert.rejects(db.transaction(async()=>{await db.raw.execute('INSERT INTO review_checks VALUES(1)');for(let i=0;i<70;i++)await db.transaction(()=>{},{after:readOnlyProcessingCheck(async client=>{invoked++;try{await setImmediate();if(i===forbiddenIndex)await client.batch(['SELECT 1','INSERT INTO review_checks VALUES(99)']);else await client.execute('SELECT 1');}finally{settled++;}})});}),/PROCESSING_READ_ONLY_CHECK_REQUIRED/);
 assert.equal(invoked,70);assert.equal(settled,70);assert.equal((await db.raw.execute('SELECT count(*) n FROM review_checks')).rows[0].n,0);
 await db.transaction(()=>db.raw.execute('INSERT INTO review_checks VALUES(2)'));assert.equal((await db.raw.execute('SELECT count(*) n FROM review_checks')).rows[0].n,1);
});
test('an unmarked separator waits for the first group and restores ordinary write semantics',async t=>{
 const db=await fixture(t);let done=0,separator=false,suffix=0;
 await db.transaction(async()=>{
  await db.raw.execute('INSERT INTO review_checks VALUES(1)');
  for(let i=0;i<40;i++)await db.transaction(()=>{},{after:readOnlyProcessingCheck(async client=>{await setImmediate();assert.equal(separator,false);await client.execute('SELECT 1');done++;})});
  await db.transaction(()=>{},{after:async client=>{assert.equal(done,40);await client.execute('INSERT INTO review_checks VALUES(2)');separator=true;}});
  for(let i=0;i<40;i++)await db.transaction(()=>{},{after:readOnlyProcessingCheck(async client=>{assert.equal(separator,true);assert.equal((await client.execute('SELECT count(*) n FROM review_checks')).rows[0].n,2);suffix++;})});
 });
 assert.equal(suffix,40);assert.equal((await db.raw.execute('SELECT count(*) n FROM review_checks')).rows[0].n,2);
});
test('synchronous first rejection retains identity after every later batch settles',async t=>{
 const db=await fixture(t),first=Symbol('first-array-rejection');let invoked=0,settled=0;
 let caught=false;try{await db.transaction(async()=>{await db.raw.execute('INSERT INTO review_checks VALUES(1)');for(let i=0;i<67;i++)await db.transaction(()=>{},{after:readOnlyProcessingCheck(client=>{invoked++;if(i===0){settled++;throw first;}return setImmediate().then(async()=>{try{await client.execute('SELECT 1');if(i===35)throw undefined;}finally{settled++;}});})});});}catch(error){caught=true;assert.equal(error,first);}
 assert.equal(caught,true);assert.equal(invoked,67);assert.equal(settled,67);assert.equal((await db.raw.execute('SELECT count(*) n FROM review_checks')).rows[0].n,0);
});
