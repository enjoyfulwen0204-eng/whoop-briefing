/**
 * Production Activation RC1: lifecycle-owned reconciliation state, bounded webhook
 * maintenance, and shared-service deployment readiness.
 *
 * Storage is real local libSQL. Provider HTTP is the only synthetic boundary.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createDb } from '../src/db.js';
import { runBriefing } from '../src/index.js';
import { createReconciler, isReconcileDue } from '../src/reconcile.js';
import { drainWhoopWebhookEvents } from '../src/whoopWebhookProcessor.js';
import { createWhoopClient } from '../src/whoop.js';
import { createBriefingEndpoint } from '../src/briefingEndpoint.js';
import { BRIEFING_TRIGGER, signTriggerRequest } from '../src/briefingTriggerAuth.js';
import {
  createWebhookHandler, schedulerConfiguration,
} from '../src/bot/webhook.js';
import { LIFECYCLE_UNFENCED } from '../src/accountLifecycle.js';
import { RECONCILE_RESULT, USER_STATUS, WHOOP_EVENT_STATE } from '../src/schema.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const NOW = new Date('2026-09-18T06:00:00.000Z');
const TZ = 'Asia/Taipei';
const ENV = {
  timezone: TZ, dryRun: true, maxUserConcurrency: 3,
  telegramBotToken: 'test-only', telegramChatId: 'test-only',
  tursoUrl: 'file:test', tursoToken: '', repoLastCommitAt: null,
  whoopClientId: 'test-only', whoopClientSecret: 'test-only',
  openrouterApiKey: 'test-only', openrouterModel: 'test-only',
};
let nextChatId = 880_000;

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

function manualTimer() {
  let callback = null;
  return {
    setTimer(fn) {
      callback = fn;
      return { unref() {} };
    },
    clearTimer() {},
    fire() {
      assert.equal(typeof callback, 'function', 'deadline timer must be armed');
      callback();
    },
  };
}

async function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whoop-activation-rc1-'));
  const db = createDb({ url: `file:${path.join(dir, 'db.sqlite')}` });
  await db.migrate();
  t.after(() => {
    try { db.close(); } catch { /* already closed */ }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return db;
}

async function addUser(db, id = 'alice', whoopUserId = `whoop-${id}`) {
  await db.createUser({ id, displayName: id, timezone: TZ });
  await db.linkTelegram({ userId: id, chatId: String(nextChatId++) });
  await db.saveTokens(id, {
    accessToken: `access-${id}`, refreshToken: `refresh-${id}`,
    expiresAt: new Date('2026-12-31T00:00:00.000Z'),
    scope: 'offline', whoopUserId,
  });
  return db.getUser(id);
}

const sleepRecord = (id = 'sleep-1') => ({
  id, user_id: 1, nap: false, score_state: 'SCORED',
  start: '2026-09-13T20:00:00.000Z', end: '2026-09-14T04:00:00.000Z',
  created_at: '2026-09-14T04:05:00.000Z', updated_at: '2026-09-14T05:00:00.000Z',
  score: {
    respiratory_rate: 15,
    stage_summary: {
      total_light_sleep_time_milli: 1,
      total_slow_wave_sleep_time_milli: 1,
      total_rem_sleep_time_milli: 1,
    },
  },
});

function collectionWhoop({ gate = null, records = [] } = {}) {
  return {
    async apiGet(resourcePath) {
      assert.equal(resourcePath, '/activity/sleep');
      if (gate) {
        gate.enter();
        await gate.resume;
      }
      return { records, next_token: null };
    },
    async bodyMeasurement() { return {}; },
  };
}

async function seedMissingCandidate(db, userId = 'alice') {
  await db.upsertSleeps(userId, [sleepRecord('local-missing')], { timezone: TZ, now: NOW });
}

