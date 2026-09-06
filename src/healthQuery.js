/**
 * 健康查詢服務（Phase M 的確定性核心）。
 *
 * ## 這一層的存在理由
 *
 * Telegram Q&A 的流程是：
 *
 *   訊息 → intent → **這裡（Node 算完所有數字）** → structured context → LLM 講人話
 *
 * LLM 拿到的永遠是「已經算好的結論」，不是 raw JSON、不是資料庫存取權。
 * 它不會、也不能自己算平均、算相關、挑最好的一天。
 *
 * ## 沒有資料時
 *
 * 每個 handler 都回 `{ available: false, reason: 'no_health_data' }`，
 * 由上層轉成「目前尚未有足夠 WHOOP 資料」。**絕不編造數字。**
 */

import { ANALYTICS } from './config.js';
import { addDays, localDate } from './time.js';
import { loadDailyMetrics, seriesOf } from './dailyMetrics.js';
import {
  describeWindow, summarise, evaluateDeviation, trendsFor,
  detectBaselineShift, whatChangedToday, seriesByMetric, ANALYSED_METRICS,
} from './analytics/index.js';
import { INSIGHT_LABELS } from './insights.js';
import { log } from './logger.js';

/** 使用者說得出口的名字 → daily_metrics 的欄位。 */
export const METRIC_ALIASES = {
  hrv: 'hrv', HRV: 'hrv', 心率變異: 'hrv',
  rhr: 'rhr', 靜息心率: 'rhr', resting_heart_rate: 'rhr', restinghr: 'rhr',
  recovery: 'recovery', 恢復: 'recovery', recovery_score: 'recovery',
  sleep: 'sleep_total', 睡眠: 'sleep_total', sleep_total: 'sleep_total',
  睡眠時長: 'sleep_total',
  deep: 'deep_sleep', 深睡: 'deep_sleep', deep_sleep: 'deep_sleep',
  rem: 'rem_sleep', rem_sleep: 'rem_sleep',
  strain: 'previous_day_strain', 負荷: 'previous_day_strain',
  previous_day_strain: 'previous_day_strain',
  respiratory_rate: 'respiratory_rate', 呼吸率: 'respiratory_rate',
  sleep_performance: 'sleep_performance', 睡眠表現: 'sleep_performance',
  sleep_efficiency: 'sleep_efficiency', 睡眠效率: 'sleep_efficiency',
  sleep_consistency: 'sleep_consistency', 睡眠一致性: 'sleep_consistency',
  sleep_debt: 'sleep_debt', 睡眠債: 'sleep_debt',
  spo2: 'spo2', 血氧: 'spo2',
  skin_temp: 'skin_temp', 皮膚溫度: 'skin_temp',
};

export function resolveMetric(name) {
  if (!name) return null;
  const k = String(name).trim();
  return METRIC_ALIASES[k] ?? METRIC_ALIASES[k.toLowerCase()] ?? null;
}

const labelOf = (m) => INSIGHT_LABELS[m]?.label ?? m;
const fmtOf = (m, v) => {
  const f = INSIGHT_LABELS[m]?.fmt;
  return f && v !== null && v !== undefined ? f(v) : v;
};

const NO_DATA = (reason = 'no_health_data') => ({ available: false, reason });

/**
 * 建立查詢服務。
 * rows 是 lazy 載入的：同一次對話多個查詢共用同一份，不重複打 DB。
 */
