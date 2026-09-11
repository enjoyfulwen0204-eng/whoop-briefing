/**
 * 全系統唯一的設定 / 門檻來源。
 *
 * 重要原則：所有「好壞判斷」都在這裡定義、由 Node 計算。
 * AI 教練只負責把算好的結果講成人話，永遠不決定顏色或嚴重度。
 */

// ---------------------------------------------------------------------------
// 1. 三級嚴重度門檻（寫死，改這裡就好）
// ---------------------------------------------------------------------------
//   dir: 'higher'   → 越高越好，用「低於基準的百分比」判斷（門檻是負數）
//   dir: 'lower'    → 越低越好，用「高於基準的百分比」判斷（門檻是正數）
//   dir: 'absMin'   → 用「與基準的絕對分鐘數差」判斷（避免 baseline=0 時除零爆炸）
//   dir: 'none'     → 只顯示數值與差異，不給紅黃燈
export const THRESHOLDS = {
  // 一般 higher-is-better：黃 < -8%、紅 < -18%
  recovery_score:    { dir: 'higher', yellow: -8,  red: -18 },
  sleep_total:       { dir: 'higher', yellow: -8,  red: -18 },
  slow_wave:         { dir: 'higher', yellow: -8,  red: -18 },
  rem:               { dir: 'higher', yellow: -8,  red: -18 },
  sleep_performance: { dir: 'higher', yellow: -8,  red: -18 },
  sleep_consistency: { dir: 'higher', yellow: -8,  red: -18 },
  sleep_efficiency:  { dir: 'higher', yellow: -8,  red: -18 },

  // HRV：黃 < -7%、紅 < -15%
  hrv:               { dir: 'higher', yellow: -7,  red: -15 },

  // RHR：黃 > +5%、紅 > +10%
  rhr:               { dir: 'lower',  yellow: 5,   red: 10 },

  // 呼吸率：黃 > +4%、紅 > +8%
  respiratory_rate:  { dir: 'lower',  yellow: 4,   red: 8 },

  // 擾動次數：lower-is-better（規格未指定數字，沿用一般 8% / 18%）
  disturbance_count: { dir: 'lower',  yellow: 8,   red: 18 },

  // 睡眠債加成：不除 baseline（可能為 0），用絕對分鐘差
  // 比基準多 30 分 → 黃；多 90 分 → 紅
  sleep_debt:        { dir: 'absMin', yellow: 30,  red: 90 },

  // 第一版只顯示數值 + 與基準差異，不給燈
  spo2:              { dir: 'none' },
  skin_temp:         { dir: 'none' },
  strain:            { dir: 'none' },
};

// ---------------------------------------------------------------------------
// 2. Baseline / 冷啟動 / 觸發 相關常數（寫死）
// ---------------------------------------------------------------------------
export const BASELINE = {
  TARGET_SAMPLES: 30,     // 基準取「最近 30 筆有效紀錄」（不是 30 個日曆天）
  LOOKBACK_DAYS: 45,      // 為避開缺資料，抓最近 45 天再挑最近 30 筆有效
  MIN_FOR_LIGHTS: 7,      // < 7 筆：只顯示數據，不給紅黃燈
  MIN_PER_METRIC: 7,      // 單一指標樣本數不足 7 也不給該指標的燈
};

export const WAKE = {
  MIN_MINUTES_AFTER_SLEEP_END: 30, // 起床後至少 30 分鐘才發（直接比 UTC timestamp）
  POLL_LOOKBACK_DAYS: 5,           // polling 只抓最近幾天的最新資料
  // 允許補發的期限：sleep.end 距現在超過這個時數就不發了。
  // 這條取代舊的「睡眠結束日必須等於執行當天」—— 晚起床 / 跨午夜也能補發，
  // 但不會把幾天前的舊資料重新報一次。防重複靠 health_date 去重。
  MAX_AGE_HOURS: 24,
};

export const TREND = {
  // 連續 3 個「逐日相鄰」的 health_date。缺一天就中斷，不會跳過缺日去湊。
  WINDOW: 3,
  MIN_STAGE: 'full',      // 只有正式 baseline（>=30 筆）才做趨勢預警
  // 兩個以上生理訊號同時異常 → 較強提醒
  STRONG_PAIRS: [
    ['hrv', 'rhr'],
    ['hrv', 'respiratory_rate'],
  ],
  METRICS: ['hrv', 'rhr', 'respiratory_rate', 'recovery_score'],
};

