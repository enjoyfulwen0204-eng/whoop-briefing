import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import {
  BRIEFING_TRIGGER, canonicalTriggerMessage, signTriggerRequest, verifyTriggerRequest,
} from '../src/briefingTriggerAuth.js';
import { createBriefingEndpoint } from '../src/briefingEndpoint.js';
import {
  checkPeerScheduler, providerState, aggregateSchedulerState, SCHEDULER_POLICY,
} from '../src/schedulerWatchdog.js';
import { HEARTBEAT_COMPONENT } from '../src/guardianPolicy.js';
import { signRequest, retryableStatus, invoke } from '../cloudflare/briefing-scheduler/worker.js';
import { BRIEFING_STATUS, renderBriefingStatus } from '../src/briefingStatus.js';
import { schedulerConfiguration } from '../src/bot/webhook.js';

const SECRET = 'test-only-secret-with-sufficient-entropy';
const NOW = 1_789_123_456_000;
const base = (overrides = {}) => ({
  timestamp: String(NOW), requestId: randomUUID(), method: 'POST',
  path: BRIEFING_TRIGGER.PATH, body: '{}', ...overrides,
});

test('HMAC canonicalization matches Worker Web Crypto signing', async () => {
  const args = base({ requestId: 'request_1234567890' });
  assert.equal(await signRequest(args, SECRET), signTriggerRequest(args, SECRET));
  assert.match(canonicalTriggerMessage(args), /POST\n\/internal\/briefing\/run\n/);
});

test('authentication binds signature to timestamp, id, method, path, and body', () => {
  const args = base();
  const signature = signTriggerRequest(args, SECRET);
  assert.deepEqual(verifyTriggerRequest({ ...args, signature, secret: SECRET, now: NOW }), { ok: true });
  for (const changed of [
    { body: '{"changed":true}' }, { method: 'GET' }, { path: '/wrong' },
  ]) {
    assert.equal(verifyTriggerRequest({ ...args, ...changed, signature, secret: SECRET, now: NOW }).ok, false);
  }
  assert.equal(verifyTriggerRequest({ ...args, signature: '', secret: SECRET, now: NOW }).reason, 'missing_auth');
  assert.equal(verifyTriggerRequest({ ...args, signature: 'v1=00', secret: SECRET, now: NOW }).reason, 'invalid_signature');
  assert.equal(verifyTriggerRequest({ ...args, requestId: 'bad', signature, secret: SECRET, now: NOW }).reason, 'malformed_request_id');
});

test('authentication rejects stale, future, and malformed timestamps', () => {
  for (const [timestamp, reason] of [
    [String(NOW - BRIEFING_TRIGGER.MAX_CLOCK_SKEW_MS - 1), 'stale_timestamp'],
    [String(NOW + BRIEFING_TRIGGER.MAX_CLOCK_SKEW_MS + 1), 'future_timestamp'],
    ['not-a-time', 'malformed_timestamp'],
  ]) {
    const args = base({ timestamp });
    const signature = signTriggerRequest(args, SECRET);
    assert.equal(verifyTriggerRequest({ ...args, signature, secret: SECRET, now: NOW }).reason, reason);
  }
});

function request(args, signature, extra = {}) {
  return {
    url: args.path, method: args.method,
    headers: {
      'content-type': 'application/json', 'x-briefing-timestamp': args.timestamp,
      'x-briefing-request-id': args.requestId, 'x-briefing-signature': signature,
      ...extra,
    },
  };
}

test('endpoint returns aggregate-only result and suppresses duplicate request ID in memory', async () => {
  let calls = 0;
  const runBriefing = async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return { users: 2, ok: 2, failed: 0, skipped: 1, errors: [], perUser: [
      { userId: 'must-not-leak', daily: 'sent' }, { userId: 'also-private', daily: 'not_ready' },
    ] };
  };
  const endpoint = createBriefingEndpoint({ secret: SECRET, runBriefing, now: () => NOW });
  const args = base();
  const req = request(args, signTriggerRequest(args, SECRET));
  const [a, b] = await Promise.all([endpoint(req, args.body), endpoint(req, args.body)]);
  assert.equal(calls, 1);
  assert.deepEqual(a, b);
  assert.equal(a.status, 200);
  assert.equal(JSON.stringify(a).includes('must-not-leak'), false);
  assert.deepEqual(a.body.result.daily, { sent: 1, not_ready: 1 });
});

