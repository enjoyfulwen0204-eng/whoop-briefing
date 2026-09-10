/**
 * daily_metrics 的欄位名 ←→ capability probe 的 key（V1.1 Phase 11）。
 *
 * ## 為什麼需要這一張表
 *
 * 系統裡有**兩套並存的命名**，而且它們不完全一致：
 *
 *   capability key   來自 config.js 的 METRICS（`recovery_score`、`strain`、
 *                    `slow_wave`、`rem`…），那是「WHOOP 原始欄位」的語彙
 *   daily_metrics    分析層自己的欄位（`recovery`、`previous_day_strain`、
 *                    `deep_sleep`、`rem_sleep`…）
 *
 * 大部分名字剛好一樣（hrv、rhr、sleep_total…），少數不一樣。而「大部分
 * 一樣」正是最危險的地方：直接用欄位名去查 capability，八成的情況會對，
 * 剩下兩成安靜地查不到 → 拿到 undefined → 被當成「還沒 probe」。那不會
 * 報錯，只會讓 capability 閘門對那幾個指標永遠失效。
 *
 * config.js 的 METRIC_DIRECTION 已經因為同一個問題吃過虧（它得為
 * `recovery` 與 `previous_day_strain` 另外補兩個 alias，註解裡寫得很明白）。
 * 這次不重蹈覆轍：**明確列出來、集中一處、而且有測試**，絕不用猜的。
 *
 * ## 沒有對應項是合法的
 *
 * 有些 daily_metrics 欄位沒有單一對應的 probe key（例如
 * `workout_duration_minutes` 是從 workout 集合算出來的，不是某個欄位）。
 * 這種情況一律回 null = 「無法用 capability 判斷」，而**不是**「不支援」。
 */

import { STATUS } from './capabilities.js';

/**
 * daily_metrics 欄位 → capability probe key。
 *
 * 只列**真的有對應**的。名字剛好一樣的也明確寫出來，不靠「查不到就用
 * 原名」這種隱性 fallback——隱性 fallback 正是這類 bug 的溫床。
 */
export const FIELD_TO_CAPABILITY = Object.freeze({
  // ---- 名字不一樣的（就是這幾個會出事）----
  recovery: 'recovery_score',
  previous_day_strain: 'strain',
  deep_sleep: 'slow_wave',
  rem_sleep: 'rem',
  disturbances: 'disturbance_count',
  weight: 'body_weight',
  body_max_hr: 'body_max_heart_rate',

  // ---- 名字剛好一樣的（仍然明確列出）----
  hrv: 'hrv',
  rhr: 'rhr',
  respiratory_rate: 'respiratory_rate',
  sleep_total: 'sleep_total',
  sleep_performance: 'sleep_performance',
  sleep_consistency: 'sleep_consistency',
  sleep_efficiency: 'sleep_efficiency',
  sleep_debt: 'sleep_debt',
  spo2: 'spo2',
  skin_temp: 'skin_temp',
});

/**
 * healthspan contributor 的 key → capability probe key。
 *
 * contributor 又是第三套命名（`resting_heart_rate`、`sleep_duration`、
 * `hr_zone_1_3`…），所以也要明確對應。
 */
export const CONTRIBUTOR_TO_CAPABILITY = Object.freeze({
  sleep_duration: 'sleep_total',
  sleep_consistency: 'sleep_consistency',
  resting_heart_rate: 'rhr',
  hrv: 'hrv',
  recovery: 'recovery_score',
  respiratory_rate: 'respiratory_rate',
  strain: 'strain',
  weight: 'body_weight',
  max_heart_rate: 'body_max_heart_rate',
  spo2: 'spo2',
  skin_temp: 'skin_temp',
  hr_zone_1_3: 'workout_zone_durations',
  hr_zone_4_5: 'workout_zone_durations',

  // 這幾個沒有單一對應的 probe key —— 明確標成 null，不是漏寫。
  // workout_volume 由 workout 集合算出來、strength_activity 由 sport_name
  // 推導，兩者都不是「某個欄位有沒有值」能回答的。
  workout_volume: null,
  strength_activity: null,

  // APP_ONLY 的三個由 healthspan.js 自己處理（source === 'app_only'），
  // 不需要也不該經過 probe。
  steps: null,
  vo2_max: null,
  lean_body_mass: null,
});

/**
 * 查某個 daily_metrics 欄位的 capability 狀態。
 *
 * @param {string} field daily_metrics 的欄位名
 * @param {object} capabilities db.getCapabilities() 的輸出（以 key 為鍵）
 * @returns {?string} capability status，或 null =「無法判斷」
 *
 * ⚠️ 回 null **不等於** UNAVAILABLE。null 的意思是「這個欄位沒有對應的
 * probe，或還沒 probe 過」，一律交給樣本數邏輯去判斷（見 readiness.js
 * 的 capabilityGate）。
 */
