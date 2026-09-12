/**
 * 訊息路由：一則 Telegram 訊息 → 一則回覆。
 *
 * 處理順序（不可調換）：
 *   1. 有未過期的追問 → 這句話當成「回答」處理（Phase O）
 *   2. 是指令 → 確定性處理
 *   3. 看起來像在記錄事情 → journal（自然語言）
 *   4. 其他 → intent → 確定性查詢 → LLM 講人話
 *
 * 全程遵守：LLM 不做計算、不查 DB、不決定健康好壞。
 */

import { AI_PURPOSE, PROMPT_VERSIONS, TELEGRAM_BOT } from '../config.js';
import { PROACTIVE_QUESTION_INTENT, PROACTIVE_OUTCOME } from '../schema.js';
import { PROACTIVE_PROCESSING_LEASE, INFORMATION_GAIN_POLICY } from '../proactivePolicy.js';
import { reanalyzeAfterAnswer } from '../proactiveReanalysis.js';
import { requireUserId } from '../userContext.js';
import { structuredWithRetry } from '../llmValidation.js';
import { buildDataQualityReport, renderDataQuality } from '../dataQuality.js';
import { createHealthQuery } from '../healthQuery.js';
import { saveEvent, describeEvent, healthDateFor, CATEGORIES } from '../journal.js';
import { addDays, localDate } from '../time.js';
import { loadDailyMetrics } from '../dailyMetrics.js';
import {
  assessUrgency, urgentReply, isSymptomEducationQuestion, symptomEducationReply,
} from './triage.js';
import { labelForCategory } from '../journal.js';
import { log, describeError } from '../logger.js';
import { resolveIntent, parseCommand } from './intent.js';
import { composeAnswer } from './answer.js';
import { resolvePerspective, intentIsInherentlyPersonal, PERSPECTIVE } from './perspective.js';
import { educationAnswer, detectTopic } from './healthEducation.js';
import { validateTimePrecision } from './timePrecision.js';
import {
  authorizeSemanticFields, rawTextVeto, negatedLogCommandReply, categoryHintOf,
} from './journalAuthorization.js';
import {
  handleLog, handleHealthData, startText, buildHelp,
  handleStatus, handleJournal, handleInsights, handlePredictions,
  handleCost, handleEvidence, handleHealthspan,
} from './commands.js';
import * as experimentFlow from './experimentFlow.js';
import {
  shouldFollowUp, openFollowUp, isNegativeAnswer, looksLikeQuestion,
  mentionsLoggableEvent, isExplicitLogCommand, isSelfRecallQuestion, FOLLOW_UP_CATEGORIES,
} from './conversation.js';

const NO_DATA_REPLY = [
  '目前還沒有足夠的 WHOOP 資料可以回答這個問題。',
  '',
  '等手錶開始同步之後我就能分析了。在那之前你還是可以用 /log 記錄事件，',
  '那些紀錄會完整保存下來，之後就能拿來對照。',
].join('\n');

export const JOURNAL_SYSTEM_PROMPT = `你要把使用者用自然語言講的一件事，轉成一個 JSON 物件。
只輸出 JSON，不要任何其他文字、不要 markdown 圍欄。

格式：
{"category":"<類別>","subtype":"<子類或 null>","numeric_value":<數字或 null>,"unit":"<單位或 null>","date_explicit":<true 或 false>,"day_offset":<0 表示今天、-1 表示昨天、-2 表示前天>,"confidence":<0 到 1>}

category 只能是下列其中一個：
alcohol, caffeine, late_meal, supplement, medication, sickness, stress,
travel, flight, location, late_sleep, exercise_note, sauna, massage, food, custom

格式裡還有四個判斷句意的欄位（全部必填）：
{"asserted":<true/false>,"negated":<true/false>,"hypothetical":<true/false>,"about_self":<true/false>,"time_precision":"now|time|date|unknown"}

規則：
- 你只做語言理解，不要做任何計算，也不要推測使用者的健康狀況。
- ★ asserted：使用者是不是在**陳述這件事真的發生過**。
  只是在問這個類別的常識（「喝酒會讓人累嗎」）、在問我們知不知道
  （「你覺得我昨天有喝酒嗎」）、或自己也不確定（「我不確定那杯有沒有酒精」）
  → asserted 給 false。
- ★ negated：句子是在說**沒有**發生（「我今天沒有喝酒」「我沒有熬夜」）→ true。
- ★ hypothetical：假設語氣（「如果我喝酒…」「要是昨晚有喝…」）→ true。
- ★ about_self：主詞是使用者本人才給 true。講別人（「我朋友…」）或泛指
  （「為什麼有人運動完會累」）→ false。
- ★ time_precision：
  「剛剛／現在」→ "now"；有明確時間（「八點喝的」）→ "time"；
  只有日期（「今天」「昨晚」）→ "date"；完全沒提 → "unknown"。
- 如果句子裡沒有明確數量，numeric_value 給 null。
- 如果無法判斷是哪個類別，category 給 "custom"，confidence 給低分。
- ★ date_explicit：句子裡**有沒有真的講到是哪一天**。
  有講（今天／昨天／前天／昨晚…）→ true，並給對應的 day_offset。
  沒講 → **false**，day_offset 給 0（那只是佔位，不代表今天）。
  這兩種情況必須分清楚：系統會把「沒講」接回它問的那一天。
- day_offset 只能是 0、-1 或 -2。

範例：
「昨天喝了三杯酒」→ {"category":"alcohol","subtype":null,"numeric_value":3,"unit":"drinks","date_explicit":true,"day_offset":-1,"confidence":0.95}
「今天飛胡志明」→ {"category":"flight","subtype":"HCMC","numeric_value":null,"unit":null,"date_explicit":true,"day_offset":0,"confidence":0.9}
「昨晚兩點才睡」→ {"category":"late_sleep","subtype":null,"numeric_value":2,"unit":"hour","date_explicit":true,"day_offset":-1,"confidence":0.9}
「喝了兩杯」→ {"category":"alcohol","subtype":null,"numeric_value":2,"unit":"drinks","date_explicit":false,"day_offset":0,"confidence":0.9}`;

const CATEGORY_SET = new Set(CATEGORIES);

/** LLM 提案 → 已驗證的 journal candidate。信心太低就不採用。 */
/**
 * Journal candidate 的嚴格 schema。
 * 數值範圍刻意收緊：模型偶爾會回 -3 杯酒或 999999 mg。
 */
