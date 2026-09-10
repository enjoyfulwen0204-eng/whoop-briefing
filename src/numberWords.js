/**
 * 把中文與英文的「數字詞」正規化成阿拉伯數字（R2-H-02 的前置零件）。
 *
 * ## 為什麼發布邊界需要這個
 *
 * 發布邊界的核心規則是「敘述裡的**每一個數字**都必須對應到一筆可發布的
 * 結構化事實」。如果只掃阿拉伯數字，那麼
 *
 *   「你今天的恢復是九十九%」
 *   「HRV came in at thirty milliseconds」
 *
 * 就會整句沒有任何數字可掃，直接通過。實測確認：改寫成中文數字之後
 * 舊版完全放行。
 *
 * 所以掃描之前必須先把數字詞換成數字。這個模組**只做這一件事**，
 * 而且刻意不追求語言學上的完備 —— 它的工作是讓「用字詞寫數字」不再是
 * 一條繞過檢查的路，而不是解析任意自然語言數字。涵蓋範圍：
 *
 *   中文：零〇一二三四五六七八九十百千萬 + 兩 + 半
 *   英文：zero..twenty, thirty..ninety, hundred, thousand
 *
 * 保守優先：看不懂的組合就**不動**它，讓後面的規則照原樣處理
 * （不會因為這裡看不懂而變成「沒有數字」）。
 */

const ZH_DIGIT = new Map(Object.entries({
  零: 0, 〇: 0, 一: 1, 壹: 1, 二: 2, 兩: 2, 貳: 2, 三: 3, 參: 3, 四: 4, 五: 5,
  六: 6, 七: 7, 八: 8, 九: 9,
}));

const ZH_UNIT = new Map(Object.entries({ 十: 10, 拾: 10, 百: 100, 千: 1000, 萬: 10000 }));

/** 一段純中文數字（不含單位詞如「歲」「分」）→ 數值，看不懂回 null。 */
export function parseChineseNumber(text) {
  const s = String(text ?? '').trim();
  if (!s) return null;

  // 「兩三天」「三四次」「七八個」——中文的**約略說法**，不是數字。
  // 合式的中文數字只要 ≥ 10 就一定帶位數字（十／百／千／萬），所以
  // 「連續兩個以上的數字字元、卻沒有任何位數字」必然是約略語，
  // 不可以被讀成一個量。少了這一條，「兩三天內會恢復」會變成「3天內」。
  const chars = [...s];
  if (chars.length >= 2 && !chars.some((c) => ZH_UNIT.has(c))) return null;

  let total = 0;      // 已經結算的部分
  let section = 0;    // 目前這一節（萬以下）
  let digit = null;   // 待用的個位數
  let seen = false;

  for (const ch of s) {
    if (ZH_DIGIT.has(ch)) {
      digit = ZH_DIGIT.get(ch);
      seen = true;
      continue;
    }
    if (ZH_UNIT.has(ch)) {
      const unit = ZH_UNIT.get(ch);
      seen = true;
      if (unit === 10000) {
        total += (section + (digit ?? 0)) * unit;
        section = 0;
        digit = null;
        continue;
      }
      // 「十」開頭代表 10（十五 = 15），不是 0 * 10
      section += (digit ?? 1) * unit;
      digit = null;
      continue;
    }
    return null;   // 出現不認得的字 → 整段放棄，保守處理
  }
  if (!seen) return null;
  const value = total + section + (digit ?? 0);
  return Number.isFinite(value) ? value : null;
}

const EN_SMALL = new Map(Object.entries({
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60,
  seventy: 70, eighty: 80, ninety: 90,
}));

/** 一段英文數字詞（如 "ninety nine", "one hundred"）→ 數值，看不懂回 null。 */
export function parseEnglishNumber(text) {
  const words = String(text ?? '').toLowerCase().trim()
    .split(/[\s-]+/).filter((w) => w && w !== 'and');
  if (!words.length) return null;

  let total = 0;
  let current = 0;
  let seen = false;
  for (const w of words) {
    if (EN_SMALL.has(w)) {
      current += EN_SMALL.get(w);
      seen = true;
      continue;
    }
    if (w === 'hundred') { current = (current || 1) * 100; seen = true; continue; }
    if (w === 'thousand') { total += (current || 1) * 1000; current = 0; seen = true; continue; }
    return null;
  }
  if (!seen) return null;
  return total + current;
}

