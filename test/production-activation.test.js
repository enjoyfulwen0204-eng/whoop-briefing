/**
 * V1.2 production activation: canonical webhook drain + automatic FAST reconciliation.
 * Real local libSQL and real production paths; WHOOP is faked only at the network boundary.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createDb } from '../src/db.js';
import {
  runBriefing, runForUser, dueForUser,
} from '../src/index.js';
import { createReconciler } from '../src/reconcile.js';
import { drainWhoopWebhookEvents } from '../src/whoopWebhookProcessor.js';
import { WHOOP_SYNC, WHOOP_RECONCILE } from '../src/config.js';
import { RECONCILE_RESULT, USER_STATUS, WHOOP_EVENT_STATE } from '../src/schema.js';
import { WhoopApiError } from '../src/whoop.js';

const NOW = new Date('2026-09-18T06:00:00.000Z');
const DAY = 86_400_000;
const TZ = 'Asia/Taipei';
const ENV = {
  timezone: TZ, dryRun: true, maxUserConcurrency: 3,
  telegramBotToken: 'test-only', telegramChatId: 'test-only',
  tursoUrl: 'file:test', tursoToken: '', repoLastCommitAt: null,
  whoopClientId: 'test-only', whoopClientSecret: 'test-only',
  openrouterApiKey: 'test-only', openrouterModel: 'test-only',
};
let nextChatId = 760000;

function barrier() {
  let enter;
  let release;
  return {
    entered: new Promise((resolve) => { enter = resolve; }),
    enter,
    resume: new Promise((resolve) => { release = resolve; }),
    release,
  };
}

async function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whoop-production-activation-'));
  const db = createDb({ url: `file:${path.join(dir, 'db.sqlite')}` });
  await db.migrate();
  t.after(() => {
    try { db.close(); } catch { /* already closed */ }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { db, dir };
}

async function addUser(db, {
  id = 'alice', whoopUserId = `whoop-${id}`, chatId = null,
} = {}) {
  await db.createUser({ id, displayName: id, timezone: TZ });
  const privateChatId = chatId ?? String(nextChatId++);
  await db.linkTelegram({ userId: id, chatId: privateChatId });
  await db.saveTokens(id, {
    accessToken: `access-${id}`, refreshToken: `refresh-${id}`,
    expiresAt: new Date('2026-12-31T00:00:00.000Z'),
    scope: 'offline', whoopUserId,
  });
  return db.getUser(id);
}

function schedulerDb(db, { users = [] } = {}) {
  return {
    ...db,
    close: () => {},
    ensureOnboardingDerivedForAll: async () => {},
    listOnboardingInState: async () => [],
    listSchedulableUsers: async () => users,
  };
}

const sleepRecord = (id = 'sleep-1', rr = 15) => ({
  id, user_id: 1, nap: false, score_state: 'SCORED',
  start: '2026-09-17T20:00:00.000Z', end: '2026-09-18T04:00:00.000Z',
  created_at: '2026-09-18T04:05:00.000Z', updated_at: '2026-09-18T05:00:00.000Z',
  score: {
    respiratory_rate: rr,
    stage_summary: {
      total_light_sleep_time_milli: 1,
      total_slow_wave_sleep_time_milli: 1,
      total_rem_sleep_time_milli: 1,
    },
  },
});

async function addEvent(db, {
  whoopUserId = 'whoop-alice', eventType = 'sleep.updated',
  resourceType = 'sleep', resourceId = 'sleep-1', traceId = `trace-${resourceId}`,
} = {}) {
  return db.recordWhoopEvent({
    whoopUserId, eventType, resourceType, resourceId, traceId,
    eventAt: String(NOW.getTime()), now: NOW,
  });
}

function webhookWhoop(routes, calls = []) {
  return async () => ({
    async apiGet(resourcePath) {
      calls.push(resourcePath);
      const result = routes[resourcePath];
      if (result instanceof Error) throw result;
      if (result === undefined) throw new WhoopApiError(`missing ${resourcePath}`, 404);
      return typeof result === 'function' ? result() : result;
    },
    async recoveries() { return []; },
  });
}

