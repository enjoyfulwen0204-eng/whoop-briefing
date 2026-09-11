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
// v3：新增 Proactive Agent 的兩張表。刻意**明確 bump 版本**而不是只依賴
// 「SCHEMA 的 CREATE TABLE IF NOT EXISTS 每次都會跑」這個副作用——
// 版本化之後，proactive_agent_state 才會進入 RESHAPED_TABLES 的形狀檢查，
// 開發機上那種「舊三欄版本」的表才會被安全重建（空表才重建，有資料會中止）。
//
// v7：telegram_operations 加上**送達**狀態機的欄位。純加欄位，走 ADDITIVE_COLUMNS，
//     既有資料原封不動（回填成 DELIVERED —— 既有的收據都是已經送完的）。
//
// v5：telegram_processed_updates 加上處理狀態機的欄位（R3-M-05）。純加欄位，
//     走 ADDITIVE_COLUMNS，既有資料原封不動（回填成 COMPLETED）。
//
// v4：新增 system_heartbeats（運維觀測）與 prediction_models（預測成熟度）。
// **兩張都是純新增**，不動任何既有表的形狀，所以：
//   - 沒有任何 DROP、沒有 rename、沒有欄位型別變更
//   - 兩張表都**刻意不加進 RESHAPED_TABLES**——那份清單的用途是「這張表
//     以前存在過別的形狀」，而這兩張表在任何環境都是第一次出現。把全新的
//     表加進去只會平白武裝一條它永遠不該走的 DROP 路徑。
/**
 * 一則 Telegram update 的持久化處理狀態（R3-M-05）。
 *
 * 「收到」不是一個狀態，因為在我們寫下任何東西之前，訊息的耐久性是由
 * Telegram 自己保證的（沒有推進 offset 就會再送一次）。我們的第一個
 * 持久化事實就是 CLAIMED。
 *
 *   CLAIMED    我拿到所有權了，**還沒有 dispatch**，所以保證零副作用。
 *              → 租約過期後可以被安全地重新認領（重做沒有任何代價）。
 *   PROCESSING 已經 dispatch，副作用可能已經發生。
 *              → 租約過期代表有人做到一半死了，**不可以自動重做**
 *                （會寫出第二筆 journal，而 journal 的重複永遠不會自己修好）。
 *   COMPLETED  終局：確定做完了。
 *   ABANDONED  終局：在 PROCESSING 階段失去所有權，做到哪裡不確定。
 *              明確記下來讓人可以查，而不是靜靜地消失。
 */
export const TELEGRAM_UPDATE_STATUS = {
  CLAIMED: 'CLAIMED',
  PROCESSING: 'PROCESSING',
  COMPLETED: 'COMPLETED',
  ABANDONED: 'ABANDONED',
};

/**
 * 一則回覆的**送達**狀態（與 update 的處理狀態分開）。
 *
 * ## 為什麼需要它
 *
 * 舊版的順序是「提交動作 → 送出 Telegram → 標記 COMPLETED」。中間死掉的話，
 * 資料庫裡看起來只是「PROCESSING 而且租約過期」—— 完全分不出來是
 * **還沒送**還是**已經送出去了**。那兩種情況的正確處置正好相反：
 * 前者要重送，後者重送就是使用者收到兩則一模一樣的健康建議。
 *
 * 所以送達本身必須是一個持久化的事實，而且要在**真的打網路之前**先寫下來。
 *
 *   NOT_REQUIRED     這一則本來就不需要回覆（被閘門擋下、未綁定且無話可說）
 *   ACTION_READY     動作已提交、回覆已產生，**還沒開始送**  → 可以安全地送
 *   DELIVERY_STARTED 已經要打網路了，結果未知              → **不可以自動重送**
 *   DELIVERED        Telegram 明確回報成功，message_id 已存 → 完成
 *   AMBIGUOUS        網路層結果不明（逾時／連線被重置）     → **不可以自動重送**
 *
 * DELIVERY_STARTED 與 AMBIGUOUS 是同一件事的兩個時間點：前者是「我們死在
 * 送出過程中」，後者是「我們活著但拿不到答案」。兩者都代表 Telegram 可能
 * 已經收下了，所以都不自動重送。
 */
