/**
 * Proactive Agent 對抗性稽核（adversarial audit）。
 *
 * 這個檔案的每一個測試都對應一個**在稽核中被實際重現的缺陷**，不是把現有
 * 實作的行為抄一遍當測試。寫這些測試的順序是：先重現問題 → 再修 → 再讓
 * 測試變綠。
 *
 * 對應的稽核發現編號寫在每個測試的標題裡。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createDb } from '../src/db.js';
import { localDate } from '../src/time.js';
import { checkAndAct } from '../src/proactiveAgent.js';
import { reanalyzeAfterAnswer } from '../src/proactiveReanalysis.js';
import { guardProactiveMessage } from '../src/proactiveMessages.js';
import { createRouter } from '../src/bot/router.js';
import { decide as decideFn } from '../src/attention.js';
import { ANTI_SPAM_POLICY } from '../src/proactivePolicy.js';
import { PROACTIVE_DECISION, PROACTIVE_OUTCOME } from '../src/schema.js';
import { INSIGHT_STATUS } from '../src/healthMemory.js';
import { fakeTelegram } from './fakes.js';
import { ALICE, BOB, seedAliceAndBob, seedSingleUser } from './users.js';

const DAY_MS = 86_400_000;
const START_DATE = '2026-01-01';
const BASELINE_DAYS = 35;

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-audit-'));
  const db = createDb({ url: `file:${path.join(dir, 't.db')}` });
  return { db, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function calmValue(i, { recovery = 60, hrv = 50, rhr = 55, respiratory_rate = 15 } = {}) {
  return {
    recovery: recovery + (i % 3) - 1,
    hrv: hrv + (i % 4) - 2,
    rhr: rhr + (i % 3) - 1,
    // 真實的呼吸率本來就會小幅波動；固定成常數會讓 stddev=0、
    // 連 z-score 都算不出來（那是正確行為，但不是我們想測的情境）。
    respiratory_rate: respiratory_rate + ((i % 5) - 2) * 0.2,
  };
}

function healthDateOf(user, dateIndex) {
  const day = new Date(Date.parse(`${START_DATE}T15:00:00.000Z`) + dateIndex * DAY_MS);
  return localDate(new Date(day.getTime() + 8 * 3600_000), user.timezone);
}

/**
 * 寫入第 dateIndex 天。`recoveryOverrides` 可以模擬 WHOOP 事後改分：
 * 同一個 sleep_id 的 recovery 被重新 upsert 成不同的值。
 */
async function seedOneDay(db, user, dateIndex, values, { idPrefix = 'a', scoreState = 'SCORED' } = {}) {
  const day = new Date(Date.parse(`${START_DATE}T15:00:00.000Z`) + dateIndex * DAY_MS);
  const start = day.toISOString();
  const end = new Date(day.getTime() + 8 * 3600_000).toISOString();
  const sleepId = `${idPrefix}-sleep-${dateIndex}`;

  await db.upsertSleeps(user.id, [{
    id: sleepId, v1_id: dateIndex, user_id: 999, start, end,
    nap: false, score_state: 'SCORED', timezone_offset: '+08:00',
    score: {
      respiratory_rate: values.respiratory_rate ?? 15,
      sleep_performance_percentage: 85, sleep_consistency_percentage: 85,
      sleep_efficiency_percentage: 90,
      stage_summary: {
        total_light_sleep_time_milli: 3_000_000, total_slow_wave_sleep_time_milli: 1_000_000,
        total_rem_sleep_time_milli: 1_000_000, total_awake_time_milli: 0,
        total_no_data_time_milli: 0, total_in_bed_time_milli: 8_000_000,
        disturbance_count: 1, sleep_cycle_count: 4,
      },
      sleep_needed: {
        baseline_milli: 28_800_000, need_from_sleep_debt_milli: 0,
        need_from_recent_strain_milli: 0, need_from_recent_nap_milli: 0,
      },
    },
  }], { timezone: user.timezone });

  await db.upsertRecoveries(user.id, [{
    sleep_id: sleepId, cycle_id: `${idPrefix}-cycle-${dateIndex}`, user_id: 999,
    score_state: scoreState,
    score: {
      recovery_score: values.recovery, hrv_rmssd_milli: values.hrv,
      resting_heart_rate: values.rhr,
      spo2_percentage: null, skin_temp_celsius: null, user_calibrating: false,
    },
  }]);
}

async function seedCalmBaseline(db, user, n, opts) {
  for (let i = 0; i < n; i++) await seedOneDay(db, user, i, calmValue(i), opts);
}

// ===========================================================================
// 發現 #1（CRITICAL）：同一個 health_date 被 WHOOP 事後改分，永遠不會被重新分析
//
// 這是 WHOOP 的**正常流程**，不是邊緣案例：sleep 先同步進來，recovery 稍後
// 才被評分（PENDING_SCORE → SCORED）。第一次 cron 看到的那天 recovery 是
// null，游標卻已經前進到那一天；等 recovery 真的有值時，
// `lastCheckedHealthDate === latestHealthDate` 直接 early-return，
// 那一天的生理訊號**從頭到尾沒有被看過一眼**。
// ===========================================================================