/**
 * 含數字字元、但完全不是數字的常見中文詞。
 *
 * 只用在積極模式的遮罩上。長詞優先，避免「第一」被「一」先吃掉。
 */
const ZH_NON_NUMERIC_WORDS = [
  '一起', '一下', '一樣', '一直', '一定', '一點', '一些', '一切', '一律',
  '一般', '一旦', '一連', '一時', '一向', '一面', '一邊', '一心', '一致',
  '一度', '一如', '再一', '之一', '唯一', '統一', '專一', '單一',
  '第一', '第二', '第三', '十分', '千萬', '萬一',
].sort((a, b) => b.length - a.length);

const ZH_NUMBER_CHARS = [...ZH_DIGIT.keys(), ...ZH_UNIT.keys()].join('');
const EN_WORDS = [...EN_SMALL.keys(), 'hundred', 'thousand'].join('|');

/**
 * 量詞／單位：出現在數字後面就代表前面那串真的是一個「量」。
 */
/**
 * 明確的單位：只要跟在數字後面，前面那串一定是一個量。
 * 單字元的中文數字（一、十）配這些單位也不會是慣用語。
 */
const UNIT_STRICT = '%|％|分鐘|毫秒|ms|bpm|歲|公斤|kg|℃|°C|小時|hours?|minutes?|seconds?|milliseconds?|years?|percent';

/**
 * **有歧義**的單位：中文裡「十分穩定」「一次」「一天」「一度」「一成」
 * 都是慣用語，不是量。所以配這些單位時要求數字串至少兩個字
 * （「八十八分」是量，「十分」不是）。
 */
const UNIT_LOOSE = '分|秒|次|天|日|時|度|成|points?|days?';

/** 「這是一個值」的連接詞。 */
const CONNECTOR_BEFORE = '是|為|達到|達|約|大約|有|到|：|:|=';

/**
 * 什麼時候才把中文數字詞換成阿拉伯數字。
 *
 * ## 為什麼不是「全部都換」
 *
 * 中文有大量含數字字元但**完全不是數字**的詞：一起、一下、一樣、一直、
 * 一定、第一、唯一、十分（很）、千萬（絕對不要）…… 無條件替換會把
 * 「一起加油」變成「1起加油」，於是一句完全正常的教練文字裡憑空多出一個
 * 「無法歸屬的數字」，被發布邊界誤擋。
 *
 * ## 判準：只在文字真的在「宣稱一個量」時才換
 *
 * 三個條件任一成立就換（每一個都要求數字是完整的值，不是詞的一部分）：
 *
 *   (a) 後面緊跟量詞／單位            「恢復是九十九%」「三十毫秒」
 *   (b) 前面是值連接詞，且後面是邊界   「估算的年齡是三十。」
 *   (c) 前面緊跟一個指標名，且後面是邊界「恢復九十九」
 *
 * 漏判的代價是「這個數字沒被換成阿拉伯數字」；誤判的代價是「正常句子被
 * 擋掉」。兩者都不會讓**捏造的數值**被發布 —— 因為攻擊者若改寫成不像在
 * 宣稱量的句子，那句話也就不再是一個可讀的生理數值宣稱。
 *
 * `metricTerms` 由呼叫端傳入（發布邊界會傳系統完整的指標詞彙表），
 * 沒傳就只用 (a) 與 (b)。
 */
/**
 * 「積極模式」：把**所有**看起來像數字的字詞都轉成阿拉伯數字。
 *
 * 只用在 R3-H-02 的「LLM 說明不得含任何生理斷言」檢查上。那個檢查的
 * 誤判代價是**丟掉一段純裝飾的文字**（數字與判定都已經由確定性渲染器
 * 輸出了），所以寧可錯殺 —— 而這正是它可以不依賴列舉的原因。
 *
 * 一般的正規化（下面那個）仍然保守，因為它會影響真正要發布的內容。
 */
