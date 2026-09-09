/**
 * Proactive Agent 主流程（PA3／PA8／PA9）。
 *
 * 固定管線，完全確定性到「要不要傳訊息、傳什麼」為止：
 *
 *   新 WHOOP 資料 → readiness → 訊號 → Attention Engine
 *     → （ASK_CONTEXT 時）Information-Gain 問題引擎 → 認領冪等鍵
 *     → Telegram → 開 pending question（如果是 ASK_CONTEXT）
 *
 * ## 只在「真的有新資料」時跑——日期 **加上** 內容指紋
 *
 * ⚠️ 稽核修正（原本是 CRITICAL 缺陷）：舊版只比對 health_date。
 * 但 WHOOP 的正常流程是「sleep 先進來、recovery 稍後才被評分」，
 * 兩者屬於**同一個 health_date**。只比日期的話，第一次 cron 會把游標
 * 推到那一天（那時 recovery 還是 null、沒有任何訊號），等 recovery 真的
 * 有值時 `lastCheckedHealthDate === latestHealthDate` 直接 early-return——
 * 那一天的生理訊號從頭到尾沒有被看過一眼。
 *
 * 現在的判斷依據是 `(health_date, fingerprint)`：
 *   fingerprint = 那一天所有被監看指標的值 + 監看清單 + 政策版本的雜湊。
 *   - 位元組/語意完全相同的重複 sync → 指紋相同 → 完全不做事
 *   - WHOOP 事後改分、補值 → 指紋改變 → 重新分析
 * 指紋同時也是 idempotency key 的一部分，所以「被修正過的那一天」可以
 * 產生新的事件，而「一模一樣的資料」不行。
 *
 * 要不要真的**打擾使用者**仍然由 Attention Engine 的冷卻/上限決定——
 * 重新分析不等於重新發訊息。
 *
 * ## 完全 per-user
 *
 * 所有輸入（rows、journal、pending question、recent events）都用同一個
 * userId 撈，這個函式本身不知道系統裡還有沒有別人。
 */

import { createHash } from 'node:crypto';
import { addDays } from './time.js';
import { loadDailyMetrics, seriesOf } from './dailyMetrics.js';
import { assessProactiveMonitoring } from './readiness.js';
import { detectSignals } from './signals.js';
import { decide, downgradeAskToNotify } from './attention.js';
import { selectQuestion } from './questionEngine.js';
import {
  buildNotifyMessage, guardProactiveMessage, deriveColdStartStage, stageAllowsMessaging,
} from './proactiveMessages.js';
import { PROACTIVE_DECISION, PROACTIVE_QUESTION_INTENT } from './schema.js';
import { POLICY_VERSION, ANTI_SPAM_POLICY, SIGNAL_POLICY } from './proactivePolicy.js';
import { READINESS_HEURISTICS } from './config.js';
import { INSIGHT_STATUS } from './healthMemory.js';
import { capabilityByMetricFor } from './capabilityMap.js';
import { requireUserId } from './userContext.js';
import { log } from './logger.js';

/** 決定「主動代理要不要啟用」的成熟度門檻指標。 */
const CORE_METRICS = READINESS_HEURISTICS.PROACTIVE_CORE_METRICS;
/** 啟用之後實際監看的指標（比核心三項廣，各自仍受自己的 readiness 把關）。 */
const MONITORED_METRICS = SIGNAL_POLICY.MONITORED_METRICS;
const LOOKBACK_DAYS = 120; // 涵蓋 BASELINE(45) / TREND_LONG(90) 需要的最長窗口
const RECENT_EVENTS_WINDOW_DAYS = 30;
/** 算指紋只需要錨點那一天，抓前後幾天當緩衝就夠（比全窗口便宜很多）。 */
const FINGERPRINT_WINDOW_DAYS = 3;

const isMessagingDecision = (d) => d === PROACTIVE_DECISION.ASK_CONTEXT || d === PROACTIVE_DECISION.NOTIFY;

/**
 * 錨點那一天的「生理內容指紋」。
 *
 * 只包含真的會驅動訊號的東西：被監看指標的值、監看清單本身、政策版本。
 * 完全確定性、沒有時間戳、沒有隨機性——同樣的生理資料永遠得到同樣的指紋。
 * 刻意不用 WHOOP 的 updated_at：那是上游給的欄位，重新同步同一筆資料時
 * 未必穩定，而且我們真正在意的是「數值有沒有變」。
 */
export function fingerprintOf(anchorRow, metrics = MONITORED_METRICS) {
  const canonical = metrics
    .map((m) => {
      const v = anchorRow?.[m];
      return `${m}=${v === null || v === undefined ? '' : String(v)}`;
    })
    .join('|');
  return createHash('sha256')
    .update(`${anchorRow?.health_date ?? ''}|${canonical}|${POLICY_VERSION}`)
    .digest('hex')
    .slice(0, 32);
}

/**
 * @param {object} deps 注入點（測試用假 telegram/db 即可，符合既有
 *   `runForUser({ deps })` 的可注入慣例，開發/測試絕不打真的 Telegram）。
 */
