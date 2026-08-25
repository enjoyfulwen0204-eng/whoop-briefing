import test from 'node:test';
import assert from 'node:assert/strict';

import {
  severityFor, stageFor, buildRecords, buildObservations, baselineRecords, computeBaselines,
  detectWake, detectTrends, evaluateAll, completedCycles, weeklyStats, weekOverWeek,
  metricValueFromRecord, yesterdayCycleFor, isValidHealthDay,
} from '../src/analyze.js';
import { BASELINE, THRESHOLDS, METRICS } from '../src/config.js';
import {
  localDate, localWeekday, addDays, completedWeeks, localMidnightUtc, prettyDate,
} from '../src/time.js';
import { renderDaily, clamp, FALLBACK_NOTE } from '../src/format.js';
import { redact, describeError } from '../src/logger.js';
import { retryAfterMs } from '../src/whoop.js';
import { buildBriefing } from '../src/daily.js';
import { makeDataset, degradedOverrides, trendOverrides, BASE } from './fixtures.js';

const TZ = 'Asia/Taipei';
const MIN = 60_000;

// ---------------------------------------------------------------------------
test('嚴重度：一般 higher-is-better 黃 -8% / 紅 -18%', () => {
  assert.equal(severityFor('sleep_performance', 95, 100), 'green');
  assert.equal(severityFor('sleep_performance', 92, 100), 'green');   // -8% 剛好不算黃
  assert.equal(severityFor('sleep_performance', 91, 100), 'yellow');
  assert.equal(severityFor('sleep_performance', 82, 100), 'yellow');  // -18% 剛好不算紅
  assert.equal(severityFor('sleep_performance', 81, 100), 'red');
});

test('嚴重度：HRV 用 -7% / -15%', () => {
  assert.equal(THRESHOLDS.hrv.yellow, -7);
  assert.equal(THRESHOLDS.hrv.red, -15);
  assert.equal(severityFor('hrv', 52, 55), 'green');      // -5.5%
  assert.equal(severityFor('hrv', 50, 55), 'yellow');     // -9.1%
  assert.equal(severityFor('hrv', 46, 55), 'red');        // -16.4%
});

test('嚴重度：RHR / 呼吸率是 lower-is-better', () => {
  assert.equal(severityFor('rhr', 52, 50), 'green');      // +4%
  assert.equal(severityFor('rhr', 53, 50), 'yellow');     // +6%
  assert.equal(severityFor('rhr', 56, 50), 'red');        // +12%
  assert.equal(severityFor('respiratory_rate', 15.5, 15), 'green');   // +3.3%
  assert.equal(severityFor('respiratory_rate', 15.8, 15), 'yellow');  // +5.3%
  assert.equal(severityFor('respiratory_rate', 16.4, 15), 'red');     // +9.3%
});

test('睡眠債加成用絕對分鐘差，baseline=0 也不會爆', () => {
  assert.equal(severityFor('sleep_debt', 20 * MIN, 10 * MIN), 'green');
  assert.equal(severityFor('sleep_debt', 45 * MIN, 10 * MIN), 'yellow');  // +35 分
  assert.equal(severityFor('sleep_debt', 105 * MIN, 10 * MIN), 'red');    // +95 分
  // baseline 為 0：不可以除法、也不可以回 null
  assert.equal(severityFor('sleep_debt', 40 * MIN, 0), 'yellow');
  assert.equal(severityFor('sleep_debt', 100 * MIN, 0), 'red');
  assert.equal(severityFor('sleep_debt', 5 * MIN, 0), 'green');
});

test('SpO2 / 皮膚溫度 / Strain 不給紅黃燈', () => {
  assert.equal(severityFor('spo2', 90, 96), null);
  assert.equal(severityFor('skin_temp', 35.5, 33.6), null);
  assert.equal(severityFor('strain', 20, 12), null);
});

test('baseline mean <= 0 或缺值時不給燈', () => {
  assert.equal(severityFor('hrv', 50, 0), null);
  assert.equal(severityFor('hrv', null, 55), null);
  assert.equal(severityFor('hrv', 50, null), null);
});

// ---------------------------------------------------------------------------
test('冷啟動分階：<7 / 7-29 / >=30', () => {
  assert.equal(stageFor(0), 'cold');
  assert.equal(stageFor(6), 'cold');
  assert.equal(stageFor(7), 'provisional');
  assert.equal(stageFor(29), 'provisional');
  assert.equal(stageFor(30), 'full');
  assert.equal(stageFor(44), 'full');
});

// ---------------------------------------------------------------------------
test('時間工具：local date / 星期 / 週區間', () => {
  // 2026-08-21T00:00:00Z = 台灣 08:00 同日
  assert.equal(localDate(new Date('2026-08-21T00:00:00Z'), TZ), '2026-08-21');
  // 2026-08-20T17:30:00Z = 台灣 01:30 隔天 → local date 要是 08-21，不是 08-20
  assert.equal(localDate(new Date('2026-08-20T17:30:00Z'), TZ), '2026-08-21');
  assert.equal(localWeekday('2026-08-24'), 1); // 週一
  assert.equal(localWeekday('2026-08-23'), 7); // 週日
  assert.equal(addDays('2026-08-24', -7), '2026-08-17');
  assert.equal(localMidnightUtc('2026-08-21', TZ).toISOString(), '2026-08-20T16:00:00.000Z');
  assert.match(prettyDate('2026-08-24'), /8\/24/);

  const w = completedWeeks(new Date('2026-08-24T00:00:00Z'), TZ); // 週一
  assert.equal(w.last.startDate, '2026-08-17');
  assert.equal(w.last.endDate, '2026-08-23');
  assert.equal(w.prev.startDate, '2026-08-10');
  assert.equal(w.prev.endDate, '2026-08-16');
  assert.equal(w.last.startUtc.toISOString(), '2026-08-16T16:00:00.000Z');
  assert.equal(w.last.endUtc.toISOString(), '2026-08-23T15:59:59.999Z');
});

