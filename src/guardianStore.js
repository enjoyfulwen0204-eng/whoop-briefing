/**
 * Guardian 的持久化層（V1.1 Phase 9）。
 *
 * 只有兩件事：心跳的讀寫，以及讀取既有 error_notifications 的累積次數。
 * **沒有任何判斷邏輯** —— 那些全部在 guardian.js 的純函式裡。
 */

import { requireUserId } from './userContext.js';

const nowIso = (d = new Date()) => d.toISOString();

export function createGuardianStore(client) {
  /**
   * 記一次「這個元件剛剛成功運作」。
   *
   * scope 沿用 error_notifications 的語彙：'global' 或 'user:<id>'。
   * 用 ON CONFLICT 覆寫，所以每個 (scope, component) 永遠只有一列，
   * 表不會無限成長。
   */
  async function recordHeartbeat(scope, component, { detail = null, now = new Date() } = {}) {
    if (!scope) throw new Error('recordHeartbeat 需要 scope');
    const ts = nowIso(now);
    await client.execute({
      sql: `INSERT INTO system_heartbeats (scope, component, last_ok_at, last_detail, updated_at)
            VALUES (?,?,?,?,?)
            ON CONFLICT(scope, component) DO UPDATE SET
              last_ok_at = excluded.last_ok_at,
              last_detail = excluded.last_detail,
              updated_at = excluded.updated_at`,
      args: [scope, component, ts, detail === null ? null : String(detail).slice(0, 500), ts],
    });
    return true;
  }

  async function getHeartbeat(scope, component) {
    const rs = await client.execute({
      sql: 'SELECT * FROM system_heartbeats WHERE scope = ? AND component = ?',
      args: [scope, component],
    });
    const row = rs.rows[0];
    if (!row) return null;
    return {
      scope: String(row.scope),
      component: String(row.component),
      lastOkAt: row.last_ok_at,
      lastDetail: row.last_detail ?? null,
      updatedAt: row.updated_at,
    };
  }

  async function listHeartbeats({ component = null } = {}) {
    const rs = component
      ? await client.execute({
        sql: 'SELECT * FROM system_heartbeats WHERE component = ? ORDER BY scope',
        args: [component],
      })
      : await client.execute('SELECT * FROM system_heartbeats ORDER BY component, scope');
    return rs.rows.map((row) => ({
      scope: String(row.scope),
      component: String(row.component),
      lastOkAt: row.last_ok_at,
      lastDetail: row.last_detail ?? null,
      updatedAt: row.updated_at,
    }));
  }

  /**
   * 讀既有的錯誤通知累積次數（Guardian 判斷「連續失敗」的依據）。
   *
   * 刻意**只讀不寫**：這張表的寫入權在 claimErrorNotify 手上，
   * Guardian 不可以偷改別人的冷卻狀態。
   */
  async function getErrorNotification(scope, errorType) {
    const rs = await client.execute({
      sql: 'SELECT * FROM error_notifications WHERE scope = ? AND error_type = ?',
      args: [scope, errorType],
    });
    const row = rs.rows[0];
    if (!row) return null;
    return {
      scope: String(row.scope),
      errorType: String(row.error_type),
      lastNotifiedAt: row.last_notified_at,
      hits: Number(row.hits ?? 0),
    };
  }

  /**
   * 已經送出、但還沒有任何結果的主動事件。
   *
   * 「送出了」= sent_at 不是 NULL（沒送出的事件本來就不會有人回答）。
   * 「沒有結果」= outcome IS NULL。
   */
  async function countStuckProactiveEvents(userId, { olderThanIso }) {
    const uid = requireUserId(userId, 'countStuckProactiveEvents');
    const rs = await client.execute({
      sql: `SELECT COUNT(*) AS n, MIN(sent_at) AS oldest
              FROM proactive_events
             WHERE user_id = ?
               AND sent_at IS NOT NULL
               AND outcome IS NULL
               AND sent_at <= ?`,
      args: [uid, olderThanIso],
    });
    return {
      count: Number(rs.rows[0].n ?? 0),
      oldestSentAt: rs.rows[0].oldest ?? null,
    };
  }

  return {
    recordHeartbeat,
    getHeartbeat,
    listHeartbeats,
    getErrorNotification,
    countStuckProactiveEvents,
  };
}