async function staleReconcile(db, { aba = false, records = [], stealOwner = false } = {}) {
  const user = await db.getUser('alice');
  const gate = barrier();
  const reconciler = createReconciler({
    db, whoop: collectionWhoop({ gate, records }), userId: 'alice', timezone: TZ,
    now: () => NOW, ownerId: 'old-lifecycle-owner',
    expectedLifecycleGeneration: user.lifecycleGeneration,
  });
  const running = reconciler.reconcileResource('sleep');
  await gate.entered;
  if (stealOwner) {
    await db.raw.execute({
      sql: `UPDATE whoop_reconciliation_state SET owner = 'new-owner'
             WHERE user_id = 'alice' AND resource = 'sleep'`,
      args: [],
    });
  } else {
    await db.transitionUserLifecycle({ userId: 'alice', targetStatus: USER_STATUS.DISABLED, now: NOW });
    if (aba) {
      await db.transitionUserLifecycle({ userId: 'alice', targetStatus: USER_STATUS.ACTIVE, now: NOW });
    }
  }
  gate.release();
  return running;
}

async function reconciliationEvidence(db, userId = 'alice') {
  const state = await db.getReconciliationState(userId, 'sleep');
  const discrepancies = await db.listDiscrepancies(userId, { resource: 'sleep' });
  const runs = await db.recentReconciliationRuns(userId, { resource: 'sleep' });
  return { state, discrepancies, runs };
}

test('REC-RC1-01 L1 empty result disabled before settlement writes no lifecycle-owned success evidence', async (t) => {
  const db = await setup(t);
  await addUser(db);
  await seedMissingCandidate(db);
  const result = await staleReconcile(db);
  const evidence = await reconciliationEvidence(db);
  assert.equal(result.result, RECONCILE_RESULT.FENCED);
  assert.equal(evidence.state.windowWatermark, null);
  assert.equal(evidence.state.lastSuccessAt, null);
  assert.equal(evidence.discrepancies.length, 0);
  assert.equal(evidence.runs.some((run) => run.result === RECONCILE_RESULT.SUCCESS), false);
  assert.equal(isReconcileDue(evidence.state, { now: NOW }), true);
});

test('REC-RC1-02 L1 empty result cannot settle after DISABLED L2 to ACTIVE L3 ABA', async (t) => {
  const db = await setup(t);
  await addUser(db);
  await seedMissingCandidate(db);
  const result = await staleReconcile(db, { aba: true });
  const evidence = await reconciliationEvidence(db);
  assert.equal((await db.getUser('alice')).lifecycleGeneration, 3);
  assert.equal(result.result, RECONCILE_RESULT.FENCED);
  assert.equal(evidence.state.windowWatermark, null);
  assert.equal(evidence.state.lastSuccessAt, null);
  assert.equal(evidence.discrepancies.length, 0);
  assert.equal(evidence.runs.at(0).result, RECONCILE_RESULT.FENCED);
});

test('REC-RC1-03 current L3 empty result succeeds and explicit inactive admin repair remains available', async (t) => {
  const db = await setup(t);
  await addUser(db);
  await db.transitionUserLifecycle({ userId: 'alice', targetStatus: USER_STATUS.DISABLED, now: NOW });
  await db.transitionUserLifecycle({ userId: 'alice', targetStatus: USER_STATUS.ACTIVE, now: NOW });
  const current = await db.getUser('alice');
  const normal = createReconciler({
    db, whoop: collectionWhoop(), userId: 'alice', timezone: TZ, now: () => NOW,
    ownerId: 'current-l3', expectedLifecycleGeneration: current.lifecycleGeneration,
  });
  const result = await normal.reconcileResource('sleep');
  const state = await db.getReconciliationState('alice', 'sleep');
  assert.equal(result.result, RECONCILE_RESULT.SUCCESS);
  assert.equal(state.windowWatermark, NOW.toISOString());
  assert.equal(state.lastSuccessAt, NOW.toISOString());

  await db.transitionUserLifecycle({ userId: 'alice', targetStatus: USER_STATUS.DISABLED, now: NOW });
  const admin = createReconciler({
    db, whoop: collectionWhoop(), userId: 'alice', timezone: TZ, now: () => NOW,
    ownerId: 'explicit-admin', expectedLifecycleGeneration: LIFECYCLE_UNFENCED,
  });
  assert.equal((await admin.reconcileResource('sleep', {
    explicitWindow: {
      from: new Date('2026-09-10T00:00:00.000Z'), to: new Date('2026-09-11T00:00:00.000Z'),
    },
  })).result, RECONCILE_RESULT.SUCCESS);
});

