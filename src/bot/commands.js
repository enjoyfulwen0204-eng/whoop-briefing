/**
 * 指令處理。
 *
 * 全部是確定性的 —— 指令不需要也不應該經過 LLM。
 * 只有 /log 的自然語言變體會用到 LLM，而那也只做「語言 → 結構化提案」。
 */

import { buildDataQualityReport, renderDataQuality, renderMissingScopes } from '../dataQuality.js';
import { parseLogCommand, saveEvent, describeEvent, labelForCategory, CATEGORIES } from '../journal.js';
import { costSummary, renderCost } from '../usage.js';
import { getEvidence, renderEvidence } from '../evidence.js';
import { scorecard } from '../prediction.js';
import { PREDICTION_MATURITY } from '../predictionPolicy.js';
import { buildPersonalHealthspan, renderPersonalHealthspan } from '../healthspanEngine.js';
import { INSIGHT_STATUS } from '../healthMemory.js';
import { assessPrediction, assessProactiveMonitoring, READINESS_STATUS } from '../readiness.js';
import { deriveColdStartStage, COLD_START_STAGE } from '../proactiveMessages.js';
import { READINESS_HEURISTICS } from '../config.js';
import { addDays, localDate } from '../time.js';
import { seriesOf } from '../dailyMetrics.js';
import { log } from '../logger.js';
import { t, formatLocalDate, formatNumber } from '../localization.js';
import { renderValidationFailure } from '../validationMessages.js';

/**
 * /help —— **動態**列出目前真的能用的功能。
 *
 * 刻意不把「還沒有資料的分析」講得像已經有結論。
 * 沒有 WHOOP 資料時，健康問答那一區會明講「目前還不能用」。
 */
export function buildHelp({ report, insightCount = 0, predictionReady = false, locale = 'zh-TW' }) {
  const hasData = report?.has_any_health_data;
  const line = key => t(locale, `bot.help.${key}`);
  const lines = [line('title'), ''];

  for (const key of ['now','log','logNatural','journal','healthdata','status','cost','experiment','help'])
    lines.push(line(key));
  lines.push('');

  if (hasData) {
    for (const key of ['questions','q1','q2','q3','q4','q5']) lines.push(line(key));
    lines.push('');
  } else {
    lines.push(line('noData'), line('noQa'));
    lines.push('');
  }

  lines.push(line('longTerm'));
  lines.push(t(locale, 'bot.help.insights', { suffix: insightCount > 0
    ? t(locale, 'bot.help.insightsCount', { count: formatNumber(locale, insightCount) })
    : line('insightsEmpty') }));
  lines.push(t(locale, 'bot.help.predictions', {
    suffix: predictionReady ? '' : line('predictionsUnready'),
  }));
  lines.push(line('healthspan'), line('evidence'));

  return lines.join('\n');
}

/** 保留舊常數給既有測試與呼叫端（靜態版本）。 */
export const HELP_TEXT = buildHelp({ report: { has_any_health_data: false } });

export function startText(report, locale = 'zh-TW') {
  const line = key => t(locale, `bot.start.${key}`);
  const lines = [line('title'), ''];
  if (!report.has_any_health_data) {
    lines.push(line('noData'), line('wait'));
    lines.push('');
    for (const key of ['available','log','healthdata','help']) lines.push(line(key));
  } else {
    lines.push(t(locale, 'bot.start.data', {
      days: formatNumber(locale, report.sleep_count),
      from: formatLocalDate(report.history_start, locale),
      to: formatLocalDate(report.history_end, locale),
    }));
    lines.push('');
    lines.push(line('ask'));
  }
  return lines.join('\n');
}

/**
 * /log 處理。
 * 先試確定性解析；失敗且有 coach 時，再讓 LLM 提案（仍要過 validate）。
 */
