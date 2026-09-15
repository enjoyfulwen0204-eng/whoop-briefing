/**
 * WHOOP webhook 事件的**處理**（V1.2 Phase 1）。
 *
 * 入口（whoopWebhookIngest）只負責把事件耐久收下。真正的工作在這裡：
 *
 *     認領（原子 + 租約）
 *       → 解析本地使用者（權威）
 *       → 向 WHOOP 取 canonical 資料
 *       → 確認所有權還在
 *       → 走**既有的** canonical 儲存層寫入
 *       → 有圍欄地結案
 *
 * ## webhook 不是生理事實的來源
 *
 * payload 只有四個欄位（user_id / id / type / trace_id），裡面根本沒有生理
 * 數值 —— 這不是巧合，官方文件明說「這些是變更的通知，不是變更本身，
 * 你需要呼叫 API 才能拿到最新資料」。所以 UPDATED 事件一律重新去拿，
 * 絕不會有任何欄位從 webhook 直接寫進 canonical 表。
 *
 * ## 寫入一律走既有的儲存層
 *
 * 不另外開一套「webhook 專用」的寫入路徑。V1.1 修好的新鮮度規則
 * （已知較舊不覆蓋已知較新、相同版本冪等、來源版本不明不覆蓋已知版本）
 * 對 webhook 與排程同步必須是**同一套**，否則兩條路遲早會分岔。
 *
 * ## 失敗不可以變成生理上的 0
 *
 * API 失敗、找不到資源、被墓碑擋下 —— 每一種都只改變**事件**的狀態，
 * 絕不會往 canonical 表寫入零值或空值。缺資料在這個系統裡永遠是「缺」。
 */

import { WHOOP_WEBHOOK } from './config.js';
import { WHOOP_EVENT_STATE } from './schema.js';
import { WhoopApiError, WhoopAuthError } from './whoop.js';
import { log, describeError } from './logger.js';

/** 事件處理的結果分類（進日誌與事件帳本，方便事後統計）。 */
export const PROCESS_RESULT = Object.freeze({
  PERSISTED: 'persisted',
  DELETED: 'deleted',
  IGNORED_UNKNOWN_USER: 'ignored_unknown_user',
  IGNORED_INACTIVE_USER: 'ignored_inactive_user',
  IGNORED_RESOURCE_GONE: 'ignored_resource_gone',
  IGNORED_TOMBSTONED: 'ignored_tombstoned',
  FENCED: 'fenced',
  RETRY: 'retry',
  FAILED: 'failed',
});

/** 錯誤類別 → 這個事件該進哪個狀態。 */
export const ERROR_CLASS = Object.freeze({
  AUTH: 'whoop_auth',
  RATE_LIMIT: 'whoop_rate_limit',
  SERVER: 'whoop_server',
  NETWORK: 'whoop_network',
  NOT_FOUND: 'whoop_not_found',
  FORBIDDEN: 'whoop_forbidden',
  MALFORMED: 'whoop_malformed_response',
  CLIENT: 'whoop_client_error',
  INTERNAL: 'internal',
});

/**
 * 把一個錯誤分成「可以重試」與「重試也沒用」。
 *
 * 這個分類是整支模組最重要的判斷：分錯的後果不是少一筆資料，而是
 *   · 把暫時性故障當成終局 → 永久遺失一次真實的生理更新
 *   · 把終局當成可重試     → 無限重試風暴
 */
export function classifyWhoopError(err) {
  if (err instanceof WhoopAuthError) {
    // refresh 之後仍然 401：通常需要重新授權，但也可能是 WHOOP 暫時的問題。
    // 給有限次重試，用完就進終局 FAILED（看得到、查得出來）。
    return { class: ERROR_CLASS.AUTH, retryable: true };
  }
  if (err instanceof WhoopApiError) {
    const status = Number(err.status ?? 0);
    if (status === 404) return { class: ERROR_CLASS.NOT_FOUND, retryable: false, gone: true };
    if (status === 403) return { class: ERROR_CLASS.FORBIDDEN, retryable: false };
    if (status === 429) return { class: ERROR_CLASS.RATE_LIMIT, retryable: true };
    if (status >= 500) return { class: ERROR_CLASS.SERVER, retryable: true };
    if (status === 0) return { class: ERROR_CLASS.NETWORK, retryable: true };
    return { class: ERROR_CLASS.CLIENT, retryable: false };
  }
  // JSON 壞掉／回應形狀不對。
  //
  // 刻意歸成**可重試**：截斷的回應是暫時性的，而把它當終局等於因為一次
  // 中間設備的抽風就永久丟掉一則真實的生理更新。重試次數有上限，
  // 用完之後一樣會進 FAILED，所以這個選擇不會變成重試風暴。
  if (err instanceof SyntaxError || /json|unexpected token/i.test(String(err?.message ?? ''))) {
    return { class: ERROR_CLASS.MALFORMED, retryable: true };
  }
  return { class: ERROR_CLASS.INTERNAL, retryable: true };
}

