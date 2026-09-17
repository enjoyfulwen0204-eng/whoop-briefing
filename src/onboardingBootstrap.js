/**
 * 授權之後的自動 bootstrap（V1.2 Phase 3.5）。
 *
 *     WHOOP_AUTHORIZED → SYNCING → READY
 *
 * 做三件事，全部重用既有的實作，**不另外建一套 WHOOP 攝取堆疊**：
 *
 *   1. 初次同步       createSync(...).syncAll()（含 backfill 的第一批 chunk）
 *   2. capability 盤點 probeCapabilities()
 *   3. 判定 READY 並通知使用者
 *
 * ## 為什麼不在 OAuth callback 裡同步做完
 *
 * callback 是一個 HTTP 請求，而第一次同步要抓 365 天。把它做在請求裡會讓
 * 使用者盯著一個轉不完的分頁，而且 Render 免費方案隨時可能把那個程序收掉。
 * 所以 callback 只做**有界**的事（存 token、改狀態、回一頁 HTML），
 * bootstrap 自己是可重入、可接手的：
 *
 *   · callback 之後可以立刻（非同步、不 await）踢一次，讓使用者很快收到通知
 *   · 排程器每一輪也會接手還沒走完的（`resumeOnboardingBootstraps`）
 *
 * 兩者都經過同一把鎖，所以不會有兩個同時在跑。程序在任何一點死掉，
 * 狀態機都停在 WHOOP_AUTHORIZED / SYNCING，下一輪自然接回去。
 *
 * ## 失敗不是「沒有資料」
 *
 * 同步或 capability 失敗時**不會**把使用者標成 READY，也不會寫任何
 * 「這個人沒有這個能力」的結論（probeCapabilities 只在成功時才寫）。
 * 重試若干次之後轉成 ACTION_REQUIRED，並告訴使用者怎麼自己重來。
 */

import { ONBOARDING } from './config.js';
import {
  ONBOARDING_STATE, ONBOARDING_FAILURE, RESOURCE_ACCESS_STATUS, USER_STATUS,
} from './schema.js';
import { createSync } from './sync.js';
import { probeCapabilities } from './capabilities.js';
import { createWhoopClient, isStaleAuthorizationError } from './whoop.js';
import { isAccountInactiveError } from './accountLifecycle.js';
import { requireUserId } from './userContext.js';
import { log, describeError } from './logger.js';

/**
 * 這一輪同步 / 盤點裡，哪些資源是**沒有權限**（不是沒有資料）。
 *
 * 兩個來源都算數：
 *   · syncAll 的 `status === 'scope_missing'`（isScopeError 判定的 401/403）
 *   · probeCapabilities 回的 `scopeErrors`
 *
 * ⚠️ 只認這兩種。一般的失敗（429 / 5xx / 連線斷掉）**不算**沒有權限 ——
 * 把暫時性故障當成「這個帳號沒有這個權限」會產生一個永久的錯誤結論。
 */
export function missingScopes({ syncResults = [], scopeErrors = [] } = {}) {
  const out = new Set();
  for (const r of syncResults) if (r?.status === 'scope_missing' && r.resource) out.add(String(r.resource));
  for (const e of scopeErrors) if (e?.resource) out.add(String(e.resource));
  return [...out].sort();
}

/**
 * ★ F05：這個帳號有沒有達到「可用的 Health OS」的最低權限。
 *
 * 「沒有資料」與「沒有權限」是兩件事：端點成功回傳空集合的人是正常的新使用者
 * （READY 的起點）；scope 缺失的人則是**拿不到**生理資料，讓他 READY 等於
 * 給他一個永遠不會有內容的產品。
 */
export function scopeVerdict(missing, { required = ONBOARDING.REQUIRED_SCOPES } = {}) {
  const lacking = required.filter((r) => missing.includes(r));
  return { ok: lacking.length === 0, lacking };
}

