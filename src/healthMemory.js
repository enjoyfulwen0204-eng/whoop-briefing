/**
 * 長期 insight 記憶（Phase Y）—— **只有基礎建設，不產生任何 insight**。
 *
 * ## 為什麼這一輪不產生
 *
 * 沒有真實 WHOOP 資料。憑空生成的 insight 就是假的健康結論，
 * 那正是這個系統最不該做的事。
 *
 * ## 這裡提供什麼
 *
 * 一套「信念會隨證據改變」的狀態機與版本鏈：
 *
 *   HYPOTHESIS → EMERGING → SUPPORTED
 *        ↑           ↓          ↓
 *        └──────  WEAKENED ─→ RETIRED
 *
 * 舊版本**永遠不刪除**，只標成 RETIRED 並用 supersedes_id 串起來，
 * 所以「我以前相信什麼、為什麼改變」永遠可以回溯。
 */

import { CONFIDENCE, dataQualityOf } from './analytics/correlation.js';
import { log } from './logger.js';
import { requireUserId } from './userContext.js';

export const INSIGHT_STATUS = {
  HYPOTHESIS: 'HYPOTHESIS',
  EMERGING: 'EMERGING',
  SUPPORTED: 'SUPPORTED',
  WEAKENED: 'WEAKENED',
  RETIRED: 'RETIRED',
};

/**
 * 允許的狀態轉移。亂跳會被拒絕，避免狀態機被寫壞。
 *
 * ## 為什麼沒有 「→ HYPOTHESIS」（M-01）
 *
 * HYPOTHESIS 的意思是「還沒有累積到足以判斷的證據」——那是一個**起點**，
 * 不是一個可以回頭的狀態。一個已經被支持過的信念，即使新證據變弱了，
 * 它的歷史也不會消失；它該走的是 WEAKENED（降級）而不是退回未知。
 *
 * 舊版的 bug 正是在這裡：statusFromEvidence() 看到樣本數不足就回
 * HYPOTHESIS，於是 SUPPORTED → HYPOTHESIS 被判成非法轉移、整個修正被拒絕，
 * 而那個**已經沒有證據支持**的 SUPPORTED 信念就這樣繼續有效。
 * 「非法轉移」被當成安全機制，實際上讓過期的健康結論永遠活著。
 */
export const ALLOWED_TRANSITIONS = {
  // HYPOTHESIS 不可以直接跳到 SUPPORTED —— 一次新答案不足以建立一個
  // 「已被支持」的健康規律。這條**不是** M-01 的問題，刻意保留。
  HYPOTHESIS: ['EMERGING', 'WEAKENED', 'RETIRED'],
  EMERGING: ['SUPPORTED', 'WEAKENED', 'RETIRED'],
  SUPPORTED: ['WEAKENED', 'RETIRED'],
  WEAKENED: ['EMERGING', 'SUPPORTED', 'RETIRED'],
  RETIRED: [],
};

export function canTransition(from, to) {
  return (ALLOWED_TRANSITIONS[from] ?? []).includes(to);
}

/**
 * 新證據的**來源狀態** —— 與證據強度完全分開的一個維度（M-01）。
 *
 * ## 這個區分是整個修正的核心
 *
 * 「這次沒有新證據，因為 ingestion 掛了」
 *   ≠
 * 「有新的有效證據，而它不再支持這個關係」
 *
 * 前者對信念**沒有任何資訊**，後者是降級的理由。把兩者混在一起，
 * 系統就會因為一次 WHOOP API 故障而開始拆掉自己的長期記憶 ——
 * 那是用「資料暫時讀不到」偽造出來的「關係不成立」，跟把
 * unknown 變成 0 是同一類錯誤。
 *
 *   AVAILABLE   算出了新的有效證據（不論它強還是弱）
 *   UNAVAILABLE 這一輪根本算不出證據（查詢失敗、資料還沒同步、樣本讀不到）
 */
export const EVIDENCE_SOURCE = Object.freeze({
  AVAILABLE: 'AVAILABLE',
  UNAVAILABLE: 'UNAVAILABLE',
});

/** 效果量門檻。與 statusFromEvidence 共用，避免兩處各寫一個數字。 */
const EFFECT = Object.freeze({ STRONG: 0.5, WEAK: 0.2 });

/**
 * 依證據強度決定 insight **本身**應該處於哪個狀態。
 * 完全確定性 —— LLM 不參與。
 *
 * ⚠️ 這支函式回的是「這組證據自己看起來像什麼」，**不是**下一個狀態。
 * 下一個狀態還要考慮目前的狀態與歷史，那是 nextStatusFor() 的工作。
 */
