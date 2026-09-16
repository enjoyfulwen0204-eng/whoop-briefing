/**
 * 分析工作者（V1.2 Phase 3 的分析端）。
 *
 * ## 兩條明確的邊界
 *
 *   runLightweightAnalysis({ db, userId, ... })  便宜、有界、確定性
 *   runHeavyAnalytics({ db, userId, ... })       昂貴、延後、整段重算
 *
 * 兩者都**只讀 canonical、只寫衍生表**，絕不寫任何 WHOOP canonical 資料，
 * 絕不呼叫 WHOOP API，絕不呼叫 LLM，絕不送 Telegram。
 *
 * ## dirty-driven 的處理迴圈
 *
 *   processPendingAnalytics({ db, cls })
 *     列出落後的使用者（有上限）
 *     → 認領 (user, class)（原子；記住認領時的 generation N）
 *     → 計算（輸入 = 認領當下的 canonical）
 *     → 結案 SUCCESS：done_generation = N（不是「現在的」）
 *
 * 計算期間又有 canonical 變動 → generation 變成 N+1；結案只寫 done = N，
 * done < generation 仍成立 → 使用者仍然髒，下一輪再算。新資料永遠不會被舊的
 * 結案清掉。失敗 → done 不動、退避、髒狀態保留。
 *
 * ## 輸出永遠帶 generation
 *
 * 輕量物化的每一列都記著算它時的 generation；重量的 done_generation 記在
 * work_state。讀取端比對 analytics_invalidation.generation 就知道是不是舊的
 * （getAnalyticsFreshness）。這是 Phase 4 判斷「重量分析是不是最新」的依據。
 */

import { ANALYTICS_WORK } from './config.js';
import { ANALYTICS_CLASS, ANALYTICS_RESULT } from './schema.js';
import { requireUserId } from './userContext.js';
import { loadDailyMetricsDetailed } from './dailyMetrics.js';
import { assessDailyState } from './readiness.js';
import { runPredictionCycle } from './predictionPipeline.js';
import { runHealthspanSnapshot } from './healthspanEngine.js';
import { capabilityStatusForField, isKnownUnavailable } from './capabilityMap.js';
import { addDays } from './time.js';
import { log, describeError } from './logger.js';

export const ANALYTICS_ERROR_CLASS = Object.freeze({
  INPUT_INCOMPLETE: 'analytics_input_incomplete',
  MODULE_FAILED: 'analytics_module_failed',
  DB: 'db',
  FENCED: 'fenced',
  INTERNAL: 'internal',
});

export function analyticsBackoffMs(consecutiveFailures, {
  base = ANALYTICS_WORK.RETRY_BASE_MS, max = ANALYTICS_WORK.RETRY_MAX_MS,
} = {}) {
  return Math.min(base * 2 ** Math.max(0, consecutiveFailures - 1), max);
}

export function classifyAnalyticsError(err) {
  if (err?.message === 'analytics_ownership_lost') return { class: ANALYTICS_ERROR_CLASS.FENCED, retryable: false };
  if (err?.code === 'analytics_input_incomplete') return { class: ANALYTICS_ERROR_CLASS.INPUT_INCOMPLETE, retryable: true };
  if (err?.code === 'analytics_module_failed') return { class: ANALYTICS_ERROR_CLASS.MODULE_FAILED, retryable: true };
  if (/SQLITE|libsql|database/i.test(String(err?.code ?? err?.message ?? ''))) return { class: ANALYTICS_ERROR_CLASS.DB, retryable: true };
  return { class: ANALYTICS_ERROR_CLASS.INTERNAL, retryable: true };
}

/**
 * 這一代輕量路徑**需要**覆蓋的完整範圍：受影響範圍 ± pad。沒有範圍（例如只有
 * 沒有日期的刪除）→ 以最新的 health_date 為錨點。**不截斷**：截斷是分片
 * （nextLightChunk）的事，剩餘的部分耐久保留（F03）。純函式（匯出給測試）。
 */
export function lightRangeFor({ affectedFrom, affectedTo, anchorDate }, {
  pad = ANALYTICS_WORK.LIGHT_RANGE_PAD_DAYS,
} = {}) {
  let from = affectedFrom ?? affectedTo ?? anchorDate;
  let to = affectedTo ?? affectedFrom ?? anchorDate;
  if (!from || !to) return null;
  if (anchorDate && to < anchorDate && !affectedTo) to = anchorDate;
  from = addDays(from, -pad);
  to = addDays(to, pad);
  return { from, to };
}

