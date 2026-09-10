/**
 * 可發布的結構化事實（R2-H-02）。
 *
 * ## 這個模組要解決的問題
 *
 * 上一輪的敘述守門問的是「這個數字在 evidence context 這段**文字**裡出現過
 * 嗎」，並且用「數字有沒有緊貼著指標名」來做歸屬。兩者都依賴列舉措辭，
 * 所以獨立稽核用改寫就繞過了 13/22：
 *
 *   「今天的恢復，99%，很不錯。」      逗號斷開了鄰接
 *   「99% 的恢復」                      數字在前
 *   「Your Recovery is 99%」            英文指標名不在詞彙表裡
 *   「恢復是九十九%」                    中文數字完全沒有阿拉伯數字可掃
 *   「你的身體年紀大概 30 歲」          WHOOP Age 的改寫
 *
 * 結論很明確：**LLM 不可以是生理事實的權威**，而「檢查它有沒有說錯話」
 * 這個方向永遠追不完。必須反過來 —— 先建立一組**權威的結構化事實**，
 * 然後要求敘述裡的每一個數值宣稱都能歸屬到其中一筆。沒有歸屬就不發布。
 *
 * ## 一筆事實長什麼樣
 *
 *   metric        系統內部的指標鍵（'recovery'、'hrv'…）
 *   labels        這個指標在文字裡可能的稱呼（中英文、同義詞）
 *   value         數值（null 代表沒有資料）
 *   unit          單位
 *   display       確定性層算好的顯示字串
 *   healthDate    這筆事實屬於哪一天（或哪個窗口）
 *   windowDays    窗口長度（趨勢／平均類事實）
 *   readiness     可用性狀態
 *   publishable   **可不可以被敘述引用**
 *   支援數值      value 之外還允許哪些數字（基準、樣本數、z 值…）
 *
 * `publishable` 是唯一的授權來源。value 是 null、readiness 不足、
 * capability 判定拿不到 —— 一律 false，敘述就不可以給它任何數值。
 *
 * ## 指標詞彙表是封閉的
 *
 * 系統**知道**自己能算出哪些指標（config.METRICS + healthspan contributors
 * + 少數衍生量）。所以「敘述裡提到一個生理指標，但那個指標不在這次的
 * 可發布事實裡」本身就是捏造 —— 不需要列舉「哪些話不能說」，只需要
 * 列舉「這個系統有哪些指標」，那是一份有限、穩定、我們自己定義的清單。
 *
 * WHOOP Age / Healthspan 分數 / 推估生理年齡都放在這份詞彙表裡，
 * 而且**永遠 publishable: false** —— 它們是 APP_ONLY 或本系統刻意不輸出的
 * 衍生分數，所以只要被提起就是違規，不必猜它被怎麼改寫。
 */

/** 一個數字的容許誤差：2% 或至少 0.05（模型常會四捨五入）。 */
export const NUMBER_TOLERANCE = (v) => Math.max(0.05, Math.abs(v) * 0.02);

/**
 * 系統的**完整**指標詞彙表：內部鍵 → 文字裡可能的稱呼。
 *
 * 這份表是封閉的，而且它的用途是**允許**而不是禁止：只有出現在這裡、
 * 而且這一次真的算出了值的指標，才可以被敘述給一個數值。
 */
