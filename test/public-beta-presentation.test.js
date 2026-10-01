import test from 'node:test';
import assert from 'node:assert/strict';
import { publicBetaPolicy, authorizePublicBetaRuntime, createPublicBetaRuntime,
  createPublicBetaPresentation } from '../src/publicBeta.js';
import { publicBetaConfiguration, publicBetaKeys, publicBetaKeysIfPresent } from '../src/publicBetaConfig.js';
import { runPublicBetaBriefing } from '../src/publicBetaEntry.js';

const NOW = new Date('2026-09-19T00:00:00.000Z');
const request = id => ({ userId: id, healthDate: '2026-09-19', now: NOW });

test('OFF, allowlist and ALL bind canonical internal user IDs', async () => {
  const reads = [];
  const stores = {
    withContext: async (id, options, work) => { reads.push([id, options.executionMode]); return work({ userId: id }); },
    bodyEnergy: { readLatestCurrent: async context => ({
      row: { user_id: context.userId, execution_mode: 'SHADOW', health_date: '2026-09-19' },
      calculation: { value: context.userId === 'a' ? 70 : 80 },
    }) },
  };
  const runtimeCapability = authorizePublicBetaRuntime({ executionMode: 'SHADOW' });
  const section = policy => createPublicBetaPresentation({ stores, policy, runtimeCapability });
  assert.equal(await section(publicBetaPolicy()).bodyEnergySection(request('a')), null);
  assert.equal(reads.length, 0);
  const allow = section(publicBetaPolicy({ mode: 'allowlist', userIds: ['a'] }));
  assert.equal(await allow.bodyEnergySection(request('b')), null);
  assert.equal(await allow.bodyEnergySection(request('a')), '⚡ 身體能量 70/100');
  assert.deepEqual(reads, [['a', 'SHADOW']]);
  assert.equal(await section(publicBetaPolicy({ mode: 'all' })).bodyEnergySection(request('b')),
    '⚡ 身體能量 80/100');
  assert.deepEqual(reads.at(-1), ['b', 'SHADOW']);
});

test('typed reader failure, stale/redacted/corrupt/ambiguous/no result and cross-user return all omit', async () => {
  const policy = publicBetaPolicy({ mode: 'all' });
  const runtimeCapability = authorizePublicBetaRuntime({ executionMode: 'SHADOW' });
  for (const state of ['STALE','REDACTED','CORRUPT','AMBIGUOUS','UNAVAILABLE']) {
    const presentation = createPublicBetaPresentation({ policy, runtimeCapability, stores: {
      withContext: async (_id, _mode, work) => work({ userId: 'a' }),
      bodyEnergy: { readLatestCurrent: async () => { throw new Error(state); } },
    } });
    assert.equal(await presentation.bodyEnergySection(request('a')), null, state);
  }
  for (const result of [null, { row: { user_id: 'b', execution_mode: 'SHADOW', health_date: '2026-09-19' },
    calculation: { value: 99 } }, { row: { user_id: 'a', execution_mode: 'LIVE', health_date: '2026-09-19' },
    calculation: { value: 99 } }]) {
    const presentation = createPublicBetaPresentation({ policy, runtimeCapability, stores: {
      withContext: async (_id, _mode, work) => work({ userId: 'a' }),
      bodyEnergy: { readLatestCurrent: async () => result },
    } });
    assert.equal(await presentation.bodyEnergySection(request('a')), null);
  }
});

test('runtime and presentation gates are separate; incomplete keys and LIVE fail closed', async () => {
  assert.equal(publicBetaConfiguration({}).runtime, 'off');
  assert.equal(publicBetaConfiguration({}).mode, 'off');
  assert.throws(() => publicBetaConfiguration({ PHASE4_PUBLIC_BETA_MODE: 'all' }), /RUNTIME_REQUIRED/);
  assert.throws(() => publicBetaConfiguration({ PHASE4_BETA_SHADOW_RUNTIME: 'true' }), /CONFIG_INVALID/);
  assert.throws(() => publicBetaPolicy({ mode: 'allowlist' }), /CONFIG_INVALID/);
  assert.throws(() => publicBetaKeys({}), /KEYS_REQUIRED/);
  await assert.rejects(runPublicBetaBriefing({ environment: {} }), /RUNTIME_OFF/);
  await assert.rejects(runPublicBetaBriefing({ environment: { PHASE4_BETA_SHADOW_RUNTIME: 'on' } }), /KEYS_REQUIRED/);
  assert.equal(publicBetaKeysIfPresent({}), undefined);
  assert.equal(publicBetaKeysIfPresent({ PHASE4_LOOKUP_KEY: '', PHASE4_AUDIT_KEY: '' }), undefined);
  assert.throws(() => publicBetaKeysIfPresent({ PHASE4_LOOKUP_KEY: 'a'.repeat(64) }), /KEYS_REQUIRED/);
  assert.ok(publicBetaKeysIfPresent({ PHASE4_LOOKUP_KEY: 'a'.repeat(64), PHASE4_AUDIT_KEY: 'b'.repeat(64) }));
  assert.throws(() => authorizePublicBetaRuntime({ executionMode: 'LIVE' }), /SHADOW_REQUIRED/);
  assert.throws(() => createPublicBetaPresentation({ stores: {}, policy: publicBetaPolicy(), runtimeCapability: {} }), /CAPABILITY_REQUIRED/);
  const capability = authorizePublicBetaRuntime({ executionMode: 'SHADOW' });
  await assert.rejects(createPublicBetaRuntime({ executionMode: 'LIVE', runtimeCapability: capability }), /CAPABILITY_REQUIRED/);
  await assert.rejects(createPublicBetaRuntime({ executionMode: 'SHADOW', runtimeCapability: {} }), /CAPABILITY_REQUIRED/);
  await assert.rejects(createPublicBetaRuntime({ executionMode: 'SHADOW', runtimeCapability: capability }), /DATABASE_REQUIRED/);
});
