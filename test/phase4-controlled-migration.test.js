import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createClient } from '@libsql/client';
import { runMigrations } from '../src/migrations.js';
import { main } from '../scripts/phase4-migrate.js';
import { createPhase4Keys } from '../src/phase4Keys.js';

test('controlled CLI rehearses populated v20 through v31, then restarts without changing data', async t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'phase4-controlled-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const url = `file:${path.join(dir, 'fixture.db')}`;
  const db = createClient({ url });
  const at = '2026-09-19T00:00:00.000Z';
  await runMigrations(db, { targetVersion: 20 });
  for (const id of ['synthetic-a', 'synthetic-b']) {
    await db.execute({ sql: `INSERT INTO users(id,display_name,status,created_at,updated_at)
      VALUES (?,'Synthetic','ACTIVE',?,?)`, args: [id, at, at] });
    await db.execute({ sql: `INSERT INTO user_telegram(telegram_chat_id,user_id,linked_at,status)
      VALUES (?,?,?,'ACTIVE')`, args: [`chat-${id}`, id, at] });
    await db.execute({ sql: `INSERT INTO journal_events(user_id,event_at,health_date,category,source,created_at,updated_at)
      VALUES (?,?,'2026-09-19','caffeine','manual',?,?)`, args: [id, at, at, at] });
    await db.execute({ sql: `INSERT INTO whoop_sleeps(user_id,id,health_date,start_at,end_at,nap,score_state,sleep_performance_percentage,synced_at)
      VALUES (?,?,'2026-09-19',?,?,0,'SCORED',50,?)`, args: [id, `sleep-${id}`, at, at, at] });
  }
  await db.execute({ sql: `INSERT INTO user_whoop_tokens(user_id,access_token,refresh_token,access_token_expires_at,updated_at)
    VALUES ('synthetic-a','fixture-access','fixture-refresh',?,?)`, args: [at, at] });
  const preserved = Object.fromEntries(await Promise.all(
    ['users', 'user_telegram', 'user_whoop_tokens', 'whoop_sleeps', 'journal_events'].map(async table => {
      const columns = (await db.execute(`PRAGMA table_info(${table})`)).rows.map(row => row.name);
      return [table, { columns, rows: (await db.execute(`SELECT ${columns.join(',')} FROM ${table}`)).rows }];
    }),
  ));
  db.close();

  const env = { TURSO_DATABASE_URL: url, PHASE4_LOOKUP_KEY: 'a'.repeat(64),
    PHASE4_AUDIT_KEY: 'b'.repeat(64) };
  assert.equal((await main(['--preflight', '--expected-target', url], env)).from, 20);
  const first = await main(['--apply', '--expected-target', url], env);
  assert.deepEqual(first.versionsApplied, [22,23,24,25,26,27,28,29,30,31]);
  assert.equal(first.health.integrity, 'ok');
  assert.equal(first.health.foreignKeyViolations, 0);
  assert.equal(first.localeRows, 0);
  assert.equal(first.liveRows, 0);
  assert.equal(first.bodyEnergyRows, 0);
  assert.equal(first.preservedCounts.users, 2);
  assert.equal(first.preservedCounts.user_whoop_tokens, 1);
  const second = await main(['--apply', '--expected-target', url], env);
  assert.deepEqual(second.versionsApplied, []);
  assert.deepEqual(second.preservedCounts, first.preservedCounts);
  const changedLookup = { ...env, PHASE4_LOOKUP_KEY: 'c'.repeat(64) };
  const changedAudit = { ...env, PHASE4_AUDIT_KEY: 'd'.repeat(64) };
  for (const changed of [changedLookup, changedAudit, { ...changedLookup, PHASE4_AUDIT_KEY: 'd'.repeat(64) }]) {
    await assert.rejects(main(['--apply', '--expected-target', url], changed), /PHASE4_(LOOKUP|AUDIT)_KEY_MISMATCH/);
  }
  await assert.rejects(main(['--preflight', '--expected-target', url], changedLookup), /PHASE4_LOOKUP_KEY_MISMATCH/);
  await assert.rejects(main(['--preflight', '--expected-target', url], changedAudit), /PHASE4_AUDIT_KEY_MISMATCH/);

  const check = createClient({ url });
  try {
    for (const [table, { columns, rows }] of Object.entries(preserved))
      assert.deepEqual((await check.execute(`SELECT ${columns.join(',')} FROM ${table}`)).rows, rows, table);
    assert.deepEqual((await check.execute('SELECT version FROM schema_version ORDER BY version')).rows
      .map(row => Number(row.version)), Array.from({ length: 12 }, (_, i) => i + 20));
    assert.equal(Number((await check.execute('SELECT COUNT(*) AS n FROM user_locales')).rows[0].n), 0);
    await check.execute("DELETE FROM phase4_migration_checkpoints WHERE step_key='lookup_key_check'");
  } finally { check.close(); }
  await assert.rejects(main(['--preflight', '--expected-target', url], env), /PHASE4_LOOKUP_KEY_CONTINUITY_UNPROVEN/);
});

