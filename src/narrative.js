/**
 * 簡報的自然語言敘述層。
 *
 * ## 這個模組存在的理由
 *
 * 正式環境曾經把教練整個關掉（`coachText = null`），於是**每一天**的簡報
 * 結尾都是：
 *
 *     ⚠️ AI 教練分析今天暫時無法生成，數據簡報仍正常
 *
 * 那句話是假的：根本沒有嘗試生成過。使用者每天被告知一個不存在的故障，
 * 同時也真的失去了敘述。
 *
 * ## 權責邊界（不可退讓）
 *
 * **應用程式擁有所有健康判斷**：選哪一天、數值、基準、樣本數、成熟度、
 * 嚴重度、趨勢、貢獻因素、校正期限制。模型只能做一件事 ——
 * 把**已經核可的事實**講成自然的中文。
 *
 * 模型不得：帶進新數字、自己算基準、改嚴重度、發明趨勢、診斷、宣稱因果、
 * 發明症狀或 Journal 事件、在沒有有效基準時說「偏低／異常」。
 *
 * 這不是靠 prompt 拜託它，是靠**輸出驗證**：生成完之後逐項比對，任何一項
 * 不過就整段丟掉、改用確定性敘述。丟掉的代價只是少一段潤飾的話 ——
 * 數字與判定本來就是程式算好也印好的。
 */

import { guardExplanation } from './publishGuard.js';
import { log } from './logger.js';

/** 失敗分類。只進日誌與 report detail，不會出現在使用者眼前。 */
export const NARRATIVE_SOURCE = Object.freeze({
  MODEL: 'model',
  DETERMINISTIC: 'deterministic',
});

export const NARRATIVE_FAILURE = Object.freeze({
  NOT_CONFIGURED: 'not_configured',
  PROVIDER_UNAVAILABLE: 'provider_unavailable',
  TIMEOUT: 'timeout',
  EMPTY_OUTPUT: 'empty_output',
  UNSUPPORTED_NUMBER: 'unsupported_number',
  UNSUPPORTED_CLAIM: 'unsupported_claim',
  DIAGNOSIS: 'diagnosis',
  TREATMENT: 'treatment_advice',
  CAUSALITY: 'causality',
  INTERNAL_LEAK: 'internal_leak',
  TOO_LONG: 'too_long',
});

const MAX_CHARS = 420;

/**
 * 驗證模型輸出。
 *
 * ★ 直接沿用既有的發布邊界（publishGuard.validateExplanation），不另寫一套。
 *
 * 那個模組是前幾輪稽核打磨出來的**封閉**判準：出現任何指標名、任何數字、
 * 任何治療／用藥、任何診斷措辭、任何強因果或即時生理宣稱，就整段丟掉。
 * 自己再寫一套只會比它弱 —— 實測過：手寫版放過了「你有心臟病」
 *「你的脈搏為９９bpm」「晚餐後吃 Zorblax」。
 *
 * 這條線之所以敢調得這麼兇，是因為**數字與判定本來就不該由模型產出**：
 * 它們已經由 renderDaily 與下面的確定性敘述印出來了。模型那一段是純粹的
 * 語氣潤飾，丟掉不會少任何資訊。
 */
/**
 * 這一段文字裡有沒有任何「身體宣稱」的味道？
 *
 * publishGuard 擋的是**已知詞彙表**裡的指標名與數字。實測它放得過：
 *
 *   你有心臟病。            病名不在指標詞彙表裡
 *   你的脈搏偏快。          脈搏不是我們量的指標
 *   你的脈搏為９９bpm。     全形數字沒被正規化
 *   建議你每天服用阿斯匹靈。 藥名不在任何清單裡
 *   晚餐後吃 Zorblax。      發明出來的藥名，永遠不會在清單裡
 *
 * 所以這裡改成**形狀白名單**而不是黑名單：這段文字是純粹的中文語氣潤飾，
 * 它不需要拉丁字母、不需要任何數字、也不需要提到任何身體部位或藥物。
 * 只要出現，就整段丟掉。
 *
 * 丟掉的代價是少一句鼓勵的話 —— 數字與判定都已經由確定性那一段印出來了。
 * 這個不對稱就是它可以「寧可錯殺」的理由。
 */
