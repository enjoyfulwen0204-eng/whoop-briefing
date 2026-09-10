/**
 * 出站遞送邊界：私人生理資料絕不進群組（R2-H-01）。
 *
 * ## 修的是什麼
 *
 * 入站身分邊界（polling.js 的私訊閘門）在上一輪就修好了。但**出站**完全
 * 沒有守：`user_telegram` 沒有存 chat 型態，而舊版的 `/link` 在群組裡送出
 * 就會成功，所以資料庫裡可能已經躺著一筆指向群組的 ACTIVE 綁定。
 * `getActiveChatIdForUser()` 是 daily / weekly / 主動訊息 / Guardian **唯一**
 * 的目的地來源，它會把那個群組 id 原封不動交出去。
 *
 * 實測確認：`getActiveChatIdForUser` 回傳 `-100500`。
 *
 * **絕不假設 migration 清理過歷史資料。**
 *
 * ## 現在的不變量
 *
 *   私人生理輸出**永遠**不會被送到不安全的 Telegram 目的地。
 *
 * 兩個邊界都守：
 *   A. 綁定邊界 —— 不安全的目的地根本寫不進資料庫
 *   B. 遞送邊界 —— 已經存在的歷史壞資料在讀取時 fail closed 並就地退役
 *
 * 判準是結構性的，不是列舉：Telegram 私訊 chat 的 id 就是對方的 user id，
 * 永遠是正整數；群組／超級群組／頻道永遠是負數。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createDb } from '../src/db.js';
import { runForUser } from '../src/index.js';
import { runGuardian } from '../src/guardian.js';
import { checkAndAct } from '../src/proactiveAgent.js';
import {
  LINK_STATUS, isSafePrivateChatId, unsafeChatReason, GLOBAL_SCOPE,
} from '../src/schema.js';
import { HEARTBEAT_COMPONENT } from '../src/guardianPolicy.js';

const GROUP = '-100500';
const SUPERGROUP = '-1001234567890';
const PRIVATE = '1001';
const PRIVATE_B = '2002';

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r2h01-'));
  const db = createDb({ url: `file:${path.join(dir, 't.db')}` });
  return { db, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/** 歷史遺留的綁定：直接寫 DB，因為現在的程式已經不可能產生它了。 */
async function seedLegacyLink(db, chatId, userId, { status = LINK_STATUS.ACTIVE } = {}) {
  await db.raw.execute({
    sql: `INSERT INTO user_telegram (telegram_chat_id, user_id, linked_at, status)
          VALUES (?, ?, ?, ?)`,
    args: [String(chatId), userId, '2026-01-01T00:00:00.000Z', status],
  });
}

async function withUser(fn) {
  const { db, cleanup } = tempDb();
  try {
    await db.migrate();
    const user = await db.createUser({ displayName: 'Alice', timezone: 'Asia/Taipei' });
    await fn(db, user);
  } finally {
    db.close();
    cleanup();
  }
}

const linkStatus = async (db, chatId) => (await db.getTelegramLink(chatId))?.status ?? null;

// ===========================================================================
// 判準本身
// ===========================================================================

test('★★ R2-H-01: 安全判準是結構性的，不是列舉', () => {
  for (const safe of ['1', '1001', 1001, '  1001  ', '+1001', '999999999']) {
    assert.equal(isSafePrivateChatId(safe), true, `${safe} 應該是安全的私訊 id`);
  }
  for (const unsafe of [
    GROUP, SUPERGROUP, -1, '-1', '0', 0, '', '   ', null, undefined,
    'abc', '1.5', '1e10', {}, [], true, false, '99999999999999999999',
  ]) {
    assert.equal(isSafePrivateChatId(unsafe), false,
      `★ ${JSON.stringify(unsafe)} 必須被視為不安全`);
  }
});

