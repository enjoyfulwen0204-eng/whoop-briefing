/**
 * AI 用量與成本帳本（Phase AE）。
 *
 * ## 兩條鐵律
 *
 * 1. **絕不猜 token 數。** provider 沒回 usage 就記 null，成本也記 null。
 *    寧可顯示「成本不明」，也不要給一個看起來精確、其實是編的數字。
 * 2. **記帳失敗不可以影響主要功能。** 所有寫入都包在 try/catch 裡，
 *    最壞情況是少一筆帳，不是簡報發不出去。
 */

import { AI_PURPOSE, PRICING_VERSION, loadPricing } from './config.js';
import { requireUserId } from './userContext.js';
import { localDate } from './time.js';
import { log } from './logger.js';

/**
 * 算一次呼叫的成本。
 *
 * @returns {?number} 價格表沒有這個模型、或沒有 token 數 → null（不猜）
 */
export function computeCost({ model, inputTokens, outputTokens, pricing = loadPricing() }) {
  if (!model) return null;
  const p = pricing[model];
  if (!p) return null;                                   // 未知模型 → 不猜
  if (inputTokens === null || inputTokens === undefined) return null;
  if (outputTokens === null || outputTokens === undefined) return null;

  const inRate = Number(p.input_per_million);
  const outRate = Number(p.output_per_million);
  if (!Number.isFinite(inRate) || !Number.isFinite(outRate)) return null;

  return (Number(inputTokens) / 1_000_000) * inRate
    + (Number(outputTokens) / 1_000_000) * outRate;
}

/** OpenRouter 的 usage 物件 → 我們的欄位。缺就是 null。 */
export function extractTokens(usage) {
  if (!usage || typeof usage !== 'object') {
    return { inputTokens: null, outputTokens: null, totalTokens: null };
  }
  const pick = (...keys) => {
    for (const k of keys) {
      const v = usage[k];
      if (v !== null && v !== undefined && Number.isFinite(Number(v))) return Number(v);
    }
    return null;
  };
  const input = pick('prompt_tokens', 'input_tokens');
  const output = pick('completion_tokens', 'output_tokens');
  const total = pick('total_tokens')
    ?? (input !== null && output !== null ? input + output : null);
  return { inputTokens: input, outputTokens: output, totalTokens: total };
}

/**
 * 記一筆用量。**永遠不拋錯。**
 * db 沒有 recordAiUsage（舊 db shape）時安靜跳過。
 */
/**
 * @param {?string} userId 使用者發起的用量**必填**；系統層用量明確傳 null。
 *   不傳（undefined）視為實作錯誤 → 拋錯，避免把使用者流量誤記成系統用量。
 */
export async function recordUsage(db, userId, entry, { now = new Date() } = {}) {
  // 沒有 db 就根本不記帳，所有權問題不存在（測試 / dry-run 常走這條）
  if (!db || typeof db.recordAiUsage !== 'function') return null;
  // 有 db 卻沒明確指定所有者 → 實作錯誤。
  // 絕不把使用者發起的流量默默記成系統用量。
  if (userId === undefined) {
    throw new Error(
      'recordUsage 需要明確的 userId（使用者發起的用量必填；系統層用量請明確傳 null）',
    );
  }
  const uid = userId === null ? null : requireUserId(userId, 'recordUsage');
  try {
    const cost = computeCost({
      model: entry.model,
      inputTokens: entry.inputTokens,
      outputTokens: entry.outputTokens,
    });
    const id = await db.recordAiUsage(uid, {
      ...entry,
      estimatedCostUsd: cost,
      pricingVersion: cost === null ? null : PRICING_VERSION,
    }, { now });
    log.info('ai_usage_recorded', {
      user_id: uid,
      purpose: entry.purpose,
      model: entry.model,
      requested_model: entry.requestedModel,
      fallback: Boolean(entry.fallbackOccurred),
      status: entry.requestStatus,
      total_tokens: entry.totalTokens,
      cost_known: cost !== null,
      latency_ms: entry.latencyMs,
    });
    return id;
  } catch (err) {
    // 記帳壞掉絕不能拖垮簡報 / 問答
    log.warn('ai_usage_record_failed', {
      purpose: entry?.purpose, error: String(err?.message ?? err).slice(0, 200),
    });
    return null;
  }
}

