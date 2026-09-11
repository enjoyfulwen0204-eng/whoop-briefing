/**
 * Telegram 入站 webhook（正式環境的傳輸方式）。
 *
 * ## 這一輪換掉的是什麼
 *
 * 只有**傳輸**：getUpdates 長輪詢 → webhook HTTP POST。
 * 「收到一則 update 之後要做什麼」一行都沒有改，polling 與 webhook 共用
 * updateProcessor.js 的同一份實作。
 *
 * ## 所以測試的重點在兩件事
 *
 *   1. 這個端點是**公開可達**的 —— 認證、體積、格式都必須在業務處理之前擋下來。
 *   2. Telegram **會重送** —— 重送不可以產生第二次副作用，也不可以回覆兩次。
 *
 * 這裡用真的 DB、真的 updateProcessor、真的 router，只有 Telegram API 是假的
 * （觀察它到底有沒有被呼叫、被呼叫幾次）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

import { createDb } from '../src/db.js';
import { createRouter } from '../src/bot/router.js';
import { createSendReply } from '../src/bot/index.js';
import { createUpdateProcessor } from '../src/bot/updateProcessor.js';
import {
  createWebhookHandler, createWebhookServer, secretMatches, looksLikeUpdate,
} from '../src/bot/webhook.js';
import { TELEGRAM_BOT } from '../src/config.js';

const SECRET = 'test-webhook-secret-value';
const PATH_ = TELEGRAM_BOT.WEBHOOK_PATH;
const NOW = new Date('2026-09-11T06:00:00Z');

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgwh-'));
  const db = createDb({ url: `file:${path.join(dir, 't.db')}` });
  return { db, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const update = (id, chat, text = '昨天睡得好嗎') => ({
  update_id: id,
  message: {
    message_id: id, chat: { id: Number(chat), type: 'private' },
    from: { id: Number(chat), is_bot: false }, text, date: 1,
  },
});

/** 真 DB + 真 processor + 假 Telegram API。 */
async function withWebhook(fn, { coachReply = '好的', coachThrows = false, sendThrows = false } = {}) {
  const { db, cleanup } = tempDb();
  try {
    await db.migrate();
    const alice = await db.createUser({ displayName: 'Alice', timezone: 'Asia/Taipei' });
    const bob = await db.createUser({ displayName: 'Bob', timezone: 'Asia/Taipei' });
    await db.linkTelegram({ chatId: '5001', userId: alice.id });
    await db.linkTelegram({ chatId: '5002', userId: bob.id });

    const sent = [];
    const aiCalls = [];
    const api = {
      async sendMessage(chatId, text) {
        if (sendThrows) throw new Error('telegram send failed');
        sent.push({ chatId, text });
        return { ok: true };
      },
    };
    const coachFor = (userId) => ({
      async ask(...a) {
        aiCalls.push(userId);
        if (coachThrows) throw new Error('openrouter down');
        return coachReply;
      },
      async json() {
        aiCalls.push(userId);
        if (coachThrows) throw new Error('openrouter down');
        // 與既有 Telegram 測試同一組解析結果，這樣「有沒有重複寫 journal」
        // 才是真的在測動作去重，而不是在測一個什麼都沒做的路徑。
        return {
          asserted: true, about_self: true, negated: false, hypothetical: false,
          category: 'alcohol', subtype: 'beer', numeric_value: 2,
          unit: 'cup', confidence: 0.9,
        };
      },
    });
    const router = createRouter({ db, coachFor, now: () => NOW });
    const processor = createUpdateProcessor({
      db,
      resolveUser: (chatId) => db.resolveUserByChatId(chatId),
      handleMessage: ({ text, chatId, user }) => router.handle({ text, chatId, user }),
      handleUnlinked: async () => null,
      sendReply: createSendReply({ db, api }),
      workerId: 'test-worker',
      now: () => NOW,
      sleepImpl: async () => {},
    });
    const handle = createWebhookHandler({ processUpdate: processor.processUpdate, secret: SECRET });

    await fn({
      db, alice, bob, sent, aiCalls, handle, processor,
      post: (body, { secret = SECRET, path: p = PATH_, method = 'POST' } = {}) =>
        invoke(handle, { method, path: p, secret, body }),
      get: (p) => invoke(handle, { method: 'GET', path: p, secret: null, body: null }),
    });
  } finally {
    db.close();
    cleanup();
  }
}

