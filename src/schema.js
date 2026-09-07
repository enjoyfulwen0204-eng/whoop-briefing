/**
 * 全系統唯一的 DDL 定義處。
 *
 * ## Multi-user 所有權模型（不可違反）
 *
 *  - **內部身分**是 `users.id`（TEXT / UUID）。這是唯一的帳號主鍵。
 *  - Telegram chat id 是**可替換的外部身分**（使用者可能刪帳號重建），
 *    存在 `user_telegram`，**絕不當主鍵**。
 *  - WHOOP 自己的 user id 存成 `whoop_user_id`，只用來防止把同一個 WHOOP
 *    帳號綁到兩個內部使用者，**不是內部主鍵**。
 *  - 每一張「屬於某個人」的表都有 `user_id TEXT NOT NULL`，而且
 *    **邏輯唯一性一律包含 user_id** —— WHOOP 的 external id 在不同使用者之間
 *    不保證唯一（同一個 sleep id 可能出現在兩個帳號的測試資料裡）。
 *  - 少數表刻意保持全域，見 GLOBAL_SCHEMA 的說明。
 *
 * ## DDL 規則
 *
 *  - 只用 CREATE TABLE / INDEX IF NOT EXISTS，永遠是 additive。
 *  - 需要改變既有表的形狀（加 user_id 到主鍵）時，走 migrations.js 的
 *    版本化流程，而且**只在該表為空時才允許重建**，否則中止並要求人工處理。
 *
 * 分組：
 *   IDENTITY_SCHEMA —— users / telegram 綁定 / link code / OAuth state
 *   TOKEN_SCHEMA    —— 每個使用者一組 WHOOP token
 *   GLOBAL_SCHEMA   —— 刻意全域（bot offset、跨 process lock、系統錯誤冷卻）
 *   REPORT_SCHEMA   —— 報告紀錄與發送權（per-user）
 *   HEALTH_SCHEMA   —— 長期健康資料 + 同步狀態 + capability（per-user）
 *   BOT_SCHEMA      —— journal / 待回答追問（per-user）
 *   ANALYSIS_SCHEMA —— healthspan / prediction / insight / experiment（per-user）
 *   LEDGER_SCHEMA   —— AI 用量帳本（per-user，系統層用量可為 NULL）
 */

// ---------------------------------------------------------------------------
// 0. Schema 版本（migrations.js 用）
// ---------------------------------------------------------------------------
export const SCHEMA_VERSION = 2;

