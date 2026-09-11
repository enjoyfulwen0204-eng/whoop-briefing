/**
 * 順序的兩個恢復缺口（TG-R04-A / TG-R04-B）。
 *
 * 全部用真的 SQLite 檔案，不是假的 helper —— 這兩個缺口都是**耐久狀態**的
 * 問題，用替身測等於沒測。
 *
 * ## A：認領與對話身分不是原子的
 *
 *     N   認領 committed → **崩潰** → 對話身分從來沒寫進去
 *     N+1 到達 → 看不到 N 是同一個對話 → 先執行
 *
 * 修法：對話身分是**認領那一筆 INSERT 的一部分**。不存在「已認領但沒有身分」
 * 的耐久狀態。
 *
 * ## B：寬限期放行了還能復活的舊工作
 *
 * 舊版在查詢裡用寬限期「忽略」太舊的更早訊息，於是後面的先跑了，而前面那則
 * **之後仍然可以恢復並執行** → ["N+1", "N"]。
 *
 * 規則只有兩個選項：嚴格照順序，或把舊工作徹底放棄掉。
 * 不可以放行之後還讓它回來。所以現在是**先原子地終結，再放行**。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createDb } from '../src/db.js';
import { createRouter } from '../src/bot/router.js';
import { createSendReply } from '../src/bot/index.js';
import {
  createUpdateProcessor, UPDATE_OUTCOME, conversationKeyOf,
} from '../src/bot/updateProcessor.js';
import { TELEGRAM_BOT } from '../src/config.js';
import { TELEGRAM_UPDATE_STATUS, TELEGRAM_DELIVERY_STATE } from '../src/schema.js';

const NOW = new Date('2026-09-11T06:00:00Z');
const GRACE = TELEGRAM_BOT.ORDER_BLOCK_GRACE_MS;

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgrec-'));
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
const dedupe = (a) => a.filter((v, i) => a[i - 1] !== v);

async function withEnv(fn, { resolveDelay = null, handleDelay = null } = {}) {
  const { db, cleanup } = tempDb();
  try {
    await db.migrate();
    const alice = await db.createUser({ displayName: 'Alice', timezone: 'Asia/Taipei' });
    await db.linkTelegram({ chatId: '5001', userId: alice.id });
    const exec = [];
    const sent = [];
    const ai = [];
    const api = {
      async sendMessage(chatId, text) { sent.push({ chatId, text }); return { message_id: sent.length }; },
    };
    const router = createRouter({
      db,
      coachFor: (uid) => ({
        async ask() { ai.push(uid); return 'ok'; },
        async json() { ai.push(uid); return null; },
      }),
      now: () => NOW,
    });
    const mk = (w, nowFn = () => NOW) => createUpdateProcessor({
      db,
      resolveUser: async (c) => { if (resolveDelay) await resolveDelay(c); return db.resolveUserByChatId(c); },
      handleMessage: async (m) => {
        if (handleDelay) await handleDelay(m);
        exec.push(m.text);
        return router.handle({ text: m.text, chatId: m.chatId, user: m.user });
      },
      handleUnlinked: async () => null,
      sendReply: createSendReply({ db, api }),
      workerId: w, now: nowFn, sleepImpl: async () => {},
    });
    await fn({ db, alice, exec, sent, ai, mk });
  } finally {
    db.close();
    cleanup();
  }
}

const journalCount = async (db, userId) => (await db.getJournalEvents(userId, {
  from: '2026-09-01', to: '2026-09-30', limit: 200,
})).length;

// ===========================================================================
// A —— 認領 + 對話身分必須是原子的
// ===========================================================================


/**
 * 確定性的閘門，取代「睡 30 毫秒、希望對方已經進場」。
 *
 * 固定睡眠在忙碌的機器上會偶發失敗（觀察過一次無法重現的 flake），
 * 而且失敗時看起來像產品的競態 —— 那種假訊號比測試本身更貴。
 *
 * `entered` 在對方真的進到閘門時 resolve，`release()` 才放它走。
 */
