// R4: real local libSQL/orchestration, synthetic health data and fake networks only.
// Races use explicit barriers or awaited hooks, never timing sleeps.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createDb } from '../src/db.js';
import { createTelegram } from '../src/telegram.js';
import { withDeliveryAuthorization, LIFECYCLE_UNFENCED, LifecycleContextError } from '../src/accountLifecycle.js';
import { checkAndAct } from '../src/proactiveAgent.js';
import { runForUser } from '../src/index.js';
import { runHealthspanSnapshot } from '../src/healthspanEngine.js';
import { runPredictionCycle } from '../src/predictionPipeline.js';
import { lifecycleOutputDb } from '../src/lifecycleOutput.js';
import { HEAVY_OUTPUT_WRITERS } from '../src/analyticsWorker.js';
import { probeCapabilities } from '../src/capabilities.js';
import { SCHEMA_VERSION } from '../src/schema.js';
import { seedSingleUser, seedAliceAndBob, seedHealthData } from './users.js';
import { seedCalmBaseline, seedOneDay, calmValue } from './r4-health.fixture.js';

const NOW = new Date('2026-02-07T08:00:00Z');
const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
async function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whoop-r4-'));
  const url = `file:${path.join(dir, 'db.sqlite')}`;
  const db = createDb({ url });
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  await db.migrate();
  const user = await seedSingleUser(db, { probed: false });
  return { db, user, dir, url };
}
async function transition(db, uid, aba = true) {
  await db.transitionUserLifecycle({ userId: uid, targetStatus: 'DISABLED' });
  if (aba) await db.transitionUserLifecycle({ userId: uid, targetStatus: 'ACTIVE' });
}
const barrier = () => {
  let enter, release;
  return { entered: new Promise((r) => { enter = r; }), enter,
    resume: new Promise((r) => { release = r; }), release };
};
const count = async (db, table, uid) => Number((await db.raw.execute({
  sql: `SELECT COUNT(*) n FROM ${table} WHERE user_id = ?`, args: [uid],
})).rows[0].n);
function transport(db, uid, life, sent, extraAuthorize = async () => {}) {
  return withDeliveryAuthorization(createTelegram({
    db, errorScope: `user:${uid}`, botToken: 'test-only', chatId: uid,
    fetchImpl: async () => { sent.push(uid); return new Response(JSON.stringify({ ok: true, result: { message_id: sent.length } })); },
  }), async () => {
    await extraAuthorize();
    return db.assertAccountActive(uid, life).then(() => true, () => false);
  }, { userId: uid, expectedLifecycleGeneration: life });
}

for (const aba of [false, true]) test(`ERR-R4-0${aba ? 2 : 1}: final error send rejects ${aba ? 'ABA' : 'disable'} after cooldown reservation`, async (t) => {
  const { db, user } = await setup(t); const sent = [];
  const view = { ...db, claimErrorNotifyOwned: async (...args) => {
    const claim = await db.claimErrorNotifyOwned(...args);
    assert.equal(claim.granted, true);
    await transition(db, user.id, aba);
    return claim;
  } };
  const result = await transport(view, user.id, 1, sent).notifyError('health', 'synthetic error');
  assert.equal(result.suppressed, 'ACCOUNT_INACTIVE');
  assert.deepEqual(sent, []);
  const rows = await db.raw.execute('SELECT * FROM error_notifications');
  assert.equal(rows.rows.length, 0, 'stale reservation released');
});

test('ERR-R4-03/04: fresh L3 can reserve while old L1 is paused; stale release cannot delete fresh cooldown', async (t) => {
  const { db, user } = await setup(t); const sent = []; const gate = barrier();
  const oldDb = { ...db, claimErrorNotifyOwned: async (...args) => {
    const claim = await db.claimErrorNotifyOwned(...args); gate.enter(); await gate.resume; return claim;
  } };
  const old = transport(oldDb, user.id, 1, sent).notifyError('health', 'old');
  await gate.entered;
  await transition(db, user.id);
  assert.equal(await transport(db, user.id, 3, sent).notifyError('health', 'fresh'), true);
  gate.release();
  assert.equal((await old).suppressed, 'ACCOUNT_INACTIVE');
  assert.equal(await transport(db, user.id, 3, sent).notifyError('health', 'repeat'), false);
  assert.deepEqual(sent, [user.id]);
  assert.equal(Number((await db.raw.execute('SELECT lifecycle_generation FROM error_notifications')).rows[0].lifecycle_generation), 3);
});

