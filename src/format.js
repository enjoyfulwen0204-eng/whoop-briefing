/**
 * Telegram 訊息組裝（plain text，不用 Markdown，避免 escaping 出包）。
 * 上半數據、下半教練的話。單則不超過 4096 字元。
 */

import { BASELINE, TELEGRAM_MAX_CHARS, TREND } from './config.js';
import { prettyDate } from './time.js';

const LIGHT = { green: '🟢', yellow: '🟡', red: '🔴⚠️' };

const FALLBACK_NOTE = '⚠️ AI 教練分析今天暫時無法生成，數據簡報仍正常';

// 教練文字的硬上限。system prompt 已經要求 80–180 字（週回顧 150–300），
// 這是防止模型失控時把訊息撐爆的保險 —— 數據永遠不會被裁掉。
const COACH_MAX_CHARS = { daily: 900, weekly: 1400 };

/** 超長時在句子邊界收尾，不留半句話。 */
function capCoachText(text, max) {
  if (!text) return null;
  const t = text.trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const lastStop = Math.max(
    cut.lastIndexOf('。'), cut.lastIndexOf('！'), cut.lastIndexOf('？'), cut.lastIndexOf('\n'),
  );
  return lastStop > max * 0.5 ? cut.slice(0, lastStop + 1) : `${cut}…`;
}

export function lightOf(severity) {
  return severity ? LIGHT[severity] : '';
}

function stageSuffix(stage, sampleCount) {
  if (stage === 'cold') return '（個人基準建立中）';
  if (stage === 'provisional') return `（基準建立中 ${sampleCount}/${BASELINE.TARGET_SAMPLES}）`;
  return '';
}

/** 一行指標：`❤️ HRV 42ms（基準 55ms）🟡` */
function metricLine(m, stage) {
  if (!m.available) return `${m.emoji} ${m.label} 無資料`;
  // 冷啟動（<7 筆）：只顯示數據，不顯示還不可信的基準、也不給燈
  if (stage === 'cold') return `${m.emoji} ${m.label} ${m.display}`;
  const base = m.baselineDisplay ? `（基準 ${m.baselineDisplay}）` : '（基準建立中）';
  return `${m.emoji} ${m.label} ${m.display}${base}${lightOf(m.severity)}`;
}

/**
 * 組每日簡報。
 * @param {object} briefing analyze 算好的結果
 * @param {string|null} coachText AI 教練的文字；null = 模型掛了走 fallback
 */
export function renderDaily(briefing, coachText) {
  const { stage, sampleCount, metrics, trends } = briefing;
  // 顯示日期一律是 health_date（主睡眠結束那天），不是執行當下的日期
  const reportDate = briefing.healthDate ?? briefing.localDate;
  const byKey = Object.fromEntries(metrics.map((m) => [m.key, m]));
  const recovery = byKey.recovery_score;

  const lines = [];
  lines.push('🌅 早安，Kelvin');

  if (recovery?.available) {
    lines.push(`恢復 ${recovery.display}${lightOf(recovery.severity)}${stageSuffix(stage, sampleCount)}`);
  } else {
    lines.push(`恢復 無資料${stageSuffix(stage, sampleCount)}`);
  }

  lines.push('');
  lines.push(stage === 'cold' ? '📊 今日指標' : '📊 指標 vs 你的基準');

  // WHOOP 校正期：數值照顯示，但不給燈（跟 cold stage 同樣的原則），要說清楚為什麼
  if (metrics.some((m) => m.calibrating && m.available)) {
    lines.push('ℹ️ WHOOP 恢復數據還在校正中，恢復類指標今天只顯示數值、不做好壞判斷');
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
    lines.push(metricLine(m, stage));
  }

  const trendLines = renderTrendLines(trends);
  if (trendLines.length) {
    lines.push('');
    lines.push(...trendLines);
  }

  lines.push('—');
  // 模型掛掉時 coachText 是 null → 照樣發數據簡報，底下加上 fallback 說明
  lines.push(capCoachText(coachText, COACH_MAX_CHARS.daily) ?? FALLBACK_NOTE);

  lines.push('');
  lines.push(footer(stage, sampleCount, reportDate));

  return clamp(lines.join('\n'));
}

