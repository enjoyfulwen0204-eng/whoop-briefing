/**
 * 資料品質報告（Phase P）。
 *
 * ## 「沒有資料」不是錯誤
 *
 * 手錶還沒到、還沒授權、還沒 backfill —— 這些都是正常狀態。
 * 這個 service 一律回一份結構完整的報告，欄位是 0 或 null，
 * 絕不拋錯、也絕不把「還沒開始」講成「壞掉」。
 */

import { STATUS } from './capabilities.js';
import { requireUserId } from './userContext.js';
import { daysBetween, localDate } from './time.js';
import { log } from './logger.js';

/** 每個查詢都獨立包起來，一個失敗不影響其他。 */
async function safe(label, fn, fallback) {
  try {
    return await fn();
  } catch (err) {
    log.warn('data_quality_part_failed', {
      part: label, error: String(err?.message ?? err).slice(0, 200),
    });
    return fallback;
  }
}

/**
 * 完整的資料品質報告。
 *
 * @returns 永遠是一個完整物件，never throws
 */
/** @param {string} userId **必填**。只評估這個使用者的資料品質。 */
export async function buildDataQualityReport({ db, userId, timezone, now = new Date() }) {
  const uid = requireUserId(userId, 'buildDataQualityReport');
  const today = localDate(now, timezone);

  const coverage = await safe('coverage', () => db.coverage(uid), null);
  const syncStates = await safe('sync', () => db.getAllSyncState(uid), []);
  const capabilities = await safe('capabilities', () => db.getCapabilities(uid), {});
  const journalCount = await safe('journal', () => db.countJournalEvents(uid), 0);
  const tokens = await safe('tokens', () => db.getTokens(uid), null);

  const mainSleeps = Number(coverage?.main_sleeps ?? 0);
  const historyStart = coverage?.first_date ?? null;
  const historyEnd = coverage?.last_date ?? null;

  const coverageDays = historyStart && historyEnd
    ? daysBetween(historyEnd, historyStart) + 1
    : 0;
  const missingDays = coverageDays > 0 ? Math.max(0, coverageDays - mainSleeps) : 0;
  const coverageRatio = coverageDays > 0 ? mainSleeps / coverageDays : null;

  // backfill 進度
  const backfill = {};
  for (const s of syncStates) {
    backfill[s.resource] = {
      complete: Number(s.backfill_complete) === 1,
      cursor: s.backfill_cursor ?? null,
      lastSuccessAt: s.last_success_at ?? null,
      lastError: s.last_error ?? null,
    };
  }
  const allComplete = syncStates.length > 0
    && syncStates.every((s) => Number(s.backfill_complete) === 1);

  // capability 摘要
  const capList = Object.values(capabilities);
  const capSummary = {
    probed: capList.length > 0,
    lastProbedAt: capList[0]?.lastProbedAt ?? null,
    counts: {},
  };
  for (const st of Object.values(STATUS)) {
    capSummary.counts[st] = capList.filter((c) => c.status === st).length;
  }

  // token scope
  const scope = tokens?.scope ?? null;
  const missingScopes = ['read:workout', 'read:body_measurement']
    .filter((s) => !String(scope ?? '').includes(s));

  const hasAnyHealthData = mainSleeps > 0;

  return {
    generatedAt: now.toISOString(),
    today,

    // 歷史
    history_start: historyStart,
    history_end: historyEnd,
    coverage_days: coverageDays,
    missing_days: missingDays,
    coverage_ratio: coverageRatio,
    latest_health_date: historyEnd,
    days_behind: historyEnd ? daysBetween(today, historyEnd) : null,

    // 各表筆數
    sleep_count: mainSleeps,
    nap_count: Number(coverage?.naps ?? 0),
    recovery_count: Number(coverage?.recoveries ?? 0),
    valid_recoveries: Number(coverage?.scored_recoveries ?? 0),
    unscored_records: Number(coverage?.unscored_sleeps ?? 0),
    cycle_count: Number(coverage?.cycles ?? 0),
    workout_count: Number(coverage?.workouts ?? 0),
    journal_count: journalCount,

    // 同步
    backfill_status: backfill,
    backfill_complete: allComplete,
    last_sync: syncStates
      .map((s) => s.last_success_at)
      .filter(Boolean)
      .sort()
      .pop() ?? null,

    // 能力與授權
    capabilities: capSummary,
    token_present: Boolean(tokens),
    scope,
    missing_scopes: missingScopes,

    // 給上層決定要不要做分析
    has_any_health_data: hasAnyHealthData,
    state: deriveState({ tokens, hasAnyHealthData, allComplete, probed: capSummary.probed }),
  };
}

