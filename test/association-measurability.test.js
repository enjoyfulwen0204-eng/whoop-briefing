/**
 * 測不出來的關聯不可以變成解釋（M-05）。
 *
 * ## 修的是什麼
 *
 * `reanalyzeAfterAnswer()` 原本有兩道關卡，但**兩道都只看數量**：
 *
 *   1. readiness ≥ LIMITED   —— 樣本數夠不夠
 *   2. assoc.usable === true —— 有沒有對照組（曝露/未曝露都 ≥ 3 天）
 *
 * 兩者都可能在關聯**根本無法測量**時通過。最典型的情況是指標序列沒有
 * 變異（WHOOP 某個欄位一直回同一個值、感測器卡住、或值被夾在上限），
 * 此時 `pearson()` 回 null，但 n 可以是 40、曝露 13 天、未曝露 27 天。
 *
 * 舊版接下來會：
 *   - 把 `effectSize: null` 寫進 insight，狀態卻由**樣本數**決定
 *     （dataQualityOf(40) → SUPPORTED）
 *   - 方向一致性檢查因為 `assoc.pearson !== null` 為假而整段跳過，
 *     `directionConsistent` 停在預設的 true
 *   - 於是 outcome = EXPLAINED，還可能送出一則「我發現一個規律」的 follow-up
 *
 * 實測確認：n=40、usable=true、pearson=null → EXPLAINED。
 *
 * ## 現在的不變量
 *
 *   **統計上測不出來的關聯，不可以被寫成 insight，也不可以被當成解釋。**
 *   數量再多都補不上「這個關聯無法測量」。fail closed。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createDb } from '../src/db.js';
import { reanalyzeAfterAnswer } from '../src/proactiveReanalysis.js';
import { journalAssociation } from '../src/analytics/correlation.js';
import { assessJournalAssociation, READINESS_STATUS } from '../src/readiness.js';
import { PROACTIVE_OUTCOME } from '../src/schema.js';

const DAY_MS = 86_400_000;
const START_DATE = '2026-07-01';
const dateAt = (i) => new Date(Date.parse(`${START_DATE}T00:00:00.000Z`) + i * DAY_MS)
  .toISOString().slice(0, 10);

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm05-'));
  const db = createDb({ url: `file:${path.join(dir, 't.db')}` });
  return { db, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/**
 * 45 天歷史。`hrvFor(i)` 決定當天的 HRV —— 測試用它來製造
 * 「有變異」與「零變異」兩種序列。
 */
