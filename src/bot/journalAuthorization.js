/**
 * 寫入個人健康紀錄的授權（兩道獨立的關卡）。
 *
 * ## 為什麼要獨立成一個模組
 *
 * 前一輪把語意欄位加進解析結果，並在 router 裡檢查。獨立稽核找出兩個漏洞，
 * 兩個都是「看起來有檢查、實際上沒守住」：
 *
 *   1. **缺欄位被當成 false。** schema 把四個欄位宣告成 nullable，runtime 只在
 *      `negated === true` 時拒絕。於是 `{asserted:true, about_self:true}` ——
 *      完全沒提 negated / hypothetical —— 直接通過。那是 fail open。
 *
 *   2. **模型說了算。** 即使欄位齊全，`我今天沒有喝酒，為什麼還是很累？`
 *      配上一個謊報 `asserted:true, negated:false` 的解析結果，仍然寫出一筆
 *      飲酒紀錄。原文明明寫著沒有喝。
 *
 * 所以授權現在是兩道**獨立**的關卡，而且兩道都必須自己 fail closed：
 *
 *   關卡 A（結構化契約）  四個布林欄位必須存在、是布林、且等於指定值。
 *   關卡 B（原文否決權）  原文清楚顯示否定／假設／不確定／在問／講別人時，
 *                        直接否決 —— 不論模型說什麼。
 *
 * 關卡 B 之所以有權推翻模型，是因為它讀的是**使用者真的打出來的字**，
 * 那是這個系統唯一不會被模型幻覺污染的證據。
 *
 * ## 刻意接受的代價
 *
 * 關卡 B 保守。遇到極性混亂（雙重否定、一句話裡既否定又肯定不同類別）
 * 時，它寧可否決寫入 —— 漏記一筆使用者可以再說一次的事，遠好過在健康
 * 紀錄裡放一筆從未發生的事。這個不對稱是明知故犯的。
 */

import { resolvePerspective, PERSPECTIVE } from './perspective.js';
import { looksLikeQuestion } from './conversation.js';

// ===========================================================================
// 關卡 A —— 結構化契約
// ===========================================================================

/** 唯一被授權的組合。任何一個欄位不是這個值就不寫。 */
export const AUTHORIZED_SEMANTICS = Object.freeze({
  asserted: true,
  negated: false,
  hypothetical: false,
  about_self: true,
});

export const SEMANTIC_FIELDS = Object.freeze(Object.keys(AUTHORIZED_SEMANTICS));

/**
 * 四個語意欄位是否構成授權？
 *
 * 刻意**不**做任何寬容轉換：`"true"`、`1`、`0`、`null`、缺席，全部是拒絕。
 * 這裡不信任 schema 已經驗過 —— runtime 必須能單獨守住這條線，否則
 * schema 的一次放寬就會讓整條防線消失。
 *
 * @returns {{ok:boolean, reason:?string, field:?string}}
 */
export function authorizeSemanticFields(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: 'not_an_object', field: null };
  }
  for (const field of SEMANTIC_FIELDS) {
    if (!(field in raw)) return { ok: false, reason: 'missing_field', field };
    const v = raw[field];
    if (typeof v !== 'boolean') return { ok: false, reason: 'not_a_boolean', field };
    if (v !== AUTHORIZED_SEMANTICS[field]) return { ok: false, reason: 'not_authorized_value', field };
  }
  return { ok: true, reason: null, field: null };
}

// ===========================================================================
// 關卡 B —— 原文否決權
// ===========================================================================

/**
 * 每一個類別在原文裡長什麼樣子。
 *
 * 否決必須**對準被解析出來的那個類別**：`我沒有喝酒，但我昨晚熬夜了`
 * 在 category=late_sleep 時不該被否決 —— 那句否定講的是酒，不是熬夜。
 * 這就是為什麼不能用一條全局的否定規則。
 */
