/**
 * Telegram bot / journal / 對話狀態的持久化。
 *
 * 與 store.js 分開純粹是為了檔案不要過長；語義上是同一層。
 * 一樣的原則：只做「存」與「取」，不做任何健康判斷。
 */

import { log } from './logger.js';
import { TELEGRAM_UPDATE_STATUS } from './schema.js';
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
   * update_id 正規化。回 null 代表這不是一個合法的 id。
   *
   * ⚠️ `Number(null) === 0`、`Number('') === 0`、`Number([]) === 0`——
   * 少了這幾行，一個空的 update_id 會被當成合法的 id 0 認領下去。
   * 這個陷阱在這個 codebase 裡已經出現過三次，一律先排除空值再轉數字。
   */
  function normalizeUpdateId(updateId) {
    if (updateId === null || updateId === undefined || updateId === '') return null;
    if (typeof updateId === 'object' || typeof updateId === 'boolean') return null;
    const id = Number(updateId);
    return Number.isInteger(id) ? id : null;
  }

  /** 一列 → 對外的狀態物件。 */
  const claimRow = (row) => (row ? {
    updateId: Number(row.update_id),
    status: String(row.status ?? TELEGRAM_UPDATE_STATUS.COMPLETED),
    owner: row.owner ?? null,
    attempts: Number(row.attempts ?? 1),
    leaseExpiresAt: row.lease_expires_at ?? null,
    dispatchedAt: row.dispatched_at ?? null,
    processedAt: row.processed_at ?? null,
  } : null);

  async function getTelegramUpdate(updateId) {
    const id = normalizeUpdateId(updateId);
    if (id === null) return null;
    const rs = await client.execute({
      sql: `SELECT update_id, status, owner, attempts, lease_expires_at,
                   dispatched_at, processed_at
              FROM telegram_processed_updates WHERE update_id = ?`,
      args: [id],
    });
    return claimRow(rs.rows[0]);
  }

  /**
   * 原子認領一則 Telegram update（M-09 → R2-M-05 → R3-M-05）。
   *
   * ## 為什麼 offset 不夠
   *
   * 每一則訊息的流程是「處理（寫 journal、跑分析、送訊息）→ 存 offset」，
   * 這是兩段寫入。中間 worker 被殺（部署、OOM、SIGKILL）的話 offset 還是
   * 舊的，Telegram 會把同一則 update 再送一次 —— 同一句「喝了兩杯」就被
   * 寫成兩筆 journal。實測確認：重送一次 → 2 筆。
   *
   * ## 為什麼「有列就跳過」也不夠（R3-M-05）
   *
   * 舊版把「認領」和「做完」壓成同一個事實：列存在 = 處理過。實測重現兩個
   * 後果相反的失敗：
   *
   *   A. 認領成功、**還沒 dispatch** 就被殺 → 重送時看到列 → 當成重複 →
   *      這則訊息一件事都沒做卻永遠不會再被處理（靜默遺失）。
   *   B. INSERT 其實 commit 了，但連線在回應前斷掉 → 重試撞主鍵 → 同樣被
   *      當成重複 → 一樣靜默遺失。
   *
   * 所以認領帶 owner 與租約，而且分階段：
   *
   *   - 撞到自己的 owner（B）→ 這是我自己的認領，續租、繼續做。
   *   - 撞到 CLAIMED 而租約過期（A）→ 前一個 worker 死在零副作用的區間，
   *     安全接手。
   *   - PROCESSING 租約過期 → 接手；telegram_operations 的交易性收據
   *     決定重做未提交工作，或直接取回已提交結果，絕不重做已提交動作。
   *   - 撞到 COMPLETED → 真正的重複。
   *   - 撞到還活著的租約 → 別人正在做，不要碰。
   *
   * 整段是**一句** SQL：ON CONFLICT ... DO UPDATE ... WHERE 讓「可不可以接手」
   * 的判斷和寫入發生在同一個原子步驟裡，不是 SELECT 完再賭一把。
   *
   * @returns {{ok:boolean, state:string, status:string, attempts:number, owner:?string}}
   *   state: 'claimed' | 'completed' | 'in_progress' | 'abandoned' | 'invalid'
   */
  async function claimTelegramUpdate(updateId, {
    owner = 'default', leaseMs = 120_000, now = new Date(),
  } = {}) {
    const id = normalizeUpdateId(updateId);
    if (id === null) return { ok: false, state: 'invalid', status: null, attempts: 0, owner: null };

    const at = nowIso(now);
    const until = nowIso(new Date(now.getTime() + leaseMs));
    const rs = await client.execute({
      sql: `INSERT INTO telegram_processed_updates
              (update_id, status, owner, claimed_at, lease_expires_at, dispatched_at,
               processed_at, attempts)
            VALUES (?, ?, ?, ?, ?, NULL, ?, 1)
            ON CONFLICT(update_id) DO UPDATE SET
              owner            = excluded.owner,
              claimed_at       = excluded.claimed_at,
              lease_expires_at = excluded.lease_expires_at,
              status           = excluded.status,
              attempts         = telegram_processed_updates.attempts + 1
            WHERE telegram_processed_updates.status IN (?, 'PROCESSING')
              AND ((telegram_processed_updates.status = 'CLAIMED' AND telegram_processed_updates.owner = excluded.owner)
                   OR telegram_processed_updates.lease_expires_at IS NULL
                   OR telegram_processed_updates.lease_expires_at <= excluded.claimed_at)`,
      args: [
        // processed_at 填的是「最後一次狀態變動的時間」，不是「處理完成」。
        // ⚠️ 它在既有的正式資料庫上是 NOT NULL，而 ALTER TABLE ADD COLUMN
        // 沒辦法把既有欄位的 NOT NULL 拿掉 —— 塞 NULL 會讓每一次認領在
        // 遷移過的資料庫上直接爆掉（有資料的遷移測試抓到的）。
        // 「做完了沒有」現在由 status 決定，這一欄只是時間戳。
        id, TELEGRAM_UPDATE_STATUS.CLAIMED, String(owner), at, until, at,
        TELEGRAM_UPDATE_STATUS.CLAIMED,
      ],
    });

    if (Number(rs.rowsAffected ?? 0) > 0) {
      const row = await getTelegramUpdate(id);
      return {
        ok: true, state: 'claimed', status: TELEGRAM_UPDATE_STATUS.CLAIMED,
        attempts: row?.attempts ?? 1, owner: String(owner),
      };
    }

    // 沒寫進去 —— 讀出來看是哪一種。這一次讀不需要原子性：
    // COMPLETED / ABANDONED 是終局（不會變回來），而「別人的租約還活著」
    // 最壞的誤判就是我們稍後再試一次，那是安全的。
    const row = await getTelegramUpdate(id);
    if (!row) {
      // 條件式 UPDATE 沒中、列又不見了 —— 只可能是同時被裁剪掉。
      // 當成不可用讓呼叫端 fail closed，比猜一個結果安全。
      return { ok: false, state: 'in_progress', status: null, attempts: 0, owner: null };
    }
    if (row.status === TELEGRAM_UPDATE_STATUS.COMPLETED) {
      return { ok: false, state: 'completed', status: row.status, attempts: row.attempts, owner: row.owner };
    }
    if (row.status === TELEGRAM_UPDATE_STATUS.ABANDONED) {
      return { ok: false, state: 'abandoned', status: row.status, attempts: row.attempts, owner: row.owner };
    }
    // 通常只會看到有效租約。若租約在認領失敗後才到期，暫停這批；
    // 下一次原子認領會接手，不在這裡把尚未提交的工作當作完成。
    if (row.status === TELEGRAM_UPDATE_STATUS.PROCESSING) {
      const expired = !row.leaseExpiresAt || row.leaseExpiresAt <= at;
      return {
        ok: false, state: expired ? 'stale_processing' : 'in_progress',
        status: row.status, attempts: row.attempts, owner: row.owner,
      };
    }
    // CLAIMED 而條件不成立 → 別人的租約還活著。
    return { ok: false, state: 'in_progress', status: row.status, attempts: row.attempts, owner: row.owner };
  }

  /**
   * CLAIMED → PROCESSING。**在 dispatch 之前**呼叫。
   *
   * PROCESSING 只表示可以開始交易。副作用是否已提交由
   * telegram_operations 收據決定，不能由這個狀態猜測。
   *
   * 條件帶 owner：租約掉了就不可以推進狀態。
   */
  async function markTelegramUpdateProcessing(updateId, { owner, now = new Date() } = {}) {
    const id = normalizeUpdateId(updateId);
    if (id === null) return false;
    const rs = await client.execute({
      sql: `UPDATE telegram_processed_updates
               SET status = ?, dispatched_at = ?
             WHERE update_id = ? AND owner = ? AND status = ? AND lease_expires_at > ?`,
      args: [TELEGRAM_UPDATE_STATUS.PROCESSING, nowIso(now), id, String(owner),
        TELEGRAM_UPDATE_STATUS.CLAIMED, nowIso(now)],
    });
    return Number(rs.rowsAffected ?? 0) > 0;
  }

  /**
   * → COMPLETED（終局）。只有持有所有權的人可以標記。
   *
   * 已經是 COMPLETED 就回 true（冪等）；被別人接手了就回 false ——
   * 那代表我們已經不是這則訊息的處理者，不可以宣稱它完成。
   */
  async function completeTelegramUpdate(updateId, { owner, now = new Date() } = {}) {
    const id = normalizeUpdateId(updateId);
    if (id === null) return false;
    const rs = await client.execute({
      sql: `UPDATE telegram_processed_updates
               SET status = ?, processed_at = ?, lease_expires_at = NULL
             WHERE update_id = ? AND owner = ? AND status <> ?`,
      args: [TELEGRAM_UPDATE_STATUS.COMPLETED, nowIso(now), id, String(owner),
        TELEGRAM_UPDATE_STATUS.COMPLETED],
    });
    if (Number(rs.rowsAffected ?? 0) > 0) return true;
    const row = await getTelegramUpdate(id);
    return row?.status === TELEGRAM_UPDATE_STATUS.COMPLETED && row.owner === String(owner);
  }

  /**
   * → ABANDONED（終局）。
   *
   * 用在「上一個 worker 死在 PROCESSING 階段」：副作用做到哪裡不確定，
   * 自動重做的代價（重複的 journal 列，永遠不會自己修好）比放棄高。
   * 明確寫成終局狀態而不是留著，是為了讓它可以被查詢、被人看見。
   */
  async function abandonTelegramUpdate(updateId, { reason = null, now = new Date() } = {}) {
    const id = normalizeUpdateId(updateId);
    if (id === null) return false;
    const rs = await client.execute({
      sql: `UPDATE telegram_processed_updates
               SET status = ?, processed_at = ?, lease_expires_at = NULL
             WHERE update_id = ? AND status = ?
               AND (lease_expires_at IS NULL OR lease_expires_at <= ?)`,
      args: [TELEGRAM_UPDATE_STATUS.ABANDONED, nowIso(now), id,
        TELEGRAM_UPDATE_STATUS.PROCESSING, nowIso(now)],
    });
    const ok = Number(rs.rowsAffected ?? 0) > 0;
    if (ok) log.warn('telegram_update_abandoned', { update_id: id, reason });
    return ok;
  }

  /**
   * 把太舊的認領紀錄刪掉。update_id 對一個 bot 是單調遞增的，
   * 所以「保留最近 keep 個 id」就是一個確定性、O(索引) 的裁剪，
   * 不需要時間欄位、也不需要掃全表。
   *
   * ★ R3-M-05：**只刪終局的列**。刪掉一列 CLAIMED/PROCESSING 等於把
   * 「這則正在被處理」這個事實丟掉 —— 下一次重送就會變成全新的認領，
   * 也就是重新打開了重複寫 journal 的那個洞。
   */
  async function pruneTelegramUpdates(currentUpdateId, { keep = 10_000 } = {}) {
    if (currentUpdateId === null || currentUpdateId === undefined || currentUpdateId === '') return 0;
    const id = Number(currentUpdateId);
    if (!Number.isFinite(id) || id <= keep) return 0;
    const rs = await client.execute({
      sql: `DELETE FROM telegram_processed_updates
             WHERE update_id < ? AND status IN (?, ?)`,
      args: [id - keep, TELEGRAM_UPDATE_STATUS.COMPLETED, TELEGRAM_UPDATE_STATUS.ABANDONED],
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
    markTelegramUpdateProcessing,
    completeTelegramUpdate,
    abandonTelegramUpdate,
    getTelegramUpdate,
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
