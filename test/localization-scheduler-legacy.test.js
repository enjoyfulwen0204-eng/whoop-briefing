import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDb } from './localDb.js';
import { runForUser } from '../src/index.js';
import { handleOnboardingMessage } from '../src/onboarding.js';
import { LANGUAGE_SELECTOR } from '../src/localization.js';

test('legacy READY user gets one selector, remains syncable, and resumes localized delivery after restart', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'locale-legacy-scheduler-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const url = `file:${path.join(dir, 'test.db')}`;
  let db = createDb({ url });
  await db.migrate();
  await db.createUser({ id:'legacy', displayName:'Linh', timezone:'Asia/Taipei' });
  await db.linkTelegram({ userId:'legacy', chatId:'9001' });
  await db.ensureOnboarding('legacy', { state:'READY' });
  const sent = [];
  let syncs = 0;
  let dailies = 0;
  const deps = {
    makeTelegram: ({ chatId }) => ({
      async send(text) { sent.push({ chatId:String(chatId), text }); return { messageId:sent.length }; },
      async notifyError() { return true; },
    }),
    makeWhoop: () => ({ getAccessToken: async () => 'synthetic' }),
    makeSource: () => ({}), makeCoach: () => ({}),
    makeSync: () => ({ async syncAll() { syncs++; return {}; } }),
    daily: async () => { dailies++; return { status:'sent' }; },
    weekly: async () => null, proactive: async () => null, reap: async () => null,
    predictionCycle: async () => null, healthspan: async () => null,
  };
  const env = { telegramBotToken:'synthetic', dryRun:false, whoopClientId:'synthetic',
    whoopClientSecret:'synthetic', openrouterApiKey:'synthetic', openrouterModel:'synthetic' };
  const now = new Date('2026-09-19T00:00:00.000Z');
  const run = async () => runForUser({ db, env, user:await db.getUser('legacy'), now, deps });
  assert.equal((await run()).skipped, 'locale_unset');
  assert.equal((await run()).skipped, 'locale_unset');
  assert.deepEqual(sent, [{ chatId:'9001', text:LANGUAGE_SELECTOR }]);
  assert.equal(dailies, 0);
  assert.ok(syncs >= 1, 'locale gating must not stop ordinary data sync');
  db.close();
  db = createDb({ url });
  t.after(() => db.close());
  assert.equal((await run()).skipped, 'locale_unset');
  assert.equal(sent.length, 1, 'the one-time selector claim survives restart');
  assert.equal(await db.getLocale('legacy'), null);
  assert.match(await handleOnboardingMessage({ db, user:await db.getUser('legacy'),
    text:'Tiếng Việt', now }), /sẵn sàng/);
  assert.equal(await db.getLocale('legacy'), 'vi');
  assert.equal((await run()).daily?.status, 'sent');
  assert.equal(dailies, 1);
  assert.equal(sent.length, 1, 'selection does not send another selector');
});