test('★★★ 稽核 #1: WHOOP 事後改分同一個 health_date，必須重新評估（不能因為日期沒前進就跳過）', async () => {
  const { db, cleanup } = tempDb();
  try {
    await db.migrate();
    const user = await seedSingleUser(db);
    await seedCalmBaseline(db, user, BASELINE_DAYS);

    const telegram = fakeTelegram();
    const chatId = await db.getActiveChatIdForUser(user.id);

    // 第一次同步：最新一天的 recovery 還沒被評分（WHOOP 常見狀態）。
    await seedOneDay(db, user, BASELINE_DAYS, calmValue(BASELINE_DAYS), {
      scoreState: 'PENDING_SCORE',
    });
    const first = await checkAndAct({
      db, userId: user.id, timezone: user.timezone, telegram, chatId,
      now: new Date('2026-02-06T08:00:00Z'),
    });
    assert.equal(first.triggered, true);
    assert.equal(first.signals.length, 0, '未評分時本來就不該有訊號');

    // 稍後 WHOOP 完成評分，同一個 health_date、同一個 sleep_id，
    // 但 HRV 是明顯偏低的值。
    await seedOneDay(db, user, BASELINE_DAYS, { ...calmValue(BASELINE_DAYS), hrv: 15 }, {
      scoreState: 'SCORED',
    });
    const second = await checkAndAct({
      db, userId: user.id, timezone: user.timezone, telegram, chatId,
      now: new Date('2026-02-06T10:00:00Z'),
    });

    assert.notEqual(
      second.reason, 'no_new_health_date',
      '★ 生理資料真的變了，不可以只因為 health_date 沒前進就跳過分析',
    );
    assert.equal(second.triggered, true);
    assert.ok(
      second.signals?.some((s) => s.metric === 'hrv'),
      '★ 改分後的 HRV 偏離必須被偵測到',
    );
  } finally {
    db.close();
    cleanup();
  }
});

test('★★ 稽核 #1b: 完全相同的資料重跑，仍然不可以重新產生 proactive 分析', async () => {
  const { db, cleanup } = tempDb();
  try {
    await db.migrate();
    const user = await seedSingleUser(db);
    await seedCalmBaseline(db, user, BASELINE_DAYS);
    await seedOneDay(db, user, BASELINE_DAYS, { ...calmValue(BASELINE_DAYS), hrv: 15 });

    const telegram = fakeTelegram();
    const chatId = await db.getActiveChatIdForUser(user.id);
    const now = new Date('2026-02-06T08:00:00Z');

    const first = await checkAndAct({
      db, userId: user.id, timezone: user.timezone, telegram, chatId, now,
    });
    assert.equal(first.triggered, true);

    // 一模一樣的 sync（WHOOP 回傳同樣的 payload，upsert 沒有改變任何值）
    await seedOneDay(db, user, BASELINE_DAYS, { ...calmValue(BASELINE_DAYS), hrv: 15 });
    const second = await checkAndAct({
      db, userId: user.id, timezone: user.timezone, telegram, chatId,
      now: new Date('2026-02-06T08:30:00Z'),
    });

    assert.equal(second.triggered, false, '★ 語意上完全相同的資料不可以再觸發一次分析');
    const events = await db.getRecentProactiveEvents(user.id, { sinceIso: '2026-01-01T00:00:00.000Z' });
    assert.equal(events.length, 1, '★ 相同資料不可以產生第二筆 proactive event');
  } finally {
    db.close();
    cleanup();
  }
});

// ===========================================================================
// 發現 #2（HIGH）：已經很成熟的 insight 反而會讓使用者收到「資料還不足」
//
// outcome 之前是 `changed ? EXPLAINED : STILL_UNEXPLAINED`。一個已經
// SUPPORTED 的「喝酒 → 隔天 HRV 低」規律，使用者回答「有喝酒」時
// reviseInsight 走的是 reconfirm（狀態沒變 → changed=false），
// 於是 outcome = STILL_UNEXPLAINED，系統回「資料還不足以確認」。
// 歷史越完整，回答越糟糕——跟「越用越懂你」完全相反。
// ===========================================================================

test('★★★ 稽核 #2: 已經 SUPPORTED 的規律被再次佐證時，不可以回報 STILL_UNEXPLAINED', async () => {
  const { db, cleanup } = tempDb();
  try {
    await db.migrate();
    const user = await seedSingleUser(db);

    // 造一段「喝酒隔天 HRV 明顯偏低」的長歷史，讓 insight 直接成熟。
    const exposed = new Set([3, 8, 13, 18, 23, 28, 33, 38, 43]);
    for (let i = 0; i < 45; i++) {
      const hrv = exposed.has(i - 1) ? 25 : 50;
      await seedOneDay(db, user, i, { recovery: 60, hrv, rhr: 55 });
      if (exposed.has(i)) {
        await db.addJournalEvent(user.id, {
          eventAt: `${healthDateOf(user, i)}T22:00:00.000Z`,
          healthDate: healthDateOf(user, i),
          category: 'alcohol', numericValue: 2, unit: 'drinks', source: 'proactive_agent',
        });
      }
    }
    const anchor = healthDateOf(user, 44);

    // 第一次：建立 insight（此時 changed=true）
    const first = await reanalyzeAfterAnswer({
      db, userId: user.id, timezone: user.timezone,
      category: 'alcohol', metric: 'hrv', healthDate: anchor,
    });
    assert.equal(first.outcome, PROACTIVE_OUTCOME.EXPLAINED);

    const insights = await db.getActiveInsights(user.id, { subject: 'alcohol_vs_hrv' });
    assert.equal(insights[0].status, INSIGHT_STATUS.SUPPORTED, '測試前提：這段歷史應該足以形成 SUPPORTED');

    // 第二次：同樣強的證據再次佐證（狀態不變）——這才是關鍵。
    const second = await reanalyzeAfterAnswer({
      db, userId: user.id, timezone: user.timezone,
      category: 'alcohol', metric: 'hrv', healthDate: anchor,
    });
    assert.notEqual(
      second.outcome, PROACTIVE_OUTCOME.STILL_UNEXPLAINED,
      '★ 已經 SUPPORTED 的規律再次被佐證，絕不可以說「還是解釋不了」',
    );
    assert.equal(second.outcome, PROACTIVE_OUTCOME.EXPLAINED);
  } finally {
    db.close();
    cleanup();
  }
});

