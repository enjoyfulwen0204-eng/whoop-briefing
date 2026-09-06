/**
 * 分析基礎建設的持久化：healthspan / prediction / insight / experiment。
 *
 * 這一輪只有 schema 與存取，**不產生任何結論**。
 * 沒有真實資料時所有查詢都回空集合，不是錯誤。
 */

import { log } from './logger.js';

const nowIso = (d = new Date()) => d.toISOString();
const rowsOf = (rs) => rs.rows.map((r) => ({ ...r }));

export function createAnalysisStore(client) {
  // -------------------------------------------------------------------------
  // Healthspan
  // -------------------------------------------------------------------------
  async function saveHealthspanMetrics(metrics = [], { now = new Date() } = {}) {
    if (!metrics.length) return 0;
    const calculatedAt = nowIso(now);
    const stmts = metrics.map((m) => ({
      sql: `INSERT INTO healthspan_metrics
              (calculated_at, metric_key, value, unit, window_days, sample_count,
               coverage, availability, source, confidence, detail)
            VALUES (?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(calculated_at, metric_key) DO UPDATE SET
              value=excluded.value, unit=excluded.unit,
              window_days=excluded.window_days, sample_count=excluded.sample_count,
              coverage=excluded.coverage, availability=excluded.availability,
              source=excluded.source, confidence=excluded.confidence,
              detail=excluded.detail`,
      args: [
        calculatedAt, m.metricKey, m.value ?? null, m.unit ?? null,
        m.windowDays ?? null, m.sampleCount ?? null, m.coverage ?? null,
        m.availability, m.source ?? null, m.confidence ?? null, m.detail ?? null,
      ],
    }));
    await client.batch(stmts, 'write');
    log.info('healthspan_metrics_saved', { count: stmts.length, calculated_at: calculatedAt });
    return stmts.length;
  }

  /** 最近一次計算的全部 contributor。 */
  async function getLatestHealthspanMetrics() {
    const rs = await client.execute(`
      SELECT * FROM healthspan_metrics
       WHERE calculated_at = (SELECT MAX(calculated_at) FROM healthspan_metrics)
       ORDER BY metric_key`);
    return rowsOf(rs);
  }

  async function saveHealthspanSnapshot(snap, { now = new Date() } = {}) {
    await client.execute({
      sql: `INSERT INTO healthspan_snapshots
              (snapshot_date, algorithm_version, score, score_kind,
               contributors_json, coverage, status, created_at)
            VALUES (?,?,?,?,?,?,?,?)
            ON CONFLICT(snapshot_date, algorithm_version) DO UPDATE SET
              score=excluded.score, score_kind=excluded.score_kind,
              contributors_json=excluded.contributors_json,
              coverage=excluded.coverage, status=excluded.status`,
      args: [
        snap.snapshotDate, snap.algorithmVersion, snap.score ?? null,
        snap.scoreKind ?? null,
        snap.contributors ? JSON.stringify(snap.contributors) : null,
        snap.coverage ?? null, snap.status, nowIso(now),
      ],
    });
    return true;
  }

  async function getHealthspanSnapshots(limit = 20) {
    const rs = await client.execute({
      sql: 'SELECT * FROM healthspan_snapshots ORDER BY snapshot_date DESC LIMIT ?',
      args: [limit],
    });
    return rowsOf(rs);
  }

  // -------------------------------------------------------------------------
  // Prediction
  // -------------------------------------------------------------------------
  async function savePrediction(p, { now = new Date() } = {}) {
    await client.execute({
      sql: `INSERT INTO prediction_runs
              (target_date, target_metric, model_version, status, features_json,
               predicted_value, predicted_low, predicted_high, n_train, created_at)
            VALUES (?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(target_date, target_metric, model_version) DO UPDATE SET
              status=excluded.status, features_json=excluded.features_json,
              predicted_value=excluded.predicted_value,
              predicted_low=excluded.predicted_low,
              predicted_high=excluded.predicted_high,
              n_train=excluded.n_train, created_at=excluded.created_at`,
      args: [
        p.targetDate, p.targetMetric, p.modelVersion, p.status,
        p.features ? JSON.stringify(p.features) : null,
        p.predictedValue ?? null, p.predictedLow ?? null, p.predictedHigh ?? null,
        p.nTrain ?? null, nowIso(now),
      ],
    });
    return true;
  }

  /** 事後回填實際值並算誤差（預測記分卡的基礎）。 */
  async function recordPredictionActual({
    targetDate, targetMetric, modelVersion, actualValue,
  }, { now = new Date() } = {}) {
    const rs = await client.execute({
      sql: `UPDATE prediction_runs
               SET actual_value = ?,
                   error = CASE WHEN predicted_value IS NULL THEN NULL
                                ELSE ? - predicted_value END,
                   evaluated_at = ?
             WHERE target_date = ? AND target_metric = ? AND model_version = ?`,
      args: [actualValue, actualValue, nowIso(now), targetDate, targetMetric, modelVersion],
    });
    return Number(rs.rowsAffected ?? 0) > 0;
  }

  async function getPredictions({ targetMetric = null, limit = 100 } = {}) {
    const rs = targetMetric
      ? await client.execute({
        sql: 'SELECT * FROM prediction_runs WHERE target_metric = ? ORDER BY target_date DESC LIMIT ?',
        args: [targetMetric, limit],
      })
      : await client.execute({
        sql: 'SELECT * FROM prediction_runs ORDER BY target_date DESC LIMIT ?',
        args: [limit],
      });
    return rowsOf(rs);
  }

  // -------------------------------------------------------------------------
  // Health insights（版本鏈：舊版本永遠不刪）
  // -------------------------------------------------------------------------
  async function createInsight(i, { now = new Date() } = {}) {
    const ts = nowIso(now);
    const rs = await client.execute({
      sql: `INSERT INTO health_insights
              (insight_type, subject, statement, evidence_json, sample_count,
               effect_size, confidence, status, first_detected_at,
               last_confirmed_at, last_recalculated_at, version, supersedes_id)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: [
        i.insightType, i.subject, i.statement,
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
  async function superseiveInsight(oldId, next, { now = new Date() } = {}) {
    const old = await getInsight(oldId);
    if (!old) return null;
    await client.execute({
      sql: "UPDATE health_insights SET status = 'RETIRED', retired_at = ? WHERE id = ?",
      args: [nowIso(now), oldId],
    });
    return createInsight({
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

  async function updateInsightStatus(id, status, { now = new Date() } = {}) {
    const rs = await client.execute({
      sql: `UPDATE health_insights
               SET status = ?, last_recalculated_at = ?,
                   retired_at = CASE WHEN ? = 'RETIRED' THEN ? ELSE retired_at END
             WHERE id = ?`,
      args: [status, nowIso(now), status, nowIso(now), id],
    });
    return Number(rs.rowsAffected ?? 0) > 0;
  }

  async function getInsight(id) {
    const rs = await client.execute({
      sql: 'SELECT * FROM health_insights WHERE id = ?',
      args: [id],
    });
    return rs.rows[0] ? { ...rs.rows[0] } : null;
  }

  async function getActiveInsights({ subject = null } = {}) {
    const rs = subject
      ? await client.execute({
        sql: `SELECT * FROM health_insights
               WHERE status NOT IN ('RETIRED') AND subject = ?
               ORDER BY id DESC`,
        args: [subject],
      })
      : await client.execute(
        "SELECT * FROM health_insights WHERE status NOT IN ('RETIRED') ORDER BY id DESC",
      );
    return rowsOf(rs);
  }

  /** 版本鏈：從某一列往回追它取代了誰。 */
  async function getInsightHistory(id) {
    const chain = [];
    let cur = await getInsight(id);
    while (cur) {
      chain.push(cur);
      cur = cur.supersedes_id ? await getInsight(Number(cur.supersedes_id)) : null;
    }
    return chain;
  }

  // -------------------------------------------------------------------------
  // Experiments
  // -------------------------------------------------------------------------
  async function createExperiment(e, { now = new Date() } = {}) {
    const ts = nowIso(now);
    const rs = await client.execute({
      sql: `INSERT INTO experiments
              (name, hypothesis, intervention, target_metrics, baseline_start,
               baseline_end, start_date, end_date, status, protocol_json,
               created_at, updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: [
        e.name, e.hypothesis ?? null, e.intervention ?? null,
        JSON.stringify(e.targetMetrics ?? []),
        e.baselineStart ?? null, e.baselineEnd ?? null,
        e.startDate ?? null, e.endDate ?? null,
        e.status ?? 'DRAFT',
        e.protocol ? JSON.stringify(e.protocol) : null,
        ts, ts,
      ],
    });
    const id = Number(rs.lastInsertRowid ?? 0);
    log.info('experiment_created', { id, name: e.name });
    return id;
  }

  async function updateExperiment(id, patch, { now = new Date() } = {}) {
    const cur = await getExperiment(id);
    if (!cur) return false;
    await client.execute({
      sql: `UPDATE experiments
               SET status = ?, start_date = ?, end_date = ?,
                   baseline_start = ?, baseline_end = ?,
                   result_json = ?, updated_at = ?
             WHERE id = ?`,
      args: [
        patch.status ?? cur.status,
        patch.startDate !== undefined ? patch.startDate : cur.start_date,
        patch.endDate !== undefined ? patch.endDate : cur.end_date,
        patch.baselineStart !== undefined ? patch.baselineStart : cur.baseline_start,
        patch.baselineEnd !== undefined ? patch.baselineEnd : cur.baseline_end,
        patch.result !== undefined ? JSON.stringify(patch.result) : cur.result_json,
        nowIso(now), id,
      ],
    });
    return true;
  }

  async function getExperiment(id) {
    const rs = await client.execute({
      sql: 'SELECT * FROM experiments WHERE id = ?',
      args: [id],
    });
    return rs.rows[0] ? { ...rs.rows[0] } : null;
  }

  async function listExperiments({ status = null } = {}) {
    const rs = status
      ? await client.execute({
        sql: 'SELECT * FROM experiments WHERE status = ? ORDER BY id DESC',
        args: [status],
      })
      : await client.execute('SELECT * FROM experiments ORDER BY id DESC');
    return rowsOf(rs);
  }

  // -------------------------------------------------------------------------
  // AI 用量帳本
  // -------------------------------------------------------------------------
  async function recordAiUsage(u, { now = new Date() } = {}) {
    const rs = await client.execute({
      sql: `INSERT INTO ai_usage
              (timestamp, provider, requested_model, model, fallback_occurred,
               purpose, prompt_version, input_tokens, output_tokens, total_tokens,
               estimated_cost_usd, pricing_version, request_status, latency_ms, detail)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: [
        u.timestamp ?? nowIso(now), u.provider ?? 'openrouter',
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
  async function getAiUsage({ fromIso, toIso, limit = 5000 } = {}) {
    const rs = await client.execute({
      sql: `SELECT * FROM ai_usage
             WHERE timestamp >= ? AND timestamp <= ?
             ORDER BY timestamp DESC LIMIT ?`,
      args: [fromIso, toIso, limit],
    });
    return rowsOf(rs);
  }

  async function countAiUsage() {
    const rs = await client.execute('SELECT COUNT(*) AS c FROM ai_usage');
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
    superseiveInsight,
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
