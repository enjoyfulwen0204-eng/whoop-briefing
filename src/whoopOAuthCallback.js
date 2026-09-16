/**
 * 公開的 WHOOP OAuth 回呼（V1.2 Phase 3.5）。
 *
 *     WHOOP 授權頁 → GET /whoop/oauth/callback?code=…&state=… → 綁定 → 一頁 HTML
 *
 * ## 這條路的權威來源只有 state
 *
 * 「這是誰」完全由 state 決定（它在產生的那一刻就綁死一個內部 userId，
 * DB 只存 hash）。query string 裡的任何其他東西都不被信任，也沒有任何
 * 參數可以指定使用者。所以用 Alice 的連結在 Bob 的瀏覽器裡完成授權，
 * 綁到的仍然是 Alice —— 瀏覽器身分在這裡沒有意義。
 *
 * ## 回應絕不回放外部輸入
 *
 * WHOOP 可能在 query 裡帶 `error` / `error_description`，那是**外部可控的
 * 字串**。舊的本機腳本把它直接印進 HTML；這裡不這麼做：所有畫面文字都是
 * 應用程式自己的常數，外部只用來選一個訊息代碼。連帶地，token、state、
 * 授權碼、內部 user_id 都不會出現在頁面或 log 裡。
 *
 * ## 有界
 *
 * callback 只做：驗 state → 換 token → 驗身分 → 存 → 改上線狀態 → 回 HTML。
 * 初次同步／backfill／capability 一概不在這裡做（見 onboardingBootstrap.js）。
 */

import { ONBOARDING_STATE, ONBOARDING_FAILURE } from './schema.js';
import { completeAuthorization, OAuthFlowError } from './oauthFlow.js';
import { log, describeError } from './logger.js';

export const OAUTH_CALLBACK_PATH = '/whoop/oauth/callback';

/** OAuthFlowError.code → 上線失敗代碼（給使用者看的訊息由 onboarding.js 決定）。 */
const FAILURE_BY_CODE = {
  NO_CODE: ONBOARDING_FAILURE.OAUTH_DENIED,
  STATE_NOT_FOUND: ONBOARDING_FAILURE.OAUTH_STATE_INVALID,
  STATE_EXPIRED: ONBOARDING_FAILURE.OAUTH_STATE_INVALID,
  STATE_USED: ONBOARDING_FAILURE.OAUTH_STATE_INVALID,
  STATE_CONSUMED: ONBOARDING_FAILURE.OAUTH_STATE_INVALID,
  NO_TOKEN: ONBOARDING_FAILURE.TOKEN_EXCHANGE_FAILED,
  IDENTITY_UNVERIFIED: ONBOARDING_FAILURE.IDENTITY_UNVERIFIED,
  IDENTITY_HISTORY_UNREADABLE: ONBOARDING_FAILURE.IDENTITY_UNVERIFIED,
  IDENTITY_HISTORY_AMBIGUOUS: ONBOARDING_FAILURE.IDENTITY_UNVERIFIED,
  WHOOP_ACCOUNT_ALREADY_LINKED: ONBOARDING_FAILURE.WHOOP_ACCOUNT_ALREADY_LINKED,
  WHOOP_ACCOUNT_MISMATCH: ONBOARDING_FAILURE.WHOOP_ACCOUNT_MISMATCH,
};

/** 畫面代碼 → 標題與內文。**全部是常數**，沒有任何外部字串。 */
const SCREENS = {
  ok: {
    status: 200,
    title: '連接完成',
    heading: '✅ WHOOP 已連接',
    body: '你可以關掉這個分頁，回到 Telegram。資料同步完成之後，助理會通知你。',
  },
  denied: {
    status: 400,
    title: '授權未完成',
    heading: '授權未完成',
    body: '你在 WHOOP 的頁面取消了授權，或授權沒有完成。回到 Telegram 輸入 /connect 可以重新取得一條連結。',
  },
  state_invalid: {
    status: 400,
    title: '連結已失效',
    heading: '這條連結已經失效',
    body: '授權連結是一次性的，而且有時效。回到 Telegram 輸入 /connect 取得一條新的。',
  },
  identity: {
    status: 400,
    title: '無法確認帳號',
    heading: '無法確認這是哪個 WHOOP 帳號',
    body: '為了避免把別人的資料算到你身上，這次授權已經中止，沒有儲存任何東西。回到 Telegram 輸入 /connect 再試一次。',
  },
  already_linked: {
    status: 409,
    title: '帳號已被連接',
    heading: '這個 WHOOP 帳號已經連到另一個使用者',
    body: '請改用你自己的 WHOOP 帳號。回到 Telegram 輸入 /connect 再試一次。',
  },
  mismatch: {
    status: 409,
    title: '帳號不一致',
    heading: '這個帳號先前連的是另一個 WHOOP 帳號',
    body: '換帳號會讓既有的健康資料被錯誤歸屬，因此擋下來了。需要換人請聯絡管理者。',
  },
  error: {
    status: 500,
    title: '暫時無法完成',
    heading: '暫時無法完成授權',
    body: '這是系統端的暫時問題。回到 Telegram 輸入 /connect 稍後再試一次。',
  },
  not_found: { status: 404, title: '找不到', heading: '找不到這個頁面', body: '' },
};

