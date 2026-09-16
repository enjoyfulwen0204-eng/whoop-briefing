/**
 * Canonical 寫入 → 分析失效（V1.2 Phase 3 的攝取端）。
 *
 * ## 這一層在哪裡
 *
 * db.js 用它把 canonical 儲存層的寫入器（upsertSleeps / upsertRecoveries /
 * upsertWorkouts / upsertCycles / upsertBodyMeasurement / deleteWhoopResource）
 * **各包一層**。所有寫入者 —— V1.1 排程同步、Phase 1 webhook 處理器、Phase 2
 * 對帳、腳本、測試 —— 都經過同一個入口，所以沒有任何一條路徑可以改了
 * canonical 卻沒讓分析知道。它不是另一個 WHOOP 寫入者：它呼叫的就是原本的
 * 儲存層函式，M-03 新鮮度與 ACTIVE 墓碑判定原封不動。
 *
 * ## 崩潰一致性（Phase 3 的主要閘門）
 *
 * 包裝器在 processing.transaction 裡執行：
 *
 *   BEGIN IMMEDIATE
 *     之前快照（id → updated_at）
 *     原本的 canonical 寫入（含墓碑判定、M-03）
 *     之後快照
 *     語義比對 → 有變化才 markAnalyticsDirty（同一交易）
 *   COMMIT
 *
 * 已經在 mutateForWhoopEvent / mutateForReconciliation 的交易裡時，
 * processing.transaction 直接沿用父交易（不巢狀）。所以「canonical 提交了、
 * 失效沒提交」在結構上不存在：兩者是同一個 commit。崩潰在 commit 之前 →
 * 兩者都不在；之後 → 兩者都在。不需要任何「稍後補記」的復原機制。
 *
 * ## 語義變化，不是傳輸活動
 *
 * 每一筆依「之前 / 之後 / 進來的版本」分成：
 *   CHANGED    之前沒有，或 updated_at 嚴格更新       → 失效
 *   UNCHANGED  同一版本重放（M-03 的「相等冪等」）     → 不失效
 *   BLOCKED    進來的版本比較舊（M-03 擋下），或之後仍然沒有列（ACTIVE 墓碑擋下）→ 不失效
 *   DELETED    權威 DELETE 真的移走了一列              → 失效
 *
 * updated_at 是 WHOOP 的來源版本（M-03 已經以它為權威）；Phase 3 不引入任何
 * 本地時序。body_measurement 沒有 updated_at → 比對數值本身。
 *
 * ## 受影響日期
 *
 * sleep / recovery / workout 用 canonical 的 health_date（沒有就退回 start / created
 * 的日期）；cycle 用 start 的日期與其後一天（昨日 Strain 單向對應）；
 * body_measurement 用快照日。範圍取聯集；下游的日期依賴（±1 天）在輕量路徑
 * 展開，重量路徑本來就是整段回看重算。
 */

import { requireUserId } from './userContext.js';
import { CANONICAL_CHANGE } from './schema.js';
import { addDays } from './time.js';
import { log } from './logger.js';

const CHUNK = 200;

/** 每種資源在 canonical 表裡的定位與日期欄位。 */
const SPEC = Object.freeze({
  sleep: {
    table: 'whoop_sleeps', idColumn: 'id', idOf: (r) => r?.id,
    dateSql: 'COALESCE(health_date, substr(end_at, 1, 10), substr(start_at, 1, 10))',
  },
  recovery: {
    table: 'whoop_recoveries', idColumn: 'sleep_id', idOf: (r) => r?.sleep_id,
    dateSql: 'COALESCE(health_date, substr(created_at, 1, 10))',
    // 日期**關聯**本身（可為 NULL）：變化偵測看這個，不看 COALESCE 過的日期，
    // 否則「NULL → D」在 D 剛好等於 created_at 的日期時會被誤判成沒變。
    linkSql: 'health_date',
    relinks: true,   // upsertRecoveries 之後會 relink 整個使用者的 health_date
  },
  workout: {
    table: 'whoop_workouts', idColumn: 'id', idOf: (r) => r?.id,
    dateSql: 'COALESCE(health_date, substr(end_at, 1, 10), substr(start_at, 1, 10))',
  },
  cycle: {
    table: 'whoop_cycles', idColumn: 'id', idOf: (r) => r?.id,
    dateSql: 'substr(start_at, 1, 10)', spansNextDay: true,
  },
});

const isoOrNull = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

/**
 * recovery 的 health_date 不是它自己的欄位，而是從對應的 sleep **關聯**過來的
 * （store 的 relinkRecoveryDates 會在 upsertRecoveries 之後改寫**所有**列）。
 * 所以 recovery 的快照要看這個使用者的全部列，不只這一批 —— 一次 upsert 可能
 * 讓別的 recovery 換了日期。一天最多一筆，成本有界。（P3-AUDIT-F02）
 */
