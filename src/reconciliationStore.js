/**
 * 對帳的耐久儲存層（V1.2 Phase 2）。
 *
 * 四件事，全部 per-user / per-resource：
 *   1. 狀態列（水位、續傳、租約、退避）—— whoop_reconciliation_state
 *   2. 執行帳本 —— whoop_reconciliation_runs
 *   3. 差異紀錄 —— whoop_reconciliation_discrepancies
 *   4. 墓碑的對帳診斷欄位 —— whoop_resource_tombstones.reconcile_*（只寫診斷，不改 state）
 *
 * ## 權威一律是資料庫
 *
 * 認領、水位前進、續傳存檔，每一句都把「我還是不是擁有者、租約還有沒有效」
 * 寫進 WHERE。失去所有權的執行拿到 rowsAffected = 0，寫不進任何狀態。
 * 這與 whoop_webhook_events / report_claims 是同一套模式。
 */

import { requireUserId } from './userContext.js';
import { RECONCILE_RESULT, TOMBSTONE_STATE, TOMBSTONE_RECONCILE_VERDICT } from './schema.js';
import { log } from './logger.js';

const iso = (v) => (v instanceof Date ? v.toISOString() : new Date(v).toISOString());

// Production callers pass a captured lifecycle generation. `null` is reserved for
// the explicit administrator repair mode selected by createReconciler. Keeping the
// predicate in the same SQL statement as each mutation closes both disable and ABA
// races; a check performed before the statement would still leave a write window.
const LIFECYCLE_PREDICATE = `(? IS NULL OR EXISTS (
  SELECT 1 FROM users lifecycle_user
   WHERE lifecycle_user.id = ?
     AND lifecycle_user.status = 'ACTIVE'
     AND lifecycle_user.lifecycle_generation = ?
))`;
const lifecycleArgs = (uid, generation) => [generation, uid, generation];

// Diagnostics are reconciliation output too. Normal workers must still own the
// exact per-user/per-state-resource lease when the diagnostic statement commits.
// The base diagnostic resource (`sleep`) may use either its FAST state key
// (`sleep`) or its explicit DEEP key (`sleep/deep`); no other pairing is valid.
const RECONCILIATION_OWNERSHIP_PREDICATE = `EXISTS (
  SELECT 1 FROM whoop_reconciliation_state diagnostic_owner
   WHERE diagnostic_owner.user_id = ?
     AND diagnostic_owner.resource = ?
     AND diagnostic_owner.owner = ?
     AND diagnostic_owner.lease_expires_at > ?
)`;
const ownershipArgs = (uid, stateResource, owner, nowIso) => [
  uid, stateResource, String(owner), nowIso,
];
const ownsDiagnosticResource = (resource, stateResource) => {
  const base = String(resource);
  const state = String(stateResource ?? '');
  return state === base || state === `${base}/deep`;
};

