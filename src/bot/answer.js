/** Health answers use computed facts and application-owned templates only.
 * Prompt/context exports remain for compatibility; publication never calls them. */

import { AI_PURPOSE } from '../config.js';
import { factsFromQaResult } from '../publishableFacts.js';
import { renderAssertions, assemblePublication } from '../assertionRenderer.js';
import { mechanismNoun } from './healthEducation.js';
import { SYNC_VERDICT } from '../syncTruth.js';
import { renderBriefingStatus } from '../briefingStatus.js';

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
    case 'sync_status': return renderSyncAnswer(result);
    case 'briefing_status':
      return renderBriefingStatus({ status: result.briefing_status, evidence: result.evidence });
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
    case 'sync_status': return renderSyncAnswer(result);
    case 'briefing_status':
      return renderBriefingStatus({ status: result.briefing_status, evidence: result.evidence });
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


/** 幾小時前（人話）。時間不可信就回 null，不要編。 */
function agoText(iso, nowIso) {
  if (!iso || !nowIso) return null;
  const ms = Date.parse(nowIso) - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return null;
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `${mins} 分鐘前`;
  const hrs = ms / 3_600_000;
  return hrs < 48 ? `${hrs.toFixed(1)} 小時前` : `${Math.round(hrs / 24)} 天前`;
}

/**
 * 「WHOOP 有同步成功嗎」的回答。
 *
 * 只講**有證據**的事：最後一次成功同步的時間、哪些資源出錯、最新一筆資料
 * 是哪一天。沒有證據就說不確定 —— 絕不因為「有資料」就宣稱「最近同步成功」，
 * 那兩件事不一樣。
 *
 * 也絕不吐 capability probe／backfill／資源筆數 —— 那是 /healthdata 的事。
 */
/**
 * 同步狀態 → 使用者看得懂的一句話。
 *
 * ## 為什麼有這麼多種說法
 *
 * 「有同步成功嗎」底下其實是三個不同的問題：覆蓋率、最近一次的結果、
 * 新鮮度。上一版把它們壓成 ok/partial/failing 三檔，於是「三週前 sleep
 * 成功過一次、其他資源從來沒跑過」也會得到「有，最後一次成功同步是……」。
 *
 * 這裡每一種判定對應一句**只宣稱證據支持得起的事**的話。
 *
 * ⚠️ 一律不提資源的內部鍵、endpoint、capability probe、backfill。
 * 使用者要知道的是「資料完不完整、新不新」，不是我們的資料管線長什麼樣。
 */
