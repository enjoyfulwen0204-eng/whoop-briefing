/**
 * Proactive Agent 的「產品政策」集中地（PA1 review 要求）。
 *
 * ## 兩種數字，絕對不可以混在一起
 *
 * STATISTICAL（統計門檻）
 *   樣本夠不夠、信心夠不夠 —— 這些數字已經有既有模組背書
 *   （BASELINE.* / ANALYTICS.* / TREND_ENGINE.* / correlation.dataQualityOf /
 *   regression 與 prediction 的動態公式），一律留在 src/readiness.js 裡
 *   直接重用來源模組，不在這裡重複定義。
 *
 * PRODUCT HEURISTIC（產品啟發式）
 *   「多嚴重才值得通知」「同一個話題多久才能再問一次」「一天最多發幾則」
 *   「這個訊號算不算新鮮」—— 這些沒有統計推導，是產品判斷。
 *   全部集中在這個檔案，version 化、可測試、可調整，
 *   **絕不假裝是科學算出來的**。
 *
 * 未來任何 Attention Engine / 反騷擾 / Information-Gain 問題引擎 /
 * 訊號嚴重度 / 新鮮度 / 持續性 相關的常數，一律加在這裡，
 * 不可以散落在各個實作檔案裡當成 magic number。
 */

export const POLICY_VERSION = 'proactive-policy-v1';

/**
 * Signal Engine（PA4）—— 訊號嚴重度。
 *
 * 刻意不重新定義「多少 z-score 算嚴重」——那已經是
 * ANALYTICS.Z_THRESHOLDS（MILD/NOTABLE/STRONG）在管，Signal Engine
 * 直接讀 evaluateDeviation() 算出來的 level，這裡只放「幾個 level
 * 才需要往上一層看」這種 policy 層的判斷。
 */
export const SIGNAL_POLICY = {
  // 訊號至少要到這個 deviation level 才值得進 Attention Engine 評估；
  // MILD 太常出現，天天發會變成 alert bot。
  MIN_LEVEL_FOR_ATTENTION: 'NOTABLE',

  /**
   * 實際監看哪些指標。
   *
   * 跟 READINESS_HEURISTICS.PROACTIVE_CORE_METRICS 分開的理由：
   * 那三個（recovery/hrv/rhr）是「主動代理要不要啟用」的成熟度門檻，
   * 要求呼吸率或睡眠債也全部 READY 才啟用太嚴苛。啟用之後，
   * 監看範圍可以比較廣——每個指標仍然各自受自己的 readiness 把關，
   * 沒有 READY 的指標本來就不會產生訊號。
   */
  MONITORED_METRICS: [
    'recovery', 'hrv', 'rhr',
    'respiratory_rate',
    'sleep_performance', 'sleep_debt',
    'previous_day_strain',
  ],

  /**
   * 每個指標「哪一個方向才值得打擾使用者」。
   *
   * ⚠️ 稽核發現（真的踩到了）：analytics 層的 METRIC_DIRECTION 對呼吸率、
   * strain 這類指標是 'both'——那對**描述性**分析是對的（今天有什麼變化，
   * 兩個方向都值得描述），但拿來當**主動打擾**的依據就完全錯了。
   * 實際跑 e2e 時，系統對著一份日報說「今天狀態看起來不錯」的資料，
   * 同時因為 RESPIRATORY_RATE_LOW（呼吸更平穩）+ PREVIOUS_DAY_STRAIN_LOW
   * （昨天比較沒操）兩個「好消息」判定為多重佐證，跑去問使用者
   * 「昨天是不是喝酒了」。
   *
   * 所以主動代理有自己的一份方向表：只有往「值得擔心」的那一邊偏離才算
   * 訊號。這是產品判斷，不是統計判斷，所以放在政策檔而不是 config.js，
   * 也完全不動 analytics 層既有的描述性語義。
   */
  CONCERNING_DIRECTION: {
    recovery: 'low',
    hrv: 'low',
    rhr: 'high',
    respiratory_rate: 'high',   // 升高是生病早期徵兆；偏低不是問題
    sleep_performance: 'low',
    sleep_debt: 'high',
    previous_day_strain: 'high', // 異常吃力的一天是壓力源；休息日不是
  },

  /**
   * 生理「領域」分群——用來判斷什麼才算**獨立**的佐證。
   *
   * ⚠️ 這一段是稽核加的，而且很重要：recovery 本身就是 WHOOP 用 hrv 與 rhr
   * 算出來的。把「HRV 低 + RHR 高 + 恢復低」當成三個獨立訊號互相佐證，
   * 其實是同一件事被數了三次，會讓「多重訊號佐證」在任何一個狀況差的
   * 日子都自動成立，等於變相取消了這個門檻。
   *
   * 所以佐證的計算單位是**不同的生理領域**，不是訊號筆數。
   */
  METRIC_DOMAIN: {
    recovery: 'autonomic',
    hrv: 'autonomic',
    rhr: 'autonomic',
    respiratory_rate: 'respiratory',
    sleep_performance: 'sleep',
    sleep_debt: 'sleep',
    previous_day_strain: 'load',
  },
};

