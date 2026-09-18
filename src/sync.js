/**
 * WHOOP → Turso 長期同步。
 *
 * 兩種模式，同一支程式：
 *   backfill    —— 第一次部署時往回抓歷史（預設 365 天），分 chunk、可 resume。
 *   incremental —— 之後每次只抓最近幾天，並刻意重疊（WHOOP 會重新評分 /
 *                  事後修正資料，所以要 upsert 覆蓋）。
 *
 * 三條不可違反的規則：
 *  1. **同步失敗絕不能讓 Daily Brief 掛掉。** 每個 resource 各自 try/catch，
 *     syncAll() 永遠不往外拋。
 *  2. **scope 不足不是故障。** 加了 read:workout / read:body_measurement 之後，
 *     重新授權之前一定會 401/403，這要被記成 scope_missing 而不是錯誤。
 *  3. **全部 upsert。** 重跑、重疊、resume 都必須冪等。
 */

import { WHOOP_SYNC } from './config.js';
import { isScopeError, isStaleAuthorizationError } from './whoop.js';
import { isAccountInactiveError, requireLifecycle } from './accountLifecycle.js';
import { requireUserId } from './userContext.js';
import { log, describeError } from './logger.js';

const DAY_MS = 86_400_000;

/** 只抓一次就好的 resource（沒有時間區間概念）。 */
const POINT_IN_TIME = new Set(['body_measurement']);

/**
 * 單一 resource「現在該不該同步」。
 *
 * 抽出來當獨立函式，是為了讓 **syncAll 的節流** 與 **cron 的「這次要不要
 * 連 WHOOP」預先判斷** 共用同一份定義。兩邊各寫一次遲早會走鐘，
 * 而走鐘的後果是「每個 scheduler tick 白打一次 WHOOP」或「該同步的時候不同步」。
 *
 * 語義（與抽出來之前逐字等價）：
 *   - 從來沒同步過（沒有狀態列 / lastSuccessAt 是 null）→ 該同步
 *   - backfill 還沒跑完 → 一律該同步（不受節流限制）
 *   - 距離上次成功還不到 MIN_INTERVAL_MS → 節流，不同步
 */
export function resourceSyncDue(state, {
  now = new Date(), minIntervalMs = WHOOP_SYNC.MIN_INTERVAL_MS,
} = {}) {
  const last = state?.lastSuccessAt ? Date.parse(state.lastSuccessAt) : 0;
  const dueForBackfill = Boolean(state) && !state.backfillComplete;
  const throttled = Number.isFinite(last)
    && now.getTime() - last < minIntervalMs
    && !dueForBackfill;
  return !throttled;
}

/**
 * 這個使用者現在有沒有**任何**一個 resource 需要同步。
 *
 * cron 用這個來決定「這一輪要不要為了同步而去拿 WHOOP token」——
 * 全部都在節流中就完全不碰 WHOOP。
 *
 * 讀不到狀態時保守回 true（寧可嘗試同步，也不要因為查詢失敗而靜靜停擺；
 * 真的連不上時 syncAll 內部會各自 try/catch 並記錄）。
 */
export async function isSyncDue({
  db, userId, now = new Date(), resources = WHOOP_SYNC.RESOURCES,
}) {
  const uid = requireUserId(userId, 'isSyncDue');
  for (const resource of resources) {
    let state = null;
    try {
      state = await db.getSyncState(uid, resource);
    } catch {
      return true;
    }
    if (resourceSyncDue(state, { now })) return true;
  }
  return false;
}

/**
 * @param {object} o
 * @param {string} o.userId  **必填**。這個 sync 屬於哪個內部使用者。
 * @param {string} o.timezone 該使用者的時區（不是全域 TIMEZONE）
 */
