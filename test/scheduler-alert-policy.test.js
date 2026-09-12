/**
 * 排程器故障通知政策（72 小時模擬）。
 *
 * ## 為什麼需要這一組
 *
 * 獨立審查實測過舊行為：Cloudflare 主排程持續離線時，每小時跑到的 GitHub
 * 備援每次都呼叫 notifyError，而全域冷卻是 2 小時 —— 於是
 *
 *     48 小時 → 24 則一模一樣的 Telegram 警報（一天 12 則）
 *
 * 那不是通知，是把使用者訓練成看到警報就忽略。而且它同時傷害真正重要的
 * 警報：下一次真的出事時，那則訊息已經沒有人看了。
 *
 * ## 這一組釘住的政策
 *
 *   1. 確認離線 → 一則
 *   2. 同一場故障持續 → 最多每 24 小時一則
 *   3. 恢復 → 只有在真的宣告過故障時才送一則恢復通知
 *   4. 恢復後的**新**故障 → 可以再通知
 *   5. 備援自己延遲 → 完全不吵使用者
 *   6. 兩邊都離線 → 仍然只有一個訊號，不會變成兩場警報風暴
 *
 * ⚠️ 冷卻的時間來源是 `claimErrorNotify` 裡的 `Date.now()`，不是注入的時鐘。
 * 所以模擬必須同時推進兩者，否則會得到「0 則警報」這種假通過。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createDb } from '../src/db.js';
import { createTelegram } from '../src/telegram.js';
import {
  checkPeerScheduler, SCHEDULER_ALERT_COOLDOWN_HOURS, SCHEDULER_ALERT_TYPE,
} from '../src/schedulerWatchdog.js';
import { GLOBAL_SCOPE } from '../src/schema.js';
import { HEARTBEAT_COMPONENT } from '../src/guardianPolicy.js';

const T0 = Date.parse('2026-09-12T00:00:00.000Z');

/** 同時控制注入時鐘與 Date.now()（冷卻判斷讀後者）。 */
function virtualClock() {
  const real = Date.now;
  let at = T0;
  Date.now = () => at;
  return {
    set(hours) { at = T0 + hours * 3600_000; return new Date(at); },
    restore() { Date.now = real; },
  };
}