export const JOURNAL_SCHEMA = {
  category: { type: 'string', enum: CATEGORIES, required: true },
  /**
   * ★ 「這句話有沒有真的主張這件事發生在使用者身上」。
   *
   * 只有關鍵字是**不足以**授權寫入個人健康紀錄的。「喝酒會讓人累嗎？」
   * 「我朋友昨晚熬夜」「如果我喝酒…」「我今天沒有喝酒」全都含有事件詞，
   * 但沒有一句在陳述使用者自己發生過這件事。
   *
   * 四個欄位都必須明確成立才會寫入；缺欄位、型別不對、互相矛盾一律不寫。
   */
  //
  // ★ 四個欄位一律**必填、布林、不可為 null**。
  //
  // 上一版宣告成 nullable，於是模型只回 `{asserted:true, about_self:true}`
  // 也算通過 schema，缺席的 negated / hypothetical 被 runtime 當成 false。
  // 那是 fail open：沒有回答等於默認授權。現在缺一個就整份輸出作廢
  //（retry → fallback → 不寫入）。
  asserted: { type: 'boolean', required: true, nullable: false },
  negated: { type: 'boolean', required: true, nullable: false },
  hypothetical: { type: 'boolean', required: true, nullable: false },
  about_self: { type: 'boolean', required: true, nullable: false },
  /** 時間精確度：'now' | 'time' | 'date' | 'unknown'。決定敢不敢談先後關係。 */
  time_precision: { type: 'string', enum: ['now', 'time', 'date', 'unknown'], nullable: true },
  subtype: { type: 'string', nullable: true, maxLength: 60 },
  numeric_value: { type: 'number', min: 0, max: 100_000, nullable: true },
  unit: { type: 'string', nullable: true, maxLength: 20 },
  date_explicit: { type: 'boolean', nullable: true },
  day_offset: { type: 'integer', min: -2, max: 0, nullable: true },
  confidence: { type: 'number', min: 0, max: 1, nullable: true },
};

export async function parseNaturalJournal({
  text, now, timezone, coach, minConfidence = 0.5, subjectEstablished = false,
}) {
  if (!coach?.json) return { ok: false, reason: 'no_llm' };

  // schema 驗證 + 最多重試一次；兩次都不合法就放棄（確定性 fallback = 不寫入）
  const result = await structuredWithRetry({
    label: 'journal',
    spec: JOURNAL_SCHEMA,
    call: () => coach.json({
      system: JOURNAL_SYSTEM_PROMPT,
      user: String(text).slice(0, 400),
      maxTokens: TELEGRAM_BOT.PARSE_MAX_TOKENS,
      purpose: AI_PURPOSE.JOURNAL_PARSE,
      promptVersion: PROMPT_VERSIONS.JOURNAL_PARSE,
    }),
    fallbackFn: () => null,
  });

  if (!result.ok || !result.value) {
    return { ok: false, reason: result.usedFallback ? 'schema_invalid' : 'unparsable' };
  }
  const raw = result.value;

  const category = String(raw.category ?? '').toLowerCase();
  if (!CATEGORY_SET.has(category)) return { ok: false, reason: 'unknown_category' };

  const confidence = Number(raw.confidence);
  if (Number.isFinite(confidence) && confidence < minConfidence) {
    return { ok: false, reason: 'low_confidence', confidence };
  }

  // ★ 寫入個人健康紀錄之前，四個條件缺一不可 —— 而且一律 fail closed：
  // 欄位缺席、型別不對、或互相矛盾，都當成「沒有授權寫入」。
  //
  // 關鍵字出現不等於事情發生過。「喝酒會讓人累嗎？」裡有「喝酒」，
  // 但它是一個衛教問題，不是一筆個人紀錄。
  //
  // ★ 訊號**不論通過與否都要回報**。上一輪它們只保護寫入，於是被拒絕之後
  // 「這句話在講誰」的資訊就消失了，回答規劃只好重新猜 —— 那正是「我朋友
  // 喝酒後很累」被用使用者自己的數據回答的原因。
  const signals = {
    asserted: raw.asserted === true,
    negated: raw.negated === true,
    hypothetical: raw.hypothetical === true,
    aboutSelf: raw.about_self === true ? true : (raw.about_self === false ? false : null),
  };
  const reject = (reason, extra = {}) => ({ ok: false, reason, signals, ...extra });

  // ★ 關卡 A：結構化契約。**不依賴 schema 已經驗過** —— runtime 必須自己
  // 守得住，否則 schema 的一次放寬就會讓整條防線消失。
  const fields = authorizeSemanticFields(raw);
  if (!fields.ok) {
    log.info('journal_mutation_denied', { gate: 'semantic_fields', reason: fields.reason, field: fields.field });
    return reject(`fields_${fields.reason}`, { deniedField: fields.field ?? null });
  }

  // ★ 關卡 B：原文否決權。即使欄位齊全，模型也不能推翻使用者打出來的字。
  //「我今天沒有喝酒，為什麼還是很累？」配上謊報 asserted:true 的解析結果，
  // 以前會寫出一筆飲酒紀錄。
  const veto = rawTextVeto({ text, category, subjectEstablished });
  if (veto.vetoed) {
    log.info('journal_mutation_denied', { gate: 'raw_text_veto', reason: veto.reason, cues: veto.cues });
    return reject(`veto_${veto.reason}`, { veto });
  }

  // ★ 解析器只能**提議**時間精確度；原文支撐不起來就下修。
  // 「我昨天喝酒」不會因為模型回了 now 就變成一個精確的時刻。
  const validated = validateTimePrecision({ text, proposed: raw.time_precision });
  if (validated.downgraded) {
    log.info('time_precision_downgraded', {
      proposed: validated.proposed, supported: validated.supported,
    });
  }
  const timePrecision = validated.precision;

  // ★ R3-M-02：「沒說日期」與「明確說今天」必須是**兩個不同的狀態**。
  //
  // 舊版靠 day_offset 是不是 null 來判斷，但 prompt 自己就寫著
  // 「沒提到時間就給 0」—— 模型於是**永遠**回 0，「沒說」在資料上完全
  // 等同「說了今天」。實測：訊號日 2026-02-06 的問題（問的是 02-05），
  // 短答「喝了兩杯」仍然被記在 02-06。
  //
  // 現在由模型明確回報 `date_explicit`，而且**只有 true 才算使用者說了**。
  // 欄位缺席、不是布林、或 false，一律當成「沒說」（fail safe：沒說就
  // 繼承問題的目標日，而不是預設今天）。
  const explicit = raw.date_explicit === true;
  const rawOffset = raw.day_offset === null || raw.day_offset === undefined || raw.day_offset === ''
    ? null
    : Number(raw.day_offset);
  const statedOffset = explicit && rawOffset !== null && Number.isInteger(rawOffset)
    && rawOffset <= 0 && rawOffset >= -2
    ? rawOffset
    : null;
  const offset = statedOffset ?? 0;

  const eventAt = new Date(now.getTime() + offset * 86_400_000);

  return {
    ok: true,
    confidence,
    signals,
    /** 時間精確度的驗證過程（稽核用：模型提議了什麼、原文撐得起什麼）。 */
    timePrecisionAudit: validated,
    /** 使用者明確講出來的日期偏移；null 代表「沒說」（不是「今天」）。 */
    statedDayOffset: statedOffset,
    /** 時間精確度（決定敢不敢談與量測的先後關係）。 */
    timePrecision,
    event: {
      eventAt: eventAt.toISOString(),
      healthDate: healthDateFor(eventAt, timezone),
      category,
      subtype: raw.subtype ?? null,
      numericValue: raw.numeric_value ?? null,
      unit: raw.unit ?? null,
      textValue: String(text).slice(0, 500),
      note: String(text).slice(0, 500),
      source: 'natural_language',
    },
  };
}

/**
 * 「這一題在問哪一天的行為」（R2-M-02）。
 *
 * ## 為什麼不能用訊號的 health_date
 *
 * 問題文字是「你的 HRV **今天**比平常偏低。**昨天**有喝酒嗎？」——
 * 「今天」是訊號日 D，被問的行為在 D-1。用 D 當錨點會把答案記在錯的一天，
 * 而且錯的方向剛好讓 lag=1 的關聯分析永遠對不上。實測確認：訊號日
 * 2026-02-06 的問題，答案被記成 2026-02-06 而不是 2026-02-05。
 *
 * 所以「問哪一天」在**問題被建立時**就決定並持久化成
 * `context.question_target_date`，這裡只是讀出來 —— 絕不在這裡重新推論。
 *
 * 舊資料只接受 category 政策可推導的日期；否則所有回答分支都先問清楚。
 */
