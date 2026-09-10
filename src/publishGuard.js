/**
 * 發布邊界：結構化事實 → 敘述（R2-H-02）。
 *
 * ## 不變量
 *
 *   **LLM 不是生理事實的權威。**
 *   被發布的生理宣稱一律來自已驗證的結構化事實。
 *
 * ## 為什麼要換掉上一輪的做法
 *
 * 上一輪問的是「這個數字在 evidence context 這段**文字**裡出現過嗎」，
 * 歸屬則靠「數字有不有緊貼指標名」。兩者都在列舉措辭，所以獨立稽核用
 * 改寫就繞過了 13/22（逗號斷開鄰接、數字放前面、英文指標名、中文數字、
 * WHOOP Age 的各種改寫……）。
 *
 * 這個模組把方向反過來：**先有權威事實，再要求敘述裡的每一個數值宣稱
 * 都能歸屬到其中一筆**。歸屬不到就不發布。判準因此不依賴「列出所有不能
 * 說的句子」，而依賴「這次算出了哪些事實」—— 那是一份我們自己產生的、
 * 有限的、確定性的清單。
 *
 * ## 四條規則
 *
 * R1 數字閉合
 *    敘述裡的每一個數字都必須歸屬到：某筆事實的值（±容差）、該事實的
 *    支援值（基準、樣本數、顯示字串裡的數字）、或這組事實的結構性數字
 *    （日期、窗口天數、z 值…）。歸屬不到 → 違規。
 *
 * R2 指標歸屬
 *    一個數字要歸給**句子裡距離最近的指標名**。歸屬到的那個指標必須
 *    允許這個數字。這一條不看鄰接、不看語序、不看標點，所以
 *    「今天的恢復，99%」與「99% 的恢復」與「Recovery is 99%」都一樣被擋。
 *
 * R3 封閉詞彙表
 *    系統知道自己能算哪些指標。敘述提到一個**這次沒有算出來**的指標
 *    → 違規。提到 WHOOP Age / Healthspan 這種永不可發布的衍生分數
 *    → 光是提起就違規（不必猜它被怎麼改寫）。
 *
 * R4 語言規則
 *    強因果、醫學診斷、宣稱即時生理數值、治療／用藥指示。
 *    這一組沿用既有的 llmValidation 規則（它們是**非數值**的類別宣稱，
 *    數字閉合抓不到），但它們已經不是數值防護的唯一依靠。
 *
 * ## Fail closed
 *
 * 任何一條違規 → 原文一個字都不送出，改用呼叫端提供的確定性 fallback。
 * 沒有事實集、事實集是空的、敘述是空的 → 一律不發布。
 */

import {
  ALL_METRIC_TERMS, TERM_TO_METRIC, NEVER_PUBLISHABLE, NUMBER_TOLERANCE,
} from './publishableFacts.js';
import { normalizeNumberWords } from './numberWords.js';
import {
  CAUSAL_PATTERNS, DIAGNOSIS_PATTERNS, LIVE_CLAIM_PATTERNS, TREATMENT_PATTERNS,
} from './llmValidation.js';
import { log } from './logger.js';

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 句子邊界：只用強標點。逗號**不算**，否則「恢復，99%」會被拆開而逃過歸屬。 */
const SENTENCE_SPLIT = /[。！？!?；;\n]+|(?<=[.!?])\s+/;

const METRIC_TERM_RE = new RegExp(`(${ALL_METRIC_TERMS.map(escapeRe).join('|')})`, 'gi');
const NUMBER_RE = /-?\d+(?:\.\d+)?/g;

/**
 * 治療指示的**文法**規則（不是藥名清單）。
 *
 * 「建議／可以／應該 + 吃／服用／補充／施打 + <東西>」是一個處置指示。
 * 只有當受詞落在一份**很小而穩定的生活作息白名單**裡時才放行 ——
 * 這樣新藥名、罕見藥名、外文藥名都不需要被列舉。
 *
 * 反過來列舉（列出所有藥名）永遠列不完；列舉「可以建議吃的東西」
 * 則是一份我們自己定義、幾乎不會變的清單。
 */