export const ERROR_NOTIFY_COOLDOWN_HOURS = 2;

// GitHub 會在 repo 連續 60 天無 commit 時自動停用 scheduled workflow，
// 而且是安靜地停 —— 沒有 run 就沒有錯誤通知。所以提前用 Telegram 提醒。
// 只在 GitHub Actions 環境生效（靠 REPO_LAST_COMMIT_AT 這個變數，由 workflow 注入）。
// Multi-user cron：同時處理幾個使用者。保守起見預設 3，避免撞 WHOOP rate limit
// （官方 100 req/分）。可用 MAX_USER_CONCURRENCY 覆寫。
export const CRON = { MAX_USER_CONCURRENCY: 3 };

export const REPO_FRESHNESS = {
  WARN_AFTER_DAYS: 55,
  DISABLE_AFTER_DAYS: 60,
  NOTIFY_COOLDOWN_HOURS: 24, // 同一天最多提醒一次
};

export const TELEGRAM_MAX_CHARS = 4096;

export const COACH = {
  DAILY_MAX_TOKENS: 1200,   // 新 tokenizer 約多 30% token，抓足夠但不過大
  WEEKLY_MAX_TOKENS: 1800,
  // OpenRouter 的 model id 要帶 namespace，清單見 https://openrouter.ai/models
  DEFAULT_MODEL: 'anthropic/claude-sonnet-5',
  BASE_URL: 'https://openrouter.ai/api/v1',
  TIMEOUT_MS: 60_000,
  MAX_RETRIES: 3,           // 429 / 5xx / 連線錯誤才重試
  MAX_BACKOFF_MS: 30_000,
};

// 每週回顧只在週一發；若當天沒抓到睡眠（沒戴錶等），過了這個台灣時間仍會補發
export const WEEKLY = {
  WEEKDAY: 1,                    // 1 = 週一
  FALLBACK_SEND_AFTER_HOUR: 12,  // 台灣時間 12:00 之後就算沒偵測到起床也補發
  // 補發寬限：週一當天沒發成功（系統故障 / 沒戴錶）時，還可以往後補幾天。
  // 1 = 只有週一；3 = 週一、週二、週三都可以補發「上一個完整週」。
  // 週 key 仍然是上週一的日期，配合 uniq_report_sent 保證一週只發一次。
  CATCHUP_DAYS: 3,
};

// 「昨日 Strain」：從主睡眠 sleep.end 往「前」找最近一個已完成 cycle，
// 最多往前找這麼久。超過就視為過期 → 該健康日的 Strain 記為 null。
// 刻意是單向的（只往前找）：結束在起床「之後」的 cycle 不是昨天的負荷。
export const STRAIN = { MAX_CYCLE_AGE_MS: 48 * 60 * 60 * 1000 };

// ---------------------------------------------------------------------------
// 3. WHOOP API
// ---------------------------------------------------------------------------
export const WHOOP = {
  AUTH_URL: 'https://api.prod.whoop.com/oauth/oauth2/auth',
  TOKEN_URL: 'https://api.prod.whoop.com/oauth/oauth2/token',
  API_BASE: 'https://api.prod.whoop.com/developer/v2',
  // 注意單複數。offline 必要，否則不給 refresh token。
  // read:profile 用於 OAuth 後的 /user/profile/basic 身分驗證。
  // read:workout / read:body_measurement 是後來加的 —— 既有 token 不會自動
  // 取得新 scope，必須重跑一次 `npm run authorize`。在那之前相關 endpoint
  // 會回 401/403，由 capability probe 標成 UNAUTHORIZED，簡報不受影響。
  SCOPES: 'offline read:recovery read:cycles read:sleep read:workout read:profile read:body_measurement',
  PAGE_LIMIT: 25,          // collection 每頁最多 25 筆
  MAX_PAGES: 12,           // 45 天 * 每天 1~2 筆，12 頁綽綽有餘（安全上限）
  TOKEN_REFRESH_SKEW_MS: 5 * 60 * 1000, // 還有 >5 分鐘效期就直接重用
  MAX_RETRIES: 4,
  MAX_BACKOFF_MS: 60_000,
};

