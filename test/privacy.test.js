import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { WHOOP } from '../src/config.js';
import { buildAuthorizeUrl } from '../src/whoop.js';
const policy = fs.readFileSync(new URL('../public/privacy.html', import.meta.url), 'utf8');
const renderConfig = fs.readFileSync(new URL('../render.yaml', import.meta.url), 'utf8');

test('static privacy policy is standalone and contains the required contact', () => {
  assert.match(policy, /^<!doctype html>/i);
  assert.match(policy, /<meta charset="utf-8">/i);
  assert.match(policy, /Kelvin Health OS Privacy Policy/);
  assert.match(policy, /enjoyfulwen@hotmail\.com/);
  assert.match(policy, /application-derived estimates/);
  assert.doesNotMatch(policy, /<script|https?:\/\//i);
});

test('static privacy policy contains no credential material or external assets', () => {
  for (const forbidden of [
    'WHOOP_CLIENT_SECRET', 'OPENROUTER_API_KEY', 'TELEGRAM_BOT_TOKEN',
    'TURSO_AUTH_TOKEN', ['-----BEGIN', 'PRIVATE KEY-----'].join(' '),
  ]) assert.ok(!policy.includes(forbidden));
  assert.doesNotMatch(policy, /<(?:img|link|iframe|video|audio|source)\b/i);
});

test('Render serves the policy as a credential-free static site at /privacy', () => {
  const privacyService = renderConfig.match(
    /- type: web\n    name: whoop-privacy\n([\s\S]*?)(?=\n  # -{10,}\n  # 1\.)/,
  )?.[1] ?? '';
  assert.match(privacyService, /runtime: static/);
  assert.match(privacyService, /staticPublishPath: \.\/public/);
  assert.match(privacyService, /source: \/privacy\n        destination: \/privacy\.html/);
  assert.doesNotMatch(privacyService, /\b(?:plan|startCommand|healthCheckPath|envVars):/);
});

test('WHOOP production scopes are exactly the resources the application uses', () => {
  assert.deepEqual(new Set(WHOOP.SCOPES.split(/\s+/)), new Set([
    'offline', 'read:recovery', 'read:cycles', 'read:sleep', 'read:workout',
    'read:profile', 'read:body_measurement',
  ]));
});

test('WHOOP example redirect is executable configuration, not Markdown', () => {
  const example = fs.readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
  assert.match(example, /^WHOOP_REDIRECT_URI=http:\/\/localhost:8788\/callback$/m);
  assert.doesNotMatch(example, /\[http:\/\/localhost:8788\/callback\]\(http:\/\/localhost:8788\/callback\)/);

  const auth = new URL(buildAuthorizeUrl({
    clientId: 'example-client',
    redirectUri: 'http://localhost:8788/callback',
    state: 'example-state',
  }));
  assert.equal(auth.searchParams.get('redirect_uri'), 'http://localhost:8788/callback');
  assert.ok(auth.searchParams.get('scope').split(/\s+/).includes('read:profile'));
});
