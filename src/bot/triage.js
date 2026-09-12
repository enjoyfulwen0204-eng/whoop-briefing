/**
 * 緊急症狀的優先攔截（確定性，不依賴 LLM）。
 *
 * ## 為什麼必須是確定性的、而且必須排在最前面
 *
 * 「我喝酒後胸痛又喘不過氣」這句話同時符合好幾條既有規則：它提到喝酒
 * （可記錄的事件）、提到累（cause_query）、是個問句。原本的路由會先去
 * 寫一筆 journal、再列出一堆 WHOOP 數字、再解釋基準不足 —— 而使用者
 * 正在描述可能需要立刻就醫的狀況。
 *
 * 所以這一關：
 *   · 排在**所有**路由之前（追問消化、journal 寫入、Q&A、LLM fallback）
 *   · 不呼叫 LLM（分類器不可用、逾時、或判錯都不能影響安全）
 *   · 攔下來之後**不寫入任何東西**、不列數據、不談基準、不猜原因
 *
 * ## 不做診斷
 *
 * 這裡不判斷是什麼病，也不宣稱 WHOOP 能排除危險。只做一件事：
 * 把「這聽起來需要真人評估」講清楚，並沿用產品既有的保守用語。
 */

/**
 * 需要立刻被當成緊急處理的描述。
 *
 * 刻意用「症狀詞」而不是情緒強度詞：「累死了」「快虛脫」是日常誇飾，
 * 「喘不過氣」「快昏倒」「意識」不是。
 */
const URGENT_PATTERNS = [
  // 心肺
  /胸(口|部)?(很|好|超)?(痛|悶|緊)/,
  /喘不過氣|呼吸困難|吸不到空氣|無法呼吸/,
  // 意識（含第三人稱轉述：「我朋友叫不醒」「他意識不清」）
  /快(要)?昏倒|要昏倒了|昏過去|失去意識|意識模糊|意識不清|失去知覺|暈倒/,
  /叫不醒|叫不起來|沒有反應|沒反應/,
  // 神經／循環
  /(突然)?(全身)?無力.{0,6}(站不起來|動不了)/,
  /站不起來|癱軟/,
  /冒冷汗/,
  // 併發組合：心悸 + 其他
  /(心跳|心悸).{0,10}(頭暈|暈|呼吸困難|喘)/,
  /(頭暈|暈).{0,10}(心跳(很)?快|心悸|喘)/,
  // 持續嘔吐
  /一直吐|狂吐|吐不停|嘔吐不止/,
];

/** 明顯是日常疲倦的說法 —— 不可以被上面的規則誤判成緊急。 */
const ORDINARY_FATIGUE = [
  /^只是/, /有點(累|疲|沒精神)/, /比較(累|疲倦)/, /運動後.{0,4}(有點)?累/,
];

// ---------------------------------------------------------------------------
// 語境排除
//
// 症狀詞出現 ≠ 這個人現在有這個症狀。獨立稽核找到三種誤判，每一種都會讓
// 使用者收到一整段急診指引：
//
//   這部電影讓我笑到喘不過氣     —— 譬喻
//   我的 recovery 低到快昏倒     —— 拿指標開玩笑
//   我想知道胸痛通常是什麼        —— 衛教問題
//
// 誤判的代價不只是尷尬：每一次狼來了都讓真正需要升級的那一次更容易被忽略。
//
// ⚠️ 排除規則一律**保守**：只排除證據明確的情況。看不懂就維持緊急 ——
// 這個方向的錯誤（多問一次安全）遠比反方向便宜。
// ---------------------------------------------------------------------------

/** 在問這個症狀是什麼、通常怎麼回事 —— 不是在說自己現在這樣。 */
const EDUCATIONAL = /(通常|一般來說|一般而言|哪些|什麼原因|是什麼意思|代表什麼|定義|怎麼分辨|為什麼會有人|想知道)/;

/**
 * 譬喻框架：症狀詞的主語是一個「東西」而不是身體狀況。
 *
 * 「笑到喘不過氣」「工作累到讓人昏倒」「recovery 低到快昏倒」——
 * 共同點是症狀前面有一個「X 到／得」的程度補語結構，而 X 是情緒或指標。
 */
const METAPHOR_FRAMES = [
  /笑(到|得|死)/,
  /(這|那)(部|個|種|隻|本)?\s*(電影|影片|工作|案子|天氣|遊戲|書|片|笑話|梗)/,
  /(recovery|hrv|strain|分數|數字|指數|股票|房價|價格)\s*[^。，,]{0,6}(低|高|爛|差|掉)\s*(到|得)/i,
  // ⚠️ 這裡刻意只抓**主語不是說話者身體**的用法。
  //「我累到快昏倒了」是第一人稱在描述自己的狀態 —— 那要維持緊急；
  //「這個工作累到讓人昏倒」的主語是工作，「讓人」是泛稱，那才是譬喻。
  /(累|忙|煩|氣)\s*到\s*讓人\s*(昏倒|昏過去|喘不過氣|站不起來)/,
  /(工作|案子|天氣|事情|行程|會議|考試|報告)[^。，,]{0,4}(累|忙|煩)\s*到/,
  /嚇死人|誇張到|扯到/,
];