function makeGate() {
  let release;
  let signalEntered;
  const opened = new Promise((r) => { release = r; });
  const entered = new Promise((r) => { signalEntered = r; });
  let used = false;
  return {
    entered,
    release: () => release(),
    /** 放進 coach / resolveUser 裡：第一個進來的會被擋住。 */
    wait: async () => {
      if (used) return;
      used = true;
      signalEntered();
      await opened;
    },
  };
}

test('★★★ A1: 認領那一筆就已經帶著對話身分', async () => {
  await withEnv(async ({ db }) => {
    const key = conversationKeyOf(upd(100, '5001', 'N'));
    assert.equal(key, 'tg:5001');
    const r = await db.claimTelegramUpdate(100, {
      owner: 'attempt#1', leaseMs: 300_000, now: NOW, conversationKey: key,
    });
    assert.equal(r.ok, true);
    const row = await db.getTelegramUpdate(100);
    assert.equal(row.conversationKey, 'tg:5001',
      '★ 認領回來的當下身分就在，不是之後才補寫');
  });
});

test('★★★ A2: 認領成功後立刻崩潰 → N+1 仍然看得到 N，不可以超車', async () => {
  await withEnv(async ({ db, exec, sent }) => {
    // 推導身分 → 耐久認領 → process 立刻死掉（後面什麼都沒做）
    const key = conversationKeyOf(upd(100, '5001', 'N'));
    await db.claimTelegramUpdate(100, {
      owner: 'dead-attempt', leaseMs: 300_000, now: NOW, conversationKey: key,
    });
    assert.equal((await db.getTelegramUpdate(100)).conversationKey, 'tg:5001');

    const rN1 = await withProcessorBlocked(db);
    assert.equal(rN1.outcome, UPDATE_OUTCOME.RETRY,
      '★ 崩潰留下的 N 仍然擋得住 N+1');
    assert.equal(rN1.reason, 'earlier_update_pending');
    assert.deepEqual(dedupe(exec), [], '★ N+1 不可以執行任何業務邏輯');
    assert.equal(sent.length, 0);

    async function withProcessorBlocked(database) {
      const router = createRouter({
        database, db: database,
        coachFor: () => ({ async ask() { return 'ok'; }, async json() { return null; } }),
        now: () => NOW,
      });
      const p = createUpdateProcessor({
        db: database,
        resolveUser: (c) => database.resolveUserByChatId(c),
        handleMessage: async (m) => { exec.push(m.text); return router.handle({ text: m.text, chatId: m.chatId, user: m.user }); },
        sendReply: createSendReply({ db: database, api: { async sendMessage(c, t) { sent.push({ c, t }); return { message_id: 1 }; } } }),
        workerId: 'fresh', now: () => NOW, sleepImpl: async () => {},
      });
      return p.processUpdate(upd(101, '5001', 'N+1'));
    }
  });
});

test('★★★ A3: 認領當下 DB 失敗 → 不留下任何部分狀態', async () => {
  await withEnv(async ({ db }) => {
    const broken = {
      ...db,
      claimTelegramUpdate: async () => { throw new Error('storage down mid-claim'); },
    };
    const router = createRouter({
      db, coachFor: () => ({ async ask() { return 'ok'; }, async json() { return null; } }), now: () => NOW,
    });
    const p = createUpdateProcessor({
      db: broken,
      resolveUser: (c) => db.resolveUserByChatId(c),
      handleMessage: (m) => router.handle({ text: m.text, chatId: m.chatId, user: m.user }),
      sendReply: createSendReply({ db, api: { async sendMessage() { return { message_id: 1 }; } } }),
      workerId: 'w', now: () => NOW, sleepImpl: async () => {},
    });
    const r = await p.processUpdate(upd(200, '5001', 'x'));
    assert.equal(r.outcome, UPDATE_OUTCOME.RETRY);
    assert.equal(await db.getTelegramUpdate(200), null,
      '★ 要嘛認領與身分一起成立，要嘛都不成立 —— 不可以留下半套');
  });
});

