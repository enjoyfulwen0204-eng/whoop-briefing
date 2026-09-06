/**
 * Turso (libSQL) 持久化層。
 *
 * 執行環境（Render Cron Job）的檔案系統是 ephemeral，所以「所有跨執行狀態」
 * 都存在 Turso，絕不使用本機 JSON / 檔案。
 *
 * 存三種東西：
 *   1. whoop_tokens        —— access_token / expires_at / refresh_token
 *   2. report_runs         —— 每日 / 每週報告的發送紀錄（去重 + 稽核）
 *   3. error_notifications —— 錯誤通知冷卻（同 error_type 2 小時最多一次）
 */

import { createClient } from '@libsql/client';
import { randomUUID } from 'node:crypto';
import { SCHEMA } from './schema.js';
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

  async function migrate() {
    for (const stmt of SCHEMA) await client.execute(stmt);
    // health_date：稽核用的明確欄位。去重 key 仍然是 local_date（唯一索引綁在它上面），
    // daily 會把 health_date 一併寫進來，舊資料留 NULL。
    await ensureColumn('report_runs', 'health_date', 'TEXT');
  }

  // ----- tokens -----------------------------------------------------------
  async function getTokens() {
    const rs = await client.execute('SELECT * FROM whoop_tokens WHERE id = 1');
    const row = rs.rows[0];
    if (!row) return null;
    return {
      accessToken: row.access_token,
      refreshToken: row.refresh_token,
      expiresAt: new Date(row.access_token_expires_at),
      scope: row.scope,
      updatedAt: row.updated_at,
    };
  }

  /**
   * 寫回 token。refresh 成功後「第一件事」就是呼叫這個，寫成功前不做任何
   * WHOOP 資料處理。DB 寫入失敗會 retry。
   */
  async function saveTokens({ accessToken, refreshToken, expiresAt, scope }, { retries = 4 } = {}) {
    const sql = `INSERT INTO whoop_tokens
        (id, access_token, refresh_token, access_token_expires_at, scope, updated_at)
      VALUES (1, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        access_token = excluded.access_token,
        refresh_token = excluded.refresh_token,
        access_token_expires_at = excluded.access_token_expires_at,
        scope = excluded.scope,
        updated_at = excluded.updated_at`;
    const args = [
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
        log.info('tokens_saved', { attempt, expires_at: new Date(expiresAt).toISOString() });
        return;
      } catch (err) {
        lastErr = err;
        log.warn('tokens_save_failed', { attempt, error: String(err?.message ?? err) });
        if (attempt < retries) await sleep(500 * 2 ** (attempt - 1));
      }
    }
    // 這是最危險的失敗：新 refresh_token 沒寫進 DB。往上拋，不要繼續跑。
    throw new Error(`token 寫入 Turso 連續 ${retries} 次失敗，中止本次執行：${lastErr?.message ?? lastErr}`);
  }

  // ----- report dedup -----------------------------------------------------
  /** 該類型報告在該 local_date 是否已經成功送出。 */
  async function isSent(reportType, localDateKey) {
    const rs = await client.execute({
      sql: `SELECT 1 FROM report_runs
             WHERE report_type = ? AND local_date = ? AND status = 'SENT' LIMIT 1`,
      args: [reportType, localDateKey],
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
    reportType, localDateKey, healthDate = null, sleepId = null, cycleId = null,
    telegramMessageId = null, status, detail = null,
  }, { retries = 3, throwOnError = true } = {}) {
    const sql = `INSERT INTO report_runs
           (report_type, local_date, health_date, sleep_id, cycle_id,
            telegram_message_id, status, detail, sent_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    const args = [
      reportType, localDateKey, healthDate, sleepId, cycleId,
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
            report_type: reportType, local_date: localDateKey, status,
          });
          return false;
        }
        lastErr = err;
        log.warn('record_run_retry', {
          report_type: reportType, local_date: localDateKey, status, attempt,
          error: String(err?.message ?? err),
        });
        if (attempt < retries) await sleep(500 * 2 ** (attempt - 1));
      }
    }

    const msg = `發送紀錄寫入 Turso 連續 ${retries} 次失敗：${lastErr?.message ?? lastErr}`;
    if (throwOnError) throw new Error(msg);
    log.error('record_run_failed', {
      report_type: reportType, local_date: localDateKey, status, error: msg,
    });
    return false;
  }

  async function recentRuns(limit = 20) {
    const rs = await client.execute({
      sql: 'SELECT * FROM report_runs ORDER BY id DESC LIMIT ?',
      args: [limit],
    });
    return rs.rows;
  }

  // ----- error notify cooldown -------------------------------------------
  /** 回傳 true 表示「可以通知」，同時記錄這次通知時間。 */
  async function claimErrorNotify(errorType, cooldownHours) {
    const now = Date.now();
    const rs = await client.execute({
      sql: 'SELECT last_notified_at, hits FROM error_notifications WHERE error_type = ?',
      args: [errorType],
    });
    const row = rs.rows[0];
    if (row) {
      const last = new Date(row.last_notified_at).getTime();
      if (Number.isFinite(last) && now - last < cooldownHours * 3600_000) {
        await client.execute({
          sql: 'UPDATE error_notifications SET hits = hits + 1 WHERE error_type = ?',
          args: [errorType],
        });
        return false;
      }
    }
    await client.execute({
      sql: `INSERT INTO error_notifications (error_type, last_notified_at, hits)
            VALUES (?, ?, 1)
            ON CONFLICT(error_type) DO UPDATE SET
              last_notified_at = excluded.last_notified_at, hits = 1`,
      args: [errorType, new Date(now).toISOString()],
    });
    return true;
  }

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
  async function claimReport({ reportType, localDateKey, ttlMs, owner = randomUUID(), now = new Date() }) {
    const nowIso = now.toISOString();
    const expiresIso = new Date(now.getTime() + ttlMs).toISOString();
    const rs = await client.execute({
      sql: `INSERT INTO report_claims
              (report_type, local_date, owner, claimed_at, expires_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(report_type, local_date) DO UPDATE SET
              owner      = excluded.owner,
              claimed_at = excluded.claimed_at,
              expires_at = excluded.expires_at
            WHERE report_claims.telegram_sent_at IS NULL
              AND report_claims.expires_at <= excluded.claimed_at`,
      args: [reportType, localDateKey, owner, nowIso, expiresIso],
    });
    if (Number(rs.rowsAffected ?? 0) > 0) {
      log.info('report_claimed', { report_type: reportType, local_date: localDateKey });
      return { granted: true, owner };
    }
    const existing = await getClaim(reportType, localDateKey);
    const alreadySent = Boolean(existing?.telegramSentAt);
    log.info('report_claim_denied', {
      report_type: reportType, local_date: localDateKey, already_sent: alreadySent,
    });
    return { granted: false, alreadySent, owner: null };
  }

  /**
   * Telegram 送出成功後「第一件事」就是呼叫這個。
   * 刻意是一個極小的 UPDATE：比整筆 report_runs insert 更可能成功，
   * 而且它才是防重發的關鍵證據。
   */
  async function markClaimSent({ reportType, localDateKey, owner, messageId = null, now = new Date() }) {
    const rs = await client.execute({
      sql: `UPDATE report_claims
               SET telegram_sent_at = ?, telegram_message_id = ?
             WHERE report_type = ? AND local_date = ? AND owner = ?
               AND telegram_sent_at IS NULL`,
      args: [now.toISOString(), messageId, reportType, localDateKey, owner],
    });
    return Number(rs.rowsAffected ?? 0) > 0;
  }

  async function getClaim(reportType, localDateKey) {
    const rs = await client.execute({
      sql: 'SELECT * FROM report_claims WHERE report_type = ? AND local_date = ?',
      args: [reportType, localDateKey],
    });
    const row = rs.rows[0];
    if (!row) return null;
    return {
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
  async function releaseClaim({ reportType, localDateKey, owner }) {
    const rs = await client.execute({
      sql: `DELETE FROM report_claims
             WHERE report_type = ? AND local_date = ? AND owner = ?
               AND telegram_sent_at IS NULL`,
      args: [reportType, localDateKey, owner],
    });
    return Number(rs.rowsAffected ?? 0) > 0;
  }

  return {
    raw: client,
    migrate,
    getTokens,
    saveTokens,
    isSent,
    recordRun,
    recentRuns,
    claimErrorNotify,
    acquireLock,
    releaseLock,
    claimReport,
    markClaimSent,
    getClaim,
    releaseClaim,
    ...createHealthStore(client),
    ...createBotStore(client),
    ...createAnalysisStore(client),
    close: () => client.close(),
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
