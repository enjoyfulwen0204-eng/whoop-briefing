import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@libsql/client';
import { currentVersion, runMigrations } from '../src/migrations.js';
import { applyPhase4Migrations } from '../src/phase4Migrations.js';
import { createPhase4Keys } from '../src/phase4Keys.js';

const keys = (lookup, audit) => createPhase4Keys({
  lookupKey: Buffer.alloc(32, lookup), auditKey: Buffer.alloc(32, audit),
});
const original = keys(11, 22);
const missingKeys = { code: 'PHASE4_PRIVACY_KEYS_REQUIRED' };

test('only an authority-free pre-v21 database may bootstrap v21 without keys', async t => {
  const db = createClient({ url: ':memory:' });
  t.after(() => db.close());
  await runMigrations(db, { targetVersion: 20 });
  assert.deepEqual((await runMigrations(db, { targetVersion: 21 })).versionsApplied, [21]);
  await assert.rejects(runMigrations(db, { targetVersion: 21 }), missingKeys);
  await assert.rejects(runMigrations(db, { targetVersion: 31 }), missingKeys);
  assert.equal(await currentVersion(db), 21);

  assert.deepEqual((await runMigrations(db, { targetVersion: 31, privacyKeys: original })).versionsApplied,
    [22,23,24,25,26,27,28,29,30,31]);
  assert.deepEqual((await runMigrations(db, { targetVersion: 31, privacyKeys: original })).versionsApplied, []);
  await assert.rejects(runMigrations(db, { targetVersion: 31 }), missingKeys);
  await assert.rejects(applyPhase4Migrations(db, 31, 31), missingKeys);
  for (const changed of [keys(33, 22), keys(11, 44), keys(33, 44)]) {
    await assert.rejects(runMigrations(db, { targetVersion: 31, privacyKeys: changed }),
      /PHASE4_(LOOKUP|AUDIT)_KEY_MISMATCH/);
  }
  assert.equal(await currentVersion(db), 31);
});

test('v20 to v31 requires keys before a write and then establishes both checkpoints', async t => {
  const db = createClient({ url: ':memory:' });
  t.after(() => db.close());
  await runMigrations(db, { targetVersion: 20 });
  await assert.rejects(runMigrations(db, { targetVersion: 31 }), missingKeys);
  assert.equal(await currentVersion(db), 20);
  assert.equal((await db.execute("SELECT 1 FROM sqlite_master WHERE name='phase4_migration_checkpoints'")).rows.length, 0);
  assert.deepEqual((await runMigrations(db, { targetVersion: 31, privacyKeys: original })).versionsApplied,
    [21,22,23,24,25,26,27,28,29,30,31]);
  assert.deepEqual((await db.execute(`SELECT step_key FROM phase4_migration_checkpoints
    WHERE step_key IN ('lookup_key_check','audit_key_check') ORDER BY step_key`)).rows.map(r => r.step_key),
    ['audit_key_check', 'lookup_key_check']);
});

test('checkpoint rows require keys even if the recorded version is v20', async t => {
  const db = createClient({ url: ':memory:' });
  t.after(() => db.close());
  await runMigrations(db, { targetVersion: 21 });
  await runMigrations(db, { targetVersion: 21, privacyKeys: original });
  await db.execute('DELETE FROM schema_version WHERE version=21');
  await assert.rejects(runMigrations(db, { targetVersion: 21 }), missingKeys);
  assert.equal(await currentVersion(db), 20);
});

test('interrupted v22 authority rejects missing keys before advancing and resumes with original keys', async t => {
  const db = createClient({ url: ':memory:' });
  t.after(() => db.close());
  await runMigrations(db, { targetVersion: 22, privacyKeys: original });
  const before = (await db.execute('SELECT COUNT(*) AS n FROM phase4_source_links')).rows[0].n;
  await assert.rejects(runMigrations(db, { targetVersion: 31 }), missingKeys);
  assert.equal(await currentVersion(db), 22);
  assert.equal((await db.execute('SELECT COUNT(*) AS n FROM phase4_source_links')).rows[0].n, before);
  assert.deepEqual((await runMigrations(db, { targetVersion: 31, privacyKeys: original })).versionsApplied,
    [23,24,25,26,27,28,29,30,31]);
});
