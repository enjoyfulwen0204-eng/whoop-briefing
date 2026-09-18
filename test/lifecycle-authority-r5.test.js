/**
 * R5 error-evidence provenance. Real local libSQL and orchestration; Telegram and
 * WHOOP are replaced only at their external network boundaries. Races use barriers.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createDb } from '../src/db.js';
import { createTelegram } from '../src/telegram.js';
import { withDeliveryAuthorization, LifecycleContextError } from '../src/accountLifecycle.js';
import { runForUser } from '../src/index.js';
import { runGuardian } from '../src/guardian.js';
import { GUARDIAN_SIGNAL } from '../src/guardianPolicy.js';
import { userScope } from '../src/schema.js';

const NOW = new Date('2026-09-18T04:00:00.000Z');

async function setup(t, { id = 'r5-user', chatId = '51001' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whoop-r5-'));
  const db = createDb({ url: `file:${path.join(dir, 'db.sqlite')}` });
  t.after(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await db.migrate();
  const user = await db.createUser({ id, displayName: id, timezone: 'Asia/Taipei' });
  await db.linkTelegram({ chatId, userId: user.id });
  return { db, user: await db.getUser(user.id), chatId };
}

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

async function transition(db, userId, { reactivate = true } = {}) {
  await db.transitionUserLifecycle({ userId, targetStatus: 'DISABLED' });
  if (reactivate) await db.transitionUserLifecycle({ userId, targetStatus: 'ACTIVE' });
}

function userErrorTelegram(db, userId, lifecycleGeneration, sent = []) {
  const raw = createTelegram({
    db,
    errorScope: userScope(userId),
    botToken: 'test-only',
    chatId: userId,
    fetchImpl: async () => {
      sent.push(userId);
      return new Response(JSON.stringify({ ok: true, result: { message_id: sent.length } }));
    },
  });
  return withDeliveryAuthorization(
    raw,
    () => db.assertAccountActive(userId, lifecycleGeneration).then(() => true, () => false),
    { userId, expectedLifecycleGeneration: lifecycleGeneration },
  );
}

async function recordAuthFailures(db, userId, lifecycleGeneration, count = 3) {
  const sent = [];
  const telegram = userErrorTelegram(db, userId, lifecycleGeneration, sent);
  for (let i = 0; i < count; i += 1) {
    await telegram.notifyError('whoop_auth', `synthetic failure ${i + 1}`);
  }
  return sent;
}

async function errorRow(db, userId, errorType = 'whoop_auth') {
  const rs = await db.raw.execute({
    sql: `SELECT * FROM error_notifications
           WHERE scope = ? AND error_type = ?`,
    args: [userScope(userId), errorType],
  });
  return rs.rows[0] ?? null;
}

function runUser(db, user, { getAccessToken }) {
  return runForUser({
    db,
    user,
    now: NOW,
    env: { dryRun: true, whoopClientId: 'test', whoopClientSecret: 'test' },
    deps: {
      makeWhoop: () => ({ getAccessToken }),
      makeTelegram: () => ({ send: async () => ({ messageId: 1 }), notifyError: async () => false }),
      makeSource: () => ({}),
      makeCoach: () => ({}),
      daily: async () => ({ status: 'not_run' }),
      weekly: async () => ({ status: 'not_run' }),
      makeSync: () => ({ syncAll: async () => [] }),
      proactive: async () => ({}),
      predictionCycle: async () => ({}),
      healthspan: async () => ({}),
      reap: async () => 0,
    },
  });
}

async function saveToken(db, userId) {
  await db.saveTokens(userId, {
    accessToken: `access-${userId}`,
    refreshToken: `refresh-${userId}`,
    expiresAt: new Date('2026-12-31T00:00:00.000Z'),
    scope: 'offline',
    whoopUserId: `whoop-${userId}`,
  });
}

function guardianTelegram(box) {
  return {
    makeTelegram: ({ chatId }) => ({
      send: async (text) => {
        box.push({ chatId: String(chatId), text });
        return { messageId: box.length };
      },
    }),
  };
}

test('ERRPROV-R5-01: stale L1 runForUser success cannot clear three current L3 failures', async (t) => {
  const { db, user } = await setup(t);
  const gate = barrier();
  const oldRun = runUser(db, user, {
    getAccessToken: async () => {
      gate.enter();
      await gate.resume;
      return 'old-L1-token';
    },
  });
  await gate.entered;
  await transition(db, user.id);
  await recordAuthFailures(db, user.id, 3);
  const before = await errorRow(db, user.id);
  assert.equal(Number(before.lifecycle_generation), 3);
  assert.equal(Number(before.hits), 3);

  gate.release();
  const result = await oldRun;
  assert.equal(result.skipped, 'account_inactive');
  const after = await errorRow(db, user.id);
  assert.equal(Number(after.lifecycle_generation), 3);
  assert.equal(Number(after.hits), 3);
  assert.equal(after.last_notified_at, before.last_notified_at);
});

test('ERRPROV-R5-02: stale L1 success cannot clear evidence after direct disable', async (t) => {
  const { db, user } = await setup(t);
  await recordAuthFailures(db, user.id, 1, 3);
  const gate = barrier();
  const oldRun = runUser(db, user, {
    getAccessToken: async () => {
      gate.enter();
      await gate.resume;
      return 'old-L1-token';
    },
  });
  await gate.entered;
  await transition(db, user.id, { reactivate: false });
  gate.release();
  const result = await oldRun;
  assert.equal(result.skipped, 'account_inactive');
  const row = await errorRow(db, user.id);
  assert.equal(Number(row.lifecycle_generation), 1);
  assert.equal(Number(row.hits), 3);
});

test('ERRPROV-R5-03: same-lifecycle runForUser success clears its own evidence', async (t) => {
  const { db, user } = await setup(t);
  await recordAuthFailures(db, user.id, 1, 3);
  const result = await runUser(db, user, { getAccessToken: async () => 'current-token' });
  assert.equal(result.skipped, null);
  assert.equal(await errorRow(db, user.id), null);
});

test('ERRPROV-R5-04: historical L1 authentication failures do not create an L3 Guardian warning', async (t) => {
  const { db, user } = await setup(t);
  await saveToken(db, user.id);
  await recordAuthFailures(db, user.id, 1, 3);
  await transition(db, user.id);
  const box = [];
  const result = await runGuardian({ db, ...guardianTelegram(box), now: NOW });
  assert.ok(!result.findings.some((f) => f.signal === GUARDIAN_SIGNAL.WHOOP_AUTH_REPEATED_FAILURE));
  assert.deepEqual(box, []);
  assert.equal(Number((await errorRow(db, user.id)).lifecycle_generation), 1);
});

test('ERRPROV-R5-05: three current L3 failures authorize a valid L3 Guardian warning', async (t) => {
  const { db, user, chatId } = await setup(t);
  await saveToken(db, user.id);
  await transition(db, user.id);
  await recordAuthFailures(db, user.id, 3, 3);
  const box = [];
  const result = await runGuardian({ db, ...guardianTelegram(box), now: NOW });
  const finding = result.findings.find((f) => f.signal === GUARDIAN_SIGNAL.WHOOP_AUTH_REPEATED_FAILURE);
  assert.equal(finding.lifecycleGeneration, 3);
  assert.equal(result.notified, 1);
  assert.equal(box.length, 1);
  assert.equal(box[0].chatId, String(chatId));
});

test('ERRPROV-R5-06: current L3 evidence starts at one and never aggregates three historical L1 failures', async (t) => {
  const { db, user } = await setup(t);
  await saveToken(db, user.id);
  await recordAuthFailures(db, user.id, 1, 3);
  await transition(db, user.id);
  await recordAuthFailures(db, user.id, 3, 1);
  const row = await errorRow(db, user.id);
  assert.equal(Number(row.lifecycle_generation), 3);
  assert.equal(Number(row.hits), 1);
  const box = [];
  const result = await runGuardian({ db, ...guardianTelegram(box), now: NOW });
  assert.ok(!result.findings.some((f) => f.signal === GUARDIAN_SIGNAL.WHOOP_AUTH_REPEATED_FAILURE));
  assert.deepEqual(box, []);
});

test('ERRPROV-R5-07: Alice lifecycle evidence cannot clear, aggregate with, or notify for Bob', async (t) => {
  const { db, user: alice } = await setup(t, { id: 'alice', chatId: '51001' });
  const bob = await db.createUser({ id: 'bob', displayName: 'Bob', timezone: 'Asia/Taipei' });
  await db.linkTelegram({ chatId: '51002', userId: bob.id });
  await saveToken(db, alice.id);
  await saveToken(db, bob.id);
  await recordAuthFailures(db, alice.id, 1, 3);
  await recordAuthFailures(db, bob.id, 1, 3);
  await db.clearUserErrorNotify(alice.id, 'whoop_auth', { expectedLifecycleGeneration: 1 });
  assert.equal(await errorRow(db, alice.id), null);
  assert.equal(Number((await errorRow(db, bob.id)).hits), 3);

  const box = [];
  const result = await runGuardian({ db, ...guardianTelegram(box), now: NOW });
  const authFindings = result.findings.filter(
    (f) => f.signal === GUARDIAN_SIGNAL.WHOOP_AUTH_REPEATED_FAILURE,
  );
  assert.deepEqual(authFindings.map((f) => f.scope), [userScope(bob.id)]);
  assert.deepEqual(box.map((m) => m.chatId), ['51002']);
});

test('R5 contracts: user error claim/read/clear reject missing lifecycle provenance', async (t) => {
  const { db, user } = await setup(t);
  await assert.rejects(
    () => db.claimUserErrorNotify(user.id, 'whoop_auth', 2),
    LifecycleContextError,
  );
  await assert.rejects(
    () => db.getErrorNotification(userScope(user.id), 'whoop_auth'),
    LifecycleContextError,
  );
  await assert.rejects(
    () => db.clearUserErrorNotify(user.id, 'whoop_auth'),
    LifecycleContextError,
  );
  await assert.rejects(
    () => db.hasErrorNotify(userScope(user.id), 'whoop_auth'),
    LifecycleContextError,
  );
  await assert.rejects(
    () => db.releaseErrorNotify(userScope(user.id), 'whoop_auth', '2026-09-18T00:00:00.000Z'),
    LifecycleContextError,
  );
});