export function renderSyncAnswer(result) {
  const ago = agoText(result.last_success_at, result.now);
  const when = ago ? `是 ${ago}` : '有紀錄但時間不明';
  const latest = result.latest_health_date
    ? `目前最新的健康資料是 ${result.latest_health_date}。` : null;

  // 同步成功、但 WHOOP 還沒產生今天的分數 —— 這不是故障，必須分開講，
  // 否則使用者會去修一個沒有壞的東西。
  if (result.no_new_data) {
    return [
      `有，最近一次完整同步成功${ago ? `（${ago}）` : ''}，不過還沒有今天的新資料。`,
      'WHOOP 通常要等當天的睡眠評分出來之後才會有新的數字。',
      latest,
    ].filter(Boolean).join('\n');
  }

  switch (result.verdict) {
    case SYNC_VERDICT.LATEST_SUCCESS_COMPLETE:
      return [`有，最近一次完整同步成功，時間${when}。`, latest].filter(Boolean).join('\n');

    case SYNC_VERDICT.LATEST_SUCCESS_PARTIAL:
      return [
        `有部分資料同步成功${ago ? `（最近一次是 ${ago}）` : ''}，`
        + '但不是每一項都確認拿到了，所以我沒辦法說這次是完整的。',
        latest,
      ].filter(Boolean).join('\n');

    case SYNC_VERDICT.HISTORICAL_SUCCESS_LATEST_FAILED:
      return [
        `之前成功過${ago ? `（最近一次成功是 ${ago}）` : ''}，但最近一次有部分沒有成功。`,
        '通常下一次排程會自己補上；如果一直這樣，可能要重新授權一次 WHOOP。',
        latest,
      ].filter(Boolean).join('\n');

    case SYNC_VERDICT.STALE_SUCCESS:
      return [
        `有成功過，但已經有一段時間沒有更新了${ago ? `（最近一次成功是 ${ago}）` : ''}。`,
        '如果你的 WHOOP 有在配戴而且有連上網，通常下一次排程就會補上。',
        latest,
      ].filter(Boolean).join('\n');

    case SYNC_VERDICT.LATEST_FAILED:
      return '目前看起來同步是失敗的，我這邊還沒有成功取得資料的紀錄。'
        + '如果持續這樣，可能要重新授權一次 WHOOP。';

    case SYNC_VERDICT.NEVER_SYNCED:
      return '我這邊還沒有任何同步紀錄，看起來同步從來沒有跑成功過。';

    case SYNC_VERDICT.INCOMPLETE_EVIDENCE:
    default:
      return [
        '目前只能確認部分狀態 —— 我手邊的同步紀錄不完整，沒辦法確定最近一次的結果。',
        result.latest_health_date
          ? `目前最新的健康資料是 ${result.latest_health_date}，但那不保證最近一次同步成功。`
          : null,
      ].filter(Boolean).join('\n');
  }
}

/** 指標 → 對話裡的稱呼。只用核可的標籤，絕不印內部鍵。 */
const METRIC_WORD = {
  sleep_total: '睡眠', sleep_performance: '睡眠表現', recovery: '恢復',
  hrv: 'HRV', rhr: '靜息心率', previous_day_strain: '昨日 Strain',
};
const metricWord = (k) => METRIC_WORD[k] ?? null;

/** 沒有基準的那幾個指標，用人話列出來。 */
function notReadyPhrase(result) {
  const names = (result.not_ready_metrics ?? []).map(metricWord).filter(Boolean);
  return names.length ? names.join('、') : null;
}

/**
 * 「為什麼我這麼累」的回答。
 *
 * ## 三條不可退讓的規則
 *
 * 1. **「沒偵測到偏離」不可以講成「你沒事」。** 使用者說他累，那是一個事實；
 *    系統看不出異常只代表系統看不出來。
 * 2. **成熟度是逐指標的。** 睡眠有基準不代表 Recovery／HRV／靜息心率也有。
 * 3. **時序不明就不要講先後。** 只有日期的紀錄不足以支撐因果順序的說法。
 *
 * ## 長度
 *
 * 目標 3～5 個短段、450 字以內。上一版雖然行數變少了，卻仍然是一份報表：
 * 開場白、指標清單、基準說明、因果限制、時序說明、建議、緊急警語 —— 七個
 * 區塊每次都出現，連「今天有點累」也會收到一段急診指引。
 *
 * 所以這一版把結論放到**第一句**，不確定性只講一次，緊急警語不再自動附加
 * （明確的緊急症狀由 triage 那一層處理，它排在路由最前面）。
 */
