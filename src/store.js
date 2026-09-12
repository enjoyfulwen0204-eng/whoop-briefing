/**
 * 長期健康資料落地層。
 *
 * 設計原則：
 *  - 全部 upsert（ON CONFLICT DO UPDATE）。WHOOP 會重新評分（PENDING_SCORE →
 *    SCORED）或事後修正資料，所以同一個 id 再抓到就整列覆蓋，last-write-wins。
 *  - 一律保留 raw_json。未來 WHOOP 新增欄位時不必重抓就能回頭解析。
 *  - health_date 的定義與 analyze.js 完全相同（sleep.end 的當地日期），
 *    絕不另立一套時間軸。
 *  - 這一層只做「存」與「取」，不做任何健康判斷。
 */

import { num, sleepTotalMilli } from './config.js';
import { localDate } from './time.js';
import { log } from './logger.js';
import { requireUserId } from './userContext.js';

/** 每批寫入的筆數上限（避免單一 batch payload 過大）。 */
const BATCH_SIZE = 100;

const iso = (v) => (v ? new Date(v).toISOString() : null);
const bool = (v) => (typeof v === 'boolean' ? (v ? 1 : 0) : null);
const str = (v) => (v === null || v === undefined ? null : String(v));

/** 把 rows 切成小批，用 libSQL batch 寫入。回傳實際寫入筆數。 */
async function writeBatched(client, statements) {
  let written = 0;
  for (let i = 0; i < statements.length; i += BATCH_SIZE) {
    const chunk = statements.slice(i, i + BATCH_SIZE);
    await client.batch(chunk, 'write');
    written += chunk.length;
  }
  return written;
}

