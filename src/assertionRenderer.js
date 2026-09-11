/**
 * 確定性斷言渲染器（R3-H-02）。
 *
 * ## 這個模組存在的唯一理由
 *
 *   **LLM 永遠不可以是「已發布的生理宣稱」的來源。**
 *
 * 前兩輪的做法都是「讓 LLM 自由寫，再檢查它有沒有說錯」。獨立稽核連續
 * 兩次證明那個方向追不完：改標點、換語序、換同義詞、用中文數字、把句子
 * 切開、只講方向不給數字 —— 27 個攻擊樣本裡漏了 17 個。
 *
 * 問題不在規則不夠多，在於**架構**：只要生理陳述是由 LLM 產生的，
 * 驗證就永遠是在追一個無限的集合。
 *
 * 所以這一輪把來源反過來：
 *
 *   已驗證的結構化事實 → **這個渲染器** → 生理斷言（確定性、樣板）
 *                       → 選配的 LLM 說明（不得包含任何生理斷言）
 *                       → 組裝器
 *
 * 渲染器只吃 `publishable: true` 的事實，而且每一句都用固定樣板組出來。
 * 沒有事實就沒有句子 —— 捏造在結構上不可能發生，不需要辨識任何一種
 * 「幻覺句型」。
 *
 * ## 為什麼這樣才敢把過濾器調得很兇
 *
 * LLM 那一段現在是**純裝飾**：數字與判定都已經由渲染器輸出。所以丟掉它
 * 的代價只是少一段鼓勵的話，不會少任何資訊。這個不對稱讓過濾器可以
 * 「寧可錯殺」—— 而那正是它能夠不依賴列舉的原因。
 */

import { FACT_ROLE } from './publishableFacts.js';
import { log } from './logger.js';

/**
 * metric → 對外顯示名稱。與 METRIC_VOCABULARY 的第一個別名一致。
 *
 * ⚠️ 這張表就是**發布的白名單**。不在表裡的 key 一律不發布 —— 見
 * displayLabelFor()。以前這裡是 `DISPLAY_LABEL[k] ?? k`，於是任何漏掉對應的
 * 內部欄位名會被原樣印給使用者看（實測出現過「previous_day_strain 2.6」）。
 */
const DISPLAY_LABEL = {
  recovery: '恢復',
  hrv: 'HRV',
  rhr: '靜息心率',
  respiratory_rate: '呼吸率',
  sleep_total: '睡眠',
  slow_wave: '深睡',
  rem: 'REM',
  sleep_performance: '睡眠表現',
  sleep_debt: '睡眠債',
  sleep_consistency: '睡眠一致性',
  sleep_efficiency: '睡眠效率',
  disturbance_count: '擾動次數',
  strain: 'Strain',
  spo2: '血氧',
  skin_temp: '皮膚溫度',
  weight: '體重',
  steps: '步數',
  vo2_max: '最大攝氧量',
  max_heart_rate: '最大心率',
  lean_body_mass: '去脂體重',
  calories: '熱量',
};

/**
 * 取得可以印給使用者看的標籤。**沒有核可的標籤就回 null（fail closed）。**
 *
 * 絕不回傳 metric key 本身：那是內部識別碼（snake_case、DB 欄位名、分析用
 * 的鍵），使用者看到只會困惑，而且等於洩漏內部結構。
 */
export function displayLabelFor(f) {
  // 明確覆寫優先（保留「昨日 Strain」這種時間語義）
  if (typeof f?.displayLabel === 'string' && f.displayLabel.trim()) return f.displayLabel;
  const label = DISPLAY_LABEL[f?.metric];
  if (typeof label === 'string' && label.trim()) return label;
  log.warn('assertion_unmapped_metric_key', { metric: f?.metric ?? null });
  return null;
}

/** 一筆事實 → 顯示字串。優先用確定性層算好的 display。 */
function valueText(f) {
  if (f.display) return String(f.display);
  if (f.value === null) return null;
  return f.unit ? `${f.value}${f.unit}` : String(f.value);
}

/**
 * 一筆事實 → 一句斷言。
 *
 * 樣板依 role 決定，所以「這句話在講什麼」由型別決定，不由文字決定。
 * 回 null 代表這筆事實不可發布（或沒有可顯示的值），那就**不會有這句話**。
 */
export function renderAssertion(f) {
  if (!f || !f.publishable) return null;
  // 沒有核可標籤 → 整筆不發布。寧可少一句話，也不要把內部欄位名印出去。
  const label = displayLabelFor(f);
  if (label === null) return null;
  const text = valueText(f);
  if (text === null) return null;

  switch (f.role) {
    case FACT_ROLE.BASELINE:
      return { factId: f.factId, text: `${label}基準 ${text}` };
    case FACT_ROLE.CHANGE:
      return { factId: f.factId, text: `${label}變化 ${text}` };
    case FACT_ROLE.TREND:
      return { factId: f.factId, text: `${label}趨勢 ${text}` };
    case FACT_ROLE.SUPPORTING_STATISTIC:
      return { factId: f.factId, text: `${label} ${text}` };
    case FACT_ROLE.CURRENT_VALUE:
    default:
      return { factId: f.factId, text: `${label} ${text}` };
  }
}

/**
 * 一組事實 → 全部的確定性斷言。
 *
 * @returns {{lines:string[], factIds:string[], unavailable:string[]}}
 *   lines        要印給使用者看的句子
 *   factIds      每一句的來源（provenance；稽核用）
 *   unavailable  這次拿不到資料的指標名稱（誠實告知，不是捏造）
 */
export function renderAssertions(factSet) {
  const lines = [];
  const factIds = [];
  const unavailable = [];
  for (const f of factSet?.facts ?? []) {
    const rendered = renderAssertion(f);
    if (rendered) {
      lines.push(rendered.text);
      factIds.push(rendered.factId);
      continue;
    }
    // 不可發布 = 這次沒有資料。誠實列出來，不要假裝它不存在 ——
    // 但一樣只用核可的標籤，沒有就整筆略過。
    if (f && f.value === null) {
      const label = displayLabelFor(f);
      if (label !== null) unavailable.push(label);
    }
  }
  return { lines, factIds, unavailable };
}

/**
 * 組裝最終要送出去的文字。
 *
 * 順序是刻意的：**確定性斷言永遠在前，而且永遠存在**；LLM 的說明只在
 * 通過「不含任何生理斷言」的檢查之後才被附加上去。
 *
 * @param {string[]} assertionLines 確定性斷言（renderAssertions 的輸出）
 * @param {?string}  explanation    已經通過檢查的 LLM 說明（沒有就傳 null）
 * @param {object}   opts
 *   header       最上面的一行（可選）
 *   unavailable  拿不到資料的指標名稱
 *   emptyText    完全沒有任何斷言時要說的話
 */
export function assemblePublication({
  header = null, assertionLines = [], explanation = null,
  unavailable = [], emptyText = '目前還沒有足夠的資料可以回答這個問題。',
} = {}) {
  const parts = [];
  if (header) parts.push(header);
  if (assertionLines.length) parts.push(assertionLines.join('\n'));
  if (unavailable.length) parts.push(`目前拿不到：${unavailable.join('、')}`);
  if (!assertionLines.length && !unavailable.length) parts.push(emptyText);
  if (explanation) parts.push(explanation);
  return parts.join('\n\n');
}