export function statusFromEvidence({ sampleCount = 0, effectSize = null }) {
  const quality = dataQualityOf(sampleCount);
  const strong = effectSize !== null && Math.abs(effectSize) >= EFFECT.STRONG;
  const weak = effectSize !== null && Math.abs(effectSize) < EFFECT.WEAK;

  if (quality === CONFIDENCE.INSUFFICIENT) return INSIGHT_STATUS.HYPOTHESIS;
  if (weak) return INSIGHT_STATUS.WEAKENED;
  if (quality === CONFIDENCE.LOW) return INSIGHT_STATUS.EMERGING;
  if (quality === CONFIDENCE.MODERATE) {
    return strong ? INSIGHT_STATUS.SUPPORTED : INSIGHT_STATUS.EMERGING;
  }
  return strong ? INSIGHT_STATUS.SUPPORTED : INSIGHT_STATUS.EMERGING;
}

/**
 * 新證據與舊證據的方向相反嗎？
 *
 * 樣本變少、效果變弱都只是「支持度下降」；**方向翻轉**是另一回事 ——
 * 那代表我們相信的那個關係本身被否定了，不是它比較弱。
 *
 * 兩邊都要有實質效果量才算翻轉：在 0 附近的正負跳動是雜訊，不是矛盾。
 */
export function contradicts(oldEffect, newEffect) {
  if (oldEffect === null || oldEffect === undefined) return false;
  if (newEffect === null || newEffect === undefined) return false;
  if (Math.abs(oldEffect) < EFFECT.WEAK || Math.abs(newEffect) < EFFECT.WEAK) return false;
  return Math.sign(oldEffect) !== Math.sign(newEffect);
}

/**
 * 目前狀態 + 新證據 → **合法**的下一個狀態。確定性，LLM 不參與。
 *
 * ## 規則
 *
 *   1. 證據方向翻轉
 *        → 已經 WEAKENED 過的直接 RETIRED（連續兩次否定）
 *        → 其餘一律 WEAKENED（先降級，不一次殺掉）
 *
 *   2. 證據不足以支持（樣本掉到 INSUFFICIENT，或效果量變弱）
 *        · 目前已經是 WEAKENED → RETIRED
 *          （上一次就降級過了，這次仍然沒回來 —— 可以收掉了）
 *        · 目前是 SUPPORTED / EMERGING → WEAKENED
 *          ★ 這是 M-01 修掉的那條路。舊版在這裡試圖走 → HYPOTHESIS，
 *            被判非法而整個放棄，於是 SUPPORTED 原封不動留著。
 *        · 目前是 HYPOTHESIS → 留在 HYPOTHESIS（本來就還沒相信過）
 *
 *   3. 證據仍然支持 → 直接採用它的強度狀態（升級或維持）
 *
 * 「不會因為一次短暫事件就 RETIRE」由兩件事共同保證：
 *   · 真正的缺資料根本不會走到這裡（reviseInsight 會先擋掉）
 *   · 有效但變弱的證據第一次只降到 WEAKENED，要**再一次**才會 RETIRE
 */
export function nextStatusFor(current, { sampleCount, effectSize, previousEffectSize = null }) {
  const evidence = statusFromEvidence({ sampleCount, effectSize });

  if (current === INSIGHT_STATUS.RETIRED) return INSIGHT_STATUS.RETIRED;

  if (contradicts(previousEffectSize, effectSize)) {
    return current === INSIGHT_STATUS.WEAKENED
      ? INSIGHT_STATUS.RETIRED : INSIGHT_STATUS.WEAKENED;
  }

  const collapsed = evidence === INSIGHT_STATUS.HYPOTHESIS
    || evidence === INSIGHT_STATUS.WEAKENED;

  if (collapsed) {
    if (current === INSIGHT_STATUS.WEAKENED) return INSIGHT_STATUS.RETIRED;
    if (current === INSIGHT_STATUS.HYPOTHESIS) return INSIGHT_STATUS.HYPOTHESIS;
    return INSIGHT_STATUS.WEAKENED;
  }

  // 升級一次只能升一級：還在 HYPOTHESIS 的信念就算證據看起來很強，
  // 也只能先到 EMERGING。一次回答不可以直接產生一條「已被支持」的規律
  // （既有規則，與 M-01 無關，刻意保留）。
  if (current === INSIGHT_STATUS.HYPOTHESIS && evidence === INSIGHT_STATUS.SUPPORTED) {
    return INSIGHT_STATUS.EMERGING;
  }

  return evidence;
}

export async function recordInsight(db, userId, {
  insightType, subject, statement, evidence, sampleCount, effectSize,
}, { now = new Date() } = {}) {
  const uid = requireUserId(userId, 'recordInsight');
  const status = statusFromEvidence({ sampleCount, effectSize });
  const id = await db.createInsight(uid, {
    insightType, subject, statement, evidence, sampleCount, effectSize,
    confidence: dataQualityOf(sampleCount ?? 0),
    status,
  }, { now });
  return { id, status };
}

