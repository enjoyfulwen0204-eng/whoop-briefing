/**
 * 運維管理 CLI（Phase 4）。
 *
 * 重點不是「指令會不會跑」，而是這幾條安全性質：
 *   - 綁定碼原文只出現一次，而且 DB 裡只有雜湊
 *   - 停用使用者**不刪任何資料**，而且會被排程排除
 *   - 需要指定使用者的指令一律不猜
 *   - token / 綁定碼絕不出現在輸出裡
 *
 * 全程用真的本機 libSQL 檔案，不呼叫任何外部服務。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createDb } from '../src/db.js';
import { runAdmin, parseArgs } from '../scripts/admin.js';
import { hashSecret } from '../src/identityStore.js';
import { ALICE, BOB, seedAliceAndBob, seedHealthData } from './users.js';

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v11-admin-'));
  const db = createDb({ url: `file:${path.join(dir, 't.db')}` });
  return { db, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

async function withDb(fn, { seed = true } = {}) {
  const { db, cleanup } = tempDb();
  try {
    await db.migrate();
    if (seed) await seedAliceAndBob(db);
    await fn(db);
  } finally {
    db.close();
    cleanup();
  }
}

/** 跑一個指令，回傳 { code, text, lines }。 */
async function run(db, argv) {
  const lines = [];
  const code = await runAdmin({ db, argv, out: (l) => lines.push(String(l)) });
  return { code, lines, text: lines.join('\n') };
}

// ---------------------------------------------------------------------------
// 參數解析
// ---------------------------------------------------------------------------

test('parseArgs 同時支援 --key=value 與 --key value', () => {
  assert.deepEqual(
    parseArgs(['--name=Friend', '--timezone', 'Asia/Tokyo', '--flag']),
    { name: 'Friend', timezone: 'Asia/Tokyo', flag: true },
  );
});

test('parseArgs 把 --name="有空白的名字" 完整保留', () => {
  assert.deepEqual(parseArgs(['--name=Ann Lee']), { name: 'Ann Lee' });
});

// ---------------------------------------------------------------------------
// user:create
// ---------------------------------------------------------------------------

test('user:create 建立使用者並印出 internal user id', async () => {
  await withDb(async (db) => {
    const { code, text } = await run(db, ['user:create', '--name=Friend', '--timezone=Asia/Tokyo']);
    assert.equal(code, 0);

    const users = await db.listUsers({});
    const friend = users.find((u) => u.displayName === 'Friend');
    assert.ok(friend, '使用者應該真的被建立');
    assert.equal(friend.timezone, 'Asia/Tokyo');
    assert.equal(friend.status, 'ACTIVE');
    assert.ok(text.includes(friend.id), '輸出要包含 internal user id');
  }, { seed: false });
});

test('user:create 預設時區是 Asia/Taipei', async () => {
  await withDb(async (db) => {
    await run(db, ['user:create', '--name=Solo']);
    const u = (await db.listUsers({})).find((x) => x.displayName === 'Solo');
    assert.equal(u.timezone, 'Asia/Taipei');
  }, { seed: false });
});

test('user:create 缺 --name 時失敗且不建立任何東西', async () => {
  await withDb(async (db) => {
    const { code, text } = await run(db, ['user:create']);
    assert.equal(code, 1);
    assert.match(text, /缺少 --name/);
    assert.equal((await db.listUsers({})).length, 0);
  }, { seed: false });
});

test('新建立的使用者立刻會被排程視為 ACTIVE', async () => {
  await withDb(async (db) => {
    await run(db, ['user:create', '--name=Friend']);
    const active = await db.listActiveUsers();
    assert.equal(active.length, 1);
    assert.equal(active[0].displayName, 'Friend');
  }, { seed: false });
});

// ---------------------------------------------------------------------------
// user:list
// ---------------------------------------------------------------------------

test('user:list 列出所有使用者與綁定/授權狀態', async () => {
  await withDb(async (db) => {
    const { code, text } = await run(db, ['user:list']);
    assert.equal(code, 0);
    assert.ok(text.includes(ALICE.id));
    assert.ok(text.includes(BOB.id));
    assert.ok(text.includes(ALICE.chatId));
    assert.match(text, /未授權/); // 兩人都還沒有 WHOOP token
  });
});