test('★★ R2-H-01: 不安全的原因說得清楚（運維看得懂）', () => {
  assert.equal(unsafeChatReason(GROUP), 'group_or_channel');
  assert.equal(unsafeChatReason(SUPERGROUP), 'group_or_channel');
  assert.equal(unsafeChatReason('0'), 'zero');
  assert.equal(unsafeChatReason(null), 'missing');
  assert.equal(unsafeChatReason('abc'), 'not_numeric');
  assert.equal(unsafeChatReason(PRIVATE), 'safe');
});

// ===========================================================================
// ★★★ A. 綁定邊界
// ===========================================================================

for (const [name, chatId] of [['群組', GROUP], ['超級群組', SUPERGROUP], ['0', '0'], ['非數字', 'abc']]) {
  test(`★★★ R2-H-01 綁定邊界: ${name} 綁不進資料庫`, async () => {
    await withUser(async (db, user) => {
      await assert.rejects(
        () => db.linkTelegram({ chatId, userId: user.id }),
        (e) => e.code === 'UNSAFE_CHAT_DESTINATION',
      );
      assert.equal(await db.getTelegramLink(chatId), null, '★ 一列都不可以寫進去');
    });
  });
}

test('★★ R2-H-01 綁定邊界: 正常私訊仍然綁得起來', async () => {
  await withUser(async (db, user) => {
    const r = await db.linkTelegram({ chatId: PRIVATE, userId: user.id });
    assert.equal(r.chatId, PRIVATE);
    assert.equal(await db.getActiveChatIdForUser(user.id), PRIVATE);
  });
});

// ===========================================================================
// ★★★ B. 遞送邊界：歷史遺留的壞資料
// ===========================================================================

for (const [name, chatId] of [['群組', GROUP], ['超級群組', SUPERGROUP]]) {
  test(`★★★ R2-H-01 遞送邊界: 歷史遺留的${name}綁定不會被交出去`, async () => {
    await withUser(async (db, user) => {
      await seedLegacyLink(db, chatId, user.id);
      assert.equal(await db.getActiveChatIdForUser(user.id), null,
        `★ 絕不可以把${name} id 當成遞送目的地`);
    });
  });

  test(`★★★ R2-H-01 遞送邊界: 歷史遺留的${name}綁定會被就地退役`, async () => {
    await withUser(async (db, user) => {
      await seedLegacyLink(db, chatId, user.id);
      await db.getActiveChatIdForUser(user.id);
      assert.equal(await linkStatus(db, chatId), LINK_STATUS.RETIRED_UNSAFE);
    });
  });
}

test('★★★ R2-H-01: 退役只改狀態，不刪任何資料（可稽核、可恢復）', async () => {
  await withUser(async (db, user) => {
    await seedLegacyLink(db, GROUP, user.id);
    await db.addJournalEvent(user.id, {
      eventAt: '2026-09-08T12:00:00.000Z', healthDate: '2026-09-08',
      category: 'alcohol', note: 'x', source: 'manual',
    });
    await db.getActiveChatIdForUser(user.id);

    const row = await db.getTelegramLink(GROUP);
    assert.ok(row, '★ 綁定列本身必須still在（運維要看得到發生過什麼事）');
    assert.equal(row.userId, user.id, '★ 歸屬不變');
    assert.equal((await db.getJournalEvents(user.id, {
      from: '2026-09-01', to: '2026-09-30', limit: 10,
    })).length, 1, '★ 健康資料一列都不可以少');

    // 重新在私訊裡綁定就能恢復
    await db.linkTelegram({ chatId: PRIVATE, userId: user.id });
    assert.equal(await db.getActiveChatIdForUser(user.id), PRIVATE);
  });
});

test('★★★ R2-H-01: 同時有群組與私訊綁定時，回私訊、並把群組退役', async () => {
  await withUser(async (db, user) => {
    await seedLegacyLink(db, GROUP, user.id);
    await db.linkTelegram({ chatId: PRIVATE, userId: user.id });

    assert.equal(await db.getActiveChatIdForUser(user.id), PRIVATE,
      '★ 一筆壞資料不該讓有正常綁定的人收不到報告');
    assert.equal(await linkStatus(db, GROUP), LINK_STATUS.RETIRED_UNSAFE,
      '★ 群組列不可以留在 ACTIVE 當休眠地雷——私訊被撤銷後它會重新可達');
  });
});

