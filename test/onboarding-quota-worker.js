/**
 * 測試用 worker：在**另一條執行緒、另一個 libSQL 連線**上狂發 OAuth state，
 * 用來證明「同時最多 N 條有效連結」這個限制是資料庫層的原子條件
 * （單一條件式 INSERT），不是應用層的讀-改-寫。
 *
 * 協定：
 *   main → worker  { type: 'go', url, userId, attempts, limit, ttlMs, nowMs }
 *   worker → main  { type: 'done', ok, issued }
 */

import { parentPort } from 'node:worker_threads';
import { createDb } from '../src/db.js';

parentPort.on('message', async (msg) => {
  let db = null;
  try {
    if (msg?.type !== 'go') return;
    db = createDb({ url: msg.url });
    await db.raw.execute(`PRAGMA busy_timeout = ${Number(msg.busyTimeoutMs ?? 15_000)}`);
    const now = new Date(msg.nowMs);
    let issued = 0;
    for (let i = 0; i < msg.attempts; i += 1) {
      const r = await db.createOAuthState(msg.userId, {
        ttlMs: msg.ttlMs, now, maxOutstanding: msg.limit,
      });
      if (r.ok) issued += 1;
    }
    parentPort.postMessage({ type: 'done', ok: true, issued });
  } catch (err) {
    parentPort.postMessage({ type: 'done', ok: false, error: String(err?.code ?? err?.message ?? err) });
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
});