test('★★ 稽核 #2b: 證據不足時仍然要誠實回報 STILL_UNEXPLAINED（不可以矯枉過正）', async () => {
  const { db, cleanup } = tempDb();
  try {
    await db.migrate();
    const user = await seedSingleUser(db);
    for (let i = 0; i < 12; i++) await seedOneDay(db, user, i, calmValue(i));
    await db.addJournalEvent(user.id, {
      eventAt: `${healthDateOf(user, 3)}T22:00:00.000Z`, healthDate: healthDateOf(user, 3),
      category: 'alcohol', numericValue: 2, unit: 'drinks', source: 'proactive_agent',
    });

    const r = await reanalyzeAfterAnswer({
      db, userId: user.id, timezone: user.timezone,
      category: 'alcohol', metric: 'hrv', healthDate: healthDateOf(user, 11),
    });
    assert.equal(r.outcome, PROACTIVE_OUTCOME.STILL_UNEXPLAINED);
    assert.equal(r.insightChanged, false);
  } finally {
    db.close();
    cleanup();
  }
});

// ===========================================================================
// 發現 #3（HIGH）：主動訊息的守門完全擋不住捏造的即時生理數字
//
// guardProactiveMessage() 呼叫 validateNarrative(text, text, {checkNumbers:false})：
//   1. checkNumbers 明確關掉 → 數字守門根本沒跑
//   2. 就算打開，context 就是 text 自己 → 任何數字都「有出處」
// 而且 llmValidation.js 沒有任何「宣稱即時生理數值」的規則。
// WHOOP 官方 API 根本沒有即時心率，這種句子必須被擋下來。
// ===========================================================================

test('★★★ 稽核 #3: 捏造的「即時」生理數值必須被擋下來', async () => {
  const blocked = [
    '你的心率現在是 135 bpm，建議你先坐下來休息。',
    '你目前的即時心率偏高。',
    '你現在的 HRV 是 22 ms。',
    '偵測到你此刻的心跳異常。',
  ];
  for (const text of blocked) {
    const r = guardProactiveMessage(text, { label: 'audit' });
    assert.ok(r.problems.length > 0, `★ 這句話宣稱了不存在的即時資料，必須被擋：${text}`);
    assert.notEqual(r.text, text, '★ 沒過關的原文絕不可以被送出去');
  }
});

test('★★ 稽核 #3b: 正常的回顧性描述不可以被誤擋', () => {
  const allowed = [
    '你的HRV今天比平常偏低了一些。昨天有喝酒嗎？',
    '留意一下：你的恢復分數最近持續偏低，不是單一天的雜訊。\n\n如果你覺得不舒服，建議考慮休息、就醫或諮詢醫療專業人員——我沒有能力做任何醫療判斷。',
  ];
  for (const text of allowed) {
    const r = guardProactiveMessage(text, { label: 'audit' });
    assert.equal(r.problems.length, 0, `★ 這句話是正常的回顧性描述，不該被擋：${text}`);
  }
});

// ===========================================================================
// 發現 #4（HIGH）：沒有任何「這個使用者關閉主動訊息」的機制
// ===========================================================================

test('★★★ 稽核 #4: 使用者可以個別關閉主動訊息，且不影響另一個使用者', async () => {
  const { db, cleanup } = tempDb();
  try {
    await db.migrate();
    await seedAliceAndBob(db);

    assert.equal(typeof db.setProactiveEnabled, 'function', '★ 需要 per-user 的主動訊息開關');
    assert.equal(typeof db.isProactiveEnabled, 'function');

    // 預設開啟
    assert.equal(await db.isProactiveEnabled(ALICE.id), true);
    assert.equal(await db.isProactiveEnabled(BOB.id), true);

    // Alice 關閉，Bob 不受影響
    await db.setProactiveEnabled(ALICE.id, false);
    assert.equal(await db.isProactiveEnabled(ALICE.id), false);
    assert.equal(await db.isProactiveEnabled(BOB.id), true, '★ Alice 的設定絕不能影響 Bob');

    // 關閉之後：即使有強烈訊號也不送任何訊息
    const aliceTelegram = fakeTelegram();
    const aliceChat = await db.getActiveChatIdForUser(ALICE.id);
    await seedCalmBaseline(db, ALICE, BASELINE_DAYS, { idPrefix: 'alice' });
    await seedOneDay(db, ALICE, BASELINE_DAYS, {
      ...calmValue(BASELINE_DAYS), hrv: 15, respiratory_rate: 22,
    }, { idPrefix: 'alice' });

    const result = await checkAndAct({
      db, userId: ALICE.id, timezone: ALICE.timezone, telegram: aliceTelegram, chatId: aliceChat,
      now: new Date('2026-02-06T08:00:00Z'),
    });
    assert.equal(aliceTelegram.sent.length, 0, '★ 關閉主動訊息的使用者不可以收到任何主動訊息');
    assert.equal(result.decision, PROACTIVE_DECISION.LOG_ONLY);
    assert.equal(result.reason, 'proactive_disabled_by_user');

    // 但是 Bob 一樣的資料仍然會正常運作
    const bobTelegram = fakeTelegram();
    const bobChat = await db.getActiveChatIdForUser(BOB.id);
    await seedCalmBaseline(db, BOB, BASELINE_DAYS, { idPrefix: 'bob' });
    await seedOneDay(db, BOB, BASELINE_DAYS, {
      ...calmValue(BASELINE_DAYS), hrv: 15, respiratory_rate: 22,
    }, { idPrefix: 'bob' });
    const bobResult = await checkAndAct({
      db, userId: BOB.id, timezone: BOB.timezone, telegram: bobTelegram, chatId: bobChat,
      now: new Date('2026-02-06T08:00:00Z'),
    });
    assert.equal(bobResult.decision, PROACTIVE_DECISION.ASK_CONTEXT);
    assert.equal(bobTelegram.sent.length, 1);
  } finally {
    db.close();
    cleanup();
  }
});

// ===========================================================================
// 發現 #5（SHOULD_FIX）：recordPredictionActual 直接 ReferenceError
// ===========================================================================

