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
 * ## 沒有列時**推導**，不預設 READY（RC1 / F02）
 *
 * 第一版把「查不到列」一律當成 READY。那對 Kelvin 是對的，對任何其他形狀
 * 的列都是捏造 —— 被停用的帳號、沒有 Telegram 綁定的、沒有 WHOOP token 的，
 * 全都會被宣告成「上線完成」。
 *
 * 現在查不到列就依**證據**推導（`ONBOARDING_DERIVED_STATE_SQL`，與 v14/v15
 * 的資料遷移共用同一段 SQL，所以兩條路徑不可能給出不同答案）。
 * 排程器那一條更嚴格：沒有列就不排程（JOIN，不是 LEFT JOIN）。
 *
 * ## 這裡不存祕密
 *
 * 沒有 token、沒有 OAuth state 原文、沒有授權碼。只有「第幾步、何時、
 * 為什麼卡住」。
 */

import {
  ONBOARDING_STATE, ONBOARDING_DERIVED_STATE_SQL, ONBOARDING_DERIVED_TZ_SQL,
  ONBOARDING_DERIVED_FAILURE_SQL, ONBOARDING_IDENTITY_STRICT_SQL,
  RESOURCE_ACCESS_STATUS, USER_STATUS,
} from './schema.js';
import { requireUserId } from './userContext.js';
import { log } from './logger.js';

const iso = (v) => (v instanceof Date ? v.toISOString() : new Date(v).toISOString());
const STATES = new Set(Object.values(ONBOARDING_STATE));