const CATEGORY_CUES = {
  alcohol: /(喝酒|飲酒|酒精|喝[^。，,]{0,4}酒|喝了|喝完|啤酒|紅酒|調酒|威士忌|清酒|高粱|一杯|兩杯|幾杯)/g,
  late_sleep: /(熬夜|晚睡|睡得晚|太晚睡|很晚才睡|沒睡|失眠)/g,
  exercise_note: /(運動|重訓|跑步|訓練|練完|健身|打球|游泳)/g,
  stress: /(壓力|焦慮|緊繃|緊張)/g,
  caffeine: /(咖啡因|咖啡|喝茶|能量飲)/g,
  late_meal: /(宵夜|晚餐|吃了|吃很晚|大餐|消夜)/g,
  sickness: /(生病|感冒|發燒|不舒服|感染)/g,
  medication: /(吃藥|用藥|服藥|止痛藥|抗生素)/g,
  supplement: /(補充品|保健品|維他命|維生素|魚油|鎂)/g,
  sauna: /(三溫暖|烤箱|蒸氣)/g,
  massage: /(按摩|推拿|放鬆療程)/g,
  travel: /(出差|旅行|旅遊|時差)/g,
  flight: /(搭機|飛機|班機|紅眼)/g,
  food: /(吃|飲食|餐)/g,
  location: /(在|到了|抵達)/g,
  custom: /(.)/g,
};

/**
 * 原文最像哪一個類別？
 *
 * 只用在「還沒有解析結果、但需要先看否定」的場合（明確記錄指令）。
 * 認不出來就回 null，呼叫端據此略過對準類別的否定判斷。
 * `custom` 與 `location`/`food` 這種過寬的規則不參與猜測。
 */
const HINT_ORDER = ['alcohol', 'late_sleep', 'exercise_note', 'stress', 'caffeine',
  'late_meal', 'sickness', 'medication', 'supplement', 'sauna', 'massage', 'travel', 'flight'];

export function categoryHintOf(text) {
  const t = String(text ?? '');
  for (const key of HINT_ORDER) {
    const re = new RegExp(CATEGORY_CUES[key].source);
    if (re.test(t)) return key;
  }
  return null;
}

/** 否定詞。 */
const NEGATORS = /(沒有|沒|不是|並沒有|並沒|並不|不曾|未曾|未|從來不|從沒|根本沒|根本不|不會|別|無)/g;
/** 只在 cue 之前這麼近的範圍裡找否定詞 —— 太遠的否定通常在講另一件事。 */
const NEG_WINDOW = 8;
/**
 * 裸的「不」（「我不喝酒」）。
 *
 * 它沒有進 NEGATORS，因為「不」在中文裡到處出現（「為什麼不…」「不過」），
 * 8 個字的窗口太寬會誤殺。所以單獨處理，而且只認**緊貼線索詞**的用法。
 */
const BARE_NEG = /不/;
const BARE_NEG_WINDOW = 3;

/**
 * 對「這件事到底發生了沒有」的不確定 —— 不論在句子哪裡出現都算。
 */
const UNCERTAIN_GLOBAL = /(不確定|不太確定|不記得|忘了|好像|似乎|大概有|可能有|應該有|記得.{0,6}嗎)/;

/**
 * 在**問這件事發生了沒有**的句型。
 *
 * ⚠️ 必須跟線索詞落在**同一個子句**才算。
 *
 * 「我剛喝了兩杯，現在很累，會有關係嗎？」裡的「有…嗎」問的是**有沒有關係**，
 * 不是有沒有喝 —— 喝這件事在第一個子句裡講得很清楚。早一版用全句比對，
 * 於是這句明確的個人陳述被當成「不確定發生過」而拒絕寫入。
 */
const UNCERTAIN_NEAR_CUE = [
  /是不是/, /有沒有/, /有[^。，,]{0,8}嗎/, /過嗎/, /了嗎/,
];
/**
 * 在**討論**這件事（紀錄、話題），而不是在陳述它發生了。
 *
 * 「喝酒的話題先不要談」含有線索詞、是陳述句、也沒有否定線索詞本身 ——
 * 但它顯然不是一筆紀錄。使用者在談論這個話題，不是在報告一件事。
 */
const META_RECORD = /(已經.{0,8}說過|跟你說過|不是已經記|為什麼還要再記|重複記|再記一次|話題|不要談|不想談|先不談|別談|不提)/;
/** 明確的條件句標記。 */
const CONDITIONAL_MARKERS = /(如果|假如|要是|假設|萬一|若)/;

/**
 * 這段原文有沒有清楚地否決「使用者身上發生了這件事」？
 *
 * @param {string} text 使用者原話
 * @param {string} category 解析出來的類別（否定的判定要對準它）
 * @returns {{vetoed:boolean, reason:?string, cues:string[]}}
 */
/**
 * @param {boolean} subjectEstablished
 *   對話脈絡是否已經確立主詞是使用者本人。
 *
 *   Bot 問「昨天有喝酒嗎？」，使用者答「喝了三杯酒」—— 那句話沒有第一人稱，
 *   因為主詞在問題裡就定了。明確的記錄指令（「幫我記錄…」）同理。
 *   這種情況下「沒有主詞」不再是拒絕的理由，但**講別人**和**一般衛教問句**
 *   仍然否決，否定與假設也仍然否決。
 */
