import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createClient } from '@libsql/client';
import { currentVersion, runMigrations } from '../src/migrations.js';
import { controlledMigration } from '../scripts/phase4-migrate.js';
import { createPhase4Keys } from '../src/phase4Keys.js';

const at = '2026-09-19T00:00:00.000Z';
const keys = createPhase4Keys({ lookupKey: Buffer.alloc(32, 0xaa), auditKey: Buffer.alloc(32, 0xbb) });
const wrongLookup = createPhase4Keys({ lookupKey: Buffer.alloc(32, 0xcc), auditKey: Buffer.alloc(32, 0xbb) });
const wrongAudit = createPhase4Keys({ lookupKey: Buffer.alloc(32, 0xaa), auditKey: Buffer.alloc(32, 0xdd) });
const n = async (db, sql) => Number((await db.execute(sql)).rows[0].n);

test('populated v22 with v21 schema and PENDING checkpoint fails closed, then resumes through v31', async t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'phase4-v22-repair-resume-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = createClient({ url: `file:${path.join(dir, 'fixture.db')}` });
  t.after(() => db.close());
  await runMigrations(db, { targetVersion: 20 });
  for (const id of ['a', 'b']) {
    await db.execute({ sql: `INSERT INTO users(id,display_name,status,created_at,updated_at)
      VALUES (?,'Synthetic','ACTIVE',?,?)`, args: [id, at, at] });
    await db.execute({ sql: `INSERT INTO journal_events(user_id,event_at,health_date,category,source,created_at,updated_at)
      VALUES (?,?,'2026-09-19','caffeine','manual',?,?)`, args: [id, at, at, at] });
    await db.execute({ sql: `INSERT INTO whoop_sleeps(user_id,id,health_date,start_at,end_at,nap,score_state,synced_at)
      VALUES (?,?,'2026-09-19',?,?,0,'SCORED',?)`, args: [id, `sleep-${id}`, at, at, at] });
    for (let i = 0; i < 3; i++) await db.execute({ sql: `INSERT INTO healthspan_metrics
      (user_id,calculated_at,metric_key,availability) VALUES (?,?,?,'AVAILABLE')`,
      args: [id, `${at.slice(0,10)}T00:00:0${i}.000Z`, `metric-${i}`] });
  }
  await runMigrations(db, { targetVersion: 22, privacyKeys: keys });
  assert.equal(await currentVersion(db), 22);
  const linksBefore = (await db.execute(`SELECT user_id,artifact_type,artifact_id,source_type,source_id
    FROM phase4_source_links ORDER BY user_id,artifact_type,artifact_id,source_type,source_id`)).rows;
  const countsBefore = {
    users: await n(db, 'SELECT count(*) n FROM users'),
    sleeps: await n(db, 'SELECT count(*) n FROM whoop_sleeps'),
    journal: await n(db, 'SELECT count(*) n FROM journal_events'),
    metrics: await n(db, 'SELECT count(*) n FROM healthspan_metrics'),
    links: linksBefore.length,
  };
  assert.equal(await n(db, 'SELECT count(*) n FROM healthspan_metrics WHERE privacy_artifact_id IS NULL'), 0);
  await db.execute('DELETE FROM schema_version WHERE version=22');
  await db.execute(`UPDATE phase4_migration_checkpoints SET postcondition_state='PENDING'
    WHERE target_version=22 AND step_key='privacy_backfill'`);
  assert.equal(await currentVersion(db), 21);
  assert.equal((await db.execute(`SELECT postcondition_state FROM phase4_migration_checkpoints
    WHERE target_version=22 AND step_key='privacy_backfill'`)).rows[0].postcondition_state, 'PENDING');
  assert.deepEqual((await db.execute(`SELECT step_key,postcondition_state FROM phase4_migration_checkpoints
    WHERE step_key IN ('audit_key_check','lookup_key_check') ORDER BY step_key`)).rows.map(r => [r.step_key,r.postcondition_state]),
  [['audit_key_check','COMPLETE'],['lookup_key_check','COMPLETE']]);

  for (const [label, testKeys] of [['lookup', wrongLookup], ['audit', wrongAudit], ['missing', null]]) {
    await assert.rejects(controlledMigration(db, { apply: true, keys: testKeys }),
      label === 'missing' ? /PHASE4_PRIVACY_KEYS_REQUIRED/ : /PHASE4_(LOOKUP|AUDIT)_KEY_MISMATCH/);
    assert.equal(await currentVersion(db), 21, label);
    assert.equal(await n(db, 'SELECT count(*) n FROM phase4_source_links'), countsBefore.links, label);
  }

  // Fail exactly at the previously timed-out predicate. No completion marker
  // or version write may occur before that query succeeds.
  const blocked = { execute: async statement => {
    const sql = typeof statement === 'string' ? statement : statement.sql;
    if (sql.includes('FROM healthspan_metrics p LEFT JOIN linked l'))
      throw new Error('synthetic_verification_interruption');
    return db.execute(statement);
  } };
  await assert.rejects(controlledMigration(blocked, { apply: true, keys }),
    /synthetic_verification_interruption/);
  assert.equal(await currentVersion(db), 21);
  assert.equal((await db.execute(`SELECT postcondition_state FROM phase4_migration_checkpoints
    WHERE target_version=22 AND step_key='privacy_backfill'`)).rows[0].postcondition_state, 'PENDING');

  const blockedFinal = { execute: async statement => {
    const sql = typeof statement === 'string' ? statement : statement.sql;
    if (sql.includes("FROM experiment_field_groups f WHERE f.content_state='PRESENT'"))
      throw new Error('synthetic_last_postcondition_interruption');
    return db.execute(statement);
  } };
  await assert.rejects(controlledMigration(blockedFinal, { apply: true, keys }),
    /synthetic_last_postcondition_interruption/);
  assert.equal(await currentVersion(db), 21);
  assert.equal((await db.execute(`SELECT postcondition_state FROM phase4_migration_checkpoints
    WHERE target_version=22 AND step_key='privacy_backfill'`)).rows[0].postcondition_state, 'PENDING');

  const events = [];
  const observed = { execute: async statement => {
    const sql = typeof statement === 'string' ? statement : statement.sql;
    if (sql.includes('FROM healthspan_metrics p LEFT JOIN linked l')) events.push('linkage_verified');
    if (/UPDATE phase4_migration_checkpoints SET postcondition_state='COMPLETE'/.test(sql)
        && sql.includes('target_version=22')) events.push('checkpoint_complete');
    if (sql.includes('INSERT INTO schema_version') && Array.isArray(statement.args)
        && statement.args[0] === 22) events.push('schema_22');
    return db.execute(statement);
  } };
  const result = await controlledMigration(observed, { apply: true, keys });
  assert.equal(result.from, 21);
  assert.deepEqual(result.versionsApplied, [22,23,24,25,26,27,28,29,30,31]);
  assert.ok(events.indexOf('linkage_verified') >= 0);
  assert.ok(events.indexOf('linkage_verified') < events.indexOf('checkpoint_complete'));
  assert.ok(events.indexOf('checkpoint_complete') < events.indexOf('schema_22'));
  assert.equal(await currentVersion(db), 31);
  assert.equal((await db.execute(`SELECT postcondition_state FROM phase4_migration_checkpoints
    WHERE target_version=22 AND step_key='privacy_backfill'`)).rows[0].postcondition_state, 'COMPLETE');
  assert.deepEqual((await db.execute(`SELECT user_id,artifact_type,artifact_id,source_type,source_id
    FROM phase4_source_links ORDER BY user_id,artifact_type,artifact_id,source_type,source_id`)).rows, linksBefore);
  assert.deepEqual({ users: await n(db, 'SELECT count(*) n FROM users'),
    sleeps: await n(db, 'SELECT count(*) n FROM whoop_sleeps'),
    journal: await n(db, 'SELECT count(*) n FROM journal_events'),
    metrics: await n(db, 'SELECT count(*) n FROM healthspan_metrics'),
    links: await n(db, 'SELECT count(*) n FROM phase4_source_links') }, countsBefore);
  assert.equal(result.health.integrity, 'ok');
  assert.equal(result.health.foreignKeyViolations, 0);
  assert.equal(result.liveRows, 0);
  assert.equal(result.bodyEnergyRows, 0);
  assert.equal(result.localeRows, 0);
  const rerun = await controlledMigration(db, { apply: true, keys });
  assert.deepEqual(rerun.versionsApplied, []);
  assert.equal(await n(db, 'SELECT count(*) n FROM phase4_source_links'), countsBefore.links);
});
