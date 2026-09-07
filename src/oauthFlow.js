/**
 * Multi-user WHOOP OAuth 流程（與 CLI / HTTP 無關的純邏輯，好 mock 測試）。
 *
 * ## 安全設計
 *
 *  - state 由 identityStore 產生：**32 bytes 隨機，DB 只存 SHA-256 hash**，
 *    原文只回給 authorize URL。
 *  - state 在建立的那一刻就綁定內部 userId，**callback 完全不信任外部傳來的
 *    使用者身分** —— 誰的 token 存到誰身上，只由 state 決定。
 *    所以 Alice 的 state 不可能換到 Bob 的 token。
 *  - 消耗是原子的（單一條件式 UPDATE），所以同一組 state 兩個 callback
 *    同時進來只有一個會成功，replay 一律被拒。
 *  - 同一個 WHOOP 帳號（whoop_user_id）不允許綁到兩個不同的內部使用者：
 *    先靠 DB 的 partial unique index 擋（race-safe），程式再把錯誤翻譯成人話。
 *  - **絕不 log 或回傳 token / 原始 state。**
 */

import { USER_STATUS } from './schema.js';
import { requireUserId } from './userContext.js';
import { buildAuthorizeUrl } from './whoop.js';
import { log } from './logger.js';

export class OAuthFlowError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'OAuthFlowError';
    this.code = code;
  }
}

/** 這個使用者可以被授權嗎（存在 + ACTIVE）。 */
export async function assertAuthorizable(db, userId) {
  const uid = requireUserId(userId, 'assertAuthorizable');
  const user = await db.getUser(uid);
  if (!user) throw new OAuthFlowError('UNKNOWN_USER', `找不到使用者：${uid}`);
  if (user.status !== USER_STATUS.ACTIVE) {
    throw new OAuthFlowError('USER_NOT_ACTIVE', `使用者 ${uid} 的狀態是 ${user.status}，不可授權`);
  }
  return user;
}

/**
 * 產生授權 URL。state 綁死這個 userId。
 * @returns {{ user, state: string, authUrl: string, expiresAt: string }}
 */
export async function prepareAuthorization({
  db, userId, clientId, redirectUri, ttlMs = 10 * 60_000, now = new Date(),
}) {
  const user = await assertAuthorizable(db, userId);
  const { state, expiresAt } = await db.createOAuthState(user.id, { ttlMs, now });
  const authUrl = buildAuthorizeUrl({ clientId, redirectUri, state });
  // 只 log 使用者與到期時間，絕不 log state
  log.info('oauth_authorize_prepared', { user_id: user.id, expires_at: expiresAt });
  return { user, state, authUrl, expiresAt };
}

/**
 * 完成授權：驗 state（原子消耗）→ 換 token → 存給 state 綁定的那個使用者。
 *
 * @param {function} exchange async ({ code }) => { accessToken, refreshToken, expiresAt, scope, whoopUserId? }
 *   由呼叫端注入，測試時給 mock，正式跑時包 whoop.exchangeCode。
 */
export async function completeAuthorization({
  db, rawState, code, exchange, now = new Date(),
}) {
  if (!code) throw new OAuthFlowError('NO_CODE', 'callback 沒有帶 authorization code');

  // ★ 原子消耗。一次性 + 有期限 → replay 與並發雙擊都只有一個能過。
  const consumed = await db.consumeOAuthState(rawState, { now });
  if (!consumed.ok) {
    throw new OAuthFlowError(
      `STATE_${String(consumed.reason).toUpperCase()}`,
      `OAuth state 無效（${consumed.reason}）—— 為安全起見中止`,
    );
  }
  // 使用者身分只來自 state，不來自任何外部輸入
  const userId = consumed.userId;

  const tokens = await exchange({ code });
  if (!tokens?.accessToken) throw new OAuthFlowError('NO_TOKEN', 'WHOOP 沒有回傳 access_token');

  const whoopUserId = tokens.whoopUserId ?? null;

  try {
    await db.saveTokens(userId, {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
      scope: tokens.scope,
      whoopUserId,
    });
  } catch (err) {
    // DB 層的 partial unique index 才是真正 race-safe 的那道防線
    if (/UNIQUE constraint failed/i.test(String(err?.message ?? ''))) {
      const other = await db.findUserByWhoopUserId(whoopUserId, { excludeUserId: userId });
      throw new OAuthFlowError(
        'WHOOP_ACCOUNT_ALREADY_LINKED',
        '這個 WHOOP 帳號已經綁在另一個內部使用者身上'
        + (other ? `（${other}）` : '') + '，不可重複綁定。',
      );
    }
    throw err;
  }

  log.info('oauth_authorize_completed', {
    user_id: userId, has_refresh: Boolean(tokens.refreshToken),
  });
  return { userId, whoopUserId, scope: tokens.scope ?? null };
}
