/**
 * 「今天的晨報呢？」—— 用**已經存在的證據**回答，不做任何寫入。
 *
 * ## 為什麼需要它
 *
 * 2026-09-12 的事故裡，使用者等了一個早上，系統什麼都沒說。事後追查才發現
 * 鏈條是：排程器那天只在 00:54:49Z（台北 08:54）跑過一次，那時使用者還沒
 * 起床，最新的觀測仍然是前一天已經送出的 09-11；流程正確地回了
 * `already_sent` 就結束。設計上「等下一輪 cron 補」—— 但下一輪沒有來。
 *
 * 整條鏈上**每一步都沒有留下任何使用者看得到的東西**。使用者唯一能做的事
 * 是問，而系統當時連「我在等什麼」都答不出來。
 *
 * 這個模組補的就是這一格：把四種已經持久化的事實組合成一句誠實的話。
 *
 * ## 這個模組的邊界（刻意很窄）
 *
 *   · **完全唯讀。** 不寫 report_runs、不寫 heartbeat、不碰 claim。
 *     診斷不可以改變被診斷的狀態。
 *   · **不呼叫 WHOOP。** 只看資料庫裡已經同步進來的東西。
 *   · **不宣稱重試時間。** 排程器的可靠性是外部事實；heartbeat 顯示它最近
 *     有在跑，才敢說「等下一輪」。否則只說現況，不給承諾 —— 事故當天
 *     任何「馬上就會來」的說法都會是謊話。
 *   · **不輸出內部診斷。** 資源名稱、endpoint、capability、backfill 一律不提。
 */

import { WAKE } from './config.js';
import { detectWake, buildObservations } from './analyze.js';
import { localDate, addDays } from './time.js';
import { GLOBAL_SCOPE } from './schema.js';
import { HEARTBEAT_COMPONENT } from './guardianPolicy.js';
import { readSchedulerHealth } from './schedulerWatchdog.js';
import { log, describeError } from './logger.js';
import { t, formatNumber } from './localization.js';

/** 結構化判定。使用者看到的句子由 renderBriefingStatus 決定。 */
export const BRIEFING_STATUS = Object.freeze({
  /** 今天這一份已經送出去了。 */
  DELIVERED: 'delivered',
  /** 還在等今晚／昨晚的睡眠被 WHOOP 記錄並評分。 */
  WAITING_FOR_SLEEP_DATA: 'waiting_for_sleep_data',
  /** 睡眠有了但還沒評分，或恢復分數還沒出來。 */
  WAITING_FOR_SCORING: 'waiting_for_scoring',
  /** 剛起床不久，還沒到最短等待時間。 */
  TOO_SOON_AFTER_WAKE: 'too_soon_after_wake',
  /** 資料齊了、也還在時限內，但還沒有任何一輪去處理它。 */
  READY_NOT_YET_PROCESSED: 'ready_not_yet_processed',
  /** 已經超過補發時限，現行設定不會再發。 */
  WINDOW_EXPIRED: 'window_expired',
  /** 排程器太久沒有跑完一輪 —— 這件事本身就是答案。 */
  SCHEDULER_STALE: 'scheduler_stale',
  /** 睡眠已評分，但還沒有對應的恢復資料。 */
  WAITING_FOR_RECOVERY: 'waiting_for_recovery',
  /** 另一個流程正握著發送權。 */
  CLAIM_BUSY: 'claim_busy',
  /** 已經以補發的形式送出。 */
  SENT_LATE: 'sent_late',
  /** 嘗試送出但失敗，還會再試。 */
  FAILED_RETRYABLE: 'failed_retryable',
  /** 超過 48 小時的補發期限，終局不再發送。 */
  MISSED: 'missed',
  /** 證據不足，不猜。 */
  UNKNOWN: 'unknown',
});

/**
 * 收集證據並判定。**唯讀。**
 *
 * @param {object}  db        store（只會用到 getSleeps/getRecoveries/getCycles/isSent/getHeartbeat）
 * @param {string}  userId
 * @param {string}  timezone  該使用者的時區
 * @param {Date}    now
 */