const MAX_TREND_LINES = 3;

function renderTrendLines(trends) {
  if (!trends?.enabled || !trends.alerts?.length) return [];
  const head = trends.level === 'strong' ? '📉 趨勢提醒（多項生理訊號同時偏離）' : '📉 趨勢提醒';
  const lines = [head];
  // 紅的排前面，最多列 3 項，避免訊息變成長篇報表
  const sorted = [...trends.alerts].sort(
    (a, b) => (b.latestSeverity === 'red' ? 1 : 0) - (a.latestSeverity === 'red' ? 1 : 0),
  );
  for (const a of sorted.slice(0, MAX_TREND_LINES)) {
    const kind = a.types.includes('worsening') && a.types.includes('sustained_low')
      ? '連續偏離且逐日變差'
      // streakFor 保證這 3 天是逐日相鄰的健康日，所以「連續 N 天」是準確的說法
      : (a.types.includes('worsening') ? '逐日變差' : `連續 ${TREND.WINDOW} 天偏離基準`);
    lines.push(`· ${a.label} ${kind}：${a.series.map((p) => p.display).join(' → ')}`);
  }
  if (sorted.length > MAX_TREND_LINES) {
    lines.push(`· 另有 ${sorted.length - MAX_TREND_LINES} 項指標也在偏離`);
  }
  return lines;
}

function footer(stage, sampleCount, reportDate) {
  const n = stage === 'full'
    ? `基準 ${BASELINE.TARGET_SAMPLES}/${BASELINE.TARGET_SAMPLES} 筆`
    : `基準 ${sampleCount}/${BASELINE.TARGET_SAMPLES} 筆`;
  return `${prettyDate(reportDate)} · ${n}`;
}

/** 組每週回顧。 */
export function renderWeekly(weekly, coachText) {
  const { last, prev, wow } = weekly;
  const lines = [];
  lines.push('📅 上週回顧（Kelvin）');
  lines.push(`${fmtRange(last.startDate, last.endDate)} · 有效 ${last.days} 天`);
  lines.push('');

  const rows = [
    ['💪 恢復平均', 'recovery_score'],
    ['📈 睡眠表現', 'sleep_performance'],
    ['🌙 睡眠時長', 'sleep_total'],
    ['⏳ 睡眠債加成', 'sleep_debt'],
    ['❤️ HRV', 'hrv'],
    ['💓 靜息心率', 'rhr'],
  ];
  for (const [label, key] of rows) {
    const a = last.averages[key];
    if (!a || a.mean === null) {
      lines.push(`${label} 無資料`);
      continue;
    }
    lines.push(`${label} ${a.display}${wowSuffix(wow[key], key)}`);
  }

  lines.push('');
  if (last.best) lines.push(`🏆 最好的一天 ${prettyDate(last.best.date)} 恢復 ${last.best.display}`);
  if (last.worst) lines.push(`🥀 最差的一天 ${prettyDate(last.worst.date)} 恢復 ${last.worst.display}`);
  if (prev.days === 0) lines.push('（前一週沒有足夠資料，這次先不比較）');

  lines.push('—');
  lines.push(capCoachText(coachText, COACH_MAX_CHARS.weekly) ?? FALLBACK_NOTE);
  return clamp(lines.join('\n'));
}

function wowSuffix(w, key) {
  if (!w || w.delta === null) return '（前週無資料可比）';
  // 時間類指標用分鐘講，比百分比直觀（睡眠債基準小，百分比會失真）
  if (key === 'sleep_debt' || key === 'sleep_total') {
    const min = Math.round(w.delta / 60000);
    if (Math.abs(min) < 10) return '（與前週差不多）';
    return `（比前週${min > 0 ? '多' : '少'} ${Math.abs(min)} 分）`;
  }
  if (w.direction === 'flat') return '（與前週差不多）';
  const arrow = w.direction === 'up' ? '↑' : '↓';
  return `（${arrow} 比前週 ${Math.abs(w.pct).toFixed(0)}%）`;
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
  return `${text.slice(0, max - 3)}...`;
}

export { FALLBACK_NOTE };
