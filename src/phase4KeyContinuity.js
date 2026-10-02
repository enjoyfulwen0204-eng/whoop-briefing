import { PHASE4_MIGRATIONS } from './schema.js';
import { requirePhase4Keys } from './phase4Keys.js';
import { V21_SCHEMA } from './phase4Schema.js';
import { V22_LEGACY_R_TABLES } from './phase4V22Schema.js';

// The frozen v21 table has a composite (target_version, step_key) primary key.
// Separate named rows use its existing durable, atomic uniqueness contract.
const LOOKUP = [22, 'lookup_key_check'];
const AUDIT = [22, 'audit_key_check'];

function fail(code) { const error = new Error(code); error.code = code; throw error; }

async function hasTable(client, name) {
  return (await client.execute({ sql: "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", args: [name] })).rows.length === 1;
}

export async function hasPhase4KeyContinuityAuthority(client) {
  if (!await hasTable(client, 'phase4_migration_checkpoints')) return false;
  return (await client.execute(`SELECT 1 FROM phase4_migration_checkpoints
    WHERE step_key IN ('lookup_key_check','audit_key_check') LIMIT 1`)).rows.length > 0;
}

async function assertCheckpointStructure(client) {
  const expected = V21_SCHEMA.find(sql => /^CREATE TABLE IF NOT EXISTS phase4_migration_checkpoints\b/.test(sql));
  const actual = (await client.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='phase4_migration_checkpoints'")).rows[0]?.sql;
  const normalize = sql => String(sql ?? '').replace(/\bIF NOT EXISTS\s+/gi, '').replace(/\s+/g, ' ').trim();
  if (normalize(actual) !== normalize(expected)) fail('PHASE4_KEY_CHECKPOINT_STORAGE_INVALID');
}

async function checkpoint(client, [version, step]) {
  return (await client.execute({ sql: `SELECT last_cursor,postcondition_state FROM phase4_migration_checkpoints
    WHERE target_version=? AND step_key=?`, args: [version, step] })).rows[0];
}

// Every table first introduced after v21 is covered from the frozen migration
// definitions, including a partially applied version whose schema_version row
// was not committed. The three exclusions have no audit-key-derived contents.
const POST_V21_TABLES = Object.freeze(PHASE4_MIGRATIONS
  .filter(m => m.version >= 22)
  .flatMap(m => m.ddl.map(ddl => [ /^CREATE TABLE IF NOT EXISTS (\w+)/i.exec(ddl)?.[1], m.version ]))
  .filter(([name]) => name));
const AUDIT_HISTORY_TABLES = Object.freeze(POST_V21_TABLES
  .filter(([name]) => !['phase4_source_links', 'user_locales', 'user_locale_prompts'].includes(name)));

// All audit-key-derived durable fields are in post-v21 tables. The additive
// columns on legacy health_insights contain no audit digest; claim_hash is in
// the new insight_revisions table and is covered above.

async function noRowsInTables(client, tables, version) {
  for (const [table, introducedAt] of tables) {
    if (!await hasTable(client, table)) {
      if (version >= introducedAt) return false;
      continue;
    }
    if ((await client.execute(`SELECT 1 FROM "${table}" LIMIT 1`)).rows.length) return false;
  }
  return true;
}

export async function noAuditHistory(client, version) {
  return noRowsInTables(client, AUDIT_HISTORY_TABLES, version);
}

async function noLookupHistory(client, version) {
  if (!await noRowsInTables(client, POST_V21_TABLES, version)) return false;
  for (const table of V22_LEGACY_R_TABLES) {
    if (!await hasTable(client, table)) return false;
    const columns = (await client.execute(`PRAGMA table_info("${table}")`)).rows.map(row => row.name);
    if (version >= 22 && !columns.includes('privacy_artifact_id')) return false;
    if (columns.includes('privacy_artifact_id')
        && (await client.execute(`SELECT 1 FROM "${table}" WHERE privacy_artifact_id IS NOT NULL LIMIT 1`)).rows.length)
      return false;
  }
  return true;
}

/** Call before any v22+ backfill or current-schema no-op. v21 must exist. */
export async function establishPhase4KeyContinuity(client, keys, version) {
  requirePhase4Keys(keys);
  if (version < 21 || !await hasTable(client, 'phase4_migration_checkpoints'))
    fail('PHASE4_KEY_CHECKPOINT_STORAGE_REQUIRED');
  await assertCheckpointStructure(client);
  const lookup = await checkpoint(client, LOOKUP);
  const audit = await checkpoint(client, AUDIT);
  if (lookup && (lookup.postcondition_state !== 'COMPLETE'
      || !keys.verifyLookupCheckpoint(lookup.last_cursor))) fail('PHASE4_LOOKUP_KEY_MISMATCH');
  if (audit && (audit.postcondition_state !== 'COMPLETE'
      || !keys.verifyAuditCheckpoint(audit.last_cursor))) fail('PHASE4_AUDIT_KEY_MISMATCH');
  if (!lookup && (version >= 22 || !await noLookupHistory(client, version)))
    fail('PHASE4_LOOKUP_KEY_CONTINUITY_UNPROVEN');
  if (!audit && !await noAuditHistory(client, version)) fail('PHASE4_AUDIT_KEY_CONTINUITY_UNPROVEN');
  const at = new Date().toISOString();
  const missing = [
    !lookup && [LOOKUP, keys.lookupCheckpoint()],
    !audit && [AUDIT, keys.auditCheckpoint()],
  ].filter(Boolean);
  const inserts = missing.map(([[targetVersion, stepKey], verifier]) => ({
    sql: `INSERT INTO phase4_migration_checkpoints
      (target_version,step_key,last_cursor,postcondition_state,updated_at)
      VALUES (?, ?, ?, 'COMPLETE', ?) ON CONFLICT(target_version,step_key) DO NOTHING`,
    args: [targetVersion, stepKey, verifier, at],
  }));
  // Production libSQL clients commit both rows in one write transaction. A
  // tracing test client may expose only execute(); each row remains an atomic
  // insert and no dependent write follows until both readbacks succeed.
  if (inserts.length && typeof client.batch === 'function') await client.batch(inserts, 'write');
  else for (const statement of inserts) await client.execute(statement);
  const storedLookup = await checkpoint(client, LOOKUP);
  const storedAudit = await checkpoint(client, AUDIT);
  if (storedLookup?.postcondition_state !== 'COMPLETE'
      || !keys.verifyLookupCheckpoint(storedLookup.last_cursor)) fail('PHASE4_LOOKUP_KEY_MISMATCH');
  if (storedAudit?.postcondition_state !== 'COMPLETE'
      || !keys.verifyAuditCheckpoint(storedAudit.last_cursor)) fail('PHASE4_AUDIT_KEY_MISMATCH');
}
