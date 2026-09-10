/**
 * structured context → 人話。
 *
 * ## LLM 在這裡能做什麼、不能做什麼
 *
 *  能：把 Node 算好的數字組織成一段好讀的中文。
 *  不能：計算任何東西、推論相關性、發明數字、判斷醫學意義。
 *
 * 所以送進 prompt 的永遠是**已經算完的結論**（平均、z-score、樣本數、趨勢方向），
 * 而且明確告訴模型「這些數字已經算好，不要重算也不要質疑」。
 *
 * LLM 掛掉時走 renderFallback()：純 Node 排版的版本，資訊一樣完整，只是比較乾。
 */

import { AI_PURPOSE, PROMPT_VERSIONS, TELEGRAM_BOT } from '../config.js';
import { safeSlice } from '../format.js';
import { guardPublication } from '../publishGuard.js';
import { factsFromQaResult } from '../publishableFacts.js';
import { log } from '../logger.js';

export const ANSWER_SYSTEM_PROMPT = `你是 Kelvin 的私人健康教練，語氣溫暖、專業、口語，用繁體中文。

你會收到「程式已經算好」的健康數據結論（平均、標準差、z-score、樣本數、趨勢方向）。

嚴格規則：
- 這些數字已經由程式算好。不要重新計算、不要換算、不要質疑、不要補上沒給你的數字。
- 絕對不要編造任何沒有出現在輸入裡的數值、日期或結論。
- 樣本數少的時候要老實說「資料還不夠多，這只是初步觀察」。
- 你是教練不是醫生：不要診斷疾病，不要用「異常」「不正常」這種醫學字眼。
  要講就講「和你平常比偏低／偏高」。
- 如果輸入說某項資料不可用，就直說目前拿不到，不要猜。
- 回答控制在 120–250 字，重點先講，不要條列一大堆數字（數字使用者看得到）。
- 可以用少量 emoji，稱呼對方 Kelvin。
- ★ 需要提到數字時，只能照抄輸入裡的那一個，一個字都不能改；
  沒把握就用「比平常低一些」這種相對描述，不要給數字。
- ★ 絕對不要提到輸入裡沒有出現的指標，也不要提 WHOOP Age、Healthspan
  分數、推估年齡這類分數（這個系統算不出它們）。
- ★ 絕對不要建議任何藥物、補劑、劑量或醫療處置。`;

/**
 * 把 structured result 轉成**可信事實**。
 *
 * ★ 這裡刻意不含使用者的問題。見 composeAnswer 的說明：
 *   USER TEXT IS NOT EVIDENCE。
 */
