#!/usr/bin/env node
/**
 * Telegram 入站 webhook（正式環境的傳輸方式）。
 *
 * ## 為什麼是 webhook 而不是長輪詢
 *
 * getUpdates 需要一個**永遠活著**的 process，在 Render 上那是付費的
 * Background Worker。webhook 只需要在「有人傳訊息」的時候醒著，所以可以跑在
 * 免費的 Web Service 上。代價是免費方案會睡著，第一則訊息可能要等幾十秒的
 * 冷啟動 —— 這是刻意接受的取捨。
 *
 * ## 只換傳輸，不換處理
 *
 * 「收到一則 update 之後要做什麼」完全沒有改變：那一整段（原子認領、
 * PROCESSING 圍欄、動作與收據同一個交易、送出前的綁定守衛、標記完成）
 * 在 updateProcessor.js 裡，polling 與 webhook 共用同一份。
 *
 *     Telegram → POST /telegram/webhook → processUpdate() → 同一條處理鏈
 *
 * ## Telegram 會重送，所以 ack 的語義很重要
 *
 * 回 2xx = 「這一則我收下了，不要再送」。回其他 = Telegram 稍後重送。
 *
 * 所以這裡**只有在 update 真的被耐久地處理掉（或確認是重複）之後才回 200**。
 * 內部暫時性失敗一律回 503：讓 Telegram 重送，再靠耐久去重保證重送不會產生
 * 第二次副作用。反過來做（先回 200 再處理）會在 free instance 被回收時
 * 直接把訊息弄丟。
 *
 * 唯一的例外是**送達結果不明**（逾時／連線被重置）：動作已經耐久提交，只是
 * 不知道 Telegram 有沒有收到回覆。那一種回 200 —— 自動重送有機會讓使用者
 * 收到兩則一樣的健康建議，而那比偶爾漏掉一則更糟。
 *
 * ## 冷啟動安全
 *
 * 沒有任何正確性依賴記憶體：認領、動作收據、offset 全都在 Turso。
 * 睡著、重啟、重新部署、醒來後兩個請求同時進來 —— 都由 DB 的
 * 原子認領決定誰贏，輸的那個回 503 讓 Telegram 稍後重送。
 */

import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { randomUUID } from 'node:crypto';

import { loadDotEnvIfPresent, loadEnv, TELEGRAM_BOT, WHOOP_WEBHOOK } from '../config.js';
import { createDb } from '../db.js';
import { createCoach } from '../coach.js';
import { createTelegramApi } from './api.js';
import { createRouter } from './router.js';
import { createSendReply } from './index.js';
import { handleLinkAttempt } from './link.js';
import { createUpdateProcessor, UPDATE_OUTCOME, isAcknowledgeable } from './updateProcessor.js';
import { log, describeError } from '../logger.js';
import { BRIEFING_TRIGGER } from '../briefingTriggerAuth.js';
import { createBriefingEndpoint } from '../briefingEndpoint.js';
import { runBriefing } from '../index.js';
import { createWhoopWebhookIngest, statusForIngest } from '../whoopWebhookIngest.js';
import { createWhoopOAuthCallback, OAUTH_CALLBACK_PATH, renderScreen } from '../whoopOAuthCallback.js';
import { handleUnlinkedMessage, handleOnboardingMessage, MESSAGES as ONBOARDING_MESSAGES } from '../onboarding.js';
import { runOnboardingBootstrap } from '../onboardingBootstrap.js';
import { exchangeCode, fetchWhoopUserId } from '../whoop.js';

/**
 * 定長時間比較。長度不同直接回 false（長度本身不是祕密）。
 *
 * 用 timingSafeEqual 而不是 `===`：後者會在第一個不同的位元組就返回，
 * 理論上可以用回應時間一個位元組一個位元組地猜出祕密。
 */
export function secretMatches(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string') return false;
  if (!provided || !expected) return false;
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * 讀取請求內容，超過上限就中斷。
 *
 * 上限在**讀取過程中**檢查而不是讀完再看 —— 免費方案的記憶體很小，
 * 一個惡意的無限 body 不可以有機會被整個讀進來。
 */
export function readBody(req, { limit = TELEGRAM_BOT.WEBHOOK_MAX_BODY_BYTES } = {}) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        // 停止累積並**立刻回報**，但不要在這裡砍連線 —— 砍了對方就只會看到
        // ECONNRESET 而不是 413。連線由呼叫端在回應送出**之後**關掉。
        chunks.length = 0;
        if (typeof req.pause === 'function') req.pause();
        finish({ ok: false, reason: 'too_large' });
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => finish({ ok: true, body: Buffer.concat(chunks).toString('utf8') }));
    req.on('error', () => finish({ ok: false, reason: 'stream_error' }));
    req.on('aborted', () => finish({ ok: false, reason: 'aborted' }));
  });
}