test('interrupted v21 bootstrap resumes with the same keys and rejects either changed key before v22 writes', async t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'phase4-interrupted-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const url = `file:${path.join(dir, 'fixture.db')}`;
  const db = createClient({ url });
  await runMigrations(db, { targetVersion: 20 });
  db.close();
  const env = { TURSO_DATABASE_URL: url, PHASE4_LOOKUP_KEY: 'a'.repeat(64), PHASE4_AUDIT_KEY: 'b'.repeat(64) };
  const preflight = await main(['--preflight', '--expected-target', url], env);
  assert.equal(preflight.checkpointBootstrapVersion, 21);
  const check = createClient({ url });
  assert.equal(Number((await check.execute('SELECT MAX(version) v FROM schema_version')).rows[0].v), 21);
  assert.equal((await check.execute("SELECT step_key FROM phase4_migration_checkpoints WHERE step_key LIKE '%key_check' ORDER BY step_key")).rows.length, 2);
  check.close();
  for (const changed of [{ ...env, PHASE4_LOOKUP_KEY: 'c'.repeat(64) },
    { ...env, PHASE4_AUDIT_KEY: 'd'.repeat(64) }]) {
    await assert.rejects(main(['--apply', '--expected-target', url], changed), /PHASE4_(LOOKUP|AUDIT)_KEY_MISMATCH/);
    const verify = createClient({ url });
    assert.equal(Number((await verify.execute('SELECT MAX(version) v FROM schema_version')).rows[0].v), 21);
    verify.close();
  }
  assert.deepEqual((await main(['--apply', '--expected-target', url], env)).versionsApplied,
    [22,23,24,25,26,27,28,29,30,31]);
});

test('v20 direct apply establishes both key authorities before v22 and reaches v31', async t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'phase4-direct-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const url = `file:${path.join(dir, 'fixture.db')}`;
  const db = createClient({ url });
  await runMigrations(db, { targetVersion: 20 });
  db.close();
  const env = { TURSO_DATABASE_URL: url, PHASE4_LOOKUP_KEY: 'a'.repeat(64), PHASE4_AUDIT_KEY: 'b'.repeat(64) };
  assert.deepEqual((await main(['--apply', '--expected-target', url], env)).versionsApplied,
    [21,22,23,24,25,26,27,28,29,30,31]);
  const check = createClient({ url });
  const verifiers = (await check.execute("SELECT step_key,last_cursor FROM phase4_migration_checkpoints WHERE step_key LIKE '%key_check' ORDER BY step_key")).rows;
  assert.deepEqual(verifiers.map(row => row.step_key),
    ['audit_key_check', 'lookup_key_check']);
  for (const row of verifiers) {
    assert.match(row.last_cursor, /^[a-f0-9]{64}$/);
    assert.notEqual(row.last_cursor, env.PHASE4_AUDIT_KEY);
    assert.notEqual(row.last_cursor, env.PHASE4_LOOKUP_KEY);
  }
  check.close();
});