// ---------------------------------------------------------------------------
test('起床觸發：主睡眠 SCORED + recovery 用 sleep_id 對上 + 已過 30 分鐘', () => {
  const ds = makeDataset({ days: 10, wakeMinutesAgo: 60 });
  const records = buildRecords({ ...ds, timezone: TZ });
  const wake = detectWake({
    observations: buildObservations({ ...ds, timezone: TZ }), now: ds.now, timezone: TZ,
  });
  assert.equal(wake.ready, true);
  assert.equal(wake.record.sleep.nap, false);
  assert.equal(wake.record.recovery.sleep_id, wake.record.sleepId);
  assert.ok(wake.minutesSinceWake >= 30);
});

test('起床觸發：未滿 30 分鐘不發（直接比 UTC）', () => {
  const ds = makeDataset({ days: 10, wakeMinutesAgo: 20 });
  const wake = detectWake({
    observations: buildObservations({ ...ds, timezone: TZ }), now: ds.now, timezone: TZ,
  });
  assert.equal(wake.ready, false);
  assert.equal(wake.reason, 'too_soon');
  assert.equal(wake.minutesSinceWake, 20);
});

test('起床觸發：剛好 30 分鐘就發', () => {
  const ds = makeDataset({ days: 10, wakeMinutesAgo: 30 });
  const wake = detectWake({
    observations: buildObservations({ ...ds, timezone: TZ }), now: ds.now, timezone: TZ,
  });
  assert.equal(wake.ready, true);
});

test('起床觸發：sleep 未評分 / recovery 缺失 / recovery 未評分都不發', () => {
  const unscored = makeDataset({ days: 10, unscoredDays: [0] });
  assert.equal(detectWake({
    observations: buildObservations({ ...unscored, timezone: TZ }),
    now: unscored.now, timezone: TZ,
  }).reason, 'sleep_not_scored');

  const ds = makeDataset({ days: 10 });
  const noRecovery = { ...ds, recoveries: ds.recoveries.slice(1) };
  assert.equal(detectWake({
    observations: buildObservations({ ...noRecovery, timezone: TZ }),
    now: ds.now, timezone: TZ,
  }).reason, 'recovery_missing');

  const wrongSleepId = {
    ...ds,
    recoveries: ds.recoveries.map((r, i) => (i === 0 ? { ...r, sleep_id: 'other-uuid' } : r)),
  };
  assert.equal(detectWake({
    observations: buildObservations({ ...wrongSleepId, timezone: TZ }),
    now: ds.now, timezone: TZ,
  }).reason, 'recovery_missing');
});

test('起床觸發：不會挑到小睡', () => {
  const ds = makeDataset({ days: 10, withNaps: true });
  const records = buildRecords({ ...ds, timezone: TZ });
  assert.ok(records.every((r) => r.sleep.nap === false));
  assert.ok(ds.sleeps.some((s) => s.nap === true), '假資料裡應該要有小睡');
});

// ---------------------------------------------------------------------------
test('baseline：排除今天、排除小睡、排除 user_calibrating、取最近 30 筆', () => {
  const ds = makeDataset({ days: 45, calibratingDays: [1, 2, 3], unscoredDays: [10] });
  const records = buildRecords({ ...ds, timezone: TZ });
  const today = localDate(ds.now, TZ);

  const baseSet = baselineRecords({
    records, healthDate: today, excludeSleepId: records[0].sleepId,
  });
  assert.ok(baseSet.every((r) => r.date !== today), 'baseline 不可包含今天');
  assert.ok(baseSet.every((r) => r.sleep.nap === false), 'baseline 不可包含小睡');
  assert.ok(baseSet.every((r) => r.sleep.score_state === 'SCORED'), 'baseline 只能用 SCORED');

  const baselines = computeBaselines({ records: baseSet, cycles: completedCycles(ds.cycles) });
  assert.equal(baselines.hrv.n, BASELINE.TARGET_SAMPLES);
  assert.equal(baselines.sleep_total.n, BASELINE.TARGET_SAMPLES);
  assert.ok(baselines.hrv.mean > 45 && baselines.hrv.mean < 65);

  // 校正期的 recovery 值不可被採用（recovery 類指標直接視為 null）
  const calibrating = baseSet.filter((r) => r.recovery?.score?.user_calibrating === true);
  assert.equal(calibrating.length, 3, '假資料應有 3 天處於校正期');
  const hrvMetric = METRICS.find((m) => m.key === 'hrv');
  const sleepMetric = METRICS.find((m) => m.key === 'sleep_total');
  for (const r of calibrating) {
    assert.equal(metricValueFromRecord(hrvMetric, r), null, '校正期不可提供 HRV');
    assert.notEqual(metricValueFromRecord(sleepMetric, r), null, '校正期的睡眠資料仍可用');
  }

  // 小睡的睡眠時長不可進 sleep_total 樣本
  const napTotal = 40 * MIN;
  assert.ok(!baselines.sleep_total.samples.includes(napTotal));
});

