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
 * ## 冷啟動安全
 *
 * 沒有任何正確性依賴記憶體：認領、動作收據、offset 全都在 Turso。
 * 睡著、重啟、重新部署、醒來後兩個請求同時進來 —— 都由 DB 的
 * 原子認領決定誰贏，輸的那個回 503 讓 Telegram 稍後重送。
 */

import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { randomUUID } from 'node:crypto';

import { loadDotEnvIfPresent, loadEnv, TELEGRAM_BOT } from '../config.js';
import { createDb } from '../db.js';
import { createCoach } from '../coach.js';
import { createTelegramApi } from './api.js';
import { createRouter } from './router.js';
import { createSendReply } from './index.js';
import { handleLinkAttempt } from './link.js';
import { createUpdateProcessor, UPDATE_OUTCOME, isAcknowledgeable } from './updateProcessor.js';
import { log, describeError } from '../logger.js';

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

/** 這個物件像不像一則 Telegram Update（只檢查到不會讓下游爆掉為止）。 */
export function looksLikeUpdate(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v)
    && Number.isFinite(Number(v.update_id));
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
  webhookPath = TELEGRAM_BOT.WEBHOOK_PATH,
  healthPath = TELEGRAM_BOT.HEALTH_PATH,
  maxBodyBytes = TELEGRAM_BOT.WEBHOOK_MAX_BODY_BYTES,
}) {
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
      return send(res, 200, { ok: true, service: 'telegram-webhook' });
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

  const db = createDb({ url: env.tursoUrl, authToken: env.tursoToken });
  await db.migrate();

  const coachFor = (userId) => createCoach({
    apiKey: env.openrouterApiKey, model: env.openrouterModel, db, userId,
  });
  const api = createTelegramApi({ botToken: env.telegramBotToken });
  const router = createRouter({ db, coachFor });

  const processor = createUpdateProcessor({
    db,
    resolveUser: (chatId) => db.resolveUserByChatId(chatId),
    handleMessage: ({ text, chatId, user }) => router.handle({ text, chatId, user }),
    handleUnlinked: ({ text, chatId, isPrivateChat = false }) => handleLinkAttempt({
      db, text, chatId, isPrivateChat,
    }),
    sendReply: createSendReply({ db, api }),
    // 每次啟動都是新的身分：免費方案會睡會醒，醒來之後的自己不可以被
    // 認成上一輪那個可能死在半路的自己。
    workerId: `${process.pid}:${randomUUID()}`,
  });

  const server = createWebhookServer({ processUpdate: processor.processUpdate, secret });
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