test('★★ 稽核 #5: recordPredictionActual 可以正常回填實際值（原本 uid 未定義會直接爆掉）', async () => {
  const { db, cleanup } = tempDb();
  try {
    await db.migrate();
    const user = await seedSingleUser(db);
    await db.savePrediction(user.id, {
      targetDate: '2026-03-01', targetMetric: 'recovery', modelVersion: 'v-test',
      status: 'OK', features: ['hrv'], predictedValue: 50, predictedLow: 45, predictedHigh: 55, nTrain: 40,
    });

    const ok = await db.recordPredictionActual({
      userId: user.id, targetDate: '2026-03-01', targetMetric: 'recovery',
      modelVersion: 'v-test', actualValue: 48,
    });
    assert.equal(ok, true);

    const runs = await db.getPredictions(user.id, { targetMetric: 'recovery' });
    assert.equal(Number(runs[0].actual_value), 48);
    assert.equal(Number(runs[0].error), -2);
  } finally {
    db.close();
    cleanup();
  }
});

test('★★ 稽核 #5b: recordPredictionActual 不可以跨使用者回填', async () => {
  const { db, cleanup } = tempDb();
  try {
    await db.migrate();
    await seedAliceAndBob(db);
    await db.savePrediction(ALICE.id, {
      targetDate: '2026-03-01', targetMetric: 'recovery', modelVersion: 'v-test',
      status: 'OK', features: ['hrv'], predictedValue: 50, predictedLow: 45, predictedHigh: 55, nTrain: 40,
    });

    const ok = await db.recordPredictionActual({
      userId: BOB.id, targetDate: '2026-03-01', targetMetric: 'recovery',
      modelVersion: 'v-test', actualValue: 99,
    });
    assert.equal(ok, false, '★ Bob 不可以回填 Alice 的預測');

    const aliceRuns = await db.getPredictions(ALICE.id, { targetMetric: 'recovery' });
    assert.equal(aliceRuns[0].actual_value, null, '★ Alice 的資料必須完全沒被動到');
  } finally {
    db.close();
    cleanup();
  }
});

// ===========================================================================
// 發現 #6（MEDIUM）：狀態沒變時，新證據被靜默丟棄
// ===========================================================================

test('★★ 稽核 #6: insight 狀態不變時，新證據仍然要被寫進去（不可以靜默丟棄）', async () => {
  const { db, cleanup } = tempDb();
  try {
    await db.migrate();
    const user = await seedSingleUser(db);
    const { reviseInsight, recordInsight } = await import('../src/healthMemory.js');

    const created = await recordInsight(db, user.id, {
      insightType: 'journal_association', subject: 'alcohol_vs_hrv',
      statement: '初版說法', evidence: { n: 20, pearson: -0.6 },
      sampleCount: 20, effectSize: -0.6,
    });

    // 同樣的狀態（樣本更多、效果量接近）→ reconfirm 路徑
    const revised = await reviseInsight(db, user.id, created.id, {
      statement: '更新後的說法', evidence: { n: 30, pearson: -0.62 },
      sampleCount: 30, effectSize: -0.62,
    });
    assert.equal(revised.ok, true);
    assert.equal(revised.changed, false, '測試前提：這一步應該是 reconfirm，不是換版本');

    const row = await db.getInsight(user.id, created.id);
    assert.equal(Number(row.sample_count), 30, '★ 新的樣本數必須被記錄');
    const evidence = JSON.parse(row.evidence_json);
    assert.equal(evidence.n, 30, '★ 新的證據必須被寫入 evidence_json');
  } finally {
    db.close();
    cleanup();
  }
});

// ===========================================================================
// 發現 #7（MEDIUM）：版本鏈可能在併發下分叉
// ===========================================================================

test('★★ 稽核 #7: 併發的 insight 修正不可以讓版本鏈分叉出兩條 active', async () => {
  const { db, cleanup } = tempDb();
  try {
    await db.migrate();
    const user = await seedSingleUser(db);
    const { recordInsight, reviseInsight } = await import('../src/healthMemory.js');

    const created = await recordInsight(db, user.id, {
      insightType: 'journal_association', subject: 'alcohol_vs_hrv',
      statement: 'v1', evidence: { n: 12 }, sampleCount: 12, effectSize: -0.6,
    });

    // 兩個同時抵達的修正，都想把同一個 insight 推到新狀態
    const [a, b] = await Promise.all([
      reviseInsight(db, user.id, created.id, {
        statement: 'v2-a', evidence: { n: 45 }, sampleCount: 45, effectSize: -0.9,
      }),
      reviseInsight(db, user.id, created.id, {
        statement: 'v2-b', evidence: { n: 45 }, sampleCount: 45, effectSize: -0.9,
      }),
    ]);

    const active = await db.getActiveInsights(user.id, { subject: 'alcohol_vs_hrv' });
    assert.equal(active.length, 1, `★ 同一個 subject 永遠只能有一筆 active，實際有 ${active.length} 筆`);
    assert.ok(a.ok || b.ok, '至少一個修正要成功');
  } finally {
    db.close();
    cleanup();
  }
});

// ===========================================================================
// 發現 #8（MEDIUM）：主動問題開著的時候，使用者問別的問題會被當成答案吃掉
// ===========================================================================