/** 兩個日期範圍的聯集（都是連續區間，所以是 min/max）。 */
export function unionRange(a, b) {
  if (!a) return b ?? null;
  if (!b) return a;
  return { from: a.from < b.from ? a.from : b.from, to: a.to > b.to ? a.to : b.to };
}

/**
 * 剩餘範圍裡**最新**的一片（最多 maxDays 天）。回傳 chunk 與縮完之後的剩餘上緣
 * （null = 這一片做完就沒有剩餘）。
 */
export function nextLightChunk({ from, to }, { maxDays = ANALYTICS_WORK.LIGHT_MAX_DAYS } = {}) {
  const chunkFrom = addDays(to, -(maxDays - 1)) > from ? addDays(to, -(maxDays - 1)) : from;
  const remainingTo = chunkFrom > from ? addDays(chunkFrom, -1) : null;
  return { chunk: { from: chunkFrom, to }, remainingTo, complete: remainingTo === null };
}

/**
 * 輕量分析（一片）：daily metrics 物化 + 當日就緒狀態。
 *
 * 為什麼只有這些：倉庫裡其他「便宜」的東西（基準、z-score、what-changed）
 * 都是讀取時從 daily metrics 現算，沒有耐久輸出可刷新；而 daily metrics 本身
 * 是所有分析的共同輸入，物化它才是 Phase 4「近事件回應」真正需要的東西。
 *
 * 讀取失敗（loadDailyMetricsDetailed.complete = false）→ 整片失敗，**不**把
 * 讀不到的資源物化成「沒有」（H-06：讀取失敗不是生理事實）。
 *
 * 寫入走 saveAnalyticsDailyState 的所有權圍欄交易（F01）：owner / 有效租約 /
 * claimed_generation 在寫入的同一個交易裡證明。
 *
 * @param {{from:string,to:string}} range 這一片要算的日期（呼叫端已切好）
 * @returns {{days:number, from:string, to:string, anchorDate:?string, dailyStatus:string}}
 */
export async function runLightweightAnalysis({
  db, userId, timezone, generation, owner, range, now = new Date(),
}) {
  const uid = requireUserId(userId, 'runLightweightAnalysis');
  const coverage = await db.coverage(uid);
  const anchorDate = coverage?.last_date ?? null;
  if (!range) {
    return { days: 0, from: null, to: null, anchorDate, dailyStatus: 'NO_DATA' };
  }
  const detailed = await loadDailyMetricsDetailed({ db, userId: uid, timezone, from: range.from, to: range.to });
  if (!detailed.complete) {
    const err = new Error(`daily metrics incomplete: ${JSON.stringify(detailed.available)}`);
    err.code = 'analytics_input_incomplete';
    throw err;
  }
  const rows = detailed.rows.map((m) => ({
    health_date: m.health_date,
    daily_status: assessDailyState({ rows: [m], anchorDate: m.health_date, now }).status,
    metrics: m,
  }));
  const days = await db.saveAnalyticsDailyState(uid, rows, { owner, generation, now });
  const anchorRow = detailed.rows.find((r) => r.health_date === anchorDate) ?? null;
  const dailyStatus = assessDailyState({ rows: anchorRow ? [anchorRow] : [], anchorDate, now }).status;
  return { days, from: range.from, to: range.to, anchorDate, dailyStatus };
}

/**
 * 重量模組的**圍欄 db 視圖**（F01）：模組自己呼叫的每一個耐久寫入
 * （savePredictionModel / savePrediction / recordPredictionActual /
 * saveHealthspanMetrics / saveHealthspanSnapshot）都包進
 * mutateForAnalytics —— 短的持久化交易，開頭與結尾都證明 owner / 有效租約 /
 * claimed_generation。計算本身在交易外。失去租約的執行，寫入在資料庫層被擋下；
 * `fence.lost` 記下這件事，讓工作者把整輪判成 FENCED。
 */
export const HEAVY_OUTPUT_WRITERS = Object.freeze([
  'savePredictionModel', 'savePrediction', 'recordPredictionActual',
  'saveHealthspanMetrics', 'saveHealthspanSnapshot',
]);

