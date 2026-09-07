/**
 * PA13: Insight Memory belief revision — 一次回答絕不能直接跳到 SUPPORTED。
 *
 * 這是對 src/proactiveReanalysis.js 的白盒測試：直接呼叫
 * reanalyzeAfterAnswer()，累積多筆 journal 對照，驗證狀態機是漸進的
 * （HYPOTHESIS/STILL_UNEXPLAINED → 需要足夠對照組才 EMERGING/SUPPORTED），
 * 而不是像 PA10-11 端到端測試那樣只看第一次回答。
 *
 * 這裡順手抓到並修掉了一個真的會導致「一次回答直接 SUPPORTED」的 bug：
 * journalAssociation() 在沒有足夠對照組時（exposed/unexposed 天數 < 3）
 * 回傳的 pearson 其實是「單一天 vs 其餘全部」硬算出來的雜訊，readiness
 * 卻仍然標成 LIMITED（樣本數夠但沒有對照組）。reanalyzeAfterAnswer()
 * 之前只檢查 readiness.status，沒有另外檢查 assoc.usable，導致單一筆
 * 新答案就能讓 statusFromEvidence() 誤判成 SUPPORTED。現在兩者都要通過。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createDb } from '../src/db.js';
import { reanalyzeAfterAnswer } from '../src/proactiveReanalysis.js';
import { INSIGHT_STATUS } from '../src/healthMemory.js';
import { PROACTIVE_OUTCOME } from '../src/schema.js';
import { localDate } from '../src/time.js';
import { seedSingleUser } from './users.js';

const DAY_MS = 86_400_000;
const START_DATE = '2026-01-01';

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'insight-lifecycle-'));
  const db = createDb({ url: `file:${path.join(dir, 't.db')}` });
  return { db, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/**
 * 第 i 天實際落在哪個 health_date——一定要用跟 seedHistory 完全相同的
 * sleep.end 時間戳換算（+08:00 時區下，15:00 UTC 起床 8 小時後 = 隔天
 * 當地 07:00），絕不能用「START_DATE + i 天」這種天真的日曆算法，
 * 那會跟真正的 health_date 差一天，讓 journal 對照全部錯位。
 */
function dateAt(i, timezone = 'Asia/Taipei') {
  const day = new Date(Date.parse(`${START_DATE}T15:00:00.000Z`) + i * DAY_MS);
  const end = new Date(day.getTime() + 8 * 3600_000);
  return localDate(end, timezone);
}