export const TELEGRAM_DELIVERY_STATE = Object.freeze({
  NOT_REQUIRED: 'NOT_REQUIRED',
  ACTION_READY: 'ACTION_READY',
  DELIVERY_STARTED: 'DELIVERY_STARTED',
  DELIVERED: 'DELIVERED',
  AMBIGUOUS: 'AMBIGUOUS',
});

export const SCHEMA_VERSION = 7;

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

  // 已經處理過的 Telegram update（M-09）。
  //
  // ## 為什麼光有 offset 不夠
  //
  // polling.js 有三層不重複機制，但全部建立在「offset 存得下去」上。
  // 每一則訊息的流程是：處理（寫 journal、跑分析、送訊息）→ 存 offset。
  // 這是**兩段寫入**，中間 worker 被殺（部署、OOM、SIGKILL）的話，
  // offset 還是舊的，Telegram 會把同一則 update 再送一次，於是同一句
  // 「喝了兩杯」被寫成兩筆 journal。實測確認：重送一次 → 2 筆。
  //
  // 而 journal 是所有長期關聯分析的輸入，重複的曝露日會直接扭曲相關係數。
  //
  // 解法沿用系統裡已經在用的同一套：**在副作用之前原子認領**
  // （proactive_events.idempotency_key、pending_questions 的條件式 UPDATE
  // 都是同一個模式）。這裡的認領鍵就是 update_id 本身。
  //
  // 刻意**不**分 user：update_id 對一個 bot 是全域唯一且遞增的，
  // 而且認領必須發生在身分解析之前之後都安全的位置。純新增表，零風險。
  //
  // ★ R3-M-05：一列的**存在**曾經同時代表「認領了」和「做完了」。
  //
  // 那兩件事在崩潰的時候會分開，而分開的時候後果相反：
  //   - 認領完、還沒 dispatch 就死 → 這則訊息其實一件事都沒做，
  //     但重送時看到列就被當成重複 → **永久遺失**（實測重現）。
  //   - 副作用做完、還沒標記完成就死 → 重做會寫出第二筆 journal。
  //
  // 所以狀態必須是持久化且分階段的，而且要有 owner + 租約，
  // 才能分辨「別人正在做」與「有人做到一半死了」。
  `CREATE TABLE IF NOT EXISTS telegram_processed_updates (
     update_id        INTEGER PRIMARY KEY,
     processed_at     TEXT,
     status           TEXT NOT NULL DEFAULT '${TELEGRAM_UPDATE_STATUS.COMPLETED}',
     owner            TEXT,
     claimed_at       TEXT,
     lease_expires_at TEXT,
     dispatched_at    TEXT,
     attempts         INTEGER NOT NULL DEFAULT 1,
     -- 這一則屬於誰（身分解析出來之後才寫）。用途只有一個：**同一個人的
     -- 訊息要照順序處理**。沒有它就沒辦法問「這個人還有沒有更早、還沒做完
     -- 的訊息」，而那正是「澄清回覆不可以超車」的判準。
     user_id          TEXT
   )`,
];

/**
 * 既有資料庫的加欄位遷移（R3-M-05）。
 *
 * telegram_processed_updates 在正式環境是**有資料**的（每一則處理過的
 * update 都在裡面），所以不能走 RESHAPED_TABLES 的「空表才重建」路徑 ——
 * 那條路徑遇到有資料的表會直接中止 migration。
 *
 * ALTER TABLE ADD COLUMN 在 SQLite 是 O(1) 的中繼資料變更，不重寫資料列，
 * 而且可以重複執行（先檢查欄位在不在）。既有的列一律回填成 COMPLETED：
 * 它們的語義本來就是「這則已經處理完了」。
 */
