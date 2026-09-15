/**
 * 測試用 worker：在**另一條執行緒、另一個 libSQL 連線**上認領同一個
 * (user, resource) 的對帳權。用來證明「認領是資料庫層的原子操作」——
 * 兩條執行緒同時搶，最多一個拿到。
 *
 * 協定：
 *   main → worker  { type: 'go', url, userId, resource, owner, attempts, leaseMs }
 *   worker → main  { type: 'done', ok, wins }
 */

import { parentPort } from 'node:worker_threads';
import { createDb } from '../src/db.js';

parentPort.on('message', async (msg) => {
  let db = null;
  try {
    if (msg?.type !== 'go') return;
    db = createDb({ url: msg.url });
    await db.raw.execute(`PRAGMA busy_timeout = ${Number(msg.busyTimeoutMs ?? 15_000)}`);
    let wins = 0;
    for (let i = 0; i < msg.attempts; i += 1) {
      const ok = await db.claimReconciliation({
        userId: msg.userId, resource: msg.resource, owner: msg.owner, leaseMs: msg.leaseMs,
      });
      if (ok) wins += 1;
    }
    parentPort.postMessage({ type: 'done', ok: true, wins });
  } catch (err) {
    parentPort.postMessage({ type: 'done', ok: false, error: String(err?.code ?? err?.message ?? err) });
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
});
