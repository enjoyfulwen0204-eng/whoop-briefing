import test from 'node:test';
import assert from 'node:assert/strict';

import {
  severityFor, stageFor, buildRecords, baselineRecords, computeBaselines,
  detectWake, detectTrends, evaluateAll, completedCycles, weeklyStats, weekOverWeek,
  metricValueFromRecord,
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
  const wake = detectWake({ records, now: ds.now, timezone: TZ });
  assert.equal(wake.ready, true);
  assert.equal(wake.record.sleep.nap, false);
  assert.equal(wake.record.recovery.sleep_id, wake.record.sleepId);
  assert.ok(wake.minutesSinceWake >= 30);
});

test('起床觸發：未滿 30 分鐘不發（直接比 UTC）', () => {
  const ds = makeDataset({ days: 10, wakeMinutesAgo: 20 });
  const wake = detectWake({
    records: buildRecords({ ...ds, timezone: TZ }), now: ds.now, timezone: TZ,
  });
  assert.equal(wake.ready, false);
  assert.equal(wake.reason, 'too_soon');
  assert.equal(wake.minutesSinceWake, 20);
});

test('起床觸發：剛好 30 分鐘就發', () => {
  const ds = makeDataset({ days: 10, wakeMinutesAgo: 30 });
  const wake = detectWake({
    records: buildRecords({ ...ds, timezone: TZ }), now: ds.now, timezone: TZ,
  });
  assert.equal(wake.ready, true);
});

test('起床觸發：sleep 未評分 / recovery 缺失 / recovery 未評分都不發', () => {
  const unscored = makeDataset({ days: 10, unscoredDays: [0] });
  assert.equal(detectWake({
    records: buildRecords({ ...unscored, timezone: TZ }), now: unscored.now, timezone: TZ,
  }).reason, 'sleep_not_scored');

  const ds = makeDataset({ days: 10 });
  const noRecovery = { ...ds, recoveries: ds.recoveries.slice(1) };
  assert.equal(detectWake({
    records: buildRecords({ ...noRecovery, timezone: TZ }), now: ds.now, timezone: TZ,
  }).reason, 'recovery_missing');

  const wrongSleepId = {
    ...ds,
    recoveries: ds.recoveries.map((r, i) => (i === 0 ? { ...r, sleep_id: 'other-uuid' } : r)),
  };
  assert.equal(detectWake({
    records: buildRecords({ ...wrongSleepId, timezone: TZ }), now: ds.now, timezone: TZ,
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
    records, todayLocalDate: today, excludeSleepId: records[0].sleepId,
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
    ...ds, timezone: TZ, today: localDate(ds.now, TZ),
    wakeSleepId: 'sleep-000-uuid',
  });
  assert.equal(briefing.cycleId, String(done[0].id));
});

// ---------------------------------------------------------------------------
test('趨勢預警：連續 3 天走低 + 兩個生理訊號同時異常 → strong', () => {
  const ds = makeDataset({ days: 45, overrides: trendOverrides() });
  const briefing = buildBriefing({
    ...ds, timezone: TZ, today: localDate(ds.now, TZ), wakeSleepId: 'sleep-000-uuid',
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
    ...ds, timezone: TZ, today: localDate(ds.now, TZ), wakeSleepId: 'sleep-000-uuid',
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
    ...ds, timezone: TZ, today: localDate(ds.now, TZ), wakeSleepId: 'sleep-000-uuid',
  });
  assert.ok(!briefing.trends.alerts.some((a) => a.key === 'hrv'));
});

test('趨勢預警：真的走低（70→65→46）要報 worsening', () => {
  const ds = makeDataset({
    days: 45,
    overrides: { 2: { hrv: 70 }, 1: { hrv: 65 }, 0: { hrv: 46 } },
  });
  const briefing = buildBriefing({
    ...ds, timezone: TZ, today: localDate(ds.now, TZ), wakeSleepId: 'sleep-000-uuid',
  });
  const hrv = briefing.trends.alerts.find((a) => a.key === 'hrv');
  assert.ok(hrv, 'HRV 應該要被抓到');
  assert.ok(hrv.types.includes('worsening'));
});

test('趨勢預警：冷啟動階段（<30 筆）不啟用', () => {
  const ds = makeDataset({ days: 12, overrides: trendOverrides() });
  const briefing = buildBriefing({
    ...ds, timezone: TZ, today: localDate(ds.now, TZ), wakeSleepId: 'sleep-000-uuid',
  });
  assert.equal(briefing.stage, 'provisional');
  assert.equal(briefing.trends.enabled, false);
  assert.equal(briefing.trends.alerts.length, 0);
});

// ---------------------------------------------------------------------------
test('冷啟動 <7 筆：不給任何紅黃燈，並標「個人基準建立中」', () => {
  const ds = makeDataset({ days: 5, overrides: degradedOverrides() });
  const briefing = buildBriefing({
    ...ds, timezone: TZ, today: localDate(ds.now, TZ), wakeSleepId: 'sleep-000-uuid',
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
    ...ds, timezone: TZ, today: localDate(ds.now, TZ), wakeSleepId: 'sleep-000-uuid',
  });
  assert.equal(briefing.stage, 'provisional');
  const text = renderDaily(briefing, '教練文字');
  assert.match(text, /基準建立中 14\/30/);
  assert.ok(/🔴/.test(text), '暫定基準階段仍應給燈');
});

test('多項偏離時燈號正確（紅/黃由 Node 算好）', () => {
  const ds = makeDataset({ days: 45, overrides: degradedOverrides() });
  const briefing = buildBriefing({
    ...ds, timezone: TZ, today: localDate(ds.now, TZ), wakeSleepId: 'sleep-000-uuid',
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
    ...ds, timezone: TZ, today: localDate(ds.now, TZ), wakeSleepId: 'sleep-000-uuid',
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
    ...ds, timezone: TZ, today: localDate(ds.now, TZ), wakeSleepId: 'sleep-000-uuid',
  });
  const text = renderDaily(briefing, 'x'.repeat(600));
  assert.ok(text.length <= 4096, `長度 ${text.length}`);
  assert.equal(clamp('a'.repeat(5000)).length, 4096);
});

test('Claude 掛掉：照樣發數據簡報 + fallback 說明', () => {
  const ds = makeDataset({ days: 45 });
  const briefing = buildBriefing({
    ...ds, timezone: TZ, today: localDate(ds.now, TZ), wakeSleepId: 'sleep-000-uuid',
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