/**
 * Attention Engine（PA5）—— 決定 IGNORE / LOG_ONLY / ASK_CONTEXT / NOTIFY / FOLLOW_UP。
 */
export const ATTENTION_POLICY = {
  // 幾個**不同生理領域**同時出現 noteworthy 偏離，才算「多重訊號佐證」。
  // 單位是領域，不是訊號筆數（見 SIGNAL_POLICY.METRIC_DOMAIN 的說明）。
  MULTI_SIGNAL_CONFIRMATION_MIN: 2,
  // 訊號重複出現在最近幾天內，就不算「新鮮」，避免同一件事一直被重新評估成
  // NOTIFY。
  NOVELTY_WINDOW_DAYS: 14,
  // 需要連續出現幾天才算「持續」而不是單日雜訊。
  PERSISTENCE_MIN_DAYS: 2,
};

/**
 * 反騷擾政策（PA6）。
 *
 * 這些數字直接決定使用者一天會被打擾幾次，是最容易被人詬病的地方，
 * 所以獨立、集中、可測試、可調整。
 */
/**
 * 處理中的主動事件租約（R2-M-03）。
 *
 * ## 為什麼需要租約，而不是只靠 sent_at grace
 *
 * 回答流程是「原子認領追問 → 打 LLM 解析（秒級）→ 寫 journal → 重新分析
 * → 結案」。收割器的孤兒判準是「送出很久了、沒有 OPEN 的追問指著它」——
 * 一個**正在被處理**的事件剛好完全符合：追問已經是 ANSWERED，而 sent_at
 * 可能是好幾天前（使用者隔天才回）。
 *
 * 實測確認：收割器寫了 ABANDONED，回答流程恢復後把它覆寫成
 * STILL_UNEXPLAINED —— 兩個結論都不可信。
 *
 * grace 調長只是把窗口往後推，不會關掉它（使用者可以在 TTL 的最後一秒
 * 回答）。真正的解法是讓「正在處理」變成一個**明確、有時效、原子**的事實。
 *
 * 沿用既有的 `resource_locks` 租約（與 WHOOP token refresh 同一套機制），
 * 所以不需要任何 schema 變更。
 */
export const PROACTIVE_PROCESSING_LEASE = {
  /**
   * 一次回答處理最多允許多久。
   *
   * 要涵蓋最壞情況的 LLM 解析 + 重新分析（兩次 LLM 呼叫加上 180 天的
   * journal 查詢），但也必須夠短，讓真的死掉的 process 不會永久卡住事件。
   */
  TTL_MS: 5 * 60_000,
  name: (userId, eventId) => `proactive_event:${userId}:${eventId}`,
};

export const ANTI_SPAM_POLICY = {
  // 同一個「話題」（例如同一個 metric 的偏離）多久之內不能再問一次。
  TOPIC_COOLDOWN_HOURS: 24,
  // 一個使用者一天最多收到幾則主動訊息（ASK_CONTEXT + NOTIFY 合計）。
  DAILY_PROACTIVE_CAP: 2,
  // 同時間最多開幾個未回答的 proactive 問題（目前先固定 1：
  // 「一次只問一件事」，不要讓使用者同時欠好幾筆債）。
  MAX_OPEN_QUESTIONS: 1,

  /**
   * 主動問題的存活時間。
   *
   * ⚠️ **DEFAULT / UNTUNED PRODUCT HEURISTIC —— 這個數字沒有被驗證過。**
   *
   * 它不是最佳值，也沒有任何行為資料支撐。目前刻意沿用既有的 30 分鐘，
   * 純粹是為了向後相容：在這次改動之前，主動問題借用的是
   * `TELEGRAM_BOT.PENDING_TTL_MS`，改成獨立常數的同時如果順手換掉數值，
   * 就會在「沒有任何觀察」的情況下偷偷改變使用者體驗。
   *
   * 為什麼一定要跟 TELEGRAM_BOT.PENDING_TTL_MS 分開：那個常數的語義是
   * 「使用者自己問完之後，對話延續的視窗」——使用者當下就在跟系統講話，
   * 30 分鐘很合理。主動問題的語義完全不同：系統在早上七點不請自來地問
   * 一句話，使用者可能在通勤、可能在開會，30 分鐘很可能太短。
   * 兩者本來就不該共用一個數字。
   *
   * 要怎麼調：等 `proactive_events.outcome` 累積出真實的 NO_RESPONSE 比例
   * 之後再說。**這正是先把生命週期做完的理由**——在有 NO_RESPONSE 資料
   * 之前，任何 TTL 數字都只是意見。
   */
  QUESTION_TTL_MS: 30 * 60_000,
  // 完全一樣的 proactive event（同一個 idempotency key）在這個時間內
  // 重複出現，視為重複 sync，不重新發送。
  DUPLICATE_SUPPRESSION_HOURS: 24,
};

