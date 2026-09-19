import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@libsql/client';
import { currentVersion, runMigrations } from '../src/migrations.js';
import { assertPhase4Schema, verifyPhase4Schema } from '../src/phase4Migrations.js';
import { V21_SCHEMA } from '../src/phase4Schema.js';
import { LEGACY_SCHEMA_VERSION, PHASE4_MIGRATIONS } from '../src/schema.js';

const now = '2026-09-19T00:00:00.000Z';
async function fixture(t, populated = true) {
  const db = createClient({ url: ':memory:' });
  t.after(() => db.close());
  await runMigrations(db, { targetVersion: 20 });
  if (populated) {
    for (const id of ['tenant-a', 'tenant-b']) await db.execute({
      sql: `INSERT INTO users(id, display_name, status, created_at, updated_at)
        VALUES (?, 'Synthetic', 'ACTIVE', ?, ?)`, args: [id, now, now],
    });
    await db.execute(`INSERT INTO journal_events(user_id,event_at,health_date,category,source,created_at,updated_at)
      VALUES ('tenant-a','2026-09-18T23:00:00Z','2026-09-19','caffeine','manual','${now}','${now}')`);
  }
  return db;
}
const rows = async (db, table) => (await db.execute(`SELECT * FROM ${table}`)).rows.map(r => ({ ...r }));
const versions = async db => (await db.execute('SELECT version FROM schema_version ORDER BY version')).rows.map(r => Number(r.version));

test('v21: frozen v20 boundary, complete schema and sequential version history', async t => {
  assert.equal(LEGACY_SCHEMA_VERSION, 20);
  assert.equal(PHASE4_MIGRATIONS[0].version, 21);
  const db = await fixture(t);
  const before = await rows(db, 'journal_events');
  const users = await rows(db, 'users');
  assert.deepEqual((await runMigrations(db, { targetVersion: 21 })).versionsApplied, [21]);
  await assertPhase4Schema(db, 21);
  assert.deepEqual(await versions(db), [20, 21]);
  assert.deepEqual(await rows(db, 'journal_events'), before);
  assert.deepEqual(await rows(db, 'users'), users);
  const states = await rows(db, 'phase4_computation_state');
  assert.equal(states.length, 2);
  assert.ok(states.every(s => s.execution_mode === 'SHADOW' && s.input_generation === 0
    && s.last_completed_generation === 0 && s.source_generation_seen === 0));
  assert.ok((await rows(db, 'user_notification_preferences')).every(p => p.notifications_paused === 0
    && p.morning_brief_mode === 'AFTER_WAKE' && p.after_wake_delay_minutes === 30 && p.fallback_local_time === '10:00'));
  await db.execute("UPDATE user_notification_preferences SET notifications_paused = 1, preference_version = 4 WHERE user_id = 'tenant-a'");
  const snapshot = await rows(db, 'user_notification_preferences');
  assert.equal((await runMigrations(db, { targetVersion: 21 })).skipped, true);
  assert.deepEqual(await rows(db, 'user_notification_preferences'), snapshot);
  assert.deepEqual(await versions(db), [20, 21]);
});

test('v21: empty installation has no fabricated tenants or LIVE computation', async t => {
  const db = await fixture(t, false);
  await runMigrations(db, { targetVersion: 21 });
  await verifyPhase4Schema(db, 21);
  assert.deepEqual(await rows(db, 'phase4_user_state'), []);
  assert.deepEqual(await rows(db, 'phase4_computation_state'), []);
});

test('v21: deterministic tenant backfill crosses bounded batches without changing preferences', async t => {
  const db = await fixture(t, false);
  for (let i = 0; i < 205; i++) await db.execute({
    sql: `INSERT INTO users(id,display_name,status,created_at,updated_at) VALUES (?,'Synthetic','PAUSED',?,?)`,
    args: [`tenant-${String(i).padStart(3, '0')}`, now, now],
  });
  await runMigrations(db, { targetVersion: 21 });
  assert.equal((await rows(db, 'phase4_user_state')).length, 205);
  assert.equal((await rows(db, 'phase4_computation_state')).length, 205);
  assert.deepEqual((await rows(db, 'phase4_migration_checkpoints')).map(r => [r.last_cursor, r.postcondition_state]),
    [['tenant-204', 'COMPLETE']]);
});

test('v21: populated or empty incompatible v20 shapes cannot be rebuilt', async t => {
  for (const populated of [false, true]) {
    const db = await fixture(t);
    await db.execute('DROP TABLE report_runs');
    await db.execute('CREATE TABLE report_runs(id INTEGER PRIMARY KEY, report_type TEXT)');
    if (populated) await db.execute("INSERT INTO report_runs VALUES (1,'synthetic')");
    const before = await rows(db, 'report_runs');
    await assert.rejects(runMigrations(db, { targetVersion: 21 }), { name: 'UnsafeMigrationError' });
    assert.deepEqual(await rows(db, 'report_runs'), before);
    assert.equal(await currentVersion(db), 20);
  }
});

