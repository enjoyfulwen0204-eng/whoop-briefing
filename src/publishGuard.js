/**
 * 發布邊界（R3-H-02）：LLM 說明必須**完全不含生理斷言**。
 *
 * ## 不變量
 *
 *   **LLM 永遠不可以是「已發布的生理宣稱」的來源。**
 *
 * ## 為什麼要換掉前兩輪的做法
 *
 * 前兩輪都是「讓 LLM 自由寫，再驗證它說的對不對」：
 *   R1 比對數字有沒有在 prompt 文字裡出現過
 *   R2 比對數字有沒有歸屬到正確的結構化事實
 *
 * 獨立稽核連續兩次證明這個方向追不完。R3 的探測在 R2 的架構下仍然漏了
 * 27 個裡的 17 個：
 *
 *   「恢復為 30%。」            30 剛好是基準窗天數（結構性數字）
 *   「恢復。今天的數值是 99%。」 句子被切開，第二句裡沒有指標名
 *   「你的 HRV 偏高。」          只有方向、沒有數字
 *   「恢復九成九。」             「成」不是被涵蓋的單位寫法
 *   「Take Zorblax every night.」不在任何藥名清單裡
 *
 * 問題不在規則不夠多，在於**只要生理陳述由 LLM 產生，驗證就是在追一個
 * 無限集合**。
 *
 * ## 這一輪的架構
 *
 *   已驗證的結構化事實
 *     → assertionRenderer（確定性樣板）→ **所有**生理斷言
 *     → 選配的 LLM 說明（必須通過這裡的檢查）
 *     → 組裝器
 *
 * 於是這個模組的工作變成一個**封閉**的問題：
 * 「這段純裝飾的文字裡，有沒有出現任何生理斷言？」有就整段丟掉。
 *
 * ## 為什麼可以（而且應該）調得很兇
 *
 * 數字與判定都已經由渲染器輸出了，所以丟掉 LLM 那一段的代價只是少一句
 * 鼓勵的話 —— **不會少任何資訊**。這個不對稱讓過濾器可以「寧可錯殺」，
 * 而那正是它不需要列舉每一種幻覺句型的原因。
 *
 * 判準（任何一條成立就整段丟掉）：
 *   1. 出現任何**指標名**（封閉詞彙表，含專有分數與英文別名）
 *   2. 出現任何**數字**（阿拉伯數字，或中文／英文數字詞）
 *   3. 治療／用藥／處置指示
 *   4. 醫學診斷措辭
 *   5. 強因果或「即時生理數值」宣稱
 *   6. 監測指示
 *
 * 第 1、2 條合起來涵蓋了所有「數值型」與「方向型」的生理斷言，
 * 不需要知道句子長什麼樣。
 */

import { ALL_METRIC_TERMS, TERM_TO_METRIC } from './publishableFacts.js';
import { normalizeNumberWordsAggressive } from './numberWords.js';
import {
  CAUSAL_PATTERNS, DIAGNOSIS_PATTERNS, LIVE_CLAIM_PATTERNS, TREATMENT_PATTERNS,
} from './llmValidation.js';
import { log } from './logger.js';

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const METRIC_TERM_RE = new RegExp(`(${ALL_METRIC_TERMS.map(escapeRe).join('|')})`, 'gi');

/**
 * 有些指標名在中文裡同時是常用動詞（最典型的是「恢復」）。
 *
 *   「你的恢復 55%」   指標
 *   「兩三天內會恢復」 動詞
 *
 * 動詞用法不是生理斷言，擋掉它只會讓正常的鼓勵話語消失。
 * 判準是語法標記，不是語意猜測。
 */
const VERB_CONTEXT = {
  恢復: {
    before: /(?:會|能|夠|可以|已經|慢慢|逐漸|開始|快|難以|沒有|還沒|尚未|完全)\s*$/,
    after: /^(?:了|過來|得|不了|起來)/,
  },
};

/** 這段文字裡出現的指標名（排除明顯的動詞用法）。 */
function metricMentions(text) {
  const out = [];
  for (const m of text.matchAll(METRIC_TERM_RE)) {
    const key = TERM_TO_METRIC.get(m[1].toLowerCase());
    if (!key) continue;
    const rule = VERB_CONTEXT[m[1]];
    if (rule) {
      const before = text.slice(Math.max(0, m.index - 6), m.index);
      const after = text.slice(m.index + m[1].length, m.index + m[1].length + 4);
      if (rule.before.test(before) || rule.after.test(after)) continue;
    }
    out.push({ key, term: m[1] });
  }
  return out;
}