export function buildTrustedFacts(result) {
  const lines = [];

  if (!result || result.available === false) {
    lines.push(`目前無法回答，原因：${result?.reason ?? 'unknown'}`);
    return lines.join('\n');
  }

  lines.push(`分析類型：${result.intent}`);
  if (result.health_date) lines.push(`最新健康日：${result.health_date}`);
  if (result.history_days !== undefined) lines.push(`可用歷史天數：${result.history_days}`);
  lines.push('');

  switch (result.intent) {
    case 'today_status': {
      lines.push('今日指標（程式已算好）：');
      for (const [key, m] of Object.entries(result.metrics)) {
        if (m.value === null || m.value === undefined) {
          lines.push(`- ${m.label}：無資料`);
          continue;
        }
        const bits = [`- ${m.label}：${m.display}`];
        if (m.baseline_display) bits.push(`30 天基準 ${m.baseline_display}（n=${m.baseline_n}）`);
        if (m.z_score !== null) bits.push(`z=${m.z_score.toFixed(2)}`);
        bits.push(`偏離程度：${m.level}`);
        lines.push(bits.join('，'));
      }
      if (result.what_changed?.length) {
        lines.push('', '最值得注意的變化（已依重要度排序）：');
        for (const c of result.what_changed) {
          lines.push(`- ${c.metric}：目前 ${c.current}，`
            + `${c.vs_30d_pct !== null ? `比 30 天平均${c.vs_30d_pct >= 0 ? '高' : '低'} ${Math.abs(c.vs_30d_pct).toFixed(0)}%，` : ''}`
            + `z=${c.z_score === null ? 'n/a' : c.z_score.toFixed(2)}`);
        }
      }
      if (result.data_quality?.calibrating) {
        lines.push('', '注意：WHOOP 恢復數據還在校正中，恢復類指標僅供參考。');
      }
      break;
    }

    case 'trend_query': {
      lines.push(`指標：${result.label}`);
      lines.push(`目前值：${result.current_display ?? '無資料'}`);
      const w = result.window;
      lines.push(`${w.window_days} 天窗口：平均 ${w.mean_display ?? 'n/a'}，`
        + `樣本 n=${w.n}${w.sufficient ? '' : '（樣本不足，結論僅供參考）'}`);
      if (w.stddev !== null) lines.push(`標準差 ${w.stddev.toFixed(2)}`);
      if (result.deviation?.z_score !== null) {
        lines.push(`與 30 天基準的偏離：z=${result.deviation.z_score.toFixed(2)}，`
          + `程度 ${result.deviation.level}，值得留意：${result.deviation.noteworthy ? '是' : '否'}`);
      }
      lines.push('', '趨勢（程式算的線性斜率）：');
      for (const [k, t] of Object.entries(result.trends)) {
        lines.push(`- ${k}：${t.sufficient
          ? `${t.direction}（斜率/天 ${t.slope_per_day?.toFixed(4)}，n=${t.n}）`
          : `資料不足（n=${t.n}）`}`);
      }
      if (result.baseline_shift?.shift) {
        lines.push('', `基準可能位移：最近 ${result.baseline_shift.window_days} 天平均 `
          + `${result.baseline_shift.recent_mean?.toFixed(2)} vs 前期 `
          + `${result.baseline_shift.previous_mean?.toFixed(2)}，`
          + `effect size ${result.baseline_shift.effect_size?.toFixed(2)}`);
      }
      break;
    }

    case 'sleep_quality': {
      lines.push(`睡眠指標（${result.window_days} 天窗口）：`);
      for (const m of Object.values(result.metrics)) {
        if (!m.available) { lines.push(`- ${m.label}：拿不到`); continue; }
        const t = m.trends?.[`${result.window_days}d`] ?? m.trends?.['30d'];
        lines.push(`- ${m.label}：目前 ${m.current_display ?? 'n/a'}，`
          + `平均 ${m.mean_display ?? 'n/a'}（n=${m.n}）`
          + `${t?.sufficient ? `，趨勢 ${t.direction}` : ''}`);
      }
      if (result.bedtime_n > 0) {
        lines.push('', `最近的就寢時間（共 ${result.bedtime_n} 筆有紀錄）：`
          + result.bedtime_samples.map((b) => `${b.date} ${b.bedtime}`).join('、'));
      }
      break;
    }

    case 'best_worst_day': {
      lines.push(`指標：${result.label}，區間 ${result.window_days} 天，有效樣本 n=${result.n}`);
      lines.push(`最好的一天：${result.best.health_date}，${result.best.display}`);
      if (result.best.sleep_total_display) lines.push(`  當天睡眠 ${result.best.sleep_total_display}，就寢 ${result.best.bedtime_local ?? 'n/a'}`);
      if (result.worst) {
        lines.push(`最差的一天：${result.worst.health_date}，${result.worst.display}`);
        if (result.worst.sleep_total_display) lines.push(`  當天睡眠 ${result.worst.sleep_total_display}，就寢 ${result.worst.bedtime_local ?? 'n/a'}`);
      }
      break;
    }

    case 'what_changed': {
      if (!result.items.length) {
        lines.push('今天沒有任何指標偏離到值得特別提出來的程度。');
      } else {
        lines.push('值得注意的變化（已依重要度排序，程式算好）：');
        for (const c of result.items) {
          lines.push(`- ${c.label}：${c.current_display}，`
            + `${c.vs_30d_pct !== null ? `比 30 天平均${c.vs_30d_pct >= 0 ? '高' : '低'} ${Math.abs(c.vs_30d_pct).toFixed(0)}%，` : ''}`
            + `z=${c.z_score === null ? 'n/a' : c.z_score.toFixed(2)}，重要度 ${c.importance.toFixed(2)}`);
        }
      }
      break;
    }

    default:
      lines.push(JSON.stringify(result).slice(0, 1500));
  }

  return lines.join('\n');
}

/**
 * 給模型看的完整 prompt = 使用者的問題 + 可信事實 + 指示。
 *
 * 模型**需要**看到問題才知道要回答什麼；驗證層**絕不可以**看到問題
 * （否則使用者可以用問題自己授權自己的健康宣稱）。所以兩者分開產生。
 */
export function buildAnswerContext(question, result) {
  return [
    `使用者的問題：${question}`,
    '',
    buildTrustedFacts(result),
    '',
    '請用溫暖口語的繁體中文回答上面的問題。只根據以上資訊，不要補任何沒給你的數字。',
  ].join('\n');
}