async function runScheduler(db, deps = {}, triggerSource = 'cloudflare') {
  return runBriefing({
    now: NOW,
    triggerSource,
    deps: {
      db: schedulerDb(db), env: ENV, maintenanceNow: () => NOW,
      ...deps,
    },
  });
}

test('P1-LIVE-01 canonical scheduler claims and processes a pending webhook event', async (t) => {
  const { db } = await setup(t);
  await addUser(db);
  const event = await addEvent(db);
  const summary = await runScheduler(db, {
    webhookWhoopFor: webhookWhoop({ '/activity/sleep/sleep-1': sleepRecord() }),
  });
  assert.equal(summary.webhookDrain.status, 'completed');
  assert.equal(summary.webhookDrain.claimed, 1);
  assert.equal(summary.webhookDrain.processed, 1);
  assert.equal(summary.webhookDrain.remaining, 0);
  assert.equal((await db.getWhoopEvent(event.id)).state, WHOOP_EVENT_STATE.PROCESSED);
});

test('P1-LIVE-02 pending event drains even when no briefing is due', async (t) => {
  const { db } = await setup(t);
  await addUser(db);
  await addEvent(db);
  const summary = await runScheduler(db, {
    webhookWhoopFor: webhookWhoop({ '/activity/sleep/sleep-1': sleepRecord() }),
  });
  assert.equal(summary.users, 0, 'no schedulable/READY briefing user');
  assert.equal(summary.outcome, 'nothing_due');
  assert.equal(summary.webhookDrain.processed, 1);
});

test('P1-LIVE-03 overlapping Cloudflare/GitHub runs process one event once', async (t) => {
  const { db } = await setup(t);
  await addUser(db);
  await addEvent(db);
  const gate = barrier();
  let providerCalls = 0;
  const whoopFor = async () => ({
    async apiGet() {
      providerCalls += 1;
      gate.enter();
      await gate.resume;
      return sleepRecord();
    },
    async recoveries() { return []; },
  });
  const cloudflare = runScheduler(db, { webhookWhoopFor: whoopFor }, 'cloudflare');
  await gate.entered;
  const github = await runScheduler(db, { webhookWhoopFor: whoopFor }, 'github');
  gate.release();
  const primary = await cloudflare;
  assert.equal(primary.webhookDrain.claimed + github.webhookDrain.claimed, 1);
  assert.equal(providerCalls, 1);
  assert.equal(Number((await db.raw.execute(
    "SELECT COUNT(*) n FROM whoop_webhook_events WHERE state = 'PROCESSED'",
  )).rows[0].n), 1);
});

test('P1-LIVE-04 drain is batch-bounded and preserves remainder', async (t) => {
  const { db } = await setup(t);
  await addUser(db);
  for (let i = 1; i <= 3; i += 1) {
    await addEvent(db, {
      eventType: 'sleep.deleted', resourceId: `sleep-${i}`, traceId: `delete-${i}`,
    });
  }
  const summary = await runScheduler(db, {
    drainWebhook: (args) => drainWhoopWebhookEvents({ ...args, batch: 2 }),
  });
  assert.equal(summary.webhookDrain.claimed, 2);
  assert.equal(summary.webhookDrain.processed, 2);
  assert.equal(summary.webhookDrain.remaining, 1);
  assert.equal(Number((await db.raw.execute(
    "SELECT COUNT(*) n FROM whoop_webhook_events WHERE state = 'RECEIVED'",
  )).rows[0].n), 1);
});