test('v21: interruption after every DDL/backfill/checkpoint statement converges', async t => {
  const reference = await fixture(t);
  const writes = [];
  const trace = { execute: async stmt => {
    const sql = typeof stmt === 'string' ? stmt : stmt.sql;
    const result = await reference.execute(stmt);
    if (/^(CREATE|INSERT|UPDATE)/.test(sql.trim()) && /phase4_|user_notification_preferences/.test(sql)
      && !sql.includes('schema_version')) writes.push(sql);
    return result;
  } };
  await runMigrations(trace, { targetVersion: 21 });
  assert.equal(writes.filter(s => s.startsWith('CREATE')).length, V21_SCHEMA.length);
  for (let stop = 1; stop <= writes.length; stop++) {
    const db = await fixture(t);
    let count = 0;
    const crash = { execute: async stmt => {
      const result = await db.execute(stmt);
      const sql = typeof stmt === 'string' ? stmt : stmt.sql;
      if (/^(CREATE|INSERT|UPDATE)/.test(sql.trim()) && /phase4_|user_notification_preferences/.test(sql)
          && !sql.includes('schema_version') && ++count === stop) throw new Error('synthetic_crash');
      return result;
    } };
    await assert.rejects(runMigrations(crash, { targetVersion: 21 }), /synthetic_crash/);
    assert.equal(await currentVersion(db), 20, `stop ${stop} must not advance`);
    await runMigrations(db, { targetVersion: 21 });
    await assertPhase4Schema(db, 21);
    for (const table of ['phase4_user_state', 'phase4_computation_state', 'user_notification_preferences',
      'phase4_migration_checkpoints', 'journal_events']) assert.deepEqual(await rows(db, table), await rows(reference, table));
  }
});

test('v21: conflicting partial shape and failed postconditions withhold version', async t => {
  const db = await fixture(t);
  await db.execute('CREATE TABLE phase4_user_state(user_id TEXT NOT NULL PRIMARY KEY)');
  await assert.rejects(runMigrations(db, { targetVersion: 21 }), /phase4_schema_postcondition_failed/);
  assert.equal(await currentVersion(db), 20);
  assert.deepEqual((await db.execute('PRAGMA table_info(phase4_user_state)')).rows.map(r => r.name), ['user_id']);
  const orphanDb = await fixture(t);
  for (const sql of V21_SCHEMA) await orphanDb.execute(sql);
  await orphanDb.execute(`INSERT INTO phase4_user_state(user_id,created_at,updated_at) VALUES ('not-a-tenant','${now}','${now}')`);
  await assert.rejects(runMigrations(orphanDb, { targetVersion: 21 }), /phase4_data_postcondition_failed/);
  assert.equal(await currentVersion(orphanDb), 20);
});

test('v21: missing or drifted applied objects are refused, not silently repaired', async t => {
  const db = await fixture(t);
  await runMigrations(db, { targetVersion: 21 });
  await db.execute('DROP TRIGGER phase4_computation_state_mode_immutable');
  await assert.rejects(assertPhase4Schema(db, 21), /phase4_schema_postcondition_failed/);
  await assert.rejects(runMigrations(db, { targetVersion: 21 }), /phase4_schema_postcondition_failed/);
});

test('v21: exact startup refuses behind, ahead and absent versions', async t => {
  const db = await fixture(t);
  await assert.rejects(assertPhase4Schema(db, 21), /phase4_schema_version_mismatch/);
  await runMigrations(db, { targetVersion: 21 });
  await db.execute(`INSERT INTO schema_version VALUES (99,'${now}','synthetic future')`);
  await assert.rejects(assertPhase4Schema(db, 21), /phase4_schema_version_mismatch/);
  await assert.rejects(runMigrations(db), /schema_version_incompatible/);
  const empty = createClient({ url: ':memory:' }); t.after(() => empty.close());
  await assert.rejects(assertPhase4Schema(empty), /phase4_schema_version_mismatch/);
});

test('v21: tenant/mode PKs, safe defaults, immutable modes and numeric constraints', async t => {
  const db = await fixture(t, false);
  await runMigrations(db, { targetVersion: 21 });
  const insert = (uid, mode) => db.execute({
    sql: `INSERT INTO phase4_computation_state(user_id,${mode === undefined ? '' : 'execution_mode,'}
      algorithm_set_version,created_at,updated_at) VALUES (?,${mode === undefined ? '' : '?,'}'test',?,?)`,
    args: mode === undefined ? [uid, now, now] : [uid, mode, now, now],
  });
  await insert('tenant-a'); await insert('tenant-b'); await insert('tenant-a', 'LIVE');
  // Raw SQL fixtures demonstrate namespace; no production LIVE factory exists.
  assert.equal((await rows(db, 'phase4_computation_state')).length, 3);
  await assert.rejects(insert('tenant-a'), /UNIQUE/);
  for (const mode of [null, 'unknown', 'live']) await assert.rejects(insert('x', mode), /constraint/i);
  await assert.rejects(insert(null), /NOT NULL/);
  await assert.rejects(db.execute("UPDATE phase4_computation_state SET execution_mode = 'LIVE' WHERE user_id = 'tenant-b'"), /immutable/);
  await assert.rejects(db.execute("UPDATE phase4_computation_state SET execution_mode = 'SHADOW' WHERE execution_mode = 'LIVE'"), /immutable/);
  for (const set of ['input_generation = -1', 'last_completed_generation = 1', 'revision = 1.5', 'source_generation_seen = -1']) {
    await assert.rejects(db.execute(`UPDATE phase4_computation_state SET ${set}`), /CHECK/);
  }
});
