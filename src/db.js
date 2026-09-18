/**
 * Turso (libSQL) 持久化層。
 *
 * 執行環境（Render Cron Job）的檔案系統是 ephemeral，所以「所有跨執行狀態」
 * 都存在 Turso，絕不使用本機 JSON / 檔案。
 *
 * ## Multi-user
 *
 * 所有「屬於某個人」的操作**第一個參數一律是 userId**，而且用
 * requireUserId() 硬性檢查 —— 缺就拋錯，絕不 fallback 到某個預設使用者。
 * 刻意保持全域的只有：resource_locks（表結構）、telegram_state（bot offset）、
 * 以及 error_notifications 的 'global' scope。
 */

import { createClient } from '@libsql/client';
import { randomUUID } from 'node:crypto';
import {
  GLOBAL_SCOPE, userScope, TELEGRAM_DELIVERY_STATE, TELEGRAM_UPDATE_STATUS,
  REPORT_DELIVERY_STATE, USER_STATUS, lifecycleActiveSql,
} from './schema.js';
import { AccountInactiveError, requireLifecycle } from './accountLifecycle.js';

const TELEGRAM_UPDATE_STATUS_COMPLETED = TELEGRAM_UPDATE_STATUS.COMPLETED;
const TELEGRAM_UPDATE_STATUS_ABANDONED = TELEGRAM_UPDATE_STATUS.ABANDONED;
import { runMigrations } from './migrations.js';
import { requireUserId } from './userContext.js';
import { createIdentityStore } from './identityStore.js';
import { createHealthStore } from './store.js';
import { createWhoopWebhookStore } from './whoopWebhookStore.js';
import { createReconciliationStore } from './reconciliationStore.js';
import { createAnalyticsWorkStore } from './analyticsWorkStore.js';
import { createOnboardingStore } from './onboardingStore.js';
import { withAnalyticsInvalidation } from './analyticsInvalidation.js';
import { createBotStore } from './botStore.js';
import { createAnalysisStore } from './analysisStore.js';
import { createProactiveStore } from './proactiveStore.js';
import { createGuardianStore } from './guardianStore.js';
import { log } from './logger.js';
import { processingTransactions } from './processingTransaction.js';

// SCHEMA 定義集中在 schema.js（唯一 DDL 來源）。這裡 re-export 維持既有 import 路徑。
export { SCHEMA } from './schema.js';

/**
 * 是不是撞到唯一索引（同一天、同一種報告已經有一筆 SENT）。
 *
 * 刻意只認 UNIQUE，不認整個 SQLITE_CONSTRAINT —— NOT NULL / CHECK 之類的違反
 * 是程式 bug，必須浮出來，不能跟「另一個 run 已送出」混為一談。
 * 實測 Turso 回的是 code='SQLITE_CONSTRAINT'、message 含 'UNIQUE constraint failed'。
 */
export function isDuplicateSentError(err) {
  return /UNIQUE constraint failed/i.test(String(err?.message ?? ''));
}

