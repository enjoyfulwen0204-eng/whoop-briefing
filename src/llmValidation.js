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

/** 分析層認得的指標中文名（用來偵測憑空冒出來的指標）。 */
export const KNOWN_METRIC_TERMS = [
  'HRV', '心率變異', '靜息心率', 'RHR', '恢復', '睡眠', '深睡', 'REM',
  '睡眠表現', '睡眠效率', '睡眠一致性', '睡眠債', '呼吸率', 'Strain', '負荷',
  '血氧', 'SpO2', '皮膚溫度', '體溫', '步數', 'VO2', '最大攝氧量', '體重',
  '心率', '卡路里', '熱量',
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

/**
 * 驗證一段敘述性回答。
 *
 * @param {string} answer  LLM 的回答
 * @param {string} context 送給它的 evidence context（唯一的事實來源）
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
