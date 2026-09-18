/**
 * Telegram 推送。
 *
 * - plain text（不設 parse_mode），避免 Markdown escaping 出包。
 * - Telegram API 本身出錯：只寫 log，絕不遞迴再呼叫 Telegram。
 * - 錯誤通知有 cooldown（同一 error_type 2 小時內最多一次），避免每 30 分鐘洗版。
 */

import { ERROR_NOTIFY_COOLDOWN_HOURS, TELEGRAM_MAX_CHARS, TELEGRAM_SEND } from './config.js';
import { GLOBAL_SCOPE } from './schema.js';
import { SEND_OUTCOME, classifySendOutcome, DEFINITE_NETWORK_CODES } from './sendOutcome.js';
import { clamp } from './format.js';
import { log, describeError } from './logger.js';
import { ACCOUNT_INACTIVE, isSuppressedDelivery } from './accountLifecycle.js';

export class TelegramError extends Error {
  /**
   * @param {string} message
   * @param {object} opts
   * @param {?string} opts.sendOutcome 這次送出到底發生了什麼（見 sendOutcome.js）。
   *   **一律明確指定**：讓下游去推測正是 H-04 的根因。
   */
  constructor(message, { sendOutcome = null, sendStage = null, status = null } = {}) {
    super(message);
    this.name = 'TelegramError';
    if (sendOutcome) this.sendOutcome = sendOutcome;
    if (sendStage) this.sendStage = sendStage;
    if (status !== null) this.status = status;
  }
}

/** 這個送出錯誤可不可以安全地自動重送？（只有「確定沒送出」可以） */
export function isDefiniteSendFailure(err) {
  return classifySendOutcome(err) === SEND_OUTCOME.DEFINITE_FAILURE;
}

/**
 * @param {?string} errorScope 錯誤通知冷卻的 scope。
 *   'global'（預設）= 基礎設施故障；`user:<userId>` = 某個使用者的帳號問題。
 *   分開才不會讓 Alice 的 WHOOP token 過期壓抑掉 Bob 的同類通知。
 */
