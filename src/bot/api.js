/**
 * Telegram Bot API client（long polling 用）。
 *
 * 刻意**不用** webhook：webhook 需要對外可達的 HTTPS endpoint，
 * 而這個系統的部署形態（Render worker）用 getUpdates 更簡單也更好測。
 *
 * 這一層只負責 HTTP 與重試，不懂任何業務邏輯。
 */

import { TELEGRAM_BOT } from '../config.js';
import { log } from '../logger.js';

export class TelegramApiError extends Error {
  constructor(message, { status = null, retryAfterMs = null, isNetwork = false } = {}) {
    super(message);
    this.name = 'TelegramApiError';
    this.status = status;
    this.retryAfterMs = retryAfterMs;
    this.isNetwork = isNetwork;
  }
}

export function createTelegramApi({
  botToken,
  fetchImpl = fetch,
  requestTimeoutMs = TELEGRAM_BOT.REQUEST_TIMEOUT_MS,
}) {
  const base = `https://api.telegram.org/bot${botToken}`;

  async function call(method, body = {}, { timeoutMs = requestTimeoutMs } = {}) {
    let res;
    try {
      res = await fetchImpl(`${base}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      // 網路層失敗（含 long poll 逾時）。這是常態，不是故障。
      throw new TelegramApiError(`Telegram 連線失敗：${err?.message ?? err}`, { isNetwork: true });
    }

    const raw = await res.text();
    let json = null;
    try {
      json = raw ? JSON.parse(raw) : null;
    } catch { /* 下面用原始文字報錯 */ }

    if (!res.ok || json?.ok === false) {
      // 429 會帶 parameters.retry_after（秒）
      const retryAfter = Number(json?.parameters?.retry_after);
      throw new TelegramApiError(
        `Telegram ${res.status}: ${json?.description ?? raw.slice(0, 200)}`,
        {
          status: res.status,
          retryAfterMs: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : null,
        },
      );
    }
    return json?.result;
  }

  return {
    /**
     * 拉取更新。
     * offset 的語義：「從這個 update_id 開始給我」。傳了之後 Telegram 會把
     * 更小的 update 視為已確認並刪除 —— 這正是不會重複收到的機制。
     */
    getUpdates: ({ offset = 0, timeoutS = TELEGRAM_BOT.POLL_TIMEOUT_S, limit = TELEGRAM_BOT.BATCH_LIMIT } = {}) =>
      call('getUpdates', {
        offset: offset || undefined,
        timeout: timeoutS,
        limit,
        allowed_updates: ['message'],
      }, { timeoutMs: timeoutS * 1000 + 15_000 }),

    sendMessage: (chatId, text) => call('sendMessage', {
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
    }, { timeoutMs: 30_000 }),

    getMe: () => call('getMe', {}, { timeoutMs: 15_000 }),
  };
}

/** 指數退避 + jitter。 */
export function backoffMs(attempt, {
  base = TELEGRAM_BOT.BASE_BACKOFF_MS, max = TELEGRAM_BOT.MAX_BACKOFF_MS,
} = {}) {
  const v = Math.min(base * 2 ** Math.max(0, attempt - 1), max);
  return v + Math.floor(Math.random() * 250);
}

/** 這個錯誤該等多久再試。 */
export function waitForError(err, attempt) {
  if (err?.retryAfterMs) {
    log.warn('telegram_rate_limited', { retry_after_ms: err.retryAfterMs });
    return Math.min(err.retryAfterMs, TELEGRAM_BOT.MAX_BACKOFF_MS);
  }
  return backoffMs(attempt);
}
