/**
 * Multi-user cron / 報告路由 / Telegram 綁定（STEP 9 / 13 / 14 / 15）。
 *
 * 最重要的兩件事：
 *   1. Alice 的報告**永遠不可能**送到 Bob 的 chat（反之亦然）
 *   2. 一個使用者失敗**絕不**影響另一個使用者
 *
 * 全部用注入的替身，**不呼叫真實 Telegram / WHOOP / OpenRouter**。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createDb } from '../src/db.js';
import { dueForUser, runForUser } from '../src/index.js';
import { mapWithConcurrency } from '../src/concurrency.js';
import { handleLinkAttempt } from '../src/bot/link.js';
import { ALICE, BOB, seedAliceAndBob } from './users.js';

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mu-cron-'));
  const db = createDb({ url: `file:${path.join(dir, 't.db')}` });
  return { db, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
async function withAliceBob(fn) {
  const { db, cleanup } = tempDb();
  try { await db.migrate(); await seedAliceAndBob(db); await fn(db); }
  finally { db.close(); cleanup(); }
}

const ENV = {
  telegramBotToken: 'T', telegramChatId: 'bootstrap-chat', dryRun: false,
  whoopClientId: 'c', whoopClientSecret: 's',
  openrouterApiKey: 'k', openrouterModel: 'm',
  maxUserConcurrency: 3,
};

/** 記錄每個 chat 收到什麼的假 telegram 工廠。 */
function telegramSpy(box) {
  return ({ chatId, errorScope }) => ({
    async send(text) {
      box.push({ chatId: String(chatId), text, kind: 'message' });
      return { messageId: box.length };
    },
    async notifyError(type, msg) {
      box.push({ chatId: String(chatId), text: msg, kind: 'error', type, scope: errorScope });
      return true;
    },
    async sendTyping() { return true; },
  });
}

const okWhoop = () => ({ getAccessToken: async () => 'tok' });
const noopSource = () => ({ poll: async () => ({ sleeps: [], recoveries: [] }) });
const noopCoach = () => ({ daily: async () => null, weekly: async () => null, chat: async () => '' });
const noopSync = () => ({ syncAll: async () => ({ resources: {} }) });

// ---------------------------------------------------------------------------
// per-user due 判斷用各自的時區
// ---------------------------------------------------------------------------
test('due 判斷用每個使用者自己的時區（同一 UTC 瞬間可能是不同當地日期）', async () => {
  await withAliceBob(async (db) => {
    // 台灣 2026-09-07 07:00 / 紐約 2026-09-06 19:00
    const now = new Date('2026-09-06T23:00:00Z');
    const a = await dueForUser({ db, userId: ALICE.id, timezone: ALICE.timezone, now });
    const b = await dueForUser({ db, userId: BOB.id, timezone: BOB.timezone, now });
    assert.equal(a.today, '2026-09-07');
    assert.equal(b.today, '2026-09-06');
    assert.notEqual(a.today, b.today);
    assert.equal(a.anythingDue, true);
    assert.equal(b.anythingDue, true);
  });
});

test('一個使用者發完報告不影響另一個使用者的 due 狀態', async () => {
  await withAliceBob(async (db) => {
    const now = new Date('2026-09-06T23:00:00Z');
    // 把 Alice 的今天與昨天都標成已發
    for (const d of ['2026-09-07', '2026-09-06']) {
      await db.recordRun({ userId: ALICE.id, reportType: 'daily', localDateKey: d, status: 'SENT' });
    }
    const a = await dueForUser({ db, userId: ALICE.id, timezone: ALICE.timezone, now });
    const b = await dueForUser({ db, userId: BOB.id, timezone: BOB.timezone, now });
    assert.equal(a.dailySettled, true);
    assert.equal(b.dailySettled, false, 'Bob 的 due 不可因為 Alice 已發而變成已結案');
  });
});

// ---------------------------------------------------------------------------
// 報告目的地
// ---------------------------------------------------------------------------
test('★ Alice 的報告永遠只送到 Alice 的 chat（雙向驗證）', async () => {
  await withAliceBob(async (db) => {
    const box = [];
    const deps = {
      makeTelegram: telegramSpy(box),
      makeWhoop: okWhoop, makeSource: noopSource, makeCoach: noopCoach, makeSync: noopSync,
      // 假的 runDaily：把自己收到的 userId 與 telegram 寫進去
      daily: async ({ userId, telegram, timezone }) => {
        await telegram.send(`DAILY-FOR-${userId}-TZ-${timezone}`);
        return { status: 'sent', userId };
      },
      weekly: async () => null,
    };
    const now = new Date('2026-09-06T23:00:00Z');
    for (const u of [ALICE, BOB]) {
      const user = await db.getUser(u.id);
      await runForUser({ db, env: ENV, user, now, deps });
    }

    const aliceMsgs = box.filter((m) => m.chatId === ALICE.chatId);
    const bobMsgs = box.filter((m) => m.chatId === BOB.chatId);
    assert.equal(aliceMsgs.length, 1);
    assert.equal(bobMsgs.length, 1);
    assert.match(aliceMsgs[0].text, /DAILY-FOR-u-alice-TZ-Asia\/Taipei/);
    assert.match(bobMsgs[0].text, /DAILY-FOR-u-bob-TZ-America\/New_York/);
    // 交叉檢查：任何一方的 chat 都不可出現另一方的 userId
    assert.ok(!aliceMsgs.some((m) => m.text.includes(BOB.id)), 'Bob 的內容不可出現在 Alice 的 chat');
    assert.ok(!bobMsgs.some((m) => m.text.includes(ALICE.id)), 'Alice 的內容不可出現在 Bob 的 chat');
    // bootstrap chat 完全沒被用到
    assert.equal(box.filter((m) => m.chatId === 'bootstrap-chat').length, 0);
  });
});