/** 直接餵假的 req/res，不用真的綁 port。 */
function invoke(handle, { method, path: p, secret, body }) {
  const payload = body === null || body === undefined
    ? null
    : (typeof body === 'string' ? body : JSON.stringify(body));
  const req = {
    method,
    url: p,
    headers: secret === null ? {} : { 'x-telegram-bot-api-secret-token': secret },
    _handlers: {},
    on(ev, cb) { this._handlers[ev] = cb; return this; },
    pause() { this.paused = true; },
    destroy() { this.destroyed = true; },
  };
  const res = {
    statusCode: null, headers: null, body: '', headersSent: false, _finish: [],
    on(ev, cb) { if (ev === 'finish') this._finish.push(cb); return this; },
    writeHead(s, h) { this.statusCode = s; this.headers = h; this.headersSent = true; },
    end(b) { this.body = b ?? ''; this.done = true; this._finish.forEach((f) => f()); },
  };
  const p2 = handle(req, res);
  // 串流要在 handler 開始監聽之後才餵
  setImmediate(() => {
    if (payload !== null && req._handlers.data) req._handlers.data(Buffer.from(payload, 'utf8'));
    if (req._handlers.end) req._handlers.end();
  });
  return p2.then(() => ({
    status: res.statusCode,
    json: (() => { try { return JSON.parse(res.body); } catch { return null; } })(),
  }));
}

const journalCount = async (db, userId) => (await db.getJournalEvents(userId, {
  from: '2026-09-01', to: '2026-09-30', limit: 100,
})).length;

// ===========================================================================
// 1. /health
// ===========================================================================

test('★★ webhook: GET /health 回最小狀態，不碰 DB、不吐內部資訊', async () => {
  await withWebhook(async ({ get, db }) => {
    let touched = 0;
    const spy = { ...db, raw: { execute: async (...a) => { touched += 1; return db.raw.execute(...a); } } };
    assert.ok(spy);
    const r = await get('/health');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { ok: true, service: 'telegram-webhook' });
    const text = JSON.stringify(r.json);
    for (const leak of ['5001', '5002', 'turso', 'token', 'secret', 'user_id']) {
      assert.ok(!text.toLowerCase().includes(leak), `不可以出現 ${leak}`);
    }
  });
});

// ===========================================================================
// 2-4. 祕密驗證
// ===========================================================================

test('★★★ webhook: 正確的 secret → 處理', async () => {
  await withWebhook(async ({ post, sent }) => {
    const r = await post(update(100, '5001'));
    assert.equal(r.status, 200);
    assert.equal(sent.length, 1, '★ 有回覆送出');
  });
});

test('★★★ webhook: 缺少 secret → 401，而且**完全不處理**', async () => {
  await withWebhook(async ({ post, sent, db, alice }) => {
    const r = await post(update(100, '5001'), { secret: null });
    assert.equal(r.status, 401);
    assert.equal(sent.length, 0, '★ 不可以回覆');
    assert.equal(await journalCount(db, alice.id), 0, '★ 不可以有任何副作用');
    const row = await db.getTelegramUpdate(100);
    assert.equal(row, null, '★ 連認領都不可以發生（驗證在業務處理之前）');
  });
});

test('★★★ webhook: 錯誤的 secret → 401，而且完全不處理', async () => {
  await withWebhook(async ({ post, sent, db }) => {
    const r = await post(update(100, '5001'), { secret: 'wrong-secret-value-xx' });
    assert.equal(r.status, 401);
    assert.equal(sent.length, 0);
    assert.equal(await db.getTelegramUpdate(100), null);
  });
});

test('★★★ webhook: secret 比較是定長的，而且長度不同直接拒絕', () => {
  assert.equal(secretMatches('abc', 'abc'), true);
  assert.equal(secretMatches('abc', 'abd'), false);
  assert.equal(secretMatches('abc', 'abcd'), false, '★ 長度不同不可以丟例外');
  assert.equal(secretMatches('', ''), false, '★ 空的一律不通過');
  assert.equal(secretMatches(undefined, 'abc'), false);
  assert.equal(secretMatches('abc', undefined), false);
});

