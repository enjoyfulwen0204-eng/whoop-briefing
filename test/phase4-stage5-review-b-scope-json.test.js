import test from 'node:test';
import assert from 'node:assert/strict';
import { syntheticPhase4Fixture } from './phase4Fixture.js';
import { setup,request } from './stage5HistoryFixture.js';
import { call } from './stage5ClosureFixture.js';
import { durable,semantic,leases,T } from './stage5ReviewBFixture.js';

for(const path of ['top-success','top-error','nested-success','nested-error','outer-rollback','after-check-error'])
  test(`M004: withContext ${path} retains capability through validation and releases at completion`,async t=>{
    const f=await syntheticPhase4Fixture(t);let captured,checked=false;
    const work=()=>f.stores.withContext('a',{executionMode:'SHADOW'},async c=>{
      captured=c;await f.stores.cache.set(c,'scope',{alive:true});
      await f.core.transaction(async()=>{}, {after:async()=>{await f.stores.assertCurrent(c);checked=true;
        if(path==='after-check-error')throw Error('AFTER_CHECK');}});
      if(path.endsWith('-error')&&path!=='after-check-error')throw Error('SCOPE_ERROR');
      return 'ok';
    });
    const run=()=>path.startsWith('top-')?work():f.db.transaction(async()=>{
      const result=await work();await f.stores.assertCurrent(captured);
      if(path==='outer-rollback')throw Error('OUTER_ROLLBACK');return result;
    });
    if(path.includes('error')||path.includes('rollback'))await assert.rejects(run(),/SCOPE_ERROR|OUTER_ROLLBACK|AFTER_CHECK/);
    else {assert.equal(await run(),'ok');assert.equal(checked,true);}
    assert.equal(await leases(f),0);await assert.rejects(f.stores.assertCurrent(captured),/CONTEXT_RELEASED/);
    await f.stores.release(captured);assert.equal(await leases(f),0);
  });

test('M004: an owned operation inside withContext leaves capability usable until scope exit',async t=>{
  const f=await setup(t);await f.stores.release(f.context);
  await f.stores.withContext('a',{executionMode:'SHADOW'},async c=>{
    const root=await f.stores.root(c,'recovery',f.recoveryIds[0]);
    await f.stores.intelligence.analyzeMetric(c,request(root.ref,[]));
    await f.stores.cache.set(c,'after-operation',true);assert.equal(await f.stores.cache.get(c,'after-operation'),true);
  });assert.equal(await leases(f),0);
});

test('M005: all accepted special own JSON keys survive identity, content and reordered exact replay',async t=>{
  const f=await setup(t),evidence=await call(f,'intelligence','analyzeMetric',request(f.initialRefs[0],[]));
  const identity={algorithmMajor:'phase4-intelligence-v1',direction:'LOWER',domain:'recovery',metric:'recovery_score',subject:'recovery_score',windowFamily:'JSON'};
  const values=['{"__proto__":{"value":1}}','{"__proto__":{"value":2}}',
    '{"nested":{"__proto__":{"value":1}}}','{"nested":{"__proto__":{"value":2}}}',
    '{"constructor":1}','{"constructor":2}','{"prototype":1}','{"prototype":2}',
    '{"雪\u0000":1,"":true}','{"雪\u0000":2,"":true}'].map(text=>JSON.parse(text.replaceAll('\u0000','\\u0000')));
  const keys=new Set();
  for(const [index,value] of values.entries()) {
    const req={identity:{...identity,windowFamily:`JSON-${index}`},data:{explanation_json:value},
      evidenceItemId:evidence.item.row.evidence_item_id,semanticAt:T};
    const result=await call(f,'episodes','open',req);
    assert.deepEqual(JSON.parse(result.row.explanation_json),value);
    const candidates=(await f.db.raw.execute("SELECT * FROM phase4_operation_receipts WHERE operation_kind='EPISODE_OPEN' ")).rows;
    const receipt=candidates.find(row=>JSON.parse(row.request_json).request.identity.windowFamily===req.identity.windowFamily);
    const normalized=JSON.parse(receipt.request_json).request;assert.deepEqual(normalized.data.explanation_json,value);
    // Compare identity with ONLY content changed, holding all other dimensions fixed.
    const other={...req,data:{explanation_json:values[index^1]}};
    await call(f,'episodes','open',other);
    const seconds=(await f.db.raw.execute("SELECT * FROM phase4_operation_receipts WHERE operation_kind='EPISODE_OPEN' ")).rows;
    const second=seconds.find(row=>row.operation_key!==receipt.operation_key&&JSON.parse(row.request_json).request.identity.windowFamily===req.identity.windowFamily);
    assert.ok(second);assert.notEqual(receipt.operation_key,second.operation_key);keys.add(receipt.operation_key);
    const reorder=v=>Array.isArray(v)?v.map(reorder):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).reverse().map(([k,v])=>[k,reorder(v)])):v;
    const before=await durable(f);
    assert.deepEqual(semantic(await call(f,'episodes','open',reorder(req))),semantic(result));
    assert.deepEqual(await durable(f),before);
  }
  assert.equal(keys.size,values.length);assert.equal({}.value,undefined);
});