export function createReconciliationStore(client) {
  const rowToState = (r) => (r ? {
    userId: String(r.user_id),
    resource: String(r.resource),
    windowWatermark: r.window_watermark ?? null,
    latestRemoteUpdatedAt: r.latest_remote_updated_at ?? null,
    continuationToken: r.continuation_token ?? null,
    continuationFrom: r.continuation_from ?? null,
    continuationTo: r.continuation_to ?? null,
    owner: r.owner ?? null,
    leaseExpiresAt: r.lease_expires_at ?? null,
    lastAttemptAt: r.last_attempt_at ?? null,
    lastSuccessAt: r.last_success_at ?? null,
    lastFailureAt: r.last_failure_at ?? null,
    lastErrorClass: r.last_error_class ?? null,
    lastErrorDetail: r.last_error_detail ?? null,
    consecutiveFailures: Number(r.consecutive_failures ?? 0),
    nextAttemptAt: r.next_attempt_at ?? null,
  } : null);

  async function getReconciliationState(userId, resource) {
    const uid = requireUserId(userId, 'getReconciliationState');
    const rs = await client.execute({
      sql: 'SELECT * FROM whoop_reconciliation_state WHERE user_id = ? AND resource = ?',
      args: [uid, resource],
    });
    return rowToState(rs.rows[0]);
  }

  async function getAllReconciliationState(userId) {
    const uid = requireUserId(userId, 'getAllReconciliationState');
    const rs = await client.execute({
      sql: 'SELECT * FROM whoop_reconciliation_state WHERE user_id = ? ORDER BY resource',
      args: [uid],
    });
    return rs.rows.map(rowToState);
  }

  /**
   * 認領一個 (user, resource) 的對帳權。
   *
   * 沒有列 → 建一列並持有。有列 → 只有在「沒人握著或租約已過期」時才接手。
   * 原子：INSERT ... ON CONFLICT DO UPDATE ... WHERE 租約已過期。
   *
   * 退避（next_attempt_at）在**這裡**不檢查 —— 那是「該不該跑」的決定，
   * 由呼叫端用 isReconcileDue 判斷；認領只回答「能不能持有」。
   */
  async function claimReconciliation({
    userId, resource, owner, leaseMs, now = new Date(), lifecycleGeneration = null,
  }) {
    const uid = requireUserId(userId, 'claimReconciliation');
    if (!owner) throw new Error('reconcile_owner_required');
    const nowIso = iso(now);
    const leaseIso = iso(new Date(new Date(now).getTime() + leaseMs));
    const rs = await client.execute({
      sql: `INSERT INTO whoop_reconciliation_state
              (user_id, resource, owner, lease_expires_at, last_attempt_at, created_at, updated_at)
            SELECT ?, ?, ?, ?, ?, ?, ?
             WHERE ${LIFECYCLE_PREDICATE}
            ON CONFLICT(user_id, resource) DO UPDATE SET
              owner = excluded.owner,
              lease_expires_at = excluded.lease_expires_at,
              last_attempt_at = excluded.last_attempt_at,
              updated_at = excluded.updated_at
            WHERE whoop_reconciliation_state.owner IS NULL
               OR whoop_reconciliation_state.lease_expires_at IS NULL
               OR whoop_reconciliation_state.lease_expires_at <= excluded.last_attempt_at`,
      args: [uid, resource, String(owner), leaseIso, nowIso, nowIso, nowIso,
        ...lifecycleArgs(uid, lifecycleGeneration)],
    });
    const got = Number(rs.rowsAffected ?? 0) > 0;
    if (!got) log.info('reconcile_claim_busy', { user_id: uid, resource });
    return got;
  }

  /** 我**現在**還握著這個 (user, resource) 嗎？ */
  async function holdsReconciliation({ userId, resource, owner, now = new Date() }) {
    const uid = requireUserId(userId, 'holdsReconciliation');
    if (!owner) return false;
    const rs = await client.execute({
      sql: `SELECT 1 FROM whoop_reconciliation_state
             WHERE user_id = ? AND resource = ? AND owner = ? AND lease_expires_at > ? LIMIT 1`,
      args: [uid, resource, String(owner), iso(now)],
    });
    return rs.rows.length > 0;
  }

  /**
   * 把這一輪要做的**邏輯窗**寫成耐久的「未完成窗」（P2-R02）。
   *
   * 窗一旦寫下，就只有 SUCCESS 能清掉它。PARTIAL 在它上面加續傳 token、
   * FAILED 只清 token —— 所以任何失敗之後，下一輪都會**用同一個窗從第一頁
   * 重來**，而不是用往前走的時鐘重算一個新窗、讓窗的下緣永遠掉出去。
   *
   * 帶 owner + 租約圍欄；明確窗（backfill）不呼叫這一支。
   */
  async function openPendingWindow({
    userId, resource, owner, from, to, now = new Date(), lifecycleGeneration = null,
  }) {
    const uid = requireUserId(userId, 'openPendingWindow');
    if (!owner) return false;
    const nowIso = iso(now);
    const rs = await client.execute({
      sql: `UPDATE whoop_reconciliation_state
               SET continuation_from = ?, continuation_to = ?, updated_at = ?
             WHERE user_id = ? AND resource = ? AND owner = ? AND lease_expires_at > ?
               AND ${LIFECYCLE_PREDICATE}`,
      args: [iso(from), iso(to), nowIso, uid, resource, String(owner), nowIso,
        ...lifecycleArgs(uid, lifecycleGeneration)],
    });
    return Number(rs.rowsAffected ?? 0) > 0;
  }

  /**
   * 結案 —— 一句原子 UPDATE，帶 owner + 租約圍欄。
   *
   *   SUCCESS  依 watermarkMode 處理水位；清掉未完成窗與續傳；成功時間；失敗計數歸零
   *              'advance'  window_watermark = MAX(舊, 窗 end)   —— 快路徑（單調不減）
   *              'set'      window_watermark = cursor            —— 深度游標（輪轉，可倒退）
   *              'keep'     不動                                  —— 明確窗（backfill）
   *   PARTIAL  存續傳 token + 窗；**水位不動**
   *   FAILED   失敗計數 +1；退避；**水位不動**；**只清 token、保留未完成窗**（P2-R02）
   *
   * 三種都會釋放租約（owner = NULL）。失去所有權的執行寫不進任何東西。
   */
  async function settleReconciliation({
    userId, resource, owner, result, windowTo = null, cursor = null,
    continuation = null, latestRemoteUpdatedAt = null,
    errorClass = null, errorDetail = null, nextAttemptAt = null, now = new Date(),
    watermarkMode = 'advance',
    lifecycleGeneration = null,
  }) {
    const uid = requireUserId(userId, 'settleReconciliation');
    if (!owner) return false;
    const nowIso = iso(now);
    let rs;
    if (result === RECONCILE_RESULT.SUCCESS) {
      if (!['advance', 'set', 'keep'].includes(watermarkMode)) {
        throw new Error(`invalid_watermark_mode:${watermarkMode}`);
      }
      if (watermarkMode === 'advance' && !windowTo) throw new Error('reconcile_success_requires_window_to');
      if (watermarkMode === 'set' && !cursor) throw new Error('reconcile_success_requires_cursor');
      const watermarkSql = watermarkMode === 'advance'
        ? 'window_watermark = MAX(COALESCE(window_watermark, \'\'), ?),'
        : watermarkMode === 'set' ? 'window_watermark = ?,' : 'window_watermark = COALESCE(?, window_watermark),';
      const watermarkArg = watermarkMode === 'advance' ? iso(windowTo)
        : watermarkMode === 'set' ? iso(cursor) : null;
      // 'keep'（明確窗）不清未完成窗 / 續傳：那是常規對帳的進度，不能被額外補一段改寫。
      const clearPendingSql = watermarkMode === 'keep' ? ''
        : 'continuation_token = NULL, continuation_from = NULL, continuation_to = NULL,';
      const successSql = watermarkMode === 'keep' ? ''
        : 'last_success_at = ?, last_error_class = NULL, last_error_detail = NULL, consecutive_failures = 0, next_attempt_at = NULL,';
      rs = await client.execute({
        sql: `UPDATE whoop_reconciliation_state
                 SET ${watermarkSql}
                     latest_remote_updated_at = COALESCE(?, latest_remote_updated_at),
                     ${clearPendingSql}
                     owner = NULL, lease_expires_at = NULL,
                     ${successSql}
                     updated_at = ?
               WHERE user_id = ? AND resource = ? AND owner = ? AND lease_expires_at > ?
                 AND ${LIFECYCLE_PREDICATE}`,
        args: [watermarkArg, latestRemoteUpdatedAt,
          ...(watermarkMode === 'keep' ? [] : [nowIso]), nowIso,
          uid, resource, String(owner), nowIso,
          ...lifecycleArgs(uid, lifecycleGeneration)],
      });
    } else if (result === RECONCILE_RESULT.PARTIAL) {
      rs = await client.execute({
        sql: `UPDATE whoop_reconciliation_state
                 SET continuation_token = ?, continuation_from = ?, continuation_to = ?,
                     latest_remote_updated_at = COALESCE(?, latest_remote_updated_at),
                     owner = NULL, lease_expires_at = NULL,
                     last_error_class = NULL, last_error_detail = NULL,
                     next_attempt_at = NULL, updated_at = ?
               WHERE user_id = ? AND resource = ? AND owner = ? AND lease_expires_at > ?
                 AND ${LIFECYCLE_PREDICATE}`,
        args: [continuation?.token ?? null,
          continuation?.from ? iso(continuation.from) : null,
          continuation?.to ? iso(continuation.to) : null,
          latestRemoteUpdatedAt, nowIso,
          uid, resource, String(owner), nowIso,
          ...lifecycleArgs(uid, lifecycleGeneration)],
      });
    } else if (result === RECONCILE_RESULT.FAILED) {
      // P2-R02：失敗**只清 token、保留未完成窗**。下一輪用同一個 [from, to]
      // 從第一頁重抓（寫入冪等，重抓安全）。不清 token 的話，一個永遠無效的
      // token 會讓這個資源卡死在同一頁；清了窗的話，往前走的時鐘會讓窗的下緣
      // 永遠掉出去。
      rs = await client.execute({
        sql: `UPDATE whoop_reconciliation_state
                 SET owner = NULL, lease_expires_at = NULL,
                     continuation_token = NULL,
                     last_failure_at = ?, last_error_class = ?, last_error_detail = ?,
                     consecutive_failures = consecutive_failures + 1,
                     next_attempt_at = ?, updated_at = ?
               WHERE user_id = ? AND resource = ? AND owner = ? AND lease_expires_at > ?
                 AND ${LIFECYCLE_PREDICATE}`,
        args: [nowIso, errorClass, errorDetail ? String(errorDetail).slice(0, 300) : null,
          nextAttemptAt ? iso(nextAttemptAt) : null, nowIso,
          uid, resource, String(owner), nowIso,
          ...lifecycleArgs(uid, lifecycleGeneration)],
      });
    } else {
      throw new Error(`invalid_reconcile_result:${result}`);
    }
    return Number(rs.rowsAffected ?? 0) > 0;
  }

  // ----- 執行帳本 ---------------------------------------------------------
  async function openReconciliationRun({
    userId, resource, owner, mode, windowFrom = null, windowTo = null, now = new Date(),
  }) {
    const uid = requireUserId(userId, 'openReconciliationRun');
    const rs = await client.execute({
      sql: `INSERT INTO whoop_reconciliation_runs
              (user_id, resource, owner, mode, window_from, window_to, started_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [uid, resource, String(owner), mode,
        windowFrom ? iso(windowFrom) : null, windowTo ? iso(windowTo) : null, iso(now)],
    });
    return Number(rs.lastInsertRowid ?? 0);
  }

  async function closeReconciliationRun(runId, {
    result, pages = 0, fetched = 0, written = 0, blocked = 0,
    errorClass = null, errorDetail = null, retryable = null, now = new Date(),
  }) {
    await client.execute({
      sql: `UPDATE whoop_reconciliation_runs
               SET finished_at = ?, result = ?, pages = ?, fetched = ?, written = ?, blocked = ?,
                   error_class = ?, error_detail = ?, retryable = ?
             WHERE id = ?`,
      args: [iso(now), result, pages, fetched, written, blocked,
        errorClass, errorDetail ? String(errorDetail).slice(0, 300) : null,
        retryable === null ? null : (retryable ? 1 : 0), Number(runId)],
    });
  }

  async function recentReconciliationRuns(userId, { resource = null, limit = 20 } = {}) {
    const uid = requireUserId(userId, 'recentReconciliationRuns');
    const rs = resource
      ? await client.execute({
        sql: `SELECT * FROM whoop_reconciliation_runs WHERE user_id = ? AND resource = ?
               ORDER BY id DESC LIMIT ?`,
        args: [uid, resource, limit],
      })
      : await client.execute({
        sql: 'SELECT * FROM whoop_reconciliation_runs WHERE user_id = ? ORDER BY id DESC LIMIT ?',
        args: [uid, limit],
      });
    return rs.rows.map((r) => ({
      id: Number(r.id), resource: String(r.resource), owner: String(r.owner), mode: String(r.mode),
      windowFrom: r.window_from ?? null, windowTo: r.window_to ?? null,
      startedAt: r.started_at, finishedAt: r.finished_at ?? null, result: r.result ?? null,
      pages: Number(r.pages ?? 0), fetched: Number(r.fetched ?? 0),
      written: Number(r.written ?? 0), blocked: Number(r.blocked ?? 0),
      errorClass: r.error_class ?? null, errorDetail: r.error_detail ?? null,
      retryable: r.retryable === null || r.retryable === undefined ? null : Number(r.retryable) === 1,
    }));
  }

  // ----- 差異紀錄 ---------------------------------------------------------
  /** 記一筆差異。同一個 (user, resource, id, kind) 只有一列，重複看到就累加。 */
  async function recordDiscrepancy({
    userId, resource, resourceId, kind, windowFrom = null, windowTo = null, now = new Date(),
    lifecycleGeneration = null, owner = null, reconciliationResource = null,
  }) {
    const uid = requireUserId(userId, 'recordDiscrepancy');
    if (!owner || !ownsDiagnosticResource(resource, reconciliationResource)) return false;
    const nowIso = iso(now);
    const rs = await client.execute({
      sql: `INSERT INTO whoop_reconciliation_discrepancies
              (user_id, resource, resource_id, kind, first_seen_at, last_seen_at, seen_count,
               window_from, window_to)
            SELECT ?, ?, ?, ?, ?, ?, 1, ?, ?
             WHERE ${LIFECYCLE_PREDICATE}
               AND ${RECONCILIATION_OWNERSHIP_PREDICATE}
            ON CONFLICT(user_id, resource, resource_id, kind) DO UPDATE SET
              last_seen_at = excluded.last_seen_at,
              seen_count = whoop_reconciliation_discrepancies.seen_count + 1,
              window_from = excluded.window_from,
              window_to = excluded.window_to`,
      args: [uid, resource, String(resourceId), kind, nowIso, nowIso,
        windowFrom ? iso(windowFrom) : null, windowTo ? iso(windowTo) : null,
        ...lifecycleArgs(uid, lifecycleGeneration),
        ...ownershipArgs(uid, reconciliationResource, owner, nowIso)],
    });
    return Number(rs.rowsAffected ?? 0) > 0;
  }

  async function listDiscrepancies(userId, { resource = null } = {}) {
    const uid = requireUserId(userId, 'listDiscrepancies');
    const rs = resource
      ? await client.execute({
        sql: `SELECT * FROM whoop_reconciliation_discrepancies
               WHERE user_id = ? AND resource = ? ORDER BY last_seen_at DESC`,
        args: [uid, resource],
      })
      : await client.execute({
        sql: 'SELECT * FROM whoop_reconciliation_discrepancies WHERE user_id = ? ORDER BY last_seen_at DESC',
        args: [uid],
      });
    return rs.rows.map((r) => ({
      resource: String(r.resource), resourceId: String(r.resource_id), kind: String(r.kind),
      firstSeenAt: r.first_seen_at, lastSeenAt: r.last_seen_at, seenCount: Number(r.seen_count ?? 0),
      windowFrom: r.window_from ?? null, windowTo: r.window_to ?? null,
    }));
  }

  // ----- 墓碑的對帳診斷 -------------------------------------------------
  /** 這個使用者、這種資源、需要（重新）檢查的 ACTIVE 墓碑。 */
  async function tombstonesDueForCheck(userId, resourceType, { recheckMs, limit, now = new Date() }) {
    const uid = requireUserId(userId, 'tombstonesDueForCheck');
    const cutoff = iso(new Date(new Date(now).getTime() - recheckMs));
    const rs = await client.execute({
      sql: `SELECT resource_id, last_known_updated_at, reconcile_verdict
              FROM whoop_resource_tombstones
             WHERE user_id = ? AND resource_type = ? AND state = ?
               AND (reconcile_checked_at IS NULL OR reconcile_checked_at <= ?)
             ORDER BY reconcile_checked_at IS NOT NULL, reconcile_checked_at
             LIMIT ?`,
      args: [uid, resourceType, TOMBSTONE_STATE.ACTIVE, cutoff, Number(limit)],
    });
    return rs.rows.map((r) => ({
      resourceId: String(r.resource_id),
      lastKnownUpdatedAt: r.last_known_updated_at ?? null,
      previousVerdict: r.reconcile_verdict ?? null,
    }));
  }

  /**
   * 寫下對帳對某個 ACTIVE 墓碑的**診斷**判定。
   *
   * ★ 只更新 reconcile_* 欄位。WHERE 帶 state = ACTIVE 而且 SET 裡沒有 state ——
   * 這支函式在結構上就不可能讓墓碑退位。
   */
  async function recordTombstoneVerdict({
    userId, resourceType, resourceId, verdict, remoteUpdatedAt = null, now = new Date(),
    lifecycleGeneration = null, owner = null, reconciliationResource = null,
  }) {
    const uid = requireUserId(userId, 'recordTombstoneVerdict');
    if (!Object.values(TOMBSTONE_RECONCILE_VERDICT).includes(verdict)) {
      throw new Error(`invalid_tombstone_verdict:${verdict}`);
    }
    if (!owner || !ownsDiagnosticResource(resourceType, reconciliationResource)) return false;
    const nowIso = iso(now);
    const rs = await client.execute({
      sql: `UPDATE whoop_resource_tombstones
               SET reconcile_checked_at = ?, reconcile_verdict = ?, reconcile_remote_updated_at = ?,
                   updated_at = ?
             WHERE user_id = ? AND resource_type = ? AND resource_id = ? AND state = ?
               AND ${LIFECYCLE_PREDICATE}
               AND ${RECONCILIATION_OWNERSHIP_PREDICATE}`,
      args: [nowIso, verdict, remoteUpdatedAt, nowIso,
        uid, resourceType, String(resourceId), TOMBSTONE_STATE.ACTIVE,
        ...lifecycleArgs(uid, lifecycleGeneration),
        ...ownershipArgs(uid, reconciliationResource, owner, nowIso)],
    });
    return Number(rs.rowsAffected ?? 0) > 0;
  }

  return {
    getReconciliationState,
    getAllReconciliationState,
    claimReconciliation,
    holdsReconciliation,
    openPendingWindow,
    settleReconciliation,
    openReconciliationRun,
    closeReconciliationRun,
    recentReconciliationRuns,
    recordDiscrepancy,
    listDiscrepancies,
    tombstonesDueForCheck,
    recordTombstoneVerdict,
  };
}