test('★★★ A4: 同一個 update_id 帶著不同的對話鍵 → fail closed，不覆寫身分', async () => {
  await withEnv(async ({ db }) => {
    await db.claimTelegramUpdate(300, {
      owner: 'a#1', leaseMs: 1_000, now: new Date(NOW.getTime() - 3600_000),
      conversationKey: 'tg:5001',
    });
    // 租約早就過期，所以「可以接手」的條件成立 —— 但身分不同必須擋下來
    const r = await db.claimTelegramUpdate(300, {
      owner: 'b#1', leaseMs: 300_000, now: NOW, conversationKey: 'tg:9999',
    });
    assert.equal(r.ok, false);
    assert.equal(r.state, 'identity_conflict', '★ 身分衝突要明確回報');
    assert.equal((await db.getTelegramUpdate(300)).conversationKey, 'tg:5001',
      '★ 絕不可以把 chat A 的訊息改記成 chat B 的');
  });
});

test('★★ A5: 沒有安全身分的 update（群組等）不會產生能擋路的列', async () => {
  await withEnv(async ({ db, mk }) => {
    const group = upd(400, '5001', 'x');
    group.message.chat.id = -100500;
    group.message.chat.type = 'supergroup';
    assert.equal(conversationKeyOf(group), null);

    await mk('w').processUpdate(group);
    const row = await db.getTelegramUpdate(400);
    assert.equal(row?.conversationKey ?? null, null, '★ 沒有身分就是 NULL');
    // NULL 身分的列不屬於任何對話，所以擋不到任何人
    const r = await mk('w2').processUpdate(upd(401, '5001', '正常訊息'));
    assert.equal(r.outcome, UPDATE_OUTCOME.PROCESSED);
  });
});

// ===========================================================================
// B —— 寬限期放行之前必須先終結
// ===========================================================================

/** 造一個「久到沒人在推進」的更早訊息。 */
async function seedStale(db, { id = 500, key = 'tg:5001', owner = 'stale#1', status = null } = {}) {
  const long = new Date(NOW.getTime() - (GRACE + 3600_000));
  await db.claimTelegramUpdate(id, { owner, leaseMs: 1_000, now: long, conversationKey: key });
  if (status === TELEGRAM_UPDATE_STATUS.PROCESSING) {
    await db.markTelegramUpdateProcessing(id, { owner, now: long });
  }
  return owner;
}

test('★★★ B1: 超過寬限的 N 會先被終結，之後永遠不能執行', async () => {
  await withEnv(async ({ db, exec, sent, mk }) => {
    await seedStale(db, { id: 500 });

    const rN1 = await mk('p2').processUpdate(upd(501, '5001', 'N+1'));
    assert.equal(rN1.outcome, UPDATE_OUTCOME.PROCESSED);

    const rowN = await db.getTelegramUpdate(500);
    assert.equal(rowN.status, TELEGRAM_UPDATE_STATUS.ABANDONED,
      '★ 放行之前必須先把 N 推到終局');
    assert.equal(rowN.owner, null, '★ 舊 owner 要被清掉（圍欄）');
    assert.equal(rowN.leaseExpiresAt, null);

    // N 之後被重送 —— 絕不可以執行
    const rN = await mk('p3').processUpdate(upd(500, '5001', 'N'));
    assert.equal(rN.outcome, UPDATE_OUTCOME.REPLAYED);
    assert.deepEqual(dedupe(exec), ['N+1'], '★ 最終只有 N+1 執行過');
    assert.equal(sent.length, 1);
  });
});

