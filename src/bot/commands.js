/**
 * 指令處理。
 *
 * 全部是確定性的 —— 指令不需要也不應該經過 LLM。
 * 只有 /log 的自然語言變體會用到 LLM，而那也只做「語言 → 結構化提案」。
 */

import { buildDataQualityReport, renderDataQuality } from '../dataQuality.js';
import { parseLogCommand, saveEvent, describeEvent, CATEGORIES } from '../journal.js';
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
    if (!saved.ok) return locale === 'zh-TW'
      ? `⚠️ 這筆記錄有問題：${saved.errors.join(', ')}`
      : t(locale, 'bot.log.invalid');
    return t(locale, 'router.saved', { event: describeEvent(saved.event, locale) });
  }

  // 確定性解析失敗 → 試自然語言
  if (parseNatural && argsText) {
    const nat = await parseNatural({ text: argsText, now, timezone, coach });
    if (nat.ok) {
      const saved = await saveEvent(db, userId, nat.event, { now, timezone });
      if (saved.ok) return t(locale, 'router.saved', { event: describeEvent(saved.event, locale) });
    }
  }

  // 欄位名刻意不叫 token —— logger 的遮蔽清單把 'token' 當機密，
  // 用那個名字會讓這行 debug 資訊被 [REDACTED] 掉，等於白記。
  log.info('log_command_unparsed', { error: parsed.error, unknown_word: parsed.token });
  if (locale !== 'zh-TW') return t(locale, 'bot.log.unparsed', {
    input: argsText || '—', categories: CATEGORIES.join(', '),
  });
  return [
    `⚠️ 看不懂「${argsText || '(空白)'}」。`,
    '',
    '用法例如：',
    '/log alcohol 3 drinks',
    '/log caffeine 2 coffee',
    '/log flight TPE SGN',
    '/log sick',
    '/log magnesium 300mg',
    '',
    `可用類別：${CATEGORIES.join(', ')}`,
  ].join('\n');
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
  if (locale !== 'zh-TW') return renderLocalizedStatus({
    db, userId, timezone, now, rows, report, locale,
  });
  const lines = ['🩺 系統狀態', ''];

  lines.push('Bot：✅ 運作中');
  lines.push(`時區：${timezone}`);
  lines.push('');

  lines.push('WHOOP 資料：'
    + (report.has_any_health_data
      ? `✅ ${report.sleep_count} 天（${report.history_start} ～ ${report.history_end}）`
      : '尚未開始'));
  lines.push(`授權：${report.token_present ? '✅ 已授權' : '尚未授權'}`
    + (report.missing_scopes.length ? `（缺 ${report.missing_scopes.join(', ')}）` : ''));

  const bf = Object.entries(report.backfill_status);
  lines.push(`Backfill：${bf.length === 0 ? '尚未開始' : (report.backfill_complete ? '✅ 完成' : '進行中')}`);
  lines.push(`最後同步：${report.last_sync ?? '尚未同步'}`);
  lines.push(`Capability probe：${report.capabilities.probed ? '✅ 已執行' : '尚未執行'}`);
  lines.push('');

  // 預測就緒度——直接問 readiness engine，不在這裡重複算一次門檻
  const predictionReadiness = assessPrediction({ rows });
  lines.push(`預測就緒：${predictionReadiness.status === READINESS_STATUS.READY
    ? '✅ 可訓練'
    : `尚未（${predictionReadiness.usable_samples}/${predictionReadiness.required_samples} 筆可用樣本）`}`);

  // insight 就緒度
  let insightCount = 0;
  try {
    insightCount = (await db.getActiveInsights(userId, {})).length;
  } catch { /* 忽略 */ }
  lines.push(`長期規律：${insightCount > 0 ? `${insightCount} 項` : '尚未形成'}`);

  lines.push('');
  lines.push(`Journal：${report.journal_count} 筆`);

  // ---- Proactive Agent（PA22）----
  // 刻意精簡：開關狀態、資料成熟度、有沒有正在等回答的問題、最近一次動作。
  // 不展開成一堆新指令，維持 /status 是「一頁摘要」。
  lines.push('');
  lines.push(await renderProactiveStatusLines({ db, userId, timezone, rows, now }));

  return lines.join('\n');
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
        ? line('missingScopes', { scopes: report.missing_scopes.join(', ') }) : ''),
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
  if (locale !== 'zh-TW') {
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

  const STAGE_LABEL = {
    [COLD_START_STAGE.STAGE_0]: '尚未開始累積資料',
    [COLD_START_STAGE.STAGE_1]: '累積中，還不足以主動分析',
    [COLD_START_STAGE.STAGE_2]: '資料有限，主動分析尚未啟用',
    [COLD_START_STAGE.STAGE_3]: '✅ 已啟用',
    [COLD_START_STAGE.STAGE_4]: '✅ 已啟用（已有長期規律）',
  };

  const lines = ['🔔 Proactive Agent', `狀態：${STAGE_LABEL[stage] ?? stage}`];

  let openQuestion = null;
  try {
    openQuestion = await db.getOpenPendingQuestion(userId, { now });
  } catch { /* 忽略 */ }
  lines.push(`待回答問題：${openQuestion ? '有（' + (openQuestion.context?.category ?? '未分類') + '）' : '無'}`);

  try {
    const recent = await db.getRecentProactiveEvents(userId, {
      sinceIso: addDays(anchorDate, -7),
    });
    const last = recent[0];
    lines.push(`最近一次動作：${last ? `${last.createdAt?.slice(0, 10)} ${last.decision}` : '尚無'}`);
  } catch {
    lines.push('最近一次動作：尚無');
  }

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
    lines.push(locale === 'zh-TW' ? date : formatLocalDate(date, locale));
    for (const e of byDate[date]) {
      const amount = e.numeric_value === null || e.numeric_value === undefined
        ? '' : ` ${formatNumber(locale, e.numeric_value, 2)}${e.unit ? ` ${e.unit}` : ''}`;
      const factor = ({ late_meal:'lateMeal', late_sleep:'lateSleep', exercise_note:'exercise' })[e.category]
        ?? e.category;
      const category = locale === 'zh-TW' ? e.category : t(locale, `factor.${factor}`);
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

  if (locale !== 'zh-TW') {
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

  if (!visible.length) {
    return [
      '🧠 長期規律',
      '',
      '目前資料還不足以形成長期規律。',
      '',
      '要看出「什麼會影響你的恢復」，需要累積一段時間的 WHOOP 資料，',
      '再加上 /log 記錄的生活事件當對照。',
    ].join('\n');
  }

  const lines = ['🧠 長期規律', ''];
  for (const i of visible) {
    lines.push(`[${i.status}] ${i.statement}`);
    lines.push(`   樣本 ${i.sample_count ?? '不明'}`
      + (i.effect_size !== null && i.effect_size !== undefined
        ? `，effect size ${Number(i.effect_size).toFixed(2)}` : '')
      + `，v${i.version}`);
    if (wantHistory && Number(i.supersedes_id)) {
      try {
        const chain = await db.getInsightHistory(userId, Number(i.id));
        for (const old of chain.slice(1)) {
          lines.push(`   ↳ v${old.version}（${old.status}）${old.statement}`);
        }
      } catch { /* 忽略 */ }
    }
    lines.push('');
  }
  lines.push('註：全部都是個人層級的觀察到的關聯，不是因果關係。');
  if (!wantHistory) lines.push('用 /insights history 可以看修正過程。');
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
const MATURITY_LABEL = {
  [PREDICTION_MATURITY.NO_DATA]: '尚無資料',
  [PREDICTION_MATURITY.INSUFFICIENT_DATA]: '資料累積中',
  [PREDICTION_MATURITY.MODEL_UNAVAILABLE]: '目前的資料結構算不出模型',
  [PREDICTION_MATURITY.TRAINABLE]: '已訓練，但還沒有足夠的測試資料可以評估',
  [PREDICTION_MATURITY.EVALUATED_UNQUALIFIED]: '已評估，但還沒達到可發布的標準',
  [PREDICTION_MATURITY.QUALIFIED]: '✅ 已通過品質門檻',
  [PREDICTION_MATURITY.STALE]: '模型已過期，需要重新訓練',
  [PREDICTION_MATURITY.UNSUPPORTED]: '這個帳號拿不到所需的欄位',
};
export async function handlePredictions({ db, userId, rows = [], locale = 'zh-TW' }) {
  if (locale !== 'zh-TW') return renderLocalizedPredictions({ db, userId, rows, locale });
  const lines = ['🔮 恢復預測', ''];

  // 用 readiness engine 判斷，不在這裡重複 MIN_TRAIN_ROWS 的門檻邏輯——
  // prediction.js 的 train() 本身用的是「D 天特徵 → D+1 天結果」配對數，
  // 不是原始列數，assessPrediction() 已經正確算過這件事。
  const readiness = assessPrediction({ rows });

  if (readiness.status !== READINESS_STATUS.READY) {
    // ⚠️ 以前這裡對**所有**非 READY 狀態都印 INSUFFICIENT_DATA，包含
    // DEGRADED（樣本夠了但結構上算不出來）。那會誤導：使用者以為只要
    // 再等幾天就好，其實是特徵共線之類的問題。現在誠實印出實際狀態。
    lines.push(`狀態：${readiness.status}`);
    lines.push('');
    lines.push(`目前可用樣本：${readiness.usable_samples} 筆`);
    lines.push(`最低需求：${readiness.required_samples} 筆`);
    lines.push('');
    if (readiness.status === READINESS_STATUS.DEGRADED) {
      lines.push('樣本數雖然夠了，但目前的資料結構算不出可用的模型，');
      lines.push('所以我不會給你任何預測數字。');
    } else {
      lines.push('資料量還不足以訓練預測模型，所以我不會給你任何預測數字。');
    }
    lines.push('（一個沒有足夠資料支撐的預測，比沒有預測更糟。）');
  } else {
    // ★ 資料夠訓練 ≠ 模型可信。這是兩個完全不同的問題，現在分開講。
    lines.push('資料就緒：✅ 可訓練');
    lines.push(`可用樣本：${readiness.usable_samples} 筆`);
    lines.push('');

    let model = null;
    try {
      model = await db.getLatestPredictionModel(userId, { targetMetric: 'recovery' });
    } catch { /* 沒有模型層資料就當作還沒訓練過 */ }

    if (!model) {
      lines.push('模型狀態：尚未訓練（下一次排程執行時會訓練）');
    } else {
      lines.push(`模型狀態：${MATURITY_LABEL[model.maturity] ?? model.maturity}`);
      if (model.nTest) lines.push(`  測試樣本 ${model.nTest} 筆（時序切分，不含未來資料）`);
      if (model.mae !== null) lines.push(`  MAE ${model.mae.toFixed(2)}`);
      if (model.baselineMae !== null) {
        const verdict = model.beatsBaseline === true ? '✅ 優於' : '❌ 沒有優於';
        lines.push(`  對照「只用歷史平均猜」：${verdict}（基準 MAE ${model.baselineMae.toFixed(2)}）`);
      }

      lines.push('');
      if (model.qualified) {
        lines.push('這個模型已通過品質門檻。');
      } else {
        // ★ 這是整個功能的核心訊息：算得出來 ≠ 可以給你看
        lines.push('目前**不會**給你預測數字。');
        lines.push('模型還沒有被證明夠準——在證明之前，給出一個數字只會誤導你。');
      }
    }
  }

  // 已經有記分卡就一併顯示
  try {
    const sc = await scorecard(db, userId, {});
    if (sc.available) {
      lines.push('');
      lines.push('過往預測準確度：');
      lines.push(`  已評估 ${sc.n} 次`);
      lines.push(`  MAE ${sc.mae.toFixed(2)}`);
      lines.push(`  RMSE ${sc.rmse.toFixed(2)}`);
      lines.push(`  區間涵蓋率 ${(sc.interval_coverage * 100).toFixed(0)}%`);
    }
  } catch { /* 忽略 */ }

  return lines.join('\n');
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
  const result = await getEvidence({ db, userId, now });
  return renderEvidence(result, locale);
}
