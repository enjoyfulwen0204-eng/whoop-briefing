/**
 * 使用者回答主動問題之後的重新分析（PA11／PA12／PA13／PA14）。
 *
 * ## 誠實面對「還是解釋不了」
 *
 * 一次新增的 journal 事件幾乎不可能單獨把某個類別的關聯撐到統計上
 * 「夠了」——這是刻意的。`healthMemory.js` 的 `statusFromEvidence()`
 * 本來就是依 `dataQualityOf(sampleCount)` 分級，這裡直接呼叫它、
 * 不繞過、不加速。STILL_UNEXPLAINED 是完全合法、誠實的結果。
 *
 * ## Evidence Card（PA12）
 *
 * 不新增獨立的 evidence 表——`health_insights.evidence_json` 已經是
 * 為此設計的欄位（見 src/evidence.js 的 fromInsight()）。這裡寫進去的
 * evidence 就是 journalAssociation() 的完整輸出，保留 pearson/spearman/
 * p_value/樣本數，翻譯成卡片是 evidence.js 的工作，這裡不重算。
 *
 * ## Insight Memory（PA13）
 *
 * 直接呼叫既有的 `recordInsight`/`reviseInsight`（healthMemory.js），
 * 不繞過它們的狀態機——這正是「一次回答不能直接跳到 SUPPORTED」的保證
 * 來源，不是這個檔案自己加的規則。
 */

import { addDays } from './time.js';
import { loadDailyMetrics, seriesOf } from './dailyMetrics.js';
import { assessJournalAssociation, READINESS_STATUS } from './readiness.js';
import { journalAssociation } from './analytics/correlation.js';
import { recordInsight, reviseInsight, INSIGHT_STATUS } from './healthMemory.js';
import { decideFollowUp } from './attention.js';
import { buildFollowUpMessage, guardProactiveMessage } from './proactiveMessages.js';
import { PROACTIVE_OUTCOME } from './schema.js';
import { requireUserId } from './userContext.js';
import { log } from './logger.js';

const METRIC_LABEL = { hrv: 'HRV', rhr: '靜息心率', recovery: '恢復分數', respiratory_rate: '呼吸率' };
const CATEGORY_LABEL = {
  alcohol: '喝酒', sickness: '生病/不舒服', travel: '旅行', late_sleep: '晚睡', stress: '壓力',
};

function describeAssociation(category, metric, assoc) {
  const metricLabel = METRIC_LABEL[metric] ?? metric;
  const categoryLabel = CATEGORY_LABEL[category] ?? category;
  const dir = assoc.pearson === null ? '不明顯' : (assoc.pearson > 0 ? '正向' : '負向');
  const r = assoc.pearson === null ? '不明' : assoc.pearson.toFixed(2);
  return `「${categoryLabel}」與隔天${metricLabel}之間目前觀察到${dir}的關聯`
    + `（r=${r}，樣本 ${assoc.n} 天，資料充分度 ${assoc.data_quality}）。`
    // ⚠️ 刻意不寫「不是因果關係」——guardNarrative 的 CAUSAL_PATTERNS 對
    // 「因果關係」是單純子字串比對，不理解否定語境，這句話會被自己的安全
    // 檢查擋下來。跟 correlation.js／evidence.js 用同一套說法繞開這個問題：
    // 直接講「觀察到的關聯」，不提「因果」兩個字。
    + '這是個人層級觀察到的關聯，跟其他因素的影響無法完全分開。';
}

/**
 * @param {string} category journal 類別（FOLLOW_UP_CATEGORIES 之一）
 * @param {string} metric   觸發這次追問的指標（例如 'hrv'）
 * @param {string} healthDate 觸發訊號當天（重新分析的錨點，不是回答當下）
 */