test('user:list --status 可以過濾', async () => {
  await withDb(async (db) => {
    await db.updateUser(BOB.id, { status: 'DISABLED' });
    const { text } = await run(db, ['user:list', '--status=ACTIVE']);
    assert.ok(text.includes(ALICE.id));
    assert.ok(!text.includes(BOB.id));
  });
});

test('user:list 對不合法的 status 明確報錯', async () => {
  await withDb(async (db) => {
    const { code, text } = await run(db, ['user:list', '--status=NOPE']);
    assert.equal(code, 1);
    assert.match(text, /不合法的 --status/);
  });
});

test('user:list 空系統時給出清楚訊息，不當掉', async () => {
  await withDb(async (db) => {
    const { code, text } = await run(db, ['user:list']);
    assert.equal(code, 0);
    assert.match(text, /還沒有任何使用者/);
  }, { seed: false });
});

test('★ user:list 絕不印出 WHOOP token', async () => {
  await withDb(async (db) => {
    await db.saveTokens(ALICE.id, {
      accessToken: 'SECRET-ACCESS-TOKEN-AAA',
      refreshToken: 'SECRET-REFRESH-TOKEN-BBB',
      expiresAt: new Date('2026-12-31T00:00:00Z'),
      scope: 'offline read:recovery',
      whoopUserId: 'w-1',
    });
    const { text } = await run(db, ['user:list']);
    assert.ok(!text.includes('SECRET-ACCESS-TOKEN-AAA'));
    assert.ok(!text.includes('SECRET-REFRESH-TOKEN-BBB'));
    assert.match(text, /已授權/);
  });
});

// ---------------------------------------------------------------------------
// user:status —— 停用 / 重新啟用
// ---------------------------------------------------------------------------

test('★ user:status DISABLED 會把使用者排除在排程之外', async () => {
  await withDb(async (db) => {
    const { code } = await run(db, ['user:status', `--user=${BOB.id}`, '--status=DISABLED']);
    assert.equal(code, 0);

    const active = await db.listActiveUsers();
    assert.deepEqual(active.map((u) => u.id), [ALICE.id]);
  });
});

test('★★ 停用使用者不刪除任何資料，重新啟用後完全恢復', async () => {
  await withDb(async (db) => {
    await seedHealthData(db, BOB, 22);
    await db.addJournalEvent(BOB.id, {
      eventAt: '2026-09-07T10:00:00Z', healthDate: '2026-09-07',
      category: 'alcohol', numericValue: 2, source: 'manual',
    });

    const beforeCoverage = await db.coverage(BOB.id);
    const beforeJournal = await db.countJournalEvents(BOB.id);
    const beforeChat = await db.getActiveChatIdForUser(BOB.id);
    assert.ok(Number(beforeCoverage.main_sleeps) > 0);
    assert.equal(beforeJournal, 1);

    await run(db, ['user:status', `--user=${BOB.id}`, '--status=DISABLED']);

    // 資料一列都不能少
    assert.deepEqual(await db.coverage(BOB.id), beforeCoverage);
    assert.equal(await db.countJournalEvents(BOB.id), beforeJournal);
    assert.equal(await db.getActiveChatIdForUser(BOB.id), beforeChat);

    // 重新啟用
    await run(db, ['user:status', `--user=${BOB.id}`, '--status=ACTIVE']);
    const active = await db.listActiveUsers();
    assert.ok(active.some((u) => u.id === BOB.id));
    assert.equal(await db.countJournalEvents(BOB.id), beforeJournal);
  });
});

test('user:status 缺 --user 時失敗（絕不在多個使用者之間猜）', async () => {
  await withDb(async (db) => {
    const { code, text } = await run(db, ['user:status', '--status=DISABLED']);
    assert.equal(code, 1);
    assert.match(text, /缺少 --user/);
    // 沒有任何人被改動
    assert.equal((await db.listActiveUsers()).length, 2);
  });
});

test('user:status 對不存在的使用者明確報錯', async () => {
  await withDb(async (db) => {
    const { code, text } = await run(db, ['user:status', '--user=nope', '--status=ACTIVE']);
    assert.equal(code, 1);
    assert.match(text, /找不到使用者/);
  });
});

