/**
 * Round-2 跨切面再稽核。
 *
 * 八個修復（H-01、H-02、M-01…M-06）各自都有專屬的測試檔。這個檔案問的是
 * 另一個問題：
 *
 *   **把它們放在一起之後，有沒有哪一條既有的不變量被弄壞了？**
 *
 * 涵蓋稽核要求的 14 項：
 *   1. 多使用者隔離           2. Telegram 私訊限定（入站 + 出站）
 *   3. WHOOP 身分不可變       4. OAuth 並發
 *   5. 主動狀態機收斂         6. Guardian 假警報
 *   7. Journal 日期正確性     8. Telegram 重送冪等
 *   9. capability fail-closed 10. 敘述的結構化證據邊界
 *  11. 預測沒有 D→D+1 洩漏    12. Healthspan 仍然 fail-closed
 *  13. 遷移安全               14. 冷啟動
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SCHEMA_VERSION } from '../src/schema.js';
import { createDb } from '../src/db.js';
import { runForUser } from '../src/index.js';
import { createPoller } from '../src/bot/polling.js';
import { createRouter } from '../src/bot/router.js';
import { reapExpiredProactiveQuestions } from '../src/proactiveReaper.js';
import { gatherFacts, evaluate } from '../src/guardian.js';
import { buildPersonalHealthspan } from '../src/healthspanEngine.js';
import { validateExplanation } from '../src/publishGuard.js';
import { renderAssertions } from '../src/assertionRenderer.js';
import { factsFromQaResult } from '../src/publishableFacts.js';
import { authorizesProactiveMessaging } from '../src/capabilityMap.js';
import { prepareAuthorization, completeAuthorization } from '../src/oauthFlow.js';
import { questionTargetDate } from '../src/questionEngine.js';
import { assessPrediction, READINESS_STATUS } from '../src/readiness.js';
import { DEFAULT_FEATURES, train, buildSupervised } from '../src/prediction.js';
import {
  LINK_STATUS, PROACTIVE_QUESTION_INTENT, isSafePrivateChatId,
} from '../src/schema.js';
import { STATUS } from '../src/capabilities.js';

const NOW = new Date('2026-09-11T00:00:00Z');
const SENT = new Date(NOW.getTime() - 72 * 3600_000);

const ENV = {
  telegramBotToken: 'T', tursoUrl: 'file:x', tursoToken: 't',
  whoopClientId: 'c', whoopClientSecret: 's',
  openrouterApiKey: 'k', openrouterModel: 'm',
  timezone: 'Asia/Taipei', dryRun: false,
};

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-reaudit-'));
  const db = createDb({ url: `file:${path.join(dir, 't.db')}` });
  return { db, dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/** 兩個真實形狀的使用者：各自私訊綁定、各自 WHOOP 身分、各自資料。 */
async function withPair(fn) {
  const { db, cleanup } = tempDb();
  try {
    await db.migrate();
    const alice = await db.createUser({ displayName: 'Alice', timezone: 'Asia/Taipei' });
    const bob = await db.createUser({ displayName: 'Bob', timezone: 'America/New_York' });
    await db.linkTelegram({ chatId: '1001', userId: alice.id });
    await db.linkTelegram({ chatId: '1002', userId: bob.id });
    await db.saveTokens(alice.id, {
      accessToken: 'a', refreshToken: 'r',
      expiresAt: new Date(NOW.getTime() + 3600_000), scope: 's', whoopUserId: '111',
    });
    await db.saveTokens(bob.id, {
      accessToken: 'b', refreshToken: 'r',
      expiresAt: new Date(NOW.getTime() + 3600_000), scope: 's', whoopUserId: '222',
    });
    await fn(db, alice, bob);
  } finally {
    db.close();
    cleanup();
  }
}

// ===========================================================================
// 1 + 2. 多使用者隔離 × Telegram 私訊限定（入站與出站）
// ===========================================================================

