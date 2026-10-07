import test from 'node:test';
import assert from 'node:assert/strict';
import { publicBetaPolicy, authorizePublicBetaRuntime, createPublicBetaRuntime,
  createPublicBetaPresentation } from '../src/publicBeta.js';
import { publicBetaConfiguration, publicBetaKeys, publicBetaKeysIfPresent } from '../src/publicBetaConfig.js';
import { runPublicBetaBriefing } from '../src/publicBetaEntry.js';

const now = new Date('2026-09-19T00:00:00.000Z');
const request = userId => ({ userId, now });
const users = { a: { id: 'a', displayName: 'Alice' }, b: { id: 'b', displayName: 'Bob' },
  c: { id: 'c', displayName: '' } };
const current = id => ({ userId: id, executionMode: 'SHADOW',
  episodes: [{ metricKey: 'recovery_score', direction: id === 'b' ? 'HIGHER' : 'LOWER' }],
  insights: [{ status: 'SUPPORTED', claim: `${id === 'b' ? 'caffeine' : 'alcohol'} has been repeatedly associated in your data with lower recovery_score.` }] });
function fixture(read = context => current(context.userId), locales = { a:'zh-TW', b:'zh-TW', c:'zh-TW' }) {
  const reads = [];
  const stores = { withContext: async (id, mode, work) => {
    reads.push([id, mode.executionMode]); return work({ userId: id }); },
  assertCurrent: async () => true, betaSummary: { readCurrent: read } };
  const db = { getUser: async id => users[id] ?? null, getLocale: async id => locales[id] ?? null };
  const runtimeCapability = authorizePublicBetaRuntime({ executionMode: 'SHADOW' });
  return { reads, presentation: policy => createPublicBetaPresentation({ stores, db, policy, runtimeCapability }) };
}

test('OFF, allowlist and ALL use canonical internal IDs; names never cross users', async () => {
  const f = fixture();
  assert.equal(await f.presentation(publicBetaPolicy()).summary(request('a')), null);
  assert.equal(f.reads.length, 0);
  const allow = f.presentation(publicBetaPolicy({ mode: 'allowlist', userIds: ['a'] }));
  assert.equal(await allow.summary(request('b')), null);
  assert.match(await allow.summary(request('a')), /Beta 摘要（Alice）[\s\S]*飲酒/);
  assert.deepEqual(f.reads, [['a', 'SHADOW']]);
  const all = f.presentation(publicBetaPolicy({ mode: 'all' }));
  assert.match(await all.summary(request('b')), /Beta 摘要（Bob）[\s\S]*咖啡因/);
  assert.match(await all.summary(request('c')), /^🧪 Phase 4 Beta 摘要\n/);
  assert.doesNotMatch(await all.summary(request('c')), /Alice|Bob|Kelvin|身體能量/);
});

test('locale choice never grants Beta eligibility; eligible UNSET users receive no summary', async () => {
  const f = fixture(undefined, { a:'zh-TW', b:'en', c:null });
  const allow = f.presentation(publicBetaPolicy({ mode:'allowlist', userIds:['a','c'] }));
  assert.equal(await allow.summary(request('b')), null);
  assert.equal(await allow.summary(request('c')), null);
  assert.match(await allow.summary(request('a')), /Beta 摘要/);
  const all = f.presentation(publicBetaPolicy({ mode:'all' }));
  assert.match(await all.summary(request('b')), /Beta Summary/);
  assert.equal(await all.summary(request('c')), null);
  assert.equal(await f.presentation(publicBetaPolicy({ mode:'off' })).summary(request('a')), null);
});

test('unavailable, stale, corrupt, ambiguous, redacted, mismatched and Body Energy content stay hidden', async () => {
  const policy = publicBetaPolicy({ mode: 'all' });
  for (const state of ['STALE','REDACTED','CORRUPT','AMBIGUOUS','UNAVAILABLE']) {
    const f = fixture(async () => { throw new Error(state); });
    assert.equal(await f.presentation(policy).summary(request('a')), null, state);
  }
  for (const result of [null, { ...current('b') }, { ...current('a'), executionMode: 'LIVE' },
    { userId: 'a', executionMode: 'SHADOW', episodes: [{ metricKey: 'body_energy', direction: 'HIGHER' }],
      insights: [{ status: 'SUPPORTED', claim: 'body_energy improved' }] }]) {
    const f = fixture(async () => result);
    assert.equal(await f.presentation(policy).summary(request('a')), null);
  }
});

test('runtime and cohort gates remain separate; incomplete keys and LIVE fail closed', async () => {
  assert.equal(publicBetaConfiguration({}).runtime, 'off');
  assert.equal(publicBetaConfiguration({}).mode, 'off');
  assert.throws(() => publicBetaConfiguration({ PHASE4_PUBLIC_BETA_MODE: 'all' }), /RUNTIME_REQUIRED/);
  assert.throws(() => publicBetaConfiguration({ PHASE4_BETA_SHADOW_RUNTIME: 'true' }), /CONFIG_INVALID/);
  assert.throws(() => publicBetaPolicy({ mode: 'allowlist' }), /CONFIG_INVALID/);
  assert.throws(() => publicBetaKeys({}), /KEYS_REQUIRED/);
  await assert.rejects(runPublicBetaBriefing({ environment: {} }), /RUNTIME_OFF/);
  await assert.rejects(runPublicBetaBriefing({ environment: { PHASE4_BETA_SHADOW_RUNTIME: 'on' } }), /EXECUTION_PHASE_INVALID/);
  await assert.rejects(runPublicBetaBriefing({ environment: { PHASE4_BETA_SHADOW_RUNTIME: 'on' },
    request:{requestId:'synthetic-request-0001',phase:'SYNC',triggerSource:'manual',executionMode:'SHADOW',configProof:'a'.repeat(64)} }), /KEYS_REQUIRED/);
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
