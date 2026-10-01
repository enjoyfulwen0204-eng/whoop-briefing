/**
 * /experiment 的多步驟建立流程。
 *
 * 沿用既有的 pending_questions 基礎建設，不另外做 agent。
 * 狀態全部存在 context_json 裡，所以 worker 重啟也不會遺失進度。
 */

import { TELEGRAM_BOT } from '../config.js';
import {
  createExperiment, startExperiment, completeExperiment,
  analyseExperimentData, EXPERIMENT_STATUS,
} from '../experiments.js';
import { resolveMetric } from '../healthQuery.js';
import { addDays, localDate } from '../time.js';
import { log } from '../logger.js';
import { t, formatLocalDate, formatNumber } from '../localization.js';

export const FLOW = 'experiment_create';

/** 依序要問的五個問題。 */
export const STEPS = [
  { key: 'name', question: '這個實驗要叫什麼名字？（例如「睡前不喝咖啡」）' },
  { key: 'hypothesis', question: '你的假設是什麼？（例如「深睡會變多」；沒有就回「跳過」）' },
  { key: 'intervention', question: '具體要做什麼？（例如「14:00 後不攝取咖啡因」）' },
  {
    key: 'target_metric',
    question: '要觀察哪個指標？（例如 深睡、恢復、HRV、睡眠效率）',
  },
  { key: 'duration_days', question: '打算做幾天？（建議 14 天以上，直接回數字）' },
];

const SKIP = /^(跳過|skip|無|沒有|-)$/i;
const metricKeys = new Set(['hrv','rhr','recovery','sleep_total','sleep_performance',
  'previous_day_strain','deep_sleep','rem_sleep','respiratory_rate','sleep_debt',
  'spo2','skin_temp','current_hr']);
const questionFor = (step, locale) => t(locale, `experiment.step.${step.key}`);
const metricFor = (key, locale) => t(locale, metricKeys.has(key)
  ? `answer.metric.${key}` : 'answer.metricUnknown');
const statusFor = (status, locale) => t(locale, `experiment.status.${Object.values(EXPERIMENT_STATUS).includes(status)
  ? status : 'UNKNOWN'}`);
const dateFor = (date, locale) => date && locale !== 'zh-TW' ? formatLocalDate(date, locale) : date;

/** 開始建立流程。 */
export async function beginCreate({ db, userId, chatId, now, locale = 'zh-TW' }) {
  await db.openPendingQuestion(userId, {
    chatId,
    originalMessage: '/experiment create',
    question: questionFor(STEPS[0], locale),
    intent: FLOW,
    contextJson: { flow: FLOW, step: 0, data: {} },
    ttlMs: TELEGRAM_BOT.PENDING_TTL_MS,
  }, { now });
  return t(locale, 'experiment.begin', {
    step: 1, total: STEPS.length, question: questionFor(STEPS[0], locale),
  });
}

/**
 * 收到使用者對某一步的回答。
 * @returns {?string} 回覆文字；不是這個 flow 就回 null
 */
