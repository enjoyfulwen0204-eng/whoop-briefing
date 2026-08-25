/**
 * 所有數值判斷都在這裡（deterministic Node code）。
 * AI 教練只把這裡算好的結果講成人話，不參與任何好壞判斷。
 *
 * ## health_date（全系統的「哪一天」）
 *
 * `health_date` = 主睡眠 `sleep.end` 換算到當地時區的日期。**不是執行當下的日期。**
 * 顯示日期、baseline 排除、去重 key、report_runs 紀錄全部用同一個 health_date，
 * 所以晚起床（甚至跨午夜才跑到）也能正確補發，而且不會重複。
 *
 * 一個 health_date 只會有一筆 observation。WHOOP 同一天可能回多筆主睡眠
 * （分段睡、補眠），一律取 `sleep.end` **最晚**的那一筆當代表。
 */

import {
  BASELINE, METRICS, METRIC_BY_KEY, STRAIN, THRESHOLDS, TREND, WAKE, num,
} from './config.js';
import { addDays, localDate, minutesBetween } from './time.js';
import { log } from './logger.js';

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
    .filter((s) => {
      if (!s || !s.end) return false;
      // 刻意維持嚴格 === false：nap 不是布林代表這筆資料不完整，
      // 不去猜它是不是主睡眠，但要留下軌跡（只記 id 與型別，不寫整包 payload）。
      if (typeof s.nap !== 'boolean') {
        log.warn('sleep_nap_not_boolean', {
          sleep_id: s.id === undefined ? null : String(s.id),
          nap_type: typeof s.nap,
        });
        return false;
      }
      return s.nap === false;
    })
    .map((s) => ({
      sleepId: String(s.id),
      // date 與 healthDate 是同一個值（sleep.end 的當地日期）。
      // date 保留給既有呼叫端，healthDate 是之後一律該用的名字。
      date: localDate(s.end, timezone),
      healthDate: localDate(s.end, timezone),
      endUtc: new Date(s.end),
      sleep: s,
      recovery: recoveryBySleep.get(String(s.id)) ?? null,
    }))
    .sort((a, b) => b.endUtc - a.endUtc);
}

/**
 * 每個 health_date 一筆 observation（新→舊）。
 *
 * 同一個 health_date 有多筆主睡眠時取 `sleep.end` 最晚的那一筆 —— daily 觸發、
 * 趨勢、baseline、Strain 對應全部共用這個規則，所以不會出現「顯示用了 A 筆、
 * 趨勢用了 B 筆」而湊出假趨勢。
 */
export function buildObservations({ sleeps = [], recoveries = [], timezone }) {
  const byDate = new Map();
  for (const r of buildRecords({ sleeps, recoveries, timezone })) {
    const cur = byDate.get(r.healthDate);
    if (!cur || r.endUtc > cur.endUtc) byDate.set(r.healthDate, r);
  }
  return [...byDate.values()].sort((a, b) => b.endUtc - a.endUtc);
}

/** 這筆 observation 是否為「完整可用的健康日」（睡眠與恢復都可信）。 */
export function isValidHealthDay(obs) {
  if (!obs) return false;
  if (obs.sleep?.score_state !== 'SCORED') return false;
  if (!obs.recovery) return false;
  if (obs.recovery.score_state !== 'SCORED') return false;
  return !isCalibrating(obs);
}

/** 已完成(end 不為 null)且 SCORED 的 cycle，新→舊。 */
export function completedCycles(cycles = []) {
  return cycles
    .filter((c) => c && c.end && c.score_state === 'SCORED' && num(c?.score?.strain) !== null)
    .sort((a, b) => new Date(b.end) - new Date(a.end));
}

/**
 * 某個健康日的「昨日 Strain」對應到哪個 cycle。
 *
 * 規則：`sleep.end` **之前**最近一個已完成 SCORED cycle，且不能太舊
 * （`STRAIN.MAX_CYCLE_AGE_MS`，預設 48 小時）。
 *
 * 單向是重點：結束在起床「之後」的 cycle 是今天正在累積的負荷，不是昨天的。
 * 找不到就回 null（該日 Strain 視為無資料），**不會**退回去用睡眠之後的 cycle 補。
 *
 * 今日顯示值與歷史 baseline 都呼叫這一個函式，口徑完全相同。
 *
 * @param {object} obs        observation（要有 endUtc）
 * @param {object[]} cyclesDesc completedCycles() 的輸出（新→舊）
 */
