/**
 * 主動問題過期生命週期（V1.1 Phase 5）。
 *
 * 完整的狀態機：
 *   OPEN → ANSWERED
 *   OPEN → EXPIRED + 事件 NO_RESPONSE
 *   OPEN → SUPERSEDED
 *
 * 這個檔案要證明的三件事，重要性由高到低：
 *   1. NO_RESPONSE **不會**污染反騷擾政策（冷卻 / 每日上限 / 新鮮度）
 *   2. 終局狀態只會有一個贏家（收割器 vs 使用者回答）
 *   3. 收割器冪等、重啟安全、per-user 隔離
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createDb } from '../src/db.js';
import { createBotStore } from '../src/botStore.js';
import { reapExpiredProactiveQuestions } from '../src/proactiveReaper.js';
import { decide } from '../src/attention.js';
import {
  PROACTIVE_DECISION, PROACTIVE_OUTCOME, PROACTIVE_QUESTION_INTENT,
} from '../src/schema.js';
import { ANTI_SPAM_POLICY } from '../src/proactivePolicy.js';
import { TELEGRAM_BOT } from '../src/config.js';
import { DEVIATION } from '../src/analytics/anomaly.js';
import { ALICE, BOB, seedAliceAndBob } from './users.js';

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v11-noresp-'));
  const db = createDb({ url: `file:${path.join(dir, 't.db')}` });
  return { db, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

async function withDb(fn) {
  const { db, cleanup } = tempDb();
  try {
    await db.migrate();
    await seedAliceAndBob(db);
    await fn(db);
  } finally {
    db.close();
    cleanup();
  }
}

const T0 = new Date('2026-09-09T07:00:00Z');
const later = (ms) => new Date(T0.getTime() + ms);
const AFTER_TTL = later(ANTI_SPAM_POLICY.QUESTION_TTL_MS + 60_000);

/**
 * 開一個「主動問題 + 對應事件」的完整組合，跟 proactiveAgent 實際做的一樣。
 * @returns {{eventId:number, questionId:number}}
 */
async function askProactive(db, user, {
  key = 'k1', code = 'HRV_LOW', now = T0, decision = PROACTIVE_DECISION.ASK_CONTEXT,
} = {}) {
  const claim = await db.claimProactiveEvent(user.id, {
    healthDate: '2026-09-09',
    idempotencyKey: key,
    signals: [{ code, metric: 'hrv', level: DEVIATION.STRONG }],
    decision,
    reason: { question_category: 'alcohol' },
    policyVersion: 'p1',
    messageText: '昨天有喝酒嗎？',
  }, { now });

  const questionId = await db.openPendingQuestion(user.id, {
    chatId: user.chatId,
    question: '昨天有喝酒嗎？',
    intent: PROACTIVE_QUESTION_INTENT,
    contextJson: { health_date: '2026-09-09', proactive_event_id: claim.id, category: 'alcohol' },
    ttlMs: ANTI_SPAM_POLICY.QUESTION_TTL_MS,
  }, { now });

  await db.markProactiveEventSent(user.id, claim.id, { pendingQuestionId: questionId }, { now });
  return { eventId: claim.id, questionId };
}

const eventById = async (db, userId, id) => (await db.getRecentProactiveEvents(userId, {
  sinceIso: '2026-01-01T00:00:00.000Z', limit: 100,
})).find((e) => e.id === id);

const questionRow = async (db, id) => (await db.raw.execute({
  sql: 'SELECT * FROM pending_questions WHERE id = ?', args: [id],
})).rows[0];

// ===========================================================================
// TTL 分離
// ===========================================================================

test('★ 主動問題的 TTL 是獨立常數，與反應式 Q&A 的 TTL 分開', () => {
  assert.equal(typeof ANTI_SPAM_POLICY.QUESTION_TTL_MS, 'number');
  assert.ok(ANTI_SPAM_POLICY.QUESTION_TTL_MS > 0);
  // 目前刻意等值（向後相容），但必須是**兩個各自可調的常數**
  assert.notEqual(
    Object.getOwnPropertyDescriptor(ANTI_SPAM_POLICY, 'QUESTION_TTL_MS'),
    undefined,
  );
  assert.ok(Object.hasOwn(TELEGRAM_BOT, 'PENDING_TTL_MS'));
});

test('主動問題用 QUESTION_TTL_MS 設定到期時間', async () => {
  await withDb(async (db) => {
    const { questionId } = await askProactive(db, ALICE);
    const row = await questionRow(db, questionId);
    const expected = new Date(T0.getTime() + ANTI_SPAM_POLICY.QUESTION_TTL_MS).toISOString();
    assert.equal(row.expires_at, expected);
  });
});

// ===========================================================================
// 基本收割行為
// ===========================================================================

test('★★ 未回答的主動問題過期後 → EXPIRED + 事件 NO_RESPONSE + resolved_at', async () => {
  await withDb(async (db) => {
    const { eventId, questionId } = await askProactive(db, ALICE);

    const before = await eventById(db, ALICE.id, eventId);
    assert.equal(before.outcome, null);
    assert.equal(before.resolvedAt, null);

    const res = await reapExpiredProactiveQuestions({ db, userId: ALICE.id, now: AFTER_TTL });
    assert.deepEqual(res, { expired: 1, repaired: 0, noResponse: 1, skipped: 0 });

    assert.equal((await questionRow(db, questionId)).status, 'EXPIRED');
    const after = await eventById(db, ALICE.id, eventId);
    assert.equal(after.outcome, PROACTIVE_OUTCOME.NO_RESPONSE);
    assert.ok(after.resolvedAt);
  });
});

test('尚未過期的問題完全不被碰', async () => {
  await withDb(async (db) => {
    const { eventId, questionId } = await askProactive(db, ALICE);

    const res = await reapExpiredProactiveQuestions({
      db, userId: ALICE.id, now: later(60_000),
    });
    assert.deepEqual(res, { expired: 0, repaired: 0, noResponse: 0, skipped: 0 });

    assert.equal((await questionRow(db, questionId)).status, 'OPEN');
    assert.equal((await eventById(db, ALICE.id, eventId)).outcome, null);
  });
});

