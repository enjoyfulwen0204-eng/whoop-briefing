/**
 * Intent 判定。
 *
 * ## 兩層，順序不可顛倒
 *
 *   1. **確定性**：指令與關鍵字。免費、瞬間、可測、不會漂移。
 *   2. **LLM fallback**：只有第 1 層認不出來時才呼叫，而且只做
 *      「自然語言 → 結構化提案」。它的輸出**一定**要過 validateIntent。
 *
 * LLM 永遠不會拿到資料庫，也不會決定要算什麼數字 —— 它只說「使用者大概想問這個」。
 */

import { AI_PURPOSE, PROMPT_VERSIONS } from '../config.js';
import { structuredWithRetry } from '../llmValidation.js';

export const INTENTS = [
  'today_status',    // 我今天狀態怎樣
  'trend_query',     // 最近 HRV 如何 / recovery 趨勢
  'sleep_quality',   // 最近睡眠有沒有變差
  'best_worst_day',  // 最近 30 天最好是哪一天
  'what_changed',    // 今天最值得注意的是什麼
  'data_status',     // 資料同步狀況
  'journal_log',     // 記一筆 journal
  /**
   * 問「現在心跳幾下」「心跳怎麼那麼快」—— 也就是**即時心率**。
   *
   * 這個系統拿得到的心率只有：recovery 的靜息心率、已完成 cycle 的平均／最高
   * 心率、運動的心率、profile 的最大心率。**沒有**即時心率串流。
   *
   * 以前沒有這個意圖，於是分類器被迫在現有詞彙裡挑一個最像的 → 挑了 rhr，
   * 結果系統把「靜息心率 54」當成使用者「現在的心跳」回答出去。那是錯的，
   * 而且是會誤導人的那種錯。寧可明講拿不到，也不要拿別的數字頂替。
   */
  'current_hr',
  'unknown',
];

export const METRIC_KEYWORDS = {
  hrv: [/hrv/i, /心率變異/],
  rhr: [/rhr/i, /靜息心率/, /resting/i],
  recovery: [/recovery/i, /恢復/],
  sleep_total: [/睡眠時長/, /睡多久/, /sleep duration/i],
  deep_sleep: [/深睡/, /deep sleep/i],
  rem_sleep: [/\brem\b/i],
  previous_day_strain: [/strain/i, /負荷/],
  respiratory_rate: [/呼吸率/, /respiratory/i],
  sleep_debt: [/睡眠債/, /sleep debt/i],
  spo2: [/血氧/, /spo2/i],
  skin_temp: [/皮膚溫度/, /skin temp/i],
};

/** `/cmd args...` → { command, args, argsText }。不是指令回 null。 */
export function parseCommand(text) {
  const m = String(text ?? '').trim().match(/^\/([a-zA-Z_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/);
  if (!m) return null;
  const argsText = (m[2] ?? '').trim();
  return {
    command: m[1].toLowerCase(),
    argsText,
    args: argsText ? argsText.split(/\s+/) : [],
  };
}

/** 從句子裡抓時間窗（天）。抓不到回 null。 */
export function extractWindowDays(text) {
  const t = String(text ?? '');
  // ⚠️ 不可以在「天」後面加 \b —— \b 是用 [A-Za-z0-9_] 定義的，
  // CJK 字元不是 \w，所以 /天\b/ 在字串結尾永遠不成立（「最近 7 天」會解析失敗）。
  // 中文用 (?!\d) 防止吃到 9999 的一部分；英文才用 \b。
  const m = t.match(/(?:最近|past|last)?\s*(\d{1,3})\s*(?:天(?!\d)|days?\b|d\b)/i);
  if (m) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n >= 1 && n <= 365) return n;
  }
  if (/(這週|本週|this week)/i.test(t)) return 7;
  if (/(這個月|本月|this month)/i.test(t)) return 30;
  return null;
}

