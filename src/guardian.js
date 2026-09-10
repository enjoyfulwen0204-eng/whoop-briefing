/**
 * Minimal System Guardian（V1.1 Phase 9）。
 *
 * ## 要解決的問題
 *
 * 這個系統絕大多數的**故障事實**其實都已經有地方存了：
 * `whoop_sync_state.last_error`、`report_runs.status`、
 * `ai_usage.request_status`、`error_notifications.hits`……
 * 缺的從來不是資料，而是**有人定期去看**。
 *
 * 最危險的一種故障已經有前例：`maintenance.js` 存在，是因為 GitHub 會在
 * repo 滿 60 天沒 commit 時安靜地停用排程 ——「沒有 run 就沒有錯誤通知，
 * 系統裡沒有任何東西知道自己死了」。同樣的盲點也適用於同步停擺、
 * 主動事件卡住、授權失效。
 *
 * ## 架構：純判斷 + 薄副作用
 *
 *   gatherFacts()  讀 DB，把事實蒐集成一個普通物件
 *   evaluate()     **純函式**：事實 → findings[]。沒有 DB、沒有 await、
 *                  沒有 LLM。跟 readiness.js 同一個立場，所以零資料、
 *                  各種邊界都可以直接測。
 *   runGuardian()  gather → evaluate → 冷卻 → Telegram
 *
 * ## Guardian 絕對不做的事（不可放寬）
 *
 *   不改程式碼、不部署、不跑 migration、不動 token、不做 OAuth、
 *   不重送任何 at-most-once 的主動訊息、不修改健康資料。
 *
 * V1 只有兩個層級：LEVEL_0（健康 → 完全靜默）與 LEVEL_2（發一則 Telegram）。
 *
 * ## 冷啟動不是故障
 *
 * 一個剛建立、還沒授權 WHOOP、一筆生理資料都沒有的使用者，**不是**
 * 「資料過期」的故障。這是 Guardian 最容易做錯、也最惱人的一件事：
 * 對著一個還沒開始用的帳號每天喊「同步異常」。所以每一條 per-user 訊號
 * 都要先問「這個帳號到底啟用了沒」。
 *
 * ## 自己不能偵測自己完全死掉
 *
 * Guardian 掛在 cron 裡跑，所以 cron 整個死掉時它也不會執行 —— 這是
 * 結構性的限制，誠實寫在這裡。cron 心跳這條訊號真正的用途是讓**另一個
 * process**（常駐的 bot worker）或人來事後判讀。V1 不做 worker 端的
 * 交叉告警，避免兩個 process 互相叫醒的迴圈。
 */

import { GLOBAL_SCOPE, userScope } from './schema.js';
import {
  GUARDIAN_LEVEL, GUARDIAN_POLICY, GUARDIAN_POLICY_VERSION, GUARDIAN_SIGNAL,
  HEARTBEAT_COMPONENT,
} from './guardianPolicy.js';
import { log, describeError } from './logger.js';

const ageMs = (iso, now) => {
  const t = Date.parse(iso ?? '');
  return Number.isFinite(t) ? now.getTime() - t : null;
};

const hours = (ms) => Math.floor(ms / 3600_000);

/** 統一的 finding 形狀。 */
function finding({
  signal, level, scope, summary, detail = {},
}) {
  return {
    signal,
    level,
    scope,
    summary,
    detail,
    policy_version: GUARDIAN_POLICY_VERSION,
  };
}

// ===========================================================================
// 純判斷層
// ===========================================================================

/**
 * 事實 → findings。**純函式**：不碰 DB、不 await、不呼叫 LLM。
 *
 * @param {object} facts
 * @param {?object} facts.cronHeartbeat  { lastOkAt } 或 null
 * @param {object[]} facts.users  每個使用者的事實，見下面各欄位
 * @param {Date} facts.now
 * @returns {object[]} findings（空陣列 = 一切正常 = LEVEL_0）
 */