test('interrupted v22 authority rejects changed keys before later migration writes', async t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'phase4-v22-stop-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const url = `file:${path.join(dir, 'fixture.db')}`;
  const env = { TURSO_DATABASE_URL: url, PHASE4_LOOKUP_KEY: 'a'.repeat(64), PHASE4_AUDIT_KEY: 'b'.repeat(64) };
  const keys = createPhase4Keys({ lookupKey: Buffer.from(env.PHASE4_LOOKUP_KEY, 'hex'),
    auditKey: Buffer.from(env.PHASE4_AUDIT_KEY, 'hex') });
  const db = createClient({ url });
  await runMigrations(db, { targetVersion: 20 });
  await db.execute("INSERT INTO users(id,display_name,status,created_at,updated_at) VALUES ('synthetic','Synthetic','ACTIVE','2026-01-01','2026-01-01')");
  await runMigrations(db, { targetVersion: 22, privacyKeys: keys });
  const before = Number((await db.execute('SELECT COUNT(*) n FROM phase4_source_links')).rows[0].n);
  db.close();
  for (const changed of [{ ...env, PHASE4_LOOKUP_KEY: 'c'.repeat(64) },
    { ...env, PHASE4_AUDIT_KEY: 'd'.repeat(64) }]) {
    await assert.rejects(main(['--apply', '--expected-target', url], changed), /PHASE4_(LOOKUP|AUDIT)_KEY_MISMATCH/);
    const check = createClient({ url });
    assert.equal(Number((await check.execute('SELECT MAX(version) v FROM schema_version')).rows[0].v), 22);
    assert.equal(Number((await check.execute('SELECT COUNT(*) n FROM phase4_source_links')).rows[0].n), before);
    check.close();
  }
  assert.deepEqual((await main(['--apply', '--expected-target', url], env)).versionsApplied,
    [23,24,25,26,27,28,29,30,31]);
});

test('partial v22 lookup history without its checkpoint cannot adopt a new key', async t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'phase4-lookup-missing-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const url = `file:${path.join(dir, 'fixture.db')}`;
  const env = { TURSO_DATABASE_URL: url, PHASE4_LOOKUP_KEY: 'a'.repeat(64), PHASE4_AUDIT_KEY: 'b'.repeat(64) };
  const keys = createPhase4Keys({ lookupKey: Buffer.from(env.PHASE4_LOOKUP_KEY, 'hex'),
    auditKey: Buffer.from(env.PHASE4_AUDIT_KEY, 'hex') });
  const db = createClient({ url });
  await runMigrations(db, { targetVersion: 20 });
  await db.execute("INSERT INTO users(id,display_name,status,created_at,updated_at) VALUES ('synthetic','Synthetic','ACTIVE','2026-01-01','2026-01-01')");
  await db.execute("INSERT INTO journal_events(user_id,event_at,health_date,category,source,created_at,updated_at) VALUES ('synthetic','2026-01-01','2026-01-01','caffeine','manual','2026-01-01','2026-01-01')");
  await runMigrations(db, { targetVersion: 22, privacyKeys: keys });
  assert.ok((await db.execute('SELECT 1 FROM phase4_source_links LIMIT 1')).rows.length);
  await db.execute("DELETE FROM phase4_migration_checkpoints WHERE step_key='lookup_key_check'");
  await db.execute('DELETE FROM schema_version WHERE version=22');
  db.close();
  await assert.rejects(main(['--preflight', '--expected-target', url],
    { ...env, PHASE4_LOOKUP_KEY: 'c'.repeat(64) }), /PHASE4_LOOKUP_KEY_CONTINUITY_UNPROVEN/);
});