test('REC-RC1-04 non-empty stale result retains canonical lifecycle protection', async (t) => {
  const db = await setup(t);
  await addUser(db);
  const result = await staleReconcile(db, { records: [sleepRecord('remote-new')] });
  assert.equal(result.result, RECONCILE_RESULT.FENCED);
  assert.equal(Number((await db.raw.execute(
    "SELECT COUNT(*) n FROM whoop_sleeps WHERE user_id = 'alice' AND id = 'remote-new'",
  )).rows[0].n), 0);
  assert.equal((await db.getReconciliationState('alice', 'sleep')).lastSuccessAt, null);
});

test('REC-RC1-05 stale owner is rejected even while lifecycle remains current', async (t) => {
  const db = await setup(t);
  await addUser(db);
  const result = await staleReconcile(db, { stealOwner: true });
  assert.equal(result.result, RECONCILE_RESULT.FENCED);
  const state = await db.getReconciliationState('alice', 'sleep');
  assert.equal(state.windowWatermark, null);
  assert.equal(state.lastSuccessAt, null);
});

test('REC-RC1-06 stale Alice reconciliation cannot alter Bob state or discrepancies', async (t) => {
  const db = await setup(t);
  await addUser(db, 'alice');
  await addUser(db, 'bob');
  const bob = await db.getUser('bob');
  const bobReconciler = createReconciler({
    db, whoop: collectionWhoop(), userId: 'bob', timezone: TZ, now: () => NOW,
    ownerId: 'bob-current', expectedLifecycleGeneration: bob.lifecycleGeneration,
  });
  await bobReconciler.reconcileResource('sleep');
  const before = await reconciliationEvidence(db, 'bob');
  await seedMissingCandidate(db);
  await staleReconcile(db, { aba: true });
  const after = await reconciliationEvidence(db, 'bob');
  assert.deepEqual(after.state, before.state);
  assert.deepEqual(after.discrepancies, before.discrepancies);
  assert.deepEqual(after.runs, before.runs);
});

async function addEvent(db, index, { action = 'deleted', whoopUserId = 'whoop-alice' } = {}) {
  return db.recordWhoopEvent({
    whoopUserId,
    eventType: `sleep.${action}`,
    resourceType: 'sleep',
    resourceId: `sleep-${index}`,
    traceId: `rc1-trace-${whoopUserId}-${index}-${action}`,
    eventAt: String(NOW.getTime()),
    now: NOW,
  });
}

function schedulerDb(db, users = []) {
  return {
    ...db,
    close: () => {},
    ensureOnboardingDerivedForAll: async () => {},
    listOnboardingInState: async () => [],
    listSchedulableUsers: async () => users,
  };
}

async function schedulerRun(db, { users = [], ...deps } = {}) {
  return runBriefing({
    now: NOW,
    triggerSource: 'cloudflare',
    deps: {
      db: schedulerDb(db, users), env: ENV, maintenanceNow: () => NOW,
      ...deps,
    },
  });
}

function deadlineWhoopFor(db, fetchImpl, extra = {}) {
  return (userId, { expectedLifecycleGeneration, maintenance } = {}) => createWhoopClient({
    db, userId, clientId: 'test-client', clientSecret: 'test-secret', fetchImpl,
    expectedLifecycleGeneration,
    requestSignal: maintenance?.signal,
    requestDeadlineAt: maintenance?.deadlineAt,
    ...extra,
  });
}