// ---------------------------------------------------------------------------
// 4. 指標登錄表（唯一定義處：怎麼取值、怎麼顯示、用哪個門檻）
// ---------------------------------------------------------------------------
//  source: 'sleep' | 'recovery' | 'cycle'
//  get:    從那筆原始 WHOOP 資料取出數值（拿不到就回 null）
//  fmt:    顯示格式
//  tier:   'core' 一定顯示（缺資料就標「無資料」）；'optional' 有值才顯示
export const METRICS = [
  {
    key: 'recovery_score', label: '恢復', emoji: '💪', tier: 'core',
    source: 'recovery', header: true,
    get: (r) => num(r?.score?.recovery_score),
    fmt: (v) => `${Math.round(v)}%`,
  },
  {
    key: 'strain', label: '昨日 Strain', emoji: '🔥', tier: 'core',
    source: 'cycle',
    get: (c) => num(c?.score?.strain),
    fmt: (v) => v.toFixed(1),
  },
  {
    key: 'hrv', label: 'HRV', emoji: '❤️', tier: 'core',
    source: 'recovery',
    get: (r) => num(r?.score?.hrv_rmssd_milli),
    fmt: (v) => `${Math.round(v)}ms`,
  },
  {
    key: 'rhr', label: '靜息心率', emoji: '💓', tier: 'core',
    source: 'recovery',
    get: (r) => num(r?.score?.resting_heart_rate),
    fmt: (v) => `${Math.round(v)}bpm`,
  },
  {
    key: 'respiratory_rate', label: '呼吸率', emoji: '🫁', tier: 'core',
    source: 'sleep',
    get: (s) => num(s?.score?.respiratory_rate),
    fmt: (v) => v.toFixed(1),
  },
  {
    // 睡眠總時長 = light + slow_wave(深睡) + REM，不含 awake / no-data，
    // 也不用 total_in_bed_time。
    key: 'sleep_total', label: '睡眠', emoji: '🌙', tier: 'core',
    source: 'sleep',
    get: (s) => {
      const g = s?.score?.stage_summary;
      if (!g) return null;
      const light = num(g.total_light_sleep_time_milli);
      const sws = num(g.total_slow_wave_sleep_time_milli);
      const rem = num(g.total_rem_sleep_time_milli);
      if (light === null && sws === null && rem === null) return null;
      return (light ?? 0) + (sws ?? 0) + (rem ?? 0);
    },
    fmt: (v) => formatDuration(v),
  },
  {
    key: 'slow_wave', label: '深睡', emoji: '😴', tier: 'core',
    source: 'sleep',
    get: (s) => num(s?.score?.stage_summary?.total_slow_wave_sleep_time_milli),
    fmt: (v) => formatDuration(v),
  },
  {
    key: 'rem', label: 'REM', emoji: '🧠', tier: 'core',
    source: 'sleep',
    get: (s) => num(s?.score?.stage_summary?.total_rem_sleep_time_milli),
    fmt: (v) => formatDuration(v),
  },
  {
    key: 'sleep_performance', label: '睡眠表現', emoji: '📈', tier: 'core',
    source: 'sleep',
    get: (s) => num(s?.score?.sleep_performance_percentage),
    fmt: (v) => `${Math.round(v)}%`,
  },
  {
    // 對外顯示名稱「睡眠債加成」
    key: 'sleep_debt', label: '睡眠債加成', emoji: '⏳', tier: 'core',
    source: 'sleep',
    get: (s) => num(s?.score?.sleep_needed?.need_from_sleep_debt_milli),
    fmt: (v) => `+${Math.round(v / 60000)}m`,
  },

  // ↓↓↓ 這個 WHOOP 帳號有回傳且非 null 才會出現在簡報裡 ↓↓↓
  {
    key: 'sleep_consistency', label: '睡眠一致性', emoji: '🔁', tier: 'optional',
    source: 'sleep',
    get: (s) => num(s?.score?.sleep_consistency_percentage),
    fmt: (v) => `${Math.round(v)}%`,
  },
  {
    key: 'sleep_efficiency', label: '睡眠效率', emoji: '⚙️', tier: 'optional',
    source: 'sleep',
    get: (s) => num(s?.score?.sleep_efficiency_percentage),
    fmt: (v) => `${Math.round(v)}%`,
  },
  {
    key: 'disturbance_count', label: '擾動次數', emoji: '🌀', tier: 'optional',
    source: 'sleep',
    get: (s) => num(s?.score?.stage_summary?.disturbance_count),
    fmt: (v) => `${Math.round(v)} 次`,
  },
  {
    key: 'spo2', label: '血氧', emoji: '🩸', tier: 'optional',
    source: 'recovery',
    get: (r) => num(r?.score?.spo2_percentage),
    fmt: (v) => `${v.toFixed(1)}%`,
  },
  {
    key: 'skin_temp', label: '皮膚溫度', emoji: '🌡️', tier: 'optional',
    source: 'recovery',
    get: (r) => num(r?.score?.skin_temp_celsius),
    fmt: (v) => `${v.toFixed(1)}°C`,
  },
];