export const METRIC_VOCABULARY = {
  recovery: ['恢復', '恢復分數', '恢復度', 'recovery', 'recovery score'],
  hrv: ['HRV', '心率變異', '心率變異度', 'heart rate variability', 'rmssd'],
  rhr: ['靜息心率', '休息心率', 'RHR', 'resting heart rate', 'resting hr'],
  respiratory_rate: ['呼吸率', '呼吸頻率', 'respiratory rate', 'breathing rate'],
  sleep_total: ['睡眠', '睡眠時長', '睡眠時間', 'sleep', 'sleep duration', 'total sleep'],
  slow_wave: ['深睡', '深層睡眠', 'deep sleep', 'slow wave sleep', 'sws'],
  rem: ['REM', 'REM 睡眠', '快速動眼', 'rem sleep'],
  sleep_performance: ['睡眠表現', '睡眠品質', 'sleep performance', 'sleep quality'],
  sleep_debt: ['睡眠債', '睡眠債加成', 'sleep debt'],
  sleep_consistency: ['睡眠一致性', '作息一致性', 'sleep consistency'],
  sleep_efficiency: ['睡眠效率', 'sleep efficiency'],
  disturbance_count: ['擾動次數', '睡眠擾動', 'disturbances', 'disturbance count'],
  strain: ['Strain', '負荷', '訓練負荷', 'day strain'],
  spo2: ['血氧', '血氧濃度', 'SpO2', 'spo₂', 'blood oxygen', 'oxygen saturation'],
  skin_temp: ['皮膚溫度', '體溫', 'skin temperature', 'skin temp'],
  weight: ['體重', 'weight', 'body weight'],
  steps: ['步數', 'steps', 'step count'],
  vo2_max: ['VO2', 'VO2 Max', '最大攝氧量', 'vo2max'],
  max_heart_rate: ['最大心率', 'max heart rate', 'max hr'],
  lean_body_mass: ['去脂體重', '肌肉量', 'lean body mass'],
  calories: ['卡路里', '熱量', 'calories', 'kilojoule', '大卡'],

  // ---- 以下永遠 publishable: false ----------------------------------------
  // 這些是 WHOOP App 專有、或本系統刻意不輸出的衍生分數。
  // 官方 Developer API 沒有這些欄位（capabilities.js 標成 APP_ONLY），
  // healthspanPolicy.js 的三道閘門也讓分數永遠是 null。
  // 只要被提起就是捏造，不必判斷它被怎麼改寫。
  whoop_age: [
    'WHOOP Age', 'WHOOP 年齡', '生理年齡', '身體年齡', '身體年紀', '體能年齡',
    '推估年齡', '推算年齡', '估算的年齡', '估算年齡',
    'physiological age', 'estimated age', 'body age', 'fitness age',
  ],
  healthspan_score: [
    'Healthspan', 'WHOOP Healthspan', 'Healthspan 分數', 'Healthspan Score',
    '健康壽命', '健康壽命指數', '健康壽命分數', '健康餘命',
    'healthspan index', 'pace of aging', 'pace estimate',
  ],
};

/** 永遠不可發布的衍生／專有分數。 */
export const NEVER_PUBLISHABLE = new Set(['whoop_age', 'healthspan_score']);

/** config.METRICS 的 key → 詞彙表的 key（兩邊命名不完全一致）。 */
const CONFIG_KEY_TO_VOCAB = {
  recovery_score: 'recovery',
  strain: 'strain',
  hrv: 'hrv',
  rhr: 'rhr',
  respiratory_rate: 'respiratory_rate',
  sleep_total: 'sleep_total',
  slow_wave: 'slow_wave',
  rem: 'rem',
  sleep_performance: 'sleep_performance',
  sleep_debt: 'sleep_debt',
  sleep_consistency: 'sleep_consistency',
  sleep_efficiency: 'sleep_efficiency',
  disturbance_count: 'disturbance_count',
  spo2: 'spo2',
  skin_temp: 'skin_temp',
};

/** 所有指標稱呼（長的排前面，比對時才不會被短的吃掉）。 */
export const ALL_METRIC_TERMS = Object.values(METRIC_VOCABULARY)
  .flat()
  .sort((a, b) => b.length - a.length);

/** 稱呼 → 指標鍵。全部小寫比對。 */
export const TERM_TO_METRIC = (() => {
  const m = new Map();
  for (const [key, terms] of Object.entries(METRIC_VOCABULARY)) {
    for (const t of terms) m.set(t.toLowerCase(), key);
  }
  return m;
})();

/**
 * 建立一筆事實。
 *
 * @param {string}  metric      指標鍵（必須在 METRIC_VOCABULARY 裡）
 * @param {?number} value       數值。null / 非有限數 → 不可發布
 * @param {object}  opts
 *   unit, display, healthDate, windowDays, readiness
 *   supporting  除了 value 之外還允許出現的數字（基準、n、z、百分比變化…）
 *   publishable 明確覆寫（例如 capability 判定拿不到）
 */
/**
 * 一筆事實在敘述裡扮演的角色（R3-H-02）。
 *
 * 角色決定**確定性渲染器**怎麼把它寫成一句話，所以它必須是型別的一部分，
 * 不能靠呼叫端臨時決定。
 */
export const FACT_ROLE = {
  CURRENT_VALUE: 'CURRENT_VALUE',
  BASELINE: 'BASELINE',
  CHANGE: 'CHANGE',
  TREND: 'TREND',
  SUPPORTING_STATISTIC: 'SUPPORTING_STATISTIC',
};