/**
 * Information-Gain 問題引擎（PA7）—— 候選問題怎麼排序。
 *
 * 分數只是「這個問題值不值得問」的相對排序依據，不是任何統計量，
 * 改這裡的權重不需要動 readiness 或分析邏輯。
 */
export const INFORMATION_GAIN_POLICY = {
  /**
   * 可以拿來問的 journal 類別 + 對應問句。
   *
   * ⚠️ 稽核修正：這份清單原本散在 questionEngine.js 裡（候選類別 import 自
   * bot/conversation.js 的 FOLLOW_UP_CATEGORIES，問句樣板則直接寫死在
   * 引擎裡）。政策資料集中放這裡，引擎只負責排序與挑選。
   *
   * 每一個 key 都必須是 src/journal.js `CATEGORIES` 裡真的存在的類別——
   * 不新增使用者記不了的類別，也不碰任何醫療/私密性更高的主題。
   * 相對於最初的五個，這裡補上 caffeine / late_meal / exercise_note，
   * 它們都是 Journal 早就支援、而且跟恢復高度相關的既有類別。
   */
  CANDIDATES: {
    alcohol: '昨天有喝酒嗎？',
    sickness: '最近有沒有不舒服、感冒的感覺？',
    travel: '昨天有搭飛機或跨時區旅行嗎？',
    late_sleep: '昨晚是不是特別晚睡？',
    stress: '最近是不是壓力特別大？',
    caffeine: '昨天下午或晚上有喝咖啡、茶之類的嗎？',
    late_meal: '昨天有吃宵夜或很晚才吃晚餐嗎？',
    exercise_note: '昨天的運動是不是比平常吃力？',
  },

  /**
   * 每一個候選類別在**問哪一天**（相對於訊號的 health_date，單位：天）。
   *
   * ## 為什麼一定要明文寫下來（R2-M-02）
   *
   * 問題文字是「你的 HRV **今天**比平常偏低。**昨天**有喝酒嗎？」——
   * 「今天」是訊號日 D，所以「昨天」是 D-1。這正是 lag=1 關聯分析要的那一天
   * （journal 日 D-1 → 指標日 D）。
   *
   * 舊版只記下訊號日 D，然後在**回答的時候**才由 parser 的預設值去猜日期。
   * 於是「喝了兩杯」被記在 D，而不是 D-1 —— 我們主動問來的答案，結構上
   * 永遠對不上我們主動問的那個異常。實測確認（訊號日 2026-02-06 的問題，
   * 答案被記成 2026-02-06 而不是 2026-02-05）。
   *
   * 現在「這題在問哪一天」是問題被**建立時**就決定並持久化的事實，
   * 不是事後推論。
   *
   * 「最近…」這種沒有指定某一天的問題用 0（以訊號日為準）。
   */
  TARGET_DAY_OFFSET: {
    alcohol: -1,          // 昨天有喝酒嗎？
    travel: -1,           // 昨天有搭飛機或跨時區旅行嗎？
    late_sleep: -1,       // 昨晚是不是特別晚睡？
    caffeine: -1,         // 昨天下午或晚上有喝咖啡…
    late_meal: -1,        // 昨天有吃宵夜…
    exercise_note: -1,    // 昨天的運動是不是比平常吃力？
    sickness: 0,          // 最近有沒有不舒服 —— 沒有指定某一天
    stress: 0,            // 最近是不是壓力特別大 —— 沒有指定某一天
  },

  WEIGHTS: {
    // 這個 journal 類別過去是否曾經對這個 metric 有關聯佐證
    // （journalAssociation 的 data_quality 越高分越高）。
    PRIOR_ASSOCIATION_STRENGTH: 0.4,
    // 這個類別最近有沒有已知的答案（如果昨天已經問過同一類別，
    // 資訊增益就低，不該再問一次）。
    CONTEXT_ALREADY_KNOWN_PENALTY: 0.3,
    // 這個訊號本身的嚴重度（越嚴重，弄清楚原因的價值越高）。
    SIGNAL_SEVERITY: 0.3,
  },
  // 一次最多問幾題：目前規則是「只問一題」，這個常數只是把規則明文化，
  // 不是之後可以隨便調大的旋鈕。
  MAX_QUESTIONS_PER_EVENT: 1,
  // 使用者回答不清楚時，最多允許幾次澄清追問（避免無限盤問）。
  MAX_CLARIFICATIONS: 1,
};
