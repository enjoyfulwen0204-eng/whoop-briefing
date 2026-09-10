/**
 * Guardian 不可以發假警報（M-07 / M-08）。
 *
 * ## 為什麼假警報是嚴重問題
 *
 * Guardian 的價值完全建立在「它一出聲就代表真的有事」上。一個**永遠不會
 * 消失**的假警報，會在幾天內訓練出「看到 Guardian 就忽略」的習慣 ——
 * 之後真正的故障也會被一起忽略。所以下面兩個都是永久性假警報，
 * 比「少報一次」嚴重得多。
 *
 * ## M-07：已完成的 NOTIFY 事件被當成「卡住」
 *
 * `countStuckProactiveEvents` 的判準是
 * `sent_at IS NOT NULL AND outcome IS NULL`。但 NOTIFY 這類決策只是通知
 * 一句話，**不會開追問**，沒有人該回答它，於是 outcome 永遠是 NULL。
 * 結果每一則正常送出的通知，24 小時後都變成一筆永久假警報。
 *
 * 修正：沒有問問題的事件，**送出即終局**（outcome = DELIVERED）。
 *
 * ## M-08：已經恢復的授權失敗還在報
 *
 * `error_notifications` 只會被失敗寫入，從來沒有任何地方在成功時清掉。
 * 使用者重新授權、同步恢復正常之後，那一列仍然停在 hits = 3，
 * Guardian 每 12 小時就照樣發一次「需要重新授權」——永遠不會停。
 *
 * 修正兩道：拿到 token 時清掉紀錄；Guardian 另外用「最近一次成功同步
 * 比最後一次失敗還新」當獨立的恢復證據。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createDb } from '../src/db.js';
import { gatherFacts, evaluate } from '../src/guardian.js';
import { reapExpiredProactiveQuestions } from '../src/proactiveReaper.js';
import { GUARDIAN_SIGNAL } from '../src/guardianPolicy.js';
import {
  PROACTIVE_DECISION, PROACTIVE_OUTCOME, PROACTIVE_QUESTION_INTENT, userScope,
} from '../src/schema.js';

const NOW = new Date('2026-09-10T00:00:00Z');
const LONG_AGO = new Date(NOW.getTime() - 72 * 3600_000);

async function withUser(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-fa-'));
  const db = createDb({ url: `file:${path.join(dir, 't.db')}` });
  try {
    await db.migrate();
    const user = await db.createUser({ displayName: 'K' });
    await db.saveTokens(user.id, {
      accessToken: 'a', refreshToken: 'r',
      expiresAt: new Date('2026-12-31T00:00:00Z'), scope: 's', whoopUserId: 'w-1',
    });
    await fn(db, user.id);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const signalsFrom = async (db) => {
  const facts = await gatherFacts({ db, now: NOW });
  return { facts, signals: evaluate({ ...facts, now: NOW }).map((f) => f.signal) };
};

const eventRow = async (db, userId, id) => {
  const rs = await db.raw.execute({
    sql: 'SELECT outcome, resolved_at FROM proactive_events WHERE user_id = ? AND id = ?',
    args: [userId, id],
  });
  return rs.rows[0];
};

// ===========================================================================
// ★★★ M-07
// ===========================================================================

async function sendNotify(db, userId, { key = 'n1', now = LONG_AGO } = {}) {
  const { id } = await db.claimProactiveEvent(userId, {
    healthDate: '2026-09-05', idempotencyKey: key,
    signals: [{ metric: 'hrv' }], decision: PROACTIVE_DECISION.NOTIFY,
    reason: {}, policyVersion: 'p1', messageText: 'HRV 連續三天偏低。',
  }, { now });
  // NOTIFY 不開追問 —— 這正是 proactiveAgent 的實際行為
  await db.markProactiveEventSent(userId, id, { pendingQuestionId: null }, { now });
  return id;
}

test('★★★ M-07: 已送出的 NOTIFY 事件不會被 Guardian 當成卡住', async () => {
  await withUser(async (db, uid) => {
    await sendNotify(db, uid);
    const { facts, signals } = await signalsFrom(db);
    assert.equal(facts.users[0].stuckProactiveCount, 0);
    assert.ok(!signals.includes(GUARDIAN_SIGNAL.PROACTIVE_EVENT_STUCK),
      '★ 正常送出的通知不可以變成永久假警報');
  });
});

test('★★★ M-07: NOTIFY 在送出的那一刻就有終局（DELIVERED）', async () => {
  await withUser(async (db, uid) => {
    const id = await sendNotify(db, uid);
    const row = await eventRow(db, uid, id);
    assert.equal(row.outcome, PROACTIVE_OUTCOME.DELIVERED);
    assert.ok(row.resolved_at, '★ resolved_at 也要寫，否則稽核軌跡不完整');
  });
});

test('★★★ M-07: 收割器不會把 NOTIFY 誤寫成 NO_RESPONSE（沒問過就沒有「沒回應」）', async () => {
  await withUser(async (db, uid) => {
    const id = await sendNotify(db, uid);
    // 模擬舊資料：outcome 被清成 NULL
    await db.raw.execute({
      sql: 'UPDATE proactive_events SET outcome = NULL, resolved_at = NULL WHERE id = ?',
      args: [id],
    });
    const res = await reapExpiredProactiveQuestions({ db, userId: uid, now: NOW });
    assert.equal(res.noResponse, 0, '★ 從來沒問過問題，寫 NO_RESPONSE 是事實錯誤');
    assert.equal(res.delivered, 1);
    assert.equal((await eventRow(db, uid, id)).outcome, PROACTIVE_OUTCOME.DELIVERED);
  });
});

test('★★ M-07: 真的卡住的 ASK_CONTEXT 事件仍然報得出來（沒有把偵測關掉）', async () => {
  await withUser(async (db, uid) => {
    const { id } = await db.claimProactiveEvent(uid, {
      healthDate: '2026-09-05', idempotencyKey: 'ask-1',
      signals: [], decision: PROACTIVE_DECISION.ASK_CONTEXT,
      reason: {}, policyVersion: 'p1', messageText: 'q',
    }, { now: LONG_AGO });
    const qid = await db.openPendingQuestion(uid, {
      chatId: '1', question: 'q', intent: PROACTIVE_QUESTION_INTENT,
      contextJson: { proactive_event_id: id }, ttlMs: 30 * 60_000,
    }, { now: LONG_AGO });
    await db.markProactiveEventSent(uid, id, { pendingQuestionId: qid }, { now: LONG_AGO });

    const { facts, signals } = await signalsFrom(db);
    assert.equal(facts.users[0].stuckProactiveCount, 1);
    assert.ok(signals.includes(GUARDIAN_SIGNAL.PROACTIVE_EVENT_STUCK),
      '★ 收割器真的沒在跑時，必須還是報得出來');
  });
});

test('★★ M-07: markProactiveEventSent 冪等，不覆寫已有的結論', async () => {
  await withUser(async (db, uid) => {
    const id = await sendNotify(db, uid);
    await db.resolveProactiveEvent(uid, id, PROACTIVE_OUTCOME.EXPLAINED, { now: NOW });
    await db.markProactiveEventSent(uid, id, { pendingQuestionId: null }, { now: NOW });
    assert.equal((await eventRow(db, uid, id)).outcome, PROACTIVE_OUTCOME.EXPLAINED,
      '★ 已經有結論的事件不可以被改成 DELIVERED');
  });
});

// ===========================================================================
// ★★★ M-08
// ===========================================================================

/** 造一筆「授權在 failedAt 連續失敗 3 次」的紀錄。 */
async function seedAuthFailures(db, uid, failedAt) {
  for (let i = 0; i < 3; i += 1) await db.claimUserErrorNotify(uid, 'whoop_auth', 12);
  // claimErrorNotify 沒有可注入的時鐘，直接把時間改成我們要的
  await db.raw.execute({
    sql: 'UPDATE error_notifications SET last_notified_at = ?, hits = 3 WHERE scope = ?',
    args: [failedAt, userScope(uid)],
  });
}