test('★★★ 再稽核 1+2: 群組 chat 在入站與出站都不可能成為身分或目的地', async () => {
  await withPair(async (db, alice, bob) => {
    // 歷史遺留的群組綁定（現在的程式已經寫不進去了）
    await db.raw.execute({
      sql: `INSERT INTO user_telegram (telegram_chat_id, user_id, linked_at, status)
            VALUES ('-100500', ?, ?, 'ACTIVE')`,
      args: [alice.id, '2026-01-01T00:00:00.000Z'],
    });

    // 入站
    assert.equal(await db.resolveUserByChatId('-100500'), null);
    // 出站（並且順手退役）
    assert.equal(await db.getActiveChatIdForUser(alice.id), '1001',
      '★ 有正常私訊時回私訊');
    assert.equal((await db.getTelegramLink('-100500')).status, LINK_STATUS.RETIRED_UNSAFE);
    // 綁定邊界
    await assert.rejects(() => db.linkTelegram({ chatId: '-999', userId: bob.id }),
      (e) => e.code === 'UNSAFE_CHAT_DESTINATION');
    // 判準本身
    assert.equal(isSafePrivateChatId('1001'), true);
    assert.equal(isSafePrivateChatId('-100500'), false);
  });
});

// ===========================================================================
// 3 + 4. WHOOP 身分不可變 × OAuth 並發
// ===========================================================================

test('★★★ 再稽核 3+4: 身分不可變、跨使用者唯一、並發只有一個贏', async () => {
  await withPair(async (db, alice, bob) => {
    const exchange = async () => ({
      accessToken: 'x', refreshToken: 'y',
      expiresAt: new Date(NOW.getTime() + 3600_000), scope: 's',
    });
    const go = async (userId, whoopId) => {
      const { state } = await prepareAuthorization({
        db, userId, clientId: 'c', redirectUri: 'r',
      });
      return completeAuthorization({
        db, rawState: state, code: 'c', exchange, verifyIdentity: async () => whoopId,
      });
    };

    // Alice 已經是 111 → 換成別的一律拒絕
    await assert.rejects(() => go(alice.id, '999'),
      (e) => e.code === 'WHOOP_ACCOUNT_MISMATCH');
    // Bob 不可以搶 Alice 的帳號
    await assert.rejects(() => go(bob.id, '111'),
      (e) => e.code === 'WHOOP_ACCOUNT_ALREADY_LINKED');
    // 兩人都保持原本的身分
    assert.equal((await db.getTokens(alice.id)).whoopUserId, '111');
    assert.equal((await db.getTokens(bob.id)).whoopUserId, '222');

    // 一個全新的使用者，兩個並發授權 → 恰好一個成功
    const carol = await db.createUser({ displayName: 'Carol' });
    const s1 = (await prepareAuthorization({ db, userId: carol.id, clientId: 'c', redirectUri: 'r' })).state;
    const s2 = (await prepareAuthorization({ db, userId: carol.id, clientId: 'c', redirectUri: 'r' })).state;
    const rs = await Promise.allSettled([
      completeAuthorization({ db, rawState: s1, code: 'c', exchange, verifyIdentity: async () => 'c-a' }),
      completeAuthorization({ db, rawState: s2, code: 'c', exchange, verifyIdentity: async () => 'c-b' }),
    ]);
    assert.equal(rs.filter((r) => r.status === 'fulfilled').length, 1);
  });
});

// ===========================================================================
// 5 + 6. 主動狀態機收斂 × Guardian 假警報
// ===========================================================================