const TREATMENT_VERB = '服用|吃|喝|補充|注射|施打|塗|敷';
const SAFE_INGESTIBLE = [
  '水', '溫水', '開水', '早餐', '午餐', '晚餐', '正餐', '飯', '東西', '點東西',
  '蔬菜', '水果', '青菜', '蛋白質', '碳水', '食物', '宵夜', '咖啡', '茶',
  '電解質', '運動飲料', '牛奶', '豆漿', '維他命', '維生素',
];
const SAFE_EN = [
  'water', 'breakfast', 'lunch', 'dinner', 'a meal', 'food', 'fluids',
  'electrolytes', 'protein', 'vegetables', 'fruit', 'coffee', 'tea', 'a break',
  'a rest', 'a nap', 'a walk', 'it easy',
];

const ZH_TREATMENT_RE = new RegExp(
  `(?:建議|可以|應該|不妨|記得|試試|要)\\s*(?:你|妳)?\\s*(?:${TREATMENT_VERB})`
  + '\\s*(?:一點|一些|一顆|一片|兩顆|半顆|幾顆)?\\s*([^\\s。，、；：！？,.;:!?]{1,8})',
  'g',
);
const EN_TREATMENT_RE = new RegExp(
  '\\b(?:should|recommend|suggest|try|need to|ought to)\\s+'
  + '(?:taking|take|taking\\s+some|drink|drinking|apply|inject)\\s+'
  + '(?:a|an|some|the)?\\s*([a-z][a-z\\s-]{0,20})',
  'gi',
);

/**
 * 治療／處置指示的**文法**判斷，不是藥名清單。
 *
 * 「建議 + 吃／服用／補充 + <受詞>」是一個處置指示。只有當受詞落在一份
 * **很小而穩定的生活作息白名單**裡時才放行 —— 這樣新藥名、罕見藥名、
 * 外文藥名都不需要被列舉。
 *
 * 反過來列舉（列出所有藥名）永遠列不完，而且獨立稽核已經證明了這一點：
 * 上一輪的清單有褪黑激素、安眠藥、抗生素，卻沒有阿斯匹靈 / aspirin。
 * 列舉「可以建議吃的東西」則是一份我們自己定義、幾乎不會變的清單。
 *
 * 刻意用程式判斷而不是純 regex 的負向預查：regex 的回溯會讓
 * 「補充一點水」在「水」被白名單擋下後退回去用「一」重新匹配成功。
 */
function detectTreatmentInstruction(text) {
  for (const m of String(text).matchAll(ZH_TREATMENT_RE)) {
    const object = m[1] ?? '';
    if (SAFE_INGESTIBLE.some((safe) => object.startsWith(safe))) continue;
    return `處置指示:${object.slice(0, 8)}`;
  }
  for (const m of String(text).matchAll(EN_TREATMENT_RE)) {
    const object = (m[1] ?? '').trim().toLowerCase();
    if (SAFE_EN.some((safe) => object.startsWith(safe))) continue;
    return `treatment_instruction:${object.slice(0, 16)}`;
  }
  return null;
}

/**
 * 診斷式的病名標籤。
 *
 * 「症候群」「失調」「障礙」在中文裡**只**用來指一個臨床診斷，所以
 * 提起就是診斷宣稱。刻意不含「症狀」—— 那是「如果有不舒服的症狀就去看
 * 醫師」這種正確且必要的提醒會用到的字。
 */
const DIAGNOSTIC_LABEL_RE = /症候群|症候羣|失調|障礙|\bsyndrome\b|\bdisorder\b/i;

/**
 * 有些指標名在中文裡同時是**常用動詞**，最典型的是「恢復」：
 *
 *   「你的恢復 55%」      → 指標
 *   「兩三天內會恢復」    → 動詞（to recover）
 *   「已經恢復了」        → 動詞
 *
 * 把動詞用法當成指標宣稱會誤擋完全正常的教練文字。判準是它前後的
 * 語法標記，不是語意猜測：前面接助動詞／副詞（會、能、可以、已經、
 * 慢慢、逐漸、開始…）或後面接動詞尾（了、過來、得）就是動詞。
 *
 * 這只影響「這個詞算不算一次指標提及」；只要它真的帶著一個數值，
 * 前面的助動詞就不會出現，所以攻擊面沒有被放寬。
 */
