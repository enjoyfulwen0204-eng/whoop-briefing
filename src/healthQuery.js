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
import { labelForCategory } from './journal.js';
import { loadDailyMetrics, seriesOf, RECOVERY_DERIVED_METRICS } from './dailyMetrics.js';
import { requireUserId } from './userContext.js';
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

/**
 * 事件與「今天那組睡眠期間量測」的先後關係。
 *
 * 只有在兩邊時間都可信時才回 after／before；其餘一律 'unknown'，
 * 讓呈現層用保守措辭，而不是編造一個確定的先後。
 *
 * ⚠️ 絕不拿同步時間當生理量測時間 —— 那是資料進到我們這裡的時間，
 * 不是身體被量到的時間。
 */
export function temporalRelation(sleepEndIso, event) {
  if (!sleepEndIso || !event?.event_at) return 'unknown';
  // 只有日期、沒有時間的紀錄（或解析時就只知道日期）不足以判斷先後。
  const precision = event.time_precision ?? null;
  if (precision === 'date' || precision === 'unknown') return 'unknown';
  const endMs = Date.parse(sleepEndIso);
  const evMs = Date.parse(event.event_at);
  if (!Number.isFinite(endMs) || !Number.isFinite(evMs)) return 'unknown';
  return evMs > endMs ? 'after' : 'before';
}

/** 疲勞類問題真正相關的指標（不是全部欄位都倒出來）。 */
export const READINESS_METRICS = ['sleep_total', 'recovery', 'hrv', 'rhr'];

/**
 * 允許被當成「可能因素」的類別。
 *
 * 白名單制：只有明確支援、而且與體感有合理關聯的類別才會被提出來。
 * 未知／自訂／內部鍵一律排除（fail closed），也絕不印原始鍵。
 */
const CONTRIBUTOR_CATEGORIES = new Set([
  'alcohol', 'late_sleep', 'stress', 'sickness', 'medication',
  'late_meal', 'exercise_note', 'caffeine',
]);
const fmtOf = (m, v) => {
  const f = INSIGHT_LABELS[m]?.fmt;
  return f && v !== null && v !== undefined ? f(v) : v;
};

const NO_DATA = (reason = 'no_health_data') => ({ available: false, reason });

/**
 * 「為什麼給不出東西」的具體原因。
 *
 * 以前全部擠在一個 metric_unavailable，而呼叫端把它一律講成
 * 「等 WHOOP 同步之後就能分析了」—— 那句話在絕大多數情況下是**錯的**：
 * 實測那天 recovery / HRV / RHR 早在 12:32 就同步進資料庫了，使用者 17:05
 * 問的時候卻被告知要等同步。
 *
 * 沒有證據顯示同步是問題時，就不可以把責任推給同步。
 */
export const UNAVAILABLE_REASON = Object.freeze({
  /** 這個帳號在查詢窗內完全沒有健康資料 */
  NO_DATA: 'no_health_data',
  /** 認得這個指標，但這段期間沒有任何一筆紀錄 */
  NO_METRIC_RECORDS: 'no_metric_records',
  /** 不認得這個指標名 */
  UNKNOWN_METRIC: 'unknown_metric',
  /** 這個系統的資料來源本來就取不到（例如即時心率） */
  UNSUPPORTED_CAPABILITY: 'unsupported_capability',
  /** 有當下的值，但樣本太少，下不了統計結論 */
  INSUFFICIENT_HISTORY: 'insufficient_history',
  /** 有當下的值，但還在 WHOOP 校正期，不進統計 */
  CALIBRATING: 'calibrating',
});

/**
 * 當下有值、但統計結論給不出來時，說明是**哪一種**給不出來。
 *
 * 刻意不含「等同步」：那要有實際證據才能講。
 */
function analysisLimitFor({ row, key, seriesLength }) {
  if (seriesLength >= ANALYTICS.MIN_SAMPLES) return null;
  if (row?.calibrating === true && RECOVERY_DERIVED_METRICS.has(key)) {
    return UNAVAILABLE_REASON.CALIBRATING;
  }
  return UNAVAILABLE_REASON.INSUFFICIENT_HISTORY;
}

/**
 * 建立查詢服務。
 * rows 是 lazy 載入的：同一次對話多個查詢共用同一份，不重複打 DB。
 */
