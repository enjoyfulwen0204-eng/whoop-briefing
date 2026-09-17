/**
 * WHOOP OAuth + v2 API client。
 *
 * Token 策略（重要）：
 *  - access token 還有 >5 分鐘效期 → 直接重用，不 refresh。
 *  - 快過期才 refresh；refresh 成功後「第一件事」是把新的
 *    refresh_token / access_token / expires_at 寫回 Turso，
 *    寫成功前不做任何 WHOOP 資料處理。DB 寫入失敗會 retry 並中止本次執行。
 *  - 動態 token 只存 Turso，不放環境變數。
 *  - **兩層互斥**：process 內用記憶體 mutex（refreshing），跨 process 再加一層
 *    Turso lease lock。WHOOP 會輪替 refresh_token，兩個 process 同時 refresh
 *    會讓慢的那一方手上的 refresh_token 直接失效（必須重新授權才能恢復）。
 *
 * Rate limit：預設 100 req/分、10,000 req/日。遇到 429 用 exponential backoff，
 * 若有 X-RateLimit-Reset / Retry-After 就依它等待。
 */

import { LOCKS, WHOOP } from './config.js';
import { requireUserId } from './userContext.js';
import { log } from './logger.js';
import { requireLifecycle } from './accountLifecycle.js';

export class WhoopAuthError extends Error {
  constructor(message) {
    super(message);
    this.name = 'WhoopAuthError';
  }
}

export class WhoopApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'WhoopApiError';
    this.status = status;
  }
}

/** 「這一輪是以一個已經過期的授權開始的」的統一代碼。 */
export const STALE_AUTHORIZATION = 'STALE_AUTHORIZATION';

/**
 * ★ F04：授權世代圍欄被觸發。
 *
 * 意思是：這個 client 被綁定在授權世代 N 上，但 DB 現在給的是別的世代 ——
 * 使用者在這一輪執行的中途重新授權了。
 *
 * 這**不是**權限不足，也**不是** provider 故障，更不是使用者做錯了什麼。
 * 它是一個純粹的內部競態，正確的處置只有一個：這一輪放棄，什麼都不寫，
 * 讓新的世代自己跑一輪。所以它有自己的型別與 code，不可以被
 * `isScopeError` 吃掉變成「缺 scope」（那會對使用者發出錯誤的重新授權提示）。
 *
 * 錯誤內容只有兩個整數，沒有任何 token / refresh token / 授權碼 / state。
 */
export class WhoopAuthGenerationError extends WhoopAuthError {
  constructor({ expected = null, actual = null } = {}) {
    super('WHOOP 授權世代在本次執行期間改變（使用者重新授權），本輪以舊授權開始，中止且不寫入任何結論。');
    this.name = 'WhoopAuthGenerationError';
    this.code = STALE_AUTHORIZATION;
    this.expectedAuthGeneration = expected;
    this.actualAuthGeneration = actual;
  }
}