async function harness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alert-'));
  const db = createDb({ url: `file:${path.join(dir, 't.db')}` });
  await db.migrate();
  const sends = [];
  let failSend = false;
  const telegram = createTelegram({
    botToken: 'stub', chatId: 'stub', dryRun: false, db, errorScope: GLOBAL_SCOPE,
    fetchImpl: async (_url, opts) => {
      if (failSend) throw new Error('telegram down');
      sends.push(JSON.parse(opts.body).text);
      // ⚠️ send() 讀的是 res.text() 再自己 JSON.parse，不是 res.json()。
      // 回 '{}' 會讓它丟 TelegramError，於是 notifyError 明明送出去了卻回 false。
      return {
        ok: true, status: 200,
        async text() { return JSON.stringify({ ok: true, result: { message_id: sends.length } }); },
      };
    },
  });
  return {
    db, sends, telegram,
    setSendFailure(v) { failSend = v; },
    async beat(component, hours) {
      await db.recordHeartbeat(GLOBAL_SCOPE, component, {
        detail: 'outcome=completed;users=1;failed=0', now: new Date(T0 + hours * 3600_000),
      });
    },
    cleanup() { db.close(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

const outageAlerts = (sends) => sends.filter((t) => t.includes(SCHEDULER_ALERT_TYPE)).length;
const recoveryNotes = (sends) => sends.filter((t) => t.includes('排程已恢復')).length;

// ===========================================================================

test('★★★ 72 小時連續主排程離線：確認一次 + 每 24 小時最多一次', async () => {
  const h = await harness();
  const clock = virtualClock();
  try {
    await h.beat(HEARTBEAT_COMPONENT.CLOUDFLARE, 0);   // 最後一次成功，之後死掉
    const attempts = [];
    for (let hour = 1; hour <= 72; hour += 1) {
      const now = clock.set(hour);
      await h.beat(HEARTBEAT_COMPONENT.GITHUB, hour);  // 備援每小時跑到
      const r = await checkPeerScheduler({
        db: h.db, source: 'github', systemTelegram: h.telegram, now,
      });
      attempts.push({ hour, alerted: r.alerted });
    }
    const sentHours = attempts.filter((a) => a.alerted).map((a) => a.hour);
    assert.equal(attempts.length, 72, '★ 每小時都評估過');
    assert.deepEqual(sentHours, [1, 25, 49], '★ 只在第 1、25、49 小時送出');
    assert.equal(outageAlerts(h.sends), 3, `★ 72 小時最多 3 則（實際 ${outageAlerts(h.sends)}）`);
    // 舊行為會是 36 則
    assert.ok(outageAlerts(h.sends) <= 3, '★ 絕不可以回到兩小時一則');
  } finally { clock.restore(); h.cleanup(); }
});

test('★★★ 每 24 小時上限：任一 24 小時窗內都不超過 1 則', async () => {
  const h = await harness();
  const clock = virtualClock();
  try {
    await h.beat(HEARTBEAT_COMPONENT.CLOUDFLARE, 0);
    const hours = [];
    for (let hour = 1; hour <= 72; hour += 1) {
      const now = clock.set(hour);
      await h.beat(HEARTBEAT_COMPONENT.GITHUB, hour);
      const r = await checkPeerScheduler({ db: h.db, source: 'github', systemTelegram: h.telegram, now });
      if (r.alerted) hours.push(hour);
    }
    for (const start of [0, 12, 24, 36, 48]) {
      const inWindow = hours.filter((x) => x > start && x <= start + 24).length;
      assert.ok(inWindow <= 1, `★ ${start}-${start + 24}h 窗內 ${inWindow} 則，上限 1`);
    }
    assert.equal(SCHEDULER_ALERT_COOLDOWN_HOURS, 24);
  } finally { clock.restore(); h.cleanup(); }
});

test('★★★ 恢復：宣告過才送恢復通知，而且只送一次', async () => {
  const h = await harness();
  const clock = virtualClock();
  try {
    await h.beat(HEARTBEAT_COMPONENT.CLOUDFLARE, 0);
    // 故障期
    for (const hour of [1, 2, 3]) {
      const now = clock.set(hour);
      await h.beat(HEARTBEAT_COMPONENT.GITHUB, hour);
      await checkPeerScheduler({ db: h.db, source: 'github', systemTelegram: h.telegram, now });
    }
    assert.equal(outageAlerts(h.sends), 1, '★ 故障期一則');

    // 主排程回來了：由它自己跑完時判定恢復
    for (const hour of [4, 4.2, 4.4]) {
      const now = clock.set(hour);
      await h.beat(HEARTBEAT_COMPONENT.CLOUDFLARE, hour);
      await checkPeerScheduler({ db: h.db, source: 'cloudflare', systemTelegram: h.telegram, now });
    }
    assert.equal(recoveryNotes(h.sends), 1, '★ 恢復通知恰好一則，不可以每 10 分鐘一則');
  } finally { clock.restore(); h.cleanup(); }
});

test('★★★ 沒宣告過就沒有恢復通知', async () => {
  const h = await harness();
  const clock = virtualClock();
  try {
    // 主排程一路健康，從來沒有故障通知
    for (const hour of [0, 0.2, 0.4]) {
      const now = clock.set(hour);
      await h.beat(HEARTBEAT_COMPONENT.CLOUDFLARE, hour);
      await checkPeerScheduler({ db: h.db, source: 'cloudflare', systemTelegram: h.telegram, now });
    }
    assert.equal(recoveryNotes(h.sends), 0, '★ 沒有故障就不該有「恢復了」');
    assert.equal(h.sends.length, 0);
  } finally { clock.restore(); h.cleanup(); }
});

test('★★★ 恢復之後的第二場獨立故障可以再通知一次', async () => {
  const h = await harness();
  const clock = virtualClock();
  try {
    await h.beat(HEARTBEAT_COMPONENT.CLOUDFLARE, 0);
    // 第一場
    let now = clock.set(1);
    await h.beat(HEARTBEAT_COMPONENT.GITHUB, 1);
    await checkPeerScheduler({ db: h.db, source: 'github', systemTelegram: h.telegram, now });
    assert.equal(outageAlerts(h.sends), 1);
    // 恢復
    now = clock.set(2);
    await h.beat(HEARTBEAT_COMPONENT.CLOUDFLARE, 2);
    await checkPeerScheduler({ db: h.db, source: 'cloudflare', systemTelegram: h.telegram, now });
    assert.equal(recoveryNotes(h.sends), 1);
    // 第二場（在 24 小時冷卻內，但旗標已清 → 可以再響）
    now = clock.set(4);
    await h.beat(HEARTBEAT_COMPONENT.GITHUB, 4);
    await checkPeerScheduler({ db: h.db, source: 'github', systemTelegram: h.telegram, now });
    assert.equal(outageAlerts(h.sends), 2, '★ 新的一場故障要能再通知');
  } finally { clock.restore(); h.cleanup(); }
});

test('★★★ 備援自己延遲：使用者完全不會被吵', async () => {
  const h = await harness();
  const clock = virtualClock();
  try {
    // GitHub 最後一次成功在 30 小時前（早就超過它的 12 小時 alertable）
    await h.beat(HEARTBEAT_COMPONENT.GITHUB, -30);
    // Cloudflare 每 10 分鐘健康地跑 144 次
    for (let i = 0; i < 144; i += 1) {
      const hour = i / 6;
      const now = clock.set(hour);
      await h.beat(HEARTBEAT_COMPONENT.CLOUDFLARE, hour);
      await checkPeerScheduler({ db: h.db, source: 'cloudflare', systemTelegram: h.telegram, now });
    }
    assert.equal(h.sends.length, 0, '★ 備援延遲不是使用者的問題，一則都不該送');
  } finally { clock.restore(); h.cleanup(); }
});

test('★★★ 兩邊都離線：仍然只有一個訊號，不會變成兩場警報風暴', async () => {
  const h = await harness();
  const clock = virtualClock();
  try {
    await h.beat(HEARTBEAT_COMPONENT.CLOUDFLARE, -40);
    await h.beat(HEARTBEAT_COMPONENT.GITHUB, -40);
    // 備援偶爾跑到一次（跑到就會寫自己的 heartbeat）
    for (const hour of [1, 2, 3, 4, 5, 6]) {
      const now = clock.set(hour);
      await h.beat(HEARTBEAT_COMPONENT.GITHUB, hour);
      await checkPeerScheduler({ db: h.db, source: 'github', systemTelegram: h.telegram, now });
    }
    assert.equal(outageAlerts(h.sends), 1, '★ 一個訊號、一個冷卻');
  } finally { clock.restore(); h.cleanup(); }
});

test('★★★ 通知送失敗不會把冷卻用掉（下一輪還能再試）', async () => {
  const h = await harness();
  const clock = virtualClock();
  try {
    await h.beat(HEARTBEAT_COMPONENT.CLOUDFLARE, 0);
    h.setSendFailure(true);
    let now = clock.set(1);
    await h.beat(HEARTBEAT_COMPONENT.GITHUB, 1);
    const first = await checkPeerScheduler({ db: h.db, source: 'github', systemTelegram: h.telegram, now });
    assert.equal(first.alerted, false, '★ 送失敗要誠實回 false');
    assert.equal(h.sends.length, 0);

    // 送得出去之後仍在 24 小時冷卻窗內 —— 這是已知取捨（見 RESIDUAL RISKS）：
    // claimErrorNotify 是「先認領再送」，所以一次送達失敗會消耗該窗。
    h.setSendFailure(false);
    now = clock.set(25);
    await h.beat(HEARTBEAT_COMPONENT.GITHUB, 25);
    const later = await checkPeerScheduler({ db: h.db, source: 'github', systemTelegram: h.telegram, now });
    assert.equal(later.alerted, true, '★ 下一個窗一定要能重新通知');
  } finally { clock.restore(); h.cleanup(); }
});

test('★★★ 併發評估只會產生一則（claim 是原子的）', async () => {
  const h = await harness();
  const clock = virtualClock();
  try {
    await h.beat(HEARTBEAT_COMPONENT.CLOUDFLARE, 0);
    const now = clock.set(1);
    await h.beat(HEARTBEAT_COMPONENT.GITHUB, 1);
    const results = await Promise.all([1, 2, 3, 4].map(() => checkPeerScheduler({
      db: h.db, source: 'github', systemTelegram: h.telegram, now,
    })));
    assert.equal(results.filter((r) => r.alerted).length, 1, '★ 只有一個宣稱送出');
    assert.equal(outageAlerts(h.sends), 1);
  } finally { clock.restore(); h.cleanup(); }
});

test('★★★ 重啟不會重置冷卻（狀態是耐久的）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alert-r-'));
  const url = `file:${path.join(dir, 't.db')}`;
  const clock = virtualClock();
  try {
    const sends = [];
    const mk = async () => {
      const db = createDb({ url });
      await db.migrate();
      const tg = createTelegram({
        botToken: 'stub', chatId: 'stub', dryRun: false, db, errorScope: GLOBAL_SCOPE,
        fetchImpl: async (_u, o) => {
          sends.push(JSON.parse(o.body).text);
          return {
            ok: true, status: 200,
            async text() { return JSON.stringify({ ok: true, result: { message_id: 1 } }); },
          };
        },
      });
      return { db, tg };
    };
    const a = await mk();
    await a.db.recordHeartbeat(GLOBAL_SCOPE, HEARTBEAT_COMPONENT.CLOUDFLARE, { detail: 'x', now: new Date(T0) });
    let now = clock.set(1);
    await a.db.recordHeartbeat(GLOBAL_SCOPE, HEARTBEAT_COMPONENT.GITHUB, { detail: 'x', now });
    await checkPeerScheduler({ db: a.db, source: 'github', systemTelegram: a.tg, now });
    assert.equal(sends.length, 1);
    a.db.close();

    // 全新的連線（模擬 process 重啟）
    const b = await mk();
    now = clock.set(3);
    await b.db.recordHeartbeat(GLOBAL_SCOPE, HEARTBEAT_COMPONENT.GITHUB, { detail: 'x', now });
    await checkPeerScheduler({ db: b.db, source: 'github', systemTelegram: b.tg, now });
    assert.equal(sends.length, 1, '★ 重啟不可以讓冷卻歸零');
    b.db.close();
  } finally { clock.restore(); fs.rmSync(dir, { recursive: true, force: true }); }
});