test('baseline：睡眠總時長 = light + 深睡 + REM（不含 awake / no-data）', () => {
  const ds = makeDataset({ days: 3 });
  const metric = METRICS.find((m) => m.key === 'sleep_total');
  const s = ds.sleeps.find((x) => x.nap === false);
  const g = s.score.stage_summary;
  assert.equal(
    metric.get(s),
    g.total_light_sleep_time_milli + g.total_slow_wave_sleep_time_milli + g.total_rem_sleep_time_milli,
  );
  assert.notEqual(metric.get(s), g.total_in_bed_time_milli);
});

test('昨日 Strain 用「上一個已完成」cycle，不用今天那個開放中的', () => {
  const ds = makeDataset({ days: 10 });
  const open = ds.cycles.find((c) => c.end === null);
  assert.ok(open, '假資料應該有一個還沒結束的 cycle');
  const done = completedCycles(ds.cycles);
  assert.ok(done.every((c) => c.end !== null));
  assert.notEqual(String(done[0].id), String(open.id));

  const briefing = buildBriefing({
    ...ds, timezone: TZ, healthDate: localDate(ds.now, TZ),
    wakeSleepId: 'sleep-000-uuid',
  });
  assert.equal(briefing.cycleId, String(done[0].id));
});

// ---------------------------------------------------------------------------
test('趨勢預警：連續 3 天走低 + 兩個生理訊號同時異常 → strong', () => {
  const ds = makeDataset({ days: 45, overrides: trendOverrides() });
  const briefing = buildBriefing({
    ...ds, timezone: TZ, healthDate: localDate(ds.now, TZ), wakeSleepId: 'sleep-000-uuid',
  });
  assert.equal(briefing.stage, 'full');
  assert.equal(briefing.trends.enabled, true);
  const keys = briefing.trends.alerts.map((a) => a.key);
  assert.ok(keys.includes('hrv'), 'HRV 應該被抓到');
  assert.ok(keys.includes('rhr'), 'RHR 應該被抓到');
  assert.equal(briefing.trends.level, 'strong');
  const hrv = briefing.trends.alerts.find((a) => a.key === 'hrv');
  assert.ok(hrv.types.includes('worsening'), 'HRV 逐日變差要被標為 worsening');
  // series 是舊 → 新
  assert.ok(hrv.series[0].value > hrv.series[2].value);
});

test('趨勢預警：資料正常時不亂報', () => {
  // 最近 3 天都貼著基準（沒有偏離）→ 不論排列是否單調都不該報
  const flat = { hrv: BASE.hrv, rhr: BASE.rhr, respiratory_rate: BASE.respiratory_rate, recovery_score: BASE.recovery_score };
  const ds = makeDataset({ days: 45, seed: 7, overrides: { 0: flat, 1: flat, 2: flat } });
  const briefing = buildBriefing({
    ...ds, timezone: TZ, healthDate: localDate(ds.now, TZ), wakeSleepId: 'sleep-000-uuid',
  });
  assert.equal(briefing.trends.level, 'none');
  assert.equal(briefing.trends.alerts.length, 0);
});

test('趨勢預警：單調下降但還在基準內 → 不報（避免每天亂叫）', () => {
  // HRV 56 → 55.5 → 55：確實逐日下降，但都在基準附近
  const ds = makeDataset({
    days: 45,
    overrides: { 2: { hrv: 56 }, 1: { hrv: 55.5 }, 0: { hrv: 55 } },
  });
  const briefing = buildBriefing({
    ...ds, timezone: TZ, healthDate: localDate(ds.now, TZ), wakeSleepId: 'sleep-000-uuid',
  });
  assert.ok(!briefing.trends.alerts.some((a) => a.key === 'hrv'));
});

test('趨勢預警：真的走低（70→65→46）要報 worsening', () => {
  const ds = makeDataset({
    days: 45,
    overrides: { 2: { hrv: 70 }, 1: { hrv: 65 }, 0: { hrv: 46 } },
  });
  const briefing = buildBriefing({
    ...ds, timezone: TZ, healthDate: localDate(ds.now, TZ), wakeSleepId: 'sleep-000-uuid',
  });
  const hrv = briefing.trends.alerts.find((a) => a.key === 'hrv');
  assert.ok(hrv, 'HRV 應該要被抓到');
  assert.ok(hrv.types.includes('worsening'));
});

test('趨勢預警：冷啟動階段（<30 筆）不啟用', () => {
  const ds = makeDataset({ days: 12, overrides: trendOverrides() });
  const briefing = buildBriefing({
    ...ds, timezone: TZ, healthDate: localDate(ds.now, TZ), wakeSleepId: 'sleep-000-uuid',
  });
  assert.equal(briefing.stage, 'provisional');
  assert.equal(briefing.trends.enabled, false);
  assert.equal(briefing.trends.alerts.length, 0);
});

// ---------------------------------------------------------------------------
test('冷啟動 <7 筆：不給任何紅黃燈，並標「個人基準建立中」', () => {
  const ds = makeDataset({ days: 5, overrides: degradedOverrides() });
  const briefing = buildBriefing({
    ...ds, timezone: TZ, healthDate: localDate(ds.now, TZ), wakeSleepId: 'sleep-000-uuid',
  });
  assert.equal(briefing.stage, 'cold');
  assert.ok(briefing.metrics.every((m) => m.severity === null), '冷啟動不可有嚴重度');

  const text = renderDaily(briefing, '教練文字');
  assert.ok(!/🟢|🟡|🔴/.test(text), `冷啟動訊息不該出現燈號：\n${text}`);
  assert.match(text, /個人基準建立中/);
});

