/**
 * 帳號啟用生命週期的共用語彙（V1.2 Phase 3.5，schema v17）。
 *
 * ## 為什麼需要一個獨立的世代
 *
 * `users.status` 只回答「現在是不是 ACTIVE」。它回答不了「現在這一段啟用期，
 * 跟你開始工作的時候是不是同一段」—— 而這兩件事在 ABA 之下會分岔：
 *
 *     t0  worker 在 ACTIVE 開跑，捕捉 lifecycle_generation = L
 *     t1  帳號被停用（PAUSED / DISABLED）→ L+1
 *     t2  帳號又被啟用                   → L+2
 *     t3  舊 worker 醒來寫入
 *
 * 在 t3，`status` 又是 ACTIVE。只看狀態的圍欄會放行一份**跨越了一整段
 * 停用期**的結論、報告、回覆或健康資料。世代讓那一刻變成可判定的：
 * L ≠ L+2，舊 worker 什麼都改不了。
 *
 * ## 分工（四個世代，四個不變量，不可互相取代）
 *
 *   auth_generation       WHOOP 授權（同意）的紀元
 *   lifecycle_generation  內部帳號啟用的紀元        ← 這個檔案
 *   analytics generation  分析失效的紀元
 *   lease / owner         worker 的所有權
 *
 * 重新授權不動啟用世代；停用再啟用不動授權世代。
 */

/** 帳號層級停止的統一代碼。 */
export const ACCOUNT_INACTIVE = 'ACCOUNT_INACTIVE';

/**
 * 帳號不是 ACTIVE，或已經不在這一輪捕捉到的那一段啟用期。
 *
 * 這**不是** provider 故障、不是缺 scope、不是可重試的暫時錯誤。
 * 它是一個確定的「這份工作不屬於現在這個帳號」的結論：
 * 什麼都不寫、不通知、不累積失敗次數，讓新的啟用期自己跑一輪。
 *
 * 錯誤內容只有 user id，沒有任何 token / 授權碼 / state / 健康資料。
 */
export class AccountInactiveError extends Error {
  constructor(userId = null) {
    super('帳號不是 ACTIVE，或啟用世代已改變：這一輪的結果不屬於目前的帳號狀態');
    this.name = 'AccountInactiveError';
    this.code = ACCOUNT_INACTIVE;
    this.userId = userId;
  }
}

/** 這個錯誤是不是帳號啟用層級的停止。 */
export function isAccountInactiveError(err) {
  return err?.code === ACCOUNT_INACTIVE;
}

// ---------------------------------------------------------------------------
// 啟用脈絡的**契約**（R2 §4 / §5）
// ---------------------------------------------------------------------------
/**
 * 明確的「這一次呼叫刻意不受啟用世代約束」記號。
 *
 * ## 為什麼需要一個記號，而不是「傳 null 就好」
 *
 * 第一版讓 `expectedLifecycleGeneration` 是選用的：沒傳就退化成「只檢查
 * ACTIVE」。那看起來是體貼，實際上是把安全性押在「每個呼叫端都記得傳」
 * 上面 —— 而獨立稽核找到的正是那些忘記傳的正式路徑（手動同步、盤點
 * CLI、對帳）。忘記的後果是**安靜地**失去 ABA 防護，沒有任何訊號。
 *
 * 所以現在：正式的健康處理 API **必須**拿到一個世代，拿不到就大聲失敗。
 * 真的需要不受約束的（測試夾具、管理者整備、資料修復）必須寫出這個記號，
 * 於是它在 code review 與 grep 裡都是看得見的一個決定，不是一個疏忽。
 */
export const LIFECYCLE_UNFENCED = 'LIFECYCLE_UNFENCED_ADMIN';

/** 正式健康路徑缺少啟用脈絡 —— 這是程式錯誤，不是執行期狀況。 */
export class LifecycleContextError extends Error {
  constructor(where) {
    super(
      `${where} 需要 expectedLifecycleGeneration（正式健康處理不可以沒有啟用脈絡）。`
      + `測試／管理用途請明確傳 LIFECYCLE_UNFENCED。`,
    );
    this.name = 'LifecycleContextError';
    this.code = 'LIFECYCLE_CONTEXT_REQUIRED';
  }
}

/**
 * 把呼叫端給的值轉成 SQL 圍欄要用的參數，**fail closed**。
 *
 * @returns {?number} 正整數 = 受約束；null = 呼叫端明確選擇不受約束
 * @throws {LifecycleContextError} 什麼都沒給（最危險的那一種）
 */
export function requireLifecycle(value, where) {
  if (value === LIFECYCLE_UNFENCED) return null;
  if (Number.isInteger(value) && value >= 1) return value;
  throw new LifecycleContextError(where);
}

/** 這個值是不是一個真正受約束的啟用世代。 */
export const isLifecycleFenced = (v) => Number.isInteger(v) && v >= 1;

/**
 * ★ v17 §27：**送出時**的健康訊息授權（單一入口）。
 *
 * 把一個 Telegram client 包起來，讓它的每一次 `send` 在真正送出**之前**
 * 重新證明「這個帳號現在仍然 ACTIVE，而且仍在這一輪捕捉到的那一段啟用期」。
 *
 * 為什麼不能只在選取時檢查：選取到送出之間會經過 provider 往返、LLM 分析、
 * 報告組版與多使用者併發 —— 帳號完全可能在那段時間被停用。更麻煩的是
 * 「停用又啟用」：那時候 status 又是 ACTIVE，只看狀態的檢查會放行一則
 * **跨越了一整段停用期**的健康訊息。世代讓它變成可判定的。
 *
 * User-scoped notifyError also receives the final transport check, after cooldown I/O.
 * Operator clients remain separate and do not use this wrapper.
 *
 * @param {object} telegram  createTelegram 的結果（{ send, notifyError }）
 * @param {function} authorize async () => boolean
 */
export function withDeliveryAuthorization(telegram, authorize, { userId = null, expectedLifecycleGeneration } = {}) {
  if (!telegram || typeof telegram.send !== 'function') return telegram;
  const guarded = async (fn, ...args) => {
    if (!await authorize()) {
      // 不是錯誤：帳號在分析與送出之間變得不該再收到健康內容。
      // 回傳一個**明確標記為未送出**的結果（見 SUPPRESSED）——
      // 呼叫端必須看得出「這不是一次成功的遞送」。
      return { messageId: null, suppressed: ACCOUNT_INACTIVE, userId };
    }
    return fn(...args);
  };
  return {
    ...telegram,
    send: (...args) => guarded(telegram.send.bind(telegram), ...args),
    // ★ R2 / LIFE-FG-09：user-scoped 的錯誤通知也是**送給使用者的訊息**。
    //
    // 舊版只包 send，於是「你的 WHOOP 授權壞了」「日報產生失敗」這類
    // 使用者可見的帳號／健康告警會繞過整個啟用授權，在停用（甚至 ABA）
    // 之後照樣送達。運維要看的系統告警走的是另一個 scope 的 client，
    // 不經過這裡，所以不受影響。
    notifyError: typeof telegram.notifyError === 'function'
      ? (type, message, options = {}) => guarded(telegram.notifyError.bind(telegram), type, message, {
        ...options, authorize, userId, expectedLifecycleGeneration,
      })
      : telegram.notifyError,
  };
}

/** 這個送出結果是不是被啟用授權擋下來的（**沒有**送出去）。 */
export function isSuppressedDelivery(result) {
  return result?.suppressed === ACCOUNT_INACTIVE;
}
