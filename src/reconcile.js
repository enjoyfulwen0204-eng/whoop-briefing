/**
 * 對帳 + 增量同步引擎（V1.2 Phase 2）。
 *
 * ## 它回答的問題（每個 user × resource）
 *
 *   A. WHOOP 現在回得出哪些資源？            → 抓窗、寫入（新鮮度 + 墓碑規則）
 *   B. 哪些本地資源在遠端有更新的版本？       → 同上：M-03 讓新版本蓋掉舊版本
 *   C. 哪些本地資源在遠端看不到了？           → **只記錄差異，不刪**（見下）
 *   D. 哪些 ACTIVE 墓碑仍然沒有解決？         → 診斷判定，**永遠不改 state**
 *   E. 哪些 webhook 可能漏了但現在補得回來？   → 重疊窗自然補回
 *   F. 哪些資源沒有 webhook，只能靠對帳？     → cycle、body_measurement
 *   G. 下一次該用什麼窗？                     → 水位 − 重疊 … now
 *
 * ## 三條不可違反的規則
 *
 * 1. **水位只在整個窗完整成功之後才前進。** 任何一頁失敗、頁數預算用完、
 *    寫入失敗 → 不前進。失敗永遠不會跳過資料。
 * 2. **失敗不是零。** API 失敗只改變對帳狀態，絕不寫出任何空結果。
 * 3. **不捏造來源時序。** 本地執行順序、抓取時間、run id 都不是 WHOOP 的時序；
 *    ACTIVE 墓碑在 Phase 2 仍然是權威（P1-R01 不變）。
 *
 * ## 為什麼「遠端看不到」不等於「被刪了」
 *
 * WHOOP 集合端點只能用資源的 start 時間過濾，而且 end 是「intersect 或在
 * 此之前結束」的語義。一個資源不在某個窗裡，可能是：被刪了、被使用者改了
 * 時間、剛好壓在邊界上、還在評分、或者根本是我們那一頁沒抓完。
 * 這些情況在 API 回應裡長得一模一樣。所以 Phase 2 只把它記成差異
 * （MISSING_REMOTE），刪除的唯一證據仍然是 webhook DELETE。
 *
 * ## 寫入一律走既有的 canonical 儲存層
 *
 * upsertSleeps / Recoveries / Workouts 帶著 M-03 新鮮度與 Phase 1 墓碑保護
 * （同一交易）；upsertCycles 帶 M-03；upsertBodyMeasurement 沿用日期快照。
 * 整段寫入再包在 mutateForReconciliation 的所有權圍欄交易裡。
 */

import { WHOOP_RECONCILE, WHOOP } from './config.js';
import { RECONCILE_RESULT, TOMBSTONE_RECONCILE_VERDICT, DISCREPANCY_KIND } from './schema.js';
import { WhoopApiError, WhoopAuthError, isScopeError } from './whoop.js';
import { requireUserId } from './userContext.js';
import { log, describeError } from './logger.js';

const DAY_MS = 86_400_000;

/** 每種資源的 API 路徑、識別欄位、canonical 寫入器、start 欄位。 */
const RESOURCE_SPEC = Object.freeze({
  sleep: {
    path: '/activity/sleep', idOf: (r) => r?.id, startOf: (r) => r?.start,
    table: 'whoop_sleeps', idColumn: 'id', startColumn: 'start_at', tombstoned: true,
    singleGet: (id) => `/activity/sleep/${encodeURIComponent(id)}`,
  },
  recovery: {
    path: '/recovery', idOf: (r) => r?.sleep_id, startOf: (r) => null,
    table: 'whoop_recoveries', idColumn: 'sleep_id', startColumn: null, tombstoned: true,
    singleGet: null,   // v2 沒有以 sleep id 定址的單筆 recovery 端點
  },
  workout: {
    path: '/activity/workout', idOf: (r) => r?.id, startOf: (r) => r?.start,
    table: 'whoop_workouts', idColumn: 'id', startColumn: 'start_at', tombstoned: true,
    singleGet: (id) => `/activity/workout/${encodeURIComponent(id)}`,
  },
  cycle: {
    path: '/cycle', idOf: (r) => r?.id, startOf: (r) => r?.start,
    table: 'whoop_cycles', idColumn: 'id', startColumn: 'start_at', tombstoned: false,
    singleGet: null,
  },
  body_measurement: { pointInTime: true, tombstoned: false },
});

