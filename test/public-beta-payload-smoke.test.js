import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createDb } from './localDb.js';
import { runForUser } from '../src/index.js';
import { runDaily } from '../src/daily.js';
import { runWeekly } from '../src/weekly.js';
import { staticDataSource } from '../src/dataSource.js';
import { fakeCoach } from './fakes.js';
import { makeDataset } from './fixtures.js';
import { mapWithConcurrency } from '../src/concurrency.js';
import { authorizePublicBetaRuntime, createPublicBetaPresentation, publicBetaPolicy } from '../src/publicBeta.js';
import { deliverPublicBetaSummary } from '../src/publicBetaSummaryDelivery.js';

const users = [
  { id: 'alice', displayName: 'Alice', chatId: '1001', recovery: 21, energy: 71 },
  { id: 'bob', displayName: 'Bob', chatId: '1002', recovery: 81, energy: 82 },
  { id: 'nameless', displayName: '', chatId: '1003', recovery: 45, energy: 93 },
];
const env = { telegramBotToken: 'synthetic', dryRun: false, whoopClientId: 'synthetic',
  whoopClientSecret: 'synthetic', openrouterApiKey: 'synthetic', openrouterModel: 'synthetic' };

test('actual pre-transport daily payload binds user, chat, name and WHOOP across order and restart without Body Energy', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beta-payload-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const url = `file:${path.join(dir, 'beta.db')}`;
  let db = createDb({ url });
  await db.migrate();
  for (const user of users) {
    await db.createUser({ id: user.id, displayName: user.displayName || 'Temporary', timezone: 'Asia/Taipei' });
    if (!user.displayName) await db.raw.execute("UPDATE users SET display_name='' WHERE id='nameless'");
    await db.linkTelegram({ userId: user.id, chatId: user.chatId });
  }
  let currentHealthDate = '2026-09-19';

  async function batch(order, now) {
    currentHealthDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei',
      year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
    const datasets = Object.fromEntries(users.map(user => [user.id,
      makeDataset({ now, overrides: { 0: { recovery_score: user.recovery } }, withNaps: false })]));
    const payloads = [];
    const deps = {
      makeTelegram: ({ chatId }) => ({
        async send(text) { payloads.push({ chatId: String(chatId), text }); return { messageId: payloads.length }; },
        async notifyError() { return true; },
        async sendTyping() { return true; },
      }),
      makeWhoop: ({ userId }) => ({ userId, getAccessToken: async () => 'synthetic' }),
      makeSource: ({ whoop }) => staticDataSource(datasets[whoop.userId]),
      makeCoach: () => fakeCoach(), makeSync: () => ({ syncAll: async () => ({}) }),
      daily: runDaily, weekly: async () => null, proactive: async () => null,
      reap: async () => null, predictionCycle: async () => null, healthspan: async () => null,
    };
    const results = await mapWithConcurrency(order, 3, async user =>
      runForUser({ db, env, user: await db.getUser(user.id), now, deps }));
    for (const [index, result] of results.entries()) {
      assert.equal(result.ok, true, order[index].id);
      assert.equal(result.value.daily?.status, 'sent',
        `${order[index].id}: ${JSON.stringify(result.value.errors)}`);
    }
    assert.equal(payloads.length, 3);
    for (const user of users) {
      const payload = payloads.find(p => p.chatId === user.chatId);
      assert.ok(payload);
      assert.match(payload.text, new RegExp(`恢復 ${user.recovery}%`));
      assert.doesNotMatch(payload.text, /身體能量|Body Energy|Phase 4 Beta/);
      assert.match(payload.text, user.displayName ? new RegExp(`🌅 早安，${user.displayName}`) : /🌅 早安\n/);
      for (const other of users.filter(item => item.id !== user.id)) {
        assert.doesNotMatch(payload.text, new RegExp(`恢復 ${other.recovery}%`));
        if (other.displayName) assert.doesNotMatch(payload.text, new RegExp(other.displayName));
        assert.notEqual(payload.chatId, other.chatId);
      }
      assert.doesNotMatch(payload.text, /Kelvin/);
      assert.doesNotMatch(payload.text, /-(?:RECEIPT|EPISODE|JOURNAL|INSIGHT)/,
        'internal Phase 4 evidence and non-presented intelligence stay out of outbound text');
    }
    if (currentHealthDate === '2026-09-19') console.log(JSON.stringify({
      syntheticSmoke: true, healthDate: currentHealthDate,
      payloads: payloads.map(payload => ({ recipient: payload.chatId,
        userId: users.find(user => user.chatId === payload.chatId).id,
        body: payload.text })),
    }));
  }

  await batch(users, new Date('2026-09-19T00:00:00.000Z'));
  const betaStores = {
    withContext: async (id, options, work) => {
      assert.equal(options.executionMode, 'SHADOW'); return work({ userId: id }); },
    assertCurrent: async () => true,
    betaSummary: { readCurrent: async context => ({ userId: context.userId, executionMode: 'SHADOW',
      episodes: [{ metricKey: 'recovery_score', direction: context.userId === 'bob' ? 'HIGHER' : 'LOWER',
        resultId: `${context.userId}-EPISODE` }],
      insights: [{ status: 'SUPPORTED', claim: `${context.userId} journal association`,
        resultId: `${context.userId}-INSIGHT`, receipt: `${context.userId}-RECEIPT` }] }) },
  };
  const capability = authorizePublicBetaRuntime({ executionMode: 'SHADOW' });
  const beta = policy => createPublicBetaPresentation({ stores: betaStores, db, policy, runtimeCapability: capability });
  const summaryPayloads = [];
  const summarySender = ({ chatId }) => ({ async send(text) {
    summaryPayloads.push({ chatId: String(chatId), text }); return { messageId: summaryPayloads.length };
  } });
  const firstSummaryDay = new Date('2026-09-19T00:00:00.000Z');
  for (const user of users) {
    const result = await deliverPublicBetaSummary({ db, env, user: await db.getUser(user.id),
      presentation: beta(publicBetaPolicy({ mode: 'all' })), now: firstSummaryDay,
      makeTelegram: summarySender });
    assert.equal(result.status, 'delivered');
  }
  assert.equal(summaryPayloads.length, 3);
  for (const user of users) {
    const payload = summaryPayloads.find(item => item.chatId === user.chatId);
    assert.ok(payload);
    assert.match(payload.text, user.displayName ? new RegExp(`Beta 摘要（${user.displayName}）`) : /Beta 摘要\n/);
    assert.match(payload.text, new RegExp(`${user.id} journal association`));
    assert.match(payload.text, user.id === 'bob' ? /恢復分數高於/ : /恢復分數低於/);
    assert.doesNotMatch(payload.text, /Kelvin|Body Energy|身體能量|EPISODE|INSIGHT|RECEIPT/);
    for (const other of users.filter(item => item.id !== user.id)) {
      assert.doesNotMatch(payload.text, new RegExp(`${other.id} journal association`));
      if (other.displayName) assert.doesNotMatch(payload.text, new RegExp(other.displayName));
    }
  }
  const duplicate = await deliverPublicBetaSummary({ db, env, user: await db.getUser('alice'),
    presentation: beta(publicBetaPolicy({ mode: 'all' })), now: firstSummaryDay,
    makeTelegram: summarySender });
  assert.equal(duplicate.status, 'already_sent');
  assert.equal(summaryPayloads.length, 3);
  console.log(JSON.stringify({ syntheticBetaSummarySmoke: true, payloads: summaryPayloads }));
  db.close();
  db = createDb({ url });
  const childOutput = execFileSync(process.execPath,
    [new URL('./publicBetaPayloadChild.js', import.meta.url).pathname, url],
    { encoding: 'utf8', timeout: 20000 });
  const childLine = childOutput.split('\n').find(line => line.startsWith('PUBLIC_BETA_CHILD_PAYLOADS='));
  assert.ok(childLine, 'separate process must capture pre-transport payloads');
  const child = JSON.parse(childLine.slice('PUBLIC_BETA_CHILD_PAYLOADS='.length));
  assert.equal(child.payloads.length, 3);
  assert.equal(child.summaryPayloads.length, 3);
  for (const user of users) {
    const summary = child.summaryPayloads.find(item => item.chatId === user.chatId)?.text;
    assert.ok(summary);
    assert.match(summary, new RegExp(`${user.id} journal association`));
    assert.doesNotMatch(summary, /Kelvin|Body Energy|身體能量|EPISODE|INSIGHT|RECEIPT/);
  }
  for (const user of users) {
    const payload = child.payloads.find(item => item.chatId === user.chatId);
    assert.ok(payload);
    assert.match(payload.text, new RegExp(`恢復 ${user.recovery}%`));
    assert.doesNotMatch(payload.text, /身體能量|Body Energy|Phase 4 Beta/);
    assert.match(payload.text, user.displayName ? new RegExp(`🌅 早安，${user.displayName}`) : /🌅 早安\n/);
    assert.doesNotMatch(payload.text, /Kelvin|-(?:RECEIPT|EPISODE|JOURNAL|INSIGHT)/);
    for (const other of users.filter(item => item.id !== user.id)) {
      assert.doesNotMatch(payload.text, new RegExp(`恢復 ${other.recovery}%`));
      if (other.displayName) assert.doesNotMatch(payload.text, new RegExp(other.displayName));
    }
  }
  await batch(users, new Date('2026-09-21T00:00:00.000Z'));
  for (const user of users) assert.equal((await deliverPublicBetaSummary({ db, env,
    user: await db.getUser(user.id), presentation: beta(publicBetaPolicy()),
    now: new Date('2026-09-21T00:00:00.000Z'), makeTelegram: summarySender })).status, 'not_eligible');
  assert.equal(summaryPayloads.length, 3, 'OFF rollback sends no new Beta Summary');
  const overlapping = await Promise.all(Array.from({ length: 3 }, () =>
    deliverPublicBetaSummary({ db, env, user: { id: 'alice' },
      presentation: beta(publicBetaPolicy({ mode: 'all' })),
      now: new Date('2026-09-22T00:00:00.000Z'), makeTelegram: summarySender })));
  assert.equal(overlapping.filter(item => item.status === 'delivered').length, 1);
  assert.equal(summaryPayloads.length, 4, 'overlapping scheduler calls send only once');
  let currentChecks = 0;
  const stalePresentation = createPublicBetaPresentation({ stores: {
    ...betaStores, assertCurrent: async () => {
      if (++currentChecks === 2) throw new Error('generation_changed_before_send');
    },
  }, db, policy: publicBetaPolicy({ mode: 'all' }), runtimeCapability: capability });
  const staleDay = new Date('2026-09-23T00:00:00.000Z');
  const stale = await deliverPublicBetaSummary({ db, env, user: { id: 'alice' },
    presentation: stalePresentation, now: staleDay, makeTelegram: summarySender });
  assert.equal(stale.status, 'definite_failure');
  assert.equal(summaryPayloads.length, 4, 'stale context is fenced before transport');
  const recovered = await deliverPublicBetaSummary({ db, env, user: { id: 'alice' },
    presentation: beta(publicBetaPolicy({ mode: 'all' })), now: staleDay,
    makeTelegram: summarySender });
  assert.equal(recovered.status, 'delivered');
  assert.equal(summaryPayloads.length, 5, 'a definite pre-send failure can be retried');
  let semanticReads = 0;
  const expiringPresentation = createPublicBetaPresentation({ stores: {
    ...betaStores, betaSummary: { readCurrent: async context => {
      if (++semanticReads === 1) return betaStores.betaSummary.readCurrent(context);
      return { userId: context.userId, executionMode: 'SHADOW', episodes: [], insights: [] };
    } },
  }, db, policy: publicBetaPolicy({ mode: 'all' }), runtimeCapability: capability });
  const expired = await deliverPublicBetaSummary({ db, env, user: { id: 'alice' },
    presentation: expiringPresentation, now: new Date('2026-09-24T00:00:00.000Z'),
    makeTelegram: summarySender });
  assert.equal(expired.status, 'definite_failure');
  assert.equal(summaryPayloads.length, 5, 'semantic expiry before send is withheld');
  const weeklyNow = new Date('2026-09-21T00:00:00.000Z');
  const weeklyPayloads = [];
  for (const user of users) {
    const chatId = await db.getActiveChatIdForUser(user.id);
    const result = await runWeekly({ db, userId: user.id, timezone: 'Asia/Taipei',
      expectedLifecycleGeneration: 1, now: weeklyNow,
      source: staticDataSource(makeDataset({ now: weeklyNow, withNaps: false })), coach: fakeCoach(),
      telegram: { async send(text) { weeklyPayloads.push({ chatId, text }); return { messageId: weeklyPayloads.length }; } } });
    assert.equal(result.status, 'sent');
  }
  for (const user of users) {
    const message = weeklyPayloads.find(payload => payload.chatId === user.chatId)?.text;
    assert.ok(message);
    assert.match(message, user.displayName ? new RegExp(`上週回顧（${user.displayName}）`) : /📅 上週回顧\n/);
    assert.doesNotMatch(message, /Kelvin/);
  }
  db.close();
});
