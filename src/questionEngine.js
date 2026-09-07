/**
 * Information-Gain 問題引擎（PA7）。
 *
 * 從「可能解釋這個訊號」的候選 journal 類別中，排出一個分數，
 * 選**恰好一個**最值得問的類別，組成**恰好一題**的訊息。
 *
 * ## 重用，不重造
 *
 * 候選類別直接沿用 `src/bot/conversation.js` 既有的
 * `FOLLOW_UP_CATEGORIES`（反應式追問已經在用的同一組類別）——
 * 沒有理由主動代理用一套不同的分類法。
 *
 * ## 分數不是統計量
 *
 * 這裡算出來的「資訊增益分數」只是排序用的產品啟發式（權重見
 * `src/proactivePolicy.js` 的 `INFORMATION_GAIN_POLICY`），不是任何形式的
 * 機率或統計顯著性。真正的資料充分度另外由 `assessJournalAssociation()`
 * 判斷。
 */

import { FOLLOW_UP_CATEGORIES } from './bot/conversation.js';
import { assessJournalAssociation, READINESS_STATUS } from './readiness.js';
import { CONFIDENCE } from './analytics/correlation.js';
import { INFORMATION_GAIN_POLICY } from './proactivePolicy.js';
import { DEVIATION } from './analytics/anomaly.js';

export { FOLLOW_UP_CATEGORIES };

const QUALITY_SCORE = {
  [CONFIDENCE.BETTER]: 1,
  [CONFIDENCE.MODERATE]: 0.75,
  [CONFIDENCE.LOW]: 0.5,
  [CONFIDENCE.INSUFFICIENT]: 0.5, // 還不知道，中性分數——不因為沒歷史就懲罰新類別
};

const SEVERITY_SCORE = { [DEVIATION.STRONG]: 1, [DEVIATION.NOTABLE]: 0.6, [DEVIATION.MILD]: 0.3 };

const METRIC_LABEL = { hrv: 'HRV', rhr: '靜息心率', recovery: '恢復分數', respiratory_rate: '呼吸率' };
const DIRECTION_WORD = { low: '偏低', high: '偏高', flat: '有變化' };
const LEVEL_WORD = { [DEVIATION.STRONG]: '不少', [DEVIATION.NOTABLE]: '一些' };

const CATEGORY_PROMPT = {
  alcohol: '昨天有喝酒嗎？',
  sickness: '最近有沒有不舒服、感冒的感覺？',
  travel: '昨天有搭飛機或跨時區旅行嗎？',
  late_sleep: '昨晚是不是特別晚睡？',
  stress: '最近是不是壓力特別大？',
};

/**
 * 幫一個候選類別打分。
 *
 * @param {string} category
 * @param {object} signal 觸發這次評估的訊號（detectSignals() 的一筆）
 * @param {object[]} journalEvents 這個使用者的 journal 歷史
 * @param {{date:string,value:number}[]} metricSeries 訊號指標的完整序列
 */
export function scoreCandidate({
  category, signal, journalEvents = [], metricSeries = [],
}) {
  const readiness = assessJournalAssociation({
    journalEvents, metricSeries, category, lagDays: 1,
  });
  const priorScore = readiness.data_quality
    ? (QUALITY_SCORE[readiness.data_quality] ?? 0.5)
    : 0.5;
  const severityScore = SEVERITY_SCORE[signal.level] ?? 0.3;

  const w = INFORMATION_GAIN_POLICY.WEIGHTS;
  const score = w.PRIOR_ASSOCIATION_STRENGTH * priorScore + w.SIGNAL_SEVERITY * severityScore;

  return {
    category,
    score,
    prior_score: priorScore,
    severity_score: severityScore,
    association_readiness: readiness.status,
  };
}

/**
 * 選出恰好一個候選類別。
 *
 * @param {Set<string>} excludeCategories 今天已經有 journal、或最近才問過
 *   （反騷擾冷卻中）的類別——這些直接排除，不進排序。
 * @returns {?object} { category, score, question, candidates } 或
 *   null（所有候選都被排除，呼叫端要降級成 NOTIFY）
 */
export function selectQuestion({
  signal, journalEvents = [], metricSeries = [], excludeCategories = new Set(),
}) {
  const candidates = FOLLOW_UP_CATEGORIES
    .filter((c) => !excludeCategories.has(c))
    .map((category) => scoreCandidate({
      category, signal, journalEvents, metricSeries,
    }));

  if (!candidates.length) return null;

  // 分數高者優先；同分時用 FOLLOW_UP_CATEGORIES 的既有順序（穩定排序），
  // 保證同樣的輸入永遠選出同一個類別。
  const ranked = [...candidates].sort((a, b) => b.score - a.score);
  const top = ranked[0];

  return {
    category: top.category,
    score: top.score,
    question: buildQuestionText({ category: top.category, signal }),
    candidates: ranked,
  };
}

/** 訊號 + 類別 → 一句話的問題。純樣板，不是 LLM 生成。 */
export function buildQuestionText({ category, signal }) {
  const metricLabel = METRIC_LABEL[signal.metric] ?? signal.metric;
  const dirWord = DIRECTION_WORD[signal.direction] ?? '有變化';
  const levelWord = LEVEL_WORD[signal.level] ?? '';
  const prompt = CATEGORY_PROMPT[category] ?? '昨天有發生什麼特別的事嗎？';

  return `你的${metricLabel}今天比平常${dirWord}${levelWord ? `了${levelWord}` : ''}。${prompt}\n`
    + '（直接回我就好，例如「喝了三杯」或「沒有」。我會記下來，之後就能對照著看。）';
}

/**
 * 這是唯一規則：一次最多問一題。存在只是把規則明文化並可測試，
 * 不是給呼叫端調整的旋鈕。
 */
export const MAX_QUESTIONS_PER_EVENT = INFORMATION_GAIN_POLICY.MAX_QUESTIONS_PER_EVENT;
