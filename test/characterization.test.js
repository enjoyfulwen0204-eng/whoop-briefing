/**
 * V1.1 特徵化測試（characterization tests）。
 *
 * ## 這個檔案的用途跟其他測試不一樣
 *
 * 這裡凍結的是**改動之前的現況行為**，不是「應該要有的行為」。
 * V1.1 要動的東西（NO_RESPONSE 生命週期、sync 與報告解耦、預測發布閘門、
 * capability 接線）全部都踩在既有的高風險路徑上，所以先把現況釘住：
 * 之後任何一個 phase 只要不小心改到不該改的地方，這裡會先紅。
 *
 * 特別重要的是 A 組：Attention Engine 只讀 `decision` / `createdAt` /
 * `signals`，**完全沒有讀 `outcome`**。這正是「事後補寫 NO_RESPONSE 不會
 * 污染冷卻與每日上限」的結構性理由 —— 不是靠實作小心，是靠 decide()
 * 根本看不到那個欄位。所以這件事一定要有測試守著。
 *
 * 全程不呼叫真的 WHOOP / OpenRouter / Telegram。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createDb } from '../src/db.js';
import { decide } from '../src/attention.js';
import { PROACTIVE_DECISION, PROACTIVE_OUTCOME } from '../src/schema.js';
import { ANTI_SPAM_POLICY, ATTENTION_POLICY } from '../src/proactivePolicy.js';
import { DEVIATION } from '../src/analytics/anomaly.js';
import { dueForUser, runForUser } from '../src/index.js';
import { handlePredictions } from '../src/bot/commands.js';
import { assessDeviation, READINESS_STATUS } from '../src/readiness.js';
import { STATUS as CAPABILITY_STATUS } from '../src/capabilities.js';
import {
  buildSupervised, temporalSplit, assertNoLeakage, MIN_TRAIN_ROWS,
} from '../src/prediction.js';
import { ALICE, BOB, seedAliceAndBob } from './users.js';
import { trainableRows } from './predictionFixtures.js';

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v11-char-'));
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

const NOW = new Date('2026-09-09T00:00:00Z');
const hoursAgo = (h) => new Date(NOW.getTime() - h * 3600_000).toISOString();

const signal = (metric, code, level = DEVIATION.STRONG) => ({
  metric, code, level, direction: 'low', health_date: '2026-09-09',
});

/** recentEvents 一列（getRecentProactiveEvents 的形狀）。 */
const evt = ({
  code, decision = PROACTIVE_DECISION.ASK_CONTEXT, hours = 1, outcome = null,
}) => ({
  id: 1,
  decision,
  createdAt: hoursAgo(hours),
  signals: [{ code }],
  outcome,
  resolvedAt: outcome ? hoursAgo(hours) : null,
});

// ===========================================================================
// A. Attention Engine —— 冷卻 / 新鮮度 / 每日上限 / 未答問題
// ===========================================================================

test('[char-A1] decide(): 同一主題在冷卻窗內 → 該主題被遮蔽', () => {
  const signals = [signal('hrv', 'HRV_LOW')];
  const recent = [evt({ code: 'HRV_LOW', hours: 1 })];
  const d = decide({ signals, now: NOW, recentEvents: recent });

  assert.equal(d.decision, PROACTIVE_DECISION.LOG_ONLY);
  assert.equal(d.reason, 'topic_cooldown_active');
  assert.deepEqual(d.factors.masked_by_cooldown, ['HRV_LOW']);
  assert.equal(d.factors.all_topics_in_cooldown, true);
});

test('[char-A2] decide(): 冷卻不連坐 —— 另一個領域的新訊號仍可被評估', () => {
  const signals = [
    signal('hrv', 'HRV_LOW'),
    signal('respiratory_rate', 'RESPIRATORY_RATE_HIGH'),
  ];
  const recent = [evt({ code: 'HRV_LOW', hours: 1 })];
  const d = decide({ signals, now: NOW, recentEvents: recent });

  assert.equal(d.factors.evaluated_code, 'RESPIRATORY_RATE_HIGH');
  assert.deepEqual(d.factors.masked_by_cooldown, ['HRV_LOW']);
  assert.notEqual(d.decision, PROACTIVE_DECISION.LOG_ONLY);
});

