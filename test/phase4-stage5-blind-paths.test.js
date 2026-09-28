import test from 'node:test';
import assert from 'node:assert/strict';
import { setup,request } from './stage5HistoryFixture.js';
import { call } from './stage5ClosureFixture.js';
import { snapshot } from './stage5M007Fixture.js';
import { semantic,leases,T } from './stage5ReviewBFixture.js';

test('BF-M02: literal path labels preserve JSON order while genuine nested source sets replay permutations',async t=>{
  const f=await setup(t);
  const first=await call(f,'intelligence','analyzeMetric',request(f.initialRefs[0],[]));
  const second=await call(f,'intelligence','analyzeMetric',{...request(f.initialRefs[1],[]),windowFamily:'BLIND-PATH-SECOND'});
  const identity={algorithmMajor:'phase4-intelligence-v1',direction:'LOWER',domain:'recovery',metric:'recovery_score',subject:'recovery_score',windowFamily:'BLIND-PATHS'};
  const open={identity,data:{episode_type:'METRIC_DEVIATION'},evidenceItemId:first.item.row.evidence_item_id,semanticAt:T};
  const opened=await call(f,'episodes','open',open);
  const req={prior:{episodeId:opened.row.episode_id,expectedRevision:1,sourceRefs:[first.item.ref,second.item.ref]},
    opposite:{...open,identity:{...identity,direction:'HIGHER'}},semanticAt:T,
    'prior/sourceRefs':[2,1],'prior~1sourceRefs':[4,3],'prior/*/sourceRefs':[6,5]};
  const reversed=await call(f,'episodes','reverse',req);
  const receipt=(await f.db.raw.execute("SELECT * FROM phase4_operation_receipts WHERE operation_kind='EPISODE_REVERSE'")).rows[0];
  const sealed=JSON.parse(receipt.request_json).request;
  for(const key of ['prior/sourceRefs','prior~1sourceRefs','prior/*/sourceRefs'])assert.deepEqual(sealed[key],req[key],key);
  const before=await snapshot(f);
  assert.deepEqual(semantic(await call(f,'episodes','reverse',{...req,prior:{...req.prior,sourceRefs:[...req.prior.sourceRefs].reverse()}})),semantic(reversed));
  assert.deepEqual(await snapshot(f),before);assert.equal(await leases(f),0);
});
