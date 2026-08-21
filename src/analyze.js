/**
 * 所有數值判斷都在這裡（deterministic Node code）。
 * Claude 只把這裡算好的結果講成人話，不參與任何好壞判斷。
 */

import {
  BASELINE, METRICS, METRIC_BY_KEY, THRESHOLDS, TREND, WAKE, num,
} from './config.js';
import { localDate, minutesBetween } from './time.js';

// ---------------------------------------------------------------------------
// 1. 把 WHOOP 原始資料整理成「一天一筆」
// ---------------------------------------------------------------------------

/**
 * 主睡眠(nap===false) + 對應的 recovery(sleep_id 相符) 組成每日紀錄。
 * 依睡眠結束時間新→舊排序。
 */
export function buildRecords({ sleeps = [], recoveries = [], timezone }) {
  const recoveryBySleep = new Map();
  for (const r of recoveries) {
    if (r?.sleep_id) recoveryBySleep.set(String(r.sleep_id), r);
  }

  return sleeps
    .filter((s) => s && s.nap === false && s.end)
    .map((s) => ({
      sleepId: String(s.id),
      date: localDate(s.end, timezone),
      endUtc: new Date(s.end),
      sleep: s,
      recovery: recoveryBySleep.get(String(s.id)) ?? null,
    }))
    .sort((a, b) => b.endUtc - a.endUtc);
}

/** 已完成(end 不為 null)且 SCORED 的 cycle，新→舊。 */
export function completedCycles(cycles = []) {
  return cycles
    .filter((c) => c && c.end && c.score_state === 'SCORED' && num(c?.score?.strain) !== null)
    .sort((a, b) => new Date(b.end) - new Date(a.end));
}

// ---------------------------------------------------------------------------
// 2. 起床觸發判斷
// ---------------------------------------------------------------------------

/**
 * 找最新一筆 nap===false 的主睡眠 → 該 sleep.score_state==='SCORED'
 *   → recovery.sleep_id === 該 sleep.id → recovery.score_state==='SCORED'
 *   → nowUTC - sleep.end >= 30 分鐘（直接比 UTC）
 * 另外要求該睡眠的「當地結束日期」就是今天，避免拿舊資料重複報今天。
 */
export function detectWake({ records, now, timezone }) {
  const today = localDate(now, timezone);
  const latest = records[0];

  if (!latest) return { ready: false, reason: 'no_main_sleep' };
  if (latest.sleep.score_state !== 'SCORED') {
    return { ready: false, reason: 'sleep_not_scored', record: latest };
  }
  if (!latest.recovery) {
    return { ready: false, reason: 'recovery_missing', record: latest };
  }
  if (latest.recovery.score_state !== 'SCORED') {
    return { ready: false, reason: 'recovery_not_scored', record: latest };
  }

  const minutes = minutesBetween(now, latest.endUtc);
  if (minutes < WAKE.MIN_MINUTES_AFTER_SLEEP_END) {
    return {
      ready: false,
      reason: 'too_soon',
      minutesSinceWake: Math.round(minutes),
      record: latest,
    };
  }
  if (latest.date !== today) {
    return { ready: false, reason: 'sleep_not_today', sleepDate: latest.date, record: latest };
  }
  return { ready: true, record: latest, minutesSinceWake: Math.round(minutes), localDate: today };
}

// ---------------------------------------------------------------------------
// 3. Baseline
// ---------------------------------------------------------------------------

/**
 * 可進 baseline 的每日紀錄：
 *  - 排除今天、排除被評估的那一筆
 *  - 睡眠必須 SCORED、必須是主睡眠（buildRecords 已過濾 nap）
 *  - recovery 若是 user_calibrating===true 則該筆的 recovery 指標不採用
 */
export function baselineRecords({ records, todayLocalDate, excludeSleepId }) {
  return records.filter((r) => {
    if (r.date === todayLocalDate) return false;
    if (excludeSleepId && r.sleepId === excludeSleepId) return false;
    return r.sleep.score_state === 'SCORED';
  });
}

/** 冷啟動分階（寫死）。 */
export function stageFor(validCount) {
  if (validCount < BASELINE.MIN_FOR_LIGHTS) return 'cold';
  if (validCount < BASELINE.TARGET_SAMPLES) return 'provisional';
  return 'full';
}

function metricValueFromRecord(metric, record) {
  if (metric.source === 'sleep') return metric.get(record.sleep);
  if (metric.source === 'recovery') {
    if (!record.recovery) return null;
    if (record.recovery.score_state !== 'SCORED') return null;
    if (record.recovery.score?.user_calibrating === true) return null; // 排除校正期
    return metric.get(record.recovery);
  }
  return null;
}

/**
 * 每個指標各自取「最近 N 筆有效（非 null）」算平均。
 * 回傳 { [key]: { mean, n, samples } }
 */
