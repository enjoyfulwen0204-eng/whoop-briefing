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

/** 開始建立流程。 */
export async function beginCreate({ db, chatId, now }) {
  await db.openPendingQuestion({
    chatId,
    originalMessage: '/experiment create',
    question: STEPS[0].question,
    intent: FLOW,
    contextJson: { flow: FLOW, step: 0, data: {} },
    ttlMs: TELEGRAM_BOT.PENDING_TTL_MS,
  }, { now });
  return `🧪 來建立一個實驗。\n\n（1/${STEPS.length}）${STEPS[0].question}\n\n隨時輸入「取消」可以中止。`;
}

/**
 * 收到使用者對某一步的回答。
 * @returns {?string} 回覆文字；不是這個 flow 就回 null
 */
export async function handleStep({ db, pending, text, now, timezone }) {
  const ctx = pending.context;
  if (ctx?.flow !== FLOW) return null;

  if (/^(取消|cancel|算了)$/i.test(text.trim())) {
    await db.cancelPendingQuestion(pending.id);
    return '好，這個實驗先不建立了。';
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
      return `我不認得「${answer}」這個指標。\n可以用：恢復、HRV、靜息心率、睡眠、深睡、REM、睡眠效率、睡眠一致性、Strain。\n\n（${stepIndex + 1}/${STEPS.length}）${step.question}`;
    }
    data[step.key] = metric;
  } else if (step.key === 'duration_days') {
    const n = Number(answer.replace(/[^\d]/g, ''));
    if (!Number.isFinite(n) || n < 3 || n > 180) {
      return `請給一個 3 到 180 之間的天數。\n\n（${stepIndex + 1}/${STEPS.length}）${step.question}`;
    }
    data[step.key] = n;
  } else if (SKIP.test(answer)) {
    data[step.key] = null;
  } else {
    data[step.key] = answer.slice(0, 200);
  }

  // --- 還有下一步 ---
  const nextIndex = stepIndex + 1;
  if (nextIndex < STEPS.length) {
    await db.resolvePendingQuestion(pending.id, answer, { now });
    await db.openPendingQuestion({
      chatId: pending.chatId,
      originalMessage: '/experiment create',
      question: STEPS[nextIndex].question,
      intent: FLOW,
      contextJson: { flow: FLOW, step: nextIndex, data },
      ttlMs: TELEGRAM_BOT.PENDING_TTL_MS,
    }, { now });
    return `（${nextIndex + 1}/${STEPS.length}）${STEPS[nextIndex].question}`;
  }

  // --- 全部問完 → 建立並啟動 ---
  await db.resolvePendingQuestion(pending.id, answer, { now });

  const today = localDate(now, timezone);
  const created = await createExperiment(db, {
    name: data.name || '未命名實驗',
    hypothesis: data.hypothesis,
    intervention: data.intervention,
    targetMetrics: [data.target_metric],
    protocol: { duration_days: data.duration_days, created_via: 'telegram' },
  }, { now });

  if (!created.ok) return `建立失敗：${created.error}`;

  // baseline 取實驗開始前同樣長度的一段
  const baselineEnd = addDays(today, -1);
  const baselineStart = addDays(baselineEnd, -(data.duration_days - 1));
  await startExperiment(db, created.id, {
    startDate: today,
    baselineStart,
    baselineEnd,
    now,
  });

  log.info('experiment_created_via_telegram', { id: created.id, name: data.name });

  return [
    `✅ 實驗已建立並開始（#${created.id}）`,
    '',
    `名稱：${data.name}`,
    data.hypothesis ? `假設：${data.hypothesis}` : null,
    data.intervention ? `做法：${data.intervention}` : null,
    `觀察指標：${data.target_metric}`,
    `期間：${today} ～ ${addDays(today, data.duration_days - 1)}（${data.duration_days} 天）`,
    `對照期：${baselineStart} ～ ${baselineEnd}`,
    '',
    '結束後用 /experiment stop 收尾，我會做前後對照。',
    '（提醒：這是 n=1 的個人前後比較，只能看出關聯，不能證明因果。）',
  ].filter(Boolean).join('\n');
}

