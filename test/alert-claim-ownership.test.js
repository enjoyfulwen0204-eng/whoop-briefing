/**
 * 警報認領的擁有權與釋放。
 *
 * ## 修掉的缺陷
 *
 * `claimErrorNotify` 會先把認領持久化，**再**送 Telegram。送失敗時認領留著，
 * 於是一次 Telegram 故障就吃掉整個冷卻窗 —— 排程離線警報是 24 小時。
 * 使用者在那 24 小時內完全不會被告知系統掛了，而那正是最需要通知的時候。
 *
 * ## 為什麼不能無條件 DELETE
 *
 *   A 認領 → A 送失敗（慢）
 *   B 在下一輪認領（新的時間戳）→ B 送成功
 *   A 的錯誤處理才跑到，DELETE 掉了 **B** 的冷卻
 *   → 下一輪又送一次，使用者收到重複警報
 *
 * 所以釋放要帶上自己的 `claimedAt` 做比較後刪除：只刪自己那一列。
 * 認領本身仍然是單一語句的原子寫入，沒有回到 SELECT-then-INSERT。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createDb } from '../src/db.js';
import { createTelegram } from '../src/telegram.js';
import { checkPeerScheduler, SCHEDULER_ALERT_TYPE } from '../src/schedulerWatchdog.js';
import { GLOBAL_SCOPE } from '../src/schema.js';
import { HEARTBEAT_COMPONENT } from '../src/guardianPolicy.js';

const T0 = Date.parse('2026-09-12T00:00:00.000Z');
const TYPE = SCHEDULER_ALERT_TYPE;

function virtualClock() {
  const real = Date.now;
  let at = T0;
  Date.now = () => at;
  return { set(h) { at = T0 + h * 3600_000; return new Date(at); }, restore() { Date.now = real; } };
}

async function harness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claim-'));
  const db = createDb({ url: `file:${path.join(dir, 't.db')}` });
  await db.migrate();
  const sends = [];
  let failSend = false;
  const telegram = createTelegram({
    botToken: 'stub', chatId: 'stub', dryRun: false, db, errorScope: GLOBAL_SCOPE,
    fetchImpl: async (_u, o) => {
      if (failSend) throw new Error('telegram down');
      sends.push(JSON.parse(o.body).text);
      return {
        ok: true, status: 200,
        async text() { return JSON.stringify({ ok: true, result: { message_id: sends.length } }); },
      };
    },
  });
  const rows = async () => (await db.raw.execute(
    'SELECT scope, error_type, last_notified_at, hits FROM error_notifications',
  )).rows;
  return { db, telegram, sends, rows, setFail: (v) => { failSend = v; },
    cleanup() { db.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

// ===========================================================================
// 認領 / 釋放的原語
// ===========================================================================

test('★★★ 認領回傳擁有權憑證；同一個窗只有一個呼叫拿得到', async () => {
  const h = await harness();
  const clock = virtualClock();
  try {
    clock.set(0);
    const a = await h.db.claimErrorNotifyOwned(GLOBAL_SCOPE, TYPE, 24);
    assert.equal(a.granted, true);
    assert.ok(a.claimedAt, '★ 要給得出憑證');
    const b = await h.db.claimErrorNotifyOwned(GLOBAL_SCOPE, TYPE, 24);
    assert.equal(b.granted, false);
    assert.equal(b.claimedAt, null);
  } finally { clock.restore(); h.cleanup(); }
});

test('★★★ 帶憑證釋放 → 只刪自己那一列，下一次可以馬上重新認領', async () => {
  const h = await harness();
  const clock = virtualClock();
  try {
    clock.set(0);
    const a = await h.db.claimErrorNotifyOwned(GLOBAL_SCOPE, TYPE, 24);
    assert.equal((await h.rows()).length, 1);
    assert.equal(await h.db.releaseErrorNotify(GLOBAL_SCOPE, TYPE, a.claimedAt), true);
    assert.equal((await h.rows()).length, 0, '★ 自己的認領被還回去了');
    // 同一毫秒就能重新認領（不必等冷卻）
    const b = await h.db.claimErrorNotifyOwned(GLOBAL_SCOPE, TYPE, 24);
    assert.equal(b.granted, true, '★ 釋放之後要能馬上重試');
  } finally { clock.restore(); h.cleanup(); }
});

test('★★★ 舊的釋放**不可以**刪掉新的成功認領（比較後刪除）', async () => {
  const h = await harness();
  const clock = virtualClock();
  try {
    // A 在 h=0 認領
    clock.set(0);
    const a = await h.db.claimErrorNotifyOwned(GLOBAL_SCOPE, TYPE, 24);
    assert.equal(a.granted, true);
    // A 送失敗、釋放
    await h.db.releaseErrorNotify(GLOBAL_SCOPE, TYPE, a.claimedAt);
    // B 在 h=1 認領並送成功
    clock.set(1);
    const b = await h.db.claimErrorNotifyOwned(GLOBAL_SCOPE, TYPE, 24);
    assert.equal(b.granted, true);
    // A 的錯誤處理「遲到」了，又拿舊憑證釋放一次
    const released = await h.db.releaseErrorNotify(GLOBAL_SCOPE, TYPE, a.claimedAt);
    assert.equal(released, false, '★ 舊憑證不該刪到任何東西');
    assert.equal((await h.rows()).length, 1, '★ B 的冷卻必須還在');
    assert.equal(String((await h.rows())[0].last_notified_at), b.claimedAt);
    // 於是 B 的冷卻仍然有效
    clock.set(2);
    assert.equal((await h.db.claimErrorNotifyOwned(GLOBAL_SCOPE, TYPE, 24)).granted, false);
  } finally { clock.restore(); h.cleanup(); }
});

test('★★★ 沒有憑證的釋放是 no-op（不會清掉別人的冷卻）', async () => {
  const h = await harness();
  const clock = virtualClock();
  try {
    clock.set(0);
    await h.db.claimErrorNotifyOwned(GLOBAL_SCOPE, TYPE, 24);
    assert.equal(await h.db.releaseErrorNotify(GLOBAL_SCOPE, TYPE, null), false);
    assert.equal(await h.db.releaseErrorNotify(GLOBAL_SCOPE, TYPE, '2020-01-01T00:00:00.000Z'), false);
    assert.equal((await h.rows()).length, 1, '★ 冷卻沒被動到');
  } finally { clock.restore(); h.cleanup(); }
});

// ===========================================================================
// notifyError 的端到端行為
// ===========================================================================

test('★★★ 送出成功 → 冷卻持久化（下一輪被擋）', async () => {
  const h = await harness();
  const clock = virtualClock();
  try {
    clock.set(0);
    assert.equal(await h.telegram.notifyError(TYPE, 'down', { cooldownHours: 24 }), true);
    assert.equal(h.sends.length, 1);
    assert.equal((await h.rows()).length, 1, '★ 冷卻要留著');
    clock.set(1);
    assert.equal(await h.telegram.notifyError(TYPE, 'down', { cooldownHours: 24 }), false);
    assert.equal(h.sends.length, 1, '★ 24 小時內只送一次');
  } finally { clock.restore(); h.cleanup(); }
});

test('★★★ 送出失敗 → 認領被釋放，下一輪可以馬上重試', async () => {
  const h = await harness();
  const clock = virtualClock();
  try {
    clock.set(0);
    h.setFail(true);
    assert.equal(await h.telegram.notifyError(TYPE, 'down', { cooldownHours: 24 }), false);
    assert.equal(h.sends.length, 0);
    assert.equal((await h.rows()).length, 0, '★ 失敗不可以吃掉 24 小時的冷卻窗');

    // 幾分鐘後 Telegram 恢復 —— 不必等 24 小時
    h.setFail(false);
    clock.set(0.2);
    assert.equal(await h.telegram.notifyError(TYPE, 'down', { cooldownHours: 24 }), true);
    assert.equal(h.sends.length, 1, '★ 立刻就能補送');
    assert.equal((await h.rows()).length, 1);
  } finally { clock.restore(); h.cleanup(); }
});

test('★★★ 四個併發認領仍然只有一個送出（原子性沒有被破壞）', async () => {
  const h = await harness();
  const clock = virtualClock();
  try {
    clock.set(0);
    const results = await Promise.all([1, 2, 3, 4].map(
      () => h.telegram.notifyError(TYPE, 'down', { cooldownHours: 24 }),
    ));
    assert.equal(results.filter(Boolean).length, 1, '★ 恰好一個宣稱送出');
    assert.equal(h.sends.length, 1, '★ 恰好一則');
    assert.equal((await h.rows()).length, 1);
  } finally { clock.restore(); h.cleanup(); }
});

test('★★★ 併發中一個送失敗、一個送成功 → 成功的冷卻不可以被刪掉', async () => {
  const h = await harness();
  const clock = virtualClock();
  try {
    // 第一次：失敗並釋放
    clock.set(0);
    h.setFail(true);
    await h.telegram.notifyError(TYPE, 'down', { cooldownHours: 24 });
    assert.equal((await h.rows()).length, 0);
    // 第二次：成功
    h.setFail(false);
    clock.set(0.1);
    assert.equal(await h.telegram.notifyError(TYPE, 'down', { cooldownHours: 24 }), true);
    const after = await h.rows();
    assert.equal(after.length, 1, '★ 成功的冷卻必須存在');
    // 第三次：仍在冷卻內 → 擋下，而且不可以動到那一列
    clock.set(0.2);
    assert.equal(await h.telegram.notifyError(TYPE, 'down', { cooldownHours: 24 }), false);
    assert.equal((await h.rows()).length, 1);
    assert.equal(h.sends.length, 1);
  } finally { clock.restore(); h.cleanup(); }
});

test('★★★ 重啟不會讓成功的冷卻消失', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claim-r-'));
  const url = `file:${path.join(dir, 't.db')}`;
  const clock = virtualClock();
  const sends = [];
  const mk = async () => {
    const db = createDb({ url });
    await db.migrate();
    const tg = createTelegram({
      botToken: 'stub', chatId: 'stub', dryRun: false, db, errorScope: GLOBAL_SCOPE,
      fetchImpl: async (_u, o) => {
        sends.push(JSON.parse(o.body).text);
        return { ok: true, status: 200, async text() { return JSON.stringify({ ok: true, result: { message_id: 1 } }); } };
      },
    });
    return { db, tg };
  };
  try {
    clock.set(0);
    const a = await mk();
    assert.equal(await a.tg.notifyError(TYPE, 'down', { cooldownHours: 24 }), true);
    a.db.close();

    clock.set(1);
    const b = await mk();
    assert.equal(await b.tg.notifyError(TYPE, 'down', { cooldownHours: 24 }), false,
      '★ 重啟不可以讓冷卻歸零');
    assert.equal(sends.length, 1);
    b.db.close();
  } finally { clock.restore(); fs.rmSync(dir, { recursive: true, force: true }); }
});

// ===========================================================================
// 與排程器監看整合
// ===========================================================================

test('★★★ 排程離線：警報送失敗 → 下一輪備援就能重試（不必等 24 小時）', async () => {
  const h = await harness();
  const clock = virtualClock();
  try {
    const beat = async (c, hour) => h.db.recordHeartbeat(GLOBAL_SCOPE, c, {
      detail: 'x', now: new Date(T0 + hour * 3600_000),
    });
    await beat(HEARTBEAT_COMPONENT.CLOUDFLARE, 0);   // 之後就死掉

    // 第 1 小時：備援跑到，但 Telegram 掛了
    h.setFail(true);
    let now = clock.set(1);
    await beat(HEARTBEAT_COMPONENT.GITHUB, 1);
    const first = await checkPeerScheduler({ db: h.db, source: 'github', systemTelegram: h.telegram, now });
    assert.equal(first.alerted, false);
    assert.equal((await h.rows()).length, 0, '★ 認領已釋放');

    // 第 2 小時：Telegram 恢復 —— 舊行為要等到第 25 小時
    h.setFail(false);
    now = clock.set(2);
    await beat(HEARTBEAT_COMPONENT.GITHUB, 2);
    const second = await checkPeerScheduler({ db: h.db, source: 'github', systemTelegram: h.telegram, now });
    assert.equal(second.alerted, true, '★ 下一輪就要補上');
    assert.equal(h.sends.length, 1);

    // 之後 24 小時內不再重複
    now = clock.set(6);
    await beat(HEARTBEAT_COMPONENT.GITHUB, 6);
    await checkPeerScheduler({ db: h.db, source: 'github', systemTelegram: h.telegram, now });
    assert.equal(h.sends.length, 1, '★ 成功之後冷卻照常生效');
  } finally { clock.restore(); h.cleanup(); }
});

test('★★★ 故障→恢復：恢復通知最多一則，而且送失敗不會變成每 10 分鐘一則', async () => {
  const h = await harness();
  const clock = virtualClock();
  try {
    const beat = async (c, hour) => h.db.recordHeartbeat(GLOBAL_SCOPE, c, {
      detail: 'x', now: new Date(T0 + hour * 3600_000),
    });
    await beat(HEARTBEAT_COMPONENT.CLOUDFLARE, 0);
    let now = clock.set(1);
    await beat(HEARTBEAT_COMPONENT.GITHUB, 1);
    await checkPeerScheduler({ db: h.db, source: 'github', systemTelegram: h.telegram, now });
    assert.equal(h.sends.length, 1, '★ 一則故障通知');

    // 主排程恢復，但恢復通知送失敗
    h.setFail(true);
    now = clock.set(2);
    await beat(HEARTBEAT_COMPONENT.CLOUDFLARE, 2);
    const r1 = await checkPeerScheduler({ db: h.db, source: 'cloudflare', systemTelegram: h.telegram, now });
    assert.equal(r1.recovered, true, '★ 旗標在送出前就清掉了');

    // 之後每 10 分鐘再跑 6 次：不可以變成恢復通知洗版
    h.setFail(false);
    for (const t of [2.2, 2.4, 2.6, 2.8, 3.0, 3.2]) {
      now = clock.set(t);
      await beat(HEARTBEAT_COMPONENT.CLOUDFLARE, t);
      await checkPeerScheduler({ db: h.db, source: 'cloudflare', systemTelegram: h.telegram, now });
    }
    const recoveries = h.sends.filter((s) => s.includes('排程已恢復')).length;
    assert.equal(recoveries, 0, '★ 送失敗的恢復通知不可以無限重試');
    assert.equal(h.sends.length, 1, '★ 總共只有那一則故障通知');
  } finally { clock.restore(); h.cleanup(); }
});

test('★★★ 沒宣告過故障就沒有恢復通知', async () => {
  const h = await harness();
  const clock = virtualClock();
  try {
    for (const t of [0, 0.2, 0.4]) {
      const now = clock.set(t);
      await h.db.recordHeartbeat(GLOBAL_SCOPE, HEARTBEAT_COMPONENT.CLOUDFLARE, {
        detail: 'x', now: new Date(T0 + t * 3600_000),
      });
      await checkPeerScheduler({ db: h.db, source: 'cloudflare', systemTelegram: h.telegram, now });
    }
    assert.equal(h.sends.length, 0);
  } finally { clock.restore(); h.cleanup(); }
});