export async function handleLog({ db, userId, argsText, rawText, timezone, now, coach, parseNatural, locale = 'zh-TW' }) {
  const parsed = parseLogCommand(`/log ${argsText}`, { now, timezone });

  if (parsed.ok) {
    const saved = await saveEvent(db, userId, parsed.event, { now, timezone });
    if (!saved.ok) return renderValidationFailure(locale, saved.errors);
    return t(locale, 'router.saved', { event: describeEvent(saved.event, locale) });
  }

  // 確定性解析失敗 → 試自然語言
  if (parseNatural && argsText) {
    const nat = await parseNatural({ text: argsText, now, timezone, coach });
    if (nat.ok) {
      const saved = await saveEvent(db, userId, nat.event, { now, timezone });
      if (saved.ok) return t(locale, 'router.saved', { event: describeEvent(saved.event, locale) });
      return renderValidationFailure(locale, saved.errors);
    }
  }

  // 欄位名刻意不叫 token —— logger 的遮蔽清單把 'token' 當機密，
  // 用那個名字會讓這行 debug 資訊被 [REDACTED] 掉，等於白記。
  log.info('log_command_unparsed', { error: parsed.error, unknown_word: parsed.token });
  if (parsed.error === 'unknown_category') return renderValidationFailure(locale, parsed.error);
  return t(locale, 'bot.log.unparsed', {
    input: argsText || '—', categories: CATEGORIES.join(', '),
  });
}

/** /healthdata */
export async function handleHealthData({ db, userId, timezone, now, locale = 'zh-TW' }) {
  const report = await buildDataQualityReport({ db, userId, timezone, now });
  return renderDataQuality(report, locale);
}


// ---------------------------------------------------------------------------
// /status
// ---------------------------------------------------------------------------
export async function handleStatus({ db, userId, timezone, now, rows = [], locale = 'zh-TW' }) {
  const report = await buildDataQualityReport({ db, userId, timezone, now });
  return renderLocalizedStatus({ db, userId, timezone, now, rows, report, locale });
}

async function renderLocalizedStatus({ db, userId, timezone, now, rows, report, locale }) {
  const line = (key, vars = {}) => t(locale, `bot.status.${key}`, vars);
  const lines = [line('title'), '', line('bot'), line('timezone', { timezone }), ''];
  const dataStatus = report.has_any_health_data
    ? line('dataPresent', {
      days: formatNumber(locale, report.sleep_count),
      from: formatLocalDate(report.history_start, locale),
      to: formatLocalDate(report.history_end, locale),
    }) : line('notStarted');
  lines.push(line('data', { status: dataStatus }));
  lines.push(line('authorization', {
    status: line(report.token_present ? 'authorized' : 'unauthorized')
      + (report.missing_scopes.length
        ? line('missingScopes', { scopes: renderMissingScopes(locale, report.missing_scopes) }) : ''),
  }));
  const backfillCount = Object.keys(report.backfill_status).length;
  lines.push(line('backfill', {
    status: line(backfillCount === 0 ? 'notStarted'
      : report.backfill_complete ? 'complete' : 'inProgress'),
  }));
  lines.push(line('lastSync', {
    value: report.last_sync ? new Intl.DateTimeFormat(locale, {
      dateStyle: 'medium', timeStyle: 'short', timeZone: timezone,
    }).format(new Date(report.last_sync)) : line('neverSynced'),
  }));
  lines.push(line('probe', { status: line(report.capabilities.probed ? 'probed' : 'notProbed') }), '');
  const prediction = assessPrediction({ rows });
  lines.push(prediction.status === READINESS_STATUS.READY
    ? line('predictionReady') : line('predictionUnready', {
      usable: formatNumber(locale, prediction.usable_samples),
      required: formatNumber(locale, prediction.required_samples),
    }));
  const insightCount = (await db.getActiveInsights(userId, {}).catch(() => [])).length;
  lines.push(insightCount ? line('insights', { count: formatNumber(locale, insightCount) })
    : line('noInsights'));
  lines.push('', line('journal', { count: formatNumber(locale, report.journal_count) }), '');
  lines.push(await renderProactiveStatusLines({ db, userId, timezone, rows, now, locale }));
  return lines.join('\n');
}

