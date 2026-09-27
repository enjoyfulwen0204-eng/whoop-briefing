import test from 'node:test';
import assert from 'node:assert/strict';
import { processingTransactions } from '../src/processingTransaction.js';
const busy=()=>Object.assign(Error('locked'),{code:'SQLITE_BUSY'});

test('M003: admission/commit contention does not repeat the application callback',async()=>{
  let begins=0,commits=0,calls=0,reconnects=0;
  const base={protocol:'file',execute:async()=>({}),reconnect:async()=>{reconnects++;},transaction:async()=>{
    if(++begins===1)throw busy();
    return {execute:async()=>({}),commit:async()=>{if(++commits===1)throw busy();},close(){},rollback:async()=>{}};
  }};
  const p=processingTransactions(base);
  assert.equal(await p.transaction(async()=>{calls++;return 'result';}),'result');
  assert.deepEqual({begins,commits,calls,reconnects},{begins:2,commits:2,calls:1,reconnects:1});
});

test('M003: non-contention error runs once and rolls back; no arbitrary callback retry',async()=>{
  let calls=0,rollbacks=0;
  const p=processingTransactions({execute:async()=>({}),transaction:async()=>({commit:async()=>{},close(){},rollback:async()=>{rollbacks++;}})});
  await assert.rejects(p.transaction(async()=>{calls++;throw Error('APPLICATION_FAULT');}),/APPLICATION_FAULT/);
  assert.equal(calls,1);assert.equal(rollbacks,1);
});

test('M003: contention budget is finite even when the lock never clears',async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout']});
  let calls=0,failed=false;
  const p=processingTransactions({execute:async()=>({}),transaction:async()=>{calls++;throw busy();}});
  const pending=assert.rejects(p.transaction(async()=>assert.fail('callback before admission')),/locked/).then(()=>{failed=true;});
  for(let i=0;i<100&&!failed;i++) {await Promise.resolve();t.mock.timers.tick(1000);}
  await pending;assert.ok(calls>1&&calls<30);
});

test('M003: read-only startup contention refreshes the idle local connection',async()=>{
  let reads=0,reconnects=0;
  const p=processingTransactions({protocol:'file',reconnect:async()=>{reconnects++;},execute:async()=>{if(++reads===1)throw busy();return 'schema';}});
  assert.equal(await p.client.execute('SELECT name FROM sqlite_master'),'schema');assert.equal(reads,2);assert.equal(reconnects,1);
});
