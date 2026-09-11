/**
 * Telegram webhook 的所有權、送達與順序（Codex findings A / B / C）。
 *
 * ## A — 模糊送達可能重複回覆
 *
 * 舊順序是「提交動作 → 送出 Telegram → 標記 COMPLETED」。中間死掉的話，
 * 資料庫裡只看得到「PROCESSING 而且租約過期」，完全分不出是**還沒送**還是
 * **已經送出去了** —— 而那兩種情況的正確處置正好相反。
 *
 * 現在送達本身是耐久狀態，而且在**打網路之前**就寫下來。
 *
 * ## B — 同一 process 的去重依賴記憶體
 *
 * 舊版所有權用 process 層級的 workerId，於是同一個 process 的兩個併發請求
 * 在耐久層「互相認得」，都拿得到所有權，排他性只好靠記憶體裡的 inFlight。
 * 現在每一次執行有自己的 attemptId，排他性完全由 DB 的條件式寫入決定。
 *
 * 下面每一個併發測試都**不經過 inFlight**（直接開多個 processor 實例、或
 * 直接呼叫底層），所以它們證明的是耐久層本身的排他性。
 *
 * ## C — 同一使用者的訊息沒有順序保證
 *
 * 同一個人的兩則訊息可能併發執行，對澄清狀態與 Journal 互動不安全。
 * 現在每個使用者有一條對話通道（resource_locks 租約）＋「不可以超車比我早
 * 且還沒結案的訊息」的檢查。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createDb } from '../src/db.js';
import { createRouter } from '../src/bot/router.js';
import { createSendReply } from '../src/bot/index.js';
import { createUpdateProcessor, UPDATE_OUTCOME } from '../src/bot/updateProcessor.js';
import { TelegramApiError, classifySendOutcome } from '../src/bot/api.js';
import {
  TELEGRAM_DELIVERY_STATE, TELEGRAM_UPDATE_STATUS, ADDITIVE_COLUMNS,
} from '../src/schema.js';

const NOW = new Date('2026-09-11T06:00:00Z');

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdh-'));
  const db = createDb({ url: `file:${path.join(dir, 't.db')}` });
  return { db, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const upd = (id, chat, text = '喝了兩杯') => ({
  update_id: id,
  message: {
    message_id: id, chat: { id: Number(chat), type: 'private' },
    from: { id: Number(chat), is_bot: false }, text, date: 1,
  },
});

/**
 * 一個測試環境。`mkProcessor()` 每次都造出一個**獨立**的 processor，
 * 代表「另一個 Render 實例」或「同一個 process 的另一個併發請求」——
 * 兩者的差別只在 workerId，而所有權靠的是 attemptId。
 */
async function withEnv(fn, opts = {}) {
  const { db, cleanup } = tempDb();
  try {
    await db.migrate();
    const alice = await db.createUser({ displayName: 'Alice', timezone: 'Asia/Taipei' });
    const bob = await db.createUser({ displayName: 'Bob', timezone: 'Asia/Taipei' });
    await db.linkTelegram({ chatId: '5001', userId: alice.id });
    await db.linkTelegram({ chatId: '5002', userId: bob.id });

    const sent = [];
    let nextMessageId = 1000;
    const api = {
      async sendMessage(chatId, text) {
        if (opts.onSend) await opts.onSend({ chatId, text, sent });
        sent.push({ chatId, text });
        nextMessageId += 1;
        return { message_id: nextMessageId };
      },
    };
    // ⚠️ 延遲一律放在 coach 裡，不要放在 handleMessage 裡。
    //
    // 真正的 LLM 呼叫是透過 processingTransaction 的 outside() 做的：它會先
    // 回滾這次的寫入交易、在交易外面把答案拿到、再用新鮮的狀態重跑。所以
    // провider 的延遲**不會**讓任何人握著寫入交易。
    // 如果測試把延遲塞進 handleMessage，就等於人工製造一個生產環境不存在的
    // 「拿著寫入交易等網路」，在本機 SQLite 上會直接 SQLITE_BUSY。
    const coachFor = () => ({
      async ask() { if (opts.coachDelay) await opts.coachDelay(); return '好的'; },
      async json() {
        if (opts.coachDelay) await opts.coachDelay();
        return { asserted: true, about_self: true, negated: false, hypothetical: false, category: 'alcohol', subtype: 'beer', numeric_value: 2, unit: 'cup', confidence: 0.9 };
      },
    });
    const router = createRouter({ db, coachFor, now: () => NOW });
    const mkProcessor = (o = {}) => createUpdateProcessor({
      db: o.db ?? db,
      resolveUser: async (c) => {
        if (o.resolveDelay) await o.resolveDelay(c);
        return db.resolveUserByChatId(c);
      },
      handleMessage: async (m) => {
        if (o.onHandle) await o.onHandle(m);
        return router.handle({ text: m.text, chatId: m.chatId, user: m.user });
      },
      handleUnlinked: async () => null,
      sendReply: o.sendReply ?? createSendReply({ db, api: o.api ?? api }),
      workerId: o.workerId ?? 'instance-1',
      now: o.now ?? (() => NOW),
      sleepImpl: async () => {},
    });
    await fn({ db, alice, bob, sent, api, mkProcessor, cleanup });
  } finally {
    db.close();
    cleanup();
  }
}

