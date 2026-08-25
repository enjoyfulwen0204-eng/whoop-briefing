/**
 * AI 教練文字生成（走 OpenRouter）。
 *
 * 為什麼是 OpenRouter：一把 key 就能換不同模型 / 不同供應商，模型掛了可以直接改
 * OPENROUTER_MODEL 換一個。OpenRouter 只提供 OpenAI 格式的 /chat/completions，
 * 沒有 Anthropic Messages API，所以這裡用 fetch 自己打，不用任何 SDK。
 *
 * 重點：
 *  - model 走環境變數 OPENROUTER_MODEL，預設 anthropic/claude-sonnet-5（要帶 namespace）。
 *  - 這種簡單教練文字不需要推理 → reasoning 關掉，省 token。
 *  - 不設 temperature / top_p / top_k，語氣風格全靠 system prompt 控制。
 *  - 模型只把「程式算好的結果」講成人話，不做任何好壞判斷。
 */

import { COACH } from './config.js';
import { log, describeError } from './logger.js';

export const SYSTEM_PROMPT = `你是 Kelvin 的私人健康教練，語氣像溫暖、專業、體貼的女教練。你會收到「程式已算好」的今日數據、個人基準、三級判斷結果、趨勢資訊。你只負責把這些用繁體中文、口語、溫暖但不啰嗦地講給他聽。

規則：
- 不要自己判斷數值好壞或決定嚴重度，程式算好了，你只依判斷結果說話。
- 依身體狀況決定長短：全部正常就簡短一兩句（肯定他、放心去衝）；有偏離才展開講哪裡、可能方向、今天怎麼調整。整體約 80–180 字。
- 給生活化方向性建議（補水、早睡、放輕鬆、留意身體訊號），不堆術語。
- 你是教練不是醫生：可說「這幾天恢復指標偏離平常，可能是恢復不足、壓力累積，或身體在承受額外負荷」，但除非我提供實際症狀，不要推測是感冒或任何特定疾病，也不要碰中醫概念（如濕氣）。
- 多個指標同時明顯偏離，溫和提醒：若我也覺得疲倦、喉嚨不適或有其他症狀，別硬撐，去看醫生。
- 語氣溫暖可帶少量 emoji（☀️💪💛），別浮誇。稱呼我 Kelvin。不要重述所有數字（數字已在訊息上方），只講重點與建議。`;

const WEEKLY_EXTRA = `
這次是「每週回顧」：請用同樣的溫暖口吻，約 150–300 字。談上週整體狀態、最好與最差的一天、和前一週相比的趨勢，最後給下週一個具體可執行的小方向。`;

const SEVERITY_ZH = { green: '正常', yellow: '偏離', red: '差很多', null: '未判定' };

/**
 * 把算好的結果轉成給模型的輸入。
 * 只給結論與必要數字，不給原始 API payload。
 */
export function buildDailyUserMessage(briefing) {
  const lines = [];
  lines.push(`日期：${briefing.localDate}`);
  lines.push(`基準狀態：${stageZh(briefing.stage, briefing.sampleCount)}`);
  if (briefing.metrics.some((m) => m.calibrating && m.available)) {
    lines.push('恢復數據狀態：WHOOP 校正中。恢復類指標只顯示數值、未做判定，請不要評論這幾項的好壞。');
  }
  lines.push('');
  lines.push('今日指標（程式已判定）：');
  for (const m of briefing.metrics) {
    if (!m.available) {
      if (m.tier === 'core') lines.push(`- ${m.label}：無資料`);
      continue;
    }
    const parts = [`- ${m.label}：${m.display}`];
    // 冷啟動階段基準還不可信，就不要餵給模型，免得它拿來評論
    if (briefing.stage !== 'cold') {
      if (m.baselineDisplay) parts.push(`基準 ${m.baselineDisplay}`);
      if (m.pct !== null) parts.push(`${m.pct >= 0 ? '+' : ''}${m.pct.toFixed(1)}%`);
      parts.push(`判定：${SEVERITY_ZH[m.severity ?? 'null']}`);
    }
    lines.push(parts.join('，'));
  }

  if (briefing.trends?.alerts?.length) {
    lines.push('');
    lines.push(`趨勢預警（強度：${briefing.trends.level === 'strong' ? '較強，多項生理訊號同時異常' : '一般'}）：`);
    for (const a of briefing.trends.alerts) {
      const kinds = a.types.map((t) => (t === 'worsening' ? '連續惡化' : '連續偏低')).join('、');
      lines.push(`- ${a.label}：${kinds}（${a.series.map((p) => p.display).join(' → ')}）`);
    }
  } else {
    lines.push('');
    lines.push('趨勢預警：無');
  }

  lines.push('');
  lines.push(summaryLine(briefing));
  lines.push('請只輸出要對 Kelvin 說的話本身，不要標題、不要條列數字、不要重複上面的數據表。');
  return lines.join('\n');
}

