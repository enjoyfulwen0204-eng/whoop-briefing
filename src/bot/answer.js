/** Health answers use computed facts and application-owned templates only.
 * Prompt/context exports remain for compatibility; publication never calls them. */

import { AI_PURPOSE } from '../config.js';
import { factsFromQaResult } from '../publishableFacts.js';
import { renderAssertions, assemblePublication } from '../assertionRenderer.js';
import { SYNC_VERDICT } from '../syncTruth.js';
import { renderBriefingStatus } from '../briefingStatus.js';
import { t, formatLocalDate, formatNumber, localizedDisplay } from '../localization.js';

export const ANSWER_SYSTEM_PROMPT = `你是使用者的私人健康教練，語氣溫暖、專業、口語，用繁體中文。

你會收到「程式已經算好」的健康數據結論（平均、標準差、z-score、樣本數、趨勢方向）。

嚴格規則：
- 這些數字已經由程式算好。不要重新計算、不要換算、不要質疑、不要補上沒給你的數字。
- 絕對不要編造任何沒有出現在輸入裡的數值、日期或結論。
- 樣本數少的時候要老實說「資料還不夠多，這只是初步觀察」。
- 你是教練不是醫生：不要診斷疾病，不要用「異常」「不正常」這種醫學字眼。
  要講就講「和你平常比偏低／偏高」。
- 如果輸入說某項資料不可用，就直說目前拿不到，不要猜。
- 回答控制在 120–250 字，重點先講，不要條列一大堆數字（數字使用者看得到）。
- 可以用少量 emoji，不要猜測使用者姓名。
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
export function renderFallback(result, locale = 'zh-TW') {
  if (!result || result.available === false) return t(locale, 'qa.empty');
  return renderLocalizedFallback(result, locale);
}


/** 幾小時前（人話）。時間不可信就回 null，不要編。 */
function agoText(iso, nowIso, locale = 'zh-TW') {
  if (!iso || !nowIso) return null;
  const ms = Date.parse(nowIso) - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return null;
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return t(locale, 'answer.agoMinutes', { value: formatNumber(locale, mins) });
  const hrs = ms / 3_600_000;
  return hrs < 48
    ? t(locale, 'answer.agoHours', { value: formatNumber(locale, hrs, 1) })
    : t(locale, 'answer.agoDays', { value: formatNumber(locale, Math.round(hrs / 24)) });
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
export function renderSyncAnswer(result, locale = 'zh-TW') {
  return renderLocalizedSyncAnswer(result, locale);
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
export function renderCauseAnswer(result, locale = 'zh-TW') {
  return renderLocalizedCauseAnswer(result, locale);
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
export function renderReadinessAnswer(result, locale = 'zh-TW') {
  return renderLocalizedReadinessAnswer(result, locale);
}

const PUBLIC_METRICS = new Set([
  'sleep_total', 'sleep_performance', 'recovery', 'hrv', 'rhr',
  'previous_day_strain', 'deep_sleep', 'rem_sleep', 'respiratory_rate',
  'sleep_debt', 'spo2', 'skin_temp', 'current_hr',
]);
const PUBLIC_FACTORS = new Set([
  'alcohol', 'caffeine', 'stress', 'lateMeal', 'lateSleep', 'sickness',
  'travel', 'exercise', 'sauna', 'supplement', 'medication', 'flight',
  'location', 'massage', 'food', 'custom',
]);
const factorAlias = { late_meal:'lateMeal', late_sleep:'lateSleep', exercise_note:'exercise' };
const metricText = (locale, key) => t(locale,
  PUBLIC_METRICS.has(key) ? `answer.metric.${key}` : 'answer.metricUnknown');
const factorText = (locale, key) => {
  const normalized = factorAlias[key] ?? key;
  return t(locale, `factor.${PUBLIC_FACTORS.has(normalized) ? normalized : 'custom'}`);
};
const numberOrDash = (locale, value, digits = 0) => Number.isFinite(Number(value))
  ? formatNumber(locale, Number(value), digits) : '—';
const displayOrNa = (locale, value) => value == null ? t(locale, 'answer.na') : localizedDisplay(locale, value);

function renderLocalizedFallback(result, locale) {
  const lines = [];
  switch (result.intent) {
    case 'cause_query': return renderLocalizedCauseAnswer(result, locale);
    case 'sync_status': return renderLocalizedSyncAnswer(result, locale);
    case 'briefing_status':
      return renderBriefingStatus({ status: result.briefing_status, evidence: result.evidence, locale });
    case 'readiness_query': return renderLocalizedReadinessAnswer(result, locale);
    case 'today_status':
      lines.push(t(locale, 'answer.todayTitle', { date: formatLocalDate(result.health_date, locale) }));
      for (const [key, m] of Object.entries(result.metrics ?? {})) {
        const metric = metricText(locale, key);
        if (m.value == null) { lines.push(t(locale, 'answer.metricMissing', { metric })); continue; }
        const baseline = m.baseline_display
          ? t(locale, 'answer.baseline', { value: localizedDisplay(locale, m.baseline_display) }) : '';
        const z = m.z_score == null ? '' : ` z=${numberOrDash(locale, m.z_score, 1)}`;
        lines.push(t(locale, 'answer.metricValue', { metric, value: `${localizedDisplay(locale, m.display)}${baseline}${z}` }));
      }
      break;
    case 'trend_query': {
      const w = result.window ?? {};
      lines.push(t(locale, 'answer.trendTitle', { metric: metricText(locale, result.metric) }));
      lines.push(t(locale, 'answer.current', { value: displayOrNa(locale, result.current_display) }));
      if (result.analysis_limited === 'calibrating') lines.push(t(locale, 'answer.calibrating'));
      else if (result.analysis_limited === 'insufficient_history') lines.push(t(locale, 'answer.insufficientHistory'));
      else {
        lines.push(t(locale, 'answer.windowMean', {
          days: numberOrDash(locale, w.window_days), mean: displayOrNa(locale, w.mean_display),
          count: numberOrDash(locale, w.n),
        }));
        for (const [window, trend] of Object.entries(result.trends ?? {})) {
          const direction = ['IMPROVING','STABLE','DECLINING','INSUFFICIENT_DATA'].includes(trend.direction)
            ? trend.direction : 'INSUFFICIENT_DATA';
          lines.push(t(locale, 'answer.trendLine', {
            days: window.replace(/d$/, ''), direction: t(locale, `answer.trend.${direction}`),
          }));
        }
      }
      break;
    }
    case 'best_worst_day':
      lines.push(t(locale, 'answer.bestTitle', {
        metric: metricText(locale, result.metric), days: numberOrDash(locale, result.window_days),
        count: numberOrDash(locale, result.n),
      }));
      lines.push(t(locale, 'answer.best', {
        date: formatLocalDate(result.best.health_date, locale), value: localizedDisplay(locale, result.best.display),
      }));
      if (result.worst) lines.push(t(locale, 'answer.worst', {
        date: formatLocalDate(result.worst.health_date, locale), value: localizedDisplay(locale, result.worst.display),
      }));
      break;
    case 'what_changed':
      if (!result.items?.length) return t(locale, 'answer.noChanges');
      lines.push(t(locale, 'answer.changesTitle'));
      for (const item of result.items) lines.push(t(locale, 'answer.changeLine', {
        metric: metricText(locale, item.metric), value: localizedDisplay(locale, item.current_display),
      }));
      break;
    case 'sleep_quality':
      lines.push(t(locale, 'answer.sleepTitle', { days: numberOrDash(locale, result.window_days) }));
      for (const [key, m] of Object.entries(result.metrics ?? {})) {
        if (!m.available) continue;
        lines.push(t(locale, 'answer.sleepLine', {
          metric: metricText(locale, key), current: displayOrNa(locale, m.current_display),
          mean: displayOrNa(locale, m.mean_display), count: numberOrDash(locale, m.n),
        }));
      }
      break;
    default: return t(locale, 'answer.unable');
  }
  return lines.join('\n');
}

function renderLocalizedSyncAnswer(result, locale) {
  const ago = agoText(result.last_success_at, result.now, locale);
  const parentheticAgo = ago ? ` (${ago})` : '';
  const latest = result.latest_health_date
    ? t(locale, 'answer.latestDate', { date: formatLocalDate(result.latest_health_date, locale) }) : null;
  if (result.no_new_data) return [
    t(locale, 'answer.sync.noNewData', { ago: parentheticAgo }),
    t(locale, 'answer.sync.scoreWait'), latest,
  ].filter(Boolean).join('\n');
  let parts;
  switch (result.verdict) {
    case SYNC_VERDICT.LATEST_SUCCESS_COMPLETE:
      parts = [t(locale, 'answer.sync.complete', {
        ago: ago ?? t(locale, 'answer.timeUnknown'),
      }), latest];
      break;
    case SYNC_VERDICT.LATEST_SUCCESS_PARTIAL:
      parts = [t(locale, 'answer.sync.partial', { ago: parentheticAgo }), latest];
      break;
    case SYNC_VERDICT.HISTORICAL_SUCCESS_LATEST_FAILED:
      parts = [t(locale, 'answer.sync.historicalFailure', { ago: parentheticAgo }),
        t(locale, 'answer.sync.retryAuth'), latest];
      break;
    case SYNC_VERDICT.STALE_SUCCESS:
      parts = [t(locale, 'answer.sync.stale', { ago: parentheticAgo }),
        t(locale, 'answer.sync.staleAdvice'), latest];
      break;
    case SYNC_VERDICT.LATEST_FAILED: parts = [t(locale, 'answer.sync.failed')]; break;
    case SYNC_VERDICT.NEVER_SYNCED: parts = [t(locale, 'answer.sync.never')]; break;
    default:
      parts = [t(locale, 'answer.sync.incomplete'),
        result.latest_health_date ? t(locale, 'answer.latestDateCaveat', {
          date: formatLocalDate(result.latest_health_date, locale),
        }) : null];
  }
  return parts.filter(Boolean).join('\n');
}

function renderLocalizedCauseAnswer(result, locale) {
  const facts = result.facts ?? [];
  const contributors = result.contributors ?? [];
  const comparable = facts.filter(f => f.comparable);
  const named = contributors.length > 0;
  const out = [named ? t(locale, 'answer.causeWithFactor', {
    factor: contributors.map(c => factorText(locale, c.category)).join(', '),
  }) : t(locale, 'answer.causeUnknown')];
  const noteworthy = comparable.filter(f => f.noteworthy).slice(0, 2);
  const highlight = noteworthy.length ? noteworthy
    : facts.filter(f => ['sleep_total','recovery'].includes(f.key)).slice(0, 2);
  const parts = [];
  if (highlight.length) parts.push(t(locale, 'answer.causeToday', {
    observations: highlight.map(f => t(locale, 'answer.causeObservation', {
      metric: metricText(locale, f.key), value: localizedDisplay(locale, f.display),
      baseline: f.comparable && f.baseline_display
        ? t(locale, f.noteworthy ? 'answer.causeBaselineNoteworthy' : 'answer.causeBaselineSimilar',
          { value: localizedDisplay(locale, f.baseline_display) }) : '',
    })).join(', '),
  }));
  const missing = (result.not_ready_metrics ?? []).filter(k => PUBLIC_METRICS.has(k))
    .map(k => metricText(locale, k)).join(', ');
  if (!comparable.length) parts.push(t(locale,
    missing ? 'answer.causeNoBaselineNamed' : 'answer.causeNoBaseline', { metrics: missing }));
  else if (missing) parts.push(t(locale, 'answer.causeSomeBaseline', { metrics: missing }));
  if (named && contributors.some(c => c.temporal === 'after'))
    parts.push(t(locale, 'answer.causeTiming'));
  if (parts.length) out.push(parts.join(' '));
  out.push(t(locale, named ? 'answer.causeAdviceWithFactor' : 'answer.causeAdvice'));
  return out.join('\n\n');
}

function renderLocalizedReadinessAnswer(result, locale) {
  if (result.all_ready) return [
    t(locale, 'answer.readinessNo'), t(locale, 'answer.readinessOther'),
  ].join('\n\n');
  const missing = (result.not_ready_metrics ?? []).filter(k => PUBLIC_METRICS.has(k))
    .map(k => metricText(locale, k)).join(', ');
  const out = [t(locale, 'answer.readinessYes')];
  out.push(t(locale, result.has_today_facts
    ? missing ? 'answer.readinessTodayNamed' : 'answer.readinessToday'
    : 'answer.readinessNoFacts', { metrics: missing }));
  if (result.calibrating) out.push(t(locale, 'answer.readinessCalibrating'));
  if (Number.isFinite(result.min_samples_needed)) out.push(t(locale, 'answer.readinessNeed', {
    count: formatNumber(locale, result.min_samples_needed),
  }));
  out.push(t(locale, 'answer.readinessCaveat'));
  return out.join('\n\n');
}

/** structured result → 最終要送出去的文字。 */
/** Render the computed result without invoking or appending provider prose.
 * Trend templates preserve computed windows/sample counts in addition to values. */
export async function composeAnswer({ question, result, coach, purpose = AI_PURPOSE.QA, locale = 'zh-TW' }) {
  if (!result || result.available === false) return renderFallback(result, locale);

  // 1) 確定性斷言 —— 這一段永遠存在，而且與 LLM 無關
  const factSet = factsFromQaResult(result);
  const { lines, unavailable } = renderAssertions(factSet, locale);
  const header = result.health_date ? t(locale, 'qa.header',
    { date: formatLocalDate(result.health_date, locale) }) : null;

  // 事實集算不出任何東西時，退回既有的確定性排版（它涵蓋 trend/best-worst
  // 等 factsFromQaResult 不建模的 intent）。
  const deterministic = lines.length && result.intent !== 'trend_query'
    ? assemblePublication({ header, assertionLines: lines, unavailable, locale })
    : renderFallback(result, locale);

  // Provider prose has no publication authority, including optional explanations.
  return deterministic;
}
