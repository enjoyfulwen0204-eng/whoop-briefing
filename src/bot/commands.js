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
import { INSIGHT_STATUS } from '../healthMemory.js';
import { assessPrediction, assessProactiveMonitoring, READINESS_STATUS } from '../readiness.js';
import { deriveColdStartStage, COLD_START_STAGE } from '../proactiveMessages.js';
import { READINESS_HEURISTICS } from '../config.js';
import { addDays, localDate } from '../time.js';
import { seriesOf } from '../dailyMetrics.js';
import { log } from '../logger.js';

/**
 * /help —— **動態**列出目前真的能用的功能。
 *
 * 刻意不把「還沒有資料的分析」講得像已經有結論。
 * 沒有 WHOOP 資料時，健康問答那一區會明講「目前還不能用」。
 */
export function buildHelp({ report, insightCount = 0, predictionReady = false }) {
  const hasData = report?.has_any_health_data;
  const lines = ['🤖 我可以做這些事', ''];

  lines.push('【現在就能用】');
  lines.push('/log — 記錄事件，例如 /log alcohol 3 drinks');
  lines.push('       也可以直接講「昨天喝了三杯酒」「今天飛胡志明」');
  lines.push('/journal — 看最近的記錄（/journal 7、/journal 30）');
  lines.push('/healthdata — 資料同步與涵蓋狀況');
  lines.push('/status — 系統整體狀態');
  lines.push('/cost — AI 使用成本');
  lines.push('/experiment — 建立與追蹤自我實驗');
  lines.push('/help — 這則說明');
  lines.push('');

  if (hasData) {
    lines.push('【健康問答】直接用中文問我：');
    lines.push('· 我今天狀態怎樣？');
    lines.push('· 最近 HRV 如何？');
    lines.push('· 最近睡眠有沒有變差？');
    lines.push('· 最近 30 天最好是哪一天？');
    lines.push('· 今天最值得注意的是什麼？');
    lines.push('');
  } else {
    lines.push('【還不能用（等 WHOOP 資料）】');
    lines.push('· 健康問答 —— 目前沒有任何生理資料可以分析');
    lines.push('');
  }

  lines.push('【長期分析】');
  lines.push(`/insights — 長期規律${insightCount > 0 ? `（目前 ${insightCount} 項）` : '（目前尚未形成）'}`);
  lines.push(`/predictions — 恢復預測${predictionReady ? '' : '（資料量還不足）'}`);
  lines.push('/evidence — 目前結論背後的證據與樣本數');

  return lines.join('\n');
}

/** 保留舊常數給既有測試與呼叫端（靜態版本）。 */
export const HELP_TEXT = buildHelp({ report: { has_any_health_data: false } });

export function startText(report) {
  const lines = ['👋 WHOOP 健康助理已啟動。', ''];
  if (!report.has_any_health_data) {
    lines.push('目前還沒有同步到任何健康資料。');
    lines.push('等手錶開始產生資料、並完成 WHOOP 授權之後，我會自動開始分析 —— 你不需要再做任何設定。');
    lines.push('');
    lines.push('在那之前你已經可以用的功能：');
    lines.push('· /log 記錄喝酒、咖啡、生病、旅行等事件（會完整保存，之後可以拿來對照）');
    lines.push('· /healthdata 看目前的資料狀態');
    lines.push('· /help 看完整說明');
  } else {
    lines.push(`目前有 ${report.sleep_count} 天睡眠資料`
      + `（${report.history_start} ～ ${report.history_end}）。`);
    lines.push('');
    lines.push('直接問我問題就好，例如「我今天狀態怎樣？」。/help 看更多。');
  }
  return lines.join('\n');
}

/**
 * /log 處理。
 * 先試確定性解析；失敗且有 coach 時，再讓 LLM 提案（仍要過 validate）。
 */
