/**
 * V1.1 final audit — H-03 / H-04 的對抗性回歸。
 *
 *   H-03  被放棄的舊 Telegram 處理程序恢復執行之後，仍然能把自己的
 *         operation 推進到 DELIVERY_STARTED 並送出 → 對話順序被破壞
 *
 *   H-04  HTTP 回應已經拿到，但**讀取 body** 失敗 → 舊版分類成「確定失敗」
 *         → 自動重送 → 使用者收到兩則一樣的回覆
 *
 * 兩題都不打真的 Telegram：H-04 用一個會在指定階段爆掉的 fetch 替身。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createDb } from './localDb.js';
import { createTelegram } from '../src/telegram.js';
import { createTelegramApi, TelegramApiError } from '../src/bot/api.js';
import { SEND_OUTCOME, classifySendOutcome } from '../src/sendOutcome.js';
import { TELEGRAM_DELIVERY_STATE, TELEGRAM_UPDATE_STATUS } from '../src/schema.js';

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v11-tg-'));
  const db = createDb({ url: `file:${path.join(dir, 't.db')}` });
  return { db, cleanup: () => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

// ===========================================================================
// H-04 —— 送出結果分類
// ===========================================================================

/**
 * 一個可以在**任何一個階段**壞掉的 fetch 替身。
 *
 * 這是這一題的重點：一次送出有五個階段，而它們的可重送性完全不同。
 * 只有真的走到「Telegram 回應了而且說它沒收」才可以重送。
 */
function fetchThatFails(stage, { status = 200 } = {}) {
  return async () => {
    if (stage === 'connect') {
      const err = new Error('socket hang up');
      err.cause = { code: 'ECONNRESET' };
      throw err;
    }
    return {
      ok: status >= 200 && status < 300,
      status,
      async text() {
        if (stage === 'body_read') {
          const err = new Error('aborted');
          err.cause = { code: 'ECONNRESET' };
          throw err;
        }
        if (stage === 'body_truncated') return '{"ok":true,"resul';
        if (stage === 'no_message_id') return '{"ok":true,"result":{}}';
        if (stage === 'ok_false') return '{"ok":false,"description":"chat not found"}';
        return '{"ok":true,"result":{"message_id":42}}';
      },
    };
  };
}

const tg = (fetchImpl) => createTelegram({
  botToken: 't', chatId: '1', fetchImpl,
});

test('★★★ H-04/1: HTTP 200 之後 body 讀取失敗 → AMBIGUOUS（絕不自動重送）', async () => {
  // 拿到 200 的那一刻，Telegram 就已經接受並投遞了訊息。
  // body 讀不到只是**我們**不知道，不是它沒收到。
  await assert.rejects(
    () => tg(fetchThatFails('body_read')).send('x'),
    (err) => {
      assert.equal(classifySendOutcome(err), SEND_OUTCOME.AMBIGUOUS,
        '★ 這是 H-04 的核心：絕不可以被分類成確定失敗');
      assert.equal(err.sendStage, 'body_read');
      return true;
    },
  );
});

test('★★★ H-04/2: 截斷的成功回應 → AMBIGUOUS（不宣稱送達，也不重送）', async () => {
  await assert.rejects(
    () => tg(fetchThatFails('body_truncated')).send('x'),
    (err) => {
      assert.equal(classifySendOutcome(err), SEND_OUTCOME.AMBIGUOUS);
      assert.equal(err.sendStage, 'body_parse');
      return true;
    },
  );
});

test('★★★ H-04/3: ok:true 但沒有 message_id → AMBIGUOUS（成功的形狀不完整）', async () => {
  await assert.rejects(
    () => tg(fetchThatFails('no_message_id')).send('x'),
    (err) => {
      assert.equal(classifySendOutcome(err), SEND_OUTCOME.AMBIGUOUS);
      assert.equal(err.sendStage, 'success_shape');
      return true;
    },
  );
});

test('★★★ H-04/4: Telegram 親口拒收 → DEFINITE_FAILURE（可以安全重送）', async () => {
  for (const [stage, status] of [['ok_false', 200], ['rejected', 400], ['rejected', 500]]) {
    await assert.rejects(
      () => tg(fetchThatFails(stage, { status })).send('x'),
      (err) => {
        assert.equal(classifySendOutcome(err), SEND_OUTCOME.DEFINITE_FAILURE,
          `★ ${stage}/${status} 是明確拒收`);
        return true;
      },
    );
  }
});

test('★★★ H-04/5: 非 2xx 的 body 讀不到 → 仍然是 DEFINITE_FAILURE（狀態碼就夠了）', async () => {
  // 500 + body 讀失敗：Telegram 已經說了「我沒收」，body 是什麼不重要。
  const fetchImpl = async () => ({
    ok: false,
    status: 500,
    async text() { throw new Error('aborted'); },
  });
  await assert.rejects(
    () => tg(fetchImpl).send('x'),
    (err) => {
      assert.equal(classifySendOutcome(err), SEND_OUTCOME.DEFINITE_FAILURE);
      return true;
    },
  );
});

