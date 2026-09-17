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
 * `notifyError` 不包：那是運維用的故障告警，不是健康內容，而且在帳號剛被
 * 停用時仍然應該讓管理者看得到。
 *
 * @param {object} telegram  createTelegram 的結果（{ send, notifyError }）
 * @param {function} authorize async () => boolean
 */
export function withDeliveryAuthorization(telegram, authorize, { userId = null } = {}) {
  if (!telegram || typeof telegram.send !== 'function') return telegram;
  return {
    ...telegram,
    async send(...args) {
      if (!await authorize()) {
        // 不是錯誤：帳號在分析與送出之間變得不該再收到健康內容。
        return { messageId: null, suppressed: ACCOUNT_INACTIVE, userId };
      }
      return telegram.send(...args);
    },
  };
}