test('★★ R2-H-01: 退役是冪等的（重複呼叫不會變來變去）', async () => {
  await withUser(async (db, user) => {
    await seedLegacyLink(db, GROUP, user.id);
    for (let i = 0; i < 3; i += 1) {
      assert.equal(await db.getActiveChatIdForUser(user.id), null);
    }
    assert.equal(await linkStatus(db, GROUP), LINK_STATUS.RETIRED_UNSAFE);
  });
});

test('★★ R2-H-01: 運維可以一次掃完所有不安全綁定', async () => {
  await withUser(async (db, user) => {
    const other = await db.createUser({ displayName: 'Bob' });
    await seedLegacyLink(db, GROUP, user.id);
    await seedLegacyLink(db, SUPERGROUP, other.id);
    await db.linkTelegram({ chatId: PRIVATE, userId: user.id });

    assert.equal(await db.retireUnsafeTelegramLinks(), 2);
    assert.equal(await db.retireUnsafeTelegramLinks(), 0, '★ 冪等');
    assert.equal(await linkStatus(db, PRIVATE), LINK_STATUS.ACTIVE, '★ 安全的不可以被動到');
  });
});

// ===========================================================================
// ★★★ 入站也不信任儲存的列（縱深防禦）
// ===========================================================================

test('★★★ R2-H-01: resolveUserByChatId 對群組列一律回 null', async () => {
  await withUser(async (db, user) => {
    await seedLegacyLink(db, GROUP, user.id);
    assert.equal(await db.resolveUserByChatId(GROUP), null);
  });
});

// ===========================================================================
// ★★★ 每一條遞送路徑
// ===========================================================================

const envFor = () => ({
  telegramBotToken: 'T', tursoUrl: 'file:x', tursoToken: 't',
  whoopClientId: 'c', whoopClientSecret: 's',
  openrouterApiKey: 'k', openrouterModel: 'm',
  timezone: 'Asia/Taipei', dryRun: false,
});

test('★★★ R2-H-01 daily/weekly: 只有群組綁定時，runForUser 完全不建立 Telegram client', async () => {
  await withUser(async (db, user) => {
    await seedLegacyLink(db, GROUP, user.id);
    const built = [];
    const out = await runForUser({
      db, env: envFor(), user, now: new Date('2026-09-09T00:00:00Z'),
      deps: {
        makeTelegram: (a) => { built.push(a.chatId); return { async send() {}, async notifyError() {} }; },
        makeWhoop: () => ({ async getAccessToken() { return 'a'; } }),
        makeCoach: () => ({}),
        makeSource: () => ({}),
        daily: async () => ({ status: 'sent' }),
        weekly: async () => ({ status: 'skipped' }),
        makeSync: () => ({ async syncAll() { return []; } }),
        proactive: async () => ({ triggered: false }),
      },
    });
    assert.deepEqual(built, [], '★ 絕不可以對群組 id 建立 Telegram client');
    assert.equal(out.skipped, 'no_active_telegram_link');
    assert.equal(out.daily, null, '★ daily 不可以被執行');
    assert.equal(out.weekly, null, '★ weekly 不可以被執行');
  });
});

test('★★★ R2-H-01 proactive: 只有群組綁定時，主動訊息送不出去', async () => {
  await withUser(async (db, user) => {
    await seedLegacyLink(db, GROUP, user.id);
    const sent = [];
    const chatId = await db.getActiveChatIdForUser(user.id);
    assert.equal(chatId, null, '前置：目的地必須是 null');
    // 主動代理拿到的 chatId 就是上面那個 null → 不可能開追問也不可能送訊息
    const r = await checkAndAct({
      db, userId: user.id, timezone: user.timezone,
      telegram: { async send(t) { sent.push(t); } },
      chatId, now: new Date('2026-09-09T00:00:00Z'),
    });
    assert.deepEqual(sent, [], '★ 沒有安全目的地就不可以送任何主動訊息');
    assert.ok(r);
  });
});