export function computeBaselines({ records, cycles = [], excludeCycleId = null,
  target = BASELINE.TARGET_SAMPLES }) {
  const out = {};

  for (const metric of METRICS) {
    if (metric.source === 'cycle') continue;
    const samples = [];
    for (const r of records) {
      if (samples.length >= target) break;
      const v = metricValueFromRecord(metric, r);
      if (v !== null) samples.push(v);
    }
    out[metric.key] = summarize(samples);
  }

  // strain 的基準來自已完成的 cycle（排除正在被當成「昨日 Strain」的那一筆）
  const strainMetric = METRIC_BY_KEY.strain;
  const strainSamples = [];
  for (const c of cycles) {
    if (strainSamples.length >= target) break;
    if (excludeCycleId && String(c.id) === String(excludeCycleId)) continue;
    const v = strainMetric.get(c);
    if (v !== null) strainSamples.push(v);
  }
  out.strain = summarize(strainSamples);

  return out;
}

function summarize(samples) {
  if (!samples.length) return { mean: null, n: 0, samples };
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  return { mean, n: samples.length, samples };
}

// ---------------------------------------------------------------------------
// 4. 三級嚴重度
// ---------------------------------------------------------------------------

/**
 * 回傳 'green' | 'yellow' | 'red' | null（null = 不給燈）
 * 判斷完全由這裡決定，Claude 不得改動。
 */
export function severityFor(metricKey, value, baselineMean) {
  const t = THRESHOLDS[metricKey];
  if (!t || t.dir === 'none') return null;
  if (value === null || baselineMean === null) return null;

  if (t.dir === 'absMin') {
    // 不除 baseline（可能為 0），用絕對分鐘差
    const diffMin = (value - baselineMean) / 60000;
    if (diffMin >= t.red) return 'red';
    if (diffMin >= t.yellow) return 'yellow';
    return 'green';
  }

  if (baselineMean <= 0) return null; // 避免除以 0 或負基準
  const pct = ((value - baselineMean) / baselineMean) * 100;

  if (t.dir === 'higher') {
    if (pct < t.red) return 'red';
    if (pct < t.yellow) return 'yellow';
    return 'green';
  }
  // lower-is-better
  if (pct > t.red) return 'red';
  if (pct > t.yellow) return 'yellow';
  return 'green';
}

/** 單一指標的完整評估結果。 */
export function evaluateMetric({ metric, record, cycle, baselines, stage }) {
  const value = metric.source === 'cycle'
    ? metric.get(cycle)
    : metricValueFromRecord(metric, record);

  const base = baselines[metric.key] ?? { mean: null, n: 0 };
  const enoughSamples = base.n >= BASELINE.MIN_PER_METRIC;
  const lightsAllowed = stage !== 'cold' && enoughSamples;

  const severity = lightsAllowed ? severityFor(metric.key, value, base.mean) : null;

  let pct = null;
  let diff = null;
  if (value !== null && base.mean !== null) {
    diff = value - base.mean;
    if (base.mean > 0) pct = ((value - base.mean) / base.mean) * 100;
  }

  return {
    key: metric.key,
    label: metric.label,
    emoji: metric.emoji,
    tier: metric.tier,
    available: value !== null,
    value,
    display: value === null ? null : metric.fmt(value),
    baseline: base.mean,
    baselineDisplay: base.mean === null ? null : metric.fmt(base.mean),
    baselineN: base.n,
    pct,
    diff,
    severity,
    scored: THRESHOLDS[metric.key]?.dir !== 'none',
  };
}

/** 一次算完所有指標。 */
export function evaluateAll({ record, cycle, baselines, stage }) {
  return METRICS.map((metric) => evaluateMetric({ metric, record, cycle, baselines, stage }));
}

// ---------------------------------------------------------------------------
// 5. 趨勢預警
// ---------------------------------------------------------------------------

/**
 * A 持續偏低：某指標連續 3 個資料點都低於基準門檻（severity 為黃或紅）。
 * B 持續惡化：某指標連續 3 個資料點逐日變差。
 *
 * 只在 stage === 'full'（>=30 筆正式 baseline）才啟用。
 * 兩個以上生理訊號同時異常 → level = 'strong'。
 */
