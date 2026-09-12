import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import {
  BRIEFING_TRIGGER, canonicalTriggerMessage, signTriggerRequest, verifyTriggerRequest,
} from '../src/briefingTriggerAuth.js';
import { createBriefingEndpoint } from '../src/briefingEndpoint.js';
import { checkPeerScheduler } from '../src/schedulerWatchdog.js';
import { HEARTBEAT_COMPONENT } from '../src/guardianPolicy.js';
import { signRequest, retryableStatus, invoke } from '../cloudflare/briefing-scheduler/worker.js';
import { BRIEFING_STATUS, renderBriefingStatus } from '../src/briefingStatus.js';

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
  assert.equal((await endpoint(request(args, sig), '{}')).status, 207);
});

test('Worker retries only bounded transport/temporary failures and reuses request metadata', async () => {
  assert.equal(retryableStatus(503), true);
  assert.equal(retryableStatus(401), false);
  const requests = [];
  const statuses = [503, 502, 200];
  const result = await invoke({
    BRIEFING_ENDPOINT_URL: 'https://example.invalid/internal/briefing/run',
    BRIEFING_TRIGGER_SECRET: SECRET,
  }, {
    now: () => NOW, sleep: async () => {},
    fetchImpl: async (_url, options) => {
      requests.push(options);
      const status = statuses.shift();
      return { status, ok: status === 200, text: async () => '' };
    },
  });
  assert.equal(result.attempt, 3);
  assert.equal(requests.length, 3);
  assert.equal(new Set(requests.map((r) => r.headers['x-briefing-request-id'])).size, 1);
  assert.equal(new Set(requests.map((r) => r.headers['x-briefing-signature'])).size, 1);

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

test('reciprocal watchdog distinguishes healthy, stale, unknown, and alert failure', async () => {
  const notices = [];
  const systemTelegram = { notifyError: async (...v) => { notices.push(v); return true; } };
  const db = { getHeartbeat: async (_scope, component) => component === HEARTBEAT_COMPONENT.GITHUB
    ? { lastOkAt: new Date(NOW - 60_000).toISOString() } : null };
  assert.equal((await checkPeerScheduler({ db, source: 'cloudflare', systemTelegram, now: new Date(NOW) })).status, 'healthy');
  db.getHeartbeat = async () => ({ lastOkAt: new Date(NOW - 3 * 60 * 60_000).toISOString() });
  assert.equal((await checkPeerScheduler({ db, source: 'cloudflare', systemTelegram, now: new Date(NOW) })).status, 'stale');
  assert.equal(notices.length, 1);
  db.getHeartbeat = async () => null;
  assert.equal((await checkPeerScheduler({ db, source: 'github', systemTelegram, now: new Date(NOW) })).status, 'unknown');
  db.getHeartbeat = async () => { throw new Error('db timeout'); };
  assert.equal((await checkPeerScheduler({ db, source: 'github', systemTelegram, now: new Date(NOW) })).status, 'unknown');
});

test('briefing status reports each provider independently without promising timing when both stale', () => {
  const one = renderBriefingStatus({
    status: BRIEFING_STATUS.WAITING_FOR_SLEEP_DATA,
    evidence: { cloudflare_stale: true, github_stale: false, scheduler_stale: false },
  });
  assert.match(one, /Cloudflare/);
  assert.match(one, /GitHub/);
  const both = renderBriefingStatus({
    status: BRIEFING_STATUS.SCHEDULER_STALE,
    evidence: { cloudflare_stale: true, github_stale: true, scheduler_stale: true },
  });
  assert.match(both, /都沒有心跳/);
  assert.doesNotMatch(both, /10 分鐘|一小時後/);
});

test('CLI and Render endpoint reference the same exported canonical runner', async () => {
  const index = await import('../src/index.js');
  assert.equal(index.main, index.runBriefing);
  const webhookSource = (await import('node:fs')).readFileSync('src/bot/webhook.js', 'utf8');
  assert.match(webhookSource, /import \{ runBriefing \} from '\.\.\/index\.js'/);
  assert.doesNotMatch(webhookSource, /exec|spawn|npm start/);
});