test('★ 收割器是冪等的：重跑不會重複寫，也不會改變任何東西', async () => {
  await withDb(async (db) => {
    const { eventId } = await askProactive(db, ALICE);

    const first = await reapExpiredProactiveQuestions({ db, userId: ALICE.id, now: AFTER_TTL });
    const afterFirst = await eventById(db, ALICE.id, eventId);

    const second = await reapExpiredProactiveQuestions({
      db, userId: ALICE.id, now: later(ANTI_SPAM_POLICY.QUESTION_TTL_MS + 3600_000),
    });
    const afterSecond = await eventById(db, ALICE.id, eventId);

    assert.deepEqual(first, { expired: 1, repaired: 0, noResponse: 1, skipped: 0 });
    // 已經修好的列會退出待收清單 → 第二次是真正的零工作量，不是
    // 「又拜訪一次然後跳過」。這正是 EXISTS 條件存在的理由。
    assert.deepEqual(second, { expired: 0, repaired: 0, noResponse: 0, skipped: 0 });
    // resolved_at 不可以被第二次收割改掉
    assert.equal(afterSecond.resolvedAt, afterFirst.resolvedAt);
    assert.equal(afterSecond.outcome, PROACTIVE_OUTCOME.NO_RESPONSE);
  });
});

test('沒有任何過期問題時是乾淨的 no-op', async () => {
  await withDb(async (db) => {
    const res = await reapExpiredProactiveQuestions({ db, userId: ALICE.id, now: AFTER_TTL });
    assert.deepEqual(res, { expired: 0, repaired: 0, noResponse: 0, skipped: 0 });
  });
});

// ===========================================================================
// 已經有結果的絕不被覆寫
// ===========================================================================

test('★★ 已回答的問題絕不會被收割成 NO_RESPONSE', async () => {
  await withDb(async (db) => {
    const { eventId, questionId } = await askProactive(db, ALICE);

    // 使用者在期限內回答
    await db.resolvePendingQuestion(ALICE.id, questionId, '有喝兩杯', { now: later(60_000) });
    await db.resolveProactiveEvent(
      ALICE.id, eventId, PROACTIVE_OUTCOME.EXPLAINED, { now: later(60_000) },
    );

    const res = await reapExpiredProactiveQuestions({ db, userId: ALICE.id, now: AFTER_TTL });
    assert.equal(res.noResponse, 0);

    const ev = await eventById(db, ALICE.id, eventId);
    assert.equal(ev.outcome, PROACTIVE_OUTCOME.EXPLAINED);
    assert.equal((await questionRow(db, questionId)).status, 'ANSWERED');
  });
});

test('★★ 回答了但事件還沒收尾（reanalysis 掛掉）→ 問題不是 OPEN，收割器不動它', async () => {
  await withDb(async (db) => {
    const { eventId, questionId } = await askProactive(db, ALICE);
    // 只 resolve pending，事件故意留 NULL（模擬 reanalysis 拋錯）
    await db.resolvePendingQuestion(ALICE.id, questionId, '有', { now: later(60_000) });

    const res = await reapExpiredProactiveQuestions({ db, userId: ALICE.id, now: AFTER_TTL });
    assert.deepEqual(res, { expired: 0, repaired: 0, noResponse: 0, skipped: 0 });

    // 使用者確實回答過，所以絕不可以被記成「沒回應」
    assert.equal((await eventById(db, ALICE.id, eventId)).outcome, null);
  });
});

test('★★ SUPERSEDED 的問題不會變成 NO_RESPONSE', async () => {
  await withDb(async (db) => {
    const first = await askProactive(db, ALICE, { key: 'k1' });
    // 開第二題 → 第一題被 SUPERSEDED
    const second = await askProactive(db, ALICE, { key: 'k2', now: later(1000) });

    assert.equal((await questionRow(db, first.questionId)).status, 'SUPERSEDED');

    const res = await reapExpiredProactiveQuestions({ db, userId: ALICE.id, now: AFTER_TTL });

    // 只有第二題（還 OPEN 且已過期）被收
    assert.equal(res.expired, 1);
    assert.equal((await eventById(db, ALICE.id, first.eventId)).outcome, null);
    assert.equal(
      (await eventById(db, ALICE.id, second.eventId)).outcome,
      PROACTIVE_OUTCOME.NO_RESPONSE,
    );
  });
});

test('★★ 遲到的回答不能覆寫已經寫下的 NO_RESPONSE', async () => {
  await withDb(async (db) => {
    const { eventId, questionId } = await askProactive(db, ALICE);
    await reapExpiredProactiveQuestions({ db, userId: ALICE.id, now: AFTER_TTL });

    // 使用者很久以後才回：pending 已經不是 OPEN，所以 resolve 失敗
    const ok = await db.resolvePendingQuestion(
      ALICE.id, questionId, '啊我剛看到', { now: later(7200_000) },
    );
    assert.equal(ok, false);

    const ev = await eventById(db, ALICE.id, eventId);
    assert.equal(ev.outcome, PROACTIVE_OUTCOME.NO_RESPONSE);
  });
});

test('★★ resolveProactiveEventIfUnresolved 絕不覆寫既有結果', async () => {
  await withDb(async (db) => {
    const { eventId } = await askProactive(db, ALICE);

    const first = await db.resolveProactiveEventIfUnresolved(
      ALICE.id, eventId, PROACTIVE_OUTCOME.EXPLAINED, { now: T0 },
    );
    assert.equal(first, true);

    const second = await db.resolveProactiveEventIfUnresolved(
      ALICE.id, eventId, PROACTIVE_OUTCOME.NO_RESPONSE, { now: AFTER_TTL },
    );
    assert.equal(second, false);

    assert.equal((await eventById(db, ALICE.id, eventId)).outcome, PROACTIVE_OUTCOME.EXPLAINED);
  });
});

// ===========================================================================
// 競態：收割器 vs 使用者回答
// ===========================================================================

