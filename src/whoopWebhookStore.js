/**
 * WHOOP webhook 的耐久儲存層（V1.2 Phase 1）。
 *
 * 兩件事：
 *   1. 事件帳本 whoop_webhook_events —— 去重、認領、租約、狀態機
 *   2. 刪除墓碑 whoop_resource_tombstones —— 讓「已刪除」這件事耐久且不可復活
 *
 * ## 權威一律是資料庫
 *
 * 認領與每一次狀態轉移都是**單一句原子 SQL**，而且都把「我還是不是擁有者」
 * 寫進 WHERE。記憶體不參與正確性：免費方案會睡著、會重啟、會冷啟動，
 * 任何依賴 process 記憶的設計在那裡都等於沒有設計。
 *
 * 這與 V1.1 已經定案的兩套狀態機（report_claims / telegram_operations）
 * 用的是同一個模式，刻意不另外發明一種。
 */

import { requireUserId } from './userContext.js';
import { WHOOP_EVENT_STATE, WHOOP_EVENT_TERMINAL, TOMBSTONE_STATE } from './schema.js';
import { WHOOP_EVENT_TYPES } from './whoopWebhookEvent.js';
import { log } from './logger.js';

/** 撞到唯一索引 = 這一則事件已經收過了（去重成立）。 */
export function isUniqueViolation(err) {
  return /UNIQUE constraint failed/i.test(String(err?.message ?? ''));
}

const iso = (v) => (v instanceof Date ? v.toISOString() : new Date(v).toISOString());