export async function assessBriefingStatus({ db, userId, timezone, now = new Date() }) {
  const today = localDate(now, timezone);
  const evidence = {
    today,
    yesterday: addDays(today, -1),
    timezone,
    evaluated_at: new Date(now).toISOString(),
    scheduler_last_ok_at: null,
    scheduler_age_ms: null,
    scheduler_stale: null,
    scheduler_state: 'unknown',
    cloudflare_state: 'unknown',
    github_state: 'unknown',
    sent_today: null,
    sent_yesterday: null,
    observation_health_date: null,
    observation_age_ms: null,
    wake_reason: null,
    cycle_open: null,
    /** v8：最新一次評估的耐久結果（最可靠的證據，優先於重新推導）。 */
    evaluation_outcome: null,
    evaluation_health_date: null,
    evaluation_retryable: null,
  };

  // ---- 1. 排程器最近有跑完一輪嗎？----
  try {
    if (typeof db.getHeartbeat === 'function') {
      const scheduler = await readSchedulerHealth({ db, now });
      evidence.scheduler_state = scheduler.overall;
      evidence.cloudflare_state = scheduler.cloudflare.state;
      evidence.github_state = scheduler.github.state;
      const hb = await db.getHeartbeat(GLOBAL_SCOPE, HEARTBEAT_COMPONENT.CRON);
      if (hb?.lastOkAt) {
        evidence.scheduler_last_ok_at = hb.lastOkAt;
        const age = new Date(now).getTime() - Date.parse(hb.lastOkAt);
        if (Number.isFinite(age) && age >= 0) evidence.scheduler_age_ms = age;
      }
      if (scheduler.overall !== 'unknown' && scheduler.overall !== 'uninitialized') {
        evidence.scheduler_stale = scheduler.overall === 'outage';
      }
    }
  } catch (err) {
    log.warn('briefing_status_heartbeat_failed', { error: describeError(err) });
  }

  // ---- 2. 今天／昨天的這一份送出去了嗎？----
  for (const [key, date] of [['sent_today', today], ['sent_yesterday', evidence.yesterday]]) {
    try {
      if (typeof db.isSent === 'function') evidence[key] = await db.isSent(userId, 'daily', date);
    } catch (err) {
      log.warn('briefing_status_is_sent_failed', { error: describeError(err) });
    }
  }

  // ---- 3. 手邊的資料夠不夠發？（用同一個 detectWake，不另寫一套判斷）----
  let wake = null;
  try {
    const from = addDays(today, -WAKE.POLL_LOOKBACK_DAYS);
    const sleeps = (await db.getSleeps(userId, { from, to: today })).map(parseRaw).filter(Boolean);
    const recoveries = (await db.getRecoveries(userId, { from, to: today }))
      .map(parseRaw).filter(Boolean);
    wake = detectWake({
      observations: buildObservations({ sleeps, recoveries, timezone }), now, timezone,
    });
    evidence.wake_reason = wake.reason ?? (wake.ready ? 'ready' : null);
    evidence.observation_health_date = wake.healthDate ?? wake.record?.healthDate ?? null;
    if (wake.record?.endUtc) {
      const age = new Date(now).getTime() - Date.parse(wake.record.endUtc);
      if (Number.isFinite(age)) evidence.observation_age_ms = age;
    }
  } catch (err) {
    log.warn('briefing_status_readiness_failed', { error: describeError(err) });
  }

  // ---- 3b. v8：最新一次評估的耐久結果 ----
  //
  // 這比「重新推導一次」可靠：它記的是排程器**當時真的看到什麼**。
  // MISSED 尤其只能從這裡知道 —— 重新推導只會說「資料太舊」。
  try {
    if (typeof db.getBriefingEvaluation === 'function') {
      const ev = await db.getBriefingEvaluation(userId, 'daily');
      if (ev) {
        evidence.evaluation_outcome = ev.outcome;
        evidence.evaluation_health_date = ev.targetHealthDate ?? null;
        evidence.evaluation_retryable = ev.retryable;
      }
    }
  } catch (err) {
    log.warn('briefing_status_evaluation_failed', { error: describeError(err) });
  }

  // ---- 4. 現在這一夜還在進行中嗎？（cycle 還沒關）----
  //
  // 這是「在等今晚的睡眠」與「睡眠資料遺失」之間唯一的區別證據：WHOOP 的
  // 週期還開著，代表那一夜還沒被結算，不是資料掉了。
  try {
    // ⚠️ 用 getLatestCycle 而不是 getCycles：後者刻意排除 end_at IS NULL，
    // 而「還沒結束的那一個」正是我們要找的證據。
    if (typeof db.getLatestCycle === 'function') {
      const newest = await db.getLatestCycle(userId);
      if (newest) evidence.cycle_open = !newest.end_at;
    }
  } catch (err) {
    log.warn('briefing_status_cycle_failed', { error: describeError(err) });
  }

  return { status: decide(evidence, wake), evidence };
}