export const ERROR_CLASS = Object.freeze({
  AUTH: 'whoop_auth',
  SCOPE: 'whoop_scope_missing',
  RATE_LIMIT: 'whoop_rate_limit',
  SERVER: 'whoop_server',
  NETWORK: 'whoop_network',
  NOT_FOUND: 'whoop_not_found',
  CLIENT: 'whoop_client_error',
  MALFORMED: 'whoop_malformed_response',
  DB: 'db',
  FENCED: 'fenced',
  INTERNAL: 'internal',
});

/**
 * 錯誤分類。與 webhook 處理器的原則一致：分錯的代價不是少一筆，而是
 * 「暫時性故障被當終局 → 永久漏資料」或「終局被當可重試 → 重試風暴」。
 */
export function classifyReconcileError(err) {
  if (err?.message === 'reconcile_ownership_lost') return { class: ERROR_CLASS.FENCED, retryable: false };
  if (err instanceof WhoopAuthError) return { class: ERROR_CLASS.AUTH, retryable: true };
  if (err instanceof WhoopApiError) {
    const status = Number(err.status ?? 0);
    // scope 不足是「還沒重新授權」，不是故障：不重試、不算錯誤通知。
    if (status === 403 || (status === 401 && isScopeError(err))) {
      return { class: ERROR_CLASS.SCOPE, retryable: false };
    }
    if (status === 404) return { class: ERROR_CLASS.NOT_FOUND, retryable: false };
    if (status === 429) return { class: ERROR_CLASS.RATE_LIMIT, retryable: true };
    if (status >= 500) return { class: ERROR_CLASS.SERVER, retryable: true };
    if (status === 0) return { class: ERROR_CLASS.NETWORK, retryable: true };
    return { class: ERROR_CLASS.CLIENT, retryable: false };
  }
  if (err instanceof SyntaxError || /json|unexpected token/i.test(String(err?.message ?? ''))) {
    return { class: ERROR_CLASS.MALFORMED, retryable: true };
  }
  if (/SQLITE|libsql|database/i.test(String(err?.code ?? err?.message ?? ''))) {
    return { class: ERROR_CLASS.DB, retryable: true };
  }
  return { class: ERROR_CLASS.INTERNAL, retryable: true };
}

/** 指數退避（有上限）。 */
export function reconcileBackoffMs(consecutiveFailures, {
  base = WHOOP_RECONCILE.RETRY_BASE_MS, max = WHOOP_RECONCILE.RETRY_MAX_MS,
} = {}) {
  return Math.min(base * 2 ** Math.max(0, consecutiveFailures - 1), max);
}

/**
 * 現在該不該對這個資源做一輪？
 *   · 退避中 → 否
 *   · 有續傳 → 是（要把上一個窗做完）
 *   · 距上次成功不到 MIN_INTERVAL → 否
 */
export function isReconcileDue(state, { now = new Date(), minIntervalMs = WHOOP_RECONCILE.MIN_INTERVAL_MS } = {}) {
  const t = now.getTime();
  if (state?.nextAttemptAt && Date.parse(state.nextAttemptAt) > t) return false;
  if (state?.continuationToken) return true;
  const last = state?.lastSuccessAt ? Date.parse(state.lastSuccessAt) : 0;
  return !(Number.isFinite(last) && t - last < minIntervalMs);
}

/**
 * 下一個窗。
 *
 *   有續傳 → 完全沿用上一個窗（同一組 [from, to]，從 token 繼續）
 *   有水位 → [水位 − 重疊, now]
 *   都沒有 → [now − INITIAL_WINDOW_DAYS, now]
 *
 * `to` 固定在窗開始的那一刻（而不是每頁重新取 now）：水位前進到 `to`
 * 代表「到這一刻為止都完整」，如果 to 一直往前跑，這句話就不成立。
 */