// ===========================================================================
// 5-7. 格式與體積
// ===========================================================================

test('★★★ webhook: 壞掉的 JSON → 400，不處理', async () => {
  await withWebhook(async ({ post, sent }) => {
    const r = await post('{"update_id": 這不是 json', {});
    assert.equal(r.status, 400);
    assert.equal(sent.length, 0);
  });
});

test('★★★ webhook: 過大的請求 → 413，而且不繼續累積內容', async () => {
  await withWebhook(async ({ handle }) => {
    const big = 'x'.repeat(TELEGRAM_BOT.WEBHOOK_MAX_BODY_BYTES + 1024);
    const r = await invoke(handle, {
      method: 'POST', path: PATH_, secret: SECRET, body: big,
    });
    assert.equal(r.status, 413);
  });
});

test('★★ webhook: 不是 Update 結構 → 200（重送也不會變好），但不處理', async () => {
  await withWebhook(async ({ post, sent }) => {
    for (const body of [{}, { hello: 'world' }, [1, 2, 3], { update_id: 'abc' }]) {
      const r = await post(body);
      assert.equal(r.status, 200, `${JSON.stringify(body)} 應該被 ack 掉`);
      assert.equal(r.json.outcome, 'invalid');
    }
    assert.equal(sent.length, 0);
  });
});

test('★★ webhook: 不支援的 update 型別（沒有 message）→ ack、不回覆', async () => {
  await withWebhook(async ({ post, sent }) => {
    const r = await post({ update_id: 300, edited_message: { chat: { id: 5001 } } });
    assert.equal(r.status, 200);
    assert.equal(r.json.outcome, 'ignored');
    assert.equal(sent.length, 0);
  });
});

test('★★ webhook: 路徑與方法', async () => {
  await withWebhook(async ({ post, get, handle }) => {
    assert.equal((await post(update(1, '5001'), { path: '/nope' })).status, 404);
    assert.equal((await post(update(1, '5001'), { method: 'GET' })).status, 405);
    assert.equal((await invoke(handle, {
      method: 'POST', path: '/health', secret: null, body: null,
    })).status, 405);
    assert.equal((await get('/health')).status, 200);
  });
});

// ===========================================================================
// 8-10. 使用者解析
// ===========================================================================

test('★★★ webhook: 已綁定的使用者 → Q&A 路徑、有回覆', async () => {
  await withWebhook(async ({ post, sent, aiCalls, alice }) => {
    const r = await post(update(100, '5001'));
    assert.equal(r.status, 200);
    assert.equal(r.json.outcome, 'processed');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].chatId, '5001');
    assert.ok(aiCalls.every((u) => u === alice.id), '★ AI 只能以 Alice 的身分被呼叫');
  });
});

test('★★★ webhook: 未綁定的 chat → 完全不回覆、不寫任何東西', async () => {
  await withWebhook(async ({ post, sent, db }) => {
    const r = await post(update(100, '9999'));
    assert.equal(r.status, 200);
    assert.equal(sent.length, 0, '★ 未綁定一律靜默');
    assert.equal(await journalCount(db, 'u-nobody').catch(() => 0), 0);
  });
});

test('★★★ webhook: 綁定被撤銷 → fail closed，不回覆', async () => {
  await withWebhook(async ({ post, sent, db }) => {
    await db.revokeTelegramLink('5001');
    const r = await post(update(100, '5001'));
    assert.equal(r.status, 200);
    assert.equal(sent.length, 0);
  });
});

test('★★★ webhook: 使用者被停用 → fail closed，不回覆', async () => {
  await withWebhook(async ({ post, sent, db, alice }) => {
    await db.updateUser(alice.id, { status: 'DISABLED' });
    const r = await post(update(100, '5001'));
    assert.equal(r.status, 200);
    assert.equal(sent.length, 0);
  });
});

test('★★★ webhook: 群組訊息一律拒絕（H-01）', async () => {
  await withWebhook(async ({ post, sent }) => {
    const u = update(100, '5001');
    u.message.chat.id = -100500;
    u.message.chat.type = 'supergroup';
    const r = await post(u);
    assert.equal(r.status, 200);
    assert.equal(sent.length, 0, '★ 私人生理資料絕不進群組');
  });
});

