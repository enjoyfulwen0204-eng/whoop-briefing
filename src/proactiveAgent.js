/**
 * Proactive Agent 主流程（PA3／PA8／PA9）。
 *
 * 固定管線，完全確定性到「要不要傳訊息、傳什麼」為止：
 *
 *   新 WHOOP 資料 → readiness → 訊號 → Attention Engine
 *     → （ASK_CONTEXT 時）Information-Gain 問題引擎 → 認領冪等鍵
 *     → Telegram → 開 pending question（如果是 ASK_CONTEXT）
 *
 * ## 只在「真的有新資料」時跑
 *
 * 用 `proactive_agent_state.last_checked_health_date` 當游標：跟這次
 * sync 之後的最新 health_date 比較，沒有進展就直接回傳、什麼都不做——
 * 不算 readiness、不產生訊號、不呼叫 Telegram。這是「重複的 sync 不會
 * 產生重複 proactive event」的第一道防線；第二道是 idempotency key
 * （見 claimProactiveEvent 的說明）。
 *
 * ## 完全 per-user
 *
 * 所有輸入（rows、journal、pending question、recent events）都用同一個
 * userId 撈，這個函式本身不知道系統裡還有沒有別人。
 */

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
import { POLICY_VERSION, ANTI_SPAM_POLICY } from './proactivePolicy.js';
import { READINESS_HEURISTICS, TELEGRAM_BOT } from './config.js';
import { INSIGHT_STATUS } from './healthMemory.js';
import { requireUserId } from './userContext.js';
import { log } from './logger.js';

const CORE_METRICS = READINESS_HEURISTICS.PROACTIVE_CORE_METRICS;
const LOOKBACK_DAYS = 120; // 涵蓋 BASELINE(45) / TREND_LONG(90) 需要的最長窗口
const RECENT_EVENTS_WINDOW_DAYS = 30;

const isMessagingDecision = (d) => d === PROACTIVE_DECISION.ASK_CONTEXT || d === PROACTIVE_DECISION.NOTIFY;

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

  const state = await db.getProactiveState(uid);
  if (state?.lastCheckedHealthDate === latestHealthDate) {
    return { triggered: false, reason: 'no_new_health_date' };
  }

  const anchorDate = latestHealthDate;
  const from = addDays(anchorDate, -LOOKBACK_DAYS);
  const rows = await loadDailyMetrics({
    db, userId: uid, timezone, from, to: anchorDate,
  });

  const seriesByMetric = {};
  for (const m of CORE_METRICS) seriesByMetric[m] = seriesOf(rows, m);

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
    await db.setProactiveState(uid, { lastCheckedHealthDate: latestHealthDate }, { now });
    log.info('proactive_stage_not_ready', {
      user_id: uid, health_date: anchorDate, stage, monitoring_status: monitoring.status,
    });
    return {
      triggered: true, stage, decision: PROACTIVE_DECISION.IGNORE,
      reason: 'cold_start_stage_not_ready', signals: [],
    };
  }

  const signals = detectSignals({ seriesByMetric, anchorDate, metrics: CORE_METRICS });

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

  let messageText = null;
  let questionCategory = null;

  if (decision.decision === PROACTIVE_DECISION.ASK_CONTEXT) {
    const topSignal = signals[0];
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
    messageText = buildNotifyMessage(signals[0]);
  }

  if (messageText) {
    messageText = guardProactiveMessage(messageText, { label: decision.decision }).text;
  }

  const idempotencyKey = `${anchorDate}::${POLICY_VERSION}`;
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
    await db.setProactiveState(uid, { lastCheckedHealthDate: latestHealthDate }, { now });
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
          signal: signals[0],
          category: questionCategory,
          proactive_event_id: claim.id,
        },
        ttlMs: TELEGRAM_BOT.PENDING_TTL_MS,
      }, { now });
    }
    await db.markProactiveEventSent(uid, claim.id, { pendingQuestionId }, { now });
  }

  // 事件已經 claim 成功（不管有沒有真的送出訊息），這個 health_date 就算
  // 「處理過了」——游標在這裡前進，不是函式一開始就前進。如果剛好在
  // claim 成功、送出訊息之前當掉，下一輪重算會拿到同一把 idempotency key、
  // claim 失敗、落到上面的 duplicate 分支，一樣安全前進，不會重送。
  await db.setProactiveState(uid, { lastCheckedHealthDate: latestHealthDate }, { now });

  log.info('proactive_decision', {
    user_id: uid, health_date: anchorDate, decision: decision.decision,
    reason: decision.reason, signal_count: signals.length, stage, message_sent: messageSent,
  });

  return {
    triggered: true, stage, decision: decision.decision, reason: decision.reason, signals, messageSent,
  };
}