/** /experiment list */
export async function renderList(db) {
  const all = await db.listExperiments({});
  if (!all.length) {
    return '目前沒有任何實驗。用 /experiment create 建立一個。';
  }
  const lines = ['🧪 實驗清單', ''];
  for (const e of all) {
    const metrics = JSON.parse(e.target_metrics ?? '[]').join('、');
    lines.push(`#${e.id} ${e.name}  [${e.status}]`);
    lines.push(`   指標：${metrics || '未指定'}`);
    if (e.start_date) lines.push(`   期間：${e.start_date} ～ ${e.end_date ?? '進行中'}`);
    lines.push('');
  }
  return lines.join('\n');
}

/** /experiment status [id] */
export async function renderStatus({ db, rows, id, timezone, now }) {
  const list = await db.listExperiments({});
  const exp = id
    ? list.find((e) => Number(e.id) === Number(id))
    : list.find((e) => e.status === EXPERIMENT_STATUS.RUNNING) ?? list[0];

  if (!exp) return '目前沒有任何實驗。用 /experiment create 建立一個。';

  const lines = [
    `🧪 #${exp.id} ${exp.name}`,
    `狀態：${exp.status}`,
    exp.hypothesis ? `假設：${exp.hypothesis}` : null,
    exp.start_date ? `期間：${exp.start_date} ～ ${exp.end_date ?? '進行中'}` : null,
    exp.baseline_start ? `對照期：${exp.baseline_start} ～ ${exp.baseline_end}` : null,
    '',
  ].filter(Boolean);

  // 進行中的實驗還沒有 end_date。用「今天」當暫定結束日，
  // 這樣可以看到目前為止的進度，而不是只回一句「缺少期間日期」。
  const provisional = exp.end_date
    ? exp
    : { ...exp, end_date: localDate(now, timezone) };
  const result = analyseExperimentData({ rows, experiment: provisional });
  if (!result.ok) {
    lines.push('目前還無法分析（缺少期間日期）。');
    return lines.join('\n');
  }

  let anySufficient = false;
  for (const m of Object.values(result.metrics)) {
    if (!m.sufficient) {
      lines.push(`${m.metric}：資料還不夠`
        + `（對照期 ${m.baseline_n} 天 / 實驗期 ${m.intervention_n} 天，`
        + `各需至少 ${m.required_per_period} 天）`);
      continue;
    }
    anySufficient = true;
    lines.push(`${m.metric}：`);
    lines.push(`  對照期平均 ${m.baseline_mean.toFixed(2)}（n=${m.baseline_n}）`);
    lines.push(`  實驗期平均 ${m.intervention_mean.toFixed(2)}（n=${m.intervention_n}）`);
    lines.push(`  差異 ${m.mean_difference >= 0 ? '+' : ''}${m.mean_difference.toFixed(2)}`
      + `${m.effect_size !== null ? `，effect size ${m.effect_size.toFixed(2)}` : ''}`);
  }

  if (anySufficient) {
    lines.push('');
    lines.push('註：這是 within-person observed association（個人層級的前後關聯），');
    lines.push('不是因果證明。時間本身的變化（季節、生活作息）無法排除。');
  }
  return lines.join('\n');
}

/** /experiment stop [id] */
export async function stopExperiment({ db, id, timezone, now }) {
  const list = await db.listExperiments({ status: EXPERIMENT_STATUS.RUNNING });
  const exp = id ? list.find((e) => Number(e.id) === Number(id)) : list[0];
  if (!exp) return '目前沒有進行中的實驗。';

  const today = localDate(now, timezone);
  const r = await completeExperiment(db, Number(exp.id), { endDate: today, now });
  if (!r.ok) return `無法結束：${r.error}`;
  return `✅ 實驗 #${exp.id}「${exp.name}」已結束（${exp.start_date} ～ ${today}）。\n用 /experiment status ${exp.id} 看前後對照結果。`;
}