test('7–29 筆：顯示「基準建立中 n/30」且會給燈', () => {
  const ds = makeDataset({ days: 15, overrides: degradedOverrides() });
  const briefing = buildBriefing({
    ...ds, timezone: TZ, healthDate: localDate(ds.now, TZ), wakeSleepId: 'sleep-000-uuid',
  });
  assert.equal(briefing.stage, 'provisional');
  const text = renderDaily(briefing, '教練文字');
  assert.match(text, /基準建立中 14\/30/);
  assert.ok(/🔴/.test(text), '暫定基準階段仍應給燈');
});

test('多項偏離時燈號正確（紅/黃由 Node 算好）', () => {
  const ds = makeDataset({ days: 45, overrides: degradedOverrides() });
  const briefing = buildBriefing({
    ...ds, timezone: TZ, healthDate: localDate(ds.now, TZ), wakeSleepId: 'sleep-000-uuid',
  });
  const by = Object.fromEntries(briefing.metrics.map((m) => [m.key, m]));
  assert.equal(by.hrv.severity, 'red');
  assert.equal(by.rhr.severity, 'red');
  assert.equal(by.respiratory_rate.severity, 'red');
  assert.equal(by.sleep_total.severity, 'red');
  assert.equal(by.spo2.severity, null);
  assert.equal(by.skin_temp.severity, null);
  assert.equal(by.strain.severity, null);
});

test('WHOOP 沒回傳的選配欄位（SpO2 / 皮膚溫度）整行不顯示，核心欄位缺才標無資料', () => {
  const ds = makeDataset({ days: 45, omitFields: ['spo2', 'skin_temp', 'sleep_consistency'] });
  const briefing = buildBriefing({
    ...ds, timezone: TZ, healthDate: localDate(ds.now, TZ), wakeSleepId: 'sleep-000-uuid',
  });
  const text = renderDaily(briefing, '教練文字');
  assert.ok(!text.includes('血氧'), '沒資料的選配欄位不該出現');
  assert.ok(!text.includes('皮膚溫度'));
  assert.ok(!text.includes('睡眠一致性'));
  assert.match(text, /睡眠效率/, '有資料的選配欄位要出現');
  assert.match(text, /HRV/);
});

test('Telegram：plain text、不超過 4096 字元', () => {
  const ds = makeDataset({ days: 45, overrides: { ...degradedOverrides(), ...trendOverrides() } });
  const briefing = buildBriefing({
    ...ds, timezone: TZ, healthDate: localDate(ds.now, TZ), wakeSleepId: 'sleep-000-uuid',
  });
  const text = renderDaily(briefing, 'x'.repeat(600));
  assert.ok(text.length <= 4096, `長度 ${text.length}`);
  assert.equal(clamp('a'.repeat(5000)).length, 4096);
});

test('Claude 掛掉：照樣發數據簡報 + fallback 說明', () => {
  const ds = makeDataset({ days: 45 });
  const briefing = buildBriefing({
    ...ds, timezone: TZ, healthDate: localDate(ds.now, TZ), wakeSleepId: 'sleep-000-uuid',
  });
  const text = renderDaily(briefing, null);
  assert.ok(text.includes(FALLBACK_NOTE));
  assert.match(text, /HRV/);
  assert.match(text, /恢復/);
});

// ---------------------------------------------------------------------------
test('每週統計：區間、平均、最好與最差的一天、與前週比較', () => {
  const monday = new Date('2026-08-24T00:00:00Z');
  assert.equal(localWeekday(localDate(monday, TZ)), 1);
  const ds = makeDataset({ days: 45, now: monday });
  const records = buildRecords({ ...ds, timezone: TZ });
  const weeks = completedWeeks(monday, TZ);

  const last = weeklyStats({ records, week: weeks.last });
  const prev = weeklyStats({ records, week: weeks.prev });
  assert.equal(last.days, 7);
  assert.equal(prev.days, 7);
  assert.ok(last.averages.recovery_score.mean > 0);
  assert.ok(last.best.value >= last.worst.value);
  assert.ok(last.best.date >= last.startDate && last.best.date <= last.endDate);

  const wow = weekOverWeek(last, prev);
  assert.ok(['up', 'down', 'flat'].includes(wow.recovery_score.direction));
});

// ---------------------------------------------------------------------------
test('log 會遮蔽 token / key，不會外洩', () => {
  const out = redact({
    access_token: 'super-secret-value',
    refresh_token: 'another-secret',
    nested: { authorization: 'Bearer abc', ok: 'visible' },
  });
  assert.ok(!JSON.stringify(out).includes('super-secret-value'));
  assert.ok(!JSON.stringify(out).includes('another-secret'));
  assert.ok(!JSON.stringify(out).includes('Bearer abc'));
  assert.match(JSON.stringify(out), /visible/);
  assert.equal(typeof describeError(new Error('boom')), 'string');
});