/** 這個上線狀態可以被排程器當成正式使用者嗎。**沒有狀態不算 READY。** */
export const isOnboardingReady = (o) => o?.state === ONBOARDING_STATE.READY;

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

  /**
   * 唯讀地推導一個使用者「應該處於哪個狀態」（不寫入）。
   * 與 ensureOnboardingDerived / 資料遷移共用同一段 SQL。
   */
  async function deriveOnboardingState(userId) {
    const uid = requireUserId(userId, 'deriveOnboardingState');
    const rs = await client.execute({
      sql: `SELECT ${ONBOARDING_DERIVED_STATE_SQL} state,
                   ${ONBOARDING_DERIVED_TZ_SQL} tz,
                   ${ONBOARDING_DERIVED_FAILURE_SQL} failure
              FROM users u WHERE u.id = ?`,
      args: [uid],
    });
    const r = rs.rows[0];
    if (!r) return null;
    return { state: String(r.state), timezoneConfirmedAt: r.tz ?? null, failureCode: r.failure ?? null };
  }

  /**
   * 有列就回列；沒有列就**依證據推導**（不寫入）。
   * 連使用者本身都不存在時回 STARTED —— 絕不回 READY。
   */
  async function getOnboarding(userId) {
    const row = await getOnboardingRow(userId);
    if (row) return row;
    const derived = await deriveOnboardingState(userId);
    return {
      userId: String(userId), legacy: true, failureDetail: null,
      timezoneConfirmedAt: derived?.timezoneConfirmedAt ?? null,
      failureCode: derived?.failureCode ?? null,
      state: derived?.state ?? ONBOARDING_STATE.STARTED,
    };
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
   * 沒有上線列的既有使用者 → 依**證據**推導一列（F02）。
   *
   * 用在兩個地方：遷移之後才被管理員 CLI 建出來的使用者，以及任何
   * 「資料庫裡有這個人但沒有上線狀態」的情況。與 v14/v15 的資料遷移共用
   * 同一段推導 SQL，所以兩條路徑不可能給出不同的答案。
   *
   * **絕不**預設 READY —— 那正是 v14 的錯誤。
   */
  async function ensureOnboardingDerived(userId, { now = new Date() } = {}) {
    const uid = requireUserId(userId, 'ensureOnboardingDerived');
    const ts = iso(now);
    await client.execute({
      sql: `INSERT INTO user_onboarding
              (user_id, state, timezone_confirmed_at, whoop_authorized_at, ready_at,
               failure_code, state_changed_at, created_at, updated_at)
            SELECT u.id,
                   ${ONBOARDING_DERIVED_STATE_SQL},
                   ${ONBOARDING_DERIVED_TZ_SQL},
                   CASE WHEN ${ONBOARDING_DERIVED_STATE_SQL} IN ('WHOOP_AUTHORIZED', 'SYNCING', 'READY')
                        THEN u.created_at ELSE NULL END,
                   CASE WHEN ${ONBOARDING_DERIVED_STATE_SQL} = 'READY' THEN ? ELSE NULL END,
                   ${ONBOARDING_DERIVED_FAILURE_SQL},
                   ?, ?, ?
              FROM users u
             WHERE u.id = ?
            ON CONFLICT(user_id) DO NOTHING`,
      args: [ts, ts, ts, ts, uid],
    });
    return getOnboardingRow(uid);
  }

  /**
   * 一次替**所有**還沒有上線列的使用者推導建立（排程器每一輪呼叫，冪等）。
   *
   * 為什麼需要：遷移只覆蓋「遷移當下存在」的人。之後被管理員 CLI 建出來的
   * 使用者仍然沒有列，而「沒有列」已經不再等於 READY —— 沒有這一步，他們
   * 會永遠不被排程。有了它：設定完整的立刻 READY，不完整的得到真實狀態
   * （而且仍然不會被排程，繞不過狀態機）。
   */
  async function ensureOnboardingDerivedForAll({ now = new Date() } = {}) {
    const ts = iso(now);
    const rs = await client.execute({
      sql: `INSERT INTO user_onboarding
              (user_id, state, timezone_confirmed_at, whoop_authorized_at, ready_at,
               failure_code, state_changed_at, created_at, updated_at)
            SELECT u.id,
                   ${ONBOARDING_DERIVED_STATE_SQL},
                   ${ONBOARDING_DERIVED_TZ_SQL},
                   CASE WHEN ${ONBOARDING_DERIVED_STATE_SQL} IN ('WHOOP_AUTHORIZED', 'SYNCING', 'READY')
                        THEN u.created_at ELSE NULL END,
                   CASE WHEN ${ONBOARDING_DERIVED_STATE_SQL} = 'READY' THEN ? ELSE NULL END,
                   ${ONBOARDING_DERIVED_FAILURE_SQL},
                   ?, ?, ?
              FROM users u
             WHERE NOT EXISTS (SELECT 1 FROM user_onboarding o WHERE o.user_id = u.id)`,
      args: [ts, ts, ts, ts],
    });
    const n = Number(rs.rowsAffected ?? 0);
    if (n) log.info('onboarding_backfilled', { count: n });
    return n;
  }

  // ----- 授權世代與資源權限（RC2 / F04）-----------------------------------

  /** 目前的授權世代（沒有 token 列就是 null）。 */
  async function getAuthGeneration(userId) {
    const uid = requireUserId(userId, 'getAuthGeneration');
    const rs = await client.execute({
      sql: 'SELECT auth_generation FROM user_whoop_tokens WHERE user_id = ?', args: [uid],
    });
    const row = rs.rows[0];
    return row ? Number(row.auth_generation ?? 1) : null;
  }

  /**
   * 記下「這一次授權**拿不拿得到**這個資源」。
   *
   * 只寫得出結論的兩種（ACCESSIBLE / UNAUTHORIZED）。暫時性失敗
   * （429 / 5xx / 逾時）**不呼叫這一支** —— 把它寫成 UNAUTHORIZED 會製造一個
   * 永久的假結論；留著舊世代的判定則會被 READY 的世代條件擋下來，兩者都安全。
   */
  async function recordResourceAccess(userId, entries = [], { authGeneration, now = new Date() }) {
    const uid = requireUserId(userId, 'recordResourceAccess');
    if (!Number.isFinite(authGeneration)) throw new Error('resource_access_requires_generation');
    const ts = iso(now);
    let n = 0;
    for (const e of entries) {
      if (!e?.resource) continue;
      if (!Object.values(RESOURCE_ACCESS_STATUS).includes(e.status)) {
        throw new Error(`invalid_resource_access_status:${e.status}`);
      }
      await client.execute({
        sql: `INSERT INTO whoop_resource_access (user_id, resource, status, auth_generation, checked_at)
              VALUES (?, ?, ?, ?, ?)
              ON CONFLICT(user_id, resource) DO UPDATE SET
                status = excluded.status, auth_generation = excluded.auth_generation,
                checked_at = excluded.checked_at`,
        args: [uid, String(e.resource), e.status, Number(authGeneration), ts],
      });
      n += 1;
    }
    return n;
  }

  async function getResourceAccess(userId) {
    const uid = requireUserId(userId, 'getResourceAccess');
    const rs = await client.execute({
      sql: 'SELECT * FROM whoop_resource_access WHERE user_id = ? ORDER BY resource', args: [uid],
    });
    return rs.rows.map((r) => ({
      resource: String(r.resource), status: String(r.status),
      authGeneration: Number(r.auth_generation), checkedAt: r.checked_at,
    }));
  }

  /**
   * ★ F04：**原子**地轉成 READY。
   *
   * 一句 UPDATE 就把「條件」與「寫入」綁在一起：所有關鍵前提都寫在 WHERE 的
   * EXISTS 子查詢裡，SQLite 對單一語句的求值與寫入是原子的，所以不存在
   * 「讀完前提 → 交易結束 → 稍後盲目寫 READY」那個空隙。
   *
   * 重新驗證的前提（全部必須在**轉移的那一刻**仍然成立）：
   *   · 使用者存在且 ACTIVE
   *   · 時區已**確認**（timezone_confirmed_at 不是 NULL；不是看字串長什麼樣）
   *   · 有 ACTIVE 的 Telegram 綁定
   *   · 有 access token，而且 WHOOP 身分已驗證
   *   · 有同步狀態、有 capability 盤點結果
   *   · 目前狀態仍然是允許的來源狀態（擋掉過期的 bootstrap 覆蓋更新的狀態）
   *
   * @returns {{ok:boolean, reason?:string}} 沒成立時回 ok:false，呼叫端據此
   *   保持待處理／轉 ACTION_REQUIRED，而不是宣告 READY。
   */
  async function setReadyIfEligible({
    userId, from = [ONBOARDING_STATE.WHOOP_AUTHORIZED, ONBOARDING_STATE.SYNCING],
    requiredResources = [], now = new Date(),
  }) {
    const uid = requireUserId(userId, 'setReadyIfEligible');
    const ts = iso(now);
    const states = Array.isArray(from) && from.length ? from : [ONBOARDING_STATE.SYNCING];
    // ★ RC2 / F04：每一個必要資源都必須有「屬於**目前**授權世代」的
    // ACCESSIBLE 判定。條件寫在同一句 UPDATE 裡，所以 JS 那邊算出來的舊結論
    // 完全不參與決定 —— 重新授權（世代 +1）或判定被改成 UNAUTHORIZED，
    // 這次轉移就會失敗。
    const accessClauses = requiredResources.map(() => `
               AND EXISTS (SELECT 1 FROM whoop_resource_access ra
                            WHERE ra.user_id = user_onboarding.user_id AND ra.resource = ?
                              AND ra.status = ?
                              AND ra.auth_generation = (SELECT k3.auth_generation
                                                          FROM user_whoop_tokens k3
                                                         WHERE k3.user_id = user_onboarding.user_id))`).join('');
    const accessArgs = requiredResources.flatMap((r) => [String(r), RESOURCE_ACCESS_STATUS.ACCESSIBLE]);
    const rs = await client.execute({
      sql: `UPDATE user_onboarding
               SET state = ?, state_changed_at = ?, ready_at = ?,
                   failure_code = NULL, failure_detail = NULL, updated_at = ?
             WHERE user_id = ?
               AND state IN (${states.map(() => '?').join(',')})
               AND timezone_confirmed_at IS NOT NULL
               AND EXISTS (SELECT 1 FROM users u WHERE u.id = user_onboarding.user_id AND u.status = ?)
               AND EXISTS (SELECT 1 FROM user_telegram t
                            WHERE t.user_id = user_onboarding.user_id AND t.status = 'ACTIVE')
               -- ★ RC2 / F02：身分必須**可信**。「有一組 token」不是身分證明 ——
               -- 它不能證明那組 token 屬於這個內部使用者歷史上的 WHOOP 帳號。
               -- 這裡用 STRICT 規則（token 上有身分，且與 canonical 不衝突）；
               -- 窄化的歷史例外只存在於遷移，即時路徑拿不到。
               AND EXISTS (SELECT 1 FROM users u
                            WHERE u.id = user_onboarding.user_id
                              AND ${ONBOARDING_IDENTITY_STRICT_SQL})
               AND EXISTS (SELECT 1 FROM whoop_sync_state s WHERE s.user_id = user_onboarding.user_id)
               AND EXISTS (SELECT 1 FROM whoop_capabilities c WHERE c.user_id = user_onboarding.user_id)${accessClauses}`,
      args: [ONBOARDING_STATE.READY, ts, ts, ts, uid, ...states, USER_STATUS.ACTIVE, ...accessArgs],
    });
    if (Number(rs.rowsAffected ?? 0) > 0) {
      log.info('onboarding_state', { user_id: uid, state: ONBOARDING_STATE.READY });
      return { ok: true };
    }
    // 沒成立：把**為什麼**查出來給呼叫端（只用來寫 log 與決定下一步）。
    const row = await getOnboardingRow(uid);
    return { ok: false, reason: !row ? 'no_onboarding' : `state:${row.state}`, state: row?.state ?? null };
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
  /**
   * 授權連結的**冷卻**閘門（F03）。
   *
   * 這裡只管「兩次之間至少隔多久」—— 純時間條件，所以一定會自己恢復。
   * 「同時最多幾條有效連結」由 identityStore 的 createOAuthState 用一句
   * 條件式 INSERT 決定（那才是原子的，而且過期的 state 自然不再計入）。
   *
   * auth_link_count 從此只是診斷計數，**不再**是會把人永久鎖死的配額。
   */
  async function recordAuthLinkIssued(userId, { cooldownMs, now = new Date() }) {
    const uid = requireUserId(userId, 'recordAuthLinkIssued');
    const row = await getOnboardingRow(uid);
    if (!row) return { ok: false, reason: 'no_onboarding' };
    const t = new Date(now).getTime();
    if (row.lastAuthLinkAt && t - Date.parse(row.lastAuthLinkAt) < cooldownMs) {
      return { ok: false, reason: 'cooldown', retryAfterMs: cooldownMs - (t - Date.parse(row.lastAuthLinkAt)) };
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
   * 排程器的使用者清單：ACTIVE **而且**上線狀態是 READY。
   *
   * ★ F02/N06：「沒有上線列」**不再**被當成 READY。
   *
   * v14/v15 的遷移保證每個既有使用者都有一列（而且是依證據推導的），
   * 之後任何新使用者都必須自己走完狀態機。把「查不到列」當成 READY 等於
   * 留一個繞過上線流程的後門：一個剛被 CLI 建出來、什麼都還沒設定的
   * ACTIVE 使用者會立刻開始收日報。
   *
   * 用 JOIN 而不是先取全部再過濾：一個還在選時區的人根本不該出現在日報
   * 流程裡，而不是「出現了但後面被跳過」。
   */
  async function listSchedulableUsers({ activeStatus }) {
    const rs = await client.execute({
      sql: `SELECT u.* FROM users u
              JOIN user_onboarding o ON o.user_id = u.id
             WHERE u.status = ? AND o.state = ?
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
    deriveOnboardingState,
    ensureOnboarding,
    ensureOnboardingDerived,
    ensureOnboardingDerivedForAll,
    setOnboardingState,
    setReadyIfEligible,
    getAuthGeneration,
    recordResourceAccess,
    getResourceAccess,
    recordAuthLinkIssued,
    resetAuthLinkBudget,
    recordBootstrapAttempt,
    listOnboardingInState,
    listSchedulableUsers,
  };
}
