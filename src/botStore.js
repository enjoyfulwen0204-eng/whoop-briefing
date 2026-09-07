/**
 * Telegram bot / journal / 對話狀態的持久化。
 *
 * 與 store.js 分開純粹是為了檔案不要過長；語義上是同一層。
 * 一樣的原則：只做「存」與「取」，不做任何健康判斷。
 */

import { log } from './logger.js';
import { requireUserId } from './userContext.js';

const nowIso = (d = new Date()) => d.toISOString();

export function createBotStore(client) {
  // -------------------------------------------------------------------------
  // telegram_state（key-value）
  // -------------------------------------------------------------------------
  async function getState(key) {
    const rs = await client.execute({
      sql: 'SELECT value FROM telegram_state WHERE key = ?',
      args: [key],
    });
    return rs.rows[0]?.value ?? null;
  }

  async function setState(key, value, { now = new Date() } = {}) {
    await client.execute({
      sql: `INSERT INTO telegram_state (key, value, updated_at) VALUES (?,?,?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value,
                                          updated_at = excluded.updated_at`,
      args: [key, value === null || value === undefined ? null : String(value), nowIso(now)],
    });
    return true;
  }

  /**
   * getUpdates 的 offset。
   * 語義：「下一次要從這個 update_id 開始拿」。Telegram 收到 offset 之後
   * 會把更小的 update 標記為已確認、不再送。
   */
  async function getUpdateOffset() {
    const v = await getState('telegram_offset');
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  async function setUpdateOffset(offset, { now = new Date() } = {}) {
    return setState('telegram_offset', String(offset), { now });
  }

  // -------------------------------------------------------------------------
  // journal_events
  // -------------------------------------------------------------------------
  async function addJournalEvent(userId, e, { now = new Date() } = {}) {
    const uid = requireUserId(userId, 'addJournalEvent');
    const ts = nowIso(now);
    const rs = await client.execute({
      sql: `INSERT INTO journal_events
              (user_id, event_at, health_date, category, subtype, numeric_value, text_value,
               unit, severity, note, source, created_at, updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: [
        uid, e.eventAt, e.healthDate, e.category, e.subtype ?? null,
        e.numericValue ?? null, e.textValue ?? null, e.unit ?? null,
        e.severity ?? null, e.note ?? null, e.source ?? 'manual', ts, ts,
      ],
    });
    const id = Number(rs.lastInsertRowid ?? 0);
    log.info('journal_event_added', {
      user_id: uid, id, category: e.category, health_date: e.healthDate, source: e.source,
    });
    return id;
  }

  async function getJournalEvents(userId, { from, to, category = null, limit = 500 } = {}) {
    const uid = requireUserId(userId, 'getJournalEvents');
    const where = ['user_id = ?', 'health_date >= ?', 'health_date <= ?'];
    const args = [uid, from, to];
    if (category) { where.push('category = ?'); args.push(category); }
    args.push(limit);
    const rs = await client.execute({
      sql: `SELECT * FROM journal_events WHERE ${where.join(' AND ')}
             ORDER BY event_at DESC LIMIT ?`,
      args,
    });
    return rs.rows.map((r) => ({ ...r }));
  }

  async function countJournalEvents(userId) {
    const uid = requireUserId(userId, 'countJournalEvents');
    const rs = await client.execute({
      sql: 'SELECT COUNT(*) AS c FROM journal_events WHERE user_id = ?',
      args: [uid],
    });
    return Number(rs.rows[0].c);
  }

  async function deleteJournalEvent(userId, id) {
    const uid = requireUserId(userId, 'deleteJournalEvent');
    const rs = await client.execute({
      // user_id 條件是防越權刪除：帶別人的 id 進來一律刪不到
      sql: 'DELETE FROM journal_events WHERE user_id = ? AND id = ?',
      args: [uid, id],
    });
    return Number(rs.rowsAffected ?? 0) > 0;
  }

  // -------------------------------------------------------------------------
  // pending_questions
  // -------------------------------------------------------------------------
  /**
   * 開一個新的追問。同一個 chat 先前還開著的會被標成 SUPERSEDED ——
   * 同時只允許一個 OPEN，否則使用者的下一句話不知道要接哪一個。
   */
  async function openPendingQuestion(userId, q, { now = new Date() } = {}) {
    const uid = requireUserId(userId, 'openPendingQuestion');
    // 「一個使用者同時只有一個 OPEN」—— 依 user_id 而不是 chat_id，
    // 這樣使用者換 chat 也不會同時留著兩個未回答的追問。
    await client.execute({
      sql: `UPDATE pending_questions SET status = 'SUPERSEDED'
             WHERE user_id = ? AND status = 'OPEN'`,
      args: [uid],
    });
    const rs = await client.execute({
      sql: `INSERT INTO pending_questions
              (user_id, chat_id, original_message, question, intent, context_json,
               asked_at, expires_at, status)
            VALUES (?,?,?,?,?,?,?,?, 'OPEN')`,
      args: [
        uid, String(q.chatId), q.originalMessage ?? null, q.question,
        q.intent ?? null, q.contextJson ? JSON.stringify(q.contextJson) : null,
        nowIso(now), new Date(now.getTime() + q.ttlMs).toISOString(),
      ],
    });
    const id = Number(rs.lastInsertRowid ?? 0);
    log.info('pending_question_opened', { user_id: uid, id, intent: q.intent });
    return id;
  }

  /**
   * 取這個 chat 目前有效的追問。
   * **過期的一律回 null**，並順手標成 EXPIRED —— 三十分鐘前問的問題，
   * 使用者現在講的話多半跟它無關，硬接會答非所問。
   */
  async function getOpenPendingQuestion(userId, { now = new Date() } = {}) {
    const uid = requireUserId(userId, 'getOpenPendingQuestion');
    const rs = await client.execute({
      sql: `SELECT * FROM pending_questions
             WHERE user_id = ? AND status = 'OPEN'
             ORDER BY id DESC LIMIT 1`,
      args: [uid],
    });
    const row = rs.rows[0];
    if (!row) return null;
    if (Date.parse(row.expires_at) <= now.getTime()) {
      await client.execute({
        sql: "UPDATE pending_questions SET status = 'EXPIRED' WHERE id = ?",
        args: [row.id],
      });
      log.info('pending_question_expired', { id: Number(row.id) });
      return null;
    }
    return {
      id: Number(row.id),
      chatId: row.chat_id,
      originalMessage: row.original_message,
      question: row.question,
      intent: row.intent,
      context: row.context_json ? JSON.parse(row.context_json) : null,
      askedAt: row.asked_at,
      expiresAt: row.expires_at,
      status: row.status,
    };
  }

  async function resolvePendingQuestion(userId, id, answerText, { now = new Date() } = {}) {
    const uid = requireUserId(userId, 'resolvePendingQuestion');
    const rs = await client.execute({
      sql: `UPDATE pending_questions
               SET status = 'ANSWERED', answered_at = ?, answer_text = ?
             WHERE user_id = ? AND id = ? AND status = 'OPEN'`,
      args: [nowIso(now), answerText ?? null, uid, id],
    });
    return Number(rs.rowsAffected ?? 0) > 0;
  }

  async function cancelPendingQuestion(userId, id) {
    const uid = requireUserId(userId, 'cancelPendingQuestion');
    const rs = await client.execute({
      sql: `UPDATE pending_questions SET status = 'CANCELLED'
             WHERE user_id = ? AND id = ? AND status = 'OPEN'`,
      args: [uid, id],
    });
    return Number(rs.rowsAffected ?? 0) > 0;
  }

  return {
    getState,
    setState,
    getUpdateOffset,
    setUpdateOffset,
    addJournalEvent,
    getJournalEvents,
    countJournalEvents,
    deleteJournalEvent,
    openPendingQuestion,
    getOpenPendingQuestion,
    resolvePendingQuestion,
    cancelPendingQuestion,
  };
}
