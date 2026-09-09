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
import { reanalyzeAfterAnswer } from '../proactiveReanalysis.js';
import { requireUserId } from '../userContext.js';
import { structuredWithRetry } from '../llmValidation.js';
import { buildDataQualityReport, renderDataQuality } from '../dataQuality.js';
import { createHealthQuery } from '../healthQuery.js';
import { saveEvent, describeEvent, healthDateFor, CATEGORIES } from '../journal.js';
import { addDays, localDate } from '../time.js';
import { loadDailyMetrics } from '../dailyMetrics.js';
import { log, describeError } from '../logger.js';
import { resolveIntent, parseCommand } from './intent.js';
import { composeAnswer } from './answer.js';
import {
  handleLog, handleHealthData, startText, buildHelp,
  handleStatus, handleJournal, handleInsights, handlePredictions,
  handleCost, handleEvidence, handleHealthspan,
} from './commands.js';
import * as experimentFlow from './experimentFlow.js';
import {
  shouldFollowUp, openFollowUp, isNegativeAnswer, looksLikeQuestion, FOLLOW_UP_CATEGORIES,
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
{"category":"<類別>","subtype":"<子類或 null>","numeric_value":<數字或 null>,"unit":"<單位或 null>","day_offset":<0 表示今天、-1 表示昨天、-2 表示前天>,"confidence":<0 到 1>}

category 只能是下列其中一個：
alcohol, caffeine, late_meal, supplement, medication, sickness, stress,
travel, flight, location, late_sleep, exercise_note, sauna, massage, food, custom

規則：
- 你只做語言理解，不要做任何計算，也不要推測使用者的健康狀況。
- 如果句子裡沒有明確數量，numeric_value 給 null。
- 如果無法判斷是哪個類別，category 給 "custom"，confidence 給低分。
- day_offset 只能是 0、-1 或 -2。沒提到時間就給 0。

範例：
「昨天喝了三杯酒」→ {"category":"alcohol","subtype":null,"numeric_value":3,"unit":"drinks","day_offset":-1,"confidence":0.95}
「今天飛胡志明」→ {"category":"flight","subtype":"HCMC","numeric_value":null,"unit":null,"day_offset":0,"confidence":0.9}
「昨晚兩點才睡」→ {"category":"late_sleep","subtype":null,"numeric_value":2,"unit":"hour","day_offset":-1,"confidence":0.9}`;

const CATEGORY_SET = new Set(CATEGORIES);

/** LLM 提案 → 已驗證的 journal candidate。信心太低就不採用。 */
/**
 * Journal candidate 的嚴格 schema。
 * 數值範圍刻意收緊：模型偶爾會回 -3 杯酒或 999999 mg。
 */
export const JOURNAL_SCHEMA = {
  category: { type: 'string', enum: CATEGORIES, required: true },
  subtype: { type: 'string', nullable: true, maxLength: 60 },
  numeric_value: { type: 'number', min: 0, max: 100_000, nullable: true },
  unit: { type: 'string', nullable: true, maxLength: 20 },
  day_offset: { type: 'integer', min: -2, max: 0, nullable: true },
  confidence: { type: 'number', min: 0, max: 1, nullable: true },
};

export async function parseNaturalJournal({ text, now, timezone, coach, minConfidence = 0.5 }) {
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

  let offset = Number(raw.day_offset ?? 0);
  if (!Number.isInteger(offset) || offset > 0 || offset < -2) offset = 0;

  const eventAt = new Date(now.getTime() + offset * 86_400_000);

  return {
    ok: true,
    confidence,
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

/** 這句話看起來像不像在「記錄一件事」而不是在問問題？ */
export function looksLikeJournal(text) {
  const t = String(text ?? '');
  if (/[?？]$/.test(t)) return false;
  if (/(怎樣|如何|為什麼|為何|嗎\s*$|多少|哪一?天)/.test(t)) return false;
  return /(喝|吃|飛|睡|生病|不舒服|感冒|壓力|按摩|三溫暖|旅行|出差|加班|宵夜)/.test(t);
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
    const coach = coachFor(userId);
    try {
      return await route({
        text: String(text ?? '').trim(), chatId, t, userId, timezone, coach,
      });
    } catch (err) {
      log.error('router_failed', { error: describeError(err) });
      return '抱歉，我這邊出了點問題，稍後再試一次。（錯誤已記錄）';
    }
  }

  async function route({ text, chatId, t, userId, timezone, coach }) {
    // ---- 1. 有沒有等著被回答的追問 ----
    const pending = typeof db.getOpenPendingQuestion === 'function'
      ? await db.getOpenPendingQuestion(userId, { now: t })
      : null;
    // 主動代理的問題是「不請自來」的，使用者當下可能正在想別的事。
    // 明顯是在問問題的訊息不可以被當成答案吃掉——否則使用者的問題不會被
    // 回答，還會收到一句「聽不懂」。主動問題保持開著，等真正的回答。
    // （反應式追問不套用這條：那是使用者自己問完之後的對話延續。）
    const swallowsUnrelatedQuestion = pending
      && pending.intent === PROACTIVE_QUESTION_INTENT
      && looksLikeQuestion(text);

    if (pending && !parseCommand(text) && !swallowsUnrelatedQuestion) {
      // 多步驟實驗建立流程有自己的狀態機
      if (pending.context?.flow === experimentFlow.FLOW) {
        const reply = await experimentFlow.handleStep({
          db, userId, pending, text, now: t, timezone,
        });
        if (reply !== null) return reply;
      }
      return handlePendingAnswer({ pending, text, chatId, t, userId, timezone, coach });
    }

    // ---- 2. 指令 ----
    const cmd = parseCommand(text);
    if (cmd) return handleCommand({ cmd, text, chatId, t, userId, timezone, coach });

    // ---- 3. 看起來像在記錄事情 ----
    if (looksLikeJournal(text)) {
      const nat = await parseNaturalJournal({ text, now: t, timezone, coach });
      if (nat.ok) {
        const saved = await saveEvent(db, userId, nat.event, { now: t, timezone });
        if (saved.ok) return `✅ 已記錄：${describeEvent(saved.event)}`;
      }
      // 解析不出來就往下走，當成一般問題
    }

    // ---- 4. 一般問答 ----
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

  async function handleQuestion({ text, chatId, t, userId, timezone, coach }) {
    // 「證據呢？」「你憑什麼？」「樣本多少？」→ 直接回 evidence 摘要。
    // ★ 必須在 intent 判定之前 —— 這類問句不會被任何 intent 認出來，
    // 放在後面會先被 unknown 分支攔截而永遠走不到。
    if (/(證據|憑什麼|可信嗎|樣本(數|多少)|怎麼知道|evidence)/i.test(text)) {
      return handleEvidence({ db, userId, now: t });
    }

    const intent = await resolveIntent(text, { coach });
    log.info('intent_resolved', { intent: intent.intent, source: intent.source, metric: intent.metric });

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
      return handleHealthData({ db, userId, timezone, now: t });
    }

    const q = createHealthQuery({ db, userId, timezone, now: t, lookbackDays });
    const result = await runIntent(q, intent);

    if (!result || result.available === false) {
      if (result?.reason === 'unknown_metric') {
        return `我還不認得「${result.metric}」這個指標。可以問 HRV、靜息心率、恢復、睡眠、Strain 等。`;
      }
      if (result?.reason === 'metric_unavailable') {
        return `目前還沒有 ${result.metric} 的資料。等 WHOOP 同步之後就能分析了。`;
      }
      return NO_DATA_REPLY;
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
      default: return null;
    }
  }

  /**
   * 使用者回答追問。
   * 流程：解析 → 寫 journal → 重跑分析 → 回答原問題 → 清 pending。
   */
  async function handlePendingAnswer({ pending, text, chatId, t, userId, timezone, coach }) {
    if (pending.intent === PROACTIVE_QUESTION_INTENT) {
      return handleProactiveAnswer({ pending, text, chatId, t, userId, timezone, coach });
    }

    // 明確說「沒有」→ 不寫 journal，但要把 pending 收掉
    if (isNegativeAnswer(text)) {
      await db.resolvePendingQuestion(userId, pending.id, text, { now: t });
      return '好，那我先記著這幾天的數字，繼續幫你留意。';
    }

    const nat = await parseNaturalJournal({ text, now: t, timezone, coach });
    let savedLine = null;
    if (nat.ok) {
      const saved = await saveEvent(db, userId, nat.event, { now: t, timezone });
      if (saved.ok) savedLine = `✅ 已記錄：${describeEvent(saved.event)}`;
    }

    await db.resolvePendingQuestion(userId, pending.id, text, { now: t });

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
  async function handleProactiveAnswer({ pending, text, chatId, t, userId, timezone, coach }) {
    const metric = pending.context?.signal?.metric ?? null;
    const healthDate = pending.context?.health_date ?? null;
    const proactiveEventId = pending.context?.proactive_event_id ?? null;

    // journalEventId 讓「哪個主動問題 → 哪筆 Journal → 哪次重新分析」可追溯。
    const closeOut = async (outcome, { journalEventId = null } = {}) => {
      await db.resolvePendingQuestion(userId, pending.id, text, { now: t });
      if (proactiveEventId && typeof db.resolveProactiveEvent === 'function') {
        await db.resolveProactiveEvent(userId, proactiveEventId, outcome, { journalEventId, now: t });
      }
    };

    if (isNegativeAnswer(text)) {
      await closeOut(PROACTIVE_OUTCOME.NO_EXPLANATION_OFFERED);
      return '好，我先記著這件事，會繼續留意後續的數字。';
    }

    const nat = await parseNaturalJournal({ text, now: t, timezone, coach });
    if (!nat.ok) {
      // 只允許一次澄清追問——不能無止盡盤問使用者。
      if (!pending.context?.clarified) {
        await db.resolvePendingQuestion(userId, pending.id, text, { now: t });
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

    const saved = await saveEvent(db, userId, { ...nat.event, source: 'proactive_agent' }, { now: t, timezone });
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
