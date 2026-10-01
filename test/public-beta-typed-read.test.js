import test from 'node:test';
import assert from 'node:assert/strict';
import { syntheticPhase4Fixture } from './phase4Fixture.js';
import { bodyInput, seedBodyInput } from './bodyEnergyFixture.js';
import { createPublicBetaPresentation, publicBetaPolicy } from '../src/publicBeta.js';
import { authorizePublicBetaRuntime, createPublicBetaRuntime } from '../src/publicBeta.js';
import { runPhase4Stage6 } from '../src/shadowDrainScheduler.js';

const AT = Date.parse('2026-09-19T00:00:00.000Z');
const date = '2026-09-19';
const args = id => ({ userId: id, healthDate: date, now: new Date(AT) });

test('beta section reads completed current SHADOW Body Energy through receipt-checked public reader', async t => {
  const f = await syntheticPhase4Fixture(t, { targetVersion: 30 });
  const runtimeCapability = authorizePublicBetaRuntime({ executionMode: 'SHADOW' });
  await f.db.transaction(() => seedBodyInput(f.db));
  const b = bodyInput();
  b.userId = 'b';
  for (const rows of Object.values(b.sources)) for (const row of rows) row.user_id = 'b';
  for (const rows of [b.access, b.sync, b.capabilities]) for (const row of rows) row.user_id = 'b';
  b.sources.sleep[0].sleep_performance_percentage = 75;
  await f.db.transaction(() => seedBodyInput(f.db, b));

  const resultIds = {};
  for (const id of ['a', 'b']) {
    const result = await f.stores.withContext(id, { executionMode: 'SHADOW' },
      context => f.stores.bodyEnergy.compute(context, { asOfEpochMs: AT, targetHealthDate: date }));
    resultIds[id] = result.row.result_id;
    const typed = await f.stores.withContext(id, { executionMode: 'SHADOW' },
      context => f.stores.bodyEnergy.readLatestCurrent(context, { healthDate: date, asOfEpochMs: AT }));
    assert.equal(typed.row.result_id, resultIds[id]);
  }
  assert.notEqual(resultIds.a, resultIds.b);
  console.log(JSON.stringify({ syntheticTypedResults: true, executionMode: 'SHADOW', resultIds }));

  const all = createPublicBetaPresentation({ stores: f.stores, policy: publicBetaPolicy({ mode: 'all' }), runtimeCapability });
  const alice = await all.bodyEnergySection(args('a'));
  const bob = await all.bodyEnergySection(args('b'));
  assert.match(alice, /^⚡ 身體能量 \d+\/100$/);
  assert.match(bob, /^⚡ 身體能量 \d+\/100$/);
  assert.notEqual(alice, bob);

  const off = createPublicBetaPresentation({ stores: f.stores, policy: publicBetaPolicy(), runtimeCapability });
  const allow = createPublicBetaPresentation({ stores: f.stores,
    policy: publicBetaPolicy({ mode: 'allowlist', userIds: ['a'] }), runtimeCapability });
  assert.equal(await off.bodyEnergySection(args('a')), null);
  assert.equal(await allow.bodyEnergySection(args('b')), null);
  assert.equal(await allow.bodyEnergySection(args('a')), alice);

  await f.db.raw.execute("DELETE FROM whoop_sleeps WHERE user_id='a' AND id='sleep-00'");
  assert.equal(await all.bodyEnergySection(args('a')), null, 'missing provenance is withheld');
  assert.equal(await all.bodyEnergySection(args('b')), bob, 'other tenant remains readable');
  await f.db.raw.execute("UPDATE body_energy_results SET invalidated_at='2026-09-20T00:00:00Z' WHERE user_id='b'");
  assert.equal(await all.bodyEnergySection(args('b')), null, 'invalidated result is withheld');
});

test('default runner has no worker; explicit SHADOW beta capability admits the approved worker', async t => {
  const f = await syntheticPhase4Fixture(t, { targetVersion: 30 });
  assert.equal((await runPhase4Stage6({ db: f.db })).outcome, 'DISABLED');
  const capability = authorizePublicBetaRuntime({ executionMode: 'SHADOW' });
  const runtime = await createPublicBetaRuntime({ db: f.db, keys: f.keys,
    executionMode: 'SHADOW', runtimeCapability: capability });
  assert.equal(typeof runtime.phase4Stage6.drain, 'function');
  assert.equal(await runtime.betaPresentation.bodyEnergySection(args('a')), null,
    'worker authority does not grant presentation while cohort gate is OFF');
});

test('pending generation and corrupt signed receipt cannot reach beta output', async t => {
  const f = await syntheticPhase4Fixture(t, { targetVersion: 30 });
  const runtimeCapability = authorizePublicBetaRuntime({ executionMode: 'SHADOW' });
  await f.db.transaction(() => seedBodyInput(f.db));
  await f.stores.withContext('a', { executionMode: 'SHADOW' }, context =>
    f.stores.bodyEnergy.compute(context, { asOfEpochMs: AT, targetHealthDate: date }));
  const presentation = createPublicBetaPresentation({ stores: f.stores,
    policy: publicBetaPolicy({ mode: 'allowlist', userIds: ['a'] }), runtimeCapability });
  assert.ok(await presentation.bodyEnergySection(args('a')));
  const guards = (await f.db.raw.execute("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name='phase4_operation_receipts'")).rows;
  for (const guard of guards) await f.db.raw.execute(`DROP TRIGGER ${guard.name}`);
  await f.db.raw.execute("UPDATE phase4_operation_receipts SET receipt_hmac='" + '0'.repeat(64) + "' WHERE user_id='a'");
  for (const guard of guards) await f.db.raw.execute(guard.sql);
  assert.equal(await presentation.bodyEnergySection(args('a')), null, 'corrupt v27 authority is withheld');
  await f.stores.queue.sourceChanged(await f.stores.captureControl('a'), { reasonCode: 'SOURCE_CHANGED' });
  assert.equal(await presentation.bodyEnergySection(args('a')), null, 'pending generation is withheld');
});