/** bootstrap 的通知種類 → 使用者看得到的文字。 */
export function onboardingNotice(kind) {
  if (kind === 'ready') return ONBOARDING_MESSAGES.ready();
  if (kind === 'bootstrap_failed') return ONBOARDING_MESSAGES.actionRequired('BOOTSTRAP_FAILED');
  if (kind === 'scope_incomplete') return ONBOARDING_MESSAGES.actionRequired('WHOOP_SCOPE_INCOMPLETE');
  return ONBOARDING_MESSAGES.statusSyncing();
}

/** 這個物件像不像一則 Telegram Update（只檢查到不會讓下游爆掉為止）。 */
export function looksLikeUpdate(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v)
    && Number.isFinite(Number(v.update_id));
}

/** 排程 HMAC 密鑰的最低長度（與 briefingEndpoint 的檢查一致）。 */
export const MIN_TRIGGER_SECRET_BYTES = 32;

/**
 * 排程路由的設定狀態。
 *
 * ★ 三種結果都**不會**讓服務起不來。入站 Telegram 是獨立的職責，不該因為
 * 排程設定不完整或密鑰太弱而整個掛掉 —— 那等於用一個次要功能的設定錯誤
 * 換掉主要功能的可用性。密鑰太弱時排程維持關閉（fail closed），入站照跑。
 */
export function schedulerConfiguration(env, triggerSecret) {
  const present = [env?.whoopClientId, env?.whoopClientSecret, env?.telegramChatId, triggerSecret];
  const secretStrong = typeof triggerSecret === 'string'
    && Buffer.byteLength(triggerSecret) >= MIN_TRIGGER_SECRET_BYTES;
  if (present.every(Boolean) && secretStrong) return { enabled: true, state: 'enabled' };
  if (present.every(Boolean) && !secretStrong) {
    // 設定齊全但密鑰不合格 —— 這是設定錯誤，不是「沒設定」。分開講才修得動。
    return { enabled: false, state: 'weak_secret' };
  }
  return { enabled: false, state: present.some(Boolean) ? 'incomplete' : 'disabled' };
}

/**
 * WHOOP webhook 攝取的啟用閘門（V1.2 Phase 1）。
 *
 * ## 預設關閉，而且需要兩個條件同時成立
 *
 *   1. `WHOOP_WEBHOOK_ENABLED` 明確打開（只認 '1' / 'true' / 'yes'）
 *   2. `WHOOP_CLIENT_SECRET` 存在（沒有它就**不可能**驗證官方簽章）
 *
 * 第 2 條不是設定檢查，是安全邊界：缺了 client secret，驗簽只有兩種可能
 * 的實作 —— 全部拒絕，或全部放行。既然全部拒絕等於沒有這條路由，
 * 那就乾脆讓它不存在，而不是留一個永遠 401 的端點對外宣告「這裡有東西」。
 *
 * ## 為什麼旗標要「明確打開」
 *
 * 用 `Boolean(process.env.X)` 的話，`WHOOP_WEBHOOK_ENABLED=false` 會是 true。
 * 這種端點不可以因為一個字串寫法就意外上線。
 */
export function whoopWebhookConfiguration({ enabledFlag, clientSecret } = {}) {
  const enabled = ['1', 'true', 'yes', 'on'].includes(String(enabledFlag ?? '').trim().toLowerCase());
  if (!enabled) return { enabled: false, state: 'disabled' };
  if (typeof clientSecret !== 'string' || !clientSecret) {
    return { enabled: false, state: 'missing_client_secret' };
  }
  return { enabled: true, state: 'enabled' };
}

/**
 * 建立 HTTP 請求處理器。
 *
 * 刻意與「開 port」分開：測試可以直接餵假的 req/res，不需要真的綁一個
 * 通訊埠，也就不需要在測試裡處理埠號衝突。
 */
