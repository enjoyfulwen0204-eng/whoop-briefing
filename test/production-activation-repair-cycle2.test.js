/**
 * Production Activation RC2: diagnostic owner/lease fencing and release-readiness docs.
 *
 * Storage is real local libSQL. Provider HTTP is the only synthetic boundary.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createDb } from '../src/db.js';
import { createReconciler } from '../src/reconcile.js';
import { WhoopApiError } from '../src/whoop.js';
import { createBriefingEndpoint } from '../src/briefingEndpoint.js';
import { BRIEFING_TRIGGER, signTriggerRequest } from '../src/briefingTriggerAuth.js';
import { createWebhookHandler, schedulerConfiguration } from '../src/bot/webhook.js';
import {
  DISCREPANCY_KIND, RECONCILE_RESULT, TOMBSTONE_RECONCILE_VERDICT, USER_STATUS,
} from '../src/schema.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const NOW = new Date('2026-09-18T08:00:00.000Z');
const FUTURE = new Date(NOW.getTime() + 60_000);
const TZ = 'Asia/Taipei';

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whoop-activation-rc2-'));
  const db = createDb({ url: `file:${path.join(dir, 'db.sqlite')}` });
  await db.migrate();
  t.after(() => {
    try { db.close(); } catch { /* already closed */ }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return db;
}

async function addUser(db, id = 'alice') {
  await db.createUser({ id, displayName: id, timezone: TZ });
  return db.getUser(id);
}

const sleepRecord = (id = 'local-missing') => ({
  id, user_id: 1, nap: false, score_state: 'SCORED',
  start: '2026-09-14T20:00:00.000Z', end: '2026-09-15T04:00:00.000Z',
  created_at: '2026-09-15T04:05:00.000Z', updated_at: '2026-09-15T05:00:00.000Z',
  score: {
    respiratory_rate: 15,
    stage_summary: {
      total_light_sleep_time_milli: 1,
      total_slow_wave_sleep_time_milli: 1,
      total_rem_sleep_time_milli: 1,
    },
  },
});

async function seedTombstone(db, userId, resourceType = 'sleep', resourceId = 'deleted-1') {
  await db.deleteWhoopResource({ userId, resourceType, resourceId, now: NOW });
}

async function transferOwner(db, userId, resource, owner = 'owner-B') {
  await db.raw.execute({
    sql: `UPDATE whoop_reconciliation_state
             SET owner = ?, lease_expires_at = ?
           WHERE user_id = ? AND resource = ?`,
    args: [owner, FUTURE.toISOString(), userId, resource],
  });
}

async function tombstoneDiagnostic(db, userId, resourceType, resourceId) {
  const rs = await db.raw.execute({
    sql: `SELECT reconcile_checked_at, reconcile_verdict, reconcile_remote_updated_at
            FROM whoop_resource_tombstones
           WHERE user_id = ? AND resource_type = ? AND resource_id = ?`,
    args: [userId, resourceType, resourceId],
  });
  return rs.rows[0] ?? null;
}

const discrepancyArgs = ({
  userId = 'alice', resource = 'sleep', resourceId = 'missing-1', owner = 'owner-A',
  reconciliationResource = resource, lifecycleGeneration = 1, now = NOW,
} = {}) => ({
  userId, resource, resourceId, kind: DISCREPANCY_KIND.MISSING_REMOTE,
  windowFrom: new Date(NOW.getTime() - 86_400_000), windowTo: NOW,
  owner, reconciliationResource, lifecycleGeneration, now,
});

const verdictArgs = ({
  userId = 'alice', resourceType = 'sleep', resourceId = 'deleted-1', owner = 'owner-A',
  reconciliationResource = resourceType, lifecycleGeneration = 1, now = NOW,
} = {}) => ({
  userId, resourceType, resourceId,
  verdict: TOMBSTONE_RECONCILE_VERDICT.STILL_DELETED,
  owner, reconciliationResource, lifecycleGeneration, now,
});

