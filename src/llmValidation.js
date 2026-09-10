/**
 * LLM 輸出驗證（Phase AB）。
 *
 * ## 兩種輸出、兩套規則
 *
 * 1. **結構化輸出**（intent / journal parser）
 *    嚴格 schema：enum、數值範圍、拒絕未知欄位。
 *    格式壞掉最多重試一次，第二次仍失敗就走確定性 fallback。
 *
 * 2. **敘述性回答**（健康問答）
 *    LLM 不得說出 evidence context 裡沒有的數字、日期、指標名稱，
 *    也不得使用強因果語言或醫學診斷措辭。
 *    驗證失敗時**不把原文送出去**，改用純 Node 排版的 fallback。
 *
 * ## 不能誤判
 *
 * 中文標點、百分比、ms、bpm、°C 這些正常格式都必須安全通過。
 * 下面每一條規則都有對應的 false-positive 測試。
 */

import { log } from './logger.js';

// ===========================================================================
// 1. 結構化輸出
// ===========================================================================

/**
 * 極簡 schema 驗證器。刻意不引入 ajv —— 這裡的 schema 很小，
 * 而且自己寫才能精準控制「拒絕未知欄位」的行為。
 *
 * spec 形如：
 *   { field: { type:'string'|'number'|'integer', enum:[...], min, max,
 *              required:bool, nullable:bool } }
 */
export function validateStructured(raw, spec, { allowUnknown = false } = {}) {
  const errors = [];
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: ['not_an_object'], value: null };
  }

  // 未知欄位一律視為錯誤：模型自己加欄位通常代表它在自由發揮
  if (!allowUnknown) {
    for (const key of Object.keys(raw)) {
      if (!(key in spec)) errors.push(`unknown_field:${key}`);
    }
  }

  const value = {};
  for (const [key, rule] of Object.entries(spec)) {
    const present = key in raw;
    const v = raw[key];

    if (!present || v === null || v === undefined) {
      if (rule.required && !rule.nullable) errors.push(`missing:${key}`);
      value[key] = null;
      continue;
    }

    if (rule.type === 'number' || rule.type === 'integer') {
      const n = typeof v === 'number' ? v : Number(v);
      if (!Number.isFinite(n)) { errors.push(`not_a_number:${key}`); value[key] = null; continue; }
      if (rule.type === 'integer' && !Number.isInteger(n)) {
        errors.push(`not_an_integer:${key}`); value[key] = null; continue;
      }
      if (rule.min !== undefined && n < rule.min) { errors.push(`below_min:${key}`); value[key] = null; continue; }
      if (rule.max !== undefined && n > rule.max) { errors.push(`above_max:${key}`); value[key] = null; continue; }
      value[key] = n;
      continue;
    }

    if (rule.type === 'string') {
      if (typeof v !== 'string') { errors.push(`not_a_string:${key}`); value[key] = null; continue; }
      const sv = v.trim();
      if (rule.enum && !rule.enum.includes(sv)) {
        errors.push(`invalid_enum:${key}:${sv.slice(0, 40)}`);
        value[key] = null;
        continue;
      }
      if (rule.maxLength && sv.length > rule.maxLength) {
        value[key] = sv.slice(0, rule.maxLength);
        continue;
      }
      value[key] = sv;
      continue;
    }

    value[key] = v;
  }

  return { ok: errors.length === 0, errors, value: errors.length === 0 ? value : null };
}

/**
 * 呼叫 LLM 拿結構化輸出，最多重試一次，仍失敗就交給確定性 fallback。
 *
 * @param {function} call        () => Promise<object|null>  真正打 LLM
 * @param {object}   spec        validateStructured 的 schema
 * @param {function} fallbackFn  () => any  兩次都失敗時用這個
 */
export async function structuredWithRetry({
  call, spec, fallbackFn, label = 'structured', allowUnknown = false,
}) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    let raw = null;
    try {
      raw = await call(attempt);
    } catch (err) {
      log.warn('llm_structured_call_failed', {
        label, attempt, error: String(err?.message ?? err).slice(0, 200),
      });
    }

    if (raw) {
      const v = validateStructured(raw, spec, { allowUnknown });
      if (v.ok) return { ok: true, value: v.value, attempts: attempt, usedFallback: false };
      log.warn('llm_structured_invalid', { label, attempt, errors: v.errors.slice(0, 5) });
    } else {
      log.warn('llm_structured_unparsable', { label, attempt });
    }
  }

  log.warn('llm_structured_fallback', { label });
  return {
    ok: false,
    value: fallbackFn ? fallbackFn() : null,
    attempts: 2,
    usedFallback: true,
  };
}