test('different request IDs coalesce onto one active canonical process run', async () => {
  let resolveRun;
  let calls = 0;
  const endpoint = createBriefingEndpoint({
    secret: SECRET, now: () => NOW,
    runBriefing: () => { calls += 1; return new Promise((resolve) => { resolveRun = resolve; }); },
  });
  const a = base();
  const b = base();
  const pa = endpoint(request(a, signTriggerRequest(a, SECRET)), a.body);
  const pb = endpoint(request(b, signTriggerRequest(b, SECRET)), b.body);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  resolveRun({ users: 0, ok: 0, failed: 0, skipped: 0, errors: [], perUser: [] });
  assert.equal((await pa).status, 200);
  assert.equal((await pb).status, 200);
});

test('endpoint rejects media type, malformed/large body, auth failure, and reports partial failure', async () => {
  const endpoint = createBriefingEndpoint({
    secret: SECRET, now: () => NOW,
    runBriefing: async () => ({ users: 1, ok: 0, failed: 1, skipped: 0, errors: [], perUser: [] }),
  });
  const args = base();
  const sig = signTriggerRequest(args, SECRET);
  assert.equal((await endpoint(request(args, sig, { 'content-type': 'text/plain' }), '{}')).status, 415);
  assert.equal((await endpoint(request(args, sig), '{')).status, 400);
  assert.equal((await endpoint(request(args, sig), 'x'.repeat(1025))).status, 413);
  assert.equal((await endpoint(request(args, 'bad'), '{}')).status, 401);
  assert.equal((await endpoint({ ...request(args, sig), url: `${args.path}?unexpected=1` }, '{}')).status, 400);
  assert.equal((await endpoint(request(args, sig), '{}')).status, 207);
});

test('scheduler-only env is fail-closed without taking down inbound configuration', () => {
  assert.deepEqual(schedulerConfiguration({}, ''), { enabled: false, state: 'disabled' });
  assert.deepEqual(schedulerConfiguration({ whoopClientId: 'only-one' }, ''),
    { enabled: false, state: 'incomplete' });
  assert.deepEqual(schedulerConfiguration({
    whoopClientId: 'id', whoopClientSecret: 'secret', telegramChatId: 'chat',
  }, SECRET), { enabled: true, state: 'enabled' });
});