test('[char-A3] decide(): 冷卻窗外的同一主題不再遮蔽', () => {
  const signals = [signal('hrv', 'HRV_LOW')];
  const recent = [evt({ code: 'HRV_LOW', hours: ANTI_SPAM_POLICY.TOPIC_COOLDOWN_HOURS + 1 })];
  const d = decide({ signals, now: NOW, recentEvents: recent });

  assert.deepEqual(d.factors.masked_by_cooldown, []);
  assert.equal(d.factors.evaluated_code, 'HRV_LOW');
});

test('[char-A4] decide(): 只有 messaging 決策才進冷卻（LOG_ONLY 不算打擾過）', () => {
  const signals = [signal('hrv', 'HRV_LOW')];
  const recent = [evt({ code: 'HRV_LOW', decision: PROACTIVE_DECISION.LOG_ONLY, hours: 1 })];
  const d = decide({ signals, now: NOW, recentEvents: recent });

  assert.deepEqual(d.factors.masked_by_cooldown, []);
});

test('[char-A5] decide(): 每日上限達到 → LOG_ONLY（且優先於其他判斷）', () => {
  const signals = [signal('hrv', 'HRV_LOW')];
  const recent = Array.from(
    { length: ANTI_SPAM_POLICY.DAILY_PROACTIVE_CAP },
    (_, i) => evt({ code: `OTHER_${i}`, hours: 2 }),
  );
  const d = decide({ signals, now: NOW, recentEvents: recent });

  assert.equal(d.decision, PROACTIVE_DECISION.LOG_ONLY);
  assert.equal(d.reason, 'daily_cap_reached');
  assert.equal(d.factors.daily_cap_reached, true);
});

test('[char-A6] decide(): 新鮮但非持續、且無多重佐證 → 低於行動門檻', () => {
  const signals = [signal('hrv', 'HRV_LOW', DEVIATION.NOTABLE)];
  const d = decide({ signals, now: NOW, recentEvents: [] });

  assert.equal(d.decision, PROACTIVE_DECISION.LOG_ONLY);
  assert.equal(d.reason, 'below_action_threshold');
  assert.equal(d.factors.novel, true);
  assert.equal(d.factors.persistent, false);
});

test('[char-A7] decide(): 已知脈絡（當天已有 journal）→ LOG_ONLY', () => {
  const signals = [
    signal('hrv', 'HRV_LOW'),
    signal('respiratory_rate', 'RESPIRATORY_RATE_HIGH'),
  ];
  const d = decide({
    signals, now: NOW, recentEvents: [], journalCoversHealthDate: true,
  });

  assert.equal(d.decision, PROACTIVE_DECISION.LOG_ONLY);
  assert.equal(d.reason, 'context_already_explained');
});

test('[char-A8] decide(): 已有未答問題 → 嚴重且有佐證時降級成 NOTIFY 而不是再問一題', () => {
  const signals = [
    signal('hrv', 'HRV_LOW'),
    signal('respiratory_rate', 'RESPIRATORY_RATE_HIGH'),
  ];
  const d = decide({
    signals, now: NOW, recentEvents: [], hasOpenQuestion: true,
  });

  assert.equal(d.decision, PROACTIVE_DECISION.NOTIFY);
  assert.equal(d.reason, 'already_has_open_question');
  assert.equal(d.factors.has_open_question, true);
});

test('[char-A9] decide(): 多重生理領域佐證 → ASK_CONTEXT', () => {
  const signals = [
    signal('hrv', 'HRV_LOW'),
    signal('respiratory_rate', 'RESPIRATORY_RATE_HIGH'),
  ];
  const d = decide({ signals, now: NOW, recentEvents: [] });

  assert.equal(d.decision, PROACTIVE_DECISION.ASK_CONTEXT);
  assert.equal(d.factors.multi_signal_confirmation, true);
  assert.equal(d.factors.domain_count, 2);
});