export function evaluate({ cronHeartbeat = null, users = [], now = new Date() } = {}) {
  const out = [];

  // ---- 1. cron 心跳 ----
  // 從來沒有心跳（全新部署、或剛升上這一版）**不算故障**：這個系統可能
  // 根本還沒跑過第一輪。只有「曾經有過心跳，然後停了」才是異常。
  if (cronHeartbeat?.lastOkAt) {
    const age = ageMs(cronHeartbeat.lastOkAt, now);
    if (age !== null && age > GUARDIAN_POLICY.CRON_HEARTBEAT_MAX_AGE_MS) {
      out.push(finding({
        signal: GUARDIAN_SIGNAL.CRON_HEARTBEAT_STALE,
        level: GUARDIAN_LEVEL.LEVEL_2_NOTIFY,
        scope: GLOBAL_SCOPE,
        summary: `排程已經 ${hours(age)} 小時沒有成功執行`,
        detail: { last_ok_at: cronHeartbeat.lastOkAt, age_hours: hours(age) },
      }));
    }
  }

  // ---- 2~4. per-user ----
  for (const u of users) {
    const scope = userScope(u.userId);

    // ★ 冷啟動閘門：還沒授權 WHOOP 的帳號，什麼都不該報。
    // 「還沒開始用」不是故障。
    if (!u.hasWhoopToken) continue;

    // ---- 2. 同步停擺 ----
    // 只有「曾經成功同步過」才談得上停擺。剛授權、還沒跑過第一次同步的
    // 帳號回報 lastSyncOkAt = null —— 那是進行中，不是故障。
    if (u.lastSyncOkAt) {
      const age = ageMs(u.lastSyncOkAt, now);
      if (age !== null && age > GUARDIAN_POLICY.SYNC_STALE_MAX_AGE_MS) {
        out.push(finding({
          signal: GUARDIAN_SIGNAL.WHOOP_SYNC_STALE,
          level: GUARDIAN_LEVEL.LEVEL_2_NOTIFY,
          scope,
          summary: `WHOOP 資料已經 ${hours(age)} 小時沒有成功同步`,
          detail: { last_sync_ok_at: u.lastSyncOkAt, age_hours: hours(age) },
        }));
      }
    }

    // ---- 3. 主動事件卡住 ----
    // 送出了、但遠遠超過 TTL 還是沒有任何結果 → 收割器沒在跑。
    if (Number(u.stuckProactiveCount) > 0) {
      out.push(finding({
        signal: GUARDIAN_SIGNAL.PROACTIVE_EVENT_STUCK,
        level: GUARDIAN_LEVEL.LEVEL_2_NOTIFY,
        scope,
        summary: `有 ${u.stuckProactiveCount} 則主動訊息送出後長時間沒有收尾`,
        detail: {
          count: Number(u.stuckProactiveCount),
          oldest_sent_at: u.oldestStuckSentAt ?? null,
        },
      }));
    }

    // ---- 4. WHOOP 授權連續失敗 ----
    //
    // ★ M-08：只報**還沒恢復**的失敗。
    //
    // `error_notifications` 的 hits 是累加的，而且在正常路徑上會由
    // `clearUserErrorNotify()` 在拿到 token 時清掉。但 Guardian 不可以
    // 只依賴那一步：清除失敗、舊資料、或是先前版本留下的列，都會讓
    // hits 永遠停在 3，於是每 12 小時響一次假警報直到天荒地老。
    //
    // 所以這裡再加一道**獨立的**恢復證據：如果最近一次成功同步比最後
    // 一次授權失敗還新，那就是已經恢復了——同步成功必然代表 token 有效。
    // 假警報比沒有警報更糟：它會很快訓練出「看到 Guardian 就忽略」。
    const failureAt = u.whoopAuthFailureAt ? Date.parse(u.whoopAuthFailureAt) : null;
    const syncOkAt = u.lastSyncOkAt ? Date.parse(u.lastSyncOkAt) : null;
    const recovered = Number.isFinite(failureAt) && Number.isFinite(syncOkAt)
      && syncOkAt > failureAt;

    if (!recovered
        && Number(u.whoopAuthFailures) >= GUARDIAN_POLICY.WHOOP_AUTH_FAILURE_MIN_HITS) {
      out.push(finding({
        signal: GUARDIAN_SIGNAL.WHOOP_AUTH_REPEATED_FAILURE,
        level: GUARDIAN_LEVEL.LEVEL_2_NOTIFY,
        scope,
        summary: `WHOOP 授權已經連續失敗 ${u.whoopAuthFailures} 次，需要重新授權`,
        detail: { hits: Number(u.whoopAuthFailures) },
      }));
    }
  }

  return out;
}

