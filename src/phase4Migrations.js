import { PHASE4_MIGRATIONS, SCHEMA_VERSION } from './schema.js';
import { backfillV22, verifyV22Data } from './phase4V22Backfill.js';
import { requirePhase4Keys } from './phase4Keys.js';
import { V23_TABLES } from './phase4V23Schema.js';
import { V24_TABLES } from './phase4V24Schema.js';

// This is an exact binary/schema contract, not a minimum supported version.
export const EXPECTED_SCHEMA_VERSION = SCHEMA_VERSION;
export class Phase4SchemaError extends Error {
  constructor(code, object) {
    super(`${code}${object ? `: ${object}` : ''}`);
    this.name = 'Phase4SchemaError';
    this.code = code;
  }
}

const normalizeSql = (sql) => String(sql).replace(/\bIF NOT EXISTS\s+/gi, '')
  .replace(/\s+/g, ' ').trim().replace(/;$/, '');

/** A name alone is not a postcondition: verify complete definitions, including
 * every column, CHECK, PK, partial-index predicate and trigger. A conflicting
 * partial table is never silently rebuilt, even if empty. */
export async function verifyPhase4Definition(client, ddl) {
  const [, kind, name] = ddl.match(/^CREATE (TABLE|(?:UNIQUE )?INDEX|TRIGGER) IF NOT EXISTS (\w+)/i) ?? [];
  if (!name) throw new Phase4SchemaError('phase4_invalid_migration_definition');
  const rs = await client.execute({
    sql: 'SELECT type, sql FROM sqlite_master WHERE name = ?', args: [name],
  });
  if (rs.rows.length !== 1 || rs.rows[0].type !== kind.toLowerCase().replace('unique ', '')
      || normalizeSql(rs.rows[0].sql) !== normalizeSql(ddl)) {
    throw new Phase4SchemaError('phase4_schema_postcondition_failed', name);
  }
}

async function verifyColumn(client, { table, column, definition }) {
  const info = (await client.execute(`PRAGMA table_info(${table})`)).rows;
  const sql = (await client.execute({ sql: "SELECT sql FROM sqlite_master WHERE type='table' AND name=?", args: [table] })).rows[0]?.sql;
  if (!info.some(r => r.name === column) || !normalizeSql(sql).includes(normalizeSql(`${column} ${definition}`))) {
    throw new Phase4SchemaError('phase4_column_postcondition_failed', `${table}.${column}`);
  }
}

async function requireZero(client, sql, name) {
  if ((await client.execute(sql)).rows.length) {
    throw new Phase4SchemaError('phase4_data_postcondition_failed', name);
  }
}

async function verifyV21(client, { backfill = false } = {}) {
  for (const table of ['phase4_user_state', 'phase4_computation_state', 'user_notification_preferences']) {
    await requireZero(client, `SELECT 1 FROM ${table} p LEFT JOIN users u ON u.id = p.user_id
      WHERE u.id IS NULL LIMIT 1`, `${table}_tenant`);
  }
  await requireZero(client, `SELECT 1 FROM phase4_computation_state c
    LEFT JOIN phase4_user_state s ON s.user_id = c.user_id
    WHERE s.user_id IS NULL OR c.source_generation_seen > s.source_generation LIMIT 1`, 'computation_source');
  if (backfill) {
    await requireZero(client, `SELECT 1 FROM users u
      LEFT JOIN phase4_user_state s ON s.user_id = u.id
      LEFT JOIN phase4_computation_state c ON c.user_id = u.id AND c.execution_mode = 'SHADOW'
      LEFT JOIN user_notification_preferences p ON p.user_id = u.id
      WHERE s.user_id IS NULL OR c.user_id IS NULL OR p.user_id IS NULL LIMIT 1`, 'v21_backfill');
    await requireZero(client, `SELECT 1 FROM phase4_computation_state WHERE execution_mode <> 'SHADOW'
      LIMIT 1`, 'migration_must_not_create_live');
  }
}

/** Bounded, deterministic and restartable. Existing rows/preferences are never
 * reset. All writes are independently idempotent; the cursor is audit/progress,
 * not permission to skip missing rows after a partial write. */
