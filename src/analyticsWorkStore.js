/**
 * 分析工作的耐久儲存層（V1.2 Phase 3）。
 *
 * 四件事，全部 per-user：
 *   1. 失效（generation + 受影響範圍）—— analytics_invalidation
 *   2. 每個類別的工作狀態（done_generation、租約、退避）—— analytics_work_state
 *   3. 輕量物化 —— analytics_daily_state
 *   4. 執行帳本 —— analytics_runs
 *
 * ## 權威一律是資料庫
 *
 * 認領、結案每一句都把「我還是不是持有者、租約還有沒有效」寫進 WHERE；
 * 結案再加一層 generation 的 CAS。失去所有權的執行拿到 rowsAffected = 0。
 * 這與 whoop_reconciliation_state / whoop_webhook_events 是同一套模式。
 *
 * ## markAnalyticsDirty 只能在 canonical 交易裡呼叫
 *
 * 它不自己開交易：呼叫端（analyticsInvalidation.js 的包裝器）已經在
 * processing.transaction 裡，所以這裡的 UPDATE 與 canonical 寫入一起提交。
 * 讀-改-寫是安全的：processing.transaction 用 BEGIN IMMEDIATE，寫入者序列化。
 */

import { requireUserId } from './userContext.js';
import { ANALYTICS_CLASS, ANALYTICS_RESULT, ANALYTICS_FRESHNESS } from './schema.js';
import { log } from './logger.js';

const iso = (v) => (v instanceof Date ? v.toISOString() : new Date(v).toISOString());
const CLASSES = Object.values(ANALYTICS_CLASS);

const mergeCsv = (existing, add) => {
  const set = new Set(String(existing ?? '').split(',').filter(Boolean));
  for (const a of add ?? []) if (a) set.add(String(a));
  return [...set].sort().join(',') || null;
};
const minDate = (a, b) => (!a ? b : !b ? a : (a < b ? a : b));
const maxDate = (a, b) => (!a ? b : !b ? a : (a > b ? a : b));

