/**
 * Claude 教練文字生成。
 *
 * 重點（照官方做法）：
 *  - model 走環境變數 ANTHROPIC_MODEL，預設 claude-sonnet-5。
 *  - 這種簡單教練文字不需要深度推理 → thinking 關掉、effort 設 low，省 token。
 *  - 不設 temperature / top_p / top_k（Sonnet 5 設非預設值會回 400）。
 *    語氣風格全靠 system prompt 控制。
 *  - Claude 只把「程式算好的結果」講成人話，不做任何好壞判斷。
 */

import Anthropic from '@anthropic-ai/sdk';
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
 * 把算好的結果轉成給 Claude 的輸入。
 * 只給結論與必要數字，不給原始 API payload。
 */
export function buildDailyUserMessage(briefing) {
  const lines = [];
  lines.push(`日期：${briefing.localDate}`);
  lines.push(`基準狀態：${stageZh(briefing.stage, briefing.sampleCount)}`);
  lines.push('');
  lines.push('今日指標（程式已判定）：');
  for (const m of briefing.metrics) {
    if (!m.available) {
      if (m.tier === 'core') lines.push(`- ${m.label}：無資料`);
      continue;
    }
    const parts = [`- ${m.label}：${m.display}`];
    // 冷啟動階段基準還不可信，就不要餵給 Claude，免得它拿來評論
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

export function createCoach({ apiKey, model = COACH.DEFAULT_MODEL, baseUrl = undefined }) {
  const client = new Anthropic({
    apiKey,
    timeout: COACH.TIMEOUT_MS,
    ...(baseUrl ? { baseURL: baseUrl } : {}),
  });

  /**
   * 參數階梯：先用最省的組合，若該模型不接受某個參數（400）就退一階。
   * 這樣換模型（例如改成 claude-haiku-4-5-20251001）也不會直接掛掉。
   */
  const PARAM_TIERS = [
    { thinking: { type: 'disabled' }, output_config: { effort: 'low' } },
    { thinking: { type: 'disabled' } },
    { output_config: { effort: 'low' } },
    {},
  ];

  async function complete({ system, userMessage, maxTokens }) {
    let lastErr;
    for (const [i, extra] of PARAM_TIERS.entries()) {
      try {
        const res = await client.messages.create({
          model,
          max_tokens: maxTokens,
          system,
          messages: [{ role: 'user', content: userMessage }],
          ...extra,
        });
        const text = res.content
          .filter((b) => b.type === 'text')
          .map((b) => b.text)
          .join('\n')
          .trim();
        log.info('coach_ok', {
          model,
          param_tier: i,
          stop_reason: res.stop_reason,
          input_tokens: res.usage?.input_tokens,
          output_tokens: res.usage?.output_tokens,
          chars: text.length,
        });
        if (!text) throw new Error('Claude 回傳空白內容');
        return text;
      } catch (err) {
        lastErr = err;
        if (err instanceof Anthropic.BadRequestError && i < PARAM_TIERS.length - 1) {
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
