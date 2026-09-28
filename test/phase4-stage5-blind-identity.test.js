import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture,snapshot } from './stage5M007Fixture.js';
import { preBlindStores } from './stage5BlindFixture.js';
import { call } from './stage5ClosureFixture.js';
import { semantic,leases,T } from './stage5ReviewBFixture.js';

test('BF-M03/M007: normalize identity once; preserve genuine Unicode logical keys across cutover and succession',async t=>{
  const {f,direct,evidenceId}=await fixture(t,{retired:false}),legacy={...f,stores:await preBlindStores(t,f)};
  // NFC followed by lowercase is not universally idempotent: uppercase J +
  // caron lowercases to a sequence that a second NFC pass would compose.
  const req=direct(T,'unicode-original');req.identity={...req.identity,subject:'J\u030c'};
  const original=await call(legacy,'insights','create',req),before=await snapshot(f);
  assert.deepEqual(semantic(await call(f,'insights','create',req)),semantic(original));
  await assert.rejects(call(f,'insights','create',{...req,creationKey:'unicode-successor'}),/INSIGHT_INCARNATION_INVALID/);
  assert.deepEqual(await snapshot(f),before);
  await call(f,'insights','transition',{insightId:original.row.id,expectedRevision:1,status:'RETIRED',disposition:'REJECTED',
    claim:original.row.statement,supportingEvidenceIds:[evidenceId],reason:'REJECTED',semanticAt:T});
  const successor=await call(f,'insights','create',{...req,creationKey:'unicode-successor'});
  assert.equal(successor.row.supersedes_id,original.row.id);assert.equal(successor.row.insight_key,original.row.insight_key);
  const after=await snapshot(f);
  assert.deepEqual(semantic(await call(f,'insights','create',{...req,creationKey:'unicode-successor',identity:{...req.identity,subject:'  J\u030c  '}})),semantic(successor));
  assert.deepEqual(await snapshot(f),after);assert.equal(await leases(f),0);
});
