/**
 * 「WHOOP 有同步成功嗎？」的真相判定。
 *
 * ## 為什麼不能只看「有沒有成功過」
 *
 * 上一版的判定是：任何一個資源有 last_success_at、而且沒有 last_error
 * → verdict `ok` → 回「有，最後一次成功同步是……」。
 *
 * 獨立稽核指出那句話幾乎沒有資訊量。實際可能的情況是：
 *
 *   · sleep 在三週前成功過一次
 *   · recovery / cycle / workout / body_measurement 連狀態列都沒有
 *   · 沒有任何錯誤列（因為根本沒跑過）
 *
 * 系統卻宣稱同步成功。使用者會據此相信資料是完整且新的，而它兩者都不是。
 *
 * ## 這個模組回答的是三個分開的問題
 *
 *   1. **覆蓋率** —— 預期的資源裡，有多少真的成功過？
 *   2. **最新一次嘗試** —— 最近一次是成功還是失敗？
 *   3. **新鮮度** —— 成功是多久以前？資料本身有沒有跟著變新？
 *
 * 三個問題的答案不同，使用者該聽到的話就不同。把它們壓成一個 ok/not-ok
 * 必然會在某些情況下說謊。
 *
 * ## 預期資源的唯一來源
 *
 * `WHOOP_SYNC.RESOURCES`（config.js）。這裡**不另外定義一份清單** ——
 * 兩份清單遲早會分岔，而分岔的那一天沒有人會發現。
 */

import { WHOOP_SYNC } from './config.js';
import { STATUS } from './capabilities.js';

/** 結構化判定。使用者看到的句子由呈現層決定，不是這裡。 */
export const SYNC_VERDICT = Object.freeze({
  /** 完全沒有同步狀態 —— 從來沒跑過。 */
  NEVER_SYNCED: 'never_synced',
  /** 每個預期資源最近一次都成功，而且夠新。 */
  LATEST_SUCCESS_COMPLETE: 'latest_success_complete',
  /** 有成功，但沒有涵蓋所有預期資源。 */
  LATEST_SUCCESS_PARTIAL: 'latest_success_partial',
  /** 最近一次嘗試失敗，而且沒有任何成功紀錄。 */
  LATEST_FAILED: 'latest_failed',
  /** 以前成功過，但最近一次有資源失敗。 */
  HISTORICAL_SUCCESS_LATEST_FAILED: 'historical_success_but_latest_failed',
  /** 全部成功過，但已經太久沒更新。 */
  STALE_SUCCESS: 'stale_success',
  /** 有狀態列但證據不足以下判斷（時間戳無效、狀態自相矛盾…）。 */
  INCOMPLETE_EVIDENCE: 'incomplete_evidence',
});

/** 超過這個時間沒有成功同步就算「舊」。WHOOP 一天至少會有一次新資料。 */
export const STALE_AFTER_MS = 36 * 3600_000;

/** capability 明確表示「這個帳號拿不到」的狀態 —— 不該算進預期涵蓋範圍。 */
const EXCLUDING_STATUSES = new Set([
  STATUS.UNAUTHORIZED, STATUS.UNAVAILABLE, STATUS.APP_ONLY,
]);

const isIsoish = (v) => typeof v === 'string' && !Number.isNaN(Date.parse(v));

/**
 * 一列 sync_state（原始 row 或 camelCase 皆可）→ 正規化的證據。
 *
 * `getAllSyncState()` 回的是原始 row（snake_case），`getSyncState()` 回
 * camelCase。兩種都吃，因為呼叫端不該為了這個差異而知道儲存層細節。
 */
function normalizeState(row, nowMs) {
  const resource = String(row.resource ?? '');
  const successRaw = row.last_success_at ?? row.lastSuccessAt ?? null;
  const errorAtRaw = row.last_error_at ?? row.lastErrorAt ?? null;
  const error = row.last_error ?? row.lastError ?? null;

  // 未來的時間戳是壞資料，不是「非常新」。當成無效。
  const successValid = isIsoish(successRaw) && Date.parse(successRaw) <= nowMs;
  const errorValid = isIsoish(errorAtRaw) && Date.parse(errorAtRaw) <= nowMs;
  const invalidTimestamp = (successRaw !== null && !successValid)
    || (errorAtRaw !== null && !errorValid);

  const successMs = successValid ? Date.parse(successRaw) : null;
  const errorMs = errorValid ? Date.parse(errorAtRaw) : null;

  // 「最近一次嘗試」是哪一種？有錯誤而且錯誤比成功新 → 最近一次失敗。
  // 有錯誤字串但沒有時間 → 無法排序，當成證據不足（不是成功）。
  let latest;
  if (error && errorMs === null) latest = 'unknown';
  else if (errorMs !== null && (successMs === null || errorMs > successMs)) latest = 'failed';
  else if (successMs !== null) latest = 'success';
  else latest = 'unknown';

  return {
    resource,
    last_success_at: successValid ? successRaw : null,
    last_error: error ?? null,
    last_error_at: errorValid ? errorAtRaw : null,
    has_historical_success: successMs !== null,
    latest,
    invalid_timestamp: invalidTimestamp,
    success_ms: successMs,
  };
}

