/**
 * 拿不到持久化所有權就不處理（R2-M-05）。
 *
 * ## 修的是什麼
 *
 * 上一輪加了 `claimTelegramUpdate`（在 classify 之前原子認領），關掉了
 * 「重送 → 重複寫 journal」。但認領**本身失敗**時舊版是刻意放行的
 * （註解寫「寧可偶爾重複，也不要讓整個 bot 啞掉」）。
 *
 * 那個取捨是錯的，實測的失敗序列證明了：
 *
 *   claim 拋錯（DB 抽風）→ 副作用照做 → offset 也存不下去（同一次故障）
 *   → Telegram 重送 → DB 已恢復 → 認領成功 → **再做一次**
 *   → 同一句「喝了兩杯」寫了 2 筆 journal
 *
 * ## 現在的不變量
 *
 *   **無法建立持久化的所有權時，不可以進行任何變更處理。**
 *
 * 而且**不會丟掉那一則訊息**：認領不可用時刻意**不推進 offset**，整批在
 * 那裡停下。DB 恢復之後 Telegram 會再送一次，那時才第一次真正處理它。
 *
 * 短暫的抽風先重試幾次（CLAIM_RETRIES），重試用完才 fail closed。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createDb } from '../src/db.js';
import { createPoller } from '../src/bot/polling.js';
import { createRouter } from '../src/bot/router.js';
import { TELEGRAM_BOT } from '../src/config.js';

const NOW = new Date('2026-09-09T02:00:00Z');
const CHAT = '555';

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r2m05-'));
  const db = createDb({ url: `file:${path.join(dir, 't.db')}` });
  return { db, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
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
    return { category: 'alcohol', subtype: 'beer', numeric_value: 2, unit: 'cup', confidence: 0.9 };
  },
  async ask() { return null; },
});

const update = (id) => ({
  update_id: id,
  message: {
    message_id: id, chat: { id: Number(CHAT), type: 'private' },
    from: { id: Number(CHAT), is_bot: false }, text: '喝了兩杯', date: 1,
  },
});

function makePoller(db, realDb, { sent = [] } = {}) {
  const router = createRouter({ db: realDb, coachFor, now: () => NOW });
  return createPoller({
    db,
    botToken: 'T',
    api: { async getUpdates() { return []; }, async sendMessage() { return {}; } },
    resolveUser: (chatId) => realDb.resolveUserByChatId(chatId),
    handleMessage: async ({ text, chatId, user }) => {
      const reply = await router.handle({ text, chatId, user });
      if (reply) sent.push(reply);
    },
    sleepImpl: async () => {},   // 測試不要真的等退避
  });
}

const journalCount = async (db, userId) => (await db.getJournalEvents(userId, {
  from: '2026-09-01', to: '2026-09-30', limit: 100,
})).length;

// ===========================================================================
// 正常路徑（不可以退化）
// ===========================================================================

test('★★ R2-M-05: 認領成功 → 正常處理', async () => {
  await withUser(async (db, user) => {
    await makePoller(db, db).processBatch([update(100)], 0);
    assert.equal(await journalCount(db, user.id), 1);
    assert.equal(await db.getUpdateOffset(), 101);
  });
});

test('★★ R2-M-05: 重送（認領回 false）→ 跳過但推進 offset', async () => {
  await withUser(async (db, user) => {
    await makePoller(db, db).processBatch([update(100)], 0);
    await db.setUpdateOffset(0);
    const next = await makePoller(db, db).processBatch([update(100)], 0);
    assert.equal(await journalCount(db, user.id), 1, '★ 不可以寫第二筆');
    assert.equal(next, 101, '★ 跳過也要推進 offset，否則整條 queue 卡住');
  });
});

test('★★ R2-M-05: 並發認領同一則 → 恰好一個成功', async () => {
  await withUser(async (db) => {
    const rs = await Promise.all([
      db.claimTelegramUpdate(200, { owner: 'w1' }),
      db.claimTelegramUpdate(200, { owner: 'w2' }),
      db.claimTelegramUpdate(200, { owner: 'w3' }),
    ]);
    assert.equal(rs.filter((r) => r.ok).length, 1);
  });
});

// ===========================================================================
// ★★★ 認領不可用 → fail closed，但不丟訊息
// ===========================================================================

const alwaysFails = (db) => ({
  ...db,
  claimTelegramUpdate: async () => { throw new Error('claim table unavailable'); },
});

test('★★★ R2-M-05: 認領一直失敗 → 完全不處理（沒有任何副作用）', async () => {
  await withUser(async (db, user) => {
    const sent = [];
    await makePoller(alwaysFails(db), db, { sent }).processBatch([update(100)], 0);
    assert.equal(await journalCount(db, user.id), 0, '★ 絕不可以寫 journal');
    assert.deepEqual(sent, [], '★ 也不可以回覆（那也是副作用）');
  });
});

test('★★★ R2-M-05: 認領一直失敗 → offset 不推進（訊息不會被丟掉）', async () => {
  await withUser(async (db) => {
    const next = await makePoller(alwaysFails(db), db).processBatch([update(100)], 0);
    assert.equal(next, 0, '★ 回傳的 offset 不可以跳過那一則');
    assert.equal(await db.getUpdateOffset(), 0, '★ 存下的 offset 也不可以推進');
  });
});

test('★★★ R2-M-05: DB 恢復後重送 → 恰好處理一次', async () => {
  await withUser(async (db, user) => {
    // 最壞情況：認領失敗 **而且** offset 也存不下去
    const broken = {
      ...alwaysFails(db),
      setUpdateOffset: async () => { throw new Error('offset save failed too'); },
    };
    await makePoller(broken, db).processBatch([update(100)], 0);
    assert.equal(await journalCount(db, user.id), 0);

    // DB 恢復，Telegram 重送
    await makePoller(db, db).processBatch([update(100)], await db.getUpdateOffset());
    assert.equal(await journalCount(db, user.id), 1, '★ 恰好一次');
    assert.equal(await db.getUpdateOffset(), 101);
  });
});

test('★★★ R2-M-05: 認領不可用時整批停下（不會把 offset 推過那一則）', async () => {
  await withUser(async (db, user) => {
    let calls = 0;
    // 第一則認領失敗，之後都成功
    const flaky = {
      ...db,
      claimTelegramUpdate: async (id, o) => {
        calls += 1;
        if (Number(id) === 100) throw new Error('down');
        return db.claimTelegramUpdate(id, o);
      },
    };
    const next = await makePoller(flaky, db).processBatch(
      [update(100), update(101), update(102)], 0,
    );
    assert.equal(next, 0, '★ 整批必須停在第一則失敗的地方');
    assert.equal(await journalCount(db, user.id), 0,
      '★ 後面的 update 也不可以被處理（那會讓 offset 越過失敗的那一則）');
    assert.ok(calls >= TELEGRAM_BOT.CLAIM_RETRIES, '要真的重試過');
  });
});

// ===========================================================================
// ★★★ 暫時性失敗會重試
// ===========================================================================

test('★★★ R2-M-05: 暫時性失敗重試之後成功 → 正常處理一次', async () => {
  await withUser(async (db, user) => {
    let attempts = 0;
    const flaky = {
      ...db,
      claimTelegramUpdate: async (id, o) => {
        attempts += 1;
        if (attempts < TELEGRAM_BOT.CLAIM_RETRIES) throw new Error('transient');
        return db.claimTelegramUpdate(id, o);
      },
    };
    await makePoller(flaky, db).processBatch([update(100)], 0);
    assert.equal(attempts, TELEGRAM_BOT.CLAIM_RETRIES, '★ 要重試到成功');
    assert.equal(await journalCount(db, user.id), 1, '★ 而且只處理一次');
    assert.equal(await db.getUpdateOffset(), 101);
  });
});

test('★★ R2-M-05: 重試次數是明文政策', () => {
  assert.ok(Number.isInteger(TELEGRAM_BOT.CLAIM_RETRIES) && TELEGRAM_BOT.CLAIM_RETRIES >= 2);
  assert.ok(Number.isInteger(TELEGRAM_BOT.CLAIM_RETRY_BASE_MS)
    && TELEGRAM_BOT.CLAIM_RETRY_BASE_MS > 0);
});

// ===========================================================================
// ★★★ offset 存不下去（既有行為不可以退化）
// ===========================================================================

test('★★★ R2-M-05: 認領成功但 offset 存不下去 → 重送不會重複處理', async () => {
  await withUser(async (db, user) => {
    const noOffset = {
      ...db,
      setUpdateOffset: async () => { throw new Error('offset save failed'); },
    };
    await makePoller(noOffset, db).processBatch([update(100)], 0);
    assert.equal(await journalCount(db, user.id), 1);
    assert.equal(await db.getUpdateOffset(), 0, '前置：offset 確實沒存下去');

    // 重送：認領已經被記下來了 → 跳過
    await makePoller(db, db).processBatch([update(100)], 0);
    assert.equal(await journalCount(db, user.id), 1, '★ 認領紀錄擋下重複處理');
  });
});

// ===========================================================================
// 重啟
// ===========================================================================

test('★★ R2-M-05: 重啟（換 db 連線）之後認領紀錄仍然有效', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r2m05-restart-'));
  const url = `file:${path.join(dir, 't.db')}`;
  try {
    const db1 = createDb({ url });
    await db1.migrate();
    const user = await db1.createUser({ displayName: 'K', timezone: 'Asia/Taipei' });
    await db1.linkTelegram({ chatId: CHAT, userId: user.id });
    await makePoller(db1, db1).processBatch([update(100)], 0);
    await db1.setUpdateOffset(0);
    db1.close();

    const db2 = createDb({ url });
    await db2.migrate();
    await makePoller(db2, db2).processBatch([update(100)], 0);
    assert.equal(await journalCount(db2, user.id), 1, '★ 重啟後也不可以重複處理');
    db2.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('★★ R2-M-05: 沒有認領函式的舊 fake db 仍然可以跑', async () => {
  await withUser(async (db, user) => {
    const stripped = { ...db };
    delete stripped.claimTelegramUpdate;
    delete stripped.pruneTelegramUpdates;
    await makePoller(stripped, db).processBatch([update(100)], 0);
    assert.equal(await journalCount(db, user.id), 1);
  });
});