export const METRIC_BY_KEY = Object.fromEntries(METRICS.map((m) => [m.key, m]));

// ---------------------------------------------------------------------------
// 4b. 併發控制（跨 process）
// ---------------------------------------------------------------------------
export const LOCKS = {
  // token refresh 的 lease 長度。要比「一次 refresh + 寫 DB」久得多，
  // 但不能久到 process crash 後要等太久才能恢復。
  TOKEN_REFRESH_NAME: 'whoop_token_refresh',
  TOKEN_REFRESH_TTL_MS: 60_000,
  // 拿不到 lock 時最多等多久（等別人 refresh 完，再從 DB 讀新 token）
  TOKEN_REFRESH_WAIT_MS: 15_000,
  TOKEN_REFRESH_POLL_MS: 500,
};

export const REPORT_CLAIM = {
  // 發送權租期。要涵蓋「抓 45 天資料 + 呼叫 LLM + 送 Telegram」的最壞情況。
  // 太短會讓另一個 run 在前一個還在跑時搶走 claim 而重複發送。
  TTL_MS: 10 * 60_000,
};

// ---------------------------------------------------------------------------
// 4a-2. AI：用途、prompt 版本、model routing、價格
// ---------------------------------------------------------------------------

/** 每一次 LLM 呼叫都要標明用途（寫進 ai_usage.purpose）。 */
export const AI_PURPOSE = {
  DAILY: 'DAILY',
  WEEKLY: 'WEEKLY',
  QA: 'QA',
  INTENT_PARSE: 'INTENT_PARSE',
  JOURNAL_PARSE: 'JOURNAL_PARSE',
  FOLLOWUP: 'FOLLOWUP',
  EXPERIMENT: 'EXPERIMENT',
  OTHER: 'OTHER',
};

/**
 * Prompt 版本。
 *
 * 改 prompt 內容時**一定要同時升版**，否則事後無法回答
 * 「這句健康建議是哪一版 prompt 生出來的」。
 * 這一輪只加 metadata，daily / weekly 的 prompt 文字一個字都沒動。
 */
export const PROMPT_VERSIONS = {
  DAILY: 'daily-v1',
  WEEKLY: 'weekly-v1',
  QA: 'qa-v1',
  INTENT_PARSE: 'intent-parser-v1',
  JOURNAL_PARSE: 'journal-parser-v1',
  OTHER: 'generic-v1',
};

/**
 * 依任務挑模型。
 *
 * 優先序（由高到低）：
 *   1. 該任務專屬的環境變數（MODEL_QA 等）
 *   2. MODEL_DEFAULT
 *   3. 既有的 OPENROUTER_MODEL（向後相容，現有部署就是靠這個）
 *   4. COACH.DEFAULT_MODEL
 *
 * ⚠️ 這一輪所有任務的預設值都**留空**，所以實際行為與現在完全相同 ——
 * 全部都會落到 OPENROUTER_MODEL。要換便宜模型跑 parsing 時，
 * 只要在環境變數設 MODEL_PARSE 就好，不用改程式。
 */
export function resolveModel(purpose, env = process.env, fallback = null) {
  const byPurpose = {
    [AI_PURPOSE.DAILY]: env.MODEL_DAILY,
    [AI_PURPOSE.WEEKLY]: env.MODEL_WEEKLY,
    [AI_PURPOSE.QA]: env.MODEL_QA,
    [AI_PURPOSE.FOLLOWUP]: env.MODEL_QA,
    [AI_PURPOSE.INTENT_PARSE]: env.MODEL_PARSE,
    [AI_PURPOSE.JOURNAL_PARSE]: env.MODEL_PARSE,
    [AI_PURPOSE.EXPERIMENT]: env.MODEL_ADVANCED,
  };
  return byPurpose[purpose]
    || env.MODEL_DEFAULT
    || fallback                 // createCoach 建構時拿到的 model（現有部署走這條）
    || env.OPENROUTER_MODEL
    || COACH.DEFAULT_MODEL;
}

