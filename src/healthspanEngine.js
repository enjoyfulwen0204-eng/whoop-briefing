/**
 * Personal Healthspan 引擎（V1.1 Phase 12）。
 *
 * 在這之前，healthspan.js 的 contributor 盤點是完整的，但
 * `snapshotContributors()` **沒有任何生產呼叫端** —— 兩張 healthspan 表
 * 在正常運作下永遠是空的。這個檔案把它接進 cron，並在上面加一層
 * 明確的成熟度階梯與（尚未啟用的）計分框架。
 *
 * ## 分工
 *
 *   healthspan.js         contributor 盤點（既有，不重寫）
 *   healthspanPolicy.js   成熟度定義、權重（全部 null）、發布閘門
 *   healthspanEngine.js   把兩者組起來 + 持久化
 *
 * ## 這裡不會做的事
 *
 * 不算生理年齡、不輸出任何合成分數、不跟任何族群比較、不使用 WHOOP
 * 專有的名詞。分數欄位永遠寫入 null，而那是**正確答案**，不是待辦事項。
 */

import { requireUserId } from './userContext.js';
import { assessHealthspanFoundation, READINESS_STATUS } from './readiness.js';
import { buildContributors, AVAILABILITY } from './healthspan.js';
import {
  HEALTHSPAN_ALGORITHM_VERSION, HEALTHSPAN_MATURITY, HEALTHSPAN_POLICY,
  HEALTHSPAN_POLICY_VERSION, hasQualifiedScoringPolicy, historyTierLabel, publishableScore,
} from './healthspanPolicy.js';
import { log, describeError } from './logger.js';

/**
 * readiness 狀態 → 成熟度。**純函式。**
 *
 * 刻意與 proactiveMessages.deriveColdStartStage() 同一個形狀：由 readiness
 * 決定，不看日曆天數。
 *
 * 注意 READY 對應到的是 STRUCTURALLY_READY 而不是 QUALIFIED —— 「資料夠了」
 * 與「有一套可信的公式」是兩件完全不同的事，而後者目前不成立。
 */
export function maturityFromReadiness(status, { policy = HEALTHSPAN_POLICY } = {}) {
  switch (status) {
    case READINESS_STATUS.NO_DATA:
      return HEALTHSPAN_MATURITY.NO_DATA;
    case READINESS_STATUS.WARMING_UP:
      return HEALTHSPAN_MATURITY.WARMING_UP;
    case READINESS_STATUS.LIMITED:
      return HEALTHSPAN_MATURITY.LIMITED;
    case READINESS_STATUS.READY:
      return hasQualifiedScoringPolicy({ policy })
        ? HEALTHSPAN_MATURITY.QUALIFIED
        : HEALTHSPAN_MATURITY.STRUCTURALLY_READY;
    // DEGRADED / UNAVAILABLE：保守當成還不能講話
    default:
      return HEALTHSPAN_MATURITY.NO_DATA;
  }
}

/**
 * 算出一份完整的 Personal Healthspan 評估。**純函式，不碰 DB。**
 *
 * @param {object[]} rows daily_metrics
 * @param {object} capabilities db.getCapabilities() 的輸出
 */