/** 初次 bootstrap 會碰到的 WHOOP 資源（與 WHOOP_SYNC.RESOURCES 一致）。 */
const SYNC_RESOURCES = ['sleep', 'recovery', 'cycle', 'workout', 'body_measurement'];

export const BOOTSTRAP_RESULT = Object.freeze({
  READY: 'READY',
  RETRY: 'RETRY',
  ACTION_REQUIRED: 'ACTION_REQUIRED',
  SKIPPED: 'SKIPPED',
  BUSY: 'BUSY',
  /**
   * ★ F04：這一輪是以一個**已經過期的授權**開始的（使用者在中途重新授權）。
   *
   * 語義上是 RETRY 的一種，但刻意獨立命名，因為它的處置與所有其他失敗都不同：
   *   · 不寫任何權限判定（那些觀測屬於一個已經不存在的授權）
   *   · 不寫 ACTION_REQUIRED（使用者沒有做錯任何事）
   *   · 不通知使用者（這是純內部競態）
   *   · 不累積失敗（新的世代會自己跑一輪，見 resetBootstrapAttempts）
   */
  STALE_AUTHORIZATION: 'STALE_AUTHORIZATION',
  /**
   * ★ v17：帳號不是 ACTIVE，或已經不在這一輪開跑時的那一段啟用期。
   *
   * 與 STALE_AUTHORIZATION 平行但**不同**：那個是「WHOOP 的同意換了」，
   * 這個是「帳號的啟用期換了（或帳號被停用）」。處置相同 —— 什麼都不寫、
   * 不通知、不累積失敗 —— 但原因必須分得開，否則診斷會指向錯誤的方向。
   */
  ACCOUNT_INACTIVE: 'ACCOUNT_INACTIVE',
});

/**
 * 這一輪同步的結果，足夠讓系統「可用」嗎。
 *
 * 只看**核心**資源（ONBOARDING.REQUIRED_SCOPES）有沒有真的失敗：
 *
 *   · `scope_missing` 不是我們的故障（由 F05 的權限判定另外處理）
 *   · 選配資源（cycle / workout / body_measurement）暫時抓不到**不該**把人
 *     永遠擋在上線外 —— 它們的指標會誠實地標成拿不到，而且排程同步之後
 *     每一輪都會再試。讓一個時好時壞的選配端點無限期卡住上線是錯的。
 *   · 核心資源（sleep / recovery）失敗 → 重試（這是暫時性故障，不是結論）
 */
export function syncUsable(results = [], { required = ONBOARDING.REQUIRED_SCOPES } = {}) {
  if (!Array.isArray(results) || !results.length) return false;
  return !results.some((r) => r?.status === 'failed' && required.includes(String(r?.resource)));
}

/**
 * 跑一個使用者的 bootstrap。**永遠不拋錯**（回結構化結果）。
 *
 * @param {function} [deps.makeWhoop] 注入點（測試用假的 WHOOP client）
 * @param {function} [deps.makeSync]
 * @param {function} [deps.probe]
 * @param {function} [deps.notify] async (userId, text) => void；送 Telegram 通知
 */
