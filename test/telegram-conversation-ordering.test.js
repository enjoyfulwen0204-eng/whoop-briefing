/**
 * 同一個對話的訊息順序（TG-R04）。
 *
 * ## 修的是什麼
 *
 * 排序身分以前是**內部 user_id**，而那要查資料庫才知道。於是有一段空窗：
 *
 *     N   認領 → （卡在 resolveUser 裡）……………… 對話欄位還是空的
 *     N+1 認領 → resolveUser 很快 → 寫下身分 → 進通道
 *              → 問「有沒有更早的還沒做完」→ **看不到 N** → 執行 → 先回覆
 *
 * 實測重現：執行順序 ["N+1", "N"]。對 Q&A、澄清狀態、Journal 對話都是錯的。
 *
 * ## 現在的順序
 *
 *     認領 → 寫下**對話鍵** → 進對話通道 → **才** resolveUser
 *
 * 對話鍵純粹從 Update 的結構推導（私訊 + 寄件者就是對方本人），不需要查任何
 * 東西，所以在認領的當下就能落地 —— 空窗因此不存在。
 *
 * 而且鍵是 chat 自己的 id，不是內部 user_id：一則偽造或未綁定的訊息只會鎖到
 * 它自己的對話，不可能鎖住別人的。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createDb } from '../src/db.js';
import { createRouter } from '../src/bot/router.js';
import { createSendReply } from '../src/bot/index.js';
import { createUpdateProcessor, UPDATE_OUTCOME, conversationKeyOf } from '../src/bot/updateProcessor.js';
import { TELEGRAM_BOT } from '../src/config.js';

const NOW = new Date('2026-09-11T06:00:00Z');

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgord-'));
  const db = createDb({ url: `file:${path.join(dir, 't.db')}` });
  return { db, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const upd = (id, chat, text) => ({
  update_id: id,
  message: {
    message_id: id, chat: { id: Number(chat), type: 'private' },
    from: { id: Number(chat), is_bot: false }, text, date: 1,
  },
});

/** 交易重跑會讓同一則的 handleMessage 被呼叫兩次；只看「順序」就要去掉相鄰重複。 */
const dedupeAdjacent = (a) => a.filter((v, i) => a[i - 1] !== v);

async function withEnv(fn, { resolveDelay = null } = {}) {
  const { db, cleanup } = tempDb();
  try {
    await db.migrate();
    const alice = await db.createUser({ displayName: 'Alice', timezone: 'Asia/Taipei' });
    const bob = await db.createUser({ displayName: 'Bob', timezone: 'Asia/Taipei' });
    await db.linkTelegram({ chatId: '5001', userId: alice.id });
    await db.linkTelegram({ chatId: '5002', userId: bob.id });

    const exec = [];
    const sent = [];
    const api = {
      async sendMessage(chatId, text) { sent.push({ chatId, text }); return { message_id: sent.length }; },
    };
    const router = createRouter({
      db,
      coachFor: () => ({ async ask() { return 'ok'; }, async json() { return null; } }),
      now: () => NOW,
    });
    // ★ 延遲放在 resolveUser 裡 —— 也就是身分落地**之前**，才是真正的 TG-R04 競態。
    const resolveUser = async (chatId) => {
      if (resolveDelay) await resolveDelay(chatId);
      return db.resolveUserByChatId(chatId);
    };
    const mk = (w) => createUpdateProcessor({
      db,
      resolveUser,
      handleMessage: async (m) => {
        exec.push(m.text);
        return router.handle({ text: m.text, chatId: m.chatId, user: m.user });
      },
      handleUnlinked: async () => null,
      sendReply: createSendReply({ db, api }),
      workerId: w, now: () => NOW, sleepImpl: async () => {},
    });
    await fn({ db, alice, bob, exec, sent, mk });
  } finally {
    db.close();
    cleanup();
  }
}

// ===========================================================================
// ★★★ Codex 重現：N 卡在 resolveUser 裡，N+1 很快
// ===========================================================================