test('[char-A10] decide(): 同一領域的多個訊號不算多重佐證（recovery 由 hrv/rhr 算出）', () => {
  const signals = [
    signal('hrv', 'HRV_LOW'),
    signal('rhr', 'RHR_HIGH'),
    signal('recovery', 'RECOVERY_LOW'),
  ];
  const d = decide({ signals, now: NOW, recentEvents: [] });

  assert.equal(d.factors.domain_count, 1);
  assert.equal(d.factors.multi_signal_confirmation, false);
});

// ---------------------------------------------------------------------------
// ★★★ A11 —— V1.1 Phase 5 的結構性安全理由
// ---------------------------------------------------------------------------

test('[char-A11] ★ decide() 完全不讀 outcome —— 事後補寫 outcome 不可能改變任何決策', () => {
  const signals = [signal('hrv', 'HRV_LOW')];

  // 完全相同的事件，只有 outcome 不同
  for (const outcome of [
    null,
    PROACTIVE_OUTCOME.NO_RESPONSE,
    PROACTIVE_OUTCOME.EXPLAINED,
    PROACTIVE_OUTCOME.STILL_UNEXPLAINED,
    PROACTIVE_OUTCOME.NO_EXPLANATION_OFFERED,
  ]) {
    const d = decide({
      signals, now: NOW, recentEvents: [evt({ code: 'HRV_LOW', hours: 1, outcome })],
    });
    assert.equal(
      d.decision, PROACTIVE_DECISION.LOG_ONLY,
      `outcome=${outcome} 不可以改變決策`,
    );
    assert.equal(d.reason, 'topic_cooldown_active');
    assert.deepEqual(d.factors.masked_by_cooldown, ['HRV_LOW']);
  }
});

test('[char-A12] ★ 每日上限只數 decision，與 outcome 無關', () => {
  const signals = [signal('hrv', 'HRV_LOW')];
  const withOutcome = Array.from(
    { length: ANTI_SPAM_POLICY.DAILY_PROACTIVE_CAP },
    (_, i) => evt({ code: `OTHER_${i}`, hours: 2, outcome: PROACTIVE_OUTCOME.NO_RESPONSE }),
  );
  const withoutOutcome = withOutcome.map((e) => ({ ...e, outcome: null, resolvedAt: null }));

  const a = decide({ signals, now: NOW, recentEvents: withOutcome });
  const b = decide({ signals, now: NOW, recentEvents: withoutOutcome });

  assert.equal(a.decision, b.decision);
  assert.equal(a.factors.daily_cap_reached, true);
  assert.equal(b.factors.daily_cap_reached, true);
});

test('[char-A13] ★ 新鮮度 / 持續性只看 createdAt，與 outcome 無關', () => {
  const signals = [signal('hrv', 'HRV_LOW')];
  const base = { code: 'HRV_LOW', hours: ATTENTION_POLICY.NOVELTY_WINDOW_DAYS * 24 - 1 };

  const a = decide({ signals, now: NOW, recentEvents: [evt({ ...base })] });
  const b = decide({
    signals, now: NOW, recentEvents: [evt({ ...base, outcome: PROACTIVE_OUTCOME.NO_RESPONSE })],
  });

  assert.equal(a.factors.novel, b.factors.novel);
  assert.equal(a.factors.persistent, b.factors.persistent);
});

// ===========================================================================
// B. Proactive event 查詢的現況
// ===========================================================================

test('[char-B1] getRecentProactiveEvents 回傳 outcome/resolvedAt 欄位（預設 null）', async () => {
  await withDb(async (db) => {
    const claim = await db.claimProactiveEvent(ALICE.id, {
      healthDate: '2026-09-09',
      idempotencyKey: 'k1',
      signals: [{ code: 'HRV_LOW' }],
      decision: PROACTIVE_DECISION.ASK_CONTEXT,
      reason: {},
      policyVersion: 'p1',
      messageText: 'q',
    }, { now: NOW });
    assert.equal(claim.claimed, true);

    const rows = await db.getRecentProactiveEvents(ALICE.id, {
      sinceIso: '2026-01-01T00:00:00.000Z',
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].outcome, null);
    assert.equal(rows[0].resolvedAt, null);
    assert.equal(rows[0].decision, PROACTIVE_DECISION.ASK_CONTEXT);
  });
});

