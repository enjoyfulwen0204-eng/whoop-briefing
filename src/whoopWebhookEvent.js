/**
 * WHOOP webhook 事件的解析與分類（V1.2 Phase 1）。
 *
 * 這一層**只做結構解析**，不碰資料庫、不打網路、不做任何健康判斷。
 * 它回答的問題只有一個：「這包 JSON 是不是一則我們支援的事件，
 * 它指向哪一個使用者的哪一個資源？」
 *
 * ## 只支援官方列出的六種
 *
 * developer.whoop.com 的 webhook 規格目前就是這六個字串。刻意用封閉白名單
 * 而不是「解析 type 再猜」：未知的事件類型一律走安全的忽略路徑，
 * 絕不會因為字串長得像就去動生理資料。
 *
 * ## v2 的 recovery 有一個必須寫下來的非對稱
 *
 * recovery 事件的 `id` 是**該筆睡眠的 UUID**（官方文件："The id of the
 * associated sleep (UUID)"），而單筆 recovery 的 API 端點卻是用 cycle 定址的
 * （`/cycle/{cycleId}/recovery`）。這兩件事不一致，所以取 canonical 資料時
 * 不能直接拿 webhook 的 id 去組 recovery 的路徑 —— 那會打到別人的 cycle。
 * 正確作法見 whoopWebhookProcessor.js。
 *
 * 本地 `whoop_recoveries` 的邏輯主鍵正好也是 (user_id, sleep_id)，
 * 所以 recovery 的 resource_id 用 sleep UUID 是與既有儲存層一致的。
 */

/** 官方支援的事件類型 → 內部資源類型。封閉白名單。 */
export const WHOOP_EVENT_TYPES = Object.freeze({
  'sleep.updated': { resourceType: 'sleep', action: 'updated' },
  'sleep.deleted': { resourceType: 'sleep', action: 'deleted' },
  'recovery.updated': { resourceType: 'recovery', action: 'updated' },
  'recovery.deleted': { resourceType: 'recovery', action: 'deleted' },
  'workout.updated': { resourceType: 'workout', action: 'updated' },
  'workout.deleted': { resourceType: 'workout', action: 'deleted' },
});

/** 這一輪支援的資源類型（與 canonical 儲存層對得上的那些）。 */
export const WHOOP_RESOURCE_TYPES = Object.freeze(['sleep', 'recovery', 'workout']);

export const WHOOP_PARSE_FAILURE = Object.freeze({
  NOT_JSON: 'not_json',
  NOT_OBJECT: 'not_object',
  MISSING_USER: 'missing_user',
  MISSING_ID: 'missing_id',
  MISSING_TYPE: 'missing_type',
  MISSING_TRACE: 'missing_trace',
  UNSUPPORTED_TYPE: 'unsupported_type',
});

/** 這個值可不可以當成一個穩定的識別字串。 */
function identifier(v) {
  if (typeof v === 'string') {
    const t = v.trim();
    // 長度上限純粹是防呆：識別碼是 UUID 或 int64，不會是一整篇文章。
    return t && t.length <= 128 ? t : null;
  }
  if (typeof v === 'number' && Number.isFinite(v)) {
    // v1 的 id 是 int64。用 Number.isSafeInteger 擋掉會失真的值 ——
    // 失真的 id 會指到**別筆資料**，那比拒絕處理危險得多。
    if (!Number.isSafeInteger(v)) return null;
    return String(v);
  }
  return null;
}

/**
 * 解析一則 webhook 事件。
 *
 * @param {string} rawBody 原始內容（已經通過簽章驗證）
 * @returns {{ok:true, event:object} | {ok:false, reason:string, eventType?:string}}
 */
export function parseWhoopEvent(rawBody) {
  let payload;
  try {
    payload = JSON.parse(String(rawBody));
  } catch {
    return { ok: false, reason: WHOOP_PARSE_FAILURE.NOT_JSON };
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, reason: WHOOP_PARSE_FAILURE.NOT_OBJECT };
  }

  const eventType = typeof payload.type === 'string' ? payload.type.trim() : '';
  if (!eventType) return { ok: false, reason: WHOOP_PARSE_FAILURE.MISSING_TYPE };

  const whoopUserId = identifier(payload.user_id);
  if (!whoopUserId) return { ok: false, reason: WHOOP_PARSE_FAILURE.MISSING_USER, eventType };

  const resourceId = identifier(payload.id);
  if (!resourceId) return { ok: false, reason: WHOOP_PARSE_FAILURE.MISSING_ID, eventType };

  // trace_id 是去重身分的一部分，缺了就沒辦法安全去重 —— 不可以用
  // 「反正補一個隨機值」帶過，那會讓每一次重送都變成一則新事件。
  const traceId = identifier(payload.trace_id);
  if (!traceId) return { ok: false, reason: WHOOP_PARSE_FAILURE.MISSING_TRACE, eventType };

  const spec = WHOOP_EVENT_TYPES[eventType];
  if (!spec) return { ok: false, reason: WHOOP_PARSE_FAILURE.UNSUPPORTED_TYPE, eventType };

  return {
    ok: true,
    event: {
      whoopUserId,
      eventType,
      resourceType: spec.resourceType,
      action: spec.action,
      resourceId,
      traceId,
    },
  };
}

/** 這個解析失敗值不值得讓 WHOOP 重送？結構問題重送一百次也一樣。 */
export function isPermanentParseFailure(reason) {
  return Object.values(WHOOP_PARSE_FAILURE).includes(reason);
}
