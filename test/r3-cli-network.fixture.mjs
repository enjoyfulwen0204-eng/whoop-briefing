// Imported only by local CLI regression subprocesses. No network fallback.
import fs from 'node:fs';
import { createDb } from '../src/db.js';

if (!process.env.TURSO_DATABASE_URL?.startsWith('file:')) throw new Error('local_test_db_required');
globalThis.fetch = async (input) => {
  const url = new URL(input);
  if (url.hostname !== 'api.prod.whoop.com') throw new Error('unexpected_test_network');
  const token = url.pathname.endsWith('/oauth/oauth2/token');
  fs.appendFileSync(process.env.R3_REQUEST_LOG, `${token ? 'refresh' : 'resource'}\n`);
  if (token && process.env.R3_TRANSITION_USER) {
    const db = createDb({ url: process.env.TURSO_DATABASE_URL });
    try {
      await db.transitionUserLifecycle({ userId: process.env.R3_TRANSITION_USER, targetStatus: 'DISABLED' });
      await db.transitionUserLifecycle({ userId: process.env.R3_TRANSITION_USER, targetStatus: 'ACTIVE' });
    } finally { db.close(); }
  }
  return new Response(JSON.stringify(token
    ? { access_token: 'cli-test-refreshed', refresh_token: 'cli-test-refresh', expires_in: 3600 }
    : url.pathname.endsWith('/measurement/body') ? {} : { records: [], next_token: null }), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
};
