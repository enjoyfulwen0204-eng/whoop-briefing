/**
 * 處理**一則** Telegram Update —— 與傳輸方式無關。
 *
 * ## 為什麼要有這一層
 *
 * 正式環境的入站從 getUpdates 長輪詢改成 webhook，但「收到一則 update 之後
 * 要做什麼」完全沒有變：認領 → 推進 PROCESSING → 在動作交易裡處理 → 送出 →
 * 標記完成。那一段是整個系統最難的部分（R2-M-05 / R3-M-05 兩輪稽核的產物），
 * **絕對不可以為了換傳輸而複製一份**。
 *
 * 所以這裡把它抽出來，polling 與 webhook 都呼叫同一個函式：
 *
 *     Telegram → getUpdates ─┐
 *                            ├→ processUpdate() → 認領 / 動作 / 送出 / 完成
 *     Telegram → webhook  ───┘
 *
 * 差別只剩下「怎麼回報結果」：
 *   - polling 用結果決定 offset 要不要往前推
 *   - webhook 用結果決定 HTTP 狀態碼（Telegram 要不要重送）
 *
 * ## 結果語義（傳輸層據此決定 ack 與否）
 *
 *   processed  這一則真的被處理完了 → 可以 ack
 *   replayed   之前就已經處理完（或已放棄）→ 可以 ack，而且**不會**再做一次
 *   ignored    結構上不需要處理（不是文字訊息、群組、機器人…）→ 可以 ack
 *   invalid    update_id 根本不合法 → 可以 ack（重送也不會變好）
 *   retry      **不可以 ack**。拿不到所有權、租約壞掉、或處理中途失敗。
 *              Telegram 會重送；耐久去重保證重送不會產生第二次副作用。
 *
 * `retry` 是刻意保守的：在「有沒有人正在處理」不確定的時候，正確的行為是
 * 不處理也不承認，而不是賭一把。
 */

import { TELEGRAM_BOT } from '../config.js';
import { log, describeError } from '../logger.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 結果種類。傳輸層只需要看這個。 */
export const UPDATE_OUTCOME = Object.freeze({
  PROCESSED: 'processed',
  REPLAYED: 'replayed',
  IGNORED: 'ignored',
  INVALID: 'invalid',
  RETRY: 'retry',
});

/** 可以安全 ack（Telegram 不需要再送一次）的結果。 */
export function isAcknowledgeable(outcome) {
  return outcome !== UPDATE_OUTCOME.RETRY;
}

