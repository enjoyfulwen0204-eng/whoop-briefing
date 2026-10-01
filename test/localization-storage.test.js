import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDb } from './localDb.js';
import { assertPhase4Schema } from '../src/phase4Migrations.js';
import { currentVersion } from '../src/migrations.js';
import { normalizeLocale, validateCatalogs, formatLocalDate } from '../src/localization.js';
import { buildV31 } from '../src/phase4V31Schema.js';

test('v30 to v31 preserves legacy users as UNSET and persists isolated canonical locales across restart', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'locale-v31-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const url = `file:${path.join(dir, 'test.db')}`;
  let db = createDb({ url });
  await db.migrate({ targetVersion: 30 });
  for (const id of ['alice','bob','linh','legacy'])
    await db.createUser({ id, displayName: id });
  assert.equal(await currentVersion(db.raw), 30);
  await db.migrate();
  assert.equal(await assertPhase4Schema(db.raw, 31), 31);
  for (const id of ['alice','bob','linh','legacy']) assert.equal(await db.getLocale(id), null);
  await db.setLocale('alice','zh-TW');
  await db.setLocale('bob','en');
  await db.setLocale('linh','vi');
  await db.setLocale('linh','vi');
  await assert.rejects(db.setLocale('legacy','fr'), /UNSUPPORTED/);
  assert.equal(await db.getLocale('legacy'), null);
  assert.equal(await db.claimLocalePrompt('legacy'), true);
  assert.equal(await db.claimLocalePrompt('legacy'), false);
  await db.releaseLocalePrompt('legacy');
  assert.equal(await db.claimLocalePrompt('legacy'), true, 'failed delivery can retry its one-time prompt');
  db.close();
  db = createDb({ url });
  t.after(() => db.close());
  await db.migrate();
  assert.deepEqual(await Promise.all(['alice','bob','linh','legacy'].map(id => db.getLocale(id))),
    ['zh-TW','en','vi',null]);
  await db.setLocale('legacy','en');
  assert.equal(await db.getLocale('legacy'),'en');
});

test('catalog keys and placeholders are complete; dates format by locale without changing the calendar day', () => {
  assert.equal(validateCatalogs(), true);
  assert.equal(normalizeLocale('繁體中文'),'zh-TW');
  assert.equal(normalizeLocale('English'),'en');
  assert.equal(normalizeLocale('Tiếng Việt'),'vi');
  assert.equal(normalizeLocale('fr'),null);
  assert.match(formatLocalDate('2026-09-19','zh-TW'), /9\/19/);
  assert.match(formatLocalDate('2026-09-19','en'), /Sep/);
  assert.match(formatLocalDate('2026-09-19','vi'), /thg 9/);
});

test('v31 resumes an interrupted DDL, reruns safely, and rejects a drifted locale table', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'locale-v31-partial-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const db = createDb({ url: `file:${path.join(dir, 'test.db')}` });
  t.after(() => db.close());
  await db.migrate({ targetVersion: 30 });
  await db.createUser({ id: 'legacy', displayName: 'Legacy' });
  await db.raw.execute(buildV31().ddl[0]);
  assert.equal(await currentVersion(db.raw), 30);
  await db.migrate();
  await db.migrate();
  assert.equal(await assertPhase4Schema(db.raw, 31), 31);
  assert.equal(await db.getLocale('legacy'), null);
  await db.raw.execute('ALTER TABLE user_locales ADD COLUMN invented TEXT');
  await assert.rejects(assertPhase4Schema(db.raw, 31), /postcondition/);
});
