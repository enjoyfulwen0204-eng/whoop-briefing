/**
 * 一般健康知識的回答（衛教路徑）。
 *
 * ## 為什麼需要它
 *
 * 「喝酒會讓人累嗎？」寫入零筆是對的，但接著回一份指令清單：
 *
 *   我不太確定你想問什麼。可以試試：· 我今天狀態怎樣？…
 *
 * 那不是對話。使用者問了一個清楚、合理、而且安全的健康問題，系統卻因為
 * 它不是「查自己的數據」就當作聽不懂。
 *
 * ## 為什麼句子是樣板而不是 LLM 生成
 *
 * 這個專案已經定下的原則：**LLM 永遠不可以是「已發布的生理宣稱」的來源。**
 * 衛教句同樣是生理宣稱（「酒精會干擾睡眠結構」），只是對象是一般人而不是
 * 使用者本人。所以這裡一樣走確定性樣板 —— 內容固定、可審閱、可測試，
 * 而且不會在某一次生成時多長出一句沒人核可過的說法。
 *
 * 代價是涵蓋範圍有限：認不出主題時，誠實說「這題我沒把握」，而不是猜。
 * 那仍然遠好過丟一份指令清單。
 *
 * ## 語氣規則
 *
 * 一律「可能／常見」，絕不「一定／就是」。不診斷、不對特定的人下判斷、
 * 不引用任何人的量測值。
 *
 * ## 四種宣稱必須分清楚
 *
 *   1. **一般生理可能性** —— 這個模組唯一可以講的東西，而且一律加上限定詞。
 *   2. **個人推論** —— 不在這裡（這裡拿不到、也不該拿到個人資料）。
 *   3. **WHOOP 指標的組成方式** —— **一律不宣稱**。「恢復分數主要由睡眠與
 *      自律神經構成」這類說法是專有演算法的內部細節，這個 repo 沒有任何
 *      官方來源可以支撐它（capabilities.js 引用的官方文件只說明**有哪些
 *      欄位**，不說明分數怎麼算）。所以改成「會受到多種因素影響，單靠
 *      這一項無法判定」。
 *   4. **已證實的因果** —— 不宣稱。相關與常見觀察不等於因果。
 *
 * 上一版寫過「睡眠是恢復分數最主要的輸入之一」「身體通常會優先補深睡」
 * 「睡得太少之後覺得累是很直接的因果」，三句分別落在 (3)(1 過度)(4)。
 */

import { PERSPECTIVE } from './perspective.js';
import { t } from '../localization.js';

const TOPICS = new Set(['alcohol','late_sleep','short_sleep','exercise','stress','caffeine','sickness']);

const TOPIC_PATTERNS = [
  ['alcohol', /(喝酒|飲酒|酒精|喝了酒|喝完酒|酒後)/],
  ['short_sleep', /(睡太少|睡不夠|睡眠不足|睡很少|沒睡飽|睡不飽)/],
  ['late_sleep', /(熬夜|晚睡|睡得晚|太晚睡|很晚才睡)/],
  ['exercise', /(運動|重訓|跑步|訓練|練完|健身)/],
  ['stress', /(壓力|焦慮|緊張)/],
  ['caffeine', /(咖啡因|咖啡|喝茶)/],
  ['sickness', /(生病|感冒|發燒|感染)/],
];

const ASPECT_PATTERNS = [
  ['hrv', /hrv|心率變異/i],
  ['recovery', /(recovery|恢復(分數|度)?)/i],
  ['sleep', /(睡眠|睡得好|睡不好|失眠|睡眠品質)/],
  ['tired', /(累|疲倦|疲勞|沒精神|沒力|精神差|想睡)/],
];

/** 主題偵測。認不出來就回 null —— 不猜。 */
export function detectTopic(text) {
  const t = String(text ?? '');
  for (const [topic, re] of TOPIC_PATTERNS) if (re.test(t)) return topic;
  return null;
}

/** 問的是哪一個面向。預設 'tired'（最常見的問法）。 */
export function detectAspect(text) {
  const t = String(text ?? '');
  for (const [aspect, re] of ASPECT_PATTERNS) if (re.test(t)) return aspect;
  return 'tired';
}

/**
 * 這句話有沒有描述**需要升級處理**的嚴重症狀？
 *
 * 只用在第三人稱：使用者自己的緊急症狀由 triage 的確定性閘門處理（那一層
 * 排在路由最前面）。這裡處理的是「我朋友喝完酒一直吐」這種轉述。
 */
const SEVERE_IN_REPORT = /(叫不醒|失去意識|意識不清|昏迷|沒有反應|一直吐|狂吐|吐不停|嘔吐不止|呼吸困難|喘不過氣|胸痛|胸悶|抽搐|痙攣|發紺|嘴唇發紫)/;

/**
 * 產生衛教回答。
 *
 * @returns {?{text:string, topic:?string, aspect:string, perspective:string}}
 *   認不出主題而且也看不出是健康問題時回 null（呼叫端維持原本的行為）。
 */
export function educationAnswer({ text, perspective = PERSPECTIVE.GENERAL, locale = 'zh-TW' } = {}) {
  const topic = detectTopic(text);
  const aspect = detectAspect(text);
  const entry = topic && TOPICS.has(topic);
  const body = entry ? t(locale, `education.${topic}.${aspect}`) : null;
  if (!body) return null;

  const out = [body];

  if (perspective === PERSPECTIVE.THIRD_PARTY) {
    // 只回答使用者真的提供的資訊。不診斷那個人，也不假裝看得到他的數據。
    out.push(t(locale, 'education.thirdParty'));
    out.push(SEVERE_IN_REPORT.test(String(text ?? ''))
      ? t(locale, 'education.thirdPartySevere')
      : t(locale, 'education.thirdPartyMild'));
  } else {
    out.push(t(locale, 'education.general'));
  }

  return { text: out.join('\n\n'), topic, aspect, perspective };
}