/** 造 N 天的 sleep+recovery，hrv 在「昨天有喝酒」的日子刻意偏低。 */
async function seedHistory(db, user, n, exposedDayIndexes) {
  const exposed = new Set(exposedDayIndexes);
  for (let i = 0; i < n; i++) {
    const day = new Date(Date.parse(`${START_DATE}T15:00:00.000Z`) + i * DAY_MS);
    const start = day.toISOString();
    const end = new Date(day.getTime() + 8 * 3600_000).toISOString();
    await db.upsertSleeps(user.id, [{
      id: `h-sleep-${i}`, v1_id: i, user_id: 999, start, end,
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

    // 前一天有喝酒 → 今天 hrv 偏低（明確的訊號，方便測狀態機本身，
    // 不需要靠雜訊剛好對出效果量）。
    const hrv = exposed.has(i - 1) ? 25 : 50;
    await db.upsertRecoveries(user.id, [{
      sleep_id: `h-sleep-${i}`, cycle_id: `h-cycle-${i}`, user_id: 999, score_state: 'SCORED',
      score: {
        recovery_score: 60, hrv_rmssd_milli: hrv, resting_heart_rate: 55,
        spo2_percentage: null, skin_temp_celsius: null, user_calibrating: false,
      },
    }]);

    if (exposed.has(i)) {
      await db.addJournalEvent(user.id, {
        eventAt: `${dateAt(i)}T22:00:00.000Z`, healthDate: dateAt(i), category: 'alcohol',
        numericValue: 2, unit: 'drinks', source: 'proactive_agent',
      });
    }
  }
}

test('★★★ PA13: 對照組不足時（1-2 個曝露日）絕不建立 insight；累積到真正的門檻才形成，且冪等', async () => {
  const { db, cleanup } = tempDb();
  try {
    await db.migrate();
    const user = await seedSingleUser(db);

    // 一次寫好完整的 45 天歷史（固定的曝露模式），之後只靠改變
    // reanalyzeAfterAnswer 的 healthDate 錨點來模擬「隨時間累積」——
    // 這樣資料本身永遠一致，不會因為分批寫入、事後覆寫而互相干擾。
    const exposedDays = [3, 8, 13, 18, 23, 28, 33, 38, 43];
    await seedHistory(db, user, 45, exposedDays);

    // 第一階段：只看到第 9 天為止——範圍內只有「第 3 天曝露」這一個對照，
    // 對照組不足（journalAssociation 要求 exposed/unexposed 都 >= 3），
    // 不管效果量看起來多大，都必須是 STILL_UNEXPLAINED，不建立任何 insight。
    const first = await reanalyzeAfterAnswer({
      db, userId: user.id, timezone: user.timezone,
      category: 'alcohol', metric: 'hrv', healthDate: dateAt(9),
    });
    assert.equal(first.outcome, PROACTIVE_OUTCOME.STILL_UNEXPLAINED);
    assert.equal(first.insightChanged, false);
    assert.equal((await db.getActiveInsights(user.id, {})).length, 0, '對照組不足時不該建立任何 insight');

    // 第二階段：看到第 11 天為止（在第 13 天曝露之前）——現在有 2 個曝露日
    // （3/8），還是不到 3 個。這一步證明「不是單純多答一次就會通過」，
    // 而是有一個真正的門檻。
    const second = await reanalyzeAfterAnswer({
      db, userId: user.id, timezone: user.timezone,
      category: 'alcohol', metric: 'hrv', healthDate: dateAt(11),
    });
    assert.equal(second.outcome, PROACTIVE_OUTCOME.STILL_UNEXPLAINED);
    assert.equal((await db.getActiveInsights(user.id, {})).length, 0, '2 個曝露日還是不足以形成對照組');

    // 第三階段：看到第 19 天為止——現在有 3 個曝露日（3/8/13），對照組終於
    // 足夠，第一次真正形成 insight。狀態值本身（HYPOTHESIS/EMERGING/
    // SUPPORTED 三者中的哪一個）由 healthMemory.js 的 statusFromEvidence
    // 決定——那個狀態機本身已經在 test/journal-quality.test.js 測過，
    // 這裡只驗證「有沒有正確走到那一步」，不重複驗證它的內部門檻。
    const third = await reanalyzeAfterAnswer({
      db, userId: user.id, timezone: user.timezone,
      category: 'alcohol', metric: 'hrv', healthDate: dateAt(19),
    });
    assert.equal(third.outcome, PROACTIVE_OUTCOME.EXPLAINED);
    assert.equal(third.insightChanged, true);
    let insights = await db.getActiveInsights(user.id, {});
    assert.equal(insights.length, 1, '對照組剛好足夠時，應該恰好形成一筆 insight');
    assert.notEqual(insights[0].status, INSIGHT_STATUS.RETIRED);

    // 冪等：同一個錨點再分析一次，不該生出第二筆 insight（reviseInsight
    // 的 reconfirm 分支——同一個 subject 永遠只有一筆非 RETIRED 的列）。
    await reanalyzeAfterAnswer({
      db, userId: user.id, timezone: user.timezone,
      category: 'alcohol', metric: 'hrv', healthDate: dateAt(19),
    });
    insights = await db.getActiveInsights(user.id, {});
    assert.equal(insights.length, 1, '重跑同一個分析不該產生重複的 insight');
  } finally {
    db.close();
    cleanup();
  }
});