const LATIN = /[A-Za-z]/;                       // Zorblax、bpm、WHOOP…
const FULLWIDTH_DIGIT = /[０-９]/;
const BODY_OR_TREATMENT = new RegExp([
  '病', '症', '診斷', '罹患', '中風', '腫瘤',
  '脈搏', '血壓', '血糖', '體溫', '心跳', '呼吸道', '器官',
  '藥', '服用', '處方', '劑量', '療程', '打針', '手術',
  '年紀', '年齡', '壽命',
].join('|'));

export function validateNarrative(text) {
  const t = String(text ?? '').trim();
  if (!t) return { ok: false, reason: NARRATIVE_FAILURE.EMPTY_OUTPUT, detail: null };
  if (t.length > MAX_CHARS) {
    return { ok: false, reason: NARRATIVE_FAILURE.TOO_LONG, detail: String(t.length) };
  }
  if (LATIN.test(t) || FULLWIDTH_DIGIT.test(t)) {
    return { ok: false, reason: NARRATIVE_FAILURE.UNSUPPORTED_NUMBER, detail: 'non_chinese_token' };
  }
  const bodyHit = t.match(BODY_OR_TREATMENT);
  if (bodyHit) {
    const treatment = /藥|服用|處方|劑量|療程|打針|手術/.test(bodyHit[0]);
    return {
      ok: false,
      reason: treatment ? NARRATIVE_FAILURE.TREATMENT : NARRATIVE_FAILURE.DIAGNOSIS,
      detail: bodyHit[0],
    };
  }
  const guard = guardExplanation(t, { label: 'briefing_narrative' });
  if (guard.used === 'llm') return { ok: true, reason: null, detail: null };
  const first = guard.violations[0] ?? '';
  const reason = first.startsWith('metric_mention') ? NARRATIVE_FAILURE.UNSUPPORTED_CLAIM
    : first.startsWith('numeric_claim') ? NARRATIVE_FAILURE.UNSUPPORTED_NUMBER
      : first.startsWith('treatment_advice') ? NARRATIVE_FAILURE.TREATMENT
        : first.startsWith('diagnosis') ? NARRATIVE_FAILURE.DIAGNOSIS
          : first.startsWith('causal') ? NARRATIVE_FAILURE.CAUSALITY
            : NARRATIVE_FAILURE.UNSUPPORTED_CLAIM;
  return { ok: false, reason, detail: first.slice(0, 60) };
}

/**
 * 確定性敘述：模型不可用、或輸出被否決時使用。
 *
 * 它**不是**錯誤訊息。使用者拿到的仍然是一段可讀的話，而且內容完全來自
 * 已核可的事實 —— 只是少了潤飾。絕不宣稱「AI 暫時無法生成」，因為那句話
 * 在多數情況下是假的，而且對使用者毫無意義。
 */
export function deterministicNarrative(briefing, { period = 'daily' } = {}) {
  // 週報講的是「上週」，日報講的是「今天」。用同一段文字會寫出
  //「今天恢復 65%」配在一份週回顧底下 —— 事實對，但話是錯的。
  const when = period === 'weekly' ? '上週' : '今天';
  const stage = briefing?.stage;
  const metrics = (briefing?.metrics ?? []).filter((m) => m.available);
  const byKey = Object.fromEntries(metrics.map((m) => [m.key, m]));
  const calibrating = metrics.some((m) => m.calibrating);
  const out = [];

  const recovery = byKey.recovery_score ?? byKey.recovery;
  const sleep = byKey.sleep_total;
  const facts = [recovery && `恢復 ${recovery.display}`, sleep && `睡眠 ${sleep.display}`]
    .filter(Boolean).join('、');

  if (stage === 'cold') {
    out.push(facts ? `${when}${facts}。` : `${when}的數字我已經收到了。`);
    out.push('個人基準還在建立，所以這幾個數字目前只當作紀錄，'
      + '還不能用來判斷是否偏離你的常態。');
    if (calibrating) out.push('WHOOP 的恢復數據也還在校正期，這段期間的數值不適合當基準。');
    out.push('先照平常的節奏作息，資料累積起來之後我能給的判斷會具體很多。');
    return out.join('');
  }

  const flagged = metrics.filter((m) => m.severity === 'red' || m.severity === 'yellow');
  const withBaseline = metrics.filter((m) => m.baselineDisplay && m.severity);
  const missingBaseline = metrics.filter((m) => !m.baselineDisplay);

  out.push(facts ? `${when}${facts}。` : `${when}的指標已經整理好了。`);
  if (flagged.length) {
    out.push(`其中 ${flagged.map((m) => m.label).join('、')} 和你的個人基準有明顯差距，值得留意。`);
  } else if (withBaseline.length) {
    out.push(`對照你的個人基準，${when}沒有特別需要注意的偏離。`);
  }
  if (missingBaseline.length && withBaseline.length) {
    out.push(`另外，${missingBaseline.map((m) => m.label).join('、')} 的基準還在累積，那幾項${when}先不下判斷。`);
  }
  if (briefing?.trends?.alerts?.length) {
    out.push(`另外 ${briefing.trends.alerts.map((a) => a.label).join('、')} 出現連續變化，可以多觀察幾天。`);
  }
  out.push(flagged.length
    ? `${when === '上週' ? '這週' : '今天'}適合把強度放輕一點，讓身體有時間補回來。`
    : '維持目前的節奏就好。');
  return out.join('');
}

