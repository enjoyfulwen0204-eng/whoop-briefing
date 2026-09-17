// Local-only CLI network interception. Never falls back to a real provider.
import { createDb } from '../src/db.js';
if (!process.env.TURSO_DATABASE_URL?.startsWith('file:')) throw new Error('local_test_db_required');
globalThis.fetch = async (input) => {
  const url = new URL(input);
  if (url.hostname !== 'api.prod.whoop.com') throw new Error('unexpected_test_network');
  if (url.pathname.endsWith('/measurement/body')) {
    const db = createDb({ url: process.env.TURSO_DATABASE_URL });
    try { await db.transitionUserLifecycle({ userId: process.env.R4_USER, targetStatus: 'ACTIVE' }); }
    finally { db.close(); }
    return new Response('{}');
  }
  return new Response(JSON.stringify({ records: [], next_token: null }));
};
