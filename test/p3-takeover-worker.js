/**
 * 測試用 worker：在**另一條執行緒、另一個 libSQL 連線**上扮演接手的工作者 B。
 *
 *   main → worker  { type: 'takeover', url, userId, cls, owner, leaseMs, nowMs, action, payload }
 *   worker → main  { type: 'done', ok, generation, error }
 *
 * B 認領（A 的租約已過期）→ 透過**真正的圍欄路徑**寫耐久輸出 → 結案 SUCCESS。
 * action: 'light' | 'prediction' | 'healthspan'
 */

import { parentPort } from 'node:worker_threads';
import { createDb } from './localDb.js';
import { fencedAnalyticsDb } from '../src/analyticsWorker.js';
import { LIFECYCLE_UNFENCED } from '../src/accountLifecycle.js';

parentPort.on('message', async (msg) => {
  let db = null;
  try {
    if (msg?.type !== 'takeover') return;
    db = createDb({ url: msg.url });
    await db.raw.execute(`PRAGMA busy_timeout = ${Number(msg.busyTimeoutMs ?? 15_000)}`);
    const now = new Date(msg.nowMs);
    const claim = await db.claimAnalyticsWork({ expectedLifecycleGeneration: LIFECYCLE_UNFENCED, userId: msg.userId, cls: msg.cls, owner: msg.owner, leaseMs: msg.leaseMs, now });
    if (!claim) throw new Error('B could not claim');
    const generation = claim.generation;
    if (msg.action === 'light') {
      // 測試用的確定性時鐘注入：租約是用同一個邏輯時刻建立的。
      await db.saveAnalyticsDailyState(msg.userId, msg.payload.rows, { expectedLifecycleGeneration: LIFECYCLE_UNFENCED, owner: msg.owner, generation, now, clock: () => now });
    } else {
      const { db: fenced } = fencedAnalyticsDb(db, { expectedLifecycleGeneration: LIFECYCLE_UNFENCED, userId: msg.userId, cls: msg.cls, owner: msg.owner, generation, now: () => now });
      if (msg.action === 'prediction') await fenced.savePredictionModel(msg.userId, msg.payload.model, { now });
      else if (msg.action === 'healthspan') await fenced.saveHealthspanSnapshot(msg.userId, msg.payload.snapshot, { now });
      else throw new Error(`unknown action ${msg.action}`);
    }
    await db.settleAnalyticsWork({ expectedLifecycleGeneration: LIFECYCLE_UNFENCED, userId: msg.userId, cls: msg.cls, owner: msg.owner, result: 'SUCCESS', generation, clearRange: msg.cls === 'light', now });
    parentPort.postMessage({ type: 'done', ok: true, generation });
  } catch (err) {
    parentPort.postMessage({ type: 'done', ok: false, error: String(err?.code ?? err?.message ?? err) });
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
});