const journalCount = async (db, userId) => (await db.getJournalEvents(userId, {
  from: '2026-09-01', to: '2026-09-30', limit: 200,
})).length;

// ===========================================================================
// A1-A5 — 耐久所有權（不依賴 inFlight）
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

test('★★★ A1: 同一 process 兩個併發請求（繞過 inFlight）→ 只有一個送出', async () => {
  await withEnv(async ({ db, alice, sent, mkProcessor }) => {
    // 兩個獨立的 processor 實例 = 兩個獨立的 inFlight Map，
    // 而且**共用同一個 workerId**（同一個 process）。
    const p1 = mkProcessor({ workerId: 'same-process' });
    const p2 = mkProcessor({ workerId: 'same-process' });

    const [r1, r2] = await Promise.all([
      p1.processUpdate(upd(100, '5001')),
      p2.processUpdate(upd(100, '5001')),
    ]);

    assert.equal(sent.length, 1, '★ 只能送一次');
    assert.equal(await journalCount(db, alice.id), 1, '★ 只能寫一筆');
    const outcomes = [r1.outcome, r2.outcome].sort();
    assert.ok(outcomes.includes(UPDATE_OUTCOME.PROCESSED), '★ 一個成功');
    assert.ok(!outcomes.every((o) => o === UPDATE_OUTCOME.PROCESSED),
      '★ 不可以兩個都宣稱處理完');
  });
});

test('★★★ A2: 同一則 update、不同 attempt owner → 只有一個送出', async () => {
  await withEnv(async ({ db, alice, sent, mkProcessor }) => {
    const [r1, r2] = await Promise.all([
      mkProcessor({ workerId: 'w-a' }).processUpdate(upd(100, '5001')),
      mkProcessor({ workerId: 'w-b' }).processUpdate(upd(100, '5001')),
    ]);
    assert.equal(sent.length, 1);
    assert.equal(await journalCount(db, alice.id), 1);
    assert.notDeepEqual([r1.outcome, r2.outcome], [UPDATE_OUTCOME.PROCESSED, UPDATE_OUTCOME.PROCESSED]);
  });
});

test('★★★ A3: 兩個模擬的 Render 實例共用同一個 DB → 只有一個送出', async () => {
  await withEnv(async ({ db, alice, sent, mkProcessor }) => {
    const instances = [mkProcessor({ workerId: 'render-1' }), mkProcessor({ workerId: 'render-2' })];
    const results = await Promise.all(instances.map((p) => p.processUpdate(upd(200, '5001'))));
    assert.equal(sent.length, 1, '★ 跨實例也只能送一次');
    assert.equal(await journalCount(db, alice.id), 1);
    assert.equal(results.filter((r) => r.outcome === UPDATE_OUTCOME.PROCESSED).length, 1);
  });
});

