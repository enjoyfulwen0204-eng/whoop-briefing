/**
 * Minimal System Guardian（V1.1 Phase 9）。
 *
 * 最重要的測試是第一個：**健康時完全靜默**。
 * 一個會亂叫的監控比沒有監控更糟——被無視之後，真的出事時也不會有人看。
 *
 * 第二重要的是冷啟動：剛建立、還沒授權、一筆生理資料都沒有的帳號
 * **不是**故障。對著還沒開始用的帳號每天喊「同步異常」是最容易犯、
 * 也最惱人的錯。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createDb } from '../src/db.js';
import { evaluate, gatherFacts, runGuardian, renderFinding } from '../src/guardian.js';
import {
  GUARDIAN_LEVEL, GUARDIAN_POLICY, GUARDIAN_SIGNAL, HEARTBEAT_COMPONENT,
} from '../src/guardianPolicy.js';
import {
  GLOBAL_SCOPE, userScope, PROACTIVE_DECISION, PROACTIVE_QUESTION_INTENT,
} from '../src/schema.js';
import { ALICE, BOB, seedAliceAndBob } from './users.js';

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v11-guard-'));
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

const NOW = new Date('2026-09-09T12:00:00Z');
const agoMs = (ms) => new Date(NOW.getTime() - ms).toISOString();
const hoursAgo = (h) => agoMs(h * 3600_000);

/** 蒐集送出的訊息，並提供注入用的 telegram 工廠。 */
function telegramSpy(box, { fail = false } = {}) {
  return {
    systemTelegram: {
      async send(text) {
        if (fail) throw new Error('telegram down');
        box.push({ chatId: 'system', text });
        return { messageId: 1 };
      },
    },
    makeTelegram: ({ chatId }) => ({
      async send(text) {
        if (fail) throw new Error('telegram down');
        box.push({ chatId: String(chatId), text });
        return { messageId: 1 };
      },
    }),
  };
}

/** 一個「完全健康、已啟用」的使用者事實。 */
const healthyUser = (userId) => ({
  userId,
  hasWhoopToken: true,
  lastSyncOkAt: hoursAgo(1),
  stuckProactiveCount: 0,
  oldestStuckSentAt: null,
  whoopAuthFailures: 0,
});

// ===========================================================================
// ★★★ LEVEL 0：健康就閉嘴
// ===========================================================================

test('★★★ 一切正常 → 零 findings（完全靜默）', () => {
  const findings = evaluate({
    cronHeartbeat: { lastOkAt: hoursAgo(0.2) },
    users: [healthyUser('u-a'), healthyUser('u-b')],
    now: NOW,
  });
  assert.deepEqual(findings, []);
});

test('★★★ 端到端：健康系統跑 Guardian 不送任何訊息', async () => {
  await withDb(async (db) => {
    await db.recordHeartbeat(GLOBAL_SCOPE, HEARTBEAT_COMPONENT.CRON, { now: NOW });
    const box = [];
    const res = await runGuardian({ db, ...telegramSpy(box), now: NOW });

    assert.deepEqual(res.findings, []);
    assert.equal(res.notified, 0);
    assert.deepEqual(box, [], '健康時一則訊息都不可以送');
  });
});

test('★★ 完全空的系統（沒有心跳、沒有使用者）也是靜默的', async () => {
  const { db, cleanup } = tempDb();
  try {
    await db.migrate();
    const box = [];
    const res = await runGuardian({ db, ...telegramSpy(box), now: NOW });
    assert.deepEqual(res.findings, []);
    assert.deepEqual(box, []);
  } finally { db.close(); cleanup(); }
});

// ===========================================================================
// ★★★ 冷啟動不是故障
// ===========================================================================

test('★★★ 全新使用者（沒授權、沒資料）不會被報成故障', () => {
  const findings = evaluate({
    cronHeartbeat: { lastOkAt: hoursAgo(0.2) },
    users: [{
      userId: 'u-new',
      hasWhoopToken: false,
      lastSyncOkAt: null,
      stuckProactiveCount: 0,
      oldestStuckSentAt: null,
      whoopAuthFailures: 0,
    }],
    now: NOW,
  });
  assert.deepEqual(findings, [], '還沒開始用 ≠ 壞掉');
});

