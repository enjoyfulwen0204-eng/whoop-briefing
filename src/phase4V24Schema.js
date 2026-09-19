import { R_SQL, SCOPE_SQL, SLOT_STATES, scopePredicate, sqlEnum } from './phase4V22Schema.js';
import { schemaIndex, privacyChecks } from './phase4V23Schema.js';

export const MESSAGE_FAMILIES = ['MORNING_BRIEF_V1','EPISODE_NOTIFICATION','CONTEXT_QUESTION','ANSWER_FOLLOWUP'];
export const FOLLOWUP_KINDS = ['INTERPRETATION_UPDATE','OBSERVATION_PLAN'];
export const DECISION_ACTIONS = ['NO_NOTIFICATION','NOTIFY','ASK_ONE_HIGHEST_VALUE_QUESTION','DEFER_OBSERVATION'];
export const JOB_KINDS = ['RECOMPUTE_DERIVED','REPAIR_CURRENTNESS'];
export const JOB_STATES = ['PENDING','RUNNING','RETRY_WAIT','COMPLETED','REPAIR_REQUIRED'];
export const OUTBOX_STATES = ['PROPOSED','ELIGIBLE','CLAIMED','DELIVERY_STARTED','DELIVERED','FAILED_DEFINITE',
  'AMBIGUOUS','SUPPRESSED','INVALIDATED','FAILED_TERMINAL'];
export const ATTEMPT_STATES = ['DELIVERY_STARTED','DELIVERED','FAILED_DEFINITE','AMBIGUOUS'];
export const SLOT_OCCUPIED = ['RESERVED','DELIVERY_STARTED','AMBIGUOUS_WAIT','AWAITING_ANSWER'];
export const SLOT_CANCELLATION_REASONS = ['RESERVATION_EXPIRED','PRE_SEND_FAILURE','PROVIDER_DEFINITE_NON_ACCEPTANCE',
  'PAUSED','LIFECYCLE_CHANGED','AUTH_CHANGED','SOURCE_INVALIDATED','CONTENT_REDACTED'];
export const OPERATION_ERROR_CODES = ['INVARIANT_VIOLATION','CALCULATION_FAILED','STALE_GENERATION','SOURCE_UNAVAILABLE',
  'CONTENT_REDACTED','AUTH_CHANGED','LIFECYCLE_CHANGED','SCOPE_CHANGED','LEASE_LOST','REPAIR_REQUIRED',
  'PROVIDER_DEFINITE_NON_ACCEPTANCE','PROVIDER_RATE_LIMIT','PROVIDER_UNAVAILABLE','NETWORK_UNCERTAIN','INVALID_RESPONSE'];
export const SCOPE_REASON_CODES = ['SOURCE_CHANGED','SOURCE_CORRECTED','SOURCE_DELETED','JOURNAL_CREATED','AUTH_CHANGED',
  'LIFECYCLE_CHANGED','TIMEZONE_CHANGED','PREFERENCE_CHANGED','ALGORITHM_CHANGED','CONTENT_REDACTED','HEALTH_SCOPE_REDACTED','REPAIR_REQUIRED'];
export const V24_TABLES = ['phase4_invalidations','phase4_jobs','phase4_proactive_decisions','tenant_delivery_modes',
  'outbound_semantic_reservations','phase4_question_interaction_slots','outbound_messages','outbound_delivery_attempts'];
export const V24_HEALTH_FIELDS = Object.freeze({
  phase4_invalidations:['affected_from','affected_to','subject_key'], phase4_jobs:['affected_from','affected_to','subject_key'],
  phase4_proactive_decisions:['gate_results_json','candidate_diagnostics_json','branch_signatures_json','selected_question_key','decision_reason'],
  outbound_messages:['payload_json','payload_text'], outbound_delivery_attempts:[],
});
const integer = (n, defaultValue = null) => `${n} INTEGER NOT NULL${defaultValue === null ? '' : ` DEFAULT ${defaultValue}`}
  CHECK(typeof(${n}) = 'integer' AND ${n} BETWEEN 0 AND 9007199254740991)`;
