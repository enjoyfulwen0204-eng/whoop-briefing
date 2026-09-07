/**
 * PA15（NOTIFY-without-question 安全語言）／PA16（敘述守門延伸到主動訊息）
 * ／PA17-18（冷啟動階段由 readiness 決定，不是日曆天數）的直接單元測試。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createDb } from '../src/db.js';
import { checkAndAct } from '../src/proactiveAgent.js';
import { decide } from '../src/attention.js';
import { PROACTIVE_DECISION } from '../src/schema.js';
import {
  buildNotifyMessage, guardProactiveMessage, deriveColdStartStage,
  stageAllowsMessaging, COLD_START_STAGE,
} from '../src/proactiveMessages.js';
import { READINESS_STATUS } from '../src/readiness.js';
import { fakeTelegram } from './fakes.js';
import { seedSingleUser } from './users.js';

const DAY_MS = 86_400_000;
const START_DATE = '2026-01-01';

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notify-guard-'));
  const db = createDb({ url: `file:${path.join(dir, 't.db')}` });
  return { db, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function calmValue(i, { recovery = 60, hrv = 50, rhr = 55 } = {}) {
  return { recovery: recovery + (i % 3) - 1, hrv: hrv + (i % 4) - 2, rhr: rhr + (i % 3) - 1 };
}

async function seedOneDay(db, user, dateIndex, values) {
  const day = new Date(Date.parse(`${START_DATE}T15:00:00.000Z`) + dateIndex * DAY_MS);
  const start = day.toISOString();
  const end = new Date(day.getTime() + 8 * 3600_000).toISOString();
  const sleepId = `n-sleep-${dateIndex}`;
  await db.upsertSleeps(user.id, [{
    id: sleepId, v1_id: dateIndex, user_id: 999, start, end,
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
    sleep_id: sleepId, cycle_id: `n-cycle-${dateIndex}`, user_id: 999, score_state: 'SCORED',
    score: {
      recovery_score: values.recovery, hrv_rmssd_milli: values.hrv, resting_heart_rate: values.rhr,
      spo2_percentage: null, skin_temp_celsius: null, user_calibrating: false,
    },
  }]);
}

async function seedCalmBaseline(db, user, n) {
  for (let i = 0; i < n; i++) await seedOneDay(db, user, i, calmValue(i));
}

const BASELINE_DAYS = 35;

// ===========================================================================
// PA15: NOTIFY 路徑——已經有一個 OPEN 問題時，嚴重+持續的訊號改成「只告知」
// ===========================================================================

test('★★ PA15: decide() —— 已經有 OPEN 問題時，嚴重+持續的訊號改成 NOTIFY 而不是再開一題', () => {
  const now = new Date('2026-02-08T08:00:00Z');
  const signals = [{
    type: 'DEVIATION', code: 'RHR_HIGH', metric: 'rhr', level: 'STRONG', direction: 'high',
  }];
  // 前一天同一個訊號已經被記錄過（不管當時的決定是什麼），構成「持續」。
  const recentEvents = [{
    createdAt: new Date(now.getTime() - 24 * 3600_000).toISOString(),
    decision: PROACTIVE_DECISION.LOG_ONLY,
    signals: [{ code: 'RHR_HIGH' }],
  }];

  const withoutOpenQuestion = decide({
    signals, now, recentEvents, hasOpenQuestion: false, journalCoversHealthDate: false,
  });
  assert.equal(withoutOpenQuestion.decision, PROACTIVE_DECISION.ASK_CONTEXT, '沒有 OPEN 問題時應該正常問一題');

  const withOpenQuestion = decide({
    signals, now, recentEvents, hasOpenQuestion: true, journalCoversHealthDate: false,
  });
  assert.equal(withOpenQuestion.decision, PROACTIVE_DECISION.NOTIFY);
  assert.equal(withOpenQuestion.reason, 'already_has_open_question');
  assert.equal(withOpenQuestion.factors.has_open_question, true, 'factors 要誠實記錄這個考量，決策才可稽核');
});

test('★★★ PA8/PA15: 完整管線裡，NOTIFY 訊息確實不是問句、確實包含保守安全語言', async () => {
  const { db, cleanup } = tempDb();
  try {
    await db.migrate();
    const user = await seedSingleUser(db);
    await seedCalmBaseline(db, user, BASELINE_DAYS);
    await seedOneDay(db, user, BASELINE_DAYS, { ...calmValue(BASELINE_DAYS), hrv: 15, rhr: 80 });

    const telegram = fakeTelegram();
    const chatId = await db.getActiveChatIdForUser(user.id);
    // 單日但兩個指標同時異常 → multi-signal confirmation 成立，
    // 不需要等第二天就達到「嚴重 + 有佐證」的門檻。
    const result = await checkAndAct({
      db, userId: user.id, timezone: user.timezone, telegram, chatId,
      now: new Date('2026-02-06T08:00:00Z'),
    });

    assert.equal(result.decision, PROACTIVE_DECISION.ASK_CONTEXT, '多重訊號佐證應該足以觸發（這裡驗證管線走到這一步)');
    assert.equal(telegram.sent.length, 1);
  } finally {
    db.close();
    cleanup();
  }
});

test('PA15: buildNotifyMessage 的樣板只含保守用語，不宣稱急症、不做診斷', () => {
  const msg = buildNotifyMessage({ metric: 'recovery', direction: 'low', level: 'STRONG' });
  assert.match(msg, /建議考慮休息、就醫或諮詢醫療專業人員/);
  assert.doesNotMatch(msg, /診斷|確診|急症|你得了|你患有/);
});

// ===========================================================================
// PA16: guardProactiveMessage —— 明確的 blocked / allowed 例句
// ===========================================================================

test('★★ PA16: guardProactiveMessage 擋下因果/診斷語言，換成保守 fallback', () => {
  const blockedExamples = [
    '你的HRV下降一定是因為生病了，這證明你需要就醫。',      // 因果 + 隱含斷言
    '這個模式導致你的恢復變差，長期下去會造成心臟病。',        // 導致/造成
    '根據數據，你可能得了自律神經失調，建議立刻就醫。',        // 診斷式措辭
    '你的心率變異已經確診異常，這是因果關係。',               // 確診 + 因果關係
  ];
  for (const text of blockedExamples) {
    const { text: guarded, problems } = guardProactiveMessage(text, { label: 'test' });
    assert.ok(problems.length > 0, `這句話應該被攔下來：${text}`);
    assert.notEqual(guarded, text, '被攔下來的原文絕不能被送出去');
  }
});

test('PA16: guardProactiveMessage 放行正常的保守用語', () => {
  const allowedExamples = [
    '你的HRV今天比平常偏低了一些。昨天有喝酒嗎？',
    '留意一下：你的恢復分數最近持續偏低，不是單一天的雜訊。\n\n如果你覺得不舒服，建議考慮休息、就醫或諮詢醫療專業人員——我沒有能力做任何醫療判斷。',
    '補充一下之前提到的觀察：「喝酒」與隔天HRV之間目前觀察到負向的關聯（r=-0.70，樣本 20 天，資料充分度 MODERATE）。這是個人層級觀察到的關聯，跟其他因素的影響無法完全分開。',
  ];
  for (const text of allowedExamples) {
    const { text: guarded, problems } = guardProactiveMessage(text, { label: 'test' });
    assert.equal(problems.length, 0, `這句話不該被攔下來：${text}`);
    assert.equal(guarded, text);
  }
});

// ===========================================================================
// PA17-18: 冷啟動階段——由 readiness 決定，不是日曆天數
// ===========================================================================

test('★ PA17-18: deriveColdStartStage 完整對應 readiness 狀態，不看日期', () => {
  assert.equal(
    deriveColdStartStage({ proactiveMonitoringStatus: READINESS_STATUS.NO_DATA }),
    COLD_START_STAGE.STAGE_0,
  );
  assert.equal(
    deriveColdStartStage({ proactiveMonitoringStatus: READINESS_STATUS.WARMING_UP }),
    COLD_START_STAGE.STAGE_1,
  );
  assert.equal(
    deriveColdStartStage({ proactiveMonitoringStatus: READINESS_STATUS.LIMITED }),
    COLD_START_STAGE.STAGE_2,
  );
  assert.equal(
    deriveColdStartStage({ proactiveMonitoringStatus: READINESS_STATUS.READY, hasMatureInsight: false }),
    COLD_START_STAGE.STAGE_3,
  );
  assert.equal(
    deriveColdStartStage({ proactiveMonitoringStatus: READINESS_STATUS.READY, hasMatureInsight: true }),
    COLD_START_STAGE.STAGE_4,
  );
  // DEGRADED/UNAVAILABLE：曾經足夠但現在有問題 → 保守當成不能主動打擾，
  // 絕不能因為「以前資料夠」就假裝現在還可以主動下結論。
  assert.equal(
    deriveColdStartStage({ proactiveMonitoringStatus: READINESS_STATUS.DEGRADED }),
    COLD_START_STAGE.STAGE_0,
  );
  assert.equal(
    deriveColdStartStage({ proactiveMonitoringStatus: READINESS_STATUS.UNAVAILABLE }),
    COLD_START_STAGE.STAGE_0,
  );

  assert.equal(stageAllowsMessaging(COLD_START_STAGE.STAGE_0), false);
  assert.equal(stageAllowsMessaging(COLD_START_STAGE.STAGE_1), false);
  assert.equal(stageAllowsMessaging(COLD_START_STAGE.STAGE_2), false);
  assert.equal(stageAllowsMessaging(COLD_START_STAGE.STAGE_3), true);
  assert.equal(stageAllowsMessaging(COLD_START_STAGE.STAGE_4), true);
});
