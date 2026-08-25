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
import { log } from './logger.js';

export const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS whoop_tokens (
     id                      INTEGER PRIMARY KEY CHECK (id = 1),
     access_token            TEXT NOT NULL,
     refresh_token           TEXT NOT NULL,
     access_token_expires_at TEXT NOT NULL,
     scope                   TEXT,
     updated_at              TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS report_runs (
     id                  INTEGER PRIMARY KEY AUTOINCREMENT,
     report_type         TEXT NOT NULL,
     -- 去重 key。daily 放 health_date（主睡眠結束的當地日期），weekly 放上週一日期
     local_date          TEXT NOT NULL,
     -- 稽核用：daily 會另外明確記一份 health_date（舊資料為 NULL）
     health_date         TEXT,
     sleep_id            TEXT,
     cycle_id            TEXT,
     telegram_message_id INTEGER,
     status              TEXT NOT NULL,
     detail              TEXT,
     sent_at             TEXT NOT NULL
   )`,
  // 同一天、同一種報告只能有一筆 SENT —— 資料庫層級的去重保險
  `CREATE UNIQUE INDEX IF NOT EXISTS uniq_report_sent
     ON report_runs (report_type, local_date) WHERE status = 'SENT'`,
  `CREATE INDEX IF NOT EXISTS idx_report_lookup
     ON report_runs (report_type, local_date)`,
  `CREATE TABLE IF NOT EXISTS error_notifications (
     error_type       TEXT PRIMARY KEY,
     last_notified_at TEXT NOT NULL,
     hits             INTEGER NOT NULL DEFAULT 1
   )`,
];

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

  return {
    raw: client,
    migrate,
    getTokens,
    saveTokens,
    isSent,
    recordRun,
    recentRuns,
    claimErrorNotify,
    close: () => client.close(),
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