test('★★★ A4: 第一個嘗試認領後死掉 → 租約過期後第二個可以接手', async () => {
  await withEnv(async ({ db, alice, sent, mkProcessor }) => {
    // 認領了就死（沒有推進 PROCESSING），租約早就過期
    await db.claimTelegramUpdate(300, {
      owner: 'dead-attempt', leaseMs: 1_000,
      now: new Date(NOW.getTime() - 3600_000),
    });
    const r = await mkProcessor({ workerId: 'fresh' }).processUpdate(upd(300, '5001'));
    assert.equal(r.outcome, UPDATE_OUTCOME.PROCESSED, '★ 必須能接手（否則訊息永遠卡住）');
    assert.equal(sent.length, 1);
    assert.equal(await journalCount(db, alice.id), 1);
  });
});

test('★★★ A5: 失去租約的舊 owner 不可以標記完成（fencing）', async () => {
  await withEnv(async ({ db }) => {
    await db.claimTelegramUpdate(400, { owner: 'old', leaseMs: 60_000, now: NOW });
    await db.markTelegramUpdateProcessing(400, { owner: 'old', now: NOW });
    // 租約過期後被新的嘗試接手
    const later = new Date(NOW.getTime() + 3600_000);
    const takeover = await db.claimTelegramUpdate(400, { owner: 'new', leaseMs: 60_000, now: later });
    assert.equal(takeover.ok, true, '★ 過期之後要能接手');

    assert.equal(await db.completeTelegramUpdate(400, { owner: 'old', now: later }), false,
      '★ 舊 owner 不可以在失去租約之後完成它');
    const row = await db.getTelegramUpdate(400);
    assert.notEqual(row.status, TELEGRAM_UPDATE_STATUS.COMPLETED);
  });
});

test('★★★ B: 耐久層本身就排他 —— 不同 attempt owner 不會互相繼承所有權', async () => {
  await withEnv(async ({ db }) => {
    const a = await db.claimTelegramUpdate(500, { owner: 'proc#attempt-1', leaseMs: 300_000, now: NOW });
    const b = await db.claimTelegramUpdate(500, { owner: 'proc#attempt-2', leaseMs: 300_000, now: NOW });
    assert.equal(a.state, 'claimed');
    assert.equal(b.state, 'in_progress',
      '★ 同一個 process 的另一個嘗試也必須被擋下（這是 Finding B 的核心）');
  });
});

// ===========================================================================
// B1-B6 — 模糊送達
// ===========================================================================

test('★★★ B1: 送出成功 → message_id 持久化，重播不會再送', async () => {
  await withEnv(async ({ db, sent, mkProcessor }) => {
    const r = await mkProcessor().processUpdate(upd(600, '5001'));
    assert.equal(r.outcome, UPDATE_OUTCOME.PROCESSED);
    assert.equal(sent.length, 1);

    const op = await db.getTelegramOperation(600);
    assert.equal(op.deliveryState, TELEGRAM_DELIVERY_STATE.DELIVERED);
    assert.ok(Number.isFinite(op.telegramMessageId), '★ 必須存下 Telegram 的 message_id');
    assert.ok(op.deliveredAt);

    // 重播
    const again = await mkProcessor({ workerId: 'other' }).processUpdate(upd(600, '5001'));
    assert.equal(again.outcome, UPDATE_OUTCOME.REPLAYED);
    assert.equal(sent.length, 1, '★ 重播不可以再送');
  });
});

test('★★★ B2: Telegram 明確拒絕（HTTP 400）→ 保持可重送', async () => {
  await withEnv(async ({ db, sent, mkProcessor }) => {
    const failing = {
      async sendMessage() { throw new TelegramApiError('Telegram 400: bad request', { status: 400 }); },
    };
    const r = await mkProcessor({ api: failing }).processUpdate(upd(700, '5001'));
    assert.equal(r.outcome, UPDATE_OUTCOME.RETRY, '★ 明確失敗要可以重試');
    assert.equal(sent.length, 0);

    const op = await db.getTelegramOperation(700);
    assert.equal(op.deliveryState, TELEGRAM_DELIVERY_STATE.ACTION_READY,
      '★ 狀態要退回「可以安全地送」');
  });
});

