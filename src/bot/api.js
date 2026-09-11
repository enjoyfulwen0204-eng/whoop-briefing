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
  constructor(message, {
    status = null, retryAfterMs = null, isNetwork = false, cause = null,
  } = {}) {
    super(message);
    this.name = 'TelegramApiError';
    this.status = status;
    this.retryAfterMs = retryAfterMs;
    this.isNetwork = isNetwork;
    this.networkCode = cause?.cause?.code ?? cause?.code ?? cause?.name ?? null;
  }
}

/**
 * 這次送出到底有沒有可能已經被 Telegram 收下？（R-A：模糊送達）
 *
 * Telegram 的 sendMessage **沒有**通用的呼叫端冪等鍵，所以在網路層失敗時
 * 我們無法證明遠端有沒有接受。硬要重送就有機會讓使用者收到兩則一模一樣的
 * 健康建議；硬要放棄又會在單純的網路抽風時吃掉回覆。所以要分類，不能一概而論。
 *
 *   'definite_failure' —— 有證據顯示**沒有**送成功：
 *       · 收到了 Telegram 的 HTTP 回應（不論 4xx/5xx 或 ok:false）
 *         → Telegram 自己講了話，就以它的話為準
 *       · 連線根本沒建立起來（DNS 查不到、連線被拒、URL 不合法）
 *         → 請求從來沒有離開過這台機器
 *
 *   'ambiguous' —— 連線已經建立、請求可能已經送出去了，但拿不到答案：
 *       逾時、連線被重置、socket 中斷。**證明不了** Telegram 沒收到。
 *
 * 刻意不把所有網路錯誤都當成「確定失敗」—— 那正是會產生重複訊息的誤判。
 */
const DEFINITE_NETWORK_CODES = new Set([
  'ENOTFOUND',      // DNS 查不到 → 連線沒建立
  'EAI_AGAIN',      // DNS 暫時失敗 → 連線沒建立
  'ECONNREFUSED',   // 對方拒絕連線 → 沒建立
  'ERR_INVALID_URL',
]);

export function classifySendOutcome(err) {
  if (!err) return 'definite_failure';
  // 收到 HTTP 回應 = Telegram 親口回報結果，以它為準。
  if (!err.isNetwork && err.status !== null && err.status !== undefined) return 'definite_failure';
  if (!err.isNetwork) return 'definite_failure';
  const code = err.networkCode ?? null;
  if (code && DEFINITE_NETWORK_CODES.has(String(code))) return 'definite_failure';
  // 逾時 / ECONNRESET / socket hang up / 其他不明 → 不可證明未送達
  return 'ambiguous';
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
      throw new TelegramApiError(`Telegram 連線失敗：${err?.message ?? err}`, {
        isNetwork: true, cause: err,
      });
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

    // Ephemeral UX only: Telegram clears chat actions automatically. Keep the
    // timeout short so feedback can never hold up the durable business reply for
    // more than a few seconds when Telegram is unavailable.
    sendChatAction: (chatId, action = 'typing') => call('sendChatAction', {
      chat_id: chatId,
      action,
    }, { timeoutMs: 3_000 }),

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
