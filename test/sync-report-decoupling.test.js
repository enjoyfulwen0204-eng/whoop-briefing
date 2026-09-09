/**
 * 同步與報告排程的解耦（V1.1 Phase 7）。
 *
 * 要證明的事：
 *   「報告不用發」≠「健康資料不需要更新」
 *
 * 同時要證明**沒有**因此放寬任何東西：
 *   - 節流還在（沒有變成每 30 分鐘無條件打 WHOOP）
 *   - 報告去重還在（不會重複發）
 *   - 完全沒事做時仍然是乾淨的 no-op，而且**不碰 WHOOP token**
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createDb } from '../src/db.js';
import { dueForUser, runForUser } from '../src/index.js';
import { isSyncDue, resourceSyncDue } from '../src/sync.js';
import { WHOOP_SYNC } from '../src/config.js';
import { ALICE, BOB, seedAliceAndBob } from './users.js';

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v11-decouple-'));
  const db = createDb({ url: `file:${path.join(dir, 't.db')}` });
  return { db, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

async function withDb(fn) {
  const { db, cleanup } = tempDb();
  try {
    await db.migrate();
    await seedAliceAndBob(db);
    await fn(db);
  } finally {
    db.close();
    cleanup();
  }
}

const NOW = new Date('2026-09-09T00:00:00Z');

const ENV = {
  telegramBotToken: 'T', telegramChatId: 'bootstrap', dryRun: false,
  whoopClientId: 'c', whoopClientSecret: 's',
  openrouterApiKey: 'k', openrouterModel: 'm',
  maxUserConcurrency: 3,
};

function spyDeps(calls, { syncResult = { resources: {} }, failSync = false } = {}) {
  return {
    makeTelegram: () => ({
      async send(text) { calls.push({ k: 'send', text }); return { messageId: 1 }; },
      async notifyError(type) { calls.push({ k: 'error', type }); return true; },
      async sendTyping() { return true; },
    }),
    makeWhoop: () => ({
      getAccessToken: async () => { calls.push({ k: 'whoop.token' }); return 'tok'; },
    }),
    makeCoach: () => ({ daily: async () => null, weekly: async () => null }),
    makeSource: () => ({ poll: async () => ({ sleeps: [], recoveries: [] }) }),
    daily: async () => { calls.push({ k: 'daily' }); return { status: 'not_ready' }; },
    weekly: async () => { calls.push({ k: 'weekly' }); return { status: 'skipped' }; },
    makeSync: () => ({
      syncAll: async () => {
        calls.push({ k: 'sync' });
        if (failSync) throw new Error('sync boom');
        return syncResult;
      },
    }),
    proactive: async () => { calls.push({ k: 'proactive' }); return { triggered: false }; },
    reap: async () => { calls.push({ k: 'reap' }); return { expired: 0, noResponse: 0, skipped: 0 }; },
  };
}

const kinds = (calls) => calls.map((c) => c.k);

/** 讓所有報告都變成「已送出」。 */
async function settleAllReports(db, user, now) {
  const due = await dueForUser({ db, userId: user.id, timezone: user.timezone, now });
  for (const key of [due.today, due.yesterday]) {
    await db.recordRun({
      userId: user.id, reportType: 'daily', localDateKey: key,
      healthDate: key, status: 'SENT', detail: null,
    });
  }
  await db.recordRun({
    userId: user.id, reportType: 'weekly', localDateKey: due.weekKey,
    healthDate: due.weekKey, status: 'SENT', detail: null,
  });
  return due;
}

/** 把所有 resource 標成「剛剛才同步成功、backfill 完成」→ 全部在節流窗內。 */
async function markAllSyncedNow(db, user, now) {
  for (const resource of WHOOP_SYNC.RESOURCES) {
    await db.saveSyncState(user.id, resource, {
      backfillComplete: true,
      lastSuccessAt: now.toISOString(),
    }, { now });
  }
}

// ===========================================================================
// 節流述詞本身
// ===========================================================================

test('resourceSyncDue: 從來沒同步過 → due', () => {
  assert.equal(resourceSyncDue(null, { now: NOW }), true);
  assert.equal(resourceSyncDue({ lastSuccessAt: null, backfillComplete: true }, { now: NOW }), true);
});

test('resourceSyncDue: 剛同步完且 backfill 完成 → 節流', () => {
  const state = { lastSuccessAt: NOW.toISOString(), backfillComplete: true };
  assert.equal(resourceSyncDue(state, { now: NOW }), false);
});