/**
 * 算出這個使用者的同步真相。
 *
 * @param {object[]} states       db.getAllSyncState() 的結果
 * @param {object}   capabilities key → {status}（可省略）
 * @param {Date|number} now
 * @param {?string} latestHealthDate 目前手上最新的健康資料日期（新鮮度的第二證據）
 */
export function assessSync({
  states = [], capabilities = null, now = new Date(), latestHealthDate = null,
} = {}) {
  const nowMs = now instanceof Date ? now.getTime() : Number(now);

  // --- 預期資源：canonical 清單扣掉 capability 明確說拿不到的 ---
  const excluded = [];
  const expected = WHOOP_SYNC.RESOURCES.filter((r) => {
    const status = capabilities?.[r]?.status ?? null;
    if (status && EXCLUDING_STATUSES.has(status)) { excluded.push(r); return false; }
    return true;
  });
  /** capability 還沒 probe 過的資源 —— 「預期」本身就不確定。 */
  const unknownCapability = expected.filter((r) => (capabilities?.[r]?.status ?? null) === STATUS.UNKNOWN);

  // --- 每個資源的證據（同一資源出現多列時取最新的成功）---
  const byResource = new Map();
  for (const row of states ?? []) {
    const s = normalizeState(row, nowMs);
    if (!s.resource) continue;
    const prev = byResource.get(s.resource);
    if (!prev || (s.success_ms ?? -1) > (prev.success_ms ?? -1)) byResource.set(s.resource, s);
  }
  const observed = [...byResource.values()];

  const expectedStates = expected.map((r) => byResource.get(r) ?? null);
  const missing = expected.filter((r) => !byResource.has(r));
  const succeededLatest = expected.filter((r) => byResource.get(r)?.latest === 'success');
  const failedLatest = expected.filter((r) => byResource.get(r)?.latest === 'failed');
  const unknownLatest = expected.filter((r) => byResource.get(r)?.latest === 'unknown');
  const everSucceeded = expected.filter((r) => byResource.get(r)?.has_historical_success);
  const invalidTimestamps = observed.filter((s) => s.invalid_timestamp).map((s) => s.resource);

  const successTimes = expectedStates.map((s) => s?.success_ms ?? null).filter((v) => v !== null);
  const lastSuccessMs = successTimes.length ? Math.max(...successTimes) : null;
  const oldestSuccessMs = successTimes.length && successTimes.length === expected.length
    ? Math.min(...successTimes) : null;
  const ageMs = lastSuccessMs === null ? null : nowMs - lastSuccessMs;
  const stale = oldestSuccessMs !== null && (nowMs - oldestSuccessMs) > STALE_AFTER_MS;

  const complete = expected.length > 0 && succeededLatest.length === expected.length;

  // --- 判定（順序即優先序）---
  let verdict;
  if (!observed.length) verdict = SYNC_VERDICT.NEVER_SYNCED;
  else if (invalidTimestamps.length || unknownLatest.length) verdict = SYNC_VERDICT.INCOMPLETE_EVIDENCE;
  else if (failedLatest.length && everSucceeded.length === 0) verdict = SYNC_VERDICT.LATEST_FAILED;
  else if (failedLatest.length) verdict = SYNC_VERDICT.HISTORICAL_SUCCESS_LATEST_FAILED;
  else if (complete && stale) verdict = SYNC_VERDICT.STALE_SUCCESS;
  else if (complete) verdict = SYNC_VERDICT.LATEST_SUCCESS_COMPLETE;
  else if (succeededLatest.length) verdict = SYNC_VERDICT.LATEST_SUCCESS_PARTIAL;
  else verdict = SYNC_VERDICT.INCOMPLETE_EVIDENCE;

  // capability 還沒確認時，不可以宣稱「完整」——「預期」本身就不確定。
  if (verdict === SYNC_VERDICT.LATEST_SUCCESS_COMPLETE && unknownCapability.length) {
    verdict = SYNC_VERDICT.LATEST_SUCCESS_PARTIAL;
  }

  return {
    verdict,
    expected_resources: expected,
    excluded_resources: excluded,
    unknown_capability_resources: unknownCapability,
    covered_resources: succeededLatest,
    missing_resources: missing,
    failing_resources: failedLatest,
    unknown_resources: unknownLatest,
    invalid_timestamp_resources: invalidTimestamps,
    last_success_at: lastSuccessMs === null ? null : new Date(lastSuccessMs).toISOString(),
    success_age_ms: ageMs,
    stale,
    complete,
    latest_health_date: latestHealthDate ?? null,
    now: new Date(nowMs).toISOString(),
  };
}

/**
 * 同步成功了，但健康資料本身沒有變新。
 *
 * 這是一個真實而且常見的情況（WHOOP 還沒產生今天的分數），而且它跟
 * 「同步失敗」完全不同 —— 必須分開講，否則使用者會去修一個沒有壞的東西。
 */
export function producedNoNewData(assessment, { expectedHealthDate = null } = {}) {
  if (!assessment || !expectedHealthDate) return false;
  if (assessment.verdict !== SYNC_VERDICT.LATEST_SUCCESS_COMPLETE) return false;
  const latest = assessment.latest_health_date;
  return typeof latest === 'string' && latest < expectedHealthDate;
}
