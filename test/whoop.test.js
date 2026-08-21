/**
 * WHOOP client 行為驗證（用本機假 WHOOP API，不需要真帳號）：
 *  - access token 還有 >5 分鐘就直接重用，不 refresh
 *  - 快過期才 refresh，而且 refresh 成功後「第一件事」是寫回 DB
 *  - DB 寫入失敗 → 整個中止，不會拿新 token 去撈資料（避免 refresh_token 遺失）
 *  - collection 用 next_token 分頁、每頁 limit=25
 *  - 429 會 backoff 後重試
 *  - 401 會 force refresh 一次再重試
 *  - 平行請求時只 refresh 一次
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { createWhoopClient, WhoopAuthError } from '../src/whoop.js';
import { WHOOP } from '../src/config.js';

/** 假的 WHOOP API + token endpoint。 */
async function mockWhoop({ pages = {}, tokenHandler = null, failures = {} } = {}) {
  const calls = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      calls.push({
        method: req.method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        auth: req.headers.authorization,
        body,
      });

      if (url.pathname === '/oauth/oauth2/token') {
        const out = tokenHandler
          ? tokenHandler(new URLSearchParams(body), calls)
          : {
            status: 200,
            json: {
              access_token: 'new-access', refresh_token: 'new-refresh',
              expires_in: 3600, scope: WHOOP.SCOPES,
            },
          };
        res.writeHead(out.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(out.json));
        return;
      }

      const key = url.pathname;
      const fail = failures[key];
      if (fail && fail.remaining > 0) {
        fail.remaining -= 1;
        res.writeHead(fail.status, {
          'Content-Type': 'application/json',
          ...(fail.retryAfter ? { 'retry-after': String(fail.retryAfter) } : {}),
        });
        res.end('{}');
        return;
      }

      const token = url.searchParams.get('nextToken') ?? '';
      const page = (pages[key] ?? {})[token];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(page ?? { records: [], next_token: null }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  return {
    calls,
    apiBase: base,
    tokenUrl: `${base}/oauth/oauth2/token`,
    close: () => new Promise((r) => server.close(r)),
  };
}

function tokenDb({ expiresInMs = 3600_000, failSaves = 0 } = {}) {
  const saves = [];
  let saveFailures = failSaves;
  return {
    saves,
    tokens: {
      accessToken: 'old-access',
      refreshToken: 'old-refresh',
      expiresAt: new Date(Date.now() + expiresInMs),
      scope: WHOOP.SCOPES,
    },
    async getTokens() { return this.tokens; },
    async saveTokens(t) {
      if (saveFailures > 0) {
        saveFailures -= 1;
        throw new Error('模擬 Turso 寫入失敗');
      }
      saves.push(t);
      this.tokens = { ...t, expiresAt: new Date(t.expiresAt) };
    },
  };
}

const NO_BACKOFF = () => 1;

test('access token 還有效（>5 分鐘）→ 直接重用，完全不打 token endpoint', async () => {
  const api = await mockWhoop({
    pages: { '/recovery': { '': { records: [{ id: 1 }], next_token: null } } },
  });
  const db = tokenDb({ expiresInMs: 30 * 60_000 });
  try {
    const whoop = createWhoopClient({
      db, clientId: 'cid', clientSecret: 'sec', apiBase: api.apiBase, tokenUrl: api.tokenUrl,
    });
    const out = await whoop.collect('/recovery');
    assert.equal(out.length, 1);
    assert.equal(db.saves.length, 0, '不該 refresh');
    assert.ok(!api.calls.some((c) => c.path === '/oauth/oauth2/token'));
    assert.equal(api.calls[0].auth, 'Bearer old-access');
  } finally {
    await api.close();
  }
});

test('剩不到 5 分鐘 → refresh，且「先寫回 DB」才去撈資料', async () => {
  const api = await mockWhoop({
    pages: { '/recovery': { '': { records: [{ id: 1 }], next_token: null } } },
  });
  const db = tokenDb({ expiresInMs: 4 * 60_000 });
  const order = [];
  const origSave = db.saveTokens.bind(db);
  db.saveTokens = async (t) => { order.push('save'); return origSave(t); };
  try {
    const whoop = createWhoopClient({
      db, clientId: 'cid', clientSecret: 'sec', apiBase: api.apiBase, tokenUrl: api.tokenUrl,
    });
    const out = await whoop.collect('/recovery');
    order.push('fetch');

    assert.equal(out.length, 1);
    assert.deepEqual(order, ['save', 'fetch'], 'DB 寫入必須在資料處理之前');
    assert.equal(db.saves.length, 1);
    assert.equal(db.saves[0].accessToken, 'new-access');
    assert.equal(db.saves[0].refreshToken, 'new-refresh');

    const tokenCall = api.calls.find((c) => c.path === '/oauth/oauth2/token');
    const form = new URLSearchParams(tokenCall.body);
    assert.equal(form.get('grant_type'), 'refresh_token');
    assert.equal(form.get('refresh_token'), 'old-refresh');
    assert.equal(form.get('scope'), 'offline');

    // 撈資料時用的是新 token
    const dataCall = api.calls.find((c) => c.path === '/recovery');
    assert.equal(dataCall.auth, 'Bearer new-access');
  } finally {
    await api.close();
  }
});

test('DB 寫入一直失敗 → 中止，不會用新 token 去撈資料（避免 refresh_token 遺失）', async () => {
  const api = await mockWhoop({
    pages: { '/recovery': { '': { records: [{ id: 1 }], next_token: null } } },
  });
  const db = tokenDb({ expiresInMs: 60_000, failSaves: 99 });
  try {
    const whoop = createWhoopClient({
      db, clientId: 'cid', clientSecret: 'sec', apiBase: api.apiBase, tokenUrl: api.tokenUrl,
    });
    await assert.rejects(() => whoop.collect('/recovery'), /模擬 Turso 寫入失敗|寫入/);
    assert.ok(!api.calls.some((c) => c.path === '/recovery'), '不該在 token 沒存好時撈資料');
  } finally {
    await api.close();
  }
});

test('平行請求時只 refresh 一次', async () => {
  const api = await mockWhoop({
    pages: {
      '/recovery': { '': { records: [{ id: 1 }], next_token: null } },
      '/cycle': { '': { records: [{ id: 2 }], next_token: null } },
      '/activity/sleep': { '': { records: [{ id: 3 }], next_token: null } },
    },
  });
  const db = tokenDb({ expiresInMs: 30_000 });
  try {
    const whoop = createWhoopClient({
      db, clientId: 'cid', clientSecret: 'sec', apiBase: api.apiBase, tokenUrl: api.tokenUrl,
    });
    await Promise.all([
      whoop.collect('/recovery'),
      whoop.collect('/cycle'),
      whoop.collect('/activity/sleep'),
    ]);
    const refreshes = api.calls.filter((c) => c.path === '/oauth/oauth2/token');
    assert.equal(refreshes.length, 1, `只該 refresh 一次，實際 ${refreshes.length} 次`);
    assert.equal(db.saves.length, 1);
  } finally {
    await api.close();
  }
});

test('collection 用 next_token 分頁，每頁 limit=25', async () => {
  const mkRecords = (n, offset) => Array.from({ length: n }, (_, i) => ({ id: offset + i }));
  const api = await mockWhoop({
    pages: {
      '/activity/sleep': {
        '': { records: mkRecords(25, 0), next_token: 'p2' },
        p2: { records: mkRecords(25, 25), next_token: 'p3' },
        p3: { records: mkRecords(7, 50), next_token: null },
      },
    },
  });
  const db = tokenDb();
  try {
    const whoop = createWhoopClient({
      db, clientId: 'cid', clientSecret: 'sec', apiBase: api.apiBase, tokenUrl: api.tokenUrl,
    });
    const out = await whoop.sleeps(new Date('2026-07-01T00:00:00Z'), new Date('2026-08-21T00:00:00Z'));
    assert.equal(out.length, 57);
    const dataCalls = api.calls.filter((c) => c.path === '/activity/sleep');
    assert.equal(dataCalls.length, 3);
    assert.equal(dataCalls[0].query.limit, '25');
    assert.equal(dataCalls[0].query.nextToken, undefined);
    assert.equal(dataCalls[1].query.nextToken, 'p2');
    assert.equal(dataCalls[2].query.nextToken, 'p3');
    assert.ok(dataCalls[0].query.start.endsWith('Z'), 'start 要是 ISO UTC');
  } finally {
    await api.close();
  }
});

test('429 會 backoff 後重試成功', async () => {
  const api = await mockWhoop({
    pages: { '/recovery': { '': { records: [{ id: 1 }], next_token: null } } },
    failures: { '/recovery': { status: 429, remaining: 2, retryAfter: 0 } },
  });
  const db = tokenDb();
  try {
    const whoop = createWhoopClient({
      db, clientId: 'cid', clientSecret: 'sec',
      apiBase: api.apiBase, tokenUrl: api.tokenUrl, backoffFor: NO_BACKOFF,
    });
    const out = await whoop.collect('/recovery');
    assert.equal(out.length, 1);
    assert.equal(api.calls.filter((c) => c.path === '/recovery').length, 3);
  } finally {
    await api.close();
  }
});

test('429 一直不停 → 拋錯（讓上層記錄並通知）', async () => {
  const api = await mockWhoop({
    failures: { '/recovery': { status: 429, remaining: 99, retryAfter: 0 } },
  });
  const db = tokenDb();
  try {
    const whoop = createWhoopClient({
      db, clientId: 'cid', clientSecret: 'sec',
      apiBase: api.apiBase, tokenUrl: api.tokenUrl, backoffFor: NO_BACKOFF,
    });
    await assert.rejects(() => whoop.collect('/recovery'), /429/);
  } finally {
    await api.close();
  }
});

test('401 → 強制 refresh 一次再重試；再 401 就明確要求重新授權', async () => {
  const api = await mockWhoop({
    failures: { '/recovery': { status: 401, remaining: 99 } },
  });
  const db = tokenDb();
  try {
    const whoop = createWhoopClient({
      db, clientId: 'cid', clientSecret: 'sec',
      apiBase: api.apiBase, tokenUrl: api.tokenUrl, backoffFor: NO_BACKOFF,
    });
    await assert.rejects(
      () => whoop.collect('/recovery'),
      (err) => err instanceof WhoopAuthError && /重新授權/.test(err.message),
    );
    assert.equal(api.calls.filter((c) => c.path === '/oauth/oauth2/token').length, 1);
  } finally {
    await api.close();
  }
});

test('Turso 沒有 token → 明確叫你先跑授權腳本', async () => {
  const whoop = createWhoopClient({
    db: { getTokens: async () => null }, clientId: 'cid', clientSecret: 'sec',
  });
  await assert.rejects(() => whoop.getAccessToken(), /npm run authorize/);
});
