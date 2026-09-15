/**
 * 敘述的**發布邊界**（H-05）。
 *
 * ## 被推翻的那個架構
 *
 * 前三輪的形狀一直是：
 *
 *     模型自由寫一段話 → 一組規則檢查它 → 通過就原文發布
 *
 * 稽核連續三輪證明這條路走不通，而這一輪給了決定性的反例：
 *
 *     「熬夜使你的免疫力下降。」
 *
 * 這句話沒有數字、沒有指標名、沒有拉丁字母、沒有藥名、沒有病名，所以
 * 每一條規則都放行。但它是一個**因果生理宣稱**，而且完全沒有證據支撐。
 * 同一輪還通過了「自律神經失衡」「粒線體效率低落」——
 * 每一個都可以再加一條規則擋掉，然後模型會寫出第四個。
 *
 * 問題從來不是規則不夠多。問題是：
 *
 *   **只要「已發布的文字」由模型產生，驗證就是在窮舉一個無限集合。**
 *
 * ## 這一輪的架構：模型不再產生文字
 *
 * 應用程式先把**所有**可以說的話寫好，每一句一個 id：
 *
 *     f_facts      「今天恢復 28%、睡眠 7h12m。」
 *     f_flagged    「其中 恢復、HRV 和你的個人基準有明顯差距，值得留意。」
 *     f_advice_ease「今天適合把強度放輕一點，讓身體有時間補回來。」
 *     ...
 *
 * 模型拿到的是這份清單，它唯一能回的是**一串 id**：
 *
 *     { "order": ["f_facts", "f_flagged", "f_advice_ease"] }
 *
 * 然後由這裡照 id 把**應用程式自己寫的句子**接起來。
 *
 * ## 為什麼這樣就關上了那個無限集合
 *
 * 模型的輸出通道裡**沒有自由文字這個東西**。它送回來的每一個 token 只可能
 * 是「清單裡的某個 id」或「不是 id」；後者一律整包丟掉。
 *
 * 所以「熬夜使你的免疫力下降」不需要被辨認、被分類、被列進任何黑名單 ——
 * 它根本沒有地方可以出現。新的幻覺句型、新的醫學名詞、新的語言、
 * 新的越獄手法，全部同時失效，而且不需要我們預先想到它們。
 *
 * 模型剩下的權力只有**挑選與排序**，而每一個候選項都是應用程式已經
 * 核可的斷言。它挑得再糟，最壞情況也只是一段語序怪異的正確敘述。
 *
 * ## 模型不可用時
 *
 * 用 defaultOrder。那正是原本的確定性敘述，逐字相同 ——
 * 所以「沒有模型」與「有模型」的差別只有句子的順序與取捨，
 * 不是「有沒有敘述」。使用者永遠拿得到一段完整、可讀、正確的話。
 */

import { validateDeterministicMessage } from './publishGuard.js';
import { log } from './logger.js';

/** 一份計畫最多幾段。夠用而且擋掉「把同一句重複一百次」這種輸出。 */
export const MAX_FRAGMENTS = 8;

/**
 * 把 briefing 變成一份**封閉**的候選句子清單。
 *
 * 每一句都由應用程式從已核可的事實組出來，所以它們可以（也應該）包含
 * 指標名與數字 —— 那正是確定性渲染器該做的事。
 *
 * @returns {{fragments: {id:string, text:string, required:boolean}[], defaultOrder: string[]}}
 */
