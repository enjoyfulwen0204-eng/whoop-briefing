/**
 * Telegram Bot API client（long polling 用）。
 *
 * 刻意**不用** webhook：webhook 需要對外可達的 HTTPS endpoint，
 * 而這個系統的部署形態（Render worker）用 getUpdates 更簡單也更好測。
 *
 * 這一層只負責 HTTP 與重試，不懂任何業務邏輯。
 */

import { TELEGRAM_BOT } from '../config.js';
import { SEND_OUTCOME, tagOutcome } from '../sendOutcome.js';
import { log } from '../logger.js';

export class TelegramApiError extends Error {
  constructor(message, {
    status = null, retryAfterMs = null, isNetwork = false, cause = null,
    sendOutcome = null, sendStage = null,
  } = {}) {
    super(message);
    this.name = 'TelegramApiError';
    this.status = status;
    this.retryAfterMs = retryAfterMs;
    this.isNetwork = isNetwork;
    this.networkCode = cause?.cause?.code ?? cause?.code ?? cause?.name ?? null;
    // 產生錯誤的這一層最清楚發生在哪一個階段，所以由它**明確**標記，
    // 不要讓下游從 status/isNetwork 去推測（推測錯 = 重複訊息）。
    if (sendOutcome) this.sendOutcome = sendOutcome;
    if (sendStage) this.sendStage = sendStage;
  }
}

/**
 * 送出結果分類**已經搬到 src/sendOutcome.js**。
 *
 * 理由：簡報那條路（src/telegram.js）與 bot 這條路以前各判各的，而分類只要
 * 有一邊判錯，使用者就會收到重複的健康訊息。判準集中在一處，兩邊共用。
 *
 * 這裡 re-export 只是維持既有的 import 路徑（含測試），沒有第二份實作。
 */
export { classifySendOutcome, SEND_OUTCOME } from '../sendOutcome.js';

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

    // ★ H-04：從這裡開始，Telegram **已經收到請求並回應了**。
    //
    // 所以後面每一個失敗都必須先問一句：「這是 Telegram 說它沒收，
    // 還是只有我們自己讀不到答案？」前者可以重送，後者不可以。
    //
    // 分水嶺就是 res.ok：非 2xx 是它親口拒收（body 讀不讀得到都一樣），
    // 2xx 之後的任何讀取／解析失敗都只是**我們**不知道。
    const definiteReject = !res.ok;

    let raw;
    try {
      raw = await res.text();
    } catch (err) {
      if (definiteReject) {
        // 狀態碼就足以證明它沒收下，body 是什麼不重要。
        throw new TelegramApiError(`Telegram ${res.status}（回應內容讀取失敗）`, {
          status: res.status,
          sendOutcome: SEND_OUTCOME.DEFINITE_FAILURE,
          sendStage: 'body_read',
        });
      }
      // 2xx 之後 body 讀到一半斷線：Telegram 很可能已經投遞了。
      // 舊版讓這個原生錯誤直接往上冒，被預設成「確定失敗」而重送 —— 就是 H-04。
      throw tagOutcome(
        new TelegramApiError(`Telegram 回應內容讀取失敗：${err?.message ?? err}`, {
          status: res.status,
        }),
        SEND_OUTCOME.AMBIGUOUS,
        { stage: 'body_read' },
      );
    }

    let json = null;
    let parseFailed = false;
    try {
      json = raw ? JSON.parse(raw) : null;
    } catch { parseFailed = true; }

    if (definiteReject || json?.ok === false) {
      // 429 會帶 parameters.retry_after（秒）
      const retryAfter = Number(json?.parameters?.retry_after);
      throw new TelegramApiError(
        `Telegram ${res.status}: ${json?.description ?? raw.slice(0, 200)}`,
        {
          status: res.status,
          retryAfterMs: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : null,
          sendOutcome: SEND_OUTCOME.DEFINITE_FAILURE,
          sendStage: 'telegram_rejected',
        },
      );
    }

    // 2xx 但 body 不是合法 JSON（截斷 / 中間設備插手）。
    // 它可能已經投遞了，我們只是看不懂回答 → 不可以重送。
    if (parseFailed || (raw && json === null)) {
      throw new TelegramApiError('Telegram 回應不是合法 JSON（可能截斷）', {
        status: res.status,
        sendOutcome: SEND_OUTCOME.AMBIGUOUS,
        sendStage: 'body_parse',
      });
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

    /**
     * 送出一則訊息。
     *
     * ★ 成功的**形狀**也要驗（H-04）。
     *
     * Telegram 回 ok:true 的時候一定會帶 result.message_id。沒帶就代表我們
     * 拿到的不是一個完整的成功回應（截斷、中間設備改寫、API 行為改變）。
     * 那種情況下訊息可能已經投遞了，但我們**證明不了** —— 所以既不宣稱
     * 送達，也不重送，一律走模糊。
     */
    sendMessage: async (chatId, text) => {
      const result = await call('sendMessage', {
        chat_id: chatId,
        text,
        disable_web_page_preview: true,
      }, { timeoutMs: 30_000 });
      const messageId = Number(result?.message_id);
      if (!Number.isFinite(messageId)) {
        throw new TelegramApiError('Telegram 回報成功但沒有 message_id（無法證明送達）', {
          sendOutcome: SEND_OUTCOME.AMBIGUOUS,
          sendStage: 'success_shape',
        });
      }
      return result;
    },

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