export function questionTargetDateOf(pending) {
  const explicit = pending?.context?.question_target_date;
  if (typeof explicit === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(explicit)) return explicit;

  // ★ R3-M-02：舊追問沒有這個欄位時，只在**明確可推導**的情況下推導。
  //
  // 主動問題的 context 帶著 category，而每個 category 的目標日偏移是
  // 明文政策（INFORMATION_GAIN_POLICY.TARGET_DAY_OFFSET）。那是確定性的
  // 推導，不是猜測。
  const healthDate = pending?.context?.health_date;
  const category = pending?.context?.category;
  if (typeof healthDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(healthDate)) {
    const offset = INFORMATION_GAIN_POLICY.TARGET_DAY_OFFSET?.[category];
    if (Number.isInteger(offset)) return addDays(healthDate, offset);
  }

  // 推導不出來 → **null**。呼叫端據此改成問使用者是哪一天，
  // 而不是默默用今天寫下一個很可能錯的日期（見 processProactiveAnswer）。
  return null;
}

/**
 * 把追問的答案重新錨定到「這題問的是哪一天」（M-06）。
 *
 * ## 修的是什麼
 *
 * 主動代理在 09-09 早上問「**昨天**有喝酒嗎？」，問的是 09-08 的異常。
 * 使用者回「有，喝了兩杯」。這種短答裡完全沒有時間資訊，於是
 * `parseNaturalJournal()` 落回 `day_offset = 0`，事件被記成 **09-09**。
 *
 * 後果不是小小的日期誤差，而是三件事同時壞掉：
 *   1. Journal 說了假話（那杯酒不是今天喝的）。
 *   2. `reanalyzeAfterAnswer()` 用 lag=1 把 journal 日配到隔天的指標，
 *      於是它去看 09-10 —— 根本不是我們在問的那個異常。我們主動問來的
 *      答案，結構上永遠解釋不了我們主動問的問題。
 *   3. 長期關聯學習被系統性地灌進差一天的資料。
 *
 * ## 規則
 *
 * 追問的 context 一定帶著 `health_date`（主動代理與反應式追問都是）。
 * 那就是「這題在問哪一天」。所以：
 *
 *   - 使用者**沒有**講日期（statedDayOffset === null）→ 錨定到那一天。
 *     這是絕大多數的情況，也是唯一會出錯的情況。
 *   - 使用者**有**講（「前天喝的」）→ 完全尊重使用者，一個字都不動。
 *     使用者講的偏移是相對於「今天」的，不是相對於問題的錨點。
 *
 * `eventAt` 跟著平移同樣的天數，保持與 health_date 一致 —— 它原本也只是
 * 「回話當下」這個近似值，平移之後不會比原本更不精確。
 */
export function anchorToQuestionDay(event, { anchorHealthDate, statedDayOffset, timezone }) {
  if (!anchorHealthDate || !/^\d{4}-\d{2}-\d{2}$/.test(anchorHealthDate)) return event;
  if (statedDayOffset !== null && statedDayOffset !== undefined) return event;
  if (event.healthDate === anchorHealthDate) return event;

  const deltaDays = Math.round(
    (Date.parse(`${event.healthDate}T00:00:00Z`) - Date.parse(`${anchorHealthDate}T00:00:00Z`))
    / 86_400_000,
  );
  if (!Number.isFinite(deltaDays) || deltaDays === 0) return event;

  const shifted = new Date(Date.parse(event.eventAt) - deltaDays * 86_400_000);
  return {
    ...event,
    eventAt: shifted.toISOString(),
    healthDate: healthDateFor(shifted, timezone) === anchorHealthDate
      ? anchorHealthDate
      // 時區換算若對不上（極端 DST 情況），以問題的那一天為準——
      // 那是我們唯一確定的事實。
      : anchorHealthDate,
  };
}

/** 這句話看起來像不像在「記錄一件事」而不是在問問題？ */
export function looksLikeJournal(text) {
  const t = String(text ?? '');
  if (/[?？]$/.test(t)) return false;
  if (/(怎樣|如何|為什麼|為何|嗎\s*$|多少|哪一?天)/.test(t)) return false;
  // ⚠️ 這張表以前漏了幾個很常見的動詞：「我昨晚熬夜到三點」「我剛運動完」
  //「我今天壓力很大」都是清楚的個人陳述，卻因為詞表沒收錄而完全不會被記錄。
  // 補齊之後仍然安全：問句在上面已經被排除，而寫入本身還要過
  // journalAuthorization 的兩道關卡。
  return /(喝|吃|飛|睡|熬夜|晚睡|生病|不舒服|感冒|發燒|壓力|按摩|三溫暖|旅行|出差|加班|宵夜|運動|重訓|跑步|訓練|健身|咖啡)/.test(t);
}

/**
 * Multi-user router。
 *
 * 身分在**進入 router 之前**就已經解析完（bot/index.js 從 telegram_chat_id
 * 查出內部使用者），所以這裡拿到的一定是 `{ id, timezone }`，不需要再猜。
 *
 * timezone 一律用**該使用者的**（users.timezone），不是全域 TIMEZONE。
 * coach 用 coachFor(userId) 產生，這樣 ai_usage 才會記在正確的人身上。
 */
/**
 * 「給不出東西」的具體說法。
 *
 * ⚠️ 刻意**不再**一律講「等 WHOOP 同步之後就能分析了」。
 *
 * 那句話原本套在每一種缺資料上，但它在絕大多數情況下是錯的：實測那天
 * recovery / HRV / RHR 早就同步進資料庫了，使用者下午問的時候卻被告知要等
 * 同步。沒有證據顯示同步有問題，就不可以把責任推給同步 —— 那會讓人白等，
 * 也會掩蓋真正的原因。
 */
export function unavailableReply(result) {
  // Publication boundary: never echo an internal/model-provided metric key.
  const publicLabels = {
    hrv: 'HRV', rhr: '靜息心率', recovery: '恢復', sleep_total: '睡眠',
    deep_sleep: '深睡', rem_sleep: 'REM', previous_day_strain: '昨日 Strain',
    respiratory_rate: '呼吸率', sleep_debt: '睡眠債', spo2: '血氧',
    skin_temp: '皮膚溫度', current_hr: '即時心率',
  };
  const label = publicLabels[result?.metric] ?? '這個指標';
  switch (result?.reason) {
    case 'unknown_metric':
      return '我還不認得這個指標。可以問 HRV、靜息心率、恢復、睡眠、Strain 等。';
    case 'unsupported_capability': {
      // 即時心率：明講拿不到，並且把真正答得出來的東西（今天的靜息心率）
      // 清楚標示出來 —— 但絕不讓人以為那就是他現在的心跳。
      if (result?.capability === 'current_heart_rate') {
        const lines = [
          '我看不到你「現在」的心跳 —— WHOOP 的開發者 API 沒有即時心率，',
          '我這邊只有睡眠期間量到的靜息心率、以及已完成週期的平均／最高心率。',
        ];
        if (result.rhr_today_display) {
          lines.push('', `今天的靜息心率是 ${result.rhr_today_display}（這是睡眠時的值，不是你當下的心跳）。`);
        }
        lines.push('', '如果你手邊的錶或 App 正顯示一個數字，跟我說多少，我可以幫你對照看看。');
        return lines.join('\n');
      }
      return `${label}不在這個系統拿得到的資料範圍內，所以我沒辦法回答這一題。`;
    }
    case 'no_metric_records':
      return `我這邊還沒有${label}的任何一筆紀錄。`;
    case 'insufficient_history':
      return `${label}目前的樣本還太少，還不夠下結論。再累積幾天就可以了。`;
    case 'calibrating':
      return `${label}今天的數值有，但還在 WHOOP 的校正期，暫時不做趨勢判斷。`;
    default:
      return NO_DATA_REPLY;
  }
}