test('ERR-R4-04/05 + isolation: same life and global operator alerts work; Alice cannot consume Bob cooldown', async (t) => {
  const { db } = await setup(t); const { alice, bob } = await seedAliceAndBob(db); const sent = [];
  assert.equal(await transport(db, alice.id, 1, sent).notifyError('health', 'test'), true);
  await transition(db, alice.id, false);
  assert.equal(await transport(db, bob.id, 1, sent).notifyError('health', 'test'), true);
  const operator = createTelegram({ db, botToken: 'test', chatId: 'operator', fetchImpl: async () => {
    sent.push('operator'); return new Response(JSON.stringify({ ok: true, result: { message_id: 3 } }));
  } });
  assert.equal(await operator.notifyError('infra', 'test'), true);
  assert.deepEqual(sent, [alice.id, bob.id, 'operator']);
});

async function proactiveSetup(t) {
  const e = await setup(t);
  // Seed explicit, captured-life capability evidence and historical observations.
  await e.db.saveCapabilities(e.user.id, [{ key: 'hrv', status: 'SUPPORTED' }], { expectedLifecycleGeneration: 1 });
  await seedCalmBaseline(e.db, e.user, 35);
  await seedOneDay(e.db, e.user, 35, { ...calmValue(35), hrv: 15 });
  const ctx = { db: e.db, userId: e.user.id, timezone: e.user.timezone, chatId: e.user.chatId };
  await checkAndAct({ ...ctx, expectedLifecycleGeneration: 1, now: new Date('2026-02-06T08:00:00Z') });
  await seedOneDay(e.db, e.user, 36, { ...calmValue(36), hrv: 14 });
  return { ...e, ctx };
}

test('PRO-R4-01/03/04/05: L3 overlaps an old ASK claim without cursor consumption; only L3 opens a question', async (t) => {
  const { db, user, ctx } = await proactiveSetup(t); const sent = [];
  const oldGate = barrier(); const freshGate = barrier();
  const oldTelegram = transport(db, user.id, 1, sent, async () => { oldGate.enter(); await oldGate.resume; });
  const old = checkAndAct({ ...ctx, telegram: oldTelegram, expectedLifecycleGeneration: 1, now: NOW });
  await oldGate.entered;
  const before = await db.getProactiveState(user.id);
  await transition(db, user.id);
  const freshTelegram = transport(db, user.id, 3, sent, async () => { freshGate.enter(); await freshGate.resume; });
  // A buggy duplicate path resolves here without reaching transport. Race against
  // completion so the assertion fails immediately instead of hanging on a barrier.
  const fresh = checkAndAct({ ...ctx, telegram: freshTelegram, expectedLifecycleGeneration: 3, now: NOW });
  const reached = await Promise.race([freshGate.entered.then(() => true), fresh.then(() => false)]);
  assert.equal(reached, true, 'fresh lifecycle must reach its own delivery boundary');
  assert.deepEqual(await db.getProactiveState(user.id), before, 'claim alone cannot advance cursor');
  assert.deepEqual(sent, []);
  oldGate.release();
  assert.equal((await old).messageSent, false);
  assert.equal(await db.getOpenPendingQuestion(user.id, { now: NOW }), null);
  freshGate.release();
  assert.equal((await fresh).messageSent, true);
  const question = await db.getOpenPendingQuestion(user.id, { now: NOW });
  assert.equal(question.context.lifecycle_generation, 3);
  assert.equal((await db.getProactiveState(user.id)).lifecycleGeneration, 3);
  assert.deepEqual(sent, [user.id]);
  assert.equal((await checkAndAct({ ...ctx, telegram: freshTelegram, expectedLifecycleGeneration: 3, now: NOW })).reason, 'no_new_or_changed_data');
});