export async function runOnboardingBootstrap({
  db, userId, env, now = () => new Date(), deps = {},
}) {
  const uid = requireUserId(userId, 'runOnboardingBootstrap');
  const {
    makeWhoop = createWhoopClient,
    makeSync = createSync,
    probe = probeCapabilities,
    notify = null,
  } = deps;
  const at = () => new Date(now());

  const onboarding = await db.getOnboarding(uid);
  if (onboarding.state !== ONBOARDING_STATE.WHOOP_AUTHORIZED
      && onboarding.state !== ONBOARDING_STATE.SYNCING) {
    return { userId: uid, result: BOOTSTRAP_RESULT.SKIPPED, reason: `state:${onboarding.state}` };
  }

  // 一次只有一個 bootstrap。租約到期才可能被接手，所以卡住的程序不會永遠鎖住。
  const lockName = db.userLockName('onboarding_bootstrap', uid);
  const owner = `bootstrap:${uid}:${process.pid}:${Math.random().toString(36).slice(2, 8)}`;
  const got = await db.acquireLock(lockName, {
    owner, ttlMs: ONBOARDING.BOOTSTRAP_LEASE_MS, now: at(),
  });
  if (!got) return { userId: uid, result: BOOTSTRAP_RESULT.BUSY };

  try {
    const user = await db.getUser(uid);
    if (!user) return { userId: uid, result: BOOTSTRAP_RESULT.SKIPPED, reason: 'unknown_user' };

    // ---- 0a. ★ v17：帳號啟用閘門 + 啟用世代捕捉 ------------------------
    //
    // 必須在**任何**副作用之前：一個被停用的帳號不該消耗嘗試次數、不該被
    // 推進狀態、不該打 WHOOP、不該收到任何訊息。
    //
    // 捕捉到的世代之後會跟著整輪跑，而且每一個耐久變更都會在 SQL 裡再證明
    // 一次 —— 因為帳號可能在這之後才被停用（甚至停用又啟用，見 ABA）。
    if (user.status !== USER_STATUS.ACTIVE) {
      log.info('onboarding_account_inactive', { user_id: uid, user_status: user.status });
      return { userId: uid, result: BOOTSTRAP_RESULT.ACCOUNT_INACTIVE, reason: `status:${user.status}` };
    }
    const expectedLifecycleGeneration = user.lifecycleGeneration;

    const attempt = await db.recordBootstrapAttempt(uid, {
      expectedLifecycleGeneration, now: at(),
    });
    if (attempt && attempt.ok === false) return accountInactive(uid, 'attempt');

    const entered = await db.setOnboardingState(uid, ONBOARDING_STATE.SYNCING, {
      from: [ONBOARDING_STATE.WHOOP_AUTHORIZED, ONBOARDING_STATE.SYNCING],
      syncStarted: true,
      expectedLifecycleGeneration, requireActiveLifecycle: true,
      now: at(),
    });
    if (!entered) {
      // 狀態沒轉成功：可能是帳號在這一瞬間被停用，也可能是別人動了狀態。
      if (await lifecycleChanged(db, uid, expectedLifecycleGeneration)) {
        return accountInactive(uid, 'syncing');
      }
      log.warn('onboarding_syncing_not_applied', { user_id: uid });
      return { userId: uid, result: BOOTSTRAP_RESULT.RETRY, detail: 'syncing_state_not_applied' };
    }

    // ---- 0. ★ F04：**在任何 WHOOP 觀測之前**捕捉授權快照 --------------
    //
    // 這是整個修正的核心，而且順序本身就是修正：
    //
    //   舊的做法是在 sync / probe **跑完之後**才去讀一次目前的授權世代，
    //   然後用那個值去標記這些觀測。使用者只要在中間重新授權一次，
    //   用世代 N 觀測到的「睡眠可讀」就會被貼上 N+1 的標籤 ——
    //   而 setReadyIfEligible 看到的正是「目前世代的 ACCESSIBLE」，
    //   於是一個剛剛才撤掉睡眠權限的人被宣告 READY。
    //
    // 現在：憑證與世代來自**同一次列讀取**（db.getTokens），在所有觀測
    // 之前取得，並且在整輪執行中不變。之後的每一個判定都貼這個被捕捉的
    // 世代，永遠不會有「事後才決定這些觀測屬於誰」這件事。
    const authorization = await db.getTokens(uid).catch(() => null);
    const expectedAuthGeneration = authorization?.authGeneration ?? null;
    if (!authorization?.accessToken || !Number.isInteger(expectedAuthGeneration)) {
      log.warn('onboarding_no_auth_snapshot', { user_id: uid });
      // 這一輪的授權快照是「沒有（可用的）token 列」。圍欄用 IS NULL 把它
      // 釘在同一個事實上：如果現在已經有授權了，這個結論就不是我們的了。
      return failOrRetry({
        db, uid, now: at(), notify, detail: 'no_auth_generation',
        expectedAuthGeneration: null,
      });
    }

    // client 被**綁死**在這次授權上：任何一次從 DB 撿到別的世代的 token
    // 都會直接拋 STALE_AUTHORIZATION，而不是安靜地換一組憑證繼續跑。
    const whoop = makeWhoop({
      db, userId: uid, clientId: env.whoopClientId, clientSecret: env.whoopClientSecret,
      authorization,
    });

    // ---- 1. 初次同步（重用 V1.1 的同步，含 backfill 的第一批 chunk）----
    let results;
    try {
      results = await makeSync({
        db, whoop, userId: uid, timezone: user.timezone,
        expectedLifecycleGeneration, now: at(),
      }).syncAll({ force: true });
    } catch (err) {
      if (isAccountInactiveError(err)) return accountInactive(uid, 'sync');
      if (isStaleAuthorizationError(err)) return staleAuthorization(uid, 'sync');
      // syncAll 本身保證不拋，這是最後一道
      log.error('onboarding_sync_unexpected', { user_id: uid, error: describeError(err) });
      return failOrRetry({
        db, uid, now: at(), notify, detail: describeError(err),
        expectedAuthGeneration, expectedLifecycleGeneration,
      });
    }
    // 世代已經換掉 → 這些觀測不屬於任何一個我們可以宣告的授權。
    // 必須擋在 syncUsable 之前：stale 不是 'failed'，syncUsable 會放它過去。
    if (results.some((r) => r?.status === 'stale_authorization')) {
      return staleAuthorization(uid, 'sync');
    }
    if (results.some((r) => r?.status === 'account_inactive')) {
      return accountInactive(uid, 'sync');
    }
    if (!syncUsable(results)) {
      log.warn('onboarding_sync_incomplete', {
        user_id: uid, failed: results.filter((r) => r?.status === 'failed').map((r) => r.resource),
      });
      return failOrRetry({
        db, uid, now: at(), notify, detail: 'initial_sync_failed',
        expectedAuthGeneration, expectedLifecycleGeneration,
      });
    }

    // ---- 2. capability 盤點（失敗不寫任何結論）----
    let probed;
    try {
      probed = await probe({
        db, whoop, userId: uid, timezone: user.timezone,
        days: ONBOARDING.CAPABILITY_PROBE_DAYS,
        expectedLifecycleGeneration, now: at(),
      });
    } catch (err) {
      // 世代競態不是 probe 失敗。probeCapabilities 只在**完全成功**時才寫
      // capability，所以走到這裡代表什麼都沒被寫進去 —— 正是我們要的。
      if (isAccountInactiveError(err)) return accountInactive(uid, 'probe');
      if (isStaleAuthorizationError(err)) return staleAuthorization(uid, 'probe');
      log.warn('onboarding_probe_failed', { user_id: uid, error: describeError(err) });
      return failOrRetry({
        db, uid, now: at(), notify, detail: 'capability_probe_failed',
        expectedAuthGeneration, expectedLifecycleGeneration,
      });
    }

    // ---- 3. ★ F05 / RC2 F04：把權限判定**綁在目前的授權世代**上 --------
    //
    // 「sleep 可讀」只有在它被驗證的那一次授權底下才有意義。使用者重新授權
    // 而這次沒勾睡眠權限之後，舊判定完全不能用 —— 所以判定與世代一起耐久，
    // READY 的原子轉移再要求「必要資源的判定屬於目前世代」。
    //
    // 暫時性失敗（429 / 5xx / 逾時）**不寫任何判定**：那不是結論，是雜訊。
    const missing = missingScopes({ syncResults: results, scopeErrors: probed?.scopeErrors ?? [] });
    const transient = new Set(results.filter((r) => r?.status === 'failed').map((r) => String(r.resource)));
    const verdicts = [];
    for (const r of ONBOARDING.RESOURCES ?? SYNC_RESOURCES) {
      if (transient.has(r)) continue;          // 暫時性失敗 → 不下結論
      verdicts.push({
        resource: r,
        status: missing.includes(r) ? RESOURCE_ACCESS_STATUS.UNAUTHORIZED : RESOURCE_ACCESS_STATUS.ACCESSIBLE,
      });
    }
    // 寫入時**在 SQL 裡**再證明一次「捕捉到的世代仍然是目前世代」。
    // 觀測全部結束之後、判定寫進去之前，仍然有一個空隙可以被重新授權塞進來 ——
    // 這個 CAS 就是那個空隙的封口：條件不成立就一列都不寫。
    const recorded = await db.recordResourceAccess(uid, verdicts, {
      expectedAuthGeneration, expectedLifecycleGeneration, now: at(),
    });
    if (recorded && recorded.ok === false) {
      // 判定沒寫成：分清楚是授權換了還是帳號啟用期換了。
      if (await lifecycleChanged(db, uid, expectedLifecycleGeneration)) {
        return accountInactive(uid, 'record_access');
      }
      return staleAuthorization(uid, 'record_access');
    }

    const verdict = scopeVerdict(missing);
    if (!verdict.ok) {
      // ★ F04：這是一個**以授權為前提的負面結論**。寫的時候要證明它講的
      // 還是目前那次授權 —— 否則一個在世代 N 得出「缺睡眠權限」的舊 bootstrap
      // 會把剛剛才重新授權好的人打成 ACTION_REQUIRED 並發出錯誤的提示。
      const marked = await db.setOnboardingState(uid, ONBOARDING_STATE.ACTION_REQUIRED, {
        from: [ONBOARDING_STATE.SYNCING, ONBOARDING_STATE.WHOOP_AUTHORIZED],
        failureCode: ONBOARDING_FAILURE.WHOOP_SCOPE_INCOMPLETE,
        failureDetail: `missing:${verdict.lacking.join(',')}`,
        expectedAuthGeneration,
        expectedLifecycleGeneration, requireActiveLifecycle: true,
        now: at(),
      });
      if (!marked) {
        // 轉移沒成立。分清楚三種原因：帳號啟用期、授權世代、其他。
        if (await lifecycleChanged(db, uid, expectedLifecycleGeneration)) {
          return accountInactive(uid, 'scope_incomplete');
        }
        if (await generationChanged(db, uid, expectedAuthGeneration)) {
          return staleAuthorization(uid, 'scope_incomplete');
        }
        log.warn('onboarding_scope_incomplete_not_applied', { user_id: uid });
        return { userId: uid, result: BOOTSTRAP_RESULT.RETRY, detail: 'scope_state_not_applied' };
      }
      if (notify) await safeNotify(notify, uid, 'scope_incomplete');
      log.warn('onboarding_scope_incomplete', { user_id: uid, lacking: verdict.lacking });
      return { userId: uid, result: BOOTSTRAP_RESULT.ACTION_REQUIRED, lacking: verdict.lacking };
    }

    // ---- 4. ★ F04：**原子**地轉成 READY ------------------------------
    //
    // 不是「讀完前提 → 之後盲目寫 READY」：所有關鍵前提都在同一句 UPDATE 的
    // WHERE 裡重新驗證一次（包含目前狀態仍然是允許的來源狀態），所以
    // 在讀與寫之間被撤銷的綁定／token／身分都會讓這次轉移失敗。
    const ready = await db.setReadyIfEligible({
      userId: uid,
      from: [ONBOARDING_STATE.SYNCING, ONBOARDING_STATE.WHOOP_AUTHORIZED],
      requiredResources: ONBOARDING.REQUIRED_SCOPES,
      expectedLifecycleGeneration,
      now: at(),
    });
    if (!ready.ok) {
      if (await lifecycleChanged(db, uid, expectedLifecycleGeneration)) {
        return accountInactive(uid, 'ready');
      }
      // 先分辨「授權換了」與「真的不符合資格」。前者不是失敗，不可以
      // 累積失敗次數、也不可以走到 ACTION_REQUIRED。
      if (await generationChanged(db, uid, expectedAuthGeneration)) {
        return staleAuthorization(uid, 'ready');
      }
      const why = await evaluateReadiness({ db, userId: uid });
      log.warn('onboarding_ready_rejected', {
        user_id: uid, reason: ready.reason, missing: why.missing,
      });
      return failOrRetry({
        db, uid, now: at(), notify, expectedAuthGeneration, expectedLifecycleGeneration,
        detail: `ready_rejected:${ready.reason}:${why.missing.join(',')}`,
      });
    }
    if (notify) await safeNotify(notify, uid, 'ready');
    log.info('onboarding_ready', { user_id: uid });
    return { userId: uid, result: BOOTSTRAP_RESULT.READY, syncResults: results };
  } catch (err) {
    // 任何一層漏上來的世代競態都不是「未預期的錯誤」。
    if (isAccountInactiveError(err)) return accountInactive(uid, 'unhandled');
    if (isStaleAuthorizationError(err)) return staleAuthorization(uid, 'unhandled');
    log.error('onboarding_bootstrap_unhandled', { user_id: uid, error: describeError(err) });
    return { userId: uid, result: BOOTSTRAP_RESULT.RETRY, error: describeError(err) };
  } finally {
    await db.releaseLock(lockName, owner).catch(() => {});
  }
}