test('★★★ B3: 遠端可能已接受之後逾時 → AMBIGUOUS，且不自動重送', async () => {
  await withEnv(async ({ db, alice, sent, mkProcessor }) => {
    const timeoutApi = {
      async sendMessage() {
        // 模擬「請求送出去了，但等不到回應」
        throw new TelegramApiError('Telegram 連線失敗：timeout', {
          isNetwork: true, cause: { name: 'TimeoutError' },
        });
      },
    };
    const r = await mkProcessor({ api: timeoutApi }).processUpdate(upd(800, '5001'));
    assert.equal(r.outcome, UPDATE_OUTCOME.AMBIGUOUS_DELIVERY);

    const op = await db.getTelegramOperation(800);
    assert.equal(op.deliveryState, TELEGRAM_DELIVERY_STATE.AMBIGUOUS);
    assert.equal(await journalCount(db, alice.id), 1, '★ 動作已經耐久提交了');

    // 自動重播不可以再送一次
    const again = await mkProcessor({ workerId: 'retry' }).processUpdate(upd(800, '5001'));
    assert.equal(again.outcome, UPDATE_OUTCOME.REPLAYED);
    assert.equal(sent.length, 0, '★ 模糊狀態絕不自動重送');
  });
});

test('★★★ B4: 連線被重置 → 同樣視為模糊', async () => {
  await withEnv(async ({ db, mkProcessor }) => {
    const resetApi = {
      async sendMessage() {
        throw new TelegramApiError('Telegram 連線失敗：socket hang up', {
          isNetwork: true, cause: { cause: { code: 'ECONNRESET' } },
        });
      },
    };
    const r = await mkProcessor({ api: resetApi }).processUpdate(upd(900, '5001'));
    assert.equal(r.outcome, UPDATE_OUTCOME.AMBIGUOUS_DELIVERY);
    assert.equal((await db.getTelegramOperation(900)).deliveryState,
      TELEGRAM_DELIVERY_STATE.AMBIGUOUS);
  });
});

test('★★★ B5: 模糊狀態撐過 process 重啟 → 仍然不自動重送', async () => {
  await withEnv(async ({ db, sent, mkProcessor }) => {
    const timeoutApi = {
      async sendMessage() {
        throw new TelegramApiError('timeout', { isNetwork: true, cause: { name: 'TimeoutError' } });
      },
    };
    await mkProcessor({ api: timeoutApi, workerId: 'before-restart' }).processUpdate(upd(1000, '5001'));
    assert.equal((await db.getTelegramOperation(1000)).deliveryState,
      TELEGRAM_DELIVERY_STATE.AMBIGUOUS);

    // 「重啟」：全新的 processor、全新的 workerId，記憶體全空
    const after = await mkProcessor({ workerId: 'after-restart' }).processUpdate(upd(1000, '5001'));
    assert.equal(after.outcome, UPDATE_OUTCOME.REPLAYED);
    assert.equal(sent.length, 0, '★ 重啟之後也不可以重送');
  });
});

test('★★★ B6: 明確失敗之後重試 → 最終恰好一則回覆', async () => {
  await withEnv(async ({ db, alice, sent, mkProcessor }) => {
    let fail = true;
    const flaky = {
      async sendMessage(chatId, text) {
        if (fail) { fail = false; throw new TelegramApiError('Telegram 500', { status: 500 }); }
        sent.push({ chatId, text });
        return { message_id: 42 };
      },
    };
    const first = await mkProcessor({ api: flaky, workerId: 'a' }).processUpdate(upd(1100, '5001'));
    assert.equal(first.outcome, UPDATE_OUTCOME.RETRY);
    assert.equal(sent.length, 0);

    // Telegram 重送（租約過期後由新的嘗試接手）
    const later = new Date(NOW.getTime() + 3600_000);
    const second = await mkProcessor({
      api: flaky, workerId: 'b', now: () => later,
    }).processUpdate(upd(1100, '5001'));

    assert.equal(second.outcome, UPDATE_OUTCOME.PROCESSED);
    assert.equal(sent.length, 1, '★ 最終恰好一則');
    assert.equal(await journalCount(db, alice.id), 1, '★ 動作沒有被重做');
    assert.equal((await db.getTelegramOperation(1100)).telegramMessageId, 42);
  });
});