function summaryLine(briefing) {
  const scored = briefing.metrics.filter((m) => m.available && m.severity);
  const red = scored.filter((m) => m.severity === 'red').map((m) => m.label);
  const yellow = scored.filter((m) => m.severity === 'yellow').map((m) => m.label);
  if (briefing.stage === 'cold') {
    return '整體：個人基準還在建立中，這次不做好壞判斷，請以鼓勵與建立習慣為主。';
  }
  if (!red.length && !yellow.length) return '整體：全部指標正常。';
  const bits = [];
  if (red.length) bits.push(`差很多：${red.join('、')}`);
  if (yellow.length) bits.push(`偏離：${yellow.join('、')}`);
  return `整體：${bits.join('；')}。`;
}

export function buildWeeklyUserMessage(weekly) {
  const { last, prev, wow } = weekly;
  const lines = [];
  lines.push(`上週區間：${last.startDate} ～ ${last.endDate}，有效天數 ${last.days}`);
  lines.push('上週平均（程式已算好）：');
  for (const [key, a] of Object.entries(last.averages)) {
    if (a.mean === null) {
      lines.push(`- ${a.label}：無資料`);
      continue;
    }
    const w = wow[key];
    const cmp = w && w.pct !== null
      ? `，與前週相比 ${w.delta >= 0 ? '+' : ''}${w.pct.toFixed(1)}%（${w.direction === 'flat' ? '差不多' : (w.direction === 'up' ? '上升' : '下降')}）`
      : '，前週無可比資料';
    lines.push(`- ${a.label}：${a.display}${cmp}`);
  }
  if (last.best) lines.push(`最好的一天：${last.best.date}，恢復 ${last.best.display}`);
  if (last.worst) lines.push(`最差的一天：${last.worst.date}，恢復 ${last.worst.display}`);
  lines.push(`前一週有效天數：${prev.days}`);
  lines.push('');
  lines.push('請只輸出要對 Kelvin 說的話本身，不要標題、不要條列數字。');
  return lines.join('\n');
}

function stageZh(stage, n) {
  if (stage === 'cold') return `冷啟動，有效紀錄 ${n} 筆（不足 7 筆，不做好壞判斷）`;
  if (stage === 'provisional') return `暫定基準，有效紀錄 ${n}/30 筆`;
  return '正式基準（30 筆）';
}

// ---------------------------------------------------------------------------

export class CoachApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'CoachApiError';
    this.status = status;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function backoffMs(attempt) {
  return Math.min(2000 * 2 ** (attempt - 1), COACH.MAX_BACKOFF_MS);
}

/** OpenRouter 正常回字串；少數 provider 會回 content parts 陣列，兩種都吃。 */
function contentToText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((p) => (typeof p === 'string' ? p : p?.text ?? '')).join('');
  }
  return '';
}