test('[char-B2] resolveProactiveEvent 只改 outcome/resolved_at，不動 decision/created_at/signals', async () => {
  await withDb(async (db) => {
    const claim = await db.claimProactiveEvent(ALICE.id, {
      healthDate: '2026-09-09',
      idempotencyKey: 'k2',
      signals: [{ code: 'HRV_LOW' }],
      decision: PROACTIVE_DECISION.ASK_CONTEXT,
      reason: {},
      policyVersion: 'p1',
      messageText: 'q',
    }, { now: NOW });

    const before = (await db.getRecentProactiveEvents(ALICE.id, {
      sinceIso: '2026-01-01T00:00:00.000Z',
    }))[0];

    await db.resolveProactiveEvent(
      ALICE.id, claim.id, PROACTIVE_OUTCOME.STILL_UNEXPLAINED, { now: NOW },
    );

    const after = (await db.getRecentProactiveEvents(ALICE.id, {
      sinceIso: '2026-01-01T00:00:00.000Z',
    }))[0];

    assert.equal(after.decision, before.decision);
    assert.equal(after.createdAt, before.createdAt);
    assert.deepEqual(after.signals, before.signals);
    assert.equal(after.outcome, PROACTIVE_OUTCOME.STILL_UNEXPLAINED);
    assert.ok(after.resolvedAt);
  });
});

test('[char-B3] resolveProactiveEvent 不可跨使用者', async () => {
  await withDb(async (db) => {
    const claim = await db.claimProactiveEvent(ALICE.id, {
      healthDate: '2026-09-09',
      idempotencyKey: 'k3',
      signals: [],
      decision: PROACTIVE_DECISION.NOTIFY,
      reason: {},
      policyVersion: 'p1',
      messageText: 'n',
    }, { now: NOW });

    const ok = await db.resolveProactiveEvent(
      BOB.id, claim.id, PROACTIVE_OUTCOME.EXPLAINED, { now: NOW },
    );
    assert.equal(ok, false);

    const alice = (await db.getRecentProactiveEvents(ALICE.id, {
      sinceIso: '2026-01-01T00:00:00.000Z',
    }))[0];
    assert.equal(alice.outcome, null);
  });
});

// ===========================================================================
// C. 報告 due 判斷 vs sync / proactive 執行（改動前的耦合現況）
// ===========================================================================

const ENV = {
  telegramBotToken: 'T', telegramChatId: 'bootstrap', dryRun: false,
  whoopClientId: 'c', whoopClientSecret: 's',
  openrouterApiKey: 'k', openrouterModel: 'm',
  maxUserConcurrency: 3,
};

function spyDeps(calls) {
  return {
    makeTelegram: () => ({
      async send() { calls.push('telegram.send'); return { messageId: 1 }; },
      async notifyError(type) { calls.push(`telegram.error:${type}`); return true; },
      async sendTyping() { return true; },
    }),
    makeWhoop: () => ({ getAccessToken: async () => { calls.push('whoop.token'); return 'tok'; } }),
    makeCoach: () => ({ daily: async () => null, weekly: async () => null }),
    makeSource: () => ({ poll: async () => ({ sleeps: [], recoveries: [] }) }),
    daily: async () => { calls.push('daily'); return { status: 'not_ready' }; },
    weekly: async () => { calls.push('weekly'); return { status: 'skipped' }; },
    makeSync: () => ({ syncAll: async () => { calls.push('sync'); return { resources: {} }; } }),
    proactive: async () => { calls.push('proactive'); return { triggered: false }; },
  };
}