export function rawTextVeto({ text, category, subjectEstablished = false }) {
  const t = String(text ?? '');
  const cues = [];
  if (!t.trim()) return { vetoed: true, reason: 'empty_text', cues };

  // --- B1. 視角：講別人、或一般性衛教問題 ---
  //
  // 直接用同一個視角模組，不另寫一套判斷 —— 兩邊分岔就等於兩套語意。
  // 只有「明確在講使用者自己」才可能寫入（脈絡已確立主詞時，ambiguous 放行）。
  const persp = resolvePerspective({ text: t });
  //
  // ⚠️ 中文的主詞省略是常態。「喝了兩杯」「熬夜到三點」在一對一對話裡就是
  // 在講自己 —— 要求每一句都出現「我」會把正常的記錄用法全部擋掉。
  //
  // 所以「沒有主詞」只在**問句**裡才是拒絕的理由：陳述句省略主詞預設是自己，
  // 問句省略主詞則可能在問一般情況（「喝完酒很累正常嗎？」）。
  // 明確指向別人（THIRD_PARTY）或明確是一般問法（GENERAL）一律否決，不受此影響。
  const isQuestion = looksLikeQuestion(t);
  const elidedSelf = persp.perspective === PERSPECTIVE.AMBIGUOUS
    && (subjectEstablished || !isQuestion);
  const subjectOk = persp.perspective === PERSPECTIVE.SELF || elidedSelf;
  if (elidedSelf) cues.push(subjectEstablished ? 'subject_from_context' : 'subject_elided');
  if (!subjectOk) {
    // 「不是我朋友，是我喝酒了」：第三人稱本身被否定了，那句話其實在講自己。
    const negatedThirdParty = /(不是|並不是|不只是)\s*(我(的)?(朋友|同事|家人|老婆|老公|同學|室友)|他|她)/.test(t);
    if (!negatedThirdParty) {
      cues.push(`perspective:${persp.perspective}`);
      return { vetoed: true, reason: `perspective_${persp.perspective}`, cues };
    }
    cues.push('negated_third_party');
  }

  // --- B2. 條件／假設 ---
  if (CONDITIONAL_MARKERS.test(t)) {
    cues.push('conditional_marker');
    return { vetoed: true, reason: 'hypothetical', cues };
  }

  // --- B3. 在問、或不確定發生過沒有 ---
  if (UNCERTAIN_GLOBAL.test(t)) {
    cues.push('uncertain');
    return { vetoed: true, reason: 'uncertain_occurrence', cues };
  }
  if (occurrenceQuestioned(t, category)) {
    cues.push('uncertain_near_cue');
    return { vetoed: true, reason: 'uncertain_occurrence', cues };
  }
  if (META_RECORD.test(t)) {
    cues.push('meta_record');
    return { vetoed: true, reason: 'meta_discussion', cues };
  }

  // --- B4. 對準類別的否定 ---
  const polarity = categoryPolarity(t, category);
  if (polarity.conditionalOnCue) {
    cues.push('cue_conditional');
    return { vetoed: true, reason: 'hypothetical', cues };
  }
  if (polarity.negated) {
    cues.push(`negated:${polarity.matchedCue}`);
    return { vetoed: true, reason: 'negated', cues };
  }
  if (polarity.doubleNegated) cues.push('double_negation');

  return { vetoed: false, reason: null, cues };
}

/**
 * 使用者是在**問**這件事發生了沒有嗎？
 *
 * 只看線索詞所在的那個子句 —— 疑問句型出現在別的子句時，問的是別的事。
 */
function occurrenceQuestioned(text, category) {
  const cue = CATEGORY_CUES[String(category ?? '')] ?? null;
  if (!cue) return false;
  const re = new RegExp(cue.source, 'g');
  let m;
  while ((m = re.exec(text)) !== null) {
    const start = clauseStartBefore(text, m.index);
    const end = clauseEndAfter(text, m.index + m[0].length);
    const clause = text.slice(start, end);
    if (UNCERTAIN_NEAR_CUE.some((p) => p.test(clause))) return true;
  }
  return false;
}

/** 這個位置所屬子句的終點（下一個句讀，含它）。 */
function clauseEndAfter(text, index) {
  const rest = text.slice(index);
  const m = rest.match(/[，,。；;！!？?、\n]/);
  return m ? index + m.index + 1 : text.length;
}

