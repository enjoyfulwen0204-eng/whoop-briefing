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
 * ## 授權（Multi-user）
 *
 * 身分不再是單一的 TELEGRAM_CHAT_ID，而是查 `user_telegram` 表：
 *
 *   telegram_chat_id → user_telegram(ACTIVE) → users(ACTIVE) → userId
 *
 * 解析不到的 chat（沒綁定、綁定被撤銷、使用者被停用）一律視為未授權。
 * **未授權的 chat 只記 log、不回任何內容** —— 連「你沒有權限」都不回。
 * 它永遠學不到：有沒有其他使用者、有幾個、叫什麼名字、有沒有 WHOOP 帳號、
 * 任何健康資訊、任何內部 id。
 *
 * 唯一的例外是 `/link <code>`：那是「還沒綁定的人」唯一能做的事，
 * 由 handleUnlinked 處理（回覆刻意中性，不透露碼是否存在過）。
 */

import { randomUUID } from 'node:crypto';

import { TELEGRAM_BOT } from '../config.js';
import { createTelegramApi, waitForError } from './api.js';
import { createUpdateProcessor, UPDATE_OUTCOME, isAcknowledgeable } from './updateProcessor.js';
import { log, describeError } from '../logger.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const OFFSET_KEY = 'telegram_offset';

export function createPoller({
  db,
  botToken,
  /**
   * chatId → { id, timezone, … } | null。由 bot/index.js 注入
   * （實作就是 db.resolveUserByChatId）。回 null 代表未授權。
   */
  resolveUser,
  handleMessage,
  /** 未授權 chat 的處理（目前只用來吃 /link）。回 null 代表完全不回。 */
  handleUnlinked = null,
  sendReply = null,
  api = createTelegramApi({ botToken }),
  sleepImpl = sleep,
  pollTimeoutS = TELEGRAM_BOT.POLL_TIMEOUT_S,
  /**
   * 這個 worker 的身分（R3-M-05）。
   *
   * 每次啟動都是新的：重啟之後的自己**不可以**被認成上一輪的自己，
   * 否則「上一個 worker 死在哪個階段」的判斷就失效了。
   * 同一輪之內固定不變，所以 ambiguous commit 的重試認得出自己的認領。
   */
  workerId = `${process.pid}:${randomUUID()}`,
  now = () => new Date(),
}) {
  let running = false;
  let stopping = false;
  let consecutiveFailures = 0;
  const stats = { polls: 0, updates: 0, handled: 0, ignored: 0, errors: 0 };

  // ★ 每一則 update 的實際處理（認領 / 動作交易 / 送出 / 完成）全部在
  // updateProcessor.js 裡，與 webhook 共用同一份。這裡只負責「長輪詢」這個
  // 傳輸方式本身：抓一批、決定 offset 要不要往前推、退避重試。
  const processor = createUpdateProcessor({
    db, resolveUser, handleMessage, handleUnlinked, sendReply, workerId, now, sleepImpl,
  });

  /** offset 存檔。失敗只記錄 —— 認領表才是防重複的那一層。 */
  async function saveOffset(offset) {
    try {
      await db.setUpdateOffset(offset);
      return true;
    } catch (err) {
      log.error('telegram_offset_save_failed', { offset, error: describeError(err) });
      return false;
    }
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
      const r = await processor.processUpdate(update);

      if (!isAcknowledgeable(r.outcome)) {
        // 不可以 ack → **刻意不推進 offset**，而且整批在這裡停下。
        // 繼續處理後面的 update 會把 offset 推過這一則，等於把它丟掉。
        stats.errors += 1;
        log.error('telegram_batch_paused', {
          update_id: updateId, offset, reason: r.reason ?? null,
        });
        return offset;
      }

      if (r.outcome === UPDATE_OUTCOME.PROCESSED) stats.handled += 1;
      else stats.ignored += 1;

      offset = updateId + 1;
      await saveOffset(offset);
    }

    // 認領紀錄的裁剪：一批一次，不是一則一次。失敗完全無所謂。
    if (offset > startOffset && typeof db.pruneTelegramUpdates === 'function') {
      try {
        await db.pruneTelegramUpdates(offset);
      } catch (err) {
        log.warn('telegram_update_prune_failed', { error: describeError(err) });
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
    log.info('telegram_poller_start', { poll_timeout_s: pollTimeoutS });

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
    // 既有測試與除錯會用到；實作在 updateProcessor（與 webhook 共用同一份）
    classify: processor.classify,
    stats,
    isRunning: () => running,
  };
}
