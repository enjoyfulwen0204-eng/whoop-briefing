/**
 * 權限與抑制狀態讀不到時，絕不打擾使用者（M-11）。
 *
 * ## 修的是什麼
 *
 * `checkAndAct()` 有五個讀取決定「可不可以打擾使用者」：
 *
 *   isProactiveEnabled       使用者有沒有把主動訊息關掉（**權限**）
 *   getOpenPendingQuestion   已經有一題還沒回答了（抑制）
 *   getJournalEvents（當天） 使用者今天已經自己記過了（抑制）
 *   getRecentProactiveEvents 冷卻窗、每日上限、持續性（抑制）
 *   getJournalEvents（歷史） 挑題時避開已經問過的類別（抑制）
 *
 * 舊版每一個都是 `.catch(() => <寬鬆值>)` —— 讀不到就當成「沒關」
 * 「沒有未回答的問題」「今天沒記過」。實測確認：把前三個中的**任何一個**
 * 弄壞，系統照樣送出主動訊息。
 *
 *   isProactiveEnabled 讀取失敗   → ASK_CONTEXT，sent=1
 *   getOpenPendingQuestion 失敗   → ASK_CONTEXT，sent=1
 *   getJournalEvents 失敗         → ASK_CONTEXT，sent=1
 *
 * 最嚴重的是第一個：一個**明確把主動訊息關掉**的使用者，只要那次讀取
 * 失敗就會被打擾。那是直接違反使用者表達過的意願。
 *
 * ## 現在的不變量
 *
 *   一個會不請自來發訊息的系統，「不確定可不可以發」的答案永遠是**不發**。
 *
 * 降級的只有「主動打擾」這一件事：分析照跑、事件照記（稽核軌跡與長期
 * 規律完全不受影響），手動問答也完全不受影響。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createDb } from '../src/db.js';
import { checkAndAct } from '../src/proactiveAgent.js';
import { PROACTIVE_DECISION } from '../src/schema.js';
import { fakeTelegram } from './fakes.js';
import { seedSingleUser } from './users.js';

const DAY_MS = 86_400_000;
const START_DATE = '2026-01-01';
const BASELINE_DAYS = 35;
const DAY1 = new Date('2026-02-06T08:00:00Z');
const DAY2 = new Date('2026-02-07T08:00:00Z');

const calm = (i) => ({ recovery: 60 + (i % 3) - 1, hrv: 50 + (i % 4) - 2, rhr: 55 + (i % 3) - 1 });

async function seedOneDay(db, user, i, v) {
  const day = new Date(Date.parse(`${START_DATE}T15:00:00.000Z`) + i * DAY_MS);
  const sleepId = `d-sleep-${i}`;
  await db.upsertSleeps(user.id, [{
    id: sleepId, v1_id: i, user_id: 999,
    start: day.toISOString(), end: new Date(day.getTime() + 8 * 3600_000).toISOString(),
    nap: false, score_state: 'SCORED', timezone_offset: '+08:00',
    score: {
      respiratory_rate: 15, sleep_performance_percentage: 85,
      sleep_consistency_percentage: 85, sleep_efficiency_percentage: 90,
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
    sleep_id: sleepId, cycle_id: `d-cycle-${i}`, user_id: 999, score_state: 'SCORED',
    score: {
      recovery_score: v.recovery, hrv_rmssd_milli: v.hrv, resting_heart_rate: v.rhr,
      spo2_percentage: null, skin_temp_celsius: null, user_calibrating: false,
    },
  }]);
}

/**
 * 跑到「第二天、持續性訊號、應該 ASK_CONTEXT」那個狀態，
 * 第二次呼叫時套用 `patch`（用來弄壞某一個讀取）。
 */
async function runToDay2(patch = null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm11-'));
  const db = createDb({ url: `file:${path.join(dir, 't.db')}` });
  try {
    await db.migrate();
    const user = await seedSingleUser(db);
    for (let i = 0; i < BASELINE_DAYS; i += 1) await seedOneDay(db, user, i, calm(i));
    await seedOneDay(db, user, BASELINE_DAYS, { ...calm(BASELINE_DAYS), hrv: 15 });

    const telegram = fakeTelegram();
    const chatId = await db.getActiveChatIdForUser(user.id);
    const common = { userId: user.id, timezone: user.timezone, telegram, chatId };

    const day1 = await checkAndAct({ db, ...common, now: DAY1 });
    await seedOneDay(db, user, BASELINE_DAYS + 1, { ...calm(BASELINE_DAYS + 1), hrv: 14 });

    const sentBefore = telegram.sent.length;
    const result = await checkAndAct({
      db: patch ? patch(db) : db, ...common, now: DAY2,
    });
    return {
      db, user, telegram, day1, result,
      sentOnDay2: telegram.sent.length - sentBefore,
      async events() {
        const rs = await db.raw.execute({
          sql: 'SELECT decision, reason_json FROM proactive_events WHERE user_id = ? ORDER BY id',
          args: [user.id],
        });
        return rs.rows;
      },
      cleanup: () => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); },
    };
  } catch (err) {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
    throw err;
  }
}

