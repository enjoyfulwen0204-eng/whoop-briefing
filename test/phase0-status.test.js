/**
 * V1.2 Phase 0 觀測工具。
 *
 * 這支工具的全部價值建立在一件事上：**它只讀、不改**。Phase 0 要跑 7～14 天，
 * 期間正式環境一直在動；一個會寫東西的觀測工具會污染它自己要量的基線。
 *
 * 所以測試的重點不是輸出好不好看，而是：
 *   - 跑完之後資料庫**一個位元組都沒變**（含 schema）
 *   - 完全沒有對外呼叫（WHOOP / OpenRouter / Telegram）
 *   - 沒有資料時回 null / 0，不是崩潰、也不是捏造
 *   - 多使用者時每個人的數字互不混入
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createDb } from '../src/db.js';
import { WAKE } from '../src/config.js';
import {
  collectPhase0, renderPhase0, wakeEligibleAt, minutesBetween, observeWakeGate,
} from '../scripts/phase0-status.js';

const NOW = new Date('2026-09-11T06:00:00Z');

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase0-'));
  const db = createDb({ url: `file:${path.join(dir, 't.db')}` });
  return { db, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

async function withDb(fn) {
  const { db, cleanup } = tempDb();
  try {
    await db.migrate();
    await fn(db);
  } finally {
    db.close();
    cleanup();
  }
}

/** 整個資料庫的內容快照（用來證明「跑完沒有變」）。 */
async function snapshot(db) {
  const tables = (await db.raw.execute(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  )).rows.map((r) => String(r.name));
  const out = {};
  for (const t of tables) {
    out[t] = (await db.raw.execute(`SELECT * FROM "${t}" ORDER BY rowid`)).rows.map((r) => ({ ...r }));
  }
  return out;
}

/** 一個有睡眠 / 恢復 / 報告的使用者。 */
async function seedUser(db, { id, chat, healthDate = '2026-09-11' }) {
  const user = await db.createUser({ displayName: id, timezone: 'Asia/Taipei' });
  await db.linkTelegram({ chatId: chat, userId: user.id });
  await db.raw.execute({
    sql: `INSERT INTO whoop_sleeps (user_id, id, health_date, start_at, end_at, nap,
            score_state, created_at, updated_at, synced_at)
          VALUES (?,?,?,?,?,0,'SCORED',?,?,?)`,
    args: [user.id, `s-${user.id}`, healthDate, '2026-09-10T17:00:00.000Z',
      '2026-09-11T01:43:34.000Z', '2026-09-11T00:17:53.000Z',
      '2026-09-11T01:58:00.000Z', '2026-09-11T04:32:23.000Z'],
  });
  await db.raw.execute({
    sql: `INSERT INTO whoop_recoveries (user_id, sleep_id, cycle_id, health_date, score_state,
            created_at, updated_at, synced_at)
          VALUES (?,?,?,?, 'SCORED', ?,?,?)`,
    args: [user.id, `s-${user.id}`, `c-${user.id}`, healthDate, '2026-09-11T00:17:53.000Z',
      '2026-09-11T01:58:00.000Z', '2026-09-11T04:32:23.000Z'],
  });
  await db.raw.execute({
    sql: `INSERT INTO report_claims (user_id, report_type, local_date, owner, claimed_at,
            expires_at, telegram_sent_at)
          VALUES (?, 'daily', ?, 'o', ?, ?, ?)`,
    args: [user.id, healthDate, '2026-09-11T04:32:40.000Z',
      '2026-09-11T05:32:40.000Z', '2026-09-11T04:32:41.000Z'],
  });
  return user;
}

// ===========================================================================
// ★★★ 只讀
// ===========================================================================

test('★★★ Phase 0: 跑完之後資料庫完全沒有被改動（含 schema）', async () => {
  await withDb(async (db) => {
    await seedUser(db, { id: 'alice', chat: '5001' });
    const before = await snapshot(db);

    await collectPhase0(db, { now: NOW });

    assert.deepEqual(await snapshot(db), before,
      '★ 觀測工具不可以留下任何痕跡 —— 它要量的基線正在跑');
  });
});

test('★★★ Phase 0: 不呼叫 migrate（觀測工具不該有能力改 schema）', async () => {
  await withDb(async (db) => {
    let migrated = 0;
    const watched = { ...db, migrate: async () => { migrated += 1; return {}; } };
    await collectPhase0(watched, { now: NOW });
    assert.equal(migrated, 0, '★ Phase 0 期間不可以跑 migration');
  });
});

