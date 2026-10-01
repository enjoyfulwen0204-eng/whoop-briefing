// A separate process for the payload smoke: exercise the real scheduler user
// path after the parent process has already produced its first batch.
import { createDb } from './localDb.js';
import { runForUser } from '../src/index.js';
import { runDaily } from '../src/daily.js';
import { staticDataSource } from '../src/dataSource.js';
import { fakeCoach } from './fakes.js';
import { makeDataset } from './fixtures.js';
import { authorizePublicBetaRuntime, createPublicBetaPresentation, publicBetaPolicy } from '../src/publicBeta.js';
import { deliverPublicBetaSummary } from '../src/publicBetaSummaryDelivery.js';

const users = [
  { id: 'nameless', chatId: '1003', recovery: 45, energy: 93 },
  { id: 'bob', chatId: '1002', recovery: 81, energy: 82 },
  { id: 'alice', chatId: '1001', recovery: 21, energy: 71 },
];
const now = new Date('2026-09-20T00:00:00.000Z');
const db = createDb({ url: process.argv[2] });
const payloads = [];
const summaryPayloads = [];
try {
  const datasets = Object.fromEntries(users.map(user => [user.id,
    makeDataset({ now, overrides: { 0: { recovery_score: user.recovery } }, withNaps: false })]));
  const deps = {
    makeTelegram: ({ chatId }) => ({
      async send(text) { payloads.push({ chatId: String(chatId), text }); return { messageId: payloads.length }; },
      async notifyError() { return true; }, async sendTyping() { return true; },
    }),
    makeWhoop: ({ userId }) => ({ userId, getAccessToken: async () => 'synthetic' }),
    makeSource: ({ whoop }) => staticDataSource(datasets[whoop.userId]),
    makeCoach: () => fakeCoach(), makeSync: () => ({ syncAll: async () => ({}) }),
    daily: runDaily, weekly: async () => null, proactive: async () => null,
    reap: async () => null, predictionCycle: async () => null, healthspan: async () => null,
  };
  const env = { telegramBotToken: 'synthetic', dryRun: false, whoopClientId: 'synthetic',
    whoopClientSecret: 'synthetic', openrouterApiKey: 'synthetic', openrouterModel: 'synthetic' };
  for (const user of users) {
    const result = await runForUser({ db, env, user: await db.getUser(user.id), now, deps });
    if (result.daily?.status !== 'sent')
      throw new Error(`PAYLOAD_FAILED:${user.id}:${result.daily?.status ?? result.skipped}`);
  }
  const stores = {
    withContext: async (id, options, work) => {
      if (options.executionMode !== 'SHADOW') throw Error('MODE_MISMATCH');
      return work({ userId: id });
    },
    assertCurrent: async () => true,
    betaSummary: { readCurrent: async context => ({ userId: context.userId, executionMode: 'SHADOW',
      episodes: [{ metricKey: 'recovery_score', direction: 'LOWER', resultId: `${context.userId}-EPISODE` }],
      insights: [{ status: 'SUPPORTED', claim: `${context.userId} journal association`,
        resultId: `${context.userId}-INSIGHT` }] }) },
  };
  const presentation = createPublicBetaPresentation({ stores, db,
    policy: publicBetaPolicy({ mode: 'all' }),
    runtimeCapability: authorizePublicBetaRuntime({ executionMode: 'SHADOW' }) });
  const oldPeriod = await deliverPublicBetaSummary({ db, env,
    user: await db.getUser('alice'), presentation,
    now: new Date('2026-09-19T00:00:00.000Z'),
    makeTelegram: ({ chatId }) => ({ async send(text) {
      summaryPayloads.push({ chatId: String(chatId), text }); return { messageId: summaryPayloads.length };
    } }) });
  if (oldPeriod.status !== 'already_sent' || summaryPayloads.length !== 0)
    throw Error(`BETA_RESTART_DEDUPE_FAILED:${oldPeriod.status}`);
  for (const user of users) {
    const result = await deliverPublicBetaSummary({ db, env, user: await db.getUser(user.id),
      presentation, now, makeTelegram: ({ chatId }) => ({ async send(text) {
        summaryPayloads.push({ chatId: String(chatId), text }); return { messageId: summaryPayloads.length };
      } }) });
    if (result.status !== 'delivered') throw Error(`BETA_SUMMARY_FAILED:${user.id}:${result.status}`);
  }
  process.stdout.write(`PUBLIC_BETA_CHILD_PAYLOADS=${JSON.stringify({ payloads, summaryPayloads })}\n`);
} finally {
  db.close();
}
