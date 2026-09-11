#!/usr/bin/env node
/**
 * V1.2 Phase 0：正式環境觀測基線。
 *
 * 用法：npm run phase0
 *
 * ## 這支工具存在的理由
 *
 * V1.2 的每一個大決定（要不要上 webhook、對帳頻率、增量同步視窗、分析要不要
 * 跟攝取拆開、Proactive V2）都取決於 V1.1 在真實世界裡**實際**怎麼跑，而不是
 * 我們以為它怎麼跑。Phase 0 就是先看 7～14 天，讓證據來決定。
 *
 * ## 安全邊界（這支工具做不到的事）
 *
 * 它**只讀**已經持久化的狀態，而且刻意不建立任何對外的 client：
 *
 *   - 不打 WHOOP（不同步、不刻意 refresh token）
 *   - 不打 OpenRouter
 *   - 不送 Telegram
 *   - 不跑 migration（**刻意不呼叫 db.migrate()** —— 其他 script 會呼叫，
 *     但觀測工具不該有能力改變 schema）
 *   - 不寫健康資料、不碰 report claim、不動排程狀態
 *
 * 也不印任何健康數值與任何 secret：它報告的是**時間與狀態**，不是身體資料。
 *
 * ## 時間戳的語義（很重要，不要搞混）
 *
 *   whoop_*.created_at / updated_at   ← **WHOOP 自己的**時間戳（來自 API payload）
 *   whoop_*.synced_at                 ← **我們**寫進 Turso 的時間
 *
 * 所以 `updated_at > created_at` 代表「WHOOP 事後改過這筆紀錄」。
 *
 * ⚠️ 但 `synced_at` 在每一次 upsert 都會被覆寫，所以它的語義是「**最後一次**
 * 同步時間」，不是「第一次落地時間」。凡是需要「第一次看到」的數字，這裡一律
 * 標成 inferred，不假裝精確。
 */

import { loadDotEnvIfPresent, loadEnv, WAKE, WHOOP_SYNC } from '../src/config.js';
import { detectWake } from '../src/analyze.js';
import { createDb } from '../src/db.js';
import { GLOBAL_SCOPE } from '../src/schema.js';
import { HEARTBEAT_COMPONENT, GUARDIAN_POLICY } from '../src/guardianPolicy.js';

const MIN = 60_000;
const iso = (v) => (v ? String(v) : null);
const short = (v) => (v ? String(v).slice(0, 19).replace('T', ' ') : '—');

/** 兩個時間戳相差多少分鐘。任一為空回 null（不猜）。 */
export function minutesBetween(fromIso, toIso) {
  if (!fromIso || !toIso) return null;
  const a = new Date(fromIso).getTime();
  const b = new Date(toIso).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / MIN);
}

const dur = (mins) => {
  if (mins === null) return '—';
  const s = mins < 0 ? '-' : '';
  const m = Math.abs(mins);
  return m < 90 ? `${s}${m}m` : `${s}${(m / 60).toFixed(1)}h`;
};

/**
 * 醒來閘門的資格時間：睡眠結束 + WAKE.MIN_MINUTES_AFTER_SLEEP_END。
 *
 * 這是從既有政策**推導**出來的，不是另外記錄的事實 —— 閘門本身完全沒有被改動。
 */
export function wakeEligibleAt(sleepEndIso) {
  if (!sleepEndIso) return null;
  const t = new Date(sleepEndIso).getTime();
  if (!Number.isFinite(t)) return null;
  return new Date(t + WAKE.MIN_MINUTES_AFTER_SLEEP_END * MIN).toISOString();
}

/** 用正式環境的 detectWake 判斷這筆主睡眠在 generatedAt 當下的閘門狀態。 */
export function observeWakeGate({ sleep, recovery, now, timezone }) {
  if (!sleep) return { ready: false, reason: 'no_main_sleep', earliestEligibleAt: null };
  const earliestEligibleAt = wakeEligibleAt(iso(sleep.end_at));
  const result = detectWake({
    observations: [{
      sleep: { score_state: sleep.score_state },
      recovery: recovery ? { score_state: recovery.score_state } : null,
      endUtc: iso(sleep.end_at),
      healthDate: iso(sleep.health_date),
      sleepId: iso(sleep.id),
    }],
    now,
    timezone,
  });
  return { ...result, earliestEligibleAt };
}