function stalledFetch(gate) {
  return async (_url, { signal } = {}) => {
    gate.enter();
    return new Promise((resolve, reject) => {
      const abort = () => reject(signal?.reason ?? new DOMException('aborted', 'AbortError'));
      if (signal?.aborted) abort();
      else signal?.addEventListener('abort', abort, { once: true });
    });
  };
}

test('DRAIN-RC1-01 25 immediate events can all finish inside the time budget', async (t) => {
  const db = await setup(t);
  await addUser(db);
  for (let i = 1; i <= 25; i += 1) await addEvent(db, i);
  const out = await drainWhoopWebhookEvents({ db, whoopFor: async () => ({}), owner: 'batch-25', now: () => NOW });
  assert.equal(out.claimed, 25);
  assert.equal(out.processed, 25);
  assert.equal(out.remaining, 0);
  assert.equal(out.budgetExhausted, false);
});

test('DRAIN-RC1-02 more than 25 events leaves the remainder durable', async (t) => {
  const db = await setup(t);
  await addUser(db);
  for (let i = 1; i <= 27; i += 1) await addEvent(db, i);
  const out = await drainWhoopWebhookEvents({ db, whoopFor: async () => ({}), owner: 'count-cap', now: () => NOW });
  assert.equal(out.claimed, 25);
  assert.equal(out.remaining, 2);
  assert.equal(Number((await db.raw.execute(
    "SELECT COUNT(*) n FROM whoop_webhook_events WHERE state = 'RECEIVED'",
  )).rows[0].n), 2);
});

test('DRAIN-RC1-03 long Retry-After is not slept and normal scheduler work continues', async (t) => {
  const db = await setup(t);
  await addUser(db, 'alice');
  const bob = await addUser(db, 'bob');
  const event = await addEvent(db, 1, { action: 'updated' });
  const waits = [];
  let userRuns = 0;
  const summary = await schedulerRun(db, {
    users: [bob],
    webhookWhoopFor: deadlineWhoopFor(db, async () => new Response('{}', {
      status: 429, headers: { 'retry-after': '600' },
    }), { sleepImpl: async (ms) => { waits.push(ms); } }),
    runUser: async () => {
      userRuns += 1;
      return { daily: null, weekly: null, skipped: null, errors: [], reconciliation: null };
    },
  });
  assert.equal(summary.webhookDrain.retryable, 1);
  assert.equal((await db.getWhoopEvent(event.id)).state, WHOOP_EVENT_STATE.RETRY);
  assert.deepEqual(waits, []);
  assert.equal(userRuns, 1);
  assert.equal(summary.runState, 'alive');
});

test('DRAIN-RC1-04 a stalled provider fetch is aborted, retried durably, and the canonical run continues', async (t) => {
  const db = await setup(t);
  const alice = await addUser(db, 'alice');
  const event = await addEvent(db, 1, { action: 'updated' });
  const gate = barrier();
  const timer = manualTimer();
  let userRuns = 0;
  const running = schedulerRun(db, {
    users: [alice],
    drainWebhook: (args) => drainWhoopWebhookEvents({
      ...args, budgetMs: 25_000, setTimer: timer.setTimer, clearTimer: timer.clearTimer,
    }),
    webhookWhoopFor: deadlineWhoopFor(db, stalledFetch(gate)),
    runUser: async () => {
      userRuns += 1;
      return { daily: null, weekly: null, skipped: null, errors: [], reconciliation: null };
    },
  });
  await gate.entered;
  timer.fire();
  const summary = await running;
  assert.equal(summary.webhookDrain.budgetExhausted, true);
  assert.equal(summary.webhookDrain.retryable, 1);
  assert.equal((await db.getWhoopEvent(event.id)).state, WHOOP_EVENT_STATE.RETRY);
  assert.equal(userRuns, 1);
});