test('PRO-R4-02/03/04: old suppression releases its claim; fresh retry still asks with no invisible state', async (t) => {
  const { db, user, ctx } = await proactiveSetup(t); const sent = [];
  const telegram = transport(db, user.id, 1, sent, () => transition(db, user.id));
  const old = await checkAndAct({ ...ctx, telegram, expectedLifecycleGeneration: 1, now: NOW });
  assert.equal(old.messageSent, false);
  assert.equal(old.suppressed, 'stale_lifecycle');
  assert.equal(await db.getOpenPendingQuestion(user.id, { now: NOW }), null);
  assert.equal((await db.getRecentProactiveEvents(user.id, { sinceIso: NOW.toISOString() })).length, 0);
  const fresh = await checkAndAct({ ...ctx, telegram: transport(db, user.id, 3, sent), expectedLifecycleGeneration: 3, now: NOW });
  assert.equal(fresh.decision, 'ASK_CONTEXT');
  assert.equal(fresh.messageSent, true);
});

test('PRO-R4-06: fresh L3 NOTIFY preserves a current open question, settles sent marker and cursor', async (t) => {
  const { db, user, ctx } = await proactiveSetup(t); const sent = [];
  await transition(db, user.id);
  const questionId = await db.openPendingQuestion(user.id, { chatId: user.chatId, question: 'test', ttlMs: 3600000 }, { now: NOW });
  const fresh = await checkAndAct({ ...ctx, telegram: transport(db, user.id, 3, sent), expectedLifecycleGeneration: 3, now: NOW });
  assert.equal(fresh.decision, 'NOTIFY'); assert.equal(fresh.messageSent, true);
  assert.equal((await db.getOpenPendingQuestion(user.id, { now: NOW })).id, questionId);
  const events = await db.getRecentProactiveEvents(user.id, { sinceIso: NOW.toISOString() });
  assert.equal(events[0].lifecycleGeneration, 3); assert.ok(events[0].sentAt);
  assert.equal(events[0].outcome, 'DELIVERED');
});

test('PRO-R4 ownership: a delivered L1 pending question and cursor are not current after ABA; Bob unaffected', async (t) => {
  const { db, user, ctx } = await proactiveSetup(t); const sent = [];
  await checkAndAct({ ...ctx, telegram: transport(db, user.id, 1, sent), expectedLifecycleGeneration: 1, now: NOW });
  await transition(db, user.id);
  assert.equal(await db.getOpenPendingQuestion(user.id, { now: NOW }), null);
  const bob = await seedSingleUser(db, { id: 'bob', chatId: '9002' });
  await seedCalmBaseline(db, bob, 35);
  const result = await checkAndAct({ db, userId: bob.id, timezone: bob.timezone, expectedLifecycleGeneration: 1, now: NOW });
  assert.equal(result.triggered, true);
  assert.equal((await db.getProactiveState(bob.id)).lifecycleGeneration, 1);
});

function scheduled(db, user, extra = {}) {
  return runForUser({ db, user, now: NOW, env: { dryRun: true }, deps: {
    makeWhoop: () => ({ getAccessToken: async () => 'test' }), makeSource: () => ({}), makeCoach: () => ({}),
    makeTelegram: () => ({ send: async () => ({ messageId: 1 }), notifyError: async () => false }),
    daily: async () => ({}), weekly: async () => ({}), makeSync: () => ({ syncAll: async () => [] }),
    proactive: async () => ({}), reap: async () => 0, ...extra,
  } });
}
for (const aba of [false, true]) test(`ANA-R4-01: ${aba ? 'ABA' : 'disable'} during sync stops every subsequent health stage`, async (t) => {
  const { db, user } = await setup(t); await seedHealthData(db, user, 70); const stages = [];
  const out = await scheduled(db, user, {
    makeSync: () => ({ syncAll: async () => { await transition(db, user.id, aba); return [{ status: 'account_inactive' }]; } }),
    proactive: async () => stages.push('proactive'), predictionCycle: async () => stages.push('prediction'), healthspan: async () => stages.push('healthspan'),
  });
  assert.equal(out.skipped, 'account_inactive'); assert.deepEqual(stages, []);
  assert.equal(await count(db, 'healthspan_snapshots', user.id), 0);
});
for (const aba of [false, true]) test(`ANA-R4-0${aba ? 3 : 2}: healthspan ${aba ? 'ABA' : 'disable'} immediately before persistence writes zero output`, async (t) => {
  const { db, user } = await setup(t); await seedHealthData(db, user, 70); let attempted = 0;
  const out = await scheduled(db, user, { predictionCycle: async () => ({}), healthspan: ({ db: owned, ...args }) => runHealthspanSnapshot({ ...args, db: {
    ...owned, saveHealthspanMetrics: async (...values) => {
      attempted++; await transition(db, user.id, aba); return owned.saveHealthspanMetrics(...values);
    },
  } }) });
  assert.equal(attempted, 1); assert.equal(out.skipped, 'account_inactive');
  assert.equal(await count(db, 'healthspan_metrics', user.id), 0);
  assert.equal(await count(db, 'healthspan_snapshots', user.id), 0);
});

