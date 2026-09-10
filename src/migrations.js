/**
 * 版本化 schema migration。
 *
 * ## 設計原則
 *
 * 這一輪把 single-user schema 換成 multi-user，有些表的**邏輯主鍵形狀改了**
 * （例如 whoop_sleeps 從 PRIMARY KEY(id) 變成 PRIMARY KEY(user_id, id)）。
 * SQLite/libSQL 不能 ALTER 主鍵，CREATE TABLE IF NOT EXISTS 也不會動既有表。
 *
 * 所以流程是：
 *   1. 找出「形狀變了」的表（RESHAPED_TABLES：缺少某個必要欄位就代表是舊形狀）
 *   2. **數該表有幾列**
 *      - 0 列 → DROP 後重建（沒有資料可以遺失）
 *      - 有列 → **中止並拋錯**，要求人工做資料遷移
 *   3. 跑完整 SCHEMA（全部 IF NOT EXISTS）
 *   4. 記錄 schema_version
 *
 * 這樣同時滿足 zero-data-loss（有資料就不動）與 idempotent（版本到了就跳過重建）。
 *
 * 舊的 single-user 表（whoop_tokens / app_state）**不刪**——0 列、無程式引用，
 * 留著比執行不必要的破壞性 DDL 安全。
 */

import {
  ADDITIVE_COLUMNS, LEGACY_TABLES, RESHAPED_TABLES, SCHEMA, SCHEMA_VERSION,
} from './schema.js';
import { log } from './logger.js';

export class UnsafeMigrationError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'UnsafeMigrationError';
    this.details = details;
  }
}

async function tableExists(client, name) {
  const rs = await client.execute({
    sql: "SELECT 1 FROM sqlite_master WHERE type='table' AND name = ? LIMIT 1",
    args: [name],
  });
  return rs.rows.length > 0;
}

async function columnNames(client, table) {
  const rs = await client.execute(`PRAGMA table_info("${table}")`);
  return rs.rows.map((r) => String(r.name));
}

async function rowCount(client, table) {
  const rs = await client.execute(`SELECT COUNT(*) AS n FROM "${table}"`);
  return Number(rs.rows[0].n);
}

async function currentVersion(client) {
  if (!(await tableExists(client, 'schema_version'))) return 0;
  const rs = await client.execute('SELECT MAX(version) AS v FROM schema_version');
  return Number(rs.rows[0]?.v ?? 0);
}

/**
 * 掃出「舊形狀且非空」的表。回傳空陣列代表可以安全重建。
 * 這個函式是唯讀的，可以單獨拿來做 pre-flight 檢查。
 */
export async function inspectReshape(client) {
  const out = { rebuild: [], blocked: [], absent: [] };
  for (const { table, requiredColumn } of RESHAPED_TABLES) {
    if (!(await tableExists(client, table))) { out.absent.push(table); continue; }
    const cols = await columnNames(client, table);
    if (cols.includes(requiredColumn)) continue; // 已經是新形狀
    const n = await rowCount(client, table);
    if (n === 0) out.rebuild.push({ table, rows: 0 });
    else out.blocked.push({ table, rows: n, requiredColumn });
  }
  return out;
}

/**
 * 執行 migration。
 * @param {object} client libsql client
 * @param {{ allowRebuild?: boolean }} opts allowRebuild=false 時只建新表、不重建舊形狀表
 */
export async function runMigrations(client, { allowRebuild = true } = {}) {
  const from = await currentVersion(client);
  const summary = { from, to: SCHEMA_VERSION, rebuilt: [], created: 0, skipped: from >= SCHEMA_VERSION };

  if (from < SCHEMA_VERSION) {
    const insp = await inspectReshape(client);

    if (insp.blocked.length) {
      throw new UnsafeMigrationError(
        '偵測到舊形狀的表裡有資料，拒絕自動重建（避免資料遺失）。'
        + `需要人工遷移：${insp.blocked.map((b) => `${b.table}(${b.rows} 列)`).join('、')}`,
        insp.blocked,
      );
    }

    if (insp.rebuild.length) {
      if (!allowRebuild) {
        throw new UnsafeMigrationError(
          `有 ${insp.rebuild.length} 張舊形狀空表需要重建，但 allowRebuild=false`,
          insp.rebuild,
        );
      }
      for (const { table } of insp.rebuild) {
        // 再確認一次是空的（避免 inspect 與 drop 之間有寫入）
        const n = await rowCount(client, table);
        if (n !== 0) {
          throw new UnsafeMigrationError(`${table} 在重建前突然有 ${n} 列，中止`, { table, rows: n });
        }
        await client.execute(`DROP TABLE "${table}"`);
        summary.rebuilt.push(table);
        log.warn('schema_table_rebuilt', { table, rows: 0, reason: 'multi_user_reshape' });
      }
    }
  }

  for (const stmt of SCHEMA) {
    await client.execute(stmt);
    summary.created += 1;
  }

  // ★ R3-M-05：加欄位式的遷移。
  //
  // CREATE TABLE IF NOT EXISTS 不會動既有的表，而 RESHAPED_TABLES 那條路徑
  // 遇到有資料的表會中止 —— telegram_processed_updates 在正式環境一定有資料。
  // ALTER TABLE ADD COLUMN 是唯一一條「保留資料又能改形狀」的路，而且它在
  // SQLite 只改中繼資料。先檢查欄位在不在，所以可以重複執行。
  summary.columnsAdded = [];
  for (const { table, column, ddl } of ADDITIVE_COLUMNS) {
    if (!(await tableExists(client, table))) continue;
    const cols = await columnNames(client, table);
    if (cols.includes(column)) continue;
    await client.execute(ddl);
    summary.columnsAdded.push(`${table}.${column}`);
    log.info('schema_column_added', { table, column });
  }

  if (from < SCHEMA_VERSION) {
    await client.execute({
      sql: `INSERT INTO schema_version (version, applied_at, note) VALUES (?, ?, ?)
            ON CONFLICT(version) DO NOTHING`,
      args: [SCHEMA_VERSION, new Date().toISOString(), `multi-user (from v${from})`],
    });
    log.info('schema_migrated', { from, to: SCHEMA_VERSION, rebuilt: summary.rebuilt });
  }

  return summary;
}

/** 舊 single-user 表的現況（回報用，不做任何刪除）。 */
export async function legacyTableStatus(client) {
  const out = [];
  for (const t of LEGACY_TABLES) {
    if (!(await tableExists(client, t))) { out.push({ table: t, present: false }); continue; }
    out.push({ table: t, present: true, rows: await rowCount(client, t) });
  }
  return out;
}
