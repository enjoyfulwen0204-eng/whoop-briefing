/**
 * 分析基礎建設的持久化：healthspan / prediction / insight / experiment。
 *
 * 這一輪只有 schema 與存取，**不產生任何結論**。
 * 沒有真實資料時所有查詢都回空集合，不是錯誤。
 */

import { log } from './logger.js';
import { requireUserId } from './userContext.js';

const nowIso = (d = new Date()) => d.toISOString();
const rowsOf = (rs) => rs.rows.map((r) => ({ ...r }));

export function createAnalysisStore(client) {
  // -------------------------------------------------------------------------
  // Healthspan
  // -------------------------------------------------------------------------
  async function saveHealthspanMetrics(userId, metrics = [], { now = new Date() } = {}) {
    const uid = requireUserId(userId, 'saveHealthspanMetrics');
    if (!metrics.length) return 0;
    const calculatedAt = nowIso(now);
    const stmts = metrics.map((m) => ({
      sql: `INSERT INTO healthspan_metrics
              (user_id, calculated_at, metric_key, value, unit, window_days, sample_count,
               coverage, availability, source, confidence, detail)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(user_id, calculated_at, metric_key) DO UPDATE SET
              value=excluded.value, unit=excluded.unit,
              window_days=excluded.window_days, sample_count=excluded.sample_count,
              coverage=excluded.coverage, availability=excluded.availability,
              source=excluded.source, confidence=excluded.confidence,
              detail=excluded.detail`,
      args: [
        uid, calculatedAt, m.metricKey, m.value ?? null, m.unit ?? null,
        m.windowDays ?? null, m.sampleCount ?? null, m.coverage ?? null,
        m.availability, m.source ?? null, m.confidence ?? null, m.detail ?? null,
      ],
    }));
    await client.batch(stmts, 'write');
    log.info('healthspan_metrics_saved', { user_id: uid, count: stmts.length, calculated_at: calculatedAt });
    return stmts.length;
  }

  /** 最近一次計算的全部 contributor。 */
  async function getLatestHealthspanMetrics(userId) {
    const uid = requireUserId(userId, 'getLatestHealthspanMetrics');
    // 內層 MAX 也必須限定 user，否則會拿別人的 calculated_at 去比對自己的列
    const rs = await client.execute({
      sql: `
      SELECT * FROM healthspan_metrics
       WHERE user_id = ?
         AND calculated_at = (SELECT MAX(calculated_at) FROM healthspan_metrics
                               WHERE user_id = ?)
       ORDER BY metric_key`,
      args: [uid, uid],
    });
    return rowsOf(rs);
  }

  async function saveHealthspanSnapshot(userId, snap, { now = new Date() } = {}) {
    const uid = requireUserId(userId, 'saveHealthspanSnapshot');
    await client.execute({
      sql: `INSERT INTO healthspan_snapshots
              (user_id, snapshot_date, algorithm_version, score, score_kind,
               contributors_json, coverage, status, created_at)
            VALUES (?,?,?,?,?,?,?,?,?)
            ON CONFLICT(user_id, snapshot_date, algorithm_version) DO UPDATE SET
              score=excluded.score, score_kind=excluded.score_kind,
              contributors_json=excluded.contributors_json,
              coverage=excluded.coverage, status=excluded.status`,
      args: [
        uid, snap.snapshotDate, snap.algorithmVersion, snap.score ?? null,
        snap.scoreKind ?? null,
        snap.contributors ? JSON.stringify(snap.contributors) : null,
        snap.coverage ?? null, snap.status, nowIso(now),
      ],
    });
    return true;
  }

  async function getHealthspanSnapshots(userId, limit = 20) {
    const uid = requireUserId(userId, 'getHealthspanSnapshots');
    const rs = await client.execute({
      sql: `SELECT * FROM healthspan_snapshots WHERE user_id = ?
             ORDER BY snapshot_date DESC LIMIT ?`,
      args: [uid, limit],
    });
    return rowsOf(rs);
  }

  // -------------------------------------------------------------------------
  // Prediction
  // -------------------------------------------------------------------------
  async function savePrediction(userId, p, { now = new Date() } = {}) {
    const uid = requireUserId(userId, 'savePrediction');
    await client.execute({
      sql: `INSERT INTO prediction_runs
              (user_id, target_date, target_metric, model_version, status, features_json,
               predicted_value, predicted_low, predicted_high, n_train, created_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(user_id, target_date, target_metric, model_version) DO UPDATE SET
              status=excluded.status, features_json=excluded.features_json,
              predicted_value=excluded.predicted_value,
              predicted_low=excluded.predicted_low,
              predicted_high=excluded.predicted_high,
              n_train=excluded.n_train, created_at=excluded.created_at`,
      args: [
        uid, p.targetDate, p.targetMetric, p.modelVersion, p.status,
        p.features ? JSON.stringify(p.features) : null,
        p.predictedValue ?? null, p.predictedLow ?? null, p.predictedHigh ?? null,
        p.nTrain ?? null, nowIso(now),
      ],
    });
    return true;
  }

  /** 事後回填實際值並算誤差（預測記分卡的基礎）。 */
  async function recordPredictionActual({
    userId,
    targetDate, targetMetric, modelVersion, actualValue,
  }, { now = new Date() } = {}) {
    // ⚠️ 稽核修正：這裡原本直接用 `uid` 但從來沒有定義過它，任何呼叫都會
    // 拋 ReferenceError（等於 backfillActuals() 整條路徑是壞的，預測記分卡
    // 永遠不可能有資料）。跟其他 store 函式一樣用 requireUserId 取得 uid。
    const uid = requireUserId(userId, 'recordPredictionActual');
    const rs = await client.execute({
      sql: `UPDATE prediction_runs
               SET actual_value = ?,
                   error = CASE WHEN predicted_value IS NULL THEN NULL
                                ELSE ? - predicted_value END,
                   evaluated_at = ?
             WHERE user_id = ? AND target_date = ? AND target_metric = ? AND model_version = ?`,
      args: [actualValue, actualValue, nowIso(now), uid, targetDate, targetMetric, modelVersion],
    });
    return Number(rs.rowsAffected ?? 0) > 0;
  }

  async function getPredictions(userId, { targetMetric = null, limit = 100 } = {}) {
    const uid = requireUserId(userId, 'getPredictions');
    const rs = targetMetric
      ? await client.execute({
        sql: `SELECT * FROM prediction_runs WHERE user_id = ? AND target_metric = ?
               ORDER BY target_date DESC LIMIT ?`,
        args: [uid, targetMetric, limit],
      })
      : await client.execute({
        sql: 'SELECT * FROM prediction_runs WHERE user_id = ? ORDER BY target_date DESC LIMIT ?',
        args: [uid, limit],
      });
    return rowsOf(rs);
  }

  // -------------------------------------------------------------------------
  // Health insights（版本鏈：舊版本永遠不刪）
  // -------------------------------------------------------------------------
  async function createInsight(userId, i, { now = new Date() } = {}) {
    const uid = requireUserId(userId, 'createInsight');
    const ts = nowIso(now);
    const rs = await client.execute({
      sql: `INSERT INTO health_insights
              (user_id, insight_type, subject, statement, evidence_json, sample_count,
               effect_size, confidence, status, first_detected_at,
               last_confirmed_at, last_recalculated_at, version, supersedes_id)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: [
        uid, i.insightType, i.subject, i.statement,
        i.evidence ? JSON.stringify(i.evidence) : null,
        i.sampleCount ?? null, i.effectSize ?? null, i.confidence ?? null,
        i.status ?? 'HYPOTHESIS', i.firstDetectedAt ?? ts,
        i.lastConfirmedAt ?? null, ts, i.version ?? 1, i.supersedesId ?? null,
      ],
    });
    const id = Number(rs.lastInsertRowid ?? 0);
    log.info('insight_created', { id, subject: i.subject, status: i.status ?? 'HYPOTHESIS' });
    return id;
  }

  /**
   * 用新版本取代舊的：舊列標成 RETIRED（保留），新列 version+1 並指回舊 id。
   * 這樣「我以前相信什麼、後來為什麼改變」是可以回溯的。
   */
  async function supersedeInsight(userId, oldId, next, { now = new Date() } = {}) {
    const uid = requireUserId(userId, 'supersedeInsight');
    const old = await getInsight(uid, oldId);
    if (!old) return null;
    // ⚠️ 稽核修正：這個 UPDATE 同時當成 compare-and-swap 用。
    // `AND status != 'RETIRED'` + 檢查 rowsAffected 是版本鏈不會分叉的關鍵：
    // 兩個併發的 reviseInsight 讀到同一列時，只有先 RETIRE 成功的那個
    // 可以繼續建新版本；輸的那個拿到 rowsAffected=0 就放棄，
    // 否則會出現兩列 supersedes_id 相同、而且都是 active 的分叉狀態。
    const retire = await client.execute({
      sql: `UPDATE health_insights SET status = 'RETIRED', retired_at = ?
             WHERE user_id = ? AND id = ? AND status != 'RETIRED'`,
      args: [nowIso(now), uid, oldId],
    });
    if (Number(retire.rowsAffected ?? 0) === 0) {
      log.warn('insight_supersede_lost_race', { user_id: uid, old_id: oldId });
      return null;
    }
    return createInsight(uid, {
      insightType: next.insightType ?? old.insight_type,
      subject: next.subject ?? old.subject,
      statement: next.statement,
      evidence: next.evidence,
      sampleCount: next.sampleCount,
      effectSize: next.effectSize,
      confidence: next.confidence,
      status: next.status ?? 'SUPPORTED',
      firstDetectedAt: old.first_detected_at,
      lastConfirmedAt: next.lastConfirmedAt ?? nowIso(now),
      version: Number(old.version) + 1,
      supersedesId: oldId,
    }, { now });
  }

  /**
   * 狀態沒變、但證據更新了（樣本變多、效果量微調）。
   *
   * ⚠️ 稽核修正：以前這條路徑只呼叫 updateInsightStatus()，那個函式只寫
   * status 與 last_recalculated_at——新的 evidence/sample_count/effect_size
   * 會被靜默丟棄，導致一個成熟 insight 的 evidence_json 從此凍結在「上一次
   * 狀態變動」的那一刻。版本鏈只在狀態改變時才開新版本（這是對的），
   * 但同一版本內的證據仍然必須跟著更新。
   */
  async function reconfirmInsight(userId, id, next, { now = new Date() } = {}) {
    const uid = requireUserId(userId, 'reconfirmInsight');
    const ts = nowIso(now);
    const rs = await client.execute({
      sql: `UPDATE health_insights
               SET statement = COALESCE(?, statement),
                   evidence_json = COALESCE(?, evidence_json),
                   sample_count = COALESCE(?, sample_count),
                   effect_size = COALESCE(?, effect_size),
                   confidence = COALESCE(?, confidence),
                   last_confirmed_at = ?, last_recalculated_at = ?
             WHERE user_id = ? AND id = ? AND status != 'RETIRED'`,
      args: [
        next.statement ?? null,
        next.evidence ? JSON.stringify(next.evidence) : null,
        next.sampleCount ?? null, next.effectSize ?? null, next.confidence ?? null,
        ts, ts, uid, id,
      ],
    });
    return Number(rs.rowsAffected ?? 0) > 0;
  }

  async function updateInsightStatus(userId, id, status, { now = new Date() } = {}) {
    const uid = requireUserId(userId, 'updateInsightStatus');
    const rs = await client.execute({
      sql: `UPDATE health_insights
               SET status = ?, last_recalculated_at = ?,
                   retired_at = CASE WHEN ? = 'RETIRED' THEN ? ELSE retired_at END
             WHERE user_id = ? AND id = ?`,
      args: [status, nowIso(now), status, nowIso(now), uid, id],
    });
    return Number(rs.rowsAffected ?? 0) > 0;
  }

  async function getInsight(userId, id) {
    const uid = requireUserId(userId, 'getInsight');
    const rs = await client.execute({
      sql: 'SELECT * FROM health_insights WHERE user_id = ? AND id = ?',
      args: [uid, id],
    });
    return rs.rows[0] ? { ...rs.rows[0] } : null;
  }

  async function getActiveInsights(userId, { subject = null } = {}) {
    const uid = requireUserId(userId, 'getActiveInsights');
    const rs = subject
      ? await client.execute({
        sql: `SELECT * FROM health_insights
               WHERE user_id = ? AND status NOT IN ('RETIRED') AND subject = ?
               ORDER BY id DESC`,
        args: [uid, subject],
      })
      : await client.execute(
        {
          sql: `SELECT * FROM health_insights WHERE user_id = ? AND status NOT IN ('RETIRED')
                 ORDER BY id DESC`,
          args: [uid],
        },
      );
    return rowsOf(rs);
  }

  /** 版本鏈：從某一列往回追它取代了誰。 */
  async function getInsightHistory(userId, id) {
    const uid = requireUserId(userId, 'getInsightHistory');
    const chain = [];
    let cur = await getInsight(uid, id);
    while (cur) {
      chain.push(cur);
      cur = cur.supersedes_id ? await getInsight(uid, Number(cur.supersedes_id)) : null;
    }
    return chain;
  }

  // -------------------------------------------------------------------------
  // Experiments
  // -------------------------------------------------------------------------
  async function createExperiment(userId, e, { now = new Date() } = {}) {
    const uid = requireUserId(userId, 'createExperiment');
    const ts = nowIso(now);
    const rs = await client.execute({
      sql: `INSERT INTO experiments
              (user_id, name, hypothesis, intervention, target_metrics, baseline_start,
               baseline_end, start_date, end_date, status, protocol_json,
               created_at, updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: [
        uid, e.name, e.hypothesis ?? null, e.intervention ?? null,
        JSON.stringify(e.targetMetrics ?? []),
        e.baselineStart ?? null, e.baselineEnd ?? null,
        e.startDate ?? null, e.endDate ?? null,
        e.status ?? 'DRAFT',
        e.protocol ? JSON.stringify(e.protocol) : null,
        ts, ts,
      ],
    });
    const id = Number(rs.lastInsertRowid ?? 0);
    log.info('experiment_created', { user_id: uid, id, name: e.name });
    return id;
  }

  async function updateExperiment(userId, id, patch, { now = new Date() } = {}) {
    const uid = requireUserId(userId, 'updateExperiment');
    const cur = await getExperiment(uid, id);
    if (!cur) return false;
    await client.execute({
      sql: `UPDATE experiments
               SET status = ?, start_date = ?, end_date = ?,
                   baseline_start = ?, baseline_end = ?,
                   result_json = ?, updated_at = ?
             WHERE user_id = ? AND id = ?`,
      args: [
        patch.status ?? cur.status,
        patch.startDate !== undefined ? patch.startDate : cur.start_date,
        patch.endDate !== undefined ? patch.endDate : cur.end_date,
        patch.baselineStart !== undefined ? patch.baselineStart : cur.baseline_start,
        patch.baselineEnd !== undefined ? patch.baselineEnd : cur.baseline_end,
        patch.result !== undefined ? JSON.stringify(patch.result) : cur.result_json,
        nowIso(now), uid, id,
      ],
    });
    return true;
  }

  async function getExperiment(userId, id) {
    const uid = requireUserId(userId, 'getExperiment');
    const rs = await client.execute({
      sql: 'SELECT * FROM experiments WHERE user_id = ? AND id = ?',
      args: [uid, id],
    });
    return rs.rows[0] ? { ...rs.rows[0] } : null;
  }

  async function listExperiments(userId, { status = null } = {}) {
    const uid = requireUserId(userId, 'listExperiments');
    const rs = status
      ? await client.execute({
        sql: 'SELECT * FROM experiments WHERE user_id = ? AND status = ? ORDER BY id DESC',
        args: [uid, status],
      })
      : await client.execute({
        sql: 'SELECT * FROM experiments WHERE user_id = ? ORDER BY id DESC',
        args: [uid],
      });
    return rowsOf(rs);
  }

  // -------------------------------------------------------------------------
  // AI 用量帳本
  // -------------------------------------------------------------------------
  /**
   * userId 允許 null，代表「系統層」用量（不屬於任何使用者的呼叫）。
   * 刻意不把系統用量硬塞給某個隨機使用者。
   */
  async function recordAiUsage(userId, u, { now = new Date() } = {}) {
    const uid = userId === null || userId === undefined ? null : String(userId);
    const rs = await client.execute({
      sql: `INSERT INTO ai_usage
              (user_id, timestamp, provider, requested_model, model, fallback_occurred,
               purpose, prompt_version, input_tokens, output_tokens, total_tokens,
               estimated_cost_usd, pricing_version, request_status, latency_ms, detail)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: [
        uid, u.timestamp ?? nowIso(now), u.provider ?? 'openrouter',
        u.requestedModel ?? null, u.model ?? null,
        u.fallbackOccurred ? 1 : 0,
        u.purpose, u.promptVersion ?? null,
        u.inputTokens ?? null, u.outputTokens ?? null, u.totalTokens ?? null,
        u.estimatedCostUsd ?? null, u.pricingVersion ?? null,
        u.requestStatus, u.latencyMs ?? null,
        u.detail ? String(u.detail).slice(0, 300) : null,
      ],
    });
    return Number(rs.lastInsertRowid ?? 0);
  }

  /** 某個時間區間（ISO 字串比較）的用量列。 */
  async function getAiUsage(userId, { fromIso, toIso, limit = 5000 } = {}) {
    const uid = requireUserId(userId, 'getAiUsage');
    const rs = await client.execute({
      sql: `SELECT * FROM ai_usage
             WHERE user_id = ? AND timestamp >= ? AND timestamp <= ?
             ORDER BY timestamp DESC LIMIT ?`,
      args: [uid, fromIso, toIso, limit],
    });
    return rowsOf(rs);
  }

  async function countAiUsage(userId) {
    const uid = requireUserId(userId, 'countAiUsage');
    const rs = await client.execute({
      sql: 'SELECT COUNT(*) AS c FROM ai_usage WHERE user_id = ?',
      args: [uid],
    });
    return Number(rs.rows[0].c);
  }

  return {
    recordAiUsage,
    getAiUsage,
    countAiUsage,
    saveHealthspanMetrics,
    getLatestHealthspanMetrics,
    saveHealthspanSnapshot,
    getHealthspanSnapshots,
    savePrediction,
    recordPredictionActual,
    getPredictions,
    createInsight,
    supersedeInsight,
    reconfirmInsight,
    updateInsightStatus,
    getInsight,
    getActiveInsights,
    getInsightHistory,
    createExperiment,
    updateExperiment,
    getExperiment,
    listExperiments,
  };
}