// ===========================================================================
// 2. 敘述性回答
// ===========================================================================

/**
 * 強因果語言。
 *
 * 「一定」要特別小心：「一定要早點睡」是祈使句不是因果宣稱，
 * 只有「一定是 / 一定會 / 一定有」才是在斷言必然性。
 */
export const CAUSAL_PATTERNS = [
  { re: /一定(?=[是會有])/, label: '一定' },
  { re: /必然/, label: '必然' },
  { re: /肯定(?=[是會有])/, label: '肯定' },
  { re: /證明/, label: '證明' },
  { re: /導致/, label: '導致' },
  { re: /造成/, label: '造成' },
  { re: /因果關係/, label: '因果關係' },
  { re: /\bdefinitely\b/i, label: 'definitely' },
  { re: /\bprove[sd]?\b/i, label: 'proves' },
  { re: /\bcause[sd]?\b/i, label: 'causes' },
  { re: /\bguarantee[sd]?\b/i, label: 'guarantees' },
];

/**
 * 醫學診斷措辭。
 *
 * 只攔「斷言你有某個病」的說法，不攔「如果你覺得不舒服就去看醫生」
 * 這種正確且必要的提醒。
 */
export const DIAGNOSIS_PATTERNS = [
  { re: /你(?:應該|可能|大概)?(?:得了|患有|罹患|感染了)/, label: '診斷式措辭' },
  { re: /確診/, label: '確診' },
  { re: /診斷(?![^。]*醫)/, label: '診斷' },
  { re: /\bdiagnos(?:is|ed|e)\b/i, label: 'diagnosis' },
  { re: /你有(?:某種)?(?:疾病|感染|發炎)/, label: '斷言疾病' },
];

/**
 * 宣稱「即時／現在」的生理數值。
 *
 * WHOOP 官方 Developer API v2 **沒有**連續或即時的生理訊號 endpoint：
 * 這個系統看得到的永遠是已經同步進來的歷史紀錄（最快也是幾十分鐘前）。
 * 所以任何「你現在的心率是…」「偵測到你此刻…」都必然是捏造的，
 * 不管數字本身有沒有出處都要擋。
 *
 * 刻意只攔「即時性副詞 + 生理名詞」的組合，不攔「今天」「最近」
 * 這種正確的回顧性描述。
 */
const LIVE_METRIC = '心率|心跳|HRV|心率變異|血氧|體溫|呼吸率';
export const LIVE_CLAIM_PATTERNS = [
  // 「現在的心率」「目前 HRV」——即時副詞直接修飾一個生理量
  { re: new RegExp(`(現在|目前|此刻|當下)的?\\s*(${LIVE_METRIC})`), label: '宣稱即時生理數值' },
  // 「心率現在是 135」——生理量 + 即時副詞 + 斷言動詞
  { re: new RegExp(`(${LIVE_METRIC})\\s*(現在|目前|此刻|當下)\\s*(是|為|達到|高達|偏|有)`), label: '宣稱即時生理數值' },
  { re: /即時(心率|心跳|監測|數據|生理)/, label: '宣稱即時監測' },
  { re: /偵測到你(現在|此刻|正在|目前)/, label: '宣稱即時偵測' },
  { re: /\b(real[- ]?time|live)\b[^.\n]{0,20}\b(heart rate|hr|hrv)\b/i, label: 'real-time claim' },
];

/** 分析層認得的指標中文名（用來偵測憑空冒出來的指標）。 */
export const KNOWN_METRIC_TERMS = [
  'HRV', '心率變異', '靜息心率', 'RHR', '恢復', '睡眠', '深睡', 'REM',
  '睡眠表現', '睡眠效率', '睡眠一致性', '睡眠債', '呼吸率', 'Strain', '負荷',
  '血氧', 'SpO2', '皮膚溫度', '體溫', '步數', 'VO2', '最大攝氧量', '體重',
  '心率', '卡路里', '熱量',
];

/**
 * 專有 / 衍生分數的宣稱（H-02）。
 *
 * 這幾個東西**在任何情況下都不可能**由 LLM 敘述出來：
 *
 *  - WHOOP Age / WHOOP Healthspan：WHOOP App 專有演算法，官方 Developer
 *    API 根本沒有這個欄位（capabilities.js 標成 APP_ONLY）。任何數字都是編的。
 *  - Personal Healthspan 分數 / 推估生理年齡：本系統自己的框架**刻意**
 *    永遠回 null（healthspanPolicy.js 的三道閘門）。所以敘述層出現一個
 *    數字，必然與確定性層矛盾。
 *
 * 這些不是「數字有沒有出處」的問題，是「這個宣稱本身不該存在」，
 * 所以獨立成一組硬性攔截，不走數字比對。
 */