/**
 * 治療／處置指示的**文法**（不是藥名清單）。
 *
 * 兩種形態，而且兩種都要求它真的是一個「指示」：
 *
 *   A 有引導詞：「建議你吃 X」「記得補充 X」
 *   B 祈使句　：子句開頭的醫療動詞 —— 「服用 X」「去打一針」「Take X」
 *
 * ⚠️ B 的動詞刻意只收**明確醫療**的那幾個。早期版本把「吃／喝／補充」也
 * 放進祈使句形態，結果把
 *
 *   「昨天有喝酒嗎？」          （問過去，不是指示）
 *   「補充一下之前提到的觀察」  （補充＝補述，不是攝取）
 *
 * 這種完全正常的樣板句誤判成用藥指示。動詞出現 ≠ 指示。
 *
 * 受詞只有落在一份很小而穩定的生活作息白名單裡才放行，所以阿斯匹靈、
 * 褪黑激素、或任何虛構藥名（Zorblax）都不需要被列舉。
 */
const TREATMENT_LEAD = '建議|可以|應該|不妨|記得|試試|要|請';
const TREATMENT_VERB_LED = '服用|吃|喝|補充|注射|施打|塗|敷|打';
/** 祈使句才認的動詞：明確醫療行為，不會有日常歧義。 */
const TREATMENT_VERB_BARE = '服用|注射|施打|吞服';
const QUANTIFIER = '一點|一些|一顆|一片|兩顆|半顆|幾顆|一針|一劑|一包';
const SAFE_INGESTIBLE = [
  '水', '溫水', '開水', '早餐', '午餐', '晚餐', '正餐', '飯', '東西', '點東西',
  '蔬菜', '水果', '青菜', '蛋白質', '碳水', '食物', '宵夜', '咖啡', '茶',
  '電解質', '運動飲料', '牛奶', '豆漿', '維他命', '維生素',
];
const SAFE_EN = [
  'water', 'breakfast', 'lunch', 'dinner', 'meal', 'food', 'fluids',
  'electrolytes', 'protein', 'vegetables', 'fruit', 'coffee', 'tea', 'break',
  'rest', 'nap', 'walk', 'easy', 'look', 'care', 'time',
];

const OBJECT = '([^\\s。，、；：！？,.;:!?（）()「」]{1,10})';

/** A：有引導詞。 */
const ZH_TREATMENT_LED_RE = new RegExp(
  `(?:${TREATMENT_LEAD})\\s*(?:你|妳)?\\s*(?:去)?\\s*(?:${TREATMENT_VERB_LED})`
  + `\\s*(?:${QUANTIFIER})?\\s*${OBJECT}`,
  'g',
);
/** B：子句開頭的祈使句（可帶「去」「請」）。 */
const ZH_TREATMENT_BARE_RE = new RegExp(
  `(?:^|[。！？!?\\n；;])\\s*(?:去|請)?\\s*(?:${TREATMENT_VERB_BARE})`
  + `\\s*(?:${QUANTIFIER})?\\s*${OBJECT}`,
  'g',
);
/** 「打一針 / 打點滴」——「打」只有配這些受詞才是醫療行為。 */
const ZH_INJECTION_RE = /(?:^|[。！？!?\n；;，,]|去|請)\s*打\s*(?:一|1)?\s*(?:針|點滴)/;

const EN_TREATMENT_RE = new RegExp(
  '(?:\\b(?:should|recommend|recommends|suggest|try|need to|ought to|must)\\s+'
  + '|(?:^|[.!?\\n])\\s*)'
  + '(?:take|taking|drink|drinking|apply|inject|swallow)\\s+'
  + '(?:a|an|some|the|your)?\\s*([a-z][a-z-]{1,20})',
  'gi',
);

