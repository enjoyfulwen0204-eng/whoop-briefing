/**
 * V1.1 final audit — H-01 / H-02 的對抗性回歸。
 *
 * 這一支測的是**同一個**正確性問題的兩半：
 *
 *   H-01  Telegram 收下了訊息，但本地證明不了 → 舊版把發送權還回去
 *         → 下一輪重新 claim → 使用者收到第二份晨報
 *
 *   H-02  報告生成（抓歷史 + 問模型）比租約長 → 租約過期 → B 接手並送出
 *         → A 的 JavaScript 恢復執行 → A 也送出
 *
 * 兩者的共同判準只有一個數字：**外部真正被接受的次數**。
 * 所以每一題都直接數 telegram.send 被呼叫了幾次，不看任何中間狀態。
 *
 * 全部用記憶體替身與暫時 DB，絕不碰正式環境。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runDaily } from '../src/daily.js';
import { runWeekly } from '../src/weekly.js';
import { staticDataSource } from '../src/dataSource.js';
import { localDate, localWeekday } from '../src/time.js';
import { createDb } from '../src/db.js';
import { REPORT_DELIVERY_STATE } from '../src/schema.js';
import { SEND_OUTCOME } from '../src/sendOutcome.js';
import { TelegramError } from '../src/telegram.js';
import { REPORT_CLAIM } from '../src/config.js';
import { makeDataset } from './fixtures.js';
import { fakeDb, fakeCoach } from './fakes.js';

const TZ = 'Asia/Taipei';
const U = 'u-delivery';

function tempDbFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v11-deliv-'));
  return {
    url: `file:${path.join(dir, 't.db')}`,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

function mondayMorning() {
  let d = new Date('2026-08-24T00:00:00Z');
  while (localWeekday(localDate(d, TZ)) !== 1) d = new Date(d.getTime() + 86_400_000);
  return d;
}

/**
 * 一個會數「Telegram 真的收下幾次」的替身。
 *
 * `mode` 決定這一次送出長什麼樣：
 *   'ok'           正常成功
 *   'ambiguous'    ★ Telegram **收下了**，但本地拿不到證明（body 讀到一半斷線）
 *   'definite'     Telegram 親口拒收（HTTP 500）——確定沒送出
 */
function countingTelegram({ mode = 'ok' } = {}) {
  const tg = {
    /** Telegram 端**實際接受**的訊息。這是唯一重要的數字。 */
    accepted: [],
    /** 本地認為成功的次數（可能比 accepted 少 —— 那正是模糊的定義）。 */
    confirmed: 0,
    mode,
    notifies: [],
    async send(text) {
      if (tg.mode === 'definite') {
        // 連 Telegram 都沒收下 —— accepted 不增加。
        throw new TelegramError('Telegram 500', {
          status: 500,
          sendOutcome: SEND_OUTCOME.DEFINITE_FAILURE,
          sendStage: 'telegram_rejected',
        });
      }
      // ★ 關鍵：訊息**已經**被 Telegram 接受了，使用者已經看得到。
      tg.accepted.push(text);
      if (tg.mode === 'ambiguous') {
        throw new TelegramError('socket hang up while reading body', {
          status: 200,
          sendOutcome: SEND_OUTCOME.AMBIGUOUS,
          sendStage: 'body_read',
        });
      }
      tg.confirmed += 1;
      return { messageId: tg.accepted.length };
    },
    async notifyError(type, msg) { tg.notifies.push({ type, msg }); return true; },
  };
  return tg;
}

const dailyCtx = (db, telegram, ds, now = ds.now) => ({
  db, userId: U, telegram, coach: fakeCoach(), source: staticDataSource(ds), timezone: TZ, now,
});

// ===========================================================================
// H-01 —— 模糊送出絕不重送
// ===========================================================================

test('★★★ H-01/1: daily — Telegram 收下但回應不明 → 排程重跑，外部只收到一次', async () => {
  const ds = makeDataset({ days: 45 });
  const db = fakeDb();
  const tg = countingTelegram({ mode: 'ambiguous' });

  const first = await runDaily(dailyCtx(db, tg, ds));
  assert.equal(first.status, 'delivery_ambiguous', '★ 必須是模糊，不是失敗');
  assert.equal(first.retryable, false, '★ 模糊是終局');
  assert.equal(tg.accepted.length, 1, 'Telegram 確實收下了一次');

  // 排程每 10 分鐘跑一次。跑很多輪都不可以再送。
  tg.mode = 'ok';   // 就算 Telegram 完全恢復正常也一樣
  for (let i = 0; i < 5; i += 1) {
    const again = await runDaily(dailyCtx(db, tg, ds));
    assert.equal(again.status, 'delivery_ambiguous', `第 ${i + 2} 輪仍然是終局`);
  }

  assert.equal(tg.accepted.length, 1, '★★★ 外部接受次數必須維持 1');
});

