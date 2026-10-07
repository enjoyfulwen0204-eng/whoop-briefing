#!/usr/bin/env node
/** Controlled historical v20→v31 or narrow v31→v32 migration. No dotenv loading. */
import { createClient } from '@libsql/client';
import { execFileSync } from 'node:child_process';
import { currentVersion, inspectReshape, runMigrations } from '../src/migrations.js';
import { assertPhase4Schema } from '../src/phase4Migrations.js';
import { createPhase4Keys } from '../src/phase4Keys.js';
import { establishPhase4KeyContinuity } from '../src/phase4KeyContinuity.js';
import { EXPERIMENT_FIELDS, V22_LEGACY_R_TABLES } from '../src/phase4V22Schema.js';

const PRESERVED = ['users', 'user_telegram', 'user_whoop_tokens', 'whoop_sleeps',
  'whoop_recoveries', 'whoop_cycles', 'whoop_workouts', 'journal_events', 'report_runs'];
const PRODUCTION_HOST = 'whoop-briefing-enjoyfulwen0204-eng.aws-ap-northeast-1.turso.io';
const CONTINUITY_CODES = new Set(['PHASE4_AUDIT_KEY_CONTINUITY_UNPROVEN',
  'PHASE4_LOOKUP_KEY_CONTINUITY_UNPROVEN', 'PHASE4_AUDIT_KEY_MISMATCH',
  'PHASE4_LOOKUP_KEY_MISMATCH', 'PHASE4_KEY_CHECKPOINT_STORAGE_REQUIRED',
  'PHASE4_KEY_CHECKPOINT_STORAGE_INVALID']);
const MIGRATION_CODES = new Set(['MIGRATION_KEYS_REQUIRED', 'MIGRATION_TARGET_INVALID',
  'MIGRATION_DATABASE_UNHEALTHY', 'MIGRATION_VERSION_OUT_OF_RANGE',
  'MIGRATION_RESHAPE_BLOCKED', 'MIGRATION_DATA_COUNT_CHANGED',
  'MIGRATION_EXISTING_LOCALE_NOT_UNSET', 'MIGRATION_CREATED_LIVE_STATE',
  'MIGRATION_BODY_ENERGY_CREATED', 'MIGRATION_ARGUMENT_INVALID',
  'MIGRATION_ARGUMENT_REQUIRED', 'MIGRATION_NODE22_REQUIRED',
  'MIGRATION_TARGET_MISMATCH', 'MIGRATION_PRODUCTION_HOST_UNAPPROVED',
  'MIGRATION_DB_AUTH_REQUIRED', 'MIGRATION_PRODUCTION_CONFIRMATION_REQUIRED',
  'MIGRATION_COMMIT_REQUIRED', 'MIGRATION_RELEASE_TREE_MISMATCH',
  'MIGRATION_VERIFICATION_QUERY_FAILED', 'MIGRATION_POSTCONDITION_FAILED']);
const PROVIDER_CAUSE_CODES = new Set(['UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT', 'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN',
  'ENOTFOUND', 'SQLITE_BUSY', 'SQLITE_LOCKED', 'SQLITE_IOERR']);
const VERIFICATION_OPERATIONS = new Set([
  ...V22_LEGACY_R_TABLES.flatMap(table => [`${table}_identity`, `${table}_redaction`,
    `${table}_linkage`, `${table}_diagnostic_redaction`]),
  'receipt_quarantine', 'journal_backfill', 'ten_experiment_leaves', 'experiment_provenance',
  ...Object.keys(EXPERIMENT_FIELDS).map(field => `experiment_${field}_redaction`),
]);

/** Serialize only known diagnostic identifiers; never serialize Error.message/cause. */
export function safeMigrationError(error) {
  const code = typeof error?.code === 'string' &&
    (MIGRATION_CODES.has(error.code) || CONTINUITY_CODES.has(error.code))
    ? error.code : 'MIGRATION_FAILED';
  const report = { code };
  if (error?.migrationVersion === 22 && error?.migrationPhase === 'verification'
      && VERIFICATION_OPERATIONS.has(error?.migrationOperation)) {
    report.version = 'v22';
    report.phase = 'verification';
    report.operation = error.migrationOperation;
  }
  if (['Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError'].includes(error?.name))
    report.errorClass = error.name;
  const causeCode = error?.cause?.code;
  if (PROVIDER_CAUSE_CODES.has(causeCode))
    report.causeCode = causeCode;
  return report;
}

function fail(code) { const error = new Error(code); error.code = code; throw error; }
function keyFromEnv(env, name) {
  const value = env[name];
  if (typeof value !== 'string' || !/^(?:[a-f0-9]{2}){32,}$/i.test(value)) fail('MIGRATION_KEYS_REQUIRED');
  return Buffer.from(value, 'hex');
}
function targetIdentity(url) {
  let target;
  try { target = new URL(url); } catch { fail('MIGRATION_TARGET_INVALID'); }
  if (target.protocol === 'file:') return target.href;
  if (target.protocol !== 'libsql:' || target.hostname !== PRODUCTION_HOST
      || target.username || target.password || target.port
      || (target.pathname !== '' && target.pathname !== '/')
      || target.search || target.hash
      || (url !== `libsql://${PRODUCTION_HOST}` && url !== `libsql://${PRODUCTION_HOST}/`))
    fail('MIGRATION_TARGET_INVALID');
  return target.hostname;
}
async function count(client, table) {
  return Number((await client.execute(`SELECT COUNT(*) AS n FROM ${table}`)).rows[0].n);
}
async function snapshot(client) {
  return Object.fromEntries(await Promise.all(PRESERVED.map(async table => [table, await count(client, table)])));
}
async function health(client) {
  return {
    integrity: String((await client.execute('PRAGMA integrity_check')).rows[0]?.integrity_check ?? ''),
    foreignKeyViolations: (await client.execute('PRAGMA foreign_key_check')).rows.length,
  };
}
function assertHealthy(check) {
  if (check.integrity !== 'ok' || check.foreignKeyViolations !== 0) fail('MIGRATION_DATABASE_UNHEALTHY');
}