/** LLM 不可用時的純 Node 版本 —— 資訊完整，只是比較乾。 */
export function renderFallback(result) {
  if (!result || result.available === false) {
    return '目前還沒有足夠的 WHOOP 資料可以回答這個問題。';
  }
  const lines = [];
  switch (result.intent) {
    case 'today_status':
      lines.push(`📊 ${result.health_date} 的狀態`);
      for (const m of Object.values(result.metrics)) {
        if (m.value === null || m.value === undefined) { lines.push(`${m.label}：無資料`); continue; }
        lines.push(`${m.label} ${m.display}`
          + (m.baseline_display ? `（基準 ${m.baseline_display}）` : '')
          + (m.z_score !== null ? ` z=${m.z_score.toFixed(1)}` : ''));
      }
      break;
    case 'trend_query': {
      const w = result.window;
      lines.push(`📈 ${result.label}`);
      lines.push(`目前 ${result.current_display ?? '無資料'}`);
      lines.push(`${w.window_days} 天平均 ${w.mean_display ?? 'n/a'}（n=${w.n}）`);
      for (const [k, t] of Object.entries(result.trends)) {
        lines.push(`${k} 趨勢：${t.sufficient ? t.direction : '資料不足'}`);
      }
      break;
    }
    case 'best_worst_day':
      lines.push(`🏆 ${result.label}（最近 ${result.window_days} 天，n=${result.n}）`);
      lines.push(`最好：${result.best.health_date} ${result.best.display}`);
      if (result.worst) lines.push(`最差：${result.worst.health_date} ${result.worst.display}`);
      break;
    case 'what_changed':
      if (!result.items.length) return '今天沒有特別值得注意的變化。';
      lines.push('🔎 今天最值得注意');
      for (const c of result.items) {
        lines.push(`· ${c.label} ${c.current_display}`
          + (c.z_score !== null ? `（z=${c.z_score.toFixed(1)}）` : ''));
      }
      break;
    case 'sleep_quality':
      lines.push(`🌙 睡眠（最近 ${result.window_days} 天）`);
      for (const m of Object.values(result.metrics)) {
        if (!m.available) continue;
        lines.push(`${m.label}：目前 ${m.current_display ?? 'n/a'}，平均 ${m.mean_display ?? 'n/a'}（n=${m.n}）`);
      }
      break;
    default:
      return '目前無法回答這個問題。';
  }
  return lines.join('\n');
}

/** structured result → 最終要送出去的文字。 */
/**
 * structured result → 最終要送出去的文字。
 *
 * ★ LLM 的回答一定會先過 guardNarrative：如果它講出可信事實裡沒有的數字、
 * 日期、指標，或使用強因果 / 診斷措辭，**原文不會被送出去**，
 * 改用 renderFallback() 的純 Node 版本。
 *
 * ## USER TEXT IS NOT EVIDENCE（H-02）
 *
 * 舊版把 `buildAnswerContext()` 的輸出同時當成 prompt 和驗證用的 context，
 * 而那個字串的第一行就是 `使用者的問題：<原話>`。結果使用者可以自己
 * 授權自己的宣稱：
 *
 *   問：「我的 HRV 是 999ms 對嗎？」
 *   → 999 出現在 context → 「你的 HRV 999ms 偏高」通過驗證並送出
 *
 * 現在 prompt 與可信事實是兩個分開產生的字串，guardNarrative 只拿得到
 * `buildTrustedFacts(result)` —— 100% 由確定性 / 統計層算出來的東西。
 */
export async function composeAnswer({ question, result, coach, purpose = AI_PURPOSE.QA }) {
  const fallback = renderFallback(result);
  if (!result || result.available === false) return fallback;
  if (!coach?.ask) return fallback;

  // prompt 仍然含問題（模型需要知道要回答什麼）；驗證則完全不看它，
  // 而是看 factsFromQaResult(result) 建立的結構化事實。
  const prompt = buildAnswerContext(question, result);
  const text = await coach.ask({
    system: ANSWER_SYSTEM_PROMPT,
    user: prompt,
    maxTokens: TELEGRAM_BOT.ANSWER_MAX_TOKENS,
    purpose,
    promptVersion: PROMPT_VERSIONS.QA,
  });
  if (!text) return fallback;

  // ★ 發布邊界（R2-H-02）：事實集直接從 structured result 建立。
  // 使用者的問題**從來沒有機會**變成證據 —— 它只出現在 prompt 裡。
  const guarded = guardPublication({
    narrative: safeSlice(text.trim(), TELEGRAM_BOT.MAX_REPLY_CHARS),
    factSet: factsFromQaResult(result),
    fallback,
    label: 'qa',
  });
  if (guarded.used === 'fallback') {
    log.warn('qa_answer_replaced_by_fallback', { violations: guarded.violations?.slice(0, 4) });
  }
  return guarded.text;
}