/** 抓指標。抓不到回 null。 */
export function extractMetric(text) {
  const t = String(text ?? '');
  for (const [metric, patterns] of Object.entries(METRIC_KEYWORDS)) {
    if (patterns.some((re) => re.test(t))) return metric;
  }
  return null;
}

/**
 * 確定性 intent 判定。認不出來回 null（交給 LLM fallback）。
 */
export function deterministicIntent(text) {
  const t = String(text ?? '').trim();
  if (!t) return null;

  const metric = extractMetric(t);
  const windowDays = extractWindowDays(t);

  // 最好 / 最差的一天
  if (/(最好|最佳|最差|最糟|best|worst)/i.test(t) && /(哪一?天|哪天|day)/i.test(t)) {
    return {
      intent: 'best_worst_day',
      metric: metric ?? 'recovery',
      window_days: windowDays ?? 30,
      source: 'deterministic',
    };
  }

  // 即時心率。**必須排在其他心率規則之前** —— 否則「現在心跳很快」會被
  // 當成靜息心率的查詢，然後拿 RHR 頂替回答。
  //
  // 判準：提到心跳/心率/bpm，而且**沒有**明講靜息/RHR，再加上
  // 「現在」或「跳很快」這類當下語氣。明確講靜息心率的一律讓給 rhr。
  if (/(心跳|心率|脈搏|bpm|heart\s*rate|heartbeat|pulse|heart(?=\s+(?:is\s+)?racing))/i.test(t)
      && !/(靜息|rhr|resting)/i.test(t)
      && /(現在|目前|此刻|當下|剛剛|now|current|很快|太快|那麼快|狂跳|亂跳|加速|飆|fast|racing)/i.test(t)) {
    return { intent: 'current_hr', source: 'deterministic' };
  }

  // 今天最值得注意
  if (/(值得注意|最需要注意|what changed|有什麼變化|異常)/i.test(t)) {
    return { intent: 'what_changed', source: 'deterministic' };
  }

  // 睡眠整體
  if (/(睡眠|睡得|sleep)/i.test(t) && /(怎樣|如何|好嗎|變差|變好|品質|how)/i.test(t) && !metric) {
    return { intent: 'sleep_quality', window_days: windowDays ?? 30, source: 'deterministic' };
  }

  // 今天狀態。**必須排在趨勢判斷之前** ——「今天恢復如何」問的是今天，
  // 不是趨勢；若讓趨勢規則先跑，只要句子裡有指標就會被吃掉。
  //
  // 另外刻意要求同時出現「健康語境詞」：只靠「今天…如何」會把
  // 「今天天氣如何」這種完全無關的句子誤判成健康查詢。
  // 確定性這一層寧可漏判（交給 LLM fallback），也不要誤判。
  if (/(今天|今日|現在|目前|today)/i.test(t)
      && /(狀態|身體|恢復|感覺|status|recovery)/i.test(t)
      && !/(最近|趨勢|trend|recent|這幾天|過去)/i.test(t)) {
    return { intent: 'today_status', source: 'deterministic' };
  }

  // 趨勢：有指標 + 有「最近/趨勢」語氣
  if (metric && /(最近|趨勢|trend|變化|下降|上升|怎樣|如何|recent)/i.test(t)) {
    return {
      intent: 'trend_query',
      metric,
      window_days: windowDays ?? 30,
      source: 'deterministic',
    };
  }

  // 資料狀況
  if (/(資料|數據|同步|sync|data).*(狀態|多少|有嗎|status)/i.test(t)) {
    return { intent: 'data_status', source: 'deterministic' };
  }

  // 只提到一個指標，沒有其他線索 → 當成趨勢查詢
  if (metric) {
    return { intent: 'trend_query', metric, window_days: windowDays ?? 30, source: 'deterministic' };
  }

  return null;
}

const INTENT_SET = new Set(INTENTS);

/**
 * 驗證 LLM 回來的 intent 提案。
 * **任何不合法的東西一律丟掉** —— 寧可回 unknown，也不要照著幻覺去查。
 */
