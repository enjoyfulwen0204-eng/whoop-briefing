import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createClient } from '@libsql/client';
import { v22LinkageQuery, verifyV22Data } from '../src/phase4V22Backfill.js';
import { safeMigrationError } from '../scripts/phase4-migrate.js';

const oldQuery = `SELECT 1 FROM healthspan_metrics p WHERE content_state='PRESENT' AND (source_linkage_state <> 'COMPLETE'
  OR health_content_redacted_at IS NOT NULL OR NOT EXISTS (
  SELECT 1 FROM phase4_source_links l WHERE l.user_id=p.user_id AND l.artifact_id=p.privacy_artifact_id AND l.artifact_type='healthspan_metrics'
    AND l.unlinked_at IS NULL)) LIMIT 1`;
const newQuery = v22LinkageQuery('healthspan_metrics', 'p.user_id');
const count = async (db, sql) => (await db.execute(sql)).rows.length;
async function linkageDb() {
  const db = createClient({ url: ':memory:' });
  await db.execute(`CREATE TABLE healthspan_metrics(user_id TEXT,privacy_artifact_id TEXT,
    content_state TEXT,source_linkage_state TEXT,health_content_redacted_at TEXT)`);
  await db.execute(`CREATE TABLE phase4_source_links(user_id TEXT,artifact_id TEXT,artifact_type TEXT,
    source_type TEXT,source_id TEXT,unlinked_at TEXT,source_execution_mode TEXT DEFAULT 'SHARED')`);
  await db.execute(`CREATE INDEX p4_source_traversal ON phase4_source_links
    (user_id,source_execution_mode,source_type,source_id)`);
  return db;
}
const metric = (user, artifact, state = 'PRESENT', linkage = 'COMPLETE', redactedAt = null) =>
  ({ sql: 'INSERT INTO healthspan_metrics VALUES (?,?,?,?,?)', args: [user, artifact, state, linkage, redactedAt] });
const link = (user, artifact, type = 'healthspan_metrics', sourceType = 'TENANT_LEGACY', sourceId = user, unlinked = null) =>
  ({ sql: `INSERT INTO phase4_source_links
      (user_id,artifact_id,artifact_type,source_type,source_id,unlinked_at) VALUES (?,?,?,?,?,?)`,
    args: [user, artifact, type, sourceType, sourceId, unlinked] });

test('reviewed correlated linkage and materialized anti-join agree on adversarial cases', async () => {
  const db = await linkageDb();
  try {
    const cases = [
      ['valid linkage', [metric('a','m'), link('a','m')], false],
      ['missing link', [metric('a','m')], true],
      ['wrong tenant', [metric('a','m'), link('b','m')], true],
      ['wrong artifact source type', [metric('a','m'), link('a','m','journal_events')], true],
      ['different source id under correct owner and artifact',
        [metric('a','m'), link('a','m','healthspan_metrics','TENANT_LEGACY','other-source')], false],
      ['duplicate ambiguous active links', [metric('a','m'), link('a','m'), link('a','m','healthspan_metrics','JOURNAL_FACT','j')], false],
      ['redacted metric without link', [metric('a','m','REDACTED','DISCONNECTED','now')], false],
      ['present metric with disconnected marker', [metric('a','m','PRESENT','DISCONNECTED'), link('a','m')], true],
      ['cross-user link', [metric('a','m'), link('b','m','healthspan_metrics','TENANT_LEGACY','a')], true],
      ['orphaned link', [link('a','orphan')], false],
      ['malformed linkage redaction timestamp', [metric('a','m','PRESENT','COMPLETE','now'), link('a','m')], true],
      ['unlinked source', [metric('a','m'), link('a','m','healthspan_metrics','TENANT_LEGACY','a','now')], true],
      ['mixed tenants and source types with valid owner link', [metric('a','m'), link('b','m'), link('a','m','journal_events'), link('a','m')], false],
      ['null linkage marker with valid link', [metric('a','m','PRESENT',null), link('a','m')], false],
    ];
    for (const [label, statements, expected] of cases) {
      await db.execute('DELETE FROM phase4_source_links');
      await db.execute('DELETE FROM healthspan_metrics');
      for (const statement of statements) await db.execute(statement);
      const oldViolation = Boolean(await count(db, oldQuery));
      const newViolation = Boolean(await count(db, newQuery));
      assert.equal(oldViolation, expected, `${label}: reviewed query`);
      assert.equal(newViolation, oldViolation, `${label}: repaired query`);
    }
  } finally { db.close(); }
});

test('special owner expressions preserve reviewed linkage truth values', async () => {
  const db = await linkageDb();
  try {
    await db.execute(`CREATE TABLE telegram_operations(user_id TEXT,owner_user_id TEXT,
      privacy_artifact_id TEXT,content_state TEXT,source_linkage_state TEXT,health_content_redacted_at TEXT)`);
    await db.execute(`CREATE TABLE system_heartbeats(scope TEXT,privacy_artifact_id TEXT,
      content_state TEXT,source_linkage_state TEXT,health_content_redacted_at TEXT)`);
    for (const [table, owner, insert] of [
      ['telegram_operations', 'p.owner_user_id', `INSERT INTO telegram_operations VALUES
        ('wrong-column-user','a','m','PRESENT','COMPLETE',NULL)`],
      ['system_heartbeats', 'substr(p.scope,6)', `INSERT INTO system_heartbeats VALUES
        ('user:a','m','PRESENT','COMPLETE',NULL)`],
    ]) {
      await db.execute(insert);
      const reviewed = `SELECT 1 FROM ${table} p WHERE content_state='PRESENT' AND
        (source_linkage_state <> 'COMPLETE' OR health_content_redacted_at IS NOT NULL OR NOT EXISTS
        (SELECT 1 FROM phase4_source_links l WHERE l.user_id=${owner}
          AND l.artifact_id=p.privacy_artifact_id AND l.artifact_type='${table}'
          AND l.unlinked_at IS NULL)) LIMIT 1`;
      assert.equal(await count(db, reviewed), 1, table);
      assert.equal(await count(db, v22LinkageQuery(table, owner)), 1, table);
      await db.execute(link('a','m',table));
      assert.equal(await count(db, reviewed), 0, table);
      assert.equal(await count(db, v22LinkageQuery(table, owner)), 0, table);
      await db.execute('DELETE FROM phase4_source_links');
    }
  } finally { db.close(); }
});

