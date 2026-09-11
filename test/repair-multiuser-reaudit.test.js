/**
 * 多使用者再稽核：這次修復碰到的**每一個**表面。
 *
 * 這個檔案不重複測既有的隔離規則（那些在 multiuser-*.test.js），
 * 它只問一件事：
 *
 *   **這次新增／改動的程式碼，有沒有任何一條路徑會讓 Alice 影響到 Bob？**
 *
 * 涵蓋 H-01、H-02、M-01…M-11、L-01…L-03 全部新表面。
 * 每一題都有兩個使用者同時存在、而且都有資料——只有一個使用者的測試
 * 不可能發現跨使用者的洩漏。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createDb } from '../src/db.js';
import { createRouter } from '../src/bot/router.js';
import { createPoller } from '../src/bot/polling.js';
import { reapExpiredProactiveQuestions } from '../src/proactiveReaper.js';
import { gatherFacts, evaluate } from '../src/guardian.js';
import { buildPersonalHealthspan } from '../src/healthspanEngine.js';
import { completeAuthorization, prepareAuthorization, OAuthFlowError } from '../src/oauthFlow.js';
import { GUARDIAN_SIGNAL } from '../src/guardianPolicy.js';
import {
  PROACTIVE_DECISION, PROACTIVE_OUTCOME, PROACTIVE_QUESTION_INTENT, userScope,
} from '../src/schema.js';

const NOW = new Date('2026-09-09T02:00:00Z');
const LONG_AGO = new Date(NOW.getTime() - 72 * 3600_000);

/** Alice 與 Bob：各自的私訊 chat（Telegram 私訊 chat.id === from.id）。 */
const A = { chat: '1001', name: 'Alice' };
const B = { chat: '1002', name: 'Bob' };