async function backfillV21(client) {
  let cursor = '';
  for (;;) {
    const { rows } = await client.execute({
      sql: 'SELECT id, created_at, updated_at FROM users WHERE id > ? ORDER BY id COLLATE BINARY LIMIT 100',
      args: [cursor],
    });
    if (!rows.length) break;
    for (const u of rows) {
      await client.execute({
        sql: `INSERT INTO phase4_user_state (user_id, created_at, updated_at) VALUES (?, ?, ?)
          ON CONFLICT(user_id) DO NOTHING`, args: [u.id, u.created_at, u.updated_at],
      });
      await client.execute({
        sql: `INSERT INTO phase4_computation_state
          (user_id, execution_mode, source_generation_seen, algorithm_set_version, created_at, updated_at)
          SELECT user_id, 'SHADOW', source_generation, 'phase4-foundation-v1', ?, ?
          FROM phase4_user_state WHERE user_id = ?
          ON CONFLICT(user_id, execution_mode) DO NOTHING`, args: [u.created_at, u.updated_at, u.id],
      });
      await client.execute({
        sql: `INSERT INTO user_notification_preferences (user_id, created_at, updated_at) VALUES (?, ?, ?)
          ON CONFLICT(user_id) DO NOTHING`, args: [u.id, u.created_at, u.updated_at],
      });
    }
    cursor = String(rows.at(-1).id);
    await client.execute({
      sql: `INSERT INTO phase4_migration_checkpoints
        (target_version, step_key, last_cursor, postcondition_state, updated_at)
        VALUES (21, 'tenant_metadata', ?, 'PENDING', ?)
        ON CONFLICT(target_version, step_key) DO UPDATE SET last_cursor = excluded.last_cursor,
          postcondition_state = 'PENDING', updated_at = excluded.updated_at`,
      args: [cursor, rows.at(-1).updated_at],
    });
  }
  await verifyV21(client, { backfill: true });
  await client.execute(`UPDATE phase4_migration_checkpoints SET postcondition_state = 'COMPLETE'
    WHERE target_version = 21 AND step_key = 'tenant_metadata'`);
}

async function backfillV23(client) {
  await client.execute({sql:`INSERT INTO phase4_migration_checkpoints
    (target_version,step_key,postcondition_state,updated_at) VALUES (23,'legacy_insights','PENDING',?)
    ON CONFLICT(target_version,step_key) DO NOTHING`,args:[new Date().toISOString()]});
  for (;;) {
    const rows = (await client.execute(`SELECT id FROM health_insights WHERE legacy_classification IS NULL
      ORDER BY id LIMIT 100`)).rows;
    if (!rows.length) break;
    for (const row of rows) await client.execute({sql:`UPDATE health_insights SET legacy_classification='LEGACY_UNVERIFIED'
      WHERE id=? AND legacy_classification IS NULL`,args:[row.id]});
    await client.execute({sql:`INSERT INTO phase4_migration_checkpoints
      (target_version,step_key,last_cursor,postcondition_state,updated_at) VALUES (23,'legacy_insights',?,'PENDING',?)
      ON CONFLICT(target_version,step_key) DO UPDATE SET last_cursor=excluded.last_cursor,updated_at=excluded.updated_at`,
    args:[String(rows.at(-1).id),new Date().toISOString()]});
  }
}

