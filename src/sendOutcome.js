/**
 * 「這次外部送出到底發生了什麼」——**唯一**的判準（H-04）。
 *
 * ## 為什麼要有這個模組
 *
 * 系統有兩條各自獨立的 Telegram 送出路徑：
 *   · src/telegram.js      簡報 / 錯誤通知（排程那條路）
 *   · src/bot/api.js       互動回覆（bot 那條路）
 *
 * 它們以前各自判斷「失敗了沒」，而且判得不一樣。分類只要錯一次，後果就是
 * 使用者收到兩則一模一樣的健康建議 —— 那是這個系統最不能出的錯之一。
 * 所以判準集中在這裡，兩條路都用同一套。
 *
 * ## 一次送出其實有五個可能失敗的階段
 *
 *   1. 連線建立          ── 失敗 ⇒ 請求從來沒離開這台機器
 *   2. 請求送出
 *   3. 取得 HTTP 回應標頭 ── 拿到了 ⇒ Telegram 一定收到了請求
 *   4. **讀取回應 body**  ── 這一段以前沒人處理
 *   5. 解析／驗證 body
 *
 * 舊版的 `await res.text()` 不在任何 try 裡。第 4 階段失敗（HTTP 回應已經
 * 拿到，body 讀到一半 ECONNRESET）會丟出一個**沒有任何分類標記**的原生
 * TypeError，而兩邊的分類器看到「沒有 status、沒有 isNetwork」都會回
 * 「確定失敗」→ 自動重送 → 重複訊息。實測重現。
 *
 * 真相是：拿到 HTTP 200 的那一刻，Telegram 就已經接受並投遞了訊息。
 * body 讀不到只是**我們**不知道，不是它沒收到。
 *
 * ## 三分類（不是二分類）
 *
 *   DEFINITE_FAILURE 有證據顯示**沒有**送成功：
 *       · 連線根本沒建立（DNS、拒絕連線、URL 不合法）→ 請求沒離開本機
 *       · Telegram 回了非 2xx 的 HTTP 狀態            → 它親口說不收
 *       · Telegram 回了 ok:false                      → 同上
 *     ⇒ 可以安全地自動重送。
 *
 *   AMBIGUOUS       可能已經送到了，但**證明不了**：
 *       · 逾時 / ECONNRESET / socket hang up（回應還沒拿到）
 *       · 拿到 2xx 之後 body 讀取失敗
 *       · 拿到 2xx 但 body 不是合法 JSON（截斷）
 *       · 拿到 ok:true 但沒有 message_id（成功的形狀不完整）
 *     ⇒ **絕不自動重送**，寫成終局狀態，需要人工處置。
 *
 *   SUCCESS         Telegram 明確回 ok:true 且帶 message_id。
 *
 * ## 為什麼「不完整的成功」也算 AMBIGUOUS 而不是成功
 *
 * 把它當成功，等於在沒有證據的情況下宣稱「已送達」。宣稱送達的代價是
 * 使用者**沒收到**卻沒有人知道；宣稱 AMBIGUOUS 的代價是留下一筆要看的
 * 紀錄。後者可以修，前者不行。
 */

export const SEND_OUTCOME = Object.freeze({
  SUCCESS: 'success',
  DEFINITE_FAILURE: 'definite_failure',
  AMBIGUOUS: 'ambiguous',
});

/**
 * 連線**確定沒有建立起來**的網路錯誤碼。
 * 只有這幾個可以斷言「請求從來沒有離開這台機器」。
 * 其餘（逾時、ECONNRESET、socket hang up…）一律是不可證明的。
 */
export const DEFINITE_NETWORK_CODES = new Set([
  'ENOTFOUND',      // DNS 查不到 → 連線沒建立
  'EAI_AGAIN',      // DNS 暫時失敗 → 連線沒建立
  'ECONNREFUSED',   // 對方拒絕連線 → 沒建立
  'ERR_INVALID_URL',
]);

/**
 * 在錯誤物件上釘一個**明確**的分類，不要讓下游去猜。
 *
 * 猜測正是 H-04 的根因：一個沒有標記的錯誤被預設成「確定失敗」，
 * 於是最危險的那一類（模糊）被當成最安全的那一類處理。
 */
export function tagOutcome(err, outcome, { stage = null } = {}) {
  if (err && typeof err === 'object') {
    err.sendOutcome = outcome;
    if (stage) err.sendStage = stage;
  }
  return err;
}

/**
 * 這個錯誤代表的送出結果。
 *
 * 優先序是刻意的：
 *   1. 明確標記（tagOutcome）—— 產生錯誤的那一層最清楚發生了什麼
 *   2. HTTP 狀態 —— Telegram 親口說了話，以它為準
 *   3. 網路錯誤碼 —— 只有「確定沒連上」才算確定失敗
 *   4. 其他 ⇒ **AMBIGUOUS**
 *
 * ★ 第 4 條是這次修正的核心。舊版的預設是 DEFINITE_FAILURE，
 * 也就是「不認識的錯誤 ⇒ 放心重送」。預設值必須倒過來：
 * 不知道發生什麼事的時候，唯一安全的假設是「可能已經送出去了」。
 */
export function classifySendOutcome(err) {
  // 沒有錯誤物件本身就是一種不明狀態。呼叫端不該走到這裡；
  // 走到了就用最保守的答案。
  if (!err) return SEND_OUTCOME.AMBIGUOUS;

  if (err.sendOutcome === SEND_OUTCOME.DEFINITE_FAILURE
      || err.sendOutcome === SEND_OUTCOME.AMBIGUOUS
      || err.sendOutcome === SEND_OUTCOME.SUCCESS) {
    return err.sendOutcome;
  }

  // 收到 HTTP 狀態 = Telegram 回應了。非 2xx 就是它明確拒收。
  if (!err.isNetwork && err.status !== null && err.status !== undefined) {
    return SEND_OUTCOME.DEFINITE_FAILURE;
  }

  if (err.isNetwork) {
    const code = err.networkCode ?? null;
    if (code && DEFINITE_NETWORK_CODES.has(String(code))) {
      return SEND_OUTCOME.DEFINITE_FAILURE;
    }
    // 逾時 / ECONNRESET / socket hang up / 不明 → 證明不了未送達
    return SEND_OUTCOME.AMBIGUOUS;
  }

  // 沒有 status、也沒有標記成網路錯誤：來歷不明。fail closed。
  return SEND_OUTCOME.AMBIGUOUS;
}

/** 這個錯誤可不可以安全地自動重試？只有「確定失敗」可以。 */
export function isSafeToRetry(err) {
  return classifySendOutcome(err) === SEND_OUTCOME.DEFINITE_FAILURE;
}