test('★★★ R2-H-01 Guardian: 只有群組綁定時，Guardian 不對群組發警報', async () => {
  await withUser(async (db, user) => {
    await seedLegacyLink(db, GROUP, user.id);
    await db.saveTokens(user.id, {
      accessToken: 'a', refreshToken: 'r',
      expiresAt: new Date('2026-12-31T00:00:00Z'), scope: 's', whoopUserId: 'w1',
    });
    // 造一個真的會觸發 Guardian 的狀況（同步停擺）
    await db.saveSyncState(user.id, 'sleep', {
      lastSuccessAt: '2026-09-01T00:00:00.000Z',
    }, { now: new Date('2026-09-09T00:00:00Z') });
    await db.recordHeartbeat(GLOBAL_SCOPE, HEARTBEAT_COMPONENT.CRON, {
      now: new Date('2026-09-09T00:00:00Z'),
    });

    const built = [];
    const res = await runGuardian({
      db,
      makeTelegram: ({ chatId }) => {
        built.push(chatId);
        return { async send() {} };
      },
      now: new Date('2026-09-09T00:00:00Z'),
    });
    assert.ok(res.findings.length >= 1, '前置：確實有 finding 要通知');
    assert.deepEqual(built, [], '★ Guardian 絕不可以把系統狀態發到群組');
    assert.equal(res.notified, 0);
  });
});

test('★★ R2-H-01: 有安全私訊綁定時，遞送路徑照常運作（沒有把功能鎖死）', async () => {
  await withUser(async (db, user) => {
    await db.linkTelegram({ chatId: PRIVATE, userId: user.id });
    const built = [];
    const out = await runForUser({
      db, env: envFor(), user, now: new Date('2026-09-09T00:00:00Z'),
      deps: {
        makeTelegram: (a) => { built.push(a.chatId); return { async send() {}, async notifyError() {} }; },
        makeWhoop: () => ({ async getAccessToken() { return 'a'; } }),
        makeCoach: () => ({}),
        makeSource: () => ({}),
        daily: async () => ({ status: 'sent' }),
        weekly: async () => ({ status: 'skipped' }),
        makeSync: () => ({ async syncAll() { return []; } }),
        proactive: async () => ({ triggered: false }),
      },
    });
    assert.deepEqual(built, [PRIVATE], '★ 正常私訊必須照常建立 client');
    assert.notEqual(out.skipped, 'no_active_telegram_link');
  });
});

// ===========================================================================
// ★★★ 兩個使用者的隔離
// ===========================================================================

test('★★★ R2-H-01 兩使用者: Alice 的群組壞資料不影響 Bob 的正常遞送', async () => {
  await withUser(async (db, alice) => {
    const bob = await db.createUser({ displayName: 'Bob', timezone: 'Asia/Taipei' });
    await seedLegacyLink(db, GROUP, alice.id);
    await db.linkTelegram({ chatId: PRIVATE_B, userId: bob.id });

    assert.equal(await db.getActiveChatIdForUser(alice.id), null);
    assert.equal(await db.getActiveChatIdForUser(bob.id), PRIVATE_B);
    assert.equal(await linkStatus(db, PRIVATE_B), LINK_STATUS.ACTIVE);
  });
});

test('★★★ R2-H-01 兩使用者: 同一個群組被兩人綁過，兩人都拿不到它', async () => {
  await withUser(async (db, alice) => {
    const bob = await db.createUser({ displayName: 'Bob', timezone: 'Asia/Taipei' });
    await seedLegacyLink(db, GROUP, alice.id);
    await seedLegacyLink(db, SUPERGROUP, bob.id);

    assert.equal(await db.getActiveChatIdForUser(alice.id), null);
    assert.equal(await db.getActiveChatIdForUser(bob.id), null);
  });
});