export const ADDITIVE_COLUMNS = [
  {
    table: 'telegram_processed_updates',
    column: 'status',
    ddl: `ALTER TABLE telegram_processed_updates ADD COLUMN status TEXT NOT NULL DEFAULT '${TELEGRAM_UPDATE_STATUS.COMPLETED}'`,
  },
  { table: 'telegram_processed_updates', column: 'owner', ddl: 'ALTER TABLE telegram_processed_updates ADD COLUMN owner TEXT' },
  { table: 'telegram_processed_updates', column: 'claimed_at', ddl: 'ALTER TABLE telegram_processed_updates ADD COLUMN claimed_at TEXT' },
  { table: 'telegram_processed_updates', column: 'lease_expires_at', ddl: 'ALTER TABLE telegram_processed_updates ADD COLUMN lease_expires_at TEXT' },
  { table: 'telegram_processed_updates', column: 'dispatched_at', ddl: 'ALTER TABLE telegram_processed_updates ADD COLUMN dispatched_at TEXT' },
  { table: 'telegram_processed_updates', column: 'attempts', ddl: 'ALTER TABLE telegram_processed_updates ADD COLUMN attempts INTEGER NOT NULL DEFAULT 1' },

  // v7：送達狀態機。既有的 telegram_operations 列都是「動作提交了、回覆也送完了」
  // 才會留下來的，所以預設回填成 DELIVERED —— 不可以讓遷移把歷史紀錄變成
  // 「還沒送」而觸發重送。
  { table: 'telegram_processed_updates', column: 'user_id', ddl: 'ALTER TABLE telegram_processed_updates ADD COLUMN user_id TEXT' },
  {
    table: 'telegram_operations',
    column: 'delivery_state',
    ddl: `ALTER TABLE telegram_operations ADD COLUMN delivery_state TEXT NOT NULL DEFAULT '${TELEGRAM_DELIVERY_STATE.DELIVERED}'`,
  },
  { table: 'telegram_operations', column: 'delivery_owner', ddl: 'ALTER TABLE telegram_operations ADD COLUMN delivery_owner TEXT' },
  { table: 'telegram_operations', column: 'delivery_started_at', ddl: 'ALTER TABLE telegram_operations ADD COLUMN delivery_started_at TEXT' },
  { table: 'telegram_operations', column: 'delivered_at', ddl: 'ALTER TABLE telegram_operations ADD COLUMN delivered_at TEXT' },
  { table: 'telegram_operations', column: 'telegram_message_id', ddl: 'ALTER TABLE telegram_operations ADD COLUMN telegram_message_id INTEGER' },
  { table: 'telegram_operations', column: 'delivery_attempts', ddl: 'ALTER TABLE telegram_operations ADD COLUMN delivery_attempts INTEGER NOT NULL DEFAULT 0' },
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

// ---------------------------------------------------------------------------
// 9. Proactive Agent（per-user）——純新增表，不動任何既有表
// ---------------------------------------------------------------------------
export const PROACTIVE_SCHEMA = [
  // cron 每次同步後，「這個使用者上次檢查到哪一天」的游標。
  // 沒有這張表就無法判斷「這次 sync 有沒有帶來新的 health_date」，
  // 會變成每次 cron 都重新跑一次訊號偵測（即使資料完全沒變）。
  // `enabled` 是 per-user 的主動訊息開關（1=開，預設開）。刻意放在這張
  // **全新的**表而不是 ALTER 既有的 users 表：這張表在 production 還不存在，
  // 加欄位等於零風險；而且「要不要被主動打擾」本來就是 proactive agent
  // 自己的狀態，不是身分資料。
  //
  // `last_fingerprint` 是「上次分析過的生理內容指紋」——只比對 health_date
  // 會漏掉 WHOOP 事後改分（同一天、同一筆 sleep，recovery 才剛被評分）。
  `CREATE TABLE IF NOT EXISTS proactive_agent_state (
     user_id                   TEXT PRIMARY KEY,
     last_checked_health_date  TEXT,
     last_fingerprint          TEXT,
     enabled                   INTEGER NOT NULL DEFAULT 1,
     updated_at                TEXT NOT NULL
   )`,

  // 主動事件的稽核軌跡，同時也是冪等鍵與反騷擾政策的資料來源。
  //
  // idempotency_key 由「health_date + policy 版本」決定性算出來
  // （見 src/proactiveAgent.js），UNIQUE(user_id, idempotency_key) 保證：
  //   - 同一個使用者、同一個 health_date、同一版政策，只會有一列
  //   - cron 重跑 / worker 重啟時，重算出一樣的 key → INSERT 失敗 →
  //     視為「已經處理過」，不會重複發送 Telegram 訊息
  //
  // 這是刻意選擇的「at-most-once」語意：寧可極端情況下漏發一次，
  // 也不要對同一件事重複打擾使用者。詳見 docs/proactive-agent.md。
  `CREATE TABLE IF NOT EXISTS proactive_events (
     id                  INTEGER PRIMARY KEY AUTOINCREMENT,
     user_id             TEXT NOT NULL,
     health_date         TEXT NOT NULL,
     idempotency_key     TEXT NOT NULL,
     signals_json        TEXT,
     decision            TEXT NOT NULL,
     reason_json         TEXT,
     policy_version      TEXT NOT NULL,
     pending_question_id INTEGER,
     -- 這個主動問題最後促成了哪一筆 journal_events（可追溯性：
     -- 哪個問題 → 哪筆 Journal → 哪次重新分析）。刻意放在這張新表而不是
     -- ALTER journal_events：新表加欄位零風險。
     journal_event_id    INTEGER,
     message_text        TEXT,
     sent_at             TEXT,
     created_at          TEXT NOT NULL,
     resolved_at         TEXT,
     outcome             TEXT
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uniq_proactive_event
     ON proactive_events (user_id, idempotency_key)`,
  `CREATE INDEX IF NOT EXISTS idx_proactive_user_created
     ON proactive_events (user_id, created_at)`,
];

// ---------------------------------------------------------------------------
// 10. 運維觀測（v4 新增）—— 純新增表，不動任何既有表
// ---------------------------------------------------------------------------
export const GUARDIAN_SCHEMA = [
  // 「某個元件最後一次成功運作是什麼時候」。
  //
  // 為什麼需要一張新表：系統裡幾乎所有**故障**的原始事實都已經有地方存了
  // （whoop_sync_state.last_error、report_runs.status、ai_usage.request_status
  // …），唯獨「這一輪 cron 真的有跑」這件事沒有任何紀錄——而那正是最需要
  // 被監看的一件事，因為 cron 死掉時是**安靜地**死。沒有 run 就沒有錯誤。
  //
  // scope 沿用 error_notifications 已經在用的同一套語彙：
  //   scope = 'global'        → cron / worker 這類不屬於任何人的元件
  //   scope = 'user:<userId>' → 某個使用者的同步、主動代理…
  //
  // 刻意**不用 `user_id TEXT NULL` 當主鍵的一部分**：SQLite 的 UNIQUE 把
  // NULL 視為互不相同，所以 (component, NULL) 可以重複插入無限多列，
  // ON CONFLICT 也永遠對不上。error_notifications 當初就是為了這個問題
  // 才用 scope 字串，這裡沿用同一個解法，不另外發明。
  `CREATE TABLE IF NOT EXISTS system_heartbeats (
     scope       TEXT NOT NULL,
     component   TEXT NOT NULL,
     last_ok_at  TEXT NOT NULL,
     last_detail TEXT,
     updated_at  TEXT NOT NULL,
     PRIMARY KEY (scope, component)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_heartbeat_component
     ON system_heartbeats (component, last_ok_at)`,
];

// ---------------------------------------------------------------------------
// 11. 預測模型成熟度（v4 新增）—— 純新增表，不動 prediction_runs
// ---------------------------------------------------------------------------
export const PREDICTION_MODEL_SCHEMA = [
  // 「某一次訓練出來的模型長什麼樣、表現如何、夠不夠格發布」。
  //
  // 刻意跟 prediction_runs **分開**：那張表記的是「某一天的預測與它的實際
  // 值」（run 層），這張記的是「模型本身」（model 層）。把模型層的統計混進
  // run 層會讓每一列都重複同一份 MAE/RMSE，而且無法表達「模型還在，但今天
  // 沒有產生預測」。
  //
  // qualified 預設 0：**沒有被證明夠好之前一律不夠格**。這不是保守的預設值
  // 而已，是這張表的核心語義——見 predictionPolicy.js 的 fail-closed 說明。
  `CREATE TABLE IF NOT EXISTS prediction_models (
     id                  INTEGER PRIMARY KEY AUTOINCREMENT,
     user_id             TEXT NOT NULL,
     target_metric       TEXT NOT NULL,
     model_version       TEXT NOT NULL,
     features_json       TEXT,
     trained_at          TEXT NOT NULL,
     train_start         TEXT,
     train_end           TEXT,
     test_start          TEXT,
     test_end            TEXT,
     n_train             INTEGER,
     n_test              INTEGER,
     mae                 REAL,
     rmse                REAL,
     r2                  REAL,
     interval_coverage   REAL,
     baseline_kind       TEXT,
     baseline_mae        REAL,
     beats_baseline      INTEGER,
     maturity            TEXT NOT NULL,
     qualified           INTEGER NOT NULL DEFAULT 0,
     unqualified_reason  TEXT,
     policy_version      TEXT,
     created_at          TEXT NOT NULL
   )`,
  // 冪等鍵：同一個使用者、同一個目標、同一版模型、同一段訓練資料
  // （train_end 由資料決定，不是由時鐘決定）→ 重跑只會更新同一列。
  // 所以「cron 每 30 分鐘重算一次」不會長出一堆重複的模型列。
  `CREATE UNIQUE INDEX IF NOT EXISTS uniq_prediction_model
     ON prediction_models (user_id, target_metric, model_version, train_end)`,
  `CREATE INDEX IF NOT EXISTS idx_prediction_model_latest
     ON prediction_models (user_id, target_metric, trained_at)`,
];

/** Attention Engine 的決策列舉（IGNORE 不落地，其餘都會寫進 proactive_events）。 */
export const PROACTIVE_DECISION = {
  IGNORE: 'IGNORE',
  LOG_ONLY: 'LOG_ONLY',
  ASK_CONTEXT: 'ASK_CONTEXT',
  NOTIFY: 'NOTIFY',
  FOLLOW_UP: 'FOLLOW_UP',
};

/**
 * proactive_events.outcome 的允許值——事後 reanalysis 或收割器才會填。
 *
 * 前四個是「對話真的走完了」的結果。後兩個（M-03）是**收斂用的終局**：
 * 有些狀態下這個事件永遠不可能再被正常流程結案，但它仍然必須有一個
 * 誠實的終局，否則會永遠停在 NULL，讓 Guardian 每 12 小時誤報一次。
 *
 * 刻意**不**把後兩者併進 NO_RESPONSE：那會是事實錯誤（使用者其實回了，
 * 或這題根本沒機會被回答），而 proactivePolicy 未來要拿 NO_RESPONSE 的
 * 比例去調門檻——污染它等於用假資料調整騷擾程度。
 */
export const PROACTIVE_OUTCOME = {
  STILL_UNEXPLAINED: 'STILL_UNEXPLAINED',
  EXPLAINED: 'EXPLAINED',
  NO_EXPLANATION_OFFERED: 'NO_EXPLANATION_OFFERED',
  NO_RESPONSE: 'NO_RESPONSE',
  /** 這題還沒被回答就被新的追問取代了。不是「沒回應」。 */
  SUPERSEDED: 'SUPERSEDED',
  /** 使用者確實回答了，但處理流程中途死掉，沒有走到真正的結論。 */
  ABANDONED: 'ABANDONED',
  /**
   * 送出去了，而且**本來就沒有要問任何問題**（M-07）。
   *
   * NOTIFY 這類決策只是通知一句話，不會開追問，所以沒有人該回答它。
   * 舊版讓這種事件的 outcome 永遠停在 NULL，而 Guardian 的「卡住」判準
   * 正是 `sent_at IS NOT NULL AND outcome IS NULL` —— 於是每一則正常送出
   * 的通知都會變成一筆永久的假警報。送出即終局。
   */
  DELIVERED: 'DELIVERED',
};

/** pending_questions.intent 用這個值標記「這是主動代理發起的問題」。 */
export const PROACTIVE_QUESTION_INTENT = 'proactive_signal';

/** migrate() 實際執行的完整順序。 */
export const SCHEMA = [
  // Result and all database actions commit together. Retained independently of
  // transport claim pruning; replay never repeats an already committed action.
  // 動作收據 + 送達收據。
  //
  // result_json 是「這一則 update 的處理結果」（含要送出去的回覆文字），與動作
  // 在同一個交易裡提交 —— 所以重播會拿回同一份結果而不會把動作再做一次。
  //
  // delivery_* 是**送達**那一段的狀態機（見 TELEGRAM_DELIVERY_STATE）。
  // 它必須與 result_json 分開，因為「動作做完了」和「回覆送到了」是兩件在
  // 崩潰時會分開、而且處置相反的事。
  `CREATE TABLE IF NOT EXISTS telegram_operations (
     update_id            INTEGER PRIMARY KEY,
     result_json          TEXT NOT NULL,
     committed_at         TEXT NOT NULL,
     delivery_state       TEXT NOT NULL DEFAULT '${TELEGRAM_DELIVERY_STATE.ACTION_READY}',
     delivery_owner       TEXT,
     delivery_started_at  TEXT,
     delivered_at         TEXT,
     telegram_message_id  INTEGER,
     delivery_attempts    INTEGER NOT NULL DEFAULT 0
   )`,
  ...VERSION_SCHEMA,
  ...IDENTITY_SCHEMA,
  ...TOKEN_SCHEMA,
  ...GLOBAL_SCHEMA,
  ...REPORT_SCHEMA,
  ...HEALTH_SCHEMA,
  ...BOT_SCHEMA,
  ...ANALYSIS_SCHEMA,
  ...LEDGER_SCHEMA,
  ...PROACTIVE_SCHEMA,
  ...GUARDIAN_SCHEMA,
  ...PREDICTION_MODEL_SCHEMA,
];

/** 使用者狀態。 */
export const USER_STATUS = { ACTIVE: 'ACTIVE', PAUSED: 'PAUSED', DISABLED: 'DISABLED' };

/** Telegram 綁定狀態。 */
/**
 * user_telegram.status。
 *
 * RETIRED_UNSAFE 是 R2-H-01 新增的：歷史遺留的群組綁定不可以被刪掉
 * （那會讓運維看不出發生過什麼事），但也絕不可以再被選為遞送目的地。
 * 改狀態是**唯一**需要的動作 —— 任何健康資料都不會被碰到，
 * 而且對方重新在私訊裡 /link 就能恢復。
 */
export const LINK_STATUS = {
  ACTIVE: 'ACTIVE',
  REVOKED: 'REVOKED',
  RETIRED_UNSAFE: 'RETIRED_UNSAFE',
};

/**
 * 這個 Telegram chat id 可以安全地接收**私人生理資料**嗎（R2-H-01）。
 *
 * ## 為什麼需要一個結構性判準，而不是查一個欄位
 *
 * `user_telegram` 沒有存 chat 型態，而且**不能假設 migration 清理過歷史
 * 資料**：舊版的 `/link` 在群組裡送出就會成功，所以資料庫裡可能已經躺著
 * 一筆指向群組的 ACTIVE 綁定。入站身分邊界（polling.js）已經守住了，
 * 但**出站遞送**完全沒有守 —— `getActiveChatIdForUser()` 照樣會把那個
 * 群組 id 交給 daily / weekly / 主動訊息 / Guardian。實測確認。
 *
 * Telegram 的 chat id 有一個**保證**的結構性質：
 *
 *   私訊 chat 的 id **就是對方的 user id**，永遠是正整數。
 *   群組 / 超級群組 / 頻道的 id 永遠是負數。
 *
 * 所以「正整數」是一個不需要列舉、也不需要新欄位的判準。任何不是正整數
 * 的東西（負數、0、空值、非數字、小數、超出安全整數範圍）一律視為不安全
 * —— fail closed，不猜。
 *
 * @returns {boolean}
 */
export function isSafePrivateChatId(chatId) {
  if (chatId === null || chatId === undefined) return false;
  if (typeof chatId === 'boolean' || typeof chatId === 'object') return false;
  const raw = String(chatId).trim();
  // 只接受純數字（允許前導 +），不接受空白、小數點、指數、任何符號
  if (!/^\+?\d+$/.test(raw)) return false;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0;
}

/** 不安全的原因（只用於 log / 運維說明，絕不回給使用者）。 */
export function unsafeChatReason(chatId) {
  if (chatId === null || chatId === undefined || String(chatId).trim() === '') return 'missing';
  const raw = String(chatId).trim();
  if (!/^[+-]?\d+$/.test(raw)) return 'not_numeric';
  const n = Number(raw);
  if (!Number.isSafeInteger(n)) return 'out_of_safe_range';
  if (n < 0) return 'group_or_channel';
  if (n === 0) return 'zero';
  return 'safe';
}

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
  // v3 期間加了 last_fingerprint / enabled / journal_event_id。production 還
  // 沒有這兩張表（會直接以新形狀建立），這裡是為了保護「已經建過舊形狀」
  // 的開發機資料庫：空表就重建，有資料一樣會中止並要求人工處理。
  { table: 'proactive_agent_state', requiredColumn: 'enabled' },
  { table: 'proactive_events', requiredColumn: 'journal_event_id' },
];

/** 舊的 single-user 表，被取代後留著不刪（0 列，無害）。 */
export const LEGACY_TABLES = ['whoop_tokens', 'app_state'];
