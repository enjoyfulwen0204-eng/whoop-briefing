import test from 'node:test';
import assert from 'node:assert/strict';
import { syntheticPhase4Fixture } from './phase4Fixture.js';
import { bodyInput, seedBodyInput } from './bodyEnergyFixture.js';
import { createPhase4Foundation } from '../src/phase4Foundation.js';

const start = Date.parse('2026-09-25T12:00:00.000Z');
const request = (currentSource, baselineSources, asOfUtc = new Date(start).toISOString()) => ({
  metricKey: 'recovery_score', currentSource, baselineSources, asOfUtc, windowFamily: 'DAILY_RECOVERY',
});
async function recoveryRefs(stores, context, ids) {
  const refs = [];
  for (const id of ids) refs.push((await stores.root(context, 'recovery', id)).ref);
  return refs;
}

async function setup(t) {
  let now = new Date(start);
  const fixture = await syntheticPhase4Fixture(t, { now: () => now });
  const input = bodyInput({ asOf: start, days: 30 });
  for (let index = 0; index < input.sources.recovery.length; index += 1) {
    input.sources.recovery[index].recovery_score = index === 0 ? 15 : [40, 45, 50, 55, 60][(index - 1) % 5];
  }
  await fixture.db.transaction(() => seedBodyInput(fixture.db, input));
  const context = await fixture.stores.capture('a', { executionMode: 'SHADOW' });
  const recoveryIds = input.sources.recovery.map(row => row.sleep_id);
  const refs = await recoveryRefs(fixture.stores, context, recoveryIds);
  return { ...fixture, context, currentSource: refs[0], baselineSources: refs.slice(1),
    recoveryIds,
    setNow(value) { now = new Date(value); } };
}

test('Metric analysis persists completed traceable evidence before one OPEN episode and semantic event', async t => {
  const f = await setup(t), result = await f.stores.intelligence.analyzeMetric(f.context, request(f.currentSource, f.baselineSources));
  assert.equal(result.baseline.sampleCount, 30);
  assert.equal(result.baseline.median, 50);
  assert.equal(result.quality.status, 'AVAILABLE');
  assert.equal(result.calculation.classification, 'NEW_CHANGE');
  assert.equal(result.calculation.severeSingle, true);
  assert.equal(result.run.row.state, 'COMPLETED');
  assert.equal(result.run.row.method, 'PERSONAL_BASELINE_DEVIATION');
  assert.equal(result.item.row.causal_status, 'ASSOCIATION_ONLY');
  assert.equal(result.item.row.direction, 'LOWER');
  assert.equal(result.episode.episode.row.state, 'OPEN');
  assert.equal(result.episode.episode.row.execution_mode, 'SHADOW');
  assert.ok(result.episode.episode.row.last_semantic_event_id);
  const counts = (await f.db.raw.execute(`SELECT
    (SELECT count(*) FROM evidence_runs) runs,(SELECT count(*) FROM evidence_items) items,
    (SELECT count(*) FROM observation_episodes) episodes,(SELECT count(*) FROM episode_observations) observations,
    (SELECT count(*) FROM episode_evidence) links,(SELECT count(*) FROM episode_events) events,
    (SELECT count(*) FROM episode_semantic_events) semantic`)).rows[0];
  assert.deepEqual(counts, { runs: 1, items: 1, episodes: 1, observations: 1, links: 1, events: 1, semantic: 1 });
  assert.equal((await f.db.raw.execute('SELECT count(*) n FROM outbound_messages')).rows[0].n, 0);
  assert.equal((await f.db.raw.execute('SELECT count(*) n FROM phase4_proactive_decisions')).rows[0].n, 0);
});

test('Exact replay converges on the same evidence, episode, observation and semantic identities', async t => {
  const f = await setup(t), input = request(f.currentSource, f.baselineSources);
  const first = await f.stores.intelligence.analyzeMetric(f.context, input);
  const second = await f.stores.intelligence.analyzeMetric(f.context, input);
  assert.equal(second.run.row.run_id, first.run.row.run_id);
  assert.equal(second.item.row.evidence_item_id, first.item.row.evidence_item_id);
  assert.equal(second.episode.episode.row.episode_id, first.episode.episode.row.episode_id);
  assert.equal(second.episode.replayed, true);
  assert.equal(second.episode.episode.row.revision, 1);
  for (const table of ['evidence_runs', 'evidence_items', 'observation_episodes', 'episode_observations',
    'episode_evidence', 'episode_events', 'episode_semantic_events']) {
    assert.equal((await f.db.raw.execute(`SELECT count(*) n FROM ${table}`)).rows[0].n, 1, table);
  }
});