test('ANA-R4-04/05/06: actual prediction pipeline output fence rejects ABA; same-life and fresh L3 outputs succeed', async (t) => {
  const { db, user } = await setup(t); await seedCalmBaseline(db, user, 100);
  for (let i = 0; i < 100; i++) {
    const start = new Date(Date.parse('2026-01-01T00:00:00Z') + i * 86400000).toISOString();
    await db.upsertCycles(user.id, [{ id: `cycle-${i}`, user_id: 999, start,
      end: new Date(Date.parse(start) + 86400000).toISOString(), score_state: 'SCORED', score: { strain: 10 + i % 4 } }]);
  }
  let attempted = 0; let healthspanCalls = 0;
  const out = await scheduled(db, user, {
    predictionCycle: ({ db: owned, ...args }) => runPredictionCycle({ ...args, db: {
      ...owned, savePredictionModel: async (...values) => { attempted++; await transition(db, user.id); return owned.savePredictionModel(...values); },
    } }),
    healthspan: async () => { healthspanCalls++; },
  });
  assert.equal(attempted, 1); assert.equal(out.skipped, 'account_inactive'); assert.equal(healthspanCalls, 0);
  assert.equal(await count(db, 'prediction_models', user.id), 0);
  assert.equal(await count(db, 'prediction_runs', user.id), 0);
  const fresh = await scheduled(db, await db.getUser(user.id));
  assert.equal(fresh.prediction.modelSaved, true); assert.equal(fresh.healthspan.saved, true);
  assert.ok(await count(db, 'prediction_models', user.id)); assert.ok(await count(db, 'healthspan_metrics', user.id));
  const same = await scheduled(db, await db.getUser(user.id));
  assert.equal(same.prediction.modelSaved, true); assert.equal(same.healthspan.saved, true);
});

test('ANA-R4 output authority: all five writers reject stale work and cross-user writes', async (t) => {
  const { db, user } = await setup(t);
  const view = lifecycleOutputDb(db, { userId: user.id, expectedLifecycleGeneration: 1, writers: HEAVY_OUTPUT_WRITERS });
  await transition(db, user.id);
  for (const name of HEAVY_OUTPUT_WRITERS) {
    const args = name === 'recordPredictionActual' ? [{ userId: user.id }] : [user.id, {}];
    await assert.rejects(async () => view[name](...args), { code: 'ACCOUNT_INACTIVE' });
    const other = name === 'recordPredictionActual' ? [{ userId: 'bob' }] : ['bob', {}];
    await assert.rejects(async () => view[name](...other), /lifecycle_output_user_mismatch/);
  }
});

const provider = (last = async () => ({})) => ({ sleeps: async () => [], recoveries: async () => [], cycles: async () => [], workouts: async () => [], bodyMeasurement: last });
for (const reactivate of [false, true]) test(`PROBE-R4-0${reactivate ? 2 : 1}: inactive admin diagnostic ${reactivate ? 'reactivated during provider work' : 'stays inactive'} cannot create evidence`, async (t) => {
  const { db, user } = await setup(t); await transition(db, user.id, false);
  const result = await probeCapabilities({ db, userId: user.id, timezone: user.timezone, now: NOW,
    expectedLifecycleGeneration: LIFECYCLE_UNFENCED, whoop: provider(async () => {
      if (reactivate) await db.transitionUserLifecycle({ userId: user.id, targetStatus: 'ACTIVE' }); return {};
    }),
  });
  assert.ok(result.entries.length); assert.equal(result.persisted, false);
  assert.equal(await count(db, 'whoop_capabilities', user.id), 0);
});