export async function checkAndAct({
  db, userId, timezone, telegram, chatId, now = new Date(),
}) {
  const uid = requireUserId(userId, 'checkAndAct');

  const coverage = await db.coverage(uid);
  const latestHealthDate = coverage?.last_date ?? null;
  if (!latestHealthDate) {
    return { triggered: false, reason: 'no_health_data' };
  }

  const anchorDate = latestHealthDate;
  const state = await db.getProactiveState(uid);

  // ---- 便宜的變更偵測：只抓錨點附近幾天，算出生理內容指紋 ----
  // 沒變就在這裡結束，不會去載入 120 天的完整歷史。
  const probeRows = await loadDailyMetrics({
    db, userId: uid, timezone, from: addDays(anchorDate, -FINGERPRINT_WINDOW_DAYS), to: anchorDate,
  });
  const anchorRow = probeRows.find((r) => r.health_date === anchorDate) ?? null;
  const fingerprint = fingerprintOf(anchorRow);

  if (state?.lastCheckedHealthDate === anchorDate && state?.lastFingerprint === fingerprint) {
    return { triggered: false, reason: 'no_new_or_changed_data' };
  }

  const from = addDays(anchorDate, -LOOKBACK_DAYS);
  const rows = await loadDailyMetrics({
    db, userId: uid, timezone, from, to: anchorDate,
  });

  const seriesByMetric = {};
  for (const m of MONITORED_METRICS) seriesByMetric[m] = seriesOf(rows, m);

  const monitoring = assessProactiveMonitoring({
    seriesByMetric, anchorDate, coreMetrics: CORE_METRICS,
  });

  let insights = [];
  try {
    insights = await db.getActiveInsights(uid, {});
  } catch { /* insights 查詢失敗不該擋住整個流程 */ }
  const hasMatureInsight = insights.some((i) => i.status !== INSIGHT_STATUS.HYPOTHESIS);
  const stage = deriveColdStartStage({
    proactiveMonitoringStatus: monitoring.status, hasMatureInsight,
  });

  if (!stageAllowsMessaging(stage)) {
    // 這個分支從來不會 claim 任何事件（沒有訊號可言），游標可以立刻前進，
    // 沒有「claim 完但游標沒進」這種需要重試的中間狀態。
    await db.setProactiveState(uid, { lastCheckedHealthDate: anchorDate, lastFingerprint: fingerprint }, { now });
    log.info('proactive_stage_not_ready', {
      user_id: uid, health_date: anchorDate, stage, monitoring_status: monitoring.status,
    });
    return {
      triggered: true, stage, decision: PROACTIVE_DECISION.IGNORE,
      reason: 'cold_start_stage_not_ready', signals: [],
    };
  }

  // ---- capability 接線（V1.1 Phase 11）----
  // 以前這裡沒有把 capability 傳進去，於是 detectSignals 的
  // capabilityByMetric 永遠是 {}，capabilityGate 形同虛設：一個
  // **已經證實**這個帳號拿不到的欄位，會被報成 NO_DATA「還在累積中」，
  // 而不是 UNAVAILABLE「這個帳號沒有」。
  //
  // 讀不到 capability 就用空物件——那會回到「還沒 probe」的語義，
  // 也就是繼續走樣本數邏輯，絕不會誤判成不支援。
  const capabilities = await db.getCapabilities(uid).catch(() => ({}));
  const capabilityByMetric = capabilityByMetricFor(MONITORED_METRICS, capabilities);

  const signals = detectSignals({
    seriesByMetric, capabilityByMetric, anchorDate, metrics: MONITORED_METRICS,
  });

  const [openQuestion, journalToday, recentEvents] = await Promise.all([
    db.getOpenPendingQuestion(uid, { now }).catch(() => null),
    db.getJournalEvents(uid, { from: anchorDate, to: anchorDate }).catch(() => []),
    db.getRecentProactiveEvents(uid, {
      sinceIso: new Date(now.getTime() - RECENT_EVENTS_WINDOW_DAYS * 86_400_000).toISOString(),
    }).catch(() => []),
  ]);

  let decision = decide({
    signals,
    now,
    recentEvents,
    hasOpenQuestion: Boolean(openQuestion),
    journalCoversHealthDate: journalToday.length > 0,
  });

  // ---- per-user 主動訊息開關 ----
  // 關閉的使用者：分析照跑、事件照記（稽核軌跡與長期規律不受影響），
  // 但**絕不主動送出任何訊息**。手動問答完全不受影響。
  const proactiveEnabled = await db.isProactiveEnabled(uid).catch(() => true);
  if (!proactiveEnabled && isMessagingDecision(decision.decision)) {
    decision = {
      decision: PROACTIVE_DECISION.LOG_ONLY,
      reason: 'proactive_disabled_by_user',
      factors: { ...decision.factors, proactive_enabled: false },
    };
  }

  let messageText = null;
  let questionCategory = null;

  if (decision.decision === PROACTIVE_DECISION.ASK_CONTEXT) {
    // Attention Engine 可能因為冷卻而跳過了最嚴重的那個訊號，改判另一個。
    // 訊息一定要針對**它真的判斷的那個訊號**，否則會答非所問。
    const topSignal = decision.evaluatedSignal ?? signals[0];
    const cooldownCutoff = now.getTime() - ANTI_SPAM_POLICY.TOPIC_COOLDOWN_HOURS * 3600_000;
    const excludeCategories = new Set(
      recentEvents
        .filter((e) => Date.parse(e.createdAt) >= cooldownCutoff && e.reason?.question_category)
        .map((e) => e.reason.question_category),
    );
    const [fullMetricSeries, journalHistory] = await Promise.all([
      Promise.resolve(seriesOf(rows, topSignal.metric)),
      db.getJournalEvents(uid, {
        from: addDays(anchorDate, -180), to: anchorDate, limit: 2000,
      }).catch(() => []),
    ]);
    const selection = selectQuestion({
      signal: topSignal, journalEvents: journalHistory, metricSeries: fullMetricSeries, excludeCategories,
    });
    if (!selection) {
      decision = downgradeAskToNotify(decision, { reason: 'no_question_candidate' });
    } else {
      questionCategory = selection.category;
      messageText = selection.question;
    }
  }

  if (decision.decision === PROACTIVE_DECISION.NOTIFY) {
    messageText = buildNotifyMessage(decision.evaluatedSignal ?? signals[0]);
  }

  if (messageText) {
    messageText = guardProactiveMessage(messageText, { label: decision.decision }).text;
  }

  // 指紋進 key：被修正過的那一天可以產生新事件，一模一樣的資料不行。
  const idempotencyKey = `${anchorDate}::${fingerprint}::${POLICY_VERSION}`;
  const claim = await db.claimProactiveEvent(uid, {
    healthDate: anchorDate,
    idempotencyKey,
    signals,
    decision: decision.decision,
    reason: { ...decision, question_category: questionCategory },
    policyVersion: POLICY_VERSION,
    messageText,
  }, { now });

  if (!claim.claimed) {
    // 同一個 health_date、同一版政策已經處理過（cron 重跑／worker 重啟）。
    // 刻意不重送——見 schema.js PROACTIVE_SCHEMA 註解的 at-most-once 說明。
    // 游標在這裡才前進（不是一進函式就前進）：這代表「上一輪已經 claim
    // 成功但可能死在送出訊息之前」，現在確認過不需要重試，才安全前進。
    await db.setProactiveState(uid, { lastCheckedHealthDate: anchorDate, lastFingerprint: fingerprint }, { now });
    return {
      triggered: true, stage, decision: decision.decision, duplicate: true, signals,
    };
  }

  let messageSent = false;
  if (messageText && telegram && isMessagingDecision(decision.decision)) {
    await telegram.send(messageText);
    messageSent = true;
    let pendingQuestionId = null;
    if (decision.decision === PROACTIVE_DECISION.ASK_CONTEXT && chatId) {
      pendingQuestionId = await db.openPendingQuestion(uid, {
        chatId,
        question: messageText,
        intent: PROACTIVE_QUESTION_INTENT,
        contextJson: {
          health_date: anchorDate,
          signal: decision.evaluatedSignal ?? signals[0],
          category: questionCategory,
          proactive_event_id: claim.id,
        },
        // 主動問題有**自己的** TTL（見 ANTI_SPAM_POLICY.QUESTION_TTL_MS）。
        // 以前借用 TELEGRAM_BOT.PENDING_TTL_MS——那個常數的語義是「使用者
        // 自己問完之後的對話延續視窗」，跟「系統不請自來問一句話」完全
        // 是兩回事，不該共用一個數字。
        ttlMs: ANTI_SPAM_POLICY.QUESTION_TTL_MS,
      }, { now });
    }
    await db.markProactiveEventSent(uid, claim.id, { pendingQuestionId }, { now });
  }

  // 事件已經 claim 成功（不管有沒有真的送出訊息），這個 health_date 就算
  // 「處理過了」——游標在這裡前進，不是函式一開始就前進。如果剛好在
  // claim 成功、送出訊息之前當掉，下一輪重算會拿到同一把 idempotency key、
  // claim 失敗、落到上面的 duplicate 分支，一樣安全前進，不會重送。
  await db.setProactiveState(uid, { lastCheckedHealthDate: anchorDate, lastFingerprint: fingerprint }, { now });

  log.info('proactive_decision', {
    user_id: uid, health_date: anchorDate, decision: decision.decision,
    reason: decision.reason, signal_count: signals.length, stage, message_sent: messageSent,
    // 訊號代碼與領域（不含任何實際數值）——沒有這個，事後根本無法回答
    // 「那天為什麼決定要問/不問」。訊息內文與 journal 內容仍然不進 log。
    signal_codes: signals.map((s) => s.code),
    domains: decision.factors?.domains ?? [],
  });

  return {
    triggered: true, stage, decision: decision.decision, reason: decision.reason, signals, messageSent,
  };
}
