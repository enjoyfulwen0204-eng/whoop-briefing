/**
 * 追問 / 多輪對話（Phase O）。
 *
 * 場景：
 *   使用者：「為什麼今天 recovery 很差？」
 *   系統發現 WHOOP 指標本身解釋不了 → 反問「昨天有喝酒、旅行或睡特別晚嗎？」
 *   使用者：「喝了三杯」
 *   系統：解析 → 寫 journal → 重新取得 context → 回答原問題 → 清掉 pending
 *
 * 設計重點：
 *  - 一個 chat 同時只有一個 OPEN 的追問（新的會把舊的標成 SUPERSEDED）
 *  - 30 分鐘過期。過期的追問不會硬接使用者的下一句話（那多半已經換話題了）
 *  - 沒有 WHOOP 資料時照樣能運作：至少會把 journal 記下來
 */

import { TELEGRAM_BOT } from '../config.js';
import { addDays } from '../time.js';
import { log } from '../logger.js';

/** 追問哪些 journal 類別可能解釋恢復變差。 */
export const FOLLOW_UP_CATEGORIES = ['alcohol', 'sickness', 'travel', 'late_sleep', 'stress'];

export const FOLLOW_UP_QUESTION =
  '昨天有喝酒、旅行、生病、壓力特別大，或睡得特別晚嗎？\n'
  + '（直接回我就好，例如「喝了三杯酒」或「沒有」。我會記下來，之後就能幫你把這些對照著看。）';

/** 使用者是不是在說「沒有」。 */
export function isNegativeAnswer(text) {
  return /^(沒有|沒|無|none|no|nope|不用|都沒有|沒事)\s*[。.!！]?$/i.test(String(text ?? '').trim());
}

/**
 * 這句話明顯是在「問問題」而不是在回答。
 *
 * 用在**主動代理**發出的問題上：那種問題是不請自來的，使用者當下很可能
 * 正在想別的事情。把「我今天狀態怎樣？」硬吃成追問的答案，會同時毀掉
 * 兩件事——使用者的問題沒被回答，還被反問一句「聽不懂」。
 *
 * 刻意跟 looksLikeJournal() 用同一組判斷詞（那邊是反向用它排除問句），
 * 保持兩邊語感一致。反應式追問**不套用**這條規則：那是使用者自己問完
 * 之後緊接著的對話，接下去講的話本來就該被當成回答。
 */
export function looksLikeQuestion(text) {
  const t = String(text ?? '').trim();
  if (!t) return false;
  if (/[?？]\s*$/.test(t)) return true;
  // 中文很常不打問號。「…嗎」「…呢」「…吧」結尾就是問句，
  // 漏掉這一類的後果是：使用者在問問題，卻被當成在回答追問而被吃掉。
  if (/(嗎|呢|吧|嘛)\s*[。.!！]?\s*$/.test(t)) return true;
  // 「怎麼這麼累」「怎麼那麼喘」——沒有問號也沒有嗎，但確實是在問。
  if (/怎麼(這麼|那麼|會)/.test(t)) return true;
  return /(怎樣|怎麼樣|如何|為什麼|為何|多少|哪一?天|是不是|會不會|有沒有|難道|還是說)/.test(t);
}

/**
 * 這句話裡有沒有「在報告一件發生過的事」。
 *
 * 與 looksLikeQuestion 是**正交**的：一句話可以同時是報告也是提問
 * （「我剛喝了酒，是不是因為這樣才這麼累？」）。所以這裡刻意不排除問句。
 */
export function mentionsLoggableEvent(text) {
  return /(喝酒|喝了|喝完|吃了|宵夜|熬夜|睡得?晚|沒睡|失眠|生病|不舒服|感冒|發燒|壓力|加班|出差|旅行|時差|按摩|三溫暖|運動|重訓|跑步|練)/
    .test(String(text ?? ''));
}

/**
 * 要不要對這個問題發出追問？
 *
 * 條件（全部成立才問）：
 *  - 使用者問的是「今天狀態」或「有什麼變化」
 *  - 真的有值得注意的偏離
 *  - 而且那一天**沒有**任何 journal 紀錄（有的話就不必再問了）
 */
export function shouldFollowUp({ result, journalCountForDay }) {
  if (!result || result.available === false) return false;
  if (!['today_status', 'what_changed'].includes(result.intent)) return false;
  if (journalCountForDay > 0) return false;

  const items = result.what_changed ?? result.items ?? [];
  const noteworthy = items.filter((c) => c.noteworthy || c.level === 'STRONG' || c.level === 'NOTABLE');
  return noteworthy.length > 0;
}

/** 開一個追問。 */
export async function openFollowUp({ db, userId, chatId, originalMessage, result, now = new Date() }) {
  const id = await db.openPendingQuestion(userId, {
    chatId,
    originalMessage,
    question: FOLLOW_UP_QUESTION,
    intent: result.intent,
    contextJson: {
      health_date: result.health_date,
      // ★ R2-M-02：FOLLOW_UP_QUESTION 問的是「昨天」，也就是 health_date
      // 的前一天（lag=1 的關聯分析要的正是那一天）。
      question_target_date: result.health_date ? addDays(result.health_date, -1) : null,
      items: (result.what_changed ?? result.items ?? []).slice(0, 3).map((c) => ({
        metric: c.metric, z_score: c.z_score, level: c.level,
      })),
    },
    ttlMs: TELEGRAM_BOT.PENDING_TTL_MS,
  }, { now });
  log.info('follow_up_opened', { user_id: userId, id, chat_id: String(chatId), intent: result.intent });
  return id;
}