test('Concurrent exact replay has one durable winner for every logical artifact', async t => {
  const f = await setup(t), input = request(f.currentSource, f.baselineSources);
  const results = await Promise.all([f.stores.intelligence.analyzeMetric(f.context, input),
    f.stores.intelligence.analyzeMetric(f.context, input)]);
  assert.equal(results[0].run.row.run_id, results[1].run.row.run_id);
  assert.equal(results[0].item.row.evidence_item_id, results[1].item.row.evidence_item_id);
  assert.equal(results[0].episode.episode.row.episode_id, results[1].episode.episode.row.episode_id);
  for (const table of ['evidence_runs', 'evidence_items', 'observation_episodes', 'episode_observations',
    'episode_evidence', 'episode_events', 'episode_semantic_events'])
    assert.equal((await f.db.raw.execute(`SELECT count(*) n FROM ${table}`)).rows[0].n, 1, table);
});

test('A new qualifying observation extends the same family instead of opening a duplicate episode', async t => {
  const f = await setup(t), first = await f.stores.intelligence.analyzeMetric(f.context, request(f.currentSource, f.baselineSources));
  const nextAt = '2026-09-26T10:00:00.000Z'; f.setNow('2026-09-26T12:00:00.000Z');
  await f.db.raw.execute({ sql: `INSERT INTO whoop_recoveries(user_id,sleep_id,health_date,score_state,recovery_score,
    hrv_rmssd_milli,resting_heart_rate,user_calibrating,updated_at,synced_at) VALUES ('a','next-low','2026-09-26','SCORED',10,50,60,0,?,?)`,
  args: [nextAt, '2026-09-26T12:00:00.000Z'] });
  const context = await f.stores.capture('a', { executionMode: 'SHADOW' });
  const refs = await recoveryRefs(f.stores, context, ['next-low', ...f.recoveryIds.slice(0, 30)]);
  const second = await f.stores.intelligence.analyzeMetric(context, request(refs[0], refs.slice(1), '2026-09-26T12:00:00.000Z'));
  assert.equal(second.episode.episode.row.episode_id, first.episode.episode.row.episode_id);
  assert.equal(second.episode.episode.row.state, 'UPDATING');
  assert.equal(second.episode.episode.row.revision, 2);
  assert.equal((await f.db.raw.execute('SELECT count(*) n FROM observation_episodes')).rows[0].n, 1);
  assert.equal((await f.db.raw.execute('SELECT count(*) n FROM episode_observations')).rows[0].n, 2);
  assert.equal((await f.db.raw.execute('SELECT count(*) n FROM episode_semantic_events')).rows[0].n, 1,
    'continuation alone is not semantic novelty');
});

test('Close-threshold evidence stabilizes and only a 24-hour hold resolves an episode', async t => {
  const f = await setup(t), opened = await f.stores.intelligence.analyzeMetric(f.context, request(f.currentSource, f.baselineSources));
  const normalAt = '2026-09-26T10:00:00.000Z'; f.setNow('2026-09-26T12:00:00.000Z');
  await f.db.raw.execute({ sql: `INSERT INTO whoop_recoveries(user_id,sleep_id,health_date,score_state,recovery_score,
    hrv_rmssd_milli,resting_heart_rate,user_calibrating,updated_at,synced_at) VALUES ('a','normal','2026-09-26','SCORED',50,50,60,0,?,?)`,
  args: [normalAt, '2026-09-26T12:00:00.000Z'] });
  let context = await f.stores.capture('a', { executionMode: 'SHADOW' });
  let refs = await recoveryRefs(f.stores, context, ['normal', ...f.recoveryIds.slice(0, 30)]);
  const stabilizing = await f.stores.intelligence.analyzeMetric(context,
    request(refs[0], refs.slice(1), '2026-09-26T12:00:00.000Z'));
  assert.equal(stabilizing.calculation.classification, 'IMPROVING');
  assert.equal(stabilizing.episode.episode.row.state, 'STABILIZING');
  assert.equal(stabilizing.episode.episode.row.resolved_at, null);
  f.setNow('2026-09-27T12:00:00.000Z');
  context = await f.stores.capture('a', { executionMode: 'SHADOW' });
  refs = await recoveryRefs(f.stores, context, ['normal', ...f.recoveryIds.slice(0, 30)]);
  const resolved = await f.stores.intelligence.analyzeMetric(context,
    request(refs[0], refs.slice(1), '2026-09-27T12:00:00.000Z'));
  assert.equal(resolved.calculation.classification, 'RESOLVED');
  assert.equal(resolved.episode.episode.row.state, 'RESOLVED');
  assert.equal(resolved.episode.episode.row.resolution_reason, 'RESOLUTION_HOLD');
  assert.equal(resolved.episode.episode.row.episode_id, opened.episode.episode.row.episode_id);
  assert.equal((await f.db.raw.execute('SELECT count(*) n FROM episode_observations')).rows[0].n, 2,
    'same canonical normal observation is a member only once across reevaluation');
});

