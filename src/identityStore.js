/**
 * 身分層：內部使用者、Telegram 綁定、一次性綁定碼、OAuth state。
 *
 * ## 安全原則
 *
 *  - **link code 與 OAuth state 只存 SHA-256 hash，資料庫裡沒有原文。**
 *    原文只在產生的那一刻回給呼叫端（給使用者 / 給 OAuth flow），之後就再也拿不到。
 *  - 兩者都是**一次性**：用單一條件式 UPDATE 當原子閘門（`used_at IS NULL`
 *    / `consumed_at IS NULL`），所以並發重複使用只有一個會成功。
 *  - 內部 user id 是 UUID，與 Telegram chat id、WHOOP user id 都無關。
 *  - **絕不 log 原始 code / state。**
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  LINK_STATUS, USER_STATUS, ONBOARDING_STATE, isSafePrivateChatId, unsafeChatReason,
  lifecycleActiveSql,
} from './schema.js';
import { requireUserId } from './userContext.js';
import { log } from './logger.js';

/** 產生高強度的一次性碼（128 bits）。回傳原文，呼叫端只有這一次機會拿到。 */
export function generateSecret(bytes = 16) {
  return randomBytes(bytes).toString('base64url');
}

export function hashSecret(raw) {
  return createHash('sha256').update(String(raw), 'utf8').digest('hex');
}

const iso = (d) => (d instanceof Date ? d : new Date(d)).toISOString();