test('★★ 稽核 #8: 主動問題開著時，使用者明顯在問問題不可以被當成答案吃掉', async () => {
  const { db, cleanup } = tempDb();
  try {
    await db.migrate();
    const user = await seedSingleUser(db);
    await seedCalmBaseline(db, user, BASELINE_DAYS);
    await seedOneDay(db, user, BASELINE_DAYS, {
      ...calmValue(BASELINE_DAYS), hrv: 15, respiratory_rate: 22,
    });

    const telegram = fakeTelegram();
    const chatId = await db.getActiveChatIdForUser(user.id);
    const asked = await checkAndAct({
      db, userId: user.id, timezone: user.timezone, telegram, chatId,
      now: new Date('2026-02-06T08:00:00Z'),
    });
    assert.equal(asked.decision, PROACTIVE_DECISION.ASK_CONTEXT, '測試前提：要先有一個開著的主動問題');

    const coachFor = () => ({ json: async () => null, ask: async () => null });
    const router = createRouter({ db, coachFor, now: () => new Date('2026-02-06T08:05:00Z') });

    const reply = await router.handle({
      text: '我今天狀態怎樣？', chatId, user: { id: user.id, timezone: user.timezone },
    });

    assert.doesNotMatch(
      reply, /沒有聽懂/,
      '★ 使用者明顯在問問題，不該被當成主動問題的（無法解析的）答案',
    );

    const stillOpen = await db.getOpenPendingQuestion(user.id, { now: new Date('2026-02-06T08:06:00Z') });
    assert.ok(stillOpen, '★ 使用者問別的問題不代表放棄回答，主動問題應該還開著');
  } finally {
    db.close();
    cleanup();
  }
});

// ===========================================================================
// 發現 #9（對抗性隔離）：Alice 與 Bob 使用完全相同的冪等鍵組成元素
// ===========================================================================

test('★★★ 稽核 #9: Alice 與 Bob 在同一天產生「字面完全相同」的 idempotency key，必須各自成立', async () => {
  const { db, cleanup } = tempDb();
  try {
    await db.migrate();
    await seedAliceAndBob(db);

    const sameKey = '2026-02-06::proactive-policy-v1';
    const a = await db.claimProactiveEvent(ALICE.id, {
      healthDate: '2026-02-06', idempotencyKey: sameKey,
      signals: [{ code: 'HRV_LOW' }], decision: PROACTIVE_DECISION.ASK_CONTEXT,
      reason: {}, policyVersion: 'proactive-policy-v1', messageText: 'alice',
    });
    const b = await db.claimProactiveEvent(BOB.id, {
      healthDate: '2026-02-06', idempotencyKey: sameKey,
      signals: [{ code: 'HRV_LOW' }], decision: PROACTIVE_DECISION.ASK_CONTEXT,
      reason: {}, policyVersion: 'proactive-policy-v1', messageText: 'bob',
    });

    assert.equal(a.claimed, true);
    assert.equal(b.claimed, true, '★ 相同的 key 字串在不同使用者底下必須都能成立');

    // 但同一個人重複用同一把 key 一定要被擋
    const again = await db.claimProactiveEvent(ALICE.id, {
      healthDate: '2026-02-06', idempotencyKey: sameKey,
      signals: [], decision: PROACTIVE_DECISION.NOTIFY,
      reason: {}, policyVersion: 'proactive-policy-v1', messageText: 'dup',
    });
    assert.equal(again.claimed, false);

    const aliceEvents = await db.getRecentProactiveEvents(ALICE.id, { sinceIso: '2026-01-01T00:00:00.000Z' });
    const bobEvents = await db.getRecentProactiveEvents(BOB.id, { sinceIso: '2026-01-01T00:00:00.000Z' });
    assert.equal(aliceEvents.length, 1);
    assert.equal(bobEvents.length, 1);
    assert.equal(aliceEvents[0].messageText, 'alice');
    assert.equal(bobEvents[0].messageText, 'bob');
  } finally {
    db.close();
    cleanup();
  }
});

// ===========================================================================
// 發現 #10（Phase U）：production 已經在 schema_version=2，新表仍然要被建出來
// ===========================================================================

test('★★★ 稽核 #10: production 等效狀態（v2、沒有 proactive 表、已有使用者資料）migrate 後兩張表都在且資料無損', async () => {
  const { db, cleanup } = tempDb();
  try {
    // 1) 先建出「production 目前的樣子」：完整 schema，然後把 proactive 兩張表
    //    拿掉、版本壓回 2——這正是正式環境現在的狀態。
    await db.migrate();
    const user = await seedSingleUser(db);
    await db.addJournalEvent(user.id, {
      eventAt: '2026-02-01T10:00:00.000Z', healthDate: '2026-02-01',
      category: 'alcohol', numericValue: 1, unit: 'drinks', source: 'manual',
    });
    await db.raw.execute('DROP TABLE proactive_events');
    await db.raw.execute('DROP TABLE proactive_agent_state');
    await db.raw.execute('DELETE FROM schema_version WHERE version > 2');
    await db.raw.execute({
      sql: 'INSERT INTO schema_version (version, applied_at, note) VALUES (2, ?, ?) ON CONFLICT(version) DO NOTHING',
      args: [new Date().toISOString(), 'simulated production'],
    });

    const before = await db.raw.execute('SELECT MAX(version) AS v FROM schema_version');
    assert.equal(Number(before.rows[0].v), 2, '測試前提：模擬成 production 的 v2');

    // 2) 跑 migration（就是 cron/bot 啟動時會做的那一件事）
    const summary = await db.migrate();
    assert.equal(summary.from, 2);
    assert.equal(summary.to, 3);
    assert.deepEqual(summary.rebuilt, [], '★ 不可以重建任何既有的表——這是零資料遺失的關鍵');

    // 3) 兩張新表確實建出來了
    const tables = await db.raw.execute(
      "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'proactive%' ORDER BY name",
    );
    assert.deepEqual(
      tables.rows.map((r) => r.name),
      ['proactive_agent_state', 'proactive_events'],
    );

    // 4) 既有身分與資料完全沒動到
    const stillThere = await db.getUser(user.id);
    assert.ok(stillThere, '★ 使用者身分必須完好');
    assert.equal(await db.countJournalEvents(user.id), 1, '★ 既有資料不可以掉');

    // 5) 冪等：再跑一次不會有任何變化
    const again = await db.migrate();
    assert.equal(again.from, 3);
    assert.deepEqual(again.rebuilt, []);
    assert.equal(await db.countJournalEvents(user.id), 1);
  } finally {
    db.close();
    cleanup();
  }
});

