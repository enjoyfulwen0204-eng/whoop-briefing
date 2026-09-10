import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { WHOOP } from '../src/config.js';
import { buildAuthorizeUrl } from '../src/whoop.js';
import {
  PRIVACY_CONTACT, PRIVACY_POLICY_HTML, handlePrivacyRequest,
} from '../src/privacyServer.js';

function request(path, method = 'GET') {
  const response = { status: null, headers: null, body: null };
  handlePrivacyRequest({ url: path, method }, {
    writeHead(status, headers) { response.status = status; response.headers = headers; },
    end(body) { response.body = body; },
  });
  return response;
}

test('/privacy returns a standalone HTML policy with the required contact', () => {
  const response = request('/privacy');
  assert.equal(response.status, 200);
  assert.match(response.headers['Content-Type'], /^text\/html; charset=utf-8$/);
  assert.match(response.body, /Kelvin Health OS Privacy Policy/);
  assert.match(response.body, new RegExp(PRIVACY_CONTACT.replace('.', '\\.')));
  assert.match(response.body, /application-derived estimates/);
  assert.doesNotMatch(response.body, /<script|https?:\/\/(?!localhost)/i);
});

test('/privacy does not render common credential material', () => {
  for (const forbidden of [
    'WHOOP_CLIENT_SECRET', 'OPENROUTER_API_KEY', 'TELEGRAM_BOT_TOKEN',
    'TURSO_AUTH_TOKEN', ['-----BEGIN', 'PRIVATE KEY-----'].join(' '),
  ]) assert.ok(!PRIVACY_POLICY_HTML.includes(forbidden));
});

test('unrelated routes are not exposed by the privacy service', () => {
  assert.equal(request('/').status, 404);
  assert.equal(request('/privacy', 'POST').status, 404);
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