test('P1-LIVE-05 retryable event failure does not stop normal scheduler work', async (t) => {
  const { db } = await setup(t);
  const user = await addUser(db);
  const event = await addEvent(db);
  let userRuns = 0;
  const summary = await runBriefing({
    now: NOW,
    triggerSource: 'cloudflare',
    deps: {
      db: schedulerDb(db, { users: [user] }), env: ENV, maintenanceNow: () => NOW,
      webhookWhoopFor: webhookWhoop({
        '/activity/sleep/sleep-1': new WhoopApiError('temporary', 500),
      }),
      runUser: async () => {
        userRuns += 1;
        return { daily: null, weekly: null, skipped: null, errors: [], reconciliation: null };
      },
    },
  });
  assert.equal(summary.webhookDrain.retryable, 1);
  assert.equal((await db.getWhoopEvent(event.id)).state, WHOOP_EVENT_STATE.RETRY);
  assert.equal(userRuns, 1);
  assert.equal(summary.runState, 'alive');
});

test('P1-LIVE-06 poison event does not starve a later valid event', async (t) => {
  const { db } = await setup(t);
  await addUser(db);
  await addEvent(db, { resourceId: 'poison', traceId: 'poison' });
  const good = await addEvent(db, { resourceId: 'good', traceId: 'good' });
  const summary = await runScheduler(db, {
    webhookWhoopFor: webhookWhoop({
      '/activity/sleep/poison': new WhoopApiError('temporary', 500),
      '/activity/sleep/good': sleepRecord('good', 17),
    }),
  });
  assert.equal(summary.webhookDrain.claimed, 2);
  assert.equal(summary.webhookDrain.retryable, 1);
  assert.equal(summary.webhookDrain.processed, 1);
  assert.equal((await db.getWhoopEvent(good.id)).state, WHOOP_EVENT_STATE.PROCESSED);
});

test('P1-LIVE-07 inactive-user DELETE semantics remain active', async (t) => {
  const { db } = await setup(t);
  await addUser(db);
  await db.upsertSleeps('alice', [sleepRecord()], { timezone: TZ, now: NOW });
  await db.transitionUserLifecycle({ userId: 'alice', targetStatus: USER_STATUS.DISABLED, now: NOW });
  await addEvent(db, { eventType: 'sleep.deleted', traceId: 'inactive-delete' });
  const summary = await runScheduler(db);
  assert.equal(summary.webhookDrain.processed, 1);
  assert.equal(Number((await db.raw.execute(
    "SELECT COUNT(*) n FROM whoop_sleeps WHERE user_id = 'alice'",
  )).rows[0].n), 0);
  assert.equal((await db.getTombstone('alice', 'sleep', 'sleep-1')).state, 'ACTIVE');
});

test('P1-LIVE-08 Alice webhook event cannot affect Bob', async (t) => {
  const { db } = await setup(t);
  await addUser(db, { id: 'alice', whoopUserId: 'whoop-alice' });
  await addUser(db, { id: 'bob', whoopUserId: 'whoop-bob' });
  await addEvent(db, { whoopUserId: 'whoop-alice' });
  await runScheduler(db, {
    webhookWhoopFor: webhookWhoop({ '/activity/sleep/sleep-1': sleepRecord() }),
  });
  const rows = await db.raw.execute(
    "SELECT user_id FROM whoop_sleeps WHERE id = 'sleep-1' ORDER BY user_id",
  );
  assert.deepEqual(rows.rows.map((row) => String(row.user_id)), ['alice']);
});

async function settleReports(db, user, now) {
  const due = await dueForUser({ db, userId: user.id, timezone: user.timezone, now });
  for (const day of [due.today, due.yesterday]) {
    await db.recordRun({
      userId: user.id, reportType: 'daily', localDateKey: day,
      healthDate: day, status: 'SENT', detail: null,
    });
  }
  await db.recordRun({
    userId: user.id, reportType: 'weekly', localDateKey: due.weekKey,
    healthDate: due.weekKey, status: 'SENT', detail: null,
  });
}