test('★★★ Phase 0: 完全不對外呼叫（WHOOP / OpenRouter / Telegram）', async () => {
  await withDb(async (db) => {
    await seedUser(db, { id: 'alice', chat: '5001' });
    const calls = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (...a) => { calls.push(String(a[0])); throw new Error('不該有網路呼叫'); };
    try {
      await collectPhase0(db, { now: NOW });
    } finally {
      globalThis.fetch = realFetch;
    }
    assert.deepEqual(calls, [], '★ 觀測不可以打任何外部 API');
  });
});

test('★★★ Phase 0: 只用 SELECT（沒有任何寫入語句）', async () => {
  await withDb(async (db) => {
    await seedUser(db, { id: 'alice', chat: '5001' });
    const stmts = [];
    const watched = {
      ...db,
      raw: {
        execute: async (arg) => {
          stmts.push(typeof arg === 'string' ? arg : arg.sql);
          return db.raw.execute(arg);
        },
      },
    };
    await collectPhase0(watched, { now: NOW });

    assert.ok(stmts.length > 0, '要真的有查東西');
    for (const sql of stmts) {
      assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|REPLACE)\b/i,
        `★ 出現了寫入語句：${sql.slice(0, 80)}`);
    }
  });
});

// ===========================================================================
// ★★★ 沒有資料時的行為
// ===========================================================================

test('★★★ Phase 0: 全新的空資料庫 → 回 null/0，不崩潰也不捏造', async () => {
  await withDb(async (db) => {
    const d = await collectPhase0(db, { now: NOW });
    assert.equal(d.users, 0);
    assert.deepEqual(d.perUser, []);
    assert.equal(d.scheduler.lastOkAt, null, '★ 沒有心跳就是 null，不可以假裝跑過');
    assert.equal(d.scheduler.stale, null, '★ 沒有心跳時「過不過期」是未知，不是 false');
    assert.equal(d.telegram.updates, 0);
    assert.ok(renderPhase0(d).includes('從來沒有完整跑完過一輪'));
  });
});

test('★★ Phase 0: 有使用者但完全沒有健康資料 → 各區塊都說「還沒有」', async () => {
  await withDb(async (db) => {
    await db.createUser({ displayName: 'new', timezone: 'Asia/Taipei' });
    const d = await collectPhase0(db, { now: NOW });
    const p = d.perUser[0];
    assert.equal(p.sleeps.length, 0);
    assert.equal(p.token, null, '★ 沒授權就是 null');
    assert.equal(p.cost.calls, 0);
    for (const r of p.resources) assert.equal(r.count, 0);
    const text = renderPhase0(d);
    assert.ok(text.includes('還沒有主睡眠紀錄'));
    assert.ok(text.includes('沒有 token'));
  });
});

// ===========================================================================
// ★★★ 延遲鏈與修訂
// ===========================================================================

test('★★★ Phase 0: 延遲鏈算得出來，而且推論值有被標示', async () => {
  await withDb(async (db) => {
    await seedUser(db, { id: 'alice', chat: '5001' });
    const d = await collectPhase0(db, { now: NOW });
    const s = d.perUser[0].sleeps[0];

    assert.equal(s.healthDate, '2026-09-11');
    assert.equal(s.sleepScoreState, 'SCORED');
    assert.equal(s.recoveryScoreState, 'SCORED');
    // 01:43:34 → 01:58:00 ≈ 14 分鐘
    assert.equal(s.endToWhoopUpdateMin, 14);
    // 01:58:00 → 04:32:23 ≈ 154 分鐘
    assert.equal(s.whoopUpdateToSyncMin, 154);
    // 醒來資格 = 睡眠結束 + 30 分鐘（既有政策推導，沒有改動閘門）
    assert.equal(s.wakeEligibleAt, '2026-09-11T02:13:34.000Z');
    // 02:13:34 → 04:32:41 ≈ 139 分鐘
    assert.equal(s.eligibleToSentMin, 139);

    const text = renderPhase0(d);
    assert.ok(text.includes('（推論）'), '★ 推論出來的延遲必須標明，不可以當成觀測事實');
    assert.ok(text.includes('由 WAKE 政策推導'));
  });
});

test('★★★ Phase 0: WHOOP updated_at 晚於 created_at 的紀錄會被算出來', async () => {
  await withDb(async (db) => {
    await seedUser(db, { id: 'alice', chat: '5001' });
    const d = await collectPhase0(db, { now: NOW });
    const sleep = d.perUser[0].resources.find((r) => r.resource === 'sleep');
    assert.equal(sleep.updatedAfterCreateCount, 1);
    assert.equal(d.perUser[0].sleeps[0].whoopUpdatedAfterCreation, true);
    assert.match(renderPhase0(d), /不代表已觀測到多版/);
  });
});