export function fact(metric, value, {
  unit = null, display = null, healthDate = null, windowDays = null,
  readiness = null, supporting = [], publishable = null, allowsStructural = null,
  role = FACT_ROLE.CURRENT_VALUE, provenance = null,
} = {}) {
  const known = Object.prototype.hasOwnProperty.call(METRIC_VOCABULARY, metric);
  const numeric = typeof value === 'number' && Number.isFinite(value);
  const allowed = publishable !== null
    ? Boolean(publishable)
    : known && numeric && !NEVER_PUBLISHABLE.has(metric);
  return {
    /**
     * 這一筆事實的穩定識別碼。渲染出來的每一句斷言都帶著它，
     * 所以「這句話是從哪一筆事實來的」永遠查得到（provenance）。
     */
    factId: `${metric}:${role}:${healthDate ?? windowDays ?? 'na'}`,
    metric,
    role,
    /** 這筆事實是從哪個確定性層算出來的（稽核用，絕不含使用者原話）。 */
    provenance,
    labels: known ? METRIC_VOCABULARY[metric] : [metric],
    value: numeric ? value : null,
    unit,
    display,
    healthDate,
    windowDays,
    readiness,
    publishable: allowed,
    /**
     * 這個指標旁邊可不可以出現「結構性數字」（樣本數、相關係數、
     * 窗口天數…）。
     *
     * 預設跟 publishable 一樣。需要分開是因為有一種合法情況：
     * **關聯敘述**會提到指標名並帶上統計量（r、n、p），但**不會**給那個
     * 指標一個當日數值。那時 publishable 是 false（不可以給值），
     * allowsStructural 卻必須是 true（統計量是確定性層算出來的真實數字）。
     *
     * 反過來，一個「今天完全沒有資料」的指標兩者都是 false ——
     * 否則「你的 HRV 是 30ms」會因為 30 剛好是基準窗天數而通過。
     */
    allowsStructural: allowsStructural === null ? allowed : Boolean(allowsStructural),
    supporting: supporting
      .map((n) => (typeof n === 'number' ? n : Number(n)))
      .filter((n) => Number.isFinite(n)),
  };
}

/**
 * 一組事實。
 *
 * `structural` 是「不是生理數值、但合理會出現在敘述裡」的數字：
 * 樣本數、天數、日期的年月日、窗口長度。它們同樣必須是**確定性層算出來**
 * 的，不是敘述層自己編的。
 */
export function factSet(facts = [], { structural = [], dates = [], label = 'unknown' } = {}) {
  return {
    label,
    facts: facts.filter(Boolean),
    structural: structural
      .map((n) => (typeof n === 'number' ? n : Number(n)))
      .filter((n) => Number.isFinite(n)),
    /**
     * 這組事實涵蓋的日期（YYYY-MM-DD）。
     *
     * 日期必須**獨立處理**，不能丟進數字堆裡：`2026-09-09` 被一般的數字
     * 掃描切成 `2026`、`-09`、`-09`（連字號被讀成負號），於是一個完全正確
     * 的日期會變成「無法歸屬的負數」而誤擋。
     *
     * 分開之後也才能有一條真正的規則：**敘述提到的日期必須是確定性層
     * 給出的日期**，否則就是編出來的（模型很容易編日期）。
     */
    dates: dates.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d ?? ''))),
  };
}

/** 這組事實裡，這個指標的那一筆（沒有就 null）。 */
export function factFor(set, metric) {
  return set.facts.find((f) => f.metric === metric) ?? null;
}

/** 從一個 YYYY-MM-DD 抽出結構性數字（年、月、日、以及不分隔的整串）。 */
export function dateNumbers(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr ?? ''));
  if (!m) return [];
  const [, y, mo, d] = m;
  return [Number(y), Number(mo), Number(d), Number(`${mo}${d}`)];
}

// ---------------------------------------------------------------------------
// 各發布路徑的事實建構器
// ---------------------------------------------------------------------------

/**
 * daily 簡報 → 事實集。
 *
 * briefing.metrics 是 daily.js 的確定性輸出，每一項都已經有 available /
 * value / display / baseline。**不可用的指標一律不可發布**，所以敘述層
 * 連提它一個數字都不行。
 */