test('★★★ 剛授權但還沒同步過的帳號不會被報成「同步停擺」', () => {
  const findings = evaluate({
    cronHeartbeat: { lastOkAt: hoursAgo(0.2) },
    users: [{
      ...healthyUser('u-fresh'),
      lastSyncOkAt: null, // 從來沒成功同步過 = 進行中，不是故障
    }],
    now: NOW,
  });
  assert.deepEqual(findings, []);
});

test('★★ 沒授權的帳號即使有一堆卡住的事件也不報（閘門在最前面）', () => {
  const findings = evaluate({
    users: [{
      userId: 'u-x',
      hasWhoopToken: false,
      lastSyncOkAt: hoursAgo(999),
      stuckProactiveCount: 5,
      whoopAuthFailures: 99,
    }],
    now: NOW,
  });
  assert.deepEqual(findings, []);
});

test('★★ 從來沒有心跳（全新部署）不算 cron 死掉', () => {
  const findings = evaluate({ cronHeartbeat: null, users: [], now: NOW });
  assert.deepEqual(findings, []);
});

// ===========================================================================
// 四個 V1 訊號
// ===========================================================================

test('cron 心跳過期 → LEVEL_2，global scope', () => {
  const [f] = evaluate({
    cronHeartbeat: { lastOkAt: agoMs(GUARDIAN_POLICY.CRON_HEARTBEAT_MAX_AGE_MS + 60_000) },
    users: [],
    now: NOW,
  });
  assert.equal(f.signal, GUARDIAN_SIGNAL.CRON_HEARTBEAT_STALE);
  assert.equal(f.level, GUARDIAN_LEVEL.LEVEL_2_NOTIFY);
  assert.equal(f.scope, GLOBAL_SCOPE);
});

test('cron 心跳剛好在門檻內 → 不報', () => {
  const findings = evaluate({
    cronHeartbeat: { lastOkAt: agoMs(GUARDIAN_POLICY.CRON_HEARTBEAT_MAX_AGE_MS - 60_000) },
    users: [],
    now: NOW,
  });
  assert.deepEqual(findings, []);
});

test('同步停擺 → LEVEL_2，per-user scope', () => {
  const [f] = evaluate({
    users: [{
      ...healthyUser('u-a'),
      lastSyncOkAt: agoMs(GUARDIAN_POLICY.SYNC_STALE_MAX_AGE_MS + 3600_000),
    }],
    now: NOW,
  });
  assert.equal(f.signal, GUARDIAN_SIGNAL.WHOOP_SYNC_STALE);
  assert.equal(f.scope, userScope('u-a'));
});

test('主動事件卡住 → LEVEL_2', () => {
  const [f] = evaluate({
    users: [{ ...healthyUser('u-a'), stuckProactiveCount: 2, oldestStuckSentAt: hoursAgo(50) }],
    now: NOW,
  });
  assert.equal(f.signal, GUARDIAN_SIGNAL.PROACTIVE_EVENT_STUCK);
  assert.equal(f.detail.count, 2);
});

test('WHOOP 授權連續失敗達門檻 → LEVEL_2；未達門檻 → 不報', () => {
  const under = evaluate({
    users: [{
      ...healthyUser('u-a'),
      whoopAuthFailures: GUARDIAN_POLICY.WHOOP_AUTH_FAILURE_MIN_HITS - 1,
    }],
    now: NOW,
  });
  assert.deepEqual(under, []);

  const [f] = evaluate({
    users: [{
      ...healthyUser('u-a'),
      whoopAuthFailures: GUARDIAN_POLICY.WHOOP_AUTH_FAILURE_MIN_HITS,
    }],
    now: NOW,
  });
  assert.equal(f.signal, GUARDIAN_SIGNAL.WHOOP_AUTH_REPEATED_FAILURE);
});