test('★★ 稽核 #10b: 舊形狀的 proactive_agent_state（沒有 enabled 欄位）且為空 → 安全重建', async () => {
  const { db, cleanup } = tempDb();
  try {
    await db.migrate();
    // 模擬開發機上「在稽核修正之前就建過」的舊三欄版本
    await db.raw.execute('DROP TABLE proactive_agent_state');
    await db.raw.execute(`CREATE TABLE proactive_agent_state (
      user_id TEXT PRIMARY KEY, last_checked_health_date TEXT, updated_at TEXT NOT NULL)`);
    await db.raw.execute('DELETE FROM schema_version WHERE version >= 3');

    const summary = await db.migrate();
    assert.ok(summary.rebuilt.includes('proactive_agent_state'), '空的舊形狀表應該被重建');

    const cols = await db.raw.execute('PRAGMA table_info("proactive_agent_state")');
    const names = cols.rows.map((r) => String(r.name));
    assert.ok(names.includes('enabled'), '★ 重建後必須有 enabled 欄位');
    assert.ok(names.includes('last_fingerprint'), '★ 重建後必須有 last_fingerprint 欄位');
  } finally {
    db.close();
    cleanup();
  }
});

// ===========================================================================
// 發現 #11（HIGH）：「好消息」也會被當成需要追問的訊號
//
// daily_metrics 的欄位叫 `recovery`／`previous_day_strain`，但 config.js 的
// METRIC_DIRECTION 只有 `recovery_score`／`strain` 這兩個鍵。
// anomaly.js 的 isNoteworthy() 查不到就 fallback 成 'both'（兩個方向都算
// 值得注意）——於是「恢復分數異常地好」也會產生訊號，系統可能跑去問你
// 「昨天是不是喝酒了？」。
// ===========================================================================

test('★★★ 稽核 #11: 恢復分數異常地「好」不可以產生需要追問的訊號', async () => {
  const { db, cleanup } = tempDb();
  try {
    await db.migrate();
    const user = await seedSingleUser(db);
    await seedCalmBaseline(db, user, BASELINE_DAYS);
    // 恢復分數遠高於基準 = 好消息
    await seedOneDay(db, user, BASELINE_DAYS, { ...calmValue(BASELINE_DAYS), recovery: 98 });

    const telegram = fakeTelegram();
    const chatId = await db.getActiveChatIdForUser(user.id);
    const result = await checkAndAct({
      db, userId: user.id, timezone: user.timezone, telegram, chatId,
      now: new Date('2026-02-06T08:00:00Z'),
    });

    assert.equal(
      result.signals.filter((s) => s.metric === 'recovery').length, 0,
      '★ 恢復分數往「好」的方向偏離，不該被當成需要使用者解釋的訊號',
    );
    assert.equal(telegram.sent.length, 0);
  } finally {
    db.close();
    cleanup();
  }
});

// ===========================================================================
// 發現 #12（MEDIUM）：訊號覆蓋面過窄
//
// 只監看 recovery/hrv/rhr 三個指標。呼吸率是 WHOOP 真的有提供、而且是
// 生病最早期的指標之一（daily_metrics.respiratory_rate 一直都有存），
// 卻完全不在監看範圍內。
// ===========================================================================

test('★★ 稽核 #12: 呼吸率明顯上升（常見的生病早期徵兆）必須能被偵測到', async () => {
  const { db, cleanup } = tempDb();
  try {
    await db.migrate();
    const user = await seedSingleUser(db);
    await seedCalmBaseline(db, user, BASELINE_DAYS);
    await seedOneDay(db, user, BASELINE_DAYS, {
      ...calmValue(BASELINE_DAYS), respiratory_rate: 22,
    });

    const telegram = fakeTelegram();
    const chatId = await db.getActiveChatIdForUser(user.id);
    const result = await checkAndAct({
      db, userId: user.id, timezone: user.timezone, telegram, chatId,
      now: new Date('2026-02-06T08:00:00Z'),
    });

    assert.ok(
      result.signals.some((s) => s.metric === 'respiratory_rate'),
      '★ 呼吸率是既有且可用的欄位，明顯偏離時必須產生訊號',
    );
  } finally {
    db.close();
    cleanup();
  }
});

// ===========================================================================
// #13（確認性）：多重訊號佐證確實比單一訊號更有份量
// ===========================================================================

test('#13: 多個同時發生的中度訊號 > 單一孤立的中度訊號', async () => {
  const { decide } = await import('../src/attention.js');
  const now = new Date('2026-02-08T08:00:00Z');
  const mk = (code, metric) => ({ type: 'DEVIATION', code, metric, level: 'NOTABLE', direction: 'low' });

  const isolated = decide({
    signals: [mk('HRV_LOW', 'hrv')], now, recentEvents: [],
    hasOpenQuestion: false, journalCoversHealthDate: false,
  });
  assert.equal(isolated.decision, PROACTIVE_DECISION.LOG_ONLY, '單一孤立的中度訊號不該打擾使用者');

  const corroborated = decide({
    signals: [mk('HRV_LOW', 'hrv'), mk('RHR_HIGH', 'rhr'), mk('RESPIRATORY_RATE_HIGH', 'respiratory_rate')],
    now, recentEvents: [], hasOpenQuestion: false, journalCoversHealthDate: false,
  });
  assert.equal(corroborated.decision, PROACTIVE_DECISION.ASK_CONTEXT, '三個同時發生的中度訊號構成佐證');
  assert.equal(corroborated.factors.multi_signal_confirmation, true);
});

