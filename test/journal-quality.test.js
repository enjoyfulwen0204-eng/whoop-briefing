/**
 * Journal / Data quality / Healthspan / Insight memory / Experiment
 * （Phase N / P / R / Y / Z）。
 *
 * 重點：沒有 WHOOP 資料時全部都要能安全運作，而且絕不產生假的健康結論。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createDb } from '../src/db.js';
import { createSync } from '../src/sync.js';
import {
  parseLogCommand, validateEvent, healthDateFor, parseAmount,
  normalizeChineseNumbers, relativeDayOffset, describeEvent, saveEvent, CATEGORIES,
} from '../src/journal.js';
import { buildDataQualityReport, renderDataQuality } from '../src/dataQuality.js';
import { buildContributors, snapshotContributors, AVAILABILITY, CONTRIBUTORS } from '../src/healthspan.js';
import {
  statusFromEvidence, canTransition, recordInsight, reviseInsight,
  retireInsight, activeBeliefs, INSIGHT_STATUS,
} from '../src/healthMemory.js';
import {
  createExperiment, startExperiment, completeExperiment,
  analyseExperimentData, analyzeExperiment, EXPERIMENT_STATUS,
} from '../src/experiments.js';
import { makeDataset } from './fixtures.js';

const TZ = 'Asia/Taipei';
const NOW = new Date('2026-09-01T04:00:00Z'); // 台灣 12:00
const USER = { id: 'u-jq-test' };

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whoop-jq-'));
  return {
    url: `file:${path.join(dir, 'jq.db')}`,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

async function freshDb() {
  const { url, cleanup } = tempDb();
  const db = createDb({ url });
  await db.migrate();
  return { db, cleanup };
}

// ===========================================================================
// Phase N — Journal
// ===========================================================================

test('N: /log 各種寫法都解析得出來', () => {
  const opts = { now: NOW, timezone: TZ };

  const a = parseLogCommand('/log alcohol 3 drinks', opts);
  assert.equal(a.ok, true);
  assert.equal(a.event.category, 'alcohol');
  assert.equal(a.event.numericValue, 3);
  assert.equal(a.event.unit, 'drinks');

  const b = parseLogCommand('/log caffeine 2 coffee', opts);
  assert.equal(b.event.category, 'caffeine');
  assert.equal(b.event.numericValue, 2);

  const c = parseLogCommand('/log flight TPE SGN', opts);
  assert.equal(c.event.category, 'flight');
  assert.equal(c.event.textValue, 'TPE SGN');

  const d = parseLogCommand('/log sick', opts);
  assert.equal(d.event.category, 'sickness');

  const e = parseLogCommand('/log magnesium 300mg', opts);
  assert.equal(e.event.category, 'supplement', 'magnesium 要對到 supplement');
  assert.equal(e.event.subtype, 'magnesium');
  assert.equal(e.event.numericValue, 300);
  assert.equal(e.event.unit, 'mg');
});

test('N: 中文與相對日期', () => {
  const opts = { now: NOW, timezone: TZ };
  assert.equal(normalizeChineseNumbers('三杯'), '3杯');
  assert.equal(relativeDayOffset('昨天'), -1);
  assert.equal(relativeDayOffset('今天'), 0);
  assert.equal(relativeDayOffset('隨便'), null);

  const y = parseLogCommand('/log 昨天 alcohol 3', opts);
  assert.equal(y.ok, true);
  const today = parseLogCommand('/log alcohol 3', opts);
  assert.ok(y.event.healthDate < today.event.healthDate, '昨天要早於今天');
});

test('N: 不認得的類別會被拒絕並給提示', () => {
  const r = parseLogCommand('/log 我亂打的東西', { now: NOW, timezone: TZ });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'unknown_category');
  assert.match(r.hint, /alcohol/);
});

test('★ N: health_date 用凌晨 4 點當界線（半夜喝的酒算前一天）', () => {
  // 台灣時間 2026-09-02 02:00 = UTC 2026-09-01 18:00
  const lateNight = new Date('2026-09-01T18:00:00Z');
  assert.equal(healthDateFor(lateNight, TZ), '2026-09-01', '★ 凌晨 2 點算前一天');

  // 台灣時間 2026-09-02 05:00
  const morning = new Date('2026-09-01T21:00:00Z');
  assert.equal(healthDateFor(morning, TZ), '2026-09-02', '早上 5 點算當天');
});

test('★ N: validateEvent 擋掉所有不合法的提案', () => {
  const opts = { now: NOW, timezone: TZ };
  assert.equal(validateEvent({ category: '亂編' }, opts).ok, false);
  assert.equal(validateEvent(null, opts).ok, false);
  assert.equal(validateEvent('字串', opts).ok, false);

  // 未來太遠
  const future = validateEvent({
    category: 'alcohol', eventAt: new Date(NOW.getTime() + 5 * 86_400_000).toISOString(),
  }, opts);
  assert.equal(future.ok, false);
  assert.ok(future.errors.includes('event_in_future'));

  // 負數與不合法 severity
  assert.ok(validateEvent({ category: 'alcohol', numericValue: -3 }, opts)
    .errors.includes('negative_numeric_value'));
  assert.ok(validateEvent({ category: 'stress', severity: 99 }, opts)
    .errors.includes('invalid_severity'));

  // 合法的要通過
  const ok = validateEvent({ category: 'alcohol', numericValue: 3, unit: 'drinks' }, opts);
  assert.equal(ok.ok, true);
  assert.equal(ok.event.category, 'alcohol');
});

test('N: parseAmount', () => {
  assert.deepEqual(parseAmount('300mg'), { numericValue: 300, unit: 'mg' });
  assert.deepEqual(parseAmount('3 drinks'), { numericValue: 3, unit: 'drinks' });
  assert.deepEqual(parseAmount('沒有數字'), {});
});

test('N: 寫進 DB 並讀回來', async () => {
  const { db, cleanup } = await freshDb();
  try {
    const r = parseLogCommand('/log alcohol 3 drinks', { now: NOW, timezone: TZ });
    const saved = await saveEvent(db, USER.id, r.event, { now: NOW, timezone: TZ });
    assert.equal(saved.ok, true);

    const events = await db.getJournalEvents(USER.id, { from: '2026-01-01', to: '2027-01-01' });
    assert.equal(events.length, 1);
    assert.equal(events[0].category, 'alcohol');
    assert.equal(events[0].source, 'command');
    assert.equal(await db.countJournalEvents(USER.id), 1);
    // describeEvent 是給使用者看的 → 中文標籤，不是內部鍵
    assert.match(describeEvent(saved.event), /飲酒/);
    assert.doesNotMatch(describeEvent(saved.event), /alcohol/);
  } finally { db.close(); cleanup(); }
});

test('N: 所有宣告的 category 都能被解析', () => {
  for (const c of CATEGORIES) {
    const r = parseLogCommand(`/log ${c}`, { now: NOW, timezone: TZ });
    assert.equal(r.ok, true, `${c} 應該可以解析`);
    assert.equal(r.event.category, c);
  }
});

// ===========================================================================
// Phase P — Data quality
// ===========================================================================

test('★ P: 完全沒有資料時回完整報告，不是 error', async () => {
  const { db, cleanup } = await freshDb();
  try {
    const r = await buildDataQualityReport({ db, userId: USER.id, timezone: TZ, now: NOW });
    assert.equal(r.state, 'NO_AUTH', '連 token 都沒有');
    assert.equal(r.has_any_health_data, false);
    assert.equal(r.sleep_count, 0);
    assert.equal(r.recovery_count, 0);
    assert.equal(r.workout_count, 0);
    assert.equal(r.coverage_days, 0);
    assert.equal(r.capabilities.probed, false);
    assert.deepEqual(r.missing_scopes, ['read:workout', 'read:body_measurement']);

    const text = renderDataQuality(r);
    assert.match(text, /尚未開始/);
    assert.match(text, /睡眠：0 筆/);
    assert.ok(!/error/i.test(text));
  } finally { db.close(); cleanup(); }
});

test('P: 有資料時報告涵蓋率與缺漏天數', async () => {
  const { db, cleanup } = await freshDb();
  try {
    const ds = makeDataset({ days: 30, now: new Date('2026-09-01T00:00:00Z') });
    const whoop = {
      sleeps: async () => ds.sleeps,
      recoveries: async () => ds.recoveries,
      cycles: async () => ds.cycles,
      workouts: async () => [],
      bodyMeasurement: async () => null,
    };
    const sync = createSync({ db, whoop, userId: USER.id, timezone: TZ, now: new Date('2026-09-01T00:00:00Z') });
    await sync.incremental('sleep');
    await sync.incremental('recovery');

    const r = await buildDataQualityReport({ db, userId: USER.id, timezone: TZ, now: NOW });
    assert.ok(r.has_any_health_data);
    assert.ok(r.sleep_count > 0);
    assert.ok(r.history_start && r.history_end);
    assert.ok(r.coverage_ratio > 0 && r.coverage_ratio <= 1);
    const text = renderDataQuality(r);
    assert.match(text, /歷史區間/);
    assert.match(text, /涵蓋天數/);
  } finally { db.close(); cleanup(); }
});

test('P: 某個查詢失敗不會讓整份報告失敗', async () => {
  const broken = {
    coverage: async () => { throw new Error('boom'); },
    getAllSyncState: async () => { throw new Error('boom'); },
    getCapabilities: async () => ({}),
    countJournalEvents: async () => 3,
    getTokens: async () => null,
  };
  const r = await buildDataQualityReport({ db: broken, userId: USER.id, timezone: TZ, now: NOW });
  assert.equal(r.sleep_count, 0, '壞掉的部分退成 0');
  assert.equal(r.journal_count, 3, '沒壞的部分照常');
  assert.ok(renderDataQuality(r).length > 0);
});

// ===========================================================================
// Phase R — Healthspan 基礎
// ===========================================================================

test('★ R: 沒有資料時所有 contributor 都是 UNKNOWN 或 APP_ONLY，值一律 null', () => {
  const cs = buildContributors([], { windowDays: 90 });
  assert.equal(cs.length, CONTRIBUTORS.length);
  for (const c of cs) {
    assert.equal(c.value, null, `${c.metricKey} 不可以有值`);
    assert.ok(
      [AVAILABILITY.UNKNOWN, AVAILABILITY.APP_ONLY].includes(c.availability),
      `${c.metricKey} 應該是 UNKNOWN 或 APP_ONLY，實際 ${c.availability}`,
    );
  }
});

test('★ R: 官方 API 拿不到的 contributor 永遠標 APP_ONLY，永遠沒有值', () => {
  const cs = buildContributors([], { windowDays: 90 });
  const byKey = Object.fromEntries(cs.map((c) => [c.metricKey, c]));
  for (const key of ['steps', 'vo2_max', 'lean_body_mass']) {
    assert.equal(byKey[key].availability, AVAILABILITY.APP_ONLY, `${key} 必須是 APP_ONLY`);
    assert.equal(byKey[key].value, null);
    assert.ok(byKey[key].detail, '要說明為什麼拿不到');
  }
});

test('R: 有足夠資料的 contributor 才會有值（樣本太少一律 null）', () => {
  const rows = Array.from({ length: 80 }, (_, i) => ({
    health_date: new Date(Date.parse('2026-06-01T00:00:00Z') + i * 86_400_000)
      .toISOString().slice(0, 10),
    hrv: 55 + (i % 5),
    rhr: 50,
    sleep_total: 25_000_000,
    // 只有 2 天有 spo2 → 樣本不足
    spo2: i < 2 ? 96 : null,
  }));
  const cs = buildContributors(rows, { endDate: rows.at(-1).health_date, windowDays: 90 });
  const byKey = Object.fromEntries(cs.map((c) => [c.metricKey, c]));

  assert.ok(byKey.hrv.value > 0, 'HRV 樣本夠 → 有值');
  assert.equal(byKey.hrv.availability, AVAILABILITY.AVAILABLE);
  assert.ok(byKey.hrv.sampleCount >= 70);

  assert.equal(byKey.spo2.value, null, '★ 只有 2 筆不可以拿來當結論');
  assert.equal(byKey.spo2.availability, AVAILABILITY.UNKNOWN);
});

test('★ R: snapshot 只建底座，score 一定是 null（不算生理年齡）', async () => {
  const { db, cleanup } = await freshDb();
  try {
    const out = await snapshotContributors({
  userId: USER.id,
      db, rows: [], endDate: '2026-09-01', windowDays: 90, now: NOW,
    });
    assert.equal(out.score, null, '★ 這一輪絕不產生生理年齡');
    assert.match(out.note, /不計算生理年齡/);

    const snaps = await db.getHealthspanSnapshots(USER.id);
    assert.equal(snaps.length, 1);
    assert.equal(snaps[0].score, null);
    assert.equal(snaps[0].status, 'FOUNDATION_ONLY');
    assert.equal(snaps[0].algorithm_version, 'foundation-v0', '公式要可以版本化');

    const metrics = await db.getLatestHealthspanMetrics(USER.id);
    assert.equal(metrics.length, CONTRIBUTORS.length);
    assert.ok(metrics.every((m) => m.availability));
  } finally { db.close(); cleanup(); }
});

// ===========================================================================
// Phase Y — Insight memory
// ===========================================================================

test('Y: 證據強度決定狀態', () => {
  assert.equal(statusFromEvidence({ sampleCount: 5, effectSize: 0.9 }), INSIGHT_STATUS.HYPOTHESIS);
  assert.equal(statusFromEvidence({ sampleCount: 15, effectSize: 0.6 }), INSIGHT_STATUS.EMERGING);
  assert.equal(statusFromEvidence({ sampleCount: 30, effectSize: 0.8 }), INSIGHT_STATUS.SUPPORTED);
  assert.equal(statusFromEvidence({ sampleCount: 50, effectSize: 0.05 }), INSIGHT_STATUS.WEAKENED);
});

test('Y: 非法狀態轉移會被拒絕', () => {
  assert.equal(canTransition('HYPOTHESIS', 'EMERGING'), true);
  assert.equal(canTransition('SUPPORTED', 'WEAKENED'), true);
  assert.equal(canTransition('RETIRED', 'SUPPORTED'), false, '退休的不可以復活');
  assert.equal(canTransition('HYPOTHESIS', 'SUPPORTED'), false, '不可以跳級');
});

test('★ Y: belief revision —— 舊版本保留、版本鏈可回溯', async () => {
  const { db, cleanup } = await freshDb();
  try {
    const { id, status } = await recordInsight(db, USER.id, {
      insightType: 'association',
      subject: 'alcohol->recovery',
      statement: '喝酒的隔天恢復似乎偏低',
      evidence: { pearson: -0.4 },
      sampleCount: 12,
      effectSize: 0.5,
    }, { now: NOW });
    assert.equal(status, INSIGHT_STATUS.EMERGING);

    // 更多證據進來 → 升級成 SUPPORTED，開新版本
    const rev = await reviseInsight(db, USER.id, id, {
      statement: '喝酒的隔天恢復偏低（更多資料支持）',
      evidence: { pearson: -0.55 },
      sampleCount: 45,
      effectSize: 0.8,
    }, { now: NOW });
    assert.equal(rev.ok, true);
    assert.equal(rev.changed, true);
    assert.equal(rev.status, INSIGHT_STATUS.SUPPORTED);
    assert.equal(rev.supersedes, id);

    // 舊的仍在，只是 RETIRED
    const old = await db.getInsight(USER.id, id);
    assert.equal(old.status, INSIGHT_STATUS.RETIRED, '★ 舊版本不可以被刪除');
    assert.ok(old.retired_at);

    const next = await db.getInsight(USER.id, rev.id);
    assert.equal(Number(next.version), 2);
    assert.equal(Number(next.supersedes_id), id);
    // first_detected_at 要延續，不是重新開始
    assert.equal(next.first_detected_at, old.first_detected_at);

    const chain = await db.getInsightHistory(USER.id, rev.id);
    assert.equal(chain.length, 2, '★ 版本鏈可以回溯');
  } finally { db.close(); cleanup(); }
});

test('Y: 證據變弱 → WEAKENED；狀態沒變則不開新版本', async () => {
  const { db, cleanup } = await freshDb();
  try {
    const { id } = await recordInsight(db, USER.id, {
      insightType: 'association', subject: 's', statement: 'x',
      sampleCount: 45, effectSize: 0.8,
    }, { now: NOW });

    // 同樣強度 → 只是重新確認
    const same = await reviseInsight(db, USER.id, id, { sampleCount: 46, effectSize: 0.8 }, { now: NOW });
    assert.equal(same.changed, false, '狀態沒變就不要開新版本');
    assert.equal(same.id, id);

    // 效果消失 → WEAKENED
    const weak = await reviseInsight(db, USER.id, id, { sampleCount: 60, effectSize: 0.05 }, { now: NOW });
    assert.equal(weak.changed, true);
    assert.equal(weak.status, INSIGHT_STATUS.WEAKENED);
  } finally { db.close(); cleanup(); }
});

test('Y: retire 之後不能再修改；HYPOTHESIS 不算「相信」', async () => {
  const { db, cleanup } = await freshDb();
  try {
    const a = await recordInsight(db, USER.id, {
      insightType: 'association', subject: 'a', statement: 'weak',
      sampleCount: 5, effectSize: 0.9,
    }, { now: NOW });
    assert.equal(a.status, INSIGHT_STATUS.HYPOTHESIS);

    const b = await recordInsight(db, USER.id, {
      insightType: 'association', subject: 'b', statement: 'strong',
      sampleCount: 50, effectSize: 0.9,
    }, { now: NOW });

    const beliefs = await activeBeliefs(db, USER.id);
    assert.equal(beliefs.length, 1, '★ 只有證據夠的才算「相信」');
    assert.equal(Number(beliefs[0].id), b.id);

    assert.equal((await retireInsight(db, USER.id, b.id, { now: NOW })).ok, true);
    assert.equal((await retireInsight(db, USER.id, b.id, { now: NOW })).ok, false, '不能重複退休');
    assert.equal((await reviseInsight(db, USER.id, b.id, { sampleCount: 60, effectSize: 0.9 })).ok, false);
  } finally { db.close(); cleanup(); }
});

// ===========================================================================
// Phase Z — Experiments
// ===========================================================================

test('Z: 實驗生命週期 DRAFT → RUNNING → COMPLETED', async () => {
  const { db, cleanup } = await freshDb();
  try {
    const c = await createExperiment(db, USER.id, {
      name: '睡前不喝咖啡', hypothesis: '深睡會變多',
      intervention: '14:00 後不攝取咖啡因', targetMetrics: ['deep_sleep', 'recovery'],
    }, { now: NOW });
    assert.equal(c.ok, true);

    assert.equal((await db.getExperiment(USER.id, c.id)).status, EXPERIMENT_STATUS.DRAFT);

    const s = await startExperiment(db, USER.id, c.id, {
      startDate: '2026-08-15', baselineStart: '2026-08-01', baselineEnd: '2026-08-14', now: NOW,
    });
    assert.equal(s.ok, true);
    assert.equal((await db.getExperiment(USER.id, c.id)).status, EXPERIMENT_STATUS.RUNNING);

    // 不能重複啟動
    assert.equal((await startExperiment(db, USER.id, c.id, { startDate: '2026-08-20' })).ok, false);

    const done = await completeExperiment(db, USER.id, c.id, { endDate: '2026-08-28', now: NOW });
    assert.equal(done.ok, true);
    assert.equal((await db.getExperiment(USER.id, c.id)).status, EXPERIMENT_STATUS.COMPLETED);
  } finally { db.close(); cleanup(); }
});

test('Z: 缺必要欄位會被拒絕', async () => {
  const { db, cleanup } = await freshDb();
  try {
    assert.equal((await createExperiment(db, USER.id, { name: '' })).ok, false);
    assert.equal((await createExperiment(db, USER.id, { name: 'x' })).ok, false, '沒有 target metrics');
    assert.equal((await startExperiment(db, USER.id, 999, { startDate: 'x' })).ok, false, '不存在的實驗');
  } finally { db.close(); cleanup(); }
});

test('★ Z: 分析輸出 baseline vs intervention，且明確標示非因果', () => {
  const rows = [];
  const t0 = Date.parse('2026-08-01T00:00:00Z');
  for (let i = 0; i < 28; i++) {
    const date = new Date(t0 + i * 86_400_000).toISOString().slice(0, 10);
    rows.push({ health_date: date, deep_sleep: i < 14 ? 5_000_000 : 6_500_000 });
  }
  const result = analyseExperimentData({
    rows,
    experiment: {
      id: 1, name: 'test', target_metrics: JSON.stringify(['deep_sleep']),
      baseline_start: '2026-08-01', baseline_end: '2026-08-14',
      start_date: '2026-08-15', end_date: '2026-08-28',
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.causal, false, '★ 絕不宣稱因果');
  assert.equal(result.interpretation, 'within-person observed association');
  assert.match(result.note, /不是隨機對照試驗/);

  const m = result.metrics.deep_sleep;
  assert.equal(m.sufficient, true);
  assert.equal(m.baseline_n, 14);
  assert.equal(m.intervention_n, 14);
  assert.equal(m.mean_difference, 1_500_000);
  assert.ok(m.median_difference > 0);
});

test('★ Z: 期間樣本不足時不下結論', () => {
  const rows = [
    { health_date: '2026-08-01', deep_sleep: 5_000_000 },
    { health_date: '2026-08-15', deep_sleep: 6_000_000 },
  ];
  const result = analyseExperimentData({
    rows,
    experiment: {
      id: 1, name: 't', target_metrics: JSON.stringify(['deep_sleep']),
      baseline_start: '2026-08-01', baseline_end: '2026-08-14',
      start_date: '2026-08-15', end_date: '2026-08-28',
    },
  });
  assert.equal(result.metrics.deep_sleep.sufficient, false);
  assert.equal(result.metrics.deep_sleep.reason, 'insufficient_data');
});

test('Z: 缺日期時明講，不硬算', () => {
  const r = analyseExperimentData({
    rows: [], experiment: { id: 1, name: 't', target_metrics: '[]' },
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'missing_period_dates');
});

test('Z: analyzeExperiment 會把結果存回 DB', async () => {
  const { db, cleanup } = await freshDb();
  try {
    const c = await createExperiment(db, USER.id, {
      name: 'x', targetMetrics: ['recovery'],
      baselineStart: '2026-08-01', baselineEnd: '2026-08-14',
      startDate: '2026-08-15', endDate: '2026-08-28',
    }, { now: NOW });
    const rows = Array.from({ length: 28 }, (_, i) => ({
      health_date: new Date(Date.parse('2026-08-01T00:00:00Z') + i * 86_400_000)
        .toISOString().slice(0, 10),
      recovery: i < 14 ? 60 : 70,
    }));
    const res = await analyzeExperiment(db, USER.id, c.id, rows, { now: NOW });
    assert.equal(res.ok, true);
    const stored = await db.getExperiment(USER.id, c.id);
    assert.ok(stored.result_json, '結果要存回 DB');
    assert.equal(JSON.parse(stored.result_json).metrics.recovery.mean_difference, 10);
  } finally { db.close(); cleanup(); }
});
