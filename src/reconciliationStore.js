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
  async function claimReconciliation({ userId, resource, owner, leaseMs, now = new Date() }) {
    const uid = requireUserId(userId, 'claimReconciliation');
    if (!owner) throw new Error('reconcile_owner_required');
    const nowIso = iso(now);
    const leaseIso = iso(new Date(new Date(now).getTime() + leaseMs));
    const rs = await client.execute({
      sql: `INSERT INTO whoop_reconciliation_state
              (user_id, resource, owner, lease_expires_at, last_attempt_at, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(user_id, resource) DO UPDATE SET
              owner = excluded.owner,
              lease_expires_at = excluded.lease_expires_at,
              last_attempt_at = excluded.last_attempt_at,
              updated_at = excluded.updated_at
            WHERE whoop_reconciliation_state.owner IS NULL
               OR whoop_reconciliation_state.lease_expires_at IS NULL
               OR whoop_reconciliation_state.lease_expires_at <= excluded.last_attempt_at`,
      args: [uid, resource, String(owner), leaseIso, nowIso, nowIso, nowIso],
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
   * 結案 —— 一句原子 UPDATE，帶 owner + 租約圍欄。
   *
   *   SUCCESS  水位 = 窗的 end；清掉續傳；成功時間；失敗計數歸零
   *   PARTIAL  存續傳 token + 窗；**水位不動**
   *   FAILED   失敗計數 +1；退避；**水位不動**；續傳保留（下一輪可從同處繼續）
   *
   * 三種都會釋放租約（owner = NULL）。失去所有權的執行寫不進任何東西。
   */
  async function settleReconciliation({
    userId, resource, owner, result, windowTo = null,
    continuation = null, latestRemoteUpdatedAt = null,
    errorClass = null, errorDetail = null, nextAttemptAt = null, now = new Date(),
    advanceWatermark = true,
  }) {
    const uid = requireUserId(userId, 'settleReconciliation');
    if (!owner) return false;
    const nowIso = iso(now);
    let rs;
    if (result === RECONCILE_RESULT.SUCCESS && advanceWatermark) {
      if (!windowTo) throw new Error('reconcile_success_requires_window_to');
      rs = await client.execute({
        sql: `UPDATE whoop_reconciliation_state
                 SET window_watermark = MAX(COALESCE(window_watermark, ''), ?),
                     latest_remote_updated_at = COALESCE(?, latest_remote_updated_at),
                     continuation_token = NULL, continuation_from = NULL, continuation_to = NULL,
                     owner = NULL, lease_expires_at = NULL,
                     last_success_at = ?, last_error_class = NULL, last_error_detail = NULL,
                     consecutive_failures = 0, next_attempt_at = NULL, updated_at = ?
               WHERE user_id = ? AND resource = ? AND owner = ? AND lease_expires_at > ?`,
        args: [iso(windowTo), latestRemoteUpdatedAt, nowIso, nowIso,
          uid, resource, String(owner), nowIso],
      });
    } else if (result === RECONCILE_RESULT.SUCCESS) {
      // 明確窗（backfill / 修復）成功：**水位與續傳都不動**。它是額外補一段，
      // 不是常規對帳；常規對帳的進度不能被它改寫。
      rs = await client.execute({
        sql: `UPDATE whoop_reconciliation_state
                 SET latest_remote_updated_at = COALESCE(?, latest_remote_updated_at),
                     owner = NULL, lease_expires_at = NULL, updated_at = ?
               WHERE user_id = ? AND resource = ? AND owner = ? AND lease_expires_at > ?`,
        args: [latestRemoteUpdatedAt, nowIso, uid, resource, String(owner), nowIso],
      });
    } else if (result === RECONCILE_RESULT.PARTIAL) {
      rs = await client.execute({
        sql: `UPDATE whoop_reconciliation_state
                 SET continuation_token = ?, continuation_from = ?, continuation_to = ?,
                     latest_remote_updated_at = COALESCE(?, latest_remote_updated_at),
                     owner = NULL, lease_expires_at = NULL,
                     last_error_class = NULL, last_error_detail = NULL,
                     next_attempt_at = NULL, updated_at = ?
               WHERE user_id = ? AND resource = ? AND owner = ? AND lease_expires_at > ?`,
        args: [continuation?.token ?? null,
          continuation?.from ? iso(continuation.from) : null,
          continuation?.to ? iso(continuation.to) : null,
          latestRemoteUpdatedAt, nowIso,
          uid, resource, String(owner), nowIso],
      });
    } else if (result === RECONCILE_RESULT.FAILED) {
      // 失敗也清掉續傳：下一輪從頭重抓同一個窗（寫入冪等，重抓安全）。
      // 不清的話，一個永遠無效的 token 會讓這個資源卡死在同一頁。
      rs = await client.execute({
        sql: `UPDATE whoop_reconciliation_state
                 SET owner = NULL, lease_expires_at = NULL,
                     continuation_token = NULL, continuation_from = NULL, continuation_to = NULL,
                     last_failure_at = ?, last_error_class = ?, last_error_detail = ?,
                     consecutive_failures = consecutive_failures + 1,
                     next_attempt_at = ?, updated_at = ?
               WHERE user_id = ? AND resource = ? AND owner = ? AND lease_expires_at > ?`,
        args: [nowIso, errorClass, errorDetail ? String(errorDetail).slice(0, 300) : null,
          nextAttemptAt ? iso(nextAttemptAt) : null, nowIso,
          uid, resource, String(owner), nowIso],
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
  }) {
    const uid = requireUserId(userId, 'recordDiscrepancy');
    const nowIso = iso(now);
    await client.execute({
      sql: `INSERT INTO whoop_reconciliation_discrepancies
              (user_id, resource, resource_id, kind, first_seen_at, last_seen_at, seen_count,
               window_from, window_to)
            VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
            ON CONFLICT(user_id, resource, resource_id, kind) DO UPDATE SET
              last_seen_at = excluded.last_seen_at,
              seen_count = whoop_reconciliation_discrepancies.seen_count + 1,
              window_from = excluded.window_from,
              window_to = excluded.window_to`,
      args: [uid, resource, String(resourceId), kind, nowIso, nowIso,
        windowFrom ? iso(windowFrom) : null, windowTo ? iso(windowTo) : null],
    });
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
  }) {
    const uid = requireUserId(userId, 'recordTombstoneVerdict');
    if (!Object.values(TOMBSTONE_RECONCILE_VERDICT).includes(verdict)) {
      throw new Error(`invalid_tombstone_verdict:${verdict}`);
    }
    const rs = await client.execute({
      sql: `UPDATE whoop_resource_tombstones
               SET reconcile_checked_at = ?, reconcile_verdict = ?, reconcile_remote_updated_at = ?,
                   updated_at = ?
             WHERE user_id = ? AND resource_type = ? AND resource_id = ? AND state = ?`,
      args: [iso(now), verdict, remoteUpdatedAt, iso(now),
        uid, resourceType, String(resourceId), TOMBSTONE_STATE.ACTIVE],
    });
    return Number(rs.rowsAffected ?? 0) > 0;
  }

  return {
    getReconciliationState,
    getAllReconciliationState,
    claimReconciliation,
    holdsReconciliation,
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