export function createHealthQuery({ db, timezone, now = new Date(), lookbackDays = 120 }) {
  let rowsPromise = null;

  function loadRows() {
    if (!rowsPromise) {
      const to = localDate(now, timezone);
      const from = addDays(to, -lookbackDays);
      rowsPromise = loadDailyMetrics({ db, timezone, from, to }).catch((err) => {
        log.warn('health_query_load_failed', {
          error: String(err?.message ?? err).slice(0, 200),
        });
        return [];
      });
    }
    return rowsPromise;
  }

  /** 最新一個真的有資料的健康日。 */
  async function latestDate() {
    const rows = await loadRows();
    return rows.length ? rows[0].health_date : null;
  }

  // -------------------------------------------------------------------------
  /** 「我今天狀態怎樣？」 */
  async function todayStatus() {
    const rows = await loadRows();
    if (!rows.length) return NO_DATA();
    const anchor = rows[0].health_date;
    const today = rows[0];
    const series = seriesByMetric(rows);

    const metrics = {};
    for (const key of ['recovery', 'hrv', 'rhr', 'sleep_total', 'sleep_performance', 'previous_day_strain']) {
      const baseline = describeWindow(series[key], {
        endDate: anchor, days: ANALYTICS.DEFAULT_BASELINE_WINDOW, excludeEndDate: true,
      });
      const dev = evaluateDeviation(key, today[key], baseline);
      metrics[key] = {
        label: labelOf(key),
        value: today[key],
        display: fmtOf(key, today[key]),
        baseline_mean: baseline.mean,
        baseline_display: fmtOf(key, baseline.mean),
        baseline_n: baseline.n,
        z_score: dev.z_score,
        level: dev.level,
        noteworthy: dev.noteworthy,
      };
    }

    return {
      available: true,
      intent: 'today_status',
      health_date: anchor,
      history_days: rows.length,
      metrics,
      what_changed: whatChangedToday(series, anchor),
      data_quality: {
        recovery_scored: today.recovery_scored,
        calibrating: today.calibrating,
        has_previous_cycle: today.has_previous_cycle,
      },
    };
  }

  // -------------------------------------------------------------------------
  /** 「最近 HRV 如何？」「最近 recovery 趨勢怎樣？」 */
  async function trendQuery({ metric, windowDays = 30 }) {
    const key = resolveMetric(metric);
    if (!key) return { available: false, reason: 'unknown_metric', metric };

    const rows = await loadRows();
    if (!rows.length) return NO_DATA();

    const anchor = rows[0].health_date;
    const series = seriesOf(rows, key);
    if (!series.length) return { available: false, reason: 'metric_unavailable', metric: key };

    const current = rows[0][key] ?? null;
    const windows = summarise(series, { endDate: anchor, current });
    const win = describeWindow(series, {
      endDate: anchor, days: windowDays, excludeEndDate: true,
    });

    return {
      available: true,
      intent: 'trend_query',
      metric: key,
      label: labelOf(key),
      health_date: anchor,
      current,
      current_display: fmtOf(key, current),
      requested_window_days: windowDays,
      window: {
        window_days: win.windowDays,
        n: win.n,
        sufficient: win.sufficient,
        mean: win.mean,
        mean_display: fmtOf(key, win.mean),
        median: win.median,
        stddev: win.stddev,
        min: win.min,
        max: win.max,
      },
      windows,
      trends: trendsFor(key, series, { endDate: anchor }),
      deviation: evaluateDeviation(key, current, describeWindow(series, {
        endDate: anchor, days: ANALYTICS.DEFAULT_BASELINE_WINDOW, excludeEndDate: true,
      })),
      baseline_shift: detectBaselineShift(key, series, { endDate: anchor }),
    };
  }

  // -------------------------------------------------------------------------
  /** 「最近睡眠有沒有變差？」 */
  async function sleepQuality({ windowDays = 30 } = {}) {
    const rows = await loadRows();
    if (!rows.length) return NO_DATA();
    const anchor = rows[0].health_date;

    const keys = [
      'sleep_total', 'sleep_performance', 'sleep_efficiency',
      'sleep_consistency', 'deep_sleep', 'rem_sleep', 'sleep_debt',
    ];
    const out = {};
    for (const key of keys) {
      const s = seriesOf(rows, key);
      if (!s.length) {
        out[key] = { label: labelOf(key), available: false };
        continue;
      }
      const win = describeWindow(s, { endDate: anchor, days: windowDays, excludeEndDate: true });
      out[key] = {
        label: labelOf(key),
        available: true,
        current: rows[0][key] ?? null,
        current_display: fmtOf(key, rows[0][key]),
        mean: win.mean,
        mean_display: fmtOf(key, win.mean),
        n: win.n,
        window_days: win.windowDays,
        trends: trendsFor(key, s, { endDate: anchor }),
      };
    }

    // 就寢時間（只有在真的有值時才給）
    const bedtimes = rows
      .filter((r) => r.bedtime_local)
      .slice(0, windowDays)
      .map((r) => ({ date: r.health_date, bedtime: r.bedtime_local }));

    return {
      available: true,
      intent: 'sleep_quality',
      health_date: anchor,
      window_days: windowDays,
      metrics: out,
      bedtime_samples: bedtimes.slice(0, 7),
      bedtime_n: bedtimes.length,
    };
  }

  // -------------------------------------------------------------------------
  /** 「最近 30 天最好是哪一天？」 */
  async function bestWorstDay({ metric = 'recovery', windowDays = 30 } = {}) {
    const key = resolveMetric(metric) ?? 'recovery';
    const rows = await loadRows();
    if (!rows.length) return NO_DATA();

    const anchor = rows[0].health_date;
    const start = addDays(anchor, -(windowDays - 1));
    const inWindow = rows
      .filter((r) => r.health_date >= start && r.health_date <= anchor)
      .filter((r) => r[key] !== null && r[key] !== undefined);

    if (!inWindow.length) return { available: false, reason: 'metric_unavailable', metric: key };

    const sorted = [...inWindow].sort((a, b) => b[key] - a[key]);
    const best = sorted[0];
    const worst = sorted[sorted.length - 1];

    // 附上那兩天的其他數字，讓 LLM 有東西可講（但仍然是算好的）
    const context = (r) => ({
      health_date: r.health_date,
      value: r[key],
      display: fmtOf(key, r[key]),
      sleep_total: r.sleep_total,
      sleep_total_display: fmtOf('sleep_total', r.sleep_total),
      hrv: r.hrv,
      rhr: r.rhr,
      previous_day_strain: r.previous_day_strain,
      bedtime_local: r.bedtime_local,
    });

    return {
      available: true,
      intent: 'best_worst_day',
      metric: key,
      label: labelOf(key),
      window_days: windowDays,
      n: inWindow.length,
      best: context(best),
      worst: sorted.length > 1 ? context(worst) : null,
    };
  }

  // -------------------------------------------------------------------------
  /** 「今天最值得注意的是什麼？」 */
  async function whatChanged() {
    const rows = await loadRows();
    if (!rows.length) return NO_DATA();
    const anchor = rows[0].health_date;
    const items = whatChangedToday(seriesByMetric(rows), anchor);
    return {
      available: true,
      intent: 'what_changed',
      health_date: anchor,
      history_days: rows.length,
      items: items.map((c) => ({
        ...c,
        label: labelOf(c.metric),
        current_display: fmtOf(c.metric, c.current),
      })),
    };
  }

  // -------------------------------------------------------------------------
  /** 某一天的完整數字（追問時用）。 */
  async function dayDetail({ healthDate }) {
    const rows = await loadRows();
    if (!rows.length) return NO_DATA();
    const row = rows.find((r) => r.health_date === healthDate);
    if (!row) return { available: false, reason: 'day_not_found', health_date: healthDate };
    return { available: true, intent: 'day_detail', health_date: healthDate, row };
  }

  /** 這一次對話已經載入的資料量（給上層判斷要不要做分析）。 */
  async function summary() {
    const rows = await loadRows();
    return {
      history_days: rows.length,
      latest: rows[0]?.health_date ?? null,
      earliest: rows[rows.length - 1]?.health_date ?? null,
      analysed_metrics: ANALYSED_METRICS,
    };
  }

  return {
    loadRows,
    latestDate,
    todayStatus,
    trendQuery,
    sleepQuality,
    bestWorstDay,
    whatChanged,
    dayDetail,
    summary,
  };
}