/**
 * ★ F04：以過期授權開始的這一輪，統一的收尾。
 *
 * 刻意什麼都不做 —— 不寫判定、不改狀態、不通知、不累積失敗。
 * 這一輪就當作沒發生過；新的世代由 callback 的 onAuthorized 或排程器
 * 重新跑一輪，那一輪會在正確的授權下產生正確的結論。
 */
function staleAuthorization(uid, stage) {
  log.warn('onboarding_stale_authorization', { user_id: uid, stage });
  return { userId: uid, result: BOOTSTRAP_RESULT.STALE_AUTHORIZATION, stage };
}

/**
 * ★ v17：帳號是不是已經不能被這一輪繼續處理了。
 *
 * 兩種都算：不再是 ACTIVE，或啟用世代已經往前走（停用→再啟用的 ABA）。
 * 只用來**選一條不寫入的路**，不授權任何寫入 —— 真正的圍欄在 SQL 裡。
 */
async function lifecycleChanged(db, uid, expectedLifecycleGeneration) {
  const user = await db.getUser(uid).catch(() => null);
  if (!user) return true;
  if (user.status !== USER_STATUS.ACTIVE) return true;
  if (!Number.isInteger(expectedLifecycleGeneration)) return false;
  return user.lifecycleGeneration !== expectedLifecycleGeneration;
}