test('A qualified opposite direction atomically resolves the old episode and opens one linked reversal', async t => {
  const f = await setup(t), opened = await f.stores.intelligence.analyzeMetric(f.context, request(f.currentSource, f.baselineSources));
  f.setNow('2026-09-26T12:00:00.000Z');
  await f.db.raw.execute({ sql: `INSERT INTO whoop_recoveries(user_id,sleep_id,health_date,score_state,recovery_score,
    hrv_rmssd_milli,resting_heart_rate,user_calibrating,updated_at,synced_at) VALUES ('a','opposite-high','2026-09-26','SCORED',90,50,60,0,?,?)`,
  args: ['2026-09-26T10:00:00.000Z', '2026-09-26T12:00:00.000Z'] });
  const context = await f.stores.capture('a', { executionMode: 'SHADOW' });
  const refs = await recoveryRefs(f.stores, context, ['opposite-high', ...f.recoveryIds.slice(0, 30)]);
  const reversed = await f.stores.intelligence.analyzeMetric(context,
    request(refs[0], refs.slice(1), '2026-09-26T12:00:00.000Z'));
  assert.equal(reversed.calculation.classification, 'DIRECTION_REVERSAL');
  assert.equal(reversed.episode.episode.row.state, 'OPEN');
  assert.equal(reversed.episode.episode.row.direction, 'HIGHER');
  assert.equal(reversed.episode.episode.row.reverses_episode_id, opened.episode.episode.row.episode_id);
  const prior = (await f.db.raw.execute({ sql: 'SELECT * FROM observation_episodes WHERE episode_id=?', args: [opened.episode.episode.row.episode_id] })).rows[0];
  assert.equal(prior.state, 'RESOLVED');
  assert.equal(prior.resolution_reason, 'DIRECTION_REVERSAL');
  assert.equal((await f.db.raw.execute("SELECT count(*) n FROM observation_episodes WHERE state IN ('OPEN','UPDATING','ESCALATED','EXPLAINED','STABILIZING')")).rows[0].n, 1);
});

test('A qualified recurrence within seven days opens a linked episode without mutating resolved history', async t => {
  const f = await setup(t), opened = await f.stores.intelligence.analyzeMetric(f.context, request(f.currentSource, f.baselineSources));
  const originalId = opened.episode.episode.row.episode_id;
  f.setNow('2026-09-26T12:00:00.000Z');
  await f.db.raw.execute({ sql: `INSERT INTO whoop_recoveries(user_id,sleep_id,health_date,score_state,recovery_score,
    hrv_rmssd_milli,resting_heart_rate,user_calibrating,updated_at,synced_at) VALUES ('a','normal-reopen','2026-09-26','SCORED',50,50,60,0,?,?)`,
  args: ['2026-09-26T10:00:00.000Z', '2026-09-26T12:00:00.000Z'] });
  let context = await f.stores.capture('a', { executionMode: 'SHADOW' });
  let refs = await recoveryRefs(f.stores, context, ['normal-reopen', ...f.recoveryIds.slice(0, 30)]);
  await f.stores.intelligence.analyzeMetric(context, request(refs[0], refs.slice(1), '2026-09-26T12:00:00.000Z'));
  f.setNow('2026-09-27T12:00:00.000Z');
  context = await f.stores.capture('a', { executionMode: 'SHADOW' });
  refs = await recoveryRefs(f.stores, context, ['normal-reopen', ...f.recoveryIds.slice(0, 30)]);
  const resolved = await f.stores.intelligence.analyzeMetric(context,
    request(refs[0], refs.slice(1), '2026-09-27T12:00:00.000Z'));
  assert.equal(resolved.episode.episode.row.state, 'RESOLVED');
  f.setNow('2026-09-28T12:00:00.000Z');
  await f.db.raw.execute({ sql: `INSERT INTO whoop_recoveries(user_id,sleep_id,health_date,score_state,recovery_score,
    hrv_rmssd_milli,resting_heart_rate,user_calibrating,updated_at,synced_at) VALUES ('a','recur-low','2026-09-28','SCORED',10,50,60,0,?,?)`,
  args: ['2026-09-28T10:00:00.000Z', '2026-09-28T12:00:00.000Z'] });
  context = await f.stores.capture('a', { executionMode: 'SHADOW' });
  refs = await recoveryRefs(f.stores, context, ['recur-low', ...f.recoveryIds.slice(0, 30)]);
  const recurrence = await f.stores.intelligence.analyzeMetric(context,
    request(refs[0], refs.slice(1), '2026-09-28T12:00:00.000Z'));
  assert.notEqual(recurrence.episode.episode.row.episode_id, originalId);
  assert.equal(recurrence.episode.episode.row.reopens_episode_id, originalId);
  assert.equal(recurrence.episode.episode.row.state, 'OPEN');
  assert.equal((await f.db.raw.execute({ sql: 'SELECT state,revision FROM observation_episodes WHERE episode_id=?',
    args: [originalId] })).rows[0].state, 'RESOLVED');
});