async function markSynced(db, userId, now) {
  for (const resource of WHOOP_SYNC.RESOURCES) {
    await db.saveSyncState(userId, resource, {
      backfillComplete: true, lastSuccessAt: now.toISOString(),
    }, { now });
  }
}

function reconciliationWhoop({ calls = [], sleep = null, sleepFailure = null, gate = null } = {}) {
  return {
    async getAccessToken() { return 'test-token'; },
    async apiGet(resourcePath) {
      calls.push(resourcePath);
      if (resourcePath === '/activity/sleep' && gate) {
        gate.enter();
        await gate.resume;
      }
      if (resourcePath === '/activity/sleep' && sleepFailure) {
        const failure = typeof sleepFailure === 'function' ? sleepFailure() : sleepFailure;
        if (failure) throw failure;
      }
      return {
        records: resourcePath === '/activity/sleep' && sleep ? [sleep] : [],
        next_token: null,
      };
    },
    async bodyMeasurement() {
      calls.push('/user/measurement/body');
      return { height_meter: 1.8, weight_kilogram: 70, max_heart_rate: 190 };
    },
  };
}

function automaticDeps(whoop, {
  clock = { now: NOW }, makeReconciler = createReconciler, order = [],
} = {}) {
  return {
    makeTelegram: () => ({
      send: async () => ({ messageId: 1 }), notifyError: async () => false,
    }),
    makeWhoop: () => whoop,
    makeCoach: () => ({}),
    makeSource: () => ({}),
    makeSync: () => ({
      syncAll: async () => { order.push('sync'); return []; },
    }),
    makeReconciler,
    reconcileNow: () => clock.now,
    daily: async () => ({ status: 'not_run' }),
    weekly: async () => ({ status: 'not_run' }),
    proactive: async () => ({ triggered: false }),
    predictionCycle: async () => ({}),
    healthspan: async () => ({}),
    reap: async () => 0,
  };
}

async function prepareAutomaticUser(db, now = NOW, opts = {}) {
  const user = await addUser(db, opts);
  await settleReports(db, user, now);
  await markSynced(db, user.id, now);
  return db.getUser(user.id);
}

const onlyResources = (resources) => (args) => {
  const real = createReconciler(args);
  return {
    ...real,
    reconcileAll: (options = {}) => real.reconcileAll({
      ...options, resources, includeDeep: false,
    }),
  };
};

async function runAutomatic(db, user, now, deps) {
  return runForUser({
    db, env: ENV, user, now, deps, productionMaintenance: true,
  });
}

test('P2-LIVE-01 ACTIVE+READY scheduled user automatically runs due FAST reconciliation after sync', async (t) => {
  const { db } = await setup(t);
  const user = await prepareAutomaticUser(db);
  const calls = [];
  const order = [];
  const whoop = reconciliationWhoop({ calls });
  const deps = automaticDeps(whoop, { order });
  const originalApiGet = whoop.apiGet.bind(whoop);
  whoop.apiGet = async (...args) => { order.push('reconcile'); return originalApiGet(...args); };
  const out = await runAutomatic(db, user, NOW, deps);
  assert.equal(out.reconciliation.due, true);
  assert.equal(out.reconciliation.attempted, WHOOP_RECONCILE.RESOURCES.length);
  assert.equal(out.reconciliation.completed, WHOOP_RECONCILE.RESOURCES.length);
  assert.ok(order.indexOf('sync') < order.indexOf('reconcile'));
  assert.ok(calls.length > 0);
});

test('P2-LIVE-02 not-due FAST reconciliation performs no provider work', async (t) => {
  const { db } = await setup(t);
  const user = await prepareAutomaticUser(db);
  for (const resource of WHOOP_RECONCILE.RESOURCES) {
    const owner = `seed-${resource}`;
    await db.claimReconciliation({ userId: user.id, resource, owner, leaseMs: 60_000, now: NOW });
    await db.settleReconciliation({
      userId: user.id, resource, owner, result: RECONCILE_RESULT.SUCCESS,
      windowTo: NOW, now: NOW,
    });
  }
  const calls = [];
  const out = await runAutomatic(db, user, NOW, automaticDeps(reconciliationWhoop({ calls })));
  assert.equal(out.skipped, 'nothing_due');
  assert.equal(out.reconciliation.due, false);
  assert.deepEqual(calls, []);
});