/** purpose → /cost 上顯示的分組。 */
export const COST_GROUPS = {
  [AI_PURPOSE.DAILY]: 'Daily',
  [AI_PURPOSE.WEEKLY]: 'Weekly',
  [AI_PURPOSE.QA]: 'Q&A',
  [AI_PURPOSE.FOLLOWUP]: 'Q&A',
  [AI_PURPOSE.INTENT_PARSE]: 'Parsing',
  [AI_PURPOSE.JOURNAL_PARSE]: 'Parsing',
  [AI_PURPOSE.EXPERIMENT]: 'Other',
  [AI_PURPOSE.OTHER]: 'Other',
};

function summariseRows(rows) {
  const groups = {};
  let total = 0;
  let known = 0;
  let unknown = 0;
  let calls = 0;
  let failed = 0;

  for (const r of rows) {
    calls += 1;
    if (r.request_status !== 'OK') failed += 1;
    const group = COST_GROUPS[r.purpose] ?? 'Other';
    if (!groups[group]) groups[group] = { cost: 0, calls: 0, unknown_cost_calls: 0 };
    groups[group].calls += 1;

    const cost = r.estimated_cost_usd;
    if (cost === null || cost === undefined) {
      groups[group].unknown_cost_calls += 1;
      unknown += 1;
    } else {
      groups[group].cost += Number(cost);
      total += Number(cost);
      known += 1;
    }
  }

  return {
    calls,
    failed_calls: failed,
    groups,
    total_cost_usd: known > 0 ? total : null,
    calls_with_known_cost: known,
    calls_with_unknown_cost: unknown,
  };
}

/**
 * /cost 用的摘要：今天 + 本月。
 * 沒有任何紀錄時回結構完整的空摘要（不是錯誤）。
 */
/** @param {string} userId **必填**。/cost 只看自己的用量。 */
export async function costSummary({ db, userId, timezone, now = new Date() }) {
  const uid = requireUserId(userId, 'costSummary');
  const today = localDate(now, timezone);
  const monthStart = `${today.slice(0, 7)}-01`;

  const empty = { calls: 0, failed_calls: 0, groups: {}, total_cost_usd: null, calls_with_known_cost: 0, calls_with_unknown_cost: 0 };
  if (!db || typeof db.getAiUsage !== 'function') {
    return { today, available: false, reason: 'no_ledger', todaySummary: empty, monthSummary: empty };
  }

  try {
    const monthRows = await db.getAiUsage(uid, {
      fromIso: `${monthStart}T00:00:00.000Z`,
      toIso: `${today}T23:59:59.999Z`,
    });
    // 用當地日期分組（timestamp 是 UTC，要換算才不會把跨日的算錯）
    const todayRows = monthRows.filter((r) => localDate(r.timestamp, timezone) === today);
    return {
      today,
      month: today.slice(0, 7),
      available: true,
      todaySummary: summariseRows(todayRows),
      monthSummary: summariseRows(monthRows),
    };
  } catch (err) {
    log.warn('cost_summary_failed', { error: String(err?.message ?? err).slice(0, 200) });
    return { today, available: false, reason: 'query_failed', todaySummary: empty, monthSummary: empty };
  }
}

const fmt = (v) => `$${v.toFixed(v < 0.01 ? 4 : 3)}`;

/** /cost 的 Telegram 文字。 */
export function renderCost(summary) {
  const lines = ['💰 AI 使用成本', ''];

  if (!summary.available) {
    lines.push('目前沒有可用的用量紀錄。');
    return lines.join('\n');
  }

  const section = (title, s) => {
    lines.push(title);
    if (s.calls === 0) {
      lines.push('  （沒有呼叫紀錄）');
      return;
    }
    const names = Object.keys(s.groups).sort();
    for (const name of names) {
      const g = s.groups[name];
      const costPart = g.unknown_cost_calls === g.calls
        ? 'cost unavailable'
        : `${fmt(g.cost)}${g.unknown_cost_calls ? `（另有 ${g.unknown_cost_calls} 次無 token 資料）` : ''}`;
      lines.push(`  ${name}: ${costPart}`);
    }
    lines.push(`  Total: ${s.total_cost_usd === null ? 'cost unavailable' : fmt(s.total_cost_usd)}`);
    lines.push(`  （${s.calls} 次呼叫${s.failed_calls ? `，${s.failed_calls} 次失敗` : ''}）`);
    if (s.calls_with_unknown_cost > 0) {
      lines.push(`  ⚠️ ${s.calls_with_unknown_cost} 次沒有 token 用量資料，成本未估算`);
    }
  };

  section(`今天（${summary.today}）`, summary.todaySummary);
  lines.push('');
  section(`本月（${summary.month}）`, summary.monthSummary);

  lines.push('');
  lines.push('註：成本依內建價格表估算，供參考用；價格表可能與實際帳單有落差。');
  return lines.join('\n');
}