async function seedHistory(db, user, days, exposedDays, hrvFor) {
  const exposed = new Set(exposedDays);
  for (let i = 0; i < days; i += 1) {
    const day = new Date(Date.parse(`${START_DATE}T15:00:00.000Z`) + i * DAY_MS);
    await db.upsertSleeps(user.id, [{
      id: `h-sleep-${i}`, v1_id: i, user_id: 999,
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
      sleep_id: `h-sleep-${i}`, cycle_id: `h-cycle-${i}`, user_id: 999, score_state: 'SCORED',
      score: {
        recovery_score: 60, hrv_rmssd_milli: hrvFor(i, exposed),
        resting_heart_rate: 55, spo2_percentage: null,
        skin_temp_celsius: null, user_calibrating: false,
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

const EXPOSED = [3, 8, 13, 18, 23, 28, 33, 38, 43];
/** 零變異：HRV 永遠一樣 → pearson 算不出來。 */
const FLAT = () => 50;
/**
 * 有變異、而且方向正確：前一天喝酒 → 隔天 HRV 低。
 *
 * ⚠️ 索引要對齊 health_date：第 i 筆睡眠是 15:00Z 開始、隔天早上結束，
 * 所以它的 health_date 是 dateAt(i + 1)。要讓「dateAt(i) 喝酒 →
 * dateAt(i+1) HRV 低」成立，低值就要放在第 i 筆睡眠上。
 */
const REAL = (i, exposed) => (exposed.has(i) ? 25 : 50);

async function withUser(fn) {
  const { db, cleanup } = tempDb();
  try {
    await db.migrate();
    const user = await db.createUser({ displayName: 'K', timezone: 'Asia/Taipei' });
    await fn(db, user);
  } finally {
    db.close();
    cleanup();
  }
}

// ===========================================================================
// 前置：證明這組資料真的會走到「兩道舊關卡都通過、但 pearson 是 null」
// ===========================================================================

test('前置：零變異序列會讓 pearson 算不出來，但樣本數與對照組都很充足', () => {
  const metricSeries = [];
  const journalEvents = [];
  for (let i = 0; i < 40; i += 1) {
    metricSeries.push({ date: dateAt(i), value: 55 });
    if (i % 3 === 0) journalEvents.push({ category: 'alcohol', health_date: dateAt(i) });
  }
  const assoc = journalAssociation({ journalEvents, metricSeries, category: 'alcohol', lagDays: 1 });
  const readiness = assessJournalAssociation({
    journalEvents, metricSeries, category: 'alcohol', lagDays: 1,
  });

  assert.equal(assoc.pearson, null, '★ 關聯確實測不出來');
  assert.equal(assoc.usable, true, '★ 舊的「對照組」關卡會通過');
  assert.equal(readiness.status, READINESS_STATUS.READY, '★ 舊的「樣本數」關卡也會通過');
  assert.ok(assoc.n >= 30);
});

// ===========================================================================
// ★★★ 測不出來 → 絕不解釋、絕不寫 insight
// ===========================================================================

test('★★★ M-05: 關聯測不出來時 → STILL_UNEXPLAINED，不是 EXPLAINED', async () => {
  await withUser(async (db, user) => {
    await seedHistory(db, user, 45, EXPOSED, FLAT);
    const res = await reanalyzeAfterAnswer({
      db, userId: user.id, timezone: user.timezone,
      category: 'alcohol', metric: 'hrv', healthDate: dateAt(44),
      signal: { direction: 'low', metric: 'hrv' },
    });
    assert.equal(res.outcome, PROACTIVE_OUTCOME.STILL_UNEXPLAINED,
      '★ 測不出來的關聯不可以被當成這次異常的解釋');
    assert.equal(res.reason, 'association_not_measurable');
  });
});

test('★★★ M-05: 關聯測不出來時 → 絕不建立任何 insight', async () => {
  await withUser(async (db, user) => {
    await seedHistory(db, user, 45, EXPOSED, FLAT);
    await reanalyzeAfterAnswer({
      db, userId: user.id, timezone: user.timezone,
      category: 'alcohol', metric: 'hrv', healthDate: dateAt(44),
      signal: { direction: 'low', metric: 'hrv' },
    });
    const insights = await db.getActiveInsights(user.id, {});
    assert.deepEqual(insights, [],
      '★ effect_size 是 null 的 insight 絕不可以存在——它的狀態只會反映樣本數');
  });
});

test('★★★ M-05: 關聯測不出來時 → 不送 follow-up、不宣稱有變化', async () => {
  await withUser(async (db, user) => {
    await seedHistory(db, user, 45, EXPOSED, FLAT);
    const res = await reanalyzeAfterAnswer({
      db, userId: user.id, timezone: user.timezone,
      category: 'alcohol', metric: 'hrv', healthDate: dateAt(44),
      signal: { direction: 'low', metric: 'hrv' },
    });
    assert.equal(res.followUpMessage, null, '★ 不可以告訴使用者「我發現一個規律」');
    assert.equal(res.insightChanged, false);
    assert.equal(res.beliefStatus, null);
  });
});

test('★★★ M-05: 沒有訊號方向時也一樣擋（不是靠方向檢查擋下來的）', async () => {
  await withUser(async (db, user) => {
    await seedHistory(db, user, 45, EXPOSED, FLAT);
    const res = await reanalyzeAfterAnswer({
      db, userId: user.id, timezone: user.timezone,
      category: 'alcohol', metric: 'hrv', healthDate: dateAt(44),
      signal: null,
    });
    assert.equal(res.outcome, PROACTIVE_OUTCOME.STILL_UNEXPLAINED);
    assert.equal(res.reason, 'association_not_measurable');
  });
});

test('★★ M-05: 重跑一樣的結果（沒有殘留半個 insight）', async () => {
  await withUser(async (db, user) => {
    await seedHistory(db, user, 45, EXPOSED, FLAT);
    for (let i = 0; i < 3; i += 1) {
      const res = await reanalyzeAfterAnswer({
        db, userId: user.id, timezone: user.timezone,
        category: 'alcohol', metric: 'hrv', healthDate: dateAt(44),
        signal: { direction: 'low', metric: 'hrv' },
      });
      assert.equal(res.outcome, PROACTIVE_OUTCOME.STILL_UNEXPLAINED);
    }
    assert.deepEqual(await db.getActiveInsights(user.id, {}), []);
  });
});

// ===========================================================================
// ★★ 不能過度封鎖：真的測得出來的關聯必須照常運作
// ===========================================================================

test('★★ M-05 false positive: 真的有變異時，關聯照常成立並解釋這次異常', async () => {
  await withUser(async (db, user) => {
    await seedHistory(db, user, 45, EXPOSED, REAL);
    const res = await reanalyzeAfterAnswer({
      db, userId: user.id, timezone: user.timezone,
      category: 'alcohol', metric: 'hrv', healthDate: dateAt(44),
      signal: { direction: 'low', metric: 'hrv' },
    });
    assert.equal(res.outcome, PROACTIVE_OUTCOME.EXPLAINED,
      '★ 真的測得出來的關聯不可以被誤擋');
    const insights = await db.getActiveInsights(user.id, {});
    assert.equal(insights.length, 1);
    assert.ok(Number.isFinite(insights[0].effect_size),
      '★ 存下來的 insight 一定要有真實的效果量');
  });
});

test('★★ M-05: 方向不一致時仍然是 STILL_UNEXPLAINED（既有規則沒被破壞）', async () => {
  await withUser(async (db, user) => {
    await seedHistory(db, user, 45, EXPOSED, REAL);
    const res = await reanalyzeAfterAnswer({
      db, userId: user.id, timezone: user.timezone,
      category: 'alcohol', metric: 'hrv', healthDate: dateAt(44),
      // 這次異常是「偏高」，但觀察到的關聯是負向 → 方向對不上
      signal: { direction: 'high', metric: 'hrv' },
    });
    assert.equal(res.outcome, PROACTIVE_OUTCOME.STILL_UNEXPLAINED);
    assert.equal(res.directionConsistent, false);
  });
});
