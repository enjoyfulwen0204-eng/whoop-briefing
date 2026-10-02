import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createClient } from '@libsql/client';
import { runMigrations } from '../src/migrations.js';
import { fixtureKeys } from './localDb.js';
import { main } from '../src/bot/webhook.js';
import { publicBetaConfiguration } from '../src/publicBetaConfig.js';

test('v31-compatible webhook starts with beta gates OFF and serves legacy health ingress', async t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'phase4-rollback-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const url = `file:${path.join(dir, 'fixture.db')}`;
  const fixture = createClient({ url });
  await runMigrations(fixture, { targetVersion: 31, privacyKeys: fixtureKeys });
  fixture.close();
  const vars = {
    TURSO_DATABASE_URL: url, TURSO_AUTH_TOKEN: 'fixture-only',
    TELEGRAM_BOT_TOKEN: 'fixture-only', TELEGRAM_WEBHOOK_SECRET: 'fixture-only',
    TELEGRAM_CHAT_ID: 'fixture-only', OPENROUTER_API_KEY: 'fixture-only',
    WHOOP_CLIENT_ID: '', WHOOP_CLIENT_SECRET: '', WHOOP_REDIRECT_URI: '',
    BRIEFING_TRIGGER_SECRET: '', WHOOP_WEBHOOK_ENABLED: 'false',
    PHASE4_BETA_SHADOW_RUNTIME: 'off', PHASE4_PUBLIC_BETA_MODE: 'off',
    PHASE4_PUBLIC_BETA_USER_IDS: '', PHASE4_LOOKUP_KEY: Buffer.alloc(32, 71).toString('hex'),
    PHASE4_AUDIT_KEY: Buffer.alloc(32, 83).toString('hex'),
  };
  const saved = Object.fromEntries(Object.keys(vars).map(key => [key, process.env[key]]));
  Object.assign(process.env, vars);
  let running;
  try {
    assert.equal(publicBetaConfiguration(process.env).runtime, 'off');
    assert.equal(publicBetaConfiguration(process.env).mode, 'off');
    running = await main({ listen: false });
    await new Promise(resolve => running.server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${running.server.address().port}`;
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).ok, true);
    const scheduler = await fetch(`${base}/internal/briefing/run`, { method: 'POST', body: '{}' });
    assert.equal(scheduler.status, 503);
    const telegram = await fetch(`${base}/telegram/webhook`, { method: 'POST', body: '{}' });
    assert.equal(telegram.status, 401);
    const live = await running.db.raw.execute("SELECT COUNT(*) AS n FROM phase4_computation_state WHERE execution_mode='LIVE'");
    assert.equal(Number(live.rows[0].n), 0);
    process.env.PHASE4_AUDIT_KEY = '';
    await assert.rejects(main({ listen: false }), /PHASE4_PRIVACY_KEYS_REQUIRED/);
    process.env.PHASE4_LOOKUP_KEY = '';
    await assert.rejects(main({ listen: false }), /PHASE4_PRIVACY_KEYS_REQUIRED/);
  } finally {
    if (running?.server?.listening) await new Promise(resolve => running.server.close(resolve));
    running?.db?.close();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