test('user:status 拒絕不合法的狀態值', async () => {
  await withDb(async (db) => {
    const { code, text } = await run(db, ['user:status', `--user=${ALICE.id}`, '--status=BANNED']);
    assert.equal(code, 1);
    assert.match(text, /不合法的 --status/);
    assert.equal((await db.getUser(ALICE.id)).status, 'ACTIVE');
  });
});

// ---------------------------------------------------------------------------
// link:new —— 綁定碼
// ---------------------------------------------------------------------------

test('★★ link:new 印出原文一次，DB 只存雜湊', async () => {
  await withDb(async (db) => {
    const { code, text } = await run(db, ['link:new', `--user=${ALICE.id}`]);
    assert.equal(code, 0);

    // 從輸出裡把碼撈出來
    const m = text.match(/\/link (\S+)/);
    assert.ok(m, '輸出要包含 /link <碼>');
    const plaintext = m[1];
    assert.ok(plaintext.length >= 16);

    // DB 裡找不到原文，只有雜湊
    const rows = await db.raw.execute('SELECT code_hash FROM user_link_codes');
    assert.equal(rows.rows.length, 1);
    assert.notEqual(rows.rows[0].code_hash, plaintext);
    assert.equal(rows.rows[0].code_hash, hashSecret(plaintext));

    // 整張表的任何欄位都不可以出現原文
    const all = await db.raw.execute('SELECT * FROM user_link_codes');
    const dump = JSON.stringify(all.rows);
    assert.ok(!dump.includes(plaintext), '資料庫裡不可以有綁定碼原文');
  });
});

test('★ link:new 產生的碼真的可以兌換，而且只能用一次', async () => {
  await withDb(async (db) => {
    const { text } = await run(db, ['link:new', `--user=${ALICE.id}`]);
    const codeText = text.match(/\/link (\S+)/)[1];

    const first = await db.redeemLinkCode(codeText, { chatId: '7777' });
    assert.equal(first.ok, true);
    assert.equal(first.userId, ALICE.id);

    const second = await db.redeemLinkCode(codeText, { chatId: '8888' });
    assert.equal(second.ok, false);
    assert.equal(second.reason, 'used');
  });
});

test('link:new 尊重 --ttl-hours', async () => {
  await withDb(async (db) => {
    const before = Date.now();
    await run(db, ['link:new', `--user=${ALICE.id}`, '--ttl-hours=1']);
    const rs = await db.raw.execute('SELECT expires_at FROM user_link_codes');
    const expires = Date.parse(rs.rows[0].expires_at);
    const delta = expires - before;
    assert.ok(delta > 0 && delta <= 3600_000 + 5000, `ttl 應該約一小時，實際 ${delta}ms`);
  });
});

test('link:new 拒絕不合法的 ttl', async () => {
  await withDb(async (db) => {
    const { code, text } = await run(db, ['link:new', `--user=${ALICE.id}`, '--ttl-hours=0']);
    assert.equal(code, 1);
    assert.match(text, /不合法的 --ttl-hours/);
  });
});

test('link:new 對不存在的使用者不產生任何碼', async () => {
  await withDb(async (db) => {
    const { code } = await run(db, ['link:new', '--user=ghost']);
    assert.equal(code, 1);
    const rs = await db.raw.execute('SELECT COUNT(*) AS n FROM user_link_codes');
    assert.equal(Number(rs.rows[0].n), 0);
  });
});

test('link:new 缺 --user 時失敗', async () => {
  await withDb(async (db) => {
    const { code, text } = await run(db, ['link:new']);
    assert.equal(code, 1);
    assert.match(text, /缺少 --user/);
  });
});

// ---------------------------------------------------------------------------
// link:revoke
// ---------------------------------------------------------------------------

test('★ link:revoke 之後該 chat 不再解析得到使用者', async () => {
  await withDb(async (db) => {
    assert.ok(await db.resolveUserByChatId(ALICE.chatId));

    const { code } = await run(db, ['link:revoke', `--chat=${ALICE.chatId}`]);
    assert.equal(code, 0);

    assert.equal(await db.resolveUserByChatId(ALICE.chatId), null);
    // 使用者本人與資料都還在
    assert.ok(await db.getUser(ALICE.id));
  });
});

