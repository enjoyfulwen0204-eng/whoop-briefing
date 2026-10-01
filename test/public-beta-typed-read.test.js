import test from 'node:test';
import assert from 'node:assert/strict';
import { syntheticPhase4Fixture } from './phase4Fixture.js';
import { bodyInput, seedBodyInput } from './bodyEnergyFixture.js';
import { setup, request } from './stage5HistoryFixture.js';
import { setup as associationSetup, hypothesis, family } from './stage5AssociationFixture.js';
import { call } from './stage5ClosureFixture.js';
import { createPhase4Stage6, authorizeStage6ShadowWorker } from '../src/phase4Reanalysis.js';
import { createPublicBetaPresentation, publicBetaPolicy } from '../src/publicBeta.js';
import { authorizePublicBetaRuntime, createPublicBetaRuntime } from '../src/publicBeta.js';
import { runPhase4Stage6 } from '../src/shadowDrainScheduler.js';

const AT = Date.parse('2026-09-25T12:00:00.000Z');
const at = new Date(AT);
const capability = authorizePublicBetaRuntime({ executionMode: 'SHADOW' });
const present = f => createPublicBetaPresentation({ stores: f.stores, db: f.db,
  policy: publicBetaPolicy({ mode: 'all' }), runtimeCapability: capability });

test('v30 Body Energy remains a receipt-checked SHADOW result with no publication helper', async t => {
  const f = await syntheticPhase4Fixture(t, { targetVersion: 30, now: () => at });
  await f.db.transaction(() => seedBodyInput(f.db, bodyInput({ asOf: AT, days: 30 })));
  const result = await f.stores.withContext('a', { executionMode: 'SHADOW' },
    context => f.stores.bodyEnergy.compute(context, { asOfEpochMs: AT, targetHealthDate: '2026-09-25' }));
  const typed = await f.stores.withContext('a', { executionMode: 'SHADOW' },
    context => f.stores.bodyEnergy.readLatestCurrent(context,
      { healthDate: '2026-09-25', asOfEpochMs: AT }));
  assert.equal(typed.row.result_id, result.row.result_id);
  assert.equal(present(f).bodyEnergySection, undefined);
  assert.equal(await present(f).summary({ userId: 'a', now: at }), null);
});

test('v30 Beta Summary reads a current episode through the canonical typed and receipt authority after drain', async t => {
  const f = await setup(t, { targetVersion: 30 });
  const initial = await call(f, 'intelligence', 'analyzeMetric',
    { ...request(f.initialRefs[0], f.initialRefs.slice(1), at.toISOString()),
      windowFamily: 'BETA_TYPED_EPISODE' });
  assert.ok(initial.episode);
  const control = await f.stores.captureControl('a');
  await f.stores.queue.sourceChanged(control);
  const worker = await createPhase4Stage6({ db: f.db, keys: f.keys, executionMode: 'SHADOW',
    workerCapability: authorizeStage6ShadowWorker({ executionMode: 'SHADOW' }), now: () => at });
  for (let i = 0; i < 12 && (await worker.diagnostics()).pendingJobs; i++) {
    const drained = await worker.drain({ budget: { maxItemsPerTenant: 32, maxItems: 64 } });
    assert.equal(drained.failedJobs, 0, JSON.stringify(drained));
  }
  assert.equal((await worker.diagnostics()).pendingJobs, 0);
  const summary = await f.stores.withContext('a', { executionMode: 'SHADOW' },
    context => f.stores.betaSummary.readCurrent(context, { asOfUtc: at.toISOString() }));
  assert.ok(summary.episodes.some(item => item.resultId === initial.episode.episode.row.episode_id));
  assert.ok(summary.episodes.every(item => item.metricKey !== 'body_energy'));
  const text = await present(f).summary({ userId: 'a', now: at });
  assert.match(text, /Phase 4 Beta 摘要/);
  assert.match(text, /恢復分數/);
  assert.doesNotMatch(text, /身體能量|Body Energy|EPISODE|RECEIPT/);
  assert.deepEqual((await f.stores.withContext('b', { executionMode: 'SHADOW' },
    context => f.stores.betaSummary.readCurrent(context, { asOfUtc: at.toISOString() }))).episodes, []);
  await f.stores.queue.sourceChanged(await f.stores.captureControl('a'));
  assert.equal(await present(f).summary({ userId: 'a', now: at }), null,
    'pending generation cannot present a previous completed result');
});

test('v30 Beta Summary admits current Journal association claims through typed insight evidence', async t => {
  const f = await associationSetup(t, { days: 30, targetVersion: 30 });
  const analyzed = await call(f, 'intelligence', 'analyzeAssociationFamily',
    family('beta-association', hypothesis(f, Array.from({ length: 30 }, (_, i) => i))));
  assert.ok(analyzed.items[0].insight);
  await f.stores.queue.sourceChanged(await f.stores.captureControl('a'));
  const worker = await createPhase4Stage6({ db: f.db, keys: f.keys, executionMode: 'SHADOW',
    workerCapability: authorizeStage6ShadowWorker({ executionMode: 'SHADOW' }), now: () => at });
  for (let i = 0; i < 16 && (await worker.diagnostics()).pendingJobs; i++) {
    const drained = await worker.drain({ budget: { maxItemsPerTenant: 32, maxItems: 64,
      maxWallMs: 90000, leaseMs: 120000 } });
    assert.equal(drained.failedJobs, 0, JSON.stringify(drained));
  }
  assert.equal((await worker.diagnostics()).pendingJobs, 0);
  const typed = await f.stores.withContext('a', { executionMode: 'SHADOW' },
    context => f.stores.betaSummary.readCurrent(context, { asOfUtc: at.toISOString() }));
  assert.ok(typed.insights.length > 0, JSON.stringify(typed));
  const text = await present(f).summary({ userId: 'a', now: at });
  assert.match(text, /Phase 4 Beta 摘要/);
  assert.doesNotMatch(text, /Body Energy|身體能量|INSIGHT|RECEIPT/);
});

test('default runner has no worker; explicit SHADOW beta capability admits approved worker with cohort OFF', async t => {
  const f = await syntheticPhase4Fixture(t, { targetVersion: 30 });
  assert.equal((await runPhase4Stage6({ db: f.db })).outcome, 'DISABLED');
  const runtime = await createPublicBetaRuntime({ db: f.db, keys: f.keys,
    executionMode: 'SHADOW', runtimeCapability: capability });
  assert.equal(typeof runtime.phase4Stage6.drain, 'function');
  assert.equal(await runtime.betaPresentation.summary({ userId: 'a', now: at }), null);
});