export const VERSION_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS schema_version (
     version    INTEGER PRIMARY KEY,
     applied_at TEXT NOT NULL,
     note       TEXT
   )`,
];

// ---------------------------------------------------------------------------
// 1. 身分（Multi-user 的核心）
// ---------------------------------------------------------------------------
export const IDENTITY_SCHEMA = [
  // 內部帳號。id 是穩定的內部 UUID，與任何外部系統無關。
  `CREATE TABLE IF NOT EXISTS users (
     id           TEXT PRIMARY KEY,
     display_name TEXT NOT NULL,
     timezone     TEXT NOT NULL DEFAULT 'Asia/Taipei',
     status       TEXT NOT NULL,
     created_at   TEXT NOT NULL,
     updated_at   TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_users_status ON users (status)`,

  // Telegram 綁定。chat_id 當 PK 是因為「一個 chat 只能屬於一個人」，
  // 但它是**外部**身分：使用者換 chat id 時刪一列、加一列即可，users.id 不動。
  `CREATE TABLE IF NOT EXISTS user_telegram (
     telegram_chat_id TEXT PRIMARY KEY,
     user_id          TEXT NOT NULL,
     linked_at        TEXT NOT NULL,
     status           TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_user_telegram_user ON user_telegram (user_id, status)`,

  // 一次性綁定碼。**只存 hash，絕不存原碼。**
  `CREATE TABLE IF NOT EXISTS user_link_codes (
     id         TEXT PRIMARY KEY,
     user_id    TEXT NOT NULL,
     code_hash  TEXT NOT NULL,
     created_at TEXT NOT NULL,
     expires_at TEXT NOT NULL,
     used_at    TEXT,
     used_by    TEXT
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uniq_link_code_hash ON user_link_codes (code_hash)`,
  `CREATE INDEX IF NOT EXISTS idx_link_code_user ON user_link_codes (user_id, used_at)`,

  // OAuth state。**只存 hash**，原始 state 只回給 OAuth flow 本身。
  // consumed_at 讓 state 一次性（防重放）。
  `CREATE TABLE IF NOT EXISTS oauth_states (
     state_hash  TEXT PRIMARY KEY,
     user_id     TEXT NOT NULL,
     created_at  TEXT NOT NULL,
     expires_at  TEXT NOT NULL,
     consumed_at TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS idx_oauth_state_user ON oauth_states (user_id, consumed_at)`,
];

// ---------------------------------------------------------------------------
// 2. WHOOP token（每個使用者一組）
// ---------------------------------------------------------------------------
export const TOKEN_SCHEMA = [
  // 取代舊的 whoop_tokens CHECK(id = 1)。
  // whoop_user_id 用來偵測「同一個 WHOOP 帳號被綁到兩個內部使用者」。
  `CREATE TABLE IF NOT EXISTS user_whoop_tokens (
     user_id                 TEXT PRIMARY KEY,
     whoop_user_id           TEXT,
     access_token            TEXT NOT NULL,
     refresh_token           TEXT NOT NULL,
     access_token_expires_at TEXT NOT NULL,
     scope                   TEXT,
     updated_at              TEXT NOT NULL
   )`,
  // ★ race-safe：同一個 WHOOP 帳號不可綁到兩個內部使用者。
  // 只靠 SELECT-before-INSERT 會有競態，所以用 DB 層的 partial unique index。
  // whoop_user_id 為 NULL 時不受限（還沒授權 / WHOOP 沒回傳 id 的情況）。
  `CREATE UNIQUE INDEX IF NOT EXISTS uniq_whoop_account
     ON user_whoop_tokens (whoop_user_id) WHERE whoop_user_id IS NOT NULL`,
];

// ---------------------------------------------------------------------------
// 3. 刻意全域的表
// ---------------------------------------------------------------------------
export const GLOBAL_SCHEMA = [
  // Telegram getUpdates offset 是**整個 bot 一份**。
  // 加 user_id 會造成同一則 update 被多個 user scope 重複處理或漏處理。
  `CREATE TABLE IF NOT EXISTS telegram_state (
     key        TEXT PRIMARY KEY,
     value      TEXT,
     updated_at TEXT NOT NULL
   )`,

  // 跨 process lease lock。表結構全域，但**per-user 的鎖名要帶 user id**
  // （例如 whoop_token_refresh:<userId>），否則 Alice refresh 會卡住 Bob。
  `CREATE TABLE IF NOT EXISTS resource_locks (
     name        TEXT PRIMARY KEY,
     owner       TEXT NOT NULL,
     acquired_at TEXT NOT NULL,
     expires_at  TEXT NOT NULL
   )`,

  // 錯誤通知冷卻。scope 區分「系統層」與「某個使用者」：
  //   scope = 'global'        → Turso / Telegram 這類基礎設施故障
  //   scope = 'user:<userId>' → 某人的 WHOOP token 失效
  // 這樣一個人的 token 過期不會壓抑另一個人的錯誤通知。
  `CREATE TABLE IF NOT EXISTS error_notifications (
     scope            TEXT NOT NULL,
     error_type       TEXT NOT NULL,
     last_notified_at TEXT NOT NULL,
     hits             INTEGER NOT NULL DEFAULT 1,
     PRIMARY KEY (scope, error_type)
   )`,
];

// ---------------------------------------------------------------------------
// 4. 報告紀錄與發送權（per-user）
// ---------------------------------------------------------------------------
export const REPORT_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS report_runs (
     id                  INTEGER PRIMARY KEY AUTOINCREMENT,
     user_id             TEXT NOT NULL,
     report_type         TEXT NOT NULL,
     local_date          TEXT NOT NULL,
     health_date         TEXT,
     sleep_id            TEXT,
     cycle_id            TEXT,
     telegram_message_id INTEGER,
     status              TEXT NOT NULL,
     detail              TEXT,
     sent_at             TEXT NOT NULL
   )`,
  // 去重的邏輯 key 必須含 user_id：Alice 與 Bob 同一天都要能各發一份。
  `CREATE UNIQUE INDEX IF NOT EXISTS uniq_report_sent
     ON report_runs (user_id, report_type, local_date) WHERE status = 'SENT'`,
  `CREATE INDEX IF NOT EXISTS idx_report_lookup
     ON report_runs (user_id, report_type, local_date)`,

  // 發送權。telegram_sent_at 一旦寫入就是「已經送出去了」的耐久證據 ——
  // 即使之後 report_runs 的 SENT 寫入失敗，也不會被重新 claim 而重發。
  `CREATE TABLE IF NOT EXISTS report_claims (
     user_id             TEXT NOT NULL,
     report_type         TEXT NOT NULL,
     local_date          TEXT NOT NULL,
     owner               TEXT NOT NULL,
     claimed_at          TEXT NOT NULL,
     expires_at          TEXT NOT NULL,
     telegram_sent_at    TEXT,
     telegram_message_id INTEGER,
     PRIMARY KEY (user_id, report_type, local_date)
   )`,
];

// ---------------------------------------------------------------------------
// 5. 長期健康資料（per-user）
// ---------------------------------------------------------------------------
// 共通約定：
//   user_id       內部使用者（TEXT），一律是邏輯主鍵的第一段
//   whoop_user_id WHOOP 自己的 user id（只作參考／防綁錯帳號，不是內部主鍵）
//   *_at          一律 ISO8601 UTC 字串
//   health_date   一律 YYYY-MM-DD（**該使用者的**時區），與 analyze.js 定義相同
//   raw_json      保留原始 payload
//   synced_at     本地最後一次寫入時間
export const HEALTH_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS whoop_sleeps (
     user_id                       TEXT NOT NULL,
     id                            TEXT NOT NULL,
     v1_id                         INTEGER,
     whoop_user_id                 INTEGER,
     health_date                   TEXT,
     start_at                      TEXT,
     end_at                        TEXT,
     timezone_offset               TEXT,
     nap                           INTEGER,
     score_state                   TEXT,
     respiratory_rate              REAL,
     sleep_performance_percentage  REAL,
     sleep_consistency_percentage  REAL,
     sleep_efficiency_percentage   REAL,
     total_sleep_milli             INTEGER,
     light_sleep_milli             INTEGER,
     slow_wave_sleep_milli         INTEGER,
     rem_sleep_milli               INTEGER,
     awake_milli                   INTEGER,
     no_data_milli                 INTEGER,
     in_bed_milli                  INTEGER,
     disturbance_count             INTEGER,
     sleep_cycle_count             INTEGER,
     sleep_need_baseline_milli     INTEGER,
     sleep_debt_milli              INTEGER,
     sleep_need_recent_strain_milli INTEGER,
     sleep_need_recent_nap_milli   INTEGER,
     created_at                    TEXT,
     updated_at                    TEXT,
     synced_at                     TEXT NOT NULL,
     raw_json                      TEXT,
     PRIMARY KEY (user_id, id)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_sleeps_health_date ON whoop_sleeps (user_id, health_date)`,
  `CREATE INDEX IF NOT EXISTS idx_sleeps_end        ON whoop_sleeps (user_id, end_at)`,
  `CREATE INDEX IF NOT EXISTS idx_sleeps_nap_date   ON whoop_sleeps (user_id, nap, health_date)`,

  `CREATE TABLE IF NOT EXISTS whoop_recoveries (
     user_id             TEXT NOT NULL,
     sleep_id            TEXT NOT NULL,
     cycle_id            TEXT,
     whoop_user_id       INTEGER,
     health_date         TEXT,
     score_state         TEXT,
     recovery_score      REAL,
     hrv_rmssd_milli     REAL,
     resting_heart_rate  REAL,
     spo2_percentage     REAL,
     skin_temp_celsius   REAL,
     user_calibrating    INTEGER,
     created_at          TEXT,
     updated_at          TEXT,
     synced_at           TEXT NOT NULL,
     raw_json            TEXT,
     PRIMARY KEY (user_id, sleep_id)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_recoveries_health_date ON whoop_recoveries (user_id, health_date)`,
  `CREATE INDEX IF NOT EXISTS idx_recoveries_cycle       ON whoop_recoveries (user_id, cycle_id)`,

  `CREATE TABLE IF NOT EXISTS whoop_cycles (
     user_id            TEXT NOT NULL,
     id                 TEXT NOT NULL,
     whoop_user_id      INTEGER,
     start_at           TEXT,
     end_at             TEXT,
     timezone_offset    TEXT,
     score_state        TEXT,
     strain             REAL,
     kilojoule          REAL,
     average_heart_rate REAL,
     max_heart_rate     REAL,
     created_at         TEXT,
     updated_at         TEXT,
     synced_at          TEXT NOT NULL,
     raw_json           TEXT,
     PRIMARY KEY (user_id, id)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_cycles_end   ON whoop_cycles (user_id, end_at)`,
  `CREATE INDEX IF NOT EXISTS idx_cycles_start ON whoop_cycles (user_id, start_at)`,

  // 欄位完全依官方 v2 WorkoutScore schema，沒有臆造欄位。
  // sport_id 官方標為 2025-09-01 後移除，仍保留欄位以吃下舊資料。
  `CREATE TABLE IF NOT EXISTS whoop_workouts (
     user_id                TEXT NOT NULL,
     id                     TEXT NOT NULL,
     v1_id                  INTEGER,
     whoop_user_id          INTEGER,
     health_date            TEXT,
     start_at               TEXT,
     end_at                 TEXT,
     timezone_offset        TEXT,
     sport_name             TEXT,
     sport_id               INTEGER,
     score_state            TEXT,
     strain                 REAL,
     average_heart_rate     REAL,
     max_heart_rate         REAL,
     kilojoule              REAL,
     percent_recorded       REAL,
     distance_meter         REAL,
     altitude_gain_meter    REAL,
     altitude_change_meter  REAL,
     zone_zero_milli        INTEGER,
     zone_one_milli         INTEGER,
     zone_two_milli         INTEGER,
     zone_three_milli       INTEGER,
     zone_four_milli        INTEGER,
     zone_five_milli        INTEGER,
     created_at             TEXT,
     updated_at             TEXT,
     synced_at              TEXT NOT NULL,
     raw_json               TEXT,
     PRIMARY KEY (user_id, id)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_workouts_health_date ON whoop_workouts (user_id, health_date)`,
  `CREATE INDEX IF NOT EXISTS idx_workouts_start       ON whoop_workouts (user_id, start_at)`,

  // /user/measurement/body 是單一物件（非 collection）。用 recorded_at 當版本，
  // 保留歷史變化（體重會變），不覆蓋舊值。
  `CREATE TABLE IF NOT EXISTS whoop_body_measurements (
     user_id         TEXT NOT NULL,
     recorded_at     TEXT NOT NULL,
     height_meter    REAL,
     weight_kilogram REAL,
     max_heart_rate  REAL,
     synced_at       TEXT NOT NULL,
     raw_json        TEXT,
     PRIMARY KEY (user_id, recorded_at)
   )`,

  // 同步進度。每個 (user, resource) 一列，可 resume。
  `CREATE TABLE IF NOT EXISTS whoop_sync_state (
     user_id           TEXT NOT NULL,
     resource          TEXT NOT NULL,
     backfill_complete INTEGER NOT NULL DEFAULT 0,
     backfill_cursor   TEXT,
     earliest_synced   TEXT,
     latest_synced     TEXT,
     last_success_at   TEXT,
     last_error        TEXT,
     last_error_at     TEXT,
     updated_at        TEXT NOT NULL,
     PRIMARY KEY (user_id, resource)
   )`,

  // capability：由 probe 寫入，其他模組靠它判斷「**這個使用者的**帳號有沒有這個欄位」。
  // Alice 有 90 天資料不代表 Bob 就 READY。
  `CREATE TABLE IF NOT EXISTS whoop_capabilities (
     user_id        TEXT NOT NULL,
     key            TEXT NOT NULL,
     status         TEXT NOT NULL,
     sample_count   INTEGER,
     non_null_count INTEGER,
     latest_value   TEXT,
     first_seen_at  TEXT,
     last_seen_at   TEXT,
     last_probed_at TEXT NOT NULL,
     detail         TEXT,
     PRIMARY KEY (user_id, key)
   )`,
];

// ---------------------------------------------------------------------------
// 6. journal / 對話狀態（per-user）
// ---------------------------------------------------------------------------
export const BOT_SCHEMA = [
  // 個人 journal。event_at 是「事情發生的時間」，health_date 是它歸屬的健康日
  // （用**該使用者的**時區換算）。凌晨 2 點喝的酒屬於前一個健康日。
  `CREATE TABLE IF NOT EXISTS journal_events (
     id            INTEGER PRIMARY KEY AUTOINCREMENT,
     user_id       TEXT NOT NULL,
     event_at      TEXT NOT NULL,
     health_date   TEXT NOT NULL,
     category      TEXT NOT NULL,
     subtype       TEXT,
     numeric_value REAL,
     text_value    TEXT,
     unit          TEXT,
     severity      INTEGER,
     note          TEXT,
     source        TEXT NOT NULL,
     created_at    TEXT NOT NULL,
     updated_at    TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_journal_health_date ON journal_events (user_id, health_date)`,
  `CREATE INDEX IF NOT EXISTS idx_journal_category    ON journal_events (user_id, category, health_date)`,
  `CREATE INDEX IF NOT EXISTS idx_journal_event_at    ON journal_events (user_id, event_at)`,

  // 待回答的追問。一個使用者同時只該有一個 OPEN。
  // chat_id 保留（回覆時要用），但所有權是 user_id。
  `CREATE TABLE IF NOT EXISTS pending_questions (
     id               INTEGER PRIMARY KEY AUTOINCREMENT,
     user_id          TEXT NOT NULL,
     chat_id          TEXT NOT NULL,
     original_message TEXT,
     question         TEXT NOT NULL,
     intent           TEXT,
     context_json     TEXT,
     asked_at         TEXT NOT NULL,
     expires_at       TEXT NOT NULL,
     status           TEXT NOT NULL,
     answered_at      TEXT,
     answer_text      TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS idx_pending_user ON pending_questions (user_id, status)`,
];

// ---------------------------------------------------------------------------
// 7. 分析基礎建設（per-user）
// ---------------------------------------------------------------------------
export const ANALYSIS_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS healthspan_metrics (
     id            INTEGER PRIMARY KEY AUTOINCREMENT,
     user_id       TEXT NOT NULL,
     calculated_at TEXT NOT NULL,
     metric_key    TEXT NOT NULL,
     value         REAL,
     unit          TEXT,
     window_days   INTEGER,
     sample_count  INTEGER,
     coverage      REAL,
     availability  TEXT NOT NULL,
     source        TEXT,
     confidence    REAL,
     detail        TEXT
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uniq_healthspan_metric
     ON healthspan_metrics (user_id, calculated_at, metric_key)`,
  `CREATE INDEX IF NOT EXISTS idx_healthspan_metric_key
     ON healthspan_metrics (user_id, metric_key, calculated_at)`,

  `CREATE TABLE IF NOT EXISTS healthspan_snapshots (
     id                INTEGER PRIMARY KEY AUTOINCREMENT,
     user_id           TEXT NOT NULL,
     snapshot_date     TEXT NOT NULL,
     algorithm_version TEXT NOT NULL,
     score             REAL,
     score_kind        TEXT,
     contributors_json TEXT,
     coverage          REAL,
     status            TEXT NOT NULL,
     created_at        TEXT NOT NULL
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uniq_healthspan_snapshot
     ON healthspan_snapshots (user_id, snapshot_date, algorithm_version)`,

  `CREATE TABLE IF NOT EXISTS prediction_runs (
     id              INTEGER PRIMARY KEY AUTOINCREMENT,
     user_id         TEXT NOT NULL,
     target_date     TEXT NOT NULL,
     target_metric   TEXT NOT NULL,
     model_version   TEXT NOT NULL,
     status          TEXT NOT NULL,
     features_json   TEXT,
     predicted_value REAL,
     predicted_low   REAL,
     predicted_high  REAL,
     n_train         INTEGER,
     created_at      TEXT NOT NULL,
     actual_value    REAL,
     error           REAL,
     evaluated_at    TEXT
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uniq_prediction_run
     ON prediction_runs (user_id, target_date, target_metric, model_version)`,

  `CREATE TABLE IF NOT EXISTS health_insights (
     id                  INTEGER PRIMARY KEY AUTOINCREMENT,
     user_id             TEXT NOT NULL,
     insight_type        TEXT NOT NULL,
     subject             TEXT NOT NULL,
     statement           TEXT NOT NULL,
     evidence_json       TEXT,
     sample_count        INTEGER,
     effect_size         REAL,
     confidence          TEXT,
     status              TEXT NOT NULL,
     first_detected_at   TEXT NOT NULL,
     last_confirmed_at   TEXT,
     last_recalculated_at TEXT,
     version             INTEGER NOT NULL DEFAULT 1,
     supersedes_id       INTEGER,
     retired_at          TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS idx_insight_subject ON health_insights (user_id, subject, status)`,
  `CREATE INDEX IF NOT EXISTS idx_insight_active  ON health_insights (user_id, status, insight_type)`,

  `CREATE TABLE IF NOT EXISTS experiments (
     id             INTEGER PRIMARY KEY AUTOINCREMENT,
     user_id        TEXT NOT NULL,
     name           TEXT NOT NULL,
     hypothesis     TEXT,
     intervention   TEXT,
     target_metrics TEXT,
     baseline_start TEXT,
     baseline_end   TEXT,
     start_date     TEXT,
     end_date       TEXT,
     status         TEXT NOT NULL,
     protocol_json  TEXT,
     result_json    TEXT,
     created_at     TEXT NOT NULL,
     updated_at     TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_experiment_status ON experiments (user_id, status)`,
];

// ---------------------------------------------------------------------------
// 8. AI 用量 / 成本帳本（per-user）
// ---------------------------------------------------------------------------
export const LEDGER_SCHEMA = [
  // user_id **可為 NULL**，代表「系統層」用量（不屬於任何使用者的呼叫）。
  // 刻意不把系統用量硬塞給某個隨機使用者。
  //
  // 刻意允許 token 與 cost 為 NULL：如果 provider 沒有回 usage，
  // 就誠實記 null，絕不用猜的 token 數填進資料庫。
  `CREATE TABLE IF NOT EXISTS ai_usage (
     id                 INTEGER PRIMARY KEY AUTOINCREMENT,
     user_id            TEXT,
     timestamp          TEXT NOT NULL,
     provider           TEXT NOT NULL,
     requested_model    TEXT,
     model              TEXT,
     fallback_occurred  INTEGER NOT NULL DEFAULT 0,
     purpose            TEXT NOT NULL,
     prompt_version     TEXT,
     input_tokens       INTEGER,
     output_tokens      INTEGER,
     total_tokens       INTEGER,
     estimated_cost_usd REAL,
     pricing_version    TEXT,
     request_status     TEXT NOT NULL,
     latency_ms         INTEGER,
     detail             TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS idx_ai_usage_ts      ON ai_usage (user_id, timestamp)`,
  `CREATE INDEX IF NOT EXISTS idx_ai_usage_purpose ON ai_usage (user_id, purpose, timestamp)`,
];

/** migrate() 實際執行的完整順序。 */
export const SCHEMA = [
  ...VERSION_SCHEMA,
  ...IDENTITY_SCHEMA,
  ...TOKEN_SCHEMA,
  ...GLOBAL_SCHEMA,
  ...REPORT_SCHEMA,
  ...HEALTH_SCHEMA,
  ...BOT_SCHEMA,
  ...ANALYSIS_SCHEMA,
  ...LEDGER_SCHEMA,
];

/** 使用者狀態。 */
export const USER_STATUS = { ACTIVE: 'ACTIVE', PAUSED: 'PAUSED', DISABLED: 'DISABLED' };

/** Telegram 綁定狀態。 */
export const LINK_STATUS = { ACTIVE: 'ACTIVE', REVOKED: 'REVOKED' };

/** 錯誤通知的 scope。 */
export const GLOBAL_SCOPE = 'global';
export const userScope = (userId) => `user:${userId}`;

/**
 * 「這一輪重建時，哪些舊表的形狀變了」。
 * migrations.js 用這份清單決定要不要重建 —— 而且只在該表為空時才允許。
 */
export const RESHAPED_TABLES = [
  { table: 'report_runs', requiredColumn: 'user_id' },
  { table: 'error_notifications', requiredColumn: 'scope' },
  { table: 'whoop_sleeps', requiredColumn: 'whoop_user_id' },
  { table: 'whoop_recoveries', requiredColumn: 'whoop_user_id' },
  { table: 'whoop_cycles', requiredColumn: 'whoop_user_id' },
  { table: 'whoop_workouts', requiredColumn: 'whoop_user_id' },
  { table: 'whoop_body_measurements', requiredColumn: 'user_id' },
  { table: 'whoop_sync_state', requiredColumn: 'user_id' },
  { table: 'whoop_capabilities', requiredColumn: 'user_id' },
  { table: 'report_claims', requiredColumn: 'user_id' },
  { table: 'journal_events', requiredColumn: 'user_id' },
  { table: 'pending_questions', requiredColumn: 'user_id' },
  { table: 'healthspan_metrics', requiredColumn: 'user_id' },
  { table: 'healthspan_snapshots', requiredColumn: 'user_id' },
  { table: 'prediction_runs', requiredColumn: 'user_id' },
  { table: 'health_insights', requiredColumn: 'user_id' },
  { table: 'experiments', requiredColumn: 'user_id' },
  { table: 'ai_usage', requiredColumn: 'user_id' },
];

/** 舊的 single-user 表，被取代後留著不刪（0 列，無害）。 */
export const LEGACY_TABLES = ['whoop_tokens', 'app_state'];