test('429 backoff：讀 Retry-After / X-RateLimit-Reset', () => {
  const mk = (h) => ({ headers: { get: (k) => h[k.toLowerCase()] ?? null } });
  assert.equal(retryAfterMs(mk({ 'retry-after': '3' })), 3000);
  assert.equal(retryAfterMs(mk({ 'x-ratelimit-reset': '5' })), 5000);
  const now = 1_800_000_000_000;
  assert.equal(retryAfterMs(mk({ 'x-ratelimit-reset': String(now / 1000 + 4) }), now), 4000);
  assert.equal(retryAfterMs(mk({})), null);
  assert.ok(retryAfterMs(mk({ 'retry-after': '99999' })) <= 60_000);
});

test('evaluateAll：核心指標一定在結果裡（缺資料就標 available=false）', () => {
  const ds = makeDataset({ days: 45, omitFields: ['spo2'] });
  const records = buildRecords({ ...ds, timezone: TZ });
  const baselines = computeBaselines({
    records: records.slice(1), cycles: completedCycles(ds.cycles),
  });
  const metrics = evaluateAll({
    record: records[0], cycle: completedCycles(ds.cycles)[0], baselines, stage: 'full',
  });
  const core = metrics.filter((m) => m.tier === 'core');
  assert.equal(core.length, 10, '核心指標應有 10 項');
  assert.ok(core.every((m) => m.available));
  assert.equal(metrics.find((m) => m.key === 'spo2').available, false);
});

// ---------------------------------------------------------------------------
// 修正 A：WHOOP 校正期
// ---------------------------------------------------------------------------
test('校正期：今天的恢復數值照顯示但不給燈（不是「無資料」）', () => {
  const ds = makeDataset({ days: 45, calibratingDays: [0] });
  const briefing = buildBriefing({
    ...ds, timezone: TZ, healthDate: localDate(ds.now, TZ), wakeSleepId: 'sleep-000-uuid',
  });
  const byKey = Object.fromEntries(briefing.metrics.map((m) => [m.key, m]));

  for (const key of ['recovery_score', 'hrv', 'rhr']) {
    assert.equal(byKey[key].available, true, `${key} 該有值 —— 校正期不等於無資料`);
    assert.equal(byKey[key].calibrating, true, `${key} 該被標記為校正期`);
    assert.equal(byKey[key].severity, null, `${key} 校正期不可給燈`);
  }

  // 睡眠類指標跟 recovery 校正無關，照常判定
  assert.equal(byKey.sleep_total.calibrating, false);
  assert.notEqual(byKey.sleep_total.severity, null, '睡眠指標不該被校正期波及');

  const text = renderDaily(briefing, '教練文字');
  assert.match(text, /WHOOP 恢復數據還在校正中/, '要說明為什麼沒有燈');
  assert.doesNotMatch(text, /HRV 無資料/, '不該再顯示成無資料');
});

test('校正期：baseline 仍然排除校正期的數字（修 A 沒有放寬這件事）', () => {
  const ds = makeDataset({ days: 45, calibratingDays: [1, 2, 3] });
  const records = buildRecords({ ...ds, timezone: TZ });
  const baseSet = baselineRecords({
    records, healthDate: localDate(ds.now, TZ), excludeSleepId: records[0].sleepId,
  });
  const hrvMetric = METRICS.find((m) => m.key === 'hrv');
  const calibrating = baseSet.filter((r) => r.recovery?.score?.user_calibrating === true);
  assert.equal(calibrating.length, 3);
  for (const r of calibrating) {
    assert.equal(metricValueFromRecord(hrvMetric, r), null, '預設仍排除校正期');
    assert.notEqual(
      metricValueFromRecord(hrvMetric, r, { allowCalibrating: true }), null,
      '只有明確要求時才給值',
    );
  }
});

// ---------------------------------------------------------------------------
// 修正 C：趨勢的 3 個資料點不能橫跨太多天
// ---------------------------------------------------------------------------
test('趨勢預警：中間缺資料 → streak 中斷，不算趨勢', () => {
  // 第 1~3 天沒資料 → 從第 0 天往回走第一步就斷了
  const ds = makeDataset({
    days: 45,
    unscoredDays: [1, 2, 3],
    overrides: { 0: { hrv: 44 }, 4: { hrv: 40 }, 5: { hrv: 45 } },
  });
  const briefing = buildBriefing({
    ...ds, timezone: TZ, healthDate: localDate(ds.now, TZ), wakeSleepId: 'sleep-000-uuid',
  });
  assert.equal(briefing.stage, 'full');
  assert.ok(
    !briefing.trends.alerts.some((a) => a.key === 'hrv'),
    '缺日就該中斷，不可跳過缺日往前湊 3 筆',
  );
});

test('趨勢預警：真的連續 3 天 → 文案寫「連續 3 天」', () => {
  // 44 → 40 → 45（新→舊皆低於基準，但不是單調變差）→ 只有 sustained_low
  const ds = makeDataset({
    days: 45,
    overrides: { 0: { hrv: 44 }, 1: { hrv: 40 }, 2: { hrv: 45 } },
  });
  const briefing = buildBriefing({
    ...ds, timezone: TZ, healthDate: localDate(ds.now, TZ), wakeSleepId: 'sleep-000-uuid',
  });
  const hrv = briefing.trends.alerts.find((a) => a.key === 'hrv');
  assert.ok(hrv, 'HRV 應該被抓到');
  assert.equal(hrv.series.length, 3);
  assert.ok(hrv.types.includes('sustained_low'));
  assert.ok(!hrv.types.includes('worsening'), '44→40→45 不是單調變差');
  assert.match(renderDaily(briefing, 'x'), /連續 3 天偏離基準/);
});