/** /status 裡「Proactive Agent」那幾行。獨立成函式方便測試。 */
export async function renderProactiveStatusLines({ db, userId, timezone, rows = [], now, locale = 'zh-TW' }) {
  const anchorDate = rows.length
    ? [...rows].sort((a, b) => (a.health_date < b.health_date ? -1 : 1)).at(-1).health_date
    : localDate(now, timezone);
  const coreMetrics = READINESS_HEURISTICS.PROACTIVE_CORE_METRICS;
  const seriesByMetric = {};
  for (const m of coreMetrics) seriesByMetric[m] = seriesOf(rows, m);

  const monitoring = assessProactiveMonitoring({ seriesByMetric, anchorDate, coreMetrics });
  let hasMatureInsight = false;
  try {
    hasMatureInsight = (await db.getActiveInsights(userId, {}))
      .some((i) => i.status !== INSIGHT_STATUS.HYPOTHESIS);
  } catch { /* 忽略 */ }
  const stage = deriveColdStartStage({ proactiveMonitoringStatus: monitoring.status, hasMatureInsight });

    const lines = [
      t(locale, 'bot.status.proactiveTitle'),
      t(locale, 'bot.status.proactiveState', { state: t(locale, `bot.status.stage.${stage}`) }),
    ];
    const openQuestion = await db.getOpenPendingQuestion(userId, { now }).catch(() => null);
    const factor = openQuestion?.context?.category;
    const normalized = ({ late_meal:'lateMeal', late_sleep:'lateSleep', exercise_note:'exercise' })[factor] ?? factor;
    const allowed = new Set(['alcohol','caffeine','stress','lateMeal','lateSleep','sickness',
      'travel','exercise','sauna','supplement','medication','flight','location','massage','food','custom']);
    lines.push(openQuestion ? t(locale, 'bot.status.pendingYes', {
      factor: t(locale, `factor.${allowed.has(normalized) ? normalized : 'custom'}`),
    }) : t(locale, 'bot.status.pendingNo'));
    const recent = await db.getRecentProactiveEvents(userId, {
      sinceIso: addDays(anchorDate, -7),
    }).catch(() => []);
    const last = recent[0];
    lines.push(last ? t(locale, 'bot.status.lastAction', {
      date: formatLocalDate(last.createdAt?.slice(0, 10), locale),
      action: t(locale, `bot.status.action.${['IGNORE','LOG_ONLY','ASK_CONTEXT','NOTIFY','FOLLOW_UP'].includes(last.decision)
        ? last.decision : 'UNKNOWN'}`),
    }) : t(locale, 'bot.status.noAction'));
    return lines.join('\n');
}