/**
 * 用新證據修正既有 insight（belief revision）。
 *
 * 狀態沒變 → 只更新證據（不開新版本）
 * 狀態變了 → 開新版本，舊的標 RETIRED 並串起來
 *
 * @param {string} opts.evidenceSource EVIDENCE_SOURCE.AVAILABLE / UNAVAILABLE。
 *   UNAVAILABLE 代表「這一輪算不出證據」（ingestion 失敗、資料還沒同步）。
 *   那種情況下這支函式**什麼都不做** —— 見下面的說明。
 */
export async function reviseInsight(db, userId, id, {
  statement, evidence, sampleCount, effectSize,
}, { now = new Date(), evidenceSource = EVIDENCE_SOURCE.AVAILABLE } = {}) {
  const uid = requireUserId(userId, 'reviseInsight');
  const old = await db.getInsight(uid, id);
  if (!old) return { ok: false, error: 'not_found' };
  if (old.status === INSIGHT_STATUS.RETIRED) return { ok: false, error: 'already_retired' };

  // -------------------------------------------------------------------------
  // ★ M-01 的第一道關卡：沒有新證據 ≠ 新證據不支持。
  // -------------------------------------------------------------------------
  //
  // 呼叫端明說證據拿不到，或者根本沒給樣本數（undefined / NaN）——
  // 兩者都代表「這一輪什麼都沒算出來」。這時候動任何狀態都是在用
  // 一次基礎建設故障去改寫一個關於使用者身體的長期結論。
  //
  // 所以：不改狀態、不開新版本、不寫證據。回報成功（沒有事情出錯），
  // 但明確標示 skipped，呼叫端與日誌都看得出來發生過什麼。
  const sampleKnown = Number.isFinite(Number(sampleCount));
  if (evidenceSource === EVIDENCE_SOURCE.UNAVAILABLE || !sampleKnown) {
    log.info('insight_revision_skipped', {
      user_id: uid, id, status: old.status, reason: 'evidence_unavailable',
    });
    return {
      ok: true, changed: false, skipped: 'evidence_unavailable', id, status: old.status,
    };
  }

  // 有效證據。現在才可以談升級或降級。
  const nextStatus = nextStatusFor(old.status, {
    sampleCount,
    effectSize,
    previousEffectSize: old.effectSize ?? old.effect_size ?? null,
  });

  if (nextStatus === old.status) {
    // 狀態沒變 → 不開新版本，但**新證據一定要寫進去**（稽核修正）。
    // 舊版只呼叫 updateInsightStatus()，新的 evidence/sampleCount/effectSize
    // 會被靜默丟棄，成熟 insight 的證據會永遠停在上一次狀態變動的時候。
    await db.reconfirmInsight(uid, id, {
      statement: statement ?? old.statement,
      evidence,
      sampleCount,
      effectSize,
      confidence: dataQualityOf(sampleCount ?? 0),
    }, { now });
    log.info('insight_reconfirmed', { user_id: uid, id, status: nextStatus });
    return { ok: true, changed: false, id, status: nextStatus };
  }

  // nextStatusFor 只會產生合法轉移，但仍然檢查一次：狀態機被改壞時
  // 我們要的是一個明確的錯誤，而不是一條寫進資料庫的非法邊。
  if (!canTransition(old.status, nextStatus)) {
    log.error('insight_illegal_transition', {
      user_id: uid, id, from: old.status, to: nextStatus,
    });
    return { ok: false, error: `illegal_transition:${old.status}->${nextStatus}` };
  }

  const newId = await db.supersedeInsight(uid, id, {
    statement: statement ?? old.statement,
    evidence,
    sampleCount,
    effectSize,
    confidence: dataQualityOf(sampleCount ?? 0),
    status: nextStatus,
  }, { now });

  // supersedeInsight 在併發競爭中輸掉時回 null（另一個 job 已經把這一列
  // RETIRE 掉了）。這時候不可以假裝成功——否則版本鏈會分叉。
  if (newId === null || newId === undefined) {
    return { ok: false, error: 'superseded_by_concurrent_update' };
  }

  log.info('insight_revised', {
    user_id: uid, old_id: id, new_id: newId, from: old.status, to: nextStatus,
  });
  return { ok: true, changed: true, id: newId, supersedes: id, status: nextStatus };
}

export async function retireInsight(db, userId, id, { now = new Date() } = {}) {
  const uid = requireUserId(userId, 'retireInsight');
  const old = await db.getInsight(uid, id);
  if (!old) return { ok: false, error: 'not_found' };
  if (!canTransition(old.status, INSIGHT_STATUS.RETIRED)) {
    return { ok: false, error: 'already_retired' };
  }
  await db.updateInsightStatus(uid, id, INSIGHT_STATUS.RETIRED, { now });
  return { ok: true };
}

/** 目前「相信」的東西（HYPOTHESIS 不算，證據太弱）。 */
export async function activeBeliefs(db, userId, { subject = null } = {}) {
  const uid = requireUserId(userId, 'activeBeliefs');
  const all = await db.getActiveInsights(uid, { subject });
  return all.filter((i) => i.status !== INSIGHT_STATUS.HYPOTHESIS);
}
