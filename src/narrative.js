/**
 * 簡報的自然語言敘述層。
 *
 * ## 這個模組存在的理由
 *
 * 正式環境曾經把教練整個關掉（`coachText = null`），於是**每一天**的簡報
 * 結尾都是：
 *
 *     ⚠️ AI 教練分析今天暫時無法生成，數據簡報仍正常
 *
 * 那句話是假的：根本沒有嘗試生成過。使用者每天被告知一個不存在的故障，
 * 同時也真的失去了敘述。
 *
 * ## 權責邊界（H-05 之後）
 *
 * **應用程式擁有每一個字。**
 *
 * 模型不再產生任何會被發布的文字。它拿到一份由應用程式寫好的候選句子
 * 清單（每句一個 id），唯一能回的是一串 id；發布出去的文字完全由這些
 * id 對應的、我們自己寫的句子串成。
 *
 * 為什麼要走到這一步：前三輪都是「讓模型自由寫，再驗證它說了什麼」，
 * 而獨立稽核連續三輪證明那是在窮舉一個無限集合。決定性的反例是
 *
 *     「熬夜使你的免疫力下降。」
 *
 * —— 沒有數字、沒有指標名、沒有拉丁字母、沒有藥名病名，於是每一條規則
 * 都放行，而它是一個毫無根據的因果生理宣稱。再加一條規則只會換來下一句。
 *
 * 完整說明見 narrativePlan.js。
 */

import {
  buildFragmentCatalogue, catalogueForModel, fragmentsArePublishable,
  renderFragments, validatePlan,
} from './narrativePlan.js';
import { log } from './logger.js';

/** 失敗分類。只進日誌與 report detail，不會出現在使用者眼前。 */
export const NARRATIVE_SOURCE = Object.freeze({
  /** 模型挑了順序（文字仍然 100% 由應用程式產生）。 */
  MODEL: 'model',
  /** 用應用程式的預設順序。 */
  DETERMINISTIC: 'deterministic',
});

export const NARRATIVE_FAILURE = Object.freeze({
  NOT_CONFIGURED: 'not_configured',
  PROVIDER_UNAVAILABLE: 'provider_unavailable',
  TIMEOUT: 'timeout',
  EMPTY_OUTPUT: 'empty_output',
  /** 計畫的結構不合法（不是 id 陣列、編造 id、重複、丟掉事實骨幹…）。 */
  INVALID_PLAN: 'invalid_plan',
  /**
   * 我們**自己**的樣板違反了發布守門。這是程式錯誤，不是模型的問題 ——
   * 它在這裡浮出來，而不是安靜地送給使用者。
   */
  TEMPLATE_VIOLATION: 'template_violation',
});

/**
 * 確定性敘述：模型不可用、或計畫被否決時使用。
 *
 * 它**不是**錯誤訊息。使用者拿到的仍然是一段完整可讀的話，內容完全來自
 * 已核可的事實 —— 只是順序由我們決定。絕不宣稱「AI 暫時無法生成」，
 * 因為那句話在多數情況下是假的，而且對使用者毫無意義。
 */
export function deterministicNarrative(briefing, { period = 'daily' } = {}) {
  const catalogue = buildFragmentCatalogue(briefing, { period });
  return renderFragments(catalogue, catalogue.defaultOrder);
}

/**
 * 產生敘述。**一定會回傳一段可讀的文字**，永遠不會回 null。
 *
 * @param {function} plan
 *   `(fragments) => Promise<{order: string[]}|null>`
 *   把候選句子清單交給模型，拿回一份**只含 id** 的計畫。
 *   失敗 / 不可用時回 null —— 呼叫端不需要做任何額外處理。
 *
 * @param {function} generate **已移除**。
 *   舊介面讓模型回傳散文，那正是 H-05 的根因。仍然有人傳它進來時，
 *   我們不會偷偷去用它（那等於架構沒改），只會記一筆並走確定性敘述。
 */
export async function buildNarrative({
  briefing, plan = null, period = 'daily', generate = undefined,
}) {
  const catalogue = buildFragmentCatalogue(briefing, { period });
  const base = renderFragments(catalogue, catalogue.defaultOrder);

  /** 發布前的最後檢查。連確定性那一段都要過 —— 擋的是我們自己改壞樣板。 */
  const publish = (text, source, failureCategory) => {
    if (!fragmentsArePublishable(text, { label: `narrative_${period}` })) {
      // 樣板本身有問題。這時候沒有一個「更安全的文字」可以退，
      // 因為 base 與它同源。照實記錄，仍然回傳 —— 簡報的數字表格
      // 是另外渲染的，使用者不會因此拿到空白。
      return {
        text, source, failureCategory: NARRATIVE_FAILURE.TEMPLATE_VIOLATION,
      };
    }
    return { text, source, failureCategory };
  };

  const fallback = (reason, level = 'info') => {
    log[level]('narrative_deterministic', { reason, period });
    return publish(base, NARRATIVE_SOURCE.DETERMINISTIC, reason);
  };

  if (generate !== undefined) {
    // 明確拒絕舊介面。靜默忽略會讓呼叫端以為模型還在參與，
    // 而靜默採用會把剛關上的那個洞重新打開。
    log.warn('narrative_freeform_generate_ignored', { period });
  }

  if (typeof plan !== 'function') return fallback(NARRATIVE_FAILURE.NOT_CONFIGURED);

  let proposal;
  try {
    proposal = await plan(catalogueForModel(catalogue));
  } catch (err) {
    const category = /timeout|abort/i.test(String(err?.message ?? ''))
      ? NARRATIVE_FAILURE.TIMEOUT : NARRATIVE_FAILURE.PROVIDER_UNAVAILABLE;
    return fallback(category, 'warn');
  }

  if (proposal === null || proposal === undefined) {
    return fallback(NARRATIVE_FAILURE.PROVIDER_UNAVAILABLE);
  }

  const checked = validatePlan(catalogue, proposal);
  if (!checked.ok) {
    // 被否決的內容絕不進入日誌 —— 只記**理由**。
    log.warn('narrative_plan_rejected', { reason: checked.reason, period });
    return publish(base, NARRATIVE_SOURCE.DETERMINISTIC, NARRATIVE_FAILURE.INVALID_PLAN);
  }

  // 文字來自我們自己的清單，模型只決定了順序與取捨。
  const text = renderFragments(catalogue, checked.order);
  if (!text.trim()) return fallback(NARRATIVE_FAILURE.EMPTY_OUTPUT, 'warn');

  return publish(text, NARRATIVE_SOURCE.MODEL, null);
}