const boom = () => { throw new Error('db down'); };

// ===========================================================================
// 前置：沒有故障時確實會送
// ===========================================================================

test('前置：一切正常時第二天確實會 ASK_CONTEXT 並送出訊息', async () => {
  const r = await runToDay2(null);
  try {
    assert.equal(r.result.decision, PROACTIVE_DECISION.ASK_CONTEXT);
    assert.equal(r.sentOnDay2, 1, '★ 前置必須真的會送，否則下面全是假通過');
  } finally { r.cleanup(); }
});

// ===========================================================================
// ★★★ 每一個閘門讀不到 → 一律不送
// ===========================================================================

const GATES = [
  ['isProactiveEnabled（權限）', (db) => ({ ...db, isProactiveEnabled: boom })],
  ['getOpenPendingQuestion（抑制）', (db) => ({ ...db, getOpenPendingQuestion: boom })],
  ['getJournalEvents（抑制）', (db) => ({ ...db, getJournalEvents: boom })],
  ['getRecentProactiveEvents（抑制）', (db) => ({ ...db, getRecentProactiveEvents: boom })],
];

for (const [name, patch] of GATES) {
  test(`★★★ M-11: ${name} 讀不到 → 絕不送出主動訊息`, async () => {
    const r = await runToDay2(patch);
    try {
      assert.equal(r.sentOnDay2, 0, `★ ${name} 讀不到就不可以打擾使用者`);
      assert.notEqual(r.result.decision, PROACTIVE_DECISION.ASK_CONTEXT);
      assert.notEqual(r.result.decision, PROACTIVE_DECISION.NOTIFY);
    } finally { r.cleanup(); }
  });
}

test('★★★ M-11: 全部閘門同時讀不到 → 一樣不送', async () => {
  const r = await runToDay2((db) => ({
    ...db,
    isProactiveEnabled: boom,
    getOpenPendingQuestion: boom,
    getJournalEvents: boom,
    getRecentProactiveEvents: boom,
  }));
  try {
    assert.equal(r.sentOnDay2, 0);
  } finally { r.cleanup(); }
});

// ===========================================================================
// ★★★ 降級的只有「打擾」，稽核軌跡與分析完全不受影響
// ===========================================================================

test('★★★ M-11: 閘門讀不到時，事件仍然被記錄下來（稽核軌跡不中斷）', async () => {
  const r = await runToDay2((db) => ({ ...db, isProactiveEnabled: boom }));
  try {
    const events = await r.events();
    assert.equal(events.length, 2, '★ 兩天都要有事件紀錄');
    assert.equal(events[1].decision, PROACTIVE_DECISION.LOG_ONLY);
  } finally { r.cleanup(); }
});

test('★★★ M-11: 降級的理由被明確記下來（事後查得出為什麼沒送）', async () => {
  const r = await runToDay2((db) => ({ ...db, isProactiveEnabled: boom }));
  try {
    const events = await r.events();
    const reason = JSON.parse(events[1].reason_json);
    assert.equal(reason.reason, 'permission_state_unreadable');
    assert.deepEqual(reason.factors.unreadable_gates, ['proactive_enabled']);
  } finally { r.cleanup(); }
});

test('★★ M-11: 訊號分析本身完全不受影響', async () => {
  const r = await runToDay2((db) => ({ ...db, isProactiveEnabled: boom }));
  try {
    assert.ok(r.result.signals.length >= 1, '★ 分析照跑');
    assert.equal(r.result.signals[0].metric, 'hrv');
  } finally { r.cleanup(); }
});

// ===========================================================================
// ★★ 明確關閉 vs 讀不到，是兩件不同的事，但結果一樣（都不送）
// ===========================================================================

test('★★ M-11: 使用者明確關閉 → LOG_ONLY，理由是 proactive_disabled_by_user', async () => {
  const r = await runToDay2((db) => ({ ...db, isProactiveEnabled: async () => false }));
  try {
    assert.equal(r.sentOnDay2, 0);
    const events = await r.events();
    assert.equal(JSON.parse(events[1].reason_json).reason, 'proactive_disabled_by_user');
  } finally { r.cleanup(); }
});

test('★★ M-11: isProactiveEnabled 回 true 時照常送（沒有把功能鎖死）', async () => {
  const r = await runToDay2((db) => ({ ...db, isProactiveEnabled: async () => true }));
  try {
    assert.equal(r.sentOnDay2, 1);
    assert.equal(r.result.decision, PROACTIVE_DECISION.ASK_CONTEXT);
  } finally { r.cleanup(); }
});
