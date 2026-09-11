/**
 * 送出回覆時的使用者綁定守衛（HRD-R03）。
 *
 * ## 修的是什麼
 *
 * 送出發生在動作交易**之外**，而且失敗會重送。從產生回覆到真的送出之間，
 * 綁定可能已經被撤銷、換綁到別人、或因為是群組列而被退役 —— 所以送出前
 * 要再確認一次這個 chat 現在仍然屬於當初產生這則回覆的使用者。
 *
 * 守衛本身是對的，錯的是它比較的那一層：
 *
 *     resolveUserByChatId() → { user, link }   ← 不是 user 本身
 *     舊版比的是 current?.id                    ← 這一層永遠是 undefined
 *
 * 於是 `undefined !== userId` 恆真，**每一則給已綁定使用者的回覆都被靜靜
 * 丟掉**。實測：正確綁定的使用者收到 0 則。
 *
 * `/link` 那條路走的是 `userId: null`，守衛整段被跳過，所以它一直是好的
 * —— 這就是為什麼這個 bug 躲得過冒煙測試。
 *
 * 這裡測的是**行為**（api.sendMessage 到底有沒有被呼叫），不是原始碼字串，
 * 所以之後任何一次「又比錯一層」都會讓這些測試紅掉。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createDb } from '../src/db.js';
import { createSendReply } from '../src/bot/index.js';

const CHAT = '555123456';   // 私訊 chat id 一定是正數（群組是負數）

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hrd03-'));
  const db = createDb({ url: `file:${path.join(dir, 't.db')}` });
  return { db, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/** 真的 DB + 假的 Telegram API。送出與否用 sent 陣列觀察。 */
async function withBot(fn) {
  const { db, cleanup } = tempDb();
  try {
    await db.migrate();
    const user = await db.createUser({ displayName: 'Kelvin', timezone: 'Asia/Taipei' });
    await db.linkTelegram({ chatId: CHAT, userId: user.id });
    const sent = [];
    const api = { async sendMessage(chatId, text) { sent.push({ chatId, text }); return { ok: true }; } };
    await fn({ db, user, sent, sendReply: createSendReply({ db, api }) });
  } finally {
    db.close();
    cleanup();
  }
}

// ===========================================================================
// A. 正確綁定的使用者 —— 一定要收得到
// ===========================================================================

test('★★★ HRD-R03 A: 正確綁定的使用者，回覆必須送出去', async () => {
  await withBot(async ({ user, sent, sendReply }) => {
    await sendReply({ chatId: CHAT, reply: '已記錄：啤酒 2 杯', userId: user.id });

    assert.equal(sent.length, 1,
      '★ 正確綁定的使用者不可以收不到回覆（舊版在這裡吞掉每一則）');
    assert.equal(sent[0].chatId, CHAT);
    assert.equal(sent[0].text, '已記錄：啤酒 2 杯');
  });
});

test('★★★ HRD-R03 D: 守衛比較的是 { user, link } 裡的 user.id', async () => {
  // 這一題直接盯住契約本身：回傳物件的**最外層沒有 id**。
  // 只要有人又改回去比外層，A 那個測試就會紅 —— 這裡把原因寫清楚。
  await withBot(async ({ db, user }) => {
    const resolved = await db.resolveUserByChatId(CHAT);
    assert.deepEqual(Object.keys(resolved).sort(), ['link', 'user'],
      '★ 契約是 { user, link }');
    assert.equal(resolved.id, undefined,
      '★ 最外層沒有 id —— 比這一層永遠不會相等');
    assert.equal(resolved.user.id, user.id,
      '★ 身分在 user.id');
  });
});

// ===========================================================================
// B. 換綁到別人 —— 絕對不可以送過去
// ===========================================================================

test('★★★ HRD-R03 B: chat 已經換綁給別人 → 不可以把前一個人的回覆送過去', async () => {
  await withBot(async ({ db, user, sent, sendReply }) => {
    // 產生回覆之後、送出之前，這個 chat 被重新綁給另一個人。
    const other = await db.createUser({ displayName: 'Someone', timezone: 'Asia/Taipei' });
    await db.revokeTelegramLink(CHAT);
    await db.linkTelegram({ chatId: CHAT, userId: other.id });

    await sendReply({ chatId: CHAT, reply: '你的 HRV 偏低', userId: user.id });

    assert.equal(sent.length, 0,
      '★ 絕不可以把一個人的生理資料送進現在屬於別人的 chat');
  });
});

test('★★★ HRD-R03 B2: 新的擁有者自己的回覆仍然送得出去', async () => {
  await withBot(async ({ db, sent, sendReply }) => {
    const other = await db.createUser({ displayName: 'Someone', timezone: 'Asia/Taipei' });
    await db.revokeTelegramLink(CHAT);
    await db.linkTelegram({ chatId: CHAT, userId: other.id });

    await sendReply({ chatId: CHAT, reply: '早安', userId: other.id });

    assert.equal(sent.length, 1, '★ 守衛只擋不相符的，不可以連對的也擋');
  });
});

// ===========================================================================
// C. 綁定不見了 —— fail closed
// ===========================================================================

test('★★★ HRD-R03 C: 綁定已被撤銷 → fail closed，不送', async () => {
  await withBot(async ({ db, user, sent, sendReply }) => {
    await db.revokeTelegramLink(CHAT);
    await sendReply({ chatId: CHAT, reply: '你的恢復是 65%', userId: user.id });
    assert.equal(sent.length, 0, '★ 解析不到就不可以送');
  });
});

test('★★★ HRD-R03 C2: 使用者被停用 → fail closed，不送', async () => {
  await withBot(async ({ db, user, sent, sendReply }) => {
    await db.updateUser(user.id, { status: 'DISABLED' });
    await sendReply({ chatId: CHAT, reply: '你的恢復是 65%', userId: user.id });
    assert.equal(sent.length, 0, '★ 使用者不是 ACTIVE 就不可以送');
  });
});

test('★★★ HRD-R03 C3: 完全不存在的 chat → fail closed，不送', async () => {
  await withBot(async ({ user, sent, sendReply }) => {
    await sendReply({ chatId: '888999', reply: '哈囉', userId: user.id });
    assert.equal(sent.length, 0);
  });
});

// ===========================================================================
// 未綁定路徑（/link）：守衛刻意跳過
// ===========================================================================

test('★★ HRD-R03: userId 為 null（/link 回覆）時守衛跳過，訊息照送', async () => {
  await withBot(async ({ sent, sendReply }) => {
    // 這條路徑本來就沒有「屬於誰」可言 —— 它就是還沒綁定的人在試著綁定。
    // 舊版之所以看起來正常，正是因為只有這條路會被走到。
    await sendReply({ chatId: '888999', reply: '綁定成功', userId: null });
    assert.equal(sent.length, 1);
  });
});