export function createSync({
  db, whoop, userId, timezone, expectedLifecycleGeneration, now = new Date(),
}) {
  const uid = requireUserId(userId, 'createSync');
  // ★ R2 §34：正式的健康同步**必須**帶啟用脈絡。
  //
  // 第一版讓它是選用的，沒傳就退化成不受約束 —— 於是手動同步 CLI 安靜地
  // 失去了保護，而且沒有任何訊號。現在缺少就大聲失敗；測試夾具與管理用途
  // 必須明確寫出 LIFECYCLE_UNFENCED，那是一個 grep 得到的決定。
  const lifecycleFence = requireLifecycle(expectedLifecycleGeneration, 'createSync');

  /**
   * ★ v17：抓到的資料 + 游標推進 = **一個**不可分割的單位。
   *
   * 網路在交易外（絕不在寫入交易裡等 provider），落地在交易內，而交易的
   * 第一件事就是證明帳號仍然 ACTIVE 且仍在同一段啟用期。證不出來就拋，
   * 整個交易回滾：canonical 列沒寫，游標也**沒有前進**。
   *
   * 這個「一起成功或一起不動」是關鍵：如果只擋資料寫入而讓游標前進，
   * 那段時間的資料會被永久跳過，而且沒有任何地方看得出來。
   */
  const lifecycleFenced = lifecycleFence !== null;

  async function commitWindow(resource, payload, cursorPatch) {
    return db.transaction(async () => {
      // 只有**帶著啟用脈絡**的呼叫端才受圍欄約束（與這次修正其他地方一致）。
      // 正式路徑（排程器 runForUser、上線 bootstrap）都會帶；沒有帶的是
      // 腳本／測試夾具那種「沒有帳號脈絡」的情境，行為維持不變。
      if (lifecycleFenced) await db.assertAccountActive(uid, lifecycleFence);
      const written = await persist(resource, payload);
      if (cursorPatch) await db.saveSyncState(uid, resource, cursorPatch, { now });
      return written;
    });
  }
  /**
   * 一個 resource 的抓取器。全部沿用 whoop client 既有的
   * collect / pagination / retry / rate-limit / 401-refresh 機制。
   */
  const fetchers = {
    sleep: (from, to) => whoop.sleeps(from, to),
    recovery: (from, to) => whoop.recoveries(from, to),
    cycle: (from, to) => whoop.cycles(from, to),
    workout: (from, to) => whoop.workouts(from, to),
    body_measurement: () => whoop.bodyMeasurement(),
  };

  /** 把抓到的東西寫進對應的表。回傳寫入筆數。 */
  async function persist(resource, payload) {
    switch (resource) {
      case 'sleep': return db.upsertSleeps(uid, payload, { timezone, now });
      case 'recovery': return db.upsertRecoveries(uid, payload, { now });
      case 'cycle': return db.upsertCycles(uid, payload, { now });
      case 'workout': return db.upsertWorkouts(uid, payload, { timezone, now });
      case 'body_measurement': return db.upsertBodyMeasurement(uid, payload, { now });
      default: throw new Error(`未知的 resource：${resource}`);
    }
  }

  /** 抓一個時間窗（純網路，不落地）。 */
  async function fetchWindow(resource, fromIso, toIso) {
    // ★ R3 / R2-STAGE-01：每一次**獨立發出**的 provider 抓取之前重新驗證。
    // 一個窗內的分頁序列是一個有界階段，不逐頁檢查；但 incremental 與
    // backfill 的每一個 chunk 都是新的請求，各自驗一次。
    if (lifecycleFenced) await db.assertAccountActive(uid, lifecycleFence);
    const payload = POINT_IN_TIME.has(resource)
      ? await fetchers[resource]()
      : await fetchers[resource](fromIso, toIso);
    return { payload, fetched: Array.isArray(payload) ? payload.length : (payload ? 1 : 0) };
  }

  /** 抓一個時間窗並**與游標一起**落地。 */
  async function syncWindow(resource, fromIso, toIso, cursorPatch = null) {
    const { payload, fetched } = await fetchWindow(resource, fromIso, toIso);
    const written = await commitWindow(resource, payload, cursorPatch);
    return { fetched, written };
  }

  /**
   * 增量同步：抓最近 OVERLAP_DAYS 天。
   * 重疊是刻意的 —— WHOOP 的 PENDING_SCORE 會在數小時後變成 SCORED，
   * 只抓「上次之後的新資料」會永遠留著未評分的殘骸。
   */
  async function incremental(resource) {
    const to = now;
    const from = new Date(now.getTime() - WHOOP_SYNC.INCREMENTAL_OVERLAP_DAYS * DAY_MS);
    // 資料與進度在同一個交易裡（見 commitWindow）。
    const r = await syncWindow(resource, from.toISOString(), to.toISOString(), {
      latestSynced: to.toISOString(),
      lastSuccessAt: to.toISOString(),
      lastError: null,
      lastErrorAt: null,
    });
    log.info('sync_incremental_done', { resource, ...r });
    return { resource, mode: 'incremental', ...r };
  }

  /**
   * Backfill：從 cursor 往回一次推進最多 MAX_CHUNKS_PER_RUN 個 chunk。
   *
   * cursor 的語義 = 「已經往回抓到這個時間點了」。每個 chunk 成功寫入後
   * 立刻存檔，所以中途失敗（rate limit / 部署重啟）下次會從斷點續傳，
   * 不會從頭再來。
   */
  async function backfill(resource) {
    const state = (await db.getSyncState(uid, resource)) ?? {};
    if (state.backfillComplete) return { resource, mode: 'backfill', status: 'already_complete' };

    const target = new Date(now.getTime() - WHOOP_SYNC.BACKFILL_DAYS * DAY_MS);
    let cursor = state.backfillCursor ? new Date(state.backfillCursor) : now;

    let chunks = 0;
    let fetched = 0;
    let written = 0;

    while (chunks < WHOOP_SYNC.MAX_CHUNKS_PER_RUN && cursor.getTime() > target.getTime()) {
      const chunkStart = new Date(
        Math.max(target.getTime(), cursor.getTime() - WHOOP_SYNC.BACKFILL_CHUNK_DAYS * DAY_MS),
      );
      // 每個 chunk 的資料與它的游標在**同一個交易**裡落地 —— 這既是 resume
      // 的關鍵，也是「被拒絕的資料不會讓進度前進」的保證。
      const r = await syncWindow(resource, chunkStart.toISOString(), cursor.toISOString(), {
        backfillCursor: chunkStart.toISOString(),
        earliestSynced: chunkStart.toISOString(),
        lastSuccessAt: new Date().toISOString(),
        lastError: null,
        lastErrorAt: null,
      });
      fetched += r.fetched;
      written += r.written;
      cursor = chunkStart;
      chunks += 1;
      log.info('sync_backfill_chunk', {
        resource, from: chunkStart.toISOString(), to: cursor.toISOString(), ...r,
      });
    }

    const complete = cursor.getTime() <= target.getTime();
    if (complete) {
      await db.transaction(async () => {
        if (lifecycleFenced) await db.assertAccountActive(uid, lifecycleFence);
        await db.saveSyncState(uid, resource, { backfillComplete: true }, { now });
      });
      log.info('sync_backfill_complete', { resource, earliest: cursor.toISOString() });
    }
    return {
      resource, mode: 'backfill', chunks, fetched, written, complete,
      cursor: cursor.toISOString(),
    };
  }

  /** point-in-time resource（body measurement）沒有 backfill 的概念。 */
  async function syncPointInTime(resource) {
    const r = await syncWindow(resource, null, null, {
      backfillComplete: true,
      latestSynced: now.toISOString(),
      lastSuccessAt: now.toISOString(),
      lastError: null,
      lastErrorAt: null,
    });
    log.info('sync_point_in_time_done', { resource, ...r });
    return { resource, mode: 'point_in_time', ...r };
  }

  /** 單一 resource：先補歷史，再抓最近。 */
  async function syncResource(resource) {
    if (POINT_IN_TIME.has(resource)) return syncPointInTime(resource);

    const inc = await incremental(resource);
    const back = await backfill(resource);
    return { resource, incremental: inc, backfill: back };
  }

  /**
   * 全部同步。**永遠不拋錯** —— 這是給 cron 在簡報之後呼叫的附加工作。
   *
   * @param {boolean} force 忽略 MIN_INTERVAL_MS 節流（手動 / 腳本用）
   */
  async function syncAll({ force = false, resources = WHOOP_SYNC.RESOURCES } = {}) {
    const results = [];
    for (const resource of resources) {
      try {
        // ★ R3 / R2-STAGE-01：階段邊界在 fetchWindow 裡（每一次獨立的 provider
        // 抓取之前）。落地圍欄仍然是最後一道。
        if (!force) {
          // 節流的唯一定義在 resourceSyncDue()，cron 的預先判斷用的是同一份
          const state = await db.getSyncState(uid, resource);
          if (!resourceSyncDue(state, { now })) {
            results.push({ resource, status: 'throttled' });
            continue;
          }
        }
        results.push({ status: 'ok', ...(await syncResource(resource)) });
      } catch (err) {
        // ★ F04：授權世代已經換了 —— 這一輪是以一個**過期的授權**開始的。
        //
        // 必須排在 scope 判定之前，而且必須**停止**後面的資源：繼續跑只會
        // 產生更多無法歸屬的觀測。也不寫 lastError —— 這不是故障，寫進去
        // 會讓一個純內部競態長得像 provider 壞掉。
        // ★ v17：帳號層級的停止排在最前面 —— 它既不是缺 scope，也不是故障，
        // 而且必須立刻停止後面的資源（繼續跑只會產生更多不屬於這個帳號的工作）。
        if (isAccountInactiveError(err)) {
          log.info('sync_account_inactive', { resource });
          results.push({ resource, status: 'account_inactive' });
          break;
        }
        if (isStaleAuthorizationError(err)) {
          log.warn('sync_stale_authorization', { resource });
          results.push({ resource, status: 'stale_authorization' });
          break;
        }
        // scope 不足是「還沒重新授權」，不是故障 —— 不可以觸發錯誤通知
        const scope = isScopeError(err);
        const detail = scope ? 'scope_missing' : describeError(err);
        try {
          await db.saveSyncState(uid, resource, {
            lastError: detail,
            lastErrorAt: new Date().toISOString(),
          }, { now });
        } catch { /* 連狀態都寫不進去就算了，不能讓同步拖垮簡報 */ }
        if (scope) {
          log.warn('sync_scope_missing', { resource, hint: '需要重跑 npm run authorize' });
        } else {
          log.error('sync_failed', { resource, error: detail });
        }
        results.push({ resource, status: scope ? 'scope_missing' : 'failed', error: detail });
      }
    }
    log.info('sync_all_done', {
      ok: results.filter((r) => r.status === 'ok').length,
      throttled: results.filter((r) => r.status === 'throttled').length,
      failed: results.filter((r) => r.status === 'failed').length,
      scope_missing: results.filter((r) => r.status === 'scope_missing').length,
    });
    return results;
  }

  return { syncAll, syncResource, incremental, backfill };
}