const rowEntry = (spec, r) => ({
  updatedAt: isoOrNull(r.updated_at),
  date: r.d ? String(r.d) : null,
  // 有 linkSql 的資源：link 是原始的日期關聯，**NULL 就是 NULL**（不退回日期）
  ...(spec.linkSql ? { link: r.l === null || r.l === undefined ? null : String(r.l) } : {}),
});
const selectCols = (spec) => `"${spec.idColumn}" id, updated_at, ${spec.dateSql} d, ${spec.linkSql ?? 'NULL'} l`;

async function snapshotAll(client, spec, uid) {
  const rs = await client.execute({
    sql: `SELECT ${selectCols(spec)} FROM "${spec.table}" WHERE user_id = ?`,
    args: [uid],
  });
  const out = new Map();
  for (const r of rs.rows) out.set(String(r.id), rowEntry(spec, r));
  return out;
}

async function snapshot(client, spec, uid, ids) {
  const out = new Map();
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const rs = await client.execute({
      sql: `SELECT ${selectCols(spec)}
              FROM "${spec.table}" WHERE user_id = ? AND "${spec.idColumn}" IN (${chunk.map(() => '?').join(',')})`,
      args: [uid, ...chunk],
    });
    for (const r of rs.rows) out.set(String(r.id), rowEntry(spec, r));
  }
  return out;
}

/**
 * 依之前 / 之後 / 進來的版本，把一批紀錄分類，並算出受影響的日期範圍。
 * 純函式（匯出給測試）。
 */
export function classifyCanonicalWrite({ records, before, after, idOf, spansNextDay = false }) {
  const counts = { changed: 0, unchanged: 0, blocked: 0 };
  // 日期關聯：有 link（可為 NULL 的原始 health_date）就看 link，否則看日期
  const linkOf = (x) => (x.link !== undefined ? (x.link ?? null) : (x.date ?? null));
  let from = null; let to = null;
  const touch = (d) => {
    if (!d) return;
    from = !from || d < from ? d : from;
    const end = spansNextDay ? addDays(d, 1) : d;
    to = !to || end > to ? end : to;
  };
  const seen = new Set();
  for (const r of records) {
    const id = idOf(r);
    if (id === null || id === undefined) continue;
    const key = String(id);
    if (seen.has(key)) continue;
    seen.add(key);
    const b = before.get(key) ?? null;
    const a = after.get(key) ?? null;
    if (!a) { counts.blocked += 1; continue; }                       // 墓碑擋下（或寫入被略過）
    if (!b) { counts.changed += 1; touch(a.date); continue; }        // 新列
    const bu = b.updatedAt; const au = a.updatedAt;
    if (au && bu && au > bu) { counts.changed += 1; touch(b.date); touch(a.date); continue; }   // 較新版本
    if (au && bu && au < bu) { counts.blocked += 1; continue; }      // 不可能（M-03 擋）；保守歸 blocked
    // 版本相同，但**日期關聯**變了（recovery 的 health_date 被 relink）：
    // 語義上這一天的歸屬移動了，新舊兩天都要失效（P3-AUDIT-F02）。
    if (linkOf(a) !== linkOf(b)) { counts.changed += 1; touch(b.date); touch(a.date); continue; }
    // 版本相同：進來的是同版本重放，或 M-03 擋下的較舊版本
    const incoming = isoOrNull(r?.updated_at);
    if (incoming && bu && incoming < bu) counts.blocked += 1;
    else counts.unchanged += 1;
  }
  // 不在這一批裡、但日期關聯被同一交易改到的列（relink 會掃整個使用者）。
  for (const [key, a] of after) {
    if (seen.has(key)) continue;
    const b = before.get(key) ?? null;
    if (b && linkOf(a) !== linkOf(b)) { counts.changed += 1; touch(b.date); touch(a.date); }
  }
  return { ...counts, affectedFrom: from, affectedTo: to };
}

/** relink 專用：比對前後所有列的日期，回傳 {changed, affectedFrom, affectedTo}。 */
export function classifyRelink({ before, after }) {
  return classifyCanonicalWrite({ records: [], before, after, idOf: () => null });
}

/**
 * 把 canonical 儲存層的寫入器包上「同交易失效」。
 *
 * @param {object} health createHealthStore 的結果
 * @param {object} webhook createWhoopWebhookStore 的結果（deleteWhoopResource）
 * @param {object} analytics createAnalyticsWorkStore 的結果（markAnalyticsDirty）
 * @param {object} opts.client processing 代理 client（交易內讀取）
 * @param {function} opts.transaction processing.transaction
 */