test('★★★ H-01/2: weekly — 同樣的模糊送出，外部只收到一次', async () => {
  const now = mondayMorning();
  const ds = makeDataset({ days: 45, now });
  const db = fakeDb();
  const tg = countingTelegram({ mode: 'ambiguous' });
  const ctx = {
    db, userId: U, telegram: tg, coach: fakeCoach(), source: staticDataSource(ds), timezone: TZ, now,
  };

  const first = await runWeekly(ctx);
  assert.equal(first.status, 'delivery_ambiguous');
  assert.equal(tg.accepted.length, 1);

  tg.mode = 'ok';
  for (let i = 0; i < 5; i += 1) {
    const again = await runWeekly({ ...ctx, telegram: tg });
    assert.equal(again.status, 'delivery_ambiguous');
  }
  assert.equal(tg.accepted.length, 1, '★★★ 週回顧也只可以被接受一次');
});

test('★★★ H-01/3: 明確失敗（Telegram 親口拒收）仍然可以安全重送', async () => {
  // 這一題是上面那兩題的對照組：fail-closed **不可以**變成 fail-always。
  // 證明得了沒送出去的時候，下一輪必須補上。
  const ds = makeDataset({ days: 45 });
  const db = fakeDb();
  const tg = countingTelegram({ mode: 'definite' });

  const first = await runDaily(dailyCtx(db, tg, ds));
  assert.equal(first.status, 'telegram_failed');
  assert.equal(tg.accepted.length, 0, 'Telegram 根本沒收到');

  tg.mode = 'ok';
  const retry = await runDaily(dailyCtx(db, tg, ds));
  assert.equal(retry.status, 'sent', '★ 確定失敗必須可以重試');
  assert.equal(tg.accepted.length, 1);
  assert.equal(tg.confirmed, 1);
});

test('★★★ H-01/4: 授權發生在打網路之前（死在送出中也不會重送）', async () => {
  // 模擬 process 在 telegram.send 當下就消失：狀態必須已經是終局。
  const { url, cleanup } = tempDbFile();
  const db = createDb({ url });
  try {
    await db.migrate();
    await db.createUser({ id: U, displayName: 'D' });
    const key = { userId: U, reportType: 'daily', localDateKey: '2026-09-12' };

    const claim = await db.claimReport({ ...key, ttlMs: REPORT_CLAIM.TTL_MS });
    assert.equal(claim.granted, true);
    assert.equal((await db.getClaim(U, 'daily', '2026-09-12')).deliveryState,
      REPORT_DELIVERY_STATE.CLAIMED);

    // 授權（= 打網路前的最後一步）
    assert.equal(await db.authorizeReportDelivery({ ...key, owner: claim.owner }), true);
    assert.equal((await db.getClaim(U, 'daily', '2026-09-12')).deliveryState,
      REPORT_DELIVERY_STATE.DELIVERY_STARTED);

    // ★ process 在這裡死掉。重開機之後：
    const after = await db.claimReport({
      ...key, ttlMs: REPORT_CLAIM.TTL_MS,
      now: new Date(Date.now() + 365 * 86_400_000),   // 租約早就過期
    });
    assert.equal(after.granted, false, '★ 租約過期也不可以被重新授予');
    assert.equal(after.ambiguous, true, '★ 要能告訴呼叫端這是「可能已送出」');
    assert.equal(after.alreadySent, false);
  } finally { db.close(); cleanup(); }
});

// ===========================================================================
// H-02 —— 租約過期的舊 owner 不可以送
// ===========================================================================

