/**
 * Telegram 訊息組裝（plain text，不用 Markdown，避免 escaping 出包）。
 * 上半數據、下半教練的話。單則不超過 4096 字元。
 */

import { BASELINE, TELEGRAM_MAX_CHARS, TREND } from './config.js';
import { INSIGHT_LABELS } from './insights.js';
import { prettyDate } from './time.js';
import { safeDisplayName } from './displayName.js';
import { t, formatLocalDate, formatNumber, localizedDisplay } from './localization.js';

const LIGHT = { green: '🟢', yellow: '🟡', red: '🔴⚠️' };

/**
 * ⚠️ 舊的「AI 教練分析今天暫時無法生成」已經移除。
 *
 * 正式環境把教練關掉之後，那句話每天都出現 —— 而它是**假的**：根本沒有
 * 嘗試生成過。使用者每天被告知一個不存在的故障。現在敘述一定存在
 * （模型或確定性版本），呼叫端不會再傳 null 進來；真的傳了就整段省略，
 * 絕不宣稱故障。
 */
const FALLBACK_NOTE = null;

// 教練文字的硬上限。system prompt 已經要求 80–180 字（週回顧 150–300），
// 這是防止模型失控時把訊息撐爆的保險 —— 數據永遠不會被裁掉。
const COACH_MAX_CHARS = { daily: 900, weekly: 1400 };

/**
 * 安全截斷 —— **全系統唯一一份**。
 *
 * JS 的 slice 是以 UTF-16 code unit 為單位，直接切會把 emoji 的 surrogate pair
 * 剖成兩半，產生落單的 surrogate（在 Telegram 上顯示成 �）。
 * 這裡把切壞的尾巴修掉：
 *   1. 尾端是落單的 high surrogate → 丟掉
 *   2. 尾端是 ZWJ / variation selector → 丟掉（否則 👩‍💻 會斷成「👩‍」）
 */
export function safeSlice(text, end) {
  if (end <= 0) return '';
  if (end >= text.length) return text;
  let cut = text.slice(0, end);
  // 落單的 high surrogate（pair 的前半被留下、後半被切掉）
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  // 懸空的組合字元：ZWJ(U+200D) 與 variation selector(U+FE0E/U+FE0F)
  while (cut.length) {
    const c = cut.codePointAt(cut.length - 1);
    if (c === 0x200d || c === 0xfe0e || c === 0xfe0f) cut = cut.slice(0, -1);
    else break;
  }
  return cut;
}

/** 超長時在句子邊界收尾，不留半句話。 */
function capCoachText(text, max) {
  if (!text) return null;
  const t = text.trim();
  if (t.length <= max) return t;
  const cut = safeSlice(t, max);
  const lastStop = Math.max(
    cut.lastIndexOf('。'), cut.lastIndexOf('！'), cut.lastIndexOf('？'), cut.lastIndexOf('\n'),
  );
  return lastStop > max * 0.5 ? cut.slice(0, lastStop + 1) : `${cut}…`;
}

export function lightOf(severity) {
  return severity ? LIGHT[severity] : '';
}

function stageSuffix(stage, sampleCount, locale) {
  if (stage === 'cold') return t(locale, 'daily.stageCold');
  if (stage === 'provisional') return t(locale, 'daily.stageProvisional',
    { count: sampleCount, target: BASELINE.TARGET_SAMPLES });
  return '';
}

const metricName = (locale, key) => t(locale, `metric.${key}`);

/** 一行指標：`❤️ HRV 42ms（基準 55ms）🟡` */
function metricLine(m, stage, locale) {
  const values = { emoji: m.emoji, metric: metricName(locale, m.key), value: localizedDisplay(locale, m.display) };
  if (!m.available) return t(locale, 'daily.metricMissing', values);
  // 冷啟動（<7 筆）：只顯示數據，不顯示還不可信的基準、也不給燈
  if (stage === 'cold') return t(locale, 'daily.metricCold', values);
  const baseline = m.baselineDisplay ? t(locale, 'daily.baseline', { value: localizedDisplay(locale, m.baselineDisplay) })
    : t(locale, 'daily.baselinePending');
  return t(locale, 'daily.metricReady', { ...values, baseline, light: lightOf(m.severity) });
}

/**
 * 組每日簡報。
 * @param {object} briefing analyze 算好的結果
 * @param {string|null} coachText AI 教練的文字；null = 模型掛了走 fallback
 */