test('link:revoke 之後可以用新的碼重新綁定', async () => {
  await withDb(async (db) => {
    await run(db, ['link:revoke', `--chat=${ALICE.chatId}`]);
    const { text } = await run(db, ['link:new', `--user=${ALICE.id}`]);
    const code = text.match(/\/link (\S+)/)[1];

    const res = await db.redeemLinkCode(code, { chatId: ALICE.chatId });
    assert.equal(res.ok, true);
    const resolved = await db.resolveUserByChatId(ALICE.chatId);
    assert.equal(resolved.user.id, ALICE.id);
  });
});

test('link:revoke 對沒有綁定的 chat 是安全的 no-op', async () => {
  await withDb(async (db) => {
    const { code, text } = await run(db, ['link:revoke', '--chat=999999']);
    assert.equal(code, 0);
    assert.match(text, /沒有任何綁定紀錄/);
  });
});

// ---------------------------------------------------------------------------
// whoop:status
// ---------------------------------------------------------------------------

test('whoop:status 未授權時說清楚下一步', async () => {
  await withDb(async (db) => {
    const { code, text } = await run(db, ['whoop:status', `--user=${ALICE.id}`]);
    assert.equal(code, 0);
    assert.match(text, /尚未授權/);
    assert.match(text, /npm run authorize/);
  });
});

test('★ whoop:status 已授權時顯示狀態但絕不顯示 token', async () => {
  await withDb(async (db) => {
    await db.saveTokens(ALICE.id, {
      accessToken: 'SECRET-ACCESS-XYZ',
      refreshToken: 'SECRET-REFRESH-XYZ',
      expiresAt: new Date('2026-12-31T00:00:00Z'),
      scope: 'offline read:recovery read:sleep',
      whoopUserId: 'w-42',
    });
    const { text } = await run(db, ['whoop:status', `--user=${ALICE.id}`]);

    assert.match(text, /已授權/);
    assert.match(text, /w-42/);
    assert.ok(!text.includes('SECRET-ACCESS-XYZ'));
    assert.ok(!text.includes('SECRET-REFRESH-XYZ'));
    // 缺的 scope 要提醒
    assert.match(text, /缺少 scope/);
  });
});

test('whoop:status 缺 --user 時失敗', async () => {
  await withDb(async (db) => {
    const { code, text } = await run(db, ['whoop:status']);
    assert.equal(code, 1);
    assert.match(text, /缺少 --user/);
  });
});

// ---------------------------------------------------------------------------
// 多使用者安全性
// ---------------------------------------------------------------------------

test('★★ Alice 的綁定碼只能綁到 Alice，不會影響 Bob', async () => {
  await withDb(async (db) => {
    const { text } = await run(db, ['link:new', `--user=${ALICE.id}`]);
    const code = text.match(/\/link (\S+)/)[1];

    const res = await db.redeemLinkCode(code, { chatId: '5555' });
    assert.equal(res.userId, ALICE.id);
    assert.notEqual(res.userId, BOB.id);

    // Bob 的原有綁定不受影響
    const bob = await db.resolveUserByChatId(BOB.chatId);
    assert.equal(bob.user.id, BOB.id);
  });
});

test('★★ 停用 Alice 完全不影響 Bob', async () => {
  await withDb(async (db) => {
    await seedHealthData(db, ALICE, 11);
    await seedHealthData(db, BOB, 22);

    await run(db, ['user:status', `--user=${ALICE.id}`, '--status=DISABLED']);

    const active = await db.listActiveUsers();
    assert.deepEqual(active.map((u) => u.id), [BOB.id]);
    assert.ok(await db.resolveUserByChatId(BOB.chatId));
    assert.ok(Number((await db.coverage(BOB.id)).main_sleeps) > 0);
  });
});

// ---------------------------------------------------------------------------
// 其他
// ---------------------------------------------------------------------------

test('不認得的指令回 exit 1 並印出用法', async () => {
  await withDb(async (db) => {
    const { code, text } = await run(db, ['nope:nope']);
    assert.equal(code, 1);
    assert.match(text, /不認得的指令/);
    assert.match(text, /user:create/);
  });
});

test('沒有參數時印出用法並回 exit 1', async () => {
  await withDb(async (db) => {
    const { code, text } = await run(db, []);
    assert.equal(code, 1);
    assert.match(text, /user:create/);
  });
});

test('help 印出用法並回 exit 0', async () => {
  await withDb(async (db) => {
    const { code, text } = await run(db, ['help']);
    assert.equal(code, 0);
    assert.match(text, /link:new/);
  });
});