const e = (n, values, nullable = false, defaultValue = null) => `${n} TEXT ${nullable ? 'NULL' : 'NOT NULL'}
  ${defaultValue === null ? '' : `DEFAULT '${defaultValue}'`} CHECK(${n} IN (${sqlEnum(values)}))`;
const json = n => `${n} TEXT NULL CHECK(length(${n}) <= 32768)`;
const fences = ['input_generation','lifecycle_generation','auth_generation'].map(n=>integer(n)).join(',');

export function buildV24(modeColumn, immutableMode) {
  const header = (table, privacy = true) => `CREATE TABLE IF NOT EXISTS ${table}
    (user_id TEXT NOT NULL, ${modeColumn}, ${privacy ? `${R_SQL},` : ''}`;
  const tail = (key, privacy = true) => `${privacy ? `${privacyChecks},` : ''} PRIMARY KEY(user_id,execution_mode${key ? `,${key}` : ''}))`;
  const scopeFields = `${SCOPE_SQL}, affected_from TEXT NULL, affected_to TEXT NULL, subject_key TEXT NULL,
    reason_codes_json TEXT NOT NULL DEFAULT '[]' CHECK(length(reason_codes_json) <= 2048)`;
  const ddl = [
    `${header('phase4_invalidations')}
      ${integer('requested_generation')}, ${scopeFields}, updated_at TEXT NOT NULL,
      CHECK ${scopePredicate('','affected_from','affected_to','subject_key')}, ${tail('')}`,
    `${header('phase4_jobs')}
      ${e('job_kind',JOB_KINDS)}, ${integer('requested_generation')}, ${integer('completed_generation',0)},
      ${scopeFields}, ${e('state',JOB_STATES,false,'PENDING')}, ${integer('attempt',0)}, next_attempt_at TEXT NULL,
      lease_owner TEXT NULL, lease_expires_at TEXT NULL, claimed_generation INTEGER NULL,
      claimed_lifecycle_generation INTEGER NULL, claimed_auth_generation INTEGER NULL,
      claimed_scope_revision INTEGER NULL, claimed_purge_generation INTEGER NULL,
      ${e('last_error_code',OPERATION_ERROR_CODES,true)}, updated_at TEXT NOT NULL,
      CHECK(completed_generation <= requested_generation),
      CHECK(state <> 'COMPLETED' OR (scope_kind = 'NONE' AND completed_generation = requested_generation
        AND lease_owner IS NULL AND lease_expires_at IS NULL)),
      CHECK(state <> 'RUNNING' OR (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL
        AND claimed_generation IS NOT NULL AND claimed_lifecycle_generation IS NOT NULL AND claimed_auth_generation IS NOT NULL
        AND claimed_scope_revision IS NOT NULL AND claimed_purge_generation IS NOT NULL)),
      CHECK ${scopePredicate('','affected_from','affected_to','subject_key')}, ${tail('job_kind')}`,
    `${header('phase4_proactive_decisions')}
      decision_id TEXT NOT NULL, deterministic_decision_key TEXT NOT NULL, ${e('action',DECISION_ACTIONS)},
      episode_id TEXT NULL, episode_revision INTEGER NULL CHECK(episode_revision > 0), ${fences},
      policy_version TEXT NOT NULL, metric_registry_version TEXT NOT NULL, evidence_version TEXT NOT NULL, template_version TEXT NOT NULL,
      ${json('gate_results_json')}, ${json('candidate_diagnostics_json')}, episode_semantic_event_id TEXT NULL,
      question_request_id TEXT NULL, answer_event_id TEXT NULL, ${e('selected_followup_kind',FOLLOWUP_KINDS,true)},
      counterfactual_evaluator_version TEXT NULL, ${json('branch_signatures_json')}, selected_question_key TEXT NULL,
      notification_hash TEXT NULL, question_hash TEXT NULL, semantic_claim_hash TEXT NULL, action_hash TEXT NULL,
      decision_reason TEXT NULL, invalidated_at TEXT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL,
      UNIQUE(user_id,execution_mode,deterministic_decision_key), ${tail('decision_id')}`,
    `${header('tenant_delivery_modes',false)}
      ${e('message_family',MESSAGE_FAMILIES)}, ${e('mode',['LEGACY','CUTOVER_PENDING','PHASE4'],false,'LEGACY')},
      cutover_boundary TEXT NULL, timezone TEXT NULL, ${integer('revision',0)},
      ${integer('lifecycle_generation')}, ${integer('auth_generation')}, changed_at TEXT NOT NULL,
      ${e('reason_code',['INITIAL','CUTOVER_REQUESTED','CUTOVER_COMMITTED','CUTOVER_DEFERRED','ROLLED_BACK','SHADOW_SIMULATION'])},
      CHECK(mode = 'LEGACY' OR (cutover_boundary IS NOT NULL AND timezone IS NOT NULL)), ${tail('message_family',false)}`,
    `${header('outbound_semantic_reservations',false)}
      reservation_id TEXT NOT NULL, ${e('message_family',MESSAGE_FAMILIES)}, semantic_key TEXT NOT NULL,
      ${e('state',['RESERVED','CONSUMED','CLOSED'],false,'RESERVED')}, ${e('origin',['PHASE4','LEGACY_BARRIER'],false,'PHASE4')},
      ${e('legacy_table',['report_runs','report_claims','proactive_events','pending_questions','telegram_operations'],true)}, legacy_row_id TEXT NULL,
      message_id TEXT NULL, episode_semantic_event_id TEXT NULL, question_request_id TEXT NULL, answer_event_id TEXT NULL,
      local_health_date TEXT NULL, ${e('followup_kind',FOLLOWUP_KINDS,true)}, ${e('consumed_outcome',['DELIVERED','AMBIGUOUS'],true)},
      ${e('closed_reason',[...SLOT_CANCELLATION_REASONS,'SUPPRESSED','INVALIDATED','FAILED_TERMINAL'],true)},
      created_at TEXT NOT NULL, consumed_at TEXT NULL, closed_at TEXT NULL,
      UNIQUE(user_id,execution_mode,message_family,semantic_key),
      CHECK(origin <> 'LEGACY_BARRIER' OR (legacy_table IS NOT NULL AND legacy_row_id IS NOT NULL)),
      CHECK(state <> 'CONSUMED' OR (consumed_outcome IS NOT NULL AND consumed_at IS NOT NULL)),
      CHECK(state <> 'CLOSED' OR (closed_reason IS NOT NULL AND closed_at IS NOT NULL)),
      CHECK(origin = 'LEGACY_BARRIER' OR ((message_family = 'MORNING_BRIEF_V1' AND local_health_date IS NOT NULL
          AND semantic_key = json_array(user_id,'MORNING_BRIEF_V1',local_health_date))
        OR (message_family = 'EPISODE_NOTIFICATION' AND episode_semantic_event_id IS NOT NULL
          AND semantic_key = json_array(user_id,'EPISODE_NOTIFICATION',episode_semantic_event_id))
        OR (message_family = 'CONTEXT_QUESTION' AND question_request_id IS NOT NULL
          AND semantic_key = json_array(user_id,'CONTEXT_QUESTION',question_request_id))
        OR (message_family = 'ANSWER_FOLLOWUP' AND answer_event_id IS NOT NULL AND followup_kind IS NOT NULL
          AND semantic_key = json_array(user_id,'ANSWER_FOLLOWUP',answer_event_id,followup_kind)))), ${tail('reservation_id',false)}`,
    `${header('phase4_question_interaction_slots',false)}
      ${integer('revision',0)}, ${e('state',SLOT_STATES,false,'FREE')}, question_request_id TEXT NULL, outbound_message_id TEXT NULL,
      ${e('origin',['PHASE4','LEGACY'],false,'PHASE4')}, legacy_pending_question_id INTEGER NULL, legacy_operation_id TEXT NULL,
      lifecycle_generation INTEGER NULL, auth_generation INTEGER NULL, reserved_at TEXT NULL, delivery_started_at TEXT NULL,
      delivered_at TEXT NULL, answer_deadline TEXT NULL, resolved_at TEXT NULL, expired_at TEXT NULL, ambiguous_at TEXT NULL,
      updated_at TEXT NOT NULL, ${e('cancellation_reason',SLOT_CANCELLATION_REASONS,true)},
      CHECK(state <> 'FREE' OR (question_request_id IS NULL AND outbound_message_id IS NULL
        AND legacy_pending_question_id IS NULL AND legacy_operation_id IS NULL)),
      CHECK(state NOT IN (${sqlEnum(SLOT_OCCUPIED)}) OR
        (origin = 'PHASE4' AND question_request_id IS NOT NULL AND lifecycle_generation IS NOT NULL AND auth_generation IS NOT NULL
          AND (execution_mode = 'SHADOW' OR outbound_message_id IS NOT NULL))
        OR (origin = 'LEGACY' AND execution_mode = 'LIVE' AND (legacy_pending_question_id IS NOT NULL OR legacy_operation_id IS NOT NULL))),
      CHECK(state <> 'RESERVED' OR reserved_at IS NOT NULL),
      CHECK(state NOT IN ('DELIVERY_STARTED','AMBIGUOUS_WAIT','AWAITING_ANSWER') OR
        (delivery_started_at IS NOT NULL AND answer_deadline IS NOT NULL AND answer_deadline > delivery_started_at)),
      CHECK(state <> 'AMBIGUOUS_WAIT' OR ambiguous_at IS NOT NULL),
      CHECK(state <> 'AWAITING_ANSWER' OR delivered_at IS NOT NULL),
      CHECK(state <> 'RESOLVED' OR resolved_at IS NOT NULL), CHECK(state <> 'EXPIRED' OR expired_at IS NOT NULL),
      CHECK(state <> 'CANCELLED_PRE_SEND' OR cancellation_reason IS NOT NULL), ${tail('',false)}`,
    `${header('outbound_messages')}
      message_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, ${e('message_class',MESSAGE_FAMILIES)},
      reservation_id TEXT NOT NULL, semantic_key_version TEXT NOT NULL DEFAULT 'semantic-key-v1' CHECK(semantic_key_version = 'semantic-key-v1'),
      decision_id TEXT NULL, episode_id TEXT NULL, question_request_id TEXT NULL, episode_semantic_event_id TEXT NULL,
      answer_event_id TEXT NULL, ${e('followup_kind',FOLLOWUP_KINDS,true)}, destination_binding_id TEXT NULL,
      ${json('payload_json')}, payload_text TEXT NULL CHECK(length(payload_text) <= 16384), payload_hash TEXT NULL, semantic_hash TEXT NULL,
      ${e('state',OUTBOX_STATES,false,'PROPOSED')}, ${integer('revision',0)}, ${fences}, ${integer('attempt_count',0)},
      next_attempt_at TEXT NULL, expires_at TEXT NOT NULL, lease_owner TEXT NULL, lease_expires_at TEXT NULL,
      provider_message_id TEXT NULL,
      ${e('terminal_reason',[...SLOT_CANCELLATION_REASONS,'SUPPRESSED','INVALIDATED','FAILED_TERMINAL','EXPIRED',
        'NO_NOTIFICATION','INSUFFICIENT_EVIDENCE','SHADOW_SIMULATION','SHADOW_SIMULATED_DELIVERED','SHADOW_SIMULATED_AMBIGUOUS'],true)},
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(user_id,execution_mode,idempotency_key), UNIQUE(user_id,execution_mode,reservation_id),
      CHECK((execution_mode = 'SHADOW' AND destination_binding_id IS NULL) OR (execution_mode = 'LIVE' AND destination_binding_id IS NOT NULL)),
      CHECK(state <> 'CLAIMED' OR (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)), ${tail('message_id')}`,
    `${header('outbound_delivery_attempts')}
      attempt_id TEXT NOT NULL, message_id TEXT NOT NULL, attempt_number INTEGER NOT NULL CHECK(typeof(attempt_number) = 'integer' AND attempt_number > 0),
      ${e('state',ATTEMPT_STATES)}, request_hash TEXT NOT NULL,
      ${e('provider_status_class',['ACCEPTED','DEFINITE_NON_ACCEPTANCE','RATE_LIMITED','UNAVAILABLE','UNCERTAIN'],true)},
      delivery_started_at TEXT NOT NULL, completed_at TEXT NULL, provider_message_id TEXT NULL,
      ${e('error_code',OPERATION_ERROR_CODES,true)},
      ${e('ambiguity_reason',['TIMEOUT','CONNECTION_LOST','MALFORMED_SUCCESS','PROCESS_RESTART','UNKNOWN_ACCEPTANCE'],true)},
      UNIQUE(user_id,execution_mode,message_id,attempt_number), CHECK(execution_mode = 'LIVE'), ${tail('attempt_id')}`,
  ];
  const indexes = [];
  const add=(name,table,fields)=>indexes.push(schemaIndex(name,table,fields));
  for(const table of Object.keys(V24_HEALTH_FIELDS)) {
    indexes.push(schemaIndex(`p4_${table}_privacy_id`,table,'user_id,execution_mode,privacy_artifact_id',true));
    add(`p4_${table}_privacy`,table,'user_id,execution_mode,content_state,purge_generation');
  }
  for(const table of ['phase4_invalidations','phase4_jobs'])add(`p4_${table}_scope`,table,'user_id,execution_mode,scope_kind,requested_generation');
  add('p4_invalidation_queue','phase4_invalidations','execution_mode,updated_at,user_id');
  for(const table of ['phase4_jobs','outbound_messages']) {
    add(`p4_${table}_queue`,table,'execution_mode,state,next_attempt_at,user_id');
    add(`p4_${table}_lease`,table,'execution_mode,lease_expires_at,user_id');
  }
  add('p4_decision_episode','phase4_proactive_decisions','user_id,execution_mode,episode_id,episode_revision');
  add('p4_decision_action','phase4_proactive_decisions','user_id,execution_mode,action,created_at');
  add('p4_decision_invalid','phase4_proactive_decisions','user_id,execution_mode,invalidated_at');
  add('p4_delivery_mode','tenant_delivery_modes','user_id,execution_mode,message_family,mode,cutover_boundary');
  add('p4_reservation_state','outbound_semantic_reservations','user_id,execution_mode,message_family,semantic_key,state');
  add('p4_reservation_legacy','outbound_semantic_reservations','user_id,execution_mode,origin,legacy_table,legacy_row_id');
  add('p4_slot_deadline','phase4_question_interaction_slots','user_id,execution_mode,state,answer_deadline');
  add('p4_slot_expiry_queue','phase4_question_interaction_slots','execution_mode,state,answer_deadline,user_id');
  add('p4_outbox_reservation','outbound_messages','user_id,execution_mode,reservation_id');
  add('p4_outbox_decision','outbound_messages','user_id,execution_mode,decision_id');
  add('p4_outbox_semantic','outbound_messages','user_id,execution_mode,semantic_hash');
  add('p4_attempt_message','outbound_delivery_attempts','user_id,execution_mode,message_id,attempt_number');
  add('p4_attempt_state','outbound_delivery_attempts','user_id,execution_mode,state,completed_at');
  const triggers = V24_TABLES.map(immutableMode);
  const immutable = {
    phase4_invalidations:['privacy_artifact_id'], phase4_jobs:['job_kind','privacy_artifact_id'],
    phase4_proactive_decisions:['decision_id','deterministic_decision_key','action','episode_id','episode_revision','input_generation',
      'lifecycle_generation','auth_generation','policy_version','metric_registry_version','evidence_version','template_version',
      'episode_semantic_event_id','question_request_id','answer_event_id','selected_followup_kind','created_at','privacy_artifact_id'],
    tenant_delivery_modes:['message_family'],
    outbound_semantic_reservations:['reservation_id','message_family','semantic_key','origin','legacy_table','legacy_row_id',
      'episode_semantic_event_id','question_request_id','answer_event_id','local_health_date','followup_kind','created_at'],
    outbound_messages:['message_id','idempotency_key','message_class','reservation_id','semantic_key_version','decision_id','episode_id',
      'question_request_id','episode_semantic_event_id','answer_event_id','followup_kind','destination_binding_id','payload_hash','semantic_hash',
      'input_generation','lifecycle_generation','auth_generation','created_at','privacy_artifact_id'],
    outbound_delivery_attempts:['attempt_id','message_id','attempt_number','request_hash','delivery_started_at','privacy_artifact_id'],
  };
  for(const [table,fields] of Object.entries(immutable))triggers.push(`CREATE TRIGGER IF NOT EXISTS p4_${table}_envelope_immutable
    BEFORE UPDATE ON ${table} WHEN ${fields.map(f=>`NEW.${f} IS NOT OLD.${f}`).join(' OR ')}
    BEGIN SELECT RAISE(ABORT,'phase4_envelope_immutable'); END`);
  for(const table of V24_TABLES) triggers.push(`CREATE TRIGGER IF NOT EXISTS p4_${table}_owner_immutable
    BEFORE UPDATE OF user_id ON ${table} WHEN NEW.user_id IS NOT OLD.user_id
    BEGIN SELECT RAISE(ABORT,'phase4_owner_immutable'); END`);
  for(const [table,fields] of Object.entries(V24_HEALTH_FIELDS)) {
    for(const op of ['INSERT','UPDATE']) if(fields.length)triggers.push(`CREATE TRIGGER IF NOT EXISTS p4_${table}_redaction_${op.toLowerCase()}
      BEFORE ${op} ON ${table} WHEN NEW.content_state = 'REDACTED' AND (${fields.map(f=>`NEW.${f} IS NOT NULL`).join(' OR ')})
      BEGIN SELECT RAISE(ABORT,'phase4_redacted_plaintext'); END`);
    if(!['phase4_jobs','phase4_invalidations'].includes(table)) {
      triggers.push(`CREATE TRIGGER IF NOT EXISTS p4_${table}_no_rehydration
        BEFORE UPDATE ON ${table} WHEN OLD.content_state = 'REDACTED' AND NEW.content_state <> 'REDACTED'
        BEGIN SELECT RAISE(ABORT,'phase4_content_redacted'); END`);
      if(fields.length)triggers.push(`CREATE TRIGGER IF NOT EXISTS p4_${table}_content_append_only
        BEFORE UPDATE ON ${table} WHEN NEW.content_state <> 'REDACTED' AND (${fields.map(f=>`NEW.${f} IS NOT OLD.${f}`).join(' OR ')})
        BEGIN SELECT RAISE(ABORT,'phase4_content_append_only'); END`);
    }
  }
  triggers.push(`CREATE TRIGGER IF NOT EXISTS p4_reservation_permanent
    BEFORE UPDATE ON outbound_semantic_reservations WHEN (OLD.state IN ('CONSUMED','CLOSED') AND NEW.state <> OLD.state)
      OR NEW.reservation_id IS NOT OLD.reservation_id OR NEW.message_family IS NOT OLD.message_family OR NEW.semantic_key IS NOT OLD.semantic_key
      OR NEW.origin IS NOT OLD.origin OR (OLD.message_id IS NOT NULL AND NEW.message_id IS NOT OLD.message_id)
      OR (OLD.consumed_outcome IS NOT NULL AND NEW.consumed_outcome IS NOT OLD.consumed_outcome)
      OR (OLD.state <> 'RESERVED' AND NEW.message_id IS NOT OLD.message_id)
    BEGIN SELECT RAISE(ABORT,'phase4_semantic_reservation_permanent'); END`);
  triggers.push(`CREATE TRIGGER IF NOT EXISTS p4_reservation_no_delete BEFORE DELETE ON outbound_semantic_reservations
    BEGIN SELECT RAISE(ABORT,'phase4_semantic_reservation_permanent'); END`);
  for(const table of ['phase4_question_interaction_slots','outbound_messages','tenant_delivery_modes'])triggers.push(
    `CREATE TRIGGER IF NOT EXISTS p4_${table}_revision BEFORE UPDATE ON ${table}
      WHEN NEW.revision <> OLD.revision + 1 BEGIN SELECT RAISE(ABORT,'phase4_invalid_revision'); END`);
  triggers.push(`CREATE TRIGGER IF NOT EXISTS p4_slot_transition BEFORE UPDATE ON phase4_question_interaction_slots
    WHEN NEW.state <> OLD.state AND NOT (
      (OLD.state IN ('FREE','RESOLVED','EXPIRED','CANCELLED_PRE_SEND') AND NEW.state = 'RESERVED')
      OR (OLD.state = 'RESERVED' AND NEW.state IN ('DELIVERY_STARTED','CANCELLED_PRE_SEND'))
      OR (OLD.state = 'DELIVERY_STARTED' AND NEW.state IN ('AWAITING_ANSWER','AMBIGUOUS_WAIT','CANCELLED_PRE_SEND'))
      OR (OLD.state = 'AMBIGUOUS_WAIT' AND NEW.state IN ('AWAITING_ANSWER','RESOLVED','EXPIRED'))
      OR (OLD.state = 'AWAITING_ANSWER' AND NEW.state IN ('RESOLVED','EXPIRED')))
    BEGIN SELECT RAISE(ABORT,'phase4_invalid_slot_transition'); END`);
  triggers.push(`CREATE TRIGGER IF NOT EXISTS p4_slot_occupied_identity BEFORE UPDATE ON phase4_question_interaction_slots
    WHEN OLD.state IN (${sqlEnum(SLOT_OCCUPIED)}) AND (NEW.question_request_id IS NOT OLD.question_request_id
      OR NEW.origin IS NOT OLD.origin OR NEW.legacy_pending_question_id IS NOT OLD.legacy_pending_question_id
      OR NEW.legacy_operation_id IS NOT OLD.legacy_operation_id OR NEW.lifecycle_generation IS NOT OLD.lifecycle_generation
      OR NEW.auth_generation IS NOT OLD.auth_generation
      OR (OLD.outbound_message_id IS NOT NULL AND NEW.outbound_message_id IS NOT OLD.outbound_message_id)
      OR NEW.reserved_at IS NOT OLD.reserved_at
      OR (OLD.delivery_started_at IS NOT NULL AND NEW.delivery_started_at IS NOT OLD.delivery_started_at)
      OR (OLD.ambiguous_at IS NOT NULL AND NEW.ambiguous_at IS NOT OLD.ambiguous_at))
    BEGIN SELECT RAISE(ABORT,'phase4_occupied_slot_immutable'); END`);
  triggers.push(`CREATE TRIGGER IF NOT EXISTS p4_slot_deadline_immutable BEFORE UPDATE ON phase4_question_interaction_slots
    WHEN (OLD.state IN ('AMBIGUOUS_WAIT','AWAITING_ANSWER') AND NEW.state = OLD.state AND NEW.answer_deadline IS NOT OLD.answer_deadline)
      OR (OLD.state IN ('DELIVERY_STARTED','AMBIGUOUS_WAIT','AWAITING_ANSWER')
        AND (NEW.answer_deadline IS NULL OR NEW.answer_deadline < OLD.answer_deadline))
    BEGIN SELECT RAISE(ABORT,'phase4_slot_deadline_immutable'); END`);
  triggers.push(`CREATE TRIGGER IF NOT EXISTS p4_outbox_transition BEFORE UPDATE ON outbound_messages
    WHEN NEW.state <> OLD.state AND NOT (
      (OLD.state = 'PROPOSED' AND NEW.state IN ('ELIGIBLE','SUPPRESSED','INVALIDATED'))
      OR (OLD.state = 'ELIGIBLE' AND NEW.state IN ('CLAIMED','SUPPRESSED','INVALIDATED'))
      OR (OLD.state = 'CLAIMED' AND NEW.state IN ('ELIGIBLE','SUPPRESSED','INVALIDATED','DELIVERY_STARTED'))
      OR (OLD.state = 'DELIVERY_STARTED' AND NEW.state IN ('DELIVERED','FAILED_DEFINITE','AMBIGUOUS'))
      OR (OLD.state = 'FAILED_DEFINITE' AND NEW.state IN ('ELIGIBLE','FAILED_TERMINAL')))
    BEGIN SELECT RAISE(ABORT,'phase4_invalid_outbox_transition'); END`);
  triggers.push(`CREATE TRIGGER IF NOT EXISTS p4_attempt_terminal BEFORE UPDATE ON outbound_delivery_attempts
    WHEN OLD.state <> 'DELIVERY_STARTED' AND NEW.state <> OLD.state
    BEGIN SELECT RAISE(ABORT,'phase4_attempt_terminal'); END`);
  for(const table of ['phase4_invalidations','phase4_jobs'])triggers.push(`CREATE TRIGGER IF NOT EXISTS p4_${table}_monotonic
    BEFORE UPDATE ON ${table} WHEN NEW.requested_generation < OLD.requested_generation OR NEW.scope_revision < OLD.scope_revision
      OR NEW.purge_generation < OLD.purge_generation${table === 'phase4_jobs' ? ' OR NEW.completed_generation < OLD.completed_generation' : ''}
    BEGIN SELECT RAISE(ABORT,'phase4_generation_regression'); END`);
  for(const op of ['INSERT','UPDATE']) {
    for(const table of ['phase4_invalidations','phase4_jobs'])triggers.push(`CREATE TRIGGER IF NOT EXISTS p4_${table}_reason_codes_${op.toLowerCase()}
      BEFORE ${op} ON ${table} WHEN json_valid(NEW.reason_codes_json) = 0 OR json_type(NEW.reason_codes_json) <> 'array'
        OR EXISTS (SELECT 1 FROM json_each(NEW.reason_codes_json) WHERE type <> 'text' OR value NOT IN (${sqlEnum(SCOPE_REASON_CODES)}))
      BEGIN SELECT RAISE(ABORT,'phase4_invalid_scope_reason'); END`);
    triggers.push(`CREATE TRIGGER IF NOT EXISTS p4_outbox_reservation_parent_${op.toLowerCase()}
      BEFORE ${op} ON outbound_messages WHEN NOT EXISTS (SELECT 1 FROM outbound_semantic_reservations r
        WHERE r.user_id = NEW.user_id AND r.execution_mode = NEW.execution_mode AND r.reservation_id = NEW.reservation_id
          AND r.message_family = NEW.message_class AND r.semantic_key = NEW.idempotency_key AND r.origin = 'PHASE4'
          ${op === 'INSERT' ? "AND r.state = 'RESERVED'" : ''})
      BEGIN SELECT RAISE(ABORT,'phase4_invalid_reservation_parent'); END`);
    triggers.push(`CREATE TRIGGER IF NOT EXISTS p4_attempt_message_parent_${op.toLowerCase()}
      BEFORE ${op} ON outbound_delivery_attempts WHEN NOT EXISTS (SELECT 1 FROM outbound_messages m
        WHERE m.user_id = NEW.user_id AND m.execution_mode = NEW.execution_mode AND m.message_id = NEW.message_id)
      BEGIN SELECT RAISE(ABORT,'phase4_invalid_attempt_parent'); END`);
  }
  return Object.freeze({version:24,ddl,indexes,triggers});
}
