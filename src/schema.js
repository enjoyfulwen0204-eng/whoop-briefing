/**
 * 全系統唯一的 DDL 定義處。
 *
 * 規則（不可違反）：
 *  - 只用 CREATE TABLE / INDEX IF NOT EXISTS，永遠是 additive。
 *  - 絕不 DROP / RENAME / 修改既有欄位。舊資料一律保留。
 *  - 需要補欄位時走 db.js 的 ensureColumn()（ALTER TABLE ADD COLUMN）。
 *
 * 分成三組：
 *   CORE_SCHEMA    —— 原本就有的（token / 報告紀錄 / 錯誤冷卻）
 *   CONTROL_SCHEMA —— 併發控制（跨 process lock、報告 claim）
 *   HEALTH_SCHEMA  —— 長期健康資料落地 + 同步狀態 + capability
 */

// ---------------------------------------------------------------------------
// 1. 既有核心（一字不改，維持向後相容）
// ---------------------------------------------------------------------------
export const CORE_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS whoop_tokens (
     id                      INTEGER PRIMARY KEY CHECK (id = 1),
     access_token            TEXT NOT NULL,
     refresh_token           TEXT NOT NULL,
     access_token_expires_at TEXT NOT NULL,
     scope                   TEXT,
     updated_at              TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS report_runs (
     id                  INTEGER PRIMARY KEY AUTOINCREMENT,
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
  `CREATE UNIQUE INDEX IF NOT EXISTS uniq_report_sent
     ON report_runs (report_type, local_date) WHERE status = 'SENT'`,
  `CREATE INDEX IF NOT EXISTS idx_report_lookup
     ON report_runs (report_type, local_date)`,
  `CREATE TABLE IF NOT EXISTS error_notifications (
     error_type       TEXT PRIMARY KEY,
     last_notified_at TEXT NOT NULL,
     hits             INTEGER NOT NULL DEFAULT 1
   )`,
];

// ---------------------------------------------------------------------------
// 2. 併發控制
// ---------------------------------------------------------------------------
export const CONTROL_SCHEMA = [
  // 通用 lease lock。expires_at 讓 process crash 後不會永久卡死。
  `CREATE TABLE IF NOT EXISTS resource_locks (
     name        TEXT PRIMARY KEY,
     owner       TEXT NOT NULL,
     acquired_at TEXT NOT NULL,
     expires_at  TEXT NOT NULL
   )`,

  // 報告發送權。一個 (report_type, local_date) 同時只有一個 process 拿得到。
  // telegram_sent_at 一旦寫入就是「已經送出去了」的耐久證據 —— 即使之後
  // report_runs 的 SENT 寫入失敗，也不會被重新 claim 而重發。
  `CREATE TABLE IF NOT EXISTS report_claims (
     report_type         TEXT NOT NULL,
     local_date          TEXT NOT NULL,
     owner               TEXT NOT NULL,
     claimed_at          TEXT NOT NULL,
     expires_at          TEXT NOT NULL,
     telegram_sent_at    TEXT,
     telegram_message_id INTEGER,
     PRIMARY KEY (report_type, local_date)
   )`,
];

// ---------------------------------------------------------------------------
// 3. 長期健康資料
// ---------------------------------------------------------------------------
// 共通約定：
//   *_at        一律 ISO8601 UTC 字串
//   health_date 一律 YYYY-MM-DD（當地時區），與 analyze.js 的定義完全相同
//   raw_json    保留原始 payload，未來 WHOOP 新增欄位時可回頭解析
//   synced_at   本地最後一次寫入時間（不是 WHOOP 的 updated_at）
export const HEALTH_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS whoop_sleeps (
     id                            TEXT PRIMARY KEY,
     v1_id                         INTEGER,
     user_id                       INTEGER,
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
     raw_json                      TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS idx_sleeps_health_date ON whoop_sleeps (health_date)`,
  `CREATE INDEX IF NOT EXISTS idx_sleeps_end        ON whoop_sleeps (end_at)`,
  `CREATE INDEX IF NOT EXISTS idx_sleeps_nap_date   ON whoop_sleeps (nap, health_date)`,

  `CREATE TABLE IF NOT EXISTS whoop_recoveries (
     sleep_id            TEXT PRIMARY KEY,
     cycle_id            TEXT,
     user_id             INTEGER,
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
     raw_json            TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS idx_recoveries_health_date ON whoop_recoveries (health_date)`,
  `CREATE INDEX IF NOT EXISTS idx_recoveries_cycle       ON whoop_recoveries (cycle_id)`,

  `CREATE TABLE IF NOT EXISTS whoop_cycles (
     id                 TEXT PRIMARY KEY,
     user_id            INTEGER,
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
     raw_json           TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS idx_cycles_end   ON whoop_cycles (end_at)`,
  `CREATE INDEX IF NOT EXISTS idx_cycles_start ON whoop_cycles (start_at)`,

  // 欄位完全依官方 v2 WorkoutScore schema，沒有臆造欄位。
  // sport_id 官方標為 2025-09-01 後移除，仍保留欄位以吃下舊資料。
  `CREATE TABLE IF NOT EXISTS whoop_workouts (
     id                     TEXT PRIMARY KEY,
     v1_id                  INTEGER,
     user_id                INTEGER,
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
     raw_json               TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS idx_workouts_health_date ON whoop_workouts (health_date)`,
  `CREATE INDEX IF NOT EXISTS idx_workouts_start       ON whoop_workouts (start_at)`,

  // /user/measurement/body 是單一物件（非 collection）。用 recorded_at 當版本，
  // 保留歷史變化（體重會變），不覆蓋舊值。
  `CREATE TABLE IF NOT EXISTS whoop_body_measurements (
     recorded_at     TEXT PRIMARY KEY,
     height_meter    REAL,
     weight_kilogram REAL,
     max_heart_rate  REAL,
     synced_at       TEXT NOT NULL,
     raw_json        TEXT
   )`,

  // 同步進度。每個 resource 一列，可 resume。
  `CREATE TABLE IF NOT EXISTS whoop_sync_state (
     resource          TEXT PRIMARY KEY,
     backfill_complete INTEGER NOT NULL DEFAULT 0,
     backfill_cursor   TEXT,
     earliest_synced   TEXT,
     latest_synced     TEXT,
     last_success_at   TEXT,
     last_error        TEXT,
     last_error_at     TEXT,
     updated_at        TEXT NOT NULL
   )`,

  // capability：由 probe 寫入，其他模組靠它判斷「這個帳號有沒有這個欄位」，
  // 而不是靠 membership tier。
  `CREATE TABLE IF NOT EXISTS whoop_capabilities (
     key            TEXT PRIMARY KEY,
     status         TEXT NOT NULL,
     sample_count   INTEGER,
     non_null_count INTEGER,
     latest_value   TEXT,
     first_seen_at  TEXT,
     last_seen_at   TEXT,
     last_probed_at TEXT NOT NULL,
     detail         TEXT
   )`,
];

// ---------------------------------------------------------------------------
// 4. Telegram bot / journal / 對話狀態
// ---------------------------------------------------------------------------
export const BOT_SCHEMA = [
  // 泛用 key-value。目前只放 last_update_id，但刻意保持通用，
  // 之後要記別的 worker 狀態不用再開表。
  `CREATE TABLE IF NOT EXISTS telegram_state (
     key        TEXT PRIMARY KEY,
     value      TEXT,
     updated_at TEXT NOT NULL
   )`,

  // 個人 journal。event_at 是「事情發生的時間」，health_date 是它歸屬的健康日。
  // 兩者分開：凌晨 2 點喝的酒屬於前一個健康日。
  `CREATE TABLE IF NOT EXISTS journal_events (
     id            INTEGER PRIMARY KEY AUTOINCREMENT,
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
  `CREATE INDEX IF NOT EXISTS idx_journal_health_date ON journal_events (health_date)`,
  `CREATE INDEX IF NOT EXISTS idx_journal_category    ON journal_events (category, health_date)`,
  `CREATE INDEX IF NOT EXISTS idx_journal_event_at    ON journal_events (event_at)`,

  // 待回答的追問。一個 chat 同時只該有一個 OPEN（見 store 的 openPendingQuestion）。
  `CREATE TABLE IF NOT EXISTS pending_questions (
     id               INTEGER PRIMARY KEY AUTOINCREMENT,
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
  `CREATE INDEX IF NOT EXISTS idx_pending_chat ON pending_questions (chat_id, status)`,
];

// ---------------------------------------------------------------------------
// 5. 分析基礎建設（healthspan / prediction / insight / experiment）
// ---------------------------------------------------------------------------
// 這一組是「未來要用」的骨架。這一輪只建表，不產生任何結論。
export const ANALYSIS_SCHEMA = [
  // 每個 healthspan contributor 一列。availability 讓「拿不到」與「值是 0」
  // 永遠分得清楚 —— 這正是不能靠 membership 猜能力的原因。
  `CREATE TABLE IF NOT EXISTS healthspan_metrics (
     id            INTEGER PRIMARY KEY AUTOINCREMENT,
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
     ON healthspan_metrics (calculated_at, metric_key)`,
  `CREATE INDEX IF NOT EXISTS idx_healthspan_metric_key
     ON healthspan_metrics (metric_key, calculated_at)`,

  // 未來要算 physiological age 時的一次快照。algorithm_version 讓公式可以版本化，
  // 舊快照不會因為換公式而失去意義。**這一輪不會寫入任何 score。**
  `CREATE TABLE IF NOT EXISTS healthspan_snapshots (
     id                INTEGER PRIMARY KEY AUTOINCREMENT,
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
     ON healthspan_snapshots (snapshot_date, algorithm_version)`,

  // 預測與事後對帳。predicted 先寫入，actual 之後 backfill，才能算 MAE/RMSE。
  `CREATE TABLE IF NOT EXISTS prediction_runs (
     id              INTEGER PRIMARY KEY AUTOINCREMENT,
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
     ON prediction_runs (target_date, target_metric, model_version)`,

  // 長期 insight 記憶。supersedes_id 形成版本鏈，舊版本不刪除。
  `CREATE TABLE IF NOT EXISTS health_insights (
     id                  INTEGER PRIMARY KEY AUTOINCREMENT,
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
  `CREATE INDEX IF NOT EXISTS idx_insight_subject ON health_insights (subject, status)`,
  `CREATE INDEX IF NOT EXISTS idx_insight_active  ON health_insights (status, insight_type)`,

  // 自我實驗。protocol_json 保留彈性，不用一開始就把欄位訂死。
  `CREATE TABLE IF NOT EXISTS experiments (
     id             INTEGER PRIMARY KEY AUTOINCREMENT,
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
  `CREATE INDEX IF NOT EXISTS idx_experiment_status ON experiments (status)`,
];

// ---------------------------------------------------------------------------
// 6. AI 用量 / 成本帳本
// ---------------------------------------------------------------------------
export const LEDGER_SCHEMA = [
  // 每一次 OpenRouter 呼叫一列。
  //
  // 刻意允許 token 與 cost 為 NULL：如果 provider 沒有回 usage，
  // 就誠實記 null。**絕不用「猜的 token 數」填進資料庫** ——
  // 那會讓成本報表看起來很精確，其實是編的。
  //
  // requested_model / model 分開記：model routing 有 fallback，
  // 事後要能分辨「我要的」與「實際跑的」是不是同一個。
  `CREATE TABLE IF NOT EXISTS ai_usage (
     id                 INTEGER PRIMARY KEY AUTOINCREMENT,
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
  `CREATE INDEX IF NOT EXISTS idx_ai_usage_ts      ON ai_usage (timestamp)`,
  `CREATE INDEX IF NOT EXISTS idx_ai_usage_purpose ON ai_usage (purpose, timestamp)`,
];

/** migrate() 實際執行的完整順序。 */
export const SCHEMA = [
  ...CORE_SCHEMA,
  ...CONTROL_SCHEMA,
  ...HEALTH_SCHEMA,
  ...BOT_SCHEMA,
  ...ANALYSIS_SCHEMA,
  ...LEDGER_SCHEMA,
];
