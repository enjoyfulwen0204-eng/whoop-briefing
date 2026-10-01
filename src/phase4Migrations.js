import { PHASE4_MIGRATIONS, SCHEMA_VERSION } from './schema.js';
import { backfillV22, verifyV22Data } from './phase4V22Backfill.js';
import { requirePhase4Keys } from './phase4Keys.js';
import { V23_TABLES } from './phase4V23Schema.js';
import { V27_TABLES } from './phase4V27Schema.js';
import { V26_TABLES } from './phase4V26Schema.js';
import { V25_TABLES } from './phase4V25Schema.js';
import { V24_TABLES } from './phase4V24Schema.js';
import { V29_TABLES } from './phase4V29Schema.js';
import { V30_TABLES } from './phase4V30Schema.js';
import { createReceiptRouting, verifyV27RouteSource } from './phase4ReceiptRouting.js';
import { createFamilyDirectory } from './phase4FamilyDirectory.js';
import { PHASE4_METRICS } from './phase4IntelligenceRegistry.js';
import { physicallyScrubbed } from './phase4Redaction.js';

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

// ALTER TABLE inserts columns before table constraints, preserving the rest
// of sqlite_master's original SQL. Find that boundary without mistaking a
// column CHECK (or a quoted comma) for a table constraint.
function withAddedColumns(ddl, columns) {
  if (!columns.length) return ddl;
  let depth=0, quote=null, boundary=-1;
  for(let i=ddl.indexOf('(');i<ddl.length;i++) {
    const ch=ddl[i];
    if(quote) {if(ch===quote){if(ddl[i+1]===quote)i++;else quote=null;}continue;}
    if(ch==="'"||ch==='"'||ch==='`'){quote=ch;continue;}
    if(ch==='(')depth++;
    if(ch===')'&&--depth===0){boundary=i;break;}
    if(ch===','&&depth===1&&/^\s*(?:CHECK\s*\(|PRIMARY\s+KEY\b|UNIQUE\s*\(|FOREIGN\s+KEY\b|CONSTRAINT\b)/i.test(ddl.slice(i+1))) {
      boundary=i;break;
    }
  }
  if(boundary<0)throw new Phase4SchemaError('phase4_invalid_migration_definition');
  return `${ddl.slice(0,boundary)}, ${columns.map(column=>`${column.column} ${column.definition}`).join(', ')}${ddl.slice(boundary)}`;
}

/** A name alone is not a postcondition: verify complete definitions, including
 * every column, CHECK, PK, partial-index predicate and trigger. A conflicting
 * partial table is never silently rebuilt, even if empty. */
export async function verifyPhase4Definition(client, ddl, additions=[]) {
  const [, kind, name] = ddl.match(/^CREATE (TABLE|(?:UNIQUE )?INDEX|TRIGGER) IF NOT EXISTS (\w+)/i) ?? [];
  if (!name) throw new Phase4SchemaError('phase4_invalid_migration_definition');
  const rs = await client.execute({
    sql: 'SELECT type, sql FROM sqlite_master WHERE name = ?', args: [name],
  });
  // SQLite appends additive columns to the original CREATE TABLE text. Keep
  // comparing the complete frozen definition plus only declared additions.
  const columns=kind==='TABLE'?additions.filter(column=>column.table===name):[];
  const expected=withAddedColumns(ddl,columns);
  if (rs.rows.length !== 1 || rs.rows[0].type !== kind.toLowerCase().replace('unique ', '')
      || normalizeSql(rs.rows[0].sql) !== normalizeSql(expected)) {
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

async function backfillV29(client,keys) {
  requirePhase4Keys(keys);
  const routing=createReceiptRouting(client,keys);
  const receipts=(await client.execute(`SELECT * FROM phase4_operation_receipts
    ORDER BY user_id,execution_mode,operation_kind,operation_key`)).rows;
  for(const receipt of receipts) {
    if(receipt.content_state==='PRESENT')await routing.register(receipt,{
      ...verifyV27RouteSource(keys,receipt),
      // The frozen v27 payload uses request_json/related_results_json names;
      // routing accepts the independently authenticated decoded pair above.
    });
    else {
      if(!physicallyScrubbed('phase4_operation_receipts',receipt))
        throw new Phase4SchemaError('phase4_route_legacy_redaction_invalid');
      await routing.register(receipt,null,{legacyUnknown:true});
    }
  }
  await requireZero(client,`SELECT 1 FROM phase4_operation_receipts r LEFT JOIN phase4_receipt_routes x
    ON x.user_id=r.user_id AND x.execution_mode=r.execution_mode AND x.operation_kind=r.operation_kind
      AND x.operation_key=r.operation_key WHERE x.operation_key IS NULL LIMIT 1`,'v29_receipt_route_coverage');
  await requireZero(client,`SELECT 1 FROM phase4_receipt_routes x LEFT JOIN phase4_operation_receipts r
    ON x.user_id=r.user_id AND x.execution_mode=r.execution_mode AND x.operation_kind=r.operation_kind
      AND x.operation_key=r.operation_key WHERE r.operation_key IS NULL LIMIT 1`,'v29_route_receipt_coverage');
  if((await client.execute('PRAGMA integrity_check')).rows[0]?.integrity_check!=='ok')
    throw new Phase4SchemaError('phase4_route_integrity_check_failed');
  if((await client.execute('PRAGMA foreign_key_check')).rows.length)
    throw new Phase4SchemaError('phase4_route_foreign_key_check_failed');
}

async function backfillV30(client,keys) {
  requirePhase4Keys(keys);
  const routing=createReceiptRouting(client,keys),directory=createFamilyDirectory(client,keys),metrics=Object.keys(PHASE4_METRICS);
  const nonEpisodeOperations=new Set(['INSIGHT_CREATE','INSIGHT_TRANSITION','expireInsight','analyzeAssociationFamily',
    'BODY_ENERGY_COMPUTE','BODY_ENERGY_CHECKPOINT']);
  // Migration may scan historical rows once. Runtime family discovery must
  // rely on the signed directory/route manifest fence instead.
  await requireZero(client,`SELECT 1 FROM phase4_operation_receipts r LEFT JOIN phase4_receipt_routes x
    ON x.user_id=r.user_id AND x.execution_mode=r.execution_mode AND x.operation_kind=r.operation_kind
      AND x.operation_key=r.operation_key WHERE x.operation_key IS NULL LIMIT 1`,'v30_receipt_route_coverage');
  await requireZero(client,`SELECT 1 FROM phase4_receipt_routes x LEFT JOIN phase4_operation_receipts r
    ON x.user_id=r.user_id AND x.execution_mode=r.execution_mode AND x.operation_kind=r.operation_kind
      AND x.operation_key=r.operation_key WHERE r.operation_key IS NULL LIMIT 1`,'v30_route_receipt_coverage');
  const scopes=(await client.execute(`SELECT c.user_id,c.execution_mode,c.input_generation,c.algorithm_set_version,
    s.source_generation,s.purge_generation
    FROM phase4_computation_state c JOIN phase4_user_state s ON s.user_id=c.user_id
    WHERE c.execution_mode='SHADOW' ORDER BY c.user_id`)).rows;
  for(const scope of scopes) {
    const context={userId:scope.user_id,executionMode:scope.execution_mode,inputGeneration:scope.input_generation,
      sourceGeneration:scope.source_generation,purgeGeneration:scope.purge_generation,
      algorithmSetVersion:scope.algorithm_set_version,authGeneration:0,lifecycleGeneration:0};
    const sourceByMetricToken=new Map();
    for(const metricKey of metrics) {
      const identity=directory.source(context,metricKey);
      sourceByMetricToken.set(routing.token(context.userId,context.executionMode,'EPISODE',
        [metricKey,identity.identity.domain]),metricKey);
      await directory.ensureManifest(context,identity.token,'COMPLETE',metricKey);
    }
    const candidates=new Map(),unknownMetrics=new Set(),routes=(await client.execute({sql:`SELECT * FROM phase4_receipt_routes
      WHERE user_id=? AND execution_mode=? ORDER BY operation_kind,operation_key`,
      args:[context.userId,context.executionMode]})).rows;
    for(const route of routes) {
      const subjects=routing.verifyReceipt(route);
      for(const [kind,token] of subjects)if(kind==='EPISODE_FAMILY') {
        const bound=(await client.execute({sql:`SELECT * FROM phase4_receipt_route_entries WHERE user_id=?
          AND execution_mode=? AND subject_kind='EPISODE_FAMILY' AND subject_token=?
          AND operation_kind=? AND operation_key=?`,args:[context.userId,context.executionMode,
          token,route.operation_kind,route.operation_key]})).rows[0];
        if(!bound)throw new Phase4SchemaError('v30_family_route_binding_missing');
        routing.verifyEntry(bound);
      }
      if(route.route_state==='LEGACY_ROUTE_UNKNOWN'){
        // The v27 privacy artifact identity survives redaction and binds the
        // operation kind/key independently of the later v29 route HMAC. A
        // signed v29 route alone must not bless a pre-migration altered kind.
        const receipt=(await client.execute({sql:`SELECT privacy_artifact_id FROM phase4_operation_receipts
          WHERE user_id=? AND execution_mode=? AND operation_kind=? AND operation_key=?`,
          args:[context.userId,context.executionMode,route.operation_kind,route.operation_key]})).rows[0];
        const bound=receipt?.privacy_artifact_id===keys.lookup(['privacy-artifact-v1','phase4_operation_receipts',
          context.userId,context.executionMode,[route.operation_kind,route.operation_key]]);
        // Only known producer contracts that cannot create an episode family
        // can narrow the episode directory. Other or unbound kinds remain
        // unknown; their insight uncertainty remains in v29 routing.
        if(!bound||!nonEpisodeOperations.has(route.operation_kind))
          for(const metricKey of metrics)unknownMetrics.add(metricKey);
        continue;
      }
      if(!route.operation_kind.startsWith('EPISODE_'))continue;
      const familyTokens=subjects.filter(([kind])=>kind==='EPISODE_FAMILY').map(([,token])=>token);
      const metricKeys=subjects.filter(([kind])=>kind==='EPISODE')
        .map(([,token])=>sourceByMetricToken.get(token)).filter(Boolean);
      if(!metricKeys.length)continue;
      if(!familyTokens.length){for(const metricKey of metricKeys)unknownMetrics.add(metricKey);continue;}
      const receipt=(await client.execute({sql:`SELECT * FROM phase4_operation_receipts
        WHERE user_id=? AND execution_mode=? AND operation_kind=? AND operation_key=?`,
        args:[context.userId,context.executionMode,route.operation_kind,route.operation_key]})).rows[0];
      if(!receipt)throw new Phase4SchemaError('v30_route_receipt_missing');
      let identity=null;
      if(receipt.content_state==='PRESENT')try {
        const decoded=verifyV27RouteSource(keys,receipt);
        identity=decoded.request.request.identity??null;
      } catch { /* Typed uncertainty: a corrupt payload cannot name a family. */ }
      for(const metricKey of metricKeys)for(const token of familyTokens) {
        const key=`${metricKey}:${token}`,prior=candidates.get(key);
        const matched=identity?.metric===metricKey&&directory.family(context,identity).token===token;
        if(!prior||matched&&!prior.identity)candidates.set(key,{metricKey,token,identity:matched?{
          metric:identity.metric,domain:identity.domain,algorithmMajor:identity.algorithmMajor,
          subject:identity.subject,windowFamily:identity.windowFamily}:null});
      }
    }
    for(const {metricKey,token,identity} of candidates.values()) {
      await directory.register(context,identity??{metric:metricKey},{legacyToken:identity?null:token,repairInterrupted:true});
      if(!identity)unknownMetrics.add(metricKey);
    }
    for(const metricKey of unknownMetrics)await directory.markUnknown(context,metricKey);
    for(const metricKey of metrics)await directory.touchSource(context,metricKey);
    for(const metricKey of metrics)try {await directory.inventory(context,metricKey);}
    catch(error){if(error?.code!=='PHASE4_FAMILY_DIRECTORY_LEGACY_UNKNOWN')throw error;}
  }
  if((await client.execute('PRAGMA integrity_check')).rows[0]?.integrity_check!=='ok')
    throw new Phase4SchemaError('v30_integrity_check_failed');
  if((await client.execute('PRAGMA foreign_key_check')).rows.length)
    throw new Phase4SchemaError('v30_foreign_key_check_failed');
}

export async function verifyPhase4Schema(client, version = EXPECTED_SCHEMA_VERSION, options = {}) {
  const migrations = PHASE4_MIGRATIONS.filter(m => m.version <= version);
  const replacements = migrations.flatMap(m=>m.replacements ?? []);
  const nextReplacements = options.resuming ? PHASE4_MIGRATIONS.find(m=>m.version === version + 1)?.replacements ?? [] : [];
  const additions=migrations.flatMap(m=>m.columns??[]);
  if(options.resuming)for(const column of PHASE4_MIGRATIONS.find(m=>m.version===version+1)?.columns??[]) {
    if((await client.execute(`PRAGMA table_info(${column.table})`)).rows.some(row=>row.name===column.column))additions.push(column);
  }
  for (const migration of migrations) {
    for (const ddl of migration.ddl) await verifyPhase4Definition(client, ddl,additions);
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
  for (const table of [...(version >= 23 ? V23_TABLES : []), ...(version >= 24 ? V24_TABLES : []), ...(version >= 25 ? V25_TABLES : []), ...(version >= 26 ? V26_TABLES : []), ...(version >= 27 ? V27_TABLES : []), ...(version >= 29 ? V29_TABLES : []), ...(version >= 30 ? V30_TABLES : [])]) {
    await requireZero(client, `SELECT 1 FROM ${table} p LEFT JOIN users u ON u.id=p.user_id WHERE u.id IS NULL LIMIT 1`, `${table}_tenant`);
    if (options.backfillVersion === 24 && V24_TABLES.includes(table)) await requireZero(client,
      `SELECT 1 FROM ${table} WHERE execution_mode <> 'SHADOW' LIMIT 1`, `${table}_no_migration_live`);
  }
  if(version>=29) {
    await requireZero(client,`SELECT 1 FROM phase4_operation_receipts r LEFT JOIN phase4_receipt_routes x
      ON x.user_id=r.user_id AND x.execution_mode=r.execution_mode AND x.operation_kind=r.operation_kind
      AND x.operation_key=r.operation_key WHERE x.operation_key IS NULL LIMIT 1`,'v29_receipt_route_coverage');
    await requireZero(client,`SELECT 1 FROM phase4_receipt_routes x LEFT JOIN phase4_operation_receipts r
      ON x.user_id=r.user_id AND x.execution_mode=r.execution_mode AND x.operation_kind=r.operation_kind
      AND x.operation_key=r.operation_key WHERE r.operation_key IS NULL LIMIT 1`,'v29_route_receipt_coverage');
    await requireZero(client,`SELECT 1 FROM phase4_receipt_route_entries e LEFT JOIN phase4_receipt_routes r
      ON r.user_id=e.user_id AND r.execution_mode=e.execution_mode AND r.operation_kind=e.operation_kind
      AND r.operation_key=e.operation_key WHERE r.operation_key IS NULL LIMIT 1`,'v29_orphan_route_entry');
    await requireZero(client,`SELECT 1 FROM phase4_receipt_route_entries e LEFT JOIN phase4_receipt_route_manifests m
      ON m.user_id=e.user_id AND m.execution_mode=e.execution_mode AND m.subject_kind=e.subject_kind
      AND m.subject_token=e.subject_token WHERE m.subject_token IS NULL LIMIT 1`,'v29_orphan_route_manifest');
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
    for (const {oldName,ddl,kind = 'INDEX'} of migration.replacements ?? []) {
      await client.execute(ddl);
      await verifyPhase4Definition(client,ddl);
      await client.execute(`DROP ${kind} IF EXISTS ${oldName}`);
    }
    if (migration.version === 29) await backfillV29(client,options.privacyKeys);
    if (migration.version === 30) await backfillV30(client,options.privacyKeys);
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