/** Exported so tests can exercise the same control path on isolated file databases. */
export async function controlledMigration(client, { apply, keys, targetVersion=31 }) {
  const from = await currentVersion(client);
  if(targetVersion!==31&&targetVersion!==32)fail('MIGRATION_VERSION_OUT_OF_RANGE');
  if (from < (targetVersion===32?31:20) || from > targetVersion) fail('MIGRATION_VERSION_OUT_OF_RANGE');
  const beforeHealth = await health(client);
  assertHealthy(beforeHealth);
  // v21 introduces the frozen checkpoint table and has no key-derived writes.
  // Preflight on v20 intentionally performs this one-time bootstrap; it must
  // therefore run only after the verified backup and writer quiet-window gate.
  if (from === 20) await runMigrations(client, { allowRebuild: false, targetVersion: 21 });
  await establishPhase4KeyContinuity(client, keys, Math.max(from, 21));
  const shape = await inspectReshape(client);
  if (shape.blocked.length || shape.rebuild.length) fail('MIGRATION_RESHAPE_BLOCKED');
  const before = await snapshot(client);
  if (from === targetVersion) await assertPhase4Schema(client, targetVersion);
  if (!apply) return { mode: 'preflight', from, target: targetVersion, checkpointBootstrapVersion: from === 20 ? 21 : null,
    health: beforeHealth, preservedCounts: before };
  const result = await runMigrations(client, { allowRebuild: false, targetVersion, privacyKeys: keys });
  await assertPhase4Schema(client, targetVersion);
  const afterHealth = await health(client);
  assertHealthy(afterHealth);
  const after = await snapshot(client);
  for (const table of PRESERVED) if (before[table] !== after[table]) fail('MIGRATION_DATA_COUNT_CHANGED');
  const localeRows = await count(client, 'user_locales');
  if (from < 31 && localeRows !== 0) fail('MIGRATION_EXISTING_LOCALE_NOT_UNSET');
  const liveRows = await count(client, 'phase4_computation_state');
  const live = Number((await client.execute(
    "SELECT COUNT(*) AS n FROM phase4_computation_state WHERE execution_mode='LIVE'",
  )).rows[0].n);
  if (live !== 0) fail('MIGRATION_CREATED_LIVE_STATE');
  const bodyEnergyRows = await count(client, 'body_energy_results');
  if (from === 20 && bodyEnergyRows !== 0) fail('MIGRATION_BODY_ENERGY_CREATED');
  return { mode: 'apply', from, target: targetVersion, versionsApplied: [...(from === 20 ? [21] : []), ...result.versionsApplied],
    health: afterHealth, preservedCounts: after, localeRows, computationRows: liveRows,
    liveRows: live, bodyEnergyRows };
}

function options(argv) {
  const opt = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--preflight' || arg === '--apply') {
      if (opt.mode) fail('MIGRATION_ARGUMENT_INVALID');
      opt.mode = arg.slice(2);
    }
    else if (['--expected-target', '--expected-commit', '--confirm-production','--target-version'].includes(arg)) opt[arg.slice(2)] = argv[++i];
    else fail('MIGRATION_ARGUMENT_INVALID');
  }
  if (!opt.mode || !opt['expected-target']) fail('MIGRATION_ARGUMENT_REQUIRED');
  return opt;
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  if (Number(process.versions.node.split('.')[0]) !== 22) fail('MIGRATION_NODE22_REQUIRED');
  const opt = options(argv);
  const targetVersion = Number(opt['target-version'] ?? 31);
  if (![31, 32].includes(targetVersion)) fail('MIGRATION_VERSION_OUT_OF_RANGE');
  const url = env.TURSO_DATABASE_URL;
  if (!url) fail('MIGRATION_TARGET_MISMATCH');
  const production = !url.startsWith('file:');
  const expected = production ? opt['expected-target'] : new URL(opt['expected-target']).href;
  if (targetIdentity(url) !== expected) fail('MIGRATION_TARGET_MISMATCH');
  if (production) {
    if (expected !== PRODUCTION_HOST) fail('MIGRATION_PRODUCTION_HOST_UNAPPROVED');
    if (!env.TURSO_AUTH_TOKEN) fail('MIGRATION_DB_AUTH_REQUIRED');
    if (opt.mode === 'apply' && opt['confirm-production'] !== 'whoop-briefing')
      fail('MIGRATION_PRODUCTION_CONFIRMATION_REQUIRED');
    if (!opt['expected-commit'] || !/^[a-f0-9]{40}$/i.test(opt['expected-commit'])) fail('MIGRATION_COMMIT_REQUIRED');
    const actual = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const dirty = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim();
    if (actual !== opt['expected-commit'] || dirty) fail('MIGRATION_RELEASE_TREE_MISMATCH');
  }
  const keys = createPhase4Keys({
    lookupKey: keyFromEnv(env, 'PHASE4_LOOKUP_KEY'),
    auditKey: keyFromEnv(env, 'PHASE4_AUDIT_KEY'),
  });
  const db = createClient({ url, authToken: env.TURSO_AUTH_TOKEN });
  try {
    const result = await controlledMigration(db, { apply: opt.mode === 'apply', keys, targetVersion });
    console.log(JSON.stringify({ databaseTarget: opt['expected-target'], ...result }));
    return result;
  } finally { db.close(); }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    console.error(JSON.stringify(safeMigrationError(error)));
    process.exitCode = 1;
  });
}