function parseRaw(row) {
  try { return JSON.parse(row.raw_json); } catch { return null; }
}

/**
 * 證據 → 判定。純函式，方便把每一種組合都測到。
 *
 * 順序即優先序，而且刻意把「已送出」放在最前面：那是唯一一個讓使用者
 * 不需要再等的答案。
 */
export function decide(e, wake = null) {
  if (e.sent_today === true) return BRIEFING_STATUS.DELIVERED;

  // ★ v8 的耐久結果優先 —— 但只有在它講的是**今天**那一份時。
  // 昨天的 MISSED 不該讓使用者以為今天的也沒救了。
  const evalIsCurrent = e.evaluation_health_date
    && e.evaluation_health_date === e.today;
  if (evalIsCurrent) {
    switch (e.evaluation_outcome) {
      case 'MISSED': return BRIEFING_STATUS.MISSED;
      case 'SENT_LATE': return BRIEFING_STATUS.SENT_LATE;
      case 'FAILED': return BRIEFING_STATUS.FAILED_RETRYABLE;
      case 'CLAIM_BUSY': return BRIEFING_STATUS.CLAIM_BUSY;
      case 'WAITING_FOR_RECOVERY': return BRIEFING_STATUS.WAITING_FOR_RECOVERY;
      default: break;
    }
  }

  const ready = wake?.ready === true;
  const reason = e.wake_reason;

  // 資料齊了、在時限內，卻還沒送 → 差的只有「有人去處理它」。
  // 這時排程器的狀態就是答案本身。
  if (ready) {
    // ★ 「可以發」不代表「使用者在等的那一份可以發」。
    // 補發窗（48 小時）讓前一天的觀測仍然是 ready 的，但那一天如果已經
    // 送出去了，使用者真正在等的是**今晚**的資料。
    const staleObservation = e.observation_health_date
      && e.observation_health_date !== e.today;
    if (staleObservation && e.sent_yesterday === true) {
      return BRIEFING_STATUS.WAITING_FOR_SLEEP_DATA;
    }
    return e.scheduler_stale === true
      ? BRIEFING_STATUS.SCHEDULER_STALE
      : BRIEFING_STATUS.READY_NOT_YET_PROCESSED;
  }

  switch (reason) {
    case 'no_main_sleep':
      return BRIEFING_STATUS.WAITING_FOR_SLEEP_DATA;
    case 'sleep_not_scored':
    case 'recovery_missing':
    case 'recovery_not_scored':
      return BRIEFING_STATUS.WAITING_FOR_SCORING;
    case 'too_soon':
      return BRIEFING_STATUS.TOO_SOON_AFTER_WAKE;
    case 'sleep_too_old':
      // 最新的觀測已經超過補發時限。如果那一天本來就送過了，使用者真正在
      // 等的是**今晚**的資料，不是一份過期的報告。
      return e.sent_yesterday === true || e.observation_health_date !== e.today
        ? BRIEFING_STATUS.WAITING_FOR_SLEEP_DATA
        : BRIEFING_STATUS.WINDOW_EXPIRED;
    default:
      break;
  }

  // 連讀不到資料時，排程器狀態仍然可能是有意義的答案。
  if (e.scheduler_stale === true) return BRIEFING_STATUS.SCHEDULER_STALE;
  return BRIEFING_STATUS.UNKNOWN;
}