/** 一句話描述系統現在處於哪個階段。 */
function deriveState({ tokens, hasAnyHealthData, allComplete, probed }) {
  if (!tokens) return 'NO_AUTH';
  if (!hasAnyHealthData) return 'NO_DATA';
  if (!probed) return 'NOT_PROBED';
  if (!allComplete) return 'BACKFILL_IN_PROGRESS';
  return 'READY';
}

/** 報告 → Telegram 純文字（/healthdata 用）。 */
export function renderDataQuality(r) {
  const lines = ['📊 WHOOP 資料狀態', ''];

  if (r.state === 'NO_AUTH') {
    lines.push('尚未完成 WHOOP 授權。');
    lines.push('（在本機跑一次 npm run authorize 就會開始。）', '');
  }

  if (!r.has_any_health_data) {
    lines.push('歷史資料：尚未開始');
    lines.push('睡眠：0 筆');
    lines.push('恢復：0 筆');
    lines.push('運動：0 筆');
    lines.push('小睡：0 筆');
  } else {
    lines.push(`歷史區間：${r.history_start} ～ ${r.history_end}`);
    lines.push(`涵蓋天數：${r.coverage_days} 天（缺 ${r.missing_days} 天${
      r.coverage_ratio !== null ? `，涵蓋率 ${(r.coverage_ratio * 100).toFixed(0)}%` : ''}）`);
    lines.push(`睡眠：${r.sleep_count} 筆`);
    lines.push(`恢復：${r.recovery_count} 筆（已評分 ${r.valid_recoveries}）`);
    lines.push(`週期：${r.cycle_count} 筆`);
    lines.push(`運動：${r.workout_count} 筆`);
    lines.push(`小睡：${r.nap_count} 筆`);
    lines.push(`未評分：${r.unscored_records} 筆`);
    if (r.days_behind !== null && r.days_behind > 1) {
      lines.push(`⚠️ 最新資料已落後 ${r.days_behind} 天`);
    }
  }

  lines.push('', `Journal 紀錄：${r.journal_count} 筆`);

  lines.push('', `Capability probe：${r.capabilities.probed
    ? `已執行（${r.capabilities.lastProbedAt?.slice(0, 10) ?? ''}）`
    : '尚未執行'}`);
  if (r.capabilities.probed) {
    const c = r.capabilities.counts;
    lines.push(`  可用 ${c.SUPPORTED ?? 0}／部分 ${c.PARTIAL ?? 0}／`
      + `不可用 ${c.UNAVAILABLE ?? 0}／未知 ${c.UNKNOWN ?? 0}`);
  }

  const bf = Object.entries(r.backfill_status);
  lines.push('', `Backfill：${bf.length === 0 ? '尚未開始' : (r.backfill_complete ? '已完成' : '進行中')}`);
  for (const [res, s] of bf) {
    lines.push(`  ${res}: ${s.complete ? '✅' : '⏳'}${s.lastError ? ` (${s.lastError})` : ''}`);
  }

  if (r.missing_scopes.length) {
    lines.push('', `⚠️ token 缺少 scope：${r.missing_scopes.join(', ')}`);
    lines.push('（重跑 npm run authorize 即可，不影響現有簡報）');
  }

  return lines.join('\n');
}
