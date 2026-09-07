/**
 * Proactive Agent 的持久化層（PA3／PA9）。
 *
 * 跟 botStore.js／analysisStore.js 同一個原則：只做「存」與「取」，
 * 不做任何訊號判斷或決策——那些邏輯在 signals.js／attention.js／
 * proactiveAgent.js。
 */

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
    return { userId: row.user_id, lastCheckedHealthDate: row.last_checked_health_date, updatedAt: row.updated_at };
  }

  async function setProactiveState(userId, { lastCheckedHealthDate }, { now = new Date() } = {}) {
    const uid = requireUserId(userId, 'setProactiveState');
    await client.execute({
      sql: `INSERT INTO proactive_agent_state (user_id, last_checked_health_date, updated_at)
            VALUES (?,?,?)
            ON CONFLICT(user_id) DO UPDATE SET
              last_checked_health_date = excluded.last_checked_health_date,
              updated_at = excluded.updated_at`,
      args: [uid, lastCheckedHealthDate, nowIso(now)],
    });
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

  async function markProactiveEventSent(userId, id, { pendingQuestionId = null } = {}, { now = new Date() } = {}) {
    const uid = requireUserId(userId, 'markProactiveEventSent');
    await client.execute({
      sql: `UPDATE proactive_events SET sent_at = ?, pending_question_id = ?
             WHERE user_id = ? AND id = ?`,
      args: [nowIso(now), pendingQuestionId, uid, id],
    });
    return true;
  }

  async function resolveProactiveEvent(userId, id, outcome, { now = new Date() } = {}) {
    const uid = requireUserId(userId, 'resolveProactiveEvent');
    const rs = await client.execute({
      sql: `UPDATE proactive_events SET outcome = ?, resolved_at = ?
             WHERE user_id = ? AND id = ?`,
      args: [outcome, nowIso(now), uid, id],
    });
    return Number(rs.rowsAffected ?? 0) > 0;
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
    claimProactiveEvent,
    markProactiveEventSent,
    resolveProactiveEvent,
    getProactiveEventByPendingQuestion,
    getRecentProactiveEvents,
  };
}