/**
 * 判定 → 一句誠實的話。
 *
 * ⚠️ 只有在 heartbeat 顯示排程器最近有跑完一輪時，才會說「等下一輪」。
 * 排程器本身的可靠性是外部事實，程式碼保證不了 —— 事故當天任何
 * 「等一下就會來」的說法都會是謊話。
 */
export function renderBriefingStatus({ status, evidence, locale = 'zh-TW' }) {
  return renderLocalizedBriefingStatus({ status, evidence, locale });
}

function renderLocalizedBriefingStatus({ status, evidence, locale }) {
  const e = evidence ?? {};
  const tr = (key, values) => t(locale, `briefingStatus.${key}`, values);
  const ago = ms => {
    if (!Number.isFinite(ms) || ms < 0) return tr('agoUnknown');
    const minutes = Math.round(ms / 60_000);
    if (minutes < 60) return tr('agoMinutes', { value: formatNumber(locale, minutes) });
    const hours = ms / 3_600_000;
    if (hours >= 24) return tr('agoDays', { value: formatNumber(locale, Math.round(hours / 24)) });
    return tr('agoHours', { value: formatNumber(locale, Math.round(hours)) });
  };
  const source = ({ healthy:'sourceHealthy', degraded:'sourceDegraded', outage:'sourceOutage' })
    [e.scheduler_state];
  const sourceLine = source ? tr(source) : null;
  const schedulerLine = e.scheduler_stale === true
    ? tr('schedulerStale', { ago:ago(e.scheduler_age_ms) }) : null;
  const nextCheck = e.scheduler_stale === false ? tr('nextCheck') : null;
  const join = (...parts) => parts.filter(Boolean).join('\n\n');
  switch (status) {
    case BRIEFING_STATUS.DELIVERED: return tr('delivered');
    case BRIEFING_STATUS.WAITING_FOR_SLEEP_DATA:
      return join(tr(e.cycle_open === true ? 'waitingSleepOpen' : 'waitingSleep'),
        schedulerLine, nextCheck, sourceLine);
    case BRIEFING_STATUS.WAITING_FOR_SCORING:
      return join(tr('waitingScoring'), schedulerLine ?? nextCheck, schedulerLine ? null : sourceLine);
    case BRIEFING_STATUS.TOO_SOON_AFTER_WAKE:
      return join(tr('tooSoon', { ago:Number.isFinite(e.observation_age_ms)
        ? ago(e.observation_age_ms) : tr('soon'),
      minutes:formatNumber(locale, WAKE.MIN_MINUTES_AFTER_SLEEP_END) }),
      schedulerLine ?? nextCheck, schedulerLine ? null : sourceLine);
    case BRIEFING_STATUS.READY_NOT_YET_PROCESSED:
      return join(tr('ready'), sourceLine);
    case BRIEFING_STATUS.SCHEDULER_STALE:
      return join(tr('staleMain', { ago:ago(e.scheduler_age_ms) }), tr('staleExplain'));
    case BRIEFING_STATUS.SENT_LATE: return tr('sentLate');
    case BRIEFING_STATUS.MISSED: return join(tr('missed'), tr('missedExplain'));
    case BRIEFING_STATUS.FAILED_RETRYABLE:
      return join(tr('failed'), schedulerLine ?? tr('failedRetry'));
    case BRIEFING_STATUS.CLAIM_BUSY: return tr('busy');
    case BRIEFING_STATUS.WAITING_FOR_RECOVERY:
      return join(tr('waitingRecovery'), schedulerLine ?? nextCheck);
    case BRIEFING_STATUS.WINDOW_EXPIRED:
      return join(tr('windowExpired'), tr('windowExplain'));
    default: return join(tr('unknown'), schedulerLine);
  }
}