export function renderDaily(briefing, coachText, { displayName = '', locale = 'zh-TW' } = {}) {
  const { stage, sampleCount, metrics, trends } = briefing;
  // 顯示日期一律是 health_date（主睡眠結束那天），不是執行當下的日期
  const reportDate = briefing.healthDate ?? briefing.localDate;
  const byKey = Object.fromEntries(metrics.map((m) => [m.key, m]));
  const recovery = byKey.recovery_score;

  const lines = [];
  const name = safeDisplayName(displayName);
  lines.push(name ? t(locale, 'daily.greetingNamed', { name }) : t(locale, 'daily.greetingNeutral'));

  if (recovery?.available) {
    lines.push(t(locale, 'daily.recoveryValue', { value: localizedDisplay(locale, recovery.display),
      light: lightOf(recovery.severity), stage: stageSuffix(stage, sampleCount, locale) }));
  } else {
    lines.push(t(locale, 'daily.recoveryMissing', { stage: stageSuffix(stage, sampleCount, locale) }));
  }

  lines.push('');
  lines.push(t(locale, stage === 'cold' ? 'daily.headerCold' : 'daily.headerWarm'));

  // WHOOP 校正期：數值照顯示，但不給燈（跟 cold stage 同樣的原則），要說清楚為什麼
  if (metrics.some((m) => m.calibrating && m.available)) {
    lines.push(t(locale, 'daily.calibrating'));
  }

  const order = [
    'hrv', 'rhr', 'respiratory_rate',
    'sleep_total', 'slow_wave', 'rem', 'sleep_performance', 'sleep_debt',
    'sleep_consistency', 'sleep_efficiency', 'disturbance_count',
    'spo2', 'skin_temp',
    'strain',
  ];
  for (const key of order) {
    const m = byKey[key];
    if (!m) continue;
    // optional 指標：這個帳號沒回傳就整行不顯示
    if (m.tier === 'optional' && !m.available) continue;
    lines.push(metricLine(m, stage, locale));
  }

  const trendLines = renderTrendLines(trends, locale);
  if (trendLines.length) {
    lines.push('');
    lines.push(...trendLines);
  }

  // 「今天最值得注意」—— 由 Node 算好排序的 top 2~3 項（見 analytics/whatChanged.js）。
  // briefing.whatChanged 不存在時整段不出現，簡報與以前一模一樣。
  const changeLines = renderWhatChanged(briefing.whatChanged, locale);
  if (changeLines.length) {
    lines.push('');
    lines.push(...changeLines);
  }

  lines.push('—');
  // 模型掛掉時 coachText 是 null → 照樣發數據簡報，底下加上 fallback 說明
  const dailyNarrative = capCoachText(coachText, COACH_MAX_CHARS.daily) ?? FALLBACK_NOTE;
  if (dailyNarrative) lines.push(dailyNarrative);

  lines.push('');
  lines.push(footer(stage, sampleCount, reportDate, locale));

  return clamp(lines.join('\n'));
}

const MAX_TREND_LINES = 3;

function renderTrendLines(trends, locale) {
  if (!trends?.enabled || !trends.alerts?.length) return [];
  const head = t(locale, trends.level === 'strong' ? 'daily.trendHeadStrong' : 'daily.trendHead');
  const lines = [head];
  // 紅的排前面，最多列 3 項，避免訊息變成長篇報表
  const sorted = [...trends.alerts].sort(
    (a, b) => (b.latestSeverity === 'red' ? 1 : 0) - (a.latestSeverity === 'red' ? 1 : 0),
  );
  for (const a of sorted.slice(0, MAX_TREND_LINES)) {
    const kind = a.types.includes('worsening') && a.types.includes('sustained_low')
      ? t(locale, 'daily.trendBoth')
      // streakFor 保證這 3 天是逐日相鄰的健康日，所以「連續 N 天」是準確的說法
      : (a.types.includes('worsening') ? t(locale, 'daily.trendWorsening')
        : t(locale, 'daily.trendSustained', { days: TREND.WINDOW }));
    lines.push(t(locale, 'daily.trendLine', { metric: metricName(locale, a.key),
      kind, series: a.series.map((p) => localizedDisplay(locale, p.display)).join(' → ') }));
  }
  if (sorted.length > MAX_TREND_LINES) {
    lines.push(t(locale, 'daily.trendMore', { count: sorted.length - MAX_TREND_LINES }));
  }
  return lines;
}

/** 簡報上限 2 行，避免訊息變成長篇報表。 */
const MAX_CHANGE_LINES = 2;

/**
 * 「今天最值得注意」。排序與挑選都已經由 Node 做完，這裡只負責排版。
 * 刻意用「偏離平常」而不是「異常」—— 這是拿自己的歷史當基準的統計描述。
 */
function renderWhatChanged(whatChanged, locale) {
  if (!Array.isArray(whatChanged) || !whatChanged.length) return [];
  const lines = [t(locale, 'daily.changeHead')];
  for (const c of whatChanged.slice(0, MAX_CHANGE_LINES)) {
    const meta = INSIGHT_LABELS[c.metric];
    if (!meta || c.current === null || c.current === undefined) continue;
    const values = { emoji: meta.emoji, metric: metricName(locale, c.metric), value: localizedDisplay(locale, meta.fmt(c.current)),
      zscore: c.z_score !== null ? `, z=${formatNumber(locale, c.z_score, 1)}` : '' };
    if (c.vs_30d_pct !== null) {
      values.comparison = t(locale, c.vs_30d_pct >= 0 ? 'daily.changeAbove' : 'daily.changeBelow',
        { percent: formatNumber(locale, Math.abs(c.vs_30d_pct)) });
    }
    lines.push(t(locale, c.vs_30d_pct !== null ? 'daily.changeLine' : 'daily.changeLineSimple', values));
  }
  return lines.length > 1 ? lines : [];
}