test('★★★ 再稽核 5+6: 每一種卡住狀態都收斂，Guardian 的 stuck 回到 0', async () => {
  await withPair(async (db, alice) => {
    const mk = async (key, finish) => {
      const { id } = await db.claimProactiveEvent(alice.id, {
        healthDate: '2026-09-08', idempotencyKey: key, signals: [],
        decision: 'ASK_CONTEXT', reason: {}, policyVersion: 'v1', messageText: 'q',
      }, { now: SENT });
      const qid = await db.openPendingQuestion(alice.id, {
        chatId: '1001', question: 'q', intent: PROACTIVE_QUESTION_INTENT,
        contextJson: { proactive_event_id: id }, ttlMs: 30 * 60_000,
      }, { now: SENT });
      await db.markProactiveEventSent(alice.id, id, { pendingQuestionId: qid }, { now: SENT });
      if (finish) await finish(qid);
      return id;
    };
    // ⚠️ 一個使用者同時只有一個 OPEN 追問（後開的會 SUPERSEDE 先開的），
    // 所以順序很重要：先建立「已回答」的那個（它的追問不再是 OPEN），
    // 再建立「放到過期」的那個。
    const answered = await mk('e1', (qid) => db.resolvePendingQuestion(alice.id, qid, '嗯', { now: SENT }));
    const expired = await mk('e2', null);
    // NOTIFY：送出即終局
    const { id: notify } = await db.claimProactiveEvent(alice.id, {
      healthDate: '2026-09-08', idempotencyKey: 'e3', signals: [],
      decision: 'NOTIFY', reason: {}, policyVersion: 'v1', messageText: 'n',
    }, { now: SENT });
    await db.markProactiveEventSent(alice.id, notify, { pendingQuestionId: null }, { now: SENT });

    const before = await db.countStuckProactiveEvents(alice.id, { olderThanIso: NOW.toISOString() });
    assert.ok(before.count >= 2, `前置：確實有卡住的事件（${before.count}）`);

    await reapExpiredProactiveQuestions({ db, userId: alice.id, now: NOW });

    const outcome = async (id) => (await db.raw.execute({
      sql: 'SELECT outcome FROM proactive_events WHERE id = ?', args: [id],
    })).rows[0].outcome;
    assert.equal(await outcome(expired), 'NO_RESPONSE');
    assert.equal(await outcome(answered), 'ABANDONED');
    assert.equal(await outcome(notify), 'DELIVERED');

    const after = await db.countStuckProactiveEvents(alice.id, { olderThanIso: NOW.toISOString() });
    assert.equal(after.count, 0, '★ Guardian 不可以再看到任何卡住的事件');

    const facts = await gatherFacts({ db, now: NOW });
    const signals = evaluate({ ...facts, now: NOW }).map((f) => f.signal);
    assert.ok(!signals.includes('proactive_event_stuck'), '★ 也不可以再發假警報');
  });
});

// ===========================================================================
// 7. Journal 日期正確性
// ===========================================================================

test('★★★ 再稽核 7: 「昨天有喝酒嗎？」的答案記在訊號日的前一天', async () => {
  await withPair(async (db, alice) => {
    const signal = { metric: 'hrv', direction: 'low', level: 'STRONG', health_date: '2026-02-06' };
    const target = questionTargetDate({ category: 'alcohol', signal });
    assert.equal(target, '2026-02-05');

    const askAt = new Date('2026-02-06T01:00:00Z');
    await db.openPendingQuestion(alice.id, {
      chatId: '1001', question: '昨天有喝酒嗎？', intent: PROACTIVE_QUESTION_INTENT,
      contextJson: { health_date: '2026-02-06', question_target_date: target, signal },
      ttlMs: 30 * 60_000,
    }, { now: askAt });

    const router = createRouter({
      db,
      coachFor: () => ({
        async json() {
          return { asserted: true, about_self: true, negated: false, hypothetical: false, category: 'alcohol', subtype: 'beer', numeric_value: 2, unit: 'cup', confidence: 0.9 };
        },
        async ask() { return null; },
      }),
      now: () => new Date('2026-02-06T01:10:00Z'),
    });
    await router.handle({ text: '喝了兩杯', chatId: '1001', user: { id: alice.id, timezone: 'Asia/Taipei' } });

    const events = await db.getJournalEvents(alice.id, { from: '2026-02-01', to: '2026-02-28', limit: 10 });
    assert.deepEqual(events.map((e) => e.health_date), ['2026-02-05']);
  });
});

// ===========================================================================
// 8. Telegram 重送冪等（含認領不可用時 fail closed）
// ===========================================================================