export function buildFragmentCatalogue(briefing, { period = 'daily' } = {}) {
  const when = period === 'weekly' ? '上週' : '今天';
  const laterWhen = when === '上週' ? '這週' : '今天';
  const stage = briefing?.stage;
  const metrics = (briefing?.metrics ?? []).filter((m) => m.available);
  const byKey = Object.fromEntries(metrics.map((m) => [m.key, m]));
  const calibrating = metrics.some((m) => m.calibrating);

  const fragments = [];
  const order = [];
  /**
   * @param {boolean} required 這一句是**事實骨幹**，模型不可以把它丟掉。
   *   少了它，敘述會變成「只有鼓勵沒有內容」。
   */
  const add = (id, text, { required = false } = {}) => {
    if (!text) return;
    fragments.push({ id, text, required });
    order.push(id);
  };

  const recovery = byKey.recovery_score ?? byKey.recovery;
  const sleep = byKey.sleep_total;
  const facts = [recovery && `恢復 ${recovery.display}`, sleep && `睡眠 ${sleep.display}`]
    .filter(Boolean).join('、');

  // --- 冷啟動：完全不同的一組句子（不可以跟成熟期混用）---------------------
  if (stage === 'cold') {
    add('f_cold_facts', facts ? `${when}${facts}。` : `${when}的數字我已經收到了。`,
      { required: true });
    add('f_cold_baseline',
      '個人基準還在建立，所以這幾個數字目前只當作紀錄，還不能用來判斷是否偏離你的常態。',
      { required: true });
    if (calibrating) {
      add('f_cold_calibrating', 'WHOOP 的恢復數據也還在校正期，這段期間的數值不適合當基準。');
    }
    add('f_cold_advice', '先照平常的節奏作息，資料累積起來之後我能給的判斷會具體很多。');
    return { fragments, defaultOrder: order };
  }

  // --- 成熟期 -------------------------------------------------------------
  const flagged = metrics.filter((m) => m.severity === 'red' || m.severity === 'yellow');
  const withBaseline = metrics.filter((m) => m.baselineDisplay && m.severity);
  const missingBaseline = metrics.filter((m) => !m.baselineDisplay);

  add('f_facts', facts ? `${when}${facts}。` : `${when}的指標已經整理好了。`,
    { required: true });

  if (flagged.length) {
    add('f_flagged',
      `其中 ${flagged.map((m) => m.label).join('、')} 和你的個人基準有明顯差距，值得留意。`,
      { required: true });
  } else if (withBaseline.length) {
    add('f_normal', `對照你的個人基準，${when}沒有特別需要注意的偏離。`, { required: true });
  }

  if (missingBaseline.length && withBaseline.length) {
    add('f_missing_baseline',
      `另外，${missingBaseline.map((m) => m.label).join('、')} 的基準還在累積，那幾項${when}先不下判斷。`);
  }

  if (briefing?.trends?.alerts?.length) {
    add('f_trends',
      `另外 ${briefing.trends.alerts.map((a) => a.label).join('、')} 出現連續變化，可以多觀察幾天。`);
  }

  add('f_advice',
    flagged.length
      ? `${laterWhen}適合把強度放輕一點，讓身體有時間補回來。`
      : '維持目前的節奏就好。',
    { required: true });

  return { fragments, defaultOrder: order };
}

/** 把一組 id 依序接成文字。純字串串接，沒有任何模型內容進得來。 */
export function renderFragments(catalogue, order) {
  const byId = new Map(catalogue.fragments.map((f) => [f.id, f]));
  return order.map((id) => byId.get(id)?.text ?? '').join('');
}

/**
 * 驗證模型交回來的計畫。
 *
 * 這裡**不檢查語意**，因為沒有語意可以檢查 —— 所有句子都是我們自己寫的。
 * 只檢查結構：
 *
 *   · 真的是一個 id 陣列
 *   · 每一個 id 都在清單裡（不認識的一律整包拒絕，不是略過）
 *   · 沒有重複
 *   · 事實骨幹沒有被丟掉
 *   · 長度在合理範圍
 *
 * 「不認識的 id 就整包拒絕」是刻意的：一個編造出來的 id 代表模型沒有照
 * 規則玩，那時候它挑的其他東西也不值得信任。退回確定性順序的代價是零。
 *
 * @returns {{ok:true, order:string[]} | {ok:false, reason:string}}
 */
export function validatePlan(catalogue, plan) {
  const raw = plan?.order ?? plan;
  if (!Array.isArray(raw)) return { ok: false, reason: 'plan_not_array' };
  if (!raw.length) return { ok: false, reason: 'plan_empty' };
  if (raw.length > MAX_FRAGMENTS) return { ok: false, reason: 'plan_too_long' };

  const known = new Set(catalogue.fragments.map((f) => f.id));
  const seen = new Set();
  const order = [];
  for (const item of raw) {
    if (typeof item !== 'string') return { ok: false, reason: 'plan_non_string_id' };
    const id = item.trim();
    if (!known.has(id)) return { ok: false, reason: 'plan_unknown_id' };
    if (seen.has(id)) return { ok: false, reason: 'plan_duplicate_id' };
    seen.add(id);
    order.push(id);
  }

  const missingRequired = catalogue.fragments
    .filter((f) => f.required && !seen.has(f.id))
    .map((f) => f.id);
  if (missingRequired.length) return { ok: false, reason: 'plan_missing_required' };

  return { ok: true, order };
}

/**
 * 交給模型看的東西。
 *
 * 刻意**只有** id 與句子本身 —— 沒有原始指標鍵、沒有 baseline 數值、
 * 沒有內部狀態。模型看不到的東西，就不可能在輸出裡洩漏出來。
 */
export function catalogueForModel(catalogue) {
  return catalogue.fragments.map((f) => ({
    id: f.id, text: f.text, required: f.required,
  }));
}

/**
 * 最後一道**深度防禦**：渲染出來的文字仍然要通過確定性樣板守門。
 *
 * 這裡擋的不是模型（模型已經碰不到文字了），而是**我們自己**：
 * 有人日後把一句不該有的話加進 buildFragmentCatalogue 時，要在這裡被擋下來。
 *
 * @returns {boolean}
 */
export function fragmentsArePublishable(text, { label = 'narrative' } = {}) {
  const v = validateDeterministicMessage(text);
  if (!v.ok) {
    log.error('narrative_template_violation', { label, violations: v.violations.slice(0, 8) });
  }
  return v.ok;
}