/**
 * 模型價格（USD / 每百萬 token）。
 *
 * ⚠️ 價格**會變**，而且這份表是人工維護的。所以：
 *  - 每一筆都標 effective_date 與來源
 *  - 表裡沒有的模型 → estimated_cost_usd = null（**絕不猜**）
 *  - 可以用環境變數 MODEL_PRICING_JSON 覆蓋，不必改程式碼重新部署
 */
export const PRICING_VERSION = '2026-09-06';

export const MODEL_PRICING = {
  'anthropic/claude-sonnet-5': {
    input_per_million: 3,
    output_per_million: 15,
    effective_date: '2026-09-06',
    source: 'openrouter.ai/models（人工抄錄，可能過期）',
  },
  'anthropic/claude-haiku-4.5': {
    input_per_million: 1,
    output_per_million: 5,
    effective_date: '2026-09-06',
    source: 'openrouter.ai/models（人工抄錄，可能過期）',
  },
  'anthropic/claude-opus-4.1': {
    input_per_million: 15,
    output_per_million: 75,
    effective_date: '2026-09-06',
    source: 'openrouter.ai/models（人工抄錄，可能過期）',
  },
};

/** 讀取價格表（含環境變數覆蓋）。壞掉的 JSON 一律忽略並記 log。 */
export function loadPricing(env = process.env) {
  const base = { ...MODEL_PRICING };
  const raw = env.MODEL_PRICING_JSON;
  if (!raw) return base;
  try {
    const override = JSON.parse(raw);
    if (override && typeof override === 'object') Object.assign(base, override);
  } catch {
    // 覆蓋壞掉時退回內建表，不要讓整個系統起不來
  }
  return base;
}

// ---------------------------------------------------------------------------
// 4b-2. Telegram bot（常駐 worker）
// ---------------------------------------------------------------------------
export const TELEGRAM_BOT = {
  /**
   * 認領一則 Telegram update 的重試次數與退避基數（R2-M-05）。
   *
   * 認領是「處理這則訊息」的持久化所有權。拿不到就不處理（fail closed），
   * 但一次短暫的 DB 抽風不該讓整批訊息卡住，所以先重試幾次。
   * 重試用完仍然失敗 → 這一則不處理、offset 不推進 → Telegram 之後會再送。
   */
  CLAIM_RETRIES: 3,
  CLAIM_RETRY_BASE_MS: 200,

  /**
   * 認領租約的長度（R3-M-05）。
   *
   * 語義是「一則訊息從認領到處理完的最壞情況時間」。一則訊息最多會打兩次
   * LLM（解析 + 回覆），所以要留足夠餘裕；但也不能太長，否則一個真的死掉的
   * worker 會讓它留下的那一則卡到租約到期才被判定。
   *
   * 注意：租約過期**不代表**會被自動重做 —— 只有還沒 dispatch 的
   * CLAIMED 才可以被接手，PROCESSING 過期是走 ABANDONED。
   */
  CLAIM_LEASE_MS: 5 * 60_000,

  // long polling 的 timeout（秒）。Telegram 建議 50 以下；連線會掛著等訊息，
  // 沒訊息就到時間回空陣列 —— 這比每秒輪詢省太多。
  POLL_TIMEOUT_S: 50,
  // fetch 自己的逾時要比 long poll 久，否則永遠等不到訊息就被自己砍掉
  REQUEST_TIMEOUT_MS: 65_000,
  // 連線失敗 / 5xx 的退避
  BASE_BACKOFF_MS: 1_000,
  MAX_BACKOFF_MS: 60_000,
  // 一次最多拿幾則
  BATCH_LIMIT: 20,
  // 追問的存活時間
  PENDING_TTL_MS: 30 * 60_000,
  // 回覆長度上限（沿用 Telegram 的 4096，但留一點餘裕）
  MAX_REPLY_CHARS: 3800,

  // ---- Webhook 入站（正式環境的傳輸方式）----
  //
  // 路徑刻意不含任何祕密：認證靠 Telegram 官方的
  // X-Telegram-Bot-Api-Secret-Token 標頭，不是靠猜不到的網址。
  WEBHOOK_PATH: '/telegram/webhook',
  HEALTH_PATH: '/health',
  // 一則 Telegram Update 的合理上限。Telegram 自己的訊息上限是 4096 字元，
  // 加上實體與轉發等欄位也遠遠不到 100KB —— 超過就是濫用或壞掉的請求，
  // 在讀完之前就中斷，不讓它吃掉 free instance 的記憶體。
  WEBHOOK_MAX_BODY_BYTES: 100 * 1024,
  // LLM 產生回答的 token 上限
  ANSWER_MAX_TOKENS: 1000,
  PARSE_MAX_TOKENS: 400,
};