// ===========================================================================
// 純度
// ===========================================================================

test('★ evaluate 是純函式：同樣輸入永遠同樣輸出，而且不改動輸入', () => {
  const facts = {
    cronHeartbeat: { lastOkAt: hoursAgo(99) },
    users: [healthyUser('u-a')],
    now: NOW,
  };
  const snapshot = JSON.stringify(facts);
  const a = evaluate(facts);
  const b = evaluate(facts);
  assert.deepEqual(a, b);
  assert.equal(JSON.stringify(facts), snapshot, '不可以改動輸入');
});

test('★ evaluate 對空輸入是安全的', () => {
  assert.deepEqual(evaluate(), []);
  assert.deepEqual(evaluate({}), []);
});

// ===========================================================================
// ★★ 不洩漏秘密 / 隱私
// ===========================================================================

test('★★★ 訊息不含 token、金鑰、或任何 Journal 內容', async () => {
  await withDb(async (db) => {
    const SECRET_TOKEN = 'SECRET-ACCESS-TOKEN-DO-NOT-LEAK';
    const SECRET_REFRESH = 'SECRET-REFRESH-DO-NOT-LEAK';
    const PRIVATE_JOURNAL = '昨天喝了很多酒而且跟老闆吵架';

    await db.saveTokens(ALICE.id, {
      accessToken: SECRET_TOKEN,
      refreshToken: SECRET_REFRESH,
      expiresAt: new Date('2026-12-31T00:00:00Z'),
      scope: 'offline read:recovery',
      whoopUserId: 'w-1',
    });
    await db.addJournalEvent(ALICE.id, {
      eventAt: NOW.toISOString(), healthDate: '2026-09-09',
      category: 'alcohol', note: PRIVATE_JOURNAL, textValue: PRIVATE_JOURNAL, source: 'manual',
    });
    // 造出一個「同步停擺」的狀況
    await db.saveSyncState(ALICE.id, 'sleep', {
      backfillComplete: true, lastSuccessAt: hoursAgo(99),
    }, { now: NOW });
    await db.recordHeartbeat(GLOBAL_SCOPE, HEARTBEAT_COMPONENT.CRON, { now: NOW });

    const box = [];
    const res = await runGuardian({ db, ...telegramSpy(box), now: NOW });

    assert.ok(res.findings.length > 0, '前提：真的有 finding');
    const all = JSON.stringify(box) + JSON.stringify(res.findings);
    assert.ok(!all.includes(SECRET_TOKEN), '絕不可以出現 access token');
    assert.ok(!all.includes(SECRET_REFRESH), '絕不可以出現 refresh token');
    assert.ok(!all.includes(PRIVATE_JOURNAL), '絕不可以出現 Journal 內容');
  });
});

test('★ renderFinding 只用樣板組字串，不含 detail 的原始內容', () => {
  const text = renderFinding({
    signal: GUARDIAN_SIGNAL.WHOOP_SYNC_STALE,
    level: GUARDIAN_LEVEL.LEVEL_2_NOTIFY,
    scope: userScope('u-a'),
    summary: 'WHOOP 資料已經 99 小時沒有成功同步',
    detail: { secret: 'SHOULD-NOT-APPEAR', age_hours: 99 },
  });
  assert.match(text, /系統健康檢查/);
  assert.ok(!text.includes('SHOULD-NOT-APPEAR'));
});

// ===========================================================================
// 冷卻 / 反洗版
// ===========================================================================

