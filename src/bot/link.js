/**
 * `/link <code>` —— 唯一一個「還沒綁定的 chat」可以做的動作。
 *
 * ## 安全與隱私
 *
 *  - 綁定碼**只比對 hash**（identityStore 負責），原文不進 DB、不進 log。
 *  - 一次性：兌換用單一條件式 UPDATE 當原子閘門，所以兩個人同時用同一組碼，
 *    只有一個會成功，另一個得到 ALREADY_USED。
 *  - 回覆刻意**中性**：不論碼不存在、已用過、還是過期，對外都只說「無法使用」，
 *    不透露這組碼是否曾經存在、屬於誰。未綁定的 chat 永遠學不到系統裡有誰。
 *  - 已經綁在**別人**身上的 chat 不會被靜默搶走（identityStore 會拒絕）。
 */

import { log } from '../logger.js';

export const LINK_COMMAND = /^\/link(?:@\w+)?(?:\s+(\S+))?\s*$/i;

/** 中性回覆：所有失敗原因共用同一句，避免變成碼的探測工具。 */
const NEUTRAL_FAIL = '這組綁定碼無法使用。請向管理者索取一組新的。';
const USAGE = '用法：/link <綁定碼>';

/**
 * @param {object} o
 * @param {object} o.db      identityStore（redeemLinkCode / getTelegramLink）
 * @param {string} o.text    使用者訊息
 * @param {string} o.chatId
 * @returns {Promise<?string>} 要回覆的文字；null = 完全不回（靜默忽略）
 */
export async function handleLinkAttempt({
  db, text, chatId, isPrivateChat = false, now = new Date(),
}) {
  const m = LINK_COMMAND.exec(String(text ?? '').trim());
  // 不是 /link → 完全不回。未綁定的 chat 不該得到任何回應。
  if (!m) return null;

  // ★ H-01 縱深防禦：綁定是整個系統最敏感的一步——它決定「這個 chat 之後
  // 講的話算誰的」。呼叫端（polling.classify）已經擋掉非私訊，但這裡**再
  // 擋一次**，而且預設是 false：任何忘記傳這個旗標的新呼叫端，行為會是
  // 拒絕綁定，而不是默默把一個群組綁到某個人身上。
  //
  // 群組被綁定 = 群組裡每一個人都變成那個人（實測過）。這條路徑不可以
  // 依賴「呼叫端有記得檢查」。
  if (!isPrivateChat) {
    log.warn('link_attempt_rejected_non_private', { chat_id: String(chatId) });
    return null;   // 完全不回：不讓群組成員推斷出這個 bot 的任何狀態
  }

  const code = m[1];
  if (!code) return USAGE;

  // 這個 chat 已經綁在別人身上？不透露細節，只拒絕。
  const existing = await db.getTelegramLink(chatId);
  if (existing && existing.status === 'ACTIVE') {
    log.warn('link_attempt_on_linked_chat', { chat_id: String(chatId) });
    return '這個聊天室已經綁定過了。如果要換綁，請先讓管理者解除舊的綁定。';
  }

  const res = await db.redeemLinkCode(code, { chatId, now });
  if (!res.ok) {
    // reason 只進 log，不進回覆
    log.warn('link_failed', { chat_id: String(chatId), reason: res.reason });
    return NEUTRAL_FAIL;
  }

  const user = await db.getUser(res.userId);
  log.info('link_succeeded', { user_id: res.userId });
  return `✅ 綁定完成，${user?.displayName ?? ''}。`
    + '\n\n接下來需要授權 WHOOP 才能開始收到簡報，請聯絡管理者完成授權。';
}