export function createHealthStore(client) {
  // -------------------------------------------------------------------------
  // Sleep
  // -------------------------------------------------------------------------
  async function upsertSleeps(userId, sleeps = [], { timezone, now = new Date() } = {}) {
    const uid = requireUserId(userId, 'upsertSleeps');
    const syncedAt = now.toISOString();
    const stmts = [];
    for (const s of sleeps) {
      if (!s?.id) continue;
      const g = s?.score?.stage_summary ?? {};
      const need = s?.score?.sleep_needed ?? {};
      const light = num(g.total_light_sleep_time_milli);
      const sws = num(g.total_slow_wave_sleep_time_milli);
      const rem = num(g.total_rem_sleep_time_milli);
      // 與 config.js METRICS 的 sleep_total 完全同一套算法（三段相加，
      // 不含 awake / no-data，也不用 total_in_bed_time_milli）
      // 缺任何一段就存 null —— 存一個少算的總和等於把不完整的資料
      // 偽裝成完整的（見 config.js sleepTotalMilli 的說明）。
      const total = sleepTotalMilli(g);

      stmts.push({
        sql: `INSERT INTO whoop_sleeps (
                user_id, id, v1_id, whoop_user_id, health_date, start_at, end_at, timezone_offset,
                nap, score_state, respiratory_rate, sleep_performance_percentage,
                sleep_consistency_percentage, sleep_efficiency_percentage,
                total_sleep_milli, light_sleep_milli, slow_wave_sleep_milli,
                rem_sleep_milli, awake_milli, no_data_milli, in_bed_milli,
                disturbance_count, sleep_cycle_count, sleep_need_baseline_milli,
                sleep_debt_milli, sleep_need_recent_strain_milli,
                sleep_need_recent_nap_milli, created_at, updated_at, synced_at, raw_json
              ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
              ON CONFLICT(user_id, id) DO UPDATE SET
                v1_id=excluded.v1_id, whoop_user_id=excluded.whoop_user_id,
                health_date=excluded.health_date, start_at=excluded.start_at,
                end_at=excluded.end_at, timezone_offset=excluded.timezone_offset,
                nap=excluded.nap, score_state=excluded.score_state,
                respiratory_rate=excluded.respiratory_rate,
                sleep_performance_percentage=excluded.sleep_performance_percentage,
                sleep_consistency_percentage=excluded.sleep_consistency_percentage,
                sleep_efficiency_percentage=excluded.sleep_efficiency_percentage,
                total_sleep_milli=excluded.total_sleep_milli,
                light_sleep_milli=excluded.light_sleep_milli,
                slow_wave_sleep_milli=excluded.slow_wave_sleep_milli,
                rem_sleep_milli=excluded.rem_sleep_milli,
                awake_milli=excluded.awake_milli, no_data_milli=excluded.no_data_milli,
                in_bed_milli=excluded.in_bed_milli,
                disturbance_count=excluded.disturbance_count,
                sleep_cycle_count=excluded.sleep_cycle_count,
                sleep_need_baseline_milli=excluded.sleep_need_baseline_milli,
                sleep_debt_milli=excluded.sleep_debt_milli,
                sleep_need_recent_strain_milli=excluded.sleep_need_recent_strain_milli,
                sleep_need_recent_nap_milli=excluded.sleep_need_recent_nap_milli,
                created_at=excluded.created_at, updated_at=excluded.updated_at,
                synced_at=excluded.synced_at, raw_json=excluded.raw_json`,
        args: [
          uid, String(s.id), num(s.v1_id), num(s.user_id),
          s.end ? localDate(s.end, timezone) : null,
          iso(s.start), iso(s.end), str(s.timezone_offset),
          bool(s.nap), str(s.score_state),
          num(s?.score?.respiratory_rate),
          num(s?.score?.sleep_performance_percentage),
          num(s?.score?.sleep_consistency_percentage),
          num(s?.score?.sleep_efficiency_percentage),
          total, light, sws, rem,
          num(g.total_awake_time_milli), num(g.total_no_data_time_milli),
          num(g.total_in_bed_time_milli),
          num(g.disturbance_count), num(g.sleep_cycle_count),
          num(need.baseline_milli), num(need.need_from_sleep_debt_milli),
          num(need.need_from_recent_strain_milli), num(need.need_from_recent_nap_milli),
          iso(s.created_at), iso(s.updated_at), syncedAt, JSON.stringify(s),
        ],
      });
    }
    const n = await writeBatched(client, stmts);
    if (n) log.info('store_sleeps_upserted', { user_id: uid, count: n });
    return n;
  }

  // -------------------------------------------------------------------------
  // Recovery
  // -------------------------------------------------------------------------
  async function upsertRecoveries(userId, recoveries = [], { now = new Date() } = {}) {
    const uid = requireUserId(userId, 'upsertRecoveries');
    const syncedAt = now.toISOString();
    const stmts = [];
    for (const r of recoveries) {
      if (!r?.sleep_id) continue;
      stmts.push({
        sql: `INSERT INTO whoop_recoveries (
                user_id, sleep_id, cycle_id, whoop_user_id, health_date, score_state,
                recovery_score, hrv_rmssd_milli, resting_heart_rate,
                spo2_percentage, skin_temp_celsius, user_calibrating,
                created_at, updated_at, synced_at, raw_json
              ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
              ON CONFLICT(user_id, sleep_id) DO UPDATE SET
                cycle_id=excluded.cycle_id, whoop_user_id=excluded.whoop_user_id,
                score_state=excluded.score_state,
                recovery_score=excluded.recovery_score,
                hrv_rmssd_milli=excluded.hrv_rmssd_milli,
                resting_heart_rate=excluded.resting_heart_rate,
                spo2_percentage=excluded.spo2_percentage,
                skin_temp_celsius=excluded.skin_temp_celsius,
                user_calibrating=excluded.user_calibrating,
                created_at=excluded.created_at, updated_at=excluded.updated_at,
                synced_at=excluded.synced_at, raw_json=excluded.raw_json`,
        args: [
          uid, String(r.sleep_id), str(r.cycle_id), num(r.user_id),
          null, // health_date 由下面的 relink 從 whoop_sleeps 補上
          str(r.score_state),
          num(r?.score?.recovery_score), num(r?.score?.hrv_rmssd_milli),
          num(r?.score?.resting_heart_rate), num(r?.score?.spo2_percentage),
          num(r?.score?.skin_temp_celsius), bool(r?.score?.user_calibrating),
          iso(r.created_at), iso(r.updated_at), syncedAt, JSON.stringify(r),
        ],
      });
    }
    const n = await writeBatched(client, stmts);
    if (n) {
      await relinkRecoveryDates(uid);
      log.info('store_recoveries_upserted', { user_id: uid, count: n });
    }
    return n;
  }

  /**
   * recovery 的 health_date 一律取自它對應的 sleep（唯一真實來源）。
   * upsert 當下那筆 sleep 可能還沒寫進來，所以每次寫完 recovery 都補跑一次。
   * 冪等，而且 sleep 被重新評分改了 health_date 時也會自動跟上。
   */
  async function relinkRecoveryDates(userId) {
    const uid = requireUserId(userId, 'relinkRecoveryDates');
    await client.execute({
      sql: `UPDATE whoop_recoveries
          SET health_date = (SELECT s.health_date FROM whoop_sleeps s
                              WHERE s.user_id = whoop_recoveries.user_id
                                AND s.id = whoop_recoveries.sleep_id)
        WHERE whoop_recoveries.user_id = ?
          AND EXISTS (SELECT 1 FROM whoop_sleeps s
                       WHERE s.user_id = whoop_recoveries.user_id
                         AND s.id = whoop_recoveries.sleep_id)
          AND health_date IS NOT (SELECT s.health_date FROM whoop_sleeps s
                                   WHERE s.user_id = whoop_recoveries.user_id
                                     AND s.id = whoop_recoveries.sleep_id)`,
      args: [uid],
    });
  }

  // -------------------------------------------------------------------------
  // Cycle
  // -------------------------------------------------------------------------
  async function upsertCycles(userId, cycles = [], { now = new Date() } = {}) {
    const uid = requireUserId(userId, 'upsertCycles');
    const syncedAt = now.toISOString();
    const stmts = [];
    for (const c of cycles) {
      if (c?.id === undefined || c?.id === null) continue;
      stmts.push({
        sql: `INSERT INTO whoop_cycles (
                user_id, id, whoop_user_id, start_at, end_at, timezone_offset, score_state,
                strain, kilojoule, average_heart_rate, max_heart_rate,
                created_at, updated_at, synced_at, raw_json
              ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
              ON CONFLICT(user_id, id) DO UPDATE SET
                whoop_user_id=excluded.whoop_user_id, start_at=excluded.start_at,
                end_at=excluded.end_at, timezone_offset=excluded.timezone_offset,
                score_state=excluded.score_state, strain=excluded.strain,
                kilojoule=excluded.kilojoule,
                average_heart_rate=excluded.average_heart_rate,
                max_heart_rate=excluded.max_heart_rate,
                created_at=excluded.created_at, updated_at=excluded.updated_at,
                synced_at=excluded.synced_at, raw_json=excluded.raw_json`,
        args: [
          uid, String(c.id), num(c.user_id), iso(c.start), iso(c.end),
          str(c.timezone_offset), str(c.score_state),
          num(c?.score?.strain), num(c?.score?.kilojoule),
          num(c?.score?.average_heart_rate), num(c?.score?.max_heart_rate),
          iso(c.created_at), iso(c.updated_at), syncedAt, JSON.stringify(c),
        ],
      });
    }
    const n = await writeBatched(client, stmts);
    if (n) log.info('store_cycles_upserted', { user_id: uid, count: n });
    return n;
  }

  // -------------------------------------------------------------------------
  // Workout（欄位完全依官方 v2 WorkoutScore schema）
  // -------------------------------------------------------------------------
  async function upsertWorkouts(userId, workouts = [], { timezone, now = new Date() } = {}) {
    const uid = requireUserId(userId, 'upsertWorkouts');
    const syncedAt = now.toISOString();
    const stmts = [];
    for (const w of workouts) {
      if (!w?.id) continue;
      const z = w?.score?.zone_durations ?? {};
      stmts.push({
        sql: `INSERT INTO whoop_workouts (
                user_id, id, v1_id, whoop_user_id, health_date, start_at, end_at, timezone_offset,
                sport_name, sport_id, score_state, strain, average_heart_rate,
                max_heart_rate, kilojoule, percent_recorded, distance_meter,
                altitude_gain_meter, altitude_change_meter,
                zone_zero_milli, zone_one_milli, zone_two_milli,
                zone_three_milli, zone_four_milli, zone_five_milli,
                created_at, updated_at, synced_at, raw_json
              ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
              ON CONFLICT(user_id, id) DO UPDATE SET
                v1_id=excluded.v1_id, whoop_user_id=excluded.whoop_user_id,
                health_date=excluded.health_date, start_at=excluded.start_at,
                end_at=excluded.end_at, timezone_offset=excluded.timezone_offset,
                sport_name=excluded.sport_name, sport_id=excluded.sport_id,
                score_state=excluded.score_state, strain=excluded.strain,
                average_heart_rate=excluded.average_heart_rate,
                max_heart_rate=excluded.max_heart_rate, kilojoule=excluded.kilojoule,
                percent_recorded=excluded.percent_recorded,
                distance_meter=excluded.distance_meter,
                altitude_gain_meter=excluded.altitude_gain_meter,
                altitude_change_meter=excluded.altitude_change_meter,
                zone_zero_milli=excluded.zone_zero_milli,
                zone_one_milli=excluded.zone_one_milli,
                zone_two_milli=excluded.zone_two_milli,
                zone_three_milli=excluded.zone_three_milli,
                zone_four_milli=excluded.zone_four_milli,
                zone_five_milli=excluded.zone_five_milli,
                created_at=excluded.created_at, updated_at=excluded.updated_at,
                synced_at=excluded.synced_at, raw_json=excluded.raw_json`,
        args: [
          uid, String(w.id), num(w.v1_id), num(w.user_id),
          w.start ? localDate(w.start, timezone) : null,
          iso(w.start), iso(w.end), str(w.timezone_offset),
          str(w.sport_name), num(w.sport_id), str(w.score_state),
          num(w?.score?.strain), num(w?.score?.average_heart_rate),
          num(w?.score?.max_heart_rate), num(w?.score?.kilojoule),
          num(w?.score?.percent_recorded), num(w?.score?.distance_meter),
          num(w?.score?.altitude_gain_meter), num(w?.score?.altitude_change_meter),
          num(z.zone_zero_milli), num(z.zone_one_milli), num(z.zone_two_milli),
          num(z.zone_three_milli), num(z.zone_four_milli), num(z.zone_five_milli),
          iso(w.created_at), iso(w.updated_at), syncedAt, JSON.stringify(w),
        ],
      });
    }
    const n = await writeBatched(client, stmts);
    if (n) log.info('store_workouts_upserted', { user_id: uid, count: n });
    return n;
  }

  // -------------------------------------------------------------------------
  // Body measurement（單一物件，非 collection。用 recorded_at 保留歷史版本）
  // -------------------------------------------------------------------------
  async function upsertBodyMeasurement(userId, bm, { now = new Date() } = {}) {
    const uid = requireUserId(userId, 'upsertBodyMeasurement');
    if (!bm) return 0;
    const syncedAt = now.toISOString();
    // WHOOP 這個 endpoint 不回傳時間戳，所以用「當天」當版本鍵：
    // 同一天重複同步會覆蓋，體重變化則逐日留下歷史。
    const recordedAt = syncedAt.slice(0, 10);
    await client.execute({
      sql: `INSERT INTO whoop_body_measurements
              (user_id, recorded_at, height_meter, weight_kilogram, max_heart_rate,
               synced_at, raw_json)
            VALUES (?,?,?,?,?,?,?)
            ON CONFLICT(user_id, recorded_at) DO UPDATE SET
              height_meter=excluded.height_meter,
              weight_kilogram=excluded.weight_kilogram,
              max_heart_rate=excluded.max_heart_rate,
              synced_at=excluded.synced_at, raw_json=excluded.raw_json`,
      args: [
        uid, recordedAt, num(bm.height_meter), num(bm.weight_kilogram),
        num(bm.max_heart_rate), syncedAt, JSON.stringify(bm),
      ],
    });
    log.info('store_body_measurement_upserted', { user_id: uid, recorded_at: recordedAt });
    return 1;
  }

  // -------------------------------------------------------------------------
  // 讀取
  // -------------------------------------------------------------------------
  const rowsOf = (rs) => rs.rows.map((r) => ({ ...r }));

  /** 某段 health_date 區間的主睡眠（nap = 0），新→舊。 */
  async function getSleeps(userId, { from, to, includeNaps = false } = {}) {
    const uid = requireUserId(userId, 'getSleeps');
    const napClause = includeNaps ? '' : 'AND nap = 0';
    const rs = await client.execute({
      sql: `SELECT * FROM whoop_sleeps
             WHERE user_id = ? AND health_date >= ? AND health_date <= ? ${napClause}
             ORDER BY end_at DESC`,
      args: [uid, from, to],
    });
    return rowsOf(rs);
  }

  async function getRecoveries(userId, { from, to } = {}) {
    const uid = requireUserId(userId, 'getRecoveries');
    const rs = await client.execute({
      sql: `SELECT * FROM whoop_recoveries
             WHERE user_id = ? AND health_date >= ? AND health_date <= ?
             ORDER BY health_date DESC`,
      args: [uid, from, to],
    });
    return rowsOf(rs);
  }

  /** cycles 用 end_at 篩（health_date 對 cycle 沒有意義）。 */
  /**
   * 最新的一個 cycle，**包含還沒結束的那一個**。
   *
   * `getCycles()` 刻意過濾掉 `end_at IS NULL`（分析只能用已結算的週期）。
   * 但「這一夜還在進行中」正是「在等今晚的資料」與「資料掉了」之間唯一的
   * 區別證據，所以診斷需要看得到它。純 SELECT，不改任何既有查詢的語意。
   */
  async function getLatestCycle(userId) {
    const uid = requireUserId(userId, 'getLatestCycle');
    const rs = await client.execute({
      sql: `SELECT id, start_at, end_at, score_state, synced_at FROM whoop_cycles
             WHERE user_id = ? ORDER BY start_at DESC LIMIT 1`,
      args: [uid],
    });
    return rowsOf(rs)[0] ?? null;
  }

  async function getCycles(userId, { fromIso, toIso } = {}) {
    const uid = requireUserId(userId, 'getCycles');
    const rs = await client.execute({
      sql: `SELECT * FROM whoop_cycles
             WHERE user_id = ? AND end_at IS NOT NULL AND end_at >= ? AND end_at <= ?
             ORDER BY end_at DESC`,
      args: [uid, fromIso, toIso],
    });
    return rowsOf(rs);
  }

  async function getWorkouts(userId, { fromIso, toIso } = {}) {
    const uid = requireUserId(userId, 'getWorkouts');
    const rs = await client.execute({
      sql: `SELECT * FROM whoop_workouts
             WHERE user_id = ? AND start_at >= ? AND start_at <= ?
             ORDER BY start_at DESC`,
      args: [uid, fromIso, toIso],
    });
    return rowsOf(rs);
  }

  async function getLatestBodyMeasurement(userId) {
    const uid = requireUserId(userId, 'getLatestBodyMeasurement');
    const rs = await client.execute({
      sql: `SELECT * FROM whoop_body_measurements
             WHERE user_id = ? ORDER BY recorded_at DESC LIMIT 1`,
      args: [uid],
    });
    return rs.rows[0] ? { ...rs.rows[0] } : null;
  }

  /** 資料涵蓋範圍摘要（給 data quality / health-status 用）。 */
  async function coverage(userId) {
    const uid = requireUserId(userId, 'coverage');
    // 每一個子查詢都必須帶 user_id。少一個就會變成「Bob 因為 Alice 有資料
    // 而顯示 READY」—— 這是 capability / data-quality 最容易出的隔離漏洞。
    const rs = await client.execute({
      sql: `
      SELECT
        (SELECT COUNT(*) FROM whoop_sleeps WHERE user_id = ? AND nap = 0)      AS main_sleeps,
        (SELECT COUNT(*) FROM whoop_sleeps WHERE user_id = ? AND nap = 1)      AS naps,
        (SELECT MIN(health_date) FROM whoop_sleeps WHERE user_id = ? AND nap = 0) AS first_date,
        (SELECT MAX(health_date) FROM whoop_sleeps WHERE user_id = ? AND nap = 0) AS last_date,
        (SELECT COUNT(*) FROM whoop_recoveries WHERE user_id = ?)              AS recoveries,
        (SELECT COUNT(*) FROM whoop_recoveries
          WHERE user_id = ? AND score_state = 'SCORED')                        AS scored_recoveries,
        (SELECT COUNT(*) FROM whoop_cycles   WHERE user_id = ?)                AS cycles,
        (SELECT COUNT(*) FROM whoop_workouts WHERE user_id = ?)                AS workouts,
        (SELECT COUNT(*) FROM whoop_sleeps
          WHERE user_id = ? AND nap = 0 AND score_state <> 'SCORED')           AS unscored_sleeps
    `,
      args: Array(9).fill(uid),
    });
    return { ...rs.rows[0] };
  }

  // -------------------------------------------------------------------------
  // 同步狀態
  // -------------------------------------------------------------------------
  async function getSyncState(userId, resource) {
    const uid = requireUserId(userId, 'getSyncState');
    const rs = await client.execute({
      sql: 'SELECT * FROM whoop_sync_state WHERE user_id = ? AND resource = ?',
      args: [uid, resource],
    });
    const row = rs.rows[0];
    if (!row) return null;
    return {
      resource: row.resource,
      backfillComplete: Number(row.backfill_complete) === 1,
      backfillCursor: row.backfill_cursor ?? null,
      earliestSynced: row.earliest_synced ?? null,
      latestSynced: row.latest_synced ?? null,
      lastSuccessAt: row.last_success_at ?? null,
      lastError: row.last_error ?? null,
      lastErrorAt: row.last_error_at ?? null,
      updatedAt: row.updated_at,
    };
  }

  async function getAllSyncState(userId) {
    const uid = requireUserId(userId, 'getAllSyncState');
    const rs = await client.execute({
      sql: 'SELECT * FROM whoop_sync_state WHERE user_id = ? ORDER BY resource',
      args: [uid],
    });
    return rowsOf(rs);
  }

  /** 只更新有傳進來的欄位（其餘保持原值）。 */
  async function saveSyncState(userId, resource, patch = {}, { now = new Date() } = {}) {
    const uid = requireUserId(userId, 'saveSyncState');
    const cur = (await getSyncState(uid, resource)) ?? {};
    const merged = {
      backfillComplete: patch.backfillComplete ?? cur.backfillComplete ?? false,
      backfillCursor: patch.backfillCursor !== undefined ? patch.backfillCursor : (cur.backfillCursor ?? null),
      earliestSynced: patch.earliestSynced !== undefined ? patch.earliestSynced : (cur.earliestSynced ?? null),
      latestSynced: patch.latestSynced !== undefined ? patch.latestSynced : (cur.latestSynced ?? null),
      lastSuccessAt: patch.lastSuccessAt !== undefined ? patch.lastSuccessAt : (cur.lastSuccessAt ?? null),
      lastError: patch.lastError !== undefined ? patch.lastError : (cur.lastError ?? null),
      lastErrorAt: patch.lastErrorAt !== undefined ? patch.lastErrorAt : (cur.lastErrorAt ?? null),
    };
    await client.execute({
      sql: `INSERT INTO whoop_sync_state
              (user_id, resource, backfill_complete, backfill_cursor, earliest_synced,
               latest_synced, last_success_at, last_error, last_error_at, updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(user_id, resource) DO UPDATE SET
              backfill_complete=excluded.backfill_complete,
              backfill_cursor=excluded.backfill_cursor,
              earliest_synced=excluded.earliest_synced,
              latest_synced=excluded.latest_synced,
              last_success_at=excluded.last_success_at,
              last_error=excluded.last_error,
              last_error_at=excluded.last_error_at,
              updated_at=excluded.updated_at`,
      args: [
        uid, resource, merged.backfillComplete ? 1 : 0, merged.backfillCursor,
        merged.earliestSynced, merged.latestSynced, merged.lastSuccessAt,
        merged.lastError ? String(merged.lastError).slice(0, 500) : null,
        merged.lastErrorAt, now.toISOString(),
      ],
    });
    return merged;
  }

  // -------------------------------------------------------------------------
  // Capability
  // -------------------------------------------------------------------------
  async function saveCapabilities(userId, entries = [], { now = new Date() } = {}) {
    const uid = requireUserId(userId, 'saveCapabilities');
    const probedAt = now.toISOString();
    const stmts = entries.map((e) => ({
      sql: `INSERT INTO whoop_capabilities
              (user_id, key, status, sample_count, non_null_count, latest_value,
               first_seen_at, last_seen_at, last_probed_at, detail)
            VALUES (?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(user_id, key) DO UPDATE SET
              status=excluded.status,
              sample_count=excluded.sample_count,
              non_null_count=excluded.non_null_count,
              latest_value=excluded.latest_value,
              -- first_seen_at 只在「以前沒看過、這次看到了」時才寫入
              first_seen_at=COALESCE(whoop_capabilities.first_seen_at, excluded.first_seen_at),
              last_seen_at=COALESCE(excluded.last_seen_at, whoop_capabilities.last_seen_at),
              last_probed_at=excluded.last_probed_at,
              detail=excluded.detail`,
      args: [
        uid, e.key, e.status, e.sampleCount ?? null, e.nonNullCount ?? null,
        e.latestValue === null || e.latestValue === undefined ? null : String(e.latestValue),
        e.nonNullCount > 0 ? probedAt : null,
        e.nonNullCount > 0 ? probedAt : null,
        probedAt, e.detail ?? null,
      ],
    }));
    const n = await writeBatched(client, stmts);
    log.info('capabilities_saved', { user_id: uid, count: n });
    return n;
  }

  async function getCapabilities(userId) {
    const uid = requireUserId(userId, 'getCapabilities');
    const rs = await client.execute({
      sql: 'SELECT * FROM whoop_capabilities WHERE user_id = ? ORDER BY key',
      args: [uid],
    });
    const out = {};
    for (const row of rs.rows) {
      out[row.key] = {
        key: row.key,
        status: row.status,
        sampleCount: row.sample_count,
        nonNullCount: row.non_null_count,
        latestValue: row.latest_value,
        firstSeenAt: row.first_seen_at,
        lastSeenAt: row.last_seen_at,
        lastProbedAt: row.last_probed_at,
        detail: row.detail,
      };
    }
    return out;
  }

  return {
    upsertSleeps,
    upsertRecoveries,
    upsertCycles,
    upsertWorkouts,
    upsertBodyMeasurement,
    relinkRecoveryDates,
    getSleeps,
    getRecoveries,
    getCycles,
    getLatestCycle,
    getWorkouts,
    getLatestBodyMeasurement,
    coverage,
    getSyncState,
    getAllSyncState,
    saveSyncState,
    saveCapabilities,
    getCapabilities,
  };
}
