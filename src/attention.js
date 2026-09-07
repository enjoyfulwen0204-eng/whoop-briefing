/**
 * Attention Engine（PA5／PA6）。
 *
 * 決定「這些訊號值不值得打擾使用者」，而且**每一個決定都要能回答
 * 「為什麼」**——`decide()` 永遠回傳 `{ decision, reason, factors }`，
 * `factors` 裡列出每一項有納入考量的東西（嚴重度、持續性、多重訊號佐證、
 * 新鮮度、既有脈絡、反騷擾冷卻/上限、既有未答問題），不是黑盒子。
 *
 * 完全確定性：沒有一行呼叫 LLM，權重與門檻全部來自
 * src/proactivePolicy.js（明確標成產品啟發式）。
 */

import { PROACTIVE_DECISION } from './schema.js';
import { ATTENTION_POLICY, ANTI_SPAM_POLICY, SIGNAL_POLICY } from './proactivePolicy.js';
import { DEVIATION } from './analytics/anomaly.js';

const LEVEL_RANK = { NORMAL: 0, MILD: 1, NOTABLE: 2, STRONG: 3 };

/**
 * 有幾個**互相獨立**的生理領域同時出狀況。
 *
 * ⚠️ 稽核修正：以前直接用 signals.length。但 WHOOP 的 recovery 本來就是
 * 用 hrv 與 rhr 算出來的——「HRV 低 + RHR 高 + 恢復低」是同一件事被數了
 * 三次，不是三個獨立證據。用領域數當佐證單位，才不會讓任何一個狀況差的
 * 日子都自動「多重訊號佐證成立」。
 */
function distinctDomains(signals) {
  return new Set(
    signals.map((s) => SIGNAL_POLICY.METRIC_DOMAIN[s.metric] ?? `metric:${s.metric}`),
  );
}

/**
 * @param {object[]} signals         detectSignals() 的輸出（已依嚴重度排序）
 * @param {Date}     now
 * @param {object[]} recentEvents    db.getRecentProactiveEvents() 的輸出
 * @param {boolean}  hasOpenQuestion 這個使用者現在是否已經有一個 OPEN 的追問
 * @param {boolean}  journalCoversHealthDate 這個 health_date 是否已經有任何 journal 紀錄
 *   （沿用既有 conversation.js shouldFollowUp() 的同一個粗粒度判斷：
 *   有紀錄就代表「使用者自己已經講了發生什麼事」，不需要再問一次）
 */