export function factsFromBriefing(briefing) {
  const facts = [];
  const structural = [];
  for (const m of briefing?.metrics ?? []) {
    const key = CONFIG_KEY_TO_VOCAB[m.key] ?? m.key;
    const supporting = [];
    if (Number.isFinite(m.baseline)) supporting.push(m.baseline);
    if (Number.isFinite(m.pct)) supporting.push(m.pct, Math.abs(m.pct));
    // display / baselineDisplay 裡的數字（例如 7h01m 的 7 與 1）也算支援值
    for (const s of [m.display, m.baselineDisplay]) {
      for (const n of String(s ?? '').matchAll(/-?\d+(?:\.\d+)?/g)) supporting.push(Number(n[0]));
    }
    facts.push(fact(key, m.available ? m.value : null, {
      unit: m.unit ?? null,
      display: m.display ?? null,
      healthDate: briefing?.localDate ?? null,
      readiness: m.available ? 'AVAILABLE' : 'UNAVAILABLE',
      supporting,
      provenance: 'daily_briefing',
      publishable: Boolean(m.available) && Number.isFinite(m.value),
    }));
  }
  if (Number.isFinite(briefing?.sampleCount)) structural.push(briefing.sampleCount);
  const dates = [briefing?.localDate].filter(Boolean);
  structural.push(...dateNumbers(briefing?.localDate));
  // ⚠️ 刻意**不**塞入「30」「7」這類常數。看起來無害，實際上會讓
  // 「你昨晚睡了 7 小時」這種完全捏造的宣稱因為「7 是結構性數字」而通過。
  // 需要出現的窗口天數一律來自 briefing 自己算出來的欄位。
  return factSet(facts, { structural, dates, label: 'daily' });
}

/** weekly 回顧 → 事實集。 */
export function factsFromWeekly(weekly) {
  const facts = [];
  const structural = [];
  const last = weekly?.last ?? {};
  for (const [key, a] of Object.entries(last.averages ?? {})) {
    const vocab = CONFIG_KEY_TO_VOCAB[key] ?? key;
    const supporting = [];
    for (const n of String(a?.display ?? '').matchAll(/-?\d+(?:\.\d+)?/g)) {
      supporting.push(Number(n[0]));
    }
    const w = weekly?.wow?.[key];
    if (Number.isFinite(w?.pct)) supporting.push(w.pct, Math.abs(w.pct), Math.round(Math.abs(w.pct)));
    if (Number.isFinite(w?.delta)) supporting.push(w.delta, Math.abs(w.delta));
    facts.push(fact(vocab, Number.isFinite(a?.mean) ? a.mean : null, {
      display: a?.display ?? null,
      windowDays: last.days ?? null,
      readiness: Number.isFinite(a?.mean) ? 'AVAILABLE' : 'UNAVAILABLE',
      supporting,
      provenance: 'weekly_stats',
      role: FACT_ROLE.CURRENT_VALUE,
      publishable: Number.isFinite(a?.mean),
    }));
  }
  const dates = [last.startDate, last.endDate].filter(Boolean);
  for (const day of [last.best, last.worst]) {
    if (!day) continue;
    if (day.date) dates.push(day.date);
    structural.push(...dateNumbers(day.date));
    for (const n of String(day.display ?? '').matchAll(/-?\d+(?:\.\d+)?/g)) {
      structural.push(Number(n[0]));
    }
  }
  if (Number.isFinite(last.days)) structural.push(last.days);
  if (Number.isFinite(weekly?.prev?.days)) structural.push(weekly.prev.days);
  structural.push(...dateNumbers(last.startDate), ...dateNumbers(last.endDate));
  return factSet(facts, { structural, dates, label: 'weekly' });
}

/**
 * 健康問答的 structured result → 事實集。
 *
 * ⚠️ 這裡**只**吃 result（確定性 / 統計層的輸出）。
 * 使用者的問題永遠不會進來 —— 那正是 H-02 的核心不變量。
 */