/** 帳號層級的停止：什麼都不寫、不通知、不累積失敗。 */
function accountInactive(uid, stage) {
  log.info('onboarding_account_inactive', { user_id: uid, stage });
  return { userId: uid, result: BOOTSTRAP_RESULT.ACCOUNT_INACTIVE, stage };
}

/** 目前的授權世代是不是已經不是我們這一輪捕捉到的那一個。 */
async function generationChanged(db, uid, expectedAuthGeneration) {
  if (!Number.isInteger(expectedAuthGeneration)) return false;
  const current = await db.getTokens(uid).catch(() => null);
  return Boolean(current) && current.authGeneration !== expectedAuthGeneration;
}

/**
 * READY 的**確定性**條件。刻意不包含「分析已經成熟」——
 * 一個剛買手錶的人本來就沒有 30 天基準，那不是上線沒完成。
 */
export async function evaluateReadiness({ db, userId }) {
  const uid = requireUserId(userId, 'evaluateReadiness');
  const missing = [];

  const user = await db.getUser(uid);
  if (!user || user.status !== 'ACTIVE') missing.push('user_active');
  // ★ F01：時區看的是**明確的確認證據**，不是字串長什麼樣。
  // `UTC` 是一個完全合法的時區 —— 住在 UTC 的人選了 UTC 就該算數；
  // 而一個還沒選過的新使用者即使欄位是 UTC 也不算。
  const onboarding = await db.getOnboarding(uid).catch(() => null);
  if (!onboarding?.timezoneConfirmedAt) missing.push('timezone_confirmed');
  if (!user?.timezone) missing.push('timezone');

  const chatId = await db.getActiveChatIdForUser(uid).catch(() => null);
  if (!chatId) missing.push('telegram_binding');

  const tokens = await db.getTokens(uid).catch(() => null);
  if (!tokens?.accessToken) missing.push('whoop_tokens');
  // ★ RC2 / F02：身分必須可信。token 列上沒有身分就是沒有身分 ——
  // 「有一組 token」不能證明它屬於這個人歷史上的 WHOOP 帳號。
  // 有身分時再檢查它與 canonical 歷史身分是否衝突。
  if (!tokens?.whoopUserId) missing.push('whoop_identity');
  else if (typeof db.getHistoricalWhoopUserIds === 'function') {
    const historical = await db.getHistoricalWhoopUserIds(uid).catch(() => null);
    if (historical === null) missing.push('whoop_identity_unreadable');
    else if (historical.length > 1) missing.push('whoop_identity_conflict');
    else if (historical.length === 1 && historical[0] !== String(tokens.whoopUserId)) {
      missing.push('whoop_identity_conflict');
    }
  }

  // 必要資源的權限判定必須屬於**目前**的授權世代
  const generation = typeof db.getAuthGeneration === 'function' ? await db.getAuthGeneration(uid) : null;
  const access = typeof db.getResourceAccess === 'function'
    ? await db.getResourceAccess(uid).catch(() => []) : [];
  for (const r of ONBOARDING.REQUIRED_SCOPES) {
    const row = access.find((a) => a.resource === r);
    if (!row || row.authGeneration !== generation) missing.push(`access_${r}_unknown`);
    else if (row.status !== RESOURCE_ACCESS_STATUS.ACCESSIBLE) missing.push(`access_${r}_unauthorized`);
  }

  // 同步狀態要真的存在（代表初次同步跑過），而且沒有全軍覆沒。
  const syncState = await db.getAllSyncState(uid).catch(() => []);
  if (!syncState.length) missing.push('sync_state');

  // capability 盤點跑過（有列就算；內容可以是 UNAVAILABLE，那是誠實的結論）
  const caps = await db.getCapabilities(uid).catch(() => null);
  if (!caps || !Object.keys(caps).length) missing.push('capabilities');

  return { ready: missing.length === 0, missing };
}