test('P2-LIVE-03 second scheduler run before 24-hour cadence does not reconcile twice', async (t) => {
  const { db } = await setup(t);
  const user = await prepareAutomaticUser(db);
  const calls = [];
  const whoop = reconciliationWhoop({ calls });
  await runAutomatic(db, user, NOW, automaticDeps(whoop));
  const firstCalls = calls.length;
  const later = new Date(NOW.getTime() + 10 * 60_000);
  await settleReports(db, user, later);
  await markSynced(db, user.id, later);
  const second = await runAutomatic(db, user, later, automaticDeps(whoop, { clock: { now: later } }));
  assert.equal(second.reconciliation.due, false);
  assert.equal(calls.length, firstCalls);
});

test('P2-LIVE-04 FAST reconciliation runs again after the 24-hour cadence', async (t) => {
  const { db } = await setup(t);
  const user = await prepareAutomaticUser(db);
  const calls = [];
  const whoop = reconciliationWhoop({ calls });
  await runAutomatic(db, user, NOW, automaticDeps(whoop));
  const firstCalls = calls.length;
  const later = new Date(NOW.getTime() + WHOOP_RECONCILE.AUTOMATIC_MIN_INTERVAL_MS + 1);
  await settleReports(db, user, later);
  await markSynced(db, user.id, later);
  const out = await runAutomatic(db, user, later, automaticDeps(whoop, { clock: { now: later } }));
  assert.equal(out.reconciliation.due, true);
  assert.ok(out.reconciliation.completed > 0);
  assert.ok(calls.length > firstCalls);
});

test('P2-LIVE-05 overlapping schedulers use durable ownership and do not duplicate resource work', async (t) => {
  const { db } = await setup(t);
  const user = await prepareAutomaticUser(db);
  const gate = barrier();
  const calls = [];
  const whoop = reconciliationWhoop({ calls, gate });
  const makeReconciler = onlyResources(['sleep']);
  const first = runAutomatic(db, user, NOW, automaticDeps(whoop, { makeReconciler }));
  await gate.entered;
  const second = await runAutomatic(db, user, NOW, automaticDeps(whoop, { makeReconciler }));
  gate.release();
  await first;
  assert.equal(second.reconciliation.deferred, 1);
  assert.equal(calls.filter((p) => p === '/activity/sleep').length, 1);
  const runs = await db.raw.execute(
    "SELECT COUNT(*) n FROM whoop_reconciliation_runs WHERE user_id = 'alice' AND resource = 'sleep'",
  );
  assert.equal(Number(runs.rows[0].n), 1);
});

test('P2-LIVE-06 PAUSED and DISABLED users do not run automatic reconciliation', async (t) => {
  const { db } = await setup(t);
  await addUser(db, { id: 'paused' });
  await addUser(db, { id: 'disabled' });
  await db.transitionUserLifecycle({ userId: 'paused', targetStatus: USER_STATUS.PAUSED, now: NOW });
  await db.transitionUserLifecycle({ userId: 'disabled', targetStatus: USER_STATUS.DISABLED, now: NOW });
  let reconcilerCalls = 0;
  const deps = automaticDeps(reconciliationWhoop(), {
    makeReconciler: () => { reconcilerCalls += 1; return { reconcileAll: async () => [] }; },
  });
  for (const id of ['paused', 'disabled']) {
    const out = await runAutomatic(db, await db.getUser(id), NOW, deps);
    assert.equal(out.skipped, 'no_active_telegram_link');
  }
  assert.equal(reconcilerCalls, 0);
});

