import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { MAX_ATTEMPTS, TIMEOUT_MS, MAX_CONFIGURED_WINDOW_MS } from '../cloudflare/briefing-scheduler/worker.js';

const read = name => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');

test('deployment gates retain a reviewed backup, writer drain and staged activation', () => {
  const guide = read('docs/phase4-deployment-control.md');
  for (const required of [
    'No push', 'auto-deploy Off', 'queued', 'maintenance mode', 'zero active triggers',
    '31 minutes after T0', 'no in-flight scheduler request', 'MIGRATION MUST NOT START',
    'turso db branch <PRODUCTION_DB_NAME> <UNIQUE_PRE_V31_BRANCH_NAME>',
    'PRAGMA integrity_check', 'PRAGMA foreign_key_check', 'schema',
    'one zh-TW, one en, one vi', 'If only two qualify, presentation remains OFF',
    'Restoring the pre-migration snapshot may discard writes',
  ]) assert.ok(guide.includes(required), required);
  assert.equal(MAX_ATTEMPTS, 3);
  assert.equal(TIMEOUT_MS, 120_000);
  assert.equal(MAX_CONFIGURED_WINDOW_MS, 361_500);
  assert.equal(15 * 60_000 + Math.max(MAX_CONFIGURED_WINDOW_MS, 15 * 60_000) + 60_000,
    31 * 60_000);
});

test('default-branch transition artifact pins source and supports all three gated stages', () => {
  const artifact = read('docs/phase4-main-workflow.yml');
  assert.match(artifact, /ref: REVIEWED_RELEASE_SHA/);
  assert.match(artifact, /off:off\) npm start/);
  assert.match(artifact, /on:off\) node src\/publicBetaEntry\.js/);
  assert.match(artifact, /on:allowlist\)[\s\S]*cohort\[@\][\s\S]*node src\/publicBetaEntry\.js/);
  assert.doesNotMatch(artifact, /on:all\)|ref: main|ref: v1\.2-phase4/);
  assert.match(artifact, /PHASE4_PUBLIC_BETA_MODE: \$\{\{ vars\.PHASE4_PUBLIC_BETA_MODE \}\}/);
  assert.match(artifact, /cron: "17 \* \* \* \*"/);
  const shell = artifact.split('        run: |\n')[1].split('\n').map(line => line.replace(/^          /, '')).join('\n');
  assert.equal(spawnSync('bash', ['-n'], { input: shell, encoding: 'utf8' }).status, 0);
  assert.match(read('cloudflare/briefing-scheduler/wrangler.toml'), /crons = \["\*\/10 0-3 \* \* \*"\]/);
  assert.match(read('docs/phase4-public-beta-preparation.md'), /checked-in Cloudflare Worker target is already/);
});
