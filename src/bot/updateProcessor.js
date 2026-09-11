/**
 * 處理**一則** Telegram Update —— 與傳輸方式無關。
 *
 * ## 為什麼要有這一層
 *
 * 正式環境的入站從 getUpdates 長輪詢改成 webhook，但「收到一則 update 之後
 * 要做什麼」完全沒有變。那一段是整個系統最難的部分，**絕對不可以為了換傳輸
 * 而複製一份**。polling 與 webhook 都呼叫這裡。
 *
 * ## 三層耐久保護（全部在 DB，不依賴記憶體）
 *
 * 1. **執行權**：每一次執行有自己的 attemptId。同一則 update 的兩個併發
 *    執行永遠是兩個不同的 owner，所以條件式寫入只會讓一個通過 —— 不論它們
 *    來自同一個 process 還是不同的 Render 實例。
 *
 * 2. **送達狀態**：回覆送出去之前先把「要送了」寫進 DB。任何時間點死掉，
 *    資料庫都說得出當時走到哪，所以恢復的執行分得出「還沒送」與「可能送了」。
 *
 * 3. **對話通道**：同一個使用者一次只有一則訊息在跑，而且不可以超車比自己
 *    早、還沒結案的訊息。澄清回覆因此不會在問題本身落地之前就被處理。
 *
 * ## 結果語義（傳輸層據此決定 ack 與否）
 *
 *   processed           真的處理完了 → 可以 ack
 *   replayed            之前就處理完（或已放棄）→ 可以 ack，不會再做一次
 *   ignored             結構上不需要處理 → 可以 ack
 *   invalid             update_id 不合法 → 可以 ack
 *   ambiguous_delivery  動作已提交，但送達結果不明 → 可以 ack，**不自動重送**
 *   retry               **不可以 ack**。沒拿到執行權、要讓路、或明確的失敗。
 */

import { randomUUID } from 'node:crypto';

import { TELEGRAM_BOT } from '../config.js';
import { TELEGRAM_DELIVERY_STATE } from '../schema.js';
import { classifySendOutcome } from './api.js';
import { log, describeError } from '../logger.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const UPDATE_OUTCOME = Object.freeze({
  PROCESSED: 'processed',
  REPLAYED: 'replayed',
  IGNORED: 'ignored',
  INVALID: 'invalid',
  RETRY: 'retry',
  /**
   * 動作已經耐久提交，但回覆的送達結果**無法確定**（逾時／連線被重置）。
   * 不會自動重送 —— 重送有機會讓使用者收到兩則一樣的健康建議。
   * 這是終局：可以 ack，讓 Telegram 停止重送。
   */
  AMBIGUOUS_DELIVERY: 'ambiguous_delivery',
});

/** 可以安全 ack（Telegram 不需要再送一次）的結果。 */
export function isAcknowledgeable(outcome) {
  return outcome !== UPDATE_OUTCOME.RETRY;
}

/**
 * 這則 Update 的**對話鍵** —— 純粹從結構推導，不查資料庫、不信任任何文字。
 *
 * ## 為什麼不能用內部 user_id 當排序身分（TG-R04）
 *
 * 內部身分要查資料庫才知道。在「已經認領、但還沒查完身分」的那段空窗裡，
 * 這一列的對話欄位是空的，後來的訊息看不到它 —— 於是 N+1 超車 N。
 * 對話鍵不需要查任何東西，所以可以在**認領的當下**就寫下去，空窗不存在。
 *
 * ## 安全性
 *
 * 只用 Telegram 自己的結構事實，而且與 H-01 授權閘門同一組條件：
 *
 *   1. 是私訊（chat.type === 'private'）
 *   2. 寄件者是真人（from.is_bot 不為真）
 *   3. from.id === chat.id —— Telegram 的私訊 chat id 就是對方的使用者 id，
 *      所以這一條等於「這則訊息真的是這個帳號本人送的」
 *
 * 三條缺一就回 null：沒有對話鍵 → 不進任何通道 → **不可能**用一則偽造或
 * 未綁定的訊息去鎖住別人的對話。而且鍵是 chat 自己的 id，不是內部 user_id，
 * 所以連「對應到別人的內部身分」這件事在結構上都做不到。
 *
 * 刻意不看訊息文字、不看 username —— 那些都是對方可以隨意控制的。
 */
