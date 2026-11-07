import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import {exportSelectSnapshot} from './selectSnapshot.mjs';
import {localAdapter} from './localAdapter.mjs';
import {denyRehearsalNetwork} from './networkFence.mjs';
import {phase4AuthorityKeys} from '../../src/phase4EnvironmentKeys.js';
import {assertSchemaTransitionProfile, createSchemaTransitionRuntimeProfile, SCHEMA_TRANSITION_PROFILE} from '../../src/schemaTransitionProfile.js';
import {bindConnectionLifetime, admitRuntime} from '../../src/runtimeAdmission.js';
import {rehearseLocal} from './rehearsalChecks.mjs';
import {RECOVERY_PRODUCTION_HOST} from '../../src/recoveryPolicy.js';
import {assertJobStartWindow} from './jobChecks.mjs';
import {fail, failureFields} from './rehearsalDiagnostics.mjs';

const readHead = () => execFileSync('git', ['rev-parse', '--verify', 'HEAD^{commit}'], {
  cwd: new URL('../..', import.meta.url), env: {PATH: process.env.PATH},
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
}).trim();
const operations = {readHead, phase4AuthorityKeys, createSchemaTransitionRuntimeProfile,
  mkdtemp, rm, exportSelectSnapshot, denyRehearsalNetwork, localAdapter, bindConnectionLifetime, admitRuntime, rehearseLocal};
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);

