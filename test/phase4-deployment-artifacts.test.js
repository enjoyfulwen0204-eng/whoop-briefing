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
    'authorized zh-TW and vi controlled READY smoke', 'EN_IMPLEMENTED_AND_TESTED_NO_LIVE_USER_YET', 'no third human is required',
    'Restoring the pre-migration snapshot may discard writes',
    'FINAL_REVIEWED_RC_SHA', 'Manually deploy', 'maintenance mode **ON**',
    'public ingress **closed**', 'Render deploy ID', 'deployed commit SHA',
    'deployed SHA **exactly equal** `FINAL_REVIEWED_RC_SHA`',
    'deploy status to be successful/live', 'do not reopen ingress',
    'DB connectivity reports v31', 'Beta SHADOW runtime is OFF',
    'Public Beta presentation is OFF', 'no LIVE execution exists',
    'Keep auto-deploy **Off throughout the later push, RC/tag publication, backup, migration, manual RC deployment',
  ]) assert.ok(guide.includes(required), required);
  assert.equal(MAX_ATTEMPTS, 2);
  assert.equal(TIMEOUT_MS, 180_000);
  assert.equal(MAX_CONFIGURED_WINDOW_MS, 561_000);
  assert.equal(15 * 60_000 + Math.max(MAX_CONFIGURED_WINDOW_MS, 15 * 60_000) + 60_000,
    31 * 60_000);
});

test('default-branch transition artifact pins source and supports all three gated stages', () => {
  const artifact = read('docs/phase4-main-workflow.yml');
  assert.match(artifact, /ref: REVIEWED_RELEASE_SHA/);
  assert.equal((artifact.match(/ref: REVIEWED_RELEASE_SHA/g) ?? []).length, 2);
  assert.equal((artifact.match(/timeout-minutes: 10/g) ?? []).length, 2);
  assert.equal((artifact.match(/PHASE4_RELEASE_SHA: REVIEWED_RELEASE_SHA/g)??[]).length,4);
  assert.equal((artifact.match(/actual_sha=\$\(git rev-parse --verify 'HEAD\^\{commit\}'\)/g)??[]).length,2);
  assert.equal((artifact.match(/test "\$actual_sha" = "\$PHASE4_RELEASE_SHA"/g)??[]).length,2);
  assert.match(artifact, /needs: sync/);
  assert.match(artifact, /needs.sync.result == 'success'/);
  assert.match(artifact, /sync_complete == 'true'/);
  assert.match(artifact, /PHASE4_EXECUTION_PHASE: SYNC/);
  assert.match(artifact, /PHASE4_EXECUTION_PHASE: STAGE6_DRAIN/);
  assert.match(artifact, /node scripts\/phase4-run\.js/g);
  assert.doesNotMatch(artifact, /on:all\)|ref: main|ref: v1\.2-phase4/);
  assert.match(artifact, /PHASE4_PUBLIC_BETA_MODE: \$\{\{ vars\.PHASE4_PUBLIC_BETA_MODE \}\}/);
  assert.match(artifact, /cron: "17 \* \* \* \*"/);
  const shell = artifact.split('        run: |\n')[1].split('\n').map(line => line.replace(/^          /, '')).join('\n');
  assert.equal(spawnSync('bash', ['-n'], { input: shell, encoding: 'utf8' }).status, 0);
  assert.match(read('cloudflare/briefing-scheduler/wrangler.toml'), /crons = \[\]/);
  assert.match(read('docs/phase4-public-beta-preparation.md'), /checked-in Cloudflare Worker target is already/);
});
