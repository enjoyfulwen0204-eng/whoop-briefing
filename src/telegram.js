/**
 * Telegram 推送。
 *
 * - plain text（不設 parse_mode），避免 Markdown escaping 出包。
 * - Telegram API 本身出錯：只寫 log，絕不遞迴再呼叫 Telegram。
 * - 錯誤通知有 cooldown（同一 error_type 2 小時內最多一次），避免每 15 分鐘洗版。
 */

import { ERROR_NOTIFY_COOLDOWN_HOURS, TELEGRAM_MAX_CHARS } from './config.js';
import { log, describeError } from './logger.js';

export class TelegramError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TelegramError';
  }
}

export function createTelegram({ botToken, chatId, dryRun = false, fetchImpl = fetch, db = null }) {
  async function send(text) {
    const body = text.length > TELEGRAM_MAX_CHARS
      ? `${text.slice(0, TELEGRAM_MAX_CHARS - 3)}...`
      : text;

    if (dryRun) {
      log.info('telegram_dry_run', { chars: body.length });
      process.stdout.write(`\n----- DRY RUN Telegram 訊息 -----\n${body}\n----- 結束（${body.length} 字元）-----\n\n`);
      return { messageId: null, dryRun: true };
    }

    const res = await fetchImpl(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: body,
        disable_web_page_preview: true,
      }),
    });

    const raw = await res.text();
    if (!res.ok) {
      throw new TelegramError(`Telegram ${res.status}: ${raw.slice(0, 300)}`);
    }
    let json;
    try {
      json = JSON.parse(raw);
    } catch {
      throw new TelegramError('Telegram 回傳非 JSON');
    }
    if (!json.ok) throw new TelegramError(`Telegram 回應 ok=false: ${JSON.stringify(json).slice(0, 300)}`);

    log.info('telegram_sent', { message_id: json.result?.message_id, chars: body.length });
    return { messageId: json.result?.message_id ?? null, dryRun: false };
  }

  /**
   * 發錯誤通知（帶 cooldown）。
   * 這個函式自己絕不拋錯 —— Telegram 掛了只寫 log。
   */
  async function notifyError(errorType, message) {
    try {
      if (db) {
        const allowed = await db.claimErrorNotify(errorType, ERROR_NOTIFY_COOLDOWN_HOURS);
        if (!allowed) {
          log.info('error_notify_suppressed', { error_type: errorType });
          return false;
        }
      }
      await send(`🚨 WHOOP 簡報系統異常\n類型：${errorType}\n${message}\n\n（同類型錯誤 ${ERROR_NOTIFY_COOLDOWN_HOURS} 小時內只通知一次）`);
      return true;
    } catch (err) {
      // 不遞迴：Telegram 出錯就只留 log
      log.error('error_notify_failed', { error_type: errorType, error: describeError(err) });
      return false;
    }
  }

  return { send, notifyError };
}