test('both formulations identify the same violating metric identities in one mixed batch', async () => {
  const db = await linkageDb();
  try {
    for (const statement of [
      metric('a','valid'), metric('a','missing'), metric('a','wrong-tenant'),
      metric('a','disconnected','PRESENT','DISCONNECTED'),
      metric('a','redacted','REDACTED','DISCONNECTED','now'),
      metric('b','valid-b'), link('a','valid'), link('b','wrong-tenant'),
      link('a','disconnected'), link('b','valid-b'),
      link('a','valid','healthspan_metrics','JOURNAL_FACT','other'),
      link('a','orphan'),
    ]) await db.execute(statement);
    const identities = async sql => (await db.execute(sql.replace(
      'SELECT 1 FROM healthspan_metrics p',
      'SELECT p.privacy_artifact_id AS artifact_id FROM healthspan_metrics p',
    ).replace(/ LIMIT 1$/, ''))).rows.map(row => row.artifact_id).sort();
    assert.deepEqual(await identities(oldQuery), ['disconnected','missing','wrong-tenant']);
    assert.deepEqual(await identities(newQuery), await identities(oldQuery));
  } finally { db.close(); }
});

test('65,588 metric rows and 65,563 active links verify with no repeated source-link scan', async t => {
  const db = await linkageDb();
  t.after(() => db.close());
  await db.execute(`WITH RECURSIVE seq(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM seq WHERE n<65588)
    INSERT INTO healthspan_metrics SELECT 'tenant-'||(n%6),'artifact-'||n,
      CASE WHEN n<=25 THEN 'REDACTED' ELSE 'PRESENT' END,
      CASE WHEN n<=25 THEN 'DISCONNECTED' ELSE 'COMPLETE' END,
      CASE WHEN n<=25 THEN 'now' ELSE NULL END FROM seq`);
  await db.execute(`INSERT INTO phase4_source_links
    (user_id,artifact_id,artifact_type,source_type,source_id,unlinked_at)
    SELECT user_id,privacy_artifact_id,'healthspan_metrics','TENANT_LEGACY',user_id,NULL
    FROM healthspan_metrics WHERE content_state='PRESENT'`);
  const metrics = Number((await db.execute('SELECT count(*) n FROM healthspan_metrics')).rows[0].n);
  const links = Number((await db.execute('SELECT count(*) n FROM phase4_source_links')).rows[0].n);
  assert.equal(metrics, 65588);
  assert.equal(links, 65563);
  const plan = (await db.execute(`EXPLAIN QUERY PLAN ${newQuery}`)).rows.map(row => row.detail);
  assert.ok(plan.some(detail => /MATERIALIZE linked/.test(detail)), plan.join('\n'));
  assert.ok(plan.some(detail => /SEARCH l USING AUTOMATIC COVERING INDEX/.test(detail)), plan.join('\n'));
  assert.ok(!plan.some(detail => /CORRELATED/.test(detail)), plan.join('\n'));
  const started = performance.now();
  assert.equal(await count(db, newQuery), 0);
  const durationMs = performance.now() - started;
  assert.ok(durationMs < 60000, `verification took ${durationMs.toFixed(1)} ms`);
  t.diagnostic(JSON.stringify({ metrics, links, durationMs: Math.round(durationMs), plan }));
});

test('verification failure reports fixed context and redacts provider payloads and secrets', async () => {
  const secret = 'A'.repeat(64);
  const cause = Object.assign(new Error(`provider token ${secret}`), { code: 'UND_ERR_HEADERS_TIMEOUT' });
  const error = new TypeError(`db URL and key ${secret}`, { cause });
  const client = { execute: async sql => {
    if (sql.includes('FROM healthspan_metrics p')) throw error;
    return { rows: [] };
  } };
  await assert.rejects(verifyV22Data(client, { backfill: true }), rejected => rejected === error);
  const diagnostic = safeMigrationError(error);
  assert.deepEqual(diagnostic, { code: 'MIGRATION_VERIFICATION_QUERY_FAILED', version: 'v22',
    phase: 'verification', operation: 'healthspan_metrics_linkage',
    errorClass: 'TypeError', causeCode: 'UND_ERR_HEADERS_TIMEOUT' });
  assert.ok(!JSON.stringify(diagnostic).includes(secret));
  const forged = { code: `MIGRATION_${secret}`, name: secret, cause: { code: secret },
    migrationVersion: 22, migrationPhase: 'verification', migrationOperation: secret,
    message: secret };
  assert.deepEqual(safeMigrationError(forged), { code: 'MIGRATION_FAILED' });
});

test('migration CLI emits structured safe JSON on an operational failure', () => {
  const script = fileURLToPath(new URL('../scripts/phase4-migrate.js', import.meta.url));
  const result = spawnSync(process.execPath, [script, '--preflight'],
    { encoding: 'utf8', env: { PATH: process.env.PATH ?? '' } });
  assert.equal(result.status, 1);
  assert.deepEqual(JSON.parse(result.stderr.trim()),
    { code: 'MIGRATION_ARGUMENT_REQUIRED', errorClass: 'Error' });
});