export async function verifyPhase4Schema(client, version = EXPECTED_SCHEMA_VERSION, options = {}) {
  const migrations = PHASE4_MIGRATIONS.filter(m => m.version <= version);
  const replacements = migrations.flatMap(m=>m.replacements ?? []);
  const nextReplacements = options.resuming ? PHASE4_MIGRATIONS.find(m=>m.version === version + 1)?.replacements ?? [] : [];
  for (const migration of migrations) {
    for (const ddl of migration.ddl) await verifyPhase4Definition(client, ddl);
    for (const column of migration.columns ?? []) await verifyColumn(client, column);
    for (const ddl of [...(migration.indexes ?? []), ...(migration.triggers ?? [])]) {
      const name = ddl.match(/^CREATE (?:UNIQUE )?(?:INDEX|TRIGGER) IF NOT EXISTS (\w+)/)?.[1];
      if (replacements.some(r=>r.oldName === name)) continue;
      const pending = nextReplacements.find(r=>r.oldName === name);
      const exists = pending && (await client.execute({sql:'SELECT 1 FROM sqlite_master WHERE name=?',args:[name]})).rows.length;
      await verifyPhase4Definition(client,pending && !exists ? pending.ddl : ddl);
    }
  }
  for (const {oldName,ddl} of replacements) {
    await verifyPhase4Definition(client,ddl);
    if ((await client.execute({sql:'SELECT 1 FROM sqlite_master WHERE name=?',args:[oldName]})).rows.length) {
      throw new Phase4SchemaError('phase4_retired_index_present',oldName);
    }
  }
  if (version >= 21) await verifyV21(client, options);
  if (version >= 22) await verifyV22Data(client, { backfill: options.backfillVersion === 22 });
  if (version >= 23 && options.backfillVersion === 23) await requireZero(client, `SELECT 1 FROM health_insights
    WHERE legacy_classification IS NOT 'LEGACY_UNVERIFIED' OR insight_key IS NOT NULL OR current_revision IS NOT NULL
      OR evidence_contract_version IS NOT NULL OR lifecycle_disposition IS NOT NULL OR lifecycle_generation IS NOT NULL
      OR auth_generation IS NOT NULL OR input_generation IS NOT NULL LIMIT 1`, 'v23_legacy_insights');
  for (const table of [...(version >= 23 ? V23_TABLES : []), ...(version >= 24 ? V24_TABLES : [])]) {
    await requireZero(client, `SELECT 1 FROM ${table} p LEFT JOIN users u ON u.id=p.user_id WHERE u.id IS NULL LIMIT 1`, `${table}_tenant`);
    if (options.backfillVersion === 24 && V24_TABLES.includes(table)) await requireZero(client,
      `SELECT 1 FROM ${table} WHERE execution_mode <> 'SHADOW' LIMIT 1`, `${table}_no_migration_live`);
  }
}

export async function assertPhase4Schema(client, expected = EXPECTED_SCHEMA_VERSION) {
  let actual;
  try { actual = Number((await client.execute('SELECT MAX(version) AS v FROM schema_version')).rows[0]?.v ?? 0); }
  catch { throw new Phase4SchemaError('phase4_schema_version_mismatch'); }
  if (actual !== expected) throw new Phase4SchemaError('phase4_schema_version_mismatch', `${actual}/${expected}`);
  await verifyPhase4Schema(client, expected);
  return actual;
}

export async function applyPhase4Migrations(client, from, target, options = {}) {
  const applied = [];
  if (from < 22 && target >= 22) requirePhase4Keys(options.privacyKeys);
  // Applied versions are immutable. Do not repair drift with IF NOT EXISTS.
  if (from >= 21) await verifyPhase4Schema(client, from, { resuming: from < target });
  for (const migration of PHASE4_MIGRATIONS.filter(m => m.version > from && m.version <= target)) {
    for (const ddl of migration.ddl) {
      await client.execute(ddl);
      await verifyPhase4Definition(client, ddl);
    }
    for (const column of migration.columns ?? []) {
      const info = (await client.execute(`PRAGMA table_info(${column.table})`)).rows;
      if (!info.some(r => r.name === column.column)) await client.execute(`ALTER TABLE ${column.table} ADD COLUMN ${column.column} ${column.definition}`);
      await verifyColumn(client, column);
    }
    if (migration.version === 21) await backfillV21(client);
    if (migration.version === 22) await backfillV22(client, options);
    if (migration.version === 23) await backfillV23(client);
    for (const ddl of [...(migration.indexes ?? []), ...(migration.triggers ?? [])]) {
      await client.execute(ddl);
      await verifyPhase4Definition(client, ddl);
    }
    for (const {oldName,ddl} of migration.replacements ?? []) {
      await client.execute(ddl);
      await verifyPhase4Definition(client,ddl);
      await client.execute(`DROP INDEX IF EXISTS ${oldName}`);
    }
    await verifyPhase4Schema(client, migration.version, { backfill: migration.version === 21, backfillVersion: migration.version });
    if (migration.version === 22) await client.execute(`UPDATE phase4_migration_checkpoints SET postcondition_state='COMPLETE'
      WHERE target_version=22 AND step_key='privacy_backfill'`);
    if (migration.version === 23) await client.execute(`UPDATE phase4_migration_checkpoints SET postcondition_state='COMPLETE'
      WHERE target_version=23 AND step_key='legacy_insights'`);
    await client.execute({
      sql: `INSERT INTO schema_version (version, applied_at, note) VALUES (?, ?, ?)
        ON CONFLICT(version) DO NOTHING`,
      args: [migration.version, new Date().toISOString(), `phase4 v${migration.version} postconditions verified`],
    });
    applied.push(migration.version);
  }
  return applied;
}
