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
  LINK_STATUS, USER_STATUS, isSafePrivateChatId, unsafeChatReason,
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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createIdentityStore(client) {
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
      sql: `INSERT INTO users (id, display_name, timezone, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: [id, String(displayName).trim(), timezone, status, ts, ts],
    });
    log.info('user_created', { user_id: id, timezone, status });
    return { id, displayName: String(displayName).trim(), timezone, status, createdAt: ts, updatedAt: ts };
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

  async function updateUser(userId, patch = {}, { now = new Date() } = {}) {
    const uid = requireUserId(userId, 'updateUser');
    const allowed = { displayName: 'display_name', timezone: 'timezone', status: 'status' };
    const sets = [];
    const args = [];
    for (const [k, col] of Object.entries(allowed)) {
      if (patch[k] !== undefined) {
        if (k === 'status' && !Object.values(USER_STATUS).includes(patch[k])) {
          throw new Error(`不合法的 status：${patch[k]}`);
        }
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
  async function getActiveChatIdForUser(userId) {
    const uid = requireUserId(userId, 'getActiveChatIdForUser');
    const rs = await client.execute({
      sql: `SELECT telegram_chat_id FROM user_telegram
             WHERE user_id = ? AND status = ? ORDER BY linked_at DESC`,
      args: [uid, LINK_STATUS.ACTIVE],
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
  async function createOAuthState(userId, { ttlMs = 10 * 60_000, now = new Date() } = {}) {
    const uid = requireUserId(userId, 'createOAuthState');
    const user = await getUser(uid);
    if (!user) throw new Error(`使用者不存在：${uid}`);
    // 32 bytes（256 bits）—— 比 WHOOP 要求的最低長度高出很多
    const state = generateSecret(32);
    const expiresAt = iso(new Date((now instanceof Date ? now : new Date(now)).getTime() + ttlMs));
    await client.execute({
      sql: `INSERT INTO oauth_states (state_hash, user_id, created_at, expires_at)
            VALUES (?, ?, ?, ?)`,
      args: [hashSecret(state), uid, iso(now), expiresAt],
    });
    log.info('oauth_state_created', { user_id: uid, expires_at: expiresAt });
    return { state, expiresAt };
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
      sql: 'SELECT user_id FROM oauth_states WHERE state_hash = ?',
      args: [hash],
    });
    const userId = String(rs.rows[0].user_id);
    log.info('oauth_state_consumed', { user_id: userId });
    return { ok: true, userId };
  }

  return {
    createUser,
    getUser,
    listUsers,
    listActiveUsers,
    updateUser,
    linkTelegram,
    getTelegramLink,
    resolveUserByChatId,
    getActiveChatIdForUser,
    retireUnsafeTelegramLinks,
    revokeTelegramLink,
    createLinkCode,
    redeemLinkCode,
    createOAuthState,
    consumeOAuthState,
  };
}