test('★★★ H-02/1: A 過期 → B 接手並送出 → A 恢復執行 → 外部只收到一次', async () => {
  const ds = makeDataset({ days: 45 });
  const db = fakeDb();
  const tg = countingTelegram();

  // A 取得發送權，然後「卡住」。
  const key = { userId: U, reportType: 'daily', localDateKey: localDate(ds.now, TZ) };
  const t0 = new Date(ds.now);
  const a = await db.claimReport({ ...key, ttlMs: 60_000, now: t0 });
  assert.equal(a.granted, true);

  // 租約過期之後 B 接手。
  const later = new Date(t0.getTime() + 61_000);
  const b = await db.claimReport({ ...key, ttlMs: 60_000, now: later });
  assert.equal(b.granted, true, 'B 必須能接手（A 還沒有任何外部副作用）');

  // B 走完完整的送出流程。
  assert.equal(await db.authorizeReportDelivery({ ...key, owner: b.owner, now: later }), true);
  await tg.send('B 送出的晨報');
  assert.equal(await db.markClaimSent({
    ...key, owner: b.owner, messageId: 1, now: later,
  }), true);
  assert.equal(tg.accepted.length, 1);

  // ★ A 的 JavaScript 現在恢復執行。它手上的 owner 已經沒有任何權力。
  assert.equal(
    await db.authorizeReportDelivery({ ...key, owner: a.owner, now: later }), false,
    '★ 失去所有權的 owner 不可以取得送出授權',
  );
  assert.equal(
    await db.markClaimSent({ ...key, owner: a.owner, messageId: 2, now: later }), false,
    '★ 也不可以宣稱送達',
  );
  assert.equal(
    await db.releaseClaim({ ...key, owner: a.owner }), false,
    '★ 更不可以把接手者的狀態刪掉',
  );

  assert.equal(tg.accepted.length, 1, '★★★ 外部接受次數必須維持 1');
});

test('★★★ H-02/2: 端到端 —— A 在生成期間失去所有權，runDaily 必須 fail closed', async () => {
  const ds = makeDataset({ days: 45 });
  const db = fakeDb();
  const tg = countingTelegram();
  const healthDate = localDate(ds.now, TZ);
  const key = { userId: U, reportType: 'daily', localDateKey: healthDate };

  // 讓「抓歷史」這一步變成搶奪所有權的時機：A 還在算的時候，
  // B 就把 claim 接走並且送出去了。
  const base = staticDataSource(ds);
  let hijacked = false;
  const source = {
    poll: () => base.poll(),
    async history() {
      if (!hijacked) {
        hijacked = true;
        // A 的 claim 是用**真實**時鐘建立的（runDaily 沒有注入 now 給 claimReport），
        // 所以「租約過期」也要用同一條時間軸算，否則測到的會是別的東西。
        const afterLease = new Date(Date.now() + REPORT_CLAIM.TTL_MS + 1_000);
        const b = await db.claimReport({ ...key, ttlMs: 600_000, now: afterLease });
        assert.equal(b.granted, true, 'B 必須能接手');
        await db.authorizeReportDelivery({ ...key, owner: b.owner, now: afterLease });
        await tg.send('B 送出的晨報');
        await db.markClaimSent({ ...key, owner: b.owner, messageId: 1, now: afterLease });
      }
      return base.history();
    },
  };

  const res = await runDaily({
    db, userId: U, telegram: tg, coach: fakeCoach(), source, timezone: TZ, now: ds.now,
  });

  assert.equal(res.status, 'claim_lost', '★ A 必須就地失效，而不是繼續送');
  assert.equal(tg.accepted.length, 1, '★★★ 只有 B 送出去的那一次');
});

test('★★★ H-02/3: 續租讓正常的長工作不會失去所有權', async () => {
  const { url, cleanup } = tempDbFile();
  const db = createDb({ url });
  try {
    await db.migrate();
    await db.createUser({ id: U, displayName: 'D' });
    const key = { userId: U, reportType: 'daily', localDateKey: '2026-09-12' };
    const t0 = new Date('2026-09-12T00:00:00.000Z');

    const c = await db.claimReport({ ...key, ttlMs: 60_000, now: t0 });
    // 生成花了 50 秒，續租一次。
    const mid = new Date(t0.getTime() + 50_000);
    assert.equal(await db.renewClaim({ ...key, owner: c.owner, ttlMs: 60_000, now: mid }), true);

    // 原本會過期的時間點，現在仍然握得住。
    const afterOriginalTtl = new Date(t0.getTime() + 70_000);
    assert.equal(
      await db.authorizeReportDelivery({ ...key, owner: c.owner, now: afterOriginalTtl }), true,
      '★ 續租之後仍然是合法 owner',
    );

    // 但續租**不是**安全機制：跨過授權之後就不能再續租了。
    assert.equal(
      await db.renewClaim({ ...key, owner: c.owner, ttlMs: 60_000, now: afterOriginalTtl }), false,
      '★ DELIVERY_STARTED 之後不可以再續租（那是終局狀態）',
    );
  } finally { db.close(); cleanup(); }
});

