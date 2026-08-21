/**
 * WHOOP OAuth + v2 API client。
 *
 * Token 策略（重要）：
 *  - access token 還有 >5 分鐘效期 → 直接重用，不 refresh。
 *  - 快過期才 refresh；refresh 成功後「第一件事」是把新的
 *    refresh_token / access_token / expires_at 寫回 Turso，
 *    寫成功前不做任何 WHOOP 資料處理。DB 寫入失敗會 retry 並中止本次執行。
 *  - 動態 token 只存 Turso，不放環境變數。
 *
 * Rate limit：預設 100 req/分、10,000 req/日。遇到 429 用 exponential backoff，
 * 若有 X-RateLimit-Reset / Retry-After 就依它等待。
 */

import { WHOOP } from './config.js';
import { log } from './logger.js';

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// OAuth
// ---------------------------------------------------------------------------

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

async function postToken(body, tokenUrl = WHOOP.TOKEN_URL) {
  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  });
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
export function exchangeCode({ code, clientId, clientSecret, redirectUri, tokenUrl }) {
  return postToken({
    grant_type: 'authorization_code',
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
  }, tokenUrl);
}

/** refresh_token → 新 token（WHOOP 會輪替 refresh_token）。 */
export function refreshTokens({ refreshToken, clientId, clientSecret, tokenUrl }) {
  return postToken({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
    scope: 'offline',
  }, tokenUrl);
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export function createWhoopClient({
  db, clientId, clientSecret, fetchImpl = fetch,
  // 下面兩個只有測試會覆寫，正式執行一律用官方 endpoint
  apiBase = WHOOP.API_BASE, tokenUrl = WHOOP.TOKEN_URL,
  backoffFor = backoffMs,
} = {}) {
  let cached = null;       // 單次執行內的記憶體快取，避免同一 run 重複讀 DB
  let refreshing = null;   // mutex：同一 run 內平行請求時只會 refresh 一次

  async function loadTokens() {
    if (cached) return cached;
    const t = await db.getTokens();
    if (!t) {
      throw new WhoopAuthError(
        'Turso 裡沒有 WHOOP token。請先在本機跑一次 `npm run authorize` 完成授權。',
      );
    }
    cached = t;
    return t;
  }

  /** 取得可用的 access token（>5 分鐘效期就重用）。 */
  async function getAccessToken({ force = false } = {}) {
    const t = await loadTokens();
    const msLeft = t.expiresAt.getTime() - Date.now();
    if (!force && msLeft > WHOOP.TOKEN_REFRESH_SKEW_MS) {
      log.info('token_reused', { minutes_left: Math.round(msLeft / 60000) });
      return t.accessToken;
    }
    // 平行請求時只允許一個 refresh（WHOOP 會輪替 refresh_token，重複 refresh 會失效）
    if (refreshing) return refreshing;
    refreshing = doRefresh(t, force).finally(() => { refreshing = null; });
    return refreshing;
  }

  async function doRefresh(t, force) {
    const msLeft = t.expiresAt.getTime() - Date.now();
    log.info('token_refresh_start', { minutes_left: Math.round(msLeft / 60000), force });
    const fresh = await refreshTokens({
      refreshToken: t.refreshToken,
      clientId,
      clientSecret,
      tokenUrl,
    });
    // ⚠️ 第一件事：寫回 Turso。寫成功前不做任何 WHOOP 資料處理。
    await db.saveTokens({
      accessToken: fresh.accessToken,
      refreshToken: fresh.refreshToken ?? t.refreshToken,
      expiresAt: fresh.expiresAt,
      scope: fresh.scope,
    });
    cached = {
      accessToken: fresh.accessToken,
      refreshToken: fresh.refreshToken ?? t.refreshToken,
      expiresAt: fresh.expiresAt,
      scope: fresh.scope,
    };
    log.info('token_refresh_done', { expires_at: fresh.expiresAt.toISOString() });
    return cached.accessToken;
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
  };
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