// ===========================================================================
// 發現 #14（MEDIUM）：冷卻中的主題會順手把「別的領域」的新訊號一起悶掉
//
// 舊版一律拿當天最嚴重的那個訊號去比冷卻，只要它還在冷卻中就整個
// LOG_ONLY。於是「昨天問過 HRV」會連帶讓今天新出現的呼吸率升高
// （不同生理領域、常見的生病早期徵兆）被安靜地壓下去 24 小時。
// ===========================================================================

test('★★★ 稽核 #14: 冷卻中的主題不可以蓋掉另一個生理領域的新訊號', async () => {
  const { decide } = await import('../src/attention.js');
  const now = new Date('2026-02-08T08:00:00Z');

  const signals = [
    // 最嚴重的是 HRV，但它昨天才剛被問過（冷卻中）
    { type: 'DEVIATION', code: 'HRV_LOW', metric: 'hrv', level: 'STRONG', direction: 'low' },
    // 呼吸率是**新出現**的、不同領域的訊號
    {
      type: 'DEVIATION', code: 'RESPIRATORY_RATE_HIGH', metric: 'respiratory_rate',
      level: 'NOTABLE', direction: 'high',
    },
  ];
  const recentEvents = [{
    createdAt: new Date(now.getTime() - 6 * 3600_000).toISOString(),
    decision: PROACTIVE_DECISION.ASK_CONTEXT,
    signals: [{ code: 'HRV_LOW' }],
  }];

  const r = decide({
    signals, now, recentEvents, hasOpenQuestion: false, journalCoversHealthDate: false,
  });

  assert.notEqual(
    r.decision, PROACTIVE_DECISION.LOG_ONLY,
    '★ 呼吸率是新的、不同領域的訊號，不該因為 HRV 在冷卻中就被一起悶掉',
  );
  assert.equal(r.evaluatedSignal.metric, 'respiratory_rate', '★ 應該改用沒有在冷卻中的那個訊號來判斷');
  assert.deepEqual(r.factors.masked_by_cooldown, ['HRV_LOW'], 'factors 要誠實記錄哪些主題被冷卻擋住');
});

test('★★ 稽核 #14b: 所有主題都在冷卻中時，仍然安靜（不可以變成繞過冷卻的後門）', async () => {
  const { decide } = await import('../src/attention.js');
  const now = new Date('2026-02-08T08:00:00Z');
  const signals = [
    { type: 'DEVIATION', code: 'HRV_LOW', metric: 'hrv', level: 'STRONG', direction: 'low' },
  ];
  const recentEvents = [{
    createdAt: new Date(now.getTime() - 6 * 3600_000).toISOString(),
    decision: PROACTIVE_DECISION.ASK_CONTEXT,
    signals: [{ code: 'HRV_LOW' }],
  }];
  const r = decide({ signals, now, recentEvents, hasOpenQuestion: false, journalCoversHealthDate: false });
  assert.equal(r.decision, PROACTIVE_DECISION.LOG_ONLY);
  assert.equal(r.reason, 'topic_cooldown_active');
});

// ===========================================================================
// 發現 #15（MEDIUM）：Journal 沒有連回觸發它的 proactive event
// 需求是「哪個主動問題 → 造成哪筆 Journal → 造成哪次重新分析」可追溯。
// ===========================================================================

test('★★ 稽核 #15: 由主動問題產生的 Journal 必須可以回溯到觸發它的 proactive event', async () => {
  const { db, cleanup } = tempDb();
  try {
    await db.migrate();
    const user = await seedSingleUser(db);
    await seedCalmBaseline(db, user, BASELINE_DAYS);
    await seedOneDay(db, user, BASELINE_DAYS, {
      ...calmValue(BASELINE_DAYS), hrv: 15, respiratory_rate: 22,
    });

    const telegram = fakeTelegram();
    const chatId = await db.getActiveChatIdForUser(user.id);
    await checkAndAct({
      db, userId: user.id, timezone: user.timezone, telegram, chatId,
      now: new Date('2026-02-06T08:00:00Z'),
    });

    const coachFor = () => ({
      json: async () => ({
        category: 'alcohol', subtype: null, numeric_value: 2, unit: 'drinks',
        day_offset: -1, confidence: 0.9,
      }),
      ask: async () => null,
    });
    const router = createRouter({ db, coachFor, now: () => new Date('2026-02-06T08:05:00Z') });
    await router.handle({ text: '喝了兩杯', chatId, user: { id: user.id, timezone: user.timezone } });

    const events = await db.getRecentProactiveEvents(user.id, { sinceIso: '2026-01-01T00:00:00.000Z' });
    const event = events[0];
    assert.ok(event.journalEventId, '★ proactive event 要記下它促成了哪一筆 journal');

    const journal = await db.getJournalEvents(user.id, { from: '2026-01-01', to: '2026-12-31' });
    const linked = journal.find((j) => Number(j.id) === Number(event.journalEventId));
    assert.ok(linked, '★ 連過去的 journal id 必須真的存在');
    assert.equal(linked.source, 'proactive_agent');
    assert.equal(event.outcome !== null, true, '★ 這個事件必須已經被結案（有 outcome）');
  } finally {
    db.close();
    cleanup();
  }
});

// ===========================================================================
// Phase F：實際的送達語意（誠實地測，不是宣稱）
//
// 這幾個測試把每一個當機視窗真的跑一次，確認結論是
// AT_MOST_ONCE + best-effort dedup：**寧可漏發，不會重發**。
// ===========================================================================

async function seedReadyUserWithSignal(db, user) {
  await seedCalmBaseline(db, user, BASELINE_DAYS);
  await seedOneDay(db, user, BASELINE_DAYS, {
    ...calmValue(BASELINE_DAYS), hrv: 15, respiratory_rate: 22,
  });
}