test('趨勢預警：只缺一天也立即中斷（不跳過缺日湊 3 筆）', () => {
  const ds = makeDataset({
    days: 45,
    unscoredDays: [1],
    overrides: { 0: { hrv: 44 }, 2: { hrv: 40 }, 3: { hrv: 45 } },
  });
  const briefing = buildBriefing({
    ...ds, timezone: TZ, healthDate: localDate(ds.now, TZ), wakeSleepId: 'sleep-000-uuid',
  });
  assert.equal(briefing.stage, 'full');
  assert.ok(
    !briefing.trends.alerts.some((a) => a.key === 'hrv'),
    '第 1 天未評分 → 從第 0 天往回第一步就斷，不該有 HRV 預警',
  );
  const text = renderDaily(briefing, 'x');
  assert.doesNotMatch(text, /近 \d+ 天內/, '不該再出現「近 N 天內」這種說法');
});

// ---------------------------------------------------------------------------
// health_date：晚起床 / 跨午夜補發
// ---------------------------------------------------------------------------
test('health_date：跨午夜也能補發（睡眠結束日 ≠ 執行當天）', () => {
  // 台灣時間 2026-08-23 00:30 執行，睡眠在 2026-08-22 23:00 結束
  const now = new Date('2026-08-22T16:30:00Z');
  const ds = makeDataset({ days: 40, now, wakeMinutesAgo: 90 });

  assert.equal(localDate(now, TZ), '2026-08-23', '執行當天是 8/23');

  const wake = detectWake({
    observations: buildObservations({ ...ds, timezone: TZ }), now, timezone: TZ,
  });
  assert.equal(wake.ready, true, '舊邏輯會因為「不是今天」而永久跳過，新邏輯要能發');
  assert.equal(wake.healthDate, '2026-08-22', 'health_date 是睡眠結束那天');
  assert.equal(wake.minutesSinceWake, 90);

  // 簡報上顯示的日期也要是 health_date，不是執行當天
  const briefing = buildBriefing({
    ...ds, timezone: TZ, healthDate: wake.healthDate, wakeSleepId: wake.record.sleepId,
  });
  assert.equal(briefing.healthDate, '2026-08-22');
  assert.match(renderDaily(briefing, 'x'), /8\/22/);
  assert.doesNotMatch(renderDaily(briefing, 'x'), /8\/23/);
});

test('health_date：sleep.end 超過 24 小時就不補發了', () => {
  const ds = makeDataset({ days: 40, wakeMinutesAgo: 25 * 60 });
  const wake = detectWake({
    observations: buildObservations({ ...ds, timezone: TZ }), now: ds.now, timezone: TZ,
  });
  assert.equal(wake.ready, false);
  assert.equal(wake.reason, 'sleep_too_old');
  assert.equal(wake.hoursSinceWake, 25);
});

test('health_date：剛好 24 小時內還發（邊界）', () => {
  const ds = makeDataset({ days: 40, wakeMinutesAgo: 24 * 60 });
  const wake = detectWake({
    observations: buildObservations({ ...ds, timezone: TZ }), now: ds.now, timezone: TZ,
  });
  assert.equal(wake.ready, true);
});

// ---------------------------------------------------------------------------
// 同一 health_date 多筆主睡眠
// ---------------------------------------------------------------------------
/** 在第 dayIndex 天插入一筆「更早結束」的額外主睡眠（模擬分段睡 / 補眠）。 */
function withExtraSleep(ds, dayIndex, { hoursEarlier = 4, hrv = 999 } = {}) {
  const base = ds.sleeps.find((s) => s.id === `sleep-${String(dayIndex).padStart(3, '0')}-uuid`);
  const end = new Date(new Date(base.end).getTime() - hoursEarlier * 3_600_000);
  const id = `sleep-${String(dayIndex).padStart(3, '0')}-extra`;
  return {
    ...ds,
    sleeps: [...ds.sleeps, { ...base, id, end: end.toISOString() }],
    recoveries: [...ds.recoveries, {
      ...ds.recoveries.find((r) => r.sleep_id === base.id),
      sleep_id: id,
      score: { ...base.score, user_calibrating: false, hrv_rmssd_milli: hrv, recovery_score: 50, resting_heart_rate: 50 },
    }],
  };
}

test('同一 health_date 多筆主睡眠：只留 sleep.end 最晚那筆，不會湊出假趨勢', () => {
  const ds0 = makeDataset({ days: 45, overrides: trendOverrides() });
  // 第 0、1 天各插一筆更早結束的睡眠，HRV 給極端值以便分辨用了哪一筆
  const ds = withExtraSleep(withExtraSleep(ds0, 0, { hrv: 999 }), 1, { hrv: 998 });

  const records = buildRecords({ ...ds, timezone: TZ });
  const observations = buildObservations({ ...ds, timezone: TZ });
  assert.ok(records.length > observations.length, 'records 應該比 observations 多（同日多筆）');

  // 每個 health_date 只剩一筆
  const dates = observations.map((o) => o.healthDate);
  assert.equal(new Set(dates).size, dates.length, '每個 health_date 只能有一筆 observation');

  // 留下的是 end 最晚那筆（不是 999 那筆）
  const todayObs = observations[0];
  assert.ok(!String(todayObs.sleepId).endsWith('-extra'), '該留原本那筆（結束較晚）');

  const briefing = buildBriefing({
    ...ds, timezone: TZ, healthDate: localDate(ds.now, TZ), wakeSleepId: todayObs.sleepId,
  });
  const hrv = briefing.trends.alerts.find((a) => a.key === 'hrv');
  assert.ok(hrv, '本來就該有 HRV 趨勢（trendOverrides）');
  const seriesDates = hrv.series.map((p) => p.date);
  assert.equal(new Set(seriesDates).size, 3, '3 個資料點必須是 3 個不同的日期');
  assert.ok(!hrv.series.some((p) => p.value === 999 || p.value === 998), '不該用到被淘汰的那筆');
});