/** 這個錯誤是不是「舊授權」競態（呼叫端據此回 RETRY，而不是失敗升級）。 */
export function isStaleAuthorizationError(err) {
  return err?.code === STALE_AUTHORIZATION;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// OAuth
// ---------------------------------------------------------------------------

/**
 * 用剛換到的 access token 問「這是誰的 WHOOP 帳號」（M-01）。
 *
 * ## 為什麼授權流程一定要做這一步
 *
 * `postToken()` 只回 access_token / refresh_token / expires_in / scope ——
 * WHOOP 的 token endpoint **不會告訴你這是誰**。所以 `completeAuthorization`
 * 裡的 `tokens.whoopUserId` 在正式路徑上永遠是 undefined，
 * `user_whoop_tokens.whoop_user_id` 永遠寫進 NULL，而那個 partial unique
 * index 的條件正是 `WHERE whoop_user_id IS NOT NULL` ——
 * **所有防止「同一個 WHOOP 帳號綁到兩個內部使用者」的機制全部沒有生效。**
 *
 * 後果不是「少一個檢查」，是**身分被捏造**：兩個內部使用者可以指向同一個
 * WHOOP 帳號，之後 Bob 的每日簡報、Journal 關聯、長期規律、預測，全部是
 * Alice 的生理資料，而系統會自信地稱它為 Bob 的。
 *
 * 這支函式因此是授權流程的**必要**步驟，不是加值功能：
 * 問不到身分就不存 token（見 completeAuthorization 的 fail-closed）。
 *
 * 用的是官方 v2 `/user/profile/basic`，只讀 `user_id`，
 * **不儲存也不 log 姓名或 email**。
 */
export async function fetchWhoopUserId({
  accessToken, apiBase = WHOOP.API_BASE, fetchImpl = fetch,
}) {
  if (!accessToken) throw new WhoopAuthError('fetchWhoopUserId：沒有 access token');
  let res;
  try {
    res = await fetchImpl(`${apiBase}/user/profile/basic`, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    });
  } catch (err) {
    throw new WhoopApiError(`WHOOP 身分查詢連線失敗：${err?.message ?? err}`, 0);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new WhoopApiError(
      `WHOOP 身分查詢失敗 ${res.status}: ${body.slice(0, 200)}`, res.status,
    );
  }
  const json = await res.json().catch(() => null);
  const id = json?.user_id;
  // 0 是不合法的 WHOOP user id；空字串 / null / undefined 也一樣不可接受
  if (id === null || id === undefined || id === '' || Number(id) === 0) {
    throw new WhoopApiError('WHOOP 身分查詢沒有回傳 user_id', res.status);
  }
  return String(id);
}

/** 建立授權網址（一次性授權腳本用）。 */
export function buildAuthorizeUrl({ clientId, redirectUri, state }) {
  const u = new URL(WHOOP.AUTH_URL);
  u.searchParams.set('client_id', clientId);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', WHOOP.SCOPES);
  u.searchParams.set('state', state);
  return u.toString();
}

/**
 * @param {function} fetchImpl 可注入，測試絕不打真的 WHOOP。
 *   舊版寫死全域 fetch —— 於是 refreshTokens 完全無法在測試中被攔截，
 *   而那正好是 M-02 最需要驗的那一段。
 * @param {number} timeoutMs **必要**，不是調校。
 *   沒有逾時的 refresh 會一路掛著，而 lease 的 TTL 是有限的：
 *   owner A 卡在網路上 → 租約過期 → B 接手並換到新的 refresh_token
 *   → A 的請求終於回來 → A 用**過期的結果**覆蓋掉 B 的新 token。
 *   WHOOP 會輪替 refresh_token，所以那一寫會把帳號直接鎖死（要人工重新授權）。
 */
async function postToken(body, tokenUrl = WHOOP.TOKEN_URL, {
  fetchImpl = fetch, timeoutMs = WHOOP.TOKEN_REQUEST_TIMEOUT_MS,
} = {}) {
  let res;
  try {
    res = await fetchImpl(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    // 逾時 / 連線失敗。絕不在訊息裡帶任何 token 內容。
    throw new WhoopAuthError(`WHOOP token endpoint 連線失敗：${err?.name ?? ''} ${err?.message ?? ''}`.trim());
  }
  const text = await res.text();
  if (!res.ok) {
    throw new WhoopAuthError(`WHOOP token endpoint ${res.status}: ${text.slice(0, 300)}`);
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new WhoopAuthError('WHOOP token endpoint 回傳非 JSON');
  }
  if (!json.access_token) throw new WhoopAuthError('WHOOP token 回應缺少 access_token');
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: new Date(Date.now() + Number(json.expires_in ?? 3600) * 1000),
    scope: json.scope ?? WHOOP.SCOPES,
  };
}

/** authorization_code → 第一組 token。 */
export function exchangeCode({
  code, clientId, clientSecret, redirectUri, tokenUrl, fetchImpl, timeoutMs,
}) {
  return postToken({
    grant_type: 'authorization_code',
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
  }, tokenUrl, { fetchImpl, timeoutMs });
}

