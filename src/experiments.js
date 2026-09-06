/**
 * 自我實驗（Phase Z）。
 *
 * ## 用詞紀律
 *
 * 這是 n=1 的個人前後對照，**不是隨機對照試驗**。
 * 所有輸出一律稱 "within-person observed association"，
 * 絕不說「證明」「causes」「因為 X 所以 Y」。
 */

import { mean, median, stddev } from './analytics/statistics.js';
import { seriesOf } from './dailyMetrics.js';
import { log } from './logger.js';

export const EXPERIMENT_STATUS = {
  DRAFT: 'DRAFT',
  RUNNING: 'RUNNING',
  COMPLETED: 'COMPLETED',
  ABANDONED: 'ABANDONED',
};

export const MIN_PERIOD_DAYS = 5;

export async function createExperiment(db, spec, { now = new Date() } = {}) {
  if (!spec?.name) return { ok: false, error: 'name_required' };
  if (!Array.isArray(spec.targetMetrics) || !spec.targetMetrics.length) {
    return { ok: false, error: 'target_metrics_required' };
  }
  const id = await db.createExperiment({ ...spec, status: EXPERIMENT_STATUS.DRAFT }, { now });
  return { ok: true, id };
}

export async function startExperiment(db, id, { startDate, baselineStart, baselineEnd, now = new Date() } = {}) {
  const exp = await db.getExperiment(id);
  if (!exp) return { ok: false, error: 'not_found' };
  if (exp.status !== EXPERIMENT_STATUS.DRAFT) return { ok: false, error: `cannot_start_from_${exp.status}` };
  await db.updateExperiment(id, {
    status: EXPERIMENT_STATUS.RUNNING, startDate, baselineStart, baselineEnd,
  }, { now });
  log.info('experiment_started', { id, start_date: startDate });
  return { ok: true };
}

export async function completeExperiment(db, id, { endDate, now = new Date() } = {}) {
  const exp = await db.getExperiment(id);
  if (!exp) return { ok: false, error: 'not_found' };
  if (exp.status !== EXPERIMENT_STATUS.RUNNING) return { ok: false, error: `cannot_complete_from_${exp.status}` };
  await db.updateExperiment(id, { status: EXPERIMENT_STATUS.COMPLETED, endDate }, { now });
  log.info('experiment_completed', { id, end_date: endDate });
  return { ok: true };
}

/** 取某段日期區間內某指標的值。 */
function valuesIn(rows, metric, start, end) {
  return seriesOf(rows, metric)
    .filter((p) => p.date >= start && p.date <= end)
    .map((p) => p.value);
}

/**
 * 分析：baseline 期 vs intervention 期。
 *
 * 輸出平均差、中位數差、effect size（Cohen's d）與樣本數。
 * 任一期樣本不足就標 insufficient，**不下結論**。
 */
export function analyseExperimentData({ rows, experiment }) {
  const targets = JSON.parse(experiment.target_metrics ?? '[]');
  const baselineStart = experiment.baseline_start;
  const baselineEnd = experiment.baseline_end;
  const start = experiment.start_date;
  const end = experiment.end_date;

  const base = {
    experiment_id: Number(experiment.id),
    name: experiment.name,
    interpretation: 'within-person observed association',
    causal: false,
    note: 'n=1 前後對照，不是隨機對照試驗。時間本身的變化（季節、生活）無法排除。',
  };

  if (!baselineStart || !baselineEnd || !start || !end) {
    return { ...base, ok: false, reason: 'missing_period_dates', metrics: {} };
  }

  const metrics = {};
  for (const metric of targets) {
    const baselineValues = valuesIn(rows, metric, baselineStart, baselineEnd);
    const interventionValues = valuesIn(rows, metric, start, end);

    if (baselineValues.length < MIN_PERIOD_DAYS || interventionValues.length < MIN_PERIOD_DAYS) {
      metrics[metric] = {
        metric,
        sufficient: false,
        reason: 'insufficient_data',
        baseline_n: baselineValues.length,
        intervention_n: interventionValues.length,
        required_per_period: MIN_PERIOD_DAYS,
      };
      continue;
    }

    const bMean = mean(baselineValues);
    const iMean = mean(interventionValues);
    const bSd = stddev(baselineValues);
    const iSd = stddev(interventionValues);

    let effectSize = null;
    if (bSd !== null && iSd !== null) {
      const pooled = Math.sqrt(
        (((baselineValues.length - 1) * bSd ** 2) + ((interventionValues.length - 1) * iSd ** 2))
        / (baselineValues.length + interventionValues.length - 2),
      );
      if (Number.isFinite(pooled) && pooled > 0) effectSize = (iMean - bMean) / pooled;
    }

    metrics[metric] = {
      metric,
      sufficient: true,
      baseline_n: baselineValues.length,
      intervention_n: interventionValues.length,
      baseline_mean: bMean,
      intervention_mean: iMean,
      mean_difference: iMean - bMean,
      baseline_median: median(baselineValues),
      intervention_median: median(interventionValues),
      median_difference: median(interventionValues) - median(baselineValues),
      baseline_stddev: bSd,
      intervention_stddev: iSd,
      effect_size: effectSize,
    };
  }

  return { ...base, ok: true, metrics };
}

export async function analyzeExperiment(db, id, rows, { now = new Date() } = {}) {
  const exp = await db.getExperiment(id);
  if (!exp) return { ok: false, error: 'not_found' };
  const result = analyseExperimentData({ rows, experiment: exp });
  await db.updateExperiment(id, { result }, { now });
  return result;
}
