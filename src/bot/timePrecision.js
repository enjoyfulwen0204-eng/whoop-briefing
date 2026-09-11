/**
 * 時間精確度的確定性驗證。
 *
 * ## 為什麼解析器說了不算
 *
 * 上一輪把「敢不敢談先後關係」綁在 `time_precision` 上，那是對的：只有日期
 * 的事件不可以宣稱「時間早於這次量測」。但精確度本身**完全由 LLM 提供**，
 * 於是一個自信但錯誤的解析結果就能把「我昨天喝酒」升級成一個精確到秒的
 * 時間戳，然後系統就會用它去講因果順序。
 *
 * 那是把最後一道生理推論的地基交給模型。
 *
 * ## 規則
 *
 *   LLM 可以**提議**精確度。
 *   確定性驗證可以**維持或下修**。
 *   永遠不可以**上修到原文支撐不了的程度**。
 *
 * 原文說「今天」，最多就是 date；模型說 now 也一樣被壓回 date。原文完全
 * 沒有時間線索，上限是 unknown —— 收到訊息的時間不是事件發生的時間。
 *
 * 「剛剛」是唯一可以把訊息時間當成有界代理的情況：使用者明確表示這件事
 * 就發生在此刻的前後。這是刻意的、寫明的例外。
 */

/** 精確度高低。比較用，不對外。 */
const RANK = { unknown: 0, date: 1, time: 2, now: 3 };
export const PRECISIONS = Object.freeze(['now', 'time', 'date', 'unknown']);

/** 「就是現在」—— 只有這一類可以把訊息時間當成事件時間的有界代理。 */
const NOW_CUES = /(剛剛|剛才|剛剛才|現在|此刻|方才|正在|才剛|剛喝|剛吃|剛運動|剛練完|剛跑完)/;
/** 「X 分鐘前 / X 小時前」也是相對於此刻的明確說法。 */
const RELATIVE_NOW = /([0-9０-９一二三四五六七八九十兩半]+)\s*(分鐘|分|小時|個小時)\s*(前|之前)/;
/** 明確的鐘點。 */
const CLOCK_CUES = /([0-9０-９]{1,2}\s*[:：]\s*[0-9０-９]{2})|([0-9０-９一二三四五六七八九十兩]+\s*點(半|[0-9０-９一二三四五六七八九十]*分?)?)/;
/** 只講得出哪一天（或更模糊）。 */
const DATE_CUES = /(今天|今日|昨天|昨晚|昨夜|前天|早上|上午|中午|下午|晚上|傍晚|半夜|凌晨|最近|前幾天|這幾天|這兩天|剛剛那天|喝完|吃完|之後|後來|有喝|有吃)/;

/**
 * 原文最多支撐到什麼精確度？
 *
 * 注意順序：先看最強的線索。「昨天晚上十點」同時有 date 與 clock 線索，
 * 支撐得起 'time'。
 */
export function textSupportedPrecision(text) {
  const t = String(text ?? '');
  if (NOW_CUES.test(t) || RELATIVE_NOW.test(t)) return 'now';
  if (CLOCK_CUES.test(t)) return 'time';
  if (DATE_CUES.test(t)) return 'date';
  return 'unknown';
}

/**
 * 驗證（必要時下修）解析器提議的精確度。
 *
 * @returns {{precision:string, proposed:string, supported:string, downgraded:boolean}}
 */
export function validateTimePrecision({ text, proposed }) {
  const supported = textSupportedPrecision(text);
  const want = PRECISIONS.includes(proposed) ? proposed : 'unknown';
  // 取兩者中比較低的那一個 —— 下修安全，上修不安全。
  const precision = RANK[want] <= RANK[supported] ? want : supported;
  return { precision, proposed: want, supported, downgraded: precision !== want };
}