export function withAnalyticsInvalidation({ health, webhook, analytics, client, transaction }) {
  const wrapUpsert = (resource, orig) => async (userId, records = [], opts = {}) => {
    const uid = requireUserId(userId, `upsert:${resource}`);
    const spec = SPEC[resource];
    const now = opts.now ?? new Date();
    return transaction(async () => {
      const ids = [...new Set(records.map(spec.idOf).filter((v) => v !== null && v !== undefined).map(String))];
      const take = () => (spec.relinks ? snapshotAll(client, spec, uid) : snapshot(client, spec, uid, ids));
      const before = await take();
      const written = await orig(uid, records, { ...opts, now });
      const after = await take();
      const cls = classifyCanonicalWrite({ records, before, after, idOf: spec.idOf, spansNextDay: Boolean(spec.spansNextDay) });
      if (cls.changed > 0) {
        await analytics.markAnalyticsDirty({
          userId: uid, resource, reason: opts.invalidationReason ?? 'upsert',
          affectedFrom: cls.affectedFrom, affectedTo: cls.affectedTo, now,
        });
      }
      log.info('canonical_write_classified', {
        user_id: uid, resource, written, changed: cls.changed, unchanged: cls.unchanged, blocked: cls.blocked,
      });
      return written;
    });
  };

  /** body measurement：沒有來源版本 → 比對當日快照的數值。 */
  const upsertBodyMeasurement = async (userId, bm, opts = {}) => {
    const uid = requireUserId(userId, 'upsert:body_measurement');
    const now = opts.now ?? new Date();
    return transaction(async () => {
      const day = new Date(now).toISOString().slice(0, 10);
      const read = async () => (await client.execute({
        sql: `SELECT height_meter h, weight_kilogram w, max_heart_rate m FROM whoop_body_measurements
               WHERE user_id = ? AND recorded_at = ?`,
        args: [uid, day],
      })).rows[0] ?? null;
      const before = await read();
      const written = await health.upsertBodyMeasurement(uid, bm, { ...opts, now });
      const after = await read();
      const same = (a, b) => (a === null || a === undefined ? null : Number(a)) === (b === null || b === undefined ? null : Number(b));
      const changed = Boolean(after) && (!before || !same(before.h, after.h) || !same(before.w, after.w) || !same(before.m, after.m));
      if (changed) {
        await analytics.markAnalyticsDirty({
          userId: uid, resource: 'body_measurement', reason: opts.invalidationReason ?? 'upsert',
          affectedFrom: day, affectedTo: day, now,
        });
      }
      return written;
    });
  };

  /** 權威 DELETE：真的移走 canonical 列才失效。墓碑本身由 Phase 1 儲存層負責。 */
  const deleteWhoopResource = async (args) => {
    const uid = requireUserId(args?.userId, 'deleteWhoopResource');
    const spec = SPEC[args.resourceType];
    const now = args.now ?? new Date();
    return transaction(async () => {
      const before = spec ? await snapshot(client, spec, uid, [String(args.resourceId)]) : new Map();
      const result = await webhook.deleteWhoopResource({ ...args, now });
      if (Number(result?.removed ?? 0) > 0) {
        const d = before.get(String(args.resourceId))?.date ?? null;
        await analytics.markAnalyticsDirty({
          userId: uid, resource: args.resourceType, reason: 'delete',
          affectedFrom: d, affectedTo: d && spec?.spansNextDay ? addDays(d, 1) : d, now,
        });
      }
      return result;
    });
  };

  /**
   * 公開的 relinkRecoveryDates（P3-AUDIT-F02）：真的改了日期關聯的列，
   * 新舊兩個日期都在同一交易裡失效。沒有列改變 → 不失效。
   * 在 upsertRecoveries 內部的 relink 已經被上面的包裝器一併分類，
   * 不會重複 +1（那是同一個交易裡的同一次語義變化）。
   */
  const relinkRecoveryDates = async (userId, opts = {}) => {
    const uid = requireUserId(userId, 'relinkRecoveryDates');
    const spec = SPEC.recovery;
    const now = opts.now ?? new Date();
    return transaction(async () => {
      const before = await snapshotAll(client, spec, uid);
      const result = await health.relinkRecoveryDates(uid);
      const after = await snapshotAll(client, spec, uid);
      const cls = classifyRelink({ before, after });
      if (cls.changed > 0) {
        await analytics.markAnalyticsDirty({
          userId: uid, resource: 'recovery', reason: 'relink',
          affectedFrom: cls.affectedFrom, affectedTo: cls.affectedTo, now,
        });
      }
      log.info('recovery_relink_classified', { user_id: uid, changed: cls.changed });
      return result;
    });
  };

  return {
    relinkRecoveryDates,
    upsertSleeps: wrapUpsert('sleep', health.upsertSleeps),
    upsertRecoveries: wrapUpsert('recovery', health.upsertRecoveries),
    upsertWorkouts: wrapUpsert('workout', health.upsertWorkouts),
    upsertCycles: wrapUpsert('cycle', health.upsertCycles),
    upsertBodyMeasurement,
    deleteWhoopResource,
  };
}

export { CANONICAL_CHANGE };