/** refresh_token → 新 token（WHOOP 會輪替 refresh_token）。 */
export function refreshTokens({
  refreshToken, clientId, clientSecret, tokenUrl, fetchImpl, timeoutMs,
}) {
  return postToken({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
    scope: 'offline',
  }, tokenUrl, { fetchImpl, timeoutMs });
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/**
 * 每個內部使用者一個 client。
 *
 * userId 是**必填**：token 的擁有權、refresh 的 lease lock 名稱都綁在它上面。
 * 這樣 Alice 的 refresh 不會卡住 Bob（鎖名不同），也不可能拿到別人的 token。
 */
export function createWhoopClient({
  db, userId, clientId, clientSecret, fetchImpl = fetch, sleepImpl = sleep,
  // 下面兩個只有測試會覆寫，正式執行一律用官方 endpoint
  apiBase = WHOOP.API_BASE, tokenUrl = WHOOP.TOKEN_URL,
  backoffFor = backoffMs,
  // ★ F04：把這個 client 綁死在**一次**授權上（見下方大段說明）。
  // 不傳就是既有行為（不受約束），所以 index.js / reconcile.js 完全不受影響。
  authorization = null,
  // ★ R2 §9：帳號啟用世代，與授權世代**各自獨立**。
  // 一個受約束的健康 client 兩個都要帶：重新授權不動啟用期，
  // 停用／再啟用不動授權期。
  expectedLifecycleGeneration = null,
} = {}) {
  const uid = requireUserId(userId, 'createWhoopClient');
  // per-user 的 lease lock 名稱。全域鎖名會讓一個人的 refresh 卡住所有人。
  const lockName = `${LOCKS.TOKEN_REFRESH_NAME}:${uid}`;
  // ---------------------------------------------------------------------
  // ★ F04：授權世代圍欄
  // ---------------------------------------------------------------------
  //
  // 上線 bootstrap 會用同一個 client 連續做很多次 WHOOP 觀測（sync 五種資源
  // 再加 capability 盤點）。這一整串觀測最後會變成「這次授權拿不拿得到這個
  // 資源」的**耐久結論**，所以它們必須全部屬於**同一次授權**。
  //
  // 問題在於 client 會在好幾個地方從 DB 重新撿 token（peer refresh、圍欄
  // 落敗後的 adopt、401 之後的強制 refresh）。使用者只要在這中間重新授權，
  // 這些路徑就會安靜地換上**新世代**的憑證繼續跑 —— 於是同一組結論裡
  // 一半是 N、一半是 N+1，而沒有任何人知道。
  //
  // 綁定之後：任何一次從 DB 撿到的 token 只要世代不是 N，就**不採用**，
  // 直接拋 STALE_AUTHORIZATION。寧可這一輪整個放棄（新世代自己會跑一輪），
  // 也不要產生一組跨世代、無法歸屬的觀測。
  const expectedGeneration = Number.isInteger(authorization?.authGeneration)
    ? authorization.authGeneration : null;
  const constrained = expectedGeneration !== null;
  // ★ R3 / R2-FG-01：**每一個** client 都必須帶啟用脈絡，不只受授權約束的。
  //
  // R2 只在 `authorization` 出現時才要求它，於是所有「正常的」執行期
  // client（排程器的 runForUser、手動同步、盤點、對帳、webhook 重放）
  // 全都是不受約束的 —— 而那些正是會做例行 token refresh 的路徑。
  // 一個在停用前開始的 refresh 因此仍然可以把輪替後的憑證寫回去。
  //
  // 現在少傳就大聲失敗；管理／測試要不受約束必須明確寫 LIFECYCLE_UNFENCED。
  const lifecycleFence = requireLifecycle(
    expectedLifecycleGeneration, 'createWhoopClient',
  );
  // 受約束時直接用呼叫端已經讀好的那一列當快取：第一次 WHOOP 呼叫因此
  // 不會再去讀一次 token 列（那次讀取本身就是一個新的、可能不同的快照）。
  let cached = constrained ? authorization : null;
  let refreshing = null;   // mutex：同一 run 內平行請求時只會 refresh 一次

  /**
   * 從 DB 撿來的這一列，屬於我們這一輪綁定的那次授權嗎。
   *
   * 不受約束的 client 一律放行（既有行為）。受約束時世代不符就拋，
   * 而且**在採用之前**拋 —— 圍欄的意義就是不讓它進到 `cached`。
   */
  function assertGeneration(t) {
    if (!constrained || !t) return t;
    const actual = Number.isInteger(t.authGeneration) ? t.authGeneration : null;
    if (actual !== expectedGeneration) {
      log.warn('whoop_stale_authorization', {
        user_id: uid, expected_generation: expectedGeneration, actual_generation: actual,
      });
      throw new WhoopAuthGenerationError({ expected: expectedGeneration, actual });
    }
    return t;
  }

  async function loadTokens() {
    if (cached) return cached;
    const t = assertGeneration(await db.getTokens(uid));
    if (!t) {
      throw new WhoopAuthError(
        `這個使用者（${uid}）在 Turso 裡沒有 WHOOP token。`
        + '請先跑 `npm run authorize -- --user=<userId>` 完成授權。',
      );
    }
    cached = t;
    return t;
  }

  /** 取得可用的 access token（>5 分鐘效期就重用）。 */
  async function getAccessToken({ force = false } = {}) {
    if (lifecycleFence !== null) await db.assertAccountActive(uid, lifecycleFence);
    const t = await loadTokens();
    const msLeft = t.expiresAt.getTime() - Date.now();
    if (!force && msLeft > WHOOP.TOKEN_REFRESH_SKEW_MS) {
      log.info('token_reused', { user_id: uid, minutes_left: Math.round(msLeft / 60000) });
      return t.accessToken;
    }
    // 平行請求時只允許一個 refresh（WHOOP 會輪替 refresh_token，重複 refresh 會失效）
    if (refreshing) return refreshing;
    refreshing = doRefresh(t, force).finally(() => { refreshing = null; });
    return refreshing;
  }

  /**
   * DB 裡這組 token 現在能不能直接用？
   *  - 一般情況：還有 >5 分鐘效期就能用。
   *  - force（剛剛吃了 401）：只有「跟剛才失敗的那個不同」的 token 才算數，
   *    否則會拿同一個壞掉的 token 再撞一次牆。
   */
  function tokenUsable(t, { force, staleAccessToken }) {
    if (!t?.accessToken) return false;
    if (force) return t.accessToken !== staleAccessToken;
    return t.expiresAt.getTime() - Date.now() > WHOOP.TOKEN_REFRESH_SKEW_MS;
  }

  /**
   * 別的 process 正握著 refresh lock。等它做完，然後從 DB 撿現成的新 token。
   *
   * 刻意**不會**在等不到時自己硬 refresh —— 那正好會造成這個 lock 要防的
   * refresh_token 輪替競態。寧可這一輪失敗（30 分鐘後排程會再來），
   * 也不要把 refresh_token 弄丟而需要人工重新授權。
   */
  async function waitForPeerRefresh({ force, staleAccessToken }) {
    const attempts = Math.max(1, Math.ceil(LOCKS.TOKEN_REFRESH_WAIT_MS / LOCKS.TOKEN_REFRESH_POLL_MS));
    log.warn('token_refresh_lock_busy', { user_id: uid, attempts, poll_ms: LOCKS.TOKEN_REFRESH_POLL_MS });
    for (let i = 1; i <= attempts; i++) {
      await sleepImpl(LOCKS.TOKEN_REFRESH_POLL_MS);
      // ★ F04：世代不符就**立刻**放棄，不繼續輪詢 —— 我們等的那個授權
      // 已經不存在了，再等下去只會等到一個我們無權使用的憑證。
      const latest = assertGeneration(await db.getTokens(uid));
      if (tokenUsable(latest, { force, staleAccessToken })) {
        cached = latest;
        log.info('token_adopted_from_peer', { user_id: uid, waited_polls: i });
        return latest.accessToken;
      }
    }
    throw new WhoopAuthError(
      '另一個執行中的 process 正在 refresh WHOOP token，等待逾時。'
      + '本次執行中止（不自行 refresh，避免 refresh_token 輪替競態）。',
    );
  }

  /**
   * 被圍欄擋下之後的善後：去看看**別人**寫了什麼。
   *
   * 這是刻意的非對稱設計 —— 我們放棄自己的結果，但不放棄這一輪執行：
   * 接手者八成已經寫好一組可用的 token，直接用它就好。
   * 撿不到才失敗（而失敗只是這一輪跑不了，30 分鐘後排程會再來）。
   *
   * 絕不 log 任何 token 內容。
   */
  async function adoptPeerToken({ force, staleAccessToken, reason }) {
    // ★ F04：接手者寫的可能是**下一次授權**的 token。撿別人的結果是好事，
    // 撿到別的世代則是這個圍欄存在的唯一理由 —— 不採用，拋 STALE_AUTHORIZATION。
    const latest = assertGeneration(await db.getTokens(uid));
    if (tokenUsable(latest, { force, staleAccessToken })) {
      cached = latest;
      log.info('token_adopted_after_fence', { user_id: uid, reason });
      return latest.accessToken;
    }
    throw new WhoopAuthError(
      '這次 WHOOP token refresh 失去了所有權（另一個 process 已經接手），'
      + '而且撿不到可用的新 token。本次執行中止，不覆寫任何 token 狀態。',
    );
  }

  async function doRefresh(t, force) {
    const staleAccessToken = t.accessToken;
    const msLeft = t.expiresAt.getTime() - Date.now();

    // 跨 process lease lock。db 沒有實作時退回只有 process 內互斥（並警告）。
    let owner = null;
    const lockable = typeof db.acquireLock === 'function';
    if (lockable) {
      owner = await db.acquireLock(lockName, {
        ttlMs: LOCKS.TOKEN_REFRESH_TTL_MS,
      });
      if (!owner) return waitForPeerRefresh({ force, staleAccessToken });
    } else {
      log.warn('token_refresh_lock_unavailable', { reason: 'db.acquireLock 未實作' });
    }

    try {
      // 拿到 lock 之後【重新讀一次 DB】：剛剛卡住的那段時間，別的 process
      // 可能已經 refresh 完了。有現成的就直接用，不要浪費一次輪替。
      const latest = assertGeneration(await db.getTokens(uid));
      if (tokenUsable(latest, { force, staleAccessToken })) {
        cached = latest;
        log.info('token_refresh_skipped_peer_won', { user_id: uid });
        return latest.accessToken;
      }

      const base = latest ?? t;
      // 這一版 token 的版本戳。等一下寫回去的時候要用它做 compare-and-swap：
      // 如果 DB 上的 updated_at 已經不是它，代表在我們打網路的這段時間裡
      // 有別人寫過了 —— 我們手上的結果就是舊的。
      const baseUpdatedAt = base?.updatedAt ?? null;

      log.info('token_refresh_start', { user_id: uid, minutes_left: Math.round(msLeft / 60000), force });
      const fresh = await refreshTokens({
        refreshToken: base.refreshToken,
        clientId,
        clientSecret,
        tokenUrl,
        fetchImpl,
      });

      // -------------------------------------------------------------------
      // ★ M-02：寫入圍欄。網路回來了**不代表**我們還有權力寫。
      // -------------------------------------------------------------------
      //
      // 兩道各自獨立、都必要的關卡：
      //
      //   1. 租約還在不在（lockable 時）。請求有逾時，但逾時仍可能長到
      //      跨過租約；而且 GC / 排程延遲也會讓一個 process 停很久。
      //   2. compare-and-swap。就算租約看起來還在（時鐘偏移、鎖被誤放），
      //      DB 上的版本戳才是最終權威。
      //
      // 任一關卡不過就**放棄這次寫入**，改去撿別人寫好的新 token。
      // WHOOP 會輪替 refresh_token：用舊結果覆蓋新狀態會讓帳號直接失效，
      // 而那需要人工重新授權才能救回來。少 refresh 一次只是這一輪跑不了。
      if (lockable && owner) {
        const stillMine = typeof db.holdsLock === 'function'
          ? await db.holdsLock(lockName, owner)
          : true;
        if (!stillMine) {
          log.warn('token_refresh_fenced', { user_id: uid, reason: 'lease_lost' });
          return adoptPeerToken({ force, staleAccessToken, reason: 'lease_lost' });
        }
      }

      let written = true;
      try {
        // ⚠️ 第一件事：寫回 Turso。寫成功前不做任何 WHOOP 資料處理。
        written = await db.saveTokens(uid, {
          accessToken: fresh.accessToken,
          refreshToken: fresh.refreshToken ?? base.refreshToken,
          expiresAt: fresh.expiresAt,
          scope: fresh.scope,
          // ★ F04：例行 refresh **不會**動世代（世代代表「這次授權／同意」，
          // 不是 token 字串的版本）。所以這裡寫的是「我還是在世代 N」，
          // 而不是「把世代推進」。
        }, {
          expectedUpdatedAt: baseUpdatedAt,
          expectedAuthGeneration: base.authGeneration ?? expectedGeneration,
          // ★ R2 / LIFE-FG-01：輪替後的憑證不可以寫進一個已經停用（或已經
          // 換過啟用期）的帳號。這是與授權世代正交的第二道 CAS。
          expectedLifecycleGeneration: lifecycleFence,
        });
      } catch (err) {
        // 身分不可變之類的硬錯誤要往上拋，不可以被當成「有人搶先寫了」。
        if (err?.code === 'WHOOP_IDENTITY_IMMUTABLE') throw err;
        throw err;
      }

      if (written === false) {
        // CAS 失敗：在我們打網路的時候有人寫過了。我們手上的是舊結果。
        log.warn('token_refresh_fenced', { user_id: uid, reason: 'stale_version' });
        return adoptPeerToken({ force, staleAccessToken, reason: 'stale_version' });
      }

      cached = {
        accessToken: fresh.accessToken,
        refreshToken: fresh.refreshToken ?? base.refreshToken,
        expiresAt: fresh.expiresAt,
        scope: fresh.scope,
        whoopUserId: base.whoopUserId ?? null,
        // 我們剛剛自己寫的那一列，世代照定義沒有變。保留它，否則下一次
        // 需要比對世代的地方會拿到 undefined 而誤判成「世代不符」。
        authGeneration: base.authGeneration ?? expectedGeneration ?? undefined,
      };
      log.info('token_refresh_done', { user_id: uid, expires_at: fresh.expiresAt.toISOString() });
      return cached.accessToken;
    } finally {
      if (owner) {
        try {
          await db.releaseLock(lockName, owner);
        } catch (err) {
          // 放不掉沒關係，TTL 到了自然過期。絕不能因此蓋掉真正的結果 / 錯誤。
          log.warn('token_refresh_lock_release_failed', { error: String(err?.message ?? err) });
        }
      }
    }
  }

  /** 單一 GET，含 429 / 5xx backoff 與 401 自動 refresh 一次。 */
  async function apiGet(path, params = {}, { retriedAfterAuth = false } = {}) {
    const token = await getAccessToken();
    const url = new URL(apiBase + path);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }

    for (let attempt = 1; attempt <= WHOOP.MAX_RETRIES; attempt++) {
      let res;
      try {
        res = await fetchImpl(url.toString(), {
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        });
      } catch (err) {
        // 網路層失敗也重試
        if (attempt === WHOOP.MAX_RETRIES) {
          throw new WhoopApiError(`WHOOP 連線失敗：${err?.message ?? err}`, 0);
        }
        await sleep(backoffFor(attempt));
        continue;
      }

      if (res.status === 401) {
        if (retriedAfterAuth) throw new WhoopAuthError('WHOOP 回 401，refresh 後仍失敗（refresh_token 可能已失效，需重新授權）');
        log.warn('whoop_401_refreshing', { path });
        await getAccessToken({ force: true });
        return apiGet(path, params, { retriedAfterAuth: true });
      }

      if (res.status === 429 || res.status >= 500) {
        const wait = retryAfterMs(res) ?? backoffFor(attempt);
        log.warn('whoop_rate_limited', { path, status: res.status, attempt, wait_ms: wait });
        if (attempt === WHOOP.MAX_RETRIES) {
          throw new WhoopApiError(`WHOOP ${res.status}（已重試 ${attempt} 次）`, res.status);
        }
        await sleep(wait);
        continue;
      }

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new WhoopApiError(`WHOOP ${res.status} ${path}: ${body.slice(0, 200)}`, res.status);
      }

      return res.json();
    }
    throw new WhoopApiError(`WHOOP ${path} 重試耗盡`, 0);
  }

  /**
   * Collection 分頁（每頁最多 25 筆，用 next_token 翻頁）。
   * maxPages 是安全上限，避免異常時無限抓。
   */
  async function collect(path, params = {}, { maxPages = WHOOP.MAX_PAGES } = {}) {
    const out = [];
    let nextToken = null;
    let pages = 0;
    do {
      const page = await apiGet(path, {
        ...params,
        limit: WHOOP.PAGE_LIMIT,
        nextToken: nextToken ?? undefined,
      });
      const records = Array.isArray(page?.records) ? page.records : [];
      out.push(...records);
      nextToken = page?.next_token || null;
      pages += 1;
      if (pages >= maxPages && nextToken) {
        log.warn('whoop_pagination_capped', { path, pages, fetched: out.length });
        break;
      }
    } while (nextToken);
    log.info('whoop_collected', { path, pages, records: out.length });
    return out;
  }

  const iso = (d) => new Date(d).toISOString();

  return {
    getAccessToken,
    apiGet,
    collect,
    /** 睡眠（含小睡）。 */
    sleeps: (start, end) => collect('/activity/sleep', { start: iso(start), end: iso(end) }),
    /** 恢復。 */
    recoveries: (start, end) => collect('/recovery', { start: iso(start), end: iso(end) }),
    /** 生理週期（day strain 在這裡）。 */
    cycles: (start, end) => collect('/cycle', { start: iso(start), end: iso(end) }),
    /**
     * 運動紀錄。需要 read:workout scope —— 舊 token 沒有這個 scope，
     * 會拿到 401/403。呼叫端必須自己接住（不可以讓簡報因此掛掉）。
     */
    workouts: (start, end) => collect('/activity/workout', { start: iso(start), end: iso(end) }),
    /**
     * 身體量測（身高 / 體重 / 最大心率）。
     * ⚠️ 這個 endpoint 回傳**單一物件**，不是 collection，所以不走 collect()、
     * 沒有 records / next_token / 分頁。需要 read:body_measurement scope。
     */
    bodyMeasurement: () => apiGet('/user/measurement/body'),
  };
}