test('★★ B: 送出前一定先寫 DELIVERY_STARTED（不是送完才寫）', async () => {
  await withEnv(async ({ db, mkProcessor }) => {
    let stateAtSend = null;
    const api = {
      async sendMessage() {
        stateAtSend = (await db.getTelegramOperation(1200))?.deliveryState ?? null;
        return { message_id: 7 };
      },
    };
    await mkProcessor({ api }).processUpdate(upd(1200, '5001'));
    assert.equal(stateAtSend, TELEGRAM_DELIVERY_STATE.DELIVERY_STARTED,
      '★ 打網路的當下，資料庫必須已經知道「可能送出去了」');
  });
});

test('★★ 送達結果分類：有 HTTP 回應或連線沒建立 = 確定失敗；其餘網路錯誤 = 模糊', () => {
  const mk = (o) => new TelegramApiError('x', o);
  for (const status of [400, 401, 403, 429, 500]) {
    assert.equal(classifySendOutcome(mk({ status })), 'definite_failure', `HTTP ${status}`);
  }
  for (const code of ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED']) {
    assert.equal(classifySendOutcome(mk({ isNetwork: true, cause: { cause: { code } } })),
      'definite_failure', code);
  }
  for (const code of ['ECONNRESET', 'ETIMEDOUT', 'EPIPE']) {
    assert.equal(classifySendOutcome(mk({ isNetwork: true, cause: { cause: { code } } })),
      'ambiguous', code);
  }
  assert.equal(classifySendOutcome(mk({ isNetwork: true, cause: { name: 'TimeoutError' } })), 'ambiguous');
});

// ===========================================================================
// C1-C5 — 同一使用者的順序
// ===========================================================================

test('★★★ C1: 同一使用者 N 與 N+1 併發，N 被拖慢 → N+1 不可以超車', async () => {
  const seen = [];
  const gate = makeGate();

  await withEnv(async ({ sent, mkProcessor }) => {
    const p1 = mkProcessor({ workerId: 'p1', onHandle: ({ text }) => { seen.push(text); } });
    const p2 = mkProcessor({ workerId: 'p2', onHandle: ({ text }) => { seen.push(text); } });

    const pN = p1.processUpdate(upd(2000, '5001', 'N'));
    await gate.entered;   // 確定 N 已經卡在 coach 上（不是靠睡固定時間）

    const rN1 = await p2.processUpdate(upd(2001, '5001', 'N+1'));
    assert.equal(rN1.outcome, UPDATE_OUTCOME.RETRY,
      '★ N 還在跑，N+1 必須讓路（而不是同時改狀態）');
    assert.deepEqual(seen, ['N'], '★ N+1 的業務邏輯根本不該被執行');

    gate.release();
    const rN = await pN;
    assert.equal(rN.outcome, UPDATE_OUTCOME.PROCESSED);
    assert.equal(sent.length, 1);
  }, { coachDelay: () => gate.wait() });
});

test('★★★ C1b: N 還沒結案時，N+1 即使單獨進來也要讓路（不可以超車）', async () => {
  await withEnv(async ({ db, mkProcessor }) => {
    // N 已經被認領、還在處理中（租約還活著）
    await db.claimTelegramUpdate(2100, { owner: 'busy-attempt', leaseMs: 300_000, now: NOW });
    // 對話鍵，不是內部 user_id（TG-R04 之後排序身分改成從結構推導）
    await db.setTelegramUpdateConversation(2100, {
      owner: 'busy-attempt', conversationKey: 'tg:5001', now: NOW,
    });

    const r = await mkProcessor().processUpdate(upd(2101, '5001', 'N+1'));
    assert.equal(r.outcome, UPDATE_OUTCOME.RETRY);
    assert.equal(r.reason, 'earlier_update_pending',
      '★ 理由必須是「有更早的還沒結案」，而不是碰巧被鎖擋住');
  });
});