test('PROBE-R4-03/04/05: active evidence uses captured L3, rejects later ABA and rejects absent/admin provenance', async (t) => {
  const { db, user } = await setup(t); await transition(db, user.id);
  await probeCapabilities({ db, userId: user.id, timezone: user.timezone, whoop: provider(), expectedLifecycleGeneration: 3, now: NOW });
  const before = (await db.raw.execute({ sql: 'SELECT * FROM whoop_capabilities WHERE user_id = ? ORDER BY key', args: [user.id] })).rows;
  assert.ok(before.length); assert.ok(before.every((r) => Number(r.lifecycle_generation) === 3));
  await assert.rejects(() => probeCapabilities({ db, userId: user.id, timezone: user.timezone,
    whoop: provider(async () => { await transition(db, user.id); return {}; }), expectedLifecycleGeneration: 3, now: NOW,
  }), { code: 'ACCOUNT_INACTIVE' });
  assert.deepEqual((await db.raw.execute({ sql: 'SELECT * FROM whoop_capabilities WHERE user_id = ? ORDER BY key', args: [user.id] })).rows, before);
  for (const life of [undefined, null, LIFECYCLE_UNFENCED]) {
    await assert.rejects(() => db.saveCapabilities(user.id, [{ key: 'hrv', status: 'SUPPORTED' }], { expectedLifecycleGeneration: life }), LifecycleContextError);
  }
});

test('PROBE-R4 CLI: --allow-inactive prints diagnostic result and creates no evidence even after reactivation', async (t) => {
  const { db, user, dir, url } = await setup(t);
  await db.saveTokens(user.id, { accessToken: 'test-access', refreshToken: 'test-refresh', expiresAt: new Date(Date.now() + 3600000) }, { expectedLifecycleGeneration: 1 });
  await transition(db, user.id, false);
  const result = spawnSync(process.execPath, ['--import', path.join(ROOT, 'test/r4-cli-network.fixture.mjs'), path.join(ROOT, 'scripts/probe-fields.js'), '--user', user.id, '--allow-inactive'], {
    cwd: dir, encoding: 'utf8', timeout: 15000,
    env: { PATH: process.env.PATH, TURSO_DATABASE_URL: url, TURSO_AUTH_TOKEN: 'test', WHOOP_CLIENT_ID: 'test', WHOOP_CLIENT_SECRET: 'test', R4_USER: user.id },
  });
  assert.ifError(result.error); assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /管理診斷完成/);
  assert.equal((await db.getUser(user.id)).lifecycleGeneration, 3);
  assert.equal(await count(db, 'whoop_capabilities', user.id), 0);
});

test('MIG-R4: real v19 schema upgrades to v20 without adopting historical ownership; repeat is idempotent', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whoop-r4-v19-'));
  const db = createDb({ url: `file:${path.join(dir, 'db.sqlite')}` });
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const old = JSON.parse(fs.readFileSync(new URL('./fixtures/schema-v19.json', import.meta.url), 'utf8'));
  for (const sql of old.schema) await db.raw.execute(sql);
  for (const col of old.additive) {
    const columns = (await db.raw.execute(`PRAGMA table_info(${col.table})`)).rows;
    if (!columns.some((c) => c.name === col.column)) await db.raw.execute(col.ddl);
  }
  await db.raw.execute("INSERT INTO schema_version (version, applied_at, note) VALUES (19, '2026-09-16', 'R3')");
  await db.raw.execute("INSERT INTO proactive_agent_state(user_id, last_checked_health_date, last_fingerprint, enabled, updated_at) VALUES ('old', '2026-09-16', 'fp', 0, '2026-09-16')");
  await db.raw.execute("INSERT INTO proactive_events(user_id, health_date, idempotency_key, decision, policy_version, created_at) VALUES ('old', '2026-09-16', 'key', 'ASK_CONTEXT', 'test', '2026-09-16')");
  const migration = await db.migrate(); assert.equal(migration.from, 19); assert.equal(migration.to, 20);
  assert.equal(SCHEMA_VERSION, 20);
  assert.deepEqual(migration.columnsAdded.sort(), ['error_notifications.lifecycle_generation', 'proactive_agent_state.lifecycle_generation', 'proactive_events.lifecycle_generation']);
  assert.equal((await db.getProactiveState('old')).lifecycleGeneration, null);
  assert.equal((await db.getProactiveState('old')).enabled, false);
  assert.equal((await db.getRecentProactiveEvents('old', { sinceIso: '2020' }))[0].lifecycleGeneration, null);
  assert.deepEqual((await db.migrate()).columnsAdded, []);
});
