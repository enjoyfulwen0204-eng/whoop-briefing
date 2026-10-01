// A separate process for the payload smoke: exercise the real scheduler user
// path after the parent process has already produced its first batch.
import { createDb } from './localDb.js';
import { runForUser } from '../src/index.js';
import { runDaily } from '../src/daily.js';
import { staticDataSource } from '../src/dataSource.js';
import { fakeCoach } from './fakes.js';
import { makeDataset } from './fixtures.js';
import { authorizePublicBetaRuntime, createPublicBetaPresentation, publicBetaPolicy } from '../src/publicBeta.js';

const users = [
  { id: 'nameless', chatId: '1003', recovery: 45, energy: 93 },
  { id: 'bob', chatId: '1002', recovery: 81, energy: 82 },
  { id: 'alice', chatId: '1001', recovery: 21, energy: 71 },
];
const now = new Date('2026-09-20T00:00:00.000Z');
const db = createDb({ url: process.argv[2] });
const payloads = [];
const readRefs = [];
try {
  const stores = {
    withContext: async (id, options, work) => {
      if (options.executionMode !== 'SHADOW') throw new Error('MODE_MISMATCH');
      return work({ userId: id });
    },
    bodyEnergy: { readLatestCurrent: async context => {
      const resultId = `synthetic-${context.userId}-body-result`;
      readRefs.push({ userId: context.userId, resultId });
      return { row: { user_id: context.userId, execution_mode: 'SHADOW',
        health_date: '2026-09-20', result_id: resultId },
      calculation: { value: users.find(user => user.id === context.userId).energy } };
    } },
  };
  const betaPresentation = createPublicBetaPresentation({ stores,
    policy: publicBetaPolicy({ mode: 'all' }),
    runtimeCapability: authorizePublicBetaRuntime({ executionMode: 'SHADOW' }) });
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
    betaPresentation,
  };
  const env = { telegramBotToken: 'synthetic', dryRun: false, whoopClientId: 'synthetic',
    whoopClientSecret: 'synthetic', openrouterApiKey: 'synthetic', openrouterModel: 'synthetic' };
  for (const user of users) {
    const result = await runForUser({ db, env, user: await db.getUser(user.id), now, deps });
    if (result.daily?.status !== 'sent')
      throw new Error(`PAYLOAD_FAILED:${user.id}:${result.daily?.status ?? result.skipped}`);
  }
  process.stdout.write(`PUBLIC_BETA_CHILD_PAYLOADS=${JSON.stringify({ payloads, readRefs })}\n`);
} finally {
  db.close();
}