test('★★★ C2: 澄清流程 —— 問題落地之前，澄清回覆不會被處理', async () => {
  const seen = [];
  const gate = makeGate();

  await withEnv(async ({ sent, mkProcessor }) => {
    // ⚠️ 閘門要掛在**寫入交易之外**的地方。
    //
    //  · 不能掛在 coach 上：「為什麼我這麼累」現在走 cause_query，那條路是
    //    全確定性的、根本不呼叫 LLM，閘門永遠不會觸發 → 測試卡死。
    //  · 不能掛在 handleMessage 上：它在 processTelegramOperation 的寫入
    //    交易裡面，卡在那裡等於抱著交易不放，後面那一則會拿不到所有權。
    //
    // resolveUser 在認領之後、動作交易之前被呼叫，剛好是我們要的位置。
    const q = mkProcessor({
      workerId: 'q',
      onHandle: ({ text }) => { seen.push(text); },
      resolveDelay: () => gate.wait(),
    });
    const c = mkProcessor({ workerId: 'c', onHandle: ({ text }) => { seen.push(text); } });

    const pQ = q.processUpdate(upd(3000, '5001', '為什麼我這麼累'));
    await gate.entered;

    const clar = await c.processUpdate(upd(3001, '5001', '昨天喝了兩杯'));
    assert.equal(clar.outcome, UPDATE_OUTCOME.RETRY,
      '★ 澄清不可以在問題的狀態落地之前就被處理');
    // 真正要保證的是「澄清沒有先跑」，而不是問題跑到哪一步了
    //（閘門現在卡在 resolveUser，問題還沒進到 handleMessage）。
    assert.ok(!seen.includes('昨天喝了兩杯'),
      '★ 澄清的業務邏輯絕不可以在問題之前執行');

    gate.release();
    const rQ = await pQ;
    assert.equal(rQ.outcome, UPDATE_OUTCOME.PROCESSED,
      `★ 問題本身必須處理完（實際 ${rQ.outcome}/${rQ.reason}）`);

    // 問題結案之後，澄清就能進來了
    const retry = await mkProcessor({ workerId: 'c2' }).processUpdate(upd(3001, '5001', '昨天喝了兩杯'));
    assert.equal(retry.outcome, UPDATE_OUTCOME.PROCESSED,
      `★ 前一則結案後就要能處理（實際 ${retry.outcome}/${retry.reason}）`);
    assert.equal(sent.length, 2);
  });
});

test('★★★ C3: 通道被崩潰的執行鎖住 → 租約過期後自動恢復', async () => {
  await withEnv(async ({ db, alice, sent, mkProcessor }) => {
    // 有人鎖了 Alice 的對話通道然後死了
    const lane = 'telegram_lane:tg:5001';
    await db.acquireLock(lane, {
      ttlMs: 1_000, owner: 'dead-attempt',
      now: new Date(NOW.getTime() - 3600_000),
    });
    // 租約早就過期 → 新的執行要能拿到
    const r = await mkProcessor().processUpdate(upd(4000, '5001'));
    assert.equal(r.outcome, UPDATE_OUTCOME.PROCESSED, '★ 崩潰不可以永久卡住一個使用者');
    assert.equal(sent.length, 1);
  });
});

test('★★★ C4: Alice 的通道被佔住時，Bob 仍然照常處理', async () => {
  await withEnv(async ({ db, alice, sent, mkProcessor }) => {
    await db.acquireLock('telegram_lane:tg:5001', {
      ttlMs: 300_000, owner: 'alice-busy', now: NOW,
    });
    const rA = await mkProcessor().processUpdate(upd(5000, '5001'));
    const rB = await mkProcessor().processUpdate(upd(5001, '5002'));

    assert.equal(rA.outcome, UPDATE_OUTCOME.RETRY, '★ Alice 要讓路');
    assert.equal(rB.outcome, UPDATE_OUTCOME.PROCESSED, '★ Bob 不可以被 Alice 拖累');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].chatId, '5002');
  });
});

