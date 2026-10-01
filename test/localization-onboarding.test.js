import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDb } from './localDb.js';
import { handleUnlinkedMessage, handleOnboardingMessage, handleLocaleOnlyMessage } from '../src/onboarding.js';
import { LANGUAGE_SELECTOR } from '../src/localization.js';

const args = { clientId: 'synthetic', redirectUri: 'https://example.test/callback',
  now: new Date('2026-10-01T00:00:00.000Z') };
const message = { from: { id: 123, first_name: 'Linh' }, chat: { id: 123, type: 'private' } };

test('language is the first onboarding choice, survives restart, and latest valid choice wins', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'locale-onb-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const url = `file:${path.join(dir, 'test.db')}`;
  let db = createDb({ url });
  await db.migrate();
  const start = () => handleUnlinkedMessage({ db, text: '/start', chatId: '123', message,
    isPrivateChat: true, ...args });
  assert.equal(await start(), LANGUAGE_SELECTOR);
  const id = (await db.resolveUserByChatId('123')).user.id;
  assert.equal(await db.getLocale(id), null);
  db.close();
  db = createDb({ url });
  const user = (await db.resolveUserByChatId('123')).user;
  const select = text => handleOnboardingMessage({ db, user, text, ...args });
  assert.equal(await select('fr'), LANGUAGE_SELECTOR);
  assert.equal(await db.getLocale(id), null);
  assert.match(await select('English'), /Welcome/);
  assert.equal(await db.getLocale(id), 'en');
  assert.match(await select('English'), /timezone/i);
  assert.match(await select('Tiếng Việt'), /múi giờ/);
  assert.equal(await db.getLocale(id), 'vi');
  assert.match(await select('not-a-timezone'), /múi giờ/);
  assert.equal(await db.getLocale(id), 'vi');
  db.close();
  db = createDb({ url });
  t.after(() => db.close());
  assert.equal(await db.getLocale(id), 'vi');
  assert.match(await handleOnboardingMessage({ db, user: (await db.getUser(id)),
    text: '/start', ...args }), /múi giờ/);
});

test('legacy READY user is UNSET until chosen; account identity and onboarding stay intact', async t => {
  const db = createDb({ url: ':memory:' });
  t.after(() => db.close());
  await db.migrate();
  await db.createUser({ id: 'legacy', displayName: 'Alice', timezone: 'Asia/Taipei' });
  await db.linkTelegram({ userId: 'legacy', chatId: '456' });
  await db.ensureOnboarding('legacy', { state: 'READY' });
  const user = await db.getUser('legacy');
  const before = await db.getOnboarding('legacy');
  assert.equal(await handleOnboardingMessage({ db, user, text: '/start', ...args }), LANGUAGE_SELECTOR);
  assert.equal(await db.getLocale('legacy'), null);
  assert.match(await handleOnboardingMessage({ db, user, text: '繁體中文', ...args }), /準備好了/);
  assert.equal(await db.getLocale('legacy'), 'zh-TW');
  assert.equal((await db.getUser('legacy')).displayName, 'Alice');
  assert.equal((await db.getOnboarding('legacy')).state, before.state);
  assert.notEqual(await handleOnboardingMessage({ db, user, text: '/status', ...args }), LANGUAGE_SELECTOR);
});

test('new user without a Telegram name keeps a blank canonical name for neutral greetings', async t => {
  const db = createDb({ url: ':memory:' });
  t.after(() => db.close());
  await db.migrate();
  const anonymous = { from:{ id:789 }, chat:{ id:789, type:'private' } };
  assert.equal(await handleUnlinkedMessage({ db, text:'/start', chatId:'789',
    message:anonymous, isPrivateChat:true, ...args }), LANGUAGE_SELECTOR);
  const user = (await db.resolveUserByChatId('789')).user;
  assert.equal(user.displayName, '');
  assert.equal(await db.getLocale(user.id), null);
});

test('bound legacy accounts can select a locale while self-service OAuth is disabled', async t => {
  const db = createDb({ url: ':memory:' });
  t.after(() => db.close());
  await db.migrate();
  const user = await db.createUser({ id:'legacy-offline-oauth', displayName:'Bob' });
  assert.equal(await handleLocaleOnlyMessage({ db, user, text:'/status' }), LANGUAGE_SELECTOR);
  assert.match(await handleLocaleOnlyMessage({ db, user, text:'English' }), /English selected/);
  assert.equal(await db.getLocale(user.id), 'en');
  assert.equal(await handleLocaleOnlyMessage({ db, user, text:'/status' }), null);
});

test('repeating the same language in authorization setup does not mint another OAuth link', async t => {
  const db = createDb({ url: ':memory:' });
  t.after(() => db.close());
  await db.migrate();
  const user = await db.createUser({ id:'repeat-language', displayName:'Bob' });
  await db.ensureOnboarding(user.id, { state:'WHOOP_AUTH_PENDING' });
  await db.setLocale(user.id, 'en');
  const reply = await handleOnboardingMessage({ db, user, text:'English', ...args });
  assert.match(reply, /Use \/connect/);
  assert.equal(await db.getLocale(user.id), 'en');
  const rows = (await db.raw.execute({ sql:'SELECT COUNT(*) n FROM oauth_states WHERE user_id=?',
    args:[user.id] })).rows;
  assert.equal(Number(rows[0].n), 0);
});