test('★★★ webhook: 寄件者與 chat 不符一律拒絕（H-01）', async () => {
  await withWebhook(async ({ post, sent }) => {
    const u = update(100, '5001');
    u.message.from.id = 7777;   // 別人冒用
    const r = await post(u);
    assert.equal(r.status, 200);
    assert.equal(sent.length, 0);
  });
});

// ===========================================================================
// 11-14. 重送 / 去重（webhook 的核心風險）
// ===========================================================================

test('★★★ webhook: 同一個 update_id 送兩次 → 只處理一次、只回覆一次', async () => {
  await withWebhook(async ({ post, sent, db, alice }) => {
    const a = await post(update(100, '5001', '喝了兩杯'));
    const b = await post(update(100, '5001', '喝了兩杯'));

    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(b.json.outcome, 'replayed', '★ 第二次必須被認出是重播');
    assert.equal(sent.length, 1, '★ 絕不可以回覆兩次');
    assert.equal(await journalCount(db, alice.id), 1, '★ 絕不可以寫兩筆 journal');
  });
});

test('★★★ webhook: 同一實例併發同一個 update_id → 合流成一次，只回覆一次', async () => {
  // Telegram 可能在第一個請求還沒回應時就重送，於是同一個實例同時處理同一則。
  // 兩邊帶同一個 workerId，而同一個 owner 重複認領在耐久層是合法的「續租」，
  // 所以兩邊都會往下走 —— 動作不會做兩次（收據擋住），但回覆會送兩次。
  // processUpdate 的 in-process 合流就是為了這個。
  await withWebhook(async ({ post, sent, db, alice }) => {
    const [a, b] = await Promise.all([
      post(update(100, '5001', '喝了兩杯')),
      post(update(100, '5001', '喝了兩杯')),
    ]);
    // 兩邊都可以誠實地說「這一則已經被耐久地處理掉了」。
    assert.deepEqual([a.status, b.status], [200, 200]);
    assert.equal(sent.length, 1, '★ 絕不可以回覆兩次');
    assert.equal(await journalCount(db, alice.id), 1, '★ 絕不可以寫兩筆');
  });
});

test('★★★ webhook: 跨實例併發同一個 update_id → 只有一個能處理，另一個要重送', async () => {
  // 不同實例 = 不同 workerId，這時候擋下來的是 DB 的原子認領，不是記憶體。
  await withWebhook(async ({ post, sent, db }) => {
    await db.claimTelegramUpdate(100, { owner: 'other-instance', leaseMs: 300_000, now: NOW });
    const r = await post(update(100, '5001', '喝了兩杯'));
    assert.equal(r.status, 503, '★ 別人正握著所有權就不可以 ack');
    assert.equal(sent.length, 0);
  });
});

test('★★★ webhook: 已完成的重播不會重跑動作，也不會重新呼叫 AI', async () => {
  await withWebhook(async ({ post, aiCalls, sent }) => {
    await post(update(100, '5001'));
    const before = aiCalls.length;
    const r = await post(update(100, '5001'));
    assert.equal(r.json.outcome, 'replayed');
    assert.equal(aiCalls.length, before, '★ 重播不可以再打一次 OpenRouter');
    assert.equal(sent.length, 1);
  });
});

test('★★★ webhook: 內部暫時性失敗 → 503（讓 Telegram 重送），不是假裝成功', async () => {
  await withWebhook(async ({ post, sent, db }) => {
    // 別人正握著這一則的認領（模擬另一個實例正在處理）
    await db.claimTelegramUpdate(100, { owner: 'someone-else', leaseMs: 300_000, now: NOW });
    const r = await post(update(100, '5001'));
    assert.equal(r.status, 503, '★ 拿不到所有權就不可以 ack');
    assert.equal(r.json.ok, false);
    assert.equal(sent.length, 0);
  });
});