function detectTreatmentInstruction(text) {
  for (const re of [ZH_TREATMENT_LED_RE, ZH_TREATMENT_BARE_RE]) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      const object = m[1] ?? '';
      if (!object) continue;
      if (SAFE_INGESTIBLE.some((safe) => object.startsWith(safe))) continue;
      return `處置指示:${object.slice(0, 10)}`;
    }
  }
  if (ZH_INJECTION_RE.test(text)) return '處置指示:注射';
  for (const m of text.matchAll(EN_TREATMENT_RE)) {
    const object = (m[1] ?? '').trim().toLowerCase();
    if (!object) continue;
    if (SAFE_EN.some((safe) => object.startsWith(safe))) continue;
    return `treatment_instruction:${object.slice(0, 16)}`;
  }
  return null;
}

/**
 * 劑量：數字 + 劑量單位。
 *
 * 不需要動詞 —— 「每天 500 毫克。」本身就是用藥指示，而它沒有任何
 * 治療動詞可以觸發上面的文法。
 */
const DOSAGE_RE = /\d+(?:\.\d+)?\s*(?:mg|mcg|ug|µg|ml|cc|IU|毫克|微克|公絲|毫升|錠|顆|粒|劑|單位)/i;

/** 診斷式的病名標籤。刻意不含「症狀」（正確的就醫提醒會用到）。 */
const DIAGNOSTIC_LABEL_RE = /症候群|症候羣|失調|障礙|中止症|呼吸中止|\bsyndrome\b|\bdisorder\b|\bapnea\b/i;

/**
 * 監測指示：叫使用者自己去量某個生理量。
 * 這個系統只讀 WHOOP，沒有立場指示任何量測行為。
 */
const MONITORING_RE = /(?:量|測|監測|追蹤|記錄)\s*(?:一下|一次|1下|1次)?\s*(?:血壓|血糖|體溫|心率|心跳|脈搏|血氧)/;

/** 任何阿拉伯數字。 */
const DIGIT_RE = /\d/;

/**
 * 確定性樣板訊息的**深度防禦**檢查（主動訊息用）。
 *
 * ## 為什麼這一條規則集比 validateExplanation 寬
 *
 * 主動訊息（`buildNotifyMessage`、`selectQuestion`、`buildFollowUpMessage`）
 * 完全由確定性樣板產生 —— proactiveAgent 從頭到尾**沒有呼叫 coach**。
 * 它們理當包含指標名與數字，那正是渲染器該做的事。
 *
 * 所以這裡不檢查「有沒有指標名／數字」（那會擋掉自己的正常輸出），
 * 只檢查**類別性**的違規：治療、診斷、強因果、宣稱即時數值、監測指示。
 * 這是防止樣板被改壞的第二道防線，不是防幻覺的主防線 ——
 * 主防線是「這條路徑上根本沒有 LLM」。
 *
 * @returns {{ok:boolean, violations:string[]}}
 */
export function validateDeterministicMessage(text) {
  const violations = [];
  const raw = String(text ?? '');
  if (!raw.trim()) return { ok: false, violations: ['empty_message'] };
  const normalized = normalizeNumberWordsAggressive(raw);

  const treatment = detectTreatmentInstruction(normalized);
  if (treatment) violations.push(`treatment_advice:${treatment}`);
  if (DOSAGE_RE.test(normalized)) violations.push('treatment_advice:劑量');
  for (const { re, label } of TREATMENT_PATTERNS) {
    if (re.test(normalized)) violations.push(`treatment_advice:${label}`);
  }
  for (const { re, label } of DIAGNOSIS_PATTERNS) {
    if (re.test(normalized)) violations.push(`diagnosis_language:${label}`);
  }
  if (DIAGNOSTIC_LABEL_RE.test(normalized)) violations.push('diagnosis_language:病名標籤');
  for (const { re, label } of CAUSAL_PATTERNS) {
    if (re.test(normalized)) violations.push(`causal_language:${label}`);
  }
  for (const { re, label } of LIVE_CLAIM_PATTERNS) {
    if (re.test(normalized)) violations.push(`live_claim:${label}`);
  }
  if (MONITORING_RE.test(normalized)) violations.push('monitoring_instruction');

  // 專有／衍生分數永遠不可以出現，連確定性樣板也不行
  // （系統根本算不出它們，樣板裡出現就是程式錯誤）。
  for (const m of metricMentions(normalized)) {
    if (m.key === 'whoop_age' || m.key === 'healthspan_score') {
      violations.push(`forbidden_metric:${m.key}:${m.term}`);
    }
  }
  return { ok: violations.length === 0, violations: [...new Set(violations)] };
}