export function decide({
  signals = [], now = new Date(), recentEvents = [],
  hasOpenQuestion = false, journalCoversHealthDate = false,
}) {
  const domains = distinctDomains(signals);
  const factors = {
    signal_count: signals.length,
    domain_count: domains.size,
    domains: [...domains].sort(),
    top_code: signals[0]?.code ?? null,
    top_level: signals[0]?.level ?? null,
    // 佐證的單位是「不同的生理領域」，不是訊號筆數。
    multi_signal_confirmation: domains.size >= ATTENTION_POLICY.MULTI_SIGNAL_CONFIRMATION_MIN,
    persistent: false,
    novel: true,
    context_already_known: journalCoversHealthDate,
    daily_cap_reached: false,
    topic_cooldown_active: false,
    has_open_question: hasOpenQuestion,
  };

  if (!signals.length) {
    return { decision: PROACTIVE_DECISION.IGNORE, reason: 'no_signals', factors };
  }

  const nowMs = now.getTime();
  const messagingDecisions = new Set([PROACTIVE_DECISION.ASK_CONTEXT, PROACTIVE_DECISION.NOTIFY]);
  const cooldownCutoff = nowMs - ANTI_SPAM_POLICY.TOPIC_COOLDOWN_HOURS * 3600_000;
  const recentFor = (code) => recentEvents.filter(
    (e) => Array.isArray(e.signals) && e.signals.some((s) => s.code === code),
  );
  const inCooldown = (code) => recentFor(code).some(
    (e) => messagingDecisions.has(e.decision) && Date.parse(e.createdAt) >= cooldownCutoff,
  );

  // ⚠️ 稽核修正（top-signal masking）：不要只看 signals[0]。
  // 舊版一律拿當天最嚴重的那個訊號去比冷卻，只要它還在冷卻中就整個
  // LOG_ONLY——於是「昨天已經問過 HRV」會連帶把今天新出現、而且屬於
  // **完全不同生理領域**的訊號（例如呼吸率升高這種生病早期徵兆）一起
  // 悶掉 24 小時。現在改成：跳過還在冷卻中的主題，改用第一個沒有在
  // 冷卻中的訊號來評估。反騷擾仍然成立（每日上限、該主題自己的冷卻、
  // 一次只問一題都沒有放寬），只是不再讓一個主題順手蓋掉別的主題。
  const evaluated = signals.find((s) => !inCooldown(s.code)) ?? null;
  factors.all_topics_in_cooldown = evaluated === null;
  factors.evaluated_code = evaluated?.code ?? null;
  factors.masked_by_cooldown = signals
    .filter((s) => inCooldown(s.code))
    .map((s) => s.code);

  const todayCutoff = nowMs - 24 * 3600_000;
  const messagesToday = recentEvents.filter(
    (e) => messagingDecisions.has(e.decision) && Date.parse(e.createdAt) >= todayCutoff,
  ).length;
  factors.daily_cap_reached = messagesToday >= ANTI_SPAM_POLICY.DAILY_PROACTIVE_CAP;
  factors.topic_cooldown_active = factors.masked_by_cooldown.length > 0;

  if (factors.daily_cap_reached) {
    return { decision: PROACTIVE_DECISION.LOG_ONLY, reason: 'daily_cap_reached', factors };
  }
  if (!evaluated) {
    return { decision: PROACTIVE_DECISION.LOG_ONLY, reason: 'topic_cooldown_active', factors };
  }

  const withSignal = (decision, reason) => ({
    decision, reason, factors, evaluatedSignal: evaluated,
  });

  const sameTopicRecent = recentFor(evaluated.code);
  const novelCutoff = nowMs - ATTENTION_POLICY.NOVELTY_WINDOW_DAYS * 86_400_000;
  const persistCutoff = nowMs - ATTENTION_POLICY.PERSISTENCE_MIN_DAYS * 86_400_000;
  factors.novel = !sameTopicRecent.some((e) => Date.parse(e.createdAt) >= novelCutoff);
  factors.persistent = sameTopicRecent.some((e) => Date.parse(e.createdAt) >= persistCutoff);

  if (factors.context_already_known) {
    return withSignal(PROACTIVE_DECISION.LOG_ONLY, 'context_already_explained');
  }
  if (!factors.novel && !factors.persistent) {
    return withSignal(PROACTIVE_DECISION.LOG_ONLY, 'seen_recently_not_persistent');
  }

  const topLevel = evaluated.level;
  const corroborated = factors.persistent || factors.multi_signal_confirmation;

  if (topLevel === DEVIATION.STRONG && corroborated) {
    if (hasOpenQuestion) {
      return withSignal(PROACTIVE_DECISION.NOTIFY, 'already_has_open_question');
    }
    return withSignal(PROACTIVE_DECISION.ASK_CONTEXT, 'severe_and_corroborated');
  }
  if (topLevel === DEVIATION.NOTABLE && corroborated && !hasOpenQuestion) {
    return withSignal(PROACTIVE_DECISION.ASK_CONTEXT, 'notable_and_corroborated');
  }

  return withSignal(PROACTIVE_DECISION.LOG_ONLY, 'below_action_threshold');
}

/**
 * ASK_CONTEXT 選定之後，如果 Information-Gain 引擎找不到任何可問的候選類別
 * （例如所有相關類別今天都已經有 journal，或都在冷卻中），就要降級成
 * NOTIFY——絕不能因為「問不出東西」就整個放棄，訊號本身仍然值得讓使用者
 * 知道。
 */
export function downgradeAskToNotify(decisionResult, { reason = 'no_question_candidate' } = {}) {
  if (decisionResult.decision !== PROACTIVE_DECISION.ASK_CONTEXT) return decisionResult;
  return {
    decision: PROACTIVE_DECISION.NOTIFY,
    reason,
    factors: decisionResult.factors,
    evaluatedSignal: decisionResult.evaluatedSignal ?? null,
  };
}

/**
 * 回答之後的重新分析結果 → 要不要發 follow-up（PA14）。
 * 只有「解讀真的變了」才值得再發一則訊息，單純「謝謝你的回覆」是騷擾。
 */
export function decideFollowUp({ insightChanged = false, outcome = null } = {}) {
  if (insightChanged) {
    return { decision: PROACTIVE_DECISION.FOLLOW_UP, reason: 'insight_status_changed' };
  }
  return { decision: PROACTIVE_DECISION.IGNORE, reason: outcome ?? 'no_material_change' };
}
