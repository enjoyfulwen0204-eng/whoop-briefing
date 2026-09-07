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

/** 允許的狀態轉移。亂跳會被拒絕，避免狀態機被寫壞。 */
export const ALLOWED_TRANSITIONS = {
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
 * 依證據強度決定 insight 應該處於哪個狀態。
 * 完全確定性 —— LLM 不參與。
 */
export function statusFromEvidence({ sampleCount = 0, effectSize = null }) {
  const quality = dataQualityOf(sampleCount);
  const strong = effectSize !== null && Math.abs(effectSize) >= 0.5;
  const weak = effectSize !== null && Math.abs(effectSize) < 0.2;

  if (quality === CONFIDENCE.INSUFFICIENT) return INSIGHT_STATUS.HYPOTHESIS;
  if (weak) return INSIGHT_STATUS.WEAKENED;
  if (quality === CONFIDENCE.LOW) return INSIGHT_STATUS.EMERGING;
  if (quality === CONFIDENCE.MODERATE) {
    return strong ? INSIGHT_STATUS.SUPPORTED : INSIGHT_STATUS.EMERGING;
  }
  return strong ? INSIGHT_STATUS.SUPPORTED : INSIGHT_STATUS.EMERGING;
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
 * 狀態沒變 → 只更新 last_recalculated_at（不開新版本）
 * 狀態變了 → 開新版本，舊的標 RETIRED 並串起來
 */
export async function reviseInsight(db, userId, id, {
  statement, evidence, sampleCount, effectSize,
}, { now = new Date() } = {}) {
  const uid = requireUserId(userId, 'reviseInsight');
  const old = await db.getInsight(uid, id);
  if (!old) return { ok: false, error: 'not_found' };
  if (old.status === INSIGHT_STATUS.RETIRED) return { ok: false, error: 'already_retired' };

  const nextStatus = statusFromEvidence({ sampleCount, effectSize });

  if (nextStatus === old.status) {
    await db.updateInsightStatus(uid, id, nextStatus, { now });
    log.info('insight_reconfirmed', { user_id: uid, id, status: nextStatus });
    return { ok: true, changed: false, id, status: nextStatus };
  }

  if (!canTransition(old.status, nextStatus)) {
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