export function fencedAnalyticsDb(db, { userId, cls, owner, generation, now }) {
  const fence = { lost: false, blockedWrites: 0 };
  const view = { ...db };
  for (const name of HEAVY_OUTPUT_WRITERS) {
    if (typeof db[name] !== 'function') continue;
    view[name] = async (...args) => {
      try {
        return await db.mutateForAnalytics({ userId, cls, owner, generation, now }, () => db[name](...args));
      } catch (err) {
        if (err?.message === 'analytics_ownership_lost') { fence.lost = true; fence.blockedWrites += 1; }
        throw err;
      }
    };
  }
  return { db: view, fence };
}

/**
 * 重量分析：預測生產迴圈 + Healthspan 盤點。與 index.js 每輪跑的那一段相同的
 * 輸入與模組，只是搬到 dirty-driven 的邊界後面。
 *
 * 模組各自有錯誤邊界（F-02）：一個炸掉不影響另一個的輸出；但整輪只有在
 * **全部**模組成功時才算 SUCCESS（done_generation 才前進）。部分失敗 →
 * FAILED，成功的模組輸出保留（它們自己寫自己的表），下一輪重算全部。
 * 這樣 heavy 的「CURRENT」才是一個誠實的整體宣稱。
 */
export async function runHeavyAnalytics({ db, userId, timezone, now = new Date(), deps = {}, fence = null }) {
  const uid = requireUserId(userId, 'runHeavyAnalytics');
  const { predictionCycle = runPredictionCycle, healthspan = runHealthspanSnapshot } = deps;
  const anchor = (await db.coverage(uid))?.last_date ?? null;
  if (!anchor) return { anchorDate: null, modules: {}, failed: [] };

  const detailed = await loadDailyMetricsDetailed({
    db, userId: uid, timezone, from: addDays(anchor, -ANALYTICS_WORK.HEAVY_LOOKBACK_DAYS), to: anchor,
  });
  if (!detailed.complete) {
    const err = new Error(`daily metrics incomplete: ${JSON.stringify(detailed.available)}`);
    err.code = 'analytics_input_incomplete';
    throw err;
  }
  const rows = detailed.rows;
  // capability 查不到（還沒 probe）一律當 {}：樣本數邏輯照走，絕不誤判成不支援。
  const caps = await db.getCapabilities(uid).catch(() => ({}));

  // F01：有圍欄就用圍欄視圖；沒有（直接呼叫的開發邊界）就明講。
  let outDb = db; let fenceState = null;
  if (fence) {
    const f = fencedAnalyticsDb(db, { userId: uid, cls: ANALYTICS_CLASS.HEAVY, owner: fence.owner, generation: fence.generation, now: fence.now ?? (() => now) });
    outDb = f.db; fenceState = f.fence;
  } else {
    log.warn('analytics_heavy_unfenced', { user_id: uid });
  }
  const lost = () => Boolean(fenceState?.lost);

  const modules = {};
  const failed = [];
  try {
    const targetStatus = capabilityStatusForField('recovery', caps);
    const p = await predictionCycle({
      db: outDb, userId: uid, rows, anchorDate: anchor,
      capabilityUnavailable: isKnownUnavailable(targetStatus), now,
    });
    modules.prediction = { maturity: p?.maturity ?? null, qualified: Boolean(p?.qualified), modelSaved: Boolean(p?.modelSaved) };
  } catch (err) {
    if (err?.message === 'analytics_ownership_lost') throw err;
    failed.push('prediction');
    modules.prediction = { error: describeError(err) };
    log.error('analytics_heavy_prediction_failed', { user_id: uid, error: describeError(err) });
  }
  if (lost()) throw new Error('analytics_ownership_lost');
  try {
    const h = await healthspan({ db: outDb, userId: uid, rows, endDate: anchor, capabilities: caps, now });
    if (h?.error) throw new Error('healthspan_snapshot_failed');
    modules.healthspan = { maturity: h?.maturity ?? null, saved: Boolean(h?.saved) };
  } catch (err) {
    if (err?.message === 'analytics_ownership_lost') throw err;
    failed.push('healthspan');
    modules.healthspan = { error: describeError(err) };
    log.error('analytics_heavy_healthspan_failed', { user_id: uid, error: describeError(err) });
  }
  if (lost()) throw new Error('analytics_ownership_lost');
  if (failed.length) {
    const err = new Error(`heavy modules failed: ${failed.join(',')}`);
    err.code = 'analytics_module_failed';
    err.modules = modules;
    throw err;
  }
  return { anchorDate: anchor, historyDays: rows.length, modules, failed };
}

