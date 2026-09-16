/**
 * 自助上線生命週期的耐久儲存層（V1.2 Phase 3.5）。
 *
 * ## 為什麼狀態一定要在 DB
 *
 * 上線橫跨三個不同的程序邊界：Telegram webhook（可能睡著、可能換一台機器）、
 * WHOOP 的 OAuth callback（完全不同的請求）、排程器（幾分鐘後才醒）。
 * 任何存在記憶體裡的對話狀態都會在這三者之間掉光。所以「走到哪一步」
 * 只有一個權威：`user_onboarding` 這一列。
 *
 * ## 沒有列 = 舊使用者 = READY
 *
 * Phase 3.5 之前的使用者是管理員用 CLI 建的，上線在當時就是人工完成的事。
 * 查不到列一律視為 READY（`LEGACY_ONBOARDING`），所以既有的正式使用者
 * 不會因為這個新表而變成「還沒上線」。v13 → v14 的資料遷移另外把當下
 * 存在的使用者明確補成 READY，讓狀態在 DB 裡看得見。
 *
 * ## 這裡不存祕密
 *
 * 沒有 token、沒有 OAuth state 原文、沒有授權碼。只有「第幾步、何時、
 * 為什麼卡住」。
 */

import { ONBOARDING_STATE } from './schema.js';
import { requireUserId } from './userContext.js';
import { log } from './logger.js';

const iso = (v) => (v instanceof Date ? v.toISOString() : new Date(v).toISOString());
const STATES = new Set(Object.values(ONBOARDING_STATE));

/** 查不到列時代表的東西：Phase 3.5 之前就存在的使用者。 */
export const LEGACY_ONBOARDING = Object.freeze({
  state: ONBOARDING_STATE.READY,
  legacy: true,
  failureCode: null,
  failureDetail: null,
});

/** 這個上線狀態可以被排程器當成正式使用者嗎。 */
export const isOnboardingReady = (o) => (o?.state ?? ONBOARDING_STATE.READY) === ONBOARDING_STATE.READY;