export const PROPRIETARY_CLAIM_PATTERNS = [
  { re: /WHOOP\s*Age/i, label: 'WHOOP Age' },
  { re: /WHOOP\s*Healthspan/i, label: 'WHOOP Healthspan' },
  { re: /(?:身體|生理|體能)年齡/, label: '生理年齡' },
  { re: /推估年齡/, label: '推估年齡' },
  { re: /\bEstimated\s+(?:Physiological\s+)?Age\b/i, label: 'Estimated Age' },
  { re: /Healthspan\s*(?:Score|分數)/i, label: 'Healthspan Score' },
  { re: /Pace\s*Estimate/i, label: 'Pace Estimate' },
];

/**
 * 治療 / 用藥指示（H-02）。
 *
 * 既有的 DIAGNOSIS_PATTERNS 只攔「斷言你有某個病」，完全沒有攔「你該吃
 * 什麼」。但給出劑量或用藥建議比誤判疾病更危險，而且這個系統沒有任何
 * 立場提供醫療處置。
 *
 * 刻意**不**攔「建議你早點睡」「多喝水」這類生活作息建議——那是這個
 * 產品本來就該做的事。只攔藥物 / 補劑 / 劑量 / 就醫處置。
 */
export const TREATMENT_PATTERNS = [
  { re: /(?:服用|吃|補充|注射|施打)\s*\S{0,12}?(?:藥|錠|膠囊|mg|毫克|IU|劑量)/, label: '用藥指示' },
  { re: /(?:褪黑激素|安眠藥|抗生素|止痛藥|類固醇|退燒藥|鎮定劑)/, label: 'specific medication' },
  { re: /\b\d+\s*(?:mg|mcg|IU)\b/i, label: '劑量' },
  { re: /\b(?:prescri(?:be|ption)|dosage|medication|antibiotics?)\b/i, label: 'medication advice' },
  { re: /建議你(?:去)?(?:打針|吃藥|停藥|加藥|減藥)/, label: '處置指示' },
];

/** 帶單位的數字，或小數 —— 這些才是「測量值」，才需要有出處。 */
const MEASUREMENT_RE = /(\d+(?:\.\d+)?)\s*(%|％|ms|毫秒|bpm|°C|℃|度|分鐘|分|小時|h|kg|公斤|次|天)/gi;
const DECIMAL_RE = /\b\d+\.\d+\b/g;
const DATE_RE = /\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}/g;

/** 從 evidence context 抽出所有「被允許」的數字。 */
export function allowedNumbersFrom(context) {
  const set = new Set();
  const add = (n) => {
    if (!Number.isFinite(n)) return;
    set.add(n);
    set.add(Math.round(n));                       // 模型常會四捨五入
    set.add(Math.round(n * 10) / 10);
    set.add(Math.abs(n));
    set.add(Math.round(Math.abs(n)));
    set.add(Math.round(Math.abs(n) * 10) / 10);
  };
  for (const m of String(context ?? '').matchAll(/-?\d+(?:\.\d+)?/g)) add(Number(m[0]));
  return set;
}