export function capabilityStatusForField(field, capabilities = {}) {
  const key = FIELD_TO_CAPABILITY[field];
  if (!key) return null;
  return capabilities?.[key]?.status ?? null;
}

/** 同上，但吃 healthspan contributor 的 key。 */
export function capabilityStatusForContributor(contributorKey, capabilities = {}) {
  const key = CONTRIBUTOR_TO_CAPABILITY[contributorKey];
  if (!key) return null;
  return capabilities?.[key]?.status ?? null;
}

/**
 * 一次算出一組欄位的 capability 狀態，形狀直接餵給 detectSignals()。
 *
 * @returns {object} { [field]: status } —— 只放**查得到**的，
 *   查不到的欄位刻意不放進去（缺席 = null = 交給樣本數邏輯）。
 */
export function capabilityByMetricFor(fields = [], capabilities = {}) {
  const out = {};
  for (const f of fields) {
    const status = capabilityStatusForField(f, capabilities);
    if (status !== null) out[f] = status;
  }
  return out;
}

/**
 * capability 狀態對「主動分析訊息」的授權等級（R2-M-04）。
 *
 * ## 為什麼需要一套獨立的分級
 *
 * `isKnownUnavailable()` 回答的是「這個欄位是不是**已經證實**拿不到」，
 * 用來決定分析要不要跑。那個問題的正確答案讓 UNKNOWN / PARTIAL 通過 ——
 * 一個還沒 probe 過的正常帳號不該被整組關掉。
 *
 * 但「可不可以**主動發訊息打擾使用者**」是完全不同的問題，而且風險不對稱：
 * 分析結果錯了只是內部狀態；主動訊息錯了是直接對使用者說錯話。
 *
 * 獨立稽核確認的三個殘留缺口：
 *   getCapabilities 拋錯    → 仍然送出 ASK_CONTEXT
 *   capability = PARTIAL    → 仍然送出
 *   capability = UNKNOWN    → 仍然送出
 *
 * 所以這裡把狀態明確分級，而且**只有 AUTHORIZED 才授權主動訊息**：
 *
 *   AUTHORIZED   SUPPORTED —— 已經實際驗證過這個帳號拿得到這個欄位
 *   DEGRADED     PARTIAL —— 只有部分資料，不足以主動打擾
 *   UNVERIFIED   UNKNOWN / 沒 probe 過 / 認不出來的值
 *   UNAVAILABLE  UNAVAILABLE / UNAUTHORIZED / APP_ONLY
 *   UNREADABLE   查詢本身失敗（**絕不**默默代換成空物件）
 */
export const CAPABILITY_AUTHORIZATION = {
  AUTHORIZED: 'AUTHORIZED',
  DEGRADED: 'DEGRADED',
  UNVERIFIED: 'UNVERIFIED',
  UNAVAILABLE: 'UNAVAILABLE',
  UNREADABLE: 'UNREADABLE',
};

/** capability 狀態 → 授權等級。認不出來的值一律 UNVERIFIED（fail closed）。 */
export function normalizeCapabilityStatus(status) {
  if (status === CAPABILITY_AUTHORIZATION.UNREADABLE) return CAPABILITY_AUTHORIZATION.UNREADABLE;
  switch (status) {
    case STATUS.SUPPORTED:
      return CAPABILITY_AUTHORIZATION.AUTHORIZED;
    case STATUS.PARTIAL:
      return CAPABILITY_AUTHORIZATION.DEGRADED;
    case STATUS.UNAVAILABLE:
    case STATUS.UNAUTHORIZED:
    case STATUS.APP_ONLY:
      return CAPABILITY_AUTHORIZATION.UNAVAILABLE;
    case STATUS.UNKNOWN:
    case null:
    case undefined:
      return CAPABILITY_AUTHORIZATION.UNVERIFIED;
    default:
      return CAPABILITY_AUTHORIZATION.UNVERIFIED;
  }
}

/**
 * 這個 capability 狀態可以授權主動分析訊息嗎。
 *
 * **只有 SUPPORTED。** 其他一律不行 —— 包含「還沒 probe 過」。
 * 這是刻意的取捨：主動打擾必須建立在**已經驗證**的資料能力上。
 * 運維動作是跑一次 `npm run probe`。
 */
export function authorizesProactiveMessaging(status) {
  return normalizeCapabilityStatus(status) === CAPABILITY_AUTHORIZATION.AUTHORIZED;
}

/**
 * 這個狀態算不算「已經證實拿不到」。
 *
 * 只有這三種才算——與 readiness.capabilityGate() 完全同一套判準。
 * UNKNOWN / undefined / SUPPORTED / PARTIAL 一律**不算**。
 *
 * ⚠️ 這支函式回答的是「分析要不要跑」，**不是**「可不可以發訊息」。
 * 後者請用 authorizesProactiveMessaging()。
 */
export function isKnownUnavailable(status) {
  return status === STATUS.APP_ONLY
    || status === STATUS.UNAVAILABLE
    || status === STATUS.UNAUTHORIZED;
}
