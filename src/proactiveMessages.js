/**
 * Proactive Agent 的訊息樣板 + 安全語言把關（PA15／PA16／PA17-18）。
 *
 * ## 冷啟動階段——由 readiness 決定，不是日曆天數
 *
 * STAGE_0/1/2 直接對應 PROACTIVE_MONITORING 的 NO_DATA/WARMING_UP/LIMITED；
 * 只有 READY 才進入 STAGE_3（完整流程可以跑）。STAGE_4（成熟）代表這個
 * 使用者已經有至少一個非 HYPOTHESIS 的 insight——這時候的訊息可以引用
 * 「這是我們之前觀察到的規律」這類脈絡，STAGE_3 則不行。
 *
 * ## 安全語言
 *
 * NOTIFY 訊息一律只能用「建議考慮休息／就醫／諮詢醫療專業人員」這種保守
 * 措辭，絕不能宣稱偵測到急症、絕不能診斷。每一則要送出去的訊息在真正送出
 * 前都會再跑一次 `guardNarrative` 家族的規則檢查（跟健康問答用同一套
 * 因果/診斷語言黑名單），這是深度防禦：樣板本身已經是安全的，
 * 這一層只是確保「以後改樣板時不小心踩到」會被擋下來，而不是新增規則。
 */

import { validatePublication } from './publishGuard.js';
import { factsFromProactive } from './publishableFacts.js';
import { READINESS_STATUS } from './readiness.js';
import { DEVIATION } from './analytics/anomaly.js';
import { log } from './logger.js';

export const COLD_START_STAGE = {
  STAGE_0: 'STAGE_0',
  STAGE_1: 'STAGE_1',
  STAGE_2: 'STAGE_2',
  STAGE_3: 'STAGE_3',
  STAGE_4: 'STAGE_4',
};

/** 由 PROACTIVE_MONITORING 的 readiness + 是否已有成熟 insight 決定階段。 */
export function deriveColdStartStage({ proactiveMonitoringStatus, hasMatureInsight = false }) {
  switch (proactiveMonitoringStatus) {
    case READINESS_STATUS.NO_DATA: return COLD_START_STAGE.STAGE_0;
    case READINESS_STATUS.WARMING_UP: return COLD_START_STAGE.STAGE_1;
    case READINESS_STATUS.LIMITED: return COLD_START_STAGE.STAGE_2;
    case READINESS_STATUS.READY:
      return hasMatureInsight ? COLD_START_STAGE.STAGE_4 : COLD_START_STAGE.STAGE_3;
    // DEGRADED / UNAVAILABLE：資料曾經足夠但現在有問題，保守當成不能主動打擾。
    default: return COLD_START_STAGE.STAGE_0;
  }
}

/** 只有 STAGE_3／STAGE_4 允許 Attention Engine 產生 ASK_CONTEXT / NOTIFY。 */
export function stageAllowsMessaging(stage) {
  return stage === COLD_START_STAGE.STAGE_3 || stage === COLD_START_STAGE.STAGE_4;
}

const SAFETY_LINE = '如果你覺得不舒服，建議考慮休息、就醫或諮詢醫療專業人員——我沒有能力做任何醫療判斷。';

const METRIC_LABEL = { hrv: 'HRV', rhr: '靜息心率', recovery: '恢復分數', respiratory_rate: '呼吸率' };
const DIRECTION_WORD = { low: '偏低', high: '偏高', flat: '有變化' };
const LEVEL_WORD = { [DEVIATION.STRONG]: '，而且幅度不小', [DEVIATION.NOTABLE]: '' };

/**
 * NOTIFY 決策的訊息樣板（沒有問句，因為 NOTIFY 就是「不問，只告知」）。
 * 純樣板，不經過 LLM。
 */
export function buildNotifyMessage(signal) {
  const metricLabel = METRIC_LABEL[signal.metric] ?? signal.metric;
  const dir = DIRECTION_WORD[signal.direction] ?? '有變化';
  const lvl = LEVEL_WORD[signal.level] ?? '';
  return `留意一下：你的${metricLabel}最近持續${dir}${lvl}，不是單一天的雜訊。\n\n${SAFETY_LINE}`;
}

/** insight 狀態變化 → follow-up 訊息（PA14）。只有真的變化才會被呼叫。 */
export function buildFollowUpMessage({ statement, fromStatus, toStatus }) {
  return `補充一下之前提到的觀察：${statement}\n`
    + `（信心程度從 ${fromStatus} 更新為 ${toStatus}，會持續追蹤。）`;
}

/**
 * 深度防禦：任何要送出去的主動訊息，送出前都再驗一次。
 *
 * ## 稽核修正史
 *
 * 第一版是 `validateNarrative(text, text, { checkNumbers: false })`，兩個
 * 破口：數字守門沒跑，而且 context 傳的是 text 自己（任何數字都找得到
 * 自己）。第二版改成 fail-closed 的字串比對，但獨立稽核證明字串比對會被
 * 改寫繞過。
 *
 * 現在走**同一個發布邊界**（publishGuard）：訊息裡的每一個數值宣稱都要
 * 歸屬到一筆可發布的結構化事實。呼叫端傳 `factSet`（由
 * publishableFacts.factsFromProactive 從訊號／關聯統計建立）。
 *
 * 沒傳 factSet → 空事實集 → 任何數字都歸屬不到 → 一律擋下並改用中性
 * 樣板。這正是 fail closed 該有的行為。
 */
export function guardProactiveMessage(text, {
  label = 'proactive', factSet = null, signal = null, association = null,
} = {}) {
  const set = factSet ?? factsFromProactive({ signal, association });
  const check = validatePublication(text, set);
  if (check.ok) return { text, violations: [] };
  log.error('proactive_message_failed_guard', { label, violations: check.violations.slice(0, 6) });
  return {
    text: '你的生理數據最近有些變化，值得留意。',
    violations: check.violations,
  };
}