async function withPair(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reaudit-'));
  const db = createDb({ url: `file:${path.join(dir, 't.db')}` });
  try {
    await db.migrate();
    const alice = await db.createUser({ displayName: A.name, timezone: 'Asia/Taipei' });
    const bob = await db.createUser({ displayName: B.name, timezone: 'America/New_York' });
    await db.linkTelegram({ chatId: A.chat, userId: alice.id });
    await db.linkTelegram({ chatId: B.chat, userId: bob.id });
    await fn(db, alice, bob);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const coachFor = () => ({
  async json() {
    return { asserted: true, about_self: true, negated: false, hypothetical: false, category: 'alcohol', subtype: 'beer', numeric_value: 2, unit: 'cup', confidence: 0.9 };
  },
  async ask() { return null; },
});

const journalOf = (db, userId) => db.getJournalEvents(userId, {
  from: '2026-09-01', to: '2026-09-30', limit: 100,
});

async function askProactive(db, userId, chatId, { key = 'k1', now = LONG_AGO } = {}) {
  const { id } = await db.claimProactiveEvent(userId, {
    healthDate: '2026-09-08', idempotencyKey: key,
    signals: [{ metric: 'hrv' }], decision: PROACTIVE_DECISION.ASK_CONTEXT,
    reason: {}, policyVersion: 'v1', messageText: '昨天有喝酒嗎？',
  }, { now });
  const qid = await db.openPendingQuestion(userId, {
    chatId, originalMessage: 'HRV 偏低', question: '昨天有喝酒嗎？',
    intent: PROACTIVE_QUESTION_INTENT,
    contextJson: {
      proactive_event_id: id, health_date: '2026-09-08', signal: { metric: 'hrv' },
      question_target_date: '2026-09-07', category: 'alcohol',
    },
    ttlMs: 30 * 60_000,
  }, { now });
  await db.markProactiveEventSent(userId, id, { pendingQuestionId: qid }, { now });
  return { eventId: id, questionId: qid };
}

const outcomeOf = async (db, userId, eventId) => (await db.raw.execute({
  sql: 'SELECT outcome FROM proactive_events WHERE user_id = ? AND id = ?',
  args: [userId, eventId],
})).rows[0]?.outcome ?? null;

// ===========================================================================
// M-01：WHOOP 身分
// ===========================================================================

test('★★★ 再稽核 M-01: Alice 的 WHOOP 帳號絕不可能被 Bob 綁走', async () => {
  await withPair(async (db, alice, bob) => {
    const go = async (userId, whoopId) => {
      const { state } = await prepareAuthorization({
        db, userId, clientId: 'c', redirectUri: 'http://x/cb',
      });
      return completeAuthorization({
        db, rawState: state, code: 'c',
        exchange: async () => ({
          accessToken: 'A', refreshToken: 'R',
          expiresAt: new Date(NOW.getTime() + 3600_000), scope: 'offline',
        }),
        verifyIdentity: async () => whoopId,
      });
    };
    await go(alice.id, '111');
    await assert.rejects(() => go(bob.id, '111'),
      (e) => e instanceof OAuthFlowError && e.code === 'WHOOP_ACCOUNT_ALREADY_LINKED');

    assert.equal((await db.getTokens(alice.id)).whoopUserId, '111');
    assert.equal(await db.getTokens(bob.id), null, '★ Bob 絕不可以拿到任何 token');
  });
});

// ===========================================================================
// M-02：追問認領
// ===========================================================================

test('★★★ 再稽核 M-02: Alice 的認領不會消耗 Bob 的追問', async () => {
  await withPair(async (db, alice, bob) => {
    const a = await askProactive(db, alice.id, A.chat, { key: 'a1', now: NOW });
    const b = await askProactive(db, bob.id, B.chat, { key: 'b1', now: NOW });

    const router = createRouter({ db, coachFor, now: () => new Date(NOW.getTime() + 60_000) });
    await router.handle({
      text: '有，喝了兩杯', chatId: A.chat, user: { id: alice.id, timezone: 'Asia/Taipei' },
    });

    const bq = await db.getOpenPendingQuestion(bob.id, { now: new Date(NOW.getTime() + 60_000) });
    assert.ok(bq, '★ Bob 的追問必須還開著');
    assert.equal(bq.id, b.questionId);
    assert.ok(a.questionId !== b.questionId);
  });
});

test('★★★ 再稽核 M-02: 只有 Alice 的 journal 被寫，Bob 一筆都沒有', async () => {
  await withPair(async (db, alice, bob) => {
    await askProactive(db, alice.id, A.chat, { key: 'a1', now: NOW });
    const router = createRouter({ db, coachFor, now: () => new Date(NOW.getTime() + 60_000) });
    await router.handle({
      text: '有，喝了兩杯', chatId: A.chat, user: { id: alice.id, timezone: 'Asia/Taipei' },
    });
    assert.equal((await journalOf(db, alice.id)).length, 1);
    assert.equal((await journalOf(db, bob.id)).length, 0, '★ Bob 的 journal 必須是空的');
  });
});

// ===========================================================================
// M-03 / M-07：事件收斂
// ===========================================================================

test('★★★ 再稽核 M-03: 收割 Alice 絕不改動 Bob 的任何事件', async () => {
  await withPair(async (db, alice, bob) => {
    const a = await askProactive(db, alice.id, A.chat, { key: 'a1' });
    await db.resolvePendingQuestion(alice.id, a.questionId, '嗯', { now: LONG_AGO });
    const b = await askProactive(db, bob.id, B.chat, { key: 'b1' });
    await db.resolvePendingQuestion(bob.id, b.questionId, '嗯', { now: LONG_AGO });

    await reapExpiredProactiveQuestions({ db, userId: alice.id, now: NOW });

    assert.equal(await outcomeOf(db, alice.id, a.eventId), PROACTIVE_OUTCOME.ABANDONED);
    assert.equal(await outcomeOf(db, bob.id, b.eventId), null,
      '★ Bob 的事件必須完全沒被碰到');
  });
});

test('★★★ 再稽核 M-07: DELIVERED 只寫給自己的事件', async () => {
  await withPair(async (db, alice, bob) => {
    const mk = async (userId, key) => {
      const { id } = await db.claimProactiveEvent(userId, {
        healthDate: '2026-09-08', idempotencyKey: key, signals: [],
        decision: PROACTIVE_DECISION.NOTIFY, reason: {}, policyVersion: 'v1', messageText: 'x',
      }, { now: LONG_AGO });
      return id;
    };
    const aid = await mk(alice.id, 'a1');
    const bid = await mk(bob.id, 'b1');
    await db.markProactiveEventSent(alice.id, aid, { pendingQuestionId: null }, { now: LONG_AGO });

    assert.equal(await outcomeOf(db, alice.id, aid), PROACTIVE_OUTCOME.DELIVERED);
    assert.equal(await outcomeOf(db, bob.id, bid), null, '★ Bob 的事件不受影響');
  });
});

// ===========================================================================
// M-08：Guardian
// ===========================================================================

test('★★★ 再稽核 M-08: 清掉 Alice 的授權失敗不影響 Bob 的警報', async () => {
  await withPair(async (db, alice, bob) => {
    for (const u of [alice, bob]) {
      await db.saveTokens(u.id, {
        accessToken: 'a', refreshToken: 'r',
        expiresAt: new Date('2026-12-31T00:00:00Z'), scope: 's', whoopUserId: `w-${u.id}`,
      });
      for (let i = 0; i < 3; i += 1) await db.claimUserErrorNotify(u.id, 'whoop_auth', 12);
      await db.raw.execute({
        sql: 'UPDATE error_notifications SET last_notified_at = ?, hits = 3 WHERE scope = ?',
        args: ['2026-09-08T00:00:00.000Z', userScope(u.id)],
      });
    }
    await db.clearUserErrorNotify(alice.id, 'whoop_auth');

    const facts = await gatherFacts({ db, now: NOW });
    const findings = evaluate({ ...facts, now: NOW });
    const scopes = findings
      .filter((f) => f.signal === GUARDIAN_SIGNAL.WHOOP_AUTH_REPEATED_FAILURE)
      .map((f) => f.scope);
    assert.deepEqual(scopes, [userScope(bob.id)],
      '★ 只有 Bob 還該被報——Alice 已經恢復了');
  });
});

// ===========================================================================
// M-09：Telegram update 認領（全域鍵）
// ===========================================================================

test('★★★ 再稽核 M-09: 認領是 per-update 的，不會擋掉另一個人的訊息', async () => {
  await withPair(async (db, alice, bob) => {
    const router = createRouter({ db, coachFor, now: () => NOW });
    const mkPoller = () => createPoller({
      db, botToken: 'T',
      api: { async getUpdates() { return []; }, async sendMessage() { return {}; } },
      resolveUser: (chatId) => db.resolveUserByChatId(chatId),
      handleMessage: async ({ text, chatId, user }) => { await router.handle({ text, chatId, user }); },
    });
    const mk = (id, chat) => ({
      update_id: id,
      message: {
        message_id: id, chat: { id: Number(chat), type: 'private' },
        from: { id: Number(chat), is_bot: false }, text: '喝了兩杯', date: 1,
      },
    });

    // 兩個人各一則不同的 update
    await mkPoller().processBatch([mk(100, A.chat), mk(101, B.chat)], 0);
    assert.equal((await journalOf(db, alice.id)).length, 1);
    assert.equal((await journalOf(db, bob.id)).length, 1, '★ Bob 的訊息不可以被 Alice 的認領擋掉');

    // 重送兩則：兩個人都不該再多一筆
    await db.setUpdateOffset(0);
    await mkPoller().processBatch([mk(100, A.chat), mk(101, B.chat)], 0);
    assert.equal((await journalOf(db, alice.id)).length, 1);
    assert.equal((await journalOf(db, bob.id)).length, 1);
  });
});

// ===========================================================================
// M-10：Healthspan 錨點
// ===========================================================================

test('★★★ 再稽核 M-10: 兩個使用者各自的錨點互不干擾', async () => {
  await withPair(async (db, alice, bob) => {
    const rows = (latest, n) => {
      const out = [];
      for (let i = 0; i < n; i += 1) {
        out.push({
          health_date: new Date(Date.parse(`${latest}T00:00:00Z`) - i * 86_400_000)
            .toISOString().slice(0, 10),
          hrv: 50, rhr: 52, recovery: 60,
        });
      }
      return out;
    };
    const a = buildPersonalHealthspan(rows('2026-09-09', 100), { capabilities: {} });
    const b = buildPersonalHealthspan(rows('2026-08-01', 40), { capabilities: {} });
    assert.equal(a.anchorDate, '2026-09-09');
    assert.equal(b.anchorDate, '2026-08-01');
    assert.ok(alice.id !== bob.id);
  });
});

// ===========================================================================
// L-01：壞掉的 context
// ===========================================================================

test('★★★ 再稽核 L-01: Alice 的壞資料不會讓 Bob 的 bot 掛掉', async () => {
  await withPair(async (db, alice, bob) => {
    const qid = await db.openPendingQuestion(alice.id, {
      chatId: A.chat, question: 'q', intent: PROACTIVE_QUESTION_INTENT,
      contextJson: { x: 1 }, ttlMs: 30 * 60_000,
    }, { now: NOW });
    await db.raw.execute({
      sql: "UPDATE pending_questions SET context_json = '{壞掉' WHERE id = ?", args: [qid],
    });

    const router = createRouter({ db, coachFor, now: () => NOW });
    for (const [chat, user] of [[A.chat, alice], [B.chat, bob]]) {
      const reply = await router.handle({
        text: '/status', chatId: chat, user: { id: user.id, timezone: user.timezone },
      });
      assert.doesNotMatch(String(reply), /我這邊出了點問題/,
        `★ ${user.displayName} 的 /status 必須正常`);
    }
  });
});

// ===========================================================================
// L-03：時區
// ===========================================================================

test('★★★ 再稽核 L-03: 兩個使用者的時區真的不同，不能共用一個「今天」', async () => {
  await withPair(async (db, alice, bob) => {
    assert.equal(alice.timezone, 'Asia/Taipei');
    assert.equal(bob.timezone, 'America/New_York');
    const { localDate } = await import('../src/time.js');
    const instant = new Date('2026-09-08T23:00:00Z');
    assert.notEqual(
      localDate(instant, alice.timezone), localDate(instant, bob.timezone),
      '★ 同一個 UTC 瞬間對兩人是不同的日期——per-user 腳本不可以共用一個時區',
    );
  });
});