// ---------------------------------------------------------------------------
// 4c. 長期同步
// ---------------------------------------------------------------------------
export const WHOOP_SYNC = {
  // 第一次要往回抓多久。WHOOP 帳號較新時會自然提早結束。
  BACKFILL_DAYS: 365,
  // 每次執行最多推進幾個 chunk（避免單一 cron run 太久 / 打爆 rate limit）
  BACKFILL_CHUNK_DAYS: 30,
  MAX_CHUNKS_PER_RUN: 3,
  // 增量同步的重疊天數：WHOOP 會重新評分或事後修正，所以每次都重抓最近幾天
  INCREMENTAL_OVERLAP_DAYS: 5,
  // 增量同步的節流：排程每 30 分鐘跑一次，但不需要每次都同步。
  MIN_INTERVAL_MS: 60 * 60_000,
  // 同步失敗絕不能讓簡報掛掉
  RESOURCES: ['sleep', 'recovery', 'cycle', 'workout', 'body_measurement'],
};

// ---------------------------------------------------------------------------
// 4d. 統計 / 個人偏離（Phase H / I）
// ---------------------------------------------------------------------------
export const ANALYTICS = {
  // 日曆窗口（天）。注意：window 是日曆天數，n 是該窗口內實際有效樣本數，
  // 兩者永遠分開記錄，不可混用。
  WINDOWS: [7, 14, 30, 90],
  // 少於這個樣本數就不輸出該窗口的統計結論
  MIN_SAMPLES: 5,
  // 標準差小於這個比例（相對於平均）視為變異不足，不算 z-score
  MIN_STDDEV_RATIO: 0.001,
  // z-score 分級（用絕對值）
  Z_THRESHOLDS: { MILD: 1, NOTABLE: 1.5, STRONG: 2 },
  // 個人偏離用的基準窗口
  DEFAULT_BASELINE_WINDOW: 30,
};

/**
 * 每個指標「哪個方向算不好」。
 *   'higher_better' → 偏低才值得注意
 *   'lower_better'  → 偏高才值得注意
 *   'both'          → 兩個方向偏離都值得看
 * 這裡刻意不用「正常 / 異常」這種醫學語彙，全系統一律稱 personal deviation。
 */
export const METRIC_DIRECTION = {
  recovery_score: 'higher_better',
  hrv: 'higher_better',
  rhr: 'lower_better',
  respiratory_rate: 'both',
  sleep_total: 'higher_better',
  slow_wave: 'higher_better',
  rem: 'higher_better',
  sleep_performance: 'higher_better',
  sleep_efficiency: 'higher_better',
  sleep_consistency: 'higher_better',
  sleep_debt: 'lower_better',
  disturbance_count: 'lower_better',
  spo2: 'higher_better',
  skin_temp: 'both',
  strain: 'both',

  // ⚠️ 稽核修正：daily_metrics 的欄位名跟上面幾個 METRICS key 不一樣
  // （`recovery` vs `recovery_score`、`previous_day_strain` vs `strain`）。
  // 缺這兩個 alias 時，anomaly.js 的 isNoteworthy() 查不到就 fallback 成
  // 'both'，於是「恢復分數異常地好」也會被當成需要使用者解釋的訊號。
  recovery: 'higher_better',
  previous_day_strain: 'both',
};

// Phase PA1：Data Readiness Engine 的「產品啟發式」門檻。
// 跟 BASELINE / ANALYTICS / TREND_ENGINE 不同 —— 那些門檻背後有統計推導
// 或既有已上線的邏輯撐腰。這裡是「還沒有任何既有模組定義過」的新能力
// （相似日候選池大小、healthspan 基礎涵蓋率、proactive monitoring 觀察哪些指標），
// 純粹是產品判斷，不是統計驗證過的數字，未來應該依實際使用調整、並且要能測試，
// 絕不可以包裝成「這是科學算出來的」。
export const READINESS_HEURISTICS = {
  SIMILAR_DAYS_MIN_POOL: 14,
  HEALTHSPAN_MIN_COVERAGE_RATIO: 0.5,
  PROACTIVE_CORE_METRICS: ['recovery', 'hrv', 'rhr'],
};