export function buildPersonalHealthspan(rows = [], {
  endDate = null, windowDays = 90, capabilities = {}, policy = HEALTHSPAN_POLICY,
} = {}) {
  // ★ M-10：錨點必須是**最新**的健康日，而且不可以依賴陣列順序。
  //
  // 舊版寫 `rows[rows.length - 1]`，也就是假設 rows 是「舊→新」。但這個
  // 系統的 daily metrics 是**新→舊**：`buildObservations()` 用
  // `b.endUtc - a.endUtc` 排序，`healthQuery.js` 全篇也都拿 `rows[0]` 當
  // 「最新」、`rows[at(-1)]` 當「最早」。所以 `/healthspan` 的錨點取到的是
  // **最舊**的那一天。
  //
  // 後果不是差一天：以 120 天歷史為例，錨點會落在 119 天前，90 天窗口
  // 於是覆蓋「四個月前到七個月前」，整份盤點都在描述一段早就過去的時間。
  // 而且畫面上不會有任何地方看起來壞掉。
  //
  // 這裡直接取 max(health_date)：與順序無關，兩個呼叫端（cron 傳 endDate、
  // bot 不傳）都不可能再被順序假設咬到。
  const latestHealthDate = () => {
    let best = null;
    for (const r of rows) {
      const d = r?.health_date;
      if (typeof d !== 'string' || !d) continue;
      if (best === null || d > best) best = d;
    }
    return best;
  };
  const anchor = endDate ?? latestHealthDate();
  const contributors = buildContributors(rows, { endDate: anchor, windowDays, capabilities });

  const readiness = assessHealthspanFoundation({ contributors });

  // ⚠️ 完全沒有資料時必須是 NO_DATA。
  //
  // assessHealthspanFoundation 只有在「連一個非 APP_ONLY 的 contributor
  // 都沒有」時才回 NO_DATA，而 contributor 清單是靜態的，所以那個分支實際上
  // 永遠不會發生——零資料會落到 WARMING_UP。對 readiness 來說那沒問題
  // （它描述的是「有沒有 contributor 算得出值」），但對使用者來說，
  // 「一筆資料都沒有」與「有資料但還在暖機」是完全不同的兩件事，
  // 混在一起會讓全新帳號看到「校準中」而以為系統已經在讀他的資料了。
  const maturity = anchor
    ? maturityFromReadiness(readiness.status, { policy })
    : HEALTHSPAN_MATURITY.NO_DATA;

  // 覆蓋率只算「這個帳號拿得到的」——APP_ONLY 的三個永遠拿不到，
  // 把它們放進分母只會讓覆蓋率永遠上不去，那是誤導。
  const scoped = contributors.filter((c) => c.availability !== AVAILABILITY.APP_ONLY);
  const usable = scoped.filter(
    (c) => c.availability === AVAILABILITY.AVAILABLE || c.availability === AVAILABILITY.PARTIAL,
  );
  const coverage = scoped.length ? usable.length / scoped.length : 0;

  // 歷史長度純粹是描述性的，不參與任何解鎖判斷
  const historyDays = rows.length;

  return {
    algorithmVersion: HEALTHSPAN_ALGORITHM_VERSION,
    policyVersion: HEALTHSPAN_POLICY_VERSION,
    anchorDate: anchor,
    windowDays,
    maturity,
    readinessStatus: readiness.status,
    contributors,
    usableCount: usable.length,
    scopedCount: scoped.length,
    appOnlyCount: contributors.length - scoped.length,
    coverage,
    historyDays,
    historyTier: historyTierLabel(historyDays, { policy }),
    // ★ 永遠是 null：沒有經過驗證的權重，也沒有打開總開關。
    score: publishableScore({ maturity, score: null, policy }),
    scoreKind: null,
    scoringPolicyActive: hasQualifiedScoringPolicy({ policy }),
  };
}

/**
 * 算完並寫進 healthspan_metrics / healthspan_snapshots。
 *
 * **永遠不拋錯**：這是附加能力，不能拖垮任何東西。
 */
