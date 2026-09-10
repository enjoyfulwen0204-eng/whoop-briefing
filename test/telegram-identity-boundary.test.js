/**
 * Telegram 身分邊界（H-01）。
 *
 * ## 修的是什麼
 *
 * 舊版只用 `msg.chat.id` 解析身分，完全不看**誰**送的訊息、也不看聊天室
 * 型態。只要有一個群組被綁定過（`/link` 在群組裡送出就會成功），群組裡
 * 任何一個人的訊息都會被解析成綁定者本人——可以讀他的生理資料、寫他的
 * Journal、看他的報告與長期規律。
 *
 * ## 現在的不變量
 *
 * 一個 Telegram 身分，**絕不可能**因為和別人同在一個群組，就取得對方的
 * 生理資料、Journal、報告、證據、長期規律、預測、Healthspan 或主動狀態。
 *
 * V1.1 沒有任何群組共享的產品模型，所以健康資料互動一律**私訊限定**。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createDb } from '../src/db.js';
import { createPoller } from '../src/bot/polling.js';
import { handleLinkAttempt } from '../src/bot/link.js';

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-ident-'));
  const db = createDb({ url: `file:${path.join(dir, 't.db')}` });
  return { db, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/** Alice 私訊 chat = 1001（Telegram 私訊：chat.id === from.id）；Bob = 1002。 */
const ALICE_CHAT = '1001';
const BOB_CHAT = '1002';
const GROUP_CHAT = '-100500';

/**
 * 直接寫進 DB 的「歷史遺留群組綁定」。
 *
 * 刻意**不**走 `db.linkTelegram()` —— R2-H-01 之後那條路會（正確地）拒絕
 * 群組目的地。真實情況也正是如此：這些列是舊版程式留下來的，不是現在的
 * 程式寫出來的。要測「已經存在的壞資料」就必須這樣造。
 */
async function seedLegacyGroupLink(db, chatId, userId) {
  await db.raw.execute({
    sql: `INSERT INTO user_telegram (telegram_chat_id, user_id, linked_at, status)
          VALUES (?, ?, ?, 'ACTIVE')`,
    args: [String(chatId), userId, '2026-01-01T00:00:00.000Z'],
  });
}

async function withUsers(fn) {
  const { db, cleanup } = tempDb();
  try {
    await db.migrate();
    await db.createUser({ id: 'u-alice', displayName: 'Alice' });
    await db.createUser({ id: 'u-bob', displayName: 'Bob' });
    await fn(db);
  } finally {
    db.close();
    cleanup();
  }
}

/** 一則真實形狀的 Telegram update。 */
function msg(updateId, {
  chatId, chatType = 'private', fromId = null, isBot = false, text = 'hi',
}) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      chat: { id: chatId, type: chatType },
      from: { id: fromId ?? chatId, is_bot: isBot, first_name: 'X' },
      text,
      date: 1,
    },
  };
}

/** 收集「哪些訊息真的被當成某個使用者處理了」。 */
function spyPoller(db, box, unlinkedBox = []) {
  return createPoller({
    db,
    botToken: 'T',
    api: { async getUpdates() { return []; }, async sendMessage() { return {}; } },
    resolveUser: (chatId) => db.resolveUserByChatId(chatId),
    handleMessage: async ({ text, chatId, user }) => {
      box.push({ text, chatId, userId: user.id });
    },
    handleUnlinked: async (a) => { unlinkedBox.push(a); },
  });
}

// ===========================================================================
// ★★★ 群組冒用
// ===========================================================================

test('★★★ H-01: 群組成員絕不會被解析成綁定者（即使群組曾被綁定）', async () => {
  await withUsers(async (db) => {
    // 直接把群組綁到 Alice（模擬舊資料 / 繞過 /link 的最壞情況）
    await seedLegacyGroupLink(db, GROUP_CHAT, 'u-alice');

    const handled = [];
    const poller = spyPoller(db, handled);
    // Bob 在那個群組裡發言
    await poller.processBatch([msg(1, {
      chatId: Number(GROUP_CHAT), chatType: 'supergroup', fromId: 777777,
      text: '我今天狀態怎樣？',
    })], 0);

    assert.deepEqual(handled, [], '★ 群組訊息絕不可以被當成任何使用者處理');
  });
});