// Phase K：趨勢引擎
export const TREND_ENGINE = {
  WINDOWS: [7, 30, 90],
  MIN_SAMPLES: 5,
  // 斜率要達到「每天變動 > 基準的這個比例」才算真的有方向
  MIN_SLOPE_RATIO_PER_DAY: 0.0015,
  // change point：最近 N 天 vs 前 N 天
  SHIFT_WINDOW_DAYS: 14,
  MIN_SHIFT_EFFECT_SIZE: 0.6,   // Cohen's d 門檻
  MIN_SHIFT_SAMPLES: 7,
};

// Phase J：What Changed Today
export const WHAT_CHANGED = {
  MAX_ITEMS: 3,
  // 重要度低於這個值就不顯示（避免每天都在報雜訊）
  MIN_IMPORTANCE: 0.35,
};

// ---------------------------------------------------------------------------
// 5. 小工具
// ---------------------------------------------------------------------------
/** 只接受有限數字，其他（null / undefined / NaN / 字串）一律回 null。 */
export function num(v) {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** 毫秒 → "7h10m" / "45m" */
export function formatDuration(ms) {
  const totalMin = Math.round(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}h${String(m).padStart(2, '0')}m` : `${m}m`;
}

// ---------------------------------------------------------------------------
// 6. 環境變數
// ---------------------------------------------------------------------------
const REQUIRED_ENV = [
  'WHOOP_CLIENT_ID',
  'WHOOP_CLIENT_SECRET',
  'OPENROUTER_API_KEY',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_CHAT_ID',
  'TURSO_DATABASE_URL',
  'TURSO_AUTH_TOKEN',
];

export function loadEnv({ require: requireList = REQUIRED_ENV } = {}) {
  const missing = requireList.filter((k) => !process.env[k]);
  if (missing.length) {
    throw new Error(`缺少環境變數：${missing.join(', ')}`);
  }
  return {
    whoopClientId: process.env.WHOOP_CLIENT_ID,
    whoopClientSecret: process.env.WHOOP_CLIENT_SECRET,
    whoopRedirectUri: process.env.WHOOP_REDIRECT_URI,
    openrouterApiKey: process.env.OPENROUTER_API_KEY,
    openrouterModel: process.env.OPENROUTER_MODEL || COACH.DEFAULT_MODEL,
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,
    telegramChatId: process.env.TELEGRAM_CHAT_ID,
    tursoUrl: process.env.TURSO_DATABASE_URL,
    tursoToken: process.env.TURSO_AUTH_TOKEN,
    timezone: process.env.TIMEZONE || 'Asia/Taipei',
    dryRun: process.env.DRY_RUN === '1',
    // 由 GitHub Actions workflow 注入（git log -1 --format=%cI）。
    // Render / 本機不會有 → 60 天提醒自動跳過。
    repoLastCommitAt: process.env.REPO_LAST_COMMIT_AT || null,
    // cron 併發上限。TIMEZONE 只是 bootstrap 預設，真正的時區在 users.timezone。
    maxUserConcurrency: Number(process.env.MAX_USER_CONCURRENCY) > 0
      ? Number(process.env.MAX_USER_CONCURRENCY)
      : CRON.MAX_USER_CONCURRENCY,
  };
}

/**
 * 本機開發：如果有 .env 就載入（雲端用平台環境變數，不會有 .env）。
 *
 * 只忽略「檔案不存在」（ENOENT）—— 那是雲端的正常情況。其他錯誤（權限不足、
 * 格式壞掉、Node 版本太舊沒有 loadEnvFile）一律重新拋出：以前全部吞掉的話，
 * 使用者明明填好了 .env 卻會收到「缺少環境變數」這種完全誤導的訊息。
 */
export function loadDotEnvIfPresent() {
  try {
    process.loadEnvFile('.env');
  } catch (err) {
    if (err?.code === 'ENOENT') return; // 沒有 .env，正常
    throw new Error(
      `.env 存在但載入失敗（${err?.code ?? err?.name ?? 'unknown'}）：${err?.message ?? err}`,
      { cause: err },
    );
  }
}