/** 這個數字有沒有出處（允許四捨五入誤差）。 */
function isSupported(value, allowed) {
  if (allowed.has(value)) return true;
  for (const a of allowed) {
    const tol = Math.max(0.05, Math.abs(a) * 0.02);  // 2% 或至少 0.05
    if (Math.abs(a - value) <= tol) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// 指標 ↔ 數值綁定（H-02 的核心修正）
// ---------------------------------------------------------------------------

/**
 * ## 為什麼「數字有沒有出處」根本不夠
 *
 * 舊版把 context 裡**所有**數字倒進同一個集合，然後只問「這個數字有沒有
 * 出現過」。於是任何數字都可以被安到任何指標上：
 *
 *   context: 恢復 55%、睡眠表現 99%、基準 30/30 筆
 *   answer : 「你今天的恢復是 99%」        → 通過（99 來自睡眠表現）
 *   answer : 「你的 HRV 是 30ms」          → 通過（30 來自基準窗天數）
 *
 * 兩句話都是**捏造的生理數值**，但每個數字都「有出處」。實測 11 個對抗
 * 樣本中有 8 個被放行。
 *
 * 正確的問題不是「這個數字存在嗎」，而是
 * **「這個數字被綁在這個指標上嗎」**。
 *
 * 所以這裡把 context 解析成 `指標 → 允許的數值集合`，答案端也用同樣的
 * 方式抽出「指標 + 貼著它的數值」，然後逐一比對。
 */
// 長的指標名必須排在前面，否則 `睡眠` 會先吃掉 `睡眠表現`。
const METRIC_ALTERNATION = [...KNOWN_METRIC_TERMS]
  .sort((a, b) => b.length - a.length)
  .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  .join('|');

/**
 * 指標名與它的數值之間允許出現的連接詞。
 *
 * 刻意**只列舉安全的字**，不用 `.{0,6}` 這種萬用 filler：萬用 filler 會
 * 跨過另一個指標名，把「HRV 偏低、恢復 55%」錯讀成 `HRV → 55`。
 * 這個字集裡沒有任何數字、也沒有任何指標名的片段。
 */
const BINDING_CONNECTOR = '(?:\\s|是|為|有|達到|達|約|大約|在|到|的|：|:|=|分數|指數|數值|值)*';

/** 指標名 → 緊跟其後的數值。 */
const BINDING_RE = new RegExp(
  `(${METRIC_ALTERNATION})${BINDING_CONNECTOR}(-?\\d+(?:\\.\\d+)?)`,
  'gi',
);

/** 正規化指標名，讓 HRV / hrv、RHR / 靜息心率 之類的同義詞落到同一個 key。 */
const METRIC_ALIASES = new Map([
  ['hrv', 'hrv'], ['心率變異', 'hrv'],
  ['rhr', 'rhr'], ['靜息心率', 'rhr'],
  ['spo2', 'spo2'], ['血氧', 'spo2'],
  ['皮膚溫度', 'temp'], ['體溫', 'temp'],
  ['vo2', 'vo2'], ['最大攝氧量', 'vo2'],
  ['strain', 'strain'], ['負荷', 'strain'],
  ['卡路里', 'kcal'], ['熱量', 'kcal'],
]);
const normalizeMetric = (term) => {
  const k = String(term).toLowerCase();
  return METRIC_ALIASES.get(k) ?? k;
};

/** 把一個值連同它的四捨五入變體塞進集合（與 allowedNumbersFrom 同一套寬容度）。 */
function addRounded(set, n) {
  if (!Number.isFinite(n)) return;
  set.add(n);
  set.add(Math.round(n));
  set.add(Math.round(n * 10) / 10);
  set.add(Math.abs(n));
  set.add(Math.round(Math.abs(n)));
  set.add(Math.round(Math.abs(n) * 10) / 10);
}

/**
 * 可信 context → `Map<正規化指標, Set<允許數值>>`。
 *
 * ⚠️ 呼叫端必須傳**確定性事實**。使用者的原話不是證據，絕不可以混進來
 * （見 validateNarrative 的 USER TEXT IS NOT EVIDENCE 說明）。
 */
export function metricBindingsFrom(context) {
  const out = new Map();
  for (const m of String(context ?? '').matchAll(BINDING_RE)) {
    const key = normalizeMetric(m[1]);
    const n = Number(m[2]);
    if (!Number.isFinite(n)) continue;
    if (!out.has(key)) out.set(key, new Set());
    addRounded(out.get(key), n);
  }
  return out;
}

/** 答案裡出現的「指標 + 貼著它的數值」。 */
export function metricClaimsIn(text) {
  const claims = [];
  for (const m of String(text ?? '').matchAll(BINDING_RE)) {
    const n = Number(m[2]);
    if (!Number.isFinite(n)) continue;
    claims.push({ term: m[1], key: normalizeMetric(m[1]), value: n, raw: m[0].trim() });
  }
  return claims;
}

/**
 * 驗證一段敘述性回答。
 *
 * ## USER TEXT IS NOT EVIDENCE
 *
 * `context` 是**唯一**的事實來源，而且它必須只包含確定性 / 統計層算出來的
 * 事實。使用者自己打的字（問題、Journal 原文、任何轉述）**不是證據**：
 * 只要它被混進 context，使用者就可以自己授權自己的健康宣稱——
 *
 *   問題：「我的 HRV 是 999ms 對嗎？」
 *   → 舊版把問題塞進 context → 999 變成「有出處的數字」
 *   → 回答「你的 HRV 999ms 偏高」通過驗證
 *
 * 呼叫端（bot/answer.js 的 composeAnswer）因此把「給模型看的 prompt」與
 * 「用來驗證的可信事實」拆成兩個字串，只把後者傳進來。
 *
 * @param {string} answer  LLM 的回答
 * @param {string} context 可信事實（**不含**使用者原話）
 */
export function validateNarrative(answer, context, {
  checkNumbers = true, checkMetrics = true,
} = {}) {
  const problems = [];
  const text = String(answer ?? '');
  if (!text.trim()) return { ok: false, problems: ['empty_answer'] };

  // --- 強因果語言 ---
  for (const { re, label } of CAUSAL_PATTERNS) {
    if (re.test(text)) problems.push(`causal_language:${label}`);
  }

  // --- 醫學診斷措辭 ---
  for (const { re, label } of DIAGNOSIS_PATTERNS) {
    if (re.test(text)) problems.push(`diagnosis_language:${label}`);
  }

  // --- 宣稱即時生理數值（這個系統結構上不可能知道）---
  for (const { re, label } of LIVE_CLAIM_PATTERNS) {
    if (re.test(text)) problems.push(`live_claim:${label}`);
  }

  // --- 專有 / 衍生分數：不管數字有沒有出處，這個宣稱本身就不該存在 ---
  for (const { re, label } of PROPRIETARY_CLAIM_PATTERNS) {
    if (re.test(text)) problems.push(`proprietary_claim:${label}`);
  }

  // --- 治療 / 用藥指示 ---
  for (const { re, label } of TREATMENT_PATTERNS) {
    if (re.test(text)) problems.push(`treatment_advice:${label}`);
  }

  // --- 沒有出處的數字 ---
  if (checkNumbers) {
    const allowed = allowedNumbersFrom(context);
    const seen = new Set();

    for (const m of text.matchAll(MEASUREMENT_RE)) {
      const n = Number(m[1]);
      if (seen.has(n)) continue;
      seen.add(n);
      if (!isSupported(n, allowed)) problems.push(`unsupported_number:${m[0].trim()}`);
    }
    for (const m of text.matchAll(DECIMAL_RE)) {
      const n = Number(m[0]);
      if (seen.has(n)) continue;
      seen.add(n);
      if (!isSupported(n, allowed)) problems.push(`unsupported_number:${m[0]}`);
    }
    // 日期一定要有出處（模型很容易編日期）
    const ctx = String(context ?? '');
    for (const m of text.matchAll(DATE_RE)) {
      if (!ctx.includes(m[0])) problems.push(`unsupported_date:${m[0]}`);
    }

    // --- ★ 指標 ↔ 數值綁定 ---
    // 上面那圈只問「這個數字在 context 裡出現過嗎」，任何數字都能被安到
    // 任何指標上（恢復 55%、睡眠表現 99% → 「恢復 99%」通過）。
    // 這裡改問「這個數字被綁在**這個**指標上嗎」，fail-closed：
    // 指標在可信事實裡沒有任何數值 → 答案就不可以給它一個數值。
    const bindings = metricBindingsFrom(context);
    for (const claim of metricClaimsIn(text)) {
      const allowedForMetric = bindings.get(claim.key);
      if (!allowedForMetric) {
        problems.push(`unsupported_metric_value:${claim.raw}`);
      } else if (!isSupported(claim.value, allowedForMetric)) {
        problems.push(`metric_value_mismatch:${claim.raw}`);
      }
    }
  }

  // --- 憑空冒出來的指標 ---
  if (checkMetrics) {
    const ctx = String(context ?? '');
    for (const term of KNOWN_METRIC_TERMS) {
      const inAnswer = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(text);
      if (!inAnswer) continue;
      const inContext = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(ctx);
      if (!inContext) problems.push(`unsupported_metric:${term}`);
    }
  }

  return { ok: problems.length === 0, problems };
}

/**
 * 驗證通過就用 LLM 的回答，否則用 fallback。
 * **驗證失敗時原文絕不會被送出去。**
 */
export function guardNarrative({ answer, context, fallback, label = 'qa' }) {
  if (!answer) return { text: fallback, used: 'fallback', reason: 'no_answer' };
  const v = validateNarrative(answer, context);
  if (v.ok) return { text: answer, used: 'llm', problems: [] };

  log.warn('narrative_validation_failed', { label, problems: v.problems.slice(0, 6) });
  return { text: fallback, used: 'fallback', reason: 'validation_failed', problems: v.problems };
}
