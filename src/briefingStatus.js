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
import { log, describeError } from './logger.js';

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
  /** 證據不足，不猜。 */
  UNKNOWN: 'unknown',
});

/**
 * 超過這個時間沒有跑完一輪，就把「排程器沒在跑」當成主要答案。
 *
 * 刻意比 guardian 的 3 小時短：guardian 是在決定「要不要吵使用者」，
 * 這裡是在回答使用者主動問的問題，寧可早一點誠實說「我最近沒被叫起來」。
 * 事故當天觀測到的排程間隔是 2h11m～4h33m，所以 90 分鐘足以區分
 * 「正常但慢」與「根本沒在跑」。
 */
export const SCHEDULER_STALE_AFTER_MS = 90 * 60_000;

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
    sent_today: null,
    sent_yesterday: null,
    observation_health_date: null,
    observation_age_ms: null,
    wake_reason: null,
    cycle_open: null,
  };

  // ---- 1. 排程器最近有跑完一輪嗎？----
  try {
    if (typeof db.getHeartbeat === 'function') {
      const hb = await db.getHeartbeat(GLOBAL_SCOPE, HEARTBEAT_COMPONENT.CRON);
      if (hb?.lastOkAt) {
        evidence.scheduler_last_ok_at = hb.lastOkAt;
        const age = new Date(now).getTime() - Date.parse(hb.lastOkAt);
        if (Number.isFinite(age) && age >= 0) {
          evidence.scheduler_age_ms = age;
          evidence.scheduler_stale = age > SCHEDULER_STALE_AFTER_MS;
        }
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

  const ready = wake?.ready === true;
  const reason = e.wake_reason;

  // 資料齊了、在時限內，卻還沒送 → 差的只有「有人去處理它」。
  // 這時排程器的狀態就是答案本身。
  if (ready) {
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

/** 毫秒 → 人話（只給大概，不假裝精確）。 */
function ago(ms) {
  if (!Number.isFinite(ms) || ms < 0) return null;
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m} 分鐘前`;
  const h = ms / 3600_000;
  return h < 24 ? `${h.toFixed(1)} 小時前` : `${Math.round(h / 24)} 天前`;
}

/**
 * 判定 → 一句誠實的話。
 *
 * ⚠️ 只有在 heartbeat 顯示排程器最近有跑完一輪時，才會說「等下一輪」。
 * 排程器本身的可靠性是外部事實，程式碼保證不了 —— 事故當天任何
 * 「等一下就會來」的說法都會是謊話。
 */
export function renderBriefingStatus({ status, evidence }) {
  const e = evidence ?? {};
  const schedulerLine = e.scheduler_stale === true
    ? `另外，負責定時檢查的排程最近一次跑完是${ago(e.scheduler_age_ms) ?? '有一段時間了'}，`
      + '所以我現在沒辦法保證下一次檢查什麼時候會發生。'
    : null;
  const nextCheck = e.scheduler_stale === false ? '下一次檢查就會處理。' : null;

  switch (status) {
    case BRIEFING_STATUS.DELIVERED:
      return '今天的簡報我已經發出來了，往上滑應該看得到。';

    case BRIEFING_STATUS.WAITING_FOR_SLEEP_DATA:
      return [
        e.cycle_open === true
          ? '還在等這一晚的睡眠資料。WHOOP 要等這一段睡眠結束並結算之後才會給我數字。'
          : '還在等最新的睡眠資料進來 —— 我這邊目前沒有可以報告的新睡眠。',
        schedulerLine,
        // ★ 只有在**有證據**排程最近跑過時才敢說「下一次檢查」。
        // 沒有 heartbeat（null）跟 heartbeat 過期（true）一樣不可以承諾 ——
        // 事故當天任何「等一下就會來」的說法都會是謊話。
        nextCheck ? '資料一到，下一次檢查就會發給你。' : null,
      ].filter(Boolean).join('\n\n');

    case BRIEFING_STATUS.WAITING_FOR_SCORING:
      return [
        '睡眠已經記錄到了，但 WHOOP 還沒給出完整的評分（恢復分數通常會晚一點）。'
        + '沒有評分我不會硬算，那樣的數字不可靠。',
        schedulerLine ?? nextCheck,
      ].filter(Boolean).join('\n\n');

    case BRIEFING_STATUS.TOO_SOON_AFTER_WAKE:
      return [
        `你剛起來不久（大約 ${ago(e.observation_age_ms) ?? '不到半小時'}），`
        + `我會等超過 ${WAKE.MIN_MINUTES_AFTER_SLEEP_END} 分鐘再發，讓數字穩定下來。`,
        schedulerLine ?? nextCheck,
      ].filter(Boolean).join('\n\n');

    case BRIEFING_STATUS.READY_NOT_YET_PROCESSED:
      return '資料已經齊了，簡報還沒送出 —— 就等下一次檢查把它發出來。';

    case BRIEFING_STATUS.SCHEDULER_STALE:
      return [
        '我這邊的資料看起來可以做簡報了，但負責定時檢查的排程最近沒有跑'
        + `（上一次跑完是${ago(e.scheduler_age_ms) ?? '有一段時間了'}）。`,
        '所以問題不在你的資料，是沒有人去把它發出來。我沒辦法自己叫醒那個排程，'
        + '也不想給你一個我保證不了的時間。',
      ].join('\n\n');

    case BRIEFING_STATUS.WINDOW_EXPIRED:
      return [
        '那一份已經過了我會補發的時限，所以現行設定不會再把它發出來。',
        '不是資料不見了 —— 是超過時限之後我就不再當成「今天的簡報」。'
        + '下一次睡眠的簡報不受影響。',
      ].join('\n\n');

    case BRIEFING_STATUS.UNKNOWN:
    default:
      return [
        '我現在沒辦法確定今天簡報的狀態 —— 手邊的紀錄不足以下判斷。',
        schedulerLine,
      ].filter(Boolean).join('\n\n');
  }
}