const VERB_CONTEXT = {
  恢復: {
    before: /(?:會|能|夠|可以|已經|慢慢|逐漸|開始|快|難以|沒有|還沒|尚未|完全)\s*$/,
    after: /^(?:了|過來|得|不了|起來)/,
  },
};

/** 一個句子裡的指標出現位置（排除明顯的動詞用法）。 */
function metricsIn(sentence) {
  const out = [];
  for (const m of sentence.matchAll(METRIC_TERM_RE)) {
    const key = TERM_TO_METRIC.get(m[1].toLowerCase());
    if (!key) continue;
    const rule = VERB_CONTEXT[m[1]];
    if (rule) {
      const before = sentence.slice(Math.max(0, m.index - 6), m.index);
      const after = sentence.slice(m.index + m[1].length, m.index + m[1].length + 4);
      if (rule.before.test(before) || rule.after.test(after)) continue;
    }
    out.push({ key, term: m[1], index: m.index });
  }
  return out;
}

/**
 * 這個數字該歸給哪個指標。
 *
 * 中文與英文都是「指標在前、數值在後」（恢復 55%／Recovery is 99%），
 * 所以**只要句子裡有指標出現在數字之前，就取最近的那一個**；
 * 一個都沒有時才往後找（「99% 的恢復」）。
 *
 * 這一條很關鍵：如果只比字元距離，
 * 「恢復 55%，比 30 天基準 62% 低；睡眠表現 99%」裡的 62 會被歸給後面的
 * 睡眠表現而誤判 —— 62 其實是恢復的基準。
 */
function nearestMetric(metrics, index) {
  if (!metrics.length) return null;
  let before = null;
  for (const m of metrics) {
    if (m.index <= index && (before === null || m.index > before.index)) before = m;
  }
  if (before) return before;
  let after = null;
  for (const m of metrics) {
    if (m.index > index && (after === null || m.index < after.index)) after = m;
  }
  return after;
}

const near = (a, b) => Math.abs(a - b) <= NUMBER_TOLERANCE(b);

/** 這個數字被這筆事實允許嗎（值本身或它的支援值）。 */
function factAllows(f, n) {
  if (!f) return false;
  if (f.publishable && f.value !== null && near(n, f.value)) return true;
  return f.supporting.some((s) => near(n, s));
}

/**
 * 驗證一段敘述可不可以發布。
 *
 * @param {string} narrative LLM 產生的文字
 * @param {object} factSet   publishableFacts.js 建立的事實集
 * @returns {{ok:boolean, violations:string[]}}
 */
