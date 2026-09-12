/**
 * System Guardian 的政策（V1.1 Phase 9）。
 *
 * ## 這裡的每一個數字都是產品啟發式
 *
 * 跟 proactivePolicy.js 同一個立場：這些門檻背後**沒有**統計推導。
 * 「多久沒同步算異常」「連續失敗幾次才值得打擾」純粹是運維判斷，
 * 未來要依實際運作調整，絕不可以包裝成算出來的。
 *
 * 但它們跟生理門檻有一個關鍵差異：Guardian 看的是**系統事實**
 * （cron 有沒有跑、同步有沒有成功），不是生理資料。所以這些數字可以
 * 從已知的排程週期直接推導，不需要等真實生理資料才能決定。
 * 例如 cron 是每 30 分鐘一次，「超過 3 小時沒有心跳」就是明確的異常，
 * 這個推理不需要任何使用者資料。
 *
 * ## Guardian 絕對不做的事
 *
 * 這不是一個會自己修東西的代理。它只會：觀察持久化的事實 → 判斷 →
 * （必要時）發一則 Telegram。它**不會**改程式碼、不會部署、不會跑
 * migration、不會動 token、不會重送任何 at-most-once 的主動訊息。
 */

/**
 * 動作層級。
 *
 * LEVEL_1（有界的自動修復）與 LEVEL_3（產生修復包）**刻意只保留列舉值、
 * 不實作**——V1 只要「健康就閉嘴，有事就講一句人話」。留著是為了讓之後
 * 要加的時候不用改動 finding 的形狀。
 */
export const GUARDIAN_LEVEL = Object.freeze({
  /** 一切正常 → 完全靜默。這是預設，也是絕大多數時候該有的結果。 */
  LEVEL_0_HEALTHY: 'LEVEL_0_HEALTHY',
  /** 保留：有界的安全自動修復。V1 不實作。 */
  LEVEL_1_SAFE_RECOVERY: 'LEVEL_1_SAFE_RECOVERY',
  /** 需要人介入 → Telegram 通知。 */
  LEVEL_2_NOTIFY: 'LEVEL_2_NOTIFY',
  /** 保留：產生 Claude Code 修復包。**永遠不自動改程式或部署。** V1 不實作。 */
  LEVEL_3_REPAIR_PACKET: 'LEVEL_3_REPAIR_PACKET',
});

/** 訊號代碼。error_notifications 的 error_type 會用 `guardian:<code>`。 */
export const GUARDIAN_SIGNAL = Object.freeze({
  CRON_HEARTBEAT_STALE: 'cron_heartbeat_stale',
  WHOOP_SYNC_STALE: 'whoop_sync_stale',
  PROACTIVE_EVENT_STUCK: 'proactive_event_stuck',
  WHOOP_AUTH_REPEATED_FAILURE: 'whoop_auth_repeated_failure',
});

/** 心跳元件名稱。 */
export const HEARTBEAT_COMPONENT = Object.freeze({
  CRON: 'cron',
  GITHUB: 'briefing_github',
  CLOUDFLARE: 'briefing_cloudflare',
  BOT_WORKER: 'bot_worker',
});

export const GUARDIAN_POLICY_VERSION = 'guardian-policy-v1';

export const GUARDIAN_POLICY = {
  /**
   * cron 心跳超過這麼久沒更新就算異常。
   *
   * 相容性的 aggregate heartbeat 由任一排程更新；三小時才示警。
   * 抓得寬是刻意的——外部排程都不保證準時，
   * 偶爾延遲十幾分鐘是正常的，為此叫一次就會開始被無視。
   */
  CRON_HEARTBEAT_MAX_AGE_MS: 3 * 60 * 60_000,

  /**
   * 距離上次成功同步超過這麼久就算異常。
   *
   * 同步節流是 60 分鐘，所以 12 小時代表「連續十幾次機會都沒有成功過」。
   * 不設更短是因為 WHOOP 偶爾 5xx、使用者偶爾沒戴錶都很正常。
   */
  SYNC_STALE_MAX_AGE_MS: 12 * 60 * 60_000,

  /**
   * 主動事件已經送出、但超過這麼久還沒有任何結果 → 卡住了。
   *
   * 正常情況下它會在 QUESTION_TTL_MS 之後被收割器寫成 NO_RESPONSE，
   * 所以「遠大於 TTL 還是 NULL」代表收割器沒在跑，而不是使用者沒回答。
   * 這個數字必須明顯大於 TTL，否則會把「還在等使用者回答」誤報成故障。
   */
  PROACTIVE_STUCK_MAX_AGE_MS: 24 * 60 * 60_000,

  /**
   * WHOOP 授權連續失敗幾次才示警。
   *
   * 1 次可能只是 WHOOP 那邊暫時抽風；累積到這個數字就幾乎一定是
   * refresh token 真的失效了，需要人重跑 authorize。
   */
  WHOOP_AUTH_FAILURE_MIN_HITS: 3,

  /**
   * 同一個訊號多久之內不重複通知。直接餵給既有的 claimErrorNotify，
   * 不另外做一套冷卻機制。
   */
  NOTIFY_COOLDOWN_HOURS: 12,

  /**
   * 一次 Guardian 執行最多送幾則訊息。
   * 這是最後一道防線：就算判斷邏輯出錯，也不會一次洗版。
   */
  MAX_MESSAGES_PER_RUN: 3,

  /** 單一 Guardian 執行的 lease lock，避免兩個 cron 同時跑。 */
  LOCK_NAME: 'system_guardian',
  LOCK_TTL_MS: 5 * 60_000,
};
