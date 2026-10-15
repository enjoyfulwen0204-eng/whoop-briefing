import test from 'node:test';import assert from 'node:assert/strict';
import {createStage6OwnedMemoryDb} from './checkout/src/db.js';
import {fixtureKeys} from './checkout/test/localDb.js';
import {scheduleNativeReceiverExecutor} from './checkout/src/stage6NativeScheduling.js';
const busy=ms=>{const at=performance.now();while(performance.now()-at<ms){}};
test('wrapper preserves exact ACK objects, receiver/arguments, and original failure without scheduling rejected operations',async()=>{
 const order=[],result={rows:[{value:1}]},error=Object.assign(Error('ORIGINAL_FAILURE'),{code:'SYNTHETIC_ORIGINAL'});let pauses=0;
 const executor={async execute(...args){assert.equal(this,executor);order.push(['execute',...args]);return result;},async batch(...args){assert.equal(this,executor);order.push(['batch',...args]);throw error;}};
 const wrapped=scheduleNativeReceiverExecutor(executor,async()=>{pauses++;order.push('pause');});assert.equal(wrapped,executor);
 assert.equal(await wrapped.execute('SELECT ?', [1]),result);await assert.rejects(wrapped.batch(['bad'],'write'),e=>e===error);assert.equal(pauses,1);assert.deepEqual(order,[['execute','SELECT ?',[1]],'pause',['batch',['bad'],'write']]);
});
test('Promise.all native ACK yields retain shared transaction snapshot and exclude a concurrently queued root writer',async t=>{
 const db=await createStage6OwnedMemoryDb(c=>c.execute('CREATE TABLE independent_parallel(n INTEGER)'),fixtureKeys);t.after(()=>db.close());let competing=false,queued,timer;
 timer=setImmediate(()=>{queued=db.transaction(async()=>{competing=true;await db.raw.execute('INSERT INTO independent_parallel VALUES(2)');});});
 await db.transaction(async()=>{await db.raw.execute('INSERT INTO independent_parallel VALUES(1)');busy(12);
  for(let n=0;n<200;n++){const [a,b]=await Promise.all([db.raw.execute('SELECT count(*) n FROM independent_parallel'),db.raw.execute('SELECT sum(n) n FROM independent_parallel')]);assert.equal(a.rows[0].n,1);assert.equal(b.rows[0].n,1);assert.equal(competing,false);}
 });clearImmediate(timer);await queued;assert.deepEqual((await db.raw.execute('SELECT n FROM independent_parallel ORDER BY n')).rows.map(r=>r.n),[1,2]);
});
test('one rejected parallel SQL prevents a delayed successful ACK continuation from writing after rollback or into a successor root',async t=>{
 const db=await createStage6OwnedMemoryDb(c=>c.execute('CREATE TABLE independent_late(n INTEGER)'),fixtureKeys);t.after(()=>db.close());let late;
 await assert.rejects(db.transaction(async()=>{await db.raw.execute('INSERT INTO independent_late VALUES(1)');busy(12);
  late=db.raw.execute('SELECT n FROM independent_late').then(()=>db.raw.execute('INSERT INTO independent_late VALUES(99)'));
  await Promise.all([late,db.raw.execute('SELECT absent_column FROM independent_late')]);
 }),/absent_column/);
 await db.transaction(()=>db.raw.execute('INSERT INTO independent_late VALUES(2)'));await assert.rejects(late,/absent_column|TRANSACTION_CLOSED/);
 assert.deepEqual((await db.raw.execute('SELECT n FROM independent_late ORDER BY n')).rows.map(r=>r.n),[2]);
});