test('沒有 ACTIVE Telegram 綁定的使用者會被跳過，不會亂發', async () => {
  await withAliceBob(async (db) => {
    await db.revokeTelegramLink(BOB.chatId);
    const box = [];
    const deps = {
      makeTelegram: telegramSpy(box), makeWhoop: okWhoop, makeSource: noopSource,
      makeCoach: noopCoach, makeSync: noopSync,
      daily: async ({ telegram, userId }) => { await telegram.send(`D-${userId}`); return {}; },
      weekly: async () => null,
    };
    const user = await db.getUser(BOB.id);
    const out = await runForUser({ db, env: ENV, user, now: new Date('2026-09-06T23:00:00Z'), deps });
    assert.equal(out.skipped, 'no_active_telegram_link');
    assert.equal(box.length, 0, '沒有綁定就完全不該送任何訊息');
  });
});

// ---------------------------------------------------------------------------
// 失敗隔離
// ---------------------------------------------------------------------------
test('★ Alice 的 WHOOP 授權失敗不影響 Bob（錯誤通知也 scope 到本人）', async () => {
  await withAliceBob(async (db) => {
    const box = [];
    const deps = {
      makeTelegram: telegramSpy(box),
      makeWhoop: ({ userId }) => ({
        getAccessToken: async () => {
          if (userId === ALICE.id) throw new Error('WHOOP 401 for alice');
          return 'tok';
        },
      }),
      makeSource: noopSource, makeCoach: noopCoach, makeSync: noopSync,
      daily: async ({ userId, telegram }) => { await telegram.send(`D-${userId}`); return { status: 'sent' }; },
      weekly: async () => null,
    };
    const now = new Date('2026-09-06T23:00:00Z');
    const users = await db.listActiveUsers();
    const results = await mapWithConcurrency(users, 3,
      (user) => runForUser({ db, env: ENV, user, now, deps }));

    assert.equal(results.length, 2);
    assert.ok(results.every((r) => r.ok), 'runForUser 本身不該拋錯');

    const alice = results.find((r) => r.value.userId === ALICE.id).value;
    const bob = results.find((r) => r.value.userId === BOB.id).value;
    assert.equal(alice.errors[0].stage, 'whoop_auth');
    assert.equal(alice.daily, null, 'Alice 不該發出報告');
    assert.equal(bob.errors.length, 0, 'Bob 必須完全不受影響');
    assert.equal(bob.daily.status, 'sent');

    // Alice 的錯誤通知送到 Alice 的 chat，scope 是 user:alice
    const errs = box.filter((m) => m.kind === 'error');
    assert.equal(errs.length, 1);
    assert.equal(errs[0].chatId, ALICE.chatId);
    assert.equal(errs[0].scope, `user:${ALICE.id}`);
    // Bob 收到的是報告，不是別人的錯誤
    assert.deepEqual(
      box.filter((m) => m.chatId === BOB.chatId).map((m) => m.kind), ['message'],
    );
  });
});

test('★ daily 拋錯只影響那一個使用者，其他人照跑完', async () => {
  await withAliceBob(async (db) => {
    const box = [];
    const deps = {
      makeTelegram: telegramSpy(box), makeWhoop: okWhoop, makeSource: noopSource,
      makeCoach: noopCoach, makeSync: noopSync,
      daily: async ({ userId, telegram }) => {
        if (userId === BOB.id) throw new Error('bob daily 爆了');
        await telegram.send(`D-${userId}`);
        return { status: 'sent' };
      },
      weekly: async () => null,
    };
    const users = await db.listActiveUsers();
    const results = await mapWithConcurrency(users, 3,
      (user) => runForUser({ db, env: ENV, user, now: new Date('2026-09-06T23:00:00Z'), deps }));

    const alice = results.find((r) => r.value.userId === ALICE.id).value;
    const bob = results.find((r) => r.value.userId === BOB.id).value;
    assert.equal(alice.daily.status, 'sent', 'Alice 必須成功');
    assert.equal(alice.errors.length, 0);
    assert.equal(bob.errors[0].stage, 'daily');
    // Bob 收到錯誤通知，Alice 收到報告
    assert.deepEqual(box.filter((m) => m.chatId === ALICE.chatId).map((m) => m.kind), ['message']);
    assert.deepEqual(box.filter((m) => m.chatId === BOB.chatId).map((m) => m.kind), ['error']);
  });
});