test('REC-RC2-01 owner transfer prevents the old worker from inserting MISSING_REMOTE', async (t) => {
  const db = await setup(t);
  const user = await addUser(db);
  await db.upsertSleeps('alice', [sleepRecord()], { timezone: TZ, now: NOW });
  const gate = barrier();
  const reconciler = createReconciler({
    db, userId: 'alice', timezone: TZ, now: () => NOW, ownerId: 'owner-A',
    expectedLifecycleGeneration: user.lifecycleGeneration,
    whoop: {
      async apiGet(resourcePath) {
        assert.equal(resourcePath, '/activity/sleep');
        gate.enter();
        await gate.resume;
        return { records: [], next_token: null };
      },
    },
  });
  const running = reconciler.reconcileResource('sleep');
  await gate.entered;
  await transferOwner(db, 'alice', 'sleep');
  gate.release();
  const result = await running;
  assert.equal(result.result, RECONCILE_RESULT.FENCED);
  assert.deepEqual(await db.listDiscrepancies('alice', { resource: 'sleep' }), []);
  const state = await db.getReconciliationState('alice', 'sleep');
  assert.equal(state.owner, 'owner-B');
  assert.equal(state.windowWatermark, null);
  assert.equal(state.lastSuccessAt, null);
});

test('REC-RC2-02 owner transfer prevents stale tombstone verdict and checked-at writes', async (t) => {
  const db = await setup(t);
  const user = await addUser(db);
  await seedTombstone(db, 'alice');
  const gate = barrier();
  const reconciler = createReconciler({
    db, userId: 'alice', timezone: TZ, now: () => NOW, ownerId: 'owner-A',
    expectedLifecycleGeneration: user.lifecycleGeneration,
    whoop: {
      async apiGet(resourcePath) {
        if (resourcePath === '/activity/sleep') return { records: [], next_token: null };
        assert.equal(resourcePath, '/activity/sleep/deleted-1');
        gate.enter();
        await gate.resume;
        throw new WhoopApiError('not found', 404);
      },
    },
  });
  const running = reconciler.reconcileResource('sleep');
  await gate.entered;
  await transferOwner(db, 'alice', 'sleep');
  gate.release();
  const result = await running;
  assert.equal(result.result, RECONCILE_RESULT.FENCED);
  const diagnostic = await tombstoneDiagnostic(db, 'alice', 'sleep', 'deleted-1');
  assert.equal(diagnostic.reconcile_checked_at, null);
  assert.equal(diagnostic.reconcile_verdict, null);
  assert.equal((await db.getReconciliationState('alice', 'sleep')).owner, 'owner-B');
});

test('REC-RC2-03 matching owner with an expired lease cannot write diagnostics', async (t) => {
  const db = await setup(t);
  const user = await addUser(db);
  await seedTombstone(db, 'alice');
  assert.equal(await db.claimReconciliation({
    userId: 'alice', resource: 'sleep', owner: 'owner-A', leaseMs: 1_000,
    lifecycleGeneration: user.lifecycleGeneration, now: NOW,
  }), true);
  const expired = new Date(NOW.getTime() + 1_001);
  assert.equal(await db.recordDiscrepancy(discrepancyArgs({ now: expired })), false);
  assert.equal(await db.recordTombstoneVerdict(verdictArgs({ now: expired })), false);
  assert.deepEqual(await db.listDiscrepancies('alice'), []);
  assert.equal((await tombstoneDiagnostic(db, 'alice', 'sleep', 'deleted-1')).reconcile_checked_at, null);
});

test('REC-RC2-04 a sleep lease cannot authorize recovery diagnostics', async (t) => {
  const db = await setup(t);
  const user = await addUser(db);
  await seedTombstone(db, 'alice', 'recovery', 'recovery-1');
  assert.equal(await db.claimReconciliation({
    userId: 'alice', resource: 'sleep', owner: 'owner-A', leaseMs: 60_000,
    lifecycleGeneration: user.lifecycleGeneration, now: NOW,
  }), true);
  assert.equal(await db.recordDiscrepancy(discrepancyArgs({
    resource: 'recovery', resourceId: 'recovery-1', reconciliationResource: 'sleep',
  })), false);
  assert.equal(await db.recordTombstoneVerdict(verdictArgs({
    resourceType: 'recovery', resourceId: 'recovery-1', reconciliationResource: 'sleep',
  })), false);
  assert.deepEqual(await db.listDiscrepancies('alice'), []);
  assert.equal((await tombstoneDiagnostic(db, 'alice', 'recovery', 'recovery-1')).reconcile_checked_at, null);
});

