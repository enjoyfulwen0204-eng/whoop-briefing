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

export const BOOTSTRAP_RESULT = Object.freeze({
  READY: 'READY',
  RETRY: 'RETRY',
  ACTION_REQUIRED: 'ACTION_REQUIRED',
  SKIPPED: 'SKIPPED',
  BUSY: 'BUSY',
});

/** 這一輪同步的結果，足夠讓系統「可用」嗎。 */
export function syncUsable(results = []) {
  if (!Array.isArray(results) || !results.length) return false;
  // 每個資源要嘛成功 / 節流，要嘛是「這個帳號沒有授權這個範圍」
  // （syncAll 的 `scope_missing`）—— 後者是使用者的帳號狀態，不是我們的
  // 故障，不該讓人永遠卡在上線中。只有 `failed` 才算真的失敗。
  return results.every((r) => r?.status !== 'failed');
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
    try {
      await probe({
        db, whoop, userId: uid, timezone: user.timezone,
        days: ONBOARDING.CAPABILITY_PROBE_DAYS, now: at(),
      });
    } catch (err) {
      log.warn('onboarding_probe_failed', { user_id: uid, error: describeError(err) });
      return failOrRetry({ db, uid, onboarding, now: at(), notify, detail: 'capability_probe_failed' });
    }

    // ---- 3. READY 判定 ----
    const verdict = await evaluateReadiness({ db, userId: uid });
    if (!verdict.ready) {
      log.warn('onboarding_not_ready', { user_id: uid, missing: verdict.missing });
      return failOrRetry({ db, uid, onboarding, now: at(), notify, detail: `not_ready:${verdict.missing.join(',')}` });
    }

    const moved = await db.setOnboardingState(uid, ONBOARDING_STATE.READY, {
      from: [ONBOARDING_STATE.SYNCING, ONBOARDING_STATE.WHOOP_AUTHORIZED],
      ready: true, failureCode: null, failureDetail: null, now: at(),
    });
    if (moved && notify) await safeNotify(notify, uid, 'ready');
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
  if (!user?.timezone || user.timezone === 'UTC') missing.push('timezone');

  const chatId = await db.getActiveChatIdForUser(uid).catch(() => null);
  if (!chatId) missing.push('telegram_binding');

  const tokens = await db.getTokens(uid).catch(() => null);
  if (!tokens?.accessToken) missing.push('whoop_tokens');
  if (!tokens?.whoopUserId) missing.push('whoop_identity');

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