test('★★★ C5: 通道是 per-user 的 —— 多個使用者不會互相排隊', async () => {
  // 要證明的是「這一輪加的 per-user 通道沒有製造全域瓶頸」：
  // 每個人有自己的鎖，握著任何一個都不會擋到別人。
  //
  // ⚠️ 這裡刻意**不**用「同時打 N 個請求」來量併發。本機 SQLite 的檔案型
  // 儲存本來就不接受多個同時進行的寫入交易（會直接 SQLITE_BUSY），那是儲存
  // 引擎的性質，不是通道設計造成的。真發生時每一則都會拿到 retry → Telegram
  // 重送，語義上安全，但拿它當併發指標會量到錯的東西。
  const { db, cleanup } = tempDb();
  try {
    await db.migrate();
    const users = [];
    for (let i = 0; i < 5; i += 1) {
      const u = await db.createUser({ displayName: `U${i}`, timezone: 'Asia/Taipei' });
      await db.linkTelegram({ chatId: String(6000 + i), userId: u.id });
      users.push(u);
    }

    // 1) 每個人的通道名稱都不一樣（沒有共用的全域鎖）
    const names = users.map((u) => `telegram_lane:${u.id}`);
    assert.equal(new Set(names).size, users.length, '★ 通道必須是 per-user');

    // 2) 同時握住**每一個人**的通道都不會互相擋
    const owners = [];
    for (const n of names) {
      const owner = await db.acquireLock(n, { ttlMs: 300_000, now: NOW });
      assert.ok(owner, `★ ${n} 應該拿得到（別人的鎖不該擋住）`);
      owners.push({ n, owner });
    }
    // 3) 但同一個人的第二個請求會被擋下
    const again = await db.acquireLock(names[0], { ttlMs: 300_000, now: NOW });
    assert.equal(again, null, '★ 同一個人一次只能有一則');

    for (const { n, owner } of owners) await db.releaseLock(n, owner);
    assert.ok(await db.acquireLock(names[0], { ttlMs: 1_000, now: NOW }),
      '★ 放掉之後要能再拿');
  } finally {
    db.close();
    cleanup();
  }
});

test('★★★ C5b: 依序處理多個使用者 → 每個人都成功，互不汙染', async () => {
  await withEnv(async ({ db, alice, bob, sent, mkProcessor }) => {
    await mkProcessor({ workerId: 'a' }).processUpdate(upd(7000, '5001'));
    await mkProcessor({ workerId: 'b' }).processUpdate(upd(7001, '5002'));

    assert.equal(sent.length, 2);
    assert.deepEqual(sent.map((x) => x.chatId), ['5001', '5002']);
    assert.equal(await journalCount(db, alice.id), 1, '★ Alice 只有自己那筆');
    assert.equal(await journalCount(db, bob.id), 1, '★ Bob 只有自己那筆');
  });
});

// ===========================================================================
// 遷移安全（v6 → v7，純加欄位）
// ===========================================================================

