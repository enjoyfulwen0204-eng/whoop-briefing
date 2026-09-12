/**
 * 缺值絕不可以變成 0（V1.1 固定不變量）。
 *
 * ## 為什麼這件事比看起來嚴重
 *
 * `acc + (num(x) ?? 0)` 這個寫法不會少一筆資料 —— 它會產生一個**看起來完整**
 * 的數字。使用者沒有任何線索知道那個總和少算了一段，於是它比「無資料」更糟：
 * 無資料至少是誠實的。
 *
 * 舊程式有三個地方這樣寫，而且是同一個睡眠總時長被算了三次：
 *   store.js       寫進資料庫（於是錯的值被持久化）
 *   config.js      METRICS.sleep_total（於是錯的值被印給使用者）
 *   dailyMetrics.js 彙總（於是錯的值進了統計與預測）
 *
 * ## 規則
 *
 *   · 計數（幾筆紀錄）可以是 0 —— 那是事實。
 *   · 窗內沒有符合的事件，總時長可以是 0 —— 那也是事實。
 *   · **有紀錄但缺必要的量測** → null／不可用，絕不用 0 頂替。
 *   · 部分總和不可以被當成完整總和發布。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { computeDailyMetrics } from '../src/dailyMetrics.js';
import { sleepTotalMilli, METRICS } from '../src/config.js';
import { renderDaily } from '../src/format.js';

const TZ = 'Asia/Taipei';
const HD = '2026-09-12';
const SLEEP_START = '2026-09-11T17:48:00.000Z';
const SLEEP_END = '2026-09-12T01:43:00.000Z';
/** 「昨天」的 cycle 窗 —— 運動與小睡都要落在裡面才會被計入。 */
const CYCLE_START = '2026-09-10T17:48:00.000Z';
const CYCLE_END = SLEEP_START;

const stage = (over = {}) => ({
  total_light_sleep_time_milli: 13_000_000,
  total_slow_wave_sleep_time_milli: 7_000_000,
  total_rem_sleep_time_milli: 6_000_000,
  total_awake_time_milli: 900_000,
  total_in_bed_time_milli: 27_000_000,
  disturbance_count: 9,
  sleep_cycle_count: 5,
  ...over,
});

function sleepRow(stageOver = {}) {
  const s = stage(stageOver);
  return {
    id: 's0', health_date: HD, start_at: SLEEP_START, end_at: SLEEP_END, nap: 0,
    score_state: 'SCORED',
    raw_json: JSON.stringify({
      id: 's0', score_state: 'SCORED', start: SLEEP_START, end: SLEEP_END, nap: false,
      score: { sleep_performance_percentage: 87, stage_summary: s },
    }),
  };
}
const cycleRow = () => ({
  id: 'c0', start_at: CYCLE_START, end_at: CYCLE_END, score_state: 'SCORED', strain: 8.2,
  raw_json: JSON.stringify({
    id: 'c0', start: CYCLE_START, end: CYCLE_END, score_state: 'SCORED', score: { strain: 8.2 },
  }),
});
const workout = (over = {}) => ({
  id: `w${Math.random()}`, start_at: '2026-09-11T02:00:00.000Z', end_at: '2026-09-11T03:00:00.000Z',
  score_state: 'SCORED', sport_name: 'running',
  strain: 8.5, kilojoule: 1500,
  zone_one_milli: 300_000, zone_two_milli: 600_000, zone_three_milli: 600_000,
  zone_four_milli: 300_000, zone_five_milli: 120_000,
  ...over,
});
const nap = (over = {}) => ({
  id: `n${Math.random()}`, health_date: HD, nap: 1, score_state: 'SCORED',
  start_at: '2026-09-11T05:00:00.000Z', end_at: '2026-09-11T06:00:00.000Z',
  total_sleep_milli: 2_400_000, ...over,
});