test('★★★ B2: 被暫停的舊 owner 醒來之後，零副作用', async () => {
  await withEnv(async ({ db, alice, exec, sent, ai, mk }) => {
    // 舊執行已經走到 PROCESSING，然後被暫停
    const owner = await seedStale(db, { id: 600, status: TELEGRAM_UPDATE_STATUS.PROCESSING });

    // 後來的訊息把它終結掉並繼續
    const rN1 = await mk('p2').processUpdate(upd(601, '5001', 'N+1'));
    assert.equal(rN1.outcome, UPDATE_OUTCOME.PROCESSED);
    assert.equal((await db.getTelegramUpdate(600)).status, TELEGRAM_UPDATE_STATUS.ABANDONED);

    const journalBefore = await journalCount(db, alice.id);
    const sentBefore = sent.length;
    const aiBefore = ai.length;

    // 舊 owner 醒來，嘗試每一個副作用邊界
    assert.equal(await db.markTelegramUpdateProcessing(600, { owner, now: NOW }), false,
      '★ 不可以再推進狀態');
    assert.equal(await db.completeTelegramUpdate(600, { owner, now: NOW }), false,
      '★ 不可以結案');
    await assert.rejects(
      () => db.processTelegramOperation(600, { owner, now: () => NOW }, async () => {
        exec.push('ZOMBIE');
        await db.addJournalEvent(alice.id, {
          eventAt: NOW.toISOString(), healthDate: '2026-09-11',
          category: 'alcohol', note: 'zombie', source: 'manual',
        });
        return { chatId: '5001', reply: '殭屍回覆', userId: alice.id };
      }),
      /ownership_lost/,
      '★ 動作交易的圍欄必須擋下來',
    );
    assert.equal(await db.markDeliveryStarted(600, { owner, now: NOW }), false,
      '★ 不可以開始送達');

    assert.equal(await journalCount(db, alice.id), journalBefore, '★ 零 Journal 寫入');
    assert.equal(sent.length, sentBefore, '★ 零 Telegram 送出');
    assert.equal(ai.length, aiBefore, '★ 零 AI 呼叫');
    assert.ok(!exec.includes('ZOMBIE'), '★ 業務邏輯根本沒被執行');
  });
});

test('★★★ B3: 被終結的 N 不可能再被認領回 PROCESSING', async () => {
  await withEnv(async ({ db, mk }) => {
    await seedStale(db, { id: 700 });
    await mk('p2').processUpdate(upd(701, '5001', 'N+1'));
    assert.equal((await db.getTelegramUpdate(700)).status, TELEGRAM_UPDATE_STATUS.ABANDONED);

    const again = await db.claimTelegramUpdate(700, {
      owner: 'new#1', leaseMs: 300_000, now: NOW, conversationKey: 'tg:5001',
    });
    assert.equal(again.ok, false);
    assert.equal(again.state, 'abandoned', '★ 終局就是終局');
    assert.equal((await db.getTelegramUpdate(700)).status, TELEGRAM_UPDATE_STATUS.ABANDONED);
  });
});

test('★★★ B4: 兩個後來的請求同時發現舊工作 → 清理安全，順序仍然成立', async () => {
  await withEnv(async ({ db, exec, sent, mk }) => {
    await seedStale(db, { id: 800 });
    const [r1, r2] = await Promise.all([
      mk('a').processUpdate(upd(801, '5001', 'N+1')),
      mk('b').processUpdate(upd(802, '5001', 'N+2')),
    ]);
    // 舊的被終結一次，不會壞
    assert.equal((await db.getTelegramUpdate(800)).status, TELEGRAM_UPDATE_STATUS.ABANDONED);
    // 兩個後來的仍然要遵守彼此的順序：801 必須先於 802
    const outcomes = [r1.outcome, r2.outcome];
    assert.ok(outcomes.includes(UPDATE_OUTCOME.PROCESSED), '★ 至少一個進得去');
    if (r2.outcome === UPDATE_OUTCOME.PROCESSED) {
      assert.equal(r1.outcome, UPDATE_OUTCOME.PROCESSED,
        '★ 802 進得去的話，801 一定得先完成');
    }
    // 收斂
    for (const id of [801, 802]) {
      let guard = 0;
      while (guard++ < 10 && (await db.getTelegramUpdate(id))?.status !== TELEGRAM_UPDATE_STATUS.COMPLETED) {
        await mk('drain').processUpdate(upd(id, '5001', id === 801 ? 'N+1' : 'N+2'));
      }
    }
    assert.deepEqual(dedupe(exec), ['N+1', 'N+2'], '★ 順序必須是 N+1 → N+2');
    assert.equal(sent.length, 2);
  });
});

test('★★★ B5: N / N+1 / N+2 —— N 被放棄，之後只有 N+1、N+2 且照順序', async () => {
  await withEnv(async ({ db, exec, mk }) => {
    await seedStale(db, { id: 900 });
    for (const [id, text] of [[901, 'N+1'], [902, 'N+2']]) {
      let guard = 0;
      while (guard++ < 10 && (await db.getTelegramUpdate(id))?.status !== TELEGRAM_UPDATE_STATUS.COMPLETED) {
        await mk('w').processUpdate(upd(id, '5001', text));
      }
    }
    // N 事後被重送
    const rN = await mk('late').processUpdate(upd(900, '5001', 'N'));
    assert.equal(rN.outcome, UPDATE_OUTCOME.REPLAYED);
    assert.deepEqual(dedupe(exec), ['N+1', 'N+2'], '★ N 永遠不會出現');
  });
});