export function nextWindow(resource, state, { now = new Date() } = {}) {
  if (state?.continuationToken && state.continuationFrom && state.continuationTo) {
    return {
      from: new Date(state.continuationFrom), to: new Date(state.continuationTo),
      token: state.continuationToken, resumed: true,
    };
  }
  const overlapDays = WHOOP_RECONCILE.OVERLAP_DAYS[resource] ?? 5;
  const to = new Date(now);
  let from = state?.windowWatermark
    ? new Date(Date.parse(state.windowWatermark) - overlapDays * DAY_MS)
    : new Date(now.getTime() - WHOOP_RECONCILE.INITIAL_WINDOW_DAYS * DAY_MS);
  // 時鐘倒退（水位在未來）：仍抓一個合法的窗；水位本身單調不減（store 用 MAX）。
  if (from.getTime() >= to.getTime()) from = new Date(to.getTime() - overlapDays * DAY_MS);
  return { from, to, token: null, resumed: false };
}

/**
 * 建立一個使用者的對帳器。
 *
 * @param {object} whoop createWhoopClient 的結果（token 租約 / CAS 圍欄都在裡面）
 */
export function createReconciler({
  db, whoop, userId, timezone, now = () => new Date(), ownerId = null,
  maxPagesPerRun = WHOOP_RECONCILE.MAX_PAGES_PER_RUN,
  leaseMs = WHOOP_RECONCILE.LEASE_MS,
}) {
  const uid = requireUserId(userId, 'createReconciler');
  const owner = ownerId ?? `reconcile:${uid}:${process.pid}:${Math.random().toString(36).slice(2, 10)}`;
  const at = () => new Date(now());

  /**
   * 抓一個窗，**可續傳**，有頁數預算。
   *
   * 刻意不用 whoop.collect()：它在超過 MAX_PAGES 時只記一筆 warn 然後回傳
   * 截斷的結果，呼叫端分不出「抓完了」跟「被截斷了」。這裡每一頁都明確。
   *
   * @returns {{records, pages, nextToken, complete}}
   */
  async function fetchWindow(spec, { from, to, token }) {
    const records = [];
    const seen = new Set();
    let nextToken = token ?? null;
    let pages = 0;
    do {
      const page = await whoop.apiGet(spec.path, {
        start: from.toISOString(), end: to.toISOString(),
        limit: WHOOP.PAGE_LIMIT, nextToken: nextToken ?? undefined,
      });
      if (!page || typeof page !== 'object' || (page.records !== undefined && !Array.isArray(page.records))) {
        throw new SyntaxError('whoop collection response malformed');
      }
      pages += 1;
      for (const r of Array.isArray(page.records) ? page.records : []) {
        const id = spec.idOf(r);
        if (id === null || id === undefined) continue;
        // 同一筆跨頁重複（WHOOP 分頁在資料變動時可能重疊）→ 保留一份。
        // 寫入本來就冪等，這只是省事與讓 fetched 計數誠實。
        const key = String(id);
        if (seen.has(key)) continue;
        seen.add(key);
        records.push(r);
      }
      nextToken = page.next_token || null;
      if (nextToken && pages >= maxPagesPerRun) {
        return { records, pages, nextToken, complete: false };
      }
    } while (nextToken);
    return { records, pages, nextToken: null, complete: true };
  }

  /** 走既有儲存層。回傳實際寫入筆數。 */
  async function persist(resource, records) {
    switch (resource) {
      case 'sleep': return db.upsertSleeps(uid, records, { timezone, now: at() });
      case 'recovery': return db.upsertRecoveries(uid, records, { now: at() });
      case 'workout': return db.upsertWorkouts(uid, records, { timezone, now: at() });
      case 'cycle': return db.upsertCycles(uid, records, { now: at() });
      default: throw new Error(`unsupported_resource:${resource}`);
    }
  }

  /** 本地在窗內（縮邊之後）的資源 id，用來找「遠端看不到」的差異。 */
  async function localIdsInWindow(spec, { from, to }) {
    if (!spec.startColumn) return [];
    const margin = WHOOP_RECONCILE.DISCREPANCY_EDGE_MARGIN_MS;
    const innerFrom = new Date(from.getTime() + margin).toISOString();
    const innerTo = new Date(to.getTime() - margin).toISOString();
    if (innerFrom >= innerTo) return [];
    const rs = await db.raw.execute({
      sql: `SELECT "${spec.idColumn}" id FROM "${spec.table}"
             WHERE user_id = ? AND "${spec.startColumn}" >= ? AND "${spec.startColumn}" < ?`,
      args: [uid, innerFrom, innerTo],
    });
    return rs.rows.map((r) => String(r.id));
  }

  /**
   * 差異偵測：**只在窗完整成功時**，而且**只記錄、不刪除**。
   */
  async function recordMissingRemote(resource, spec, window, remoteIds) {
    const local = await localIdsInWindow(spec, window);
    let n = 0;
    for (const id of local) {
      if (remoteIds.has(id)) continue;
      await db.recordDiscrepancy({
        userId: uid, resource, resourceId: id, kind: DISCREPANCY_KIND.MISSING_REMOTE,
        windowFrom: window.from, windowTo: window.to, now: at(),
      });
      n += 1;
    }
    if (n) log.warn('reconcile_missing_remote_recorded', { user_id: uid, resource, count: n });
    return n;
  }

  /**
   * ACTIVE 墓碑的診斷檢查。**永遠不改 state。**
   *
   * sleep / workout 有單筆端點：404 → STILL_DELETED；200 → REMOTE_PRESENT_UNRESOLVED。
   * recovery 沒有：只能看這一輪的窗有沒有觀察到它。
   */
  async function inspectTombstones(resource, spec, remoteById) {
    if (!spec.tombstoned) return { checked: 0, unresolved: 0 };
    const due = await db.tombstonesDueForCheck(uid, resource, {
      recheckMs: WHOOP_RECONCILE.TOMBSTONE_RECHECK_MS,
      limit: WHOOP_RECONCILE.MAX_TOMBSTONE_CHECKS_PER_RUN, now: at(),
    });
    let unresolved = 0;
    for (const t of due) {
      let verdict = TOMBSTONE_RECONCILE_VERDICT.UNRESOLVED;
      let remoteUpdatedAt = null;
      if (remoteById.has(t.resourceId)) {
        verdict = TOMBSTONE_RECONCILE_VERDICT.REMOTE_PRESENT_UNRESOLVED;
        remoteUpdatedAt = remoteById.get(t.resourceId)?.updated_at ?? null;
      } else if (spec.singleGet) {
        try {
          const one = await whoop.apiGet(spec.singleGet(t.resourceId));
          verdict = TOMBSTONE_RECONCILE_VERDICT.REMOTE_PRESENT_UNRESOLVED;
          remoteUpdatedAt = one?.updated_at ?? null;
        } catch (err) {
          const cls = classifyReconcileError(err);
          if (cls.class === ERROR_CLASS.NOT_FOUND) verdict = TOMBSTONE_RECONCILE_VERDICT.STILL_DELETED;
          else throw err;   // 其他錯誤照樣往上（會被分類成這一輪的失敗）
        }
      }
      await db.recordTombstoneVerdict({
        userId: uid, resourceType: resource, resourceId: t.resourceId,
        verdict, remoteUpdatedAt: remoteUpdatedAt ? new Date(remoteUpdatedAt).toISOString() : null,
        now: at(),
      });
      if (verdict === TOMBSTONE_RECONCILE_VERDICT.REMOTE_PRESENT_UNRESOLVED) {
        unresolved += 1;
        // 這是 Phase 2 刻意不解決的情況：資源在遠端存在，但我們沒有來源時序
        // 能證明它是「刪除後重建」還是「刪除通知晚到」。留給人看。
        log.warn('reconcile_tombstone_remote_present_unresolved', {
          user_id: uid, resource, resource_id: t.resourceId,
        });
      }
    }
    return { checked: due.length, unresolved };
  }

  /**
   * 對一種資源做一輪。呼叫端負責 due 判斷；這裡負責認領 → 抓 → 寫 → 結案。
   *
   * @param {{from?:Date, to?:Date}} explicitWindow 明確的 backfill / 修復窗（可選）。
   *   給了就不看水位、也不前進水位（那是「額外補一段」，不是常規對帳）。
   */
  async function reconcileResource(resource, { explicitWindow = null } = {}) {
    const spec = RESOURCE_SPEC[resource];
    if (!spec) throw new Error(`unsupported_resource:${resource}`);

    const claimed = await db.claimReconciliation({
      userId: uid, resource, owner, leaseMs, now: at(),
    });
    if (!claimed) return { resource, result: RECONCILE_RESULT.SKIPPED, reason: 'claim_busy' };

    const state = await db.getReconciliationState(uid, resource);
    const window = explicitWindow
      ? { from: new Date(explicitWindow.from), to: new Date(explicitWindow.to), token: null, resumed: false }
      : (spec.pointInTime ? { from: null, to: at(), token: null, resumed: false } : nextWindow(resource, state, { now: at() }));
    const mode = spec.pointInTime ? 'point_in_time' : explicitWindow ? 'explicit_window' : 'incremental';
    const runId = await db.openReconciliationRun({
      userId: uid, resource, owner, mode, windowFrom: window.from, windowTo: window.to, now: at(),
    });
    const counters = { pages: 0, fetched: 0, written: 0, blocked: 0, missing: 0, tombstonesChecked: 0, tombstonesUnresolved: 0 };

    try {
      // ---- body measurement：單一物件、沒有時間戳、沿用日期快照 ----------
      if (spec.pointInTime) {
        const bm = await whoop.bodyMeasurement();
        if (!bm || typeof bm !== 'object') throw new SyntaxError('whoop body measurement malformed');
        counters.pages = 1;
        counters.fetched = 1;
        counters.written = await db.mutateForReconciliation(
          { userId: uid, resource, owner, now },
          () => db.upsertBodyMeasurement(uid, bm, { now: at() }),
        );
        const settled = await db.settleReconciliation({
          userId: uid, resource, owner, result: RECONCILE_RESULT.SUCCESS, windowTo: window.to, now: at(),
        });
        await db.closeReconciliationRun(runId, {
          result: settled ? RECONCILE_RESULT.SUCCESS : RECONCILE_RESULT.FENCED, ...counters, now: at(),
        });
        return { resource, result: settled ? RECONCILE_RESULT.SUCCESS : RECONCILE_RESULT.FENCED, ...counters };
      }

      // ---- 集合資源：抓窗（可續傳）→ 圍欄交易內寫入 → 診斷 → 結案 --------
      const fetched = await fetchWindow(spec, window);
      counters.pages = fetched.pages;
      counters.fetched = fetched.records.length;
      const remoteById = new Map(fetched.records.map((r) => [String(spec.idOf(r)), r]));
      let latestRemoteUpdatedAt = null;
      for (const r of fetched.records) {
        const u = r?.updated_at ? new Date(r.updated_at).toISOString() : null;
        if (u && (!latestRemoteUpdatedAt || u > latestRemoteUpdatedAt)) latestRemoteUpdatedAt = u;
      }

      // 寫入：既有儲存層（M-03 + 墓碑）+ 所有權圍欄交易。
      // 寫入筆數 < 抓到筆數的差額 = 被新鮮度或墓碑擋下的；墓碑擋下的另外從
      // 墓碑的 blocked_count 差值推算會更精確，但那需要多一次讀 —— 這裡的
      // blocked 是「沒寫進去的」，足以判讀。
      counters.written = fetched.records.length
        ? await db.mutateForReconciliation({ userId: uid, resource, owner, now }, () => persist(resource, fetched.records))
        : 0;
      counters.blocked = Math.max(0, counters.fetched - counters.written);

      if (!fetched.complete) {
        // 頁數預算用完：存續傳，**水位不動**。
        const settled = await db.settleReconciliation({
          userId: uid, resource, owner, result: RECONCILE_RESULT.PARTIAL,
          continuation: { token: fetched.nextToken, from: window.from, to: window.to },
          latestRemoteUpdatedAt, now: at(),
        });
        await db.closeReconciliationRun(runId, {
          result: settled ? RECONCILE_RESULT.PARTIAL : RECONCILE_RESULT.FENCED, ...counters, now: at(),
        });
        log.info('reconcile_partial', { user_id: uid, resource, pages: counters.pages, fetched: counters.fetched });
        return { resource, result: settled ? RECONCILE_RESULT.PARTIAL : RECONCILE_RESULT.FENCED, ...counters };
      }

      // 窗完整 → 差異偵測（只記錄）與墓碑診斷。這兩件事失敗不影響水位：
      // 資料已經寫進去了，它們是附加診斷。
      try {
        counters.missing = await recordMissingRemote(resource, spec, window, new Set(remoteById.keys()));
        const tomb = await inspectTombstones(resource, spec, remoteById);
        counters.tombstonesChecked = tomb.checked;
        counters.tombstonesUnresolved = tomb.unresolved;
      } catch (err) {
        log.warn('reconcile_diagnostics_failed', { user_id: uid, resource, error: describeError(err) });
      }

      // 明確窗（backfill / 修復）不前進常規水位、不動續傳：它是「額外補一段」。
      const settled = await db.settleReconciliation({
        userId: uid, resource, owner, result: RECONCILE_RESULT.SUCCESS,
        windowTo: window.to, latestRemoteUpdatedAt, now: at(),
        advanceWatermark: !explicitWindow,
      });
      const result = settled ? RECONCILE_RESULT.SUCCESS : RECONCILE_RESULT.FENCED;
      await db.closeReconciliationRun(runId, { result, ...counters, now: at() });
      log.info('reconcile_done', { user_id: uid, resource, result, ...counters });
      return { resource, result, ...counters };
    } catch (err) {
      const cls = classifyReconcileError(err);
      if (cls.class === ERROR_CLASS.FENCED) {
        await db.closeReconciliationRun(runId, { result: RECONCILE_RESULT.FENCED, ...counters, errorClass: cls.class, now: at() });
        log.warn('reconcile_fenced', { user_id: uid, resource });
        return { resource, result: RECONCILE_RESULT.FENCED, ...counters };
      }
      const failures = (state?.consecutiveFailures ?? 0) + 1;
      // 可重試與不可重試都排退避：不可重試（scope / 4xx）多半要等人重新授權，
      // 但也不該每個排程 tick 都去撞一次 403 —— 退避上限把 API 用量綁死。
      const nextAttemptAt = new Date(at().getTime() + reconcileBackoffMs(failures));
      await db.settleReconciliation({
        userId: uid, resource, owner, result: RECONCILE_RESULT.FAILED,
        errorClass: cls.class, errorDetail: describeError(err), nextAttemptAt, now: at(),
      });
      await db.closeReconciliationRun(runId, {
        result: RECONCILE_RESULT.FAILED, ...counters,
        errorClass: cls.class, errorDetail: describeError(err), retryable: cls.retryable, now: at(),
      });
      log[cls.class === ERROR_CLASS.SCOPE ? 'warn' : 'error']('reconcile_failed', {
        user_id: uid, resource, error_class: cls.class, retryable: cls.retryable,
      });
      return { resource, result: RECONCILE_RESULT.FAILED, errorClass: cls.class, retryable: cls.retryable, ...counters };
    }
  }

  /**
   * 對一個使用者的所有資源各做一輪（有節流與退避）。**永遠不拋錯。**
   */
  async function reconcileAll({ resources = WHOOP_RECONCILE.RESOURCES, force = false } = {}) {
    const out = [];
    for (const resource of resources) {
      try {
        if (!force) {
          const state = await db.getReconciliationState(uid, resource);
          if (!isReconcileDue(state, { now: at() })) {
            out.push({ resource, result: RECONCILE_RESULT.SKIPPED, reason: 'not_due' });
            continue;
          }
        }
        out.push(await reconcileResource(resource));
      } catch (err) {
        // reconcileResource 已經把可預期的錯誤都結案了；這是最後防線。
        log.error('reconcile_unhandled', { user_id: uid, resource, error: describeError(err) });
        out.push({ resource, result: RECONCILE_RESULT.FAILED, errorClass: ERROR_CLASS.INTERNAL });
      }
    }
    return out;
  }

  return { reconcileAll, reconcileResource, owner };
}