test('★★★ 收割器與回答同時發生 → 終局狀態恰好一個贏家', async () => {
  await withDb(async (db) => {
    const { eventId, questionId } = await askProactive(db, ALICE);

    // 兩條路同時搶同一個 OPEN → EXPIRED / ANSWERED 閘門
    const [reapWon, answerWon] = await Promise.all([
      db.expirePendingQuestion(ALICE.id, questionId, { now: AFTER_TTL }),
      db.resolvePendingQuestion(ALICE.id, questionId, '有喝', { now: AFTER_TTL }),
    ]);

    // 恰好一個成功
    assert.equal([reapWon, answerWon].filter(Boolean).length, 1, '只能有一個贏家');

    const status = (await questionRow(db, questionId)).status;
    assert.ok(['EXPIRED', 'ANSWERED'].includes(status));
    assert.equal(status === 'EXPIRED', reapWon);
    assert.equal(status === 'ANSWERED', answerWon);

    // 事件那一層也只會有一個結果
    await db.resolveProactiveEventIfUnresolved(
      ALICE.id, eventId, PROACTIVE_OUTCOME.NO_RESPONSE, { now: AFTER_TTL },
    );
    const ev = await eventById(db, ALICE.id, eventId);
    assert.ok(ev.outcome === PROACTIVE_OUTCOME.NO_RESPONSE || ev.outcome === null);
  });
});

test('★★ 兩個收割器同時跑 → 只寫一次 NO_RESPONSE', async () => {
  await withDb(async (db) => {
    const { eventId } = await askProactive(db, ALICE);

    const [a, b] = await Promise.all([
      reapExpiredProactiveQuestions({ db, userId: ALICE.id, now: AFTER_TTL }),
      reapExpiredProactiveQuestions({ db, userId: ALICE.id, now: AFTER_TTL }),
    ]);

    assert.equal(a.noResponse + b.noResponse, 1, 'NO_RESPONSE 只能被寫一次');
    assert.equal((await eventById(db, ALICE.id, eventId)).outcome, PROACTIVE_OUTCOME.NO_RESPONSE);
  });
});