test('Worker re-signs each retry while preserving logical request ID', async () => {
  assert.equal(retryableStatus(503), true);
  assert.equal(retryableStatus(401), false);
  const requests = [];
  const statuses = [503, 502, 200];
  let cleared = 0;
  const result = await invoke({
    BRIEFING_ENDPOINT_URL: 'https://example.invalid/internal/briefing/run',
    BRIEFING_TRIGGER_SECRET: SECRET,
  }, {
    now: (() => { const times = [NOW, NOW + 120_000, NOW + 240_000]; return () => times.shift(); })(),
    sleep: async () => {}, clearTimer: (timer) => { cleared += 1; clearTimeout(timer); },
    fetchImpl: async (_url, options) => {
      requests.push(options);
      const status = statuses.shift();
      return { status, ok: status === 200, text: async () => '' };
    },
  });
  assert.equal(result.attempt, 3);
  assert.equal(cleared, 3, 'success and retry responses must clear their timers');
  assert.equal(requests.length, 3);
  assert.equal(new Set(requests.map((r) => r.headers['x-briefing-request-id'])).size, 1);
  assert.deepEqual(requests.map((r) => Number(r.headers['x-briefing-timestamp'])),
    [NOW, NOW + 120_000, NOW + 240_000]);
  assert.equal(new Set(requests.map((r) => r.headers['x-briefing-signature'])).size, 3);
  for (const r of requests) {
    assert.deepEqual(verifyTriggerRequest({
      timestamp: r.headers['x-briefing-timestamp'], requestId: r.headers['x-briefing-request-id'],
      signature: r.headers['x-briefing-signature'], secret: SECRET, method: 'POST',
      path: BRIEFING_TRIGGER.PATH, body: r.body, now: Number(r.headers['x-briefing-timestamp']),
    }), { ok: true });
  }
  const first = requests[0];
  assert.equal(verifyTriggerRequest({
    timestamp: first.headers['x-briefing-timestamp'], requestId: first.headers['x-briefing-request-id'],
    signature: first.headers['x-briefing-signature'], secret: SECRET, method: 'POST',
    path: BRIEFING_TRIGGER.PATH, body: first.body,
    now: NOW + BRIEFING_TRIGGER.MAX_CLOCK_SKEW_MS + 1,
  }).reason, 'stale_timestamp');

  let authAttempts = 0;
  await assert.rejects(() => invoke({
    BRIEFING_ENDPOINT_URL: 'https://example.invalid/internal/briefing/run',
    BRIEFING_TRIGGER_SECRET: SECRET,
  }, {
    now: () => NOW, sleep: async () => {},
    fetchImpl: async () => {
      authAttempts += 1;
      return { status: 401, ok: false, text: async () => 'unauthorized' };
    },
  }), /401/);
  assert.equal(authAttempts, 1);
});

test('scheduler role policy covers observed GitHub gaps without healthy-primary alerts', async () => {
  const at = new Date(NOW);
  for (const minutes of [120, 131, 137, 157, 226, 272, 273, 240, 420]) {
    const state = providerState({ lastOkAt: new Date(NOW - minutes * 60_000).toISOString() }, 'github', at);
    assert.notEqual(state.state, 'stale', `${minutes} minutes must not be severe`);
  }
  assert.equal(providerState({ lastOkAt: new Date(NOW - 13 * 3600_000).toISOString() }, 'github', at).state, 'stale');
  assert.equal(providerState({ lastOkAt: 'malformed' }, 'github', at).state, 'unknown');
  assert.equal(providerState({ lastOkAt: new Date(NOW + 1).toISOString() }, 'github', at).state, 'unknown');

  let alerts = 0;
  const systemTelegram = { notifyError: async () => { alerts += 1; return true; } };
  const heartbeats = new Map([
    [HEARTBEAT_COMPONENT.CLOUDFLARE, { lastOkAt: new Date(NOW - 5 * 60_000).toISOString() }],
    [HEARTBEAT_COMPONENT.GITHUB, { lastOkAt: new Date(NOW - 13 * 3600_000).toISOString() }],
  ]);
  const db = { getHeartbeat: async (_scope, component) => heartbeats.get(component) ?? null };
  for (let minute = 0; minute < 24 * 60; minute += 10) {
    heartbeats.set(HEARTBEAT_COMPONENT.CLOUDFLARE,
      { lastOkAt: new Date(NOW + minute * 60_000).toISOString() });
    await checkPeerScheduler({ db, source: 'cloudflare', systemTelegram, now: new Date(NOW + minute * 60_000) });
  }
  assert.equal(alerts, 0, 'healthy-primary operation must emit zero product-channel backup alerts/24h');

  heartbeats.set(HEARTBEAT_COMPONENT.CLOUDFLARE,
    { lastOkAt: new Date(NOW - 60 * 60_000).toISOString() });
  heartbeats.set(HEARTBEAT_COMPONENT.GITHUB,
    { lastOkAt: new Date(NOW - 10 * 60_000).toISOString() });
  const degraded = await checkPeerScheduler({ db, source: 'github', systemTelegram, now: at });
  assert.equal(degraded.overall, 'degraded');
  assert.equal(degraded.alerted, true);
  assert.equal(alerts, 1);

  heartbeats.clear();
  const firstDeploy = await checkPeerScheduler({ db, source: 'cloudflare', systemTelegram, now: at });
  assert.equal(firstDeploy.overall, 'uninitialized');
  db.getHeartbeat = async () => { throw new Error('db timeout'); };
  assert.equal((await checkPeerScheduler({ db, source: 'github', systemTelegram, now: at })).overall, 'unknown');
});

