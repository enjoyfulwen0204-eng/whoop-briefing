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

import { TELEGRAM_BOT } from '../config.js';
import { createTelegramApi, waitForError } from './api.js';
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
  api = createTelegramApi({ botToken }),
  sleepImpl = sleep,
  pollTimeoutS = TELEGRAM_BOT.POLL_TIMEOUT_S,
}) {
  let running = false;
  let stopping = false;
  let consecutiveFailures = 0;
  const stats = { polls: 0, updates: 0, handled: 0, ignored: 0, errors: 0 };

  /**
   * 這則 update 是不是我們要處理的文字訊息，以及它屬於哪個內部使用者。
   * 身分解析在**進入 router 之前**完成，router 拿到的一定是已知使用者。
   *
   * ## H-01：身分是「私訊的那個人」，不是「這個聊天室」
   *
   * 舊版只看 `msg.chat.id`，完全不看訊息是**誰**送的、也不看聊天室型態。
   * 於是只要有一個群組被綁定過（`/link` 在群組裡送出就會成功），
   * **群組裡任何一個人**的訊息都會被解析成綁定者本人 —— 可以讀他的生理
   * 資料、寫他的 Journal、看他的報告與長期規律。實測確認：Bob 在群組發言
   * 被解析成 Alice。
   *
   * V1.1 沒有任何「群組共享」的產品模型，所以這裡採 **fail-closed 私訊限定**，
   * 而不是臨時發明分享語義：
   *
   *   1. `chat.type` 必須是 `private`。群組 / 超級群組 / 頻道一律拒絕。
   *   2. 送訊息的人必須是真人（`from.is_bot` 為真一律拒絕）。
   *   3. `from.id` 必須等於 `chat.id`。Telegram 的私訊聊天室 id 就是對方的
   *      使用者 id，所以這一條等於「這則訊息真的是這個帳號本人送的」，
   *      而且**不需要改 schema** 就取得了寄件者綁定。
   *
   * 三條都必須明確成立才放行；缺欄位、型態不明、對不上一律當成未授權。
   * 被拒絕的訊息**完全不回覆**（連錯誤都不回），與既有「未綁定 chat 一律
   * 靜默」的立場一致：對方永遠學不到這個 bot 綁了誰、有沒有人在用。
   *
   * 這一段刻意放在 `resolveUser()` **之前** —— 連查都不查，就不可能因為
   * 查詢副作用而洩漏任何東西。
   */
  async function classify(update) {
    const msg = update?.message;
    if (!msg) return { kind: 'not_a_message' };
    const chat = msg.chat ?? {};
    const chatId = String(chat.id ?? '');
    if (typeof msg.text !== 'string' || !msg.text.trim()) return { kind: 'no_text', chatId };
    const text = msg.text.trim();

    // ---- H-01 授權閘門（fail-closed，三條缺一不可）----
    if (chat.type !== 'private') {
      return { kind: 'non_private_chat', chatId, chatType: chat.type ?? 'unknown' };
    }
    const from = msg.from ?? {};
    if (from.is_bot === true) return { kind: 'bot_sender', chatId };
    const senderId = String(from.id ?? '');
    if (!senderId || senderId !== chatId) {
      return { kind: 'sender_chat_mismatch', chatId };
    }

    const resolved = await resolveUser(chatId);
    if (!resolved) return { kind: 'unlinked', chatId, text, message: msg };
    return { kind: 'ok', chatId, text, message: msg, user: resolved.user ?? resolved };
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

      // ★ M-09：原子認領，而且**在任何副作用之前**。
      //
      // 上面的 offset 防線只在「offset 存得下去」時有效。實際流程是
      // 「處理（寫 journal、跑分析、送訊息）→ 存 offset」兩段寫入，
      // 中間 worker 被殺（部署、OOM、SIGKILL）的話 offset 還是舊的，
      // Telegram 會把同一則 update 再送一次 —— 同一句話被寫成兩筆 journal。
      // 實測確認：重送一次 → 2 筆。
      //
      // 認領放在 classify() **之前**：連身分解析都不做，就不可能有任何
      // 副作用（含 getOpenPendingQuestion 的惰性過期寫入）。
      if (typeof db.claimTelegramUpdate === 'function') {
        let claimed = true;
        try {
          claimed = await db.claimTelegramUpdate(updateId);
        } catch (err) {
          // 認領機制本身壞掉時**放行**：寧可偶爾重複，也不要讓整個 bot
          // 啞掉。這是刻意的取捨，而且會留下明確的 log。
          log.error('telegram_update_claim_failed', {
            update_id: updateId, error: describeError(err),
          });
        }
        if (!claimed) {
          stats.ignored += 1;
          log.info('telegram_update_skipped_replay', { update_id: updateId });
          offset = updateId + 1;
          try {
            await db.setUpdateOffset(offset);
          } catch (err) {
            log.error('telegram_offset_save_failed', { offset, error: describeError(err) });
          }
          continue;
        }
      }

      const c = await classify(update);

      if (c.kind === 'unlinked') {
        // 未綁定：唯一允許的動作是 /link。其他一律靜默忽略。
        stats.ignored += 1;
        log.warn('telegram_unlinked_chat', { update_id: updateId, chat_id: c.chatId });
        if (handleUnlinked) {
          try {
            // classify() 已經保證走到這裡的一定是私訊本人，明確傳下去
            await handleUnlinked({
              text: c.text, chatId: c.chatId, message: c.message, isPrivateChat: true,
            });
          } catch (err) {
            stats.errors += 1;
            log.error('telegram_unlinked_handle_failed', {
              update_id: updateId, error: describeError(err),
            });
          }
        }
      } else if (c.kind !== 'ok') {
        stats.ignored += 1;
        // H-01：被授權閘門擋下的訊息記 warn（這是安全事件，不是雜訊），
        // 但**不回覆任何內容**——群組成員不該從回覆推斷出這個 bot 綁了誰。
        if (c.kind === 'non_private_chat' || c.kind === 'bot_sender' || c.kind === 'sender_chat_mismatch') {
          log.warn('telegram_message_rejected', {
            update_id: updateId, reason: c.kind, chat_id: c.chatId, chat_type: c.chatType ?? null,
          });
        } else {
          log.info('telegram_update_ignored', { update_id: updateId, reason: c.kind });
        }
      } else {
        try {
          await handleMessage({
            text: c.text, chatId: c.chatId, message: c.message, user: c.user,
          });
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
    classify,
    stats,
    isRunning: () => running,
  };
}