const compute = ({ sleepStage = {}, workouts = [], naps = [] } = {}) => computeDailyMetrics({
  sleepRows: [sleepRow(sleepStage), ...naps],
  recoveryRows: [], cycleRows: [cycleRow()], workoutRows: workouts,
  bodyMeasurement: null, timezone: TZ,
})[0];

// ===========================================================================
// 睡眠分期總和
// ===========================================================================

test('★★★ 睡眠總時長：三段齊全才給總和', () => {
  assert.equal(sleepTotalMilli(stage()), 26_000_000);
  const m = METRICS.find((x) => x.key === 'sleep_total');
  assert.equal(m.get({ score: { stage_summary: stage() } }), 26_000_000);
});

test('★★★ 睡眠總時長：缺任何一段就不可用（不是部分和）', () => {
  for (const missing of [
    'total_light_sleep_time_milli',
    'total_slow_wave_sleep_time_milli',
    'total_rem_sleep_time_milli',
  ]) {
    const s = stage({ [missing]: null });
    assert.equal(sleepTotalMilli(s), null, `★ 缺 ${missing} 就不可以給總和`);
    // 舊行為會回 20_000_000（少算一段）而且看起來完整
    assert.notEqual(sleepTotalMilli(s), 20_000_000);
    const m = METRICS.find((x) => x.key === 'sleep_total');
    assert.equal(m.get({ score: { stage_summary: s } }), null, `★ 顯示層也一樣`);
  }
});

test('★★★ 睡眠總時長：真零仍然是 0', () => {
  assert.equal(sleepTotalMilli(stage({
    total_light_sleep_time_milli: 0,
    total_slow_wave_sleep_time_milli: 0,
    total_rem_sleep_time_milli: 0,
  })), 0);
});

test('★★★ 彙總層：缺一段 → sleep_total 不可用，但各分期各自保留', () => {
  const row = compute({ sleepStage: { total_rem_sleep_time_milli: null } });
  assert.equal(row.sleep_total, null, '★ 總和不可用');
  assert.equal(row.light_sleep, 13_000_000, '★ 拿得到的那一段照常保留');
  assert.equal(row.deep_sleep, 7_000_000);
  assert.equal(row.rem_sleep, null, '★ 拿不到的那一段誠實回 null');
});

// ===========================================================================
// 運動
// ===========================================================================

test('★★★ 完全沒有運動紀錄：計數 0，總和不可用（兩者可分辨）', () => {
  const row = compute({ workouts: [] });
  assert.equal(row.workout_count, 0, '★ 計數是事實');
  assert.equal(row.workout_scored_count, 0);
  assert.equal(row.workout_strain_total, null, '★ 沒有已評分紀錄就沒有總和');
  assert.equal(row.zone1_3_minutes, null);
  assert.equal(row.workout_duration_minutes, null);
});

test('★★★ 完整的運動紀錄：總和正確', () => {
  const row = compute({ workouts: [workout()] });
  assert.equal(row.workout_count, 1);
  assert.equal(row.workout_strain_total, 8.5);
  assert.equal(row.workout_kilojoule, 1500);
  assert.equal(row.zone1_3_minutes, 25, '(300+600+600)k ms = 25 分');
  assert.equal(row.zone4_5_minutes, 7, '(300+120)k ms ≈ 7 分');
  assert.equal(row.workout_duration_minutes, 60);
});

test('★★★ 已評分但缺 strain → 總和不可用（不可以靜靜壓低）', () => {
  const row = compute({ workouts: [workout({ strain: null })] });
  assert.equal(row.workout_count, 1, '★ 紀錄確實存在');
  assert.equal(row.workout_scored_count, 1);
  assert.equal(row.workout_strain_total, null, '★ 缺值不可以當 0');
  assert.notEqual(row.workout_strain_total, 0);
  // 其他有齊的欄位不受影響
  assert.equal(row.workout_kilojoule, 1500);
});

