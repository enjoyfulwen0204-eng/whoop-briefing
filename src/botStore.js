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
      // `AND status = 'OPEN'` 是刻意的：這句話與 resolvePendingQuestion 及
      // 收割器互為競爭者，三者都用同一個條件式 UPDATE 當原子閘門。少了它，
      // 一個剛剛被回答（已經是 ANSWERED）的問題可能被這裡覆寫回 EXPIRED，
      // 使用者的答案就靜靜消失了。
      //
      // F-05：`user_id = ?` 是外部稽核要求補上的。上面那個 SELECT 已經帶了
      // user_id，所以這一列必然屬於 uid——但這是整個 codebase 裡唯一一句
      // 沒有 user scope 的 per-user 寫入，不該靠「呼叫端剛好查對了」成立。
      await client.execute({
        sql: `UPDATE pending_questions SET status = 'EXPIRED'
               WHERE user_id = ? AND id = ? AND status = 'OPEN'`,
        args: [uid, row.id],
      });
      // ⚠️ 這裡**只**把問題收成 EXPIRED，不碰對應的 proactive_events。
      // 事件的收尾（outcome = NO_RESPONSE）一律由收割器負責，而收割器
      // 現在看得到已經 EXPIRED 的列（見 listReapablePendingQuestions），
      // 所以「惰性過期先發生」不會再讓事件永遠停在 NULL。
      log.info('pending_question_expired', { user_id: uid, id: Number(row.id) });
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

  /**
   * 收割器要處理的追問：TTL 已到，而且**還沒有走到「使用者真的回應過」
   * 的終局**。
   *
   * ## F-01：為什麼一定要包含已經是 EXPIRED 的列
   *
   * `OPEN → EXPIRED` 這個轉移有**兩個**寫入者：收割器，以及
   * `getOpenPendingQuestion()` 的惰性過期（它在 proactiveAgent 每次 cron、
   * bot router 每則訊息、`/status` 都會被觸發，而且只收問題、不碰事件）。
   *
   * 舊版只選 `status = 'OPEN'`，所以只要惰性過期先發生一次，那一列就
   * **永遠**從收割器的視野裡消失，連帶讓 proactive_events.outcome 永遠
   * 停在 NULL —— 無法自我修復，而且會讓 Guardian 每 12 小時誤報一次
   * 「有事件卡住」直到天荒地老。
   *
   * 現在兩條路徑匯流到同一個終局：不管誰先把問題收成 EXPIRED，收割器
   * 都還看得到它，並用 `outcome IS NULL` 這個閘門補上 NO_RESPONSE。
   *
   * ANSWERED 與 SUPERSEDED **刻意不在清單裡**：
   *   ANSWERED    使用者真的回答過，寫 NO_RESPONSE 會是事實錯誤
   *   SUPERSEDED  被新問題取代，本來就不該有「沒回應」這個結論
   *
   * 一樣用 intent 過濾：只有主動代理發出的問題才連著 proactive_events。
   */
  async function listReapablePendingQuestions(userId, { now = new Date(), intent = null, limit = 100 } = {}) {
    const uid = requireUserId(userId, 'listReapablePendingQuestions');
    // OPEN：還沒收過，一律要處理（不管它有沒有連到事件）。
    //
    // EXPIRED：**只有**在它連著的事件還沒有結果時才需要處理——那正是
    // 要修的半完成狀態。加上這個條件，已經修好的列就自然退出清單，
    // 收割器會收斂到零工作量；否則每天累積一列 EXPIRED，每輪都要重新
    // 拜訪一次。這個條件是**精確**的，不是時間窗猜測，不需要新門檻常數。
    const where = [
      'user_id = ?',
      'expires_at <= ?',
      `(status = 'OPEN' OR (status = 'EXPIRED' AND EXISTS (
          SELECT 1 FROM proactive_events e
           WHERE e.user_id = pending_questions.user_id
             AND e.pending_question_id = pending_questions.id
             AND e.outcome IS NULL)))`,
    ];
    const args = [uid, nowIso(now)];
    if (intent) { where.push('intent = ?'); args.push(intent); }
    args.push(limit);
    const rs = await client.execute({
      sql: `SELECT * FROM pending_questions WHERE ${where.join(' AND ')}
             ORDER BY id ASC LIMIT ?`,
      args,
    });
    return rs.rows.map((row) => ({
      id: Number(row.id),
      chatId: row.chat_id,
      question: row.question,
      intent: row.intent,
      context: row.context_json ? JSON.parse(row.context_json) : null,
      askedAt: row.asked_at,
      expiresAt: row.expires_at,
      status: row.status,
    }));
  }

  /**
   * OPEN → EXPIRED 的**原子**轉移。
   *
   * 回傳 true 代表「這一次呼叫真的把它從 OPEN 收走了」。
   * `AND status = 'OPEN'` 讓收割器與使用者的回答（resolvePendingQuestion
   * 用的是同一個條件）恰好只有一個會成功——這就是「終局狀態只會有一個
   * 贏家」的保證來源，不是靠呼叫端先查再寫。
   */
  async function expirePendingQuestion(userId, id, { now = new Date() } = {}) {
    const uid = requireUserId(userId, 'expirePendingQuestion');
    const rs = await client.execute({
      sql: `UPDATE pending_questions SET status = 'EXPIRED'
             WHERE user_id = ? AND id = ? AND status = 'OPEN'`,
      args: [uid, id],
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
    listReapablePendingQuestions,
    expirePendingQuestion,
  };
}