test('★★★ Phase F: Telegram 送出後、DB 標記前當機 → 重跑絕不重發', async () => {
  const { db, cleanup } = tempDb();
  try {
    await db.migrate();
    const user = await seedSingleUser(db);
    await seedReadyUserWithSignal(db, user);
    const chatId = await db.getActiveChatIdForUser(user.id);

    // 第一輪：Telegram 成功，但緊接著整個 process 死掉
    //（用 markProactiveEventSent 拋錯來模擬「送出去了、但狀態沒寫完」）。
    const sent = [];
    const flakyDb = {
      ...db,
      markProactiveEventSent: async () => { throw new Error('crash after send'); },
    };
    const telegram = { send: async (t) => { sent.push(t); return { messageId: 1 }; } };

    await assert.rejects(() => checkAndAct({
      db: flakyDb, userId: user.id, timezone: user.timezone, telegram, chatId,
      now: new Date('2026-02-06T08:00:00Z'),
    }));
    assert.equal(sent.length, 1, '測試前提：第一輪確實送出去了');

    // 第二輪：正常重跑（游標當時沒能前進）
    const second = await checkAndAct({
      db, userId: user.id, timezone: user.timezone, telegram, chatId,
      now: new Date('2026-02-06T08:30:00Z'),
    });
    assert.equal(second.duplicate, true, '★ 同一把 idempotency key 必須被辨識為重複');
    assert.equal(sent.length, 1, '★★ 絕不可以重發：使用者只能收到一次');
  } finally {
    db.close();
    cleanup();
  }
});

test('★★★ Phase F: Telegram 逾時（送達結果未知）→ 不重試，誠實地是 at-most-once', async () => {
  const { db, cleanup } = tempDb();
  try {
    await db.migrate();
    const user = await seedSingleUser(db);
    await seedReadyUserWithSignal(db, user);
    const chatId = await db.getActiveChatIdForUser(user.id);

    let attempts = 0;
    const flakyTelegram = {
      send: async () => { attempts += 1; throw new Error('ETIMEDOUT: delivery unknown'); },
    };
    await assert.rejects(() => checkAndAct({
      db, userId: user.id, timezone: user.timezone, telegram: flakyTelegram, chatId,
      now: new Date('2026-02-06T08:00:00Z'),
    }));
    assert.equal(attempts, 1);

    // 事件已經被 claim 起來了 → 下一輪不會再送一次。
    // 這是刻意的取捨：訊息可能遺失，但絕不會重複打擾使用者。
    const retry = await checkAndAct({
      db, userId: user.id, timezone: user.timezone, telegram: flakyTelegram, chatId,
      now: new Date('2026-02-06T08:30:00Z'),
    });
    assert.equal(retry.duplicate, true);
    assert.equal(attempts, 1, '★ 逾時之後不重試——AT_MOST_ONCE，不是 at-least-once');

    const events = await db.getRecentProactiveEvents(user.id, { sinceIso: '2026-01-01T00:00:00.000Z' });
    assert.equal(events.length, 1);
    assert.equal(events[0].sentAt, null, '★ 沒有成功標記送出 → sent_at 應該還是空的（稽核軌跡誠實）');
  } finally {
    db.close();
    cleanup();
  }
});

// ===========================================================================
// Phase T：對抗性 multi-user 隔離——冷卻與每日上限
// ===========================================================================

test('★★★ Phase T: Alice 的冷卻與每日上限完全不影響 Bob（同日期、同訊號代碼、同時間）', async () => {
  const { db, cleanup } = tempDb();
  try {
    await db.migrate();
    await seedAliceAndBob(db);
    const now = new Date('2026-02-06T08:00:00Z');

    // Alice 已經用滿今天的額度，而且 HRV_LOW 正在冷卻中
    for (let i = 0; i < ANTI_SPAM_POLICY.DAILY_PROACTIVE_CAP; i++) {
      await db.claimProactiveEvent(ALICE.id, {
        healthDate: '2026-02-05', idempotencyKey: `alice-cap-${i}`,
        signals: [{ code: 'HRV_LOW' }], decision: PROACTIVE_DECISION.ASK_CONTEXT,
        reason: {}, policyVersion: 'v', messageText: 'x',
      }, { now: new Date(now.getTime() - (i + 1) * 3600_000) });
    }

    const aliceEvents = await db.getRecentProactiveEvents(ALICE.id, { sinceIso: '2026-01-01T00:00:00.000Z' });
    const bobEvents = await db.getRecentProactiveEvents(BOB.id, { sinceIso: '2026-01-01T00:00:00.000Z' });
    assert.equal(aliceEvents.length, ANTI_SPAM_POLICY.DAILY_PROACTIVE_CAP);
    assert.equal(bobEvents.length, 0, '★ Alice 的事件絕不能出現在 Bob 的歷史裡');

    const signals = [{
      type: 'DEVIATION', code: 'HRV_LOW', metric: 'hrv', level: 'STRONG', direction: 'low',
    }];

    // 用各自真實的歷史去決策
    const aliceDecision = decideWith(signals, now, aliceEvents);
    const bobDecision = decideWith(signals, now, bobEvents);

    assert.equal(aliceDecision.decision, PROACTIVE_DECISION.LOG_ONLY);
    assert.equal(aliceDecision.reason, 'daily_cap_reached');
    assert.equal(bobDecision.factors.daily_cap_reached, false, '★ Bob 的每日上限不可以被 Alice 用掉');
    assert.equal(bobDecision.factors.topic_cooldown_active, false, '★ Bob 的主題冷卻不可以被 Alice 觸發');

    // Bob 的開關也必須獨立
    await db.setProactiveEnabled(ALICE.id, false);
    assert.equal(await db.isProactiveEnabled(ALICE.id), false);
    assert.equal(await db.isProactiveEnabled(BOB.id), true);
  } finally {
    db.close();
    cleanup();
  }
});

function decideWith(signals, now, recentEvents) {
  // eslint-disable-next-line global-require
  return decideFn({ signals, now, recentEvents, hasOpenQuestion: false, journalCoversHealthDate: false });
}