test('★★★ 多筆運動、其中一筆缺必要值 → 該項總和不可用', () => {
  const row = compute({ workouts: [workout(), workout({ strain: null })] });
  assert.equal(row.workout_scored_count, 2);
  assert.equal(row.workout_strain_total, null, '★ 一筆缺就整個不可用');
  assert.notEqual(row.workout_strain_total, 8.5, '★ 絕不可以只回「拿得到的那一筆」');
  assert.equal(row.workout_kilojoule, 3000, '★ 齊全的欄位照常合計');
});

test('★★★ 缺任一心率區間 → 該區間合計不可用', () => {
  const missingZone2 = compute({ workouts: [workout({ zone_two_milli: null })] });
  assert.equal(missingZone2.zone1_3_minutes, null, '★ z1-3 不可用');
  assert.equal(missingZone2.zone4_5_minutes, 7, '★ z4-5 不受影響');

  const missingZone5 = compute({ workouts: [workout({ zone_five_milli: null })] });
  assert.equal(missingZone5.zone4_5_minutes, null);
  assert.equal(missingZone5.zone1_3_minutes, 25);
});

test('★★★ 運動起訖時間壞掉 → 時長不可用（不是 0 分鐘）', () => {
  const row = compute({ workouts: [workout({ end_at: 'not-a-date' })] });
  assert.equal(row.workout_scored_count, 1);
  assert.equal(row.workout_duration_minutes, null);
  assert.notEqual(row.workout_duration_minutes, 0);
});

test('★★★ 未評分的運動不影響已評分的總和', () => {
  const row = compute({
    workouts: [workout(), workout({ score_state: 'PENDING_SCORE', strain: null })],
  });
  assert.equal(row.workout_count, 2, '★ 兩筆紀錄');
  assert.equal(row.workout_scored_count, 1, '★ 只有一筆已評分');
  assert.equal(row.workout_strain_total, 8.5, '★ 未評分的不該讓總和失效');
});

// ===========================================================================
// 小睡
// ===========================================================================

test('★★★ 窗內沒有小睡：計數 0、總時長 0（真零）', () => {
  const row = compute({ naps: [] });
  assert.equal(row.nap_count, 0);
  assert.equal(row.nap_total_milli, 0, '★ 沒睡就是 0，這是事實不是缺值');
});

test('★★★ 小睡缺時長 → 總時長不可用（不是 0 分鐘的睡眠）', () => {
  const row = compute({ naps: [nap({ total_sleep_milli: null })] });
  assert.equal(row.nap_count, 1, '★ 紀錄確實存在');
  assert.equal(row.nap_total_milli, null);
  assert.notEqual(row.nap_total_milli, 0);
});

test('★★★ 多筆小睡齊全 → 正常合計；其中一筆缺 → 不可用', () => {
  const ok = compute({ naps: [nap(), nap({ total_sleep_milli: 600_000 })] });
  assert.equal(ok.nap_count, 2);
  assert.equal(ok.nap_total_milli, 3_000_000);

  const bad = compute({ naps: [nap(), nap({ total_sleep_milli: null })] });
  assert.equal(bad.nap_count, 2);
  assert.equal(bad.nap_total_milli, null, '★ 一筆缺就整個不可用');
});

// ===========================================================================
// 發布邊界
// ===========================================================================

test('★★★ 簡報絕不會把不可用的總和印成 0', () => {
  const metric = (over) => ({
    key: 'sleep_total', label: '睡眠', emoji: '🌙', tier: 'core',
    baselineDisplay: '7h05m', severity: 'normal', pct: 0, calibrating: false, ...over,
  });
  const base = { stage: 'full', sampleCount: 30, healthDate: HD, trends: null };

  const unknown = renderDaily({
    ...base, metrics: [metric({ available: false, display: null, value: null })],
  }, null);
  assert.match(unknown, /睡眠 無資料/, '★ 不可用要標示成無資料');
  assert.doesNotMatch(unknown, /睡眠 0/, '★ 絕不可以印成 0');

  const genuineZero = renderDaily({
    ...base, metrics: [metric({ available: true, display: '0m', value: 0 })],
  }, null);
  assert.match(genuineZero, /睡眠 0m/, '★ 真零照實印');
});