// ---------------------------------------------------------------------------
// 趨勢：null 值中斷
// ---------------------------------------------------------------------------
test('趨勢預警：中間某天 recovery 在校正期 → streak 中斷', () => {
  const ds = makeDataset({
    days: 45,
    calibratingDays: [1],
    overrides: { 0: { hrv: 44 }, 1: { hrv: 40 }, 2: { hrv: 45 } },
  });
  const briefing = buildBriefing({
    ...ds, timezone: TZ, healthDate: localDate(ds.now, TZ), wakeSleepId: 'sleep-000-uuid',
  });
  assert.equal(briefing.stage, 'full');
  assert.ok(
    !briefing.trends.alerts.some((a) => a.key === 'hrv'),
    '校正期那天不算有效健康日，streak 該中斷',
  );
});

test('isValidHealthDay：睡眠未評分 / 無 recovery / recovery 未評分 / 校正期都不算有效', () => {
  const ds = makeDataset({ days: 5 });
  const obs = buildObservations({ ...ds, timezone: TZ });
  assert.equal(isValidHealthDay(obs[0]), true);
  assert.equal(isValidHealthDay(undefined), false);
  assert.equal(isValidHealthDay({ ...obs[0], sleep: { ...obs[0].sleep, score_state: 'PENDING_SCORE' } }), false);
  assert.equal(isValidHealthDay({ ...obs[0], recovery: null }), false);
  assert.equal(isValidHealthDay({ ...obs[0], recovery: { ...obs[0].recovery, score_state: 'PENDING_SCORE' } }), false);
  assert.equal(isValidHealthDay({
    ...obs[0],
    recovery: { ...obs[0].recovery, score: { ...obs[0].recovery.score, user_calibrating: true } },
  }), false);
});

// ---------------------------------------------------------------------------
// 昨日 Strain：單向選取 + baseline 口徑
// ---------------------------------------------------------------------------
test('昨日 Strain：sleep.end 前後各有 cycle 時，只選「之前」那個', () => {
  const ds = makeDataset({ days: 45 });
  const obs = buildObservations({ ...ds, timezone: TZ })[0];

  const before = {
    id: 900001,
    start: new Date(obs.endUtc.getTime() - 20 * 3_600_000).toISOString(),
    end: new Date(obs.endUtc.getTime() - 2 * 3_600_000).toISOString(), // 起床前 2 小時
    score_state: 'SCORED',
    score: { strain: 11.1 },
  };
  const after = {
    id: 900002,
    start: obs.endUtc.toISOString(),
    end: new Date(obs.endUtc.getTime() + 1 * 3_600_000).toISOString(), // 起床後 1 小時
    score_state: 'SCORED',
    score: { strain: 99.9 },
  };

  // 只用這兩筆，隔離驗證「單向選取」本身
  const cyclesDesc = completedCycles([before, after]);
  assert.equal(cyclesDesc[0].id, 900002, '排序上「起床後」那筆確實最新');

  const picked = yesterdayCycleFor(obs, cyclesDesc);
  assert.equal(picked.id, 900001, '必須跳過起床後那筆，選起床前最近的');
  assert.equal(picked.score.strain, 11.1);

  // 加回完整 cycle 清單後也不能選到起床後那筆
  const withAll = yesterdayCycleFor(obs, completedCycles([...ds.cycles, before, after]));
  assert.notEqual(withAll.id, 900002, '不論清單多長，都不可選到起床之後結束的 cycle');
  assert.ok(new Date(withAll.end).getTime() <= obs.endUtc.getTime());
});

test('昨日 Strain：sleep.end 之前找不到已完成 cycle → null，不退回用睡眠之後的', () => {
  const ds = makeDataset({ days: 45 });
  const obs = buildObservations({ ...ds, timezone: TZ })[0];
  const onlyAfter = [{
    id: 900003,
    start: obs.endUtc.toISOString(),
    end: new Date(obs.endUtc.getTime() + 3_600_000).toISOString(),
    score_state: 'SCORED',
    score: { strain: 99.9 },
  }];
  assert.equal(yesterdayCycleFor(obs, completedCycles(onlyAfter)), null);
});

test('昨日 Strain：太舊的 cycle（超過 48 小時）視為過期 → null', () => {
  const ds = makeDataset({ days: 45 });
  const obs = buildObservations({ ...ds, timezone: TZ })[0];
  const stale = [{
    id: 900004,
    start: new Date(obs.endUtc.getTime() - 80 * 3_600_000).toISOString(),
    end: new Date(obs.endUtc.getTime() - 72 * 3_600_000).toISOString(),
    score_state: 'SCORED',
    score: { strain: 12.0 },
  }];
  assert.equal(yesterdayCycleFor(obs, completedCycles(stale)), null);
});

