import test from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './stage5AssociationFixture.js';
import { snapshot } from './stage5M007Fixture.js';
import { guards,leases } from './stage5ReviewBFixture.js';

for(const [name,patch] of Object.entries({
  'self-cycle':{supersedes_coverage_window_id:'coverage-caffeine'},
  'missing-root':{supersedes_coverage_window_id:'missing',revision:2},
  'root-revision':{revision:2},
  'domain':{factor_keys_json:'["not-a-factor"]'},
  'foreign-user-parent':{supersedes_coverage_window_id:'foreign',revision:2},
}))test(`BF-M01: public Journal classifier and typed coverage both reject ${name} without writes`,async t=>{
  const f=await setup(t,{days:2,createFacts:false});await f.stores.release(f.context);
  const row=(await f.db.raw.execute('SELECT * FROM journal_coverage_windows')).rows[0];
  await guards(f,'journal_coverage_windows',async()=>{
    if(name==='foreign-user-parent') {
      const parent={...row,user_id:'b',coverage_window_id:'foreign',privacy_artifact_id:'foreign-artifact',status:'SUPERSEDED'};
      await f.db.raw.execute({sql:`INSERT INTO journal_coverage_windows(${Object.keys(parent).join(',')}) VALUES (${Object.keys(parent).map(()=>'?').join(',')})`,args:Object.values(parent)});
    }
    await f.db.raw.execute({sql:`UPDATE journal_coverage_windows SET ${Object.keys(patch).map(key=>`${key}=?`).join(',')} WHERE user_id='a'`,args:Object.values(patch)});
  });
  const before=await snapshot(f);
  for(const work of [c=>f.stores.journalCoverage.read(c,row.coverage_window_id),c=>f.stores.journal.classify(c,
    {factor:'caffeine',windowStart:row.window_start_utc,windowEnd:row.window_end_utc})]) {
    await assert.rejects(f.stores.withContext('a',{executionMode:'SHADOW'},work),/LINEAGE_INVALID/);
    assert.deepEqual(await snapshot(f),before);assert.equal(await leases(f),0);
  }
});

test('BF-M01: valid typed coverage still authorizes confirmed unexposed classification',async t=>{
  const f=await setup(t,{days:2,createFacts:false});await f.stores.release(f.context);
  await f.stores.withContext('a',{executionMode:'SHADOW'},async c=>{
    const row=await f.stores.journalCoverage.read(c,f.coverageRef.id);
    assert.equal((await f.stores.journal.classify(c,{factor:'caffeine',windowStart:row.window_start_utc,windowEnd:row.window_end_utc})).state,'CONFIRMED_UNEXPOSED');
  });assert.equal(await leases(f),0);
});