export function createAnalyticsWorkStore(client) {
  const rowToInvalidation = (r) => (r ? {
    userId: String(r.user_id),
    generation: Number(r.generation ?? 0),
    affectedFrom: r.affected_from ?? null,
    affectedTo: r.affected_to ?? null,
    resources: r.resources ? String(r.resources).split(',') : [],
    reasons: r.reasons ? String(r.reasons).split(',') : [],
    dirtySince: r.dirty_since ?? null,
    lastInvalidatedAt: r.last_invalidated_at ?? null,
  } : null);

  const rowToWork = (r) => (r ? {
    userId: String(r.user_id),
    class: String(r.class),
    doneGeneration: Number(r.done_generation ?? 0),
    claimedGeneration: r.claimed_generation === null || r.claimed_generation === undefined ? null : Number(r.claimed_generation),
    owner: r.owner ?? null,
    leaseExpiresAt: r.lease_expires_at ?? null,
    status: r.status ?? null,
    lastAttemptAt: r.last_attempt_at ?? null,
    lastSuccessAt: r.last_success_at ?? null,
    lastFailureAt: r.last_failure_at ?? null,
    lastErrorClass: r.last_error_class ?? null,
    lastErrorDetail: r.last_error_detail ?? null,
    consecutiveFailures: Number(r.consecutive_failures ?? 0),
    nextAttemptAt: r.next_attempt_at ?? null,
    summary: r.summary_json ? JSON.parse(String(r.summary_json)) : null,
  } : null);

  // ----- 失效 -------------------------------------------------------------

  /**
   * 記錄「這個使用者的 canonical 真的變了」。**必須在 canonical 交易裡呼叫。**
   *
   * generation +1；受影響範圍取聯集；資源 / 原因合併。冪等到「同一交易裡
   * 呼叫多次也只是多 +1」的程度 —— generation 的絕對值沒有意義，只有
   * 「done < generation」有意義，所以多加幾次是無害的。
   *
   * @returns {number} 新的 generation
   */
  async function markAnalyticsDirty({
    userId, resource, reason, affectedFrom = null, affectedTo = null, now = new Date(),
  }) {
    const uid = requireUserId(userId, 'markAnalyticsDirty');
    const nowIso = iso(now);
    const cur = await client.execute({
      sql: 'SELECT * FROM analytics_invalidation WHERE user_id = ?', args: [uid],
    });
    const row = cur.rows[0];
    if (!row) {
      await client.execute({
        sql: `INSERT INTO analytics_invalidation
                (user_id, generation, affected_from, affected_to, resources, reasons,
                 dirty_since, last_invalidated_at, created_at, updated_at)
              VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [uid, affectedFrom, affectedTo, mergeCsv(null, [resource]), mergeCsv(null, [reason]),
          nowIso, nowIso, nowIso, nowIso],
      });
      log.info('analytics_invalidated', { user_id: uid, generation: 1, resource, reason });
      return 1;
    }
    const generation = Number(row.generation ?? 0) + 1;
    await client.execute({
      sql: `UPDATE analytics_invalidation
               SET generation = ?, affected_from = ?, affected_to = ?, resources = ?, reasons = ?,
                   dirty_since = COALESCE(dirty_since, ?), last_invalidated_at = ?, updated_at = ?
             WHERE user_id = ?`,
      args: [generation,
        minDate(row.affected_from ?? null, affectedFrom), maxDate(row.affected_to ?? null, affectedTo),
        mergeCsv(row.resources, [resource]), mergeCsv(row.reasons, [reason]),
        nowIso, nowIso, nowIso, uid],
    });
    log.info('analytics_invalidated', { user_id: uid, generation, resource, reason });
    return generation;
  }

  async function getAnalyticsInvalidation(userId) {
    const uid = requireUserId(userId, 'getAnalyticsInvalidation');
    const rs = await client.execute({ sql: 'SELECT * FROM analytics_invalidation WHERE user_id = ?', args: [uid] });
    return rowToInvalidation(rs.rows[0]);
  }

  // ----- 工作狀態 -----------------------------------------------------------

  async function getAnalyticsWorkState(userId, cls) {
    const uid = requireUserId(userId, 'getAnalyticsWorkState');
    const rs = await client.execute({
      sql: 'SELECT * FROM analytics_work_state WHERE user_id = ? AND class = ?', args: [uid, cls],
    });
    return rowToWork(rs.rows[0]);
  }

  /**
   * 哪些使用者在某個類別上落後（done_generation < generation），而且沒有在
   * 退避中、也沒有人握著有效租約。**有上限**（呼叫端的 max users）。
   * 最早失效的排前面。
   */
  async function listPendingAnalytics(cls, { limit = 10, now = new Date() } = {}) {
    if (!CLASSES.includes(cls)) throw new Error(`invalid_analytics_class:${cls}`);
    const nowIso = iso(now);
    const rs = await client.execute({
      sql: `SELECT i.user_id, i.generation, i.last_invalidated_at, i.dirty_since,
                   COALESCE(w.done_generation, 0) done_generation, w.next_attempt_at, w.owner, w.lease_expires_at
              FROM analytics_invalidation i
              LEFT JOIN analytics_work_state w ON w.user_id = i.user_id AND w.class = ?
             WHERE i.generation > COALESCE(w.done_generation, 0)
               AND (w.next_attempt_at IS NULL OR w.next_attempt_at <= ?)
               AND (w.owner IS NULL OR w.lease_expires_at IS NULL OR w.lease_expires_at <= ?)
             ORDER BY i.last_invalidated_at, i.user_id
             LIMIT ?`,
      args: [cls, nowIso, nowIso, Number(limit)],
    });
    return rs.rows.map((r) => ({
      userId: String(r.user_id), generation: Number(r.generation), doneGeneration: Number(r.done_generation ?? 0),
      lastInvalidatedAt: r.last_invalidated_at ?? null, dirtySince: r.dirty_since ?? null,
    }));
  }

  /**
   * 認領一個 (使用者, 類別) 的分析權。原子：INSERT … ON CONFLICT DO UPDATE …
   * WHERE 沒人握著或租約已過期。認領**不是**續租。
   *
   * @returns {?{generation:number, doneGeneration:number}} 認領時看到的 generation；沒拿到 → null
   */
  async function claimAnalyticsWork({ userId, cls, owner, leaseMs, now = new Date() }) {
    const uid = requireUserId(userId, 'claimAnalyticsWork');
    if (!CLASSES.includes(cls)) throw new Error(`invalid_analytics_class:${cls}`);
    if (!owner) throw new Error('analytics_owner_required');
    const nowIso = iso(now);
    const leaseIso = iso(new Date(new Date(now).getTime() + leaseMs));
    const rs = await client.execute({
      sql: `INSERT INTO analytics_work_state
              (user_id, class, owner, lease_expires_at, last_attempt_at, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, 'RUNNING', ?, ?)
            ON CONFLICT(user_id, class) DO UPDATE SET
              owner = excluded.owner,
              lease_expires_at = excluded.lease_expires_at,
              last_attempt_at = excluded.last_attempt_at,
              status = 'RUNNING',
              updated_at = excluded.updated_at
            WHERE analytics_work_state.owner IS NULL
               OR analytics_work_state.lease_expires_at IS NULL
               OR analytics_work_state.lease_expires_at <= excluded.last_attempt_at`,
      args: [uid, cls, String(owner), leaseIso, nowIso, nowIso, nowIso],
    });
    if (Number(rs.rowsAffected ?? 0) === 0) {
      log.info('analytics_claim_busy', { user_id: uid, class: cls });
      return null;
    }
    // 認領之後才讀 generation：認領成功前讀到的數字可能已經過期。
    const inv = await getAnalyticsInvalidation(uid);
    const work = await getAnalyticsWorkState(uid, cls);
    const generation = inv?.generation ?? 0;
    await client.execute({
      sql: `UPDATE analytics_work_state SET claimed_generation = ?, updated_at = ?
             WHERE user_id = ? AND class = ? AND owner = ? AND lease_expires_at > ?`,
      args: [generation, nowIso, uid, cls, String(owner), nowIso],
    });
    return {
      generation, doneGeneration: work?.doneGeneration ?? 0,
      affectedFrom: inv?.affectedFrom ?? null, affectedTo: inv?.affectedTo ?? null,
      resources: inv?.resources ?? [], reasons: inv?.reasons ?? [],
    };
  }

  /**
   * 結案 —— owner + 租約圍欄，成功時再加 generation 的 CAS。
   *
   *   SUCCESS  done_generation = 認領時的 generation（不是「現在的」）；失敗歸零；
   *            **只有** generation 仍等於 claimed 時才清受影響範圍（輕量）。
   *            若此時 generation 已前進，done < generation 仍成立 → 仍然髒，範圍保留。
   *   FAILED   done_generation 不動；失敗 +1；退避。
   *
   * 兩者都釋放租約。失去所有權的執行寫不進任何東西（回 false）。
   */
  async function settleAnalyticsWork({
    userId, cls, owner, result, generation, summary = null,
    errorClass = null, errorDetail = null, nextAttemptAt = null, clearRange = false, now = new Date(),
  }) {
    const uid = requireUserId(userId, 'settleAnalyticsWork');
    if (!owner) return false;
    const nowIso = iso(now);
    let rs;
    if (result === ANALYTICS_RESULT.SUCCESS) {
      if (!Number.isInteger(generation)) throw new Error('analytics_success_requires_generation');
      rs = await client.execute({
        sql: `UPDATE analytics_work_state
                 SET done_generation = MAX(done_generation, ?), status = 'SUCCESS',
                     owner = NULL, lease_expires_at = NULL, claimed_generation = NULL,
                     last_success_at = ?, last_error_class = NULL, last_error_detail = NULL,
                     consecutive_failures = 0, next_attempt_at = NULL,
                     summary_json = ?, updated_at = ?
               WHERE user_id = ? AND class = ? AND owner = ? AND lease_expires_at > ?`,
        args: [generation, nowIso, summary ? JSON.stringify(summary) : null, nowIso,
          uid, cls, String(owner), nowIso],
      });
      const settled = Number(rs.rowsAffected ?? 0) > 0;
      if (settled && clearRange) {
        // CAS：只有在沒有更新的 canonical 變動時才清範圍。
        await client.execute({
          sql: `UPDATE analytics_invalidation
                   SET affected_from = NULL, affected_to = NULL, resources = NULL, reasons = NULL, updated_at = ?
                 WHERE user_id = ? AND generation = ?`,
          args: [nowIso, uid, generation],
        });
      }
      if (settled) {
        // 所有類別都追上了 → dirty_since 清掉（純診斷）。
        await client.execute({
          sql: `UPDATE analytics_invalidation SET dirty_since = NULL, updated_at = ?
                 WHERE user_id = ?
                   AND NOT EXISTS (
                     SELECT 1 FROM analytics_work_state w
                      WHERE w.user_id = analytics_invalidation.user_id
                        AND w.done_generation < analytics_invalidation.generation)
                   AND (SELECT COUNT(*) FROM analytics_work_state w2 WHERE w2.user_id = analytics_invalidation.user_id) = ?`,
          args: [nowIso, uid, CLASSES.length],
        });
      }
      return settled;
    }
    if (result === ANALYTICS_RESULT.FAILED) {
      rs = await client.execute({
        sql: `UPDATE analytics_work_state
                 SET status = 'FAILED', owner = NULL, lease_expires_at = NULL, claimed_generation = NULL,
                     last_failure_at = ?, last_error_class = ?, last_error_detail = ?,
                     consecutive_failures = consecutive_failures + 1,
                     next_attempt_at = ?, updated_at = ?
               WHERE user_id = ? AND class = ? AND owner = ? AND lease_expires_at > ?`,
        args: [nowIso, errorClass, errorDetail ? String(errorDetail).slice(0, 300) : null,
          nextAttemptAt ? iso(nextAttemptAt) : null, nowIso,
          uid, cls, String(owner), nowIso],
      });
      return Number(rs.rowsAffected ?? 0) > 0;
    }
    throw new Error(`invalid_analytics_result:${result}`);
  }

  /**
   * 釋放租約而不結案（沒有要算：已經是最新、節奏未到）。done_generation 不動。
   * nextAttemptAt 可用來讓 listPendingAnalytics 在節奏到期前不再列出這個使用者。
   */
  async function releaseAnalyticsWork({ userId, cls, owner, nextAttemptAt = null, now = new Date() }) {
    const uid = requireUserId(userId, 'releaseAnalyticsWork');
    if (!owner) return false;
    const rs = await client.execute({
      sql: `UPDATE analytics_work_state
               SET owner = NULL, lease_expires_at = NULL, claimed_generation = NULL,
                   status = CASE WHEN status = 'RUNNING' THEN 'IDLE' ELSE status END,
                   next_attempt_at = ?, updated_at = ?
             WHERE user_id = ? AND class = ? AND owner = ?`,
      args: [nextAttemptAt ? iso(nextAttemptAt) : null, iso(now), uid, cls, String(owner)],
    });
    return Number(rs.rowsAffected ?? 0) > 0;
  }

  /** 這個 (使用者, 類別) 現在是不是還被 owner 有效持有。 */
  async function holdsAnalyticsWork({ userId, cls, owner, now = new Date() }) {
    const uid = requireUserId(userId, 'holdsAnalyticsWork');
    if (!owner) return false;
    const rs = await client.execute({
      sql: `SELECT 1 FROM analytics_work_state
             WHERE user_id = ? AND class = ? AND owner = ? AND lease_expires_at > ? LIMIT 1`,
      args: [uid, cls, String(owner), iso(now)],
    });
    return rs.rows.length > 0;
  }

  /**
   * 新鮮度：每個類別相對於目前 generation 的狀態。
   * 給日後 Phase 4 判斷「重量分析是不是最新的」用；不含任何生理數值。
   */
  async function getAnalyticsFreshness(userId) {
    const uid = requireUserId(userId, 'getAnalyticsFreshness');
    const inv = await getAnalyticsInvalidation(uid);
    const generation = inv?.generation ?? 0;
    const out = { userId: uid, generation, lastInvalidatedAt: inv?.lastInvalidatedAt ?? null, dirtySince: inv?.dirtySince ?? null };
    for (const cls of CLASSES) {
      const w = await getAnalyticsWorkState(uid, cls);
      const done = w?.doneGeneration ?? 0;
      let status;
      if (generation === 0 && done === 0) status = ANALYTICS_FRESHNESS.NEVER;
      else if (done >= generation) status = ANALYTICS_FRESHNESS.CURRENT;
      else if (w?.status === 'FAILED') status = ANALYTICS_FRESHNESS.FAILED;
      else status = ANALYTICS_FRESHNESS.PENDING;
      out[cls] = {
        status, doneGeneration: done, lastSuccessAt: w?.lastSuccessAt ?? null,
        lastFailureAt: w?.lastFailureAt ?? null, lastErrorClass: w?.lastErrorClass ?? null,
        owner: w?.owner ?? null, leaseExpiresAt: w?.leaseExpiresAt ?? null,
        nextAttemptAt: w?.nextAttemptAt ?? null, consecutiveFailures: w?.consecutiveFailures ?? 0,
      };
    }
    return out;
  }

  // ----- 輕量物化 -----------------------------------------------------------

  async function saveAnalyticsDailyState(userId, rows, { generation, now = new Date() }) {
    const uid = requireUserId(userId, 'saveAnalyticsDailyState');
    if (!Number.isInteger(generation)) throw new Error('analytics_daily_state_requires_generation');
    const nowIso = iso(now);
    let n = 0;
    for (const r of rows) {
      if (!r?.health_date) continue;
      await client.execute({
        sql: `INSERT INTO analytics_daily_state (user_id, health_date, generation, computed_at, daily_status, metrics_json)
              VALUES (?, ?, ?, ?, ?, ?)
              ON CONFLICT(user_id, health_date) DO UPDATE SET
                generation = excluded.generation, computed_at = excluded.computed_at,
                daily_status = excluded.daily_status, metrics_json = excluded.metrics_json
              WHERE excluded.generation >= analytics_daily_state.generation`,
        args: [uid, String(r.health_date), generation, nowIso, String(r.daily_status ?? 'UNKNOWN'), JSON.stringify(r.metrics)],
      });
      n += 1;
    }
    return n;
  }

  async function getAnalyticsDailyState(userId, { from = null, to = null } = {}) {
    const uid = requireUserId(userId, 'getAnalyticsDailyState');
    const rs = await client.execute({
      sql: `SELECT * FROM analytics_daily_state
             WHERE user_id = ? AND (? IS NULL OR health_date >= ?) AND (? IS NULL OR health_date <= ?)
             ORDER BY health_date`,
      args: [uid, from, from, to, to],
    });
    return rs.rows.map((r) => ({
      healthDate: String(r.health_date), generation: Number(r.generation), computedAt: r.computed_at,
      dailyStatus: String(r.daily_status), metrics: JSON.parse(String(r.metrics_json)),
    }));
  }

  // ----- 執行帳本 -----------------------------------------------------------

  async function openAnalyticsRun({ userId, cls, owner, generation, now = new Date() }) {
    const uid = requireUserId(userId, 'openAnalyticsRun');
    const rs = await client.execute({
      sql: `INSERT INTO analytics_runs (user_id, class, owner, generation, started_at) VALUES (?, ?, ?, ?, ?)`,
      args: [uid, cls, String(owner), Number(generation), iso(now)],
    });
    return Number(rs.lastInsertRowid ?? 0);
  }

  async function closeAnalyticsRun(runId, { result, detail = null, errorClass = null, errorDetail = null, now = new Date() }) {
    await client.execute({
      sql: `UPDATE analytics_runs SET finished_at = ?, result = ?, detail_json = ?, error_class = ?, error_detail = ? WHERE id = ?`,
      args: [iso(now), result, detail ? JSON.stringify(detail) : null, errorClass,
        errorDetail ? String(errorDetail).slice(0, 300) : null, Number(runId)],
    });
  }

  async function recentAnalyticsRuns(userId, { cls = null, limit = 20 } = {}) {
    const uid = requireUserId(userId, 'recentAnalyticsRuns');
    const rs = await client.execute({
      sql: `SELECT * FROM analytics_runs WHERE user_id = ? AND (? IS NULL OR class = ?) ORDER BY id DESC LIMIT ?`,
      args: [uid, cls, cls, Number(limit)],
    });
    return rs.rows.map((r) => ({
      id: Number(r.id), class: String(r.class), owner: String(r.owner), generation: Number(r.generation),
      startedAt: r.started_at, finishedAt: r.finished_at ?? null, result: r.result ?? null,
      detail: r.detail_json ? JSON.parse(String(r.detail_json)) : null,
      errorClass: r.error_class ?? null, errorDetail: r.error_detail ?? null,
    }));
  }

  return {
    markAnalyticsDirty,
    getAnalyticsInvalidation,
    getAnalyticsWorkState,
    listPendingAnalytics,
    claimAnalyticsWork,
    settleAnalyticsWork,
    releaseAnalyticsWork,
    holdsAnalyticsWork,
    getAnalyticsFreshness,
    saveAnalyticsDailyState,
    getAnalyticsDailyState,
    openAnalyticsRun,
    closeAnalyticsRun,
    recentAnalyticsRuns,
  };
}