test('★★★ B6: 還在寬限期內的舊工作**不可以**被終結（只有真的沒人推進才算）', async () => {
  await withEnv(async ({ db, mk }) => {
    // 租約剛過期一點點，還在寬限期內 → 仍然可能有人在重送
    const recent = new Date(NOW.getTime() - 60_000);
    await db.claimTelegramUpdate(1000, {
      owner: 'recent#1', leaseMs: 1_000, now: recent, conversationKey: 'tg:5001',
    });
    const r = await mk('p2').processUpdate(upd(1001, '5001', 'N+1'));
    assert.equal(r.outcome, UPDATE_OUTCOME.RETRY, '★ 還在寬限期內就要讓路');
    assert.notEqual((await db.getTelegramUpdate(1000)).status, TELEGRAM_UPDATE_STATUS.ABANDONED,
      '★ 不可以把還可能活著的工作殺掉');
  });
});

test('★★★ B7: 已確認送達的舊工作被終結成 COMPLETED（不是 ABANDONED）', async () => {
  await withEnv(async ({ db, mk }) => {
    const long = new Date(NOW.getTime() - (GRACE + 3600_000));
    await db.claimTelegramUpdate(1100, {
      owner: 's#1', leaseMs: 1_000, now: long, conversationKey: 'tg:5001',
    });
    await db.markTelegramUpdateProcessing(1100, { owner: 's#1', now: long });
    // 動作與送達都完成了，只是死在標記結案之前
    await db.raw.execute({
      sql: `INSERT INTO telegram_operations
              (update_id, result_json, committed_at, delivery_state, delivery_attempts)
            VALUES (?,?,?,?,1)`,
      args: [1100, JSON.stringify({ chatId: '5001', reply: 'x', userId: 'u' }),
        long.toISOString(), TELEGRAM_DELIVERY_STATE.DELIVERED],
    });

    await mk('p2').processUpdate(upd(1101, '5001', 'N+1'));
    assert.equal((await db.getTelegramUpdate(1100)).status, TELEGRAM_UPDATE_STATUS.COMPLETED,
      '★ 已經送達的應該被記成完成，說 ABANDONED 不誠實');
  });
});

// ===========================================================================
// 原本的 TG-R04 競態仍然要成立
// ===========================================================================

test('★★★ 回歸: N 卡在 resolveUser、N+1 很快 → 順序仍是 N → N+1', async () => {
  const gate = makeGate();
  await withEnv(async ({ exec, mk }) => {
    const pN = mk('p1').processUpdate(upd(1200, '5001', 'N'));
    await gate.entered;
    const rN1 = await mk('p2').processUpdate(upd(1201, '5001', 'N+1'));
    assert.equal(rN1.outcome, UPDATE_OUTCOME.RETRY);
    gate.release();
    await pN;
    await mk('p3').processUpdate(upd(1201, '5001', 'N+1'));
    assert.deepEqual(dedupe(exec), ['N', 'N+1']);
  }, { resolveDelay: () => gate.wait() });
});

test('★★★ 澄清流程: 問題先建立狀態，答案才進來（崩潰後也不會被超車）', async () => {
  await withEnv(async ({ db, exec, mk }) => {
    // 問題已經被認領（身分同時落地），然後 process 死掉
    await db.claimTelegramUpdate(1300, {
      owner: 'dead', leaseMs: 300_000, now: NOW,
      conversationKey: conversationKeyOf(upd(1300, '5001', '我怎麼感覺那麼累')),
    });
    const answer = await mk('p2').processUpdate(upd(1301, '5001', '昨天喝了兩杯'));
    assert.equal(answer.outcome, UPDATE_OUTCOME.RETRY,
      '★ 答案不可以在問題之前被處理');
    assert.deepEqual(dedupe(exec), []);
  });
});
