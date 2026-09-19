/** Frozen v22 privacy expansion. Imported by the central schema registry. */
export const REDACTION_REASONS = ['SOURCE_CORRECTED', 'SOURCE_DELETED', 'RETENTION_EXPIRED', 'UNATTRIBUTED_LEGACY', 'INCIDENT_COPY'];
export const sqlEnum = values => values.map(v => `'${v}'`).join(',');
export const R_COLUMNS = Object.freeze({
  content_state: "TEXT NOT NULL DEFAULT 'LEGACY_UNLINKED' CHECK (content_state IN ('PRESENT','LEGACY_UNLINKED','PURGE_PENDING','REDACTED'))",
  health_content_redacted_at: 'TEXT NULL',
  health_content_redaction_reason: `TEXT NULL CHECK (health_content_redaction_reason IN (${sqlEnum(REDACTION_REASONS)}))`,
  source_subject_deleted_at: 'TEXT NULL',
  purge_generation: 'INTEGER NOT NULL DEFAULT 0 CHECK (purge_generation >= 0)',
  source_linkage_state: "TEXT NOT NULL DEFAULT 'LEGACY_UNLINKED' CHECK (source_linkage_state IN ('COMPLETE','LEGACY_UNLINKED','DISCONNECTED'))",
  content_digest_salt: 'TEXT NULL',
  privacy_artifact_id: 'TEXT NULL',
});
export const R_SQL = Object.entries(R_COLUMNS).map(([n, d]) => `${n} ${d}`).join(',\n');
export const SCOPE_COLUMNS = Object.freeze({
  scope_kind: "TEXT NOT NULL DEFAULT 'FULL_TENANT_RECOMPUTE' CHECK (scope_kind IN ('NONE','HEALTH_DATE_RANGE','FULL_TENANT_RECOMPUTE'))",
  scope_revision: 'INTEGER NOT NULL DEFAULT 0 CHECK (scope_revision >= 0)',
  health_scope_redacted_at: 'TEXT NULL',
  health_scope_redaction_reason: `TEXT NULL CHECK (health_scope_redaction_reason IN (${sqlEnum(REDACTION_REASONS)}))`,
  full_scan_cursor: 'TEXT NULL',
});
export const SCOPE_SQL = Object.entries(SCOPE_COLUMNS).map(([n, d]) => `${n} ${d}`).join(',\n');
export const V22_LEGACY_R_TABLES = Object.freeze([
  'journal_events', 'pending_questions', 'telegram_operations', 'proactive_events', 'health_insights',
  'whoop_capabilities', 'healthspan_metrics', 'healthspan_snapshots', 'prediction_runs', 'prediction_models',
  'analytics_daily_state', 'analytics_invalidation', 'analytics_work_state', 'analytics_runs',
  'report_runs', 'report_claims', 'briefing_evaluations', 'whoop_sync_state', 'whoop_webhook_events',
  'whoop_reconciliation_state', 'whoop_reconciliation_runs', 'user_onboarding', 'ai_usage',
  'system_heartbeats', 'proactive_agent_state',
]);
export const V22_NEW_R_TABLES = Object.freeze([
  'journal_coverage_windows', 'context_questions', 'structured_answer_events', 'health_purge_replacements', 'experiment_field_groups',
]);
export const EXPERIMENT_FIELDS = Object.freeze({
  name: 'DEFINITION', hypothesis: 'DEFINITION', target_metrics: 'DEFINITION',
  intervention: 'INTERVENTION_PROTOCOL', protocol_json: 'INTERVENTION_PROTOCOL',
  baseline_start: 'SCHEDULE', baseline_end: 'SCHEDULE', start_date: 'SCHEDULE', end_date: 'SCHEDULE',
  result_json: 'DERIVED_RESULT',
});
export const EXPERIMENT_SOURCE_KINDS = ['EXPERIMENT_DIRECT_ASSERTION', 'JOURNAL_DERIVED', 'WHOOP_DERIVED', 'QA_DERIVED', 'ANALYSIS_DERIVED', 'MIXED_DERIVED', 'LEGACY_UNPROVEN'];
export const SLOT_STATES = ['FREE', 'RESERVED', 'DELIVERY_STARTED', 'AMBIGUOUS_WAIT', 'AWAITING_ANSWER', 'RESOLVED', 'EXPIRED', 'CANCELLED_PRE_SEND'];
export const scopePredicate = (prefix, from, to, subject = null) => `(
  (${prefix}scope_kind = 'HEALTH_DATE_RANGE' AND ${prefix}${from} IS NOT NULL AND ${prefix}${to} IS NOT NULL
    AND ${prefix}${from} <= ${prefix}${to} AND ${prefix}content_state = 'PRESENT'
    AND ${prefix}source_linkage_state = 'COMPLETE') OR
  (${prefix}scope_kind IN ('NONE','FULL_TENANT_RECOMPUTE') AND ${prefix}${from} IS NULL AND ${prefix}${to} IS NULL
    ${subject ? `AND (${prefix}scope_kind <> 'FULL_TENANT_RECOMPUTE' OR ${prefix}${subject} IS NULL)` : ''})
)`;

