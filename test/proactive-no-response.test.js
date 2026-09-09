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
    assert.deepEqual(res, { expired: 1, noResponse: 1, skipped: 0 });

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
    assert.deepEqual(res, { expired: 0, noResponse: 0, skipped: 0 });

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

    assert.deepEqual(first, { expired: 1, noResponse: 1, skipped: 0 });
    assert.deepEqual(second, { expired: 0, noResponse: 0, skipped: 0 });
    // resolved_at 不可以被第二次收割改掉
    assert.equal(afterSecond.resolvedAt, afterFirst.resolvedAt);
    assert.equal(afterSecond.outcome, PROACTIVE_OUTCOME.NO_RESPONSE);
  });
});

test('沒有任何過期問題時是乾淨的 no-op', async () => {
  await withDb(async (db) => {
    const res = await reapExpiredProactiveQuestions({ db, userId: ALICE.id, now: AFTER_TTL });
    assert.deepEqual(res, { expired: 0, noResponse: 0, skipped: 0 });
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
    assert.deepEqual(res, { expired: 0, noResponse: 0, skipped: 0 });

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
    assert.deepEqual(res, { expired: 1, noResponse: 1, skipped: 0 });
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
    assert.deepEqual(res, { expired: 0, noResponse: 0, skipped: 0 });
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
    assert.deepEqual(res, { expired: 0, noResponse: 0, skipped: 0 });
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
  assert.deepEqual(res, { expired: 0, noResponse: 0, skipped: 0 });
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