const ROWS = async (db, sql, args = []) => (await db.raw.execute({ sql, args })).rows;

/**
 * 收集 Phase 0 的全部觀測資料。純讀。
 *
 * 拆成 collect / render 兩段是為了可以用本地測試 DB 驗行為，
 * 而不是比對輸出字串。
 */
export async function collectPhase0(db, { now = new Date(), sleepSample = 7 } = {}) {
  const users = await db.listActiveUsers();
  const out = {
    generatedAt: now.toISOString(),
    schemaVersion: Number((await ROWS(db, 'SELECT MAX(version) v FROM schema_version'))[0]?.v ?? 0),
    users: users.length,
    scheduler: null,
    perUser: [],
    gaps: [],
  };

  // ---- 排程器（唯讀；診斷由另一個任務負責，這裡只量測）----
  const beat = await db.getHeartbeat(GLOBAL_SCOPE, HEARTBEAT_COMPONENT.CRON);
  const beatAge = beat?.lastOkAt ? minutesBetween(beat.lastOkAt, out.generatedAt) : null;
  out.scheduler = {
    // 期望節奏來自 workflow，是設定值不是觀測值 —— 標明清楚。
    expectedCadenceMin: 30,
    lastOkAt: iso(beat?.lastOkAt),
    lastDetail: beat?.lastDetail ?? null,
    ageMin: beatAge,
    stale: beatAge === null ? null : beatAge * MIN > GUARDIAN_POLICY.CRON_HEARTBEAT_MAX_AGE_MS,
  };

  for (const u of users) {
    const uid = u.id;
    const p = { userId: uid, timezone: u.timezone, resources: [], sleeps: [], sync: [] };

    // ---- WHOOP 攝取：每個 resource 的筆數與最新時間戳 ----
    for (const [resource, table, tcol] of [
      ['sleep', 'whoop_sleeps', 'end_at'],
      ['recovery', 'whoop_recoveries', 'health_date'],
      ['cycle', 'whoop_cycles', 'start_at'],
      ['workout', 'whoop_workouts', 'end_at'],
      ['body_measurement', 'whoop_body_measurements', 'recorded_at'],
    ]) {
      const cols = (await ROWS(db, `PRAGMA table_info("${table}")`)).map((r) => String(r.name));
      const hasRevision = cols.includes('created_at') && cols.includes('updated_at');
      const base = await ROWS(db, `SELECT COUNT(*) n, MAX(${tcol}) latest_source,
               MAX(synced_at) latest_synced FROM ${table} WHERE user_id = ?`, [uid]);
      // 只能證明 WHOOP updated_at 晚於 created_at；無法證明我們觀測到多個版本。
      const updatedAfterCreate = hasRevision
        ? Number((await ROWS(db, `SELECT COUNT(*) n FROM ${table}
             WHERE user_id = ? AND updated_at IS NOT NULL AND created_at IS NOT NULL
               AND updated_at > created_at`, [uid]))[0].n)
        : null;
      p.resources.push({
        resource,
        count: Number(base[0].n),
        latestSource: iso(base[0].latest_source),
        latestSynced: iso(base[0].latest_synced),
        updatedAfterCreateCount: updatedAfterCreate,
      });
    }

    // ---- 同步狀態（每個 resource 的最後成功／錯誤）----
    for (const r of await ROWS(db, `SELECT resource, backfill_complete, earliest_synced,
           latest_synced, last_success_at, last_error IS NOT NULL AS has_error, last_error_at
         FROM whoop_sync_state WHERE user_id = ? ORDER BY resource`, [uid])) {
      p.sync.push({
        resource: String(r.resource),
        backfillComplete: Number(r.backfill_complete) === 1,
        earliestSynced: iso(r.earliest_synced),
        lastSuccessAt: iso(r.last_success_at),
        hasError: Number(r.has_error) === 1,
        lastErrorAt: iso(r.last_error_at),
      });
    }

    // ---- 睡眠 → 恢復 → 醒來資格 → 報告：一條完整的延遲鏈 ----
    const sleeps = await ROWS(db, `SELECT id, health_date, end_at, score_state,
           created_at, updated_at, synced_at
         FROM whoop_sleeps
        WHERE user_id = ? AND (nap = 0 OR nap IS NULL)
        ORDER BY end_at DESC LIMIT ?`, [uid, sleepSample]);
    for (const s of sleeps) {
      const hd = s.health_date ? String(s.health_date) : null;
      // 正式 wake gate 是用 recovery.sleep_id === sleep.id，不是只靠 health_date。
      const rec = (await ROWS(db, `SELECT score_state, created_at, updated_at, synced_at
             FROM whoop_recoveries WHERE user_id = ? AND sleep_id = ?
             ORDER BY updated_at DESC LIMIT 1`, [uid, String(s.id)]))[0] ?? null;
      const claim = hd ? (await ROWS(db, `SELECT claimed_at, telegram_sent_at
             FROM report_claims WHERE user_id = ? AND report_type = 'daily' AND local_date = ?`,
      [uid, hd]))[0] : null;
      const run = hd ? (await ROWS(db, `SELECT status, sent_at FROM report_runs
             WHERE user_id = ? AND report_type = 'daily' AND local_date = ?
             ORDER BY id DESC LIMIT 1`, [uid, hd]))[0] : null;

      const wakeGate = observeWakeGate({ sleep: s, recovery: rec, now, timezone: u.timezone });
      const eligibleAt = wakeGate.earliestEligibleAt;
      const sentAt = iso(claim?.telegram_sent_at) ?? iso(run?.sent_at);
      p.sleeps.push({
        healthDate: hd,
        endAt: iso(s.end_at),
        sleepScoreState: s.score_state ?? null,
        // WHOOP 自己的時間戳。updated_at 只是 WHOOP 最後更新這筆資料的時間；
        // 不是評分完成時間，也不是我們觀測到的 API 可用時間。
        whoopCreatedAt: iso(s.created_at),
        whoopUpdatedAt: iso(s.updated_at),
        whoopUpdatedAfterCreation: Boolean(s.created_at && s.updated_at && s.updated_at > s.created_at),
        lastSyncedAt: iso(s.synced_at),
        recoveryScoreState: rec?.score_state ?? null,
        recoveryUpdatedAt: iso(rec?.updated_at),
        wakeEligibleAt: eligibleAt,
        wakeReadyNow: wakeGate.ready,
        wakeGateReason: wakeGate.ready ? 'ready' : wakeGate.reason,
        claimedAt: iso(claim?.claimed_at),
        sentAt,
        reportStatus: run?.status ?? null,
        // 延遲鏈（分鐘）
        endToWhoopUpdateMin: minutesBetween(iso(s.end_at), iso(s.updated_at)),
        whoopUpdateToSyncMin: minutesBetween(iso(s.updated_at), iso(s.synced_at)),
        eligibleToSentMin: minutesBetween(eligibleAt, sentAt),
        endToSentMin: minutesBetween(iso(s.end_at), sentAt),
      });
    }

    // ---- Token（只有時間，沒有任何 token 值）----
    const tok = (await ROWS(db, `SELECT updated_at, access_token_expires_at,
           whoop_user_id IS NOT NULL AS bound FROM user_whoop_tokens WHERE user_id = ?`, [uid]))[0];
    p.token = tok ? {
      lastWriteAt: iso(tok.updated_at),
      accessExpiresAt: iso(tok.access_token_expires_at),
      identityBound: Number(tok.bound) === 1,
      lastWriteAgeMin: minutesBetween(iso(tok.updated_at), out.generatedAt),
    } : null;

    // ---- 報告 ----
    const claims = await ROWS(db, `SELECT report_type, COUNT(*) n,
           SUM(CASE WHEN telegram_sent_at IS NOT NULL THEN 1 ELSE 0 END) sent
         FROM report_claims WHERE user_id = ? GROUP BY report_type`, [uid]);
    const runs = await ROWS(db, `SELECT report_type, status, COUNT(*) n FROM report_runs
         WHERE user_id = ? GROUP BY report_type, status`, [uid]);
    p.reports = {
      claims: claims.map((r) => ({ type: String(r.report_type), claimed: Number(r.n), sent: Number(r.sent) })),
      runs: runs.map((r) => ({ type: String(r.report_type), status: String(r.status), n: Number(r.n) })),
    };

    // ---- 主動代理 ----
    const pro = await ROWS(db, `SELECT decision, outcome, COUNT(*) n FROM proactive_events
         WHERE user_id = ? GROUP BY decision, outcome`, [uid]);
    p.proactive = pro.map((r) => ({
      decision: String(r.decision), outcome: r.outcome ?? null, n: Number(r.n),
    }));

    // ---- Capability / readiness ----
    const caps = await ROWS(db, `SELECT status, COUNT(*) n FROM whoop_capabilities
         WHERE user_id = ? GROUP BY status ORDER BY status`, [uid]);
    p.capabilities = caps.map((r) => ({ status: String(r.status), n: Number(r.n) }));
    const hs = await ROWS(db, `SELECT availability, COUNT(*) n FROM healthspan_metrics
         WHERE user_id = ? GROUP BY availability`, [uid]);
    p.healthspan = hs.map((r) => ({ availability: String(r.availability ?? 'null'), n: Number(r.n) }));
    p.predictions = (await ROWS(db, `SELECT status, COUNT(*) n FROM prediction_runs
         WHERE user_id = ? GROUP BY status`, [uid])).map((r) => ({ status: String(r.status), n: Number(r.n) }));
    p.insights = (await ROWS(db, `SELECT status, COUNT(*) n FROM health_insights
         WHERE user_id = ? GROUP BY status`, [uid])).map((r) => ({ status: String(r.status), n: Number(r.n) }));

    // ---- 成本（既有帳本；不估算、不推測）----
    const usage = (await ROWS(db, `SELECT COUNT(*) n, SUM(total_tokens) tok,
           SUM(estimated_cost_usd) cost, MIN(timestamp) first_at, MAX(timestamp) last_at
         FROM ai_usage WHERE user_id = ?`, [uid]))[0];
    p.cost = {
      calls: Number(usage.n),
      totalTokens: usage.tok === null ? null : Number(usage.tok),
      estimatedCostUsd: usage.cost === null ? null : Number(usage.cost),
      firstAt: iso(usage.first_at),
      lastAt: iso(usage.last_at),
      byPurpose: (await ROWS(db, `SELECT purpose, COUNT(*) n FROM ai_usage
           WHERE user_id = ? GROUP BY purpose`, [uid])).map((r) => ({
        purpose: String(r.purpose ?? 'null'), n: Number(r.n),
      })),
    };

    out.perUser.push(p);
  }

  // ---- Telegram worker（全域表，不分 user）----
  const tg = (await ROWS(db, `SELECT COUNT(*) n,
         SUM(CASE WHEN status = 'COMPLETED' THEN 1 ELSE 0 END) completed,
         SUM(CASE WHEN status = 'ABANDONED' THEN 1 ELSE 0 END) abandoned,
         SUM(CASE WHEN attempts > 1 THEN 1 ELSE 0 END) retried,
         MAX(processed_at) last_at FROM telegram_processed_updates`))[0];
  out.telegram = {
    updates: Number(tg.n),
    completed: Number(tg.completed ?? 0),
    abandoned: Number(tg.abandoned ?? 0),
    retried: Number(tg.retried ?? 0),
    lastAt: iso(tg.last_at),
    operations: Number((await ROWS(db, 'SELECT COUNT(*) n FROM telegram_operations'))[0].n),
  };

  out.gaps = phase0Gaps(out);
  return out;
}