test('★★ Phase 0: 沒被改過的紀錄不可以被算成修訂', async () => {
  await withDb(async (db) => {
    const u = await db.createUser({ displayName: 'a', timezone: 'Asia/Taipei' });
    await db.raw.execute({
      sql: `INSERT INTO whoop_sleeps (user_id, id, health_date, end_at, nap, score_state,
              created_at, updated_at, synced_at)
            VALUES (?,?,?,?,0,'SCORED',?,?,?)`,
      args: [u.id, 's1', '2026-09-11', '2026-09-11T01:00:00.000Z',
        '2026-09-11T02:00:00.000Z', '2026-09-11T02:00:00.000Z', '2026-09-11T03:00:00.000Z'],
    });
    const d = await collectPhase0(db, { now: NOW });
    assert.equal(d.perUser[0].resources.find((r) => r.resource === 'sleep').updatedAfterCreateCount, 0);
    assert.equal(d.perUser[0].sleeps[0].whoopUpdatedAfterCreation, false);
  });
});

// ===========================================================================
// ★★★ 多使用者隔離
// ===========================================================================

test('★★★ Phase 0: 兩個使用者的數字不可以互相混入', async () => {
  await withDb(async (db) => {
    const alice = await seedUser(db, { id: 'alice', chat: '5001' });
    const bob = await seedUser(db, { id: 'bob', chat: '5002' });
    // Bob 多一筆睡眠
    await db.raw.execute({
      sql: `INSERT INTO whoop_sleeps (user_id, id, health_date, end_at, nap, score_state,
              created_at, updated_at, synced_at)
            VALUES (?,?,?,?,0,'SCORED',?,?,?)`,
      args: [bob.id, 's-bob-2', '2026-09-10', '2026-09-10T01:00:00.000Z',
        '2026-09-10T02:00:00.000Z', '2026-09-10T02:00:00.000Z', '2026-09-10T03:00:00.000Z'],
    });

    const d = await collectPhase0(db, { now: NOW });
    assert.equal(d.users, 2);
    const A = d.perUser.find((p) => p.userId === alice.id);
    const B = d.perUser.find((p) => p.userId === bob.id);

    assert.equal(A.resources.find((r) => r.resource === 'sleep').count, 1,
      '★ Alice 不可以看到 Bob 的睡眠');
    assert.equal(B.resources.find((r) => r.resource === 'sleep').count, 2);
    assert.equal(A.reports.claims[0].sent, 1);
    assert.equal(B.reports.claims[0].sent, 1, '★ 報告也要各自計算');
  });
});

// ===========================================================================
// 輸出安全：不可以洩漏健康數值或 secret
// ===========================================================================

test('★★★ Phase 0: 輸出不含 token 值', async () => {
  await withDb(async (db) => {
    const u = await seedUser(db, { id: 'alice', chat: '5001' });
    // 哨兵值：不是真的 token，只是拿來確認它不會出現在輸出裡。
    // 刻意不寫成 `accessToken: '長字串'` 的字面形狀，免得密鑰掃描誤報。
    const fakeAccess = ['phase0', 'fixture', 'sentinel', 'access'].join('-');
    const fakeRefresh = ['phase0', 'fixture', 'sentinel', 'refresh'].join('-');
    await db.saveTokens(u.id, {
      accessToken: fakeAccess,
      refreshToken: fakeRefresh,
      expiresAt: new Date('2026-09-11T05:32:38.000Z'),
      scope: 'offline read:sleep',
      whoopUserId: '111',
    });
    const d = await collectPhase0(db, { now: NOW });
    const text = renderPhase0(d);

    assert.ok(!text.includes(fakeAccess), '★ 絕不可以印 access token');
    assert.ok(!text.includes(fakeRefresh), '★ 絕不可以印 refresh token');
    assert.ok(!JSON.stringify(d).includes(fakeAccess));
    assert.ok(!JSON.stringify(d).includes(fakeRefresh));
    // 但時間性的中介資料要看得到（那才是我們要觀測的）
    assert.ok(d.perUser[0].token.lastWriteAt);
    assert.equal(d.perUser[0].token.identityBound, true);
  });
});