test('★★★ TG-R05 遷移: 舊收據只有「證明得了」的才算送達', async () => {
  // v7 之前的順序是「提交收據 → 送出 → 標記 COMPLETED」，所以：
  //   收據在 + 那一則 COMPLETED  ⇒ 當時送出去**成功了**（可以證明）
  //   收據在 + 那一則沒 COMPLETED ⇒ 崩潰在中間，送了沒有**證明不了**
  const { db, cleanup } = tempDb();
  try {
    await db.migrate();
    // 退回 v6 形狀
    await db.raw.execute('DROP TABLE telegram_operations');
    await db.raw.execute(`CREATE TABLE telegram_operations (
      update_id INTEGER PRIMARY KEY, result_json TEXT NOT NULL, committed_at TEXT NOT NULL)`);
    const receipt = (id) => db.raw.execute({
      sql: 'INSERT INTO telegram_operations (update_id, result_json, committed_at) VALUES (?,?,?)',
      args: [id, JSON.stringify({ chatId: '5001', reply: '舊回覆', userId: 'u1' }), NOW.toISOString()],
    });
    await receipt(11);   // 會有 COMPLETED → 可以證明送出去了
    await receipt(12);   // 只有收據，那一則沒走到 COMPLETED → 證明不了
    await receipt(13);   // 連 processed 列都沒有 → 證明不了

    await db.raw.execute({
      sql: `INSERT INTO telegram_processed_updates (update_id, processed_at, status, attempts)
            VALUES (?,?,?,1)`,
      args: [11, NOW.toISOString(), TELEGRAM_UPDATE_STATUS.COMPLETED],
    });
    await db.raw.execute({
      sql: `INSERT INTO telegram_processed_updates (update_id, processed_at, status, attempts)
            VALUES (?,?,?,1)`,
      args: [12, NOW.toISOString(), TELEGRAM_UPDATE_STATUS.PROCESSING],
    });
    await db.raw.execute('DELETE FROM schema_version');

    const summary = await db.migrate();
    assert.deepEqual(summary.rebuilt, [], '★ 不可以重建（會清掉歷史收據）');

    assert.equal((await db.getTelegramOperation(11)).deliveryState,
      TELEGRAM_DELIVERY_STATE.DELIVERED,
      '★ COMPLETED 反過來證明了當時 sendReply 沒有拋錯 → 可以算送達');
    assert.equal((await db.getTelegramOperation(12)).deliveryState,
      TELEGRAM_DELIVERY_STATE.AMBIGUOUS,
      '★ 崩潰在中間的證明不了 —— 不可以宣稱送達');
    assert.equal((await db.getTelegramOperation(13)).deliveryState,
      TELEGRAM_DELIVERY_STATE.AMBIGUOUS,
      '★ 沒有任何證據的一律保守');
  } finally {
    db.close();
    cleanup();
  }
});

test('★★★ TG-R05: 不確定的舊收據不會被自動重送', async () => {
  await withEnv(async ({ db, sent, mkProcessor }) => {
    // 造出一則「有收據、但送達不確定」的舊資料
    await db.raw.execute({
      sql: `INSERT INTO telegram_operations
              (update_id, result_json, committed_at, delivery_state, delivery_attempts)
            VALUES (?,?,?,?,0)`,
      args: [2200, JSON.stringify({ chatId: '5001', reply: '舊回覆', userId: 'u1' }),
        NOW.toISOString(), TELEGRAM_DELIVERY_STATE.AMBIGUOUS],
    });
    const r = await mkProcessor().processUpdate(upd(2200, '5001'));
    assert.equal(sent.length, 0, '★ 不確定的舊收據絕不可以被重新發出去');
    assert.ok([UPDATE_OUTCOME.AMBIGUOUS_DELIVERY, UPDATE_OUTCOME.PROCESSED].includes(r.outcome));
    assert.equal((await db.getTelegramOperation(2200)).deliveryState,
      TELEGRAM_DELIVERY_STATE.AMBIGUOUS, '★ 狀態維持不變');
  });
});

test('★★ TG-R05: 加欄位的預設值是保守的那一邊（回填沒跑到也安全）', () => {
  const spec = ADDITIVE_COLUMNS.find(
    (c) => c.table === 'telegram_operations' && c.column === 'delivery_state',
  );
  assert.ok(spec, '★ 必須有這個加欄位規格');
  assert.match(spec.ddl, new RegExp(`DEFAULT '${TELEGRAM_DELIVERY_STATE.AMBIGUOUS}'`),
    '★ 預設必須是 AMBIGUOUS —— 不宣稱送達，也不會被自動重送');
  assert.ok(spec.backfill, '★ 必須有回填，才能把證明得了的升級成 DELIVERED');
  assert.match(spec.backfill, /status = 'COMPLETED'/,
    '★ 升級的證據必須是那一則真的走到了 COMPLETED');
});

test('★★ 遷移: 重複跑是冪等的', async () => {
  const { db, cleanup } = tempDb();
  try {
    await db.migrate();
    const s2 = await db.migrate();
    assert.deepEqual(s2.columnsAdded ?? [], []);
  } finally {
    db.close();
    cleanup();
  }
});