/**
 * finding → 要送出去的文字。
 *
 * ★ 只用**樣板 + 已知安全的欄位**組出來。絕不塞入任何原始錯誤字串、
 * 環境變數、token、journal 內容或使用者訊息。摘要與 detail 都是
 * Guardian 自己算出來的數字與時間戳。
 */
export function renderFinding(f) {
  const lines = [
    '🛡 系統健康檢查',
    '',
    f.summary,
  ];
  const hint = {
    [GUARDIAN_SIGNAL.CRON_HEARTBEAT_STALE]:
      '請確認排程（GitHub Actions / Render cron）是否還在啟用中。',
    [GUARDIAN_SIGNAL.WHOOP_SYNC_STALE]:
      '可能是 WHOOP 授權失效或連線問題。可以先用 /status 看看目前狀態。',
    [GUARDIAN_SIGNAL.PROACTIVE_EVENT_STUCK]:
      '主動訊息的收尾流程可能沒有執行。資料本身不受影響。',
    [GUARDIAN_SIGNAL.WHOOP_AUTH_REPEATED_FAILURE]:
      '需要在電腦上重新執行一次 WHOOP 授權（npm run authorize）。',
  }[f.signal];
  if (hint) lines.push('', hint);
  lines.push('', '（同一項目在冷卻時間內只會通知一次）');
  return lines.join('\n');
}

// ===========================================================================
// 薄副作用層
// ===========================================================================

/**
 * 蒐集判斷所需的事實。全部來自**已經持久化**的東西，不呼叫任何外部服務。
 *
 * 任何一項讀取失敗都不會拋錯 —— 讀不到就當作「沒有這項事實」，
 * 寧可少報一則，也不要讓 Guardian 自己變成故障來源。
 */
export async function gatherFacts({ db, now = new Date() }) {
  const facts = { cronHeartbeat: null, users: [], now };

  try {
    facts.cronHeartbeat = await db.getHeartbeat(GLOBAL_SCOPE, HEARTBEAT_COMPONENT.CRON);
  } catch { /* 沒有心跳事實就不判斷這條 */ }

  let users = [];
  try {
    users = await db.listActiveUsers();
  } catch {
    return facts;
  }

  const stuckCutoff = new Date(
    now.getTime() - GUARDIAN_POLICY.PROACTIVE_STUCK_MAX_AGE_MS,
  ).toISOString();

  for (const u of users) {
    const uid = u.id;
    const fact = {
      userId: uid,
      displayName: u.displayName,
      hasWhoopToken: false,
      lastSyncOkAt: null,
      stuckProactiveCount: 0,
      oldestStuckSentAt: null,
      whoopAuthFailures: 0,
      whoopAuthFailureAt: null,
    };

    try {
      fact.hasWhoopToken = Boolean(await db.getTokens(uid));
    } catch { /* 讀不到就當作沒授權 → 冷啟動閘門會擋掉所有訊號 */ }

    // 沒授權就不必再查其他東西了（而且也不該報任何故障）
    if (!fact.hasWhoopToken) {
      facts.users.push(fact);
      continue;
    }

    try {
      const states = await db.getAllSyncState(uid);
      const times = states.map((s) => s.last_success_at).filter(Boolean).sort();
      fact.lastSyncOkAt = times.length ? times[times.length - 1] : null;
    } catch { /* 沒有同步狀態 = 還沒同步過 = 不是故障 */ }

    try {
      const stuck = await db.countStuckProactiveEvents(uid, { olderThanIso: stuckCutoff });
      fact.stuckProactiveCount = stuck.count;
      fact.oldestStuckSentAt = stuck.oldestSentAt;
    } catch { /* 查不到就當作沒有卡住的事件 */ }

    try {
      const notif = await db.getErrorNotification(userScope(uid), 'whoop_auth');
      fact.whoopAuthFailures = notif?.hits ?? 0;
      // M-08：失敗發生在什麼時候，才判斷得出來「後來有沒有恢復」
      fact.whoopAuthFailureAt = notif?.lastNotifiedAt ?? null;
    } catch { /* 查不到就當作沒有失敗 */ }

    facts.users.push(fact);
  }

  return facts;
}