test('[char-C1] 有報告要發時：daily / sync / proactive 都會執行', async () => {
  await withDb(async (db) => {
    const calls = [];
    const now = new Date('2026-09-09T00:00:00Z');
    const out = await runForUser({
      db, env: ENV, user: { id: ALICE.id, timezone: ALICE.timezone }, now, deps: spyDeps(calls),
    });

    assert.equal(out.skipped, null);
    assert.ok(calls.includes('daily'));
    assert.ok(calls.includes('sync'));
    assert.ok(calls.includes('proactive'));
  });
});

test('[char-C2] 報告都已送出時：目前會整個早退，sync 與 proactive 都不執行', async () => {
  await withDb(async (db) => {
    const now = new Date('2026-09-09T00:00:00Z');
    const due = await dueForUser({
      db, userId: ALICE.id, timezone: ALICE.timezone, now,
    });

    // 讓 daily 今天與昨天都已送出、weekly 也已送出 → anythingDue = false
    for (const key of [due.today, due.yesterday]) {
      await db.recordRun({
        userId: ALICE.id, reportType: 'daily', localDateKey: key,
        healthDate: key, status: 'SENT', detail: null,
      });
    }
    await db.recordRun({
      userId: ALICE.id, reportType: 'weekly', localDateKey: due.weekKey,
      healthDate: due.weekKey, status: 'SENT', detail: null,
    });

    const settled = await dueForUser({
      db, userId: ALICE.id, timezone: ALICE.timezone, now,
    });
    assert.equal(settled.anythingDue, false);

    const calls = [];
    const out = await runForUser({
      db, env: ENV, user: { id: ALICE.id, timezone: ALICE.timezone }, now, deps: spyDeps(calls),
    });

    // ⚠️ V1.1 Phase 7 刻意改變了這裡的行為。
    //
    // 舊行為（這個測試原本凍結的）：沒有報告要發 → 整個早退，
    // 連 sync 與 proactive 都不跑。
    //
    // 新行為：報告 due 與資料新鮮度是獨立的。這個使用者從來沒同步過
    // （沒有任何 whoop_sync_state 列），所以 sync 仍然是 due 的 →
    // 即使沒有報告要發，同步與主動代理照樣執行。
    //
    // 報告本身完全沒有被放寬：daily/weekly 都沒有被呼叫。
    assert.equal(out.skipped, null);
    assert.equal(out.syncDue, true);
    assert.ok(calls.includes('sync'), '沒有報告要發時，同步仍然要跑');
    assert.ok(calls.includes('proactive'));
    assert.ok(!calls.includes('daily'), '報告已送出就不可以再發一次');
    assert.ok(!calls.includes('weekly'));
    assert.ok(!calls.includes('telegram.send'), '不可以送出任何報告訊息');
  });
});

// ===========================================================================
// D. /predictions 現況：永遠不輸出預測數字
// ===========================================================================

test('[char-D1] handlePredictions 樣本不足時不輸出任何預測數字', async () => {
  await withDb(async (db) => {
    const text = await handlePredictions({ db, userId: ALICE.id, rows: [] });

    assert.match(text, /INSUFFICIENT_DATA/);
    assert.match(text, /最低需求/);
    assert.ok(!/預測值/.test(text));
  });
});

test('[char-D2] handlePredictions 即使可訓練也只說「可訓練」，不給數字', async () => {
  await withDb(async (db) => {
    const text = await handlePredictions({
      db, userId: ALICE.id, rows: trainableRows(MIN_TRAIN_ROWS + 15),
    });

    assert.match(text, /可訓練/);
    // 現況：READY 也不會印出任何預測值
    assert.ok(!/預測值/.test(text));
    assert.ok(!/預計恢復/.test(text));
  });
});

// ===========================================================================
// E. capability UNKNOWN 的現況語義
// ===========================================================================

test('[char-E1] capabilityStatus=UNKNOWN 不會變成 UNAVAILABLE', () => {
  const r = assessDeviation({
    series: [], anchorDate: '2026-09-09', capabilityStatus: CAPABILITY_STATUS.UNKNOWN,
  });
  assert.equal(r.status, READINESS_STATUS.NO_DATA);
  assert.notEqual(r.status, READINESS_STATUS.UNAVAILABLE);
  assert.ok(r.missing_requirements.includes('capability_not_yet_verified'));
});

