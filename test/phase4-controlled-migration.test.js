import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createClient } from '@libsql/client';
import { runMigrations } from '../src/migrations.js';
import { main } from '../scripts/phase4-migrate.js';

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
  assert.deepEqual(first.versionsApplied, [21,22,23,24,25,26,27,28,29,30,31]);
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

  const check = createClient({ url });
  try {
    for (const [table, { columns, rows }] of Object.entries(preserved))
      assert.deepEqual((await check.execute(`SELECT ${columns.join(',')} FROM ${table}`)).rows, rows, table);
    assert.deepEqual((await check.execute('SELECT version FROM schema_version ORDER BY version')).rows
      .map(row => Number(row.version)), Array.from({ length: 12 }, (_, i) => i + 20));
    assert.equal(Number((await check.execute('SELECT COUNT(*) AS n FROM user_locales')).rows[0].n), 0);
  } finally { check.close(); }
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