test('★★★ 再稽核 8: 重送不重複；認領不可用時不處理也不丟訊息', async () => {
  await withPair(async (db, alice) => {
    const router = createRouter({
      db,
      coachFor: () => ({
        async json() {
          return { asserted: true, about_self: true, negated: false, hypothetical: false, category: 'alcohol', subtype: 'beer', numeric_value: 2, unit: 'cup', confidence: 0.9 };
        },
        async ask() { return null; },
      }),
      now: () => NOW,
    });
    const mkPoller = (useDb) => createPoller({
      db: useDb, botToken: 'T',
      api: { async getUpdates() { return []; }, async sendMessage() { return {}; } },
      resolveUser: (c) => db.resolveUserByChatId(c),
      handleMessage: async ({ text, chatId, user }) => { await router.handle({ text, chatId, user }); },
      sleepImpl: async () => {},
    });
    const upd = {
      update_id: 500,
      message: {
        message_id: 500, chat: { id: 1001, type: 'private' },
        from: { id: 1001, is_bot: false }, text: '喝了兩杯', date: 1,
      },
    };
    const count = async () => (await db.getJournalEvents(alice.id, {
      from: '2026-09-01', to: '2026-09-30', limit: 50,
    })).length;

    // 認領不可用 → 不處理、不推進 offset
    const broken = { ...db, claimTelegramUpdate: async () => { throw new Error('down'); } };
    const next = await mkPoller(broken).processBatch([upd], 0);
    assert.equal(await count(), 0);
    assert.equal(next, 0, '★ 不可以跳過那一則');

    // 恢復 → 恰好處理一次
    await mkPoller(db).processBatch([upd], 0);
    assert.equal(await count(), 1);
    // 重送 → 不重複
    await db.setUpdateOffset(0);
    await mkPoller(db).processBatch([upd], 0);
    assert.equal(await count(), 1);
  });
});

// ===========================================================================
// 9. capability fail-closed
// ===========================================================================

test('★★★ 再稽核 9: 只有 SUPPORTED 授權主動訊息', () => {
  assert.equal(authorizesProactiveMessaging(STATUS.SUPPORTED), true);
  for (const st of [STATUS.PARTIAL, STATUS.UNKNOWN, STATUS.UNAVAILABLE,
    STATUS.UNAUTHORIZED, STATUS.APP_ONLY, null, undefined, 'NEW_STATUS']) {
    assert.equal(authorizesProactiveMessaging(st), false, `★ ${st} 不可以授權`);
  }
});

// ===========================================================================
// 10. 敘述的結構化證據邊界
// ===========================================================================

test('★★★ 再稽核 10: 發布邊界 —— 斷言來自渲染器，說明不得含任何生理斷言', () => {
  const set = factsFromQaResult({
    available: true, health_date: '2026-09-09', history_days: 30,
    metrics: {
      recovery_score: {
        label: '恢復', value: 55, display: '55%',
        baseline_display: '62%', baseline_n: 30, z_score: -0.8,
      },
      hrv: { label: 'HRV', value: null, display: null, baseline_n: 0, z_score: null },
    },
  });

  // 確定性斷言只從可發布的事實產生
  const { lines, unavailable } = renderAssertions(set);
  assert.deepEqual(lines, ['恢復 55%']);
  assert.deepEqual(unavailable, ['HRV'], '★ 拿不到的要誠實列出');

  // LLM 說明夾帶任何生理斷言都要被丟掉
  for (const bad of [
    '你今天的恢復是 99%。',
    '恢復為 30%。',
    '恢復。今天的數值是 99%。',
    '你的 HRV 是 30ms。',
    'HRV 九九毫秒。',
    '你的 HRV 偏高。',
    '恢復是三十%。',
    'Recovery is thirty percent.',
    'WHOOP 的年齡是三十歲。',
    'WHOOP Healthspan 分數 88。',
    '服用阿斯匹靈。',
    'Take Zorblax every night.',
    '去打一針。',
    '你有睡眠呼吸中止。',
    '每小時量一次血壓。',
    '恢復九成九。',
  ]) {
    assert.equal(validateExplanation(bad).ok, false, `★ 放行了：${bad}`);
  }

  // 正常的鼓勵話語必須留得住
  assert.equal(
    validateExplanation('Kelvin，今天整體看起來穩定，照平常節奏走就好 💛').ok, true,
  );
});

