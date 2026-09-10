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
 * ## M-01：身分必須被驗證，絕不可以捏造
 *
 * WHOOP 的 token endpoint **不會回傳這是誰的帳號**，所以 `exchange()` 的
 * 結果裡沒有 `whoopUserId`。舊版直接 `tokens.whoopUserId ?? null`，於是正式
 * 路徑上 `whoop_user_id` 永遠是 NULL，而 schema 的 partial unique index
 * （`WHERE whoop_user_id IS NOT NULL`）與 `findUserByWhoopUserId()` 全部
 * 形同虛設 —— 同一個 WHOOP 帳號可以綁到兩個內部使用者，之後 Bob 的簡報
 * 其實是 Alice 的生理資料。實測確認：兩次授權都成功，兩筆都是 NULL。
 *
 * 現在身分驗證是**授權流程的必要步驟**，而且三個方向都 fail-closed：
 *
 *   1. 問不到 WHOOP user id  → 不存 token，`IDENTITY_UNVERIFIED`。
 *   2. 這個 WHOOP 帳號已經屬於另一個內部使用者 → 拒絕（DB unique index
 *      仍然是 race-safe 的最後一道）。
 *   3. 這個內部使用者先前已經綁過**另一個** WHOOP 帳號 → 拒絕。
 *      否則舊帳號累積的健康資料會被無聲地重新歸屬到新帳號名下。
 *
 * @param {function} exchange async ({ code }) => { accessToken, refreshToken, expiresAt, scope, whoopUserId? }
 *   由呼叫端注入，測試時給 mock，正式跑時包 whoop.exchangeCode。
 * @param {function} verifyIdentity async ({ accessToken }) => string
 *   用剛拿到的 token 問出 WHOOP user id。**必填** —— 沒有它就沒有身分，
 *   沒有身分就不存 token。正式跑時包 whoop.fetchWhoopUserId。
 */
export async function completeAuthorization({
  db, rawState, code, exchange, verifyIdentity, now = new Date(),
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

  // ---- M-01 身分閘門：先確定這是誰，才可能把 token 存到誰身上 ----
  let whoopUserId = tokens.whoopUserId ?? null;
  if (whoopUserId === null || whoopUserId === undefined || String(whoopUserId).trim() === '') {
    if (typeof verifyIdentity !== 'function') {
      throw new OAuthFlowError(
        'IDENTITY_UNVERIFIED',
        'WHOOP 沒有回傳帳號身分，而且沒有提供 verifyIdentity —— '
        + '為避免把別人的生理資料歸到這個使用者名下，授權中止（token 未儲存）。',
      );
    }
    try {
      whoopUserId = await verifyIdentity({ accessToken: tokens.accessToken });
    } catch (err) {
      throw new OAuthFlowError(
        'IDENTITY_UNVERIFIED',
        `無法向 WHOOP 確認這是哪個帳號（${String(err?.message ?? err).slice(0, 160)}）——`
        + '為避免身分錯置，授權中止（token 未儲存）。',
      );
    }
  }
  whoopUserId = whoopUserId === null || whoopUserId === undefined
    ? null : String(whoopUserId).trim();
  if (!whoopUserId) {
    throw new OAuthFlowError(
      'IDENTITY_UNVERIFIED',
      'WHOOP 身分查詢回傳空值 —— 授權中止（token 未儲存）。',
    );
  }

  // 這個 WHOOP 帳號已經是別人的？（DB unique index 是 race-safe 的最後一道，
  // 這裡先擋是為了給人看得懂的錯誤，而且在寫入之前就停下來。）
  const owner = await db.findUserByWhoopUserId(whoopUserId, { excludeUserId: userId });
  if (owner) {
    throw new OAuthFlowError(
      'WHOOP_ACCOUNT_ALREADY_LINKED',
      `這個 WHOOP 帳號已經綁在另一個內部使用者身上（${owner}），不可重複綁定。`,
    );
  }

  // 這個內部使用者先前綁的是**另一個** WHOOP 帳號？
  // 直接覆蓋會讓舊帳號累積的健康資料被無聲地重新歸屬，等同捏造身分。
  const existing = await db.getTokens(userId);
  if (existing?.whoopUserId && String(existing.whoopUserId) !== whoopUserId) {
    throw new OAuthFlowError(
      'WHOOP_ACCOUNT_MISMATCH',
      `使用者 ${userId} 先前綁定的是另一個 WHOOP 帳號。`
      + '換帳號會讓既有的健康資料被錯誤歸屬，因此拒絕。'
      + '若確定要換人，請建立新的內部使用者。',
    );
  }

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
    user_id: userId,
    has_refresh: Boolean(tokens.refreshToken),
    whoop_user_id: whoopUserId,
  });
  return { userId, whoopUserId, scope: tokens.scope ?? null };
}