// ---------------------------------------------------------------------------
// /journal [days]
// ---------------------------------------------------------------------------
export async function handleJournal({ db, userId, argsText, timezone, now, locale = 'zh-TW' }) {
  const n = Number(String(argsText ?? '').trim());
  const days = Number.isFinite(n) && n >= 1 && n <= 365 ? Math.floor(n) : 14;

  const to = localDate(now, timezone);
  const from = addDays(to, -(days - 1));
  const events = await db.getJournalEvents(userId, { from, to, limit: 100 });

  if (!events.length) {
    return t(locale, 'bot.journal.empty', { days: formatNumber(locale, days) });
  }

  const lines = [t(locale, 'bot.journal.title', {
    days: formatNumber(locale, days), count: formatNumber(locale, events.length),
  }), ''];
  const byDate = {};
  for (const e of events) {
    (byDate[e.health_date] ??= []).push(e);
  }
  for (const date of Object.keys(byDate).sort().reverse()) {
    lines.push(formatLocalDate(date, locale));
    for (const e of byDate[date]) {
      const amount = e.numeric_value === null || e.numeric_value === undefined
        ? '' : ` ${formatNumber(locale, e.numeric_value, 2)}${e.unit ? ` ${e.unit}` : ''}`;
      const category = labelForCategory(e.category, locale);
      lines.push(t(locale, 'bot.journal.entry', {
        category, subtype: e.subtype ? `/${e.subtype}` : '', amount,
      }));
    }
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// /insights [history]
// ---------------------------------------------------------------------------
export async function handleInsights({ db, userId, argsText, locale = 'zh-TW' }) {
  const wantHistory = /^history$/i.test(String(argsText ?? '').trim());

  let all = [];
  try {
    all = await db.getActiveInsights(userId, {});
  } catch { /* 沒表就當空的 */ }

  // 預設只顯示 SUPPORTED / EMERGING / HYPOTHESIS，不顯示 RETIRED
  const visible = all.filter((i) => [
    INSIGHT_STATUS.SUPPORTED, INSIGHT_STATUS.EMERGING, INSIGHT_STATUS.HYPOTHESIS,
  ].includes(i.status));


    const lines = [t(locale, 'bot.insights.title'), ''];
    if (!visible.length) return `${lines.join('\n')}${t(locale, 'bot.insights.empty')}`;
    for (const i of visible) {
      const match = /^([a-z_]+)_vs_([a-z_]+)$/.exec(String(i.subject ?? ''));
      const factor = match && ({ late_meal:'lateMeal', late_sleep:'lateSleep', exercise_note:'exercise' })[match[1]]
        || match?.[1];
      const metric = match?.[2];
      const factorKey = factor && `factor.${factor}`;
      const metricKey = metric && `metric.${metric}`;
      if (!factorKey || !metricKey || !Object.hasOwn({
        alcohol:1,caffeine:1,stress:1,lateMeal:1,lateSleep:1,sickness:1,travel:1,
        exercise:1,sauna:1,supplement:1,medication:1,flight:1,location:1,massage:1,food:1,custom:1,
      }, factor) || !Object.hasOwn({ hrv:1,rhr:1,recovery:1,respiratory_rate:1 }, metric)) {
        lines.push(t(locale, 'bot.insights.unavailable'));
        continue;
      }
      const direction = !Number.isFinite(i.effect_size)
        ? 'Unknown' : i.effect_size > 0 ? 'Positive' : 'Negative';
      const statement = t(locale, 'bot.insights.line', {
        factor: t(locale, factorKey), metric: t(locale, metricKey),
        direction: t(locale, `bot.insights.direction${direction}`),
        effect: Number.isFinite(i.effect_size) ? formatNumber(locale, i.effect_size, 2) : '—',
        count: Number.isFinite(i.sample_count) ? formatNumber(locale, i.sample_count) : '—',
        status: t(locale, `bot.insights.status.${i.status}`),
      });
      lines.push(statement, t(locale, 'bot.insights.meta', {
        count: Number.isFinite(i.sample_count) ? formatNumber(locale, i.sample_count) : '—',
        version: i.version,
      }));
      if (wantHistory && Number(i.supersedes_id)) {
        const chain = await db.getInsightHistory(userId, Number(i.id)).catch(() => []);
        for (const old of chain.slice(1)) lines.push(t(locale, 'bot.insights.history', {
          version: old.version, status: t(locale, `bot.insights.status.${old.status}`),
          statement: t(locale, 'bot.insights.unavailable'),
        }));
      }
      lines.push('');
    }
    lines.push(t(locale, 'bot.insights.note'));
    if (!wantHistory) lines.push(t(locale, 'bot.insights.historyHint'));
    return lines.join('\n');
}

// ---------------------------------------------------------------------------
// /predictions
// ---------------------------------------------------------------------------

/**
 * 模型成熟度的對外說法。
 *
 * 刻意都用「還沒被證明」而不是「不好」——我們知道的是「沒有證據支持」，
 * 不是「有證據反對」。這兩件事不一樣。
 */
export async function handlePredictions({ db, userId, rows = [], locale = 'zh-TW' }) {
  return renderLocalizedPredictions({ db, userId, rows, locale });
}

async function renderLocalizedPredictions({ db, userId, rows, locale }) {
  const line = (key, vars = {}) => t(locale, `bot.prediction.${key}`, vars);
  const readiness = assessPrediction({ rows });
  const status = Object.values(READINESS_STATUS).includes(readiness.status)
    ? readiness.status : READINESS_STATUS.UNAVAILABLE;
  const lines = [line('title'), ''];
  if (status !== READINESS_STATUS.READY) {
    lines.push(line('state', { state: line(`state.${status}`) }), '',
      line('usable', { count: formatNumber(locale, readiness.usable_samples) }),
      line('required', { count: formatNumber(locale, readiness.required_samples) }), '',
      line(status === READINESS_STATUS.DEGRADED ? 'degraded' : 'insufficient'),
      line('caveat'));
  } else {
    lines.push(line('dataReady'), line('usable', {
      count: formatNumber(locale, readiness.usable_samples),
    }), '');
    const model = await db.getLatestPredictionModel(userId, { targetMetric:'recovery' })
      .catch(() => null);
    if (!model) lines.push(line('modelUntrained'));
    else {
      const maturity = Object.values(PREDICTION_MATURITY).includes(model.maturity)
        ? model.maturity : 'MODEL_UNAVAILABLE';
      lines.push(line('modelState', { state: line(`maturity.${maturity}`) }));
      if (model.nTest) lines.push(line('testSamples', { count: formatNumber(locale, model.nTest) }));
      if (model.mae != null) lines.push(`  MAE ${formatNumber(locale, model.mae, 2)}`);
      if (model.baselineMae != null) lines.push(line('baseline', {
        verdict: line(model.beatsBaseline === true ? 'baselineBetter' : 'baselineWorse'),
        value: formatNumber(locale, model.baselineMae, 2),
      }));
      lines.push('', line(model.qualified ? 'qualified' : 'unqualified'));
    }
  }
  const sc = await scorecard(db, userId, {}).catch(() => null);
  if (sc?.available) {
    lines.push('', line('scorecard'), line('evaluated', { count: formatNumber(locale, sc.n) }),
      `  MAE ${formatNumber(locale, sc.mae, 2)}`,
      `  RMSE ${formatNumber(locale, sc.rmse, 2)}`,
      line('coverage', { value: formatNumber(locale, sc.interval_coverage * 100, 0) }));
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// /healthspan
// ---------------------------------------------------------------------------

/**
 * 長期生理盤點。
 *
 * 完全確定性、沒有 LLM。目前**不會**輸出任何綜合分數或推估年齡——
 * 見 healthspanPolicy.js 的說明。
 */
export async function handleHealthspan({ db, userId, rows = [], locale = 'zh-TW' }) {
  let capabilities = {};
  try {
    capabilities = await db.getCapabilities(userId);
  } catch { /* 沒 probe 過就是空的，不影響盤點 */ }

  const result = buildPersonalHealthspan(rows, { capabilities });
  return renderPersonalHealthspan(result, locale);
}

// ---------------------------------------------------------------------------
// /cost
// ---------------------------------------------------------------------------
export async function handleCost({ db, userId, timezone, now, locale = 'zh-TW' }) {
  const summary = await costSummary({ db, userId, timezone, now });
  return renderCost(summary, locale);
}

// ---------------------------------------------------------------------------
// /evidence
// ---------------------------------------------------------------------------
export async function handleEvidence({ db, userId, now, locale = 'zh-TW' }) {
  const result = await getEvidence({ db, userId, now, locale });
  return renderEvidence(result, locale);
}