export function createDb({ url, authToken }) {
  const processing = processingTransactions(createClient({ url, authToken }));
  const { client } = processing;
  const health = createHealthStore(client, { transaction: processing.transaction });
  const webhook = createWhoopWebhookStore(client);
  // 輸出寫入走 processing.transaction 的所有權圍欄（F01）。
  const analytics = createAnalyticsWorkStore(client, { transaction: processing.transaction });

  async function withAnswerOwnership(userId, ownership, now, fn) {
    const uid = requireUserId(userId, 'withAnswerOwnership');
    if (!ownership?.owner) throw new Error('answer_ownership_required');
    const checkLease = async () => {
      if (!await holdsLock(ownership.name, ownership.owner, { now: new Date(now()) })) {
        throw new Error('answer_ownership_lost');
      }
    };
    return processing.transaction(fn, {
      before: async () => {
        await checkLease();
        const result = await client.execute({
          sql: 'SELECT id FROM proactive_events WHERE id = ? AND user_id = ? AND outcome IS NULL',
          args: [ownership.eventId, uid],
        });
        if (!result.rows.length) throw new Error('answer_event_settled');
      },
      after: checkLease,
    });
  }

  /**
   * 動作與收據同一個交易。
   *
   * 重播時回傳**已存的結果**而不重跑動作 —— 這是「同一則訊息不會寫出第二筆
   * journal」的根本保證。前後都用 `check` 圍欄確認所有權還在（fencing）。
   *
   * 收據一併帶上送達狀態的起點：有回覆就是 ACTION_READY（可以安全地送），
   * 沒有回覆就是 NOT_REQUIRED（本來就不需要送）。
   */
  async function processTelegramOperation(updateId, { owner, now = () => new Date() }, fn) {
    const id = Number(updateId);
    if (!Number.isSafeInteger(id) || id < 0) throw new Error('invalid_update_id');
    const check = async () => {
      const r = await client.execute({
        sql: `SELECT update_id FROM telegram_processed_updates
              WHERE update_id = ? AND owner = ? AND status = 'PROCESSING' AND lease_expires_at > ?`,
        args: [id, owner, new Date(now()).toISOString()],
      });
      if (!r.rows.length) throw new Error('telegram_processing_ownership_lost');
    };
    return processing.transaction(async () => {
      const prior = await client.execute({
        sql: 'SELECT result_json FROM telegram_operations WHERE update_id = ?',
        args: [id],
      });
      if (prior.rows.length) return JSON.parse(prior.rows[0].result_json);
      const result = await fn();
      await client.execute({
        sql: `INSERT INTO telegram_operations
                (update_id, result_json, committed_at, delivery_state, delivery_attempts)
              VALUES (?, ?, ?, ?, 0)`,
        args: [
          id, JSON.stringify(result ?? null), new Date(now()).toISOString(),
          result?.reply ? TELEGRAM_DELIVERY_STATE.ACTION_READY : TELEGRAM_DELIVERY_STATE.NOT_REQUIRED,
        ],
      });
      return result;
    }, { before: check, after: check });
  }

  /**
   * 代表某則 WHOOP webhook 事件執行 canonical / 墓碑變更（V1.2 Phase 1，P1-R02）。
   *
   * ## 這是唯一允許的變更邊界
   *
   * 「先用 JavaScript 檢查所有權，回 true，**之後**才變更」不夠：
   * 檢查與變更之間租約可能過期、別人可能接手，於是一個已經失去所有權的
   * 舊執行仍然把它手上（可能已經過時的）結果寫進 canonical。
   *
   * 所以所有權的證明必須是**變更交易的一部分**：
   *   · 交易開始時驗（before）：event id + owner + PROCESSING + 租約仍有效
   *   · 變更做完、commit 之前再驗一次（after）
   *   · 任一次不成立 → 整個交易 rollback，**一個位元組都不會落地**
   *
   * fn 裡面的每一個 client.execute / batch 都自動走同一個交易
   * （processingTransaction 的 Proxy），所以 upsertSleeps / deleteWhoopResource
   * 這些既有的儲存層函式不需要知道自己在交易裡 —— 這正是重用既有
   * 新鮮度規則而不分叉的方法。
   *
   * ## 不在交易裡等網路
   *
   * WHOOP API GET 一定在呼叫這支函式**之前**完成。交易只包 DB 變更。
   *
   * @throws {Error} message = 'whoop_event_ownership_lost' 代表被圍欄擋下，
   *   呼叫端**不可以**再做任何變更、也不可以結案（那一則現在屬於接手者）。
   */
  async function mutateForWhoopEvent(eventId, { owner, now = () => new Date() }, fn) {
    const id = Number(eventId);
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error('invalid_whoop_event_id');
    if (!owner) throw new Error('whoop_event_owner_required');
    const check = async () => {
      const r = await client.execute({
        sql: `SELECT 1 FROM whoop_webhook_events
               WHERE id = ? AND owner = ? AND state = ? AND lease_expires_at > ? LIMIT 1`,
        args: [id, String(owner), 'PROCESSING', new Date(now()).toISOString()],
      });
      if (!r.rows.length) throw new Error('whoop_event_ownership_lost');
    };
    return processing.transaction(fn, { before: check, after: check });
  }

  /**
   * 代表某個 (user, resource) 的對帳執行寫入 canonical（V1.2 Phase 2）。
   *
   * 與 mutateForWhoopEvent 完全同一個模式：所有權（owner + 租約仍有效）的證明
   * 是交易的 before 與 after，任一次不成立就整個 rollback。
   *
   * 為什麼 canonical 寫入也要圍欄，而不只圍水位：
   * 失去所有權的舊執行手上的資料**通常**會被新鮮度規則擋下（同版或較舊），
   * 但「通常」不是不變量。把它擋在交易門口，答案就只有一個。
   *
   * 交易只包 DB 寫入；WHOOP API 一定在呼叫之前完成。
   *
   * @throws {Error} message = 'reconcile_ownership_lost'
   */
  async function mutateForReconciliation({ userId, resource, owner, now = () => new Date() }, fn) {
    const uid = requireUserId(userId, 'mutateForReconciliation');
    if (!owner) throw new Error('reconcile_owner_required');
    const check = async () => {
      const r = await client.execute({
        sql: `SELECT 1 FROM whoop_reconciliation_state
               WHERE user_id = ? AND resource = ? AND owner = ? AND lease_expires_at > ? LIMIT 1`,
        args: [uid, resource, String(owner), new Date(now()).toISOString()],
      });
      if (!r.rows.length) throw new Error('reconcile_ownership_lost');
    };
    return processing.transaction(fn, { before: check, after: check });
  }

  /**
   * DELIVERY_STARTED → NOT_REQUIRED（這則回覆**刻意**不送）。
   *
   * 用在送出前的綁定守衛擋下的情況（HRD-R03）：chat 已經不屬於當初產生這則
   * 回覆的人了。那不是失敗，而是一個終局的正確決定 —— 所以不重試、也不留下
   * 「還沒送」的狀態去誘發未來重送。
   */
  async function markDeliverySuppressed(updateId, { owner, now = new Date() } = {}) {
    const id = Number(updateId);
    if (!Number.isSafeInteger(id) || !owner) return false;
    const rs = await client.execute({
      sql: `UPDATE telegram_operations
               SET delivery_state = ?, delivered_at = NULL, telegram_message_id = NULL
             WHERE update_id = ? AND delivery_owner = ? AND delivery_state = ?`,
      args: [TELEGRAM_DELIVERY_STATE.NOT_REQUIRED, id, String(owner),
        TELEGRAM_DELIVERY_STATE.DELIVERY_STARTED],
    });
    return Number(rs.rowsAffected ?? 0) > 0;
  }

  /**
   * 記下這一則 update 屬於哪一個**對話**。
   *
   * ⚠️ 關鍵在「什麼時候寫」：必須在認領之後、**解析內部身分之前**。
   *
   * TG-R04 的根因就是這個順序反了。內部 user_id 要查資料庫才知道，而在
   * 「已認領但還沒查完」的那段空窗裡，這一列的對話欄位是 NULL —— 後來的
   * 訊息去問「有沒有更早的還沒做完」時看不到它，於是超車。
   *
   * 對話鍵可以純粹從 Update 的結構推導（見 conversationKeyOf），不需要查
   * 任何東西，所以可以在認領的當下就落地，空窗因此不存在。
   */
  async function setTelegramUpdateConversation(updateId, { owner, conversationKey, now = new Date() } = {}) {
    const id = Number(updateId);
    if (!Number.isSafeInteger(id) || !owner || !conversationKey) return false;
    const rs = await client.execute({
      sql: `UPDATE telegram_processed_updates SET user_id = ?
             WHERE update_id = ? AND owner = ? AND lease_expires_at > ?`,
      args: [String(conversationKey), id, String(owner), now.toISOString()],
    });
    return Number(rs.rowsAffected ?? 0) > 0;
  }

  /**
   * 這個**對話**有沒有更早、而且還沒到終局的訊息？
   *
   * Telegram 的 update_id 單調遞增，所以「比我小而且還沒到終局」就是
   * 「有一則更早的訊息還沒處理完」。有的話這一則就要讓路。
   *
   * ⚠️ 這個判斷是**嚴格**的：沒有任何寬限、沒有任何「太舊就當它不存在」。
   *
   * 舊版用寬限期直接在查詢裡忽略太舊的那一則，於是出現一個更糟的狀態：
   * 後面的訊息被放行了，而前面那一則**仍然可以恢復並執行** —— 最後的執行
   * 順序變成 ["N+1", "N"]。
   *
   * 「久到沒人在推進了」現在的處置是**先把它原子地終結掉**
   * （abandonStaleConversationUpdates），終結成功之後這裡自然就看不到它了。
   * 先終結、再放行 —— 絕不放行一個還能回來的舊工作。
   */
  async function hasEarlierUnfinishedInConversation(conversationKey, updateId) {
    const id = Number(updateId);
    if (!Number.isSafeInteger(id) || !conversationKey) return false;
    const rs = await client.execute({
      sql: `SELECT 1 FROM telegram_processed_updates
             WHERE user_id = ? AND update_id < ?
               AND status NOT IN (?, ?)
             LIMIT 1`,
      args: [String(conversationKey), id,
        TELEGRAM_UPDATE_STATUS_COMPLETED, TELEGRAM_UPDATE_STATUS_ABANDONED],
    });
    return rs.rows.length > 0;
  }

  /**
   * 把這個對話裡「久到不可能還有人在推進」的更早訊息**原子地終結掉**。
   *
   * ## 為什麼必須先終結才能放行
   *
   * 只是在查詢裡忽略它，等於「後面的先跑，而前面那則之後還能回來跑」——
   * 那正是 TG-R04-B。規則只有兩個選項：要嘛嚴格照順序，要嘛把舊工作徹底
   * 放棄掉；**不可以**放行之後還讓它復活。
   *
   * ## 怎麼算「久到不可能」
   *
   * 租約已經過期，而且過期超過 graceMs。租約本身遠短於 graceMs，所以正常的
   * 重送與接手完全不會走到這裡 —— 只有真的沒人再碰的才會。
   *
   * ## 圍欄：把舊 owner 弄死
   *
   * 終局狀態 + `owner = NULL` + `lease_expires_at = NULL` 三件一起寫。
   * 舊的執行如果之後醒過來，它的每一個副作用邊界都會失敗：
   *   · markTelegramUpdateProcessing  需要 status = CLAIMED         → 不成立
   *   · processTelegramOperation 的圍欄 需要 PROCESSING + owner + 活租約 → 不成立
   *   · completeTelegramUpdate         需要 owner 相符               → 不成立
   * 所以它寫不了 Journal、打不了 OpenRouter、送不出 Telegram、也結不了案。
   *
   * ## 與送達狀態合作
   *
   * 已經確認送達（DELIVERED）的那一則，終局狀態用 COMPLETED 比較誠實 ——
   * 它其實做完了，只是死在標記之前。其餘一律 ABANDONED。兩者都是終局，
   * 都不會觸發重送。
   *
   * @returns {number} 被終結的筆數
   */
  async function abandonStaleConversationUpdates(conversationKey, updateId, {
    now = new Date(), graceMs = 0, reason = 'stale_ordering_cleanup',
  } = {}) {
    const id = Number(updateId);
    if (!Number.isSafeInteger(id) || !conversationKey) return 0;
    const nowIso = now.toISOString();
    const cutoff = new Date(now.getTime() - Math.max(0, graceMs)).toISOString();
    const rs = await client.execute({
      sql: `UPDATE telegram_processed_updates
               SET status = CASE
                     WHEN (SELECT o.delivery_state FROM telegram_operations o
                            WHERE o.update_id = telegram_processed_updates.update_id) = ?
                       THEN ? ELSE ? END,
                   processed_at     = ?,
                   owner            = NULL,
                   lease_expires_at = NULL
             WHERE user_id = ? AND update_id < ?
               AND status NOT IN (?, ?)
               AND lease_expires_at IS NOT NULL
               AND lease_expires_at <= ?`,
      args: [
        TELEGRAM_DELIVERY_STATE.DELIVERED,
        TELEGRAM_UPDATE_STATUS.COMPLETED, TELEGRAM_UPDATE_STATUS.ABANDONED,
        nowIso,
        String(conversationKey), id,
        TELEGRAM_UPDATE_STATUS.COMPLETED, TELEGRAM_UPDATE_STATUS.ABANDONED,
        cutoff,
      ],
    });
    const n = Number(rs.rowsAffected ?? 0);
    if (n) {
      log.warn('telegram_stale_updates_terminalized', {
        conversation: String(conversationKey), before_update_id: id, count: n, reason,
      });
    }
    return n;
  }

  /** 讀一則 update 的動作／送達收據。沒有就回 null。 */
  async function getTelegramOperation(updateId) {
    const id = Number(updateId);
    if (!Number.isSafeInteger(id) || id < 0) return null;
    const rs = await client.execute({
      sql: `SELECT update_id, committed_at, delivery_state, delivery_owner,
                   delivery_started_at, delivered_at, telegram_message_id, delivery_attempts
              FROM telegram_operations WHERE update_id = ?`,
      args: [id],
    });
    const r = rs.rows[0];
    if (!r) return null;
    return {
      updateId: Number(r.update_id),
      committedAt: r.committed_at,
      deliveryState: String(r.delivery_state ?? TELEGRAM_DELIVERY_STATE.DELIVERED),
      deliveryOwner: r.delivery_owner ?? null,
      deliveryStartedAt: r.delivery_started_at ?? null,
      deliveredAt: r.delivered_at ?? null,
      telegramMessageId: r.telegram_message_id === null || r.telegram_message_id === undefined
        ? null : Number(r.telegram_message_id),
      deliveryAttempts: Number(r.delivery_attempts ?? 0),
    };
  }

  /**
   * ACTION_READY → DELIVERY_STARTED。**在打網路之前**呼叫。
   *
   * 這一筆寫入就是「從這一刻起，Telegram 可能已經收到了」的持久化事實。
   * 少了它，死在送出過程中的執行與死在送出之前的執行長得一模一樣。
   *
   * ## 為什麼這裡要驗的不只是 delivery_state（H-03）
   *
   * 舊版只檢查 `delivery_state = ACTION_READY`。那擋得住「同一則被送兩次」，
   * 但擋不住**順序被破壞**：
   *
   *   N 進入 PROCESSING，卡住
   *   N 的租約過期 → abandonStaleConversationUpdates 把它終結成 ABANDONED，
   *                  owner 與租約一起清空
   *   N+1 放行、處理、送出
   *   N 的 JavaScript 恢復執行 → 它手上的 operation 收據還是 ACTION_READY
   *                            → 舊版讓它通過，於是使用者在 N+1 之後才收到 N
   *
   * 「失去所有權的執行不可以因為 CPU 排到它就重新取得權力」（全域不變量 8）。
   * 所以送出授權必須**原子地**證明整條所有權鏈都還在：
   *
   *   1. 這則 update 還是我的           p.owner = ?
   *   2. 它還在 PROCESSING              p.status = 'PROCESSING'
   *   3. 我的租約現在還有效             p.lease_expires_at > now
   *   4. 對話鍵沒被換掉                 p.user_id = ?
   *   5. 這個對話裡沒有更早、未終局的    NOT EXISTS(...)
   *   6. 收據還在可送狀態               delivery_state = ACTION_READY
   *
   * 第 5 條就是「排序權」：只有對話裡最早的那一則有資格製造外部副作用。
   * 全部寫在同一句 SQL 裡，所以「檢查完到寫入之間」那個空窗不存在。
   *
   * 記憶體裡的 lane lock 仍然保留（它便宜、擋掉大多數併發），但**權威是
   * 資料庫**：lane lock 只是最佳化，這裡才是正確性邊界。
   *
   * @param {string} conversationKey 這則 update 的對話鍵（tg:<chat_id>）。
   *   缺它就沒辦法證明第 4、5 條 → 一律拒絕（fail closed）。
   */
  async function markDeliveryStarted(updateId, { owner, conversationKey = null, now = new Date() } = {}) {
    const id = Number(updateId);
    if (!Number.isSafeInteger(id) || !owner) return false;
    // 對話鍵是排序權的判準。證明不了就不授權 —— 寧可少送一則，
    // 也不要在順序上說謊。
    if (!conversationKey) {
      log.warn('telegram_delivery_start_no_conversation', { update_id: id });
      return false;
    }
    const nowIso = now.toISOString();
    const rs = await client.execute({
      sql: `UPDATE telegram_operations
               SET delivery_state = ?, delivery_owner = ?, delivery_started_at = ?,
                   delivery_attempts = delivery_attempts + 1
             WHERE update_id = ? AND delivery_state = ?
               AND EXISTS (
                 SELECT 1 FROM telegram_processed_updates p
                  WHERE p.update_id = telegram_operations.update_id
                    AND p.owner = ?
                    AND p.status = ?
                    AND p.lease_expires_at > ?
                    AND p.user_id = ?
               )
               AND NOT EXISTS (
                 SELECT 1 FROM telegram_processed_updates e
                  WHERE e.user_id = ?
                    AND e.update_id < telegram_operations.update_id
                    AND e.status NOT IN (?, ?)
               )`,
      args: [
        TELEGRAM_DELIVERY_STATE.DELIVERY_STARTED, String(owner), nowIso,
        id, TELEGRAM_DELIVERY_STATE.ACTION_READY,
        String(owner), TELEGRAM_UPDATE_STATUS.PROCESSING, nowIso, String(conversationKey),
        String(conversationKey),
        TELEGRAM_UPDATE_STATUS_COMPLETED, TELEGRAM_UPDATE_STATUS_ABANDONED,
      ],
    });
    return Number(rs.rowsAffected ?? 0) > 0;
  }

  /** DELIVERY_STARTED → DELIVERED，並存下 Telegram 的 message_id。 */
  async function markDelivered(updateId, { owner, messageId = null, now = new Date() } = {}) {
    const id = Number(updateId);
    if (!Number.isSafeInteger(id) || !owner) return false;
    const mid = messageId === null || messageId === undefined ? null : Number(messageId);
    const rs = await client.execute({
      sql: `UPDATE telegram_operations
               SET delivery_state = ?, delivered_at = ?, telegram_message_id = ?
             WHERE update_id = ? AND delivery_owner = ? AND delivery_state = ?`,
      args: [TELEGRAM_DELIVERY_STATE.DELIVERED, now.toISOString(),
        Number.isFinite(mid) ? mid : null, id, String(owner),
        TELEGRAM_DELIVERY_STATE.DELIVERY_STARTED],
    });
    return Number(rs.rowsAffected ?? 0) > 0;
  }

  /**
   * DELIVERY_STARTED → ACTION_READY（**明確**的送出失敗）。
   *
   * 只有在 Telegram 親口回報「我沒有收下」的時候才可以走這條：把狀態退回去，
   * 下一次嘗試就能安全地重送（動作不會重做，收據還在）。
   */
  async function markDeliveryFailed(updateId, { owner, now = new Date() } = {}) {
    const id = Number(updateId);
    if (!Number.isSafeInteger(id) || !owner) return false;
    const rs = await client.execute({
      sql: `UPDATE telegram_operations
               SET delivery_state = ?, delivery_owner = NULL, delivery_started_at = ?
             WHERE update_id = ? AND delivery_owner = ? AND delivery_state = ?`,
      args: [TELEGRAM_DELIVERY_STATE.ACTION_READY, now.toISOString(), id, String(owner),
        TELEGRAM_DELIVERY_STATE.DELIVERY_STARTED],
    });
    return Number(rs.rowsAffected ?? 0) > 0;
  }

  /**
   * DELIVERY_STARTED → AMBIGUOUS（網路層結果不明）。
   *
   * 逾時、連線被重置 —— 我們**證明不了** Telegram 沒收到。自動重送有機會讓
   * 使用者收到兩則一模一樣的健康建議，所以這裡停下來，交給人決定。
   */
  async function markDeliveryAmbiguous(updateId, { owner, now = new Date() } = {}) {
    const id = Number(updateId);
    if (!Number.isSafeInteger(id) || !owner) return false;
    const rs = await client.execute({
      sql: `UPDATE telegram_operations
               SET delivery_state = ?
             WHERE update_id = ? AND delivery_owner = ? AND delivery_state = ?`,
      args: [TELEGRAM_DELIVERY_STATE.AMBIGUOUS, id, String(owner),
        TELEGRAM_DELIVERY_STATE.DELIVERY_STARTED],
    });
    return Number(rs.rowsAffected ?? 0) > 0;
  }

  /**
   * 若欄位不存在就補上（向後相容 migration，不動既有資料）。
   * SQLite 的 ALTER TABLE ADD COLUMN 沒有 IF NOT EXISTS，所以先問 table_info。
   */
  async function ensureColumn(table, column, type) {
    const rs = await client.execute(`PRAGMA table_info(${table})`);
    if (rs.rows.some((r) => r.name === column)) return false;
    await client.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    log.info('schema_column_added', { table, column });
    return true;
  }

  /**
   * 版本化 migration（見 migrations.js）。
   * 舊形狀的表只在「完全沒有資料」時才會被重建，有資料就中止並拋錯。
   */
  async function migrate(opts = {}) {
    return runMigrations(client, opts);
  }

  // ----- tokens（per-user）-----------------------------------------------
  /**
   * 某個使用者的 WHOOP token。沒有就回 null。**絕不會回別人的。**
   *
   * ★ F04：回傳值**包含 `authGeneration`**，而且它與 access token 來自
   * **同一次列讀取**。這不是順手多帶一個欄位 —— 它是整個授權歸屬圍欄的地基：
   *
   *   憑證與世代必須是同一個快照。分兩次讀（先讀 token、之後再讀世代）
   *   就是 F04 的根因 —— 中間只要有一次成功的重新授權，用世代 N 觀測到的
   *   結果就會被貼上 N+1 的標籤，而那是一個系統無法察覺的謊。
   *
   * 所以：**不要**另外加一支 getAuthGeneration 來組快照。要世代就讀這一列。
   */
  async function getTokens(userId) {
    const uid = requireUserId(userId, 'getTokens');
    const rs = await client.execute({
      sql: 'SELECT * FROM user_whoop_tokens WHERE user_id = ?',
      args: [uid],
    });
    const row = rs.rows[0];
    if (!row) return null;
    // 世代必須是正整數。壞掉的值寧可讓這一輪失敗，也不可以被當成一個
    // 可以拿來比對的數字 —— 圍欄用它做等值判定，NaN 會讓所有比對都不成立
    // 而且理由完全看不出來。
    const authGeneration = Number(row.auth_generation ?? 1);
    if (!Number.isInteger(authGeneration) || authGeneration < 1) {
      throw new Error(`auth_generation_invalid:${uid}`);
    }
    return {
      userId: row.user_id,
      whoopUserId: row.whoop_user_id ?? null,
      accessToken: row.access_token,
      refreshToken: row.refresh_token,
      expiresAt: new Date(row.access_token_expires_at),
      scope: row.scope,
      updatedAt: row.updated_at,
      authGeneration,
    };
  }

  /**
   * 這個 WHOOP 帳號是否已經綁在**別的**內部使用者身上。
   * 用來防止同一支手環被兩個內部帳號同時綁走。
   */
  async function findUserByWhoopUserId(whoopUserId, { excludeUserId = null } = {}) {
    if (whoopUserId === null || whoopUserId === undefined || whoopUserId === '') return null;
    const rs = await client.execute({
      sql: 'SELECT user_id FROM user_whoop_tokens WHERE whoop_user_id = ?',
      args: [String(whoopUserId)],
    });
    const hit = rs.rows.map((r) => String(r.user_id)).find((u) => u !== String(excludeUserId ?? ''));
    return hit ?? null;
  }

  /**
   * 寫回 token。refresh 成功後「第一件事」就是呼叫這個，寫成功前不做任何
   * WHOOP 資料處理。DB 寫入失敗會 retry。
   */
  /**
   * 寫回 token，並在**儲存層**保證 WHOOP 身分不可變（R2-M-01）。
   *
   * ## 兩個必須在 SQL 裡解決的繞過
   *
   * 1. **既有列的 whoop_user_id 是 NULL。** 舊版的
   *    `COALESCE(excluded.whoop_user_id, existing)` 讓新來的身分覆寫 NULL。
   *    於是一個已經累積了 WHOOP#111 健康資料的使用者，可以被換成
   *    WHOOP#999，而歷史資料完全留在原地。實測確認。
   *
   * 2. **同一個未綁定使用者的並發 OAuth。** 兩個 callback 都讀到 NULL、
   *    都通過應用層檢查、都寫入，最後一個贏。實測確認：兩個不同身分都
   *    回報成功。應用層的 SELECT-before-WRITE 永遠關不掉這個競態。
   *
   * ## 解法
   *
   *   COALESCE 順序反過來 —— **既有的身分永遠贏**，新來的只能填 NULL。
   *   再加上 ON CONFLICT 的 WHERE：身分不同時整個 UPDATE 變成 no-op，
   *   rowsAffected = 0，呼叫端據此拋錯。
   *
   * 這讓「NULL → 某個身分」的轉移成為一個**原子的條件式寫入**：並發時
   * 恰好一個贏，輸的那個讀到不同的身分而失敗。與 pending_questions 和
   * proactive_events 用的是同一個模式。
   *
   * `excluded.whoop_user_id IS NULL` 這一條不可省：token refresh 不帶身分，
   * 少了它每一次 refresh 都會變成 no-op（新的 refresh_token 寫不進去，
   * 那是這個系統最危險的失敗）。
   *
   * ⚠️ 實作備註：在這個 WHERE 之下，COALESCE 的兩種順序其實是**等價**的
   * （四種組合逐一驗算都相同），所以變異測試觀察不到單獨改動 COALESCE
   * 順序的差異 —— 真正的閘門是 WHERE。這裡仍然寫成「既有的贏」，
   * 因為那才是這段程式想表達的意思：**身分一旦確立就不再改變**。
   * 不要把它當成獨立的防線。
   *
   * @returns {Promise<{identityBound:boolean}>} identityBound 代表這一次
   *   呼叫帶了身分而且寫入成功（身分現在確定等於傳入的值）。
   */
  /**
   * 寫回一組 WHOOP token。
   *
   * @param {?string} opts.expectedUpdatedAt compare-and-swap 的版本戳（M-02）。
   *
   *   給了它，這次寫入就只有在 DB 上的 updated_at **仍然等於**它的時候才會
   *   成立。這是「token 狀態只能單調前進」的最終保證：
   *
   *     A 讀到 v1 → A 的 refresh 請求卡住 → A 的租約過期
   *     B 讀到 v1 → B refresh 成功 → 寫入 v2（WHOOP 已經輪替了 refresh_token）
   *     A 的請求終於回來，手上是「以 v1 為基礎」的舊結果
   *     → CAS 發現 DB 已經是 v2 ≠ v1 → **拒絕寫入**，回 false
   *
   *   沒有它的話 A 會蓋掉 v2，而 v1 的 refresh_token 已經被 WHOOP 作廢 ——
   *   帳號就此需要人工重新授權。
   *
   *   `null` 代表「我讀的時候這一列根本不存在」，所以只有在它**現在仍然
   *   不存在**時才可以寫（純 INSERT）。
   *
   *   不傳這個參數就是無條件寫入（授權流程用：那時沒有併發的第二個寫者）。
   *
   * @returns {Promise<{identityBound:boolean}|false>}
   *   寫入成功回 `{ identityBound }`；CAS 落敗回 **`false`**
   *   （不是錯誤 —— 併發控制正常運作，別人贏了而已）。
   *   身分不可變的違反仍然拋錯，那是完全不同的一件事。
   */
  /**
   * @param {boolean} [opts.bumpAuthGeneration] 這是一次**新的授權**（不是例行
   *   refresh）。只有 OAuth 完成那條路會傳 true。
   *
   *   授權世代是「這組 token 屬於哪一次授權」的非祕密識別（RC2 / F04）。
   *   權限判定（whoop_resource_access）綁在它上面：使用者重新授權而這次沒勾
   *   某個權限時，舊的判定就自動失效，READY 不可能用舊結論通過。
   *   例行 refresh **不會** +1 —— 換的是同一次授權的新 access token，權限沒變。
   */
  async function saveTokens(userId, {
    accessToken, refreshToken, expiresAt, scope, whoopUserId = null,
  }, {
    retries = 4, expectedUpdatedAt = undefined, bumpAuthGeneration = false,
    expectedAuthGeneration = null, expectedLifecycleGeneration = null,
  } = {}) {
    const uid = requireUserId(userId, 'saveTokens');
    const fenced = expectedUpdatedAt !== undefined;
    // ★ F04：世代圍欄。一個在世代 N 開始的例行 refresh，網路來回期間使用者
    // 可能已經完成了一次新的授權（世代 N+1）。那組新 token 才是權威 ——
    // 用舊世代的 refresh 結果蓋掉它會讓剛授權好的人立刻失效。
    // updated_at 的 CAS 多數情況也擋得住，但世代是語意上正確的那一個。
    const genFenced = Number.isInteger(expectedAuthGeneration) && expectedAuthGeneration >= 1;
    // CAS 條件。刻意用 `IS ?` 而不是 `= ?`，這樣 NULL 也能正確比較
    // （SQL 的 `= NULL` 永遠不成立，會讓「我讀到的時候沒有這一列」無法表達）。
    // ★ R2 / LIFE-FG-01：帳號啟用世代的 CAS。
    //
    // 授權世代擋不住這一種：停用（或停用再啟用）**不會**改 auth_generation，
    // 所以一個在舊啟用期開始的例行 refresh，網路回來之後仍然握著「正確的」
    // 授權世代，會把輪替後的憑證寫進一個已經不該被處理的帳號。
    const lifeFenced = Number.isInteger(expectedLifecycleGeneration)
      && expectedLifecycleGeneration >= 1;
    const casClause = (fenced ? '\n         AND user_whoop_tokens.updated_at IS ?' : '')
      + (genFenced ? '\n         AND user_whoop_tokens.auth_generation = ?' : '')
      + (lifeFenced ? `\n         AND ${lifecycleActiveSql('user_whoop_tokens.user_id')}` : '');
    // ★ R2 / LIFE-FG-02：啟用圍欄必須同時蓋住 **INSERT** 與 DO UPDATE。
    //
    // 只放在 ON CONFLICT 的 WHERE 裡是不夠的：**第一次**授權沒有既有列，
    // 走的是 INSERT 路徑，那個 WHERE 根本不會被求值 —— 於是一個在
    // provider 往返期間被停用的帳號，仍然會拿到它的第一組憑證。
    // 改成 INSERT … SELECT … WHERE，讓條件對兩條路徑都成立。
    const insertGuard = lifeFenced ? lifecycleActiveSql('?') : '1';
    const sql = `INSERT INTO user_whoop_tokens
        (user_id, whoop_user_id, access_token, refresh_token,
         access_token_expires_at, scope, updated_at, auth_generation)
      SELECT ?, ?, ?, ?, ?, ?, ?, 1
       WHERE ${insertGuard}
      ON CONFLICT(user_id) DO UPDATE SET
        whoop_user_id = COALESCE(user_whoop_tokens.whoop_user_id, excluded.whoop_user_id),
        auth_generation = user_whoop_tokens.auth_generation + ${bumpAuthGeneration ? 1 : 0},
        access_token = excluded.access_token,
        refresh_token = excluded.refresh_token,
        access_token_expires_at = excluded.access_token_expires_at,
        scope = excluded.scope,
        updated_at = excluded.updated_at
      WHERE (user_whoop_tokens.whoop_user_id IS NULL
         OR excluded.whoop_user_id IS NULL
         OR user_whoop_tokens.whoop_user_id = excluded.whoop_user_id)${casClause}`;
    const args = [
      uid,
      whoopUserId === null || whoopUserId === undefined ? null : String(whoopUserId),
      accessToken,
      refreshToken,
      new Date(expiresAt).toISOString(),
      scope ?? null,
      new Date().toISOString(),
      // INSERT 路徑的啟用圍欄（uid + 世代），再來才是 ON CONFLICT 的 CAS
      ...(lifeFenced ? [uid, expectedLifecycleGeneration] : []),
      ...(fenced ? [expectedUpdatedAt] : []),
      ...(genFenced ? [expectedAuthGeneration] : []),
      ...(lifeFenced ? [expectedLifecycleGeneration] : []),
    ];

    const wanted = whoopUserId === null || whoopUserId === undefined
      ? null : String(whoopUserId);

    let lastErr;
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const rs = await client.execute({ sql, args });
        if (Number(rs.rowsAffected ?? 0) === 0) {
          // WHERE 沒過。現在有**兩個**可能的原因，而它們的處置完全相反，
          // 所以一定要分清楚 —— 把 CAS 落敗誤判成身分衝突會讓正常的
          // refresh 競爭變成一個看起來很嚴重的假警報。
          const row = (await client.execute({
            sql: `SELECT t.whoop_user_id, t.updated_at, t.auth_generation,
                         u.status user_status, u.lifecycle_generation user_lifecycle
                    FROM user_whoop_tokens t
                    LEFT JOIN users u ON u.id = t.user_id
                   WHERE t.user_id = ?`,
            args: [uid],
          })).rows[0] ?? null;
          const current = row?.whoop_user_id ?? null;
          const currentStr = current === null || current === undefined ? null : String(current);

          // (a) 身分不可變的違反：既有的 WHOOP 帳號與這次要寫的不同。
          //     這是硬錯誤，不重試、也不可以被 CAS 的語意吃掉。
          const identityConflict = wanted !== null && currentStr !== null && currentStr !== wanted;
          if (identityConflict) {
            const err = new Error(
              `使用者 ${uid} 已經綁定另一個 WHOOP 帳號，身分不可變更`,
            );
            err.code = 'WHOOP_IDENTITY_IMMUTABLE';
            err.currentWhoopUserId = currentStr;
            log.error('tokens_identity_conflict', {
              user_id: uid, current: currentStr,
            });
            throw err;
          }

          // (a0) ★ R2 / LIFE-FG-01 / LIFE-FG-02：帳號層級的原因**最優先**。
          //
          // 一個被停用（或已經換過啟用期）的帳號，它的寫入根本不該落地，
          // 而且那既不是授權競態、更不是身分衝突 —— 用帳號自己的列判斷，
          // 不是用 token 列：**第一次**授權時根本還沒有 token 列，而那正是
          // 「停用期間完成第一次授權」這個情境。
          const acct = lifeFenced ? (await client.execute({
            sql: 'SELECT status, lifecycle_generation FROM users WHERE id = ?', args: [uid],
          })).rows[0] ?? null : null;
          if (lifeFenced
              && (!acct
                || String(acct.status) !== USER_STATUS.ACTIVE
                || Number(acct.lifecycle_generation ?? 1) !== expectedLifecycleGeneration)) {
            log.warn('tokens_save_lifecycle_rejected', {
              user_id: uid,
              user_status: acct ? String(acct.status) : null,
              expected_lifecycle: expectedLifecycleGeneration,
              current_lifecycle: acct ? Number(acct.lifecycle_generation ?? 1) : null,
            });
            return false;
          }

          // (a2) ★ F04：世代已經往前走了 —— 使用者在我們打網路的時候完成了
          //      一次新的授權。舊世代的 refresh 結果**必須**被丟掉。
          //      這和 (b) 一樣不是錯誤，但理由不同，所以分開記。
          if (genFenced && row && Number(row.auth_generation ?? 1) !== expectedAuthGeneration) {
            log.warn('tokens_save_stale_generation', {
              user_id: uid,
              expected_generation: expectedAuthGeneration,
              current_generation: Number(row.auth_generation ?? 1),
            });
            return false;
          }

          // (b) CAS 落敗：在我們讀到現在，有別人寫過了。這**不是**錯誤，
          //     是併發控制正常運作。呼叫端要去撿贏家寫好的 token。
          if (fenced) {
            log.warn('tokens_save_stale_version', {
              user_id: uid,
              expected_present: expectedUpdatedAt !== null,
              current_present: Boolean(row),
            });
            return false;
          }

          // 沒開 CAS 又走到這裡，代表身分條件擋下了一個我們沒預期的形狀。
          // 保守當成身分衝突，讓它浮出來。
          const err = new Error(
            `使用者 ${uid} 已經綁定另一個 WHOOP 帳號，身分不可變更`,
          );
          err.code = 'WHOOP_IDENTITY_IMMUTABLE';
          err.currentWhoopUserId = currentStr;
          log.error('tokens_identity_conflict', { user_id: uid, current: currentStr });
          throw err;
        }
        // 絕不 log token 內容，只 log 使用者與到期時間
        log.info('tokens_saved', {
          user_id: uid, attempt, expires_at: new Date(expiresAt).toISOString(),
        });
        // 不需要回頭讀一次：WHERE 通過而且 rowsAffected > 0 就代表
        // 既有身分原本是 NULL（現在被設成 wanted）或本來就等於 wanted。
        // 兩種情況下儲存的身分都是 wanted。
        return { identityBound: wanted !== null };
      } catch (err) {
        if (err?.code === 'WHOOP_IDENTITY_IMMUTABLE') throw err;
        lastErr = err;
        log.warn('tokens_save_failed', { user_id: uid, attempt, error: String(err?.message ?? err) });
        if (attempt < retries) await sleep(500 * 2 ** (attempt - 1));
      }
    }
    // 這是最危險的失敗：新 refresh_token 沒寫進 DB。往上拋，不要繼續跑。
    throw new Error(`token 寫入 Turso 連續 ${retries} 次失敗，中止本次執行：${lastErr?.message ?? lastErr}`);
  }

  /**
   * 這個使用者的健康資料**實際上**來自哪個 WHOOP 帳號。
   *
   * ## 為什麼不能只看 token 列
   *
   * 舊資料的 `user_whoop_tokens.whoop_user_id` 可能是 NULL（第一版的授權
   * 流程從來沒有寫過它）。但每一列健康資料**自己**都帶著 WHOOP 回傳的
   * `whoop_user_id` —— 那是「這些生理資料屬於誰」的權威事實。
   *
   * ## R3-M-01：完整、而且失敗要傳播
   *
   * R2 的版本有兩個缺口，獨立稽核兩個都重現了：
   *
   *   1. **漏了 whoop_workouts。** 只有運動資料的使用者會被判定成
   *      「沒有歷史身分」，於是任何帳號都綁得上去。實測：歷史屬於
   *      WHOOP#777，卻成功綁定 WHOOP#888。
   *
   *   2. **每張表各自 try/catch 吞掉錯誤。** 一次 DB 抽風會讓函式
   *      「成功」回傳一份**部分**的歷史，呼叫端無從分辨那是「真的沒有
   *      歷史」還是「查不到」。實測：所有來源都不可讀時回傳 []，
   *      於是 WHOOP#666 綁定成功。
   *
   * 現在：**每一個**權威來源都要查，任何一個查詢失敗就往上拋。
   * 「查不到」與「沒有」是兩件不同的事，只有後者可以放行綁定。
   */
  const WHOOP_HISTORY_TABLES = Object.freeze([
    'whoop_sleeps',
    'whoop_recoveries',
    'whoop_cycles',
    'whoop_workouts',
  ]);

  async function getHistoricalWhoopUserIds(userId) {
    const uid = requireUserId(userId, 'getHistoricalWhoopUserIds');
    const ids = new Set();
    for (const table of WHOOP_HISTORY_TABLES) {
      // ⚠️ 刻意**不** try/catch：查不到就是查不到，必須讓呼叫端知道。
      // 吞掉錯誤等於把「不確定」偽裝成「沒有」，而那正是 R3 稽核重現的漏洞。
      const rs = await client.execute({
        sql: `SELECT DISTINCT whoop_user_id FROM ${table}
               WHERE user_id = ? AND whoop_user_id IS NOT NULL LIMIT 10`,
        args: [uid],
      });
      for (const row of rs.rows) ids.add(String(row.whoop_user_id));
    }
    return [...ids];
  }

  /** 權威歷史來源清單（測試用：確保新增的 WHOOP 表不會被遺漏）。 */
  const whoopHistoryTables = () => [...WHOOP_HISTORY_TABLES];

  // ----- report dedup -----------------------------------------------------
  /** **該使用者**的該類型報告在該 local_date 是否已經成功送出。 */
  async function isSent(userId, reportType, localDateKey) {
    const uid = requireUserId(userId, 'isSent');
    const rs = await client.execute({
      sql: `SELECT 1 FROM report_runs
             WHERE user_id = ? AND report_type = ? AND local_date = ? AND status = 'SENT'
             LIMIT 1`,
      args: [uid, reportType, localDateKey],
    });
    return rs.rows.length > 0;
  }

  /**
   * 寫一筆發送紀錄。
   *
   * 兩種失敗要分清楚，這是刻意的：
   *  - **撞到 uniq_report_sent**（另一個 run 已經送出了）→ 預期中的安全行為，
   *    回 false 就好，不吵。
   *  - **其他 DB 錯誤**（Turso 短暫故障等）→ 危險。沒有 SENT 紀錄，下一輪
   *    `isSent` 會回 false 而重複發送。所以要重試，重試用完就往上拋，
   *    讓呼叫端決定怎麼喊（`throwOnError: false` 可改成只寫 log）。
   */
  async function recordRun({
    userId, reportType, localDateKey, healthDate = null, sleepId = null, cycleId = null,
    telegramMessageId = null, status, detail = null,
  }, { retries = 3, throwOnError = true } = {}) {
    const uid = requireUserId(userId, 'recordRun');
    const sql = `INSERT INTO report_runs
           (user_id, report_type, local_date, health_date, sleep_id, cycle_id,
            telegram_message_id, status, detail, sent_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    const args = [
      uid, reportType, localDateKey, healthDate, sleepId, cycleId,
      telegramMessageId, status, detail ? String(detail).slice(0, 500) : null,
      new Date().toISOString(),
    ];

    let lastErr;
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        await client.execute({ sql, args });
        return true;
      } catch (err) {
        if (isDuplicateSentError(err)) {
          log.warn('record_run_duplicate', {
            user_id: uid, report_type: reportType, local_date: localDateKey, status,
          });
          return false;
        }
        lastErr = err;
        log.warn('record_run_retry', {
          user_id: uid, report_type: reportType, local_date: localDateKey, status, attempt,
          error: String(err?.message ?? err),
        });
        if (attempt < retries) await sleep(500 * 2 ** (attempt - 1));
      }
    }

    const msg = `發送紀錄寫入 Turso 連續 ${retries} 次失敗：${lastErr?.message ?? lastErr}`;
    if (throwOnError) throw new Error(msg);
    log.error('record_run_failed', {
      user_id: uid, report_type: reportType, local_date: localDateKey, status, error: msg,
    });
    return false;
  }

  async function recentRuns(userId, limit = 20) {
    const uid = requireUserId(userId, 'recentRuns');
    const rs = await client.execute({
      sql: 'SELECT * FROM report_runs WHERE user_id = ? ORDER BY id DESC LIMIT ?',
      args: [uid, limit],
    });
    return rs.rows;
  }

  // ----- error notify cooldown（scope 化）--------------------------------
  /**
   * 回傳 true 表示「可以通知」，同時記錄這次通知時間。
   *
   * scope 把「系統層」與「某個使用者」分開：
   *   'global'        → Turso / Telegram 這類基礎設施故障
   *   'user:<userId>' → 某人的 WHOOP token 失效
   *
   * 這樣 Alice 的 token 過期不會壓抑 Bob 的錯誤通知，
   * 基礎設施故障也不會被歸到某個隨機使用者身上。
   */
  /**
   * 認領一次錯誤通知（帶冷卻）。回 true 代表**這一個呼叫**有權送出。
   *
   * ★ 認領必須是原子的。
   *
   * 舊版是「先 SELECT 看冷卻、再 INSERT」。兩個併發的評估會同時讀到「沒有
   * 紀錄」，然後兩個都認為自己贏了 —— 使用者收到兩則一模一樣的警報。
   * 排程器的對等監看正好會併發（主要與備援可能同時跑完），所以這不是理論問題。
   *
   * 現在全部靠單一語句的條件式寫入決定勝負：
   *   1. `INSERT ... ON CONFLICT DO NOTHING` —— 第一次通知，插入成功就是贏。
   *   2. 沒插進去代表已有紀錄：用帶 cutoff 條件的 UPDATE 搶冷卻窗，
   *      SQLite 逐語句序列化，所以只有一個呼叫會拿到 rowsAffected = 1。
   *   3. 兩者都沒搶到 → 被冷卻擋下，只累加 hits。
   */
  /**
   * 認領一次通知，並回傳**這一次認領的擁有權憑證**。
   *
   * 憑證就是寫進去的那個 `last_notified_at`。它足以當 token，因為認領本身
   * 是原子的：同一個窗只有一個呼叫拿得到，也就只有一個呼叫握著那個時間戳。
   *
   * @returns {{granted:boolean, claimedAt:?string}}
   */
  async function claimErrorNotifyOwned(scope, errorType, cooldownHours, { expectedLifecycleGeneration = null } = {}) {
    if (!scope) throw new Error('claimErrorNotify 需要 scope（global 或 user:<id>）');
    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    const cutoffIso = new Date(now - cooldownHours * 3600_000).toISOString();
    const userScoped = scope.startsWith('user:');
    const uid = userScoped ? requireUserId(scope.slice(5), 'claimErrorNotifyOwned(scope)') : null;
    // User-facing error evidence belongs to the lifecycle that observed it.
    // Global/operator evidence has no account lifecycle.
    const life = userScoped
      ? requireLifecycle(expectedLifecycleGeneration, 'claimErrorNotifyOwned(user)')
      : null;
    const active = `(? IS NULL OR EXISTS (SELECT 1 FROM users
      WHERE id = ? AND status = 'ACTIVE' AND lifecycle_generation = ?))`;
    const guard = [life, uid, life];

    const inserted = await client.execute({
      sql: `INSERT INTO error_notifications (scope, error_type, last_notified_at, hits, lifecycle_generation)
            SELECT ?, ?, ?, 1, ? WHERE ${active}
            ON CONFLICT(scope, error_type) DO NOTHING`,
      args: [scope, errorType, nowIso, life, ...guard],
    });
    if (Number(inserted.rowsAffected ?? 0) > 0) return { granted: true, claimedAt: nowIso };

    const claimed = await client.execute({
      sql: `UPDATE error_notifications
               SET last_notified_at = ?, hits = 1, lifecycle_generation = ?
             WHERE scope = ? AND error_type = ? AND ${active}
               AND (last_notified_at <= ? OR (? IS NOT NULL AND lifecycle_generation IS NOT ?))`,
      args: [nowIso, life, scope, errorType, ...guard, cutoffIso, life, life],
    });
    if (Number(claimed.rowsAffected ?? 0) > 0) return { granted: true, claimedAt: nowIso };

    await client.execute({
      sql: `UPDATE error_notifications SET hits = hits + 1
             WHERE scope = ? AND error_type = ? AND ${active}`,
      args: [scope, errorType, ...guard],
    });
    return { granted: false, claimedAt: null };
  }

  /** 簡化介面：只回傳是否取得通知權；user scope 仍須明確帶生命週期。 */
  async function claimErrorNotify(scope, errorType, cooldownHours, options = {}) {
    return (await claimErrorNotifyOwned(scope, errorType, cooldownHours, options)).granted;
  }

  /**
   * 送失敗了 —— 把**自己那一次**的認領還回去，讓下一輪可以馬上重試。
   *
   * ## 為什麼要帶 claimedAt
   *
   * 無條件 DELETE 會製造一個更難查的 bug：
   *
   *   A 認領 → A 送失敗（慢）
   *   B 在下一輪認領（新的時間戳）→ B 送成功
   *   A 的錯誤處理才跑到，DELETE 掉了**B** 的冷卻
   *   → 下一輪又送一次，使用者收到重複警報
   *
   * 帶上自己的時間戳做比較後刪除，就只會刪掉自己那一列；別人已經接手的
   * 認領（時間戳不同）碰不到。
   *
   * @returns {boolean} 有沒有真的釋放（false = 已經被新的認領取代，本來就不該動）
   */
  async function releaseErrorNotify(scope, errorType, claimedAt, { expectedLifecycleGeneration = null } = {}) {
    if (!scope) throw new Error('releaseErrorNotify 需要 scope');
    const userScoped = scope.startsWith('user:');
    if (userScoped) requireUserId(scope.slice(5), 'releaseErrorNotify(scope)');
    const life = userScoped
      ? requireLifecycle(expectedLifecycleGeneration, 'releaseErrorNotify(user)')
      : null;
    if (!claimedAt) return false;
    const rs = await client.execute({
      sql: `DELETE FROM error_notifications
             WHERE scope = ? AND error_type = ? AND last_notified_at = ?
               AND lifecycle_generation IS ?`,
      args: [scope, errorType, claimedAt, life],
    });
    return Number(rs.rowsAffected ?? 0) > 0;
  }

  /**
   * 這個錯誤已經恢復了 —— 把累積的失敗紀錄清掉（M-08）。
   *
   * ## 為什麼一定要有這個
   *
   * `error_notifications` 只會被**失敗**寫入，從來沒有任何地方在成功時
   * 清掉它。Guardian 讀 `hits` 來判斷「WHOOP 授權連續失敗 N 次」，
   * 於是：使用者重新授權、同步恢復正常之後，那一列仍然停在 hits = 3，
   * Guardian 每 12 小時（冷卻窗）就照樣發一次「需要重新授權」——
   * **永遠不會停**。實測確認：最近一次同步在 10 分鐘前，Guardian 還是
   * 回報 whoop_auth_repeated_failure。
   *
   * 假警報比沒有警報更糟：它會很快訓練出「看到 Guardian 就忽略」的習慣。
   *
   * 回傳有沒有真的刪掉一列（沒有紀錄可清時是乾淨的 no-op）。
   */
  async function clearErrorNotify(scope, errorType, { expectedLifecycleGeneration = null } = {}) {
    if (!scope) throw new Error('clearErrorNotify 需要 scope（global 或 user:<id>）');
    const userScoped = scope.startsWith('user:');
    const uid = userScoped ? requireUserId(scope.slice(5), 'clearErrorNotify(scope)') : null;
    const life = userScoped
      ? requireLifecycle(expectedLifecycleGeneration, 'clearErrorNotify(user)')
      : null;
    const rs = await client.execute({
      sql: `DELETE FROM error_notifications
             WHERE scope = ? AND error_type = ?
               AND (? IS NULL OR lifecycle_generation = ?)
               AND (? IS NULL OR EXISTS (
                 SELECT 1 FROM users
                  WHERE id = ? AND status = 'ACTIVE' AND lifecycle_generation = ?
               ))`,
      args: [scope, errorType, life, life, life, uid, life],
    });
    return Number(rs.rowsAffected ?? 0) > 0;
  }

  /**
   * 這個 scope/type 目前有沒有一筆「已經通知過」的紀錄？
   *
   * 唯讀。用來回答「我們有沒有announce過這場故障」——復原通知只有在
   * 真的送出過故障通知時才該送，否則使用者會收到一則莫名其妙的「恢復了」。
   */
  async function hasErrorNotify(scope, errorType, { expectedLifecycleGeneration = null } = {}) {
    if (!scope) throw new Error('hasErrorNotify 需要 scope（global 或 user:<id>）');
    const userScoped = scope.startsWith('user:');
    const uid = userScoped ? requireUserId(scope.slice(5), 'hasErrorNotify(scope)') : null;
    const life = userScoped
      ? requireLifecycle(expectedLifecycleGeneration, 'hasErrorNotify(user)')
      : null;
    const rs = await client.execute({
      sql: `SELECT 1 FROM error_notifications
             WHERE scope = ? AND error_type = ?
               AND (? IS NULL OR lifecycle_generation = ?)
               AND (? IS NULL OR EXISTS (
                 SELECT 1 FROM users
                  WHERE id = ? AND status = 'ACTIVE' AND lifecycle_generation = ?
               ))
             LIMIT 1`,
      args: [scope, errorType, life, life, life, uid, life],
    });
    return rs.rows.length > 0;
  }

  // ----- 簡報評估的最新狀態（v8）-----------------------------------------
  /**
   * 寫下這個使用者/報告型別**最新一次**評估的結果。
   *
   * 單一 upsert：併發的 Cloudflare 與 GitHub 各寫各的，最後一個贏，表不會成長。
   * created_at 用 COALESCE 保留第一次寫入的時間。
   */
  async function recordBriefingEvaluation({
    userId, reportType = 'daily', evaluatedAt, localDate, targetHealthDate = null,
    outcome, reason = null, retryable = true, observationAgeMinutes = null,
    reportRunId = null, detail = null,
  }) {
    const uid = requireUserId(userId, 'recordBriefingEvaluation');
    if (!outcome) throw new Error('recordBriefingEvaluation 需要 outcome');
    const at = evaluatedAt ?? new Date().toISOString();
    await client.execute({
      sql: `INSERT INTO briefing_evaluations
              (user_id, report_type, evaluated_at, local_date, target_health_date,
               outcome, reason, retryable, observation_age_minutes, report_run_id,
               detail, created_at, updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(user_id, report_type) DO UPDATE SET
              evaluated_at = excluded.evaluated_at,
              local_date = excluded.local_date,
              target_health_date = excluded.target_health_date,
              outcome = excluded.outcome,
              reason = excluded.reason,
              retryable = excluded.retryable,
              observation_age_minutes = excluded.observation_age_minutes,
              report_run_id = excluded.report_run_id,
              detail = excluded.detail,
              updated_at = excluded.updated_at`,
      args: [uid, reportType, at, localDate, targetHealthDate, outcome, reason,
        retryable ? 1 : 0, observationAgeMinutes, reportRunId,
        detail ? String(detail).slice(0, 500) : null, at, at],
    });
    return true;
  }

  async function getBriefingEvaluation(userId, reportType = 'daily') {
    const uid = requireUserId(userId, 'getBriefingEvaluation');
    const rs = await client.execute({
      sql: 'SELECT * FROM briefing_evaluations WHERE user_id = ? AND report_type = ?',
      args: [uid, reportType],
    });
    const row = rs.rows[0];
    if (!row) return null;
    return {
      reportType: row.report_type,
      evaluatedAt: row.evaluated_at,
      localDate: row.local_date,
      targetHealthDate: row.target_health_date ?? null,
      outcome: row.outcome,
      reason: row.reason ?? null,
      retryable: Number(row.retryable) === 1,
      observationAgeMinutes: row.observation_age_minutes ?? null,
      reportRunId: row.report_run_id ?? null,
      detail: row.detail ?? null,
      updatedAt: row.updated_at,
    };
  }

  /** 便利包裝：系統層 / 使用者層。 */
  const claimGlobalErrorNotify = (errorType, hours) =>
    claimErrorNotify(GLOBAL_SCOPE, errorType, hours);
  const claimUserErrorNotify = (userId, errorType, hours, { expectedLifecycleGeneration } = {}) =>
    claimErrorNotify(
      userScope(requireUserId(userId, 'claimUserErrorNotify')),
      errorType,
      hours,
      { expectedLifecycleGeneration },
    );

  // ----- 跨 process lease lock (A1) --------------------------------------
  /**
   * 取得一個具名 lease lock。
   *
   * 原子性來自單一 SQL：ON CONFLICT DO UPDATE ... WHERE 只有在既有 lock
   * 已過期時才會改寫，否則整句話不動任何列（rowsAffected = 0）。
   * 因為所有時間戳都是等寬的 ISO8601 UTC，字串比較 == 時間比較。
   *
   * @returns {Promise<?string>} 拿到就回 owner token，沒拿到回 null
   */
  async function acquireLock(name, { ttlMs, owner = randomUUID(), now = new Date() } = {}) {
    const nowIso = now.toISOString();
    const expiresIso = new Date(now.getTime() + ttlMs).toISOString();
    const rs = await client.execute({
      sql: `INSERT INTO resource_locks (name, owner, acquired_at, expires_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(name) DO UPDATE SET
              owner       = excluded.owner,
              acquired_at = excluded.acquired_at,
              expires_at  = excluded.expires_at
            WHERE resource_locks.expires_at <= excluded.acquired_at`,
      args: [name, owner, nowIso, expiresIso],
    });
    const got = Number(rs.rowsAffected ?? 0) > 0;
    log.info(got ? 'lock_acquired' : 'lock_busy', { lock: name, ttl_ms: ttlMs });
    return got ? owner : null;
  }

  /**
   * 這個 owner 現在**還**持有這把 lock 嗎（R3-M-03）。
   *
   * 用來在每一個副作用之前重新確認所有權：租約會過期，過期之後別人可能
   * 已經接手並把狀態推向終局。「當初拿到了」不等於「現在還有」。
   */
  async function holdsLock(name, owner, { now = new Date() } = {}) {
    if (!name || !owner) return false;
    const rs = await client.execute({
      sql: `SELECT 1 FROM resource_locks
             WHERE name = ? AND owner = ? AND expires_at > ? LIMIT 1`,
      args: [name, owner, now.toISOString()],
    });
    return rs.rows.length > 0;
  }

  /** 只有持有者能釋放（避免釋放掉別人接手的 lock）。 */
  async function releaseLock(name, owner) {
    const rs = await client.execute({
      sql: 'DELETE FROM resource_locks WHERE name = ? AND owner = ?',
      args: [name, owner],
    });
    const released = Number(rs.rowsAffected ?? 0) > 0;
    log.info('lock_released', { lock: name, released });
    return released;
  }

  /**
   * per-user 的鎖名。resource_locks 表結構保持全域，但鎖名必須帶 user，
   * 否則 Alice 的 token refresh 會卡住 Bob。
   */
  const userLockName = (base, userId) => `${base}:${requireUserId(userId, 'userLockName')}`;

  // ----- 報告發送權 / 送達狀態機 (A2 + H-01 + H-02) -----------------------
  /**
   * 取得某份報告的「發送權」。
   *
   * 結果：
   *   { granted: true, owner }                  → 你負責發
   *   { granted:false, alreadySent:true }       → 已經證明送出去過，永遠不要再送
   *   { granted:false, ambiguous:true }         → 上一次送出結果不明 → **終局**，
   *                                               不可以自動再送（需要人工處置）
   *   { granted:false }                         → 別人正握著（claim 未過期）
   *
   * ## 同一啟用期只接手 CLAIMED；新啟用期可接手舊的 DELIVERY_STARTED
   *
   * CLAIMED 的定義是「拿到權限了，但**還沒有任何外部副作用**」——
   * 抓歷史、算 baseline、問模型全都在這個狀態裡，重做一次不會有任何代價。
   * 所以它的租約過期之後被別人接手是安全的。
   *
   * 一旦跨過 authorizeReportDelivery（=可能已經打到 Telegram），狀態就變成
   * DELIVERY_STARTED，而那是**終局**：租約過不過期都不再授予任何人。
   * 「租約過期」永遠不可以變成「再送一次」的理由。
   * 已知的不同啟用世代可回收未確認送達的 DELIVERY_STARTED；
   * AMBIGUOUS 與已確認送達的歷史列仍然不在自動接手範圍內。
   */
  async function claimReport({
    userId, reportType, localDateKey, ttlMs, owner = randomUUID(),
    expectedLifecycleGeneration, now = new Date(),
  }) {
    const uid = requireUserId(userId, 'claimReport');
    const nowIso = now.toISOString();
    const expiresIso = new Date(now.getTime() + ttlMs).toISOString();
    const life = requireLifecycle(expectedLifecycleGeneration, 'claimReport');
    const rs = await client.execute({
      // ★ R2 / LIFE-FG-07 §20：認領記下它屬於哪一段啟用期，而且**別的
      // 啟用期留下的未送出認領一律可以被接手**（不必等租約過期）。
      //
      // 沒有這一條，一個在停用前認領、之後被啟用授權擋下來的舊 worker，
      // 會讓使用者在合法重新啟用之後整整一個租約週期收不到晨報 ——
      // 而晨報是每天都要有的東西。
      sql: `INSERT INTO report_claims
              (user_id, report_type, local_date, owner, claimed_at, expires_at,
               delivery_state, delivery_attempts, lifecycle_generation)
            SELECT ?, ?, ?, ?, ?, ?, ?, 0, ?
             -- ★ R3 / R2-REPORT-01：認領本身就要證明帳號 ACTIVE 且仍在
             -- 這個 worker 捕捉到的啟用期。舊 L1 worker 不可以在 L3 裡
             -- 憑空建出一個認領（那會佔掉當天的遞送名額）。
             WHERE ${lifecycleActiveSql('?')}
            ON CONFLICT(user_id, report_type, local_date) DO UPDATE SET
              owner      = excluded.owner,
              claimed_at = excluded.claimed_at,
              expires_at = excluded.expires_at,
              lifecycle_generation = excluded.lifecycle_generation,
              delivery_state = excluded.delivery_state, delivery_started_at = NULL, delivery_detail = NULL
            WHERE report_claims.telegram_sent_at IS NULL
              AND ((report_claims.delivery_state = ? AND report_claims.expires_at <= excluded.claimed_at)
                -- ★ R2：兩邊都知道而且不同時才接手（NULL = 出處不明，維持互斥）
                OR (report_claims.delivery_state IN ('CLAIMED', 'DELIVERY_STARTED')
                    AND report_claims.lifecycle_generation IS NOT NULL
                    AND excluded.lifecycle_generation IS NOT NULL
                    AND report_claims.lifecycle_generation <> excluded.lifecycle_generation))`,
      args: [uid, reportType, localDateKey, owner, nowIso, expiresIso,
        REPORT_DELIVERY_STATE.CLAIMED, life,
        uid, life,                       // INSERT 的啟用圍欄
        REPORT_DELIVERY_STATE.CLAIMED],
    });
    if (Number(rs.rowsAffected ?? 0) > 0) {
      log.info('report_claimed', { user_id: uid, report_type: reportType, local_date: localDateKey });
      // 認領帶著它的啟用世代，deliverReport 據此在送出前再證明一次。
      return { granted: true, owner, lifecycleGeneration: expectedLifecycleGeneration };
    }
    const existing = await getClaim(uid, reportType, localDateKey);
    const state = existing?.deliveryState ?? null;
    const alreadySent = Boolean(existing?.telegramSentAt)
      || state === REPORT_DELIVERY_STATE.DELIVERED;
    // DELIVERY_STARTED 與 AMBIGUOUS 是同一件事的兩個時間點：都代表
    // 「Telegram 可能已經收下了，但我們證明不了」。兩者都不可以自動重送。
    const ambiguous = !alreadySent
      && (state === REPORT_DELIVERY_STATE.DELIVERY_STARTED
        || state === REPORT_DELIVERY_STATE.AMBIGUOUS);
    if (ambiguous) {
      log.warn('report_claim_denied_ambiguous', {
        user_id: uid, report_type: reportType, local_date: localDateKey, state,
      });
    } else {
      log.info('report_claim_denied', {
        user_id: uid, report_type: reportType, local_date: localDateKey, already_sent: alreadySent,
      });
    }
    return { granted: false, alreadySent, ambiguous, owner: null };
  }

  /**
   * 延長租約（只有還握著、而且**還沒開始送**的持有者可以延）。
   *
   * 報告生成會抓 45 天歷史、算 baseline、再等模型回應 —— 那段時間可能比
   * 租約長。沒有續租的話，正常的長工作會莫名其妙失去所有權。
   *
   * ⚠️ 這是**效率**機制，不是安全機制：即使續租失敗，送出前的
   * authorizeReportDelivery 圍欄仍然會擋下失去所有權的舊 owner。
   * 安全性永遠不依賴「租約夠長」。
   */
  async function renewClaim({
    userId, reportType, localDateKey, owner, ttlMs, now = new Date(),
  }) {
    const uid = requireUserId(userId, 'renewClaim');
    if (!owner) return false;
    const rs = await client.execute({
      sql: `UPDATE report_claims
               SET expires_at = ?
             WHERE user_id = ? AND report_type = ? AND local_date = ?
               AND owner = ? AND expires_at > ?
               AND delivery_state = ? AND telegram_sent_at IS NULL`,
      args: [new Date(now.getTime() + ttlMs).toISOString(), uid, reportType, localDateKey,
        String(owner), now.toISOString(), REPORT_DELIVERY_STATE.CLAIMED],
    });
    return Number(rs.rowsAffected ?? 0) > 0;
  }

  /**
   * ★ 外部送出的授權圍欄（H-02）。**在打 Telegram 之前**呼叫。
   *
   * 一個原子的 UPDATE 同時證明四件事：
   *   1. 這份報告還是**我**的           owner = ?
   *   2. 我的租約**現在**還有效          expires_at > now
   *   3. 還沒有人開始送 / 送成功         delivery_state = CLAIMED
   *   4. 沒有已證明的送出紀錄            telegram_sent_at IS NULL
   *
   * 四件事在同一句 SQL 裡成立，所以「檢查完到寫入之間被別人插隊」不存在。
   *
   * 回 false ⇒ 所有權已經不在了 ⇒ 呼叫端**絕對不可以送**，而且不可以
   * releaseClaim（那會把接手者的狀態刪掉）。舊 owner 就地失效。
   *
   * 回 true 之後這一列就是 DELIVERY_STARTED —— 一個**終局**狀態。
   * 從這一刻起，即使 process 立刻死掉，也不會有第二次自動送出。
   */
  async function authorizeReportDelivery({
    userId, reportType, localDateKey, owner, expectedLifecycleGeneration,
    now = new Date(),
  }) {
    const uid = requireUserId(userId, 'authorizeReportDelivery');
    if (!owner) return false;
    const life = requireLifecycle(expectedLifecycleGeneration, 'authorizeReportDelivery');
    const rs = await client.execute({
      // ★ R3 / R2-REPORT-01：跨進 DELIVERY_STARTED（= 可能已經有外部副作用
      // 的終局狀態）之前，同時證明：擁有權、認領的啟用世代、以及帳號
      // **現在**仍然在同一段啟用期。三者任一不成立就不授權，於是
      // 一個過期的 worker 連 DELIVERY_STARTED 都進不去（也就不會把
      // 當天的遞送名額卡在一個沒有人會完成的狀態）。
      sql: `UPDATE report_claims
               SET delivery_state = ?, delivery_started_at = ?,
                   delivery_attempts = delivery_attempts + 1
             WHERE user_id = ? AND report_type = ? AND local_date = ?
               AND owner = ? AND expires_at > ?
               AND delivery_state = ? AND telegram_sent_at IS NULL
               AND report_claims.lifecycle_generation IS ?
               AND ${lifecycleActiveSql('report_claims.user_id')}`,
      args: [REPORT_DELIVERY_STATE.DELIVERY_STARTED, now.toISOString(),
        uid, reportType, localDateKey, String(owner), now.toISOString(),
        REPORT_DELIVERY_STATE.CLAIMED, life, life],
    });
    const ok = Number(rs.rowsAffected ?? 0) > 0;
    if (!ok) {
      log.warn('report_delivery_authorization_denied', {
        user_id: uid, report_type: reportType, local_date: localDateKey,
      });
    }
    return ok;
  }

  /**
   * DELIVERY_STARTED → DELIVERED。Telegram 明確回報成功之後的第一件事。
   *
   * 刻意是一個極小的 UPDATE：比整筆 report_runs insert 更可能成功，
   * 而且它才是防重發的關鍵證據。
   */
  async function markClaimSent({
    userId, reportType, localDateKey, owner, messageId = null, now = new Date(),
  }) {
    const uid = requireUserId(userId, 'markClaimSent');
    const rs = await client.execute({
      sql: `UPDATE report_claims
               SET telegram_sent_at = ?, telegram_message_id = ?, delivery_state = ?
             WHERE user_id = ? AND report_type = ? AND local_date = ? AND owner = ?
               AND delivery_state = ? AND telegram_sent_at IS NULL`,
      args: [now.toISOString(), messageId, REPORT_DELIVERY_STATE.DELIVERED,
        uid, reportType, localDateKey, owner, REPORT_DELIVERY_STATE.DELIVERY_STARTED],
    });
    return Number(rs.rowsAffected ?? 0) > 0;
  }

  /**
   * DELIVERY_STARTED → AMBIGUOUS（送出結果**證明不了**）。
   *
   * 終局。排程不會再自動送這一份報告。這是刻意的：Telegram 可能已經把
   * 訊息交給使用者了，重送就是讓人收到兩份一樣的健康建議。
   *
   * 註記寫進 delivery_detail 方便事後人工判讀（絕不含訊息內容或祕密）。
   */
  async function markClaimAmbiguous({
    userId, reportType, localDateKey, owner, detail = null, now = new Date(),
  }) {
    const uid = requireUserId(userId, 'markClaimAmbiguous');
    if (!owner) return false;
    const rs = await client.execute({
      sql: `UPDATE report_claims
               SET delivery_state = ?, delivery_detail = ?
             WHERE user_id = ? AND report_type = ? AND local_date = ? AND owner = ?
               AND delivery_state = ? AND telegram_sent_at IS NULL`,
      args: [REPORT_DELIVERY_STATE.AMBIGUOUS, detail ? String(detail).slice(0, 200) : null,
        uid, reportType, localDateKey, String(owner), REPORT_DELIVERY_STATE.DELIVERY_STARTED],
    });
    const ok = Number(rs.rowsAffected ?? 0) > 0;
    if (ok) {
      log.error('report_delivery_ambiguous', {
        user_id: uid, report_type: reportType, local_date: localDateKey,
      });
    }
    return ok;
  }

  async function getClaim(userId, reportType, localDateKey) {
    const uid = requireUserId(userId, 'getClaim');
    const rs = await client.execute({
      sql: `SELECT * FROM report_claims
             WHERE user_id = ? AND report_type = ? AND local_date = ?`,
      args: [uid, reportType, localDateKey],
    });
    const row = rs.rows[0];
    if (!row) return null;
    return {
      userId: row.user_id,
      reportType: row.report_type,
      localDate: row.local_date,
      owner: row.owner,
      claimedAt: row.claimed_at,
      expiresAt: row.expires_at,
      telegramSentAt: row.telegram_sent_at ?? null,
      telegramMessageId: row.telegram_message_id ?? null,
      deliveryState: String(row.delivery_state ?? REPORT_DELIVERY_STATE.CLAIMED),
      deliveryStartedAt: row.delivery_started_at ?? null,
      deliveryAttempts: Number(row.delivery_attempts ?? 0),
      deliveryDetail: row.delivery_detail ?? null,
    };
  }

  /**
   * DELIVERY_STARTED → 整列刪除（回到 UNCLAIMED）。
   *
   * **只有在能證明 Telegram 沒收下時才可以呼叫**：它回了 4xx/5xx、
   * 回了 ok:false，或連線根本沒建立起來。那三種情況下重送是安全的，
   * 而且必要 —— 否則一次暫時性的 400 就讓那天的報告永遠消失。
   *
   * 其餘所有情況（body 讀不到、逾時、形狀不完整）一律走 markClaimAmbiguous。
   * 兩者的差別就是「有沒有證據」，不是「看起來像不像失敗」。
   */
  async function releaseClaimAfterFailedSend({ userId, reportType, localDateKey, owner }) {
    const uid = requireUserId(userId, 'releaseClaimAfterFailedSend');
    if (!owner) return false;
    const rs = await client.execute({
      sql: `DELETE FROM report_claims
             WHERE user_id = ? AND report_type = ? AND local_date = ? AND owner = ?
               AND delivery_state = ? AND telegram_sent_at IS NULL`,
      args: [uid, reportType, localDateKey, String(owner),
        REPORT_DELIVERY_STATE.DELIVERY_STARTED],
    });
    return Number(rs.rowsAffected ?? 0) > 0;
  }

  /**
   * 釋放發送權 —— 只在「**確定**還沒有任何外部副作用」時呼叫。
   *
   * 所以條件除了 owner 相符，還要求 delivery_state 仍然是 CLAIMED：
   * 一旦跨過 authorizeReportDelivery，這一列就不可以再被刪掉，
   * 否則下一輪會重新 claim 而重送一份可能已經送達的報告。
   */
  async function releaseClaim({ userId, reportType, localDateKey, owner }) {
    const uid = requireUserId(userId, 'releaseClaim');
    const rs = await client.execute({
      sql: `DELETE FROM report_claims
             WHERE user_id = ? AND report_type = ? AND local_date = ? AND owner = ?
               AND delivery_state = ? AND telegram_sent_at IS NULL`,
      args: [uid, reportType, localDateKey, owner, REPORT_DELIVERY_STATE.CLAIMED],
    });
    return Number(rs.rowsAffected ?? 0) > 0;
  }

  /**
   * ★ v17：帳號啟用圍欄，**在目前的交易裡**求值。
   *
   * 給「已經抓回資料、準備落地」的寫入者用（同步、webhook、對帳）：
   * 在同一個交易裡先證明帳號仍然 ACTIVE 且仍在同一段啟用期，證不出來就拋，
   * 整個交易回滾 —— 於是 canonical 列與游標**一起**不動，不會出現
   * 「資料沒寫進去但進度前進了」那種永久性的破洞。
   *
   * @throws {AccountInactiveError}
   */
  async function assertAccountActive(userId, expectedLifecycleGeneration = null) {
    const uid = requireUserId(userId, 'assertAccountActive');
    const rs = await client.execute({
      sql: 'SELECT status, lifecycle_generation FROM users WHERE id = ?',
      args: [uid],
    });
    const row = rs.rows[0];
    const ok = row
      && String(row.status) === USER_STATUS.ACTIVE
      && (!Number.isInteger(expectedLifecycleGeneration)
        || Number(row.lifecycle_generation ?? 1) === expectedLifecycleGeneration);
    if (!ok) {
      log.warn('account_lifecycle_rejected', {
        user_id: uid,
        user_status: row ? String(row.status) : null,
        expected_lifecycle: expectedLifecycleGeneration,
        current_lifecycle: row ? Number(row.lifecycle_generation ?? 1) : null,
      });
      throw new AccountInactiveError(uid);
    }
    return true;
  }

  return {
    raw: client,
    transaction: processing.transaction,
    assertAccountActive,
    withAnswerOwnership,
    processTelegramOperation,
    mutateForWhoopEvent,
    mutateForReconciliation,
    getTelegramOperation,
    markDeliveryStarted,
    markDelivered,
    markDeliveryFailed,
    markDeliveryAmbiguous,
    markDeliverySuppressed,
    setTelegramUpdateConversation,
    hasEarlierUnfinishedInConversation,
    abandonStaleConversationUpdates,
    outsideProcessingTransaction: processing.outside,
    afterProcessingCommit: processing.afterCommit,
    processingTransactionActive: processing.active,
    migrate,
    // per-user token
    getTokens,
    saveTokens,
    getHistoricalWhoopUserIds,
    whoopHistoryTables,
    findUserByWhoopUserId,
    // per-user 報告
    isSent,
    recordRun,
    recentRuns,
    claimReport,
    renewClaim,
    authorizeReportDelivery,
    markClaimSent,
    markClaimAmbiguous,
    getClaim,
    releaseClaim,
    releaseClaimAfterFailedSend,
    // 錯誤通知（scope 化）
    claimErrorNotify,
    claimErrorNotifyOwned,
    releaseErrorNotify,
    clearErrorNotify,
    hasErrorNotify,
    recordBriefingEvaluation,
    getBriefingEvaluation,
    clearUserErrorNotify: (userId, errorType, { expectedLifecycleGeneration } = {}) =>
      clearErrorNotify(
        userScope(requireUserId(userId, 'clearUserErrorNotify')),
        errorType,
        { expectedLifecycleGeneration },
      ),
    claimGlobalErrorNotify,
    claimUserErrorNotify,
    // 全域 lock（鎖名要自己帶 user）
    acquireLock,
    holdsLock,
    releaseLock,
    userLockName,
    ...createIdentityStore(client, { transaction: processing.transaction }),
    // 墓碑判定與 canonical 寫入必須同一交易（P1-R02-RC2）：把「需要時才開交易」
    // 的執行器交給儲存層。已在 mutateForWhoopEvent 交易裡時會直接沿用，不巢狀。
    ...health,
    // V1.2 Phase 1：WHOOP webhook 事件帳本 + 刪除墓碑。
    ...webhook,
    // V1.2 Phase 2：對帳狀態 / 執行帳本 / 差異 / 墓碑診斷。
    ...createReconciliationStore(client),
    ...createBotStore(client),
    ...createAnalysisStore(client),
    ...createProactiveStore(client),
    ...createGuardianStore(client),
    // V1.2 Phase 3.5：自助上線的生命週期（沒有列 = 舊使用者 = READY）。
    ...createOnboardingStore(client, { transaction: processing.transaction }),
    // V1.2 Phase 3：分析工作狀態（失效 / 認領 / 結案 / 物化 / 帳本）。
    ...analytics,
    // V1.2 Phase 3：canonical 寫入器的**同交易**分析失效。放在最後，覆蓋上面
    // health / webhook 的同名函式 —— 所有寫入者（V1.1 同步、webhook 處理器、
    // 對帳、腳本）都經過這一層；它呼叫的仍是原本的儲存層函式。
    ...withAnalyticsInvalidation({
      health, webhook, analytics, client, transaction: processing.transaction,
    }),
    close: () => client.close(),
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
