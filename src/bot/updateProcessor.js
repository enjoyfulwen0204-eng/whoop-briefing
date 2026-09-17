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
import { isAccountInactiveError } from '../accountLifecycle.js';

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
  /**
   * 送出授權被圍欄擋下（H-03）：這個執行已經失去所有權或排序權。
   *
   * 它與 RETRY **不同**：這一則不是「稍後再試就會成功」，而是
   * 「現在做這件事的不該是我」。接手的執行（或已經跑完的 N+1）才是權威。
   *
   * 也與 AMBIGUOUS_DELIVERY 不同：我們**確定沒有送出任何東西**。
   *
   * 終局。可以 ack —— 讓 Telegram 重送只會讓同一個失效的執行再撞一次牆。
   */
  FENCED: 'fenced',
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
const PROCESS_STARTED_AT_MS = Date.now();

/** Commands are intentionally kept quiet; startup feedback is for real Q&A. */
function isNaturalLanguage(text) {
  return typeof text === 'string' && Boolean(text.trim()) && !text.trim().startsWith('/');
}

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
  /** Ephemeral Telegram activity; deliberately separate from durable replies. */
  sendTyping = null,
  processStartedAtMs = PROCESS_STARTED_AT_MS,
  startupWindowMs = 90_000,
  typingRefreshMs = 4_000,
  typingMaxMs = 28_000,
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
}) {
  const mkAttemptId = newAttemptId ?? (() => `${workerId}#${randomUUID()}`);
  let startupFeedbackClaimed = false;

  function claimStartupFeedback() {
    if (startupFeedbackClaimed) return false;
    const elapsed = now().getTime() - processStartedAtMs;
    if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed > startupWindowMs) return false;
    // JavaScript runs this read/write without an await, so concurrent requests in
    // this process cannot both observe false before one claims it.
    startupFeedbackClaimed = true;
    return true;
  }

  async function withTyping(c, startup, fn) {
    if (typeof sendTyping !== 'function') return fn();
    let timer = null;
    let inFlight = null;
    let stopped = false;
    let refreshesLeft = typingRefreshMs > 0
      ? Math.max(0, Math.floor(typingMaxMs / typingRefreshMs) - 1) : 0;

    const tick = async () => {
      if (stopped || inFlight) return true;
      inFlight = Promise.resolve(sendTyping({
        chatId: c.chatId, userId: c.user.id, startup,
      })).then(() => true).catch((err) => {
        log.warn('telegram_typing_failed', { error: describeError(err) });
        return false;
      });
      const ok = await inFlight;
      inFlight = null;
      return ok;
    };

    // Start feedback before health context, analytics, or the model are touched.
    const available = await tick();
    if (startup && available) log.info('telegram_startup_feedback_started', {});
    if (available && refreshesLeft > 0 && typingRefreshMs > 0) {
      timer = setIntervalImpl(() => {
        if (refreshesLeft <= 0) {
          clearIntervalImpl(timer);
          timer = null;
          return;
        }
        refreshesLeft -= 1;
        void tick().then((ok) => {
          if (!ok && timer) {
            clearIntervalImpl(timer);
            timer = null;
          }
        });
      }, typingRefreshMs);
      timer?.unref?.();
    }

    try {
      return await fn();
    } finally {
      stopped = true;
      if (timer) clearIntervalImpl(timer);
      // A refresh has a hard 3s API timeout in production. Waiting here ensures
      // no activity task survives the request or races the durable final send.
      if (inFlight) await inFlight;
    }
  }

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
  async function claimWithRetry(updateId, attemptId, conversationKey) {
    let lastErr = null;
    for (let attempt = 1; attempt <= TELEGRAM_BOT.CLAIM_RETRIES; attempt += 1) {
      try {
        return await db.claimTelegramUpdate(updateId, {
          owner: attemptId, leaseMs: TELEGRAM_BOT.CLAIM_LEASE_MS, now: now(),
          // ★ TG-R04-A：對話身分**與認領同一筆寫入**。
          // 分兩步寫的話，中間崩潰就會留下一個「已認領但沒有對話身分」的列，
          // 後來的訊息看不到它就會超車。
          conversationKey,
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
        // ★ TG-R04-B：先把「久到不可能還有人在推進」的更早訊息**原子地終結**。
        //
        // 順序是不可以反的：終結 → 再檢查 → 才放行。
        // 舊版是在查詢裡用寬限期「忽略」太舊的那一則，於是後面的先跑了，
        // 而前面那則之後還能恢復並執行 —— 執行順序變成 ["N+1", "N"]。
        //
        // 終結會把 owner 與租約一起清掉，所以舊的執行醒來之後每一個副作用
        // 邊界都會失敗（詳見 abandonStaleConversationUpdates）。
        //
        // 這一段在對話鎖的保護之下，所以兩個併發的清理不會互相踩到。
        if (typeof db.abandonStaleConversationUpdates === 'function') {
          await db.abandonStaleConversationUpdates(conversationKey, updateId, {
            now: now(), graceMs: TELEGRAM_BOT.ORDER_BLOCK_GRACE_MS,
          });
        }
        // 然後是**嚴格**檢查：只要還有任何更早、未終局的，就讓路。
        earlier = await db.hasEarlierUnfinishedInConversation(conversationKey, updateId);
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
  async function deliverReply(updateId, result, attemptId, conversationKey) {
    const op = typeof db.getTelegramOperation === 'function'
      ? await db.getTelegramOperation(updateId) : null;
    const state = op?.deliveryState ?? null;

    if (state === TELEGRAM_DELIVERY_STATE.DELIVERED) return { outcome: 'delivered' };
    if (state === TELEGRAM_DELIVERY_STATE.NOT_REQUIRED) return { outcome: 'suppressed' };
    if (state === TELEGRAM_DELIVERY_STATE.DELIVERY_STARTED
        || state === TELEGRAM_DELIVERY_STATE.AMBIGUOUS) {
      // 上一次走到一半死了，或結果不明 —— Telegram 可能已經收下了。
      // **絕不自動重送。**
      log.warn('telegram_delivery_not_retried', { update_id: updateId, state });
      return { outcome: 'ambiguous' };
    }

    // ★ 不可逆外部副作用的唯一入口（H-03）。
    //
    // markDeliveryStarted 是一句**原子**的 SQL，同時證明：收據可送、這則
    // update 還屬於我、我的租約還有效、對話鍵沒被換掉、而且這個對話裡沒有
    // 更早、還沒到終局的訊息（＝我現在有排序權）。
    //
    // 任何一項不成立就拒絕。被放棄掉的舊執行醒來之後走到這裡會失敗，
    // 所以它送不出任何東西 —— 「JavaScript 恢復執行」不等於「重新取得權力」。
    //
    // 記憶體的 lane lock 仍然在（它便宜），但權威是這一句 SQL。
    if (typeof db.markDeliveryStarted === 'function') {
      const started = await db.markDeliveryStarted(updateId, {
        owner: attemptId, conversationKey, now: now(),
      });
      if (!started) {
        // 失去所有權 / 失去排序權 / 已經有人送過。一律**不送**。
        log.warn('telegram_delivery_start_rejected', {
          update_id: updateId, conversation: conversationKey ? String(conversationKey) : null,
        });
        return { outcome: 'fenced' };
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
      return { outcome: 'suppressed' };
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
      const claim = await claimWithRetry(updateId, attemptId, conversationKey);

      if (claim.state === 'identity_conflict') {
        // 同一個 update_id 帶著不同的對話鍵 —— 資料完整性問題，不是競態。
        // 不處理、也不 ack：這需要人看，不該靠重送自己好起來。
        log.error('telegram_update_identity_conflict_refused', { update_id: updateId });
        return { outcome: UPDATE_OUTCOME.RETRY, updateId, reason: 'identity_conflict', replied: false };
      }
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

    // ---- 對話通道：同一個對話一次一則，而且不可以超車 ----
    //
    // 對話身分已經在**認領那一筆**就落地了（見 claimWithRetry），所以這裡
    // 不需要、也不可以再補寫一次：任何「認領成功但身分還沒寫」的空窗都不存在。
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
        // ---- ★ R2 / LIFE-FG-05：健康處理**之前**的啟用授權 ---------------
        //
        // 只在遞送時擋是不夠的：handleMessage 會查個人健康資料、可能打
        // WHOOP、餵給模型，而且會寫下耐久的健康／脈絡狀態（journal、
        // 追問狀態、答覆收據）。那些寫入都發生在遞送之前，所以一個在
        // 停用（或 ABA）之後才跑到這裡的請求，光靠遞送圍欄會留下
        // 一整串屬於舊啟用期的耐久痕跡。
        //
        // 這一段整個在 processTelegramOperation 的交易裡，所以拒絕就是
        // 「什麼健康狀態都沒被寫下」。更新本身仍然會被正常結案
        // （那是傳輸層的冪等中繼資料，不是健康狀態）。
        if (typeof db?.assertAccountActive === 'function'
            && Number.isInteger(c.user?.lifecycleGeneration)) {
          try {
            await db.assertAccountActive(c.user.id, c.user.lifecycleGeneration);
          } catch (err) {
            if (isAccountInactiveError(err)) {
              log.info('telegram_message_lifecycle_skipped', { update_id: updateId });
              return { chatId: c.chatId, reply: null, userId: c.user.id };
            }
            throw err;
          }
        }
        const reply = await handleMessage({
          text: c.text, chatId: c.chatId, message: c.message, user: c.user,
        });
        return {
          chatId: c.chatId, reply, userId: c.user.id,
          // ★ R3 / R2-QA-DELIVERY-01：帶到**最終送出**那一刻。
          expectedLifecycleGeneration: Number.isInteger(c.user?.lifecycleGeneration)
            ? c.user.lifecycleGeneration : null,
        };
      };

      // 動作與收據共用同一個交易。提交之後重播會拿回存起來的回覆，
      // 不會把動作再做一次。
      const execute = () => claimed && db.processTelegramOperation
        ? db.processTelegramOperation(updateId, { owner: attemptId, now }, dispatch)
        : dispatch();
      const typingEligible = c.kind === 'ok' && isNaturalLanguage(c.text);
      const startup = typingEligible ? claimStartupFeedback() : false;
      const result = typingEligible
        ? await withTyping(c, startup, execute)
        : await execute();

      let replied = false;
      let ambiguous = false;

      // ---- ★ v17 §26：健康回覆的**送出時**帳號授權 --------------------
      //
      // 入站時 resolveUserByChatId 已經要求 ACTIVE，但從那一刻到這裡會經過
      // 分類、資料查詢與 LLM 生成。帳號可能在那段時間被停用 —— 甚至停用又
      // 啟用，那時候 status 又是 ACTIVE，只看狀態完全分不出來。
      // 所以這裡比對的是**進來時捕捉到的啟用世代**。
      //
      // 只擋有使用者的回覆：未綁定 / 帳號管理類的回覆是傳輸層，照舊。
      let deliverable = Boolean(result?.reply) && Boolean(sendReply);
      if (deliverable && result.userId && typeof db?.getActiveChatIdForUser === 'function') {
        const authorized = await db.getActiveChatIdForUser(result.userId, {
          expectedLifecycleGeneration: Number.isInteger(c.user?.lifecycleGeneration)
            ? c.user.lifecycleGeneration : null,
        }).catch(() => null);
        if (!authorized) {
          log.info('telegram_reply_lifecycle_suppressed', { update_id: updateId });
          deliverable = false;
        }
      }

      if (deliverable) {
        if (claimed) {
          const d = await deliverReply(updateId, result, attemptId, conversationKey);
          if (d.outcome === 'retry') {
            return { outcome: UPDATE_OUTCOME.RETRY, updateId, reason: 'send_failed', replied: false };
          }
          if (d.outcome === 'fenced') {
            // ★ 失去所有權／排序權。什麼都沒送出去，而且**不可以**把這一則
            // 標成完成 —— 那一列現在屬於別人（或已經被終結掉了），
            // 我們對它沒有任何話語權。就地退出。
            return {
              outcome: UPDATE_OUTCOME.FENCED, updateId,
              reason: 'ownership_lost', replied: false,
            };
          }
          ambiguous = d.outcome === 'ambiguous';
          replied = d.outcome === 'delivered';
        } else {
          const sent = await sendReply(result);
          replied = sent?.sent !== false;
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