/**
 * 這一輪**還是量不到**的東西。
 *
 * 刻意在輸出裡明講：Phase 0 的價值一半在「我們知道什麼」，另一半在
 * 「我們知道自己不知道什麼」。每一條都附上為什麼沒有補 —— 幾乎都是因為補它
 * 需要改 upsert 行為或加 schema，而那兩件事在 Phase 0 是被禁止的。
 */
export function phase0Gaps() {
  return [
    ['第一次落地時間', 'synced_at 每次 upsert 都被覆寫 → 只知道「最後一次同步」。補它要改 upsert 行為（Phase 0 禁止）。'],
    ['WHOOP API 可用時間', '我們沒有觀測到這個事實。created_at/updated_at 是 WHOOP 自己的時間戳，只能當**推論**用。'],
    ['修訂次數與修訂觀測時間', 'upsert 就地覆寫、沒有歷史列 → 只知 updated_at 是否晚於 created_at，不能證明我們觀測過多版。'],
    ['score_state 轉換時間', '只存目前狀態，沒有 PENDING→SCORED 的轉換時間。'],
    ['排程器的歷次執行', 'system_heartbeats 是單列覆寫 → 只知道最後一次。漏跑／重跑／重疊的歷史不在 DB 裡（在 Actions 的 run 紀錄裡）。'],
    ['每次同步的筆數與耗時', '只在執行當下的 log 裡，沒有持久化。'],
    ['Telegram worker 心跳', '目前只有 cron 這個 component 有心跳，worker 沒有 → 它掛掉不會留下痕跡。'],
  ];
}