export function conversationKeyOf(update) {
  const msg = update?.message;
  if (!msg) return null;
  if (typeof msg.text !== 'string' || !msg.text.trim()) return null;
  const chat = msg.chat ?? {};
  if (chat.type !== 'private') return null;
  const from = msg.from ?? {};
  if (from.is_bot === true) return null;
  const chatId = String(chat.id ?? '');
  const senderId = String(from.id ?? '');
  if (!chatId || !senderId || chatId !== senderId) return null;
  return `tg:${chatId}`;
}

/** 這個 process 的身分。用在日誌與除錯，**不是**所有權的依據。 */
const PROCESS_INSTANCE_ID = `${process.pid}:${randomUUID()}`;

export function createUpdateProcessor({
  db,
  /** chatId → { user, link } | null。實作就是 db.resolveUserByChatId。 */
  resolveUser,
  handleMessage,
  /** 未綁定 chat 的處理（目前只用來吃 /link）。回 null 代表完全不回。 */
  handleUnlinked = null,
  /** 送出回覆。帶 HRD-R03 的綁定守衛，回 {sent, messageId}。 */
  sendReply = null,
  /**
   * 這個 process 的身分。**只用於日誌**。
   * 所有權一律用每次執行各自產生的 attemptId —— 這兩件事必須分開：
   * 同一個 process 的兩個併發請求是**兩個不同的嘗試**，不可以互相繼承所有權。
   */
  workerId = PROCESS_INSTANCE_ID,
  now = () => new Date(),
  sleepImpl = sleep,
  /** 每次執行的所有權 token。可注入是為了測試能製造確定的交錯。 */
  newAttemptId = null,
  /** 同一個使用者的對話通道租約長度。 */
  laneTtlMs = TELEGRAM_BOT.USER_LANE_TTL_MS,
}) {
  const mkAttemptId = newAttemptId ?? (() => `${workerId}#${randomUUID()}`);

  /**
   * 這則 update 是不是我們要處理的文字訊息，以及它屬於哪個內部使用者。
   *
   * ## H-01 授權閘門（fail-closed，三條缺一不可）
   *
   *   1. `chat.type` 必須是 `private`。群組 / 超級群組 / 頻道一律拒絕。
   *   2. 送訊息的人必須是真人（`from.is_bot` 為真一律拒絕）。
   *   3. `from.id` 必須等於 `chat.id`。Telegram 的私訊聊天室 id 就是對方的
   *      使用者 id，所以這一條等於「這則訊息真的是這個帳號本人送的」。
   *
   * 三條都必須明確成立才放行；缺欄位、型態不明、對不上一律當成未授權。
   * 被拒絕的訊息**完全不回覆**：對方永遠學不到這個 bot 綁了誰。
   */
  async function classify(update) {
    const msg = update?.message;
    if (!msg) return { kind: 'not_a_message' };
    const chat = msg.chat ?? {};
    const chatId = String(chat.id ?? '');
    if (typeof msg.text !== 'string' || !msg.text.trim()) return { kind: 'no_text', chatId };
    const text = msg.text.trim();

    if (chat.type !== 'private') {
      return { kind: 'non_private_chat', chatId, chatType: chat.type ?? 'unknown' };
    }
    const from = msg.from ?? {};
    if (from.is_bot === true) return { kind: 'bot_sender', chatId };
    const senderId = String(from.id ?? '');
    if (!senderId || senderId !== chatId) return { kind: 'sender_chat_mismatch', chatId };

    const resolved = await resolveUser(chatId);
    if (!resolved) return { kind: 'unlinked', chatId, text, message: msg };
    return { kind: 'ok', chatId, text, message: msg, user: resolved.user ?? resolved };
  }

  /**
   * 認領，暫時性失敗會重試。
   *
   * 重試帶著**同一個 attemptId**，所以「INSERT 其實成功了但連線斷掉」
   * （ambiguous commit）的下一次嘗試會認出那是自己的認領而續租。
   * 因為 attemptId 是每次執行獨有的，這條路徑不會讓別的請求取得所有權。
   */
  async function claimWithRetry(updateId, attemptId) {
    let lastErr = null;
    for (let attempt = 1; attempt <= TELEGRAM_BOT.CLAIM_RETRIES; attempt += 1) {
      try {
        return await db.claimTelegramUpdate(updateId, {
          owner: attemptId, leaseMs: TELEGRAM_BOT.CLAIM_LEASE_MS, now: now(),
        });
      } catch (err) {
        lastErr = err;
        log.warn('telegram_update_claim_failed', {
          update_id: updateId, attempt, error: describeError(err),
        });
        if (attempt < TELEGRAM_BOT.CLAIM_RETRIES) {
          await sleepImpl(TELEGRAM_BOT.CLAIM_RETRY_BASE_MS * 2 ** (attempt - 1));
        }
      }
    }
    log.error('telegram_update_claim_unavailable', {
      update_id: updateId, error: describeError(lastErr),
    });
    return { ok: false, state: 'unavailable' };
  }

  /**
   * 取得這個使用者的對話通道，並確認沒有更早、還沒做完的訊息。
   *
   * 兩件事缺一不可：
   *   - 租約（互斥）：同一個人一次只有一則訊息在跑
   *   - 順序檢查：比我早的那一則如果還沒結案，我就要讓路
   * 只有互斥的話，N+1 先搶到通道就會超車 N。
   *
   * 租約用既有的 resource_locks，自帶 owner / 到期 / 圍欄 / 過期回收：
   * 崩潰的執行不會永久鎖住這個使用者。
   */
  async function enterConversationLane(conversationKey, updateId, attemptId) {
    if (!conversationKey || typeof db.acquireLock !== 'function') return { ok: true, lane: null };
    const name = `telegram_lane:${conversationKey}`;
    let owner = null;
    try {
      owner = await db.acquireLock(name, { ttlMs: laneTtlMs, owner: attemptId, now: now() });
    } catch (err) {
      log.error('telegram_lane_unavailable', { update_id: updateId, error: describeError(err) });
      return { ok: false, reason: 'lane_unavailable' };
    }
    if (!owner) {
      log.info('telegram_lane_busy', { update_id: updateId });
      return { ok: false, reason: 'lane_busy' };
    }
    if (typeof db.hasEarlierUnfinishedInConversation === 'function') {
      let earlier = false;
      try {
        earlier = await db.hasEarlierUnfinishedInConversation(conversationKey, updateId, {
          now: now(), graceMs: TELEGRAM_BOT.ORDER_BLOCK_GRACE_MS,
        });
      } catch (err) {
        log.error('telegram_order_check_failed', { update_id: updateId, error: describeError(err) });
        await leaveConversationLane({ name, owner });
        return { ok: false, reason: 'order_check_failed' };
      }
      if (earlier) {
        log.info('telegram_lane_waiting_for_earlier', { update_id: updateId });
        await leaveConversationLane({ name, owner });
        return { ok: false, reason: 'earlier_update_pending' };
      }
    }
    return { ok: true, lane: { name, owner } };
  }

  async function leaveConversationLane(lane) {
    if (!lane?.owner || typeof db.releaseLock !== 'function') return;
    try {
      await db.releaseLock(lane.name, lane.owner);
    } catch { /* 放不掉沒關係，TTL 到了自然過期 */ }
  }

  /**
   * 送出回覆，並把送達狀態耐久地記下來。
   *
   * 這是這一輪修的核心。舊版是「提交動作 → 送出 → 標記完成」，中間死掉就
   * 分不出「還沒送」和「已經送了」。現在**打網路之前**先寫 DELIVERY_STARTED。
   *
   * @returns {{outcome:'delivered'|'retry'|'ambiguous'}}
   */
  async function deliverReply(updateId, result, attemptId) {
    const op = typeof db.getTelegramOperation === 'function'
      ? await db.getTelegramOperation(updateId) : null;
    const state = op?.deliveryState ?? null;

    if (state === TELEGRAM_DELIVERY_STATE.DELIVERED
        || state === TELEGRAM_DELIVERY_STATE.NOT_REQUIRED) {
      return { outcome: 'delivered' };
    }
    if (state === TELEGRAM_DELIVERY_STATE.DELIVERY_STARTED
        || state === TELEGRAM_DELIVERY_STATE.AMBIGUOUS) {
      // 上一次走到一半死了，或結果不明 —— Telegram 可能已經收下了。
      // **絕不自動重送。**
      log.warn('telegram_delivery_not_retried', { update_id: updateId, state });
      return { outcome: 'ambiguous' };
    }

    if (typeof db.markDeliveryStarted === 'function') {
      const started = await db.markDeliveryStarted(updateId, { owner: attemptId, now: now() });
      if (!started) {
        log.warn('telegram_delivery_start_rejected', { update_id: updateId });
        return { outcome: 'ambiguous' };
      }
    }

    let sendResult;
    try {
      sendResult = await sendReply(result);
    } catch (err) {
      const cls = classifySendOutcome(err);
      if (cls === 'definite_failure') {
        // Telegram 親口說沒收下（或連線根本沒建立）→ 退回可重送狀態。
        if (typeof db.markDeliveryFailed === 'function') {
          await db.markDeliveryFailed(updateId, { owner: attemptId, now: now() });
        }
        log.warn('telegram_delivery_failed_retryable', {
          update_id: updateId, error: describeError(err),
        });
        return { outcome: 'retry' };
      }
      if (typeof db.markDeliveryAmbiguous === 'function') {
        await db.markDeliveryAmbiguous(updateId, { owner: attemptId, now: now() });
      }
      log.error('telegram_delivery_ambiguous', { update_id: updateId, error: describeError(err) });
      return { outcome: 'ambiguous' };
    }

    if (sendResult && sendResult.sent === false) {
      // 綁定守衛擋下來的（HRD-R03）。不是失敗，是終局的正確決定。
      if (typeof db.markDeliverySuppressed === 'function') {
        await db.markDeliverySuppressed(updateId, { owner: attemptId, now: now() });
      }
      return { outcome: 'delivered' };
    }

    if (typeof db.markDelivered === 'function') {
      await db.markDelivered(updateId, {
        owner: attemptId, messageId: sendResult?.messageId ?? null, now: now(),
      });
    }
    return { outcome: 'delivered' };
  }

  /**
   * 處理一則 update。**永遠不拋錯** —— 一律回結果物件，讓傳輸層決定怎麼回應。
   *
   * 同一則 update 的併發呼叫（不論同一個 process 還是不同實例）由**資料庫**
   * 決定誰贏。這裡刻意沒有任何記憶體層的合流：正確性不可以依賴記憶體。
   */
  async function processUpdate(update) {
    const updateId = Number(update?.update_id);
    if (!Number.isFinite(updateId)) {
      return { outcome: UPDATE_OUTCOME.INVALID, updateId: null, reason: 'bad_update_id', replied: false };
    }

    const attemptId = mkAttemptId();
    // 純結構推導，不查資料庫 —— 所以它在認領的當下就可用。
    const conversationKey = conversationKeyOf(update);

    let claimed = false;
    if (typeof db.claimTelegramUpdate === 'function') {
      const claim = await claimWithRetry(updateId, attemptId);

      if (claim.state === 'unavailable' || claim.state === 'in_progress') {
        log.info('telegram_update_not_acknowledged', { update_id: updateId, state: claim.state });
        return { outcome: UPDATE_OUTCOME.RETRY, updateId, reason: claim.state, replied: false };
      }
      if (claim.state === 'completed' || claim.state === 'abandoned') {
        log.info('telegram_update_skipped_replay', { update_id: updateId, state: claim.state });
        return { outcome: UPDATE_OUTCOME.REPLAYED, updateId, reason: claim.state, replied: false };
      }
      if (claim.state !== 'claimed') {
        log.error('telegram_update_claim_unexpected_state', {
          update_id: updateId, state: claim.state ?? null,
        });
        return { outcome: UPDATE_OUTCOME.RETRY, updateId, reason: 'unexpected_claim_state', replied: false };
      }
      claimed = true;
    }

    // ---- 對話身分：**在解析內部身分之前**就落地（TG-R04 的修法）----
    //
    // 順序是刻意的：
    //   認領 → 寫下對話鍵 → 進對話通道 → **然後才** resolveUser
    //
    // 舊版把 resolveUser 排在寫對話欄位之前，於是「已認領但還沒查完身分」
    // 的那段空窗裡，這一列在別人眼中是無主的，後來的訊息就會超車。
    if (claimed && conversationKey && typeof db.setTelegramUpdateConversation === 'function') {
      await db.setTelegramUpdateConversation(updateId, {
        owner: attemptId, conversationKey, now: now(),
      });
    }

    // ---- 對話通道：同一個對話一次一則，而且不可以超車 ----
    let lane = null;
    if (claimed && conversationKey) {
      const entered = await enterConversationLane(conversationKey, updateId, attemptId);
      if (!entered.ok) {
        // 讓路：把這一則退回可再認領，讓 Telegram 重送時能馬上被接手。
        if (typeof db.releaseTelegramUpdate === 'function') {
          await db.releaseTelegramUpdate(updateId, { owner: attemptId, now: now() });
        }
        return { outcome: UPDATE_OUTCOME.RETRY, updateId, reason: entered.reason, replied: false };
      }
      lane = entered.lane;
    }

    // ---- 現在才解析內部身分（唯讀，而且已經在通道保護之下）----
    const c = await classify(update);

    let ignored = false;
    try {
      if (claimed) {
        // ★ CLAIMED → PROCESSING，就在動作交易之前。
        let dispatchable = false;
        try {
          dispatchable = await db.markTelegramUpdateProcessing(updateId, {
            owner: attemptId, now: now(),
          });
        } catch (err) {
          log.error('telegram_update_mark_processing_failed', {
            update_id: updateId, error: describeError(err),
          });
        }
        if (!dispatchable) {
          log.error('telegram_update_dispatch_fence', { update_id: updateId });
          return { outcome: UPDATE_OUTCOME.RETRY, updateId, reason: 'dispatch_fence', replied: false };
        }
      }

      const dispatch = async () => {
        if (c.kind === 'unlinked') {
          const reply = handleUnlinked ? await handleUnlinked({
            text: c.text, chatId: c.chatId, message: c.message, isPrivateChat: true,
          }) : null;
          return { chatId: c.chatId, reply, userId: null };
        }
        if (c.kind !== 'ok') {
          ignored = true;
          if (c.kind === 'non_private_chat' || c.kind === 'bot_sender' || c.kind === 'sender_chat_mismatch') {
            log.warn('telegram_message_rejected', {
              update_id: updateId, reason: c.kind, chat_type: c.chatType ?? null,
            });
          } else {
            log.info('telegram_update_ignored', { update_id: updateId, reason: c.kind });
          }
          return null;
        }
        const reply = await handleMessage({
          text: c.text, chatId: c.chatId, message: c.message, user: c.user,
        });
        return { chatId: c.chatId, reply, userId: c.user.id };
      };

      // 動作與收據共用同一個交易。提交之後重播會拿回存起來的回覆，
      // 不會把動作再做一次。
      const result = claimed && db.processTelegramOperation
        ? await db.processTelegramOperation(updateId, { owner: attemptId, now }, dispatch)
        : await dispatch();

      let replied = false;
      let ambiguous = false;
      if (result?.reply && sendReply) {
        if (claimed) {
          const d = await deliverReply(updateId, result, attemptId);
          if (d.outcome === 'retry') {
            return { outcome: UPDATE_OUTCOME.RETRY, updateId, reason: 'send_failed', replied: false };
          }
          ambiguous = d.outcome === 'ambiguous';
          replied = d.outcome === 'delivered';
        } else {
          await sendReply(result);
          replied = true;
        }
      }

      if (claimed) {
        const done = await db.completeTelegramUpdate(updateId, { owner: attemptId, now: now() });
        if (!done) throw new Error('telegram_update_complete_rejected');
      }
      if (ambiguous) {
        return {
          outcome: UPDATE_OUTCOME.AMBIGUOUS_DELIVERY, updateId,
          reason: 'ambiguous_send', replied: false,
        };
      }
      return {
        outcome: ignored ? UPDATE_OUTCOME.IGNORED : UPDATE_OUTCOME.PROCESSED,
        updateId, reason: null, replied,
      };
    } catch (err) {
      log.error('telegram_processing_retry_required', {
        update_id: updateId, error: describeError(err),
      });
      return { outcome: UPDATE_OUTCOME.RETRY, updateId, reason: 'processing_failed', replied: false };
    } finally {
      await leaveConversationLane(lane);
    }
  }

  return { processUpdate, classify };
}