test('★★★ M-08: 授權失敗之後同步已經恢復 → 不再報「需要重新授權」', async () => {
  await withUser(async (db, uid) => {
    await seedAuthFailures(db, uid, '2026-09-01T00:00:00.000Z');
    await db.saveSyncState(uid, 'recovery', {
      lastSuccessAt: new Date(NOW.getTime() - 600_000).toISOString(),
    }, { now: NOW });

    const { signals } = await signalsFrom(db);
    assert.ok(!signals.includes(GUARDIAN_SIGNAL.WHOOP_AUTH_REPEATED_FAILURE),
      '★ 同步都成功了，授權顯然是好的——不可以繼續報');
  });
});

test('★★★ M-08: 還沒恢復（失敗比最後一次成功同步新）→ 照樣要報', async () => {
  await withUser(async (db, uid) => {
    await db.saveSyncState(uid, 'recovery', {
      lastSuccessAt: '2026-09-01T00:00:00.000Z',
    }, { now: NOW });
    await seedAuthFailures(db, uid, '2026-09-09T00:00:00.000Z');

    const { signals } = await signalsFrom(db);
    assert.ok(signals.includes(GUARDIAN_SIGNAL.WHOOP_AUTH_REPEATED_FAILURE),
      '★ 真的還壞著就一定要報');
  });
});