test('DRAIN-RC1-05 elapsed budget stops before count cap and preserves backlog', async (t) => {
  const db = await setup(t);
  await addUser(db);
  for (let i = 1; i <= 3; i += 1) await addEvent(db, i);
  let clock = 0;
  const out = await drainWhoopWebhookEvents({
    db, whoopFor: async () => ({}), owner: 'time-cap', now: () => NOW,
    budgetMs: 25, monotonicNow: () => { const value = clock; clock += 10; return value; },
    setTimer: () => ({ unref() {} }), clearTimer: () => {},
  });
  assert.equal(out.budgetExhausted, true);
  assert.equal(out.claimed, 1);
  assert.equal(out.remaining, 2);
});

function signedRequest(secret, requestId) {
  const body = '{}';
  const timestamp = String(NOW.getTime());
  const common = {
    timestamp, requestId, method: 'POST', path: BRIEFING_TRIGGER.PATH, body,
  };
  return {
    body,
    req: {
      method: 'POST', url: BRIEFING_TRIGGER.PATH,
      headers: {
        'content-type': 'application/json',
        'x-briefing-timestamp': timestamp,
        'x-briefing-request-id': requestId,
        'x-briefing-signature': signTriggerRequest(common, secret),
      },
    },
  };
}

async function invokeHandler(handle, { method, url, headers = {}, body = null }) {
  const handlers = {};
  const req = {
    method, url, headers,
    on(event, fn) { handlers[event] = fn; return this; },
    pause() {},
  };
  const res = {
    statusCode: null, body: '', headersSent: false,
    writeHead(status) { this.statusCode = status; this.headersSent = true; },
    end(value) { this.body = value ?? ''; },
  };
  const pending = handle(req, res);
  setImmediate(() => {
    if (body !== null) handlers.data?.(Buffer.from(body));
    handlers.end?.();
  });
  await pending;
  return { status: res.statusCode, json: JSON.parse(res.body) };
}

test('DRAIN-RC1-06 a later signed trigger starts a new run after deadline exhaustion', async (t) => {
  const db = await setup(t);
  await addUser(db);
  await addEvent(db, 1, { action: 'updated' });
  const gate = barrier();
  const timer = manualTimer();
  let runs = 0;
  const secret = 'x'.repeat(32);
  const endpoint = createBriefingEndpoint({
    secret, now: () => NOW.getTime(),
    runBriefing: async () => {
      runs += 1;
      if (runs === 1) {
        return schedulerRun(db, {
          drainWebhook: (args) => drainWhoopWebhookEvents({
            ...args, setTimer: timer.setTimer, clearTimer: timer.clearTimer,
          }),
          webhookWhoopFor: deadlineWhoopFor(db, stalledFetch(gate)),
        });
      }
      return { users: 0, ok: 0, failed: 0, skipped: 0, errors: [], perUser: [] };
    },
  });
  const first = signedRequest(secret, 'rc1-request-id-000001');
  const firstRun = endpoint(first.req, first.body);
  await gate.entered;
  timer.fire();
  assert.equal((await firstRun).status, 200);
  const second = signedRequest(secret, 'rc1-request-id-000002');
  assert.equal((await endpoint(second.req, second.body)).status, 200);
  assert.equal(runs, 2);
});

test('DRAIN-RC1-07 overlapping scheduler-equivalent drains retain one event owner', async (t) => {
  const db = await setup(t);
  await addUser(db);
  await addEvent(db, 1, { action: 'updated' });
  const gate = barrier();
  let providerCalls = 0;
  const whoopFor = async () => ({
    async apiGet() {
      providerCalls += 1;
      gate.enter();
      await gate.resume;
      return sleepRecord('sleep-1');
    },
  });
  const first = drainWhoopWebhookEvents({ db, whoopFor, owner: 'cloudflare', now: () => NOW });
  await gate.entered;
  const second = await drainWhoopWebhookEvents({ db, whoopFor, owner: 'github', now: () => NOW });
  gate.release();
  const primary = await first;
  assert.equal(primary.claimed + second.claimed, 1);
  assert.equal(providerCalls, 1);
  assert.equal(Number((await db.raw.execute(
    "SELECT COUNT(*) n FROM whoop_webhook_events WHERE state = 'PROCESSED'",
  )).rows[0].n), 1);
});