/** 純文字報告。不含任何健康數值與 secret。 */
export function renderPhase0(d) {
  const L = [];
  const line = (s = '') => L.push(s);
  const head = (t) => { line(); line(`══════════ ${t} ══════════`); };

  line(`V1.2 PHASE 0 觀測基線    產生於 ${short(d.generatedAt)}`);
  line(`schema v${d.schemaVersion}｜使用中的使用者 ${d.users} 位`);
  line('時間戳顯示為 UTC（health_date 是使用者當地日期）');

  head('排程器（唯讀）');
  const s = d.scheduler;
  line(`  期望節奏      每 ${s.expectedCadenceMin} 分鐘（來自 workflow 設定，非觀測值）`);
  if (!s.lastOkAt) {
    line('  最後跑完      ❌ 從來沒有完整跑完過一輪');
  } else {
    line(`  最後跑完      ${short(s.lastOkAt)}（${dur(s.ageMin)} 前）${s.stale ? '  ⚠️ 已過期' : '  ✅'}`);
    line(`  當時處理      ${s.lastDetail ?? '—'}`);
    if (s.ageMin !== null && s.ageMin > s.expectedCadenceMin * 2) {
      line(`  ⚠️ 心跳落後期望節奏 ${dur(s.ageMin)} —— 漏跑的歷史不在 DB 裡，要去 Actions 的 run 紀錄看`);
    }
  }

  for (const p of d.perUser) {
    head(`使用者 ${p.userId}（${p.timezone}）`);

    line('  ── WHOOP 攝取 ──');
    line(`  ${'resource'.padEnd(18)}${'筆數'.padEnd(8)}${'最新來源時間'.padEnd(22)}${'最後同步'.padEnd(22)}updated>created`);
    for (const r of p.resources) {
      line(`  ${r.resource.padEnd(18)}${String(r.count).padEnd(8)}${short(r.latestSource).padEnd(22)}`
        + `${short(r.latestSynced).padEnd(22)}${r.updatedAfterCreateCount === null ? '—' : r.updatedAfterCreateCount}`);
    }

    line();
    line('  ── 同步狀態 ──');
    for (const r of p.sync) {
      line(`  ${r.resource.padEnd(18)}backfill=${r.backfillComplete ? '完成' : '進行中'}`
        + `  最後成功=${short(r.lastSuccessAt)}${r.hasError ? `  ⚠️ 有錯誤（${short(r.lastErrorAt)}）` : ''}`);
    }
    if (!p.sync.length) line('  （尚未跑過同步）');

    line();
    line('  ── 睡眠 → 恢復 → 醒來資格 → 報告（延遲鏈）──');
    if (!p.sleeps.length) {
      line('  （還沒有主睡眠紀錄）');
    } else {
      for (const x of p.sleeps) {
        line(`  ${x.healthDate}  睡眠結束 ${short(x.endAt)}  睡眠=${x.sleepScoreState ?? '—'} 恢復=${x.recoveryScoreState ?? '—'}`);
        line(`      WHOOP 建立 ${short(x.whoopCreatedAt)} → 更新 ${short(x.whoopUpdatedAt)}`
          + `${x.whoopUpdatedAfterCreation ? '（updated_at > created_at；不代表已觀測到多版）' : ''}`);
        line(`      最早資格 ${short(x.wakeEligibleAt)}（由 WAKE 政策推導）`
          + `  目前閘門=${x.wakeReadyNow ? 'ready' : x.wakeGateReason}`
          + `  認領 ${short(x.claimedAt)}  送出 ${short(x.sentAt)}  ${x.reportStatus ?? '未發'}`);
        line(`      結束→WHOOP更新 ${dur(x.endToWhoopUpdateMin)}（推論）`
          + `  ｜ WHOOP更新→同步 ${dur(x.whoopUpdateToSyncMin)}（推論）`
          + `  ｜ 有資格→送出 ${dur(x.eligibleToSentMin)}`
          + `  ｜ 結束→送出 ${dur(x.endToSentMin)}`);
      }
    }

    line();
    line('  ── Token（不含任何 token 值）──');
    if (!p.token) line('  ❌ 沒有 token');
    else {
      line(`  最後寫入      ${short(p.token.lastWriteAt)}（${dur(p.token.lastWriteAgeMin)} 前）`);
      line(`  access 到期   ${short(p.token.accessExpiresAt)}`);
      line(`  WHOOP 身分綁定 ${p.token.identityBound ? '✅' : '❌'}`);
    }

    line();
    line('  ── 報告 ──');
    for (const c of p.reports.claims) line(`  ${c.type.padEnd(8)}認領 ${c.claimed}｜實際送出 ${c.sent}`);
    for (const r of p.reports.runs) line(`  ${r.type.padEnd(8)}${r.status} × ${r.n}`);
    if (!p.reports.claims.length && !p.reports.runs.length) line('  （還沒有發過報告）');

    line();
    line('  ── 主動代理 ──');
    if (!p.proactive.length) line('  （還沒有任何事件）');
    for (const r of p.proactive) line(`  ${r.decision} → ${r.outcome ?? '未結案'} × ${r.n}`);

    line();
    line('  ── Readiness / Capability ──');
    line(`  capability    ${p.capabilities.map((c) => `${c.status}=${c.n}`).join('  ') || '（尚未 probe）'}`);
    line(`  healthspan    ${p.healthspan.map((c) => `${c.availability}=${c.n}`).join('  ') || '（還沒算過）'}`);
    line(`  prediction    ${p.predictions.map((c) => `${c.status}=${c.n}`).join('  ') || '（還沒有）'}`);
    line(`  insight       ${p.insights.map((c) => `${c.status}=${c.n}`).join('  ') || '（還沒有）'}`);

    line();
    line('  ── AI 用量 / 成本 ──');
    if (!p.cost.calls) {
      line('  0 次呼叫。注意：V1.1 的每日／每週報告**刻意完全不打 LLM**');
      line('  （health publication is application-owned），所以成本只會來自 Telegram 問答。');
    } else {
      line(`  呼叫 ${p.cost.calls} 次｜tokens ${p.cost.totalTokens ?? '—'}｜估計成本 $${(p.cost.estimatedCostUsd ?? 0).toFixed(4)}`);
      line(`  區間 ${short(p.cost.firstAt)} ～ ${short(p.cost.lastAt)}`);
      line(`  用途 ${p.cost.byPurpose.map((x) => `${x.purpose}=${x.n}`).join('  ')}`);
    }
  }

  head('Telegram worker（全域運維證據，非 per-user）');
  const t = d.telegram;
  line(`  處理過的 update  ${t.updates}（完成 ${t.completed}｜放棄 ${t.abandoned}｜重試過 ${t.retried}）`);
  line(`  持久化操作收據   ${t.operations}`);
  line(`  最後一則         ${short(t.lastAt)}`);
  if (!t.updates) line('  （worker 還沒處理過任何訊息 —— 也可能是它根本沒在跑，目前無法分辨）');

  head('Phase 0 量不到的東西');
  for (const [what, why] of d.gaps) line(`  • ${what}\n      ${why}`);

  line();
  line(`備份窗：BACKFILL_DAYS=${WHOOP_SYNC.BACKFILL_DAYS}｜醒來閘門=睡眠結束後 ${WAKE.MIN_MINUTES_AFTER_SLEEP_END} 分鐘`);
  line();
  return L.join('\n');
}

// 直接執行時才連正式環境（被 import 時不跑，測試才能安全載入）
if (import.meta.url === `file://${process.argv[1]}`) {
  loadDotEnvIfPresent();
  const env = loadEnv({ require: ['TURSO_DATABASE_URL', 'TURSO_AUTH_TOKEN'] });
  const db = createDb({ url: env.tursoUrl, authToken: env.tursoToken });
  try {
    // ⚠️ 刻意**沒有** db.migrate()：觀測工具不該有能力改變 schema。
    console.log(renderPhase0(await collectPhase0(db)));
  } catch (err) {
    console.error(`❌ 失敗：${err.message}`);
    process.exitCode = 1;
  } finally {
    db.close();
  }
}