export function buildV22(modeColumn, immutableMode) {
  const columns = [];
  const add = (table, fields) => Object.entries(fields).forEach(([column, definition]) => columns.push({ table, column, definition }));
  for (const table of V22_LEGACY_R_TABLES) add(table, R_COLUMNS);
  add('journal_events', {
    logical_fact_id: 'TEXT NULL', revision: 'INTEGER NULL CHECK (revision > 0)',
    fact_status: "TEXT NULL CHECK (fact_status IN ('ACTIVE','SUPERSEDED','DELETED'))",
    supersedes_event_id: 'INTEGER NULL', source_event_key: 'TEXT NULL', question_id: 'TEXT NULL', episode_id: 'TEXT NULL',
    parser_version: 'TEXT NULL', normalizer_version: 'TEXT NULL',
    extraction_confidence: 'REAL NULL CHECK (extraction_confidence BETWEEN 0 AND 1)',
    raw_answer_excerpt: 'TEXT NULL CHECK (length(raw_answer_excerpt) <= 500)', recorded_timezone: 'TEXT NULL',
    time_scope: "TEXT NULL CHECK (time_scope IN ('POINT','INTERVAL','HEALTH_DAY'))", event_end_at: 'TEXT NULL',
    health_date_alignment: "TEXT NULL CHECK (health_date_alignment IN ('ALIGNED','PROVISIONAL','LEGACY'))",
    alignment_version: 'TEXT NULL', exposure_state: "TEXT NULL CHECK (exposure_state IN ('EXPOSED','CONFIRMED_UNEXPOSED'))",
    coverage_window_id: 'TEXT NULL', invalidated_at: 'TEXT NULL', invalidation_reason: 'TEXT NULL',
  });
  add('pending_questions', {
    execution_mode: modeColumn.replace(/^execution_mode /, ''), context_question_id: 'TEXT NULL',
    source_logical_fact_id: 'TEXT NULL', input_generation: 'INTEGER NULL', slot_revision: 'INTEGER NULL',
  });
  add('telegram_operations', {
    owner_user_id: 'TEXT NULL', operation_state: "TEXT NOT NULL DEFAULT 'COMMITTED' CHECK (operation_state = 'COMMITTED')",
    source_update_key: 'TEXT NULL',
  });
  for (const table of ['analytics_invalidation', 'analytics_work_state']) add(table, SCOPE_COLUMNS);
  add('analytics_work_state', { claimed_scope_revision: 'INTEGER NULL', claimed_purge_generation: 'INTEGER NULL' });
  const ddl = [
    `CREATE TABLE IF NOT EXISTS journal_event_tombstones (
      user_id TEXT NOT NULL, logical_fact_id TEXT NOT NULL, source_event_hash TEXT NULL,
      deletion_idempotency_key TEXT NOT NULL, deleted_at TEXT NOT NULL, PRIMARY KEY(user_id,logical_fact_id)
    )`,
    `CREATE TABLE IF NOT EXISTS journal_coverage_windows (
      user_id TEXT NOT NULL, coverage_window_id TEXT NOT NULL,
      window_start_utc TEXT NULL, window_end_utc TEXT NULL, health_date_start TEXT NULL, health_date_end TEXT NULL,
      recorded_timezone TEXT NULL, factor_set_version TEXT NULL, factor_keys_json TEXT NULL,
      source_event_key TEXT NOT NULL, confirmation_text_hash TEXT NULL,
      parser_version TEXT NOT NULL, normalizer_version TEXT NOT NULL,
      lifecycle_generation INTEGER NOT NULL, auth_generation INTEGER NOT NULL, input_generation INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('ACTIVE','SUPERSEDED','DELETED')),
      revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0), answer_confidence REAL NULL,
      supersedes_coverage_window_id TEXT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      ${R_SQL}, PRIMARY KEY(user_id,coverage_window_id), UNIQUE(user_id,source_event_key),
      CHECK (content_state <> 'PRESENT' OR (window_start_utc IS NOT NULL AND window_end_utc IS NOT NULL
        AND window_start_utc < window_end_utc AND health_date_start IS NOT NULL AND health_date_end IS NOT NULL
        AND health_date_start <= health_date_end AND recorded_timezone IS NOT NULL AND factor_keys_json IS NOT NULL))
    )`,
    `CREATE TABLE IF NOT EXISTS phase4_source_links (
      user_id TEXT NOT NULL, artifact_execution_mode TEXT NOT NULL CHECK(artifact_execution_mode IN ('SHADOW','LIVE','SHARED')),
      artifact_type TEXT NOT NULL, artifact_id TEXT NOT NULL,
      source_execution_mode TEXT NOT NULL CHECK(source_execution_mode IN ('SHADOW','LIVE','SHARED')),
      source_type TEXT NOT NULL, source_id TEXT NOT NULL, relationship TEXT NOT NULL,
      linked_at TEXT NOT NULL, unlinked_at TEXT NULL, purge_id TEXT NULL,
      PRIMARY KEY(user_id,artifact_execution_mode,artifact_type,artifact_id,source_execution_mode,source_type,source_id,relationship),
      CHECK(artifact_execution_mode = 'SHARED' OR source_execution_mode = 'SHARED' OR artifact_execution_mode = source_execution_mode)
    )`,
    `CREATE TABLE IF NOT EXISTS health_plaintext_purges (
      user_id TEXT NOT NULL, purge_id TEXT NOT NULL, purge_generation INTEGER NOT NULL CHECK(purge_generation > 0),
      deletion_or_correction_idempotency_key TEXT NOT NULL, target_source_type TEXT NOT NULL, target_source_id TEXT NOT NULL,
      requested_source_generation INTEGER NOT NULL CHECK(requested_source_generation >= 0),
      state TEXT NOT NULL CHECK(state IN ('ADMITTED','DB_REDACTED','CACHE_CONFIRMED','COMPLETE')),
      admitted_at TEXT NOT NULL, db_redacted_at TEXT NULL, cache_confirmed_at TEXT NULL, completed_at TEXT NULL,
      updated_at TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 0, last_error_code TEXT NULL,
      operation_kind TEXT NOT NULL CHECK(operation_kind IN ('CORRECTION','DELETION','RETENTION','INCIDENT')),
      source_update_id TEXT NULL, replacement_receipt_id TEXT NULL,
      PRIMARY KEY(user_id,purge_id), UNIQUE(user_id,purge_generation), UNIQUE(user_id,deletion_or_correction_idempotency_key)
    )`,
    `CREATE TABLE IF NOT EXISTS health_purge_targets (
      user_id TEXT NOT NULL, purge_id TEXT NOT NULL,
      artifact_execution_mode TEXT NOT NULL CHECK(artifact_execution_mode IN ('SHADOW','LIVE','SHARED')),
      artifact_type TEXT NOT NULL, artifact_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('PENDING','REDACTED','REMOVED')), completed_at TEXT NULL,
      PRIMARY KEY(user_id,purge_id,artifact_execution_mode,artifact_type,artifact_id)
    )`,
    `CREATE TABLE IF NOT EXISTS health_purge_replacements (
      user_id TEXT NOT NULL, purge_id TEXT NOT NULL,
      replacement_kind TEXT NOT NULL CHECK(replacement_kind IN ('JOURNAL_FACT','JOURNAL_COVERAGE','EXPERIMENT_FIELDS')),
      normalized_replacement_json TEXT NULL CHECK(length(normalized_replacement_json) <= 32768),
      replacement_source_key TEXT NOT NULL, parser_version TEXT NOT NULL, normalizer_version TEXT NOT NULL,
      created_at TEXT NOT NULL, expires_at TEXT NOT NULL, ${R_SQL}, PRIMARY KEY(user_id,purge_id)
    )`,
    `CREATE TABLE IF NOT EXISTS context_questions (
      user_id TEXT NOT NULL, ${modeColumn}, question_request_id TEXT NOT NULL,
      selected_decision_id TEXT NULL, factor_question_kind TEXT NULL, target_window_start_utc TEXT NULL,
      target_window_end_utc TEXT NULL, question_cycle_ordinal INTEGER NOT NULL CHECK(question_cycle_ordinal > 0),
      question_cycle_source_key TEXT NULL, request_lookup_key TEXT NOT NULL,
      episode_id TEXT NULL, episode_revision INTEGER NOT NULL, selected_candidate_key TEXT NULL,
      candidate_set_hash TEXT NULL, candidate_diagnostics_json TEXT NULL CHECK(length(candidate_diagnostics_json) <= 32768),
      question_template_version TEXT NOT NULL, policy_version TEXT NOT NULL, question_utility_version TEXT NOT NULL,
      ${['U','D','R','A','T','K','P','F'].map(n => `${n} REAL NULL CHECK(${n} BETWEEN 0 AND 1)`).join(',')},
      utility_score REAL NULL CHECK(utility_score BETWEEN 0 AND 1), eligibility_threshold REAL NULL,
      counterfactual_branch_hash TEXT NULL, counterfactual_evaluator_version TEXT NOT NULL,
      branch_signatures_json TEXT NULL CHECK(length(branch_signatures_json) <= 8192),
      sensitivity_class TEXT NULL, fatigue_class TEXT NULL, outbound_message_id TEXT NULL, pending_question_id INTEGER NULL,
      status TEXT NOT NULL CHECK(status IN (${sqlEnum(SLOT_STATES.slice(1))})), expires_at TEXT NOT NULL, answered_at TEXT NULL,
      logical_fact_id TEXT NULL, lifecycle_generation INTEGER NOT NULL, auth_generation INTEGER NOT NULL,
      input_generation INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, ${R_SQL},
      PRIMARY KEY(user_id,execution_mode,question_request_id), UNIQUE(user_id,execution_mode,request_lookup_key),
      CHECK(content_state <> 'PRESENT' OR (episode_id IS NOT NULL AND factor_question_kind IS NOT NULL
        AND target_window_start_utc IS NOT NULL AND target_window_end_utc IS NOT NULL AND target_window_start_utc < target_window_end_utc))
    )`,
    `CREATE TABLE IF NOT EXISTS structured_answer_events (
      user_id TEXT NOT NULL, ${modeColumn}, answer_event_id TEXT NOT NULL,
      logical_answer_id TEXT NOT NULL, answer_revision INTEGER NOT NULL CHECK(answer_revision > 0),
      question_request_id TEXT NULL, logical_fact_id TEXT NULL, fact_revision INTEGER NULL, coverage_window_id TEXT NULL,
      source_update_id TEXT NOT NULL, normalized_answer_json TEXT NULL CHECK(length(normalized_answer_json) <= 32768),
      answer_semantics_hash TEXT NULL, selected_followup_kind TEXT NULL
        CHECK(selected_followup_kind IN ('INTERPRETATION_UPDATE','OBSERVATION_PLAN')),
      supersedes_answer_event_id TEXT NULL, input_generation INTEGER NOT NULL,
      lifecycle_generation INTEGER NOT NULL, auth_generation INTEGER NOT NULL, committed_at TEXT NOT NULL, ${R_SQL},
      PRIMARY KEY(user_id,execution_mode,answer_event_id), UNIQUE(user_id,execution_mode,logical_answer_id,answer_revision),
      UNIQUE(user_id,execution_mode,source_update_id),
      CHECK(execution_mode <> 'SHADOW' OR (logical_fact_id IS NULL AND fact_revision IS NULL AND coverage_window_id IS NULL))
    )`,
    `CREATE TABLE IF NOT EXISTS experiment_field_groups (
      user_id TEXT NOT NULL, experiment_id INTEGER NOT NULL, field_group TEXT NOT NULL, field_name TEXT NOT NULL,
      field_revision INTEGER NOT NULL DEFAULT 1 CHECK(field_revision > 0), is_current INTEGER NOT NULL DEFAULT 1 CHECK(is_current IN (0,1)),
      source_kind TEXT NOT NULL CHECK(source_kind IN (${sqlEnum(EXPERIMENT_SOURCE_KINDS)})), assertion_id TEXT NULL,
      source_update_key TEXT NULL, writer_kind TEXT NOT NULL
        CHECK(writer_kind IN ('EXPERIMENT_FLOW','EXPERIMENT_API','EXPERIMENT_ANALYSIS','LEGACY_BACKFILL')),
      provenance_state TEXT NOT NULL DEFAULT 'QUARANTINED' CHECK(provenance_state IN ('DIRECT','LINKED','QUARANTINED','REDACTED')),
      supersedes_privacy_artifact_id TEXT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, ${R_SQL},
      PRIMARY KEY(user_id,experiment_id,field_group,field_name,field_revision),
      CHECK(${Object.entries(EXPERIMENT_FIELDS).map(([f,g]) => `(field_group = '${g}' AND field_name = '${f}')`).join(' OR ')}),
      CHECK(provenance_state <> 'DIRECT' OR (source_kind = 'EXPERIMENT_DIRECT_ASSERTION' AND assertion_id IS NOT NULL AND field_name <> 'result_json'))
    )`,
  ];
  const index = (name, table, fields, { unique = false, where = '' } = {}) =>
    `CREATE ${unique ? 'UNIQUE ' : ''}INDEX IF NOT EXISTS ${name} ON ${table} (${fields})${where ? ` WHERE ${where}` : ''}`;
  const indexes = [
    index('p4_journal_revision', 'journal_events', 'user_id,logical_fact_id,revision', { unique: true, where: 'logical_fact_id IS NOT NULL' }),
    index('p4_journal_source', 'journal_events', 'user_id,source,source_event_key', { unique: true, where: 'source_event_key IS NOT NULL' }),
    index('p4_journal_current', 'journal_events', 'user_id,logical_fact_id', { unique: true, where: "fact_status = 'ACTIVE' AND logical_fact_id IS NOT NULL" }),
    index('p4_journal_date', 'journal_events', 'user_id,fact_status,health_date'),
    index('p4_journal_invalid', 'journal_events', 'user_id,invalidated_at'),
    index('p4_coverage_date', 'journal_coverage_windows', 'user_id,status,health_date_start,health_date_end'),
    index('p4_source_traversal', 'phase4_source_links', 'user_id,source_execution_mode,source_type,source_id'),
    index('p4_purge_state', 'health_plaintext_purges', 'user_id,state,updated_at'),
    index('p4_context_tuple', 'context_questions', 'user_id,execution_mode,episode_id,factor_question_kind,target_window_start_utc,target_window_end_utc,question_cycle_ordinal', { unique: true, where: "content_state = 'PRESENT'" }),
    index('p4_context_cycle_receipt', 'context_questions', 'user_id,execution_mode,question_cycle_source_key', { unique: true, where: 'question_cycle_source_key IS NOT NULL' }),
    index('p4_context_decision', 'context_questions', 'user_id,execution_mode,selected_decision_id', { unique: true, where: 'selected_decision_id IS NOT NULL' }),
    index('p4_context_expiry', 'context_questions', 'user_id,execution_mode,status,expires_at'),
    index('p4_context_episode', 'context_questions', 'user_id,execution_mode,episode_id'),
    index('p4_context_outbox', 'context_questions', 'user_id,execution_mode,outbound_message_id'),
    index('p4_answer_question', 'structured_answer_events', 'user_id,execution_mode,question_request_id'),
    index('p4_pending_context', 'pending_questions', 'user_id,execution_mode,context_question_id', { unique: true, where: 'context_question_id IS NOT NULL' }),
    index('p4_receipt_source', 'telegram_operations', 'owner_user_id,source_update_key', { unique: true, where: 'source_update_key IS NOT NULL' }),
    index('p4_receipt_owner', 'telegram_operations', 'owner_user_id,content_state,update_id'),
    index('p4_experiment_current', 'experiment_field_groups', 'user_id,experiment_id,field_name', { unique: true, where: 'is_current = 1' }),
    index('p4_experiment_assertion', 'experiment_field_groups', 'user_id,assertion_id', { unique: true, where: 'assertion_id IS NOT NULL' }),
    index('p4_experiment_provenance', 'experiment_field_groups', 'user_id,provenance_state,field_group'),
    ...['analytics_invalidation','analytics_work_state'].map(t => index(`p4_${t}_scope`, t, 'user_id,scope_kind,scope_revision')),
  ];
  for (const table of [...V22_LEGACY_R_TABLES, ...V22_NEW_R_TABLES]) {
    const mode = ['pending_questions','context_questions','structured_answer_events'].includes(table) ? ',execution_mode' : '';
    const owner = table === 'system_heartbeats' ? 'scope' : table === 'telegram_operations' ? 'owner_user_id' : 'user_id';
    indexes.push(index(`p4_${table}_privacy_id`, table, `${owner}${mode},privacy_artifact_id`, { unique: true }));
    indexes.push(index(`p4_${table}_privacy`, table,
      table === 'system_heartbeats' ? 'content_state,purge_generation,scope,component' : `${owner}${mode},content_state,purge_generation`));
    if (['telegram_operations','ai_usage','whoop_webhook_events'].includes(table)) {
      indexes.push(index(`p4_${table}_unowned_privacy_id`, table, 'privacy_artifact_id', { unique: true, where: `${owner} IS NULL` }));
    }
  }
  const triggers = ['pending_questions','context_questions','structured_answer_events'].map(immutableMode);
  for (const operation of ['INSERT','UPDATE']) {
    triggers.push(`CREATE TRIGGER IF NOT EXISTS p4_pending_live_${operation.toLowerCase()}
      BEFORE ${operation} ON pending_questions
      WHEN NEW.context_question_id IS NOT NULL AND NEW.execution_mode <> 'LIVE'
      BEGIN SELECT RAISE(ABORT,'phase4_pending_projection_requires_live'); END`);
    for (const [table, from, to] of [['analytics_invalidation','affected_from','affected_to'], ['analytics_work_state','range_from','range_to']]) {
      triggers.push(`CREATE TRIGGER IF NOT EXISTS p4_${table}_scope_${operation.toLowerCase()}
        BEFORE ${operation} ON ${table} WHEN NOT ${scopePredicate('NEW.', from, to)}
        BEGIN SELECT RAISE(ABORT,'phase4_invalid_legacy_scope'); END`);
    }
  }
  return Object.freeze({ version: 22, ddl, columns, indexes, triggers });
}