test('★★★ Phase 0: 輸出不含生理數值', async () => {
  await withDb(async (db) => {
    const u = await db.createUser({ displayName: 'a', timezone: 'Asia/Taipei' });
    await db.raw.execute({
      sql: `INSERT INTO whoop_sleeps (user_id, id, health_date, end_at, nap, score_state,
              sleep_performance_percentage, respiratory_rate, created_at, updated_at, synced_at)
            VALUES (?,?,?,?,0,'SCORED', 93.5, 16.7, ?,?,?)`,
      args: [u.id, 's1', '2026-09-11', '2026-09-11T01:00:00.000Z',
        '2026-09-11T02:00:00.000Z', '2026-09-11T02:00:00.000Z', '2026-09-11T03:00:00.000Z'],
    });
    const text = renderPhase0(await collectPhase0(db, { now: NOW }));
    assert.ok(!text.includes('93.5'), '★ 不可以印睡眠表現');
    assert.ok(!text.includes('16.7'), '★ 不可以印呼吸率');
  });
});

// ===========================================================================
// 小工具
// ===========================================================================

test('★★ Phase 0: 缺任何一端的時間戳就回 null（不猜）', () => {
  assert.equal(minutesBetween(null, '2026-09-11T00:00:00Z'), null);
  assert.equal(minutesBetween('2026-09-11T00:00:00Z', null), null);
  assert.equal(minutesBetween('bad', '2026-09-11T00:00:00Z'), null);
  assert.equal(minutesBetween('2026-09-11T00:00:00Z', '2026-09-11T01:00:00Z'), 60);
  assert.equal(wakeEligibleAt(null), null);
});

test('★★ Phase 0: 醒來資格沿用既有的 WAKE 政策（沒有另外寫一個數字）', () => {
  const end = '2026-09-11T01:43:34.000Z';
  const expected = new Date(new Date(end).getTime() + WAKE.MIN_MINUTES_AFTER_SLEEP_END * 60_000);
  assert.equal(wakeEligibleAt(end), expected.toISOString());
});

test('★★★ Phase 0: wake gate 沿用正式的 scored/recovery/時間視窗規則', () => {
  const sleep = { id: 's1', health_date: '2026-09-11', end_at: '2026-09-11T01:00:00Z', score_state: 'SCORED' };
  const recovery = { score_state: 'SCORED' };
  assert.equal(observeWakeGate({ sleep, recovery, now: new Date('2026-09-11T01:29:00Z'), timezone: 'Asia/Taipei' }).reason, 'too_soon');
  assert.equal(observeWakeGate({ sleep, recovery: null, now: new Date('2026-09-11T02:00:00Z'), timezone: 'Asia/Taipei' }).reason, 'recovery_missing');
  assert.equal(observeWakeGate({ sleep: { ...sleep, score_state: 'PENDING_SCORE' }, recovery, now: new Date('2026-09-11T02:00:00Z'), timezone: 'Asia/Taipei' }).reason, 'sleep_not_scored');
  assert.equal(observeWakeGate({ sleep, recovery: { score_state: 'PENDING_SCORE' }, now: new Date('2026-09-11T02:00:00Z'), timezone: 'Asia/Taipei' }).reason, 'recovery_not_scored');
  assert.equal(observeWakeGate({ sleep, recovery, now: new Date('2026-09-12T01:01:00Z'), timezone: 'Asia/Taipei' }).reason, 'sleep_too_old');
  assert.equal(observeWakeGate({ sleep, recovery, now: new Date('2026-09-11T02:00:00Z'), timezone: 'Asia/Taipei' }).ready, true);
});

test('★★★ Phase 0: recovery 必須用 sleep_id 連到正確主睡眠', async () => {
  await withDb(async (db) => {
    const u = await db.createUser({ displayName: 'a', timezone: 'Asia/Taipei' });
    await db.raw.execute({
      sql: `INSERT INTO whoop_sleeps (user_id,id,health_date,end_at,nap,score_state,synced_at)
            VALUES (?,?,?,?,0,'SCORED',?)`,
      args: [u.id, 'right-sleep', '2026-09-11', '2026-09-11T01:00:00Z', '2026-09-11T01:05:00Z'],
    });
    await db.raw.execute({
      sql: `INSERT INTO whoop_recoveries (user_id,sleep_id,cycle_id,health_date,score_state,synced_at)
            VALUES (?,?,?,?, 'SCORED',?)`,
      args: [u.id, 'different-sleep', 'c1', '2026-09-11', '2026-09-11T01:05:00Z'],
    });
    const s = (await collectPhase0(db, { now: new Date('2026-09-11T02:00:00Z') })).perUser[0].sleeps[0];
    assert.equal(s.recoveryScoreState, null);
    assert.equal(s.wakeGateReason, 'recovery_missing');
  });
});
