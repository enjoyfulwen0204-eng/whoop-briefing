/**
 * Turso (libSQL) 持久化層。
 *
 * 執行環境（Render Cron Job）的檔案系統是 ephemeral，所以「所有跨執行狀態」
 * 都存在 Turso，絕不使用本機 JSON / 檔案。
 *
 * ## Multi-user
 *
 * 所有「屬於某個人」的操作**第一個參數一律是 userId**，而且用
 * requireUserId() 硬性檢查 —— 缺就拋錯，絕不 fallback 到某個預設使用者。
 * 刻意保持全域的只有：resource_locks（表結構）、telegram_state（bot offset）、
 * 以及 error_notifications 的 'global' scope。
 */

import { createClient } from '@libsql/client';
import { randomUUID } from 'node:crypto';
import { GLOBAL_SCOPE, userScope } from './schema.js';
import { runMigrations } from './migrations.js';
import { requireUserId } from './userContext.js';
import { createIdentityStore } from './identityStore.js';
import { createHealthStore } from './store.js';
import { createBotStore } from './botStore.js';
import { createAnalysisStore } from './analysisStore.js';
import { log } from './logger.js';

// SCHEMA 定義集中在 schema.js（唯一 DDL 來源）。這裡 re-export 維持既有 import 路徑。
export { SCHEMA } from './schema.js';

/**
 * 是不是撞到唯一索引（同一天、同一種報告已經有一筆 SENT）。
 *
 * 刻意只認 UNIQUE，不認整個 SQLITE_CONSTRAINT —— NOT NULL / CHECK 之類的違反
 * 是程式 bug，必須浮出來，不能跟「另一個 run 已送出」混為一談。
 * 實測 Turso 回的是 code='SQLITE_CONSTRAINT'、message 含 'UNIQUE constraint failed'。
 */
export function isDuplicateSentError(err) {
  return /UNIQUE constraint failed/i.test(String(err?.message ?? ''));
}