test('resourceSyncDue: 超過 MIN_INTERVAL_MS → due', () => {
  const state = {
    lastSuccessAt: new Date(NOW.getTime() - WHOOP_SYNC.MIN_INTERVAL_MS - 1000).toISOString(),
    backfillComplete: true,
  };
  assert.equal(resourceSyncDue(state, { now: NOW }), true);
});

test('★ resourceSyncDue: backfill 未完成時不受節流限制', () => {
  const state = { lastSuccessAt: NOW.toISOString(), backfillComplete: false };
  assert.equal(resourceSyncDue(state, { now: NOW }), true);
});

test('isSyncDue: 任何一個 resource due 就算 due', async () => {
  await withDb(async (db) => {
    await markAllSyncedNow(db, ALICE, NOW);
    assert.equal(await isSyncDue({ db, userId: ALICE.id, now: NOW }), false);

    // 只讓一個 resource 過期
    await db.saveSyncState(ALICE.id, 'sleep', {
      backfillComplete: true,
      lastSuccessAt: new Date(NOW.getTime() - WHOOP_SYNC.MIN_INTERVAL_MS - 1000).toISOString(),
    }, { now: NOW });
    assert.equal(await isSyncDue({ db, userId: ALICE.id, now: NOW }), true);
  });
});

test('isSyncDue 缺 userId 一律拋錯', async () => {
  await withDb(async (db) => {
    await assert.rejects(() => isSyncDue({ db, userId: null, now: NOW }), /缺少 userId/);
  });
});

// ===========================================================================
// ★ 核心解耦行為
// ===========================================================================

test('★★★ 沒有報告要發 + 同步 due → 同步照樣執行', async () => {
  await withDb(async (db) => {
    await settleAllReports(db, ALICE, NOW);
    // 從來沒同步過 → sync due
    const calls = [];
    const out = await runForUser({
      db, env: ENV, user: { id: ALICE.id, timezone: ALICE.timezone }, now: NOW, deps: spyDeps(calls),
    });

    assert.equal(out.skipped, null);
    assert.equal(out.syncDue, true);
    assert.ok(kinds(calls).includes('sync'));
    assert.ok(!kinds(calls).includes('daily'));
    assert.ok(!kinds(calls).includes('weekly'));
  });
});

test('★★★ 沒有報告要發 + 同步 due → 主動代理也有機會評估', async () => {
  await withDb(async (db) => {
    await settleAllReports(db, ALICE, NOW);
    const calls = [];
    await runForUser({
      db, env: ENV, user: { id: ALICE.id, timezone: ALICE.timezone }, now: NOW, deps: spyDeps(calls),
    });

    assert.ok(kinds(calls).includes('proactive'));
    // 順序：sync 一定在 proactive 之前（新資料先進來才有東西可看）
    assert.ok(kinds(calls).indexOf('sync') < kinds(calls).indexOf('proactive'));
  });
});

test('★★★ 沒有報告要發 + 同步被節流 → 完全不碰 WHOOP', async () => {
  await withDb(async (db) => {
    await settleAllReports(db, ALICE, NOW);
    await markAllSyncedNow(db, ALICE, NOW);

    const calls = [];
    const out = await runForUser({
      db, env: ENV, user: { id: ALICE.id, timezone: ALICE.timezone }, now: NOW, deps: spyDeps(calls),
    });

    assert.equal(out.skipped, 'nothing_due');
    assert.equal(out.syncDue, false);
    // ★ 連 token 都不去拿：這一輪對 WHOOP 是零請求
    assert.ok(!kinds(calls).includes('whoop.token'), '不該為了沒事做而去拿 token');
    assert.ok(!kinds(calls).includes('sync'));
    assert.ok(!kinds(calls).includes('daily'));
    assert.ok(!kinds(calls).includes('proactive'));
  });
});

test('★ 完全沒事做時，過期問題的收割仍然會跑（純 DB，不需要 WHOOP）', async () => {
  await withDb(async (db) => {
    await settleAllReports(db, ALICE, NOW);
    await markAllSyncedNow(db, ALICE, NOW);

    const calls = [];
    const out = await runForUser({
      db, env: ENV, user: { id: ALICE.id, timezone: ALICE.timezone }, now: NOW, deps: spyDeps(calls),
    });

    assert.equal(out.skipped, 'nothing_due');
    assert.ok(kinds(calls).includes('reap'));
    assert.deepEqual(out.reaped, { expired: 0, noResponse: 0, skipped: 0 });
  });
});

// ===========================================================================
// 沒有放寬任何既有語義
// ===========================================================================

