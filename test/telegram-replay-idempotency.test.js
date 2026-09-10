/**
 * 同一則 Telegram 訊息只會產生一次副作用（M-09）。
 *
 * ## 修的是什麼
 *
 * polling.js 有三層不重複機制，但**全部**建立在「offset 存得下去」上。
 * 每一則訊息的實際流程是：
 *
 *   處理（寫 journal、跑分析、送訊息） → 存 offset
 *
 * 這是兩段寫入。中間 worker 被殺（部署、OOM、SIGKILL）的話，offset 還是
 * 舊的，Telegram 會把同一則 update 再送一次。實測確認：同一句「喝了兩杯」
 * 被寫成 **2 筆** journal。
 *
 * 而 journal 是所有長期關聯分析的輸入 —— 重複的曝露日會直接扭曲相關係數，
 * 而且**永遠不會自己修好**。
 *
 * ## 現在的不變量
 *
 *   **認領 update_id 是產生任何副作用的前置條件。**
 *   認領放在 classify() 之前：連身分解析都不做，就不可能有任何副作用。
 *
 * ## 遷移安全
 *
 * 這是一張**純新增**的表（`CREATE TABLE IF NOT EXISTS`），而且
 * `runMigrations()` 的 SCHEMA 迴圈是無條件執行的，所以：
 * 不需要動版本號、不碰任何既有表、不重建、不刪任何一列。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createDb } from '../src/db.js';
import { createPoller } from '../src/bot/polling.js';
import { createRouter } from '../src/bot/router.js';
import { SCHEMA_VERSION } from '../src/schema.js';

const NOW = new Date('2026-09-09T02:00:00Z');
const CHAT = '555';

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm09-'));
  const db = createDb({ url: `file:${path.join(dir, 't.db')}` });
  return { db, dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

async function withUser(fn) {
  const { db, cleanup } = tempDb();
  try {
    await db.migrate();
    const user = await db.createUser({ displayName: 'K', timezone: 'Asia/Taipei' });
    await db.linkTelegram({ chatId: CHAT, userId: user.id });
    await fn(db, user);
  } finally {
    db.close();
    cleanup();
  }
}

const coachFor = () => ({
  async json() {
    return {
      category: 'alcohol', subtype: 'beer', numeric_value: 2, unit: 'cup', confidence: 0.9,
    };
  },
  async ask() { return null; },
});

function makePoller(db, { sent = [] } = {}) {
  const router = createRouter({ db, coachFor, now: () => NOW });
  return createPoller({
    db,
    botToken: 'T',
    api: { async getUpdates() { return []; }, async sendMessage(c, t) { sent.push(t); return {}; } },
    resolveUser: (chatId) => db.resolveUserByChatId(chatId),
    handleMessage: async ({ text, chatId, user }) => {
      const reply = await router.handle({ text, chatId, user });
      if (reply) sent.push(reply);
    },
  });
}

const update = (id, text = '喝了兩杯') => ({
  update_id: id,
  message: {
    message_id: id,
    chat: { id: Number(CHAT), type: 'private' },
    from: { id: Number(CHAT), is_bot: false, first_name: 'K' },
    text,
    date: 1,
  },
});

const journalCount = async (db, userId) => (await db.getJournalEvents(userId, {
  from: '2026-09-01', to: '2026-09-30', limit: 100,
})).length;

// ===========================================================================
// ★★★ 重送不會產生第二次副作用
// ===========================================================================

test('★★★ M-09: offset 沒存下去就被殺 → 重送同一則不會寫第二筆 journal', async () => {
  await withUser(async (db, user) => {
    const u = update(100);

    // 第一次：處理成功，但存 offset 之前 worker 被殺
    const realSet = db.setUpdateOffset.bind(db);
    db.setUpdateOffset = async () => { throw new Error('killed before offset save'); };
    await makePoller(db).processBatch([u], 0);
    db.setUpdateOffset = realSet;

    assert.equal(await journalCount(db, user.id), 1, '前置：第一次確實寫進去了');
    assert.equal(await db.getUpdateOffset(), 0, '前置：offset 確實沒存下去');

    // 重啟：Telegram 重送同一則
    await makePoller(db).processBatch([u], 0);
    assert.equal(await journalCount(db, user.id), 1,
      '★ 同一則訊息絕不可以被寫成兩筆 journal');
  });
});

test('★★★ M-09: 重送時完全不回覆（不會對使用者說兩次一樣的話）', async () => {
  await withUser(async (db) => {
    const u = update(100);
    const first = [];
    await makePoller(db, { sent: first }).processBatch([u], 0);
    assert.ok(first.length > 0, '前置：第一次有回話');

    const second = [];
    await makePoller(db, { sent: second }).processBatch([u], 0);
    assert.deepEqual(second, [], '★ 重送不可以再回一次');
  });
});

test('★★★ M-09: 重送時連身分解析都不做（認領在 classify 之前）', async () => {
  await withUser(async (db) => {
    const u = update(100);
    await makePoller(db).processBatch([u], 0);

    let resolved = 0;
    const poller = createPoller({
      db,
      botToken: 'T',
      api: { async getUpdates() { return []; }, async sendMessage() { return {}; } },
      resolveUser: async (chatId) => { resolved += 1; return db.resolveUserByChatId(chatId); },
      handleMessage: async () => { throw new Error('不該被呼叫'); },
    });
    await poller.processBatch([u], 0);
    assert.equal(resolved, 0, '★ 連查都不該查——查詢本身也可能有副作用');
  });
});

test('★★ M-09: 重送仍然會把 offset 推進去（不會卡住整條 queue）', async () => {
  await withUser(async (db) => {
    await makePoller(db).processBatch([update(100)], 0);
    await db.setUpdateOffset(0);
    const next = await makePoller(db).processBatch([update(100)], 0);
    assert.equal(next, 101, '★ 跳過也要推進 offset');
  });
});

test('★★★ M-09: 一批裡混著新舊訊息 → 只有新的產生副作用', async () => {
  await withUser(async (db, user) => {
    await makePoller(db).processBatch([update(100)], 0);
    await db.setUpdateOffset(0);

    await makePoller(db).processBatch([update(100), update(101, '又喝了一杯')], 0);
    assert.equal(await journalCount(db, user.id), 2,
      '★ 舊的跳過、新的照常處理');
  });
});

test('★★ M-09: 兩個 worker 同時處理同一則 → 只有一個認領成功', async () => {
  await withUser(async (db, user) => {
    // owner 必須不同 —— 這一題問的是「不同的 worker」。
    // 同一個 owner 重複認領是 ambiguous commit 的復原路徑（見 R3-M-05 測試）。
    const results = await Promise.all([
      db.claimTelegramUpdate(200, { owner: 'w1' }),
      db.claimTelegramUpdate(200, { owner: 'w2' }),
      db.claimTelegramUpdate(200, { owner: 'w3' }),
    ]);
    assert.equal(results.filter((r) => r.ok).length, 1, '★ 恰好一個贏');
    assert.ok(user.id);
  });
});

test('★★ M-09: claimTelegramUpdate 對不合法的 id 安全拒絕', async () => {
  await withUser(async (db) => {
    for (const bad of [null, undefined, 'abc', NaN, {}]) {
      const r = await db.claimTelegramUpdate(bad);
      assert.equal(r.ok, false);
      assert.equal(r.state, 'invalid');
    }
  });
});

// ===========================================================================
// 認領紀錄不會無限成長
// ===========================================================================

test('★★ M-09: 舊的認領紀錄會被裁剪，但保留窗內的一定還在', async () => {
  await withUser(async (db) => {
    for (const id of [1, 2, 3, 50_000, 50_001]) {
      await db.claimTelegramUpdate(id, { owner: 'w1' });
      await db.completeTelegramUpdate(id, { owner: 'w1' });
    }
    await db.pruneTelegramUpdates(50_002, { keep: 10 });

    assert.equal((await db.claimTelegramUpdate(1, { owner: 'w2' })).ok, true,
      '很舊的被裁掉了（可以重新認領）');
    assert.equal((await db.claimTelegramUpdate(50_001, { owner: 'w2' })).state, 'completed',
      '★ 保留窗內的絕不可以被裁掉');
  });
});

test('★★ M-09: id 還沒超過保留窗時，裁剪是乾淨的 no-op', async () => {
  await withUser(async (db) => {
    await db.claimTelegramUpdate(5, { owner: 'w1' });
    await db.completeTelegramUpdate(5, { owner: 'w1' });
    assert.equal(await db.pruneTelegramUpdates(9, { keep: 10 }), 0);
    assert.equal((await db.claimTelegramUpdate(5, { owner: 'w2' })).state, 'completed',
      '★ 不可以被誤刪');
  });
});

// ===========================================================================
// ★★★ 遷移安全：純新增表
// ===========================================================================

test('★★★ M-09 遷移安全: 既有資料庫加上新表，一列資料都不會少', async () => {
  const { db, cleanup } = tempDb();
  try {
    await db.migrate();
    const user = await db.createUser({ displayName: 'K', timezone: 'Asia/Taipei' });
    await db.addJournalEvent(user.id, {
      eventAt: '2026-09-08T12:00:00.000Z', healthDate: '2026-09-08',
      category: 'alcohol', note: '既有資料', source: 'manual',
    });
    const before = await db.getJournalEvents(user.id, {
      from: '2026-09-01', to: '2026-09-30', limit: 10,
    });

    // 再跑一次 migrate（模擬部署新版）
    const summary = await db.migrate();

    const after = await db.getJournalEvents(user.id, {
      from: '2026-09-01', to: '2026-09-30', limit: 10,
    });
    assert.deepEqual(after, before, '★ 既有資料必須一模一樣');
    assert.deepEqual(summary.rebuilt, [], '★ 不可以重建任何既有表');
    assert.equal(summary.to, SCHEMA_VERSION);
    assert.equal((await db.claimTelegramUpdate(1, { owner: 'w1' })).ok, true, '新表可以用了');
  } finally {
    db.close();
    cleanup();
  }
});

test('★★★ M-09 遷移安全: 重複 migrate 不會清掉已經認領的紀錄', async () => {
  const { db, cleanup } = tempDb();
  try {
    await db.migrate();
    await db.claimTelegramUpdate(777, { owner: 'w1' });
    await db.completeTelegramUpdate(777, { owner: 'w1' });
    await db.migrate();
    await db.migrate();
    assert.equal((await db.claimTelegramUpdate(777, { owner: 'w2' })).state, 'completed',
      '★ CREATE TABLE IF NOT EXISTS 不可以把紀錄洗掉');
  } finally {
    db.close();
    cleanup();
  }
});

test('★★ M-09: 沒有新 store 函式的舊 fake db 仍然可以跑（安全降級）', async () => {
  await withUser(async (db, user) => {
    const stripped = { ...db };
    delete stripped.claimTelegramUpdate;
    delete stripped.pruneTelegramUpdates;
    const router = createRouter({ db, coachFor, now: () => NOW });
    const poller = createPoller({
      db: stripped,
      botToken: 'T',
      api: { async getUpdates() { return []; }, async sendMessage() { return {}; } },
      resolveUser: (chatId) => db.resolveUserByChatId(chatId),
      handleMessage: async ({ text, chatId, user: u }) => { await router.handle({ text, chatId, user: u }); },
    });
    await poller.processBatch([update(100)], 0);
    assert.equal(await journalCount(db, user.id), 1, '★ 不可以因為缺函式就整個掛掉');
  });
});