function rowToUser(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    displayName: row.display_name,
    timezone: row.timezone,
    status: row.status,
    // ★ v17：帳號啟用世代。健康工作在開跑時捕捉它，之後每一個耐久變更
    // 都必須在 SQL 裡證明它沒變（見 schema.js 的 LIFECYCLE_GENERATION_DOC）。
    lifecycleGeneration: Number(row.lifecycle_generation ?? 1),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createIdentityStore(client, { transaction = null } = {}) {
  // 沒有注入交易時退回直接執行（單句仍是原子的，只是失去多句的原子性）。
  const inTransaction = typeof transaction === 'function' ? transaction : (fn) => fn();
  // ----- users -----------------------------------------------------------
  async function createUser({
    id = randomUUID(),
    displayName,
    timezone = 'Asia/Taipei',
    status = USER_STATUS.ACTIVE,
    now = new Date(),
  }) {
    if (!displayName || !String(displayName).trim()) throw new Error('createUser 需要 displayName');
    if (!Object.values(USER_STATUS).includes(status)) throw new Error(`不合法的 status：${status}`);
    const ts = iso(now);
    await client.execute({
      sql: `INSERT INTO users
              (id, display_name, timezone, status, lifecycle_generation, created_at, updated_at)
            VALUES (?, ?, ?, ?, 1, ?, ?)`,
      args: [id, String(displayName).trim(), timezone, status, ts, ts],
    });
    log.info('user_created', { user_id: id, timezone, status });
    return {
      id, displayName: String(displayName).trim(), timezone, status,
      lifecycleGeneration: 1, createdAt: ts, updatedAt: ts,
    };
  }

  async function getUser(userId) {
    const uid = requireUserId(userId, 'getUser');
    const rs = await client.execute({ sql: 'SELECT * FROM users WHERE id = ?', args: [uid] });
    return rowToUser(rs.rows[0]);
  }

  async function listUsers({ status = null } = {}) {
    const rs = status
      ? await client.execute({ sql: 'SELECT * FROM users WHERE status = ? ORDER BY created_at', args: [status] })
      : await client.execute('SELECT * FROM users ORDER BY created_at');
    return rs.rows.map(rowToUser);
  }

  /** cron 用：只跑 ACTIVE 的使用者。 */
  const listActiveUsers = () => listUsers({ status: USER_STATUS.ACTIVE });

  /**
   * ★ v17：**唯一**可以改 users.status 的路徑，而且改的同時推進啟用世代。
   *
   * 為什麼一定要是同一句 UPDATE：世代的意義是「這一段啟用期」。只要
   * 「改狀態」與「推世代」之間存在任何空隙，就會有一個 worker 在那個空隙裡
   * 用舊世代通過檢查 —— 而那正是這個機制要擋的東西。
   *
   * 狀態沒有真的改變時**不推世代**（`WHERE status <> ?`）：重複執行
   * `user:status --status=ACTIVE` 不該讓所有進行中的健康工作全部失效。
   * 這也讓這支函式是冪等的。
   *
   * 同一個交易裡還做兩件與「新啟用期」語義綁死的事：
   *   · bootstrap 嘗試額度歸零（新的啟用期 = 全新的嘗試脈絡）
   *   · READY 降級成 WHOOP_AUTHORIZED（舊世代的資格證據不能延用到新世代，
   *     見 §10；降級之後 bootstrap 會在新世代重新產生證據）
   *
   * @returns {{changed:boolean, oldStatus, newStatus, oldGeneration, newGeneration}}
   */
  async function transitionUserLifecycle({
    userId, targetStatus, expectedCurrentStatus = null, now = new Date(),
    /**
     * 只給「這一列從來沒有成為一個帳號」的情境（併發 /start 認領輸掉的
     * 孤兒列）。那種列**不可能**有上線狀態、報告認領或分析認領，所以清理
     * 步驟全是 no-op —— 但它們仍然會佔住寫入交易，在 20 路併發的 /start
     * 底下把正常流程餓到 SQLITE_BUSY。
     *
     * 世代仍然由**同一句** UPDATE 原子地推進，所以它不是一個繞過圍欄的
     * 後門：狀態與世代永遠一起改變。
     */
    orphanCleanupOnly = false,
  } = {}) {
    const uid = requireUserId(userId, 'transitionUserLifecycle');
    if (!Object.values(USER_STATUS).includes(targetStatus)) {
      throw new Error(`不合法的 status：${targetStatus}`);
    }
    const ts = iso(now);

    // 轉移現在是一個寫入交易，所以高度併發時會碰到 SQLITE_BUSY。
    // 狀態轉移本身很少見而且很短，有界重試是正確的處置（而不是放棄
    // 原子性）。重試不會造成重複推進：狀態相同時是冪等的 no-op。
    const withBusyRetry = async (fn) => {
      let lastErr;
      for (let attempt = 1; attempt <= 10; attempt++) {
        try { return await fn(); } catch (err) {
          if (!/SQLITE_BUSY|database is locked/i.test(String(err?.message ?? ''))) throw err;
          lastErr = err;
          // 指數退避 + 抖動：沒有抖動的話兩個競爭者會一直同步重試、一直互撞。
          const backoff = Math.min(200, 5 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 10);
          await new Promise((r) => { setTimeout(r, backoff); });
        }
      }
      throw lastErr;
    };

    // 孤兒列：單句原子轉移，不開交易（見 orphanCleanupOnly 的說明）。
    if (orphanCleanupOnly) {
      const one = await client.execute({
        sql: `UPDATE users
                 SET status = ?, lifecycle_generation = lifecycle_generation + 1, updated_at = ?
               WHERE id = ? AND status <> ?`,
        args: [targetStatus, ts, uid, targetStatus],
      });
      return { changed: Number(one.rowsAffected ?? 0) > 0, reason: 'orphan' };
    }

    // ---- ★ R2：整個轉移是**一個**交易 ------------------------------------
    //
    // 第一版把它切成兩步（先改 status + 推世代，之後再歸零嘗試次數、降級
    // READY）。那之間存在一個外部看得見的窗口：帳號已經是新世代的 ACTIVE，
    // 但 onboarding 還是舊世代的 READY —— 排程器在那一瞬間會把他當成可以
    // 發報告的正式使用者。併發的兩個轉移還會讓呼叫端拿到一個「不可能」的
    // 結果（它回報的前後狀態不是它自己提交的那一次）。
    //
    // 現在：讀目前狀態、寫新狀態、推世代、降級 READY、歸零嘗試次數，
    // 全部在同一個交易裡。外界只會看到轉移前或轉移後，沒有中間態。
    return withBusyRetry(() => inTransaction(async () => {
      const cur = (await client.execute({
        sql: 'SELECT status, lifecycle_generation FROM users WHERE id = ?', args: [uid],
      })).rows[0];
      if (!cur) throw new Error(`使用者不存在：${uid}`);
      const oldStatus = String(cur.status);
      const oldGeneration = Number(cur.lifecycle_generation ?? 1);

      if (expectedCurrentStatus !== null && oldStatus !== expectedCurrentStatus) {
        return {
          changed: false, reason: 'unexpected_current_status',
          oldStatus, newStatus: oldStatus, oldGeneration, newGeneration: oldGeneration,
        };
      }

      // 狀態本來就是目標值 → 冪等的 no-op，世代不動。
      if (oldStatus === targetStatus) {
        return {
          changed: false, reason: 'already',
          oldStatus, newStatus: oldStatus, oldGeneration, newGeneration: oldGeneration,
        };
      }

      // CAS：證明我們看到的就是我們要改的那一版。並發的另一個轉移若先提交，
      // 這一句就會影響零列，於是這個呼叫端**不會**回報一次它沒做的轉移。
      const upd = await client.execute({
        sql: `UPDATE users
                 SET status = ?, lifecycle_generation = lifecycle_generation + 1, updated_at = ?
               WHERE id = ? AND status = ? AND lifecycle_generation = ?`,
        args: [targetStatus, ts, uid, oldStatus, oldGeneration],
      });
      if (Number(upd.rowsAffected ?? 0) === 0) {
        return {
          changed: false, reason: 'concurrent_transition',
          oldStatus, newStatus: oldStatus, oldGeneration, newGeneration: oldGeneration,
        };
      }

      // 同一個交易裡做完新啟用期的語義：
      //   · READY 降級（舊世代的資格證據不能延用）
      //   · 嘗試額度歸零（新的啟用期 = 全新的嘗試脈絡）
      await client.execute({
        sql: `UPDATE user_onboarding
                 SET bootstrap_attempts = 0,
                     state = CASE WHEN state = ? THEN ? ELSE state END,
                     state_changed_at = CASE WHEN state = ? THEN ? ELSE state_changed_at END,
                     updated_at = ?
               WHERE user_id = ?`,
        args: [
          ONBOARDING_STATE.READY, ONBOARDING_STATE.WHOOP_AUTHORIZED,
          ONBOARDING_STATE.READY, ts, ts, uid,
        ],
      });

      // 舊啟用期的認領不可以繼續佔住新啟用期的格子。刪掉**還沒送出**的
      // 報告認領：已經送出的（telegram_sent_at 有值）是歷史證據，留著。
      await client.execute({
        sql: `DELETE FROM report_claims
               WHERE user_id = ? AND telegram_sent_at IS NULL`,
        args: [uid],
      });
      // 分析認領同理：釋放租約，讓新啟用期可以重新認領。
      await client.execute({
        sql: `UPDATE analytics_work_state
                 SET owner = NULL, lease_expires_at = NULL, claimed_lifecycle = NULL
               WHERE user_id = ?`,
        args: [uid],
      }).catch(() => { /* 舊資料庫可能還沒有這張表 */ });

      log.info('user_lifecycle_transition', {
        user_id: uid, from: oldStatus, to: targetStatus,
        from_generation: oldGeneration, to_generation: oldGeneration + 1,
      });
      return {
        changed: true,
        oldStatus, newStatus: targetStatus,
        oldGeneration, newGeneration: oldGeneration + 1,
      };
    }));
  }

  /**
   * 一般欄位更新。**不接受 status** —— 改狀態一律走
   * transitionUserLifecycle，否則會產生一個不推進世代的後門，
   * 而 ABA 防護就是靠世代成立的。
   */
  async function updateUser(userId, patch = {}, { now = new Date() } = {}) {
    const uid = requireUserId(userId, 'updateUser');
    if (patch.status !== undefined) {
      throw new Error('updateUser 不可以改 status：請用 transitionUserLifecycle（它會推進 lifecycle_generation）');
    }
    const allowed = { displayName: 'display_name', timezone: 'timezone' };
    const sets = [];
    const args = [];
    for (const [k, col] of Object.entries(allowed)) {
      if (patch[k] !== undefined) {
        sets.push(`${col} = ?`);
        args.push(patch[k]);
      }
    }
    if (!sets.length) return getUser(uid);
    sets.push('updated_at = ?');
    args.push(iso(now), uid);
    await client.execute({ sql: `UPDATE users SET ${sets.join(', ')} WHERE id = ?`, args });
    return getUser(uid);
  }

  // ----- Telegram 綁定 ---------------------------------------------------
  /**
   * 把一個 Telegram chat 綁到某個內部使用者。
   * 如果該 chat 已經 ACTIVE 綁在**別人**身上，拒絕（避免把別人的 chat 搶走）。
   */
  async function linkTelegram({ chatId, userId, now = new Date(), force = false }) {
    const uid = requireUserId(userId, 'linkTelegram');
    const cid = String(chatId);

    // ★ R2-H-01 綁定邊界：不安全的目的地**根本不可能**被寫進資料庫。
    //
    // polling.js 的入站閘門已經擋住群組訊息，但那是一層；這裡是儲存層。
    // 綁定是「之後所有私人生理資料要送去哪裡」的唯一來源，所以它自己
    // 必須成立，不可以靠「呼叫端剛好檢查過了」—— admin CLI、測試、
    // 未來任何新的呼叫端都會經過這裡。
    if (!isSafePrivateChatId(cid)) {
      const err = new Error(
        '只能綁定 Telegram 私訊（群組／頻道不可接收私人生理資料）',
      );
      err.code = 'UNSAFE_CHAT_DESTINATION';
      log.warn('telegram_link_rejected_unsafe', {
        user_id: uid, reason: unsafeChatReason(cid),
      });
      throw err;
    }

    const existing = await getTelegramLink(cid);
    if (existing && existing.status === LINK_STATUS.ACTIVE && existing.userId !== uid && !force) {
      const err = new Error('這個 Telegram chat 已經綁在另一個使用者身上');
      err.code = 'CHAT_ALREADY_LINKED';
      throw err;
    }
    const ts = iso(now);
    await client.execute({
      sql: `INSERT INTO user_telegram (telegram_chat_id, user_id, linked_at, status)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(telegram_chat_id) DO UPDATE SET
              user_id = excluded.user_id, linked_at = excluded.linked_at,
              status = excluded.status`,
      args: [cid, uid, ts, LINK_STATUS.ACTIVE],
    });
    log.info('telegram_linked', { user_id: uid });
    return { chatId: cid, userId: uid, linkedAt: ts, status: LINK_STATUS.ACTIVE };
  }

  /**
   * **原子**認領一個 Telegram 私訊（自助上線用，V1.2 Phase 3.5）。
   *
   * 與 linkTelegram 的差別是併發語義：linkTelegram 先查再寫（應用層判斷），
   * 兩個並發呼叫可以一起通過那個判斷然後互相覆蓋。這一支只有一條語句 ——
   * 主鍵衝突時 **DO NOTHING**，然後讀回「現在的主人是誰」。
   * 所以 20 個並發認領同一個 chat，恰好一個成功，其餘都拿到贏家的 id。
   *
   * 絕不搶走別人的綁定，也絕不復活被退役的綁定（那要管理者處理）。
   *
   * @returns {{ok:boolean, userId:?string, reason?:string}}
   *   ok = 這一次真的由我建立；userId = 目前的主人（不論是不是我）。
   */
  async function claimTelegramChat({ chatId, userId, now = new Date() }) {
    const uid = requireUserId(userId, 'claimTelegramChat');
    const cid = String(chatId);
    // 綁定邊界與 linkTelegram 相同：群組／頻道永遠不可能成為目的地。
    if (!isSafePrivateChatId(cid)) {
      log.warn('telegram_claim_rejected_unsafe', { user_id: uid, reason: unsafeChatReason(cid) });
      return { ok: false, userId: null, reason: 'unsafe_chat' };
    }
    const ts = iso(now);
    const rs = await client.execute({
      sql: `INSERT INTO user_telegram (telegram_chat_id, user_id, linked_at, status)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(telegram_chat_id) DO NOTHING`,
      args: [cid, uid, ts, LINK_STATUS.ACTIVE],
    });
    if (Number(rs.rowsAffected ?? 0) > 0) {
      log.info('telegram_linked', { user_id: uid });
      return { ok: true, userId: uid };
    }
    const existing = await getTelegramLink(cid);
    if (!existing) return { ok: false, userId: null, reason: 'unknown' };
    if (existing.status !== LINK_STATUS.ACTIVE) {
      return { ok: false, userId: null, reason: `link_${String(existing.status).toLowerCase()}` };
    }
    return { ok: false, userId: existing.userId, reason: 'already_claimed' };
  }

  async function getTelegramLink(chatId) {
    const rs = await client.execute({
      sql: 'SELECT * FROM user_telegram WHERE telegram_chat_id = ?',
      args: [String(chatId)],
    });
    const row = rs.rows[0];
    if (!row) return null;
    return {
      chatId: String(row.telegram_chat_id),
      userId: String(row.user_id),
      linkedAt: row.linked_at,
      status: row.status,
    };
  }

  /**
   * Telegram chat id → 內部使用者。
   * **只有 ACTIVE 綁定 + ACTIVE 使用者**才算通過。其他一律回 null，
   * 呼叫端不得從回傳值推斷「這個 chat 是不是存在別人的帳號」。
   */
  async function resolveUserByChatId(chatId) {
    const link = await getTelegramLink(chatId);
    if (!link || link.status !== LINK_STATUS.ACTIVE) return null;
    const user = await getUser(link.userId);
    if (!user || user.status !== USER_STATUS.ACTIVE) return null;
    // R2-H-01 縱深防禦：入站也不信任儲存的列。polling.js 已經擋住群組
    // 訊息，但這一層不該依賴呼叫端有沒有檢查。
    if (!isSafePrivateChatId(link.chatId)) {
      log.warn('telegram_resolve_rejected_unsafe', {
        user_id: link.userId, reason: unsafeChatReason(link.chatId),
      });
      return null;
    }
    return { user, link };
  }

  /**
   * 某個使用者目前可以**安全接收私人生理資料**的 Telegram chat。
   *
   * ## R2-H-01 遞送邊界
   *
   * 這支函式是 daily / weekly / 主動訊息 / Guardian **唯一**的目的地來源。
   * 舊版只問「有沒有一筆 ACTIVE 的綁定」，於是資料庫裡歷史遺留的群組綁定
   * （舊版 `/link` 在群組裡送出就會成功）會被原封不動交出去 —— 私人生理
   * 資料就這樣送進群組。實測確認。
   *
   * **絕不假設 migration 清理過歷史資料。** 所以每一次讀取都重新驗證，
   * 而不是相信寫入時檢查過。
   *
   * 遇到不安全的列時就地退役（status → RETIRED_UNSAFE）：
   *   - 只改狀態，**任何健康資料都不會被碰到**
   *   - 冪等，而且下一輪就不會再被選到（不會每次都重新發現一次）
   *   - 運維在 `user:list` / log 裡看得到發生過什麼事
   *   - 對方重新在**私訊**裡 /link 就能恢復
   *
   * 退役之後繼續往下找同一個使用者其他的 ACTIVE 綁定 —— 一筆壞資料不該
   * 讓一個其實有正常私訊綁定的使用者收不到報告。
   */
  async function getActiveChatIdForUser(userId, { expectedLifecycleGeneration = null } = {}) {
    const uid = requireUserId(userId, 'getActiveChatIdForUser');
    // ★ v17：**送出時**的帳號授權閘門（§27）。
    //
    // 這支函式是 daily / weekly / 主動訊息 / Guardian / 上線通知 / Q&A 回覆
    // 唯一的目的地來源，所以它是唯一一個必須擋住「選的時候還 ACTIVE、送的
    // 時候已經不是」的地方。選取時過濾不夠：分析、LLM、provider 往返都要時間。
    //
    // 帶 expectedLifecycleGeneration 時還要求「仍然是同一段啟用期」——
    // 否則一則在停用**之前**算出來的健康訊息，會在重新啟用之後才送達。
    const rs = await client.execute({
      sql: `SELECT t.telegram_chat_id FROM user_telegram t
             WHERE t.user_id = ? AND t.status = ?
               AND ${lifecycleActiveSql('t.user_id')}
             ORDER BY t.linked_at DESC`,
      args: [uid, LINK_STATUS.ACTIVE,
        Number.isInteger(expectedLifecycleGeneration) ? expectedLifecycleGeneration : null],
    });
    // ⚠️ 先把**所有**不安全的列退役，再挑安全的那一筆。
    //
    // 如果只是「遇到不安全的就跳過」，一個同時有私訊綁定與歷史群組綁定的
    // 使用者會因為 ORDER BY linked_at DESC 先命中私訊而立刻回傳 —— 那筆
    // 群組列就一直留在 ACTIVE。目前不會被選到，但只要私訊綁定被撤銷，
    // 它就重新變成可達的目的地。留一顆休眠的地雷不可接受。
    let safe = null;
    for (const row of rs.rows) {
      const cid = String(row.telegram_chat_id);
      if (isSafePrivateChatId(cid)) {
        if (safe === null) safe = cid;      // 最新的那一筆安全綁定
        continue;
      }
      await retireUnsafeLink(cid, uid);
    }
    return safe;
  }

  /** 把一筆不安全的綁定退役。只改 status，不刪任何資料。 */
  async function retireUnsafeLink(chatId, userId = null) {
    const cid = String(chatId);
    try {
      await client.execute({
        sql: `UPDATE user_telegram SET status = ?
               WHERE telegram_chat_id = ? AND status = ?`,
        args: [LINK_STATUS.RETIRED_UNSAFE, cid, LINK_STATUS.ACTIVE],
      });
      log.warn('telegram_link_retired_unsafe', {
        user_id: userId, reason: unsafeChatReason(cid),
      });
    } catch (err) {
      // 退役失敗完全不影響安全性——上面已經拒絕回傳它了。
      log.warn('telegram_link_retire_failed', { error: String(err?.message ?? err).slice(0, 200) });
    }
  }

  /**
   * 掃出所有不安全的 ACTIVE 綁定並退役（運維用，可重複執行）。
   * 回傳退役了幾筆。
   */
  async function retireUnsafeTelegramLinks() {
    const rs = await client.execute({
      sql: 'SELECT telegram_chat_id, user_id FROM user_telegram WHERE status = ?',
      args: [LINK_STATUS.ACTIVE],
    });
    let n = 0;
    for (const row of rs.rows) {
      const cid = String(row.telegram_chat_id);
      if (isSafePrivateChatId(cid)) continue;
      await retireUnsafeLink(cid, String(row.user_id));
      n += 1;
    }
    return n;
  }

  async function revokeTelegramLink(chatId) {
    const rs = await client.execute({
      sql: 'UPDATE user_telegram SET status = ? WHERE telegram_chat_id = ?',
      args: [LINK_STATUS.REVOKED, String(chatId)],
    });
    return Number(rs.rowsAffected ?? 0) > 0;
  }

  // ----- 一次性綁定碼 -----------------------------------------------------
  /**
   * 產生綁定碼。**原文只在這裡回傳一次**，DB 只留 hash。
   * @returns {{ id: string, code: string, expiresAt: string }}
   */
  async function createLinkCode(userId, { ttlMs = 24 * 3600_000, now = new Date() } = {}) {
    const uid = requireUserId(userId, 'createLinkCode');
    const user = await getUser(uid);
    if (!user) throw new Error(`使用者不存在：${uid}`);
    const code = generateSecret(16);
    const id = randomUUID();
    const expiresAt = iso(new Date((now instanceof Date ? now : new Date(now)).getTime() + ttlMs));
    await client.execute({
      sql: `INSERT INTO user_link_codes (id, user_id, code_hash, created_at, expires_at)
            VALUES (?, ?, ?, ?, ?)`,
      args: [id, uid, hashSecret(code), iso(now), expiresAt],
    });
    // 只 log id 與到期時間，絕不 log code
    log.info('link_code_created', { user_id: uid, link_code_id: id, expires_at: expiresAt });
    return { id, code, expiresAt };
  }

  /**
   * 兌換綁定碼並把 chat 綁上去。原子性來自那句條件式 UPDATE。
   * @returns {{ ok: true, userId } | { ok: false, reason: 'invalid'|'expired'|'used' }}
   */
  async function redeemLinkCode(rawCode, { chatId, now = new Date() }) {
    const hash = hashSecret(rawCode ?? '');
    const nowIso = iso(now);

    // 一次性閘門：只有 未使用 且 未過期 的那一列會被更新
    const upd = await client.execute({
      sql: `UPDATE user_link_codes SET used_at = ?, used_by = ?
             WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?`,
      args: [nowIso, String(chatId), hash, nowIso],
    });

    if (Number(upd.rowsAffected ?? 0) === 0) {
      // 分辨失敗原因（僅供 log / 回覆措辭，不洩漏任何他人資訊）
      const rs = await client.execute({
        sql: 'SELECT used_at, expires_at FROM user_link_codes WHERE code_hash = ?',
        args: [hash],
      });
      const row = rs.rows[0];
      const reason = !row ? 'invalid' : (row.used_at ? 'used' : 'expired');
      log.warn('link_code_rejected', { reason });
      return { ok: false, reason };
    }

    const rs = await client.execute({
      sql: 'SELECT user_id FROM user_link_codes WHERE code_hash = ?',
      args: [hash],
    });
    const userId = String(rs.rows[0].user_id);
    await linkTelegram({ chatId, userId, now, force: true });
    log.info('link_code_redeemed', { user_id: userId });
    return { ok: true, userId };
  }

  // ----- OAuth state -----------------------------------------------------
  /**
   * 產生 OAuth state 並綁到某個內部使用者。
   * **原文只回傳一次**（要放進 authorize URL），DB 只留 hash。
   */
  /**
   * 產生一組 OAuth state。
   *
   * @param {?number} opts.maxOutstanding 同時最多幾條**還有效**（未消耗、未過期）
   *   的 state。給了就用**一句條件式 INSERT** 擋 —— 條件與寫入在同一個語句裡，
   *   所以並發的多個請求不可能一起穿過去（V1.2 Phase 3.5 RC1 / F03）。
   *
   *   這種「有界的未完成數量」本身就會自己恢復：舊的 state 一旦過期或被用掉
   *   就不再計入，不需要任何重置動作，也不可能把人永久鎖死。
   *
   * @returns {{ok:true, state, expiresAt} | {ok:false, reason:'too_many'}}
   */
  async function createOAuthState(userId, {
    ttlMs = 10 * 60_000, now = new Date(), maxOutstanding = null,
  } = {}) {
    const uid = requireUserId(userId, 'createOAuthState');
    const user = await getUser(uid);
    if (!user) throw new Error(`使用者不存在：${uid}`);
    // ★ v17：state 屬於**發出它的那一段啟用期**。把世代寫進列裡，
    // callback 才有辦法分辨「ACTIVE→停用→再啟用之後回來的舊 state」——
    // 那時候 status 又是 ACTIVE，光看狀態完全分不出來。
    const lifecycle = user.lifecycleGeneration;
    // 32 bytes（256 bits）—— 比 WHOOP 要求的最低長度高出很多
    const state = generateSecret(32);
    const nowIso = iso(now);
    const expiresAt = iso(new Date((now instanceof Date ? now : new Date(now)).getTime() + ttlMs));
    if (Number.isFinite(maxOutstanding)) {
      const rs = await client.execute({
        // 配額與**啟用資格**在同一句裡求值：一個在核發過程中被停用的帳號
        // 不會拿到 state，也不會消耗任何額度（F03 的配額語義不變）。
        sql: `INSERT INTO oauth_states
                (state_hash, user_id, lifecycle_generation, created_at, expires_at)
              SELECT ?, ?, ?, ?, ?
               WHERE (SELECT COUNT(*) FROM oauth_states
                       WHERE user_id = ? AND consumed_at IS NULL AND expires_at > ?) < ?
                 AND EXISTS (SELECT 1 FROM users lu
                              WHERE lu.id = ? AND lu.status = 'ACTIVE'
                                AND lu.lifecycle_generation = ?)`,
        args: [
          hashSecret(state), uid, lifecycle, nowIso, expiresAt,
          uid, nowIso, Number(maxOutstanding), uid, lifecycle,
        ],
      });
      if (Number(rs.rowsAffected ?? 0) === 0) {
        // 兩個原因：額度滿了，或帳號在核發途中變得不合資格。分開回報，
        // 因為前者會自己恢復，後者要管理者處理。
        const still = await getUser(uid);
        if (!still || still.status !== USER_STATUS.ACTIVE || still.lifecycleGeneration !== lifecycle) {
          log.warn('oauth_state_lifecycle_rejected', { user_id: uid });
          return { ok: false, reason: 'account_inactive' };
        }
        log.warn('oauth_state_quota_exceeded', { user_id: uid });
        return { ok: false, reason: 'too_many' };
      }
      log.info('oauth_state_created', { user_id: uid, expires_at: expiresAt });
      return { ok: true, state, expiresAt };
    }
    const rs2 = await client.execute({
      sql: `INSERT INTO oauth_states
              (state_hash, user_id, lifecycle_generation, created_at, expires_at)
            SELECT ?, ?, ?, ?, ?
             WHERE EXISTS (SELECT 1 FROM users lu
                            WHERE lu.id = ? AND lu.status = 'ACTIVE'
                              AND lu.lifecycle_generation = ?)`,
      args: [hashSecret(state), uid, lifecycle, nowIso, expiresAt, uid, lifecycle],
    });
    if (Number(rs2.rowsAffected ?? 0) === 0) {
      log.warn('oauth_state_lifecycle_rejected', { user_id: uid });
      return { ok: false, reason: 'account_inactive' };
    }
    log.info('oauth_state_created', { user_id: uid, expires_at: expiresAt });
    return { ok: true, state, expiresAt, lifecycleGeneration: lifecycle };
  }

  /**
   * 消耗 OAuth state。一次性 + 有期限，所以 replay 與跨使用者綁定都不可能。
   * @returns {{ ok: true, userId } | { ok: false, reason: 'invalid'|'expired'|'consumed' }}
   */
  async function consumeOAuthState(rawState, { now = new Date() } = {}) {
    const hash = hashSecret(rawState ?? '');
    const nowIso = iso(now);
    const upd = await client.execute({
      sql: `UPDATE oauth_states SET consumed_at = ?
             WHERE state_hash = ? AND consumed_at IS NULL AND expires_at > ?`,
      args: [nowIso, hash, nowIso],
    });
    if (Number(upd.rowsAffected ?? 0) === 0) {
      const rs = await client.execute({
        sql: 'SELECT consumed_at, expires_at FROM oauth_states WHERE state_hash = ?',
        args: [hash],
      });
      const row = rs.rows[0];
      const reason = !row ? 'invalid' : (row.consumed_at ? 'consumed' : 'expired');
      log.warn('oauth_state_rejected', { reason });
      return { ok: false, reason };
    }
    const rs = await client.execute({
      sql: 'SELECT user_id, lifecycle_generation FROM oauth_states WHERE state_hash = ?',
      args: [hash],
    });
    const row = rs.rows[0];
    const userId = String(row.user_id);
    // v17 之前發出的 state 沒有世代出處。回 null，呼叫端 fail closed ——
    // 「不知道它屬於哪一段啟用期」的正確處置是拒絕，不是猜一個。
    const lifecycleGeneration = row.lifecycle_generation === null
      || row.lifecycle_generation === undefined ? null : Number(row.lifecycle_generation);
    log.info('oauth_state_consumed', { user_id: userId });
    return { ok: true, userId, lifecycleGeneration };
  }

  /**
   * 只看、不消耗：這條 state 現在還有效嗎、綁的是誰。
   *
   * 給自助上線的 callback 用 —— 使用者在 WHOOP 那邊按了「拒絕」時，我們想把
   * 他的上線狀態標成「需要處理」，但**不該**把他手上那條還沒用過的連結作廢
   * （他可能只是按錯）。所以這是一個嚴格唯讀的查詢。
   *
   * 與 consume 一樣只比對 hash，原文永遠不進 DB、不進 log。
   */
  async function peekOAuthState(rawState, { now = new Date() } = {}) {
    const hash = hashSecret(rawState ?? '');
    const rs = await client.execute({
      sql: `SELECT user_id, consumed_at, expires_at, lifecycle_generation
              FROM oauth_states WHERE state_hash = ?`,
      args: [hash],
    });
    const row = rs.rows[0];
    if (!row) return { ok: false, reason: 'invalid', userId: null };
    if (row.consumed_at) return { ok: false, reason: 'consumed', userId: String(row.user_id) };
    if (String(row.expires_at) <= iso(now)) return { ok: false, reason: 'expired', userId: String(row.user_id) };
    return {
      ok: true, userId: String(row.user_id), expiresAt: row.expires_at,
      lifecycleGeneration: row.lifecycle_generation === null || row.lifecycle_generation === undefined
        ? null : Number(row.lifecycle_generation),
    };
  }

  return {
    createUser,
    getUser,
    transitionUserLifecycle,
    listUsers,
    listActiveUsers,
    updateUser,
    linkTelegram,
    claimTelegramChat,
    getTelegramLink,
    resolveUserByChatId,
    getActiveChatIdForUser,
    retireUnsafeTelegramLinks,
    revokeTelegramLink,
    createLinkCode,
    redeemLinkCode,
    createOAuthState,
    consumeOAuthState,
    peekOAuthState,
  };
}
