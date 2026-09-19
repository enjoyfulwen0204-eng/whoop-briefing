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
import { lifecycleActiveSql } from './schema.js';
import { requireLifecycle } from './accountLifecycle.js';
import { ANALYTICS_CLASS, ANALYTICS_RESULT, ANALYTICS_FRESHNESS, USER_STATUS } from './schema.js';
import { log } from './logger.js';
import { legacyScopeCompatibility } from './legacyScopeCompatibility.js';

const iso = (v) => (v instanceof Date ? v.toISOString() : new Date(v).toISOString());
const CLASSES = Object.values(ANALYTICS_CLASS);

const mergeCsv = (existing, add) => {
  const set = new Set(String(existing ?? '').split(',').filter(Boolean));
  for (const a of add ?? []) if (a) set.add(String(a));
  return [...set].sort().join(',') || null;
};
const minDate = (a, b) => (!a ? b : !b ? a : (a < b ? a : b));
const maxDate = (a, b) => (!a ? b : !b ? a : (a > b ? a : b));

/**
 * @param {object} client processing 代理 client
 * @param {function} opts.transaction processing.transaction —— 輸出寫入的圍欄交易（F01）
 */
export function createAnalyticsWorkStore(client, { transaction, privacyKeys } = {}) {
  if (typeof transaction !== 'function') throw new Error('analytics_store_requires_transaction');
  const scope = legacyScopeCompatibility(client, privacyKeys);
  const privacyLeaseSql=async()=>await scope.available()?`AND claimed_scope_revision=scope_revision
    AND EXISTS (SELECT 1 FROM phase4_user_state ps WHERE ps.user_id=analytics_work_state.user_id
      AND ps.pending_purge_count=0 AND ps.purge_generation=analytics_work_state.claimed_purge_generation)` : '';
  const rowToInvalidation = (r) => (r ? {
    userId: String(r.user_id),
    generation: Number(r.generation ?? 0),
    affectedFrom: r.scope_kind==='FULL_TENANT_RECOMPUTE'?null:r.affected_from ?? null,
    affectedTo: r.scope_kind==='FULL_TENANT_RECOMPUTE'?null:r.affected_to ?? null,
    resources: r.scope_kind==='FULL_TENANT_RECOMPUTE'?[]:r.resources ? String(r.resources).split(',') : [],
    reasons: r.reasons ? String(r.reasons).split(',') : [],
    dirtySince: r.dirty_since ?? null,
    lastInvalidatedAt: r.last_invalidated_at ?? null,
    ...(r.scope_kind ? { scopeKind: r.scope_kind } : {}),
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
    lastErrorDetail: r.scope_kind==='FULL_TENANT_RECOMPUTE'?null:r.last_error_detail ?? null,
    consecutiveFailures: Number(r.consecutive_failures ?? 0),
    nextAttemptAt: r.next_attempt_at ?? null,
    summary: r.scope_kind==='FULL_TENANT_RECOMPUTE'?{}:r.summary_json ? JSON.parse(String(r.summary_json)) : null,
    rangeGeneration: r.range_generation === null || r.range_generation === undefined ? null : Number(r.range_generation),
    rangeFrom: r.scope_kind==='FULL_TENANT_RECOMPUTE'?null:r.range_from ?? null,
    rangeTo: r.scope_kind==='FULL_TENANT_RECOMPUTE'?null:r.range_to ?? null,
    ...(r.scope_kind ? { scopeKind: r.scope_kind } : {}),
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
    userId, resource, reason, affectedFrom = null, affectedTo = null, fullRecompute=false, now = new Date(),
  }) {
    const uid = requireUserId(userId, 'markAnalyticsDirty');
    const nowIso = iso(now);
    const cur = await client.execute({
      sql: 'SELECT * FROM analytics_invalidation WHERE user_id = ?', args: [uid],
    });
    const row = cur.rows[0];
    const mergedFrom = fullRecompute?null:minDate(row?.affected_from ?? null, affectedFrom);
    const mergedTo = fullRecompute?null:maxDate(row?.affected_to ?? null, affectedTo);
    const privacy = await scope.range(uid, 'analytics_invalidation', mergedFrom, mergedTo, nowIso);
    if (!row) {
      await client.execute({
        sql: `INSERT INTO analytics_invalidation
                (user_id, generation, affected_from, affected_to, resources, reasons,
                 dirty_since, last_invalidated_at, created_at, updated_at${privacy.columns})
              VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?${privacy.placeholders})`,
        args: [uid, privacy.full ? null : affectedFrom, privacy.full ? null : affectedTo, privacy.full?null:mergeCsv(null, [resource]), privacy.full?'HEALTH_SCOPE_REDACTED':mergeCsv(null, [reason]),
          nowIso, nowIso, nowIso, nowIso, ...privacy.values],
      });
      log.info('analytics_invalidated', { user_id: uid, generation: 1, resource, reason });
      return 1;
    }
    const generation = Number(row.generation ?? 0) + 1;
    await client.execute({
      sql: `UPDATE analytics_invalidation
               SET generation = ?, affected_from = ?, affected_to = ?, resources = ?, reasons = ?,
                   dirty_since = COALESCE(dirty_since, ?), last_invalidated_at = ?, updated_at = ?${privacy.suffix}
             WHERE user_id = ?`,
      args: [generation,
        privacy.full ? null : mergedFrom, privacy.full ? null : mergedTo,
        privacy.full?null:mergeCsv(row.resources, [resource]), privacy.full?'HEALTH_SCOPE_REDACTED':mergeCsv(row.reasons, [reason]),
        nowIso, nowIso, nowIso, ...privacy.values, uid],
    });
    log.info('analytics_invalidated', { user_id: uid, generation, resource, reason });
    return generation;
  }

  async function getAnalyticsInvalidation(userId) {
    const uid = requireUserId(userId, 'getAnalyticsInvalidation');
    const rs = await client.execute({ sql: 'SELECT * FROM analytics_invalidation WHERE user_id = ?', args: [uid] });
    return rowToInvalidation(rs.rows[0]);
  }

  // ----- 所有權證明（F01）------------------------------------------------------

  /**
   * 「這個 owner **此刻**還握著這個 (使用者, 類別) 的有效租約，而且認領的是
   * 這一代」。租約到期時刻本身算過期（lease_expires_at > now，嚴格）。
   * 在圍欄交易裡執行 → 與寫入同一個 BEGIN IMMEDIATE，不存在 check 與 write 之間
   * 的空隙（TOCTOU）。
   *
   * ★ P3-RC1-F01：`now` 是**檢查當下**取的時刻，不是呼叫端稍早凍結的那一個。
   */
  async function proveOwnership({
    userId, cls, owner, generation, expectedLifecycleGeneration, now,
  }) {
    const life = requireLifecycle(expectedLifecycleGeneration, 'proveOwnership');
    if (await scope.available() && (await client.execute({
      sql: `SELECT 1 FROM analytics_invalidation WHERE user_id=? AND scope_kind='FULL_TENANT_RECOMPUTE'
        UNION ALL SELECT 1 FROM analytics_work_state WHERE user_id=? AND class=? AND scope_kind='FULL_TENANT_RECOMPUTE'`,
      args: [userId,userId,cls],
    })).rows.length) throw new Error('analytics_full_scope_requires_authorized_worker');
    const rs = await client.execute({
      sql: `SELECT 1 FROM analytics_work_state
             WHERE user_id = ? AND class = ? AND owner = ? AND lease_expires_at > ?
               AND claimed_generation = ? ${await privacyLeaseSql()} LIMIT 1`,
      args: [userId, cls, String(owner), iso(now), Number(generation)],
    });
    if (!rs.rows.length) throw new Error('analytics_ownership_lost');

    // ★ R2 / LIFE-FG-06：帳號啟用是**第四個**維度，加在 analytics generation、
    // 租約所有權、live clock 之上，一個都不取代。
    //
    // 分析世代擋不住這一種：停用（或停用再啟用）不會讓 analytics_invalidation
    // 前進，所以一個舊 worker 手上的 generation 仍然「正確」。
    if (life !== null) {
      const live = await client.execute({
        sql: `SELECT 1 FROM analytics_work_state w
                JOIN users u ON u.id = w.user_id
               WHERE w.user_id = ? AND w.class = ?
                 AND w.claimed_lifecycle IS ?
                 AND u.status = ? AND u.lifecycle_generation = ? LIMIT 1`,
        args: [userId, cls, expectedLifecycleGeneration,
          USER_STATUS.ACTIVE, expectedLifecycleGeneration],
      });
      if (!live.rows.length) {
        log.warn('analytics_lifecycle_rejected', {
          user_id: userId, class: cls, expected_lifecycle: expectedLifecycleGeneration,
        });
        throw new Error('analytics_account_inactive');
      }
    }
  }

  /**
   * 把一段耐久輸出寫入包進「所有權圍欄交易」：交易開始先證明所有權，交易結束
   * 前再證明一次，兩次都過才 commit。失去租約的執行在這裡被擋下 —— 不是事後
   * 檢查、不是事後刪除，而是寫入本身進不了資料庫。
   *
   * 昂貴的計算**不可以**放在 fn 裡：這是短的持久化交易。
   *
   * ## `now` 必須是**活的時鐘函式**（P3-RC1-F01）
   *
   * before 與 after 各自呼叫一次 `now()`，所以兩次檢查都拿到當下的時刻：
   *
   *   before:  now() → 證明 owner + generation + lease_expires_at > now()
   *   寫入
   *   after:   now() → 再證明一次（寫入期間才過期的話，這裡擋下 → 整段回滾）
   *
   * 傳一個**凍結的 Date**（或永遠回傳同一個瞬間的閉包）會讓租約證明用的是
   * 呼叫端稍早捕捉的時間 —— 昂貴計算跑完之後，那個時刻早就過去了，於是
   * 已經過期的工作者仍然寫得進去。這正是 P3-RC1-F01 的根因，所以這裡
   * **結構上拒絕** Date：不是函式就直接拋錯，不能靠呼叫端自律。
   */
  async function mutateForAnalytics({
    userId, cls, owner, generation, expectedLifecycleGeneration, now = () => new Date(),
  }, fn) {
    const uid = requireUserId(userId, 'mutateForAnalytics');
    // ★ R3 / R2-ANALYTICS-01：每一個輸出寫入都必須帶啟用脈絡。
    requireLifecycle(expectedLifecycleGeneration, 'mutateForAnalytics');
    if (!CLASSES.includes(cls)) throw new Error(`invalid_analytics_class:${cls}`);
    if (!owner) throw new Error('analytics_owner_required');
    if (!Number.isInteger(generation)) throw new Error('analytics_generation_required');
    if (typeof now !== 'function') throw new Error('analytics_live_clock_required');
    // 兩個 check 都是「現在再問一次」——刻意不共用同一個 Date。
    const check = () => proveOwnership({
      userId: uid, cls, owner, generation, expectedLifecycleGeneration, now: now(),
    });
    return transaction(fn, { before: check, after: check });
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
    const scoped = await scope.available();
    const rs = await client.execute({
      sql: `SELECT i.user_id, i.generation, i.last_invalidated_at, i.dirty_since,
                   COALESCE(w.done_generation, 0) done_generation, w.next_attempt_at, w.owner, w.lease_expires_at
              FROM analytics_invalidation i
              JOIN users u ON u.id = i.user_id
              LEFT JOIN analytics_work_state w ON w.user_id = i.user_id AND w.class = ?
             -- ★ v17：停用／暫停的帳號不產生新的分析計算。失效列本身保留
             -- （那是資料事實），只是不再被選出來做工。
             WHERE u.status = 'ACTIVE'
               ${scoped?"AND EXISTS (SELECT 1 FROM phase4_user_state ps WHERE ps.user_id=i.user_id AND ps.pending_purge_count=0)":''}
               AND (i.generation > COALESCE(w.done_generation, 0)
                 ${scoped ? "OR i.scope_kind = 'FULL_TENANT_RECOMPUTE' OR w.scope_kind = 'FULL_TENANT_RECOMPUTE'" : ''})
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
  /**
   * ★ R2 / LIFE-FG-06：認領要**捕捉帳號啟用世代**，而且只有 ACTIVE 帳號
   * 才認領得到。
   *
   * 選取層過濾 ACTIVE 不夠：低階的認領 API 可以被直接呼叫，而且選到與認領
   * 之間帳號可能就被停用了。認領當下記下啟用世代，輸出時再要求它沒變 ——
   * 於是停用、或停用再啟用（ABA）之後，舊 worker 都發布不了。
   *
   * 這是**加在** Phase 3 既有圍欄之上的一個維度，不取代 analytics generation、
   * 租約所有權或 live clock 的任何一個。
   */
  async function claimAnalyticsWork({
    userId, cls, owner, leaseMs, expectedLifecycleGeneration, now = new Date(),
  }) {
    return transaction(async () => {
      const uid = requireUserId(userId, 'claimAnalyticsWork');
      if (!CLASSES.includes(cls)) throw new Error(`invalid_analytics_class:${cls}`);
      if (!owner) throw new Error('analytics_owner_required');
      const nowIso = iso(now);
      const leaseIso = iso(new Date(new Date(now).getTime() + leaseMs));
      // ★ R3 / R2-ANALYTICS-01：啟用脈絡是**必填**的。少傳就大聲失敗；
      // 測試／管理要不受約束必須明確寫 LIFECYCLE_UNFENCED。
      const life = requireLifecycle(expectedLifecycleGeneration, 'claimAnalyticsWork');
      const scoped = await scope.available();
      if (scoped && (await client.execute({
        sql: `SELECT 1 FROM analytics_invalidation WHERE user_id=? AND scope_kind='FULL_TENANT_RECOMPUTE'
          UNION ALL SELECT 1 FROM analytics_work_state WHERE user_id=? AND class=? AND scope_kind='FULL_TENANT_RECOMPUTE'`,
        args: [uid,uid,cls],
      })).rows.length) return null;
      const rs = await client.execute({
        sql: `INSERT INTO analytics_work_state
                (user_id, class, owner, lease_expires_at, last_attempt_at, status,
                 claimed_lifecycle, created_at, updated_at${scoped ? ',scope_kind' : ''})
              SELECT ?, ?, ?, ?, ?, 'RUNNING', ?, ?, ?${scoped ? ",'NONE'" : ''}
               WHERE ${lifecycleActiveSql('?')}
              ON CONFLICT(user_id, class) DO UPDATE SET
                owner = excluded.owner,
                lease_expires_at = excluded.lease_expires_at,
                last_attempt_at = excluded.last_attempt_at,
                status = 'RUNNING',
                claimed_lifecycle = excluded.claimed_lifecycle,
                updated_at = excluded.updated_at
              WHERE analytics_work_state.owner IS NULL
                 OR analytics_work_state.lease_expires_at IS NULL
                 OR analytics_work_state.lease_expires_at <= excluded.last_attempt_at
                 -- ★ R2：**兩邊都知道**而且不同時才可以接手。
                 -- 一邊是 NULL（出處不明）時維持互斥，否則同一個世代的兩個
                 -- worker 會因為「NULL ≠ 1」互相搶走對方的租約。
                 OR (analytics_work_state.claimed_lifecycle IS NOT NULL
                     AND excluded.claimed_lifecycle IS NOT NULL
                     AND analytics_work_state.claimed_lifecycle <> excluded.claimed_lifecycle)`,
        args: [uid, cls, String(owner), leaseIso, nowIso, life, nowIso, nowIso, uid, life],
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
          ${scoped?',claimed_scope_revision=scope_revision,claimed_purge_generation=(SELECT purge_generation FROM phase4_user_state WHERE user_id=analytics_work_state.user_id)':''}
               WHERE user_id = ? AND class = ? AND owner = ? AND lease_expires_at > ?`,
        args: [generation, nowIso, uid, cls, String(owner), nowIso],
      });
      return {
        generation, doneGeneration: work?.doneGeneration ?? 0,
        lifecycleGeneration: life,
        affectedFrom: inv?.affectedFrom ?? null, affectedTo: inv?.affectedTo ?? null,
        resources: inv?.resources ?? [], reasons: inv?.reasons ?? [],
        rangeGeneration: work?.rangeGeneration ?? null, rangeFrom: work?.rangeFrom ?? null, rangeTo: work?.rangeTo ?? null,
      };
    });
  }

  // ----- 輕量分片進度（F03）----------------------------------------------------

  /**
   * 把這一代的剩餘範圍寫成耐久狀態（owner + 租約圍欄）。
   * 呼叫端在認領後決定剩餘範圍（同一代 → 沿用；換代 → 與失效範圍取聯集）。
   */
  async function setAnalyticsRange({ userId, cls, owner, generation, from, to, expectedLifecycleGeneration, now = new Date() }) {
    const uid = requireUserId(userId, 'setAnalyticsRange');
    const life = requireLifecycle(expectedLifecycleGeneration, 'setAnalyticsRange');
    const nowIso = iso(now);
    const privacy = await scope.range(uid, 'analytics_work_state', from, to, nowIso, cls);
    if (privacy.full) return false;
    const rs = await client.execute({
      sql: `UPDATE analytics_work_state
               SET range_generation = ?, range_from = ?, range_to = ?, updated_at = ?${privacy.suffix}
                 ${privacy.scopeRevision!==undefined?',claimed_scope_revision=?':''}
             WHERE user_id = ? AND class = ? AND owner = ? AND lease_expires_at > ? AND claimed_generation = ?
               ${await privacyLeaseSql()}
               AND (? IS NULL OR claimed_lifecycle IS ?)
               AND (? IS NULL OR ${lifecycleActiveSql('analytics_work_state.user_id')})`,
      args: [Number(generation), from, to, nowIso, ...privacy.values,...(privacy.scopeRevision!==undefined?[privacy.scopeRevision]:[]), uid, cls, String(owner), nowIso, generation, life, life, life, life],
    });
    return Number(rs.rowsAffected ?? 0) > 0;
  }

  /**
   * 一片完成：把剩餘範圍的上緣縮到這一片的下緣之前。
   * 圍欄：owner + 有效租約 + range_generation 相符 + range_to 仍是這一片的上緣（CAS）。
   * newTo = null 表示剩餘範圍清空。
   */
  async function advanceAnalyticsRange({ userId, cls, owner, generation, chunkTo, newTo, expectedLifecycleGeneration, now = new Date() }) {
    const uid = requireUserId(userId, 'advanceAnalyticsRange');
    const life = requireLifecycle(expectedLifecycleGeneration, 'advanceAnalyticsRange');
    const nowIso = iso(now);
    const scoped = await scope.available();
    const rs = await client.execute({
      sql: `UPDATE analytics_work_state
               SET range_to = ?, range_from = CASE WHEN ? IS NULL THEN NULL ELSE range_from END, updated_at = ?
                 ${scoped ? ", scope_kind = CASE WHEN ? IS NULL THEN 'NONE' ELSE 'HEALTH_DATE_RANGE' END,scope_revision=scope_revision+1,claimed_scope_revision=scope_revision+1" : ''}
             WHERE user_id = ? AND class = ? AND owner = ? AND lease_expires_at > ?
               AND range_generation = ? AND range_to = ? AND claimed_generation = ?
               ${await privacyLeaseSql()}
               AND (? IS NULL OR claimed_lifecycle IS ?)
               AND (? IS NULL OR ${lifecycleActiveSql('analytics_work_state.user_id')})`,
      args: [newTo, newTo, nowIso, ...(scoped ? [newTo] : []), uid, cls, String(owner), nowIso, Number(generation), chunkTo, generation, life, life, life, life],
    });
    return Number(rs.rowsAffected ?? 0) > 0;
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
    errorClass = null, errorDetail = null, nextAttemptAt = null, clearRange = false,
    expectedLifecycleGeneration, now = new Date(),
  }) {
    return transaction(async () => {
      const uid = requireUserId(userId, 'settleAnalyticsWork');
      if (!owner) return false;
      const nowIso = iso(now);
      const scoped = await scope.available();
      // ★ R3 / R2-ANALYTICS-01 §24：結案是「讓目前的分析狀態看起來完成了」，
      // 所以它和輸出一樣必須帶啟用脈絡；SUCCESS 更要在 SQL 裡證明世代沒變。
      const life = requireLifecycle(expectedLifecycleGeneration, 'settleAnalyticsWork');
      let rs;
      if (result === ANALYTICS_RESULT.SUCCESS) {
        if (!Number.isInteger(generation)) throw new Error('analytics_success_requires_generation');
        rs = await client.execute({
          sql: `UPDATE analytics_work_state
                   SET done_generation = MAX(done_generation, ?), status = 'SUCCESS',
                       range_from = NULL, range_to = NULL,
                       ${scoped ? "scope_kind = 'NONE'," : ''}
                       owner = NULL, lease_expires_at = NULL, claimed_generation = NULL,
                       claimed_lifecycle = NULL,
                       last_success_at = ?, last_error_class = NULL, last_error_detail = NULL,
                       consecutive_failures = 0, next_attempt_at = NULL,
                       summary_json = ?, updated_at = ?
                 WHERE user_id = ? AND class = ? AND owner = ? AND lease_expires_at > ? AND claimed_generation = ?
                   ${scoped ? "AND scope_kind <> 'FULL_TENANT_RECOMPUTE' AND NOT EXISTS (SELECT 1 FROM analytics_invalidation i WHERE i.user_id = analytics_work_state.user_id AND i.scope_kind = 'FULL_TENANT_RECOMPUTE')" : ''}
                   ${await privacyLeaseSql()}
                   AND (? IS NULL OR analytics_work_state.claimed_lifecycle IS ?)
                   AND (? IS NULL OR ${lifecycleActiveSql('analytics_work_state.user_id')})`,
          args: [generation, nowIso, summary ? JSON.stringify(summary) : null, nowIso,
            uid, cls, String(owner), nowIso, generation, life, life, life, life],
        });
        const settled = Number(rs.rowsAffected ?? 0) > 0;
        if (settled && clearRange) {
          // CAS：只有在沒有更新的 canonical 變動時才清範圍。
          await client.execute({
            sql: `UPDATE analytics_invalidation
                     SET affected_from = NULL, affected_to = NULL, resources = NULL, reasons = NULL, updated_at = ?
                       ${scoped ? ", scope_kind = 'NONE'" : ''}
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
                   SET status = 'FAILED', owner = NULL, lease_expires_at = NULL, claimed_generation = NULL, claimed_lifecycle = NULL,
                       last_failure_at = ?, last_error_class = ?, last_error_detail = ?,
                       consecutive_failures = consecutive_failures + 1,
                       next_attempt_at = ?, updated_at = ?
                 WHERE user_id = ? AND class = ? AND owner = ? AND lease_expires_at > ?
                   ${await privacyLeaseSql()}
                   AND (? IS NULL OR claimed_lifecycle IS ?)
                   AND (? IS NULL OR ${lifecycleActiveSql('analytics_work_state.user_id')})`,
          args: [nowIso, errorClass, errorDetail ? String(errorDetail).slice(0, 300) : null,
            nextAttemptAt ? iso(nextAttemptAt) : null, nowIso,
            uid, cls, String(owner), nowIso, life, life, life, life],
        });
        return Number(rs.rowsAffected ?? 0) > 0;
      }
      throw new Error(`invalid_analytics_result:${result}`);
    });
  }

  /**
   * 釋放租約而不結案（沒有要算：已經是最新、節奏未到）。done_generation 不動。
   * nextAttemptAt 可用來讓 listPendingAnalytics 在節奏到期前不再列出這個使用者。
   */
  async function releaseAnalyticsWork({ userId, cls, owner, nextAttemptAt = null, expectedLifecycleGeneration, now = new Date() }) {
    const uid = requireUserId(userId, 'releaseAnalyticsWork');
    const life = requireLifecycle(expectedLifecycleGeneration, 'releaseAnalyticsWork');
    if (!owner) return false;
    const rs = await client.execute({
      sql: `UPDATE analytics_work_state
               SET owner = NULL, lease_expires_at = NULL, claimed_generation = NULL, claimed_lifecycle = NULL,
                   status = CASE WHEN status = 'RUNNING' THEN 'IDLE' ELSE status END,
                   next_attempt_at = ?, updated_at = ?
             WHERE user_id = ? AND class = ? AND owner = ? AND lease_expires_at > ?
               ${await privacyLeaseSql()}
               AND (? IS NULL OR claimed_lifecycle IS ?)
               AND (? IS NULL OR ${lifecycleActiveSql('analytics_work_state.user_id')})`,
      args: [nextAttemptAt ? iso(nextAttemptAt) : null, iso(now), uid, cls, String(owner), iso(now), life, life, life, life],
    });
    return Number(rs.rowsAffected ?? 0) > 0;
  }

  /** 這個 (使用者, 類別) 現在是不是還被 owner 有效持有。 */
  async function holdsAnalyticsWork({ userId, cls, owner, expectedLifecycleGeneration, now = new Date() }) {
    const uid = requireUserId(userId, 'holdsAnalyticsWork');
    const life = requireLifecycle(expectedLifecycleGeneration, 'holdsAnalyticsWork');
    if (!owner) return false;
    const rs = await client.execute({
      sql: `SELECT 1 FROM analytics_work_state
             WHERE user_id = ? AND class = ? AND owner = ? AND lease_expires_at > ?
               ${await privacyLeaseSql()}
               AND (? IS NULL OR claimed_lifecycle IS ?)
               AND (? IS NULL OR ${lifecycleActiveSql('analytics_work_state.user_id')}) LIMIT 1`,
      args: [uid, cls, String(owner), iso(now), life, life, life, life],
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
      const remaining = w?.rangeFrom && w?.rangeTo && w?.rangeGeneration === generation;
      let status;
      if (inv?.scopeKind === 'FULL_TENANT_RECOMPUTE' || w?.scopeKind === 'FULL_TENANT_RECOMPUTE') status = ANALYTICS_FRESHNESS.PENDING;
      else if (generation === 0 && done === 0) status = ANALYTICS_FRESHNESS.NEVER;
      else if (done >= generation && !remaining) status = ANALYTICS_FRESHNESS.CURRENT;
      else if (w?.status === 'FAILED') status = ANALYTICS_FRESHNESS.FAILED;
      else status = ANALYTICS_FRESHNESS.PENDING;
      out[cls] = {
        status, doneGeneration: done, lastSuccessAt: w?.lastSuccessAt ?? null,
        remainingRange: remaining ? { from: w.rangeFrom, to: w.rangeTo } : null,
        lastFailureAt: w?.lastFailureAt ?? null, lastErrorClass: w?.lastErrorClass ?? null,
        owner: w?.owner ?? null, leaseExpiresAt: w?.leaseExpiresAt ?? null,
        nextAttemptAt: w?.nextAttemptAt ?? null, consecutiveFailures: w?.consecutiveFailures ?? 0,
      };
    }
    return out;
  }

  // ----- 輕量物化 -----------------------------------------------------------

  /**
   * 輕量物化的寫入 —— **必須**帶所有權證明（F01）。整批在一個圍欄交易裡：
   * 交易開頭與結尾都驗 owner / 有效租約 / claimed_generation；任何一項不成立
   * 就整批不寫。同一代、不同 owner（接手之後）也進不來。
   *
   * ## 兩個時間是**不同**的東西（P3-RC1-F01）
   *
   *   now    分析錨點：`computed_at` 用它。它可以（也應該）是這一輪計算開始
   *          時捕捉的穩定時刻 —— 健康日與就緒判定都靠它保持一致。
   *   clock  租約證明：**活的時鐘函式**，在交易裡的 before / after 各取一次。
   *
   * 以前這裡把 `now` 當成租約時鐘（`() => now`），於是「計算花了比租約還久」
   * 的過期工作者仍然寫得進去。錨點與租約證明從此分開。
   */
  async function saveAnalyticsDailyState(userId, rows, {
    owner, generation, expectedLifecycleGeneration, now = new Date(), clock = () => new Date(),
  }) {
    const uid = requireUserId(userId, 'saveAnalyticsDailyState');
    if (!Number.isInteger(generation)) throw new Error('analytics_daily_state_requires_generation');
    if (!owner) throw new Error('analytics_owner_required');
    if (typeof clock !== 'function') throw new Error('analytics_live_clock_required');
    const nowIso = iso(now);
    return mutateForAnalytics({
      userId: uid, cls: ANALYTICS_CLASS.LIGHT, owner, generation,
      expectedLifecycleGeneration, now: clock,
    }, async () => {
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
    });
  }

  /**
   * 每一列帶 `stale`：算它時的 generation 比目前的 generation 舊，或輕量路徑
   * 這一代還有剩餘範圍沒算完 —— 讀取端不能把它當成最新。
   */
  async function getAnalyticsDailyState(userId, { from = null, to = null } = {}) {
    const uid = requireUserId(userId, 'getAnalyticsDailyState');
    const inv = await getAnalyticsInvalidation(uid);
    const work = await getAnalyticsWorkState(uid, ANALYTICS_CLASS.LIGHT);
    if (inv?.scopeKind === 'FULL_TENANT_RECOMPUTE' || work?.scopeKind === 'FULL_TENANT_RECOMPUTE') return [];
    const generation = inv?.generation ?? 0;
    const incomplete = Boolean(work?.rangeFrom && work?.rangeTo && work?.rangeGeneration === generation)
      || (work?.doneGeneration ?? 0) < generation;
    const rs = await client.execute({
      sql: `SELECT * FROM analytics_daily_state
             WHERE user_id = ? AND (? IS NULL OR health_date >= ?) AND (? IS NULL OR health_date <= ?)
             ORDER BY health_date`,
      args: [uid, from, from, to, to],
    });
    return rs.rows.map((r) => ({
      healthDate: String(r.health_date), generation: Number(r.generation), computedAt: r.computed_at,
      dailyStatus: String(r.daily_status), metrics: JSON.parse(String(r.metrics_json)),
      stale: Number(r.generation) < generation || incomplete,
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

  async function closeAnalyticsRun(userId, runId, { result, detail=null, expectedLifecycleGeneration,
    errorClass = null, now = new Date() }) {
    const uid=requireUserId(userId,'closeAnalyticsRun');
    if(!Object.values(ANALYTICS_RESULT).includes(result))throw new Error('analytics_result_required');
    return transaction(async()=>{
      const scoped=await scope.available();
      const eligible=scoped?(await client.execute({sql:`SELECT 1 FROM analytics_runs r JOIN users u ON u.id=r.user_id
        JOIN phase4_user_state p ON p.user_id=r.user_id JOIN analytics_invalidation i ON i.user_id=r.user_id
        WHERE r.user_id=? AND r.id=? AND u.status='ACTIVE' AND u.lifecycle_generation=?
          AND p.pending_purge_count=0 AND p.purge_generation=r.purge_generation AND i.generation=r.generation
          AND r.content_state='PRESENT' AND r.source_linkage_state='COMPLETE' AND r.health_content_redacted_at IS NULL`,
        args:[uid,Number(runId),expectedLifecycleGeneration??null]})).rows.length>0:false;
      // Late closing may record finite operational truth after revocation, but
      // only a same-lifecycle/current privacy envelope may receive summaries.
      await client.execute({
        sql: `UPDATE analytics_runs SET finished_at = ?, result = ?, detail_json = ?, error_class = ?, error_detail = NULL WHERE user_id = ? AND id = ?`,
        args: [iso(now),result,eligible&&detail?JSON.stringify(detail):null,errorClass,uid,Number(runId)],
      });
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
    markAnalyticsDirty: (...args) => transaction(() => markAnalyticsDirty(...args)),
    getAnalyticsInvalidation,
    getAnalyticsWorkState,
    listPendingAnalytics,
    claimAnalyticsWork,
    setAnalyticsRange: (...args) => transaction(() => setAnalyticsRange(...args)),
    advanceAnalyticsRange,
    mutateForAnalytics,
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