export function createUpdateProcessor({
  db,
  /** chatId → { user, link } | null。實作就是 db.resolveUserByChatId。 */
  resolveUser,
  handleMessage,
  /** 未綁定 chat 的處理（目前只用來吃 /link）。回 null 代表完全不回。 */
  handleUnlinked = null,
  /** 送出回覆。帶 HRD-R03 的綁定守衛。 */
  sendReply = null,
  workerId,
  now = () => new Date(),
  sleepImpl = sleep,
}) {
  /**
   * 同一個 process 內、同一則 update 的併發合流（webhook 才會遇到）。
   *
   * 長輪詢是一批一則循序處理，不可能併發。webhook 不一樣：Telegram 可能在
   * 第一個請求還沒回應時就重送，於是**同一個實例**同時處理同一則 update。
   *
   * 那時候兩個請求帶的是同一個 workerId，而同一個 owner 重複認領在耐久層
   * 是合法的「續租」（ambiguous commit 的復原路徑），所以兩邊都會往下走。
   * 動作本身不會做兩次 —— telegram_operations 的收據會讓第二個直接拿回
   * 已存的結果 —— 但那個結果**帶著回覆文字**，於是回覆會被送出兩次。
   *
   * ⚠️ 這張表只是同一個 process 內的合流，**不是正確性的來源**：
   *   - 跨實例的併發由 DB 的原子認領擋下（workerId 不同 → in_progress）
   *   - 重啟之後這張表是空的，而正確性完全不受影響（收據在 Turso）
   * 它解決的是「同一個實例重複回覆」這一個具體問題，沒有取代任何耐久機制。
   */
  const inFlight = new Map();
  /**
   * 這則 update 是不是我們要處理的文字訊息，以及它屬於哪個內部使用者。
   *
   * ## H-01 授權閘門（fail-closed，三條缺一不可）
   *
   * 一則訊息要被當成「這個使用者說的話」，必須同時滿足三個**結構性**條件，
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
   * 認領一則 update，暫時性失敗會重試（R2-M-05 / R3-M-05）。
   *
   * 重試帶著**同一個 workerId**，所以「INSERT 其實成功了但連線斷掉」
   * （ambiguous commit）的下一次嘗試會認出那是自己的認領而續租，
   * 不會把自己誤判成別人的重複。
   */
  async function claimWithRetry(updateId) {
    let lastErr = null;
    for (let attempt = 1; attempt <= TELEGRAM_BOT.CLAIM_RETRIES; attempt += 1) {
      try {
        return await db.claimTelegramUpdate(updateId, {
          owner: workerId, leaseMs: TELEGRAM_BOT.CLAIM_LEASE_MS, now: now(),
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
   * 處理一則 update。**永遠不拋錯** —— 一律回結果物件，讓傳輸層決定怎麼回應。
   *
   * 同一個 process 內針對同一則 update 的併發呼叫會合流成一次（見 inFlight），
   * 第二個呼叫拿到的是第一個的結果。
   *
   * @returns {{outcome:string, updateId:?number, reason:?string, replied:boolean}}
   */
  async function processUpdate(update) {
    const id = Number(update?.update_id);
    if (!Number.isFinite(id)) return processUpdateOnce(update);
    const running = inFlight.get(id);
    if (running) {
      log.info('telegram_update_coalesced', { update_id: id });
      // 等前一個做完，回報「這一則已經被處理過了」。
      // 刻意不回傳它的 replied —— 這一次請求沒有送出任何東西。
      const prior = await running;
      return { ...prior, outcome: prior.outcome, replied: false, coalesced: true };
    }
    const p = processUpdateOnce(update).finally(() => inFlight.delete(id));
    inFlight.set(id, p);
    return p;
  }

  async function processUpdateOnce(update) {
    const updateId = Number(update?.update_id);
    if (!Number.isFinite(updateId)) {
      return { outcome: UPDATE_OUTCOME.INVALID, updateId: null, reason: 'bad_update_id', replied: false };
    }

    // ★ M-09 / R3-M-05：原子認領，而且**在任何副作用之前**。
    //
    // 認領放在 classify() **之前**：連身分解析都不做，就不可能有任何
    // 副作用（含 getOpenPendingQuestion 的惰性過期寫入）。
    let claimed = false;
    if (typeof db.claimTelegramUpdate === 'function') {
      const claim = await claimWithRetry(updateId);

      if (claim.state === 'unavailable' || claim.state === 'in_progress') {
        // ★ **拿不到持久化的所有權就不處理。**
        //
        // 舊版在認領機制壞掉時放行（「寧可偶爾重複」），但那個取捨是錯的：
        // 實測的失敗序列是「claim 拋錯 → 副作用照做 → offset 也存不下去
        // → Telegram 重送 → 再做一次」，結果同一句話寫了兩筆 journal。
        log.error('telegram_update_not_acknowledged', {
          update_id: updateId, state: claim.state, holder: claim.owner ?? null,
        });
        return { outcome: UPDATE_OUTCOME.RETRY, updateId, reason: claim.state, replied: false };
      }

      if (claim.state === 'stale_processing') {
        // 有人死在「已經 dispatch、還沒標記完成」的區間裡。副作用做到哪不確定。
        // **絕不因為某個 worker 死了就承認未提交的工作。**
        log.error('telegram_update_stale_processing', { update_id: updateId });
        return { outcome: UPDATE_OUTCOME.RETRY, updateId, reason: 'stale_processing', replied: false };
      }

      if (claim.state === 'completed' || claim.state === 'abandoned') {
        // 真正的重複投遞。動作交易早就提交了，這裡**什麼都不做**。
        log.info('telegram_update_skipped_replay', { update_id: updateId, state: claim.state });
        return { outcome: UPDATE_OUTCOME.REPLAYED, updateId, reason: claim.state, replied: false };
      }

      if (claim.state !== 'claimed') {
        // 沒有列舉到的狀態一律 fail closed。
        log.error('telegram_update_claim_unexpected_state', {
          update_id: updateId, state: claim.state ?? null,
        });
        return { outcome: UPDATE_OUTCOME.RETRY, updateId, reason: 'unexpected_claim_state', replied: false };
      }

      claimed = true;

      // ★ CLAIMED → PROCESSING，**就在 dispatch 之前**。
      // PROCESSING 授權開始動作交易；動作與收據原子提交。
      let dispatchable = false;
      try {
        dispatchable = await db.markTelegramUpdateProcessing(updateId, {
          owner: workerId, now: now(),
        });
      } catch (err) {
        log.error('telegram_update_mark_processing_failed', {
          update_id: updateId, error: describeError(err),
        });
      }
      if (!dispatchable) {
        // 推不進 PROCESSING = 所有權已經不在我手上（或寫不進去）。
        // 這時候 dispatch 就是在沒有所有權的情況下產生副作用。
        log.error('telegram_update_dispatch_fence', { update_id: updateId });
        return { outcome: UPDATE_OUTCOME.RETRY, updateId, reason: 'dispatch_fence', replied: false };
      }
    }

    let ignored = false;
    try {
      const dispatch = async () => {
        const c = await classify(update);
        if (c.kind === 'unlinked') {
          const reply = handleUnlinked ? await handleUnlinked({
            text: c.text, chatId: c.chatId, message: c.message, isPrivateChat: true,
          }) : null;
          return { chatId: c.chatId, reply, userId: null };
        }
        if (c.kind !== 'ok') {
          ignored = true;
          if (c.kind === 'non_private_chat' || c.kind === 'bot_sender' || c.kind === 'sender_chat_mismatch') {
            // H-01：被授權閘門擋下的訊息記 warn（這是安全事件，不是雜訊），
            // 但**不回覆任何內容**。
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
        ? await db.processTelegramOperation(updateId, { owner: workerId, now }, dispatch)
        : await dispatch();

      let replied = false;
      if (result?.reply && sendReply) {
        await sendReply(result);
        replied = true;
      }
      if (claimed) {
        const done = await db.completeTelegramUpdate(updateId, { owner: workerId, now: now() });
        if (!done) throw new Error('telegram_update_complete_rejected');
      }
      return {
        outcome: ignored ? UPDATE_OUTCOME.IGNORED : UPDATE_OUTCOME.PROCESSED,
        updateId,
        reason: null,
        replied,
      };
    } catch (err) {
      log.error('telegram_processing_retry_required', {
        update_id: updateId, error: describeError(err),
      });
      return { outcome: UPDATE_OUTCOME.RETRY, updateId, reason: 'processing_failed', replied: false };
    }
  }

  return { processUpdate, classify };
}