test('重啟安全：狀態全在 DB，換一個 db 連線收割結果一樣', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v11-restart-'));
  const url = `file:${path.join(dir, 't.db')}`;
  try {
    const db1 = createDb({ url });
    await db1.migrate();
    await seedAliceAndBob(db1);
    const { eventId } = await askProactive(db1, ALICE);
    db1.close();

    // 「process 重啟」
    const db2 = createDb({ url });
    const res = await reapExpiredProactiveQuestions({ db: db2, userId: ALICE.id, now: AFTER_TTL });
    assert.deepEqual(res, { expired: 1, repaired: 0, noResponse: 1, skipped: 0 });
    assert.equal((await eventById(db2, ALICE.id, eventId)).outcome, PROACTIVE_OUTCOME.NO_RESPONSE);
    db2.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// ★★★ 不可以污染反騷擾政策
// ===========================================================================

test('★★★ NO_RESPONSE 不改變冷卻：收割前後 decide() 的結果完全一樣', async () => {
  await withDb(async (db) => {
    await askProactive(db, ALICE, { code: 'HRV_LOW' });

    const sinceIso = '2026-01-01T00:00:00.000Z';
    const signals = [{
      metric: 'hrv', code: 'HRV_LOW', level: DEVIATION.STRONG, direction: 'low',
    }];

    const before = decide({
      signals, now: AFTER_TTL, recentEvents: await db.getRecentProactiveEvents(ALICE.id, { sinceIso }),
    });

    await reapExpiredProactiveQuestions({ db, userId: ALICE.id, now: AFTER_TTL });

    const after = decide({
      signals, now: AFTER_TTL, recentEvents: await db.getRecentProactiveEvents(ALICE.id, { sinceIso }),
    });

    assert.equal(after.decision, before.decision);
    assert.equal(after.reason, before.reason);
    assert.deepEqual(after.factors.masked_by_cooldown, before.factors.masked_by_cooldown);
    assert.equal(after.factors.daily_cap_reached, before.factors.daily_cap_reached);
    assert.equal(after.factors.novel, before.factors.novel);
    assert.equal(after.factors.persistent, before.factors.persistent);
  });
});

test('★★★ NO_RESPONSE 不改變每日上限的計數', async () => {
  await withDb(async (db) => {
    for (let i = 0; i < ANTI_SPAM_POLICY.DAILY_PROACTIVE_CAP; i += 1) {
      await askProactive(db, ALICE, { key: `cap-${i}`, code: `CODE_${i}`, now: later(i * 1000) });
    }
    const sinceIso = '2026-01-01T00:00:00.000Z';
    const signals = [{ metric: 'hrv', code: 'NEW_CODE', level: DEVIATION.STRONG, direction: 'low' }];

    const before = decide({
      signals, now: AFTER_TTL, recentEvents: await db.getRecentProactiveEvents(ALICE.id, { sinceIso }),
    });
    await reapExpiredProactiveQuestions({ db, userId: ALICE.id, now: AFTER_TTL });
    const after = decide({
      signals, now: AFTER_TTL, recentEvents: await db.getRecentProactiveEvents(ALICE.id, { sinceIso }),
    });

    assert.equal(before.factors.daily_cap_reached, true);
    assert.equal(after.factors.daily_cap_reached, true);
    assert.equal(after.decision, before.decision);
  });
});

test('★★ 收割只改 outcome/resolved_at，decision/created_at/signals 原封不動', async () => {
  await withDb(async (db) => {
    const { eventId } = await askProactive(db, ALICE);
    const before = await eventById(db, ALICE.id, eventId);

    await reapExpiredProactiveQuestions({ db, userId: ALICE.id, now: AFTER_TTL });
    const after = await eventById(db, ALICE.id, eventId);

    assert.equal(after.decision, before.decision);
    assert.equal(after.createdAt, before.createdAt);
    assert.deepEqual(after.signals, before.signals);
    assert.equal(after.healthDate, before.healthDate);
    assert.equal(after.idempotencyKey, before.idempotencyKey);
    assert.equal(after.sentAt, before.sentAt);
  });
});

// ===========================================================================
// 範圍與隔離
// ===========================================================================

test('★ 反應式追問（沒有 proactive intent）不會被收割器碰到', async () => {
  await withDb(async (db) => {
    const qid = await db.openPendingQuestion(ALICE.id, {
      chatId: ALICE.chatId,
      question: '你昨天睡得如何？',
      intent: 'followup',           // ← 不是 proactive
      contextJson: {},
      ttlMs: 60_000,
    }, { now: T0 });

    const res = await reapExpiredProactiveQuestions({ db, userId: ALICE.id, now: AFTER_TTL });
    assert.deepEqual(res, { expired: 0, repaired: 0, noResponse: 0, skipped: 0 });
    assert.equal((await questionRow(db, qid)).status, 'OPEN');
  });
});

test('★★★ Alice 的收割完全不影響 Bob', async () => {
  await withDb(async (db) => {
    const a = await askProactive(db, ALICE, { key: 'same-key' });
    const b = await askProactive(db, BOB, { key: 'same-key' }); // 刻意同一把 key

    const res = await reapExpiredProactiveQuestions({ db, userId: ALICE.id, now: AFTER_TTL });
    assert.equal(res.noResponse, 1);

    assert.equal((await eventById(db, ALICE.id, a.eventId)).outcome, PROACTIVE_OUTCOME.NO_RESPONSE);
    assert.equal((await eventById(db, BOB.id, b.eventId)).outcome, null);
    assert.equal((await questionRow(db, b.questionId)).status, 'OPEN');
  });
});

test('★ 收割器不能跨使用者收走別人的問題', async () => {
  await withDb(async (db) => {
    const b = await askProactive(db, BOB);
    // 用 Alice 的身分去收 —— 應該什麼都收不到
    const res = await reapExpiredProactiveQuestions({ db, userId: ALICE.id, now: AFTER_TTL });
    assert.deepEqual(res, { expired: 0, repaired: 0, noResponse: 0, skipped: 0 });
    assert.equal((await questionRow(db, b.questionId)).status, 'OPEN');
  });
});

test('缺 userId 一律拋 MissingUserIdError', async () => {
  await withDb(async (db) => {
    await assert.rejects(
      () => reapExpiredProactiveQuestions({ db, userId: null, now: AFTER_TTL }),
      /缺少 userId/,
    );
  });
});

// ===========================================================================
// 韌性
// ===========================================================================

test('★ 事件查詢失敗不會讓收割器拋錯（維護工作絕不影響主流程）', async () => {
  await withDb(async (db) => {
    await askProactive(db, ALICE);
    const broken = {
      ...db,
      resolveProactiveEventIfUnresolved: async () => { throw new Error('boom'); },
    };
    const res = await reapExpiredProactiveQuestions({ db: broken, userId: ALICE.id, now: AFTER_TTL });
    assert.equal(res.skipped, 1);
    assert.equal(res.noResponse, 0);
  });
});

test('不支援新 store 函式的 db（舊 fake）→ 安全跳過', async () => {
  const res = await reapExpiredProactiveQuestions({
    db: {}, userId: 'u-x', now: AFTER_TTL,
  });
  assert.deepEqual(res, { expired: 0, repaired: 0, noResponse: 0, skipped: 0 });
});

test('★ 問題沒有連到任何事件時，仍然會被收成 EXPIRED（不卡在 OPEN）', async () => {
  await withDb(async (db) => {
    const qid = await db.openPendingQuestion(ALICE.id, {
      chatId: ALICE.chatId,
      question: '孤兒問題',
      intent: PROACTIVE_QUESTION_INTENT,
      contextJson: {},                 // 沒有 proactive_event_id
      ttlMs: ANTI_SPAM_POLICY.QUESTION_TTL_MS,
    }, { now: T0 });

    const res = await reapExpiredProactiveQuestions({ db, userId: ALICE.id, now: AFTER_TTL });
    assert.equal(res.expired, 1);
    assert.equal(res.noResponse, 0);
    assert.equal(res.skipped, 1);
    assert.equal((await questionRow(db, qid)).status, 'EXPIRED');
  });
});

test('★ 惰性過期不會蓋掉剛剛被寫入的回答', async () => {
  await withDb(async (db) => {
    const { questionId } = await askProactive(db, ALICE);
    // 先回答
    await db.resolvePendingQuestion(ALICE.id, questionId, '有', { now: later(60_000) });
    // 再讓惰性過期路徑跑一次（過期時間已到）
    const open = await db.getOpenPendingQuestion(ALICE.id, { now: AFTER_TTL });
    assert.equal(open, null);
    // 狀態必須還是 ANSWERED，不可以被覆寫成 EXPIRED
    assert.equal((await questionRow(db, questionId)).status, 'ANSWERED');
  });
});

// ===========================================================================
// ★★★ F-01 —— 惰性過期先發生時，事件仍然必須收斂到 NO_RESPONSE
//
// `getOpenPendingQuestion()` 的惰性過期會把問題收成 EXPIRED 但不碰事件。
// 它在 proactiveAgent 每次 cron、bot router 每則訊息、`/status` 都會觸發，
// 而且在 runForUser 裡**早於**收割器。舊版收割器只看 status='OPEN'，
// 所以這個半完成狀態永遠修不回來。
// ===========================================================================

test('★★★ F-01: 惰性過期先發生 → 之後的收割仍然補上 NO_RESPONSE', async () => {
  await withDb(async (db) => {
    const { eventId, questionId } = await askProactive(db, ALICE);

    // 這一行就是 proactiveAgent.checkAndAct / bot router / /status 做的事
    const open = await db.getOpenPendingQuestion(ALICE.id, { now: AFTER_TTL });
    assert.equal(open, null);
    assert.equal((await questionRow(db, questionId)).status, 'EXPIRED');
    assert.equal((await eventById(db, ALICE.id, eventId)).outcome, null, '半完成狀態');

    // 收割器必須修得回來
    const res = await reapExpiredProactiveQuestions({ db, userId: ALICE.id, now: AFTER_TTL });
    assert.deepEqual(res, { expired: 0, repaired: 1, noResponse: 1, skipped: 0 });

    const ev = await eventById(db, ALICE.id, eventId);
    assert.equal(ev.outcome, PROACTIVE_OUTCOME.NO_RESPONSE);
    assert.ok(ev.resolvedAt);
  });
});

test('★★★ F-01: 修好之後不會被重複拜訪（收斂到零工作量）', async () => {
  await withDb(async (db) => {
    await askProactive(db, ALICE);
    await db.getOpenPendingQuestion(ALICE.id, { now: AFTER_TTL });

    const first = await reapExpiredProactiveQuestions({ db, userId: ALICE.id, now: AFTER_TTL });
    assert.equal(first.noResponse, 1);

    for (let i = 0; i < 3; i += 1) {
      const again = await reapExpiredProactiveQuestions({
        db, userId: ALICE.id, now: later(ANTI_SPAM_POLICY.QUESTION_TTL_MS + (i + 2) * 3600_000),
      });
      assert.deepEqual(again, { expired: 0, repaired: 0, noResponse: 0, skipped: 0 });
    }
  });
});

test('★★★ F-01: 崩潰留下的半完成狀態（EXPIRED + outcome NULL）可以跨連線修復', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v11-crash-'));
  const url = `file:${path.join(dir, 't.db')}`;
  try {
    const db1 = createDb({ url });
    await db1.migrate();
    await seedAliceAndBob(db1);
    const { eventId, questionId } = await askProactive(db1, ALICE);
    // 模擬「第一段寫入成功、process 就死了」
    const won = await db1.expirePendingQuestion(ALICE.id, questionId, { now: AFTER_TTL });
    assert.equal(won, true);
    assert.equal((await eventById(db1, ALICE.id, eventId)).outcome, null);
    db1.close();

    // 重啟
    const db2 = createDb({ url });
    const res = await reapExpiredProactiveQuestions({ db: db2, userId: ALICE.id, now: AFTER_TTL });
    assert.deepEqual(res, { expired: 0, repaired: 1, noResponse: 1, skipped: 0 });
    assert.equal(
      (await eventById(db2, ALICE.id, eventId)).outcome, PROACTIVE_OUTCOME.NO_RESPONSE,
    );
    db2.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('★★★ F-01: ANSWERED 即使事件未收尾，也絕不會被補成 NO_RESPONSE', async () => {
  await withDb(async (db) => {
    const { eventId, questionId } = await askProactive(db, ALICE);
    // 使用者回答了，但 reanalysis 掛掉 → 事件 outcome 仍是 NULL
    await db.resolvePendingQuestion(ALICE.id, questionId, '有喝', { now: later(60_000) });
    assert.equal((await questionRow(db, questionId)).status, 'ANSWERED');

    const res = await reapExpiredProactiveQuestions({ db, userId: ALICE.id, now: AFTER_TTL });
    assert.deepEqual(res, { expired: 0, repaired: 0, noResponse: 0, skipped: 0 });
    assert.equal(
      (await eventById(db, ALICE.id, eventId)).outcome, null,
      '★ 使用者真的回答過，寫 NO_RESPONSE 會是事實錯誤',
    );
  });
});

test('★★★ F-01: SUPERSEDED 即使事件未收尾，也絕不會被補成 NO_RESPONSE', async () => {
  await withDb(async (db) => {
    const first = await askProactive(db, ALICE, { key: 'k1' });
    await askProactive(db, ALICE, { key: 'k2', now: later(1000) });
    assert.equal((await questionRow(db, first.questionId)).status, 'SUPERSEDED');

    await reapExpiredProactiveQuestions({ db, userId: ALICE.id, now: AFTER_TTL });
    assert.equal(
      (await eventById(db, ALICE.id, first.eventId)).outcome, null,
      '被取代的問題不該有「沒回應」這個結論',
    );
  });
});

test('★★★ F-01: 惰性過期之後，遲到的回答仍然無法覆寫 NO_RESPONSE', async () => {
  await withDb(async (db) => {
    const { eventId, questionId } = await askProactive(db, ALICE);
    await db.getOpenPendingQuestion(ALICE.id, { now: AFTER_TTL });   // 惰性過期
    await reapExpiredProactiveQuestions({ db, userId: ALICE.id, now: AFTER_TTL });

    const ok = await db.resolvePendingQuestion(
      ALICE.id, questionId, '啊我現在才看到', { now: later(7200_000) },
    );
    assert.equal(ok, false);
    assert.equal(
      (await eventById(db, ALICE.id, eventId)).outcome, PROACTIVE_OUTCOME.NO_RESPONSE,
    );
  });
});

test('★★★ F-01: 兩個收割器同時修復同一個半完成狀態 → 只寫一次', async () => {
  await withDb(async (db) => {
    const { eventId } = await askProactive(db, ALICE);
    await db.getOpenPendingQuestion(ALICE.id, { now: AFTER_TTL });   // 惰性過期

    const [a, b] = await Promise.all([
      reapExpiredProactiveQuestions({ db, userId: ALICE.id, now: AFTER_TTL }),
      reapExpiredProactiveQuestions({ db, userId: ALICE.id, now: AFTER_TTL }),
    ]);
    assert.equal(a.noResponse + b.noResponse, 1);
    assert.equal(
      (await eventById(db, ALICE.id, eventId)).outcome, PROACTIVE_OUTCOME.NO_RESPONSE,
    );
  });
});

test('★★★ F-01: Alice 與 Bob 同時處於半完成狀態 → 各自修復，互不影響', async () => {
  await withDb(async (db) => {
    const a = await askProactive(db, ALICE, { key: 'same' });
    const b = await askProactive(db, BOB, { key: 'same' });
    await db.getOpenPendingQuestion(ALICE.id, { now: AFTER_TTL });
    await db.getOpenPendingQuestion(BOB.id, { now: AFTER_TTL });

    const resA = await reapExpiredProactiveQuestions({ db, userId: ALICE.id, now: AFTER_TTL });
    assert.equal(resA.noResponse, 1);
    assert.equal((await eventById(db, ALICE.id, a.eventId)).outcome, PROACTIVE_OUTCOME.NO_RESPONSE);
    assert.equal((await eventById(db, BOB.id, b.eventId)).outcome, null, 'Bob 還沒被收');

    const resB = await reapExpiredProactiveQuestions({ db, userId: BOB.id, now: AFTER_TTL });
    assert.equal(resB.noResponse, 1);
    assert.equal((await eventById(db, BOB.id, b.eventId)).outcome, PROACTIVE_OUTCOME.NO_RESPONSE);
  });
});

// ===========================================================================
// ★★ F-05 —— 惰性過期的 UPDATE 必須帶 user_id
// ===========================================================================

test('★★★ F-05: 惰性過期的 UPDATE 自己就帶 user_id（不倚賴上游 SELECT）', async () => {
  await withDb(async (db) => {
    const bob = await askProactive(db, BOB);

    // 正常情況下這條 UPDATE 是碰不到別人的列的——因為上面那個 SELECT
    // 已經用 user_id 濾過了。所以要證明「UPDATE **自己**有 scope」，
    // 唯一的方法是把上游的 SELECT 換成一個會回傳別人資料的惡意版本，
    // 然後看那句 UPDATE 擋不擋得住。這就是縱深防禦的定義。
    const bobRow = await questionRow(db, bob.questionId);
    const forgedClient = {
      async execute(q) {
        const sql = typeof q === 'string' ? q : q.sql;
        // 攔截「找我自己的 OPEN 追問」，改成回傳 Bob 的那一列
        if (sql.includes('SELECT * FROM pending_questions') && sql.includes("status = 'OPEN'")) {
          return { rows: [bobRow] };
        }
        return db.raw.execute(q);
      },
      async batch(...a) { return db.raw.batch(...a); },
    };
    const forgedStore = createBotStore(forgedClient);

    // Alice 的身分 + Bob 的列 → 惰性過期會嘗試把它收成 EXPIRED
    const open = await forgedStore.getOpenPendingQuestion(ALICE.id, { now: AFTER_TTL });
    assert.equal(open, null, '過期 → 回 null（這部分照舊）');

    // ★ 關鍵斷言：Bob 的列必須毫髮無傷
    assert.equal(
      (await questionRow(db, bob.questionId)).status, 'OPEN',
      '★ Alice 的惰性過期絕不可以動到 Bob 的 pending question',
    );
  });
});

test('★★ F-05: 直接對 store 施加跨使用者的過期嘗試也無效', async () => {
  await withDb(async (db) => {
    const bob = await askProactive(db, BOB);
    // Alice 拿著 Bob 的 pending question id 去收
    const won = await db.expirePendingQuestion(ALICE.id, bob.questionId, { now: AFTER_TTL });
    assert.equal(won, false);
    assert.equal((await questionRow(db, bob.questionId)).status, 'OPEN');
  });
});

// ===========================================================================
// ★★★ RF-01 —— 澄清追問（clarification）的收斂
//
// router 聽不懂使用者的回答時會開一個**新的**追問 Q2，context 沿用同一個
// proactive_event_id，但不會呼叫 markProactiveEventSent。所以事件的
// pending_question_id 仍然指著 Q1（此時已 ANSWERED）。只看那個欄位的話，
// Q2 過期之後永遠找不到自己的事件 → 事件永遠停在 NULL → Guardian 永遠誤報。
// ===========================================================================

/** 完整重現 router.handleProactiveAnswer 的澄清分支。 */
async function askWithClarification(db, user, { key = 'c1', now = T0 } = {}) {
  const claim = await db.claimProactiveEvent(user.id, {
    healthDate: '2026-09-09',
    idempotencyKey: key,
    signals: [{ code: 'HRV_LOW', metric: 'hrv' }],
    decision: PROACTIVE_DECISION.ASK_CONTEXT,
    reason: { question_category: 'alcohol' },
    policyVersion: 'p1',
    messageText: '昨天有喝酒嗎？',
  }, { now });
  const q1 = await db.openPendingQuestion(user.id, {
    chatId: user.chatId,
    question: '昨天有喝酒嗎？',
    intent: PROACTIVE_QUESTION_INTENT,
    contextJson: { health_date: '2026-09-09', category: 'alcohol', proactive_event_id: claim.id },
    ttlMs: ANTI_SPAM_POLICY.QUESTION_TTL_MS,
  }, { now });
  await db.markProactiveEventSent(user.id, claim.id, { pendingQuestionId: q1 }, { now });

  // 使用者回了聽不懂的話 → Q1 收成 ANSWERED，開澄清追問 Q2
  const t1 = new Date(now.getTime() + 60_000);
  const ctx = (await db.getOpenPendingQuestion(user.id, { now: t1 })).context;
  await db.resolvePendingQuestion(user.id, q1, '嗯……', { now: t1 });
  const q2 = await db.openPendingQuestion(user.id, {
    chatId: user.chatId,
    originalMessage: '昨天有喝酒嗎？',
    question: '不好意思我沒有聽懂——可以說「有」還是「沒有」嗎？',
    intent: PROACTIVE_QUESTION_INTENT,
    contextJson: { ...ctx, clarified: true },
    ttlMs: TELEGRAM_BOT.PENDING_TTL_MS,
  }, { now: t1 });

  return { eventId: claim.id, q1, q2, t1 };
}

const AFTER_CLARIFY = later(60_000 + TELEGRAM_BOT.PENDING_TTL_MS + 60_000);

test('★★★ RF-01 (1): 澄清追問過期 → 事件收斂到 NO_RESPONSE', async () => {
  await withDb(async (db) => {
    const { eventId, q1, q2 } = await askWithClarification(db, ALICE);

    // 前提：事件的欄位連結指著 Q1，不是 Q2
    assert.equal((await eventById(db, ALICE.id, eventId)).pendingQuestionId, q1);
    assert.equal((await questionRow(db, q1)).status, 'ANSWERED');

    const res = await reapExpiredProactiveQuestions({ db, userId: ALICE.id, now: AFTER_CLARIFY });
    assert.equal(res.noResponse, 1);
    assert.equal((await questionRow(db, q2)).status, 'EXPIRED');
    assert.equal((await eventById(db, ALICE.id, eventId)).outcome, PROACTIVE_OUTCOME.NO_RESPONSE);
  });
});

test('★★★ RF-01 (2): 澄清追問先被惰性過期 → 之後的收割仍然修得回來', async () => {
  await withDb(async (db) => {
    const { eventId, q2 } = await askWithClarification(db, ALICE);

    // checkAndAct / router / /status 都會走這一行
    await db.getOpenPendingQuestion(ALICE.id, { now: AFTER_CLARIFY });
    assert.equal((await questionRow(db, q2)).status, 'EXPIRED');
    assert.equal((await eventById(db, ALICE.id, eventId)).outcome, null, '半完成狀態');

    const res = await reapExpiredProactiveQuestions({ db, userId: ALICE.id, now: AFTER_CLARIFY });
    assert.deepEqual(res, { expired: 0, repaired: 1, noResponse: 1, skipped: 0 });
    assert.equal((await eventById(db, ALICE.id, eventId)).outcome, PROACTIVE_OUTCOME.NO_RESPONSE);
  });
});

test('★★★ RF-01 (3): 澄清追問的半完成狀態可以跨 process 修復', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v11-rf01-'));
  const url = `file:${path.join(dir, 't.db')}`;
  try {
    const db1 = createDb({ url });
    await db1.migrate();
    await seedAliceAndBob(db1);
    const { eventId } = await askWithClarification(db1, ALICE);
    await db1.getOpenPendingQuestion(ALICE.id, { now: AFTER_CLARIFY });   // 惰性過期後崩潰
    db1.close();

    const db2 = createDb({ url });
    const res = await reapExpiredProactiveQuestions({ db: db2, userId: ALICE.id, now: AFTER_CLARIFY });
    assert.equal(res.noResponse, 1);
    assert.equal((await eventById(db2, ALICE.id, eventId)).outcome, PROACTIVE_OUTCOME.NO_RESPONSE);
    db2.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('★★★ RF-01 (4): 澄清追問被回答 → 事件絕不可以變成 NO_RESPONSE', async () => {
  await withDb(async (db) => {
    const { eventId, q2, t1 } = await askWithClarification(db, ALICE);
    await db.resolvePendingQuestion(ALICE.id, q2, '有喝兩杯', { now: new Date(t1.getTime() + 60_000) });

    const res = await reapExpiredProactiveQuestions({ db, userId: ALICE.id, now: AFTER_CLARIFY });
    assert.equal(res.noResponse, 0);
    assert.equal((await eventById(db, ALICE.id, eventId)).outcome, null, '使用者真的回答過');
  });
});

test('★★★ RF-01 (5): 澄清追問被取代（SUPERSEDED）→ 事件不變成 NO_RESPONSE', async () => {
  await withDb(async (db) => {
    const { eventId, q2, t1 } = await askWithClarification(db, ALICE);
    // 又有新的主動問題 → Q2 變 SUPERSEDED
    await db.openPendingQuestion(ALICE.id, {
      chatId: ALICE.chatId, question: '新問題', intent: PROACTIVE_QUESTION_INTENT,
      contextJson: {}, ttlMs: ANTI_SPAM_POLICY.QUESTION_TTL_MS,
    }, { now: new Date(t1.getTime() + 1000) });
    assert.equal((await questionRow(db, q2)).status, 'SUPERSEDED');

    await reapExpiredProactiveQuestions({ db, userId: ALICE.id, now: AFTER_CLARIFY });
    assert.equal((await eventById(db, ALICE.id, eventId)).outcome, null);
  });
});

test('★★★ RF-01 (6): 澄清追問已產生 NO_RESPONSE 後，遲到的回答蓋不掉', async () => {
  await withDb(async (db) => {
    const { eventId, q2 } = await askWithClarification(db, ALICE);
    await reapExpiredProactiveQuestions({ db, userId: ALICE.id, now: AFTER_CLARIFY });

    const ok = await db.resolvePendingQuestion(
      ALICE.id, q2, '啊我現在才看到', { now: later(9e6) },
    );
    assert.equal(ok, false);
    assert.equal((await eventById(db, ALICE.id, eventId)).outcome, PROACTIVE_OUTCOME.NO_RESPONSE);
  });
});

test('★★★ RF-01 (7): Alice 的 context 偽造成 Bob 的事件 id → Bob 的事件毫髮無傷', async () => {
  await withDb(async (db) => {
    const bob = await askProactive(db, BOB, { key: 'bob-1' });

    // Alice 開一個 context 指向 **Bob 事件** 的主動問題
    await db.openPendingQuestion(ALICE.id, {
      chatId: ALICE.chatId,
      question: '惡意問題',
      intent: PROACTIVE_QUESTION_INTENT,
      contextJson: { proactive_event_id: bob.eventId },
      ttlMs: ANTI_SPAM_POLICY.QUESTION_TTL_MS,
    }, { now: T0 });

    // ★ 第一層：**選取**階段就不可以把別人的事件當成目標。
    // 只斷言「Bob 的事件沒被改」不夠——寫入層的 user_id 條件本來就會擋下來，
    // 所以那樣測不出選取層到底有沒有防線（縱深防禦的兩層要分別驗）。
    const rows = await db.listReapablePendingQuestions(ALICE.id, {
      now: AFTER_TTL, intent: PROACTIVE_QUESTION_INTENT,
    });
    for (const r of rows) {
      assert.notEqual(
        r.unresolvedEventId, bob.eventId,
        '★ 選取階段就絕不可以把 Bob 的事件挑成 Alice 的目標',
      );
    }

    // ★ 第二層：就算選取層被繞過，寫入層也必須擋下來。
    const res = await reapExpiredProactiveQuestions({ db, userId: ALICE.id, now: AFTER_TTL });
    assert.equal(res.noResponse, 0, '★ 絕不可以解析到別人的事件');
    assert.equal(
      (await eventById(db, BOB.id, bob.eventId)).outcome, null,
      '★ Bob 的事件必須完全不受影響',
    );
  });
});

test('★★★ RF-01 (8): context_json 壞掉 → 不當掉、不寫入、fail closed', async () => {
  await withDb(async (db) => {
    const { eventId, q2 } = await askWithClarification(db, ALICE);
    await db.raw.execute({
      sql: "UPDATE pending_questions SET context_json = '{壞掉的 JSON' WHERE id = ?",
      args: [q2],
    });

    // 不可以拋錯（json_extract 對壞 JSON 會讓整個查詢失敗，所以要有 json_valid 守門）
    const res = await reapExpiredProactiveQuestions({ db, userId: ALICE.id, now: AFTER_CLARIFY });
    assert.equal(res.noResponse, 0, 'context 壞掉 → 不解析任何事件');
    assert.equal((await eventById(db, ALICE.id, eventId)).outcome, null);
  });
});

test('★★★ RF-01 (8b): 壞掉的 context 不會讓同一批的其他問題也收不了', async () => {
  await withDb(async (db) => {
    // 一筆壞掉的孤兒問題
    const bad = await db.openPendingQuestion(ALICE.id, {
      chatId: ALICE.chatId, question: 'bad', intent: PROACTIVE_QUESTION_INTENT,
      contextJson: { proactive_event_id: 999 }, ttlMs: ANTI_SPAM_POLICY.QUESTION_TTL_MS,
    }, { now: T0 });
    await db.raw.execute({
      sql: "UPDATE pending_questions SET context_json = '{broken' WHERE id = ?", args: [bad],
    });
    // 一筆正常的（會 SUPERSEDE 上面那筆，所以直接改回 OPEN 模擬兩筆並存）
    const good = await askProactive(db, ALICE, { key: 'good' });
    await db.raw.execute({
      sql: "UPDATE pending_questions SET status = 'OPEN' WHERE id = ?", args: [bad],
    });

    const res = await reapExpiredProactiveQuestions({ db, userId: ALICE.id, now: AFTER_TTL });
    assert.equal(
      (await eventById(db, ALICE.id, good.eventId)).outcome, PROACTIVE_OUTCOME.NO_RESPONSE,
      '★ 一列壞資料不可以讓整個使用者的收割停擺',
    );
    assert.ok(res.expired >= 1);
  });
});

test('★★★ RF-01 (9): context 沒有 proactive_event_id → 不亂解析任何事件', async () => {
  await withDb(async (db) => {
    const other = await askProactive(db, ALICE, { key: 'other' });
    // 另開一個沒有事件連結的主動問題（會把上面那題 SUPERSEDE 掉）
    const orphan = await db.openPendingQuestion(ALICE.id, {
      chatId: ALICE.chatId, question: '沒有 context 的問題',
      intent: PROACTIVE_QUESTION_INTENT, contextJson: { category: 'alcohol' },
      ttlMs: ANTI_SPAM_POLICY.QUESTION_TTL_MS,
    }, { now: later(1000) });

    const res = await reapExpiredProactiveQuestions({ db, userId: ALICE.id, now: AFTER_TTL });
    assert.equal((await questionRow(db, orphan)).status, 'EXPIRED', '仍然要被收成 EXPIRED');
    assert.equal(
      (await eventById(db, ALICE.id, other.eventId)).outcome, null,
      '★ 不可以隨便挑一個事件來收尾',
    );
    assert.equal(res.noResponse, 0);
  });
});

test('★★★ RF-01 (10): 重複收割 → 第一次解析一次，之後零工作量', async () => {
  await withDb(async (db) => {
    const { eventId } = await askWithClarification(db, ALICE);
    const first = await reapExpiredProactiveQuestions({ db, userId: ALICE.id, now: AFTER_CLARIFY });
    assert.equal(first.noResponse, 1);

    for (let i = 0; i < 3; i += 1) {
      const again = await reapExpiredProactiveQuestions({
        db, userId: ALICE.id, now: new Date(AFTER_CLARIFY.getTime() + (i + 1) * 3600_000),
      });
      assert.deepEqual(again, { expired: 0, repaired: 0, noResponse: 0, skipped: 0 });
    }
    assert.equal((await eventById(db, ALICE.id, eventId)).outcome, PROACTIVE_OUTCOME.NO_RESPONSE);
  });
});

test('★★★ RF-01 (11): 兩個收割器同時處理澄清追問 → 只寫一次', async () => {
  await withDb(async (db) => {
    const { eventId } = await askWithClarification(db, ALICE);
    const [a, b] = await Promise.all([
      reapExpiredProactiveQuestions({ db, userId: ALICE.id, now: AFTER_CLARIFY }),
      reapExpiredProactiveQuestions({ db, userId: ALICE.id, now: AFTER_CLARIFY }),
    ]);
    assert.equal(a.noResponse + b.noResponse, 1);
    assert.equal((await eventById(db, ALICE.id, eventId)).outcome, PROACTIVE_OUTCOME.NO_RESPONSE);
  });
});

test('★★★ RF-01: 多個未結案事件 → 只收尾真正連結的那一個', async () => {
  await withDb(async (db) => {
    const { eventId, q2 } = await askWithClarification(db, ALICE, { key: 'linked' });
    // 另一個同樣未結案、但與 Q2 毫無連結的事件
    const unrelated = await db.claimProactiveEvent(ALICE.id, {
      healthDate: '2026-09-08', idempotencyKey: 'unrelated',
      signals: [], decision: PROACTIVE_DECISION.NOTIFY,
      reason: {}, policyVersion: 'p1', messageText: 'n',
    }, { now: T0 });

    await reapExpiredProactiveQuestions({ db, userId: ALICE.id, now: AFTER_CLARIFY });

    assert.equal((await eventById(db, ALICE.id, eventId)).outcome, PROACTIVE_OUTCOME.NO_RESPONSE);
    assert.equal(
      (await eventById(db, ALICE.id, unrelated.id)).outcome, null,
      '★ 沒有連結的事件絕不可以被順手收掉',
    );
    assert.equal((await questionRow(db, q2)).status, 'EXPIRED');
  });
});

test('★★ RF-01: 選取與解析用同一個事件身分（store 直接回傳目標）', async () => {
  await withDb(async (db) => {
    const { eventId, q2 } = await askWithClarification(db, ALICE);
    const rows = await db.listReapablePendingQuestions(ALICE.id, {
      now: AFTER_CLARIFY, intent: PROACTIVE_QUESTION_INTENT,
    });
    const row = rows.find((r) => r.id === q2);
    assert.ok(row, '澄清追問必須出現在待收清單裡');
    assert.equal(
      row.unresolvedEventId, eventId,
      '★ store 直接給出目標事件 id，收割器不需要自己再推一次',
    );
  });
});