export function renderCauseAnswer(result) {
  const out = [];
  const facts = result.facts ?? [];
  const contributors = result.contributors ?? [];
  const comparable = facts.filter((f) => f.comparable);
  const names = contributors.map((c) => c.label).filter(Boolean);

  // ---- 1. 先回答問題本身 ----
  if (names.length) {
    // 用自然的說法（「酒精」而不是「飲酒」），避免跟記錄確認那句重複。
    const noun = contributors.map((c) => mechanismNoun(c.category) ?? c.label)
      .filter(Boolean).join('、');
    out.push(`${noun}確實可能讓人短時間覺得疲倦，不過目前還不能確定這就是主因。`);
  } else {
    out.push('你會覺得累是一個事實，值得看一下 —— 不過我還沒辦法指出原因。');
  }

  // ---- 2. 只講最相關的一兩項觀察 ----
  const highlight = (comparable.filter((f) => f.noteworthy).slice(0, 2).length
    ? comparable.filter((f) => f.noteworthy).slice(0, 2)
    : facts.filter((f) => ['sleep_total', 'recovery'].includes(f.key)).slice(0, 2));
  const parts = [];
  if (highlight.length) {
    parts.push(`今天${highlight
      .map((f) => `${f.label} ${f.display}`
        + (f.comparable && f.baseline_display
          ? `（平常約 ${f.baseline_display}${f.noteworthy ? '，這次偏離比較明顯' : '，差不多'}）`
          : ''))
      .join('、')}。`);
  }

  // ---- 3. 限制只講一次 ----
  const missing = notReadyPhrase(result);
  if (!comparable.length) {
    parts.push(missing
      ? `不過${missing}的個人基準還在累積，我沒辦法判斷這些數字是不是偏離你的常態。`
      : '不過你的個人基準還在累積，我沒辦法判斷這些數字是不是偏離你的常態。');
  } else if (missing) {
    parts.push(`${missing}的基準還在累積，那幾項我暫時不下判斷。`);
  }

  // ---- 4. 時序：只有在確定的時候才講 ----
  if (names.length) {
    if (contributors.some((c) => c.temporal === 'after')) {
      parts.push('而且今天的恢復與 HRV 是在這件事之前量到的，沒辦法用來看它的影響。');
    }
    // 時間不確定就**不講**先後 —— 不需要為此多寫一句解釋。
  }
  if (parts.length) out.push(parts.join(''));

  // ---- 5. 一句可以實際做的事 ----
  out.push(names.length
    ? '先休息、補充水分並觀察。'
    : '先照平常的節奏休息，有變化再跟我說。');
  return out.join('\n\n');
}

/**
 * 「因為數據不夠嗎」的回答。
 *
 * 直接回答，然後用人話講限制 —— 不倒涵蓋率、不倒各資源筆數、不倒
 * capability probe 或 backfill。那些是給維運看的。
 *
 * ⚠️ 不把 MIN_SAMPLES 講成「累積五天就能找出原因」。那個門檻只是**某一個
 * 指標做基本比較**的最低合格樣本數，不是成熟個人化、更不是因果保證。
 */
export function renderReadinessAnswer(result) {
  const out = [];
  const missing = notReadyPhrase(result);
  const need = result.min_samples_needed ?? null;

  if (!result.all_ready) {
    out.push('對，主要是這個。');
    out.push('');
    if (result.has_today_facts) {
      out.push(missing
        ? `今天的數字我看得到，但${missing}還沒有足夠的合格歷史可以建立你的個人基準，`
          + '所以我還不能可靠判斷它們是否偏離你平常的狀態。'
        : '今天的數字我看得到，但合格的歷史還不夠建立你的個人基準。');
    } else {
      out.push('我目前累積到的合格資料還太少，還建立不出你的個人基準。');
    }
    if (result.calibrating) {
      out.push('WHOOP 本身也還在校正期，這段期間的數值不適合當基準。');
    }
    if (Number.isFinite(need)) {
      out.push('');
      out.push(`做最基本的比較，每個指標大約需要 ${need} 筆先前的合格紀錄；`
        + '不同的判斷（趨勢、預測、關聯）需要的更多。');
    }
    out.push('');
    out.push('再累積一段時間會好很多。不過就算歷史足夠，我能給的也是關聯，不是單一原因的證明。');
  } else {
    out.push('不完全是。');
    out.push('');
    out.push('相關指標的基準我都已經建立得起來了。判斷不出來比較可能是因為：'
      + '這件事的答案本來就不在 WHOOP 量得到的範圍裡，或是目前的數字確實沒有明顯偏離。');
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