test('REC-RC2-05 current owner, live lease, resource, and lifecycle can write and settle', async (t) => {
  const db = await setup(t);
  const user = await addUser(db);
  await seedTombstone(db, 'alice');
  assert.equal(await db.claimReconciliation({
    userId: 'alice', resource: 'sleep', owner: 'owner-A', leaseMs: 60_000,
    lifecycleGeneration: user.lifecycleGeneration, now: NOW,
  }), true);
  assert.equal(await db.recordDiscrepancy(discrepancyArgs()), true);
  assert.equal(await db.recordTombstoneVerdict(verdictArgs()), true);
  assert.equal((await db.listDiscrepancies('alice')).length, 1);
  const diagnostic = await tombstoneDiagnostic(db, 'alice', 'sleep', 'deleted-1');
  assert.equal(diagnostic.reconcile_checked_at, NOW.toISOString());
  assert.equal(diagnostic.reconcile_verdict, TOMBSTONE_RECONCILE_VERDICT.STILL_DELETED);
  assert.equal(await db.settleReconciliation({
    userId: 'alice', resource: 'sleep', owner: 'owner-A', result: RECONCILE_RESULT.SUCCESS,
    windowTo: NOW, lifecycleGeneration: user.lifecycleGeneration, now: NOW,
  }), true);
  assert.equal((await db.getReconciliationState('alice', 'sleep')).lastSuccessAt, NOW.toISOString());
});

test('REC-RC2-06 current owner cannot write with a stale lifecycle generation', async (t) => {
  const db = await setup(t);
  const user = await addUser(db);
  await seedTombstone(db, 'alice');
  assert.equal(await db.claimReconciliation({
    userId: 'alice', resource: 'sleep', owner: 'owner-A', leaseMs: 60_000,
    lifecycleGeneration: user.lifecycleGeneration, now: NOW,
  }), true);
  await db.transitionUserLifecycle({ userId: 'alice', targetStatus: USER_STATUS.DISABLED, now: NOW });
  await db.transitionUserLifecycle({ userId: 'alice', targetStatus: USER_STATUS.ACTIVE, now: NOW });
  await transferOwner(db, 'alice', 'sleep', 'owner-A');
  assert.equal(await db.recordDiscrepancy(discrepancyArgs({
    lifecycleGeneration: user.lifecycleGeneration,
  })), false);
  assert.equal(await db.recordTombstoneVerdict(verdictArgs({
    lifecycleGeneration: user.lifecycleGeneration,
  })), false);
  assert.deepEqual(await db.listDiscrepancies('alice'), []);
  assert.equal((await tombstoneDiagnostic(db, 'alice', 'sleep', 'deleted-1')).reconcile_checked_at, null);
});

test('REC-RC2-07 Alice owner cannot mutate Bob diagnostic state', async (t) => {
  const db = await setup(t);
  const alice = await addUser(db, 'alice');
  const bob = await addUser(db, 'bob');
  await seedTombstone(db, 'bob');
  assert.equal(await db.claimReconciliation({
    userId: 'alice', resource: 'sleep', owner: 'alice-owner', leaseMs: 60_000,
    lifecycleGeneration: alice.lifecycleGeneration, now: NOW,
  }), true);
  assert.equal(await db.claimReconciliation({
    userId: 'bob', resource: 'sleep', owner: 'bob-owner', leaseMs: 60_000,
    lifecycleGeneration: bob.lifecycleGeneration, now: NOW,
  }), true);
  assert.equal(await db.recordDiscrepancy(discrepancyArgs({
    userId: 'bob', owner: 'alice-owner', lifecycleGeneration: bob.lifecycleGeneration,
  })), false);
  assert.equal(await db.recordTombstoneVerdict(verdictArgs({
    userId: 'bob', owner: 'alice-owner', lifecycleGeneration: bob.lifecycleGeneration,
  })), false);
  assert.deepEqual(await db.listDiscrepancies('bob'), []);
  assert.equal((await tombstoneDiagnostic(db, 'bob', 'sleep', 'deleted-1')).reconcile_checked_at, null);
  assert.equal((await db.getReconciliationState('bob', 'sleep')).owner, 'bob-owner');
});

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

function signedRequest(secret) {
  const body = '{}';
  const timestamp = String(NOW.getTime());
  const requestId = 'rc2-readiness-id-0001';
  const common = { timestamp, requestId, method: 'POST', path: BRIEFING_TRIGGER.PATH, body };
  return {
    body,
    headers: {
      'content-type': 'application/json',
      'x-briefing-timestamp': timestamp,
      'x-briefing-request-id': requestId,
      'x-briefing-signature': signTriggerRequest(common, secret),
    },
  };
}