test('★★ 同一個訊號只通知一次，冷卻期內不再重複', async () => {
  await withDb(async (db) => {
    await db.saveSyncState(ALICE.id, 'sleep', {
      backfillComplete: true, lastSuccessAt: hoursAgo(99),
    }, { now: NOW });
    await db.saveTokens(ALICE.id, {
      accessToken: 'a', refreshToken: 'r',
      expiresAt: new Date('2026-12-31T00:00:00Z'), scope: 's', whoopUserId: 'w-1',
    });

    const box = [];
    const first = await runGuardian({ db, ...telegramSpy(box), now: NOW });
    assert.equal(first.notified, 1);

    const second = await runGuardian({ db, ...telegramSpy(box), now: NOW });
    assert.ok(second.findings.length > 0, '問題還在，所以還是有 finding');
    assert.equal(second.notified, 0, '★ 但冷卻期內不可以再通知');
    assert.equal(box.length, 1);
  });
});

test('★ 一次執行最多送 MAX_MESSAGES_PER_RUN 則', async () => {
  await withDb(async (db) => {
    // 讓兩個人都同步停擺 + cron 心跳也過期 → 至少三個 finding
    for (const u of [ALICE, BOB]) {
      await db.saveTokens(u.id, {
        accessToken: 'a', refreshToken: 'r',
        expiresAt: new Date('2026-12-31T00:00:00Z'), scope: 's', whoopUserId: `w-${u.id}`,
      });
      await db.saveSyncState(u.id, 'sleep', {
        backfillComplete: true, lastSuccessAt: hoursAgo(99),
      }, { now: NOW });
    }
    await db.recordHeartbeat(GLOBAL_SCOPE, HEARTBEAT_COMPONENT.CRON, { now: new Date(NOW.getTime() - 99 * 3600_000) });

    const box = [];
    const res = await runGuardian({ db, ...telegramSpy(box), now: NOW });
    assert.ok(res.findings.length >= 3);
    assert.ok(box.length <= GUARDIAN_POLICY.MAX_MESSAGES_PER_RUN);
  });
});

// ===========================================================================
// per-user 隔離
// ===========================================================================

test('★★★ Alice 的故障不會通知到 Bob 的 chat', async () => {
  await withDb(async (db) => {
    await db.saveTokens(ALICE.id, {
      accessToken: 'a', refreshToken: 'r',
      expiresAt: new Date('2026-12-31T00:00:00Z'), scope: 's', whoopUserId: 'w-a',
    });
    await db.saveSyncState(ALICE.id, 'sleep', {
      backfillComplete: true, lastSuccessAt: hoursAgo(99),
    }, { now: NOW });
    // Bob 完全健康且已啟用
    await db.saveTokens(BOB.id, {
      accessToken: 'b', refreshToken: 'r2',
      expiresAt: new Date('2026-12-31T00:00:00Z'), scope: 's', whoopUserId: 'w-b',
    });
    await db.saveSyncState(BOB.id, 'sleep', {
      backfillComplete: true, lastSuccessAt: hoursAgo(1),
    }, { now: NOW });
    await db.recordHeartbeat(GLOBAL_SCOPE, HEARTBEAT_COMPONENT.CRON, { now: NOW });

    const box = [];
    await runGuardian({ db, ...telegramSpy(box), now: NOW });

    assert.equal(box.length, 1);
    assert.equal(box[0].chatId, ALICE.chatId);
    assert.ok(!box.some((m) => m.chatId === BOB.chatId), 'Bob 不該收到任何東西');
  });
});

test('★★ Alice 的冷卻不會壓抑 Bob 的同類通知', async () => {
  await withDb(async (db) => {
    for (const u of [ALICE, BOB]) {
      await db.saveTokens(u.id, {
        accessToken: 'a', refreshToken: 'r',
        expiresAt: new Date('2026-12-31T00:00:00Z'), scope: 's', whoopUserId: `w-${u.id}`,
      });
      await db.saveSyncState(u.id, 'sleep', {
        backfillComplete: true, lastSuccessAt: hoursAgo(99),
      }, { now: NOW });
    }
    await db.recordHeartbeat(GLOBAL_SCOPE, HEARTBEAT_COMPONENT.CRON, { now: NOW });

    const box = [];
    const res = await runGuardian({ db, ...telegramSpy(box), now: NOW });
    assert.equal(res.notified, 2, '兩個人各收到自己的那一則');
    assert.deepEqual(
      box.map((m) => m.chatId).sort(),
      [ALICE.chatId, BOB.chatId].sort(),
    );
  });
});