function footer(stage, sampleCount, reportDate, locale) {
  return t(locale, 'daily.footer', { date: formatLocalDate(reportDate, locale),
    count: stage === 'full' ? BASELINE.TARGET_SAMPLES : sampleCount,
    target: BASELINE.TARGET_SAMPLES });
}

/** 組每週回顧。 */
export function renderWeekly(weekly, coachText, { displayName = '', locale = 'zh-TW' } = {}) {
  const { last, prev, wow } = weekly;
  const lines = [];
  const name = safeDisplayName(displayName);
  lines.push(name ? t(locale, 'weekly.titleNamed', { name }) : t(locale, 'weekly.titleNeutral'));
  lines.push(t(locale, 'weekly.range', { start: formatLocalDate(last.startDate, locale),
    end: formatLocalDate(last.endDate, locale), days: last.days }));
  lines.push('');

  const rows = [
    ['💪', 'recovery_score'],
    ['📈', 'sleep_performance'],
    ['🌙', 'sleep_total'],
    ['⏳', 'sleep_debt'],
    ['❤️', 'hrv'],
    ['💓', 'rhr'],
  ];
  for (const [, key] of rows) {
    const a = last.averages[key];
    const metric = t(locale, `weekly.label.${key}`);
    if (!a || a.mean === null) {
      lines.push(t(locale, 'weekly.metricMissing', { metric }));
      continue;
    }
    lines.push(t(locale, 'weekly.metricValue', { metric, value: localizedDisplay(locale, a.display),
      comparison: wowSuffix(wow[key], key, locale) }));
  }

  lines.push('');
  if (last.best) lines.push(t(locale, 'weekly.best', { date: formatLocalDate(last.best.date, locale), value: localizedDisplay(locale, last.best.display) }));
  if (last.worst) lines.push(t(locale, 'weekly.worst', { date: formatLocalDate(last.worst.date, locale), value: localizedDisplay(locale, last.worst.display) }));
  if (prev.days === 0) lines.push(t(locale, 'weekly.noPrevious'));

  lines.push('—');
  const weeklyNarrative = capCoachText(coachText, COACH_MAX_CHARS.weekly) ?? FALLBACK_NOTE;
  if (weeklyNarrative) lines.push(weeklyNarrative);
  return clamp(lines.join('\n'));
}

function wowSuffix(w, key, locale) {
  if (!w || w.delta === null) return t(locale, 'weekly.noComparison');
  // 前週平均為 0 → 算不出百分比。以前會走到下面用 Math.abs(null) 印出「比前週 0%」，
  // 明明有變化卻顯示 0，比不顯示還糟。
  if (w.pct === null && key !== 'sleep_debt' && key !== 'sleep_total') {
    if (w.direction === 'flat') return t(locale, 'weekly.flat');
    return t(locale, w.direction === 'up' ? 'weekly.aboveZero' : 'weekly.belowZero');
  }
  // 時間類指標用分鐘講，比百分比直觀（睡眠債基準小，百分比會失真）
  if (key === 'sleep_debt' || key === 'sleep_total') {
    const min = Math.round(w.delta / 60000);
    if (Math.abs(min) < 10) return t(locale, 'weekly.flat');
    return t(locale, min > 0 ? 'weekly.moreMinutes' : 'weekly.fewerMinutes',
      { minutes: formatNumber(locale, Math.abs(min)) });
  }
  if (w.direction === 'flat') return t(locale, 'weekly.flat');
  const arrow = w.direction === 'up' ? '↑' : '↓';
  return t(locale, 'weekly.percentChange', { arrow,
    percent: formatNumber(locale, Math.abs(w.pct)) });
}

function fmtRange(a, b) {
  return `${prettyDate(a)} ～ ${prettyDate(b)}`;
}

/**
 * Telegram 長度收斂 —— **全系統唯一一份**。
 *
 * format.js 與 telegram.js 以前各有一份一模一樣的實作，行為很容易漂移。
 * 現在組訊息與發送前都呼叫這一個；發送層再另外做一次 assertion 當防線。
 *
 * 從尾端裁（數據在訊息前半，永遠保留；被犧牲的一定是教練文字）。
 */
export function clamp(text, max = TELEGRAM_MAX_CHARS) {
  if (text.length <= max) return text;
  // safeSlice 可能會少切 1 個 code unit（修掉半個 emoji），所以結果一定 <= max
  return `${safeSlice(text, max - 3)}...`;
}

export { FALLBACK_NOTE };