test('★★★ TG-R04: N 卡在 resolveUser（身分未落地）→ N+1 不可以超車', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  let gated = false;

  await withEnv(async ({ exec, sent, mk }) => {
    const pN = mk('p1').processUpdate(upd(100, '5001', 'N'));
    await new Promise((r) => setTimeout(r, 40));   // 確保 N 先進場並卡住

    const rN1 = await mk('p2').processUpdate(upd(101, '5001', 'N+1'));
    assert.equal(rN1.outcome, UPDATE_OUTCOME.RETRY,
      '★ N 還沒完成，N+1 必須讓路');
    assert.deepEqual(dedupeAdjacent(exec), [],
      '★ N+1 不可以在 N 之前執行任何業務邏輯（N 這時還卡在 resolveUser）');

    release();
    await pN;

    // Telegram 重送被 503 的那一則
    const rN1b = await mk('p3').processUpdate(upd(101, '5001', 'N+1'));
    assert.equal(rN1b.outcome, UPDATE_OUTCOME.PROCESSED);

    assert.deepEqual(dedupeAdjacent(exec), ['N', 'N+1'], '★ 最終執行順序必須是 N → N+1');
    assert.deepEqual(sent.map((s) => s.chatId), ['5001', '5001']);
    assert.equal(sent.length, 2, '★ 各回一次');
  }, {
    resolveDelay: async () => { if (!gated) { gated = true; await gate; } },
  });
});

// ===========================================================================
// O1-O8
// ===========================================================================

test('★★★ O1: 同一對話，N 慢 N+1 快 → 順序仍是 N → N+1', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  let first = true;
  await withEnv(async ({ exec, mk }) => {
    const pN = mk('a').processUpdate(upd(200, '5001', 'N'));
    await new Promise((r) => setTimeout(r, 30));
    const r1 = await mk('b').processUpdate(upd(201, '5001', 'N+1'));
    assert.equal(r1.outcome, UPDATE_OUTCOME.RETRY);
    release();
    await pN;
    await mk('c').processUpdate(upd(201, '5001', 'N+1'));
    assert.deepEqual(dedupeAdjacent(exec), ['N', 'N+1']);
  }, { resolveDelay: async () => { if (first) { first = false; await gate; } } });
});

test('★★★ O2: 更早的那則是未綁定的 chat → 終局，不會餓死後面的訊息', async () => {
  await withEnv(async ({ db, exec, sent, mk }) => {
    // 9999 沒有綁定；它自己的對話鍵是 tg:9999，與 5001 無關
    const rUnknown = await mk('a').processUpdate(upd(300, '9999', '我是誰'));
    assert.equal(rUnknown.outcome, UPDATE_OUTCOME.PROCESSED);
    const row = await db.getTelegramUpdate(300);
    assert.equal(row.status, 'COMPLETED', '★ 未綁定也要到終局');
    assert.equal(sent.length, 0, '★ 未綁定一律不回');

    // 同一個未綁定對話的後續訊息不會被卡住
    const rNext = await mk('b').processUpdate(upd(301, '9999', '再問一次'));
    assert.equal(rNext.outcome, UPDATE_OUTCOME.PROCESSED);
    assert.deepEqual(exec, [], '★ 未綁定不進業務路由');
  });
});

test('★★★ O3: 更早的那則屬於被停用的使用者 → 不會永久擋住後面的訊息', async () => {
  await withEnv(async ({ db, alice, exec, mk }) => {
    await db.updateUser(alice.id, { status: 'DISABLED' });
    const rN = await mk('a').processUpdate(upd(400, '5001', 'N'));
    assert.equal(rN.outcome, UPDATE_OUTCOME.PROCESSED, '★ 要到終局');
    assert.equal((await db.getTelegramUpdate(400)).status, 'COMPLETED');

    const rN1 = await mk('b').processUpdate(upd(401, '5001', 'N+1'));
    assert.equal(rN1.outcome, UPDATE_OUTCOME.PROCESSED, '★ 後面的不可以被卡死');
    assert.deepEqual(exec, [], '★ 停用的使用者不進業務路由');
  });
});