export function createRouter({
  db, coachFor, now = () => new Date(), lookbackDays = 120,
}) {
  /**
   * 處理一則訊息，回傳要送出去的文字。
   * **永遠不拋錯** —— 出錯就回一句人話，讓 bot 繼續活著。
   */
  async function handle({ text, chatId, user }) {
    const t = new Date(now());
    const userId = requireUserId(user?.id, 'router.handle');
    const timezone = user.timezone;
    const provider = coachFor(userId);
    const coach = provider && db.outsideProcessingTransaction ? new Proxy(provider, {
      get(target, key) {
        const value = target[key];
        if (typeof value !== 'function') return value;
        return (...args) => db.outsideProcessingTransaction(
          JSON.stringify([userId, key, args]), () => value.apply(target, args),
        );
      },
    }) : provider;
    try {
      return await route({
        text: String(text ?? '').trim(), chatId, t, userId, timezone, coach,
      });
    } catch (err) {
      if (db.processingTransactionActive?.()) throw err;
      log.error('router_failed', { error: describeError(err) });
      return '抱歉，我這邊出了點問題，稍後再試一次。';
    }
  }

  /**
   * 取得「我正在處理這個主動事件」的所有權（R3-M-03）。
   *
   * 一定要在**翻轉追問狀態之前**呼叫。回 `{ ok: false, reply }` 代表
   * 不可以產生任何副作用。
   *
   * 三種結果：
   *   沒有事件可鎖  → ok（反應式追問沒有 proactive_events 可言）
   *   拿到租約      → ok，帶著 name / owner 供後續 fence
   *   拿不到 / 出錯 → **fail closed**
   *
   * ⚠️ R2 的版本在 acquireLock 拋錯時「放行」，理由是不要讓維護機制卡住
   * 使用者。那個取捨是錯的：實測顯示租約機制壞掉時處理照跑、Journal 照寫，
   * 而此時完全沒有任何東西擋得住收割器同時settle 這個事件。
   * 沒有所有權就不可以變更狀態 —— 這是這一輪的核心不變量。
   */
  async function acquireProcessingOwnership({ pending, userId, t }) {
    const eventId = pending?.context?.proactive_event_id ?? null;
    if (!eventId) {
      return { ok: true, name: null, owner: null };
    }
    const name = PROACTIVE_PROCESSING_LEASE.name(userId, eventId);
    let owner = null;
    try {
      owner = await db.acquireLock(name, {
        ttlMs: PROACTIVE_PROCESSING_LEASE.TTL_MS, now: t,
      });
    } catch (err) {
      log.error('proactive_ownership_unavailable', {
        user_id: userId, event_id: eventId, error: describeError(err),
      });
      return {
        ok: false,
        reply: '我這邊暫時處理不了，稍後再說一次好嗎？（你的訊息沒有被記錄）',
      };
    }
    if (!owner) {
      log.warn('proactive_answer_lease_busy', { user_id: userId, event_id: eventId });
      return { ok: false, reply: '我還在處理你上一句回覆，稍等一下再說一次好嗎？' };
    }
    return { ok: true, name, owner, eventId };
  }

  async function releaseProcessingOwnership(ownership) {
    if (db.processingTransactionActive?.()) {
      db.afterProcessingCommit(() => releaseProcessingOwnership(ownership));
      return;
    }
    if (!ownership?.owner || typeof db.releaseLock !== 'function') return;
    try {
      await db.releaseLock(ownership.name, ownership.owner);
    } catch { /* 放不掉沒關係，TTL 到了自然過期 */ }
  }

  /**
   * 在產生副作用之前重新確認所有權還在（R3-M-03 的 fence）。
   *
   * 租約會過期。過期之後收割器可能已經把事件推向終局，這時候再寫 Journal
   * 就是一個「沒有人擁有」的變更。所以每一個副作用之前都要再問一次。
   */
  async function stillOwns(ownership) {
    if (!ownership?.eventId) return true;
    if (!ownership.owner || typeof db.holdsLock !== 'function') return false;
    try {
      return await db.holdsLock(ownership.name, ownership.owner, { now: new Date(now()) });
    } catch (err) {
      // 確認不了就當作沒有 —— fail closed
      log.warn('proactive_ownership_check_failed', { error: describeError(err) });
      return false;
    }
  }

  async function route({ text, chatId, t, userId, timezone, coach }) {
    // ---- 0. 緊急症狀（確定性，排在所有東西之前）----
    //
    // 這一關在追問消化、journal 寫入、Q&A、LLM fallback **全部之前**。
    // 「我喝酒後胸痛又喘不過氣」同時符合好幾條規則，原本會先寫 journal、
    // 再列數據、再談基準 —— 而使用者正在描述可能需要立刻就醫的狀況。
    //
    // 刻意不呼叫 LLM：分類器不可用或判錯都不該影響安全。攔下來之後
    // **不寫入任何東西**。
    if (assessUrgency(text).urgent) {
      log.warn('urgent_symptom_intercepted', { user_id: userId });
      return urgentReply();
    }

    // ---- 0b. 在問症狀是什麼（不是在描述自己現在的狀況）----
    // 不觸發急診指引，也不掉到指令清單。
    if (isSymptomEducationQuestion(text)) {
      log.info('symptom_education_question', { user_id: userId });
      return symptomEducationReply();
    }

    // ---- 1. 有沒有等著被回答的追問 ----
    const pending = typeof db.getOpenPendingQuestion === 'function'
      ? await db.getOpenPendingQuestion(userId, { now: t })
      : null;
    // 主動代理的問題是「不請自來」的，使用者當下可能正在想別的事。
    // 明顯是在問問題的訊息不可以被當成答案吃掉——否則使用者的問題不會被
    // 回答，還會收到一句「聽不懂」。主動問題保持開著，等真正的回答。
    // （反應式追問不套用這條：那是使用者自己問完之後的對話延續。）
    // 明顯是在問問題的訊息**不可以**被當成追問的答案吃掉。
    //
    // 這條以前只套用在主動追問上，反應式追問（bot 問完「昨天有喝酒嗎」之後）
    // 不套用。結果就是這次的事故：使用者問「我怎麼感覺那麼累 是因為剛剛也
    // 喝酒嗎」，被當成那句追問的答案，只寫了 journal 就回
    // 「✅ 已記錄：alcohol」，問題本身被丟掉。
    //
    // 兩種追問都套用：使用者在問問題的時候，回答他的問題永遠比收集脈絡重要。
    // （單純的答覆如「喝了三杯」「沒有」不是問句，照舊被收下。）
    const swallowsUnrelatedQuestion = pending && looksLikeQuestion(text);

    if (pending && !parseCommand(text) && !swallowsUnrelatedQuestion) {
      // 多步驟實驗建立流程有自己的狀態機
      if (pending.context?.flow === experimentFlow.FLOW) {
        const reply = await experimentFlow.handleStep({
          db, userId, pending, text, now: t, timezone,
        });
        if (reply !== null) return reply;
      }
      // ★ M-02：原子認領，而且**在任何副作用之前**。
      //
      // `getOpenPendingQuestion()` 讀到的是一個瞬間的快照。接下來的解析要
      // 打一次 LLM（秒級），這段時間裡 cron 的收割器可能已經把這題收成
      // EXPIRED 並把對應的 proactive_event 寫成 NO_RESPONSE。
      //
      // 舊版把 `resolvePendingQuestion()` 埋在流程中段而且**丟掉回傳值**，
      // 於是：journal 先被寫進去，然後 `resolveProactiveEvent()`（無條件
      // UPDATE）把 NO_RESPONSE 覆寫成 STILL_UNEXPLAINED。實測確認：
      // `resolvePendingQuestion -> false`，程式照樣走完並覆寫了結果。
      //
      // 現在認領是進入處理流程的**前置條件**：贏了才有資格產生副作用。
      // 輸了代表這題已經不屬於我們（被收割 / 被別的 handler 處理），
      // 就當作沒有這個追問，讓訊息走一般路徑 —— 使用者的話不會被吞掉，
      // 而且絕不會回頭覆寫任何已經定案的結果。
      //
      // ★ R3-M-03：**先取得處理所有權，再翻轉追問狀態。**
      //
      // R2 的順序是「認領 → 取租約」，中間有一個窗口：追問已經是 ANSWERED
      // （所以收割器的孤兒判準完全命中），但還沒有租約可以擋住它。實測：
      // 收割器在那個窗口寫了 ABANDONED，處理者恢復後照樣寫了 Journal。
      //
      // 把租約移到認領**之前**，那個窗口就不存在了：追問一旦變成 ANSWERED，
      // 租約必定已經在我們手上，收割器的 requireNoLease 會跳過它。
      const ownership = await acquireProcessingOwnership({ pending, userId, t });
      if (!ownership.ok) {
        return ownership.reply;
      }
      try {
        const processAnswer = async () => {
          const claimed = await db.resolvePendingQuestion(userId, pending.id, text, { now: new Date(now()) });
          if (!claimed) return null;
          return handlePendingAnswer({ pending, text, chatId, t, userId, timezone, coach, ownership });
        };
        const reply = ownership.eventId
          ? await db.withAnswerOwnership(userId, ownership, now, processAnswer)
          : await processAnswer();
        if (reply !== null) return reply;
      } finally {
        await releaseProcessingOwnership(ownership);
      }
    }

    // ---- 2. 指令 ----
    const cmd = parseCommand(text);
    if (cmd) return handleCommand({ cmd, text, chatId, t, userId, timezone, coach });

    // ---- 3. 複合訊息：既報告了一件事，又在問問題 ----
    //
    // 「我剛喝了酒，是不是因為這樣才這麼累？」同時是兩個言語行為：
    //   (a) 記錄一件事  (b) 問這件事跟身體狀況的關係
    //
    // 以前只做了 (a) 就回「✅ 已記錄」，問題被丟掉。兩件事都要做：
    // 先安全地寫下事件（寫入本身仍然走既有的冪等路徑），再回答問題，
    // 最後把「已記錄」併進答案裡 —— 確認不可以取代回答。
    //
    // ⚠️ 明確的記錄指令（「記一下…」「幫我登記…」）不走這條路：那是單一
    // 言語行為（只有 (a)），使用者要的是確認，不是分析。否則「記一下我昨晚
    // 熬夜好嗎」會被當成複合問題，回一整段身體狀況說明。
    //
    // ★ 兩種問句雖然含有事件詞，但都**不是**在陳述使用者身上發生的事：
    //   「我是不是喝酒了？」 —— 在問我們有沒有那筆紀錄
    //   「壓力可能讓 HRV 改變嗎？」 —— 一般衛教問題
    // 它們不可以走到這條路：這裡會寫入 Journal，也會把正在等待的追問收掉。
    const compoundPerspective = resolvePerspective({ text });
    if (!isExplicitLogCommand(text)
      && !isSelfRecallQuestion(text)
      && compoundPerspective.usePersonalData
      && looksLikeQuestion(text) && mentionsLoggableEvent(text)) {
      // ★ 使用者明顯換了話題（開始問一個帶事件的新問題），原本開著的追問
      // 就不該再留著 —— 否則它會在稍後吃掉一句無關的短回覆，而且那句話
      // 會被記在**追問問的那一天**（例如昨天），不是使用者現在講的事。
      if (pending && typeof db.expirePendingQuestion === 'function') {
        try {
          await db.expirePendingQuestion(userId, pending.id, { now: t });
          log.info('follow_up_superseded_by_new_topic', { user_id: userId, pending_id: pending.id });
        } catch (err) {
          log.warn('follow_up_supersede_failed', { error: describeError(err) });
        }
      }
      let savedLine = null;
      let justLogged = null;
      let signals = null;
      try {
        const nat = await parseNaturalJournal({ text, now: t, timezone, coach });
        // ★ 訊號不論解析是否通過都要留下來：它是「這句話在講誰」的結構化證據。
        signals = nat.signals ?? null;
        if (nat.ok) {
          const saved = await saveEvent(db, userId, nat.event, { now: t, timezone });
          if (saved.ok) {
            savedLine = `我先幫你記下${labelForCategory(saved.event.category)}。`;
            justLogged = { category: saved.event.category, timePrecision: nat.timePrecision };
          }
        }
      } catch (err) {
        // 記錄失敗不可以吃掉問題的答案
        log.warn('compound_journal_failed', { error: describeError(err) });
      }
      const answer = await handleQuestion({
        text, chatId, t, userId, timezone, coach, justLogged, signals,
      });
      return savedLine ? `${savedLine}\n\n${answer}` : answer;
    }

    // ---- 4. 看起來像在記錄事情（純記錄，沒有提問）----
    // 明確指令一律嘗試記錄，即使 looksLikeJournal() 的詞表沒收錄那個動詞
    // （例如「熬夜」）—— 使用者已經直接說了要記什麼。
    if (isExplicitLogCommand(text) || looksLikeJournal(text)) {
      // 「幫我記錄今天沒有喝酒」：journal_events 沒有「沒有發生」這種形狀，
      // 記成一筆飲酒是反的，靜靜忽略又會讓人以為記到了。誠實說明限制。
      if (isExplicitLogCommand(text)) {
        const preVeto = rawTextVeto({ text, category: categoryHintOf(text), subjectEstablished: true });
        if (preVeto.vetoed && preVeto.reason === 'negated') {
          log.info('journal_mutation_denied', { gate: 'explicit_command_negated', cues: preVeto.cues });
          return negatedLogCommandReply();
        }
      }
      const nat = await parseNaturalJournal({
        text, now: t, timezone, coach,
        // 使用者直接下令要記自己的事，主詞由指令本身確立。
        subjectEstablished: isExplicitLogCommand(text),
      });
      if (nat.ok) {
        const saved = await saveEvent(db, userId, nat.event, { now: t, timezone });
        if (saved.ok) return `✅ 已記錄：${describeEvent(saved.event)}`;
      }
      // 解析不出來就往下走，當成一般問題
    }

    // ---- 5. 一般問答 ----
    return handleQuestion({ text, chatId, t, userId, timezone, coach });
  }

  /** 只有需要 daily_metrics 的指令才去載入（沒資料時是空陣列，不是錯誤）。 */
  async function loadRows(t, userId, timezone) {
    try {
      if (typeof db.getSleeps !== 'function') return [];
      const to = localDate(t, timezone);
      return await loadDailyMetrics({
        db, userId, timezone, from: addDays(to, -lookbackDays), to,
      });
    } catch (err) {
      log.warn('router_rows_failed', { error: describeError(err) });
      return [];
    }
  }

  async function handleCommand({ cmd, text, chatId, t, userId, timezone, coach }) {
    switch (cmd.command) {
      case 'start': {
        const report = await buildDataQualityReport({ db, userId, timezone, now: t });
        return startText(report);
      }

      case 'help': {
        // 動態說明：沒有資料時不會把分析功能講得像已經可用
        const report = await buildDataQualityReport({ db, userId, timezone, now: t });
        let insightCount = 0;
        try {
          insightCount = (await db.getActiveInsights(userId, {})).length;
        } catch { /* 忽略 */ }
        const rows = await loadRows(t, userId, timezone);
        let predictionReady = false;
        try {
          const { assessPrediction, READINESS_STATUS } = await import('../readiness.js');
          predictionReady = assessPrediction({ rows }).status === READINESS_STATUS.READY;
        } catch { /* 忽略 */ }
        return buildHelp({ report, insightCount, predictionReady });
      }

      case 'healthdata':
      case 'health':
        return handleHealthData({ db, userId, timezone, now: t });

      case 'status':
        return handleStatus({ db, userId, timezone, now: t, rows: await loadRows(t, userId, timezone) });

      case 'journal':
        return handleJournal({ db, userId, argsText: cmd.argsText, timezone, now: t });

      case 'insights':
        return handleInsights({ db, userId, argsText: cmd.argsText });

      case 'predictions':
      case 'prediction':
        return handlePredictions({ db, userId, rows: await loadRows(t, userId, timezone) });

      case 'healthspan':
        return handleHealthspan({ db, userId, rows: await loadRows(t, userId, timezone) });

      case 'cost':
        return handleCost({ db, userId, timezone, now: t });

      case 'evidence':
        return handleEvidence({ db, userId, now: t });

      case 'experiment':
      case 'experiments':
        return handleExperiment({ cmd, chatId, t, userId, timezone });

      case 'log':
        return handleLog({
          db, userId, argsText: cmd.argsText, rawText: text, timezone, now: t, coach,
          parseNatural: parseNaturalJournal,
        });

      default:
        return `不認得指令 /${cmd.command}。輸入 /help 看可用指令。`;
    }
  }

  /** /experiment create|list|status|stop */
  async function handleExperiment({ cmd, chatId, t, userId, timezone }) {
    const [sub, arg] = cmd.args;
    const action = String(sub ?? '').toLowerCase();

    switch (action) {
      case 'create':
      case 'new':
        return experimentFlow.beginCreate({ db, userId, chatId, now: t });
      case 'list':
        return experimentFlow.renderList(db, userId);
      case 'status':
        return experimentFlow.renderStatus({
          db, userId, rows: await loadRows(t, userId, timezone), id: arg, timezone, now: t,
        });
      case 'stop':
      case 'complete':
        return experimentFlow.stopExperiment({ db, userId, id: arg, timezone, now: t });
      default:
        return [
          '🧪 實驗指令：',
          '',
          '/experiment create — 建立一個新實驗（我會一步步問你）',
          '/experiment list — 列出所有實驗',
          '/experiment status [id] — 看前後對照結果',
          '/experiment stop [id] — 結束進行中的實驗',
        ].join('\n');
    }
  }

  /**
   * 回答規劃：這一題可不可以動用個人 WHOOP 資料？
   *
   * ★ 這是唯一的授權點。個人資料的使用必須**正面確立**，不是「沒被否定」。
   *
   * 兩種情況可以用：
   *   (a) intent 本質上就是在問使用者自己的量測／歷史（今天狀態、趨勢、
   *       同步、成熟度…）—— 這些 intent 沒有別的對象可以問。
   *   (b) 解釋原因這一族，而且視角解析確立了在問使用者自己。
   *
   * 其餘一律走衛教路徑，而且**不會構造個人化的結果物件** —— 不是算出來
   * 之後再過濾，是根本不去算。
   */
  function planAnswer({ text, intent, signals }) {
    const resolved = resolvePerspective({ text, signals });

    // ★ 視角的否決權優先於 intent。
    //
    // intent 只看句子在問什麼**主題**，不看在問**誰**：「有人喝酒後 HRV 會
    // 降低嗎？」被判成 trend_query，「壓力可能讓 HRV 改變嗎？」也是。如果
    // 只憑 intent 就放行，這兩句都會用使用者自己的 HRV 歷史去回答一個
    // 一般性問題。明確指向別人或明確是一般問法時，個人資料一律不開放。
    if (resolved.perspective === PERSPECTIVE.THIRD_PARTY
      || resolved.perspective === PERSPECTIVE.GENERAL) {
      return resolved;
    }

    // 主詞是使用者、或沒有主詞但 intent 本來就只問得到使用者自己的帳號
    //（「因為數據不夠嗎」「WHOOP 有同步成功嗎」「最近 HRV 如何」）。
    if (intentIsInherentlyPersonal(intent)) {
      return {
        ...resolved, perspective: PERSPECTIVE.SELF, usePersonalData: true, source: 'intent_scope',
      };
    }
    return resolved;
  }

  async function handleQuestion({
    text, chatId, t, userId, timezone, coach, justLogged = null, signals = null,
  }) {
    // 「證據呢？」「你憑什麼？」「樣本多少？」→ 直接回 evidence 摘要。
    // ★ 必須在 intent 判定之前 —— 這類問句不會被任何 intent 認出來，
    // 放在後面會先被 unknown 分支攔截而永遠走不到。
    if (/(證據|憑什麼|可信嗎|樣本(數|多少)|怎麼知道|evidence)/i.test(text)) {
      return handleEvidence({ db, userId, now: t });
    }

    // 「我是不是喝酒了？」—— 問的是我們這邊有沒有紀錄。這題有確定性的答案，
    // 不需要 intent 分類，也絕不該掉到指令清單或衛教說明。
    if (isSelfRecallQuestion(text)) {
      return journalRecall({ text, t, userId, timezone });
    }

    const intent = await resolveIntent(text, { coach });
    log.info('intent_resolved', { intent: intent.intent, source: intent.source, metric: intent.metric });

    // ---- 視角：這一題在問誰，可不可以用個人資料 ----
    const plan = planAnswer({ text, intent: intent.intent, signals });
    log.info('answer_plan', {
      intent: intent.intent, perspective: plan.perspective,
      use_personal_data: plan.usePersonalData, source: plan.source,
    });

    // ★ 不是在問使用者自己 → 走衛教，個人資料完全不碰。
    // 放在 intent 分派之前，所以 cause_query 的個人化算式根本不會被執行。
    if (!plan.usePersonalData) {
      const edu = educationAnswer({ text, perspective: plan.perspective });
      if (edu) {
        log.info('health_education_answered', {
          topic: edu.topic, aspect: edu.aspect, perspective: edu.perspective,
        });
        return edu.text;
      }
      // 認不出主題：誠實說沒把握，不要拿使用者的數據去回答別人的問題，
      // 也不要丟指令清單。
      if (plan.perspective === PERSPECTIVE.THIRD_PARTY) {
        return '這題我沒辦法幫你判斷 —— 我看不到他的資料，也不該用你的數據去回答關於他的問題。\n\n'
          + '如果他的狀況讓你不放心，尤其是有呼吸困難、胸痛、意識不清或叫不醒的情況，'
          + '請直接尋求醫療協助。';
      }
      if (detectTopic(text) || plan.perspective === PERSPECTIVE.GENERAL) {
        return '這個問題我沒有足夠把握給你一般性的說明，我不想憑印象回答健康問題。\n\n'
          + '如果你想問的是自己的數據，可以直接問「我今天狀態怎樣」或「最近 HRV 如何」。';
      }
    }

    if (intent.intent === 'unknown') {
      return [
        '我不太確定你想問什麼。可以試試：',
        '· 我今天狀態怎樣？',
        '· 最近 HRV 如何？',
        '· 最近睡眠有沒有變差？',
        '· 最近 30 天最好是哪一天？',
        '',
        '或輸入 /help 看完整說明。',
      ].join('\n');
    }

    if (intent.intent === 'data_status') {
      // ⚠️ 內部診斷區塊（涵蓋率、各資源筆數、capability probe、backfill）
      // **只走明確指令**。自然語言問句一律給對話式的成熟度說明。
      //
      // 事故當時「因為數據不夠嗎」撞到這條，於是使用者收到一整塊給維運看的
      // 診斷輸出。那不是對話，是把人當成在操作資料庫主控台。
      return composeAnswer({
        question: text,
        result: await createHealthQuery({ db, userId, timezone, now: t, lookbackDays })
          .readinessExplanation(),
        coach,
      });
    }

    const q = createHealthQuery({ db, userId, timezone, now: t, lookbackDays });
    const result = await runIntent(q, justLogged ? { ...intent, justLogged } : intent);

    if (!result || result.available === false) {
      return unavailableReply(result);
    }

    const answer = await composeAnswer({ question: text, result, coach });

    // ---- 需要的話發出追問（Phase O）----
    try {
      if (typeof db.openPendingQuestion === 'function' && result.health_date) {
        const events = await db.getJournalEvents(userId, {
          from: result.health_date, to: result.health_date,
        });
        if (shouldFollowUp({ result, journalCountForDay: events.length })) {
          await openFollowUp({ db, userId, chatId, originalMessage: text, result, now: t });
          const { FOLLOW_UP_QUESTION } = await import('./conversation.js');
          return `${answer}\n\n———\n${FOLLOW_UP_QUESTION}`;
        }
      }
    } catch (err) {
      // 追問失敗不影響已經算好的答案
      log.warn('follow_up_failed', { error: describeError(err) });
    }

    return answer;
  }

  /**
   * 讀出今天的 Journal 紀錄來回答「我是不是…了」。
   *
   * 只講我們確實有的東西：沒有紀錄就說沒有紀錄，**不是**說「你沒有喝酒」——
   * 系統看不到使用者沒告訴它的事。
   */
  async function journalRecall({ text, t, userId, timezone }) {
    const today = localDate(t, timezone);
    let events = [];
    try {
      if (typeof db.getJournalEvents === 'function') {
        events = await db.getJournalEvents(userId, { from: today, to: today, limit: 50 });
      }
    } catch (err) {
      log.warn('journal_recall_failed', { error: describeError(err) });
    }
    // 問的是哪一類（認不出來就全部列出）
    const topic = detectTopic(text);
    const matched = topic ? events.filter((e) => e.category === topic) : events;
    if (matched.length) {
      const names = [...new Set(matched.map((e) => labelForCategory(e.category)))].join('、');
      return `你今天有告訴我：${names}。`;
    }
    if (events.length) {
      const names = [...new Set(events.map((e) => labelForCategory(e.category)))].join('、');
      return `我這邊今天沒有那筆紀錄，只有${names}。\n\n`
        + '我只看得到你告訴我的事，所以沒有紀錄不代表沒發生。';
    }
    return '我這邊今天還沒有你的任何紀錄。\n\n'
      + '我只看得到你告訴我的事，所以沒有紀錄不代表沒發生 —— 想記的話跟我說一聲就好。';
  }

  async function runIntent(q, intent) {
    switch (intent.intent) {
      case 'today_status': return q.todayStatus();
      case 'trend_query':
        return q.trendQuery({
          metric: intent.metric ?? 'hrv',
          windowDays: intent.window_days ?? 30,
        });
      case 'sleep_quality': return q.sleepQuality({ windowDays: intent.window_days ?? 30 });
      case 'best_worst_day':
        return q.bestWorstDay({
          metric: intent.metric ?? 'recovery',
          windowDays: intent.window_days ?? 30,
        });
      case 'what_changed': return q.whatChanged();
      case 'cause_query':
        return q.causeExplanation({ metric: intent.metric ?? null, justLogged: intent.justLogged ?? null });
      case 'readiness_query': return q.readinessExplanation();
      case 'sync_status': return q.syncStatus();
      case 'current_hr': return q.currentHeartRate();
      default: return null;
    }
  }

  /**
   * 使用者回答追問。
   * 流程：解析 → 寫 journal → 重跑分析 → 回答原問題。
   *
   * ⚠️ 進到這裡代表 `route()` 已經**原子認領**了這個追問（狀態已是
   * ANSWERED）。所以下面不再呼叫 resolvePendingQuestion —— 認領是前置
   * 條件，不是流程中段的一步（見 route() 的 M-02 說明）。
   */
  async function handlePendingAnswer({
    pending, text, chatId, t, userId, timezone, coach, ownership = null,
  }) {
    if (pending.intent === PROACTIVE_QUESTION_INTENT) {
      return handleProactiveAnswer({
        pending, text, chatId, t, userId, timezone, coach, ownership,
      });
    }

    // 明確說「沒有」→ 不寫 journal（pending 已在 route() 認領時收掉）
    if (isNegativeAnswer(text)) {
      return '好，那我先記著這幾天的數字，繼續幫你留意。';
    }

    const nat = await parseNaturalJournal({
      text, now: t, timezone, coach,
      // Bot 剛剛問了這個人一個問題，主詞在問題裡就定了：「喝了三杯酒」
      // 沒有第一人稱，但它確實是在講自己。
      subjectEstablished: true,
    });
    let savedLine = null;
    if (nat.ok) {
      // M-06：這題問的是哪一天，答案就記在哪一天（使用者自己講日期時除外）
      const targetDate = questionTargetDateOf(pending);
      if (nat.statedDayOffset === null && targetDate === null) {
        return '我想確認一下：這是哪一天的事？（今天、昨天，還是前天？）';
      }
      const event = anchorToQuestionDay(nat.event, {
        anchorHealthDate: targetDate,
        statedDayOffset: nat.statedDayOffset,
        timezone,
      });
      if (!await stillOwns(ownership)) {
        log.warn('pending_answer_ownership_lost', { user_id: userId, pending_question_id: pending.id });
        return '我這邊處理到一半被中斷了，這則先沒有記錄；需要的話再跟我說一次。';
      }
      const saved = await saveEvent(db, userId, event, { now: t, timezone });
      if (saved.ok) savedLine = `✅ 已記錄：${describeEvent(saved.event)}`;
    }

    // 沒有 WHOOP 資料時也要能運作：至少確認 journal 寫進去了
    const q = createHealthQuery({ db, userId, timezone, now: t, lookbackDays });
    const summary = await q.summary();
    if (!summary.history_days) {
      return savedLine
        ? `${savedLine}\n\n目前還沒有 WHOOP 資料，等同步之後我就能把這些對照著看。`
        : '我先記下來了。目前還沒有 WHOOP 資料，等同步之後就能分析。';
    }

    // 重新取得 context 並回答原本的問題
    const result = await q.todayStatus();
    const answer = await composeAnswer({
      question: pending.originalMessage ?? '我今天狀態怎樣？',
      result,
      coach,
    });
    return savedLine ? `${savedLine}\n\n${answer}` : answer;
  }

  /**
   * 主動代理發起的問題被回答了（PA10-PA14）。
   * 流程：解析 → 寫 journal（source=proactive_agent）→ 重新分析 → 決定
   * 要不要 follow-up。允許「還是解釋不了」當作合法結果。
   */
  async function handleProactiveAnswer({
    pending, text, chatId, t, userId, timezone, coach, ownership = null,
  }) {
    // ★ R3-M-03：所有權在 route() 裡、**翻轉追問狀態之前**就已經取得。
    // 這裡不再自己拿租約 —— 那個順序正是 R2 留下的競態窗口。
    return processProactiveAnswer({
      pending, text, chatId, t, userId, timezone, coach, ownership,
      metric: pending.context?.signal?.metric ?? null,
      healthDate: pending.context?.health_date ?? null,
      proactiveEventId: pending.context?.proactive_event_id ?? null,
    });
  }

  /** handleProactiveAnswer 的實作（所有權在 route() 取得與釋放）。 */
  async function processProactiveAnswer({
    pending, text, chatId, t, userId, timezone, coach, ownership,
    metric, healthDate, proactiveEventId,
  }) {

    // journalEventId 讓「哪個主動問題 → 哪筆 Journal → 哪次重新分析」可追溯。
    // pending 已在 route() 認領（M-02），這裡只負責事件的終局。
    //
    // ★ R2-M-03：改用**條件式**寫入（outcome IS NULL）。
    //
    // 舊版是無條件 UPDATE，所以一個「解析暫停很久、租約已經過期、事件已經
    // 被收割器收成 ABANDONED」的流程恢復之後，會把那個終局覆寫掉。實測
    // 確認：ABANDONED 被覆寫成 STILL_UNEXPLAINED——兩個結論都不可信。
    //
    // 現在已經定案的終局永遠贏；輸掉的流程只留下一行 log。
    const closeOut = async (outcome, { journalEventId = null } = {}) => {
      if (!proactiveEventId || typeof db.resolveProactiveEventIfUnresolved !== 'function') return;
      const wrote = await db.resolveProactiveEventIfUnresolved(
        userId, proactiveEventId, outcome, { now: t, journalEventId },
      );
      if (!wrote) {
        log.warn('proactive_outcome_already_settled', {
          user_id: userId, event_id: proactiveEventId, attempted: outcome,
        });
      }
    };

    if (isNegativeAnswer(text)) {
      await closeOut(PROACTIVE_OUTCOME.NO_EXPLANATION_OFFERED);
      return '好，我先記著這件事，會繼續留意後續的數字。';
    }

    const nat = await parseNaturalJournal({
      text, now: t, timezone, coach,
      // Bot 剛剛問了這個人一個問題，主詞在問題裡就定了：「喝了三杯酒」
      // 沒有第一人稱，但它確實是在講自己。
      subjectEstablished: true,
    });
    if (!nat.ok) {
      // 只允許一次澄清追問——不能無止盡盤問使用者。
      if (!pending.context?.clarified) {
        const clarifyQuestion = '不好意思我沒有聽懂——可以更明確地說「有」還是「沒有」嗎？'
          + '（例如「喝了兩杯」或「沒有」）';
        await db.openPendingQuestion(userId, {
          chatId,
          originalMessage: pending.originalMessage,
          question: clarifyQuestion,
          intent: PROACTIVE_QUESTION_INTENT,
          contextJson: { ...pending.context, clarified: true },
          ttlMs: TELEGRAM_BOT.PENDING_TTL_MS,
        }, { now: t });
        return clarifyQuestion;
      }
      await closeOut(PROACTIVE_OUTCOME.NO_EXPLANATION_OFFERED);
      return '好，我先記著，會繼續留意。';
    }

    // ★ R3-M-02：使用者沒說日期、而且我們也推導不出這題在問哪一天
    // → **不寫**，改成問清楚。默默用今天寫下去會產生一筆錯的關聯資料，
    // 而且之後沒有任何辦法分辨它是不是錯的。
    const targetDate = questionTargetDateOf(pending);
    if (nat.statedDayOffset === null && targetDate === null) {
      log.warn('proactive_answer_date_unresolvable', {
        user_id: userId, pending_question_id: pending.id,
      });
      return '我想確認一下：這是哪一天的事？（今天、昨天，還是前天？）';
    }

    // 主動問題問的是 targetDate 那一天的行為，短答必須記在那一天
    const anchored = anchorToQuestionDay(nat.event, {
      anchorHealthDate: targetDate,
      statedDayOffset: nat.statedDayOffset,
      timezone,
    });
    // ★ R3-M-03 fence：寫 Journal 之前重新確認所有權還在。
    // 租約可能在 LLM 解析期間過期，而收割器已經把事件推向終局 ——
    // 那時候再寫就是一個「沒有人擁有」的變更。
    if (!await stillOwns(ownership)) {
      log.warn('proactive_answer_ownership_lost', {
        user_id: userId, event_id: proactiveEventId,
      });
      return '我這邊處理到一半被中斷了，這則先沒有記錄；需要的話再跟我說一次。';
    }
    const saved = await saveEvent(db, userId, { ...anchored, source: 'proactive_agent' }, { now: t, timezone });
    const savedLine = saved.ok ? `✅ 已記錄：${describeEvent(saved.event)}` : null;

    let followUpLine = '';
    let outcome = PROACTIVE_OUTCOME.NO_EXPLANATION_OFFERED;
    if (saved.ok && metric && healthDate) {
      try {
        const result = await reanalyzeAfterAnswer({
          db, userId, timezone, category: saved.event.category, metric, healthDate,
          // 把觸發這次追問的訊號帶進去，重新分析才是「針對這個異常」，
          // 而不是只看全域的 journal 關聯有沒有變。
          signal: pending.context?.signal ?? null,
          now: t,
        });
        outcome = result.outcome;
        if (result.outcome === PROACTIVE_OUTCOME.STILL_UNEXPLAINED) {
          followUpLine = '\n\n目前累積的資料還不足以確認這是不是解釋，我會繼續追蹤。';
        } else if (result.followUpMessage) {
          followUpLine = `\n\n${result.followUpMessage}`;
        }
      } catch (err) {
        log.warn('proactive_reanalysis_failed', { error: describeError(err) });
      }
    }

    await closeOut(outcome, { journalEventId: saved.ok ? saved.id : null });
    return savedLine ? `${savedLine}${followUpLine}` : `我先記下來了。${followUpLine}`;
  }

  return { handle, route, handleQuestion, handlePendingAnswer, runIntent };
}