/** 這個位置所屬子句的起點（前一個句讀之後）。 */
function clauseStartBefore(text, index) {
  const before = text.slice(0, index);
  let last = -1;
  for (const ch of ['，', ',', '。', '；', ';', '！', '!', '？', '?', '、', '\n']) {
    last = Math.max(last, before.lastIndexOf(ch));
  }
  return last + 1;
}

/**
 * 這個類別的線索詞，在原文裡是被肯定還是被否定？
 *
 * 只看 cue **之前**很近的一段（NEG_WINDOW 個字）。窗內出現兩個否定詞視為
 * 雙重否定（「我不是沒喝酒」），那等於肯定，不否決。
 */
function categoryPolarity(text, category) {
  const cue = CATEGORY_CUES[String(category ?? '')] ?? null;
  if (!cue) return { negated: false, doubleNegated: false, conditionalOnCue: false, matchedCue: null };

  const re = new RegExp(cue.source, 'g');
  let m;
  let sawPositive = false;
  let negatedCue = null;
  let doubleNegated = false;
  let conditionalOnCue = false;

  while ((m = re.exec(text)) !== null) {
    const start = m.index;
    // ★ 否定的作用範圍**不跨子句**。
    //
    //「我沒有不喝，我確實喝了」的「沒有」屬於前一個子句；如果視窗跨過逗號，
    // 後半句明確的肯定就會被前半句的否定吃掉。同理「不是我朋友，是我喝酒了」。
    const clauseStart = clauseStartBefore(text, start);
    const window = text.slice(Math.max(clauseStart, start - NEG_WINDOW), start);
    let negCount = (window.match(NEGATORS) ?? []).length;
    // 緊貼線索詞的「不」（「我不喝酒」）也算一次否定。
    const near = text.slice(Math.max(clauseStart, start - BARE_NEG_WINDOW), start);
    if (negCount === 0 && BARE_NEG.test(near)) negCount = 1;
    // cue 後面緊跟「的話」= 條件句（「有喝酒的話，HRV 會降低嗎？」）。
    // 「的話題」不算 —— 那是在講話題。
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + 4);
    if (/^的話(?!題)/.test(after)) conditionalOnCue = true;

    if (negCount >= 2) { doubleNegated = true; sawPositive = true; continue; }
    if (negCount === 1) { negatedCue = m[0]; continue; }
    sawPositive = true;
  }

  // 這個類別的線索被否定過，而且不是雙重否定 → 否決。
  //
  // 注意「混合極性」也走這條（例如 alcohol 類別遇到「我沒有喝酒，但我昨晚
  // 熬夜了」）：一句話裡同時有肯定與否定的提及時，我們沒有可靠的方法確定
  // 使用者到底在說哪一件，所以不寫。sawPositive 只用來記錄這個情況，不用來
  // 放寬否決。
  return {
    negated: negatedCue !== null && !doubleNegated,
    mixedPolarity: negatedCue !== null && sawPositive && !doubleNegated,
    doubleNegated,
    conditionalOnCue,
    matchedCue: negatedCue,
  };
}

/**
 * 兩道關卡一起跑。
 *
 * @returns {{ok:boolean, reason:?string, gate:?string, cues:string[]}}
 */
export function authorizeJournalMutation({ text, raw, category, subjectEstablished = false }) {
  const fields = authorizeSemanticFields(raw);
  if (!fields.ok) {
    return {
      ok: false, reason: fields.reason, gate: 'semantic_fields',
      field: fields.field ?? null, cues: [],
    };
  }
  const veto = rawTextVeto({ text, category, subjectEstablished });
  if (veto.vetoed) {
    return { ok: false, reason: veto.reason, gate: 'raw_text_veto', field: null, cues: veto.cues };
  }
  return { ok: true, reason: null, gate: null, field: null, cues: veto.cues };
}

/**
 * 明確的記錄指令裡帶著否定（「幫我記錄今天沒有喝酒」）。
 *
 * journal_events 只有「發生過的事」這一種資料形狀 —— 沒有「沒有發生」的
 * 表示法。把它記成一筆飲酒顯然是反的；靜靜忽略又會讓使用者以為記到了。
 * 所以誠實說出這個限制。
 */
export function negatedLogCommandReply() {
  return '我這邊只能記下發生過的事，沒有辦法記「沒有發生」這種紀錄。\n\n'
    + '所以這次我什麼都沒有記。沒有紀錄本身就代表我沒收到那件事 —— '
    + '真的發生了再跟我說一聲就好。';
}