const FAILURE_SCREEN = {
  [ONBOARDING_FAILURE.OAUTH_DENIED]: 'denied',
  [ONBOARDING_FAILURE.OAUTH_STATE_INVALID]: 'state_invalid',
  [ONBOARDING_FAILURE.TOKEN_EXCHANGE_FAILED]: 'error',
  [ONBOARDING_FAILURE.IDENTITY_UNVERIFIED]: 'identity',
  [ONBOARDING_FAILURE.WHOOP_ACCOUNT_ALREADY_LINKED]: 'already_linked',
  [ONBOARDING_FAILURE.WHOOP_ACCOUNT_MISMATCH]: 'mismatch',
};

/**
 * HTML escape。**即使這裡的文字全部是自己的常數**也照escape ——
 * 這一層的存在讓「以後有人加了一個帶變數的畫面」不會變成注入點。
 */
export function escapeHtml(v) {
  return String(v ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

export function renderScreen(key) {
  const s = SCREENS[key] ?? SCREENS.error;
  const html = `<!doctype html>
<html lang="zh-Hant"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${escapeHtml(s.title)}</title>
<style>
 body{font-family:system-ui,-apple-system,"Noto Sans TC",sans-serif;margin:0;padding:2.5rem 1.25rem;
      background:#fafafa;color:#1a1a1a;line-height:1.7}
 main{max-width:34rem;margin:0 auto;background:#fff;border-radius:12px;padding:2rem;
      box-shadow:0 1px 3px rgba(0,0,0,.08)}
 h1{font-size:1.25rem;margin:0 0 1rem}
 p{margin:0;color:#444}
</style></head>
<body><main><h1>${escapeHtml(s.heading)}</h1><p>${escapeHtml(s.body)}</p></main></body></html>`;
  return { status: s.status, html };
}

/**
 * 建立 callback 處理器。
 *
 * @param {function} opts.exchange   async ({code}) => tokens
 * @param {function} opts.verifyIdentity async ({accessToken}) => whoopUserId
 * @param {function} [opts.onAuthorized] async (userId) => void
 *   授權成功之後的鉤子（送 Telegram 通知、踢一次 bootstrap）。
 *   **失敗絕不影響已經耐久的綁定** —— 錯誤只進 log。
 * @returns {function} async ({ query }) => { status, html, userId?, outcome }
 */
export function createWhoopOAuthCallback({
  db, exchange, verifyIdentity, onAuthorized = null, now = () => new Date(),
}) {
  return async function handleCallback({ query }) {
    const params = query ?? new URLSearchParams();
    const rawState = params.get('state') ?? '';
    const code = params.get('code') ?? '';
    const providerError = params.get('error') ?? '';

    // ---- 使用者在 WHOOP 那邊按了拒絕（或 WHOOP 回報錯誤）----------------
    // `error` / `error_description` 是外部可控字串：只用來**選畫面**，
    // 內容既不顯示也不進 log。
    if (providerError) {
      const userId = await markFailureByState({
        db, rawState, failure: ONBOARDING_FAILURE.OAUTH_DENIED, now,
      });
      log.warn('oauth_callback_provider_error', { has_state: Boolean(rawState), user_id: userId });
      return { ...renderScreen('denied'), outcome: 'provider_error', userId };
    }

    if (!rawState) {
      log.warn('oauth_callback_no_state', {});
      return { ...renderScreen('state_invalid'), outcome: 'no_state', userId: null };
    }

    let result;
    try {
      result = await completeAuthorization({
        db, rawState, code, exchange, verifyIdentity, now: new Date(now()),
      });
    } catch (err) {
      const code2 = err instanceof OAuthFlowError ? err.code : null;
      const failure = FAILURE_BY_CODE[code2] ?? ONBOARDING_FAILURE.TOKEN_EXCHANGE_FAILED;
      // state 已經被原子消耗掉了（fail closed），所以這裡只能用「state 之前
      // 綁的是誰」去標記失敗 —— 但那筆記錄已經沒了。改由 completeAuthorization
      // 拋出的錯誤附帶的 userId（有的話）標記。
      const userId = err?.userId ?? null;
      if (userId) {
        await db.setOnboardingState(userId, ONBOARDING_STATE.ACTION_REQUIRED, {
          from: [ONBOARDING_STATE.WHOOP_AUTH_PENDING, ONBOARDING_STATE.ACTION_REQUIRED,
            ONBOARDING_STATE.WHOOP_AUTHORIZED, ONBOARDING_STATE.SYNCING],
          failureCode: failure, failureDetail: code2, now: new Date(now()),
        }).catch(() => {});
      }
      log.warn('oauth_callback_failed', { code: code2 ?? 'unknown', user_id: userId });
      return {
        ...renderScreen(FAILURE_SCREEN[failure] ?? 'error'),
        outcome: 'failed', failure, userId,
      };
    }

    const userId = result.user?.id ?? result.userId ?? null;

    // ---- 授權成功：狀態改成「已授權」（bootstrap 由別人接手）-------------
    //
    // 這一步必須在回應之前完成而且是耐久的：程序在回應送出前後任何一刻死掉，
    // 重啟後排程器都看得到 WHOOP_AUTHORIZED 並接手。
    await db.ensureOnboarding(userId, { state: ONBOARDING_STATE.WHOOP_AUTHORIZED, now: new Date(now()) })
      .catch(() => {});
    await db.setOnboardingState(userId, ONBOARDING_STATE.WHOOP_AUTHORIZED, {
      // ★ RC2 / F04：**成功的重新授權會讓舊的權限判定失效**（授權世代 +1）。
      //
      // 所以連已經 READY 的人也要回到「已授權、待驗證」：這一次授權可能少勾了
      // 睡眠或恢復權限，而那些判定必須重新驗過才算數。bootstrap 緊接著就會跑
      // （回呼結束後立刻踢一次），通常同一輪就回到 READY。
      //
      // 重放不會走到這裡：state 是一次性的，重複的 callback 在消耗那一步就被擋下。
      from: [ONBOARDING_STATE.STARTED, ONBOARDING_STATE.TIMEZONE_PENDING,
        ONBOARDING_STATE.WHOOP_AUTH_PENDING, ONBOARDING_STATE.ACTION_REQUIRED,
        ONBOARDING_STATE.READY],
      whoopAuthorized: true, failureCode: null, failureDetail: null, now: new Date(now()),
    });
    await db.resetAuthLinkBudget(userId, { now: new Date(now()) }).catch(() => {});
    // ★ F04：一次成功的新授權 = 一個全新的 bootstrap 情境，嘗試次數歸零。
    //
    // 沒有這一條，純內部的世代競態（舊 bootstrap 以過期授權開始 → 中止）
    // 會一次次吃掉使用者的重試額度，最後把一個什麼都沒做錯、只是重新
    // 授權過幾次的人永久卡在 ACTION_REQUIRED。
    //
    // 刻意**獨立於上面那句狀態轉移**：最需要歸零的情境（舊 bootstrap 正在
    // 跑、狀態是 SYNCING）正好是那句轉移不會成立的情境（SYNCING 不在它的
    // from 白名單裡）。綁在一起等於在最需要的時候失效。
    if (typeof db.resetBootstrapAttempts === 'function') {
      await db.resetBootstrapAttempts(userId, { now: new Date(now()) }).catch(() => {});
    }

    if (onAuthorized) {
      try {
        await onAuthorized(userId);
      } catch (err) {
        // 綁定已經耐久了；通知／bootstrap 失敗不可以把成功變成失敗。
        log.warn('oauth_callback_post_hook_failed', { user_id: userId, error: describeError(err) });
      }
    }
    log.info('oauth_callback_ok', { user_id: userId });
    return { ...renderScreen('ok'), outcome: 'ok', userId };
  };
}

/**
 * provider 回報錯誤時，用**還沒被消耗**的 state 找出是誰，把他標成
 * ACTION_REQUIRED。找不到就算了（不可能從 state 反推出人時，沉默是對的）。
 *
 * 刻意**不**消耗 state：使用者可能只是按錯，手上那條連結還能用。
 */
async function markFailureByState({ db, rawState, failure, now }) {
  if (!rawState || typeof db.peekOAuthState !== 'function') return null;
  try {
    const peek = await db.peekOAuthState(rawState, { now: new Date(now()) });
    if (!peek?.userId) return null;
    await db.setOnboardingState(peek.userId, ONBOARDING_STATE.ACTION_REQUIRED, {
      from: [ONBOARDING_STATE.WHOOP_AUTH_PENDING, ONBOARDING_STATE.ACTION_REQUIRED],
      failureCode: failure, now: new Date(now()),
    });
    return peek.userId;
  } catch {
    return null;
  }
}
