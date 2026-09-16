/**
 * 測試用子行程：對 canonical 做一次寫入（或刪除），commit 之後**立刻 SIGKILL 自己**。
 * 用來證明「canonical 提交了 → 分析失效也一定在」：兩者是同一個 commit。
 *
 * 用法：node test/p3-crash-worker.js <url> <userId> <op:upsert|delete> <json>
 */
import { createDb } from '../src/db.js';

const [url, userId, op, json] = process.argv.slice(2);
const db = createDb({ url });
const payload = JSON.parse(json);
if (op === 'upsert') {
  await db.upsertSleeps(userId, [payload.record], { timezone: 'Asia/Taipei' });
} else if (op === 'delete') {
  const rec = await db.recordWhoopEvent({
    whoopUserId: payload.whoopUserId, eventType: 'sleep.deleted', resourceType: 'sleep',
    resourceId: payload.resourceId, traceId: `t-${payload.resourceId}`,
  });
  const ev = await db.claimWhoopEvent({ owner: 'crash-worker', leaseMs: 600_000 });
  if (!ev || ev.id !== rec.id) throw new Error('claim failed');
  await db.mutateForWhoopEvent(ev.id, { owner: 'crash-worker' }, () => db.deleteWhoopResource({
    userId, resourceType: 'sleep', resourceId: payload.resourceId, sourceEventId: ev.id,
  }));
}
// commit 已回來。不 close、不 settle、不做任何清理 —— 模擬立刻崩潰。
process.stdout.write('COMMITTED\n');
process.kill(process.pid, 'SIGKILL');