export function factsFromQaResult(result) {
  const facts = [];
  const structural = [];
  if (!result || result.available === false) {
    return factSet([], { structural: [], label: 'qa' });
  }
  const dates = [result.health_date].filter(Boolean);
  structural.push(...dateNumbers(result.health_date));
  if (Number.isFinite(result.history_days)) structural.push(result.history_days);
  if (Number.isFinite(result.window_days)) structural.push(result.window_days);
  if (Number.isFinite(result.n)) structural.push(result.n);

  const addFrom = (key, m, { windowDays = null } = {}) => {
    const vocab = CONFIG_KEY_TO_VOCAB[key] ?? key;
    const supporting = [];
    for (const s of [m?.display, m?.baseline_display, m?.mean_display, m?.current_display]) {
      for (const n of String(s ?? '').matchAll(/-?\d+(?:\.\d+)?/g)) supporting.push(Number(n[0]));
    }
    for (const extra of [m?.baseline_n, m?.n, m?.z_score, m?.stddev]) {
      if (Number.isFinite(extra)) structural.push(extra, Math.abs(extra));
    }
    const value = Number.isFinite(m?.value) ? m.value
      : Number.isFinite(m?.current) ? m.current : null;
    facts.push(fact(vocab, value, {
      display: m?.display ?? m?.current_display ?? null,
      healthDate: result.health_date ?? null,
      windowDays,
      readiness: value === null ? 'UNAVAILABLE' : 'AVAILABLE',
      supporting,
      provenance: 'health_query',
      publishable: value !== null,
    }));
  };

  for (const [key, m] of Object.entries(result.metrics ?? {})) addFrom(key, m);
  if (result.label && (result.current_display || result.window)) {
    // trend_query：主指標
    const key = result.metric ?? result.label;
    addFrom(key, {
      value: Number.isFinite(result.current) ? result.current : null,
      current_display: result.current_display,
      mean_display: result.window?.mean_display,
      n: result.window?.n,
      stddev: result.window?.stddev,
      z_score: result.deviation?.z_score,
    }, { windowDays: result.window?.window_days ?? null });
  }
  for (const d of [result.best?.health_date, result.worst?.health_date]) {
    if (d) dates.push(d);
  }
  for (const c of result.what_changed ?? result.items ?? []) {
    if (Number.isFinite(c?.vs_30d_pct)) structural.push(c.vs_30d_pct, Math.abs(c.vs_30d_pct), Math.round(Math.abs(c.vs_30d_pct)));
    if (Number.isFinite(c?.z_score)) structural.push(c.z_score, Math.abs(c.z_score));
    if (Number.isFinite(c?.importance)) structural.push(c.importance);
  }
  for (const b of result.bedtime_samples ?? []) {
    if (b?.date) dates.push(b.date);
    structural.push(...dateNumbers(b?.date));
    for (const n of String(b?.bedtime ?? '').matchAll(/\d+/g)) structural.push(Number(n[0]));
  }
  return factSet(facts, { structural, dates, label: 'qa' });
}

/**
 * 主動訊息 → 事實集。
 *
 * 訊號與關聯統計都是確定性層算的，所以它們的數字都可以出現；
 * 但**指標仍然受限於訊號真的看到的那一個**。
 */
export function factsFromProactive({ signal = null, association = null } = {}) {
  const facts = [];
  const structural = [];
  const dates = [];
  if (signal) {
    const vocab = CONFIG_KEY_TO_VOCAB[signal.metric] ?? signal.metric;
    const supporting = [];
    for (const k of ['baseline_mean', 'baseline_n', 'z_score', 'effect_size', 'recent_mean', 'previous_mean']) {
      if (Number.isFinite(signal[k])) supporting.push(signal[k], Math.abs(signal[k]));
    }
    facts.push(fact(vocab, Number.isFinite(signal.current) ? signal.current : null, {
      healthDate: signal.health_date ?? null,
      readiness: signal.readiness_status ?? null,
      supporting,
      provenance: 'proactive_signal',
      publishable: Number.isFinite(signal.current),
    }));
    structural.push(...dateNumbers(signal.health_date));
    if (signal.health_date) dates.push(signal.health_date);
  }
  if (association) {
    for (const k of ['n', 'pearson', 'spearman', 'p_value', 'exposed_days', 'unexposed_days', 'lag_days', 'x_mean', 'y_mean', 'x_stddev', 'y_stddev']) {
      const v = association[k];
      if (Number.isFinite(v)) structural.push(v, Math.abs(v), Math.round(Math.abs(v) * 100) / 100);
    }
    const vocab = CONFIG_KEY_TO_VOCAB[association.metric] ?? association.metric;
    if (vocab && Object.prototype.hasOwnProperty.call(METRIC_VOCABULARY, vocab)
        && !facts.some((f) => f.metric === vocab)) {
      // 關聯敘述會提到指標名，但**不會**給它一個當日數值。
      // allowsStructural: true 讓 r / n / p 這些真實統計量可以出現。
      facts.push(fact(vocab, null, {
        publishable: false, readiness: 'ASSOCIATION_ONLY', allowsStructural: true,
      }));
    }
  }
  return factSet(facts, { structural, dates, label: 'proactive' });
}