// ===========================================================================
// 韌性
// ===========================================================================

test('★★ Telegram 掛掉不會拋錯、不會重試、不會迴圈', async () => {
  await withDb(async (db) => {
    await db.saveTokens(ALICE.id, {
      accessToken: 'a', refreshToken: 'r',
      expiresAt: new Date('2026-12-31T00:00:00Z'), scope: 's', whoopUserId: 'w-a',
    });
    await db.saveSyncState(ALICE.id, 'sleep', {
      backfillComplete: true, lastSuccessAt: hoursAgo(99),
    }, { now: NOW });

    const box = [];
    const res = await runGuardian({
      db, ...telegramSpy(box, { fail: true }), now: NOW,
    });
    assert.ok(res.findings.length > 0);
    assert.equal(res.notified, 0);
    assert.deepEqual(box, []);
  });
});

test('★★ DB 整個壞掉時 Guardian 不會遞迴嘗試把自己的錯誤寫進同一個 DB', async () => {
  const brokenDb = {
    acquireLock: async () => 'owner',
    releaseLock: async () => true,
    getHeartbeat: async () => { throw new Error('turso down'); },
    listActiveUsers: async () => { throw new Error('turso down'); },
    claimErrorNotify: async () => { throw new Error('turso down'); },
    getActiveChatIdForUser: async () => { throw new Error('turso down'); },
  };
  const box = [];
  const res = await runGuardian({ db: brokenDb, ...telegramSpy(box), now: NOW });
  assert.deepEqual(res.findings, []);
  assert.equal(res.notified, 0);
  assert.deepEqual(box, []);
});

test('★★ 兩個 Guardian 同時跑 → 只有一個真的執行（single-flight）', async () => {
  await withDb(async (db) => {
    await db.saveTokens(ALICE.id, {
      accessToken: 'a', refreshToken: 'r',
      expiresAt: new Date('2026-12-31T00:00:00Z'), scope: 's', whoopUserId: 'w-a',
    });
    await db.saveSyncState(ALICE.id, 'sleep', {
      backfillComplete: true, lastSuccessAt: hoursAgo(99),
    }, { now: NOW });

    const box = [];
    const [a, b] = await Promise.all([
      runGuardian({ db, ...telegramSpy(box), now: NOW }),
      runGuardian({ db, ...telegramSpy(box), now: NOW }),
    ]);

    const skipped = [a, b].filter((r) => r.skipped === 'another_guardian_running');
    assert.equal(skipped.length, 1, '恰好一個被鎖擋下');
    assert.equal(box.length, 1, '只會送出一則');
  });
});