export function normalizeNumberWordsAggressive(text) {
  let out = String(text ?? '');
  // 先把「含數字字元但完全不是數字」的常見詞遮起來。
  //
  // ⚠️ 這份清單是列舉沒錯，但它列的是**安全的東西**：漏掉一個只會多丟
  // 一句裝飾文字，攻擊者也無法靠它夾帶數值（詞是固定字串）。
  // 真正的防線是「來源只能是確定性渲染器」，不是這份清單。
  const masked = [];
  out = out.replace(new RegExp(ZH_NON_NUMERIC_WORDS.join('|'), 'g'), (m) => {
    masked.push(m);
    return `\u0000${masked.length - 1}\u0000`;
  });
  const zhRun = new RegExp(`[${ZH_NUMBER_CHARS}]{1,8}`, 'g');
  out = out.replace(zhRun, (m) => {
    // 積極模式連「兩三」這種約略說法也視為數字（寧可錯殺）
    const n = parseChineseNumber(m) ?? parseChineseNumber(m[0]);
    return n === null ? m : String(n);
  });
  out = out.replace(/\u0000(\d+)\u0000/g, (_, i) => masked[Number(i)]);
  const enRun = new RegExp(`\\b(?:${EN_WORDS})(?:[\\s-](?:and[\\s-])?(?:${EN_WORDS}))*\\b`, 'gi');
  out = out.replace(enRun, (m) => {
    const n = parseEnglishNumber(m);
    return n === null ? m : String(n);
  });
  return out;
}

export function normalizeNumberWords(text, { metricTerms = [] } = {}) {
  let out = String(text ?? '');
  const terms = metricTerms
    .filter(Boolean)
    .map((t) => String(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .sort((a, b) => b.length - a.length)
    .join('|');
  const BOUNDARY = '$|[\\s。，、；：！？.,;:!?)）」』】\\]]';

  const zhRun = `[${ZH_NUMBER_CHARS}]{1,8}`;
  const zhRun2 = `[${ZH_NUMBER_CHARS}]{2,8}`;
  // 序數（第一、第三）不是量。所有規則都先排除它。
  const NOT_ORDINAL = '(?<!第)';
  const patterns = [
    // (a1) 數字 + 明確單位（允許單字元數字）
    new RegExp(`${NOT_ORDINAL}(${zhRun})(?=\\s*(?:${UNIT_STRICT}))`, 'g'),
    // (a2) 數字 + 有歧義單位（要求兩個字以上，避開「十分」「一次」）
    new RegExp(`${NOT_ORDINAL}(${zhRun2})(?=\\s*(?:${UNIT_LOOSE}))`, 'g'),
    // (b) 連接詞 + 數字 + 邊界
    new RegExp(`(?<=(?:${CONNECTOR_BEFORE})\\s*)${NOT_ORDINAL}(${zhRun})(?=${BOUNDARY})`, 'g'),
  ];
  if (terms) {
    // (c) 指標名 + 數字 + 邊界
    patterns.push(new RegExp(`(?<=(?:${terms})\\s*)${NOT_ORDINAL}(${zhRun})(?=${BOUNDARY})`, 'g'));
  }

  for (const re of patterns) {
    out = out.replace(re, (m) => {
      const n = parseChineseNumber(m);
      return n === null ? m : String(n);
    });
  }

  // 英文數字詞沒有這個問題（"one" 不會是別的詞的一部分），但同樣要求
  // 它真的在宣稱一個量，否則 "one of the best days" 會變成 "1 of ..."。
  const enRun = `\\b(?:${EN_WORDS})(?:[\\s-](?:and[\\s-])?(?:${EN_WORDS}))*\\b`;
  const enPatterns = [
    new RegExp(`(${enRun})(?=\\s*(?:${UNIT_STRICT}|${UNIT_LOOSE}))`, 'gi'),
    new RegExp(`(?<=\\b(?:is|was|of|at|around|about|hit|reached)\\s)(${enRun})(?=${BOUNDARY})`, 'gi'),
  ];
  for (const re of enPatterns) {
    out = out.replace(re, (m) => {
      const n = parseEnglishNumber(m);
      return n === null ? m : String(n);
    });
  }
  return out;
}
