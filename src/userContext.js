/**
 * user scope 的硬性守衛。
 *
 * Multi-user 最危險的失敗模式不是「查錯人」，而是**忘記帶 user 就查**——
 * 那會安靜地回傳所有人的資料。所以所有 per-user 的 store 函式第一行都要
 * 呼叫 requireUserId()，缺就大聲拋錯，絕不 fallback 到「第一個使用者」
 * 或「legacy 使用者」。
 */

export class MissingUserIdError extends Error {
  constructor(where) {
    super(`${where} 缺少 userId —— per-user 資料一律必須帶內部使用者 id，不可省略`);
    this.name = 'MissingUserIdError';
    this.where = where;
  }
}

/**
 * @param {unknown} userId
 * @param {string} where 呼叫端名稱，方便定位
 * @returns {string} 正規化後的 userId
 */
export function requireUserId(userId, where = 'store') {
  if (userId === null || userId === undefined) throw new MissingUserIdError(where);
  // ⚠️ 稽核修正（evidence.js 真的踩到了）：物件是 truthy，而且 String({})
  // 會變成字面上的 "[object Object]" —— 守衛安靜地放行，查詢卻拿一個垃圾
  // 字串當 user id，永遠 0 列。這正是「忘記帶 user 就查」的變形，而且比
  // 忘記帶還難發現，因為它連錯誤都不會拋。
  //
  // 只接受 string 與 number：number 是合法的（測試與外部 id 可能是數字），
  // 其他型別（object / array / boolean / function / symbol）一律大聲拒絕。
  const t = typeof userId;
  if (t !== 'string' && t !== 'number') throw new MissingUserIdError(where);
  if (t === 'number' && !Number.isFinite(userId)) throw new MissingUserIdError(where);
  const s = String(userId).trim();
  if (!s) throw new MissingUserIdError(where);
  return s;
}

/** 系統層（不屬於任何使用者）的用量／錯誤，用這個而不是隨便塞一個 user。 */
export const SYSTEM_USER_ID = null;