test('DOC-RC2-01 README and deployment guides distinguish liveness from scheduler readiness', () => {
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const telegram = fs.readFileSync(path.join(ROOT, 'docs/telegram-webhook.md'), 'utf8');
  const cloudflare = fs.readFileSync(path.join(ROOT, 'docs/cloudflare-briefing-runbook.md'), 'utf8');
  const render = fs.readFileSync(path.join(ROOT, 'render.yaml'), 'utf8');
  assert.doesNotMatch(readme, /GET \/health[^\n]+只回 `\{"ok":true,"service":"telegram-webhook"\}`/);
  assert.match(readme, /HTTP 200[^\n]+不代表 scheduler 可用/);
  assert.match(readme, /"scheduler":"enabled"/);
  assert.match(readme, /503 scheduler_unavailable/);
  assert.match(telegram, /HTTP 200[^\n]+不證明 canonical/);
  assert.match(telegram, /scheduler` 是 `"enabled"`/);
  assert.match(cloudflare, /Cloudflare Worker Cron, \*\*every 10 minutes\*\*/);
  assert.match(cloudflare, /GitHub Actions, \*\*hourly at minute 17\*\*/);
  assert.match(cloudflare, /HTTP 200 alone means only that the web process is live/);
  assert.match(render, /主排程是 Cloudflare Worker Cron/);
  assert.match(render, /GitHub Actions（每小時第 17 分）/);
});

test('CFG-RC2-01 complete config is ready; missing WHOOP_CLIENT_ID is live but unavailable', async () => {
  const expectedEnv = [
    'TELEGRAM_BOT_TOKEN', 'TELEGRAM_WEBHOOK_SECRET', 'TELEGRAM_CHAT_ID',
    'TURSO_DATABASE_URL', 'TURSO_AUTH_TOKEN', 'OPENROUTER_API_KEY',
    'WHOOP_CLIENT_ID', 'WHOOP_CLIENT_SECRET', 'WHOOP_REDIRECT_URI',
    'BRIEFING_TRIGGER_SECRET',
  ];
  const telegram = fs.readFileSync(path.join(ROOT, 'docs/telegram-webhook.md'), 'utf8');
  const block = telegram.match(/shared-service-required-env:start -->([\s\S]*?)<!-- shared-service-required-env:end/);
  assert.ok(block);
  assert.deepEqual([...block[1].matchAll(/`([A-Z][A-Z0-9_]*)`/g)].map((m) => m[1]), expectedEnv);

  const secret = 's'.repeat(32);
  const completeEnv = {
    telegramBotToken: 'present', telegramWebhookSecret: 'present', telegramChatId: 'present',
    tursoUrl: 'file:unused', tursoToken: 'present', openrouterApiKey: 'present',
    whoopClientId: 'present', whoopClientSecret: 'present',
    whoopRedirectUri: 'https://example.invalid/callback',
  };
  const ready = schedulerConfiguration(completeEnv, secret);
  assert.deepEqual(ready, { enabled: true, state: 'enabled' });
  const endpoint = createBriefingEndpoint({
    secret, now: () => NOW.getTime(),
    runBriefing: async () => ({ users: 0, ok: 0, failed: 0, skipped: 0, errors: [], perUser: [] }),
  });
  const readyHandler = createWebhookHandler({
    processUpdate: async () => ({ outcome: 'completed' }), secret: 'telegram-test',
    briefingEndpoint: endpoint, schedulerConfigured: true, schedulerState: 'enabled',
  });
  const readyHealth = await invokeHandler(readyHandler, { method: 'GET', url: '/health' });
  assert.equal(readyHealth.status, 200);
  assert.equal(readyHealth.json.scheduler, 'enabled');
  const signed = signedRequest(secret);
  assert.notEqual((await invokeHandler(readyHandler, {
    method: 'POST', url: BRIEFING_TRIGGER.PATH, headers: signed.headers, body: signed.body,
  })).status, 503);

  const incompleteEnv = { ...completeEnv, whoopClientId: '' };
  const incomplete = schedulerConfiguration(incompleteEnv, secret);
  assert.deepEqual(incomplete, { enabled: false, state: 'incomplete' });
  const incompleteHandler = createWebhookHandler({
    processUpdate: async () => ({ outcome: 'completed' }), secret: 'telegram-test',
    briefingEndpoint: null, schedulerConfigured: false, schedulerState: incomplete.state,
  });
  const liveHealth = await invokeHandler(incompleteHandler, { method: 'GET', url: '/health' });
  assert.equal(liveHealth.status, 200);
  assert.equal(liveHealth.json.scheduler, 'incomplete');
  const unavailable = await invokeHandler(incompleteHandler, {
    method: 'POST', url: BRIEFING_TRIGGER.PATH, headers: signed.headers, body: signed.body,
  });
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.json.error, 'scheduler_unavailable');
});