/**
 * 一般性失敗（暫時性同步故障、capability 故障、READY 前提不足…）的收尾。
 *
 * ## ★ F04-FG-NEW-01：終局升級必須被世代圍住，而且不可以相信快取的次數
 *
 * 這裡曾經有兩個各自獨立、但湊在一起會憑空製造一次失敗的問題：
 *
 *   1. 它用 bootstrap **開跑時**讀到的 onboarding 快照算嘗試次數。
 *      使用者中途重新授權時，callback 會把額度歸零 —— 而快照完全看不到
 *      那件事，於是舊 worker 仍然認為「已經第 5 次了」。
 *   2. 它寫 ACTION_REQUIRED / BOOTSTRAP_FAILED 時沒有任何世代條件。
 *
 * 結果：一個剛剛才授權成功、額度全新（attempts = 0）的人，被一個屬於
 * **上一次授權**的 worker 用**上一次授權的故障**宣告上線失敗，還收到通知。
 *
 * 現在三個前提都在同一句 UPDATE 的 WHERE 裡於寫入當下求值（見
 * failBootstrapIfExhausted）。這裡**刻意不做**「先檢查世代有沒有變、再寫」——
 * 那只是把競態窗口縮小，沒有消除：授權可以在檢查與寫入之間改變。
 * 被圍欄擋下來才是結論，不是事前的預測。
 *
 * 通知也因此移到**確認寫入成功之後**：沒有真的完成那次轉移的 worker，
 * 一則訊息都不准送。
 */