export function yesterdayCycleFor(obs, cyclesDesc = []) {
  if (!obs?.endUtc) return null;
  const endMs = obs.endUtc.getTime();
  for (const c of cyclesDesc) {
    const cEnd = new Date(c.end).getTime();
    if (cEnd > endMs) continue;                          // 結束在起床之後 → 不是昨天的
    if (endMs - cEnd > STRAIN.MAX_CYCLE_AGE_MS) return null; // 再往前只會更舊
    return c;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 2. 起床觸發判斷
// ---------------------------------------------------------------------------

/**
 * 判斷「最新的健康日是否可以發簡報了」。
 *
 * 依序檢查最新一筆 observation（每個 health_date 已取 sleep.end 最晚那筆）：
 *   1. 有主睡眠
 *   2. sleep.score_state === 'SCORED'
 *   3. 有對應的 recovery（recovery.sleep_id === sleep.id）
 *   4. recovery.score_state === 'SCORED'
 *   5. nowUTC - sleep.end >= 30 分鐘（直接比 UTC，不碰時區）
 *   6. nowUTC - sleep.end <= 24 小時（超過就不補發了）
 *
 * 刻意**不再**檢查「睡眠結束日 === 執行當天」—— 那條讓下午才起床、或跨午夜才
 * 跑到的那天永久收不到簡報。防止舊資料重報改由兩件事負責：health_date 去重
 * （呼叫端查 DB）+ 第 6 條的 24 小時期限。
 */
export function detectWake({ observations, now, timezone }) {
  const latest = observations?.[0];

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
  if (minutes > WAKE.MAX_AGE_HOURS * 60) {
    return {
      ready: false,
      reason: 'sleep_too_old',
      healthDate: latest.healthDate,
      hoursSinceWake: Math.round(minutes / 60),
      record: latest,
    };
  }
  return {
    ready: true,
    record: latest,
    healthDate: latest.healthDate,
    minutesSinceWake: Math.round(minutes),
    // 保留舊欄位名給呼叫端過渡用；值就是 health_date
    localDate: latest.healthDate,
    timezone,
  };
}

// ---------------------------------------------------------------------------
// 3. Baseline
// ---------------------------------------------------------------------------

/**
 * 可進 baseline 的紀錄：
 *  - 排除「本次要報告的那個 health_date」（不然當天數值會把基準往自己拉）
 *  - 排除被評估的那一筆 sleep
 *  - 睡眠必須 SCORED、必須是主睡眠（buildRecords 已過濾 nap）
 *  - recovery 若是 user_calibrating===true 則該筆的 recovery 指標不採用
 *    （在 metricValueFromRecord 處理）
 */
export function baselineRecords({ records, healthDate, excludeSleepId }) {
  return records.filter((r) => {
    if (r.healthDate === healthDate) return false;
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

/** 這筆紀錄的 recovery 是否處於 WHOOP 校正期。 */
export function isCalibrating(record) {
  return record?.recovery?.score?.user_calibrating === true;
}

/**
 * 從每日紀錄取出某個指標的值。
 *
 * allowCalibrating 的用意：校正期的 recovery 數字不可信，**不能進 baseline / 趨勢 /
 * 週平均**（預設 false 就是排除）。但「今天的數值」還是該顯示出來給人看，
 * 只是不給紅黃燈 —— 那條路徑會傳 allowCalibrating: true。
 */
function metricValueFromRecord(metric, record, { allowCalibrating = false } = {}) {
  if (metric.source === 'sleep') return metric.get(record.sleep);
  if (metric.source === 'recovery') {
    if (!record.recovery) return null;
    if (record.recovery.score_state !== 'SCORED') return null;
    if (!allowCalibrating && isCalibrating(record)) return null; // 排除校正期
    return metric.get(record.recovery);
  }
  return null;
}

/**
 * 每個指標各自取「最近 N 筆有效（非 null）」算平均。
 * 回傳 { [key]: { mean, n, samples } }
 */
export function computeBaselines({ records, cycles = [], target = BASELINE.TARGET_SAMPLES }) {
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

  // strain 的基準：對每一筆 baseline observation 用「跟今日顯示值完全相同」的
  // mapping（yesterdayCycleFor）找出該健康日的昨日 Strain。
  // 找不到就跳過那天 —— 不退回用睡眠之後的 cycle 補。
  // records 本身已排除本次報告的 health_date，所以不會混進今天。
  const strainMetric = METRIC_BY_KEY.strain;
  const strainSamples = [];
  for (const r of records) {
    if (strainSamples.length >= target) break;
    const c = yesterdayCycleFor(r, cycles);
    const v = c ? strainMetric.get(c) : null;
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
 * 判斷完全由這裡決定，AI 教練不得改動。
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
  // 校正期：數值照顯示（allowCalibrating），但不給燈 —— 跟 cold stage 同樣的原則
  const calibrating = metric.source === 'recovery' && isCalibrating(record);
  const value = metric.source === 'cycle'
    ? metric.get(cycle)
    : metricValueFromRecord(metric, record, { allowCalibrating: true });

  const base = baselines[metric.key] ?? { mean: null, n: 0 };
  const enoughSamples = base.n >= BASELINE.MIN_PER_METRIC;
  const lightsAllowed = stage !== 'cold' && enoughSamples && !calibrating;

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
    calibrating,
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
 * 從 anchorDate 往回取 TREND.WINDOW 個「逐日相鄰」的健康日資料點（新→舊）。
 *
 * 任何一項不成立就**立即中斷**（回 null，不是跳過那天再往前湊）：
 *  - 該 health_date 沒有 observation（沒戴錶 / 沒同步）
 *  - 該日不是完整健康日（睡眠或恢復未 SCORED、或 recovery 在校正期）
 *  - 該指標當天取不到值（null）
 *
 * 所有指標共用這一套規則，A 持續偏低與 B 持續惡化也共用同一組資料點。
 * 註：cycle 來源的指標在這裡一律取不到值（會中斷），目前 TREND.METRICS 沒有
 * cycle 來源的指標；未來若加入，需要先給它自己的 observation mapping。
 */
function streakFor({ metric, byDate, anchorDate }) {
  const points = [];
  let date = anchorDate;
  while (points.length < TREND.WINDOW) {
    const obs = byDate.get(date);
    if (!isValidHealthDay(obs)) return null;
    const v = metricValueFromRecord(metric, obs);
    if (v === null) return null;
    points.push({ date, value: v });
    date = addDays(date, -1);
  }
  return points; // 新→舊
}

/**
 * A 持續偏低：連續 3 個相鄰健康日都超出門檻（severity 為黃或紅）。
 * B 持續惡化：連續 3 個相鄰健康日逐日變差，而且最新那天已超出門檻。
 *
 * 「連續」是嚴格的日曆連續 —— 中間缺一天就中斷，不會跳過缺日去湊 3 筆。
 * 只在 stage === 'full'（>=30 筆正式 baseline）才啟用。
 * 兩個以上生理訊號同時異常 → level = 'strong'。
 */
export function detectTrends({ observations = [], baselines, stage, anchorDate = null }) {
  if (stage !== TREND.MIN_STAGE) return { enabled: false, alerts: [], level: 'none' };

  const byDate = new Map(observations.map((o) => [o.healthDate, o]));
  const anchor = anchorDate ?? observations[0]?.healthDate ?? null;
  if (!anchor) return { enabled: true, alerts: [], level: 'none' };

  const alerts = [];

  for (const key of TREND.METRICS) {
    const metric = METRIC_BY_KEY[key];
    if (!metric) continue;
    const t = THRESHOLDS[key];
    if (!t || t.dir === 'none') continue;

    const base = baselines[key];
    if (!base || base.mean === null || base.n < BASELINE.MIN_PER_METRIC) continue;

    const points = streakFor({ metric, byDate, anchorDate: anchor });
    if (!points) continue;

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