test('[char-E2] 完全沒給 capabilityStatus 也不會變成 UNAVAILABLE', () => {
  const r = assessDeviation({ series: [], anchorDate: '2026-09-09' });
  assert.equal(r.status, READINESS_STATUS.NO_DATA);
});

test('[char-E3] APP_ONLY / UNAVAILABLE / UNAUTHORIZED 才是 UNAVAILABLE', () => {
  for (const st of [
    CAPABILITY_STATUS.APP_ONLY,
    CAPABILITY_STATUS.UNAVAILABLE,
    CAPABILITY_STATUS.UNAUTHORIZED,
  ]) {
    const r = assessDeviation({ series: [], anchorDate: '2026-09-09', capabilityStatus: st });
    assert.equal(r.status, READINESS_STATUS.UNAVAILABLE, `${st} 應該是 UNAVAILABLE`);
  }
});

test('[char-E4] SUPPORTED / PARTIAL 仍然走樣本數邏輯', () => {
  for (const st of [CAPABILITY_STATUS.SUPPORTED, CAPABILITY_STATUS.PARTIAL]) {
    const r = assessDeviation({ series: [], anchorDate: '2026-09-09', capabilityStatus: st });
    assert.equal(r.status, READINESS_STATUS.NO_DATA, `${st} 不該是 UNAVAILABLE`);
  }
});

// ===========================================================================
// F. 預測的時序切分 —— 絕不可洩漏
// ===========================================================================

test('[char-F1] temporalSplit 永遠按日期切，測試集全部晚於訓練集', () => {
  const rows = Array.from({ length: 40 }, (_, i) => ({
    health_date: new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10),
    recovery: i,
  }));
  // 刻意打亂輸入順序：切分必須自己排序，不可以相信輸入順序
  const shuffled = [...rows].sort(() => 0.5 - Math.random());
  const { train, test: te, boundaryDate } = temporalSplit(shuffled);

  assert.ok(train.length > 0 && te.length > 0);
  const lastTrain = train.map((r) => r.health_date).sort().pop();
  const firstTest = te.map((r) => r.health_date).sort()[0];
  assert.ok(firstTest > lastTrain);
  assert.equal(boundaryDate, firstTest);

  const leak = assertNoLeakage(train, te);
  assert.equal(leak.ok, true);
});

test('[char-F2] assertNoLeakage 抓得到重疊', () => {
  const a = [{ health_date: '2026-01-02' }];
  const b = [{ health_date: '2026-01-01' }];
  const leak = assertNoLeakage(a, b);
  assert.equal(leak.ok, false);
  assert.equal(leak.reason, 'test_overlaps_train');
});

test('[char-F3] buildSupervised 只用 D 天特徵預測 D+1，且 null 特徵整列剔除', () => {
  const rows = [
    {
      health_date: '2026-01-01',
      recovery: 50,
      sleep_total: 1,
      previous_day_strain: 1,
      hrv: 1,
      rhr: 1,
      sleep_debt: 1,
    },
    {
      health_date: '2026-01-02',
      recovery: 60,
      sleep_total: null, // ← 這天的特徵不完整
      previous_day_strain: 1,
      hrv: 1,
      rhr: 1,
      sleep_debt: 1,
    },
    {
      health_date: '2026-01-03',
      recovery: 70,
      sleep_total: 1,
      previous_day_strain: 1,
      hrv: 1,
      rhr: 1,
      sleep_debt: 1,
    },
  ];

  const samples = buildSupervised(rows);

  // 只有 01-01 → 01-02 這組成立；01-02 的特徵有 null 所以整列剔除
  assert.equal(samples.length, 1);
  assert.equal(samples[0].feature_date, '2026-01-01');
  assert.equal(samples[0].health_date, '2026-01-02');
  assert.equal(samples[0].recovery, 60);
  // null 絕不可以被當成 0 餵進模型
  assert.notEqual(samples[0].sleep_total, 0);
  assert.equal(samples[0].sleep_total, 1);
});