test('★★★ H-01: 連綁定者本人在群組裡發言也不被授權（私訊限定）', async () => {
  await withUsers(async (db) => {
    await seedLegacyGroupLink(db, GROUP_CHAT, 'u-alice');
    const handled = [];
    const poller = spyPoller(db, handled);
    // from.id 就是 Alice 本人，但場合是群組
    await poller.processBatch([msg(1, {
      chatId: Number(GROUP_CHAT), chatType: 'group', fromId: Number(ALICE_CHAT),
    })], 0);
    assert.deepEqual(handled, [], '沒有群組共享模型 → 一律拒絕');
  });
});

test('★★★ H-01: 群組訊息完全不回覆（不洩漏 bot 綁了誰）', async () => {
  await withUsers(async (db) => {
    await seedLegacyGroupLink(db, GROUP_CHAT, 'u-alice');
    const handled = [];
    const unlinked = [];
    const poller = spyPoller(db, handled, unlinked);
    await poller.processBatch([msg(1, {
      chatId: Number(GROUP_CHAT), chatType: 'supergroup', fromId: 777777, text: '/link abc',
    })], 0);
    assert.deepEqual(handled, []);
    assert.deepEqual(unlinked, [], '連 /link 分支都不可以在群組裡被觸發');
  });
});

// ===========================================================================
// 寄件者綁定
// ===========================================================================

test('★★★ H-01: from.id 與 chat.id 不符 → 拒絕（偽造寄件者）', async () => {
  await withUsers(async (db) => {
    await db.linkTelegram({ chatId: ALICE_CHAT, userId: 'u-alice' });
    const handled = [];
    const poller = spyPoller(db, handled);
    // 宣稱是 Alice 的私訊，但寄件者是別人
    await poller.processBatch([msg(1, {
      chatId: Number(ALICE_CHAT), chatType: 'private', fromId: 999999,
    })], 0);
    assert.deepEqual(handled, []);
  });
});

test('★★ H-01: bot 送出的訊息一律拒絕', async () => {
  await withUsers(async (db) => {
    await db.linkTelegram({ chatId: ALICE_CHAT, userId: 'u-alice' });
    const handled = [];
    const poller = spyPoller(db, handled);
    await poller.processBatch([msg(1, {
      chatId: Number(ALICE_CHAT), chatType: 'private', isBot: true,
    })], 0);
    assert.deepEqual(handled, []);
  });
});

test('★★ H-01: 缺 from / 缺 chat.type 一律拒絕（fail-closed）', async () => {
  await withUsers(async (db) => {
    await db.linkTelegram({ chatId: ALICE_CHAT, userId: 'u-alice' });
    const poller = spyPoller(db, []);

    const noType = { update_id: 1, message: { chat: { id: Number(ALICE_CHAT) }, from: { id: Number(ALICE_CHAT) }, text: 'hi' } };
    const noFrom = { update_id: 2, message: { chat: { id: Number(ALICE_CHAT), type: 'private' }, text: 'hi' } };

    assert.equal((await poller.classify(noType)).kind, 'non_private_chat');
    assert.equal((await poller.classify(noFrom)).kind, 'sender_chat_mismatch');
  });
});

// ===========================================================================
// 正常私訊仍然完全可用
// ===========================================================================

test('★★ H-01: 合法的私訊仍然正常運作（沒有把功能鎖死）', async () => {
  await withUsers(async (db) => {
    await db.linkTelegram({ chatId: ALICE_CHAT, userId: 'u-alice' });
    const handled = [];
    const poller = spyPoller(db, handled);
    await poller.processBatch([msg(1, { chatId: Number(ALICE_CHAT), text: '我今天狀態怎樣？' })], 0);

    assert.equal(handled.length, 1);
    assert.equal(handled[0].userId, 'u-alice');
  });
});

// ===========================================================================
// ★★★ 多使用者再稽核：Alice / Bob / 一個群組 / 兩個私訊
// ===========================================================================