export function createCoach({
  apiKey,
  model = COACH.DEFAULT_MODEL,
  baseUrl = COACH.BASE_URL,
  fetchImpl = fetch,
  maxRetries = COACH.MAX_RETRIES,
  backoffFor = backoffMs,
}) {
  /**
   * 參數階梯：先用最省的組合，若該模型 / provider 不吃某個參數（400）就退一階。
   * 這樣換模型（例如改成 anthropic/claude-haiku-4.5）也不會直接掛掉。
   */
  const PARAM_TIERS = [
    { reasoning: { enabled: false } }, // 教練文字不需要推理，關掉省 token
    {},
  ];

  /** 單次 POST。非 2xx 一律丟 CoachApiError（帶 status，外層才知道要退參數還是重試）。 */
  async function post(body) {
    const res = await fetchImpl(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        // OpenRouter 用來標示來源 app（選填，只影響它自己的排行榜）
        'x-title': 'whoop-briefing',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(COACH.TIMEOUT_MS),
    });

    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* 不是 JSON（例如 gateway 的 HTML 錯誤頁），下面用原始文字報錯 */
    }

    if (!res.ok) {
      const msg = json?.error?.message || text.slice(0, 200) || `HTTP ${res.status}`;
      throw new CoachApiError(`OpenRouter ${res.status}: ${msg}`, res.status);
    }
    // OpenRouter 有時用 200 包一個 error（上游 provider 出錯時）
    if (json?.error) {
      const msg = json.error.message ?? JSON.stringify(json.error);
      throw new CoachApiError(`OpenRouter error: ${msg}`, Number(json.error.code) || 502);
    }
    return json;
  }

  /** 429 / 5xx / 連線錯誤時 exponential backoff 重試；timeout 不重試（避免拖太久）。 */
  async function send(body) {
    let lastErr;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await post(body);
      } catch (err) {
        lastErr = err;
        const status = err instanceof CoachApiError ? err.status : null;
        const retryable = status !== null
          ? (status === 429 || status >= 500)
          : (err?.name !== 'AbortError' && err?.name !== 'TimeoutError');
        if (!retryable || attempt === maxRetries) throw err;
        const wait = backoffFor(attempt);
        log.warn('coach_retry', { attempt, status, wait_ms: wait, error: describeError(err) });
        await sleep(wait);
      }
    }
    throw lastErr;
  }

  async function complete({ system, userMessage, maxTokens }) {
    let lastErr;
    for (const [i, extra] of PARAM_TIERS.entries()) {
      try {
        const json = await send({
          model,
          max_tokens: maxTokens,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: userMessage },
          ],
          ...extra,
        });
        const choice = json?.choices?.[0];
        const text = contentToText(choice?.message?.content).trim();
        log.info('coach_ok', {
          model: json?.model ?? model,
          param_tier: i,
          finish_reason: choice?.finish_reason,
          input_tokens: json?.usage?.prompt_tokens,
          output_tokens: json?.usage?.completion_tokens,
          chars: text.length,
        });
        if (!text) throw new Error('OpenRouter 回傳空白內容');
        return text;
      } catch (err) {
        lastErr = err;
        const status = err instanceof CoachApiError ? err.status : null;
        // 400 / 422 = 這個模型不吃某個參數 → 退一階再試
        if ((status === 400 || status === 422) && i < PARAM_TIERS.length - 1) {
          log.warn('coach_param_tier_rejected', { param_tier: i, error: describeError(err) });
          continue;
        }
        throw err;
      }
    }
    throw lastErr;
  }

  return {
    model,
    /** 失敗回 null → 上層走 fallback（照樣發數據簡報）。 */
    async daily(briefing) {
      try {
        return await complete({
          system: SYSTEM_PROMPT,
          userMessage: buildDailyUserMessage(briefing),
          maxTokens: COACH.DAILY_MAX_TOKENS,
        });
      } catch (err) {
        log.error('coach_daily_failed', { error: describeError(err) });
        return null;
      }
    },
    async weekly(weeklyData) {
      try {
        return await complete({
          system: SYSTEM_PROMPT + WEEKLY_EXTRA,
          userMessage: buildWeeklyUserMessage(weeklyData),
          maxTokens: COACH.WEEKLY_MAX_TOKENS,
        });
      } catch (err) {
        log.error('coach_weekly_failed', { error: describeError(err) });
        return null;
      }
    },
  };
}