export async function handleStep({ db, userId, pending, text, now, timezone, locale = 'zh-TW' }) {
  const ctx = pending.context;
  if (ctx?.flow !== FLOW) return null;

  if (/^(取消|cancel|算了|hủy|huy)$/i.test(text.trim())) {
    await db.cancelPendingQuestion(userId, pending.id);
    return t(locale, 'experiment.cancel');
  }

  const stepIndex = Number(ctx.step ?? 0);
  const step = STEPS[stepIndex];
  const data = { ...(ctx.data ?? {}) };
  const answer = text.trim();

  // --- 驗證這一步的答案 ---
  if (step.key === 'target_metric') {
    const metric = resolveMetric(answer);
    if (!metric) {
      // 不推進步驟，重新問一次
      return t(locale, 'experiment.metricInvalid', {
        input: answer, step: stepIndex + 1, total: STEPS.length,
        question: questionFor(step, locale),
      });
    }
    data[step.key] = metric;
  } else if (step.key === 'duration_days') {
    const n = Number(answer.replace(/[^\d]/g, ''));
    if (!Number.isFinite(n) || n < 3 || n > 180) {
      return t(locale, 'experiment.durationInvalid', {
        step: stepIndex + 1, total: STEPS.length, question: questionFor(step, locale),
      });
    }
    data[step.key] = n;
  } else if (SKIP.test(answer) || /^(bỏ qua|bo qua)$/i.test(answer)) {
    data[step.key] = null;
  } else {
    data[step.key] = answer.slice(0, 200);
  }

  // --- 還有下一步 ---
  const nextIndex = stepIndex + 1;
  if (nextIndex < STEPS.length) {
    // M-02 同一條不變量：認領成功才有資格推進到下一步。
    // 輸掉代表這一步已經被別人（或收割器）收走了，重開下一題會讓
    // 使用者看到兩條互相打架的流程。
    if (!await db.resolvePendingQuestion(userId, pending.id, answer, { now })) {
      log.warn('experiment_flow_claim_lost', { user_id: userId, pending_question_id: pending.id });
      return null;
    }
    await db.openPendingQuestion(userId, {
      chatId: pending.chatId,
      originalMessage: '/experiment create',
      question: questionFor(STEPS[nextIndex], locale),
      intent: FLOW,
      contextJson: { flow: FLOW, step: nextIndex, data },
      ttlMs: TELEGRAM_BOT.PENDING_TTL_MS,
    }, { now });
    return t(locale, 'experiment.next', {
      step: nextIndex + 1, total: STEPS.length,
      question: questionFor(STEPS[nextIndex], locale),
    });
  }

  // --- 全部問完 → 建立並啟動 ---
  // ★ 認領必須在 createExperiment **之前**且必須成功：否則同一段流程被
  // 處理兩次會建立兩個一模一樣的實驗。
  if (!await db.resolvePendingQuestion(userId, pending.id, answer, { now })) {
    log.warn('experiment_flow_claim_lost', { user_id: userId, pending_question_id: pending.id });
    return null;
  }

  const today = localDate(now, timezone);
  const created = await createExperiment(db, userId, {
    name: data.name || t(locale, 'experiment.unnamed'),
    hypothesis: data.hypothesis,
    intervention: data.intervention,
    targetMetrics: [data.target_metric],
    protocol: { duration_days: data.duration_days, created_via: 'telegram' },
  }, { now, provenance:{kind:'DIRECT',writerKind:'EXPERIMENT_FLOW',sourceUpdateKey:`experiment-flow:${pending.id}`,
    fields:['name','hypothesis','intervention','target_metrics','protocol_json']} });

  if (!created.ok) return t(locale, 'experiment.createFailed');

  // baseline 取實驗開始前同樣長度的一段
  const baselineEnd = addDays(today, -1);
  const baselineStart = addDays(baselineEnd, -(data.duration_days - 1));
  await startExperiment(db, userId, created.id, {
    startDate: today,
    baselineStart,
    baselineEnd,
    now,
    provenance:{kind:'DIRECT',writerKind:'EXPERIMENT_FLOW',sourceUpdateKey:`experiment-flow-schedule:${pending.id}`,
      fields:['start_date','baseline_start','baseline_end']},
  });

  log.info('experiment_created_via_telegram', { id: created.id, name: data.name });

  return [
    t(locale, 'experiment.created', { id: created.id }),
    '',
    t(locale, 'experiment.name', { name: data.name || t(locale, 'experiment.unnamed') }),
    data.hypothesis ? t(locale, 'experiment.hypothesis', { value: data.hypothesis }) : null,
    data.intervention ? t(locale, 'experiment.intervention', { value: data.intervention }) : null,
    t(locale, 'experiment.target', { metric: metricFor(data.target_metric, locale) }),
    t(locale, 'experiment.period', {
      from: dateFor(today, locale), to: dateFor(addDays(today, data.duration_days - 1), locale),
      days: formatNumber(locale, data.duration_days),
    }),
    t(locale, 'experiment.baselinePeriod', {
      from: dateFor(baselineStart, locale), to: dateFor(baselineEnd, locale),
    }),
    '',
    t(locale, 'experiment.finishHint'),
    t(locale, 'experiment.caveat'),
  ].filter(Boolean).join('\n');
}

/** /experiment list */
export async function renderList(db, userId, locale = 'zh-TW') {
  const all = await db.listExperiments(userId, {});
  if (!all.length) return t(locale, 'experiment.none');
  const lines = [t(locale, 'experiment.listTitle'), ''];
  for (const e of all) {
    const parsedMetrics = JSON.parse(e.target_metrics ?? '[]');
    const metrics = Array.isArray(parsedMetrics)
      ? parsedMetrics.map(m => metricFor(m, locale)).join(', ') : '';
    lines.push(t(locale, 'experiment.listEntry', {
      id: e.id, name: e.name, status: statusFor(e.status, locale),
    }));
    lines.push(t(locale, 'experiment.listMetric', {
      metrics: metrics || t(locale, 'experiment.notSpecified'),
    }));
    if (e.start_date) lines.push(t(locale, 'experiment.listPeriod', {
      from: dateFor(e.start_date, locale),
      to: e.end_date ? dateFor(e.end_date, locale) : t(locale, 'experiment.inProgress'),
    }));
    lines.push('');
  }
  return lines.join('\n');
}

