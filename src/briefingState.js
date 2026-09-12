/**
 * 簡報評估結果的詞彙與政策常數（v8）。
 *
 * 這些名稱會被寫進 `briefing_evaluations.outcome`，所以它們是**耐久契約**：
 * 改名等於改資料格式。分得細是刻意的 —— 2026-09-12 的事故裡，
 * 「跑了但還不能發」與「根本沒跑」在紀錄上完全一樣，於是沒有人能回答
 * 使用者「我在等什麼」。
 */
export const BRIEFING_OUTCOME = Object.freeze({
  /** 還沒有可以報告的主睡眠。 */
  WAITING_FOR_SLEEP: 'WAITING_FOR_SLEEP',
  /** 睡眠進來了，但 WHOOP 還沒評分。 */
  WAITING_FOR_SLEEP_SCORE: 'WAITING_FOR_SLEEP_SCORE',
  /** 睡眠已評分，但還沒有對應的恢復資料。 */
  WAITING_FOR_RECOVERY: 'WAITING_FOR_RECOVERY',
  /** 恢復資料在了，但還沒評分。 */
  WAITING_FOR_RECOVERY_SCORE: 'WAITING_FOR_RECOVERY_SCORE',
  /** 剛起床，還沒到最短等待時間。 */
  TOO_SOON: 'TOO_SOON',
  /** 資料齊了、可以發了（但這一輪還沒送出）。 */
  READY: 'READY',
  /** 另一個 process 正握著發送權。 */
  CLAIM_BUSY: 'CLAIM_BUSY',
  /** 這個 health_date 已經送過了。 */
  ALREADY_SENT: 'ALREADY_SENT',
  /** 這一輪真的送出去了。 */
  SENT: 'SENT',
  /** 超過正常窗、但仍在補發期限內送出的。 */
  SENT_LATE: 'SENT_LATE',
  /** 嘗試送出但失敗（可重試）。 */
  FAILED: 'FAILED',
  /** 超過補發期限，終局不再發送。 */
  MISSED: 'MISSED',
});

/** 哪些結果代表「再跑一次也許就成了」。MISSED 與 ALREADY_SENT 是終局。 */
const TERMINAL = new Set([
  BRIEFING_OUTCOME.MISSED, BRIEFING_OUTCOME.ALREADY_SENT,
  BRIEFING_OUTCOME.SENT, BRIEFING_OUTCOME.SENT_LATE,
]);
export const isRetryableOutcome = (outcome) => !TERMINAL.has(outcome);

/**
 * 補發政策（使用者已核可）。
 *
 * ## 邊界語意（明文定義）
 *
 *   age = now − sleep.end（用**實際的**睡眠結束時間，不從前一天的作息推估）
 *
 *   age ≤ NORMAL_WINDOW_HOURS(24)  → 一般簡報
 *   NORMAL < age ≤ LATE_WINDOW_HOURS(48) → 補發簡報（標示「補發」）
 *   age > 48                       → MISSED，不送整份報告，只通知一次
 *
 * **48 小時是包含的**：age 恰好等於 48h 仍然可以補發；超過一毫秒就是 MISSED。
 * 取這個方向是因為邊界上的錯誤代價不對稱 —— 晚送一份有標示的報告，
 * 遠好過把一份還救得回來的報告永久丟掉。
 */
export const LATE_POLICY = Object.freeze({
  NORMAL_WINDOW_HOURS: 24,
  LATE_WINDOW_HOURS: 48,
});

/**
 * 依實際睡眠結束時間判定投遞窗。
 *
 * @returns {'normal'|'late'|'missed'|'unknown'}
 */
export function deliveryWindow({ sleepEndIso, now }) {
  if (!sleepEndIso) return 'unknown';
  const end = Date.parse(sleepEndIso);
  const at = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(end) || !Number.isFinite(at)) return 'unknown';
  const ageHours = (at - end) / 3600_000;
  if (ageHours < 0) return 'unknown';                       // 未來的時間戳是壞資料
  if (ageHours <= LATE_POLICY.NORMAL_WINDOW_HOURS) return 'normal';
  if (ageHours <= LATE_POLICY.LATE_WINDOW_HOURS) return 'late';
  return 'missed';
}
