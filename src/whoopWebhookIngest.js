/**
 * WHOOP webhook 的**入口**（V1.2 Phase 1）。
 *
 * 這一層只做四件事，而且刻意只做這四件：
 *
 *     驗簽 → 解析 → 耐久寫下（去重）→ 立刻回 200
 *
 * ## 為什麼不在請求裡打 WHOOP API
 *
 * 官方規格：投遞失敗（非 2XX 或逾時）會在一小時內重試五次。
 * 如果在 HTTP 請求裡同步去打 WHOOP API 拿 canonical 資料，一次 WHOOP 慢回應
 * 就會讓我們超時 → WHOOP 重送 → 兩個請求同時在處理同一則事件。
 * 那把「外部 API 慢」變成了「併發正確性問題」，而那是不必要的耦合。
 *
 * 所以邊界切在「耐久寫下」：只要事件進了帳本，這一則就不會遺失，
 * 重送也只會撞到唯一索引而被認成重複。之後的處理由排空器負責，
 * 它有自己的認領、租約與圍欄。
 *
 * ## ack 的語義
 *
 * 回 2XX = 「收下了，不用再送」。所以只有在**真的耐久寫進去**之後才回 200。
 * 暫時性錯誤（資料庫掛了）回 503 讓 WHOOP 重送 —— 那正是重試機制的用途。
 * 結構性錯誤（簽章不對、body 壞掉、不支援的事件）不可以要求重送：
 * 重送一百次結果一樣，只會浪費雙方的資源。
 *
 * ## 認證在任何業務處理之前
 *
 * 這個端點是公開可達的。沒有這一關，任何人都可以偽造「某人的睡眠變了」
 * 讓我們去打 WHOOP API、寫帳本。所以驗簽失敗時**一個位元組都不會被解析**。
 */

import { WHOOP_WEBHOOK } from './config.js';
import { verifyWhoopWebhook, WHOOP_AUTH_FAILURE } from './whoopWebhookAuth.js';
import { parseWhoopEvent, WHOOP_PARSE_FAILURE } from './whoopWebhookEvent.js';
import { log, describeError } from './logger.js';

/** 入口的處理結果（給路由層決定 HTTP 狀態碼，也給測試斷言）。 */
export const INGEST_OUTCOME = Object.freeze({
  /** 新事件已經耐久寫下。 */
  RECORDED: 'recorded',
  /** 一模一樣的事件早就收過了 —— 正常的重複投遞。 */
  DUPLICATE: 'duplicate',
  /** 簽章／時間戳不合格。 */
  UNAUTHORIZED: 'unauthorized',
  /** body 壞掉或缺必要欄位。重送不會變好。 */
  BAD_REQUEST: 'bad_request',
  /** 認得出來但我們不處理（不支援的事件類型）。 */
  UNSUPPORTED: 'unsupported',
  /** 我們自己這邊暫時壞了 —— 要求重送。 */
  TRANSIENT_ERROR: 'transient_error',
});

/** 這個結果該回什麼 HTTP 狀態碼。 */
export function statusForIngest(outcome) {
  switch (outcome) {
    case INGEST_OUTCOME.RECORDED:
    case INGEST_OUTCOME.DUPLICATE:
    // 不支援的事件**要 ack**：它是結構性的，重送一百次還是不支援。
    case INGEST_OUTCOME.UNSUPPORTED:
      return 200;
    case INGEST_OUTCOME.UNAUTHORIZED:
      return 401;
    case INGEST_OUTCOME.BAD_REQUEST:
      return 400;
    default:
      return 503;
  }
}

/**
 * 建立入口處理器。
 *
 * @param {object} db            需要 recordWhoopEvent
 * @param {?string} clientSecret WHOOP client secret（驗簽用；沒有就不可能通過）
 */
export function createWhoopWebhookIngest({
  db,
  clientSecret,
  toleranceMs = WHOOP_WEBHOOK.TIMESTAMP_TOLERANCE_MS,
  now = () => new Date(),
}) {
  /**
   * @param {object} headers 已正規化成小寫鍵
   * @param {string} rawBody **原始**內容字串（尚未 parse —— 驗簽要用它）
   */
  return async function ingest({ headers = {}, rawBody = '' }) {
    // ---- 1. 認證 -----------------------------------------------------------
    const auth = verifyWhoopWebhook({
      headers, rawBody, clientSecret, toleranceMs, now: new Date(now()).getTime(),
    });
    if (!auth.ok) {
      // 只記類別。絕不記簽章本身、也絕不記算出來的期望值 ——
      // 後者等於把答案直接寫進日誌。
      log.warn('whoop_webhook_unauthorized', { reason: auth.reason });
      return {
        outcome: INGEST_OUTCOME.UNAUTHORIZED,
        reason: auth.reason,
        // 沒設定祕密是**我們的**設定問題，不是對方的錯，但仍然不放行。
        configIssue: auth.reason === WHOOP_AUTH_FAILURE.NOT_CONFIGURED,
      };
    }

    // ---- 2. 解析 -----------------------------------------------------------
    const parsed = parseWhoopEvent(rawBody);
    if (!parsed.ok) {
      if (parsed.reason === WHOOP_PARSE_FAILURE.UNSUPPORTED_TYPE) {
        // 認得出是一則合法簽章的 WHOOP 事件，只是我們這一期不處理它。
        // 記下類型讓未來擴充時知道實際上收到過什麼。
        log.info('whoop_webhook_unsupported_event', { event_type: parsed.eventType ?? null });
        return { outcome: INGEST_OUTCOME.UNSUPPORTED, reason: parsed.reason };
      }
      log.warn('whoop_webhook_unprocessable', { reason: parsed.reason });
      return { outcome: INGEST_OUTCOME.BAD_REQUEST, reason: parsed.reason };
    }

    const event = parsed.event;

    // ---- 3. 耐久寫下（去重的權威是 DB 的唯一索引）---------------------------
    try {
      const recorded = await db.recordWhoopEvent({
        whoopUserId: event.whoopUserId,
        eventType: event.eventType,
        resourceType: event.resourceType,
        resourceId: event.resourceId,
        traceId: event.traceId,
        eventAt: String(auth.timestampMs),
        now: new Date(now()),
      });

      const base = {
        event_id: recorded.id,
        event_type: event.eventType,
        resource_type: event.resourceType,
        // whoop_user_id 是外部識別碼，不是健康資料；診斷需要它。
        whoop_user_id: event.whoopUserId,
      };
      if (recorded.duplicate) {
        log.info('whoop_webhook_duplicate', base);
        return { outcome: INGEST_OUTCOME.DUPLICATE, eventId: recorded.id, event };
      }
      log.info('whoop_webhook_received', base);
      return { outcome: INGEST_OUTCOME.RECORDED, eventId: recorded.id, event };
    } catch (err) {
      // 寫不進去就**不可以** ack：ack 等於告訴 WHOOP「收下了」，
      // 而事實上這一則會就此消失。回 503 讓它重送。
      log.error('whoop_webhook_record_failed', {
        event_type: event.eventType, error: describeError(err),
      });
      return { outcome: INGEST_OUTCOME.TRANSIENT_ERROR, reason: 'record_failed' };
    }
  };
}