test('primary outage alerts obey cooldown, delivery failure, and concurrent atomic claims', async () => {
  const heartbeats = new Map([
    [HEARTBEAT_COMPONENT.CLOUDFLARE, { lastOkAt: new Date(NOW - 2 * 3600_000).toISOString() }],
    [HEARTBEAT_COMPONENT.GITHUB, { lastOkAt: new Date(NOW).toISOString() }],
  ]);
  const db = { getHeartbeat: async (_scope, component) => heartbeats.get(component) };
  let currentHour = 0;
  let lastClaim = -Infinity;
  let sends = 0;
  const systemTelegram = { notifyError: async () => {
    if (currentHour - lastClaim < 2) return false;
    lastClaim = currentHour;
    sends += 1;
    return sends !== 1; // first delivery failure is surfaced as alerted=false
  } };
  const first = await checkPeerScheduler({ db, source: 'github', systemTelegram, now: new Date(NOW) });
  assert.equal(first.alerted, false);
  for (currentHour = 1; currentHour < 24; currentHour += 1) {
    heartbeats.set(HEARTBEAT_COMPONENT.GITHUB,
      { lastOkAt: new Date(NOW + currentHour * 3600_000).toISOString() });
    await checkPeerScheduler({
      db, source: 'github', systemTelegram, now: new Date(NOW + currentHour * 3600_000),
    });
  }
  assert.equal(sends, 12, 'hourly fallback with a 2h cooldown produces exactly 12 attempts/24h');

  currentHour = 30;
  lastClaim = -Infinity;
  sends = 0;
  let claimed = false;
  const atomicTelegram = { notifyError: async () => {
    await new Promise((resolve) => setImmediate(resolve));
    if (claimed) return false;
    claimed = true;
    sends += 1;
    return true;
  } };
  const pair = await Promise.all([
    checkPeerScheduler({ db, source: 'github', systemTelegram: atomicTelegram, now: new Date(NOW + 30 * 3600_000) }),
    checkPeerScheduler({ db, source: 'github', systemTelegram: atomicTelegram, now: new Date(NOW + 30 * 3600_000) }),
  ]);
  assert.equal(sends, 1);
  assert.deepEqual(pair.map((r) => r.alerted).sort(), [false, true]);
});

test('briefing status is vendor/topology-free in every product state', () => {
  const forbidden = /Cloudflare|GitHub|cron|heartbeat|Render|Worker|Actions|endpoint|primary|backup|主排程|備援/i;
  for (const status of Object.values(BRIEFING_STATUS)) {
    for (const schedulerState of ['healthy', 'degraded', 'outage', 'unknown', 'uninitialized']) {
      const message = renderBriefingStatus({
        status,
        evidence: { scheduler_state: schedulerState, scheduler_stale: schedulerState === 'outage' },
      });
      assert.doesNotMatch(message, forbidden, `${status}/${schedulerState}`);
    }
  }
});