/**
 * 對一個使用者做一輪某個類別：認領 → 算 → 結案。**永遠不拋錯**（結果結構化）。
 */
export async function processAnalyticsForUser({
  db, userId, cls, owner, now = () => new Date(), force = false, deps = {},
  leaseMs = ANALYTICS_WORK.LEASE_MS[cls], heavyMinIntervalMs = ANALYTICS_WORK.HEAVY_MIN_INTERVAL_MS,
}) {
  const uid = requireUserId(userId, 'processAnalyticsForUser');
  if (!Object.values(ANALYTICS_CLASS).includes(cls)) throw new Error(`invalid_analytics_class:${cls}`);
  const at = () => new Date(now());

  const claim = await db.claimAnalyticsWork({ userId: uid, cls, owner, leaseMs, now: at() });
  if (!claim) return { userId: uid, cls, result: ANALYTICS_RESULT.SKIPPED, reason: 'claim_busy' };
  const generation = claim.generation;
  const prior = await db.getAnalyticsWorkState(uid, cls);

  const release = async (reason, nextAttemptAt = null) => {
    // 沒有要算：釋放租約，不記成功也不記失敗（done 不動）。
    await db.releaseAnalyticsWork({ userId: uid, cls, owner, nextAttemptAt, now: at() });
    return { userId: uid, cls, result: ANALYTICS_RESULT.SKIPPED, reason, generation };
  };
  if (!force && generation <= claim.doneGeneration) return release('already_current');
  if (!force && cls === ANALYTICS_CLASS.HEAVY && prior?.lastSuccessAt
      && at().getTime() - Date.parse(prior.lastSuccessAt) < heavyMinIntervalMs) {
    // 節奏未到：把 next_attempt_at 設到節奏到期，list 才不會每輪都白認領一次。
    return release('heavy_cadence', new Date(Date.parse(prior.lastSuccessAt) + heavyMinIntervalMs));
  }

  const user = await db.getUser(uid);
  if (!user) return release('unknown_user');
  const runId = await db.openAnalyticsRun({ userId: uid, cls, owner, generation, now: at() });

  try {
    let summary; let partial = false;
    if (cls === ANALYTICS_CLASS.LIGHT) {
      // ---- F03：耐久的剩餘範圍 + 有界的一片 ----------------------------------
      // 同一代 → 沿用剩餘範圍；換代 → 上一代還沒做完的剩餘 ∪ 這一代的失效範圍。
      // 任何一天都不會掉：失效範圍在完成（CAS）之前不會被清。
      const anchorDate = (await db.coverage(uid))?.last_date ?? null;
      const needed = lightRangeFor({ affectedFrom: claim.affectedFrom, affectedTo: claim.affectedTo, anchorDate });
      const carried = claim.rangeFrom && claim.rangeTo ? { from: claim.rangeFrom, to: claim.rangeTo } : null;
      const remaining = claim.rangeGeneration === generation && carried ? carried : unionRange(carried, needed);
      if (!remaining) {
        summary = { days: 0, from: null, to: null, anchorDate, dailyStatus: 'NO_DATA' };
      } else {
        if (!(claim.rangeGeneration === generation && carried)) {
          const set = await db.setAnalyticsRange({ userId: uid, cls, owner, generation, from: remaining.from, to: remaining.to, now: at() });
          if (!set) throw new Error('analytics_ownership_lost');
        }
        const { chunk, remainingTo, complete } = nextLightChunk(remaining);
        summary = await runLightweightAnalysis({
          db, userId: uid, timezone: user.timezone, generation, owner, range: chunk, now: at(),
        });
        // 這一片完成 → 縮剩餘範圍（owner + 租約 + range_generation + range_to 的 CAS）
        const advanced = await db.advanceAnalyticsRange({
          userId: uid, cls, owner, generation, chunkTo: chunk.to, newTo: remainingTo, now: at(),
        });
        if (!advanced) throw new Error('analytics_ownership_lost');
        summary = { ...summary, remaining: complete ? null : { from: remaining.from, to: remainingTo } };
        partial = !complete;
      }
    } else {
      summary = await runHeavyAnalytics({
        db, userId: uid, timezone: user.timezone, now: at(), deps,
        fence: { owner, generation, now },
      });
    }

    if (partial) {
      // 還有剩餘範圍：不結案（done 不動），只釋放租約讓下一輪（或別的工作者）接續。
      const released = await db.releaseAnalyticsWork({ userId: uid, cls, owner, now: at() });
      const result = released ? ANALYTICS_RESULT.PARTIAL : ANALYTICS_RESULT.FENCED;
      await db.closeAnalyticsRun(runId, { result, detail: summary, now: at() });
      log.info('analytics_partial', { user_id: uid, class: cls, generation, remaining: summary.remaining });
      return { userId: uid, cls, result, generation, stillDirty: true, summary };
    }

    // 結案前再驗一次所有權：租約過期被接手的話，這裡的結果不能寫成「最新」。
    if (!await db.holdsAnalyticsWork({ userId: uid, cls, owner, now: at() })) throw new Error('analytics_ownership_lost');
    const settled = await db.settleAnalyticsWork({
      userId: uid, cls, owner, result: ANALYTICS_RESULT.SUCCESS, generation,
      summary: { ...summary, generation }, clearRange: cls === ANALYTICS_CLASS.LIGHT, now: at(),
    });
    const result = settled ? ANALYTICS_RESULT.SUCCESS : ANALYTICS_RESULT.FENCED;
    await db.closeAnalyticsRun(runId, { result, detail: summary, now: at() });
    const after = await db.getAnalyticsInvalidation(uid);
    const stillDirty = (after?.generation ?? 0) > generation;
    log.info('analytics_done', { user_id: uid, class: cls, result, generation, still_dirty: stillDirty });
    return { userId: uid, cls, result, generation, stillDirty, summary };
  } catch (err) {
    const c = classifyAnalyticsError(err);
    if (c.class === ANALYTICS_ERROR_CLASS.FENCED) {
      await db.closeAnalyticsRun(runId, { result: ANALYTICS_RESULT.FENCED, errorClass: c.class, now: at() });
      log.warn('analytics_fenced', { user_id: uid, class: cls, generation });
      return { userId: uid, cls, result: ANALYTICS_RESULT.FENCED, generation };
    }
    const failures = (prior?.consecutiveFailures ?? 0) + 1;
    const nextAttemptAt = new Date(at().getTime() + analyticsBackoffMs(failures));
    await db.settleAnalyticsWork({
      userId: uid, cls, owner, result: ANALYTICS_RESULT.FAILED,
      errorClass: c.class, errorDetail: describeError(err), nextAttemptAt, now: at(),
    });
    await db.closeAnalyticsRun(runId, {
      result: ANALYTICS_RESULT.FAILED, detail: err?.modules ?? null, errorClass: c.class, errorDetail: describeError(err), now: at(),
    });
    log.error('analytics_failed', { user_id: uid, class: cls, generation, error_class: c.class });
    return { userId: uid, cls, result: ANALYTICS_RESULT.FAILED, generation, errorClass: c.class, retryable: c.retryable };
  }
}