/**
 * 這段 LLM 說明可不可以被附加到已發布的斷言後面。
 *
 * @returns {{ok:boolean, violations:string[]}}
 */
/**
 * 把「被拆開的拉丁字母」黏回去（R3-H-02）。
 *
 *   'r e c o v e r y'  →  'recovery'
 *   'H R V'            →  'HRV'
 *
 * 這是**正規化**，不是又一條同義詞規則：它不認識任何一個指標名，只是把
 * 一種寫法還原成標準寫法，然後交給既有的封閉詞彙表去判斷。所以它一次
 * 關掉「把英文指標名拆開」這整類寫法，而不是關掉其中某幾個詞。
 *
 * 只在 LLM 說明那條路上使用。誤判的代價是丟掉一句鼓勵的話 —— 而中文
 * 鼓勵語裡不會出現連續三個以上、彼此用空白隔開的單一拉丁字母。
 */
function collapseSpacedLatin(text) {
  return String(text ?? '').replace(
    /\b(?:[A-Za-z][ \t.\-_]+){2,}[A-Za-z]\b/g,
    (m) => m.replace(/[^A-Za-z]/g, ''),
  );
}

export function validateExplanation(text) {
  const violations = [];
  const raw = String(text ?? '');
  if (!raw.trim()) return { ok: false, violations: ['empty_explanation'] };

  // 積極正規化：先把拆開的拉丁字母黏回去，再把中文／英文數字詞轉成
  // 阿拉伯數字。誤判的代價只是丟掉一段裝飾文字，所以這裡刻意寧可錯殺。
  const normalized = normalizeNumberWordsAggressive(collapseSpacedLatin(raw));

  // 1. 任何指標名
  for (const m of metricMentions(normalized)) {
    violations.push(`metric_mention:${m.key}:${m.term}`);
  }

  // 2. 任何數字
  //
  // 這一條是整個檢查的骨幹：所有「數值型」的生理斷言都必然含數字，
  // 不管它被怎麼改寫、切句、換標點、換語序。而說明本來就不需要數字
  // —— 數字全部由確定性渲染器輸出。
  if (DIGIT_RE.test(normalized)) {
    violations.push(`numeric_claim:${normalized.match(/\d+(?:\.\d+)?/)?.[0] ?? '?'}`);
  }

  // 3. 治療／用藥／處置
  const treatment = detectTreatmentInstruction(normalized);
  if (treatment) violations.push(`treatment_advice:${treatment}`);
  for (const { re, label } of TREATMENT_PATTERNS) {
    if (re.test(normalized)) violations.push(`treatment_advice:${label}`);
  }

  // 4. 醫學診斷
  for (const { re, label } of DIAGNOSIS_PATTERNS) {
    if (re.test(normalized)) violations.push(`diagnosis_language:${label}`);
  }
  if (DIAGNOSTIC_LABEL_RE.test(normalized)) violations.push('diagnosis_language:病名標籤');

  // 5. 強因果 / 宣稱即時生理數值
  for (const { re, label } of CAUSAL_PATTERNS) {
    if (re.test(normalized)) violations.push(`causal_language:${label}`);
  }
  for (const { re, label } of LIVE_CLAIM_PATTERNS) {
    if (re.test(normalized)) violations.push(`live_claim:${label}`);
  }

  // 6. 監測指示
  if (MONITORING_RE.test(normalized)) violations.push('monitoring_instruction');

  return { ok: violations.length === 0, violations: [...new Set(violations)] };
}

/**
 * 通過檢查就回傳原文，否則回 null（**丟掉那一段**）。
 *
 * 回 null 不是錯誤路徑：確定性斷言已經包含全部資訊，少的只是一句
 * 鼓勵的話。呼叫端不需要 fallback 文案。
 */
export function guardExplanation(text, { label = 'explanation' } = {}) {
  if (!text) return { text: null, used: 'none', violations: [] };
  const v = validateExplanation(text);
  if (v.ok) return { text, used: 'llm', violations: [] };
  log.warn('explanation_discarded', { label, violations: v.violations.slice(0, 8) });
  return { text: null, used: 'discarded', violations: v.violations };
}