test('missing audit checkpoint is established only without audit-dependent history', async t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'phase4-audit-missing-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const url = `file:${path.join(dir, 'empty.db')}`;
  const env = { TURSO_DATABASE_URL: url, PHASE4_LOOKUP_KEY: 'a'.repeat(64), PHASE4_AUDIT_KEY: 'b'.repeat(64) };
  const keys = createPhase4Keys({ lookupKey: Buffer.from(env.PHASE4_LOOKUP_KEY, 'hex'),
    auditKey: Buffer.from(env.PHASE4_AUDIT_KEY, 'hex') });
  const db = createClient({ url });
  await runMigrations(db, { targetVersion: 31, privacyKeys: keys });
  await db.execute("DELETE FROM phase4_migration_checkpoints WHERE target_version=22 AND step_key='audit_key_check'");
  db.close();
  assert.equal((await main(['--preflight', '--expected-target', url], env)).from, 31);
  const check = createClient({ url });
  assert.equal((await check.execute("SELECT count(*) n FROM phase4_migration_checkpoints WHERE step_key='audit_key_check'")).rows[0].n, 1);
  // A single durable audit-derived authority makes re-adoption impossible.
  await check.execute("DELETE FROM phase4_migration_checkpoints WHERE step_key='audit_key_check'");
  await check.execute({ sql: `INSERT INTO phase4_receipt_route_manifests
    (user_id,execution_mode,subject_kind,subject_token,route_version,entry_count,chain_digest,manifest_hmac)
    VALUES ('synthetic','SHADOW','EPISODE',?,'stage6-receipt-routing-v1',1,?,?)`,
    args: ['1'.repeat(64), '2'.repeat(64), '3'.repeat(64)] });
  check.close();
  await assert.rejects(main(['--preflight', '--expected-target', url], env), /PHASE4_AUDIT_KEY_CONTINUITY_UNPROVEN/);
  await assert.rejects(main(['--apply', '--expected-target', url], env), /PHASE4_AUDIT_KEY_CONTINUITY_UNPROVEN/);
});

test('controlled CLI rejects target mismatch and missing or equal keys before any migration', async () => {
  const env = { TURSO_DATABASE_URL: 'file:/tmp/never-open.db',
    PHASE4_LOOKUP_KEY: 'a'.repeat(64), PHASE4_AUDIT_KEY: 'a'.repeat(64) };
  await assert.rejects(main(['--apply', '--expected-target', 'file:/tmp/other.db'], env), /MIGRATION_TARGET_MISMATCH/);
  await assert.rejects(main(['--apply', '--expected-target', env.TURSO_DATABASE_URL], env), /phase4_distinct_keys_required/);
  await assert.rejects(main(['--apply', '--expected-target', env.TURSO_DATABASE_URL],
    { ...env, PHASE4_LOOKUP_KEY: '' }), /MIGRATION_KEYS_REQUIRED/);
  const host = 'whoop-briefing-enjoyfulwen0204-eng.aws-ap-northeast-1.turso.io';
  await assert.rejects(main(['--apply', '--expected-target', host],
    { ...env, TURSO_DATABASE_URL: `libsql://${host}`, TURSO_AUTH_TOKEN: 'fixture-only' }),
  /MIGRATION_PRODUCTION_CONFIRMATION_REQUIRED/);
});

test('production target guard validates the complete canonical libsql URL', async () => {
  const host = 'whoop-briefing-enjoyfulwen0204-eng.aws-ap-northeast-1.turso.io';
  const env = { TURSO_DATABASE_URL: `libsql://${host}`, TURSO_AUTH_TOKEN: 'fixture-only',
    PHASE4_LOOKUP_KEY: 'a'.repeat(64), PHASE4_AUDIT_KEY: 'b'.repeat(64) };
  const args = ['--preflight', '--expected-target', host];
  // The valid URL gets past target validation. No connection is opened because
  // this test deliberately omits the required reviewed commit.
  await assert.rejects(main(args, env), /MIGRATION_COMMIT_REQUIRED/);
  await assert.rejects(main(args, { ...env, TURSO_DATABASE_URL: `libsql://${host}/` }), /MIGRATION_COMMIT_REQUIRED/);
  for (const url of [`https://${host}`, `http://${host}`, `libsql://@${host}`, `libsql://user@${host}`,
    `libsql://user:password@${host}`, `libsql://${host}:443`, `libsql://${host}/other`,
    `libsql://${host}?x=1`, `libsql://${host}#fragment`])
    await assert.rejects(main(args, { ...env, TURSO_DATABASE_URL: url }), /MIGRATION_TARGET_INVALID/, url);
});