test('★★★ H-04/6: 連線階段 —— 只有「確定沒連上」才算確定失敗', async () => {
  // ECONNRESET：連線建立過了，請求可能已經送出去 → 模糊
  await assert.rejects(
    () => tg(fetchThatFails('connect')).send('x'),
    (err) => {
      assert.equal(classifySendOutcome(err), SEND_OUTCOME.AMBIGUOUS);
      return true;
    },
  );
  // ENOTFOUND：DNS 都查不到，請求從來沒離開本機 → 確定失敗
  const dnsFail = async () => {
    const err = new Error('getaddrinfo ENOTFOUND');
    err.cause = { code: 'ENOTFOUND' };
    throw err;
  };
  await assert.rejects(
    () => tg(dnsFail).send('x'),
    (err) => {
      assert.equal(classifySendOutcome(err), SEND_OUTCOME.DEFINITE_FAILURE);
      return true;
    },
  );
});

test('★★★ H-04/7: 正常成功仍然正常（修正不可以把好路徑弄壞）', async () => {
  const r = await tg(fetchThatFails('none')).send('hello');
  assert.equal(r.messageId, 42);
  assert.equal(r.dryRun, false);
});

test('★★★ H-04/8: 預設是 fail closed —— 來歷不明的錯誤不可以被當成確定失敗', async () => {
  // 舊版的預設是 definite_failure（「不認識就放心重送」）。
  // 那個預設本身就是 bug：不知道發生什麼事的時候，唯一安全的假設是
  // 「可能已經送出去了」。
  assert.equal(classifySendOutcome(new Error('something odd')), SEND_OUTCOME.AMBIGUOUS);
  assert.equal(classifySendOutcome(null), SEND_OUTCOME.AMBIGUOUS);
  assert.equal(classifySendOutcome({}), SEND_OUTCOME.AMBIGUOUS);
});

test('★★★ H-04/9: bot 那條路（bot/api.js）分類必須完全一致', async () => {
  // 兩條送出路徑以前各判各的。分類只要有一邊判錯就會產生重複訊息，
  // 所以它們現在共用同一個判準 —— 這一題就是在釘住「同一個」。
  const api = createTelegramApi({ botToken: 't', fetchImpl: fetchThatFails('body_read') });
  await assert.rejects(
    () => api.sendMessage('1', 'x'),
    (err) => {
      assert.ok(err instanceof TelegramApiError);
      assert.equal(classifySendOutcome(err), SEND_OUTCOME.AMBIGUOUS);
      assert.equal(err.sendStage, 'body_read');
      return true;
    },
  );

  const shape = createTelegramApi({ botToken: 't', fetchImpl: fetchThatFails('no_message_id') });
  await assert.rejects(
    () => shape.sendMessage('1', 'x'),
    (err) => {
      assert.equal(classifySendOutcome(err), SEND_OUTCOME.AMBIGUOUS);
      return true;
    },
  );
});

// ===========================================================================
// H-03 —— 被放棄的處理程序不可以送出
// ===========================================================================

/** 造一則「已認領並在處理中」的 update，外加它的回覆收據。 */
async function seedProcessing(db, { updateId, conversationKey, owner, leaseMs = 60_000 }) {
  await db.raw.execute({
    sql: `INSERT INTO telegram_processed_updates
            (update_id, status, owner, claimed_at, lease_expires_at, attempts, user_id)
          VALUES (?, ?, ?, ?, ?, 1, ?)`,
    args: [updateId, TELEGRAM_UPDATE_STATUS.PROCESSING, owner,
      new Date().toISOString(), new Date(Date.now() + leaseMs).toISOString(), conversationKey],
  });
  await db.raw.execute({
    sql: `INSERT INTO telegram_operations
            (update_id, result_json, committed_at, delivery_state, delivery_attempts)
          VALUES (?, ?, ?, ?, 0)`,
    args: [updateId, JSON.stringify({ reply: 'hi' }), new Date().toISOString(),
      TELEGRAM_DELIVERY_STATE.ACTION_READY],
  });
}

