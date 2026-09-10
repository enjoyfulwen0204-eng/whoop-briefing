/**
 * 持久化的處理狀態機（R3-M-05）。
 *
 * ## 修的是什麼
 *
 * 認領表原本只有一個事實：**列存在**。而它同時被拿來代表兩件在崩潰時會
 * 分開、而且處置正好相反的事：
 *
 *   「我認領了」  和  「我做完了」
 *
 * 實測重現的兩個後果：
 *
 *   A. 認領成功、**還沒 dispatch** 就被殺 → 重送時看到列 → 判為重複 →
 *      這則訊息一件事都沒做，卻永遠不會再被處理。**靜默遺失。**
 *   B. INSERT 其實 commit 了，但連線在回應前斷掉（ambiguous commit）→
 *      重試撞主鍵 → 一樣被判為重複 → 一樣靜默遺失。
 *
 * 而反方向的要求同時存在：副作用做完之後才崩潰的那一則**不可以**被重做，
 * 否則同一句話會寫出第二筆 journal —— journal 是長期相關分析的輸入，
 * 重複的曝露日會直接扭曲係數，而且永遠不會自己修好。
 *
 * ## 現在的狀態機
 *
 *   （沒有列）→ CLAIMED → PROCESSING → COMPLETED
 *
 *   CLAIMED    拿到所有權，**還沒 dispatch**，保證零副作用。
 *              → 租約過期可以安全接手（重做沒有代價）。這關掉 A。
 *              → 同一個 owner 撞到自己的 CLAIMED 就是續租。這關掉 B。
 *   PROCESSING 已經 dispatch，副作用可能發生了。
 *              → 租約過期可以接手：動作與 telegram_operations 收據同交易。
 *                有收據就回傳結果；無收據就重新處理。
 *   COMPLETED  終局。真正的重複。
 *
 * 「收到」不需要是一個狀態：在我們寫下第一列之前，訊息的耐久性由 Telegram
 * 自己保證（沒推進 offset 就會再送）。CLAIMED 就是我們的第一個持久化事實。
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
import { SCHEMA_VERSION, TELEGRAM_UPDATE_STATUS } from '../src/schema.js';

const NOW = new Date('2026-09-09T02:00:00Z');
const CHAT = '555';

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r3m05-'));
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

function makePoller(db, realDb, { sent = [], workerId, now = () => NOW, onHandle } = {}) {
  const router = createRouter({ db: realDb, coachFor, now: () => NOW });
  return createPoller({
    db,
    botToken: 'T',
    api: { async getUpdates() { return []; }, async sendMessage() { return {}; } },
    resolveUser: (chatId) => realDb.resolveUserByChatId(chatId),
    handleMessage: async ({ text, chatId, user }) => {
      if (onHandle) await onHandle();
      const reply = await router.handle({ text, chatId, user });
      if (reply) sent.push(reply);
    },
    sleepImpl: async () => {},
    ...(workerId ? { workerId } : {}),
    now,
  });
}

const journalCount = async (db, userId) => (await db.getJournalEvents(userId, {
  from: '2026-09-01', to: '2026-09-30', limit: 100,
})).length;

const statusOf = async (db, id) => (await db.getTelegramUpdate(id))?.status ?? null;

// ===========================================================================
// ★★★ A：認領完、dispatch 之前崩潰 → 必須可以復原
// ===========================================================================

test('★★★ R3-M-05: CLAIMED 之後死掉（零副作用）→ 重送時被安全接手', async () => {
  await withUser(async (db, user) => {
    // 上一個 worker 認領了就死了，租約早就過期。
    const dead = await db.claimTelegramUpdate(100, {
      owner: 'dead-worker', leaseMs: 1_000,
      now: new Date(NOW.getTime() - 3600_000),
    });
    assert.equal(dead.ok, true);
    assert.equal(await statusOf(db, 100), TELEGRAM_UPDATE_STATUS.CLAIMED);

    await makePoller(db, db, { workerId: 'fresh-worker' }).processBatch([update(100)], 0);

    assert.equal(await journalCount(db, user.id), 1,
      '★ 這則訊息一件事都還沒做過，必須被處理（不可以靜默遺失）');
    assert.equal(await statusOf(db, 100), TELEGRAM_UPDATE_STATUS.COMPLETED);
  });
});

test('★★★ R3-M-05: 別人的 CLAIMED 租約還活著 → 不接手、不推進 offset', async () => {
  await withUser(async (db, user) => {
    await db.claimTelegramUpdate(100, { owner: 'live-worker', leaseMs: 300_000, now: NOW });

    const next = await makePoller(db, db, { workerId: 'me' }).processBatch([update(100)], 0);

    assert.equal(await journalCount(db, user.id), 0, '★ 不可以有副作用');
    assert.equal(next, 0, '★ 不可以推進 offset（那會把訊息丟掉）');
  });
});

// ===========================================================================
// ★★★ B：ambiguous commit
// ===========================================================================

test('★★★ R3-M-05: INSERT 其實成功但回報失敗 → 重試認得出是自己的認領', async () => {
  await withUser(async (db, user) => {
    let first = true;
    const flaky = {
      ...db,
      async claimTelegramUpdate(id, o) {
        const r = await db.claimTelegramUpdate(id, o);
        // commit 成功了，但連線在回應前斷掉。
        if (first) { first = false; throw new Error('connection reset after commit'); }
        return r;
      },
    };
    await makePoller(flaky, db, { workerId: 'me' }).processBatch([update(100)], 0);

    assert.equal(await journalCount(db, user.id), 1,
      '★ 自己的認領不可以把自己判成重複');
    assert.equal(await statusOf(db, 100), TELEGRAM_UPDATE_STATUS.COMPLETED);
  });
});

test('★★★ R3-M-05: 同一個 owner 重複認領 CLAIMED = 續租，不是重複', async () => {
  await withUser(async (db) => {
    const a = await db.claimTelegramUpdate(100, { owner: 'me', leaseMs: 60_000, now: NOW });
    const b = await db.claimTelegramUpdate(100, { owner: 'me', leaseMs: 60_000, now: NOW });
    assert.equal(a.ok, true);
    assert.equal(b.ok, true, '★ 這是同一個 worker 的重試');
    assert.equal(b.attempts, 2, '★ 但要看得出來重試過');
  });
});

test('★★★ R3-M-05: 別的 owner 不可以靠重複認領搶走活著的租約', async () => {
  await withUser(async (db) => {
    await db.claimTelegramUpdate(100, { owner: 'me', leaseMs: 60_000, now: NOW });
    const other = await db.claimTelegramUpdate(100, { owner: 'other', leaseMs: 60_000, now: NOW });
    assert.equal(other.ok, false);
    assert.equal(other.state, 'in_progress');
  });
});

// ===========================================================================
// ★★★ C：副作用之後、標記完成之前崩潰
// ===========================================================================

test('★★★ R3-M-05: PROCESSING 中途死掉 → 恢復未提交工作並完成', async () => {
  await withUser(async (db, user) => {
    // 上一個 worker 已經 dispatch（副作用可能發生了）然後死掉。
    const past = new Date(NOW.getTime() - 3600_000);
    await db.claimTelegramUpdate(100, { owner: 'dead', leaseMs: 1_000, now: past });
    await db.markTelegramUpdateProcessing(100, { owner: 'dead', now: past });
    assert.equal(await statusOf(db, 100), TELEGRAM_UPDATE_STATUS.PROCESSING);

    const next = await makePoller(db, db, { workerId: 'fresh' }).processBatch([update(100)], 0);

    assert.equal(await journalCount(db, user.id), 1, '未提交工作必須恢復');
    assert.equal(await statusOf(db, 100), TELEGRAM_UPDATE_STATUS.COMPLETED);
    assert.equal(next, 101, '★ 佇列要往前走，不可以卡死');
  });
});

test('★★★ R3-M-05: 完成標記寫不進去 → 重送時不會重做', async () => {
  await withUser(async (db, user) => {
    const broken = {
      ...db,
      completeTelegramUpdate: async () => { throw new Error('write failed'); },
    };
    await makePoller(broken, db, { workerId: 'w1' }).processBatch([update(100)], 0);
    assert.equal(await journalCount(db, user.id), 1, '副作用已經發生了');
    assert.equal(await statusOf(db, 100), TELEGRAM_UPDATE_STATUS.PROCESSING);

    // 租約過期之後 Telegram 重送。
    const later = new Date(NOW.getTime() + TELEGRAM_BOT.CLAIM_LEASE_MS + 60_000);
    await makePoller(db, db, { workerId: 'w2', now: () => later }).processBatch([update(100)], 0);

    assert.equal(await journalCount(db, user.id), 1, '★ 恰好一次');
    assert.equal(await statusOf(db, 100), TELEGRAM_UPDATE_STATUS.COMPLETED);
  });
});

// ===========================================================================
// ★★★ 正常路徑與收斂
// ===========================================================================

test('★★★ R3-M-05: 正常處理一則 → CLAIMED → PROCESSING → COMPLETED', async () => {
  await withUser(async (db, user) => {
    const seen = [];
    const spy = {
      ...db,
      async claimTelegramUpdate(id, o) {
        const r = await db.claimTelegramUpdate(id, o);
        seen.push(['claim', await statusOf(db, id)]);
        return r;
      },
      async markTelegramUpdateProcessing(id, o) {
        const r = await db.markTelegramUpdateProcessing(id, o);
        seen.push(['dispatch', await statusOf(db, id)]);
        return r;
      },
    };
    await makePoller(spy, db, { workerId: 'w1' }).processBatch([update(100)], 0);

    assert.deepEqual(seen, [
      ['claim', TELEGRAM_UPDATE_STATUS.CLAIMED],
      ['dispatch', TELEGRAM_UPDATE_STATUS.PROCESSING],
    ], '★ 狀態必須真的分階段推進，不是一步到位');
    assert.equal(await statusOf(db, 100), TELEGRAM_UPDATE_STATUS.COMPLETED);
    assert.equal(await journalCount(db, user.id), 1);
    assert.equal(await db.getUpdateOffset(), 101);
  });
});

test('★★★ R3-M-05: PROCESSING 標記在 dispatch **之前**（不是之後）', async () => {
  await withUser(async (db) => {
    let statusAtDispatch = null;
    await makePoller(db, db, {
      workerId: 'w1',
      onHandle: async () => { statusAtDispatch = await statusOf(db, 100); },
    }).processBatch([update(100)], 0);

    assert.equal(statusAtDispatch, TELEGRAM_UPDATE_STATUS.PROCESSING,
      '★ 副作用發生時狀態必須已經是 PROCESSING —— 否則崩潰之後分不出是哪個區間');
  });
});

test('★★★ R3-M-05: 推不進 PROCESSING（所有權沒了）→ 完全不 dispatch', async () => {
  await withUser(async (db, user) => {
    const fenced = { ...db, markTelegramUpdateProcessing: async () => false };
    const next = await makePoller(fenced, db, { workerId: 'w1' }).processBatch([update(100)], 0);

    assert.equal(await journalCount(db, user.id), 0, '★ 沒有所有權就不可以有副作用');
    assert.equal(next, 0, '★ 也不可以推進 offset');
  });
});

test('★★★ R3-M-05: 真正的重複（COMPLETED）→ 跳過，但推進 offset', async () => {
  await withUser(async (db, user) => {
    await makePoller(db, db, { workerId: 'w1' }).processBatch([update(100)], 0);
    // offset 存檔失敗 → Telegram 重送同一則
    const next = await makePoller(db, db, { workerId: 'w2' }).processBatch([update(100)], 0);

    assert.equal(await journalCount(db, user.id), 1, '★ 恰好一次');
    assert.equal(next, 101, '★ 重複也要推進 offset，否則佇列卡死');
  });
});

test('★★★ R3-M-05: 重啟（新的 db 連線、新的 workerId）自我修復', async () => {
  const { db, cleanup } = tempDb();
  const dir = path.dirname(String(db.url ?? ''));
  try {
    await db.migrate();
    const user = await db.createUser({ displayName: 'K', timezone: 'Asia/Taipei' });
    await db.linkTelegram({ chatId: CHAT, userId: user.id });
    // 舊 worker 認領後就死了。
    await db.claimTelegramUpdate(100, {
      owner: 'old-process', leaseMs: 1_000, now: new Date(NOW.getTime() - 7200_000),
    });
    // 「重啟」：狀態全在 DB 裡。
    await makePoller(db, db, { workerId: 'new-process' }).processBatch([update(100)], 0);
    assert.equal(await journalCount(db, user.id), 1, '★ 重啟之後要收斂');
    assert.equal(await statusOf(db, 100), TELEGRAM_UPDATE_STATUS.COMPLETED);
  } finally {
    db.close();
    cleanup();
    if (dir && dir !== '.') fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('★★★ R3-M-05: offset 存檔一直失敗 → 靠認領表仍然恰好一次', async () => {
  await withUser(async (db, user) => {
    const noOffset = { ...db, setUpdateOffset: async () => { throw new Error('offset write failed'); } };
    await makePoller(noOffset, db, { workerId: 'w1' }).processBatch([update(100)], 0);
    await makePoller(noOffset, db, { workerId: 'w2' }).processBatch([update(100)], 0);
    await makePoller(noOffset, db, { workerId: 'w3' }).processBatch([update(100)], 0);

    assert.equal(await journalCount(db, user.id), 1,
      '★ offset 只是最佳化，認領表才是防重複的那一層');
  });
});

// ===========================================================================
// ★★★ 狀態轉移的完整性
// ===========================================================================

test('★★★ R3-M-05: 不是所有權人不可以標記完成', async () => {
  await withUser(async (db) => {
    await db.claimTelegramUpdate(100, { owner: 'me', leaseMs: 60_000, now: NOW });
    await db.markTelegramUpdateProcessing(100, { owner: 'me', now: NOW });
    assert.equal(await db.completeTelegramUpdate(100, { owner: 'someone-else', now: NOW }), false);
    assert.equal(await statusOf(db, 100), TELEGRAM_UPDATE_STATUS.PROCESSING);
    assert.equal(await db.completeTelegramUpdate(100, { owner: 'me', now: NOW }), true);
  });
});

test('★★★ R3-M-05: 不是所有權人不可以推進到 PROCESSING', async () => {
  await withUser(async (db) => {
    await db.claimTelegramUpdate(100, { owner: 'me', leaseMs: 60_000, now: NOW });
    assert.equal(await db.markTelegramUpdateProcessing(100, { owner: 'other', now: NOW }), false);
    assert.equal(await statusOf(db, 100), TELEGRAM_UPDATE_STATUS.CLAIMED);
  });
});

test('★★★ R3-M-05: COMPLETED 是終局，任何人都不可以把它拉回來', async () => {
  await withUser(async (db) => {
    await db.claimTelegramUpdate(100, { owner: 'me', leaseMs: 60_000, now: NOW });
    await db.completeTelegramUpdate(100, { owner: 'me', now: NOW });

    const again = await db.claimTelegramUpdate(100, { owner: 'me', leaseMs: 60_000, now: NOW });
    assert.equal(again.state, 'completed', '★ 連原本的所有權人也不可以');
    const other = await db.claimTelegramUpdate(100, { owner: 'other', leaseMs: 60_000, now: NOW });
    assert.equal(other.state, 'completed');
    assert.equal(await db.markTelegramUpdateProcessing(100, { owner: 'me', now: NOW }), false);
    assert.equal(await statusOf(db, 100), TELEGRAM_UPDATE_STATUS.COMPLETED);
  });
});

test('★★★ R3-M-05: 還活著的 PROCESSING 不可以被判成放棄', async () => {
  await withUser(async (db) => {
    await db.claimTelegramUpdate(100, { owner: 'me', leaseMs: 300_000, now: NOW });
    await db.markTelegramUpdateProcessing(100, { owner: 'me', now: NOW });
    assert.equal(await db.abandonTelegramUpdate(100, { reason: 'x', now: NOW }), false,
      '★ 租約還活著就代表真的有人在做');
    assert.equal(await statusOf(db, 100), TELEGRAM_UPDATE_STATUS.PROCESSING);
  });
});

test('★★★ R3-M-05: 併發：多個 worker 搶同一則 → 恰好一個處理', async () => {
  await withUser(async (db, user) => {
    await Promise.all([
      makePoller(db, db, { workerId: 'a' }).processBatch([update(100)], 0),
      makePoller(db, db, { workerId: 'b' }).processBatch([update(100)], 0),
      makePoller(db, db, { workerId: 'c' }).processBatch([update(100)], 0),
    ]);
    assert.equal(await journalCount(db, user.id), 1, '★ 恰好一次');
  });
});

// ===========================================================================
// ★★★ 裁剪不可以打開重複的洞
// ===========================================================================

test('★★★ R3-M-05: 裁剪只刪終局的列，不可以刪掉還在處理中的', async () => {
  await withUser(async (db) => {
    await db.claimTelegramUpdate(1, { owner: 'w1', leaseMs: 300_000, now: NOW });
    await db.markTelegramUpdateProcessing(1, { owner: 'w1', now: NOW });
    await db.claimTelegramUpdate(2, { owner: 'w2', leaseMs: 300_000, now: NOW });
    await db.claimTelegramUpdate(3, { owner: 'w3', leaseMs: 300_000, now: NOW });
    await db.completeTelegramUpdate(3, { owner: 'w3', now: NOW });

    await db.pruneTelegramUpdates(50_000, { keep: 10 });

    assert.equal(await statusOf(db, 1), TELEGRAM_UPDATE_STATUS.PROCESSING,
      '★ 刪掉 PROCESSING 等於把「有人做到一半」這件事忘掉');
    assert.equal(await statusOf(db, 2), TELEGRAM_UPDATE_STATUS.CLAIMED,
      '★ 刪掉 CLAIMED 等於讓下一次重送變成全新的認領');
    assert.equal(await statusOf(db, 3), null, '終局的可以裁掉');
  });
});

// ===========================================================================
// ★★★ 遷移：有資料的正式資料庫
// ===========================================================================

test('★★★ R3-M-05 遷移: 舊形狀 + 有資料 → 加欄位，一列都不少', async () => {
  const { db, cleanup } = tempDb();
  try {
    await db.migrate();
    // 把表退回 v4 的形狀（只有兩欄），並塞進代表性資料。
    await db.raw.execute('DROP TABLE telegram_processed_updates');
    await db.raw.execute(`CREATE TABLE telegram_processed_updates (
      update_id INTEGER PRIMARY KEY, processed_at TEXT NOT NULL)`);
    for (const id of [11, 12, 13]) {
      await db.raw.execute({
        sql: 'INSERT INTO telegram_processed_updates (update_id, processed_at) VALUES (?,?)',
        args: [id, NOW.toISOString()],
      });
    }
    await db.raw.execute('DELETE FROM schema_version');

    const summary = await db.migrate();

    assert.deepEqual(summary.rebuilt, [], '★ 不可以重建（重建會清光已處理的紀錄）');
    const rows = (await db.raw.execute('SELECT * FROM telegram_processed_updates ORDER BY update_id')).rows;
    assert.equal(rows.length, 3, '★ 一列都不可以少');
    for (const r of rows) {
      assert.equal(String(r.status), TELEGRAM_UPDATE_STATUS.COMPLETED,
        '★ 既有的列本來就代表「已經處理完」，必須回填成 COMPLETED');
    }
    // 而且它們必須真的還能擋掉重播。
    assert.equal((await db.claimTelegramUpdate(12, { owner: 'w1', now: NOW })).state, 'completed');
    assert.equal(summary.to, SCHEMA_VERSION);
  } finally {
    db.close();
    cleanup();
  }
});

test('★★★ R3-M-05 遷移: 重複跑 migrate 是冪等的（不會重複加欄位）', async () => {
  const { db, cleanup } = tempDb();
  try {
    await db.migrate();
    await db.claimTelegramUpdate(50, { owner: 'w1', leaseMs: 60_000, now: NOW });
    const before = (await db.raw.execute('SELECT * FROM telegram_processed_updates')).rows;

    const s2 = await db.migrate();
    const s3 = await db.migrate();

    assert.deepEqual(s2.columnsAdded ?? [], [], '★ 第二次不可以再加欄位');
    assert.deepEqual(s3.columnsAdded ?? [], []);
    assert.deepEqual(
      (await db.raw.execute('SELECT * FROM telegram_processed_updates')).rows, before,
      '★ 每一列都必須一模一樣',
    );
  } finally {
    db.close();
    cleanup();
  }
});

test('★★★ R3-M-05: workerId 每次建立都不一樣（重啟不可以認成上一輪的自己）', async () => {
  // owner 是「誰擁有這則訊息」的唯一依據，而「同一個 owner」是一條**特權**
  // 路徑：它可以直接接手一個租約還活著的 CLAIMED（那是 ambiguous commit 的
  // 復原機制）。所以 owner 必須真的能識別「這一個正在跑的 worker」：
  //   - 重啟後沿用同一個 id → 新的自己會被當成舊的自己
  //   - 兩個同時在跑的 worker 共用 id → 互相搶
  const owners = [];
  const fakeDb = {
    getUpdateOffset: async () => 0,
    setUpdateOffset: async () => true,
    claimTelegramUpdate: async (_id, o) => {
      owners.push(o?.owner ?? null);
      return { ok: false, state: 'completed' };
    },
  };
  for (let i = 0; i < 3; i += 1) {
    const p = createPoller({
      db: fakeDb,
      botToken: 'T',
      api: { async getUpdates() { return []; }, async sendMessage() { return {}; } },
      resolveUser: async () => null,
      handleMessage: async () => {},
    });
    await p.processBatch([update(100 + i)], 0);
  }

  assert.equal(owners.length, 3);
  for (const o of owners) {
    assert.ok(typeof o === 'string' && o.length > 0, '★ owner 不可以是空的');
  }
  assert.equal(new Set(owners).size, 3, '★ 每一個 worker 都必須有自己的身分');
});

test('★★ R3-M-05: 租約長度是明文政策', () => {
  assert.ok(Number.isInteger(TELEGRAM_BOT.CLAIM_LEASE_MS));
  assert.ok(TELEGRAM_BOT.CLAIM_LEASE_MS >= 60_000, '★ 太短會讓正常的兩次 LLM 呼叫做不完');
  assert.ok(TELEGRAM_BOT.CLAIM_LEASE_MS <= 30 * 60_000, '★ 太長會讓死掉的 worker 卡住太久');
});