export async function runHealthspanSnapshot({
  db, userId, rows = [], endDate = null, windowDays = 90,
  capabilities = null, now = new Date(),
}) {
  const uid = requireUserId(userId, 'runHealthspanSnapshot');
  try {
    const caps = capabilities ?? await db.getCapabilities(uid).catch(() => ({}));
    const result = buildPersonalHealthspan(rows, {
      endDate, windowDays, capabilities: caps,
    });

    if (!result.anchorDate) {
      // 完全沒有資料 → 不寫任何東西（寫一列全 null 的快照沒有意義）
      return { ...result, saved: false };
    }

    await db.saveHealthspanMetrics(uid, result.contributors, { now });
    await db.saveHealthspanSnapshot(uid, {
      snapshotDate: result.anchorDate,
      algorithmVersion: result.algorithmVersion,
      // ★ 兩個都是 null，而且是刻意的
      score: null,
      scoreKind: null,
      contributors: result.contributors,
      coverage: result.coverage,
      status: result.maturity,
    }, { now });

    log.info('healthspan_snapshot_saved', {
      user_id: uid,
      maturity: result.maturity,
      coverage: Number(result.coverage.toFixed(3)),
      usable: result.usableCount,
      scoped: result.scopedCount,
      // 絕不記錄任何 contributor 的實際數值
    });
    return { ...result, saved: true };
  } catch (err) {
    log.warn('healthspan_snapshot_failed', { user_id: uid, error: describeError(err) });
    return {
      algorithmVersion: HEALTHSPAN_ALGORITHM_VERSION,
      maturity: HEALTHSPAN_MATURITY.NO_DATA,
      score: null,
      scoreKind: null,
      saved: false,
      error: true,
    };
  }
}

/** 成熟度的對外說法。刻意都不承諾「之後會有分數」。 */
const MATURITY_LABEL = {
  [HEALTHSPAN_MATURITY.NO_DATA]: '尚未開始累積',
  [HEALTHSPAN_MATURITY.WARMING_UP]: '校準中',
  [HEALTHSPAN_MATURITY.LIMITED]: '資料有限',
  [HEALTHSPAN_MATURITY.STRUCTURALLY_READY]: '資料充足',
  [HEALTHSPAN_MATURITY.QUALIFIED]: '已啟用',
};

const AVAILABILITY_MARK = {
  [AVAILABILITY.AVAILABLE]: '✅',
  [AVAILABILITY.PARTIAL]: '⚠️',
  [AVAILABILITY.UNAVAILABLE]: '❌',
  [AVAILABILITY.UNKNOWN]: '…',
  [AVAILABILITY.APP_ONLY]: '🚫',
};

/**
 * 渲染成 Telegram 文字。
 *
 * ★ 絕不出現 WHOOP Age / WHOOP Healthspan，絕不輸出任何合成分數或年齡。
 */
export function renderPersonalHealthspan(result) {
  const lines = ['🧬 Personal Healthspan', ''];

  lines.push(`狀態：${MATURITY_LABEL[result.maturity] ?? result.maturity}`);
  if (result.scopedCount) {
    lines.push(`資料覆蓋：${result.usableCount}/${result.scopedCount} 項指標`);
  }
  if (result.historyTier) lines.push(`累積歷史：約${result.historyTier}`);
  lines.push(`演算法版本：${result.algorithmVersion}`);
  lines.push('');

  if (result.maturity === HEALTHSPAN_MATURITY.NO_DATA) {
    lines.push('還沒有可以盤點的資料。等 WHOOP 開始同步之後就會自動開始。');
    return lines.join('\n');
  }

  // 逐項列出「拿不拿得到」——這才是這個功能現在真正能給的東西
  lines.push('目前盤點到的指標：');
  for (const c of result.contributors) {
    const mark = AVAILABILITY_MARK[c.availability] ?? '?';
    const n = c.sampleCount ? `（${c.sampleCount} 筆）` : '';
    lines.push(`  ${mark} ${c.metricKey}${n}`);
  }
  lines.push('');

  if (!result.scoringPolicyActive) {
    // ★ 這是整個功能現階段最重要的一句話
    lines.push('目前**不會**給你一個綜合分數或推估年齡。');
    lines.push('資料底座已經在累積，但還沒有一套經過驗證的計分方式——');
    lines.push('在那之前給出一個數字，只會讓你以為它有意義。');
  }
  lines.push('');
  lines.push('註：這是本系統自己的長期生理盤點，與 WHOOP App 內的任何評分無關。');
  return lines.join('\n');
}