test('★★★ H-03/1: N 被放棄 → N+1 送出 → N 恢復執行 → N 不可以開始送出', async () => {
  const { db, cleanup } = tempDb();
  try {
    await db.migrate();
    const conv = 'tg:5001';

    await seedProcessing(db, { updateId: 100, conversationKey: conv, owner: 'owner-N' });
    await seedProcessing(db, { updateId: 101, conversationKey: conv, owner: 'owner-N1' });

    // N 卡住 → 租約過期 → 被原子地終結掉（owner 與租約一起清空）。
    await db.raw.execute({
      sql: `UPDATE telegram_processed_updates
               SET status = ?, owner = NULL, lease_expires_at = NULL
             WHERE update_id = 100`,
      args: [TELEGRAM_UPDATE_STATUS.ABANDONED],
    });

    // N+1 現在是對話裡最早的未終局訊息 → 拿得到送出授權。
    assert.equal(
      await db.markDeliveryStarted(101, { owner: 'owner-N1', conversationKey: conv }), true,
      '★ N+1 必須能正常送出',
    );
    await db.markDelivered(101, { owner: 'owner-N1', messageId: 1 });

    // ★ N 的 JavaScript 恢復執行。它的收據仍然是 ACTION_READY，
    // 舊版就是在這裡放行它 —— 於是使用者在 N+1 之後才收到 N。
    assert.equal(
      await db.markDeliveryStarted(100, { owner: 'owner-N', conversationKey: conv }), false,
      '★★★ 失去所有權的處理程序絕不可以開始送出',
    );

    const op = await db.getTelegramOperation(100);
    assert.equal(op.deliveryState, TELEGRAM_DELIVERY_STATE.ACTION_READY,
      '★ 而且它不可以留下任何「送出中」的痕跡');
    assert.equal(op.deliveryAttempts, 0);
  } finally { cleanup(); }
});

test('★★★ H-03/2: 租約過期（還沒被終結）也不可以送出', async () => {
  const { db, cleanup } = tempDb();
  try {
    await db.migrate();
    const conv = 'tg:5002';
    await seedProcessing(db, {
      updateId: 200, conversationKey: conv, owner: 'owner-A', leaseMs: -1_000,  // 已過期
    });
    assert.equal(
      await db.markDeliveryStarted(200, { owner: 'owner-A', conversationKey: conv }), false,
      '★ 租約過期就沒有權力製造外部副作用',
    );
  } finally { cleanup(); }
});

test('★★★ H-03/3: 對話裡還有更早、未終局的訊息 → 沒有排序權，不可以送出', async () => {
  const { db, cleanup } = tempDb();
  try {
    await db.migrate();
    const conv = 'tg:5003';
    // N 還在正常處理中（租約有效，沒有被放棄）。
    await seedProcessing(db, { updateId: 300, conversationKey: conv, owner: 'owner-N' });
    await seedProcessing(db, { updateId: 301, conversationKey: conv, owner: 'owner-N1' });

    assert.equal(
      await db.markDeliveryStarted(301, { owner: 'owner-N1', conversationKey: conv }), false,
      '★★★ N+1 不可以超車一個還活著的 N',
    );
    // N 自己可以（它才是最早的）。
    assert.equal(
      await db.markDeliveryStarted(300, { owner: 'owner-N', conversationKey: conv }), true,
    );
  } finally { cleanup(); }
});

test('★★★ H-03/4: 換了 owner / 換了對話鍵都不可以送出', async () => {
  const { db, cleanup } = tempDb();
  try {
    await db.migrate();
    const conv = 'tg:5004';
    await seedProcessing(db, { updateId: 400, conversationKey: conv, owner: 'owner-A' });

    assert.equal(
      await db.markDeliveryStarted(400, { owner: 'someone-else', conversationKey: conv }), false,
      '★ 別人的 owner 不算數',
    );
    assert.equal(
      await db.markDeliveryStarted(400, { owner: 'owner-A', conversationKey: 'tg:9999' }), false,
      '★ 對話鍵對不上也不算數',
    );
    assert.equal(
      await db.markDeliveryStarted(400, { owner: 'owner-A' }), false,
      '★ 證明不了對話身分就 fail closed',
    );
    // 全部對上才可以。
    assert.equal(
      await db.markDeliveryStarted(400, { owner: 'owner-A', conversationKey: conv }), true,
    );
  } finally { cleanup(); }
});

test('★★★ H-03/5: 已經開始送出的收據不可以被再啟動一次（重播保護仍在）', async () => {
  const { db, cleanup } = tempDb();
  try {
    await db.migrate();
    const conv = 'tg:5005';
    await seedProcessing(db, { updateId: 500, conversationKey: conv, owner: 'owner-A' });
    assert.equal(
      await db.markDeliveryStarted(500, { owner: 'owner-A', conversationKey: conv }), true,
    );
    assert.equal(
      await db.markDeliveryStarted(500, { owner: 'owner-A', conversationKey: conv }), false,
      '★ DELIVERY_STARTED 是終局，不可以再送一次',
    );
  } finally { cleanup(); }
});

test('★★★ H-03/6: 不同對話之間互不影響（多使用者隔離）', async () => {
  const { db, cleanup } = tempDb();
  try {
    await db.migrate();
    // Alice 的對話裡有一則很早、還沒做完的訊息。
    await seedProcessing(db, { updateId: 600, conversationKey: 'tg:alice', owner: 'a1' });
    // Bob 的訊息 update_id 比較大，但它屬於**另一個**對話。
    await seedProcessing(db, { updateId: 601, conversationKey: 'tg:bob', owner: 'b1' });

    assert.equal(
      await db.markDeliveryStarted(601, { owner: 'b1', conversationKey: 'tg:bob' }), true,
      '★ Alice 的未完成訊息不可以卡住 Bob',
    );
  } finally { cleanup(); }
});
