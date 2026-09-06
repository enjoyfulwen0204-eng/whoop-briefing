/**
 * Telegram long polling 迴圈。
 *
 * ## 為什麼不塞進 cron
 *
 * cron 是「跑完就結束」的一次性容器，long polling 需要常駐。
 * 兩者混在一起會讓簡報的排程被 polling 卡住。所以這是獨立的 worker。
 *
 * ## 不重複處理的機制（三層）
 *
 * 1. Telegram 端：送出 offset 之後，比它小的 update 會被伺服器刪除。
 * 2. **每處理完一則就立刻把 offset 寫進 Turso** —— 不是整批處理完才寫。
 *    這樣 worker 中途被殺，重啟後最多重做「正在處理的那一則」。
 * 3. 本地防線：`update_id < storedOffset` 的一律跳過（即使 Telegram 重送）。
 *
 * ## 授權
 *
 * 只回應設定的 TELEGRAM_CHAT_ID。其他 chat 的訊息**只記 log、不回任何內容**
 * —— 連「你沒有權限」都不回，避免把 bot 的存在洩漏給陌生人。
 */

import { TELEGRAM_BOT } from '../config.js';
import { createTelegramApi, waitForError } from './api.js';
import { log, describeError } from '../logger.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const OFFSET_KEY = 'telegram_offset';

export function createPoller({
  db,
  botToken,
  allowedChatId,
  handleMessage,
  api = createTelegramApi({ botToken }),
  sleepImpl = sleep,
  pollTimeoutS = TELEGRAM_BOT.POLL_TIMEOUT_S,
}) {
  let running = false;
  let stopping = false;
  let consecutiveFailures = 0;
  const stats = { polls: 0, updates: 0, handled: 0, ignored: 0, errors: 0 };

  /** 這則 update 是不是我們要處理的、來自授權 chat 的文字訊息。 */
  function classify(update) {
    const msg = update?.message;
    if (!msg) return { kind: 'not_a_message' };
    const chatId = String(msg.chat?.id ?? '');
    if (chatId !== String(allowedChatId)) return { kind: 'unauthorized', chatId };
    if (typeof msg.text !== 'string' || !msg.text.trim()) return { kind: 'no_text', chatId };
    return { kind: 'ok', chatId, text: msg.text.trim(), message: msg };
  }

  /**
   * 處理一批 updates。回傳新的 offset。
   * 每一則都獨立 try/catch —— 一則訊息處理失敗不可以卡住整條 queue。
   */
  async function processBatch(updates, startOffset) {
    let offset = startOffset;

    for (const update of updates) {
      const updateId = Number(update.update_id);
      if (!Number.isFinite(updateId)) continue;

      // 本地防線：Telegram 若因故重送舊的，直接跳過
      if (updateId < offset) {
        log.info('telegram_update_skipped_duplicate', { update_id: updateId, offset });
        continue;
      }

      stats.updates += 1;
      const c = classify(update);

      if (c.kind === 'unauthorized') {
        // 刻意什麼都不回：不確認 bot 存在，也不浪費配額
        stats.ignored += 1;
        log.warn('telegram_unauthorized_chat', { update_id: updateId, chat_id: c.chatId });
      } else if (c.kind !== 'ok') {
        stats.ignored += 1;
        log.info('telegram_update_ignored', { update_id: updateId, reason: c.kind });
      } else {
        try {
          await handleMessage({ text: c.text, chatId: c.chatId, message: c.message });
          stats.handled += 1;
        } catch (err) {
          stats.errors += 1;
          // 處理失敗仍然要推進 offset，否則同一則壞訊息會永遠卡住整個 bot
          log.error('telegram_handle_failed', {
            update_id: updateId, error: describeError(err),
          });
        }
      }

      // ★ 每一則處理完就立刻存檔
      offset = updateId + 1;
      try {
        await db.setUpdateOffset(offset);
      } catch (err) {
        log.error('telegram_offset_save_failed', {
          offset, error: describeError(err),
        });
      }
    }
    return offset;
  }

  /** 跑一輪 poll。回傳 { updates, offset }。 */
  async function pollOnce() {
    const offset = await db.getUpdateOffset();
    const updates = (await api.getUpdates({ offset, timeoutS: pollTimeoutS })) ?? [];
    stats.polls += 1;
    if (updates.length) {
      log.info('telegram_updates_received', { count: updates.length, offset });
    }
    const next = await processBatch(updates, offset);
    return { updates, offset: next };
  }

  /**
   * 主迴圈。
   * @param {number} maxIterations 測試用；正式執行不傳（無限跑）
   */
  async function start({ maxIterations = Infinity } = {}) {
    running = true;
    stopping = false;
    log.info('telegram_poller_start', { poll_timeout_s: pollTimeoutS, chat_id: String(allowedChatId) });

    let i = 0;
    while (!stopping && i < maxIterations) {
      i += 1;
      try {
        await pollOnce();
        consecutiveFailures = 0;
      } catch (err) {
        consecutiveFailures += 1;
        stats.errors += 1;
        const wait = waitForError(err, consecutiveFailures);
        log.warn('telegram_poll_failed', {
          attempt: consecutiveFailures,
          wait_ms: wait,
          is_network: Boolean(err?.isNetwork),
          error: describeError(err),
        });
        await sleepImpl(wait);
      }
    }

    running = false;
    log.info('telegram_poller_stopped', { ...stats });
    return stats;
  }

  /** 讓目前這一輪跑完就收工（graceful shutdown）。 */
  function stop() {
    stopping = true;
    log.info('telegram_poller_stopping', {});
  }

  return {
    start,
    stop,
    pollOnce,
    processBatch,
    classify,
    stats,
    isRunning: () => running,
  };
}