export function createWebhookHandler({
  processUpdate,
  secret,
  briefingEndpoint = null,
  /**
   * WHOOP webhook 攝取（V1.2 Phase 1）。
   *
   * null = 這條路由**完全不存在**（回 404，與任何未知路徑一樣）。
   * 正式環境預設就是 null —— 沒有啟用旗標、或沒有 client secret 可以驗簽時，
   * 不可以留下一個「存在但永遠 401」的端點：那等於對外宣告這裡有東西。
   */
  whoopIngest = null,
  /**
   * WHOOP OAuth 回呼（V1.2 Phase 3.5）。
   *
   * null = 這條路由不存在（回 404）。沒有 WHOOP client id/secret 可以換
   * token 時就是 null —— 不留一個「存在但永遠失敗」的端點。
   */
  oauthCallback = null,
  oauthCallbackPath = OAUTH_CALLBACK_PATH,
  whoopWebhookPath = WHOOP_WEBHOOK.PATH,
  whoopMaxBodyBytes = WHOOP_WEBHOOK.MAX_BODY_BYTES,
  webhookPath = TELEGRAM_BOT.WEBHOOK_PATH,
  healthPath = TELEGRAM_BOT.HEALTH_PATH,
  maxBodyBytes = TELEGRAM_BOT.WEBHOOK_MAX_BODY_BYTES,
  schedulerConfigured = Boolean(briefingEndpoint),
  schedulerState = schedulerConfigured ? 'enabled' : 'disabled',
}) {
  /** OAuth 回呼回的是給人看的網頁（其餘端點一律 JSON）。 */
  const sendHtml = (res, status, html) => {
    res.writeHead(status, {
      'content-type': 'text/html; charset=utf-8',
      'content-length': Buffer.byteLength(html),
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      // 這一頁沒有任何腳本、樣式是內嵌的；把能關的都關掉。
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      'x-content-type-options': 'nosniff',
    });
    res.end(html);
  };

  const send = (res, status, obj) => {
    const text = JSON.stringify(obj);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(text),
      'cache-control': 'no-store',
    });
    res.end(text);
  };

  return async function handle(req, res) {
    const url = String(req.url ?? '');
    const path = url.split('?')[0];

    // ---- 健康檢查：Render 用來判斷服務活著。完全不碰 DB、不吐任何內部資訊 ----
    if (path === healthPath) {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return send(res, 405, { ok: false });
      }
      return send(res, 200, {
        ok: true, service: 'telegram-webhook', scheduler: schedulerState,
      });
    }

    if (path === BRIEFING_TRIGGER.PATH && !briefingEndpoint) {
      return send(res, 503, { ok: false, error: 'scheduler_unavailable' });
    }
    if (path === BRIEFING_TRIGGER.PATH && briefingEndpoint) {
      if (url !== path) return send(res, 400, { ok: false, error: 'query_not_allowed' });
      if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'method_not_allowed' });
      const schedulerBody = await readBody(req, { limit: BRIEFING_TRIGGER.MAX_BODY_BYTES });
      if (!schedulerBody.ok) {
        return send(res, schedulerBody.reason === 'too_large' ? 413 : 400, { ok: false });
      }
      const result = await briefingEndpoint(req, schedulerBody.body);
      return send(res, result.status, result.body);
    }

    // ---- WHOOP OAuth 回呼（V1.2 Phase 3.5）--------------------------------
    //
    // 使用者的瀏覽器會被 WHOOP 導到這裡，所以它回的是**網頁**而不是 JSON，
    // 而且必須是 GET。這條路沒有自己的祕密：安全性完全來自一次性、
    // 綁死使用者的 state（見 whoopOAuthCallback.js）。
    if (path === oauthCallbackPath) {
      if (!oauthCallback) return send(res, 404, { ok: false });
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        const page = renderScreen('not_found');
        return sendHtml(res, 405, page.html);
      }
      const q = new URLSearchParams(url.includes('?') ? url.slice(url.indexOf('?') + 1) : '');
      let result;
      try {
        result = await oauthCallback({ query: q });
      } catch (err) {
        log.error('oauth_callback_unhandled', { error: describeError(err) });
        const page = renderScreen('error');
        return sendHtml(res, page.status, page.html);
      }
      return sendHtml(res, result.status, result.html);
    }

    // ---- WHOOP webhook（V1.2 Phase 1，正式環境預設關閉）--------------------
    //
    // 與 Telegram 是**完全獨立**的一條路：不同路徑、不同標頭、不同祕密、
    // 不同演算法。兩邊的認證絕不互相接受 —— 一個 Telegram 的 secret token
    // 不可能讓 WHOOP 的簽章驗證通過，反之亦然。
    if (path === whoopWebhookPath) {
      if (!whoopIngest) return send(res, 404, { ok: false });
      if (url !== path) return send(res, 400, { ok: false, error: 'query_not_allowed' });
      if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'method_not_allowed' });

      const whoopBody = await readBody(req, { limit: whoopMaxBodyBytes });
      if (!whoopBody.ok) {
        log.warn('whoop_webhook_body_rejected', { reason: whoopBody.reason });
        if (whoopBody.reason === 'too_large') {
          send(res, 413, { ok: false });
          res.on('finish', () => { if (typeof req.destroy === 'function') req.destroy(); });
          return undefined;
        }
        return send(res, 400, { ok: false });
      }

      let ingestResult;
      try {
        // ⚠️ 傳的是**原始字串**。簽章簽的是原始位元組，parse 再序列化回去
        // 會改變鍵順序與空白，算出來的簽章就對不上。
        ingestResult = await whoopIngest({
          headers: req.headers ?? {}, rawBody: whoopBody.body,
        });
      } catch (err) {
        log.error('whoop_webhook_unhandled', { error: describeError(err) });
        return send(res, 503, { ok: false });
      }
      const status = statusForIngest(ingestResult.outcome);
      return send(res, status, status === 200
        ? { ok: true, outcome: ingestResult.outcome }
        : { ok: false, outcome: ingestResult.outcome });
    }

    if (path !== webhookPath) return send(res, 404, { ok: false });
    if (req.method !== 'POST') return send(res, 405, { ok: false });

    // ---- 認證：在任何業務處理**之前** ----
    //
    // 這個端點是公開可達的，任何人都能 POST。沒有這一關，別人就可以偽造
    // 「某個使用者說了什麼」並讓系統寫進他的 Journal。
    const provided = req.headers?.['x-telegram-bot-api-secret-token'];
    if (!secretMatches(typeof provided === 'string' ? provided : '', secret)) {
      // 不記錄提供了什麼（那可能是對方的猜測，也可能誤記到真的祕密）。
      log.warn('telegram_webhook_unauthorized', {});
      return send(res, 401, { ok: false });
    }

    const body = await readBody(req, { limit: maxBodyBytes });
    if (!body.ok) {
      log.warn('telegram_webhook_body_rejected', { reason: body.reason });
      if (body.reason === 'too_large') {
        send(res, 413, { ok: false });
        // 回應送出之後才切斷：不讓對方繼續灌資料進來，但對方看得到 413。
        res.on('finish', () => { if (typeof req.destroy === 'function') req.destroy(); });
        return undefined;
      }
      return send(res, 400, { ok: false });
    }

    let update;
    try {
      update = JSON.parse(body.body);
    } catch {
      // 刻意不記錄內容本身。
      log.warn('telegram_webhook_bad_json', {});
      return send(res, 400, { ok: false });
    }

    if (!looksLikeUpdate(update)) {
      // 結構不對就沒有東西可以處理，重送也不會變好 → ack 掉。
      log.warn('telegram_webhook_unprocessable', {});
      return send(res, 200, { ok: true, outcome: UPDATE_OUTCOME.INVALID });
    }

    let result;
    try {
      result = await processUpdate(update);
    } catch (err) {
      // processUpdate 本身保證不拋，這是最後一道防線。
      log.error('telegram_webhook_unhandled', { error: describeError(err) });
      return send(res, 503, { ok: false });
    }

    if (!isAcknowledgeable(result.outcome)) {
      // **還沒被耐久地處理掉 → 不可以 ack。**
      // 回 503 讓 Telegram 重送；耐久去重保證重送不會做第二次。
      log.warn('telegram_webhook_retry_requested', {
        update_id: result.updateId, reason: result.reason ?? null,
      });
      return send(res, 503, { ok: false, outcome: result.outcome });
    }
    if (result.outcome === UPDATE_OUTCOME.AMBIGUOUS_DELIVERY) {
      // 動作已經耐久提交了，只是送達結果不明。**要 ack**：讓 Telegram 停止
      // 重送，因為自動重送有機會讓使用者收到兩則一樣的健康建議。
      // 這一則會留在 AMBIGUOUS 狀態讓人看得到（npm run phase0）。
      log.warn('telegram_webhook_ambiguous_delivery', { update_id: result.updateId });
      return send(res, 200, { ok: true, outcome: result.outcome });
    }
    return send(res, 200, { ok: true, outcome: result.outcome });
  };
}

