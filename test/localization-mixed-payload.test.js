import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDb } from './localDb.js';
import { runForUser } from '../src/index.js';
import { runDaily } from '../src/daily.js';
import { staticDataSource } from '../src/dataSource.js';
import { fakeCoach } from './fakes.js';
import { makeDataset } from './fixtures.js';
import { authorizePublicBetaRuntime, createPublicBetaPresentation, publicBetaPolicy } from '../src/publicBeta.js';
import { deliverPublicBetaSummary } from '../src/publicBetaSummaryDelivery.js';

const users = [
  { id: 'alice', name: 'Alice', locale: 'zh-TW', chat: '7101', recovery: 21, factor: 'alcohol' },
  { id: 'bob', name: 'Bob', locale: 'en', chat: '7102', recovery: 34, factor: 'caffeine' },
  { id: 'linh', name: 'Linh', locale: 'vi', chat: '7103', recovery: 47, factor: 'stress' },
  { id: 'nozh', name: '', locale: 'zh-TW', chat: '7104', recovery: 60, factor: 'travel' },
  { id: 'noen', name: '', locale: 'en', chat: '7105', recovery: 73, factor: 'sauna' },
  { id: 'novi', name: '', locale: 'vi', chat: '7106', recovery: 86, factor: 'food' },
];
const env = { telegramBotToken: 'synthetic', dryRun: false, whoopClientId: 'synthetic',
  whoopClientSecret: 'synthetic', openrouterApiKey: 'synthetic', openrouterModel: 'synthetic' };
const factorText = { 'zh-TW': { alcohol:'飲酒',caffeine:'咖啡因',stress:'壓力',travel:'旅行',sauna:'三溫暖',food:'飲食' },
  en: { alcohol:'Alcohol',caffeine:'Caffeine',stress:'Stress',travel:'Travel',sauna:'Sauna',food:'Food' },
  vi: { alcohol:'Việc uống rượu',caffeine:'Caffeine',stress:'Căng thẳng',travel:'Việc đi lại',sauna:'Xông hơi',food:'Ăn uống' } };
const header = { 'zh-TW': /🌅 早安/, en: /🌅 Good morning/, vi: /🌅 Chào buổi sáng/ };
const betaTitle = { 'zh-TW': /Beta 摘要/, en: /Beta Summary/, vi: /Tóm tắt Beta/ };

test('six users get isolated locale, name, WHOOP, episode and association payloads across reverse order and restart', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'locale-payload-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const url = `file:${path.join(dir, 'test.db')}`;
  let db = createDb({ url });
  await db.migrate();
  for (const u of users) {
    await db.createUser({ id: u.id, displayName: u.name || 'Temporary', timezone: 'Asia/Taipei' });
    if (!u.name) await db.raw.execute({ sql: "UPDATE users SET display_name='' WHERE id=?", args: [u.id] });
    await db.linkTelegram({ userId: u.id, chatId: u.chat });
    await db.setLocale(u.id, u.locale);
  }
  const capability = authorizePublicBetaRuntime({ executionMode: 'SHADOW' });
  async function batch(order, now) {
    const data = Object.fromEntries(users.map(u => [u.id,
      makeDataset({ now, overrides: { 0: { recovery_score: u.recovery } }, withNaps: false })]));
    const outbound = [];
    const makeTelegram = ({ chatId }) => ({
      async send(text) { outbound.push({ chat: String(chatId), text }); return { messageId: outbound.length }; },
      async notifyError() { return true; }, async sendTyping() { return true; },
    });
    const deps = { makeTelegram, makeWhoop: ({ userId }) => ({ userId, getAccessToken: async () => 'synthetic' }),
      makeSource: ({ whoop }) => staticDataSource(data[whoop.userId]), makeCoach: () => fakeCoach(),
      makeSync: () => ({ syncAll: async () => ({}) }), daily: runDaily,
      weekly: async () => null, proactive: async () => null, reap: async () => null,
      predictionCycle: async () => null, healthspan: async () => null };
    for (const u of order) {
      const result = await runForUser({ db, env, user: await db.getUser(u.id), now, deps });
      assert.equal(result.daily?.status, 'sent', `${u.id}: ${JSON.stringify(result)}`);
    }
    assert.equal(outbound.length, users.length);
    for (const u of users) {
      const payload = outbound.find(p => p.chat === u.chat);
      assert.ok(payload, u.id);
      assert.match(payload.text, header[u.locale]);
      if (u.locale !== 'zh-TW') assert.doesNotMatch(payload.text, /[\p{Script=Han}]/u);
      if (u.locale === 'en') assert.doesNotMatch(payload.text, /Chào buổi sáng|mức nền|Tóm tắt Beta/);
      if (u.locale === 'vi') assert.doesNotMatch(payload.text, /Good morning|your baseline|Beta Summary/);
      if (u.name) assert.match(payload.text, new RegExp(u.name));
      else assert.doesNotMatch(payload.text, /Alice|Bob|Linh|Kelvin/);
      const recoveryLine = payload.text.split('\n')[1];
      assert.match(recoveryLine, new RegExp(`${u.recovery}%`));
      assert.doesNotMatch(payload.text, /Body Energy|身體能量/);
      for (const other of users.filter(x => x.id !== u.id)) {
        assert.notEqual(payload.chat, other.chat);
        assert.doesNotMatch(recoveryLine, new RegExp(`${other.recovery}%`));
      }
    }
    const stores = { withContext: async (id, options, work) => {
      assert.equal(options.executionMode, 'SHADOW'); return work({ userId: id }); },
    assertCurrent: async () => true,
    betaSummary: { readCurrent: async context => {
      const u = users.find(item => item.id === context.userId);
      return { userId: u.id, executionMode: 'SHADOW',
        episodes: [{ metricKey: 'recovery_score', direction: 'LOWER' }],
        insights: [{ status: 'SUPPORTED', claim: `${u.factor} has been repeatedly associated in your data with lower recovery_score.` }] };
    } } };
    const presentation = createPublicBetaPresentation({ stores, db,
      policy: publicBetaPolicy({ mode: 'all' }), runtimeCapability: capability });
    const summaries = [];
    for (const u of order) {
      const result = await deliverPublicBetaSummary({ db, env, user: await db.getUser(u.id),
        presentation, now, makeTelegram: ({ chatId }) => ({ async send(text) {
          summaries.push({ chat: String(chatId), text }); return { messageId: summaries.length };
        } }) });
      assert.equal(result.status, 'delivered', u.id);
    }
    for (const u of users) {
      const payload = summaries.find(p => p.chat === u.chat);
      assert.ok(payload, u.id);
      assert.match(payload.text, betaTitle[u.locale]);
      if (u.locale !== 'zh-TW') assert.doesNotMatch(payload.text, /[\p{Script=Han}]/u);
      if (u.locale === 'en') assert.doesNotMatch(payload.text, /Tóm tắt Beta|mức nền/);
      if (u.locale === 'vi') assert.doesNotMatch(payload.text, /Beta Summary|personal baseline/);
      assert.match(payload.text, new RegExp(factorText[u.locale][u.factor]));
      if (u.name) assert.match(payload.text, new RegExp(u.name));
      else assert.doesNotMatch(payload.text, /Alice|Bob|Linh|Kelvin/);
      assert.doesNotMatch(payload.text, /Body Energy|身體能量|EPISODE|RECEIPT/);
    }
  }
  await batch(users, new Date('2026-09-19T00:00:00.000Z'));
  db.close();
  db = createDb({ url });
  t.after(() => db.close());
  await batch([...users].reverse(), new Date('2026-09-20T00:00:00.000Z'));
});