export function detectTrends({ records, baselines, stage, cycles = [] }) {
  if (stage !== TREND.MIN_STAGE) return { enabled: false, alerts: [], level: 'none' };

  const alerts = [];

  for (const key of TREND.METRICS) {
    const metric = METRIC_BY_KEY[key];
    if (!metric) continue;
    const t = THRESHOLDS[key];
    if (!t || t.dir === 'none') continue;

    // 取最近 3 個有值的資料點（新→舊）
    const points = [];
    const source = metric.source === 'cycle' ? cycles : records;
    for (const item of source) {
      if (points.length >= TREND.WINDOW) break;
      const v = metric.source === 'cycle' ? metric.get(item) : metricValueFromRecord(metric, item);
      if (v !== null) points.push({ date: item.date ?? null, value: v });
    }
    if (points.length < TREND.WINDOW) continue;

    const base = baselines[key];
    if (!base || base.mean === null || base.n < BASELINE.MIN_PER_METRIC) continue;

    const sevs = points.map((p) => severityFor(key, p.value, base.mean));
    const deviating = (s) => s === 'yellow' || s === 'red';

    // A 持續偏低：連續 3 個資料點都超出門檻
    const sustainedLow = sevs.every(deviating);

    // B 持續惡化：舊→新逐點變差，而且「最新那點已經超出門檻」。
    // 後面這個條件很重要：只看單調遞減的話，在基準附近正常波動也會
    // 隨機湊出 3 點連續下降（機率約 1/6），每天都亂報就沒人看了。
    const chron = [...points].reverse().map((p) => p.value);
    const monotonic = t.dir === 'higher'
      ? chron[0] > chron[1] && chron[1] > chron[2]
      : chron[0] < chron[1] && chron[1] < chron[2];
    const worsening = monotonic && deviating(sevs[0]);

    if (!sustainedLow && !worsening) continue;

    alerts.push({
      key,
      label: metric.label,
      types: [
        ...(sustainedLow ? ['sustained_low'] : []),
        ...(worsening ? ['worsening'] : []),
      ],
      // 顯示用：舊 → 新
      series: [...points].reverse().map((p) => ({
        date: p.date,
        value: p.value,
        display: metric.fmt(p.value),
      })),
      latestSeverity: sevs[0],
    });
  }

  const keys = new Set(alerts.map((a) => a.key));
  const pair = TREND.STRONG_PAIRS.find(([a, b]) => keys.has(a) && keys.has(b));
  const level = alerts.length === 0 ? 'none' : (pair ? 'strong' : 'mild');

  return { enabled: true, alerts, level, strongPair: pair ?? null };
}

// ---------------------------------------------------------------------------
// 6. 每週回顧統計
// ---------------------------------------------------------------------------

const WEEKLY_KEYS = ['recovery_score', 'sleep_performance', 'sleep_total', 'sleep_debt', 'hrv', 'rhr'];

/** 算某個時間區間的平均值 + 最好 / 最差的一天（依 Recovery）。 */
export function weeklyStats({ records, week }) {
  const inWeek = records.filter(
    (r) => r.date >= week.startDate && r.date <= week.endDate && r.sleep.score_state === 'SCORED',
  );

  const averages = {};
  for (const key of WEEKLY_KEYS) {
    const metric = METRIC_BY_KEY[key];
    const values = inWeek
      .map((r) => metricValueFromRecord(metric, r))
      .filter((v) => v !== null);
    averages[key] = values.length
      ? {
        mean: values.reduce((a, b) => a + b, 0) / values.length,
        n: values.length,
        display: metric.fmt(values.reduce((a, b) => a + b, 0) / values.length),
        label: metric.label,
      }
      : { mean: null, n: 0, display: null, label: metric.label };
  }

  const recoveryMetric = METRIC_BY_KEY.recovery_score;
  const scored = inWeek
    .map((r) => ({ date: r.date, value: metricValueFromRecord(recoveryMetric, r) }))
    .filter((x) => x.value !== null)
    .sort((a, b) => b.value - a.value);

  return {
    key: week.key,
    startDate: week.startDate,
    endDate: week.endDate,
    days: inWeek.length,
    averages,
    best: scored[0] ? { ...scored[0], display: recoveryMetric.fmt(scored[0].value) } : null,
    worst: scored.length > 1
      ? { ...scored[scored.length - 1], display: recoveryMetric.fmt(scored[scored.length - 1].value) }
      : null,
  };
}

/** 上週 vs 前週的變化（正數 = 上週比前週高）。 */
export function weekOverWeek(lastWeek, prevWeek) {
  const out = {};
  for (const key of WEEKLY_KEYS) {
    const a = lastWeek.averages[key]?.mean ?? null;
    const b = prevWeek.averages[key]?.mean ?? null;
    if (a === null || b === null) {
      out[key] = { delta: null, pct: null, direction: 'unknown' };
      continue;
    }
    const delta = a - b;
    const pct = b > 0 ? (delta / b) * 100 : null;
    out[key] = {
      delta,
      pct,
      direction: Math.abs(pct ?? 0) < 2 ? 'flat' : (delta > 0 ? 'up' : 'down'),
    };
  }
  return out;
}

export { metricValueFromRecord, WEEKLY_KEYS };