/**
 * 這個錯誤是不是「token 沒有這個 scope」？
 *
 * 加了 read:workout / read:body_measurement 之後，既有 token 在重新授權前
 * 一定會撞到這個。呼叫端用它來把 capability 標成 UNAUTHORIZED，
 * 而不是當成系統故障去發錯誤通知。
 */
export function isScopeError(err) {
  // ★ F04：授權世代競態**絕不是**缺 scope。把它誤判成缺 scope 會讓系統
  // 對一個剛剛才重新授權成功的人說「你少給了權限」，並且寫下一個永久的
  // 錯誤結論。這一條必須排在所有 401/403 判斷之前。
  if (isStaleAuthorizationError(err)) return false;
  const status = err?.status;
  if (status === 403) return true;
  // refresh 過還是 401 → WhoopAuthError；scope 不足時 WHOOP 也可能回 401
  if (status === 401) return true;
  return err?.name === 'WhoopAuthError' && /401/.test(String(err?.message ?? ''));
}

function backoffMs(attempt) {
  const base = Math.min(2000 * 2 ** (attempt - 1), WHOOP.MAX_BACKOFF_MS);
  return base + Math.floor(Math.random() * 500);
}

/** 依 Retry-After / X-RateLimit-Reset 決定等多久（秒數或 epoch 秒都支援）。 */
export function retryAfterMs(res, nowMs = Date.now()) {
  const pick = (name) => res.headers?.get?.(name);
  const retryAfter = Number(pick('retry-after'));
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return Math.min(retryAfter * 1000, WHOOP.MAX_BACKOFF_MS);
  }
  const reset = Number(pick('x-ratelimit-reset'));
  if (Number.isFinite(reset) && reset > 0) {
    // > 10^9 視為 epoch 秒，否則視為「還要幾秒」
    const ms = reset > 1_000_000_000 ? reset * 1000 - nowMs : reset * 1000;
    if (ms > 0) return Math.min(ms, WHOOP.MAX_BACKOFF_MS);
  }
  return null;
}