test('redirects are terminal, never followed, and placeholder/query URLs fail closed', async () => {
  for (const [status, location] of [
    [301, 'https://render.example/other'],
    [302, 'https://cross-origin.example/internal/briefing/run'],
    [302, 'http://render.example/internal/briefing/run'],
    [301, 'https://render.example/internal/briefing/run'],
  ]) {
    let calls = 0;
    await assert.rejects(() => invoke({
      BRIEFING_ENDPOINT_URL: 'https://render.example/internal/briefing/run',
      BRIEFING_TRIGGER_SECRET: SECRET,
    }, {
      now: () => NOW, sleep: async () => {},
      fetchImpl: async (_url, options) => {
        calls += 1;
        assert.equal(options.redirect, 'error');
        return { status, ok: false, headers: { get: () => location }, text: async () => 'redirect target hidden' };
      },
    }), new RegExp(String(status)));
    assert.equal(calls, 1);
  }
  for (const url of [
    'https://REPLACE_WITH_RENDER_HOST/internal/briefing/run',
    'https://render.example/internal/briefing/run?x=1',
    'https://render.example/internal/briefing/run#x',
    'http://render.example/internal/briefing/run',
  ]) {
    await assert.rejects(() => invoke({ BRIEFING_ENDPOINT_URL: url, BRIEFING_TRIGGER_SECRET: SECRET }));
  }
});

test('real AbortController path aborts each hanging attempt and clears every timer', async () => {
  let attempts = 0;
  let cleared = 0;
  await assert.rejects(() => invoke({
    BRIEFING_ENDPOINT_URL: 'https://render.example/internal/briefing/run',
    BRIEFING_TRIGGER_SECRET: SECRET,
  }, {
    now: (() => { let t = NOW; return () => (t += 120_000); })(), sleep: async () => {}, timeoutMs: 1,
    setTimer: (fn) => { queueMicrotask(fn); return Symbol('timer'); },
    clearTimer: () => { cleared += 1; },
    fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => {
      attempts += 1;
      signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')),
        { once: true });
    }),
  }), { name: 'AbortError' });
  assert.equal(attempts, 3);
  assert.equal(cleared, 3);
});

test('CLI and Render endpoint reference the same exported canonical runner', async () => {
  const index = await import('../src/index.js');
  assert.equal(index.main, index.runBriefing);
  const webhookSource = (await import('node:fs')).readFileSync('src/bot/webhook.js', 'utf8');
  assert.match(webhookSource, /import \{ runBriefing \} from '\.\.\/index\.js'/);
  assert.doesNotMatch(webhookSource, /exec|spawn|npm start/);
});

test('zero-user execution is successful liveness, records heartbeat, and sends no alerts', async () => {
  const index = await import('../src/index.js');
  const heartbeats = [];
  let alerts = 0;
  const db = {
    migrate: async () => {}, listActiveUsers: async () => [],
    recordHeartbeat: async (...args) => { heartbeats.push(args); }, close: () => {},
  };
  const env = {
    timezone: 'Asia/Taipei', dryRun: true, maxUserConcurrency: 3,
    telegramBotToken: 'test', telegramChatId: 'test', tursoUrl: 'file:test', tursoToken: '',
    repoLastCommitAt: null,
  };
  const result = await index.runBriefing({
    triggerSource: 'cloudflare', deps: {
      db, env, makeTelegram: () => ({ send: async () => {}, notifyError: async () => { alerts += 1; } }),
    },
  });
  assert.equal(result.outcome, 'nothing_due');
  assert.equal(result.users, 0);
  assert.equal(heartbeats.length, 2);
  assert.equal(alerts, 0);
});

test('partial application failure does not record a successful scheduler heartbeat', async () => {
  const index = await import('../src/index.js');
  const heartbeats = [];
  const db = {
    migrate: async () => {}, listActiveUsers: async () => [{ id: 'user-1' }],
    recordHeartbeat: async (...args) => { heartbeats.push(args); },
    getHeartbeat: async () => null, close: () => {},
  };
  const env = {
    timezone: 'Asia/Taipei', dryRun: true, maxUserConcurrency: 1,
    telegramBotToken: 'test', telegramChatId: 'test', tursoUrl: 'file:test', tursoToken: '',
    repoLastCommitAt: null,
  };
  const result = await index.runBriefing({ triggerSource: 'cloudflare', deps: {
    db, env, runUser: async () => ({ skipped: false, errors: [new Error('isolated failure')] }),
  } });
  assert.equal(result.outcome, 'partial_failure');
  assert.equal(result.failed, 1);
  assert.equal(heartbeats.length, 0);
});
