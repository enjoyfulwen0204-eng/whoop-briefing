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
import { t, formatLocalDate, formatNumber } from './localization.js';

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
export function renderDataQuality(r, locale = 'zh-TW') {
  return renderLocalizedDataQuality(r, locale);
}

export function renderMissingScopes(locale, scopes) {
  const names = { 'read:workout':'workout', 'read:body_measurement':'bodyMeasurement' };
  return scopes.map(scope => t(locale, `quality.scopeName.${names[scope] ?? 'other'}`)).join(', ');
}

function renderLocalizedDataQuality(r, locale) {
  const line = (key, vars = {}) => t(locale, `quality.${key}`, vars);
  const n = value => formatNumber(locale, value ?? 0);
  const lines = [line('title'), ''];
  if (r.state === 'NO_AUTH') lines.push(line('noAuth'), '');
  if (!r.has_any_health_data) {
    lines.push(line('notStarted'),
      line('sleep', { count: n(0) }),
      line('recovery', { count: n(0), scored: n(0) }),
      line('workouts', { count: n(0) }),
      line('naps', { count: n(0) }));
  } else {
    lines.push(line('history', {
      from: formatLocalDate(r.history_start, locale),
      to: formatLocalDate(r.history_end, locale),
    }));
    lines.push(line('coverage', {
      days: n(r.coverage_days), missing: n(r.missing_days),
      ratio: r.coverage_ratio == null ? '—' : n(Math.round(r.coverage_ratio * 100)),
    }));
    lines.push(line('sleep', { count: n(r.sleep_count) }),
      line('recovery', { count: n(r.recovery_count), scored: n(r.valid_recoveries) }),
      line('cycles', { count: n(r.cycle_count) }),
      line('workouts', { count: n(r.workout_count) }),
      line('naps', { count: n(r.nap_count) }),
      line('unscored', { count: n(r.unscored_records) }));
    if (r.days_behind > 1) lines.push(line('stale', { days: n(r.days_behind) }));
  }
  lines.push('', line('journal', { count: n(r.journal_count) }), '');
  lines.push(r.capabilities.probed ? line('probeDone', {
    date: r.capabilities.lastProbedAt
      ? formatLocalDate(r.capabilities.lastProbedAt.slice(0, 10), locale) : '—',
  }) : line('probePending'));
  if (r.capabilities.probed) {
    const c = r.capabilities.counts;
    lines.push(line('capabilities', {
      supported: n(c.SUPPORTED), partial: n(c.PARTIAL),
      unavailable: n(c.UNAVAILABLE), unknown: n(c.UNKNOWN),
    }));
  }
  const backfill = Object.entries(r.backfill_status);
  lines.push('', line('backfill', { status: line(backfill.length === 0
    ? 'backfillPending' : r.backfill_complete ? 'backfillComplete' : 'backfillRunning') }));
  const known = new Set(['sleep','recovery','cycle','workout','profile','body_measurement']);
  for (const [resource, state] of backfill) lines.push(line('resource', {
    resource: line(`resourceName.${known.has(resource) ? resource : 'other'}`),
    status: state.complete ? '✅' : '⏳',
  }));
  if (r.missing_scopes.length) lines.push('', line('scopeMissing', {
    scopes: renderMissingScopes(locale, r.missing_scopes),
  }), line('scopeAdvice'));
  return lines.join('\n');
}
