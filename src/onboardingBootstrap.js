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
import { ONBOARDING_STATE, ONBOARDING_FAILURE } from './schema.js';
import { createSync } from './sync.js';
import { probeCapabilities } from './capabilities.js';
import { createWhoopClient } from './whoop.js';
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

export const BOOTSTRAP_RESULT = Object.freeze({
  READY: 'READY',
  RETRY: 'RETRY',
  ACTION_REQUIRED: 'ACTION_REQUIRED',
  SKIPPED: 'SKIPPED',
  BUSY: 'BUSY',
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

    await db.recordBootstrapAttempt(uid, { now: at() });
    await db.setOnboardingState(uid, ONBOARDING_STATE.SYNCING, {
      from: [ONBOARDING_STATE.WHOOP_AUTHORIZED, ONBOARDING_STATE.SYNCING],
      syncStarted: true, now: at(),
    });

    const whoop = makeWhoop({
      db, userId: uid, clientId: env.whoopClientId, clientSecret: env.whoopClientSecret,
    });

    // ---- 1. 初次同步（重用 V1.1 的同步，含 backfill 的第一批 chunk）----
    let results;
    try {
      results = await makeSync({ db, whoop, userId: uid, timezone: user.timezone, now: at() })
        .syncAll({ force: true });
    } catch (err) {
      // syncAll 本身保證不拋，這是最後一道
      log.error('onboarding_sync_unexpected', { user_id: uid, error: describeError(err) });
      return failOrRetry({ db, uid, onboarding, now: at(), notify, detail: describeError(err) });
    }
    if (!syncUsable(results)) {
      log.warn('onboarding_sync_incomplete', {
        user_id: uid, failed: results.filter((r) => r?.status === 'failed').map((r) => r.resource),
      });
      return failOrRetry({ db, uid, onboarding, now: at(), notify, detail: 'initial_sync_failed' });
    }

    // ---- 2. capability 盤點（失敗不寫任何結論）----
    let probed;
    try {
      probed = await probe({
        db, whoop, userId: uid, timezone: user.timezone,
        days: ONBOARDING.CAPABILITY_PROBE_DAYS, now: at(),
      });
    } catch (err) {
      log.warn('onboarding_probe_failed', { user_id: uid, error: describeError(err) });
      return failOrRetry({ db, uid, onboarding, now: at(), notify, detail: 'capability_probe_failed' });
    }

    // ---- 3. ★ F05：最低權限。沒有權限 ≠ 沒有資料 ----------------------
    //
    // 缺的是**必要** scope → 這不是重試能解決的，要使用者回去重新授權並
    // 勾選權限。所以直接轉 ACTION_REQUIRED（不耗重試次數），並給明確訊息。
    const missing = missingScopes({ syncResults: results, scopeErrors: probed?.scopeErrors ?? [] });
    const verdict = scopeVerdict(missing);
    if (!verdict.ok) {
      await db.setOnboardingState(uid, ONBOARDING_STATE.ACTION_REQUIRED, {
        from: [ONBOARDING_STATE.SYNCING, ONBOARDING_STATE.WHOOP_AUTHORIZED],
        failureCode: ONBOARDING_FAILURE.WHOOP_SCOPE_INCOMPLETE,
        failureDetail: `missing:${verdict.lacking.join(',')}`, now: at(),
      });
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
      now: at(),
    });
    if (!ready.ok) {
      const why = await evaluateReadiness({ db, userId: uid });
      log.warn('onboarding_ready_rejected', {
        user_id: uid, reason: ready.reason, missing: why.missing,
      });
      return failOrRetry({
        db, uid, onboarding, now: at(), notify,
        detail: `ready_rejected:${ready.reason}:${why.missing.join(',')}`,
      });
    }
    if (notify) await safeNotify(notify, uid, 'ready');
    log.info('onboarding_ready', { user_id: uid });
    return { userId: uid, result: BOOTSTRAP_RESULT.READY, syncResults: results };
  } catch (err) {
    log.error('onboarding_bootstrap_unhandled', { user_id: uid, error: describeError(err) });
    return { userId: uid, result: BOOTSTRAP_RESULT.RETRY, error: describeError(err) };
  } finally {
    await db.releaseLock(lockName, owner).catch(() => {});
  }
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
  // 身分：token 列上有就算數；沒有的話看健康資料上的 whoop_user_id
  // （R2-M-01：舊的授權流程從來沒寫過 token 列的身分，但資料每一列都帶著）。
  if (!tokens?.whoopUserId) {
    const historical = typeof db.getHistoricalWhoopUserIds === 'function'
      ? await db.getHistoricalWhoopUserIds(uid).catch(() => [])
      : [];
    if (!historical.length) missing.push('whoop_identity');
  }

  // 同步狀態要真的存在（代表初次同步跑過），而且沒有全軍覆沒。
  const syncState = await db.getAllSyncState(uid).catch(() => []);
  if (!syncState.length) missing.push('sync_state');

  // capability 盤點跑過（有列就算；內容可以是 UNAVAILABLE，那是誠實的結論）
  const caps = await db.getCapabilities(uid).catch(() => null);
  if (!caps || !Object.keys(caps).length) missing.push('capabilities');

  return { ready: missing.length === 0, missing };
}

async function failOrRetry({ db, uid, onboarding, now, notify, detail }) {
  const attempts = (onboarding?.bootstrapAttempts ?? 0) + 1;
  if (attempts >= ONBOARDING.MAX_BOOTSTRAP_ATTEMPTS) {
    await db.setOnboardingState(uid, ONBOARDING_STATE.ACTION_REQUIRED, {
      from: [ONBOARDING_STATE.SYNCING, ONBOARDING_STATE.WHOOP_AUTHORIZED],
      failureCode: ONBOARDING_FAILURE.BOOTSTRAP_FAILED, failureDetail: detail, now,
    });
    if (notify) await safeNotify(notify, uid, 'bootstrap_failed');
    return { userId: uid, result: BOOTSTRAP_RESULT.ACTION_REQUIRED, detail };
  }
  // 留在 SYNCING：下一輪排程會再接手。
  return { userId: uid, result: BOOTSTRAP_RESULT.RETRY, attempts, detail };
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