test('★★★ M-08: 拿到 token 時清掉失敗紀錄（clearUserErrorNotify）', async () => {
  await withUser(async (db, uid) => {
    await seedAuthFailures(db, uid, '2026-09-09T00:00:00.000Z');
    assert.equal((await db.getErrorNotification(userScope(uid), 'whoop_auth')).hits, 3);

    const cleared = await db.clearUserErrorNotify(uid, 'whoop_auth');
    assert.equal(cleared, true);
    assert.equal(await db.getErrorNotification(userScope(uid), 'whoop_auth'), null);

    const { signals } = await signalsFrom(db);
    assert.ok(!signals.includes(GUARDIAN_SIGNAL.WHOOP_AUTH_REPEATED_FAILURE));
  });
});

test('★★ M-08: 沒有紀錄可清時是乾淨的 no-op', async () => {
  await withUser(async (db, uid) => {
    assert.equal(await db.clearUserErrorNotify(uid, 'whoop_auth'), false);
  });
});

test('★★★ M-08: 清除只影響這個使用者、這個錯誤類型', async () => {
  await withUser(async (db, uid) => {
    const other = await db.createUser({ displayName: 'B' });
    await db.claimUserErrorNotify(uid, 'whoop_auth', 12);
    await db.claimUserErrorNotify(uid, 'sync', 12);
    await db.claimUserErrorNotify(other.id, 'whoop_auth', 12);

    await db.clearUserErrorNotify(uid, 'whoop_auth');

    assert.equal(await db.getErrorNotification(userScope(uid), 'whoop_auth'), null);
    assert.ok(await db.getErrorNotification(userScope(uid), 'sync'), '★ 別的錯誤類型不可以被清掉');
    assert.ok(await db.getErrorNotification(userScope(other.id), 'whoop_auth'),
      '★ 別人的紀錄不可以被清掉');
  });
});

test('★★ M-08: 從來沒有成功同步過時，恢復判斷不會誤放行', async () => {
  await withUser(async (db, uid) => {
    // lastSyncOkAt = null（剛授權就壞了）
    await seedAuthFailures(db, uid, '2026-09-09T00:00:00.000Z');
    const { signals } = await signalsFrom(db);
    assert.ok(signals.includes(GUARDIAN_SIGNAL.WHOOP_AUTH_REPEATED_FAILURE),
      '★ 沒有任何恢復證據時必須照報');
  });
});
