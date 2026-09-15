/**
 * WHOOP webhook 認證（V1.2 Phase 1）。
 *
 * ## 這是官方機制，不是自創的
 *
 * developer.whoop.com 的 webhook 規格：
 *
 *   X-WHOOP-Signature            簽章
 *   X-WHOOP-Signature-Timestamp  毫秒 epoch
 *
 *   calculated = base64(HMAC_SHA256(timestampHeader + rawBody, CLIENT_SECRET))
 *
 * 三件事必須照做，少一件都會開一個洞：
 *
 * 1. **簽的是原始 body 位元組**，不是 parse 過再序列化回去的 JSON。
 *    `JSON.parse` 再 `JSON.stringify` 會改變鍵順序、空白與數字表示法，
 *    算出來的簽章就對不上 —— 而「對不上就放行」是最糟的修法。
 *    所以驗證一定要在 parse 之前，拿到原始字串就先驗。
 *
 * 2. **timestamp 要一起進 HMAC**，而且要檢查它的新鮮度。少了新鮮度檢查，
 *    任何一則被側錄到的合法請求可以被無限重放（簽章永遠有效）。
 *
 * 3. **定長比較**。用 `===` 比字串會在第一個不同的位元組就返回，
 *    理論上可以用回應時間把簽章一個位元組一個位元組地猜出來。
 *
 * ## 與 Telegram 完全分離
 *
 * Telegram 用的是 `X-Telegram-Bot-Api-Secret-Token` 加上一個共享祕密，
 * 兩者的祕密、標頭、演算法全都不一樣，而且**絕不互相接受**。
 * 這一支模組只認 WHOOP client secret，不認任何 Telegram 的東西。
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

/** 官方標頭名稱（HTTP 標頭大小寫不敏感，Node 會轉小寫）。 */
export const WHOOP_SIGNATURE_HEADER = 'x-whoop-signature';
export const WHOOP_TIMESTAMP_HEADER = 'x-whoop-signature-timestamp';

/**
 * 驗證失敗的原因。**只回類別，不回任何計算出來的值** ——
 * 把期望的簽章寫進回應或日誌等於直接把答案送給攻擊者。
 */
export const WHOOP_AUTH_FAILURE = Object.freeze({
  NOT_CONFIGURED: 'not_configured',
  MISSING_SIGNATURE: 'missing_signature',
  MISSING_TIMESTAMP: 'missing_timestamp',
  BAD_TIMESTAMP: 'bad_timestamp',
  STALE_TIMESTAMP: 'stale_timestamp',
  BAD_SIGNATURE: 'bad_signature',
});

/**
 * 依官方公式算出簽章。
 *
 * @param {string} timestamp 標頭裡的**原始字串**（不是 parse 過的數字）——
 *   WHOOP 簽的是它送出來的那串字元，重新格式化過就對不上了。
 * @param {string|Buffer} rawBody 原始請求內容。
 */
export function computeWhoopSignature(timestamp, rawBody, clientSecret) {
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), 'utf8');
  return createHmac('sha256', clientSecret)
    .update(Buffer.concat([Buffer.from(String(timestamp), 'utf8'), body]))
    .digest('base64');
}

/** 定長比較。長度不同直接 false（長度本身不是祕密）。 */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * 驗證一則 WHOOP webhook 請求。
 *
 * @param {object} headers       已正規化成小寫鍵的標頭
 * @param {string|Buffer} rawBody 原始內容（**尚未** parse）
 * @param {?string} clientSecret WHOOP app 的 client secret
 * @param {number} toleranceMs   時間戳容許的偏差（雙向）
 * @returns {{ok:true, timestampMs:number} | {ok:false, reason:string}}
 */
export function verifyWhoopWebhook({
  headers = {}, rawBody = '', clientSecret = null,
  toleranceMs = 5 * 60_000, now = Date.now(),
}) {
  // 沒有設定祕密就**沒有能力驗證**。這種情況下唯一安全的答案是拒絕：
  // 「驗不了所以放行」正是這一關存在的理由。
  if (typeof clientSecret !== 'string' || !clientSecret) {
    return { ok: false, reason: WHOOP_AUTH_FAILURE.NOT_CONFIGURED };
  }

  const signature = headers[WHOOP_SIGNATURE_HEADER];
  const timestamp = headers[WHOOP_TIMESTAMP_HEADER];
  if (typeof signature !== 'string' || !signature) {
    return { ok: false, reason: WHOOP_AUTH_FAILURE.MISSING_SIGNATURE };
  }
  if (typeof timestamp !== 'string' || !timestamp) {
    return { ok: false, reason: WHOOP_AUTH_FAILURE.MISSING_TIMESTAMP };
  }

  // 時間戳必須是**純數字**。放行 '123abc' 之類的東西等於讓 HMAC 的輸入
  // 空間比規格更大，沒有好處只有風險。
  if (!/^\d{1,20}$/.test(timestamp)) {
    return { ok: false, reason: WHOOP_AUTH_FAILURE.BAD_TIMESTAMP };
  }
  const timestampMs = Number(timestamp);
  if (!Number.isFinite(timestampMs)) {
    return { ok: false, reason: WHOOP_AUTH_FAILURE.BAD_TIMESTAMP };
  }

  // 新鮮度：雙向都要檢查。只擋「太舊」的話，一個時鐘超前的偽造時間戳
  // 可以把重放窗口拉到任意遠的未來。
  if (Math.abs(now - timestampMs) > toleranceMs) {
    return { ok: false, reason: WHOOP_AUTH_FAILURE.STALE_TIMESTAMP };
  }

  const expected = computeWhoopSignature(timestamp, rawBody, clientSecret);
  if (!safeEqual(signature, expected)) {
    return { ok: false, reason: WHOOP_AUTH_FAILURE.BAD_SIGNATURE };
  }
  return { ok: true, timestampMs };
}