async function failOrRetry({
  db, uid, now, notify, detail,
  expectedAuthGeneration = null, expectedLifecycleGeneration = null,
}) {
  const outcome = await db.failBootstrapIfExhausted({
    userId: uid,
    from: [ONBOARDING_STATE.SYNCING, ONBOARDING_STATE.WHOOP_AUTHORIZED],
    failureCode: ONBOARDING_FAILURE.BOOTSTRAP_FAILED,
    failureDetail: detail,
    expectedAuthGeneration,
    // ★ v17：終局失敗也是一個「以帳號啟用為前提」的結論。
    expectedLifecycleGeneration,
    maxAttempts: ONBOARDING.MAX_BOOTSTRAP_ATTEMPTS,
    now,
  });

  if (outcome.ok) {
    // 只有真的完成了這次轉移才通知。
    if (notify) await safeNotify(notify, uid, 'bootstrap_failed');
    return { userId: uid, result: BOOTSTRAP_RESULT.ACTION_REQUIRED, detail };
  }
  if (outcome.reason === 'account_inactive') {
    // 帳號被停用，或已經換過一段啟用期。這一輪的故障不屬於現在這個帳號。
    return accountInactive(uid, 'fail_or_retry');
  }
  if (outcome.reason === 'stale_authorization') {
    // 這一輪的故障屬於一次已經不存在的授權。不宣告失敗、不通知、不累積。
    return staleAuthorization(uid, 'fail_or_retry');
  }
  // 還沒到上限（或狀態已經被別人動過）：留在 SYNCING，下一輪排程再接手。
  return {
    userId: uid, result: BOOTSTRAP_RESULT.RETRY, attempts: outcome.attempts, detail,
  };
}