/** 已經過去而且已經緩解。 */
const RESOLVED = /(已經)?(好了|沒事了|恢復了|不會了|沒問題了|退了|緩解了)/;

/** 否定詞（只看症狀詞前面很近的範圍）。 */
const NEGATORS = /(沒有|沒|不會|不曾|未|並沒|沒在)/;
const NEG_WINDOW = 6;

/** 這個症狀詞是被引號框起來在討論的嗎？ */
function isQuoted(text, index, length) {
  const before = text.slice(Math.max(0, index - 2), index);
  const after = text.slice(index + length, index + length + 2);
  return /[「『"'（(]/.test(before) && /[」』"'）)]/.test(after);
}

/**
 * 這個匹配到的症狀，在語境上是否**不是**當下的症狀陳述？
 *
 * @returns {?string} 排除原因；null 代表沒有排除理由（維持緊急）
 */
function contextualExclusion(text, match) {
  const index = match.index ?? text.indexOf(match[0]);
  const matched = match[0];

  if (isQuoted(text, index, matched.length)) return 'quoted';

  // 否定：「我沒有胸痛也沒有呼吸困難」
  const window = text.slice(Math.max(0, index - NEG_WINDOW), index);
  if (NEGATORS.test(window)) return 'negated';

  if (METAPHOR_FRAMES.some((re) => re.test(text))) return 'figurative';
  if (EDUCATIONAL.test(text)) return 'educational';
  if (RESOLVED.test(text)) return 'resolved_past';
  return null;
}

/**
 * 這則訊息聽起來需不需要立刻的真人評估？
 *
 * @returns {{urgent:boolean, matched:?string, excluded:?string}}
 */
export function assessUrgency(text) {
  const t = String(text ?? '').trim();
  if (!t) return { urgent: false, matched: null, excluded: null };

  let lastExclusion = null;
  for (const re of URGENT_PATTERNS) {
    const m = t.match(re);
    if (!m) continue;
    // 日常疲倦的措辭優先（「運動後有點累」不該因為含「累」被拉進來）
    if (ORDINARY_FATIGUE.some((ok) => ok.test(t))) continue;
    const excluded = contextualExclusion(t, m);
    if (excluded) { lastExclusion = excluded; continue; }
    return { urgent: true, matched: m[0], excluded: null };
  }
  return { urgent: false, matched: null, excluded: lastExclusion };
}

/**
 * 這是在**問一個症狀是什麼**（而不是在說自己現在這樣）嗎？
 *
 * 「我想知道胸痛通常是什麼」「胸痛通常有哪些原因？」「『喘不過氣』是什麼意思？」
 * 都不該觸發急診指引 —— 但也不該掉到指令清單，那等於聽不懂一個合理的問題。
 *
 * 回答則刻意**不做症狀衛教**：胸痛、呼吸困難這類症狀的成因判斷需要真人評估，
 * 給一份「常見原因清單」有可能讓人自己排除掉危險的可能。所以只說明界線，
 * 並把人導向能真正回答的地方。
 */
export function isSymptomEducationQuestion(text) {
  const t = String(text ?? '').trim();
  if (!t) return false;
  const hit = URGENT_PATTERNS.some((re) => re.test(t));
  if (!hit) return false;
  if (assessUrgency(t).urgent) return false;       // 真的緊急就不是在問問題
  return EDUCATIONAL.test(t) || /是什麼意思|代表什麼/.test(t);
}

/** 症狀類問題的安全回覆：說明界線，不列成因。 */
export function symptomEducationReply() {
  return [
    '這類症狀的成因我沒辦法幫你判斷 —— 胸痛、呼吸困難、意識改變這些都需要真人評估，'
    + '我如果給你一份「常見原因」清單，反而可能讓你把真正要緊的可能排除掉。',
    '',
    '如果你現在正在經歷這些症狀，請直接尋求醫療協助。'
    + '如果只是想了解，建議問醫師或護理人員 —— 他們可以結合你的病史一起看。',
    '',
    '我這邊能幫的是你自己的 WHOOP 數據，例如「我今天狀態怎樣」或「最近 HRV 如何」。',
  ].join('\n');
}

/**
 * 緊急時的回覆。
 *
 * 三件事，不多不少：把安全放在最前面、建議真人評估、說清楚我幫不上這個忙。
 * 刻意**不**列任何數據 —— 那會暗示「數字看起來還好」可以拿來排除危險，
 * 而這個系統沒有能力做那種判斷。
 */
export function urgentReply() {
  return [
    '你描述的狀況聽起來需要優先處理安全，這比任何數據都重要。',
    '',
    '如果症狀正在發生或持續，請立刻尋求醫療協助 —— 聯絡當地緊急醫療服務，'
    + '或請身邊的人陪你就醫。',
    '',
    '我沒有能力判斷這是什麼狀況，WHOOP 的數據也不能用來排除危險，'
    + '所以我不會在這裡幫你分析數字。等你安全了，我們再回來看資料。',
  ].join('\n');
}