test('Episode expiry is explicit, auditable, and cannot happen before its registered boundary', async t => {
  const f = await setup(t), opened = await f.stores.intelligence.analyzeMetric(f.context, request(f.currentSource, f.baselineSources)),
    id = opened.episode.episode.row.episode_id;
  await assert.rejects(f.stores.intelligence.expireEpisode(f.context, { episodeId: id }), /NOT_EXPIRED/);
  f.setNow(new Date(Date.parse(opened.episode.episode.row.expires_at) + 1).toISOString());
  const fresh = await f.stores.capture('a', { executionMode: 'SHADOW' });
  const expired = await f.stores.intelligence.expireEpisode(fresh, { episodeId: id });
  assert.equal(expired.row.state, 'EXPIRED');
  const event = (await f.db.raw.execute("SELECT * FROM episode_events WHERE reason='WINDOW_EXPIRED'")).rows[0];
  assert.equal(event.from_state, 'OPEN');
  assert.equal(event.to_state, 'EXPIRED');
});

test('Canonical values are derived from branded source snapshots; cross-user and forged references fail closed', async t => {
  const f = await setup(t), other = await f.stores.capture('b', { executionMode: 'SHADOW' });
  await assert.rejects(f.stores.intelligence.analyzeMetric(other, request(f.currentSource, f.baselineSources)), /INVALID_SOURCE_REFERENCE/);
  await assert.rejects(f.stores.intelligence.analyzeMetric(f.context, request({ ...f.currentSource }, f.baselineSources)), /INVALID_SOURCE_REFERENCE/);
  await assert.rejects(f.stores.intelligence.analyzeMetric(f.context, { ...request(f.currentSource, f.baselineSources), userId: 'b' }), /ANALYSIS_REQUEST_INVALID/);
  assert.equal((await f.db.raw.execute("SELECT count(*) n FROM evidence_runs WHERE user_id='b'")).rows[0].n, 0);
  assert.equal((await f.db.raw.execute("SELECT count(*) n FROM observation_episodes WHERE user_id='b'")).rows[0].n, 0);
});

test('Public and internal Stage 5 authority is SHADOW-only even though persistence identities remain mode-qualified', async t => {
  const f = await setup(t);
  await f.stores.initializeTenant('a', 'LIVE');
  const live = await f.stores.capture('a', { executionMode: 'LIVE' });
  const liveRefs = [];
  for (let index = 0; index <= 30; index += 1) liveRefs.push((await f.stores.root(live, 'recovery', `sleep-${String(index).padStart(2, '0')}`)).ref);
  await assert.rejects(f.stores.intelligence.analyzeMetric(live, request(liveRefs[0], liveRefs.slice(1))), /SHADOW_ONLY/);
  const publicStores = await createPhase4Foundation({ db: f.db, keys: f.keys, now: () => new Date(start) });
  await assert.rejects(publicStores.capture('a', { executionMode: 'LIVE' }), /LIVE_NOT_AUTHORIZED/);
  assert.equal((await f.db.raw.execute("SELECT count(*) n FROM evidence_runs WHERE execution_mode='LIVE'")).rows[0].n, 0);
  assert.equal((await f.db.raw.execute("SELECT count(*) n FROM observation_episodes WHERE execution_mode='LIVE'")).rows[0].n, 0);
});