test('★★★ webhook: 認領機制壞掉 → 503，完全沒有副作用', async () => {
  const { db, cleanup } = tempDb();
  try {
    await db.migrate();
    const u = await db.createUser({ displayName: 'A', timezone: 'Asia/Taipei' });
    await db.linkTelegram({ chatId: '5001', userId: u.id });
    const sent = [];
    const broken = { ...db, claimTelegramUpdate: async () => { throw new Error('claim table gone'); } };
    const router = createRouter({ db, coachFor: () => ({ async ask() { return 'hi'; }, async json() { return null; } }), now: () => NOW });
    const processor = createUpdateProcessor({
      db: broken,
      resolveUser: (c) => db.resolveUserByChatId(c),
      handleMessage: ({ text, chatId, user }) => router.handle({ text, chatId, user }),
      sendReply: createSendReply({ db, api: { async sendMessage(c, t) { sent.push({ c, t }); } } }),
      workerId: 'w', now: () => NOW, sleepImpl: async () => {},
    });
    const handle = createWebhookHandler({ processUpdate: processor.processUpdate, secret: SECRET });
    const r = await invoke(handle, { method: 'POST', path: PATH_, secret: SECRET, body: update(100, '5001') });
    assert.equal(r.status, 503);
    assert.equal(sent.length, 0, '★ 不確定有沒有人在處理時，正確行為是不處理');
  } finally {
    db.close();
    cleanup();
  }
});

test('★★★ webhook: Telegram 送出失敗 → 503，而且不標記完成（可以重送）', async () => {
  await withWebhook(async ({ post, db }) => {
    const r = await post(update(100, '5001'));
    assert.equal(r.status, 503, '★ 送不出去就不可以宣稱處理完');
    const row = await db.getTelegramUpdate(100);
    assert.notEqual(row?.status, 'COMPLETED', '★ 不可以被標成完成');
  }, { sendThrows: true });
});

test('★★★ webhook: OpenRouter 掛掉仍然要回一句人話，不可以讓請求失敗', async () => {
  await withWebhook(async ({ post, sent }) => {
    const r = await post(update(100, '5001'));
    // router 保證永不拋錯，所以仍然會產生回覆
    assert.equal(r.status, 200);
    assert.equal(sent.length, 1, '★ 使用者要收到東西，而不是石沉大海');
  }, { coachThrows: true });
});

// ===========================================================================
// 17. 多使用者隔離
// ===========================================================================

test('★★★ webhook: 兩個使用者互不干擾，回覆各自回到自己的 chat', async () => {
  await withWebhook(async ({ post, sent, aiCalls, alice, bob, db }) => {
    await post(update(100, '5001', '喝了兩杯'));
    await post(update(101, '5002', '喝了三杯'));

    assert.equal(sent.length, 2);
    assert.equal(sent[0].chatId, '5001');
    assert.equal(sent[1].chatId, '5002');
    assert.equal(await journalCount(db, alice.id), 1, '★ Alice 只有自己那筆');
    assert.equal(await journalCount(db, bob.id), 1, '★ Bob 只有自己那筆');
    assert.deepEqual([...new Set(aiCalls)].sort(), [alice.id, bob.id].sort(),
      '★ AI 呼叫必須各自掛在自己的使用者身上');
  });
});

// ===========================================================================
// 18. HRD-R03
// ===========================================================================

test('★★★ webhook: HRD-R03 —— chat 換綁之後，前一個人的回覆不可以送出去', async () => {
  await withWebhook(async ({ db, alice, sent }) => {
    const other = await db.createUser({ displayName: 'X', timezone: 'Asia/Taipei' });
    const api = { async sendMessage(chatId, text) { sent.push({ chatId, text }); } };
    const sendReply = createSendReply({ db, api });

    // 產生回覆之後、送出之前，chat 被換綁
    await db.revokeTelegramLink('5001');
    await db.linkTelegram({ chatId: '5001', userId: other.id });

    await sendReply({ chatId: '5001', reply: '你的 HRV 偏低', userId: alice.id });
    assert.equal(sent.length, 0, '★ 絕不可以把生理資料送進現在屬於別人的 chat');

    await sendReply({ chatId: '5001', reply: '早安', userId: other.id });
    assert.equal(sent.length, 1, '★ 新擁有者自己的回覆仍然要送得出去');
  });
});