test('併發上限被遵守，而且不影響失敗隔離', async () => {
  let live = 0;
  let peak = 0;
  const items = [1, 2, 3, 4, 5, 6, 7, 8];
  const res = await mapWithConcurrency(items, 3, async (n) => {
    live += 1; peak = Math.max(peak, live);
    await new Promise((r) => setTimeout(r, 10));
    live -= 1;
    if (n % 4 === 0) throw new Error(`n${n}`);
    return n;
  });
  assert.ok(peak <= 3, `併發峰值 ${peak} 不可超過 3`);
  assert.equal(res.filter((r) => r.ok).length, 6);
  assert.equal(res.filter((r) => !r.ok).length, 2);
  assert.deepEqual(res.filter((r) => r.ok).map((r) => r.value), [1, 2, 3, 5, 6, 7]);
});

// ---------------------------------------------------------------------------
// /link（STEP 9）
// ---------------------------------------------------------------------------
test('/link：正確的碼可以綁定；之後該 chat 就能被解析成該使用者', async () => {
  await withAliceBob(async (db) => {
    await db.createUser({ id: 'u-friend', displayName: 'Friend', timezone: 'Asia/Tokyo' });
    const { code } = await db.createLinkCode('u-friend', { ttlMs: 60_000 });

    assert.equal(await db.resolveUserByChatId('5001'), null);
    const reply = await handleLinkAttempt({ db, text: `/link ${code}`, chatId: '5001' });
    assert.match(reply, /綁定完成/);
    assert.match(reply, /Friend/);
    assert.equal((await db.resolveUserByChatId('5001')).user.id, 'u-friend');
  });
});

test('/link：無效 / 過期 / 用過的碼都回同一句中性訊息（不當成碼的探測工具）', async () => {
  await withAliceBob(async (db) => {
    await db.createUser({ id: 'u-f2', displayName: 'F2' });
    const used = await db.createLinkCode('u-f2', { ttlMs: 60_000 });
    await db.redeemLinkCode(used.code, { chatId: '6001' });
    const expired = await db.createLinkCode('u-f2', { ttlMs: -1000 });

    const replies = await Promise.all([
      handleLinkAttempt({ db, text: '/link total-nonsense', chatId: '6002' }),
      handleLinkAttempt({ db, text: `/link ${used.code}`, chatId: '6003' }),
      handleLinkAttempt({ db, text: `/link ${expired.code}`, chatId: '6004' }),
    ]);
    assert.equal(new Set(replies).size, 1, '三種失敗必須是同一句話');
    assert.match(replies[0], /無法使用/);
    // 都沒有綁定成功
    for (const c of ['6002', '6003', '6004']) {
      assert.equal(await db.resolveUserByChatId(c), null);
    }
  });
});

test('/link：已經綁定的 chat 不會被靜默搶走', async () => {
  await withAliceBob(async (db) => {
    await db.createUser({ id: 'u-f3', displayName: 'F3' });
    const { code } = await db.createLinkCode('u-f3', { ttlMs: 60_000 });
    const reply = await handleLinkAttempt({ db, text: `/link ${code}`, chatId: ALICE.chatId });
    assert.match(reply, /已經綁定過/);
    assert.equal((await db.resolveUserByChatId(ALICE.chatId)).user.id, ALICE.id,
      'Alice 的綁定必須完好');
  });
});

test('/link：未綁定的 chat 傳其他訊息 → 完全不回（不洩漏 bot 存在）', async () => {
  await withAliceBob(async (db) => {
    for (const text of ['嗨', '/help', '/cost', '你有幾個使用者？', '/start']) {
      assert.equal(
        await handleLinkAttempt({ db, text, chatId: '7001' }), null,
        `「${text}」不該有任何回覆`,
      );
    }
    // 只有 /link 沒帶碼會回用法
    assert.match(await handleLinkAttempt({ db, text: '/link', chatId: '7001' }), /用法/);
  });
});

test('/link：並發用同一組碼，只有一個 chat 綁成功', async () => {
  await withAliceBob(async (db) => {
    await db.createUser({ id: 'u-f4', displayName: 'F4' });
    const { code } = await db.createLinkCode('u-f4', { ttlMs: 60_000 });
    const replies = await Promise.all([
      handleLinkAttempt({ db, text: `/link ${code}`, chatId: '8001' }),
      handleLinkAttempt({ db, text: `/link ${code}`, chatId: '8002' }),
    ]);
    const wins = replies.filter((r) => /綁定完成/.test(r));
    assert.equal(wins.length, 1, `恰好一個成功，實際 ${wins.length}`);
    const linked = [
      await db.resolveUserByChatId('8001'), await db.resolveUserByChatId('8002'),
    ].filter(Boolean);
    assert.equal(linked.length, 1);
  });
});
