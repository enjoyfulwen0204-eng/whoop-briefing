#!/usr/bin/env node
/** Controlled v20→v31 migration. No dotenv loading: the operator supplies one explicit target. */
import { createClient } from '@libsql/client';
import { execFileSync } from 'node:child_process';
import { currentVersion, inspectReshape, runMigrations } from '../src/migrations.js';
import { assertPhase4Schema } from '../src/phase4Migrations.js';
import { createPhase4Keys } from '../src/phase4Keys.js';
import { establishPhase4KeyContinuity } from '../src/phase4KeyContinuity.js';

const PRESERVED = ['users', 'user_telegram', 'user_whoop_tokens', 'whoop_sleeps',
  'whoop_recoveries', 'whoop_cycles', 'whoop_workouts', 'journal_events', 'report_runs'];
const PRODUCTION_HOST = 'whoop-briefing-enjoyfulwen0204-eng.aws-ap-northeast-1.turso.io';

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
export async function controlledMigration(client, { apply, keys }) {
  const from = await currentVersion(client);
  if (from < 20 || from > 31) fail('MIGRATION_VERSION_OUT_OF_RANGE');
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
  if (from === 31) await assertPhase4Schema(client, 31);
  if (!apply) return { mode: 'preflight', from, target: 31, checkpointBootstrapVersion: from === 20 ? 21 : null,
    health: beforeHealth, preservedCounts: before };
  const result = await runMigrations(client, { allowRebuild: false, targetVersion: 31, privacyKeys: keys });
  await assertPhase4Schema(client, 31);
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
  return { mode: 'apply', from, target: 31, versionsApplied: [...(from === 20 ? [21] : []), ...result.versionsApplied],
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
    else if (['--expected-target', '--expected-commit', '--confirm-production'].includes(arg)) opt[arg.slice(2)] = argv[++i];
    else fail('MIGRATION_ARGUMENT_INVALID');
  }
  if (!opt.mode || !opt['expected-target']) fail('MIGRATION_ARGUMENT_REQUIRED');
  return opt;
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  if (Number(process.versions.node.split('.')[0]) !== 22) fail('MIGRATION_NODE22_REQUIRED');
  const opt = options(argv);
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
    const result = await controlledMigration(db, { apply: opt.mode === 'apply', keys });
    console.log(JSON.stringify({ databaseTarget: opt['expected-target'], ...result }));
    return result;
  } finally { db.close(); }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    const continuityCodes = new Set(['PHASE4_AUDIT_KEY_CONTINUITY_UNPROVEN',
      'PHASE4_LOOKUP_KEY_CONTINUITY_UNPROVEN', 'PHASE4_AUDIT_KEY_MISMATCH',
      'PHASE4_LOOKUP_KEY_MISMATCH', 'PHASE4_KEY_CHECKPOINT_STORAGE_REQUIRED',
      'PHASE4_KEY_CHECKPOINT_STORAGE_INVALID']);
    console.error(error?.code && (/^MIGRATION_/.test(error.code) || continuityCodes.has(error.code))
      ? error.code : 'MIGRATION_FAILED');
    process.exitCode = 1;
  });
}