export function createOnboardingStore(client) {
  const rowTo = (r) => (r ? {
    userId: String(r.user_id),
    state: String(r.state),
    legacy: false,
    timezoneConfirmedAt: r.timezone_confirmed_at ?? null,
    whoopAuthorizedAt: r.whoop_authorized_at ?? null,
    syncStartedAt: r.sync_started_at ?? null,
    readyAt: r.ready_at ?? null,
    stateChangedAt: r.state_changed_at,
    failureCode: r.failure_code ?? null,
    failureDetail: r.failure_detail ?? null,
    authLinkCount: Number(r.auth_link_count ?? 0),
    lastAuthLinkAt: r.last_auth_link_at ?? null,
    bootstrapAttempts: Number(r.bootstrap_attempts ?? 0),
    lastBootstrapAt: r.last_bootstrap_at ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  } : null);

  /** 原始的列（沒有列就是 null，不做 legacy 代換）。 */
  async function getOnboardingRow(userId) {
    const uid = requireUserId(userId, 'getOnboardingRow');
    const rs = await client.execute({ sql: 'SELECT * FROM user_onboarding WHERE user_id = ?', args: [uid] });
    return rowTo(rs.rows[0]);
  }

  /** 有列就回列；沒有列代表舊使用者 → READY（見檔頭）。 */
  async function getOnboarding(userId) {
    const row = await getOnboardingRow(userId);
    return row ?? { userId: String(userId), ...LEGACY_ONBOARDING };
  }

  /**
   * 建立這個使用者的上線列（如果還沒有）。**冪等**：已經有列就原封不動回傳，
   * 絕不把一個已經 READY 的人打回 STARTED。
   *
   * 呼叫端（自助 /start）會把它放在與「建立使用者 + 綁定 Telegram」同一個
   * 交易裡，所以不存在「使用者建好了但沒有上線狀態」的中間態。
   */
  async function ensureOnboarding(userId, { state = ONBOARDING_STATE.STARTED, now = new Date() } = {}) {
    const uid = requireUserId(userId, 'ensureOnboarding');
    if (!STATES.has(state)) throw new Error(`invalid_onboarding_state:${state}`);
    const ts = iso(now);
    await client.execute({
      sql: `INSERT INTO user_onboarding
              (user_id, state, state_changed_at, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(user_id) DO NOTHING`,
      args: [uid, state, ts, ts, ts],
    });
    return getOnboardingRow(uid);
  }

  /**
   * 狀態轉移。
   *
   * @param {string[]} [opts.from] 只有目前狀態在這個清單裡才轉（樂觀鎖）。
   *   用來擋「兩個 callback 同時進來」「晚到的 bootstrap 把 READY 打回 SYNCING」。
   * @returns {?object} 轉移後的列；條件不成立回 null（呼叫端自己決定要不要在意）。
   */
  async function setOnboardingState(userId, state, {
    from = null, failureCode = null, failureDetail = null,
    timezoneConfirmed = false, whoopAuthorized = false, syncStarted = false, ready = false,
    now = new Date(),
  } = {}) {
    const uid = requireUserId(userId, 'setOnboardingState');
    if (!STATES.has(state)) throw new Error(`invalid_onboarding_state:${state}`);
    const ts = iso(now);
    const guard = Array.isArray(from) && from.length
      ? ` AND state IN (${from.map(() => '?').join(',')})` : '';
    const rs = await client.execute({
      sql: `UPDATE user_onboarding
               SET state = ?, state_changed_at = ?,
                   failure_code = ?, failure_detail = ?,
                   timezone_confirmed_at = CASE WHEN ? = 1 THEN ? ELSE timezone_confirmed_at END,
                   whoop_authorized_at   = CASE WHEN ? = 1 THEN ? ELSE whoop_authorized_at END,
                   sync_started_at       = CASE WHEN ? = 1 THEN ? ELSE sync_started_at END,
                   ready_at              = CASE WHEN ? = 1 THEN ? ELSE ready_at END,
                   updated_at = ?
             WHERE user_id = ?${guard}`,
      args: [state, ts, failureCode, failureDetail ? String(failureDetail).slice(0, 300) : null,
        timezoneConfirmed ? 1 : 0, ts,
        whoopAuthorized ? 1 : 0, ts,
        syncStarted ? 1 : 0, ts,
        ready ? 1 : 0, ts,
        ts, uid, ...(Array.isArray(from) ? from : [])],
    });
    if (Number(rs.rowsAffected ?? 0) === 0) return null;
    log.info('onboarding_state', { user_id: uid, state, failure_code: failureCode });
    return getOnboardingRow(uid);
  }

  /**
   * 記一次「產生授權連結」。回傳是否允許（濫用控制）。
   *
   * 兩個限制：冷卻（太快連按）與這一輪上線的總量。兩者都在 DB 裡，
   * 所以重啟、換機器都算數。
   */
  async function recordAuthLinkIssued(userId, { cooldownMs, maxLinks, now = new Date() }) {
    const uid = requireUserId(userId, 'recordAuthLinkIssued');
    const row = await getOnboardingRow(uid);
    if (!row) return { ok: false, reason: 'no_onboarding' };
    const t = new Date(now).getTime();
    if (row.lastAuthLinkAt && t - Date.parse(row.lastAuthLinkAt) < cooldownMs) {
      return { ok: false, reason: 'cooldown', retryAfterMs: cooldownMs - (t - Date.parse(row.lastAuthLinkAt)) };
    }
    if (Number.isFinite(maxLinks) && row.authLinkCount >= maxLinks) {
      return { ok: false, reason: 'too_many' };
    }
    const ts = iso(now);
    await client.execute({
      sql: `UPDATE user_onboarding
               SET auth_link_count = auth_link_count + 1, last_auth_link_at = ?, updated_at = ?
             WHERE user_id = ?`,
      args: [ts, ts, uid],
    });
    return { ok: true, count: row.authLinkCount + 1 };
  }

  /** 授權成功之後把連結配額歸零：重新連線的人不會被上一輪的嘗試次數卡住。 */
  async function resetAuthLinkBudget(userId, { now = new Date() } = {}) {
    const uid = requireUserId(userId, 'resetAuthLinkBudget');
    const ts = iso(now);
    await client.execute({
      sql: 'UPDATE user_onboarding SET auth_link_count = 0, updated_at = ? WHERE user_id = ?',
      args: [ts, uid],
    });
  }

  async function recordBootstrapAttempt(userId, { now = new Date() } = {}) {
    const uid = requireUserId(userId, 'recordBootstrapAttempt');
    const ts = iso(now);
    await client.execute({
      sql: `UPDATE user_onboarding
               SET bootstrap_attempts = bootstrap_attempts + 1, last_bootstrap_at = ?, updated_at = ?
             WHERE user_id = ?`,
      args: [ts, ts, uid],
    });
  }

  /** 還沒走完的上線（排程器用來接手 bootstrap）。有上限。 */
  async function listOnboardingInState(states, { limit = 20 } = {}) {
    const list = Array.isArray(states) ? states : [states];
    if (!list.length) return [];
    const rs = await client.execute({
      sql: `SELECT * FROM user_onboarding WHERE state IN (${list.map(() => '?').join(',')})
             ORDER BY state_changed_at LIMIT ?`,
      args: [...list, Number(limit)],
    });
    return rs.rows.map(rowTo);
  }

  /**
   * 排程器的使用者清單：ACTIVE 而且上線走完（或舊使用者沒有列）。
   *
   * 用 LEFT JOIN 而不是先取全部再過濾：一個還在選時區的人根本不該出現在
   * 日報流程裡，而不是「出現了但後面被跳過」。
   */
  async function listSchedulableUsers({ activeStatus }) {
    const rs = await client.execute({
      sql: `SELECT u.* FROM users u
              LEFT JOIN user_onboarding o ON o.user_id = u.id
             WHERE u.status = ?
               AND (o.state IS NULL OR o.state = ?)
             ORDER BY u.created_at`,
      args: [activeStatus, ONBOARDING_STATE.READY],
    });
    return rs.rows.map((r) => ({
      id: String(r.id),
      displayName: String(r.display_name),
      timezone: String(r.timezone),
      status: String(r.status),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  return {
    getOnboarding,
    getOnboardingRow,
    ensureOnboarding,
    setOnboardingState,
    recordAuthLinkIssued,
    resetAuthLinkBudget,
    recordBootstrapAttempt,
    listOnboardingInState,
    listSchedulableUsers,
  };
}