/** 建立（但不啟動）HTTP server。 */
export function createWebhookServer(opts) {
  const handler = createWebhookHandler(opts);
  return http.createServer((req, res) => {
    handler(req, res).catch((err) => {
      log.error('telegram_webhook_handler_failed', { error: describeError(err) });
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end('{"ok":false}');
    });
  });
}

/**
 * 正式環境進入點。
 *
 * env 只要求這個服務**真的會用到**的東西：
 *   - TELEGRAM_BOT_TOKEN / TELEGRAM_WEBHOOK_SECRET：收訊與送訊
 *   - TURSO_*：所有耐久狀態
 *   - OPENROUTER_API_KEY：Q&A 需要
 * WHOOP 的 client id/secret **不需要** —— bot 只讀 Turso 裡已經同步好的
 * 健康資料，不會自己去打 WHOOP API（唯一會寫健康資料的仍然只有排程器）。
 */
export async function main({ port = process.env.PORT, listen = true } = {}) {
  loadDotEnvIfPresent();
  const env = loadEnv({
    require: [
      'TELEGRAM_BOT_TOKEN', 'TELEGRAM_WEBHOOK_SECRET',
      'TURSO_DATABASE_URL', 'TURSO_AUTH_TOKEN', 'OPENROUTER_API_KEY',
    ],
  });
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  const briefingTriggerSecret = process.env.BRIEFING_TRIGGER_SECRET;

  const db = createDb({ url: env.tursoUrl, authToken: env.tursoToken });
  await db.migrate();

  const coachFor = (userId) => createCoach({
    apiKey: env.openrouterApiKey, model: env.openrouterModel, db, userId,
  });
  const api = createTelegramApi({ botToken: env.telegramBotToken });
  const router = createRouter({ db, coachFor });

  // ---- 自助上線（V1.2 Phase 3.5）----------------------------------------
  //
  // 需要 WHOOP client id + 回呼網址才能產生授權連結。缺任何一個就整條關閉：
  // 與其給使用者一條一定失敗的連結，不如讓 /start 只走到「請聯絡管理者」。
  const onboardingConfigured = Boolean(
    env.whoopClientId && env.whoopClientSecret && env.whoopRedirectUri,
  );
  if (!onboardingConfigured) log.warn('self_service_onboarding_disabled', {});
  const onboardingArgs = {
    clientId: env.whoopClientId, redirectUri: env.whoopRedirectUri,
  };

  const processor = createUpdateProcessor({
    db,
    resolveUser: (chatId) => db.resolveUserByChatId(chatId),
    handleMessage: async ({ text, chatId, user }) => {
      // 上線還沒走完的人：只給狀態與下一步，**不執行任何健康處理**
      // （他的資料還沒進來，任何答案都會是假的）。
      if (onboardingConfigured) {
        const reply = await handleOnboardingMessage({ db, user, text, ...onboardingArgs });
        if (reply !== null) return reply;
      }
      return router.handle({ text, chatId, user });
    },
    handleUnlinked: async ({ text, chatId, message, isPrivateChat = false }) => {
      // 舊的 /link <碼> 仍然保留給管理者的復原路徑。
      const legacy = await handleLinkAttempt({ db, text, chatId, isPrivateChat });
      if (legacy !== null) return legacy;
      if (!onboardingConfigured) return null;
      return handleUnlinkedMessage({ db, text, chatId, message, isPrivateChat, ...onboardingArgs });
    },
    sendReply: createSendReply({ db, api }),
    // Ephemeral only. The final answer still uses the existing durable delivery
    // receipt/fencing path in updateProcessor.
    sendTyping: ({ chatId }) => api.sendChatAction(chatId, 'typing'),
    // 每次啟動都是新的身分：免費方案會睡會醒，醒來之後的自己不可以被
    // 認成上一輪那個可能死在半路的自己。
    workerId: `${process.pid}:${randomUUID()}`,
  });

  // ---- WHOOP webhook（V1.2 Phase 1）：預設關閉 ----------------------------
  const whoopWebhook = whoopWebhookConfiguration({
    enabledFlag: process.env.WHOOP_WEBHOOK_ENABLED,
    clientSecret: process.env.WHOOP_CLIENT_SECRET,
  });
  const whoopIngest = whoopWebhook.enabled
    ? createWhoopWebhookIngest({ db, clientSecret: process.env.WHOOP_CLIENT_SECRET })
    : null;
  // 只記狀態名稱，絕不記密鑰或它的長度。
  log.info('whoop_webhook_configuration', { state: whoopWebhook.state });

  const scheduler = schedulerConfiguration(env, briefingTriggerSecret);
  const schedulerConfigured = scheduler.enabled;
  if (!schedulerConfigured) {
    // 只記狀態名稱，不記密鑰長度或任何值。
    log.warn('briefing_scheduler_disabled', { reason: scheduler.state });
  }
  const briefingEndpoint = schedulerConfigured
    ? createBriefingEndpoint({ secret: briefingTriggerSecret, runBriefing }) : null;

  // ---- OAuth 回呼（V1.2 Phase 3.5）---------------------------------------
  //
  // 授權成功之後做兩件**有界**的事：通知使用者、踢一次 bootstrap。
  // bootstrap 刻意不 await —— 它可能要抓好幾分鐘的歷史，而瀏覽器在等。
  // 死掉也沒關係：狀態機停在 WHOOP_AUTHORIZED，排程器每一輪都會接手。
  // ★ v17：上線相關的通知也走送出時的帳號授權（§27）。可以帶上這一輪
  // 捕捉到的啟用世代 —— 一則在停用之前算出來的訊息不該在重新啟用之後才送達。
  const notifyUser = async (userId, text, { expectedLifecycleGeneration = null } = {}) => {
    const chatId = await db.getActiveChatIdForUser(userId, { expectedLifecycleGeneration });
    if (!chatId) return;
    await api.sendMessage(chatId, text);
  };
  const oauthCallback = onboardingConfigured ? createWhoopOAuthCallback({
    db,
    exchange: ({ code }) => exchangeCode({
      code, clientId: env.whoopClientId, clientSecret: env.whoopClientSecret,
      redirectUri: env.whoopRedirectUri,
    }),
    verifyIdentity: ({ accessToken }) => fetchWhoopUserId({ accessToken }),
    onAuthorized: async (userId) => {
      // 授權成功的那一刻捕捉啟用世代：bootstrap 是非同步的，帳號可能在它
      // 跑完之前被停用，而那之後的通知一律不該送出。
      const account = await db.getUser(userId).catch(() => null);
      const expectedLifecycleGeneration = Number.isInteger(account?.lifecycleGeneration)
        ? account.lifecycleGeneration : null;
      await notifyUser(userId, ONBOARDING_MESSAGES.authorizedSyncing(), { expectedLifecycleGeneration })
        .catch((err) => log.warn('onboarding_notify_failed', { error: describeError(err) }));
      // 不 await：回呼要在瀏覽器面前很快結束。
      runOnboardingBootstrap({
        db, userId, env,
        deps: {
          notify: (uid, kind) => notifyUser(uid, onboardingNotice(kind), {
            expectedLifecycleGeneration,
          }),
        },
      }).catch((err) => log.error('onboarding_bootstrap_detached_failed', {
        user_id: userId, error: describeError(err),
      }));
    },
  }) : null;

  const server = createWebhookServer({
    processUpdate: processor.processUpdate, secret, briefingEndpoint, schedulerConfigured,
    schedulerState: scheduler.state,
    whoopIngest,
    oauthCallback,
  });
  if (!listen) return { server, db };

  const p = Number(port);
  await new Promise((resolve) => {
    // Render 要求綁 0.0.0.0 才連得進來（只綁 localhost 會被判定沒起來）。
    server.listen(Number.isFinite(p) ? p : 0, '0.0.0.0', resolve);
  });
  log.info('telegram_webhook_listening', {
    port: server.address()?.port ?? null, path: TELEGRAM_BOT.WEBHOOK_PATH,
  });

  const shutdown = (signal) => {
    log.info('telegram_webhook_shutdown', { signal });
    server.close(() => { try { db.close(); } catch { /* 收工失敗不影響 */ } });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  return { server, db };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    log.error('telegram_webhook_fatal', { error: describeError(err) });
    process.exit(1);
  });
}