export function validateIntent(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const intent = String(raw.intent ?? '').toLowerCase();
  if (!INTENT_SET.has(intent) || intent === 'unknown') return null;

  let windowDays = raw.window_days ?? raw.windowDays ?? null;
  if (windowDays !== null && windowDays !== undefined) {
    windowDays = Number(windowDays);
    if (!Number.isFinite(windowDays) || windowDays < 1 || windowDays > 365) windowDays = null;
  }

  const metric = raw.metric ? String(raw.metric).toLowerCase() : null;

  return {
    intent,
    metric,
    window_days: windowDays,
    source: 'llm',
  };
}

export const INTENT_SYSTEM_PROMPT = `你是一個意圖分類器。使用者會用中文或英文問健康數據相關的問題。
你只需要輸出一個 JSON 物件，不要任何其他文字、不要 markdown 圍欄。

格式：
{"intent": "<intent>", "metric": "<metric or null>", "window_days": <number or null>}

intent 只能是下列其中一個：
- today_status：問今天/現在的整體狀態
- trend_query：問某個指標最近的走勢
- sleep_quality：問睡眠整體好壞
- best_worst_day：問某段期間內最好或最差的一天
- what_changed：問今天有什麼值得注意的變化
- data_status：問資料同步/涵蓋狀況
- current_hr：問**現在/當下**的心跳、心率、脈搏、bpm（例如「我心跳怎麼那麼快」
  「現在心率多少」）。注意：明確問「靜息心率 / RHR」的**不是**這一類，
  那是 trend_query + metric=rhr。
- unknown：以上都不是

metric 只能是：hrv, rhr, recovery, sleep_total, deep_sleep, rem_sleep,
previous_day_strain, respiratory_rate, sleep_debt, spo2, skin_temp，或 null。

window_days 是 1 到 365 的整數，沒有提到就給 null。

★ 如果使用者問的是「現在的心跳」，一定要用 current_hr，**不要**改用 rhr。
這個系統沒有即時心率，硬挑 rhr 會讓系統拿靜息心率冒充當下心跳，那是錯的。

你不需要回答問題本身，也不要計算任何數字。只做分類。`;

/**
 * 完整判定：先確定性，再 LLM。
 * coach 為 null（或呼叫失敗）時就只用確定性結果。
 */
/** 嚴格 schema。未知欄位、非法 enum、超出範圍的數值一律拒絕。 */
export const INTENT_SCHEMA = {
  intent: { type: 'string', enum: INTENTS, required: true },
  metric: { type: 'string', enum: Object.keys(METRIC_KEYWORDS), nullable: true },
  window_days: { type: 'integer', min: 1, max: 365, nullable: true },
};

/**
 * 完整判定：先確定性，再 LLM（含 schema 驗證與一次重試）。
 *
 * 兩次都拿不到合法結構 → 回 unknown（確定性 fallback），
 * 由呼叫端給使用者提示，**絕不照著壞掉的結構去查資料**。
 */
export async function resolveIntent(text, { coach = null, maxTokens = 400 } = {}) {
  const det = deterministicIntent(text);
  if (det) return det;
  if (!coach?.json) return { intent: 'unknown', source: 'deterministic' };

  const result = await structuredWithRetry({
    label: 'intent',
    spec: INTENT_SCHEMA,
    call: () => coach.json({
      system: INTENT_SYSTEM_PROMPT,
      user: String(text ?? '').slice(0, 500),
      maxTokens,
      purpose: AI_PURPOSE.INTENT_PARSE,
      promptVersion: PROMPT_VERSIONS.INTENT_PARSE,
    }),
    fallbackFn: () => null,
  });

  if (!result.ok || !result.value) return { intent: 'unknown', source: 'llm_fallback' };
  return validateIntent(result.value) ?? { intent: 'unknown', source: 'llm' };
}