test('★★★ O3b: 群組／寄件者不符的更早訊息根本不進通道（也就不可能擋路）', async () => {
  await withEnv(async ({ db, mk }) => {
    const group = upd(500, '5001', 'x');
    group.message.chat.id = -100500;
    group.message.chat.type = 'supergroup';
    assert.equal(conversationKeyOf(group), null, '★ 群組沒有對話鍵');

    const spoof = upd(501, '5001', 'x');
    spoof.message.from.id = 7777;
    assert.equal(conversationKeyOf(spoof), null, '★ 寄件者與 chat 不符沒有對話鍵');

    await mk('a').processUpdate(group);
    // 沒有對話鍵 → 沒有寫進任何對話 → 不會被算成「更早未完成」
    const r = await mk('b').processUpdate(upd(502, '5001', '正常訊息'));
    assert.equal(r.outcome, UPDATE_OUTCOME.PROCESSED);
    assert.equal((await db.getTelegramUpdate(500)).userId ?? null, null);
  });
});

test('★★★ O4: 不同對話互不等待（A 卡住不影響 B）', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  await withEnv(async ({ exec, mk }) => {
    const pA = mk('a').processUpdate(upd(600, '5001', 'A'));
    await new Promise((r) => setTimeout(r, 30));
    const rB = await mk('b').processUpdate(upd(601, '5002', 'B'));
    assert.equal(rB.outcome, UPDATE_OUTCOME.PROCESSED,
      '★ B 不可以被 A 的延遲拖住（update_id 更大也一樣）');
    release();
    await pA;
    assert.ok(dedupeAdjacent(exec).includes('B'));
  }, { resolveDelay: async (chatId) => { if (String(chatId) === '5001') await gate; } });
});

test('★★★ O5: 通道是 per-conversation，多個對話不互相排隊', async () => {
  const { db, cleanup } = tempDb();
  try {
    await db.migrate();
    const keys = [];
    for (let i = 0; i < 10; i += 1) {
      const u = await db.createUser({ displayName: `U${i}`, timezone: 'Asia/Taipei' });
      await db.linkTelegram({ chatId: String(7000 + i), userId: u.id });
      keys.push(`telegram_lane:tg:${7000 + i}`);
    }
    assert.equal(new Set(keys).size, 10, '★ 每個對話一把鎖');
    const owners = [];
    for (const k of keys) {
      const o = await db.acquireLock(k, { ttlMs: 300_000, now: NOW });
      assert.ok(o, `★ ${k} 不該被別人的鎖擋住`);
      owners.push({ k, o });
    }
    assert.equal(await db.acquireLock(keys[0], { ttlMs: 300_000, now: NOW }), null,
      '★ 同一個對話一次只能一則');
    for (const { k, o } of owners) await db.releaseLock(k, o);
  } finally {
    db.close();
    cleanup();
  }
});

test('★★★ O6: 澄清流程 —— 問題的狀態先落地，答案才讀得到', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  let first = true;
  await withEnv(async ({ exec, mk }) => {
    const pQ = mk('q').processUpdate(upd(800, '5001', '為什麼我這麼累'));
    await new Promise((r) => setTimeout(r, 30));
    const rA = await mk('a').processUpdate(upd(801, '5001', '昨天喝了兩杯'));
    assert.equal(rA.outcome, UPDATE_OUTCOME.RETRY,
      '★ 答案不可以在問題的狀態落地之前被處理');
    release();
    await pQ;
    await mk('a2').processUpdate(upd(801, '5001', '昨天喝了兩杯'));
    assert.deepEqual(dedupeAdjacent(exec), ['為什麼我這麼累', '昨天喝了兩杯']);
  }, { resolveDelay: async () => { if (first) { first = false; await gate; } } });
});

