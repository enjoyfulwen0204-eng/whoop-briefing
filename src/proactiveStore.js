/**
 * Proactive Agent 的持久化層（PA3／PA9）。
 *
 * 跟 botStore.js／analysisStore.js 同一個原則：只做「存」與「取」，
 * 不做任何訊號判斷或決策——那些邏輯在 signals.js／attention.js／
 * proactiveAgent.js。
 */

import { PROACTIVE_OUTCOME } from './schema.js';
import { PROACTIVE_PROCESSING_LEASE } from './proactivePolicy.js';
import { log } from './logger.js';
import { requireUserId } from './userContext.js';

const nowIso = (d = new Date()) => d.toISOString();

export function createProactiveStore(client) {
  // -------------------------------------------------------------------------
  // proactive_agent_state —— 「這個使用者上次檢查到哪一天」的游標
  // -------------------------------------------------------------------------
  async function getProactiveState(userId) {
    const uid = requireUserId(userId, 'getProactiveState');
    const rs = await client.execute({
      sql: 'SELECT * FROM proactive_agent_state WHERE user_id = ?',
      args: [uid],
    });
    const row = rs.rows[0];
    if (!row) return null;
    return {
      userId: row.user_id,
      lastCheckedHealthDate: row.last_checked_health_date,
      lastFingerprint: row.last_fingerprint ?? null,
      enabled: Number(row.enabled ?? 1) === 1,
      updatedAt: row.updated_at,
    };
  }

  /**
   * 更新分析游標。**刻意不碰 `enabled`**——使用者的開關設定不可以被
   * 每天的例行游標更新覆寫掉。
   */
  async function setProactiveState(userId, { lastCheckedHealthDate, lastFingerprint = null }, { now = new Date() } = {}) {
    const uid = requireUserId(userId, 'setProactiveState');
    await client.execute({
      sql: `INSERT INTO proactive_agent_state
              (user_id, last_checked_health_date, last_fingerprint, updated_at)
            VALUES (?,?,?,?)
            ON CONFLICT(user_id) DO UPDATE SET
              last_checked_health_date = excluded.last_checked_health_date,
              last_fingerprint = excluded.last_fingerprint,
              updated_at = excluded.updated_at`,
      args: [uid, lastCheckedHealthDate, lastFingerprint, nowIso(now)],
    });
    return true;
  }

  /** per-user 主動訊息開關。沒有紀錄 = 預設開啟。 */
  async function isProactiveEnabled(userId) {
    const uid = requireUserId(userId, 'isProactiveEnabled');
    const rs = await client.execute({
      sql: 'SELECT enabled FROM proactive_agent_state WHERE user_id = ?',
      args: [uid],
    });
    if (!rs.rows[0]) return true;
    return Number(rs.rows[0].enabled ?? 1) === 1;
  }

  /**
   * 開／關某個使用者的主動訊息。**只影響這一個 user_id**。
   * 關閉之後照樣同步資料、照樣可以手動問答，只是不會再收到未經請求的訊息。
   */
  async function setProactiveEnabled(userId, enabled, { now = new Date() } = {}) {
    const uid = requireUserId(userId, 'setProactiveEnabled');
    await client.execute({
      sql: `INSERT INTO proactive_agent_state (user_id, enabled, updated_at)
            VALUES (?,?,?)
            ON CONFLICT(user_id) DO UPDATE SET
              enabled = excluded.enabled, updated_at = excluded.updated_at`,
      args: [uid, enabled ? 1 : 0, nowIso(now)],
    });
    log.info('proactive_enabled_changed', { user_id: uid, enabled: Boolean(enabled) });
    return true;
  }

  // -------------------------------------------------------------------------
  // proactive_events —— 稽核軌跡 + 冪等鍵 + 反騷擾政策的資料來源
  // -------------------------------------------------------------------------

  /**
   * 嘗試「認領」一個 idempotency key。
   *
   * 這是唯一會真的寫入 proactive_events 的地方，而且刻意設計成
   * INSERT-first：UNIQUE(user_id, idempotency_key) 讓同一個 health_date
   * 重算兩次時，第二次一定拿到 claimed:false —— 呼叫端據此判斷「已經
   * 處理過，不要重複發送」，不需要另外查一次。
   */
  async function claimProactiveEvent(userId, {
    healthDate, idempotencyKey, signals, decision, reason, policyVersion, messageText,
  }, { now = new Date() } = {}) {
    const uid = requireUserId(userId, 'claimProactiveEvent');
    try {
      const rs = await client.execute({
        sql: `INSERT INTO proactive_events
                (user_id, health_date, idempotency_key, signals_json, decision, reason_json,
                 policy_version, message_text, created_at)
              VALUES (?,?,?,?,?,?,?,?,?)`,
        args: [
          uid, healthDate, idempotencyKey,
          signals ? JSON.stringify(signals) : null,
          decision, reason ? JSON.stringify(reason) : null,
          policyVersion, messageText ?? null, nowIso(now),
        ],
      });
      const id = Number(rs.lastInsertRowid ?? 0);
      log.info('proactive_event_claimed', { user_id: uid, id, health_date: healthDate, decision });
      return { claimed: true, id };
    } catch (err) {
      if (/UNIQUE constraint failed/i.test(String(err?.message ?? ''))) {
        log.info('proactive_event_duplicate_suppressed', { user_id: uid, health_date: healthDate });
        return { claimed: false, id: null };
      }
      throw err;
    }
  }

  /**
   * 標記「這則主動訊息已經送出去了」。
   *
   * ## M-07：沒有問問題的事件，送出即終局
   *
   * `pendingQuestionId` 是 null 代表這次**根本沒有開追問**——NOTIFY 這類
   * 決策只是通知一句話，沒有人該回答它。舊版讓這種事件的 outcome 永遠
   * 停在 NULL，而 Guardian 判斷「卡住」的條件正是
   * `sent_at IS NOT NULL AND outcome IS NULL`。結果每一則**正常送出**的
   * 通知，24 小時後都會變成一筆永久的假警報，每 12 小時響一次，
   * 而且沒有任何辦法讓它消失。實測確認。
   *
   * 所以這裡在送出的同一步就寫上 DELIVERED。`outcome IS NULL` 的條件讓
   * 它天然冪等，也不會覆寫任何已經有結論的事件。
   */
  async function markProactiveEventSent(userId, id, { pendingQuestionId = null } = {}, { now = new Date() } = {}) {
    const uid = requireUserId(userId, 'markProactiveEventSent');
    await client.execute({
      sql: `UPDATE proactive_events SET sent_at = ?, pending_question_id = ?
             WHERE user_id = ? AND id = ?`,
      args: [nowIso(now), pendingQuestionId, uid, id],
    });
    if (pendingQuestionId === null || pendingQuestionId === undefined) {
      await client.execute({
        sql: `UPDATE proactive_events
                 SET outcome = ?, resolved_at = ?
               WHERE user_id = ? AND id = ? AND outcome IS NULL`,
        args: [PROACTIVE_OUTCOME.DELIVERED, nowIso(now), uid, id],
      });
    }
    return true;
  }

  /**
   * 結案：記下這次的結果，並（如果有的話）連回使用者的回答變成的那筆 journal。
   * journalEventId 傳 null 代表「使用者說沒有 / 看不懂」，沒有 journal 產生。
   */
  async function resolveProactiveEvent(userId, id, outcome, { journalEventId = null, now = new Date() } = {}) {
    const uid = requireUserId(userId, 'resolveProactiveEvent');
    const rs = await client.execute({
      sql: `UPDATE proactive_events
               SET outcome = ?, resolved_at = ?,
                   journal_event_id = COALESCE(?, journal_event_id)
             WHERE user_id = ? AND id = ?`,
      args: [outcome, nowIso(now), journalEventId, uid, id],
    });
    return Number(rs.rowsAffected ?? 0) > 0;
  }

  /**
   * 把一個**還沒有結果**的事件標成某個終局結果。
   *
   * 與 resolveProactiveEvent 的差別只有一個、但很關鍵的條件：
   * `AND outcome IS NULL`。收割器用這一個來寫 NO_RESPONSE，所以
   *
   *   - 使用者已經回答過（outcome 已經是 EXPLAINED / STILL_UNEXPLAINED /
   *     NO_EXPLANATION_OFFERED）→ rowsAffected = 0，**絕不會被覆寫成
   *     NO_RESPONSE**
   *   - 遲到的回答走的是 resolvePendingQuestion，那條路在 pending 那一層
   *     就已經被擋掉（狀態已經不是 OPEN），所以也不會反過來蓋掉
   *     NO_RESPONSE
   *   - 收割器重跑 → 第二次 rowsAffected = 0 → 天然冪等
   *
   * 回傳 true 代表這一次呼叫真的寫進去了。
   */
  async function resolveProactiveEventIfUnresolved(userId, id, outcome, {
    now = new Date(), requireNoLease = false, journalEventId = null,
  } = {}) {
    const uid = requireUserId(userId, 'resolveProactiveEventIfUnresolved');
    // ★ R2-M-03：收割孤兒時要在**同一句 SQL 裡**重新確認資格。
    //
    // 只在 SELECT 階段檢查「有沒有人在處理」是不夠的：SELECT 與 UPDATE
    // 之間有一段時間，回答流程可以剛好在那一瞬間取得租約。把租約條件放進
    // UPDATE 的 WHERE，「settle 孤兒」就變成一個真正原子的轉移。
    const leaseGuard = requireNoLease
      ? ` AND NOT EXISTS (SELECT 1 FROM resource_locks
                           WHERE name = ? AND expires_at > ?)`
      : '';
    const args = [outcome, nowIso(now), journalEventId, uid, id];
    if (requireNoLease) {
      args.push(PROACTIVE_PROCESSING_LEASE.name(uid, id), nowIso(now));
    }
    const rs = await client.execute({
      sql: `UPDATE proactive_events
               SET outcome = ?, resolved_at = ?,
                   journal_event_id = COALESCE(?, journal_event_id)
             WHERE user_id = ? AND id = ? AND outcome IS NULL${leaseGuard}`,
      args,
    });
    return Number(rs.rowsAffected ?? 0) > 0;
  }

  /**
   * 「已經送出、但永遠不可能再被正常流程結案」的事件（M-03）。
   *
   * ## 為什麼需要這一條路
   *
   * 收割器原本只看 pending_questions 的 OPEN / EXPIRED。但追問還有兩個
   * **終局狀態**會把事件永久留在 outcome = NULL：
   *
   *   ANSWERED    澄清追問流程：Q1 被收成 ANSWERED → 接著開 Q2。
   *               這是**兩次寫入**，中間 process 死掉的話 Q2 從來不存在，
   *               而 Q1 已經是 ANSWERED——收割器的清單刻意排除 ANSWERED
   *               （寫 NO_RESPONSE 會是事實錯誤），於是事件永遠卡住。
   *
   *   SUPERSEDED  這題還沒被回答就被新的追問取代了。同樣不在清單裡。
   *
   * 實測確認：兩種狀態下把收割器連跑三次，事件都還是 NULL。後果是
   * Guardian 每 12 小時誤報一次「有事件卡住」，而且**永遠**不會消失——
   * 這種假警報會很快讓人開始忽略真的警報。
   *
   * ## 判準
   *
   * 條件跟 Guardian 的 `countStuckProactiveEvents` 對齊（送出了、沒有結果、
   * 夠舊），再加上一條關鍵的安全條件：
   *
   *   **沒有任何 OPEN 的追問還指著這個事件。**
   *
   * 這一條同時看兩種連結（欄位 `pending_question_id` 與 context 裡的
   * `proactive_event_id`），所以澄清追問 Q2 還開著的時候，事件不會被誤判
   * 成「無人接手」。`grace` 則保證不會跟一個正在處理中的請求打架。
   *
   * `last_status` 是最後一題（不管哪種連結）的狀態，呼叫端據此選出誠實的
   * 終局標籤——絕不一律寫 NO_RESPONSE。
   *
   * json_valid 的理由與 UNRESOLVED_EVENT_ID_SQL 相同：libSQL 對壞掉的
   * JSON 直接 json_extract 會讓**整個查詢**失敗。
   */
  async function listUnresolvableProactiveEvents(userId, { olderThanIso, limit = 100 } = {}) {
    const uid = requireUserId(userId, 'listUnresolvableProactiveEvents');
    const LINKED = `(q.id = e.pending_question_id
                     OR (json_valid(q.context_json)
                         AND json_extract(q.context_json, '$.proactive_event_id') = e.id))`;
    const rs = await client.execute({
      sql: `SELECT e.id AS event_id, e.sent_at,
                   (SELECT COUNT(*) FROM pending_questions q
                     WHERE q.user_id = e.user_id AND q.status = 'OPEN' AND ${LINKED}) AS open_links,
                   (SELECT q.status FROM pending_questions q
                     WHERE q.user_id = e.user_id AND ${LINKED}
                     ORDER BY q.id DESC LIMIT 1) AS last_status
              FROM proactive_events e
             WHERE e.user_id = ?
               AND e.sent_at IS NOT NULL
               AND e.outcome IS NULL
               AND e.sent_at <= ?
             ORDER BY e.id ASC
             LIMIT ?`,
      args: [uid, olderThanIso, limit],
    });
    return rs.rows
      .filter((r) => Number(r.open_links ?? 0) === 0)
      .map((r) => ({
        eventId: Number(r.event_id),
        sentAt: r.sent_at,
        lastStatus: r.last_status ?? null,
      }));
  }

  /** 找「這個使用者、由某個 pending_question_id 連過來」的事件（reanalysis 用）。 */
  async function getProactiveEventByPendingQuestion(userId, pendingQuestionId) {
    const uid = requireUserId(userId, 'getProactiveEventByPendingQuestion');
    const rs = await client.execute({
      sql: `SELECT * FROM proactive_events
             WHERE user_id = ? AND pending_question_id = ?
             ORDER BY id DESC LIMIT 1`,
      args: [uid, pendingQuestionId],
    });
    return rowToEvent(rs.rows[0]);
  }

  /** 最近 N 天的事件——反騷擾（冷卻／每日上限）與新鮮度判斷都靠這個。 */
  async function getRecentProactiveEvents(userId, { sinceIso, limit = 50 } = {}) {
    const uid = requireUserId(userId, 'getRecentProactiveEvents');
    const rs = await client.execute({
      sql: `SELECT * FROM proactive_events
             WHERE user_id = ? AND created_at >= ?
             ORDER BY created_at DESC LIMIT ?`,
      args: [uid, sinceIso, limit],
    });
    return rs.rows.map(rowToEvent);
  }

  function rowToEvent(row) {
    if (!row) return null;
    return {
      id: Number(row.id),
      userId: row.user_id,
      healthDate: row.health_date,
      idempotencyKey: row.idempotency_key,
      signals: row.signals_json ? JSON.parse(row.signals_json) : [],
      decision: row.decision,
      reason: row.reason_json ? JSON.parse(row.reason_json) : null,
      policyVersion: row.policy_version,
      pendingQuestionId: row.pending_question_id === null ? null : Number(row.pending_question_id),
      journalEventId: row.journal_event_id === null || row.journal_event_id === undefined
        ? null : Number(row.journal_event_id),
      messageText: row.message_text,
      sentAt: row.sent_at,
      createdAt: row.created_at,
      resolvedAt: row.resolved_at,
      outcome: row.outcome,
    };
  }

  return {
    getProactiveState,
    setProactiveState,
    isProactiveEnabled,
    setProactiveEnabled,
    claimProactiveEvent,
    markProactiveEventSent,
    resolveProactiveEvent,
    resolveProactiveEventIfUnresolved,
    listUnresolvableProactiveEvents,
    getProactiveEventByPendingQuestion,
    getRecentProactiveEvents,
  };
}