test('DRAIN-RC1-08 Alice stalled event cannot prevent Bob scheduler work in the same run', async (t) => {
  const db = await setup(t);
  await addUser(db, 'alice');
  const bob = await addUser(db, 'bob');
  await addEvent(db, 1, { action: 'updated', whoopUserId: 'whoop-alice' });
  const gate = barrier();
  const timer = manualTimer();
  const usersRun = [];
  const running = schedulerRun(db, {
    users: [bob],
    drainWebhook: (args) => drainWhoopWebhookEvents({
      ...args, setTimer: timer.setTimer, clearTimer: timer.clearTimer,
    }),
    webhookWhoopFor: deadlineWhoopFor(db, stalledFetch(gate)),
    runUser: async ({ user }) => {
      usersRun.push(user.id);
      return { daily: 'sent', weekly: null, skipped: null, errors: [], reconciliation: null };
    },
  });
  await gate.entered;
  timer.fire();
  const summary = await running;
  assert.deepEqual(usersRun, ['bob']);
  assert.equal(summary.webhookDrain.retryable, 1);
  assert.equal(summary.runState, 'alive');
});

test('ACT-M01 documented minimum shared-service env enables health and authenticated scheduler route', async () => {
  const expected = [
    'TELEGRAM_BOT_TOKEN', 'TELEGRAM_WEBHOOK_SECRET', 'TELEGRAM_CHAT_ID',
    'TURSO_DATABASE_URL', 'TURSO_AUTH_TOKEN', 'OPENROUTER_API_KEY',
    'WHOOP_CLIENT_ID', 'WHOOP_CLIENT_SECRET', 'WHOOP_REDIRECT_URI',
    'BRIEFING_TRIGGER_SECRET',
  ];
  const doc = fs.readFileSync(path.join(ROOT, 'docs/telegram-webhook.md'), 'utf8');
  const block = doc.match(/shared-service-required-env:start -->([\s\S]*?)<!-- shared-service-required-env:end/);
  assert.ok(block, 'shared-service environment contract marker must remain documented');
  assert.deepEqual([...block[1].matchAll(/`([A-Z][A-Z0-9_]*)`/g)].map((m) => m[1]), expected);
  assert.match(doc, /HTTP 200[^\n]+不證明 canonical/);
  assert.match(doc, /scheduler.*`"enabled"`/s);

  const secret = 's'.repeat(32);
  const env = {
    telegramBotToken: 'present', telegramWebhookSecret: 'present', telegramChatId: 'present',
    tursoUrl: 'file:unused', tursoToken: 'present', openrouterApiKey: 'present',
    whoopClientId: 'present', whoopClientSecret: 'present', whoopRedirectUri: 'https://example.invalid/callback',
  };
  const config = schedulerConfiguration(env, secret);
  assert.deepEqual(config, { enabled: true, state: 'enabled' });
  const briefingEndpoint = createBriefingEndpoint({
    secret, now: () => NOW.getTime(),
    runBriefing: async () => ({ users: 0, ok: 0, failed: 0, skipped: 0, errors: [], perUser: [] }),
  });
  const handler = createWebhookHandler({
    processUpdate: async () => ({ outcome: 'completed' }),
    secret: 'telegram-test-secret', briefingEndpoint,
    schedulerConfigured: config.enabled, schedulerState: config.state,
  });
  const health = await invokeHandler(handler, { method: 'GET', url: '/health' });
  assert.equal(health.status, 200);
  assert.equal(health.json.scheduler, 'enabled');
  const signed = signedRequest(secret, 'rc1-readiness-id-0001');
  const response = await invokeHandler(handler, {
    method: 'POST', url: BRIEFING_TRIGGER.PATH,
    headers: signed.req.headers, body: signed.body,
  });
  assert.notEqual(response.status, 503);
  assert.notEqual(response.json.error, 'scheduler_unavailable');
});