test('★★★ O7: 持有排序狀態的執行崩潰 → 租約過期後可以繼續', async () => {
  await withEnv(async ({ db, exec, mk }) => {
    // 模擬崩潰：認領 + 寫下對話鍵 + 鎖住通道，然後就死了（租約很短且早已過期）
    const past = new Date(NOW.getTime() - 3600_000);
    await db.claimTelegramUpdate(900, { owner: 'dead', leaseMs: 1_000, now: past });
    await db.setTelegramUpdateConversation(900, {
      owner: 'dead', conversationKey: 'tg:5001', now: past,
    });
    await db.acquireLock('telegram_lane:tg:5001', { ttlMs: 1_000, owner: 'dead', now: past });

    // 後面的訊息必須能繼續（租約都過期了，寬限期也過了）
    const r = await mk('fresh').processUpdate(upd(901, '5001', '之後的訊息'));
    assert.equal(r.outcome, UPDATE_OUTCOME.PROCESSED, '★ 崩潰不可以永久卡住這個對話');
    assert.deepEqual(dedupeAdjacent(exec), ['之後的訊息']);
  });
});

test('★★★ O8: 更早的那則走到 AMBIGUOUS 終局 → 後面的訊息不被永久擋住', async () => {
  await withEnv(async ({ db, mk }) => {
    const { TelegramApiError } = await import('../src/bot/api.js');
    const timeoutApi = {
      async sendMessage() {
        throw new TelegramApiError('timeout', { isNetwork: true, cause: { name: 'TimeoutError' } });
      },
    };
    const router = createRouter({
      db, coachFor: () => ({ async ask() { return 'ok'; }, async json() { return null; } }), now: () => NOW,
    });
    const amb = createUpdateProcessor({
      db,
      resolveUser: (c) => db.resolveUserByChatId(c),
      handleMessage: (m) => router.handle({ text: m.text, chatId: m.chatId, user: m.user }),
      sendReply: createSendReply({ db, api: timeoutApi }),
      workerId: 'amb', now: () => NOW, sleepImpl: async () => {},
    });
    const rN = await amb.processUpdate(upd(1000, '5001', 'N'));
    assert.equal(rN.outcome, UPDATE_OUTCOME.AMBIGUOUS_DELIVERY);
    assert.equal((await db.getTelegramUpdate(1000)).status, 'COMPLETED',
      '★ 模糊送達仍然是終局');

    const rN1 = await mk('next').processUpdate(upd(1001, '5001', 'N+1'));
    assert.equal(rN1.outcome, UPDATE_OUTCOME.PROCESSED, '★ 後面的訊息要能繼續');
  });
});

// ===========================================================================
// 對話鍵本身
// ===========================================================================

test('★★★ TG-R04 安全: 對話鍵只從結構推導，而且永遠不是內部 user_id', async () => {
  const ok = upd(1, '5001', '嗨');
  assert.equal(conversationKeyOf(ok), 'tg:5001');
  assert.match(conversationKeyOf(ok), /^tg:/, '★ 一定有前綴，不可能與內部 id 混淆');

  // 每一種不安全的形狀都沒有鍵 → 不進任何通道 → 鎖不住任何人
  const group = upd(2, '5001', 'x'); group.message.chat.type = 'group';
  const bot = upd(3, '5001', 'x'); bot.message.from.is_bot = true;
  const spoof = upd(4, '5001', 'x'); spoof.message.from.id = 999;
  const noText = upd(5, '5001', '   ');
  for (const [name, u] of [['group', group], ['bot', bot], ['spoof', spoof], ['noText', noText]]) {
    assert.equal(conversationKeyOf(u), null, `★ ${name} 不可以有對話鍵`);
  }
  assert.equal(conversationKeyOf({ update_id: 6 }), null);
  assert.equal(conversationKeyOf(null), null);

  // 文字內容不影響鍵（不信任任何使用者可控的內容）
  assert.equal(conversationKeyOf(upd(7, '5001', 'tg:9999')), 'tg:5001');
});

test('★★ TG-R04: 寬限期是明文政策，而且遠長於認領租約', () => {
  assert.ok(Number.isInteger(TELEGRAM_BOT.ORDER_BLOCK_GRACE_MS));
  assert.ok(TELEGRAM_BOT.ORDER_BLOCK_GRACE_MS > TELEGRAM_BOT.CLAIM_LEASE_MS,
    '★ 太短會讓正常的重送被當成「沒人在推進」而被超車');
  assert.ok(TELEGRAM_BOT.ORDER_BLOCK_GRACE_MS <= 6 * 3600_000,
    '★ 太長就等於永久餓死');
});