/**
 * @param {string} userId **必填**。這個 query 只看得到這個使用者的資料。
 * @param {string} timezone 該使用者的時區。
 */
export function createHealthQuery({
  db, userId, timezone, now = new Date(), lookbackDays = 120,
}) {
  const uid = requireUserId(userId, 'createHealthQuery');
  let rowsPromise = null;

  function loadRows() {
    if (!rowsPromise) {
      const to = localDate(now, timezone);
      const from = addDays(to, -lookbackDays);
      rowsPromise = loadDailyMetrics({
        db, userId: uid, timezone, from, to,
        // Q&A must distinguish a factual current observation from whether that
        // observation is eligible for statistical interpretation.
        includeCalibratingFacts: true,
      }).catch((err) => {
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
  /**
   * 這個人的**分析成熟度**：現在的判斷能到什麼程度？
   *
   * 回的是結構化狀態，不是診斷報表。呼叫端據此用人話解釋「為什麼我還不能
   * 下定論」，而不是把資料庫的筆數倒給使用者看。
   */
  async function readinessState({ metrics = READINESS_METRICS } = {}) {
    const rows = await loadRows();
    const today = rows[0] ?? null;
    const anchor = today?.health_date ?? null;

    /**
     * ★ 成熟度是**逐指標**的，不能用「最大值」代表全部。
     *
     * 舊版拿 Math.max(...eligible)：睡眠有 1 天就說「有 1 天可以比較」，
     * 而 Recovery / HRV / RHR 其實是 0 天。睡眠準備好**不代表**恢復準備好。
     *
     * 而且算的是**先前的**合格樣本（不含今天）—— 因為比較的對象是基準，
     * 今天那一筆是被比較的那一個，不能同時當成基準的一部分。
     */
    const per = {};
    for (const key of metrics) {
      const series = seriesOf(rows, key);
      const prior = anchor ? series.filter((p) => p.date !== anchor) : series;
      per[key] = {
        eligible_total: series.length,
        eligible_prior: prior.length,
        has_current: Number.isFinite(today?.[key] ?? null),
        ready: prior.length >= ANALYTICS.MIN_SAMPLES,
      };
    }
    const readyMetrics = metrics.filter((m) => per[m].ready);
    const notReady = metrics.filter((m) => !per[m].ready && per[m].has_current);
    return {
      health_date: anchor,
      history_days: rows.length,
      per_metric: per,
      ready_metrics: readyMetrics,
      not_ready_metrics: notReady,
      /** 全部相關指標都有基準才算「準備好」。一個指標合格不能代表全部。 */
      all_ready: metrics.length > 0 && readyMetrics.length === metrics.length,
      any_ready: readyMetrics.length > 0,
      min_samples_needed: ANALYTICS.MIN_SAMPLES,
      calibrating: today?.calibrating === true,
      has_today_facts: metrics.some((m) => per[m].has_current),
    };
  }

  /**
   * 「WHOOP 有同步成功嗎」—— 簡潔的同步狀態（不是完整診斷）。
   *
   * ## 同步狀態 ≠ 分析成熟度 ≠ 完整診斷
   *
   * 這三件事以前糊在一起：問同步會得到基準不足的說法，或是一整塊 capability
   * probe。它們的答案來源完全不同 ——
   * 同步狀態要看 whoop_sync_state 的最後成功／失敗時間，不是看樣本數。
   *
   * 只用**既有的持久化證據**，不會為了回答這一題去打 WHOOP。
   */
  async function syncStatus() {
    const states = typeof db.getAllSyncState === 'function'
      ? (await db.getAllSyncState(uid).catch(() => [])) ?? [] : [];
    const rows = await loadRows();
    const today = rows[0] ?? null;

    const resources = states.map((r) => ({
      resource: String(r.resource),
      last_success_at: r.last_success_at ?? null,
      last_error: r.last_error ?? null,
      last_error_at: r.last_error_at ?? null,
    }));
    const successes = resources.map((r) => r.last_success_at).filter(Boolean).sort();
    const lastSuccess = successes.length ? successes[successes.length - 1] : null;
    const failing = resources.filter((r) => r.last_error);

    let verdict;
    if (!resources.length) verdict = 'never_synced';       // 從來沒跑過同步
    else if (failing.length && !lastSuccess) verdict = 'failing';
    else if (failing.length) verdict = 'partial';          // 有成功過，但有資源出錯
    else if (lastSuccess) verdict = 'ok';
    else verdict = 'unknown';                              // 有狀態列但沒有時間 → 不確定

    return {
      available: true,
      intent: 'sync_status',
      verdict,
      last_success_at: lastSuccess,
      failing_resources: failing.map((r) => r.resource),
      /** 最新一筆健康資料的日期（「資料有沒有進來」的直接證據）。 */
      latest_health_date: today?.health_date ?? null,
      now: new Date(now).toISOString(),
    };
  }

  /** 「因為數據不夠嗎」—— 對話式的成熟度說明（不是系統診斷）。 */
  async function readinessExplanation() {
    const r = await readinessState();
    return { available: true, intent: 'readiness_query', ...r };
  }

  // -------------------------------------------------------------------------
  /**
   * 「為什麼我那麼累？」—— 主觀症狀的原因。
   *
   * ## 這裡最重要的一條規則
   *
   * **「我們沒偵測到偏離」不等於「你沒事」。** 使用者說他很累，那本身就是
   * 一個事實；系統看不出異常只代表系統看不出來，不代表他不累。以前這類問題
   * 被分到 what_changed，於是回了「今天沒有特別值得注意的變化」——
   * 等於否定了使用者的感受。
   *
   * 所以這裡回的是結構化的「我知道什麼 / 我還不知道什麼」，讓呈現層可以
   * 誠實地分開講：觀察到的事實、能不能跟個人基準比、有哪些**可能**的因素、
   * 以及哪些是這份資料證明不了的。
   */
  async function causeExplanation({ symptom = 'fatigue', metric = null, justLogged = null } = {}) {
    const rows = await loadRows();
    if (!rows.length) {
      return {
        available: true, intent: 'cause_query', symptom, facts: [], contributors: [],
        ...(await readinessState({ metrics: metric ? [metric] : READINESS_METRICS })),
      };
    }
    const today = rows[0];
    const anchor = today.health_date;
    const relevantMetrics = metric ? [metric] : READINESS_METRICS;
    const readiness = await readinessState({ metrics: relevantMetrics });

    // 只挑**跟疲勞有關**的指標，不要把所有欄位倒出來。
    const relevant = metric
      ? [metric]
      : ['sleep_total', 'sleep_performance', 'recovery', 'hrv', 'rhr', 'previous_day_strain'];
    const facts = [];
    for (const key of relevant) {
      const value = today[key] ?? null;
      if (value === null) continue;
      const series = seriesOf(rows, key);
      const base = describeWindow(series, {
        endDate: anchor, days: ANALYTICS.DEFAULT_BASELINE_WINDOW, excludeEndDate: true,
      });
      const dev = base.sufficient ? evaluateDeviation(key, value, base) : { z_score: null, level: null, noteworthy: false };
      facts.push({
        key,
        label: labelOf(key),
        value,
        display: fmtOf(key, value),
        baseline_mean: base.sufficient ? base.mean : null,
        baseline_display: base.sufficient ? fmtOf(key, base.mean) : null,
        baseline_n: base.n,
        comparable: base.sufficient,
        z_score: dev.z_score,
        level: dev.level,
        noteworthy: Boolean(dev.noteworthy),
      });
    }

    // 當天（與前一天）已記錄的生活事件 —— 可能的因素，不是證明。
    let journal = [];
    if (typeof db.getJournalEvents === 'function') {
      try {
        journal = await db.getJournalEvents(uid, {
          from: addDays(anchor, -1), to: anchor, limit: 20,
        }) ?? [];
      } catch { journal = []; }
    }
    /**
     * 可能的因素 —— 保守挑選。
     *
     * · 只收白名單類別（未知／自訂一律排除，也不會洩漏原始鍵）
     * · 同一類別只留一筆（重複出現不代表證據更強）
     * · 時序關係只有在**兩邊時間都可信**時才敢下判斷
     */
    const seenCategory = new Set();
    const contributors = [];
    for (const e of journal) {
      const category = String(e.category ?? '');
      if (!CONTRIBUTOR_CATEGORIES.has(category)) continue;
      if (seenCategory.has(category)) continue;      // 去重：不因重複而放大信心
      seenCategory.add(category);
      // 剛剛這一輪才解析出來的那一筆，時間精確度是可信的（解析器明確認出
      // 「剛剛／現在」）。從 DB 讀回來的舊資料沒有這個欄位，一律 unknown。
      const fresh = justLogged && justLogged.category === category ? justLogged : null;
      contributors.push({
        category,
        label: labelForCategory(category),
        health_date: e.health_date ?? null,
        event_at: e.event_at ?? null,
        /**
         * ★ 時序：這件事發生在「今天這組測量」之後嗎？
         *
         * Recovery / HRV / RHR 是睡眠期間量到的。剛剛才喝的酒不可能影響
         * 那組數字 —— 拿它來證明因果在時序上就不可能。
         *
         * 但這個判斷只有在**兩邊的時間都可信**時才成立：
         *   · 需要 sleep_end（量測結束時間）
         *   · 需要事件時間，而且那個時間不是我們自己編出來的
         * 任何一邊不確定 → 'unknown'，話就要說得保守。
         */
        temporal: temporalRelation(today.sleep_end ?? null, {
          ...e, time_precision: fresh?.timePrecision ?? e.time_precision ?? null,
        }),
      });
    }

    return {
      available: true,
      intent: 'cause_query',
      symptom,
      health_date: anchor,
      sleep_end: today.sleep_end ?? null,
      facts,
      contributors,
      ...readiness,
    };
  }

  // -------------------------------------------------------------------------
  /**
   * 「我現在心跳幾下？」—— 這個系統拿不到。
   *
   * WHOOP 的開發者 API 沒有即時心率串流。拿得到的心率只有：
   *   · recovery 的靜息心率（睡眠期間量到的）
   *   · 已完成 cycle 的平均／最高心率
   *   · 運動的心率
   *   · profile 的最大心率
   *
   * 全都不是「使用者此刻的心跳」。**絕不可以拿靜息心率頂替** —— 那會讓人
   * 以為系統知道他現在的心跳，而那個數字在他心跳很快的當下正好是最誤導的。
   *
   * 順帶把今天的靜息心率一起給出來（明確標示是靜息心率），因為問這句話的人
   * 通常想知道「跟平常比怎樣」，那是我們真的答得出來的部分。
   */
  async function currentHeartRate() {
    const rows = await loadRows();
    const today = rows[0] ?? null;
    const rhr = today?.rhr ?? null;
    return {
      available: false,
      reason: UNAVAILABLE_REASON.UNSUPPORTED_CAPABILITY,
      capability: 'current_heart_rate',
      metric: 'current_hr',
      label: '即時心率',
      health_date: today?.health_date ?? null,
      /** 可以一起提的、確定答得出來的替代事實（明確標示是什麼）。 */
      rhr_today: rhr,
      rhr_today_display: rhr === null ? null : fmtOf('rhr', rhr),
    };
  }

  // -------------------------------------------------------------------------
  /** 「最近 HRV 如何？」「最近 recovery 趨勢怎樣？」 */
  async function trendQuery({ metric, windowDays = 30 }) {
    const key = resolveMetric(metric);
    if (!key) return { available: false, reason: UNAVAILABLE_REASON.UNKNOWN_METRIC, metric };

    const rows = await loadRows();
    if (!rows.length) return NO_DATA();

    const anchor = rows[0].health_date;
    const series = seriesOf(rows, key);
    const current = rows[0][key] ?? null;

    // ★ 事實與分析分開。
    //
    // 序列是空的**不代表**今天沒有這個值：校正期的 recovery 衍生值刻意不進
    // 統計（seriesOf 會排除），但它今天確實被 WHOOP 算出來了。以前這裡直接
    // 回 metric_unavailable，於是「今天 HRV 多少」被回成「還沒有資料」。
    //
    // 只有**連當下的值都沒有**才是真的給不出來。
    if (!series.length && current === null) {
      return {
        available: false,
        reason: UNAVAILABLE_REASON.NO_METRIC_RECORDS,
        metric: key,
        label: labelOf(key),
      };
    }
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
      /**
       * 當下的值給得出來、但統計結論給不出來時的具體原因。
       * null 代表統計本身是成立的。
       */
      analysis_limited: analysisLimitFor({ row: rows[0], key, seriesLength: series.length }),
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
    currentHeartRate,
    causeExplanation,
    readinessExplanation,
    syncStatus,
    readinessState,
    trendQuery,
    sleepQuality,
    bestWorstDay,
    whatChanged,
    dayDetail,
    summary,
  };
}