/**
 * 跑一次 Guardian。
 *
 * **永遠不拋錯**：這是背景守護工作，絕不能自己變成故障。
 *
 * @param {function} makeTelegram ({ chatId, errorScope }) => telegram client。
 *   注入點：測試絕不打真的 Telegram。
 * @returns {Promise<{findings:object[], notified:number, skipped:string?}>}
 */
export async function runGuardian({
  db, makeTelegram, systemTelegram = null, now = new Date(),
}) {
  const result = { findings: [], notified: 0, skipped: null };

  // 單一執行：兩個 cron 同時跑不會各發一則
  let lockOwner = null;
  try {
    if (typeof db.acquireLock === 'function') {
      lockOwner = await db.acquireLock(GUARDIAN_POLICY.LOCK_NAME, {
        ttlMs: GUARDIAN_POLICY.LOCK_TTL_MS, now,
      });
      if (!lockOwner) {
        result.skipped = 'another_guardian_running';
        return result;
      }
    }
  } catch {
    // 拿不到鎖的機制本身壞掉 → 保守跳過，不冒重複通知的險
    result.skipped = 'lock_unavailable';
    return result;
  }

  try {
    const facts = await gatherFacts({ db, now });
    result.findings = evaluate(facts);

    if (!result.findings.length) {
      // ★ LEVEL_0：健康就完全靜默。不發訊息，也不寫 warn。
      log.info('guardian_healthy', { users: facts.users.length });
      return result;
    }

    for (const f of result.findings.slice(0, GUARDIAN_POLICY.MAX_MESSAGES_PER_RUN)) {
      if (f.level !== GUARDIAN_LEVEL.LEVEL_2_NOTIFY) continue;

      // 冷卻沿用既有機制，不另外做一套
      let allowed = true;
      try {
        allowed = await db.claimErrorNotify(
          f.scope, `guardian:${f.signal}`, GUARDIAN_POLICY.NOTIFY_COOLDOWN_HOURS,
        );
      } catch {
        allowed = false; // 冷卻查不到就不發，寧可漏一則也不要洗版
      }
      if (!allowed) continue;

      const sent = await deliver({ db, makeTelegram, systemTelegram, finding: f });
      if (sent) result.notified += 1;
    }

    log.warn('guardian_findings', {
      count: result.findings.length,
      notified: result.notified,
      // 只記代碼與 scope，不記任何 detail 內容
      signals: result.findings.map((f) => f.signal),
    });
    return result;
  } catch (err) {
    log.error('guardian_failed', { error: describeError(err) });
    result.skipped = 'guardian_error';
    return result;
  } finally {
    if (lockOwner) {
      try { await db.releaseLock(GUARDIAN_POLICY.LOCK_NAME, lockOwner); } catch { /* 過期會自己釋放 */ }
    }
  }
}

/**
 * 把一則 finding 送出去。
 *
 * per-user 的問題送到**那個使用者自己的 chat**；系統層的問題送到
 * bootstrap chat。Telegram 失敗只寫 log，**絕不重試、絕不遞迴**——
 * 這也是為什麼 Telegram 掛掉不會造成迴圈。
 */
async function deliver({ db, makeTelegram, systemTelegram, finding: f }) {
  try {
    const text = renderFinding(f);

    if (f.scope === GLOBAL_SCOPE) {
      if (!systemTelegram) return false;
      await systemTelegram.send(text);
      return true;
    }

    const uid = f.scope.startsWith('user:') ? f.scope.slice('user:'.length) : null;
    if (!uid || typeof makeTelegram !== 'function') return false;

    const chatId = await db.getActiveChatIdForUser(uid);
    if (!chatId) return false; // 沒綁 Telegram 就沒有地方可以講

    const tg = makeTelegram({ chatId, errorScope: f.scope });
    await tg.send(text);
    return true;
  } catch (err) {
    log.error('guardian_notify_failed', { signal: f.signal, error: describeError(err) });
    return false;
  }
}