/** /experiment status [id] */
export async function renderStatus({ db, userId, rows, id, timezone, now, locale = 'zh-TW' }) {
  const list = await db.listExperiments(userId, {});
  const exp = id
    ? list.find((e) => Number(e.id) === Number(id))
    : list.find((e) => e.status === EXPERIMENT_STATUS.RUNNING) ?? list[0];

  if (!exp) return t(locale, 'experiment.none');

  const lines = [
    t(locale, 'experiment.statusTitle', { id: exp.id, name: exp.name }),
    t(locale, 'experiment.status', { status: statusFor(exp.status, locale) }),
    exp.hypothesis ? t(locale, 'experiment.hypothesis', { value: exp.hypothesis }) : null,
    exp.start_date ? t(locale, 'experiment.listPeriod', {
      from: dateFor(exp.start_date, locale),
      to: exp.end_date ? dateFor(exp.end_date, locale) : t(locale, 'experiment.inProgress'),
    }) : null,
    exp.baseline_start ? t(locale, 'experiment.baselinePeriod', {
      from: dateFor(exp.baseline_start, locale), to: dateFor(exp.baseline_end, locale),
    }) : null,
    '',
  ].filter(Boolean);

  // 進行中的實驗還沒有 end_date。用「今天」當暫定結束日，
  // 這樣可以看到目前為止的進度，而不是只回一句「缺少期間日期」。
  const result = analyseExperimentData({ rows, experiment: exp,
    asOfDate:exp.status===EXPERIMENT_STATUS.RUNNING?localDate(now,timezone):null });
  if (!result.ok) {
    lines.push(t(locale, 'experiment.notAnalyzable'));
    return lines.join('\n');
  }

  let anySufficient = false;
  for (const m of Object.values(result.metrics)) {
    if (!m.sufficient) {
      lines.push(t(locale, 'experiment.insufficient', {
        metric: metricFor(m.metric, locale),
        baseline: formatNumber(locale, m.baseline_n),
        intervention: formatNumber(locale, m.intervention_n),
        required: formatNumber(locale, m.required_per_period),
      }));
      continue;
    }
    anySufficient = true;
    lines.push(t(locale, 'experiment.metricHeading', { metric: metricFor(m.metric, locale) }));
    lines.push(t(locale, 'experiment.baselineMean', {
      value: formatNumber(locale, m.baseline_mean, 2), count: formatNumber(locale, m.baseline_n),
    }));
    lines.push(t(locale, 'experiment.interventionMean', {
      value: formatNumber(locale, m.intervention_mean, 2), count: formatNumber(locale, m.intervention_n),
    }));
    lines.push(t(locale, 'experiment.difference', {
      value: `${m.mean_difference >= 0 ? '+' : ''}${formatNumber(locale, m.mean_difference, 2)}`,
      effect: m.effect_size != null ? t(locale, 'experiment.effect', {
        value: formatNumber(locale, m.effect_size, 2),
      }) : '',
    }));
  }

  if (anySufficient) {
    lines.push('');
    lines.push(t(locale, 'experiment.associationNote'));
  }
  return lines.join('\n');
}

/** /experiment stop [id] */
export async function stopExperiment({ db, userId, id, timezone, now, locale = 'zh-TW' }) {
  const list = await db.listExperiments(userId, { status: EXPERIMENT_STATUS.RUNNING });
  const exp = id ? list.find((e) => Number(e.id) === Number(id)) : list[0];
  if (!exp) return t(locale, 'experiment.noRunning');

  const today = localDate(now, timezone);
  const r = await completeExperiment(db, userId, Number(exp.id), { endDate: today, now,
    provenance:{kind:'DIRECT',writerKind:'EXPERIMENT_FLOW',sourceUpdateKey:`experiment-stop:${exp.id}:${today}`,fields:['end_date']} });
  if (!r.ok) return t(locale, 'experiment.stopFailed');
  return t(locale, 'experiment.stopped', {
    id: exp.id, name: exp.name,
    from: dateFor(exp.start_date, locale), to: dateFor(today, locale),
  });
}
