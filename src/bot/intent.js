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
import { mentionsLoggableEvent } from './conversation.js';

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
  /**
   * 「為什麼我這麼累／沒精神／狀態這麼差」—— 問的是**主觀症狀的原因**。
   *
   * 以前沒有這個意圖，這類問題被分到 what_changed，於是「沒偵測到偏離」被
   * 講成「今天沒有特別值得注意的變化」。那是把「我們沒看到異常」偷換成
   * 「你沒事」—— 而使用者明明就說了他很累。
   */
  'cause_query',
  /**
   * 「因為數據不夠嗎」「我的資料夠嗎」「你是不是還不了解我」——
   * 問的是**分析成熟度**，不是要看資料庫診斷。
   *
   * 以前這類句子會撞到 data_status，於是回了一大塊內部診斷（涵蓋率、
   * 各資源筆數、capability probe、backfill 狀態）。那是給維運看的，
   * 不是對話。
   */
  'readiness_query',
  /**
   * 「WHOOP 有同步成功嗎」「今天的資料同步了嗎」—— 問**同步狀態**。
   *
   * 與 readiness_query（分析成熟度）和 data_status（完整診斷）是三件事：
   * 同步問題的答案來自最後成功／失敗時間，不是樣本數，也不該吐出
   * capability probe。
   */
  'sync_status',
  /**
   * 「今天的晨報呢？」「為什麼沒有 briefing？」
   *
   * 問的是**那一則主動推送的簡報跑了沒有**，不是問資料同步、也不是問身體
   * 狀態。2026-09-12 的事故裡這句話沒有任何歸屬：使用者等了一個早上，
   * 系統連「我在等什麼」都答不出來。
   */
  'briefing_status',
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

  // 主觀症狀的原因。**必須排在 what_changed / today_status 之前** ——
  // 「為什麼我那麼累」問的是原因，不是「今天有什麼變化」。
  if (/(為什麼|為何|怎麼會|怎麼[^，。,]{0,4}(這麼|那麼)|(是|不是)因為|會不會是|難道是)/.test(t)
      && /(累|疲|沒精神|沒力|想睡|睏|昏|狀態差|不舒服|沉|虛|喘|恍神)/.test(t)) {
    return { intent: 'cause_query', source: 'deterministic' };
  }
  // 「我做了 X，這會影響 Y 嗎？」——把某件事與某個指標連起來問因果。
  // 跟單純的趨勢查詢（「最近 HRV 如何」）的差別就在這個因果連接詞。
  if (/(是因為這樣|因為這樣|會不會影響|會影響|有沒有影響|有影響嗎|是不是這樣|是不是因為|難怪)/.test(t)
      && (mentionsLoggableEvent(t) || metric
          || /(累|疲|沒精神|沒力|想睡|睏|不舒服|沉|虛|喘)/.test(t))) {
    return { intent: 'cause_query', metric: metric ?? null, source: 'deterministic' };
  }

  // 沒有疑問詞、但明顯在抱怨狀態（「今天怎麼這麼沒精神」已被上面接走；
  // 這裡處理「好累喔」「整個人很沉」這種）。
  if (/(好累|很累|累爆|沒精神|沒力氣|整個人.*(沉|重)|提不起勁)/.test(t)
      && !/(記錄|記一下|幫我記)/.test(t)) {
    return { intent: 'cause_query', source: 'deterministic' };
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

  // 簡報狀態。**必須排在 sync_status 之前** —— 「今天的簡報怎麼還沒來」同時
  // 含有「還沒」與時間詞，會被同步那條規則吃掉，但使用者問的是簡報本身。
  if (/(簡報|晨報|早報|briefing|報告|推送)/i.test(t)
      && /(呢|沒來|沒有來|還沒|怎麼|為什麼|哪裡|在哪|跑了嗎|有跑|發了嗎|來了嗎|嗎)/.test(t)) {
    return { intent: 'briefing_status', source: 'deterministic' };
  }
  if (/(起床|早上|今天).{0,6}(報告|簡報|晨報).{0,6}(呢|沒|還沒|怎麼)/.test(t)) {
    return { intent: 'briefing_status', source: 'deterministic' };
  }

  // 同步狀態（對話式）。**必須排在 data_status 與 readiness_query 之前** ——
  // 「今天的資料同步了嗎」問的是同步，不是基準夠不夠，也不是要看診斷。
  if (/(同步|sync|更新|連線|連得上|進來)/i.test(t)
      && /(嗎|沒有|成功|失敗|時間|什麼時候|正常|了嗎|過嗎|到嗎)/.test(t)) {
    return { intent: 'sync_status', source: 'deterministic' };
  }
  if (/(最後|上次|最近一次).{0,4}同步/.test(t)) {
    return { intent: 'sync_status', source: 'deterministic' };
  }
  if (/為什麼.{0,10}(還沒|沒有).{0,6}(進來|更新|同步)/.test(t)) {
    return { intent: 'sync_status', source: 'deterministic' };
  }

  // 分析成熟度（對話式）。**必須排在 data_status 之前** —— 否則
  // 「因為數據不夠嗎」會被當成要看資料庫診斷。
  if (/(資料|數據|紀錄|記錄|樣本|sample)/i.test(t)
      && /(不夠|太少|不足|夠嗎|夠不夠|還太少|不多)/.test(t)) {
    return { intent: 'readiness_query', source: 'deterministic' };
  }
  if (/(還不(夠)?了解我|不了解我|判斷不出來|沒辦法判斷|不能判斷|還不準)/.test(t)) {
    return { intent: 'readiness_query', source: 'deterministic' };
  }

  // 資料狀況（內部診斷）。刻意收窄：要明確在問「同步/涵蓋狀態」才算，
  // 「數據不夠嗎」這種對話句子上面已經先被 readiness_query 接走。
  if (/(同步|sync|backfill|涵蓋)/i.test(t) && /(狀態|狀況|進度|多少|有嗎|status)/i.test(t)) {
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
- cause_query：問**主觀症狀的原因**（「為什麼我那麼累」「今天怎麼這麼沒精神」
  「是不是因為喝酒」）。使用者在描述自己的感覺並問為什麼。
- readiness_query：問**你的資料夠不夠、判斷準不準**（「因為數據不夠嗎」
  「我的資料夠嗎」「你是不是還不了解我」）。這不是要看系統診斷。
- briefing_status：問**每日簡報這則推送跑了沒有**（「今天的晨報呢」「為什麼沒有 briefing」
  「起床報告怎麼沒來」）。問的是那一則訊息，不是同步、也不是身體狀態。
- sync_status：問**WHOOP 有沒有同步成功／資料有沒有進來**（「今天的資料同步了嗎」
  「最後同步時間」「為什麼今天的 sleep 還沒進來」）。這跟資料夠不夠是兩件事。
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