/**
 * 處理某個類別所有落後的使用者，**有上限**（maxUsers）。永遠不拋錯。
 * 這是未來排程器（每 30～60 分鐘）要呼叫的入口；目前只有本機腳本與測試呼叫。
 */
export async function processPendingAnalytics({
  db, cls, owner = null, now = () => new Date(), maxUsers = ANALYTICS_WORK.MAX_USERS_PER_RUN, deps = {},
}) {
  const at = () => new Date(now());
  const own = owner ?? `analytics:${cls}:${process.pid}:${Math.random().toString(36).slice(2, 10)}`;
  const out = [];
  let pending;
  try {
    pending = await db.listPendingAnalytics(cls, { limit: maxUsers, now: at() });
  } catch (err) {
    log.error('analytics_list_pending_failed', { class: cls, error: describeError(err) });
    return { cls, owner: own, processed: [], error: describeError(err) };
  }
  for (const p of pending) {
    try {
      out.push(await processAnalyticsForUser({ db, userId: p.userId, cls, owner: own, now, deps }));
    } catch (err) {
      log.error('analytics_unhandled', { user_id: p.userId, class: cls, error: describeError(err) });
      out.push({ userId: p.userId, cls, result: ANALYTICS_RESULT.FAILED, errorClass: ANALYTICS_ERROR_CLASS.INTERNAL });
    }
  }
  return { cls, owner: own, processed: out, candidates: pending.length };
}