export function createWhoopWebhookStore(client) {
  // -------------------------------------------------------------------------
  // 事件帳本
  // -------------------------------------------------------------------------
  /**
   * 耐久收下一則事件。
   *
   * 去重的權威是 DB 的唯一索引，不是「先查再insert」—— 後者在兩個並行投遞
   * 之間有 TOCTOU 空窗，而 WHOOP 明說會重複投遞。
   *
   * @returns {Promise<{inserted:boolean, id:number, duplicate:boolean}>}
   */
  async function recordWhoopEvent({
    whoopUserId, eventType, resourceType, resourceId, traceId,
    eventAt = null, now = new Date(),
  }) {
    const nowIso = iso(now);
    try {
      const rs = await client.execute({
        sql: `INSERT INTO whoop_webhook_events
                (provider, whoop_user_id, event_type, resource_type, resource_id, trace_id,
                 event_at, received_at, state, attempt_count, created_at, updated_at)
              VALUES ('whoop', ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
        args: [String(whoopUserId), eventType, resourceType, String(resourceId), String(traceId),
          eventAt === null || eventAt === undefined ? null : String(eventAt),
          nowIso, WHOOP_EVENT_STATE.RECEIVED, nowIso, nowIso],
      });
      return {
        inserted: true, duplicate: false,
        id: Number(rs.lastInsertRowid ?? 0),
      };
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      // 已經有一模一樣的事件了 —— 這是**正常**的重複投遞，不是錯誤。
      const existing = await client.execute({
        sql: `SELECT id FROM whoop_webhook_events
               WHERE whoop_user_id = ? AND event_type = ? AND resource_id = ? AND trace_id = ?`,
        args: [String(whoopUserId), eventType, String(resourceId), String(traceId)],
      });
      return {
        inserted: false, duplicate: true,
        id: Number(existing.rows[0]?.id ?? 0),
      };
    }
  }

  const rowToEvent = (r) => (r ? {
    id: Number(r.id),
    provider: String(r.provider),
    whoopUserId: String(r.whoop_user_id),
    userId: r.user_id ?? null,
    eventType: String(r.event_type),
    /**
     * updated / deleted。**從 event_type 推導**而不是另外存一欄：
     * 存兩份同源資訊遲早會不一致，而這裡不一致的後果是刪除事件被當成
     * 更新事件處理（實測就是這樣：processWhoopEvent 看不到 action 就整個
     * 走錯分支，去打了一個已經不存在的資源）。
     */
    action: WHOOP_EVENT_TYPES[String(r.event_type)]?.action ?? null,
    resourceType: String(r.resource_type),
    resourceId: String(r.resource_id),
    traceId: String(r.trace_id),
    eventAt: r.event_at ?? null,
    receivedAt: r.received_at,
    state: String(r.state),
    attemptCount: Number(r.attempt_count ?? 0),
    owner: r.owner ?? null,
    leaseExpiresAt: r.lease_expires_at ?? null,
    nextAttemptAt: r.next_attempt_at ?? null,
    lastErrorClass: r.last_error_class ?? null,
    lastErrorDetail: r.last_error_detail ?? null,
    processedAt: r.processed_at ?? null,
  } : null);

  async function getWhoopEvent(id) {
    const rs = await client.execute({
      sql: 'SELECT * FROM whoop_webhook_events WHERE id = ?', args: [Number(id)],
    });
    return rowToEvent(rs.rows[0]);
  }

  /**
   * 認領下一則可處理的事件。
   *
   * 可認領的有三種：
   *   RECEIVED                     還沒有人碰過
   *   RETRY 且退避時間已到          上一次暫時性失敗
   *   PROCESSING 且**租約已過期**   上一個擁有者死在半路（崩潰復原）
   *
   * 終局狀態一個都不在裡面 —— 終局永遠不會被復活。
   *
   * ## 為什麼是「先挑 id，再用那個 id 更新」
   *
   * 早期版本是一句 `UPDATE ... WHERE id = (SELECT ...)`，再用
   * `WHERE owner = ? AND state = 'PROCESSING'` 把剛認領到的那一則查回來。
   * 那個查回來的步驟有一個**實測重現**的錯誤：
   *
   *   同一個 owner 可能同時握著不只一則（前一則因為圍欄或例外沒能結案，
   *   owner 仍留在那一列上）。這時候「查回來」只能靠排序猜，而
   *   updated_at 一旦相撞或時鐘偏移，就會回傳**另一則**。
   *   後果是：真正被推進狀態的那一則從來沒被處理（attempt 卻被消耗掉），
   *   而另一則被同一個 owner 重複處理。
   *
   * 所以現在改成明確地鎖定一個 id：挑候選 → 用那個 id 原子地更新 →
   * 用同一個 id 查回來。沒有任何一步需要靠排序猜「剛剛那一則是哪一則」。
   *
   * 候選與實際更新之間的競態由 UPDATE 的 WHERE 再檢查一次擋掉；
   * 搶輸了就換下一個候選（有上限，不會空轉）。
   */
  async function claimWhoopEvent({
    owner, leaseMs, now = new Date(), maxAttempts = null, maxCandidates = 10,
  }) {
    if (!owner) throw new Error('whoop_event_owner_required');
    const nowIso = iso(now);
    const leaseIso = iso(new Date(new Date(now).getTime() + leaseMs));
    const attemptCap = Number.isFinite(maxAttempts) ? Number(maxAttempts) : Number.MAX_SAFE_INTEGER;

    const claimable = `(
         state = '${WHOOP_EVENT_STATE.RECEIVED}'
      OR (state = '${WHOOP_EVENT_STATE.RETRY}'
          AND (next_attempt_at IS NULL OR next_attempt_at <= ?))
      OR (state = '${WHOOP_EVENT_STATE.PROCESSING}'
          AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?)
    )`;

    const skip = new Set();
    for (let i = 0; i < maxCandidates; i += 1) {
      const candidates = await client.execute({
        sql: `SELECT id FROM whoop_webhook_events
               WHERE ${claimable} AND attempt_count < ?
               ORDER BY id LIMIT ?`,
        args: [nowIso, nowIso, attemptCap, maxCandidates],
      });
      const next = candidates.rows.map((r) => Number(r.id)).find((id) => !skip.has(id));
      if (next === undefined) return null;

      const rs = await client.execute({
        sql: `UPDATE whoop_webhook_events
                 SET state = ?, owner = ?, lease_expires_at = ?,
                     attempt_count = attempt_count + 1, updated_at = ?
               WHERE id = ? AND ${claimable} AND attempt_count < ?`,
        args: [
          WHOOP_EVENT_STATE.PROCESSING, String(owner), leaseIso, nowIso,
          next, nowIso, nowIso, attemptCap,
        ],
      });
      if (Number(rs.rowsAffected ?? 0) === 0) {
        // 有人先搶走了（或它剛好變成終局）。換下一個候選。
        skip.add(next);
        continue;
      }
      // 用**同一個 id** 查回來 —— 不需要任何排序假設。
      return rowToEvent((await client.execute({
        sql: 'SELECT * FROM whoop_webhook_events WHERE id = ?', args: [next],
      })).rows[0]);
    }
    return null;
  }

  /**
   * 我**現在**還握著這一則嗎？
   *
   * 每一個有副作用的邊界之前都要重新問一次：租約會過期，過期之後別人可能
   * 已經接手。「當初拿到了」不等於「現在還有」。
   */
  async function holdsWhoopEvent(id, owner, { now = new Date() } = {}) {
    if (!owner) return false;
    const rs = await client.execute({
      sql: `SELECT 1 FROM whoop_webhook_events
             WHERE id = ? AND owner = ? AND state = ? AND lease_expires_at > ? LIMIT 1`,
      args: [Number(id), String(owner), WHOOP_EVENT_STATE.PROCESSING, iso(now)],
    });
    return rs.rows.length > 0;
  }

  /**
   * 結案（或退回重試）。**一定**帶著 owner 與 PROCESSING 當圍欄。
   *
   * 失去所有權的舊執行走到這裡會拿到 rowsAffected = 0，於是它寫不進任何
   * 狀態 —— 接手者的結果不會被它蓋掉。
   */
  async function settleWhoopEvent(id, {
    owner, state, userId = undefined, errorClass = null, errorDetail = null,
    nextAttemptAt = null, now = new Date(),
  }) {
    if (!owner) return false;
    if (!Object.values(WHOOP_EVENT_STATE).includes(state)) {
      throw new Error(`invalid_whoop_event_state:${state}`);
    }
    const nowIso = iso(now);
    const terminal = WHOOP_EVENT_TERMINAL.includes(state);
    const rs = await client.execute({
      sql: `UPDATE whoop_webhook_events
               SET state = ?,
                   user_id = COALESCE(?, user_id),
                   owner = NULL,
                   lease_expires_at = NULL,
                   next_attempt_at = ?,
                   last_error_class = ?,
                   last_error_detail = ?,
                   processed_at = CASE WHEN ? = 1 THEN ? ELSE processed_at END,
                   updated_at = ?
             WHERE id = ? AND owner = ? AND state = ?`,
      args: [
        state,
        userId === undefined ? null : (userId === null ? null : String(userId)),
        nextAttemptAt === null || nextAttemptAt === undefined ? null : iso(nextAttemptAt),
        errorClass, errorDetail === null ? null : String(errorDetail).slice(0, 300),
        terminal ? 1 : 0, nowIso,
        nowIso,
        Number(id), String(owner), WHOOP_EVENT_STATE.PROCESSING,
      ],
    });
    return Number(rs.rowsAffected ?? 0) > 0;
  }

  /** 觀測用統計（不含任何生理數值）。 */
  async function whoopEventStats() {
    const rs = await client.execute(
      `SELECT state, event_type, COUNT(*) n FROM whoop_webhook_events
        GROUP BY state, event_type ORDER BY state, event_type`,
    );
    return rs.rows.map((r) => ({
      state: String(r.state), eventType: String(r.event_type), count: Number(r.n),
    }));
  }

  // -------------------------------------------------------------------------
  // 墓碑
  // -------------------------------------------------------------------------
  /**
   * 這個使用者、這個資源類型底下**目前生效**的墓碑。
   *
   * 刻意一次取回整組而不是用 `IN (...)`：正式環境一個人的墓碑數量很小，
   * 而動態組 IN 清單只會多一條字串拼接的風險，換不到任何東西。
   */
  async function activeTombstones(userId, resourceType) {
    const uid = requireUserId(userId, 'activeTombstones');
    const rs = await client.execute({
      sql: `SELECT resource_id, last_known_updated_at
              FROM whoop_resource_tombstones
             WHERE user_id = ? AND resource_type = ? AND state = ?`,
      args: [uid, resourceType, TOMBSTONE_STATE.ACTIVE],
    });
    const out = new Map();
    for (const r of rs.rows) {
      out.set(String(r.resource_id), r.last_known_updated_at ?? null);
    }
    return out;
  }

  async function getTombstone(userId, resourceType, resourceId) {
    const uid = requireUserId(userId, 'getTombstone');
    const rs = await client.execute({
      sql: `SELECT * FROM whoop_resource_tombstones
             WHERE user_id = ? AND resource_type = ? AND resource_id = ?`,
      args: [uid, resourceType, String(resourceId)],
    });
    const r = rs.rows[0];
    return r ? {
      userId: String(r.user_id),
      resourceType: String(r.resource_type),
      resourceId: String(r.resource_id),
      state: String(r.state),
      deletedAt: r.deleted_at,
      lastKnownUpdatedAt: r.last_known_updated_at ?? null,
      sourceTraceId: r.source_trace_id ?? null,
      sourceEventId: r.source_event_id === null || r.source_event_id === undefined
        ? null : Number(r.source_event_id),
      blockedCount: Number(r.blocked_count ?? 0),
      lastBlockedAt: r.last_blocked_at ?? null,
      supersededAt: r.superseded_at ?? null,
    } : null;
  }

  /**
   * 記下「這個資源被 WHOOP 刪掉了」。
   *
   * 重複刪除是冪等的：同一個 (user, type, id) 只會有一列，重放只更新
   * 來源資訊，不會製造第二個墓碑。
   *
   * ⚠️ Phase 1 **沒有任何自動退位路徑**。source_event_id / source_event_at /
   * source_trace_id 只是診斷與未來對帳的證據，**不是** WHOOP 的來源時序：
   * 帳本 id 只代表本地收下的順序，而 WHOOP 沒有文件保證投遞順序。
   */
  async function upsertTombstone({
    userId, resourceType, resourceId, lastKnownUpdatedAt = null,
    sourceTraceId = null, sourceEventAt = null, sourceEventId = null, now = new Date(),
  }) {
    const uid = requireUserId(userId, 'upsertTombstone');
    const nowIso = iso(now);
    await client.execute({
      sql: `INSERT INTO whoop_resource_tombstones
              (user_id, resource_type, resource_id, state, deleted_at,
               last_known_updated_at, source_trace_id, source_event_at, source_event_id,
               blocked_count, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
            ON CONFLICT(user_id, resource_type, resource_id) DO UPDATE SET
              state = ?,
              deleted_at = excluded.deleted_at,
              -- 已知的版本資訊只會變得更完整，不可以被 NULL 蓋掉：
              -- 那會把「證明得了」退化成「證明不了」。
              last_known_updated_at =
                COALESCE(excluded.last_known_updated_at,
                         whoop_resource_tombstones.last_known_updated_at),
              source_trace_id = excluded.source_trace_id,
              source_event_at = excluded.source_event_at,
              source_event_id = excluded.source_event_id,
              superseded_at = NULL,
              superseded_updated_at = NULL,
              updated_at = excluded.updated_at`,
      args: [uid, resourceType, String(resourceId), TOMBSTONE_STATE.ACTIVE, nowIso,
        lastKnownUpdatedAt, sourceTraceId, sourceEventAt,
        sourceEventId === null || sourceEventId === undefined ? null : Number(sourceEventId),
        nowIso, nowIso, TOMBSTONE_STATE.ACTIVE],
    });
    return true;
  }

  /** 記一次「有東西想復活但被擋下來了」。純觀測，不改變判定。 */
  async function recordTombstoneBlock({
    userId, resourceType, resourceId, now = new Date(),
  }) {
    const uid = requireUserId(userId, 'recordTombstoneBlock');
    await client.execute({
      sql: `UPDATE whoop_resource_tombstones
               SET blocked_count = blocked_count + 1, last_blocked_at = ?, updated_at = ?
             WHERE user_id = ? AND resource_type = ? AND resource_id = ? AND state = ?`,
      args: [iso(now), iso(now), uid, resourceType, String(resourceId), TOMBSTONE_STATE.ACTIVE],
    });
  }

  /**
   * 資源類型 → canonical 表與它的識別欄位。
   *
   * recovery 的識別欄位是 sleep_id（不是自己的 id）—— 這正好與 v2 webhook
   * 的 `id` 語意一致，也與本地的邏輯主鍵一致。
   */
  const CANONICAL = Object.freeze({
    sleep: { table: 'whoop_sleeps', idColumn: 'id' },
    recovery: { table: 'whoop_recoveries', idColumn: 'sleep_id' },
    workout: { table: 'whoop_workouts', idColumn: 'id' },
  });

  /**
   * 執行一次刪除：先立墓碑，再把 canonical 那一列移除。
   *
   * ## 順序是刻意的
   *
   * 墓碑**先寫**。如果反過來（先刪列、再立墓碑），中間崩潰會留下
   * 「資料沒了、但沒有任何東西擋住它被寫回來」的狀態 —— 下一次排程同步
   * 就會把它復活，而且沒有人會發現。
   *
   * 先寫墓碑的失敗模式相反而且安全：留下「墓碑在、列還在」。那一列之後
   * 會被讀到（多一筆舊資料），但它**不可能**被當成新資料寫入，而且重跑
   * 這支函式就會收斂。兩種不完整狀態裡，這是可以自己修好的那一種。
   *
   * ## 為什麼是實體刪除而不是軟刪除
   *
   * 軟刪除需要**每一個**讀取查詢都記得過濾，漏一個就等於刪除沒有發生，
   * 而這個系統的讀取路徑很多（簡報、分析、Q&A、預測）。實體刪除之後
   * 那一天在分析層看到的是「沒有資料」—— 那正是既有架構已經正確處理的
   * 「缺值」，而不是被偽造出來的 0。
   *
   * @returns {Promise<{tombstoned:boolean, removed:number, lastKnownUpdatedAt:?string}>}
   */
  async function deleteWhoopResource({
    userId, resourceType, resourceId, sourceTraceId = null, sourceEventAt = null,
    sourceEventId = null, now = new Date(),
  }) {
    const uid = requireUserId(userId, 'deleteWhoopResource');
    const spec = CANONICAL[resourceType];
    if (!spec) throw new Error(`unsupported_resource_type:${resourceType}`);
    const rid = String(resourceId);

    // 刪除當下那一版的 WHOOP updated_at。Phase 1 只把它**保留下來**給診斷與
    // 未來的對帳用 —— 它本身不足以證明一則後來的更新是「真的重建」還是
    // 「刪除前就在路上的舊通知」，所以 Phase 1 不會拿它做任何自動退位。
    const existing = await client.execute({
      sql: `SELECT updated_at FROM "${spec.table}" WHERE user_id = ? AND "${spec.idColumn}" = ?`,
      args: [uid, rid],
    });
    const lastKnownUpdatedAt = existing.rows[0]?.updated_at ?? null;

    await upsertTombstone({
      userId: uid, resourceType, resourceId: rid, lastKnownUpdatedAt,
      sourceTraceId, sourceEventAt, sourceEventId, now,
    });

    const del = await client.execute({
      sql: `DELETE FROM "${spec.table}" WHERE user_id = ? AND "${spec.idColumn}" = ?`,
      args: [uid, rid],
    });
    const removed = Number(del.rowsAffected ?? 0);
    log.info('whoop_resource_deleted', {
      user_id: uid, resource_type: resourceType, resource_id: rid,
      removed, had_local_row: lastKnownUpdatedAt !== null,
    });
    return { tombstoned: true, removed, lastKnownUpdatedAt };
  }

  /**
   * WHOOP 會員 id → 本地使用者。**權威解析**。
   *
   * ## 為什麼不重用 findUserByWhoopUserId
   *
   * 那一支的用途是「這個 WHOOP 帳號是不是已經綁在**別人**身上」
   * （授權流程的衝突偵測），它會回第一個命中而且刻意排除某個 user。
   * webhook 路由需要的是完全不同的語義：**恰好一個，否則就不要動任何東西**。
   *
   * 用同一支函式做兩件事的話，某一天改動其中一個用途就會悄悄破壞另一個。
   *
   * @returns {{status:'resolved', userId, user} | {status:'unknown'} | {status:'ambiguous', count}}
   */
  async function resolveUserByWhoopUserId(whoopUserId) {
    const wid = whoopUserId === null || whoopUserId === undefined ? '' : String(whoopUserId);
    if (!wid) return { status: 'unknown', reason: 'empty_whoop_user_id' };
    const rs = await client.execute({
      sql: `SELECT t.user_id, u.status, u.timezone, u.display_name, u.lifecycle_generation
              FROM user_whoop_tokens t
              JOIN users u ON u.id = t.user_id
             WHERE t.whoop_user_id = ?`,
      args: [wid],
    });
    if (rs.rows.length === 0) return { status: 'unknown', reason: 'no_local_binding' };
    // 結構上有 partial unique index 擋著，但**不可以**因此就假設它成立：
    // 索引是在 v6 之後才加的，而且舊資料可能早於它。多於一筆就 fail closed。
    if (rs.rows.length > 1) return { status: 'ambiguous', count: rs.rows.length };
    const row = rs.rows[0];
    return {
      status: 'resolved',
      userId: String(row.user_id),
      user: {
        id: String(row.user_id),
        status: String(row.status),
        // ★ v17：處理這則事件時的帳號啟用世代（往下帶進 canonical 寫入）。
        lifecycleGeneration: Number(row.lifecycle_generation ?? 1),
        timezone: row.timezone ? String(row.timezone) : null,
      },
    };
  }

  return {
    deleteWhoopResource,
    resolveUserByWhoopUserId,
    recordWhoopEvent,
    getWhoopEvent,
    claimWhoopEvent,
    holdsWhoopEvent,
    settleWhoopEvent,
    whoopEventStats,
    activeTombstones,
    getTombstone,
    upsertTombstone,
    recordTombstoneBlock,
  };
}