test('★ 重啟安全：狀態全在 DB，換一個連線結果一樣', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v11-guard-restart-'));
  const url = `file:${path.join(dir, 't.db')}`;
  try {
    const db1 = createDb({ url });
    await db1.migrate();
    await db1.recordHeartbeat(GLOBAL_SCOPE, HEARTBEAT_COMPONENT.CRON, { now: NOW });
    db1.close();

    const db2 = createDb({ url });
    const hb = await db2.getHeartbeat(GLOBAL_SCOPE, HEARTBEAT_COMPONENT.CRON);
    assert.equal(hb.lastOkAt, NOW.toISOString());
    db2.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ===========================================================================
// 事實蒐集
// ===========================================================================

test('gatherFacts 讀得到心跳、同步時間、卡住的事件與授權失敗次數', async () => {
  await withDb(async (db) => {
    await db.recordHeartbeat(GLOBAL_SCOPE, HEARTBEAT_COMPONENT.CRON, { now: NOW });
    await db.saveTokens(ALICE.id, {
      accessToken: 'a', refreshToken: 'r',
      expiresAt: new Date('2026-12-31T00:00:00Z'), scope: 's', whoopUserId: 'w-a',
    });
    await db.saveSyncState(ALICE.id, 'sleep', {
      backfillComplete: true, lastSuccessAt: hoursAgo(2),
    }, { now: NOW });

    // 一筆「問了、送出了、但沒收尾」而且夠老的事件。
    // ⚠️ 一定要真的開一個追問（M-07）：沒有追問的事件在送出時就已經是
    // DELIVERED 終局，本來就不該被算成「卡住」。
    const sentAt = new Date(NOW.getTime() - 72 * 3600_000);
    const claim = await db.claimProactiveEvent(ALICE.id, {
      healthDate: '2026-09-05', idempotencyKey: 'stuck-1',
      signals: [], decision: PROACTIVE_DECISION.ASK_CONTEXT,
      reason: {}, policyVersion: 'p1', messageText: 'q',
    }, { now: sentAt });
    const stuckQuestionId = await db.openPendingQuestion(ALICE.id, {
      chatId: ALICE.chatId, question: 'q', intent: PROACTIVE_QUESTION_INTENT,
      contextJson: { proactive_event_id: claim.id }, ttlMs: 30 * 60_000,
    }, { now: sentAt });
    await db.markProactiveEventSent(ALICE.id, claim.id, {
      pendingQuestionId: stuckQuestionId,
    }, { now: sentAt });

    // 授權失敗次數：用既有的 claimErrorNotify 累積
    await db.claimErrorNotify(userScope(ALICE.id), 'whoop_auth', 2);
    await db.claimErrorNotify(userScope(ALICE.id), 'whoop_auth', 2);

    const facts = await gatherFacts({ db, now: NOW });
    const alice = facts.users.find((u) => u.userId === ALICE.id);

    assert.equal(facts.cronHeartbeat.lastOkAt, NOW.toISOString());
    assert.equal(alice.hasWhoopToken, true);
    assert.ok(alice.lastSyncOkAt);
    assert.equal(alice.stuckProactiveCount, 1);
    assert.ok(alice.whoopAuthFailures >= 1);
  });
});

test('★ gatherFacts 不會因為單一查詢失敗而整個垮掉', async () => {
  await withDb(async (db) => {
    const partial = {
      ...db,
      getHeartbeat: async () => { throw new Error('nope'); },
      countStuckProactiveEvents: async () => { throw new Error('nope'); },
    };
    const facts = await gatherFacts({ db: partial, now: NOW });
    assert.equal(facts.cronHeartbeat, null);
    assert.equal(facts.users.length, 2);
    assert.equal(facts.users[0].stuckProactiveCount, 0);
  });
});

// ===========================================================================
// Guardian 不做的事
// ===========================================================================

test('★★★ Guardian 沒有任何修改資料 / 部署 / 執行程式的能力', async () => {
  const src = fs.readFileSync(new URL('../src/guardian.js', import.meta.url), 'utf8');
  // 這是一個粗糙但有效的守門：Guardian 不該 import 任何能改東西的模組
  for (const forbidden of [
    'child_process', 'node:child_process', 'exec(', 'spawn(',
    'migrate', 'saveTokens', 'runMigrations', 'upsert',
  ]) {
    assert.ok(!src.includes(forbidden), `Guardian 不該碰 ${forbidden}`);
  }
});

test('★★ LEVEL_1 / LEVEL_3 只是保留的列舉值，沒有被實作', () => {
  assert.ok(GUARDIAN_LEVEL.LEVEL_1_SAFE_RECOVERY);
  assert.ok(GUARDIAN_LEVEL.LEVEL_3_REPAIR_PACKET);

  // evaluate 目前只會產生 LEVEL_2
  const findings = evaluate({
    cronHeartbeat: { lastOkAt: hoursAgo(99) },
    users: [{ ...healthyUser('u-a'), whoopAuthFailures: 99, stuckProactiveCount: 3 }],
    now: NOW,
  });
  assert.ok(findings.length > 0);
  for (const f of findings) {
    assert.equal(f.level, GUARDIAN_LEVEL.LEVEL_2_NOTIFY);
  }
});