/**
 * 產生敘述：先問模型，驗證過才用；否則用確定性敘述。
 *
 * **一定會回傳一段可讀的文字**，永遠不會回 null —— 呼叫端不需要再處理
 * 「沒有敘述」這個狀態，也就不會再出現那句假的「暫時無法生成」。
 */
/**
 * 產生敘述。
 *
 * @param generate  () => Promise<string|null>
 *   實際去問模型的那一步。用既有的 `coach.daily()` / `coach.weekly()` ——
 *   它們已經有 prompt、模型路由、重試與 ai_usage 計費，失敗時回 null。
 *   這裡不另外組 prompt，避免出現第二套「餵給模型的東西」。
 */
export async function buildNarrative({ briefing, generate, period = 'daily' }) {
  // ★ 確定性敘述**永遠**存在，而且永遠在前面。
  //
  // 它由應用程式用已核可的事實組成，所以它可以講數字與指標名 —— 那是
  // application-owned assertion，跟 renderDaily 印出來的表格同源。
  // 模型那一段只是附加的語氣潤飾，必須完全不含任何生理斷言。
  const base = deterministicNarrative(briefing, { period });

  if (typeof generate !== 'function') {
    log.info('narrative_deterministic', { reason: NARRATIVE_FAILURE.NOT_CONFIGURED });
    return {
      text: base, source: NARRATIVE_SOURCE.DETERMINISTIC,
      failureCategory: NARRATIVE_FAILURE.NOT_CONFIGURED,
    };
  }

  let raw;
  try {
    raw = await generate();
  } catch (err) {
    const category = /timeout|abort/i.test(String(err?.message ?? ''))
      ? NARRATIVE_FAILURE.TIMEOUT : NARRATIVE_FAILURE.PROVIDER_UNAVAILABLE;
    log.warn('narrative_deterministic', { reason: category });
    return { text: base, source: NARRATIVE_SOURCE.DETERMINISTIC, failureCategory: category };
  }

  // coach.daily()/weekly() 失敗時回 null —— 那是「拿不到供應商」，不是空輸出。
  if (raw === null || raw === undefined) {
    log.info('narrative_deterministic', { reason: NARRATIVE_FAILURE.PROVIDER_UNAVAILABLE });
    return {
      text: base, source: NARRATIVE_SOURCE.DETERMINISTIC,
      failureCategory: NARRATIVE_FAILURE.PROVIDER_UNAVAILABLE,
    };
  }

  const check = validateNarrative(raw);
  if (!check.ok) {
    // 被否決的內容**絕不**進入日誌或輸出 —— 那正是我們判定為不可信的文字。
    log.warn('narrative_rejected', { reason: check.reason, detail: check.detail });
    return { text: base, source: NARRATIVE_SOURCE.DETERMINISTIC, failureCategory: check.reason };
  }
  return {
    text: `${base}\n\n${String(raw).trim()}`,
    source: NARRATIVE_SOURCE.MODEL,
    failureCategory: null,
  };
}