export function createDb({ url, authToken }) {
  const client = createClient({ url, authToken });

  /**
   * 若欄位不存在就補上（向後相容 migration，不動既有資料）。
   * SQLite 的 ALTER TABLE ADD COLUMN 沒有 IF NOT EXISTS，所以先問 table_info。
   */
  async function ensureColumn(table, column, type) {
    const rs = await client.execute(`PRAGMA table_info(${table})`);
    if (rs.rows.some((r) => r.name === column)) return false;
    await client.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    log.info('schema_column_added', { table, column });
    return true;
  }

  /**
   * 版本化 migration（見 migrations.js）。
   * 舊形狀的表只在「完全沒有資料」時才會被重建，有資料就中止並拋錯。
   */
  async function migrate(opts = {}) {
    return runMigrations(client, opts);
  }

  // ----- tokens（per-user）-----------------------------------------------
  /** 某個使用者的 WHOOP token。沒有就回 null。**絕不會回別人的。** */
  async function getTokens(userId) {
    const uid = requireUserId(userId, 'getTokens');
    const rs = await client.execute({
      sql: 'SELECT * FROM user_whoop_tokens WHERE user_id = ?',
      args: [uid],
    });
    const row = rs.rows[0];
    if (!row) return null;
    return {
      userId: row.user_id,
      whoopUserId: row.whoop_user_id ?? null,
      accessToken: row.access_token,
      refreshToken: row.refresh_token,
      expiresAt: new Date(row.access_token_expires_at),
      scope: row.scope,
      updatedAt: row.updated_at,
    };
  }

  /**
   * 這個 WHOOP 帳號是否已經綁在**別的**內部使用者身上。
   * 用來防止同一支手環被兩個內部帳號同時綁走。
   */
  async function findUserByWhoopUserId(whoopUserId, { excludeUserId = null } = {}) {
    if (whoopUserId === null || whoopUserId === undefined || whoopUserId === '') return null;
    const rs = await client.execute({
      sql: 'SELECT user_id FROM user_whoop_tokens WHERE whoop_user_id = ?',
      args: [String(whoopUserId)],
    });
    const hit = rs.rows.map((r) => String(r.user_id)).find((u) => u !== String(excludeUserId ?? ''));
    return hit ?? null;
  }

  /**
   * 寫回 token。refresh 成功後「第一件事」就是呼叫這個，寫成功前不做任何
   * WHOOP 資料處理。DB 寫入失敗會 retry。
   */
  async function saveTokens(userId, {
    accessToken, refreshToken, expiresAt, scope, whoopUserId = null,
  }, { retries = 4 } = {}) {
    const uid = requireUserId(userId, 'saveTokens');
    const sql = `INSERT INTO user_whoop_tokens
        (user_id, whoop_user_id, access_token, refresh_token,
         access_token_expires_at, scope, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        whoop_user_id = COALESCE(excluded.whoop_user_id, user_whoop_tokens.whoop_user_id),
        access_token = excluded.access_token,
        refresh_token = excluded.refresh_token,
        access_token_expires_at = excluded.access_token_expires_at,
        scope = excluded.scope,
        updated_at = excluded.updated_at`;
    const args = [
      uid,
      whoopUserId === null || whoopUserId === undefined ? null : String(whoopUserId),
      accessToken,
      refreshToken,
      new Date(expiresAt).toISOString(),
      scope ?? null,
      new Date().toISOString(),
    ];

    let lastErr;
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        await client.execute({ sql, args });
        // 絕不 log token 內容，只 log 使用者與到期時間
        log.info('tokens_saved', {
          user_id: uid, attempt, expires_at: new Date(expiresAt).toISOString(),
        });
        return;
      } catch (err) {
        lastErr = err;
        log.warn('tokens_save_failed', { user_id: uid, attempt, error: String(err?.message ?? err) });
        if (attempt < retries) await sleep(500 * 2 ** (attempt - 1));
      }
    }
    // 這是最危險的失敗：新 refresh_token 沒寫進 DB。往上拋，不要繼續跑。
    throw new Error(`token 寫入 Turso 連續 ${retries} 次失敗，中止本次執行：${lastErr?.message ?? lastErr}`);
  }

  // ----- report dedup -----------------------------------------------------
  /** **該使用者**的該類型報告在該 local_date 是否已經成功送出。 */
  async function isSent(userId, reportType, localDateKey) {
    const uid = requireUserId(userId, 'isSent');
    const rs = await client.execute({
      sql: `SELECT 1 FROM report_runs
             WHERE user_id = ? AND report_type = ? AND local_date = ? AND status = 'SENT'
             LIMIT 1`,
      args: [uid, reportType, localDateKey],
    });
    return rs.rows.length > 0;
  }

  /**
   * 寫一筆發送紀錄。
   *
   * 兩種失敗要分清楚，這是刻意的：
   *  - **撞到 uniq_report_sent**（另一個 run 已經送出了）→ 預期中的安全行為，
   *    回 false 就好，不吵。
   *  - **其他 DB 錯誤**（Turso 短暫故障等）→ 危險。沒有 SENT 紀錄，下一輪
   *    `isSent` 會回 false 而重複發送。所以要重試，重試用完就往上拋，
   *    讓呼叫端決定怎麼喊（`throwOnError: false` 可改成只寫 log）。
   */
  async function recordRun({
    userId, reportType, localDateKey, healthDate = null, sleepId = null, cycleId = null,
    telegramMessageId = null, status, detail = null,
  }, { retries = 3, throwOnError = true } = {}) {
    const uid = requireUserId(userId, 'recordRun');
    const sql = `INSERT INTO report_runs
           (user_id, report_type, local_date, health_date, sleep_id, cycle_id,
            telegram_message_id, status, detail, sent_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    const args = [
      uid, reportType, localDateKey, healthDate, sleepId, cycleId,
      telegramMessageId, status, detail ? String(detail).slice(0, 500) : null,
      new Date().toISOString(),
    ];

    let lastErr;
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        await client.execute({ sql, args });
        return true;
      } catch (err) {
        if (isDuplicateSentError(err)) {
          log.warn('record_run_duplicate', {
            user_id: uid, report_type: reportType, local_date: localDateKey, status,
          });
          return false;
        }
        lastErr = err;
        log.warn('record_run_retry', {
          user_id: uid, report_type: reportType, local_date: localDateKey, status, attempt,
          error: String(err?.message ?? err),
        });
        if (attempt < retries) await sleep(500 * 2 ** (attempt - 1));
      }
    }

    const msg = `發送紀錄寫入 Turso 連續 ${retries} 次失敗：${lastErr?.message ?? lastErr}`;
    if (throwOnError) throw new Error(msg);
    log.error('record_run_failed', {
      user_id: uid, report_type: reportType, local_date: localDateKey, status, error: msg,
    });
    return false;
  }

  async function recentRuns(userId, limit = 20) {
    const uid = requireUserId(userId, 'recentRuns');
    const rs = await client.execute({
      sql: 'SELECT * FROM report_runs WHERE user_id = ? ORDER BY id DESC LIMIT ?',
      args: [uid, limit],
    });
    return rs.rows;
  }

  // ----- error notify cooldown（scope 化）--------------------------------
  /**
   * 回傳 true 表示「可以通知」，同時記錄這次通知時間。
   *
   * scope 把「系統層」與「某個使用者」分開：
   *   'global'        → Turso / Telegram 這類基礎設施故障
   *   'user:<userId>' → 某人的 WHOOP token 失效
   *
   * 這樣 Alice 的 token 過期不會壓抑 Bob 的錯誤通知，
   * 基礎設施故障也不會被歸到某個隨機使用者身上。
   */
  async function claimErrorNotify(scope, errorType, cooldownHours) {
    if (!scope) throw new Error('claimErrorNotify 需要 scope（global 或 user:<id>）');
    const now = Date.now();
    const rs = await client.execute({
      sql: `SELECT last_notified_at, hits FROM error_notifications
             WHERE scope = ? AND error_type = ?`,
      args: [scope, errorType],
    });
    const row = rs.rows[0];
    if (row) {
      const last = new Date(row.last_notified_at).getTime();
      if (Number.isFinite(last) && now - last < cooldownHours * 3600_000) {
        await client.execute({
          sql: `UPDATE error_notifications SET hits = hits + 1
                 WHERE scope = ? AND error_type = ?`,
          args: [scope, errorType],
        });
        return false;
      }
    }
    await client.execute({
      sql: `INSERT INTO error_notifications (scope, error_type, last_notified_at, hits)
            VALUES (?, ?, ?, 1)
            ON CONFLICT(scope, error_type) DO UPDATE SET
              last_notified_at = excluded.last_notified_at, hits = 1`,
      args: [scope, errorType, new Date(now).toISOString()],
    });
    return true;
  }

  /** 便利包裝：系統層 / 使用者層。 */
  const claimGlobalErrorNotify = (errorType, hours) =>
    claimErrorNotify(GLOBAL_SCOPE, errorType, hours);
  const claimUserErrorNotify = (userId, errorType, hours) =>
    claimErrorNotify(userScope(requireUserId(userId, 'claimUserErrorNotify')), errorType, hours);

  // ----- 跨 process lease lock (A1) --------------------------------------
  /**
   * 取得一個具名 lease lock。
   *
   * 原子性來自單一 SQL：ON CONFLICT DO UPDATE ... WHERE 只有在既有 lock
   * 已過期時才會改寫，否則整句話不動任何列（rowsAffected = 0）。
   * 因為所有時間戳都是等寬的 ISO8601 UTC，字串比較 == 時間比較。
   *
   * @returns {Promise<?string>} 拿到就回 owner token，沒拿到回 null
   */
  async function acquireLock(name, { ttlMs, owner = randomUUID(), now = new Date() } = {}) {
    const nowIso = now.toISOString();
    const expiresIso = new Date(now.getTime() + ttlMs).toISOString();
    const rs = await client.execute({
      sql: `INSERT INTO resource_locks (name, owner, acquired_at, expires_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(name) DO UPDATE SET
              owner       = excluded.owner,
              acquired_at = excluded.acquired_at,
              expires_at  = excluded.expires_at
            WHERE resource_locks.expires_at <= excluded.acquired_at`,
      args: [name, owner, nowIso, expiresIso],
    });
    const got = Number(rs.rowsAffected ?? 0) > 0;
    log.info(got ? 'lock_acquired' : 'lock_busy', { lock: name, ttl_ms: ttlMs });
    return got ? owner : null;
  }

  /** 只有持有者能釋放（避免釋放掉別人接手的 lock）。 */
  async function releaseLock(name, owner) {
    const rs = await client.execute({
      sql: 'DELETE FROM resource_locks WHERE name = ? AND owner = ?',
      args: [name, owner],
    });
    const released = Number(rs.rowsAffected ?? 0) > 0;
    log.info('lock_released', { lock: name, released });
    return released;
  }

  /**
   * per-user 的鎖名。resource_locks 表結構保持全域，但鎖名必須帶 user，
   * 否則 Alice 的 token refresh 會卡住 Bob。
   */
  const userLockName = (base, userId) => `${base}:${requireUserId(userId, 'userLockName')}`;

  // ----- 報告發送權 (A2) --------------------------------------------------
  /**
   * 取得某份報告的「發送權」。
   *
   * 三種結果：
   *   { granted: true }                   → 你負責發，發完要呼叫 markClaimSent
   *   { granted: false, alreadySent: true}→ 已經有人真的送出去過了，永遠不要再送
   *   { granted: false }                  → 別人正在送（claim 未過期），這輪跳過
   *
   * telegram_sent_at 不為 null 時永遠不給 claim —— 這是「已送出」的耐久證據，
   * 即使後續 report_runs 的 SENT 寫入失敗也不會導致重發。
   */
  async function claimReport({
    userId, reportType, localDateKey, ttlMs, owner = randomUUID(), now = new Date(),
  }) {
    const uid = requireUserId(userId, 'claimReport');
    const nowIso = now.toISOString();
    const expiresIso = new Date(now.getTime() + ttlMs).toISOString();
    const rs = await client.execute({
      sql: `INSERT INTO report_claims
              (user_id, report_type, local_date, owner, claimed_at, expires_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(user_id, report_type, local_date) DO UPDATE SET
              owner      = excluded.owner,
              claimed_at = excluded.claimed_at,
              expires_at = excluded.expires_at
            WHERE report_claims.telegram_sent_at IS NULL
              AND report_claims.expires_at <= excluded.claimed_at`,
      args: [uid, reportType, localDateKey, owner, nowIso, expiresIso],
    });
    if (Number(rs.rowsAffected ?? 0) > 0) {
      log.info('report_claimed', { user_id: uid, report_type: reportType, local_date: localDateKey });
      return { granted: true, owner };
    }
    const existing = await getClaim(uid, reportType, localDateKey);
    const alreadySent = Boolean(existing?.telegramSentAt);
    log.info('report_claim_denied', {
      user_id: uid, report_type: reportType, local_date: localDateKey, already_sent: alreadySent,
    });
    return { granted: false, alreadySent, owner: null };
  }

  /**
   * Telegram 送出成功後「第一件事」就是呼叫這個。
   * 刻意是一個極小的 UPDATE：比整筆 report_runs insert 更可能成功，
   * 而且它才是防重發的關鍵證據。
   */
  async function markClaimSent({
    userId, reportType, localDateKey, owner, messageId = null, now = new Date(),
  }) {
    const uid = requireUserId(userId, 'markClaimSent');
    const rs = await client.execute({
      sql: `UPDATE report_claims
               SET telegram_sent_at = ?, telegram_message_id = ?
             WHERE user_id = ? AND report_type = ? AND local_date = ? AND owner = ?
               AND telegram_sent_at IS NULL`,
      args: [now.toISOString(), messageId, uid, reportType, localDateKey, owner],
    });
    return Number(rs.rowsAffected ?? 0) > 0;
  }

  async function getClaim(userId, reportType, localDateKey) {
    const uid = requireUserId(userId, 'getClaim');
    const rs = await client.execute({
      sql: `SELECT * FROM report_claims
             WHERE user_id = ? AND report_type = ? AND local_date = ?`,
      args: [uid, reportType, localDateKey],
    });
    const row = rs.rows[0];
    if (!row) return null;
    return {
      userId: row.user_id,
      reportType: row.report_type,
      localDate: row.local_date,
      owner: row.owner,
      claimedAt: row.claimed_at,
      expiresAt: row.expires_at,
      telegramSentAt: row.telegram_sent_at ?? null,
      telegramMessageId: row.telegram_message_id ?? null,
    };
  }

  /** 釋放發送權（失敗時呼叫，讓下一輪可以立刻重試，不必等 TTL）。 */
  async function releaseClaim({ userId, reportType, localDateKey, owner }) {
    const uid = requireUserId(userId, 'releaseClaim');
    const rs = await client.execute({
      sql: `DELETE FROM report_claims
             WHERE user_id = ? AND report_type = ? AND local_date = ? AND owner = ?
               AND telegram_sent_at IS NULL`,
      args: [uid, reportType, localDateKey, owner],
    });
    return Number(rs.rowsAffected ?? 0) > 0;
  }

  return {
    raw: client,
    migrate,
    // per-user token
    getTokens,
    saveTokens,
    findUserByWhoopUserId,
    // per-user 報告
    isSent,
    recordRun,
    recentRuns,
    claimReport,
    markClaimSent,
    getClaim,
    releaseClaim,
    // 錯誤通知（scope 化）
    claimErrorNotify,
    claimGlobalErrorNotify,
    claimUserErrorNotify,
    // 全域 lock（鎖名要自己帶 user）
    acquireLock,
    releaseLock,
    userLockName,
    ...createIdentityStore(client),
    ...createHealthStore(client),
    ...createBotStore(client),
    ...createAnalysisStore(client),
    close: () => client.close(),
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