/** 指數退避（有上限）。 */
export function backoffFor(attempt, {
  base = WHOOP_WEBHOOK.RETRY_BASE_MS, max = WHOOP_WEBHOOK.RETRY_MAX_MS,
} = {}) {
  return Math.min(base * 2 ** Math.max(0, attempt - 1), max);
}

/** 回應看起來像不像我們要的那個資源。 */
function looksLikeResource(obj, idField, expectedId) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  const got = obj[idField];
  if (got === null || got === undefined) return false;
  return String(got) === String(expectedId);
}

/**
 * 取得 UPDATED 事件對應的 canonical 資源。
 *
 * ## sleep / workout
 *
 * 官方有單筆端點，直接取：
 *   GET /activity/sleep/{sleepId}
 *   GET /activity/workout/{workoutId}
 *
 * ## recovery —— 這裡有一個必須寫下來的非對稱
 *
 * v2 的 recovery webhook 給的 `id` 是**該筆睡眠的 UUID**
 * （官方：「The id of the associated sleep (UUID)」），
 * 但單筆 recovery 的端點是用 **cycle** 定址的（`/cycle/{cycleId}/recovery`）。
 * 兩者對不起來，所以**不能**拿 webhook 的 id 去組 recovery 路徑 ——
 * 那會打到一個剛好同號的 cycle，拿回別人的（或別天的）資料。
 *
 * 走一條只用官方端點、而且可證明正確的路：
 *   1. GET /activity/sleep/{sleepId}      取得這筆睡眠（同時確認它存在）
 *   2. 以它的起訖時間為窗，列出 /recovery，挑 sleep_id 完全相符的那一筆
 *
 * 比對 sleep_id 全等是關鍵：不靠「窗裡只有一筆」這種假設。
 */
async function fetchCanonical({ whoop, resourceType, resourceId }) {
  if (resourceType === 'sleep') {
    const sleep = await whoop.apiGet(`/activity/sleep/${encodeURIComponent(resourceId)}`);
    if (!looksLikeResource(sleep, 'id', resourceId)) {
      throw new SyntaxError('whoop sleep response did not match requested id');
    }
    return { kind: 'sleep', record: sleep };
  }

  if (resourceType === 'workout') {
    const workout = await whoop.apiGet(`/activity/workout/${encodeURIComponent(resourceId)}`);
    if (!looksLikeResource(workout, 'id', resourceId)) {
      throw new SyntaxError('whoop workout response did not match requested id');
    }
    return { kind: 'workout', record: workout };
  }

  if (resourceType === 'recovery') {
    const sleep = await whoop.apiGet(`/activity/sleep/${encodeURIComponent(resourceId)}`);
    if (!looksLikeResource(sleep, 'id', resourceId)) {
      throw new SyntaxError('whoop sleep response did not match requested id');
    }
    const startMs = Date.parse(sleep.start);
    const endMs = Date.parse(sleep.end);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
      throw new SyntaxError('whoop sleep response lacked usable start/end');
    }
    const pad = WHOOP_WEBHOOK.RECOVERY_WINDOW_PAD_MS;
    const records = await whoop.recoveries(
      new Date(startMs - pad), new Date(endMs + pad),
    );
    const match = (Array.isArray(records) ? records : [])
      .find((r) => String(r?.sleep_id ?? '') === String(resourceId));
    // 找不到**不是**錯誤：recovery 可能還沒算出來，或真的已經沒有了。
    // 這種情況什麼都不寫（缺就是缺），由呼叫端記成 IGNORED。
    if (!match) return { kind: 'recovery', record: null };
    return { kind: 'recovery', record: match };
  }

  throw new Error(`unsupported_resource_type:${resourceType}`);
}