test('★★ 報告要發時，行為與以前完全一樣', async () => {
  await withDb(async (db) => {
    const calls = [];
    const out = await runForUser({
      db, env: ENV, user: { id: ALICE.id, timezone: ALICE.timezone }, now: NOW, deps: spyDeps(calls),
    });

    assert.equal(out.skipped, null);
    const k = kinds(calls);
    assert.ok(k.includes('daily'));
    assert.ok(k.includes('sync'));
    assert.ok(k.includes('proactive'));
    // 報告一定在同步之前（簡報優先）
    assert.ok(k.indexOf('daily') < k.indexOf('sync'));
  });
});

test('★★ 已送出的報告絕不會因為同步 due 而被重發', async () => {
  await withDb(async (db) => {
    await settleAllReports(db, ALICE, NOW);

    // 連跑三輪（每一輪同步都是 due 的）
    for (let i = 0; i < 3; i += 1) {
      const calls = [];
      await runForUser({
        db, env: ENV, user: { id: ALICE.id, timezone: ALICE.timezone }, now: NOW, deps: spyDeps(calls),
      });
      assert.ok(!kinds(calls).includes('daily'), `第 ${i + 1} 輪不可以再發日報`);
      assert.ok(!kinds(calls).includes('weekly'));
      assert.ok(!kinds(calls).includes('send'));
    }

    // report_runs 裡 SENT 的列數沒有增加
    const rs = await db.raw.execute({
      sql: "SELECT COUNT(*) AS n FROM report_runs WHERE user_id = ? AND status = 'SENT'",
      args: [ALICE.id],
    });
    assert.equal(Number(rs.rows[0].n), 3); // 兩筆 daily + 一筆 weekly
  });
});

test('★ 沒有 Telegram 綁定的使用者仍然直接跳過（先於任何 due 判斷）', async () => {
  await withDb(async (db) => {
    await db.revokeTelegramLink(ALICE.chatId);
    const calls = [];
    const out = await runForUser({
      db, env: ENV, user: { id: ALICE.id, timezone: ALICE.timezone }, now: NOW, deps: spyDeps(calls),
    });
    assert.equal(out.skipped, 'no_active_telegram_link');
    assert.deepEqual(calls, []);
  });
});

// ===========================================================================
// 失敗隔離
// ===========================================================================

test('★★ 一個使用者的同步失敗不影響另一個使用者', async () => {
  await withDb(async (db) => {
    await settleAllReports(db, ALICE, NOW);
    await settleAllReports(db, BOB, NOW);

    const aliceCalls = [];
    const bobCalls = [];

    const aliceOut = await runForUser({
      db, env: ENV, user: { id: ALICE.id, timezone: ALICE.timezone }, now: NOW,
      deps: spyDeps(aliceCalls, { failSync: true }),
    });
    const bobOut = await runForUser({
      db, env: ENV, user: { id: BOB.id, timezone: BOB.timezone }, now: NOW,
      deps: spyDeps(bobCalls),
    });

    assert.ok(aliceOut.errors.some((e) => e.stage === 'sync'));
    assert.equal(bobOut.errors.length, 0);
    assert.ok(kinds(bobCalls).includes('sync'));
    // Alice 同步炸掉，但她的 proactive 與 reap 還是跑了
    assert.ok(kinds(aliceCalls).includes('proactive'));
    assert.ok(kinds(aliceCalls).includes('reap'));
  });
});

test('★ Alice 的同步狀態不影響 Bob 的 due 判斷', async () => {
  await withDb(async (db) => {
    await markAllSyncedNow(db, ALICE, NOW);

    assert.equal(await isSyncDue({ db, userId: ALICE.id, now: NOW }), false);
    assert.equal(await isSyncDue({ db, userId: BOB.id, now: NOW }), true);
  });
});

test('★ 同步節流是 per-user 的：Alice 節流中，Bob 仍然會同步', async () => {
  await withDb(async (db) => {
    await settleAllReports(db, ALICE, NOW);
    await settleAllReports(db, BOB, NOW);
    await markAllSyncedNow(db, ALICE, NOW);

    const a = [];
    const b = [];
    await runForUser({
      db, env: ENV, user: { id: ALICE.id, timezone: ALICE.timezone }, now: NOW, deps: spyDeps(a),
    });
    await runForUser({
      db, env: ENV, user: { id: BOB.id, timezone: BOB.timezone }, now: NOW, deps: spyDeps(b),
    });

    assert.ok(!kinds(a).includes('sync'), 'Alice 在節流窗內');
    assert.ok(kinds(b).includes('sync'), 'Bob 沒有被 Alice 的狀態影響');
  });
});
