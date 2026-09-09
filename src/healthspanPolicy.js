/**
 * Personal Healthspan 的成熟度與計分政策（V1.1 Phase 12）。
 *
 * ## 命名（不可違反）
 *
 * 這是**我們自己的**東西，叫 Personal Healthspan。
 *
 * 它**不是** WHOOP Age，**不是** WHOOP 官方的 Healthspan，也不試圖重現
 * 那兩者。WHOOP 沒有公開演算法，而且官方 Developer API v2 根本拿不到
 * 幾個關鍵輸入（步數、VO2 Max、瘦體重——三者都已經在 capabilities.js
 * 標成 APP_ONLY）。任何宣稱「這就是你的 WHOOP Age」的東西都是假的。
 *
 * 對外文字一律用「Personal Healthspan」或「長期生理」，絕不出現
 * WHOOP Age / WHOOP Healthspan。有測試守著。
 *
 * ## 為什麼現在不給分數
 *
 * 要把十幾個 contributor 合成一個分數，需要知道**每一項各佔多少權重**。
 * 那些權重必須來自流行病學文獻或個人資料的驗證，兩者現在都沒有。
 *
 * 常見的偷懶做法是「全部給 1、加起來、normalize 到 0–100」。那會產出一個
 * 看起來很專業、實際上毫無意義的數字，而且因為它有兩位小數，讀的人會
 * 比對一個誠實的「資料還不夠」更信任它。**這比不給分數危險得多。**
 *
 * 所以 WEIGHTS 全部是 null，SCORE_ENABLED 是 false，而且引擎在任何情況下
 * 都會回 score = null。框架完整、可版本化、可測試——只差一套有依據的權重。
 *
 * ## 成熟度看 readiness，不是看日曆
 *
 * 沿用 proactiveMessages.deriveColdStartStage() 的立場：階段由**資料就緒
 * 程度**決定，不是「滿 30 天就解鎖」。日曆天數只能描述歷史有多長，
 * 不能證明那段歷史裡真的有可用的資料——一個戴了 90 天但有 60 天沒戴錶的
 * 人，跟一個扎實戴了 30 天的人，前者的日曆數字比較好看，資料卻比較差。
 */

import { ANALYTICS, READINESS_HEURISTICS } from './config.js';

export const HEALTHSPAN_POLICY_VERSION = 'healthspan-policy-v1';

/** 演算法版本。任何計分方式的改變都必須升版，否則事後無法回溯。 */
export const HEALTHSPAN_ALGORITHM_VERSION = 'personal-healthspan-v0';

/**
 * 成熟度階梯。與 readiness 的狀態一一對應，不是另一套平行的判斷。
 */
export const HEALTHSPAN_MATURITY = Object.freeze({
  /** 一筆可用資料都沒有。 */
  NO_DATA: 'NO_DATA',
  /** 有資料，但還沒有任何 contributor 算得出值。 */
  WARMING_UP: 'WARMING_UP',
  /** 部分 contributor 可用，但覆蓋率還不到門檻。 */
  LIMITED: 'LIMITED',
  /**
   * 資料結構上已經夠了 —— 但**沒有任何經過驗證的計分政策被啟用**。
   *
   * 這是目前資料充足時的最終狀態，而且它是一個**正確**的答案，
   * 不是待辦事項。系統有能力說「我的資料夠了，但我沒有一套可信的
   * 公式，所以我不給你數字」。
   */
  STRUCTURALLY_READY: 'STRUCTURALLY_READY',
  /** 未來：有了經過驗證的計分政策之後才可能到達。 */
  QUALIFIED: 'QUALIFIED',
});

/** 只有這個狀態允許輸出分數。目前沒有任何路徑會到達。 */
export const PUBLISHABLE_MATURITY = new Set([HEALTHSPAN_MATURITY.QUALIFIED]);

export const HEALTHSPAN_POLICY = Object.freeze({
  /**
   * ⚠️ **全部是 null = 尚未有經過驗證的權重。**
   *
   * 絕不可以為了「讓 UI 有數字可以顯示」而隨便填 1。列出所有 key 是為了
   * 讓「還缺什麼」一目瞭然，不是為了方便填滿。
   */
  WEIGHTS: Object.freeze({
    sleep_duration: null,
    sleep_consistency: null,
    resting_heart_rate: null,
    hrv: null,
    recovery: null,
    respiratory_rate: null,
    strain: null,
    workout_volume: null,
    hr_zone_1_3: null,
    hr_zone_4_5: null,
    strength_activity: null,
    weight: null,
    max_heart_rate: null,
    spo2: null,
    skin_temp: null,
  }),

  /**
   * 總開關。即使有一天權重填好了，也要**明確**把這個打開，
   * 避免「不小心填了一個權重就開始輸出分數」。
   */
  SCORE_ENABLED: false,

  /**
   * 覆蓋率門檻：多少比例的 contributor 算得出值才算結構上就緒。
   * **沿用既有常數**（READINESS_HEURISTICS.HEALTHSPAN_MIN_COVERAGE_RATIO），
   * 不是新發明的數字。
   */
  MIN_COVERAGE_RATIO: READINESS_HEURISTICS.HEALTHSPAN_MIN_COVERAGE_RATIO,

  /** 單一 contributor 要有多少樣本才算算得出值。沿用 ANALYTICS.MIN_SAMPLES。 */
  MIN_SAMPLES_PER_CONTRIBUTOR: ANALYTICS.MIN_SAMPLES,

  /**
   * 描述性的歷史長度分層。
   *
   * ⚠️ 這**只是給人看的標籤**，用來回答「我累積多久了」。
   * 它**絕不**參與成熟度判斷——成熟度只看 readiness。
   * 放在這裡是為了讓「日曆天數不是解鎖條件」這件事有個明確的地方被說明。
   */
  HISTORY_TIERS: Object.freeze([
    { days: 30, label: '一個月' },
    { days: 60, label: '兩個月' },
    { days: 90, label: '三個月' },
    { days: 180, label: '半年' },
  ]),
});

/** 目前有沒有一套可用的計分政策。 */
export function hasQualifiedScoringPolicy({ policy = HEALTHSPAN_POLICY } = {}) {
  if (!policy.SCORE_ENABLED) return false;
  const weights = Object.values(policy.WEIGHTS);
  // 只要還有任何一個權重沒被設定，就不算有可用的政策
  return weights.length > 0 && weights.every((w) => typeof w === 'number' && Number.isFinite(w));
}

/**
 * 描述性的歷史長度標籤。**不影響任何解鎖判斷。**
 * @returns {?string}
 */
export function historyTierLabel(historyDays, { policy = HEALTHSPAN_POLICY } = {}) {
  let label = null;
  for (const t of policy.HISTORY_TIERS) {
    if (historyDays >= t.days) label = t.label;
  }
  return label;
}

/**
 * **唯一**允許輸出 Personal Healthspan 分數的地方。
 *
 * 目前永遠回 null：沒有經過驗證的權重、總開關也沒開。
 * 這不是佔位符，是這個功能現階段的正確輸出。
 */
export function publishableScore({ maturity, score = null, policy = HEALTHSPAN_POLICY }) {
  if (!hasQualifiedScoringPolicy({ policy })) return null;
  if (!PUBLISHABLE_MATURITY.has(maturity)) return null;
  return score;
}