export async function reanalyzeAfterAnswer({
  db, userId, timezone, category, metric, healthDate, now = new Date(),
}) {
  const uid = requireUserId(userId, 'reanalyzeAfterAnswer');

  const from = addDays(healthDate, -180);
  const [rows, journalEvents] = await Promise.all([
    loadDailyMetrics({ db, userId: uid, timezone, from, to: healthDate }),
    db.getJournalEvents(uid, { from, to: healthDate, limit: 2000 }),
  ]);
  const metricSeries = seriesOf(rows, metric);

  const readiness = assessJournalAssociation({
    journalEvents, metricSeries, category, lagDays: 1,
  });
  const assoc = journalAssociation({
    journalEvents, metricSeries, category, lagDays: 1,
  });

  // ★ 兩個獨立的關卡，缺一不可：
  //   1. readiness 至少要 LIMITED（樣本數過門檻）
  //   2. assoc.usable 一定要 true（exposed/unexposed 天數都 >= 3，
  //      也就是「真的有對照組」）——這是最關鍵的一關。少了它，
  //      readiness 的 LIMITED 也可能只是「剛好只有 1 個曝露日」
  //      （journalAssociation 本身回傳 usable:false，此時 pearson 是拿
  //      「一天 vs 其餘全部」硬算出來的數字，看起來效果量很大，但那是
  //      單一樣本的雜訊，不是真的關聯）。沒有這一關會導致一次新答案就
  //      直接把 insight 撐到 SUPPORTED，違反「一次回答不能直接變
  //      SUPPORTED」的規則。
  const readyEnough = readiness.status === READINESS_STATUS.READY
    || readiness.status === READINESS_STATUS.LIMITED;

  if (!readyEnough || !assoc.usable) {
    log.info('proactive_reanalysis_insufficient', {
      user_id: uid, category, metric, readiness_status: readiness.status, usable: assoc.usable,
    });
    return { outcome: PROACTIVE_OUTCOME.STILL_UNEXPLAINED, insightChanged: false, followUpMessage: null };
  }

  const subject = `${category}_vs_${metric}`;
  const statement = describeAssociation(category, metric, assoc);

  // 刻意用 getActiveInsights（不排除 HYPOTHESIS），否則卡在 HYPOTHESIS 的
  // insight 每次都會被 activeBeliefs 濾掉、誤判成「還沒建立過」，
  // 導致同一個 subject 重複建立新列而不是修正既有的那一列。
  const existing = await db.getActiveInsights(uid, { subject });
  const current = existing[0] ?? null;

  let changed = false;
  let fromStatus = null;
  let toStatus = null;

  if (!current) {
    const created = await recordInsight(db, uid, {
      insightType: 'journal_association',
      subject,
      statement,
      evidence: assoc,
      sampleCount: assoc.n,
      effectSize: assoc.pearson,
    }, { now });
    toStatus = created.status;
    // 第一次建立、而且證據已經到 EMERGING 以上，才算「有新東西可以講」；
    // 剛建立就是 HYPOTHESIS 的話，那不是一個值得主動告知的變化。
    changed = created.status !== INSIGHT_STATUS.HYPOTHESIS;
    fromStatus = null;
  } else {
    const revised = await reviseInsight(db, uid, current.id, {
      statement, evidence: assoc, sampleCount: assoc.n, effectSize: assoc.pearson,
    }, { now });
    if (revised.ok) {
      changed = revised.changed;
      fromStatus = current.status;
      toStatus = revised.status;
    }
  }

  const outcome = changed ? PROACTIVE_OUTCOME.EXPLAINED : PROACTIVE_OUTCOME.STILL_UNEXPLAINED;
  const followUpDecision = decideFollowUp({ insightChanged: changed, outcome });

  let followUpMessage = null;
  if (followUpDecision.decision === 'FOLLOW_UP') {
    const raw = buildFollowUpMessage({ statement, fromStatus: fromStatus ?? 'NEW', toStatus });
    followUpMessage = guardProactiveMessage(raw, { label: 'follow_up' }).text;
  }

  log.info('proactive_reanalysis_done', {
    user_id: uid, category, metric, outcome, insight_changed: changed,
  });

  return { outcome, insightChanged: changed, followUpMessage };
}
