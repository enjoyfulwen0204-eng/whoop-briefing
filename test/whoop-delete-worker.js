/**
 * 測試用 worker：在**另一條執行緒、另一個 libSQL 連線**上執行 webhook DELETE。
 *
 * 為什麼一定要另一條執行緒：本機 libSQL 的原生綁定是同步的。同一個 process
 * 裡第二個連線等待寫鎖時會把整個事件迴圈卡住，於是持有鎖的那一方永遠沒有
 * 機會 commit —— 那測到的是死結，不是序列化。真正的併發需要兩條執行緒。
 *
 * 協定（parentPort）：
 *   main → worker  { type: 'prepare', url, userId, whoopUserId, resourceType, resourceId, traceId }
 *   worker → main  { type: 'ready' }           事件已收下並認領（寫入已完成）
 *   main → worker  { type: 'mutate' }
 *   worker → main  { type: 'starting' }        BEGIN IMMEDIATE 即將發出（可能阻塞）
 *   worker → main  { type: 'done', ok, error, committedAt }
 */

import { parentPort } from 'node:worker_threads';
import { createDb } from './localDb.js';

let db = null;
let ev = null;
let params = null;

parentPort.on('message', async (msg) => {
  try {
    if (msg?.type === 'prepare') {
      // 第一階段：收下並認領事件。這兩步是**寫入**，必須在主執行緒的 A 取得
      // 寫鎖**之前**完成，否則 worker 會在這裡就被擋住、永遠送不出 'ready'。
      params = msg;
      db = createDb({ url: msg.url });
      // 像伺服器一樣**等**寫鎖，而不是立刻 BUSY。
      await db.raw.execute(`PRAGMA busy_timeout = ${Number(msg.busyTimeoutMs ?? 15_000)}`);
      const rec = await db.recordWhoopEvent({
        whoopUserId: msg.whoopUserId, eventType: `${msg.resourceType}.deleted`,
        resourceType: msg.resourceType, resourceId: msg.resourceId, traceId: msg.traceId,
      });
      ev = await db.claimWhoopEvent({ owner: 'worker-B', leaseMs: 600_000 });
      if (!ev || ev.id !== rec.id) throw new Error('worker could not claim its own event');
      parentPort.postMessage({ type: 'ready' });
      return;
    }
    if (msg?.type === 'mutate') {
      // 第二階段：真正的 DELETE 變更交易。BEGIN IMMEDIATE 會在這條執行緒上等，
      // 不會卡住主執行緒。
      parentPort.postMessage({ type: 'starting' });
      await db.mutateForWhoopEvent(ev.id, { owner: 'worker-B' }, () => db.deleteWhoopResource({
        userId: params.userId, resourceType: params.resourceType, resourceId: params.resourceId,
        sourceEventId: ev.id,
      }));
      await db.settleWhoopEvent(ev.id, { owner: 'worker-B', state: 'PROCESSED', userId: params.userId });
      parentPort.postMessage({ type: 'done', ok: true, committedAt: Date.now() });
      try { db.close(); } catch { /* ignore */ }
    }
  } catch (err) {
    parentPort.postMessage({ type: 'done', ok: false, error: String(err?.code ?? err?.message ?? err) });
    try { db?.close(); } catch { /* ignore */ }
  }
});
