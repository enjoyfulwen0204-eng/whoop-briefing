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
import { WHOOP_EVENT_STATE, TOMBSTONE_STATE } from './schema.js';
import { WhoopApiError, WhoopAuthError } from './whoop.js';
import { isAccountInactiveError } from './accountLifecycle.js';
import { log, describeError } from './logger.js';

/** 事件處理的結果分類（進日誌與事件帳本，方便事後統計）。 */
export const PROCESS_RESULT = Object.freeze({
  PERSISTED: 'persisted',
  DELETED: 'deleted',
  IGNORED_UNKNOWN_USER: 'ignored_unknown_user',
  IGNORED_INACTIVE_USER: 'ignored_inactive_user',
  IGNORED_RESOURCE_GONE: 'ignored_resource_gone',
  /** 有生效中的墓碑 → 刻意不寫。這是 Phase 1 的保守政策結果，不是失敗。 */
  BLOCKED_BY_TOMBSTONE: 'blocked_by_active_tombstone',
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

const WHOOP_WEBHOOP_MAX_ATTEMPTS = () => WHOOP_WEBHOOK.MAX_ATTEMPTS;

/** 指數退避（有上限）。 */
export function backoffFor(attempt, {
  base = WHOOP_WEBHOOK.RETRY_BASE_MS, max = WHOOP_WEBHOOK.RETRY_MAX_MS,
} = {}) {
  return Math.min(base * 2 ** Math.max(0, attempt - 1), max);
}

/** 這個錯誤是不是「所有權已經不在了」（變更交易被圍欄擋下）。 */
export function isOwnershipLost(err) {
  return String(err?.message ?? '') === 'whoop_event_ownership_lost';
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
 * @param {function} whoopFor (userId, { expectedLifecycleGeneration }) => whoop client
 *   （重用既有的 token 圍欄；啟用脈絡讓例行 refresh 也受同一段啟用期約束）
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
  const accountActive = resolved.user.status === 'ACTIVE';
  // ★ v17：捕捉這一則事件開始處理時的帳號啟用世代，往下帶進 provider 抓取
  // 與 canonical 寫入 —— 抓資料要時間，帳號可能在那之間被停用。
  const eventLifecycleGeneration = Number.isInteger(resolved.user.lifecycleGeneration)
    ? resolved.user.lifecycleGeneration : null;

  // ---- ★ v17 §38：DELETE 是**例外**，而且是刻意的 --------------------
  //
  // 其他所有處理都在帳號非 ACTIVE 時停止。但 provider 的刪除**減少**我們
  // 保留的資料，而且它是來源真相：把它擋下來，等於在使用者已經在 WHOOP
  // 那邊刪掉資料之後，我們還替一個被停用的帳號留著那份生理資料 ——
  // 那是隱私上錯的方向，也會讓 Phase 1 的墓碑不變量出現破洞
  // （事件被終局忽略，但 canonical 列還在）。
  //
  // 所以停用帳號的 DELETE 仍然執行**本地**的墓碑 + canonical 刪除，
  // 但不抓 provider 資料、不跑分析、不送任何通知。
  if (!accountActive && event.action !== 'deleted') {
    // 使用者被停用／暫停：不動他的生理資料，但事件仍然留下紀錄。
    log.info('whoop_webhook_inactive_user', { event_id: event.id, user_status: resolved.user.status });
    await settle(WHOOP_EVENT_STATE.IGNORED, {
      userId, errorClass: 'inactive_user', errorDetail: resolved.user.status,
    });
    return { result: PROCESS_RESULT.IGNORED_INACTIVE_USER };
  }
  if (!accountActive) {
    log.info('whoop_webhook_inactive_user_delete', {
      event_id: event.id, user_status: resolved.user.status,
    });
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
    // ★ P1-R02：墓碑 + 實體刪除在**同一個交易**裡，而且交易本身證明所有權。
    //
    // 不是「先 holdsWhoopEvent() 回 true，再去刪」—— 那中間租約可能過期、
    // 別人可能接手。所有權的證明就在交易的 before / after 裡，不成立就整個
    // rollback：不會留下「有墓碑但列還在」或「列沒了但沒有墓碑」的半套狀態。
    let deletion;
    try {
      deletion = await db.mutateForWhoopEvent(event.id, { owner, now }, () => db.deleteWhoopResource({
        userId,
        resourceType: event.resourceType,
        resourceId: event.resourceId,
        sourceTraceId: event.traceId,
        sourceEventAt: event.eventAt,
        // 純診斷。帳本 id 是**本地收下**的順序，不是 WHOOP 的來源時序，
        // 絕不拿它推論任何事情。
        sourceEventId: event.id,
        now: at(),
      }));
    } catch (err) {
      if (isOwnershipLost(err)) {
        log.warn('whoop_webhook_fenced_delete', { event_id: event.id });
        return { result: PROCESS_RESULT.FENCED };
      }
      // 交易失敗（rollback 已經發生）→ 事件仍然是 PROCESSING，
      // 由租約過期後的重新認領處理；這裡不結案，避免蓋掉真正的錯誤。
      log.error('whoop_webhook_delete_failed', { event_id: event.id, error: describeError(err) });
      const exhausted = event.attemptCount >= WHOOP_WEBHOOP_MAX_ATTEMPTS();
      await settle(exhausted ? WHOOP_EVENT_STATE.FAILED : WHOOP_EVENT_STATE.RETRY, {
        userId, errorClass: ERROR_CLASS.INTERNAL, errorDetail: describeError(err),
        nextAttemptAt: exhausted ? null : new Date(at().getTime() + backoffFor(event.attemptCount)),
      });
      return { result: exhausted ? PROCESS_RESULT.FAILED : PROCESS_RESULT.RETRY };
    }
    // 重複刪除是冪等的（墓碑 upsert + DELETE 都是），所以崩潰後重播安全。
    await settle(WHOOP_EVENT_STATE.PROCESSED, {
      userId, errorClass: null,
      errorDetail: deletion.removed ? 'deleted' : 'delete_idempotent_replay',
    });
    return { result: PROCESS_RESULT.DELETED, removed: deletion.removed };
  }

  // ---- 3. UPDATED：向 WHOOP 取 canonical ----------------------------------
  let fetched;
  try {
    // ★ R3 / R2-FG-01：client 也要帶啟用脈絡 —— 抓資料途中可能觸發
    // 例行 refresh，而那個寫入必須屬於同一段啟用期。
    const whoop = await whoopFor(userId, { expectedLifecycleGeneration: eventLifecycleGeneration });
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

  // ---- 4. 變更：所有權證明 + 墓碑判定 + canonical 寫入，同一個交易 ---------
  //
  // ★ P1-R02：不是「先檢查所有權、再檢查墓碑、再寫」三個分開的步驟 ——
  // 每兩步之間都是一個可以被 DELETE 或接手者插進來的空窗。
  // 全部放進同一個交易：交易的 before/after 證明所有權，墓碑判定與寫入
  // 在交易裡讀寫同一份狀態，DELETE 不可能插在中間。
  //
  // ★ P1-R01：有生效中的墓碑就**不寫**，沒有任何例外。Phase 1 沒有能力
  // 分辨「延遲抵達的刪除前更新」與「刪除後的真正重建」，兩者一律維持墓碑。
  let mutation;
  try {
    mutation = await db.mutateForWhoopEvent(event.id, { owner, now }, async () => {
      // ★ v17：抓 provider 資料要時間；在**同一個交易裡**再證明一次帳號仍然
      // ACTIVE 且仍在同一段啟用期，否則這份 canonical 更新不屬於現在這個帳號。
      // 拋出去 → 交易回滾 → 沒有 canonical 寫入、也沒有分析失效。
      await db.assertAccountActive(userId, eventLifecycleGeneration);
      const tomb = await db.getTombstone(userId, event.resourceType, event.resourceId);
      if (tomb && tomb.state === TOMBSTONE_STATE.ACTIVE) {
        await db.recordTombstoneBlock({
          userId, resourceType: event.resourceType, resourceId: event.resourceId, now: at(),
        });
        return { blocked: true, written: 0 };
      }
      const written = await persistCanonical({
        db, userId, kind: fetched.kind, record: fetched.record,
        timezone: resolved.user.timezone ?? 'UTC', now: at(),
      });
      return { blocked: false, written };
    });
  } catch (err) {
    if (isAccountInactiveError(err)) {
      // 帳號在抓取途中被停用（或換了啟用期）。事件仍然結案留痕，
      // 但沒有任何 canonical 變更，也沒有分析失效。
      log.info('whoop_webhook_lifecycle_rejected', { event_id: event.id });
      await settle(WHOOP_EVENT_STATE.IGNORED, {
        userId, errorClass: 'inactive_user', errorDetail: 'lifecycle_changed',
      });
      return { result: PROCESS_RESULT.IGNORED_INACTIVE_USER };
    }
    if (isOwnershipLost(err)) {
      log.warn('whoop_webhook_fenced_before_persist', { event_id: event.id });
      return { result: PROCESS_RESULT.FENCED };
    }
    const exhausted = event.attemptCount >= WHOOP_WEBHOOP_MAX_ATTEMPTS();
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

  if (mutation.blocked) {
    // 保守政策的正常結果：處理**成功地**判定不可以寫。終局、可診斷、不重試。
    log.info('whoop_webhook_blocked_by_tombstone', {
      event_id: event.id, resource_type: event.resourceType,
    });
    const settled = await settle(WHOOP_EVENT_STATE.PROCESSED, {
      userId, errorClass: 'tombstone', errorDetail: PROCESS_RESULT.BLOCKED_BY_TOMBSTONE,
    });
    return { result: settled ? PROCESS_RESULT.BLOCKED_BY_TOMBSTONE : PROCESS_RESULT.FENCED };
  }
  const written = mutation.written;

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
 * 正式環境由 canonical scheduler 呼叫這個同一入口；本機腳本也沿用它。
 * 每輪最多處理 batch 則，所以 backlog 會安全留給下一輪，不會壟斷排程器。
 */
export async function drainWhoopWebhookEvents({
  db, whoopFor, owner, now = () => new Date(),
  batch = WHOOP_WEBHOOK.DRAIN_BATCH,
  leaseMs = WHOOP_WEBHOOK.LEASE_MS,
  maxAttempts = WHOOP_WEBHOOK.MAX_ATTEMPTS,
}) {
  const summary = {
    claimed: 0, processed: 0, ignored: 0, retryable: 0, failed: 0, fenced: 0,
    remaining: null, results: {},
  };
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
      const exhausted = event.attemptCount >= maxAttempts;
      await db.settleWhoopEvent(event.id, {
        owner,
        state: exhausted ? WHOOP_EVENT_STATE.FAILED : WHOOP_EVENT_STATE.RETRY,
        errorClass: ERROR_CLASS.INTERNAL,
        errorDetail: describeError(err),
        nextAttemptAt: exhausted
          ? null : new Date(new Date(now()).getTime() + backoffFor(event.attemptCount)),
        now: new Date(now()),
      }).catch(() => false);
      outcome = exhausted ? PROCESS_RESULT.FAILED : PROCESS_RESULT.RETRY;
    }
    summary.results[outcome] = (summary.results[outcome] ?? 0) + 1;
  }
  const countResults = (...keys) => keys.reduce((n, key) => n + (summary.results[key] ?? 0), 0);
  summary.processed = countResults(
    PROCESS_RESULT.PERSISTED, PROCESS_RESULT.DELETED, PROCESS_RESULT.BLOCKED_BY_TOMBSTONE,
  );
  summary.ignored = countResults(
    PROCESS_RESULT.IGNORED_UNKNOWN_USER,
    PROCESS_RESULT.IGNORED_INACTIVE_USER,
    PROCESS_RESULT.IGNORED_RESOURCE_GONE,
  );
  summary.retryable = countResults(PROCESS_RESULT.RETRY);
  summary.failed = countResults(PROCESS_RESULT.FAILED);
  summary.fenced = countResults(PROCESS_RESULT.FENCED);
  // 輕量 backlog 觀測：只數事件狀態，不讀 payload，也不讓統計失敗推翻已完成的處理。
  try {
    const stats = await db.whoopEventStats();
    const pendingStates = new Set([
      WHOOP_EVENT_STATE.RECEIVED, WHOOP_EVENT_STATE.RETRY, WHOOP_EVENT_STATE.PROCESSING,
    ]);
    summary.remaining = stats
      .filter((row) => pendingStates.has(row.state))
      .reduce((n, row) => n + Number(row.count ?? 0), 0);
  } catch (err) {
    log.warn('whoop_webhook_backlog_stats_failed', { error: describeError(err) });
  }
  return summary;
}