// ===========================================================================
// 11. 預測沒有 D→D+1 洩漏
// ===========================================================================

test('★★★ 再稽核 11: 預測仍然只用 D 的特徵預測 D+1（沒有反向洩漏）', () => {
  const mkRows = (n, tweakLast = null) => {
    const out = [];
    for (let i = 0; i < n; i += 1) {
      const row = {
        health_date: new Date(Date.parse('2026-05-01T00:00:00Z') + i * 86_400_000)
          .toISOString().slice(0, 10),
        recovery: 60 + (i % 11), hrv: 50 + (i % 7), rhr: 55 + (i % 5),
        sleep_total: 25_200_000 + (i % 3) * 600_000,
        sleep_performance: 85 + (i % 6), respiratory_rate: 15,
        previous_day_strain: 10 + (i % 4), sleep_consistency: 80 + (i % 5),
        sleep_efficiency: 90 + (i % 4), slow_wave: 5_400_000, rem: 5_400_000,
        sleep_debt: 0, spo2: 96, skin_temp: 33.5, disturbance_count: 2,
      };
      out.push(row);
    }
    if (tweakLast) Object.assign(out[out.length - 1], tweakLast);
    return out;
  };

  const rows = mkRows(120);
  const fit = train(rows, { target: 'recovery', features: DEFAULT_FEATURES });
  assert.ok(fit.ok, `前置：模型要訓練得出來（${fit.status}）`);
  assert.equal(assessPrediction({ rows }).status, READINESS_STATUS.READY);

  // 監督樣本的形狀本身就是不變量：特徵是 D、target 是 D+1
  const samples = buildSupervised(rows, { target: 'recovery', features: DEFAULT_FEATURES });
  assert.equal(samples.length, rows.length - 1, '★ 最後一天沒有 D+1，不可以成為樣本');
  for (let i = 0; i < samples.length; i += 1) {
    assert.equal(samples[i].recovery, rows[i + 1].recovery,
      '★ target 必須來自 D+1');
    assert.equal(samples[i].hrv, rows[i].hrv, '★ 特徵必須來自 D');
  }

  // 反向洩漏檢查：把**最後一天**的 target 改掉，不可以影響其他樣本
  const mutated = mkRows(120, { recovery: 999 });
  const a = buildSupervised(rows, { target: 'recovery', features: DEFAULT_FEATURES });
  const b = buildSupervised(mutated, { target: 'recovery', features: DEFAULT_FEATURES });
  assert.equal(a.length, b.length);
  for (let i = 0; i < a.length - 1; i += 1) {
    assert.deepEqual(b[i], a[i], `★ 第 ${i} 個樣本不可以被未來的值影響`);
  }
  assert.equal(b[b.length - 1].recovery, 999, '只有最後一個樣本的 target 該變');
});

// ===========================================================================
// 12. Healthspan 仍然 fail-closed
// ===========================================================================

test('★★★ 再稽核 12: Healthspan 分數永遠是 null，錨點永遠是最新日', () => {
  const rows = [];
  for (let i = 0; i < 120; i += 1) {
    rows.push({
      health_date: new Date(Date.parse('2026-09-09T00:00:00Z') - i * 86_400_000)
        .toISOString().slice(0, 10),
      hrv: 50, rhr: 52, recovery: 60, respiratory_rate: 15, sleep_total: 25_200_000,
    });
  }
  const r = buildPersonalHealthspan(rows, { capabilities: {} });
  assert.equal(r.anchorDate, '2026-09-09', '★ 錨點是最新那天');
  assert.equal(r.score, null, '★ 分數永遠 null');
  assert.equal(r.scoreKind ?? null, null);
  // 順序無關
  assert.equal(buildPersonalHealthspan([...rows].reverse(), { capabilities: {} }).anchorDate,
    '2026-09-09');
});

