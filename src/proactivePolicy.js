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
};

/**
 * Attention Engine（PA5）—— 決定 IGNORE / LOG_ONLY / ASK_CONTEXT / NOTIFY / FOLLOW_UP。
 */
export const ATTENTION_POLICY = {
  // 幾個指標同時出現 noteworthy 偏離，才算「多重訊號佐證」而不是單一雜訊。
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
export const ANTI_SPAM_POLICY = {
  // 同一個「話題」（例如同一個 metric 的偏離）多久之內不能再問一次。
  TOPIC_COOLDOWN_HOURS: 24,
  // 一個使用者一天最多收到幾則主動訊息（ASK_CONTEXT + NOTIFY 合計）。
  DAILY_PROACTIVE_CAP: 2,
  // 同時間最多開幾個未回答的 proactive 問題（目前先固定 1：
  // 「一次只問一件事」，不要讓使用者同時欠好幾筆債）。
  MAX_OPEN_QUESTIONS: 1,
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