/** 把 canonical 資料交給**既有的**儲存層（新鮮度／墓碑規則都在那裡）。 */
async function persistCanonical({ db, userId, kind, record, timezone, now }) {
  if (kind === 'sleep') {
    return db.upsertSleeps(userId, [record], { timezone, now });
  }
  if (kind === 'workout') {
    return db.upsertWorkouts(userId, [record], { timezone, now });
  }
  if (kind === 'recovery') {
    return db.upsertRecoveries(userId, [record], { now });
  }
  throw new Error(`unsupported_resource_kind:${kind}`);
}

/**
 * 處理**一則**已經認領到的事件。
 *
 * @param {object} event     claimWhoopEvent 回來的事件
 * @param {string} owner     我們的所有權 token
 * @param {function} whoopFor (userId) => whoop client（重用既有的 token 圍欄）
 */
export async function processWhoopEvent({
  db, event, owner, whoopFor, now = () => new Date(),
}) {
  const at = () => new Date(now());
  const settle = (state, extra = {}) => db.settleWhoopEvent(event.id, {
    owner, state, now: at(), ...extra,
  });

  // ---- 1. 解析本地使用者（權威，而且在處理當下才做）----------------------
  //
  // 刻意不在收下的時候解析：綁定可能在事件排隊期間改變，而唯一安全的答案
  // 是「處理的那一刻是誰」。
  const resolved = await db.resolveUserByWhoopUserId(event.whoopUserId);

  if (resolved.status === 'unknown') {
    log.warn('whoop_webhook_unknown_user', {
      event_id: event.id, whoop_user_id: event.whoopUserId, reason: resolved.reason,
    });
    await settle(WHOOP_EVENT_STATE.IGNORED, {
      errorClass: 'unknown_user', errorDetail: resolved.reason,
    });
    return { result: PROCESS_RESULT.IGNORED_UNKNOWN_USER };
  }
  if (resolved.status === 'ambiguous') {
    // 同一個 WHOOP 帳號對到多個本地使用者 —— 完全不知道該動誰的資料。
    // fail closed 而且要看得見：這是資料完整性問題，不是競態。
    log.error('whoop_webhook_ambiguous_user', {
      event_id: event.id, whoop_user_id: event.whoopUserId, matches: resolved.count,
    });
    await settle(WHOOP_EVENT_STATE.FAILED, {
      errorClass: 'ambiguous_user', errorDetail: `matches=${resolved.count}`,
    });
    return { result: PROCESS_RESULT.FAILED, reason: 'ambiguous_user' };
  }

  const userId = resolved.userId;
  if (resolved.user.status !== 'ACTIVE') {
    // 使用者被停用／暫停：不動他的生理資料，但事件仍然留下紀錄。
    log.info('whoop_webhook_inactive_user', { event_id: event.id, user_status: resolved.user.status });
    await settle(WHOOP_EVENT_STATE.IGNORED, {
      userId, errorClass: 'inactive_user', errorDetail: resolved.user.status,
    });
    return { result: PROCESS_RESULT.IGNORED_INACTIVE_USER };
  }

  // ---- 2. DELETED：立墓碑 + 移除 canonical ---------------------------------
  //
  // action 是從 event_type 推導出來的。推導不出來代表帳本裡有一則我們不認識
  // 的事件類型（例如未來新增了類型但這一版還不支援）—— 那種情況下**什麼都
  // 不做**才是對的，絕不可以「猜它是更新」然後去動生理資料。
  if (event.action !== 'updated' && event.action !== 'deleted') {
    log.warn('whoop_webhook_unknown_action', {
      event_id: event.id, event_type: event.eventType,
    });
    await settle(WHOOP_EVENT_STATE.IGNORED, {
      userId, errorClass: 'unsupported_action', errorDetail: event.eventType,
    });
    return { result: PROCESS_RESULT.IGNORED_RESOURCE_GONE, reason: 'unsupported_action' };
  }

  if (event.action === 'deleted') {
    if (!await db.holdsWhoopEvent(event.id, owner, { now: at() })) {
      log.warn('whoop_webhook_fenced_before_delete', { event_id: event.id });
      return { result: PROCESS_RESULT.FENCED };
    }
    await db.deleteWhoopResource({
      userId,
      resourceType: event.resourceType,
      resourceId: event.resourceId,
      sourceTraceId: event.traceId,
      sourceEventAt: event.eventAt,
      // 帳本 id = WHOOP 告訴我們這件事的順序。之後要判斷「某則更新是刪除
      // 之前還是之後的通知」全靠它（見 supersedeTombstoneIfProven）。
      sourceEventId: event.id,
      now: at(),
    });
    // 重複刪除是冪等的（墓碑 upsert + DELETE 都是），所以重播安全。
    await settle(WHOOP_EVENT_STATE.PROCESSED, { userId });
    return { result: PROCESS_RESULT.DELETED };
  }

  // ---- 3. UPDATED：向 WHOOP 取 canonical ----------------------------------
  let fetched;
  try {
    const whoop = whoopFor(userId);
    fetched = await fetchCanonical({
      whoop, resourceType: event.resourceType, resourceId: event.resourceId,
    });
  } catch (err) {
    const cls = classifyWhoopError(err);
    if (cls.gone) {
      // WHOOP 說這個資源不存在了。**不寫任何東西**（尤其不寫 0），
      // 也不自己推論成刪除 —— 真正的刪除有它自己的事件。
      log.info('whoop_webhook_resource_gone', {
        event_id: event.id, resource_type: event.resourceType,
      });
      await settle(WHOOP_EVENT_STATE.IGNORED, {
        userId, errorClass: cls.class, errorDetail: 'resource_not_found',
      });
      return { result: PROCESS_RESULT.IGNORED_RESOURCE_GONE };
    }
    const exhausted = event.attemptCount >= WHOOP_WEBHOOK.MAX_ATTEMPTS;
    const retryable = cls.retryable && !exhausted;
    log[retryable ? 'warn' : 'error']('whoop_webhook_fetch_failed', {
      event_id: event.id, error_class: cls.class,
      attempt: event.attemptCount, retryable,
    });
    await settle(retryable ? WHOOP_EVENT_STATE.RETRY : WHOOP_EVENT_STATE.FAILED, {
      userId,
      errorClass: cls.class,
      errorDetail: describeError(err),
      nextAttemptAt: retryable
        ? new Date(at().getTime() + backoffFor(event.attemptCount)) : null,
    });
    return { result: retryable ? PROCESS_RESULT.RETRY : PROCESS_RESULT.FAILED, errorClass: cls.class };
  }

  // WHOOP 回 200 但窗裡找不到那筆 recovery：資料還沒產生或已經沒有了。
  // 什麼都不寫。
  if (!fetched.record) {
    await settle(WHOOP_EVENT_STATE.IGNORED, {
      userId, errorClass: 'resource_unavailable', errorDetail: event.resourceType,
    });
    return { result: PROCESS_RESULT.IGNORED_RESOURCE_GONE };
  }

  // ---- 4. 寫入之前**重新確認所有權** --------------------------------------
  //
  // 打 API 可能花很久，租約可能已經過期而且被別人接手。失去所有權就不寫：
  // 接手者會拿到（可能更新的）資料並自己寫入。
  //
  // 就算這一關漏掉，canonical 層的新鮮度規則仍然擋得住「舊蓋新」——
  // 但這裡先擋下來可以避免做白工，也讓「誰有權寫」這件事有單一答案。
  if (!await db.holdsWhoopEvent(event.id, owner, { now: at() })) {
    log.warn('whoop_webhook_fenced_before_persist', { event_id: event.id });
    return { result: PROCESS_RESULT.FENCED };
  }

  // ---- 4b. 墓碑退位：只有在**兩個證據**都成立時 --------------------------
  //
  // canonical 儲存層對有墓碑的資源一律不寫（它沒有辦法判斷通知順序）。
  // 所以「這個資源後來真的又被重建了」的判斷放在這裡 —— 這裡同時看得到
  // 資源版本與事件順序，兩個都對得上才讓墓碑退位。
  //
  // 判斷不成立就什麼都不做：接下來的寫入會被墓碑擋下，事件照樣正常結案。
  if (typeof db.supersedeTombstoneIfProven === 'function') {
    await db.supersedeTombstoneIfProven({
      userId,
      resourceType: event.resourceType,
      resourceId: event.resourceId,
      incomingUpdatedAt: fetched.record?.updated_at
        ? new Date(fetched.record.updated_at).toISOString() : null,
      eventId: event.id,
      now: at(),
    });
  }

  // ---- 5. 走既有的 canonical 儲存層 ---------------------------------------
  let written;
  try {
    written = await persistCanonical({
      db, userId, kind: fetched.kind, record: fetched.record,
      timezone: resolved.user.timezone ?? 'UTC', now: at(),
    });
  } catch (err) {
    const exhausted = event.attemptCount >= WHOOP_WEBHOOK.MAX_ATTEMPTS;
    log.error('whoop_webhook_persist_failed', {
      event_id: event.id, error: describeError(err),
    });
    await settle(exhausted ? WHOOP_EVENT_STATE.FAILED : WHOOP_EVENT_STATE.RETRY, {
      userId,
      errorClass: ERROR_CLASS.INTERNAL,
      errorDetail: describeError(err),
      nextAttemptAt: exhausted ? null : new Date(at().getTime() + backoffFor(event.attemptCount)),
    });
    return { result: exhausted ? PROCESS_RESULT.FAILED : PROCESS_RESULT.RETRY };
  }

  // written === 0 有兩種可能，而且兩種都是**正確**的結果：
  //   · 新鮮度守衛擋下：進來的版本不比資料庫裡那一版新
  //   · 墓碑擋下：這個資源已經被刪除，而且證明不了它之後又更新了
  // 兩種都不是失敗，也都不需要重試。
  const settled = await settle(WHOOP_EVENT_STATE.PROCESSED, { userId });
  if (!settled) {
    // 結案時發現所有權已經不在了。canonical 已經寫了，但那是冪等且受
    // 新鮮度保護的，所以不會造成錯誤資料；事件本身交給接手者結案。
    log.warn('whoop_webhook_fenced_at_settle', { event_id: event.id });
    return { result: PROCESS_RESULT.FENCED, written };
  }
  log.info('whoop_webhook_processed', {
    event_id: event.id, resource_type: event.resourceType, rows_written: written,
  });
  return { result: PROCESS_RESULT.PERSISTED, written };
}