test('Lifecycle, auth, input and purge generation changes fence stale analysis before commit', async t => {
  await t.test('lifecycle ABA', async t => {
    const f = await setup(t); await f.db.transitionUserLifecycle({ userId: 'a', targetStatus: 'DISABLED' });
    await f.db.transitionUserLifecycle({ userId: 'a', targetStatus: 'ACTIVE' });
    await assert.rejects(f.stores.intelligence.analyzeMetric(f.context, request(f.currentSource, f.baselineSources)), /LIFECYCLE_FENCED/);
    assert.equal((await f.db.raw.execute('SELECT count(*) n FROM evidence_runs')).rows[0].n, 0);
  });
  await t.test('auth generation', async t => {
    const f = await setup(t); await f.db.raw.execute("UPDATE user_whoop_tokens SET auth_generation=2 WHERE user_id='a'");
    await assert.rejects(f.stores.intelligence.analyzeMetric(f.context, request(f.currentSource, f.baselineSources)), /AUTH_FENCED/);
    assert.equal((await f.db.raw.execute('SELECT count(*) n FROM evidence_runs')).rows[0].n, 0);
  });
  await t.test('input generation', async t => {
    const f = await setup(t); await f.db.raw.execute("UPDATE phase4_computation_state SET input_generation=input_generation+1 WHERE user_id='a' AND execution_mode='SHADOW'");
    await assert.rejects(f.stores.intelligence.analyzeMetric(f.context, request(f.currentSource, f.baselineSources)), /INPUT_FENCED/);
    assert.equal((await f.db.raw.execute('SELECT count(*) n FROM evidence_runs')).rows[0].n, 0);
  });
  await t.test('purge generation', async t => {
    const f = await setup(t); await f.db.raw.execute("UPDATE phase4_user_state SET purge_generation=purge_generation+1,pending_purge_count=1 WHERE user_id='a'");
    await assert.rejects(f.stores.intelligence.analyzeMetric(f.context, request(f.currentSource, f.baselineSources)), /PURGE_FENCED/);
    assert.equal((await f.db.raw.execute('SELECT count(*) n FROM evidence_runs')).rows[0].n, 0);
  });
});

test('Invalid, future, unsupported, unscored and mismatched canonical inputs cannot become evidence', async t => {
  const f = await setup(t);
  await assert.rejects(f.stores.intelligence.analyzeMetric(f.context, { ...request(f.currentSource, f.baselineSources), metricKey: 'raw_hr' }), /METRIC_UNREGISTERED/);
  await assert.rejects(f.stores.intelligence.analyzeMetric(f.context, request(f.currentSource, f.baselineSources, '2026-09-26T00:00:00.000Z')), /ANALYSIS_REQUEST_INVALID/);
  const sleep = (await f.stores.root(f.context, 'sleep', 'sleep-00')).ref;
  await assert.rejects(f.stores.intelligence.analyzeMetric(f.context, request(sleep, f.baselineSources)), /METRIC_SOURCE_MISMATCH/);
  await f.db.raw.execute("UPDATE whoop_recoveries SET score_state='PENDING_SCORE' WHERE user_id='a' AND sleep_id='sleep-00'");
  await assert.rejects(f.stores.intelligence.analyzeMetric(f.context, request(f.currentSource, f.baselineSources)), /PARENT_STALE|METRIC_SOURCE_INVALID/);
  assert.equal((await f.db.raw.execute('SELECT count(*) n FROM evidence_runs')).rows[0].n, 0);
});

test('A canonical revision ingested after the requested as-of cannot leak into historical evidence', async t => {
  const f = await setup(t);
  f.setNow('2026-09-25T14:00:00.000Z');
  await f.db.raw.execute("UPDATE whoop_recoveries SET updated_at='2026-09-25T13:00:00.000Z',synced_at='2026-09-25T13:00:00.000Z' WHERE user_id='a' AND sleep_id='sleep-00'");
  const context = await f.stores.capture('a', { executionMode: 'SHADOW' });
  const refs = await recoveryRefs(f.stores, context, f.recoveryIds);
  await assert.rejects(f.stores.intelligence.analyzeMetric(context,
    request(refs[0], refs.slice(1), '2026-09-25T12:00:00.000Z')), /METRIC_SOURCE_INVALID/);
  assert.equal((await f.db.raw.execute('SELECT count(*) n FROM evidence_runs')).rows[0].n, 0);
});
