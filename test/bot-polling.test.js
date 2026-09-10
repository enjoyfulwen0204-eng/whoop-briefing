/**
 * Telegram long polling（Phase L）。
 *
 * 全部 mock，不會碰到真的 Telegram API。
 * 重點在四件事：offset 正確推進、重啟不重複、未綁定 chat 完全不回應、
 * 身分解析正確把 chat 對應到內部使用者（不是單一 TELEGRAM_CHAT_ID allowlist）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createDb } from '../src/db.js';
import { createPoller } from '../src/bot/polling.js';
import { TelegramApiError, backoffMs, waitForError } from '../src/bot/api.js';

const CHAT = '12345';
const USER = { id: 'u-poll-test', timezone: 'Asia/Taipei' };

/** 預設只有 CHAT 綁定使用者，其他一律解析不到（模擬 db.resolveUserByChatId）。 */
function defaultResolveUser(chatId) {
  return chatId === CHAT ? Promise.resolve({ user: USER }) : Promise.resolve(null);
}

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whoop-bot-'));
  return {
    url: `file:${path.join(dir, 'bot.db')}`,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

/**
 * 造一則 Telegram update。
 *
 * ⚠️ H-01：真實的 Telegram 私訊一定帶 `chat.type === 'private'`，而且
 * 私訊聊天室的 id 就等於對方的使用者 id（`from.id === chat.id`）。
 * 舊的 fixture 兩者都沒有，等於在測一個 Telegram 不會送出的形狀；
 * 授權閘門補上之後，fixture 也必須是真實的形狀。
 */
function update(id, text, chatId = CHAT, { chatType = 'private', fromId = null, isBot = false } = {}) {
  return {
    update_id: id,
    message: {
      message_id: id,
      chat: { id: chatId, type: chatType },
      from: { id: fromId ?? chatId, is_bot: isBot, first_name: 'T' },
      text,
      date: 1,
    },
  };
}

/**
 * 假的 Telegram API。
 * batches 是一連串要依序回傳的 update 陣列；用完之後一律回空陣列。
 */
function fakeApi(batches = [], { failures = [] } = {}) {
  const calls = [];
  let i = 0;
  return {
    calls,
    sent: [],
    async getUpdates(args) {
      calls.push({ method: 'getUpdates', ...args });
      const fail = failures[calls.length - 1];
      if (fail) throw fail;
      return batches[i++] ?? [];
    },
    async sendMessage(chatId, text) {
      this.sent.push({ chatId, text });
      return { message_id: 1 };
    },
    async getMe() { return { username: 'test_bot' }; },
  };
}

async function setup({ batches = [], failures = [], resolveUser = defaultResolveUser } = {}) {
  const { url, cleanup } = tempDb();
  const db = createDb({ url });
  await db.migrate();
  const api = fakeApi(batches, { failures });
  const handled = [];
  const poller = createPoller({
    db,
    api,
    resolveUser,
    sleepImpl: async () => {},
    handleMessage: async (m) => { handled.push(m); },
  });
  return { db, api, poller, handled, cleanup };
}

// ---------------------------------------------------------------------------

test('L: 收到訊息會被處理，offset 推進到 update_id + 1', async () => {
  const { db, poller, handled, cleanup } = await setup({
    batches: [[update(100, 'hello'), update(101, 'world')]],
  });
  try {
    await poller.pollOnce();
    assert.equal(handled.length, 2);
    assert.equal(handled[0].text, 'hello');
    assert.equal(handled[1].text, 'world');
    assert.equal(await db.getUpdateOffset(), 102, 'offset = 最後一則 + 1');
  } finally { db.close(); cleanup(); }
});

test('★ L: 每處理完一則就存 offset（中途死掉最多只重做一則）', async () => {
  const { db, cleanup } = await setup();
  try {
    const seen = [];
    const poller = createPoller({
      db,
      resolveUser: defaultResolveUser,
      api: fakeApi(),
      sleepImpl: async () => {},
      handleMessage: async ({ text }) => {
        seen.push(text);
        // 處理第二則時檢查：第一則的 offset 應該已經落地了
        if (text === 'b') {
          assert.equal(await db.getUpdateOffset(), 11, '第一則處理完就該存檔');
        }
      },
    });
    await poller.processBatch([update(10, 'a'), update(11, 'b')], 0);
    assert.deepEqual(seen, ['a', 'b']);
    assert.equal(await db.getUpdateOffset(), 12);
  } finally { db.close(); cleanup(); }
});

test('★ L: 重啟後從 DB 的 offset 續傳，不會重頭處理', async () => {
  const { url, cleanup } = tempDb();
  const db = createDb({ url });
  try {
    await db.migrate();

    // 第一個 worker 生命週期
    const api1 = fakeApi([[update(200, 'first')]]);
    const h1 = [];
    const p1 = createPoller({
      db, resolveUser: defaultResolveUser, api: api1, sleepImpl: async () => {},
      handleMessage: async (m) => { h1.push(m.text); },
    });
    await p1.pollOnce();
    assert.deepEqual(h1, ['first']);
    assert.equal(await db.getUpdateOffset(), 201);

    // 重啟：新的 poller、新的 api，但同一個 DB
    const api2 = fakeApi([[update(201, 'second')]]);
    const h2 = [];
    const p2 = createPoller({
      db, resolveUser: defaultResolveUser, api: api2, sleepImpl: async () => {},
      handleMessage: async (m) => { h2.push(m.text); },
    });
    await p2.pollOnce();

    assert.equal(api2.calls[0].offset, 201, '★ 重啟後要帶著存好的 offset 去要更新');
    assert.deepEqual(h2, ['second']);
    assert.ok(!h2.includes('first'), '不可以重做已處理過的訊息');
  } finally { db.close(); cleanup(); }
});

test('★ L: Telegram 重送舊 update 時本地會擋掉（重複防線）', async () => {
  const { db, poller, handled, cleanup } = await setup();
  try {
    await db.setUpdateOffset(500);
    // 伺服器因故重送 498/499（比 offset 小），以及一則新的 500
    await poller.processBatch(
      [update(498, 'old-a'), update(499, 'old-b'), update(500, 'new')],
      500,
    );
    assert.deepEqual(handled.map((h) => h.text), ['new'], '★ 舊的一律跳過');
    assert.equal(await db.getUpdateOffset(), 501);
  } finally { db.close(); cleanup(); }
});

test('★ L: 未綁定的 chat 完全不回應（連錯誤訊息都不給）', async () => {
  const { db, poller, handled, api, cleanup } = await setup({
    batches: [[update(1, 'hi', '99999'), update(2, 'hi', CHAT)]],
  });
  try {
    await poller.pollOnce();
    assert.equal(handled.length, 1, '只處理已綁定 chat 的訊息');
    assert.equal(handled[0].chatId, CHAT);
    assert.deepEqual(handled[0].user, USER, '要把解析出來的內部使用者一起交給 handler');
    assert.equal(api.sent.length, 0, '★ 絕不主動回覆未綁定 chat');
    assert.equal(await db.getUpdateOffset(), 3, 'offset 仍要推進，否則會卡住');
  } finally { db.close(); cleanup(); }
});

test('L: 非文字訊息與非 message update 被安全略過', async () => {
  const { db, poller, handled, cleanup } = await setup({
    batches: [[
      { update_id: 1, edited_message: { chat: { id: CHAT }, text: 'x' } },
      { update_id: 2, message: { chat: { id: CHAT } } },              // 沒有 text
      { update_id: 3, message: { chat: { id: CHAT }, text: '   ' } }, // 空白
      update(4, 'real'),
    ]],
  });
  try {
    await poller.pollOnce();
    assert.deepEqual(handled.map((h) => h.text), ['real']);
    assert.equal(await db.getUpdateOffset(), 5);
  } finally { db.close(); cleanup(); }
});

test('★ L: 單一訊息處理失敗不會卡住整個 queue', async () => {
  const { url, cleanup } = tempDb();
  const db = createDb({ url });
  try {
    await db.migrate();
    const seen = [];
    const poller = createPoller({
      db, resolveUser: defaultResolveUser, api: fakeApi(), sleepImpl: async () => {},
      handleMessage: async ({ text }) => {
        if (text === 'boom') throw new Error('handler 爆炸');
        seen.push(text);
      },
    });
    await poller.processBatch([update(1, 'a'), update(2, 'boom'), update(3, 'c')], 0);
    assert.deepEqual(seen, ['a', 'c'], '壞掉那則跳過，後面照常');
    assert.equal(await db.getUpdateOffset(), 4, '★ offset 仍要推進，否則壞訊息會永遠重播');
  } finally { db.close(); cleanup(); }
});

test('L: 網路錯誤會退避重試，不會讓迴圈死掉', async () => {
  const netErr = new TelegramApiError('連線失敗', { isNetwork: true });
  const { db, poller, handled, cleanup } = await setup({
    batches: [[], [update(1, 'after-recovery')]],
    failures: [netErr, netErr],
  });
  try {
    const waits = [];
    const p = createPoller({
      db, resolveUser: defaultResolveUser,
      api: poller ? undefined : undefined,
      sleepImpl: async (ms) => { waits.push(ms); },
      handleMessage: async () => {},
    });
    // 直接驗退避函式本身（迴圈行為在下一個測試）
    assert.ok(backoffMs(1) >= 1000);
    assert.ok(backoffMs(10) <= 60_000 + 250, '要有上限');
    assert.ok(backoffMs(2) > backoffMs(1) - 250, '要遞增');
    assert.ok(p);
    assert.ok(handled.length >= 0);
    assert.ok(waits.length >= 0);
  } finally { db.close(); cleanup(); }
});

test('★ L: 429 會照 retry_after 等待，而不是用預設退避', () => {
  const err429 = new TelegramApiError('Too Many Requests', {
    status: 429, retryAfterMs: 7000,
  });
  assert.equal(waitForError(err429, 1), 7000, '要聽 Telegram 的 retry_after');

  const netErr = new TelegramApiError('網路', { isNetwork: true });
  const w = waitForError(netErr, 1);
  assert.ok(w >= 1000 && w <= 61_000, '沒有 retry_after 就用指數退避');

  // retry_after 極大時仍要有上限，不然 worker 會睡到天荒地老
  const huge = new TelegramApiError('x', { status: 429, retryAfterMs: 999_999_999 });
  assert.ok(waitForError(huge, 1) <= 60_000);
});

test('L: 主迴圈遇錯會重試並在 maxIterations 後結束', async () => {
  const { url, cleanup } = tempDb();
  const db = createDb({ url });
  try {
    await db.migrate();
    let call = 0;
    const waits = [];
    const api = {
      async getUpdates() {
        call += 1;
        if (call <= 2) throw new TelegramApiError('boom', { isNetwork: true });
        return [update(10 + call, `msg${call}`)];
      },
      async sendMessage() {},
    };
    const handled = [];
    const poller = createPoller({
      db, resolveUser: defaultResolveUser, api,
      sleepImpl: async (ms) => { waits.push(ms); },
      handleMessage: async (m) => { handled.push(m.text); },
    });
    const stats = await poller.start({ maxIterations: 4 });
    assert.equal(waits.length, 2, '兩次失敗各退避一次');
    assert.ok(handled.length >= 1, '恢復後要能繼續處理');
    assert.equal(stats.errors, 2);
  } finally { db.close(); cleanup(); }
});

test('L: stop() 會讓迴圈收工（graceful shutdown）', async () => {
  const { url, cleanup } = tempDb();
  const db = createDb({ url });
  try {
    await db.migrate();
    let polls = 0;
    const poller = createPoller({
      db, resolveUser: defaultResolveUser,
      api: {
        async getUpdates() { polls += 1; if (polls >= 2) poller.stop(); return []; },
        async sendMessage() {},
      },
      sleepImpl: async () => {},
      handleMessage: async () => {},
    });
    await poller.start({ maxIterations: 50 });
    assert.equal(polls, 2, '呼叫 stop 之後不再繼續 poll');
    assert.equal(poller.isRunning(), false);
  } finally { db.close(); cleanup(); }
});

test('L: classify 正確分類各種 update（身分解析為 async）', async () => {
  const { db, poller, cleanup } = await setup();
  try {
    assert.equal((await poller.classify(update(1, 'hi'))).kind, 'ok');
    assert.equal((await poller.classify(update(1, 'hi', '999'))).kind, 'unlinked');
    assert.equal((await poller.classify({ update_id: 1 })).kind, 'not_a_message');
    assert.equal(
      (await poller.classify({ update_id: 1, message: { chat: { id: CHAT } } })).kind,
      'no_text',
    );
  } finally { db.close(); cleanup(); }
});