test('★★★ webhook: resolveUserByChatId 的契約仍然是 { user, link }', async () => {
  await withWebhook(async ({ db, alice }) => {
    const r = await db.resolveUserByChatId('5001');
    assert.deepEqual(Object.keys(r).sort(), ['link', 'user']);
    assert.equal(r.id, undefined, '★ 最外層沒有 id');
    assert.equal(r.user.id, alice.id);
  });
});

// ===========================================================================
// 19-20. 冷啟動 / 傳輸邊界
// ===========================================================================

test('★★★ webhook: 正確性不依賴記憶體 —— 換一個全新的 processor 仍然去重', async () => {
  await withWebhook(async ({ post, db, sent, alice }) => {
    await post(update(100, '5001', '喝了兩杯'));
    assert.equal(sent.length, 1);

    // 模擬 free instance 睡著後重新醒來：全新的 workerId、全新的 processor，
    // 記憶體裡什麼都沒有，狀態只剩 Turso 裡的。
    const sent2 = [];
    const router2 = createRouter({ db, coachFor: () => ({ async ask() { return 'hi'; }, async json() { return null; } }), now: () => NOW });
    const p2 = createUpdateProcessor({
      db,
      resolveUser: (c) => db.resolveUserByChatId(c),
      handleMessage: ({ text, chatId, user }) => router2.handle({ text, chatId, user }),
      sendReply: createSendReply({ db, api: { async sendMessage(c, t) { sent2.push({ c, t }); } } }),
      workerId: 'restarted-instance', now: () => NOW, sleepImpl: async () => {},
    });
    const h2 = createWebhookHandler({ processUpdate: p2.processUpdate, secret: SECRET });
    const r = await invoke(h2, { method: 'POST', path: PATH_, secret: SECRET, body: update(100, '5001', '喝了兩杯') });

    assert.equal(r.json.outcome, 'replayed', '★ 重啟之後仍然認得出這一則做過了');
    assert.equal(sent2.length, 0, '★ 冷啟動不可以造成重複回覆');
    assert.equal(await journalCount(db, alice.id), 1, '★ 也不可以寫第二筆');
  });
});

test('★★★ webhook: 處理路徑絕不呼叫 getUpdates', async () => {
  await withWebhook(async ({ post, db }) => {
    let called = 0;
    const spy = { ...db };
    assert.ok(spy);
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (u) => { called += 1; throw new Error(`不該有外部呼叫：${u}`); };
    try {
      await post(update(100, '5001'));
    } finally {
      globalThis.fetch = realFetch;
    }
    assert.equal(called, 0, '★ webhook 路徑不可以打任何 Telegram HTTP API（送訊是注入的 api）');
  });
});

test('★★ webhook: looksLikeUpdate 只認結構合法的 Update', () => {
  assert.equal(looksLikeUpdate({ update_id: 1 }), true);
  assert.equal(looksLikeUpdate({ update_id: '1' }), true);
  assert.equal(looksLikeUpdate({ update_id: 'x' }), false);
  assert.equal(looksLikeUpdate([]), false);
  assert.equal(looksLikeUpdate(null), false);
  assert.equal(looksLikeUpdate('update'), false);
});

// ===========================================================================
// 真的綁一個 port（證明它在 Render 上跑得起來）
// ===========================================================================

test('★★★ webhook: 真的起一個 server，/health 與 webhook 都通', async () => {
  await withWebhook(async ({ processor }) => {
    const server = createWebhookServer({ processUpdate: processor.processUpdate, secret: SECRET });
    await new Promise((r) => server.listen(0, '0.0.0.0', r));
    const port = server.address().port;
    try {
      const health = await fetch(`http://127.0.0.1:${port}/health`);
      assert.equal(health.status, 200);
      assert.deepEqual(await health.json(), { ok: true, service: 'telegram-webhook' });

      const bad = await fetch(`http://127.0.0.1:${port}${PATH_}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(update(400, '5001')),
      });
      assert.equal(bad.status, 401, '★ 沒有 secret 一律擋下');

      const ok = await fetch(`http://127.0.0.1:${port}${PATH_}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': SECRET },
        body: JSON.stringify(update(401, '5001')),
      });
      assert.equal(ok.status, 200);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});