test('★★★ H-02/4: 兩個排程器同時跑（Cloudflare + GitHub）→ 只有一個送出', async () => {
  const ds = makeDataset({ days: 45 });
  const db = fakeDb();
  const tg = countingTelegram();

  // 兩個完全獨立的 runner，同一個 DB、同一個使用者、同一天。
  const results = await Promise.all([
    runDaily(dailyCtx(db, tg, ds)),
    runDaily(dailyCtx(db, tg, ds)),
  ]);

  const sentCount = results.filter((r) => r.status === 'sent').length;
  assert.equal(sentCount, 1, '★ 只有一個 runner 可以送出');
  assert.equal(tg.accepted.length, 1, '★★★ 外部只可以收到一份');
});

// ===========================================================================
// 重啟／復原
// ===========================================================================

test('★★★ 重啟復原：每一種持久狀態下重跑都不會產生第二次外部送出', async () => {
  const { url, cleanup } = tempDbFile();
  const db = createDb({ url });
  try {
    await db.migrate();
    await db.createUser({ id: U, displayName: 'D' });

    const cases = [
      // [狀態怎麼造出來, 重啟後應該拿得到 claim 嗎, 說明]
      ['CLAIMED', true, '還沒有任何外部副作用 → 可以安全接手'],
      ['DELIVERY_STARTED', false, '可能已經送出 → 終局'],
      ['DELIVERED', false, '確定已經送出 → 終局'],
      ['AMBIGUOUS', false, '可能已經送出 → 終局'],
    ];

    for (const [state, claimable, why] of cases) {
      const date = `2026-09-${state.length}`;   // 每個狀態各自一天
      const key = { userId: U, reportType: 'daily', localDateKey: date };
      const c = await db.claimReport({ ...key, ttlMs: 1_000 });
      if (state !== 'CLAIMED') {
        await db.authorizeReportDelivery({ ...key, owner: c.owner });
      }
      if (state === 'DELIVERED') await db.markClaimSent({ ...key, owner: c.owner, messageId: 1 });
      if (state === 'AMBIGUOUS') await db.markClaimAmbiguous({ ...key, owner: c.owner });

      // 重啟：一個全新的 runner，租約早就過期。
      const restart = await db.claimReport({
        ...key, ttlMs: 60_000, now: new Date(Date.now() + 86_400_000),
      });
      assert.equal(restart.granted, claimable, `★ ${state}：${why}`);
      if (!claimable) {
        assert.ok(restart.alreadySent || restart.ambiguous,
          `★ ${state}：必須明確告訴呼叫端不要再送`);
      }
    }
  } finally { db.close(); cleanup(); }
});

// ===========================================================================
// 多使用者
// ===========================================================================

test('★★★ 多使用者：Alice 的模糊送出完全不影響 Bob 的同一天報告', async () => {
  const { url, cleanup } = tempDbFile();
  const db = createDb({ url });
  try {
    await db.migrate();
    await db.createUser({ id: 'u-alice', displayName: 'Alice' });
    await db.createUser({ id: 'u-bob', displayName: 'Bob' });
    const date = '2026-09-12';
    const kA = { userId: 'u-alice', reportType: 'daily', localDateKey: date };
    const kB = { userId: 'u-bob', reportType: 'daily', localDateKey: date };

    // Alice 走到模糊（終局）。
    const a = await db.claimReport({ ...kA, ttlMs: 60_000 });
    await db.authorizeReportDelivery({ ...kA, owner: a.owner });
    await db.markClaimAmbiguous({ ...kA, owner: a.owner, detail: 'body_read' });

    // Bob 完全不受影響：拿得到發送權，也送得出去。
    const b = await db.claimReport({ ...kB, ttlMs: 60_000 });
    assert.equal(b.granted, true, '★ Alice 的終局狀態不可以阻塞 Bob');
    assert.equal(await db.authorizeReportDelivery({ ...kB, owner: b.owner }), true);
    assert.equal(await db.markClaimSent({ ...kB, owner: b.owner, messageId: 7 }), true);

    // 反向：Bob 的成功也沒有讓 Alice 那筆變成可重送。
    const aRetry = await db.claimReport({
      ...kA, ttlMs: 60_000, now: new Date(Date.now() + 86_400_000),
    });
    assert.equal(aRetry.granted, false);
    assert.equal(aRetry.ambiguous, true);

    assert.equal((await db.getClaim('u-alice', 'daily', date)).deliveryState,
      REPORT_DELIVERY_STATE.AMBIGUOUS);
    assert.equal((await db.getClaim('u-bob', 'daily', date)).deliveryState,
      REPORT_DELIVERY_STATE.DELIVERED);
  } finally { db.close(); cleanup(); }
});
