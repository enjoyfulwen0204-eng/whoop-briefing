/** Health answers use computed facts and application-owned templates only.
 * Prompt/context exports remain for compatibility; publication never calls them. */

import { AI_PURPOSE } from '../config.js';
import { factsFromQaResult } from '../publishableFacts.js';
import { renderAssertions, assemblePublication } from '../assertionRenderer.js';

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
    case 'cause_query': return renderCauseAnswer(result);
    case 'readiness_query': return renderReadinessAnswer(result);
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
    case 'cause_query': return renderCauseAnswer(result);
    case 'readiness_query': return renderReadinessAnswer(result);
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
      // 當下的值給得出來、統計給不出來時，講清楚是**哪一種**給不出來 ——
      // 不要讓人以為是資料還沒同步進來。
      if (result.analysis_limited === 'calibrating') {
        lines.push('（還在 WHOOP 校正期，暫時不做趨勢判斷）');
      } else if (result.analysis_limited === 'insufficient_history') {
        lines.push('（樣本還太少，還不夠下結論）');
      } else {
        lines.push(`${w.window_days} 天平均 ${w.mean_display ?? 'n/a'}（n=${w.n}）`);
        for (const [k, t] of Object.entries(result.trends)) {
          lines.push(`${k} 趨勢：${t.sufficient ? t.direction : '資料不足'}`);
        }
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


/** 生活事件 → 人話。只認我們真的會記錄的類別。 */
const CONTRIBUTOR_LABEL = {
  alcohol: '喝酒', caffeine: '咖啡因', late_night: '晚睡', poor_sleep: '睡不好',
  illness: '身體不適', stress: '壓力', travel: '出差或旅行', workout: '運動',
  sauna: '三溫暖', massage: '按摩', nap: '小睡',
};

/**
 * 「為什麼我這麼累」的回答。
 *
 * ## 這一段最重要的規則
 *
 * **「沒偵測到偏離」不可以講成「你沒事」。** 使用者說他累，那就是一個事實。
 * 系統看不出異常只代表系統看不出來。以前這類問題回「今天沒有特別值得注意的
 * 變化」，等於否定了他的感受。
 *
 * 所以順序固定是：先承認感受 → 講看得到的數字 → 講基準夠不夠 → 講**可能的**
 * 因素（明確標成可能）→ 誠實講限制。
 */
export function renderCauseAnswer(result) {
  const out = [];
  const facts = result.facts ?? [];
  const contributors = result.contributors ?? [];

  out.push('你會覺得累，這件事本身就值得看一下。我把目前看得到的講給你聽。');

  if (facts.length) {
    out.push('');
    out.push('目前這一天的數字：');
    for (const f of facts) {
      out.push(`· ${f.label} ${f.display}`
        + (f.comparable && f.baseline_display
          ? `（你平常大約 ${f.baseline_display}${f.noteworthy ? '，這次偏離比較明顯' : '，差不多'}）`
          : ''));
    }
  }

  // 基準夠不夠 —— 這是「能不能下判斷」的關鍵，不是資料庫筆數
  const comparable = facts.filter((f) => f.comparable);
  out.push('');
  if (!comparable.length) {
    out.push(result.calibrating
      ? '不過這些數字現在還在 WHOOP 的校正期，而且我累積的天數還不夠，'
        + '所以我沒辦法判斷它們算不算「你的不正常」。'
      : '不過我累積的天數還不夠，還建立不出你的個人基準，'
        + '所以我沒辦法判斷這些數字算不算「你的不正常」。');
    out.push('也就是說：我現在無法確定你累的真正原因，而不是判斷你的身體沒有狀況。');
  } else {
    const odd = comparable.filter((f) => f.noteworthy);
    out.push(odd.length
      ? `跟你平常比，比較明顯的是：${odd.map((f) => f.label).join('、')}。`
      : '跟你平常比，這些數字都還在你的常見範圍內 —— 但那只代表我沒看到明顯偏離，你的疲勞感仍然是真的。');
  }

  // 可能的因素（絕不講成證明）
  if (contributors.length) {
    const names = [...new Set(contributors
      .map((c) => CONTRIBUTOR_LABEL[c.category] ?? null)
      .filter(Boolean))];
    if (names.length) {
      out.push('');
      out.push(`你最近記錄了：${names.join('、')}。這些都有可能讓人覺得累，`
        + '不過以我手上的資料，還不足以確認它就是這次疲勞的原因。');
      // ★ 時序：測量在前、事件在後 → 這組數字不可能反映那件事
      if (contributors.some((c) => c.after_measurement)) {
        out.push('而且要特別說：今天的恢復／HRV／靜息心率是睡眠期間量到的，'
          + '時間點在你剛剛那件事之前，所以那組數字反映不出它的影響。');
      }
    }
  }

  out.push('');
  out.push(comparable.length
    ? '如果累的感覺一直持續，或伴隨其他不舒服，還是以你的身體感覺為準。'
    : '再累積幾天資料之後，我才有辦法給你比較有依據的判斷。');
  return out.join('\n');
}

/**
 * 「因為數據不夠嗎」的回答。
 *
 * 直接回答是/不是，然後用**人話**解釋限制 —— 不是倒出涵蓋率、各資源筆數、
 * capability probe 或 backfill 狀態。那些是給維運看的，對話裡不該出現。
 */
export function renderReadinessAnswer(result) {
  const out = [];
  const days = result.max_eligible_days ?? 0;
  const need = result.min_samples_needed ?? null;

  if (!result.baseline_ready) {
    out.push('對，主要就是這個。');
    out.push('');
    if (result.has_today_facts) {
      out.push('今天的數字我看得到，但我還沒有足夠的歷史可以建立「你平常是什麼樣子」，'
        + '所以沒辦法判斷今天的數值算不算偏離你的常態。');
    } else {
      out.push('我目前累積到的資料還太少，還建立不出你的個人基準。');
    }
    if (days > 0 && Number.isFinite(need)) {
      out.push('');
      out.push(`目前可以拿來比較的大約是 ${days} 天份，至少要 ${need} 天左右才夠做比較。`);
    }
    if (result.calibrating) {
      out.push('');
      out.push('另外 WHOOP 本身也還在校正期，這段期間的數值不適合拿來當基準。');
    }
    out.push('');
    out.push('再累積一段時間，我就能給你比較有依據的判斷。');
  } else {
    out.push('不完全是。');
    out.push('');
    out.push(`我已經有大約 ${days} 天可以比較的資料，基準是建立得起來的。`);
    out.push('判斷不出來的原因比較可能是：這件事的答案本來就不在 WHOOP 量得到的範圍裡，'
      + '或是目前的數字確實沒有明顯偏離。');
  }
  return out.join('\n');
}

/** structured result → 最終要送出去的文字。 */
/** Render the computed result without invoking or appending provider prose.
 * Trend templates preserve computed windows/sample counts in addition to values. */
export async function composeAnswer({ question, result, coach, purpose = AI_PURPOSE.QA }) {
  if (!result || result.available === false) return renderFallback(result);

  // 1) 確定性斷言 —— 這一段永遠存在，而且與 LLM 無關
  const factSet = factsFromQaResult(result);
  const { lines, unavailable } = renderAssertions(factSet);
  const header = result.health_date ? `📊 ${result.health_date} 的狀態` : null;

  // 事實集算不出任何東西時，退回既有的確定性排版（它涵蓋 trend/best-worst
  // 等 factsFromQaResult 不建模的 intent）。
  const deterministic = lines.length && result.intent !== 'trend_query'
    ? assemblePublication({ header, assertionLines: lines, unavailable })
    : renderFallback(result);

  // Provider prose has no publication authority, including optional explanations.
  return deterministic;
}
