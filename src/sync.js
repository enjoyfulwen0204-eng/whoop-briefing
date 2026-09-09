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
import { isScopeError } from './whoop.js';
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
 * 而走鐘的後果是「每 30 分鐘白打一次 WHOOP」或「該同步的時候不同步」。
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
export function createSync({ db, whoop, userId, timezone, now = new Date() }) {
  const uid = requireUserId(userId, 'createSync');
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

  /** 抓一個時間窗並寫入。 */
  async function syncWindow(resource, fromIso, toIso) {
    const payload = POINT_IN_TIME.has(resource)
      ? await fetchers[resource]()
      : await fetchers[resource](fromIso, toIso);
    const count = Array.isArray(payload) ? payload.length : (payload ? 1 : 0);
    const written = await persist(resource, payload);
    return { fetched: count, written };
  }

  /**
   * 增量同步：抓最近 OVERLAP_DAYS 天。
   * 重疊是刻意的 —— WHOOP 的 PENDING_SCORE 會在數小時後變成 SCORED，
   * 只抓「上次之後的新資料」會永遠留著未評分的殘骸。
   */
  async function incremental(resource) {
    const to = now;
    const from = new Date(now.getTime() - WHOOP_SYNC.INCREMENTAL_OVERLAP_DAYS * DAY_MS);
    const r = await syncWindow(resource, from.toISOString(), to.toISOString());
    await db.saveSyncState(uid, resource, {
      latestSynced: to.toISOString(),
      lastSuccessAt: to.toISOString(),
      lastError: null,
      lastErrorAt: null,
    }, { now });
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
      const r = await syncWindow(resource, chunkStart.toISOString(), cursor.toISOString());
      fetched += r.fetched;
      written += r.written;
      cursor = chunkStart;
      chunks += 1;

      // 每個 chunk 成功就存檔 —— 這就是 resume 的關鍵
      await db.saveSyncState(uid, resource, {
        backfillCursor: cursor.toISOString(),
        earliestSynced: cursor.toISOString(),
        lastSuccessAt: new Date().toISOString(),
        lastError: null,
        lastErrorAt: null,
      }, { now });
      log.info('sync_backfill_chunk', {
        resource, from: chunkStart.toISOString(), to: cursor.toISOString(), ...r,
      });
    }

    const complete = cursor.getTime() <= target.getTime();
    if (complete) {
      await db.saveSyncState(uid, resource, { backfillComplete: true }, { now });
      log.info('sync_backfill_complete', { resource, earliest: cursor.toISOString() });
    }
    return {
      resource, mode: 'backfill', chunks, fetched, written, complete,
      cursor: cursor.toISOString(),
    };
  }

  /** point-in-time resource（body measurement）沒有 backfill 的概念。 */
  async function syncPointInTime(resource) {
    const r = await syncWindow(resource, null, null);
    await db.saveSyncState(uid, resource, {
      backfillComplete: true,
      latestSynced: now.toISOString(),
      lastSuccessAt: now.toISOString(),
      lastError: null,
      lastErrorAt: null,
    }, { now });
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