// ===========================================================================
// 13. 遷移安全（有資料的資料庫，重複 migrate）
// ===========================================================================

test('★★★ 再稽核 13: 有資料的資料庫重複 migrate → 零重建、零資料變動', async () => {
  const { db, cleanup } = tempDb();
  try {
    await db.migrate();
    const user = await db.createUser({ displayName: 'K', timezone: 'Asia/Taipei' });
    await db.linkTelegram({ chatId: '1001', userId: user.id });
    await db.saveTokens(user.id, {
      accessToken: 'a', refreshToken: 'r',
      expiresAt: new Date(NOW.getTime() + 3600_000), scope: 's', whoopUserId: '111',
    });
    await db.addJournalEvent(user.id, {
      eventAt: '2026-09-08T12:00:00.000Z', healthDate: '2026-09-08',
      category: 'alcohol', note: 'x', source: 'manual',
    });
    const { id: ev } = await db.claimProactiveEvent(user.id, {
      healthDate: '2026-09-08', idempotencyKey: 'k1', signals: [],
      decision: 'ASK_CONTEXT', reason: {}, policyVersion: 'v1', messageText: 'q',
    }, { now: SENT });
    await db.markProactiveEventSent(user.id, ev, { pendingQuestionId: null }, { now: SENT });
    await db.claimTelegramUpdate(999, { owner: 'w1' });
    await db.acquireLock('some:lock', { ttlMs: 60_000, now: NOW });

    const tables = [
      'users', 'user_telegram', 'user_whoop_tokens', 'journal_events',
      'proactive_events', 'telegram_processed_updates', 'resource_locks',
    ];
    const snapshot = async () => {
      const out = {};
      for (const t of tables) {
        out[t] = (await db.raw.execute(`SELECT * FROM ${t} ORDER BY rowid`)).rows;
      }
      return out;
    };
    const before = await snapshot();

    const summary = await db.migrate();
    assert.deepEqual(summary.rebuilt, [], '★ 不可以重建任何表');
    assert.equal(summary.to, SCHEMA_VERSION, '★ 版本號就是目前的 schema 版本');

    assert.deepEqual(await snapshot(), before, '★ 每一張表的每一列都必須一模一樣');
  } finally {
    db.close();
    cleanup();
  }
});

// ===========================================================================
// 14. 冷啟動
// ===========================================================================

test('★★★ 再稽核 14: 全新帳號不會誤報故障、不會亂發訊息、維護照跑', async () => {
  const { db, cleanup } = tempDb();
  try {
    await db.migrate();
    const user = await db.createUser({ displayName: 'New', timezone: 'Asia/Taipei' });
    await db.linkTelegram({ chatId: '1001', userId: user.id });

    // 還沒授權 WHOOP → Guardian 不該報任何東西
    const facts = await gatherFacts({ db, now: NOW });
    assert.deepEqual(evaluate({ ...facts, now: NOW }), [],
      '★ 「還沒開始用」不是故障');

    // 也不該有任何主動訊息
    const calls = [];
    const out = await runForUser({
      db, env: ENV, user: { id: user.id, timezone: 'Asia/Taipei' }, now: NOW,
      deps: {
        makeTelegram: () => ({
          async send(t) { calls.push({ k: 'send', t }); },
          async notifyError(type) { calls.push({ k: 'err', type }); },
        }),
        makeWhoop: () => ({ async getAccessToken() { throw new Error('no tokens'); } }),
        makeCoach: () => ({}), makeSource: () => ({}),
        daily: async () => ({ status: 'skipped' }),
        weekly: async () => ({ status: 'skipped' }),
        makeSync: () => ({ async syncAll() { return []; } }),
        proactive: async () => ({ triggered: false }),
      },
    });
    assert.ok(!calls.some((c) => c.k === 'send'), '★ 冷啟動不可以主動送訊息');
    assert.ok(out.reaped, '★ 但維護仍然要跑（R2-M-06）');
    assert.equal(out.reaped.noResponse, 0, '沒有東西要收斂');
  } finally {
    db.close();
    cleanup();
  }
});