export function createTelegram({
  botToken, chatId, dryRun = false, fetchImpl = fetch, db = null,
  errorScope = GLOBAL_SCOPE,
}) {
  async function send(text, { authorize, userId = null } = {}) {
    // 共用同一個 clamp（format.js），不再各自實作一份
    const body = clamp(text);
    // 發送層的最後防線：clamp 若哪天壞了，寧可在這裡爆掉也不要送出超長訊息
    // 讓 Telegram 回 400（那會被記成發送失敗，還要多繞一輪才看得出原因）
    if (body.length > TELEGRAM_MAX_CHARS) {
      // 還沒打網路就擋下來了 → 確定沒有送出，可以安全重試。
      throw new TelegramError(
        `訊息長度收斂失敗：${body.length} > ${TELEGRAM_MAX_CHARS}（clamp 有 bug）`,
        { sendOutcome: SEND_OUTCOME.DEFINITE_FAILURE, sendStage: 'pre_send' },
      );
    }

    // Last awaited operation before transport, including notifyError's cooldown I/O.
    if (authorize && !await authorize()) {
      return { messageId: null, suppressed: ACCOUNT_INACTIVE, userId };
    }
    if (dryRun) {
      log.info('telegram_dry_run', { chars: body.length });
      process.stdout.write(`\n----- DRY RUN Telegram 訊息 -----\n${body}\n----- 結束（${body.length} 字元）-----\n\n`);
      return { messageId: null, dryRun: true };
    }

    // ★ H-04：一次送出有五個可以失敗的階段，而它們的**可重送性完全不同**。
    // 每一個階段都明確標記結果，絕不讓一個沒有分類的錯誤往上冒
    // （沒有分類的錯誤會被當成「確定失敗」而重送 → 使用者收到兩份晨報）。
    let res;
    try {
      res = await fetchImpl(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: body,
          disable_web_page_preview: true,
        }),
        // 沒有逾時的請求會讓發送權的租約在等待中過期。
        signal: AbortSignal.timeout(TELEGRAM_SEND.REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      // 連線階段。只有「確定沒連上」才算確定失敗，其餘（逾時、連線被重置）
      // 都可能是請求已經送出去了。
      const code = err?.cause?.code ?? err?.code ?? err?.name ?? null;
      const definite = code && DEFINITE_NETWORK_CODES.has(String(code));
      throw new TelegramError(`Telegram 連線失敗：${err?.message ?? err}`, {
        sendOutcome: definite ? SEND_OUTCOME.DEFINITE_FAILURE : SEND_OUTCOME.AMBIGUOUS,
        sendStage: 'connect',
      });
    }

    // 拿到 HTTP 狀態 = Telegram 回應了。非 2xx 是它**親口拒收**，
    // 所以之後 body 讀不讀得到都不影響「它沒收下」這個結論。
    const definiteReject = !res.ok;

    let raw;
    try {
      raw = await res.text();
    } catch (err) {
      if (definiteReject) {
        throw new TelegramError(`Telegram ${res.status}（回應內容讀取失敗）`, {
          status: res.status,
          sendOutcome: SEND_OUTCOME.DEFINITE_FAILURE,
          sendStage: 'body_read',
        });
      }
      // ★ 這就是稽核重現的那條路：HTTP 200 已經拿到，body 讀到一半斷線。
      // Telegram 幾乎可以確定已經投遞了；重送等於送出第二份。
      throw new TelegramError(`Telegram 回應內容讀取失敗：${err?.message ?? err}`, {
        status: res.status,
        sendOutcome: SEND_OUTCOME.AMBIGUOUS,
        sendStage: 'body_read',
      });
    }

    if (definiteReject) {
      throw new TelegramError(`Telegram ${res.status}: ${raw.slice(0, 300)}`, {
        status: res.status,
        sendOutcome: SEND_OUTCOME.DEFINITE_FAILURE,
        sendStage: 'telegram_rejected',
      });
    }

    let json;
    try {
      json = JSON.parse(raw);
    } catch {
      // 2xx 但內容看不懂（截斷）。可能已經投遞 → 不可以重送。
      throw new TelegramError('Telegram 回傳非 JSON（可能截斷）', {
        status: res.status,
        sendOutcome: SEND_OUTCOME.AMBIGUOUS,
        sendStage: 'body_parse',
      });
    }

    // ok:false 是 Telegram 明確說「我沒收下」→ 可以安全重送。
    if (!json.ok) {
      throw new TelegramError(`Telegram 回應 ok=false: ${JSON.stringify(json).slice(0, 300)}`, {
        status: res.status,
        sendOutcome: SEND_OUTCOME.DEFINITE_FAILURE,
        sendStage: 'telegram_rejected',
      });
    }

    // ok:true 一定會帶 message_id。沒帶就是一個形狀不完整的成功回應 ——
    // 既不能宣稱送達，也不能重送。
    const messageId = Number(json.result?.message_id);
    if (!Number.isFinite(messageId)) {
      throw new TelegramError('Telegram 回報成功但沒有 message_id（無法證明送達）', {
        status: res.status,
        sendOutcome: SEND_OUTCOME.AMBIGUOUS,
        sendStage: 'success_shape',
      });
    }

    log.info('telegram_sent', { message_id: messageId, chars: body.length });
    return { messageId, dryRun: false };
  }

  /**
   * 發錯誤通知（帶 cooldown）。
   * 這個函式自己絕不拋錯 —— Telegram 掛了只寫 log。
   */
  async function notifyError(errorType, message, {
    cooldownHours = ERROR_NOTIFY_COOLDOWN_HOURS, authorize, userId, expectedLifecycleGeneration,
  } = {}) {
    // ★ 冷卻時間可以逐訊號指定。
    //
    // 全域預設是 2 小時，那對「一次性的故障」剛好。但對**持續**的狀況它是災難：
    // 排程器主要供應商掛掉一整天，2 小時的冷卻會送出 12 則一模一樣的警報，
    // 48 小時就是 24 則。那不是通知，那是訓練使用者把警報靜音。
    // 所以持續型訊號（例如排程器離線）自己指定一個長冷卻（24 小時）。
    const hours = Number.isFinite(cooldownHours) && cooldownHours > 0
      ? cooldownHours : ERROR_NOTIFY_COOLDOWN_HOURS;
    let claim = null;
    try {
      if (db) {
        // 有 owned 版本就用它 —— 送失敗時才有辦法「只還自己那一次」的認領。
        claim = typeof db.claimErrorNotifyOwned === 'function'
          ? await db.claimErrorNotifyOwned(errorScope, errorType, hours, { expectedLifecycleGeneration })
          : { granted: await db.claimErrorNotify(
            errorScope, errorType, hours, { expectedLifecycleGeneration },
          ), claimedAt: null };
        if (!claim.granted) {
          log.info('error_notify_suppressed', {
            scope: errorScope, error_type: errorType, cooldown_hours: hours,
          });
          return false;
        }
      }
      const result = await send(`🚨 WHOOP 簡報系統異常\n類型：${errorType}\n${message}\n\n（同類型錯誤 ${hours} 小時內只通知一次）`, { authorize, userId });
      if (isSuppressedDelivery(result)) {
        if (claim?.granted && claim.claimedAt && db?.releaseErrorNotify) {
          await db.releaseErrorNotify(errorScope, errorType, claim.claimedAt, { expectedLifecycleGeneration });
        }
        return result;
      }
      return true;
    } catch (err) {
      // ★ 送失敗 → 把認領還回去。
      //
      // 以前這裡只寫 log：認領已經持久化了，於是一次 Telegram 故障就把整個
      // 冷卻窗吃掉（排程離線警報是 24 小時）。使用者在那段時間完全不會被
      // 告知系統掛了 —— 而那正是最需要通知的時候。
      //
      // 釋放時帶上自己的 claimedAt，所以碰不到別人**更新的**成功認領。
      if (claim?.granted && claim.claimedAt && typeof db?.releaseErrorNotify === 'function') {
        try {
          const released = await db.releaseErrorNotify(errorScope, errorType, claim.claimedAt, { expectedLifecycleGeneration });
          log.info('error_notify_claim_released', {
            scope: errorScope, error_type: errorType, released,
          });
        } catch (releaseErr) {
          log.warn('error_notify_release_failed', { error: describeError(releaseErr) });
        }
      }
      // 不遞迴：Telegram 出錯就只留 log
      log.error('error_notify_failed', {
        scope: errorScope, error_type: errorType, error: describeError(err),
      });
      return false;
    }
  }

  return { send, notifyError };
}
