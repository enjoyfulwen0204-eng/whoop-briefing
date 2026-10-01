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
import { authorizePublicBetaRuntime, createPublicBetaPresentation, publicBetaPolicy } from '../src/publicBeta.js';
import { mapWithConcurrency } from '../src/concurrency.js';

const users = [
  { id: 'alice', displayName: 'Alice', chatId: '1001', recovery: 21, energy: 71 },
  { id: 'bob', displayName: 'Bob', chatId: '1002', recovery: 81, energy: 82 },
  { id: 'nameless', displayName: '', chatId: '1003', recovery: 45, energy: 93 },
];
const env = { telegramBotToken: 'synthetic', dryRun: false, whoopClientId: 'synthetic',
  whoopClientSecret: 'synthetic', openrouterApiKey: 'synthetic', openrouterModel: 'synthetic' };

test('actual pre-transport daily payload binds user, chat, name, WHOOP and beta result across order and restart', async t => {
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
  const policy = publicBetaPolicy({ mode: 'all' });
  const readRefs = [];
  const stores = {
    withContext: async (id, options, work) => {
      assert.equal(options.executionMode, 'SHADOW');
      return work({ userId: id });
    },
    bodyEnergy: { readLatestCurrent: async context => {
      const resultId = `synthetic-${context.userId}-body-result`;
      readRefs.push({ userId: context.userId, resultId });
      return { row: { user_id: context.userId, execution_mode: 'SHADOW',
        health_date: currentHealthDate, result_id: resultId,
        receipt_marker: `${context.userId}-RECEIPT`, episode_marker: `${context.userId}-EPISODE` },
      calculation: { value: users.find(user => user.id === context.userId).energy,
        journal_marker: `${context.userId}-JOURNAL`, insight_marker: `${context.userId}-INSIGHT` } };
    } },
  };
  let currentHealthDate = '2026-09-19';
  const runtimeCapability = authorizePublicBetaRuntime({ executionMode: 'SHADOW' });
  const betaPresentation = createPublicBetaPresentation({ stores, policy, runtimeCapability });

  async function batch(order, now, presentation = betaPresentation) {
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
      betaPresentation: presentation,
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
      if (presentation === betaPresentation) assert.match(payload.text, new RegExp(`身體能量 ${user.energy}/100`));
      else assert.doesNotMatch(payload.text, /身體能量/);
      assert.match(payload.text, user.displayName ? new RegExp(`🌅 早安，${user.displayName}`) : /🌅 早安\n/);
      for (const other of users.filter(item => item.id !== user.id)) {
        assert.doesNotMatch(payload.text, new RegExp(`身體能量 ${other.energy}/100`));
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
        resultId: readRefs.find(ref => ref.userId === users.find(user => user.chatId === payload.chatId).id)?.resultId,
        body: payload.text })),
    }));
  }

  await batch(users, new Date('2026-09-19T00:00:00.000Z'));
  db.close();
  db = createDb({ url });
  const childOutput = execFileSync(process.execPath,
    [new URL('./publicBetaPayloadChild.js', import.meta.url).pathname, url],
    { encoding: 'utf8', timeout: 20000 });
  const childLine = childOutput.split('\n').find(line => line.startsWith('PUBLIC_BETA_CHILD_PAYLOADS='));
  assert.ok(childLine, 'separate process must capture pre-transport payloads');
  const child = JSON.parse(childLine.slice('PUBLIC_BETA_CHILD_PAYLOADS='.length));
  assert.deepEqual(child.readRefs.map(ref => ref.userId), ['nameless', 'bob', 'alice']);
  assert.equal(child.payloads.length, 3);
  for (const user of users) {
    const payload = child.payloads.find(item => item.chatId === user.chatId);
    assert.ok(payload);
    assert.match(payload.text, new RegExp(`恢復 ${user.recovery}%`));
    assert.match(payload.text, new RegExp(`身體能量 ${user.energy}/100`));
    assert.match(payload.text, user.displayName ? new RegExp(`🌅 早安，${user.displayName}`) : /🌅 早安\n/);
    assert.doesNotMatch(payload.text, /Kelvin|-(?:RECEIPT|EPISODE|JOURNAL|INSIGHT)/);
    for (const other of users.filter(item => item.id !== user.id)) {
      assert.doesNotMatch(payload.text, new RegExp(`恢復 ${other.recovery}%|身體能量 ${other.energy}/100`));
      if (other.displayName) assert.doesNotMatch(payload.text, new RegExp(other.displayName));
    }
  }
  await batch(users, new Date('2026-09-21T00:00:00.000Z'),
    createPublicBetaPresentation({ stores, policy: publicBetaPolicy(), runtimeCapability }));
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