async function safeNotify(notify, userId, kind) {
  try {
    await notify(userId, kind);
  } catch (err) {
    // 通知失敗絕不影響上線狀態：狀態已經耐久了，使用者下次 /start 也看得到。
    log.warn('onboarding_notify_failed', { user_id: userId, kind, error: describeError(err) });
  }
}

/**
 * 排程器的接手入口：把還卡在 WHOOP_AUTHORIZED / SYNCING 的使用者往前推。
 * **有上限**，而且永遠不拋錯。
 */
export async function resumeOnboardingBootstraps({
  db, env, now = () => new Date(), deps = {}, limit = ONBOARDING.MAX_BOOTSTRAPS_PER_RUN,
}) {
  let pending = [];
  try {
    pending = await db.listOnboardingInState(
      [ONBOARDING_STATE.WHOOP_AUTHORIZED, ONBOARDING_STATE.SYNCING], { limit },
    );
  } catch (err) {
    log.warn('onboarding_resume_list_failed', { error: describeError(err) });
    return [];
  }
  const out = [];
  for (const p of pending) {
    try {
      out.push(await runOnboardingBootstrap({ db, userId: p.userId, env, now, deps }));
    } catch (err) {
      log.error('onboarding_resume_failed', { user_id: p.userId, error: describeError(err) });
      out.push({ userId: p.userId, result: BOOTSTRAP_RESULT.RETRY, error: describeError(err) });
    }
  }
  return out;
}