test('昨日 Strain baseline：不混入今天、也不混入睡眠之後的 cycle', () => {
  const ds0 = makeDataset({ days: 45 });
  const obs = buildObservations({ ...ds0, timezone: TZ })[0];
  // 插一筆「今天起床之後」才結束的 cycle，strain 給極端值
  const afterWake = {
    id: 900005,
    start: obs.endUtc.toISOString(),
    end: new Date(obs.endUtc.getTime() + 2 * 3_600_000).toISOString(),
    score_state: 'SCORED',
    score: { strain: 99.9 },
  };
  const ds = { ...ds0, cycles: [...ds0.cycles, afterWake] };

  const briefing = buildBriefing({
    ...ds, timezone: TZ, healthDate: localDate(ds.now, TZ), wakeSleepId: 'sleep-000-uuid',
  });

  assert.ok(!briefing.baselines.strain.samples.includes(99.9), 'baseline 不可含睡眠之後的 cycle');
  const shown = briefing.metrics.find((m) => m.key === 'strain');
  assert.notEqual(shown.value, 99.9, '今日顯示值也不可用睡眠之後的 cycle');
  assert.equal(shown.severity, null, 'Strain 第一版仍不給燈');
  assert.ok(briefing.baselines.strain.n > 0, '基準要算得出來');
});

// ---------------------------------------------------------------------------
// loadDotEnvIfPresent：只忽略 ENOENT
// ---------------------------------------------------------------------------
test('loadDotEnvIfPresent：沒有 .env 安靜跳過；其他錯誤明確拋出', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const pathMod = await import('node:path');
  const { loadDotEnvIfPresent } = await import('../src/config.js');

  const cwd = process.cwd();
  const dir = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'whoop-env-'));
  try {
    process.chdir(dir);
    // 1) 沒有 .env → 不該拋錯
    loadDotEnvIfPresent();

    // 2) .env 存在但不是可讀檔案（這裡用目錄）→ 必須拋錯，不可靜默吞掉
    fs.mkdirSync(pathMod.join(dir, '.env'));
    assert.throws(() => loadDotEnvIfPresent(), /\.env 存在但載入失敗/);
  } finally {
    process.chdir(cwd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 週回顧的統計口徑（與 daily / 趨勢 / baseline 一致）
// ---------------------------------------------------------------------------
test('週回顧：分段睡的那天只算一天（不會出現「7 天的週回顧有效 8 天」）', () => {
  const now = new Date('2026-08-24T00:00:00Z'); // 台灣週一
  const ds0 = makeDataset({ days: 30, now });

  // 在上週某一天插入第二筆主睡眠（分段睡：同一 health_date 兩筆）
  const base = ds0.sleeps.find((s) => s.id === 'sleep-005-uuid');
  const extra = {
    ...base,
    id: 'sleep-005-extra',
    end: new Date(new Date(base.end).getTime() - 5 * 3_600_000).toISOString(),
  };
  const rec = ds0.recoveries.find((r) => r.sleep_id === base.id);
  const ds = {
    ...ds0,
    sleeps: [...ds0.sleeps, extra],
    recoveries: [...ds0.recoveries, { ...rec, sleep_id: 'sleep-005-extra' }],
  };

  const weeks = completedWeeks(now, TZ);

  // 舊口徑（buildRecords）會把那天算兩次
  const viaRecords = weeklyStats({
    records: buildRecords({ ...ds, timezone: TZ }), week: weeks.last,
  });
  assert.equal(viaRecords.days, 8, '（對照組）一筆睡眠一筆的舊口徑會變 8 天');

  // 現在的口徑（buildObservations）：一個 health_date 算一天
  const viaObs = weeklyStats({
    records: buildObservations({ ...ds, timezone: TZ }), week: weeks.last,
  });
  assert.equal(viaObs.days, 7, '一週最多 7 天');
  assert.equal(viaObs.averages.recovery_score.n, 7, '平均的樣本數也不能重複計算');
  assert.ok(viaObs.best && viaObs.worst, '最好 / 最差的一天照樣算得出來');
});

test('週回顧：同一 health_date 取 sleep.end 最晚那筆的值（不是先出現的那筆）', () => {
  const now = new Date('2026-08-24T00:00:00Z');
  const ds0 = makeDataset({ days: 30, now });
  const base = ds0.sleeps.find((s) => s.id === 'sleep-005-uuid');
  const earlier = {
    ...base,
    id: 'sleep-005-extra',
    end: new Date(new Date(base.end).getTime() - 5 * 3_600_000).toISOString(),
  };
  const rec = ds0.recoveries.find((r) => r.sleep_id === base.id);
  const ds = {
    ...ds0,
    sleeps: [...ds0.sleeps, earlier],
    // 較早那筆給一個極端的 recovery，用來分辨最後採用了哪一筆
    recoveries: [...ds0.recoveries, {
      ...rec, sleep_id: 'sleep-005-extra', score: { ...rec.score, recovery_score: 1 },
    }],
  };

  const obs = buildObservations({ ...ds, timezone: TZ });
  const target = obs.find((o) => o.healthDate === localDate(new Date(base.end), TZ));
  assert.equal(target.sleepId, 'sleep-005-uuid', '該留 sleep.end 較晚的那筆');

  const stats = weeklyStats({ records: obs, week: completedWeeks(now, TZ).last });
  assert.ok(stats.averages.recovery_score.mean > 20, '不該被那筆極端值（1%）拉低');
});