export async function runRehearsal({env = process.env, now = Date.now, emit, ops = operations}) {
  const started = now(), preflight = env.E1B_PREFLIGHT_ONLY === '1';
  const checks = {};
  let step = 'JOB_IDENTITY', firstFailure, head, keys, profile, environment;
  let directory, db;

  // Only a preflight continues collecting independent metadata after a
  // failed guard. It always returns before the filesystem and DB operations.
  function check(name, inspect, timing = false) {
    step = name;
    try {
      inspect();
      checks[name] = true;
    } catch (error) {
      checks[name] = false;
      if (!preflight) throw error;
      if (!timing) firstFailure ??= {step, ...failureFields(error)};
    }
  }

  try {
    check('JOB_IDENTITY', () => {
      checks.ONE_OFF_JOB = env.E1B_ONE_OFF_JOB === '1';
      checks.SERVICE_ID_PRESENT = Boolean(env.RENDER_SERVICE_ID);
      checks.SERVICE_ID_MATCH = env.RENDER_SERVICE_ID === 'srv-dahs71qd0e5s738n94c0';
      if (!checks.ONE_OFF_JOB || !checks.SERVICE_ID_MATCH) fail('REHEARSAL_JOB_REQUIRED');
    });
    const expected = env.E1B_CANDIDATE_SHA, base = env.E1B_EXPECTED_BASE_SHA;
    check('SHA', () => {
      checks.CANDIDATE_SHA_VALID = sha(expected);
      checks.BASE_SHA_VALID = sha(base);
      checks.CLONE_HEAD_MATCH = false;
      if (!checks.CANDIDATE_SHA_VALID || !checks.BASE_SHA_VALID) fail('REHEARSAL_SHA_REQUIRED');
      head = ops.readHead();
      checks.CLONE_HEAD_MATCH = head === expected;
      if (!checks.CLONE_HEAD_MATCH) fail('REHEARSAL_BUILD_MISMATCH');
    });
    check('BUILD_MATCH', () => {
      checks.RENDER_COMMIT_MATCH = sha(base) && env.RENDER_GIT_COMMIT === base;
      checks.RELEASE_SHA_MATCH = sha(base) && env.PHASE4_RELEASE_SHA === base;
      if (!checks.RENDER_COMMIT_MATCH || !checks.RELEASE_SHA_MATCH) fail('REHEARSAL_BUILD_MISMATCH');
    });
    check('DB_IDENTITY', () => {
      checks.DB_URL_PRESENT = Boolean(env.TURSO_DATABASE_URL);
      checks.DB_HOST_MATCH = false;
      const url = new URL(env.TURSO_DATABASE_URL);
      checks.DB_HOST_MATCH = url.hostname === RECOVERY_PRODUCTION_HOST;
      if (!['libsql:', 'https:'].includes(url.protocol) || !checks.DB_HOST_MATCH || url.username || url.password ||
          url.port || !['', '/'].includes(url.pathname) || url.search || url.hash) fail('REHEARSAL_DATABASE_IDENTITY_MISMATCH');
    });
    const at = new Date(now());
    check('START_WINDOW', () => assertJobStartWindow(at), true);
    check('AFTER_CRON', () => {
      const minute = at.getUTCMinutes();
      if (minute < 14 || minute >= 55) fail('REHEARSAL_AFTER_CRON_REQUIRED');
    }, true);
    check('KEYS', () => {
      checks.LOOKUP_KEY_PRESENT = Boolean(env.PHASE4_LOOKUP_KEY);
      checks.AUDIT_KEY_PRESENT = Boolean(env.PHASE4_AUDIT_KEY);
      keys = ops.phase4AuthorityKeys(env);
    });
    check('RUNTIME_PROFILE', () => {
      checks.EXECUTION_PROFILE_MATCH = env.PHASE4_EXECUTION_PROFILE === SCHEMA_TRANSITION_PROFILE;
      checks.PROFILE_FIELDS_VALID = false;
      assertSchemaTransitionProfile(env);
      checks.PROFILE_FIELDS_VALID = true;
      environment = {...env, RENDER_GIT_COMMIT: head, PHASE4_RELEASE_SHA: head};
      profile = ops.createSchemaTransitionRuntimeProfile({environment, keys});
    });

    if (preflight) {
      emit({phase: 'PREFLIGHT', ...checks});
      if (firstFailure) emit({phase: 'COMPLETE', pass: false, ...firstFailure, duration_ms: now() - started});
      else emit({phase: 'COMPLETE', pass: true});
      return !firstFailure;
    }

    try {
      step = 'TMPDIR';
      directory = await ops.mkdtemp(join(tmpdir(), 'e1b-one-off-'));
      const path = join(directory, 'snapshot.sqlite');
      step = 'EXPORT_CONNECT';
      const copied = await ops.exportSelectSnapshot({url: env.TURSO_DATABASE_URL, token: env.TURSO_AUTH_TOKEN,
        path, onReadStart: () => { step = 'EXPORT_READ'; }});
      emit({phase: 'EXPORT', pass: true, tables: copied.tables, rows: copied.rows, duration_ms: now() - started});
      step = 'LOCAL_ADMIT';
      for (const target of [env, environment]) {
        for (const name of Object.keys(target)) if (/TURSO|TOKEN|SECRET|(?:^|_)KEY(?:$|_)/.test(name)) delete target[name];
      }
      ops.denyRehearsalNetwork();
      db = ops.localAdapter(path);
      ops.bindConnectionLifetime(db.raw, db.raw, db.transaction, {runtimeProfile: profile, keys});
      const admit = () => ops.admitRuntime(db.raw, keys);
      await admit();
      step = 'REHEARSE';
      await ops.rehearseLocal({db, keys, environment, at: new Date(now()), admit, emit});
    } finally {
      try { db?.raw.close(); }
      finally { if (directory) await ops.rm(directory, {recursive: true, force: true}); }
    }
    emit({phase: 'COMPLETE', pass: true, duration_ms: now() - started});
    return true;
  } catch (error) {
    emit({phase: 'COMPLETE', pass: false, step, ...failureFields(error), duration_ms: now() - started});
    return false;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  for (const method of ['log', 'info', 'warn', 'error', 'debug', 'trace']) console[method] = () => {};
  if (!await runRehearsal({emit: record => process.stdout.write(JSON.stringify(record) + '\n')})) process.exitCode = 1;
}
