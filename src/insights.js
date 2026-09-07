/**
 * 把分析層接到簡報上的薄薄一層。
 *
 * ## 唯一鐵律
 *
 * 這裡的任何失敗都**不可以**讓 Daily Brief 消失。呼叫端一律用 try/catch
 * 包起來，失敗就當作沒有 insights，簡報照舊發送。
 * 資料庫剛部署還沒 backfill 完時，rows 會是空的 —— 那也只是「沒有這一段」，
 * 不是錯誤。
 */

import { addDays } from './time.js';
import { requireUserId } from './userContext.js';
import { loadDailyMetrics } from './dailyMetrics.js';
import { seriesByMetric, whatChangedToday } from './analytics/index.js';
import { log } from './logger.js';

/** daily_metrics 的欄位名 → 簡報上的中文標籤與格式。 */
export const INSIGHT_LABELS = {
  recovery: { label: '恢復', fmt: (v) => `${Math.round(v)}%`, emoji: '💪' },
  hrv: { label: 'HRV', fmt: (v) => `${Math.round(v)}ms`, emoji: '❤️' },
  rhr: { label: '靜息心率', fmt: (v) => `${Math.round(v)}bpm`, emoji: '💓' },
  respiratory_rate: { label: '呼吸率', fmt: (v) => v.toFixed(1), emoji: '🫁' },
  sleep_total: { label: '睡眠', fmt: fmtDur, emoji: '🌙' },
  deep_sleep: { label: '深睡', fmt: fmtDur, emoji: '😴' },
  rem_sleep: { label: 'REM', fmt: fmtDur, emoji: '🧠' },
  sleep_performance: { label: '睡眠表現', fmt: (v) => `${Math.round(v)}%`, emoji: '📈' },
  sleep_efficiency: { label: '睡眠效率', fmt: (v) => `${Math.round(v)}%`, emoji: '⚙️' },
  sleep_consistency: { label: '睡眠一致性', fmt: (v) => `${Math.round(v)}%`, emoji: '🔁' },
  sleep_debt: { label: '睡眠債加成', fmt: (v) => `+${Math.round(v / 60000)}m`, emoji: '⏳' },
  previous_day_strain: { label: '昨日 Strain', fmt: (v) => v.toFixed(1), emoji: '🔥' },
  spo2: { label: '血氧', fmt: (v) => `${v.toFixed(1)}%`, emoji: '🩸' },
  skin_temp: { label: '皮膚溫度', fmt: (v) => `${v.toFixed(1)}°C`, emoji: '🌡️' },
};

function fmtDur(ms) {
  const total = Math.round(ms / 60000);
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h > 0 ? `${h}h${String(m).padStart(2, '0')}m` : `${m}m`;
}

/** 分析要往回看幾天（90 天窗口 + 一點緩衝）。 */
export const INSIGHT_LOOKBACK_DAYS = 95;

/**
 * 算出這個 health_date 的 insights。
 *
 * @returns {Promise<?object>} 沒有足夠資料時回 null（不是錯誤）
 */
const REQUIRED_DB_METHODS = [
  'getSleeps', 'getRecoveries', 'getCycles', 'getWorkouts', 'getLatestBodyMeasurement',
];

/** @param {string} userId **必填**。 */
export async function buildInsights({ db, userId, timezone, healthDate }) {
  const uid = requireUserId(userId, 'buildInsights');
  // 全部都要在才動手。少一個就當作「還沒有健康資料層」直接跳過 ——
  // 若在建 promise 陣列的中途才丟 TypeError，先前已經建立的 promise
  // 會變成沒人接的 rejection（Node 22 會直接殺掉 process）。
  if (REQUIRED_DB_METHODS.some((m) => typeof db?.[m] !== 'function')) return null;

  const from = addDays(healthDate, -INSIGHT_LOOKBACK_DAYS);
  const rows = await loadDailyMetrics({ db, userId: uid, timezone, from, to: healthDate });
  if (!rows.length) return null;

  const series = seriesByMetric(rows);
  const whatChanged = whatChangedToday(series, healthDate);

  log.info('insights_built', {
    user_id: uid,
    health_date: healthDate,
    history_days: rows.length,
    what_changed: whatChanged.length,
  });

  return {
    healthDate,
    historyDays: rows.length,
    whatChanged,
  };
}

/**
 * 安全版：任何失敗都回 null 並只寫 log。
 * 這是 daily.js 實際呼叫的入口。
 */
export async function buildInsightsSafe({ db, userId, timezone, healthDate }) {
  try {
    return await buildInsights({ db, userId, timezone, healthDate });
  } catch (err) {
    log.warn('insights_failed_ignored', {
      health_date: healthDate,
      error: String(err?.message ?? err).slice(0, 200),
    });
    return null;
  }
}