/**
 * 排空：把還沒處理完的事件一則一則處理掉。
 *
 * ⚠️ **Phase 1 刻意沒有把它接進排程器。** 正式環境的 webhook 本來就是關閉的，
 * 而把攝取接進 V1.1 剛穩定下來的排程器是 Phase 2 的事。這裡提供的是一個
 * 乾淨、可測試、可由腳本手動呼叫的入口。
 */
export async function drainWhoopWebhookEvents({
  db, whoopFor, owner, now = () => new Date(),
  batch = WHOOP_WEBHOOK.DRAIN_BATCH,
  leaseMs = WHOOP_WEBHOOK.LEASE_MS,
  maxAttempts = WHOOP_WEBHOOK.MAX_ATTEMPTS,
}) {
  const summary = { claimed: 0, results: {} };
  for (let i = 0; i < batch; i += 1) {
    const event = await db.claimWhoopEvent({
      owner, leaseMs, now: new Date(now()), maxAttempts,
    });
    if (!event) break;
    summary.claimed += 1;
    let outcome;
    try {
      const r = await processWhoopEvent({ db, event, owner, whoopFor, now });
      outcome = r.result;
    } catch (err) {
      // processWhoopEvent 內部已經盡量自己處理；這是最後一道防線，
      // 絕不讓一則事件把整個排空打斷。
      log.error('whoop_webhook_process_unhandled', {
        event_id: event.id, error: describeError(err),
      });
      await db.settleWhoopEvent(event.id, {
        owner,
        state: event.attemptCount >= maxAttempts
          ? WHOOP_EVENT_STATE.FAILED : WHOOP_EVENT_STATE.RETRY,
        errorClass: ERROR_CLASS.INTERNAL,
        errorDetail: describeError(err),
        nextAttemptAt: event.attemptCount >= maxAttempts
          ? null : new Date(new Date(now()).getTime() + backoffFor(event.attemptCount)),
        now: new Date(now()),
      }).catch(() => false);
      outcome = PROCESS_RESULT.RETRY;
    }
    summary.results[outcome] = (summary.results[outcome] ?? 0) + 1;
  }
  return summary;
}
