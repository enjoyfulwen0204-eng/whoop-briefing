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
  // 最小 scope，注意單複數。offline 必要，否則不給 refresh token。
  SCOPES: 'offline read:recovery read:sleep read:cycles',
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
