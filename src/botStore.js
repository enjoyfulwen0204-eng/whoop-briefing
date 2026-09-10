/**
 * Telegram bot / journal / 對話狀態的持久化。
 *
 * 與 store.js 分開純粹是為了檔案不要過長；語義上是同一層。
 * 一樣的原則：只做「存」與「取」，不做任何健康判斷。
 */

import { log } from './logger.js';
import { requireUserId } from './userContext.js';

const nowIso = (d = new Date()) => d.toISOString();

/**
 * context_json → 物件。**壞掉就回 null，絕不拋錯。**
 *
 * 收割器一次處理一批追問；如果其中一列的 context 壞了就讓整個查詢的
 * 結果映射拋錯，那個使用者的收割會永遠停擺——等於用一個新的永久卡死
 * 取代舊的永久卡死。
 */
function safeParseContext(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

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

  /**
   * 原子認領一則 Telegram update（M-09）。回 true 代表**這一次**認領成功。
   *
   * ## 為什麼 offset 不夠
   *
   * 每一則訊息的流程是「處理（寫 journal、跑分析、送訊息）→ 存 offset」，
   * 這是兩段寫入。中間 worker 被殺（部署、OOM、SIGKILL）的話 offset 還是
   * 舊的，Telegram 會把同一則 update 再送一次 —— 同一句「喝了兩杯」就被
   * 寫成兩筆 journal。實測確認：重送一次 → 2 筆。
   *
   * journal 是所有長期關聯分析的輸入，重複的曝露日會直接扭曲相關係數，
   * 而且**永遠不會自己修好**。
   *
   * INSERT-first + PRIMARY KEY 衝突，跟 claimProactiveEvent 是同一個模式：
   * 認領成功才有資格產生副作用。
   */
  async function claimTelegramUpdate(updateId, { now = new Date() } = {}) {
    // ⚠️ `Number(null) === 0`、`Number('') === 0`、`Number([]) === 0`——
    // 少了這一行，一個空的 update_id 會被當成合法的 id 0 認領下去。
    // 這個陷阱在這個 codebase 裡已經出現過三次，一律先排除空值再轉數字。
    if (updateId === null || updateId === undefined || updateId === '') return false;
    if (typeof updateId === 'object' || typeof updateId === 'boolean') return false;
    const id = Number(updateId);
    if (!Number.isInteger(id)) return false;
    try {
      await client.execute({
        sql: `INSERT INTO telegram_processed_updates (update_id, processed_at)
              VALUES (?, ?)`,
        args: [id, nowIso(now)],
      });
      return true;
    } catch (err) {
      if (/UNIQUE constraint failed|PRIMARY KEY/i.test(String(err?.message ?? ''))) return false;
      throw err;
    }
  }

  /**
   * 把太舊的認領紀錄刪掉。update_id 對一個 bot 是單調遞增的，
   * 所以「保留最近 keep 個 id」就是一個確定性、O(索引) 的裁剪，
   * 不需要時間欄位、也不需要掃全表。
   */
  async function pruneTelegramUpdates(currentUpdateId, { keep = 10_000 } = {}) {
    if (currentUpdateId === null || currentUpdateId === undefined || currentUpdateId === '') return 0;
    const id = Number(currentUpdateId);
    if (!Number.isFinite(id) || id <= keep) return 0;
    const rs = await client.execute({
      sql: 'DELETE FROM telegram_processed_updates WHERE update_id < ?',
      args: [id - keep],
    });
    return Number(rs.rowsAffected ?? 0);
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
    // ★ L-01：壞掉的 context 絕不可以把整個對話卡死。
    //
    // 舊版直接 `JSON.parse(row.context_json)`。一列壞掉的 context 會讓
    // 這個 map 拋錯，而這支函式是 `route()` 的**第一步** —— 於是那個使用者
    // 送的**每一則**訊息（連 `/status` 都算）都只會拿到「我這邊出了點問題」。
    // 而且追問永遠停在 OPEN（惰性過期的 UPDATE 根本走不到），所以這是
    // **永久**卡死，只能人工改資料庫才救得回來。實測確認。
    //
    // 解不開的 context 代表這一題已經沒辦法被正確回答了。與其保留一顆
    // 地雷，不如就地收掉它：使用者的下一句話會走一般路徑，對話立刻復原。
    const context = safeParseContext(row.context_json);
    if (row.context_json && context === null) {
      log.warn('pending_question_context_unparsable', { user_id: uid, id: Number(row.id) });
      await client.execute({
        sql: `UPDATE pending_questions SET status = 'EXPIRED'
               WHERE user_id = ? AND id = ? AND status = 'OPEN'`,
        args: [uid, row.id],
      });
      return null;
    }

    return {
      id: Number(row.id),
      chatId: row.chat_id,
      originalMessage: row.original_message,
      question: row.question,
      intent: row.intent,
      context,
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
  /**
   * 一個追問「還沒有結果、而且屬於同一個使用者」的事件 id。
   *
   * ## RF-01：為什麼需要**兩種**連結
   *
   * 問題與事件之間的關係在系統裡有兩種表示法：
   *
   *   1. `proactive_events.pending_question_id`（欄位）
   *   2. `pending_questions.context_json.proactive_event_id`（context）
   *
   * 正常情況下兩者指向同一件事。但**澄清追問**會讓它們分岔：
   * router 在聽不懂使用者的回答時會開一個新的追問（Q2），context 沿用同一個
   * `proactive_event_id`，但**不會**呼叫 markProactiveEventSent——所以事件的
   * `pending_question_id` 仍然指著原本那題（Q1，此時已經是 ANSWERED）。
   *
   * 只看欄位的話，Q2 過期之後永遠找不到它的事件，事件就永遠停在 NULL。
   *
   * ## 為什麼要用 json_valid 包起來
   *
   * 實測（libSQL）：對壞掉的 JSON 直接 `json_extract` 會拋
   * `SQLITE_ERROR: malformed JSON`，而且是**整個查詢**失敗——一列壞資料
   * 就會讓這個使用者的收割永遠停擺。`json_valid` 先擋一層之後，壞掉的
   * JSON 與 NULL 都只會得到 NULL，`e.id = NULL` 為假，安全地不匹配。
   *
   * ## 為什麼是 COALESCE 兩個子查詢，而不是一個 OR
   *
   * 欄位是最權威的連結，context 是備援；兩者理論上指向不同事件時
   * （目前沒有任何程式路徑會產生）必須有確定的優先順序。
   *
   * 一開始寫成單一子查詢 + `ORDER BY CASE WHEN e.pending_question_id =
   * pending_questions.id ...`，但 SQLite 在子查詢的 ORDER BY 裡解析不到
   * 外層的關聯欄位，實測直接拋 `no such column: pending_questions.id`。
   * 拆成兩個子查詢之後，每個子查詢的 ORDER BY 只碰自己的表，關聯只出現
   * 在 WHERE（那是合法的），優先順序也變得一目瞭然。
   *
   * 兩個子查詢的 `user_id` 條件缺一不可：**絕不能相信 context 裡的事件
   * id**，它可能被偽造成別人的事件。
   */
  const UNRESOLVED_EVENT_ID_SQL = `COALESCE(
    (SELECT e.id FROM proactive_events e
      WHERE e.user_id = pending_questions.user_id
        AND e.outcome IS NULL
        AND e.pending_question_id = pending_questions.id
      ORDER BY e.id ASC LIMIT 1),
    (SELECT e2.id FROM proactive_events e2
      WHERE e2.user_id = pending_questions.user_id
        AND e2.outcome IS NULL
        AND e2.id = CASE WHEN json_valid(pending_questions.context_json)
                         THEN json_extract(pending_questions.context_json, '$.proactive_event_id')
                    END
      ORDER BY e2.id ASC LIMIT 1)
  )`;

  async function listReapablePendingQuestions(userId, { now = new Date(), intent = null, limit = 100 } = {}) {
    const uid = requireUserId(userId, 'listReapablePendingQuestions');
    // OPEN：還沒收過，一律要處理（不管它有沒有連到事件）。
    //
    // EXPIRED：**只有**在它連得到的事件還沒有結果時才需要處理——那正是
    // 要修的半完成狀態。加上這個條件，已經修好的列就自然退出清單，
    // 收割器會收斂到零工作量；否則每天累積一列 EXPIRED，每輪都要重新
    // 拜訪一次。這個條件是**精確**的，不是時間窗猜測，不需要新門檻常數。
    const where = [
      'user_id = ?',
      'expires_at <= ?',
      `(status = 'OPEN' OR (status = 'EXPIRED' AND ${UNRESOLVED_EVENT_ID_SQL} IS NOT NULL))`,
    ];
    const args = [uid, nowIso(now)];
    if (intent) { where.push('intent = ?'); args.push(intent); }
    args.push(limit);
    // ★ 選取與解析用**同一個** SQL 運算式算出事件 id，所以兩者在結構上
    // 不可能不一致——收割器不需要（也不可以）自己再推一次目標事件。
    const rs = await client.execute({
      sql: `SELECT *, ${UNRESOLVED_EVENT_ID_SQL} AS unresolved_event_id
              FROM pending_questions WHERE ${where.join(' AND ')}
             ORDER BY id ASC LIMIT ?`,
      args,
    });
    return rs.rows.map((row) => ({
      id: Number(row.id),
      chatId: row.chat_id,
      question: row.question,
      intent: row.intent,
      // 壞掉的 context 不可以讓整批收割爆掉：解析失敗就當作沒有 context。
      // 事件 id 本來就不從這裡取（見 unresolvedEventId），所以完全無損。
      context: safeParseContext(row.context_json),
      askedAt: row.asked_at,
      expiresAt: row.expires_at,
      status: row.status,
      // 已經過同一使用者驗證的目標事件；沒有就是 null。
      unresolvedEventId: row.unresolved_event_id === null || row.unresolved_event_id === undefined
        ? null
        : Number(row.unresolved_event_id),
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
    claimTelegramUpdate,
    pruneTelegramUpdates,
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