test('P2-LIVE-07 lifecycle change during FAST reconciliation rejects stale canonical write', async (t) => {
  const { db } = await setup(t);
  const user = await prepareAutomaticUser(db);
  const gate = barrier();
  const whoop = reconciliationWhoop({ calls: [], sleep: sleepRecord(), gate });
  const running = runAutomatic(db, user, NOW, automaticDeps(whoop, {
    makeReconciler: onlyResources(['sleep']),
  }));
  await gate.entered;
  await db.transitionUserLifecycle({ userId: user.id, targetStatus: USER_STATUS.DISABLED, now: NOW });
  gate.release();
  const out = await running;
  assert.equal(out.skipped, 'account_inactive');
  assert.equal(Number((await db.raw.execute(
    "SELECT COUNT(*) n FROM whoop_sleeps WHERE user_id = 'alice'",
  )).rows[0].n), 0);
});

test('P2-LIVE-08 retryable reconciliation failure leaves scheduler healthy and later retryable', async (t) => {
  const { db } = await setup(t);
  const user = await prepareAutomaticUser(db);
  let fail = true;
  const clock = { now: NOW };
  const whoop = reconciliationWhoop({
    sleepFailure: () => (fail ? new WhoopApiError('temporary', 500) : null),
  });
  const makeReconciler = onlyResources(['sleep']);
  const first = await runAutomatic(db, user, NOW, automaticDeps(whoop, { clock, makeReconciler }));
  assert.equal(first.errors.length, 0);
  assert.equal(first.reconciliation.failed, 1);
  const state = await db.getReconciliationState(user.id, 'sleep');
  assert.ok(state.nextAttemptAt);

  fail = false;
  clock.now = new Date(Date.parse(state.nextAttemptAt) + 1);
  await settleReports(db, user, clock.now);
  await markSynced(db, user.id, clock.now);
  const second = await runAutomatic(
    db, user, clock.now, automaticDeps(whoop, { clock, makeReconciler }),
  );
  assert.equal(second.reconciliation.completed, 1);
});

test('P2-LIVE-09 automatic path never invokes DEEP reconciliation', async (t) => {
  const { db } = await setup(t);
  const user = await prepareAutomaticUser(db);
  let includeDeep = null;
  const makeReconciler = (args) => {
    const real = createReconciler(args);
    return {
      ...real,
      async reconcileAll(options) {
        includeDeep = options.includeDeep;
        return real.reconcileAll({ ...options, resources: ['sleep'] });
      },
    };
  };
  await runAutomatic(db, user, NOW, automaticDeps(reconciliationWhoop(), { makeReconciler }));
  assert.equal(includeDeep, false);
  const deep = await db.raw.execute(
    "SELECT COUNT(*) n FROM whoop_reconciliation_runs WHERE resource LIKE '%/deep'",
  );
  assert.equal(Number(deep.rows[0].n), 0);
});

test('P2-LIVE-10 Alice automatic reconciliation cannot write Bob data or state', async (t) => {
  const { db } = await setup(t);
  const alice = await prepareAutomaticUser(db, NOW, { id: 'alice', whoopUserId: 'whoop-alice' });
  await addUser(db, { id: 'bob', whoopUserId: 'whoop-bob' });
  const whoop = reconciliationWhoop({ sleep: sleepRecord('shared-sleep', 18) });
  await runAutomatic(db, alice, NOW, automaticDeps(whoop, {
    makeReconciler: onlyResources(['sleep']),
  }));
  const rows = await db.raw.execute(
    "SELECT user_id FROM whoop_sleeps WHERE id = 'shared-sleep' ORDER BY user_id",
  );
  assert.deepEqual(rows.rows.map((row) => String(row.user_id)), ['alice']);
  assert.deepEqual(await db.getAllReconciliationState('bob'), []);
});

test('P3-LIVE-01 canonical scheduler keeps asynchronous analytics dormant', async () => {
  const source = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /analyticsWorker|runAnalytics|analytics:(?:light|heavy)/);
});