export function validatePublication(narrative, factSet) {
  const violations = [];
  const raw = String(narrative ?? '');
  if (!raw.trim()) return { ok: false, violations: ['empty_narrative'] };
  if (!factSet || !Array.isArray(factSet.facts)) {
    return { ok: false, violations: ['no_fact_set'] };
  }

  const byMetric = new Map(factSet.facts.map((f) => [f.metric, f]));
  const structural = factSet.structural ?? [];
  const allowedDates = new Set(factSet.dates ?? []);

  // 中文／英文數字詞 → 阿拉伯數字。少了這一步，「恢復是九十九%」整句
  // 沒有數字可掃，所有數值規則都會失效。
  let text = normalizeNumberWords(raw, { metricTerms: ALL_METRIC_TERMS });

  // ---- 日期要在數字掃描**之前**單獨處理 ----
  //
  // `2026-09-09` 被一般的數字掃描切成 `2026`、`-09`、`-09`（連字號被讀成
  // 負號），一個完全正確的日期會變成「無法歸屬的負數」而誤擋。
  //
  // 分開處理也才能有一條真正的規則：敘述提到的日期必須是確定性層給出的
  // 日期，否則就是編的（模型很容易編日期）。驗過的日期換成佔位符，
  // 它的數字就不會再被掃一次。
  text = text.replace(/\d{4}-\d{2}-\d{2}/g, (d) => {
    if (allowedDates.has(d)) return '<date>';
    violations.push(`unsupported_date:${d}`);
    return '<date>';
  });
  // M/D 形式（報告標頭用 8/24 這種寫法）
  text = text.replace(/\b(\d{1,2})\/(\d{1,2})\b/g, (m, mo, d) => {
    const ok = [...allowedDates].some((iso) => {
      const p = iso.split('-');
      return Number(p[1]) === Number(mo) && Number(p[2]) === Number(d);
    });
    if (!ok) violations.push(`unsupported_date:${m}`);
    return '<date>';
  });

  // ---- R4 語言規則（非數值的類別宣稱）----
  for (const { re, label } of CAUSAL_PATTERNS) {
    if (re.test(text)) violations.push(`causal_language:${label}`);
  }
  for (const { re, label } of DIAGNOSIS_PATTERNS) {
    if (re.test(text)) violations.push(`diagnosis_language:${label}`);
  }
  for (const { re, label } of LIVE_CLAIM_PATTERNS) {
    if (re.test(text)) violations.push(`live_claim:${label}`);
  }
  for (const { re, label } of TREATMENT_PATTERNS) {
    if (re.test(text)) violations.push(`treatment_advice:${label}`);
  }
  const treatment = detectTreatmentInstruction(text);
  if (treatment) violations.push(`treatment_advice:${treatment}`);
  if (DIAGNOSTIC_LABEL_RE.test(text)) violations.push('diagnosis_language:病名標籤');

  // ---- R3 封閉詞彙表 ----
  for (const m of metricsIn(text)) {
    if (NEVER_PUBLISHABLE.has(m.key)) {
      violations.push(`forbidden_metric:${m.key}:${m.term}`);
      continue;
    }
    if (!byMetric.has(m.key)) {
      violations.push(`metric_not_in_evidence:${m.key}:${m.term}`);
    }
  }

  // ---- R1 + R2 每一個數字都要能歸屬 ----
  for (const sentence of text.split(SENTENCE_SPLIT)) {
    if (!sentence.trim()) continue;
    const metrics = metricsIn(sentence);
    for (const nm of sentence.matchAll(NUMBER_RE)) {
      const n = Number(nm[0]);
      if (!Number.isFinite(n)) continue;

      const isStructural = structural.some((s) => near(n, s));
      const owner = nearestMetric(metrics, nm.index);

      if (owner) {
        const f = byMetric.get(owner.key);
        // 這個指標自己允許這個數字（值或支援值）→ 放行
        if (factAllows(f, n)) continue;
        // ⚠️ 結構性數字只有在這筆事實**明確允許**時才放行。
        //
        // 少了這個條件，「你的 HRV 是 30ms」會因為 30 剛好是基準窗天數
        // （結構性數字）而通過 —— 而 HRV 這次根本沒有資料。實測確認這
        // 正是 R2 稽核裡 A7/A8 的漏洞。
        //
        // allowsStructural 讓「關聯敘述提到 HRV 並帶上 r=-0.70、n=20」
        // 這種合法情況通得過，而「HRV 是 30ms」仍然被擋（見 fact() 的說明）。
        if (isStructural && f && f.allowsStructural) continue;
        violations.push(
          !f || !f.publishable
            ? `unpublishable_metric_value:${owner.key}:${nm[0]}`
            : `metric_value_mismatch:${owner.key}:${nm[0]}`,
        );
        continue;
      }

      // 句子裡沒有任何指標名 → 結構性數字可以出現
      if (isStructural) continue;

      // 句子裡沒有任何指標名 → 至少要歸屬到某一筆事實
      const anyFact = factSet.facts.some((f) => factAllows(f, n));
      if (!anyFact) violations.push(`unattributable_number:${nm[0]}`);
    }
  }

  return { ok: violations.length === 0, violations: [...new Set(violations)] };
}

/**
 * 驗證通過就用 LLM 的文字，否則用確定性 fallback。
 * **驗證失敗時原文一個字都不會被送出去。**
 */
export function guardPublication({ narrative, factSet, fallback = null, label = 'publish' }) {
  if (!narrative) {
    return { text: fallback, used: 'fallback', reason: 'no_narrative', violations: [] };
  }
  const v = validatePublication(narrative, factSet);
  if (v.ok) return { text: narrative, used: 'llm', violations: [] };
  log.warn('publication_blocked', { label, violations: v.violations.slice(0, 8) });
  return {
    text: fallback, used: 'fallback', reason: 'failed_validation', violations: v.violations,
  };
}