export async function handleLog({ db, userId, argsText, rawText, timezone, now, coach, parseNatural }) {
  const parsed = parseLogCommand(`/log ${argsText}`, { now, timezone });

  if (parsed.ok) {
    const saved = await saveEvent(db, userId, parsed.event, { now, timezone });
    if (!saved.ok) return `⚠️ 這筆記錄有問題：${saved.errors.join(', ')}`;
    return `✅ 已記錄：${describeEvent(saved.event)}`;
  }

  // 確定性解析失敗 → 試自然語言
  if (parseNatural && argsText) {
    const nat = await parseNatural({ text: argsText, now, timezone, coach });
    if (nat.ok) {
      const saved = await saveEvent(db, userId, nat.event, { now, timezone });
      if (saved.ok) return `✅ 已記錄：${describeEvent(saved.event)}`;
    }
  }

  // 欄位名刻意不叫 token —— logger 的遮蔽清單把 'token' 當機密，
  // 用那個名字會讓這行 debug 資訊被 [REDACTED] 掉，等於白記。
  log.info('log_command_unparsed', { error: parsed.error, unknown_word: parsed.token });
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
export async function handleHealthData({ db, userId, timezone, now }) {
  const report = await buildDataQualityReport({ db, userId, timezone, now });
  return renderDataQuality(report);
}


// ---------------------------------------------------------------------------
// /status
// ---------------------------------------------------------------------------
export async function handleStatus({ db, userId, timezone, now, rows = [] }) {
  const report = await buildDataQualityReport({ db, userId, timezone, now });
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

/** /status 裡「Proactive Agent」那幾行。獨立成函式方便測試。 */
export async function renderProactiveStatusLines({ db, userId, timezone, rows = [], now }) {
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
export async function handleJournal({ db, userId, argsText, timezone, now }) {
  const n = Number(String(argsText ?? '').trim());
  const days = Number.isFinite(n) && n >= 1 && n <= 365 ? Math.floor(n) : 14;

  const to = localDate(now, timezone);
  const from = addDays(to, -(days - 1));
  const events = await db.getJournalEvents(userId, { from, to, limit: 100 });

  if (!events.length) {
    return `目前沒有 Journal 紀錄。\n\n（最近 ${days} 天內）用 /log 開始記錄，例如 /log alcohol 3 drinks`;
  }

  const lines = [`📓 最近 ${days} 天的記錄（${events.length} 筆）`, ''];
  const byDate = {};
  for (const e of events) {
    (byDate[e.health_date] ??= []).push(e);
  }
  for (const date of Object.keys(byDate).sort().reverse()) {
    lines.push(date);
    for (const e of byDate[date]) {
      const amount = e.numeric_value === null || e.numeric_value === undefined
        ? '' : ` ${e.numeric_value}${e.unit ? ` ${e.unit}` : ''}`;
      lines.push(`  · ${e.category}${e.subtype ? `/${e.subtype}` : ''}${amount}`);
    }
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// /insights [history]
// ---------------------------------------------------------------------------
export async function handleInsights({ db, userId, argsText }) {
  const wantHistory = /^history$/i.test(String(argsText ?? '').trim());

  let all = [];
  try {
    all = await db.getActiveInsights(userId, {});
  } catch { /* 沒表就當空的 */ }

  // 預設只顯示 SUPPORTED / EMERGING / HYPOTHESIS，不顯示 RETIRED
  const visible = all.filter((i) => [
    INSIGHT_STATUS.SUPPORTED, INSIGHT_STATUS.EMERGING, INSIGHT_STATUS.HYPOTHESIS,
  ].includes(i.status));

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
export async function handlePredictions({ db, userId, rows = [] }) {
  const lines = ['🔮 恢復預測', ''];

  // 用 readiness engine 判斷，不在這裡重複 MIN_TRAIN_ROWS 的門檻邏輯——
  // prediction.js 的 train() 本身用的是「D 天特徵 → D+1 天結果」配對數，
  // 不是原始列數，assessPrediction() 已經正確算過這件事。
  const readiness = assessPrediction({ rows });

  if (readiness.status !== READINESS_STATUS.READY) {
    lines.push('狀態：INSUFFICIENT_DATA');
    lines.push('');
    lines.push(`目前可用樣本：${readiness.usable_samples} 筆`);
    lines.push(`最低需求：${readiness.required_samples} 筆`);
    lines.push('');
    lines.push('資料量還不足以訓練預測模型，所以我不會給你任何預測數字。');
    lines.push('（一個沒有足夠資料支撐的預測，比沒有預測更糟。）');
  } else {
    lines.push('狀態：可訓練');
    lines.push(`可用樣本：${readiness.usable_samples} 筆`);
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

// ---------------------------------------------------------------------------
// /cost
// ---------------------------------------------------------------------------
export async function handleCost({ db, userId, timezone, now }) {
  const summary = await costSummary({ db, userId, timezone, now });
  return renderCost(summary);
}

// ---------------------------------------------------------------------------
// /evidence
// ---------------------------------------------------------------------------
export async function handleEvidence({ db, userId, now }) {
  const result = await getEvidence({ db, userId, now });
  return renderEvidence(result);
}