test('★★★ H-01 多使用者再稽核：兩個私訊 + 一個群組，零跨使用者存取', async () => {
  await withUsers(async (db) => {
    await db.linkTelegram({ chatId: ALICE_CHAT, userId: 'u-alice' });
    await db.linkTelegram({ chatId: BOB_CHAT, userId: 'u-bob' });
    await seedLegacyGroupLink(db, GROUP_CHAT, 'u-alice'); // 歷史遺留的群組綁定

    const handled = [];
    const poller = spyPoller(db, handled);
    await poller.processBatch([
      msg(1, { chatId: Number(ALICE_CHAT), text: 'alice private' }),
      msg(2, { chatId: Number(BOB_CHAT), text: 'bob private' }),
      // Bob 在 Alice 綁過的群組裡發言
      msg(3, { chatId: Number(GROUP_CHAT), chatType: 'supergroup', fromId: Number(BOB_CHAT), text: 'bob in group' }),
      // Alice 本人在群組裡發言
      msg(4, { chatId: Number(GROUP_CHAT), chatType: 'supergroup', fromId: Number(ALICE_CHAT), text: 'alice in group' }),
      // 有人假冒 Alice 的私訊
      msg(5, { chatId: Number(ALICE_CHAT), fromId: 424242, text: 'impersonation' }),
    ], 0);

    assert.deepEqual(
      handled.map((h) => [h.userId, h.text]),
      [['u-alice', 'alice private'], ['u-bob', 'bob private']],
      '★ 只有兩則真正的私訊被處理，而且各自歸屬正確',
    );
    // 沒有任何一則被歸給錯的人
    for (const h of handled) {
      if (h.chatId === ALICE_CHAT) assert.equal(h.userId, 'u-alice');
      if (h.chatId === BOB_CHAT) assert.equal(h.userId, 'u-bob');
    }
  });
});

// ===========================================================================
// 綁定步驟本身（縱深防禦）
// ===========================================================================

test('★★★ H-01: handleLinkAttempt 預設 fail-closed（沒傳旗標就拒絕綁定）', async () => {
  await withUsers(async (db) => {
    const { code } = await db.createLinkCode('u-alice', {});
    // 沒有 isPrivateChat → 必須拒絕，而且完全不回
    const reply = await handleLinkAttempt({ db, text: `/link ${code}`, chatId: GROUP_CHAT });
    assert.equal(reply, null);
    assert.equal(await db.getTelegramLink(GROUP_CHAT), null, '★ 群組絕不可以被綁定');
  });
});

test('★★★ H-01: 明確標為非私訊時拒絕綁定，且碼沒有被消耗', async () => {
  await withUsers(async (db) => {
    const { code } = await db.createLinkCode('u-alice', {});
    const reply = await handleLinkAttempt({
      db, text: `/link ${code}`, chatId: GROUP_CHAT, isPrivateChat: false,
    });
    assert.equal(reply, null);
    assert.equal(await db.getTelegramLink(GROUP_CHAT), null);

    // 同一組碼在私訊裡仍然可用 —— 群組嘗試不可以把碼燒掉
    const ok = await handleLinkAttempt({
      db, text: `/link ${code}`, chatId: ALICE_CHAT, isPrivateChat: true,
    });
    assert.match(ok, /綁定完成/);
    assert.equal((await db.getTelegramLink(ALICE_CHAT)).userId, 'u-alice');
  });
});

test('★★ H-01: 端到端——群組 /link 走完整 poller 之後仍然沒有任何綁定', async () => {
  await withUsers(async (db) => {
    const { code } = await db.createLinkCode('u-alice', {});
    const unlinked = [];
    const poller = createPoller({
      db,
      botToken: 'T',
      api: { async getUpdates() { return []; }, async sendMessage() { return {}; } },
      resolveUser: (chatId) => db.resolveUserByChatId(chatId),
      handleMessage: async () => {},
      handleUnlinked: async (a) => {
        unlinked.push(a);
        await handleLinkAttempt({ db, ...a });
      },
    });
    await poller.processBatch([msg(1, {
      chatId: Number(GROUP_CHAT), chatType: 'supergroup', fromId: 777777, text: `/link ${code}`,
    })], 0);

    assert.deepEqual(unlinked, [], 'handleUnlinked 根本不該被呼叫');
    assert.equal(await db.getTelegramLink(GROUP_CHAT), null);
  });
});
